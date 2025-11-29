// models/quizQuestion.js
import mongoose from "mongoose";

const ChoiceSchema = new mongoose.Schema({
  text: { type: String, required: true },
}, { _id: false });

const QuizQuestionSchema = new mongoose.Schema({
  text: { type: String, required: true, trim: true },
  // Array of exactly 4 choices. UI enforces length 4.
  choices: { type: [ChoiceSchema], required: true, validate: v => Array.isArray(v) && v.length === 4 },
  // index 0..3 of the correct choice (stored, not sent to clients)
  answerIndex: { type: Number, required: true, min: 0, max: 3 },
  // optional metadata
  tags: { type: [String], default: [] },
  difficulty: { type: String, enum: ["easy","medium","hard"], default: "medium" },
  source: { type: String, default: "manual" },
  createdBy: { type: String, default: null }, // admin email or id
  createdAt: { type: Date, default: Date.now }
}, { timestamps: true });

// Index tags/difficulty for searching
QuizQuestionSchema.index({ tags: 1 });
QuizQuestionSchema.index({ difficulty: 1 });

export default mongoose.models.QuizQuestion || mongoose.model("QuizQuestion", QuizQuestionSchema);
