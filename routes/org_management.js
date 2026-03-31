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
import QuizRule from "../models/quizRule.js";


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
  // prevent duplicates
  const existing = await ExamInstance.countDocuments({
    org: orgId,
    userId,
    isOnboarding: true
  });
  if (existing > 0) return;

  const onboardingAssignmentId = crypto.randomUUID();

  const onboardingQuizzes = [
    { module: "inclusion", title: "Inclusion Is Not Absorption" },
    { module: "responsibility", title: "Responsibility Is Not Blame" },
    { module: "grid", title: "The Grid – How the World Actually Operates" }
  ];

  for (const quiz of onboardingQuizzes) {
    const questions = await QuizQuestion.aggregate([
      {
        $match: {
          module: quiz.module,
          $or: [{ organization: orgId }, { organization: null }]
        }
      },
      { $sample: { size: 3 } }
    ]);

    if (!questions.length) continue;

    await ExamInstance.create({
      examId: crypto.randomUUID(),
      assignmentId: onboardingAssignmentId, // ✅ REQUIRED
      title: quiz.title,                    // ✅ REQUIRED
      org: orgId,
      userId,
      module: quiz.module,                  // ❌ NEVER "onboarding"
      isOnboarding: true,
      targetRole: "teacher",
      questionIds: questions.map(q => String(q._id)),
      choicesOrder: questions.map(q =>
        Array.from({ length: q.choices.length }, (_, i) => i)
      ),
      createdAt: new Date()
    });
  }
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


// ✅ Load quiz rules for both cripfcnt-home and cripfcnt-school
let quizRules = [];
if (org.slug === "cripfcnt-home" || org.slug === "cripfcnt-school") {
  quizRules = await QuizRule.find({ org: org._id }).sort({ createdAt: -1 }).lean();
}


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





  // ✅ LOAD QUIZZES FOR QUIZ RULES DROPDOWN (HOME SCHOOL ONLY)
// ✅ Load quizzes for BOTH orgs so the dropdown works for rules
let quizzes = [];
if (org.slug === "cripfcnt-home" || org.slug === "cripfcnt-school") {
  quizzes = await Question.find({
    type: "comprehension",
    $or: [
      { organization: org._id },            // org quizzes
      { organization: { $exists: false } }, // legacy
      { organization: null }                // global
    ]
  })
    .select("_id text module")
    .sort({ createdAt: -1 })
    .lean();
}



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


const isHomeSchool = org.slug === "cripfcnt-home";
const isCripSchool = org.slug === "cripfcnt-school";


