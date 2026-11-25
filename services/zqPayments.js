// services/zqPayments.js
// ─── ZimQuote payments: EcoCash / OneMoney prompts inside WhatsApp ───────────
//
// Money paid here goes to ZIMQUOTE's own Paynow account (services/paynow.js -
// the same integration the website grocery shop uses). Used for:
//   • grocery orders placed on WhatsApp (services/groceryBot.js)
//   • ADMIN PAYMENT PROMPTS - company registration, grocery orders priced by
//     hand, business email activation, listing fees, websites, anything:
//       /zq-admin/pay-requests                (web form)
//       "pay 0771234567 120 Company registration"   (admin, on WhatsApp)
//       "push 0771234567 120 Company registration"  (also fires the PIN prompt)
//
// Customer side (all in WhatsApp, no links, no app):
//   💳 Payment request card → [📱 Pay 0771…] / [✏️ Other number] / [❌ Not now]
//   → EcoCash / OneMoney PIN prompt on their phone → ✅ receipt in the chat.
//   Typing PAY (or "pay ZQP-7K3F2") reopens their latest unpaid request.
//
// Reliability: each charge is polled every 10 s for 3 min, AND a sweeper
// re-checks every pending payment (last 6 h) every 2 min, so a pm2 restart
// mid-payment never loses a paid order.
//
// Action ids (whitelisted as meta actions in chatbotEngine.js):
//   zqp_pay_<REF>    open the pay card          zqp_same_<REF>   pay with this WhatsApp number
//   zqp_other_<REF>  type another number        zqp_check_<REF>  check status now
//   zqp_cancel_<REF> not now
// Typed-reply state: UserSession.tempData.zqp = { ref, stage: "number"|"waiting", at }
//
// .env
//   ZQ_ADMIN_PHONE / ADMIN_WHATSAPP_PHONE   admin alerts + WhatsApp "pay" command
//   ZQ_ADMIN_PHONES=2637...,2637...          (optional) more admin numbers
//   PAYNOW_INTEGRATION_ID / PAYNOW_INTEGRATION_KEY   only if services/paynow.js is missing
//   ZQ_PAYNOW_EMAIL=payments@zimqoute.co.zw          (optional) payer email Paynow requires
//
// Meta templates (optional, UTILITY) - reach customers outside the 24 h window:
//   zq_payment_request   body: "Payment request from ZimQuote.\nFor: {{1}}\nAmount: {{2}}\nReference: {{3}}\nTap the button below to pay with EcoCash or OneMoney on your phone. This is an automated message from ZimQuote."
//                        button: Quick reply "📱 Pay now"
// Without it, the request goes as WhatsApp buttons (inside 24 h) or via the
// approved zqm_news_update template with "reply PAY" instructions.
// ─────────────────────────────────────────────────────────────────────────────

import mongoose from "mongoose";
import crypto from "crypto";
import axios from "axios";
import { sendText, sendButtons } from "./metaSender.js";

const GRAPH = "v24.0";
const PNID  = () => process.env.WHATSAPP_PHONE_NUMBER_ID || process.env.META_PHONE_NUMBER_ID || process.env.PHONE_NUMBER_ID;
const TOKEN = () => process.env.META_ACCESS_TOKEN || process.env.WHATSAPP_ACCESS_TOKEN;

export const PURPOSES = {
  grocery:              "🛒 Groceries",
  company_registration: "🏢 Company registration",
  email:                "📧 Business email activation",
  listing:              "🏪 ZimQuote listing / subscription",
  website:              "🌐 Website / design",
  delivery:             "🏍️ Delivery",
  other:                "💳 Payment"
};

// ── Model ────────────────────────────────────────────────────────────────────
const zqPaymentSchema = new mongoose.Schema({
  reference:   { type: String, unique: true, index: true },   // ZQP-7K3F2
  phone:       { type: String, index: true },                 // customer WhatsApp 2637…
  name:        String,
  purpose:     { type: String, default: "other" },
  description: String,
  amount:      Number,
  currency:    { type: String, default: "USD" },
  orderRef:    { type: String, index: true },                 // e.g. GroceryOrder reference
  payerNumber: String,
  method:      String,                                        // ecocash | onemoney | manual
  status:      { type: String, enum: ["requested", "pending", "paid", "failed", "cancelled"], default: "requested", index: true },
  pollUrl:     String,
  paynowRef:   String,
  attempts:    { type: Number, default: 0 },
  paidAt:      Date,
  requestedBy: String,
  sentVia:     String,
  note:        String
}, { timestamps: true });
export const ZqPayment = mongoose.models.ZqPayment || mongoose.model("ZqPayment", zqPaymentSchema);

