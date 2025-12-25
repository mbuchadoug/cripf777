import { Router } from "express";
import Stripe from "stripe";
import { ensureAuth } from "../middleware/authGuard.js";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const router = Router();

router.post("/scoi/checkout", ensureAuth, async (req, res) => {
  const { auditId, type } = req.body;

  const pricing = {
    archived: 14900, // $149
    active: 29900   // $299
  };

  if (!pricing[type]) {
    return res.status(400).send("Invalid audit type");
  }

  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    payment_method_types: ["card"],
    customer_email: req.user.email,
    line_items: [
      {
        price_data: {
          currency: "usd",
          product_data: {
            name: `CRIPFCnt ${type} SCOI Audit Report`
          },
          unit_amount: pricing[type]
        },
        quantity: 1
      }
    ],
    metadata: {
      type: "scoi_audit_report",
      auditId,
      userId: req.user._id.toString()
    },
    success_url: `${process.env.SITE_URL}/scoi/purchased`,
    cancel_url: `${process.env.SITE_URL}/scoi`
  });

  // ✅ IMPORTANT FIX
  res.redirect(session.url);
});

export default router;
