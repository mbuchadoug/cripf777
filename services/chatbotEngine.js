//chatbotEngine

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
  sendSubscriptionMenu,
  sendBranchSelectorInvoices,
  sendBranchSelectorQuotes,
  sendBranchSelectorReceipts,
  sendBranchSelectorProducts,
  sendBranchSelectorNewDoc,
  sendBranchSelectorAddProduct,
  sendBranchSelectorPaymentIn,
  sendBranchSelectorExpense,
  sendBranchSelectorBulkExpense,
  sendBranchSelectorViewExpenses,
  sendBranchSelectorPaymentHistory,
  sendBranchSelectorAddClient,
  sendBranchSelectorViewClients,
  sendSuppliersMenu,
  sendSupplierUpgradeMenu,
  sendSupplierAccountMenu,
} from "./metaMenus.js";

import { getBizForPhone, saveBizSafe } from "./bizHelpers.js";
import { sendText } from "./metaSender.js";
import { importCsvFromMetaDocument } from "./csvImport.js";
import axios from "axios";

// ─── Supplier Platform Imports ────────────────────────────────────────────────
import SupplierProfile from "../models/supplierProfile.js";
import SupplierOrder from "../models/supplierOrder.js";
import SupplierSubscriptionPayment from "../models/supplierSubscriptionPayment.js";
import { SUPPLIER_PLANS, SUPPLIER_CITIES, SUPPLIER_CATEGORIES } from "./supplierPlans.js";
import {
  startSupplierRegistration,
  handleSupplierRegistrationStates
} from "./supplierRegistration.js";
import {
  startSupplierSearch,
  runSupplierSearch,
  formatSupplierResults,
  parseShortcodeSearch
} from "./supplierSearch.js";
import {
  notifySupplierNewOrder,
  handleOrderAccepted,
  handleOrderDeclined,
  handleBookingAccepted
} from "./supplierOrders.js";
import { sendRatingPrompt, updateSupplierCredibility } from "./supplierRatings.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

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

function normalizeProductName(value = "") {
  return String(value)
    .toLowerCase()
    .trim()
    .replace(/[^\w\s]/g, "")
    .replace(/\s+/g, " ");
}


function getSupplierCategoriesForType(profileType = "product") {
  return SUPPLIER_CATEGORIES.filter(cat =>
    Array.isArray(cat.types) ? cat.types.includes(profileType) : true
  );
}
function parseSupplierRateValue(rate = "") {
  const raw = String(rate || "").trim();
  if (!raw) return null;

  // examples: "10/hr", "$10/hr", "50/trip", "15"
  const m = raw.match(/^\$?\s*(\d+(?:\.\d+)?)/);
  if (!m) return null;

  return Number(m[1]);
}

function parseSupplierRateUnit(rate = "") {
  const raw = String(rate || "").trim();
  const parts = raw.split("/");
  if (parts.length < 2) return "each";
  return parts[1].trim() || "each";
}


function formatSupplierRateDisplay(rate = "") {
  const raw = String(rate || "").trim();
  if (!raw) return "";

  // If it already starts with $, keep it
  if (raw.startsWith("$")) return raw;

  const value = parseSupplierRateValue(raw);
  const unit = parseSupplierRateUnit(raw);

  if (typeof value === "number" && !Number.isNaN(value)) {
    return `$${value}/${unit}`;
  }

  return raw;
}
function findMatchingSupplierPrice(supplier, requestedProduct) {
  if (!requestedProduct) return null;

  const wanted = normalizeProductName(requestedProduct);
  const isServiceSupplier = supplier?.profileType === "service";

  // SERVICES: only use rates
  if (isServiceSupplier) {
    if (Array.isArray(supplier?.rates) && supplier.rates.length) {
      let match = supplier.rates.find(r =>
        normalizeProductName(r.service) === wanted
      );

      if (match) {
        return {
          product: match.service,
          amount: parseSupplierRateValue(match.rate),
          unit: parseSupplierRateUnit(match.rate),
          source: "rates"
        };
      }

      match = supplier.rates.find(r => {
        if (!r?.service) return false;
        const candidate = normalizeProductName(r.service);
        return candidate.includes(wanted) || wanted.includes(candidate);
      });

      if (match) {
        return {
          product: match.service,
          amount: parseSupplierRateValue(match.rate),
          unit: parseSupplierRateUnit(match.rate),
          source: "rates"
        };
      }
    }

    return null;
  }

  // PRODUCTS: only use prices
  if (Array.isArray(supplier?.prices) && supplier.prices.length) {
    let match = supplier.prices.find(p =>
      p?.inStock !== false &&
      normalizeProductName(p.product) === wanted
    );

    if (match) {
      return {
        product: match.product,
        amount: Number(match.amount),
        unit: match.unit || "each",
        source: "prices"
      };
    }

    match = supplier.prices.find(p => {
      if (p?.inStock === false || !p?.product) return false;
      const candidate = normalizeProductName(p.product);
      return candidate.includes(wanted) || wanted.includes(candidate);
    });

    if (match) {
      return {
        product: match.product,
        amount: Number(match.amount),
        unit: match.unit || "each",
        source: "prices"
      };
    }
  }

  return null;
}


