/**
 * bizNotifications.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Real-time WhatsApp transaction notification engine.
 *
 * IMPORTANT — 24-HOUR SESSION WINDOW:
 * ─────────────────────────────────────────────────────────────────────────────
 * WhatsApp Cloud API rules:
 *   • type:"text" messages → ONLY work if the recipient messaged your number
 *     within the last 24 hours. Outside that window, Meta returns error 131026
 *     and the message is silently dropped.
 *   • type:"template" messages → Work ANY time, no session required, but the
 *     template must be pre-approved by Meta (takes 1-3 days to approve).
 *
 * WHERE THIS FILE LIVES:
 *   /var/www/cripf777/services/bizNotifications.js
 *   (same folder as chatbotEngine.js, metaSender.js, twilioStateBridge.js)
 *
 * HOW TO USE THIS FILE:
 *   Import the notification functions in twilioStateBridge.js and chatbotEngine.js:
 *   const { notifyDocumentCreated } = await import("./bizNotifications.js");
 *
 * FOR GUARANTEED DELIVERY (outside 24hr window):
 *   Submit a Meta template named "biz_transaction_alert" with one body variable
 *   {{1}} containing the message. Once approved, uncomment the template fallback
 *   in _safeNotify() below. Template submission guide:
 *   https://business.facebook.com/wa/manage/message-templates/
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

/** Combined "HH:MM on DD Mon YYYY" string for template {{timeDate}} variables */
function timeDateNow() {
  return `${timeNow()} on ${dateNow()}`;
}

/**
 * _safeNotify: Sends a WhatsApp text message.
 *
 * Works within 24hr session. If recipient hasn't messaged in 24hrs,
 * Meta drops the message (error 131026). To fix this, submit a template
 * named "biz_transaction_alert" to Meta and uncomment the template fallback below.
 */
/**
 * _safeNotify: Send a message, falling back to a Meta template if the 24hr
 * session window is expired.
 *
 * @param {string} phone          - Recipient phone e.g. "263771446827"
 * @param {string} message        - The text message (used within 24hr window)
 * @param {string} [templateType] - Template key: "invoice"|"payment"|"expense"|"payout"|"opening"|"daily"
 * @param {Object} [templateData] - Data object for the template variables (see _templates above)
 */
async function _safeNotify(phone, message, templateType = null, templateData = null) {
  try {
    await sendText(phone, message);
  } catch (err) {
    const code = err?.response?.data?.error?.code;
    const isSessionExpired = code === 131026 || String(err?.message).includes("131026");

    if (isSessionExpired && templateType && templateData && _templates[templateType]) {
      // ── TEMPLATE FALLBACK: works 24/7 once the template is approved on Meta ──
      try {
        await _templates[templateType]({ ...templateData, phone });
        console.log(`[BIZ_NOTIF] Template fallback sent to ${phone} (${templateType})`);
      } catch (tplErr) {
        console.error(`[BIZ_NOTIF] Template fallback also failed for ${phone}:`, tplErr.message);
      }
    } else if (isSessionExpired) {
      console.warn(`[BIZ_NOTIF] ${phone} outside 24hr window — no template configured for type "${templateType || "none"}". Submit templates to Meta to fix this.`);
    } else {
      console.error(`[BIZ_NOTIF] Failed to notify ${phone}:`, err.message);
    }
  }
}

