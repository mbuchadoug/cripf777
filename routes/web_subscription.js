import express from "express";
import { requireWebAuth } from "../middleware/webAuth.js";
import Business from "../models/business.js";
import SubscriptionPayment from "../models/subscriptionPayment.js";
import paynow from "../services/paynow.js";
import { SUBSCRIPTION_PLANS } from "../services/subscriptionPlans.js";
import { PACKAGES } from "../services/packages.js";
import { generatePDF } from "../routes/twilio_biz.js";
import { sendText } from "../services/metaSender.js";

const router = express.Router();

// ── GET /web/subscription ────────────────────────────────────────────────────
router.get("/subscription", requireWebAuth, async (req, res) => {
  try {
    const business = await Business.findById(req.webUser.businessId).lean();
    if (!business) return res.redirect("/web/dashboard");

    // Last 10 payments
    const payments = await SubscriptionPayment.find({ businessId: business._id })
      .sort({ createdAt: -1 })
      .limit(10)
      .lean();

    const plans = Object.values(SUBSCRIPTION_PLANS);
    const now = new Date();
    const endsAt = business.subscriptionEndsAt ? new Date(business.subscriptionEndsAt) : null;
    const isActive = endsAt && endsAt > now;
    const daysLeft = isActive ? Math.ceil((endsAt - now) / (1000 * 60 * 60 * 24)) : 0;

    res.render("web/subscription", {
      layout: "web",
      pageTitle: "Subscription",
      pageKey: "subscription",
      user: req.webUser,
      business,
      plans,
      payments,
      isActive,
      daysLeft,
      endsAt: endsAt ? endsAt.toDateString() : null,
      success: req.query.success || null,
      error: req.query.error || null,
      pending: req.query.pending || null
    });
  } catch (err) {
    console.error("Subscription GET error:", err);
    res.redirect("/web/dashboard");
  }
});

// ── POST /web/subscription/pay ───────────────────────────────────────────────
// Body: { planKey, ecocashPhone }
router.post("/subscription/pay", requireWebAuth, async (req, res) => {
  try {
    const { planKey, ecocashPhone } = req.body;

    // ── Validate plan ────────────────────────────────────────────────────────
    const plan = SUBSCRIPTION_PLANS[planKey];
    if (!plan) return res.redirect("/web/subscription?error=invalid_plan");

    // ── Normalize phone ──────────────────────────────────────────────────────
    const phone = normalizeEcocash(ecocashPhone);
    if (!phone) return res.redirect("/web/subscription?error=invalid_phone");

    const business = await Business.findById(req.webUser.businessId);
    if (!business) return res.redirect("/web/dashboard");

    // ── Proration logic (mirrors chatbotEngine.js exactly) ───────────────────
    const now = new Date();
    const currentKey = business.package || "trial";
    const currentPlan = SUBSCRIPTION_PLANS[currentKey];
    const currentPrice = currentPlan?.price || 0;
    const endsAt = business.subscriptionEndsAt ? new Date(business.subscriptionEndsAt) : null;
    const hasActiveCycle = endsAt && endsAt > now;

    let chargeAmount = plan.price;

    if (hasActiveCycle && plan.price > currentPrice) {
      const remainingDays = Math.max(0, (endsAt - now) / (1000 * 60 * 60 * 24));
      const diff = plan.price - currentPrice;
      chargeAmount = Math.max(0.01, parseFloat((diff * (remainingDays / plan.durationDays)).toFixed(2)));
    }

    // ── Create Paynow payment ────────────────────────────────────────────────
    const reference = `WEB_SUB_${business._id}_${Date.now()}`;
    const payment = paynow.createPayment(reference, business.email || process.env.PAYNOW_DEFAULT_EMAIL || "billing@zimquote.co.zw");
    payment.currency = plan.currency;
    payment.add(`${plan.name} Package`, chargeAmount);

    const response = await paynow.sendMobile(payment, phone, "ecocash");

    if (!response.success) {
      console.error("Paynow initiation failed:", response);
      return res.redirect("/web/subscription?error=paynow_failed");
    }

    // ── Save pending record ──────────────────────────────────────────────────
    await SubscriptionPayment.create({
      businessId: business._id,
      packageKey: planKey,
      amount: chargeAmount,
      currency: plan.currency,
      reference,
      pollUrl: response.pollUrl,
      ecocashPhone: phone,
      status: "pending"
    });

    // ── WhatsApp notification to business owner ──────────────────────────────
    try {
      const ownerPhone = business.ownerPhone;
      if (ownerPhone) {
        const waFrom = ownerPhone.startsWith("263") ? `+${ownerPhone}` : ownerPhone;
        await sendText(waFrom,
`💳 *ZimQuote Subscription Payment*

Package: *${plan.name}*
Amount: *${chargeAmount} ${plan.currency}*
EcoCash: ${phone}

Please enter your EcoCash PIN to confirm. ✅`);
      }
    } catch (smsErr) {
      console.warn("WhatsApp notification failed (non-fatal):", smsErr.message);
    }

    // ── Poll in background ───────────────────────────────────────────────────
    pollPaymentBackground({
      pollUrl: response.pollUrl,
      reference,
      businessId: business._id,
      planKey,
      chargeAmount,
      plan
    });

    return res.redirect(`/web/subscription?pending=1&plan=${plan.name}&amount=${chargeAmount}`);

  } catch (err) {
    console.error("Subscription pay error:", err);
    return res.redirect("/web/subscription?error=server_error");
  }
});

