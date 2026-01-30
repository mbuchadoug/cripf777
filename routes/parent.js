import { Router } from "express";
import mongoose from "mongoose";
import crypto from "crypto";

import { ensureAuth } from "../middleware/authGuard.js";
import User from "../models/user.js";
import OrgMembership from "../models/orgMembership.js";
import Organization from "../models/organization.js";
import ExamInstance from "../models/examInstance.js";

const router = Router();

// 🔒 Hard-lock HOME org
const HOME_ORG_SLUG = "cripfcnt-home";

// ----------------------------------
// Parent dashboard
// GET /parent/dashboard
// ----------------------------------
router.get("/parent/dashboard", ensureAuth, async (req, res) => {
  if (req.user.role !== "parent") {
    return res.status(403).send("Parents only");
  }

  const children = await User.find({
    parentUserId: req.user._id,
    role: "student"
  }).lean();

  res.render("parent/dashboard", {
    user: req.user,
    children
  });
});

// ----------------------------------
// Add child form
// GET /parent/children/new
// ----------------------------------
router.get("/parent/children/new", ensureAuth, (req, res) => {
  res.render("parent/new_child", { user: req.user });
});

// ----------------------------------
// Create child + auto-assign trials
// POST /parent/children
// ----------------------------------
router.post("/parent/children", ensureAuth, async (req, res) => {
  const { firstName, lastName, grade } = req.body;

  if (!firstName || !grade) {
    return res.status(400).send("Name and grade required");
  }

  const org = await Organization.findOne({ slug: HOME_ORG_SLUG });
  if (!org) return res.status(500).send("Home org missing");

  // 1️⃣ Create child user
  const child = await User.create({
    firstName,
    lastName,
    role: "student",
    grade: Number(grade),
    parentUserId: req.user._id,
    organization: org._id,
    accountType: "student_self"
  });

  // 2️⃣ Create org membership


  // 3️⃣ AUTO ASSIGN TRIAL QUIZZES (by grade)
  await assignTrialQuizzes({
    orgId: org._id,
    grade: child.grade,
    userId: child._id
  });

  res.redirect("/parent/dashboard");
});


// ----------------------------------
// AUTO-ASSIGN TRIAL QUIZZES
// ----------------------------------
import QuizRule from "../models/quizRule.js";
import Question from "../models/question.js";

async function assignTrialQuizzes({ orgId, grade, userId }) {

  const existing = await ExamInstance.countDocuments({
    org: orgId,
    userId,
    isTrial: true
  });
  if (existing > 0) return;

  const rules = await QuizRule.find({
    org: orgId,
    grade,
    isTrial: true,
    enabled: true
  }).lean();

  if (!rules.length) return;

  const assignmentId = crypto.randomUUID();

  for (const rule of rules) {

    const questions = await Question.aggregate([
      {
        $match: {
          organization: orgId,
          module: rule.subject,
          grade
        }
      },
      { $sample: { size: rule.questionCount } }
    ]);

    if (!questions.length) continue;

    await ExamInstance.create({
      examId: crypto.randomUUID(),
      assignmentId,
      org: orgId,
      userId,
      targetRole: "student",
      module: rule.subject,
      title: rule.title,
      isTrial: true,
      questionIds: questions.map(q => String(q._id)),
      choicesOrder: questions.map(q =>
        Array.from({ length: q.choices.length }, (_, i) => i)
      ),
      createdAt: new Date()
    });
  }
}


// ----------------------------------
// View child's quizzes
// GET /parent/children/:childId/quizzes
// ----------------------------------
router.get("/parent/children/:childId/quizzes", ensureAuth, async (req, res) => {
  if (req.user.role !== "parent") {
    return res.status(403).send("Parents only");
  }

  const { childId } = req.params;

  // 🔒 ensure child belongs to parent
  const child = await User.findOne({
    _id: childId,
    parentUserId: req.user._id,
    role: "student"
  }).lean();

  if (!child) {
    return res.status(404).send("Child not found");
  }

  const quizzes = await ExamInstance.find({
    userId: child._id
  })
    .sort({ createdAt: -1 })
    .lean();

  res.render("parent/child_quizzes", {
    user: req.user,
    child,
    quizzes
  });
});


export default router;
