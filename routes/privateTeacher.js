// routes/privateTeacher.js
import { Router } from "express";
import { ensureAuth } from "../middleware/authGuard.js";
import User from "../models/user.js";
import AIQuiz from "../models/aiQuiz.js";
import { generateAIQuiz, assignAIQuizToStudents } from "../services/aiQuizGenerator.js";

const router = Router();

// ✅ Middleware: Ensure private teacher
function ensurePrivateTeacher(req, res, next) {
  if (req.user.role !== "private_teacher") {
    return res.status(403).send("Private teachers only");
  }
  next();
}

/**
 * GET /teacher/dashboard
 * Main dashboard for private teachers
 */
router.get(
  "/dashboard",
  ensureAuth,
  ensurePrivateTeacher,
  async (req, res) => {
    const teacher = await User.findById(req.user._id);
    
    // Reset credits if needed
    teacher.resetAIQuizCredits();
    await teacher.save();

    const students = await User.find({
      parentUserId: teacher._id,
      role: "student"
    }).lean();

    const aiQuizzes = await AIQuiz.find({
      teacherId: teacher._id,
      status: "active"
    }).sort({ createdAt: -1 }).lean();

    const ExamInstance = (await import("../models/examInstance.js")).default;
    
    // Get assignment counts
    for (const quiz of aiQuizzes) {
      quiz.assignedCount = await ExamInstance.countDocuments({
        "meta.aiQuizId": quiz._id
      });
    }

    res.render("teacher/dashboard", {
      user: teacher,
      students,
      aiQuizzes,
      studentLimit: teacher.getTeacherChildLimit(),
      planLabel: teacher.getTeacherPlanLabel(),
      aiCredits: teacher.aiQuizCredits,
      canAddStudent: students.length < teacher.getTeacherChildLimit()
    });
  }
);

/**
 * POST /teacher/generate-quiz
 * Generate AI quiz
 */
router.post(
  "/generate-quiz",
  ensureAuth,
  ensurePrivateTeacher,
  async (req, res) => {
    try {
      const { subject, grade, topic, difficulty, questionCount } = req.body;

      if (!subject || !grade || !topic || !difficulty) {
        return res.status(400).json({
          error: "Missing required fields"
        });
      }

      const aiQuiz = await generateAIQuiz({
        teacherId: req.user._id,
        subject,
        grade: Number(grade),
        topic,
        difficulty,
        questionCount: Number(questionCount) || 10
      });

      return res.json({
        success: true,
        quiz: aiQuiz
      });

    } catch (error) {
      console.error("[Generate Quiz Error]", error);
      return res.status(500).json({
        error: error.message
      });
    }
  }
);

/**
 * POST /teacher/assign-quiz
 * Assign AI quiz to students
 */
router.post(
  "/assign-quiz",
  ensureAuth,
  ensurePrivateTeacher,
  async (req, res) => {
    try {
      const { quizId, studentIds } = req.body;

      if (!quizId || !Array.isArray(studentIds) || studentIds.length === 0) {
        return res.status(400).json({
          error: "Quiz ID and student IDs required"
        });
      }

      const assignments = await assignAIQuizToStudents({
        aiQuizId: quizId,
        studentIds,
        teacherId: req.user._id
      });

      return res.json({
        success: true,
        assigned: assignments.length,
        skipped: studentIds.length - assignments.length
      });

    } catch (error) {
      console.error("[Assign Quiz Error]", error);
      return res.status(500).json({
        error: error.message
      });
    }
  }
);

/**
 * GET /teacher/quizzes
 * List all AI-generated quizzes
 */
router.get(
  "/quizzes",
  ensureAuth,
  ensurePrivateTeacher,
  async (req, res) => {
    const quizzes = await AIQuiz.find({
      teacherId: req.user._id,
      status: "active"
    }).sort({ createdAt: -1 }).lean();

    res.render("teacher/quizzes", {
      user: req.user,
      quizzes
    });
  }
);

/**
 * GET /teacher/quiz/:id
 * View single AI quiz with details
 */
router.get(
  "/quiz/:id",
  ensureAuth,
  ensurePrivateTeacher,
  async (req, res) => {
    const quiz = await AIQuiz.findOne({
      _id: req.params.id,
      teacherId: req.user._id
    }).lean();

    if (!quiz) {
      return res.status(404).send("Quiz not found");
    }

    const ExamInstance = (await import("../models/examInstance.js")).default;
    
    const assignments = await ExamInstance.find({
      "meta.aiQuizId": quiz._id
    }).populate("userId", "firstName lastName").lean();

    res.render("teacher/quiz_detail", {
      user: req.user,
      quiz,
      assignments
    });
  }
);



// Add this temporary route to routes/privateTeacher.js (remove after use)
router.get(
  "/reset-credits",
  ensureAuth,
  ensurePrivateTeacher,
  async (req, res) => {
    const teacher = await User.findById(req.user._id);
    
    teacher.teacherSubscriptionPlan = "starter";
    teacher.aiQuizCredits = 20;
    teacher.aiQuizCreditsResetAt = new Date();
    await teacher.save();
    
    res.json({
      success: true,
      credits: teacher.aiQuizCredits,
      plan: teacher.teacherSubscriptionPlan
    });
  }
);

export default router;