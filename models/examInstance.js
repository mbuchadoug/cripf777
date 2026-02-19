// models/examInstance.js
import mongoose from "mongoose";

const ExamInstanceSchema = new mongoose.Schema(
  {
    examId: { type: String, required: true, index: true },

    ruleId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "QuizRule",
      index: true,
      default: null
    },

    // Public attempt mode (TikTok / creator link)
    isPublic: { type: Boolean, default: false, index: true },

    isOnboarding: { type: Boolean, default: false, index: true },

    org: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Organization",
      index: true,
      default: null
    },

    module: { type: String, default: null, index: true },

    modules: [{ type: String, index: true }],

    // Assigned user (required for normal exams)
    // Public exams can have userId null
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: function () {
        return !this.isPublic;
      },
      index: true,
      default: null
    },

    // Consumer mode: learner profile (null for org quizzes)
    learnerProfileId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "LearnerProfile",
      default: null,
      index: true
    },

    // Quiz title
    title: { type: String, default: null },
    quizTitle: { type: String, default: null },

    // target role / status
    targetRole: { type: String, default: "student" },
    status: { type: String, default: "pending", index: true }, // pending | started | finished

    durationMinutes: { type: Number, default: 0 },

    // question set + ordering
    questionIds: [{ type: mongoose.Schema.Types.Mixed }],
    choicesOrder: [{ type: [Number] }],

    // optional metadata
    meta: { type: mongoose.Schema.Types.Mixed, default: {} }
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true }
  }
);

export default mongoose.models.ExamInstance || mongoose.model("ExamInstance", ExamInstanceSchema);