/**
 * _sendTemplate: Sends a pre-approved Meta template when the 24hr session is expired.
 * Each template maps to a specific notification type.
 *
 * HOW TO SUBMIT EACH TEMPLATE TO META:
 *   Meta Business Suite → WhatsApp → Message Templates → Create Template
 *   Category: UTILITY  |  Language: English (en)
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * TEMPLATE 1: biz_invoice_created
 * Body: "New {{1}} recorded at {{2}}.

Business: {{3}}
Branch: {{4}}
Ref: {{5}}
Client: {{6}}
Amount: {{7}}
Recorded by: {{8}}

Cash at hand today: {{9}}"
 * Samples: Invoice | 09:15 | Mudziyashe Hardware | Main Branch | INV-0042 | John Moyo | $250.00 | 263771446827 | $480.00 (In: +$250 | Out: -$30)
 *
 * TEMPLATE 2: biz_payment_received
 * Body: "Payment received at {{1}}.

Business: {{2}}
Branch: {{3}}
Invoice: {{4}}
Client: {{5}}
Amount: {{6}}
Method: {{7}}
Recorded by: {{8}}

Cash at hand today: {{9}}"
 * Samples: 10:30 | Mudziyashe Hardware | Main Branch | INV-0042 | John Moyo | $250.00 | Cash | 263771446827 | $730.00 (In: +$500 | Out: -$30)
 *
 * TEMPLATE 3: biz_expenses_recorded
 * Body: "Expenses recorded at {{1}}.

Business: {{2}}
Branch: {{3}}
Items: {{4}}
Total out: {{5}}
Recorded by: {{6}}

Cash at hand today: {{7}}"
 * Samples: 11:45 | Mudziyashe Hardware | Main Branch | Fuel $40.00, Lunch $15.00, Zesa $50.00 | $105.00 | 263771446827 | $395.00 (In: +$500 | Out: -$105)
 *
 * TEMPLATE 4: biz_payout_recorded
 * Body: "Cash payout recorded at {{1}}.

Business: {{2}}
Branch: {{3}}
Amount: {{4}}
Reason: {{5}}
Recorded by: {{6}}

Cash at hand today: {{7}}"
 * Samples: 14:00 | Mudziyashe Hardware | Main Branch | $200.00 | Owner drawing | 263771446827 | $195.00 (In: +$500 | Out: -$305)
 *
 * TEMPLATE 5: biz_opening_balance_set
 * Body: "Opening balance set for today.

Business: {{1}}
Branch: {{2}}
Opening balance: {{3}}
Date: {{4}}
Set by: {{5}}

Cash tracking has started for today."
 * Samples: Mudziyashe Hardware | Main Branch | $300.00 | 31 May 2026 | 263771446827
 *
 * TEMPLATE 6: biz_daily_summary
 * Body: "Daily summary for {{1}} - {{2}}.

Branch: {{3}}
Date: {{4}}

Opening balance: {{5}}
Cash in: {{6}}
Cash out: {{7}}

Cash at hand: {{8}}"
 * Samples: Mudziyashe Hardware | 31 May 2026 | Main Branch | 31 May 2026 | $300.00 | $850.00 | $305.00 | $845.00
 * ─────────────────────────────────────────────────────────────────────────────
 */

