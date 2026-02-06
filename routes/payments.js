import { Router } from "express";
import crypto from "crypto";
import paynow from "../services/paynow.js";
import Payment from "../models/payment.js";
import User from "../models/user.js";
import { ensureAuth } from "../middleware/authGuard.js";
import QuizRule from "../models/quizRule.js";
import { assignQuizFromRule } from "../services/quizAssignment.js";
import Organization from "../models/organization.js";

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
  }
};

/* ------------------------------
   INITIATE PAYMENT
-------------------------------- */
router.post("/paynow/init", ensureAuth, async (req, res) => {
  try {
    const { plan } = req.body;

    // Validate plan
    if (!plan || !PLANS[plan]) {
      return res.status(400).send("Invalid plan. Choose silver or gold.");
    }

    const selectedPlan = PLANS[plan];
    const reference = `PN-${crypto.randomUUID()}`;

    const paymentRequest = paynow.createPayment(
      reference,
      req.user.email || "parent@payment.local"
    );

    paymentRequest.add(`${selectedPlan.name} Plan - Monthly`, selectedPlan.amount);

    const response = await paynow.send(paymentRequest);

    if (!response.success) {
      console.error("[paynow init] failed", response);
      return res.status(400).send("Failed to initiate payment");
    }

    await Payment.create({
      userId: req.user._id,
      reference,
      amount: selectedPlan.amount,
      plan,
      pollUrl: response.pollUrl,
      status: "pending"
    });

    return res.redirect(response.redirectUrl);

  } catch (err) {
    console.error("[paynow init] error:", err);
    return res.status(500).send("Payment error");
  }
});

/* ------------------------------
   PAYNOW RETURN (Browser redirect)
-------------------------------- */
router.get("/paynow/return", ensureAuth, async (req, res) => {
  return res.redirect("/parent/dashboard");
});

/* ------------------------------
   PAYNOW RESULT (Server callback)
-------------------------------- */
router.post("/paynow/result", async (req, res) => {
  try {
    console.log("[paynow result] CALLBACK RECEIVED", req.body);

    const { reference } = req.body;

    if (!reference) {
      console.error("[paynow result] missing reference", req.body);
      return res.sendStatus(200);
    }

    const payment = await Payment.findOne({ reference });
    if (!payment) {
      console.error("[paynow result] payment not found:", reference);
      return res.sendStatus(200);
    }

    const pollUrl = payment.pollUrl;

    // 🔎 Poll Paynow
    const status = await paynow.pollTransaction(pollUrl);
    console.log("[paynow poll] RESULT:", status);

    if (String(status.status).toLowerCase() === "paid") {

      // 1️⃣ Mark payment as paid
      payment.status = "paid";
      payment.paidAt = new Date();
      await payment.save();

      // 2️⃣ Determine plan from payment record
      const planKey = payment.plan || "silver"; // fallback for legacy
      const planConfig = PLANS[planKey] || PLANS.silver;

      // 3️⃣ Calculate expiry (30 days from now, or extend if already active)
      const now = new Date();
      const parent = await User.findById(payment.userId).lean();
      let expiresAt;

      if (
        parent.subscriptionExpiresAt &&
        new Date(parent.subscriptionExpiresAt) > now
      ) {
        // Extend from current expiry
        expiresAt = new Date(parent.subscriptionExpiresAt);
        expiresAt.setDate(expiresAt.getDate() + planConfig.durationDays);
      } else {
        // Start fresh
        expiresAt = new Date(now);
        expiresAt.setDate(expiresAt.getDate() + planConfig.durationDays);
      }

      // 4️⃣ Update parent with plan details
      const updatedParent = await User.findByIdAndUpdate(
        payment.userId,
        {
          subscriptionStatus: "paid",
          subscriptionPlan: planKey,
          maxChildren: planConfig.maxChildren,
          subscriptionExpiresAt: expiresAt,
          paidAt: now,
          consumerEnabled: true
        },
        { new: true }
      );

      // 5️⃣ Enable all existing children
      await User.updateMany(
        { parentUserId: updatedParent._id, role: "student" },
        { $set: { consumerEnabled: true } }
      );

      // 6️⃣ Load HOME org
      const org = await Organization.findOne({ slug: "cripfcnt-home" }).lean();
      if (!org) return res.sendStatus(200);

      // 7️⃣ Load children
      const children = await User.find({
        parentUserId: updatedParent._id,
        role: "student"
      });

      // 8️⃣ Assign paid quizzes to all children
      for (const child of children) {
        const rules = await QuizRule.find({
          org: org._id,
          grade: child.grade,
          quizType: "paid",
          enabled: true
        });

        for (const rule of rules) {
          await assignQuizFromRule({
            rule,
            userId: child._id,
            orgId: org._id,
            force: true
          });
        }
      }

      console.log(
        `[paynow] ${planConfig.name} plan activated for parent:`,
        updatedParent._id,
        `expires: ${expiresAt.toISOString()}`
      );
    }

    if (String(status.status).toLowerCase() === "failed") {
      payment.status = "failed";
      await payment.save();
    }

    return res.sendStatus(200);
  } catch (err) {
    console.error("[paynow result] error:", err);
    return res.sendStatus(200);
  }
});

export default router;
