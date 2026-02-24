import { ACTIONS } from "./actions.js";
import { startInvoiceFlow } from "./invoiceFlow.js";
import { startReceiptFlow } from "./receiptFlow.js";
import { continueTwilioFlow } from "./twilioStateBridge.js";
import { showUnpaidInvoices } from "./paymentAdapters.js";
import Invoice from "../models/invoice.js";
import Product from "../models/product.js";
import { startQuoteFlow } from "./quoteFlow.js";
import { sendList } from "./metaSender.js";
import { SUBSCRIPTION_PLANS } from "./subscriptionPlans.js";
import { PACKAGES } from "./packages.js";
import mongoose from "mongoose";
import SubscriptionPayment from "../models/subscriptionPayment.js";
import paynow from "./paynow.js";
import { sendDocument } from "./metaSender.js";
import {
  canUseFeature,
  requiredPackageForFeature,
  promptUpgrade
} from "./accessGuards.js";
import { generatePDF } from "../routes/twilio_biz.js";

import { sendPackagesMenu } from "./metaMenus.js";
import { startClientFlow } from "./clientFlow.js";
import { sendButtons } from "./metaSender.js";
import Business from "../models/business.js";

import Branch from "../models/branch.js";
import UserRole from "../models/userRole.js";
import UserSession from "../models/userSession.js";
import {
  handleChooseSavedClient,
  handleNewClientFromInvoice,
  handleClientPicked,
  handleSkipClient
} from "./invoiceAdapters.js";

import {
  sendMainMenu,
  sendSalesMenu,
  sendClientsMenu,
  sendPaymentsMenu,
  sendBusinessMenu,
  sendSettingsMenu,
  sendReportsMenu,
  sendUsersMenu,
  sendBranchesMenu,
  sendProductsMenu,
  sendSubscriptionMenu
} from "./metaMenus.js";

import { getBizForPhone, saveBizSafe } from "./bizHelpers.js";
import { sendText } from "./metaSender.js";
import { importCsvFromMetaDocument } from "./csvImport.js";
import axios from "axios";


// ─── helpers ──────────────────────────────────────────────────────────────────

function msDays(ms) { return ms / (1000 * 60 * 60 * 24); }
function clamp(n, min, max) { return Math.max(min, Math.min(max, n)); }
function round2(n) { return Math.round(n * 100) / 100; }

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
  return `${sym}${n}`;
}

function normalizeEcocashNumber(input, fallbackWhatsApp) {
  const raw = (input || "").replace(/\D+/g, "");
  const fb = (fallbackWhatsApp || "").replace(/\D+/g, "");
  let phone = (input || "").trim().toLowerCase() === "same" ? fb : raw;

  if (phone.startsWith("263") && phone.length === 12) return "0" + phone.slice(3);
  if (phone.startsWith("0") && phone.length === 10) return phone;
  if (phone.length === 9 && phone.startsWith("7")) return "0" + phone;
  return null;
}

async function startOnboarding(from, phone) {
  const existingOwner = await UserRole.findOne({
    phone,
    role: "owner",
    pending: false
  }).lean();

  if (existingOwner?.businessId) {
    const b = await Business.findById(existingOwner.businessId);
    if (b) {
      await UserSession.findOneAndUpdate(
        { phone },
        { activeBusinessId: b._id },
        { upsert: true }
      );

      if (!b.sessionState) {
        b.sessionState = "awaiting_business_name";
        b.sessionData = {};
        await saveBizSafe(b);
      }

      await sendText(from, "👋 Welcome back! Send your business name:");
      return;
    }
  }

  const newBiz = await Business.create({
    name: "",
    currency: "USD",
    package: "trial",
    subscriptionStatus: "inactive",
    sessionState: "awaiting_business_name",
    sessionData: {},
    ownerPhone: phone
  });

  await UserRole.create({
    phone,
    role: "owner",
    pending: false,
    businessId: newBiz._id
  });

  await UserSession.findOneAndUpdate(
    { phone },
    { activeBusinessId: newBiz._id },
    { upsert: true }
  );

  await sendText(from, "👋 Welcome! Let's set up your business.\n\nSend your business name:");
}

async function showSalesDocs(from, type, ownerBranchId = undefined) {
  const biz = await getBizForPhone(from);
  if (!biz) return sendMainMenu(from);

  const phone = from.replace(/\D+/g, "");
  const caller = await UserRole.findOne({
    businessId: biz._id,
    phone,
    pending: false
  });

  const query = { businessId: biz._id, type };

  if (caller?.role === "owner" && ownerBranchId !== undefined) {
    if (ownerBranchId !== null) {
      query.branchId = ownerBranchId;
    }
  } else if (caller && ["clerk", "manager"].includes(caller.role) && caller.branchId) {
    query.branchId = caller.branchId;
  }

  const docs = await Invoice.find(query)
    .sort({ createdAt: -1 })
    .limit(10)
    .lean();

  if (!docs.length) {
    await sendText(from, `No ${type}s found.`);
    return sendSalesMenu(from);
  }

  let header = `📄 Select ${type}`;

  if (ownerBranchId && caller?.role === "owner") {
    const branch = await Branch.findById(ownerBranchId);
    if (branch) header = `📄 ${type}s - ${branch.name}`;
  } else if (caller?.role === "owner" && ownerBranchId === null) {
    header = `📄 ${type}s - All Branches`;
  }

  return sendList(
    from,
    header,
    docs.map(d => ({
      id: `doc_${d._id}`,
      title: `${d.number} - ${d.total} ${d.currency}`
    }))
  );
}

// ─── Client select list helper (includes "Add New Client" option) ─────────────
async function sendClientSelectList(from, biz) {
  const clients = await (await import("../models/client.js")).default
    .find({ businessId: biz._id })
    .sort({ updatedAt: -1 })
    .limit(9) // leave room for the "Add new" row
    .lean();

  const rows = clients.map(c => ({
    id: `client_${c._id}`,
    title: c.name || c.phone
  }));

  // ✅ Always add "New client" at the bottom
  rows.push({ id: "inv_new_client", title: "➕ Add new client" });

  return sendList(from, "👤 Select client", rows);
}

// ─────────────────────────────────────────────────────────────────────────────

