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

/* ------------------------------
   INITIATE PAYMENT
-------------------------------- */
router.post("/paynow/init", ensureAuth, async (req, res) => {
  try {
    const { amount } = req.body;

    if (!amount || Number(amount) <= 0) {
      return res.status(400).send("Invalid amount");
    }

    const reference = `PN-${crypto.randomUUID()}`;

    const paymentRequest = paynow.createPayment(
      reference,
      req.user.email || "parent@payment.local"
    );

    paymentRequest.add("Parent Subscription", Number(amount));

    const response = await paynow.send(paymentRequest);

    if (!response.success) {
      console.error("[paynow init] failed", response);
      return res.status(400).send("Failed to initiate payment");
    }

    await Payment.create({
      userId: req.user._id,
      reference,
      amount: Number(amount),
      pollUrl: response.pollUrl,
      status: "pending"
    });

    // 🔁 Redirect to Paynow (EcoCash / OneMoney)
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
  return res.render("payments/processing", {
    message: "Processing payment, please wait..."
  });
});

/* ------------------------------
   PAYNOW RESULT (Server callback)
-------------------------------- */
router.post("/paynow/result", async (req, res) => {
  try {
    const { reference, pollurl } = req.body;

    if (!reference || !pollurl) {
      return res.sendStatus(200);
    }

    const payment = await Payment.findOne({ reference });
    if (!payment) {
      return res.sendStatus(200);
    }

    // 🔎 Poll Paynow
    const status = await paynow.pollTransaction(pollurl);

    if (status.paid === true) {
  // 1️⃣ Mark payment
  payment.status = "paid";
  payment.paidAt = new Date();
  await payment.save();

  // 2️⃣ Mark parent paid
  const parent = await User.findByIdAndUpdate(
    payment.userId,
    {
      subscriptionStatus: "paid",
      paidAt: new Date(),
      consumerEnabled: true
    },
    { new: true }
  );

  // 3️⃣ Load HOME org
  const org = await Organization.findOne({ slug: "cripfcnt-home" }).lean();
  if (!org) return res.sendStatus(200);

  // 4️⃣ Load children
  const children = await User.find({
    parentUserId: parent._id,
    role: "student"
  });

  // 5️⃣ Load PAID rules
  const paidRules = await QuizRule.find({
    org: org._id,
    quizType: "paid",
    enabled: true
  });

  // 6️⃣ Assign quizzes
  for (const child of children) {
    for (const rule of paidRules) {
      if (rule.grade === child.grade) {
        await assignQuizFromRule({
          rule,
          userId: child._id,
          orgId: org._id
        });
      }
    }
  }

  console.log("[paynow] paid quizzes assigned for parent:", parent._id);
}


    if (status.status === "failed") {
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
