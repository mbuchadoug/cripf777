// models/reseUser.js
//
// A Rese Rese account. One document per phone number. A person can be a
// requester, a worker, or both. Everything the admin panel governs lives here:
// account status, worker approval, ID verification, and adult-age confirmation.
//
// Photos (avatar, selfie, national ID) are NOT stored inline — only the GridFS
// file id is kept here, and the bytes live in the `rese_uploads` bucket. The
// admin streams them through a gated route; they are never public.

import mongoose from "mongoose";

const WorkerSchema = new mongoose.Schema(
  {
    skills: { type: [String], default: [] },   // category ids: water, clean, ...
    suburbs: { type: [String], default: [] },   // areas they cover
    // Verification images (GridFS ObjectIds in the rese_uploads bucket)
    selfieFileId: { type: mongoose.Schema.Types.ObjectId, default: null },
    idFileId: { type: mongoose.Schema.Types.ObjectId, default: null },
    ratingAvg: { type: Number, default: 0 },
    ratingCount: { type: Number, default: 0 },
    jobsDone: { type: Number, default: 0 }
  },
  { _id: false }
);

const ReseUserSchema = new mongoose.Schema({
  phone: { type: String, required: true, unique: true, index: true }, // +2637...
  name: { type: String, default: "" },
  lang: { type: String, enum: ["sn", "nd", "en"], default: "sn" },
  avatarFileId: { type: mongoose.Schema.Types.ObjectId, default: null },

  // Which sides of the marketplace this account uses.
  isWorker: { type: Boolean, default: false },
  isRequester: { type: Boolean, default: true },
  lastMode: { type: String, enum: ["requester", "worker"], default: "requester" },

  worker: { type: WorkerSchema, default: () => ({}) },

  // ── Account status (admin-controlled) ─────────────────────────────
  // pending  : new worker awaiting approval (if approval is required)
  // active   : can use the app normally
  // suspended: blocked by admin
  status: {
    type: String,
    enum: ["pending", "active", "suspended"],
    default: "active",
    index: true
  },

  // ── ID verification (admin-reviewed) ──────────────────────────────
  verification: {
    status: {
      type: String,
      enum: ["unverified", "pending", "approved", "rejected"],
      default: "unverified",
      index: true
    },
    reviewedAt: { type: Date, default: null },
    reviewedBy: { type: String, default: null }, // admin identifier
    reason: { type: String, default: "" }        // rejection reason
  },

  // ── Age / adult confirmation ──────────────────────────────────────
  // dob may be captured in-app later; adult is what the admin confirms from
  // the ID photo. Under-age accounts can be blocked from age-restricted work.
  dob: { type: Date, default: null },
  adultConfirmed: { type: Boolean, default: false },

  createdAt: { type: Date, default: Date.now, index: true },
  lastActiveAt: { type: Date, default: Date.now }
});

// Convenience: current age from dob (null if unknown).
ReseUserSchema.virtual("age").get(function () {
  if (!this.dob) return null;
  const diff = Date.now() - new Date(this.dob).getTime();
  return Math.floor(diff / (365.25 * 24 * 3600 * 1000));
});

ReseUserSchema.set("toJSON", { virtuals: true });
ReseUserSchema.set("toObject", { virtuals: true });

export default mongoose.models.ReseUser ||
  mongoose.model("ReseUser", ReseUserSchema);
