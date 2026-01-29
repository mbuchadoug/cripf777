import mongoose from "mongoose";

const QuizRuleSchema = new mongoose.Schema({
  org: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Organization",
    required: true,
    index: true
  },

  grade: {
    type: Number,
    required: true,
    index: true
  },

  subject: {
    type: String,
    enum: ["math", "english", "science"],
    required: true,
    index: true
  },

  isTrial: {
    type: Boolean,
    default: true,
    index: true
  },

  questionCount: {
    type: Number,
    default: 10
  },

  title: {
    type: String,
    required: true
  },

  enabled: {
    type: Boolean,
    default: true
  },

  createdAt: {
    type: Date,
    default: Date.now
  }
});

const QuizRule =
  mongoose.models.QuizRule || mongoose.model("QuizRule", QuizRuleSchema);

export default QuizRule;
