import express from "express";
import Stripe from "stripe";
import dotenv from "dotenv";
import PlacementAudit from "../models/placementAudit.js";
import { generateScoiAuditPdf } from "../utils/generateScoiAuditPdf.js";
import User from "../models/user.js";
import AuditPurchase from "../models/auditPurchase.js";

dotenv.config();

const router = express.Router();

if (!process.env.STRIPE_SECRET_KEY) {
  throw new Error("❌ STRIPE_SECRET_KEY is missing at runtime");
}

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

    /**
     * 1️⃣ LIVE SCOI SEARCH CREDITS
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
     * 2️⃣ SCOI AUDIT REPORT PURCHASE
     */
    if (meta.type === "scoi_audit_report") {
      const { userId, auditId, price } = meta;

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

      await AuditPurchase.create({
        userId,
        auditId,
        pricePaid: Number(price || 0),
        stripeSessionId: session.id
      });

      const audit = await PlacementAudit.findByIdAndUpdate(
        auditId,
        { isPaid: true },
        { new: true }
      );

      if (audit && !audit.pdfUrl) {
        const pdf = await generateScoiAuditPdf({ audit, req });
        audit.pdfUrl = pdf.url;
        await audit.save();

        console.log("📄 SCOI audit PDF generated:", pdf.url);
      }

     console.log(
    `✅ SCOI audit report purchase complete | user=${userId} audit=${auditId}`
  );
    }

    /**
     * ─────────────────────────────
     * 3️⃣ EMPLOYEE UPGRADE (cripfcnt-school)
     * ─────────────────────────────
     */
    if (meta.upgradeType === "employee_full_access" && meta.orgSlug === "cripfcnt-school") {
      const { userId } = meta;

      if (!userId) {
        console.error("❌ Missing userId for employee upgrade");
        return;
      }

      console.log(`[Stripe Webhook] Processing employee upgrade for user: ${userId}`);

      try {
        // Find user
        const user = await User.findById(userId);
        if (!user) {
          console.error(`[Stripe Webhook] User not found: ${userId}`);
          return;
        }

        // Find org
        const Organization = (await import("../models/organization.js")).default;
        const org = await Organization.findOne({ slug: "cripfcnt-school" });
        if (!org) {
          console.error(`[Stripe Webhook] cripfcnt-school org not found`);
          return;
        }

        // Update user subscription status
        user.employeeSubscriptionStatus = 'paid';
        user.employeeSubscriptionPlan = 'full_access';
        user.employeeSubscriptionExpiresAt = null; // Lifetime access
        user.employeePaidAt = new Date();
        await user.save();

        console.log(`[Stripe Webhook] ✅ Updated user ${userId} to paid status`);

        // Unlock all quizzes
        const { unlockAllEmployeeQuizzes } = await import("../services/employeeTrialAssignment.js");
        const result = await unlockAllEmployeeQuizzes({
          orgId: org._id,
          userId: user._id
        });

        console.log(
          `[Stripe Webhook] ✅ Unlocked ${result.unlocked}/${result.total} quizzes for user ${userId}`
        );

      } catch (err) {
        console.error('[Stripe Webhook] Error processing employee upgrade:', err);
      }
    }

  }

  res.json({ received: true });
});

export default router;