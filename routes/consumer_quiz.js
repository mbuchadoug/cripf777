// routes/consumer_quiz.js
import { Router } from "express";
import crypto from "crypto";
import mongoose from "mongoose";

import LearnerProfile from "../models/learnerProfile.js";
import Question from "../models/question.js";
import ExamInstance from "../models/examInstance.js";
import Attempt from "../models/attempt.js";
import { ensureAuth } from "../middleware/authGuard.js";

const router = Router();

/**
 * POST /consumer/quiz/start
 * body: { learnerProfileId, subject }
 */
router.post("/quiz/start", ensureAuth, async (req, res) => {
  try {
    const { learnerProfileId, subject } = req.body;

    if (!learnerProfileId || !subject) {
      return res.status(400).json({ error: "learnerProfileId and subject required" });
    }

    const learner = await LearnerProfile.findById(learnerProfileId);
    if (!learner) return res.status(404).json({ error: "Learner not found" });

    // 🔒 ownership check
    if (String(learner.parentUserId) !== String(req.user._id)) {
      return res.status(403).json({ error: "Not your learner" });
    }

    const key = subject.toLowerCase();

    // 🧪 trial limits
    const used = learner.trialCounters?.[key] || 0;
    if (used >= 3) {
      return res.status(403).json({
        error: "Trial exhausted",
        remaining: 0
      });
    }

    // 🎯 load questions
    const questions = await Question.aggregate([
      {
        $match: {
          module: key,
          schoolLevel: "junior",
          grade: learner.grade
        }
      },
      { $sample: { size: 10 } }
    ]);

    if (!questions.length) {
      return res.status(404).json({ error: "No questions available" });
    }

    const questionIds = [];
    const choicesOrder = [];

    for (const q of questions) {
      questionIds.push(String(q._id));

      const n = Array.isArray(q.choices) ? q.choices.length : 0;
      const order = Array.from({ length: n }, (_, i) => i);
      for (let i = order.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [order[i], order[j]] = [order[j], order[i]];
      }
      choicesOrder.push(order);
    }

    const examId = crypto.randomUUID();

    await ExamInstance.create({
      examId,
      learnerProfileId: learner._id,
      userId: req.user._id,        // parent owns attempt
      module: key,
      isOnboarding: false,
      targetRole: "student",
      questionIds,
      choicesOrder,
      durationMinutes: 15
    });

    return res.json({
      ok: true,
      examId,
      remainingTrials: 2 - used
    });
  } catch (err) {
    console.error("[consumer quiz start]", err);
    return res.status(500).json({ error: "Failed to start quiz" });
  }
});

export default router;
