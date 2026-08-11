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
import Question from "../models/question.js";
import { getStudentKnowledgeMap } from "../services/topicMasteryTracker.js";
import { buildStudentDashboardData } from "../services/studentDashboardData.js";

const router = Router();

const HOME_ORG_SLUG = "cripfcnt-home";

// ==============================
// 💳 PLAN CONFIG
// ==============================
const PLAN_LIMITS = {
  none:   { maxChildren: 0, label: "Free Trial" },
  silver: { maxChildren: 5, label: "Silver" },
  gold:   { maxChildren: 10, label: "Gold" },
   starter: { maxChildren: 10, label: "Teacher Starter" },  // ✅ ADD
  professional: { maxChildren: 30, label: "Teacher Professional" }  // ✅ ADD
};

const TRIAL_MAX_CHILDREN = 1;
const TRIAL_SUBJECTS = ["math", "responsibility"];


// ==============================
// 🔐 STUDENT LOGIN HELPERS
// ==============================
function generatePin(length = 4) {
  // 4-digit PIN, numeric, no leading zeros issues
  const min = Math.pow(10, length - 1);
  const max = Math.pow(10, length) - 1;
  return String(Math.floor(min + Math.random() * (max - min + 1)));
}

async function generateUniqueStudentId(UserModel) {
  // Format: CRIP-123456 (simple, readable)
  // Retry a few times to avoid collisions
  for (let i = 0; i < 10; i++) {
    const id = "CRIP-" + String(Math.floor(100000 + Math.random() * 900000));
    const exists = await UserModel.exists({ studentId: id });
    if (!exists) return id;
  }
  throw new Error("Failed to generate unique studentId");
}

function getChildLimit(user) {
  // ✅ Private teacher check
  if (user.role === "private_teacher") {
    if (user.teacherSubscriptionStatus !== "paid") return 0;
    if (!user.teacherSubscriptionExpiresAt) return 0;
    if (new Date() >= new Date(user.teacherSubscriptionExpiresAt)) return 0;
    
    if (user.teacherSubscriptionPlan === "starter") return 15;
    if (user.teacherSubscriptionPlan === "professional") return 40;
    return 0;
  }

  if (!isSubscriptionActive(user)) return 0;
  const plan = user.subscriptionPlan || "none";
  return PLAN_LIMITS[plan]?.maxChildren ?? 0;
}

