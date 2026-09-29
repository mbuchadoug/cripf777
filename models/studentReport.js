// models/studentReport.js — a teacher's written report/comment on a learner,
// visible to the learner and their parents.
import mongoose from "mongoose";
const StudentReportSchema = new mongoose.Schema({
  teacher: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
  student: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
  title: { type: String, default: "Progress note" },
  body: { type: String, required: true },
  subject: { type: String, default: null },
  rating: { type: Number, min: 1, max: 5, default: null }
}, { timestamps: true });
StudentReportSchema.index({ student: 1, createdAt: -1 });
export default mongoose.models.StudentReport || mongoose.model("StudentReport", StudentReportSchema);