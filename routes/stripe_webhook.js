
import express from "express";
import Stripe from "stripe";
import dotenv from "dotenv";
import User from "../models/user.js";
import AuditPurchase from "../models/auditPurchase.js";

dotenv.config();

const router = express.Router();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

router.post("/", async (req, res) => {
  const sig = req.headers["stripe-signature"];
  const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

  let event;

  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      endpointSecret
    );
  } catch (err) {
    console.error("❌ Webhook verification failed:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // ✅ PAYMENT SUCCESS
  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const meta = session.metadata || {};

    // 1️⃣ LIVE SCOI CREDITS
    if (meta.userId && meta.credits) {
      const credits = Number(meta.credits);
      if (credits > 0) {
        await User.findByIdAndUpdate(meta.userId, {
          $inc: { auditCredits: credits },
          $set: { paidAt: new Date() }
        });
        console.log(`✅ Added ${credits} SCOI credits to user ${meta.userId}`);
      }
    }

    // 2️⃣ SCOI AUDIT REPORT PURCHASE (with auto PDF generation)
    if (meta.type === "scoi_audit_report") {
      const { userId, auditId, auditModel, price } = meta;

      if (!userId || !auditId) {
        console.error("❌ Missing metadata for audit purchase");
        return;
      }

      const exists = await AuditPurchase.findOne({
        stripeSessionId: session.id
      });

      if (exists) {
        console.log("⚠️ Duplicate webhook ignored:", session.id);
        return;
      }

      try {
        await AuditPurchase.create({
          userId,
          auditId,
          pricePaid: Number(price || 0),
          stripeSessionId: session.id
        });

        console.log(`✅ SCOI audit purchased: ${auditId} by user ${userId}`);

        // Get audit
        let audit;
        if (auditModel === "SpecialScoiAudit") {
          const SpecialScoiAudit = (await import("../models/specialScoiAudit.js")).default;
          audit = await SpecialScoiAudit.findById(auditId);
        } else {
          const PlacementAudit = (await import("../models/placementAudit.js")).default;
          audit = await PlacementAudit.findById(auditId);
        }

        if (!audit) {
          console.error(`❌ Audit not found: ${auditId}`);
          return;
        }

        // ✨ AUTO-GENERATE PDF
        if (!audit.pdfUrl) {
          console.log(`[PDF Auto-Gen] Generating PDF for audit: ${auditId}`);
          
          const { generateScoiPdf } = await import("../utils/generateScoiPdf.js");
          const pdf = await generateScoiPdf(audit);
          
          audit.pdfUrl = pdf.url;
          audit.isPaid = true;
          await audit.save();

          console.log(`[PDF Auto-Gen] ✅ PDF generated: ${pdf.url}`);
        } else {
          audit.isPaid = true;
          await audit.save();
          console.log(`[PDF Auto-Gen] PDF already exists`);
        }

      } catch (err) {
        console.error('[SCOI Purchase Error]', err);
      }
    }

    // 3️⃣ EMPLOYEE UPGRADE
    if (meta.upgradeType === "employee_full_access" && meta.orgSlug === "cripfcnt-school") {
      // ... existing employee upgrade code ...
    }
  }

  res.json({ received: true });
});

export default router;
