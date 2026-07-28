// routes/mobileSchool.js
//
// The learning platform for the mobile app: school/home quizzes (separate from
// the 8QT), child management for parents/teachers, offline-cacheable quizzes,
// attempt submission, and student performance data.
//
// Mount in server.js AFTER the main mobile router:
//    import mobileSchoolRouter from "./routes/mobileSchool.js";
//    app.use("/api/mobile/school", mobileSchoolRouter);
//
// Design: the server does the hard question-resolution ONCE and hands the app
// clean question JSON. The app caches that and can run the quiz offline; the
// finished attempt syncs back here. Scoring mirrors lms_api.js /quiz/submit.

import { Router } from "express";
import crypto from "crypto";
import mongoose from "mongoose";

import { requireMobileAuth } from "./mobileApi.js";
import User from "../models/user.js";
import Organization from "../models/organization.js";
import QuizRule from "../models/quizRule.js";
import Question from "../models/question.js";
import ExamInstance from "../models/examInstance.js";
import Payment from "../models/payment.js";
import paynow from "../services/paynow.js";
import { getStudentKnowledgeMap } from "../services/topicMasteryTracker.js";

const router = Router();

const PASS_THRESHOLD = parseInt(process.env.QUIZ_PASS_THRESHOLD || "60", 10);

/* Plan → how many children/learners the account may register. Mirrors parent.js. */
const PLAN_LIMITS = {
  none: 0,
  silver: 5,
  gold: 10,
  starter: 15,
  professional: 40
};

function childLimitFor(user) {
  if (user.role === "private_teacher") {
    return PLAN_LIMITS[user.teacherSubscriptionPlan] ?? 0;
  }
  return PLAN_LIMITS[user.subscriptionPlan] ?? 0;
}

function isPaid(user) {
  if (user.role === "private_teacher") {
    return ["starter", "professional"].includes(user.teacherSubscriptionPlan);
  }
  return ["silver", "gold"].includes(user.subscriptionPlan);
}

/** The org a parent/teacher's children belong to. Home org by default. */
async function resolveHomeOrg() {
  return Organization.findOne({ slug: "cripfcnt-home" }).lean();
}

/** Turn a Question doc into safe app JSON — correctIndex is NOT sent to the app. */
function publicQuestion(q) {
  return {
    _id: String(q._id),
    text: q.text,
    choices: (q.choices || []).map((c) => ({ label: c.label, text: c.text })),
    subject: q.subject || null,
    grade: q.grade ?? null,
    module: q.module || null,
    type: q.type || "question",
    passage: q.passage || null
  };
}

/* ══════════════════════════════════════════════════════════════════
   CATALOG — what grades/subjects exist for this account's org.
   ════════════════════════════════════════════════════════════════════ */

router.get("/catalog", requireMobileAuth, async (req, res) => {
  try {
    const org = await resolveHomeOrg();
    if (!org) return res.json({ grades: [], subjects: [], org: null });

    const rules = await QuizRule.find({ org: org._id, enabled: true })
      .select("grade subject module quizType questionCount title")
      .lean();

    const grades = new Set();
    const subjects = new Set();
    for (const r of rules) {
      if (r.grade) grades.add(r.grade);
      if (r.subject) subjects.add(r.subject);
    }

    return res.json({
      org: { id: String(org._id), name: org.name, slug: org.slug, type: org.type },
      grades: Array.from(grades).sort((a, b) => a - b),
      subjects: Array.from(subjects).sort(),
      ruleCount: rules.length
    });
  } catch (err) {
    console.error("[mobile school/catalog]", err);
    return res.status(500).json({ error: "Could not load the catalog." });
  }
});

/* ══════════════════════════════════════════════════════════════════
   CHILDREN / LEARNERS — list, with progress, and register new ones.
   ════════════════════════════════════════════════════════════════════ */