// ── GET /web/subscription/status/:reference ──────────────────────────────────
// Polling endpoint called by frontend JS every 5s
router.get("/subscription/status/:reference", requireWebAuth, async (req, res) => {
  try {
    const record = await SubscriptionPayment.findOne({
      reference: req.params.reference,
      businessId: req.webUser.businessId
    }).lean();

    if (!record) return res.json({ status: "not_found" });
    res.json({ status: record.status, paidAt: record.paidAt });
  } catch (err) {
    res.json({ status: "error" });
  }
});

// ── Background poller (mirrors chatbotEngine.js logic exactly) ───────────────
function pollPaymentBackground({ pollUrl, reference, businessId, planKey, chargeAmount, plan }) {
  let attempts = 0;
  const MAX_ATTEMPTS = 18; // 3 minutes at 10s intervals

  const interval = setInterval(async () => {
    attempts++;
    try {
      const status = await paynow.pollTransaction(pollUrl);

      if (status.status && status.status.toLowerCase() === "paid") {
        clearInterval(interval);

        const freshBiz = await Business.findById(businessId);
        if (!freshBiz) return;

        const now = new Date();
        const currentEnds = freshBiz.subscriptionEndsAt ? new Date(freshBiz.subscriptionEndsAt) : null;
        const hasActive = currentEnds && currentEnds > now;

        // Extend or start new cycle
        if (!hasActive) {
          freshBiz.subscriptionStartedAt = now;
          freshBiz.subscriptionEndsAt = new Date(now.getTime() + plan.durationDays * 24 * 60 * 60 * 1000);
        }

        freshBiz.package = planKey;
        freshBiz.subscriptionStatus = "active";
        await freshBiz.save();

        // Update payment record
        const receiptNumber = `SUB-${reference.slice(-8).toUpperCase()}`;
        const payRec = await SubscriptionPayment.findOne({ reference });

        // Generate PDF receipt
        try {
          const { filename } = await generatePDF({
            type: "receipt",
            number: receiptNumber,
            date: now,
            billingTo: `${freshBiz.name} (Subscription)`,
            items: [{ item: `${plan.name} Package`, qty: 1, unit: chargeAmount, total: chargeAmount }],
            bizMeta: {
              name: "ZimQuote",
              logoUrl: "",
              address: "ZimQuote",
              _id: freshBiz._id.toString(),
              status: "paid"
            }
          });

          const site = (process.env.SITE_URL || "").replace(/\/$/, "");
          const receiptUrl = `${site}/docs/generated/receipts/${filename}`;

          if (payRec) {
            payRec.status = "paid";
            payRec.paidAt = now;
            payRec.receiptFilename = filename;
            payRec.receiptUrl = receiptUrl;
            await payRec.save();
          }

          // WhatsApp success notification
          try {
            if (freshBiz.ownerPhone) {
              const { sendDocument } = await import("../services/metaSender.js");
              const waFrom = freshBiz.ownerPhone.startsWith("263")
                ? `+${freshBiz.ownerPhone}` : freshBiz.ownerPhone;
              await sendDocument(waFrom, { link: receiptUrl, filename });
              await sendText(waFrom,
`✅ *Payment Confirmed!*

Package: *${planKey.toUpperCase()}*
Amount: *${chargeAmount} ${plan.currency}*
Next renewal: *${freshBiz.subscriptionEndsAt.toDateString()}*

Thank you for subscribing to ZimQuote! 🎉`);
            }
          } catch (e) {
            console.warn("WhatsApp success notification failed:", e.message);
          }

        } catch (pdfErr) {
          console.error("PDF generation failed:", pdfErr);
          if (payRec) {
            payRec.status = "paid";
            payRec.paidAt = now;
            await payRec.save();
          }
        }
      }

      if (status.status && ["failed", "cancelled"].includes(status.status.toLowerCase())) {
        clearInterval(interval);
        await SubscriptionPayment.findOneAndUpdate({ reference }, { status: "failed" });
      }

    } catch (pollErr) {
      console.error("Poll error:", pollErr.message);
    }

    if (attempts >= MAX_ATTEMPTS) {
      clearInterval(interval);
      // Mark as failed if still pending after timeout
      await SubscriptionPayment.findOneAndUpdate(
        { reference, status: "pending" },
        { status: "failed" }
      ).catch(() => {});
    }
  }, 10000);
}

// ── Phone normalizer (mirrors chatbotEngine.js normalizeEcocashNumber) ────────
function normalizeEcocash(input) {
  if (!input) return null;
  const raw = input.replace(/\D+/g, "");
  if (raw.startsWith("263") && raw.length === 12) return "0" + raw.slice(3);
  if (raw.startsWith("0") && raw.length === 10) return raw;
  if (raw.length === 9 && raw.startsWith("7")) return "0" + raw;
  return null;
}

export default router;