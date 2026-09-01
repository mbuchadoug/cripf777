// routes/mobileProfessional.js
//
// The PROFESSIONALS platform for the mobile app.
//
// A professional signs up (role "employee" → persona "professional"), sees the
// eight CRIPFCnt framework courses, takes an assessment for a course, is scored,
// and earns a certificate on a pass. Because the account is the SAME User document
// used on cripfcnt.com, and every attempt is written with source "mobile-app" and
// the same userId, all of this shows up under their web account automatically -
// that is what "link with web account" means here.
//
// Design mirrors routes/mobileSchool.js exactly:
//   • the server resolves the question set ONCE and hands the app clean JSON
//     (correctIndex is NEVER sent to the device),
//   • the app caches it and can run the assessment offline,
//   • the finished attempt syncs back here and is scored server-side,
//   • scoring + persistence match lms_api.js and mobileSchool.js (ExamInstance +
//     Attempt), so nothing about the web reporting changes.
//
// PURELY ADDITIVE. It does not touch any existing route, model, or flow.
//
// Mount in server.js AFTER the school router (see the two-line diff in the notes):
//    import mobileProfessionalRouter from "./routes/mobileProfessional.js";
//    app.use("/api/mobile/pro", mobileProfessionalRouter);

import { Router } from "express";
import crypto from "crypto";
import mongoose from "mongoose";

import { requireMobileAuth } from "./mobileApi.js";
import User from "../models/user.js";
import Organization from "../models/organization.js";
import Question from "../models/question.js";
import ExamInstance from "../models/examInstance.js";
import Attempt from "../models/attempt.js";

const router = Router();

const PASS_THRESHOLD = parseInt(process.env.QUIZ_PASS_THRESHOLD || "60", 10);
const DEFAULT_COUNT = parseInt(process.env.PRO_QUIZ_COUNT || "10", 10);

/* ══════════════════════════════════════════════════════════════════
   THE EIGHT COURSES
   The framework pillars. `module` matches the Question.modules enum and the
   web's module keys; `code`/`name`/`blurb` match src/content.js QUOTIENTS so the
   app, the website and the certificate all read as one product.
   ════════════════════════════════════════════════════════════════════ */
const PILLARS = [
  { module: "consciousness", code: "CsQ", name: "Consciousness", blurb: "Knowing what is actually happening - not just what you are told." },
  { module: "responsibility", code: "RQ", name: "Responsibility", blurb: "Owning outcomes, not just intentions." },
  { module: "interpretation", code: "IQ", name: "Interpretation", blurb: "Reading what others miss in the same information." },
  { module: "purpose", code: "PQ", name: "Purpose", blurb: "Direction that turns activity into contribution." },
  { module: "frequencies", code: "FQ", name: "Frequencies", blurb: "How you communicate decides who actually hears you." },
  { module: "civilization", code: "CvQ", name: "Civilization", blurb: "Connecting individual progress to collective advance." },
  { module: "negotiation", code: "NQ", name: "Negotiation", blurb: "Every outcome is negotiated, including the silences." },
  { module: "technology", code: "TQ", name: "Technology", blurb: "Understanding the new rules of who gets seen and trusted." }
];

const PILLAR_BY_MODULE = PILLARS.reduce((acc, p) => {
  acc[p.module] = p;
  return acc;
}, {});

/** Fisher-Yates shuffle - returns a new shuffled array. */
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Turn a Question doc into safe app JSON - correctIndex is NOT sent to the app. */
function publicQuestion(q) {
  return {
    _id: String(q._id),
    text: q.text,
    choices: (q.choices || []).map((c) => ({ label: c.label, text: c.text })),
    module: q.module || null,
    type: q.type || "question",
    passage: q.passage || null
  };
}

/** Home org - the org professionals' attempts are tagged with, so the web's
 *  mastery/reporting pipeline (which keys off the home org) still runs. */
async function resolveHomeOrg() {
  try {
    return await Organization.findOne({ slug: "cripfcnt-home" }).lean();
  } catch {
    return null;
  }
}

/** Whether this professional is on a paid plan. Non-blocking in this build -
 *  assessments are free to take; this only drives a badge in the UI. */
function isPaidPro(user) {
  return ["full_access"].includes(user.employeeSubscriptionPlan);
}

/**
 * Find answerable multiple-choice questions for a pillar.
 *   • standalone questions tagged with the module (single `module` OR in the
 *     `modules` array), that have at least two choices and a correctIndex.
 * We do NOT pull comprehension parents here: a professional micro-assessment is
 * a set of standalone MCQs, which keeps it short and offline-friendly.
 */