router.get("/children", requireMobileAuth, async (req, res) => {
  try {
    const parent = req.mobileUser;
    const kids = await User.find({ parentUserId: parent._id, role: "student" })
      .select("displayName firstName lastName grade studentId createdAt")
      .lean();

    const children = [];
    for (const c of kids) {
      const finished = await ExamInstance.find({ userId: c._id, status: "finished" })
        .select("meta quizTitle updatedAt")
        .lean();
      const pending = await ExamInstance.countDocuments({
        userId: c._id,
        status: { $in: ["pending", "started"] }
      });
      const scores = finished
        .map((e) => e.meta?.percentage ?? e.meta?.scorePct)
        .filter((n) => typeof n === "number");
      const avg = scores.length
        ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length)
        : null;

      children.push({
        _id: String(c._id),
        displayName: c.displayName || [c.firstName, c.lastName].filter(Boolean).join(" "),
        firstName: c.firstName,
        lastName: c.lastName,
        grade: c.grade ?? null,
        completedCount: finished.length,
        pendingCount: pending,
        avgScore: avg
      });
    }

    return res.json({
      children,
      plan: parent.role === "private_teacher" ? parent.teacherSubscriptionPlan : parent.subscriptionPlan,
      isPaid: isPaid(parent),
      childLimit: childLimitFor(parent),
      canAddChild:
        (isPaid(parent) && children.length < childLimitFor(parent)) ||
        (!isPaid(parent) && children.length === 0) // free trial allows one
    });
  } catch (err) {
    console.error("[mobile school/children]", err);
    return res.status(500).json({ error: "Could not load children." });
  }
});

router.post("/children", requireMobileAuth, async (req, res) => {
  try {
    const parent = req.mobileUser;
    const firstName = String(req.body?.firstName || "").trim();
    const lastName = String(req.body?.lastName || "").trim();
    const grade = req.body?.grade != null ? Number(req.body.grade) : null;

    if (!firstName) return res.status(400).json({ error: "Enter the child's first name." });
    if (!grade || grade < 1 || grade > 12) {
      return res.status(400).json({ error: "Choose the child's grade." });
    }

    const existing = await User.countDocuments({ parentUserId: parent._id, role: "student" });
    const paid = isPaid(parent);
    const limit = childLimitFor(parent);

    // Free trial: one child allowed. Paid: up to the plan limit.
    if (!paid && existing >= 1) {
      return res.status(402).json({
        code: "UPGRADE_REQUIRED",
        error: "Your free trial allows one child. Upgrade to add more."
      });
    }
    if (paid && existing >= limit) {
      return res.status(402).json({
        code: "UPGRADE_REQUIRED",
        error: `Your plan allows ${limit} children. Upgrade for more.`
      });
    }

    const org = await resolveHomeOrg();
    const username = await User.createUniqueUsername(firstName, lastName);

    const child = await User.create({
      role: "student",
      firstName,
      lastName,
      displayName: [firstName, lastName].filter(Boolean).join(" "),
      username,
      grade,
      parentUserId: parent._id,
      organization: org?._id || null, // schema field is "organization", not "org"
      provider: "managed", // created by a parent, no own login yet
      accountType: "student_self", // must be one of: parent | guardian | student_self
      consumerEnabled: true
    });

    // Give the child a starter/trial quiz set right away.
    try {
      if (org?._id) {
        const { assignOnboardingQuizzes } = await import("../services/onboarding.js");
        await assignOnboardingQuizzes({ orgId: org._id, userId: child._id });
      }
    } catch (e) {
      console.warn("[mobile school/children] onboarding assign skipped:", e.message);
    }

    return res.json({
      child: {
        _id: String(child._id),
        displayName: child.displayName,
        grade: child.grade
      }
    });
  } catch (err) {
    if (err?.code === 11000) {
      return res.status(409).json({ error: "That did not save. Please try again." });
    }
    console.error("[mobile school/children create]", err);
    return res.status(500).json({ error: "Could not add the child.", detail: String(err?.message || err) });
  }
});

/* ══════════════════════════════════════════════════════════════════
   QUIZZES — list available/assigned quizzes for a child, with lock flags.
   ════════════════════════════════════════════════════════════════════ */

