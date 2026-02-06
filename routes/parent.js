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

const router = Router();

// 🔒 Hard-lock HOME org
const HOME_ORG_SLUG = "cripfcnt-home";

// ==============================
// 💳 PLAN LIMITS (single source of truth)
// ==============================
const PLAN_LIMITS = {
  none:   { maxChildren: 0, label: "Free Trial" },
  silver: { maxChildren: 2, label: "Silver" },
  gold:   { maxChildren: 5, label: "Gold" }
};

function getChildLimit(user) {
  // If subscription expired, revert to trial
  if (
    user.subscriptionStatus === "paid" &&
    user.subscriptionExpiresAt &&
    new Date() > new Date(user.subscriptionExpiresAt)
  ) {
    return PLAN_LIMITS.none.maxChildren;
  }

  const plan = user.subscriptionPlan || "none";
  return PLAN_LIMITS[plan]?.maxChildren ?? 0;
}

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

    const freshUser = await User.findById(req.user._id).lean();

    // 💳 Compute plan info for template
    const childLimit = getChildLimit(freshUser);
    const canAddChild = children.length < childLimit;
    const planLabel = PLAN_LIMITS[freshUser.subscriptionPlan || "none"]?.label || "Free Trial";

    // Check if subscription expired
    const isExpired = (
      freshUser.subscriptionStatus === "paid" &&
      freshUser.subscriptionExpiresAt &&
      new Date() > new Date(freshUser.subscriptionExpiresAt)
    );

    res.render("parent/dashboard", {
      user: freshUser,
      children,
      unreadCount: res.locals?.unreadCount || 0,
      childLimit,
      canAddChild,
      planLabel,
      isExpired,
      childCount: children.length
    });
  }
);

// ----------------------------------
// Add child form
// GET /parent/children/new
// ----------------------------------
router.get(
  "/parent/children/new",
  ensureAuth,
  canActAsParent,
  async (req, res) => {
    const freshUser = await User.findById(req.user._id).lean();
    const childCount = await User.countDocuments({
      parentUserId: req.user._id,
      role: "student"
    });

    const childLimit = getChildLimit(freshUser);

    if (childCount >= childLimit) {
      return res.render("parent/child_limit", {
        user: freshUser,
        maxChildren: childLimit,
        currentPlan: PLAN_LIMITS[freshUser.subscriptionPlan || "none"]?.label || "Free Trial"
      });
    }

    res.render("parent/new_child", {
      user: freshUser,
      childCount,
      childLimit
    });
  }
);

// ----------------------------------
// Create child + auto-assign trials
// POST /parent/children
// ----------------------------------
router.post("/parent/children", ensureAuth, async (req, res) => {
  const { firstName, lastName, grade, parentId } = req.body;

  // Determine parent context
  let effectiveParentId = req.user._id;

  if (parentId) {
    const parentUser = await User.findById(parentId).lean();
    if (!parentUser) {
      return res.status(400).send("Invalid parentId");
    }
    effectiveParentId = parentId;
  }

  if (!["parent", "admin", "employee", "org_admin", "super_admin"].includes(req.user.role)) {
    return res.status(403).send("Not allowed");
  }

  if (!firstName || !grade) {
    return res.status(400).send("Name and grade required");
  }

  // 🔒 PLAN-AWARE CHILD CAP
  const parentUser = await User.findById(effectiveParentId).lean();
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

  // 3️⃣ Assign trial quizzes
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

  // 4️⃣ If parent already PAID, also assign paid quizzes
  if (parentUser && parentUser.subscriptionStatus === "paid") {
    const isActive = !parentUser.subscriptionExpiresAt ||
      new Date() < new Date(parentUser.subscriptionExpiresAt);

    if (isActive) {
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

      await User.findByIdAndUpdate(child._id, { consumerEnabled: true });
    }
  }

  return res.redirect("/parent/dashboard");
});