async function findModuleQuestions(module) {
  return Question.find({
    $and: [
      { $or: [{ module }, { modules: module }] },
      { type: { $ne: "comprehension" } },
      { correctIndex: { $ne: null } },
      { "choices.1": { $exists: true } } // at least two choices
    ]
  })
    .select("text choices module type")
    .lean();
}

async function countModuleQuestions(module) {
  return Question.countDocuments({
    $and: [
      { $or: [{ module }, { modules: module }] },
      { type: { $ne: "comprehension" } },
      { correctIndex: { $ne: null } },
      { "choices.1": { $exists: true } }
    ]
  });
}

/* ══════════════════════════════════════════════════════════════════
   CATALOG - the eight courses, with what's available and how the
   signed-in professional has done on each.
   ════════════════════════════════════════════════════════════════════ */
router.get("/catalog", requireMobileAuth, async (req, res) => {
  try {
    const me = req.mobileUser;

    // This professional's finished pro assessments, most recent first.
    const finished = await ExamInstance.find({
      userId: me._id,
      "meta.track": "professional",
      status: "finished"
    })
      .select("module meta updatedAt")
      .sort({ updatedAt: -1 })
      .lean();

    // Best score + certificate state per module.
    const byModule = {};
    for (const e of finished) {
      const key = e.module;
      if (!key) continue;
      const pct = typeof e.meta?.percentage === "number" ? e.meta.percentage : null;
      if (!byModule[key]) {
        byModule[key] = { bestScore: pct, attempts: 0, passed: false, certificateStatus: null };
      }
      byModule[key].attempts += 1;
      if (pct != null && (byModule[key].bestScore == null || pct > byModule[key].bestScore)) {
        byModule[key].bestScore = pct;
      }
      if (e.meta?.passed) byModule[key].passed = true;
      if (e.meta?.certificateStatus && !byModule[key].certificateStatus) {
        byModule[key].certificateStatus = e.meta.certificateStatus;
      }
    }

    // Availability per pillar (how many answerable questions exist).
    const courses = [];
    for (const p of PILLARS) {
      const available = await countModuleQuestions(p.module);
      const stat = byModule[p.module] || {};
      courses.push({
        module: p.module,
        code: p.code,
        name: p.name,
        blurb: p.blurb,
        questionsAvailable: available,
        available: available >= 3, // need a minimum to be a real assessment
        bestScore: stat.bestScore ?? null,
        attempts: stat.attempts || 0,
        passed: !!stat.passed,
        certificateStatus: stat.certificateStatus || null
      });
    }

    return res.json({
      courses,
      isPaid: isPaidPro(me),
      plan: me.employeeSubscriptionPlan || "none",
      passThreshold: PASS_THRESHOLD,
      user: {
        displayName: me.displayName || [me.firstName, me.lastName].filter(Boolean).join(" "),
        email: me.email || null
      }
    });
  } catch (err) {
    console.error("[mobile pro/catalog]", err);
    return res.status(500).json({ error: "Could not load courses." });
  }
});

/* ══════════════════════════════════════════════════════════════════
   ASSESSMENT WITH QUESTIONS - resolve once, cache on device, run offline.
   GET /api/mobile/pro/quiz?module=<pillar>&count=10
   ════════════════════════════════════════════════════════════════════ */
router.get("/quiz", requireMobileAuth, async (req, res) => {
  try {
    const me = req.mobileUser;
    const module = String(req.query.module || "").trim().toLowerCase();
    let count = parseInt(req.query.count || String(DEFAULT_COUNT), 10);
    if (!Number.isFinite(count)) count = DEFAULT_COUNT;
    count = Math.max(3, Math.min(20, count));

    const pillar = PILLAR_BY_MODULE[module];
    if (!pillar) return res.status(400).json({ error: "Unknown course." });

    const pool = await findModuleQuestions(module);
    if (!pool.length || pool.length < 3) {
      return res.status(422).json({
        code: "NO_ASSESSMENT",
        error: "This course has no assessment yet. Check back soon."
      });
    }

    const picked = shuffle(pool).slice(0, Math.min(count, pool.length));
    const questions = picked.map(publicQuestion);
    const resolvedIds = questions.map((q) => q._id);

    const org = await resolveHomeOrg();
    const title = `${pillar.name} · Assessment`;

    // Bind the exact question set onto a fresh ExamInstance so submit scores the
    // same questions the professional saw.
    const exam = await ExamInstance.create({
      examId: crypto.randomUUID(),
      org: org?._id || me.organization || null,
      userId: me._id,
      targetRole: "employee",
      module,
      quizTitle: title,
      title,
      status: "started",
      durationMinutes: 0,
      questionIds: resolvedIds,
      meta: { track: "professional", subject: module, code: pillar.code, source: "mobile-app" }
    });

    return res.json({
      examId: exam.examId,
      module,
      code: pillar.code,
      title,
      questionCount: questions.length,
      questions // no correctIndex; scoring stays server-side
    });
  } catch (err) {
    console.error("[mobile pro/quiz]", err);
    return res.status(500).json({ error: "Could not load the assessment." });
  }
});

