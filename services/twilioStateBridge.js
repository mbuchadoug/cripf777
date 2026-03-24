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

import { runDailyReportMetaEnhanced } from "./dailyReportEnhanced.js";
import { runWeeklyReportMetaEnhanced } from "./weeklyReportEnhanced.js";
import { runMonthlyReportMetaEnhanced } from "./monthlyReportEnhanced.js";


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
    report_daily: "reports",
    report_weekly: "reports",
    report_monthly: "reports",
    report_choose_branch: "reports",
    payment_amount: "payments",
    payment_method: "payments",
    expense_amount: "payments",
    expense_category: "payments",
    cash_set_opening_balance: "payments",
    cash_payout_amount: "payments",
    cash_payout_reason: "payments",
    invite_user_phone: "users"
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

  if (state === "report_daily") return runDailyReportMetaEnhanced({ biz, from });
  if (state === "report_weekly") return runWeeklyReportMetaEnhanced({ biz, from });
  if (state === "report_monthly") return runMonthlyReportMetaEnhanced({ biz, from });

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
   EXPENSE STEP 1 — CATEGORY TAPPED
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
   EXPENSE STEP 2 — AMOUNT TYPED
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
    text: `${cat} — *${formatMoney(amt, biz.currency)}*\n_${desc}_\n\n💳 How was it paid?`,
    buttons: [
      { id: "exp_method_cash",    title: "💵 Cash" },
      { id: "exp_method_ecocash", title: "📱 EcoCash" },
      { id: "exp_method_bank",    title: "🏦 Bank" }
    ]
  });
}