// ── Helpers ──────────────────────────────────────────────────────────────────
const _digits = (p) => String(p || "").replace(/\D+/g, "");
export function intlPhone(p) {
  let d = _digits(p);
  if (d.startsWith("0") && d.length === 10) d = "263" + d.slice(1);
  if (d.length === 9 && d.startsWith("7")) d = "263" + d;
  return d;
}
export const localPhone = (p) => { const d = intlPhone(p); return d.startsWith("263") ? "0" + d.slice(3) : d; };
export const money = (n) => `$${Number(n || 0).toFixed(2)}`;

/** 0771234567 / +263 77 123 4567 → "0771234567" if EcoCash/OneMoney, else null */
export function validMobile(t) {
  const l = localPhone(t);
  return /^07[178]\d{7}$/.test(l) ? l : null;
}
const _method = (local) => (local.startsWith("071") ? "onemoney" : "ecocash");
const _methodName = (m) => (m === "onemoney" ? "OneMoney" : "EcoCash");

export function adminPhones() {
  const raw = [process.env.ZQ_ADMIN_PHONE, process.env.ADMIN_WHATSAPP_PHONE, ...(String(process.env.ZQ_ADMIN_PHONES || "").split(","))];
  return [...new Set(raw.map(intlPhone).filter(p => p.length >= 11))];
}
export const isAdminPhone = (p) => adminPhones().includes(intlPhone(p));

async function _notifyAdmins(text) {
  for (const p of adminPhones()) { try { await sendText(p, text); } catch (_) {} }
}

async function _newRef() {
  for (let i = 0; i < 6; i++) {
    const r = "ZQP-" + crypto.randomBytes(4).readUInt32BE(0).toString(36).toUpperCase().padStart(5, "0").slice(-5);
    if (!(await ZqPayment.exists({ reference: r }))) return r;
  }
  return "ZQP-" + Date.now().toString(36).toUpperCase();
}

async function _Session() { return (await import("../models/userSession.js")).default; }
async function _setState(from, val) {
  const US = await _Session();
  if (val) await US.updateOne({ phone: _digits(from) }, { $set: { "tempData.zqp": { ...val, at: new Date() } } }, { upsert: true });
  else await US.updateOne({ phone: _digits(from) }, { $unset: { "tempData.zqp": "" } });
}
async function _getState(from) {
  const US = await _Session();
  const s = await US.findOne({ phone: _digits(from) }, { "tempData.zqp": 1 }).lean();
  const st = s?.tempData?.zqp;
  if (!st || !st.at || Date.now() - new Date(st.at).getTime() > 2 * 60 * 60 * 1000) return null;
  return st;
}

// ── Paynow (ZimQuote's own integration) ─────────────────────────────────────
let _pnClient = null;
async function _paynow() {
  if (_pnClient) return _pnClient;
  try {
    const m = await import("./paynow.js");
    const c = m.default || m.paynow;
    if (c && typeof c.sendMobile === "function") return (_pnClient = c);
  } catch (_) {}
  const id = process.env.PAYNOW_INTEGRATION_ID || process.env.PAYNOW_ID;
  const key = process.env.PAYNOW_INTEGRATION_KEY || process.env.PAYNOW_KEY;
  if (!id || !key) return null;
  const mod = await import("paynow");
  const Paynow = mod.Paynow || mod.default?.Paynow || mod.default;
  const c = new Paynow(String(id), String(key));
  const site = String(process.env.SITE_URL || "https://cripfcnt.com").replace(/\/$/, "");
  c.resultUrl = `${site}/paynow/zq-result`;
  c.returnUrl = "https://zimqoute.co.zw/";
  return (_pnClient = c);
}
const _isPaidStatus = (s) => ["paid", "awaiting delivery", "delivered"].includes(String(s || "").toLowerCase());

