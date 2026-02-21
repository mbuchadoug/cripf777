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

//import { sendSettingsMenu } from "./metaMenus.js";


async function saveBizSafe(biz) {
  if (!biz) return;
  biz.markModified("sessionData");
  return biz.save();
}

/**
 * Continue Twilio-style state machine for Meta text input
 */
export async function continueTwilioFlow({ from, text }) {
  const phone = from.replace(/\D+/g, "");
  const session = await UserSession.findOne({ phone });

  // ✅ HARD GUARD: prevent shared-session corruption
if (!phone || phone.length < 9 || phone.length > 15) {
  console.error("❌ Invalid phone for session key:", { from, phone, text });
  return true; // stop flow
}

  if (!session?.activeBusinessId) return false;

  const biz = await Business.findById(session.activeBusinessId);
  if (!biz || !biz.sessionState) return false;



  // ============================
  // 🔒 ROLE GUARD (TWILIO)
  // ============================
const UserRole = (await import("../models/userRole.js")).default;
const { canAccessSection } = await import("./roleGuard.js");

const caller = await UserRole.findOne({
  businessId: biz._id,
  phone,
  pending: false
});

// ✅ SAFETY DEFAULT (FIX 3)
if (caller && !caller.role) {
  caller.role = "clerk";
}


  // Safety: unknown users are blocked
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

  invite_user_phone: "users"
};



  const section = restrictedStateMap[biz.sessionState];

  if (section && !canAccessSection(caller.role, section)) {
    await sendText(
      from,
      "🔒 You do not have permission to perform this action."
    );

    biz.sessionState = "ready";
    biz.sessionData = {};
    await saveBizSafe(biz);

    await sendMainMenu(from);
    return true;
  }



  const trimmed = text.trim();
  const state = biz.sessionState;




  // 🛑 If user is idle, do NOT hijack messages
if (state === "ready") {
  return false;
}

  /* ===========================
     🔑 CLIENT STATEMENT
  ============================ */
/* ===========================
   CLIENT STATEMENT → GENERATE
=========================== */
if (state === "client_statement_generate") {
  const clientId = biz.sessionData.clientId;

  if (!clientId) {
    biz.sessionState = "ready";
    biz.sessionData = {};
    await saveBizSafe(biz);
    await sendMainMenu(from);
    return true;
  }

  const Client = (await import("../models/client.js")).default;
  const client = await Client.findById(clientId).lean();

  if (!client) {
    await sendText(from, "❌ Client not found.");
    await sendMainMenu(from);
    return true;
  }

  const { buildClientStatement } =
    await import("./clientStatement.js");

  const ledger = await buildClientStatement({
    businessId: biz._id,
    clientId
  });

const { filename } = await generatePDF({
  type: "statement",
  billingTo: client.name || client.phone,
  ledger,
  bizMeta: {
    name: biz.name,
    logoUrl: biz.logoUrl,
    address: biz.address || "",   // ✅ ADD THIS LINE
    _id: biz._id.toString()
  }
});



  const site = (process.env.SITE_URL || "").replace(/\/$/, "");
  const url = `${site}/docs/generated/statements/${filename}`;

  await sendDocument(from, { link: url, filename });

  biz.sessionState = "ready";
  biz.sessionData = {};
  await saveBizSafe(biz);

  await sendMainMenu(from);
  return true;
}

/* ===========================
   ⚙️ SETTINGS: TEXT INPUT HANDLERS
=========================== */





if (state === "settings_currency") {
  const cur = trimmed.toUpperCase();

  if (!["ZWL", "USD", "ZAR"].includes(cur)) {
    await sendText(from, "❌ Invalid currency. Use USD, ZWL or ZAR:");
    return true;
  }

  biz.currency = cur;
  biz.sessionState = "settings_menu";
  biz.sessionData = {};
  await saveBizSafe(biz);

  await sendText(from, `✅ Currency updated to *${cur}*`);
  await sendSettingsMenu(from);

  return true;
}

if (state === "settings_terms") {
  const days = Number(trimmed);

  if (isNaN(days) || days < 0) {
    await sendText(from, "❌ Enter a valid number of days (e.g. 30):");
    return true;
  }

  biz.paymentTermsDays = days;
  biz.sessionState = "settings_menu";
  biz.sessionData = {};
  await saveBizSafe(biz);

  await sendText(from, `✅ Payment terms set to *${days} days*`);
  await sendSettingsMenu(from);

  return true;
}











// INVOICE PREFIX
if (state === "settings_inv_prefix") {
  if (!trimmed) {
    await sendText(from, "❌ Prefix cannot be empty. Enter a valid invoice prefix:");
    return true;
  }

  biz.invoicePrefix = trimmed.toUpperCase();
  biz.sessionState = "settings_menu";
  biz.sessionData = {};
  await saveBizSafe(biz);

  await sendText(from, `✅ Invoice prefix updated to *${biz.invoicePrefix}*`);
  await sendSettingsMenu(from); // 🔁 BACK TO SETTINGS (META)

  return true;
}

// QUOTE PREFIX
if (state === "settings_qt_prefix") {
  if (!trimmed) {
    await sendText(from, "❌ Prefix cannot be empty. Enter a valid quote prefix:");
    return true;
  }

  biz.quotePrefix = trimmed.toUpperCase();
  biz.sessionState = "settings_menu";
  biz.sessionData = {};
  await saveBizSafe(biz);

  await sendText(from, `✅ Quote prefix updated to *${biz.quotePrefix}*`);
  await sendSettingsMenu(from);

  return true;
}