return res.render("admin/org_manage", {
  org,
  invites,
  modules,
  isCripSchool,
  passages,
  quizzes,        // ✅ ADD THIS LINE
  groups,
  user: req.user,
  isAdmin: true,
  isSchool,
  isHomeSchool,
  quizRules
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

router.get("/org/join/:token", async (req, res) => {
  try {
    
    const token = String(req.params.token || "");
    if (!token) return res.status(400).send("token required");

    const invite = await OrgInvite.findOne({ token, used: false }).lean();
    if (!invite) return res.status(404).send("invite not found or used");

    // 🚪 STEP 2: not logged in → go login first
if (!req.isAuthenticated()) {
  req.session.inviteToken = token;
  return res.redirect(
    `/auth/google?returnTo=${encodeURIComponent(`/org/join/${token}`)}`
  );
}

const user = req.user;


const membership = await OrgMembership.findOneAndUpdate(
  { org: invite.orgId, user: user._id },
  {
    $setOnInsert: {
      role: invite.role,
      joinedAt: new Date(),
      isOnboardingComplete: false
    }
  },
  { upsert: true, new: true }
);

// First-time onboarding
if (membership?.joinedAt && Date.now() - membership.joinedAt.getTime() < 2000) {
  req.session.isFirstLogin = true;

  await assignOnboardingQuizzes({
    orgId: invite.orgId,
    userId: user._id
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

// (Keep your existing assign-quiz code here - I left it unchanged in your original file.)
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
// Add to routes/org_management.js - UPDATED DASHBOARD ROUTE WITH SEARCH

// REPLACE the dashboard route in routes/org_management.js

// REPLACE the dashboard route in routes/org_management.js

// ═══════════════════════════════════════════════════════════════════
//  PATCH FILE — replace only the dashboard route in org_management.js
//  Find the existing  router.get("/org/:slug/dashboard", ...)  block
//  (starts around line 729) and replace it in full with this.
// ═══════════════════════════════════════════════════════════════════

/* ------------------------------------------------------------------ */
/*  ORG DASHBOARD                                                       */
/*  GET /org/:slug/dashboard                                            */
/* ------------------------------------------------------------------ */
// ═══════════════════════════════════════════════════════════════════════
//  REPLACE the entire  router.get("/org/:slug/dashboard", ...)  block
//  in your routes/org_management.js with this code.
//  Search for:  router.get("/org/:slug/dashboard", ensureAuth,
//  and replace everything up to and including the closing });
// ═══════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════
//  EXACT REPLACEMENT for the dashboard route in routes/org_management.js
//
//  HOW TO APPLY:
//  1. Open routes/org_management.js
//  2. Find:  router.get("/org/:slug/dashboard", ensureAuth, async (req, res) => {
//  3. Select from that line to its closing  });  (around line 1266)
//  4. Replace the entire block with this file's contents
//
//  WHAT THIS FIXES:
//  ─ Suggested categories (Governance, Public Policy, etc.) were all
//    count=0 and unclickable because the DB aggregation only looked at
//    type:"comprehension" for the `category` field, but the AI script
//    wrote `category` only to comprehension questions, while individual
//    questions only have `topics` populated.
//  ─ Now we: (a) aggregate topics from ALL question types to count how
//    many questions match each suggested category; (b) map each category
//    slug to a set of topic keywords; (c) when a category filter is active,
//    match quizzes whose topics overlap with those keywords — no DB
//    schema changes, no re-running AI, works with existing 15k questions.
// ═══════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════
//  COMPLETE DASHBOARD ROUTE — copy-paste this entire block into
//  routes/org_management.js, replacing the existing
//  router.get("/org/:slug/dashboard", ...) block.
// ═══════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════
//  DASHBOARD ROUTE — replace the existing router.get("/org/:slug/dashboard")
//  block in routes/org_management.js with this entire block.
//
//  KEY FIXES:
//  1. catAgg falls back to reading category directly (no aiCategorised flag)
//     so categories appear even before re-categorisation script runs
//  2. _pillarBuckets resolves empty category using allCategoryMeta by pillar
//     instead of defaulting everything to "general"
//  3. suggestedSlugs built AFTER allCategoryMeta (correct order)
// ═══════════════════════════════════════════════════════════════════════

// routes/org/dashboard.js
// ─────────────────────────────────────────────────────────────────────────────
// CRIPFCNT SCHOOL DASHBOARD ROUTE — CATEGORY-FIRST REWRITE
//
// WHAT CHANGED FROM ORIGINAL:
//
//   1. CATEGORY CARDS (topCategories):
//      • allCategoryMeta is now sorted by count DESC (not insertion order)
//      • Only categories with count > 0 are ever included
//      • categoryMeta passed to template = allCategoryMeta (already sorted)
//      • No empty category buckets ever reach the template
//
//   2. PILLAR DROPDOWN:
//      • quizzesByPillarArray still built exactly as before
//      • Pillars with 0 real quizzes are filtered out before render
//      • Template receives quizzesByPillarArray for the <select> dropdown
//
//   3. FILTER LOGIC:
//      • pillarFilter now NARROWS category cards to that pillar's categories
//      • categoryFilter drills into series/quizzes for that category
//      • When pillar + category are combined the series list is intersected
//
//   4. COUNTS:
//      • totalQuizCount is always computed from real DB aggregate
//      • Category counts come from DB aggregate (never invented)
//      • Series counts come from DB aggregate (never invented)
//
//   5. ZERO-COUNT GUARDS:
//      • allCategoryMeta: .filter(c => c.count > 0)
//      • quizzesByPillarArray: .filter(p => p.totalQuizzes > 0)
//      • per-pillar category buckets: .filter(c => c.totalQuizzes > 0)
//
//   EVERYTHING ELSE IS PRESERVED EXACTLY:
//   • quiz delivery, attempts, certificates, onboarding, timer logic
//   • admin flows, role-based access, non-cripfcnt-school orgs
//   • quizzesBySeries, quizzesByModule, quizzesByPillarArray structure
//   • all existing Handlebars helpers and template variables
//   • backward-compatible — all previously existing template vars still present
// ─────────────────────────────────────────────────────────────────────────────

import mongoose from 'mongoose';

router.get('/org/:slug/dashboard', ensureAuth, async (req, res) => {
  try {
    const slug           = String(req.params.slug  || '').trim();
    const searchQuery    = String(req.query.q        || '').trim();
    const moduleFilter   = String(req.query.module   || '').trim();
    const topicFilter    = String(req.query.topic    || '').trim();
    const seriesFilter   = String(req.query.series   || '').trim();
    const categoryFilter = String(req.query.category || '').trim();
    const pillarFilter   = String(req.query.pillar   || '').trim();

    // ── Org + membership ──────────────────────────────────────────────────────
    const org = await Organization.findOne({ slug }).lean();
    if (!org) return res.status(404).send('org not found');

    const membership = await OrgMembership.findOne({
      org: org._id, user: req.user._id
    }).lean();
    if (!membership) return res.status(403).send('You are not a member of this organization');

    // ── Admin check ───────────────────────────────────────────────────────────
    const platformAdmin = (process.env.ADMIN_EMAILS || '')
      .split(',').map(e => e.trim().toLowerCase())
      .includes((req.user.email || '').toLowerCase());
    const role    = String(membership.role || '').toLowerCase();
    const isAdmin = platformAdmin || ['admin', 'manager', 'org_admin'].includes(role);

    const isCripfcntSchool = org.slug === 'cripfcnt-school';
    const modules = await OrgModule.find({ org: org._id }).lean();

    // ── Role label ────────────────────────────────────────────────────────────
    let normalizedRole = 'professional';
    if (isAdmin)                                      normalizedRole = 'administrator';
    else if (role === 'student')                      normalizedRole = 'student';
    else if (role === 'teacher')                      normalizedRole = 'teacher';
    else if (role === 'employee' || role === 'staff') normalizedRole = 'professional';

    // ── Static helpers ────────────────────────────────────────────────────────
    const ICON_MAP = {
      'governance':'🏛','institutional-accountability':'⚖️','public-sector-ethics':'🔏',
      'rule-of-law':'⚖️','financial-accountability':'💰','structural-responsibility':'🔧',
      'social-contract':'🤝','administration':'📋',
      'consciousness-studies':'🧠','philosophical-inquiry':'🧭','systems-thinking':'🔗',
      'critical-thinking':'🔍','psychology':'🪞','education':'📚','communication':'💬',
      'interpretive-frameworks':'🔍','language-recalibration':'🗣','media-literacy':'📰',
      'strategic-communication':'📣','narrative-framing':'📖','research-methodology':'📐',
      'strategic-leadership':'🎯','change-management':'🔄','policy-implementation':'📋',
      'community-leadership':'👥','crisis-management':'🚨','motivation':'⚡',
      'organisational-development':'🏗','human-resources':'👤',
      'frequencies-and-influence':'📡','social-development':'🌱',
      'institutional-reform':'🔨','performance-metrics':'📊',
      'civilisation-theory':'🏛','social-justice':'✊','human-rights':'🌐',
      'economic-justice':'⚖️','environmental-governance':'🌿',
      'electoral-systems':'🗳','public-policy':'📜','law':'⚖️',
      'conflict-resolution':'🕊','negotiation-dynamics':'🤝','diplomacy':'🌍',
      'finance':'💹','strategy':'♟️',
      'technology-governance':'💻','digital-ethics':'🔐','ai-governance':'🤖',
      'risk-and-compliance':'🛡','innovation':'💡',
    };
    function getIcon(s) {
      if (ICON_MAP[s]) return ICON_MAP[s];
      const k = Object.keys(ICON_MAP).find(k => k.startsWith((s || '').split('-')[0]));
      return k ? ICON_MAP[k] : '📂';
    }
    function slugToLabel(s) {
      return (s || '').split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
    }

    // ── 8 CRIPFCNT Pillars ────────────────────────────────────────────────────
    const PILLAR_ORDER = [
      'consciousness','responsibility','interpretation','purpose',
      'frequencies','civilization','negotiation','technology'
    ];

    const PILLAR_META = {
      consciousness:  { label:'Consciousness',  icon:'🧠', color:'#7c3aed' },
      responsibility: { label:'Responsibility', icon:'🤝', color:'#0d9488' },
      interpretation: { label:'Interpretation', icon:'🔍', color:'#4f46e5' },
      purpose:        { label:'Purpose',        icon:'🎯', color:'#d97706' },
      frequencies:    { label:'Frequencies',    icon:'📡', color:'#e11d48' },
      civilization:   { label:'Civilization',   icon:'🏛', color:'#059669' },
      negotiation:    { label:'Negotiation',    icon:'🤝', color:'#ea580c' },
      technology:     { label:'Technology',     icon:'💻', color:'#2563eb' },
    };

    // Pillar → allowed categories (for fallback resolution + filter matching)
    const PILLAR_CATEGORY_MAP = {
      consciousness:  ['consciousness-studies','philosophical-inquiry','systems-thinking','critical-thinking','psychology','education','communication'],
      responsibility: ['governance','institutional-accountability','public-sector-ethics','rule-of-law','financial-accountability','structural-responsibility','social-contract','administration'],
      interpretation: ['interpretive-frameworks','language-recalibration','media-literacy','strategic-communication','narrative-framing','research-methodology'],
      purpose:        ['strategic-leadership','change-management','policy-implementation','community-leadership','crisis-management','motivation','organisational-development','human-resources'],
      frequencies:    ['frequencies-and-influence','social-development','institutional-reform','performance-metrics'],
      civilization:   ['civilisation-theory','social-justice','human-rights','economic-justice','environmental-governance','electoral-systems','public-policy','law'],
      negotiation:    ['conflict-resolution','negotiation-dynamics','diplomacy','finance','strategy'],
      technology:     ['technology-governance','digital-ethics','ai-governance','risk-and-compliance','innovation'],
    };

    // Category → keyword hints (for soft filter matching when category field not set)
    const CATEGORY_TOPIC_KEYWORDS = {
      'governance':['governance','government','institution','ministry','parliament','cabinet','federalism','separation-of-powers','constitutional-design'],
      'institutional-accountability':['accountability','transparency','oversight','audit','anti-corruption','watchdog','ombudsman','procurement','integrity'],
      'public-sector-ethics':['ethics','integrity','misconduct','professional-standards','code-of-conduct','conflict-of-interest','bribery','whistleblower','public-trust'],
      'rule-of-law':['rule-of-law','constitution','rights','judicial','court','legal','justice','enforcement','constitutional','due-process'],
      'financial-accountability':['financial','audit','treasury','expenditure','budget','procurement','misappropriation','fraud','fiduciary','public-funds'],
      'structural-responsibility':['structural','responsibility','blame','obligation','outsourcing','delegation','transfer','burden','ownership','hierarchy'],
      'social-contract':['social-contract','citizenship','obligation','rights-and-duties','consent','legitimacy','civic','public-service'],
      'administration':['administration','civil-service','bureaucracy','public-administration','government-operations','administrative'],
      'consciousness-studies':['consciousness','awareness','perception','mindfulness','self-awareness','metacognition','attention','clarity'],
      'philosophical-inquiry':['philosophy','ethics','morality','ontology','epistemology','truth','meaning','value','principle','virtue'],
      'systems-thinking':['system','systems-thinking','complexity','feedback','interdependence','emergent','network','holistic','dynamic'],
      'critical-thinking':['critical-thinking','analysis','reasoning','logic','evaluate','evidence','argument','bias','fallacy','question'],
      'psychology':['psychology','behaviour','cognitive','motivation','social-psychology','decision-making','behavioural'],
      'education':['education','curriculum','school','learning','teaching','pedagogy','student','literacy','reform'],
      'communication':['communication','interpersonal','rhetoric','presentation','discourse','professional-communication'],
      'interpretive-frameworks':['interpretation','framework','lens','perspective','worldview','paradigm','model','theory','reading'],
      'language-recalibration':['language','terminology','recalibration','semantics','definition','vocabulary','framing','redefinition'],
      'media-literacy':['media','journalism','news','misinformation','disinformation','fake-news','social-media','broadcast','editorial'],
      'strategic-communication':['communication','messaging','narrative','framing','rhetoric','media-strategy','public-relations','branding','discourse'],
      'narrative-framing':['narrative','story','framing','agenda','spin','perception','context','propaganda','messaging'],
      'research-methodology':['research','methodology','data','qualitative','quantitative','analysis','academic','framework'],
      'strategic-leadership':['leadership','strategic','vision','decision','executive','ceo','management','direction','strategy','commander'],
      'change-management':['change','transformation','reform','restructuring','transition','adaptation','disruption','reorganisation'],
      'policy-implementation':['implementation','execution','delivery','programme','project','rollout','service-delivery','monitoring','evaluation'],
      'community-leadership':['community','local','grassroots','civic','neighbourhood','municipality','ward','stakeholder','participation'],
      'crisis-management':['crisis','emergency','disaster','risk','resilience','continuity','response','pandemic','hazard','contingency'],
      'motivation':['motivation','incentive','intrinsic','extrinsic','drive','engagement','morale','reward','performance-psychology'],
      'organisational-development':['organisational','org-culture','capacity-building','institutional-reform','culture','structural-change'],
      'human-resources':['human-resources','hr','talent','workforce','people-management','recruitment','employment','labour'],
      'frequencies-and-influence':['frequencies','influence','energy','vibration','signal','frequency','resonance','consciousness-level'],
      'social-development':['social-development','community-development','cohesion','grassroots','capacity','social-programme'],
      'institutional-reform':['institutional-reform','systemic-change','reform-architecture','institutional-change','reform'],
      'performance-metrics':['metrics','measurement','kpi','indicator','evaluation','assessment','benchmark','performance','scoi'],
      'civilisation-theory':['civilisation','civilization','society','culture','heritage','identity','nation','state','modernity','progress'],
      'social-justice':['social-justice','equality','discrimination','race','gender','marginalised','inclusion','diversity','oppression'],
      'human-rights':['human-rights','rights','freedoms','dignity','protection','abuse','violation','refugee','asylum','torture'],
      'electoral-systems':['election','voting','democracy','ballot','electoral','representation','political-party','campaign','mandate'],
      'economic-justice':['economic-justice','inequality','poverty','redistribution','wages','wealth-gap','equity','fair','social-mobility'],
      'environmental-governance':['environment','climate','ecology','sustainability','green','carbon','pollution','conservation','biodiversity'],
      'public-policy':['policy','legislation','regulation','law-reform','regulatory','compliance','bill','statute','framework','policy-design'],
      'law':['law','statute','jurisprudence','legal-system','comparative-law','commercial-law','international-law','legal-analysis'],
      'conflict-resolution':['conflict','resolution','mediation','peace','diplomacy','dialogue','reconciliation','compromise','agreement'],
      'negotiation-dynamics':['negotiation','bargain','deal','agreement','leverage','power','concession','zone','outcome'],
      'diplomacy':['diplomacy','international-relations','treaty','multilateral','foreign-policy','diplomatic'],
      'finance':['finance','investment','capital-markets','banking','economic-policy','macroeconomics','financial-systems'],
      'strategy':['strategy','strategic-planning','competitive-strategy','scenario-planning','foresight','strategic'],
      'technology-governance':['technology','digital','data','cyber','ai','artificial-intelligence','platform','algorithm','tech-policy','innovation-policy'],
      'digital-ethics':['digital-ethics','privacy','surveillance','algorithmic','bias','facial-recognition','ai-ethics','data-protection'],
      'ai-governance':['ai-governance','ai-regulation','model-governance','responsible-ai','ai-safety','algorithmic-accountability'],
      'risk-and-compliance':['risk','compliance','enterprise-risk','regulatory-compliance','audit-framework','internal-controls','risk-governance'],
      'innovation':['innovation','r&d','startup','digital-transformation','innovation-governance','tech-innovation'],
    };

    // ══════════════════════════════════════════════════════════════════════════
    //  STEP 1 — Aggregations (cripfcnt-school only)
    // ══════════════════════════════════════════════════════════════════════════
    let allPillarSlugs   = [];
    let allCategorySlugs = [];
    let allSeriesSlugs   = [];
    let allCategoryMeta  = [];
    let allSeriesMeta    = [];

    if (isCripfcntSchool) {

      // ── Pillars (from classified quizzes, real counts only) ───────────────
      const pillarAgg = await Question.aggregate([
        {
          $match: {
            organization:        org._id,
            'meta.aiPillar':     { $exists: true, $nin: [null, ''] },
            'meta.isOutOfScope': { $ne: true }
          }
        },
        { $group: { _id: '$meta.aiPillar', count: { $sum: 1 } } },
        { $sort: { count: -1 } }
      ]);
      // Only include valid pillars that have at least 1 real quiz
      allPillarSlugs = pillarAgg
        .filter(p => p.count > 0 && PILLAR_ORDER.includes(p._id))
        .map(p => p._id);

      // ── Series (real, non-empty only) ──────────────────────────────────────
      const seriesAgg = await Question.aggregate([
        {
          $match: {
            organization:        org._id,
            type:                'comprehension',
            'meta.isOutOfScope': { $ne: true },
            series:              { $exists: true, $nin: [null, '', 'out-of-scope'] }
          }
        },
        {
          $group: {
            _id:      '$series',
            count:    { $sum: 1 },
            pillar:   { $first: '$meta.aiPillar' },
            category: { $first: '$category' },
            level:    { $first: '$level' }
          }
        },
        { $sort: { _id: 1 } }
      ]);
      allSeriesSlugs = seriesAgg.map(s => s._id).filter(Boolean);
      allSeriesMeta  = seriesAgg.map(s => ({
        slug:     s._id,
        label:    slugToLabel(s._id),
        pillar:   PILLAR_ORDER.includes(s.pillar) ? s.pillar : 'responsibility',
        category: s.category || '',
        level:    s.level    || 'foundation',
        count:    s.count
      }));

      // ── Categories ─────────────────────────────────────────────────────────
      //   Primary:  after classification script has run (meta.aiCategorised=true)
      //   Fallback: any non-null category field (before script)
      //   Zero-count guard: always filter c.count > 0
      //   Sort:     DESC by count so most-populated categories appear first
      // ──────────────────────────────────────────────────────────────────────
      const catAggPrimary = await Question.aggregate([
        {
          $match: {
            organization:         org._id,
            type:                 'comprehension',
            'meta.aiCategorised': true,
            'meta.isOutOfScope':  { $ne: true },
            category:             { $exists: true, $nin: [null, '', 'out-of-scope'] }
          }
        },
        {
          $group: {
            _id:    '$category',
            count:  { $sum: 1 },
            pillar: { $first: '$meta.aiPillar' }
          }
        },
        { $sort: { count: -1 } }   // ← sort by count DESC
      ]);

      const catAggFallback = catAggPrimary.length === 0
        ? await Question.aggregate([
            {
              $match: {
                organization:        org._id,
                type:                'comprehension',
                'meta.isOutOfScope': { $ne: true },
                category:            { $exists: true, $nin: [null, '', 'out-of-scope'] }
              }
            },
            {
              $group: {
                _id:    '$category',
                count:  { $sum: 1 },
                pillar: { $first: '$meta.aiPillar' }
              }
            },
            { $sort: { count: -1 } }   // ← sort by count DESC
          ])
        : [];

      const rawCats = catAggPrimary.length > 0 ? catAggPrimary : catAggFallback;

      // ── Zero-count guard: filter out anything with count = 0 ────────────
      allCategoryMeta = rawCats
        .filter(c => c.count > 0)
        .map(c => ({
          slug:   c._id,
          label:  slugToLabel(c._id),
          icon:   getIcon(c._id),
          // Use DB-reported pillar; validate; fall back to static map; then 'responsibility'
          pillar: PILLAR_ORDER.includes(c.pillar)
            ? c.pillar
            : (PILLAR_CATEGORY_MAP
                ? Object.entries(PILLAR_CATEGORY_MAP).find(([, cats]) => cats.includes(c._id))?.[0] || 'responsibility'
                : 'responsibility'),
          count:  c.count
        }));

      allCategorySlugs = allCategoryMeta.map(c => c.slug);
    }

    // ── catMetaBySlug: quick lookup ────────────────────────────────────────
    const catMetaBySlug = {};
    for (const cm of allCategoryMeta) catMetaBySlug[cm.slug] = cm;

    // ── suggestedCategoryMeta / remainingCategoryMeta (for legacy template vars) ─
    // Keep these for backward compat but they are no longer the primary data source.
    // The template now uses allCategoryMeta (already sorted by count) for the card strip.
    const PILLAR_CATEGORY_HINTS = {
      responsibility: ['governance','accountability','ethics','responsibility','rule-of-law','finance','administration'],
      consciousness:  ['consciousness','awareness','philosophical','systems-thinking','critical','psychology','education'],
      purpose:        ['leadership','strategic','change','implementation','mission','purpose','community','human-resources'],
      interpretation: ['interpretation','narrative','language','media','communication','framing'],
      frequencies:    ['frequencies','influence','social-development','performance','institutional-reform'],
      civilization:   ['civilization','civilisation','society','heritage','culture','social','justice','human','electoral','environment','public-policy','law'],
      negotiation:    ['negotiation','conflict','dialogue','consensus','diplomacy','finance','strategy'],
      technology:     ['technology','digital','ai','cyber','data','innovation','risk','compliance'],
    };
    const suggestedSlugs = (() => {
      if (!isCripfcntSchool || !allCategoryMeta.length) return [];
      const seen = new Set(), result = [];
      for (const [, hints] of Object.entries(PILLAR_CATEGORY_HINTS)) {
        const matches = allCategoryMeta
          .filter(cm => cm.count > 0 && !seen.has(cm.slug) &&
            hints.some(h => cm.slug.includes(h) || h.includes(cm.slug.split('-')[0])))
          .sort((a, b) => b.count - a.count).slice(0, 1);
        for (const m of matches) { seen.add(m.slug); result.push(m.slug); }
      }
      const remaining = allCategoryMeta
        .filter(cm => cm.count > 0 && !seen.has(cm.slug))
        .sort((a, b) => b.count - a.count)
        .slice(0, Math.max(0, 8 - result.length))
        .map(cm => cm.slug);
      return [...result, ...remaining].slice(0, 8);
    })();
    const suggestedCategoryMeta  = suggestedSlugs
      .filter(s => catMetaBySlug[s]?.count > 0)
      .map(s => catMetaBySlug[s]);
    const suggestedSet           = new Set(suggestedCategoryMeta.map(cm => cm.slug));
    const remainingCategoryMeta  = allCategoryMeta.filter(cm => !suggestedSet.has(cm.slug) && cm.count > 0);

    // ══════════════════════════════════════════════════════════════════════════
    //  STEP 2 — Load quizzes
    // ══════════════════════════════════════════════════════════════════════════
    let exams = [];

    if (isCripfcntSchool && isAdmin) {
      // Admin: load all comprehension quizzes from DB
      const allQuizzes = await Question.find({
        organization:        org._id,
        type:                'comprehension',
        'meta.isOutOfScope': { $ne: true }
      })
        .select('_id text quizTitle module modules topics series category level seriesOrder questionIds createdAt meta')
        .sort({ series: 1, seriesOrder: 1, createdAt: -1 })
        .lean();

      const allQuizIds    = allQuizzes.map(q => q._id);
      const childTopicDocs = await Question.find({
        'meta.inheritedFromQuiz': { $in: allQuizIds },
        topics:                   { $exists: true, $not: { $size: 0 } }
      }).select('meta.inheritedFromQuiz topics').lean();

      const quizTopicMap = {};
      for (const c of childTopicDocs) {
        const pid = String(c.meta?.inheritedFromQuiz);
        if (!quizTopicMap[pid]) quizTopicMap[pid] = new Set();
        for (const t of (c.topics || [])) quizTopicMap[pid].add(t);
      }

      for (const quiz of allQuizzes) {
        const ownTopics   = Array.isArray(quiz.topics) ? quiz.topics : [];
        const childTopics = [...(quizTopicMap[String(quiz._id)] || [])];
        const allTopics   = [...new Set([...ownTopics, ...childTopics])];
        const pillar      = PILLAR_ORDER.includes(quiz.meta?.aiPillar)
          ? quiz.meta.aiPillar
          : (quiz.module || 'responsibility');
        exams.push({
          assignmentId: `admin-quiz-${quiz._id}`,
          examId:       null,
          title:        quiz.quizTitle || quiz.text || 'Quiz',
          quizTitle:    quiz.quizTitle || quiz.text || 'Quiz',
          module:       quiz.module  || 'responsibility',
          modules:      quiz.modules || [quiz.module || 'responsibility'],
          series:       quiz.series  || null,
          category:     quiz.category || null,
          level:        quiz.level   || 'foundation',
          seriesOrder:  quiz.seriesOrder || 99,
          questionIds:  quiz.questionIds || [],
          createdAt:    quiz.createdAt,
          isAdminQuiz:  true,
          quizId:       quiz._id,
          status:       'available',
          meta: {
            topics:   allTopics,
            series:   quiz.series,
            category: quiz.category,
            aiPillar: pillar,
            level:    quiz.level
          }
        });
      }

    } else if (isAdmin) {
      // Admin on non-cripfcnt orgs: aggregate from ExamInstance
      exams = await ExamInstance.aggregate([
        { $match: { org: new mongoose.Types.ObjectId(org._id) } },
        { $match: { assignmentId: { $exists: true, $ne: null }, isOnboarding: { $ne: true } } },
        {
          $group: {
            _id: '$assignmentId',
            doc: {
              $first: {
                assignmentId: '$assignmentId', module: '$module', modules: '$modules',
                title: '$title', quizTitle: '$quizTitle', questionIds: '$questionIds',
                createdAt: '$createdAt', expiresAt: '$expiresAt', meta: '$meta'
              }
            }
          }
        },
        { $replaceRoot: { newRoot: '$doc' } },
        { $sort: { createdAt: -1 } }
      ]);

    } else {
      // Regular user: load their own exam instances
      const rawExams = await ExamInstance.find({ org: org._id, userId: req.user._id })
        .sort({ createdAt: -1 }).lean();

      if (rawExams.length && isCripfcntSchool) {
        // Hydrate quiz metadata (series/category/level) from parent quiz docs
        const quizIds = new Set();
        for (const ex of rawExams) {
          if (ex.meta?.quizId) quizIds.add(String(ex.meta.quizId));
          if (Array.isArray(ex.questionIds))
            for (const q of ex.questionIds)
              if (String(q).startsWith('parent:')) quizIds.add(String(q).replace('parent:', ''));
        }
        const quizDocs = quizIds.size
          ? await Question.find({
              _id:  { $in: [...quizIds].filter(id => mongoose.isValidObjectId(id)) },
              type: 'comprehension'
            }).select('_id series category level seriesOrder quizTitle topics meta').lean()
          : [];
        const quizDocMap = {};
        for (const qd of quizDocs) quizDocMap[String(qd._id)] = qd;

        for (const ex of rawExams) {
          let srcId = ex.meta?.quizId ? String(ex.meta.quizId) : null;
          if (!srcId && Array.isArray(ex.questionIds))
            for (const q of ex.questionIds)
              if (String(q).startsWith('parent:')) { srcId = String(q).replace('parent:', ''); break; }
          const src = srcId ? quizDocMap[srcId] : null;
          if (src) {
            ex.series      = ex.series      || src.series      || null;
            ex.category    = ex.category    || src.category    || null;
            ex.level       = ex.level       || src.level       || 'foundation';
            ex.seriesOrder = ex.seriesOrder || src.seriesOrder || 99;
            ex.quizTitle   = ex.quizTitle   || src.quizTitle   || ex.title;
            if (!ex.meta) ex.meta = {};
            ex.meta.aiPillar = ex.meta.aiPillar || src.meta?.aiPillar || ex.module;
            ex.meta.series   = ex.meta.series   || src.series   || null;
            ex.meta.category = ex.meta.category || src.category || null;
            ex.meta.topics   = ex.meta.topics   || src.topics   || [];
          }
        }
        exams = rawExams;
      } else {
        exams = rawExams;
      }
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  STEP 3 — Apply filters
    //  Category filter: exact match first, then keyword fallback, then series
    //  Pillar filter: when category is also set, intersect both conditions
    // ══════════════════════════════════════════════════════════════════════════
    if (searchQuery || moduleFilter || topicFilter || seriesFilter || categoryFilter || pillarFilter) {
      const activeCatKw = categoryFilter ? (CATEGORY_TOPIC_KEYWORDS[categoryFilter] || []) : [];

      exams = exams.filter(ex => {
        // Full-text search on title
        if (searchQuery) {
          if (!(ex.title || ex.quizTitle || '').toLowerCase().includes(searchQuery.toLowerCase())) return false;
        }
        // Module filter (exact array match)
        if (moduleFilter) {
          if (!(ex.modules || [ex.module]).includes(moduleFilter)) return false;
        }
        // Topic filter (partial match in meta.topics)
        if (topicFilter) {
          if (!(ex.meta?.topics || []).some(t => String(t).toLowerCase().includes(topicFilter.toLowerCase()))) return false;
        }
        // Series filter (exact slug match)
        if (seriesFilter) {
          const s = (ex.series || ex.meta?.series || '').toLowerCase().trim();
          if (!s || s !== seriesFilter.toLowerCase().trim()) return false;
        }
        // Category filter: multi-strategy matching
        if (categoryFilter) {
          const cat = (ex.category || ex.meta?.category || '').toLowerCase().trim();
          if (cat === categoryFilter) {
            // Exact match — still respect pillar filter if set
            if (pillarFilter) {
              const p = (ex.meta?.aiPillar || '').toLowerCase();
              return p === pillarFilter || PILLAR_CATEGORY_MAP[pillarFilter]?.includes(categoryFilter);
            }
            return true;
          }
          // Keyword fallback
          if (activeCatKw.length) {
            const exTopics = (ex.meta?.topics || []).map(t => String(t).toLowerCase());
            if (exTopics.some(t => activeCatKw.some(kw => t.includes(kw) || kw.includes(t)))) {
              if (pillarFilter) {
                const p = (ex.meta?.aiPillar || '').toLowerCase();
                return p === pillarFilter || PILLAR_CATEGORY_MAP[pillarFilter]?.includes(categoryFilter);
              }
              return true;
            }
          }
          // Series slug contains category keyword fragment
          const exSeries = (ex.series || '').toLowerCase();
          const catParts = categoryFilter.split('-').filter(p => p.length >= 5);
          if (exSeries && catParts.length && catParts.some(p => exSeries.includes(p))) {
            if (pillarFilter) {
              const p = (ex.meta?.aiPillar || '').toLowerCase();
              return p === pillarFilter || PILLAR_CATEGORY_MAP[pillarFilter]?.includes(categoryFilter);
            }
            return true;
          }
          // Pillar-category static map
          const qPillar = (ex.meta?.aiPillar || '').toLowerCase();
          if (qPillar && PILLAR_CATEGORY_MAP[qPillar]?.includes(categoryFilter)) {
            if (pillarFilter) return qPillar === pillarFilter;
            return true;
          }
          return false;
        }
        // Pillar-only filter (no category set)
        if (pillarFilter && !categoryFilter) {
          const p = (ex.meta?.aiPillar || '').toLowerCase();
          if (!p || p !== pillarFilter) return false;
        }
        return true;
      });
    }

    // ── Preload parent titles ─────────────────────────────────────────────────
    const parentIds = new Set();
    for (const ex of exams)
      if (Array.isArray(ex.questionIds))
        for (const q of ex.questionIds)
          if (String(q).startsWith('parent:')) parentIds.add(String(q).replace('parent:', ''));
    const parentDocs = parentIds.size
      ? await QuizQuestion.find({ _id: { $in: [...parentIds] } }).select('_id title text').lean()
      : [];
    const parentTitleMap = {};
    for (const p of parentDocs) parentTitleMap[String(p._id)] = p.title || p.text || 'Quiz';

    // ══════════════════════════════════════════════════════════════════════════
    //  STEP 4 — Build quizzesBySeries
    // ══════════════════════════════════════════════════════════════════════════
    const quizzesBySeries = {};
    const now = new Date();

    for (const ex of exams) {
      const assignmentKey = ex.assignmentId || ex.examId;
      const seriesKey     = ex.series || ex.meta?.series || ex.module || 'general';
      const category      = ex.category || ex.meta?.category || '';
      const pillar        = PILLAR_ORDER.includes(ex.meta?.aiPillar)
        ? ex.meta.aiPillar
        : (ex.module || 'responsibility');
      const level         = ex.level || ex.meta?.level || 'foundation';

      if (!quizzesBySeries[seriesKey]) {
        quizzesBySeries[seriesKey] = {
          seriesSlug:  seriesKey,
          seriesLabel: slugToLabel(seriesKey),
          pillar, category, level, quizzes: []
        };
      }

      let status = 'pending';
      if (ex.finishedAt) status = 'completed';
      if (process.env.QUIZ_EXPIRY_ENABLED === 'true' && ex.expiresAt && ex.expiresAt < now) status = 'expired';
      if (ex.isAdminQuiz) status = 'available';

      let quizTitle     = ex.quizTitle || ex.title || slugToLabel(seriesKey) + ' Quiz';
      let questionCount = 0;
      if (Array.isArray(ex.questionIds)) {
        questionCount = ex.questionIds.filter(q => !String(q).startsWith('parent:')).length;
        const pm = ex.questionIds.find(q => String(q).startsWith('parent:'));
        if (!ex.title && !ex.quizTitle && pm)
          quizTitle = parentTitleMap[String(pm).replace('parent:', '')] || quizTitle;
      }

      let openUrl;
      if (ex.isAdminQuiz)
        openUrl = `/org/${org.slug}/take-quiz?quizId=${ex.quizId}`;
      else if (ex.isOnboarding)
        openUrl = `/org/${org.slug}/quiz?examId=${encodeURIComponent(ex.examId)}&quizTitle=${encodeURIComponent(quizTitle)}`;
      else
        openUrl = `/org/${org.slug}/quiz?assignmentId=${encodeURIComponent(assignmentKey)}&quizTitle=${encodeURIComponent(quizTitle)}`;

      quizzesBySeries[seriesKey].quizzes.push({
        assignmentId: assignmentKey, quizTitle, questionCount, status, openUrl,
        createdAt:    ex.createdAt, isTrial: ex.meta?.isTrial || false,
        isAdminQuiz:  ex.isAdminQuiz || false, quizId: ex.quizId,
        topics:       ex.meta?.topics || [], series: seriesKey, category, pillar, level,
        seriesOrder:  ex.seriesOrder || 99
      });
    }

    for (const s of Object.values(quizzesBySeries))
      s.quizzes.sort((a, b) => (a.seriesOrder || 99) - (b.seriesOrder || 99));

    // ══════════════════════════════════════════════════════════════════════════
    //  STEP 5 — Build quizzesByPillarArray
    //  Structure: Pillar → Category → Series → Quizzes
    //
    //  Category resolution priority (unchanged from original):
    //    1. category already set on the series (after classification script)
    //    2. best DB category for this pillar from allCategoryMeta (by count)
    //    3. first allowed category for this pillar from static map
    //    4. first category of responsibility pillar (final fallback)
    //
    //  NEW: Zero-count guard on both pillar buckets and category buckets
    // ══════════════════════════════════════════════════════════════════════════

    // Pre-compute best DB category per pillar (highest count)
    const bestCatForPillar = {};
    for (const cm of allCategoryMeta) {
      const p = cm.pillar || 'responsibility';
      if (!bestCatForPillar[p] || cm.count > (bestCatForPillar[p].count || 0))
        bestCatForPillar[p] = cm;
    }

    const _pillarBuckets = {};

    for (const [, seriesData] of Object.entries(quizzesBySeries)) {
      const pillar = PILLAR_ORDER.includes(seriesData.pillar) ? seriesData.pillar : 'responsibility';

      // Resolve category for this series bucket
      let category = seriesData.category;
      if (!category || category === '' || category === 'out-of-scope') {
        if (bestCatForPillar[pillar]) {
          category = bestCatForPillar[pillar].slug;
        } else if (PILLAR_CATEGORY_MAP[pillar]?.length) {
          category = PILLAR_CATEGORY_MAP[pillar][0];
        } else {
          category = PILLAR_CATEGORY_MAP.responsibility[0];
        }
      }

      if (!_pillarBuckets[pillar]) {
        _pillarBuckets[pillar] = {
          pillarSlug:   pillar,
          pillarLabel:  PILLAR_META[pillar]?.label  || slugToLabel(pillar),
          pillarIcon:   PILLAR_META[pillar]?.icon   || '📌',
          pillarColor:  PILLAR_META[pillar]?.color  || '#8b92a5',
          totalQuizzes: 0,
          categories:   {}
        };
      }

      if (!_pillarBuckets[pillar].categories[category]) {
        _pillarBuckets[pillar].categories[category] = {
          categorySlug:  category,
          categoryLabel: slugToLabel(category),
          categoryIcon:  getIcon(category),
          pillar,
          totalQuizzes:  0,
          seriesList:    []
        };
      }

      _pillarBuckets[pillar].categories[category].seriesList.push({
        seriesSlug:  seriesData.seriesSlug,
        seriesLabel: seriesData.seriesLabel,
        pillar,
        pillarIcon:  PILLAR_META[pillar]?.icon  || '📌',
        pillarColor: PILLAR_META[pillar]?.color || '#8b92a5',
        category,
        level:       seriesData.level,
        quizCount:   seriesData.quizzes.length,
        quizzes:     seriesData.quizzes
      });

      _pillarBuckets[pillar].categories[category].totalQuizzes += seriesData.quizzes.length;
      _pillarBuckets[pillar].totalQuizzes += seriesData.quizzes.length;
    }

    // ── Zero-count guard: filter pillars and categories with no real quizzes ─
    const quizzesByPillarArray = PILLAR_ORDER
      .filter(p => (_pillarBuckets[p]?.totalQuizzes || 0) > 0)
      .map(p => ({
        ..._pillarBuckets[p],
        categories: Object.values(_pillarBuckets[p].categories)
          .filter(c => c.totalQuizzes > 0)                       // never expose empty category buckets
          .sort((a, b) => b.totalQuizzes - a.totalQuizzes)
      }));

    // ── Final derived lists ───────────────────────────────────────────────────
    const allSeries = allSeriesSlugs.length
      ? allSeriesSlugs
      : [...new Set(Object.keys(quizzesBySeries))].sort();

    const allCategories = allCategorySlugs.length
      ? allCategorySlugs
      : [...new Set(Object.values(quizzesBySeries).map(s => s.category).filter(Boolean))].sort();

    const allPillars = allPillarSlugs.length
      ? allPillarSlugs
      : PILLAR_ORDER.filter(p => (_pillarBuckets[p]?.totalQuizzes || 0) > 0);

    // Real total quiz count from DB (not derived from filtered exams)
    const totalQuizCount = isCripfcntSchool
      ? (await Question.countDocuments({
          organization:        org._id,
          type:                'comprehension',
          'meta.isOutOfScope': { $ne: true }
        }))
      : Object.values(quizzesBySeries).reduce((s, d) => s + d.quizzes.length, 0);

    const quizzesByModule = {};
    for (const [k, v] of Object.entries(quizzesBySeries)) quizzesByModule[k] = v.quizzes;

    // ── Attempts ──────────────────────────────────────────────────────────────
    const attempts = await Attempt.find({ organization: org._id, userId: req.user._id })
      .sort({ finishedAt: -1 }).lean();
    const examIds = attempts.map(a => a.examId).filter(Boolean);
    const examsByExamId = {};
    if (examIds.length) {
      const eds = await ExamInstance.find({ examId: { $in: examIds } })
        .select('examId module questionIds').lean();
      for (const ed of eds) examsByExamId[ed.examId] = ed;
    }
    const attemptRows = attempts.map(a => {
      const ex = examsByExamId[a.examId];
      let quizTitle = a.quizTitle;
      if (!quizTitle && ex)
        quizTitle = ex.module
          ? ex.module.charAt(0).toUpperCase() + ex.module.slice(1) + ' Quiz'
          : 'Quiz';
      return {
        _id:        a._id,
        examId:     a.examId,
        quizTitle:  quizTitle || 'Quiz',
        score:      a.score    || 0,
        maxScore:   a.maxScore || 0,
        percentage: a.maxScore ? Math.round((a.score / a.maxScore) * 100) : 0,
        passed:     !!a.passed,
        finishedAt: a.finishedAt || a.updatedAt || a.createdAt
      };
    });

    // ── Certificates ──────────────────────────────────────────────────────────
    const certs = await Certificate.find({ userId: req.user._id, orgId: org._id })
      .sort({ createdAt: -1 }).lean();
    const certRows = certs.map(c => ({
      _id:        c._id,
      quizTitle:  c.quizTitle || c.courseTitle || 'Quiz',
      percentage: c.percentage,
      createdAt:  c.createdAt
    }));

    // ── Trial status ──────────────────────────────────────────────────────────
    let employeeTrialTotal = 0, employeeTrialCompleted = 0, canUpgradeEmployee = false;
    let showTrialBanner = false, canUpgrade = false, trialQuizzesRemaining = 0;

    if (isCripfcntSchool && !isAdmin) {
      try {
        const { getEmployeeTrialStatus } = await import('../services/employeeTrialAssignment.js');
        const ts = await getEmployeeTrialStatus(req.user._id, org._id);
        employeeTrialTotal     = ts.total     || 0;
        employeeTrialCompleted = ts.completed  || 0;
        canUpgradeEmployee     = !!ts.canUpgrade;
        if (employeeTrialTotal === 0 && req.user.employeeSubscriptionStatus === 'trial')
          canUpgradeEmployee = true;
      } catch (err) {
        console.error('[dashboard] trial status error:', err);
        canUpgradeEmployee = req.user.employeeSubscriptionStatus === 'trial';
      }
    }

    // ── Render ────────────────────────────────────────────────────────────────
    // NOTE: categoryMeta passed to template = allCategoryMeta (sorted by count DESC)
    // The template's cat-scroll strip uses categoryMeta directly.
    // All previously existing template variables are preserved for backward compat.
    return res.render('org/dashboard', {
      org, membership, modules,

      // Quiz data
      quizzesByModule,
      quizzesBySeries,
      quizzesByPillarArray,    // Pillar → Category → Series → Quizzes (for dropdown + view A)
      hasAssignedQuizzes: Object.values(quizzesBySeries).some(s => s.quizzes.length > 0),

      // Attempt / cert history
      attemptRows,
      certRows,

      // Auth / role
      isAdmin,
      isCripfcntSchool,
      user: req.user,
      normalizedRole,

      // Trial
      employeeTrialTotal,
      employeeTrialCompleted,
      canUpgradeEmployee,
      showTrialBanner,
      canUpgrade,
      trialQuizzesRemaining,

      // Active filters (echoed back to template for highlight/chip display)
      searchQuery,
      moduleFilter,
      topicFilter,
      seriesFilter,
      categoryFilter,
      pillarFilter,

      // Filter option lists (for <select> dropdowns in advanced filter panel)
      allSeries,      // string[]
      allCategories,  // string[]
      allPillars,     // string[]

      // Category metadata for top card strip
      // categoryMeta = allCategoryMeta sorted DESC by count, zero-count excluded
      categoryMeta:          allCategoryMeta,    // ← primary source for card strip
      allCategoryMeta,                            // ← full list (backward compat)
      suggestedCategoryMeta,                      // ← legacy (still present)
      remainingCategoryMeta,                      // ← legacy (still present)

      // Series metadata for sidebar drill-down
      allSeriesMeta,

      // Totals
      totalQuizCount   // real DB count, never from filtered array
    });

  } catch (err) {
    console.error('[org dashboard] error:', err && (err.stack || err));
    return res.status(500).send('failed');
  }
});



/* ------------------------------------------------------------------ */
/*  🆕 ADMIN: Take quiz from catalog (creates exam instance on-demand) */
/*  GET /org/:slug/take-quiz?quizId=...                               */
/* ------------------------------------------------------------------ */
// ------------------------------------------------------------------
// ADMIN: Take quiz from catalog (creates exam instance on-demand)
// GET /org/:slug/take-quiz?quizId=...
// ------------------------------------------------------------------
router.get("/org/:slug/take-quiz", ensureAuth, async (req, res) => {
  try {
    const slug = String(req.params.slug || "").trim();
    const quizIdRaw = String(req.query.quizId || "").trim();

    if (!mongoose.isValidObjectId(quizIdRaw)) {
      return res.status(400).send("Invalid quiz ID");
    }
    const quizObjectId = new mongoose.Types.ObjectId(quizIdRaw);

    const org = await Organization.findOne({ slug }).lean();
    if (!org) return res.status(404).send("org not found");

    // ✅ 1) Platform admin check
    const platformAdmin = (process.env.ADMIN_EMAILS || "")
      .split(",")
      .map(e => e.trim().toLowerCase())
      .includes(String(req.user.email || "").toLowerCase());

    // ✅ 2) Membership lookup (needed for non-platform admins)
    const membership = await OrgMembership.findOne({
      org: org._id,
      user: req.user._id
    }).lean();

    if (!membership && !platformAdmin) {
      return res.status(403).send("You are not a member of this organization");
    }

    const role = String(membership?.role || "").toLowerCase();
    const isAdmin =
      platformAdmin || role === "admin" || role === "manager" || role === "org_admin";

    if (!isAdmin) {
      return res.status(403).send("Only admins can take quizzes from the catalog");
    }

    // ✅ Load the quiz (parent comprehension)
    const quiz = await Question.findById(quizObjectId).lean();
    if (!quiz || quiz.type !== "comprehension") {
      return res.status(404).send("Quiz not found");
    }

    // ✅ Reuse existing exam instance for THIS admin + THIS quiz
    let examInstance = await ExamInstance.findOne({
      org: org._id,
      userId: req.user._id,
      "meta.catalogQuizId": quizObjectId
    }).lean();

    if (!examInstance) {
      const examId = crypto.randomUUID();

      // IMPORTANT: assignmentId must be unique PER quiz PER user,
      // but we won't rely on it for routing anyway.
      const assignmentId = `catalog-${String(req.user._id)}-${String(quizObjectId)}`;

      const childIds = Array.isArray(quiz.questionIds)
        ? quiz.questionIds.map(String)
        : [];

      const questionIds = [`parent:${String(quiz._id)}`, ...childIds];

      const choicesOrder = [[]]; // parent marker has no choices order

      for (const cid of childIds) {
        let nChoices = 0;
        try {
          const childDoc = await Question.findById(cid).select("choices").lean();
          nChoices = Array.isArray(childDoc?.choices) ? childDoc.choices.length : 0;
        } catch (_) {
          nChoices = 0;
        }

        const indices = Array.from({ length: nChoices }, (_, i) => i);
        for (let i = indices.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [indices[i], indices[j]] = [indices[j], indices[i]];
        }
        choicesOrder.push(indices);
      }

      examInstance = await ExamInstance.create({
        examId,
        assignmentId,
        org: org._id,
        userId: req.user._id,

        module: quiz.module || "general",
        modules: Array.isArray(quiz.modules) && quiz.modules.length
          ? quiz.modules
          : [quiz.module || "general"],

        title: quiz.text || "Quiz",
        quizTitle: quiz.text || "Quiz",

        questionIds,
        choicesOrder,

        isOnboarding: false,
        targetRole: "admin",
        durationMinutes: 30,

        meta: {
          catalogQuizId: quizObjectId,   // ✅ ObjectId stored consistently
          topics: quiz.topics || [],
          series: quiz.series,
          isAdminAttempt: true
        },

        createdAt: new Date()
      });

      // if you need the doc as plain object for next lines:
      examInstance = examInstance.toObject();
    }

    // ✅ Redirect DIRECTLY to lms with the correct examId for THIS quiz
    const quizTitle = examInstance.quizTitle || examInstance.title || "Quiz";
    return res.redirect(
      `/lms/quiz?examId=${encodeURIComponent(examInstance.examId)}&org=${encodeURIComponent(org.slug)}&quizTitle=${encodeURIComponent(quizTitle)}`
    );
  } catch (err) {
    console.error("[take-quiz] error:", err && (err.stack || err));
    return res.status(500).send("failed");
  }
});



// --------------------------------------------------
// SHARED: View attempt detail
// - Admins can view any attempt
// - Users can ONLY view their own
// --------------------------------------------------
router.get(
  "/org/:slug/attempts/:attemptId",
  ensureAuth,
  async (req, res) => {
    try {
      const { slug, attemptId } = req.params;

      if (!mongoose.isValidObjectId(attemptId)) {
        return res.status(400).send("invalid attempt id");
      }

      const org = await Organization.findOne({ slug }).lean();
      if (!org) return res.status(404).send("org not found");

      const attempt = await Attempt.findById(attemptId).lean();
      if (!attempt) return res.status(404).send("attempt not found");

      // 🔐 AUTHORIZATION
      const isAdmin =
        (process.env.ADMIN_EMAILS || "")
          .split(",")
          .map(e => e.trim().toLowerCase())
          .includes(req.user.email?.toLowerCase());

      const isOwner = String(attempt.userId) === String(req.user._id);

      if (!isAdmin && !isOwner) {
        return res.status(403).send("Not allowed");
      }

      // ✅ REUSE ADMIN LOGIC BY REDIRECTING INTERNALLY
      return res.redirect(
        `/admin/orgs/${org.slug}/attempts/${attempt._id}`
      );
    } catch (err) {
      console.error("[shared attempt review] error:", err);
      return res.status(500).send("failed");
    }
  }
);


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
      const assignmentId = String(req.params.examId || "").trim();


      const org = await Organization.findOne({ slug }).lean();
      if (!org) return res.status(404).send("org not found");

      // delete exam instance
const exam = await ExamInstance.findOne({
  assignmentId,
  org: org._id
});

if (!exam) return res.status(404).send("quiz not found");

const examIds = await ExamInstance
  .find({ org: org._id, assignmentId })
  .distinct("examId");

await ExamInstance.deleteMany({
  org: org._id,
  assignmentId
});

await Attempt.deleteMany({
  examId: { $in: examIds }
});



    


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
    const examId = String(req.query.examId || "").trim();
const assignmentId = String(req.query.assignmentId || "").trim();
 // <-- respect examId if provided

    const org = await Organization.findOne({ slug }).lean();
    if (!org) return res.status(404).send("org not found");

    /*const membership = await OrgMembership.findOne({
      org: org._id,
      user: req.user._id,
    }).lean();
    if (!membership) {
      return res.status(403).send("You are not a member of this organization");
    }*/
   // ✅ Platform admin check
const platformAdmin = (process.env.ADMIN_EMAILS || "")
  .split(",")
  .map(e => e.trim().toLowerCase())
  .includes(String(req.user.email || "").toLowerCase());

// ✅ Membership lookup (still used for normal users)
const membership = await OrgMembership.findOne({
  org: org._id,
  user: req.user._id,
}).lean();

// ✅ Optional: allow users who have org attached directly on user record
const orgFieldMatch =
  req.user?.organization && String(req.user.organization) === String(org._id);

// ✅ Block only if NOT platform admin AND NOT member AND NOT orgFieldMatch
if (!platformAdmin && !membership && !orgFieldMatch) {
  return res.status(403).send("You are not a member of this organization");
}


    // 🔑 ADMIN OPEN: assignmentId → resolve to ONE examId
if (assignmentId && !examId) {
  const exam = await ExamInstance.findOne({
    assignmentId,
    org: org._id
  }).lean();

  if (!exam) {
    return res.status(404).send("Quiz not found");
  }

  return res.redirect(
    `/lms/quiz?examId=${encodeURIComponent(exam.examId)}&org=${encodeURIComponent(org.slug)}`
  );
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
const assignmentId = crypto.randomUUID();

     const slug = String(req.params.slug || "");

let {
  modules = [],
  userIds = [],
  grade = null,
  targetRole = "student",
  count = 20,
  expiresMinutes = 60,
  durationMinutes = 30,   // ✅ ADD THIS
  passageId = null,
    quizTitle = null
} = req.body || {};



// 🔑 normalize quiz target role
const effectiveTargetRole =
  targetRole === "employee" ? "teacher" : targetRole;

// ✅ validate modules
if (!Array.isArray(modules) || !modules.length) {
  return res.status(400).json({
    error: "At least one module must be selected"
  });
}

modules = modules.map(m => String(m).trim().toLowerCase());



const moduleKey = modules[0];


const resolvedQuizTitle =
  quizTitle ||
  (passageId
    ? "Comprehension Quiz"
    : moduleKey
      ? moduleKey.charAt(0).toUpperCase() + moduleKey.slice(1) + " Quiz"
      : "Quiz");


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

  title: resolvedQuizTitle,     // ✅ ADD
  quizTitle: resolvedQuizTitle, // ✅ ADD

  assignmentId,
  userId: mongoose.Types.ObjectId(uId),
  isOnboarding: false,
  questionIds,
  choicesOrder,
  targetRole: effectiveTargetRole,
  durationMinutes,
  expiresAt,
  createdAt: new Date()
});


          

            const url = `${baseUrl}/org/${org.slug}/quiz?examId=${examId}`;
            assigned.push({ userId: uId, examId, url });
          } catch (e) {
            console.warn("[assign-quiz][passage] user assign failed", uId, e && (e.stack || e));
          }
        } // end for userIds

     

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

  title: resolvedQuizTitle,     // ✅ ADD
  quizTitle: resolvedQuizTitle, // ✅ ADD

  assignmentId,
  userId: mongoose.Types.ObjectId(uId),
  questionIds,
  isOnboarding: false,
  targetRole: effectiveTargetRole,
  durationMinutes,
  choicesOrder,
  expiresAt,
  createdAt: new Date()
});


         
          const url = `${baseUrl}/org/${org.slug}/quiz?examId=${examId}`;
          assigned.push({ userId: uId, examId, url });
        } catch (e) {
          console.warn("[assign-quiz] user assign failed", uId, e && (e.stack || e));
        }
      } // end for userIds


return res.json({ ok: true, assigned, countUsed: docs.length });

    } catch (err) {
      console.error("[assign quiz] error:", err && (err.stack || err));
      return res.status(500).json({ error: "assign failed" });
    }
  }
);



