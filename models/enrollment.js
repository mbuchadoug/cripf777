// models/enrollment.js
// ─────────────────────────────────────────────────────────────────────────────
// An Enrollment is the ACCESS GRANT between a learner and a course. Access to a
// course's assessments and progress requires an enrollment in status "active"
// (or "completed"). This is what makes professionals, students, or anyone able
// to take a course - enrollment, not persona, is the gate.
//
// Lifecycle:
//   pending   → created, awaiting payment or admin activation (paid/invite)
//   active    → learner may take the course (free = straight to active)
//   completed → course finished + certificate issued
//   suspended → access revoked by admin (refund, abuse, expiry)
// ─────────────────────────────────────────────────────────────────────────────
import mongoose from "mongoose";

const EnrollmentSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
  course: { type: mongoose.Schema.Types.ObjectId, ref: "Course", required: true, index: true },
  org: { type: mongoose.Schema.Types.ObjectId, ref: "Organization", default: null, index: true },

  status: { type: String, enum: ["pending", "active", "completed", "suspended"], default: "pending", index: true },
  // How the enrollment was created
  source: { type: String, enum: ["self", "admin", "payment", "import"], default: "self" },
  // Access type snapshotted from the course at enroll time
  access: { type: String, enum: ["free", "paid", "invite"], default: "free" },

  payment: {
    provider: { type: String, enum: ["ecocash", "stripe", "manual", null], default: null },
    reference: { type: String, default: null, index: true },
    pollUrl: { type: String, default: null },
    amount: { type: Number, default: 0 },
    currency: { type: String, default: "USD" },
    status: { type: String, enum: ["none", "pending", "paid", "failed", "refunded"], default: "none" },
    paidAt: { type: Date, default: null }
  },

  activatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null }, // admin, if manual
  notes: { type: String, default: "" },

  enrolledAt: { type: Date, default: Date.now },
  activatedAt: { type: Date, default: null },
  completedAt: { type: Date, default: null },
  suspendedAt: { type: Date, default: null }
}, { timestamps: true });

// One enrollment per user per course
EnrollmentSchema.index({ user: 1, course: 1 }, { unique: true });

EnrollmentSchema.methods.isActive = function () {
  return this.status === "active" || this.status === "completed";
};

export default mongoose.models.Enrollment || mongoose.model("Enrollment", EnrollmentSchema);