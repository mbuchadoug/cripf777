import { Router } from "express";
import mongoose from "mongoose";
import crypto from "crypto";

import { ensureAuth } from "../middleware/authGuard.js";
import User from "../models/user.js";
import OrgMembership from "../models/orgMembership.js";
import Organization from "../models/organization.js";
import ExamInstance from "../models/examInstance.js";
import { assignQuizFromRule } from "../services/quizAssignment.js";
import QuizRule from "../models/quizRule.js";
import Attempt from "../models/attempt.js";
import Certificate from "../models/certificate.js";
import Notification from "../models/notification.js";
import { canActAsParent } from "../middleware/parentAccess.js";




//import QuizRule from "../models/quizRule.js";
import Question from "../models/question.js";

const router = Router();

// 🔒 Hard-lock HOME org
const HOME_ORG_SLUG = "cripfcnt-home";

// ----------------------------------
// Parent dashboard
// GET /parent/dashboard
// ----------------------------------
router.get(
  "/parent/dashboard",
  ensureAuth,
  canActAsParent,
  async (req, res) => {

const children = await User.find({
  parentUserId: req.user._id,
  role: "student"
}).lean();

for (const child of children) {
  // 1️⃣ Pending quizzes
  child.pendingCount = await ExamInstance.countDocuments({
    userId: child._id,
    status: { $ne: "finished" }
  });

  // 2️⃣ Completed quizzes
  child.completedCount = await ExamInstance.countDocuments({
    userId: child._id,
    status: "finished"
  });

  // 3️⃣ Certificates earned
  child.certificateCount = await Certificate.countDocuments({
    userId: child._id
  });
}


for (const child of children) {
  const attempts = await Attempt.find({
    userId: child._id,
    status: "finished"
  }).select("percentage").lean();

  if (!attempts.length) {
    child.avgScore = null;
    child.quizCount = 0;
  } else {
    const total = attempts.reduce((s, a) => s + (a.percentage || 0), 0);
    child.avgScore = Math.round(total / attempts.length);
    child.quizCount = attempts.length;
  }
}

const unreadCount = await Notification.countDocuments({
  userId: req.user._id,
  read: false
});


 res.render("parent/dashboard", {
    user: req.user,
    children,
    unreadCount: res.locals?.unreadCount || 0
  });
});

// ----------------------------------
// Add child form
// GET /parent/children/new
// ----------------------------------
router.get(
  "/parent/children/new",
  ensureAuth,
  canActAsParent,
  (req, res) => {
    res.render("parent/new_child", { user: req.user });
  }
);

// ----------------------------------
// Create child + auto-assign trials
// POST /parent/children
router.post("/parent/children", ensureAuth, async (req, res) => {
  const { firstName, lastName, grade, parentId } = req.body;

  // 🧠 Determine parent context
// ✅ DEFAULT: user is acting as parent for themselves
let effectiveParentId = req.user._id;

// ✅ OPTIONAL: admins/employees may act on behalf of another parent
if (parentId) {
  // ensure target parent exists
  const parentUser = await User.findById(parentId).lean();
  if (!parentUser) {
    return res.status(400).send("Invalid parentId");
  }
  effectiveParentId = parentId;
}

// 🚫 hard block only non-parent-capable roles
if (!["parent", "admin", "employee", "org_admin", "super_admin"].includes(req.user.role)) {
  return res.status(403).send("Not allowed");
}


  if (!firstName || !grade) {
    return res.status(400).send("Name and grade required");
  }

  const org = await Organization.findOne({ slug: HOME_ORG_SLUG });
  if (!org) return res.status(500).send("Home org missing");

  // 1️⃣ Create child
  const child = await User.create({
    firstName,
    lastName,
    role: "student",
    grade: Number(grade),
    parentUserId: effectiveParentId,
    organization: org._id,
    accountType: "student_self"
  });

  // 2️⃣ Membership
  await OrgMembership.create({
    org: org._id,
    user: child._id,
    role: "student",
    joinedAt: new Date()
  });

  // 3️⃣ Assign trials
  const rules = await QuizRule.find({
    org: org._id,
    grade: child.grade,
    quizType: "trial",
    enabled: true
  });

  for (const rule of rules) {
    await assignQuizFromRule({
      rule,
      userId: child._id,
      orgId: org._id
    });
  }

 return res.redirect("/parent/dashboard");

});



// ----------------------------------
// AUTO-ASSIGN TRIAL QUIZZES
// ----------------------------------





// ----------------------------------
// View child's quizzes
// GET /parent/children/:childId/quizzes
// ----------------------------------
router.get(
  "/parent/children/:childId/quizzes",
  ensureAuth,
  canActAsParent,
  async (req, res) => {

 // 🔐 Require paid subscription
if (req.user.subscriptionStatus !== "paid") {
  return res.render("payments/upgrade_required", {
    user: req.user
  });
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


    const certificates = await Certificate.find({
  userId: child._id
})
.sort({ createdAt: -1 })
.lean();

const org = await Organization.findOne({ slug: HOME_ORG_SLUG }).lean();
const attempts = await Attempt.find({
  userId: child._id,
  status: "finished"
})
.sort({ finishedAt: 1 })
.select("percentage")
.lean();

const progressPoints = attempts.map(a => a.percentage);

res.render("parent/child_quizzes", {
  user: req.user,
  child,
  quizzes,
  certificates,
  progressPoints,
  org
});


});


export default router;
