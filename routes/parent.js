// routes/parent.js
import { Router } from "express";
import { ensureAuth } from "../middleware/authGuard.js";
import LearnerProfile from "../models/learnerProfile.js";
import ExamInstance from "../models/examInstance.js";
import crypto from "crypto";

const router = Router();

// 🔐 All parent routes require login
router.use(ensureAuth);

// ----------------------------------
// Parent dashboard
// GET /parent/dashboard
// ----------------------------------
router.get("/parent/dashboard", async (req, res) => {
  const learners = await LearnerProfile.find({
    ownerUserId: req.user._id
  }).lean();

  res.render("parent/dashboard", {
    user: req.user,
    learners
  });
});

// ----------------------------------
// Add learner form
// GET /parent/learners/new
// ----------------------------------
router.get("/parent/learners/new", (req, res) => {
  res.render("parent/new_learner", { user: req.user });
});

// ----------------------------------
// Create learner
// POST /parent/learners
// ----------------------------------
router.post("/parent/learners", async (req, res) => {
  const { displayName, schoolLevel, grade } = req.body;

  const learner = await LearnerProfile.create({
    ownerUserId: req.user._id,
    displayName,
    schoolLevel,
    grade,
    trialCounters: {}
  });

  res.redirect("/parent/dashboard");
});

// ----------------------------------
// Start trial quiz
// POST /parent/quiz/start
// ----------------------------------
router.post("/parent/quiz/start", async (req, res) => {
  const { learnerId, subject } = req.body;

  const learner = await LearnerProfile.findById(learnerId);
  if (!learner) return res.status(404).send("Learner not found");

  const used = learner.trialCounters?.[subject] || 0;
  if (used >= 3) {
    return res.status(403).send("Trial exhausted");
  }

  const examId = crypto.randomUUID();

  await ExamInstance.create({
    examId,
    userId: req.user._id,
    module: subject,
    isTrial: true,
    learnerProfileId: learner._id,
    createdAt: new Date()
  });

  learner.trialCounters[subject] = used + 1;
  await learner.save();

  res.redirect(`/lms/quiz?examId=${examId}`);
});

export default router;
