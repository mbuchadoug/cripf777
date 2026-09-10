// models/moduleCertificate.js
// The issued "Certificate of Mastery" for completing a module/pillar track.
// Fields map to the buildCourseCertHtml() contract with tier:"module".
import mongoose from "mongoose";

const ItemSnap = new mongoose.Schema({
  title: { type: String, default: "" },      // a completed area course
  percentage: { type: Number, default: 0 }    // that course's overall %
}, { _id: false });

const ModuleCertificateSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: "User", index: true },
  org: { type: mongoose.Schema.Types.ObjectId, ref: "Organization", default: null },
  track: { type: mongoose.Schema.Types.ObjectId, ref: "ModuleTrack", index: true },
  pillar: { type: String, index: true },
  role: { type: String, default: "professional" },

  recipientName: { type: String, default: "" },
  orgName: { type: String, default: "CRIPFCnt" },
  moduleName: { type: String, default: "" },   // "Consciousness"

  classification: { type: String, default: "Pass" },
  overallPercentage: { type: Number, default: 0 },
  coursesCompleted: { type: Number, default: 0 },
  coursesTotal: { type: Number, default: 0 },
  items: [ItemSnap],

  serial: { type: String, unique: true },
  verifyCode: { type: String, unique: true, index: true },
  pdfUrl: { type: String, default: null },

  issuedAt: { type: Date, default: Date.now }
}, { timestamps: true });

export default mongoose.models.ModuleCertificate ||
  mongoose.model("ModuleCertificate", ModuleCertificateSchema);