function parseBulkOrderInput(text = "") {
  const raw = String(text).trim();
  if (!raw) return [];

  return raw
    .split(/[|\n,]+/)
    .map(s => s.trim())
    .filter(Boolean)
    .map(part => {
      // examples:
      // sugar 2
      // cooking oil x3
      // rice 5kg
      // bread 4 loaves
      const m = part.match(/^(.+?)\s+(?:x\s*)?(\d+(?:\.\d+)?)\s*([a-zA-Z]*)$/i);
      if (!m) {
        return {
          raw: part,
          product: part,
          quantity: 1,
          unitLabel: "units",
          valid: false
        };
      }

      return {
        raw: part,
        product: m[1].trim(),
        quantity: Number(m[2]),
        unitLabel: m[3]?.trim() || "units",
        valid: true
      };
    });
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

/**
 * Helper: get caller's effective branchId.
 * - Clerks/managers → their assigned branchId
 * - Owner → targetBranchId stored in sessionData (set by branch picker)
 */
function getEffectiveBranchId(caller, sessionData) {
  if (caller?.role === "owner") {
    return sessionData?.targetBranchId || null;
  }
  return caller?.branchId || null;
}

async function startOnboarding(from, phone) {
  const existingOwner = await UserRole.findOne({ phone, role: "owner", pending: false }).lean();

  if (existingOwner?.businessId) {
    const b = await Business.findById(existingOwner.businessId);
    if (b) {
      await UserSession.findOneAndUpdate({ phone }, { activeBusinessId: b._id }, { upsert: true });
      // Always reset to onboarding state (handles ghost biz and stale states)
      b.sessionState = "awaiting_business_name";
      b.sessionData = {};
      await saveBizSafe(b);
      await sendText(from, "👋 Welcome! Let's set up your business.\n\nSend your business name:");
      return;
    }
  }

  const newBiz = await Business.create({
    name: "", currency: "USD", package: "trial",
    subscriptionStatus: "inactive",
    sessionState: "awaiting_business_name",
    sessionData: {}, ownerPhone: phone
  });

  await UserRole.create({ phone, role: "owner", pending: false, businessId: newBiz._id });
  await UserSession.findOneAndUpdate({ phone }, { activeBusinessId: newBiz._id }, { upsert: true });
  await sendText(from, "👋 Welcome! Let's set up your business.\n\nSend your business name:");
}

async function showSalesDocs(from, type, ownerBranchId = undefined) {
  const biz = await getBizForPhone(from);
  if (!biz) return sendMainMenu(from);

  const phone = from.replace(/\D+/g, "");
  const caller = await UserRole.findOne({ businessId: biz._id, phone, pending: false });

  const query = { businessId: biz._id, type };

  if (caller?.role === "owner" && ownerBranchId !== undefined) {
    if (ownerBranchId !== null) query.branchId = ownerBranchId;
  } else if (caller && ["clerk", "manager"].includes(caller.role) && caller.branchId) {
    query.branchId = caller.branchId;
  }

  const docs = await Invoice.find(query).sort({ createdAt: -1 }).limit(10).lean();

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

  return sendList(from, header,
    docs.map(d => ({ id: `doc_${d._id}`, title: `${d.number} - ${d.total} ${d.currency}` }))
  );
}

// ─── Client list helper ───────────────────────────────────────────────────────

async function sendClientSelectList(from, biz) {
  const clients = await (await import("../models/client.js")).default
    .find({ businessId: biz._id })
    .sort({ updatedAt: -1 }).limit(9).lean();

  const rows = clients.map(c => ({ id: `client_${c._id}`, title: c.name || c.phone }));
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
       a === "expense_generate_receipt" ||
      a.startsWith("report_branch_") ||
      a.startsWith("sup_") ||
      a.startsWith("rate_order_") ||
      a.startsWith("sup_plan_") ||
      a.startsWith("sup_accept_") ||
      a.startsWith("sup_decline_") ||
      a.startsWith("sup_order_") ||
      a.startsWith("sup_view_") ||
      a.startsWith("sup_save_") ||
      a.startsWith("sup_search_cat_") ||
      a.startsWith("sup_search_city_") ||
      a.startsWith("sup_eta_") ||
a === "find_supplier" ||
      a === "register_supplier" ||
      a === "my_supplier_account" ||
      a === "my_orders" ||
      a.startsWith("order_detail_") ||
      a.startsWith("sup_book_") ||
      a.startsWith("sup_book_confirm_") ||
      a === "reg_type_product" ||
      a === "reg_type_service" ||
      a === "sup_travel_yes" ||
      a === "sup_travel_no" ||
      a === "sup_preset_confirm" ||
a === "sup_preset_prices_yes" ||
a.startsWith("sup_load_preset_") ||
a === "sup_skip_products" ||
a === "sup_enter_own_products" ||
a === "sup_request_upload" ||
a === "sup_prices_confirm_yes" ||
a === "sup_price_update_confirm" ||
a === "sup_prices_edit" ||
a === "sup_preset_confirm" ||
a === "sup_preset_prices_yes" ||
a.startsWith("sup_load_preset_") ||

    a === "sup_skip_prices" ||
      a === "sup_done_prices" ||
      a === "sup_update_prices" ||
      a === "sup_edit_products" ||
      a === "sup_toggle_delivery" ||
      a === "sup_toggle_active" ||
      a === "sup_edit_area" ||
      a === "sup_my_orders" ||
      a === "sup_my_earnings" ||
      a === "sup_my_reviews" ||
      a === "sup_upgrade_plan" ||
      a === "sup_renew_plan" ||
      a === "onboard_business" ||
      a === "suppliers_home" ||
      a === "back" ||
      a === "suppliers_home" ||
      a.startsWith("branch_") ||
      a.startsWith("new_doc_branch_") ||
      a.startsWith("add_product_branch_") ||
      a.startsWith("add_client_branch_") ||
      a.startsWith("payment_in_branch_") ||
      a.startsWith("expense_branch_") ||
      a.startsWith("bulk_expense_branch_") ||
      a.startsWith("view_expense_receipts_branch_") ||
      a.startsWith("view_payment_history_branch_") ||
      a.startsWith("view_clients_branch_") ||
      a.startsWith("cashbal_branch_")
    );

  // =========================
  // 🔑 JOIN INVITATION (ABSOLUTE PRIORITY)
  // =========================
  if (al === "join") {
    const invite = await UserRole.findOne({ phone, pending: true }).populate("businessId branchId");

    if (!invite) {
      await sendText(from, "❌ No pending invitation found for this number.");
      return;
    }

    invite.pending = false;
    await invite.save();

    await UserSession.findOneAndUpdate(
      { phone }, { activeBusinessId: invite.businessId._id }, { upsert: true }
    );

    await sendText(from,
`✅ Invitation accepted!

🏢 Business: ${invite.businessId.name}
📍 Branch: ${invite.branchId?.name || "Main"}
🔑 Role: ${invite.role}

Reply *menu* to start.`);

    await sendMainMenu(from);
    return;
  }

  console.log("META INCOMING:", { from, action });

  const biz = await getBizForPhone(from);

  // =========================
  // 🟢 ONBOARDING GATE
  // =========================
  const ownerRole = await UserRole.findOne({ phone, role: "owner", pending: false }).lean();

if (!biz && ownerRole?.businessId) {
    const existingBiz = await Business.findById(ownerRole.businessId);
    if (existingBiz && !existingBiz.name.startsWith("pending_supplier_")) {
      await UserSession.findOneAndUpdate({ phone }, { activeBusinessId: existingBiz._id }, { upsert: true });
      await sendText(from, "✅ Welcome back. Opening your menu...");
      await sendMainMenu(from);
      return;
    }
  }

  // =========================
  // 🆕 NEW USER - WELCOME SCREEN (not auto-onboard)
  // =========================
// =========================
// 🆕 NEW USER - WELCOME SCREEN (not auto-onboard)
// =========================

if (!biz && !ownerRole) {
  const supplierExists = await SupplierProfile.findOne({ phone });
  const sess = await UserSession.findOne({ phone });

const searchMode = sess?.tempData?.supplierSearchMode;
if (searchMode === "product") {
  const productQuery = text.trim();
  if (!productQuery || productQuery.length < 1) {
    return sendButtons(from, {
      text: "❌ Please type what you're looking for:\n\n_e.g. find cement, find plumber harare_",
      buttons: [{ id: "find_supplier", title: "⬅ Back" }]
    });
  }

  const { parseShortcodeSearch } = await import("./supplierSearch.js");
  const parsed = parseShortcodeSearch(productQuery) || parseShortcodeSearch(`find ${productQuery}`) || { product: productQuery, city: null };
  await UserSession.findOneAndUpdate(
    { phone },
    {
      $set: {
        "tempData.supplierSearchProduct": parsed.product,
        ...(parsed.city ? { "tempData.lastSearchCity": parsed.city } : {})
      },
      $unset: { "tempData.supplierSearchMode": "" }
    }
  );

  if (parsed.city) {
    // Skip city picker - go straight to results
    const results = await runSupplierSearch({
      city: parsed.city,
      product: parsed.product,
      profileType: sess?.tempData?.supplierSearchType || null
    });
    if (!results.length) {
      return sendButtons(from, {
        text: `😕 No results for *${parsed.product}* in *${parsed.city}*.\n\nTry a different city or search term.`,
        buttons: [
          { id: "find_supplier", title: "🔍 Search Again" },
          { id: "sup_search_city_all", title: "📍 Try All Cities" }
        ]
      });
    }
    const rows = formatSupplierResults(results, parsed.city, parsed.product);
    return sendList(from, `🔍 *${parsed.product}* in ${parsed.city} - ${results.length} found`, rows);
  }

  return sendList(from, `🔍 Looking for: *${parsed.product}*\n\nWhich city?`, [
    ...SUPPLIER_CITIES.map(c => ({
      id: `sup_search_city_${c.toLowerCase()}`,
      title: c
    })),
    { id: "sup_search_city_all", title: "📍 All Cities" }
  ]);
}

  const hasActiveBuyerFlow =
    !!sess?.tempData?.orderState ||
    !!sess?.tempData?.supplierSearchMode ||
    !!sess?.tempData?.supplierSearchCategory ||
    !!sess?.tempData?.supplierSearchProduct;

  // Allow supplier search/order actions through for non-registered users
const allowedWithoutBiz =
  a === "onboard_business" ||
  a === "find_supplier" ||
  a === "register_supplier" ||
  a === "suppliers_home" ||
  a === "my_orders" ||
  a === "sup_upgrade_plan" ||   // ← ADD THIS LINE
  a === "sup_renew_plan" ||     // ← ADD THIS LINE  
  a === "sup_search_type_product" ||
  a === "sup_search_type_service" ||
  a === "sup_search_more_categories" ||
  a === "sup_search_all" ||
  a.startsWith("sup_search_cat_") ||
  a.startsWith("sup_search_city_") ||
  a.startsWith("sup_view_") ||
  a.startsWith("sup_order_") ||
  a.startsWith("sup_save_") ||
  a.startsWith("rate_order_") ||
  a.startsWith("sup_accept_") ||
  a.startsWith("sup_decline_") ||

  a.startsWith("sup_cart_add_") ||
a.startsWith("sup_cart_confirm_") ||
a.startsWith("sup_cart_clear_") ||
a.startsWith("sup_cart_custom_") ||
  a === "my_supplier_account";

// ── Shortcode search intercept: "find cement", "s plumber harare" etc ─────
  if (!isMetaAction && text.trim().length > 2) {
    const { parseShortcodeSearch } = await import("./supplierSearch.js");
    const shortcode = parseShortcodeSearch(text);
    if (shortcode) {
      await UserSession.findOneAndUpdate(
        { phone },
        {
          $set: {
            "tempData.supplierSearchProduct": shortcode.product,
            ...(shortcode.city ? { "tempData.lastSearchCity": shortcode.city } : {})
          }
        },
        { upsert: true }
      );

      if (shortcode.city) {
        const results = await runSupplierSearch({
          city: shortcode.city,
          product: shortcode.product
        });
        if (results.length) {
          const rows = formatSupplierResults(results, shortcode.city, shortcode.product);
          return sendList(from, `🔍 *${shortcode.product}* in ${shortcode.city} - ${results.length} found`, rows);
        }
      }

      return sendList(from, `🔍 Looking for: *${shortcode.product}*\n\nWhich city?`, [
        ...SUPPLIER_CITIES.map(c => ({
          id: `sup_search_city_${c.toLowerCase()}`,
          title: c
        })),
        { id: "sup_search_city_all", title: "📍 All Cities" }
      ]);
    }
  }


 

  if (!supplierExists && al !== "join" && !allowedWithoutBiz && !hasActiveBuyerFlow) {
  return sendList(from, "👋 *Welcome to ZimQuote!*\n\nZimbabwe's business platform.", [
    { id: "find_supplier", title: "🔍 Find Suppliers" },
    { id: "my_orders", title: "📋 My Orders" },
    { id: "register_supplier", title: "📦 List My Business" },
    { id: "onboard_business", title: "🧾 Run My Business" }
  ]);
}
}



  // =========================
  // 🛒 BUYER ORDER FLOW (no-biz users via UserSession)
  // =========================
  if (!biz && !isMetaAction) {
    const sess = await UserSession.findOne({ phone });
    const orderState = sess?.tempData?.orderState;

    if (
  al === "cancel" &&
  (orderState === "supplier_order_product" || orderState === "supplier_order_address")
) {
  await UserSession.findOneAndUpdate(
    { phone },
    {
      $unset: {
        "tempData.orderState": "",
        "tempData.orderSupplierId": "",
        "tempData.orderItems": "",
        "tempData.orderProduct": "",
        "tempData.orderQuantity": ""
      }
    }
  );

await sendText(from, "❌ Order cancelled.");
return sendButtons(from, {
  text: "What would you like to do next?",
  buttons: [
    { id: "find_supplier", title: "🔍 Find Suppliers" },
    { id: "my_orders", title: "📋 My Orders" },
    { id: "onboard_business", title: "🧾 Run My Business" }
  ]
});
}
if (orderState === "supplier_order_product") {
  const parsedItems = parseBulkOrderInput(text);

  if (!parsedItems.length || parsedItems.every(i => !i.valid)) {
  return sendText(from,
`❌ Please enter your order in this format:

*product qty, product qty*

Examples:
*sugar 2, bread 3, milk 1*
*cement 10, river sand 2*

You can also send one per line.

Type *cancel* to stop this order.`);
  }

  await UserSession.findOneAndUpdate(
    { phone },
    {
      $set: {
        "tempData.orderItems": parsedItems,
        "tempData.orderState": "supplier_order_address"
      },
      $unset: {
        "tempData.orderProduct": "",
        "tempData.orderQuantity": ""
      }
    }
  );

  const preview = parsedItems
    .map(i => `• ${i.product} x${i.quantity}${i.unitLabel && i.unitLabel !== "units" ? " " + i.unitLabel : ""}`)
    .join("\n");

const sess2 = await UserSession.findOne({ phone });
const supplierIdForSummary = sess2?.tempData?.orderSupplierId;
const supplierForSummary = supplierIdForSummary
  ? await SupplierProfile.findById(supplierIdForSummary).lean()
  : null;
const isServiceSupplier = supplierForSummary?.profileType === "service";

return sendText(from,
`${isServiceSupplier ? "📅" : "🛒"} *${isServiceSupplier ? "Booking Summary" : "Order Summary"}*

${preview}

*Now enter your ${isServiceSupplier ? "location or contact note" : "delivery address or contact note"}:*

${isServiceSupplier
  ? "Examples:\n• *House number 24, Mabelreign*\n• *Come tomorrow 10am*\n• *Call me when you arrive*"
  : "Examples:\n• *123 Samora Machel Ave, Harare*\n• *Deliver to Avondale after 4pm*\n• *Call me when you get here*"
}

Type *cancel* to stop this ${isServiceSupplier ? "booking" : "order"}.`);



}

   

if (orderState === "supplier_order_address") {
  const address = text.trim();
if (!address || address.length < 2) {
  return sendText(from,
`❌ Please enter your delivery address or contact note:

Type *cancel* to stop this order.`);
}

  const sess3 = await UserSession.findOne({ phone });
  const supplierId = sess3?.tempData?.orderSupplierId;
 const orderItemsInput = sess3?.tempData?.orderCart?.length
  ? sess3.tempData.orderCart
  : (sess3?.tempData?.orderItems || []);

if (!supplierId) {
  await UserSession.findOneAndUpdate(
    { phone },
    {
      $unset: {
        "tempData.orderState": "",
        "tempData.orderSupplierId": "",
        "tempData.orderItems": "",
        "tempData.orderProduct": "",
        "tempData.orderQuantity": ""
      }
    }
  );
  await sendText(from, "❌ Order session expired. Please search for the supplier again.");
  //return sendSuppliersMenu(from);

return sendButtons(from, {
  text: "What would you like to do next?",
  buttons: [
    { id: "find_supplier", title: "🔍 Find Suppliers" },
    { id: "register_supplier", title: "📦 Become a Supplier" },
    { id: "onboard_business", title: "🧾 Run My Business" }
  ]
});

}



  const supplier = await SupplierProfile.findById(supplierId).lean();

  if (!supplier) {
    await UserSession.findOneAndUpdate(
      { phone },
      {
        $unset: {
          "tempData.orderState": "",
          "tempData.orderSupplierId": "",
          "tempData.orderItems": "",
          "tempData.orderProduct": "",
          "tempData.orderQuantity": ""
        }
      }
    );
    await sendText(from, "❌ Supplier not found. Please search again.");
    return sendSuppliersMenu(from);
  }
 
 const normalizedItems = Array.isArray(orderItemsInput) ? orderItemsInput : [];
if (!normalizedItems.length) {
  await UserSession.findOneAndUpdate(
    { phone },
    { $unset: { "tempData.orderState": "", "tempData.orderSupplierId": "", "tempData.orderItems": "" } }
  );
  await sendText(from, "❌ Order session expired. Please start again.");
  return sendSuppliersMenu(from);
}

let totalAmount = 0;
let pricedCount = 0;

const finalItems = normalizedItems.map(entry => {
  const quantity = Number(entry.quantity) || 1;
  const requestedUnit = entry.unitLabel || "units";
  const matchedPrice = findMatchingSupplierPrice(supplier, entry.product);

  let pricePerUnit = null;
  let total = null;
  let finalUnit = requestedUnit;

  if (matchedPrice && typeof matchedPrice.amount === "number") {
    pricePerUnit = matchedPrice.amount;
    total = quantity * matchedPrice.amount;
    finalUnit = matchedPrice.unit || requestedUnit;
    totalAmount += total;
    pricedCount++;
  }

  return {
    product: entry.product,
    quantity,
    unit: finalUnit,
    pricePerUnit,
    currency: "USD",
    total
  };
});

const order = await SupplierOrder.create({
  supplierId: supplier._id,
  supplierPhone: supplier.phone,
  buyerPhone: phone,
  items: finalItems,
  totalAmount,
  currency: "USD",
  delivery: {
    required: supplier.delivery?.available || false,
    address
  },
  status: "pending"
});

      await notifySupplierNewOrder(supplier.phone, order);

      // Clear order state from UserSession
    await UserSession.findOneAndUpdate(
  { phone },
  {
    $unset: {
      "tempData.orderState": "",
      "tempData.orderSupplierId": "",
      "tempData.orderItems": "",
      "tempData.orderProduct": "",
      "tempData.orderQuantity": ""
    }
  }
);

 const itemSummary = finalItems
  .map(i => `• ${i.product} x${i.quantity}${i.unit && i.unit !== "units" ? " " + i.unit : ""}`)
  .join("\n");

const isServiceSupplier = supplier.profileType === "service";

await sendText(from,
`✅ *${isServiceSupplier ? "Booking sent to" : "Order sent to"} ${supplier.businessName}!*

${itemSummary}
${supplier.delivery?.available
  ? `📍 ${address}`
  : isServiceSupplier
    ? `📍 Location/Note: ${address}`
    : `📝 Note: ${address}`}
${pricedCount > 0 ? `💵 Current estimated total: $${totalAmount.toFixed(2)}\n` : ""}📞 Supplier: ${supplier.phone}

${pricedCount === finalItems.length
  ? `${isServiceSupplier ? "All services were auto-priced. Supplier can confirm immediately. 🎉" : "All items were auto-priced. Supplier can confirm immediately. 🎉"}`
  : pricedCount > 0
    ? `${isServiceSupplier ? "Some services were auto-priced. Supplier will confirm the rest. 🎉" : "Some items were auto-priced. Supplier will confirm the rest. 🎉"}`
    : `${isServiceSupplier ? "Supplier will confirm pricing for the booking shortly. 🎉" : "Supplier will confirm pricing shortly. 🎉"}`}`);
return sendButtons(from, {
  text: "What would you like to do next?",
  buttons: [
    { id: "find_supplier", title: "🔍 Find Suppliers" },
    { id: "register_supplier", title: "📦 Become a Supplier" },
    { id: "onboard_business", title: "🧾 Run My Business" }
  ]
});

    }
  }
  // =========================
  // 🔑 ROLE CHECK
  // =========================
  let callerRole = null;
  let caller = null;
  if (biz) {
    caller = await UserRole.findOne({ businessId: biz._id, phone, pending: false });
    callerRole = caller?.role || null;
  }

  // ✅ LOCKED USER CHECK - block bot access for locked users
  if (caller?.locked) {
    await sendText(from, "🔒 Your account has been suspended. Please contact the business owner.");
    return;
  }

  // ─── META BUTTON / LIST ACTIONS ──────────────────────────────────────────

  if (al === "inv_use_client") {
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
      text: `💳 *Invoice ${invoice.number}*\n\nTotal: *${invoice.total} ${invoice.currency}*\nPaid: ${invoice.amountPaid} ${invoice.currency}\nBalance: *${invoice.balance} ${invoice.currency}*\n\nEnter amount paid:`,
      buttons: [{ id: ACTIONS.MAIN_MENU, title: "🏠 Main Menu" }]
    });
    return;
  }

  // ── Invoice confirm actions ────────────────────────────────────────────────

  if (a === "inv_generate_pdf") {
    if (!biz) return sendMainMenu(from);
    const summary = biz.sessionData.items
      .map((i, idx) => `${idx + 1}) ${i.item} x${i.qty} @ ${i.unit}`).join("\n");
    await sendText(from, `📄 Generating PDF...\n\n${summary}`);
    await continueTwilioFlow({ from, text: "2" });
    return;
  }

  if (a === "inv_set_discount") {
    if (!biz) return sendMainMenu(from);
    biz.sessionState = "creating_invoice_set_discount";
    await saveBizSafe(biz);
    await sendButtons(from, { text: "💸 Enter discount percent (0-100):", buttons: [{ id: ACTIONS.MAIN_MENU, title: "🏠 Main Menu" }] });
    return;
  }

  if (a === "inv_set_vat") {
    if (!biz) return sendMainMenu(from);
    biz.sessionState = "creating_invoice_set_vat";
    await saveBizSafe(biz);
    await sendButtons(from, { text: "🧾 Enter VAT percent (0-100):", buttons: [{ id: ACTIONS.MAIN_MENU, title: "🏠 Main Menu" }] });
    return;
  }

  if (a === "inv_item_catalogue") {
    if (!biz) return sendMainMenu(from);
    const query = { businessId: biz._id, isActive: true };
    if (caller && ["clerk", "manager"].includes(caller.role) && caller.branchId) {
      query.branchId = caller.branchId;
    } else if (caller?.role === "owner" && biz.sessionData?.targetBranchId) {
      query.branchId = biz.sessionData.targetBranchId;
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
    biz.sessionData = { targetBranchId: biz.sessionData?.targetBranchId };
    await saveBizSafe(biz);
    return sendList(from, "📂 Select Expense Category", [
      { id: "exp_cat_rent", title: "🏢 Rent" },
      { id: "exp_cat_utilities", title: "💡 Utilities" },
      { id: "exp_cat_transport", title: "🚗 Transport" },
      { id: "exp_cat_supplies", title: "📦 Supplies" },
      { id: "exp_cat_other", title: "📝 Other" }
    ]);
  }


  // ✅ ADD THIS BLOCK immediately after the add_another_expense block
if (a === "expense_generate_receipt") {
  if (!biz) return sendMainMenu(from);

  const lastExpense = biz.sessionData?.lastExpense;

  if (!lastExpense) {
    biz.sessionState = "ready";
    biz.sessionData = {};
    await saveBizSafe(biz);
    await sendText(from, "❌ No expense found to generate receipt for.");
    return sendMainMenu(from);
  }

  const receiptNumber = `EXP-${lastExpense.id.toString().slice(-6)}`;

  const { filename } = await generatePDF({
    type: "receipt",
    number: receiptNumber,
    date: lastExpense.date || new Date(),
    billingTo: lastExpense.category,
    items: [{
      item: lastExpense.description || lastExpense.category,
      qty: 1,
      unit: lastExpense.amount,
      total: lastExpense.amount
    }],
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

  await sendText(from, "✅ Expense receipt generated!");
  return sendMainMenu(from);
}

// ✅ NEW: Generate receipt for last expense (SKIP add another)
  if (biz?.sessionState === "expense_add_another_menu" && !isMetaAction) {
    const textLower = text.toLowerCase().trim();
    
    // User types anything (not a button) while in this state
    if (textLower === "receipt" || textLower === "generate" || textLower === "skip") {
      const lastExpense = biz.sessionData?.lastExpense;
      
      if (!lastExpense) {
        biz.sessionState = "ready";
        biz.sessionData = {};
        await saveBizSafe(biz);
        await sendText(from, "❌ No expense found.");
        return sendMainMenu(from);
      }

      const receiptNumber = `EXP-${lastExpense.id.toString().slice(-6)}`;

      const { filename } = await generatePDF({
        type: "receipt", 
        number: receiptNumber, 
        date: lastExpense.date || new Date(),
        billingTo: lastExpense.category,
        items: [{
          item: lastExpense.description || lastExpense.category,
          qty: 1,
          unit: lastExpense.amount,
          total: lastExpense.amount
        }],
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

      await sendText(from, "✅ Receipt generated!");
      return sendMainMenu(from);
    }
    
    // Otherwise keep waiting for button press
    return true;
  }


  if (a === "inv_add_new_product") {
    if (!biz) return sendMainMenu(from);
    biz.sessionState = "invoice_quick_add_product_name";
    biz.sessionData = { ...biz.sessionData, itemMode: "catalogue", quickAddProduct: {} };
    await saveBizSafe(biz);
    return sendButtons(from, { text: "📦 *Enter product/service name:*", buttons: [{ id: ACTIONS.MAIN_MENU, title: "🏠 Main Menu" }] });
  }

  if (a === "add_another_product") {
    if (!biz) return sendMainMenu(from);
    biz.sessionState = "product_add_name";
    biz.sessionData = { targetBranchId: biz.sessionData?.targetBranchId };
    await saveBizSafe(biz);
    return sendButtons(from, { text: "📦 *Enter product name:*", buttons: [{ id: ACTIONS.MAIN_MENU, title: "🏠 Main Menu" }] });
  }

  if (a === "inv_item_custom") {
    if (!biz) return sendMainMenu(from);
    biz.sessionData.itemMode = "custom";
    await saveBizSafe(biz);
    return sendButtons(from, { text: "✍️ *Send item description:*", buttons: [{ id: ACTIONS.MAIN_MENU, title: "🏠 Main Menu" }] });
  }

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
    products.forEach((p, i) => { msg += `${i + 1}) *${p.name}* - ${formatMoney(p.unitPrice, biz.currency)}\n`; });
    return sendText(from, msg);
  }

  // ── Client statement ───────────────────────────────────────────────────────
  if (a === ACTIONS.CLIENT_STATEMENT) {
    if (!biz) return sendMainMenu(from);
    const Client = (await import("../models/client.js")).default;
    let clients;

    if (caller && ["clerk", "manager"].includes(caller.role) && caller.branchId) {
      const branchInvoices = await Invoice.find({ businessId: biz._id, branchId: caller.branchId }).distinct("clientId");
      clients = await Client.find({ businessId: biz._id, _id: { $in: branchInvoices } }).lean();
    } else {
      clients = await Client.find({ businessId: biz._id }).lean();
    }

    if (!clients.length) { await sendText(from, "No clients found."); return sendMainMenu(from); }

    biz.sessionState = "client_statement_choose_client";
    biz.sessionData = {};
    await saveBizSafe(biz);

    return sendList(from, "📄 Select client for statement",
      clients.map(c => ({ id: `stmt_client_${c._id}`, title: c.name || c.phone }))
    );
  }

  if (a === ACTIONS.ADD_PRODUCT) {
    if (!biz) return sendMainMenu(from);
    // Owner: pick a branch first
    if (caller?.role === "owner") return sendBranchSelectorAddProduct(from);
    // Clerk/manager: use their branch
    biz.sessionState = "product_add_name";
    biz.sessionData = {};
    await saveBizSafe(biz);
    return sendButtons(from, { text: "📦 *Enter product name:*", buttons: [{ id: ACTIONS.MAIN_MENU, title: "🏠 Main Menu" }] });
  }

  // ── Owner picks branch for Add Product ───────────────────────────────────
  if (a.startsWith("add_product_branch_")) {
    if (!biz) return sendMainMenu(from);
    const branchId = a.replace("add_product_branch_", "");
    biz.sessionState = "product_add_name";
    biz.sessionData = { targetBranchId: branchId };
    await saveBizSafe(biz);
    const branch = await Branch.findById(branchId);
    return sendButtons(from, {
      text: `📦 *Add Product - ${branch?.name || "Branch"}*\n\nEnter product name:`,
      buttons: [{ id: ACTIONS.MAIN_MENU, title: "🏠 Main Menu" }]
    });
  }

  // ── Owner picks branch for Add Client ────────────────────────────────────
  if (a.startsWith("add_client_branch_")) {
    if (!biz) return sendMainMenu(from);
    const branchId = a.replace("add_client_branch_", "");
    biz.sessionData = { targetBranchId: branchId };
    await saveBizSafe(biz);
    // Now start the client flow with the branch set
    biz.sessionState = "adding_client_name";
    await saveBizSafe(biz);
    const branch = await Branch.findById(branchId);
    return sendButtons(from, {
      text: `👥 *Add Client - ${branch?.name || "Branch"}*\n\nEnter client full name:`,
      buttons: [{ id: ACTIONS.MAIN_MENU, title: "🏠 Main Menu" }]
    });
  }

  // ── Owner picks branch for Payment IN ────────────────────────────────────
  if (a.startsWith("payment_in_branch_")) {
    if (!biz) return sendMainMenu(from);
    const branchId = a.replace("payment_in_branch_", "");
    biz.sessionData = { targetBranchId: branchId };
    await saveBizSafe(biz);
    // Show unpaid invoices for this branch
    await showUnpaidInvoices(from, branchId);
    return;
  }

  // ── Owner picks branch for Expense (OUT) ─────────────────────────────────
  if (a.startsWith("expense_branch_")) {
    if (!biz) return sendMainMenu(from);
    const branchId = a.replace("expense_branch_", "");
    biz.sessionState = ACTIONS.EXPENSE_CATEGORY;
    biz.sessionData = { targetBranchId: branchId };
    await saveBizSafe(biz);
    return sendList(from, "📂 Select Expense Category", [
      { id: "exp_cat_rent", title: "🏢 Rent" },
      { id: "exp_cat_utilities", title: "💡 Utilities" },
      { id: "exp_cat_transport", title: "🚗 Transport" },
      { id: "exp_cat_supplies", title: "📦 Supplies" },
      { id: "exp_cat_other", title: "📝 Other" }
    ]);
  }

  // ── Owner picks branch for Bulk Expenses ─────────────────────────────────

 // ── Owner picks branch for Bulk Expenses ─────────────────────────────────
  if (a.startsWith("bulk_expense_branch_")) {
    if (!biz) return sendMainMenu(from);
    const branchId = a.replace("bulk_expense_branch_", "");
    biz.sessionState = "bulk_expense_input";
    biz.sessionData = { targetBranchId: branchId, bulkExpenses: [] };
    await saveBizSafe(biz);
    const branch = await Branch.findById(branchId);
    return sendText(from,
`💰 *Bulk Expense - ${branch?.name || "Branch"}*

Type expenses separated by commas:
*lunch 10, cables 5, transport 20*

Categories auto-detected ✨

*Commands:*
- 'list' - Show all
- 'remove 2' - Delete #2
- 'done' - Save all
- 'help' - More info`);
  }

  // ── Owner picks branch for View Expense Receipts ──────────────────────────
  if (a.startsWith("view_expense_receipts_branch_")) {
    if (!biz) return sendMainMenu(from);
    const branchId = a.replace("view_expense_receipts_branch_", "");
    return showExpenseReceipts(from, biz, branchId === "all" ? null : branchId);
  }

  // ── Owner picks branch for View Payment History ───────────────────────────
  if (a.startsWith("view_payment_history_branch_")) {
    if (!biz) return sendMainMenu(from);
    const branchId = a.replace("view_payment_history_branch_", "");
    return showPaymentHistory(from, biz, branchId === "all" ? null : branchId);
  }

  // ── Owner picks branch for View Clients ──────────────────────────────────
  if (a.startsWith("view_clients_branch_")) {
    if (!biz) return sendMainMenu(from);
    const branchId = a.replace("view_clients_branch_", "");
    return showClientsList(from, biz, branchId === "all" ? null : branchId);
  }

  // ── Owner picks branch for New Invoice/Quote/Receipt ─────────────────────
  if (a.startsWith("new_doc_branch_")) {
    if (!biz) return sendMainMenu(from);
    // Format: new_doc_branch_{docType}_{branchId}
    const rest = a.replace("new_doc_branch_", "");
    const parts = rest.split("_");
    // branchId is the last ObjectId segment (24 hex chars), docType is before it
    const branchId = parts[parts.length - 1];
    const docType = parts.slice(0, -1).join("_"); // handles "invoice", "quote", "receipt"

    // Validate branchId
    if (!mongoose.Types.ObjectId.isValid(branchId)) {
      await sendText(from, "⚠️ Invalid branch selected.");
      return sendSalesMenu(from);
    }

    // Store the target branch so the flow uses it
    biz.sessionData = { targetBranchId: branchId };
    await saveBizSafe(biz);

    if (docType === "invoice") return startInvoiceFlow(from);
    if (docType === "quote") {
      if (biz.package === "trial") return promptUpgrade({ biz, from, feature: "Quotes" });
      return startQuoteFlow(from);
    }
    if (docType === "receipt") {
      if (biz.package === "trial") return promptUpgrade({ biz, from, feature: "Receipts" });
      return startReceiptFlow(from);
    }

    return sendSalesMenu(from);
  }

  // ── Invoice client picker ──────────────────────────────────────────────────
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
    // Owner: pick branch first
    if (caller?.role === "owner") return sendBranchSelectorExpense(from);
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
      await sendButtons(from, { text: "❌ Enter a valid product name:", buttons: [{ id: ACTIONS.MAIN_MENU, title: "🏠 Main Menu" }] });
      return;
    }
    biz.sessionData.productName = name;
    biz.sessionState = "product_add_price";
    await saveBizSafe(biz);
    return sendButtons(from, { text: `📦 *${name}*\n\n💰 *Enter product price:*`, buttons: [{ id: ACTIONS.MAIN_MENU, title: "🏠 Main Menu" }] });
  }

  if (biz?.sessionState === "product_add_price") {
    const price = Number(text);
    if (isNaN(price) || price <= 0) {
      await sendButtons(from, { text: "❌ Enter a valid price (e.g. 50):", buttons: [{ id: ACTIONS.MAIN_MENU, title: "🏠 Main Menu" }] });
      return;
    }

    const effectiveBranchId = getEffectiveBranchId(caller, biz.sessionData);

    await Product.create({
      businessId: biz._id,
      branchId: effectiveBranchId,
      name: biz.sessionData.productName,
      unitPrice: price,
      isActive: true,
      createdBy: phone
    });

    const savedName = biz.sessionData.productName;
    biz.sessionState = "product_add_name_or_menu";
    biz.sessionData = { targetBranchId: biz.sessionData.targetBranchId }; // preserve for next product
    await saveBizSafe(biz);

    await sendText(from, `✅ *${savedName}* saved at *${formatMoney(price, biz.currency)}*`);
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
      biz.sessionState = "ready"; biz.sessionData = {};
      await saveBizSafe(biz);
      await sendText(from, "❌ Bulk upload cancelled.");
      return sendProductsMenu(from);
    }

    if (msg.toLowerCase() === "done") {
      biz.sessionState = "ready"; biz.sessionData = {};
      await saveBizSafe(biz);
      await sendText(from, "✅ Bulk upload finished.");
      return sendProductsMenu(from);
    }

    const lines = msg.split("\n").map(l => l.trim()).filter(Boolean);
    const parsed = [], failed = [];

    for (const line of lines) {
      const m = line.match(/^(.+?)\s*[-|:]\s*(\d+(\.\d+)?)\s*$/);
      if (!m) { failed.push(line); continue; }
      const name = m[1].trim();
      const unitPrice = Number(m[2]);
      if (!name || Number.isNaN(unitPrice) || unitPrice < 0) { failed.push(line); continue; }
      parsed.push({ name, unitPrice });
    }

    if (!parsed.length) {
      await sendText(from, `❌ Couldn't read any valid lines.\n\nUse:\nMilk 1L - 1.50\nMath Lesson | 10\n\nInvalid:\n${failed.slice(0, 5).join("\n") || "(none)"}`);
      return;
    }

    const effectiveBranchId = getEffectiveBranchId(caller, biz.sessionData);

    await Product.insertMany(
      parsed.map(p => ({ businessId: biz._id, branchId: effectiveBranchId, name: p.name, unitPrice: p.unitPrice, isActive: true })),
      { ordered: false }
    ).catch(() => {});

    let reply = `✅ Imported: ${parsed.length}`;
    if (failed.length) reply += `\n❌ Skipped: ${failed.length}\n\nExamples skipped:\n${failed.slice(0, 5).join("\n")}`;
    reply += `\n\nSend more lines, or reply *done* to finish.`;
    return sendText(from, reply);
  }

  // ── Bulk expense input ─────────────────────────────────────────────────────

  // ── Bulk expense input (ENHANCED WITH NATURAL LANGUAGE) ───────────────────

// ── Bulk expense input (COMMA-SEPARATED FORMAT) ───────────────────────────

  if (biz && biz.sessionState === "bulk_expense_input" && !isMetaAction) {
    const textRaw = (text || "").trim();
    const textLower = textRaw.toLowerCase();

    // ✅ Handle empty input
    if (!textRaw) {
      await sendText(from, "❌ Type expenses separated by commas.\n\nExample: lunch 10, fuel 20, tea 5");
      return;
    }

    // ✅ Handle 'done' command
    if (textLower === "done" || textLower === "finish" || textLower === "save") {
      const expenseCount = biz.sessionData?.bulkExpenses?.length || 0;
      
      if (expenseCount === 0) {
        biz.sessionState = "ready"; 
        biz.sessionData = {};
        await saveBizSafe(biz);
        await sendText(from, "❌ No expenses to save.");
        return sendPaymentsMenu(from);
      }

      // Move to confirmation
      biz.sessionState = "bulk_expense_confirm";
      await saveBizSafe(biz);

      const { formatBulkSummary } = await import("./expenseParser.js");
      const cur = currencySymbol(biz.currency);
      const summary = formatBulkSummary(biz.sessionData.bulkExpenses, cur);
      
      await sendText(from, `${summary}\n*Confirm?* (yes/no)`);
      return;
    }

    // ✅ Handle 'cancel' command
    if (textLower === "cancel" || textLower === "stop") {
      const count = biz.sessionData?.bulkExpenses?.length || 0;
      biz.sessionState = "ready"; 
      biz.sessionData = {};
      await saveBizSafe(biz);
      await sendText(from, count > 0 
        ? `❌ Cancelled. Discarded ${count} expense(s).`
        : "❌ Cancelled.");
      return sendPaymentsMenu(from);
    }

    // ✅ Handle 'list' command
   // ✅ Handle 'list' command
    if (textLower === "list" || textLower === "show") {
      const expenses = biz.sessionData?.bulkExpenses || [];
      
      if (expenses.length === 0) {
        await sendText(from, "📝 No expenses yet.\n\nExample: lunch 10, fuel 20");
        return;
      }

      const expenseParser = await import("./expenseParser.js");
      const cur = currencySymbol(biz.currency);
      
      let list = `📝 *Current Expenses (${expenses.length})*\n\n`;
      list += expenseParser.formatExpenseList(expenses, 1, cur);
      const total = expenses.reduce((sum, exp) => sum + exp.amount, 0);
      list += `\n*Total: ${cur}${total.toFixed(2)}*\n\nType 'done' to save.`;
      
      await sendText(from, list);
      return;
    }

    // ✅ Handle 'remove N' command
   // ✅ Handle 'remove N' command
    const removeMatch = textLower.match(/^(?:remove|delete|clear)\s+(\d+)$/);
    if (removeMatch) {
      const index = parseInt(removeMatch[1]);
      const expenses = biz.sessionData?.bulkExpenses || [];
      
      if (index < 1 || index > expenses.length) {
        await sendText(from, `❌ Invalid. You have ${expenses.length} expense(s).\n\nType 'list' to see all.`);
        return;
      }
      
      const removed = expenses.splice(index - 1, 1)[0];
      await saveBizSafe(biz);
      
      const expenseParser = await import("./expenseParser.js");
      const cur = currencySymbol(biz.currency);
      const emoji = expenseParser.getCategoryEmoji(removed.category);
      
      await sendText(from, `✅ Removed: ${emoji} ${cur}${removed.amount.toFixed(2)} - ${removed.description}\n\n${expenses.length} expense(s) remaining.`);
      return;
    }
    // ✅ Handle 'clear' or 'clear all' command
    if (textLower === "clear" || textLower === "clear all" || textLower === "reset") {
      const count = biz.sessionData?.bulkExpenses?.length || 0;
      biz.sessionData.bulkExpenses = [];
      await saveBizSafe(biz);
      await sendText(from, `✅ Cleared ${count} expense(s).\n\nStart fresh: lunch 10, fuel 20`);
      return;
    }

    // ✅ Handle 'help' command
    if (textLower === "help" || textLower === "?") {
      await sendText(from,
`💡 *Bulk Expense Help*

*Format:*
description amount, description amount

*Examples:*
- lunch 10, fuel 20, tea 5
- office supplies 50
- transport 15, airtime 10

*Commands:*
- 'list' - Show all expenses
- 'remove 3' - Delete expense #3
- 'clear' - Remove all expenses
- 'done' - Save everything
- 'cancel' - Discard all

Categories auto-detected ✨`);
      return;
    }

    // ✅ PARSE COMMA-SEPARATED EXPENSES
   // ✅ PARSE COMMA-SEPARATED EXPENSES
    const expenseParser = await import("./expenseParser.js");
    const { parseBulkExpenseText, formatExpenseList, getCategoryEmoji: getExpenseCategoryEmoji } = expenseParser;
    
    const result = parseBulkExpenseText(textRaw);
    
    if (result.error || result.expenses.length === 0) {
      let errorMsg = `❌ ${result.error || "Couldn't parse expenses"}\n\n`;
      errorMsg += `*Format:* description amount, description amount\n`;
      errorMsg += `*Example:* lunch 10, fuel 20, tea 5\n\n`;
      if (result.failed && result.failed.length > 0) {
        errorMsg += `Failed to parse:\n${result.failed.slice(0, 3).join('\n')}`;
      }
      await sendText(from, errorMsg);
      return;
    }
    
    // Initialize expenses array if needed
    if (!biz.sessionData.bulkExpenses) {
      biz.sessionData.bulkExpenses = [];
    }
    
    // Add all parsed expenses
    const startIndex = biz.sessionData.bulkExpenses.length + 1;
    biz.sessionData.bulkExpenses.push(...result.expenses);
    await saveBizSafe(biz);
    
    const count = biz.sessionData.bulkExpenses.length;
    const total = biz.sessionData.bulkExpenses.reduce((sum, exp) => sum + exp.amount, 0);
    const cur = currencySymbol(biz.currency);
    
    // Build response
    let response = `✅ Added ${result.expenses.length} expense(s):\n\n`;
    response += formatExpenseList(result.expenses, startIndex, cur);
    response += `\n*Total: ${cur}${total.toFixed(2)}* (${count} items)\n\n`;
    
    if (result.failed && result.failed.length > 0) {
      response += `⚠️ Skipped ${result.failed.length}:\n${result.failed.slice(0, 2).join(', ')}\n\n`;
    }
    
    response += `Continue or type 'done' to save`;
    
    await sendText(from, response);
    return;
  }

  // ✅ Bulk expense confirmation (keep this unchanged)
  if (biz && biz.sessionState === "bulk_expense_confirm" && !isMetaAction) {
    const textLower = text.toLowerCase().trim();
    
    if (textLower === "yes" || textLower === "y" || textLower === "confirm") {
      const expenses = biz.sessionData?.bulkExpenses || [];
      
      if (expenses.length === 0) {
        biz.sessionState = "ready"; 
        biz.sessionData = {};
        await saveBizSafe(biz);
        await sendText(from, "❌ No expenses to save.");
        return sendPaymentsMenu(from);
      }
      
      try {
        const Expense = (await import("../models/expense.js")).default;
        const effectiveBranchId = getEffectiveBranchId(caller, biz.sessionData);
        
        // Save all expenses to database
        const expenseDocs = expenses.map(exp => ({
          businessId: biz._id,
          branchId: effectiveBranchId,
          amount: exp.amount,
          description: exp.description,
          category: exp.category,
          method: "Cash",
          createdBy: phone
        }));
        
        await Expense.insertMany(expenseDocs);
        
        // Clear session
        const count = expenses.length;
        const total = expenses.reduce((sum, exp) => sum + exp.amount, 0);
        const cur = currencySymbol(biz.currency);
        
        biz.sessionState = "ready"; 
        biz.sessionData = {};
        await saveBizSafe(biz);
        
        await sendText(from, `✅ *Success!*\n\nSaved ${count} expenses totaling ${cur}${total.toFixed(2)}`);
        return sendPaymentsMenu(from);
        
      } catch (error) {
        console.error('[Bulk Expense Save Error]', error);
        await sendText(from, `❌ Error: ${error.message}\n\nType 'yes' to retry or 'no' to cancel.`);
        return;
      }
    }
    
    if (textLower === "no" || textLower === "n" || textLower === "cancel") {
      const count = biz.sessionData?.bulkExpenses?.length || 0;
      biz.sessionState = "ready"; 
      biz.sessionData = {};
      await saveBizSafe(biz);
      await sendText(from, `❌ Cancelled. Discarded ${count} expense(s).`);
      return sendPaymentsMenu(from);
    }
    
    await sendText(from, `Reply 'yes' to save or 'no' to cancel.`);
    return;
  }

  // ✅ NEW STATE: Bulk expense confirmation
  if (biz && biz.sessionState === "bulk_expense_confirm" && !isMetaAction) {
    const textLower = text.toLowerCase().trim();
    
    if (textLower === "yes" || textLower === "y" || textLower === "confirm") {
      const expenses = biz.sessionData?.bulkExpenses || [];
      
      if (expenses.length === 0) {
        biz.sessionState = "ready"; 
        biz.sessionData = {};
        await saveBizSafe(biz);
        await sendText(from, "❌ No expenses to save.");
        return sendPaymentsMenu(from);
      }
      
      try {
        const Expense = (await import("../models/expense.js")).default;
        const effectiveBranchId = getEffectiveBranchId(caller, biz.sessionData);
        
        // Save all expenses to database
        const expenseDocs = expenses.map(exp => ({
          businessId: biz._id,
          branchId: effectiveBranchId,
          amount: exp.amount,
          description: exp.description,
          category: exp.category,
          method: exp.method || "Cash",
          createdBy: phone
        }));
        
        await Expense.insertMany(expenseDocs);
        
        // Clear session
        const count = expenses.length;
        const total = expenses.reduce((sum, exp) => sum + exp.amount, 0);
        const cur = currencySymbol(biz.currency);
        
        biz.sessionState = "ready"; 
        biz.sessionData = {};
        await saveBizSafe(biz);
        
        const { formatBulkSummary } = await import("./expenseParser.js");
        const summary = formatBulkSummary(expenses, cur);
        
        await sendText(from, `✅ *Success!*\n\nSaved ${count} expenses totaling ${cur}${total.toFixed(2)} to the system.\n\n${summary}\nType 'bulk expense' to add more.`);
        return sendPaymentsMenu(from);
        
      } catch (error) {
        console.error('[Bulk Expense Save Error]', error);
        await sendText(from, `❌ Error saving expenses: ${error.message}\n\nYour data is still here. Type 'yes' to retry or 'no' to cancel.`);
        return;
      }
    }
    
    if (textLower === "no" || textLower === "n" || textLower === "cancel") {
      const count = biz.sessionData?.bulkExpenses?.length || 0;
      biz.sessionState = "ready"; 
      biz.sessionData = {};
      await saveBizSafe(biz);
      await sendText(from, `❌ Cancelled. Discarded ${count} expense(s).`);
      return sendPaymentsMenu(from);
    }
    
    await sendText(from, `Please reply 'yes' to save or 'no' to cancel.`);
    return;
  }
  // ── Bulk paste products ────────────────────────────────────────────────────

  if (biz && biz.sessionState === "bulk_paste_input" && !isMetaAction) {
    const textRaw = (text || "").trim();

    if (!textRaw) { await sendText(from, "❌ Paste at least one product or type *done* to finish."); return; }

    if (textRaw.toLowerCase() === "done") {
      biz.sessionState = "ready"; biz.sessionData = {};
      await saveBizSafe(biz);
      await sendText(from, "✅ Bulk paste complete.");
      return sendProductsMenu(from);
    }

    const items = textRaw.split(/[|\n]/).map(i => i.trim()).filter(Boolean);
    const effectiveBranchId = getEffectiveBranchId(caller, biz.sessionData);
    let created = 0, skipped = 0;

    for (const item of items) {
      const parts = item.split(",").map(p => p.trim());
      if (parts.length < 2) { skipped++; continue; }
      const name = parts[0];
      const unitPrice = Number(parts[1]);
      if (!name || name.length < 2 || Number.isNaN(unitPrice) || unitPrice <= 0) { skipped++; continue; }

      await Product.create({ businessId: biz._id, branchId: effectiveBranchId, name, unitPrice, isActive: true });
      created++;
    }

    let reply = `✅ Imported *${created}* products`;
    if (skipped > 0) reply += `\n⚠️ Skipped *${skipped}* (invalid format)`;
    reply += `\n\nType more or reply *done* to finish.`;
    return sendText(from, reply);
  }

  // =========================
  // 🏢 ONBOARDING
  // =========================
  if (biz && biz.sessionState === "awaiting_business_name") {
    const name = text;
    if (!name || name.length < 2) { await sendText(from, "❌ Please enter a valid business name:"); return; }
    biz.name = name;
    biz.sessionState = "awaiting_address";
    await saveBizSafe(biz);
    await sendButtons(from, {
      text: "📍 Would you like to add your business address?\n(It will appear on invoices & receipts)",
      buttons: [{ id: "onb_address_yes", title: "Add address" }, { id: "onb_address_skip", title: "Skip" }]
    });
    return;
  }

  // ── Settings text states ───────────────────────────────────────────────────

const settingsStates = [
    "settings_currency", "settings_terms", "settings_inv_prefix",
    "settings_qt_prefix", "settings_rcpt_prefix", "settings_address", "bulk_upload_products",
    "awaiting_business_name", "awaiting_address_input", "awaiting_currency",
    "awaiting_logo", "awaiting_logo_upload"
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
      biz.sessionState = "ready"; biz.sessionData = {};
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
      businessId: biz._id, packageKey: selected, amount: chargeAmount,
      currency: plan.currency, reference, pollUrl: response.pollUrl,
      ecocashPhone, status: "pending"
    });

    if (!response.success) {
      biz.sessionState = "ready"; biz.sessionData = {};
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

        if (status.status && status.status.toLowerCase() === "paid") {
          clearInterval(pollInterval);
          const freshBiz = await Business.findById(biz._id);

          if (freshBiz?.sessionState === "subscription_payment_pending" && freshBiz.sessionData?.targetPackage) {
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

            const payRec = await SubscriptionPayment.findOne({ businessId: freshBiz._id, reference }).sort({ createdAt: -1 });
            const receiptNumber = `SUB-${reference.slice(-8).toUpperCase()}`;

            const { filename } = await generatePDF({
              type: "receipt", number: receiptNumber, date: now,
              billingTo: `${freshBiz.name} (Subscription)`,
              items: [{ item: `${plan.name} Package`, qty: 1, unit: payRec?.amount || plan.price, total: payRec?.amount || plan.price }],
              bizMeta: { name: "Zimqoute", logoUrl: "", address: "Zimqoute", _id: freshBiz._id.toString(), status: "paid" }
            });

            const site = (process.env.SITE_URL || "").replace(/\/$/, "");
            const receiptUrl = `${site}/docs/generated/receipts/${filename}`;

            if (payRec) {
              payRec.status = "paid"; payRec.paidAt = now;
              payRec.receiptFilename = filename; payRec.receiptUrl = receiptUrl;
              await payRec.save();
            }

            freshBiz.sessionState = "ready"; freshBiz.sessionData = {};
            await freshBiz.save();

            await sendDocument(from, { link: receiptUrl, filename });
            await sendText(from,
`✅ Payment successful!

Package: *${freshBiz.package.toUpperCase()}*
Next due date: *${freshBiz.subscriptionEndsAt ? freshBiz.subscriptionEndsAt.toDateString() : "N/A"}*`);
            await sendMainMenu(from);
          }
        }

        if (attempts >= MAX_ATTEMPTS) clearInterval(pollInterval);
      } catch (err) { console.error("Paynow polling failed:", err); }
    }, 10000);

    await sendText(from, `💳 ${plan.name} Package (${chargeAmount} ${plan.currency})\nEcoCash number: ${ecocashPhone}\n\nPlease confirm the payment on your phone.`);
    return;
  }

  // ── Pass text to Twilio state machine ─────────────────────────────────────

