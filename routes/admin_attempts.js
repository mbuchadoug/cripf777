import express from "express";
import Attempt from "../models/attempt.js";
import ExamInstance from "../models/examInstance.js";
import Organization from "../models/organization.js";
import User from "../models/user.js";
import { ensureAuth } from "../middleware/authGuard.js";

const router = express.Router();

// -------------------------------
// LIST ATTEMPTS FOR AN ORG
// -------------------------------
router.get("/admin/orgs/:slug/attempts", ensureAuth, async (req, res) => {
  try {
    const slug = req.params.slug;
    const org = await Organization.findOne({ slug }).lean();

    if (!org) return res.status(404).send("Org not found.");

    // 🔥 FIX: populate("userId")
    const attempts = await Attempt.find({ organization: org._id })
      .sort({ createdAt: -1 })
      .populate("userId", "email name")   // <---- THIS IS THE FIX
      .lean();

    // also load exam map for fallback
    const examIds = attempts.map(a => a.examId);
    const exams = await ExamInstance.find({ examId: { $in: examIds } })
      .populate("user", "email name")
      .lean();

    const examMap = {};
    for (const e of exams) examMap[e.examId] = e;

    res.render("admin/org_attempts", {
      org,
      attempts,
      examMap,
    });

  } catch (err) {
    console.error("Admin attempts error:", err);
    res.status(500).send("Server error");
  }
});

// -------------------------------
// VIEW SPECIFIC ATTEMPT
// -------------------------------
router.get("/admin/orgs/:slug/attempts/:attemptId", ensureAuth, async (req, res) => {
  try {
    const { slug, attemptId } = req.params;

    const org = await Organization.findOne({ slug }).lean();
    if (!org) return res.status(404).send("Org not found");

    const attempt = await Attempt.findById(attemptId)
      .populate("userId", "email name")
      .lean();

    if (!attempt) return res.status(404).send("Attempt not found");

    const exam = await ExamInstance.findOne({ examId: attempt.examId })
      .populate("user", "email name")
      .lean();

    res.render("admin/org_attempt_detail", {
      org,
      attempt,
      exam,
    });

  } catch (err) {
    console.error(err);
    res.status(500).send("Error loading attempt");
  }
});

export default router;
