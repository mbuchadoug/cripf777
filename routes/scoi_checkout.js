import { Router } from "express";
import Stripe from "stripe";
import { ensureAuth } from "../middleware/authGuard.js";
import PlacementAudit from "../models/placementAudit.js";
import SpecialScoiAudit from "../models/specialScoiAudit.js";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const router = Router();

router.post("/scoi/checkout", ensureAuth, async (req, res) => {
  const { auditId, auditModel } = req.body;

  let audit;
  let price;

  if (auditModel === "PlacementAudit") {
    audit = await PlacementAudit.findById(auditId);
    price = 14900;
  }

  if (auditModel === "SpecialScoiAudit") {
    audit = await SpecialScoiAudit.findById(auditId);
    price = 29900;
  }

  if (!audit) return res.status(404).send("Audit not found");

  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    customer_email: req.user.email,
    line_items: [{
      price_data: {
        currency: "usd",
        product_data: {
          name: `CRIPFCnt SCOI Audit`
        },
        unit_amount: price
      },
      quantity: 1
    }],
    metadata: {
      auditId,
      auditModel,
      userId: req.user._id.toString()
    },
    success_url: `${process.env.SITE_URL}/scoi/purchased`,
    cancel_url: `${process.env.SITE_URL}/scoi`
  });

  res.redirect(session.url);
});

export default router;