/* ===========================
   EXPENSE STEP 3 — METHOD TAPPED → SAVE + PDF
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
    `✅ *${expense.category}* — ${formatMoney(expense.amount, biz.currency)} (${method})`
  );

  const { sendExpenseAddAnotherMenu } = await import("./metaMenus.js");
  await sendExpenseAddAnotherMenu(from);
  return true;
}

/* =====================================================
   SMART BULK ENTRY — "fuel 30, lunch 15, zesa 50"
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

  // ── Commands ────────────────────────────────────────────────────────────
  if (lower === "cancel" || lower === "stop") {
    const count = biz.sessionData?.bulkExpenses?.length || 0;
    biz.sessionState = "ready"; biz.sessionData = {};
    await saveBizSafe(biz);
    await sendText(from, count > 0 ? `❌ Cancelled — ${count} item(s) discarded.` : "❌ Cancelled.");
    await sendMainMenu(from);
    return true;
  }

  if (lower === "list" || lower === "show") {
    const items = biz.sessionData?.bulkExpenses || [];
    if (!items.length) {
      await sendText(from, "📝 Nothing added yet.\n\nType: *fuel 30, lunch 15, zesa 50*");
      return true;
    }
    const total = items.reduce((s, e) => s + e.amount, 0);
    const lines = items.map((e, i) =>
      `${i + 1}. ${e.description} — ${formatMoney(e.amount, biz.currency)} (${e.method})`
    ).join("\n");
    await sendText(from,
      `📋 *${items.length} expense(s)*\n\n${lines}\n─────────────────\n*Total: ${formatMoney(total, biz.currency)}*\n\nType more or *done* to save.`
    );
    return true;
  }

  const removeMatch = lower.match(/^(?:remove|delete)\s+(\d+)$/);
  if (removeMatch) {
    const idx   = parseInt(removeMatch[1]) - 1;
    const items = biz.sessionData?.bulkExpenses || [];
    if (idx < 0 || idx >= items.length) {
      await sendText(from, `❌ Item ${idx + 1} not found. Type *list* to see all.`);
      return true;
    }
    const removed = items.splice(idx, 1)[0];
    biz.markModified("sessionData");
    await saveBizSafe(biz);
    await sendText(from,
      `✅ Removed: ${removed.description} — ${formatMoney(removed.amount, biz.currency)}\n${items.length} item(s) remaining.`
    );
    return true;
  }

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
      `${i + 1}. ${e.description} — ${formatMoney(e.amount, biz.currency)} (${e.method})`
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
        { id: "exp_bulk_confirm_no",  title: "✏️ Keep Editing" }
      ]
    });
  }

  // ── PARSE: "description amount [method], ..." ───────────────────────────
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

    parsed.push({
      description: descWords.join(" "),
      amount:      amt,
      category:    cat,
      method:      method || "Cash"
    });
  }

  if (!parsed.length) {
    await sendText(from,
`❌ Couldn't read that.

Format: *item amount* or *item amount method*

Examples:
_fuel 30_
_fuel 30, lunch 15, zesa 50_
_fuel 30 ecocash, rent 500 bank_
_salaries 850 bank_

Type *list* to see added · *done* to save`
    );
    return true;
  }

  if (!Array.isArray(biz.sessionData.bulkExpenses)) biz.sessionData.bulkExpenses = [];
  biz.sessionData.bulkExpenses.push(...parsed);
  biz.markModified("sessionData");
  await saveBizSafe(biz);

  const allItems = biz.sessionData.bulkExpenses;
  const runTotal = allItems.reduce((s, e) => s + e.amount, 0);
  const newLines = parsed
    .map(e => `• ${e.description} — ${formatMoney(e.amount, biz.currency)} (${e.method})`)
    .join("\n");
  const failNote = failed.length ? `\n⚠️ Skipped: ${failed.join(", ")}` : "";

  // Single item with no prior items → offer instant save
  if (allItems.length === 1 && parsed.length === 1) {
    biz.sessionState = "expense_bulk_confirm";
    await saveBizSafe(biz);
    return sendButtons(from, {
      text:
`✅ *${parsed[0].description}* — ${formatMoney(parsed[0].amount, biz.currency)} (${parsed[0].method})${failNote}

Save now or add more expenses?`,
      buttons: [
        { id: "exp_bulk_confirm_yes", title: "✅ Save" },
        { id: "exp_bulk_keep_adding", title: "➕ Add More" }
      ]
    });
  }

  await sendText(from,
`✅ *${parsed.length} added*${failNote}

${newLines}
─────────────────
Running total: *${formatMoney(runTotal, biz.currency)}* (${allItems.length} items)

Type more, *list* to review, or *done* to save`
  );
  return true;
}

/* =====================================================
   BULK CONFIRM → SAVE ALL TO DB + PDF
===================================================== */
if (state === "expense_bulk_confirm") {
  if (text === "exp_bulk_keep_adding") {
    biz.sessionState = "expense_smart_entry";
    await saveBizSafe(biz);
    const items    = biz.sessionData?.bulkExpenses || [];
    const runTotal = items.reduce((s, e) => s + e.amount, 0);
    await sendText(from,
      `➕ ${items.length} item(s) so far — ${formatMoney(runTotal, biz.currency)}\n\nKeep typing. *done* when finished.`
    );
    return true;
  }

  if (text === "exp_bulk_confirm_no") {
    biz.sessionState = "expense_smart_entry";
    await saveBizSafe(biz);
    await sendText(from, "✏️ Keep adding. Type *done* when finished.");
    return true;
  }

  if (text !== "exp_bulk_confirm_yes") {
    await sendText(from, "Tap *Save All* to confirm or keep typing expenses.");
    return true;
  }

  const items = biz.sessionData?.bulkExpenses || [];
  if (!items.length) {
    biz.sessionState = "ready"; biz.sessionData = {};
    await saveBizSafe(biz);
    await sendMainMenu(from);
    return true;
  }

  const effectiveBranchId = getEffectiveBranchId(caller, biz.sessionData);
  await Expense.insertMany(items.map(e => ({
    businessId:  biz._id,
    branchId:    effectiveBranchId,
    amount:      e.amount,
    description: e.description,
    category:    e.category,
    method:      e.method || "Cash",
    createdBy:   phone
  })));

  const total         = items.reduce((s, e) => s + e.amount, 0);
  const savedBranchId = biz.sessionData.targetBranchId;
  const lines         = items
    .map(e => `• ${e.description} — ${formatMoney(e.amount, biz.currency)} (${e.method})`)
    .join("\n");

  try {
    const receiptNum = `EXP-${Date.now()}`;
    const { filename } = await generatePDF({
      type: "receipt", number: receiptNum, date: new Date(),
      billingTo: "Expense Record",
      items: items.map(e => ({ item: `${e.category} — ${e.description}`, qty: 1, unit: e.amount, total: e.amount })),
      bizMeta: { name: biz.name, logoUrl: biz.logoUrl, address: biz.address || "", _id: biz._id.toString(), status: "paid" }
    });
    const site = (process.env.SITE_URL || "").replace(/\/$/, "");
    await sendDocument(from, { link: `${site}/docs/generated/receipts/${filename}`, filename });
  } catch (e) { console.error("[BULK EXP PDF]", e.message); }

  biz.sessionData  = { targetBranchId: savedBranchId };
  biz.sessionState = "expense_add_another_menu";
  await saveBizSafe(biz);

  await sendText(from,
`✅ *${items.length} expense(s) saved*

${lines}
─────────────────
Total: *${formatMoney(total, biz.currency)}*`
  );

  const { sendExpenseAddAnotherMenu } = await import("./metaMenus.js");
  await sendExpenseAddAnotherMenu(from);
  return true;
}

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
`✅ *Payment saved*  ${invoice.number} — ${formatMoney(amount, invoice.currency)} (${method})
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
    const phoneVal = isSkip ? null : (isSame ? phone : trimmed);

    const client = await Client.findOneAndUpdate(
      { businessId: biz._id, ...(phoneVal ? { phone: phoneVal } : { name: clientName, phone: null }) },
      { $set: { name: clientName, phone: phoneVal } },
      { upsert: true, new: true }
    );

    const docType = biz.sessionData?.docType || "invoice";
    biz.sessionData = {
      docType, targetBranchId: biz.sessionData?.targetBranchId, // ✅ preserve branch
      client, clientId: client._id,
      items: [], itemMode: null, lastItem: null, expectingQty: false, lastItemSource: null
    };
    biz.sessionState = "creating_invoice_add_items";
    await saveBizSafe(biz);

    await sendButtons(from, {
      text: "How would you like to add an item?",
      buttons: [{ id: "inv_item_catalogue", title: "📦 Catalogue" }, { id: "inv_item_custom", title: "✍️ Custom item" }]
    });
    return true;
  }

  /* ===========================
     INVOICE: QUICK ADD PRODUCT (NAME)
  =========================== */
  if (state === "invoice_quick_add_product_name") {
    const name = trimmed;
    if (!name || name.length < 2) { await sendPromptWithMenu(from, "❌ Please enter a valid product / service name:"); return true; }

    biz.sessionData.quickAddProduct = biz.sessionData.quickAddProduct || {};
    biz.sessionData.quickAddProduct.name = name;
    biz.sessionState = "invoice_quick_add_product_price";
    await saveBizSafe(biz);
    await sendPromptWithMenu(from, `📦 *${name}*\n\n💰 Enter price:`);
    return true;
  }

  /* ===========================
     INVOICE: QUICK ADD PRODUCT (PRICE → SAVE → ASK QTY)
  =========================== */
  if (state === "invoice_quick_add_product_price") {
    const price = Number(trimmed);
    if (isNaN(price) || price <= 0) { await sendPromptWithMenu(from, "❌ Enter a valid price (e.g. 10):"); return true; }

    const name = biz.sessionData?.quickAddProduct?.name;
    if (!name) { biz.sessionState = "creating_invoice_add_items"; await saveBizSafe(biz); await sendText(from, "⚠️ Product/Service name missing. Try again."); return true; }

    // ✅ Use effective branch
    const effectiveBranchId = getEffectiveBranchId(caller, biz.sessionData);

    const product = await Product.create({
      businessId: biz._id, branchId: effectiveBranchId,
      name, unitPrice: price, isActive: true
    });

    biz.sessionData.lastItem = { description: product.name, unit: product.unitPrice, source: "catalogue" };
    biz.sessionData.expectingQty = true;
    biz.sessionData.itemMode = "catalogue";
    biz.sessionData.quickAddProduct = null;
    biz.sessionState = "creating_invoice_add_items";
    await saveBizSafe(biz);

    await sendPromptWithMenu(from, `✅ Saved: *${product.name}* @ *${product.unitPrice}*\n\n🔢 Enter quantity (e.g. 1):`);
    return true;
  }

  /* ===========================
     ITEM ADDING
  ============================ */



// ── Quick-pick from numbered catalogue: "3x2, 7x1, 12x5" ─────────────────
// ── Quick-pick from numbered catalogue: "3x2, 7x1, 12x5" ─────────────────
if (state === "creating_invoice_pick_product") {
  const entries = trimmed.split(",").map(s => s.trim()).filter(Boolean);
  const picked = [];
  const errors = [];
  const catalogue = biz.sessionData?.catalogueProducts || [];

  for (const entry of entries) {
    const match = entry.match(/^(\d+)\s*[xX×]\s*(\d+(?:\.\d+)?)$/);
    if (!match) { errors.push(entry); continue; }

    const itemNum = parseInt(match[1], 10);
    const qty = parseFloat(match[2]);

    if (itemNum < 1 || itemNum > catalogue.length) {
      errors.push(`#${itemNum} out of range`);
      continue;
    }
    if (isNaN(qty) || qty <= 0) {
      errors.push(`bad qty for #${itemNum}`);
      continue;
    }

    const product = catalogue[itemNum - 1];
    picked.push({
      item: product.name,
      qty,
      unit: product.unitPrice || 0,
      source: "catalogue"
    });
  }

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

  const errorNote = errors.length
    ? `\n⚠️ Skipped: ${errors.join(", ")}`
    : "";

  // Find items with no price (unit = 0)
  const unpricedIndexes = biz.sessionData.items
    .map((item, idx) => (Number(item.unit) === 0 ? idx : null))
    .filter(idx => idx !== null);

  if (unpricedIndexes.length > 0) {
    biz.sessionData.unpricedIndexes = unpricedIndexes;
    biz.sessionState = "creating_invoice_enter_catalogue_prices";
    await saveBizSafe(biz);

    // Build numbered list of ONLY unpriced items clearly showing name + qty
    const unpricedLines = unpricedIndexes
      .map((itemIdx, i) => {
        const it = biz.sessionData.items[itemIdx];
        return `${i + 1}. *${it.item}* × ${it.qty}`;
      })
      .join("\n");

    // Example: "1.50, 3, 12.50"
    const examplePrices = unpricedIndexes
      .map((_, i) => ((i + 1) * 3 + 1.5).toFixed(2))
      .join(", ");

    return sendButtons(from, {
      text:
`✅ *${picked.length} item${picked.length === 1 ? "" : "s"} added*${errorNote}

💰 *${unpricedIndexes.length} item${unpricedIndexes.length === 1 ? " needs" : "s need"} a unit price:*

${unpricedLines}

─────────────────
Enter *all prices in order*, separated by commas:

_Example:_ *${examplePrices}*

That means:
${unpricedIndexes.map((itemIdx, i) => {
  const it = biz.sessionData.items[itemIdx];
  const exPrice = ((i + 1) * 3 + 1.5).toFixed(2);
  return `  ${i + 1}. ${it.item} → $${exPrice} each × ${it.qty} = $${(Number(exPrice) * it.qty).toFixed(2)}`;
}).join("\n")}

_Or enter one price to apply to ALL ${unpricedIndexes.length} items._`,
      buttons: [{ id: "inv_cancel", title: "❌ Cancel" }]
    });
  }

  // All priced — go straight to preview
  biz.sessionState = "creating_invoice_confirm";
  await saveBizSafe(biz);
  return sendInvoicePreview(from, biz, errorNote);
}