router.get("/quizzes", requireMobileAuth, async (req, res) => {
  try {
    const parent = req.mobileUser;
    const childId = String(req.query.childId || "");
    if (!mongoose.isValidObjectId(childId)) {
      return res.status(400).json({ error: "Which child?" });
    }
    const child = await User.findOne({ _id: childId, parentUserId: parent._id }).lean();
    if (!child) return res.status(404).json({ error: "Child not found." });

    const paid = isPaid(parent);

    // 1) Assigned exams that already exist for this child (trial + onboarding).
    const assigned = await ExamInstance.find({
      userId: child._id,
      status: { $in: ["pending", "started"] }
    })
      .select("examId quizTitle title module status questionIds meta createdAt")
      .lean();

    const assignedCards = assigned.map((e) => ({
      examId: e.examId,
      title: e.quizTitle || e.title || e.module || "Quiz",
      module: e.module || null,
      questionCount: (e.questionIds || []).length,
      status: e.status,
      locked: false, // already assigned → always playable
      kind: "assigned"
    }));

    // 2) Catalogue quizzes for the child's grade (locked unless subscribed).
    const org = await resolveHomeOrg();
    const rules = org
      ? await QuizRule.find({ org: org._id, enabled: true, grade: child.grade })
          .select("subject module quizType questionCount title grade")
          .lean()
      : [];

    // How many trial subjects are free (one per subject on trial).
    const catalogueCards = rules.map((r) => ({
      ruleId: String(r._id),
      title: r.title || `${r.subject || "Quiz"} · Grade ${r.grade}`,
      subject: r.subject || null,
      module: r.module || null,
      grade: r.grade,
      questionCount: r.questionCount || 10,
      locked: !paid, // catalogue is locked on the free trial
      kind: "catalogue"
    }));

    return res.json({
      child: { _id: String(child._id), displayName: child.displayName, grade: child.grade },
      isPaid: paid,
      assigned: assignedCards,
      catalogue: catalogueCards
    });
  } catch (err) {
    console.error("[mobile school/quizzes]", err);
    return res.status(500).json({ error: "Could not load quizzes." });
  }
});

/* ══════════════════════════════════════════════════════════════════
   QUIZ WITH QUESTIONS — the server resolves questions once; the app caches
   this JSON and can run the quiz offline. Two entry points:
     • examId  → an already-assigned ExamInstance
     • ruleId  → build a fresh quiz from a QuizRule (subscribers only)
   ════════════════════════════════════════════════════════════════════ */

router.get("/quiz", requireMobileAuth, async (req, res) => {
  try {
    const parent = req.mobileUser;
    const childId = String(req.query.childId || "");
    const examId = req.query.examId ? String(req.query.examId) : null;
    const ruleId = req.query.ruleId ? String(req.query.ruleId) : null;

    const child = await User.findOne({ _id: childId, parentUserId: parent._id }).lean();
    if (!child) return res.status(404).json({ error: "Child not found." });

    let exam = null;
    let title = "Quiz";
    let moduleKey = null;

    if (examId) {
      exam = await ExamInstance.findOne({ examId, userId: child._id }).lean();
      if (!exam) return res.status(404).json({ error: "Quiz not found." });
      title = exam.quizTitle || exam.title || exam.module || "Quiz";
      moduleKey = exam.module || null;
    } else if (ruleId) {
      // Building from catalogue requires a subscription.
      if (!isPaid(parent)) {
        return res.status(402).json({ code: "UPGRADE_REQUIRED", error: "Subscribe to unlock this quiz." });
      }
      const rule = await QuizRule.findById(ruleId).lean();
      if (!rule) return res.status(404).json({ error: "Quiz not found." });

      const org = await resolveHomeOrg();
      const count = rule.questionCount || 10;
      const picked = await Question.aggregate([
        {
          $match: {
            $and: [
              { $or: [{ organization: org?._id }, { organization: null }] },
              rule.grade ? { grade: rule.grade } : {},
              rule.subject ? { subject: rule.subject } : {}
            ]
          }
        },
        { $sample: { size: count } }
      ]);

      if (!picked.length) return res.status(404).json({ error: "No questions available yet." });

      exam = await ExamInstance.create({
        examId: crypto.randomUUID(),
        org: org?._id,
        userId: child._id,
        targetRole: "student",
        module: rule.module || rule.subject || "quiz",
        quizTitle: rule.title || `${rule.subject} · Grade ${rule.grade}`,
        status: "pending",
        questionIds: picked.map((q) => String(q._id)),
        choicesOrder: picked.map((q) => Array.from({ length: (q.choices || []).length }, (_, i) => i)),
        createdAt: new Date()
      });
      exam = exam.toObject();
      title = exam.quizTitle;
      moduleKey = exam.module;
    } else {
      return res.status(400).json({ error: "Nothing to load." });
    }

    // Resolve the DB questions (mobile serves DB-question quizzes only).
    const ids = (exam.questionIds || [])
      .map(String)
      .filter((id) => mongoose.isValidObjectId(id));
    const docs = await Question.find({ _id: { $in: ids } }).lean();
    const byId = {};
    for (const d of docs) byId[String(d._id)] = d;

    // Preserve the stored order.
    const questions = ids.map((id) => byId[id]).filter(Boolean).map(publicQuestion);

    if (!questions.length) {
      return res.status(422).json({ error: "This quiz can't be taken on mobile yet." });
    }

    // Mark started.
    await ExamInstance.updateOne(
      { examId: exam.examId },
      { $set: { status: "started", startedAt: new Date() } }
    );

    return res.json({
      examId: exam.examId,
      title,
      module: moduleKey,
      childId: String(child._id),
      questions // no correctIndex — scoring happens on submit, server-side
    });
  } catch (err) {
    console.error("[mobile school/quiz]", err);
    return res.status(500).json({ error: "Could not load the quiz." });
  }
});

