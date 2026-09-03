import mongoose from "mongoose";
import bcrypt from "bcryptjs";

// ==============================
// 👤 HOTSPOT ADMIN
// The people who log in to generate & manage vouchers.
//   owner → full control, incl. adding/removing other admins & plans
//   admin → generate vouchers, manage vouchers/bypass, view reports
// Every voucher stores which admin created it (accountability).
// ==============================

const HotspotAdminSchema = new mongoose.Schema({
  username: {
    type: String,
    required: true,
    unique: true,
    lowercase: true,
    trim: true,
    index: true
  },

  displayName: { type: String, required: true },

  role: {
    type: String,
    enum: ["owner", "admin"],
    default: "admin",
    index: true
  },

  passwordHash: { type: String, default: null },

  active: { type: Boolean, default: true, index: true },

  createdBy:     { type: mongoose.Schema.Types.ObjectId, ref: "HotspotAdmin", default: null },
  createdByName: { type: String, default: "system" },

  createdAt: { type: Date, default: Date.now },
  lastLogin: { type: Date, default: null }
}, { strict: true });

// ── Password helpers (same pattern as your user.js) ──
HotspotAdminSchema.methods.setPassword = async function (plain) {
  this.passwordHash = await bcrypt.hash(String(plain), 10);
};

HotspotAdminSchema.methods.verifyPassword = async function (plain) {
  if (!this.passwordHash) return false;
  return bcrypt.compare(String(plain), this.passwordHash);
};

HotspotAdminSchema.methods.isOwner = function () {
  return this.role === "owner";
};

const HotspotAdmin =
  mongoose.models.HotspotAdmin || mongoose.model("HotspotAdmin", HotspotAdminSchema);

export default HotspotAdmin;