const escapeWords = ["menu", "hi", "hello", "start", "cancel"];

  // Pass supplier registration states to the state bridge
const supplierStates = [
  "supplier_reg_name", "supplier_reg_area", "supplier_reg_products",
  "supplier_reg_prices", "supplier_update_prices",
  "supplier_edit_products", "supplier_edit_area",
  "supplier_reg_minorder", "supplier_reg_confirm", "supplier_reg_enter_ecocash",
  "supplier_reg_payment_pending", "supplier_search_city", "supplier_decline_reason",
  "supplier_reg_type",
  "supplier_reg_travel",
  "supplier_search_product",
  "supplier_order_product",
  "supplier_order_address",
  "supplier_order_enter_price",
  "supplier_order_picking",   // ← ADD: new cart browsing state
];

// ── Shortcode search for any user (runs BEFORE state machine) ─────────────
// supplier_search_city is excluded from the block - typed text in that state
// should be treated as a new shortcode search, not passed to the state machine
const shortcodeBlockedStates = supplierStates.filter(s => 
  s !== "supplier_search_city" && 
  s !== "supplier_order_product" && 
  s !== "supplier_order_address" &&
  s !== "supplier_order_enter_price" &&
   s !== "supplier_order_picking" 
);
if (!isMetaAction && biz && text.trim().length > 2 && !shortcodeBlockedStates.includes(biz.sessionState) && !settingsStates.includes(biz.sessionState)) {
  const shortcode = parseShortcodeSearch(text);
  if (shortcode) {
    if (shortcode.city) {
      const results = await runSupplierSearch({
        city: shortcode.city,
        product: shortcode.product
      });
      if (results.length) {
        const rows = formatSupplierResults(results, shortcode.city, shortcode.product);
        return sendList(from, `🔍 *${shortcode.product}* in ${shortcode.city} - ${results.length} found`, rows);
      }
    }
    biz.sessionData = {
      ...(biz.sessionData || {}),
      supplierSearch: { product: shortcode.product }
    };
    biz.sessionState = "supplier_search_city";
    await saveBizSafe(biz);
    return sendList(from, `🔍 Looking for: *${shortcode.product}*\n\nWhich city?`, [
      ...SUPPLIER_CITIES.map(c => ({
        id: `sup_search_city_${c.toLowerCase()}`,
        title: c
      })),
      { id: "sup_search_city_all", title: "📍 All Cities" }
    ]);
  }
}


if (!isMetaAction && biz && biz.sessionState && !escapeWords.includes(al) && !settingsStates.includes(biz.sessionState)) {
    if (al === "cancel" && supplierStates.includes(biz.sessionState)) {
      biz.sessionState = "ready";
      biz.sessionData = {};
      await saveBizSafe(biz);
      await sendText(from, "❌ Registration cancelled. Sending you back to the main menu.");
      return sendMainMenu(from);
    }

    // ── If in supplier_search_city state and user types a shortcode, treat as new search ──
    if (biz.sessionState === "supplier_search_city" && !isMetaAction) {
      const shortcode = parseShortcodeSearch(text);
      if (shortcode) {
        if (shortcode.city) {
          const results = await runSupplierSearch({ city: shortcode.city, product: shortcode.product });
          if (results.length) {
            biz.sessionState = "ready";
            biz.sessionData = {};
            await saveBizSafe(biz);
            const rows = formatSupplierResults(results, shortcode.city, shortcode.product);
            return sendList(from, `🔍 *${shortcode.product}* in ${shortcode.city} - ${results.length} found`, rows);
          }
        }
        biz.sessionData = { ...(biz.sessionData || {}), supplierSearch: { product: shortcode.product } };
        biz.sessionState = "supplier_search_city";
        await saveBizSafe(biz);
        return sendList(from, `🔍 Looking for: *${shortcode.product}*\n\nWhich city?`, [
          ...SUPPLIER_CITIES.map(c => ({ id: `sup_search_city_${c.toLowerCase()}`, title: c })),
          { id: "sup_search_city_all", title: "📍 All Cities" }
        ]);
      }
      // Not a shortcode but in supplier_search_city - treat the typed text as the product name directly
      const productQuery = text.trim();
      if (productQuery.length > 1) {
        biz.sessionData = { ...(biz.sessionData || {}), supplierSearch: { product: productQuery } };
        biz.sessionState = "supplier_search_city";
        await saveBizSafe(biz);
        return sendList(from, `🔍 Looking for: *${productQuery}*\n\nWhich city?`, [
          ...SUPPLIER_CITIES.map(c => ({ id: `sup_search_city_${c.toLowerCase()}`, title: c })),
          { id: "sup_search_city_all", title: "📍 All Cities" }
        ]);
      }
    }

    if (supplierStates.includes(biz.sessionState)) {
      const handled = await handleSupplierRegistrationStates({
        state: biz.sessionState, from, text, biz, saveBiz: saveBizSafe
      });
      if (handled) return;
    }

    // Only pass to Twilio for real businesses - ghost supplier biz returns "Access denied"
  
   // Only pass to Twilio for real businesses - ghost supplier biz returns "Access denied"
    if (!biz.name?.startsWith("pending_supplier_")) {
      const handled = await continueTwilioFlow({ from, text });
      if (handled) return;
    } else {
      // ── If ghost biz user is mid-order, let order handlers below process it ──
      if (
        biz.sessionState === "supplier_order_product" ||
        biz.sessionState === "supplier_order_address" ||
        biz.sessionState === "supplier_order_enter_price" ||
          biz.sessionState === "supplier_order_picking"   // ← ADD
      ) {
        // Do nothing here — fall through to the order state handlers below
      } else {
        // Ghost biz user typed something unrecognised - try as a search first
        const shortcode = parseShortcodeSearch(text);
        if (shortcode) {
          if (shortcode.city) {
            const results = await runSupplierSearch({ city: shortcode.city, product: shortcode.product });
            if (results.length) {
              const rows = formatSupplierResults(results, shortcode.city, shortcode.product);
              return sendList(from, `🔍 *${shortcode.product}* in ${shortcode.city} - ${results.length} found`, rows);
            }
          }
          biz.sessionData = { ...(biz.sessionData || {}), supplierSearch: { product: shortcode.product } };
          biz.sessionState = "supplier_search_city";
          await saveBizSafe(biz);
          return sendList(from, `🔍 Looking for: *${shortcode.product}*\n\nWhich city?`, [
            ...SUPPLIER_CITIES.map(c => ({ id: `sup_search_city_${c.toLowerCase()}`, title: c })),
            { id: "sup_search_city_all", title: "📍 All Cities" }
          ]);
        }
        // Truly unrecognised - show helpful prompt
        return sendButtons(from, {
          text: `🔍 *Looking for something?*\n\nTry:\n_find cement_\n_find plumber harare_\n_find teacher_\n_find car hire bulawayo_\n\nOr type *menu* to see all options.`,
          buttons: [
            { id: "find_supplier", title: "🔍 Find Suppliers" },
            { id: "register_supplier", title: "📦 List My Business" }
          ]
        });
      }
    }
  
  }

  if (
  biz &&
  !isMetaAction &&
  al === "cancel" &&
  (biz.sessionState === "supplier_order_product" || biz.sessionState === "supplier_order_address")
) {
  biz.sessionState = "ready";
  biz.sessionData = {};
  await saveBizSafe(biz);

  await sendText(from, "❌ Order cancelled.");
return sendButtons(from, {
  text: "What would you like to do next?",
  buttons: [
    { id: "find_supplier", title: "🔍 Find Suppliers" },
    { id: "my_orders", title: "📋 My Orders" },
    { id: "onboard_business", title: "🧾 Run My Business" }
  ]
});
}


// ── Shortcode search for any user ─────────────────────────────────────────


