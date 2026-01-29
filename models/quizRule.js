import mongoose from "mongoose";

const QuizRuleSchema = new mongoose.Schema({
  org: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Organization",
    default: null // null = platform-wide
  },

  grade: {
    type: Number,
    required: true
  },

  subject: {
    type: String,
    enum: ["math", "english", "science"],
    required: true
  },

  type: {
    type: String,
    enum: ["trial", "paid"],
    required: true
  },

  questionSource: {
    type: String,
    enum: ["module", "passage"],
    required: true
  },

  module: {
    type: String,
    default: null
  },

  passageId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Question",
    default: null
  },

  count: {
    type: Number,
    default: 10
  },

  durationMinutes: {
    type: Number,
    default: 20
  },

  active: {
    type: Boolean,
    default: true
  }
}, { timestamps: true });

export default mongoose.model("QuizRule", QuizRuleSchema);