export async function handleIncomingMessage({ from, action }) {

  const phone = from.replace(/\D+/g, "");

  if (!phone || phone.length < 9 || phone.length > 15) {
    console.error("❌ Invalid phone for session key:", { from, phone, action });
    return;
  }

  const text = typeof action === "string" ? action.trim() : "";
  const al = text.toLowerCase();
  const a = typeof action === "string" ? action.trim().toLowerCase() : "";

  const isMetaAction =
    typeof action === "string" &&
    (
      Object.values(ACTIONS).some(v => (v || "").toLowerCase() === a) ||
      a.startsWith("report_branch_") ||
      a.startsWith("branch_")
    );

  // =========================
  // 🔑 JOIN INVITATION (ABSOLUTE PRIORITY)
  // =========================
  if (al === "join") {
    const invite = await UserRole.findOne({ phone, pending: true })
      .populate("businessId branchId");

    if (!invite) {
      await sendText(from, "❌ No pending invitation found for this number.");
      return;
    }

    invite.pending = false;
    await invite.save();

    await UserSession.findOneAndUpdate(
      { phone },
      { activeBusinessId: invite.businessId._id },
      { upsert: true }
    );

    await sendText(
      from,
`✅ Invitation accepted!

🏢 Business: ${invite.businessId.name}
📍 Branch: ${invite.branchId?.name || "Main"}
🔑 Role: ${invite.role}

Reply *menu* to start.`
    );

    await sendMainMenu(from);
    return;
  }

  console.log("META INCOMING:", { from, action });

  const biz = await getBizForPhone(from);

  // =========================
  // 🟢 ONBOARDING GATE
  // =========================
  const ownerRole = await UserRole.findOne({
    phone,
    role: "owner",
    pending: false
  }).lean();

  if (!biz && ownerRole?.businessId) {
    const existingBiz = await Business.findById(ownerRole.businessId);
    if (existingBiz) {
      await UserSession.findOneAndUpdate(
        { phone },
        { activeBusinessId: existingBiz._id },
        { upsert: true }
      );
      await sendText(from, "✅ Welcome back. Opening your menu...");
      await sendMainMenu(from);
      return;
    }
  }

  // =========================
  // 🔑 ROLE CHECK (for subscription/upgrade visibility)
  // =========================
  let callerRole = null;
  if (biz) {
    const callerRecord = await UserRole.findOne({
      businessId: biz._id,
      phone,
      pending: false
    });
    callerRole = callerRecord?.role || null;
  }

  // ─── META BUTTON / LIST ACTIONS ──────────────────────────────────────────

  if (al === "inv_use_client") {
    // Use patched sendClientSelectList instead of raw handleChooseSavedClient
    if (!biz) return sendMainMenu(from);
    return sendClientSelectList(from, biz);
  }

  if (al === "inv_skip_client") {
    await handleSkipClient(from);
    return;
  }

  if (a.startsWith("payinv_")) {
    const invoiceId = a.replace("payinv_", "");
    if (!biz) return sendMainMenu(from);

    const invoice = await Invoice.findById(invoiceId);
    if (!invoice) return sendText(from, "Invoice not found.");

    biz.sessionState = "payment_amount";
    biz.sessionData = { invoiceId: invoice._id };
    await saveBizSafe(biz);

    await sendButtons(from, {
      text:
`💳 *Invoice ${invoice.number}*

Total: *${invoice.total} ${invoice.currency}*
Paid: ${invoice.amountPaid} ${invoice.currency}
Balance: *${invoice.balance} ${invoice.currency}*

Enter amount paid:`,
      buttons: [{ id: ACTIONS.MAIN_MENU, title: "🏠 Main Menu" }]
    });
    return;
  }

  // ── Invoice confirm actions ────────────────────────────────────────────────

  if (a === "inv_generate_pdf") {
    if (!biz) return sendMainMenu(from);
    const summary = biz.sessionData.items
      .map((i, idx) => `${idx + 1}) ${i.item} x${i.qty} @ ${i.unit}`)
      .join("\n");
    await sendText(from, `📄 Generating PDF...\n\n${summary}`);
    await continueTwilioFlow({ from, text: "2" });
    return;
  }

  if (a === "inv_set_discount") {
    if (!biz) return sendMainMenu(from);
    biz.sessionState = "creating_invoice_set_discount";
    await saveBizSafe(biz);
    await sendButtons(from, {
      text: "💸 Enter discount percent (0-100):",
      buttons: [{ id: ACTIONS.MAIN_MENU, title: "🏠 Main Menu" }]
    });
    return;
  }

  if (a === "inv_set_vat") {
    if (!biz) return sendMainMenu(from);
    biz.sessionState = "creating_invoice_set_vat";
    await saveBizSafe(biz);
    await sendButtons(from, {
      text: "🧾 Enter VAT percent (0-100):",
      buttons: [{ id: ACTIONS.MAIN_MENU, title: "🏠 Main Menu" }]
    });
    return;
  }

  if (a === "inv_item_catalogue") {
    if (!biz) return sendMainMenu(from);

    const caller = await UserRole.findOne({ businessId: biz._id, phone, pending: false });
    const query = { businessId: biz._id, isActive: true };

    if (caller && ["clerk", "manager"].includes(caller.role) && caller.branchId) {
      query.branchId = caller.branchId;
    }

    const products = await Product.find(query).limit(20);

    if (!products.length) {
      biz.sessionState = "creating_invoice_add_items";
      biz.sessionData.itemMode = "choose_catalogue_or_custom";
      await saveBizSafe(biz);

      return sendButtons(from, {
        text: "📦 No items in catalogue yet.\n\nWhat would you like to do?",
        buttons: [
          { id: "inv_add_new_product", title: "➕ Add new product" },
          { id: "inv_item_custom", title: "✍️ Custom item" }
        ]
      });
    }

    biz.sessionState = "creating_invoice_pick_product";
    await saveBizSafe(biz);

    const productList = products.map(p => ({
      id: `prod_${p._id}`,
      title: `${p.name} (${formatMoney(p.unitPrice, biz.currency)})`
    }));

    productList.push(
      { id: "inv_add_new_product", title: "➕ Add new product" },
      { id: "inv_item_custom", title: "✍️ Enter custom item" }
    );

    return sendList(from, "📦 Select item", productList);
  }

  if (a === "add_another_expense") {
    if (!biz) return sendMainMenu(from);
    biz.sessionState = ACTIONS.EXPENSE_CATEGORY;
    biz.sessionData = {};
    await saveBizSafe(biz);

    return sendList(from, "📂 Select Expense Category", [
      { id: "exp_cat_rent", title: "🏢 Rent" },
      { id: "exp_cat_utilities", title: "💡 Utilities" },
      { id: "exp_cat_transport", title: "🚗 Transport" },
      { id: "exp_cat_supplies", title: "📦 Supplies" },
      { id: "exp_cat_other", title: "📝 Other" }
    ]);
  }

  if (a === "inv_add_new_product") {
    if (!biz) return sendMainMenu(from);
    biz.sessionState = "invoice_quick_add_product_name";
    biz.sessionData = biz.sessionData || {};
    biz.sessionData.itemMode = "catalogue";
    biz.sessionData.quickAddProduct = {};
    await saveBizSafe(biz);

    return sendButtons(from, {
      text: "📦 *Enter product/service name:*",
      buttons: [{ id: ACTIONS.MAIN_MENU, title: "🏠 Main Menu" }]
    });
  }

  if (a === "add_another_product") {
    if (!biz) return sendMainMenu(from);
    biz.sessionState = "product_add_name";
    biz.sessionData = {};
    await saveBizSafe(biz);

    return sendButtons(from, {
      text: "📦 *Enter product name:*",
      buttons: [{ id: ACTIONS.MAIN_MENU, title: "🏠 Main Menu" }]
    });
  }

  if (a === "inv_item_custom") {
    if (!biz) return sendMainMenu(from);
    biz.sessionData.itemMode = "custom";
    await saveBizSafe(biz);

    return sendButtons(from, {
      text: "✍️ *Send item description:*",
      buttons: [{ id: ACTIONS.MAIN_MENU, title: "🏠 Main Menu" }]
    });
  }

  // Handle phone buttons from client creation
  if (a === "inv_client_phone_same" || a === "inv_client_phone_skip") {
    if (!biz) return sendMainMenu(from);
    await continueTwilioFlow({ from, text: a });
    return;
  }

  if (a === "add_client_phone_same") {
    if (!biz) return sendMainMenu(from);
    await continueTwilioFlow({ from, text: a });
    return;
  }

  if (al === "inv_new_client") {
    await handleNewClientFromInvoice(from);
    return;
  }

  if (a === "inv_view_products") {
    if (!biz) return sendMainMenu(from);
    const products = await Product.find({ businessId: biz._id, isActive: true }).lean();
    if (!products.length) return sendText(from, "📦 No products found.");

    let msg = "📦 *Product catalogue:*\n\n";
    products.forEach((p, i) => {
      msg += `${i + 1}) *${p.name}* — ${formatMoney(p.unitPrice, biz.currency)}\n`;
    });

    return sendText(from, msg);
  }

  // ── Client statement ───────────────────────────────────────────────────────
  if (a === ACTIONS.CLIENT_STATEMENT) {
    if (!biz) return sendMainMenu(from);

    const caller = await UserRole.findOne({ businessId: biz._id, phone, pending: false });
    const Client = (await import("../models/client.js")).default;
    let clients;

    if (caller && ["clerk", "manager"].includes(caller.role) && caller.branchId) {
      const branchInvoices = await Invoice.find({
        businessId: biz._id,
        branchId: caller.branchId
      }).distinct("clientId");

      clients = await Client.find({
        businessId: biz._id,
        _id: { $in: branchInvoices }
      }).lean();
    } else {
      clients = await Client.find({ businessId: biz._id }).lean();
    }

    if (!clients.length) {
      await sendText(from, "No clients found.");
      return sendMainMenu(from);
    }

    biz.sessionState = "client_statement_choose_client";
    biz.sessionData = {};
    await saveBizSafe(biz);

    return sendList(
      from,
      "📄 Select client for statement",
      clients.map(c => ({
        id: `stmt_client_${c._id}`,
        title: c.name || c.phone
      }))
    );
  }

  if (a === ACTIONS.ADD_PRODUCT) {
    if (!biz) return sendMainMenu(from);
    biz.sessionState = "product_add_name";
    biz.sessionData = {};
    await saveBizSafe(biz);

    return sendButtons(from, {
      text: "📦 *Enter product name:*",
      buttons: [{ id: ACTIONS.MAIN_MENU, title: "🏠 Main Menu" }]
    });
  }

  // ⚠️ Invoice client picker ONLY
  if (al.startsWith("client_") && al !== ACTIONS.CLIENT_STATEMENT) {
    await handleClientPicked(from, al.replace("client_", ""));
    return;
  }

  if (a === ACTIONS.INV_ADD_ANOTHER_ITEM) {
    if (!biz) return sendMainMenu(from);
    biz.sessionState = "creating_invoice_add_items";
    biz.sessionData.itemMode = null;
    biz.sessionData.lastItem = null;
    biz.sessionData.expectingQty = false;
    biz.sessionData.lastItemSource = null;
    await saveBizSafe(biz);

    return sendButtons(from, {
      text: "How would you like to add an item?",
      buttons: [
        { id: "inv_item_catalogue", title: "📦 Catalogue" },
        { id: "inv_item_custom", title: "✍️ Custom item" }
      ]
    });
  }

  if (a === ACTIONS.INV_ENTER_PRICES) {
    if (!biz) return sendMainMenu(from);
    biz.sessionState = "creating_invoice_enter_prices";
    biz.sessionData.priceIndex = 0;
    await saveBizSafe(biz);

    const item = biz.sessionData.items[0];
    return sendButtons(from, {
      text: `💰 *Enter price for:*\n${item.item} x${item.qty}`,
      buttons: [{ id: ACTIONS.MAIN_MENU, title: "🏠 Main Menu" }]
    });
  }

  if (al === "inv_cancel") {
    if (!biz) return sendMainMenu(from);
    biz.sessionState = null;
    biz.sessionData = {};
    biz.markModified("sessionData");
    await biz.save();
    return sendMainMenu(from);
  }

  // ── Payments / Expenses ────────────────────────────────────────────────────

  if (a === ACTIONS.RECORD_EXPENSE) {
    if (!biz) return sendMainMenu(from);
    biz.sessionState = ACTIONS.EXPENSE_CATEGORY;
    biz.sessionData = {};
    await saveBizSafe(biz);

    return sendList(from, "📂 Select Expense Category", [
      { id: "exp_cat_rent", title: "🏢 Rent" },
      { id: "exp_cat_utilities", title: "💡 Utilities" },
      { id: "exp_cat_transport", title: "🚗 Transport" },
      { id: "exp_cat_supplies", title: "📦 Supplies" },
      { id: "exp_cat_other", title: "📝 Other" }
    ]);
  }

  // ── Reports ────────────────────────────────────────────────────────────────

  if (a === ACTIONS.DAILY_REPORT) {
    if (!biz) return sendMainMenu(from);
    biz.sessionState = "report_daily";
    biz.sessionData = {};
    await saveBizSafe(biz);
    return continueTwilioFlow({ from, text: "auto" });
  }

  if (a === ACTIONS.WEEKLY_REPORT) {
    if (!biz) return sendMainMenu(from);
    biz.sessionState = "report_weekly";
    biz.sessionData = {};
    await saveBizSafe(biz);
    return continueTwilioFlow({ from, text: "auto" });
  }

  if (a === ACTIONS.MONTHLY_REPORT) {
    if (!biz) return sendMainMenu(from);
    biz.sessionState = "report_monthly";
    biz.sessionData = {};
    await saveBizSafe(biz);
    return continueTwilioFlow({ from, text: "auto" });
  }

  if (a === ACTIONS.BRANCH_REPORT) {
    if (!biz) return sendMainMenu(from);
    biz.sessionState = "report_choose_branch";
    biz.sessionData = {};
    await saveBizSafe(biz);
    return continueTwilioFlow({ from, text: "auto" });
  }

  // ── Product text input states ──────────────────────────────────────────────

  if (biz?.sessionState === "product_add_name") {
    const name = text?.trim();
    if (!name || name.length < 2) {
      await sendButtons(from, {
        text: "❌ Enter a valid product name:",
        buttons: [{ id: ACTIONS.MAIN_MENU, title: "🏠 Main Menu" }]
      });
      return;
    }

    biz.sessionData.productName = name;
    biz.sessionState = "product_add_price";
    await saveBizSafe(biz);

    return sendButtons(from, {
      text: `📦 *${name}*\n\n💰 *Enter product price:*`,
      buttons: [{ id: ACTIONS.MAIN_MENU, title: "🏠 Main Menu" }]
    });
  }

  if (biz?.sessionState === "product_add_price") {
    const price = Number(text);
    if (isNaN(price) || price <= 0) {
      await sendButtons(from, {
        text: "❌ Enter a valid price (e.g. 50):",
        buttons: [{ id: ACTIONS.MAIN_MENU, title: "🏠 Main Menu" }]
      });
      return;
    }

    const caller = await UserRole.findOne({ businessId: biz._id, phone, pending: false });

    await Product.create({
      businessId: biz._id,
      branchId: caller?.branchId || null,
      name: biz.sessionData.productName,
      unitPrice: price,
      isActive: true
    });

    biz.sessionState = "product_add_name_or_menu";
    biz.sessionData = {};
    await saveBizSafe(biz);

    await sendText(from, `✅ *${biz.sessionData?.productName || "Product"}* saved at *${formatMoney(price, biz.currency)}*`);

    return sendButtons(from, {
      text: "What would you like to do next?",
      buttons: [
        { id: "add_another_product", title: "➕ Add another product" },
        { id: ACTIONS.MAIN_MENU, title: "🏠 Main Menu" }
      ]
    });
  }

  // ── Bulk upload products ───────────────────────────────────────────────────

  if (biz && biz.sessionState === "bulk_upload_products" && !isMetaAction) {
    const msg = (text || "").trim();

    if (msg.toLowerCase() === "cancel") {
      biz.sessionState = "ready";
      biz.sessionData = {};
      await saveBizSafe(biz);
      await sendText(from, "❌ Bulk upload cancelled.");
      return sendProductsMenu(from);
    }

    if (msg.toLowerCase() === "done") {
      biz.sessionState = "ready";
      biz.sessionData = {};
      await saveBizSafe(biz);
      await sendText(from, "✅ Bulk upload finished.");
      return sendProductsMenu(from);
    }

    const lines = msg.split("\n").map(l => l.trim()).filter(Boolean);
    const parsed = [];
    const failed = [];

    for (const line of lines) {
      const m = line.match(/^(.+?)\s*[-|:]\s*(\d+(\.\d+)?)\s*$/);
      if (!m) { failed.push(line); continue; }
      const name = m[1].trim();
      const unitPrice = Number(m[2]);
      if (!name || Number.isNaN(unitPrice) || unitPrice < 0) { failed.push(line); continue; }
      parsed.push({ name, unitPrice });
    }

    if (!parsed.length) {
      await sendText(
        from,
        `❌ Couldn't read any valid lines.\n\nUse:\nMilk 1L - 1.50\nMath Lesson | 10\n\nInvalid:\n${failed.slice(0, 5).join("\n") || "(none)"}`
      );
      return;
    }

    const caller = await UserRole.findOne({ businessId: biz._id, phone, pending: false });

    await Product.insertMany(
      parsed.map(p => ({
        businessId: biz._id,
        branchId: caller?.branchId || null,
        name: p.name,
        unitPrice: p.unitPrice,
        isActive: true
      })),
      { ordered: false }
    ).catch(() => {});

    let reply = `✅ Imported: ${parsed.length}`;
    if (failed.length) reply += `\n❌ Skipped: ${failed.length}\n\nExamples skipped:\n${failed.slice(0, 5).join("\n")}`;
    reply += `\n\nSend more lines, or reply *done* to finish.`;
    return sendText(from, reply);
  }

  // ── Bulk expense input ─────────────────────────────────────────────────────
  // ✅ FIXED: more flexible CSV parser (handles spaces around commas, case-insensitive categories)

  if (biz && biz.sessionState === "bulk_expense_input" && !isMetaAction) {
    const textRaw = (text || "").trim();

    if (!textRaw) {
      await sendText(from, "❌ Paste at least one expense or type *done* to finish.");
      return;
    }

    if (textRaw.toLowerCase() === "done") {
      biz.sessionState = "ready";
      biz.sessionData = {};
      await saveBizSafe(biz);
      await sendText(from, "✅ Bulk expense entry complete.");
      return sendPaymentsMenu(from);
    }

    // Split by pipe OR newline
    const items = textRaw
      .split(/[|\n]/)
      .map(i => i.trim())
      .filter(Boolean);

    const Expense = (await import("../models/expense.js")).default;
    const caller = await UserRole.findOne({ businessId: biz._id, phone, pending: false });

    let created = 0;
    let skipped = 0;
    const skippedLines = [];

    // Case-insensitive category matching
    const categoryAliases = {
      rent: "Rent",
      utilities: "Utilities",
      utility: "Utilities",
      transport: "Transport",
      transportation: "Transport",
      supplies: "Supplies",
      supply: "Supplies",
      other: "Other"
    };

    for (const item of items) {
      // Accept: "Description, Amount, Category" OR "Description, Amount" (defaults to Other)
      const parts = item.split(",").map(p => p.trim());

      if (parts.length < 2) {
        skipped++;
        skippedLines.push(item);
        continue;
      }

      const description = parts[0];
      const amount = Number(parts[1]);
      const rawCategory = (parts[2] || "other").toLowerCase().trim();
      const category = categoryAliases[rawCategory] || "Other";

      if (!description || !amount || amount <= 0) {
        skipped++;
        skippedLines.push(item);
        continue;
      }

      await Expense.create({
        businessId: biz._id,
        branchId: caller?.branchId || null,
        description,
        amount,
        category,
        method: "Cash",
        createdBy: from
      });

      created++;
    }

    const totalAmount = items.reduce((sum, item) => {
      const parts = item.split(",");
      const amt = Number((parts[1] || "").trim());
      return sum + (isNaN(amt) ? 0 : amt);
    }, 0);

    let reply = `✅ Recorded *${created}* expenses`;
    if (skipped > 0) {
      reply += `\n⚠️ Skipped *${skipped}* (invalid format)`;
      if (skippedLines.length) reply += `\n\nSkipped lines:\n${skippedLines.slice(0, 3).join("\n")}`;
    }
    reply += `\n\n💰 Total: *${totalAmount} ${biz.currency}*`;
    reply += `\n\nType more or reply *done* to finish.`;

    return sendText(from, reply);
  }

  // ── Bulk paste products ────────────────────────────────────────────────────

  if (biz && biz.sessionState === "bulk_paste_input" && !isMetaAction) {
    const textRaw = (text || "").trim();

    if (!textRaw) {
      await sendText(from, "❌ Paste at least one product or type *done* to finish.");
      return;
    }

    if (textRaw.toLowerCase() === "done") {
      biz.sessionState = "ready";
      biz.sessionData = {};
      await saveBizSafe(biz);
      await sendText(from, "✅ Bulk paste complete.");
      return sendProductsMenu(from);
    }

    const items = textRaw.split(/[|\n]/).map(i => i.trim()).filter(Boolean);
    const caller = await UserRole.findOne({ businessId: biz._id, phone, pending: false });
    let created = 0, skipped = 0;

    for (const item of items) {
      const parts = item.split(",").map(p => p.trim());
      if (parts.length < 2) { skipped++; continue; }
      const name = parts[0];
      const unitPrice = Number(parts[1]);
      if (!name || name.length < 2 || Number.isNaN(unitPrice) || unitPrice <= 0) { skipped++; continue; }

      await Product.create({
        businessId: biz._id,
        branchId: caller?.branchId || null,
        name,
        unitPrice,
        isActive: true
      });
      created++;
    }

    let reply = `✅ Imported *${created}* products`;
    if (skipped > 0) reply += `\n⚠️ Skipped *${skipped}* (invalid format)`;
    if (created > 0) reply += `\n\nProducts added to your catalogue!`;
    reply += `\n\nType more products or reply *done* to finish.`;
    return sendText(from, reply);
  }

  // =========================
  // 🏢 ONBOARDING: BUSINESS NAME
  // =========================
  if (biz && biz.sessionState === "awaiting_business_name") {
    const name = text;
    if (!name || name.length < 2) {
      await sendText(from, "❌ Please enter a valid business name:");
      return;
    }

    biz.name = name;
    biz.sessionState = "awaiting_address";
    await saveBizSafe(biz);

    await sendButtons(from, {
      text: "📍 Would you like to add your business address?\n(It will appear on invoices & receipts)",
      buttons: [
        { id: "onb_address_yes", title: "Add address" },
        { id: "onb_address_skip", title: "Skip" }
      ]
    });
    return;
  }

  // ── Settings text states ───────────────────────────────────────────────────

  const settingsStates = [
    "settings_currency",
    "settings_terms",
    "settings_inv_prefix",
    "settings_qt_prefix",
    "settings_rcpt_prefix",
    "settings_address",
    "bulk_upload_products"
  ];

  // =========================
  // 💳 SUBSCRIPTION: ENTER ECOCASH NUMBER
  // =========================
  if (biz && biz.sessionState === "subscription_enter_ecocash" && !isMetaAction) {
    const waDigits = from.replace(/\D+/g, "");
    const ecocashPhone = normalizeEcocashNumber(text, waDigits);

    if (!ecocashPhone) {
      await sendText(from, "❌ Invalid EcoCash number.\n\nSend like: 0772123456\nOr type *same* to use this WhatsApp number.");
      return;
    }

    biz.sessionState = "subscription_payment_pending";
    biz.sessionData = { ...(biz.sessionData || {}), ecocashPhone };
    await saveBizSafe(biz);

    const selected = biz.sessionData?.targetPackage;
    const plan = selected ? SUBSCRIPTION_PLANS[selected] : null;

    if (!plan) {
      biz.sessionState = "ready";
      biz.sessionData = {};
      await saveBizSafe(biz);
      await sendText(from, "❌ Package info missing. Please select a package again.");
      return sendMainMenu(from);
    }

    const reference = `SUB_${biz._id}_${Date.now()}`;
    const payment = paynow.createPayment(reference, biz.ownerEmail || "bmusasa99@gmail.com");
    payment.currency = plan.currency;
    const chargeAmount = biz.sessionData?.amount || plan.price;
    payment.add(`${plan.name} Package`, chargeAmount);

    const response = await paynow.sendMobile(payment, ecocashPhone, "ecocash");

    await SubscriptionPayment.create({
      businessId: biz._id,
      packageKey: selected,
      amount: chargeAmount,
      currency: plan.currency,
      reference,
      pollUrl: response.pollUrl,
      ecocashPhone,
      status: "pending"
    });

    console.log("PAYNOW RESPONSE:", response);

    if (!response.success) {
      biz.sessionState = "ready";
      biz.sessionData = {};
      await saveBizSafe(biz);
      await sendText(from, "❌ Failed to start EcoCash payment. Try again.");
      return sendMainMenu(from);
    }

    biz.sessionData.paynow = { reference, pollUrl: response.pollUrl };
    await saveBizSafe(biz);

    const pollUrl = response.pollUrl;
    let attempts = 0;
    const MAX_ATTEMPTS = 15;

    const pollInterval = setInterval(async () => {
      attempts++;
      try {
        const status = await paynow.pollTransaction(pollUrl);
        console.log("PAYNOW POLL STATUS:", status);

        if (status.status && status.status.toLowerCase() === "paid") {
          clearInterval(pollInterval);

          const freshBiz = await Business.findById(biz._id);

          if (
            freshBiz &&
            freshBiz.sessionState === "subscription_payment_pending" &&
            freshBiz.sessionData?.targetPackage
          ) {
            const now = new Date();
            const target = freshBiz.sessionData?.targetPackage;
            const plan = target ? SUBSCRIPTION_PLANS[target] : null;
            if (!plan) return;

            const currentEnds = freshBiz.subscriptionEndsAt ? new Date(freshBiz.subscriptionEndsAt) : null;
            const hasActive = currentEnds && currentEnds.getTime() > now.getTime();

            if (!hasActive) {
              freshBiz.subscriptionStartedAt = now;
              freshBiz.subscriptionEndsAt = new Date(now.getTime() + plan.durationDays * 24 * 60 * 60 * 1000);
            }

            freshBiz.package = target;
            freshBiz.subscriptionStatus = "active";

            const payRec = await SubscriptionPayment.findOne({
              businessId: freshBiz._id,
              reference
            }).sort({ createdAt: -1 });

            const receiptNumber = `SUB-${reference.slice(-8).toUpperCase()}`;

            const { filename } = await generatePDF({
              type: "receipt",
              number: receiptNumber,
              date: now,
              billingTo: `${freshBiz.name} (Subscription)`,
              items: [{
                item: `${plan.name} Package`,
                qty: 1,
                unit: payRec?.amount || plan.price,
                total: payRec?.amount || plan.price
              }],
              bizMeta: {
                name: "Zimqoute",
                logoUrl: "",
                address: "Zimqoute",
                _id: freshBiz._id.toString(),
                status: "paid"
              }
            });

            const site = (process.env.SITE_URL || "").replace(/\/$/, "");
            const receiptUrl = `${site}/docs/generated/receipts/${filename}`;

            if (payRec) {
              payRec.status = "paid";
              payRec.paidAt = now;
              payRec.receiptFilename = filename;
              payRec.receiptUrl = receiptUrl;
              await payRec.save();
            }

            freshBiz.sessionState = "ready";
            freshBiz.sessionData = {};
            await freshBiz.save();

            await sendDocument(from, { link: receiptUrl, filename });

            await sendText(
              from,
`✅ Payment successful!

Package: *${freshBiz.package.toUpperCase()}*
Next due date: *${freshBiz.subscriptionEndsAt ? freshBiz.subscriptionEndsAt.toDateString() : "N/A"}*`
            );

            await sendMainMenu(from);
          }
        }

        if (attempts >= MAX_ATTEMPTS) {
          clearInterval(pollInterval);
          console.warn("⏰ Paynow polling timed out");
        }
      } catch (err) {
        console.error("Paynow polling failed:", err);
      }
    }, 10000);

    await sendText(
      from,
      `💳 ${plan.name} Package (${chargeAmount} ${plan.currency})\nEcoCash number: ${ecocashPhone}\n\nPlease confirm the payment on your phone.`
    );
    return;
  }

  // ── Pass text to Twilio state machine ─────────────────────────────────────

  const escapeWords = ["menu", "hi", "hello", "start"];

  if (
    !isMetaAction &&
    biz &&
    biz.sessionState &&
    !escapeWords.includes(al) &&
    !settingsStates.includes(biz.sessionState)
  ) {
    const handled = await continueTwilioFlow({ from, text });
    if (handled) return;
  }

  if (escapeWords.includes(al)) {
    if (!biz) return startOnboarding(from, phone);
    biz.sessionState = "ready";
    biz.sessionData = {};
    await saveBizSafe(biz);
    return sendMainMenu(from);
  }

  // =========================
  // 📍 ONBOARDING: ADDRESS
  // =========================
  if (biz && biz.sessionState === "awaiting_address") {
    if (a === "onb_address_yes") {
      biz.sessionState = "awaiting_address_input";
      await saveBizSafe(biz);
      return sendText(from, "Please enter your business address:");
    }

    if (a === "onb_address_skip") {
      biz.address = "";
      biz.sessionState = "awaiting_currency";
      await saveBizSafe(biz);
      return sendButtons(from, {
        text: "💱 Select your business currency",
        buttons: [
          { id: "onb_currency_USD", title: "USD ($)" },
          { id: "onb_currency_ZWL", title: "ZWL (Z$)" },
          { id: "onb_currency_ZAR", title: "ZAR (R)" }
        ]
      });
    }
  }

  if (biz && biz.sessionState === "awaiting_address_input" && !isMetaAction) {
    if (!text || text.length < 3) return sendText(from, "Please enter a valid address:");
    biz.address = text;
    biz.sessionState = "awaiting_currency";
    await saveBizSafe(biz);
    return sendButtons(from, {
      text: "💱 Select your business currency",
      buttons: [
        { id: "onb_currency_USD", title: "USD ($)" },
        { id: "onb_currency_ZWL", title: "ZWL (Z$)" },
        { id: "onb_currency_ZAR", title: "ZAR (R)" }
      ]
    });
  }

  if (biz && biz.sessionState === "awaiting_currency" && a.startsWith("onb_currency_")) {
    const currency = a.replace("onb_currency_", "").toUpperCase();
    if (!["USD", "ZWL", "ZAR"].includes(currency)) {
      await sendText(from, "❌ Invalid currency selection.");
      return;
    }
    biz.currency = currency;
    biz.sessionState = "awaiting_logo";
    await saveBizSafe(biz);
    await sendButtons(from, {
      text: "🖼 Would you like to add your business logo now?",
      buttons: [
        { id: "onb_logo_yes", title: "📷 Upload Logo" },
        { id: "onb_logo_skip", title: "Skip for now" }
      ]
    });
    return;
  }

  if (biz && biz.sessionState === "awaiting_logo") {
    if (a === "onb_logo_yes") {
      biz.sessionState = "awaiting_logo_upload";
      await saveBizSafe(biz);
      await sendText(from, "📷 Please send your logo image (PNG or JPG).\nYou can also type *skip* to continue without a logo.");
      return;
    }
    if (a === "onb_logo_skip") {
      biz.sessionState = "ready";
      await saveBizSafe(biz);
      await sendText(from, "✅ Setup complete!\n\nYour business is ready to use 🚀");
      return sendMainMenu(from);
    }
  }

  if (biz && biz.sessionState === "awaiting_logo_upload") {
    if (text && text.toLowerCase() === "skip") {
      const mainBranch = await Branch.create({ businessId: biz._id, name: "Main Branch", isDefault: true });
      await UserRole.findOneAndUpdate({ businessId: biz._id, phone, role: "owner" }, { branchId: mainBranch._id });
      biz.sessionState = "ready";
      await saveBizSafe(biz);
      await sendText(from, "✅ Setup complete!\n\n🏢 Main Branch created and assigned to you.");
      return sendMainMenu(from);
    }
    if (biz.logoUrl) {
      const mainBranch = await Branch.create({ businessId: biz._id, name: "Main Branch", isDefault: true });
      await UserRole.findOneAndUpdate({ businessId: biz._id, phone, role: "owner" }, { branchId: mainBranch._id });
      biz.sessionState = "ready";
      await saveBizSafe(biz);
      await sendText(from, "✅ Setup complete!\n\n🏢 Main Branch created and assigned to you.");
      return sendMainMenu(from);
    }
    return;
  }

  if (a.startsWith("invite_branch_")) {
    const branchId = a.replace("invite_branch_", "");
    if (!biz) return sendMainMenu(from);
    biz.sessionState = "invite_user_phone";
    biz.sessionData.branchId = branchId;
    await saveBizSafe(biz);
    return sendButtons(from, {
      text: "📱 *Enter WhatsApp number of the user to invite:*\n\nFormat: 0772123456",
      buttons: [{ id: ACTIONS.MAIN_MENU, title: "🏠 Main Menu" }]
    });
  }

  if (a.startsWith("assign_user_")) {
    const userId = a.replace("assign_user_", "");
    if (!biz) return sendMainMenu(from);
    const branches = await Branch.find({ businessId: biz._id }).lean();
    if (!branches.length) { await sendText(from, "No branches found."); return sendMainMenu(from); }
    biz.sessionData.userId = userId;
    biz.sessionState = "assign_branch_pick_branch";
    await saveBizSafe(biz);
    return sendList(from, "Select branch", branches.map(b => ({ id: `assign_branch_${b._id}`, title: b.name })));
  }

  if (a.startsWith("assign_branch_")) {
    if (!biz) return sendMainMenu(from);
    if (biz.sessionState !== "assign_branch_pick_branch") return;
    const branchId = a.replace("assign_branch_", "");
    const userId = biz.sessionData.userId;
    if (!userId) { await sendText(from, "⚠️ No user selected."); return sendMainMenu(from); }
    await UserRole.findByIdAndUpdate(userId, { branchId });
    biz.sessionState = "ready";
    biz.sessionData = {};
    await saveBizSafe(biz);
    await sendText(from, "✅ User successfully assigned to branch.");
    return sendMainMenu(from);
  }

  // ── Settings actions ───────────────────────────────────────────────────────

  if (a === ACTIONS.SETTINGS_INV_PREFIX) {
    if (!biz) return sendMainMenu(from);
    biz.sessionState = "settings_inv_prefix";
    await saveBizSafe(biz);
    return sendButtons(from, { text: `Current invoice prefix: *${biz.invoicePrefix || "INV"}*\n\nReply with new prefix:`, buttons: [{ id: ACTIONS.MAIN_MENU, title: "🏠 Main Menu" }] });
  }

  if (a === ACTIONS.SETTINGS_QT_PREFIX) {
    if (!biz) return sendMainMenu(from);
    biz.sessionState = "settings_qt_prefix";
    await saveBizSafe(biz);
    return sendButtons(from, { text: `Current quote prefix: *${biz.quotePrefix || "QT"}*\n\nReply with new prefix:`, buttons: [{ id: ACTIONS.MAIN_MENU, title: "🏠 Main Menu" }] });
  }

  if (a === ACTIONS.SETTINGS_RCPT_PREFIX) {
    if (!biz) return sendMainMenu(from);
    biz.sessionState = "settings_rcpt_prefix";
    await saveBizSafe(biz);
    return sendButtons(from, { text: `Current receipt prefix: *${biz.receiptPrefix || "RCPT"}*\n\nReply with new prefix:`, buttons: [{ id: ACTIONS.MAIN_MENU, title: "🏠 Main Menu" }] });
  }

  if (a === ACTIONS.SETTINGS_CURRENCY) {
    if (!biz) return sendMainMenu(from);
    biz.sessionState = "settings_currency";
    await saveBizSafe(biz);
    return sendButtons(from, { text: `Current currency: *${biz.currency}*\n\nReply with new currency (USD, ZWL, ZAR):`, buttons: [{ id: ACTIONS.MAIN_MENU, title: "🏠 Main Menu" }] });
  }

  if (a === ACTIONS.SETTINGS_TERMS) {
    if (!biz) return sendMainMenu(from);
    biz.sessionState = "settings_terms";
    await saveBizSafe(biz);
    return sendButtons(from, { text: `Current payment terms: *${biz.paymentTermsDays || 0} days*\n\nReply with number of days:`, buttons: [{ id: ACTIONS.MAIN_MENU, title: "🏠 Main Menu" }] });
  }

  if (a === ACTIONS.SETTINGS_ADDRESS) {
    if (!biz) return sendMainMenu(from);
    biz.sessionState = "settings_address";
    await saveBizSafe(biz);
    return sendButtons(from, { text: `Current address:\n${biz.address || "Not set"}\n\nReply with new address:`, buttons: [{ id: ACTIONS.MAIN_MENU, title: "🏠 Main Menu" }] });
  }

  if (biz?.sessionState === "settings_address" && !isMetaAction) {
    const addr = (text || "").trim();
    if (!addr || addr.length < 3) { await sendText(from, "❌ Please enter a valid address:"); return; }
    biz.address = addr;
    biz.sessionState = "ready";
    biz.sessionData = {};
    await saveBizSafe(biz);
    await sendText(from, "✅ Address updated successfully.");
    return sendSettingsMenu(from);
  }

  if (a === ACTIONS.SETTINGS_LOGO) {
    if (!biz) return sendMainMenu(from);
    biz.sessionState = "awaiting_logo_upload";
    await saveBizSafe(biz);
    return sendText(from, "📷 Please send your business logo image (PNG or JPG).\nReply 0 to cancel.");
  }

  if (a === ACTIONS.SETTINGS_CLIENTS) {
    if (!biz) return sendMainMenu(from);
    const Client = (await import("../models/client.js")).default;
    const clients = await Client.find({ businessId: biz._id }).lean();
    if (!clients.length) return sendText(from, "No clients found.");
    let msg = "👥 Clients:\n";
    clients.forEach((c, i) => { msg += `${i + 1}) ${c.name || c.phone}\n`; });
    await sendText(from, msg);
    return sendSettingsMenu(from);
  }

  if (a === ACTIONS.SETTINGS_BRANCHES) {
    if (!biz) return sendMainMenu(from);
    return sendBranchesMenu(from);
  }

  // ── Client statement ───────────────────────────────────────────────────────

  if (a.startsWith("stmt_client_")) {
    const clientId = a.replace("stmt_client_", "");
    if (!biz) return sendMainMenu(from);
    biz.sessionState = "client_statement_generate";
    biz.sessionData = { clientId };
    await saveBizSafe(biz);
    return continueTwilioFlow({ from, text: "generate" });
  }

  if (a.startsWith("prod_")) {
    const productId = a.replace("prod_", "");
    if (!biz) return sendMainMenu(from);
    const product = await Product.findById(productId);
    if (!product) return sendText(from, "❌ Item not found.");
    biz.sessionData.lastItem = { description: product.name, unit: product.unitPrice, source: "catalogue" };
    biz.sessionData.expectingQty = true;
    biz.sessionState = "creating_invoice_add_items";
    await saveBizSafe(biz);
    return sendButtons(from, {
      text: `📦 *${product.name}* @ *${formatMoney(product.unitPrice, biz.currency)}*\n\n🔢 *Enter quantity:*`,
      buttons: [{ id: ACTIONS.MAIN_MENU, title: "🏠 Main Menu" }]
    });
  }

  // ── Package selection ──────────────────────────────────────────────────────

  if (biz?.sessionState === "choose_package" && a.startsWith("pkg_")) {
    const selected = a.replace("pkg_", "");
    if (!["bronze", "silver", "gold"].includes(selected)) return sendText(from, "❌ Invalid package selected.");

    const plan = SUBSCRIPTION_PLANS[selected];
    if (!plan) return sendText(from, "❌ Invalid package selected.");

    const now = new Date();
    const currentKey = biz.package || "trial";
    const currentPlan = SUBSCRIPTION_PLANS[currentKey];
    const currentPrice = currentPlan?.price || 0;
    const endsAt = biz.subscriptionEndsAt ? new Date(biz.subscriptionEndsAt) : null;
    const hasActiveCycle = endsAt && endsAt.getTime() > now.getTime();

    let chargeAmount = plan.price;
    let note = "";

    if (hasActiveCycle && plan.price > currentPrice) {
      const remainingDays = clamp(msDays(endsAt.getTime() - now.getTime()), 0, 30);
      const diff = plan.price - currentPrice;
      chargeAmount = round2(diff * (remainingDays / plan.durationDays));
      if (chargeAmount < 0.01) chargeAmount = 0.01;
      note = `🔁 Upgrade proration:\n• Current: ${currentKey.toUpperCase()}\n• New: ${selected.toUpperCase()}\n• Days remaining: ${Math.ceil(remainingDays)}\n• You pay only the difference for remaining days.`;
    } else if (hasActiveCycle && plan.price <= currentPrice) {
      note = `ℹ️ Downgrades apply on next renewal date.`;
    }

    biz.sessionState = "subscription_enter_ecocash";
    biz.sessionData = {
      targetPackage: selected,
      amount: chargeAmount,
      prorationNote: note || null,
      previousPackage: currentKey,
      cycleEndsAt: endsAt ? endsAt.toISOString() : null
    };
    await saveBizSafe(biz);

    const pkg = PACKAGES[selected];
    const MAP = {
      invoice: "Invoices", quote: "Quotations", receipt: "Receipts",
      clients: "Clients", payments: "Payments",
      reports_daily: "Daily reports", reports_weekly: "Weekly reports",
      reports_monthly: "Monthly reports", branches: "Branches management",
      users: "User management"
    };
    const featureLines = (pkg?.features || []).map(f => `• ${MAP[f] || f}`);

    return sendText(
      from,
`✅ Selected: *${plan.name}* (${chargeAmount} ${plan.currency})

📦 Package limits:
• Users: ${pkg?.users}
• Branches: ${pkg?.branches}
• Docs per month: ${pkg?.monthlyDocs}

✨ Features:
${featureLines.join("\n")}

💳 *Payment method: EcoCash only*

Please enter the EcoCash number you want to pay with:
Example: 0772123456

Or type *same* to use this WhatsApp number.`
    );
  }

  // ── Sales document actions ─────────────────────────────────────────────────

  if (a.startsWith("doc_") && a !== ACTIONS.VIEW_DOC && a !== ACTIONS.DELETE_DOC) {
    const docId = a.replace("doc_", "");
    if (!biz) return sendMainMenu(from);
    const doc = await Invoice.findById(docId);
    if (!doc) { await sendText(from, "Document not found."); return sendSalesMenu(from); }

    const caller = await UserRole.findOne({ businessId: biz._id, phone, pending: false });
    biz.sessionState = "sales_doc_action";
    biz.sessionData = { docId };
    await saveBizSafe(biz);

    const buttons = [{ id: ACTIONS.VIEW_DOC, title: "📄 View PDF" }];
    if (caller && ["owner", "manager"].includes(caller.role)) {
      buttons.push({ id: ACTIONS.DELETE_DOC, title: "🗑 Delete" });
    }
    buttons.push({ id: ACTIONS.MAIN_MENU, title: "🏠 Main Menu" });
    buttons.push({ id: ACTIONS.BACK, title: "⬅ Back to List" });

    return sendButtons(from, {
      text: `📄 ${doc.number}\nStatus: ${doc.status}`,
      buttons
    });
  }

  if (a === ACTIONS.VIEW_DOC) {
    if (!biz?.sessionData?.docId) { await sendText(from, "❌ No document selected."); return sendSalesMenu(from); }
    const doc = await Invoice.findById(biz.sessionData.docId).lean();
    if (!doc) { await sendText(from, "❌ Document not found."); return sendSalesMenu(from); }
    const Client = (await import("../models/client.js")).default;
    const client = await Client.findById(doc.clientId).lean();
    if (!client) { await sendText(from, "❌ Client not found."); return sendSalesMenu(from); }

    const { filename } = await generatePDF({
      type: doc.type,
      number: doc.number,
      date: doc.createdAt || new Date(),
      billingTo: client.name || client.phone,
      items: doc.items,
      bizMeta: {
        name: biz.name, logoUrl: biz.logoUrl, address: biz.address || "",
        discountPercent: doc.discountPercent || 0, vatPercent: doc.vatPercent || 0,
        applyVat: doc.type === "receipt" ? false : true,
        _id: biz._id.toString(), status: doc.status
      }
    });

    const site = (process.env.SITE_URL || "").replace(/\/$/, "");
    const folder = doc.type === "invoice" ? "invoices" : doc.type === "quote" ? "quotes" : "receipts";
    const url = `${site}/docs/generated/${folder}/${filename}`;
    await sendDocument(from, { link: url, filename });
    biz.sessionState = "ready";
    biz.sessionData = {};
    await saveBizSafe(biz);
    return;
  }

  if (a === ACTIONS.DELETE_DOC) {
    if (!biz?.sessionData?.docId) { await sendText(from, "❌ No document selected."); return sendSalesMenu(from); }
    const caller = await UserRole.findOne({ businessId: biz._id, phone, pending: false });
    if (!caller || !["owner", "manager"].includes(caller.role)) {
      await sendText(from, "🔒 Only managers and owners can delete documents.");
      return sendSalesMenu(from);
    }
    const doc = await Invoice.findById(biz.sessionData.docId);
    if (!doc) { await sendText(from, "❌ Document not found."); return sendSalesMenu(from); }
    if (doc.status === "paid") { await sendText(from, "❌ Paid documents cannot be deleted."); return sendSalesMenu(from); }
    await Invoice.deleteOne({ _id: doc._id });
    biz.sessionState = "ready";
    biz.sessionData = {};
    await saveBizSafe(biz);
    await sendText(from, "🗑 Document deleted successfully.");
    return sendSalesMenu(from);
  }

  if (a.startsWith("subpay_")) {
    if (!biz) return sendMainMenu(from);
    const id = a.replace("subpay_", "");
    const rec = await SubscriptionPayment.findOne({ _id: id, businessId: biz._id }).lean();
    if (!rec) return sendText(from, "Record not found.");
    if (rec.receiptUrl) return sendDocument(from, { link: rec.receiptUrl, filename: rec.receiptFilename || "receipt.pdf" });
    return sendText(from, `Status: ${rec.status}\nAmount: ${rec.amount} ${rec.currency}\nRef: ${rec.reference}`);
  }

  // ── Owner selects branch for cash balance management ───────────────────────

  if (a.startsWith("cashbal_branch_")) {
    if (!biz) return sendMainMenu(from);
    const targetBranchId = a.replace("cashbal_branch_", "");
    const action = biz.sessionData?.cashBalAction;

    if (!action) return sendMainMenu(from);

    biz.sessionData.targetBranchId = targetBranchId;

    if (action === "set_opening") {
      biz.sessionState = "cash_set_opening_balance";
      await saveBizSafe(biz);
      return sendButtons(from, {
        text: "📝 *Set Opening Balance*\n\nEnter the opening cash amount:",
        buttons: [{ id: ACTIONS.MAIN_MENU, title: "🏠 Main Menu" }]
      });
    }

    if (action === "payout") {
      biz.sessionState = "cash_payout_amount";
      await saveBizSafe(biz);
      return sendButtons(from, {
        text: "💸 *Record Payout*\n\nEnter payout amount:",
        buttons: [{ id: ACTIONS.MAIN_MENU, title: "🏠 Main Menu" }]
      });
    }

    if (action === "view") {
      return showBranchCashBalance(from, biz, targetBranchId);
    }

    return sendMainMenu(from);
  }

  // ─────────────────────────────────────────────────────────────────────────

  switch (a) {

    case ACTIONS.SALES_MENU:
      return sendSalesMenu(from);

    case ACTIONS.CLIENTS_MENU:
      return sendClientsMenu(from);

    case ACTIONS.PAYMENTS_MENU:
      return sendPaymentsMenu(from);

    case ACTIONS.CASH_BALANCE_MENU: {
      const { sendCashBalanceMenu } = await import("./metaMenus.js");
      return sendCashBalanceMenu(from);
    }

    // ─── VIEW CASH BALANCE ──────────────────────────────────────────────────
    case ACTIONS.VIEW_CASH_BALANCE: {
      if (!biz) return sendMainMenu(from);
      const caller = await UserRole.findOne({ businessId: biz._id, phone, pending: false });

      // OWNER: show branch selector
      if (caller?.role === "owner") {
        const branches = await Branch.find({ businessId: biz._id }).lean();
        if (!branches.length) {
          await sendText(from, "❌ No branches found.");
          return sendMainMenu(from);
        }
        biz.sessionData = { ...(biz.sessionData || {}), cashBalAction: "view" };
        await saveBizSafe(biz);
        return sendList(from, "🏬 Select branch to view balance:", [
          ...branches.map(b => ({ id: `cashbal_branch_${b._id}`, title: b.name })),
          { id: "cashbal_branch_all", title: "📊 All Branches" }
        ]);
      }

      // Clerk/Manager: their own branch
      if (!caller?.branchId) {
        await sendText(from, "❌ No branch assigned. Contact your manager.");
        return sendMainMenu(from);
      }
      return showBranchCashBalance(from, biz, caller.branchId.toString());
    }

    // ─── SET OPENING BALANCE ────────────────────────────────────────────────
    case ACTIONS.SET_OPENING_BALANCE: {
      if (!biz) return sendMainMenu(from);
      const caller = await UserRole.findOne({ businessId: biz._id, phone, pending: false });

      // OWNER: choose which branch to set
      if (caller?.role === "owner") {
        const branches = await Branch.find({ businessId: biz._id }).lean();
        if (!branches.length) {
          await sendText(from, "❌ No branches found.");
          return sendMainMenu(from);
        }
        biz.sessionData = { ...(biz.sessionData || {}), cashBalAction: "set_opening" };
        await saveBizSafe(biz);
        return sendList(from, "🏬 Select branch to set opening balance:", [
          ...branches.map(b => ({ id: `cashbal_branch_${b._id}`, title: b.name }))
        ]);
      }

      // Clerk/Manager: own branch only
      if (!caller?.branchId) {
        await sendText(from, "❌ No branch assigned. Contact your manager.");
        return sendMainMenu(from);
      }

      // Check if already set
      const CashBalance = (await import("../models/cashBalance.js")).default;
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      const existing = await CashBalance.findOne({
        businessId: biz._id,
        branchId: caller.branchId,
        date: today
      }).lean();

      if (existing && existing.openingBalance > 0) {
        await sendText(from, `⚠️ Opening balance already set for today: *${existing.openingBalance} ${biz.currency}*\n\nContact your manager to change it.`);
        const { sendCashBalanceMenu } = await import("./metaMenus.js");
        return sendCashBalanceMenu(from);
      }

      biz.sessionState = "cash_set_opening_balance";
      biz.sessionData = { targetBranchId: caller.branchId.toString() };
      await saveBizSafe(biz);

      return sendButtons(from, {
        text: `📝 *Set Opening Balance*\n\nEnter the amount of cash in the till at the start of today:`,
        buttons: [{ id: ACTIONS.MAIN_MENU, title: "🏠 Main Menu" }]
      });
    }

    // ─── RECORD PAYOUT ──────────────────────────────────────────────────────
    case ACTIONS.RECORD_PAYOUT: {
      if (!biz) return sendMainMenu(from);
      const caller = await UserRole.findOne({ businessId: biz._id, phone, pending: false });

      // OWNER: choose which branch
      if (caller?.role === "owner") {
        const branches = await Branch.find({ businessId: biz._id }).lean();
        if (!branches.length) {
          await sendText(from, "❌ No branches found.");
          return sendMainMenu(from);
        }
        biz.sessionData = { ...(biz.sessionData || {}), cashBalAction: "payout" };
        await saveBizSafe(biz);
        return sendList(from, "🏬 Select branch to record payout:", [
          ...branches.map(b => ({ id: `cashbal_branch_${b._id}`, title: b.name }))
        ]);
      }

      if (!caller?.branchId) {
        await sendText(from, "❌ No branch assigned. Contact your manager.");
        return sendMainMenu(from);
      }

      biz.sessionState = "cash_payout_amount";
      biz.sessionData = { targetBranchId: caller.branchId.toString() };
      await saveBizSafe(biz);

      return sendButtons(from, {
        text: `💸 *Record Payout/Drawing*\n\nEnter the amount taken out of the till:`,
        buttons: [{ id: ACTIONS.MAIN_MENU, title: "🏠 Main Menu" }]
      });
    }

    case ACTIONS.REPORTS_MENU: {
      if (!biz) return sendMainMenu(from);
      if (!canUseFeature(biz, "reports_daily")) return promptUpgrade({ biz, from, feature: "Reports" });
      biz.sessionState = "reports_menu";
      biz.sessionData = {};
      await saveBizSafe(biz);
      const isGold = biz.package === "gold";
      return sendReportsMenu(from, isGold);
    }

    case "overall_reports": {
      if (!biz) return sendMainMenu(from);
      const { sendOverallReportsMenu } = await import("./metaMenus.js");
      return sendOverallReportsMenu(from, biz.package === "gold");
    }

    case "branch_reports": {
      if (!biz) return sendMainMenu(from);
      const { sendBranchReportsMenu } = await import("./metaMenus.js");
      return sendBranchReportsMenu(from, biz.package === "gold");
    }

    case "branch_daily": {
      if (!biz) return sendMainMenu(from);
      biz.sessionState = "report_choose_branch";
      biz.sessionData = { reportType: "daily" };
      await saveBizSafe(biz);
      return continueTwilioFlow({ from, text: "auto" });
    }

    case "branch_weekly": {
      if (!biz) return sendMainMenu(from);
      biz.sessionState = "report_choose_branch";
      biz.sessionData = { reportType: "weekly" };
      await saveBizSafe(biz);
      return continueTwilioFlow({ from, text: "auto" });
    }

    case "branch_monthly": {
      if (!biz) return sendMainMenu(from);
      biz.sessionState = "report_choose_branch";
      biz.sessionData = { reportType: "monthly" };
      await saveBizSafe(biz);
      return continueTwilioFlow({ from, text: "auto" });
    }

    case ACTIONS.BUSINESS_PROFILE: {
      if (!biz) return sendMainMenu(from);
      await sendText(from, `🏢 *Business Profile*\n\nName: ${biz.name}\nCurrency: ${biz.currency}\nPackage: ${biz.package}`);
      return sendMainMenu(from);
    }

    case ACTIONS.USERS_MENU:
      return sendUsersMenu(from);

    case ACTIONS.INVITE_USER: {
      if (!biz) return sendMainMenu(from);
      const caller = await UserRole.findOne({ businessId: biz._id, phone: phone, pending: false });
      if (!caller || caller.role !== "owner") return sendText(from, "🔒 Only the business owner can invite users.");
      const { PACKAGES } = await import("./packages.js");
      const pkg = PACKAGES[biz.package] || PACKAGES.trial;
      if (!pkg.features.includes("users")) return promptUpgrade({ biz, from, feature: "User management" });
      const activeUsers = await UserRole.countDocuments({ businessId: biz._id, pending: false });
      if (activeUsers >= pkg.users) return sendText(from, `🚫 User limit reached (${pkg.users}).\n\nUpgrade your package to add more users.`);
      biz.sessionState = "invite_user_choose_branch";
      biz.sessionData = {};
      await saveBizSafe(biz);
      const branches = await Branch.find({ businessId: biz._id }).lean();
      if (!branches.length) { await sendText(from, "No branches found. Please add a branch first."); return sendBranchesMenu(from); }
      return sendList(from, "Select branch for new user", branches.map(b => ({ id: `invite_branch_${b._id}`, title: b.name })));
    }

    case ACTIONS.BRANCHES_MENU: {
      if (!biz) return sendMainMenu(from);
      const { canAccessSection } = await import("./roleGuard.js");
      const caller = await UserRole.findOne({ businessId: biz._id, phone, pending: false });
      if (!caller || !canAccessSection(caller.role, "branches")) return sendText(from, "🔒 You do not have permission to access branches.");
      return sendBranchesMenu(from);
    }

    case ACTIONS.ADD_BRANCH: {
      if (!biz) return sendMainMenu(from);
      if (!canUseFeature(biz, "branches")) return promptUpgrade({ biz, from, feature: "Branches" });
      const count = await Branch.countDocuments({ businessId: biz._id });
      const { branches } = (await import("./packages.js")).PACKAGES[biz.package];
      if (count >= branches) return sendText(from, `🚫 Branch limit reached (${branches}).\nUpgrade your package to add more branches.`);
      biz.sessionState = "branch_add_name";
      await saveBizSafe(biz);
      return sendButtons(from, { text: "🏬 *Enter new branch name:*", buttons: [{ id: ACTIONS.MAIN_MENU, title: "🏠 Main Menu" }] });
    }

    case ACTIONS.VIEW_BRANCHES: {
      if (!biz) return sendMainMenu(from);
      const branches = await Branch.find({ businessId: biz._id }).lean();
      if (!branches.length) { await sendText(from, "No branches found."); return sendMainMenu(from); }
      let msg = "🏬 *Branches:*\n";
      branches.forEach((b, i) => { msg += `${i + 1}) ${b.name}\n`; });
      await sendText(from, msg);
      return sendMainMenu(from);
    }

    case ACTIONS.ASSIGN_BRANCH_USERS: {
      if (!biz) return sendMainMenu(from);
      const users = await UserRole.find({ businessId: biz._id, pending: false }).lean();
      if (!users.length) { await sendText(from, "No active users found."); return sendMainMenu(from); }
      biz.sessionState = "assign_branch_pick_user";
      biz.sessionData = {};
      await saveBizSafe(biz);
      return sendList(from, "Select user", users.map(u => ({ id: `assign_user_${u._id}`, title: u.phone })));
    }

    case ACTIONS.VIEW_INVITES: {
      if (!biz) return sendMainMenu(from);
      const pending = await UserRole.find({ businessId: biz._id, pending: true }).populate("branchId");
      if (!pending.length) return sendText(from, "✅ No pending invitations.");
      let msg = "⏳ *Pending Invites:*\n";
      pending.forEach((u, i) => { msg += `${i + 1}) ${u.phone} | ${u.role} | ${u.branchId?.name || "N/A"}\n`; });
      return sendText(from, msg);
    }

    case ACTIONS.VIEW_USERS: {
      if (!biz) return sendMainMenu(from);
      const users = await UserRole.find({ businessId: biz._id, pending: false }).populate("branchId");
      if (!users.length) return sendText(from, "No active users found.");
      let msg = "👥 *Active Users:*\n";
      users.forEach((u, i) => { msg += `${i + 1}) ${u.phone} | ${u.role} | ${u.branchId?.name || "N/A"}\n`; });
      return sendText(from, msg);
    }

    case ACTIONS.PAYMENT_IN:
      await showUnpaidInvoices(from);
      return;

    case ACTIONS.PAYMENT_OUT: {
      if (!biz) return sendMainMenu(from);
      biz.sessionState = ACTIONS.EXPENSE_CATEGORY;
      biz.sessionData = {};
      await saveBizSafe(biz);
      return sendList(from, "📂 Select Expense Category", [
        { id: "exp_cat_rent", title: "🏢 Rent" },
        { id: "exp_cat_utilities", title: "💡 Utilities" },
        { id: "exp_cat_transport", title: "🚗 Transport" },
        { id: "exp_cat_supplies", title: "📦 Supplies" },
        { id: "exp_cat_other", title: "📝 Other" }
      ]);
    }

    case ACTIONS.BUSINESS_MENU: {
      if (!biz) return sendMainMenu(from);
      const { canAccessSection } = await import("./roleGuard.js");
      const caller = await UserRole.findOne({ businessId: biz._id, phone, pending: false });
      if (!caller || !canAccessSection(caller.role, "users")) return sendText(from, "🔒 You do not have permission to access Business & Users.");
      return sendBusinessMenu(from);
    }

    // ✅ HIDE SUBSCRIPTION MENU FROM CLERKS & MANAGERS
    case ACTIONS.SUBSCRIPTION_MENU: {
      if (!biz) return sendMainMenu(from);
      const caller = await UserRole.findOne({ businessId: biz._id, phone, pending: false });
      if (caller && !["owner"].includes(caller.role)) {
        return sendText(from, "🔒 Only the business owner can manage subscriptions.");
      }
      return sendSubscriptionMenu(from);
    }

    case ACTIONS.SETTINGS_MENU: {
      if (!biz) return sendMainMenu(from);
      const { canAccessSection } = await import("./roleGuard.js");
      const caller = await UserRole.findOne({ businessId: biz._id, phone, pending: false });
      if (!caller || !canAccessSection(caller.role, "settings")) return sendText(from, "🔒 You do not have permission to access Settings.");
      biz.sessionState = "settings_menu";
      biz.sessionData = {};
      await saveBizSafe(biz);
      return sendSettingsMenu(from);
    }

    // ✅ HIDE UPGRADE FROM CLERKS & MANAGERS
    case ACTIONS.UPGRADE_PACKAGE: {
      if (!biz) return sendMainMenu(from);
      const caller = await UserRole.findOne({ businessId: biz._id, phone, pending: false });
      if (!caller || caller.role !== "owner") return sendText(from, "🔒 Only the business owner can change the package.");
      biz.sessionState = "choose_package";
      await saveBizSafe(biz);
      return sendPackagesMenu(from, biz.package);
    }

    case ACTIONS.BACK:
      return sendMainMenu(from);

    case ACTIONS.NEW_INVOICE: {
      if (!biz) return sendMainMenu(from);
      return startInvoiceFlow(from);
    }

    case ACTIONS.NEW_QUOTE: {
      if (!biz) return sendMainMenu(from);
      if (biz.package === "trial") return promptUpgrade({ biz, from, feature: "Quotes" });
      return startQuoteFlow(from);
    }

    case ACTIONS.NEW_RECEIPT: {
      if (!biz) return sendMainMenu(from);
      if (biz.package === "trial") return promptUpgrade({ biz, from, feature: "Receipts" });
      return startReceiptFlow(from);
    }

    case ACTIONS.VIEW_INVOICES: {
      if (!biz) return sendMainMenu(from);
      const caller = await UserRole.findOne({ businessId: biz._id, phone, pending: false });
      if (caller?.role === "owner") {
        const { sendBranchSelectorInvoices } = await import("./metaMenus.js");
        return sendBranchSelectorInvoices(from);
      }
      return showSalesDocs(from, "invoice");
    }

    case ACTIONS.VIEW_QUOTES: {
      if (!biz) return sendMainMenu(from);
      const caller = await UserRole.findOne({ businessId: biz._id, phone, pending: false });
      if (caller?.role === "owner") {
        const { sendBranchSelectorQuotes } = await import("./metaMenus.js");
        return sendBranchSelectorQuotes(from);
      }
      return showSalesDocs(from, "quote");
    }

    case ACTIONS.VIEW_RECEIPTS: {
      if (!biz) return sendMainMenu(from);
      const caller = await UserRole.findOne({ businessId: biz._id, phone, pending: false });
      if (caller?.role === "owner") {
        const { sendBranchSelectorReceipts } = await import("./metaMenus.js");
        return sendBranchSelectorReceipts(from);
      }
      return showSalesDocs(from, "receipt");
    }

    case ACTIONS.ADD_CLIENT:
      return startClientFlow(from);

    case ACTIONS.PRODUCTS_MENU:
      return sendProductsMenu(from);

    case ACTIONS.ADD_PRODUCT: {
      if (!biz) return sendMainMenu(from);
      biz.sessionState = "product_add_name";
      biz.sessionData = {};
      await saveBizSafe(biz);
      return sendButtons(from, { text: "📦 *Enter product name:*", buttons: [{ id: ACTIONS.MAIN_MENU, title: "🏠 Main Menu" }] });
    }

    case ACTIONS.VIEW_PRODUCTS: {
      if (!biz) return sendMainMenu(from);
      const caller = await UserRole.findOne({ businessId: biz._id, phone, pending: false });
      if (caller?.role === "owner") {
        const { sendBranchSelectorProducts } = await import("./metaMenus.js");
        return sendBranchSelectorProducts(from);
      }
      const query = { businessId: biz._id, isActive: true };
      if (caller?.branchId) query.branchId = caller.branchId;
      const products = await Product.find(query).lean();
      if (!products.length) { await sendText(from, "📦 No products found for your branch."); return sendMainMenu(from); }
      let msg = "📦 *Products (Your Branch):*\n\n";
      products.forEach((p, i) => { msg += `${i + 1}) *${p.name}* - ${formatMoney(p.unitPrice, biz.currency)}\n`; });
      await sendText(from, msg);
      return sendMainMenu(from);
    }

    case ACTIONS.BULK_UPLOAD_PRODUCTS: {
      if (!biz) return sendMainMenu(from);
      biz.sessionState = "bulk_upload_products";
      biz.sessionData = {};
      await saveBizSafe(biz);
      return sendText(from,
`📥 *Bulk upload (Products & Services)*

Send in ONE of these ways:

✅ Option A: Upload a CSV file
Columns: name, unitPrice

✅ Option B: Paste lines (one per item)
Format: Name - Price | Name | Price

Example:
Milk 1L - 1.50
Math Lesson | 10

Reply *done* when finished, or *cancel* to exit.`
      );
    }

    case ACTIONS.BULK_UPLOAD_MENU:
      return sendButtons(from, {
        text: "📋 *Bulk Paste (Products & Services)*\n\nPaste items (one per line).",
        buttons: [
          { id: ACTIONS.BULK_PASTE_MODE, title: "📋 Paste list" },
          { id: ACTIONS.BACK, title: "⬅ Back" }
        ]
      });

    case ACTIONS.BULK_PASTE_MODE: {
      if (!biz) return sendMainMenu(from);
      biz.sessionState = "bulk_paste_input";
      biz.sessionData = {};
      await saveBizSafe(biz);
      return sendText(from,
`📋 *Bulk Add Products*

✅ Format: Name, Price | Name, Price | Name, Price

Example:
Milk 1L, 1.50 | Bread, 2 | Math Lesson, 10

⚠️ Use *|* to separate products, comma between name and price.

Paste now, or reply *done* to finish.`
      );
    }

    case ACTIONS.BULK_EXPENSE_MODE: {
      if (!biz) return sendMainMenu(from);
      biz.sessionState = "bulk_expense_input";
      biz.sessionData = {};
      await saveBizSafe(biz);
      return sendText(from,
`📋 *Bulk Add Expenses*

✅ Format: Description, Amount, Category | Description, Amount, Category

Example:
Fuel, 50, Transport | Office supplies, 30, Supplies | Electricity, 100, Utilities

Categories: Rent, Utilities, Transport, Supplies, Other
(Category is optional — defaults to Other)

Use *|* or new lines to separate expenses.

Paste now, or reply *done* to finish.`
      );
    }

    case ACTIONS.SUBSCRIPTION_PAYMENTS: {
      if (!biz) return sendMainMenu(from);
      // Only owners
      const caller = await UserRole.findOne({ businessId: biz._id, phone, pending: false });
      if (caller && caller.role !== "owner") return sendText(from, "🔒 Only the business owner can view subscription payments.");
      const rows = await SubscriptionPayment.find({ businessId: biz._id }).sort({ createdAt: -1 }).limit(10).lean();
      if (!rows.length) { await sendText(from, "No subscription payments yet."); return sendSubscriptionMenu(from); }
      return sendList(from, "🧾 Subscription payments", rows.map(r => ({
        id: `subpay_${r._id}`,
        title: `${(r.packageKey || "").toUpperCase()} - ${r.amount} ${r.currency}`,
        description: `${r.status}${r.paidAt ? ` • ${new Date(r.paidAt).toDateString()}` : ""}`
      })));
    }

    case ACTIONS.VIEW_EXPENSE_RECEIPTS: {
      if (!biz) return sendMainMenu(from);
      const caller = await UserRole.findOne({ businessId: biz._id, phone, pending: false });
      const query = { businessId: biz._id };
      if (caller && ["clerk", "manager"].includes(caller.role) && caller.branchId) query.branchId = caller.branchId;
      const Expense = (await import("../models/expense.js")).default;
      const expenses = await Expense.find(query).sort({ createdAt: -1 }).limit(10).lean();
      if (!expenses.length) { await sendText(from, "📋 No expense receipts found."); return sendPaymentsMenu(from); }
      let msg = "🧾 *Recent Expense Receipts:*\n\n";
      expenses.forEach((e, i) => {
        const date = new Date(e.createdAt).toLocaleDateString();
        msg += `${i + 1}. *${e.category || "Other"}* - ${e.amount} ${biz.currency}\n`;
        msg += `   ${e.description || "No description"}\n`;
        msg += `   ${date} (${e.method || "Unknown method"})\n\n`;
      });
      await sendText(from, msg);
      return sendPaymentsMenu(from);
    }

    case ACTIONS.VIEW_PAYMENT_HISTORY: {
      if (!biz) return sendMainMenu(from);
      const caller = await UserRole.findOne({ businessId: biz._id, phone, pending: false });
      const query = { businessId: biz._id };
      if (caller && ["clerk", "manager"].includes(caller.role) && caller.branchId) query.branchId = caller.branchId;
      const InvoicePayment = (await import("../models/invoicePayment.js")).default;
      const payments = await InvoicePayment.find(query).sort({ createdAt: -1 }).limit(10).lean();
      if (!payments.length) { await sendText(from, "📋 No payment history found."); return sendPaymentsMenu(from); }
      let msg = "💵 *Recent Payments:*\n\n";
      for (const p of payments) {
        const invoice = await Invoice.findById(p.invoiceId).lean();
        const date = new Date(p.createdAt).toLocaleDateString();
        msg += `• *${p.amount} ${biz.currency}* (${p.method})\n`;
        msg += `  Invoice: ${invoice?.number || "Unknown"}\n`;
        msg += `  Date: ${date}\n\n`;
      }
      await sendText(from, msg);
      return sendPaymentsMenu(from);
    }

    case ACTIONS.VIEW_CLIENTS: {
      if (!biz) return sendMainMenu(from);
      const caller = await UserRole.findOne({ businessId: biz._id, phone, pending: false });
      const Client = (await import("../models/client.js")).default;
      let clients;
      if (caller && ["clerk", "manager"].includes(caller.role) && caller.branchId) {
        const branchInvoices = await Invoice.find({ businessId: biz._id, branchId: caller.branchId }).distinct("clientId");
        clients = await Client.find({ businessId: biz._id, _id: { $in: branchInvoices } }).lean();
      } else {
        clients = await Client.find({ businessId: biz._id }).lean();
      }
      if (!clients.length) { await sendText(from, "📋 No clients found."); return sendClientsMenu(from); }
      let msg = "👥 *Your Clients:*\n\n";
      clients.forEach((c, i) => {
        msg += `${i + 1}. *${c.name || "No name"}*\n`;
        if (c.phone) msg += `   📞 ${c.phone}\n`;
        if (c.email) msg += `   📧 ${c.email}\n`;
        msg += "\n";
      });
      await sendText(from, msg);
      return sendClientsMenu(from);
    }

    case ACTIONS.MAIN_MENU:
      return sendMainMenu(from);

    default: {
      // ── Sales doc branch selectors ─────────────────────────────────────────
      if (a === "view_all_invoices") return showSalesDocs(from, "invoice", null);
      if (a.startsWith("view_invoices_branch_")) return showSalesDocs(from, "invoice", a.replace("view_invoices_branch_", ""));
      if (a === "view_all_quotes") return showSalesDocs(from, "quote", null);
      if (a.startsWith("view_quotes_branch_")) return showSalesDocs(from, "quote", a.replace("view_quotes_branch_", ""));
      if (a === "view_all_receipts") return showSalesDocs(from, "receipt", null);
      if (a.startsWith("view_receipts_branch_")) return showSalesDocs(from, "receipt", a.replace("view_receipts_branch_", ""));

      // ── Product branch selectors ───────────────────────────────────────────
      if (a === "view_all_products") {
        if (!biz) return sendMainMenu(from);
        const products = await Product.find({ businessId: biz._id, isActive: true }).lean();
        if (!products.length) { await sendText(from, "📦 No products found."); return sendProductsMenu(from); }
        let msg = "📦 *All Products (All Branches):*\n\n";
        products.forEach((p, i) => { msg += `${i + 1}) *${p.name}* - ${formatMoney(p.unitPrice, biz.currency)}\n`; });
        await sendText(from, msg);
        return sendProductsMenu(from);
      }

      if (a.startsWith("view_products_branch_")) {
        const branchId = a.replace("view_products_branch_", "");
        if (!biz) return sendMainMenu(from);
        const branch = await Branch.findById(branchId);
        const products = await Product.find({ businessId: biz._id, branchId, isActive: true }).lean();
        if (!products.length) { await sendText(from, `📦 No products found for ${branch?.name || "this branch"}.`); return sendProductsMenu(from); }
        let msg = `📦 *Products (${branch?.name || "Branch"}):*\n\n`;
        products.forEach((p, i) => { msg += `${i + 1}) *${p.name}* - ${formatMoney(p.unitPrice, biz.currency)}\n`; });
        await sendText(from, msg);
        return sendProductsMenu(from);
      }

      // "cashbal_branch_all" — show all branches summary
      if (a === "cashbal_branch_all") {
        if (!biz) return sendMainMenu(from);
        return showAllBranchesCashBalance(from, biz);
      }

      // ── Branch report selector ─────────────────────────────────────────────
      if (a && (a.startsWith("report_branch_") || a.startsWith("branch_"))) {
        const bizForBranch = biz || await getBizForPhone(from);
        if (!bizForBranch) return sendMainMenu(from);

        let branchId = a.startsWith("report_branch_")
          ? a.replace("report_branch_", "")
          : a.replace("branch_", "");

        if (branchId === "all") {
          bizForBranch.sessionData.reportBranchId = null;
        } else {
          if (!mongoose.Types.ObjectId.isValid(branchId)) {
            await sendText(from, "⚠️ Invalid branch selected. Please try again.");
            return sendMainMenu(from);
          }
          bizForBranch.sessionData.reportBranchId = branchId;
        }

        const reportType = bizForBranch.sessionData?.reportType || "daily";
        bizForBranch.sessionState = "ready";
        await saveBizSafe(bizForBranch);

        if (reportType === "daily") {
          const { runDailyReportMetaEnhanced } = await import("./dailyReportEnhanced.js");
          return runDailyReportMetaEnhanced({ biz: bizForBranch, from });
        }
        if (reportType === "weekly") {
          const { runWeeklyReportMetaEnhanced } = await import("./weeklyReportEnhanced.js");
          return runWeeklyReportMetaEnhanced({ biz: bizForBranch, from });
        }
        if (reportType === "monthly") {
          const { runMonthlyReportMetaEnhanced } = await import("./monthlyReportEnhanced.js");
          return runMonthlyReportMetaEnhanced({ biz: bizForBranch, from });
        }

        return sendMainMenu(from);
      }
    }
  }
}

