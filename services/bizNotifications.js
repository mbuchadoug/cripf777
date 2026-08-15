/**
 * bizNotifications.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Real-time WhatsApp transaction notification engine.
 *
 * Fans every business event (invoice / quote / receipt, payment, expense,
 * payout, opening balance, daily summary) out to EVERY owner + manager + admin
 * of the business, plus the clerk who recorded it. Delivery is guaranteed even
 * when a recipient is OUTSIDE the 24-hour WhatsApp session window.
 *
 * ── HOW DELIVERY WORKS (the 24-hour window) ──────────────────────────────────
 * WhatsApp Cloud API rules:
 *   • type:"text"      → only delivers if the recipient messaged the number in
 *                        the last 24h. Outside that, Meta rejects the send
 *                        (error 131047 "re-engagement", sometimes 131026).
 *   • type:"template"  → delivers ANY time, no session needed, but the template
 *                        must be pre-approved by Meta (1-3 days).
 *
 * So: we try the rich free-text message first (nice formatting, works in-window),
 * and if Meta rejects it because the window is closed we automatically fall back
 * to ONE approved utility template that carries the same information. One
 * recipient may get the pretty text; another (dormant) owner gets the template.
 * Both are notified.
 *
 * ── THE ONE TEMPLATE YOU MUST SUBMIT ONCE ────────────────────────────────────
 *   Meta Business Suite → WhatsApp → Message Templates → Create template
 *     Name:      biz_transaction_alert
 *     Category:  UTILITY
 *     Language:  English (en)
 *     Body:
 *       ─────────────────────────────────────────────
 *       🔔 {{1}}
 *
 *       {{2}}
 *
 *       💰 {{3}}
 *
 *       Reply *menu* to open ZimQuote.
 *       ─────────────────────────────────────────────
 *     Sample values (Meta asks for these on submit):
 *       {{1}}  New Receipt — Mudziyashe (Main Branch)
 *       {{2}}  Ref RCPT-000002 · Client pick n pay · Amount $30.00 · By 263771446827 · 15 Aug 2026 18:08
 *       {{3}}  Cash at hand: $50.00
 *
 *   Why one template with 3 short variables (not one big blob): Meta REJECTS a
 *   send whose parameter contains newlines, tabs, or 4+ consecutive spaces. So
 *   the line breaks live in the fixed template body, and every variable we pass
 *   is a single sanitised line. _sanitizeParam() below enforces that.
 *
 *   The body never starts or ends with a variable (Meta approves those faster),
 *   and it reads as a transactional account alert (UTILITY), which is exactly
 *   what it is.
 *
 * WHERE THIS FILE LIVES:
 *   /var/www/cripf777/services/bizNotifications.js
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { sendText } from "./metaSender.js";
import axios from "axios";

// The single Meta template every out-of-window alert falls back to.
const UNIVERSAL_TEMPLATE = "biz_transaction_alert";

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmt(amount, currency = "USD") {
  const sym = currency === "USD" ? "$" : (currency || "$");
  return `${sym}${Number(amount || 0).toFixed(2)}`;
}

function timeNow() {
  return new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

function dateNow() {
  return new Date().toLocaleDateString("en-GB", {
    day: "numeric", month: "short", year: "numeric"
  });
}

/** Combined "HH:MM on DD Mon YYYY" string. */
function timeDateNow() {
  return `${timeNow()} on ${dateNow()}`;
}

/** Normalise a phone to digits only (for dedup + Meta). */
function normPhone(p) {
  return String(p || "").replace(/\D+/g, "");
}

/**
 * Make a string safe to pass as a WhatsApp TEMPLATE parameter.
 * Meta rejects parameters that contain newline characters, tab characters, or
 * more than 4 consecutive spaces - so we flatten newlines/tabs into " · ",
 * strip WhatsApp markdown, collapse whitespace, and cap length well under the
 * 1024-char limit. Never returns empty (Meta also rejects blank params).
 */