// ── Meta template with a quick-reply button (payload set per message) ───────
async function _templateWithButton(to, name, vars, payload) {
  await axios.post(`https://graph.facebook.com/${GRAPH}/${PNID()}/messages`, {
    messaging_product: "whatsapp", to: intlPhone(to), type: "template",
    template: {
      name, language: { code: "en" },
      components: [
        { type: "body", parameters: vars.map(v => ({ type: "text", text: String(v).replace(/[\n\r\t]+/g, " ").slice(0, 1000) })) },
        { type: "button", sub_type: "quick_reply", index: "0", parameters: [{ type: "payload", payload }] }
      ]
    }
  }, { headers: { Authorization: `Bearer ${TOKEN()}`, "Content-Type": "application/json" }, timeout: 15000 });
}

// ═════════════════════════════════════════════════════════════════════════════
// CREATE + SEND A PAYMENT REQUEST
// ═════════════════════════════════════════════════════════════════════════════
export async function createPaymentRequest({ phone, amount, purpose = "other", description = "", orderRef = null, name = "", requestedBy = "system", note = "" }) {
  const p = intlPhone(phone);
  if (!/^263\d{9}$/.test(p)) throw new Error("Enter a valid Zimbabwe WhatsApp number, e.g. 0771234567");
  const amt = Math.round(Number(amount) * 100) / 100;
  if (!(amt > 0) || amt > 20000) throw new Error("Enter an amount between $0.01 and $20,000");
  const purposeKey = PURPOSES[purpose] ? purpose : "other";
  const desc = String(description || PURPOSES[purposeKey]).trim().slice(0, 120) || PURPOSES[purposeKey];
  return ZqPayment.create({
    reference: await _newRef(), phone: p, name: String(name || "").slice(0, 80),
    purpose: purposeKey, description: desc, amount: amt, orderRef: orderRef || undefined,
    requestedBy, note: String(note || "").slice(0, 300), status: "requested", attempts: 0
  });
}

const _forLine = (doc) => doc.description && doc.description !== PURPOSES[doc.purpose]
  ? doc.description : (PURPOSES[doc.purpose] || "Payment").replace(/^[^\p{L}]+/u, "");

/**
 * Deliver a payment request to the customer.
 * Order: approved template (works any time) → WhatsApp buttons (inside 24 h)
 * → zqm_news_update template with "reply PAY". Optionally fires the PIN prompt.
 * @returns {Promise<{sentVia:string, pushed:boolean, error?:string}>}
 */
export async function sendPaymentRequest(doc, { push = false, payerNumber = null } = {}) {
  const to = doc.phone;
  let via = "";
  try {
    await _templateWithButton(to, "zq_payment_request", [_forLine(doc), money(doc.amount), doc.reference], `zqp_pay_${doc.reference}`);
    via = "template";
  } catch (_) {}
  if (!via) {
    try { await _payCard(to, doc); via = "buttons"; } catch (_) {}
  }
  if (!via) {
    try {
      const { _sendTemplate } = await import("./buyerRequestNotifications.js");
      await _sendTemplate(to, "zqm_news_update", [`Payment request ${doc.reference}: ${_forLine(doc)} - ${money(doc.amount)}. Reply PAY to pay with EcoCash or OneMoney on your phone.`]);
      via = "news_template";
    } catch (_) {}
  }
  await ZqPayment.updateOne({ _id: doc._id }, { $set: { sentVia: via || "failed" } });
  let pushed = false, error;
  if (push) {
    const num = validMobile(payerNumber || to);
    if (!num) error = "Not an EcoCash/OneMoney number - request sent, customer can pay from WhatsApp";
    else {
      const r = await chargePayment(doc.reference, num, { silentStart: via === "" });
      pushed = r.ok; if (!r.ok) error = r.error;
    }
  }
  return { sentVia: via || "failed", pushed, error };
}

// ── The pay card ────────────────────────────────────────────────────────────
async function _payCard(from, doc) {
  const own = validMobile(from);
  const buttons = [];
  if (own) buttons.push({ id: `zqp_same_${doc.reference}`, title: `📱 Pay ${own}` });
  buttons.push({ id: `zqp_other_${doc.reference}`, title: own ? "✏️ Other number" : "📱 Enter number" });
  buttons.push({ id: `zqp_cancel_${doc.reference}`, title: "❌ Not now" });
  return sendButtons(from, {
    text:
`💳 *Payment request*

For: *${_forLine(doc)}*
Amount: *${money(doc.amount)}*
Reference: *${doc.reference}*

Pay with *EcoCash* or *OneMoney* - you'll get a PIN prompt on your phone. Nothing is taken until you enter your PIN.`,
    buttons
  });
}

