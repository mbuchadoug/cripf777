// services/studentDashboardData.js
import ExamInstance from "../models/examInstance.js";
import Attempt from "../models/attempt.js";
import Certificate from "../models/certificate.js";
import { getStudentKnowledgeMap } from "../services/topicMasteryTracker.js";
import QuizRule from "../models/quizRule.js";


const HOME_ORG_SLUG = "cripfcnt-home";

function normaliseSubject(subject) {
  if (!subject) return "General";
  const map = {
    math: "Mathematics", maths: "Mathematics",
    english: "English", science: "Science",
    responsibility: "Responsibility"
  };
  return map[String(subject).toLowerCase()] || subject;
}

export async function buildStudentDashboardData({ userId, org }) {
let exams = [];

// ✅ Try org-specific first (covers different possible field names)
if (org?._id) {
  exams = await ExamInstance.find({
    userId,
    $or: [
      { orgId: org._id },
      { organization: org._id },
      { org: org._id }
    ]
  })
    .sort({ createdAt: -1 })
    .lean();
}

// ✅ Fallback: old behavior
if (!exams.length) {
  exams = await ExamInstance.find({ userId })
    .sort({ createdAt: -1 })
    .lean();
}


  const examById = {};
  for (const ex of exams) examById[String(ex.examId)] = ex;

  const rawAttempts = await Attempt.find({
    userId,
    status: "finished"
  }).sort({ finishedAt: -1 }).lean();

  // progress + subject stats
  const progressData = [];
  const subjectStats = {};
  let passCount = 0, failCount = 0;

  for (const a of rawAttempts) {
    const pct = a.maxScore ? Math.round((a.score / a.maxScore) * 100) : 0;
    progressData.push({ date: a.finishedAt, score: pct });
    a.passed ? passCount++ : failCount++;

    const exam = examById[String(a.examId)];
const rawSubject = exam ? await resolveSubject(exam) : "general";
const subject = normaliseSubject(rawSubject);

    if (!subjectStats[subject]) subjectStats[subject] = { total: 0, count: 0 };
    subjectStats[subject].total += pct;
    subjectStats[subject].count++;
  }

  const subjectChartData = Object.entries(subjectStats).map(
    ([subject, v]) => ({ subject, avg: Math.round(v.total / v.count) })
  );

  let avgScore = null, trend = "N/A", strongestSubject = null, weakestSubject = null;

  if (progressData.length) {
    avgScore = Math.round(progressData.reduce((s, p) => s + p.score, 0) / progressData.length);
    if (progressData.length >= 2) {
      const first = progressData[progressData.length - 1].score;
      const last = progressData[0].score;
      trend = last > first ? "Improving" : last < first ? "Declining" : "Stable";
    }
  }

  if (subjectChartData.length) {
    const sorted = [...subjectChartData].sort((a, b) => b.avg - a.avg);
    strongestSubject = sorted[0].subject;
    if (sorted.length > 1 && sorted[sorted.length - 1].avg < 60) {
      weakestSubject = sorted[sorted.length - 1].subject;
    }
  }

  const attempts = rawAttempts.map(a => ({
    _id: a._id,
    examId: a.examId,
    quizTitle: a.quizTitle || "Quiz",
    percentage: a.maxScore ? Math.round((a.score / a.maxScore) * 100) : 0,
    passed: !!a.passed,
    finishedAt: a.finishedAt
  }));

  // practice grouping (completed vs pending)
  const attemptCountByExam = {};
  const lastAttemptByExam = {};

  for (const a of rawAttempts) {
    const eid = String(a.examId);
    attemptCountByExam[eid] = (attemptCountByExam[eid] || 0) + 1;

    if (!lastAttemptByExam[eid] || new Date(a.finishedAt) > new Date(lastAttemptByExam[eid].finishedAt)) {
      lastAttemptByExam[eid] = a;
    }
  }

  let quizzesBySubject = null;
  let practiceQuizzesBySubject = null;

async function resolveSubject(exam) {
  // 1) Prefer subject stored on the exam instance itself
  if (exam?.meta?.subject) return exam.meta.subject;
  if (exam?.meta?.ruleSubject) return exam.meta.ruleSubject;

  // 2) If exam came from a rule, pull subject from the rule
  if (exam?.ruleId) {
    const rule = await QuizRule.findById(exam.ruleId).lean();
    if (rule?.subject) return rule.subject;
  }

  // 3) Fallback
  return "general";
}



 if (org.slug === HOME_ORG_SLUG) {
  quizzesBySubject = {};
  practiceQuizzesBySubject = {};

  // ✅ async-safe loop (because resolveSubject can hit DB)
  for (const ex of exams) {
    const examId = String(ex.examId);

    const rawSubject = await resolveSubject(ex);
    const subject = normaliseSubject(rawSubject);

    const attemptCount = attemptCountByExam[examId] || 0;
    const lastAttempt = lastAttemptByExam[examId];

    const quizData = {
      examId: ex.examId,
      quizTitle: ex.quizTitle || "Quiz",
      attemptCount,
      lastScore: lastAttempt
        ? Math.round((lastAttempt.score / lastAttempt.maxScore) * 100)
        : null,
      lastAttemptDate: lastAttempt ? lastAttempt.finishedAt : null,
      passed: lastAttempt ? lastAttempt.passed : false
    };

    // pending vs practice grouping
    if (attemptCount === 0) {
      if (!quizzesBySubject[subject]) quizzesBySubject[subject] = [];
      quizzesBySubject[subject].push(quizData);
    } else {
      if (!practiceQuizzesBySubject[subject]) practiceQuizzesBySubject[subject] = [];
      practiceQuizzesBySubject[subject].push(quizData);
    }
  }
}


  const certificates = await Certificate.find({ userId, orgId: org._id })
    .sort({ issuedAt: -1, createdAt: -1 }).lean();

  const totalPending = await ExamInstance.countDocuments({
    userId,
    status: { $ne: "finished" }
  });

  // knowledge map (optional)
  let knowledgeMap = null;
  // NOTE: you pass grade externally or read it outside
  // We'll leave this to caller if they want grade gating.

  return {
    exams,
    rawAttempts,
    quizzesBySubject,
    practiceQuizzesBySubject,
    attempts,
    progressData,
    subjectChartData,
    passCount,
    failCount,
    avgScore,
    trend,
    strongestSubject,
    weakestSubject,
    totalPending,
    certificates,
    knowledgeMap
  };
}
