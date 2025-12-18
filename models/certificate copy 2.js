import mongoose from "mongoose";

const CertificateSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  orgId: { type: mongoose.Schema.Types.ObjectId, ref: "Organization" },
  examId: { type: String, index: true },

  courseTitle: String,
  score: Number,
  percentage: Number,

  serial: { type: String, unique: true, index: true }, // public reference
  issuedAt: { type: Date, default: Date.now },

}, { timestamps: true });

export default mongoose.models.Certificate ||
  mongoose.model("Certificate", CertificateSchema);
