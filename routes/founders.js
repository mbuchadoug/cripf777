// routes/founders.js
// ─────────────────────────────────────────────────────────────────────────────
// CRIPFCnt SCOI - FOUNDERS 100 / Institutional Research Access Membership
//
// Fully additive. Nothing here changes existing SCOI, subscription or payment
// flows. Access to selected reports reuses the EXISTING AuditPurchase model, so
// the member's view/download works through the existing canAccessAudit() gate
// with no change to admin_scoi_reports.js.
//
// Routes (all mounted at root via app.use(foundersRoutes)):
//   GET  /founders                 public sales page (+ live "N of 100 remaining")
//   GET  /founders/checkout        Stripe checkout for the $5,000 first year
//   GET  /founders/welcome         post-payment landing (webhook fallback)
//   GET  /founders/portal          member dashboard
//   POST /founders/institution     save institution + up to 5 named users
//   GET  /founders/select          choose reports from the library
//   POST /founders/select          commit selections (grants access)
//   GET  /founders/renew           Stripe checkout for the $250 annual renewal
//   GET  /founders/renew/success   post-renewal landing (webhook fallback)
//
// Exported helpers activateFoundersMembership() / renewFoundersMembership() are
// called by the Stripe webhook (routes/stripe_webhook.js).
// ─────────────────────────────────────────────────────────────────────────────
import { Router } from "express";
import Stripe from "stripe";
import { ensureAuth } from "../middleware/authGuard.js";
import FoundersMembership from "../models/foundersMembership.js";
import SpecialScoiAudit from "../models/specialScoiAudit.js";
import PlacementAudit from "../models/placementAudit.js";
import AuditPurchase from "../models/auditPurchase.js";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const router = Router();

const MAX_MEMBERSHIPS = 100;
const SEAT_LIMIT      = 5;
const FIRST_YEAR_CENTS = 500000; // $5,000
const RENEWAL_CENTS    = 25000;  // $250
const SITE_URL = () => (process.env.SITE_URL || "").replace(/\/$/, "");

function makeRef(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`.toUpperCase();
}

async function activeCount() {
  return FoundersMembership.countDocuments({ status: "active" });
}

async function getMembership(userId) {
  return FoundersMembership.findOne({
    userId,
    status: { $in: ["pending", "active"] }
  }).sort({ createdAt: -1 });
}

// ─────────────────────────────────────────────────────────────────────────────
// Activation / renewal - idempotent, safe to call from webhook AND success page.
// ─────────────────────────────────────────────────────────────────────────────
export async function activateFoundersMembership(userId, session = {}) {
  const sessionId = session.id || null;

  // Idempotency: already activated for this checkout session?
  if (sessionId) {
    const done = await FoundersMembership.findOne({ stripeSessionId: sessionId, status: "active" });
    if (done) return done;
  }

  // Cap enforcement.
  const count = await activeCount();
  if (count >= MAX_MEMBERSHIPS) {
    console.warn("[founders] activation blocked - 100 memberships already issued.");
    return null;
  }

  // Reuse a pending membership for this user if present, else create.
  let m = await FoundersMembership.findOne({ userId, status: "pending" }).sort({ createdAt: -1 });
  if (!m) m = new FoundersMembership({ userId });

  const now = new Date();
  const oneYear = new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000);

  m.status               = "active";
  m.membershipNumber     = m.membershipNumber || (count + 1);
  m.reportQuota          = m.reportQuota || 100;
  m.firstYearAmount      = FIRST_YEAR_CENTS;
  m.renewalAmount        = RENEWAL_CENTS;
  m.totalPaid            = (m.totalPaid || 0) + FIRST_YEAR_CENTS;
  m.purchasedAt          = m.purchasedAt || now;
  m.yearOneExpiresAt     = oneYear;
  m.currentTermExpiresAt = oneYear;
  m.stripeSessionId      = sessionId || m.stripeSessionId;
  m.stripePaymentIntent  = session.payment_intent || m.stripePaymentIntent;
  m.customerEmail        = session.customer_email || m.customerEmail;

  await m.save();
  console.log(`[founders] ✅ Activated membership #${m.membershipNumber} for user ${userId}`);
  return m;
}

