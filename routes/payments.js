import { Router } from "express";
import crypto from "crypto";
import paynow from "../services/paynow.js";
import Payment from "../models/payment.js";
import { ensureAuth } from "../middleware/authGuard.js";

const router = Router();

/* ------------------------------
   INITIATE PAYMENT
-------------------------------- */
router.post("/paynow/init", ensureAuth, async (req, res) => {
  const { amount, childId } = req.body;

  const reference = `PN-${crypto.randomUUID()}`;

  const payment = paynow.createPayment(reference, req.user.email);
  payment.add("Parent Payment", amount);

  const response = await paynow.send(payment);

  if (!response.success) {
    return res.status(400).send("Failed to initiate payment");
  }

  await Payment.create({
    userId: req.user._id,
    childId,
    reference,
    amount,
    pollUrl: response.pollUrl
  });

  // Redirect parent to Paynow
  return res.redirect(response.redirectUrl);
});

/* ------------------------------
   PAYNOW RETURN (Browser)
-------------------------------- */
router.get("/paynow/return", ensureAuth, async (req, res) => {
  res.render("payments/processing", {
    message: "Processing payment, please wait..."
  });
});

/* ------------------------------
   PAYNOW RESULT (Server-to-server)
-------------------------------- */
router.post("/paynow/result", async (req, res) => {
  const { reference, pollurl } = req.body;

  const payment = await Payment.findOne({ reference });
  if (!payment) return res.sendStatus(200);

  const status = await paynow.pollTransaction(pollurl);

  if (status.paid) {
    payment.status = "paid";
    await payment.save();

    // ✅ ACTIVATE ACCESS HERE
    // e.g unlock quizzes, subscription, etc
  } else if (status.status === "failed") {
    payment.status = "failed";
    await payment.save();
  }

  res.sendStatus(200);
});

export default router;