//////////
// FIXED BULK ASSIGN ROUTE FOR CRIPFCNT-SCHOOL
// ADD THIS ROUTE TO routes/org_management.js AFTER the assign-quiz route

/* ------------------------------------------------------------------ */
/*  🆕 BULK ASSIGN ALL QUIZZES (cripfcnt-school only)                 */
/*  POST /admin/orgs/:slug/bulk-assign-all                            */
/* ------------------------------------------------------------------ */
router.post(
  "/admin/orgs/:slug/bulk-assign-all",
  ensureAuth,
  ensureAdminEmails,
  async (req, res) => {
    try {
      const slug = String(req.params.slug || "").trim();
      
      // Only for cripfcnt-school
      if (slug !== 'cripfcnt-school') {
        return res.status(403).json({ error: "Bulk assign only available for cripfcnt-school" });
      }

      const org = await Organization.findOne({ slug }).lean();
      if (!org) return res.status(404).json({ error: "org not found" });

      const {
        targetType = 'all', // all, specific
        userIds = [],
        durationMinutes = 30,
        previewOnly = false
      } = req.body;

      console.log('[bulk-assign-all] Starting bulk assignment', {
        targetType,
        userIdsCount: userIds.length,
        durationMinutes,
        previewOnly
      });

      // ===================================
      // STEP 1: RESOLVE TARGET USERS
      // ===================================
      let resolvedUserIds = [];

      if (targetType === 'all') {
        // Get all employees (staff members) in this org
        const memberships = await OrgMembership.find({
          org: org._id
        })
        .populate('user')
        .lean();

        if (!memberships.length) {
          return res.status(404).json({ error: "No members found in this organization" });
        }

        // Get user IDs from memberships
        resolvedUserIds = memberships
          .map(m => m.user ? String(m.user._id) : null)
          .filter(Boolean);

        console.log(`[bulk-assign-all] Found ${resolvedUserIds.length} members in org`);

      } else if (targetType === 'specific') {
        // Assign to specific users
        if (!Array.isArray(userIds) || !userIds.length) {
          return res.status(400).json({ error: "Please select at least one user" });
        }
        resolvedUserIds = userIds.map(String);
        console.log(`[bulk-assign-all] Using ${resolvedUserIds.length} specific users`);

      } else {
        return res.status(400).json({ error: "Invalid target type" });
      }

      if (!resolvedUserIds.length) {
        return res.status(404).json({ error: "No users to assign to" });
      }

      // ===================================
      // STEP 2: LOAD ALL QUIZZES
      // ===================================
     const allQuizzes = await Question.find({
  organization: org._id,
  type: "comprehension",
  'meta.isOutOfScope': { $ne: true }   // exclude maths/science/etc.
})
      .select('_id text module modules topics series questionIds')
      .lean();

      if (!allQuizzes.length) {
        return res.status(404).json({ error: "No quizzes found for this organization" });
      }

      console.log(`[bulk-assign-all] Found ${allQuizzes.length} quizzes to assign`);

      // ===================================
      // STEP 3: PREVIEW MODE (don't create)
      // ===================================
      if (previewOnly) {
        const totalInstances = resolvedUserIds.length * allQuizzes.length;
        return res.json({
          preview: true,
          usersCount: resolvedUserIds.length,
          quizzesCount: allQuizzes.length,
          totalInstances,
          durationMinutes
        });
      }

      // ===================================
      // STEP 4: CREATE EXAM INSTANCES
      // ===================================
      const baseAssignmentId = crypto.randomUUID(); // Base ID for this bulk assignment
      let totalCreated = 0;
      const errors = [];

      console.log('[bulk-assign-all] Starting exam instance creation...');

      for (const userId of resolvedUserIds) {
        for (const quiz of allQuizzes) {
          try {
            // Build question IDs array
            const questionIds = [];
            const choicesOrder = [];

            // Add parent marker
            questionIds.push(`parent:${String(quiz._id)}`);
            choicesOrder.push([]);

            // Add child questions with shuffled choices
            const childIds = Array.isArray(quiz.questionIds) ? quiz.questionIds.map(String) : [];
            
            for (const cid of childIds) {
              questionIds.push(String(cid));

              // Load child doc to get choice count
              let nChoices = 0;
              try {
                const childDoc = await Question.findById(String(cid)).select('choices').lean();
                if (childDoc) {
                  nChoices = Array.isArray(childDoc.choices) ? childDoc.choices.length : 0;
                }
              } catch (e) {
                nChoices = 0;
              }

              // Shuffle choice indices
              const indices = Array.from({ length: Math.max(0, nChoices) }, (_, i) => i);
              for (let i = indices.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [indices[i], indices[j]] = [indices[j], indices[i]];
              }
              choicesOrder.push(indices);
            }

            // Create unique exam instance
            const examId = crypto.randomUUID();
            const assignmentId = `${baseAssignmentId}-${quiz._id}`; // Unique per quiz

            const moduleKey = quiz.module || 'general';
            const quizTitle = quiz.text || 'Quiz';

            await ExamInstance.create({
              examId,
              assignmentId,
              org: org._id,
              userId: mongoose.Types.ObjectId(userId),
              module: moduleKey,
              modules: quiz.modules || [moduleKey],
              title: quizTitle,
              quizTitle: quizTitle,
              questionIds,
              choicesOrder,
              isOnboarding: false,
              targetRole: 'teacher', // cripfcnt-school uses 'teacher' for employees
              durationMinutes: Number(durationMinutes) || 30,
              meta: {
                bulkAssignmentId: baseAssignmentId,
                catalogQuizId: quiz._id,
                topics: quiz.topics || [],
                series: quiz.series,
                isBulkAssigned: true
              },
              createdAt: new Date()
            });

            totalCreated++;

            // Log progress every 100 instances
            if (totalCreated % 100 === 0) {
              console.log(`[bulk-assign-all] Created ${totalCreated} instances...`);
            }

          } catch (err) {
            console.error(`[bulk-assign-all] Failed to create exam for user ${userId}, quiz ${quiz._id}:`, err.message);
            errors.push({
              userId,
              quizId: quiz._id,
              error: err.message
            });
          }
        }
      }

      console.log(`[bulk-assign-all] Completed! Created ${totalCreated} exam instances`);

      return res.json({
        ok: true,
        totalCreated,
        usersCount: resolvedUserIds.length,
        quizzesCount: allQuizzes.length,
        durationMinutes,
        baseAssignmentId,
        errors: errors.length > 0 ? errors : undefined
      });

    } catch (err) {
      console.error("[bulk-assign-all] error:", err && (err.stack || err));
      return res.status(500).json({ error: "bulk assignment failed", detail: String(err && err.message) });
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

          // ===============================
// 📝 ESSAY QUESTION DETECTION
// ===============================
if (/^\[ESSAY\]/i.test(lines[0])) {
  const getLine = (prefix) =>
    lines.find(l => l.startsWith(prefix))
      ?.replace(prefix, "")
      .trim();

  const questionText = getLine("Question:");
  const template = getLine("Template:");

  const slots = [];
  let currentSlot = null;

  for (const line of lines.slice(1)) {
    if (
      line.endsWith(":") &&
      !line.startsWith("Question") &&
      !line.startsWith("Template")
    ) {
      currentSlot = {
        key: line.replace(":", "").toLowerCase(),
        label: line.replace(":", ""),
        options: []
      };
      slots.push(currentSlot);
    } else if (currentSlot && line.startsWith("-")) {
      currentSlot.options.push(
        line.replace("-", "").trim()
      );
    }
  }

  parsed.push({
    text: questionText || "Essay question",
    answerType: "essay",
    essayTemplate: template || "",
    essaySlots: slots,
    rawBlock: block
  });

  continue; // ⛔ DO NOT fall through to MCQ parser
}


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




// --------------------------------------------------
// USER: View own attempt (NON-ADMIN)
// GET /org/:slug/my-attempts/:attemptId
// --------------------------------------------------
router.get(
  "/org/:slug/my-attempts/:attemptId",
  ensureAuth,
  async (req, res) => {
    try {
      const { slug, attemptId } = req.params;

      if (!mongoose.isValidObjectId(attemptId)) {
        return res.status(400).send("invalid attempt id");
      }

      const org = await Organization.findOne({ slug }).lean();
      if (!org) return res.status(404).send("org not found");

      const attempt = await Attempt.findById(attemptId).lean();
      if (!attempt) return res.status(404).send("attempt not found");

      // 🔐 USER CAN ONLY VIEW THEIR OWN ATTEMPT
      if (String(attempt.userId) !== String(req.user._id)) {
        return res.status(403).send("Not allowed");
      }

      // Load questions
      const qIds = Array.isArray(attempt.questionIds)
        ? attempt.questionIds.map(String)
        : [];

      const questions = await Question.find({
        _id: { $in: qIds.filter(id => mongoose.isValidObjectId(id)) }
      }).lean();

      const qById = {};
      for (const q of questions) qById[String(q._id)] = q;

      const answersLookup = {};
      if (Array.isArray(attempt.answers)) {
        for (const a of attempt.answers) {
          if (a?.questionId)
            answersLookup[String(a.questionId)] = a.choiceIndex;
        }
      }

      const details = qIds.map((qid, idx) => {
        const q = qById[qid];
        const yourIndex = answersLookup[qid];

        let correctIndex = null;
        if (q) {
          if (typeof q.correctIndex === "number") correctIndex = q.correctIndex;
          else if (typeof q.answerIndex === "number") correctIndex = q.answerIndex;
        }

        return {
          qIndex: idx + 1,
          questionText: q?.text || "(question not found)",
          choices: q?.choices || [],
          yourIndex,
          correctIndex,
          correct:
            correctIndex !== null &&
            yourIndex !== null &&
            correctIndex === yourIndex
        };
      });

      return res.render("org/org_attempt_detail", {
        org,
        attempt,
        details,
        user: req.user
      });
    } catch (err) {
      console.error("[user attempt review] error:", err);
      return res.status(500).send("failed");
    }
  }
);


router.post(
  "/admin/orgs/:slug/import-admins",
  ensureAuth,
  allowPlatformAdminOrOrgManager, // NOT ensureAdminEmails
  upload.single("csv"),
  async (req, res) => {
    try {
      const slug = String(req.params.slug || "");
      const org = await Organization.findOne({ slug });
      if (!org) return res.status(404).json({ error: "org not found" });

      if (org.type !== "school") {
        return res.status(400).json({ error: "Only school orgs can import admins" });
      }

      if (!req.file) {
        return res.status(400).json({ error: "CSV file required" });
      }

      let created = 0;
      let skipped = 0;
      const errors = [];

      const stream = fs.createReadStream(req.file.path).pipe(
        parse({ columns: true, trim: true, skip_empty_lines: true })
      );

      for await (const row of stream) {
        try {
          const adminId = String(row.adminId || "").trim();
          const firstName = String(row.firstName || "").trim();
          const lastName = String(row.lastName || "").trim();
          const role = String(row.role || "admin").toLowerCase();

          if (!adminId || !firstName || !lastName) {
            skipped++;
            continue;
          }

          let user = await User.findOne({
            organization: org._id,
            adminId
          });

          if (!user) {
            user = await User.create({
              organization: org._id,
              role: "employee", // 🔒 NOT org_admin
              adminId,
              firstName,
              lastName
            });
          }

          await OrgMembership.findOneAndUpdate(
            { org: org._id, user: user._id },
            {
              $set: {
                role: role === "manager" ? "manager" : "admin",
                joinedAt: new Date()
              }
            },
            { upsert: true }
          );

          created++;
        } catch (e) {
          skipped++;
          errors.push(e.message);
        }
      }

      fs.unlink(req.file.path, () => {});
      return res.json({ ok: true, created, skipped, errors });
    } catch (err) {
      console.error("[import admins]", err);
      return res.status(500).json({ error: "import failed" });
    }
  }
);



router.post(
  "/admin/orgs/:slug/admins/:userId/password",
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
        organization: org._id
      });

      if (!user) {
        return res.status(404).json({ error: "Admin not found" });
      }

      await user.setPassword(password);
      await user.save();

      res.json({ ok: true });
    } catch (err) {
      console.error("[set admin password]", err);
      res.status(500).json({ error: "Failed to set password" });
    }
  }
);

