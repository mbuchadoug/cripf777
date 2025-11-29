// models/question.js (example)
import mongoose from "mongoose";
const ChoiceSchema = new mongoose.Schema({
  label: String,    // 'a', 'b', ...
  text: String
}, { _id: false });
const QuestionSchema = new mongoose.Schema({
  text: { type: String, required: true },
  choices: [ChoiceSchema],
  correctIndex: { type: Number, required: true },
  tags: [String],
  difficulty: { type: String, default: null },
  source: { type: String, default: "import" },
  createdAt: { type: Date, default: () => new Date() }
});
export default mongoose.models.Question || mongoose.model("Question", QuestionSchema);
