// routes/parent.js
import { Router } from "express";
import { ensureAuth } from "../middleware/authGuard.js";
import LearnerProfile from "../models/learnerProfile.js";
import ExamInstance from "../models/examInstance.js";
import crypto from "crypto";
import mongoose from "mongoose";
import { assignQuizzesForLearner } from "../services/quizAssignmentService.js";

import Question from "../models/question.js";

const router = Router();




async function assignTrialQuizzesToLearner({ learnerProfileId, parentUserId }) {
  const ORG_ID = mongoose.Types.ObjectId("693b3d8d8004ece0477340c7");
  const assignmentId = crypto.randomUUID();

  const QUIZ_TEXT = "CRIPFCnt Mathematics Test 4 - Primary Level";
// ✅ Load the comprehension parent (NOT the children directly)
const parent = await Question.findOne({
  organization: ORG_ID,
  text: QUIZ_TEXT,
  type: "comprehension"
}).lean();

if (!parent || !Array.isArray(parent.questionIds) || !parent.questionIds.length) {
  console.error("❌ Comprehension parent or children missing for:", QUIZ_TEXT);
  return;
}

// ✅ Create exam using parent marker + child IDs
await ExamInstance.create({
  examId: crypto.randomUUID(),
  assignmentId,
  org: ORG_ID,
  learnerProfileId,
  userId: parentUserId,
  targetRole: "student",
  module: "math",
  title: QUIZ_TEXT,
  isOnboarding: false,

  // 🔥 THIS IS THE CRITICAL FIX
  questionIds: [
    `parent:${parent._id}`,
    ...parent.questionIds.map(id => String(id))
  ],

  // children order handled by LMS
  choicesOrder: parent.questionIds.map(() => null),

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

for (const learner of learners) {
  learner.quizzes = await ExamInstance.find({
    learnerProfileId: learner._id
  })
    .select("title module status examId")
    .lean();
}



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
await assignQuizzesForLearner({
  learnerProfile: learner,
  parentUserId: req.user._id,
  type: "trial"
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

 // ✅ Find the pre-assigned trial exam
const exam = await ExamInstance.findOne({
  learnerProfileId: learner._id,
  module: "math",
  title: "CRIPFCnt Mathematics Test 4 - Primary Level"
}).sort({ createdAt: -1 });

if (!exam) {
  return res.status(404).send("Trial quiz not found");
}

learner.trialCounters[subject] = used + 1;
await learner.save();

return res.redirect(`/lms/quiz?examId=${exam.examId}`);



  learner.trialCounters[subject] = used + 1;
  await learner.save();

  res.redirect(`/lms/quiz?examId=${examId}`);
});

export default router;
