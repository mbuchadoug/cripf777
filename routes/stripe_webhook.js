import express from "express";
import Stripe from "stripe";

const router = express.Router();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

router.post("/", (req, res) => {
  const sig = req.headers["stripe-signature"];
  const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

  let event;

  try {
    event = stripe.webhooks.constructEvent(
      req.body,          // ✅ RAW BUFFER
      sig,
      endpointSecret
    );
  } catch (err) {
    console.error("Webhook signature verification failed:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // ✅ VERIFIED EVENT
  if (event.type === "checkout.session.completed") {
    const session = event.data.object;

    console.log("✅ Checkout completed:", session.id);
    // TODO: credit user here
  }

  res.json({ received: true });
});

export default router;
