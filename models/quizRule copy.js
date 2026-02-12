// models/quizRule.js
import mongoose from "mongoose";

const QuizRuleSchema = new mongoose.Schema({
  org: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Organization",
    index: true,
    required: true
  },
subject: {
  type: String,
  required: true,
  index: true
},

quizTitle: {
  type: String,
  required: true
},


  grade: {
    type: Number,
    required: true,
    index: true
  },

  module: {
    type: String,
    required: true,
    index: true
  },

quizQuestionId: {
  type: mongoose.Schema.Types.ObjectId,
  ref: "Question",
  required: true
},

  quizType: {
    type: String,
    enum: ["trial", "paid"],
    required: true,
    index: true
  },

  questionCount: {
    type: Number,
    default: 10
  },

  durationMinutes: {
    type: Number,
    default: 30
  },

  enabled: {
    type: Boolean,
    default: true,
    index: true
  },

  createdAt: {
    type: Date,
    default: Date.now
  }
});

QuizRuleSchema.index({ org: 1, grade: 1, module: 1, quizType: 1 });

export default mongoose.models.QuizRule ||
  mongoose.model("QuizRule", QuizRuleSchema);
