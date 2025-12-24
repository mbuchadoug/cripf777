import { Router } from "express";
import fetch from "node-fetch";
import { ensureAuth } from "../middleware/authGuard.js";
import User from "../models/user.js";
import PlacementAudit from "../models/placementAudit.js";
import Stripe from "stripe";
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const router = Router();



// BUY A SPECIFIC SCOI AUDIT REPORT
router.post(
  "/create-audit-checkout/:auditId",
  ensureAuth,
  async (req, res) => {
    const audit = await PlacementAudit.findById(req.params.auditId).lean();
    if (!audit) {
      return res.status(404).json({ error: "Audit not found" });
    }

    // price logic (can evolve later)
    const PRICE_CENTS = 4900; // $49.00 per audit

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      customer_email: req.user.email,

      line_items: [
        {
          price_data: {
            currency: "usd",
            product_data: {
              name: `CRIPFCnt SCOI Audit — ${audit.subject.name}`,
              description: `${audit.assessmentWindow.label} · Placement Audit`
            },
            unit_amount: PRICE_CENTS
          },
          quantity: 1
        }
      ],

      metadata: {
        type: "scoi_audit_report",
        userId: req.user._id.toString(),
        auditId: audit._id.toString(),
        price: PRICE_CENTS
      },

      success_url: `https://cripfcnt.com/scoi/audits/${audit._id}?paid=1`,
      cancel_url: `https://cripfcnt.com/scoi`
    });

    res.json({ url: session.url });
  }
);


router.get("/", ensureAuth, (req, res) => {
  res.render("billing", { user: req.user });
});

router.post("/create-order", ensureAuth, async (req, res) => {
  const { plan } = req.body;

  const plans = {
    starter: { price: "5.00", credits: 20 },
    pro: { price: "15.00", credits: 100 }
  };

  const selected = plans[plan];
  if (!selected) return res.status(400).json({ error: "Invalid plan" });

  // call PayPal Orders API (simplified)
  // return orderID to frontend
});

router.post("/capture-order", ensureAuth, async (req, res) => {
  const { orderID, plan } = req.body;

  // verify with PayPal
  // if success:
  await User.findByIdAndUpdate(req.user._id, {
    $inc: { auditCredits: plans[plan].credits },
    $set: { paidAt: new Date() }
  });

  res.json({ success: true });
});





router.post("/create-checkout-session", ensureAuth, async (req, res) => {
  const { plan } = req.body;

  const plans = {
    starter: { price: 500, credits: 20 }, // cents
    pro: { price: 1500, credits: 100 }
  };

  const selected = plans[plan];
  if (!selected) return res.status(400).json({ error: "Invalid plan" });

  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    payment_method_types: ["card"],
    customer_email: req.user.email,
    line_items: [
      {
        price_data: {
          currency: "usd",
          product_data: {
            name: `CRIPFCnt ${plan} credits`,
          },
          unit_amount: selected.price,
        },
        quantity: 1,
      },
    ],
    metadata: {
      userId: req.user._id.toString(),
      credits: selected.credits,
    },
    success_url: "https://cripfcnt.com/audit?paid=1",
    cancel_url: "https://cripfcnt.com/billing",
  });

  res.json({ url: session.url });
});


export default router;
