/**
 * models/userRole.js  — UPDATED: added name field
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

  // ── Staff display name — shown on reports, drawings & handover logs ─────────
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
  suspended: { type: Boolean, default: false }
}, { timestamps: true });

export default mongoose.model("UserRole", UserRoleSchema);