// services/getBizContext.js
import Business from "../models/business.js";
import UserSession from "../models/userSession.js";
import UserRole from "../models/userRole.js";

/**
 * Shared context loader for BOTH Twilio & Meta
 * ❌ No UI logic
 * ❌ No flows
 * ✅ Only business/session resolution
 */
export async function getBizContext(req, res, providerId) {
  // Normalize phone (same rule as Twilio)
  const phone = providerId.replace(/\D+/g, "");

  // Load user session
  const session = await UserSession.findOne({ phone });

  let biz = null;
  if (session?.activeBusinessId) {
    biz = await Business.findById(session.activeBusinessId);
  }

  // Helpers injected into dispatcher
  const helpers = {
    sendTwimlText: (res, text) => {
      res.set("Content-Type", "text/plain");
      res.send(text || "");
    },

    async saveBiz(biz) {
      if (!biz) return;
      if (typeof biz.markModified === "function") {
        biz.markModified("sessionData");
      }
      return biz.save();
    },

    async resetSession(biz) {
      if (!biz) return;
      biz.sessionState = null;
      biz.sessionData = {};
      return biz.save();
    },

    async sendMenuForUser(res, biz, providerId) {
      const roleRec = await UserRole.findOne({
        businessId: biz._id,
        phone: providerId
      });

      if (!roleRec) {
        return helpers.sendTwimlText(
          res,
          "⛔ You are not assigned to this business."
        );
      }

      // IMPORTANT:
      // Twilio already formats menus as text
      // Meta will never call this directly
      const role = roleRec.role;

      if (role === "owner") {
        return helpers.sendTwimlText(res, "Reply *menu* to continue.");
      }

      return helpers.sendTwimlText(res, "Reply *menu* to continue.");
    }
  };

  return { biz, helpers };
}
