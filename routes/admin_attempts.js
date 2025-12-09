// routes/admin_attempts.js — updated attempt detail viewer
import { Router } from "express";
import mongoose from "mongoose";
import fs from "fs";
import path from "path";
import Organization from "../models/organization.js";
import Attempt from "../models/attempt.js";
import ExamInstance from "../models/examInstance.js";
import Question from "../models/question.js";
import { ensureAuth } from "../middleware/authGuard.js";

function getAdminSet() {
  return new Set(
    (process.env.ADMIN_EMAILS || "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  );
}
function ensureAdminEmails(req, res, next) {
  const adminEmails = Array.from(getAdminSet());
  if (!req.user || !req.user.email) return res.status(403).send("Admins only");
  if (!adminEmails.includes(req.user.email.toLowerCase())) return res.status(403).send("Admins only");
  next();
}

const router = Router();

router.get("/admin/orgs/:slug/attempts/:attemptId", ensureAuth, ensureAdminEmails, async (req, res) => {
  try {
    const slug = String(req.params.slug || "");
    const attemptId = String(req.params.attemptId || "");
    const org = await Organization.findOne({ slug }).lean();
    if (!org) return res.status(404).send("org not found");

    if (!mongoose.isValidObjectId(attemptId)) return res.status(400).send("invalid attempt id");

    // load attempt
    const attempt = await Attempt.findById(attemptId).lean();
    if (!attempt) return res.status(404).send("attempt not found");

    // Prefer question IDs stored on the attempt; if not present try ExamInstance
    let qIdList = Array.isArray(attempt.questionIds) ? attempt.questionIds.map(String) : [];

    if ((!qIdList || qIdList.length === 0) && attempt.examId) {
      // try to find exam instance for fallback
      const exam = await ExamInstance.findOne({ examId: attempt.examId }).lean().catch(() => null);
      if (exam && Array.isArray(exam.questionIds)) qIdList = exam.questionIds.map(String);
    }

    // try to load question docs from DB for any ObjectIds
    const byId = {};
    if (qIdList && qIdList.length) {
      const dbIds = qIdList.filter(id => mongoose.isValidObjectId(id)).map(id => mongoose.Types.ObjectId(id));
      if (dbIds.length) {
        const qDocs = await Question.find({ _id: { $in: dbIds } }).lean().exec();
        for (const q of qDocs) byId[String(q._id)] = q;
      }
    }

    // fallback to file data_questions.json if some questions not found in DB
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
      console.error("[admin attempts] file fallback error:", e && (e.stack || e));
    }

    // Build QA array in the original question order (qIdList)
    const answersArray = Array.isArray(attempt.answers) ? attempt.answers : [];
    const answerMap = {};
    for (const a of answersArray) {
      const qid = String(a.questionId || "");
      answerMap[qid] = a; // last one wins if duplicates
    }

    // For display: an ordered list of { index, questionId, text, choices, correctIndex, yourIndex, yourText, correct }
    const qa = [];
    for (let i = 0; i < qIdList.length; i++) {
      const qid = String(qIdList[i] || "");
      const q = byId[qid] || null;

      // canonicalize choices array: DB may store [{text}] or ["A", "B"]
      let choices = [];
      let correctIndex = null;
      let qText = "(question text unavailable)";
      if (q) {
        qText = q.text || q.title || q.question || qText;
        if (Array.isArray(q.choices)) {
          choices = q.choices.map(c => (typeof c === "string" ? { text: c } : { text: c.text || "" }));
        }
        // try multiple correct fields
        if (typeof q.correctIndex === "number") correctIndex = q.correctIndex;
        else if (typeof q.answerIndex === "number") correctIndex = q.answerIndex;
        else if (typeof q.correct === "number") correctIndex = q.correct;
      }

      const stored = answerMap[qid] || {}; // may be undefined if answers not persisted
      const yourIndex = (typeof stored.choiceIndex === "number") ? stored.choiceIndex : null;
      const yourText = (yourIndex !== null && Array.isArray(choices) && choices[yourIndex]) ? choices[yourIndex].text : null;
      const isCorrect = (correctIndex !== null && yourIndex !== null && correctIndex === yourIndex);

      qa.push({
        index: i + 1,
        questionId: qid,
        text: qText,
        choices,
        correctIndex: correctIndex !== null ? correctIndex : null,
        yourIndex,
        yourText,
        correct: !!isCorrect
      });
    }

    // render template with attempt, qa list, and user
    return res.render("admin/org_attempt_detail", {
      org,
      attempt,
      answers: answersArray,
      qa,
      user: attempt.userId
    });
  } catch (err) {
    console.error("[admin attempt detail] error:", err && err.stack);
    return res.status(500).send("failed");
  }
});

export default router;
