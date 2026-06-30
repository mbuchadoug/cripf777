import Business from "../models/business.js";
import UserSession from "../models/userSession.js";
import Client from "../models/client.js";
import { sendText } from "./metaSender.js";
import { sendInvoiceConfirmMenu, sendMainMenu, sendSettingsMenu } from "./metaMenus.js";
import Invoice from "../models/invoice.js";
import Expense from "../models/expense.js";
import Product from "../models/product.js";
import { generatePDF } from "../routes/twilio_biz.js";
import { sendDocument } from "./metaSender.js";
import { sendButtons } from "./metaSender.js";
import { ACTIONS } from "./actions.js";
import { sendList } from "./metaSender.js";
import InvoicePayment from "../models/invoicePayment.js";

import { runDailyReportMetaEnhanced, runWeeklyReportMetaEnhanced, runMonthlyReportMetaEnhanced, runDetailedLedgerReport, runClerkStatementReport, runClerkSelfServeStatement, saveClosingBalance, parseCustomDateRange } from "./dailyReportEnhanced.js";
import {
  parseCommaNames,
  parsePickEntries,
  findUnpricedIndexes,
  buildUnpricedPromptText,
  applyBulkPrices,
  buildDocPreviewText,
  sendDocPreview,
  preserveSessionCore,
  sendAddItemPrompt
} from "./invoiceHelpers.js";


function currencySymbol(cur) {
  const c = (cur || "").toUpperCase();
  if (c === "USD") return "$";
  if (c === "ZWL") return "Z$";
  if (c === "ZAR") return "R";
  return c ? c + " " : "";
}

function formatMoney(amount, currency) {
  const sym = currencySymbol(currency);
  const n = Number(amount);
  if (Number.isNaN(n)) return `${sym}${amount}`;
  return `${sym}${n.toFixed(2)}`;
}

// ── Invoice/quote/receipt full preview ────────────────────────────────────
async function sendInvoicePreview(from, biz, extraNote = "") {
  const items = biz.sessionData.items || [];
  const currency = biz.currency || "USD";
  const docType = biz.sessionData.docType || "invoice";
  const label = docType === "invoice" ? "Invoice" : docType === "quote" ? "Quotation" : "Receipt";

  const discountPercent = Number(biz.sessionData.discountPercent || 0);
  const vatPercent      = Number(biz.sessionData.vatPercent || 0);

  const subtotal      = items.reduce((s, i) => s + Number(i.qty) * Number(i.unit), 0);
  const discountAmt   = subtotal * (discountPercent / 100);
  const vatAmt        = (subtotal - discountAmt) * (vatPercent / 100);
  const total         = subtotal - discountAmt + vatAmt;

  const itemLines = items
    .map((i, idx) =>
      `${idx + 1}. ${i.item} × ${i.qty} @ ${formatMoney(i.unit, currency)} = *${formatMoney(Number(i.qty) * Number(i.unit), currency)}*`
    )
    .join("\n");

  const discountLine = discountPercent > 0
    ? `\n💸 Discount ${discountPercent}%: -${formatMoney(discountAmt, currency)}`
    : "";
  const vatLine = vatPercent > 0
    ? `\n🧾 VAT ${vatPercent}%: +${formatMoney(vatAmt, currency)}`
    : "";

  const preview =
`🧾 *${label} Preview*${extraNote ? "\n" + extraNote : ""}

${itemLines}
─────────────────
Subtotal: ${formatMoney(subtotal, currency)}${discountLine}${vatLine}
*TOTAL: ${formatMoney(total, currency)}*

Tap *Select* to generate PDF or add more items.`;

  return sendInvoiceConfirmMenu(from, preview);
}



async function saveBizSafe(biz) {
  if (!biz) return;
  biz.markModified("sessionData");
  return biz.save();
}



// ─── Helpers ─────────────────────────────────────────────────────────────────

async function sendPromptWithMenu(to, promptText) {
  return sendButtons(to, {
    text: promptText,
    buttons: [{ id: ACTIONS.MAIN_MENU, title: "🏠 Main Menu" }]
  });
}

/**
 * Resolve the effective branchId for any DB write.
 * - Owner → use sessionData.targetBranchId (set by branch picker) or null
 * - Clerk/Manager → use their assigned branchId
 */
import mongoose from "mongoose"; // add at top if not already present

// services/twilioStateBridge.js

/**
 * ✅ ENHANCED BULK EXPENSE STATE MANAGEMENT
 */

// Current state structure (enhance this)
const userStates = new Map();

/**
 * Get or initialize user state
 */
export function getOrCreateState(phone) {
  if (!userStates.has(phone)) {
    userStates.set(phone, {
      currentState: "idle",
      businessId: null,
      branchId: null,
      role: null,
      tempData: {},
      bulkExpenses: [], // ✅ NEW: Store expenses during bulk entry
      lastActivity: Date.now()
    });
  }
  return userStates.get(phone);
}

/**
 * ✅ NEW: Initialize bulk expense session
 */
export function startBulkExpenseSession(phone, businessId, branchId, createdBy) {
  const state = getOrCreateState(phone);
  state.currentState = "bulk_expense_entry";
  state.businessId = businessId;
  state.branchId = branchId;
  state.bulkExpenses = [];
  state.tempData = {
    createdBy,
    sessionStart: Date.now()
  };
  state.lastActivity = Date.now();
  return state;
}

/**
 * ✅ NEW: Add expense to bulk session
 */
export function addExpenseToBulkSession(phone, expenseData) {
  const state = getOrCreateState(phone);
  if (state.currentState !== "bulk_expense_entry") {
    throw new Error("Not in bulk expense mode");
  }
  
  state.bulkExpenses.push({
    amount: expenseData.amount,
    description: expenseData.description,
    category: expenseData.category,
    method: expenseData.method || "Unknown",
    addedAt: Date.now()
  });
  
  state.lastActivity = Date.now();
  return state.bulkExpenses.length;
}

/**
 * ✅ NEW: Get bulk expenses summary
 */
export function getBulkExpenseSummary(phone) {
  const state = getOrCreateState(phone);
  if (!state.bulkExpenses.length) return null;
  
  const total = state.bulkExpenses.reduce((sum, exp) => sum + exp.amount, 0);
  
  // Group by category
  const byCategory = {};
  state.bulkExpenses.forEach(exp => {
    const cat = exp.category || "Other";
    byCategory[cat] = (byCategory[cat] || 0) + exp.amount;
  });
  
  return {
    count: state.bulkExpenses.length,
    total,
    byCategory,
    expenses: state.bulkExpenses
  };
}

/**
 * ✅ NEW: Cancel bulk expense session
 */
export function cancelBulkExpenseSession(phone) {
  const state = getOrCreateState(phone);
  const count = state.bulkExpenses.length;
  state.currentState = "idle";
  state.bulkExpenses = [];
  state.tempData = {};
  return count;
}

/**
 * ✅ NEW: Clear specific expense from bulk session
 */
export function removeExpenseFromBulk(phone, index) {
  const state = getOrCreateState(phone);
  if (state.currentState !== "bulk_expense_entry") return false;
  if (index < 1 || index > state.bulkExpenses.length) return false;
  
  const removed = state.bulkExpenses.splice(index - 1, 1)[0];
  state.lastActivity = Date.now();
  return removed;
}

/**
 * Session timeout (clear after 10 minutes of inactivity)
 */
setInterval(() => {
  const now = Date.now();
  const TIMEOUT = 10 * 60 * 1000; // 10 minutes
  
  for (const [phone, state] of userStates.entries()) {
    if (now - state.lastActivity > TIMEOUT) {
      if (state.currentState === "bulk_expense_entry" && state.bulkExpenses.length > 0) {
        // Don't clear bulk expenses on timeout, just warn
        console.log(`⚠️ Bulk expense session timed out for ${phone} (${state.bulkExpenses.length} unsaved)`);
      } else {
        userStates.delete(phone);
      }
    }
  }
}, 60000); // Check every minute

function getEffectiveBranchId(caller, sessionData) {
  const role = String(caller?.role || "").toLowerCase(); // ✅ normalize role

  if (role === "owner") {
    const id = sessionData?.targetBranchId || null;
    if (!id) return null;

    // ✅ Ensure mongoose can cast it properly
    return mongoose.Types.ObjectId.isValid(id) ? id.toString() : null;
  }

  const b = caller?.branchId || null;
  return b ? b.toString() : null;
}

// ─────────────────────────────────────────────────────────────────────────────