// ── Enter prices for zero-price catalogue items ───────────────────────────
if (state === "creating_invoice_enter_catalogue_prices") {
  const unpricedIndexes = biz.sessionData.unpricedIndexes || [];

  if (!unpricedIndexes.length) {
    biz.sessionState = "creating_invoice_confirm";
    await saveBizSafe(biz);
    return sendInvoicePreview(from, biz, "");
  }

  // Parse input — accept: "5.50, 3, 12.50" OR single value "5.50" for all
  const parts = trimmed.split(",").map(s => s.trim()).filter(Boolean);
  const allValid = parts.every(p => !isNaN(Number(p)) && Number(p) >= 0);

  if (!allValid || parts.length === 0) {
    const unpricedLines = unpricedIndexes
      .map((itemIdx, i) => {
        const it = biz.sessionData.items[itemIdx];
        return `${i + 1}. *${it.item}* × ${it.qty}`;
      })
      .join("\n");
    await sendText(from,
`❌ Invalid prices. Enter numbers only, separated by commas.

Items needing prices:
${unpricedLines}

Example: *5.50, 3.00, 12.50*
Or one price for all: *5.50*`
    );
    return true;
  }

  // Apply prices: either one price for all, or one per item in order
  if (parts.length === 1) {
    // Single price → apply to ALL unpriced items
    const price = Number(parts[0]);
    for (const itemIdx of unpricedIndexes) {
      biz.sessionData.items[itemIdx].unit = price;
    }
  } else if (parts.length === unpricedIndexes.length) {
    // One price per item in order
    unpricedIndexes.forEach((itemIdx, i) => {
      biz.sessionData.items[itemIdx].unit = Number(parts[i]);
    });
  } else {
    // Wrong count — show clear error
    const unpricedLines = unpricedIndexes
      .map((itemIdx, i) => {
        const it = biz.sessionData.items[itemIdx];
        return `${i + 1}. *${it.item}* × ${it.qty}`;
      })
      .join("\n");
    await sendText(from,
`❌ You sent *${parts.length} price${parts.length === 1 ? "" : "s"}* but there ${unpricedIndexes.length === 1 ? "is" : "are"} *${unpricedIndexes.length} item${unpricedIndexes.length === 1 ? "" : "s"}* needing prices.

Send *${unpricedIndexes.length} prices* in order:
${unpricedLines}

Example: *${unpricedIndexes.map((_, i) => ((i + 1) * 3 + 1.5).toFixed(2)).join(", ")}*

Or send *one price* to apply it to all ${unpricedIndexes.length} items.`
    );
    return true;
  }

  // All prices saved — clear state and go to preview
  biz.sessionData.unpricedIndexes = [];
  biz.sessionState = "creating_invoice_confirm";
  await saveBizSafe(biz);
  return sendInvoicePreview(from, biz, "");
}

