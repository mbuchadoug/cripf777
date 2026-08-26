/**
 * bizNotifications.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Real-time WhatsApp transaction notification engine.
 *
 * Fans every business event (invoice / quote / receipt, payment, expense,
 * payout, opening balance, daily summary) out to EVERY owner + manager + admin
 * of the business, plus the clerk who recorded it - and delivers even when a
 * recipient is OUTSIDE the 24-hour WhatsApp session window.
 *
 * ── HOW DELIVERY IS DECIDED (this is the important part) ──────────────────────
 * WhatsApp Cloud API rules:
 *   • type:"text"      → only delivers if the recipient messaged the number in
 *                        the last 24h. Outside that window Meta rejects it.
 *   • type:"template"  → delivers ANY time, no session needed, but the template
 *                        must be pre-approved by Meta.
 *
 * We CANNOT rely on catching an error to know the window is closed:
 * metaSender.sendText() does not throw when Meta rejects an out-of-window send -
 * it returns as if it succeeded (confirmed in production: "✓ text sent" logged
 * for owners who received nothing). So instead of "try text, fall back on
 * error", we decide up front by WHO the recipient is:
 *
 *   • the ACTIVE transactor (just tapped a button / typed) is inside the 24h
 *     window → send the rich free-text message (nice formatting, no template cost)
 *   • EVERYONE ELSE (dormant owners, the founder, scheduled jobs) → send the
 *     matching approved TEMPLATE, which always delivers.
 *
 * ── APPROVED TEMPLATES THIS FILE USES (already live on Meta, Utility/English) ─
 *   biz_invoice_created      {{1}}=doc type {{2}}=ref {{3}}=client {{4}}=amount {{5}}=time/date {{6}}=by
 *   biz_payment_received     {{1}}=invoice {{2}}=client {{3}}=amount {{4}}=method {{5}}=time/date {{6}}=by
 *   biz_expenses_recorded    {{1}}=biz|branch {{2}}=items {{3}}=total {{4}}=time/date {{5}}=by
 *   biz_payout_recorded      {{1}}=biz|branch {{2}}=amount {{3}}=reason {{4}}=time/date {{5}}=by
 *   biz_opening_balance_set  {{1}}=biz|branch {{2}}=amount {{3}}=date {{4}}=by
 *   biz_daily_summary        {{1}}=biz|branch {{2}}=date {{3}}=opening {{4}}=in {{5}}=out {{6}}=cash at hand
 *
 * If any template send logs "(#132001) Template name does not exist", the name
 * or language below no longer matches Meta - fix the name in _templates.
 *
 * WHERE THIS FILE LIVES: /var/www/cripf777/services/bizNotifications.js
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { sendText } from "./metaSender.js";
import axios from "axios";

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

/** Combined "HH:MM on DD Mon YYYY" string for template time/date variables. */
function timeDateNow() {
  return `${timeNow()} on ${dateNow()}`;
}

/** Normalise a phone to digits only (for dedup + Meta). */
function normPhone(p) {
  return String(p || "").replace(/\D+/g, "");
}

// ── Meta template plumbing ────────────────────────────────────────────────────

/**
 * Make a value safe as a WhatsApp TEMPLATE parameter. Meta rejects parameters
 * containing newlines, tabs, or 4+ consecutive spaces, so we flatten those and
 * cap the length well under Meta's 1024-char limit. Never returns empty.
 */
function _param(text) {
  let t = String(text == null ? "" : text);
  t = t.replace(/[\r\n\t]+/g, " ").replace(/ {2,}/g, " ").trim();
  if (t.length > 300) t = t.slice(0, 297) + "...";
  return { type: "text", text: t.length ? t : "-" };
}

