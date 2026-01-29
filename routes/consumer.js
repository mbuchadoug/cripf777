// routes/consumer.js
import { Router } from "express";
import LearnerProfile from "../models/learnerProfile.js";
import { ensureAuth } from "../middleware/authGuard.js";

const router = Router();

/**
 * Helper: allow only consumer-style accounts
 * (parent, guardian, or student_self)
 */
function ensureConsumer(req, res, next) {
  const role = String(req.user?.role || "").toLowerCase();

  if (!["parent", "guardian", "student_self"].includes(role)) {
    return res.status(403).json({
      error: "Consumer accounts only"
    });
  }
  next();
}

/**
 * =========================================
 * POST /consumer/learners
 * Create a learner (child)
 * =========================================
 */
router.post(
  "/learners",
  ensureAuth,
  ensureConsumer,
  async (req, res) => {
    try {
      const {
        displayName,
        schoolLevel,
        grade,
        subjects = []
      } = req.body || {};

      // ---- validation ----
      if (!displayName || !schoolLevel || !grade) {
        return res.status(400).json({
          error: "displayName, schoolLevel and grade are required"
        });
      }

      if (!["junior", "high"].includes(schoolLevel)) {
        return res.status(400).json({
          error: "Invalid schoolLevel"
        });
      }

      if (!Number.isInteger(Number(grade)) || grade <= 0) {
        return res.status(400).json({
          error: "Invalid grade"
        });
      }

      // ---- create learner ----
      const learner = await LearnerProfile.create({
        parentUserId: req.user._id,
        displayName: String(displayName).trim(),
        schoolLevel,
        grade: Number(grade),
        subjects: Array.isArray(subjects)
          ? subjects.map(s => String(s).toLowerCase())
          : []
      });

      return res.status(201).json({
        ok: true,
        learner
      });
    } catch (err) {
      console.error("[POST /consumer/learners]", err);
      return res.status(500).json({
        error: "Failed to create learner"
      });
    }
  }
);

/**
 * =========================================
 * GET /consumer/learners
 * List learners for logged-in parent
 * =========================================
 */
router.get(
  "/learners",
  ensureAuth,
  ensureConsumer,
  async (req, res) => {
    try {
      const learners = await LearnerProfile.find({
        parentUserId: req.user._id
      })
        .sort({ createdAt: -1 })
        .lean();

      return res.json({
        ok: true,
        learners
      });
    } catch (err) {
      console.error("[GET /consumer/learners]", err);
      return res.status(500).json({
        error: "Failed to load learners"
      });
    }
  }
);

export default router;
