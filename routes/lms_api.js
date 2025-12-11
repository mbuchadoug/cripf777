// routes/lms_api.js
import { Router } from "express";
import mongoose from "mongoose";
import fs from "fs";
import path from "path";

import Organization from "../models/organization.js";
import Question from "../models/question.js";         // Question model (used throughout)
import ExamInstance from "../models/examInstance.js";
import Attempt from "../models/attempt.js";

const router = Router();

// fallback file loader
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
      choices: (d.choices || []).map((c) => (typeof c === "string" ? { text: c } : { text: c.text || c })),
      correctIndex:
        typeof d.correctIndex === "number"
          ? d.correctIndex
          : typeof d.answerIndex === "number"
          ? d.answerIndex
          : null,
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
 * If examId is supplied, return the exact ExamInstance ordering (with comprehension parents expanded to include children).
 * Otherwise sample up to `count` questions (module/org-aware).
 */
router.get("/quiz", ensureAuth, async (req, res) => {
  try {
    const examId = String(req.query.examId || "").trim();
    const orgSlug = String(req.query.org || "").trim();

    if (!examId) return res.status(400).json({ error: "examId required" });

    // find exam instance
    const exam = await ExamInstance.findOne({ examId }).lean();
    if (!exam) return res.status(404).json({ error: "exam not found" });

    // optional: verify org slug if provided
    if (orgSlug) {
      const org = await Organization.findOne({ slug: orgSlug }).lean();
      if (!org) return res.status(404).json({ error: "org not found" });
      if (String(exam.org) !== String(org._id)) {
        return res.status(403).json({ error: "exam not for this org" });
      }
    }

    // optionally check ownership or membership (you may relax this if you want admins to fetch)
    // if you want to restrict to exam owner only, uncomment:
    // if (String(exam.user) !== String(req.user._id)) return res.status(403).json({ error: "not exam owner" });

    // load referenced questions
    const qIds = Array.isArray(exam.questionIds) ? exam.questionIds.filter(Boolean) : [];

    // collect only real ObjectId question ids (skip 'parent:...' markers)
    const realIds = qIds
      .filter(id => typeof id === "string" && !id.startsWith("parent:"))
      .map(id => {
        try { return mongoose.Types.ObjectId(String(id)); } catch (e) { return null; }
      })
      .filter(Boolean);

    const questions = realIds.length ? await QuizQuestion.find({ _id: { $in: realIds } }).lean() : [];
    const qById = {};
    for (const q of questions) qById[String(q._id)] = q;

    // build series: for each entry in exam.questionIds
    const series = [];
    for (let i = 0; i < qIds.length; i++) {
      const rawId = String(qIds[i]);

      // handle parent marker: include a passage marker object
      if (rawId.startsWith("parent:")) {
        const parentId = rawId.replace(/^parent:/, "");
        // try to load parent doc (may be in same collection)
        const parentDoc = questions.find(q => String(q._id) === String(parentId)) || null;
        // if parent not in `questions` array (we only loaded realIds) try fetch it
        let parent = parentDoc;
        if (!parent) {
          try {
            parent = await QuizQuestion.findById(parentId).lean();
          } catch (e) { parent = null; }
        }

        if (parent) {
          // include a passage-type item that the client can detect (client already has logic for comprehension)
          series.push({
            questionId: `parent:${String(parent._id)}`,
            type: "passage",
            passage: parent.passage || parent.text || "",
            text: parent.text || "Passage",
            // children are not expanded here to keep payload small; LMS client handles parent marker by showing passage and expecting subsequent child items
            children: Array.isArray(parent.questionIds) ? parent.questionIds.map(String) : []
          });
        } else {
          // fallback marker (if parent missing)
          series.push({ questionId: rawId, type: "passage", passage: "(passage not found)", children: [] });
        }
        continue;
      }

      // normal question id
      const q = qById[rawId] || null;

      // exam.choicesOrder may exist: mapping array for question i
      const mapping = Array.isArray(exam.choicesOrder && exam.choicesOrder[i]) ? exam.choicesOrder[i] : null;

      const shownChoices = [];

      if (q && Array.isArray(q.choices) && mapping && mapping.length) {
        for (let si = 0; si < mapping.length; si++) {
          const originalIndex = mapping[si];
          const text = q.choices[originalIndex];
          shownChoices.push({ text: typeof text === "string" ? text : (text && (text.text || "")) || "" });
        }
      } else if (q && Array.isArray(q.choices)) {
        for (const c of q.choices) {
          shownChoices.push({ text: typeof c === "string" ? c : (c && (c.text || "")) || "" });
        }
      }

      series.push({
        questionId: rawId,
        text: q ? q.text : "(question missing)",
        choices: shownChoices
      });
    }

    return res.json({ examId: exam.examId, series, expiresAt: exam.expiresAt || null });
  } catch (err) {
    console.error("[GET /api/lms/quiz] error:", err && (err.stack || err));
    return res.status(500).json({ error: "failed to load exam" });
  }
});

/**
 * POST /api/lms/quiz/submit
 * Body: { examId, answers: [{ questionId, choiceIndex }] }
 *
 * This implementation:
 * - looks up DB question docs for ObjectId-like ids using Question model
 * - falls back to file-based questions for non-DB ids
 * - maps submitted shownIndex -> canonicalIndex using ExamInstance.choicesOrder (if available)
 */
