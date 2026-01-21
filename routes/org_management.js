// routes/org_management.js
import { Router } from "express";
import crypto from "crypto";
import nodemailer from "nodemailer";
import mongoose from "mongoose";
import Certificate from "../models/certificate.js";
import Organization from "../models/organization.js";
import OrgInvite from "../models/orgInvite.js";
import OrgMembership from "../models/orgMembership.js";
import OrgModule from "../models/orgModule.js";
import User from "../models/user.js";
import ExamInstance from "../models/examInstance.js";
import QuizQuestion from "../models/question.js";
import Question from "../models/question.js";
import Attempt from "../models/attempt.js";
import { ensureAuth } from "../middleware/authGuard.js";

import multer from "multer";
import fs from "fs";
import { parse } from "csv-parse";

const upload = multer({
  dest: "uploads/",
  limits: { fileSize: 2 * 1024 * 1024 } // 2MB
});

const router = Router();

/* ------------------------------------------------------------------ */
/*  Admin check – uses ADMIN_EMAILS env (comma separated)              */
/* ------------------------------------------------------------------ */
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


async function assignOnboardingQuizzes({ orgId, userId }) {
  const existing = await ExamInstance.countDocuments({
    org: orgId,
    userId,
    isOnboarding: true,
    module: "responsibility"
  });

  if (existing > 0) return; // ✅ HARD STOP

  const questions = await QuizQuestion.aggregate([
    {
      $match: {
        module: "responsibility",
        $or: [{ organization: orgId }, { organization: null }]
      }
    },
    { $sample: { size: 5 } }
  ]);

  if (!questions.length) return;

  await ExamInstance.create({
    examId: crypto.randomUUID(),
    targetRole: "student",
    org: orgId,
    userId,
    module: "responsibility",
    isOnboarding: true,
    questionIds: questions.map(q => String(q._id)),
    choicesOrder: questions.map(q =>
      Array.from({ length: q.choices.length }, (_, i) => i)
    ),
    createdAt: new Date()
  });
}




function requireTeacherOrAdmin(req, res, next) {
  if (!["teacher", "org_admin"].includes(req.user.role)) {
    return res.status(403).send("Forbidden");
  }
  next();
}