if (escapeWords.includes(al)) {
    if (!biz || biz.name?.startsWith("pending_supplier_")) {
      // Clear supplier reg state if mid-flow
      if (biz?.name?.startsWith("pending_supplier_")) {
        biz.sessionState = "ready";
        biz.sessionData = {};
        await saveBizSafe(biz);
      }
      return sendMainMenu(from);
    }
    biz.sessionState = "ready"; biz.sessionData = {};
    await saveBizSafe(biz);
    return sendMainMenu(from);
  }

  // =========================
  // 📍 ONBOARDING: ADDRESS
  // =========================
  if (biz && biz.sessionState === "awaiting_address") {
    if (a === "onb_address_yes") {
      biz.sessionState = "awaiting_address_input"; await saveBizSafe(biz);
      return sendText(from, "Please enter your business address:");
    }
    if (a === "onb_address_skip") {
      biz.address = ""; biz.sessionState = "awaiting_currency"; await saveBizSafe(biz);
      return sendButtons(from, {
        text: "💱 Select your business currency",
        buttons: [{ id: "onb_currency_USD", title: "USD ($)" }, { id: "onb_currency_ZWL", title: "ZWL (Z$)" }, { id: "onb_currency_ZAR", title: "ZAR (R)" }]
      });
    }
  }

  if (biz && biz.sessionState === "awaiting_address_input" && !isMetaAction) {
    if (!text || text.length < 3) return sendText(from, "Please enter a valid address:");
    biz.address = text; biz.sessionState = "awaiting_currency"; await saveBizSafe(biz);
    return sendButtons(from, {
      text: "💱 Select your business currency",
      buttons: [{ id: "onb_currency_USD", title: "USD ($)" }, { id: "onb_currency_ZWL", title: "ZWL (Z$)" }, { id: "onb_currency_ZAR", title: "ZAR (R)" }]
    });
  }

  if (biz && biz.sessionState === "awaiting_currency" && a.startsWith("onb_currency_")) {
    const currency = a.replace("onb_currency_", "").toUpperCase();
    if (!["USD", "ZWL", "ZAR"].includes(currency)) { await sendText(from, "❌ Invalid currency selection."); return; }
    biz.currency = currency; biz.sessionState = "awaiting_logo"; await saveBizSafe(biz);
    await sendButtons(from, {
      text: "🖼 Would you like to add your business logo now?",
      buttons: [{ id: "onb_logo_yes", title: "📷 Upload Logo" }, { id: "onb_logo_skip", title: "Skip for now" }]
    });
    return;
  }

  if (biz && biz.sessionState === "awaiting_logo") {
    if (a === "onb_logo_yes") { biz.sessionState = "awaiting_logo_upload"; await saveBizSafe(biz); await sendText(from, "📷 Please send your logo image (PNG or JPG).\nYou can also type *skip* to continue without a logo."); return; }
    if (a === "onb_logo_skip") { biz.sessionState = "ready"; await saveBizSafe(biz); await sendText(from, "✅ Setup complete!\n\nYour business is ready to use 🚀"); return sendMainMenu(from); }
  }

  if (biz && biz.sessionState === "awaiting_logo_upload") {
    if (text && text.toLowerCase() === "skip") {
      const mainBranch = await Branch.create({ businessId: biz._id, name: "Main Branch", isDefault: true });
      await UserRole.findOneAndUpdate({ businessId: biz._id, phone, role: "owner" }, { branchId: mainBranch._id });
      biz.sessionState = "ready"; await saveBizSafe(biz);
      await sendText(from, "✅ Setup complete!\n\n🏢 Main Branch created and assigned to you.");
      return sendMainMenu(from);
    }
    if (biz.logoUrl) {
      const mainBranch = await Branch.create({ businessId: biz._id, name: "Main Branch", isDefault: true });
      await UserRole.findOneAndUpdate({ businessId: biz._id, phone, role: "owner" }, { branchId: mainBranch._id });
      biz.sessionState = "ready"; await saveBizSafe(biz);
      await sendText(from, "✅ Setup complete!\n\n🏢 Main Branch created and assigned to you.");
      return sendMainMenu(from);
    }
    return;
  }

  if (a.startsWith("invite_branch_")) {
    const branchId = a.replace("invite_branch_", "");
    if (!biz) return sendMainMenu(from);
    biz.sessionState = "invite_user_phone"; biz.sessionData.branchId = branchId; await saveBizSafe(biz);
    return sendButtons(from, { text: "📱 *Enter WhatsApp number of the user to invite:*\n\nFormat: 0772123456", buttons: [{ id: ACTIONS.MAIN_MENU, title: "🏠 Main Menu" }] });
  }

  if (a.startsWith("assign_user_")) {
    const userId = a.replace("assign_user_", "");
    if (!biz) return sendMainMenu(from);
    const branches = await Branch.find({ businessId: biz._id }).lean();
    if (!branches.length) { await sendText(from, "No branches found."); return sendMainMenu(from); }
    biz.sessionData.userId = userId; biz.sessionState = "assign_branch_pick_branch"; await saveBizSafe(biz);
    return sendList(from, "Select branch", branches.map(b => ({ id: `assign_branch_${b._id}`, title: b.name })));
  }

  if (a.startsWith("assign_branch_")) {
    if (!biz || biz.sessionState !== "assign_branch_pick_branch") return;
    const branchId = a.replace("assign_branch_", "");
    const userId = biz.sessionData.userId;
    if (!userId) { await sendText(from, "⚠️ No user selected."); return sendMainMenu(from); }
    await UserRole.findByIdAndUpdate(userId, { branchId });
    biz.sessionState = "ready"; biz.sessionData = {}; await saveBizSafe(biz);
    await sendText(from, "✅ User successfully assigned to branch.");
    return sendMainMenu(from);
  }

  // ── Settings actions ───────────────────────────────────────────────────────

  if (a === ACTIONS.SETTINGS_INV_PREFIX) {
    if (!biz) return sendMainMenu(from);
    biz.sessionState = "settings_inv_prefix"; await saveBizSafe(biz);
    return sendButtons(from, { text: `Current invoice prefix: *${biz.invoicePrefix || "INV"}*\n\nReply with new prefix:`, buttons: [{ id: ACTIONS.MAIN_MENU, title: "🏠 Main Menu" }] });
  }
  if (a === ACTIONS.SETTINGS_QT_PREFIX) {
    if (!biz) return sendMainMenu(from);
    biz.sessionState = "settings_qt_prefix"; await saveBizSafe(biz);
    return sendButtons(from, { text: `Current quote prefix: *${biz.quotePrefix || "QT"}*\n\nReply with new prefix:`, buttons: [{ id: ACTIONS.MAIN_MENU, title: "🏠 Main Menu" }] });
  }
  if (a === ACTIONS.SETTINGS_RCPT_PREFIX) {
    if (!biz) return sendMainMenu(from);
    biz.sessionState = "settings_rcpt_prefix"; await saveBizSafe(biz);
    return sendButtons(from, { text: `Current receipt prefix: *${biz.receiptPrefix || "RCPT"}*\n\nReply with new prefix:`, buttons: [{ id: ACTIONS.MAIN_MENU, title: "🏠 Main Menu" }] });
  }
  if (a === ACTIONS.SETTINGS_CURRENCY) {
    if (!biz) return sendMainMenu(from);
    biz.sessionState = "settings_currency"; await saveBizSafe(biz);
    return sendButtons(from, { text: `Current currency: *${biz.currency}*\n\nReply with new currency (USD, ZWL, ZAR):`, buttons: [{ id: ACTIONS.MAIN_MENU, title: "🏠 Main Menu" }] });
  }
  if (a === ACTIONS.SETTINGS_TERMS) {
    if (!biz) return sendMainMenu(from);
    biz.sessionState = "settings_terms"; await saveBizSafe(biz);
    return sendButtons(from, { text: `Current payment terms: *${biz.paymentTermsDays || 0} days*\n\nReply with number of days:`, buttons: [{ id: ACTIONS.MAIN_MENU, title: "🏠 Main Menu" }] });
  }
  if (a === ACTIONS.SETTINGS_ADDRESS) {
    if (!biz) return sendMainMenu(from);
    biz.sessionState = "settings_address"; await saveBizSafe(biz);
    return sendButtons(from, { text: `Current address:\n${biz.address || "Not set"}\n\nReply with new address:`, buttons: [{ id: ACTIONS.MAIN_MENU, title: "🏠 Main Menu" }] });
  }

  if (biz?.sessionState === "settings_address" && !isMetaAction) {
    const addr = (text || "").trim();
    if (!addr || addr.length < 3) { await sendText(from, "❌ Please enter a valid address:"); return; }
    biz.address = addr; biz.sessionState = "ready"; biz.sessionData = {};
    await saveBizSafe(biz);
    await sendText(from, "✅ Address updated successfully.");
    return sendSettingsMenu(from);
  }

  if (a === ACTIONS.SETTINGS_LOGO) {
    if (!biz) return sendMainMenu(from);
    biz.sessionState = "awaiting_logo_upload"; await saveBizSafe(biz);
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
    biz.sessionState = "client_statement_generate"; biz.sessionData = { clientId };
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

    let chargeAmount = plan.price, note = "";

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
    biz.sessionData = { targetPackage: selected, amount: chargeAmount, prorationNote: note || null, previousPackage: currentKey, cycleEndsAt: endsAt ? endsAt.toISOString() : null };
    await saveBizSafe(biz);

    const pkg = PACKAGES[selected];
    const MAP = {
      invoice: "Invoices", quote: "Quotations", receipt: "Receipts",
      clients: "Clients", payments: "Payments",
      reports_daily: "Daily reports", reports_weekly: "Weekly reports", reports_monthly: "Monthly reports",
      branches: "Branches management", users: "User management"
    };
    const featureLines = (pkg?.features || []).map(f => `• ${MAP[f] || f}`);

    return sendText(from,
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

Or type *same* to use this WhatsApp number.`);
  }

  // ── Sales document actions ─────────────────────────────────────────────────

  if (a.startsWith("doc_") && a !== ACTIONS.VIEW_DOC && a !== ACTIONS.DELETE_DOC) {
    const docId = a.replace("doc_", "");
    if (!biz) return sendMainMenu(from);
    const doc = await Invoice.findById(docId);
    if (!doc) { await sendText(from, "Document not found."); return sendSalesMenu(from); }

    biz.sessionState = "sales_doc_action"; biz.sessionData = { docId };
    await saveBizSafe(biz);

    const buttons = [{ id: ACTIONS.VIEW_DOC, title: "📄 View PDF" }];
    if (caller && ["owner", "manager"].includes(caller.role)) {
      buttons.push({ id: ACTIONS.DELETE_DOC, title: "🗑 Delete" });
    }
    buttons.push({ id: ACTIONS.MAIN_MENU, title: "🏠 Main Menu" });
    buttons.push({ id: ACTIONS.BACK, title: "⬅ Back to List" });

    return sendButtons(from, { text: `📄 ${doc.number}\nStatus: ${doc.status}`, buttons });
  }

  if (a === ACTIONS.VIEW_DOC) {
    if (!biz?.sessionData?.docId) { await sendText(from, "❌ No document selected."); return sendSalesMenu(from); }
    const doc = await Invoice.findById(biz.sessionData.docId).lean();
    if (!doc) { await sendText(from, "❌ Document not found."); return sendSalesMenu(from); }
    const Client = (await import("../models/client.js")).default;
    const client = await Client.findById(doc.clientId).lean();
    if (!client) { await sendText(from, "❌ Client not found."); return sendSalesMenu(from); }

    const { filename } = await generatePDF({
      type: doc.type, number: doc.number, date: doc.createdAt || new Date(),
      billingTo: client.name || client.phone, items: doc.items,
      bizMeta: { name: biz.name, logoUrl: biz.logoUrl, address: biz.address || "", discountPercent: doc.discountPercent || 0, vatPercent: doc.vatPercent || 0, applyVat: doc.type === "receipt" ? false : true, _id: biz._id.toString(), status: doc.status }
    });

    const site = (process.env.SITE_URL || "").replace(/\/$/, "");
    const folder = doc.type === "invoice" ? "invoices" : doc.type === "quote" ? "quotes" : "receipts";
    const url = `${site}/docs/generated/${folder}/${filename}`;
    await sendDocument(from, { link: url, filename });
    biz.sessionState = "ready"; biz.sessionData = {}; await saveBizSafe(biz);
    return;
  }

  if (a === ACTIONS.DELETE_DOC) {
    if (!biz?.sessionData?.docId) { await sendText(from, "❌ No document selected."); return sendSalesMenu(from); }
    if (!caller || !["owner", "manager"].includes(caller.role)) { await sendText(from, "🔒 Only managers and owners can delete documents."); return sendSalesMenu(from); }
    const doc = await Invoice.findById(biz.sessionData.docId);
    if (!doc) { await sendText(from, "❌ Document not found."); return sendSalesMenu(from); }
    if (doc.status === "paid") { await sendText(from, "❌ Paid documents cannot be deleted."); return sendSalesMenu(from); }
    await Invoice.deleteOne({ _id: doc._id });
    biz.sessionState = "ready"; biz.sessionData = {}; await saveBizSafe(biz);
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
    const cashAction = biz.sessionData?.cashBalAction;
    if (!cashAction) return sendMainMenu(from);

    biz.sessionData.targetBranchId = targetBranchId;

    if (cashAction === "set_opening") {
      biz.sessionState = "cash_set_opening_balance"; await saveBizSafe(biz);
      return sendButtons(from, { text: "📝 *Set Opening Balance*\n\nEnter the opening cash amount:", buttons: [{ id: ACTIONS.MAIN_MENU, title: "🏠 Main Menu" }] });
    }
    if (cashAction === "payout") {
      biz.sessionState = "cash_payout_amount"; await saveBizSafe(biz);
      return sendButtons(from, { text: "💸 *Record Payout*\n\nEnter payout amount:", buttons: [{ id: ACTIONS.MAIN_MENU, title: "🏠 Main Menu" }] });
    }
    if (cashAction === "view") {
      return showBranchCashBalance(from, biz, targetBranchId);
    }
    return sendMainMenu(from);
  }

  // ─────────────────────────────────────────────────────────────────────────

 // ─────────────────────────────────────────────────────────────────────────
  // 🏪 SUPPLIER PLATFORM ACTION HANDLERS
  // ─────────────────────────────────────────────────────────────────────────

// ── Supplier home - safe back button for supplier flows ───────────────────
  if (a === "suppliers_home") {
    return sendSuppliersMenu(from);
  }


  
  // ── Welcome screen: user chose "Run My Business" ──────────────────────────
  if (a === "onboard_business") {
    return startOnboarding(from, phone);
  }

  // ── Welcome screen: Find Suppliers or register ────────────────────────────
if (a === "find_supplier") {
  // Clear previous search state
  if (biz) {
    biz.sessionData = {
      ...(biz.sessionData || {}),
      supplierSearch: {}
    };
    biz.sessionState = "supplier_search_product";
    await saveBizSafe(biz);
  } else {
    await UserSession.findOneAndUpdate(
      { phone },
      {
        $set: { "tempData.supplierSearchMode": "product" },
        $unset: {
          "tempData.supplierSearchCategory": "",
          "tempData.supplierSearchProduct": "",
          "tempData.supplierSearchType": ""
        }
      },
      { upsert: true }
    );
  }

return sendText(from,
`🔍 *Find Suppliers on ZimQuote*

Type what you need and send it. You can include a city at the end.

*📦 Products:*
_find cement_, _find cooking oil harare_, _find mealie meal_, _find river sand_, _find tyres bulawayo_, _find school uniforms_, _find solar panels_

*🔧 Services:*
_find plumber_, _find electrician harare_, _find teacher_, _find tutor_, _find cleaner bulawayo_, _find painter_, _find welder_, _find catering_, _find photographer_, _find it support_

*🚗 Transport:*
_find car hire_, _find delivery harare_, _find moving company bulawayo_

Or pick a category 👇`,
  ).then(() => sendList(from, "📂 Or browse by category:", [
    { id: "sup_search_type_product", title: "📦 Products" },
    { id: "sup_search_type_service", title: "🔧 Services" }
  ]));
}

if (a === "sup_search_type_product" || a === "sup_search_type_service") {
  const searchType = a === "sup_search_type_service" ? "service" : "product";
  const filteredCategories = getSupplierCategoriesForType(searchType);

  if (biz) {
    biz.sessionData = {
      ...(biz.sessionData || {}),
      supplierSearch: {
        ...(biz.sessionData?.supplierSearch || {}),
        type: searchType
      }
    };
    await saveBizSafe(biz);
  } else {
    await UserSession.findOneAndUpdate(
      { phone },
      { $set: { "tempData.supplierSearchType": searchType } },
      { upsert: true }
    );
  }

 const categoryRows = [
  ...filteredCategories.slice(0, 8).map(c => ({
    id: `sup_search_cat_${c.id}`,
    title: c.label
  })),
  {
    id: "sup_search_all",
    title: searchType === "service" ? "🔍 Search by service name" : "🔍 Search by product name"
  },
  ...(filteredCategories.length > 8
    ? [{ id: "sup_search_more_categories", title: "➕ More Categories" }]
    : [])
];

  return sendList(
    from,
    searchType === "service"
      ? "🔧 Choose a service category"
      : "📦 Choose a product category",
    categoryRows
  );
}

if (a === "sup_search_more_categories") {
  let searchType = biz?.sessionData?.supplierSearch?.type || null;

  if (!searchType) {
    const sess = await UserSession.findOne({ phone });
    searchType = sess?.tempData?.supplierSearchType || "product";
  }

  const filteredCategories = getSupplierCategoriesForType(searchType);

  return sendList(from, "🔍 More Categories", [
    ...filteredCategories.slice(9).map(c => ({
      id: `sup_search_cat_${c.id}`,
      title: c.label
    })),
    { id: "find_supplier", title: "⬅ Back" }
  ]);
}

if (a === "register_supplier") {
  const existingSupplier = await SupplierProfile.findOne({ phone });

  if (existingSupplier) {
    if (existingSupplier.active) {
      return sendSupplierAccountMenu(from, existingSupplier);
    }
    const isComplete = Boolean(
      existingSupplier.businessName &&
      existingSupplier.location?.city &&
      existingSupplier.location?.area &&
      Array.isArray(existingSupplier.categories) && existingSupplier.categories.length > 0 &&
      Array.isArray(existingSupplier.products) && existingSupplier.products.length > 0 &&
      existingSupplier.delivery &&
      typeof existingSupplier.delivery.available === "boolean" &&
      typeof existingSupplier.minOrder === "number"
    );
    if (isComplete) {
      return sendSupplierUpgradeMenu(from, existingSupplier.tier);
    }
    return startSupplierRegistration(from, biz);
  }

  // No supplier profile yet - create pending business and start registration
  if (!biz) {
    const newBiz = await Business.create({
      name: "pending_supplier_" + phone,
      currency: "USD",
      package: "trial",
      subscriptionStatus: "inactive",
      sessionState: "supplier_reg_name",
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

    return startSupplierRegistration(from, newBiz);
  }

  return startSupplierRegistration(from, biz);
}

 if (a === "my_supplier_account") {
  const supplier = await SupplierProfile.findOne({ phone });
  if (!supplier) return sendSuppliersMenu(from);

  // Gate: must have paid to access account features
  if (!supplier.active) {
    const isComplete = Boolean(
      supplier.businessName &&
      supplier.products?.length > 0
    );

    if (!isComplete) {
      await sendText(from,
`⚠️ *Your registration is incomplete.*

Let's finish setting up your listing first.`
      );
      return startSupplierRegistration(from, biz);
    }

    await sendText(from,
`🔒 *Listing not yet active.*

Your profile is saved but buyers cannot find you yet. Choose a plan to go live and unlock your full account.`
    );
    return sendSupplierUpgradeMenu(from, supplier.tier);
  }

  return sendSupplierAccountMenu(from, supplier);
}


  // ── Buyer: My Orders list ─────────────────────────────────────────────────
  if (a === "my_orders") {
    const orders = await SupplierOrder.find({ buyerPhone: phone })
      .sort({ createdAt: -1 })
      .limit(10)
      .populate("supplierId", "businessName");

    if (!orders.length) {
      return sendButtons(from, {
        text: "📋 *My Orders*\n\nNo orders yet.",
        buttons: [
          { id: "find_supplier", title: "🔍 Find Suppliers" },
          { id: "suppliers_home", title: "🏪 Suppliers" }
        ]
      });
    }

    const si = { pending: "⏳", accepted: "✅", declined: "❌", completed: "🏁" };
    const rows = orders.map(o => ({
      id: `order_detail_${o._id}`,
      title: o.supplierId?.businessName || "Supplier",
      description: `${o.items?.[0]?.product || ""} · ${si[o.status] || "⏳"} ${o.status} · ${new Date(o.createdAt).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}`
    }));

   return sendList(from, "📋 My Placed Orders (as Buyer)", rows);
  }

  // ── Buyer: Order detail ───────────────────────────────────────────────────
  if (a.startsWith("order_detail_")) {
    const orderId = a.replace("order_detail_", "");
    const order = await SupplierOrder.findById(orderId).populate("supplierId", "businessName phone");
    if (!order) {
      return sendButtons(from, {
        text: "❌ Order not found.",
        buttons: [{ id: "my_orders", title: "⬅ Back" }]
      });
    }

    const si = { pending: "⏳", accepted: "✅", declined: "❌", completed: "🏁" };
    const itemLines = (order.items || []).map(i => `• ${i.product} x${i.quantity}`).join("\n");
    const msg = [
      `📋 *Order Details*`,
      `Supplier: ${order.supplierId?.businessName || "Unknown"}`,
      ``,
      `${itemLines}`,
      ``,
      `Delivery: ${order.delivery?.address || "Collection"}`,
      `Status: ${si[order.status] || "⏳"} ${order.status}`,
      `Date: ${new Date(order.createdAt).toLocaleDateString()}`
    ].join("\n");

    const btns = [];
    if (order.status === "completed" && !order.buyerRating) {
      btns.push({ id: `rate_order_${order._id}`, title: "⭐ Rate Order" });
    }
    btns.push({ id: "my_orders", title: "⬅ My Orders" });
    if (btns.length < 3) btns.push({ id: "suppliers_home", title: "🏪 Suppliers" });

    return sendButtons(from, { text: msg, buttons: btns });
  }
  // ── Supplier account menu actions ─────────────────────────────────────────

 if (a === "sup_edit_products") {
  const supplier = await SupplierProfile.findOne({ phone });
  if (!supplier) return sendSuppliersMenu(from);

  if (!supplier.active) {
    await sendText(from, "🔒 *Activate your listing first.*\n\nYou can edit products after your listing is live.");
    return sendSupplierUpgradeMenu(from, supplier.tier);
  }

  if (biz) {
    biz.sessionState = "supplier_edit_products";
      await saveBizSafe(biz);
    }
    const current = supplier.products?.join(", ") || "none listed";
    return sendButtons(from, {
      text: `✏️ *Edit Products*\n\nCurrent products:\n${current}\n\nSend your updated product list, comma-separated:\n\nExample: cooking oil, rice, sugar, flour`,
      buttons: [{ id: "my_supplier_account", title: "🏪 My Account" }]
    });
  }

 if (a === "sup_toggle_delivery") {
  const supplier = await SupplierProfile.findOne({ phone });
  if (!supplier) return sendSuppliersMenu(from);

  if (!supplier.active) {
    await sendText(from, "🔒 *Activate your listing first.*");
    return sendSupplierUpgradeMenu(from, supplier.tier);
  }

  const newVal = !supplier.delivery?.available;
    supplier.delivery = { ...(supplier.delivery || {}), available: newVal };
    await supplier.save();
    await sendText(from, newVal
      ? "✅ Delivery enabled. Buyers can now request delivery."
      : "✅ Set to collection only.");
    return sendSupplierAccountMenu(from, supplier);
  }

  if (a === "sup_toggle_active") {
    const supplier = await SupplierProfile.findOne({ phone });
    if (!supplier) return sendSuppliersMenu(from);
    if (!supplier.active && !supplier.tier) {
      return sendButtons(from, {
        text: "⚠️ You need an active subscription to go live.\n\nChoose a plan to activate your listing:",
        buttons: [
          { id: "sup_upgrade_plan", title: "⬆️ Choose Plan" },
          { id: "my_supplier_account", title: "🏪 My Account" }
        ]
      });
    }
    supplier.active = !supplier.active;
    await supplier.save();
    await sendText(from, supplier.active
      ? "✅ Your listing is now *active*. Buyers can find you!"
      : "⏸ Your listing is now *hidden* from search results.");
    return sendSupplierAccountMenu(from, supplier);
  }

if (a === "sup_edit_area") {
  const supplier = await SupplierProfile.findOne({ phone });
  if (!supplier) return sendSuppliersMenu(from);

  if (!supplier.active) {
    await sendText(from, "🔒 *Activate your listing first.*");
    return sendSupplierUpgradeMenu(from, supplier.tier);
  }

  if (biz) {
    biz.sessionState = "supplier_edit_area";
      await saveBizSafe(biz);
    }
   return sendText(from,
`📍 *Edit Location*

Current: ${supplier.location?.area || "not set"}, ${supplier.location?.city || ""}

Send your area/suburb name:
Example: *Avondale, Bulawayo*

_Type *cancel* to go back to your account._`
    );
  }

 if (a === "sup_my_orders") {
  const supplier = await SupplierProfile.findOne({ phone });
  if (!supplier) return sendSuppliersMenu(from);

  // Gate: must be active to see incoming orders
  if (!supplier.active) {
    await sendText(from,
`🔒 *Activate your listing first.*

Once your listing is live, buyers will start sending you orders. Choose a plan to activate.`
    );
    return sendSupplierUpgradeMenu(from, supplier.tier);
  }

  const SupplierOrder = (await import("../models/supplierOrder.js")).default;
  const orders = await SupplierOrder.find({ supplierId: supplier._id })
  // ... rest of the handler unchanged
      .sort({ createdAt: -1 })
      .limit(10)
      .lean();

    if (!orders.length) {
      return sendButtons(from, {
        text: "📦 *Orders From Buyers*\n\nNo orders yet. Make sure your listing is active so buyers can find you!",

        buttons: [{ id: "my_supplier_account", title: "🏪 My Account" }]
      });
    }

    const lines = orders.map((o) => {
      const statusIcon = {
        pending: "⏳",
        accepted: "✅",
        declined: "❌",
        completed: "🏁"
      }[o.status] || "•";

      const date = new Date(o.createdAt).toLocaleDateString("en-GB", {
        day: "numeric",
        month: "short"
      });

      const orderRef = String(o._id).slice(-6).toUpperCase();

      const itemSummary = Array.isArray(o.items) && o.items.length
        ? o.items.map(item => {
            const name = item.product || "Item";
            const qty = item.quantity ?? 1;
            const unitSuffix = item.unit && item.unit !== "units" ? ` ${item.unit}` : "";
            const lineTotal = typeof item.total === "number" ? ` - $${item.total.toFixed(2)}` : "";
            return `• ${name} x${qty}${unitSuffix}${lineTotal}`;
          }).join("\n")
        : "• Order items not available";

      const amount = typeof o.totalAmount === "number" ? o.totalAmount : 0;

      const deliveryLine = o.delivery?.required
        ? `🚚 Delivery: ${o.delivery.address || "Address not provided"}`
        : "🏠 Collection";

      return `${statusIcon} *Order #${orderRef}* (${date})
${itemSummary}
${deliveryLine}
💵 Total: $${amount.toFixed(2)}
📌 Status: ${o.status}`;
    }).join("\n\n");

    return sendButtons(from, {
   text: `📦 *Incoming Orders (From Buyers)* - last ${orders.length}\n\n${lines}`,

      buttons: [{ id: "my_supplier_account", title: "🏪 My Account" }]
    });
  }

