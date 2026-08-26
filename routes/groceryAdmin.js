import { Router } from "express";
import GroceryOrder from "../models/groceryOrder.js";
import { ZONES } from "./groceryCatalogue.js";

const router = Router();

/* ── Admin auth: header key. Set GROCERY_ADMIN_KEY in your env.
   (You can additionally mount this behind your existing /zq-admin guard.) ── */
function adminGuard(req, res, next) {
  const key = req.headers["x-admin-key"] || req.query.key;
  if (!process.env.GROCERY_ADMIN_KEY || key !== process.env.GROCERY_ADMIN_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  // CORS: proxy already sends Access-Control-Allow-Origin: * - do NOT set it again.
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,X-Admin-Key");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  next();
}
router.options("/grocery/*", (req, res) => {
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,X-Admin-Key");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.sendStatus(204);
});
router.use("/grocery", adminGuard);

/* ── List orders (optionally by fulfilment/payment status) ───────────────── */
router.get("/grocery/orders", async (req, res) => {
  const q = {};
  if (req.query.fulfil) q["fulfilment.status"] = req.query.fulfil;
  if (req.query.pay) q["payment.status"] = req.query.pay;
  const orders = await GroceryOrder.find(q).sort({ createdAt: -1 }).limit(300).lean();
  res.json({ orders });
});

/* ── Quote custom items → recompute total → make payable ─────────────────── */
router.post("/grocery/orders/:ref/quote", async (req, res) => {
  const order = await GroceryOrder.findOne({ reference: req.params.ref });
  if (!order) return res.status(404).json({ error: "Not found" });

  // body: { prices: { <itemIndex>: unitPrice } }
  const prices = req.body.prices || {};
  let goods = 0;
  order.items = order.items.map((it, i) => {
    if (it.custom && prices[i] != null) {
      it.unitPrice = Number(prices[i]);
      it.lineTotal = Math.round(it.unitPrice * it.qty * 100) / 100;
      it.custom = false;
    }
    goods += it.lineTotal || 0;
    return it;
  });
  const stillCustom = order.items.some(it => it.custom);
  order.hasCustomItems = stillCustom;

  goods = Math.round(goods * 100) / 100;
  const serviceFee = Math.max(2, Math.round(goods * 0.05 * 100) / 100);
  const deliveryFee = ZONES[order.delivery.zone]?.fee || 0;
  order.amounts.goods = goods;
  order.amounts.serviceFee = serviceFee;
  order.amounts.deliveryFee = deliveryFee;
  order.amounts.total = Math.round((goods + serviceFee + deliveryFee) * 100) / 100;

  order.fulfilment.status = stillCustom ? "quote_pending" : "awaiting_payment";
  order.pushTimeline("quoted", `Custom items priced. Total $${order.amounts.total}`);
  await order.save();
  res.json({ order });
  // NOTE: after this, send the customer a WhatsApp payment link (your Meta sender).
});

/* ── Update fulfilment status / rider / proof of delivery ────────────────── */
router.post("/grocery/orders/:ref/status", async (req, res) => {
  const { status, rider, proofUrl, note } = req.body || {};
  const allowed = ["received","quote_pending","awaiting_payment","paid",
                   "shopping","out_for_delivery","delivered","cancelled"];
  const order = await GroceryOrder.findOne({ reference: req.params.ref });
  if (!order) return res.status(404).json({ error: "Not found" });
  if (status && allowed.includes(status)) order.fulfilment.status = status;
  if (rider != null) order.fulfilment.rider = rider;
  if (proofUrl != null) order.fulfilment.proofUrl = proofUrl;
  order.pushTimeline(status || "update", note || "");
  await order.save();
  res.json({ order });
});

/* ── Reconciliation summary (paid vs pending, revenue, margins by day) ───── */
router.get("/grocery/reconcile", async (req, res) => {
  const since = new Date(Date.now() - (parseInt(req.query.days, 10) || 30) * 864e5);
  const orders = await GroceryOrder.find({ createdAt: { $gte: since } }).lean();
  let paid = 0, pending = 0, revenue = 0, deliveries = 0, service = 0, goods = 0;
  const byDay = {};
  for (const o of orders) {
    const day = new Date(o.createdAt).toISOString().slice(0, 10);
    byDay[day] = byDay[day] || { day, orders: 0, revenue: 0 };
    byDay[day].orders++;
    if (o.payment.status === "paid") {
      paid++; revenue += o.amounts.total; goods += o.amounts.goods;
      service += o.amounts.serviceFee; deliveries += o.amounts.deliveryFee;
      byDay[day].revenue += o.amounts.total;
    } else if (o.payment.status === "pending" || o.payment.status === "unpaid") {
      pending++;
    }
  }
  res.json({
    totals: {
      paidOrders: paid, pendingOrders: pending,
      revenue: round(revenue), goods: round(goods),
      serviceFees: round(service), deliveryFees: round(deliveries)
    },
    byDay: Object.values(byDay).sort((a, b) => b.day.localeCompare(a.day))
  });
});

/* ── Customer balances / lifetime (aggregate by payer phone) ─────────────── */
router.get("/grocery/customers", async (_req, res) => {
  const rows = await GroceryOrder.aggregate([
    { $group: {
        _id: "$customer.phone",
        name: { $last: "$customer.name" },
        orders: { $sum: 1 },
        paidSpend: { $sum: { $cond: [{ $eq: ["$payment.status", "paid"] }, "$amounts.total", 0] } },
        outstanding: { $sum: { $cond: [{ $in: ["$payment.status", ["unpaid","pending"]] }, "$amounts.total", 0] } },
        lastOrder: { $max: "$createdAt" }
    } },
    { $sort: { paidSpend: -1 } },
    { $limit: 500 }
  ]);
  res.json({ customers: rows });
});

function round(n) { return Math.round(n * 100) / 100; }

export default router;