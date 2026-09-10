// models/courseCertificate.js
// ─────────────────────────────────────────────────────────────────────────────
// The Level-1 "Certificate of Competence" record for completing an area course.
// Kept separate from the per-quiz Certificate model so the two credentials stay
// distinct. The fields here map 1:1 to the buildCourseCertHtml() input contract
// in services/courseCertTemplate.js, so issuing = create this doc + render PDF.
// ─────────────────────────────────────────────────────────────────────────────
import mongoose from "mongoose";

const AssessmentSnap = new mongoose.Schema({
  title: { type: String, default: "" },
  percentage: { type: Number, default: 0 }
}, { _id: false });

const CourseCertificateSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: "User", index: true },
  org: { type: mongoose.Schema.Types.ObjectId, ref: "Organization", default: null },
  course: { type: mongoose.Schema.Types.ObjectId, ref: "Course", index: true },

  // persona the course was taken under
  role: { type: String, default: "professional" },

  // Display fields (snapshot at issue time so a later course edit can't alter
  // an already-issued credential)
  recipientName: { type: String, default: "" },
  orgName: { type: String, default: "CRIPFCnt" },
  courseTitle: { type: String, default: "" },
  moduleName: { type: String, default: "" },   // area label
  level: { type: String, default: "Foundation" },

  classification: { type: String, default: "Pass" },
  overallPercentage: { type: Number, default: 0 },
  assessmentsPassed: { type: Number, default: 0 },
  assessmentsTotal: { type: Number, default: 0 },
  totalQuestions: { type: Number, default: 0 },
  assessments: [AssessmentSnap],

  serial: { type: String, unique: true },
  verifyCode: { type: String, unique: true, index: true },
  pdfUrl: { type: String, default: null },

  issuedAt: { type: Date, default: Date.now }
}, { timestamps: true });

export default mongoose.models.CourseCertificate ||
  mongoose.model("CourseCertificate", CourseCertificateSchema);