/** Open the pay card for a reference (used by grocery checkout too). */
export async function startPay(from, reference) {
  const doc = await ZqPayment.findOne({ reference: String(reference).toUpperCase() }).lean();
  if (!doc) { await sendText(from, "❌ We couldn't find that payment. Type *menu* to continue."); return true; }
  if (doc.status === "paid") { await sendText(from, `✅ *${doc.reference}* is already paid (${money(doc.amount)}). Thank you!`); return true; }
  if (doc.status === "pending") {
    await sendButtons(from, {
      text: `⏳ We're waiting for the PIN on your phone for *${doc.reference}* (${money(doc.amount)}).\n\nDidn't get a prompt? Tap *Try again*.`,
      buttons: [{ id: `zqp_check_${doc.reference}`, title: "🔄 Check payment" }, { id: `zqp_other_${doc.reference}`, title: "🔁 Try again" }]
    });
    return true;
  }
  if (doc.status === "cancelled") await ZqPayment.updateOne({ _id: doc._id }, { $set: { status: "requested" } });
  await _setState(from, null);
  await _payCard(from, doc);
  return true;
}

// ═════════════════════════════════════════════════════════════════════════════
// CHARGE + POLL
// ═════════════════════════════════════════════════════════════════════════════
export async function chargePayment(reference, number, { silentStart = false } = {}) {
  const doc = await ZqPayment.findOne({ reference });
  if (!doc) return { ok: false, error: "Payment not found" };
  if (doc.status === "paid") return { ok: true, already: true };
  const local = validMobile(number);
  if (!local) return { ok: false, error: "Use an EcoCash (077/078) or OneMoney (071) number" };
  const client = await _paynow().catch(() => null);
  if (!client) {
    console.error("[ZQ PAY] Paynow not configured (services/paynow.js or PAYNOW_INTEGRATION_ID/KEY)");
    return { ok: false, error: "Online payments are not available right now" };
  }
  const method = _method(local);
  const attempt = (doc.attempts || 0) + 1;
  const paynowRef = `${doc.reference}-${attempt}`;
  let resp;
  try {
    const email = process.env.ZQ_PAYNOW_EMAIL || `payments+${local}@zimqoute.co.zw`;
    const payment = client.createPayment(paynowRef, email);
    payment.add(`ZimQuote ${_forLine(doc)}`.slice(0, 60), Number(doc.amount));
    resp = await client.sendMobile(payment, local, method);
  } catch (e) {
    console.error("[ZQ PAY] sendMobile", e.message);
  }
  if (!resp || !resp.success || !resp.pollUrl) {
    await ZqPayment.updateOne({ _id: doc._id }, { $set: { attempts: attempt, payerNumber: local, method } });
    return { ok: false, error: resp?.error || `Could not start the ${_methodName(method)} prompt` };
  }
  await ZqPayment.updateOne({ _id: doc._id }, {
    $set: { status: "pending", pollUrl: resp.pollUrl, paynowRef, payerNumber: local, method, attempts: attempt }
  });
  await _setState(doc.phone, { ref: doc.reference, stage: "waiting" });
  if (!silentStart) {
    try {
      await sendText(doc.phone,
`📲 *Check ${local}*

Enter your ${_methodName(method)} PIN to pay *${money(doc.amount)}* to *ZimQuote*.
Reference: *${doc.reference}*

We'll confirm here as soon as it goes through.`);
    } catch (_) {}
  }
  _poll(doc.reference, resp.pollUrl);
  ensureSweeper();
  return { ok: true, method, number: local };
}

const _polling = new Set();
function _poll(reference, pollUrl) {
  if (_polling.has(reference)) return;
  _polling.add(reference);
  let tries = 0;
  const timer = setInterval(async () => {
    tries++;
    try {
      const done = await checkPayment(reference, { quietPending: true, pollUrl });
      if (done !== "pending" || tries >= 18) {
        clearInterval(timer); _polling.delete(reference);
        if (done === "pending" && tries >= 18) await _expire(reference);
      }
    } catch (e) {
      if (tries >= 18) { clearInterval(timer); _polling.delete(reference); }
      console.warn("[ZQ PAY] poll", e.message);
    }
  }, 10000);
}