// RECEIPT PREFIX
if (state === "settings_rcpt_prefix") {
  if (!trimmed) {
    await sendText(from, "❌ Prefix cannot be empty. Enter a valid receipt prefix:");
    return true;
  }

  biz.receiptPrefix = trimmed.toUpperCase();
  biz.sessionState = "settings_menu";
  biz.sessionData = {};
  await saveBizSafe(biz);

  await sendText(from, `✅ Receipt prefix updated to *${biz.receiptPrefix}*`);
  await sendSettingsMenu(from);

  return true;
}



  if (!biz.sessionData.client && biz.sessionData.clientId) {
    const client = await Client.findById(biz.sessionData.clientId);
    if (client) {
      biz.sessionData.client = client;
      await saveBizSafe(biz);
    }
  }



async function runDailyReportMeta({ biz, from }) {
  const UserRole = (await import("../models/userRole.js")).default;
  const InvoicePayment = (await import("../models/invoicePayment.js")).default;

  const caller = await UserRole.findOne({
    businessId: biz._id,
    phone: from.replace(/\D+/g, ""),
    pending: false
  });

  const start = new Date();
  start.setHours(0, 0, 0, 0);

  const end = new Date();
  end.setHours(23, 59, 59, 999);

  // ✅ Manager: restricted to branch
  if (caller?.role === "manager" && caller.branchId) {
    const branchFilter = { branchId: caller.branchId };

  const invoices = await Invoice.find({
      businessId: biz._id,
      type: "invoice",  // ✅ ONLY ACTUAL INVOICES
      ...branchFilter,
      createdAt: { $gte: start, $lte: end }
    }).lean();

    const payments = await InvoicePayment.find({
      businessId: biz._id,
      ...branchFilter,
      createdAt: { $gte: start, $lte: end }
    }).lean();

    const expenses = await Expense.find({
      businessId: biz._id,
      ...branchFilter,
      createdAt: { $gte: start, $lte: end }
    }).lean();

    const invoiced = invoices.reduce((s, i) => s + (i.total || 0), 0);
    const cashReceived = payments.reduce((s, p) => s + (p.amount || 0), 0);
    const spent = expenses.reduce((s, e) => s + (e.amount || 0), 0);
    const outstanding = invoices.reduce((s, i) => s + (i.balance || 0), 0);
    const profit = cashReceived - spent;

    // 📋 Expense breakdown
   // 📋 Expense breakdown with descriptions
    const expensesByCategory = {};
    expenses.forEach(e => {
      const cat = e.category || "Other";
      if (!expensesByCategory[cat]) {
        expensesByCategory[cat] = [];
      }
      expensesByCategory[cat].push({
        desc: e.description || cat,
        amount: e.amount
      });
    });

    let expenseDetails = "";
    Object.keys(expensesByCategory).forEach(cat => {
      const items = expensesByCategory[cat];
      const total = items.reduce((s, i) => s + i.amount, 0);
      
      expenseDetails += `  ${cat} (${total} ${biz.currency}):\n`;
      
      // Group by description
      const grouped = {};
      items.forEach(item => {
        if (!grouped[item.desc]) {
          grouped[item.desc] = { count: 0, total: 0 };
        }
        grouped[item.desc].count++;
        grouped[item.desc].total += item.amount;
      });
      
      Object.keys(grouped).forEach(desc => {
        const g = grouped[desc];
        if (g.count > 1) {
          expenseDetails += `    • ${desc} (×${g.count}): ${g.total} ${biz.currency}\n`;
        } else {
          expenseDetails += `    • ${desc}: ${g.total} ${biz.currency}\n`;
        }
      });
    });

    biz.sessionState = "ready";
    biz.sessionData = {};
    await saveBizSafe(biz);

    await sendText(
      from,
`📊 Daily Report (${start.toISOString().slice(0,10)})

💰 CASH FLOW
Invoiced: ${invoiced} ${biz.currency}
Cash received: ${cashReceived} ${biz.currency}
Outstanding: ${outstanding} ${biz.currency}

💸 EXPENSES (${spent} ${biz.currency})
${expenseDetails || "  None\n"}

📈 PROFIT: ${profit >= 0 ? "+" : ""}${profit} ${biz.currency}

---
${invoices.length} invoices | ${payments.length} payments | ${expenses.length} expenses`
    );

    await sendMainMenu(from);
    return true;
  }

  // ✅ OWNER/ADMIN: grouped by branch
  const Branch = (await import("../models/branch.js")).default;
  const branches = await Branch.find({ businessId: biz._id }).lean();

  const branchMap = new Map(branches.map(b => [String(b._id), b.name]));

  // Aggregate invoices
 // Aggregate invoices (EXCLUDE receipts)
  const invAgg = await Invoice.aggregate([
    {
      $match: {
        businessId: biz._id,
        type: "invoice",  // ✅ ONLY ACTUAL INVOICES
        createdAt: { $gte: start, $lte: end }
      }
    },
    {
      $group: {
        _id: { $ifNull: ["$branchId", "UNASSIGNED"] },
        count: { $sum: 1 },
        invoiced: { $sum: { $ifNull: ["$total", 0] } },
        outstanding: { $sum: { $ifNull: ["$balance", 0] } }
      }
    }
  ]);

  // Aggregate payments (CASH RECEIVED)
  const payAgg = await InvoicePayment.aggregate([
    {
      $match: {
        businessId: biz._id,
        createdAt: { $gte: start, $lte: end }
      }
    },
    {
      $group: {
        _id: { $ifNull: ["$branchId", "UNASSIGNED"] },
        cashReceived: { $sum: { $ifNull: ["$amount", 0] } }
      }
    }
  ]);

  // Aggregate expenses
  const expAgg = await Expense.aggregate([
    {
      $match: {
        businessId: biz._id,
        createdAt: { $gte: start, $lte: end }
      }
    },
    {
      $group: {
        _id: { $ifNull: ["$branchId", "UNASSIGNED"] },
        spent: { $sum: { $ifNull: ["$amount", 0] } }
      }
    }
  ]);

  // Merge results
  const rows = new Map();

  function ensureRow(branchKey) {
    const k = String(branchKey);
    if (!rows.has(k)) {
      const name =
        k === "UNASSIGNED"
          ? "Unassigned/Main"
          : (branchMap.get(k) || "Unknown");
      rows.set(k, { name, invoices: 0, invoiced: 0, cashReceived: 0, spent: 0, outstanding: 0 });
    }
    return rows.get(k);
  }

  for (const r of invAgg) {
    const row = ensureRow(r._id);
    row.invoices = r.count || 0;
    row.invoiced = r.invoiced || 0;
    row.outstanding = r.outstanding || 0;
  }

  for (const r of payAgg) {
    const row = ensureRow(r._id);
    row.cashReceived = r.cashReceived || 0;
  }

  for (const r of expAgg) {
    const row = ensureRow(r._id);
    row.spent = r.spent || 0;
  }

  // Build message
  let msg = `📊 Daily Report (${start.toISOString().slice(0,10)})\n\n`;

  let tInvoiced = 0, tCash = 0, tSpent = 0, tOut = 0;

  for (const row of rows.values()) {
    tInvoiced += row.invoiced;
    tCash += row.cashReceived;
    tSpent += row.spent;
    tOut += row.outstanding;

    const profit = row.cashReceived - row.spent;


    msg += `🏬 ${row.name}\n` +
           `Invoices: ${row.invoices}\n` +
           `Invoiced: ${row.invoiced} ${biz.currency}\n` +
           `Cash in: ${row.cashReceived} ${biz.currency}\n` +
           `Cash out: ${row.spent} ${biz.currency}\n` +
           `💰 Profit: ${profit >= 0 ? "+" : ""}${profit} ${biz.currency}\n` +
           `Unpaid: ${row.outstanding} ${biz.currency}\n\n`;
  }

  const totalProfit = tCash - tSpent;

 msg += `📌 TOTAL\n` +
         `Invoiced: ${tInvoiced} ${biz.currency}\n` +
         `Cash in: ${tCash} ${biz.currency}\n` +
         `Cash out: ${tSpent} ${biz.currency}\n` +
         `💰 PROFIT: ${totalProfit >= 0 ? "+" : ""}${totalProfit} ${biz.currency}\n` +
         `Unpaid: ${tOut} ${biz.currency}`;

  // 📋 Add expense breakdown (all branches combined)
  if (tSpent > 0) {
    const allExpenses = await Expense.find({
      businessId: biz._id,
      createdAt: { $gte: start, $lte: end }
    }).lean();

    const expensesByCategory = {};
    allExpenses.forEach(e => {
      const cat = e.category || "Other";
      if (!expensesByCategory[cat]) {
        expensesByCategory[cat] = [];
      }
      expensesByCategory[cat].push({
        desc: e.description || cat,
        amount: e.amount
      });
    });

    msg += `\n\n💸 EXPENSE BREAKDOWN\n`;
    Object.keys(expensesByCategory).forEach(cat => {
      const items = expensesByCategory[cat];
      const total = items.reduce((s, i) => s + i.amount, 0);
      
      msg += `${cat} (${total} ${biz.currency}):\n`;
      
      // Group by description
      const grouped = {};
      items.forEach(item => {
        if (!grouped[item.desc]) {
          grouped[item.desc] = { count: 0, total: 0 };
        }
        grouped[item.desc].count++;
        grouped[item.desc].total += item.amount;
      });
      
      Object.keys(grouped).forEach(desc => {
        const g = grouped[desc];
        if (g.count > 1) {
          msg += `  • ${desc} (×${g.count}): ${g.total} ${biz.currency}\n`;
        } else {
          msg += `  • ${desc}: ${g.total} ${biz.currency}\n`;
        }
      });
    });
  }

  biz.sessionState = "ready";
  biz.sessionData = {};
  await saveBizSafe(biz);

  await sendText(from, msg);
  await sendMainMenu(from);
  return true;
}



