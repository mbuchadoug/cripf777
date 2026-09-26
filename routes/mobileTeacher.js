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

const router = Router();
router.use(express.json({ limit: "1mb" }));

function ensureTeacher(req, res, next) {
  if (!req.mobileUser || req.mobileUser.role !== "private_teacher") {
    return res.status(403).json({ error: "For private teachers only." });
  }
  next();
}
const nameOf = (u) => u.displayName || [u.firstName, u.lastName].filter(Boolean).join(" ") || u.username || "Learner";

// ── My students (+ their most recent score) ─────────────────────────────────
router.get("/students", requireMobileAuth, ensureTeacher, async (req, res) => {
  try {
    const students = await User.find({ parentUserId: req.mobileUser._id, role: "student" })
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
    const quizzes = await AIQuiz.find({ teacherId: req.mobileUser._id }).sort({ createdAt: -1 }).lean();
    res.json({
      credits: req.mobileUser.aiQuizCredits ?? 0,
      quizzes: quizzes.map((q) => ({
        id: String(q._id), title: q.title, subject: q.subject, grade: q.grade, topic: q.topic,
        difficulty: q.difficulty, questionCount: q.questionCount || (q.questions || []).length,
        assignedCount: (q.assignedTo || []).length, createdAt: q.createdAt
      }))
    });
  } catch (e) { console.error("[mobile teacher quizzes]", e); res.status(500).json({ error: "Failed to load quizzes" }); }
});

// ── Preview one quiz (teacher owns it, so answers are fine to show) ──────────
router.get("/quizzes/:id", requireMobileAuth, ensureTeacher, async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: "Invalid quiz id" });
    const quiz = await AIQuiz.findOne({ _id: req.params.id, teacherId: req.mobileUser._id }).lean();
    if (!quiz) return res.status(404).json({ error: "Quiz not found" });
    res.json({
      id: String(quiz._id), title: quiz.title, subject: quiz.subject, grade: quiz.grade,
      topic: quiz.topic, difficulty: quiz.difficulty, assignedCount: (quiz.assignedTo || []).length,
      questions: (quiz.questions || []).map((q) => ({ text: q.text, choices: q.choices, correctIndex: q.correctIndex, explanation: q.explanation }))
    });
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
    const { aiQuizId, studentIds } = req.body || {};
    if (!aiQuizId || !mongoose.isValidObjectId(aiQuizId)) return res.status(400).json({ error: "Choose a quiz." });
    if (!Array.isArray(studentIds) || !studentIds.length) return res.status(400).json({ error: "Choose at least one student." });

    const owned = await User.find({ _id: { $in: studentIds }, parentUserId: req.mobileUser._id, role: "student" }).select("_id").lean();
    const ownedIds = owned.map((s) => String(s._id));
    if (!ownedIds.length) return res.status(403).json({ error: "Those students aren't in your class." });

    const assignments = await assignAIQuizToStudents({ aiQuizId, studentIds: ownedIds, teacherId: req.mobileUser._id });
    res.json({ ok: true, assigned: assignments.length, skipped: ownedIds.length - assignments.length });
  } catch (e) { console.error("[mobile teacher assign]", e); res.status(400).json({ error: e.message || "Could not assign the quiz." }); }
});

// ── Class overview ───────────────────────────────────────────────────────────
router.get("/overview", requireMobileAuth, ensureTeacher, async (req, res) => {
  try {
    const students = await User.find({ parentUserId: req.mobileUser._id, role: "student" }).select("_id").lean();
    const ids = students.map((s) => s._id);
    const finished = ids.length ? await ExamInstance.find({ userId: { $in: ids }, status: "finished" }).select("meta").lean() : [];
    const scores = finished.map((f) => f.meta?.percentage).filter((n) => typeof n === "number");
    const avg = scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null;
    const quizCount = await AIQuiz.countDocuments({ teacherId: req.mobileUser._id });
    res.json({ students: ids.length, quizzesCreated: quizCount, assessmentsTaken: finished.length, averageScore: avg, credits: req.mobileUser.aiQuizCredits ?? 0 });
  } catch (e) { console.error("[mobile teacher overview]", e); res.status(500).json({ error: "Failed" }); }
});

export default router;