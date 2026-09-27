// routes/mobileTeacher.js
// ─────────────────────────────────────────────────────────────────────────────
// Private-teacher portal for the mobile app. Additive — the working parent/
// student/school flows are untouched. A private_teacher already manages students
// and sees their progress via /api/mobile/school; this adds the teacher's own
// quiz library: generate an AI quiz, preview it, and assign it to students.
//
//   GET  /students            — my students + last score
//   GET  /quizzes             — my AI-quiz library (+ remaining AI credits)
//   GET  /quizzes/:id         — preview one quiz (I own it)
//   POST /quizzes/generate    — AI-generate a new quiz (uses a credit)
//   POST /assign              — assign a quiz to my students
//   GET  /overview            — class-at-a-glance
//
// Mount in server.js (before /api/mobile):
//   import mobileTeacherRouter from "./routes/mobileTeacher.js";
//   app.use("/api/mobile/teacher", mobileTeacherRouter);
// ─────────────────────────────────────────────────────────────────────────────
import express, { Router } from "express";
import mongoose from "mongoose";
import User from "../models/user.js";
import ExamInstance from "../models/examInstance.js";
import AIQuiz from "../models/aiQuiz.js";
import { requireMobileAuth } from "./mobileApi.js";
import { generateAIQuiz, assignAIQuizToStudents } from "../services/aiQuizGenerator.js";
import { linkedLearnerIds, isLinked } from "../services/learnerLinks.js";
import Organization from "../models/organization.js";
import QuizRule from "../models/quizRule.js";
import { assignQuizFromRule } from "../services/quizAssignment.js";

const router = Router();
router.use(express.json({ limit: "1mb" }));

function ensureTeacher(req, res, next) {
  const u = req.mobileUser;
  const ok = u && (
    ["private_teacher", "teacher"].includes(u.role) ||
    u.activeMobileRole === "teacher" ||
    (Array.isArray(u.mobileRoles) && u.mobileRoles.includes("teacher"))
  );
  if (!ok) return res.status(403).json({ error: "Switch to your Teacher profile to use this." });
  next();
}
const nameOf = (u) => u.displayName || [u.firstName, u.lastName].filter(Boolean).join(" ") || u.username || "Learner";

// ── My students (+ their most recent score) ─────────────────────────────────
router.get("/students", requireMobileAuth, ensureTeacher, async (req, res) => {
  try {
    const linkedIds = await linkedLearnerIds(req.mobileUser._id, "teacher");
    const students = await User.find({ $or: [ { parentUserId: req.mobileUser._id, role: "student" }, { _id: { $in: linkedIds }, role: "student" } ] })
      .select("displayName firstName lastName username grade createdAt").sort({ createdAt: -1 }).lean();
    const ids = students.map((s) => s._id);
    const attempts = ids.length
      ? await ExamInstance.find({ userId: { $in: ids }, status: "finished" }).select("userId meta updatedAt").sort({ updatedAt: -1 }).lean()
      : [];
    const last = {};
    for (const a of attempts) { const k = String(a.userId); if (!last[k]) last[k] = { pct: a.meta?.percentage ?? null, when: a.meta?.finishedAt || a.updatedAt }; }
    res.json({
      students: students.map((s) => ({
        id: String(s._id), name: nameOf(s), username: s.username || "", grade: s.grade ?? null,
        lastScore: last[String(s._id)]?.pct ?? null, lastAt: last[String(s._id)]?.when || null
      }))
    });
  } catch (e) { console.error("[mobile teacher students]", e); res.status(500).json({ error: "Failed to load students" }); }
});

