// routes/parent.js
import { Router } from "express";
import { ensureAuth } from "../middleware/authGuard.js";
import LearnerProfile from "../models/learnerProfile.js";
import ExamInstance from "../models/examInstance.js";
import crypto from "crypto";
import mongoose from "mongoose";

import Question from "../models/question.js";

const router = Router();




async function assignTrialQuizzesToLearner({ learnerProfileId, parentUserId }) {
  const ORG_ID = mongoose.Types.ObjectId("693b3d8d8004ece0477340c7");
  const assignmentId = crypto.randomUUID();

  const QUIZ_TEXT = "CRIPFCnt Mathematics Test 4 - Primary Level";

  const questions = await Question.find({
    organization: ORG_ID,
    text: QUIZ_TEXT
  }).lean();

  if (!questions.length) return;

  await ExamInstance.create({
    examId: crypto.randomUUID(),
    assignmentId,
    org: ORG_ID,
    learnerProfileId,
    userId: parentUserId,
    targetRole: "student",
    module: "trial",
    title: QUIZ_TEXT,
    isOnboarding: false,
    questionIds: questions.map(q => String(q._id)),
    choicesOrder: questions.map(q =>
      Array.from({ length: q.choices.length }, (_, i) => i)
    ),
    createdAt: new Date()
  });
}

// 🔐 All parent routes require login
router.use(ensureAuth);

// ----------------------------------
// Parent dashboard
// GET /parent/dashboard
// ----------------------------------
router.get("/parent/dashboard", async (req, res) => {
const learners = await LearnerProfile.find({
  parentUserId: req.user._id
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
  parentUserId: req.user._id,
  displayName,
  schoolLevel,
  grade,
  trialCounters: {}
});

// 🔥 AUTO-ASSIGN 2 TRIAL QUIZZES
await assignTrialQuizzesToLearner({
  learnerProfileId: learner._id,
  parentUserId: req.user._id
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
  learnerProfileId: learner._id,
  module: subject,
  title: "Trial Quiz",
  targetRole: "student", // ✅ REQUIRED
  isOnboarding: false,
  createdAt: new Date()
});


  learner.trialCounters[subject] = used + 1;
  await learner.save();

  res.redirect(`/lms/quiz?examId=${examId}`);
});

export default router;
