// models/question.js (UPDATED FOR ADAPTIVE LEARNING - cripfcnt-home only)
import mongoose from "mongoose";

const ChoiceSchema = new mongoose.Schema({
  label: String,
  text: String
}, { _id: false });

const QuestionSchema = new mongoose.Schema({
  text: { type: String, required: true },

  // for regular questions
  choices: [ChoiceSchema],
  correctIndex: { type: Number, required: function() { return this.type !== 'comprehension'; } },
  title: { type: String, default: null },

  // ==============================
  // 🎯 ADAPTIVE LEARNING FIELDS (cripfcnt-home only)
  // ==============================
  
  // Micro-topic (e.g., "fractions", "multiplication", "verb-tenses")
  topic: {
    type: String,
    lowercase: true,
    trim: true,
    index: true,
    default: null
  },

  // Subject (math, english, science, responsibility)
  subject: {
    type: String,
    lowercase: true,
    trim: true,
    index: true,
    default: null
  },

  // Grade level (1-7)
  grade: {
    type: Number,
    min: 1,
    max: 7,
    index: true,
    default: null
  },

  // Difficulty level (1=easiest, 5=hardest)
  difficulty: {
    type: Number,
    min: 1,
    max: 5,
    default: null,
    index: true
  },

  // ==============================
  // EXISTING FIELDS
  // ==============================

  // NEW: comprehension parent support
  type: { type: String, enum: ["question","comprehension"], default: "question", index: true },
  passage: { type: String, default: null }, // full passage for comprehension parent
  questionIds: [{ type: mongoose.Schema.Types.ObjectId, ref: "Question" }], // child IDs for parent

  // metadata
  organization: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: "Organization",
    default: null,
    index: true
  },
  module: {
    type: String,
    default: "general",
    index: true
  },

  tags: [String],
  source: { type: String, default: "import" },
  raw: { type: String, default: null },
  createdAt: { type: Date, default: () => new Date() }
});

// ==============================
// INDEXES FOR ADAPTIVE QUERIES
// ==============================
QuestionSchema.index({ subject: 1, topic: 1, difficulty: 1, grade: 1 });
QuestionSchema.index({ subject: 1, grade: 1, topic: 1 });
QuestionSchema.index({ organization: 1, subject: 1, topic: 1 });
QuestionSchema.index({ topic: 1, difficulty: 1 });

export default mongoose.models.Question || mongoose.model("Question", QuestionSchema);