async function _expire(reference) {
  const doc = await ZqPayment.findOneAndUpdate({ reference, status: "pending" }, { $set: { status: "failed" } }, { new: true }).lean();
  if (!doc) return;
  await _setState(doc.phone, null);
  try {
    await sendButtons(doc.phone, {
      text: `⌛ We didn't receive the PIN for *${doc.reference}* (${money(doc.amount)}).\n\nNo money was taken. Tap *Pay again* when you're ready.`,
      buttons: [{ id: `zqp_pay_${doc.reference}`, title: "🔁 Pay again" }, { id: `zqp_check_${doc.reference}`, title: "🔄 I already paid" }]
    });
  } catch (_) {}
}

/** Poll Paynow once. Returns "paid" | "failed" | "pending" | "none". */
export async function checkPayment(reference, { quietPending = false, pollUrl = null } = {}) {
  const doc = await ZqPayment.findOne({ reference }).lean();
  if (!doc) return "none";
  if (doc.status === "paid") return "paid";
  const url = pollUrl || doc.pollUrl;
  if (!url) return doc.status === "pending" ? "pending" : "none";
  const client = await _paynow().catch(() => null);
  if (!client) return "pending";
  const st = await client.pollTransaction(url);
  const s = String(st?.status || "").toLowerCase();
  if (_isPaidStatus(s) || (typeof st?.paid === "function" && st.paid())) { await markPaymentPaid(reference, { method: doc.method }); return "paid"; }
  if (["cancelled", "failed", "disputed"].includes(s)) {
    const d = await ZqPayment.findOneAndUpdate({ reference, status: "pending" }, { $set: { status: s === "cancelled" ? "cancelled" : "failed" } }, { new: true }).lean();
    if (d) {
      await _setState(d.phone, null);
      try {
        await sendButtons(d.phone, {
          text: `❌ Payment *${d.reference}* was ${s === "cancelled" ? "cancelled" : "not completed"}. No money was taken.`,
          buttons: [{ id: `zqp_pay_${d.reference}`, title: "🔁 Pay again" }, { id: "main_menu_back", title: "🏠 Main Menu" }]
        });
      } catch (_) {}
    }
    return "failed";
  }
  return "pending";
}

/** Mark paid (Paynow, or admin "mark paid" for cash/bank). Idempotent. */
export async function markPaymentPaid(reference, { method = null, by = null } = {}) {
  const doc = await ZqPayment.findOneAndUpdate(
    { reference, status: { $ne: "paid" } },
    { $set: { status: "paid", paidAt: new Date(), ...(method ? { method } : {}), ...(by ? { note: `Marked paid by ${by}` } : {}) } },
    { new: true }
  ).lean();
  if (!doc) return false;
  await _setState(doc.phone, null).catch(() => {});
  const when = new Date().toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "Africa/Harare" });
  try {
    await sendText(doc.phone,
`✅ *Payment received - thank you!*

For: ${_forLine(doc)}
Amount: *${money(doc.amount)}*
Reference: *${doc.reference}*${doc.payerNumber ? `\nPaid from: ${doc.payerNumber}` : ""}
${when}

Keep this message as your receipt.`);
  } catch (_) {}
  _notifyAdmins(`💰 *Payment received* ${money(doc.amount)}\n${_forLine(doc)}\nRef: ${doc.reference}${doc.orderRef ? ` · Order ${doc.orderRef}` : ""}\nCustomer: ${localPhone(doc.phone)}${doc.payerNumber && doc.payerNumber !== localPhone(doc.phone) ? ` (paid from ${doc.payerNumber})` : ""}${by ? `\nMarked by ${by}` : ""}`).catch(() => {});
  if (doc.purpose === "grocery" && doc.orderRef) {
    try { const g = await import("./groceryBot.js"); await g.markGroceryPaid(doc.orderRef, { method: doc.method || method || "ecocash", reference: doc.reference }); }
    catch (e) { console.error("[ZQ PAY] grocery hook", e.message); }
  }
  console.log(`[ZQ PAY] PAID ${doc.reference} ${money(doc.amount)} ${doc.purpose}`);
  return true;
}

