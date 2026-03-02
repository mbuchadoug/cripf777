import { Router } from "express";
import crypto from "crypto";
import paynow from "../services/paynow.js";
import Payment from "../models/payment.js";
import User from "../models/user.js";
import { ensureAuth } from "../middleware/authGuard.js";
import QuizRule from "../models/quizRule.js";
import { assignQuizFromRule } from "../services/quizAssignment.js";
import Organization from "../models/organization.js";

import BattleEntry from "../models/battleEntry.js";

const router = Router();

// ==============================
// 💳 PLAN DEFINITIONS
// ==============================
const PLANS = {
  silver: {
    name: "Silver",
    amount: 5,
    maxChildren: 2,
    durationDays: 30
  },
  gold: {
    name: "Gold",
    amount: 10,
    maxChildren: 5,
    durationDays: 30
  },
  teacher_starter: {
    name: "Teacher Starter",
    amount: 9,
    maxChildren: 15,
    aiQuizCredits: 20,
    durationDays: 30
  },
  teacher_professional: {
    name: "Teacher Professional",
    amount: 19,
    maxChildren: 40,
    aiQuizCredits: 50,
    durationDays: 30
  }
};

/* ------------------------------
   SHARED: Process a successful payment
   Called by webhook AND manual poll
-------------------------------- */
async function processSuccessfulPayment(paymentId) {
  const payment = await Payment.findById(paymentId);
  if (!payment || payment.status === "paid") return; // idempotent

  payment.status = "paid";
  payment.paidAt = new Date();
  await payment.save();

  // Battle entry — stop here
  if (payment.type === "battle_entry" && payment.battleId) {
    const BattleEntry = (await import("../models/battleEntry.js")).default;
    await BattleEntry.updateOne(
      { battleId: payment.battleId, userId: payment.userId },
      { $set: { status: "paid", paidAt: new Date() } }
    );
    return;
  }

  // Subscription payment
  const planKey = payment.plan || "silver";
  const planConfig = PLANS[planKey] || PLANS.silver;
  const now = new Date();

  const parent = await User.findById(payment.userId).lean();
  let daysToAdd = planConfig.durationDays;

  // Proration on upgrade
  if (parent.subscriptionExpiresAt && new Date(parent.subscriptionExpiresAt) > now) {
    const currentPlanKey = planKey.startsWith("teacher_")
      ? `teacher_${parent.teacherSubscriptionPlan}`
      : parent.subscriptionPlan;

    const currentPlanConfig = PLANS[currentPlanKey];
    if (currentPlanConfig && planConfig.amount > currentPlanConfig.amount) {
      const remainingDays = Math.ceil(
        (new Date(parent.subscriptionExpiresAt) - now) / (1000 * 60 * 60 * 24)
      );
      const unusedValue = (currentPlanConfig.amount / currentPlanConfig.durationDays) * remainingDays;
      const creditDays = Math.floor((unusedValue / planConfig.amount) * planConfig.durationDays);
      daysToAdd += creditDays;
    }
  }

  let expiresAt;
  if (parent.subscriptionExpiresAt && new Date(parent.subscriptionExpiresAt) > now) {
    expiresAt = new Date(parent.subscriptionExpiresAt);
    expiresAt.setDate(expiresAt.getDate() + daysToAdd);
  } else {
    expiresAt = new Date(now);
    expiresAt.setDate(expiresAt.getDate() + daysToAdd);
  }

  let updateFields;
  if (planKey.startsWith("teacher_")) {
    updateFields = {
      teacherSubscriptionStatus: "paid",
      teacherSubscriptionPlan: planKey === "teacher_starter" ? "starter" : "professional",
      teacherSubscriptionExpiresAt: expiresAt,
      teacherPaidAt: now,
      aiQuizCredits: planConfig.aiQuizCredits,
      aiQuizCreditsResetAt: now,
      maxChildren: planConfig.maxChildren,
      consumerEnabled: true
    };
  } else {
    updateFields = {
      subscriptionStatus: "paid",
      subscriptionPlan: planKey,
      maxChildren: planConfig.maxChildren,
      subscriptionExpiresAt: expiresAt,
      paidAt: now,
      consumerEnabled: true
    };
  }

  const updatedUser = await User.findByIdAndUpdate(payment.userId, updateFields, { new: true });

  // Upgrade trial children
  const trialChildren = await User.find({
    parentUserId: payment.userId,
    role: "student",
    consumerEnabled: false
  });

  if (trialChildren.length > 0) {
    await User.updateMany(
      { parentUserId: payment.userId, role: "student", consumerEnabled: false },
      { $set: { consumerEnabled: true } }
    );

    const org = await Organization.findOne({ slug: "cripfcnt-home" }).lean();
    if (org) {
      for (const child of trialChildren) {
        const rules = await QuizRule.find({
          org: org._id,
          grade: child.grade,
          quizType: "paid",
          enabled: true
        });
        for (const rule of rules) {
          await assignQuizFromRule({ rule, userId: child._id, orgId: org._id, force: true });
        }
      }
    }
  }

  await User.updateMany(
    { parentUserId: updatedUser._id, role: "student" },
    { $set: { consumerEnabled: true } }
  );

  const org = await Organization.findOne({ slug: "cripfcnt-home" }).lean();
  if (!org) return;

  const children = await User.find({ parentUserId: updatedUser._id, role: "student" });
  for (const child of children) {
    const rules = await QuizRule.find({ org: org._id, grade: child.grade, quizType: "paid", enabled: true });
    for (const rule of rules) {
      await assignQuizFromRule({ rule, userId: child._id, orgId: org._id, force: true });
    }
  }

  console.log(`[paynow] ${planConfig.name} activated for ${payment.userId}, expires: ${expiresAt.toISOString()}`);
}
/* ------------------------------
   INITIATE MOBILE (EcoCash) PAYMENT
   Returns JSON — frontend polls for status
-------------------------------- */
router.post("/paynow/init", ensureAuth, async (req, res) => {
  try {
    const { plan, phone } = req.body;

    // Validate plan
    if (!plan || !PLANS[plan]) {
      return res.status(400).json({ error: "Invalid plan selected." });
    }

    // ── MOBILE FLOW: phone number provided ──────────────────────────
    if (phone) {
      // Normalize phone: strip spaces/dashes, ensure starts with 07
      const normalizedPhone = String(phone)
        .replace(/\s|-/g, "")
        .replace(/^\+263/, "0")
        .replace(/^263/, "0");

      if (!/^07[7-8]\d{7}$/.test(normalizedPhone)) {
        return res.status(400).json({
          error: "Enter a valid EcoCash number (e.g. 0771234567)"
        });
      }

      const selectedPlan = PLANS[plan];
      const reference = `PN-${crypto.randomUUID()}`;

      const paymentRequest = paynow.createPayment(
        reference,
        req.user.email || `${normalizedPhone}@ecocash.local`
      );
      paymentRequest.add(`${selectedPlan.name} Plan - Monthly`, selectedPlan.amount);

      // sendMobile triggers USSD push to phone
      const response = await paynow.sendMobile(
        paymentRequest,
        normalizedPhone,
        "ecocash"
      );

      console.log("[paynow mobile] response:", response);

      if (!response.success) {
        return res.status(400).json({
          error: response.error || "Failed to send EcoCash prompt. Check your number."
        });
      }

      // Save payment record
      await Payment.create({
        userId: req.user._id,
        reference,
        amount: selectedPlan.amount,
        plan,
        pollUrl: response.pollUrl,
        status: "pending",
        meta: { phone: normalizedPhone, method: "ecocash_mobile" }
      });

      // Return pollUrl to frontend for polling
      return res.json({
        success: true,
        reference,
        pollUrl: response.pollUrl,
        message: `Check your phone (${normalizedPhone}) and approve the EcoCash prompt.`
      });
    }

    // ── WEB FALLBACK: no phone, use redirect checkout ────────────────
    const selectedPlan = PLANS[plan];
    const reference = `PN-${crypto.randomUUID()}`;

    const paymentRequest = paynow.createPayment(
      reference,
      req.user.email || "parent@payment.local"
    );
    paymentRequest.add(`${selectedPlan.name} Plan - Monthly`, selectedPlan.amount);

    const response = await paynow.send(paymentRequest);

    if (!response.success) {
      console.error("[paynow init] web fallback failed", response);
      return res.status(400).json({ error: "Failed to initiate payment" });
    }

    await Payment.create({
      userId: req.user._id,
      reference,
      amount: selectedPlan.amount,
      plan,
      pollUrl: response.pollUrl,
      status: "pending",
      meta: { method: "web_redirect" }
    });

    // For web fallback, return the redirect URL as JSON
    return res.json({
      success: true,
      redirectUrl: response.redirectUrl
    });

  } catch (err) {
    console.error("[paynow init] error:", err);
    return res.status(500).json({ error: "Payment error. Please try again." });
  }
});

