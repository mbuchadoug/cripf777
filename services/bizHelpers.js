import Business from "../models/business.js";
import UserSession from "../models/userSession.js";

/**
 * Load active business for a WhatsApp user.
 * Primary: UserSession.activeBusinessId
 * Fallback: UserRole lookup (covers clerks/managers assigned by admin without a session)
 * Side-effect: auto-creates/updates UserSession when found via UserRole fallback.
 */
export async function getBizForPhone(phone) {
  const normalized = phone.replace(/\D+/g, "");

  // ── Primary: check UserSession ───────────────────────────────────────────
  const session = await UserSession.findOne({ phone: normalized });
  if (session?.activeBusinessId) {
    return Business.findById(session.activeBusinessId);
  }

  // ── Fallback: look up UserRole (catches admin-assigned clerks/managers) ────
  try {
    const UserRole = (await import("../models/userRole.js")).default;
    const role = await UserRole.findOne({ phone: normalized, pending: false })
      .sort({ updatedAt: -1 })
      .lean();

    if (role?.businessId) {
      const biz = await Business.findById(role.businessId);
      if (biz) {
        // Auto-create/update session so future lookups use the fast path
        await UserSession.findOneAndUpdate(
          { phone: normalized },
          { $set: { phone: normalized, activeBusinessId: biz._id } },
          { upsert: true }
        );
        console.log(`[getBizForPhone] Role fallback: phone=${normalized} → biz=${biz._id} (${role.role})`);
        return biz;
      }
    }
  } catch (_roleErr) {
    console.error("[getBizForPhone] Role fallback error:", _roleErr.message);
  }

  return null;
}

/**
 * Safely save sessionData (Mongoose nested object)
 */
export async function saveBizSafe(biz) {
  if (!biz) return;
  biz.markModified("sessionData");
  return biz.save();
}