function isSubscriptionActive(user) {
  // ✅ Private teacher check (lean object compatible)
  if (user.role === "private_teacher") {
    if (user.teacherSubscriptionStatus !== "paid") return false;
    if (!user.teacherSubscriptionExpiresAt) return false;
    return new Date() < new Date(user.teacherSubscriptionExpiresAt);
  }

  if (user.subscriptionStatus !== "paid") return false;
  if (!user.subscriptionExpiresAt) return false;
  return new Date() < new Date(user.subscriptionExpiresAt);
}
// ----------------------------------
// Parent dashboard
// ----------------------------------
router.get(
  "/parent/dashboard",
  ensureAuth,
  canActAsParent,
  async (req, res) => {

    const freshUser = await User.findById(req.user._id).lean();
    const isPaid = isSubscriptionActive(freshUser);

    const children = await User.find({
      parentUserId: req.user._id,
      role: "student"
    }).lean();

    for (const child of children) {
      child.pendingCount = await ExamInstance.countDocuments({
        userId: child._id,
        status: { $ne: "finished" }
      });
      child.completedCount = await ExamInstance.countDocuments({
        userId: child._id,
        status: "finished"
      });
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

    const childLimit = getChildLimit(freshUser);
    const canAddChild = isPaid && children.length < childLimit;
    const planLabel = PLAN_LIMITS[freshUser.subscriptionPlan || "none"]?.label || "Free Trial";

    const isExpired = (
      freshUser.subscriptionStatus === "paid" &&
      freshUser.subscriptionExpiresAt &&
      new Date() > new Date(freshUser.subscriptionExpiresAt)
    );

      const daysRemaining = freshUser.subscriptionExpiresAt && !isExpired
      ? Math.ceil((new Date(freshUser.subscriptionExpiresAt) - new Date()) / (1000 * 60 * 60 * 24))
      : 0;

    const hasTrialChild = children.length > 0;

    let demoData = null;
    if (!isPaid) {
      const org = await Organization.findOne({ slug: HOME_ORG_SLUG }).lean();
      if (org) {
        const rules = await QuizRule.find({ org: org._id, enabled: true }).lean();
        const subjects = new Set();
        const grades = new Set();
        let totalQuizzes = 0;
        for (const r of rules) {
          if (r.subject) subjects.add(r.subject);
          if (r.grade) grades.add(r.grade);
          totalQuizzes++;
        }
        demoData = {
          subjects: Array.from(subjects),
          grades: Array.from(grades).sort((a, b) => a - b),
          totalQuizzes
        };
      }
    }

    res.render("parent/dashboard", {
      user: freshUser,
      children,
      unreadCount: res.locals?.unreadCount || 0,
      childLimit,
      canAddChild,
      planLabel,
      isExpired,
      isPaid,
      childCount: children.length,
      demoData,
      daysRemaining,  // ✅ ADD THIS
      hasTrialChild
    });
  }
);

// ----------------------------------
// Add child form (PAID users)
// ----------------------------------
router.get(
  "/parent/children/new",
  ensureAuth,
  canActAsParent,
  async (req, res) => {
    const freshUser = await User.findById(req.user._id).lean();

    // ✅ Check subscription based on role
    const hasActiveSubscription = freshUser.role === "private_teacher"
      ? (freshUser.teacherSubscriptionStatus === "paid" && 
         freshUser.teacherSubscriptionExpiresAt && 
         new Date() < new Date(freshUser.teacherSubscriptionExpiresAt))
      : isSubscriptionActive(freshUser);

    if (!hasActiveSubscription) {
      // ✅ Redirect teachers to teacher pricing
      if (freshUser.role === "private_teacher") {
        return res.redirect("/teacher/pricing");
      }
      return res.render("parent/subscribe_first", { user: freshUser });
    }

    const childCount = await User.countDocuments({
      parentUserId: req.user._id,
      role: "student"
    });

    const childLimit = getChildLimit(freshUser);

    if (childCount >= childLimit) {
      // ✅ Different error page for teachers
      if (freshUser.role === "private_teacher") {
        return res.render("parent/child_limit", {
          user: freshUser,
          maxChildren: childLimit,
          currentPlan: `Teacher ${freshUser.teacherSubscriptionPlan || "Trial"}`,
          isTeacher: true
        });
      }

      return res.render("parent/child_limit", {
        user: freshUser,
        maxChildren: childLimit,
        currentPlan: PLAN_LIMITS[freshUser.subscriptionPlan || "none"]?.label || "Free Trial"
      });
    }

res.render("parent/new_child", {
  user: freshUser,
  childCount,
  childLimit,
  dashboardUrl: freshUser.role === "private_teacher" ? "/teacher/dashboard" : "/parent/dashboard"
});
  }
);

// ----------------------------------
// 🆓 TRIAL: Add trial child form
// ----------------------------------
router.get(
  "/parent/trial/new",
  ensureAuth,
  canActAsParent,
  async (req, res) => {
    const freshUser = await User.findById(req.user._id).lean();

    if (isSubscriptionActive(freshUser)) {
      return res.redirect("/parent/children/new");
    }

    const existingCount = await User.countDocuments({
      parentUserId: req.user._id,
      role: "student"
    });

    if (existingCount >= TRIAL_MAX_CHILDREN) {
      return res.render("parent/trial_limit", { user: freshUser });
    }

    res.render("parent/trial_child", { user: freshUser });
  }
);

// ----------------------------------
// 🆓 TRIAL: Create trial child
// ----------------------------------
router.post(
  "/parent/trial/children",
  ensureAuth,
  canActAsParent,
  async (req, res) => {
    const { firstName, lastName, grade } = req.body;
    const freshUser = await User.findById(req.user._id).lean();

    if (isSubscriptionActive(freshUser)) {
      return res.redirect("/parent/children/new");
    }

    const existingCount = await User.countDocuments({
      parentUserId: req.user._id,
      role: "student"
    });

    if (existingCount >= TRIAL_MAX_CHILDREN) {
      return res.render("parent/trial_limit", { user: freshUser });
    }

    if (!firstName || !grade) {
      return res.status(400).send("Name and grade required");
    }

    const org = await Organization.findOne({ slug: HOME_ORG_SLUG });
    if (!org) return res.status(500).send("Home org missing");

    const studentId = await generateUniqueStudentId(User);
const pin = generatePin(4);

const child = new User({
  firstName,
  lastName,
  role: "student",
  grade: Number(grade),
  parentUserId: req.user._id,
  organization: org._id,
  accountType: "student_self",
  consumerEnabled: false,
  studentId
});

await child.setPassword(pin);   // uses your bcrypt helper
await child.save();


    await OrgMembership.create({
      org: org._id,
      user: child._id,
      role: "student",
      joinedAt: new Date()
    });

    for (const subject of TRIAL_SUBJECTS) {
      const rule = await QuizRule.findOne({
        org: org._id,
        grade: child.grade,
        subject,
        quizType: "trial",
        enabled: true
      }).lean();

      if (rule) {
        await assignQuizFromRule({
          rule,
          userId: child._id,
          orgId: org._id
        });
      }
    }

   // return res.redirect("/parent/dashboard");
 return res.render("parent/student_credentials", {
  childName: `${child.firstName} ${child.lastName || ""}`.trim(),
  studentId: child.studentId,
  pin,
  dashboardUrl: req.user.role === "private_teacher" ? "/teacher/dashboard" : "/parent/dashboard"
});

  }
);

// ----------------------------------
// Create child (PAID users)
// ----------------------------------
router.post("/parent/children", ensureAuth, async (req, res) => {
  const { firstName, lastName, grade, parentId } = req.body;

  let effectiveParentId = req.user._id;

  if (parentId) {
    const parentUser = await User.findById(parentId).lean();
    if (!parentUser) return res.status(400).send("Invalid parentId");
    effectiveParentId = parentId;
  }

 if (!["parent", "admin", "employee", "org_admin", "super_admin", "private_teacher"].includes(req.user.role)) {
    return res.status(403).send("Not allowed");
  }

  if (!firstName || !grade) {
    return res.status(400).send("Name and grade required");
  }

  const parentUser = await User.findById(effectiveParentId).lean();
  if (!isSubscriptionActive(parentUser)) {
    return res.render("parent/subscribe_first", { user: req.user });
  }

  const childLimit = getChildLimit(parentUser);
  const existingCount = await User.countDocuments({
    parentUserId: effectiveParentId,
    role: "student"
  });

  if (existingCount >= childLimit) {
    return res.render("parent/child_limit", {
      user: req.user,
      maxChildren: childLimit,
      currentPlan: PLAN_LIMITS[parentUser.subscriptionPlan || "none"]?.label || "Free Trial"
    });
  }

  const org = await Organization.findOne({ slug: HOME_ORG_SLUG });
  if (!org) return res.status(500).send("Home org missing");

  const studentId = await generateUniqueStudentId(User);
const pin = generatePin(4);

const child = new User({
  firstName,
  lastName,
  role: "student",
  grade: Number(grade),
  parentUserId: effectiveParentId,
  organization: org._id,
  accountType: "student_self",
  consumerEnabled: true,
  studentId
});

await child.setPassword(pin);
await child.save();


  await OrgMembership.create({
    org: org._id,
    user: child._id,
    role: "student",
    joinedAt: new Date()
  });

  for (const subject of TRIAL_SUBJECTS) {
    const rule = await QuizRule.findOne({
      org: org._id,
      grade: child.grade,
      subject,
      quizType: "trial",
      enabled: true
    }).lean();

    if (rule) {
      await assignQuizFromRule({
        rule,
        userId: child._id,
        orgId: org._id
      });
    }
  }

  const paidRules = await QuizRule.find({
    org: org._id,
    grade: child.grade,
    quizType: "paid",
    enabled: true
  });

  for (const rule of paidRules) {
    await assignQuizFromRule({
      rule,
      userId: child._id,
      orgId: org._id,
      force: true
    });
  }

 // return res.redirect("/parent/dashboard");
return res.render("parent/student_credentials", {
  childName: `${child.firstName} ${child.lastName || ""}`.trim(),
  studentId: child.studentId,
  pin,
  dashboardUrl: req.user.role === "private_teacher" ? "/teacher/dashboard" : "/parent/dashboard"
});

});

// ----------------------------------
// View child's quizzes + PROGRESS
// ----------------------------------
router.get(
  "/parent/children/:childId/quizzes",
  ensureAuth,
  canActAsParent,
  async (req, res) => {
    const parent = await User.findById(req.user._id).lean();
    if (!parent) return res.redirect("/parent/dashboard");

    const child = await User.findOne({
      _id: req.params.childId,
      parentUserId: parent._id,
      role: "student"
    }).lean();

    if (!child) return res.status(404).send("Child not found");

    const org = await Organization.findById(child.organization).lean();
    if (!org) return res.status(500).send("Child organization not found");

    const data = await buildStudentDashboardData({
      userId: child._id,
      org
    });

    let knowledgeMap = null;
    if (org.slug === HOME_ORG_SLUG && child.grade) {
      try {
        knowledgeMap = await getStudentKnowledgeMap(child._id, "math", child.grade);
      } catch (err) {
        console.error("[ChildQuizzes] Error getting knowledge map:", err);
      }
    }

    const parentIsPaid = isSubscriptionActive(parent);

    return res.render("parent/child_quizzes", {
      user: parent,
      child,
      org,
      ...data,
      knowledgeMap,
      parentIsPaid
    });
  }
);

// ----------------------------------
// Edit child form
// ----------------------------------
router.get(
  "/parent/children/:childId/edit",
  ensureAuth,
  canActAsParent,
  async (req, res) => {
    const parent = await User.findById(req.user._id).lean();
    const child = await User.findOne({
      _id: req.params.childId,
      parentUserId: parent._id,
      role: "student"
    }).lean();

    if (!child) return res.status(404).send("Child not found");

    res.render("parent/edit_child", {
      user: parent,
      child,
      dashboardUrl: parent.role === "private_teacher" ? "/teacher/dashboard" : "/parent/dashboard"
    });
  }
);

// ----------------------------------
// Update child details
// ----------------------------------

router.post(
  "/parent/children/:childId/edit",
  ensureAuth,
  canActAsParent,
  async (req, res) => {
    const { firstName, lastName, grade, newPin } = req.body;
    const parent = await User.findById(req.user._id);
    
    const child = await User.findOne({
      _id: req.params.childId,
      parentUserId: parent._id,
      role: "student"
    });

    if (!child) return res.status(404).send("Child not found");

    const oldGrade = child.grade;
    const gradeChanged = grade && Number(grade) !== oldGrade;

    // Update basic info
    if (firstName) child.firstName = firstName;
    if (lastName) child.lastName = lastName;
    if (grade) child.grade = Number(grade);

    // Update PIN if provided
    if (newPin && newPin.length >= 4) {
      await child.setPassword(newPin);
    }

    await child.save();

    // ✅ GRADE TRANSITION LOGIC
    if (gradeChanged && isSubscriptionActive(parent)) {
      const org = await Organization.findOne({ slug: HOME_ORG_SLUG }).lean();
      
      if (org) {
        // Archive old quizzes (mark as legacy, don't delete)
        await ExamInstance.updateMany(
          { 
            userId: child._id, 
            org: org._id,
            status: "pending"
          },
          { 
            $set: { 
              status: "archived",
              archivedReason: `Grade changed from ${oldGrade} to ${child.grade}`,
              archivedAt: new Date()
            }
          }
        );

        // Assign trial quizzes for new grade
        for (const subject of TRIAL_SUBJECTS) {
          const rule = await QuizRule.findOne({
            org: org._id,
            grade: child.grade,
            subject,
            quizType: "trial",
            enabled: true
          }).lean();

          if (rule) {
            await assignQuizFromRule({
              rule,
              userId: child._id,
              orgId: org._id
            });
          }
        }

        // Assign paid quizzes if parent is subscribed
        const paidRules = await QuizRule.find({
          org: org._id,
          grade: child.grade,
          quizType: "paid",
          enabled: true
        });

        for (const rule of paidRules) {
          await assignQuizFromRule({
            rule,
            userId: child._id,
            orgId: org._id,
            force: true
          });
        }

        // Show transition confirmation page
        return res.render("parent/grade_transition_success", {
          user: parent,
          child,
          oldGrade,
          newGrade: child.grade,
          dashboardUrl: parent.role === "private_teacher" ? "/teacher/dashboard" : "/parent/dashboard"
        });
      }
    }

    return res.redirect(`/parent/children/${child._id}/quizzes`);
  }
);

// ----------------------------------
// Delete child (with confirmation)
// ----------------------------------
router.post(
  "/parent/children/:childId/delete",
  ensureAuth,
  canActAsParent,
  async (req, res) => {
    const parent = await User.findById(req.user._id).lean();
    
    const child = await User.findOne({
      _id: req.params.childId,
      parentUserId: parent._id,
      role: "student"
    });

    if (!child) return res.status(404).send("Child not found");

    // Delete child's data
    await ExamInstance.deleteMany({ userId: child._id });
    await Attempt.deleteMany({ userId: child._id });
    await Certificate.deleteMany({ userId: child._id });
    await OrgMembership.deleteMany({ user: child._id });
    
    // Delete child account
    await User.findByIdAndDelete(child._id);

    const dashboardUrl = parent.role === "private_teacher" 
      ? "/teacher/dashboard" 
      : "/parent/dashboard";

    return res.redirect(dashboardUrl);
  }
);
// ----------------------------------
// Parent review attempt
// ----------------------------------
router.get(
  "/parent/children/:childId/attempts/:attemptId",
  ensureAuth,
  canActAsParent,
  async (req, res) => {
    const { childId, attemptId } = req.params;
    if (!mongoose.isValidObjectId(attemptId)) return res.status(400).send("Invalid attempt id");

    const child = await User.findOne({ _id: childId, parentUserId: req.user._id, role: "student" }).lean();
    if (!child) return res.status(403).send("Not allowed");

    const attempt = await Attempt.findOne({ _id: attemptId, userId: child._id }).lean();
    if (!attempt) return res.status(404).send("attempt not found");

    const org = await Organization.findById(child.organization).lean();
    const details = await buildAttemptDetails(attempt);

    return res.render("parent/org_attempt_detail", { org, attempt, details, user: child });
  }
);

// ----------------------------------
// Org attempt review
// ----------------------------------
router.get(
  "/org/:slug/my-attempts/:attemptId",
  ensureAuth,
  async (req, res) => {
    try {
      const { slug, attemptId } = req.params;
      if (!mongoose.isValidObjectId(attemptId)) return res.status(400).send("Invalid attempt id");

      const org = await Organization.findOne({ slug }).lean();
      if (!org) return res.status(404).send("org not found");

      const attempt = await Attempt.findById(attemptId).lean();
      if (!attempt) return res.status(404).send("attempt not found");

      const child = await User.findOne({ _id: attempt.userId, parentUserId: req.user._id, role: "student" }).lean();
      if (!child) return res.status(403).send("Not allowed");

      const details = await buildAttemptDetails(attempt);
      return res.render("parent/org_attempt_detail", { org, attempt, details, user: child });
    } catch (err) {
      console.error("[parent attempt review] error:", err);
      return res.status(500).send("failed");
    }
  }
);

// ----------------------------------
// Payment history
// ----------------------------------
router.get(
  "/parent/payments",
  ensureAuth,
  canActAsParent,
  async (req, res) => {
    const Payment = (await import("../models/payment.js")).default;
    const payments = await Payment.find({ userId: req.user._id }).sort({ createdAt: -1 }).lean();
    const freshUser = await User.findById(req.user._id).lean();
    res.render("parent/payments", { user: freshUser, payments });
  }
);

// ----------------------------------
// SHARED: Build attempt details
// ----------------------------------
async function buildAttemptDetails(attempt) {
  let orderedQIds = Array.isArray(attempt.questionIds) && attempt.questionIds.length
    ? attempt.questionIds.map(String) : [];

  if (!orderedQIds.length && attempt.examId) {
    const exam = await ExamInstance.findOne({ examId: attempt.examId }).lean();
    if (exam?.questionIds?.length) orderedQIds = exam.questionIds.map(String);
  }

  const answerMap = {};
  if (Array.isArray(attempt.answers)) {
    for (const a of attempt.answers) {
      if (a?.questionId != null) {
        answerMap[String(a.questionId)] = typeof a.choiceIndex === "number" ? a.choiceIndex : null;
      }
    }
  }

  const validIds = orderedQIds.filter(id => mongoose.isValidObjectId(id));
  const questions = validIds.length ? await Question.find({ _id: { $in: validIds } }).lean() : [];
  const qById = {};
  for (const q of questions) qById[String(q._id)] = q;

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

    const yourIndex = Object.prototype.hasOwnProperty.call(answerMap, qid) ? answerMap[qid] : null;
    const correct = correctIndex !== null && yourIndex !== null && correctIndex === yourIndex;

    const choices = qdoc?.choices
      ? qdoc.choices.map(c => typeof c === "string" ? { text: c } : { text: c?.text || "" })
      : [];

    details.push({
      qIndex: i + 1, questionId: qid,
      questionText: qdoc ? qdoc.text : "(question not in DB)",
      choices, yourIndex, correctIndex, correct
    });
  }

  return details;
}

