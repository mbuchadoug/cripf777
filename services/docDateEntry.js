// services/docDateEntry.js
// ─────────────────────────────────────────────────────────────────────────────
// Reusable "pick a date" sub-flow for the WhatsApp accounting bot.
//
// Purpose
//   Let a user / clerk choose the DATE a document (invoice, quotation, receipt)
//   or an expense actually happened on, BEFORE it is recorded - so a sale entered
//   today can be booked to yesterday, last Friday, "3 days ago", etc. The chosen
//   date is written to the record's createdAt, which is exactly what every report
//   / ledger / statement already sums on, so backdated entries land on the right
//   day automatically. The true system time is preserved separately in enteredAt.
//
// Design (fast & simple, WhatsApp has no native date picker)
//   • 3 quick-reply buttons:  📅 Today  ·  ⬅️ Yesterday  ·  ⌨️ Type a date
//   • forgiving free-text typing (today / yesterday / 12/08 / 12 Aug / 3 days ago)
//   • month shortcodes + clear examples shown when the user chooses "Type a date"
//   • a friendly preview label so mistakes are easy to spot
//
// This module is self-contained: every handler re-loads the business fresh from
// the session (same pattern as invoiceAdapters.js) so callers never pass around
// a stale/dirty biz document. All it needs from the caller is a single call.
//
// States it owns:
//   awaiting_doc_date       - buttons shown, waiting for tap OR typed date
//   awaiting_doc_date_type  - user tapped "Type a date", waiting for typed date
//
// sessionData keys it uses:
//   _dateReturn : "doc_finalize" | "expense_entry"   (where to go once a date is set)
//   docDateISO  : "yyyy-mm-dd"                        (the chosen business date)
//
// IMPORTANT wiring (done in chatbotEngine.js / twilioStateBridge.js):
//   • isMetaAction whitelist      → a.startsWith("docdate_")
//   • shortcodeBlockedStates      → "awaiting_doc_date", "awaiting_doc_date_type"
//   • _bizActiveStates            → "awaiting_doc_date", "awaiting_doc_date_type"
//   • button dispatch (engine)    → docdate_today | docdate_yesterday | docdate_type
//   • typed-text dispatch (bridge)→ states awaiting_doc_date / awaiting_doc_date_type
// ─────────────────────────────────────────────────────────────────────────────

import Business    from "../models/business.js";
import UserSession from "../models/userSession.js";
import { sendButtons, sendText } from "./metaSender.js";
import {
  parseDateInput,
  dateQuickButtons,
  monthShortcodesText,
  previewDateLine,
  toISODate,
  resolveDate
} from "./dateEntry.js";

// ── Safe save for the Mixed sessionData field ────────────────────────────────
// sessionData is a Mongoose Mixed type: mutations are invisible to Mongoose unless
// markModified is called first. Every write in this module goes through here.
async function saveBiz(biz) {
  if (!biz) return;
  biz.markModified("sessionData");
  try {
    await biz.save();
  } catch (e) {
    console.error("[docDateEntry save]", e.message);
  }
}

async function loadBiz(to) {
  const phone   = to.replace(/\D+/g, "");
  const session = await UserSession.findOne({ phone });
  if (!session?.activeBusinessId) return null;
  return Business.findById(session.activeBusinessId);
}

// Friendly heading per flow, e.g. "🧾 Receipt date".
function headingFor(label) {
  const map = {
    invoice:   "📄 Invoice date",
    quote:     "📋 Quotation date",
    quotation: "📋 Quotation date",
    receipt:   "🧾 Receipt date",
    expense:   "💸 Expense date"
  };
  const key = String(label || "").toLowerCase();
  return map[key] || `📅 ${label || "Document"} date`;
}

// ─────────────────────────────────────────────────────────────────────────────
// sendDocDatePrompt(to, { label, ret })
// Entry point. Shows the 3 quick buttons + examples and parks the session in
// "awaiting_doc_date". Existing sessionData (items, client, branch, …) is kept -
// we only add _dateReturn and flip the state, never wipe the draft.
// ─────────────────────────────────────────────────────────────────────────────
export async function sendDocDatePrompt(to, { label = "Document", ret = "doc_finalize" } = {}) {
  const biz = await loadBiz(to);
  if (!biz) return sendText(to, "❌ No active business.");

  biz.sessionData = { ...(biz.sessionData || {}), _dateReturn: ret };
  biz.sessionState = "awaiting_doc_date";
  await saveBiz(biz);

  const heading = headingFor(label);
  const text =
`${heading}

When did this happen?

Tap *Today* or *Yesterday*, or tap *Type a date* to enter another day.

You can also just type it:
• *today* · *yesterday*
• *12/08*  (12 August - day first)
• *12 Aug*  ·  *3 days ago*`;

  return sendButtons(to, { text, buttons: dateQuickButtons("docdate") });
}

