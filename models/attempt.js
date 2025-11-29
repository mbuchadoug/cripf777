import mongoose from "mongoose";
const AttemptSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", index: true },
  quizId: { type: mongoose.Schema.Types.ObjectId, ref: "Quiz", index: true },
  answers: [{ questionId: mongoose.Schema.Types.ObjectId, answer: mongoose.Schema.Types.Mixed }],
  score: Number,
  maxScore: Number,
  passed: Boolean,
  startedAt: Date,
  finishedAt: Date
}, { timestamps: true });
export default mongoose.models.Attempt || mongoose.model("Attempt", AttemptSchema);