/* ══════════════════════════════════════════════════════════════════
   SUBMIT - score against Question.correctIndex, persist ExamInstance + Attempt.
   Mirrors mobileSchool.js /quiz/submit and lms_api.js scoring.
   POST /api/mobile/pro/quiz/submit  { examId, module, answers:[{questionId,choiceIndex}] }
   ════════════════════════════════════════════════════════════════════ */
router.post("/quiz/submit", requireMobileAuth, async (req, res) => {
  try {
    const me = req.mobileUser;
    const examId = String(req.body?.examId || "").trim();
    const answers = Array.isArray(req.body?.answers) ? req.body.answers : [];

    if (!examId) return res.status(400).json({ error: "Missing examId." });
    if (!answers.length) return res.status(400).json({ error: "No answers submitted." });

    const exam = await ExamInstance.findOne({ examId, userId: me._id });
    if (!exam) return res.status(404).json({ error: "Assessment not found." });

    const module = exam.module || String(req.body?.module || "").trim().toLowerCase();
    const pillar = PILLAR_BY_MODULE[module] || null;

    // Load the question docs we need to score (correctIndex, choices, text).
    const qIds = answers.map((a) => String(a.questionId)).filter(Boolean);
    const docs = await Question.find({ _id: { $in: qIds } })
      .select("correctIndex module choices text")
      .lean();
    const byId = {};
    for (const d of docs) byId[String(d._id)] = d;

    let correct = 0;
    const saved = [];
    const attemptAnswers = [];
    for (const a of answers) {
      const qid = String(a.questionId);
      const q = byId[qid] || {};
      const ci = q.correctIndex;
      const isCorrect = typeof ci === "number" && ci === a.choiceIndex;
      if (isCorrect) correct++;

      const selectedText =
        Array.isArray(q.choices) && q.choices[a.choiceIndex]
          ? q.choices[a.choiceIndex].text || ""
          : "";

      saved.push({ questionId: qid, choiceIndex: a.choiceIndex, correctIndex: ci, correct: isCorrect });
      attemptAnswers.push({
        questionId: mongoose.isValidObjectId(qid) ? new mongoose.Types.ObjectId(qid) : qid,
        choiceIndex: a.choiceIndex,
        shownIndex: a.choiceIndex,
        selectedText,
        correctIndex: typeof ci === "number" ? ci : null,
        correct: isCorrect
      });
    }

    const total = answers.length;
    const percentage = Math.round((correct / Math.max(1, total)) * 100);
    const passed = percentage >= PASS_THRESHOLD;
    const now = new Date();

    // 1) Update the ExamInstance.
    exam.status = "finished";
    exam.meta = {
      ...(exam.meta || {}),
      track: "professional",
      code: pillar?.code || exam.meta?.code || null,
      subject: module,
      score: correct,
      total,
      percentage,
      passed,
      certificateEligible: passed,
      answers: saved,
      finishedAt: now.toISOString(),
      source: "mobile-app"
    };
    exam.markModified("meta");
    await exam.save();

    // 2) Write an Attempt - what web/admin attempts pages read. Fire-and-forget
    //    mastery update, exactly like mobileSchool.js (never blocks the submit).
    try {
      let orgId = exam.org || me.organization || null;
      if (!orgId) {
        const home = await resolveHomeOrg();
        orgId = home?._id || null;
      }
      const savedAttempt = await Attempt.findOneAndUpdate(
        { examId, userId: me._id },
        {
          $set: {
            examId,
            userId: me._id,
            organization: orgId,
            module,
            subject: module,
            quizTitle: exam.quizTitle || exam.title || "Assessment",
            questionIds: exam.questionIds || qIds,
            answers: attemptAnswers,
            score: correct,
            correctCount: correct,
            maxScore: total,
            scorePct: percentage,
            percentage,
            passed,
            status: "finished",
            source: "mobile-app",
            finishedAt: now
          },
          $setOnInsert: { startedAt: exam.startedAt || now }
        },
        { upsert: true, new: true }
      );

      if (savedAttempt && savedAttempt._id) {
        import("../services/topicMasteryTracker.js")
          .then((m) => m.updateTopicMasteryFromAttempt(savedAttempt._id))
          .catch(() => {}); // non-fatal, and absent in some deployments
      }
    } catch (attErr) {
      console.error("[mobile pro/submit] Attempt write failed:", attErr.message);
      // Non-fatal: the ExamInstance is still saved.
    }

    return res.json({
      examId,
      module,
      code: pillar?.code || null,
      title: exam.quizTitle || exam.title || "Assessment",
      score: correct,
      total,
      percentage,
      passed,
      passThreshold: PASS_THRESHOLD,
      certificateEligible: passed,
      answerKey: saved.map((s) => ({ questionId: s.questionId, correctIndex: s.correctIndex, correct: s.correct }))
    });
  } catch (err) {
    console.error("[mobile pro/quiz/submit]", err);
    return res.status(500).json({ error: "Could not submit the assessment." });
  }
});

