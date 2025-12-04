// routes/org.js
import { Router } from "express";
import Organization from "../models/organization.js";
import OrgMembership from "../models/orgMembership.js";
import { ensureAuth } from "../middleware/authGuard.js";
import mongoose from "mongoose";

const router = Router();

// Create org (manager/admin). Minimal UI - admin only in this simple impl.
router.get("/create", ensureAuth, async (req, res) => {
  return res.render("org/create", { user: req.user || null });
});

router.post("/create", ensureAuth, async (req, res) => {
  try {
    const { name, slug, description } = req.body || {};
    if (!name || !slug) return res.status(400).send("Missing name or slug");
    const org = await Organization.create({ name: name.trim(), slug: slug.trim(), description });
    // create membership (creator becomes admin)
    await OrgMembership.create({ org: org._id, user: req.user._id, role: "admin" });
    return res.redirect(`/org/${org.slug}/dashboard`);
  } catch (e) {
    console.error("[org/create] error:", e && e.message);
    return res.status(500).send("Failed to create org");
  }
});

// Accept invite via joinToken (token appended as ?joinToken=abc after login)
router.get("/join/:token", ensureAuth, async (req, res) => {
  try {
    const token = String(req.params.token || req.query.joinToken || "");
    if (!token) return res.status(400).send("Missing join token");
    // find org with this invite token
    const org = await Organization.findOne({ "invites.token": token }).lean();
    if (!org) return res.status(404).send("Invite not found");
    // find invite entry to get role
    const invite = (org.invites || []).find(i => i.token === token);
    const role = invite?.role || "employee";
    // add membership
    await OrgMembership.findOneAndUpdate({ org: org._id, user: req.user._id }, { $set: { role, joinedAt: new Date() } }, { upsert: true });
    // optionally remove invite
    await Organization.updateOne({ _id: org._id }, { $pull: { invites: { token } } });
    return res.redirect(`/org/${org.slug}/dashboard`);
  } catch (e) {
    console.error("[org/join] error:", e && e.message);
    return res.status(500).send("Join failed");
  }
});

// Org dashboard (requires membership)
router.get("/:slug/dashboard", ensureAuth, async (req, res) => {
  try {
    const slug = String(req.params.slug || "").trim();
    const org = await Organization.findOne({ slug }).lean();
    if (!org) return res.status(404).send("Organization not found");
    const membership = await OrgMembership.findOne({ org: org._id, user: req.user._id }).lean();
    if (!membership) return res.status(403).send("You are not a member of this organization");
    // Render a minimal dashboard (list modules, link to quizzes)
    return res.render("org/dashboard", { user: req.user, org, membership });
  } catch (e) {
    console.error("[org/dashboard] error:", e && e.message);
    return res.status(500).send("Failed to load dashboard");
  }
});

export default router;