// ── Sweeper: re-check pending payments (survives restarts) ──────────────────
let _sweeper = null;
export function ensureSweeper() {
  if (_sweeper) return;
  _sweeper = setInterval(sweepPending, 2 * 60 * 1000);
  if (_sweeper.unref) _sweeper.unref();
}
export async function sweepPending() {
  try {
    const since = new Date(Date.now() - 6 * 60 * 60 * 1000);
    const list = await ZqPayment.find({ status: "pending", updatedAt: { $gte: since }, pollUrl: { $exists: true } }).limit(50).lean();
    for (const p of list) {
      if (_polling.has(p.reference)) continue;
      try {
        const r = await checkPayment(p.reference, { quietPending: true });
        if (r === "pending" && Date.now() - new Date(p.updatedAt).getTime() > 30 * 60 * 1000) {
          await ZqPayment.updateOne({ _id: p._id, status: "pending" }, { $set: { status: "failed" } });
        }
      } catch (_) {}
    }
  } catch (e) { console.warn("[ZQ PAY] sweep", e.message); }
}
setTimeout(() => { ensureSweeper(); sweepPending().catch(() => {}); }, 30 * 1000).unref?.();

// ═════════════════════════════════════════════════════════════════════════════
// CHATBOT ENTRY POINTS
// ═════════════════════════════════════════════════════════════════════════════
/** Button taps: zqp_* . Returns true when handled. */
export async function handlePayAction({ from, action }) {
  const a = String(action || "");
  const m = a.match(/^zqp_(pay|same|other|check|cancel)_(zqp-[a-z0-9]+)$/i);
  if (!m) return false;
  const kind = m[1].toLowerCase();
  const ref = m[2].toUpperCase();
  const doc = await ZqPayment.findOne({ reference: ref }).lean();
  if (!doc) { await sendText(from, "❌ That payment request has expired. Type *menu* to continue."); return true; }
  if (doc.status === "paid") { await sendText(from, `✅ *${ref}* is already paid. Thank you!`); return true; }

  if (kind === "pay") return startPay(from, ref);
  if (kind === "cancel") {
    if (doc.status !== "pending") await ZqPayment.updateOne({ _id: doc._id, status: { $in: ["requested", "failed"] } }, { $set: { status: "cancelled" } });
    await _setState(from, null);
    await sendButtons(from, {
      text: `👍 No problem. Your request *${ref}* (${money(doc.amount)}) is saved - type *PAY* any time to pay it.`,
      buttons: [{ id: "main_menu_back", title: "🏠 Main Menu" }]
    });
    return true;
  }
  if (kind === "check") {
    const r = await checkPayment(ref).catch(() => "pending");
    if (r === "paid") return true;   // receipt already sent
    if (r !== "failed") {
      await sendButtons(from, {
        text: `⏳ *${ref}* isn't showing as paid yet.\n\nIf you entered your PIN, give it a minute and check again.`,
        buttons: [{ id: `zqp_check_${ref}`, title: "🔄 Check again" }, { id: `zqp_pay_${ref}`, title: "🔁 Pay again" }]
      });
    }
    return true;
  }
  if (kind === "other") {
    await _setState(from, { ref, stage: "number" });
    await sendText(from, `📱 Type the *EcoCash* (077/078) or *OneMoney* (071) number to pay *${money(doc.amount)}* from, e.g. *0772123456*.\n\nType *cancel* to stop.`);
    return true;
  }
  // same
  const own = validMobile(from);
  if (!own) {
    await _setState(from, { ref, stage: "number" });
    await sendText(from, "📱 This WhatsApp number isn't an EcoCash/OneMoney line. Type the number to pay from, e.g. *0772123456*.");
    return true;
  }
  const r = await chargePayment(ref, own);
  if (!r.ok) await _chargeFailed(from, ref, r.error);
  return true;
}

async function _chargeFailed(from, ref, error) {
  await _setState(from, null);
  await sendButtons(from, {
    text: `❌ We couldn't start the payment${error ? ` - ${error}` : ""}.\n\nCheck the number has enough funds and try again.`,
    buttons: [{ id: `zqp_pay_${ref}`, title: "🔁 Try again" }, { id: `zqp_cancel_${ref}`, title: "❌ Not now" }]
  });
}

/**
 * Typed text: open pay states, the PAY keyword, and the admin pay/push command.
 * Returns true when handled.
 */
