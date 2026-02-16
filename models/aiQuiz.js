// models/aiQuiz.js
import mongoose from "mongoose";

const AIQuizSchema = new mongoose.Schema(
  {
    teacherId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true
    },

    title: {
      type: String,
      required: true
    },

    subject: {
      type: String,
      required: true,
      index: true
    },

    grade: {
      type: Number,
      required: true,
      index: true
    },

    topic: {
      type: String,
      required: true
    },

    difficulty: {
      type: String,
      enum: ["easy", "medium", "hard"],
      required: true
    },

    questionCount: {
      type: Number,
      default: 10
    },

    // Generated questions stored as array
    questions: {
      type: [mongoose.Schema.Types.Mixed],
      default: []
    },

    // Track which students this has been assigned to
    assignedTo: [{
      studentId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User"
      },
      assignedAt: {
        type: Date,
        default: Date.now
      }
    }],

    aiProvider: {
      type: String,
      default: "anthropic"
    },

    generatedAt: {
      type: Date,
      default: Date.now
    },

    status: {
      type: String,
      enum: ["draft", "active", "archived"],
      default: "active",
      index: true
    }
  },
  {
    timestamps: true
  }
);

AIQuizSchema.index({ teacherId: 1, subject: 1, grade: 1 });

const AIQuiz = mongoose.models.AIQuiz || mongoose.model("AIQuiz", AIQuizSchema);
export default AIQuiz;