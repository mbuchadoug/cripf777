import express from "express";
import Stripe from "stripe";
import dotenv from "dotenv";

import User from "../models/user.js";
import AuditPurchase from "../models/auditPurchase.js"; // ✅ NEW

dotenv.config();

const router = express.Router();

if (!process.env.STRIPE_SECRET_KEY) {
  throw new Error("❌ STRIPE_SECRET_KEY is missing at runtime");
}

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

/**
 * Stripe Webhook
 * Handles:
 * 1) Live SCOI audit credits (consumable)
 * 2) SCOI audit report purchases (asset / ownership)
 */
router.post("/", async (req, res) => {
  const sig = req.headers["stripe-signature"];
  const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

  let event;

  try {
    event = stripe.webhooks.constructEvent(
      req.body,   // ✅ RAW BUFFER (do not JSON parse)
      sig,
      endpointSecret
    );
  } catch (err) {
    console.error("❌ Webhook verification failed:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // ─────────────────────────────────────────────
  // ✅ PAYMENT SUCCESS
  // ─────────────────────────────────────────────
  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const meta = session.metadata || {};

    /**
     * ─────────────────────────────
     * 1️⃣ LIVE SCOI SEARCH CREDITS
     * (existing behavior — unchanged)
     * ─────────────────────────────
     */
    if (meta.userId && meta.credits) {
      const credits = Number(meta.credits);

      if (credits > 0) {
        await User.findByIdAndUpdate(meta.userId, {
          $inc: { auditCredits: credits },
          $set: { paidAt: new Date() }
        });

        console.log(`✅ Added ${credits} live SCOI credits to user ${meta.userId}`);
      }
    }

    /**
     * ─────────────────────────────
     * 2️⃣ SCOI AUDIT REPORT PURCHASE
     * (new asset-based product)
     * ─────────────────────────────
     */
    if (meta.type === "scoi_audit_report") {
      const { userId, auditId, price } = meta;

      if (!userId || !auditId) {
        console.error("❌ Missing metadata for audit purchase");
      } else {
        // Prevent duplicate ownership (idempotency safety)
        const exists = await AuditPurchase.findOne({
          stripeSessionId: session.id
        });

        if (!exists) {
          await AuditPurchase.create({
            userId,
            auditId,
            pricePaid: Number(price || 0),
            stripeSessionId: session.id
          });

          console.log(
            `📄 SCOI audit report purchased | user=${userId} audit=${auditId}`
          );
        }
      }
    }
  }

  res.json({ received: true });
});

export default router;