// helper: check platform admin boolean
function isPlatformAdmin(req) {
  const adminEmails = (process.env.ADMIN_EMAILS || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return !!(req.user && req.user.email && adminEmails.includes(req.user.email.toLowerCase()));
}

/* ------------------------------------------------------------------ */
/*  Helper: allow platform admin OR org manager (role)                 */
/* ------------------------------------------------------------------ */
async function allowPlatformAdminOrOrgManager(req, res, next) {
  try {
    if (isPlatformAdmin(req)) return next();

    // not platform admin -> check org membership role
    const slug = String(req.params.slug || "").trim();
    const org = await Organization.findOne({ slug }).lean();
    if (!org) return res.status(404).send("org not found");

    const membership = await OrgMembership.findOne({ org: org._id, user: req.user._id }).lean();
    if (!membership) return res.status(403).send("Admins only (org membership required)");

    const role = String(membership.role || "").toLowerCase();
    if (role === "manager" || role === "admin") return next();

    return res.status(403).send("Admins only (insufficient role)");
  } catch (e) {
    console.error("[allowPlatformAdminOrOrgManager] error:", e && (e.stack || e));
    return res.status(500).send("server error");
  }
}

/* ------------------------------------------------------------------ */
/*  Nodemailer transporter helper                                     */
/* ------------------------------------------------------------------ */

let cachedTransporter = null;

function createTransporterFromEnv() {
  const host = process.env.SMTP_HOST;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  const port = Number(process.env.SMTP_PORT || 465);
  const secure =
    String(process.env.SMTP_SECURE || "true").toLowerCase() === "true";

  const hasRequired = !!(host && user && pass);

  console.log("[invite email] env snapshot:", {
    SMTP_HOST: host,
    SMTP_USER: user,
    SMTP_HAS_PASS: !!pass,
    SMTP_PORT: port,
    SMTP_SECURE: secure,
    BASE_URL: process.env.BASE_URL,
  });

  if (!hasRequired) {
    console.warn(
      "[invite email] SMTP env incomplete; host/user/pass are required"
    );
    return null;
  }

  const transporter = nodemailer.createTransport({
    host,
    port,
    secure, // true for 465 (SSL), false for 587 (STARTTLS)
    auth: { user, pass },
  });

  console.log(
    "[invite email] transporter created",
    `host=${host} port=${port} secure=${secure}`
  );
  return transporter;
}

function getTransporter() {
  if (cachedTransporter) return cachedTransporter;
  cachedTransporter = createTransporterFromEnv();
  return cachedTransporter;
}

/* ------------------------------------------------------------------ */
/*  ADMIN: Send invite                                                */
/*  POST /admin/orgs/:slug/invite                                     */
/* ------------------------------------------------------------------ */

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
      const invite = await OrgInvite.create({
        orgId: org._id,
        email,
        token,
        role,
      });

      const baseUrl = (process.env.BASE_URL || "").replace(/\/$/, "");
      const transporter = getTransporter();

      if (!transporter || !baseUrl) {
        console.warn(
          "[invite email] transporter not available or BASE_URL missing; invite email skipped",
          { hasTransporter: !!transporter, baseUrl }
        );
        return res.json({ ok: true, token: invite.token });
      }

      const inviteUrl = `${baseUrl}/org/join/${token}`;

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

/* ------------------------------------------------------------------ */
/*  ADMIN: Manage org page                                            */
/*  GET /admin/orgs/:slug/manage                                      */
/* ------------------------------------------------------------------ */

router.get(
  "/admin/orgs/:slug/manage",
  ensureAuth,
  ensureAdminEmails,
  async (req, res) => {
    try {
      const slug = String(req.params.slug || "");
      const org = await Organization.findOne({ slug }).lean();
      const isSchool = org.type === "school";

      if (!org) return res.status(404).send("org not found");

      const invites = await OrgInvite.find({ orgId: org._id })
        .sort({ createdAt: -1 })
        .lean();
     const membershipsRaw = await OrgMembership.find({ org: org._id })
  .populate("user")
  .lean();

const groups = {
  students: [],
  teachers: [],
  staff: [],
  admins: []
};

for (const m of membershipsRaw) {
  if (!m.user) continue;

  const role = String(m.role || "").toLowerCase();

  if (role === "student") {
    groups.students.push(m);
  } else if (role === "teacher") {
    groups.teachers.push(m);
  } else if (role === "employee" || role === "staff") {
    groups.staff.push(m);
  } else if (["admin", "manager", "org_admin"].includes(role)) {
    groups.admins.push(m);
  }
}

      const modules = await OrgModule.find({ org: org._id }).lean();
console.log("ORG ID:", org._id.toString());

const sample = await Question.findOne({ type: "comprehension" }).lean();
console.log("SAMPLE PASSAGE ORG:", sample?.organization?.toString());
// Load comprehension passages (org-specific + global)
const passagesRaw = await Question.find({
  type: "comprehension",
  $or: [
    { organization: org._id },
    { organization: { $exists: false } },
    { organization: null }
  ]
})
  .sort({ createdAt: -1 })
  .select("_id text module questionIds organization")
  .lean();

// Shape for UI
const passages = passagesRaw.map(p => ({
  _id: p._id,
  title: p.text || "Comprehension Passage",
  childCount: Array.isArray(p.questionIds) ? p.questionIds.length : 0,
  module: p.module || "general",
  organization: p.organization || null
}));

     /* return res.render("admin/org_manage", {
  org,
  invites,
  memberships,
  modules,
    passages,  
  user: req.user,
  isAdmin: true
});*/


return res.render("admin/org_manage", {
  org,
  invites,
  modules,
  passages,
  groups,
  user: req.user,
  isAdmin: true,
  isSchool
});


    } catch (err) {
      console.error("[admin org manage] error:", err && (err.stack || err));
      return res.status(500).send("failed");
    }
  }
);

/* ------------------------------------------------------------------ */
/*  ADMIN: View attempts list (platform admins OR org managers)       */
/*  GET /admin/orgs/:slug/attempts                                    */
/* ------------------------------------------------------------------ */
router.get(
  "/admin/orgs/:slug/attempts",
  ensureAuth,
  allowPlatformAdminOrOrgManager,
  async (req, res) => {
    try {
      const slug = String(req.params.slug || "").trim();
      const org = await Organization.findOne({ slug }).lean();
      if (!org) return res.status(404).send("org not found");

      // optional module filter
      const moduleFilter = req.query.module ? String(req.query.module).trim() : null;

      const filter = { organization: org._id };
      if (moduleFilter) filter.module = moduleFilter;

      const attempts = await Attempt.find(filter)
        .populate("userId")
        .sort({ createdAt: -1 })
        .lean();

      // shape some display fields
      const rows = attempts.map(a => ({
        _id: a._id,
        userName: a.userId ? (a.userId.displayName || a.userId.name || a.userId.email || "") : "",
        userEmail: a.userId ? a.userId.email || "" : "",
        module: a.module || "",
        score: a.score || 0,
        maxScore: a.maxScore || 0,
        passed: !!a.passed,
        startedAt: a.startedAt,
        finishedAt: a.finishedAt,
        createdAt: a.createdAt
      }));

      // try render a template (admin/org_attempts) if available, else fallback to JSON
      if (req.headers.accept && req.headers.accept.includes("text/html")) {
        return res.render("admin/org_attempts", { org, attempts: rows, moduleFilter: moduleFilter || "" });
      }
      return res.json({ org: org.slug, attempts: rows });
    } catch (e) {
      console.error("[admin attempts list] error:", e && (e.stack || e));
      return res.status(500).send("failed to load attempts");
    }
  }
);

/* ------------------------------------------------------------------ */
/*  ADMIN: View single attempt detail                                 */
/*  GET /admin/orgs/:slug/attempts/:attemptId                         */
/* ------------------------------------------------------------------ */
router.get(
  "/admin/orgs/:slug/attempts/:attemptId",
  ensureAuth,
  allowPlatformAdminOrOrgManager,
  async (req, res) => {
    try {
      const slug = String(req.params.slug || "").trim();
      const attemptId = String(req.params.attemptId || "").trim();

      const org = await Organization.findOne({ slug }).lean();
      if (!org) return res.status(404).send("org not found");

      const attempt = await Attempt.findById(attemptId).lean();
      if (!attempt) return res.status(404).send("attempt not found");

      // load questions referenced in attempt (if available)
      const qIds = Array.isArray(attempt.questionIds) ? attempt.questionIds.map(String) : [];
      let qDocs = [];
      if (qIds.length) {
        qDocs = await QuizQuestion.find({ _id: { $in: qIds } }).lean();
      }

      const qById = {};
      for (const q of qDocs) qById[String(q._id)] = q;

      // map answers array into lookup
      const answersLookup = {};
      if (Array.isArray(attempt.answers)) {
        for (const a of attempt.answers) {
          if (!a || !a.questionId) continue;
          answersLookup[String(a.questionId)] = (typeof a.choiceIndex === "number") ? a.choiceIndex : null;
        }
      }

      // Build details array preserving order of questionIds in attempt
      const details = [];
      for (const qid of qIds) {
        const q = qById[qid] || null;
        const yourIndex = answersLookup[qid] !== undefined ? answersLookup[qid] : null;

        let correctIndex = null;
        if (q) {
          if (typeof q.correctIndex === "number") correctIndex = q.correctIndex;
          else if (typeof q.answerIndex === "number") correctIndex = q.answerIndex;
          else if (typeof q.correct === "number") correctIndex = q.correct;
        }

        const choices = (q && Array.isArray(q.choices)) ? q.choices.map(c => (typeof c === "string" ? c : c.text || "")) : [];

        details.push({
          questionId: qid,
          text: q ? q.text : "(question not in DB)",
          choices,
          yourIndex,
          correctIndex,
          correct: (correctIndex !== null && yourIndex !== null) ? (correctIndex === yourIndex) : null
        });
      }

      // attempt user info (populate if needed)
      let userInfo = null;
      if (attempt.userId) {
        try {
          const u = await User.findById(attempt.userId).lean();
          if (u) userInfo = { _id: u._id, name: u.displayName || u.name || "", email: u.email || "" };
        } catch (e) { /* ignore */ }
      }

      if (req.headers.accept && req.headers.accept.includes("text/html")) {
        return res.render("admin/org_attempt_detail", {
          org,
          attempt,
          user: userInfo,
          details
        });
      }

      return res.json({ attemptId: attempt._id, org: org.slug, user: userInfo, score: attempt.score, maxScore: attempt.maxScore, details });
    } catch (e) {
      console.error("[admin attempt detail] error:", e && (e.stack || e));
      return res.status(500).send("failed to load attempt details");
    }
  }
);

/* ------------------------------------------------------------------ */
/*  PUBLIC: Join via invite token (must be logged in)                 */
/*  GET /org/join/:token                                              */
/* ------------------------------------------------------------------ */

router.get("/org/join/:token", ensureAuth, async (req, res) => {
  try {
    const token = String(req.params.token || "");
    if (!token) return res.status(400).send("token required");

    const invite = await OrgInvite.findOne({ token, used: false }).lean();
    if (!invite) return res.status(404).send("invite not found or used");

const membership = await OrgMembership.findOneAndUpdate(
  { org: invite.orgId, user: req.user._id },
  {
    $setOnInsert: {
      role: invite.role,
      joinedAt: new Date(),
      isOnboardingComplete: false
    }
  },
  { upsert: true, new: true }
);



// ✅ FIRST TIME JOIN → mark onboarding
if (membership?.joinedAt && Date.now() - membership.joinedAt.getTime() < 2000) {
  req.session.isFirstLogin = true;
  await assignOnboardingQuizzes({
  orgId: invite.orgId,
  userId: req.user._id
});

}

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

/* ------------------------------------------------------------------ */
/*  ADMIN: Member actions (promote/demote/remove)                     */
/*  POST /admin/orgs/:slug/members/:userId                            */
/* ------------------------------------------------------------------ */

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

/* ------------------------------------------------------------------ */
/*  ADMIN: Assign quiz to employees                                   */
/*  POST /admin/orgs/:slug/assign-quiz                                */
/*  (kept unchanged except minor style)                               */
/* ------------------------------------------------------------------ */

// (Keep your existing assign-quiz code here — I left it unchanged in your original file.)
// For brevity in this file I will reuse the code block you already had above in your original file.
// If you want me to paste the full assign-quiz implementation here too, tell me and I'll include it exactly as before.

/* ------------------------------------------------------------------ */
/*  ADMIN: Export attempts CSV                                        */
/*  GET /admin/orgs/:slug/reports/attempts.csv?module=xxx             */
/* ------------------------------------------------------------------ */

router.get(
  "/admin/orgs/:slug/reports/attempts.csv",
  ensureAuth,
  ensureAdminEmails,
  async (req, res) => {
    try {
      const slug = String(req.params.slug || "");
      const module = String(req.query.module || "");
      const org = await Organization.findOne({ slug }).lean();
      if (!org) return res.status(404).send("org not found");

      const filter = { organization: org._id };
      if (module) filter.module = module;

      const attempts = await Attempt.find(filter)
        .populate("userId")
        .sort({ createdAt: -1 })
        .lean();

      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="attempts_${org.slug}_${module || "all"}.csv"`
      );

      res.write(
        "userId,userEmail,module,score,maxScore,passed,startedAt,finishedAt\n"
      );

      for (const a of attempts) {
        const uid = a.userId ? String(a.userId._id) : a.userId || "";
        const email = a.userId ? a.userId.email || "" : "";
        const started = a.startedAt
          ? new Date(a.startedAt).toISOString()
          : "";
        const finished = a.finishedAt
          ? new Date(a.finishedAt).toISOString()
          : "";
        res.write(
          `${uid},${email},${a.module || ""},${a.score || 0},${
            a.maxScore || 0
          },${a.passed ? "1" : "0"},${started},${finished}\n`
        );
      }
      res.end();
    } catch (err) {
      console.error("[reports csv] error:", err && (err.stack || err));
      return res.status(500).send("failed");
    }
  }
);

/* ------------------------------------------------------------------ */
/*  ORG DASHBOARD (employees/managers)                                */
/*  GET /org/:slug/dashboard                                          */
/* ------------------------------------------------------------------ */
router.get("/org/:slug/dashboard", ensureAuth, async (req, res) => {
  try {
    const slug = String(req.params.slug || "").trim();

    const org = await Organization.findOne({ slug }).lean();
    if (!org) return res.status(404).send("org not found");

    const membership = await OrgMembership.findOne({
      org: org._id,
      user: req.user._id
    }).lean();

    if (!membership) {
      return res.status(403).send("You are not a member of this organization");
    }

    /* -------------------------------
       ADMIN CHECK (RESTORED)
    -------------------------------- */
    const platformAdmin = (process.env.ADMIN_EMAILS || "")
      .split(",")
      .map(e => e.trim().toLowerCase())
      .includes(req.user.email?.toLowerCase());

    const role = String(membership.role || "").toLowerCase();

    const isAdmin =
      platformAdmin || role === "admin" || role === "manager" || role === "org_admin";

    /* -------------------------------
       LOAD MODULES
    -------------------------------- */
    const modules = await OrgModule.find({ org: org._id }).lean();

    /* -------------------------------
       LOAD EXAMS (RAW)
    -------------------------------- */
 

// 🧠 detect first-time login
const isFirstLogin = !!req.session?.isFirstLogin;


let exams = [];

if (isAdmin) {
  // Admin sees all exams in org
  exams = await ExamInstance.find({ org: org._id })
    .sort({ createdAt: -1 })
    .lean();
} else {
  // User sees ONLY their assigned exams
if (membership.role === "student") {
  exams = await ExamInstance.find({
    org: org._id,
    userId: req.user._id,
    targetRole: "student",           // ✅ FILTER
    isOnboarding: membership.isOnboardingComplete === false
  })
    .sort({ createdAt: -1 })
    .lean();
} else if (membership.role === "teacher") {
  exams = await ExamInstance.find({
    org: org._id,
    userId: req.user._id,
    targetRole: "teacher",           // ✅ FILTER
    isOnboarding: false
  })
    .sort({ createdAt: -1 })
    .lean();
} else {
  // staff / admin fallback
  exams = await ExamInstance.find({
    org: org._id,
    userId: req.user._id
  })
    .sort({ createdAt: -1 })
    .lean();
}


}





    /* -------------------------------
       PRELOAD COMPREHENSION TITLES
    -------------------------------- */
    const parentIds = new Set();

    for (const ex of exams) {
      if (!Array.isArray(ex.questionIds)) continue;
      for (const q of ex.questionIds) {
        if (String(q).startsWith("parent:")) {
          parentIds.add(String(q).replace("parent:", ""));
        }
      }
    }

    const parentDocs = parentIds.size
      ? await QuizQuestion.find({ _id: { $in: [...parentIds] } })
          .select("_id title text")
          .lean()
      : [];

    const parentTitleMap = {};
    for (const p of parentDocs) {
      parentTitleMap[String(p._id)] =
        p.title || p.text || "Comprehension Quiz";
    }

    /* -------------------------------
       BUILD DASHBOARD DATA (DEDUPED)
    -------------------------------- */
    const quizzesByModule = {};
    //const seenExamIds = new Set();
    const seenKeys = new Set();
    const now = new Date();

   for (const ex of exams) {
  const logicalKey = `${ex.userId}-${ex.module}-${ex.targetRole}`;



  if (seenKeys.has(logicalKey)) continue;
  seenKeys.add(logicalKey);

      const moduleKey = ex.module || "general";
      if (!quizzesByModule[moduleKey]) {
        quizzesByModule[moduleKey] = [];
      }

      let status = "pending";
      if (ex.finishedAt) status = "completed";
      if (process.env.QUIZ_EXPIRY_ENABLED === "true") {
  if (ex.expiresAt && ex.expiresAt < now) status = "expired";
}


      let quizTitle =
        moduleKey.charAt(0).toUpperCase() + moduleKey.slice(1) + " Quiz";

      let questionCount = 0;

      if (Array.isArray(ex.questionIds)) {
        questionCount = ex.questionIds.filter(
          q => !String(q).startsWith("parent:")
        ).length;

        const parentMarker = ex.questionIds.find(q =>
          String(q).startsWith("parent:")
        );

        if (parentMarker) {
          const parentId = String(parentMarker).replace("parent:", "");
          quizTitle = parentTitleMap[parentId] || "Comprehension Quiz";
        }
      }

      const openUrl =
        `/org/${org.slug}/quiz` +
        `?examId=${encodeURIComponent(ex.examId)}` +
        `&quizTitle=${encodeURIComponent(quizTitle)}`;

      quizzesByModule[moduleKey].push({
        examId: ex.examId,
        quizTitle,
        questionCount,
        status,
        openUrl,
        createdAt: ex.createdAt
      });
    }

    /* -------------------------------
       USER ATTEMPTS
    -------------------------------- */
    const attempts = await Attempt.find({
      organization: org._id,
      userId: req.user._id
    })
      .sort({ finishedAt: -1 })
      .lean();

    const attemptRows = attempts.map(a => ({
      quizTitle: a.quizTitle || a.module || "Quiz",
      module: a.module || "",
      score: a.score || 0,
      maxScore: a.maxScore || 0,
      percentage: a.maxScore
        ? Math.round((a.score / a.maxScore) * 100)
        : 0,
      passed: !!a.passed,
      finishedAt: a.finishedAt || a.updatedAt || a.createdAt
    }));

    /* -------------------------------
       CERTIFICATES
    -------------------------------- */
    const certificates = await Certificate.find({
      userId: req.user._id,
      orgId: org._id
    })
      .sort({ createdAt: -1 })
      .lean();

const certRows = certificates.map(c => ({
  _id: c._id,
  quizTitle: c.quizTitle || c.courseTitle || "Quiz",
  percentage: c.percentage,
  createdAt: c.createdAt
}));



// 🔁 clear first-login flag after dashboard loads once
if (req.session?.isFirstLogin) {
  delete req.session.isFirstLogin;
}

    /* -------------------------------
       RENDER
    -------------------------------- */
    return res.render("org/dashboard", {
      org,
      membership,
      modules,
      quizzesByModule,
      hasAssignedQuizzes: Object.keys(quizzesByModule).length > 0,
      attemptRows,
      certRows,
      isAdmin,
      user: req.user
    });

  } catch (err) {
    console.error("[org dashboard] error:", err);
    return res.status(500).send("failed");
  }
});



// ------------------------------------------------------------------
// ADMIN: Delete assigned quiz (exam instance)
// POST /admin/orgs/:slug/quizzes/:examId/delete
// ------------------------------------------------------------------
router.post(
  "/admin/orgs/:slug/quizzes/:examId/delete",
  ensureAuth,
  allowPlatformAdminOrOrgManager,
  async (req, res) => {
    try {
      const slug = String(req.params.slug || "").trim();
      const examId = String(req.params.examId || "").trim();

      const org = await Organization.findOne({ slug }).lean();
      if (!org) return res.status(404).send("org not found");

      // delete exam instance
      const exam = await ExamInstance.findOneAndDelete({
        examId,
        org: org._id
      });

      if (!exam) {
        return res.status(404).send("quiz not found");
      }

      // delete related attempts
      await Attempt.deleteMany({ examId });

      return res.redirect(`/org/${org.slug}/dashboard`);
    } catch (err) {
      console.error("[delete quiz] error:", err && err.stack);
      return res.status(500).send("failed to delete quiz");
    }
  }
);



/* ------------------------------------------------------------------ */
/*  ORG: View a single module's learning material                     */
/*  GET /org/:slug/modules/:moduleSlug                                */
/* ------------------------------------------------------------------ */

router.get("/org/:slug/modules/:moduleSlug", ensureAuth, async (req, res) => {
  try {
    const slug = String(req.params.slug || "");
    const moduleSlug = String(req.params.moduleSlug || "");

    const org = await Organization.findOne({ slug }).lean();
    if (!org) return res.status(404).send("org not found");

    const membership = await OrgMembership.findOne({
      org: org._id,
      user: req.user._id,
    }).lean();
    if (!membership)
      return res
        .status(403)
        .send("You are not a member of this organization");

    const moduleDoc = await OrgModule.findOne({
      org: org._id,
      slug: moduleSlug,
    }).lean();
    if (!moduleDoc) return res.status(404).send("module not found");

    return res.render("org/module_detail", {
      org,
      membership,
      module: moduleDoc,
      user: req.user,
    });
  } catch (err) {
    console.error("[org module detail] error:", err && (err.stack || err));
    return res.status(500).send("failed");
  }
});

/* ------------------------------------------------------------------ */
/*  Member-facing quiz launcher for an org                             */
/*  GET /org/:slug/quiz?examId=...                                     */
/* ------------------------------------------------------------------ */


/* ------------------------------------------------------------------ */
/*  ORG QUIZ: employees/managers take module quiz (20 questions)       */
/* ------------------------------------------------------------------ */
// REPLACE the later duplicate handler with this version
router.get("/org/:slug/quiz", ensureAuth, async (req, res) => {
  try {
    const slug = String(req.params.slug || "").trim();
    const moduleNameRaw = String(req.query.module || "Responsibility").trim();
    const examId = String(req.query.examId || "").trim(); // <-- respect examId if provided

    const org = await Organization.findOne({ slug }).lean();
    if (!org) return res.status(404).send("org not found");

    const membership = await OrgMembership.findOne({
      org: org._id,
      user: req.user._id,
    }).lean();
    if (!membership) {
      return res.status(403).send("You are not a member of this organization");
    }

    // If an examId was supplied, redirect to the LMS page with that examId so client requests exact exam instance
    if (examId) {
      // preserve examId in query so /lms/quiz uses it
     // return res.redirect(`/lms/quiz?examId=${encodeURIComponent(examId)}&org=${encodeURIComponent(org.slug)}`);

     const quizTitle = req.query.quizTitle
  ? `&quizTitle=${encodeURIComponent(req.query.quizTitle)}`
  : "";

return res.redirect(
  `/lms/quiz?examId=${encodeURIComponent(examId)}&org=${encodeURIComponent(org.slug)}${quizTitle}`
);

    }

    // No examId: render the normal org module quiz UI (sampling mode / 20 questions)
    const moduleKey = moduleNameRaw.toLowerCase();

    return res.render("lms/quiz", {
      user: req.user,
      quizCount: 20,
      moduleLabel: `${moduleNameRaw} | ${org.slug} Quiz`,
      modules,
      orgSlug: org.slug,
      examId: ""
    });
  } catch (err) {
    console.error("[org quiz] error:", err && (err.stack || err));
    return res.status(500).send("failed");
  }
});


// REPLACE assign-quiz handler
router.post(
  "/admin/orgs/:slug/assign-quiz",
  ensureAuth,
  ensureAdminEmails,
  async (req, res) => {
    try {
     const slug = String(req.params.slug || "");

let {
  modules = [],
  userIds = [],
  grade = null,
  targetRole = "student",
  count = 20,
  expiresMinutes = 60,
  passageId = null
} = req.body || {};


// ✅ validate modules
if (!Array.isArray(modules) || !modules.length) {
  return res.status(400).json({
    error: "At least one module must be selected"
  });
}

modules = modules.map(m => String(m).trim().toLowerCase());



const moduleKey = modules[0];




// 🔹 Load org FIRST
const org = await Organization.findOne({ slug }).lean();
if (!org) return res.status(404).json({ error: "org not found" });

// ----------------------------------
// 🎓 SCHOOL MODE: resolve users by grade
// ----------------------------------
if (org.type === "school") {

  if (targetRole === "teacher") {
    const teachers = await User.find({
      organization: org._id,
      role: "teacher"
    }).select("_id");

    if (!teachers.length) {
      return res.status(404).json({
        error: "No teachers found in this school"
      });
    }

    userIds = teachers.map(t => String(t._id));

  } else {
    // default: students by grade
    const gradeNum = Number(grade);

    if (!Number.isInteger(gradeNum) || gradeNum <= 0) {
      return res.status(400).json({
        error: "valid grade required for student assignments"
      });
    }

    const students = await User.find({
      organization: org._id,
      role: "student",
      grade: gradeNum
    }).select("_id");

    if (!students.length) {
      return res.status(404).json({
        error: `No students found for grade ${gradeNum}`
      });
    }

    userIds = students.map(s => String(s._id));
  }
}

// ----------------------------------
// NON-SCHOOL ORGS MUST PROVIDE userIds
// ----------------------------------
if (org.type !== "school") {
  if (!Array.isArray(userIds) || !userIds.length) {
    return res.status(400).json({ error: "userIds required" });
  }
}



      const baseUrl = (process.env.BASE_URL || "").replace(/\/$/, "");
      const assigned = [];

      // If passageId provided -> create exam instances that ONLY contain parent + its children
      if (passageId) {
        // validate id shape
        if (!passageId || !mongoose.isValidObjectId(String(passageId))) {
          return res.status(400).json({ error: "invalid passageId" });
        }

        // load parent passage doc
        const parent = await QuizQuestion.findById(String(passageId)).lean().exec();
        if (!parent) return res.status(404).json({ error: "passage not found" });

        // optional: ensure passage belongs to this org (or allow platform/global ones)
        if (parent.organization && String(parent.organization) !== String(org._id)) {
          // allow platform admins to assign passages from other orgs? For now restrict:
          return res.status(403).json({ error: "passage does not belong to this organization" });
        }

        const childIds = Array.isArray(parent.questionIds) ? parent.questionIds.map(String) : [];

        if (!childIds.length) {
          return res.status(400).json({ error: "passage has no child questions" });
        }

        // For each user create exam instance with: ['parent:<parentId>', childId1, childId2, ...]
        for (const uId of userIds) {
          try {

            // ⛔ PREVENT DUPLICATE ASSIGNMENT FOR SAME MODULE
const alreadyAssigned = await ExamInstance.exists({
  org: org._id,
  userId: mongoose.Types.ObjectId(uId),
  module: moduleKey,
  isOnboarding: false,
  expiresAt: { $ne: null }
});


if (alreadyAssigned) {
  continue; // 🚫 skip duplicate
}

            const questionIds = [];
            const choicesOrder = [];

            // push parent marker as string
            questionIds.push(`parent:${String(parent._id)}`);
            choicesOrder.push([]); // placeholder for parent marker

            // push each child as string id and populate choicesOrder with shuffled mapping
            for (const cid of childIds) {
              questionIds.push(String(cid));

              // load child doc to know number of choices
              let nChoices = 0;
              try {
                const childDoc = await QuizQuestion.findById(String(cid)).lean().exec();
                if (childDoc) nChoices = Array.isArray(childDoc.choices) ? childDoc.choices.length : 0;
              } catch (e) {
                // ignore, treat as 0
                nChoices = 0;
              }

              const indices = Array.from({ length: Math.max(0, nChoices) }, (_, i) => i);
              // shuffle indices
              for (let i = indices.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [indices[i], indices[j]] = [indices[j], indices[i]];
              }
              choicesOrder.push(indices);
            }

            const examId = crypto.randomUUID();
            //const expiresAt = new Date(Date.now() + Number(expiresMinutes) * 60 * 1000);

            const expiresAt =
  process.env.QUIZ_EXPIRY_ENABLED === "true"
    ? new Date(Date.now() + Number(expiresMinutes) * 60 * 1000)
    : null;

            await ExamInstance.create({
              examId,
              org: org._id,
              module: moduleKey,
              //user: mongoose.Types.ObjectId(uId),
              userId: mongoose.Types.ObjectId(uId),
 isOnboarding: false,
              // store string ids and parent marker (ExamInstance schema must accept Mixed or [String])
              questionIds,
              choicesOrder,
              targetRole: targetRole, // "student" or "teacher"
              expiresAt,
              createdAt: new Date(),
              createdByIp: req.ip,
            });

          

            const url = `${baseUrl}/org/${org.slug}/quiz?examId=${examId}`;
            assigned.push({ userId: uId, examId, url });
          } catch (e) {
            console.warn("[assign-quiz][passage] user assign failed", uId, e && (e.stack || e));
          }
        } // end for userIds

       // 🔓 UNLOCK USERS AFTER ADMIN ASSIGNS PASSAGE QUIZ
await OrgMembership.updateMany(
  {
    org: org._id,
    user: { $in: userIds.map(id => mongoose.Types.ObjectId(id)) }
  },
  {
    $set: { isOnboardingComplete: true }
  }
);

return res.json({
  ok: true,
  assigned,
  countUsed: childIds.length,
  passageAssigned: String(parent._id)
});

      }

      // ---------- No passageId: previous sampling behavior ----------
      // case-insensitive match on module + org/global questions
const match = {
  $or: [{ organization: org._id }, { organization: null }],
  module: { $in: modules }
};


      const totalAvailable = await QuizQuestion.countDocuments(match);
      console.log("[assign quiz] available questions:", totalAvailable, "for module=", modules, "org=", org._id.toString());
      if (!totalAvailable) {
        return res.status(404).json({ error: "no questions available for that module" });
      }

      count = Math.max(1, Math.min(Number(count) || 1, totalAvailable));
      const pipeline = [{ $match: match }, { $sample: { size: count } }];
      const docs = await QuizQuestion.aggregate(pipeline).allowDiskUse(true);
      if (!docs || !docs.length) {
        return res.status(404).json({ error: "no questions returned from sampling" });
      }

      // create exam per user from sampled docs (existing logic; store IDs as strings)
      for (const uId of userIds) {
        try {

          // ⛔ PREVENT DUPLICATE PASSAGE ASSIGNMENT
const alreadyAssigned = await ExamInstance.exists({
  org: org._id,
  userId: mongoose.Types.ObjectId(uId),
  module: moduleKey,
  isOnboarding: false,
  expiresAt: { $ne: null }
});


if (alreadyAssigned) {
  continue;
}

          const questionIds = [];
          const choicesOrder = [];

          for (const q of docs) {
            const isComprehension = (q && (q.type === "comprehension" || (q.passage && Array.isArray(q.questionIds) && q.questionIds.length)));

            if (isComprehension) {
              questionIds.push(`parent:${String(q._id)}`);
              choicesOrder.push([]);

              const childIds = Array.isArray(q.questionIds) ? q.questionIds.map(String) : [];
              if (childIds.length) {
                for (const cid of childIds) {
                  questionIds.push(String(cid));
                  // build shuffled mapping for child
                  let nChoices = 0;
                  const childDoc = await QuizQuestion.findById(String(cid)).lean().exec();
                  if (childDoc) nChoices = Array.isArray(childDoc.choices) ? childDoc.choices.length : 0;
                  const indices = Array.from({ length: Math.max(0, nChoices) }, (_, i) => i);
                  for (let i = indices.length - 1; i > 0; i--) {
                    const j = Math.floor(Math.random() * (i + 1));
                    [indices[i], indices[j]] = [indices[j], indices[i]];
                  }
                  choicesOrder.push(indices);
                }
              }
            } else {
              questionIds.push(String(q._id));
              const n = Array.isArray(q.choices) ? q.choices.length : 0;
              const indices = Array.from({ length: Math.max(0, n) }, (_, i) => i);
              for (let i = indices.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [indices[i], indices[j]] = [indices[j], indices[i]];
              }
              choicesOrder.push(indices);
            }
          }

          const examId = crypto.randomUUID();
        //  const expiresAt = new Date(Date.now() + Number(expiresMinutes) * 60 * 1000);

        const expiresAt =
  process.env.QUIZ_EXPIRY_ENABLED === "true"
    ? new Date(Date.now() + Number(expiresMinutes) * 60 * 1000)
    : null;


          await ExamInstance.create({
            examId,
            org: org._id,
            module: moduleKey,
            userId: mongoose.Types.ObjectId(uId),
            questionIds,
             isOnboarding: false,
             targetRole: targetRole, // "student" or "teacher"

            choicesOrder,
            expiresAt,
            createdAt: new Date(),
            createdByIp: req.ip,
          });

         
          const url = `${baseUrl}/org/${org.slug}/quiz?examId=${examId}`;
          assigned.push({ userId: uId, examId, url });
        } catch (e) {
          console.warn("[assign-quiz] user assign failed", uId, e && (e.stack || e));
        }
      } // end for userIds
// 🔓 UNLOCK USERS AFTER ADMIN ASSIGNS QUIZ
await OrgMembership.updateMany(
  {
    org: org._id,
    user: { $in: userIds.map(id => mongoose.Types.ObjectId(id)) }
  },
  {
    $set: { isOnboardingComplete: true }
  }
);

return res.json({ ok: true, assigned, countUsed: docs.length });

    } catch (err) {
      console.error("[assign quiz] error:", err && (err.stack || err));
      return res.status(500).json({ error: "assign failed" });
    }
  }
);

/////////////import students

router.post(
  "/admin/orgs/:slug/import-students",
  ensureAuth,
  ensureAdminEmails,
  upload.single("csv"),
  async (req, res) => {
    try {
      const slug = String(req.params.slug || "");
      const org = await Organization.findOne({ slug }).lean();
      if (!org) return res.status(404).json({ error: "org not found" });

      if (org.type !== "school") {
        return res.status(400).json({ error: "Only school orgs can import students" });
      }

      if (!req.file) {
        return res.status(400).json({ error: "CSV file required" });
      }

      let created = 0;
      let skipped = 0;
      const errors = [];

      const stream = fs.createReadStream(req.file.path).pipe(
        parse({
          columns: true,
          trim: true,
          skip_empty_lines: true
        })
      );

      for await (const row of stream) {
        try {
          const studentId = String(row.studentId || "").trim();
          const firstName = String(row.firstName || "").trim();
          const lastName = String(row.lastName || "").trim();
          const gradeNum = Number(row.grade);

          if (!studentId || !firstName || !lastName || !Number.isInteger(gradeNum)) {
            skipped++;
            errors.push({ row, error: "invalid fields" });
            continue;
          }

          const exists = await User.findOne({
            organization: org._id,
            studentId
          }).lean();

          if (exists) {
            skipped++;
            continue;
          }

        const user = await User.create({
  organization: org._id,
  role: "student",
  studentId,
  grade: gradeNum,
  firstName,
  lastName
});

// ✅ ALSO create org membership
await OrgMembership.findOneAndUpdate(
  { org: org._id, user: user._id },
  {
    $set: {
      role: "student",
      joinedAt: new Date()
    }
  },
  { upsert: true }
);


          created++;
        } catch (e) {
          skipped++;
          errors.push({ row, error: e.message });
        }
      }

      fs.unlink(req.file.path, () => {});

      return res.json({ ok: true, created, skipped, errors });
    } catch (err) {
      console.error("[import students]", err);
      return res.status(500).json({ error: "import failed" });
    }
  }
);








router.get(
  "/admin/orgs/:slug/modules",
  ensureAuth,
  ensureAdminEmails,
  async (req, res) => {
    try {
      const slug = req.params.slug;
      const org = await Organization.findOne({ slug }).lean();
      if (!org) return res.status(404).send("Org not found");

      const modules = await OrgModule.find({ org: org._id }).lean();

      res.render("admin/org_modules", {
        org,
        modules,
      });
    } catch (err) {
      console.error("Load modules error:", err);
      res.status(500).send("Failed to load modules");
    }
  }
);

router.post(
  "/admin/orgs/:slug/modules",
  ensureAuth,
  ensureAdminEmails,
  async (req, res) => {
    try {
      const orgSlug = req.params.slug;
      const { slug, title, description } = req.body;

      if (!slug || !title) {
        return res.status(400).send("Module slug and title are required");
      }

      const org = await Organization.findOne({ slug: orgSlug });
      if (!org) return res.status(404).send("Org not found");

      await OrgModule.findOneAndUpdate(
        { org: org._id, slug },
        { title, description },
        { upsert: true, new: true }
      );

      res.redirect(`/admin/orgs/${orgSlug}/modules`);
    } catch (err) {
      if (err.code === 11000) {
        console.warn("[modules] duplicate org/slug ignored", err.keyValue);
        return res.redirect(`/admin/orgs/${req.params.slug}/modules?dup=1`);
      }

      console.error("Save module error:", err);
      res.status(500).send("Failed to save module");
    }
  }
);



// POST /admin/orgs/:slug/passages
// Create a comprehension (passage) + child questions for an organization
// POST /admin/orgs/:slug/passages
// Creates a comprehension parent + child questions (organization-scoped)
router.post(
  "/admin/orgs/:slug/passages",
  ensureAuth,
  allowPlatformAdminOrOrgManager,
  async (req, res) => {
    try {
      const slug = String(req.params.slug || "").trim();
      const org = await Organization.findOne({ slug }).lean();
      if (!org) return res.status(404).json({ error: "org not found" });

      const payload = req.body || {};
      const title = String(payload.title || "").trim();
      const moduleKey = String(payload.module || "general").trim().toLowerCase();
      const passage = String(payload.passage || "").trim();
      const questionsText = String(payload.questions || "").trim();

      if (!title) return res.status(400).json({ error: "title required" });
      if (!passage) return res.status(400).json({ error: "passage text required" });
      if (!questionsText) return res.status(400).json({ error: "questions text required" });

      // Helper: parseQuestionBlocks (same logic as your importer)
      function parseQuestionBlocks(raw) {
        if (!raw || typeof raw !== "string") return [];
        const normalized = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
        const blocks = normalized.split(/\n{2,}/).map(b => b.trim()).filter(Boolean);
        const parsed = [];

        for (const block of blocks) {
          const lines = block.split("\n").map(l => l.replace(/\t/g, ' ').trim()).filter(Boolean);
          if (lines.length === 0) continue;

          const isChoiceLine = (s) => /^[a-d][\.\)]\s+/i.test(s) || /^\([a-d]\)\s+/i.test(s) || /^[A-D]\)\s+/i.test(s);
          const isCorrectLine = (s) => /Correct Answer:/i.test(s) || /✅\s*Correct Answer:/i.test(s);

          let firstChoiceIdx = lines.findIndex(isChoiceLine);
          if (firstChoiceIdx === -1) {
            firstChoiceIdx = lines.findIndex(l => /^[a-d]\s+/.test(l) || /^[A-D]\)\s+/.test(l));
          }

          let questionLines = [];
          let choiceLines = [];
          let footerLines = [];

          if (firstChoiceIdx > 0) {
            questionLines = lines.slice(0, firstChoiceIdx);
            let i = firstChoiceIdx;
            for (; i < lines.length; i++) {
              const line = lines[i];
              if (isCorrectLine(line)) {
                footerLines.push(line);
                i++;
                break;
              }
              if (isChoiceLine(line) || /^[a-d]\s+/.test(line) || /^[A-D]\)\s+/.test(line)) {
                choiceLines.push(line);
              } else {
                if (choiceLines.length) {
                  choiceLines[choiceLines.length - 1] += " " + line;
                } else {
                  questionLines.push(line);
                }
              }
            }
            for (let j = i; j < lines.length; j++) footerLines.push(lines[j]);
          } else {
            questionLines = [lines[0]];
            for (let i = 1; i < lines.length; i++) {
              const l = lines[i];
              if (isChoiceLine(l) || /^[a-d]\s+/.test(l) || /^[A-D]\)\s+/.test(l)) {
                choiceLines.push(l);
              } else if (isCorrectLine(l)) {
                footerLines.push(l);
              } else {
                if (choiceLines.length === 0) questionLines.push(l);
                else choiceLines[choiceLines.length - 1] += " " + l;
              }
            }
          }

          let questionText = questionLines.join(" ").trim();
          questionText = questionText.replace(/^\d+\.\s*/, "").trim();

          const choices = choiceLines.map(cl => {
            const txt = cl.replace(/^[\(\[]?[a-d][\)\.\]]?\s*/i, "").trim();
            return { text: txt };
          });

          let correctIndex = null;
          const footer = footerLines.join(" ").trim();
          if (footer) {
            const m = footer.match(/Correct Answer:\s*[:\-]?\s*([a-d])\b/i);
            if (m) correctIndex = { a:0,b:1,c:2,d:3 }[m[1].toLowerCase()];
            else {
              const m2 = footer.match(/([a-d])\)/i);
              if (m2) correctIndex = { a:0,b:1,c:2,d:3 }[m2[1].toLowerCase()];
              else {
                const stripped = footer.replace(/Correct Answer:/i, "").replace(/✅/g, "").trim();
                const found = choices.findIndex(c => {
                  const lc = (c.text||"").toLowerCase();
                  const sc = stripped.toLowerCase();
                  return lc.startsWith(sc) || lc === sc || sc.startsWith(lc);
                });
                if (found >= 0) correctIndex = found;
              }
            }
          }

          if (!questionText) {
            const possible = block.split("\n").map(s => s.trim()).filter(Boolean);
            const fallback = possible.find(l => !isChoiceLine(l) && !isCorrectLine(l));
            if (fallback) questionText = fallback.replace(/^\d+\.\s*/, "").trim();
          }

          if (!questionText) continue;
          if (!choices.length) continue;

          parsed.push({
            text: questionText,
            choices,
            correctIndex: typeof correctIndex === "number" ? correctIndex : null,
            rawBlock: block
          });
        }
        return parsed;
      }

      // parse questions text
      const blocks = parseQuestionBlocks(questionsText);
      if (!blocks || !blocks.length) {
        return res.status(400).json({ error: "No valid child questions parsed from 'questions' text" });
      }

      // Build child docs
      const childDocs = blocks.map(b => {
        const choices = (b.choices || []).map(c => ({ text: (c && c.text) ? String(c.text).trim() : String(c).trim() })).filter(c => c.text);
        let ci = (typeof b.correctIndex === "number") ? b.correctIndex : null;
        if (ci === null || ci < 0 || ci >= choices.length) ci = 0;
        return {
          text: (b.text || "Question").trim(),
          choices,
          correctIndex: ci,
          tags: Array.isArray(b.tags) ? b.tags : [],
          source: "passage-import",
          organization: org._id,
          module: moduleKey || "general",
          raw: b.rawBlock || "",
          createdAt: new Date()
        };
      });

      // Insert children
      let insertedChildren = [];
      try {
        insertedChildren = await Question.insertMany(childDocs, { ordered: true });
      } catch (e) {
        console.error("[create passage] failed to insert child questions:", e && (e.stack || e));
        return res.status(500).json({ error: "Failed to save child questions", detail: String(e && e.message) });
      }

      const childIds = insertedChildren.map(c => c._id);

      // Create parent comprehension doc (use text to store title)
      const parentDoc = {
        text: title || (String(passage || "").slice(0, 120) || "Comprehension passage"),
        type: "comprehension",
        passage,
        questionIds: childIds,
        tags: [],
        source: "passage-import",
        organization: org._id,
        module: moduleKey || "general",
        createdAt: new Date()
      };

      let parent = null;
      try {
        parent = await Question.create(parentDoc);
      } catch (e) {
        console.error("[create passage] failed to create parent doc:", e && (e.stack || e));
        // Attempt cleanup of inserted children if parent creation failed
        try { await Question.deleteMany({ _id: { $in: childIds } }); } catch(_) {}
        return res.status(500).json({ error: "Failed to create parent passage", detail: String(e && e.message) });
      }

      // Optionally add a tag on children for quick lookup (e.g. comprehension-<parentId>)
      try {
        await Question.updateMany({ _id: { $in: childIds } }, { $addToSet: { tags: `comprehension-${parent._id}` } }).exec();
      } catch (e) {
        console.warn("[create passage] failed to tag children:", e && e.message);
      }

      // Return a small metadata object for client to append to passage select
      return res.json({
        passage: {
          _id: String(parent._id),
          title: parent.text,
          childCount: childIds.length,
          module: parent.module || moduleKey || "general"
        }
      });
    } catch (err) {
      console.error("[POST /admin/orgs/:slug/passages] error:", err && (err.stack || err));
      return res.status(500).json({ error: "failed", detail: String(err && err.message) });
    }
  }
);


router.post(
  "/admin/orgs/:slug/students/:userId/password",
  ensureAuth,
  ensureAdminEmails,
  async (req, res) => {
    try {
      const { slug, userId } = req.params;
      const { password } = req.body;

      if (!password || password.length < 4) {
        return res.status(400).json({ error: "Password too short" });
      }

      const org = await Organization.findOne({ slug });
      if (!org || org.type !== "school") {
        return res.status(403).json({ error: "School org only" });
      }

      const user = await User.findOne({
        _id: userId,
        organization: org._id,
        role: "student"
      });

      if (!user) {
        return res.status(404).json({ error: "Student not found" });
      }

      await user.setPassword(password);
      await user.save();

      res.json({ ok: true });
    } catch (err) {
      console.error("[set student password]", err);
      res.status(500).json({ error: "Failed to set password" });
    }
  }
);






router.post("/admin/orgs/:slug/import-teachers",
  ensureAuth,
  ensureAdminEmails,
  upload.single("csv"),
  async (req, res) => {
    try {
      const org = await Organization.findOne({ slug: req.params.slug });
      if (!org || org.type !== "school") {
        return res.status(400).json({ error: "School org only" });
      }

      let created = 0;
      let skipped = 0;
      const errors = [];

      const stream = fs.createReadStream(req.file.path).pipe(
        parse({ columns: true, trim: true })
      );

      for await (const row of stream) {
        try {
          const teacherId = String(row.teacherId || "").trim();
          const email = String(row.email || "").toLowerCase().trim();
          const firstName = String(row.firstName || "").trim();
          const lastName = String(row.lastName || "").trim();

          if (!teacherId || !firstName || !lastName) {
            skipped++;
            continue;
          }

          let user = await User.findOne({
            organization: org._id,
            teacherId
          });

          if (!user) {
            user = await User.create({
              organization: org._id,
              role: "teacher",
              teacherId,
              email,
              firstName,
              lastName
            });
          }

          await OrgMembership.findOneAndUpdate(
            { org: org._id, user: user._id },
            { $set: { role: "teacher", joinedAt: new Date() } },
            { upsert: true }
          );

          created++;
        } catch (e) {
          skipped++;
          errors.push(e.message);
        }
      }

      fs.unlink(req.file.path, () => {});
      res.json({ ok: true, created, skipped, errors });
    } catch (err) {
      console.error("[import teachers]", err);
      res.status(500).json({ error: "import failed" });
    }
  }
);




router.post(
  "/admin/orgs/:slug/teachers/:userId/password",
  ensureAuth,
  ensureAdminEmails,
  async (req, res) => {
    try {
      const { slug, userId } = req.params;
      const { password } = req.body;

      if (!password || password.length < 4) {
        return res.status(400).json({ error: "Password too short" });
      }

      const org = await Organization.findOne({ slug });
      if (!org) {
        return res.status(404).json({ error: "Org not found" });
      }

      const user = await User.findOne({
        _id: userId,
        role: "teacher"
      });

      if (!user) {
        return res.status(404).json({ error: "Teacher not found" });
      }

      await user.setPassword(password);
      await user.save();

      res.json({ ok: true });
    } catch (err) {
      console.error("[set teacher password]", err);
      res.status(500).json({ error: "Failed to set password" });
    }
  }
);



// export default router
export default router;
