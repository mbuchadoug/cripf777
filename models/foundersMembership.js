// models/foundersMembership.js
// ─────────────────────────────────────────────────────────────────────────────
// CRIPFCnt SCOI - FOUNDERS 100 / Institutional Research Access Membership
//
// One document per founding institution. Fully additive: no existing model is
// touched. Access to the member's selected reports is granted through the
// EXISTING AuditPurchase mechanism (see routes/founders.js), so the existing
// canAccessAudit() view/download gate needs no changes.
//
//   First year   US$5,000 → 100 report selections, up to 5 named users.
//   Renewal      US$250/yr from year two → +5 selections, access retained.
//   Lifetime     membership right is transferable to another eligible institution.
//   Scarcity     only 100 founding memberships are ever issued (membershipNumber 1..100).
// ─────────────────────────────────────────────────────────────────────────────
import mongoose from "mongoose";

const SeatSchema = new mongoose.Schema({
  name:  { type: String, trim: true },
  email: { type: String, trim: true, lowercase: true }
}, { _id: false });

const SelectionSchema = new mongoose.Schema({
  auditId:    { type: mongoose.Schema.Types.ObjectId, index: true },
  auditModel: { type: String, enum: ["SpecialScoiAudit", "PlacementAudit"], default: "SpecialScoiAudit" },
  title:      String,
  selectedAt: { type: Date, default: Date.now }
}, { _id: false });

const TransferSchema = new mongoose.Schema({
  fromUserId:     { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  toInstitution:  String,
  toContactEmail: String,
  at:             { type: Date, default: Date.now },
  note:           String
}, { _id: false });

const FoundersMembershipSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
    index: true
  },

  // Sequential founding number 1..100 (assigned on activation).
  membershipNumber: { type: Number, index: true },

  tier:   { type: String, default: "founding", immutable: true },

  status: {
    type: String,
    enum: ["pending", "active", "cancelled", "expired"],
    default: "pending",
    index: true
  },

  reference: { type: String, index: true },   // our checkout reference

  // Institution + named users (the 5 seats).
  institution: {
    name:         String,
    contactName:  String,
    contactEmail: String
  },
  seats: { type: [SeatSchema], default: [] },  // up to 5

  // Entitlements.
  reportQuota:     { type: Number, default: 100 },   // grows by 5 per renewal
  reportsSelected: { type: [SelectionSchema], default: [] },

  // Commercials (cents).
  firstYearAmount: { type: Number, default: 500000 },  // $5,000
  renewalAmount:   { type: Number, default: 25000 },   // $250
  totalPaid:       { type: Number, default: 0 },

  // Lifecycle.
  purchasedAt:         Date,
  yearOneExpiresAt:    Date,
  currentTermExpiresAt: Date,
  renewalsCount:       { type: Number, default: 0 },
  lastRenewalAt:       Date,

  // Lifetime, transferable right.
  transferable:    { type: Boolean, default: true },
  transferHistory: { type: [TransferSchema], default: [] },

  // Payment linkage (idempotency).
  stripeSessionId:     { type: String, index: true },
  stripePaymentIntent: String,
  customerEmail:       String,

  createdAt: { type: Date, default: Date.now }
}, {
  collection: "founders_memberships"
});

// Remaining selections available right now.
FoundersMembershipSchema.methods.remainingSelections = function () {
  return Math.max(0, (this.reportQuota || 0) - (this.reportsSelected?.length || 0));
};

FoundersMembershipSchema.methods.isActive = function () {
  if (this.status !== "active") return false;
  if (this.currentTermExpiresAt && this.currentTermExpiresAt < new Date()) return false;
  return true;
};

const FoundersMembership =
  mongoose.models.FoundersMembership ||
  mongoose.model("FoundersMembership", FoundersMembershipSchema);

export default FoundersMembership;
