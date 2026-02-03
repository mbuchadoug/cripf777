// routes/parent_attempts.js
import { Router } from "express";
import mongoose from "mongoose";

import { ensureAuth } from "../middleware/authGuard.js";
import { canActAsParent } from "../middleware/parentAccess.js";

import Organization from "../models/organization.js";
import Attempt from "../models/attempt.js";
import User from "../models/user.js";
import Question from "../models/question.js";
import ExamInstance from "../models/examInstance.js";

const router = Router();

/**
 * Parent attempt review
 * URL: /org/:slug/my-attempts/:attemptId
 */
router.get(
  "/org/:slug/my-attempts/:attemptId",
  ensureAuth,
  async (req, res) => {

    try {
      const { slug, attemptId } = req.params;

      if (!mongoose.isValidObjectId(attemptId)) {
        return res.status(400).send("Invalid attempt id");
      }

      // Load org
      const org = await Organization.findOne({ slug }).lean();
      if (!org) return res.status(404).send("org not found");

      // Load attempt
      const attempt = await Attempt.findById(attemptId).lean();
      if (!attempt) return res.status(404).send("attempt not found");

      // 🔒 CRITICAL SECURITY CHECK
      // Attempt must belong to a child of this parent
    // 🔐 Ownership resolution (supports legacy home-learning attempts)

// Case 1: attempt belongs to a student child
let child = await User.findOne({
  _id: attempt.userId,
  parentUserId: req.user._id,
  role: "student"
}).lean();

// Case 2: legacy home-learning attempt saved against parent
if (!child && String(attempt.userId) === String(req.user._id)) {
  child = await User.findOne({
    parentUserId: req.user._id,
    role: "student"
  }).lean();
}

if (!child) {
  return res.status(403).send("Not allowed");
}

      // Load exam if needed (for fallback question order)
      let orderedQIds = Array.isArray(attempt.questionIds) && attempt.questionIds.length
        ? attempt.questionIds.map(String)
        : [];

      if (!orderedQIds.length && attempt.examId) {
        const exam = await ExamInstance.findOne({ examId: attempt.examId }).lean();
        if (exam?.questionIds?.length) {
          orderedQIds = exam.questionIds.map(String);
        }
      }

      // Build answer map
      const answerMap = {};
      if (Array.isArray(attempt.answers)) {
        for (const a of attempt.answers) {
          if (a?.questionId != null) {
            answerMap[String(a.questionId)] =
              typeof a.choiceIndex === "number" ? a.choiceIndex : null;
          }
        }
      }

      // Fetch questions
      const validIds = orderedQIds.filter(id => mongoose.isValidObjectId(id));
      const questions = validIds.length
        ? await Question.find({ _id: { $in: validIds } }).lean()
        : [];

      const qById = {};
      for (const q of questions) qById[String(q._id)] = q;

      // Build details EXACTLY like admin
      const details = [];
      for (let i = 0; i < orderedQIds.length; i++) {
        const qid = orderedQIds[i];
        const qdoc = qById[qid] || null;

        let correctIndex = null;
        if (qdoc) {
          if (typeof qdoc.correctIndex === "number") correctIndex = qdoc.correctIndex;
          else if (typeof qdoc.answerIndex === "number") correctIndex = qdoc.answerIndex;
          else if (typeof qdoc.correct === "number") correctIndex = qdoc.correct;
        }

        const yourIndex = Object.prototype.hasOwnProperty.call(answerMap, qid)
          ? answerMap[qid]
          : null;

        const correct =
          correctIndex !== null &&
          yourIndex !== null &&
          correctIndex === yourIndex;

        const choices = qdoc?.choices
          ? qdoc.choices.map(c =>
              typeof c === "string" ? { text: c } : { text: c?.text || "" }
            )
          : [];

        details.push({
          qIndex: i + 1,
          questionId: qid,
          questionText: qdoc ? qdoc.text : "(question not in DB)",
          choices,
          yourIndex,
          correctIndex,
          correct
        });
      }

      // 🔁 REUSE ADMIN VIEW
  return res.render("parent/org_attempt_detail", {
    org,
    attempt,
    details,
    user: child
});

    } catch (err) {
      console.error("[parent attempt review] error:", err);
      return res.status(500).send("failed");
    }
  }
);

export default router;
