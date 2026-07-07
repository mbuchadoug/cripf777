/**
 * models/userRole.js  - UPDATED: added name field
 * ─────────────────────────────────────────────────────────────
 * The name field stores the staff member's full name.
 * It is:
 *   - Set by admin via supplierAdmin.js → Staff page → Edit modal
 *   - Read by reportHelpers.js resolveStaff() → shows on reports,
 *     drawings, handover logs, and clerk statements
 *   - Backward compatible: existing records just have name: ""
 *     and will show phone number as fallback (same as before)
 */
import mongoose from "mongoose";
import bcrypt from "bcryptjs";

const UserRoleSchema = new mongoose.Schema({
  businessId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Business",
    required: true
  },
  branchId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Branch",
    required: function () {
      return this.role !== "owner";
    }
  },

  phone: { type: String, index: true },

  // ── Staff display name - shown on reports, drawings & handover logs ─────────
  // Set by admin on the Staff page (supplierAdmin.js).
  // Falls back to phone number in reports if not set.
  name: { type: String, default: "" },

  pending: { type: Boolean, default: true },
  role: {
    type: String,
    enum: ["owner", "admin", "manager", "clerk"],
    default: "owner"
  },

  // ── Admin-level suspend flag ─────────────────────────────────────────────────
  suspended: { type: Boolean, default: false },

  // ── Web portal credentials (the /office back-office) ────────────────────────
  // Optional: only staff who log into the web portal have these. WhatsApp-only
  // staff keep working exactly as before (all fields default to empty/false).
  username:        { type: String, unique: true, sparse: true, lowercase: true, trim: true, index: true },
  passwordHash:    { type: String, default: null },
  mustSetPassword: { type: Boolean, default: false },
  lastWebLogin:    { type: Date, default: null }
}, { timestamps: true });

// ── Password helpers ─────────────────────────────────────────────────────────
UserRoleSchema.methods.setPassword = async function (plain) {
  this.passwordHash = await bcrypt.hash(String(plain), 10);
  this.mustSetPassword = false;
};
UserRoleSchema.methods.verifyPassword = async function (plain) {
  if (!this.passwordHash) return false;
  return bcrypt.compare(String(plain), this.passwordHash);
};
UserRoleSchema.methods.hasPassword = function () { return !!this.passwordHash; };

// ── Username generation (unique across all staff) ────────────────────────────
// Pattern: first name (letters only) + 3 digits, lowercase. e.g. "tino482".
UserRoleSchema.statics.makeUsername = async function (fullName, fallback = "user") {
  const first = String(fullName || fallback).trim().split(/\s+/)[0]
    .toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 12) || fallback;
  for (let i = 0; i < 12; i++) {
    const candidate = first + String(Math.floor(100 + Math.random() * 900));
    const clash = await this.findOne({ username: candidate }).select("_id").lean();
    if (!clash) return candidate;
  }
  return first + Date.now().toString().slice(-5);
};

export default mongoose.models.UserRole || mongoose.model("UserRole", UserRoleSchema);