/* ══════════════════════════════════════════════════════════════════
   SUBMIT — score against Question.correctIndex, store the ExamInstance.
   Idempotent-ish: re-submitting the same examId updates the same record.
   Mirrors lms_api.js /quiz/submit scoring.
   ════════════════════════════════════════════════════════════════════ */

router.post("/quiz/submit", requireMobileAuth, async (req, res) => {
  try {
    const parent = req.mobileUser;
    const examId = String(req.body?.examId || "").trim();
    const childId = String(req.body?.childId || "");
    const answers = Array.isArray(req.body?.answers) ? req.body.answers : [];

    if (!examId) return res.status(400).json({ error: "Missing examId." });
    if (!answers.length) return res.status(400).json({ error: "No answers submitted." });

    const child = await User.findOne({ _id: childId, parentUserId: parent._id }).lean();
    if (!child) return res.status(404).json({ error: "Child not found." });

    const exam = await ExamInstance.findOne({ examId, userId: child._id });
    if (!exam) return res.status(404).json({ error: "Quiz not found." });

    // Load the answer key.
    const qIds = answers.map((a) => String(a.questionId)).filter(Boolean);
    const docs = await Question.find({ _id: { $in: qIds } })
      .select("correctIndex")
      .lean();
    const key = {};
    for (const d of docs) key[String(d._id)] = d.correctIndex;

    let correct = 0;
    const saved = [];
    for (const a of answers) {
      const qid = String(a.questionId);
      const ci = key[qid];
      const isCorrect = typeof ci === "number" && ci === a.choiceIndex;
      if (isCorrect) correct++;
      saved.push({ questionId: qid, choiceIndex: a.choiceIndex, correctIndex: ci, correct: isCorrect });
    }

    const total = answers.length;
    const percentage = Math.round((correct / Math.max(1, total)) * 100);
    const passed = percentage >= PASS_THRESHOLD;

    exam.status = "finished";
    exam.meta = {
      ...(exam.meta || {}),
      score: correct,
      total,
      percentage,
      passed,
      answers: saved,
      finishedAt: new Date().toISOString(), // stored in meta; ExamInstance has no finishedAt field
      source: "mobile-app"
    };
    exam.markModified("meta"); // Mixed fields need this to persist
    // ExamInstance uses timestamps, so updatedAt reflects completion too.
    await exam.save();

    return res.json({
      examId,
      score: correct,
      total,
      percentage,
      passed,
      passThreshold: PASS_THRESHOLD,
      // send the key back so the app can show which were right, now that it's scored
      answerKey: saved.map((s) => ({ questionId: s.questionId, correctIndex: s.correctIndex, correct: s.correct }))
    });
  } catch (err) {
    console.error("[mobile school/quiz/submit]", err);
    return res.status(500).json({ error: "Could not submit the quiz." });
  }
});

/* ══════════════════════════════════════════════════════════════════
   PERFORMANCE — a student's results over time for the performance page.
   ════════════════════════════════════════════════════════════════════ */