// ⚠️ TEMP FIX - BACKFILL ATTEMPT QUIZ TITLES
router.get("/admin/fix-attempt-quiz-titles", ensureAuth, async (req, res) => {
  try {
    const AttemptModel = (await import("../models/attempt.js")).default;
    const ExamInstanceModel = (await import("../models/examInstance.js")).default;
    const QuizRuleModel = (await import("../models/quizRule.js")).default;

    let updated = 0;
    const attempts = await AttemptModel.find({
      $or: [{ quizTitle: { $exists: false } }, { quizTitle: null }, { quizTitle: "" }],
      examId: { $exists: true }
    });

    for (const attempt of attempts) {
      const exam = await ExamInstanceModel.findOne({ examId: attempt.examId }).lean();
      if (exam?.quizTitle) { attempt.quizTitle = exam.quizTitle; await attempt.save(); updated++; continue; }
      if (exam?.ruleId) {
        const rule = await QuizRuleModel.findById(exam.ruleId).lean();
        if (rule?.quizTitle) { attempt.quizTitle = rule.quizTitle; await attempt.save(); updated++; }
      }
    }

    res.send(`✅ Fixed quiz history titles for ${updated} attempt(s)`);
  } catch (err) {
    console.error("[fix-attempt-quiz-titles]", err);
    res.status(500).send("Failed");
  }
});



