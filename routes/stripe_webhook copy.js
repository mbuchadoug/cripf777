import express from "express";
import Stripe from "stripe";
import dotenv from "dotenv";
import User from "../models/user.js";
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
      req.body,   // ✅ RAW BUFFER
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

    const userId = session.metadata?.userId;
    const credits = Number(session.metadata?.credits || 0);

    if (userId && credits > 0) {
      await User.findByIdAndUpdate(userId, {
        $inc: { auditCredits: credits },
        $set: { paidAt: new Date() }
      });

      console.log(`✅ Added ${credits} credits to user ${userId}`);
    }
  }

  res.json({ received: true });
});

export default router;