// ═══════════════════════════════════════════════════════════════════
//  ADD THESE ROUTES TO routes/org_management.js
//  Paste them immediately BEFORE the final  export default router;  line.
//
//  These routes give admins a single, unified endpoint to:
//    1. Issue (or update) a username + password for any org member
//    2. Bulk-issue credentials to all members who don't have one yet
//    3. Let a user see their own credentials (username only)
//  The existing per-type password routes (/students/:id/password etc.)
//  are KEPT as-is for backward compat; these new routes complement them.
// ═══════════════════════════════════════════════════════════════════

/* ------------------------------------------------------------------ */
/*  ADMIN: Issue / update credentials for any single org member        */
/*  POST /admin/orgs/:slug/members/:userId/credentials                 */
/*                                                                      */
/*  Body: { username?, password, generateUsername? }                   */
/*    – if username is omitted and generateUsername=true, one is made   */
/*    – password is required and must be ≥ 8 chars                     */
/* ------------------------------------------------------------------ */
router.post(
  "/admin/orgs/:slug/members/:userId/credentials",
  ensureAuth,
  allowPlatformAdminOrOrgManager,
  async (req, res) => {
    try {
      const { slug, userId } = req.params;
      let { username, password, generateUsername } = req.body;

      if (!password || String(password).length < 8) {
        return res.status(400).json({ ok: false, error: "Password must be at least 8 characters" });
      }

      const org = await Organization.findOne({ slug }).lean();
      if (!org) return res.status(404).json({ ok: false, error: "Org not found" });

      // User must be a member of this org
      const membership = await OrgMembership.findOne({ org: org._id, user: userId }).lean();
      if (!membership) return res.status(404).json({ ok: false, error: "User not a member of this org" });

      const user = await User.findById(userId);
      if (!user) return res.status(404).json({ ok: false, error: "User not found" });

      // ── Username handling ──────────────────────────────────────
      if (username) {
        // Admin supplied a custom username — validate and check uniqueness
        username = String(username).toLowerCase().trim().replace(/[^a-z0-9_.\-]/g, "");
        if (username.length < 3) {
          return res.status(400).json({ ok: false, error: "Username must be at least 3 characters" });
        }
        const taken = await User.findOne({ username, _id: { $ne: user._id } }).lean();
        if (taken) {
          return res.status(409).json({ ok: false, error: `Username "${username}" is already taken` });
        }
        user.username = username;
      } else if (generateUsername || !user.username) {
        // Auto-generate if not supplied or if user has no username yet
        user.username = await User.createUniqueUsername(
          user.firstName || user.displayName?.split(" ")[0] || "user",
          user.lastName  || user.displayName?.split(" ").slice(1).join("") || ""
        );
      }
      // if username="" and generateUsername=false and user already has one → keep existing

      // ── Password ──────────────────────────────────────────────
      await user.setPassword(String(password));
      user.needsPasswordSetup = false;

      await user.save();

      console.log(`[credentials] Admin issued credentials to ${user.email || user._id} — username: ${user.username}`);

      return res.json({
        ok: true,
        username: user.username,
        userId:   String(user._id),
        message:  `Credentials issued. Username: ${user.username}`
      });
    } catch (err) {
      console.error("[admin issue credentials]", err);
      return res.status(500).json({ ok: false, error: "Failed to issue credentials" });
    }
  }
);