if (a === "sup_my_earnings") {
  const supplier = await SupplierProfile.findOne({ phone });
  if (!supplier) return sendSuppliersMenu(from);

  if (!supplier.active) {
    await sendText(from, "🔒 *Activate your listing first to view earnings.*");
    return sendSupplierUpgradeMenu(from, supplier.tier);
  }

  const SupplierOrder = (await import("../models/supplierOrder.js")).default;
    const completed = await SupplierOrder.find({ supplierId: supplier._id, status: "completed" });
   const total = completed.reduce((sum, o) => sum + (o.totalAmount || 0), 0);
    const thisMonth = completed.filter(o => {
      const d = new Date(o.createdAt);
      const now = new Date();
      return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
   }).reduce((sum, o) => sum + (o.totalAmount || 0), 0);
    return sendButtons(from, {
      text: `💵 *Earnings Summary*\n\n📦 Completed orders: ${completed.length}\n💰 Total earnings: $${total.toFixed(2)}\n📅 This month: $${thisMonth.toFixed(2)}\n\n⭐ Rating: ${(supplier.rating || 0).toFixed(1)} (${supplier.reviewCount || 0} reviews)\n🏅 Score: ${(supplier.credibilityScore || 0).toFixed(0)}/100`,
      buttons: [{ id: "my_supplier_account", title: "🏪 My Account" }]
    });
  }

if (a === "sup_my_reviews") {
  const supplier = await SupplierProfile.findOne({ phone });
  if (!supplier) return sendSuppliersMenu(from);

  if (!supplier.active) {
    await sendText(from, "🔒 *Activate your listing first to view reviews.*");
    return sendSupplierUpgradeMenu(from, supplier.tier);
  }

  if (!supplier.reviewCount) {
      return sendButtons(from, {
        text: "⭐ *My Reviews*\n\nNo reviews yet. Complete orders to get rated by buyers!",
        buttons: [{ id: "my_supplier_account", title: "🏪 My Account" }]
      });
    }
    return sendButtons(from, {
      text: `⭐ *My Reviews*\n\nRating: ${(supplier.rating || 0).toFixed(1)}/5\nReviews: ${supplier.reviewCount || 0}\nScore: ${(supplier.credibilityScore || 0).toFixed(0)}/100\n\n${(supplier.credibilityScore || 0) >= 70 && (supplier.completedOrders || 0) >= 10 ? "🏅 You have the Top Supplier badge!" : "Complete more orders to earn the 🏅 Top Supplier badge (score 70+, 10+ orders)"}`,
      buttons: [{ id: "my_supplier_account", title: "🏪 My Account" }]
    });
  }

if (a === "sup_upgrade_plan" || a === "sup_renew_plan") {
    return sendList(from,
      `💳 *Choose Your Plan*\n\nAll plans include:\n✅ Listed in search\n✅ Phone number visible\n✅ Product listing\n\nPick a plan to continue:`,
      [
        { id: "sup_plan_basic_monthly", title: "✅ Basic - $5/month", description: "Up to 10 orders/month" },
        { id: "sup_plan_basic_annual", title: "✅ Basic - $50/year", description: "Save $10 - pay once yearly" },
        { id: "sup_plan_pro_monthly", title: "⭐ Pro - $12/month", description: "Unlimited orders + buyer requests" },
        { id: "sup_plan_pro_annual", title: "⭐ Pro - $120/year", description: "Save $24 - most popular" },
        { id: "sup_plan_featured_monthly", title: "🔥 Featured - $25/month", description: "Top placement + featured badge" }
      ]
    );
  }


  // ── Supplier city selected from list during registration ──────────────────
  if (a.startsWith("sup_city_")) {
    const cityRaw = a.replace("sup_city_", "");
    const city = cityRaw === "other" ? null : cityRaw.charAt(0).toUpperCase() + cityRaw.slice(1);

    if (!city) {
      // Ask them to type their city
      if (biz) {
        biz.sessionState = "supplier_reg_area";
        biz.sessionData = biz.sessionData || {};
        biz.sessionData.supplierReg = biz.sessionData.supplierReg || {};
        biz.sessionData.supplierReg.city = "Other";
        await saveBizSafe(biz);
      }
  return sendText(from,
        "📍 Please type your city name:\n\n_Type *cancel* to return to main menu._"
      );
    }

    if (biz) {
      biz.sessionData = biz.sessionData || {};
      biz.sessionData.supplierReg = biz.sessionData.supplierReg || {};
      biz.sessionData.supplierReg.city = city;
      biz.sessionState = "supplier_reg_area";
      await saveBizSafe(biz);
    }

return sendText(from,
`📍 *${city}*

What area or suburb are you in?

Example: *Mbare, Chitungwiza, Belgravia*

_Type *cancel* to return to main menu._`
    );
  }


  // ── Profile type: Products or Services ───────────────────────────────────



if (a === "reg_type_product" || a === "reg_type_service") {
  if (!biz) return sendMainMenu(from);

  const profileType = a === "reg_type_service" ? "service" : "product";

  biz.sessionData = biz.sessionData || {};
  biz.sessionData.supplierReg = biz.sessionData.supplierReg || {};
  biz.sessionData.supplierReg.profileType = profileType;
  biz.sessionState = "supplier_reg_category";
  await saveBizSafe(biz);

  const filteredCategories = getSupplierCategoriesForType(profileType);

  const categoryRows = [
    ...filteredCategories.slice(0, 9).map(c => ({
      id: `sup_cat_${c.id}`,
      title: c.label
    })),
    ...(filteredCategories.length > 9
      ? [{ id: "sup_cat_more", title: "➕ More Categories" }]
      : [])
  ];

  return sendList(
    from,
    profileType === "service"
      ? "🗂 What service do you mainly offer?"
      : "🗂 What product do you mainly offer?",
    categoryRows
  );
}



if (a === "sup_cat_more") {
  if (!biz) return sendMainMenu(from);

  const profileType = biz.sessionData?.supplierReg?.profileType || "product";
  const filteredCategories = getSupplierCategoriesForType(profileType);

  return sendList(
  from,
  "🗂 More Categories",
  [
    ...filteredCategories.slice(9).map(c => ({
      id: `sup_cat_${c.id}`,
      title: c.label
    }))
  ]
);

}

  // ── Travel yes/no during service registration ─────────────────────────────
  if (a === "sup_travel_yes") {
    if (!biz) return sendMainMenu(from);
    biz.sessionData.supplierReg = biz.sessionData.supplierReg || {};
    biz.sessionData.supplierReg.travelAvailable = true;
    biz.sessionState = "supplier_reg_minorder";
    await saveBizSafe(biz);
   return sendText(from,
`💵 What is your minimum job value in USD?

Type *0* for no minimum.

Type *cancel* to stop registration.`);

  }

  if (a === "sup_travel_no") {
    if (!biz) return sendMainMenu(from);
    biz.sessionData.supplierReg = biz.sessionData.supplierReg || {};
    biz.sessionData.supplierReg.travelAvailable = false;
    biz.sessionState = "supplier_reg_minorder";
    await saveBizSafe(biz);
return sendText(from,
`💵 What is your minimum job value in USD?

Type *0* for no minimum.

Type *cancel* to stop registration.`);

  }
  // ── Supplier category selected during registration ────────────────────────
if (a.startsWith("sup_cat_")) {
  const catId = a.replace("sup_cat_", "");
  if (!biz) return sendMainMenu(from);

  const profileType = biz.sessionData?.supplierReg?.profileType || "product";

  biz.sessionData = biz.sessionData || {};
  biz.sessionData.supplierReg = biz.sessionData.supplierReg || {};
  const existing = biz.sessionData.supplierReg.categories || [];
  if (!existing.includes(catId)) existing.push(catId);
  biz.sessionData.supplierReg.categories = existing;
  biz.sessionState = "supplier_reg_products";
  await saveBizSafe(biz);

  // Get category-specific examples for either services or products
 // Get category-specific examples for either services or products
  const { CATEGORY_PRODUCT_EXAMPLES, CATEGORY_SERVICE_EXAMPLES } = await import("./supplierRegistration.js");
  const { getTemplateForCategory } = await import("./supplierProductTemplates.js");
  const template = getTemplateForCategory(catId);

if (profileType === "service") {
  const catExamples = CATEGORY_SERVICE_EXAMPLES[catId] || ["service a", "service b"];
  const exampleText = catExamples.slice(0, 2).join(", ");

  return sendButtons(from, {
    text: `✅ *Category selected!*\n\nHow would you like to add your services?\n\n_e.g. ${exampleText}_`,
    buttons: [
      { id: "sup_request_upload",     title: "📤 Send Us Your List" },
      { id: "sup_enter_own_products", title: "✍️ Type My Own" },
      { id: "sup_skip_products",      title: "⏭ Skip For Now" }
    ]
  });
}

  // Products - check for preset template first
  const catExamples = CATEGORY_PRODUCT_EXAMPLES[catId] || ["product a", "product b", "product c"];
  const exampleText = catExamples.slice(0, 3).join(", ");

if (template) {
  const preview = template.products.slice(0, 6).join(", ");
  const moreCount = template.products.length - 6;

  return sendButtons(from, {
    text:
`✅ *Category selected!*

📦 *Preset available:* _${preview}${moreCount > 0 ? ` + ${moreCount} more` : ""}_

How would you like to add your products?`,
    buttons: [
      { id: "sup_request_upload",       title: "📤 Send Us Your List" },
      { id: "sup_enter_own_products",   title: "✍️ Type My Own" },
      { id: `sup_load_preset_${catId}`, title: "📦 Use Preset List" }
    ]
  });
}

  // No preset for this category - still show all options
// No preset for this category - still show all options
return sendButtons(from, {
    text:
`✅ *Category selected!*

How would you like to add your products?

_Examples: ${exampleText}_`,
    buttons: [
      { id: "sup_request_upload",      title: "📤 Send Us Your List" },
      { id: "sup_enter_own_products",  title: "✍️ Type My Own" },
      { id: "sup_skip_products",       title: "⏭ Skip For Now" }
    ]
  });
}



// ── Load preset products with preview ─────────────────────────────────────
if (a.startsWith("sup_load_preset_")) {
  if (!biz) return sendMainMenu(from);
  const catId = a.replace("sup_load_preset_", "");
  const { getTemplateForCategory } = await import("./supplierProductTemplates.js");
  const template = getTemplateForCategory(catId);

  if (!template || !template.products?.length) {
    await sendText(from, "❌ No preset found for this category.");
    return sendSuppliersMenu(from);
  }

  // Store the preset catId so the confirm handler knows what to load
  biz.sessionData.supplierReg = biz.sessionData.supplierReg || {};
  biz.sessionData.supplierReg.pendingPresetCatId = catId;
  await saveBizSafe(biz);

  // Build preview - split into chunks of 8 per line for readability
  const chunks = [];
  for (let i = 0; i < template.products.length; i += 8) {
    chunks.push(template.products.slice(i, i + 8).join(", "));
  }
  const previewText = chunks.join("\n");

  return sendButtons(from, {
    text:
`📦 *Preset List Preview* (${template.products.length} products)

${previewText}

Load all these products to your listing?`,
    buttons: [
      { id: "sup_preset_confirm",  title: "✅ Yes, Load These" },
      { id: "sup_enter_own_products", title: "✍️ No, I'll Type Mine" }
    ]
  });
}


// ── Confirm preset load ────────────────────────────────────────────────────
if (a === "sup_preset_confirm") {
  if (!biz) return sendMainMenu(from);
  const catId = biz.sessionData?.supplierReg?.pendingPresetCatId;
  if (!catId) {
    await sendText(from, "❌ Preset session expired. Please select your category again.");
    return sendSuppliersMenu(from);
  }

  const { getTemplateForCategory } = await import("./supplierProductTemplates.js");
  const template = getTemplateForCategory(catId);

  if (!template?.products?.length) {
    await sendText(from, "❌ Could not load preset. Please type your products manually.");
    biz.sessionState = "supplier_reg_products";
    await saveBizSafe(biz);
    return;
  }

  biz.sessionData.supplierReg.products = template.products.map(p => p.toLowerCase());
  biz.sessionData.supplierReg.prices = template.prices || [];
  delete biz.sessionData.supplierReg.pendingPresetCatId;
  biz.sessionState = "supplier_reg_prices";
  await saveBizSafe(biz);

  const hasPrices = template.prices?.length > 0;

  if (hasPrices) {
    // Show price preview too
    const pricePreview = template.prices.slice(0, 5)
      .map(p => `• ${p.product}: $${p.amount}/${p.unit}`)
      .join("\n");

    return sendButtons(from, {
      text:
`✅ *${template.products.length} products loaded!*

We also have suggested prices for some items:
${pricePreview}${template.prices.length > 5 ? `\n_...and ${template.prices.length - 5} more_` : ""}

Use these suggested prices?`,
      buttons: [
        { id: "sup_preset_prices_yes", title: "✅ Use Suggested Prices" },
        { id: "sup_skip_prices",        title: "✍️ I'll Set My Own" }
      ]
    });
  }

  // No preset prices - go straight to pricing step
  const profileType = biz.sessionData?.supplierReg?.profileType || "product";
  if (profileType === "service") {
    biz.sessionState = "supplier_reg_travel";
    await saveBizSafe(biz);
    return sendButtons(from, {
      text: `✅ *${template.products.length} services loaded!*\n\n🚗 *Do you travel to clients?*`,
      buttons: [
        { id: "sup_travel_yes", title: "✅ Yes I Travel" },
        { id: "sup_travel_no",  title: "🏠 Client Comes to Me" }
      ]
    });
  }

  biz.sessionState = "supplier_reg_delivery";
  await saveBizSafe(biz);
  return sendButtons(from, {
    text: `✅ *${template.products.length} products loaded!*\n\nNow, do you deliver?`,
    buttons: [
      { id: "sup_del_yes", title: "✅ Yes I Deliver" },
      { id: "sup_del_no",  title: "🏠 Collection Only" }
    ]
  });
}


// ── Accept preset suggested prices ────────────────────────────────────────
if (a === "sup_preset_prices_yes") {
  if (!biz) return sendMainMenu(from);
  // Prices already loaded by sup_preset_confirm, just move forward
  const profileType = biz.sessionData?.supplierReg?.profileType || "product";
  if (profileType === "service") {
    biz.sessionState = "supplier_reg_travel";
    await saveBizSafe(biz);
    return sendButtons(from, {
      text: "🚗 *Do you travel to clients?*",
      buttons: [
        { id: "sup_travel_yes", title: "✅ Yes I Travel" },
        { id: "sup_travel_no",  title: "🏠 Client Comes to Me" }
      ]
    });
  }
  biz.sessionState = "supplier_reg_delivery";
  await saveBizSafe(biz);
  return sendButtons(from, {
    text: "🚚 *Do you deliver?*",
    buttons: [
      { id: "sup_del_yes", title: "✅ Yes I Deliver" },
      { id: "sup_del_no",  title: "🏠 Collection Only" }
    ]
  });
}
// ── Skip or finish pricing during registration ─────────────────────────────
if (a === "sup_skip_prices" || a === "sup_done_prices") {
  if (!biz) return sendMainMenu(from);

  const profileType = biz.sessionData?.supplierReg?.profileType || "product";

  if (profileType === "service") {
    biz.sessionState = "supplier_reg_travel";
    await saveBizSafe(biz);
    return sendButtons(from, {
      text: "🚗 *Do you travel to clients?*",
      buttons: [
        { id: "sup_travel_yes", title: "✅ Yes I Travel" },
        { id: "sup_travel_no", title: "🏠 Client Comes to Me" }
      ]
    });
  }

  biz.sessionState = "supplier_reg_delivery";
  await saveBizSafe(biz);
  return sendButtons(from, {
    text: "🚚 Do you deliver?",
    buttons: [
      { id: "sup_del_yes", title: "✅ Yes I Deliver" },
      { id: "sup_del_no", title: "🏠 Collection Only" }
    ]
  });
}

// ── Supplier confirms pricing preview ─────────────────────────────────────
if (a === "sup_prices_confirm_yes") {
  if (!biz) return sendMainMenu(from);

  const isService = biz.sessionData?.supplierReg?.profileType === "service";
  const prices = biz.sessionData?.supplierReg?.prices || [];
  const rates  = biz.sessionData?.supplierReg?.rates  || [];
  const count  = isService ? rates.length : prices.length;

  if (isService) {
    biz.sessionState = "supplier_reg_travel";
    await saveBizSafe(biz);
    return sendButtons(from, {
      text: `✅ *${count} rate(s) confirmed!*\n\n🚗 *Do you travel to clients?*`,
      buttons: [
        { id: "sup_travel_yes", title: "✅ Yes I Travel" },
        { id: "sup_travel_no",  title: "🏠 Client Comes to Me" }
      ]
    });
  }

  biz.sessionState = "supplier_reg_delivery";
  await saveBizSafe(biz);
  return sendButtons(from, {
    text: `✅ *${count} price(s) confirmed!*\n\n🚚 *Do you deliver?*`,
    buttons: [
      { id: "sup_del_yes", title: "✅ Yes I Deliver" },
      { id: "sup_del_no",  title: "🏠 Collection Only" }
    ]
  });
}

// ── Supplier wants to re-enter prices ─────────────────────────────────────
if (a === "sup_prices_edit") {
  if (!biz) return sendMainMenu(from);

  const isService = biz.sessionData?.supplierReg?.profileType === "service";
  const productList = biz.sessionData?.supplierReg?.products || [];

  // Clear existing prices so they re-enter
  if (isService) {
    biz.sessionData.supplierReg.rates = [];
  } else {
    biz.sessionData.supplierReg.prices = [];
  }
  biz.sessionState = "supplier_reg_prices";
  await saveBizSafe(biz);

  const numbered = productList.map((p, i) => `${i + 1}. ${p}`).join("\n");

  return sendText(from,
`✏️ *Re-enter Your ${isService ? "Rates" : "Prices"}*

${numbered}

*Fastest:* Just the numbers in order:
_${productList.slice(0, 4).map((_, i) => ((i + 1) * 3 + 2) + ".00").join(", ")}${productList.length > 4 ? ", ..." : ""}_

*Or name them:*
_${productList.slice(0, 2).map(p => `${p}: 5.00`).join(", ")}_

Type *skip* to skip pricing.`);
}

// ── Load preset products - show full preview before confirming ────────────
if (a.startsWith("sup_load_preset_")) {
  if (!biz) return sendMainMenu(from);

  const catId = a.replace("sup_load_preset_", "");
  const { getTemplateForCategory } = await import("./supplierProductTemplates.js");
  const template = getTemplateForCategory(catId);

  if (!template?.products?.length) {
    await sendText(from, "❌ No preset found for this category. Please type your products.");
    biz.sessionState = "supplier_reg_products";
    await saveBizSafe(biz);
    return;
  }

  // Store pending catId for confirm step
  biz.sessionData.supplierReg = biz.sessionData.supplierReg || {};
  biz.sessionData.supplierReg.pendingPresetCatId = catId;
  await saveBizSafe(biz);

  // Build full product preview grouped in rows of 4
  const allProducts = template.products;
  const rows = [];
  for (let i = 0; i < allProducts.length; i += 4) {
    rows.push(allProducts.slice(i, i + 4).map((p, j) => `${i + j + 1}. ${p}`).join("   "));
  }
  const productPreview = rows.join("\n");

  // Show price preview if available
  const priceHint = template.prices?.length
    ? `\n💰 *Suggested prices included for ${template.prices.length} items*`
    : "";

  return sendButtons(from, {
    text:
`📦 *Preset Product List* (${allProducts.length} items)

${productPreview}${priceHint}

Load all these to your listing?`,
    buttons: [
      { id: "sup_preset_confirm",      title: "✅ Yes, Load These" },
      { id: "sup_enter_own_products",  title: "✍️ No, Type My Own" }
    ]
  });
}

// ── Supplier confirms preset load ─────────────────────────────────────────
if (a === "sup_preset_confirm") {
  if (!biz) return sendMainMenu(from);

  const catId = biz.sessionData?.supplierReg?.pendingPresetCatId;
  if (!catId) {
    await sendText(from, "❌ Session expired. Please select your category again.");
    return sendSuppliersMenu(from);
  }

  const { getTemplateForCategory } = await import("./supplierProductTemplates.js");
  const template = getTemplateForCategory(catId);

  if (!template?.products?.length) {
    await sendText(from, "❌ Could not load preset. Please type your products.");
    biz.sessionState = "supplier_reg_products";
    await saveBizSafe(biz);
    return;
  }

  // Load products
  biz.sessionData.supplierReg.products = template.products.map(p => p.toLowerCase());
  delete biz.sessionData.supplierReg.pendingPresetCatId;

  // If template has prices - show price preview and ask to use them
  if (template.prices?.length) {
    biz.sessionData.supplierReg.prices = template.prices;
    await saveBizSafe(biz);

    const priceLines = template.prices.slice(0, 6)
      .map(p => `• ${p.product}: $${p.amount}/${p.unit}`)
      .join("\n");
    const remaining = template.prices.length - 6;

    return sendButtons(from, {
      text:
`✅ *${template.products.length} products loaded!*

💰 *Suggested prices:*
${priceLines}${remaining > 0 ? `\n_...and ${remaining} more_` : ""}

Use these suggested prices?`,
      buttons: [
        { id: "sup_preset_prices_yes", title: "✅ Use These Prices" },
        { id: "sup_prices_edit",        title: "✏️ Set My Own Prices" },
        { id: "sup_skip_prices",        title: "⏭ Skip For Now" }
      ]
    });
  }

  // No preset prices - prompt them to enter prices using numbered list
  biz.sessionData.supplierReg.prices = [];
  biz.sessionState = "supplier_reg_prices";
  await saveBizSafe(biz);

  const numbered = template.products.map((p, i) => `${i + 1}. ${p}`).join("\n");

  return sendButtons(from, {
    text:
`✅ *${template.products.length} products loaded!*

💰 *Now set your prices:*
${numbered}

*Fastest:* Just numbers in order:
_5.50, 8, 0.25, 12_

*Or name them:* _cement 5.50, sand 8_`,
    buttons: [{ id: "sup_skip_prices", title: "⏭ Skip For Now" }]
  });
}

// ── Supplier accepts preset suggested prices ──────────────────────────────
if (a === "sup_preset_prices_yes") {
  if (!biz) return sendMainMenu(from);

  const isService = biz.sessionData?.supplierReg?.profileType === "service";
  const prices = biz.sessionData?.supplierReg?.prices || [];

  if (isService) {
    biz.sessionState = "supplier_reg_travel";
    await saveBizSafe(biz);
    return sendButtons(from, {
      text: `✅ *Prices accepted!*\n\n🚗 *Do you travel to clients?*`,
      buttons: [
        { id: "sup_travel_yes", title: "✅ Yes I Travel" },
        { id: "sup_travel_no",  title: "🏠 Client Comes to Me" }
      ]
    });
  }

  biz.sessionState = "supplier_reg_delivery";
  await saveBizSafe(biz);
  return sendButtons(from, {
    text: `✅ *${prices.length} prices accepted!*\n\n🚚 *Do you deliver?*`,
    buttons: [
      { id: "sup_del_yes", title: "✅ Yes I Deliver" },
      { id: "sup_del_no",  title: "🏠 Collection Only" }
    ]
  });
}

// ── Enter own products (manual entry) ────────────────────────────────────────
if (a === "sup_enter_own_products") {
  if (!biz) return sendMainMenu(from);

  const profileType = biz.sessionData?.supplierReg?.profileType || "product";
  const catId = biz.sessionData?.supplierReg?.categories?.[0] || "";
  const { CATEGORY_PRODUCT_EXAMPLES, CATEGORY_SERVICE_EXAMPLES } = await import("./supplierRegistration.js");

  const isService = profileType === "service";
  const map = isService ? CATEGORY_SERVICE_EXAMPLES : CATEGORY_PRODUCT_EXAMPLES;
  const catExamples = map[catId] || (isService ? ["service a", "service b"] : ["product a", "product b"]);
  const exampleText = catExamples.slice(0, 3).join(", ");

  biz.sessionState = "supplier_reg_products";
  await saveBizSafe(biz);

  return sendText(from,
`✍️ *Enter Your ${isService ? "Services" : "Products"}*

List them separated by commas, then send.

*Example:*
_${exampleText}_

Type *cancel* to stop registration.`);
}