async function runWeeklyReportMeta({ biz, from }) {
  const UserRole = (await import("../models/userRole.js")).default;
  const InvoicePayment = (await import("../models/invoicePayment.js")).default;

  const caller = await UserRole.findOne({
    businessId: biz._id,
    phone: from.replace(/\D+/g, ""),
    pending: false
  });

  const end = new Date();
  end.setHours(23, 59, 59, 999);

  const start = new Date(end);
  start.setDate(start.getDate() - 6);
  start.setHours(0, 0, 0, 0);

  const query = {
    businessId: biz._id,
    createdAt: { $gte: start, $lte: end }
  };

  if (caller?.role === "manager" && caller.branchId) {
    query.branchId = caller.branchId;
  }

 const invoices = await Invoice.find({
    ...query,
    type: "invoice"  // ✅ ONLY INVOICES
  }).lean();
  const payments = await InvoicePayment.find(query).lean();
  const expenses = await Expense.find(query).lean();

  const invoiced = invoices.reduce((s, i) => s + (i.total || 0), 0);
  const cashReceived = payments.reduce((s, p) => s + (p.amount || 0), 0);
  const spent = expenses.reduce((s, e) => s + (e.amount || 0), 0);
  const outstanding = invoices.reduce((s, i) => s + (i.balance || 0), 0);
  const profit = cashReceived - spent;

  // Expense breakdown
  const cat = e.category || "Other";

  biz.sessionState = "ready";
  biz.sessionData = {};
  await saveBizSafe(biz);

  await sendText(
    from,
`📊 Weekly Report (${start.toISOString().slice(0,10)} → ${end.toISOString().slice(0,10)})

💰 CASH FLOW
Invoiced: ${invoiced} ${biz.currency}
Cash received: ${cashReceived} ${biz.currency}
Outstanding: ${outstanding} ${biz.currency}

💸 EXPENSES (${spent} ${biz.currency})
${expenseDetails || "  None\n"}

📈 PROFIT: ${profit >= 0 ? "+" : ""}${profit} ${biz.currency}

---
${invoices.length} invoices | ${payments.length} payments | ${expenses.length} expenses`
  );

  await sendMainMenu(from);
  return true;
}