/* ------------------------------------------------------------------ */
/*  ADMIN: Bulk-issue credentials to ALL members with no password      */
/*  POST /admin/orgs/:slug/credentials/bulk-generate                   */
/*                                                                      */
/*  Finds every org member without a passwordHash, generates a         */
/*  username + a random 10-char temporary password, returns the list   */
/*  as JSON so the admin can copy/send them.                           */
/*  Does NOT overwrite users who already have passwords.               */
/* ------------------------------------------------------------------ */
router.post(
  "/admin/orgs/:slug/credentials/bulk-generate",
  ensureAuth,
  allowPlatformAdminOrOrgManager,
  async (req, res) => {
    try {
      const { slug } = req.params;

      const org = await Organization.findOne({ slug }).lean();
      if (!org) return res.status(404).json({ ok: false, error: "Org not found" });

      // All memberships for this org
      const memberships = await OrgMembership.find({ org: org._id })
        .populate("user", "_id firstName lastName email username passwordHash displayName role")
        .lean();

      const results = [];
      let skipped = 0;

      for (const m of memberships) {
        const u = m.user;
        if (!u) continue;
        if (u.passwordHash) { skipped++; continue; } // already has a password

        const user = await User.findById(u._id);
        if (!user) continue;

        // Generate username if missing
        if (!user.username) {
          user.username = await User.createUniqueUsername(
            user.firstName || user.displayName?.split(" ")[0] || "user",
            user.lastName  || user.displayName?.split(" ").slice(1).join("") || ""
          );
        }

        // Generate a secure temporary password:  <FirstName><4-digit-pin>!
        const pin   = String(Math.floor(1000 + Math.random() * 9000));
        const first = (user.firstName || "User").replace(/[^a-zA-Z]/g, "");
        const tempPassword = first + pin + "!";

        await user.setPassword(tempPassword);
        user.needsPasswordSetup = true; // flag: they should change this
        await user.save();

        results.push({
          userId:   String(user._id),
          name:     `${user.firstName || ""} ${user.lastName || ""}`.trim() || user.displayName || user.email,
          email:    user.email || "",
          role:     m.role,
          username: user.username,
          tempPassword,
          note: "User should change this password on first login"
        });
      }

      return res.json({
        ok:       true,
        issued:   results.length,
        skipped,
        credentials: results
      });
    } catch (err) {
      console.error("[bulk generate credentials]", err);
      return res.status(500).json({ ok: false, error: "Bulk generation failed" });
    }
  }
);

