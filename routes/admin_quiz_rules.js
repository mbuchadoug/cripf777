import { Router } from "express";
import { ensureAuth } from "../middleware/authGuard.js";
import Organization from "../models/organization.js";
import QuizRule from "../models/quizRule.js";
import Question from "../models/question.js";
import User from "../models/user.js";
import ExamInstance from "../models/examInstance.js";

const router = Router();

// ----------------------------------
// VIEW QUIZ RULES (HOME SCHOOL ONLY)
// GET /admin/orgs/:slug/quiz-rules
// ----------------------------------
// ----------------------------------
// 🔐 Platform admin email guard
// ----------------------------------
function ensureAdminEmails(req, res, next) {
  const adminSet = new Set(
    (process.env.ADMIN_EMAILS || "")
      .split(",")
      .map(e => e.trim().toLowerCase())
      .filter(Boolean)
  );

  const email = String(req.user?.email || "").toLowerCase();

  if (!adminSet.has(email)) {
    return res.status(403).send("Admins only");
  }

  next();
}

router.get(
  "/admin/orgs/:slug/quiz-rules",
  ensureAuth,
  async (req, res) => {
    const org = await Organization.findOne({ slug: req.params.slug }).lean();
    if (!org) return res.status(404).send("Org not found");

    // 🔒 HARD LOCK
    if (org.slug !== "cripfcnt-home") {
      return res.status(403).send("Not allowed");
    }

    const rules = await QuizRule.find({ org: org._id }).lean();
const quizzes = await Question.find({
  type: "comprehension",
  $or: [
    { organization: org._id },
    { organization: { $exists: false } },
    { organization: null }
  ]
})
  .select("_id text module")
  .lean();


res.render("admin/quiz_rules", {
  org,
  rules,
  quizzes,
  user: req.user
});

  }
);

// ----------------------------------
// CREATE QUIZ RULE (HOME SCHOOL ONLY)
// POST /admin/orgs/:slug/quiz-rules
// ----------------------------------
router.post(
  "/admin/orgs/:slug/quiz-rules",
  ensureAuth,
  ensureAdminEmails,
  async (req, res) => {
    try {
      const slug = req.params.slug;
      const org = await Organization.findOne({ slug });
      if (!org) return res.status(404).send("Org not found");
const {
  grade,
  subject,
  module,
  quizQuestionId,
  quizType,
  questionCount,
  durationMinutes
} = req.body;


if (!grade || !subject || !quizQuestionId || !quizType) {
  return res.status(400).send("Missing fields");
}

const quiz = await Question.findById(quizQuestionId).lean();
if (!quiz) {
  return res.status(400).send("Invalid quiz selected");
}


  await QuizRule.create({
  org: org._id,
  grade: Number(grade),
  subject: subject.toLowerCase(),   // 👈 KEY
  module: module?.toLowerCase(),

  quizQuestionId: quiz._id,
  quizTitle: quiz.text,

  quizType,
  questionCount: Number(questionCount) || 10,
  durationMinutes: Number(durationMinutes) || 30,

  enabled: true
});


const students = await User.find({
  organization: org._id,
  role: "student",
  grade: Number(grade)
});

for (const student of students) {
  const exists = await ExamInstance.findOne({
    user: student._id,
    organization: org._id,
    question: quiz._id,
    source: "quiz-rule"
  });

  if (exists) continue; // 👈 prevents duplicates

  await ExamInstance.create({
    user: student._id,
    organization: org._id,
    question: quiz._id,
    module: quiz.module,
    subject: subject.toLowerCase(),
    type: quizType,
    count: Number(questionCount) || 10,
    durationMinutes: Number(durationMinutes) || 30,
    source: "quiz-rule"
  });
}




      res.redirect(`/admin/orgs/${slug}/manage`);
    } catch (err) {
      console.error("[quiz rule create]", err);
      res.status(500).send("Failed");
    }
  }
);






export default router;