router.post("/quiz/submit", async (req, res) => {
  try {
    const payload = req.body || {};
    const answers = Array.isArray(payload.answers) ? payload.answers : [];
    if (!answers.length) return res.status(400).json({ error: "No answers submitted" });

    const examId = String(payload.examId || "").trim() || null;
    const moduleKey = String(payload.module || "").trim() || null;
    const orgSlugOrId = payload.org || null;

    // map of question ids supplied
    const qIds = answers.map(a => a.questionId).filter(Boolean).map(String);

    // try to load ExamInstance (may be null)
    let exam = null;
    if (examId) {
      try {
        exam = await ExamInstance.findOne({ examId }).lean().exec();
      } catch (e) {
        console.error("[quiz/submit] exam lookup error:", e && (e.stack || e));
      }
    }

    // load DB questions for any ObjectId-like ids (use Question model)
    const byId = {};
    const dbIds = qIds.filter(id => mongoose.isValidObjectId(id));
    if (dbIds.length) {
      try {
        const qDocs = await Question.find({ _id: { $in: dbIds } }).lean().exec();
        for (const q of qDocs) byId[String(q._id)] = q;
      } catch (e) {
        console.error("[quiz/submit] DB lookup error:", e && (e.stack || e));
      }
    }

    // file fallback: include file questions by id (for fid-... items)
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

    // Build a quick lookup for exam question order & choicesOrder if exam exists
    const examIndexMap = {}; // questionId -> index in exam.questionIds
    const examChoicesOrder = Array.isArray(exam && exam.choicesOrder) ? exam.choicesOrder : [];

    if (exam && Array.isArray(exam.questionIds)) {
      for (let i = 0; i < exam.questionIds.length; i++) {
        const qidStr = String(exam.questionIds[i]);
        examIndexMap[qidStr] = i;
      }
    }

    // Scoring & saved answers
    let score = 0;
    const details = [];
    const savedAnswers = [];

    for (const a of answers) {
      const qid = String(a.questionId || "");
      const shownIndex = (typeof a.choiceIndex === "number") ? a.choiceIndex : null;

      let canonicalIndex = (typeof shownIndex === "number") ? shownIndex : null;

      // remap if exam instance has mapping for this question
      if (exam && examIndexMap.hasOwnProperty(qid)) {
        const qPos = examIndexMap[qid];
        const mapping = Array.isArray(examChoicesOrder[qPos]) ? examChoicesOrder[qPos] : null;
        if (mapping && typeof shownIndex === "number") {
          const mapped = mapping[shownIndex];
          if (typeof mapped === "number") canonicalIndex = mapped;
        }
      }

      const qdoc = byId[qid] || null;

      let correctIndex = null;
      if (qdoc) {
        if (typeof qdoc.correctIndex === "number") correctIndex = qdoc.correctIndex;
        else if (typeof qdoc.answerIndex === "number") correctIndex = qdoc.answerIndex;
        else if (typeof qdoc.correct === "number") correctIndex = qdoc.correct;
      }

      let selectedText = "";
      if (qdoc) {
        const choices = qdoc.choices || [];
        const tryChoice = (idx) => {
          if (idx === null || idx === undefined) return "";
          const c = choices[idx];
          if (!c) return "";
          return (typeof c === "string") ? c : (c.text || "");
        };
        selectedText = tryChoice(canonicalIndex);
      }

      const correct = (correctIndex !== null && canonicalIndex !== null && correctIndex === canonicalIndex);
      if (correct) score++;

      details.push({
        questionId: qid,
        correctIndex: (correctIndex !== null) ? correctIndex : null,
        yourIndex: canonicalIndex,
        correct: !!correct
      });

      const qObjId = mongoose.isValidObjectId(qid) ? mongoose.Types.ObjectId(qid) : qid;
      savedAnswers.push({
        questionId: qObjId,
        choiceIndex: (typeof canonicalIndex === "number") ? canonicalIndex : null,
        shownIndex: (typeof shownIndex === "number") ? shownIndex : null,
        selectedText,
        correctIndex: (typeof correctIndex === "number") ? correctIndex : null,
        correct: !!correct
      });
    }

    const total = answers.length;
    const percentage = Math.round((score / Math.max(1, total)) * 100);
    const passThreshold = parseInt(process.env.QUIZ_PASS_THRESHOLD || "60", 10);
    const passed = percentage >= passThreshold;

    // Find / update or create Attempt
    let attemptFilter = {};
    if (examId) attemptFilter.examId = examId;
    else {
      attemptFilter = {
        userId: (req.user && req.user._id) ? req.user._id : undefined,
        organization: (exam && exam.org) ? exam.org : undefined,
        module: exam ? exam.module : (moduleKey || undefined)
      };
    }
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

    let savedAttempt = null;
    if (attempt) {
      try {
        await Attempt.updateOne({ _id: attempt._id }, { $set: attemptDoc }).exec();
        savedAttempt = await Attempt.findById(attempt._id).lean().exec();
      } catch (e) {
        console.error("[quiz/submit] attempt update failed:", e && (e.stack || e));
      }
    } else {
      try {
        const newA = await Attempt.create(attemptDoc);
        savedAttempt = await Attempt.findById(newA._id).lean().exec();
      } catch (e) {
        console.error("[quiz/submit] attempt create failed:", e && (e.stack || e));
      }
    }

    // mark exam instance as used (optional)
    if (exam) {
      try {
        await ExamInstance.updateOne({ examId: exam.examId }, { $set: { updatedAt: now, expiresAt: now } }).exec();
      } catch (e) {
        console.error("[quiz/submit] failed to update examInstance:", e && (e.stack || e));
      }
    }

    return res.json({
      examId: attemptDoc.examId,
      total,
      score,
      percentage,
      passThreshold,
      passed,
      details,
      debug: {
        examFound: !!exam,
        attemptSaved: !!savedAttempt
      }
    });
  } catch (err) {
    console.error("[POST /api/lms/quiz/submit] error:", err && (err.stack || err));
    return res.status(500).json({ error: "Failed to score quiz", detail: String(err && err.message) });
  }
});

export default router;