export async function continueTwilioFlow({ from, text }) {
  const phone = from.replace(/\D+/g, "");

  if (!phone || phone.length < 9 || phone.length > 15) {
    console.error("❌ Invalid phone for session key:", { from, phone, text });
    return true;
  }

  const session = await UserSession.findOne({ phone });
  if (!session?.activeBusinessId) return false;

  const biz = await Business.findById(session.activeBusinessId);
  if (!biz || !biz.sessionState) return false;

  // ============================
  // 🔒 ROLE GUARD
  // ============================
  const UserRole = (await import("../models/userRole.js")).default;
  const { canAccessSection } = await import("./roleGuard.js");

  const caller = await UserRole.findOne({ businessId: biz._id, phone, pending: false });

// ✅ normalize for all comparisons
if (caller) caller.role = String(caller.role || "clerk").toLowerCase();

  // Locked users are blocked
  if (caller?.locked) {
    await sendText(from, "🔒 Your account has been suspended. Please contact the business owner.");
    biz.sessionState = "ready";
    biz.sessionData = {};
    await saveBizSafe(biz);
    return true;
  }

  // Unknown users blocked
  if (!caller) {
    await sendText(from, "❌ Access denied.");
    biz.sessionState = "ready";
    biz.sessionData = {};
    await saveBizSafe(biz);
    return true;
  }

const restrictedStateMap = {
    settings_currency: "settings",
    settings_terms: "settings",
    settings_inv_prefix: "settings",
    settings_qt_prefix: "settings",
    settings_rcpt_prefix: "settings",
    branch_add_name: "branches",
    report_daily:            "reports",
    report_weekly:           "reports",
    report_monthly:          "reports",
    report_choose_branch:    "reports",
    report_detailed:         "reports",
    report_detailed_week:    "reports",
    report_detailed_month:   "reports",
    report_detailed_year:    "reports",
    report_clerk_statement:  "reports",
    report_clerk_pick:       "reports",
    report_clerk_pick_custom: "reports",
    report_date_filter:       "reports",
    // Recurring billing
    rb_payment_pick_account:     "payments",
    rb_payment_pick_tenant:      "payments",
    rb_payment_enter_amount:     "payments",
    rb_payment_confirm:          "payments",
    rb_acct_stmt_pick_account:   "reports",
    rb_acct_stmt_pick_period:    "reports",
    rb_acct_stmt_custom_date:    "reports",
    rb_tenant_stmt_pick_account: "reports",
    rb_tenant_stmt_pick_tenant:  "reports",
    rb_tenant_stmt_pick_period:  "reports",
    rb_expense_pick_account:     "payments",
    rb_expense_enter_details:    "payments",
    payment_amount: "payments",
    payment_method: "payments",
    expense_amount: "payments",
    expense_category: "payments",
    cash_set_opening_balance: "payments",
    cash_payout_amount:   "payments",
    cash_payout_reason:   "payments",
    cash_handover_amount:   "payments",
    cash_handover_incoming: "payments",
    cash_handover_note:     "payments",
  invite_user_phone: "users",
    sales_doc_search: "sales",
    sales_doc_list: "sales",
    sales_doc_filter: "sales"
    // Supplier states are intentionally NOT restricted -
    // any role (owner, clerk, manager) can access the supplier marketplace
  };

  const section = restrictedStateMap[biz.sessionState];
  if (section && !canAccessSection(caller.role, section)) {
    await sendText(from, "🔒 You do not have permission to perform this action.");
    biz.sessionState = "ready";
    biz.sessionData = {};
    await saveBizSafe(biz);
    await sendMainMenu(from);
    return true;
  }

  const trimmed = text.trim();
  const a = trimmed;  // action id - for rb_* handlers called with text: actionId
  const state = biz.sessionState;

  if (state === "ready") return false;

  // Universal cancel / menu escape
  const cancelWords = ["cancel", "menu", "0"];
  if (cancelWords.includes(trimmed.toLowerCase())) {
    biz.sessionState = "ready";
    biz.sessionData = {};
    await saveBizSafe(biz);
    await sendMainMenu(from);
    return true;
  }




/* ===========================
   SALES DOC LIST - type a number to open
   e.g. user sees numbered list and types "3"
=========================== */
if (state === "sales_doc_list") {
  const num = parseInt(trimmed);
  const ids    = biz.sessionData?.docListIds || [];
  const offset = biz.sessionData?.docListOffset || 0;

  if (!isNaN(num) && num >= 1) {
    const localIdx = num - offset - 1; // convert display number to array index
    const docId    = ids[localIdx];
    if (docId) {
      const doc = await Invoice.findById(docId).lean();
      if (doc) {
        biz.sessionState = "sales_doc_action";
        biz.sessionData  = { docId };
        await saveBizSafe(biz);

        const statusEmoji = doc.status === "paid" ? "✅" : doc.status === "partial" ? "⏳" : "🔴";
        const docText =
`📄 *${doc.number}*
Type: ${doc.type} | ${statusEmoji} ${doc.status}
Total: $${Number(doc.total || 0).toFixed(2)} ${doc.currency || ""}
Paid: $${Number(doc.amountPaid || 0).toFixed(2)} | Balance: $${Number(doc.balance || 0).toFixed(2)}`;

        const isManager = caller && ["owner", "manager"].includes(caller.role);
        if (isManager) {
          return sendButtons(from, {
            text: docText,
            buttons: [
              { id: ACTIONS.VIEW_DOC,   title: "📄 View PDF" },
              { id: ACTIONS.DELETE_DOC, title: "🗑 Delete" },
              { id: ACTIONS.SALES_MENU, title: "⬅ Back" }
            ]
          });
        }
        return sendButtons(from, {
          text: docText,
          buttons: [
            { id: ACTIONS.VIEW_DOC,   title: "📄 View PDF" },
            { id: ACTIONS.SALES_MENU, title: "⬅ Back" },
            { id: ACTIONS.MAIN_MENU,  title: "🏠 Main Menu" }
          ]
        });
      }
    }
  }

  // Not a valid number - remind user
  await sendText(from, `❌ Type the item number from the list (1–${ids.length + offset}) to open it, or use the buttons below.`);
  return true;
}

/* ===========================
   SALES DOC SEARCH - user typed a search term
=========================== */
/* ===========================
   SALES DOC SEARCH - user typed a search term
=========================== */
if (state === "sales_doc_search") {
  const searchTerm = trimmed;
  if (!searchTerm || searchTerm.length < 1) {
    await sendText(from, "❌ Type something to search for.");
    return true;
  }

  const docType    = biz.sessionData?.docSearchType   || "invoice";
  const branchRaw  = biz.sessionData?.docSearchBranch ?? undefined;
  const branchId   = branchRaw === undefined ? undefined : (branchRaw || null);

  // Clear state before calling showSalesDocs
  biz.sessionState = "ready";
  biz.sessionData  = {};
  await saveBizSafe(biz);

  // Dynamically import showSalesDocs from chatbotEngine
  // (it's not exported, so we trigger via the session flag approach - but that breaks)
  // Instead: do the search query RIGHT HERE and build the list
  const Invoice = (await import("../models/invoice.js")).default;
  const Client  = (await import("../models/client.js")).default;
  const Branch  = (await import("../models/branch.js")).default;
  const Business = (await import("../models/business.js")).default;

  const query = { businessId: biz._id, type: docType };
  if (branchId !== undefined && branchId !== null) query.branchId = branchId;

  // Search by number or client name
  const matchedClients = await Client.find({
    businessId: biz._id,
    name: { $regex: searchTerm, $options: "i" }
  }).distinct("_id");

  query.$or = [
    { number: { $regex: searchTerm, $options: "i" } },
    ...(matchedClients.length ? [{ clientId: { $in: matchedClients } }] : [])
  ];

  const PAGE_SIZE = 8;
  const total     = await Invoice.countDocuments(query);

  if (!total) {
    await sendText(from, `📄 No ${docType}s found for "*${searchTerm}*".`);
    const { sendSalesMenu } = await import("./metaMenus.js");
    return sendSalesMenu(from);
  }

  const docs = await Invoice.find(query).sort({ createdAt: -1 }).limit(PAGE_SIZE).lean();

  const clientIds  = [...new Set(docs.map(d => d.clientId?.toString()).filter(Boolean))];
  const clients    = await Client.find({ _id: { $in: clientIds } }).lean();
  const clientMap  = Object.fromEntries(clients.map(c => [c._id.toString(), c.name || c.phone || "-"]));

  let msg = `📄 *${docType[0].toUpperCase() + docType.slice(1)}s* 🔍 "${searchTerm}"\n${total} result(s)\n\n`;
  docs.forEach((d, i) => {
    const statusIcon = d.status === "paid" ? "✅" : d.status === "partial" ? "⏳" : "🔴";
    const clientName = clientMap[d.clientId?.toString()] || "";
    const dateStr    = d.createdAt ? new Date(d.createdAt).toLocaleDateString("en-GB", { day: "numeric", month: "short" }) : "";
    msg += `${i + 1}. *${d.number}* ${statusIcon}\n`;
    msg += `   $${Number(d.total || 0).toFixed(2)} ${d.currency || ""}`;
    if (clientName) msg += ` · ${clientName}`;
    if (dateStr)    msg += ` · ${dateStr}`;
    msg += "\n";
  });
  msg += `\nType a number to open it.`;

  // Store in session for number selection
  const bizDoc = await Business.findById(biz._id);
  bizDoc.sessionState = "sales_doc_list";
  bizDoc.sessionData  = {
    docListType:   docType,
    docListPage:   0,
    docListBranch: branchId,
    docListSearch: searchTerm,
    docListFilter: null,
    docListIds:    docs.map(d => d._id.toString()),
    docListOffset: 0
  };
  bizDoc.markModified("sessionData");
  await bizDoc.save();

  await sendText(from, msg);

  const typeCode = docType === "invoice" ? "inv" : docType === "quote" ? "qt" : "rct";
  const bCode    = branchId || "all";
  return sendButtons(from, {
    text: "Open by number or change filter:",
    buttons: [
      { id: `vdoc_filter_${typeCode}_${bCode}`, title: "📅 Filter by Date" },
      { id: ACTIONS.SALES_MENU,                 title: "⬅ Back" }
    ]
  });
}


/* ===========================
   PAYMENT: SELECT INVOICE BY NUMBER
   User types "3" to pick invoice #3 from the list
=========================== */
if (state === "payment_select_invoice") {
  const num    = parseInt(trimmed);
  const ids    = biz.sessionData?.invoiceListIds    || [];
  const offset = biz.sessionData?.invoiceListOffset || 0;

  if (!isNaN(num) && num >= 1) {
    const localIdx = num - offset - 1;
    const invoiceId = ids[localIdx];
    if (invoiceId) {
      const invoice = await Invoice.findById(invoiceId);
      if (invoice) {
        biz.sessionState = "payment_amount";
        biz.sessionData  = { invoiceId: invoice._id };
        await saveBizSafe(biz);
        return sendButtons(from, {
          text:
`💳 *${invoice.number}*
Total:   $${Number(invoice.total || 0).toFixed(2)} ${invoice.currency}
Paid:    $${Number(invoice.amountPaid || 0).toFixed(2)}
Balance: *$${Number(invoice.balance || 0).toFixed(2)}*

Type amount or tap Full Balance:`,
          buttons: [
            { id: `payinv_full_${invoice._id}`, title: "✅ Pay Full Balance" },
            { id: ACTIONS.MAIN_MENU,            title: "❌ Cancel" }
          ]
        });
      }
    }
  }

  await sendText(from, `❌ Invalid number. Type a number between 1 and ${ids.length + offset}.`);
  return true;
}

/* ===========================
   PAYMENT: INVOICE SEARCH
   User typed search term after tapping Search
=========================== */
if (state === "payment_invoice_search") {
  const searchTerm = trimmed;
  if (!searchTerm) { await sendText(from, "❌ Type an invoice number to search."); return true; }
  const branchId = biz.sessionData?.invoiceSearchBranch || null;
  biz.sessionState = "ready"; biz.sessionData = {};
  await saveBizSafe(biz);
  const { showUnpaidInvoices } = await import("./paymentAdapters.js");
  await showUnpaidInvoices(from, branchId, 0, searchTerm);
  return true;
}
  /* ===========================
     CLIENT STATEMENT
  ============================ */

  if (state === "client_statement_generate") {
    const clientId = biz.sessionData.clientId;
    if (!clientId) { biz.sessionState = "ready"; biz.sessionData = {}; await saveBizSafe(biz); await sendMainMenu(from); return true; }

    const ClientModel = (await import("../models/client.js")).default;
    const client = await ClientModel.findById(clientId).lean();
    if (!client) { await sendText(from, "❌ Client not found."); await sendMainMenu(from); return true; }

    const { buildClientStatement } = await import("./clientStatement.js");
    const ledger = await buildClientStatement({
      businessId: biz._id, clientId,
      branchId: getEffectiveBranchId(caller, biz.sessionData)
    });

    const { filename } = await generatePDF({
      type: "statement", billingTo: client.name || client.phone, ledger,
      bizMeta: { name: biz.name, logoUrl: biz.logoUrl, address: biz.address || "", _id: biz._id.toString() }
    });

    const site = (process.env.SITE_URL || "").replace(/\/$/, "");
    const url = `${site}/docs/generated/statements/${filename}`;
    await sendDocument(from, { link: url, filename });
    biz.sessionState = "ready"; biz.sessionData = {}; await saveBizSafe(biz);
    await sendMainMenu(from);
    return true;
  }

  /* ===========================
     SETTINGS: TEXT INPUT HANDLERS
  =========================== */

  if (state === "settings_currency") {
    const cur = trimmed.toUpperCase();
    if (!["ZWL", "USD", "ZAR"].includes(cur)) { await sendPromptWithMenu(from, "❌ Invalid currency. Use USD, ZWL or ZAR:"); return true; }
    biz.currency = cur; biz.sessionState = "settings_menu"; biz.sessionData = {}; await saveBizSafe(biz);
    await sendText(from, `✅ Currency updated to *${cur}*`);
    await sendSettingsMenu(from);
    return true;
  }

  if (state === "settings_terms") {
    const days = Number(trimmed);
    if (isNaN(days) || days < 0) { await sendPromptWithMenu(from, "❌ Enter a valid number of days (e.g. 30):"); return true; }
    biz.paymentTermsDays = days; biz.sessionState = "settings_menu"; biz.sessionData = {}; await saveBizSafe(biz);
    await sendText(from, `✅ Payment terms set to *${days} days*`);
    await sendSettingsMenu(from);
    return true;
  }

  if (state === "settings_inv_prefix") {
    if (!trimmed) { await sendPromptWithMenu(from, "❌ Prefix cannot be empty. Enter a valid invoice prefix:"); return true; }
    biz.invoicePrefix = trimmed.toUpperCase(); biz.sessionState = "settings_menu"; biz.sessionData = {}; await saveBizSafe(biz);
    await sendText(from, `✅ Invoice prefix updated to *${biz.invoicePrefix}*`);
    await sendSettingsMenu(from);
    return true;
  }

  if (state === "settings_qt_prefix") {
    if (!trimmed) { await sendPromptWithMenu(from, "❌ Prefix cannot be empty. Enter a valid quote prefix:"); return true; }
    biz.quotePrefix = trimmed.toUpperCase(); biz.sessionState = "settings_menu"; biz.sessionData = {}; await saveBizSafe(biz);
    await sendText(from, `✅ Quote prefix updated to *${biz.quotePrefix}*`);
    await sendSettingsMenu(from);
    return true;
  }

  if (state === "settings_rcpt_prefix") {
    if (!trimmed) { await sendPromptWithMenu(from, "❌ Prefix cannot be empty. Enter a valid receipt prefix:"); return true; }
    biz.receiptPrefix = trimmed.toUpperCase(); biz.sessionState = "settings_menu"; biz.sessionData = {}; await saveBizSafe(biz);
    await sendText(from, `✅ Receipt prefix updated to *${biz.receiptPrefix}*`);
    await sendSettingsMenu(from);
    return true;
  }

  if (!biz.sessionData.client && biz.sessionData.clientId) {
    const client = await Client.findById(biz.sessionData.clientId);
    if (client) { biz.sessionData.client = client; await saveBizSafe(biz); }
  }

  if (state === "report_daily")   return runDailyReportMetaEnhanced({ biz, from });
  if (state === "report_weekly")  return runWeeklyReportMetaEnhanced({ biz, from });
  if (state === "report_monthly") return runMonthlyReportMetaEnhanced({ biz, from });

  // ── Detailed Ledger states ────────────────────────────────────────────────
  if (state === "report_detailed")       return runDetailedLedgerReport({ biz, from, period: "day"   });
  if (state === "report_detailed_week")  return runDetailedLedgerReport({ biz, from, period: "week"  });
  if (state === "report_detailed_month") return runDetailedLedgerReport({ biz, from, period: "month" });
  if (state === "report_detailed_year")  return runDetailedLedgerReport({ biz, from, period: "year"  });
  if (state === "report_detailed_custom") {
    const { customStart, customEnd } = biz.sessionData || {};
    if (!customStart || !customEnd) { biz.sessionState = "ready"; biz.sessionData = {}; await saveBizSafe(biz); return sendMainMenu(from); }
    return runDetailedLedgerReport({ biz, from, period: "custom", customStart: new Date(customStart), customEnd: new Date(customEnd) });
  }

  // ── Clerk statement: pick a clerk then show their statement ──────────────

  // ── Clerk picker for custom-date clerk statement ────────────────────────────
  // Entered after user typed a custom date range and filterFor === "clerk"
  // On first pass: shows staff list. On second pass (clerkPhone set): runs report.
  if (state === "report_clerk_pick_custom") {
    if (biz.sessionData?.clerkPhone) {
      const clerkPhone  = biz.sessionData.clerkPhone;
      const customStart = biz.sessionData.customStart ? new Date(biz.sessionData.customStart) : null;
      const customEnd   = biz.sessionData.customEnd   ? new Date(biz.sessionData.customEnd)   : null;
      biz.sessionState  = "ready"; biz.sessionData = {}; await saveBizSafe(biz);
      return runClerkStatementReport({ biz, from, clerkPhone, period: "custom", customStart, customEnd });
    }
    // First pass: show clerk list
    const UserRoleModel = (await import("../models/userRole.js")).default;
    const branchId = caller?.role !== "owner" ? caller?.branchId : null;
    const q = { businessId: biz._id, pending: false };
    if (branchId) q.branchId = branchId;
    const staff = await UserRoleModel.find(q).lean();
    if (!staff.length) {
      await sendText(from, "❌ No staff found for this business.");
      biz.sessionState = "ready"; biz.sessionData = {}; await saveBizSafe(biz);
      return sendMainMenu(from);
    }
    const items = staff.map(u => ({
      id:    `rpt_clk_custom_pick_${u.phone}`,
      title: `👤 ${u.name || u.phone} (${u.role || "clerk"})`
    }));
    items.push({ id: ACTIONS.MAIN_MENU, title: "🏠 Main Menu" });
    await sendList(from, "👤 Select clerk for statement:", items);
    return true;
  }

  if (state === "report_clerk_pick") {
    // If clerkPhone already chosen (second pass), run the statement
    if (biz.sessionData?.clerkPhone) {
      const clerkPhone = biz.sessionData.clerkPhone;
      const period     = biz.sessionData.clerkPeriod || "day";
      biz.sessionState = "ready"; biz.sessionData = {}; await saveBizSafe(biz);
      return runClerkStatementReport({ biz, from, clerkPhone, period });
    }
    // First pass: show list of staff for this business
    const UserRoleModel = (await import("../models/userRole.js")).default;
    const Branch        = (await import("../models/branch.js")).default;
    const branchId      = caller?.role !== "owner" ? caller?.branchId : null;
    const q = { businessId: biz._id, pending: false };
    if (branchId) q.branchId = branchId;
    const staff = await UserRoleModel.find(q).lean();
    if (!staff.length) {
      await sendText(from, "❌ No staff found for this business.");
      biz.sessionState = "ready"; biz.sessionData = {}; await saveBizSafe(biz);
      return sendMainMenu(from);
    }
    const items = staff.map((u, i) => {
      const name = u.name || u.phone;
      return { id: `clerk_stmt_pick_${u.phone}`, title: `👤 ${name} (${u.role || "clerk"})` };
    });
    items.push({ id: ACTIONS.MAIN_MENU, title: "🏠 Main Menu" });
    await sendList(from, "👤 Select clerk for statement:", items);
    return true;
  }

  // ── Self clerk statement (clerk views own statement) ──────────────────────
  // ── Clerk self-serve: clerk views their own statement ──────────────────────
  if (state === "report_clerk_self") {
    const period = biz.sessionData?.clerkPeriod || "month";
    const customStart = biz.sessionData?.customStart || null;
    const customEnd   = biz.sessionData?.customEnd   || null;
    return runClerkSelfServeStatement({ biz, from, period, customStart, customEnd });
  }

  if (state === "report_clerk_statement") {
    let phone2 = from.replace(/\D+/g, "");
    if (phone2.startsWith("0")) phone2 = "263" + phone2.slice(1);
    const period = biz.sessionData?.clerkPeriod || "day";
    biz.sessionState = "ready"; biz.sessionData = {}; await saveBizSafe(biz);
    return runClerkStatementReport({ biz, from, clerkPhone: phone2, period });
  }

  /* ===========================
     BRANCH REPORT - CHOOSE BRANCH
  =========================== */
  if (state === "report_choose_branch") {
    if ("reportBranchId" in (biz.sessionData || {})) return false;

    const Branch = (await import("../models/branch.js")).default;
    const branches = await Branch.find({ businessId: biz._id }).lean();

    if (!branches || branches.length === 0) {
      await sendText(from, "⚠️ No branches found. Create a branch first.");
      biz.sessionState = "ready"; biz.sessionData = {}; await saveBizSafe(biz);
      await sendMainMenu(from);
      return true;
    }

    const branchOptions = [
      ...branches.map(b => ({ id: `report_branch_${b._id}`, title: `🏬 ${b.name}` })),
      { id: "report_branch_all", title: "📊 All Branches" },
      { id: ACTIONS.BACK, title: "⬅ Back" }
    ];

    const reportType = biz.sessionData?.reportType || "daily";
    await sendList(from, `Select branch for ${reportType} report:`, branchOptions);
    return true;
  }


/* ===========================
   SELECT BRANCH (generic)
   - First entry: show list
   - Next message: accept number, set targetBranchId, resume via branchReturn
=========================== */
if (state === "select_branch") {
  const Branch = (await import("../models/branch.js")).default;

  // Always ensure there is at least one branch
  let branches = await Branch.find({ businessId: biz._id }).sort({ name: 1 }).lean();
  if (!branches.length) {
    const { ensureDefaultBranch } = await import("./ensureDefaultBranch.js");
    await ensureDefaultBranch(biz._id);
    branches = await Branch.find({ businessId: biz._id }).sort({ name: 1 }).lean();
  }

  // 1) If we haven't shown the list yet → show it and mark as shown
  if (!biz.sessionData?.branchPickerShown) {
    const lines = branches.map((b, idx) => `${idx + 1}) ${b.name}`).join("\n");

    biz.sessionData = biz.sessionData || {};
    biz.sessionData.branchPickerShown = true;
    await saveBizSafe(biz);

    await sendText(from, `🏢 Select branch:\n${lines}\n\nReply with number.`);
    return true;
  }

  // 2) We already showed the list → now we expect a number reply
  const choice = Number(trimmed);
  if (isNaN(choice) || choice < 1 || choice > branches.length) {
    await sendText(from, `❌ Invalid choice. Reply with a number between 1 and ${branches.length}.`);
    return true;
  }

  const selected = branches[choice - 1];

  // Store selection
  biz.sessionData = biz.sessionData || {};
  const ret = biz.sessionData.branchReturn; // { kind: "...", ... }
  biz.sessionData.targetBranchId = selected._id.toString();

  // Clear picker flags
  delete biz.sessionData.branchPickerShown;
  delete biz.sessionData.branchReturn;

  await saveBizSafe(biz);

  // ✅ Resume flow depending on why we asked for branch
  // (A) New doc flow
  if (ret?.kind === "new_doc") {
    biz.sessionState = "creating_invoice_choose_client"; // your start state
    biz.sessionData = { ...(biz.sessionData || {}), docType: ret.docType, items: [] };
    await saveBizSafe(biz);
    await sendText(from, `${ret.docType.toUpperCase()}:\n1) Use saved client\n2) New client\n3) Cancel`);
    return true;
  }

  // (B) Add client flow
  if (ret?.kind === "add_client") {
    biz.sessionState = "adding_client_name";
    biz.sessionData = { ...(biz.sessionData || {}) };
    await saveBizSafe(biz);
    await sendText(from, "Enter client name:");
    return true;
  }

  // Fallback
  biz.sessionState = "ready";
  await saveBizSafe(biz);
  await sendMainMenu(from);
  return true;
}
  /* ===========================
     INVITE USER: ENTER PHONE
  =========================== */
  if (state === "invite_user_phone") {
    const raw = trimmed.replace(/\D+/g, "");
    let p = raw;
    if (p.startsWith("0")) p = "263" + p.slice(1);

    if (!p.startsWith("263") || p.length !== 12) {
      await sendPromptWithMenu(from, "❌ Invalid WhatsApp number. Use 0772123456 or +263772123456");
      return true;
    }

    const UserRoleModel = (await import("../models/userRole.js")).default;
    const Branch = (await import("../models/branch.js")).default;

    const branchId = biz.sessionData.branchId;
    const branch = await Branch.findById(branchId);
    if (!branch) { biz.sessionState = "ready"; biz.sessionData = {}; await saveBizSafe(biz); await sendText(from, "⚠️ Branch not found."); await sendMainMenu(from); return true; }

    const exists = await UserRoleModel.findOne({ businessId: biz._id, phone: p, pending: false });
    if (exists) { await sendText(from, "⚠️ User already exists in your business."); await sendMainMenu(from); return true; }

    await UserRoleModel.findOneAndUpdate(
      { businessId: biz._id, phone: p },
      { businessId: biz._id, phone: p, role: "clerk", branchId: branch._id, pending: true },
      { upsert: true }
    );

    const bot = process.env.TWILIO_WHATSAPP_NUMBER.replace(/\D+/g, "");
    const joinLink = `https://wa.me/${bot}?text=JOIN`;

    await sendText(from,
`✅ Invitation created

📍 Branch: ${branch.name}
🔑 Role: Clerk

👉 Share this link with the user:
${joinLink}

They must click it to join.`);

    biz.sessionState = "ready"; biz.sessionData = {}; await saveBizSafe(biz);
    await sendMainMenu(from);
    return true;
  }

  /* ===========================
     BRANCH: ADD BRANCH
  =========================== */
 if (state === "branch_add_name") {
  const name = trimmed;
  if (!name) { await sendPromptWithMenu(from, "🏬 Branch name cannot be empty. Enter branch name:"); return true; }

  const Branch = (await import("../models/branch.js")).default;

  // If this is the first ever branch, mark it default
  const count = await Branch.countDocuments({ businessId: biz._id });
  const isDefault = count === 0;

  const created = await Branch.create({ businessId: biz._id, name, isDefault });

  await sendText(from, `✅ Branch *"${name}"* added.`);

  // ✅ RESUME: if we came from a branch picker, continue that flow
  const ret = biz.sessionData?.branchReturn;

  biz.sessionState = "ready";
  biz.sessionData = biz.sessionData || {};
  // auto-select the new branch for owner flows
  biz.sessionData.targetBranchId = created._id.toString();

  // clear branchReturn after reading it
  delete biz.sessionData.branchReturn;

  await saveBizSafe(biz);

  // Resume behavior:
  // (1) New Doc: continue directly
  if (ret?.kind === "new_doc") {
    biz.sessionState = "creating_invoice_choose_client"; // <- use your real start state
    biz.sessionData.docType = ret.docType;
    await saveBizSafe(biz);
    // call your “start doc flow” function or send the first prompt
    await sendText(from, `✅ Starting ${ret.docType} for *${name}*...`);
    return true;
  }

  // (2) View lists: send the same selector menu again (now includes the new branch)
 

  // fallback
  await sendMainMenu(from);
  return true;
}

  /* ===========================
     EXPENSE: CATEGORY
  =========================== */
 /* ===========================
   EXPENSE: QUICK ENTRY
   Format: "category, amount, method, description"
   Examples:
     rent, 150, cash, monthly rent
     transport, 30, ecocash
     supplies, 45.50, bank, office paper and pens
=========================== */
/* ===========================
   EXPENSE STEP 1 - CATEGORY TAPPED
   User taps from category list → ask for amount only
=========================== */
if (state === ACTIONS.EXPENSE_CATEGORY || state === "expense_category") {
  const CAT_MAP = {
    exp_cat_rent:        "Rent",
    exp_cat_utilities:   "Utilities",
    exp_cat_transport:   "Transport",
    exp_cat_supplies:    "Supplies",
    exp_cat_salaries:    "Salaries",
    exp_cat_maintenance: "Maintenance",
    exp_cat_other:       "Other"
  };
  const category = CAT_MAP[text];
  if (!category) { await sendText(from, "❌ Please select a category from the list."); return true; }

  biz.sessionData.prefillCat   = category;
  biz.sessionData.description  = category;
  biz.sessionState = "expense_amount";
  await saveBizSafe(biz);

  return sendButtons(from, {
    text: `${category}\n\n💵 Enter amount:\n_e.g.  150  or  150 school fees_`,
    buttons: [{ id: ACTIONS.MAIN_MENU, title: "❌ Cancel" }]
  });
}

/* ===========================
   EXPENSE STEP 2 - AMOUNT TYPED
   "150"  or  "150 school fees"
   → shows Cash / EcoCash / Bank buttons immediately
=========================== */
if (state === "expense_amount") {
  const sp    = trimmed.indexOf(" ");
  const amt   = Number(sp > 0 ? trimmed.slice(0, sp) : trimmed);
  const note  = sp > 0 ? trimmed.slice(sp + 1).trim() : "";

  if (isNaN(amt) || amt <= 0) {
    await sendText(from, "❌ Enter the amount.\n\nExamples:\n*150*\n*150 school fees*");
    return true;
  }

  biz.sessionData.amount = amt;
  if (note) biz.sessionData.description = note;
  biz.sessionState = "expense_method";
  await saveBizSafe(biz);

  const cat  = biz.sessionData.prefillCat  || "Expense";
  const desc = biz.sessionData.description || cat;

  return sendButtons(from, {
    text: `${cat} - *${formatMoney(amt, biz.currency)}*\n_${desc}_\n\n💳 How was it paid?`,
    buttons: [
      { id: "exp_method_cash",    title: "💵 Cash" },
      { id: "exp_method_ecocash", title: "📱 EcoCash" },
      { id: "exp_method_bank",    title: "🏦 Bank" }
    ]
  });
}

/* ===========================
   EXPENSE STEP 3 - METHOD TAPPED → SAVE + PDF
   Saves immediately, no confirm screen
=========================== */
if (state === "expense_method" || state === ACTIONS.EXPENSE_METHOD) {
  const methodMap = {
    exp_method_cash:    "Cash",
    exp_method_bank:    "Bank",
    exp_method_ecocash: "EcoCash",
    exp_method_other:   "Other"
  };
  const method = methodMap[text];

  if (!method) {
    await sendButtons(from, {
      text: "💳 How was it paid?",
      buttons: [
        { id: "exp_method_cash",    title: "💵 Cash" },
        { id: "exp_method_ecocash", title: "📱 EcoCash" },
        { id: "exp_method_bank",    title: "🏦 Bank" }
      ]
    });
    return true;
  }

  const effectiveBranchId = getEffectiveBranchId(caller, biz.sessionData);
  const expense = await Expense.create({
    businessId:  biz._id,
    branchId:    effectiveBranchId,
    amount:      biz.sessionData.amount,
    category:    biz.sessionData.prefillCat    || "Other",
    description: biz.sessionData.description  || biz.sessionData.prefillCat || "Other",
    method,
    createdBy:   phone
  });

  const savedBranchId = biz.sessionData.targetBranchId;
  biz.sessionData  = { targetBranchId: savedBranchId };
  biz.sessionState = "expense_add_another_menu";
  await saveBizSafe(biz);

  await sendText(from,
    `✅ *${expense.category}* - ${formatMoney(expense.amount, biz.currency)} (${method})`
  );

  const { sendExpenseAddAnotherMenu } = await import("./metaMenus.js");
  await sendExpenseAddAnotherMenu(from);
  return true;
}

/* =====================================================
   SMART BULK ENTRY - "fuel 30, lunch 15, zesa 50"
   State: expense_smart_entry
   User keeps typing expenses until they type "done"
   Single item → immediate Save/Add More choice
   Multiple → running total, type done when finished
===================================================== */
if (state === "expense_smart_entry") {
  const KEYWORD_CAT = {
    zesa:"Utilities", electricity:"Utilities", prepaid:"Utilities",
    water:"Utilities", airtime:"Utilities", wifi:"Utilities",
    internet:"Utilities", netone:"Utilities", econet:"Utilities", telecel:"Utilities",
    fuel:"Transport", petrol:"Transport", diesel:"Transport",
    transport:"Transport", commuter:"Transport", kombi:"Transport",
    taxi:"Transport", uber:"Transport", bus:"Transport",
    rent:"Rent", lease:"Rent", rental:"Rent",
    salaries:"Salaries", salary:"Salaries", wages:"Salaries",
    wage:"Salaries", staff:"Salaries", workers:"Salaries",
    supplies:"Supplies", stationery:"Supplies", paper:"Supplies",
    toner:"Supplies", printing:"Supplies",
    maintenance:"Maintenance", repair:"Maintenance", service:"Maintenance",
    lunch:"Supplies", tea:"Supplies", food:"Supplies"
  };
  const METHOD_MAP = {
    cash:"Cash", ecocash:"EcoCash", eco:"EcoCash",
    bank:"Bank", transfer:"Bank", swipe:"Bank"
  };

  const raw   = trimmed;
  const lower = raw.toLowerCase();

  // ── Button: cancel ────────────────────────────────────────────────────────
  if (lower === "cancel" || lower === "stop") {
    const count = biz.sessionData?.bulkExpenses?.length || 0;
    biz.sessionState = "ready"; biz.sessionData = {};
    await saveBizSafe(biz);
    await sendText(from, count > 0 ? `❌ Cancelled - ${count} item(s) discarded.` : "❌ Cancelled.");
    await sendMainMenu(from);
    return true;
  }

  // ── Button: show list ─────────────────────────────────────────────────────
  if (lower === "list" || lower === "show") {
    const items = biz.sessionData?.bulkExpenses || [];
    if (!items.length) {
      return sendButtons(from, {
        text: "📝 Nothing added yet.\n\nType expenses like:\n_fuel 30, lunch 15, zesa 50_",
        buttons: [{ id: ACTIONS.MAIN_MENU, title: "❌ Cancel" }]
      });
    }
    const total = items.reduce((s, e) => s + e.amount, 0);
    const lines = items.map((e, i) =>
      `${i + 1}. ${e.description} - ${formatMoney(e.amount, biz.currency)} (${e.method})`
    ).join("\n");
    biz.sessionState = "expense_bulk_confirm";
    await saveBizSafe(biz);
    return sendButtons(from, {
      text:
`📋 *${items.length} expense(s)*

${lines}
─────────────────
*Total: ${formatMoney(total, biz.currency)}*`,
      buttons: [
        { id: "exp_bulk_confirm_yes", title: "✅ Save All" },
        { id: "exp_bulk_keep_adding", title: "➕ Add More" }
      ]
    });
  }

  // ── Button: remove N ─────────────────────────────────────────────────────
  const removeMatch = lower.match(/^(?:remove|delete)\s+(\d+)$/);
  if (removeMatch) {
    const idx   = parseInt(removeMatch[1]) - 1;
    const items = biz.sessionData?.bulkExpenses || [];
    if (idx < 0 || idx >= items.length) {
      await sendText(from, `❌ Item ${idx + 1} not found.`);
      return true;
    }
    const removed = items.splice(idx, 1)[0];
    biz.markModified("sessionData");
    await saveBizSafe(biz);
    const total = items.reduce((s, e) => s + e.amount, 0);
    return sendButtons(from, {
      text: `✅ Removed: *${removed.description}* - ${formatMoney(removed.amount, biz.currency)}\n${items.length} item(s) remaining - ${formatMoney(total, biz.currency)}`,
      buttons: items.length
        ? [
            { id: "exp_bulk_confirm_yes", title: "✅ Save All" },
            { id: "exp_bulk_keep_adding", title: "➕ Add More" }
          ]
        : [{ id: ACTIONS.MAIN_MENU, title: "🏠 Main Menu" }]
    });
  }

  // ── "done" / "save" typed (button taps handled in expense_bulk_confirm) ──
  if (lower === "done" || lower === "save" || lower === "finish") {
    const items = biz.sessionData?.bulkExpenses || [];
    if (!items.length) {
      biz.sessionState = "ready"; biz.sessionData = {};
      await saveBizSafe(biz);
      await sendText(from, "❌ Nothing to save.");
      await sendMainMenu(from);
      return true;
    }
    const total = items.reduce((s, e) => s + e.amount, 0);
    const lines = items.map((e, i) =>
      `${i + 1}. ${e.description} - ${formatMoney(e.amount, biz.currency)} (${e.method})`
    ).join("\n");
    biz.sessionState = "expense_bulk_confirm";
    await saveBizSafe(biz);
    return sendButtons(from, {
      text:
`📋 *Save ${items.length} expense(s)?*

${lines}
─────────────────
*Total: ${formatMoney(total, biz.currency)}*`,
      buttons: [
        { id: "exp_bulk_confirm_yes", title: "✅ Save All" },
        { id: "exp_bulk_keep_adding", title: "➕ Add More" }
      ]
    });
  }

  // ── PARSE: "description amount [method], ..." ─────────────────────────────
  const entries = raw.split(",").map(s => s.trim()).filter(Boolean);
  const parsed  = [];
  const failed  = [];

  for (const entry of entries) {
    const words  = entry.trim().split(/\s+/);
    if (words.length < 2) { failed.push(entry); continue; }

    const lastW  = words[words.length - 1].toLowerCase();
    const method = METHOD_MAP[lastW] || null;
    const amtIdx = method ? words.length - 2 : words.length - 1;
    const amt    = Number(words[amtIdx]);

    if (isNaN(amt) || amt <= 0) { failed.push(entry); continue; }

    const descWords = words.slice(0, amtIdx);
    let cat = "Other";
    for (const w of descWords) {
      if (KEYWORD_CAT[w.toLowerCase()]) { cat = KEYWORD_CAT[w.toLowerCase()]; break; }
    }
    // Override auto-detected category with preset (from Pick by Category)
    const finalCat = biz.sessionData?.presetCategory || cat;
    parsed.push({
      description: descWords.join(" "),
      amount: amt, category: finalCat,
      method: method || "Cash"
    });
  }

  if (!parsed.length) {
    return sendButtons(from, {
      text:
`❌ Couldn't read that.

Format: *item amount* or *item amount method*

Examples:
_fuel 30_
_fuel 30, lunch 15, zesa 50_
_fuel 30 ecocash, rent 500 bank_`,
      buttons: [
        { id: "exp_bulk_confirm_yes", title: "✅ Save What I Have" },
        { id: ACTIONS.MAIN_MENU,     title: "❌ Cancel" }
      ]
    });
  }

  if (!Array.isArray(biz.sessionData.bulkExpenses)) biz.sessionData.bulkExpenses = [];
  biz.sessionData.bulkExpenses.push(...parsed);
  biz.markModified("sessionData");
  await saveBizSafe(biz);

  const allItems = biz.sessionData.bulkExpenses;
  const runTotal = allItems.reduce((s, e) => s + e.amount, 0);
  const newLines = parsed
    .map(e => `• ${e.description} - ${formatMoney(e.amount, biz.currency)} (${e.method})`)
    .join("\n");
  const failNote = failed.length ? `\n⚠️ Skipped: ${failed.join(", ")}` : "";

  // Always show buttons - never ask them to type "done"
 // Set state to expense_bulk_confirm BEFORE showing Save All button
  // so that tapping Save All routes correctly
  biz.sessionState = "expense_bulk_confirm";
  await saveBizSafe(biz);

  return sendButtons(from, {
    text:
`✅ *${parsed.length} added*${failNote}

${newLines}
─────────────────
Running total: *${formatMoney(runTotal, biz.currency)}* (${allItems.length} items)

Add more or save?`,
    buttons: [
      { id: "exp_bulk_confirm_yes", title: "✅ Save All" },
      { id: "exp_bulk_keep_adding", title: "➕ Add More" }
    ]
  });
}
/* =====================================================
   BULK CONFIRM → SAVE ALL TO DB + PDF
===================================================== */
if (state === "expense_bulk_confirm") {
  // ── "Add More" button ────────────────────────────────────────────────────
  if (text === "exp_bulk_keep_adding") {
    biz.sessionState = "expense_smart_entry";
    await saveBizSafe(biz);
    const items    = biz.sessionData?.bulkExpenses || [];
    const runTotal = items.reduce((s, e) => s + e.amount, 0);
    return sendButtons(from, {
      text: `➕ *${items.length} item(s) so far - ${formatMoney(runTotal, biz.currency)}*\n\nType more expenses:\n_fuel 30, lunch 15_`,
      buttons: [
        { id: "exp_bulk_confirm_yes", title: "✅ Save All" },
        { id: ACTIONS.MAIN_MENU,     title: "❌ Cancel" }
      ]
    });
  }

  // ── "Keep Editing" button ─────────────────────────────────────────────────
  if (text === "exp_bulk_confirm_no") {
    biz.sessionState = "expense_smart_entry";
    await saveBizSafe(biz);
    const items    = biz.sessionData?.bulkExpenses || [];
    const runTotal = items.reduce((s, e) => s + e.amount, 0);
    return sendButtons(from, {
      text: `✏️ *${items.length} item(s) so far - ${formatMoney(runTotal, biz.currency)}*\n\nKeep typing expenses:`,
      buttons: [
        { id: "exp_bulk_confirm_yes", title: "✅ Save All" },
        { id: ACTIONS.MAIN_MENU,     title: "❌ Cancel" }
      ]
    });
  }

  // ── "Save All" button ─────────────────────────────────────────────────────
  if (text !== "exp_bulk_confirm_yes") {
    // user typed something while in confirm state - treat as more expenses
    biz.sessionState = "expense_smart_entry";
    await saveBizSafe(biz);
    // re-process as new expense entry (fall through won't work so redirect)
    await sendButtons(from, {
      text: "Tap *Save All* or type more expenses to add:",
      buttons: [
        { id: "exp_bulk_confirm_yes", title: "✅ Save All" },
        { id: ACTIONS.MAIN_MENU,     title: "❌ Cancel" }
      ]
    });
    return true;
  }

  // ── SAVE TO DATABASE ──────────────────────────────────────────────────────
  const items = biz.sessionData?.bulkExpenses || [];
  if (!items.length) {
    biz.sessionState = "ready"; biz.sessionData = {};
    await saveBizSafe(biz);
    await sendText(from, "❌ Nothing to save.");
    await sendMainMenu(from);
    return true;
  }

  const effectiveBranchId = getEffectiveBranchId(caller, biz.sessionData);

  try {
    await Expense.insertMany(items.map(e => ({
      businessId:  biz._id,
      branchId:    effectiveBranchId,
      amount:      e.amount,
      description: e.description,
      category:    e.category,
      method:      e.method || "Cash",
      createdBy:   phone
    })));
  } catch (dbErr) {
    console.error("[BULK EXP SAVE]", dbErr.message);
    await sendText(from, "❌ Error saving expenses. Please try again.");
    return true;
  }

  const total         = items.reduce((s, e) => s + e.amount, 0);
  const savedBranchId = biz.sessionData.targetBranchId;
  const lines         = items
    .map(e => `• ${e.description} - ${formatMoney(e.amount, biz.currency)} (${e.method})`)
    .join("\n");

  // Clear session BEFORE sending PDF so any error doesn't leave dirty state
  biz.sessionData  = { targetBranchId: savedBranchId };
  biz.sessionState = "expense_add_another_menu";
  await saveBizSafe(biz);

  // Send confirmation text immediately
  await sendText(from,
`✅ *${items.length} expense(s) saved*

${lines}
─────────────────
Total: *${formatMoney(total, biz.currency)}*`
  );

  // Generate PDF receipt - runs after confirmation so user doesn't wait
  try {
    const receiptNum = `EXP-${Date.now()}`;
    const { filename } = await generatePDF({
      type: "receipt", number: receiptNum, date: new Date(),
      billingTo: "Expense Record",
      items: items.map(e => ({
        item:  `${e.category} - ${e.description}`,
        qty:   1,
        unit:  e.amount,
        total: e.amount
      })),
      bizMeta: {
        name: biz.name, logoUrl: biz.logoUrl,
        address: biz.address || "",
        _id: biz._id.toString(), status: "paid"
      }
    });
    const site = (process.env.SITE_URL || "").replace(/\/$/, "");
    await sendDocument(from, { link: `${site}/docs/generated/receipts/${filename}`, filename });
  } catch (pdfErr) {
    console.error("[BULK EXP PDF]", pdfErr.message);
  }

  // ── Notify owners/managers/clerk of recorded expenses ──────────────────────
  try {
    const { notifyExpensesRecorded } = await import("./bizNotifications.js");
    const Branch = (await import("../models/branch.js")).default;
    const branchDoc = savedBranchId ? await Branch.findById(savedBranchId).lean() : null;
    await notifyExpensesRecorded({
      biz,
      expenses: items,
      clerkPhone: phone,
      branchName: branchDoc?.name || null,
      branchId:   savedBranchId
    });
  } catch (_notifErr) { console.error("[EXP NOTIF]", _notifErr.message); }

  const { sendExpenseAddAnotherMenu } = await import("./metaMenus.js");
  await sendExpenseAddAnotherMenu(from);
  return true;
}

/* =====================================================
   BULK CONFIRM → SAVE ALL TO DB + PDF
===================================================== */

// Guard: clean up stale states from old flow
if (state === "expense_description" || state === "expense_quick_entry" || state === "expense_confirm") {
  biz.sessionState = "ready"; biz.sessionData = {};
  await saveBizSafe(biz);
  await sendText(from, "Session reset. Please start again from the Payments menu.");
  await sendMainMenu(from);
  return true;
}

  /* ===========================
     PAYMENT: ENTER AMOUNT
  /* ===========================
     PAYMENT: ENTER AMOUNT
  =========================== */
/* ===========================
   PAYMENT IN: ENTER AMOUNT
   User types just a number: "150"
   Or "full" to pay full balance
=========================== */
if (state === "payment_amount") {
  const invoice = await Invoice.findById(biz.sessionData.invoiceId);
  if (!invoice) {
    biz.sessionState = "ready"; biz.sessionData = {}; await saveBizSafe(biz);
    await sendText(from, "❌ Invoice not found.");
    await sendMainMenu(from);
    return true;
  }

  // "full" shortcut pays entire balance
  const isFullPay = trimmed.toLowerCase() === "full";
  const amount = isFullPay ? invoice.balance : Number(trimmed);

  if (isNaN(amount) || amount <= 0) {
    await sendButtons(from, {
      text:
`💳 *${invoice.number}*
Balance: *${formatMoney(invoice.balance, invoice.currency)}*

Type amount or tap Full:`,
      buttons: [
        { id: `payinv_full_${invoice._id}`, title: "✅ Pay Full Balance" },
        { id: ACTIONS.MAIN_MENU,            title: "❌ Cancel" }
      ]
    });
    return true;
  }

  if (amount > invoice.balance + 0.01) {
    await sendText(from,
`❌ Exceeds balance of ${formatMoney(invoice.balance, invoice.currency)}.
Type a smaller amount or *full*:`
    );
    return true;
  }

  biz.sessionData.amount = amount;
  biz.sessionState = "payment_method";
  await saveBizSafe(biz);

  return sendButtons(from, {
    text:
`💳 *${invoice.number}*
Paying: *${formatMoney(amount, invoice.currency)}*

How was it paid?`,
    buttons: [
      { id: "pay_method_cash",    title: "💵 Cash" },
      { id: "pay_method_ecocash", title: "📱 EcoCash" },
      { id: "pay_method_bank",    title: "🏦 Bank" }
    ]
  });
}

/* ===========================
   PAYMENT IN: METHOD → SAVE + PDF
=========================== */
if (state === "payment_method") {
  const methodMap = {
    "pay_method_cash": "Cash", "pay_method_bank": "Bank",
    "pay_method_ecocash": "EcoCash", "pay_method_other": "Other"
  };
  const method = methodMap[text];
  if (!method) {
    await sendButtons(from, {
      text: "💳 How was it paid?",
      buttons: [
        { id: "pay_method_cash",    title: "💵 Cash" },
        { id: "pay_method_ecocash", title: "📱 EcoCash" },
        { id: "pay_method_bank",    title: "🏦 Bank" }
      ]
    });
    return true;
  }

  const invoice = await Invoice.findById(biz.sessionData.invoiceId);
  if (!invoice) {
    biz.sessionState = "ready"; biz.sessionData = {}; await saveBizSafe(biz);
    await sendText(from, "❌ Invoice not found."); await sendMainMenu(from);
    return true;
  }

  const amount = biz.sessionData.amount;
  invoice.amountPaid = (invoice.amountPaid || 0) + amount;
  invoice.balance    = Math.max(0, (invoice.balance || 0) - amount);
  invoice.status     = invoice.balance <= 0 ? "paid" : "partial";
  await invoice.save();

  const receiptNumber = `RCPT-${Date.now()}`;
  await InvoicePayment.create({
    businessId: biz._id, clientId: invoice.clientId,
    branchId: invoice.branchId || getEffectiveBranchId(caller, biz.sessionData) || null,
    invoiceId: invoice._id, amount, method, receiptNumber, createdBy: phone
  });

  try {
    const { filename } = await generatePDF({
      type: "receipt", number: receiptNumber, date: new Date(),
      billingTo: invoice.number,
      items: [{ item: `Payment received (${method})`, qty: 1, unit: amount, total: amount }],
      bizMeta: { name: biz.name, logoUrl: biz.logoUrl, address: biz.address || "", _id: biz._id.toString(), status: invoice.status }
    });
    const site = (process.env.SITE_URL || "").replace(/\/$/, "");
    await sendDocument(from, { link: `${site}/docs/generated/receipts/${filename}`, filename });
  } catch (pdfErr) { console.error("[PAYMENT PDF]", pdfErr.message); }

  biz.sessionState = "ready"; biz.sessionData = {};
  await saveBizSafe(biz);

  await sendText(from,
`✅ *Payment saved*  ${invoice.number} - ${formatMoney(amount, invoice.currency)} (${method})
${invoice.status === "paid" ? "Fully paid ✅" : `Balance: ${formatMoney(invoice.balance, invoice.currency)}`}`
  );
  await sendMainMenu(from);
  return true;
}

  /* ===========================
     PAYMENT: METHOD → SAVE + RECEIPT
  =========================== */
  if (state === "payment_method") {
    const methodMap = {
      "pay_method_cash": "Cash", "pay_method_bank": "Bank",
      "pay_method_ecocash": "EcoCash", "pay_method_other": "Other",
      "1": "Cash", "2": "Bank", "3": "EcoCash", "4": "Other"
    };

    const method = methodMap[trimmed] || methodMap[text];
    if (!method) {
      await sendButtons(from, {
        text: "❌ Please select a payment method:",
        buttons: [
          { id: "pay_method_cash", title: "💵 Cash" },
          { id: "pay_method_bank", title: "🏦 Bank" },
          { id: "pay_method_ecocash", title: "📱 EcoCash" }
        ]
      });
      return true;
    }

    const invoice = await Invoice.findById(biz.sessionData.invoiceId);
    if (!invoice) {
      biz.sessionState = "ready"; biz.sessionData = {}; await saveBizSafe(biz);
      await sendText(from, "❌ Invoice not found."); await sendMainMenu(from);
      return true;
    }

    const amount = biz.sessionData.amount;
    invoice.amountPaid += amount;
    invoice.balance -= amount;
    if (invoice.balance <= 0) { invoice.status = "paid"; invoice.balance = 0; }
    else { invoice.status = "partial"; }
    await invoice.save();

    const receiptNumber = `RCPT-${Date.now()}`;

    // ✅ Use invoice's own branchId for payment record (most accurate)
    await InvoicePayment.create({
      businessId: biz._id,
      clientId: invoice.clientId,
      branchId: invoice.branchId || getEffectiveBranchId(caller, biz.sessionData) || null,
      invoiceId: invoice._id,
      amount, method, receiptNumber,
      createdBy: phone
    });

    const { filename } = await generatePDF({
      type: "receipt", number: receiptNumber, date: new Date(),
      billingTo: invoice.number,
      items: [{ item: `Payment (${method})`, qty: 1, unit: amount, total: amount }],
      bizMeta: { name: biz.name, logoUrl: biz.logoUrl, address: biz.address || "", _id: biz._id.toString(), status: invoice.status }
    });

    const site = (process.env.SITE_URL || "").replace(/\/$/, "");
    const url = `${site}/docs/generated/receipts/${filename}`;
    await sendDocument(from, { link: url, filename });

    biz.sessionState = "ready"; biz.sessionData = {}; await saveBizSafe(biz);
    await sendText(from, `✅ Payment recorded\n*Invoice:* ${invoice.number}\n*Amount:* ${amount} ${invoice.currency}\n*Method:* ${method}`);

    // ── Notify owners/managers/clerk ─────────────────────────────────────────
    try {
      const { notifyPaymentRecorded } = await import("./bizNotifications.js");
      const ClientModel = (await import("../models/client.js")).default;
      const client = invoice.clientId ? await ClientModel.findById(invoice.clientId).lean() : null;
      const Branch = (await import("../models/branch.js")).default;
      const branchDoc = invoice.branchId ? await Branch.findById(invoice.branchId).lean() : null;
      await notifyPaymentRecorded({
        biz,
        payment: { amount, method },
        invoiceNumber: invoice.number,
        clientName: client?.name || "Walk-in",
        clerkPhone: phone,
        branchName: branchDoc?.name || null,
        branchId:   invoice.branchId
      });
    } catch (_n) { console.error("[PAY NOTIF]", _n.message); }

    await sendMainMenu(from);
    return true;
  }

  /* ===========================
     CLIENT CREATION (MAIN MENU)
  =========================== */
  if (state === "adding_client_name") {
    biz.sessionData.clientName = trimmed;
    biz.sessionState = "adding_client_phone";
    await saveBizSafe(biz);
    await sendButtons(from, {
      text: "📞 *Enter client phone number:*\n\nOr choose an option below:",
      buttons: [
        { id: "add_client_phone_same", title: "📱 Use my number" },
        { id: ACTIONS.MAIN_MENU, title: "🏠 Main Menu" }
      ]
    });
    return true;
  }

  if (state === "adding_client_phone") {
    let phoneVal;
    if (text === "add_client_phone_same") phoneVal = phone;
    else phoneVal = trimmed;

    // ✅ Use targetBranchId if owner, otherwise caller.branchId
    const effectiveBranchId = getEffectiveBranchId(caller, biz.sessionData);

    const client = await Client.findOneAndUpdate(
      { businessId: biz._id, phone: phoneVal },
      { $set: { name: biz.sessionData.clientName, phone: phoneVal, branchId: effectiveBranchId } },
      { upsert: true, new: true }
    );

    biz.sessionState = "ready"; biz.sessionData = {}; await saveBizSafe(biz);
    await sendText(from, `✅ Client added: *${client.name || client.phone}*`);
    await sendMainMenu(from);
    return true;
  }

  /* ===========================
     CLIENT CREATION (INVOICE)
  ============================ */
  if (state === "creating_invoice_new_client") {
    biz.sessionData.clientName = trimmed;
    biz.sessionState = "creating_invoice_new_client_phone";
    await saveBizSafe(biz);
    await sendButtons(from, {
      text: "📞 *Enter client phone number:*\n\nOr choose:",
      buttons: [
        { id: "inv_client_phone_same", title: "📱 Use my number" },
        { id: "inv_client_phone_skip", title: "⏭ Skip phone" }
      ]
    });
    return true;
  }

  if (state === "creating_invoice_new_client_phone") {
    const isSkip = trimmed.toLowerCase() === "skip" || text === "inv_client_phone_skip";
    const isSame = trimmed.toLowerCase() === "same" || text === "inv_client_phone_same";

    const clientName = biz.sessionData.clientName || "Customer";
    const phoneVal   = isSkip ? null : (isSame ? phone : trimmed);

    const client = await Client.findOneAndUpdate(
      { businessId: biz._id, ...(phoneVal ? { phone: phoneVal } : { name: clientName, phone: null }) },
      { $set: { name: clientName, phone: phoneVal } },
      { upsert: true, new: true }
    );

    const core = preserveSessionCore(biz);
    biz.sessionData = {
      ...core,
      client,
      clientId:       client._id,
      items:          [],
      itemMode:       null,
      lastItem:       null,
      expectingQty:   false,
      lastItemSource: null
    };
    biz.sessionState = "creating_invoice_add_items";
    await saveBizSafe(biz);
    return sendAddItemPrompt(from);
  }

  /* ===========================
     INVOICE: QUICK ADD PRODUCT (NAME)
     Supports comma-separated bulk entry. Single name → optional price step.
     Multiple names → save all to catalogue (no price required), then ask prices
     for any that are unpriced, then continue with the invoice item flow.
  =========================== */
  if (state === "invoice_quick_add_product_name") {
    const raw = trimmed;
    if (!raw || raw.length < 2) {
      await sendPromptWithMenu(from,
        "❌ Enter a valid product/service name.\n\n" +
        "_Add multiple at once with commas:_\n" +
        "_house wiring, solar installation, geyser repair_"
      );
      return true;
    }

    const names = parseCommaNames(raw);
    if (names.length === 0) {
      await sendPromptWithMenu(from, "❌ Enter at least one valid name (min 2 characters):");
      return true;
    }

    if (names.length > 1) {
      // ── BULK MODE: save all to catalogue without requiring prices ──────────
      const effectiveBranchId = getEffectiveBranchId(caller, biz.sessionData);
      const savedProducts = await Promise.all(
        names.map(name =>
          Product.create({
            businessId: biz._id,
            branchId:   effectiveBranchId,
            name,
            unitPrice:  0,
            isActive:   true
          })
        )
      );

      // Add all to current invoice items with unit=0 so prices can be filled
      const newItems = savedProducts.map(p => ({ item: p.name, qty: 1, unit: 0, source: "catalogue" }));
      biz.sessionData.items        = [...(biz.sessionData.items || []), ...newItems];
      biz.sessionData.quickAddProduct = null;

      const unpricedIndexes = findUnpricedIndexes(biz.sessionData.items);
      biz.sessionData.unpricedIndexes = unpricedIndexes;
      biz.sessionState = "creating_invoice_enter_catalogue_prices";
      await saveBizSafe(biz);

      const savedLines = savedProducts.map((p, i) => `✅ ${i + 1}. ${p.name}`).join("\n");
      return sendButtons(from, {
        text:
          `📦 *${savedProducts.length} items saved to catalogue*\n\n${savedLines}\n\n` +
          buildUnpricedPromptText(biz.sessionData.items, unpricedIndexes, biz.currency || "USD"),
        buttons: [{ id: "inv_cancel", title: "❌ Cancel" }]
      });
    }

    // ── SINGLE NAME: ask for price (with skip option) ───────────────────────
    biz.sessionData.quickAddProduct      = biz.sessionData.quickAddProduct || {};
    biz.sessionData.quickAddProduct.name = names[0];
    biz.sessionState = "invoice_quick_add_product_price";
    await saveBizSafe(biz);
    return sendButtons(from, {
      text: `📦 *${names[0]}*\n\n💰 Enter the price, or skip:`,
      buttons: [
        { id: "inv_skip_product_price", title: "⏭ Skip Pricing" },
        { id: ACTIONS.MAIN_MENU,        title: "🏠 Main Menu"   }
      ]
    });
  }

  /* ===========================
     INVOICE: QUICK ADD PRODUCT (PRICE → SAVE → ASK QTY)
     Price is OPTIONAL - user may tap "Skip Pricing" or type 0.
  =========================== */
  if (state === "invoice_quick_add_product_price") {
    const isSkip = text === "inv_skip_product_price" || trimmed.toLowerCase() === "skip";
    const price  = isSkip ? 0 : Number(trimmed);

    if (!isSkip && (isNaN(price) || price < 0)) {
      return sendButtons(from, {
        text: "❌ Enter a valid price (e.g. 10) or skip:",
        buttons: [
          { id: "inv_skip_product_price", title: "⏭ Skip Pricing" },
          { id: ACTIONS.MAIN_MENU,        title: "🏠 Main Menu"   }
        ]
      });
    }

    const name = biz.sessionData?.quickAddProduct?.name;
    if (!name) {
      biz.sessionState = "creating_invoice_add_items";
      await saveBizSafe(biz);
      await sendText(from, "⚠️ Product/Service name missing. Try again.");
      return sendAddItemPrompt(from);
    }

    const effectiveBranchId = getEffectiveBranchId(caller, biz.sessionData);
    const product = await Product.create({
      businessId: biz._id,
      branchId:   effectiveBranchId,
      name,
      unitPrice:  price,
      isActive:   true
    });

    biz.sessionData.lastItem        = { description: product.name, unit: product.unitPrice, source: "catalogue" };
    biz.sessionData.expectingQty    = true;
    biz.sessionData.itemMode        = "catalogue";
    biz.sessionData.quickAddProduct = null;
    biz.sessionState                = "creating_invoice_add_items";
    await saveBizSafe(biz);

    const priceNote = price > 0
      ? `@ *${formatMoney(price, biz.currency)}*`
      : `_(price will be entered on invoice)_`;
    await sendPromptWithMenu(from, `✅ Saved: *${product.name}* ${priceNote}\n\n🔢 Enter quantity (e.g. 1):`);
    return true;
  }

  /* ===========================
     ITEM ADDING
  ============================ */



// ── Quick-pick from numbered catalogue: "3x2, 7x1, 12x5" ─────────────────
if (state === "creating_invoice_pick_product") {
  const catalogue = biz.sessionData?.catalogueProducts || [];
  const { picked, errors } = parsePickEntries(trimmed, catalogue);

  if (!picked.length) {
    await sendText(from,
`❌ Couldn't read that. Use *number × quantity*

Examples:
_3x2_ → item 3, qty 2
_3x2, 7x1, 12x5_ → multiple items

Type *cancel* to go back.`
    );
    return true;
  }

  biz.sessionData.items = [...(biz.sessionData.items || []), ...picked];

  const errorNote       = errors.length ? `⚠️ Skipped: ${errors.join(", ")}` : "";
  const unpricedIndexes = findUnpricedIndexes(biz.sessionData.items);

  if (unpricedIndexes.length > 0) {
    biz.sessionData.unpricedIndexes = unpricedIndexes;
    biz.sessionState = "creating_invoice_enter_catalogue_prices";
    await saveBizSafe(biz);

    const promptText = buildUnpricedPromptText(biz.sessionData.items, unpricedIndexes, biz.currency || "USD");
    return sendButtons(from, {
      text: (errorNote ? errorNote + "\n\n" : "") +
            `✅ *${picked.length} item${picked.length === 1 ? "" : "s"} added*\n\n` +
            promptText,
      buttons: [{ id: "inv_cancel", title: "❌ Cancel" }]
    });
  }

  biz.sessionState = "creating_invoice_confirm";
  await saveBizSafe(biz);
  return sendDocPreview(from, biz, errorNote);
}

// ── Enter prices for zero-price catalogue items ────────────────────────────
// Accepts: "5.50, 3.00, 12.50"  (one per unpriced item in order)
//      or: "5.50"               (applies same price to ALL unpriced items)
if (state === "creating_invoice_enter_catalogue_prices") {
  const unpricedIndexes = biz.sessionData.unpricedIndexes || [];

  if (!unpricedIndexes.length) {
    biz.sessionState = "creating_invoice_confirm";
    await saveBizSafe(biz);
    return sendDocPreview(from, biz);
  }

  const result = applyBulkPrices(trimmed, biz.sessionData.items, unpricedIndexes);

  if (!result.ok) {
    const promptText = buildUnpricedPromptText(biz.sessionData.items, unpricedIndexes, biz.currency || "USD");
    await sendText(from, result.message + "\n\n" + promptText);
    return true;
  }

  biz.sessionData.unpricedIndexes = [];
  biz.sessionState = "creating_invoice_confirm";
  await saveBizSafe(biz);
  return sendDocPreview(from, biz);
}



  if (state === "creating_invoice_add_items") {
    // Show mode-choice if nothing is in flight
    if (biz.sessionData.itemMode === null && !biz.sessionData.lastItem && !biz.sessionData.expectingQty) {
      biz.sessionData.itemMode = "choose";
      await saveBizSafe(biz);
      return sendAddItemPrompt(from);
    }

    // ── CUSTOM BULK MODE: waiting for quantities block ────────────────────────
    // State: itemMode = "custom_qty" | pendingCustomNames = [...]
    if (biz.sessionData.itemMode === "custom_qty") {
      const names = biz.sessionData.pendingCustomNames || [];
      const isSingle = names.length === 1;

      // Parse input: single number (e.g. "3") or NxQTY pairs (e.g. "1x2, 2x5, 3x1")
      let qtys = [];
      const pairMatches = trimmed.match(/\d+\s*[xX×]\s*\d+(?:\.\d+)?/g);

      if (isSingle && !isNaN(Number(trimmed)) && Number(trimmed) > 0) {
        // Single item - just type the qty directly
        qtys = [Number(trimmed)];
      } else if (pairMatches && pairMatches.length) {
        // "1x2, 2x1, 3x5" format
        for (const p of pairMatches) {
          const m = p.match(/(\d+)\s*[xX×]\s*(\d+(?:\.\d+)?)/);
          const idx = parseInt(m[1], 10) - 1;
          const qty = parseFloat(m[2]);
          if (idx >= 0 && idx < names.length && qty > 0) qtys[idx] = qty;
        }
      } else {
        // Single number for all items
        const n = Number(trimmed);
        if (!isNaN(n) && n > 0) {
          qtys = names.map(() => n);
        }
      }

      // Validate - all items must have a qty
      const missing = names.map((_, i) => i).filter(i => !qtys[i] || qtys[i] <= 0);
      if (missing.length) {
        const numbered = names.map((n, i) => `${i + 1}. ${n}`).join("\n");
        return sendButtons(from, {
          text:
            `❌ *Some items are missing a quantity.*\n\n` +
            `${numbered}\n\n` +
            (isSingle
              ? `Enter the quantity (e.g. *3*):`
              : `Use *NxQTY* format, e.g. *1x2, 2x5, 3x1*\n_Or type one number to set all the same._`),
          buttons: [{ id: ACTIONS.MAIN_MENU, title: "🏠 Main Menu" }]
        });
      }

      // Quantities captured → move to price entry
      biz.sessionData.pendingCustomItems = names.map((name, i) => ({
        item: name, qty: qtys[i] || 1, unit: 0, source: "custom"
      }));
      biz.sessionData.itemMode = "custom_price";
      await saveBizSafe(biz);

      const currency = biz.currency || "USD";
      const isSingleItem = names.length === 1;
      const itemList = names.map((n, i) => `${i + 1}. *${n}* × ${qtys[i] || 1}`).join("\n");
      return sendButtons(from, {
        text:
          `💰 *Enter ${isSingleItem ? "the price" : "prices"} for:*\n\n` +
          `${itemList}\n\n` +
          (isSingleItem
            ? `Type the unit price (e.g. *50*) or skip:`
            : `Use *NxPRICE* format, e.g. *1x50, 2x120.50, 3x35*\n_Or type one price to set all the same._`),
        buttons: [
          { id: "inv_custom_skip_price", title: "⏭ Skip prices" },
          { id: ACTIONS.MAIN_MENU,       title: "🏠 Main Menu"  }
        ]
      });
    }

    // ── CUSTOM BULK MODE: waiting for prices block ───────────────────────────
    if (biz.sessionData.itemMode === "custom_price") {
      const pending = biz.sessionData.pendingCustomItems || [];
      const isSkipAll = text === "inv_custom_skip_price" || trimmed.toLowerCase() === "skip";

      if (!isSkipAll) {
        const isSingle = pending.length === 1;
        const pairMatches = trimmed.match(/\d+\s*[xX×]\s*\d+(?:\.\d+)?/g);
        let prices = [];

        if (isSingle && !isNaN(Number(trimmed)) && Number(trimmed) >= 0) {
          prices = [Number(trimmed)];
        } else if (pairMatches && pairMatches.length) {
          for (const p of pairMatches) {
            const m = p.match(/(\d+)\s*[xX×]\s*(\d+(?:\.\d+)?)/);
            const idx = parseInt(m[1], 10) - 1;
            const price = parseFloat(m[2]);
            if (idx >= 0 && idx < pending.length && price >= 0) prices[idx] = price;
          }
        } else {
          const n = Number(trimmed);
          if (!isNaN(n) && n >= 0) prices = pending.map(() => n);
        }

        if (prices.length === 0 || prices.some((p, i) => pending[i] !== undefined && p === undefined)) {
          return sendButtons(from, {
            text:
              `❌ *Couldn't read the prices.*\n\n` +
              `${isSingle
                ? `Type the price (e.g. *50*) or skip:`
                : `Use *NxPRICE* format, e.g. *1x50, 2x120.50*\nOr one price for all.`}`,
            buttons: [
              { id: "inv_custom_skip_price", title: "⏭ Skip prices" },
              { id: ACTIONS.MAIN_MENU,       title: "🏠 Main Menu"  }
            ]
          });
        }

        // Apply prices
        prices.forEach((price, i) => {
          if (pending[i] !== undefined) pending[i].unit = price;
        });
      }
      // isSkipAll → prices stay at 0

      // Push all pending items into the main items array
      biz.sessionData.items = [...(biz.sessionData.items || []), ...pending];
      biz.sessionData.pendingCustomItems = [];
      biz.sessionData.pendingCustomNames = [];
      biz.sessionData.itemMode = null;
      biz.sessionState = "creating_invoice_confirm";
      await saveBizSafe(biz);
      return sendDocPreview(from, biz);
    }

    // ── CATALOGUE MODE: waiting for quantity after picking a catalogue item ───
    if (biz.sessionData.expectingQty) {
      const qty = Number(trimmed);
      if (isNaN(qty) || qty <= 0) { await sendPromptWithMenu(from, "❌ Invalid quantity. Enter a number like 1:"); return true; }

      const lastItemData = biz.sessionData.lastItem;
      biz.sessionData.items.push({
        item:   lastItemData.description,
        qty,
        unit:   lastItemData.unit ?? 0,
        source: lastItemData.source || "custom"
      });

      const addedSource              = lastItemData.source;
      biz.sessionData.lastItemSource = addedSource;
      biz.sessionData.lastItem       = null;
      biz.sessionData.expectingQty   = false;

      const addedItem = biz.sessionData.items[biz.sessionData.items.length - 1];

      // Catalogue item that already has a saved price → go straight to preview
      if (addedSource !== "custom" && Number(addedItem.unit) > 0) {
        biz.sessionState = "creating_invoice_confirm";
        await saveBizSafe(biz);
        return sendDocPreview(from, biz);
      }

      // Catalogue item with no saved price → ask price
      biz.sessionState           = "creating_invoice_enter_prices";
      biz.sessionData.priceIndex = biz.sessionData.items.length - 1;
      await saveBizSafe(biz);
      return sendButtons(from, {
        text: `💰 *Enter unit price for:*\n${addedItem.item}\n\n_Or skip - price can be added later._`,
        buttons: [
          { id: "inv_skip_item_price", title: "⏭ Skip Price" },
          { id: ACTIONS.MAIN_MENU,     title: "🏠 Main Menu" }
        ]
      });
    }

    // Fallback: unexpected text in add_items mode
    await saveBizSafe(biz);
    return sendAddItemPrompt(from);
  }


  /* ===========================
     CUSTOM ITEM NAME ENTRY
     State: creating_invoice_custom_names
     User types comma-separated item names, then sees a preview.
  =========================== */
  if (state === "creating_invoice_custom_names") {
    const rawNames = parseCommaNames(trimmed);
    if (!rawNames.length) {
      return sendButtons(from, {
        text:
          `❌ *No valid items found.*\n\n` +
          `Type item names separated by commas:\n\n` +
          `_labour charge, materials, transport fee_`,
        buttons: [{ id: ACTIONS.MAIN_MENU, title: "🏠 Main Menu" }]
      });
    }

    biz.sessionData.pendingCustomNames = rawNames;
    biz.sessionState = "creating_invoice_custom_preview";
    await saveBizSafe(biz);

    const numbered = rawNames.map((n, i) => `${i + 1}. ${n}`).join("\n");
    const isSingle = rawNames.length === 1;
    return sendButtons(from, {
      text:
        `📋 *${isSingle ? "Your item" : `Your ${rawNames.length} items`}:*\n\n` +
        `${numbered}\n\n` +
        `Tap *Confirm* to set quantities and prices, or *Edit* to change the list.`,
      buttons: [
        { id: "inv_custom_confirm", title: "✅ Confirm" },
        { id: "inv_custom_edit",    title: "✏️ Edit"    },
        { id: "inv_custom_cancel",  title: "❌ Cancel"  }
      ]
    });
  }


  /* ===========================
     CUSTOM ITEM NAME PREVIEW
     State: creating_invoice_custom_preview
     User sees numbered list and can edit or confirm.
  =========================== */
  if (state === "creating_invoice_custom_preview") {
    const names  = biz.sessionData.pendingCustomNames || [];
    const isEdit = text === "inv_custom_edit" || trimmed.toLowerCase() === "edit";
    const isCancel = text === "inv_custom_cancel" || trimmed.toLowerCase() === "cancel";
    const isConfirm = text === "inv_custom_confirm" || ["ok","yes","confirm"].includes(trimmed.toLowerCase());

    if (isCancel) {
      biz.sessionData.pendingCustomNames = [];
      biz.sessionData.itemMode = null;
      biz.sessionState = "creating_invoice_add_items";
      await saveBizSafe(biz);
      return sendAddItemPrompt(from);
    }

    if (isEdit) {
      biz.sessionState = "creating_invoice_custom_edit";
      await saveBizSafe(biz);
      const numbered = names.map((n, i) => `${i + 1}. ${n}`).join("\n");
      return sendButtons(from, {
        text:
          `✏️ *Edit your items:*\n\n` +
          `Current list:\n${numbered}\n\n` +
          `Type the new list, comma-separated.\n` +
          `_e.g. labour charge, materials, transport fee_`,
        buttons: [{ id: ACTIONS.MAIN_MENU, title: "🏠 Main Menu" }]
      });
    }

    if (!isConfirm) {
      // Re-show preview
      const numbered = names.map((n, i) => `${i + 1}. ${n}`).join("\n");
      return sendButtons(from, {
        text:
          `📋 *Your items:*\n\n${numbered}\n\n` +
          `Tap *Confirm* to continue, or *Edit* to change.`,
        buttons: [
          { id: "inv_custom_confirm", title: "✅ Confirm" },
          { id: "inv_custom_edit",    title: "✏️ Edit"    },
          { id: "inv_custom_cancel",  title: "❌ Cancel"  }
        ]
      });
    }

    // Confirmed → move to quantity entry
    const isSingle = names.length === 1;
    biz.sessionData.itemMode = "custom_qty";
    biz.sessionState = "creating_invoice_add_items";
    await saveBizSafe(biz);
    const itemList = names.map((n, i) => `${i + 1}. *${n}*`).join("\n");
    return sendButtons(from, {
      text:
        `🔢 *Enter quantities for:*\n\n` +
        `${itemList}\n\n` +
        (isSingle
          ? `Type the quantity (e.g. *3*):`
          : `Use *NxQTY* format, e.g. *1x2, 2x5, 3x1*\n_Or type one number to apply to all._`),
      buttons: [{ id: ACTIONS.MAIN_MENU, title: "🏠 Main Menu" }]
    });
  }

  /* ===========================
     CUSTOM ITEM EDIT (re-enter names)
     State: creating_invoice_custom_edit
  =========================== */
  if (state === "creating_invoice_custom_edit") {
    const rawNames = parseCommaNames(trimmed);
    if (!rawNames.length) {
      return sendButtons(from, {
        text:
          `❌ No valid items found.\n\n` +
          `Type item names separated by commas:\n` +
          `_e.g. labour charge, materials, transport fee_`,
        buttons: [{ id: ACTIONS.MAIN_MENU, title: "🏠 Main Menu" }]
      });
    }

    biz.sessionData.pendingCustomNames = rawNames;
    biz.sessionState = "creating_invoice_custom_preview";
    await saveBizSafe(biz);

    const numbered = rawNames.map((n, i) => `${i + 1}. ${n}`).join("\n");
    return sendButtons(from, {
      text:
        `📋 *Your items (${rawNames.length}):*\n\n${numbered}\n\n` +
        `Tap *Confirm* to add quantities and prices.`,
      buttons: [
        { id: "inv_custom_confirm", title: "✅ Confirm" },
        { id: "inv_custom_edit",    title: "✏️ Edit"    },
        { id: "inv_custom_cancel",  title: "❌ Cancel"  }
      ]
    });
  }

  /* ===========================
     PRICE ENTRY (custom items or catalogue items with no saved price)
     Price is OPTIONAL - user can tap "Skip Price" or type 0.
  =========================== */
  if (state === "creating_invoice_enter_prices") {
    const isSkip = text === "inv_skip_item_price" || trimmed.toLowerCase() === "skip";
    const price  = isSkip ? 0 : Number(trimmed);

    if (!isSkip && (isNaN(price) || price < 0)) {
      await sendButtons(from, {
        text: "❌ Invalid price. Enter a number (e.g. 500) or skip:",
        buttons: [
          { id: "inv_skip_item_price", title: "⏭ Skip Price" },
          { id: ACTIONS.MAIN_MENU,     title: "🏠 Main Menu" }
        ]
      });
      return true;
    }

    const idx = biz.sessionData.priceIndex || 0;
    biz.sessionData.items[idx].unit = price;
    biz.sessionData.priceIndex      = idx + 1;

    // Check if next item also needs a price
    const nextIdx  = biz.sessionData.priceIndex;
    const nextItem = biz.sessionData.items[nextIdx];
    if (nextItem && Number(nextItem.unit) === 0) {
      await saveBizSafe(biz);
      return sendButtons(from, {
        text: `💰 *Enter price for:*\n${nextItem.item}\n\n_Or skip:_`,
        buttons: [
          { id: "inv_skip_item_price", title: "⏭ Skip Price" },
          { id: ACTIONS.MAIN_MENU,     title: "🏠 Main Menu" }
        ]
      });
    }

    biz.sessionState           = "creating_invoice_confirm";
    biz.sessionData.priceIndex = 0;
    await saveBizSafe(biz);
    return sendDocPreview(from, biz);
  }

  /* ===========================
     CONFIRMATION → GENERATE PDF
  ============================ */
  const docType = biz.sessionData.docType || "invoice";

  if (state === "creating_invoice_confirm" && trimmed === "2") {
    let client = biz.sessionData.client;
    if (!client && biz.sessionData.clientId) client = await Client.findById(biz.sessionData.clientId);
    if (!client) { await sendText(from, "❌ Client information is missing."); return true; }

    const items = biz.sessionData.items || [];
    if (!items.length) { await sendText(from, "❌ No items found."); return true; }

    const prefix = docType === "invoice" ? biz.invoicePrefix || "INV"
      : docType === "quote" ? biz.quotePrefix || "QT"
      : biz.receiptPrefix || "RCPT";

    biz.counters = biz.counters || { invoice: 0, quote: 0, receipt: 0 };
    const counterKey = docType === "invoice" ? "invoice" : docType === "quote" ? "quote" : "receipt";
    biz.counters[counterKey] = (biz.counters[counterKey] || 0) + 1;
    const number = `${prefix}-${String(biz.counters[counterKey]).padStart(6, "0")}`;

    const subtotal = items.reduce((s, i) => s + i.qty * i.unit, 0);
    const discountPercent = Number(biz.sessionData.discountPercent || 0);
    const discountAmount = subtotal * (discountPercent / 100);
    const vatPercent = Number(biz.sessionData.vatPercent || 0);
    const applyVat = docType === "receipt" ? false : biz.sessionData.applyVat !== false;
    const vatAmount = applyVat ? (subtotal - discountAmount) * (vatPercent / 100) : 0;
    const total = subtotal - discountAmount + vatAmount;

    // Trial limit
    if (biz.package === "trial") {
      const { PACKAGES } = await import("./packages.js");
      const limit = PACKAGES.trial.monthlyDocs;
      if (biz.documentCountMonth >= limit) {
        biz.sessionState = "ready"; biz.sessionData = {}; await saveBizSafe(biz);
        await sendText(from, `🚫 Trial limit reached\n\nYou can only create *${limit} invoices* on the Trial package.\n\nUpgrade to continue creating invoices.`);
        await sendMainMenu(from);
        return true;
      }
    }

    const isReceipt = docType === "receipt";

    // ✅ Use effective branchId for owner
    const effectiveBranchId = getEffectiveBranchId(caller, biz.sessionData);

   // const effectiveBranchId = getEffectiveBranchId(caller, biz.sessionData);

console.log("INVOICE BRANCH DEBUG", {
  phone,
  callerRole: caller?.role,
  targetBranchId: biz.sessionData?.targetBranchId,
  effectiveBranchId
});
    const invoiceDoc = await Invoice.create({
      businessId: biz._id, clientId: client._id, type: docType,
      branchId: effectiveBranchId,
      number, currency: biz.currency,
      items: items.map(i => ({ item: i.item, qty: i.qty, unit: i.unit, total: i.qty * i.unit })),
      subtotal, discountPercent, discountAmount, vatPercent, vatAmount, total,
      amountPaid: isReceipt ? total : 0,
      balance: isReceipt ? 0 : total,
      status: isReceipt ? "paid" : "unpaid",
      createdBy: phone
    });

    biz.documentCountMonth += 1;
    await saveBizSafe(biz);

    const { filename } = await generatePDF({
      type: docType, number, date: new Date(),
      billingTo: client.name || client.phone, items,
      bizMeta: {
        name: biz.name, logoUrl: biz.logoUrl, address: biz.address || "",
        discountPercent, vatPercent, applyVat,
        _id: biz._id.toString(), status: invoiceDoc.status
      }
    });

    const site = (process.env.SITE_URL || "").replace(/\/$/, "");
    const folder = docType === "invoice" ? "invoices" : docType === "quote" ? "quotes" : "receipts";
    const url = `${site}/docs/generated/${folder}/${filename}`;

    await sendDocument(from, { link: url, filename });
    biz.sessionState = "ready"; biz.sessionData = {}; await saveBizSafe(biz);

    // ── Notify owners/managers/clerk ─────────────────────────────────────────
    try {
      const { notifyDocumentCreated } = await import("./bizNotifications.js");
      const Branch = (await import("../models/branch.js")).default;
      const branchDoc = effectiveBranchId ? await Branch.findById(effectiveBranchId).lean() : null;
      await notifyDocumentCreated({
        biz,
        doc: { number, total, clientName: client.name || client.phone },
        docType,
        clerkPhone: phone,
        branchName: branchDoc?.name || null,
        branchId:   effectiveBranchId
      });
    } catch (_n) { console.error("[DOC NOTIF]", _n.message); }

    await sendMainMenu(from);
    return true;
  }

  /* ===========================
     SET DISCOUNT %
  ============================ */
  if (state === "creating_invoice_set_discount") {
    const pct = Number(trimmed);
    if (isNaN(pct) || pct < 0 || pct > 100) { await sendPromptWithMenu(from, "❌ Invalid discount. Enter a percent (0-100):"); return true; }
    biz.sessionData.discountPercent = pct;
    biz.sessionState = "creating_invoice_confirm";
    await saveBizSafe(biz);
    return sendDocPreview(from, biz, pct > 0 ? `💸 Discount set to ${pct}%` : "");
  }

  /* ===========================
     SET VAT %
  ============================ */
  if (state === "creating_invoice_set_vat") {
    const pct = Number(trimmed);
    if (isNaN(pct) || pct < 0 || pct > 100) { await sendPromptWithMenu(from, "❌ Invalid VAT. Enter a percent (0-100):"); return true; }
    biz.sessionData.vatPercent = pct;
    biz.sessionData.applyVat   = pct > 0;
    biz.sessionState = "creating_invoice_confirm";
    await saveBizSafe(biz);
    return sendDocPreview(from, biz, pct > 0 ? `🧾 VAT set to ${pct}%` : "");
  }

  /* ===========================
     ADD PRODUCTS - PREVIEW BEFORE SAVE
     State: product_add_preview
     Waiting for user to confirm or edit the pending list.
  =========================== */
  if (state === "product_add_preview") {
    const { pendingNames, isService, targetBranchId } = biz.sessionData;
    if (!pendingNames || !pendingNames.length) {
      biz.sessionState = "ready"; biz.sessionData = {};
      await saveBizSafe(biz);
      await sendText(from, "❌ Nothing to save.");
      const { sendProductsMenu } = await import("./metaMenus.js");
      return sendProductsMenu(from);
    }

    // "Edit List" - go back to name entry
    if (trimmed.toLowerCase() === "edit" || text === "prod_preview_edit") {
      biz.sessionState = isService ? "service_add_name" : "product_add_name";
      biz.sessionData.pendingNames = [];
      await saveBizSafe(biz);
      const { sendProductsMenu } = await import("./metaMenus.js");
      const label = isService ? "services" : "products";
      return sendButtons(from, {
        text: `✏️ *Re-enter your ${label}, separated by commas:*\n\n_You do not need to add prices now._`,
        buttons: [{ id: ACTIONS.MAIN_MENU, title: "🏠 Main Menu" }]
      });
    }

    // "Cancel"
    if (trimmed.toLowerCase() === "cancel" || text === "prod_preview_cancel") {
      biz.sessionState = "ready"; biz.sessionData = {};
      await saveBizSafe(biz);
      await sendText(from, "❌ Cancelled - nothing was saved.");
      const { sendProductsMenu } = await import("./metaMenus.js");
      return sendProductsMenu(from);
    }

    // "Save" - text "save", "1", or button prod_preview_save
    const isSave = ["save", "1", "yes"].includes(trimmed.toLowerCase()) || text === "prod_preview_save";
    if (!isSave) {
      // Re-show preview
      const { buildSavePreviewText } = await import("./invoiceHelpers.js");
      const preview = buildSavePreviewText(pendingNames, isService);
      return sendButtons(from, {
        text: preview,
        buttons: [
          { id: "prod_preview_save",   title: "✅ Save"       },
          { id: "prod_preview_edit",   title: "✏️ Edit List"  },
          { id: "prod_preview_cancel", title: "❌ Cancel"     }
        ]
      });
    }

    // Save to DB
    const effectiveBranchId = getEffectiveBranchId(caller, biz.sessionData);
    const saved = await Promise.all(
      pendingNames.map(name =>
        Product.create({
          businessId: biz._id,
          branchId:   effectiveBranchId,
          name,
          unitPrice:  0,
          isService:  isService || false,
          isActive:   true,
          createdBy:  phone
        })
      )
    );

    const label  = isService ? "service" : "product";
    const plural = isService ? "services" : "products";
    const lines  = saved.map((p, i) => `✅ ${i + 1}. ${p.name}`).join("\n");
    await sendText(from,
      `🎉 *${saved.length} ${plural} saved!*\n\n${lines}\n\n` +
      `_Prices not set - use_ *Update ${label.charAt(0).toUpperCase() + label.slice(1)} ${isService ? "Rates" : "Prices"}* _to add them._`
    );

    // ── FIX D: Sync BEFORE session reset so we don't lose context ───────────────
    // Sync all saved items to SupplierProfile.listedProducts AND Product model.
    // This covers: new products added via chatbot dashboard AND pure biz-tools users.
    const _bizId  = biz._id;
    const _isServiceSaved = isService || false;
    const _effectiveBranch = effectiveBranchId || null;
    try {
      const SupplierProfile = (await import("../models/supplierProfile.js")).default;
      const _newNames = saved.map(p => p.name);

      // 1. Always upsert into Product model - works for both supplier and non-supplier users
      for (const _itemName of _newNames) {
        await Product.findOneAndUpdate(
          { businessId: _bizId, name: _itemName },
          { $set: {
              businessId: _bizId,
              branchId:   _effectiveBranch,
              unitPrice:  saved.find(p => p.name === _itemName)?.unitPrice || 0,
              isService:  _isServiceSaved,
              isActive:   true
            }
          },
          { upsert: true }
        );
      }

      // 2. If this business has a linked SupplierProfile, keep it in sync too
      const _supplier = await SupplierProfile.findOne({ businessId: _bizId });
      if (_supplier) {
        const _existing = [...new Set([
          ...(_supplier.listedProducts || []),
          ...(_supplier.products       || [])
        ])];
        _supplier.listedProducts = [...new Set([..._existing, ..._newNames])];
        _supplier.markModified("listedProducts");
        await _supplier.save();
      }
      console.log(`[SYNC-PROD] ${_newNames.length} items synced to Product model${_supplier ? " + SupplierProfile" : ""} for biz ${_bizId}`);
    } catch (_syncErr) {
      console.error("[SYNC-PROD] sync error:", _syncErr.message);
    }

    biz.sessionState = "ready"; biz.sessionData = {};
    await saveBizSafe(biz);
    const { sendProductsMenu } = await import("./metaMenus.js");
    return sendProductsMenu(from);
  }

  /* ===========================
     ADD SERVICES - NAME ENTRY
     State: service_add_name
     Identical to product_add_name but sets isService=true.
  =========================== */
  if (state === "service_add_name") {
    const raw = trimmed;
    if (!raw || raw.length < 2) {
      await sendPromptWithMenu(from,
        "❌ Enter a valid service name.\n\n" +
        "_Add multiple at once with commas:_\n" +
        "_house wiring, solar installation, geyser repair_"
      );
      return true;
    }

    const names = parseCommaNames(raw);
    if (!names.length) {
      await sendPromptWithMenu(from, "❌ Enter at least one name (min 2 characters):");
      return true;
    }

    const { buildSavePreviewText } = await import("./invoiceHelpers.js");
    const preview = buildSavePreviewText(names, true);

    biz.sessionState = "product_add_preview";
    biz.sessionData  = {
      ...biz.sessionData,
      pendingNames: names,
      isService:    true
    };
    await saveBizSafe(biz);

    return sendButtons(from, {
      text: preview,
      buttons: [
        { id: "prod_preview_save",   title: "✅ Save Services" },
        { id: "prod_preview_edit",   title: "✏️ Edit List"     },
        { id: "prod_preview_cancel", title: "❌ Cancel"        }
      ]
    });
  }

  /* ===========================
     UPDATE PRODUCT PRICES
     State: product_update_prices
     User types: "1 x 12, 2 x 35, 3 x 28"
  =========================== */
  if (state === "product_update_prices") {
    const catalogue = biz.sessionData.updateCatalogue || [];
    if (!catalogue.length) {
      biz.sessionState = "ready"; biz.sessionData = {};
      await saveBizSafe(biz);
      const { sendProductsMenu } = await import("./metaMenus.js");
      return sendProductsMenu(from);
    }

    if (trimmed.toLowerCase() === "cancel") {
      biz.sessionState = "ready"; biz.sessionData = {};
      await saveBizSafe(biz);
      await sendText(from, "❌ Price update cancelled.");
      const { sendProductsMenu } = await import("./metaMenus.js");
      return sendProductsMenu(from);
    }

    const { parsePriceUpdates } = await import("./invoiceHelpers.js");
    const { updates, errors }   = parsePriceUpdates(trimmed, catalogue);

    if (!updates.length) {
      const numbered = catalogue
        .map((p, i) => `${i + 1}. *${p.name}* - ${p.unitPrice > 0 ? formatMoney(p.unitPrice, biz.currency) : "_(no price)_"}`)
        .join("\n");
      const errLine = errors.length ? `\n\n⚠️ Skipped: ${errors.join(", ")}` : "";
      await sendText(from,
        `❌ Couldn't read that.${errLine}\n\n${numbered}\n\n` +
        `Enter *item number × price*:\n_1 x 12, 2 x 35, 3 x 28_`
      );
      return sendButtons(from, {
        text: "Type your price updates above, or cancel:",
        buttons: [{ id: "inv_cancel", title: "❌ Cancel" }]
      });
    }

    // Store pending updates for confirmation
    biz.sessionData.pendingPriceUpdates = updates;
    biz.sessionState = "product_update_prices_confirm";
    await saveBizSafe(biz);

    const { buildPriceUpdatePreviewText } = await import("./invoiceHelpers.js");
    const preview = buildPriceUpdatePreviewText(updates, biz.currency, false);
    const errNote = errors.length ? `\n\n⚠️ Skipped: ${errors.join(", ")}` : "";
    await sendText(from, preview + errNote);
    return sendButtons(from, {
      text: "Confirm or re-enter:",
      buttons: [
        { id: "prod_prices_confirm_save", title: "✅ Save Prices"  },
        { id: "prod_prices_confirm_edit", title: "✏️ Re-enter"     },
        { id: "inv_cancel",              title: "❌ Cancel"        }
      ]
    });
  }

  /* ===========================
     UPDATE PRODUCT PRICES - CONFIRM
  =========================== */
  if (state === "product_update_prices_confirm") {
    const isEdit = text === "prod_prices_confirm_edit";
    const isCancel = text === "inv_cancel" || trimmed.toLowerCase() === "cancel";

    if (isCancel) {
      biz.sessionState = "ready"; biz.sessionData = {};
      await saveBizSafe(biz);
      await sendText(from, "❌ Cancelled.");
      const { sendProductsMenu } = await import("./metaMenus.js");
      return sendProductsMenu(from);
    }

    if (isEdit) {
      biz.sessionData.pendingPriceUpdates = [];
      biz.sessionState = "product_update_prices";
      await saveBizSafe(biz);
      const catalogue = biz.sessionData.updateCatalogue || [];
      const numbered = catalogue
        .map((p, i) => `${i + 1}. *${p.name}* - ${p.unitPrice > 0 ? formatMoney(p.unitPrice, biz.currency) : "_(no price)_"}`)
        .join("\n");
      await sendText(from, `✏️ *Re-enter prices:*\n\n${numbered}\n\nFormat: *1 x 12, 2 x 35*`);
      return sendButtons(from, {
        text: "Type your price updates above, or cancel:",
        buttons: [{ id: "inv_cancel", title: "❌ Cancel" }]
      });
    }

    // Save
    const updates = biz.sessionData.pendingPriceUpdates || [];
    const catalogue = biz.sessionData.updateCatalogue   || [];

    for (const u of updates) {
      const product = catalogue[u.index];
      if (!product?._id) continue;
      await Product.findByIdAndUpdate(product._id, {
        $set: { unitPrice: u.price }
      });
    }

    const lines = updates.map(u => `✅ ${u.name} → ${formatMoney(u.price, biz.currency)}`).join("\n");
    await sendText(from, `✅ *${updates.length} price${updates.length === 1 ? "" : "s"} updated!*\n\n${lines}`);

    // ── FIX B: Sync updated prices back to SupplierProfile.prices ────────────
    try {
      const SupplierProfile = (await import("../models/supplierProfile.js")).default;
      const _sup = await SupplierProfile.findOne({ businessId: biz._id });
      if (_sup) {
        for (const u of updates) {
          const existing = (_sup.prices || []).find(
            p => p.product?.toLowerCase() === u.name.toLowerCase()
          );
          if (existing) {
            existing.amount = u.price;
          } else {
            _sup.prices.push({ product: u.name, amount: u.price, currency: biz.currency || "USD" });
          }
        }
        _sup.priceUpdatedAt = new Date();
        _sup.markModified("prices");
        await _sup.save();
        console.log(`[SYNC-PRICES] ${updates.length} prices synced to SupplierProfile for biz ${biz._id}`);
      }
    } catch (_priceSyncErr) {
      console.error("[SYNC-PRICES]", _priceSyncErr.message);
    }

    biz.sessionState = "ready"; biz.sessionData = {};
    await saveBizSafe(biz);
    const { sendProductsMenu } = await import("./metaMenus.js");
    return sendProductsMenu(from);
  }

  /* ===========================
     UPDATE SERVICE RATES
     State: service_update_rates
     User types: "1 x 20/hour, 2 x 50/job, 3 x 10/meter"
     If user types a number without a rate (e.g. "1 x 50"), ask them to confirm rate type.
  =========================== */
  if (state === "service_update_rates") {
    const catalogue = biz.sessionData.updateCatalogue || [];
    if (!catalogue.length) {
      biz.sessionState = "ready"; biz.sessionData = {};
      await saveBizSafe(biz);
      const { sendProductsMenu } = await import("./metaMenus.js");
      return sendProductsMenu(from);
    }

    if (trimmed.toLowerCase() === "cancel") {
      biz.sessionState = "ready"; biz.sessionData = {};
      await saveBizSafe(biz);
      await sendText(from, "❌ Cancelled.");
      const { sendProductsMenu } = await import("./metaMenus.js");
      return sendProductsMenu(from);
    }

    const { parsePriceUpdates } = await import("./invoiceHelpers.js");
    const { updates, errors }   = parsePriceUpdates(trimmed, catalogue);

    if (!updates.length) {
      const numbered = catalogue
        .map((p, i) => {
          const rate = p.unitPrice > 0 && p.rateUnit
            ? `${formatMoney(p.unitPrice, biz.currency)}/${p.rateUnit}`
            : p.unitPrice > 0 ? formatMoney(p.unitPrice, biz.currency) : "_(no rate)_";
          return `${i + 1}. *${p.name}* - ${rate}`;
        })
        .join("\n");
      const errLine = errors.length ? `\n\n⚠️ Skipped: ${errors.join(", ")}` : "";
      await sendText(from,
        `❌ Couldn't read that.${errLine}\n\n${numbered}\n\n` +
        `Format: *1 x 20/hour, 2 x 50/job, 3 x 10/meter*\n\n` +
        `Rate types: /job /hour /day /meter /room /visit /project`
      );
      return sendButtons(from, {
        text: "Type your rate updates above, or cancel:",
        buttons: [{ id: "inv_cancel", title: "❌ Cancel" }]
      });
    }

    // Check if any update is missing a rate unit
    const noRateUpdates = updates.filter(u => !u.rateUnit);

    if (noRateUpdates.length) {
      // Ask user to confirm rate type for unspecified ones
      biz.sessionData.pendingPriceUpdates  = updates;
      biz.sessionData.rateConfirmIndex     = updates.findIndex(u => !u.rateUnit);
      biz.sessionState = "service_update_rates_confirm_unit";
      await saveBizSafe(biz);

      const u = noRateUpdates[0];
      return sendButtons(from, {
        text: `⚠️ *${u.name}* - ${formatMoney(u.price, biz.currency)}\n\nWhat rate type?`,
        buttons: [
          { id: "svc_rate_per_job",   title: "📋 Per job"   },
          { id: "svc_rate_per_hour",  title: "⏱ Per hour"  },
          { id: "svc_rate_per_day",   title: "📅 Per day"   },
          { id: "svc_rate_per_meter", title: "📏 Per meter" }
        ]
      });
    }

    // All have rate units - show preview
    biz.sessionData.pendingPriceUpdates = updates;
    biz.sessionState = "service_update_rates_confirm";
    await saveBizSafe(biz);

    const { buildPriceUpdatePreviewText } = await import("./invoiceHelpers.js");
    const preview = buildPriceUpdatePreviewText(updates, biz.currency, true);
    const errNote = errors.length ? `\n\n⚠️ Skipped: ${errors.join(", ")}` : "";
    await sendText(from, preview + errNote);
    return sendButtons(from, {
      text: "Confirm or re-enter:",
      buttons: [
        { id: "svc_rates_confirm_save", title: "✅ Save Rates"  },
        { id: "svc_rates_confirm_edit", title: "✏️ Re-enter"    },
        { id: "inv_cancel",            title: "❌ Cancel"      }
      ]
    });
  }

  /* ===========================
     SERVICE RATES - CONFIRM RATE UNIT (when user omitted /unit)
  =========================== */
  if (state === "service_update_rates_confirm_unit") {
    const RATE_BUTTON_MAP = {
      svc_rate_per_job:   "job",
      svc_rate_per_hour:  "hour",
      svc_rate_per_day:   "day",
      svc_rate_per_meter: "meter",
      svc_rate_per_room:  "room",
      svc_rate_per_visit: "visit"
    };

    const selectedUnit = RATE_BUTTON_MAP[text] || trimmed.toLowerCase();
    const updates = biz.sessionData.pendingPriceUpdates || [];
    const idx     = biz.sessionData.rateConfirmIndex ?? -1;

    if (idx >= 0 && idx < updates.length) {
      updates[idx].rateUnit = selectedUnit;
    }

    // Find next one without a rate unit
    const nextIdx = updates.findIndex((u, i) => i > idx && !u.rateUnit);
    if (nextIdx >= 0) {
      biz.sessionData.rateConfirmIndex = nextIdx;
      await saveBizSafe(biz);
      const u = updates[nextIdx];
      return sendButtons(from, {
        text: `⚠️ *${u.name}* - ${formatMoney(u.price, biz.currency)}\n\nWhat rate type?`,
        buttons: [
          { id: "svc_rate_per_job",   title: "📋 Per job"   },
          { id: "svc_rate_per_hour",  title: "⏱ Per hour"  },
          { id: "svc_rate_per_day",   title: "📅 Per day"   },
          { id: "svc_rate_per_meter", title: "📏 Per meter" }
        ]
      });
    }

    // All units set - show preview
    biz.sessionData.pendingPriceUpdates = updates;
    biz.sessionState = "service_update_rates_confirm";
    await saveBizSafe(biz);

    const { buildPriceUpdatePreviewText } = await import("./invoiceHelpers.js");
    const preview = buildPriceUpdatePreviewText(updates, biz.currency, true);
    await sendText(from, preview);
    return sendButtons(from, {
      text: "Confirm or re-enter:",
      buttons: [
        { id: "svc_rates_confirm_save", title: "✅ Save Rates" },
        { id: "svc_rates_confirm_edit", title: "✏️ Re-enter"   },
        { id: "inv_cancel",            title: "❌ Cancel"     }
      ]
    });
  }

  /* ===========================
     SERVICE RATES - CONFIRM SAVE
  =========================== */
  if (state === "service_update_rates_confirm") {
    const isEdit   = text === "svc_rates_confirm_edit";
    const isCancel = text === "inv_cancel" || trimmed.toLowerCase() === "cancel";

    if (isCancel) {
      biz.sessionState = "ready"; biz.sessionData = {};
      await saveBizSafe(biz);
      await sendText(from, "❌ Cancelled.");
      const { sendProductsMenu } = await import("./metaMenus.js");
      return sendProductsMenu(from);
    }

    if (isEdit) {
      biz.sessionData.pendingPriceUpdates = [];
      biz.sessionState = "service_update_rates";
      await saveBizSafe(biz);
      const catalogue = biz.sessionData.updateCatalogue || [];
      const numbered  = catalogue
        .map((p, i) => `${i + 1}. *${p.name}*`)
        .join("\n");
      await sendText(from, `✏️ *Re-enter service rates:*\n\n${numbered}\n\nFormat: *1 x 20/hour, 2 x 50/job*`);
      return sendButtons(from, {
        text: "Type your rate updates above, or cancel:",
        buttons: [{ id: "inv_cancel", title: "❌ Cancel" }]
      });
    }

    // Save to DB
    const updates  = biz.sessionData.pendingPriceUpdates || [];
    const catalogue = biz.sessionData.updateCatalogue    || [];

    for (const u of updates) {
      const product = catalogue[u.index];
      if (!product?._id) continue;
      await Product.findByIdAndUpdate(product._id, {
        $set: { unitPrice: u.price, rateUnit: u.rateUnit || null }
      });
    }

    const lines = updates.map(u => {
      const display = u.rateUnit
        ? `${formatMoney(u.price, biz.currency)}/${u.rateUnit}`
        : formatMoney(u.price, biz.currency);
      return `✅ ${u.name} → ${display}`;
    }).join("\n");
    await sendText(from, `✅ *${updates.length} rate${updates.length === 1 ? "" : "s"} updated!*\n\n${lines}`);

    // ── FIX C: Sync updated rates back to SupplierProfile.rates ─────────────
    try {
      const SupplierProfile = (await import("../models/supplierProfile.js")).default;
      const _sup2 = await SupplierProfile.findOne({ businessId: biz._id });
      if (_sup2) {
        for (const u of updates) {
          const rateStr = u.rateUnit ? `${u.price}/${u.rateUnit}` : String(u.price);
          const existing = (_sup2.rates || []).find(
            r => r.service?.toLowerCase() === u.name.toLowerCase()
          );
          if (existing) {
            existing.rate = rateStr;
          } else {
            _sup2.rates.push({ service: u.name, rate: rateStr });
          }
        }
        _sup2.priceUpdatedAt = new Date();
        _sup2.markModified("rates");
        await _sup2.save();
        console.log(`[SYNC-RATES] ${updates.length} rates synced to SupplierProfile for biz ${biz._id}`);
      }
    } catch (_rateSyncErr) {
      console.error("[SYNC-RATES]", _rateSyncErr.message);
    }

    biz.sessionState = "ready"; biz.sessionData = {};
    await saveBizSafe(biz);
    const { sendProductsMenu } = await import("./metaMenus.js");
    return sendProductsMenu(from);
  }

  /* ===========================
     CASH BALANCE: SET OPENING BALANCE
  =========================== */
  if (state === "cash_set_opening_balance") {
    if (trimmed.toLowerCase() === "cancel") {
      biz.sessionState = "ready"; biz.sessionData = {}; await saveBizSafe(biz);
      const { sendCashBalanceMenu } = await import("./metaMenus.js");
      return sendCashBalanceMenu(from);
    }

    const amount = Number(trimmed);
    if (isNaN(amount) || amount < 0) { await sendPromptWithMenu(from, "❌ Invalid amount. Enter a number (e.g. 500):"); return true; }

    const targetBranchId = biz.sessionData.targetBranchId || caller?.branchId || null;
    if (!targetBranchId) { await sendText(from, "❌ No branch found. Contact your manager."); biz.sessionState = "ready"; biz.sessionData = {}; await saveBizSafe(biz); await sendMainMenu(from); return true; }

    const CashBalance = (await import("../models/cashBalance.js")).default;
    const today = new Date(); today.setHours(0, 0, 0, 0);

    await CashBalance.findOneAndUpdate(
      { businessId: biz._id, branchId: targetBranchId, date: today },
      { $set: { openingBalance: amount, closingBalance: amount } },
      { upsert: true }
    );

    biz.sessionState = "ready"; biz.sessionData = {}; await saveBizSafe(biz);
    const Branch = (await import("../models/branch.js")).default;
    const branch = await Branch.findById(targetBranchId);
    await sendText(from, `✅ Opening balance set to *${amount} ${biz.currency}*${branch ? ` for *${branch.name}*` : ""}`);

    // ── Notify ───────────────────────────────────────────────────────────────
    try {
      const { notifyOpeningBalanceSet } = await import("./bizNotifications.js");
      await notifyOpeningBalanceSet({
        biz, amount, clerkPhone: phone,
        branchName: branch?.name || null, branchId: targetBranchId
      });
    } catch (_n) { console.error("[OB NOTIF]", _n.message); }

    const { sendCashBalanceMenu } = await import("./metaMenus.js");
    return sendCashBalanceMenu(from);
  }

  /* ===========================
     CASH BALANCE: PAYOUT AMOUNT
  =========================== */
  if (state === "cash_payout_amount") {
    if (trimmed.toLowerCase() === "cancel") {
      biz.sessionState = "ready"; biz.sessionData = {}; await saveBizSafe(biz);
      const { sendCashBalanceMenu } = await import("./metaMenus.js");
      return sendCashBalanceMenu(from);
    }

    const amount = Number(trimmed);
    if (isNaN(amount) || amount <= 0) { await sendPromptWithMenu(from, "❌ Invalid amount. Enter a number greater than 0:"); return true; }

    biz.sessionData.payoutAmount = amount;
    biz.sessionState = "cash_payout_reason";
    await saveBizSafe(biz);
    await sendPromptWithMenu(from, "📝 *Enter reason for payout* (e.g. Owner drawing, Petty cash):");
    return true;
  }

  /* ===========================
     CASH BALANCE: PAYOUT REASON
  =========================== */
  if (state === "cash_payout_reason") {
    if (trimmed.toLowerCase() === "cancel") {
      biz.sessionState = "ready"; biz.sessionData = {}; await saveBizSafe(biz);
      const { sendCashBalanceMenu } = await import("./metaMenus.js");
      return sendCashBalanceMenu(from);
    }

    const reason = trimmed || "No reason given";
    const amount = biz.sessionData?.payoutAmount;
    const targetBranchId = biz.sessionData?.targetBranchId || caller?.branchId || null;

    if (!amount || amount <= 0) {
      biz.sessionState = "ready"; biz.sessionData = {};
      await saveBizSafe(biz);
      await sendText(from, "❌ Payout amount missing. Please start again.");
      const { sendCashBalanceMenu } = await import("./metaMenus.js");
      return sendCashBalanceMenu(from);
    }

    // Save payout record
    let payoutDoc = null;
    try {
      const CashPayout = (await import("../models/cashPayout.js")).default;
      const today = new Date(); today.setHours(0, 0, 0, 0);
      payoutDoc = await CashPayout.create({
        businessId: biz._id,
        branchId:   targetBranchId,
        amount,
        reason,
        recordedBy: phone,
        date:       today
      });
    } catch (dbErr) {
      console.error("[PAYOUT SAVE]", dbErr.message);
      await sendText(from, "❌ Error saving payout. Please try again.");
      return true;
    }

    biz.sessionState = "ready"; biz.sessionData = {}; await saveBizSafe(biz);

    const Branch = (await import("../models/branch.js")).default;
    const branch = targetBranchId ? await Branch.findById(targetBranchId).lean() : null;
    const cur    = biz.currency;

    await sendText(from,
`✅ *Payout Recorded*

  💵 Amount: *${amount} ${cur}*
  📝 Reason: ${reason}${branch ? `
  🏬 Branch: ${branch.name}` : ""}

_Cash balance updated._`
    );

    // ── Notify owners/managers/clerk ─────────────────────────────────────────
    try {
      const { notifyPayoutRecorded } = await import("./bizNotifications.js");
      await notifyPayoutRecorded({
        biz,
        payout: { amount, reason },
        clerkPhone: phone,
        branchName: branch?.name || null,
        branchId:   targetBranchId
      });
    } catch (_n) { console.error("[PAYOUT NOTIF]", _n.message); }

    const { sendCashBalanceMenu } = await import("./metaMenus.js");
    return sendCashBalanceMenu(from);
  }

/* ===========================
   CASH HANDOVER: STEP 1 - AMOUNT COUNTED
   =========================== */
  if (state === "cash_handover_amount") {
    if (trimmed.toLowerCase() === "cancel") {
      biz.sessionState = "ready"; biz.sessionData = {}; await saveBizSafe(biz);
      const { sendCashBalanceMenu } = await import("./metaMenus.js");
      return sendCashBalanceMenu(from);
    }

    const amount = Number(trimmed.replace(/[^0-9.]/g, ""));
    if (isNaN(amount) || amount < 0) {
      await sendPromptWithMenu(from, "❌ Invalid amount. Enter the cash total in the till (e.g. *340.50*):");
      return true;
    }


    // ── Handover balance enforcement ──────────────────────────────────────────
    // A clerk cannot hand over more cash than their current running custody balance.
    // We compute this in real time: all credits they received minus all debits they
    // recorded and all previous handovers they gave out.
    try {
      const InvoicePaymentM = (await import("../models/invoicePayment.js")).default;
      const InvoiceM        = (await import("../models/invoice.js")).default;
      const ExpenseM        = (await import("../models/expense.js")).default;
      const CashPayoutM     = (await import("../models/cashPayout.js")).default;
      const CashHandoverM   = (await import("../models/cashHandover.js")).default;

      const bQ = { businessId: biz._id };

      const [pmtsIn, rcptsIn, expsOut, payoutsOut, hOut, hIn] = await Promise.all([
        InvoicePaymentM.aggregate([
          { $match: { ...bQ, $or: [{ createdBy: phone }, { recordedBy: phone }] } },
          { $group: { _id: null, t: { $sum: "$amount" } } }
        ]),
        InvoiceM.aggregate([
          { $match: { ...bQ, type: "receipt", $or: [{ createdBy: phone }, { recordedBy: phone }] } },
          { $group: { _id: null, t: { $sum: "$total" } } }
        ]),
        ExpenseM.aggregate([
          { $match: { ...bQ, $or: [{ createdBy: phone }, { recordedBy: phone }] } },
          { $group: { _id: null, t: { $sum: "$amount" } } }
        ]),
        CashPayoutM.aggregate([
          { $match: { ...bQ, $or: [{ createdBy: phone }, { recordedBy: phone }] } },
          { $group: { _id: null, t: { $sum: "$amount" } } }
        ]).catch(() => []),
        CashHandoverM.aggregate([
          { $match: { ...bQ, outgoingPhone: phone } },
          { $group: { _id: null, t: { $sum: "$amountCounted" } } }
        ]).catch(() => []),
        CashHandoverM.aggregate([
          { $match: { ...bQ, incomingPhone: phone } },
          { $group: { _id: null, t: { $sum: "$amountCounted" } } }
        ]).catch(() => [])
      ]);

      const custodyBalance =
        (pmtsIn[0]?.t  || 0) +
        (rcptsIn[0]?.t || 0) +
        (hIn[0]?.t     || 0) -
        (expsOut[0]?.t  || 0) -
        (payoutsOut[0]?.t || 0) -
        (hOut[0]?.t    || 0);

      const cur = biz.currency || "USD";

      if (amount > custodyBalance + 0.01) {
        await sendText(from,
          `❌ *Cannot hand over ${amount} ${cur}*\n\n` +
          `Your current cash balance is *${custodyBalance.toFixed(2)} ${cur}*.\n\n` +
          `You can only hand over cash you actually hold.\n\n` +
          `Enter an amount up to *${custodyBalance.toFixed(2)} ${cur}*, or type *cancel* to abort.`
        );
        return true;  // Stay in cash_handover_amount so clerk can retry
      }

      // Store for confirmation message
      biz.sessionData.custodyBalanceAtHandover = custodyBalance;
    } catch (balErr) {
      console.error("[HANDOVER BALANCE CHECK]", balErr.message);
      // Non-blocking: if balance check fails, allow handover and log the error
    }
    // ── End balance enforcement ───────────────────────────────────────────────

    biz.sessionData.handoverAmount = amount;

    // Fetch branch colleagues for the incoming-staff picker
    const targetBranchId = biz.sessionData?.targetBranchId || caller?.branchId || null;
    let colleagues = [];
    try {
      const UserRoleModel = (await import("../models/userRole.js")).default;
      const q = { businessId: biz._id, pending: false, phone: { $ne: phone } };
      if (targetBranchId) q.branchId = targetBranchId;
      colleagues = await UserRoleModel.find(q).select("phone name firstName lastName role").lean();
    } catch (_) {}

    let colleagueMsg = "";
    if (colleagues.length > 0) {
      const list = colleagues.map((u, i) => {
        const name = u.name || `${u.firstName || ""} ${u.lastName || ""}`.trim() || u.phone;
        return `${i + 1}. ${name} (${u.role || "clerk"})`;
      });
      biz.sessionData.handoverColleagues = colleagues.map(u => ({
        phone: u.phone,
        name:  u.name || `${u.firstName || ""} ${u.lastName || ""}`.trim() || u.phone,
        role:  u.role || "clerk"
      }));
      colleagueMsg = `*Who are you handing over to?*\n\n${list.join("\n")}\n\nReply with a number, or type *owner* if handing to the owner.\nType *cancel* to abort.`;
    } else {
      colleagueMsg = `*Who are you handing over to?*\n\nNo other staff found. Type the person's name, or *owner*.`;
    }

    biz.sessionState = "cash_handover_incoming";
    await saveBizSafe(biz);
    await sendPromptWithMenu(from, `✅ Cash counted: *${amount} ${biz.currency || "USD"}*\n\n${colleagueMsg}`);
    return true;
  }

/* ===========================
   CASH HANDOVER: STEP 2 - INCOMING STAFF
   =========================== */
  if (state === "cash_handover_incoming") {
    if (trimmed.toLowerCase() === "cancel") {
      biz.sessionState = "ready"; biz.sessionData = {}; await saveBizSafe(biz);
      const { sendCashBalanceMenu } = await import("./metaMenus.js");
      return sendCashBalanceMenu(from);
    }

    const colleagues     = biz.sessionData?.handoverColleagues || [];
    let incomingPhone    = null;
    let incomingName     = "Unknown";
    let incomingRole     = "clerk";

    if (trimmed.toLowerCase() === "owner") {
      incomingName = "Owner"; incomingRole = "owner"; incomingPhone = null;
    } else {
      const idx = parseInt(trimmed, 10) - 1;
      if (!isNaN(idx) && colleagues[idx]) {
        incomingPhone = colleagues[idx].phone;
        incomingName  = colleagues[idx].name;
        incomingRole  = colleagues[idx].role;
      } else {
        incomingName = trimmed.slice(0, 40); // free-text name
      }
    }

    biz.sessionData.handoverIncomingPhone = incomingPhone;
    biz.sessionData.handoverIncomingName  = incomingName;
    biz.sessionData.handoverIncomingRole  = incomingRole;
    biz.sessionState = "cash_handover_note";
    await saveBizSafe(biz);

    await sendPromptWithMenu(from,
      `📝 *Any notes?* (discrepancies, pending transactions, float left, etc.)\n\nType your note or reply *none* to skip.`
    );
    return true;
  }

/* ===========================
   CASH HANDOVER: STEP 3 - NOTES + SAVE
   =========================== */
  if (state === "cash_handover_note") {
    if (trimmed.toLowerCase() === "cancel") {
      biz.sessionState = "ready"; biz.sessionData = {}; await saveBizSafe(biz);
      const { sendCashBalanceMenu } = await import("./metaMenus.js");
      return sendCashBalanceMenu(from);
    }

    const notes          = (trimmed.toLowerCase() === "none" || !trimmed) ? "" : trimmed;
    const amount         = biz.sessionData?.handoverAmount        || 0;
    const incomingPhone  = biz.sessionData?.handoverIncomingPhone || null;
    const incomingName   = biz.sessionData?.handoverIncomingName  || "Unknown";
    const incomingRole   = biz.sessionData?.handoverIncomingRole  || "clerk";
    const targetBranchId = biz.sessionData?.targetBranchId        || caller?.branchId || null;

    // Resolve outgoing staff name
    let outgoingName = phone;
    let outgoingRole = caller?.role || "clerk";
    try {
      const UserRoleModel = (await import("../models/userRole.js")).default;
      const me = await UserRoleModel.findOne({ phone, pending: false }).lean();
      if (me) {
        outgoingName = me.name || `${me.firstName || ""} ${me.lastName || ""}`.trim() || phone;
        outgoingRole = me.role || "clerk";
      }
    } catch (_) {}

    // Save handover record
    try {
      const CashHandover = (await import("../models/cashHandover.js")).default;
      const now   = new Date();
      const today = new Date(now); today.setHours(0, 0, 0, 0);
      await CashHandover.create({
        businessId:    biz._id,
        branchId:      targetBranchId,
        outgoingPhone: phone,
        outgoingName,
        outgoingRole,
        incomingPhone,
        incomingName,
        incomingRole,
        amountCounted: amount,
        notes,
        handoverAt:    now,
        date:          today
      });
    } catch (dbErr) {
      console.error("[HANDOVER SAVE]", dbErr.message);
      await sendText(from, "❌ Error saving handover. Please try again.");
      return true;
    }

    // Update closing balance so incoming clerk's opening is accurate
    try { await saveClosingBalance(biz, targetBranchId, new Date()); } catch (_) {}

    biz.sessionState = "ready"; biz.sessionData = {}; await saveBizSafe(biz);

    const cur    = biz.currency || "USD";
    const Branch = (await import("../models/branch.js")).default;
    const branch = targetBranchId ? await Branch.findById(targetBranchId).lean() : null;

    await sendText(from,
`✅ *Shift Handover Recorded*

   💵 Cash counted:  *${amount} ${cur}*
   👤 Outgoing:  ${outgoingName} (${outgoingRole})
   👤 Incoming:  ${incomingName} (${incomingRole})${branch ? `\n   🏬 Branch: ${branch.name}` : ""}${notes ? `\n   📝 ${notes}` : ""}

_This handover is logged and will appear in today's report._`
    );

    // Notify owner(s) and incoming clerk
    try {
      const UserRoleModel = (await import("../models/userRole.js")).default;
      const owners = await UserRoleModel.find({
        businessId: biz._id, role: "owner", pending: false,
        phone: { $ne: phone }
      }).lean();
      const notifMsg =
        `🔄 *Shift Handover - ${biz.name}*\n\n` +
        `   💵 Cash: ${amount} ${cur}\n` +
        `   Out: ${outgoingName} (${outgoingRole})\n` +
        `   In:  ${incomingName} (${incomingRole})\n` +
        (branch ? `   Branch: ${branch.name}\n` : "") +
        (notes  ? `   Notes: ${notes}\n` : "") +
        `\n_${new Date().toLocaleTimeString("en-GB")}_`;
      for (const o of owners) {
        try { await sendText(o.phone, notifMsg); } catch (_) {}
      }
      if (incomingPhone && incomingPhone !== phone) {
        try { await sendText(incomingPhone, notifMsg); } catch (_) {}
      }
    } catch (_n) { console.error("[HANDOVER NOTIF]", _n.message); }

    const { sendCashBalanceMenu } = await import("./metaMenus.js");
    return sendCashBalanceMenu(from);
  }


  // ══════════════════════════════════════════════════════════════════════════
  // RECURRING BILLING STATE HANDLERS
  // ══════════════════════════════════════════════════════════════════════════

  // ── Payment flow step 1: account picked ───────────────────────────────────
  if (state === "rb_payment_pick_account") {
    if (!a?.startsWith("rb_acct_")) {
      await sendText(from, "❌ Please select an account from the list.");
      return true;
    }
    const acctId = a.replace("rb_acct_", "");
    const RecurringAccount = (await import("../models/recurringAccount.js")).default;
    const RecurringTenant  = (await import("../models/recurringTenant.js")).default;
    const acct   = await RecurringAccount.findOne({ _id: acctId, businessId: biz._id }).lean();
    if (!acct) {
      await sendText(from, "❌ Account not found.");
      biz.sessionState = "ready"; biz.sessionData = {}; await saveBizSafe(biz);
      return sendMainMenu(from);
    }
    // An account can host several tenants on different rentals (e.g. one
    // "Main House" account with Room 1 and Room 2 paying different rent).
    // If there's more than one, the clerk must say WHICH tenant the payment
    // is for - otherwise it could get applied to the wrong person's invoice.
    const tenants = await RecurringTenant.find({ accountId: acct._id, isActive: true }).lean();
    const cur = acct.currency || biz.currency || "USD";

    if (tenants.length > 1) {
      biz.sessionState = "rb_payment_pick_tenant";
      biz.sessionData   = { rbAccountId: acctId, rbAccountName: acct.name, rbCurrency: cur };
      await saveBizSafe(biz);
      const items = tenants.map(t => ({ id: `rb_tenant_${t._id}`, title: t.name }));
      items.push({ id: "recurring_billing_menu", title: "⬅ Cancel" });
      await sendList(from, `🏠 *${acct.name}* has ${tenants.length} tenants.\n👤 Who is this payment for?`, items);
      return true;
    }

    const tenant = tenants[0] || null;
    const { recomputeTenantBalance, recomputeAccountBalance } = await import("./recurringBilling.js");
    const balance = tenant
      ? await recomputeTenantBalance(biz._id, tenant._id)
      : await recomputeAccountBalance(biz._id, acct._id);

    biz.sessionState = "rb_payment_enter_amount";
    biz.sessionData  = {
      rbAccountId:   acctId,
      rbAccountName: acct.name,
      rbTenantId:    tenant?._id?.toString() || null,
      rbTenantName:  tenant?.name || null,
      rbCurrency:    cur
    };
    await saveBizSafe(biz);

    await sendButtons(from, {
      text: `💰 *Record Payment*\n\n🏠 Account: *${acct.name}*${tenant ? `\n👤 Tenant: ${tenant.name}` : ""}\n💰 Current balance: *${balance.toFixed(2)} ${cur}*\n\nEnter the amount received (e.g. *300*):`,
      buttons: [{ id: "recurring_billing_menu", title: "⬅ Cancel" }]
    });
    return true;
  }

  // ── Payment flow step 1b: tenant picked (only when account has >1 tenant) ──
  if (state === "rb_payment_pick_tenant") {
    if (!a?.startsWith("rb_tenant_")) { await sendText(from, "❌ Please select a tenant."); return true; }
    const tenantId = a.replace("rb_tenant_", "");
    const RecurringTenant = (await import("../models/recurringTenant.js")).default;
    const tenant = await RecurringTenant.findById(tenantId).lean();
    if (!tenant) { await sendText(from, "❌ Tenant not found."); return true; }

    const { recomputeTenantBalance } = await import("./recurringBilling.js");
    const balance = await recomputeTenantBalance(biz._id, tenant._id);
    const cur = biz.sessionData.rbCurrency || biz.currency || "USD";

    biz.sessionState = "rb_payment_enter_amount";
    biz.sessionData.rbTenantId   = tenant._id.toString();
    biz.sessionData.rbTenantName = tenant.name;
    await saveBizSafe(biz);

    await sendButtons(from, {
      text: `💰 *Record Payment*\n\n🏠 Account: *${biz.sessionData.rbAccountName}*\n👤 Tenant: ${tenant.name}\n💰 Current balance: *${balance.toFixed(2)} ${cur}*\n\nEnter the amount received (e.g. *300*):`,
      buttons: [{ id: "recurring_billing_menu", title: "⬅ Cancel" }]
    });
    return true;
  }

  // ── Payment flow step 2: amount entered ───────────────────────────────────
  if (state === "rb_payment_enter_amount") {
    const raw = trimmed.replace(/[^0-9.]/g, "");
    const amount = Number(raw);
    if (isNaN(amount) || amount <= 0) {
      await sendPromptWithMenu(from, "❌ Invalid amount. Enter the payment amount (e.g. *300*):");
      return true;
    }
    biz.sessionData.rbPaymentAmount = amount;
    biz.sessionState = "rb_payment_confirm";
    await saveBizSafe(biz);

    const cur  = biz.sessionData.rbCurrency || biz.currency || "USD";
    await sendList(from, `💰 Confirm *${amount} ${cur}* for *${biz.sessionData.rbAccountName}*${biz.sessionData.rbTenantName ? ` (${biz.sessionData.rbTenantName})` : ""}?`, [
      { id: "rb_pay_method_cash",     title: "💵 Cash"          },
      { id: "rb_pay_method_ecocash",  title: "📱 EcoCash"       },
      { id: "rb_pay_method_bank",     title: "🏦 Bank Transfer"  },
      { id: "rb_pay_method_innbucks", title: "💳 InnBucks"       },
      { id: "rb_pay_method_zipit",    title: "🔄 ZipIt"         },
      { id: "rb_pay_method_other",    title: "🔄 Other"         },
      { id: "recurring_billing_menu", title: "⬅ Cancel"         }
    ]);
    return true;
  }

  // ── Payment flow step 3: method selected → save ───────────────────────────
  if (state === "rb_payment_confirm" && a?.startsWith("rb_pay_method_")) {
    const method = a.replace("rb_pay_method_", "");
    const { rbAccountId, rbTenantId, rbPaymentAmount, rbCurrency, rbAccountName, rbTenantName } = biz.sessionData;
    biz.sessionState = "ready"; biz.sessionData = {}; await saveBizSafe(biz);

    try {
      const { recordRecurringPayment } = await import("./recurringBilling.js");
      const RecurringAccount = (await import("../models/recurringAccount.js")).default;
      const RecurringTenant  = (await import("../models/recurringTenant.js")).default;

      const { payment, invoice } = await recordRecurringPayment({
        businessId: biz._id,
        accountId:  rbAccountId,
        tenantId:   rbTenantId || null,
        amount:     rbPaymentAmount,
        method,
        clerkPhone: phone,
        date:       new Date()
      });

      const cur  = rbCurrency || biz.currency || "USD";
      const acct = await RecurringAccount.findById(rbAccountId).lean();

      await sendText(from,
`✅ *Payment Recorded*

🏠 Account: *${rbAccountName}*${rbTenantName ? `\n👤 Tenant: ${rbTenantName}` : ""}
💵 Amount: *${rbPaymentAmount} ${cur}*
💳 Method: ${method}
📅 ${new Date().toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}
${invoice ? `📄 Applied to: ${invoice.number} (${invoice.period})` : "💡 Recorded as advance payment"}

Remaining balance: *${(acct?.currentBalance || 0).toFixed(2)} ${cur}*`
      );

      // Notify tenant if they have notifications enabled and a phone number
      const tenant = rbTenantId ? await RecurringTenant.findById(rbTenantId).lean() : null;
      if (tenant?.phone && tenant?.notificationsEnabled) {
        try {
          await sendText(tenant.phone,
`✅ *Payment Received - ${biz.name}*

🏠 ${rbAccountName}
💵 Amount: *${rbPaymentAmount} ${cur}*
💳 Method: ${method}
📅 ${new Date().toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}

Thank you for your payment.`
          );
        } catch (_) {}
      }
    } catch (e) {
      await sendText(from, `❌ Payment failed: ${e.message}`);
    }

    const { sendRecurringBillingMenu } = await import("./metaMenus.js");
    return sendRecurringBillingMenu(from);
  }

  // ── Account statement: account picked → period picker ─────────────────────
  if (state === "rb_acct_stmt_pick_account") {
    if (!a?.startsWith("rb_acct_")) {
      await sendText(from, "❌ Please select an account.");
      return true;
    }
    const acctId = a.replace("rb_acct_", "");
    biz.sessionState = "rb_acct_stmt_pick_period";
    biz.sessionData  = { rbAccountId: acctId };
    await saveBizSafe(biz);

    const now = new Date();
    const months = [-2, -1, 0].map(offset => {
      const d = new Date(now.getFullYear(), now.getMonth() + offset, 1);
      return { label: d.toLocaleDateString("en-GB", { month: "long", year: "numeric" }), month: d.getMonth(), year: d.getFullYear() };
    });
    await sendList(from, "📅 Select period:", [
      ...months.map(m => ({ id: `rb_period_${m.year}_${m.month}`, title: m.label })),
      { id: "rb_period_custom",      title: "📅 Custom Range"   },
      { id: "recurring_billing_menu", title: "⬅ Cancel"         }
    ]);
    return true;
  }

  // ── Account statement: period picked / custom date typed → generate PDF ───
  if (state === "rb_acct_stmt_pick_period") {
    const acctId = biz.sessionData?.rbAccountId;
    if (!acctId) { biz.sessionState = "ready"; biz.sessionData = {}; await saveBizSafe(biz); return sendMainMenu(from); }

    let periodStart, periodEnd, pl;

    if (a === "rb_period_custom") {
      biz.sessionState = "rb_acct_stmt_custom_date";
      await saveBizSafe(biz);
      await sendButtons(from, {
        text: "🗓 Enter date range:\n*01 Jun - 30 Jun*\n*01/06 - 30/06*",
        buttons: [{ id: "recurring_billing_menu", title: "⬅ Cancel" }]
      });
      return true;
    } else if (a?.startsWith("rb_period_")) {
      const parts = a.replace("rb_period_", "").split("_");
      const year  = parseInt(parts[0], 10);
      const month = parseInt(parts[1], 10);
      periodStart = new Date(year, month, 1, 0, 0, 0, 0);
      periodEnd   = new Date(year, month + 1, 0, 23, 59, 59, 999);
      pl = periodStart.toLocaleDateString("en-GB", { month: "long", year: "numeric" });
    } else {
      await sendText(from, "❌ Please tap a period from the list.");
      return true;
    }

    biz.sessionState = "ready"; biz.sessionData = {}; await saveBizSafe(biz);
    await _generateAndSendAccountStatement({ biz, from, acctId, periodStart, periodEnd, pl });
    const { sendRecurringBillingMenu } = await import("./metaMenus.js");
    return sendRecurringBillingMenu(from);
  }

  // ── Account statement: custom date text typed ─────────────────────────────
  if (state === "rb_acct_stmt_custom_date") {
    const range = parseCustomDateRange(trimmed);
    if (!range) {
      await sendText(from, "❌ Invalid format. Try: *01 Jun - 30 Jun*");
      return true;
    }
    const acctId = biz.sessionData?.rbAccountId;
    const pl = `${range.start.toLocaleDateString("en-GB", { day: "numeric", month: "short" })} – ${range.end.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}`;
    biz.sessionState = "ready"; biz.sessionData = {}; await saveBizSafe(biz);
    if (!acctId) return sendMainMenu(from);
    await _generateAndSendAccountStatement({ biz, from, acctId, periodStart: range.start, periodEnd: range.end, pl });
    const { sendRecurringBillingMenu } = await import("./metaMenus.js");
    return sendRecurringBillingMenu(from);
  }

  // ── Tenant statement: account picked → tenant picker ─────────────────────
  if (state === "rb_tenant_stmt_pick_account") {
    if (!a?.startsWith("rb_acct_")) { await sendText(from, "❌ Please select an account."); return true; }
    const acctId = a.replace("rb_acct_", "");
    const RecurringTenant = (await import("../models/recurringTenant.js")).default;
    const tenants = await RecurringTenant.find({ accountId: acctId, isActive: true }).lean();

    if (!tenants.length) {
      await sendText(from, "❌ No active tenants found for this account.");
      const { sendRecurringBillingMenu } = await import("./metaMenus.js");
      return sendRecurringBillingMenu(from);
    }

    biz.sessionData.rbAccountId = acctId;

    if (tenants.length === 1) {
      biz.sessionData.rbTenantId = tenants[0]._id.toString();
      biz.sessionState = "rb_tenant_stmt_pick_period";
      await saveBizSafe(biz);
    } else {
      biz.sessionState = "rb_tenant_stmt_pick_tenant";
      await saveBizSafe(biz);
    }

    const now = new Date();
    if (tenants.length === 1) {
      const months = [-2, -1, 0].map(offset => {
        const d = new Date(now.getFullYear(), now.getMonth() + offset, 1);
        return { label: d.toLocaleDateString("en-GB", { month: "long", year: "numeric" }), month: d.getMonth(), year: d.getFullYear() };
      });
      await sendList(from, `👤 Tenant: *${tenants[0].name}*\n📅 Select period:`, [
        ...months.map(m => ({ id: `rb_period_${m.year}_${m.month}`, title: m.label })),
        { id: "rb_period_all",          title: "📊 All Time"    },
        { id: "recurring_billing_menu", title: "⬅ Cancel"       }
      ]);
    } else {
      const items = tenants.map(t => ({ id: `rb_tenant_${t._id}`, title: t.name }));
      items.push({ id: "recurring_billing_menu", title: "⬅ Cancel" });
      await sendList(from, "👤 Select tenant:", items);
    }
    return true;
  }

  // ── Tenant statement: tenant picked → period picker ───────────────────────
  if (state === "rb_tenant_stmt_pick_tenant") {
    if (!a?.startsWith("rb_tenant_")) { await sendText(from, "❌ Please select a tenant."); return true; }
    const tenantId = a.replace("rb_tenant_", "");
    biz.sessionData.rbTenantId = tenantId;
    biz.sessionState = "rb_tenant_stmt_pick_period";
    await saveBizSafe(biz);

    const now = new Date();
    const months = [-2, -1, 0].map(offset => {
      const d = new Date(now.getFullYear(), now.getMonth() + offset, 1);
      return { label: d.toLocaleDateString("en-GB", { month: "long", year: "numeric" }), month: d.getMonth(), year: d.getFullYear() };
    });
    await sendList(from, "📅 Select period:", [
      ...months.map(m => ({ id: `rb_period_${m.year}_${m.month}`, title: m.label })),
      { id: "rb_period_all",          title: "📊 All Time"  },
      { id: "recurring_billing_menu", title: "⬅ Cancel"     }
    ]);
    return true;
  }

  // ── Tenant statement: period picked → generate PDF ────────────────────────
  if (state === "rb_tenant_stmt_pick_period") {
    const tenantId = biz.sessionData?.rbTenantId;
    if (!tenantId) { biz.sessionState = "ready"; biz.sessionData = {}; await saveBizSafe(biz); return sendMainMenu(from); }

    let periodStart, periodEnd, pl;
    if (a === "rb_period_all") {
      periodStart = new Date(2020, 0, 1, 0, 0, 0, 0);
      // Extend to end of next month so current-month invoices always appear
      const _now = new Date();
      periodEnd   = new Date(_now.getFullYear(), _now.getMonth() + 2, 0, 23, 59, 59, 999);
      pl = "All Time";
    } else if (a?.startsWith("rb_period_")) {
      const parts = a.replace("rb_period_", "").split("_");
      const year  = parseInt(parts[0], 10);
      const month = parseInt(parts[1], 10);
      periodStart = new Date(year, month, 1, 0, 0, 0, 0);
      periodEnd   = new Date(year, month + 1, 0, 23, 59, 59, 999);
      pl = periodStart.toLocaleDateString("en-GB", { month: "long", year: "numeric" });
    } else {
      const range = parseCustomDateRange(trimmed);
      if (!range) { await sendText(from, "❌ Invalid date. Try: *01 Jun - 30 Jun*"); return true; }
      periodStart = range.start; periodEnd = range.end;
      pl = `${range.start.toLocaleDateString("en-GB", { day: "numeric", month: "short" })} – ${range.end.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}`;
    }

    biz.sessionState = "ready"; biz.sessionData = {}; await saveBizSafe(biz);
    await sendText(from, `⏳ Building tenant statement for ${pl}...`);

    try {
      const { buildTenantStatement, generateTenantStatementPDF } = await import("./recurringBilling.js");
      const stmt = await buildTenantStatement({ businessId: biz._id, tenantId, periodStart, periodEnd });
      const cur  = stmt.cur;

      await sendText(from,
`👤 *TENANT STATEMENT*
${stmt.tenant.name}
${stmt.account ? `🏠 ${stmt.account.name}` : ""}
${pl}
━━━━━━━━━━━━━━━━━━━━
Opening Balance:   ${stmt.openingBalance.toFixed(2)} ${cur}
  + Charges:       ${stmt.totalCharged.toFixed(2)} ${cur}
  − Payments:      ${stmt.totalPaid.toFixed(2)} ${cur}
━━━━━━━━━━━━━━━━━━━━
Balance Due: *${stmt.closingBalance.toFixed(2)} ${cur}*
${stmt.rows.length} transactions

📄 Full statement PDF attached below ↓`
      );

      const { filename, url } = await generateTenantStatementPDF({ biz, stmt, periodLabel: pl });
      await sendDocument(from, { link: url, filename });
    } catch (e) {
      await sendText(from, `❌ Failed: ${e.message}`);
    }

    const { sendRecurringBillingMenu } = await import("./metaMenus.js");
    return sendRecurringBillingMenu(from);
  }

  // ── Unit expense: account picked → enter details ──────────────────────────
  if (state === "rb_expense_pick_account") {
    if (!a?.startsWith("rb_acct_")) { await sendText(from, "❌ Please select an account."); return true; }
    const acctId = a.replace("rb_acct_", "");
    const RecurringAccount = (await import("../models/recurringAccount.js")).default;
    const acct = await RecurringAccount.findOne({ _id: acctId, businessId: biz._id }).lean();
    if (!acct) { await sendText(from, "❌ Account not found."); const { sendRecurringBillingMenu } = await import("./metaMenus.js"); return sendRecurringBillingMenu(from); }

    biz.sessionState = "rb_expense_enter_details";
    biz.sessionData  = { rbAccountId: acctId, rbAccountName: acct.name };
    await saveBizSafe(biz);

    await sendButtons(from, {
      text: `🔧 *Add Expense - ${acct.name}*\n\nType description and amount on one line:\n*Plumber call-out 25*\n*Light bulb 3.50*\n*Zesa prepaid 40*`,
      buttons: [{ id: "recurring_billing_menu", title: "⬅ Cancel" }]
    });
    return true;
  }

  // ── Unit expense: details entered → save ──────────────────────────────────
  if (state === "rb_expense_enter_details") {
    const match = trimmed.match(/^(.+?)\s+(\d+(?:\.\d{1,2})?)$/);
    if (!match) {
      await sendPromptWithMenu(from, "❌ Format: *description amount* e.g. *Plumber 25* or *Zesa prepaid 40*:");
      return true;
    }
    const description = match[1].trim();
    const amount      = parseFloat(match[2]);
    const { rbAccountId, rbAccountName } = biz.sessionData;
    biz.sessionState = "ready"; biz.sessionData = {}; await saveBizSafe(biz);

    try {
      const RecurringExpense = (await import("../models/recurringExpense.js")).default;
      const now = new Date();
      await RecurringExpense.create({
        businessId:  biz._id,
        accountId:   rbAccountId,
        description,
        category:    "Maintenance",
        amount,
        currency:    biz.currency || "USD",
        date:        now,
        period:      now.toLocaleDateString("en-GB", { month: "long", year: "numeric" }),
        createdBy:   phone
      });
      await sendText(from,
        `✅ *Expense Recorded*\n\n🏠 Unit: ${rbAccountName}\n📝 ${description}\n💵 ${amount} ${biz.currency || "USD"}\n\n_Expense will appear on the unit statement._`
      );
    } catch (e) {
      await sendText(from, `❌ Failed to save expense: ${e.message}`);
    }

    const { sendRecurringBillingMenu } = await import("./metaMenus.js");
    return sendRecurringBillingMenu(from);
  }

  // END RECURRING BILLING STATE HANDLERS ────────────────────────────────────


  /* ===========================
     REPORT DATE FILTER - user types custom date range
  =========================== */
  if (state === "report_date_filter") {
    const reportAction = biz.sessionData?.filterFor || "detailed";
    const raw = (trimmed || "").trim();

    if (raw.toLowerCase() === "cancel") {
      biz.sessionState = "ready"; biz.sessionData = {}; await saveBizSafe(biz);
      return sendMainMenu(from);
    }

    const range = parseCustomDateRange(raw);
    if (!range) {
      await sendText(from,
        "❌ Couldn't understand that date range.\n\n" +
        "Try:\n" +
        "  *01 Jun - 27 Jun*\n" +
        "  *01/06 - 27/06*\n" +
        "  *2026-06-01 - 2026-06-27*\n\n" +
        "Or type *cancel* to go back."
      );
      return true;
    }

    biz.sessionData.customStart = range.start.toISOString();
    biz.sessionData.customEnd   = range.end.toISOString();

    // Self-serve clerk (rpt_self_custom): skip clerk picker, run own statement
    if (reportAction === "clerk_self") {
      let clerkPhone = from.replace(/\D+/g, "");
      if (clerkPhone.startsWith("0")) clerkPhone = "263" + clerkPhone.slice(1);
      biz.sessionState = "ready"; biz.sessionData = {}; await saveBizSafe(biz);
      return runClerkStatementReport({ biz, from, clerkPhone, period: "custom", customStart: range.start, customEnd: range.end });
    }

    // Admin clerk statement (rpt_clerk_custom): dates stored, now pick clerk
    if (reportAction === "clerk") {
      biz.sessionState = "report_clerk_pick_custom";
      await saveBizSafe(biz);
      return continueTwilioFlow({ from, text: "auto" });
    }

    // Detailed ledger
    biz.sessionState = "ready"; biz.sessionData = {}; await saveBizSafe(biz);
    return runDetailedLedgerReport({ biz, from, period: "custom", customStart: range.start, customEnd: range.end });
  }

/* ===========================
     SUPPLIER: ENTER ECOCASH (payment after registration)
  =========================== */
  if (state === "supplier_reg_enter_ecocash") {
    const waDigits = from.replace(/\D+/g, "");
    const raw = (trimmed || "").replace(/\D+/g, "");
    let ecocashPhone = trimmed.toLowerCase() === "same" ? waDigits : raw;
    if (ecocashPhone.startsWith("263") && ecocashPhone.length === 12) ecocashPhone = "0" + ecocashPhone.slice(3);
    if (!(ecocashPhone.startsWith("0") && ecocashPhone.length === 10)) {
      await sendText(from, "❌ Invalid EcoCash number.\n\nSend like: 0772123456\nOr type *same* to use this number.");
      return true;
    }

    const payment = biz.sessionData?.supplierPayment;
    const supplierId = biz.sessionData?.pendingSupplierId;

    if (!payment || !supplierId) {
      await sendText(from, "❌ Payment info missing. Please restart registration.");
      biz.sessionState = "ready"; biz.sessionData = {}; await saveBizSafe(biz);
      await sendMainMenu(from);
      return true;
    }

    const paynow = (await import("./paynow.js")).default;
    const SupplierProfile = (await import("../models/supplierProfile.js")).default;
    const SupplierSubscriptionPayment = (await import("../models/supplierSubscriptionPayment.js")).default;
    const { SUPPLIER_PLANS } = await import("./supplierPlans.js");

    const reference = `SUP_${supplierId}_${Date.now()}`;
    const paynowPayment = paynow.createPayment(reference, biz.ownerEmail || "supplier@zimquote.co.zw");
    paynowPayment.currency = payment.currency;
    paynowPayment.add(`ZimQuote Supplier ${payment.tier} plan`, payment.amount);

    const response = await paynow.sendMobile(paynowPayment, ecocashPhone, "ecocash");

    if (!response.success) {
      await sendText(from, "❌ Failed to start EcoCash payment. Please try again.");
      return true;
    }

    await SupplierSubscriptionPayment.create({
      supplierPhone: phone,
      supplierId,
      tier: payment.tier,
      plan: payment.plan,
      amount: payment.amount,
      currency: payment.currency,
      reference,
      pollUrl: response.pollUrl,
      ecocashPhone,
      status: "pending"
    });

    biz.sessionState = "supplier_reg_payment_pending";
    biz.sessionData.supplierPaynow = { reference, pollUrl: response.pollUrl };
    await saveBizSafe(biz);

    await sendText(from,
      `💳 *${payment.tier.toUpperCase()} Plan - $${payment.amount}*\n` +
      `EcoCash: ${ecocashPhone}\n\n` +
      `Please confirm the payment prompt on your phone.`
    );

    const pollUrl = response.pollUrl;
    let attempts = 0;
    const pollInterval = setInterval(async () => {
      attempts++;
      try {
        const status = await paynow.pollTransaction(pollUrl);
        if (status.status?.toLowerCase() === "paid") {
          clearInterval(pollInterval);

          const now = new Date();
          const tierRank = SUPPLIER_PLANS[payment.tier]?.tierRank || 1;
          const endsAt = new Date(now.getTime() + payment.durationDays * 24 * 60 * 60 * 1000);

          await SupplierProfile.findByIdAndUpdate(supplierId, {
            active: true,
            verified: true,
            tier: payment.tier,
            tierRank,
            subscriptionStatus: "active",
            subscriptionStartedAt: now,
            subscriptionEndsAt: endsAt,
            subscriptionPlan: payment.plan
          });

          await SupplierSubscriptionPayment.findOneAndUpdate(
            { reference },
            { status: "paid", paidAt: now, endsAt }
          );

          const freshBiz = await Business.findById(biz._id);
          if (freshBiz) {
            freshBiz.sessionState = "ready";
            freshBiz.sessionData = {};
            await freshBiz.save();
          }

          await sendText(from,
            `🎉 *You're now listed!*\n\n` +
            `✅ ${payment.tier.toUpperCase()} Plan active\n` +
            `📅 Renews: ${endsAt.toDateString()}\n\n` +
            `Buyers in your area can now find and order from you!`
          );

          const { sendMainMenu } = await import("./metaMenus.js");
          await sendMainMenu(from);
        }
        if (attempts >= 15) clearInterval(pollInterval);
      } catch (err) {
        console.error("Supplier payment poll error:", err);
      }
    }, 10000);

    return true;
  }

  return false;

  return false;
}

