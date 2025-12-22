import { Router } from "express";
import fetch from "node-fetch";
import { ensureAuth } from "../middleware/authGuard.js";
import User from "../models/user.js";

const router = Router();

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

export default router;