router.get(
  "/parent/children/:childId/knowledge-map",
  ensureAuth,
  canActAsParent,
  async (req, res) => {
    try {
      const viewer = await User.findById(req.user._id).lean();
      if (!viewer) return res.redirect("/parent/dashboard");

      let child = null;

      // ✅ Student self-view path
      if (viewer.role === "student") {
        if (String(req.params.childId) !== String(viewer._id)) {
          return res.status(403).send("Not allowed");
        }
        child = viewer; // student is the child
      } else {
        // ✅ Parent/teacher/admin path (existing logic)
        child = await User.findOne({
          _id: req.params.childId,
          parentUserId: viewer._id,
          role: "student"
        }).lean();
      }

      if (!child) return res.status(404).send("Child not found");

      const org = await Organization.findById(child.organization).lean();
      if (!org || org.slug !== HOME_ORG_SLUG) {
        return res.status(404).send("Knowledge map only available for home school students");
      }

      if (!child.grade) {
        return res.render("parent/knowledge_map", {
          user: viewer,
          child,
          error: viewer.role === "student"
            ? "Grade not set. Please contact your teacher."
            : "Child grade not set. Please update child profile.",
          backUrl: viewer.role === "student"
            ? "/student/dashboard"
            : `/parent/children/${child._id}/quizzes`,
          isStudentView: viewer.role === "student"
        });
      }

      const subjects = ["math", 'environmentalstudies','biology',"english","computerstudies",'history','geography', "science", "responsibility"];

      const knowledgeMaps = {};
      for (const subject of subjects) {
        try {
          const map = await getStudentKnowledgeMap(child._id, subject, child.grade);
          if (map?.stats?.totalTopics > 0) knowledgeMaps[subject] = map;
        } catch (err) {
          console.error(`[KnowledgeMap] Error getting ${subject}:`, err);
        }
      }

      return res.render("parent/knowledge_map", {
        user: viewer,
        child,
        knowledgeMaps,
        subjects,
        backUrl: viewer.role === "student"
          ? "/student/dashboard"
          : `/parent/children/${child._id}/quizzes`,
        isStudentView: viewer.role === "student"
      });

    } catch (error) {
      console.error("[KnowledgeMap] Error:", error);
      return res.status(500).send("Failed to load knowledge map");
    }
  }
);

export default router;
