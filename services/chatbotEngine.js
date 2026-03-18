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
a === "sup_price_confirm_yes" ||
      a === "sup_price_confirm_no" ||
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
     a.startsWith("cashbal_branch_") ||
      a === "sup_search_next_page" ||
      a === "sup_search_prev_page"
    
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
      area: parsed.area || null,
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
  const pageResults = results.slice(0, 9);
    const rows = formatSupplierResults(pageResults, parsed.city, parsed.product);
    const hasMore = results.length > 9;
    if (hasMore) {
      await UserSession.findOneAndUpdate({ phone }, {
        $set: { "tempData.searchResults": results, "tempData.searchPage": 0 }
      }, { upsert: true });
      rows.push({ id: "sup_search_next_page", title: `➡ More results (${results.length - 9} more)` });
    }
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
a.startsWith("sup_cart_remove_") ||
a.startsWith("sup_cart_custom_") ||
  a === "sup_search_next_page" ||
  a === "sup_search_prev_page" ||
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
          product: shortcode.product,
          area: shortcode.area || null
        });
        if (results.length) {
const pageResults = results.slice(0, 9);
          const rows = formatSupplierResults(pageResults, shortcode.city, shortcode.product);
          const locationLabel = shortcode.area
            ? `${shortcode.area}, ${shortcode.city}`
            : shortcode.city;
          const hasMore = results.length > 9;
          if (hasMore) {
            await UserSession.findOneAndUpdate({ phone }, {
              $set: { "tempData.searchResults": results, "tempData.searchPage": 0 }
            }, { upsert: true });
            rows.push({ id: "sup_search_next_page", title: `➡ More results (${results.length - 9} more)` });
          }
          return sendList(from, `🔍 *${shortcode.product}* in ${locationLabel} - ${results.length} found`, rows);
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
"supplier_reg_confirm", "supplier_reg_enter_ecocash",
  "supplier_reg_payment_pending", "supplier_search_city", "supplier_decline_reason",
  "supplier_reg_type",
  "supplier_reg_travel",
  "supplier_reg_city",       // ← ADD
  "supplier_reg_category",   // ← ADD
  "supplier_reg_delivery",   // ← ADD
  "supplier_search_product",
  "supplier_order_product",
  "supplier_order_address",
  "supplier_order_enter_price",
    "supplier_order_confirm_price",  // ← ADD THIS
  "supplier_order_picking",
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
        product: shortcode.product,
        area: shortcode.area || null
      });
    if (results.length) {
        // ── CRITICAL FIX: always update biz.sessionData with the CURRENT search product ──
        // Without this, sup_order_ reads a stale product from a previous search.
        biz.sessionData = {
          ...(biz.sessionData || {}),
          supplierSearch: { product: shortcode.product, city: shortcode.city }
        };
        // Also update UserSession so it's consistent for all code paths
        await UserSession.findOneAndUpdate(
          { phone },
          { $set: { "tempData.supplierSearchProduct": shortcode.product } },
          { upsert: true }
        );
   // Sync to UserSession so sup_order_ always gets the current search product
        await UserSession.findOneAndUpdate(
          { phone },
          { $set: { "tempData.supplierSearchProduct": shortcode.product } },
          { upsert: true }
        );
        const pageResults = results.slice(0, 9);
        const rows = formatSupplierResults(pageResults, shortcode.city, shortcode.product);
        const locationLabel = shortcode.area
            ? `${shortcode.area}, ${shortcode.city}`
            : shortcode.city;
        const hasMore = results.length > 9;
        if (hasMore) {
          biz.sessionData = { ...(biz.sessionData || {}), searchResults: results, searchPage: 0 };
          rows.push({ id: "sup_search_next_page", title: `➡ More results (${results.length - 9} more)` });
        }
        await saveBizSafe(biz);
        return sendList(from, `🔍 *${shortcode.product}* in ${locationLabel} - ${results.length} found`, rows);
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
        // Do nothing here - fall through to the order state handlers below
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
  // Clear previous search state in BOTH biz and UserSession to prevent stale pre-seeding
  if (biz) {
    biz.sessionData = {
      ...(biz.sessionData || {}),
      supplierSearch: {}
    };
    biz.sessionState = "supplier_search_product";
    await saveBizSafe(biz);
  }
  // Always clear UserSession regardless of biz — covers ghost-biz users too
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
  const phone = from.replace(/\D+/g, "");

  const items = isService
    ? (supplier.rates || []).map(r => ({
        id: r.service,
        label: r.service,
        price: r.rate
      }))
    : (supplier.prices || [])
        .filter(p => p.inStock !== false)
        .map(p => ({
          id: p.product,
          label: p.product,
          price: `$${Number(p.amount).toFixed(2)}/${p.unit}`
        }));

  const fallbackItems = (supplier.products || [])
    .filter(p => p !== "pending_upload")
    .map(p => ({ id: p, label: p, price: null }));

  const sourceItems = items.length ? items : fallbackItems;

  // ── No products at all ────────────────────────────────────────────────────
  if (!sourceItems.length) {
    if (biz) {
      biz.sessionState = "supplier_order_product";
      biz.sessionData = { ...(biz.sessionData || {}), orderSupplierId: String(supplier._id) };
      await saveBizSafe(biz);
    }
    await UserSession.findOneAndUpdate(
      { phone },
      { $set: { "tempData.orderState": "supplier_order_product", "tempData.orderSupplierId": String(supplier._id) }},
      { upsert: true }
    );
    return sendText(from,
`${isService ? "📅" : "🛒"} *Order from ${supplier.businessName}*

✍️ *Type your order like this:*
_item name quantity, item name quantity_

*Examples:*
${isService
  ? `_plumbing 2 hr_\n_welding 1 job, painting 1 day_`
  : `_sugar 2 kg, bread 3, cooking oil 1_\n_cement 10 bags, river sand 2 trips_`}

📌 *Commands:*
- *cancel* -cancel this order

Send your order now 👇`);
  }

  // ── Cart summary text ─────────────────────────────────────────────────────
  let cartSummary = "";
  if (cart.length) {
    const cartTotal = cart.filter(c => c.pricePerUnit).reduce((s, c) => s + c.quantity * c.pricePerUnit, 0);
    const totalStr  = cartTotal > 0 ? ` · Est. *$${cartTotal.toFixed(2)}*` : "";
    const totalQty  = cart.reduce((s, c) => s + c.quantity, 0);
    cartSummary =
      `🛒 *Cart (${totalQty} item${totalQty > 1 ? "s" : ""}${totalStr}):*\n` +
      cart.map((c, i) => `${i + 1}. ${c.product} ×${c.quantity}${c.pricePerUnit ? ` = $${(c.quantity * c.pricePerUnit).toFixed(2)}` : ""}`).join("\n") +
      "\n";
  }

 const WHATSAPP_MAX   = 10;
  const removeRowCount = cart.length ? Math.min(cart.length, 2) : 0;
  const actionSlots    = cart.length ? (removeRowCount + 2) : 0;
  const productSlots   = WHATSAPP_MAX - actionSlots - 1;

  const isBigCatalogue = sourceItems.length > productSlots;

  // ── BIG CATALOGUE: Option C -numbered text list + minimal action panel ───
  if (isBigCatalogue) {
    // Build numbered price list -plain text, unlimited length, no scrolling trap
    const priceListLines = sourceItems.map((item, i) => {
      const priceStr = item.price ? ` -${item.price}` : "";
      return `${i + 1}. ${item.label}${priceStr}`;
    }).join("\n");

    // Cart status block -shown only when buyer has already selected items
    let cartStatus = "";
    if (cart.length) {
      const cartTotal = cart.filter(c => c.pricePerUnit).reduce((s, c) => s + c.quantity * c.pricePerUnit, 0);
      cartStatus =
        `\n✅ *Items selected so far:*\n` +
        cart.map((c, i) => `${i + 1}. ${c.product} ×${c.quantity}${c.pricePerUnit ? ` = $${(c.quantity * c.pricePerUnit).toFixed(2)}` : ""}`).join("\n") +
        (cartTotal > 0 ? `\n💵 *Running total: $${cartTotal.toFixed(2)}*` : "") +
        "\n";
    }

    // Send the numbered price list as a plain text message -buyer can see ALL items, scroll freely
    await sendText(from,
`${isService ? "🔧" : "📦"} *${supplier.businessName}*
${isService ? "Services & Rates" : "Products & Prices"} -${sourceItems.length} items
${cartStatus}
${priceListLines}

─────────────────
*📌 How to order -choose any style:*

*Style 1 -Item number + quantity:*
_1x5, 3x2, 6x20_
_(item 1 qty 5, item 3 qty 2, item 6 qty 20)_

*Style 2 -Item name + quantity:*
_cement 5, river sand 2, bricks 500_

*Style 3 -Mixed (numbers and names both work):*
_1x5, sand 2, 6x20_

*Increase qty:* type item again e.g. _cement_ or _1x1_ adds 1 more

*Commands:*
- *confirm* -finish and send your order
- *r1* or *remove cement* -remove an item
- *clear* -empty cart and start fresh
- *cancel* -go back`);

    // Minimal action panel -ONLY action buttons, no product rows competing for space
    const actionRows = [];

    if (cart.length) {
      const totalQty = cart.reduce((s, c) => s + c.quantity, 0);
      actionRows.push({
        id: `sup_cart_confirm_${supplier._id}`,
        title: `✅ Confirm Order (${totalQty} item${totalQty !== 1 ? "s" : ""})`
      });
      actionRows.push({
        id: `sup_cart_clear_${supplier._id}`,
        title: "🗑 Clear Cart & Start Over"
      });
      actionRows.push({
        id: "find_supplier",
        title: "❌ Cancel"
      });
    } else {
      // No cart yet -just show guidance rows
      actionRows.push({
        id: `sup_cart_custom_${supplier._id}`,
        title: "✍️ Type order above ↑"
      });
      actionRows.push({
        id: "find_supplier",
        title: "🔍 Find Different Supplier"
      });
      actionRows.push({
        id: `sup_cart_clear_${supplier._id}`,
        title: "❌ Cancel"
      });
    }

    return sendList(from,
      cart.length
        ? `🛒 *${supplier.businessName}* · ${cart.reduce((s,c)=>s+c.quantity,0)} item${cart.reduce((s,c)=>s+c.quantity,0) !== 1 ? "s" : ""} selected -tap Confirm or keep adding`
        : `📋 *${supplier.businessName}* · ${sourceItems.length} items -see full list above, type to order`,
      actionRows
    );
  }

  // ── SMALL CATALOGUE (≤ productSlots items): keep original tappable list ───
  const rows = sourceItems.slice(0, productSlots).map(item => ({
    id: `sup_cart_add_${supplier._id}_${encodeURIComponent(item.id)}`,
    title: item.label.slice(0, 24),
    description: item.price ? String(item.price).slice(0, 72) : "Tap to add to cart"
  }));

  if (cart.length) {
    cart.slice(0, removeRowCount).forEach(c => {
      rows.push({
        id: `sup_cart_remove_${supplier._id}_${encodeURIComponent(c.product)}`,
        title: `➖ Remove: ${c.product.slice(0, 18)}`
      });
    });
    rows.push({ id: `sup_cart_confirm_${supplier._id}`, title: "✅ Confirm & Send Order" });
    rows.push({ id: `sup_cart_clear_${supplier._id}`,   title: "🗑 Clear Cart" });
  }

  rows.push({
    id: `sup_cart_custom_${supplier._id}`,
    title: `✍️ Type Custom Item`
  });

  if (rows.length > 10) rows.splice(10);

  const shortCartLine = cart.length
    ? `🛒 ${cart.reduce((s,c)=>s+c.quantity,0)} item${cart.reduce((s,c)=>s+c.quantity,0) !== 1 ? "s" : ""} in cart · `
    : "";

const catalogueHint = cart.length > 0
    ? (isService
        ? `_Tap ✅ Confirm to book, or add more services_`
        : `_Tap ✅ Confirm to order, or add more items_`)
    : `_Tap an item to add it to your ${isService ? "booking" : "order"}_`;

const catalogueActionHint = cart.length > 0
    ? (isService
        ? `_Tap ✅ Confirm to book, or add more services_`
        : `_Tap ✅ Confirm to order, or add more items_`)
    : `_Tap to add to your ${isService ? "booking" : "order"}_`;

  return sendList(from,
    `${shortCartLine}${isService ? "🔧" : "📦"} *${supplier.businessName}*\n${catalogueActionHint}`,
    rows
  );
}