// ─── Cash balance display helpers ─────────────────────────────────────────────

async function showBranchCashBalance(from, biz, branchId) {
  const CashBalance = (await import("../models/cashBalance.js")).default;
  const CashPayout = (await import("../models/cashPayout.js")).default;
  const InvoicePayment = (await import("../models/invoicePayment.js")).default;
  const Branch = (await import("../models/branch.js")).default;
  const Invoice = (await import("../models/invoice.js")).default;
  const Expense = (await import("../models/expense.js")).default;

  const branch = await Branch.findById(branchId).lean();
  const branchName = branch?.name || "Branch";

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);

  const balance = await CashBalance.findOne({
    businessId: biz._id,
    branchId,
    date: today
  }).lean();

  // ── Fetch today's transactions ──────────────────────────────────────────
  // Cash receipts (invoice payments) recorded today
  const cashPayments = await InvoicePayment.find({
    businessId: biz._id,
    branchId,
    createdAt: { $gte: today, $lt: tomorrow }
  }).lean();

  // Receipt-type invoices (instant cash sales) created today
  const cashReceipts = await Invoice.find({
    businessId: biz._id,
    branchId,
    type: "receipt",
    createdAt: { $gte: today, $lt: tomorrow }
  }).lean();

  // Expenses today
  const expenses = await Expense.find({
    businessId: biz._id,
    branchId,
    createdAt: { $gte: today, $lt: tomorrow }
  }).lean();

  // Payouts today
  let payouts = [];
  try {
    payouts = await CashPayout.find({
      businessId: biz._id,
      branchId,
      date: today
    }).lean();
  } catch (_) {
    // CashPayout model may not exist yet — silently ignore
  }

  const cur = biz.currency;
  const opening = balance?.openingBalance ?? 0;

  // Total cash in = invoice payments + receipt sales
  const cashIn = cashPayments.reduce((s, p) => s + p.amount, 0)
    + cashReceipts.reduce((s, r) => s + r.total, 0);

  // Total cash out = expenses + payouts
  const cashOutExpenses = expenses.reduce((s, e) => s + e.amount, 0);
  const cashOutPayouts = payouts.reduce((s, p) => s + p.amount, 0);
  const cashOut = cashOutExpenses + cashOutPayouts;

  const closing = opening + cashIn - cashOut;

  // ── Build message ───────────────────────────────────────────────────────
  let msg = `💰 *Cash Balance — ${branchName}*\n📅 ${today.toDateString()}\n\n`;
  msg += `━━━━━━━━━━━━━━\n`;
  msg += `📂 *Opening Balance:* ${opening} ${cur}\n\n`;

  msg += `📈 *Cash In:* +${cashIn} ${cur}\n`;
  if (cashPayments.length > 0) {
    msg += `   • Invoice payments: ${cashPayments.reduce((s, p) => s + p.amount, 0)} ${cur} (${cashPayments.length})\n`;
  }
  if (cashReceipts.length > 0) {
    msg += `   • Receipt sales: ${cashReceipts.reduce((s, r) => s + r.total, 0)} ${cur} (${cashReceipts.length})\n`;
  }

  msg += `\n📉 *Cash Out:* -${cashOut} ${cur}\n`;
  if (cashOutExpenses > 0) {
    msg += `   • Expenses: ${cashOutExpenses} ${cur} (${expenses.length})\n`;
    // Show expense breakdown
    const expByCategory = {};
    expenses.forEach(e => {
      expByCategory[e.category || "Other"] = (expByCategory[e.category || "Other"] || 0) + e.amount;
    });
    Object.entries(expByCategory).forEach(([cat, amt]) => {
      msg += `     – ${cat}: ${amt} ${cur}\n`;
    });
  }
  if (cashOutPayouts > 0) {
    msg += `   • Payouts/Drawings: ${cashOutPayouts} ${cur} (${payouts.length})\n`;
    payouts.forEach(p => {
      msg += `     – ${p.reason || "No reason"}: ${p.amount} ${cur}\n`;
    });
  }

  msg += `\n━━━━━━━━━━━━━━\n`;
  msg += `${closing >= opening ? "📈" : "📉"} *Closing Balance: ${closing} ${cur}*\n`;
  msg += `━━━━━━━━━━━━━━\n`;

  if (opening === 0 && cashIn === 0) {
    msg += `\n⚠️ No opening balance set for today.`;
  }

  await sendText(from, msg);

  const { sendCashBalanceMenu } = await import("./metaMenus.js");
  return sendCashBalanceMenu(from);
}