// ----------------------------------
// View child's quizzes
// GET /parent/children/:childId/quizzes
// ----------------------------------
router.get(
  "/parent/children/:childId/quizzes",
  ensureAuth,
  canActAsParent,
  async (req, res) => {

    const parent = await User.findById(req.user._id).lean();
    if (!parent) {
      return res.redirect("/parent/dashboard");
    }

    const child = await User.findOne({
      _id: req.params.childId,
      parentUserId: parent._id,
      role: "student"
    }).lean();

    if (!child) {
      return res.status(404).send("Child not found");
    }

    const org = await Organization.findById(child.organization).lean();
    if (!org) {
      return res.status(500).send("Child organization not found");
    }

    /* ASSIGNED QUIZZES */
    const exams = await ExamInstance.find({
      userId: child._id
    })
    .sort({ createdAt: -1 })
    .lean();

    const examById = {};
    for (const ex of exams) {
      examById[String(ex.examId)] = ex;
    }

    const rawAttempts = await Attempt.find({
      userId: child._id,
      status: "finished"
    })
    .sort({ finishedAt: -1 })
    .lean();

    function normaliseSubject(subject) {
      if (!subject) return "General";
      const map = {
        math: "Mathematics",
        maths: "Mathematics",
        english: "English",
        science: "Science"
      };
      return map[String(subject).toLowerCase()] || subject;
    }

    const progressData = [];
    const subjectStats = {};
    let passCount = 0;
    let failCount = 0;

    for (const a of rawAttempts) {
      const pct = a.maxScore ? Math.round((a.score / a.maxScore) * 100) : 0;

      progressData.push({
        date: a.finishedAt,
        score: pct
      });

      a.passed ? passCount++ : failCount++;

      const exam = examById[String(a.examId)];
      const rawSubject =
        exam?.meta?.subject ||
        exam?.meta?.ruleSubject ||
        "General";
      const subject = normaliseSubject(rawSubject);

      if (!subjectStats[subject]) {
        subjectStats[subject] = { total: 0, count: 0 };
      }
      subjectStats[subject].total += pct;
      subjectStats[subject].count++;
    }

    const subjectChartData = Object.entries(subjectStats).map(
      ([subject, v]) => ({
        subject,
        avg: Math.round(v.total / v.count)
      })
    );

    let avgScore = null;
    let trend = "N/A";
    let strongestSubject = null;
    let weakestSubject = null;

    if (progressData.length) {
      avgScore = Math.round(
        progressData.reduce((s, p) => s + p.score, 0) / progressData.length
      );

      if (progressData.length >= 2) {
        const first = progressData[progressData.length - 1].score;
        const last = progressData[0].score;
        if (last > first) trend = "Improving";
        else if (last < first) trend = "Declining";
        else trend = "Stable";
      }
    }

    const THRESHOLDS = {
      excellent: 85,
      satisfactory: 60
    };

    if (subjectChartData.length) {
      const sorted = [...subjectChartData].sort((a, b) => b.avg - a.avg);
      strongestSubject = sorted[0].subject;

      if (
        sorted.length > 1 &&
        sorted[sorted.length - 1].avg < THRESHOLDS.satisfactory
      ) {
        weakestSubject = sorted[sorted.length - 1].subject;
      } else {
        weakestSubject = null;
      }
    }

    /* ATTEMPTS (HISTORY) */
    const attempts = rawAttempts.map(a => ({
      _id: a._id,
      examId: a.examId,
      quizTitle: a.quizTitle || "Quiz",
      percentage: a.maxScore
        ? Math.round((a.score / a.maxScore) * 100)
        : 0,
      passed: !!a.passed,
      finishedAt: a.finishedAt
    }));

    /* ASSIGNED QUIZZES (GROUPED BY SUBJECT) */
    let quizzesBySubject = null;

    if (org.slug === "cripfcnt-home") {
      quizzesBySubject = {};

      exams.forEach(ex => {
        const hasFinishedAttempt = rawAttempts.some(
          a => String(a.examId) === String(ex.examId)
        );
        if (hasFinishedAttempt) return;

        const subject = ex.meta?.subject || "General";

        if (!quizzesBySubject[subject]) {
          quizzesBySubject[subject] = [];
        }

        quizzesBySubject[subject].push({
          examId: ex.examId,
          quizTitle: ex.quizTitle || "Quiz"
        });
      });
    }

    /* CERTIFICATES */
    const certificates = await Certificate.find({
      userId: child._id,
      orgId: org._id
    })
    .sort({ issuedAt: -1, createdAt: -1 })
    .lean();

    /* RENDER */
    res.render("parent/child_quizzes", {
      user: parent,
      child,
      org,
      quizzesBySubject,
      attempts,
      certificates,
      progressData,
      subjectChartData,
      passCount,
      failCount,
      avgScore,
      trend,
      strongestSubject,
      weakestSubject,
    });
  }
);