// ── Skip products entirely during registration ────────────────────────────────
if (a === "sup_skip_products") {
  if (!biz) return sendMainMenu(from);

  const profileType = biz.sessionData?.supplierReg?.profileType || "product";

  biz.sessionData.supplierReg = biz.sessionData.supplierReg || {};
  biz.sessionData.supplierReg.products = ["pending_upload"];
  biz.sessionData.supplierReg.prices = [];
  if (profileType === "service") {
    biz.sessionData.supplierReg.rates = [];
    biz.sessionState = "supplier_reg_travel";
    await saveBizSafe(biz);
    return sendButtons(from, {
      text: `🚗 *Do you travel to clients?*\n\n_You can add your services later from your account._`,
      buttons: [
        { id: "sup_travel_yes", title: "✅ Yes I Travel" },
        { id: "sup_travel_no",  title: "🏠 Client Comes to Me" }
      ]
    });
  }
  biz.sessionState = "supplier_reg_delivery";
  await saveBizSafe(biz);
  return sendButtons(from, {
    text: `🚚 *Do you deliver?*\n\n_You can add your products later from your account._`,
    buttons: [
      { id: "sup_del_yes", title: "✅ Yes I Deliver" },
      { id: "sup_del_no",  title: "🏠 Collection Only" }
    ]
  });
}

// ── Supplier requests catalogue upload help ───────────────────────────────────
if (a === "sup_request_upload") {
  if (!biz) return sendMainMenu(from);

  const profileType = biz.sessionData?.supplierReg?.profileType || "product";
  const isService = profileType === "service";

  biz.sessionData.supplierReg = biz.sessionData.supplierReg || {};
  biz.sessionData.supplierReg.products = ["pending_upload"];
  biz.sessionData.supplierReg.prices = [];

  const existingSupplierId = biz.sessionData?.pendingSupplierId;
  if (existingSupplierId) {
    await SupplierProfile.findByIdAndUpdate(existingSupplierId, {
      adminNote: `[Requested ${isService ? "service rates" : "catalogue"} upload via WhatsApp]`,
      products: ["pending_upload"]
    });
  }

  if (isService) {
    biz.sessionData.supplierReg.rates = [];
    biz.sessionState = "supplier_reg_travel";
    await saveBizSafe(biz);
    return sendButtons(from, {
      text:
`📤 *Upload Request Noted!*

After you finish registration, send your service list & rates to us:
📱 *WhatsApp:* +263 77 114 3904
📧 *Email:* info@zimquote.co.zw

We'll load it within 24 hours and notify you. ✅

Now one quick question - *do you travel to clients?*`,
      buttons: [
        { id: "sup_travel_yes", title: "✅ Yes I Travel" },
        { id: "sup_travel_no",  title: "🏠 Client Comes to Me" }
      ]
    });
  }

  biz.sessionState = "supplier_reg_delivery";
  await saveBizSafe(biz);
  return sendButtons(from, {
    text:
`📤 *Upload Request Noted!*

After you finish registration, send your product list & prices to us:
📱 *WhatsApp:* +263 78 990 1058
📧 *Email:* info@zimquote.co.zw

You can also send a photo of your price list, Excel file, or typed list.
We'll load it within 24 hours and notify you. ✅

Now one quick question - *do you deliver?*`,
    buttons: [
      { id: "sup_del_yes", title: "✅ Yes I Deliver" },
      { id: "sup_del_no",  title: "🏠 Collection Only" }
    ]
  });
}


  // ── Delivery yes/no during registration ───────────────────────────────────
  if (a === "sup_del_yes") {
    if (!biz) return sendMainMenu(from);
    biz.sessionData.supplierReg = biz.sessionData.supplierReg || {};
    biz.sessionData.supplierReg.delivery = { available: true, range: "city_wide" };
    biz.sessionState = "supplier_reg_minorder";
    await saveBizSafe(biz);
return sendText(from,
`💵 What is your minimum order amount in USD?

Type *0* for no minimum.

Type *cancel* to stop registration.`);

  }

  if (a === "sup_del_no") {
    if (!biz) return sendMainMenu(from);
    biz.sessionData.supplierReg = biz.sessionData.supplierReg || {};
    biz.sessionData.supplierReg.delivery = { available: false };
    biz.sessionState = "supplier_reg_minorder";
    await saveBizSafe(biz);
  return sendText(from,
`💵 What is your minimum order amount in USD?

Type *0* for no minimum.

Type *cancel* to stop registration.`);

  }

  // ── Supplier confirms listing → save + show plan picker ──────────────────
  if (a === "sup_confirm_yes") {
    if (!biz) return sendMainMenu(from);
    const reg = biz.sessionData?.supplierReg;
    if (!reg?.businessName) {
      await sendText(from, "❌ Registration data missing. Please start again.");
      biz.sessionState = "ready"; biz.sessionData = {}; await saveBizSafe(biz);
      return startSupplierRegistration(from, biz);
    }

    // Create inactive supplier profile
const supplier = await SupplierProfile.create({
      phone,
      businessName: reg.businessName,
      location: { city: reg.city || "Harare", area: reg.area || "" },
      categories: reg.categories || [],
      products: reg.products || [],
      prices: reg.prices || [],
      delivery: reg.delivery || { available: false },
      minOrder: reg.minOrder || 0,
      profileType: reg.profileType || "product",   // ← ADD
      rates: reg.rates || null,                     // ← ADD
      travelAvailable: reg.travelAvailable ?? null, // ← ADD
      active: false,
      subscriptionStatus: "pending",
      priceUpdatedAt: reg.prices?.length ? new Date() : null
    });

    biz.sessionData.pendingSupplierId = supplier._id.toString();
    biz.sessionState = "supplier_reg_choose_plan";
    await saveBizSafe(biz);

return sendList(from,
`🎉 *Your listing is ready!*

But right now *buyers cannot find you yet.*

To go live and start receiving orders, you need to choose a plan and pay. It's like paying for a market stall - once you pay, your business shows up when buyers search.

💳 *Choose a plan below to activate your listing:*`,
      [
        { id: "sup_plan_basic_monthly", title: "✅ Basic - $5/month", description: "Up to 10 orders/month. Good to start." },
        { id: "sup_plan_basic_annual", title: "✅ Basic - $50/year (save $10)", description: "Pay once for the whole year" },
        { id: "sup_plan_pro_monthly", title: "⭐ Pro - $12/month", description: "Unlimited orders + higher placement" },
        { id: "sup_plan_pro_annual", title: "⭐ Pro - $120/year (save $24)", description: "Most popular choice" },
        { id: "sup_plan_featured_monthly", title: "🔥 Featured - $25/month", description: "Top of search - buyers see you first" }
      ]
    );
  }

  if (a === "sup_confirm_no") {
    if (!biz) return sendMainMenu(from);
    biz.sessionState = "ready"; biz.sessionData = {}; await saveBizSafe(biz);
    return startSupplierRegistration(from, biz);
  }

  // ── Supplier search: category selected ────────────────────────────────────
if (a.startsWith("sup_search_cat_")) {
  const category = a.replace("sup_search_cat_", "");

  let searchType = biz?.sessionData?.supplierSearch?.type || null;
  if (!searchType) {
    const sess = await UserSession.findOne({ phone });
    searchType = sess?.tempData?.supplierSearchType || "product";
  }

  if (biz) {
    biz.sessionData = {
      ...(biz.sessionData || {}),
      supplierSearch: {
        ...(biz.sessionData?.supplierSearch || {}),
        type: searchType,
        category
      }
    };
    biz.sessionState = "supplier_search_city";
    await saveBizSafe(biz);
  } else {
    await UserSession.findOneAndUpdate(
      { phone },
      {
        $set: {
          "tempData.supplierSearchCategory": category,
          "tempData.supplierSearchType": searchType
        }
      },
      { upsert: true }
    );
  }

  return sendList(from, "📍 Which city?", [
    ...SUPPLIER_CITIES.map(c => ({
      id: `sup_search_city_${c.toLowerCase()}`,
      title: c
    })),
    { id: "sup_search_city_other", title: "📍 Other" }
  ]);
}

  // ── Supplier search: city selected ────────────────────────────────────────
 if (a.startsWith("sup_search_city_")) {
   const cityRaw = a.replace("sup_search_city_", "");
    const city = cityRaw === "all" ? null : cityRaw.charAt(0).toUpperCase() + cityRaw.slice(1);

    // Get category AND product from biz session or UserSession fallback
  let category = biz?.sessionData?.supplierSearch?.category || null;
let product = biz?.sessionData?.supplierSearch?.product || null;
let profileType = biz?.sessionData?.supplierSearch?.type || null;

if (!category && !product && !profileType) {
  const sess = await UserSession.findOne({ phone });
  category = sess?.tempData?.supplierSearchCategory || null;
  product = sess?.tempData?.supplierSearchProduct || null;
  profileType = sess?.tempData?.supplierSearchType || null;
}

const results = await runSupplierSearch({ city, category, product, profileType });
  if (!results.length) {
      return sendButtons(from, {
        text: `😕 No suppliers found for ${category || product || "your search"}${city ? ` in ${city}` : ""}.\n\nTry a different city or category.`,
        buttons: [
          { id: "find_supplier", title: "🔍 Search Again" },
          { id: "suppliers_home", title: "🏪 Suppliers" }
        ]
      });
    }

    if (biz) {
      biz.sessionData = {
        ...(biz.sessionData || {}),
        supplierSearch: { ...(biz.sessionData?.supplierSearch || {}), city }
      };
      await saveBizSafe(biz);
    }

const rows = formatSupplierResults(results, city, category || product);
    const locationLabel = city || "All Cities";
    const searchLabel = category || product || "Suppliers";
    return sendList(from, `🔍 ${searchLabel} - ${locationLabel}\n${results.length} found`, rows);
  }

  // ── View supplier detail ───────────────────────────────────────────────────
  if (a.startsWith("sup_view_")) {
    const supplierId = a.replace("sup_view_", "");
    const supplier = await SupplierProfile.findById(supplierId).lean();
    if (!supplier) return sendText(from, "❌ Supplier not found.");

    await SupplierProfile.findByIdAndUpdate(supplierId, {
      $inc: { viewCount: 1, monthlyViews: 1 }
    });

const deliveryText = supplier.profileType === "service"
  ? (supplier.travelAvailable ? "🚗 Mobile service - travels to you" : "📍 Visit required - client comes to provider")
  : (supplier.delivery?.available
      ? `🚚 Delivers (${(supplier.delivery.range || "").replace("_", " ")})`
      : "🏠 Collection only");
  
    const badge = supplier.topSupplierBadge ? "\n🏅 Top Supplier" : "";
    const tierBadge = supplier.tier === "featured" ? " 🔥" : supplier.tier === "pro" ? " ⭐" : "";
const offeringLabel = supplier.profileType === "service" ? "🔧" : "📦";
const offeringText = supplier.profileType === "service"
  ? (supplier.rates?.length
      ? supplier.rates.slice(0, 5).map(r => `${r.service} (${formatSupplierRateDisplay(r.rate)})`).join(", ")
      : (supplier.products || []).slice(0, 5).join(", "))
  : (supplier.prices?.length
      ? supplier.prices.slice(0, 5).map(p => `${p.product} ($${p.amount}/${p.unit})`).join(", ")
      : (supplier.products || []).slice(0, 5).join(", "));

return sendButtons(from, {
      text: `🏪 *${supplier.businessName}*${tierBadge}\n` +
            `📍 ${supplier.location?.area}, ${supplier.location?.city}\n` +
            `${offeringLabel} ${offeringText}\n` +
       `${deliveryText}${badge}\n` +
            `⭐ ${(supplier.rating || 0).toFixed(1)} (${supplier.reviewCount || 0} reviews)\n` +
            `📞 ${supplier.phone}`,
    buttons: [
  {
    id: `sup_order_${supplierId}`,
    title: supplier.profileType === "service" ? "📅 Book Service" : "🛒 Place Order"
  },
  { id: `sup_save_${supplierId}`, title: "Save Supplier" },
 { id: "find_supplier", title: "🔍 Find Suppliers" }
]
    });
  }

  // ── Save supplier ──────────────────────────────────────────────────────────
  if (a.startsWith("sup_save_")) {
    const supplierId = a.replace("sup_save_", "");
    await SupplierProfile.findByIdAndUpdate(supplierId, {
      $addToSet: { savedBy: phone }
    });
    await sendText(from, "Supplier saved! Find them in your saved list.");
    return;
  }



  // ── Update supplier prices ─────────────────────────────────────────────────
if (a === "sup_update_prices") {
  const supplier = await SupplierProfile.findOne({ phone });
  if (!supplier) return sendSuppliersMenu(from);

  if (!supplier.active) {
    await sendText(from, "🔒 *Activate your listing first.*\n\nYou can update prices after your listing is live.");
    return sendSupplierUpgradeMenu(from, supplier.tier);
  }

  if (biz) {
    biz.sessionData = { ...(biz.sessionData || {}), updatingPrices: true };
    biz.sessionState = "supplier_update_prices";
    await saveBizSafe(biz);
  }

  const products = (supplier.products || []).filter(p => p !== "pending_upload");

  if (!products.length) {
    return sendButtons(from, {
      text: "❌ Add your products first before setting prices.",
      buttons: [{ id: "sup_edit_products", title: "✏️ Add Products" }]
    });
  }

  // Show numbered list with current prices where known
  const numbered = products.map((p, i) => {
    const existing = supplier.prices?.find(pr =>
      pr.product?.toLowerCase() === p.toLowerCase()
    );
    const priceStr = existing
      ? ` - $${Number(existing.amount).toFixed(2)}/${existing.unit}`
      : " - _(not set)_";
    return `${i + 1}. ${p}${priceStr}`;
  }).join("\n");

  return sendText(from,
`💰 *Update Prices*

${numbered}

*Fastest - just numbers in order:*
_${products.slice(0, 4).map((_, i) => ((i + 1) * 3 + 2) + ".00").join(", ")}${products.length > 4 ? ", ..." : ""}_

*Or name them (update specific items):*
_cement: 6.00, sand: 9.50_

*Or one per line:*
_cement: 6.00_
_sand: 9.50_

Type *cancel* to go back.`);
}
  // ── Handle price update text input ────────────────────────────────────────
if (biz?.sessionState === "supplier_update_prices" && !isMetaAction) {
  const supplier = await SupplierProfile.findOne({ phone });
  if (!supplier) return sendSuppliersMenu(from);

  const raw = (text || "").trim();
  if (!raw) {
    await sendText(from, "❌ Please send your prices.");
    return;
  }

  const products = (supplier.products || []).filter(p => p !== "pending_upload");
  const parts = raw.split(/[,\n]+/).map(s => s.trim()).filter(Boolean);
  const allNumbers = parts.length > 0 && parts.every(s => /^\d+(\.\d+)?$/.test(s));
  const updated = [];
  const failed = [];

  if (allNumbers) {
    // Strategy 1: numbers in order
    if (parts.length !== products.length) {
      const numbered = products.map((p, i) => `${i + 1}. ${p}`).join("\n");
      await sendText(from,
`❌ You have *${products.length} products* but sent *${parts.length} prices*.

Send one price per product in order:
${numbered}`
      );
      return;
    }
    parts.forEach((numStr, i) => {
      updated.push({
        product: products[i].toLowerCase(),
        amount: parseFloat(numStr),
        unit: "each",
        inStock: true
      });
    });
  } else {
    // Strategy 2: named pricing with aggressive paste parser
    for (const line of parts) {
      const clean = line
        .replace(/^[-•*►▪✓]\s*/, "")
        .replace(/^\d+[.)]\s*/, "")
        .replace(/\$/g, "")
        .trim();

      if (!clean) continue;

      let match =
        clean.match(/^(.+?)\s*[:]\s*(\d+(?:\.\d+)?)\s*([a-zA-Z/]*)$/) ||
        clean.match(/^(.+?)\s+(\d+(?:\.\d+)?)\s*([a-zA-Z/]*)$/);

      if (!match) { failed.push(line); continue; }

      const product = match[1].replace(/[$@\-:,]+$/, "").trim().toLowerCase();
      const amount = parseFloat(match[2]);
      const unit = match[3]?.trim().toLowerCase() || "each";

      if (!product || isNaN(amount)) { failed.push(line); continue; }
      updated.push({ product, amount, unit, inStock: true });
    }
  }

  if (!updated.length) {
    const numbered = products.map((p, i) => `${i + 1}. ${p}`).join("\n");
    await sendText(from,
`❌ Couldn't read your prices.

*Your products:*
${numbered}

*Fastest - just numbers in order:*
_${products.slice(0, 3).map((_, i) => ((i + 1) * 4) + ".00").join(", ")}_`
    );
    return;
  }

  // Preview before saving
  const previewLines = updated.map(u => `• ${u.product} - $${Number(u.amount).toFixed(2)}/${u.unit}`).join("\n");
  const failNote = failed.length ? `\n\n⚠️ Skipped ${failed.length}: _${failed.slice(0, 2).join(", ")}_` : "";

  // Temporarily store pending update
  biz.sessionData.pendingPriceUpdate = updated;
  await saveBizSafe(biz);

  return sendButtons(from, {
    text:
`💰 *Price Preview* (${updated.length} items)

${previewLines}${failNote}

Save these prices?`,
    buttons: [
      { id: "sup_price_update_confirm", title: "✅ Save Prices" },
      { id: "sup_update_prices",         title: "✏️ Re-enter" },
      { id: "my_supplier_account",       title: "🏪 Cancel" }
    ]
  });
}


// ── Confirm saved price update from account menu ──────────────────────────
if (a === "sup_price_update_confirm") {
  const supplier = await SupplierProfile.findOne({ phone });
  if (!supplier) return sendSuppliersMenu(from);

  const pending = biz?.sessionData?.pendingPriceUpdate;
  if (!pending?.length) {
    await sendText(from, "❌ No pending prices found. Please re-enter.");
    return sendSupplierAccountMenu(from, supplier);
  }

  const existing = supplier.prices || [];
  for (const u of pending) {
    const idx = existing.findIndex(p =>
      p.product?.toLowerCase() === u.product
    );
    if (idx >= 0) existing[idx] = u;
    else existing.push(u);
  }

  supplier.prices = existing;
  supplier.priceUpdatedAt = new Date();
  supplier.markModified("prices");
  await supplier.save();

  if (biz) {
    biz.sessionState = "ready";
    biz.sessionData = {};
    await saveBizSafe(biz);
  }

  const summary = pending.map(u => `✅ ${u.product} - $${Number(u.amount).toFixed(2)}/${u.unit}`).join("\n");
  await sendText(from, `✅ *Prices saved!*\n\n${summary}`);
  return sendSupplierAccountMenu(from, supplier);
}

  // ── Handle edit products text input ───────────────────────────────────────
  if (biz?.sessionState === "supplier_edit_products" && !isMetaAction) {
    const supplier = await SupplierProfile.findOne({ phone });
    if (!supplier) return sendSuppliersMenu(from);
    const products = text.split(",").map(p => p.trim().toLowerCase()).filter(Boolean);
    if (!products.length) {
      await sendText(from, "❌ Please list at least one product, comma-separated.");
      return;
    }
    supplier.products = products;
    await supplier.save();
    if (biz) { biz.sessionState = "ready"; biz.sessionData = {}; await saveBizSafe(biz); }
    await sendText(from, `✅ Products updated!\n\n${products.map(p => `• ${p}`).join("\n")}`);
    return sendSupplierAccountMenu(from, supplier);
  }

  // ── Handle edit area text input ────────────────────────────────────────────
  if (biz?.sessionState === "supplier_edit_area" && !isMetaAction) {
    const supplier = await SupplierProfile.findOne({ phone });
    if (!supplier) return sendSuppliersMenu(from);
    const parts = text.split(",").map(p => p.trim());
    supplier.location = {
      area: parts[0] || supplier.location?.area,
      city: parts[1] || supplier.location?.city || "Harare"
    };
    await supplier.save();
    if (biz) { biz.sessionState = "ready"; biz.sessionData = {}; await saveBizSafe(biz); }
    await sendText(from, `✅ Location updated to: ${supplier.location.area}, ${supplier.location.city}`);
    return sendSupplierAccountMenu(from, supplier);
  }


  // ── Start order: ask what they want ───────────────────────────────────────
// ── Start order: ask what they want ───────────────────────────────────────
 // ── Start order: show supplier's product/service list as selectable menu ──
if (a.startsWith("sup_order_")) {
  const supplierId = a.replace("sup_order_", "");
  const supplier = await SupplierProfile.findById(supplierId).lean();
  if (!supplier) return sendText(from, "❌ Supplier not found.");

  const isService = supplier.profileType === "service";

  // Store order state
  await UserSession.findOneAndUpdate(
    { phone },
    { $set: {
      "tempData.orderSupplierId": supplierId,
      "tempData.orderState": "supplier_order_picking",
      "tempData.orderCart": [],          // ← cart starts empty
      "tempData.orderIsService": isService
    }},
    { upsert: true }
  );

  if (biz) {
    biz.sessionData = {
      ...(biz.sessionData || {}),
      orderSupplierId: supplierId,
      orderCart: [],
      orderIsService: isService
    };
    biz.sessionState = "supplier_order_picking";
    await saveBizSafe(biz);
  }

  return _sendSupplierCatalogueMenu(from, supplier, []);
}



// ── Cart: buyer taps an item from catalogue ───────────────────────────────
if (a.startsWith("sup_cart_add_")) {
  // format: sup_cart_add_{supplierId}_{encodedProductName}
  const withoutPrefix = a.replace("sup_cart_add_", "");
  const firstUnderscore = withoutPrefix.indexOf("_");
  const supplierId = withoutPrefix.slice(0, firstUnderscore);
  const encodedProduct = withoutPrefix.slice(firstUnderscore + 1);
  const productName = decodeURIComponent(encodedProduct);

  const supplier = await SupplierProfile.findById(supplierId).lean();
  if (!supplier) return sendText(from, "❌ Supplier not found.");

  // Get current cart
  let cart = [];
  if (biz) {
    cart = biz.sessionData?.orderCart || [];
  } else {
    const sess = await UserSession.findOne({ phone });
    cart = sess?.tempData?.orderCart || [];
  }

  // Check if item already in cart — increment qty
  const existing = cart.find(c => c.product.toLowerCase() === productName.toLowerCase());
  if (existing) {
    existing.quantity += 1;
  } else {
    // Find price for this item
    const isService = supplier.profileType === "service";
    let priceInfo = null;
    if (isService) {
      const rate = (supplier.rates || []).find(r =>
        r.service.toLowerCase() === productName.toLowerCase()
      );
      if (rate) priceInfo = { amount: parseSupplierRateValue(rate.rate), unit: parseSupplierRateUnit(rate.rate) };
    } else {
      const price = (supplier.prices || []).find(p =>
        p.product.toLowerCase() === productName.toLowerCase()
      );
      if (price) priceInfo = { amount: Number(price.amount), unit: price.unit || "each" };
    }

    cart.push({
      product: productName,
      quantity: 1,
      unit: priceInfo?.unit || (isService ? "job" : "units"),
      pricePerUnit: priceInfo?.amount || null,
      total: priceInfo?.amount || null
    });
  }

  // Save updated cart
  if (biz) {
    biz.sessionData = { ...(biz.sessionData || {}), orderCart: cart };
    await saveBizSafe(biz);
  }
  await UserSession.findOneAndUpdate(
    { phone },
    { $set: { "tempData.orderCart": cart } },
    { upsert: true }
  );

  // Show updated catalogue with cart
  return _sendSupplierCatalogueMenu(from, supplier, cart);
}

