import Business from "../models/business.js";
import UserSession from "../models/userSession.js";

/**
 * Load active business for a WhatsApp user
 */
export async function getBizForPhone(phone) {
  const normalized = phone.replace(/\D+/g, "");
  const session = await UserSession.findOne({ phone: normalized });
  if (!session?.activeBusinessId) return null;

  return Business.findById(session.activeBusinessId);
}

/**
 * Safely save sessionData (Mongoose nested object)
 */
export async function saveBizSafe(biz) {
  if (!biz) return;
  biz.markModified("sessionData");
  return biz.save();
}