async function showAllBranchesCashBalance(from, biz) {
  const CashBalance = (await import("../models/cashBalance.js")).default;
  const Branch = (await import("../models/branch.js")).default;

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const branches = await Branch.find({ businessId: biz._id }).lean();
  if (!branches.length) {
    await sendText(from, "❌ No branches found.");
    return sendMainMenu(from);
  }

  const cur = biz.currency;
  let msg = `💰 *Cash Balance Summary — All Branches*\n📅 ${today.toDateString()}\n\n`;

  let totalOpening = 0, totalIn = 0, totalOut = 0;

  for (const branch of branches) {
    const balance = await CashBalance.findOne({
      businessId: biz._id,
      branchId: branch._id,
      date: today
    }).lean();

    const opening = balance?.openingBalance ?? 0;
    const cashIn = balance?.cashIn ?? 0;
    const cashOut = balance?.cashOut ?? 0;
    const closing = opening + cashIn - cashOut;

    totalOpening += opening;
    totalIn += cashIn;
    totalOut += cashOut;

    const trend = closing >= opening ? "📈" : "📉";
    msg += `🏬 *${branch.name}*\n`;
    msg += `   Opening: ${opening} ${cur}\n`;
    msg += `   Cash In: +${cashIn} ${cur}\n`;
    msg += `   Cash Out: -${cashOut} ${cur}\n`;
    msg += `   ${trend} Closing: *${closing} ${cur}*\n\n`;
  }

  msg += `━━━━━━━━━━━━━━\n`;
  msg += `📊 *TOTAL*\n`;
  msg += `   Opening: ${totalOpening} ${cur}\n`;
  msg += `   Cash In: +${totalIn} ${cur}\n`;
  msg += `   Cash Out: -${totalOut} ${cur}\n`;
  msg += `   Closing: *${totalOpening + totalIn - totalOut} ${cur}*\n`;

  await sendText(from, msg);

  const { sendCashBalanceMenu } = await import("./metaMenus.js");
  return sendCashBalanceMenu(from);
}