async function runMonthlyReportMeta({ biz, from }) {
  const UserRole = (await import("../models/userRole.js")).default;
  const InvoicePayment = (await import("../models/invoicePayment.js")).default;

  const caller = await UserRole.findOne({
    businessId: biz._id,
    phone: from.replace(/\D+/g, ""),
    pending: false
  });

  const start = new Date();
  start.setDate(1);
  start.setHours(0, 0, 0, 0);

  const end = new Date();
  end.setHours(23, 59, 59, 999);

  const query = {
    businessId: biz._id,
    createdAt: { $gte: start, $lte: end }
  };

  if (caller?.role === "manager" && caller.branchId) {
    query.branchId = caller.branchId;
  }
const invoices = await Invoice.find({
    ...query,
    type: "invoice"  // ✅ ONLY INVOICES
  }).lean();
  const payments = await InvoicePayment.find(query).lean();
  const expenses = await Expense.find(query).lean();

  const invoiced = invoices.reduce((s, i) => s + (i.total || 0), 0);
  const cashReceived = payments.reduce((s, p) => s + (p.amount || 0), 0);
  const spent = expenses.reduce((s, e) => s + (e.amount || 0), 0);
  const outstanding = invoices.reduce((s, i) => s + (i.balance || 0), 0);
  const profit = cashReceived - spent;

  // Expense breakdown
const cat = e.category || "Other";

  // Top 5 invoices
  const topInvoices = invoices
    .sort((a, b) => b.total - a.total)
    .slice(0, 5);

  let topInvoicesList = "";
  topInvoices.forEach(inv => {
    topInvoicesList += `  ${inv.number}: ${inv.total} ${biz.currency}\n`;
  });

  biz.sessionState = "ready";
  biz.sessionData = {};
  await saveBizSafe(biz);

  await sendText(
    from,
`📊 Monthly Report (${start.toISOString().slice(0,7)})

💰 CASH FLOW
Invoiced: ${invoiced} ${biz.currency}
Cash received: ${cashReceived} ${biz.currency}
Outstanding: ${outstanding} ${biz.currency}

💸 EXPENSES (${spent} ${biz.currency})
${expenseDetails || "  None\n"}

📈 PROFIT: ${profit >= 0 ? "+" : ""}${profit} ${biz.currency}

🔝 TOP INVOICES
${topInvoicesList || "  None\n"}

---
${invoices.length} invoices | ${payments.length} payments | ${expenses.length} expenses`
  );

  await sendMainMenu(from);
  return true;
}



if (state === "report_daily") {
  return runDailyReportMeta({ biz, from });
}

if (state === "report_weekly") {
  return runWeeklyReportMeta({ biz, from });
}

if (state === "report_monthly") {
  return runMonthlyReportMeta({ biz, from });
}


/* ===========================
   INVITE USER: ENTER PHONE
=========================== */
if (state === "invite_user_phone") {
  const raw = trimmed.replace(/\D+/g, "");

  let phone = raw;
  if (phone.startsWith("0")) {
    phone = "263" + phone.slice(1);
  }

  if (!phone.startsWith("263") || phone.length !== 12) {
    await sendText(
      from,
      "❌ Invalid WhatsApp number. Use 0772123456 or +263772123456"
    );
    return true;
  }

  const UserRole = (await import("../models/userRole.js")).default;
  const Branch = (await import("../models/branch.js")).default;

  const branchId = biz.sessionData.branchId;
  const branch = await Branch.findById(branchId);

  if (!branch) {
    biz.sessionState = "ready";
    biz.sessionData = {};
    await saveBizSafe(biz);
    await sendText(from, "⚠️ Branch not found.");
    await sendMainMenu(from);
    return true;
  }

  // Prevent duplicates
  const exists = await UserRole.findOne({
    businessId: biz._id,
    phone,
    pending: false
  });

  if (exists) {
    await sendText(from, "⚠️ User already exists in your business.");
    await sendMainMenu(from);
    return true;
  }

  await UserRole.findOneAndUpdate(
    { businessId: biz._id, phone },
    {
      businessId: biz._id,
      phone,
      role: "clerk",
      branchId: branch._id,
      pending: true
    },
    { upsert: true }
  );

  const bot = process.env.TWILIO_WHATSAPP_NUMBER.replace(/\D+/g, "");
  const joinLink = `https://wa.me/${bot}?text=JOIN`;

  const msg =
`👋 You’ve been invited to ${biz.name}

📍 Branch: ${branch.name}
🔑 Role: Clerk

👉 Join here:
${joinLink}

Or reply *JOIN*`;

  await sendText(
  from,
`✅ Invitation created

📍 Branch: ${branch.name}
🔑 Role: Clerk

👉 Share this link with the user:
${joinLink}

They must click it to join.`
);


  biz.sessionState = "ready";
  biz.sessionData = {};
  await saveBizSafe(biz);

  /*await sendText(
    from,
    `✅ Invitation sent to ${phone}\n📍 Branch: ${branch.name}`
  );*/
  await sendMainMenu(from);
  return true;
}



