import mongoose from "mongoose";

// ==============================
// 🎟️ VOUCHER
// One code a customer types in. Carries a SNAPSHOT of the plan's terms
// so changing a plan later never rewrites old vouchers. Tracks who made
// it, when, whether it's been used, and which phones used it.
// ==============================

const DeviceSchema = new mongoose.Schema({
  mac:       { type: String, index: true },   // the phone's MAC (identity)
  ip:        { type: String },
  hostname:  { type: String },                // phone name, if the router knows it
  firstSeen: { type: Date, default: Date.now },
  lastSeen:  { type: Date, default: Date.now }
}, { _id: false });

const VoucherSchema = new mongoose.Schema({
  code: {
    type: String,
    required: true,
    unique: true,
    uppercase: true,
    trim: true,
    index: true
  },

  // ── Plan snapshot (frozen at creation) ─────────────────────
  planKey:         { type: String, index: true },
  planLabel:       { type: String },
  durationType:    { type: String, enum: ["uptime", "clock"], default: "uptime" },
  durationMinutes: { type: Number, required: true },
  deviceCap:       { type: Number, default: 1 },
  downKbps:        { type: Number, default: 0 },
  upKbps:          { type: Number, default: 0 },

  // ── Lifecycle ──────────────────────────────────────────────
  //   unused   → generated, never logged in
  //   active   → someone is (or was) using it, still valid
  //   used     → time fully consumed (uptime plans)
  //   expired  → window elapsed (clock plans)
  //   disabled → an admin switched it off (revoked)
  status: {
    type: String,
    enum: ["unused", "active", "used", "expired", "disabled"],
    default: "unused",
    index: true
  },

  // ── Accountability ─────────────────────────────────────────
  batchId:       { type: String, index: true },        // groups a print run
  createdBy:     { type: mongoose.Schema.Types.ObjectId, ref: "HotspotAdmin", index: true },
  createdByName: { type: String },                     // snapshot of admin name
  createdAt:     { type: Date, default: Date.now, index: true },

  // ── Sale ───────────────────────────────────────────────────
  price:         { type: Number, default: 0 },
  currency:      { type: String, default: "USD" },
  paymentMethod: { type: String, enum: ["cash", "ecocash", "complimentary", "other"], default: "cash" },
  note:          { type: String, default: "" },        // e.g. table number, guest name

  // ── Usage (filled in by the sync loop from the router) ─────
  firstUsedAt:  { type: Date, default: null, index: true },
  lastSeenAt:   { type: Date, default: null },
  validUntil:   { type: Date, default: null, index: true }, // clock plans
  uptimeUsedSec:{ type: Number, default: 0 },
  bytesIn:      { type: Number, default: 0 },
  bytesOut:     { type: Number, default: 0 },
  devices:      { type: [DeviceSchema], default: [] },

  // ── Router link ────────────────────────────────────────────
  rosUserId:       { type: String, default: null },   // the *XX id on the MikroTik
  syncedToRouter:  { type: Boolean, default: false, index: true },
  lastSyncError:   { type: String, default: null }
}, { strict: true });

VoucherSchema.index({ status: 1, createdAt: -1 });

// Total minutes still available (rough, for display).
VoucherSchema.methods.remainingMinutes = function () {
  if (this.durationType === "uptime") {
    return Math.max(0, this.durationMinutes - Math.floor(this.uptimeUsedSec / 60));
  }
  if (this.validUntil) {
    return Math.max(0, Math.round((this.validUntil - new Date()) / 60000));
  }
  return this.durationMinutes;
};

VoucherSchema.methods.isExpired = function () {
  if (this.status === "expired" || this.status === "used") return true;
  if (this.durationType === "clock" && this.validUntil) return new Date() > this.validUntil;
  if (this.durationType === "uptime") return this.uptimeUsedSec >= this.durationMinutes * 60;
  return false;
};

const Voucher =
  mongoose.models.Voucher || mongoose.model("Voucher", VoucherSchema);

export default Voucher;