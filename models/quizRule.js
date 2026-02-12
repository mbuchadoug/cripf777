// models/quizRule.js
import mongoose from "mongoose";

const QuizRuleSchema = new mongoose.Schema({
  org: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Organization",
    index: true,
    required: true
  },

  // ✅ OPTIONAL for cripfcnt-school
  // ✅ STILL USED for cripfcnt-home
subject: { type: String, default: null, index: true },

  quizTitle: {
    type: String,
    required: true
  },

  // ✅ OPTIONAL for cripfcnt-school
  // ✅ STILL USED for cripfcnt-home
  grade: { type: Number, default: null, index: true },

  // ✅ Keep required (both orgs use module)
  // If you truly want module optional too for school rules, we can relax it later,
  // but keeping it required keeps your rules organized.
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

/**
 * ✅ Indexing strategy:
 *
 * - Your old index `{ org:1, grade:1, module:1, quizType:1 }` assumes grade always exists.
 * - Now grade can be null → that index is not ideal (still works, but less meaningful for school).
 *
 * Best approach: keep TWO indexes:
 * 1) Home-style lookup: org + grade + module + quizType
 * 2) School-style lookup: org + module + quizType
 *
 * MongoDB will still index docs with grade=null for index #1, but index #2 gives you clean school queries.
 */
QuizRuleSchema.index({ org: 1, grade: 1, module: 1, quizType: 1 });
QuizRuleSchema.index({ org: 1, module: 1, quizType: 1 });

export default mongoose.models.QuizRule ||
  mongoose.model("QuizRule", QuizRuleSchema);
