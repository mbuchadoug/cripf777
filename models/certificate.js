import mongoose from "mongoose";

const CertificateSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    orgId: { type: mongoose.Schema.Types.ObjectId, ref: "Organization" },

    examId: { type: String, index: true },

    // 🔹 ADD THESE
    quizTitle: { type: String, trim: true },
    moduleName: { type: String, trim: true },

    courseTitle: { type: String }, // (you can keep for backward compatibility)

    score: Number,
    percentage: Number,
    serial: { type: String, unique: true },
    pdfFile: String,

    issuedAt: { type: Date, default: Date.now }
  },
  { timestamps: true }
);

export default mongoose.model("Certificate", CertificateSchema);