// ── Cart: buyer confirms order from catalogue ─────────────────────────────
if (a.startsWith("sup_cart_confirm_")) {
  const supplierId = a.replace("sup_cart_confirm_", "");
  const supplier = await SupplierProfile.findById(supplierId).lean();
  if (!supplier) return sendText(from, "❌ Supplier not found.");

  let cart = [];
  if (biz) {
    cart = biz.sessionData?.orderCart || [];
  } else {
    const sess = await UserSession.findOne({ phone });
    cart = sess?.tempData?.orderCart || [];
  }

  if (!cart.length) {
    return sendText(from, "❌ Your cart is empty. Tap items to add them.");
  }

  // Show order summary and ask for address
  const isService = supplier.profileType === "service";
  const previewLines = cart.map(c => {
    const priceStr = c.pricePerUnit ? ` — $${Number(c.pricePerUnit).toFixed(2)}/${c.unit}` : "";
    return `• ${c.product} x${c.quantity}${priceStr}`;
  }).join("\n");

  const knownTotal = cart
    .filter(c => c.pricePerUnit)
    .reduce((sum, c) => sum + (c.quantity * c.pricePerUnit), 0);

  const totalLine = knownTotal > 0
    ? `\n💵 *Estimated total: $${knownTotal.toFixed(2)}*`
    : "";

  // Move to address state
  if (biz) {
    biz.sessionState = "supplier_order_address";
    await saveBizSafe(biz);
  }
  await UserSession.findOneAndUpdate(
    { phone },
    { $set: { "tempData.orderState": "supplier_order_address" } },
    { upsert: true }
  );

  return sendButtons(from, {
    text:
`${isService ? "📅" : "🛒"} *Order Summary*

${previewLines}${totalLine}

📍 *Where should we ${isService ? "come to / what's your location?" : "deliver? Or are you collecting?"}*

Reply with your address or note:
_e.g. 24 Borrowdale Rd, Harare_
_e.g. I'll collect from your shop_
_e.g. Call me on arrival_`,
    buttons: [
      { id: `sup_cart_clear_${supplierId}`, title: "✏️ Edit Order" },
      { id: "find_supplier", title: "❌ Cancel" }
    ]
  });
}

// ── Cart: buyer clears cart ───────────────────────────────────────────────
if (a.startsWith("sup_cart_clear_")) {
  const supplierId = a.replace("sup_cart_clear_", "");
  const supplier = await SupplierProfile.findById(supplierId).lean();
  if (!supplier) return sendText(from, "❌ Supplier not found.");

  if (biz) {
    biz.sessionData = { ...(biz.sessionData || {}), orderCart: [] };
    biz.sessionState = "supplier_order_picking";
    await saveBizSafe(biz);
  }
  await UserSession.findOneAndUpdate(
    { phone },
    { $set: { "tempData.orderCart": [], "tempData.orderState": "supplier_order_picking" } },
    { upsert: true }
  );

  return _sendSupplierCatalogueMenu(from, supplier, []);
}

// ── Cart: buyer wants to type a custom item not in catalogue ─────────────
if (a.startsWith("sup_cart_custom_")) {
  const supplierId = a.replace("sup_cart_custom_", "");
  const supplier = await SupplierProfile.findById(supplierId).lean();
  if (!supplier) return sendText(from, "❌ Supplier not found.");

  const isService = supplier.profileType === "service";

  if (biz) {
    biz.sessionState = "supplier_order_product";
    biz.sessionData = { ...(biz.sessionData || {}), orderSupplierId: supplierId };
    await saveBizSafe(biz);
  }
  await UserSession.findOneAndUpdate(
    { phone },
    { $set: {
      "tempData.orderState": "supplier_order_product",
      "tempData.orderSupplierId": supplierId
    }},
    { upsert: true }
  );

  return sendText(from,
`✍️ *Type your ${isService ? "service request" : "item"}*

Format: *item qty, item qty*
Example: ${isService ? "*plumbing 2 hr, welding 1 job*" : "*sugar 2 kg, flour 5 kg, rice 3*"}

Type *cancel* to go back.`);
}
  // ── sup_search_all: buyer wants to search by product name (free text) ─────
  if (a === "sup_search_all") {
  let searchType = biz?.sessionData?.supplierSearch?.type || null;

  if (!searchType) {
    const sess = await UserSession.findOne({ phone });
    searchType = sess?.tempData?.supplierSearchType || "product";
  }

  if (biz) {
    biz.sessionState = "supplier_search_product";
    biz.sessionData = {
      ...(biz.sessionData || {}),
      supplierSearch: {
        ...(biz.sessionData?.supplierSearch || {}),
        type: searchType
      }
    };
    await saveBizSafe(biz);
  } else {
    await UserSession.findOneAndUpdate(
      { phone },
      {
        $set: {
          "tempData.supplierSearchMode": "product",
          "tempData.supplierSearchType": searchType
        }
      },
      { upsert: true }
    );
  }

  return sendButtons(from, {
    text: searchType === "service"
      ? "🔍 *Search by service*\n\nType the service you are looking for:\n\nExample: _plumbing_, _car hire_, _delivery_"
      : "🔍 *Search by product*\n\nType the product name you are looking for:\n\nExample: _flour_, _cooking oil_, _tiles_",
    buttons: [{ id: "find_supplier", title: "⬅ Back" }]
  });
}

  // ── Buyer: free-text product search ──────────────────────────────────────
 if (biz?.sessionState === "supplier_search_product" && !isMetaAction) {
    const productQuery = text.trim();
    if (!productQuery || productQuery.length < 1) {
      return sendButtons(from, {
        text: "❌ Please type what you're looking for:\n\n_e.g. find cement, find plumber harare_",
        buttons: [{ id: "find_supplier", title: "⬅ Back" }]
      });
    }

    // Try shortcode parse first (handles "find cement harare", "s tiles", etc.)
    const parsed = parseShortcodeSearch(productQuery) || parseShortcodeSearch(`find ${productQuery}`);
    const finalProduct = parsed?.product || productQuery;
    const finalCity = parsed?.city || null;

    if (finalCity) {
      // City was included - run search immediately, skip city picker
      const results = await runSupplierSearch({
        city: finalCity,
        product: finalProduct,
        profileType: biz.sessionData?.supplierSearch?.type || null
      });
      biz.sessionState = "ready";
      biz.sessionData = {};
      await saveBizSafe(biz);
      if (!results.length) {
        return sendButtons(from, {
          text: `😕 No results for *${finalProduct}* in *${finalCity}*.\n\nTry a different city or search term.`,
          buttons: [
            { id: "find_supplier", title: "🔍 Search Again" },
            { id: "sup_search_city_all", title: "📍 Try All Cities" }
          ]
        });
      }
      const rows = formatSupplierResults(results, finalCity, finalProduct);
      return sendList(from, `🔍 *${finalProduct}* in ${finalCity} - ${results.length} found`, rows);
    }

    // No city - ask which city
    biz.sessionData = {
      ...(biz.sessionData || {}),
      supplierSearch: {
        ...(biz.sessionData?.supplierSearch || {}),
        product: finalProduct
      }
    };
    biz.sessionState = "supplier_search_city";
    await saveBizSafe(biz);

    return sendList(from, `🔍 Looking for: *${finalProduct}*\n\nWhich city?`, [
      ...SUPPLIER_CITIES.map(c => ({
        id: `sup_search_city_${c.toLowerCase()}`,
        title: c
      })),
      { id: "sup_search_city_all", title: "📍 All Cities" }
    ]);
  }

  // ── Buyer order: product name text input ──────────────────────────────────
if (biz?.sessionState === "supplier_order_product" && !isMetaAction) {
  const parsedItems = parseBulkOrderInput(text);

  if (!parsedItems.length || parsedItems.every(i => !i.valid)) {
   return sendText(from,
`❌ Please enter your order in this format:

*product qty, product qty*

Examples:
*sugar 2, bread 3, milk 1*
*cement 10, river sand 2*

You can also send one per line.

Type *cancel* to stop this order.`);
  }

  biz.sessionData = { ...(biz.sessionData || {}), orderItems: parsedItems };
  biz.sessionState = "supplier_order_address";
  await saveBizSafe(biz);

  const preview = parsedItems
    .map(i => `• ${i.product} x${i.quantity}${i.unitLabel && i.unitLabel !== "units" ? " " + i.unitLabel : ""}`)
    .join("\n");

const supplierIdForSummary = biz.sessionData?.orderSupplierId;
const supplierForSummary = supplierIdForSummary
  ? await SupplierProfile.findById(supplierIdForSummary).lean()
  : null;
const isServiceSupplier = supplierForSummary?.profileType === "service";

return sendText(from,
`${isServiceSupplier ? "📅" : "🛒"} *${isServiceSupplier ? "Booking Summary" : "Order Summary"}*

${preview}

Now send your ${isServiceSupplier ? "location or contact note" : "delivery address or contact note"}:

Type *cancel* to stop this ${isServiceSupplier ? "booking" : "order"}.`);
}

  // ── Buyer order: quantity text input ──────────────────────────────────────


  // ── Buyer order: address / contact note text input ────────────────────────
  if (biz?.sessionState === "supplier_order_address" && !isMetaAction) {
    const address = text.trim();
 if (!address || address.length < 2) {
  return sendText(from,
`❌ Please enter your delivery address or contact note:

Type *cancel* to stop this order.`);
}

    const supplierId = biz.sessionData?.orderSupplierId;
const orderItemsInput = biz.sessionData?.orderCart?.length
  ? biz.sessionData.orderCart
  : (biz.sessionData?.orderItems || []);

    if (!supplierId) {
      biz.sessionState = "ready"; biz.sessionData = {};
      await saveBizSafe(biz);
      await sendText(from, "❌ Order session expired. Please search for the supplier again.");
      return sendMainMenu(from);
    }

    const supplier = await SupplierProfile.findById(supplierId).lean();
    if (!supplier) {
      biz.sessionState = "ready"; biz.sessionData = {};
      await saveBizSafe(biz);
      await sendText(from, "❌ Supplier not found. Please search again.");
      return sendSuppliersMenu(from);
    }

//const qtyNum = isNaN(Number(orderQty)) ? null : Number(orderQty);
const normalizedItems = Array.isArray(orderItemsInput) ? orderItemsInput : [];
if (!normalizedItems.length) {
  biz.sessionState = "ready";
  biz.sessionData = {};
  await saveBizSafe(biz);
  await sendText(from, "❌ Order session expired. Please start again.");
  return sendSuppliersMenu(from);
}

let totalAmount = 0;
let pricedCount = 0;

const finalItems = normalizedItems.map(entry => {
  const quantity = Number(entry.quantity) || 1;
  const requestedUnit = entry.unitLabel || "units";
  const matchedPrice = findMatchingSupplierPrice(supplier, entry.product);

  let pricePerUnit = null;
  let total = null;
  let finalUnit = requestedUnit;

  if (matchedPrice && typeof matchedPrice.amount === "number") {
    pricePerUnit = matchedPrice.amount;
    total = quantity * matchedPrice.amount;
    finalUnit = matchedPrice.unit || requestedUnit;
    totalAmount += total;
    pricedCount++;
  }

  return {
    product: entry.product,
    quantity,
    unit: finalUnit,
    pricePerUnit,
    currency: "USD",
    total
  };
});

const order = await SupplierOrder.create({
  supplierId: supplier._id,
  supplierPhone: supplier.phone,
  buyerPhone: phone,
  items: finalItems,
  totalAmount,
  currency: "USD",
  delivery: {
    required: supplier.delivery?.available || false,
    address
  },
  status: "pending"
});
    await notifySupplierNewOrder(supplier.phone, order);
    biz.sessionState = "ready"; biz.sessionData = {};
    await saveBizSafe(biz);

const itemSummary = finalItems
  .map(i => `• ${i.product} x${i.quantity}${i.unit && i.unit !== "units" ? " " + i.unit : ""}`)
  .join("\n");

const isServiceSupplier = supplier.profileType === "service";

await sendText(from,
`✅ *${isServiceSupplier ? "Booking sent to" : "Order sent to"} ${supplier.businessName}!*

${itemSummary}
${isServiceSupplier ? `📍 Location/Note: ${address}` : `📍 ${address}`}
${pricedCount > 0 ? `💵 Current estimated total: $${totalAmount.toFixed(2)}\n` : ""}📞 Supplier: ${supplier.phone}

${pricedCount === finalItems.length
  ? `${isServiceSupplier ? "All services were auto-priced. Supplier can confirm immediately. 🎉" : "All items were auto-priced. Supplier can confirm immediately. 🎉"}`
  : pricedCount > 0
    ? `${isServiceSupplier ? "Some services were auto-priced. Supplier will confirm the rest. 🎉" : "Some items were auto-priced. Supplier will confirm the rest. 🎉"}`
    : `${isServiceSupplier ? "Supplier will confirm pricing for the booking shortly. 🎉" : "Supplier will confirm pricing shortly. 🎉"}`}`);

return sendButtons(from, {
  text: "What would you like to do next?",
  buttons: [
    { id: "find_supplier", title: "🔍 Find Suppliers" },
    { id: "my_orders", title: "📋 My Orders" },
    { id: ACTIONS.MAIN_MENU, title: "🏠 Main Menu" }
  ]
});

  }

  // ── Accept order ──────────────────────────────────────────────────────────
  if (a.startsWith("sup_accept_")) {
    const orderId = a.replace("sup_accept_", "");
    return handleOrderAccepted(from, orderId, biz, saveBizSafe);
  }

 if (a.startsWith("sup_book_confirm_")) {
    const orderId = a.replace("sup_book_confirm_", "");
    await handleBookingAccepted(from, orderId);
    return;
  }
  // ── Decline order ─────────────────────────────────────────────────────────
  if (a.startsWith("sup_decline_")) {
    const orderId = a.replace("sup_decline_", "");
    return handleOrderDeclined(from, orderId, biz, saveBizSafe);
  }


    if (biz?.sessionState === "supplier_order_enter_price" && !isMetaAction) {
    const orderId = biz.sessionData?.pricingOrderId;
    if (!orderId) {
      biz.sessionState = "ready";
      biz.sessionData = {};
      await saveBizSafe(biz);
      await sendText(from, "❌ Pricing session expired.");
      return sendSuppliersMenu(from);
    }

    const order = await SupplierOrder.findById(orderId);
    if (!order) {
      biz.sessionState = "ready";
      biz.sessionData = {};
      await saveBizSafe(biz);
      await sendText(from, "❌ Order not found.");
      return sendSuppliersMenu(from);
    }

    const raw = (text || "").trim();
    if (!raw) {
      await sendText(from, "❌ Enter a valid price.\n\nExample: 4.50\nOr for multiple items: 4.50, 8, 1.20");
      return;
    }

    const values = raw
      .split(",")
      .map(v => Number(v.trim()))
      .filter(v => !Number.isNaN(v) && v >= 0);

    if (!values.length) {
      await sendText(from, "❌ Invalid price format.\n\nExample: 4.50\nOr: 4.50, 8, 1.20");
      return;
    }

    if (order.items.length === 1 && values.length !== 1) {
      await sendText(from, "❌ This order has 1 item. Reply with one unit price only.\n\nExample: 4.50");
      return;
    }

    if (order.items.length > 1 && values.length !== order.items.length) {
      await sendText(from, `❌ This order has ${order.items.length} items. Please send ${order.items.length} prices separated by commas.`);
      return;
    }

    let grandTotal = 0;

    order.items = order.items.map((item, idx) => {
      const unitPrice = values[idx];
      const qty = Number(item.quantity) || 1;
      const lineTotal = qty * unitPrice;
      grandTotal += lineTotal;

      return {
        ...item.toObject?.() || item,
        pricePerUnit: unitPrice,
        total: lineTotal,
        currency: "USD"
      };
    });

    order.totalAmount = grandTotal;
    order.currency = "USD";
    order.status = "accepted";
    await order.save();

await SupplierProfile.findOneAndUpdate(
  { phone: from },
  { $inc: { monthlyOrders: 1, completedOrders: 1 } }
);
    const supplier = await SupplierProfile.findOne({ phone: from });

    biz.sessionState = "ready";
    biz.sessionData = {};
    await saveBizSafe(biz);

    const itemLines = order.items
      .map(i => {
        const unitSuffix = i.unit && i.unit !== "units" ? ` ${i.unit}` : "";
        return `• ${i.product} x${i.quantity}${unitSuffix} @ $${Number(i.pricePerUnit).toFixed(2)} = $${Number(i.total).toFixed(2)}`;
      })
      .join("\n");

    const deliveryLine = order.delivery?.required
      ? `🚚 Delivery: ${order.delivery.address || "Address not provided"}`
      : "🏠 Collection";

    try {
      await sendButtons(order.buyerPhone, {
        text:
          `✅ *Order Accepted!*\n\n` +
          `*${supplier?.businessName || from}* has accepted your order:\n\n` +
          `${itemLines}\n\n` +
          `${deliveryLine}\n` +
          `💵 *Order Total: $${grandTotal.toFixed(2)}*\n` +
          `📞 Contact: ${from}\n\n` +
          `They will be in touch to arrange payment & delivery.`,
    buttons: [
          { id: `rate_order_${order._id}`, title: "⭐ Rate Order" },
          { id: "suppliers_home",           title: "🏪 Suppliers" }
        ]
      });
    } catch (err) {
      console.error("[SUPPLIER PRICE ACCEPT → BUYER NOTIFY FAILED]", err?.response?.data || err.message);
    }

    return sendList(from, `✅ Price saved. Total: $${grandTotal.toFixed(2)}\n\nWhen will the order be ready?`, [
      { id: `sup_eta_today_${orderId}`, title: "Today" },
      { id: `sup_eta_tomorrow_${orderId}`, title: "Tomorrow" },
      { id: `sup_eta_twodays_${orderId}`, title: "2-3 days" },
      { id: `sup_eta_contact_${orderId}`, title: "I'll contact buyer" }
    ]);
  }
  // ── ETA after accepting order ─────────────────────────────────────────────
  if (a.startsWith("sup_eta_")) {
    const parts = a.replace("sup_eta_", "").split("_");
    const orderId = parts[parts.length - 1];
    const etaLabel = parts.slice(0, -1).join(" ");

    const order = await SupplierOrder.findById(orderId);
    if (order) {
      order.supplierNote = etaLabel;
      await order.save();

      await sendButtons(order.buyerPhone, {
        text: `📅 *Order Update*\n\nYour order from the supplier\nwill be ready: *${etaLabel}*\n\n📞 ${from}`,
        buttons: [{ id: ACTIONS.MAIN_MENU, title: "🏠 Main Menu" }]
      });
    }

    await sendText(from, `✅ Buyer notified. Ready: ${etaLabel}`);
    return;
  }

  // ── Supplier plan selection ───────────────────────────────────────────────