/////////////////////////////////branches
/* ===========================
   BRANCH: ADD BRANCH (META)
=========================== */
if (state === "branch_add_name") {
  const name = trimmed;

  if (!name) {
    await sendText(from, "Branch name cannot be empty.");
    return true;
  }

  const Branch = (await import("../models/branch.js")).default;

  await Branch.create({
    businessId: biz._id,
    name,
    isDefault: false
  });

  biz.sessionState = "ready";
  biz.sessionData = {};
  await saveBizSafe(biz);

  await sendText(from, `✅ Branch "${name}" added.`);
  await sendMainMenu(from);

  return true;
}

/* ===========================
   PAYMENT START (META ENTRY)
=========================== */
if (state === "payment_start") {
  // Tell user what to do next
  await sendText(
    from,
    "💰 Record Payment\n\nReply with the invoice number or type *list* to see unpaid invoices."
  );

  return true;
}



/* ===========================
   EXPENSE: ENTER AMOUNT
=========================== */
if (state === "expense_amount") {
  const amount = Number(trimmed);

  if (isNaN(amount) || amount <= 0) {
    await sendText(from, "❌ Invalid amount. Enter a valid number.");
    return true;
  }
 
  biz.sessionData.amount = amount;
  biz.sessionState = ACTIONS.EXPENSE_METHOD;
  await saveBizSafe(biz);

 await sendList(
  from,
  "💳 Select payment method",
  [
    { id: "exp_method_cash", title: "Cash" },
    { id: "exp_method_bank", title: "Bank" },
    { id: "exp_method_ecocash", title: "EcoCash" },
    { id: "exp_method_other", title: "Other" }
  ]
);


  return true;
}

/* ===========================
   EXPENSE: CATEGORY
=========================== */
if (state === ACTIONS.EXPENSE_CATEGORY || state === "expense_category") {
  const categoryMap = {
    exp_cat_rent: "Rent",
    exp_cat_utilities: "Utilities",
    exp_cat_transport: "Transport",
    exp_cat_supplies: "Supplies",
    exp_cat_other: "Other"
  };

  const category = categoryMap[text];
  if (!category) {
    await sendText(from, "❌ Please select a category from the list.");
    return true;
  }

  // ✅ Save category
  biz.sessionData.category = category;

  // ➡️ NEW STEP: ask for description
  biz.sessionState = "expense_description";
  await saveBizSafe(biz);

  await sendText(
    from,
    "📝 Enter expense description (e.g. Fuel for delivery, Office stationery):"
  );

  return true;
}



/* ===========================
   EXPENSE: DESCRIPTION
=========================== */
if (state === "expense_description") {
  const description = trimmed;

  if (!description || description.length < 2) {
    await sendText(from, "❌ Please enter a valid description:");
    return true;
  }

  biz.sessionData.description = description;

  // ➡️ Next step
  biz.sessionState = "expense_amount";
  await saveBizSafe(biz);

  await sendText(from, "💵 Enter expense amount:");
  return true;
}



/* ===========================
   EXPENSE: METHOD → SAVE + RECEIPT
=========================== */
if (state === ACTIONS.EXPENSE_METHOD) {
  const methodMap = {
    exp_method_cash: "Cash",
    exp_method_bank: "Bank",
    exp_method_ecocash: "EcoCash",
    exp_method_other: "Other"
  };

  const method = methodMap[text];
  if (!method) {
    await sendText(from, "❌ Invalid method selected.");
    return true;
  }

  const Expense = (await import("../models/expense.js")).default;

 const expense = await Expense.create({
  businessId: biz._id,
  amount: biz.sessionData.amount,
    branchId: caller?.branchId || null, // ✅ ADD THIS
  category: biz.sessionData.category,
  description: biz.sessionData.description, // ✅ NEW
  method,
  createdBy: from
});


  const receiptNumber = `EXP-${expense._id.toString().slice(-6)}`;

  const { filename } = await generatePDF({
    type: "receipt",
    number: receiptNumber,
    date: new Date(),
    billingTo: biz.sessionData.category,
   items: [{
  item: biz.sessionData.description || biz.sessionData.category,
  qty: 1,
  unit: biz.sessionData.amount,
  total: biz.sessionData.amount
}]
,
    bizMeta: {
      name: biz.name,
      logoUrl: biz.logoUrl,
      address: biz.address || "",
      _id: biz._id.toString(),
      status: "paid"
    }
  });

  const site = (process.env.SITE_URL || "").replace(/\/$/, "");
  const url = `${site}/docs/generated/receipts/${filename}`;

  await sendDocument(from, { link: url, filename });

  biz.sessionState = "ready";
  biz.sessionData = {};
  await saveBizSafe(biz);

  await sendText(from, "✅ Expense recorded successfully.");
  await sendMainMenu(from);
  return true;
}

/* ===========================
   PAYMENT: ENTER AMOUNT
=========================== */
if (state === "payment_amount") {
  const amount = Number(trimmed);

  if (isNaN(amount) || amount <= 0) {
    await sendText(from, "❌ Invalid amount. Enter a number greater than 0.");
    return true;
  }

  const invoice = await Invoice.findById(biz.sessionData.invoiceId);
  if (!invoice) {
    biz.sessionState = "ready";
    biz.sessionData = {};
    await saveBizSafe(biz);
    await sendText(from, "❌ Invoice not found. Returning to menu.");
    await sendMainMenu(from);
    return true;
  }

  if (amount > invoice.balance) {
    await sendText(
      from,
      `❌ Amount exceeds balance.\nBalance: ${invoice.balance} ${invoice.currency}\nEnter a valid amount:`
    );
    return true;
  }

  biz.sessionData.amount = amount;
  biz.sessionState = "payment_method";
  await saveBizSafe(biz);

  await sendText(
    from,
`Payment method:
1) Cash
2) Bank
3) EcoCash
4) Other`
  );

  return true;
}




