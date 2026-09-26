// models/learnerLink.js
// ─────────────────────────────────────────────────────────────────────────────
// A many-to-many link between a learner (student) and a "guardian" (a private
// teacher OR a parent) who was added AFTER the student already existed — by the
// student sharing their username. This sits ALONGSIDE User.parentUserId (the
// account's creator); it never replaces it. A student can have many guardians.
//
// Consent model (kept simple): the student shares their username on purpose, so
// adding is immediate — but the student sees everyone linked to them and can
// remove any guardian at any time. Guardians get view + assign, never account
// control.
// ─────────────────────────────────────────────────────────────────────────────
import mongoose from "mongoose";

const LearnerLinkSchema = new mongoose.Schema({
  learner: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },   // the student
  guardian: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },  // teacher or parent
  role: { type: String, enum: ["teacher", "parent"], required: true },
  status: { type: String, enum: ["active", "removed"], default: "active", index: true },
  addedByName: { type: String, default: "" },
  createdAt: { type: Date, default: Date.now }
}, { timestamps: true });

LearnerLinkSchema.index({ learner: 1, guardian: 1 }, { unique: true });

export default mongoose.models.LearnerLink || mongoose.model("LearnerLink", LearnerLinkSchema);