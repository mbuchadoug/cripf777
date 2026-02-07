// routes/adaptive_quiz_routes.js
import { Router } from "express";
import { ensureAuth } from "../middleware/authGuard.js";
import { canActAsParent } from "../middleware/parentAccess.js";
import User from "../models/user.js";
import { generateAdaptiveQuiz } from "../services/adaptiveQuizEngine.js";
import { 
  getStudentKnowledgeMap, 
  updateTopicMasteryFromAttempt 
} from "../services/topicMasteryTracker.js";

const router = Router();

/**
 * POST /api/adaptive/quiz/generate
 * Generate an adaptive quiz for a student
 * 
 * Body: {
 *   childId: ObjectId,
 *   subject: string,
 *   questionCount: number (optional)
 * }
 */
router.post(
  "/quiz/generate",
  ensureAuth,
  canActAsParent,
  async (req, res) => {
    try {
      const { childId, subject, questionCount } = req.body;

      if (!childId || !subject) {
        return res.status(400).json({
          error: "childId and subject are required"
        });
      }

      // Verify child belongs to parent
      const child = await User.findOne({
        _id: childId,
        parentUserId: req.user._id,
        role: "student"
      }).lean();

      if (!child) {
        return res.status(403).json({
          error: "Child not found or not authorized"
        });
      }

      if (!child.grade) {
        return res.status(400).json({
          error: "Child grade not set"
        });
      }

      // Generate adaptive quiz
      const exam = await generateAdaptiveQuiz({
        userId: child._id,
        subject: subject.toLowerCase(),
        grade: child.grade,
        orgId: child.organization,
        questionCount: questionCount || 10
      });

      return res.json({
        success: true,
        examId: exam.examId,
        quizTitle: exam.quizTitle,
        questionCount: exam.questionIds.length,
        meta: exam.meta,
        message: "Adaptive quiz generated successfully"
      });

    } catch (error) {
      console.error("[AdaptiveQuiz API] Error generating quiz:", error);
      return res.status(500).json({
        error: "Failed to generate adaptive quiz",
        detail: error.message
      });
    }
  }
);

/**
 * GET /api/adaptive/knowledge-map/:childId/:subject
 * Get student's knowledge map for a subject
 */
router.get(
  "/knowledge-map/:childId/:subject",
  ensureAuth,
  canActAsParent,
  async (req, res) => {
    try {
      const { childId, subject } = req.params;

      // Verify child belongs to parent
      const child = await User.findOne({
        _id: childId,
        parentUserId: req.user._id,
        role: "student"
      }).lean();

      if (!child) {
        return res.status(403).json({
          error: "Child not found or not authorized"
        });
      }

      if (!child.grade) {
        return res.status(400).json({
          error: "Child grade not set"
        });
      }

      // Get knowledge map
      const knowledgeMap = await getStudentKnowledgeMap(
        child._id,
        subject.toLowerCase(),
        child.grade
      );

      return res.json({
        success: true,
        data: knowledgeMap
      });

    } catch (error) {
      console.error("[AdaptiveQuiz API] Error getting knowledge map:", error);
      return res.status(500).json({
        error: "Failed to get knowledge map",
        detail: error.message
      });
    }
  }
);

/**
 * POST /api/adaptive/update-mastery
 * Manually trigger topic mastery update for an attempt
 * (Usually called automatically after quiz submission)
 * 
 * Body: {
 *   attemptId: ObjectId
 * }
 */
router.post(
  "/update-mastery",
  ensureAuth,
  async (req, res) => {
    try {
      const { attemptId } = req.body;

      if (!attemptId) {
        return res.status(400).json({
          error: "attemptId is required"
        });
      }

      const result = await updateTopicMasteryFromAttempt(attemptId);

      return res.json({
        success: true,
        updated: result.updated,
        created: result.created,
        topics: result.topics,
        message: "Topic mastery updated successfully"
      });

    } catch (error) {
      console.error("[AdaptiveQuiz API] Error updating mastery:", error);
      return res.status(500).json({
        error: "Failed to update topic mastery",
        detail: error.message
      });
    }
  }
);

/**
 * GET /api/adaptive/subjects/:childId
 * Get available subjects for a child
 */
router.get(
  "/subjects/:childId",
  ensureAuth,
  canActAsParent,
  async (req, res) => {
    try {
      const { childId } = req.params;

      // Verify child belongs to parent
      const child = await User.findOne({
        _id: childId,
        parentUserId: req.user._id,
        role: "student"
      }).lean();

      if (!child) {
        return res.status(403).json({
          error: "Child not found or not authorized"
        });
      }

      // For now, return standard subjects
      // In future, this could be dynamic based on available questions
      const subjects = [
        { value: "math", label: "Mathematics", icon: "📐" },
        { value: "english", label: "English", icon: "📚" },
        { value: "science", label: "Science", icon: "🔬" },
        { value: "responsibility", label: "Responsibility", icon: "🎯" }
      ];

      return res.json({
        success: true,
        subjects
      });

    } catch (error) {
      console.error("[AdaptiveQuiz API] Error getting subjects:", error);
      return res.status(500).json({
        error: "Failed to get subjects",
        detail: error.message
      });
    }
  }
);

export default router;
