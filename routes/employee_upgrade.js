// routes/employee_upgrade.js
import { Router } from "express";
import Stripe from "stripe";
import { ensureAuth } from "../middleware/authGuard.js";
import Organization from "../models/organization.js";
import OrgMembership from "../models/orgMembership.js";
import User from "../models/user.js";
import { getEmployeeTrialStatus } from "../services/employeeTrialAssignment.js";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const router = Router();

/**
 * GET /employee/upgrade
 * Show upgrade page with pricing
 */
router.get("/employee/upgrade", ensureAuth, async (req, res) => {
  try {
    // Check if user is cripfcnt-school employee
    const membership = await OrgMembership.findOne({
      user: req.user._id
    }).populate('org').lean();

    if (!membership || membership.org.slug !== 'cripfcnt-school') {
      return res.status(403).send("Only cripfcnt-school employees can upgrade");
    }

    // Check if already paid
    if (req.user.employeeSubscriptionStatus === 'paid') {
      return res.redirect('/org/cripfcnt-school/dashboard');
    }

    // Get trial status
    const trialStatus = await getEmployeeTrialStatus(
      req.user._id,
      membership.org._id
    );

    return res.render("employee/upgrade", {
      user: req.user,
      org: membership.org,
      trialStatus,
      canUpgrade: trialStatus.canUpgrade,
      price: 1, // $99 one-time payment
      priceFormatted: "$1.00"
    });

  } catch (err) {
    console.error("[employee upgrade page] error:", err);
    return res.status(500).send("Failed to load upgrade page");
  }
});

/**
 * POST /employee/upgrade/checkout
 * Create Stripe checkout session
 */
router.post("/employee/upgrade/checkout", ensureAuth, async (req, res) => {
  try {
    const membership = await OrgMembership.findOne({
      user: req.user._id
    }).populate('org').lean();

    if (!membership || membership.org.slug !== 'cripfcnt-school') {
      return res.status(403).send("Only cripfcnt-school employees can upgrade");
    }

    // Check if already paid
    if (req.user.employeeSubscriptionStatus === 'paid') {
      return res.redirect('/org/cripfcnt-school/dashboard');
    }

    // Check trial completion
    const trialStatus = await getEmployeeTrialStatus(
      req.user._id,
      membership.org._id
    );

    if (!trialStatus.canUpgrade) {
      return res.status(400).send(
        `Please complete all ${trialStatus.total} trial quizzes before upgrading. ` +
        `You have completed ${trialStatus.completed}/${trialStatus.total}.`
      );
    }

    // Create Stripe checkout session
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      customer_email: req.user.email,
      line_items: [
        {
          price_data: {
            currency: "usd",
            product_data: {
              name: "CRIPFCnt School - Full Access",
              description: "Unlock all 6,681 quizzes - lifetime access"
            },
            unit_amount: 10 // $99.00
          },
          quantity: 1
        }
      ],
      metadata: {
        userId: req.user._id.toString(),
        upgradeType: "employee_full_access",
        orgSlug: "cripfcnt-school"
      },
      success_url: `${process.env.SITE_URL}/employee/upgrade/success`,
      cancel_url: `${process.env.SITE_URL}/employee/upgrade`
    });

    return res.redirect(session.url);

  } catch (err) {
    console.error("[employee checkout] error:", err);
    return res.status(500).send("Checkout failed");
  }
});

/**
 * GET /employee/upgrade/success
 * Payment success page
 */
router.get("/employee/upgrade/success", ensureAuth, async (req, res) => {
  return res.render("employee/upgrade_success", {
    user: req.user
  });
});

export default router;