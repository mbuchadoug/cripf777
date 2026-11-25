// routes/zqShopAdmin.js
// ─── Admin: payment prompts + WhatsApp grocery orders + hampers ──────────────
//
// Wired at the bottom of routes/supplierAdmin.js:
//   registerZqShopAdminRoutes(router, { requireSupplierAdmin, layout, esc });
//
//   /zq-admin/pay-requests        Send a payment prompt to anyone: company
//                                 registration, grocery order, email activation,
//                                 listing, website… It arrives in WhatsApp with a
//                                 "Pay" button (EcoCash / OneMoney PIN prompt).
//                                 Tick "push" to fire the PIN prompt straight away.
//                                 Resend, push again, mark paid (cash/bank), cancel.
//   /zq-admin/grocery-orders      WhatsApp + website grocery orders. Price the
//                                 items we don't stock → the customer gets the
//                                 total + EcoCash prompt. Update status (shopping,
//                                 on the way / ready, delivered) → customer told.
//   /zq-admin/grocery-packages    Hampers & packages: name, contents, discount,
//                                 on/off, order. Prices follow the catalogue.
// ─────────────────────────────────────────────────────────────────────────────

import * as GC from "./groceryCatalogue.js";
import {
  ZqPayment, PURPOSES, createPaymentRequest, sendPaymentRequest, chargePayment,
  markPaymentPaid, localPhone, money, validMobile
} from "../services/zqPayments.js";
import {
  GroceryPackage, DEFAULT_PACKAGES, getPackages, invalidatePackages,
  sendGroceryPaymentRequest, notifyGroceryStatus
} from "../services/groceryBot.js";

const CATALOGUE = GC.CATALOGUE || {};
const ZONES = GC.ZONES || {};
const SERVICE_MIN = GC.SERVICE_MIN ?? 3;
const SERVICE_PCT = GC.SERVICE_PCT ?? 0.05;
const r2 = n => Math.round(Number(n || 0) * 100) / 100;
const _who = req => String(req.session?.adminUser || req.session?.user || req.user?.email || "admin");
async function _GroceryOrder() { return (await import("../models/groceryOrder.js")).default; }

const CSS = `<style>
.zs-wrap{max-width:1150px}
.zs-card{background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:16px;margin-bottom:16px}
.zs-card h3{font-size:15px;margin-bottom:10px}
.zs-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px}
.zs-grid label{display:block;font-size:12px;color:#64748b;margin-bottom:3px}
.zs-grid input,.zs-grid select,.zs-grid textarea,.zs-in{width:100%;padding:8px 10px;border:1px solid #cbd5e1;border-radius:8px;font:inherit}
.zs-btn{display:inline-block;border:0;border-radius:8px;padding:8px 14px;font-weight:600;cursor:pointer;background:#0d9488;color:#fff;text-decoration:none;font-size:13px}
.zs-btn.gray{background:#e2e8f0;color:#1e293b}.zs-btn.red{background:#dc2626}.zs-btn.blue{background:#2563eb}.zs-btn.sm{padding:5px 9px;font-size:12px}
.zs-t{width:100%;border-collapse:collapse;font-size:13px}
.zs-t th{text-align:left;color:#64748b;font-weight:600;border-bottom:1px solid #e2e8f0;padding:7px 6px;white-space:nowrap}
.zs-t td{border-bottom:1px solid #f1f5f9;padding:7px 6px;vertical-align:top}
.zs-pill{display:inline-block;padding:2px 8px;border-radius:999px;font-size:11px;font-weight:700}
.p-paid{background:#dcfce7;color:#166534}.p-pending{background:#fef9c3;color:#854d0e}.p-requested{background:#e0f2fe;color:#075985}
.p-failed,.p-cancelled{background:#fee2e2;color:#991b1b}.p-quote_pending{background:#ffedd5;color:#9a3412}
.p-awaiting_payment,.p-received{background:#e0f2fe;color:#075985}.p-shopping,.p-out_for_delivery{background:#ede9fe;color:#5b21b6}.p-delivered{background:#dcfce7;color:#166534}
.zs-tabs a{display:inline-block;margin:0 6px 8px 0;padding:6px 12px;border-radius:999px;background:#e2e8f0;color:#1e293b;text-decoration:none;font-size:13px}
.zs-tabs a.on{background:#0d9488;color:#fff}
.zs-flash{padding:10px 14px;border-radius:10px;margin-bottom:14px;font-weight:600}
.zs-flash.ok{background:#dcfce7;color:#166534}.zs-flash.err{background:#fee2e2;color:#991b1b}
.zs-chips button{margin:0 6px 6px 0;border:1px solid #cbd5e1;background:#fff;border-radius:999px;padding:5px 10px;cursor:pointer;font-size:12px}
.zs-muted{color:#64748b;font-size:12px}
.zs-inline{display:inline}
@media(max-width:768px){.zs-t{min-width:640px}}
</style>`;