async function _postTemplate(phone, templateName, params) {
  const PHONE_ID = process.env.WHATSAPP_PHONE_NUMBER_ID ||
                   process.env.META_PHONE_NUMBER_ID     ||
                   process.env.PHONE_NUMBER_ID;
  const TOKEN    = process.env.META_ACCESS_TOKEN || process.env.WHATSAPP_ACCESS_TOKEN;

  await axios.post(
    `https://graph.facebook.com/v24.0/${PHONE_ID}/messages`,
    {
      messaging_product: "whatsapp",
      to:   normPhone(phone),
      type: "template",
      template: {
        name:     templateName,
        language: { code: "en" },
        components: [{ type: "body", parameters: params.map(_param) }]
      }
    },
    { headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" } }
  );
}

/**
 * One dispatcher per notification type → its approved Meta template.
 * Variable ORDER here must match the approved template exactly.
 */
const _templates = {
  invoice: (d) => _postTemplate(d.phone, "biz_invoice_created", [
    d.docType, d.ref, d.clientName, d.amount, d.timeDate, d.clerkPhone
  ]),
  payment: (d) => _postTemplate(d.phone, "biz_payment_received", [
    d.invoiceRef, d.clientName, d.amount, d.method, d.timeDate, d.clerkPhone
  ]),
  expense: (d) => _postTemplate(d.phone, "biz_expenses_recorded", [
    d.bizBranch, d.items, d.total, d.timeDate, d.clerkPhone
  ]),
  payout: (d) => _postTemplate(d.phone, "biz_payout_recorded", [
    d.bizBranch, d.amount, d.reason, d.timeDate, d.clerkPhone
  ]),
  opening: (d) => _postTemplate(d.phone, "biz_opening_balance_set", [
    d.bizBranch, d.amount, d.date, d.clerkPhone
  ]),
  daily: (d) => _postTemplate(d.phone, "biz_daily_summary", [
    d.bizBranch, d.date, d.opening, d.cashIn, d.cashOut, d.balance
  ]),
  // Optional note attached to an invoice / quote / receipt. Sent as a SEPARATE
  // alert right after the document notification (see notifyDocumentNote).
  // Template body to submit in WhatsApp Manager (category: UTILITY):
  //   A note has been added to a document on your account.
  //
  //   Document: {{1}}
  //   Note: {{2}}
  //   Recorded {{3}} by {{4}}.
  //
  //   Reply menu to open ZimQuote.
  note: (d) => _postTemplate(d.phone, "biz_document_note", [
    d.docRef, d.note, d.timeDate, d.clerkPhone
  ])
};

/**
 * Deliver one notification to one phone.
 *
 *   isActive === true  → recipient just interacted, inside the 24h window:
 *                        send rich free text; if that throws, try the template.
 *   isActive === false → window unknown (dormant owner / founder / scheduled):
 *                        send the approved template (always delivers); if that
 *                        throws, last-resort plain text (only lands if in-window).
 */
async function _safeNotify(phone, message, templateType = null, templateData = null, isActive = false) {
  const tpl = templateType && _templates[templateType]
    ? () => _templates[templateType]({ ...(templateData || {}), phone })
    : null;

  // ── Active transactor: rich free text ──────────────────────────────────────
  if (isActive) {
    try {
      await sendText(phone, message);
      console.log(`[BIZ_NOTIF] \u2713 text \u2192 ${phone} (active/in-window)`);
      return;
    } catch (err) {
      const detail = err?.response?.data?.error?.message || err?.message || "";
      console.warn(`[BIZ_NOTIF] text failed for active ${phone}: ${detail}` +
                   (tpl ? " \u2192 trying template" : ""));
      if (!tpl) return;
      // fall through to template
    }
  }

  // ── Everyone else: template first (delivers regardless of window) ───────────
  if (tpl) {
    try {
      await tpl();
      console.log(`[BIZ_NOTIF] \u2713 template (${templateType}) \u2192 ${phone}`);
      return;
    } catch (tplErr) {
      const tdetail = tplErr?.response?.data?.error?.message || tplErr.message;
      console.error(`[BIZ_NOTIF] \u2717 template (${templateType}) \u2192 ${phone}: ${tdetail}`);
      // Last resort: plain text. Only lands if they happen to be in-window.
      try {
        await sendText(phone, message);
        console.log(`[BIZ_NOTIF] text attempted (last-resort) \u2192 ${phone} ` +
                    `(delivers only if inside the 24h window)`);
      } catch (txtErr) {
        const xd = txtErr?.response?.data?.error?.message || txtErr.message;
        console.error(`[BIZ_NOTIF] \u2717 last-resort text \u2192 ${phone}: ${xd}`);
      }
    }
  } else {
    // No template configured for this type → plain text only.
    try {
      await sendText(phone, message);
      console.log(`[BIZ_NOTIF] \u2713 text \u2192 ${phone} (no template for type)`);
    } catch (e) {
      console.error(`[BIZ_NOTIF] \u2717 text \u2192 ${phone}: ${e?.response?.data?.error?.message || e.message}`);
    }
  }
}

// ── Recipients ────────────────────────────────────────────────────────────────

/**
 * Every phone that should receive notifications for a business.
 * = owners + managers + admins + founding owner (biz.providerId via extraPhones)
 *   + the clerk who recorded it. Deduplicated, digits-only.
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

  const allSet = [...new Set([...owners, ...extras, ...managers, ...clerk])];
  console.log(
    `[BIZ_NOTIF] recipients for biz ${businessId}: ` +
    `owners=[${owners.join(",")}] managers=[${managers.join(",")}] ` +
    `founder=[${extras.join(",")}] clerk=[${clerk.join(",")}] ` +
    `\u2192 ${allSet.length} unique: ${allSet.join(", ")}`
  );
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

  const base    = { businessId, ...(branchId ? { branchId } : {}) };
  const todayQ  = { ...base, createdAt: { $gte: today, $lt: tomorrow } };
  const beforeQ = { ...base, createdAt: { $lt: today } };

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

/** Append a "💰 Cash at hand" line to notifications. */
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

/** Clean single-line "Cash at hand: ..." suffix for template amount variables. */
function _balClean(bal) {
  const c = String(bal || "")
    .replace(/[*_~`]/g, "").replace(/💰/g, "")
    .replace(/[\r\n\t]+/g, " ").replace(/ {2,}/g, " ").trim();
  return c || "-";
}

/** Fan a notification out to every recipient. */
async function _dispatch(biz, clerkPhone, message, templateType = null, templateData = null) {
  try {
    const { allSet } = await getNotificationRecipients(biz._id, clerkPhone, [biz.providerId]);
    const active = normPhone(clerkPhone);
    console.log(`[BIZ_NOTIF] "${biz.name}" dispatching to ${allSet.length} recipient(s); active=${active || "none"}`);
    await Promise.all(allSet.map(p =>
      _safeNotify(p, message, templateType, { ...(templateData || {}), phone: p }, normPhone(p) === active)
    ));
  } catch (err) {
    console.error("[BIZ_NOTIF] dispatch error:", err.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC API  (signatures unchanged - call sites in twilioStateBridge.js keep working)
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

  await _dispatch(biz, clerkPhone, message, "invoice", {
    docType:    label,
    ref:        `${doc.number || "-"} | ${biz.name}${branchName ? " | " + branchName : ""}`,
    clientName: doc.clientName || "Walk-in",
    amount:     `${fmt(doc.total, biz.currency)} | ${_balClean(bal)}`,
    timeDate:   timeDateNow(),
    clerkPhone: clerkPhone || "-"
  });
}

/**
 * Optional note attached to an invoice / quote / receipt.
 *
 * Sent as a SEPARATE alert right AFTER notifyDocumentCreated() so it lands just
 * below the document notification (exactly like the attached screenshot). Uses
 * the biz_document_note template first for dormant recipients (delivers outside
 * the 24h window) and rich free text for the active clerk, via the same fan-out
 * + fallback machinery as every other business alert.
 *
 * No-ops when the note is empty, so callers can call it unconditionally.
 */
export async function notifyDocumentNote({
  biz, doc, docType, note, clerkPhone, branchName
}) {
  const clean = String(note == null ? "" : note).trim();
  if (!clean) return;   // nothing to send

  const label  = docType ? docType.charAt(0).toUpperCase() + docType.slice(1) : "Document";
  const number = doc?.number || "-";
  const branch = branchName ? `\n  🏬 Branch: ${branchName}` : "";
  const clerk  = clerkPhone ? `\n  👤 By: ${clerkPhone}` : "";
  const docRef = `${label} ${number} | ${biz.name}${branchName ? " | " + branchName : ""}`;

  const message =
`📝 *Note added - ${biz.name}*
📅 ${dateNow()} at ${timeNow()}${branch}${clerk}

  🔢 ${label}: *${number}*
  🗒 Note: ${clean}`;

  await _dispatch(biz, clerkPhone, message, "note", {
    docRef,
    note:       clean,
    timeDate:   timeDateNow(),
    clerkPhone: clerkPhone || "-"
  });
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

  await _dispatch(biz, clerkPhone, message, "payment", {
    invoiceRef: `${invoiceNumber || "-"} | ${biz.name}${branchName ? " | " + branchName : ""}`,
    clientName: clientName || "-",
    amount:     `${fmt(payment.amount, biz.currency)} | ${_balClean(bal)}`,
    method:     payment.method || "Cash",
    timeDate:   timeDateNow(),
    clerkPhone: clerkPhone || "-"
  });
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

  await _dispatch(biz, clerkPhone, message, "expense", {
    bizBranch:  `${biz.name}${branchName ? " | " + branchName : ""}`,
    items:      itemsFlat,
    total:      `${fmt(total, biz.currency)} | ${_balClean(bal)}`,
    timeDate:   timeDateNow(),
    clerkPhone: clerkPhone || "-"
  });
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

  await _dispatch(biz, clerkPhone, message, "payout", {
    bizBranch:  `${biz.name}${branchName ? " | " + branchName : ""}`,
    amount:     `${fmt(payout.amount, biz.currency)} | ${_balClean(bal)}`,
    reason:     payout.reason || "-",
    timeDate:   timeDateNow(),
    clerkPhone: clerkPhone || "-"
  });
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

  await _dispatch(biz, clerkPhone, message, "opening", {
    bizBranch:  `${biz.name}${branchName ? " | " + branchName : ""}`,
    amount:     fmt(amount, biz.currency),
    date:       dateNow(),
    clerkPhone: clerkPhone || "-"
  });
}

/**
 * Send a full daily summary to one phone (scheduled job or on demand).
 * The recipient is usually dormant, so this goes template-first.
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

  await _safeNotify(normPhone(toPhone), message, "daily", {
    bizBranch: `${biz.name}${branchName ? " | " + branchName : ""}`,
    date:      _date,
    opening:   fmt(b.opening, cur),
    cashIn:    fmt(b.cashIn,  cur),
    cashOut:   fmt(b.cashOut, cur),
    balance:   fmt(b.closing, cur)
  }, false);
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