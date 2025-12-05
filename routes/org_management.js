// routes/org_management.js
import { Router } from "express";
import crypto from "crypto";
import nodemailer from "nodemailer";
import mongoose from "mongoose";

import Organization from "../models/organization.js";
import OrgInvite from "../models/orgInvite.js";
import OrgMembership from "../models/orgMembership.js";
import OrgModule from "../models/orgModule.js";
import User from "../models/user.js";
import ExamInstance from "../models/examInstance.js";
import QuizQuestion from "../models/question.js";
import Attempt from "../models/attempt.js";
import { ensureAuth } from "../middleware/authGuard.js";

const router = Router();

/**
 * Admin check - replace if you have a different admin logic.
 * Uses ADMIN_EMAILS env (comma separated list).
 */
function ensureAdminEmails(req, res, next) {
  const adminEmails = (process.env.ADMIN_EMAILS || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  if (!req.user || !req.user.email) {
    return res.status(403).send("Admins only");
  }
  if (!adminEmails.includes(req.user.email.toLowerCase())) {
    return res.status(403).send("Admins only");
  }
  next();
}

/**
 * Lazy transporter creation: we read env *when we actually need it*.
 */
let _transporter = null;

function getTransporter() {
  if (_transporter) return _transporter;

  const host = process.env.SMTP_HOST;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  const secure =
    String(process.env.SMTP_SECURE || "").toLowerCase() === "true";
  const port = Number(process.env.SMTP_PORT || (secure ? 465 : 587));

  console.log("[invite email] env snapshot:", {
    SMTP_HOST: host,
    SMTP_USER: user,
    SMTP_HAS_PASS: !!pass,
    SMTP_PORT: port,
    SMTP_SECURE: secure,
    BASE_URL: process.env.BASE_URL,
  });

  if (!host || !user || !pass) {
    console.error(
      "[invite email] SMTP_HOST / SMTP_USER / SMTP_PASS missing – cannot create transporter"
    );
    return null;
  }

  _transporter = nodemailer.createTransport({
    host,
    port,
    secure,
    auth: {
      user,
      pass,
    },
  });

  console.log(
    `[invite email] transporter created host=${host} port=${port} secure=${secure}`
  );

  return _transporter;
}

const BASE_URL = process.env.BASE_URL || "";

/**
 * ADMIN: Send invite (POST)
 * body: { email, role }
 */
router.post(
  "/admin/orgs/:slug/invite",
  ensureAuth,
  ensureAdminEmails,
  async (req, res) => {
    try {
      const slug = String(req.params.slug || "").trim();
      const email = String(req.body.email || "").trim().toLowerCase();
      const role = String(req.body.role || "employee");

      if (!email) return res.status(400).json({ error: "email required" });

      const org = await Organization.findOne({ slug }).lean();
      if (!org) return res.status(404).json({ error: "org not found" });

      const token = crypto.randomBytes(16).toString("hex");
      const invite = await OrgInvite.create({ orgId: org._id, email, token, role });

      // Try sending email
      const transporter = getTransporter();

      if (!transporter || !BASE_URL) {
        console.warn(
          "[invite email] transporter not available or BASE_URL missing; invite email skipped"
        );
        return res.json({ ok: true, token: invite.token }); // still return token
      }

      const inviteUrl = `${BASE_URL.replace(/\/$/, "")}/org/join/${token}`;

      try {
        const info = await transporter.sendMail({
          from: process.env.SMTP_FROM || process.env.SMTP_USER,
          to: email,
          subject: `Invite to join ${org.name}`,
          text: `You've been invited to join ${org.name}. Click to accept: ${inviteUrl}`,
          html: `
            <p>You've been invited to join <strong>${org.name}</strong>.</p>
            <p><a href="${inviteUrl}">Click here to accept the invite</a></p>
          `,
        });

        console.log("[invite email] sent:", info.messageId);
      } catch (e) {
        console.error("[invite email] send failed:", e && (e.stack || e));
      }

      return res.json({ ok: true, token: invite.token });
    } catch (err) {
      console.error("[admin invite] error:", err && (err.stack || err));
      return res.status(500).json({ error: "invite failed" });
    }
  }
);

/**
 * ADMIN: Manage page view
 */
router.get(
  "/admin/orgs/:slug/manage",
  ensureAuth,
  ensureAdminEmails,
  async (req, res) => {
    try {
      const slug = String(req.params.slug || "");
      const org = await Organization.findOne({ slug }).lean();
      if (!org) return res.status(404).send("org not found");

      const invites = await OrgInvite.find({ orgId: org._id })
        .sort({ createdAt: -1 })
        .lean();
      const memberships = await OrgMembership.find({ org: org._id })
        .populate("user")
        .lean();
      const modules = await OrgModule.find({ org: org._id }).lean();

      return res.render("admin/org_manage", {
        org,
        invites,
        memberships,
        modules,
      });
    } catch (err) {
      console.error("[admin org manage] error:", err && (err.stack || err));
      return res.status(500).send("failed");
    }
  }
);

/**
 * PUBLIC: Join via invite token (GET)
 */
router.get("/org/join/:token", ensureAuth, async (req, res) => {
  try {
    const token = String(req.params.token || "");
    if (!token) return res.status(400).send("token required");

    const invite = await OrgInvite.findOne({ token, used: false }).lean();
    if (!invite) return res.status(404).send("invite not found or used");

    await OrgMembership.findOneAndUpdate(
      { org: invite.orgId, user: req.user._id },
      { $set: { role: invite.role, joinedAt: new Date() } },
      { upsert: true }
    );

    await OrgInvite.updateOne(
      { _id: invite._id },
      { $set: { used: true } }
    );

    const org = await Organization.findById(invite.orgId).lean();
    return res.redirect(`/org/${org.slug}/dashboard`);
  } catch (err) {
    console.error("[org/join] error:", err && (err.stack || err));
    return res.status(500).send("join failed");
  }
});

/**
 * ADMIN: Member actions (promote/demote/remove)
 */
router.post(
  "/admin/orgs/:slug/members/:userId",
  ensureAuth,
  ensureAdminEmails,
  async (req, res) => {
    try {
      const slug = String(req.params.slug || "");
      const userId = req.params.userId;
      const action = String(req.body.action || "").trim();
      const role = String(req.body.role || "manager");

      const org = await Organization.findOne({ slug }).lean();
      if (!org) return res.status(404).json({ error: "org not found" });

      if (action === "remove") {
        await OrgMembership.deleteOne({ org: org._id, user: userId });
        return res.json({ ok: true, action: "removed" });
      } else if (action === "promote") {
        await OrgMembership.findOneAndUpdate(
          { org: org._id, user: userId },
          { $set: { role } },
          { upsert: true }
        );
        return res.json({ ok: true, action: "promoted", role });
      } else if (action === "demote") {
        await OrgMembership.findOneAndUpdate(
          { org: org._id, user: userId },
          { $set: { role: "employee" } }
        );
        return res.json({ ok: true, action: "demoted" });
      } else {
        return res.status(400).json({ error: "invalid action" });
      }
    } catch (err) {
      console.error("[admin member action] error:", err && (err.stack || err));
      return res.status(500).json({ error: "failed" });
    }
  }
);

/**
 * ASSIGN QUIZ, REPORTS & DASHBOARD routes are unchanged from your version.
 * (Leave your existing implementations below this point, or paste them
 *  back if you removed them.)
 */

// ... keep the rest of your quiz/attempt/report/dashboard routes here ...

export default router;