if (a.startsWith("sup_plan_")) {
    const parts = a.replace("sup_plan_", "").split("_");
    const tier = parts[0];
    const plan = parts[1];

    const planDetails = SUPPLIER_PLANS[tier]?.[plan];
    if (!planDetails) {
      await sendText(from, "❌ Invalid plan selected.");
      return sendSuppliersMenu(from);
    }

    // Ensure we have a biz session to track payment state
    if (!biz) {
      await sendText(from, "❌ Session expired. Please type *menu* and try again.");
      return;
    }

    // Store plan details and move to EcoCash entry state
    biz.sessionData = {
      ...(biz.sessionData || {}),
      supplierPayment: {
        tier,
        plan,
        amount: planDetails.price,
        currency: planDetails.currency,
        durationDays: planDetails.durationDays,
        supplierId: biz.sessionData?.pendingSupplierId || null
      }
    };
    biz.sessionState = "supplier_reg_enter_ecocash";
    await saveBizSafe(biz);

    const waDigits = from.replace(/\D+/g, "");
    return sendText(from,
`💳 *${SUPPLIER_PLANS[tier].name} Plan - $${planDetails.price} ${planDetails.currency} (${plan})*

To pay, enter your EcoCash number:
*Example: 0772123456*

Or type *same* to use this WhatsApp number (${waDigits}).

_Type *cancel* to go back._`
    );
  }

  // ── Rate order ────────────────────────────────────────────────────────────
  if (a.startsWith("rate_")) {
    const parts = a.split("_");
    // rate_poor_ORDERID / rate_ok_ORDERID / rate_great_ORDERID
    if (parts.length >= 3 && ["poor", "ok", "great"].includes(parts[1])) {
      const rating = parts[1] === "poor" ? 1 : parts[1] === "ok" ? 3 : 5;
      const orderId = parts.slice(2).join("_");
      const order = await SupplierOrder.findById(orderId);
      if (order) {
        order.buyerRating = rating;
        await order.save();
        const supplier = await SupplierProfile.findOne({ phone: order.supplierPhone });
        if (supplier) {
          const totalRatings = supplier.reviewCount + 1;
          supplier.rating = ((supplier.rating * supplier.reviewCount) + rating) / totalRatings;
          supplier.reviewCount = totalRatings;
          await supplier.save();
          await updateSupplierCredibility(supplier._id);
        }
      }
      await sendText(from, "⭐ Thanks for your rating!");
      return;
    }
  }

  // ── Suppliers menu ────────────────────────────────────────────────────────
  if (a === ACTIONS.SUPPLIERS_MENU || a === "suppliers_menu") {
    return sendSuppliersMenu(from);
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
      if (caller?.role === "owner") {
        const branches = await Branch.find({ businessId: biz._id }).lean();
        if (!branches.length) { await sendText(from, "❌ No branches found."); return sendMainMenu(from); }
        biz.sessionData = { ...(biz.sessionData || {}), cashBalAction: "view" };
        await saveBizSafe(biz);
        return sendList(from, "🏬 Select branch to view balance:", [
          ...branches.map(b => ({ id: `cashbal_branch_${b._id}`, title: `🏬 ${b.name}` })),
          { id: "cashbal_branch_all", title: "📊 All Branches" }
        ]);
      }
      if (!caller?.branchId) { await sendText(from, "❌ No branch assigned. Contact your manager."); return sendMainMenu(from); }
      return showBranchCashBalance(from, biz, caller.branchId.toString());
    }

    // ─── SET OPENING BALANCE ────────────────────────────────────────────────
    case ACTIONS.SET_OPENING_BALANCE: {
      if (!biz) return sendMainMenu(from);
      if (caller?.role === "owner") {
        const branches = await Branch.find({ businessId: biz._id }).lean();
        if (!branches.length) { await sendText(from, "❌ No branches found."); return sendMainMenu(from); }
        biz.sessionData = { ...(biz.sessionData || {}), cashBalAction: "set_opening" };
        await saveBizSafe(biz);
        return sendList(from, "🏬 Select branch to set opening balance:", [
          ...branches.map(b => ({ id: `cashbal_branch_${b._id}`, title: `🏬 ${b.name}` }))
        ]);
      }
      if (!caller?.branchId) { await sendText(from, "❌ No branch assigned. Contact your manager."); return sendMainMenu(from); }

      const CashBalance = (await import("../models/cashBalance.js")).default;
      const today = new Date(); today.setHours(0, 0, 0, 0);
      const existing = await CashBalance.findOne({ businessId: biz._id, branchId: caller.branchId, date: today }).lean();

      if (existing && existing.openingBalance > 0) {
        await sendText(from, `⚠️ Opening balance already set for today: *${existing.openingBalance} ${biz.currency}*\n\nContact your manager to change it.`);
        const { sendCashBalanceMenu } = await import("./metaMenus.js");
        return sendCashBalanceMenu(from);
      }

      biz.sessionState = "cash_set_opening_balance";
      biz.sessionData = { targetBranchId: caller.branchId.toString() };
      await saveBizSafe(biz);
      return sendButtons(from, { text: `📝 *Set Opening Balance*\n\nEnter the amount of cash in the till at the start of today:`, buttons: [{ id: ACTIONS.MAIN_MENU, title: "🏠 Main Menu" }] });
    }

    // ─── RECORD PAYOUT ──────────────────────────────────────────────────────
    case ACTIONS.RECORD_PAYOUT: {
      if (!biz) return sendMainMenu(from);
      if (caller?.role === "owner") {
        const branches = await Branch.find({ businessId: biz._id }).lean();
        if (!branches.length) { await sendText(from, "❌ No branches found."); return sendMainMenu(from); }
        biz.sessionData = { ...(biz.sessionData || {}), cashBalAction: "payout" };
        await saveBizSafe(biz);
        return sendList(from, "🏬 Select branch to record payout:", [
          ...branches.map(b => ({ id: `cashbal_branch_${b._id}`, title: `🏬 ${b.name}` }))
        ]);
      }
      if (!caller?.branchId) { await sendText(from, "❌ No branch assigned. Contact your manager."); return sendMainMenu(from); }
      biz.sessionState = "cash_payout_amount";
      biz.sessionData = { targetBranchId: caller.branchId.toString() };
      await saveBizSafe(biz);
      return sendButtons(from, { text: `💸 *Record Payout/Drawing*\n\nEnter the amount taken out of the till:`, buttons: [{ id: ACTIONS.MAIN_MENU, title: "🏠 Main Menu" }] });
    }

    case ACTIONS.REPORTS_MENU: {
      if (!biz) return sendMainMenu(from);
      if (!canUseFeature(biz, "reports_daily")) return promptUpgrade({ biz, from, feature: "Reports" });
      biz.sessionState = "reports_menu"; biz.sessionData = {}; await saveBizSafe(biz);
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
      biz.sessionState = "report_choose_branch"; biz.sessionData = { reportType: "daily" }; await saveBizSafe(biz);
      return continueTwilioFlow({ from, text: "auto" });
    }
    case "branch_weekly": {
      if (!biz) return sendMainMenu(from);
      biz.sessionState = "report_choose_branch"; biz.sessionData = { reportType: "weekly" }; await saveBizSafe(biz);
      return continueTwilioFlow({ from, text: "auto" });
    }
    case "branch_monthly": {
      if (!biz) return sendMainMenu(from);
      biz.sessionState = "report_choose_branch"; biz.sessionData = { reportType: "monthly" }; await saveBizSafe(biz);
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
      if (!caller || caller.role !== "owner") return sendText(from, "🔒 Only the business owner can invite users.");
      const pkg = PACKAGES[biz.package] || PACKAGES.trial;
      if (!pkg.features.includes("users")) return promptUpgrade({ biz, from, feature: "User management" });
      const activeUsers = await UserRole.countDocuments({ businessId: biz._id, pending: false });
      if (activeUsers >= pkg.users) return sendText(from, `🚫 User limit reached (${pkg.users}).\n\nUpgrade your package to add more users.`);
      biz.sessionState = "invite_user_choose_branch"; biz.sessionData = {}; await saveBizSafe(biz);
      const branches = await Branch.find({ businessId: biz._id }).lean();
      if (!branches.length) { await sendText(from, "No branches found. Please add a branch first."); return sendBranchesMenu(from); }
      return sendList(from, "Select branch for new user", branches.map(b => ({ id: `invite_branch_${b._id}`, title: b.name })));
    }

    case ACTIONS.BRANCHES_MENU: {
      if (!biz) return sendMainMenu(from);
      const { canAccessSection } = await import("./roleGuard.js");
      if (!caller || !canAccessSection(caller.role, "branches")) return sendText(from, "🔒 You do not have permission to access branches.");
      return sendBranchesMenu(from);
    }

    case ACTIONS.ADD_BRANCH: {
      if (!biz) return sendMainMenu(from);
      if (!canUseFeature(biz, "branches")) return promptUpgrade({ biz, from, feature: "Branches" });
      const count = await Branch.countDocuments({ businessId: biz._id });
      const { branches } = (await import("./packages.js")).PACKAGES[biz.package];
      if (count >= branches) return sendText(from, `🚫 Branch limit reached (${branches}).\nUpgrade your package to add more branches.`);
      biz.sessionState = "branch_add_name"; await saveBizSafe(biz);
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
      biz.sessionState = "assign_branch_pick_user"; biz.sessionData = {}; await saveBizSafe(biz);
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
      users.forEach((u, i) => { msg += `${i + 1}) ${u.phone} | ${u.role} | ${u.branchId?.name || "N/A"}${u.locked ? " 🔒" : ""}\n`; });
      return sendText(from, msg);
    }

    case ACTIONS.PAYMENT_IN: {
      if (!biz) return sendMainMenu(from);
      // Owner: pick a branch to show unpaid invoices from
      if (caller?.role === "owner") return sendBranchSelectorPaymentIn(from);
      await showUnpaidInvoices(from);
      return;
    }

    case ACTIONS.PAYMENT_OUT: {
      if (!biz) return sendMainMenu(from);
      // Owner: pick branch first
      if (caller?.role === "owner") return sendBranchSelectorExpense(from);
      biz.sessionState = ACTIONS.EXPENSE_CATEGORY; biz.sessionData = {}; await saveBizSafe(biz);
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
      if (!caller || !canAccessSection(caller.role, "users")) return sendText(from, "🔒 You do not have permission to access Business & Users.");
      return sendBusinessMenu(from);
    }

    // ✅ OWNER ONLY - subscription menu
    case ACTIONS.SUBSCRIPTION_MENU: {
      if (!biz) return sendMainMenu(from);
      if (!caller || caller.role !== "owner") {
        return sendText(from, "🔒 Only the business owner can manage subscriptions.");
      }
      return sendSubscriptionMenu(from);
    }

    case ACTIONS.SETTINGS_MENU: {
      if (!biz) return sendMainMenu(from);
      const { canAccessSection } = await import("./roleGuard.js");
      if (!caller || !canAccessSection(caller.role, "settings")) return sendText(from, "🔒 You do not have permission to access Settings.");
      biz.sessionState = "settings_menu"; biz.sessionData = {}; await saveBizSafe(biz);
      return sendSettingsMenu(from);
    }

    // ✅ OWNER ONLY - upgrade package
    case ACTIONS.UPGRADE_PACKAGE: {
      if (!biz) return sendMainMenu(from);
      if (!caller || caller.role !== "owner") return sendText(from, "🔒 Only the business owner can change the package.");
      biz.sessionState = "choose_package"; await saveBizSafe(biz);
      return sendPackagesMenu(from, biz.package);
    }

    case ACTIONS.BACK:
      return sendMainMenu(from);

    // ─── NEW INVOICE / QUOTE / RECEIPT ────────────────────────────────────
    case ACTIONS.NEW_INVOICE: {
      if (!biz) return sendMainMenu(from);
      // Owner picks which branch the invoice goes to
      if (caller?.role === "owner") return sendBranchSelectorNewDoc(from, "invoice");
      return startInvoiceFlow(from);
    }

    case ACTIONS.NEW_QUOTE: {
      if (!biz) return sendMainMenu(from);
      if (biz.package === "trial") return promptUpgrade({ biz, from, feature: "Quotes" });
      if (caller?.role === "owner") return sendBranchSelectorNewDoc(from, "quote");
      return startQuoteFlow(from);
    }

    case ACTIONS.NEW_RECEIPT: {
      if (!biz) return sendMainMenu(from);
      if (biz.package === "trial") return promptUpgrade({ biz, from, feature: "Receipts" });
      if (caller?.role === "owner") return sendBranchSelectorNewDoc(from, "receipt");
      return startReceiptFlow(from);
    }

    case ACTIONS.VIEW_INVOICES: {
      if (!biz) return sendMainMenu(from);
      if (caller?.role === "owner") return sendBranchSelectorInvoices(from);
      return showSalesDocs(from, "invoice");
    }

    case ACTIONS.VIEW_QUOTES: {
      if (!biz) return sendMainMenu(from);
      if (caller?.role === "owner") return sendBranchSelectorQuotes(from);
      return showSalesDocs(from, "quote");
    }

    case ACTIONS.VIEW_RECEIPTS: {
      if (!biz) return sendMainMenu(from);
      if (caller?.role === "owner") return sendBranchSelectorReceipts(from);
      return showSalesDocs(from, "receipt");
    }

case ACTIONS.ADD_CLIENT: {
      if (!biz) return sendMainMenu(from);
      if (caller?.role === "owner") return sendBranchSelectorAddClient(from);
      biz.sessionState = "adding_client_name";
      biz.sessionData = {};
      await saveBizSafe(biz);
      return sendButtons(from, {
        text: "👥 *Add Client*\n\nEnter client full name:",
        buttons: [{ id: ACTIONS.MAIN_MENU, title: "🏠 Main Menu" }]
      });
    }
    case ACTIONS.PRODUCTS_MENU:
      return sendProductsMenu(from);

    case ACTIONS.VIEW_PRODUCTS: {
      if (!biz) return sendMainMenu(from);
      if (caller?.role === "owner") return sendBranchSelectorProducts(from);
      const query = { businessId: biz._id, isActive: true };
      if (caller?.branchId) query.branchId = caller.branchId;
      const products = await Product.find(query).lean();
      if (!products.length) { await sendText(from, "📦 No products found for your branch."); return sendMainMenu(from); }
      let msg = "📦 *Products (Your Branch):*\n\n";
      products.forEach((p, i) => { msg += `${i + 1}) *${p.name}* - ${formatMoney(p.unitPrice, biz.currency)}\n`; });
      await sendText(from, msg);
      return sendMainMenu(from);
    }

    case ACTIONS.VIEW_CLIENTS: {
      if (!biz) return sendMainMenu(from);
      if (caller?.role === "owner") return sendBranchSelectorViewClients(from);
      return showClientsList(from, biz, caller?.branchId || null);
    }

    case ACTIONS.BULK_UPLOAD_PRODUCTS: {
      if (!biz) return sendMainMenu(from);
      biz.sessionState = "bulk_upload_products"; biz.sessionData = {}; await saveBizSafe(biz);
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

Reply *done* when finished, or *cancel* to exit.`);
    }

    case ACTIONS.BULK_UPLOAD_MENU:
      return sendButtons(from, {
        text: "📋 *Bulk Paste (Products & Services)*\n\nPaste items (one per line).",
        buttons: [{ id: ACTIONS.BULK_PASTE_MODE, title: "📋 Paste list" }, { id: ACTIONS.BACK, title: "⬅ Back" }]
      });

    case ACTIONS.BULK_PASTE_MODE: {
      if (!biz) return sendMainMenu(from);
      biz.sessionState = "bulk_paste_input"; biz.sessionData = {}; await saveBizSafe(biz);
      return sendText(from,
`📋 *Bulk Add Products*

✅ Format: Name, Price | Name, Price

Example:
Milk 1L, 1.50 | Bread, 2 | Math Lesson, 10

Paste now, or reply *done* to finish.`);
    }

 case ACTIONS.BULK_EXPENSE_MODE: {
      if (!biz) return sendMainMenu(from);
      // Owner picks branch first
      if (caller?.role === "owner") return sendBranchSelectorBulkExpense(from);
      biz.sessionState = "bulk_expense_input"; 
      biz.sessionData = { bulkExpenses: [] }; 
      await saveBizSafe(biz);
      return sendText(from,
`💰 *Bulk Expense Mode*

Type expenses separated by commas:
*lunch 10, cables 5, transport 20*

Categories auto-detected ✨

*Commands:*
- 'list' - Show all
- 'remove 2' - Delete #2
- 'done' - Save all
- 'help' - More info`);
    }



    case ACTIONS.SUBSCRIPTION_PAYMENTS: {
      if (!biz) return sendMainMenu(from);
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
      // Owner: pick branch first
      if (caller?.role === "owner") return sendBranchSelectorViewExpenses(from);
      return showExpenseReceipts(from, biz, caller?.branchId || null);
    }

    case ACTIONS.VIEW_PAYMENT_HISTORY: {
      if (!biz) return sendMainMenu(from);
      // Owner: pick branch first
      if (caller?.role === "owner") return sendBranchSelectorPaymentHistory(from);
      return showPaymentHistory(from, biz, caller?.branchId || null);
    }

   case ACTIONS.MAIN_MENU:
      return sendMainMenu(from);

    case ACTIONS.SUPPLIERS_MENU:
      return sendSuppliersMenu(from);

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

      // "cashbal_branch_all"
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

// ─────────────────────────────────────────────────────────────────────────────
// SHARED DISPLAY HELPERS
// ─────────────────────────────────────────────────────────────────────────────

async function showClientsList(from, biz, branchId) {
  const Client = (await import("../models/client.js")).default;
  let clients;

  if (branchId) {
    const branchInvoices = await Invoice.find({ businessId: biz._id, branchId }).distinct("clientId");
    clients = await Client.find({ businessId: biz._id, _id: { $in: branchInvoices } }).lean();
  } else {
    clients = await Client.find({ businessId: biz._id }).lean();
  }

  if (!clients.length) {
    const branch = branchId ? await Branch.findById(branchId) : null;
    await sendText(from, branch ? `📋 No clients found for *${branch.name}*.` : "📋 No clients found.");
    return sendClientsMenu(from);
  }

  const branch = branchId ? await Branch.findById(branchId) : null;
  let msg = branch ? `👥 *Clients - ${branch.name}:*\n\n` : "👥 *All Clients:*\n\n";
  clients.forEach((c, i) => {
    msg += `${i + 1}. *${c.name || "No name"}*\n`;
    if (c.phone) msg += `   📞 ${c.phone}\n`;
    if (c.email) msg += `   📧 ${c.email}\n`;
    msg += "\n";
  });

  await sendText(from, msg);
  return sendClientsMenu(from);
}



// ── Build and send the supplier catalogue as a WhatsApp list ─────────────
async function _sendSupplierCatalogueMenu(from, supplier, cart = []) {
  const isService = supplier.profileType === "service";

  // Build item rows from rates (service) or prices (product)
  const items = isService
    ? (supplier.rates || []).map(r => ({
        id: r.service,
        label: r.service,
        price: r.rate,
        display: `${r.service} — ${r.rate}`
      }))
    : (supplier.prices || [])
        .filter(p => p.inStock !== false)
        .map(p => ({
          id: p.product,
          label: p.product,
          price: `$${Number(p.amount).toFixed(2)}/${p.unit}`,
          display: `${p.product} — $${Number(p.amount).toFixed(2)}/${p.unit}`
        }));

  // Fallback: supplier listed products but no prices
  const fallbackItems = (supplier.products || [])
    .filter(p => p !== "pending_upload")
    .map(p => ({ id: p, label: p, price: null, display: p }));

  const sourceItems = items.length ? items : fallbackItems;

  if (!sourceItems.length) {
    // No products at all — fall back to free-text order
    return sendText(from,
`${isService ? "📅" : "🛒"} *${isService ? "Book with" : "Order from"} ${supplier.businessName}*

Type what you need:
*Format:* item qty, item qty
*Example:* ${isService ? "plumbing 2 hr, welding 1 job" : "sugar 2, bread 3, milk 1"}

Type *cancel* to stop.`);
  }

  // Show cart summary at top if items already added
  let cartSummary = "";
  if (cart.length) {
    cartSummary = `🛒 *Cart (${cart.length} item${cart.length > 1 ? "s" : ""}):*\n` +
      cart.map(c => `• ${c.product} x${c.quantity}`).join("\n") + "\n\n";
  }

  // Build list rows — cap at 10 (WhatsApp limit)
  const rows = sourceItems.slice(0, 10).map(item => ({
    id: `sup_cart_add_${supplier._id}_${encodeURIComponent(item.id)}`,
    title: item.label.slice(0, 24),           // WhatsApp title limit
    description: item.price ? item.price.slice(0, 72) : ""
  }));

  // Add cart action rows
  if (cart.length) {
    rows.push({ id: `sup_cart_confirm_${supplier._id}`, title: "✅ Confirm Order" });
    rows.push({ id: `sup_cart_clear_${supplier._id}`, title: "🗑 Clear Cart" });
  }

  rows.push({ id: `sup_cart_custom_${supplier._id}`, title: "✍️ Type Custom Item" });

  return sendList(from,
    `${cartSummary}${isService ? "🔧" : "📦"} *${supplier.businessName}*\nTap items to add to your order:`,
    rows
  );
}
async function showExpenseReceipts(from, biz, branchId) {
  const Expense = (await import("../models/expense.js")).default;
  const query = { businessId: biz._id };
  if (branchId) query.branchId = branchId;

  const expenses = await Expense.find(query).sort({ createdAt: -1 }).limit(10).lean();

  if (!expenses.length) {
    const branch = branchId ? await Branch.findById(branchId) : null;
    await sendText(from, branch ? `📋 No expense receipts found for *${branch.name}*.` : "📋 No expense receipts found.");
    return sendPaymentsMenu(from);
  }

  const branch = branchId ? await Branch.findById(branchId) : null;
  let msg = branch
    ? `🧾 *Recent Expense Receipts - ${branch.name}:*\n\n`
    : "🧾 *Recent Expense Receipts (All Branches):*\n\n";

  expenses.forEach((e, i) => {
    const date = new Date(e.createdAt).toLocaleDateString();
    msg += `${i + 1}. *${e.category || "Other"}* - ${e.amount} ${biz.currency}\n`;
    msg += `   ${e.description || "No description"}\n`;
    msg += `   ${date} (${e.method || "Unknown method"})\n\n`;
  });

  await sendText(from, msg);
  return sendPaymentsMenu(from);
}

async function showPaymentHistory(from, biz, branchId) {
  const InvoicePayment = (await import("../models/invoicePayment.js")).default;
  const query = { businessId: biz._id };
  if (branchId) query.branchId = branchId;

  const payments = await InvoicePayment.find(query).sort({ createdAt: -1 }).limit(10).lean();

  if (!payments.length) {
    const branch = branchId ? await Branch.findById(branchId) : null;
    await sendText(from, branch ? `📋 No payment history found for *${branch.name}*.` : "📋 No payment history found.");
    return sendPaymentsMenu(from);
  }

  const branch = branchId ? await Branch.findById(branchId) : null;
  let msg = branch
    ? `💵 *Recent Payments - ${branch.name}:*\n\n`
    : "💵 *Recent Payments (All Branches):*\n\n";

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

// ─── Cash balance display helpers ─────────────────────────────────────────────

async function showBranchCashBalance(from, biz, branchId) {
  const CashBalance = (await import("../models/cashBalance.js")).default;
  const CashPayout = (await import("../models/cashPayout.js")).default;
  const InvoicePayment = (await import("../models/invoicePayment.js")).default;
  const BranchModel = (await import("../models/branch.js")).default;
  const InvoiceModel = (await import("../models/invoice.js")).default;
  const Expense = (await import("../models/expense.js")).default;

  const branch = await BranchModel.findById(branchId).lean();
  const branchName = branch?.name || "Branch";

  const today = new Date(); today.setHours(0, 0, 0, 0);
  const tomorrow = new Date(today); tomorrow.setDate(tomorrow.getDate() + 1);

  const balance = await CashBalance.findOne({ businessId: biz._id, branchId, date: today }).lean();

  const cashPayments = await InvoicePayment.find({ businessId: biz._id, branchId, createdAt: { $gte: today, $lt: tomorrow } }).lean();
  const cashReceipts = await InvoiceModel.find({ businessId: biz._id, branchId, type: "receipt", createdAt: { $gte: today, $lt: tomorrow } }).lean();
  const expenses = await Expense.find({ businessId: biz._id, branchId, createdAt: { $gte: today, $lt: tomorrow } }).lean();

  let payouts = [];
  try {
    payouts = await CashPayout.find({ businessId: biz._id, branchId, date: today }).lean();
  } catch (_) {}

  const cur = biz.currency;
  const opening = balance?.openingBalance ?? 0;
  const cashIn = cashPayments.reduce((s, p) => s + p.amount, 0) + cashReceipts.reduce((s, r) => s + r.total, 0);
  const cashOutExpenses = expenses.reduce((s, e) => s + e.amount, 0);
  const cashOutPayouts = payouts.reduce((s, p) => s + p.amount, 0);
  const cashOut = cashOutExpenses + cashOutPayouts;
  const closing = opening + cashIn - cashOut;

  let msg = `💰 *Cash Balance - ${branchName}*\n📅 ${today.toDateString()}\n\n`;
  msg += `━━━━━━━━━━━━━━\n`;
  msg += `📂 *Opening Balance:* ${opening} ${cur}\n\n`;
  msg += `📈 *Cash In:* +${cashIn} ${cur}\n`;
  if (cashPayments.length > 0) msg += `   • Invoice payments: ${cashPayments.reduce((s, p) => s + p.amount, 0)} ${cur} (${cashPayments.length})\n`;
  if (cashReceipts.length > 0) msg += `   • Receipt sales: ${cashReceipts.reduce((s, r) => s + r.total, 0)} ${cur} (${cashReceipts.length})\n`;
  msg += `\n📉 *Cash Out:* -${cashOut} ${cur}\n`;
  if (cashOutExpenses > 0) {
    msg += `   • Expenses: ${cashOutExpenses} ${cur} (${expenses.length})\n`;
    const expByCategory = {};
    expenses.forEach(e => { expByCategory[e.category || "Other"] = (expByCategory[e.category || "Other"] || 0) + e.amount; });
    Object.entries(expByCategory).forEach(([cat, amt]) => { msg += `     – ${cat}: ${amt} ${cur}\n`; });
  }
  if (cashOutPayouts > 0) {
    msg += `   • Payouts/Drawings: ${cashOutPayouts} ${cur} (${payouts.length})\n`;
    payouts.forEach(p => { msg += `     – ${p.reason || "No reason"}: ${p.amount} ${cur}\n`; });
  }
  msg += `\n━━━━━━━━━━━━━━\n`;
  msg += `${closing >= opening ? "📈" : "📉"} *Closing Balance: ${closing} ${cur}*\n`;
  msg += `━━━━━━━━━━━━━━\n`;
  if (opening === 0 && cashIn === 0) msg += `\n⚠️ No opening balance set for today.`;

  await sendText(from, msg);
  const { sendCashBalanceMenu } = await import("./metaMenus.js");
  return sendCashBalanceMenu(from);
}

async function showAllBranchesCashBalance(from, biz) {
  const CashBalance = (await import("../models/cashBalance.js")).default;
  const BranchModel = (await import("../models/branch.js")).default;

  const today = new Date(); today.setHours(0, 0, 0, 0);
  const branches = await BranchModel.find({ businessId: biz._id }).lean();
  if (!branches.length) { await sendText(from, "❌ No branches found."); return sendMainMenu(from); }

  const cur = biz.currency;
  let msg = `💰 *Cash Balance Summary - All Branches*\n📅 ${today.toDateString()}\n\n`;
  let totalOpening = 0, totalIn = 0, totalOut = 0;

  for (const branch of branches) {
    const balance = await CashBalance.findOne({ businessId: biz._id, branchId: branch._id, date: today }).lean();
    const opening = balance?.openingBalance ?? 0;
    const cashIn = balance?.cashIn ?? 0;
    const cashOut = balance?.cashOut ?? 0;
    const closing = opening + cashIn - cashOut;
    totalOpening += opening; totalIn += cashIn; totalOut += cashOut;
    msg += `🏬 *${branch.name}*\n`;
    msg += `   Opening: ${opening} ${cur}\n`;
    msg += `   Cash In: +${cashIn} ${cur}\n`;
    msg += `   Cash Out: -${cashOut} ${cur}\n`;
    msg += `   ${closing >= opening ? "📈" : "📉"} Closing: *${closing} ${cur}*\n\n`;
  }

  msg += `━━━━━━━━━━━━━━\n📊 *TOTAL*\n`;
  msg += `   Opening: ${totalOpening} ${cur}\n   Cash In: +${totalIn} ${cur}\n   Cash Out: -${totalOut} ${cur}\n`;
  msg += `   Closing: *${totalOpening + totalIn - totalOut} ${cur}*\n`;

  await sendText(from, msg);
  const { sendCashBalanceMenu } = await import("./metaMenus.js");
  return sendCashBalanceMenu(from);
}