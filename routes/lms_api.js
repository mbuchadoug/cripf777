// routes/lms_api.js  (REPLACE WHOLE FILE)
import { Router } from "express";
import mongoose from "mongoose";
import Question from "../models/question.js";
import Organization from "../models/organization.js";
import ExamInstance from "../models/examInstance.js";
import Attempt from "../models/attempt.js";
import fs from "fs";
import path from "path";

const router = Router();

// fallback file loader (like before)
function fetchRandomQuestionsFromFile(count = 5) {
  try {
    const p = path.join(process.cwd(), "data", "data_questions.json");
    if (!fs.existsSync(p)) return [];
    const raw = fs.readFileSync(p, "utf8");
    const all = JSON.parse(raw);
    for (let i = all.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [all[i], all[j]] = [all[j], all[i]];
    }
    return all.slice(0, count).map((d) => ({
      id: d.id || d._id || d.uuid || "fid-" + Math.random().toString(36).slice(2, 9),
      text: d.text,
      choices: (d.choices || []).map((c) => ({ text: c.text || c })),
      correctIndex:
        typeof d.correctIndex === "number" ? d.correctIndex : null,
      tags: d.tags || [],
      difficulty: d.difficulty || "medium",
    }));
  } catch (err) {
    console.error("[fetchRandomQuestionsFromFile] error:", err && (err.stack || err));
    return [];
  }
}

/**
 * GET /api/lms/quiz?count=5&module=responsibility&org=muono
 * - returns { examId, series }
 * - also persists a light ExamInstance on the server so submit can validate examId
 */
router.get("/quiz", async (req, res) => {
  let count = parseInt(req.query.count || "5", 10);
  if (!Number.isFinite(count)) count = 5;
  count = Math.max(1, Math.min(50, count));

  const moduleKey = String(req.query.module || "").trim().toLowerCase();
  const orgSlug = String(req.query.org || "").trim();

  try {
    let orgId = null;
    if (orgSlug) {
      const org = await Organization.findOne({ slug: orgSlug }).lean();
      if (org) orgId = org._id;
    }

    const match = {};
    if (moduleKey) {
      match.module = { $regex: new RegExp(`^${moduleKey}$`, "i") };
    }
    if (orgId) {
      match.$or = [{ organization: orgId }, { organization: null }];
    }

    const pipeline = [];
    if (Object.keys(match).length) pipeline.push({ $match: match });
    pipeline.push({ $sample: { size: count } });

    let docs = [];
    try {
      docs = await Question.aggregate(pipeline).allowDiskUse(true);
    } catch (e) {
      console.error("[/api/lms/quiz] aggregate error:", e && (e.stack || e));
    }

    let series;
    let questionIdsForInstance = [];
    if (docs && docs.length) {
      series = docs.map((d) => {
        questionIdsForInstance.push(String(d._id)); // valid ObjectId strings
        return {
          id: String(d._id),
          text: d.text,
          choices: (d.choices || []).map((c) => ({ text: c.text || c })),
          tags: d.tags || [],
          difficulty: d.difficulty || "medium",
        };
      });
    } else {
      // fallback to static file
      series = fetchRandomQuestionsFromFile(count);
      // file IDs are not ObjectIds; we won't populate questionIdsForInstance for those
    }

    const examId = "exam-" + Date.now().toString(36);

    // create/stash an ExamInstance document so submit can verify the examId
    try {
      const examDoc = {
        examId,
        org: orgId || null,
        module: moduleKey || "general",
        user: req.user && req.user._id ? req.user._id : null,
        questionIds: questionIdsForInstance, // array of ObjectId strings (or empty)
        choicesOrder: [], // if you later randomize choice order, store mapping here
        createdAt: new Date(),
        // expiresAt could be set to e.g. now + 1 hour if you want
      };

      await ExamInstance.create(examDoc);
    } catch (e) {
      // Non-fatal: log but still return the series so client can proceed
      console.error("[/api/lms/quiz] failed to create ExamInstance:", e && (e.stack || e));
    }

    return res.json({ examId, series });
  } catch (err) {
    console.error("[GET /api/lms/quiz] error:", err && (err.stack || err));
    return res.status(500).json({ error: "Failed to fetch quiz" });
  }
});

/**
 * POST /api/lms/quiz/submit
 * Body: { examId, answers: [{ questionId, choiceIndex }] }
 * - Scores answers
 * - Persists an Attempt document (finished)
 * - Updates ExamInstance (optional)
 */
/**
 * POST /api/lms/quiz/submit
 * Body: { examId, answers: [{ questionId, choiceIndex }], module?, org? }
 */