router.get("/performance", requireMobileAuth, async (req, res) => {
  try {
    const parent = req.mobileUser;
    const childId = String(req.query.childId || "");
    const child = await User.findOne({ _id: childId, parentUserId: parent._id }).lean();
    if (!child) return res.status(404).json({ error: "Child not found." });

    const finished = await ExamInstance.find({ userId: child._id, status: "finished" })
      .select("quizTitle title module meta updatedAt")
      .sort({ updatedAt: -1 })
      .limit(50)
      .lean();

    const attempts = finished.map((e) => ({
      examId: e.examId,
      title: e.quizTitle || e.title || e.module || "Quiz",
      subject: e.module || null,
      percentage: e.meta?.percentage ?? null,
      score: e.meta?.score ?? null,
      total: e.meta?.total ?? null,
      passed: e.meta?.passed ?? null,
      finishedAt: e.meta?.finishedAt || e.updatedAt
    }));

    const pcts = attempts.map((a) => a.percentage).filter((n) => typeof n === "number");
    const avg = pcts.length ? Math.round(pcts.reduce((a, b) => a + b, 0) / pcts.length) : null;

    // Per-subject averages for the breakdown.
    const bySubject = {};
    for (const a of attempts) {
      const s = a.subject || "general";
      if (!bySubject[s]) bySubject[s] = { subject: s, sum: 0, n: 0 };
      if (typeof a.percentage === "number") {
        bySubject[s].sum += a.percentage;
        bySubject[s].n += 1;
      }
    }
    const subjects = Object.values(bySubject).map((s) => ({
      subject: s.subject,
      avg: s.n ? Math.round(s.sum / s.n) : null,
      attempts: s.n
    }));

    return res.json({
      child: { _id: String(child._id), displayName: child.displayName, grade: child.grade },
      totalCompleted: attempts.length,
      avgScore: avg,
      subjects,
      recent: attempts.slice(0, 20)
    });
  } catch (err) {
    console.error("[mobile school/performance]", err);
    return res.status(500).json({ error: "Could not load performance." });
  }
});

/* ══════════════════════════════════════════════════════════════════
   ECOCASH PAYMENT (Paynow mobile) — native, in-app.
   Enter phone → USSD push → poll until paid → plan activates.
   Mirrors routes/payments.js but authed with the mobile JWT.
   ════════════════════════════════════════════════════════════════════ */

// Plan keys the app can buy. Maps a plan to its Paynow amount + label.
// Kept in sync with routes/payments.js PLANS.
const PAY_PLANS = {
  silver: { name: "Silver", amount: 5 },
  gold: { name: "Gold", amount: 10 },
  teacher_starter: { name: "Teacher Starter", amount: 9 },
  teacher_professional: { name: "Teacher Professional", amount: 19 }
};

/**
 * POST /api/mobile/school/pay/ecocash   { plan, phone }
 * Triggers the EcoCash USSD prompt on the user's phone.
 */
router.post("/pay/ecocash", requireMobileAuth, async (req, res) => {
  try {
    const user = req.mobileUser;
    const plan = String(req.body?.plan || "");
    const rawPhone = String(req.body?.phone || "");
    const bodyEmail = String(req.body?.email || "").trim().toLowerCase();

    if (!PAY_PLANS[plan]) return res.status(400).json({ error: "Choose a valid plan." });

    const phone = rawPhone.replace(/\s|-/g, "").replace(/^\+263/, "0").replace(/^263/, "0");
    if (!/^07[7-8]\d{7}$/.test(phone)) {
      return res.status(400).json({ error: "Enter a valid EcoCash number, e.g. 0771234567." });
    }

    const selected = PAY_PLANS[plan];
    const reference = `PN-${crypto.randomUUID()}`;

    const isValidEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(e || ""));
    const payerEmail = isValidEmail(bodyEmail)
      ? bodyEmail
      : isValidEmail(user.email)
      ? user.email
      : null;

    // Paynow rejects mobile payments without a valid email. Rather than send a
    // placeholder it will refuse, ask the app to collect one.
    if (!payerEmail) {
      return res.status(400).json({
        code: "EMAIL_REQUIRED",
        error: "Add a valid email to pay with EcoCash."
      });
    }

    // If they gave a real email and the account had none, save it for receipts
    // and future email sign-in.
    if (isValidEmail(bodyEmail) && !isValidEmail(user.email)) {
      try {
        await User.updateOne({ _id: user._id, email: { $in: [null, undefined, ""] } }, { $set: { email: bodyEmail } });
      } catch (e) {
        // non-fatal (e.g. email already taken) — proceed with the payment
      }
    }

    const paymentRequest = paynow.createPayment(reference, payerEmail);
    paymentRequest.add(`${selected.name} Plan - Monthly`, selected.amount);

    const response = await paynow.sendMobile(paymentRequest, phone, "ecocash");
    if (!response.success) {
      return res.status(400).json({ error: response.error || "Could not send the EcoCash prompt." });
    }

    await Payment.create({
      userId: user._id,
      reference,
      amount: selected.amount,
      plan,
      pollUrl: response.pollUrl,
      status: "pending",
      meta: { phone, method: "ecocash_mobile", source: "mobile-app" }
    });

    return res.json({
      success: true,
      reference,
      message: `Check ${phone} and approve the EcoCash prompt.`
    });
  } catch (err) {
    console.error("[mobile pay/ecocash]", err);
    return res.status(500).json({ error: "Payment error. Try again.", detail: String(err?.message || err) });
  }
});