// ----------------------------------
// Parent review attempt (child-scoped)
// GET /parent/children/:childId/attempts/:attemptId
// ----------------------------------
router.get(
  "/parent/children/:childId/attempts/:attemptId",
  ensureAuth,
  canActAsParent,
  async (req, res) => {
    const { childId, attemptId } = req.params;

    if (!mongoose.isValidObjectId(attemptId)) {
      return res.status(400).send("Invalid attempt id");
    }

    const child = await User.findOne({
      _id: childId,
      parentUserId: req.user._id,
      role: "student"
    }).lean();

    if (!child) {
      return res.status(403).send("Not allowed");
    }

    const attempt = await Attempt.findOne({
      _id: attemptId,
      userId: child._id
    }).lean();

    if (!attempt) {
      return res.status(404).send("attempt not found");
    }

    const org = await Organization.findById(child.organization).lean();

    let orderedQIds = Array.isArray(attempt.questionIds) && attempt.questionIds.length
      ? attempt.questionIds.map(String)
      : [];

    if (!orderedQIds.length && attempt.examId) {
      const exam = await ExamInstance.findOne({ examId: attempt.examId }).lean();
      if (exam?.questionIds?.length) {
        orderedQIds = exam.questionIds.map(String);
      }
    }

    const answerMap = {};
    if (Array.isArray(attempt.answers)) {
      for (const a of attempt.answers) {
        if (a?.questionId != null) {
          answerMap[String(a.questionId)] =
            typeof a.choiceIndex === "number" ? a.choiceIndex : null;
        }
      }
    }

    const validIds = orderedQIds.filter(id => mongoose.isValidObjectId(id));
    const questions = validIds.length
      ? await Question.find({ _id: { $in: validIds } }).lean()
      : [];

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

    return res.render("parent/org_attempt_detail", {
      org,
      attempt,
      details,
      user: child
    });
  }
);

// ----------------------------------
// Org attempt review (parent scoped)
// ----------------------------------
router.get(
  "/org/:slug/my-attempts/:attemptId",
  ensureAuth,
  async (req, res) => {
    try {
      const { slug, attemptId } = req.params;

      if (!mongoose.isValidObjectId(attemptId)) {
        return res.status(400).send("Invalid attempt id");
      }

      const org = await Organization.findOne({ slug }).lean();
      if (!org) return res.status(404).send("org not found");

      const attempt = await Attempt.findById(attemptId).lean();
      if (!attempt) return res.status(404).send("attempt not found");

      const child = await User.findOne({
        _id: attempt.userId,
        parentUserId: req.user._id,
        role: "student"
      }).lean();

      if (!child) {
        return res.status(403).send("Not allowed");
      }

      let orderedQIds = Array.isArray(attempt.questionIds) && attempt.questionIds.length
        ? attempt.questionIds.map(String)
        : [];

      if (!orderedQIds.length && attempt.examId) {
        const exam = await ExamInstance.findOne({ examId: attempt.examId }).lean();
        if (exam?.questionIds?.length) {
          orderedQIds = exam.questionIds.map(String);
        }
      }

      const answerMap = {};
      if (Array.isArray(attempt.answers)) {
        for (const a of attempt.answers) {
          if (a?.questionId != null) {
            answerMap[String(a.questionId)] =
              typeof a.choiceIndex === "number" ? a.choiceIndex : null;
          }
        }
      }

      const validIds = orderedQIds.filter(id => mongoose.isValidObjectId(id));
      const questions = validIds.length
        ? await Question.find({ _id: { $in: validIds } }).lean()
        : [];

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

// ----------------------------------
// Payment history
// GET /parent/payments
// ----------------------------------
router.get(
  "/parent/payments",
  ensureAuth,
  canActAsParent,
  async (req, res) => {
    const Payment = (await import("../models/payment.js")).default;

    const payments = await Payment.find({
      userId: req.user._id
    })
    .sort({ createdAt: -1 })
    .lean();

    const freshUser = await User.findById(req.user._id).lean();

    res.render("parent/payments", {
      user: freshUser,
      payments
    });
  }
);

// ⚠️ TEMP FIX — BACKFILL ATTEMPT QUIZ TITLES
router.get(
  "/admin/fix-attempt-quiz-titles",
  ensureAuth,
  async (req, res) => {
    try {
      const AttemptModel = (await import("../models/attempt.js")).default;
      const ExamInstanceModel = (await import("../models/examInstance.js")).default;
      const QuizRuleModel = (await import("../models/quizRule.js")).default;

      let updated = 0;

      const attempts = await AttemptModel.find({
        $or: [
          { quizTitle: { $exists: false } },
          { quizTitle: null },
          { quizTitle: "" }
        ],
        examId: { $exists: true }
      });

      for (const attempt of attempts) {
        const exam = await ExamInstanceModel.findOne({
          examId: attempt.examId
        }).lean();

        if (exam?.quizTitle) {
          attempt.quizTitle = exam.quizTitle;
          await attempt.save();
          updated++;
          continue;
        }

        if (exam?.ruleId) {
          const rule = await QuizRuleModel.findById(exam.ruleId).lean();
          if (rule?.quizTitle) {
            attempt.quizTitle = rule.quizTitle;
            await attempt.save();
            updated++;
          }
        }
      }

      res.send(`✅ Fixed quiz history titles for ${updated} attempt(s)`);

    } catch (err) {
      console.error("[fix-attempt-quiz-titles]", err);
      res.status(500).send("Failed");
    }
  }
);

export default router;