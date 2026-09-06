// ==============================
// 🛒 PUBLIC SELF-SERVICE PURCHASE  (mounted at /hotspot/pay)
// PUBLIC - no admin login. A guest behind the captive portal buys a voucher
// with EcoCash and gets a code back. Reuses your existing Paynow service and
// Payment model (same pattern as routes/payments.js).
//
// ⚠️ For a guest (not yet online) to reach this page + Paynow, you MUST add a
// Walled Garden rule on the router so cripfcnt.com + paynow.co.zw are reachable
// BEFORE login. See README for the two commands. EcoCash approval itself is a
// USSD prompt on the phone's cellular line, so it works even without WiFi data.
// ==============================

import { Router } from "express";
import crypto from "crypto";

import paynow from "../../services/paynow.js";       // your existing Paynow service
import Payment from "../../models/payment.js";        // your existing Payment model
import HotspotPlan from "../models/hotspotPlan.js";
import Voucher from "../models/voucher.js";
import * as mt from "../services/mikrotik.js";

const router = Router();

const WIFI_NAME = process.env.HOTSPOT_WIFI_NAME || "Central Cyber WiFi";
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

function randomCode() {
  const pick = (n) => Array.from({ length: n }, () => ALPHABET[crypto.randomInt(ALPHABET.length)]).join("");
  return `${pick(3)}-${pick(3)}`;
}
async function uniqueCode() {
  for (let i = 0; i < 12; i++) {
    const c = randomCode();
    if (!(await Voucher.exists({ code: c }))) return c;
  }
  return `${randomCode()}-${Date.now().toString(36).slice(-3).toUpperCase()}`;
}

// Push a paid voucher onto the router (create the hotspot user).
async function activateVoucher(v) {
  const plan = await HotspotPlan.findOne({ key: v.planKey });
  const profileName = plan ? plan.rosProfile() : `hs_${v.planKey}`;
  if (mt.isConfigured()) {
    try {
      if (plan) await mt.ensureProfile({ name: profileName, sharedUsers: v.deviceCap, rateLimit: plan.rateLimitString() });
      v.rosUserId = await mt.addVoucherUser({
        code: v.code, profile: profileName,
        limitUptimeMinutes: v.durationType === "uptime" ? v.durationMinutes : 0
      });
      v.syncedToRouter = true; v.lastSyncError = null;
    } catch (err) { v.syncedToRouter = false; v.lastSyncError = err?.message; }
  }
  await v.save();
}

// Public plan list (only what a buyer needs).
router.get("/plans", async (req, res) => {
  const plans = await HotspotPlan.find({ active: true }).sort({ sortOrder: 1 }).lean();
  res.json({
    wifiName: WIFI_NAME,
    plans: plans.map((p) => ({
      key: p.key, label: p.label, durationMinutes: p.durationMinutes,
      durationType: p.durationType, deviceCap: p.deviceCap, price: p.price, currency: p.currency
    }))
  });
});

// Start an EcoCash purchase → USSD prompt to the phone.
router.post("/init", async (req, res) => {
  try {
    const { planKey, phone } = req.body || {};
    const plan = await HotspotPlan.findOne({ key: String(planKey || "").toLowerCase(), active: true });
    if (!plan) return res.status(400).json({ error: "Choose a valid plan." });

    const normalizedPhone = String(phone || "").replace(/\s|-/g, "").replace(/^\+263/, "0").replace(/^263/, "0");
    if (!/^07[7-8]\d{7}$/.test(normalizedPhone)) {
      return res.status(400).json({ error: "Enter a valid EcoCash number, e.g. 0771234567" });
    }

    // Reserve the voucher up front (status unused; activated on payment).
    const code = await uniqueCode();
    const voucher = await Voucher.create({
      code, planKey: plan.key, planLabel: plan.label,
      durationType: plan.durationType, durationMinutes: plan.durationMinutes,
      deviceCap: plan.deviceCap, downKbps: plan.downKbps, upKbps: plan.upKbps,
      price: plan.price, currency: plan.currency, paymentMethod: "ecocash",
      createdByName: "self-service", note: `EcoCash ${normalizedPhone}`,
      syncedToRouter: false
    });

    const reference = `HS-${crypto.randomUUID()}`;
    const paymentRequest = paynow.createPayment(reference, `${normalizedPhone}@ecocash.local`);
    paymentRequest.add(`${plan.label} - Central Cyber WiFi`, plan.price);

    const response = await paynow.sendMobile(paymentRequest, normalizedPhone, "ecocash");
    if (!response.success) {
      await Voucher.deleteOne({ _id: voucher._id });
      return res.status(400).json({ error: response.error || "Could not send EcoCash prompt. Check your number." });
    }

    await Payment.create({
      reference, amount: plan.price, plan: plan.key, pollUrl: response.pollUrl,
      status: "pending", meta: { method: "hotspot_ecocash", phone: normalizedPhone, voucherCode: code }
    });

    res.json({ reference, message: `Check ${normalizedPhone} and approve the EcoCash prompt.` });
  } catch (err) {
    console.error("[hotspot pay init]", err);
    res.status(500).json({ error: "Payment error. Please try again." });
  }
});

// Poll for payment; on success, activate the voucher and return the code.
router.get("/poll/:reference", async (req, res) => {
  try {
    const payment = await Payment.findOne({ reference: req.params.reference });
    if (!payment) return res.status(404).json({ status: "not_found" });

    if (payment.status === "paid") {
      const v = await Voucher.findOne({ code: payment.meta?.voucherCode });
      return res.json({ status: "paid", code: v?.code, wifiName: WIFI_NAME });
    }
    if (["failed", "cancelled"].includes(payment.status)) return res.json({ status: payment.status });

    if (payment.pollUrl) {
      const pollResult = await paynow.pollTransaction(payment.pollUrl);
      const statusStr = String(pollResult.status || "").toLowerCase();

      if (statusStr === "paid") {
        payment.status = "paid"; payment.paidAt = new Date(); await payment.save();
        const v = await Voucher.findOne({ code: payment.meta?.voucherCode });
        if (v) await activateVoucher(v);
        return res.json({ status: "paid", code: v?.code, wifiName: WIFI_NAME });
      }
      if (["failed", "cancelled"].includes(statusStr)) {
        payment.status = statusStr; await payment.save();
        await Voucher.deleteOne({ code: payment.meta?.voucherCode });   // release reserved code
        return res.json({ status: statusStr });
      }
    }
    res.json({ status: "pending" });
  } catch (err) {
    console.error("[hotspot pay poll]", err);
    res.json({ status: "pending" });
  }
});

export default router;