function _param(text) {
  // Truncate to Meta's 1024-char limit per parameter
  const t = String(text || "—");
  return { type: "text", text: t.length > 100 ? t.slice(0, 97) + "..." : t };
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
      to:   phone,
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
 * Template dispatchers — one per notification type.
 * Each maps exactly to its approved Meta template.
 * Pass the same data object you pass to the sendText notification function.
 */
const _templates = {

  // ── biz_invoice_created ────────────────────────────────────────────────────
  // Body:
  //   ZimQuote Business Alert
  //   A new {{1}} has been recorded on your account.
  //   Details:
  //   - Ref: {{2}}
  //   - Client: {{3}}
  //   - Amount: {{4}}
  //   Recorded at {{5}} by {{6}}.
  //   Reply *menu* to open ZimQuote.
  //
  // Samples: Invoice | INV-0042 | John Moyo | $250.00 | 09:15 on 31 May 2026 | 263771446827
  invoice: (d) => _postTemplate(d.phone, "biz_invoice_created", [
    d.docType,    // {{1}} Invoice / Quote / Receipt
    d.ref,        // {{2}} INV-0042 | Mudziyashe Hardware | Main Branch
    d.clientName, // {{3}} John Moyo
    d.amount,     // {{4}} $250.00 | Cash at hand: $480.00
    d.timeDate,   // {{5}} 09:15 on 31 May 2026
    d.clerkPhone  // {{6}} 263771446827
  ]),

  // ── biz_payment_received ───────────────────────────────────────────────────
  // Body:
  //   ZimQuote Business Alert
  //   A payment has been received on your account.
  //   Details:
  //   - Invoice: {{1}}
  //   - Client: {{2}}
  //   - Amount paid: {{3}}
  //   - Method: {{4}}
  //   Recorded at {{5}} by {{6}}.
  //   Reply *menu* to open ZimQuote.
  //
  // Samples: INV-0042 | John Moyo | $250.00 | Cash | 10:30 on 31 May 2026 | 263771446827
  payment: (d) => _postTemplate(d.phone, "biz_payment_received", [
    d.invoiceRef, // {{1}} INV-0042 | Mudziyashe Hardware | Main Branch
    d.clientName, // {{2}} John Moyo
    d.amount,     // {{3}} $250.00 | Cash at hand: $730.00
    d.method,     // {{4}} Cash
    d.timeDate,   // {{5}} 10:30 on 31 May 2026
    d.clerkPhone  // {{6}} 263771446827
  ]),

  // ── biz_expenses_recorded ──────────────────────────────────────────────────
  // Body:
  //   ZimQuote Business Alert
  //   Expenses have been recorded on your account.
  //   Details:
  //   - Business: {{1}}
  //   - Items: {{2}}
  //   - Total out: {{3}}
  //   Recorded at {{4}} by {{5}}.
  //   Reply *menu* to open ZimQuote.
  //
  // Samples: Mudziyashe Hardware | Main Branch | Fuel $40.00, Lunch $15.00 | $105.00 | 11:45 on 31 May 2026 | 263771446827
  expense: (d) => _postTemplate(d.phone, "biz_expenses_recorded", [
    d.bizBranch,  // {{1}} Mudziyashe Hardware | Main Branch
    d.items,      // {{2}} Fuel $40.00, Lunch $15.00, Zesa $50.00
    d.total,      // {{3}} $105.00 | Cash at hand: $395.00
    d.timeDate,   // {{4}} 11:45 on 31 May 2026
    d.clerkPhone  // {{5}} 263771446827
  ]),

  // ── biz_payout_recorded ────────────────────────────────────────────────────
  // Body:
  //   ZimQuote Business Alert
  //   A cash payout has been recorded on your account.
  //   Details:
  //   - Business: {{1}}
  //   - Amount: {{2}}
  //   - Reason: {{3}}
  //   Recorded at {{4}} by {{5}}.
  //   Reply *menu* to open ZimQuote.
  //
  // Samples: Mudziyashe Hardware | Main Branch | $200.00 | Owner drawing | 14:00 on 31 May 2026 | 263771446827
  payout: (d) => _postTemplate(d.phone, "biz_payout_recorded", [
    d.bizBranch,  // {{1}} Mudziyashe Hardware | Main Branch
    d.amount,     // {{2}} $200.00 | Cash at hand: $195.00
    d.reason,     // {{3}} Owner drawing
    d.timeDate,   // {{4}} 14:00 on 31 May 2026
    d.clerkPhone  // {{5}} 263771446827
  ]),

  // ── biz_opening_balance_set ────────────────────────────────────────────────
  // Body:
  //   ZimQuote Business Alert
  //   The opening balance has been set for today.
  //   Details:
  //   - Business: {{1}}
  //   - Opening balance: {{2}}
  //   - Date: {{3}}
  //   Set by {{4}}. Cash tracking is now active for today.
  //   Reply *menu* to open ZimQuote.
  //
  // Samples: Mudziyashe Hardware | Main Branch | $300.00 | 31 May 2026 | 263771446827
  opening: (d) => _postTemplate(d.phone, "biz_opening_balance_set", [
    d.bizBranch,  // {{1}} Mudziyashe Hardware | Main Branch
    d.amount,     // {{2}} $300.00
    d.date,       // {{3}} 31 May 2026
    d.clerkPhone  // {{4}} 263771446827
  ]),

  // ── biz_daily_summary ─────────────────────────────────────────────────────
  // Body:
  //   ZimQuote Daily Summary
  //   Your end-of-day cash report is ready.
  //   Business: {{1}}
  //   Date: {{2}}
  //   Opening balance: {{3}}
  //   Cash in today:   {{4}}
  //   Cash out today:  {{5}}
  //   Cash at hand:    {{6}}
  //   Reply *menu* to view full report on ZimQuote.
  //
  // Samples: Mudziyashe Hardware | Main Branch | 31 May 2026 | $300.00 | $850.00 | $305.00 | $845.00
  daily: (d) => _postTemplate(d.phone, "biz_daily_summary", [
    d.bizBranch,  // {{1}} Mudziyashe Hardware | Main Branch
    d.date,       // {{2}} 31 May 2026
    d.opening,    // {{3}} $300.00
    d.cashIn,     // {{4}} $850.00
    d.cashOut,    // {{5}} $305.00
    d.balance     // {{6}} $845.00
  ])
}

// ── Recipients ────────────────────────────────────────────────────────────────

/**
 * Get all phones that should receive notifications for a business.
 * Returns the set of unique phones: owners + managers + admins + clerkPhone.
 */
export async function getNotificationRecipients(businessId, clerkPhone = null) {
  const UserRole = (await import("../models/userRole.js")).default;
  const roles = await UserRole.find({ businessId, pending: false }).lean();

  const owners   = roles.filter(r => r.role === "owner").map(r => r.phone);
  const managers = roles
    .filter(r => r.role === "manager" || r.role === "admin")
    .map(r => r.phone);

  // Deduplicate: clerk may also be owner/manager
  const allSet = [...new Set([...owners, ...managers, ...(clerkPhone ? [clerkPhone] : [])])];
  return { owners, managers, allSet };
}

/**
 * Get today's running cash balance for a branch (or whole business if no branchId).
 */
export async function getDailyRunningBalance(businessId, branchId, currency = "USD") {
  const [CashBalance, InvoicePayment, Invoice, Expense, CashPayout] = await Promise.all([
    import("../models/cashBalance.js").then(m => m.default),
    import("../models/invoicePayment.js").then(m => m.default),
    import("../models/invoice.js").then(m => m.default),
    import("../models/expense.js").then(m => m.default),
    import("../models/cashPayout.js").then(m => m.default).catch(() => null)
  ]);

  const today    = new Date(); today.setHours(0, 0, 0, 0);
  const tomorrow = new Date(today); tomorrow.setDate(tomorrow.getDate() + 1);

  const base      = { businessId };
  if (branchId) base.branchId = branchId;
  const todayQ    = { ...base, createdAt: { $gte: today, $lt: tomorrow } };

  const [balance, payments, receipts, expenses, payouts] = await Promise.all([
    CashBalance.findOne({ ...base, date: today }).lean().catch(() => null),
    InvoicePayment.find(todayQ).lean().catch(() => []),
    Invoice.find({ ...todayQ, type: "receipt" }).lean().catch(() => []),
    Expense.find(todayQ).lean().catch(() => []),
    CashPayout ? CashPayout.find({ ...base, date: today }).lean().catch(() => []) : []
  ]);

  const opening = balance?.openingBalance ?? 0;
  const cashIn  = payments.reduce((s, p) => s + (p.amount || 0), 0) +
                  receipts.reduce((s, r) => s + (r.total  || 0), 0);
  const cashOut = expenses.reduce((s, e) => s + (e.amount || 0), 0) +
                  payouts.reduce((s,  p) => s + (p.amount || 0), 0);

  return { opening, cashIn, cashOut, closing: opening + cashIn - cashOut, currency };
}

/** Append a "💰 Cash at hand" line to notifications. */
async function _balanceLine(biz, branchId) {
  try {
    const b = await getDailyRunningBalance(biz._id, branchId, biz.currency);
    return `\n💰 *Cash at hand: ${fmt(b.closing, biz.currency)}*` +
           `  (In: +${fmt(b.cashIn, biz.currency)} | Out: -${fmt(b.cashOut, biz.currency)})`;
  } catch (_) { return ""; }
}

/** Fire-and-forget to all recipients. */
async function _dispatch(businessId, clerkPhone, message, templateType = null, templateData = null) {
  try {
    const { allSet } = await getNotificationRecipients(businessId, clerkPhone);
    await Promise.all(allSet.map(p => _safeNotify(p, message, templateType, { ...templateData, phone: p })));
  } catch (err) {
    console.error("[BIZ_NOTIF] dispatch error:", err.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC API
// ─────────────────────────────────────────────────────────────────────────────

/** Invoice / Quote / Receipt created */
export async function notifyDocumentCreated({
  biz, doc, docType, clerkPhone, branchName, branchId
}) {
  const emoji  = { invoice: "📄", quote: "📋", receipt: "🧾" }[docType] || "📄";
  const label  = docType.charAt(0).toUpperCase() + docType.slice(1);
  const bal    = await _balanceLine(biz, branchId);
  const branch = branchName ? `\n  🏬 Branch: ${branchName}` : "";
  const clerk  = clerkPhone ? `\n  👤 By: ${clerkPhone}` : "";

  const _time = timeNow();
  const _bal  = bal.replace(/\n💰 \*Cash at hand: |\*.*$/g, "").trim() ||
                `${fmt((await getDailyRunningBalance(biz._id, branchId, biz.currency).catch(()=>({closing:0}))).closing, biz.currency)}`;
  // strip markdown for template
  const _balClean = bal.replace(/[*_]/g, "").replace(/\n/g, " ").trim() || "—";

  await _dispatch(biz._id, clerkPhone,
`${emoji} *New ${label} — ${biz.name}*
📅 ${dateNow()} at ${_time}${branch}${clerk}

  🔢 Ref: *${doc.number || "—"}*
  👥 Client: ${doc.clientName || "Walk-in"}
  💵 Amount: *${fmt(doc.total, biz.currency)}*${bal}`,
    "invoice",
    {
      docType:    label,
      ref:        `${doc.number || "—"} | ${biz.name}${branchName ? " | " + branchName : ""}`,
      clientName: doc.clientName || "Walk-in",
      amount:     `${fmt(doc.total, biz.currency)} | Cash at hand: ${_balClean}`,
      timeDate:   timeDateNow(),
      clerkPhone: clerkPhone || "—"
    }
  );
}

/** Payment received on an invoice */
export async function notifyPaymentRecorded({
  biz, payment, invoiceNumber, clientName, clerkPhone, branchName, branchId
}) {
  const bal    = await _balanceLine(biz, branchId);
  const branch = branchName ? `\n  🏬 Branch: ${branchName}` : "";
  const clerk  = clerkPhone ? `\n  👤 By: ${clerkPhone}` : "";

  const _time2 = timeNow();
  const _balClean2 = bal.replace(/[*_]/g, "").replace(/\n/g, " ").trim() || "—";

  await _dispatch(biz._id, clerkPhone,
`💳 *Payment Received — ${biz.name}*
📅 ${dateNow()} at ${_time2}${branch}${clerk}

  📄 Invoice: *${invoiceNumber || "—"}*
  👥 Client: ${clientName || "—"}
  💵 Amount: *${fmt(payment.amount, biz.currency)}*
  💳 Method: ${payment.method || "Cash"}${bal}`,
    "payment",
    {
      invoiceRef:  `${invoiceNumber || "—"} | ${biz.name}${branchName ? " | " + branchName : ""}`,
      clientName:  clientName || "—",
      amount:      `${fmt(payment.amount, biz.currency)} | Cash at hand: ${_balClean2}`,
      method:      payment.method || "Cash",
      timeDate:    timeDateNow(),
      clerkPhone:  clerkPhone || "—"
    }
  );
}

/** One or more expenses recorded */
export async function notifyExpensesRecorded({
  biz, expenses, clerkPhone, branchName, branchId
}) {
  const total  = expenses.reduce((s, e) => s + (e.amount || 0), 0);
  const bal    = await _balanceLine(biz, branchId);
  const branch = branchName ? `\n  🏬 Branch: ${branchName}` : "";
  const clerk  = clerkPhone ? `\n  👤 By: ${clerkPhone}` : "";
  const lines  = expenses
    .map(e => `  • ${e.description} — ${fmt(e.amount, biz.currency)} (${e.category || "Other"})`)
    .join("\n");

  const _time3 = timeNow();
  const _balClean3 = bal.replace(/[*_]/g, "").replace(/\n/g, " ").trim() || "—";
  const _itemsFlat = expenses
    .map(e => `${e.description} ${fmt(e.amount, biz.currency)}`)
    .join(", ");

  await _dispatch(biz._id, clerkPhone,
`💸 *Expenses Recorded — ${biz.name}*
📅 ${dateNow()} at ${_time3}${branch}${clerk}

${lines}
  ──────────────
  💵 Total out: *${fmt(total, biz.currency)}*${bal}`,
    "expense",
    {
      bizBranch:  `${biz.name}${branchName ? " | " + branchName : ""}`,
      items:      _itemsFlat,
      total:      `${fmt(total, biz.currency)} | Cash at hand: ${_balClean3}`,
      timeDate:   timeDateNow(),
      clerkPhone: clerkPhone || "—"
    }
  );
}

/** Cash payout / drawing recorded */
export async function notifyPayoutRecorded({
  biz, payout, clerkPhone, branchName, branchId
}) {
  const bal    = await _balanceLine(biz, branchId);
  const branch = branchName ? `\n  🏬 Branch: ${branchName}` : "";
  const clerk  = clerkPhone ? `\n  👤 By: ${clerkPhone}` : "";

  const _time4 = timeNow();
  const _balClean4 = bal.replace(/[*_]/g, "").replace(/\n/g, " ").trim() || "—";

  await _dispatch(biz._id, clerkPhone,
`📤 *Cash Payout — ${biz.name}*
📅 ${dateNow()} at ${_time4}${branch}${clerk}

  💵 Amount: *${fmt(payout.amount, biz.currency)}*
  📝 Reason: ${payout.reason || "—"}${bal}`,
    "payout",
    {
      bizBranch:  `${biz.name}${branchName ? " | " + branchName : ""}`,
      amount:     `${fmt(payout.amount, biz.currency)} | Cash at hand: ${_balClean4}`,
      reason:     payout.reason || "—",
      timeDate:   timeDateNow(),
      clerkPhone: clerkPhone || "—"
    }
  );
}

/** Opening balance set for the day */
export async function notifyOpeningBalanceSet({
  biz, amount, clerkPhone, branchName, branchId
}) {
  const branch = branchName ? `\n  🏬 Branch: ${branchName}` : "";
  const clerk  = clerkPhone ? `\n  👤 By: ${clerkPhone}` : "";

  await _dispatch(biz._id, clerkPhone,
`🔓 *Opening Balance Set — ${biz.name}*
📅 ${dateNow()} at ${timeNow()}${branch}${clerk}

  💰 Opening: *${fmt(amount, biz.currency)}*
  _Cash tracking started for today._`,
    "opening",
    {
      bizBranch:  `${biz.name}${branchName ? " | " + branchName : ""}`,
      amount:     fmt(amount, biz.currency),
      date:       dateNow(),
      clerkPhone: clerkPhone || "—"
    }
  );
}

/**
 * Send a full daily summary to one phone.
 * Call this manually from a scheduled job or on demand.
 */
export async function sendDailyRunningReport({
  biz, branchId, branchName, toPhone
}) {
  const b   = await getDailyRunningBalance(biz._id, branchId, biz.currency);
  const cur = biz.currency;

  const _date = dateNow();
  await _safeNotify(toPhone,
`📊 *Daily Summary — ${biz.name}*
${branchName ? `🏬 ${branchName}\n` : ""}📅 ${_date}
━━━━━━━━━━━━━━━━━━━━
📂 Opening balance: ${fmt(b.opening, cur)}
📈 Cash In:         ${fmt(b.cashIn,  cur)}
📉 Cash Out:        ${fmt(b.cashOut, cur)}
━━━━━━━━━━━━━━━━━━━━
💰 *Cash at hand:  ${fmt(b.closing, cur)}*
━━━━━━━━━━━━━━━━━━━━`,
    "daily",
    {
      bizBranch:  `${biz.name}${branchName ? " | " + branchName : ""}`,
      date:       _date,
      opening:    fmt(b.opening, cur),
      cashIn:     fmt(b.cashIn,  cur),
      cashOut:    fmt(b.cashOut, cur),
      balance:    fmt(b.closing, cur)
    }
  );
}

/**
 * Auto-sync supplier products/services → Business Tools Product model.
 * Called after supplier adds products via chatbot or admin saves.
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