// ─────────────────────────────────────────────────────────────────────────────
// handleDocDateAction(to, action)
// Button taps: docdate_today | docdate_yesterday | docdate_type
// ─────────────────────────────────────────────────────────────────────────────
export async function handleDocDateAction(to, action) {
  const biz = await loadBiz(to);
  if (!biz) return sendText(to, "❌ No active business.");

  const a = String(action || "").toLowerCase();

  if (a === "docdate_today" || a === "docdate_yesterday") {
    const parsed = parseDateInput(a === "docdate_today" ? "today" : "yesterday");
    biz.sessionData = { ...(biz.sessionData || {}), docDateISO: parsed.iso };
    await saveBiz(biz);
    return resumeAfterDate(to, biz, parsed);
  }

  // "Type a date" → show month shortcodes + examples, wait for typed text.
  if (a === "docdate_type") {
    biz.sessionState = "awaiting_doc_date_type";
    await saveBiz(biz);
    const text =
`⌨️ *Type the date*

${monthShortcodesText()}

Or simply: *today* · *yesterday* · *3 days ago*`;
    return sendText(to, text);
  }

  // Unknown docdate_* button → re-show the picker.
  return sendDocDatePrompt(to, {
    label: labelFromReturn(biz.sessionData?._dateReturn, biz.sessionData?.docType),
    ret:   biz.sessionData?._dateReturn || "doc_finalize"
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// handleDocDateInput(to, text)
// Typed date while in awaiting_doc_date OR awaiting_doc_date_type.
// ─────────────────────────────────────────────────────────────────────────────
export async function handleDocDateInput(to, text) {
  const biz = await loadBiz(to);
  if (!biz) return sendText(to, "❌ No active business.");

  const parsed = parseDateInput(text);

  if (!parsed) {
    // Unreadable - keep the user in place and show examples again.
    const text2 =
`🤔 I couldn't read that date.

${monthShortcodesText()}

Or tap / type: *today* · *yesterday* · *3 days ago*`;
    return sendButtons(to, { text: text2, buttons: dateQuickButtons("docdate") });
  }

  biz.sessionData = { ...(biz.sessionData || {}), docDateISO: parsed.iso };
  await saveBiz(biz);
  return resumeAfterDate(to, biz, parsed);
}

// ─────────────────────────────────────────────────────────────────────────────
// resumeAfterDate(to, biz, parsed)
// Route back to whatever flow asked for the date. `parsed` is the normalised
// result from dateEntry (has .label for the confirmation line).
// ─────────────────────────────────────────────────────────────────────────────
async function resumeAfterDate(to, biz, parsed) {
  const ret = biz.sessionData?._dateReturn || "doc_finalize";

  // Confirmation line so the user can eyeball the date they just set.
  await sendText(to, `${previewDateLine(parsed?.date)}`);

  if (ret === "expense_entry") {
    // Preserve branch + any items already queued, keep the date, resume entry.
    const prev = biz.sessionData || {};
    biz.sessionData = {
      targetBranchId: prev.targetBranchId,
      bulkExpenses:   Array.isArray(prev.bulkExpenses) ? prev.bulkExpenses : [],
      docDateISO:     prev.docDateISO,
      presetCategory: prev.presetCategory
    };
    biz.sessionState = "expense_smart_entry";
    await saveBiz(biz);

    return sendButtons(to, {
      text:
`💸 *Record Expenses*

Type one or many - same format either way:

Single:  _fuel 30_
Many:  _fuel 30, lunch 15, zesa 50_
With method:  _salary 850 bank_

─────────────────
Type *list* to review  ·  *done* to save  ·  *cancel* to quit`,
      buttons: [
        { id: "exp_show_categories", title: "📂 Pick by Category" },
        { id: "menu",                title: "❌ Cancel" }
      ]
    });
  }

  // Default: document finalize (invoice / quote / receipt).
  // Hand back to the existing confirm→generate path; docDateISO is now set so
  // its date-gate passes straight through to PDF generation.
  biz.sessionState = "creating_invoice_confirm";
  await saveBiz(biz);

  const { continueTwilioFlow } = await import("./twilioStateBridge.js");
  return continueTwilioFlow({ from: to, text: "2" });
}

function labelFromReturn(ret, docType) {
  if (ret === "expense_entry") return "expense";
  return docType || "invoice";
}

// ─────────────────────────────────────────────────────────────────────────────
// resolveDocDate(biz) → Date
// Used by the finalizers. Falls back to now if nothing was chosen.
// ─────────────────────────────────────────────────────────────────────────────
export function resolveDocDate(biz) {
  return resolveDate(biz?.sessionData?.docDateISO);
}

export default {
  sendDocDatePrompt,
  handleDocDateAction,
  handleDocDateInput,
  resolveDocDate
};