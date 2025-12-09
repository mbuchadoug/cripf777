// routes/admin_attempts.js
import { Router } from "express";
import mongoose from "mongoose";
import fs from "fs";
import path from "path";
import Organization from "../models/organization.js";
import Attempt from "../models/attempt.js";
import User from "../models/user.js";
import Question from "../models/question.js";
import { ensureAuth } from "../middleware/authGuard.js";

const router = Router();

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

// helper: load file fallback and return map by id/_id/uuid
function loadFileQuestionsMap() {
  const map = new Map();
  try {
    const p = path.join(process.cwd(), "data", "data_questions.json");
    if (!fs.existsSync(p)) return map;
    const raw = fs.readFileSync(p, "utf8");
    const arr = JSON.parse(raw);
    for (const q of arr || []) {
      const id = String(q.id || q._id || q.uuid || "");
      if (id) map.set(id, q);
    }
  } catch (e) {
    console.error("[loadFileQuestionsMap] error:", e && e.stack);
  }
  return map;
}

// List attempts for org
router.get("/admin/orgs/:slug/attempts", ensureAuth, ensureAdminEmails, async (req, res) => {
  try {
    const slug = String(req.params.slug || "");
    const org = await Organization.findOne({ slug }).lean();
    if (!org) return res.status(404).send("org not found");

    const attempts = await Attempt.find({ organization: org._id })
      .sort({ createdAt: -1 })
      .populate("userId", "name email")
      .lean();

    return res.render("admin/org_attempts", { org, attempts, user: req.user });
  } catch (err) {
    console.error("[admin attempts list] error:", err && err.stack);
    return res.status(500).send("failed");
  }
});

// View single attempt detail (with full review data)
router.get("/admin/orgs/:slug/attempts/:attemptId", ensureAuth, ensureAdminEmails, async (req, res) => {
  try {
    const slug = String(req.params.slug || "");
    const attemptId = String(req.params.attemptId || "");
    const org = await Organization.findOne({ slug }).lean();
    if (!org) return res.status(404).send("org not found");

    if (!mongoose.isValidObjectId(attemptId)) return res.status(400).send("invalid attempt id");

    const attempt = await Attempt.findById(attemptId).populate("userId", "name email").lean();
    if (!attempt) return res.status(404).send("attempt not found");

    // Build a map of answers submitted by questionId string -> answer object
    const submittedMap = new Map();
    (Array.isArray(attempt.answers) ? attempt.answers : []).forEach((a) => {
      const qid = a && a.questionId ? String(a.questionId) : null;
      if (qid) submittedMap.set(qid, {
        questionId: qid,
        choiceIndex: (typeof a.choiceIndex === "number") ? a.choiceIndex : null
      });
    });

    // Determine ordered list of question ids to show:
    // prefer attempt.questionIds (preserves order), else use keys from submitted answers
    let orderedQIds = [];
    if (Array.isArray(attempt.questionIds) && attempt.questionIds.length) {
      orderedQIds = attempt.questionIds.map(q => String(q));
    } else {
      orderedQIds = Array.from(submittedMap.keys());
    }

    // Prepare DB fetch list (only valid ObjectIds)
    const dbIds = orderedQIds.filter(id => mongoose.isValidObjectId(id));
    const byId = {}; // string id -> question doc or fallback

    if (dbIds.length) {
      try {
        const docs = await Question.find({ _id: { $in: dbIds } }).lean().exec();
        for (const q of docs) byId[String(q._id)] = q;
      } catch (e) {
        console.error("[admin attempt detail] question DB lookup error:", e && e.stack);
      }
    }

    // File fallback map
    const fileMap = loadFileQuestionsMap();
    for (const qid of orderedQIds) {
      if (!byId[qid]) {
        if (fileMap.has(qid)) {
          byId[qid] = fileMap.get(qid);
        }
      }
    }

    // Build review array: each item: { index, questionId, text, choices: [{text}], correctIndex, yourIndex, correct }
    const review = [];
    orderedQIds.forEach((qid, idx) => {
      const q = byId[qid] || null;

      // normalize choices
      let choices = [];
      if (q && Array.isArray(q.choices) && q.choices.length) {
        choices = q.choices.map((c) => {
          if (typeof c === "string") return { text: c };
          if (c && typeof c.text === "string") return { text: c.text };
          return { text: String(c || "") };
        });
      }

      // determine correct index from DB shape or file
      let correctIndex = null;
      if (q) {
        if (typeof q.correctIndex === "number") correctIndex = q.correctIndex;
        else if (typeof q.answerIndex === "number") correctIndex = q.answerIndex;
        else if (typeof q.correct === "number") correctIndex = q.correct;
        // if the stored correct answer is text, we could attempt to match, but keep it simple
      }

      const submitted = submittedMap.get(qid) || { choiceIndex: null };
      const yourIndex = (typeof submitted.choiceIndex === "number") ? submitted.choiceIndex : null;
      const isCorrect = (correctIndex !== null && yourIndex !== null && correctIndex === yourIndex);

      review.push({
        number: idx + 1,
        questionId: qid,
        text: q && (q.text || q.title) ? (q.text || q.title) : "(question text not available)",
        choices,
        correctIndex: correctIndex !== null ? correctIndex : null,
        yourIndex,
        correct: !!isCorrect,
      });
    });

    // Calculate basic score if available in attempt, else compute from review
    let score = typeof attempt.score === "number" ? attempt.score : review.reduce((acc, r) => acc + (r.correct ? 1 : 0), 0);
    let total = typeof attempt.maxScore === "number" ? attempt.maxScore : review.length;
    const percentage = Math.round((score / Math.max(1, total)) * 100);
    const passThreshold = parseInt(process.env.QUIZ_PASS_THRESHOLD || "60", 10);
    const passed = percentage >= passThreshold;

    return res.render("admin/org_attempt_detail", {
      org,
      attempt,
      user: attempt.userId,
      review,
      score,
      total,
      percentage,
      passThreshold,
      passed
    });
  } catch (err) {
    console.error("[admin attempt detail] error:", err && err.stack);
    return res.status(500).send("failed");
  }
});

export default router;
