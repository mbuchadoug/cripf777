import mongoose from "mongoose";

// ==============================
// 📦 HOTSPOT PLAN
// A "plan" is a reusable voucher template: how long it lasts, how many
// devices can share it, how fast it goes, and how much you sell it for.
// Each plan maps to ONE RouterOS user-profile named  hs_<key>.
// ==============================

const HotspotPlanSchema = new mongoose.Schema({
  key: {
    type: String,
    required: true,
    unique: true,
    lowercase: true,
    trim: true,
    index: true
  },

  label: { type: String, required: true },      // e.g. "Lunch - 2 hours"

  // ── Duration ───────────────────────────────────────────────
  // "uptime" = counts only connected time (pauses when idle/offline).
  //            Best for restaurant/short passes. Router enforces it.
  // "clock"  = a fixed window from first login (e.g. 24 hours), whether
  //            they use it or not. Best for overnight guests. App enforces it.
  durationType: {
    type: String,
    enum: ["uptime", "clock"],
    default: "uptime"
  },
  durationMinutes: { type: Number, required: true, min: 1 },

  // ── Device cap ─────────────────────────────────────────────
  deviceCap: { type: Number, default: 1, min: 1 },   // phones per voucher

  // ── Speed cap (protects your cameras from being starved) ───
  // NOTE: RouterOS rate-limit is "upload/download" from the client.
  // If speeds look swapped after testing, flip these two.
  downKbps: { type: Number, default: 0 },   // 0 = unlimited
  upKbps:   { type: Number, default: 0 },

  // ── Sale ───────────────────────────────────────────────────
  price:    { type: Number, default: 0 },
  currency: { type: String, default: "USD" },

  active:    { type: Boolean, default: true, index: true },
  sortOrder: { type: Number, default: 0 },

  createdAt: { type: Date, default: Date.now }
}, { strict: true });

// RouterOS profile name this plan maps to.
HotspotPlanSchema.methods.rosProfile = function () {
  return `hs_${this.key}`;
};

// "2M/5M" style rate-limit string for RouterOS, or null for unlimited.
HotspotPlanSchema.methods.rateLimitString = function () {
  if (!this.upKbps && !this.downKbps) return null;
  const up = this.upKbps ? `${this.upKbps}k` : "0";
  const down = this.downKbps ? `${this.downKbps}k` : "0";
  return `${up}/${down}`;
};

const HotspotPlan =
  mongoose.models.HotspotPlan || mongoose.model("HotspotPlan", HotspotPlanSchema);

export default HotspotPlan;