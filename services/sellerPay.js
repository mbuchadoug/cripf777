// services/sellerPay.js
// ─── Pay a seller with EcoCash / OneMoney (Paynow), inside WhatsApp ──────────
//
// MONEY GOES STRAIGHT TO THE SELLER. Each seller connects THEIR OWN Paynow
// integration (Integration ID + Key from paynow.co.zw → Receive Payments →
// Integrations). ZimQuote never holds buyer money, so there is no settlement,
// escrow or payout risk for us.
//
// Seller:  Store menu → ⚙️ More Options → 💳 Accept EcoCash → paste ID → paste Key.
// Buyer:   after an order/quote, "💳 Pay Now" → confirm number → EcoCash PIN
//          prompt on their phone → both sides get a confirmation with a reference.
//
// Action ids (all start with zqpay_, whitelisted as meta actions in the engine):
//   zqpay_setup                 seller starts connecting Paynow
//   zqpay_disable               seller turns Pay Now off
//   zqpay_start_<sid>_<cents>   buyer starts paying seller <sid> (cents optional, 0 = ask)
//   zqpay_same                  buyer: use this WhatsApp number
//   zqpay_cancel                buyer/seller: stop
//
// Typed-reply states live in UserSession.tempData.zqPay / tempData.zqPaySetup.
//
// .env (optional): ZQ_SECRET=<long random string>  → seller keys stored encrypted.
// Optional Meta template (UTILITY) for alerting a seller outside 24h:
//   seller_payment_received:
//     Payment received on ZimQuote.
//     Business: {{1}}
//     Amount: {{2}}
//     From: {{3}}
//     Reference: {{4}}
//     This is an automated payment alert from ZimQuote.
// ─────────────────────────────────────────────────────────────────────────────

import mongoose from "mongoose";
import crypto from "crypto";
import { sendText, sendButtons } from "./metaSender.js";

const _phone = (p) => String(p || "").replace(/\D+/g, "");
const _disp = (p) => { const d = _phone(p); return d.startsWith("263") ? "0" + d.slice(3) : d; };
const _money = (n) => `$${Number(n || 0).toFixed(2)}`;

// ── Payment records ──────────────────────────────────────────────────────────
const sellerPaymentSchema = new mongoose.Schema({
  supplierId:  { type: mongoose.Schema.Types.ObjectId, ref: "SupplierProfile", index: true },
  sellerName:  String,
  buyerPhone:  { type: String, index: true },
  payerNumber: String,
  method:      { type: String, default: "ecocash" },
  amount:      Number,
  currency:    { type: String, default: "USD" },
  description: String,
  reference:   { type: String, unique: true },
  pollUrl:     String,
  status:      { type: String, enum: ["pending", "paid", "failed", "cancelled"], default: "pending", index: true },
  paidAt:      Date
}, { timestamps: true });
export const SellerPayment = mongoose.models.SellerPayment || mongoose.model("SellerPayment", sellerPaymentSchema);