// ── My AI-quiz library ───────────────────────────────────────────────────────
router.get("/quizzes", requireMobileAuth, ensureTeacher, async (req, res) => {
  try {
    // 1) The teacher's own AI-generated quizzes
    const ai = await AIQuiz.find({ teacherId: req.mobileUser._id }).sort({ createdAt: -1 }).lean();

    // 2) The uploaded LIBRARY quizzes (QuizRule under cripfcnt-home), like the web.
    //    Filter by the teacher's enabled levels if set, else show all grades.
    let library = [];
    const homeOrg = await Organization.findOne({ slug: "cripfcnt-home" }).lean();
    if (homeOrg) {
      const levels = req.mobileUser.schoolLevelsEnabled || [];
      const ranges = [];
      if (levels.includes("junior")) ranges.push({ $gte: 1, $lte: 7 });
      if (levels.includes("high")) ranges.push({ $gte: 8, $lte: 13 });
      let gradeQuery = {};
      if (ranges.length === 1) gradeQuery = { grade: ranges[0] };
      else if (ranges.length === 2) gradeQuery = { $or: ranges.map((r) => ({ grade: r })) };
      library = await QuizRule.find({ org: homeOrg._id, enabled: true, ...gradeQuery })
        .select("quizTitle subject grade module questionCount durationMinutes").sort({ grade: 1 }).lean();
    }

    const quizzes = [
      ...ai.map((q) => ({
        source: "ai", id: String(q._id), title: q.title, subject: q.subject, grade: q.grade,
        topic: q.topic, difficulty: q.difficulty, questionCount: q.questionCount || (q.questions || []).length,
        assignedCount: (q.assignedTo || []).length, createdAt: q.createdAt
      })),
      ...library.map((r) => ({
        source: "library", id: String(r._id), title: r.quizTitle || "Quiz", subject: r.subject || null,
        grade: r.grade, questionCount: r.questionCount || 10
      }))
    ];

    res.json({ credits: req.mobileUser.aiQuizCredits ?? 0, aiCount: ai.length, libraryCount: library.length, quizzes });
  } catch (e) { console.error("[mobile teacher quizzes]", e); res.status(500).json({ error: "Failed to load quizzes" }); }
});

// ── Preview one quiz (teacher owns it, so answers are fine to show) ──────────
router.get("/quizzes/:id", requireMobileAuth, ensureTeacher, async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: "Invalid quiz id" });
    const quiz = await AIQuiz.findOne({ _id: req.params.id, teacherId: req.mobileUser._id }).lean();
    if (quiz) {
      return res.json({
        source: "ai", id: String(quiz._id), title: quiz.title, subject: quiz.subject, grade: quiz.grade,
        topic: quiz.topic, difficulty: quiz.difficulty, assignedCount: (quiz.assignedTo || []).length, passage: null,
        questions: (quiz.questions || []).map((q) => ({ text: q.text, choices: q.choices, correctIndex: q.correctIndex, explanation: q.explanation }))
      });
    }

    // Not an AI quiz → try the uploaded library (QuizRule → comprehension passage + children)
    const rule = await QuizRule.findById(req.params.id).lean();
    if (rule) {
      const Question = (await import("../models/question.js")).default;
      const parent = await Question.findById(rule.quizQuestionId).lean();
      let questions = [];
      let passage = null;
      if (parent) {
        passage = parent.passage || parent.text || null;
        const childIds = parent.type === "comprehension" && Array.isArray(parent.questionIds) ? parent.questionIds : [];
        if (childIds.length) {
          const kids = await Question.find({ _id: { $in: childIds } }).lean();
          const byId = {}; for (const k of kids) byId[String(k._id)] = k;
          questions = childIds.map((id) => byId[String(id)]).filter(Boolean).map((k) => ({
            text: k.text,
            choices: (k.choices || []).map((c) => (typeof c === "string" ? c : c.text)),
            correctIndex: k.answerIndex ?? k.correctIndex ?? null,
            explanation: k.explanation || ""
          }));
        } else if (parent.type !== "comprehension") {
          questions = [{ text: parent.text, choices: (parent.choices || []).map((c) => (typeof c === "string" ? c : c.text)), correctIndex: parent.answerIndex ?? null, explanation: parent.explanation || "" }];
        }
      }
      return res.json({
        source: "library", id: String(rule._id), title: rule.quizTitle || "Quiz",
        subject: rule.subject || null, grade: rule.grade, passage, questions
      });
    }

    return res.status(404).json({ error: "Quiz not found" });
  } catch (e) { console.error("[mobile teacher preview]", e); res.status(500).json({ error: "Failed to load preview" }); }
});

