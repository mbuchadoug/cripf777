import express from "express";
import Stripe from "stripe";

const router = express.Router();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// IMPORTANT: Stripe needs raw body
router.post(
  "/webhook",
  express.raw({ type: "application/json" }),
  (req, res) => {
    const sig = req.headers["stripe-signature"];

    let event;
    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.error("Webhook signature verification failed.", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    // ✅ Handle events
    switch (event.type) {
      case "checkout.session.completed":
        console.log("Payment completed:", event.data.object.id);
        // TODO: add auditCredits or activate LMS
        break;

      case "invoice.payment_succeeded":
        console.log("Subscription payment succeeded");
        break;
    }

    res.json({ received: true });
  }
);

export default router;