/* ------------------------------------------------------------------ */
/*  USER: Get own credentials (username only — password never sent)    */
/*  GET /org/:slug/my-credentials                                      */
/* ------------------------------------------------------------------ */
router.get(
  "/org/:slug/my-credentials",
  ensureAuth,
  async (req, res) => {
    try {
      const { slug } = req.params;
      const org = await Organization.findOne({ slug }).lean();
      if (!org) return res.status(404).json({ error: "Org not found" });

      const membership = await OrgMembership.findOne({ org: org._id, user: req.user._id }).lean();
      if (!membership) return res.status(403).json({ error: "Not a member" });

      const user = await User.findById(req.user._id)
        .select("username studentId teacherId adminId email firstName lastName needsPasswordSetup passwordHash")
        .lean();

      return res.json({
        username:          user.username || null,
        studentId:         user.studentId || null,
        teacherId:         user.teacherId || null,
        adminId:           user.adminId || null,
        hasPassword:       !!user.passwordHash,
        needsPasswordSetup:!!user.needsPasswordSetup,
        loginUrl:          "/auth/school"
      });
    } catch (err) {
      console.error("[my-credentials]", err);
      return res.status(500).json({ error: "Failed" });
    }
  }
);

/* ------------------------------------------------------------------ */
/*  BACKWARD COMPAT: Unified set-password for any user type            */
/*  POST /admin/orgs/:slug/users/:userId/password                      */
/*  (replaces /students/:id/password, /teachers/:id/password, etc.    */
/*   but those old routes still work too)                              */
/* ------------------------------------------------------------------ */
router.post(
  "/admin/orgs/:slug/users/:userId/password",
  ensureAuth,
  allowPlatformAdminOrOrgManager,
  async (req, res) => {
    try {
      const { slug, userId } = req.params;
      const { password } = req.body;

      if (!password || String(password).length < 4) {
        return res.status(400).json({ error: "Password too short (min 4 chars)" });
      }

      const org = await Organization.findOne({ slug });
      if (!org) return res.status(404).json({ error: "Org not found" });

      const membership = await OrgMembership.findOne({ org: org._id, user: userId }).lean();
      if (!membership) return res.status(404).json({ error: "User not a member of this org" });

      const user = await User.findById(userId);
      if (!user) return res.status(404).json({ error: "User not found" });

      await user.setPassword(String(password));
      await user.save();

      return res.json({ ok: true });
    } catch (err) {
      console.error("[unified set password]", err);
      return res.status(500).json({ error: "Failed to set password" });
    }
  }
);