/* ===========================
   PAYMENT: METHOD → SAVE + RECEIPT
=========================== */
if (state === "payment_method") {
  const methodMap = {
    "1": "Cash",
    "2": "Bank",
    "3": "EcoCash",
    "4": "Other"
  };

  const method = methodMap[trimmed];
  if (!method) {
    await sendText(from, "❌ Invalid option. Choose 1-4.");
    return true;
  }

  const invoice = await Invoice.findById(biz.sessionData.invoiceId);
  if (!invoice) {
    biz.sessionState = "ready";
    biz.sessionData = {};
    await saveBizSafe(biz);
    await sendText(from, "❌ Invoice not found.");
    await sendMainMenu(from);
    return true;
  }

  const amount = biz.sessionData.amount;

  // 💰 UPDATE INVOICE
  invoice.amountPaid += amount;
  invoice.balance -= amount;

  if (invoice.balance <= 0) {
    invoice.status = "paid";
    invoice.balance = 0;
  } else {
    invoice.status = "partial";
  }

  await invoice.save();

  
  // 🧾 GENERATE RECEIPT
  const receiptNumber = `RCPT-${Date.now()}`;


// store payment row (THIS is what statements should read)
await InvoicePayment.create({
  businessId: biz._id,
  clientId: invoice.clientId,
   branchId: invoice.branchId || null, // ✅ ADD THIS
  invoiceId: invoice._id,
  amount,
  method,
  receiptNumber,
  createdBy: from
});


  const { filename } = await generatePDF({
    type: "receipt",
    number: receiptNumber,
    date: new Date(),
    billingTo: invoice.number,
    items: [{
      item: `Payment (${method})`,
      qty: 1,
      unit: amount,
      total: amount
    }],
    bizMeta: {
      name: biz.name,
      logoUrl: biz.logoUrl,
      address: biz.address || "",
      _id: biz._id.toString(),
      status: invoice.status
    }
  });

  const site = (process.env.SITE_URL || "").replace(/\/$/, "");
  const url = `${site}/docs/generated/receipts/${filename}`;

  await sendDocument(from, { link: url, filename });

  // ✅ CLEAN EXIT
  biz.sessionState = "ready";
  biz.sessionData = {};
  await saveBizSafe(biz);

  await sendText(
    from,
    `✅ Payment recorded\nInvoice: ${invoice.number}\nAmount: ${amount} ${invoice.currency}\nMethod: ${method}`
  );

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

  await sendText(
    from,
    "Enter client phone number (or type *same* to use this WhatsApp number):"
  );
  return true;
}

if (state === "adding_client_phone") {
  const phoneVal = trimmed.toLowerCase() === "same" ? phone : trimmed;

  const client = await Client.findOneAndUpdate(
    { businessId: biz._id, phone: phoneVal },
    { $set: { name: biz.sessionData.clientName, phone: phoneVal } },
    { upsert: true, new: true }
  );

  // reset state
   biz.sessionState = "ready";
  biz.sessionData = {};
  await saveBizSafe(biz);

  await sendText(
    from,
    `✅ Client added: ${client.name || client.phone}`
  );

  // 🔁 SHOW MAIN MENU AFTER SUCCESS
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

    await sendText(
      from,
      "Enter client phone number (or type *same* to use this WhatsApp number):"
    );
    return true;
  }

  if (state === "creating_invoice_new_client_phone") {
    const phoneVal = trimmed.toLowerCase() === "same" ? phone : trimmed;

    const client = await Client.findOneAndUpdate(
      { businessId: biz._id, phone: phoneVal },
      { $set: { name: biz.sessionData.clientName, phone: phoneVal } },
      { upsert: true, new: true }
    );

     biz.sessionData.client = client;
  biz.sessionData.clientId = client._id;

  biz.sessionState = "creating_invoice_add_items";
  biz.sessionData.items = [];

  // 🔥 ensure we start with catalogue/custom choice (no manual prompt)
  biz.sessionData.itemMode = null;
  biz.sessionData.lastItem = null;
  biz.sessionData.expectingQty = false;
  biz.sessionData.lastItemSource = null;

  await saveBizSafe(biz);

  await sendButtons(from, {
    text: "How would you like to add an item?",
    buttons: [
      { id: "inv_item_catalogue", title: "📦 Catalogue" },
      { id: "inv_item_custom", title: "✍️ Custom item" }
    ]
  });


    return true;
  }


/* ===========================
   📦 INVOICE: QUICK ADD PRODUCT (NAME)
=========================== */
if (state === "invoice_quick_add_product_name") {
  const name = trimmed;

  if (!name || name.length < 2) {
    await sendText(from, "❌ Please enter a valid product name:");
    return true;
  }

  biz.sessionData.quickAddProduct = biz.sessionData.quickAddProduct || {};
  biz.sessionData.quickAddProduct.name = name;

  biz.sessionState = "invoice_quick_add_product_price";
  await saveBizSafe(biz);

  await sendText(from, "💰 Enter product price:");
  return true;
}