// ── Key encryption (only when ZQ_SECRET is set) ─────────────────────────────
function _encKey(plain) {
  const secret = process.env.ZQ_SECRET;
  if (!secret) return plain;
  const iv = crypto.randomBytes(12);
  const k = crypto.createHash("sha256").update(secret).digest();
  const c = crypto.createCipheriv("aes-256-gcm", k, iv);
  const enc = Buffer.concat([c.update(String(plain), "utf8"), c.final()]);
  return "enc:" + Buffer.concat([iv, c.getAuthTag(), enc]).toString("base64");
}
function _decKey(stored) {
  if (!stored || !String(stored).startsWith("enc:")) return stored;
  const secret = process.env.ZQ_SECRET;
  if (!secret) return null;
  const raw = Buffer.from(String(stored).slice(4), "base64");
  const k = crypto.createHash("sha256").update(secret).digest();
  const d = crypto.createDecipheriv("aes-256-gcm", k, raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString("utf8");
}

async function _Paynow() {
  const mod = await import("paynow");
  return mod.Paynow || mod.default?.Paynow || mod.default;
}
async function _sellerClient(seller) {
  const p = seller?.payments || {};
  const key = _decKey(p.paynowIntegrationKey);
  if (!p.paynowEnabled || !p.paynowIntegrationId || !key) return null;
  const Paynow = await _Paynow();
  const client = new Paynow(String(p.paynowIntegrationId), String(key));
  const site = (process.env.SITE_URL || "https://zimqoute.co.zw").replace(/\/$/, "");
  client.resultUrl = `${site}/paynow/seller-result`;
  client.returnUrl = `${site}/`;
  return client;
}

export function sellerAcceptsPaynow(seller) {
  const p = seller?.payments || {};
  return !!(p.paynowEnabled && p.paynowIntegrationId && p.paynowIntegrationKey);
}

/** Button to add to an order/quote confirmation (null when seller isn't set up). */
export function payNowButton(seller, amount = 0) {
  if (!sellerAcceptsPaynow(seller)) return null;
  const cents = Math.max(0, Math.round(Number(amount || 0) * 100));
  return { id: `zqpay_start_${seller._id}_${cents}`, title: "💳 Pay Now" };
}

async function _session() { return (await import("../models/userSession.js")).default; }
async function _setState(from, key, val) {
  const US = await _session();
  if (val === null) await US.updateOne({ phone: _phone(from) }, { $unset: { [`tempData.${key}`]: "" } });
  else await US.findOneAndUpdate({ phone: _phone(from) }, { $set: { [`tempData.${key}`]: { ...val, at: new Date() } } }, { upsert: true });
}
async function _getState(from) {
  const US = await _session();
  const s = await US.findOne({ phone: _phone(from) }, { tempData: 1 }).lean();
  return { pay: s?.tempData?.zqPay || null, setup: s?.tempData?.zqPaySetup || null };
}
async function _Supplier() { return (await import("../models/supplierProfile.js")).default; }

// 071 = NetOne OneMoney, 077/078 = Econet EcoCash
function _method(num) {
  const d = _phone(num).replace(/^263/, "0");
  return d.startsWith("071") ? "onemoney" : "ecocash";
}
function _validMobile(num) {
  let d = _phone(num);
  if (d.startsWith("263")) d = "0" + d.slice(3);
  return /^07[178]\d{7}$/.test(d) ? d : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// ACTIONS (taps)
// ─────────────────────────────────────────────────────────────────────────────
export async function handleSellerPayAction({ from, action }) {
  const a = String(action || "");
  if (!a.startsWith("zqpay_")) return false;
  const SP = await _Supplier();

  if (a === "zqpay_cancel") {
    await _setState(from, "zqPay", null);
    await _setState(from, "zqPaySetup", null);
    await sendText(from, "Okay, cancelled. Type *menu* to continue.");
    return true;
  }

  // ── Seller: connect Paynow ────────────────────────────────────────────────
  if (a === "zqpay_setup") {
    const seller = await SP.findOne({ phone: _phone(from) }).lean();
    if (!seller) { await sendText(from, "This option is for sellers on ZimQuote. Type *menu* to continue."); return true; }
    if (sellerAcceptsPaynow(seller)) {
      await sendButtons(from, {
        text: `💳 *EcoCash payments are ON* for ${seller.businessName}.\n\nBuyers see *Pay Now* after ordering, and the money goes straight into your Paynow account.`,
        buttons: [
          { id: "zqpay_setup_redo", title: "🔁 Change Keys" },
          { id: "zqpay_disable",    title: "⛔ Turn Off" },
          { id: "my_supplier_account", title: "⬅ My Store" }
        ]
      });
      return true;
    }
    return _startSetup(from, seller);
  }
  if (a === "zqpay_setup_redo") {
    const seller = await SP.findOne({ phone: _phone(from) }).lean();
    if (!seller) return true;
    return _startSetup(from, seller);
  }
  if (a === "zqpay_disable") {
    await SP.updateOne({ phone: _phone(from) }, { $set: { "payments.paynowEnabled": false } });
    await sendText(from, "⛔ Pay Now is off. Buyers will arrange payment with you directly. You can turn it on again any time.");
    return true;
  }

  // ── Buyer: pay a seller ───────────────────────────────────────────────────
  if (a.startsWith("zqpay_start_")) {
    const [sid, centsRaw] = a.replace("zqpay_start_", "").split("_");
    const seller = await SP.findById(sid).lean().catch(() => null);
    if (!seller || !sellerAcceptsPaynow(seller)) {
      await sendText(from, "This seller isn't taking online payments yet - please pay them directly.");
      return true;
    }
    const amount = (parseInt(centsRaw, 10) || 0) / 100;
    if (amount > 0) {
      await _setState(from, "zqPay", { stage: "number", sid, amount });
      await _askNumber(from, seller, amount);
    } else {
      await _setState(from, "zqPay", { stage: "amount", sid });
      await sendButtons(from, {
        text: `💳 *Pay ${seller.businessName}*\n\nHow much are you paying (USD)?\n_Type the amount, e.g. 25 or 12.50_`,
        buttons: [{ id: "zqpay_cancel", title: "❌ Cancel" }]
      });
    }
    return true;
  }
  if (a === "zqpay_same") {
    const { pay } = await _getState(from);
    if (!pay || pay.stage !== "number") return false;
    return _charge(from, pay, _phone(from));
  }
  return false;
}

async function _startSetup(from, seller) {
  await _setState(from, "zqPaySetup", { stage: "id", sid: String(seller._id) });
  await sendButtons(from, {
    text:
`💳 *Accept EcoCash & OneMoney on ZimQuote*

Buyers pay you inside WhatsApp and the money goes *straight to your Paynow account* - ZimQuote never touches it.

*You need a Paynow account* (paynow.co.zw). In Paynow open *Receive Payments → Integrations*, create one, then:

*Step 1:* paste your *Integration ID* here.`,
    buttons: [{ id: "zqpay_cancel", title: "❌ Cancel" }]
  });
  return true;
}

async function _askNumber(from, seller, amount) {
  return sendButtons(from, {
    text:
`💳 *Pay ${seller.businessName}*
Amount: *${_money(amount)}*

Which number pays? Tap below to use *${_disp(from)}*, or type another EcoCash / OneMoney number.`,
    buttons: [
      { id: "zqpay_same",   title: "✅ Use this number" },
      { id: "zqpay_cancel", title: "❌ Cancel" }
    ]
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// TYPED REPLIES
// ─────────────────────────────────────────────────────────────────────────────
export async function handleSellerPayText({ from, text }) {
  const t = String(text || "").trim();
  if (!t) return false;
  const { pay, setup } = await _getState(from);
  const fresh = (s) => s && s.at && Date.now() - new Date(s.at).getTime() < 30 * 60 * 1000;

  if (/^(cancel|stop|exit|0|menu)$/i.test(t) && (fresh(pay) || fresh(setup))) {
    await _setState(from, "zqPay", null);
    await _setState(from, "zqPaySetup", null);
    if (/^(0|menu)$/i.test(t)) return false;           // let the menu open
    await sendText(from, "Okay, cancelled.");
    return true;
  }

  // ── Seller setup ──────────────────────────────────────────────────────────
  if (fresh(setup)) {
    const SP = await _Supplier();
    if (setup.stage === "id") {
      if (!/^\d{3,8}$/.test(t)) { await sendText(from, "The Integration ID is a number, e.g. *12345*. Please paste it, or type *cancel*."); return true; }
      await _setState(from, "zqPaySetup", { ...setup, stage: "key", integrationId: t });
      await sendText(from, "*Step 2:* now paste your *Integration Key* (the long code next to the ID).\n\n_Tip: delete the message with the key from this chat afterwards._");
      return true;
    }
    if (setup.stage === "key") {
      if (!/^[A-Za-z0-9-]{20,64}$/.test(t)) { await sendText(from, "That doesn't look like a Paynow Integration Key (a long code of letters and numbers). Please paste it again, or type *cancel*."); return true; }
      await SP.updateOne({ _id: setup.sid }, { $set: {
        "payments.paynowEnabled": true,
        "payments.paynowIntegrationId": setup.integrationId,
        "payments.paynowIntegrationKey": _encKey(t),
        "payments.connectedAt": new Date()
      } });
      await _setState(from, "zqPaySetup", null);
      await sendButtons(from, {
        text:
`✅ *EcoCash payments are ON*

Buyers will now see *💳 Pay Now* after they order or accept your quote. Money goes straight to your Paynow account, and you get a WhatsApp alert with the reference each time.

_Do a test: ask a friend to order something small and pay._`,
        buttons: [{ id: "my_supplier_account", title: "🏪 My Store" }]
      });
      return true;
    }
  }

  // ── Buyer paying ──────────────────────────────────────────────────────────
  if (fresh(pay)) {
    if (pay.stage === "amount") {
      const amt = Number(t.replace(/[$,\s]|usd/gi, ""));
      if (!(amt > 0 && amt < 100000)) { await sendText(from, "Please type the amount as a number, e.g. *25* or *12.50*."); return true; }
      const SP = await _Supplier();
      const seller = await SP.findById(pay.sid).lean();
      if (!seller) { await _setState(from, "zqPay", null); return false; }
      await _setState(from, "zqPay", { ...pay, stage: "number", amount: Math.round(amt * 100) / 100 });
      await _askNumber(from, seller, amt);
      return true;
    }
    if (pay.stage === "number") {
      const num = _validMobile(t);
      if (!num) { await sendText(from, "Please type a valid EcoCash or OneMoney number, e.g. *0772123456*, or type *cancel*."); return true; }
      return _charge(from, pay, num);
    }
    if (pay.stage === "waiting") {
      await sendText(from, "⏳ Still waiting for your PIN confirmation on your phone. If you didn't get the prompt, type *cancel* and try again.");
      return true;
    }
  }
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// CHARGE + POLL
// ─────────────────────────────────────────────────────────────────────────────
async function _charge(from, pay, number) {
  const SP = await _Supplier();
  const seller = await SP.findById(pay.sid).lean();
  const client = await _sellerClient(seller).catch(e => { console.error("[SELLER PAY] client", e.message); return null; });
  if (!seller || !client) {
    await _setState(from, "zqPay", null);
    await sendText(from, "❌ This seller's online payments aren't working right now. Please pay them directly.");
    return true;
  }

  const local = _validMobile(number);
  const method = _method(local);
  const reference = `ZQ${String(seller._id).slice(-4).toUpperCase()}${Date.now().toString(36).toUpperCase()}`;
  const description = `ZimQuote order - ${seller.businessName}`.slice(0, 60);

  let resp;
  try {
    const payment = client.createPayment(reference, seller.payments?.paynowEmail || process.env.ZQ_PAYNOW_EMAIL || "payments@zimqoute.co.zw");
    payment.add(description, Number(pay.amount));
    resp = await client.sendMobile(payment, local, method);
  } catch (e) {
    console.error("[SELLER PAY] sendMobile", e.message);
  }
  if (!resp || !resp.success || !resp.pollUrl) {
    await sendButtons(from, {
      text: `❌ We couldn't start the ${method === "onemoney" ? "OneMoney" : "EcoCash"} payment${resp?.error ? ` (${resp.error})` : ""}.\n\nCheck the number has enough funds and try again, or type another number.`,
      buttons: [{ id: "zqpay_same", title: "🔁 Try Again" }, { id: "zqpay_cancel", title: "❌ Cancel" }]
    });
    return true;
  }

  await SellerPayment.create({
    supplierId: seller._id, sellerName: seller.businessName, buyerPhone: _phone(from),
    payerNumber: local, method, amount: pay.amount, description, reference, pollUrl: resp.pollUrl
  });
  await _setState(from, "zqPay", { ...pay, stage: "waiting", reference });
  await sendText(from,
`📲 *Check your phone*

Enter your ${method === "onemoney" ? "OneMoney" : "EcoCash"} PIN to pay *${_money(pay.amount)}* to *${seller.businessName}*.
Reference: *${reference}*

We'll confirm here as soon as it goes through.`);

  _poll({ from, seller, client, reference, pollUrl: resp.pollUrl, amount: pay.amount, payer: local });
  return true;
}

function _poll({ from, seller, client, reference, pollUrl, amount, payer }) {
  let tries = 0;
  const timer = setInterval(async () => {
    tries++;
    try {
      const st = await client.pollTransaction(pollUrl);
      const s = String(st?.status || "").toLowerCase();
      if (s === "paid" || s === "awaiting delivery" || s === "delivered") {
        clearInterval(timer);
        await _onPaid({ from, seller, reference, amount, payer });
      } else if (["cancelled", "failed", "disputed"].includes(s) || tries >= 18) {
        clearInterval(timer);
        await SellerPayment.updateOne({ reference, status: "pending" }, { $set: { status: s === "cancelled" ? "cancelled" : "failed" } });
        await _setState(from, "zqPay", null);
        await sendButtons(from, {
          text: `❌ Payment *${reference}* was not completed${tries >= 18 ? " (no PIN entered in time)" : ""}.\n\nNo money was taken. You can try again.`,
          buttons: [{ id: `zqpay_start_${seller._id}_${Math.round(amount * 100)}`, title: "🔁 Pay Again" }, { id: "zqpay_cancel", title: "❌ Not Now" }]
        });
      }
    } catch (e) {
      if (tries >= 18) clearInterval(timer);
      console.warn("[SELLER PAY] poll", e.message);
    }
  }, 10000);
}

async function _onPaid({ from, seller, reference, amount, payer }) {
  const rec = await SellerPayment.findOneAndUpdate(
    { reference, status: { $ne: "paid" } },
    { $set: { status: "paid", paidAt: new Date() } },
    { new: true }
  );
  if (!rec) return; // already handled
  await _setState(from, "zqPay", null);

  await sendText(from,
`✅ *Payment successful*

Paid: *${_money(amount)}*
To: *${seller.businessName}*
Reference: *${reference}*
${new Date().toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}

Keep this message as your proof of payment. ${seller.businessName} has been notified.`);

  // Seller alert: approved template if available (reaches them outside 24h), else text
  const phones = [...new Set([seller.phone, ...(seller.notificationContacts || [])].map(_phone).filter(Boolean))];
  for (const p of phones) {
    let ok = false;
    try {
      const { _sendTemplate } = await import("./buyerRequestNotifications.js");
      await _sendTemplate(p, "seller_payment_received", [seller.businessName, _money(amount), _disp(payer), reference]);
      ok = true;
    } catch (_) {}
    if (!ok) {
      try {
        await sendText(p,
`💰 *Payment received on ZimQuote*

${_money(amount)} from ${_disp(payer)}
Reference: *${reference}*

It's in your Paynow account. Please fulfil the order and contact the buyer: ${_disp(from)}`);
      } catch (_) {}
    }
  }
}

/** Paynow result URL (optional, extra safety on top of polling). */
export async function handlePaynowSellerResult(body = {}) {
  try {
    const reference = body.reference || body.Reference;
    const status = String(body.status || body.Status || "").toLowerCase();
    if (!reference || status !== "paid") return;
    const rec = await SellerPayment.findOne({ reference }).lean();
    if (!rec || rec.status === "paid") return;
    const SP = await _Supplier();
    const seller = await SP.findById(rec.supplierId).lean();
    if (seller) await _onPaid({ from: rec.buyerPhone, seller, reference, amount: rec.amount, payer: rec.payerNumber });
  } catch (e) { console.warn("[SELLER PAY RESULT]", e.message); }
}