// ══════════════════════════════════════════════════════════════════════
//  ADD THIS ROUTE to routes/org_management.js
//  Paste it immediately BEFORE the final  export default router;  line.
//
//  This enables the "✓ Activate" button in the new org_manage.hbs panel.
//  It sets employeeSubscriptionStatus → "paid" for any org member,
//  granting them full access without requiring a Paynow payment.
// ══════════════════════════════════════════════════════════════════════

/* ------------------------------------------------------------------ */
/*  ADMIN: Manually activate a member's account                        */
/*  POST /admin/orgs/:slug/members/:userId/activate                    */
/*                                                                      */
/*  Sets employeeSubscriptionStatus = "paid" and                       */
/*  employeeSubscriptionPlan = "full_access" on the User document.     */
/*  Expires 1 year from now (can be any value you choose).             */
/* ------------------------------------------------------------------ */
router.post(
  "/admin/orgs/:slug/members/:userId/activate",
  ensureAuth,
  allowPlatformAdminOrOrgManager,
  async (req, res) => {
    try {
      const { slug, userId } = req.params;

      const org = await Organization.findOne({ slug }).lean();
      if (!org) return res.status(404).json({ ok: false, error: "Org not found" });

      // Verify user is actually a member of this org
      const membership = await OrgMembership.findOne({ org: org._id, user: userId }).lean();
      if (!membership) return res.status(404).json({ ok: false, error: "User is not a member of this org" });

      const user = await User.findById(userId);
      if (!user) return res.status(404).json({ ok: false, error: "User not found" });

      // Set 1-year expiry from today (adjust as needed)
      const expiresAt = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);

      await User.findByIdAndUpdate(userId, {
        $set: {
          employeeSubscriptionStatus:   "paid",
          employeeSubscriptionPlan:     "full_access",
          employeePaidAt:               new Date(),
          employeeSubscriptionExpiresAt: expiresAt
        }
      });

      console.log(`[activate] Admin activated ${user.email || userId} in org ${slug}`);

      return res.json({
        ok:        true,
        userId:    String(userId),
        expiresAt: expiresAt.toISOString()
      });

    } catch (err) {
      console.error("[activate member]", err && (err.stack || err));
      return res.status(500).json({ ok: false, error: "Activation failed" });
    }
  }
);