const pill = (s, esc) => `<span class="zs-pill p-${esc(s || "")}">${esc(String(s || "-").replace(/_/g, " "))}</span>`;
const flash = (q, esc) => (q.ok ? `<div class="zs-flash ok">✅ ${esc(q.ok)}</div>` : "") + (q.err ? `<div class="zs-flash err">❌ ${esc(q.err)}</div>` : "");
const go = (res, path, kind, msg) => res.redirect(`${path}${path.includes("?") ? "&" : "?"}${kind}=${encodeURIComponent(msg)}`);
const when = d => d ? new Date(d).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Africa/Harare" }) : "";

export function registerZqShopAdminRoutes(router, { requireSupplierAdmin, layout, esc }) {

  // ═══════════════════════════════════════════════════════════════════════════
  // PAYMENT REQUESTS
  // ═══════════════════════════════════════════════════════════════════════════
  router.get("/pay-requests", requireSupplierAdmin, async (req, res) => {
    try {
      const status = String(req.query.status || "");
      const q = status ? { status } : {};
      const [list, paidAgg, pending] = await Promise.all([
        ZqPayment.find(q).sort({ createdAt: -1 }).limit(150).lean(),
        ZqPayment.aggregate([{ $match: { status: "paid", paidAt: { $gte: new Date(new Date().getFullYear(), new Date().getMonth(), 1) } } }, { $group: { _id: null, t: { $sum: "$amount" }, n: { $sum: 1 } } }]),
        ZqPayment.countDocuments({ status: { $in: ["requested", "pending"] } })
      ]);
      const paid = paidAgg[0] || { t: 0, n: 0 };
      const purposeOpts = Object.entries(PURPOSES).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join("");
      const rows = list.map(p => `<tr>
        <td class="zs-muted">${when(p.createdAt)}</td>
        <td><b>${esc(p.reference)}</b>${p.orderRef ? `<div class="zs-muted"><a href="/zq-admin/grocery-orders/${esc(p.orderRef)}">${esc(p.orderRef)}</a></div>` : ""}</td>
        <td>${esc(localPhone(p.phone))}${p.name ? `<div class="zs-muted">${esc(p.name)}</div>` : ""}</td>
        <td>${esc(p.description || PURPOSES[p.purpose] || "")}<div class="zs-muted">${esc(PURPOSES[p.purpose] || "")}</div></td>
        <td><b>${money(p.amount)}</b></td>
        <td>${pill(p.status, esc)}${p.payerNumber ? `<div class="zs-muted">from ${esc(p.payerNumber)}</div>` : ""}${p.paidAt ? `<div class="zs-muted">${when(p.paidAt)}</div>` : ""}</td>
        <td class="zs-muted">${esc(p.sentVia || "")}</td>
        <td style="white-space:nowrap">${p.status === "paid" ? "" : `
          <form class="zs-inline" method="POST" action="/zq-admin/pay-requests/${esc(p.reference)}/resend"><button class="zs-btn sm gray" title="Send the WhatsApp request again">↻ Resend</button></form>
          <form class="zs-inline" method="POST" action="/zq-admin/pay-requests/${esc(p.reference)}/push" onsubmit="var n=prompt('EcoCash/OneMoney number to send the PIN prompt to:','${esc(localPhone(p.payerNumber || p.phone))}');if(!n)return false;this.payer.value=n;"><input type="hidden" name="payer"><button class="zs-btn sm blue" title="Send the PIN prompt now">📲 Push</button></form>
          <form class="zs-inline" method="POST" action="/zq-admin/pay-requests/${esc(p.reference)}/paid" onsubmit="return confirm('Mark ${esc(p.reference)} as PAID (cash / bank)? The customer gets a receipt.')"><button class="zs-btn sm" title="Paid by cash or bank">✔ Paid</button></form>
          <form class="zs-inline" method="POST" action="/zq-admin/pay-requests/${esc(p.reference)}/cancel" onsubmit="return confirm('Cancel ${esc(p.reference)}?')"><button class="zs-btn sm red">✕</button></form>`}
        </td></tr>`).join("");
      const tabs = ["", "requested", "pending", "paid", "failed", "cancelled"].map(s =>
        `<a class="${s === status ? "on" : ""}" href="/zq-admin/pay-requests${s ? "?status=" + s : ""}">${s ? s : "All"}</a>`).join("");

      res.send(layout("Payment Requests", `${CSS}<div class="zs-wrap">${flash(req.query, esc)}
<div class="zs-card">
  <h3>📲 Send a payment prompt</h3>
  <p class="zs-muted" style="margin-bottom:10px">The customer gets a WhatsApp message with a <b>Pay</b> button → EcoCash/OneMoney PIN prompt → automatic receipt. Money goes to ZimQuote's Paynow account. You get a WhatsApp alert when it's paid.<br>On WhatsApp you can also type: <code>pay 0771234567 120 Company registration</code> (or <code>push …</code> to fire the PIN prompt at once).</p>
  <div class="zs-chips" id="chips">
    <button type="button" data-p="company_registration" data-d="Company registration (PBC)">🏢 Company registration</button>
    <button type="button" data-p="email" data-d="Business email activation">📧 Email activation</button>
    <button type="button" data-p="grocery" data-d="Grocery order">🛒 Groceries</button>
    <button type="button" data-p="listing" data-d="ZimQuote listing - 1 month">🏪 Listing</button>
    <button type="button" data-p="website" data-d="Website design - deposit">🌐 Website</button>
    <button type="button" data-p="delivery" data-d="Delivery">🏍️ Delivery</button>
  </div>
  <form method="POST" action="/zq-admin/pay-requests">
    <div class="zs-grid">
      <div><label>Customer WhatsApp number *</label><input name="phone" required placeholder="0771234567" inputmode="tel"></div>
      <div><label>Name (optional)</label><input name="name" placeholder="Tendai Moyo"></div>
      <div><label>Type</label><select name="purpose" id="purpose">${purposeOpts}</select></div>
      <div><label>What it's for (customer sees this) *</label><input name="description" id="desc" required maxlength="120" placeholder="Company registration (PBC)"></div>
      <div><label>Amount (USD) *</label><input name="amount" required inputmode="decimal" placeholder="120.00"></div>
    </div>
    <div style="margin-top:10px">
      <label style="font-size:13px"><input type="checkbox" name="push" value="1"> Also send the EcoCash/OneMoney PIN prompt now to</label>
      <input name="payer" class="zs-in" style="max-width:180px;display:inline-block" placeholder="same number">
    </div>
    <div style="margin-top:12px"><button class="zs-btn">📲 Send payment request</button></div>
  </form>
</div>
<div class="zs-card">
  <h3>💳 Requests &nbsp;<span class="zs-muted">Paid this month: <b>${money(paid.t)}</b> (${paid.n}) · Waiting: <b>${pending}</b></span></h3>
  <div class="zs-tabs">${tabs}</div>
  <div class="table-wrap"><table class="zs-t"><tr><th>Date</th><th>Ref</th><th>Customer</th><th>For</th><th>Amount</th><th>Status</th><th>Sent via</th><th></th></tr>${rows || `<tr><td colspan="8" class="zs-muted">No payment requests yet.</td></tr>`}</table></div>
</div>
</div>
<script>
document.querySelectorAll('#chips button').forEach(function(b){b.onclick=function(){document.getElementById('purpose').value=b.dataset.p;document.getElementById('desc').value=b.dataset.d;document.querySelector('[name=amount]').focus();};});
</script>`));
    } catch (e) {
      console.error("[PAY REQUESTS]", e);
      res.status(500).send(layout("Payment Requests", `<div class="zs-flash err">${esc(e.message)}</div>`));
    }
  });

  router.post("/pay-requests", requireSupplierAdmin, async (req, res) => {
    try {
      const b = req.body || {};
      const doc = await createPaymentRequest({
        phone: b.phone, amount: b.amount, purpose: b.purpose, description: b.description, name: b.name, requestedBy: _who(req)
      });
      const r = await sendPaymentRequest(doc, { push: b.push === "1", payerNumber: b.payer || null });
      const msg = `${doc.reference} sent to ${localPhone(doc.phone)} (${money(doc.amount)}) via ${r.sentVia}` +
        (b.push === "1" ? (r.pushed ? " · PIN prompt sent" : ` · PIN prompt NOT sent: ${r.error || "error"}`) : "");
      go(res, "/zq-admin/pay-requests", r.sentVia === "failed" ? "err" : "ok", r.sentVia === "failed"
        ? `${doc.reference} saved but WhatsApp delivery failed (outside 24h & no approved template). Ask the customer to message the bot, then Resend.` : msg);
    } catch (e) { go(res, "/zq-admin/pay-requests", "err", e.message); }
  });

  router.post("/pay-requests/:ref/:op", requireSupplierAdmin, async (req, res) => {
    const ref = String(req.params.ref).toUpperCase();
    if (!["resend", "push", "paid", "cancel"].includes(req.params.op)) return go(res, "/zq-admin/pay-requests", "err", "Unknown action");
    try {
      const doc = await ZqPayment.findOne({ reference: ref }).lean();
      if (!doc) return go(res, "/zq-admin/pay-requests", "err", "Not found");
      if (req.params.op === "resend") {
        if (doc.status === "cancelled") await ZqPayment.updateOne({ _id: doc._id }, { $set: { status: "requested" } });
        const r = await sendPaymentRequest(doc);
        return go(res, "/zq-admin/pay-requests", r.sentVia === "failed" ? "err" : "ok", `${ref} resent via ${r.sentVia}`);
      }
      if (req.params.op === "push") {
        const num = validMobile(req.body?.payer || doc.phone);
        if (!num) return go(res, "/zq-admin/pay-requests", "err", "Not an EcoCash (077/078) or OneMoney (071) number");
        const r = await chargePayment(ref, num);
        return go(res, "/zq-admin/pay-requests", r.ok ? "ok" : "err", r.ok ? `PIN prompt sent to ${num} for ${ref}` : `${ref}: ${r.error}`);
      }
      if (req.params.op === "paid") {
        await markPaymentPaid(ref, { method: "manual", by: _who(req) });
        return go(res, "/zq-admin/pay-requests", "ok", `${ref} marked paid - receipt sent`);
      }
      await ZqPayment.updateOne({ _id: doc._id, status: { $ne: "paid" } }, { $set: { status: "cancelled" } });
      return go(res, "/zq-admin/pay-requests", "ok", `${ref} cancelled`);
    } catch (e) { go(res, "/zq-admin/pay-requests", "err", e.message); }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // GROCERY ORDERS
  // ═══════════════════════════════════════════════════════════════════════════
  const FILTERS = {
    todo:     { label: "⚡ To do",          q: { "fulfilment.status": { $in: ["quote_pending", "paid", "shopping", "out_for_delivery"] } } },
    price:    { label: "❓ Needs prices",   q: { "fulfilment.status": "quote_pending" } },
    unpaid:   { label: "💳 Awaiting payment", q: { "fulfilment.status": { $in: ["awaiting_payment", "received"] }, "payment.status": { $ne: "paid" } } },
    paid:     { label: "✅ Paid - to pack", q: { "fulfilment.status": "paid" } },
    moving:   { label: "🏍️ Shopping / on the way", q: { "fulfilment.status": { $in: ["shopping", "out_for_delivery"] } } },
    done:     { label: "📦 Delivered",      q: { "fulfilment.status": "delivered" } },
    all:      { label: "All",               q: {} }
  };

  router.get("/grocery-orders", requireSupplierAdmin, async (req, res) => {
    try {
      const GroceryOrder = await _GroceryOrder();
      const f = FILTERS[req.query.s] ? String(req.query.s) : "todo";
      const counts = {};
      for (const [k, v] of Object.entries(FILTERS)) counts[k] = await GroceryOrder.countDocuments(v.q);
      const list = await GroceryOrder.find(FILTERS[f].q).sort({ createdAt: -1 }).limit(200).lean();
      const rows = list.map(o => {
        const wa = /WhatsApp/i.test(o.delivery?.notes || "");
        return `<tr>
          <td class="zs-muted">${when(o.createdAt)}</td>
          <td><a href="/zq-admin/grocery-orders/${esc(o.reference)}"><b>${esc(String(o.reference).replace(/^GRO-(.{8}).*$/, "GRO-$1…"))}</b></a><div class="zs-muted">${wa ? "💬 WhatsApp" : "🌐 Website"}</div></td>
          <td>${esc(o.customer?.name || "")}<div class="zs-muted">${esc(o.customer?.phone || "")}</div></td>
          <td>${esc(o.delivery?.zone || "")}<div class="zs-muted">${esc(String(o.delivery?.address || "").slice(0, 60))}</div></td>
          <td>${(o.items || []).length} items${o.hasCustomItems ? ` · <b style="color:#c2410c">${(o.items || []).filter(i => i.custom).length} to price</b>` : ""}</td>
          <td><b>${money(o.amounts?.total)}</b></td>
          <td>${pill(o.payment?.status || "unpaid", esc)}</td>
          <td>${pill(o.fulfilment?.status, esc)}</td></tr>`;
      }).join("");
      const tabs = Object.entries(FILTERS).map(([k, v]) => `<a class="${k === f ? "on" : ""}" href="/zq-admin/grocery-orders?s=${k}">${v.label} (${counts[k]})</a>`).join("");
      res.send(layout("Grocery Orders", `${CSS}<div class="zs-wrap">${flash(req.query, esc)}
<div class="zs-card">
  <div class="zs-tabs">${tabs}</div>
  <p class="zs-muted" style="margin-bottom:8px">WhatsApp orders ("groceries" in the bot) and website orders together. Customers are told on WhatsApp when you price, pack, send or deliver. · <a href="/zq-admin/grocery-packages">🎁 Edit hampers & packages</a> · <a href="/zq-admin/pay-requests">📲 Payment requests</a></p>
  <div class="table-wrap"><table class="zs-t"><tr><th>Date</th><th>Order</th><th>Customer</th><th>Delivery</th><th>Items</th><th>Total</th><th>Payment</th><th>Status</th></tr>${rows || `<tr><td colspan="8" class="zs-muted">Nothing here.</td></tr>`}</table></div>
</div></div>`));
    } catch (e) {
      console.error("[GROCERY ORDERS]", e);
      res.status(500).send(layout("Grocery Orders", `<div class="zs-flash err">${esc(e.message)}</div>`));
    }
  });

  router.get("/grocery-orders/:ref", requireSupplierAdmin, async (req, res) => {
    try {
      const GroceryOrder = await _GroceryOrder();
      const o = await GroceryOrder.findOne({ reference: req.params.ref }).lean();
      if (!o) return go(res, "/zq-admin/grocery-orders", "err", "Order not found");
      const pays = await ZqPayment.find({ orderRef: o.reference }).sort({ createdAt: -1 }).lean();
      const photos = String(o.delivery?.notes || "").match(/https?:\/\/\S+/g) || [];
      const itemRows = (o.items || []).map((it, i) => `<tr>
        <td>${i + 1}</td><td>${esc(it.name)}${it.unit ? ` <span class="zs-muted">${esc(it.unit)}</span>` : ""}${it.sku ? `<div class="zs-muted">${esc(it.sku)}</div>` : ""}</td>
        <td>${esc(it.qty)}</td>
        <td>${it.custom ? `<input class="zs-in" style="max-width:110px" name="price_${i}" inputmode="decimal" placeholder="unit $">` : money(it.unitPrice)}</td>
        <td>${it.custom ? `<label class="zs-muted"><input type="checkbox" name="remove_${i}" value="1"> not available</label>` : money(it.lineTotal)}</td></tr>`).join("");
      const statusOpts = ["shopping", "out_for_delivery", "delivered", "cancelled"].map(s =>
        `<option value="${s}">${s === "out_for_delivery" ? (o.delivery?.zone === "collect" ? "ready to collect" : "on the way") : s}</option>`).join("");
      const timeline = (o.fulfilment?.timeline || []).slice().reverse().map(t => `<div class="zs-muted">${when(t.at)} · <b>${esc(t.event)}</b> ${esc(t.note || "")}</div>`).join("");
      res.send(layout(`Grocery: ${o.reference}`, `${CSS}<div class="zs-wrap">${flash(req.query, esc)}
<p><a href="/zq-admin/grocery-orders">← All grocery orders</a></p>
<div class="zs-card">
  <h3>${esc(o.reference)} &nbsp;${pill(o.payment?.status || "unpaid", esc)} ${pill(o.fulfilment?.status, esc)}</h3>
  <div class="zs-grid">
    <div><label>Customer</label>${esc(o.customer?.name || "")}<br><a href="https://wa.me/${esc(String(o.customer?.phone || "").replace(/\D/g, "").replace(/^0/, "263"))}" target="_blank">${esc(o.customer?.phone || "")}</a></div>
    <div><label>Recipient</label>${esc(o.recipient?.name || "-")} ${esc(o.recipient?.phone || "")}</div>
    <div><label>Delivery</label>${esc(ZONES[o.delivery?.zone]?.label || o.delivery?.zone || "")}<br>${esc(o.delivery?.address || "")}</div>
    <div><label>Notes</label>${esc(String(o.delivery?.notes || "").replace(/https?:\/\/\S+/g, "").trim() || "-")}</div>
  </div>
  ${photos.length ? `<p style="margin-top:10px">📷 List photo${photos.length > 1 ? "s" : ""}: ${photos.map(u => `<a href="${esc(u)}" target="_blank">open</a>`).join(" · ")}</p>` : ""}
</div>
<div class="zs-card">
  <h3>🧾 Items ${o.hasCustomItems ? `<span class="zs-muted">- type a unit price for each item we don't stock, then save</span>` : ""}</h3>
  <form method="POST" action="/zq-admin/grocery-orders/${esc(o.reference)}/price">
  <div class="table-wrap"><table class="zs-t"><tr><th>#</th><th>Item</th><th>Qty</th><th>Unit price</th><th>Line</th></tr>${itemRows}
    <tr><td></td><td colspan="3" style="text-align:right">Goods</td><td><b>${money(o.amounts?.goods)}</b></td></tr>
    <tr><td></td><td colspan="3" style="text-align:right">Service fee</td><td>${money(o.amounts?.serviceFee)}</td></tr>
    <tr><td></td><td colspan="3" style="text-align:right">Delivery</td><td>${money(o.amounts?.deliveryFee)}</td></tr>
    <tr><td></td><td colspan="3" style="text-align:right"><b>Total</b></td><td><b>${money(o.amounts?.total)}</b></td></tr></table></div>
  ${o.hasCustomItems ? `<label style="display:block;margin-top:10px;font-size:13px"><input type="checkbox" name="send" value="1" checked> When everything is priced, send the customer the total + EcoCash payment prompt</label>
  <button class="zs-btn" style="margin-top:10px">💾 Save prices</button>` : ""}
  </form>
</div>
<div class="zs-card">
  <h3>💳 Payment</h3>
  ${pays.map(p => `<div>${pill(p.status, esc)} <b>${esc(p.reference)}</b> ${money(p.amount)} ${p.payerNumber ? `from ${esc(p.payerNumber)}` : ""} <span class="zs-muted">${when(p.createdAt)} · via ${esc(p.sentVia || "-")}</span></div>`).join("") || `<p class="zs-muted">No payment request yet.</p>`}
  ${o.payment?.status !== "paid" && !o.hasCustomItems ? `<div style="margin-top:10px">
    <form class="zs-inline" method="POST" action="/zq-admin/grocery-orders/${esc(o.reference)}/payreq"><button class="zs-btn blue">📲 Send EcoCash payment request</button></form>
    <form class="zs-inline" method="POST" action="/zq-admin/grocery-orders/${esc(o.reference)}/paid" onsubmit="return confirm('Mark as paid (cash / bank)?')"><button class="zs-btn gray">✔ Mark paid (cash/bank)</button></form></div>` : ""}
</div>
<div class="zs-card">
  <h3>🚚 Update status <span class="zs-muted">- the customer is told on WhatsApp</span></h3>
  <form method="POST" action="/zq-admin/grocery-orders/${esc(o.reference)}/status"><div class="zs-grid">
    <div><label>Status</label><select name="status">${statusOpts}</select></div>
    <div><label>Rider (name & phone)</label><input name="rider" value="${esc(o.fulfilment?.rider || "")}"></div>
    <div><label>Note to customer (optional)</label><input name="note" maxlength="200"></div>
  </div><button class="zs-btn" style="margin-top:10px">Update & notify</button></form>
  <div style="margin-top:12px">${timeline}</div>
</div></div>`));
    } catch (e) {
      console.error("[GROCERY ORDER]", e);
      res.status(500).send(layout("Grocery Orders", `<div class="zs-flash err">${esc(e.message)}</div>`));
    }
  });

  router.post("/grocery-orders/:ref/price", requireSupplierAdmin, async (req, res) => {
    const back = `/zq-admin/grocery-orders/${encodeURIComponent(req.params.ref)}`;
    try {
      const GroceryOrder = await _GroceryOrder();
      const o = await GroceryOrder.findOne({ reference: req.params.ref });
      if (!o) return go(res, "/zq-admin/grocery-orders", "err", "Order not found");
      const b = req.body || {};
      const keep = [];
      (o.items || []).forEach((it, i) => {
        if (it.custom && b[`remove_${i}`] === "1") return;            // not available → drop
        if (it.custom && b[`price_${i}`] !== undefined && String(b[`price_${i}`]).trim() !== "") {
          const up = r2(String(b[`price_${i}`]).replace(/[^0-9.]/g, ""));
          if (up > 0) { it.unitPrice = up; it.lineTotal = r2(up * it.qty); it.custom = false; }
        }
        keep.push(it);
      });
      o.items = keep;
      const goods = r2(keep.reduce((t, it) => t + (it.custom ? 0 : (it.lineTotal || 0)), 0));
      const stillCustom = keep.some(it => it.custom);
      o.hasCustomItems = stillCustom;
      o.amounts.goods = goods;
      o.amounts.serviceFee = Math.max(SERVICE_MIN, r2(goods * SERVICE_PCT));
      o.amounts.deliveryFee = ZONES[o.delivery?.zone]?.fee || 0;
      o.amounts.total = r2(o.amounts.goods + o.amounts.serviceFee + o.amounts.deliveryFee);
      o.fulfilment.status = stillCustom ? "quote_pending" : "awaiting_payment";
      if (typeof o.markModified === "function") o.markModified("items");
      if (typeof o.pushTimeline === "function") o.pushTimeline("quoted", `Priced by ${_who(req)}. Total ${money(o.amounts.total)}`);
      await o.save();
      if (!stillCustom && b.send === "1") {
        const r = await sendGroceryPaymentRequest(o, { by: _who(req) });
        const minG = o.delivery?.zone === "collect" ? (GC.MIN_COLLECT ?? 5) : (GC.MIN_GOODS ?? 30);
        const lowNote = goods < minG ? ` (Note: goods ${money(goods)} are below the usual ${money(minG)} minimum.)` : "";
        return go(res, back, r && r.sentVia !== "failed" ? "ok" : "err",
          r ? `Priced (${money(o.amounts.total)}). Payment request ${r.doc.reference} sent via ${r.sentVia}.${lowNote}` : "Priced, but the payment request could not be created.");
      }
      const minG = o.delivery?.zone === "collect" ? (GC.MIN_COLLECT ?? 5) : (GC.MIN_GOODS ?? 30);
      const lowNote = !stillCustom && goods < minG ? ` ⚠️ Goods ${money(goods)} are below the ${money(minG)} minimum - check before sending.` : "";
      go(res, back, "ok", (stillCustom ? "Saved - some items still need prices." : `Priced: ${money(o.amounts.total)}`) + lowNote);
    } catch (e) { go(res, back, "err", e.message); }
  });

  router.post("/grocery-orders/:ref/:op", requireSupplierAdmin, async (req, res) => {
    const back = `/zq-admin/grocery-orders/${encodeURIComponent(req.params.ref)}`;
    if (!["payreq", "paid", "status"].includes(req.params.op)) return go(res, back, "err", "Unknown action");
    try {
      const GroceryOrder = await _GroceryOrder();
      const o = await GroceryOrder.findOne({ reference: req.params.ref });
      if (!o) return go(res, "/zq-admin/grocery-orders", "err", "Order not found");
      if (req.params.op === "payreq") {
        const r = await sendGroceryPaymentRequest(o, { by: _who(req) });
        return go(res, back, r && r.sentVia !== "failed" ? "ok" : "err", r ? `Payment request ${r.doc.reference} sent via ${r.sentVia}` : "Order already paid or still needs prices");
      }
      if (req.params.op === "paid") {
        const open = await ZqPayment.findOne({ orderRef: o.reference, status: { $ne: "cancelled" } }).sort({ createdAt: -1 }).lean();
        if (open) await markPaymentPaid(open.reference, { method: "manual", by: _who(req) });
        else {
          const { markGroceryPaid } = await import("../services/groceryBot.js");
          await markGroceryPaid(o.reference, { method: "ecocash", reference: `manual by ${_who(req)}` });
        }
        return go(res, back, "ok", "Marked paid - customer notified");
      }
      const s = String(req.body?.status || "");
      if (!["shopping", "out_for_delivery", "delivered", "cancelled"].includes(s)) return go(res, back, "err", "Pick a status");
      o.fulfilment.status = s;
      if (req.body?.rider) o.fulfilment.rider = String(req.body.rider).slice(0, 80);
      if (typeof o.pushTimeline === "function") o.pushTimeline(s, String(req.body?.note || "").slice(0, 200));
      await o.save();
      await notifyGroceryStatus(o, s, { rider: o.fulfilment.rider || "", note: String(req.body?.note || "").slice(0, 200) });
      go(res, back, "ok", `Status: ${s.replace(/_/g, " ")} - customer notified`);
    } catch (e) { go(res, back, "err", e.message); }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // HAMPERS & PACKAGES
  // ═══════════════════════════════════════════════════════════════════════════
  async function _seedIfEmpty() {
    if (await GroceryPackage.countDocuments({})) return;
    for (const p of DEFAULT_PACKAGES) await GroceryPackage.create({ ...p, active: true });
  }
  const _linesText = (lines) => (lines || []).map(l => `${l.sku} x${l.qty}`).join("\n");
  function _parseLines(text) {
    const lines = [], bad = [];
    for (const raw of String(text || "").split(/[\n,]+/)) {
      const t = raw.trim(); if (!t) continue;
      const m = t.match(/^([a-z0-9_]+)\s*(?:[x×:*]\s*(\d{1,3}))?$/i);
      if (!m || !CATALOGUE[m[1].toLowerCase()]) { bad.push(t); continue; }
      lines.push({ sku: m[1].toLowerCase(), qty: Math.max(1, +(m[2] || 1)) });
    }
    return { lines, bad };
  }

  router.get("/grocery-packages", requireSupplierAdmin, async (req, res) => {
    try {
      const priced = await getPackages({ includeInactive: true });
      const priceOf = Object.fromEntries(priced.map(p => [p.key, p]));
      const dbCount = await GroceryPackage.countDocuments({});
      const src = dbCount ? await GroceryPackage.find({}).sort({ order: 1 }).lean() : DEFAULT_PACKAGES.map(p => ({ ...p, active: true }));
      const form = (p, isNew = false) => `<form method="POST" action="/zq-admin/grocery-packages/save" class="zs-card">
        <h3>${isNew ? "➕ New hamper / package" : `${esc(p.name)} <span class="zs-muted">${priceOf[p.key] ? `→ customer pays <b>${money(priceOf[p.key].price)}</b> (items ${money(priceOf[p.key].full)})` : ""}</span>`}</h3>
        <div class="zs-grid">
          <div><label>Key (short id)</label><input name="key" value="${esc(p.key || "")}" ${isNew ? "" : "readonly"} required pattern="[a-z0-9_]{2,20}" placeholder="easter"></div>
          <div><label>Name (with emoji)</label><input name="name" value="${esc(p.name || "")}" required maxlength="40"></div>
          <div><label>Short description</label><input name="blurb" value="${esc(p.blurb || "")}" maxlength="70"></div>
          <div><label>Discount %</label><input name="discountPct" value="${esc(p.discountPct ?? 5)}" inputmode="decimal"></div>
          <div><label>Order (lower = first)</label><input name="order" value="${esc(p.order ?? 100)}"></div>
          <div><label>Show to customers</label><select name="active"><option value="1" ${p.active !== false ? "selected" : ""}>Yes</option><option value="0" ${p.active === false ? "selected" : ""}>No (hidden)</option></select></div>
        </div>
        <div style="margin-top:8px"><label class="zs-muted">Contents - one per line: <code>sku x qty</code></label><textarea name="lines" class="zs-in" rows="${Math.min(14, Math.max(4, (p.lines || []).length + 1))}" required>${esc(_linesText(p.lines))}</textarea></div>
        <div style="margin-top:8px"><button class="zs-btn">💾 Save</button>
        ${isNew ? "" : `<button class="zs-btn red sm" formaction="/zq-admin/grocery-packages/delete" onclick="return confirm('Delete ${esc(p.name)}?')" style="float:right">Delete</button>`}</div>
      </form>`;
      const skuRef = Object.entries(CATALOGUE).map(([k, [n, u, pr]]) => `<tr><td><code>${esc(k)}</code></td><td>${esc(n)} ${esc(u)}</td><td>${money(pr)}</td></tr>`).join("");
      res.send(layout("Grocery Packages", `${CSS}<div class="zs-wrap">${flash(req.query, esc)}
<p class="zs-muted" style="margin-bottom:12px">Hampers shown in WhatsApp (<i>groceries → Hampers</i>). Prices are worked out from today's catalogue prices minus the discount, so they stay right when prices change. ${dbCount ? "" : "<b>Showing the built-in hampers - saving any one copies them all here so you can edit them.</b>"} · <a href="/zq-admin/grocery-orders">← Grocery orders</a></p>
${src.map(p => form(p)).join("")}
${form({ key: "", name: "", blurb: "", lines: [], discountPct: 5, order: 100, active: true }, true)}
<details class="zs-card"><summary><b>📋 Catalogue SKUs & prices</b> <span class="zs-muted">(from routes/groceryCatalogue.js)</span></summary>
<div class="table-wrap" style="margin-top:10px"><table class="zs-t"><tr><th>sku</th><th>Item</th><th>Price</th></tr>${skuRef}</table></div></details>
</div>`));
    } catch (e) {
      console.error("[GROCERY PACKAGES]", e);
      res.status(500).send(layout("Grocery Packages", `<div class="zs-flash err">${esc(e.message)}</div>`));
    }
  });

  router.post("/grocery-packages/save", requireSupplierAdmin, async (req, res) => {
    try {
      const b = req.body || {};
      const key = String(b.key || "").toLowerCase().trim();
      if (!/^[a-z0-9_]{2,20}$/.test(key)) throw new Error("Key: 2-20 lowercase letters, numbers or _");
      const { lines, bad } = _parseLines(b.lines);
      if (!lines.length) throw new Error("Add at least one item (sku x qty)");
      await _seedIfEmpty();
      await GroceryPackage.updateOne({ key }, { $set: {
        key, name: String(b.name || key).slice(0, 40), blurb: String(b.blurb || "").slice(0, 70), lines,
        discountPct: Math.min(50, Math.max(0, Number(b.discountPct) || 0)), order: Number(b.order) || 100, active: b.active !== "0"
      } }, { upsert: true });
      invalidatePackages();
      go(res, "/zq-admin/grocery-packages", bad.length ? "err" : "ok", bad.length ? `Saved, but ignored unknown items: ${bad.join(", ")}` : `Saved ${b.name || key}`);
    } catch (e) { go(res, "/zq-admin/grocery-packages", "err", e.message); }
  });

  router.post("/grocery-packages/delete", requireSupplierAdmin, async (req, res) => {
    try {
      await _seedIfEmpty();
      await GroceryPackage.deleteOne({ key: String(req.body?.key || "") });
      invalidatePackages();
      go(res, "/zq-admin/grocery-packages", "ok", "Deleted");
    } catch (e) { go(res, "/zq-admin/grocery-packages", "err", e.message); }
  });
}

export default registerZqShopAdminRoutes;
