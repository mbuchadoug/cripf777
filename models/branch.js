// models/bikerJob.js
// ═════════════════════════════════════════════════════════════════════════════
// A delivery / errand request handled by ZimQuote Bikers.
//
// Lifecycle:
//   open ──(customer picks a rider)──▶ assigned ──▶ picked_up ──▶ delivered ──▶ completed
//     │                                   │             │             │
//     ├─▶ cancelled (customer/admin)      ├─▶ open again (rider cancelled → re-dispatched)
//     └─▶ expired (nobody took it)        └─▶ cancelled (customer/admin)
//
// strict:false so older documents and future fields never get silently dropped.
// ═════════════════════════════════════════════════════════════════════════════
import mongoose from "mongoose";

const ResponseSchema = new mongoose.Schema({
  riderId:     { type: mongoose.Schema.Types.ObjectId, ref: "SupplierProfile", default: null },
  riderPhone:  { type: String, default: "" },
  riderName:   { type: String, default: "" },
  plate:       { type: String, default: "" },
  fare:        { type: String, default: "" },   // as typed/tapped, e.g. "$3" or "ZiG 80"
  fareAmount:  { type: Number, default: null }, // numeric part, for earnings & sorting
  eta:         { type: String, default: "" },
  verified:    { type: Boolean, default: false },
  rating:      { type: Number, default: 0 },
  points:      { type: Number, default: 0 },
  trips:       { type: Number, default: 0 },
  respondedAt: { type: Date, default: Date.now }
}, { _id: false });

const HistorySchema = new mongoose.Schema({
  at:    { type: Date, default: Date.now },
  by:    { type: String, default: "" },  // customer | rider | admin | system
  phone: { type: String, default: "" },
  event: { type: String, default: "" },  // created, offer, assigned, picked_up, delivered, completed, cancelled, reopened, expired, rated, note, problem, admin
  note:  { type: String, default: "" }
}, { _id: false });

const BikerJobSchema = new mongoose.Schema({
  reference:      { type: String, index: true },
  source:         { type: String, default: "whatsapp" },   // whatsapp | admin | rider_link
  createdByAdmin: { type: String, default: "" },

  // Customer + trip
  customerPhone:  { type: String, index: true },
  customerName:   { type: String, default: "" },
  task:           { type: String, default: "" },
  city:           { type: String, default: "" },
  pickup:         { type: String, default: "" },
  dropoff:        { type: String, default: "" },
  when:           { type: String, default: "Now" },

  status: {
    type: String,
    enum: ["open", "assigned", "picked_up", "delivered", "completed", "cancelled", "expired"],
    default: "open",
    index: true
  },
  openSince:      { type: Date, default: Date.now },  // reset when a rider cancels and the job re-opens

  // Dispatch
  preferredRiderId:    { type: mongoose.Schema.Types.ObjectId, default: null }, // from a rider's own link
  notifiedRiderPhones: { type: [String], default: [] },
  busyRiderPhones:     { type: [String], default: [] },
  cancelledRiderPhones:{ type: [String], default: [] },  // riders who dropped this job - never re-notified
  responses:           { type: [ResponseSchema], default: [] },
  lastNotifiedAt:      { type: Date, default: null },
  repingCount:         { type: Number, default: 0 },

  // Assignment
  assignedRiderId:    { type: mongoose.Schema.Types.ObjectId, default: null },
  assignedRiderPhone: { type: String, default: "", index: true },
  assignedRiderName:  { type: String, default: "" },
  agreedFare:         { type: String, default: "" },
  agreedFareAmount:   { type: Number, default: null },
  agreedEta:          { type: String, default: "" },
  assignedAt:         { type: Date, default: null },
  pickedUpAt:         { type: Date, default: null },
  deliveredAt:        { type: Date, default: null },
  completedAt:        { type: Date, default: null },
  completedBy:        { type: String, default: "" },   // customer | auto | admin
  staleReminderSent:  { type: Boolean, default: false },

  // Notes + feedback (both sides)
  riderNote:       { type: String, default: "" },
  customerRating:  { type: Number, default: null },
  customerNote:    { type: String, default: "" },
  problemReport:   { type: String, default: "" },
  disputed:        { type: Boolean, default: false },
  disputeResolved: { type: Boolean, default: false },

  // Cancellation
  cancelledAt:   { type: Date, default: null },
  cancelledBy:   { type: String, default: "" },   // customer | rider | admin | system
  cancelReason:  { type: String, default: "" },
  cancelCode:    { type: String, default: "" },

  // Points
  pointsAwarded: { type: Number, default: 0 },
  adminNote:     { type: String, default: "" },
  history:       { type: [HistorySchema], default: [] }
}, { timestamps: true, strict: false });

BikerJobSchema.index({ status: 1, city: 1, openSince: -1 });
BikerJobSchema.index({ customerPhone: 1, createdAt: -1 });
BikerJobSchema.index({ assignedRiderPhone: 1, status: 1 });

export default mongoose.models.BikerJob || mongoose.model("BikerJob", BikerJobSchema);