// routes/mobileEntitlements.js
// ─────────────────────────────────────────────────────────────────────────────
// What the signed-in mobile user is entitled to: trial window, AI credits,
// caps, plan — so the app can SHOW "Trial: 2 days left · 3 AI credits" and the
// right upgrade prompts. Also starts the 3-day trial on first open, and gives a
// Stripe card-checkout URL for Android.
//
// Mount in server.js (before /api/mobile):
//   import mobileEntitlementsRouter from "./routes/mobileEntitlements.js";
//   app.use("/api/mobile/me", mobileEntitlementsRouter);
// ─────────────────────────────────────────────────────────────────────────────
import express, { Router } from "express";
import Stripe from "stripe";
import User from "../models/user.js";
import Payment from "../models/payment.js";
import { requireMobileAuth } from "./mobileApi.js";
import { getTeacherCreditInfo } from "../services/aiQuizGenerator.js";

const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;
const SITE_URL = (process.env.SITE_URL || "https://cripfcnt.com").replace(/\/$/, "");
const PLANS = {
  silver: { name: "Silver", amount: 5 }, gold: { name: "Gold", amount: 10 },
  teacher_starter: { name: "Teacher Starter", amount: 9 }, teacher_professional: { name: "Teacher Professional", amount: 19 }
};

const router = Router();
router.use(express.json({ limit: "64kb" }));

// ── What this user gets (trial, credits, caps, plan) ────────────────────────
router.get("/entitlements", requireMobileAuth, async (req, res) => {
  try {
    const user = await User.findById(req.mobileUser._id);
    if (!user) return res.status(404).json({ error: "Account not found." });

    // Start the 3-day trial the first time any user opens the app.
    if (typeof user.ensureTrialStarted === "function" && user.ensureTrialStarted(3)) await user.save();

    const trialActive = typeof user.isTrialActive === "function"
      ? user.isTrialActive()
      : (!!user.trialEndsAt && new Date(user.trialEndsAt) > new Date());
    const daysLeft = user.trialEndsAt
      ? Math.max(0, Math.ceil((new Date(user.trialEndsAt) - new Date()) / 86400000)) : 0;

    // AI credits (teachers) — grant the monthly allowance if due, then read it.
    let aiCredits = user.aiQuizCredits ?? 0, aiAllowance = 0;
    const isTeacher = ["private_teacher", "teacher"].includes(user.role) ||
      user.activeMobileRole === "teacher" || (Array.isArray(user.mobileRoles) && user.mobileRoles.includes("teacher"));
    if (isTeacher) { try { const info = await getTeacherCreditInfo(user._id); aiCredits = info.credits; aiAllowance = info.allowance; } catch (_) {} }

    const planActive = typeof user.isAnyPlanPaid === "function"
      ? user.isAnyPlanPaid()
      : (user.subscriptionStatus === "paid" || user.teacherSubscriptionStatus === "paid" || user.employeeSubscriptionStatus === "paid");
    const quizCap = typeof user.monthlyQuizCap === "function"
      ? user.monthlyQuizCap() : (planActive ? null : (trialActive ? 20 : 10));
    const childLimit = typeof user.getChildLimit === "function"
      ? user.getChildLimit() : (planActive ? (user.maxChildren || 2) : 2);

    res.json({
      trial: { active: !!trialActive, endsAt: user.trialEndsAt || null, daysLeft },
      plan: { active: !!planActive, parent: user.subscriptionPlan || "none", teacher: user.teacherSubscriptionPlan || "none" },
      aiCredits, aiAllowance, isTeacher,
      caps: { childLimit, quizCap },
      // The app decides what to show per platform (see notes): iOS → website note; Android → pay buttons.
      webPaymentUrl: `${SITE_URL}/parent/dashboard`
    });
  } catch (e) { console.error("[entitlements]", e); res.status(500).json({ error: "Failed" }); }
});

// ── Android card payment → a Stripe Checkout URL to open in the browser ─────
router.post("/stripe-checkout", requireMobileAuth, async (req, res) => {
  try {
    if (!stripe) return res.status(500).json({ error: "Card payments are not configured." });
    const plan = String(req.body?.plan || ""); const cfg = PLANS[plan];
    if (!cfg) return res.status(400).json({ error: "Invalid plan." });
    const user = req.mobileUser;
    const crypto = (await import("crypto")).default;
    const reference = `ST-${crypto.randomUUID()}`;
    const payment = await Payment.create({ userId: user._id, reference, amount: cfg.amount, plan, status: "pending", meta: { method: "stripe_mobile" } });
    const session = await stripe.checkout.sessions.create({
      mode: "payment", payment_method_types: ["card"], customer_email: user.email || undefined,
      line_items: [{ price_data: { currency: "usd", unit_amount: Math.round(cfg.amount * 100), product_data: { name: `CRIPFCnt ${cfg.name} — Monthly` } }, quantity: 1 }],
      success_url: `${SITE_URL}/payments/stripe/success?ref=${reference}`,
      cancel_url: `${SITE_URL}/payments/stripe/cancel?ref=${reference}`,
      metadata: { type: "subscription", userId: String(user._id), plan, paymentId: String(payment._id), reference }
    });
    res.json({ url: session.url });
  } catch (e) { console.error("[mobile stripe]", e); res.status(500).json({ error: "Could not start card payment." }); }
});

export default router;