export async function renewFoundersMembership(userId, session = {}) {
  const sessionId = session.id || null;
  const m = await FoundersMembership.findOne({ userId, status: "active" }).sort({ createdAt: -1 });
  if (!m) {
    console.warn("[founders] renewal received but no active membership for", userId);
    return null;
  }
  // Idempotency: don't double-apply the same renewal session.
  if (sessionId && m.stripeSessionId === sessionId && m.renewalsCount > 0) return m;

  const base = (m.currentTermExpiresAt && m.currentTermExpiresAt > new Date())
    ? m.currentTermExpiresAt
    : new Date();
  m.currentTermExpiresAt = new Date(base.getTime() + 365 * 24 * 60 * 60 * 1000);
  m.reportQuota    = (m.reportQuota || 100) + 5;   // +5 entitlements per year
  m.renewalsCount  = (m.renewalsCount || 0) + 1;
  m.lastRenewalAt  = new Date();
  m.totalPaid      = (m.totalPaid || 0) + RENEWAL_CENTS;
  m.stripeSessionId = sessionId || m.stripeSessionId;

  await m.save();
  console.log(`[founders] ✅ Renewed membership #${m.membershipNumber} (quota now ${m.reportQuota})`);
  return m;
}

// ─────────────────────────────────────────────────────────────────────────────
// Grant access to a report by creating an AuditPurchase (idempotent).
// This is what makes the existing canAccessAudit() gate let the member in.
// ─────────────────────────────────────────────────────────────────────────────
async function grantAccess(userId, auditId, auditModel, membershipId) {
  const synthetic = `founders:${membershipId}:${auditId}`;
  const exists = await AuditPurchase.findOne({ userId, auditId }).lean();
  if (exists) return false;
  await AuditPurchase.create({
    userId,
    auditId,
    auditModel,
    pricePaid: 0,
    stripeSessionId: synthetic,
    status: "completed",
    source: "founders_membership"
  });
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /founders - public sales page
// ─────────────────────────────────────────────────────────────────────────────
router.get("/founders", async (req, res) => {
  try {
    const issued = await activeCount();
    const remaining = Math.max(0, MAX_MEMBERSHIPS - issued);
    const libraryCount = await SpecialScoiAudit.countDocuments({}).catch(() => 0);
    const existing = req.user ? await getMembership(req.user._id) : null;
    const membership = existing && existing.status === "active" ? existing : null;

    res.render("founders/landing", {
      layout: false,
      user: req.user || null,
      siteUrl: SITE_URL(),
      issued,
      remaining,
      soldOut: remaining <= 0,
      libraryCount: libraryCount || 283,
      firstYear: "5,000",
      renewal: "250",
      perReport: "50",
      membership: membership ? membership.toObject() : null
    });
  } catch (err) {
    console.error("[founders landing]", err);
    res.status(500).send("Unable to load the Founders 100 page.");
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /founders/checkout - $5,000 first-year membership (id-in-URL survives login)
// ─────────────────────────────────────────────────────────────────────────────
router.get("/founders/checkout", ensureAuth, async (req, res) => {
  try {
    // Already a member? Go to the portal.
    const existing = await getMembership(req.user._id);
    if (existing && existing.status === "active") return res.redirect("/founders/portal");

    if ((await activeCount()) >= MAX_MEMBERSHIPS) {
      return res.render("founders/landing", {
        layout: false, user: req.user, siteUrl: SITE_URL(),
        issued: MAX_MEMBERSHIPS, remaining: 0, soldOut: true,
        libraryCount: 283, firstYear: "5,000", renewal: "250", perReport: "50"
      });
    }

    const reference = makeRef("FND");
    // Create/refresh a pending membership so we can attach the reference.
    await FoundersMembership.findOneAndUpdate(
      { userId: req.user._id, status: "pending" },
      { $set: { userId: req.user._id, status: "pending", reference } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      customer_email: req.user.email,
      line_items: [{
        price_data: {
          currency: "usd",
          product_data: {
            name: "CRIPFCnt SCOI - Founders 100 Membership (First Year)",
            description: "Institutional Research Access: 100 SCOI report selections, 5 named users, longitudinal revisions. Lifetime, transferable founding right."
          },
          unit_amount: FIRST_YEAR_CENTS
        },
        quantity: 1
      }],
      metadata: {
        type: "founders_membership",
        userId: req.user._id.toString(),
        reference
      },
      success_url: `${SITE_URL()}/founders/welcome?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${SITE_URL()}/founders`
    });

    return res.redirect(session.url);
  } catch (err) {
    console.error("[founders checkout]", err);
    return res.status(500).send("Checkout failed. Please try again.");
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /founders/welcome - webhook fallback activation, then portal
// ─────────────────────────────────────────────────────────────────────────────
router.get("/founders/welcome", ensureAuth, async (req, res) => {
  const { session_id } = req.query;
  try {
    if (session_id) {
      const session = await stripe.checkout.sessions.retrieve(session_id);
      if (session.payment_status === "paid" && session.metadata?.type === "founders_membership") {
        await activateFoundersMembership(req.user._id, session);
      }
    }
  } catch (err) {
    console.error("[founders welcome]", err.message);
  }
  return res.redirect("/founders/portal");
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /founders/portal - member dashboard
// ─────────────────────────────────────────────────────────────────────────────
router.get("/founders/portal", ensureAuth, async (req, res) => {
  try {
    const m = await getMembership(req.user._id);
    if (!m || m.status !== "active") return res.redirect("/founders");

    res.render("founders/portal", {
      layout: false,
      user: req.user,
      siteUrl: SITE_URL(),
      m: m.toObject(),
      remaining: m.remainingSelections(),
      seatLimit: SEAT_LIMIT,
      termEnds: m.currentTermExpiresAt
    });
  } catch (err) {
    console.error("[founders portal]", err);
    res.status(500).send("Unable to load your membership portal.");
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /founders/institution - save institution name + up to 5 named users
// ─────────────────────────────────────────────────────────────────────────────
router.post("/founders/institution", ensureAuth, async (req, res) => {
  try {
    const m = await getMembership(req.user._id);
    if (!m || m.status !== "active") return res.redirect("/founders");

    const names  = [].concat(req.body.seatName  || []);
    const emails = [].concat(req.body.seatEmail || []);
    const seats = [];
    for (let i = 0; i < Math.min(SEAT_LIMIT, Math.max(names.length, emails.length)); i++) {
      const name = (names[i] || "").trim();
      const email = (emails[i] || "").trim().toLowerCase();
      if (name || email) seats.push({ name, email });
    }

    m.institution = {
      name:         (req.body.institutionName || "").trim(),
      contactName:  (req.body.contactName || "").trim(),
      contactEmail: (req.body.contactEmail || "").trim().toLowerCase()
    };
    m.seats = seats.slice(0, SEAT_LIMIT);
    await m.save();
    return res.redirect("/founders/portal");
  } catch (err) {
    console.error("[founders institution]", err);
    res.status(500).send("Could not save institution details.");
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /founders/select - choose reports from the library
// ─────────────────────────────────────────────────────────────────────────────
router.get("/founders/select", ensureAuth, async (req, res) => {
  try {
    const m = await getMembership(req.user._id);
    if (!m || m.status !== "active") return res.redirect("/founders");

    const chosenIds = new Set((m.reportsSelected || []).map(r => String(r.auditId)));

    const [special, placement] = await Promise.all([
      SpecialScoiAudit.find({}).select("title subject reportCode assessmentWindow price createdAt").sort({ createdAt: -1 }).lean(),
      PlacementAudit.find({}).select("subject reportCode assessmentWindow price").lean().catch(() => [])
    ]);

    const toCard = (a, model) => ({
      id: String(a._id),
      model,
      title: a.title || a.subject?.name || "Untitled report",
      subject: a.subject?.name || "",
      code: a.reportCode || "",
      window: a.assessmentWindow?.label || "",
      chosen: chosenIds.has(String(a._id))
    });

    const reports = [
      ...special.map(a => toCard(a, "SpecialScoiAudit")),
      ...placement.map(a => toCard(a, "PlacementAudit"))
    ];

    res.render("founders/select", {
      layout: false,
      user: req.user,
      siteUrl: SITE_URL(),
      reports,
      remaining: m.remainingSelections(),
      quota: m.reportQuota,
      chosenCount: chosenIds.size
    });
  } catch (err) {
    console.error("[founders select GET]", err);
    res.status(500).send("Unable to load the report library.");
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /founders/select - commit selections (grants access via AuditPurchase)
// ─────────────────────────────────────────────────────────────────────────────
router.post("/founders/select", ensureAuth, async (req, res) => {
  try {
    const m = await getMembership(req.user._id);
    if (!m || m.status !== "active") return res.redirect("/founders");

    // Checkbox values come as "SpecialScoiAudit:<id>" (or PlacementAudit:<id>).
    let picks = [].concat(req.body.pick || []).filter(Boolean);
    const already = new Set((m.reportsSelected || []).map(r => String(r.auditId)));

    let remaining = m.remainingSelections();
    let added = 0;

    for (const raw of picks) {
      if (remaining <= 0) break;
      const [model, id] = String(raw).split(":");
      if (!id || already.has(id)) continue;

      const Model = model === "PlacementAudit" ? PlacementAudit : SpecialScoiAudit;
      const doc = await Model.findById(id).select("title subject").lean();
      if (!doc) continue;

      m.reportsSelected.push({
        auditId: id,
        auditModel: model === "PlacementAudit" ? "PlacementAudit" : "SpecialScoiAudit",
        title: doc.title || doc.subject?.name || "Report",
        selectedAt: new Date()
      });
      await grantAccess(req.user._id, id, model === "PlacementAudit" ? "PlacementAudit" : "SpecialScoiAudit", m._id);
      already.add(id);
      remaining--;
      added++;
    }

    await m.save();
    console.log(`[founders] member #${m.membershipNumber} added ${added} report(s); ${remaining} left`);
    return res.redirect("/founders/portal");
  } catch (err) {
    console.error("[founders select POST]", err);
    res.status(500).send("Could not save your selections.");
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /founders/renew - $250 annual renewal
// ─────────────────────────────────────────────────────────────────────────────
router.get("/founders/renew", ensureAuth, async (req, res) => {
  try {
    const m = await getMembership(req.user._id);
    if (!m || m.status !== "active") return res.redirect("/founders");

    const reference = makeRef("FNDREN");
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      customer_email: req.user.email,
      line_items: [{
        price_data: {
          currency: "usd",
          product_data: {
            name: "CRIPFCnt SCOI - Founders 100 Annual Renewal",
            description: "Retains access to selected reports, adds 5 new SCOI entitlements, continues longitudinal revision access."
          },
          unit_amount: RENEWAL_CENTS
        },
        quantity: 1
      }],
      metadata: {
        type: "founders_renewal",
        userId: req.user._id.toString(),
        reference
      },
      success_url: `${SITE_URL()}/founders/renew/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${SITE_URL()}/founders/portal`
    });
    return res.redirect(session.url);
  } catch (err) {
    console.error("[founders renew]", err);
    res.status(500).send("Renewal checkout failed. Please try again.");
  }
});

router.get("/founders/renew/success", ensureAuth, async (req, res) => {
  const { session_id } = req.query;
  try {
    if (session_id) {
      const session = await stripe.checkout.sessions.retrieve(session_id);
      if (session.payment_status === "paid" && session.metadata?.type === "founders_renewal") {
        await renewFoundersMembership(req.user._id, session);
      }
    }
  } catch (err) {
    console.error("[founders renew success]", err.message);
  }
  return res.redirect("/founders/portal");
});

export default router;
