// routes/api_lms.js
import { Router } from "express";
import mongoose from "mongoose";
import QuizQuestion from "../models/quizQuestion.js";
import fs from "fs";
import path from "path";

const router = Router();

/**
 * Fetch random questions from DB, optionally filtered by module (case-insensitive).
 */
async function fetchRandomQuestionsFromDB(count = 20, moduleName = "") {
  try {
    const match = {};
    if (moduleName) {
      match.module = { $regex: new RegExp(`^${moduleName}$`, "i") };
    }

    const pipeline = [];
    if (Object.keys(match).length) pipeline.push({ $match: match });
    pipeline.push({ $sample: { size: Number(count) } });

    const docs = await QuizQuestion.aggregate(pipeline).allowDiskUse(true);

    return docs.map((d) => ({
      id: String(d._id),
      text: d.text,
      choices: (d.choices || []).map((c) => ({ text: c.text })),
      correctIndex:
        typeof d.answerIndex === "number"
          ? d.answerIndex
          : typeof d.correctIndex === "number"
          ? d.correctIndex
          : null,
      tags: d.tags || [],
      difficulty: d.difficulty || "medium",
    }));
  } catch (err) {
    console.error("[fetchRandomQuestionsFromDB] error:", err && (err.stack || err));
    return null;
  }
}

// fallback: load static file data/data_questions.json if DB missing (dev only)
function fetchRandomQuestionsFromFile(count = 5) {
  try {
    const p = path.join(process.cwd(), "data", "data_questions.json");
    if (!fs.existsSync(p)) return [];
    const raw = fs.readFileSync(p, "utf8");
    const all = JSON.parse(raw);

    // shuffle
    for (let i = all.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [all[i], all[j]] = [all[j], all[i]];
    }

    return all.slice(0, count).map((d) => ({
      id:
        d.id ||
        d._id ||
        d.uuid ||
        "fid-" + Math.random().toString(36).slice(2, 9),
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
 * GET /api/lms/quiz?count=20&module=Responsibility
 * - for /lms/quiz -> count=5, no module (global)
 * - for /lms/quiz?module=Responsibility&org=muono -> count=20, module filter
 */
router.get("/quiz", async (req, res) => {
  let rawCount = parseInt(req.query.count || "20", 10);
  if (!Number.isFinite(rawCount)) rawCount = 20;
  const count = Math.max(1, Math.min(20, rawCount));

  const moduleName = String(req.query.module || "").trim();

  try {
    const dbResult = await fetchRandomQuestionsFromDB(count, moduleName);
    let series = [];
    if (dbResult && dbResult.length >= 1) {
      series = dbResult;
    } else {
      series = fetchRandomQuestionsFromFile(count);
    }

    const publicSeries = series.map((q) => ({
      id: q.id,
      text: q.text,
      choices: q.choices.map((c) => ({ text: c.text })),
      tags: q.tags || [],
      difficulty: q.difficulty || "medium",
    }));

    const examId = "exam-" + Date.now().toString(36);
    return res.json({ examId, series: publicSeries });
  } catch (err) {
    console.error("[GET /api/lms/quiz] error:", err && (err.stack || err));
    return res.status(500).json({ error: "Failed to fetch quiz" });
  }
});

/**
 * POST /api/lms/quiz/submit
 * Body: { examId, answers: [{ questionId, choiceIndex }] }
 */
router.post("/quiz/submit", async (req, res) => {
  try {
    const payload = req.body || {};
    const answers = Array.isArray(payload.answers) ? payload.answers : [];
    if (!answers.length) {
      return res.status(400).json({ error: "No answers provided" });
    }

    const qIds = answers
      .map((a) => a.questionId)
      .filter(Boolean)
      .map(String);
    const validDbIds = qIds.filter((id) => mongoose.isValidObjectId(id));
    const byId = {};

    if (validDbIds.length) {
      try {
        const docs = await QuizQuestion.find({
          _id: { $in: validDbIds },
        })
          .lean()
          .exec();
        for (const d of docs) byId[String(d._id)] = d;
      } catch (e) {
        console.error("[quiz/submit] DB lookup failed:", e && (e.stack || e));
      }
    }

    let score = 0;
    const details = [];

    for (const a of answers) {
      const qid = String(a.questionId || "");
      const yourIndex =
        typeof a.choiceIndex === "number" ? a.choiceIndex : null;
      const q = byId[qid];

      let correctIndex = null;
      if (q) {
        if (typeof q.answerIndex === "number") correctIndex = q.answerIndex;
        else if (typeof q.correctIndex === "number") correctIndex = q.correctIndex;
        else if (typeof q.correct === "number") correctIndex = q.correct;
      }

      const correct =
        correctIndex !== null &&
        yourIndex !== null &&
        correctIndex === yourIndex;

      if (correct) score++;
      details.push({
        questionId: qid,
        correctIndex: correctIndex !== null ? correctIndex : null,
        yourIndex,
        correct: !!correct,
      });
    }

    const total = answers.length;
    const percentage = Math.round((score / Math.max(1, total)) * 100);
    const passThreshold = parseInt(
      process.env.QUIZ_PASS_THRESHOLD || "60",
      10
    );
    const passed = percentage >= passThreshold;

    return res.json({
      examId: payload.examId || "exam-" + Date.now().toString(36),
      score,
      total,
      percentage,
      passThreshold,
      passed,
      details,
    });
  } catch (err) {
    console.error(
      "[api_lms] /quiz/submit unexpected error:",
      err && (err.stack || err)
    );
    return res.status(500).json({
      error: "Submit failed",
      detail: String(err && (err.stack || err.message || err)),
    });
  }
});

export default router;