// ── Generate a new AI quiz (uses one credit; same service as the web) ────────
router.post("/quizzes/generate", requireMobileAuth, ensureTeacher, async (req, res) => {
  try {
    const { subject, grade, topic, difficulty, questionCount } = req.body || {};
    if (!subject || grade == null || String(grade) === "" || !topic) {
      return res.status(400).json({ error: "Subject, grade and topic are required." });
    }
    const quiz = await generateAIQuiz({
      teacherId: req.mobileUser._id, subject: String(subject), grade: Number(grade),
      topic: String(topic), difficulty: difficulty || "medium", questionCount: Number(questionCount) || 10
    });
    res.json({ ok: true, quiz: { id: String(quiz._id), title: quiz.title, questionCount: quiz.questionCount } });
  } catch (e) { console.error("[mobile teacher generate]", e); res.status(400).json({ error: e.message || "Could not generate the quiz." }); }
});

// ── Assign a quiz to my students (verifies the students are mine) ────────────
router.post("/assign", requireMobileAuth, ensureTeacher, async (req, res) => {
  try {
    const body = req.body || {};
    const quizId = body.quizId || body.aiQuizId;               // back-compat
    const source = body.source === "library" ? "library" : "ai";
    const studentIds = body.studentIds;
    if (!quizId || !mongoose.isValidObjectId(quizId)) return res.status(400).json({ error: "Choose a quiz." });
    if (!Array.isArray(studentIds) || !studentIds.length) return res.status(400).json({ error: "Choose at least one student." });

    // Only the teacher's own students (created or linked)
    const linkedIds = (await linkedLearnerIds(req.mobileUser._id, "teacher")).map(String);
    const found = await User.find({ _id: { $in: studentIds }, role: "student" }).select("_id parentUserId").lean();
    const ownedIds = found.filter((s) => String(s.parentUserId) === String(req.mobileUser._id) || linkedIds.includes(String(s._id))).map((s) => String(s._id));
    if (!ownedIds.length) return res.status(403).json({ error: "Those students aren't in your class." });

    if (source === "library") {
      // Uploaded QuizRule quiz → assign to each student, same engine as the web/admin.
      const rule = await QuizRule.findById(quizId).lean();
      if (!rule) return res.status(404).json({ error: "Quiz not found in the library." });
      let assigned = 0;
      for (const sid of ownedIds) {
        try { await assignQuizFromRule({ rule, userId: sid, orgId: rule.org, force: true }); assigned++; } catch (_) {}
      }
      return res.json({ ok: true, assigned, skipped: ownedIds.length - assigned });
    }

    // AI quiz
    const assignments = await assignAIQuizToStudents({ aiQuizId: quizId, studentIds: ownedIds, teacherId: req.mobileUser._id });
    res.json({ ok: true, assigned: assignments.length, skipped: ownedIds.length - assignments.length });
  } catch (e) { console.error("[mobile teacher assign]", e); res.status(400).json({ error: e.message || "Could not assign the quiz." }); }
});

// ── Class overview ───────────────────────────────────────────────────────────
router.get("/overview", requireMobileAuth, ensureTeacher, async (req, res) => {
  try {
    const linkedIds = await linkedLearnerIds(req.mobileUser._id, "teacher");
    const students = await User.find({ $or: [ { parentUserId: req.mobileUser._id, role: "student" }, { _id: { $in: linkedIds }, role: "student" } ] }).select("_id").lean();
    const ids = students.map((s) => s._id);
    const finished = ids.length ? await ExamInstance.find({ userId: { $in: ids }, status: "finished" }).select("meta").lean() : [];
    const scores = finished.map((f) => f.meta?.percentage).filter((n) => typeof n === "number");
    const avg = scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null;
    const quizCount = await AIQuiz.countDocuments({ teacherId: req.mobileUser._id });

    // Make sure this teacher's monthly AI credits are granted so the hub isn't stuck at 0.
    let credits = req.mobileUser.aiQuizCredits ?? 0;
    try {
      const t = await User.findById(req.mobileUser._id);
      if (t && typeof t.resetAIQuizCredits === "function") {
        const before = t.aiQuizCredits || 0;
        t.resetAIQuizCredits();
        if ((t.aiQuizCredits || 0) !== before) await t.save();
        credits = t.aiQuizCredits || 0;
      }
    } catch (_) {}

    res.json({ students: ids.length, quizzesCreated: quizCount, assessmentsTaken: finished.length, averageScore: avg, credits });
  } catch (e) { console.error("[mobile teacher overview]", e); res.status(500).json({ error: "Failed" }); }
});

export default router;