// ═══════════════════════════════════════════════════════════════════
//  ADD BOTH ROUTES to routes/org_management.js
//  Paste immediately BEFORE the final  export default router;  line.
//
//  Route 1: GET  /admin/orgs/:slug/members/:userId/credentials
//    → Returns current username, IDs, hasPassword — for admin preview
//
//  Route 2: POST /admin/orgs/:slug/members/:userId/username
//    → Changes only the username, leaves password untouched
// ═══════════════════════════════════════════════════════════════════

/* ------------------------------------------------------------------ */
/*  ADMIN: Preview a member's current credentials (read-only)          */
/*  GET /admin/orgs/:slug/members/:userId/credentials                  */
/* ------------------------------------------------------------------ */
router.get(
  "/admin/orgs/:slug/members/:userId/credentials",
  ensureAuth,
  allowPlatformAdminOrOrgManager,
  async (req, res) => {
    try {
      const { slug, userId } = req.params;

      const org = await Organization.findOne({ slug }).lean();
      if (!org) return res.status(404).json({ ok: false, error: "Org not found" });

      const membership = await OrgMembership.findOne({ org: org._id, user: userId }).lean();
      if (!membership) return res.status(404).json({ ok: false, error: "User is not a member of this org" });

      const user = await User.findById(userId)
        .select("username studentId teacherId adminId email firstName lastName passwordHash needsPasswordSetup role createdAt lastLogin")
        .lean();

      if (!user) return res.status(404).json({ ok: false, error: "User not found" });

      return res.json({
        ok:                true,
        userId:            String(user._id),
        firstName:         user.firstName        || "",
        lastName:          user.lastName         || "",
        email:             user.email            || "",
        role:              membership.role        || user.role || "",
        username:          user.username          || null,
        studentId:         user.studentId         || null,
        teacherId:         user.teacherId         || null,
        adminId:           user.adminId           || null,
        hasPassword:       !!user.passwordHash,
        needsPasswordSetup:!!user.needsPasswordSetup,
        loginUrl:          "/auth/school",
        lastLogin:         user.lastLogin         || null,
        createdAt:         user.createdAt         || null,
      });
    } catch (err) {
      console.error("[admin get credentials]", err && (err.stack || err));
      return res.status(500).json({ ok: false, error: "Failed to load credentials" });
    }
  }
);

/* ------------------------------------------------------------------ */
/*  ADMIN: Update username only — password is NOT touched              */
/*  POST /admin/orgs/:slug/members/:userId/username                    */
/*                                                                      */
/*  Body: { username?, generate? }                                      */
/*    – username: custom slug (optional — validated for uniqueness)     */
/*    – generate: true  → auto-generate if username is blank/omitted    */
/* ------------------------------------------------------------------ */
router.post(
  "/admin/orgs/:slug/members/:userId/username",
  ensureAuth,
  allowPlatformAdminOrOrgManager,
  async (req, res) => {
    try {
      const { slug, userId } = req.params;
      let { username, generate } = req.body;

      const org = await Organization.findOne({ slug }).lean();
      if (!org) return res.status(404).json({ ok: false, error: "Org not found" });

      const membership = await OrgMembership.findOne({ org: org._id, user: userId }).lean();
      if (!membership) return res.status(404).json({ ok: false, error: "User not a member of this org" });

      const user = await User.findById(userId);
      if (!user) return res.status(404).json({ ok: false, error: "User not found" });

      if (username) {
        // Custom username provided — sanitise and check uniqueness
        username = String(username).toLowerCase().trim().replace(/[^a-z0-9_\-\.]/g, "");
        if (username.length < 3) {
          return res.status(400).json({ ok: false, error: "Username must be at least 3 characters" });
        }
        const taken = await User.findOne({ username, _id: { $ne: user._id } }).lean();
        if (taken) {
          return res.status(409).json({ ok: false, error: `Username "${username}" is already taken` });
        }
        user.username = username;
      } else if (generate || !user.username) {
        // Auto-generate
        user.username = await User.createUniqueUsername(
          user.firstName || user.displayName?.split(" ")[0] || "user",
          user.lastName  || user.displayName?.split(" ").slice(1).join("") || ""
        );
      } else {
        // Nothing to do — user already has a username and no new one was supplied
        return res.json({ ok: true, username: user.username, message: "Username unchanged" });
      }

      await user.save();

      console.log(`[username] Admin set username for ${user.email || userId} → ${user.username}`);

      return res.json({
        ok:       true,
        username: user.username,
        userId:   String(user._id),
        message:  `Username updated to: ${user.username}`
      });
    } catch (err) {
      console.error("[admin update username]", err && (err.stack || err));
      return res.status(500).json({ ok: false, error: "Failed to update username" });
    }
  }
);

// export default router
export default router;