/**
 * GET /api/mobile/school/pay/poll/:reference
 * The app polls this until status is "paid". Reuses the same processing the
 * web webhook uses, so plan activation is identical.
 */
router.get("/pay/poll/:reference", requireMobileAuth, async (req, res) => {
  try {
    const user = req.mobileUser;
    const reference = String(req.params.reference || "");
    const payment = await Payment.findOne({ reference, userId: user._id });
    if (!payment) return res.status(404).json({ error: "Payment not found." });

    if (payment.status === "paid") {
      return res.json({ status: "paid" });
    }

    // Ask Paynow for the latest status.
    let paid = false;
    try {
      if (payment.pollUrl && typeof paynow.pollTransaction === "function") {
        const status = await paynow.pollTransaction(payment.pollUrl);
        paid = !!(status && (status.paid === true || String(status.status).toLowerCase() === "paid"));
      }
    } catch (e) {
      console.warn("[mobile pay/poll] poll error:", e.message);
    }

    if (paid) {
      // Reuse the exact same processor the web poll/webhook uses, so plan
      // activation (days, slots, credits) is identical. It takes a payment _id.
      try {
        const mod = await import("./payments.js");
        if (typeof mod.processSuccessfulPayment === "function") {
          await mod.processSuccessfulPayment(payment._id);
        } else {
          payment.status = "paid";
          payment.paidAt = new Date();
          await payment.save();
        }
      } catch (e) {
        console.warn("[mobile pay/poll] finalise fallback:", e.message);
        payment.status = "paid";
        payment.paidAt = new Date();
        await payment.save();
      }
      // Return the refreshed entitlement so the app can update instantly.
      const fresh = await User.findById(user._id).lean();
      return res.json({
        status: "paid",
        plan:
          fresh.role === "private_teacher"
            ? fresh.teacherSubscriptionPlan
            : fresh.subscriptionPlan
      });
    }

    return res.json({ status: payment.status || "pending" });
  } catch (err) {
    console.error("[mobile pay/poll]", err);
    return res.status(500).json({ error: "Could not check payment." });
  }
});

/* ══════════════════════════════════════════════════════════════════
   KNOWLEDGE MAP — per-subject topic mastery: strengths and areas to
   improve. Reuses services/topicMasteryTracker.js so it matches the web.
   ════════════════════════════════════════════════════════════════════ */

router.get("/knowledge-map", requireMobileAuth, async (req, res) => {
  try {
    const parent = req.mobileUser;
    const childId = String(req.query.childId || "");
    const child = await User.findOne({ _id: childId, parentUserId: parent._id }).lean();
    if (!child) return res.status(404).json({ error: "Child not found." });
    if (!child.grade) {
      return res.json({ child: { _id: String(child._id), displayName: child.displayName }, maps: {}, note: "Set the child's grade to see their knowledge map." });
    }

    const subjects = [
      "math", "environmentalstudies", "biology", "english",
      "computerstudies", "history", "geography", "science", "responsibility"
    ];

    const maps = {};
    for (const subject of subjects) {
      try {
        const map = await getStudentKnowledgeMap(child._id, subject, child.grade);
        if (map?.stats?.totalTopics > 0) maps[subject] = map;
      } catch (e) {
        // skip subjects with no data
      }
    }

    return res.json({
      child: { _id: String(child._id), displayName: child.displayName, grade: child.grade },
      subjects: Object.keys(maps),
      maps
    });
  } catch (err) {
    console.error("[mobile knowledge-map]", err);
    return res.status(500).json({ error: "Could not load the knowledge map." });
  }
});

export default router;
