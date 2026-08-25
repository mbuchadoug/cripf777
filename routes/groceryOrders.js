import { Router } from "express";
import crypto from "crypto";
import Stripe from "stripe";
import paynow from "../services/paynow.js";           // reuse your existing Paynow service
import GroceryOrder from "../models/groceryOrder.js";
import { priceOrder, CATALOGUE, ZONES } from "./groceryCatalogue.js";

const router = Router();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

/* ── Scoped CORS: allow ONLY the ZimQuote site to call these guest endpoints.
   Isolated to this router so it never affects your cookie/session flows. ── */
const ALLOWED = ["https://zimqoute.co.zw", "https://www.zimqoute.co.zw"];
router.use((req, res, next) => {
  const origin = req.headers.origin;
  if (ALLOWED.includes(origin)) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

/* ── Public catalogue (so the site and server share one price list) ──────── */
router.get("/catalogue", (_req, res) => {
  const items = Object.entries(CATALOGUE).map(([sku, [name, unit, price]]) => ({ sku, name, unit, price }));
  res.json({ items, zones: ZONES });
});

/* ── Create an order (guest, no auth). Server prices everything. ──────────── */
router.post("/order", async (req, res) => {
  try {
    const { customer = {}, recipient = {}, delivery = {}, items = [] } = req.body || {};

    if (!customer.name || !customer.phone) {
      return res.status(400).json({ error: "Please enter your name and phone number." });
    }
    if (!delivery.zone) {
      return res.status(400).json({ error: "Please choose a delivery zone." });
    }

    const priced = priceOrder(items, delivery.zone);
    if (priced.errors.length) {
      return res.status(400).json({ error: priced.errors[0], errors: priced.errors });
    }

    const reference = `GRO-${crypto.randomUUID()}`;
    const order = await GroceryOrder.create({
      reference,
      customer: {
        name: String(customer.name).slice(0, 80),
        phone: String(customer.phone).slice(0, 24),
        email: customer.email ? String(customer.email).slice(0, 120) : null,
        isDiaspora: !!customer.isDiaspora,
        country: (customer.country || "ZW").slice(0, 4)
      },
      recipient: {
        name: recipient.name ? String(recipient.name).slice(0, 80) : null,
        phone: recipient.phone ? String(recipient.phone).slice(0, 24) : null
      },
      delivery: {
        zone: delivery.zone,
        area: String(delivery.area || "").slice(0, 80),
        address: String(delivery.address || "").slice(0, 160),
        landmark: String(delivery.landmark || "").slice(0, 160),
        geo: { lat: delivery.lat ?? null, lng: delivery.lng ?? null },
        notes: String(delivery.notes || "").slice(0, 240)
      },
      items: priced.items,
      hasCustomItems: priced.hasCustomItems,
      amounts: priced.amounts,
      fulfilment: { status: priced.hasCustomItems ? "quote_pending" : "received", timeline: [
        { at: new Date(), event: "created", note: priced.hasCustomItems ? "Has custom items — needs quote" : "Order received" }
      ] }
    });

    return res.json({
      reference,
      amounts: priced.amounts,
      payableNow: priced.payableNow,
      hasCustomItems: priced.hasCustomItems,
      message: priced.hasCustomItems
        ? "We'll confirm the price of your custom items on WhatsApp, then send you a payment link."
        : "Order created. Choose how you'd like to pay."
    });
  } catch (err) {
    console.error("[grocery order]", err);
    return res.status(500).json({ error: "Could not create order. Please try again." });
  }
});

/* ── EcoCash (Paynow mobile) — local payers. Mirrors your payments.js flow ── */
router.post("/pay/ecocash", async (req, res) => {
  try {
    const { reference, phone } = req.body || {};
    const order = await GroceryOrder.findOne({ reference });
    if (!order) return res.status(404).json({ error: "Order not found." });
    if (order.hasCustomItems) return res.status(400).json({ error: "This order needs a price confirmation first." });
    if (order.payment.status === "paid") return res.json({ status: "paid" });

    const normalized = String(phone || "").replace(/\s|-/g, "").replace(/^\+263/, "0").replace(/^263/, "0");
    if (!/^07[7-8]\d{7}$/.test(normalized)) {
      return res.status(400).json({ error: "Enter a valid EcoCash number (e.g. 0771234567)." });
    }

    const payRef = `GRP-${crypto.randomUUID()}`;
    const pr = paynow.createPayment(payRef, order.customer.email || `${normalized}@ecocash.local`);
    pr.add(`ZimQuote groceries ${order.reference}`, order.amounts.total);

    const response = await paynow.sendMobile(pr, normalized, "ecocash");
    if (!response.success) {
      return res.status(400).json({ error: response.error || "Failed to send EcoCash prompt." });
    }

    order.payment.method = "ecocash";
    order.payment.status = "pending";
    order.payment.reference = payRef;
    order.payment.pollUrl = response.pollUrl;
    order.pushTimeline("payment_initiated", "EcoCash prompt sent to " + normalized);
    await order.save();

    return res.json({ status: "pending", reference: order.reference,
      message: `Check ${normalized} and approve the EcoCash prompt.` });
  } catch (err) {
    console.error("[grocery ecocash]", err);
    return res.status(500).json({ error: "Payment error. Please try again." });
  }
});

/* ── Poll EcoCash status (frontend polls by order reference) ─────────────── */
router.get("/poll/:reference", async (req, res) => {
  try {
    const order = await GroceryOrder.findOne({ reference: req.params.reference });
    if (!order) return res.status(404).json({ error: "Order not found." });
    if (order.payment.status === "paid") return res.json({ status: "paid" });
    if (["failed", "cancelled"].includes(order.payment.status)) return res.json({ status: order.payment.status });

    if (order.payment.pollUrl) {
      const result = await paynow.pollTransaction(order.payment.pollUrl);
      const s = String(result.status || "").toLowerCase();
      if (s === "paid") { await markPaid(order, "ecocash"); return res.json({ status: "paid" }); }
      if (s === "failed" || s === "cancelled") {
        order.payment.status = s; await order.save();
        return res.json({ status: s });
      }
    }
    return res.json({ status: "pending" });
  } catch (err) {
    console.error("[grocery poll]", err);
    return res.json({ status: "pending" });
  }
});

/* ── Paynow server callback ──────────────────────────────────────────────── */
router.post("/pay/ecocash/result", async (req, res) => {
  try {
    const order = await GroceryOrder.findOne({ "payment.reference": req.body.reference });
    if (!order) return res.sendStatus(200);
    const result = await paynow.pollTransaction(order.payment.pollUrl);
    const s = String(result.status || "").toLowerCase();
    if (s === "paid") await markPaid(order, "ecocash");
    else if (s === "failed" || s === "cancelled") { order.payment.status = s; await order.save(); }
    return res.sendStatus(200);
  } catch (err) { console.error("[grocery result]", err); return res.sendStatus(200); }
});

/* ── Stripe Checkout — diaspora / card payers ────────────────────────────── */
router.post("/pay/stripe", async (req, res) => {
  try {
    const { reference } = req.body || {};
    const order = await GroceryOrder.findOne({ reference });
    if (!order) return res.status(404).json({ error: "Order not found." });
    if (order.hasCustomItems) return res.status(400).json({ error: "This order needs a price confirmation first." });
    if (order.payment.status === "paid") return res.json({ url: null, status: "paid" });

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [{
        quantity: 1,
        price_data: {
          currency: "usd",
          product_data: { name: `ZimQuote grocery delivery ${order.reference}` },
          unit_amount: Math.round(order.amounts.total * 100)
        }
      }],
      metadata: { type: "grocery_order", reference: order.reference },
      success_url: "https://zimqoute.co.zw/grocery-delivery-harare/?paid=1&ref=" + order.reference,
      cancel_url: "https://zimqoute.co.zw/grocery-delivery-harare/?cancelled=1&ref=" + order.reference
    });

    order.payment.method = "stripe";
    order.payment.status = "pending";
    order.payment.gatewayId = session.id;
    order.pushTimeline("payment_initiated", "Stripe checkout opened");
    await order.save();

    return res.json({ url: session.url });
  } catch (err) {
    console.error("[grocery stripe]", err);
    return res.status(500).json({ error: "Could not start card payment. Please try again." });
  }
});

/* ── Shared: mark an order paid + advance fulfilment (idempotent) ─────────── */
export async function markPaid(order, method) {
  if (order.payment.status === "paid") return;
  order.payment.status = "paid";
  order.payment.method = method || order.payment.method;
  order.payment.paidAt = new Date();
  order.fulfilment.status = "paid";
  order.pushTimeline("paid", `Paid via ${method}`);
  await order.save();
  // TODO (optional): send WhatsApp confirmation to customer + recipient via your Meta sender.
  console.log(`[grocery] PAID ${order.reference} $${order.amounts.total} via ${method}`);
}

// Called by the Stripe webhook branch (see stripe_webhook grocery snippet).
export async function markPaidByReference(reference, method = "stripe") {
  const order = await GroceryOrder.findOne({ reference });
  if (order) await markPaid(order, method);
}

export default router;
