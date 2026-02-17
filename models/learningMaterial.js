import mongoose from "mongoose";

const learningMaterialSchema = new mongoose.Schema({
  teacherId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  title: { type: String, required: true },
  subject: { type: String, required: true },
  grade: { type: Number, required: true },
  description: { type: String, default: "" },
  content: { type: String, default: null },
  fileUrl: { type: String, default: null },
  fileType: { type: String, default: null },
  assignedTo: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
  status: { type: String, default: "active", enum: ["active", "archived"] }
}, { timestamps: true });

export default mongoose.model("LearningMaterial", learningMaterialSchema);