// routes/scoi_checkout.js
// Handles Stripe checkout session creation and webhook fulfillment.
// On successful payment the webhook saves an AuditPurchase record so the
// user can view/download from /scoi/purchased.

import { Router } from "express";
import Stripe from "stripe";
import express from "express";
import { ensureAuth } from "../middleware/authGuard.js";
import PlacementAudit from "../models/placementAudit.js";
import SpecialScoiAudit from "../models/specialScoiAudit.js";
import AuditPurchase from "../models/auditPurchase.js";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const router = Router();

// ── CREATE CHECKOUT SESSION ──────────────────────────────────────────────────
router.post("/scoi/checkout", ensureAuth, async (req, res) => {
  const { auditId } = req.body;

  let audit, price, productName, auditModel;

  // Try Placement first
  audit = await PlacementAudit.findById(auditId);
  if (audit) {
    price = 14900; // $149.00
    productName = `SCOI Placement Audit: ${audit.subject.name}`;
    auditModel = "PlacementAudit";
  }

  // Try Special SCOI
  if (!audit) {
    audit = await SpecialScoiAudit.findById(auditId);
    if (audit) {
      price = 29900; // $299.00
      productName = `SCOI Special Report: ${audit.subject.name}`;
      auditModel = "SpecialScoiAudit";
    }
  }

  if (!audit) {
    return res.status(404).send("Audit not found");
  }

  // Create Stripe checkout session
  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    payment_method_types: ["card"],
    customer_email: req.user.email,
    line_items: [{
      price_data: {
        currency: "usd",
        product_data: {
          name: productName,
          description: `Assessment Window: ${audit.assessmentWindow.label}`,
          metadata: {
            auditId: audit._id.toString(),
            auditType: audit.auditClass || "placement"
          }
        },
        unit_amount: price
      },
      quantity: 1
    }],
    metadata: {
      type: "scoi_audit_report",
      userId: req.user._id.toString(),
      auditId: audit._id.toString(),
      auditModel,
      price: price.toString()
    },
    success_url: `${process.env.SITE_URL}/scoi/purchased?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${process.env.SITE_URL}/scoi`
  });

  res.redirect(session.url);
});

// ── STRIPE WEBHOOK ───────────────────────────────────────────────────────────
// Must be mounted with express.raw() — raw body required for signature verification.
// Register this route BEFORE express.json() middleware in your app.js:
//
//   app.use('/stripe/webhook', express.raw({ type: 'application/json' }), scoiCheckoutRouter);
//
// Or use a dedicated webhook router mounted before body-parsers.

router.post(
  "/stripe/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const sig = req.headers["stripe-signature"];
    let event;

    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.error("[Stripe webhook] Signature verification failed:", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    // Only handle successful checkout completions
    if (event.type === "checkout.session.completed") {
      const session = event.data.object;

      // Only process SCOI audit purchases
      if (session.metadata?.type !== "scoi_audit_report") {
        return res.json({ received: true });
      }

      const { userId, auditId, auditModel, price } = session.metadata;

      try {
        // Idempotent: skip if already recorded (e.g. duplicate webhook delivery)
        const exists = await AuditPurchase.findOne({
          stripeSessionId: session.id
        }).lean();

        if (!exists) {
          await AuditPurchase.create({
            userId,
            auditId,
            auditModel,
            pricePaid: parseInt(price, 10),
            stripeSessionId: session.id,
            stripePaymentIntent: session.payment_intent || null,
            customerEmail: session.customer_email || null,
            status: "completed"
          });
          console.log(`[Stripe webhook] ✅ Purchase recorded — audit: ${auditId}, user: ${userId}`);
        } else {
          console.log(`[Stripe webhook] ℹ️  Duplicate session skipped: ${session.id}`);
        }
      } catch (err) {
        console.error("[Stripe webhook] Failed to save purchase:", err.message);
        // Return 200 so Stripe doesn't retry indefinitely for DB errors;
        // log the failure and investigate separately.
      }
    }

    res.json({ received: true });
  }
);

// ── PAYMENT SUCCESS LANDING ──────────────────────────────────────────────────
/**
 * GET /scoi/checkout/success
 * Fallback for when the webhook hasn't fired yet by the time the user
 * lands on the success URL. Verifies the session server-side and creates
 * the purchase record if it doesn't already exist.
 *
 * The success_url includes ?session_id={CHECKOUT_SESSION_ID} so we can
 * verify payment status without trusting URL parameters alone.
 */
router.get("/scoi/checkout/success", ensureAuth, async (req, res) => {
  const { session_id } = req.query;

  if (!session_id) {
    return res.redirect("/scoi/purchased");
  }

  try {
    const session = await stripe.checkout.sessions.retrieve(session_id);

    if (
      session.payment_status === "paid" &&
      session.metadata?.type === "scoi_audit_report"
    ) {
      const { userId, auditId, auditModel, price } = session.metadata;

      // Idempotent upsert — safe to call even if webhook already ran
      const existing = await AuditPurchase.findOne({
        stripeSessionId: session.id
      }).lean();

      if (!existing) {
        await AuditPurchase.create({
          userId,
          auditId,
          auditModel,
          pricePaid: parseInt(price, 10),
          stripeSessionId: session.id,
          stripePaymentIntent: session.payment_intent || null,
          customerEmail: session.customer_email || null,
          status: "completed"
        });
        console.log(`[Checkout success] ✅ Purchase recorded via success page — audit: ${auditId}`);
      }
    }
  } catch (err) {
    console.error("[Checkout success] Session verification error:", err.message);
    // Non-fatal — still redirect to purchased page
  }

  return res.redirect("/scoi/purchased");
});

export default router;