export async function handlePayText({ from, text }) {
  const t = String(text || "").trim();
  if (!t) return false;

  // ── Admin: pay|push <number> <amount> <what for> ─────────────────────────
  if (isAdminPhone(from)) {
    const am = t.match(/^(?:admin\s+)?(pay|push)\s+(\+?[\d][\d\s-]{8,15}\d)\s+\$?\s*(\d+(?:\.\d{1,2})?)\s+(.{2,100})$/i);
    if (am) {
      try {
        const purpose = _guessPurpose(am[4]);
        const doc = await createPaymentRequest({ phone: am[2], amount: am[3], purpose, description: am[4].trim(), requestedBy: `admin ${localPhone(from)}` });
        const r = await sendPaymentRequest(doc, { push: am[1].toLowerCase() === "push" });
        await sendText(from,
`✅ Payment request *${doc.reference}* sent to ${localPhone(doc.phone)}
For: ${doc.description} · *${money(doc.amount)}*
Delivered via: ${r.sentVia}${am[1].toLowerCase() === "push" ? `\nEcoCash prompt: ${r.pushed ? "sent ✅" : "not sent - " + (r.error || "")}` : ""}

You'll get a message when it's paid.`);
      } catch (e) {
        await sendText(from, `❌ ${e.message}\n\nFormat: *pay 0771234567 120 Company registration*\n(use *push* instead of *pay* to also send the EcoCash PIN prompt)`);
      }
      return true;
    }
    if (/^(?:admin\s+)?(pay|push)\s+\+?\d/i.test(t)) {
      await sendText(from, "💳 *Send a payment request*\n\n*pay 0771234567 120 Company registration*\n*push 0771234567 25 Email activation* (also sends the EcoCash PIN prompt)\n\nOr use /zq-admin/pay-requests");
      return true;
    }
  }

  const st = await _getState(from);
  if (st) {
    if (/^(cancel|stop|0|menu|main menu|hi|hie|hello)$/i.test(t)) {
      await _setState(from, null);
      if (/^(cancel|stop)$/i.test(t)) { await sendText(from, "👍 Payment stopped. Type *PAY* when you're ready."); return true; }
      return false;
    }
    if (st.stage === "number") {
      const num = validMobile(t);
      if (!num) { await sendText(from, "Please type a valid *EcoCash* (077/078) or *OneMoney* (071) number, e.g. *0772123456* - or type *cancel*."); return true; }
      const r = await chargePayment(st.ref, num);
      if (!r.ok) await _chargeFailed(from, st.ref, r.error);
      return true;
    }
    if (st.stage === "waiting" && /^(paid|done|i paid|check|status|ok)$/i.test(t)) {
      const r = await checkPayment(st.ref).catch(() => "pending");
      if (r === "pending") await sendButtons(from, {
        text: "⏳ Not showing as paid yet. If you entered your PIN, wait a minute and check again.",
        buttons: [{ id: `zqp_check_${st.ref}`, title: "🔄 Check again" }, { id: `zqp_pay_${st.ref}`, title: "🔁 Pay again" }]
      });
      return true;
    }
  }

  // ── PAY / pay ZQP-XXXXX ──────────────────────────────────────────────────
  const pm = t.match(/^pay(?:\s+now)?(?:\s+(zqp-[a-z0-9]{4,8}))?[.!]?$/i);
  if (pm) {
    const phone = intlPhone(from);
    const q = pm[1]
      ? { reference: pm[1].toUpperCase(), phone }
      : { phone, status: { $in: ["requested", "failed", "pending", "cancelled"] }, createdAt: { $gte: new Date(Date.now() - 45 * 86400000) } };
    const doc = await ZqPayment.findOne(q).sort({ createdAt: -1 }).lean();
    if (!doc) return false;     // nothing to pay → let other flows see "pay"
    return startPay(from, doc.reference);
  }
  return false;
}

function _guessPurpose(s) {
  const t = String(s || "").toLowerCase();
  if (/compan|registration|pbc|cr14|cr6|business name/.test(t)) return "company_registration";
  if (/e-?mail/.test(t)) return "email";
  if (/grocer|hamper|basket/.test(t)) return "grocery";
  if (/listing|subscription|plan|renew/.test(t)) return "listing";
  if (/website|web site|design|logo/.test(t)) return "website";
  if (/deliver|rider|parcel/.test(t)) return "delivery";
  return "other";
}

/** Paynow result URL (optional; polling + sweeper already cover it). */
export async function handleZqPaynowResult(body = {}) {
  try {
    const pref = String(body.reference || body.Reference || "");
    const ref = pref.replace(/-\d+$/, "");
    if (ref.startsWith("ZQP-")) await checkPayment(ref).catch(() => {});
  } catch (_) {}
}

export default { createPaymentRequest, sendPaymentRequest, startPay, chargePayment, checkPayment, markPaymentPaid, handlePayAction, handlePayText, PURPOSES, ZqPayment };
