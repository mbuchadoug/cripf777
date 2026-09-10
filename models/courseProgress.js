// models/courseProgress.js
// ─────────────────────────────────────────────────────────────────────────────
// Tracks one learner's progress through one Course. It reads the per-quiz
// evidence from existing Attempt records and rolls it up to a course result.
// The completion checker updates this doc; when both gates are met it flips to
// "completed", stamps the classification, and links the issued certificate.
// ─────────────────────────────────────────────────────────────────────────────
import mongoose from "mongoose";

const QuizProgressSchema = new mongoose.Schema({
  quizId: { type: mongoose.Schema.Types.ObjectId, ref: "Question", required: true },
  bestPercentage: { type: Number, default: 0 },
  attempts: { type: Number, default: 0 },
  passed: { type: Boolean, default: false },
  lastAttemptAt: { type: Date, default: null }
}, { _id: false });

const CourseProgressSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
  course: { type: mongoose.Schema.Types.ObjectId, ref: "Course", required: true, index: true },
  org: { type: mongoose.Schema.Types.ObjectId, ref: "Organization", default: null, index: true },

  // persona the course was taken under
  role: { type: String, default: "professional" },

  quizzes: [QuizProgressSchema],

  // rolled-up results
  unitsPassed: [{ type: String }],           // unit titles/ids that met the per-unit gate
  passedCount: { type: Number, default: 0 }, // quizzes individually passed
  overallPercentage: { type: Number, default: 0 },

  status: { type: String, enum: ["in_progress", "completed"], default: "in_progress", index: true },
  classification: { type: String, default: null }, // "Pass" | "Merit" | "Distinction"

  certificate: { type: mongoose.Schema.Types.ObjectId, ref: "CourseCertificate", default: null },
  completedAt: { type: Date, default: null }
}, { timestamps: true });

// One progress doc per user per course
CourseProgressSchema.index({ user: 1, course: 1 }, { unique: true });

export default mongoose.models.CourseProgress ||
  mongoose.model("CourseProgress", CourseProgressSchema);