/* ------------------------------
   POLL PAYMENT STATUS
   Frontend calls this to check if payment completed
-------------------------------- */
router.get("/paynow/poll/:reference", ensureAuth, async (req, res) => {
  try {
    const payment = await Payment.findOne({
      reference: req.params.reference,
      userId: req.user._id
    }).lean();

    if (!payment) {
      return res.status(404).json({ error: "Payment not found" });
    }

    // Already confirmed by webhook
    if (payment.status === "paid") {
      return res.json({ status: "paid" });
    }
    if (payment.status === "failed" || payment.status === "cancelled") {
      return res.json({ status: payment.status });
    }

    // Still pending — manually poll Paynow
    if (payment.pollUrl) {
      const pollResult = await paynow.pollTransaction(payment.pollUrl);
      const statusStr = String(pollResult.status || "").toLowerCase();

      if (statusStr === "paid") {
        // Webhook may not have fired yet — trigger processing inline
        await processSuccessfulPayment(payment._id);
        return res.json({ status: "paid" });
      }

      if (statusStr === "failed" || statusStr === "cancelled") {
        await Payment.updateOne({ _id: payment._id }, { $set: { status: statusStr } });
        return res.json({ status: statusStr });
      }
    }

    return res.json({ status: "pending" });

  } catch (err) {
    console.error("[paynow poll]", err);
    return res.json({ status: "pending" });
  }
});
/* ------------------------------
   PAYNOW RETURN (Browser redirect)
-------------------------------- */
router.get("/paynow/return", ensureAuth, async (req, res) => {
  try {
    // 1) If this user just paid for a battle entry, send them back to that battle
    const lastBattlePayment = await Payment.findOne({
      userId: req.user._id,
      type: "battle_entry"
    })
      .sort({ createdAt: -1 })
      .select("battleId status reference")
      .lean();

    if (lastBattlePayment?.battleId) {
      // send them back to battle lobby (safe flow)
      return res.redirect(`/arena/lobby?battleId=${lastBattlePayment.battleId}`);
    }

    // 2) Otherwise keep your normal subscription flow
    const user = await User.findById(req.user._id).lean();

    if (user.role === "private_teacher") {
      return res.redirect("/teacher/dashboard");
    }

    return res.redirect("/parent/dashboard");
  } catch (err) {
    console.error("[paynow return] error:", err);
    // fallback
    return res.redirect("/arena");
  }
});

/* ------------------------------
   PAYNOW RESULT (Server callback)
-------------------------------- */
router.post("/paynow/result", async (req, res) => {
  try {
    console.log("[paynow result] CALLBACK RECEIVED", req.body);

    const { reference } = req.body;
    if (!reference) return res.sendStatus(200);

    const payment = await Payment.findOne({ reference });
    if (!payment) return res.sendStatus(200);

    const pollResult = await paynow.pollTransaction(payment.pollUrl);
    console.log("[paynow poll] RESULT:", pollResult);

    const statusStr = String(pollResult.status || "").toLowerCase();

    if (statusStr === "paid") {
      await processSuccessfulPayment(payment._id);
    } else if (statusStr === "failed" || statusStr === "cancelled") {
      payment.status = statusStr;
      await payment.save();
    }

    return res.sendStatus(200);
  } catch (err) {
    console.error("[paynow result] error:", err);
    return res.sendStatus(200);
  }
});

export default router;