router.post("/quiz/submit", async (req, res) => {
  try {
    const payload = req.body || {};
    const answers = Array.isArray(payload.answers) ? payload.answers : [];
    if (!answers.length) return res.status(400).json({ error: "No answers submitted" });

    const examId = String(payload.examId || "").trim() || null;
    const moduleKey = String(payload.module || "").trim() || null;
    const orgSlugOrId = payload.org || null;

    // Build set of question ids user submitted
    const qIds = answers.map(a => a.questionId).filter(Boolean).map(String);

    // Try to find an ExamInstance if examId provided
    let exam = null;
    if (examId) {
      exam = await ExamInstance.findOne({ examId }).lean().exec().catch(() => null);
    }

    // Map to store question data
    const byId = {};

    // 1) Load DB questions for any ObjectId-like ids
    const dbIds = qIds.filter(id => mongoose.isValidObjectId(id));
    if (dbIds.length) {
      try {
        const qDocs = await Question.find({ _id: { $in: dbIds } }).lean().exec();
        for (const q of qDocs) byId[String(q._id)] = q;
      } catch (e) {
        console.error("[quiz/submit] DB lookup error:", e && (e.stack || e));
      }
    }

    // 2) File fallback: load data_questions.json and map by id fields if missing
    try {
      const p = path.join(process.cwd(), "data", "data_questions.json");
      if (fs.existsSync(p)) {
        const fileQ = JSON.parse(fs.readFileSync(p, "utf8"));
        for (const fq of fileQ) {
          const fid = String(fq.id || fq._id || fq.uuid || "");
          if (fid && !byId[fid]) byId[fid] = fq;
        }
      }
    } catch (e) {
      console.error("[quiz/submit] file fallback error:", e && (e.stack || e));
    }

    // Score loop & detail building
    let score = 0;
    const details = [];
    const savedAnswers = []; // canonical answers we'll persist

    for (const a of answers) {
      const qid = String(a.questionId || "");
      const yourIndex = (typeof a.choiceIndex === "number") ? a.choiceIndex : null;
      const q = byId[qid] || null;

      let correctIndex = null;
      if (q) {
        if (typeof q.correctIndex === "number") correctIndex = q.correctIndex;
        else if (typeof q.answerIndex === "number") correctIndex = q.answerIndex;
        else if (typeof q.correct === "number") correctIndex = q.correct;
        // if stored as text or other shape, adapt accordingly
      }

      const correct = (correctIndex !== null && yourIndex !== null && correctIndex === yourIndex);

      if (correct) score++;

      details.push({
        questionId: qid,
        correctIndex: (correctIndex !== null) ? correctIndex : null,
        yourIndex,
        correct: !!correct,
      });

      // Build answer record for persistent attempt (store as ObjectId if possible)
      const qObjId = mongoose.isValidObjectId(qid) ? mongoose.Types.ObjectId(qid) : qid;
      savedAnswers.push({
        questionId: qObjId,
        choiceIndex: (typeof yourIndex === 'number') ? yourIndex : null
      });
    }

    const total = answers.length;
    const percentage = Math.round((score / Math.max(1, total)) * 100);
    const passThreshold = 60;
    const passed = percentage >= passThreshold;

    // Persist: either update an existing attempt for this examId/user/org or create a new one.
    // Try to locate an existing attempt by examId OR by (user+organization+startedAt recent)
    let attemptFilter = {};
    if (examId) attemptFilter.examId = examId;
    else {
      // fallback: try user + org + module and recently created attempt
      attemptFilter = {
        userId: (req.user && req.user._id) ? req.user._id : undefined,
        organization: (exam && exam.org) ? exam.org : undefined,
        module: exam ? exam.module : (moduleKey || undefined)
      };
    }

    // Clean undefined keys
    Object.keys(attemptFilter).forEach(k => attemptFilter[k] === undefined && delete attemptFilter[k]);

    let attempt = null;
    try {
      if (Object.keys(attemptFilter).length) {
        attempt = await Attempt.findOne(attemptFilter).sort({ createdAt: -1 }).exec();
      }
    } catch (e) {
      console.error("[quiz/submit] attempt lookup error:", e && (e.stack || e));
    }

    const now = new Date();

    const attemptDoc = {
      examId: examId || ("exam-" + Date.now().toString(36)),
      userId: (req.user && req.user._id) ? req.user._id : (exam && exam.user) ? exam.user : null,
      organization: (exam && exam.org) ? exam.org : (typeof orgSlugOrId === 'string' ? orgSlugOrId : null),
      module: (exam && exam.module) ? exam.module : (moduleKey || null),
      questionIds: (exam && Array.isArray(exam.questionIds)) ? exam.questionIds : qIds.map(id => (mongoose.isValidObjectId(id) ? mongoose.Types.ObjectId(id) : id)),
      answers: savedAnswers,
      score,
      maxScore: total,
      passed: !!passed,
      status: "finished",
      startedAt: (exam && exam.createdAt) ? exam.createdAt : now,
      finishedAt: now,
      updatedAt: now,
      createdAt: attempt ? attempt.createdAt : now
    };

    if (attempt) {
      // update attempt
      try {
        await Attempt.updateOne({ _id: attempt._id }, { $set: attemptDoc }).exec();
      } catch (e) {
        console.error("[quiz/submit] attempt update failed:", e && (e.stack || e));
      }
    } else {
      // create new attempt doc
      try {
        await Attempt.create(attemptDoc);
      } catch (e) {
        console.error("[quiz/submit] attempt create failed:", e && (e.stack || e));
      }
    }

    // Respond with summary expected by frontend
    return res.json({
      examId: attemptDoc.examId,
      total,
      score,
      percentage,
      passThreshold,
      passed,
      details
    });
  } catch (err) {
    console.error("[POST /api/lms/quiz/submit] error:", err && (err.stack || err));
    return res.status(500).json({ error: "Failed to score quiz" });
  }
});


export default router;
