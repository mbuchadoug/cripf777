// routes/lms_api.js
import { Router } from "express";
import mongoose from "mongoose";
import fs from "fs";
import path from "path";

import Organization from "../models/organization.js";
import Question from "../models/question.js";         // Question model (used throughout)
import ExamInstance from "../models/examInstance.js";
import Attempt from "../models/attempt.js";
import { ensureAuth } from "../middleware/authGuard.js";

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
 * create small ExamInstance that contains questionIds and (optionally) choicesOrder
 */
router.get("/quiz", async (req, res) => {
  try {
    const examId = String(req.query.examId || "").trim();
    if (!examId) return res.status(400).json({ error: "examId required" });

    const exam = await ExamInstance.findOne({ examId }).lean();
    if (!exam) return res.status(404).json({ error: "exam not found" });

    // optional: verify ownership or org membership here if needed

    // canonicalize questionIds array (strings)
    const rawIds = Array.isArray(exam.questionIds) ? exam.questionIds.map(String) : [];

    // Load all question docs that match any id in rawIds
    const qObjectIds = rawIds
      .filter(id => mongoose.isValidObjectId(id))
      .map(id => mongoose.Types.ObjectId(id));

    const questionDocs = qObjectIds.length
      ? await QuizQuestion.find({ _id: { $in: qObjectIds } }).lean()
      : [];

    const qById = {};
    for (const q of questionDocs) qById[String(q._id)] = q;

    // Find possible parent comprehension docs that reference any of these children
    // We'll look for parents whose questionIds intersect with the exam's rawIds.
    const parents = await QuizQuestion.find({
      type: "comprehension",
      questionIds: { $in: rawIds }
    }).lean();

    // Build child->parent map (if one child can belong to multiple parents this picks first parent found)
    const childToParent = {};
    const parentById = {};
    for (const p of parents) {
      parentById[String(p._id)] = p;
      const kids = Array.isArray(p.questionIds) ? p.questionIds.map(String) : [];
      for (const kid of kids) {
        if (!childToParent[kid]) childToParent[kid] = String(p._id);
      }
    }

    // Track parents we've emitted so we don't duplicate them
    const emittedParent = new Set();

    // Build the series preserving exam ordering. When we hit the first child of a parent,
    // and all the parent's child ids are present in the exam, we emit a comprehension block.
    const series = [];
    for (let i = 0; i < rawIds.length; i++) {
      const rid = String(rawIds[i]);

      const parentId = childToParent[rid];

      if (parentId && !emittedParent.has(parentId)) {
        const parentDoc = parentById[parentId];
        const parentChildIds = Array.isArray(parentDoc.questionIds) ? parentDoc.questionIds.map(String) : [];

        // ensure parent's children are present in this exam (simple subset check)
        const allPresent = parentChildIds.every(cid => rawIds.includes(cid));
        if (allPresent) {
          // Build children in parent's declared order, but use the exam's choicesOrder where available
          const children = [];
          for (const childId of parentChildIds) {
            const qDoc = qById[childId] || null;

            // find index in exam ordering so we can pick the right choicesOrder entry
            const examIndex = rawIds.indexOf(childId);
            const mapping = Array.isArray(exam.choicesOrder && exam.choicesOrder[examIndex])
              ? exam.choicesOrder[examIndex]
              : null;

            // Build shownChoices honoring mapping
            const shownChoices = [];
            if (qDoc && Array.isArray(qDoc.choices) && Array.isArray(mapping) && mapping.length) {
              for (let si = 0; si < mapping.length; si++) {
                const origIdx = mapping[si];
                const c = qDoc.choices[origIdx];
                shownChoices.push(typeof c === "string" ? { text: c } : { text: (c && (c.text || "")) });
              }
            } else if (qDoc && Array.isArray(qDoc.choices)) {
              for (const c of qDoc.choices) {
                shownChoices.push(typeof c === "string" ? { text: c } : { text: (c && (c.text || "")) });
              }
            }

            children.push({
              questionId: childId,
              text: qDoc ? qDoc.text : "(question missing)",
              choices: shownChoices
            });
          }

          series.push({
            type: "comprehension",
            questionId: `parent:${parentId}`,
            title: parentDoc.text || "",
            passage: parentDoc.passage || "",
            children
          });

          // mark emitted and skip over child's positions in the main loop
          emittedParent.add(parentId);

          // advance i to the last occurrence index of the last child in parentChildIds
          // (so outer loop continues after them)
          const lastChild = parentChildIds[parentChildIds.length - 1];
          const lastIndex = rawIds.lastIndexOf(lastChild);
          if (lastIndex > i) {
            i = lastIndex;
          }
          continue;
        }
      }

      // Normal (non-comprehension) question
      const qDoc = qById[rid] || null;
      const mapping = Array.isArray(exam.choicesOrder && exam.choicesOrder[i]) ? exam.choicesOrder[i] : null;

      const shownChoices = [];
      if (qDoc && Array.isArray(qDoc.choices) && Array.isArray(mapping) && mapping.length) {
        for (let si = 0; si < mapping.length; si++) {
          const origIdx = mapping[si];
          const c = qDoc.choices[origIdx];
          shownChoices.push(typeof c === "string" ? { text: c } : { text: (c && (c.text || "")) });
        }
      } else if (qDoc && Array.isArray(qDoc.choices)) {
        for (const c of qDoc.choices) {
          shownChoices.push(typeof c === "string" ? { text: c } : { text: (c && (c.text || "")) });
        }
      }

      series.push({
        questionId: qDoc ? String(qDoc._id) : rid,
        text: qDoc ? qDoc.text : "(question missing)",
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