// ── Enter prices for zero-price catalogue items ───────────────────────────
if (state === "creating_invoice_enter_catalogue_prices") {
  const price = Number(trimmed);
  if (isNaN(price) || price < 0) {
    await sendText(from, "❌ Invalid price. Enter a number like *5.50*:");
    return true;
  }

  const unpricedIndexes = biz.sessionData.unpricedIndexes || [];
  const cursor = biz.sessionData.unpricedCursor || 0;
  const targetIdx = unpricedIndexes[cursor];

  if (targetIdx === undefined) {
    // Shouldn't happen but guard it
    biz.sessionState = "creating_invoice_confirm";
    await saveBizSafe(biz);
    return _sendInvoicePreview(from, biz, "");
  }

  // Save the price
  biz.sessionData.items[targetIdx].unit = price;
  const nextCursor = cursor + 1;

  if (nextCursor < unpricedIndexes.length) {
    // More prices needed
    biz.sessionData.unpricedCursor = nextCursor;
    await saveBizSafe(biz);

    const nextIdx = unpricedIndexes[nextCursor];
    const nextItem = biz.sessionData.items[nextIdx];
    const remaining = unpricedIndexes.length - nextCursor;

    return sendButtons(from, {
      text:
`✅ Saved $${price.toFixed(2)}

💰 *Next — ${remaining} item${remaining === 1 ? "" : "s"} left:*

${nextIdx + 1}. *${nextItem.item}* × ${nextItem.qty}

Enter unit price:`,
      buttons: [{ id: "inv_cancel", title: "❌ Cancel" }]
    });
  }

  // All prices entered — go to preview
  biz.sessionData.unpricedIndexes = [];
  biz.sessionData.unpricedCursor = 0;
  biz.sessionState = "creating_invoice_confirm";
  await saveBizSafe(biz);

  return _sendInvoicePreview(from, biz, "");
}



  if (state === "creating_invoice_add_items") {

    if (biz.sessionData.itemMode === null && !biz.sessionData.lastItem && !biz.sessionData.expectingQty) {
      biz.sessionData.itemMode = "choose";
      await saveBizSafe(biz);
      await sendButtons(from, {
        text: "How would you like to add an item?",
        buttons: [{ id: "inv_item_catalogue", title: "📦 Catalogue" }, { id: "inv_item_custom", title: "✍️ Custom item" }]
      });
      return true;
    }

    if (!biz.sessionData.expectingQty) {
      if (!isNaN(Number(trimmed))) { await sendText(from, "Please send an item description (not a number)."); return true; }
      biz.sessionData.lastItem = { description: trimmed, source: "custom" };
      biz.sessionData.expectingQty = true;
      await saveBizSafe(biz);
      await sendPromptWithMenu(from, `📦 *${trimmed}*\n\n🔢 Enter quantity (e.g. 1):`);
      return true;
    }

    const qty = Number(trimmed);
    if (isNaN(qty) || qty <= 0) { await sendPromptWithMenu(from, "❌ Invalid quantity. Enter a number like 1:"); return true; }

    biz.sessionData.items.push({
      item: biz.sessionData.lastItem.description, qty,
      unit: biz.sessionData.lastItem.unit ?? null, source: biz.sessionData.lastItem.source
    });

    biz.sessionData.lastItemSource = biz.sessionData.lastItem.source;
    biz.sessionData.lastItem = null;
    biz.sessionData.expectingQty = false;

    const lastItem = biz.sessionData.items[biz.sessionData.items.length - 1];

    if (biz.sessionData.lastItemSource === "custom") {
      biz.sessionState = "creating_invoice_enter_prices";
      biz.sessionData.priceIndex = biz.sessionData.items.length - 1;
      await saveBizSafe(biz);
      return sendPromptWithMenu(from, `💰 *Enter unit price for:*\n${lastItem.item}`);
    }

    biz.sessionState = "creating_invoice_confirm";
    await saveBizSafe(biz);

    const summary = biz.sessionData.items.map((i, idx) => `${idx + 1}) ${i.item} x${i.qty} @ ${i.unit}`).join("\n");
    return sendInvoiceConfirmMenu(from, `🧾 File Summary\n\n${summary}`);
  }

  /* ===========================
     PRICE ENTRY
  ============================ */
  if (state === "creating_invoice_enter_prices") {
    const price = Number(trimmed);
    if (isNaN(price) || price < 0) { await sendPromptWithMenu(from, "❌ Invalid price. Enter a number (e.g. 500):"); return true; }

    biz.sessionData.priceIndex = biz.sessionData.priceIndex || 0;
    biz.sessionData.items[biz.sessionData.priceIndex].unit = price;
    biz.sessionData.priceIndex++;

    if (biz.sessionData.priceIndex < biz.sessionData.items.length) {
      await saveBizSafe(biz);
      return sendPromptWithMenu(from, `💰 *Enter price for:*\n${biz.sessionData.items[biz.sessionData.priceIndex].item}`);
    }

    biz.sessionState = "creating_invoice_confirm";
    biz.sessionData.priceIndex = 0;
    await saveBizSafe(biz);

    const summary = biz.sessionData.items.map((i, idx) => `${idx + 1}) ${i.item} x${i.qty} @ ${i.unit}`).join("\n");
    const docType = biz.sessionData.docType || "invoice";
    const label = docType === "invoice" ? "Invoice" : docType === "quote" ? "Quotation" : "Receipt";
    return sendInvoiceConfirmMenu(from, `🧾 ${label} Summary\n\n${summary}`);
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
    const summary = biz.sessionData.items.map((i, idx) => `${idx + 1}) ${i.item} x${i.qty} @ ${i.unit}`).join("\n");
    const docTypeD = biz.sessionData.docType || "invoice";
    const labelD = docTypeD === "invoice" ? "Invoice" : docTypeD === "quote" ? "Quotation" : "Receipt";
    return sendInvoiceConfirmMenu(from, `🧾 ${labelD} Summary\n\n${summary}\n\n💸 Discount: ${pct}%`);
  }

  /* ===========================
     SET VAT %
  ============================ */
  if (state === "creating_invoice_set_vat") {
    const pct = Number(trimmed);
    if (isNaN(pct) || pct < 0 || pct > 100) { await sendPromptWithMenu(from, "❌ Invalid VAT. Enter a percent (0-100):"); return true; }
    biz.sessionData.vatPercent = pct;
    biz.sessionData.applyVat = pct > 0;
    biz.sessionState = "creating_invoice_confirm";
    await saveBizSafe(biz);
    const summary = biz.sessionData.items.map((i, idx) => `${idx + 1}) ${i.item} x${i.qty} @ ${i.unit}`).join("\n");
    const docTypeV = biz.sessionData.docType || "invoice";
    const labelV = docTypeV === "invoice" ? "Invoice" : docTypeV === "quote" ? "Quotation" : "Receipt";
    return sendInvoiceConfirmMenu(from, `🧾 ${labelV} Summary\n\n${summary}\n\n🧾 VAT: ${pct}%`);
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
}