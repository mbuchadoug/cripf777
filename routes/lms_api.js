// routes/lms_api.js
import { Router } from "express";
import mongoose from "mongoose";
import Question from "../models/question.js";
import Organization from "../models/organization.js";
import ExamInstance from "../models/examInstance.js";
import Attempt from "../models/attempt.js";
import fs from "fs";
import path from "path";
import crypto from "crypto";

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
 *
 * - returns { examId, series }
 * - persists an ExamInstance (org quizzes) and a starter Attempt record so admin can later view attempts
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
      // case-insensitive match on module
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
    if (docs && docs.length) {
      series = docs.map((d) => ({
        id: String(d._id),
        text: d.text,
        choices: (d.choices || []).map((c) => ({ text: c.text || c })),
        tags: d.tags || [],
        difficulty: d.difficulty || "medium",
      }));
    } else {
      // fallback to static file
      series = fetchRandomQuestionsFromFile(count);
    }

    // Create an examId
    const examId = "exam-" + crypto.randomBytes(8).toString("hex");

    // Persist an ExamInstance for org quizzes (helps mapping when submit occurs)
    try {
      const qIds = series
        .map(s => {
          // if id looks like an ObjectId, keep it; otherwise leave null.
          return mongoose.isValidObjectId(s.id) ? mongoose.Types.ObjectId(s.id) : null;
        })
        .filter(Boolean);

      // For org quizzes, create an ExamInstance so we can enforce ownership/expiry later
      if (orgId) {
        await ExamInstance.create({
          examId,
          org: orgId,
          module: moduleKey || "general",
          user: (req.user && req.user._id) || undefined,
          questionIds: qIds,
          choicesOrder: [], // left empty for now - you may fill with randomized mapping later
          expiresAt: new Date(Date.now() + 1000 * 60 * 60), // 1 hour default
          createdByIp: req.ip,
        });
      }

      // always create a starter Attempt record (useful for recording progress and for admin view)
      await Attempt.create({
        userId: (req.user && req.user._id) || undefined,
        organization: orgId || undefined,
        module: moduleKey || "general",
        questionIds: qIds,
        answers: [], // fill on submit
        startedAt: new Date(),
        maxScore: qIds.length || series.length,
      });
    } catch (e) {
      // log but don't block client — fallback behavior still works
      console.warn("[/api/lms/quiz] failed to persist exam/attempt starter:", e && e.stack);
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
 *
 * - If examId maps to an ExamInstance, we use that to map question order and update Attempt linked to this user/org
 * - Otherwise fall back to legacy scoring (lookup questions in DB or static file)
 */
router.post("/quiz/submit", async (req, res) => {
  try {
    const payload = req.body || {};
    const answers = Array.isArray(payload.answers) ? payload.answers : [];
    if (!answers.length) return res.status(400).json({ error: "No answers submitted" });

    const examId = payload.examId || null;

    // Try find exam instance if examId provided
    let exam = null;
    if (examId) {
      try {
        exam = await ExamInstance.findOne({ examId }).lean();
      } catch (e) {
        console.warn("[quiz/submit] ExamInstance lookup failed:", e && e.stack);
      }
    }

    // Build a question lookup (by DB id or fallback file)
    const qIds = answers.map(a => String(a.questionId)).filter(Boolean);
    const dbIds = qIds.filter(id => mongoose.isValidObjectId(id));

    const byId = {};
    if (dbIds.length) {
      try {
        const docs = await Question.find({ _id: { $in: dbIds } }).lean().exec();
        for (const q of docs) byId[String(q._id)] = q;
      } catch (e) {
        console.error("[quiz/submit] DB lookup error:", e && (e.stack || e));
      }
    }

    // file fallback for any missing questions
    try {
      const missing = qIds.filter(id => !byId[id]);
      if (missing.length) {
        const p = path.join(process.cwd(), "data", "data_questions.json");
        if (fs.existsSync(p)) {
          const fileQuestions = JSON.parse(fs.readFileSync(p, "utf8"));
          for (const fq of fileQuestions) {
            const fid = String(fq.id || fq._id || fq.uuid);
            if (fid && !byId[fid]) byId[fid] = fq;
          }
        }
      }
    } catch (e) {
      console.error("[quiz/submit] file fallback error:", e && (e.stack || e));
    }

    // if we have an exam instance that provides questionIds ordering, prefer that
    const examQIds = Array.isArray(exam && exam.questionIds) ? exam.questionIds.map(String) : null;

    // score
    let score = 0;
    const details = [];

    // helper to pull correctIndex from a question document (DB or file)
    function getCorrectIndex(q) {
      if (!q) return null;
      if (typeof q.correctIndex === "number") return q.correctIndex;
      if (typeof q.answerIndex === "number") return q.answerIndex;
      if (typeof q.correct === "number") return q.correct;
      return null;
    }

    // Process used question list: if examQIds exists, iterate that to preserve order and mapping.
    if (examQIds && examQIds.length) {
      for (let i = 0; i < examQIds.length; i++) {
        const qid = examQIds[i];
        const q = byId[qid] || null;
        const given = answers.find(a => String(a.questionId) === qid);
        const yourIndex = (given && Number.isFinite(Number(given.choiceIndex))) ? Number(given.choiceIndex) : null;

        const correctIndex = getCorrectIndex(q);
        const isCorrect = (correctIndex !== null && yourIndex !== null && correctIndex === yourIndex);
        if (isCorrect) score++;

        details.push({
          questionId: qid,
          questionText: q ? q.text : null,
          correctIndex: correctIndex !== null ? correctIndex : null,
          yourIndex,
          correct: !!isCorrect
        });
      }
    } else {
      // No exam instance: iterate answers array as provided
      for (const a of answers) {
        const qid = String(a.questionId);
        const q = byId[qid] || null;
        const yourIndex = (typeof a.choiceIndex === "number") ? a.choiceIndex : null;
        const correctIndex = getCorrectIndex(q);
        const isCorrect = (correctIndex !== null && yourIndex !== null && correctIndex === yourIndex);
        if (isCorrect) score++;

        details.push({
          questionId: qid,
          questionText: q ? q.text : null,
          correctIndex: correctIndex !== null ? correctIndex : null,
          yourIndex,
          correct: !!isCorrect
        });
      }
    }

    const total = Math.max(1, details.length);
    const percentage = Math.round((score / Math.max(1, total)) * 100);
    const passThreshold = Number(process.env.QUIZ_PASS_THRESHOLD || 60);
    const passed = percentage >= passThreshold;

    // Persist results to an Attempt record (try to update latest attempt for this user/org/module)
    try {
      // find a recent attempt for this user/org/module (if user available)
      const filter = {};
      if (req.user && req.user._id) filter.userId = req.user._id;
      if (exam && exam.org) filter.organization = exam.org;
      if (exam && exam.module) filter.module = exam.module;

      // if no user (anonymous), attempt to match by startedAt window and module/org may be omitted
      const update = {
        $set: {
          finishedAt: new Date(),
          score,
          maxScore: total,
          passed,
          answers: details.map(d => ({
            questionId: mongoose.isValidObjectId(d.questionId) ? mongoose.Types.ObjectId(d.questionId) : d.questionId,
            choiceIndex: d.yourIndex,
            correctIndex: d.correctIndex,
            correct: d.correct
          }))
        }
      };

      // try to update most recent Attempt matching the filter and not finished
      const attempt = await Attempt.findOneAndUpdate(
        Object.assign({}, filter, { finishedAt: { $exists: false } }),
        update,
        { sort: { createdAt: -1 }, new: true }
      );

      // If we didn't find an open attempt, create a new one
      if (!attempt) {
        await Attempt.create({
          userId: (req.user && req.user._id) || undefined,
          organization: (exam && exam.org) || undefined,
          module: (exam && exam.module) || undefined,
          questionIds: (examQIds && examQIds.map(id => (mongoose.isValidObjectId(id) ? mongoose.Types.ObjectId(id) : id))) || (qIds.filter(id => mongoose.isValidObjectId(id)).map(id => mongoose.Types.ObjectId(id))),
          answers: update.$set.answers.map(a => ({ questionId: a.questionId, choiceIndex: a.choiceIndex })),
          score,
          maxScore: total,
          passed,
          startedAt: new Date(), // we didn't have startedAt — set to now
          finishedAt: new Date()
        });
      }
    } catch (e) {
      console.warn("[quiz/submit] failed to persist attempt result:", e && e.stack);
    }

    // If this exam maps to an ExamInstance, optionally mark it finished or remove it (don't delete, just leave)
    // You might want to set a finishedAt or mark exam as used — left intentionally simple here.

    return res.json({
      examId: examId || ("exam-" + Date.now().toString(36)),
      total,
      score,
      percentage,
      passThreshold,
      passed,
      details,
    });
  } catch (err) {
    console.error("[POST /api/lms/quiz/submit] error:", err && (err.stack || err));
    return res.status(500).json({ error: "Failed to score quiz" });
  }
});

export default router;