function _sanitizeParam(text) {
  let t = String(text == null ? "" : text);
  t = t.replace(/[*_~`]/g, "");          // drop markdown so it reads clean
  t = t.replace(/[\r\n\t]+/g, " · ");    // no newlines / tabs allowed in params
  t = t.replace(/ {2,}/g, " ");          // collapse runs of spaces (>4 is illegal)
  t = t.replace(/(?: · )+/g, " · ");     // tidy doubled separators
  t = t.replace(/^(?: · )+|(?: · )+$/g, ""); // trim leading/trailing separators
  t = t.trim();
  if (t.length > 1000) t = t.slice(0, 997) + "...";
  return t.length ? t : "-";
}

/**
 * POST the universal utility template. Works with no active session.
 * @param {string} phone
 * @param {{title:string, details:string, balance:string}} u
 */
async function _postUniversalTemplate(phone, u) {
  const PHONE_ID = process.env.WHATSAPP_PHONE_NUMBER_ID ||
                   process.env.META_PHONE_NUMBER_ID     ||
                   process.env.PHONE_NUMBER_ID;
  const TOKEN    = process.env.META_ACCESS_TOKEN || process.env.WHATSAPP_ACCESS_TOKEN;

  const params = [
    { type: "text", text: _sanitizeParam(u.title)   },
    { type: "text", text: _sanitizeParam(u.details) },
    { type: "text", text: _sanitizeParam(u.balance) }
  ];

  await axios.post(
    `https://graph.facebook.com/v24.0/${PHONE_ID}/messages`,
    {
      messaging_product: "whatsapp",
      to:   normPhone(phone),
      type: "template",
      template: {
        name:     UNIVERSAL_TEMPLATE,
        language: { code: "en" },
        components: [{ type: "body", parameters: params }]
      }
    },
    { headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" } }
  );
}

/**
 * _safeNotify: send the rich free-text message; if the recipient is outside the
 * 24-hour window (Meta rejects it) fall back to the approved utility template.
 *
 * @param {string} phone
 * @param {string} message  - rich text (used inside the 24h window)
 * @param {{title,details,balance}} [universal] - data for the template fallback
 */
async function _safeNotify(phone, message, universal = null) {
  try {
    await sendText(phone, message);
  } catch (err) {
    const code   = Number(err?.response?.data?.error?.code);
    const detail = err?.response?.data?.error?.message || err?.message || "";

    // Meta "please re-engage / outside the 24h window / undeliverable" family.
    const windowish =
      [131047, 131026, 470, 131051, 132000].includes(code) ||
      /24 ?hours|re-?engag|outside|session|window|not .*open|allowed window/i.test(String(detail));

    if (universal && windowish) {
      try {
        await _postUniversalTemplate(phone, universal);
        console.log(`[BIZ_NOTIF] Template fallback delivered to ${phone} (code ${code || "n/a"})`);
      } catch (tplErr) {
        const tdetail = tplErr?.response?.data?.error?.message || tplErr.message;
        console.error(`[BIZ_NOTIF] Template fallback FAILED for ${phone}: ${tdetail}` +
                      ` — is "${UNIVERSAL_TEMPLATE}" approved on Meta?`);
      }
    } else {
      console.error(`[BIZ_NOTIF] Could not notify ${phone}: ${detail}`);
    }
  }
}

// ── Recipients ────────────────────────────────────────────────────────────────

/**
 * Every phone that should receive notifications for a business.
 * = owners + managers + admins + the founding owner (biz.providerId, passed in
 *   via extraPhones) + the clerk who recorded the transaction. Deduplicated and
 *   normalised to digits.
 */
export async function getNotificationRecipients(businessId, clerkPhone = null, extraPhones = []) {
  const UserRole = (await import("../models/userRole.js")).default;
  const roles = await UserRole.find({ businessId, pending: false }).lean();

  const owners   = roles.filter(r => r.role === "owner")
                        .map(r => normPhone(r.phone)).filter(Boolean);
  const managers = roles.filter(r => r.role === "manager" || r.role === "admin")
                        .map(r => normPhone(r.phone)).filter(Boolean);

  const extras = (Array.isArray(extraPhones) ? extraPhones : [extraPhones])
                   .map(normPhone).filter(Boolean);
  const clerk  = clerkPhone ? [normPhone(clerkPhone)] : [];

  // Owners + founding owner first; then managers; then the recording clerk.
  const allSet = [...new Set([...owners, ...extras, ...managers, ...clerk])];
  return { owners, managers, allSet };
}

/**
 * Today's running cash balance for a branch (or whole business if no branchId).
 */
export async function getDailyRunningBalance(businessId, branchId, currency = "USD") {
  const [InvoicePayment, Invoice, Expense, CashPayout] = await Promise.all([
    import("../models/invoicePayment.js").then(m => m.default),
    import("../models/invoice.js").then(m => m.default),
    import("../models/expense.js").then(m => m.default),
    import("../models/cashPayout.js").then(m => m.default).catch(() => null)
  ]);

  const today    = new Date(); today.setHours(0, 0, 0, 0);
  const tomorrow = new Date(today); tomorrow.setDate(tomorrow.getDate() + 1);

  const base   = { businessId, ...(branchId ? { branchId } : {}) };
  const todayQ = { ...base, createdAt: { $gte: today, $lt: tomorrow } };
  const beforeQ = { ...base, createdAt: { $lt: today } };

  // True carry-forward opening = everything collected minus spent before today.
  const [pmtsBefore, rcptsBefore, expsBefore, payoutsBefore,
         payments, receipts, expenses, payouts] = await Promise.all([
    InvoicePayment.aggregate([{ $match: beforeQ }, { $group: { _id: null, t: { $sum: "$amount" } } }]).catch(() => []),
    Invoice.aggregate([{ $match: { ...beforeQ, type: "receipt" } }, { $group: { _id: null, t: { $sum: "$total" } } }]).catch(() => []),
    Expense.aggregate([{ $match: beforeQ }, { $group: { _id: null, t: { $sum: "$amount" } } }]).catch(() => []),
    CashPayout ? CashPayout.aggregate([{ $match: beforeQ }, { $group: { _id: null, t: { $sum: "$amount" } } }]).catch(() => []) : [],
    InvoicePayment.find(todayQ).lean().catch(() => []),
    Invoice.find({ ...todayQ, type: "receipt" }).lean().catch(() => []),
    Expense.find(todayQ).lean().catch(() => []),
    CashPayout ? CashPayout.find({ ...base, createdAt: { $gte: today, $lt: tomorrow } }).lean().catch(() => []) : []
  ]);

  const opening = (pmtsBefore[0]?.t || 0) + (rcptsBefore[0]?.t || 0)
                - (expsBefore[0]?.t  || 0) - (payoutsBefore[0]?.t || 0);

  const cashIn  = payments.reduce((s, p) => s + (p.amount || 0), 0) +
                  receipts.reduce((s, r) => s + (r.total  || 0), 0);
  const cashOut = expenses.reduce((s, e) => s + (e.amount || 0), 0) +
                  payouts.reduce((s,  p) => s + (p.amount || 0), 0);

  return { opening, cashIn, cashOut, closing: opening + cashIn - cashOut, currency };
}

/** Append a "💰 Cash at hand" line to notifications.
 *  With clerkPhone → that clerk's personal custody balance; else business-wide.
 */
async function _balanceLine(biz, branchId, clerkPhone = null) {
  try {
    if (clerkPhone) {
      const { fetchClerkCumulativeBalance } = await import("./dailyReportEnhanced.js");
      const custody = await fetchClerkCumulativeBalance({ biz, clerkPhone, branchId, before: new Date(), inclusive: true });
      return `\n💰 *Cash at hand: ${fmt(custody, biz.currency)}*  (your current custody)`;
    }
    const b = await getDailyRunningBalance(biz._id, branchId, biz.currency);
    return `\n💰 *Cash at hand: ${fmt(b.closing, biz.currency)}*` +
           `  (In: +${fmt(b.cashIn, biz.currency)} | Out: -${fmt(b.cashOut, biz.currency)})`;
  } catch (_) { return ""; }
}

/** Turn the "\n💰 *Cash at hand: ...*" line into a clean single-line template var. */
function _balanceParam(bal) {
  const clean = String(bal || "")
    .replace(/[*_~`]/g, "")
    .replace(/💰/g, "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/ {2,}/g, " ")
    .trim();
  return clean || "Cash at hand: -";
}

/** Fire-and-forget to every recipient (owners + founding owner + managers + clerk). */
async function _dispatch(biz, clerkPhone, message, universal = null) {
  try {
    const { allSet } = await getNotificationRecipients(biz._id, clerkPhone, [biz.providerId]);
    await Promise.all(allSet.map(p => _safeNotify(p, message, universal)));
  } catch (err) {
    console.error("[BIZ_NOTIF] dispatch error:", err.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC API  (signatures unchanged — call sites in twilioStateBridge.js keep working)
// ─────────────────────────────────────────────────────────────────────────────

/** Invoice / Quote / Receipt created */
export async function notifyDocumentCreated({
  biz, doc, docType, clerkPhone, branchName, branchId
}) {
  const emoji  = { invoice: "📄", quote: "📋", receipt: "🧾" }[docType] || "📄";
  const label  = docType.charAt(0).toUpperCase() + docType.slice(1);
  const bal    = await _balanceLine(biz, branchId, clerkPhone);
  const branch = branchName ? `\n  🏬 Branch: ${branchName}` : "";
  const clerk  = clerkPhone ? `\n  👤 By: ${clerkPhone}` : "";

  const message =
`${emoji} *New ${label} - ${biz.name}*
📅 ${dateNow()} at ${timeNow()}${branch}${clerk}

  🔢 Ref: *${doc.number || "-"}*
  👥 Client: ${doc.clientName || "Walk-in"}
  💵 Amount: *${fmt(doc.total, biz.currency)}*${bal}`;

  const universal = {
    title:   `New ${label} — ${biz.name}${branchName ? ` (${branchName})` : ""}`,
    details: `Ref ${doc.number || "-"} · Client ${doc.clientName || "Walk-in"} · ` +
             `Amount ${fmt(doc.total, biz.currency)} · By ${clerkPhone || "-"} · ${timeDateNow()}`,
    balance: _balanceParam(bal)
  };

  await _dispatch(biz, clerkPhone, message, universal);
}

/** Payment received on an invoice */
export async function notifyPaymentRecorded({
  biz, payment, invoiceNumber, clientName, clerkPhone, branchName, branchId
}) {
  const bal    = await _balanceLine(biz, branchId, clerkPhone);
  const branch = branchName ? `\n  🏬 Branch: ${branchName}` : "";
  const clerk  = clerkPhone ? `\n  👤 By: ${clerkPhone}` : "";

  const message =
`💳 *Payment Received - ${biz.name}*
📅 ${dateNow()} at ${timeNow()}${branch}${clerk}

  📄 Invoice: *${invoiceNumber || "-"}*
  👥 Client: ${clientName || "-"}
  💵 Amount: *${fmt(payment.amount, biz.currency)}*
  💳 Method: ${payment.method || "Cash"}${bal}`;

  const universal = {
    title:   `Payment Received — ${biz.name}${branchName ? ` (${branchName})` : ""}`,
    details: `Invoice ${invoiceNumber || "-"} · Client ${clientName || "-"} · ` +
             `Amount ${fmt(payment.amount, biz.currency)} · ${payment.method || "Cash"} · ` +
             `By ${clerkPhone || "-"} · ${timeDateNow()}`,
    balance: _balanceParam(bal)
  };

  await _dispatch(biz, clerkPhone, message, universal);
}

/** One or more expenses recorded */
export async function notifyExpensesRecorded({
  biz, expenses, clerkPhone, branchName, branchId
}) {
  const total  = expenses.reduce((s, e) => s + (e.amount || 0), 0);
  const bal    = await _balanceLine(biz, branchId, clerkPhone);
  const branch = branchName ? `\n  🏬 Branch: ${branchName}` : "";
  const clerk  = clerkPhone ? `\n  👤 By: ${clerkPhone}` : "";
  const lines  = expenses
    .map(e => `  • ${e.description} - ${fmt(e.amount, biz.currency)} (${e.category || "Other"})`)
    .join("\n");
  const itemsFlat = expenses
    .map(e => `${e.description} ${fmt(e.amount, biz.currency)}`)
    .join(", ");

  const message =
`💸 *Expenses Recorded - ${biz.name}*
📅 ${dateNow()} at ${timeNow()}${branch}${clerk}

${lines}
  ──────────────
  💵 Total out: *${fmt(total, biz.currency)}*${bal}`;

  const universal = {
    title:   `Expenses Recorded — ${biz.name}${branchName ? ` (${branchName})` : ""}`,
    details: `${itemsFlat} · Total ${fmt(total, biz.currency)} · By ${clerkPhone || "-"} · ${timeDateNow()}`,
    balance: _balanceParam(bal)
  };

  await _dispatch(biz, clerkPhone, message, universal);
}

/** Cash payout / drawing recorded */
export async function notifyPayoutRecorded({
  biz, payout, clerkPhone, branchName, branchId
}) {
  const bal    = await _balanceLine(biz, branchId, clerkPhone);
  const branch = branchName ? `\n  🏬 Branch: ${branchName}` : "";
  const clerk  = clerkPhone ? `\n  👤 By: ${clerkPhone}` : "";

  const message =
`📤 *Cash Payout - ${biz.name}*
📅 ${dateNow()} at ${timeNow()}${branch}${clerk}

  💵 Amount: *${fmt(payout.amount, biz.currency)}*
  📝 Reason: ${payout.reason || "-"}${bal}`;

  const universal = {
    title:   `Cash Payout — ${biz.name}${branchName ? ` (${branchName})` : ""}`,
    details: `Amount ${fmt(payout.amount, biz.currency)} · Reason ${payout.reason || "-"} · ` +
             `By ${clerkPhone || "-"} · ${timeDateNow()}`,
    balance: _balanceParam(bal)
  };

  await _dispatch(biz, clerkPhone, message, universal);
}

/** Opening balance set for the day */
export async function notifyOpeningBalanceSet({
  biz, amount, clerkPhone, branchName, branchId
}) {
  const branch = branchName ? `\n  🏬 Branch: ${branchName}` : "";
  const clerk  = clerkPhone ? `\n  👤 By: ${clerkPhone}` : "";

  const message =
`🔓 *Opening Balance Set - ${biz.name}*
📅 ${dateNow()} at ${timeNow()}${branch}${clerk}

  💰 Opening: *${fmt(amount, biz.currency)}*
  _Cash tracking started for today._`;

  const universal = {
    title:   `Opening Balance Set — ${biz.name}${branchName ? ` (${branchName})` : ""}`,
    details: `Opening ${fmt(amount, biz.currency)} · ${dateNow()} · By ${clerkPhone || "-"}`,
    balance: `Opening balance: ${fmt(amount, biz.currency)}`
  };

  await _dispatch(biz, clerkPhone, message, universal);
}

/**
 * Send a full daily summary to one phone (scheduled job or on demand).
 */
export async function sendDailyRunningReport({
  biz, branchId, branchName, toPhone
}) {
  const b   = await getDailyRunningBalance(biz._id, branchId, biz.currency);
  const cur = biz.currency;
  const _date = dateNow();

  const message =
`📊 *Daily Summary - ${biz.name}*
${branchName ? `🏬 ${branchName}\n` : ""}📅 ${_date}
━━━━━━━━━━━━━━━━━━━━
📂 Opening balance: ${fmt(b.opening, cur)}
📈 Cash In:         ${fmt(b.cashIn,  cur)}
📉 Cash Out:        ${fmt(b.cashOut, cur)}
━━━━━━━━━━━━━━━━━━━━
💰 *Cash at hand:  ${fmt(b.closing, cur)}*
━━━━━━━━━━━━━━━━━━━━`;

  const universal = {
    title:   `Daily Summary — ${biz.name}${branchName ? ` (${branchName})` : ""}`,
    details: `${_date} · Opening ${fmt(b.opening, cur)} · In ${fmt(b.cashIn, cur)} · ` +
             `Out ${fmt(b.cashOut, cur)}`,
    balance: `Cash at hand: ${fmt(b.closing, cur)}`
  };

  await _safeNotify(normPhone(toPhone), message, universal);
}

/**
 * Auto-sync supplier products/services → Business Tools Product model.
 */
export async function syncSupplierProductsToBizTools(supplierId) {
  try {
    const SupplierProfile = (await import("../models/supplierProfile.js")).default;
    const Product         = (await import("../models/product.js")).default;

    const supplier = await SupplierProfile.findById(supplierId).lean();
    if (!supplier?.businessId) return;

    const all    = [...new Set([
      ...(supplier.listedProducts || []),
      ...(supplier.products       || [])
    ].map(n => n?.trim()).filter(Boolean))];

    for (const name of all) {
      const price = (supplier.prices || []).find(p =>
        p.product?.toLowerCase() === name.toLowerCase());
      const rate  = (supplier.rates  || []).find(r =>
        r.service?.toLowerCase() === name.toLowerCase());

      await Product.findOneAndUpdate(
        { businessId: supplier.businessId, name },
        { $set: {
            businessId:  supplier.businessId,
            branchId:    supplier.mainBranchId || null,
            unitPrice:   price?.amount || 0,
            description: rate?.rate    || null,
            isService:   supplier.profileType === "service",
            isActive:    true
          }
        },
        { upsert: true }
      );
    }
    console.log(`[SYNC] ${all.length} products synced: supplier ${supplierId} → biz ${supplier.businessId}`);
  } catch (err) {
    console.error("[SYNC] syncSupplierProductsToBizTools:", err.message);
  }
}