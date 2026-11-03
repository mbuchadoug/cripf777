// models/bikerJob.js
// ─── ZimQuote Biker (rider) job request ──────────────────────────────────────
// FULLY ISOLATED, like groceryOrder: its own collection, its own lifecycle.
// A "job" is a customer's request for a rider (collect/deliver/errand). Riders
// (SupplierProfile.profileType === "biker") respond with a fare + ETA; the
// customer picks one and the two are connected. ZimQuote takes no commission.

import mongoose from "mongoose";

const BikerResponseSchema = new mongoose.Schema({
  riderId:    { type: mongoose.Schema.Types.ObjectId, ref: "SupplierProfile" },
  riderPhone: { type: String, required: true },
  riderName:  { type: String, default: "" },
  plate:      { type: String, default: "" },
  fare:       { type: String, default: "" },   // free text, e.g. "$3" (rider sets it)
  eta:        { type: String, default: "" },   // free text, e.g. "15 min"
  verified:   { type: Boolean, default: false },
  rating:     { type: Number, default: 0 },
  respondedAt:{ type: Date, default: Date.now }
}, { _id: false });

const BikerJobSchema = new mongoose.Schema({
  reference:  { type: String, required: true, unique: true, index: true },

  // Who wants the job done
  customerPhone: { type: String, required: true, index: true },
  customerName:  { type: String, default: "" },

  // The job
  task:    { type: String, default: "" },   // "collect documents from CBD, drop in Avondale"
  city:    { type: String, default: "" },   // matched against rider location.city
  pickup:  { type: String, default: "" },   // pickup area/suburb
  dropoff: { type: String, default: "" },   // drop-off area/suburb
  when:    { type: String, default: "Now" },// "Now" | "Later today" | free text time

  // Lifecycle
  status: {
    type: String,
    enum: ["open", "assigned", "completed", "cancelled", "expired"],
    default: "open",
    index: true
  },

  notifiedRiderPhones: { type: [String], default: [] },
  responses:           { type: [BikerResponseSchema], default: [] },

  // Chosen rider (when customer picks / first-accept)
  assignedRiderId:    { type: mongoose.Schema.Types.ObjectId, ref: "SupplierProfile", default: null },
  assignedRiderPhone: { type: String, default: null },
  assignedAt:         { type: Date, default: null },

  lastNotifiedAt: { type: Date, default: null },
  createdAt:      { type: Date, default: Date.now, index: true }
}, { timestamps: true });

BikerJobSchema.index({ status: 1, city: 1, createdAt: -1 });

const BikerJob = mongoose.models.BikerJob || mongoose.model("BikerJob", BikerJobSchema);
export default BikerJob;