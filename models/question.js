import mongoose from "mongoose";
const QuestionSchema = new mongoose.Schema({
  quiz: { type: mongoose.Schema.Types.ObjectId, ref: "Quiz", index: true },
  type: { type: String, enum: ["mcq","multi","short"], default: "mcq" },
  text: String,
  choices: [{ text: String, correct: Boolean }], // for MCQ/multi
  points: { type: Number, default: 1 }
}, { timestamps: true });
export default mongoose.models.Question || mongoose.model("Question", QuestionSchema);