// ── Recurring Billing: account statement helper (used by two state handlers) ─
async function _generateAndSendAccountStatement({ biz, from, acctId, periodStart, periodEnd, pl }) {
  const { sendDocument } = await import("./metaSender.js");
  await sendText(from, `⏳ Building account statement for ${pl}...`);
  try {
    const { buildAccountStatement, generateAccountStatementPDF } = await import("./recurringBilling.js");
    const stmt = await buildAccountStatement({ businessId: biz._id, accountId: acctId, periodStart, periodEnd });
    const cur  = stmt.cur;

    await sendText(from,
`📋 *ACCOUNT STATEMENT*
${stmt.account.name}${stmt.account.ref ? ` (${stmt.account.ref})` : ""}
${stmt.tenant ? `👤 ${stmt.tenant.name}` : ""}
${pl}
━━━━━━━━━━━━━━━━━━━━
Opening Balance: ${stmt.openingBalance.toFixed(2)} ${cur}
  + Charges:     ${stmt.totalCharged.toFixed(2)} ${cur}
  − Payments:    ${stmt.totalPaid.toFixed(2)} ${cur}
━━━━━━━━━━━━━━━━━━━━
Closing Balance: *${stmt.closingBalance.toFixed(2)} ${cur}*
${stmt.rows.length} transactions

📄 Full statement PDF attached below ↓`
    );

    const { filename, url } = await generateAccountStatementPDF({ biz, stmt, periodLabel: pl });
    await sendDocument(from, { link: url, filename });
  } catch (e) {
    await sendText(from, `❌ Failed to generate statement: ${e.message}`);
  }
}