// ── Build and send the supplier registration confirm summary ─────────────
async function _sendSupplierConfirmPrompt(from, reg = {}) {
  const isService = reg.profileType === "service";

  const productList = (reg.products || [])
    .filter(p => p !== "pending_upload")
    .slice(0, 6)
    .join(", ") || "_(to be added)_";

  const priceSummary = isService
    ? (Array.isArray(reg.rates) && reg.rates.length
        ? reg.rates.slice(0, 3).map(r => `${r.service} (${r.rate})`).join(", ") +
          (reg.rates.length > 3 ? ` +${reg.rates.length - 3} more` : "")
        : "_Rates to be added_")
    : (Array.isArray(reg.prices) && reg.prices.length
        ? reg.prices.slice(0, 3).map(p => `${p.product} $${Number(p.amount).toFixed(2)}`).join(", ") +
          (reg.prices.length > 3 ? ` +${reg.prices.length - 3} more` : "")
        : "_Prices to be added_");

  const deliveryLine = isService
    ? (reg.travelAvailable ? "🚗 Travels to clients" : "📍 Clients visit provider")
    : (reg.delivery?.available ? "🚚 Delivers to buyers" : "🏠 Collection only");

  const productLabel = reg.products?.[0] === "pending_upload"
    ? "_(Catalogue to be uploaded)_"
    : productList;

  return sendButtons(from, {
    text:
`✅ *Almost done! Confirm your listing:*

🏪 *${reg.businessName || "Not set"}*
📍 ${reg.area || ""}, ${reg.city || ""}
${isService ? "🔧" : "📦"} ${productLabel}
${deliveryLine}
💰 ${priceSummary}

_Is this correct?_`,
    buttons: [
      { id: "sup_confirm_yes", title: "✅ Confirm & List" },
      { id: "sup_confirm_no",  title: "❌ Start Over" }
    ]
  });
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