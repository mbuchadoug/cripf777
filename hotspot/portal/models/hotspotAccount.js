import mongoose from "mongoose";

// ==============================
// 👤 HOTSPOT ACCOUNT
// A named, reusable login for regular clients and tenants who DON'T want to
// type a code each visit. It is a normal RouterOS hotspot user, so the SAME
// captive-portal page authenticates it (username + password instead of a code).
//
// Capped three ways, all enforced on the router:
//   • speed   → rate-limit on its user-profile
//   • devices → shared-users on its user-profile
//   • time    → either a rolling window (subscription) or a pool of connected
//               minutes (prepaid). Both are topped up to renew.
// The GLOBAL number of accounts is capped in HotspotSetting.
//
// NOTE: the password is stored as given (not hashed) because the router needs
// the real secret to (re)create the hotspot user on every resync - exactly how
// vouchers store their code. Accounts are low-value WiFi logins, same trust
// model as the rest of this module.
// ==============================

const DeviceSchema = new mongoose.Schema({
  mac:       { type: String, index: true },
  ip:        { type: String },
  hostname:  { type: String },
  firstSeen: { type: Date, default: Date.now },
  lastSeen:  { type: Date, default: Date.now }
}, { _id: false });

const TopupSchema = new mongoose.Schema({
  at:       { type: Date, default: Date.now },
  minutes:  { type: Number, default: 0 },
  amount:   { type: Number, default: 0 },
  currency: { type: String, default: "USD" },
  method:   { type: String, default: "cash" },
  by:       { type: String, default: "" },
  note:     { type: String, default: "" }
}, { _id: false });

const HotspotAccountSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true, lowercase: true, trim: true, index: true },
  password: { type: String, required: true },          // plaintext - pushed to the router as the hotspot secret
  displayName: { type: String, required: true },
  phone: { type: String, default: "", index: true },
  unit:  { type: String, default: "" },                // room / office / tenant unit

  type: { type: String, enum: ["client", "tenant", "staff"], default: "client", index: true },

  // subscription = a rolling time window (validUntil), renewed by top-up. Best for tenants / monthly.
  // prepaid      = a pool of connected minutes (limit-uptime on the router), topped up in chunks.
  billing: { type: String, enum: ["subscription", "prepaid"], default: "subscription" },
  durationMinutes: { type: Number, default: 43200 },   // window length / top-up chunk (43200 = 30 days)
  validUntil:      { type: Date, default: null, index: true },  // subscription expiry
  timeAllowanceMin:{ type: Number, default: 0 },        // prepaid: total minutes granted
  uptimeUsedSec:   { type: Number, default: 0 },

  // ── Caps (enforced on the router via the account's profile) ──
  deviceCap: { type: Number, default: 2, min: 1 },
  downKbps:  { type: Number, default: 0 },              // 0 = unlimited
  upKbps:    { type: Number, default: 0 },

  // ── Billing ──
  price:    { type: Number, default: 0 },               // monthly / per-top-up price
  currency: { type: String, default: "USD" },

  status: { type: String, enum: ["active", "suspended", "expired"], default: "active", index: true },

  // ── Usage (filled by the sync loop) ──
  bytesIn:  { type: Number, default: 0 },
  bytesOut: { type: Number, default: 0 },
  firstUsedAt: { type: Date, default: null },
  lastSeenAt:  { type: Date, default: null },
  devices: { type: [DeviceSchema], default: [] },
  topups:  { type: [TopupSchema], default: [] },

  // ── Router link ──
  rosUserId:      { type: String, default: null },
  syncedToRouter: { type: Boolean, default: false, index: true },
  lastSyncError:  { type: String, default: null },

  createdByName: { type: String, default: "" },
  createdAt: { type: Date, default: Date.now },
  lastLogin: { type: Date, default: null }
}, { strict: true });

// RouterOS profile this account maps to - shared by every account with the SAME caps.
HotspotAccountSchema.methods.profileName = function () {
  return `ha_${this.upKbps || 0}_${this.downKbps || 0}_d${this.deviceCap || 1}`;
};

HotspotAccountSchema.methods.rateLimitString = function () {
  if (!this.upKbps && !this.downKbps) return null;
  return `${this.upKbps || 0}k/${this.downKbps || 0}k`;
};

HotspotAccountSchema.methods.remainingMinutes = function () {
  if (this.billing === "prepaid") {
    return Math.max(0, (this.timeAllowanceMin || 0) - Math.floor((this.uptimeUsedSec || 0) / 60));
  }
  if (this.validUntil) return Math.max(0, Math.round((this.validUntil - new Date()) / 60000));
  return 0;
};

const HotspotAccount =
  mongoose.models.HotspotAccount || mongoose.model("HotspotAccount", HotspotAccountSchema);

export default HotspotAccount;