/* ===========================
   💰 INVOICE: QUICK ADD PRODUCT (PRICE → SAVE DB → ASK QTY)
=========================== */
if (state === "invoice_quick_add_product_price") {
  const price = Number(trimmed);

  if (isNaN(price) || price <= 0) {
    await sendText(from, "❌ Enter a valid price (e.g. 10):");
    return true;
  }

  const name = biz.sessionData?.quickAddProduct?.name;
  if (!name) {
    // safety reset
    biz.sessionState = "creating_invoice_add_items";
    await saveBizSafe(biz);
    await sendText(from, "⚠️ Product name missing. Try again.");
    return true;
  }

  // ✅ SAVE PRODUCT IMMEDIATELY
  const product = await Product.create({
    businessId: biz._id,
    name,
    unitPrice: price,
    isActive: true
  });

  // ✅ Inject as catalogue item into invoice flow
  biz.sessionData.lastItem = {
    description: product.name,
    unit: product.unitPrice,
    source: "catalogue"
  };

  biz.sessionData.expectingQty = true;
  biz.sessionData.itemMode = "catalogue";
  biz.sessionData.quickAddProduct = null;

  // Continue invoice item flow
  biz.sessionState = "creating_invoice_add_items";
  await saveBizSafe(biz);

  await sendText(
    from,
    `✅ Saved: ${product.name} (${product.unitPrice})\n\nEnter quantity (e.g. 1):`
  );
  return true;
}







  /* ===========================
     ITEM ADDING
  ============================ */
if (state === "creating_invoice_add_items") {

  // ✅ SHOW MENU WHEN itemMode IS NULL
  if (
    biz.sessionData.itemMode === null &&
    !biz.sessionData.lastItem &&
    !biz.sessionData.expectingQty
  ) {
    biz.sessionData.itemMode = "choose";
    await saveBizSafe(biz);

    await sendButtons(from, {
      text: "How would you like to add an item?",
      buttons: [
        { id: "inv_item_catalogue", title: "📦 Catalogue" },
        { id: "inv_item_custom", title: "✍️ Custom item" }
      ]
    });

    return true; // ⛔ IMPORTANT
  }

  // 👇 ONLY RUNS AFTER USER CHOOSES CUSTOM ITEM
  if (!biz.sessionData.expectingQty) {
    if (!isNaN(Number(trimmed))) {
      await sendText(from, "Please send an item description (not a number).");
      return true;
    }

    biz.sessionData.lastItem = {
  description: trimmed,
  source: "custom"
};

    biz.sessionData.expectingQty = true;
    await saveBizSafe(biz);

    await sendText(from, "Enter quantity (e.g. 1):");
    return true;
  }

  const qty = Number(trimmed);
  if (isNaN(qty) || qty <= 0) {
    await sendText(from, "Invalid quantity. Enter a number like 1:");
    return true;
  }

  // ✅ SAVE ITEM WITHOUT PRICE FIRST
biz.sessionData.items.push({
  item: biz.sessionData.lastItem.description,
  qty,
  unit: biz.sessionData.lastItem.unit ?? null,
  source: biz.sessionData.lastItem.source
});

// persist source for decision
biz.sessionData.lastItemSource = biz.sessionData.lastItem.source;


  // 🔁 RESET FLAGS
  biz.sessionData.lastItem = null;
  biz.sessionData.expectingQty = false;

  const lastItem =
  biz.sessionData.items[biz.sessionData.items.length - 1];

// 🔥 ONLY ASK PRICE FOR CUSTOM ITEMS
if (biz.sessionData.lastItemSource === "custom") {
  biz.sessionState = "creating_invoice_enter_prices";
  biz.sessionData.priceIndex = biz.sessionData.items.length - 1;

  await saveBizSafe(biz);

  return sendText(
    from,
    `💰 Enter unit price for:\n${lastItem.item}`
  );
}

// ✅ CATALOGUE ITEM → SKIP PRICE
biz.sessionState = "creating_invoice_confirm";
await saveBizSafe(biz);

const summary = biz.sessionData.items
  .map((i, idx) => `${idx + 1}) ${i.item} x${i.qty} @ ${i.unit}`)
  .join("\n");

return sendInvoiceConfirmMenu(
  from,
  `🧾 Invoice Summary\n\n${summary}`
);

}








  
  /* ===========================
     PRICE ENTRY
  ============================ */
  if (state === "creating_invoice_enter_prices") {
    const price = Number(trimmed);
    if (isNaN(price) || price < 0) {
      await sendText(from, "Invalid price. Enter a number (e.g. 500):");
      return true;
    }

    biz.sessionData.priceIndex = biz.sessionData.priceIndex || 0;
    biz.sessionData.items[biz.sessionData.priceIndex].unit = price;
    biz.sessionData.priceIndex++;

    if (biz.sessionData.priceIndex < biz.sessionData.items.length) {
      await saveBizSafe(biz);
      return sendText(
        from,
        `Enter price for:\n${biz.sessionData.items[biz.sessionData.priceIndex].item}`
      );
    }

    biz.sessionState = "creating_invoice_confirm";
    biz.sessionData.priceIndex = 0;
    await saveBizSafe(biz);

    const summary = biz.sessionData.items
      .map((i, idx) => `${idx + 1}) ${i.item} x${i.qty} @ ${i.unit}`)
      .join("\n");


      
 const docType = biz.sessionData.docType || "invoice";
const label =
  docType === "invoice"
    ? "Invoice"
    : docType === "quote"
    ? "Quotation"
    : "Receipt";

return sendInvoiceConfirmMenu(
  from,
  `🧾 ${label} Summary\n\n${summary}`
);

  }

  /* ===========================
     CONFIRMATION → GENERATE PDF
  ============================ */
  const docType = biz.sessionData.docType || "invoice";

