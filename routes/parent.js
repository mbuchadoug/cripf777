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


const freshUser = await User.findById(req.user._id).lean();

res.render("parent/dashboard", {
  user: freshUser,
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


    /* -----------------------------
       ASSIGNED QUIZZES
    ----------------------------- */
   const exams = await ExamInstance.find({
  userId: child._id
})
.sort({ createdAt: -1 })
.lean();



const rawAttempts = await Attempt.find({
  userId: child._id,
  status: "finished"
})
.sort({ finishedAt: -1 })
.lean();


const progressData = [];
const subjectStats = {};
let passCount = 0;
let failCount = 0;

for (const a of rawAttempts) {
const pct = a.maxScore ? Math.round((a.score / a.maxScore) * 100) : 0;


  // Progress over time
  progressData.push({
    date: a.finishedAt,
    score: pct
  });

  // Pass / fail
  a.passed ? passCount++ : failCount++;

  // Subject / module aggregation
  const subject = a.module || "General";
  if (!subjectStats[subject]) {
    subjectStats[subject] = { total: 0, count: 0 };
  }
  subjectStats[subject].total += pct;
  subjectStats[subject].count++;
}

// Normalize subject averages
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

if (subjectChartData.length) {
  strongestSubject = subjectChartData.reduce((a, b) =>
    b.avg > a.avg ? b : a
  ).subject;

  weakestSubject = subjectChartData.reduce((a, b) =>
    b.avg < a.avg ? b : a
  ).subject;
}




console.log("PARENT ATTEMPTS FOUND:", rawAttempts.length);






 

    /* -----------------------------
       ATTEMPTS (HISTORY)
    ----------------------------- */
// ---- QUIZ HISTORY (SOURCE OF TRUTH = ATTEMPTS) ----
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

// ---- ASSIGNED QUIZZES (SOURCE = EXAM INSTANCES WITHOUT ATTEMPTS) ----
// ASSIGNED QUIZZES = exams that DO NOT have a finished attempt
// ---- ASSIGNED QUIZZES (GROUPED BY SUBJECT) ----
let quizzesBySubject = null;

// ✅ ONLY APPLY TO HOME SCHOOL
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





    /* -----------------------------
       CERTIFICATES
    ----------------------------- */
const certificates = await Certificate.find({
  userId: child._id,
  orgId: org._id
})

.sort({ issuedAt: -1, createdAt: -1 })
.lean();





    /* -----------------------------
       RENDER
    ----------------------------- */
    console.log("PARENT VIEW DEBUG", {
  child: child._id.toString(),
  org: org._id.toString(),
  attempts: rawAttempts.length,
  certs: certificates.length,
  exams: exams.length
});

res.render("parent/child_quizzes", {
  user: parent,
  child,
  org,
  quizzesBySubject, // only set for cripfcnt-home
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

    // reuse existing logic by redirecting
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

// Build details
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

// ✅ RENDER DIRECTLY — NO REDIRECT
return res.render("parent/org_attempt_detail", {
  org,
  attempt,
  details,
  user: child
});

  }
);

















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
// ✅ Resolve child via ExamInstance (SOURCE OF TRUTH)
// ✅ Ownership check — SIMPLE AND CORRECT
const child = await User.findOne({
  _id: attempt.userId,
  parentUserId: req.user._id,
  role: "student"
}).lean();

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



// ⚠️ TEMP FIX — BACKFILL ATTEMPT QUIZ TITLES
router.get(
  "/admin/fix-attempt-quiz-titles",
  ensureAuth,
  async (req, res) => {
    try {
      const Attempt = (await import("../models/attempt.js")).default;
      const ExamInstance = (await import("../models/examInstance.js")).default;
      const QuizRule = (await import("../models/quizRule.js")).default;

      let updated = 0;

      const attempts = await Attempt.find({
        $or: [
          { quizTitle: { $exists: false } },
          { quizTitle: null },
          { quizTitle: "" }
        ],
        examId: { $exists: true }
      });

      for (const attempt of attempts) {
        // 1️⃣ Try ExamInstance first
        const exam = await ExamInstance.findOne({
          examId: attempt.examId
        }).lean();

        if (exam?.quizTitle) {
          attempt.quizTitle = exam.quizTitle;
          await attempt.save();
          updated++;
          continue;
        }

        // 2️⃣ Fallback → QuizRule
        if (exam?.ruleId) {
          const rule = await QuizRule.findById(exam.ruleId).lean();
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