/* ══════════════════════════════════════════════════════════════════
   CERTIFICATES - every passed course, as a credential the app can render.
   ════════════════════════════════════════════════════════════════════ */
router.get("/certificates", requireMobileAuth, async (req, res) => {
  try {
    const me = req.mobileUser;

    const passed = await ExamInstance.find({
      userId: me._id,
      "meta.track": "professional",
      status: "finished",
      "meta.passed": true
    })
      .select("examId module quizTitle title meta updatedAt")
      .sort({ updatedAt: -1 })
      .lean();

    // One certificate per module - the best passing attempt.
    const bestByModule = {};
    for (const e of passed) {
      const key = e.module;
      const pct = typeof e.meta?.percentage === "number" ? e.meta.percentage : 0;
      if (!bestByModule[key] || pct > (bestByModule[key].meta?.percentage || 0)) {
        bestByModule[key] = e;
      }
    }

    const certificates = Object.values(bestByModule).map((e) => {
      const pillar = PILLAR_BY_MODULE[e.module] || {};
      return {
        examId: e.examId,
        module: e.module,
        code: pillar.code || null,
        name: pillar.name || e.module,
        title: e.quizTitle || e.title || `${pillar.name || e.module} · Assessment`,
        percentage: e.meta?.percentage ?? null,
        passedAt: e.meta?.finishedAt || e.updatedAt,
        certificateStatus: e.meta?.certificateStatus || "earned"
      };
    });

    return res.json({
      certificates,
      user: {
        displayName: me.displayName || [me.firstName, me.lastName].filter(Boolean).join(" "),
        email: me.email || null
      }
    });
  } catch (err) {
    console.error("[mobile pro/certificates]", err);
    return res.status(500).json({ error: "Could not load certificates." });
  }
});

/* ══════════════════════════════════════════════════════════════════
   REQUEST AN OFFICIAL CERTIFICATE - records the request on the passing
   attempt, exactly like the 8QT certificate flow. The official PDF is issued
   by the existing web/admin certificate pipeline against the same account.
   POST /api/mobile/pro/certificate-request  { examId, name, email }
   ════════════════════════════════════════════════════════════════════ */
router.post("/certificate-request", requireMobileAuth, async (req, res) => {
  try {
    const me = req.mobileUser;
    const examId = String(req.body?.examId || "").trim();
    if (!examId) return res.status(400).json({ error: "Missing examId." });

    const exam = await ExamInstance.findOne({ examId, userId: me._id });
    if (!exam) return res.status(404).json({ error: "Assessment not found. Sync it first." });
    if (!exam.meta?.passed) {
      return res.status(400).json({ error: "You need to pass this assessment first." });
    }

    exam.meta = {
      ...(exam.meta || {}),
      certificateStatus: "requested",
      certificateRequestedAt: new Date().toISOString(),
      certificateName: String(req.body?.name || me.displayName || "").trim(),
      certificateEmail: String(req.body?.email || me.email || "").trim()
    };
    exam.markModified("meta");
    await exam.save();

    return res.json({ ok: true, examId, certificateStatus: "requested" });
  } catch (err) {
    console.error("[mobile pro/certificate-request]", err);
    return res.status(500).json({ error: "Could not record the request." });
  }
});

export default router;