// routes/scoi_checkout.js
import { Router } from "express";
import Stripe from "stripe";
import { ensureAuth } from "../middleware/authGuard.js";
import PlacementAudit from "../models/placementAudit.js";
import SpecialScoiAudit from "../models/specialScoiAudit.js";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const router = Router();

router.post("/scoi/checkout", ensureAuth, async (req, res) => {
  const { auditId } = req.body;

  let audit;
  let price;
  let label;

  /* ───────────────────────────────
     Try Placement first
  ─────────────────────────────── */
  audit = await PlacementAudit.findById(auditId);
  if (audit) {
    price = 14900;
    label = "Archived Placement SCOI Audit";
  }

  /* ───────────────────────────────
     Try Special SCOI
  ─────────────────────────────── */
  if (!audit) {
    audit = await SpecialScoiAudit.findById(auditId);
    if (audit) {
      price = 29900;
      label = "Special SCOI Audit Report";
    }
  }

  if (!audit) {
    return res.status(404).send("Audit not found");
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
            name: label
          },
          unit_amount: price
        },
        quantity: 1
      }
    ],
    metadata: {
      auditId: audit._id.toString(),
      auditType: audit.auditClass || "placement",
      userId: req.user._id.toString()
    },
    success_url: `${process.env.SITE_URL}/scoi/purchased`,
    cancel_url: `${process.env.SITE_URL}/scoi`
  });

  res.redirect(session.url);
});

export default router;