if (state === "creating_invoice_confirm" && trimmed === "2") {
  let client = biz.sessionData.client;

  if (!client && biz.sessionData.clientId) {
    client = await Client.findById(biz.sessionData.clientId);
  }

  if (!client) {
    await sendText(from, "❌ Client information is missing.");
    return true;
  }

  const items = biz.sessionData.items || [];
  if (!items.length) {
    await sendText(from, "❌ No items found.");
    return true;
  }

  const docType = biz.sessionData.docType || "invoice";

  const prefix =
    docType === "invoice"
      ? biz.invoicePrefix || "INV"
      : docType === "quote"
      ? biz.quotePrefix || "QT"
      : biz.receiptPrefix || "RCPT";

  // ✅ increment counter
  biz.counters = biz.counters || { invoice: 0, quote: 0, receipt: 0 };
  const counterKey =
    docType === "invoice"
      ? "invoice"
      : docType === "quote"
      ? "quote"
      : "receipt";

  biz.counters[counterKey] =
    (biz.counters[counterKey] || 0) + 1;

  const number = `${prefix}-${String(biz.counters[counterKey]).padStart(6, "0")}`;

  // ==========================
  // 💾 SAVE INVOICE TO DATABASE
  // ==========================
  const subtotal = items.reduce(
    (s, i) => s + i.qty * i.unit,
    0
  );

  const discountPercent = Number(biz.sessionData.discountPercent || 0);
  const discountAmount = subtotal * (discountPercent / 100);

  const vatPercent = Number(biz.sessionData.vatPercent || 0);
  const applyVat =
    docType === "receipt"
      ? false
      : biz.sessionData.applyVat !== false;

  const vatAmount = applyVat
    ? (subtotal - discountAmount) * (vatPercent / 100)
    : 0;

  const total = subtotal - discountAmount + vatAmount;


  // ==========================
// 🔒 TRIAL PACKAGE LIMIT
// ==========================
if (biz.package === "trial") {
  const { PACKAGES } = await import("./packages.js");

  const limit = PACKAGES.trial.monthlyDocs;

  if (biz.documentCountMonth >= limit) {
    biz.sessionState = "ready";
    biz.sessionData = {};
    await saveBizSafe(biz);

    await sendText(
      from,
`🚫 Trial limit reached

You can only create *${limit} invoices* on the Trial package.

Upgrade to continue creating invoices.`
    );

    await sendMainMenu(from);
    return true;
  }
}


  const invoiceDoc = await Invoice.create({
    businessId: biz._id,
    clientId: client._id,
    type: docType, // 🔥 ADD THIS LINE
     branchId: caller?.branchId || null, // ✅ ADD THIS
    number,
    currency: biz.currency,

    items: items.map(i => ({
      item: i.item,
      qty: i.qty,
      unit: i.unit,
      total: i.qty * i.unit
    })),

    subtotal,
    discountPercent,
    discountAmount,
    vatPercent,
    vatAmount,
    total,

    amountPaid: 0,
    balance: total,
    status: "unpaid",

    createdBy: from
  });


  // ✅ INCREMENT USAGE
biz.documentCountMonth += 1;
await saveBizSafe(biz);

  // ==========================
  // 📄 GENERATE PDF
  // ==========================
  const { filename } = await generatePDF({
    type: docType,
    number,
    date: new Date(),
    billingTo: client.name || client.phone,
    items,
    bizMeta: {
      name: biz.name,
      logoUrl: biz.logoUrl,
      address: biz.address || "",
      discountPercent,
      vatPercent,
      applyVat,
      _id: biz._id.toString(),
      status: invoiceDoc.status
    }
  });

  const site = (process.env.SITE_URL || "").replace(/\/$/, "");
  const folder =
    docType === "invoice"
      ? "invoices"
      : docType === "quote"
      ? "quotes"
      : "receipts";

  const url = `${site}/docs/generated/${folder}/${filename}`;

await sendDocument(from, { link: url, filename });

biz.sessionState = "ready";
biz.sessionData = {};
await saveBizSafe(biz);

// ✅ SHOW MAIN MENU AFTER PDF
await sendMainMenu(from);

return true;

}


  /* ===========================
     SET DISCOUNT %
  ============================ */
  if (state === "creating_invoice_set_discount") {
    const pct = Number(trimmed);
    if (isNaN(pct) || pct < 0 || pct > 100) {
      await sendText(from, "❌ Invalid discount. Enter a percent (0-100):");
      return true;
    }

    biz.sessionData.discountPercent = pct;
    biz.sessionState = "creating_invoice_confirm";
    await saveBizSafe(biz);

    const summary = biz.sessionData.items
      .map((i, idx) => `${idx + 1}) ${i.item} x${i.qty} @ ${i.unit}`)
      .join("\n");


    const docType = biz.sessionData.docType || "invoice";
const label =
  docType === "invoice"
    ? "Invoice"
    : docType === "quote"
    ? "Quotation"
    : "Receipt";

return sendInvoiceConfirmMenu(
  from,
  `🧾 ${label} Summary\n\n${summary}\n\n💸 Discount: ${pct}%`
);

  }

  /* ===========================
     SET VAT %
  ============================ */
  if (state === "creating_invoice_set_vat") {
    const pct = Number(trimmed);
    if (isNaN(pct) || pct < 0 || pct > 100) {
      await sendText(from, "❌ Invalid VAT. Enter a percent (0-100):");
      return true;
    }

    biz.sessionData.vatPercent = pct;
    biz.sessionData.applyVat = pct > 0;
    biz.sessionState = "creating_invoice_confirm";
    await saveBizSafe(biz);

    const summary = biz.sessionData.items
      .map((i, idx) => `${idx + 1}) ${i.item} x${i.qty} @ ${i.unit}`)
      .join("\n");

    const docType = biz.sessionData.docType || "invoice";
const label =
  docType === "invoice"
    ? "Invoice"
    : docType === "quote"
    ? "Quotation"
    : "Receipt";

return sendInvoiceConfirmMenu(
  from,
  `🧾 ${label} Summary\n\n${summary}\n\n🧾 VAT: ${pct}%`
);

  }

  return false;
}
