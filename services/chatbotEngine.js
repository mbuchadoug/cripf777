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
import PhoneContact from "../models/phoneContact.js";
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
  sendSupplierMoreOptionsMenu,
} from "./metaMenus.js";

import { getBizForPhone, saveBizSafe } from "./bizHelpers.js";
import { sendText } from "./metaSender.js";
import { importCsvFromMetaDocument } from "./csvImport.js";
import axios from "axios";

// ─── Supplier Platform Imports ────────────────────────────────────────────────
import SupplierProfile from "../models/supplierProfile.js";
import SupplierOrder from "../models/supplierOrder.js";
import SupplierSubscriptionPayment from "../models/supplierSubscriptionPayment.js";
import BuyerRequest from "../models/buyerRequest2.js";
import {
  SUPPLIER_PLANS,
  SUPPLIER_CITIES,
  SUPPLIER_CATEGORIES,
SERVICE_COLLAR_GROUPS
} from "./supplierPlans.js";
import {
  startSupplierRegistration,
  handleSupplierRegistrationStates
} from "./supplierRegistration.js";
import {
  startSupplierSearch,
  runSupplierSearch,
  runSupplierOfferSearch,
  formatSupplierResults,
  formatSupplierOfferResults,
  parseShortcodeSearch
} from "./supplierSearch.js";
import {
  notifySupplierNewOrder,
  handleOrderAccepted,
  handleOrderDeclined,
  handleBookingAccepted
} from "./supplierOrders.js";
import {
  trackSupplierResponseSpeed,
  getBuyerOpenRequests,
  formatBuyerQuoteComparison,
  formatRequestSummary
} from "./buyerRequests.js";
import { notifySupplierNewRequestTemplate } from "./buyerRequestNotifications.js";
import { findSuppliersForRequest, getVagueTermClarification } from "./requestMatchEngine.js";
import { sendRatingPrompt, updateSupplierCredibility } from "./supplierRatings.js";

import SchoolProfile from "../models/schoolProfile.js";
import {
  startSchoolRegistration,
  handleSchoolRegistrationStates,
  handleSchoolRegistrationActions
} from "./schoolRegistration.js";
import {
  startSchoolSearch,
  handleSchoolSearchActions,
  handleSchoolAdminStates,
  runSchoolShortcodeSearch,
  handleZqDeepLink,
  handleSchoolSlugSearch,
  handleSmartCardMenu,
  handleSmartCardSourceLink,
  handleMyLeads,
  handleFollowUpLead
} from "./schoolSearch.js";

import {
  showSchoolFAQMenu,
  handleSchoolFAQAction,
  handleSchoolFAQState
} from "./schoolFAQ.js";

import {
  showSellerMenu,
  handleSellerChatAction,
  handleSellerChatState,
  handleSellerPriceReply
} from "./sellerChat.js";
 

// ─── Helpers ──────────────────────────────────────────────────────────────────

function msDays(ms) { return ms / (1000 * 60 * 60 * 24); }
function clamp(n, min, max) { return Math.max(min, Math.min(max, n)); }
function round2(n) { return Math.round(n * 100) / 100; }

// ── findSupplierByPhone ───────────────────────────────────────────────────────
// Checks all 3 phone formats: "263773...", "+263773...", "0773..."
async function findSupplierByPhone(rawPhone) {
  const digits = String(rawPhone || "").replace(/\D+/g, "");
  if (!digits || digits.length < 9) return null;
  let intl, intlPlus, local;
  if (digits.startsWith("263") && digits.length >= 12) {
    intl = digits; intlPlus = "+" + digits; local = "0" + digits.slice(3);
  } else if (digits.startsWith("0") && digits.length === 10) {
    local = digits; intl = "263" + digits.slice(1); intlPlus = "+263" + digits.slice(1);
  } else {
    intl = digits; intlPlus = "+" + digits; local = digits;
  }
  return SupplierProfile.findOne({ phone: { $in: [intl, intlPlus, local] } }).lean();
}


function calculateUpgradeCost(currentPrice, nextPrice, daysRemaining, totalDays) {
  if (nextPrice <= currentPrice) return 0;
  if (daysRemaining <= 0 || totalDays <= 0) return round2(nextPrice - currentPrice);
  return round2((nextPrice - currentPrice) * (daysRemaining / totalDays));
}

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



// ── Invoice/quote/receipt preview with edit option ────────────────────────
async function _sendInvoicePreview(from, biz, extraNote = "") {
  const items = biz.sessionData.items || [];
  const currency = biz.currency || "USD";
  const docType = biz.sessionData.docType || "invoice";
  const label = docType === "invoice" ? "Invoice" : docType === "quote" ? "Quotation" : "Receipt";

  const discountPercent = Number(biz.sessionData.discountPercent || 0);
  const vatPercent = Number(biz.sessionData.vatPercent || 0);

  const subtotal = items.reduce((s, i) => s + (Number(i.qty) * Number(i.unit)), 0);
  const discountAmount = subtotal * (discountPercent / 100);
  const vatAmount = (subtotal - discountAmount) * (vatPercent / 100);
  const total = subtotal - discountAmount + vatAmount;

  const itemLines = items
    .map((i, idx) =>
      `${idx + 1}. *${i.item}* × ${i.qty} @ ${formatMoney(i.unit, currency)} = *${formatMoney(i.qty * i.unit, currency)}*`
    )
    .join("\n");

  const discountLine = discountPercent > 0 ? `\n💸 Discount: ${discountPercent}% = -${formatMoney(discountAmount, currency)}` : "";
  const vatLine = vatPercent > 0 ? `\n🧾 VAT: ${vatPercent}% = +${formatMoney(vatAmount, currency)}` : "";

  const preview =
`🧾 *${label} Preview*${extraNote}

${itemLines}
─────────────────
Subtotal: ${formatMoney(subtotal, currency)}${discountLine}${vatLine}
*Total: ${formatMoney(total, currency)}*`;

  return sendInvoiceConfirmMenu(from, preview);
}

function unpricedCursor(n) { return n; } // tiny helper to avoid inline confusion
function normalizeProductName(value = "") {
  return String(value)
    .toLowerCase()
    .trim()
    .replace(/[^\w\s]/g, "")
    .replace(/\s+/g, " ");
}


const GENERIC_REQUEST_TERMS = new Set([
  "item",
  "items",
  "product",
  "products",
  "service",
  "services",
  "thing",
  "things",
  "material",
  "materials",
  "equipment",
  "supplies",
  "parts",
  "spares",
  "uniform",
  "uniforms",
  "laptop",
  "laptops",
  "phone",
  "phones",
  "tv",
  "tvs",
  "fridge",
  "fridges",
  "stove",
  "stoves",
  "pipe",
  "pipes",
  "valve",
  "valves",
  "tap",
  "taps",
  "tile",
  "tiles",
  "cement",
  "sand",
  "paint",
  "chair",
  "chairs",
  "table",
  "tables",
  "desk",
  "desks",
  "bed",
  "beds",
  "sofa",
  "sofas",
  "shoe",
  "shoes",
  "dress",
  "dresses",
  "shirt",
  "shirts",
  "builder",
  "builders",
  "plumber",
  "plumbers",
  "electrician",
  "electricians",
  "welder",
  "welders",
  "carpenter",
  "carpenters",
  "cleaner",
  "cleaners",
  "mechanic",
  "mechanics",
  "lawyer",
  "lawyers",
  "accountant",
  "accountants",
  "doctor",
  "doctors",
  "dentist",
  "dentists",
  "transport",
  "delivery"
]);

const REQUEST_FILLER_WORDS = new Set([
  "a",
  "an",
  "the",
  "for",
  "of",
  "and",
  "with",
  "in",
  "on",
  "to",
  "my",
  "need",
  "want",
  "looking"
]);

function getBuyerRequestLabel(item = {}) {
  return String(item?.product || item?.service || item?.raw || "").trim();
}

function getMeaningfulRequestTokens(value = "") {
  return normalizeProductName(value)
    .split(" ")
    .filter(Boolean)
    .filter(token => !REQUEST_FILLER_WORDS.has(token));
}

function isGenericBuyerRequestName(value = "") {
  const normalized = normalizeProductName(value);
  if (!normalized) return true;

  const tokens = getMeaningfulRequestTokens(normalized);

  if (!tokens.length) return true;
  if (tokens.length === 1 && GENERIC_REQUEST_TERMS.has(tokens[0])) return true;
  if (tokens.length === 1) return true;

  return false;
}

function getVagueBuyerRequestItems(items = []) {
  return (items || []).filter(item => isGenericBuyerRequestName(getBuyerRequestLabel(item)));
}

function buildBuyerSpecificityPrompt(vagueItems = []) {
  const vagueLines = vagueItems.length
    ? vagueItems.map(i => `• ${getBuyerRequestLabel(i)}`).join("\n")
    : "• Your request";

  return (
    `❌ *Please use the full product or service name.*\n\n` +
    `These are too general for sellers to quote correctly:\n` +
    `${vagueLines}\n\n` +
    `Please include type, size, model, brand, class, material, or exact service needed.\n\n` +
    `Examples:\n` +
    `_ball valve brass 20mm harare_\n` +
    `_school uniform size 8 chitungwiza_\n` +
    `_hp laptop core i7 cbd harare_\n` +
    `_geyser installation avondale harare_`
  );
}

function parseSupplierItemsInput(text = "") {
  return String(text || "")
    .split(/[,\n]+/)
    .map(s => s.trim())
    .filter(Boolean);
}

function dedupeSupplierItems(items = []) {
  const seen = new Set();
  const out = [];

  for (const raw of items) {
    const clean = raw.trim();
    const key = normalizeProductName(clean);
    if (!clean || !key) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(clean);
  }

  return out;
}

function findSupplierItemIndexes(input = "", currentItems = []) {
  const tokens = String(input || "")
    .split(/[,\n]+/)
    .map(s => s.trim())
    .filter(Boolean);

  const indexes = new Set();
  const names = [];

  for (const token of tokens) {
    // support single numbers like 2, 5, 19
    if (/^\d+$/.test(token)) {
      const idx = Number(token) - 1;
      if (idx >= 0 && idx < currentItems.length) indexes.add(idx);
      continue;
    }

    // support ranges like 5-8
    const rangeMatch = token.match(/^(\d+)\s*-\s*(\d+)$/);
    if (rangeMatch) {
      const start = Number(rangeMatch[1]) - 1;
      const end = Number(rangeMatch[2]) - 1;
      for (let i = Math.min(start, end); i <= Math.max(start, end); i++) {
        if (i >= 0 && i < currentItems.length) indexes.add(i);
      }
      continue;
    }

    names.push(normalizeProductName(token));
  }

  if (names.length) {
    currentItems.forEach((item, i) => {
      const normalized = normalizeProductName(item);
      if (names.includes(normalized)) indexes.add(i);
    });
  }

  return [...indexes].sort((a, b) => a - b);
}

function parseQuickPriceUpdates(input = "", currentItems = [], isService = false) {
  const groups = String(input || "")
    .split(/[;\n]+/)
    .map(s => s.trim())
    .filter(Boolean);

  const updatesMap = new Map();
  const failed = [];
  let matchedAny = false;

  for (const group of groups) {
    // Group format:
    // 5,7,9 x 3.50
    // 20-30 x 1.25
    // 3 x 20/job
  const grouped = group.match(
  /^([\d,\-\s]+)\s*(?:x|=|@)\s*(\d+(?:\.\d+)?)(?:\s*\/\s*([a-zA-Z]+))?$/i
);

    if (grouped) {
      matchedAny = true;

      const selector = grouped[1].trim();
      const amount = Number(grouped[2]);
      const unit = (grouped[3] || (isService ? "job" : "each")).toLowerCase();
      const indexes = findSupplierItemIndexes(selector, currentItems);

      if (!indexes.length) {
        failed.push(group);
        continue;
      }

      for (const idx of indexes) {
        updatesMap.set(idx, {
          index: idx,
          product: currentItems[idx],
          amount,
          unit,
          inStock: true
        });
      }
      continue;
    }

    // Mixed single commands separated by commas:
    // 5 x 3.50, 7 x 4.20
    const parts = group.split(",").map(s => s.trim()).filter(Boolean);

    for (const part of parts) {
    const single = part.match(
  /^(\d+)\s*(?:x|=|@)\s*(\d+(?:\.\d+)?)(?:\s*\/\s*([a-zA-Z]+))?$/i
);

      if (!single) {
        failed.push(part);
        continue;
      }

      matchedAny = true;

      const idx = Number(single[1]) - 1;
      if (idx < 0 || idx >= currentItems.length) {
        failed.push(part);
        continue;
      }

      updatesMap.set(idx, {
        index: idx,
        product: currentItems[idx],
        amount: Number(single[2]),
        unit: (single[3] || (isService ? "job" : "each")).toLowerCase(),
        inStock: true
      });
    }
  }

  return {
    updates: [...updatesMap.values()].sort((a, b) => a.index - b.index),
    failed,
    matchedAny
  };
}



function parseSupplierPriceInput(raw = "", products = [], isService = false) {
  const parts = String(raw || "")
    .split(/[,\n]+/)
    .map(s => s.trim())
    .filter(Boolean);

  const allNumbers = parts.length > 0 && parts.every(s => /^\d+(\.\d+)?$/.test(s));
  const updated = [];
  const failed = [];

  // New quick syntax:
  // 75 x 3.50
  // 5,7,9 x 3.50
  // 20-30 x 1.25
  // 3 x 20/job
  const quick = parseQuickPriceUpdates(raw, products, isService);

  if (quick.matchedAny) {
    quick.updates.forEach(u => {
      updated.push({
        product: u.product.toLowerCase(),
        amount: u.amount,
        unit: u.unit,
        inStock: true
      });
    });
    failed.push(...quick.failed);
    return { updated, failed };
  }

  if (allNumbers) {
    if (parts.length !== products.length) {
      return {
        updated: [],
        failed: [`count_mismatch:${parts.length}:${products.length}`]
      };
    }

    parts.forEach((numStr, i) => {
      updated.push({
        product: products[i].toLowerCase(),
        amount: parseFloat(numStr),
        unit: isService ? "job" : "each",
        inStock: true
      });
    });

    return { updated, failed };
  }

  // Named pricing / named rate parsing
  for (const line of parts) {
    const clean = line
      .replace(/^[-•*►▪✓]\s*/, "")
      .replace(/^\d+[.)]\s*/, "")
      .replace(/\$/g, "")
      .trim();

    if (!clean) continue;

    // number/unit only e.g. 20/job
    const rateOnlyMatch = clean.match(/^(\d+(?:\.\d+)?)\/([a-zA-Z]+)$/);
    if (rateOnlyMatch) {
      const posIdx = updated.length;
      if (posIdx < products.length) {
        updated.push({
          product: products[posIdx].toLowerCase(),
          amount: parseFloat(rateOnlyMatch[1]),
          unit: rateOnlyMatch[2].toLowerCase(),
          inStock: true
        });
      } else {
        failed.push(line);
      }
      continue;
    }

    const match =
      clean.match(/^(.+?)\s*[:]\s*(\d+(?:\.\d+)?)\s*([a-zA-Z/]*)$/) ||
      clean.match(/^(.+?)\s+(\d+(?:\.\d+)?)\s*([a-zA-Z/]*)$/);

    if (!match) {
      failed.push(line);
      continue;
    }

    const product = match[1].replace(/[$@\-:,]+$/, "").trim().toLowerCase();
    const amount = parseFloat(match[2]);
    const rawUnit = (match[3] || "").trim().toLowerCase();
    const unit = rawUnit ? rawUnit.replace(/^\//, "") : (isService ? "job" : "each");

    if (!product || isNaN(amount)) {
      failed.push(line);
      continue;
    }

    updated.push({
      product,
      amount,
      unit,
      inStock: true
    });
  }

  return { updated, failed };
}


function parseQuickRenameCommand(input = "", currentItems = []) {
  const raw = String(input || "").trim();

  // format: 5=new product name
  const m = raw.match(/^(\d+)\s*=\s*(.+)$/);
  if (!m) return null;

  const idx = Number(m[1]) - 1;
  const newName = (m[2] || "").trim();

  if (idx < 0 || idx >= currentItems.length) return null;
  if (!newName) return null;

  return { index: idx, newName };
}

function parseQuickDeleteCommand(input = "", currentItems = []) {
  const raw = String(input || "").trim();

  // formats:
  // del 5
  // del 5,8,10
  // del 20-30
  const m = raw.match(/^del\s+(.+)$/i);
  if (!m) return [];

  return findSupplierItemIndexes(m[1], currentItems);
}

function parseQuickAddCommand(input = "") {
  const raw = String(input || "").trim();

  // formats:
  // add screw driver
  // add hammer, pliers
  const m = raw.match(/^add\s+(.+)$/i);
  if (!m) return [];

  return parseSupplierItemsInput(m[1]);
}


async function sendSupplierItemsInChunks(from, items, heading = "📦 Current Items") {
  const cleanItems = (items || []).filter(p => p && p !== "pending_upload");

  if (!cleanItems.length) {
    return sendText(from, "No items listed yet.");
  }

  const CHUNK = 25;
  for (let i = 0; i < cleanItems.length; i += CHUNK) {
    const chunk = cleanItems.slice(i, i + CHUNK);
    const lines = chunk
      .map((p, j) => `${i + j + 1}. ${p}`)
      .join("\n");

    const isFirst = i === 0;
    const isLast = i + CHUNK >= cleanItems.length;

    await sendText(
      from,
      isFirst
        ? `${heading} (${cleanItems.length})\n\n${lines}${isLast ? "" : "\n_(continued...)_"}`
        : `${lines}${isLast ? "" : "\n_(continued...)_"}`
    );
  }
}


async function sendSupplierQuickEditHelp(from, isService = false) {
  return sendText(
    from,
`Use these quick commands:

*Rename one item:*
_5=new name_

*Delete items:*
_del 5_
_del 5,8,10_
_del 20-30_

*Add new items:*
_add ${isService ? "geyser fitting" : "screw driver"}_
_add ${isService ? "blocked drain, toilet installation" : "hammer, pliers"}_

Type *cancel* to go back.`
  );
}

async function sendSupplierQuickPriceHelp(from, products = [], isService = false) {
  return sendText(
    from,
`─────────────────
*Fastest way: update by item number*

*Single item:*
_75x3.50_
_75 x 3.50_
${isService ? `_3x20/job_` : ""}

*Same price for selected items:*
_5,7,9x3.50_
_5,7,9 x 3.50_

*Same price for a range:*
_20-30x1.25_
_20-30 x 1.25_

*Mixed updates:*
_5x3.50,7x4.20_
_5 x 3.50, 7 x 4.20${isService ? ", 9 x 15/job" : ""}_

*Other options still work:*

*Update ALL in order:*
_${products.slice(0, 4).map((_, i) => (((i + 1) * 3) + 2).toFixed(2)).join(", ")}${products.length > 4 ? ", ..." : ""}_

*Update selected items by name:*
_${products.slice(0, 2).map(p => `${p}: 6.00`).join(", ")}_

Type *cancel* to go back.`
  );
}

function filterPricesForRemainingProducts(prices = [], remainingProducts = []) {
  const allowed = new Set(remainingProducts.map(p => normalizeProductName(p)));
  return (prices || []).filter(pr => allowed.has(normalizeProductName(pr.product)));
}

function filterRatesForRemainingServices(rates = [], remainingProducts = []) {
  const allowed = new Set(remainingProducts.map(p => normalizeProductName(p)));
  return (rates || []).filter(r => allowed.has(normalizeProductName(r.service)));
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
function scoreLooseMatch(a = "", b = "") {
  const left = normalizeProductName(a);
  const right = normalizeProductName(b);

  if (!left || !right) return 0;
  if (left === right) return 100;

  const leftTokens = left.split(" ").filter(Boolean);
  const rightTokens = right.split(" ").filter(Boolean);

  let score = 0;

  if (left.includes(right) || right.includes(left)) {
    score += 40;
  }

  const overlap = leftTokens.filter(t => rightTokens.includes(t)).length;
  if (overlap) {
    score += Math.round((overlap / Math.max(leftTokens.length, rightTokens.length)) * 50);
  }

  if (leftTokens[0] && rightTokens[0] && leftTokens[0] === rightTokens[0]) {
    score += 10;
  }

  return score;
}

function findMatchingSupplierPrice(supplier, requestedProduct) {
  if (!requestedProduct || !supplier) return null;

  const isServiceSupplier = supplier?.profileType === "service";

  if (isServiceSupplier) {
    const validRates = (supplier.rates || []).filter(r => {
      const serviceName = normalizeProductName(r?.service || "");
      return serviceName;
    });

    let exact = validRates.find(r =>
      normalizeProductName(r.service) === normalizeProductName(requestedProduct)
    );

    if (exact) {
      return {
        product: exact.service,
        amount: parseSupplierRateValue(exact.rate),
        unit: parseSupplierRateUnit(exact.rate),
        source: "rates"
      };
    }

    const scored = validRates
      .map(r => ({
        row: r,
        score: scoreLooseMatch(r.service, requestedProduct)
      }))
      .sort((a, b) => b.score - a.score);

    const best = scored[0];
    const second = scored[1];

    if (best && best.score >= 55 && (!second || best.score - second.score >= 10)) {
      return {
        product: best.row.service,
        amount: parseSupplierRateValue(best.row.rate),
        unit: parseSupplierRateUnit(best.row.rate),
        source: "rates"
      };
    }

    return null;
  }

  const allowedNames = new Set(
    (supplier.listedProducts || [])
      .map(name => normalizeProductName(name))
      .filter(Boolean)
  );

  if (!allowedNames.size) return null;

  const validPrices = (supplier.prices || []).filter(p => {
    const productName = normalizeProductName(p?.product || "");
    return productName && p?.inStock !== false && allowedNames.has(productName);
  });

  let exact = validPrices.find(p =>
    normalizeProductName(p.product) === normalizeProductName(requestedProduct)
  );

  if (exact) {
    return {
      product: exact.product,
      amount: Number(exact.amount),
      unit: exact.unit || "each",
      source: "prices"
    };
  }

  const scored = validPrices
    .map(p => ({
      row: p,
      score: scoreLooseMatch(p.product, requestedProduct)
    }))
    .sort((a, b) => b.score - a.score);

  const best = scored[0];
  const second = scored[1];

  if (best && best.score >= 55 && (!second || best.score - second.score >= 10)) {
    return {
      product: best.row.product,
      amount: Number(best.row.amount),
      unit: best.row.unit || "each",
      source: "prices"
    };
  }

  return null;
}


const PLUMBING_PRESET_PRICES = Object.freeze({
  "110mm pvc pipe":         { amount: 10, unit: "each" },
  "110mm pvc ug pipe":      { amount: 10, unit: "each" },
  "110mm ac pvc pipe":      { amount: 12, unit: "each" },
  "50mm waste pipe":        { amount: 6,  unit: "each" },

  "32mm p trap":            { amount: 5,  unit: "each" },
  "40mm p trap":            { amount: 5,  unit: "each" },
  "50mm p trap":            { amount: 5,  unit: "each" },
  "32mm bottle trap":       { amount: 10, unit: "each" },
  "100mm floor drain":      { amount: 10, unit: "each" },

  "110mm inspection eye":   { amount: 15, unit: "each" },
  "110mm plain bend":       { amount: 3,  unit: "each" },
  "110mm h t bend":         { amount: 3,  unit: "each" },
  "110mm plain tee":        { amount: 4,  unit: "each" },
  "110mm access tee":       { amount: 12, unit: "each" },
  "110mm y junction":       { amount: 4,  unit: "each" },
  "110-50 reducer tee":     { amount: 4,  unit: "each" },
  "110mm vent valve":       { amount: 3,  unit: "each" },
  "110mm boss connector":   { amount: 3,  unit: "each" },

  "50mm plain bend":        { amount: 1,   unit: "each" },
  "50mm ie bend":           { amount: 0.5, unit: "each" },
  "50mm ic tee":            { amount: 1,   unit: "each" },
  "gulley p":               { amount: 2.5, unit: "each" },
  "gulley heads":           { amount: 4,   unit: "each" },

  "15mm pipe clip":         { amount: 0.5, unit: "each" },
  "20mm pipe clip":         { amount: 1,   unit: "each" },
  "15mm male connector":    { amount: 1.5, unit: "each" },
  "15mm cap elbow":         { amount: 0.5, unit: "each" },
  "22mm cap elbow":         { amount: 1.5, unit: "each" },
  "3/4 cu elbow":           { amount: 1.5, unit: "each" },

  "22mm cu pipe":           { amount: 35, unit: "each" },
  "15mm cu pipe":           { amount: 20, unit: "each" },

  "solvent cement":         { amount: 10, unit: "each" },
  "soldering wire":         { amount: 10, unit: "each" },
  "nasco flux":             { amount: 5,  unit: "each" },
  "gas canister":           { amount: 3,  unit: "each" },
  "masonry disk":           { amount: 10, unit: "each" },

  "basin pedestal":         { amount: 30, unit: "each" },
  "basin waste":            { amount: 5,  unit: "each" },
  "toilet lid":             { amount: 10, unit: "each" },
  "shower rose and arm":    { amount: 8,  unit: "each" }
});

function getBestPlumbingPresetPrice(requestedProduct = "") {
  const normalized = normalizeProductName(requestedProduct);
  if (!normalized) return null;

  if (PLUMBING_PRESET_PRICES[normalized]) {
    return {
      product: requestedProduct,
      amount: Number(PLUMBING_PRESET_PRICES[normalized].amount),
      unit: PLUMBING_PRESET_PRICES[normalized].unit || "each",
      source: "preset_exact"
    };
  }

  const scored = Object.entries(PLUMBING_PRESET_PRICES)
    .map(([name, price]) => ({
      name,
      price,
      score: scoreLooseMatch(name, normalized)
    }))
    .sort((a, b) => b.score - a.score);

  const best = scored[0];
  const second = scored[1];

  if (best && best.score >= 70 && (!second || best.score - second.score >= 10)) {
    return {
      product: requestedProduct,
      amount: Number(best.price.amount),
      unit: best.price.unit || "each",
      source: "preset_fuzzy",
      matchedPreset: best.name
    };
  }

  return null;
}

function supplierLooksLikePlumbingSeller(supplier) {
  const categories = Array.isArray(supplier?.categories) ? supplier.categories : [];
  return categories.includes("plumbing_supplies");
}

function getSupplierStockNames(supplier) {
  return [
    ...(supplier?.listedProducts || []),
    ...(supplier?.products || [])
  ]
    .map(p => normalizeProductName(p))
    .filter(Boolean);
}

function supplierStocksRequestedItem(supplier, requestedProduct = "") {
  const requested = normalizeProductName(requestedProduct);
  if (!requested) return false;

  const stockNames = getSupplierStockNames(supplier);
  if (!stockNames.length) return false;

  if (stockNames.includes(requested)) return true;

  const scored = stockNames
    .map(name => ({ name, score: scoreLooseMatch(name, requested) }))
    .sort((a, b) => b.score - a.score);

  return Boolean(scored[0] && scored[0].score >= 70);
}

function findMatchingSupplierPriceOrPreset(supplier, requestedProduct) {
  const supplierPrice = findMatchingSupplierPrice(supplier, requestedProduct);
  if (supplierPrice) {
    return {
      ...supplierPrice,
      source: "supplier_saved"
    };
  }

  if (!supplierLooksLikePlumbingSeller(supplier)) return null;
  if (!supplierStocksRequestedItem(supplier, requestedProduct)) return null;

  return getBestPlumbingPresetPrice(requestedProduct);
}

function buildDraftQuoteFromRequest(supplier, request) {
  const items = Array.isArray(request?.items) ? request.items : [];

  const responseItems = [];
  const missingItems = [];

  for (const item of items) {
    const match = findMatchingSupplierPriceOrPreset(supplier, item.product);
    if (!match || typeof match.amount !== "number") {
      missingItems.push(item.product);
      continue;
    }

    const qty = Number(item.quantity || 1);
    const unitPrice = Number(match.amount);
    const total = Number((qty * unitPrice).toFixed(2));

    responseItems.push({
      product: item.product,
      quantity: qty,
      unit: match.unit || item.unitLabel || "each",
      pricePerUnit: unitPrice,
      total,
      available: true,
      autoSource: match.source || "unknown"
    });
  }

  const totalAmount = Number(
    responseItems.reduce((sum, i) => sum + Number(i.total || 0), 0).toFixed(2)
  );

  return {
    responseItems,
    missingItems,
    totalAmount
  };
}
function parseBulkOrderInput(text = "") {
  const raw = String(text || "").trim();
  if (!raw) return [];

  const lines = raw
    .split(/\n+/)
    .map(s => s.trim())
    .filter(Boolean)
    .filter(line => {
      const normalized = line.toLowerCase();

      // ignore headings / section labels
      if (/^stage\s*\d+\b/i.test(normalized)) return false;
      if (/^section\s*\d+\b/i.test(normalized)) return false;
      if (/^phase\s*\d+\b/i.test(normalized)) return false;
      if (/^[a-z\s]+material\s*:?$/i.test(normalized)) return false;
      if (/^[a-z\s]+items?\s*:?$/i.test(normalized)) return false;

      return true;
    });

  return lines.map(part => {
    const clean = part
      .replace(/^[-•*]\s*/, "")
      .replace(/\s+/g, " ")
      .trim();

    // examples:
    // 110 access tees x2
    // vent valves x 2
    // cement 20 bags
    // rice 5kg
    // bath tub standard x1
    let m =
      clean.match(/^(.+?)\s+x\s*(\d+(?:\.\d+)?)\s*([a-zA-Z]+)?$/i) ||
      clean.match(/^(.+?)\s+(\d+(?:\.\d+)?)\s*([a-zA-Z]+)?$/i);

    if (!m) {
      return {
        raw: clean,
        product: clean,
        quantity: 1,
        unitLabel: "units",
        valid: false
      };
    }

    return {
      raw: clean,
      product: m[1].trim(),
      quantity: Number(m[2]),
      unitLabel: (m[3] || "units").trim(),
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

function getSupplierCatalogueSourceItems(supplier) {
  if (!supplier) return [];

  if (supplier.profileType === "service") {
    // Use rates[] if available - they have prices
    const rateItems = (supplier.rates || [])
      .filter(r => normalizeProductName(r?.service || ""))
      .map(r => ({
        name: String(r.service).trim(),
        priceLabel: formatSupplierRateDisplay(r.rate || ""),
        rawPrice: parseSupplierRateValue(r.rate || ""),
        unit: parseSupplierRateUnit(r.rate || "") || "job"
      }));

    if (rateItems.length) return rateItems;

    // No rates yet - fall back to products[] and listedProducts[]
    const seen = new Set();
    const fallbackItems = [];
    const allServiceItems = [
      ...(supplier.listedProducts || []),
      ...(supplier.products || [])
    ];
    for (const svcName of allServiceItems) {
      if (!svcName || svcName === "pending_upload") continue;
      const clean = String(svcName).trim();
      const norm = normalizeProductName(clean);
      if (!norm || seen.has(norm)) continue;
      seen.add(norm);
      fallbackItems.push({
        name: clean,
        priceLabel: "",
        rawPrice: null,
        unit: "job"
      });
    }
    return fallbackItems;
  }

  const listedProducts = (supplier.listedProducts || [])
    .filter(p => p && p !== "pending_upload")
    .filter(p => normalizeProductName(p));

  if (!listedProducts.length) return [];

  const pricedMap = new Map();
  for (const p of (supplier.prices || [])) {
    const key = normalizeProductName(p?.product || "");
    if (!key) continue;
    if (p?.inStock === false) continue;
    pricedMap.set(key, p);
  }

  return listedProducts.map(name => {
    const match = pricedMap.get(normalizeProductName(name));
    return {
      name: String(name).trim(),
      priceLabel: match ? `$${Number(match.amount).toFixed(2)}/${match.unit || "each"}` : "",
      rawPrice: match ? Number(match.amount) : null,
      unit: match?.unit || "each"
    };
  });
}

function getFilteredSupplierCatalogueItems(supplier, searchTerm = "") {
  const items = getSupplierCatalogueSourceItems(supplier);
  const q = normalizeProductName(searchTerm || "");

  if (!q) return items;

  return items.filter(item => {
    const n = normalizeProductName(item.name);
    return n.includes(q) || q.includes(n);
  });
}


function formatCatalogueHeader({
  supplier,
  page,
  totalPages,
  totalItems,
  searchTerm = "",
  cartCount = 0,
  selectionMode = "catalogue"
}) {
  const label = supplier?.businessName || "Supplier";
  const itemWord = supplier?.profileType === "service" ? "service" : "product";

  const title =
    selectionMode === "search_pick" && searchTerm
      ? `🎯 *Choose exact ${itemWord} for: ${searchTerm}*`
      : `🛍 *${label} Catalogue*`;

  const supplierLine =
    selectionMode === "search_pick" ? `\n🏪 ${label}` : "";

  const searchLine =
    searchTerm ? `\n🔎 Search: *${searchTerm}*` : "";

  const cartLine =
    cartCount > 0 ? `\n🛒 Cart: ${cartCount} item${cartCount === 1 ? "" : "s"}` : "";

  const helperLine =
    selectionMode === "search_pick"
      ? `\nTap the exact ${itemWord} you want before it is added to cart.`
      : "";

  return (
    `${title}` +
    `${supplierLine}` +
    `${searchLine}` +
    `${cartLine}` +
    `${helperLine}\n\n` +
    `Page ${page + 1} of ${totalPages} • ${totalItems} item${totalItems === 1 ? "" : "s"}`
  );
}



function isCategoryBrowseContext({ biz, sess }) {
  const search = biz?.sessionData?.supplierSearch || {};
  const sessType = sess?.tempData?.supplierSearchType || null;
  const sessCategory = sess?.tempData?.supplierSearchCategory || null;
  const sessProduct = sess?.tempData?.supplierSearchProduct || null;

  const category = search.category || sessCategory || null;
  const product = search.product || sessProduct || null;
  const type = search.type || sessType || null;

  return Boolean(type && category && !product);
}

async function _sendSupplierShoppingHub(from, supplier, cart = [], opts = {}) {
  const isService = supplier?.profileType === "service";
  const cartCount = Array.isArray(cart) ? cart.length : 0;

  const subtitle =
    opts.fromCategory
      ? `Browse this ${isService ? "service provider" : "supplier"} before choosing exact ${isService ? "service" : "item"}.`
      : `Choose how you want to shop from this ${isService ? "provider" : "supplier"}.`;

  const addressLine = supplier.address
    ? `\n📍 ${supplier.address}`
    : `\n📍 ${supplier.location?.area || ""}${supplier.location?.area && supplier.location?.city ? ", " : ""}${supplier.location?.city || ""}`;

  const contactLine = supplier.contactDetails
    ? `\n📞 ${supplier.contactDetails}`
    : "";
  const websiteLine = supplier.website
    ? `\n🌐 ${supplier.website}`
    : "";

  const rows = [
    {
      id: `sup_catalog_page_open_${supplier._id}`,
      title: "📚 View Catalogue"
    },
    {
      id: `sup_catalogue_search_${supplier._id}`,
      title: isService ? "🔎 Search Services" : "🔎 Search Products"
    },
    {
      id: `sup_number_page_open_${supplier._id}`,
      title: "⚡ Quick Order"
    },
    {
      id: `sup_request_quote_supplier_${supplier._id}`,
      title: "📋 Request Quote"
    },
    {
      id: `sup_ask_availability_${supplier._id}`,
      title: isService ? "❓ Ask Availability" : "❓ Ask Stock"
    },
    {
      id: `sup_cart_view_${supplier._id}`,
      title: `🛒 View Cart${cartCount ? ` (${cartCount})` : ""}`
    },
    {
      id: "sup_back_to_search_results",
      title: "⬅ Back to Results"
    }
  ];

  return sendList(
    from,
    `🛍 *${supplier.businessName}*` +
      `${addressLine}` +
      `${contactLine}` +
      `${websiteLine}` +
      `\n🛒 Cart: ${cartCount} item${cartCount === 1 ? "" : "s"}\n\n` +
      `${subtitle}`,
    rows
  );
}
function upsertCartItemToFront(cart = [], nextItem = {}) {
  const nextCart = Array.isArray(cart) ? [...cart] : [];
  const existingIndex = nextCart.findIndex(
    item => String(item.product || "").toLowerCase() === String(nextItem.product || "").toLowerCase()
  );

  if (existingIndex >= 0) {
    const existing = nextCart[existingIndex];
    const merged = {
      ...existing,
      quantity: Number(existing.quantity || 0) + Number(nextItem.quantity || 1)
    };

    if (typeof merged.pricePerUnit === "number" && !Number.isNaN(merged.pricePerUnit)) {
      merged.total = Number((merged.quantity * merged.pricePerUnit).toFixed(2));
    }

    nextCart.splice(existingIndex, 1);
    nextCart.unshift(merged);
    return nextCart;
  }

  const fresh = {
    ...nextItem,
    quantity: Number(nextItem.quantity || 1),
    total:
      typeof nextItem.pricePerUnit === "number" && !Number.isNaN(nextItem.pricePerUnit)
        ? Number((Number(nextItem.quantity || 1) * nextItem.pricePerUnit).toFixed(2))
        : null
  };

  nextCart.unshift(fresh);
  return nextCart;
}

async function _sendSelectedSearchItemPreview(from, supplier, selectedItem, cart = [], opts = {}) {
  const isService = supplier?.profileType === "service";
  const priceLine =
    typeof selectedItem?.pricePerUnit === "number" && !Number.isNaN(selectedItem.pricePerUnit)
      ? `💵 Price: $${Number(selectedItem.pricePerUnit).toFixed(2)}/${selectedItem.unit || (isService ? "job" : "each")}`
      : `💵 Price: To be confirmed by supplier`;

  const cartCount = Array.isArray(cart) ? cart.length : 0;
  const moreMatchesId = opts.moreMatchesId || "find_supplier";
  const fullCatalogueId = `sup_catalog_page_open_${supplier._id}`;

  await sendList(
    from,
    `✅ *Selected ${isService ? "Service" : "Item"}*\n\n` +
      `🏪 Supplier: ${supplier.businessName}\n` +
      `${isService ? "🔧" : "📦"} ${selectedItem.product}\n` +
      `${priceLine}\n` +
      `🔢 Quantity: ${Number(selectedItem.quantity || 1)}\n` +
      `🛒 Cart: ${cartCount} item${cartCount === 1 ? "" : "s"}`,
    [
      {
        id: `sup_item_preview_add_${supplier._id}_${encodeURIComponent(selectedItem.product)}`,
        title: "➕ Add to Cart"
      },
      {
        id: `sup_item_preview_order_${supplier._id}_${encodeURIComponent(selectedItem.product)}`,
        title: "⚡ Order This Now"
      },
      {
        id: moreMatchesId,
        title: "🔎 View More Similar"
      },
      {
        id: fullCatalogueId,
        title: "📚 Full Catalogue"
      },
      {
        id: `sup_cart_view_${supplier._id}`,
        title: "🛒 View Cart"
      }
    ]
  );

  return _sendSelectedItemExtraActions(from, supplier, selectedItem, opts);
}
async function _sendSelectedSupplierItemPreview(from, supplier, selectedItem, cart = [], opts = {}) {
  const isService = supplier?.profileType === "service";
  const quantity = Number(opts.quantity || 1);
  const priceLine =
    typeof selectedItem?.pricePerUnit === "number"
      ? `💵 Price: $${Number(selectedItem.pricePerUnit).toFixed(2)}/${selectedItem.unit || (isService ? "job" : "each")}`
      : `💵 Price: To be confirmed by supplier`;

  const cartCount = Array.isArray(cart) ? cart.length : 0;
  const searchTerm = opts.searchTerm || "";

  await sendButtons(from, {
    text:
      `✅ *Selected ${isService ? "Service" : "Item"}*\n\n` +
      `🏪 Supplier: ${supplier.businessName}\n` +
      `${isService ? "🔧" : "📦"} ${selectedItem.product}\n` +
      `${priceLine}\n` +
      `🔢 Quantity: ${quantity}\n` +
      `🛒 Cart: ${cartCount} item${cartCount === 1 ? "" : "s"}` +
      (searchTerm ? `\n🔎 Search: ${searchTerm}` : "") +
      `\n\nWhat would you like to do next?`,
    buttons: [
      {
        id: `sup_item_preview_order_${supplier._id}_${encodeURIComponent(selectedItem.product)}`,
        title: isService ? "✅ Confirm Booking" : "✅ Place Order"
      },
      {
        id: `sup_item_preview_add_${supplier._id}_${encodeURIComponent(selectedItem.product)}`,
        title: isService ? "➕ Add Service" : "➕ Add to Cart"
      },
      {
        id: `sup_cart_view_${supplier._id}`,
        title: "🛒 View Cart"
      }
    ]
  });

  return _sendSelectedItemExtraActions(from, supplier, selectedItem, opts);
}


async function _sendSupplierQuantityPicker(from, supplier, selectedItem, cart = [], opts = {}) {
  const isService = supplier?.profileType === "service";
  const priceLine =
    typeof selectedItem?.pricePerUnit === "number" && !Number.isNaN(selectedItem.pricePerUnit)
      ? `\n💵 Price: $${Number(selectedItem.pricePerUnit).toFixed(2)}/${selectedItem.unit || (isService ? "job" : "each")}`
      : `\n💵 Price: To be confirmed by supplier`;

  const rows = [1, 2, 3, 5, 10].map(q => ({
    id: `sup_qty_pick_${supplier._id}_${encodeURIComponent(selectedItem.product)}_${q}`,
    title: `Qty ${q}`
  }));

  rows.push({ id: `sup_cart_view_${supplier._id}`, title: "🛒 View Cart" });

  if (opts.backId) {
    rows.push({ id: opts.backId, title: "⬅ Back" });
  } else {
    rows.push({ id: `sup_catalog_page_open_${supplier._id}`, title: "⬅ Back to Catalogue" });
  }

  return sendList(
    from,
    `🔢 *Choose Quantity*\n\n` +
    `🏪 ${supplier.businessName}\n` +
    `${isService ? "🔧" : "📦"} ${selectedItem.product}` +
    `${priceLine}\n` +
    `🛒 Cart: ${cart.length} item${cart.length === 1 ? "" : "s"}`,
    rows
  );
}

async function getCurrentOrderCart({ biz, phone }) {
  if (biz) return biz.sessionData?.orderCart || [];
  const sess = await UserSession.findOne({ phone });
  return sess?.tempData?.orderCart || [];
}

async function persistOrderFlowState({ biz, phone, patch = {}, unset = {} }) {
  if (biz) {
    biz.sessionData = { ...(biz.sessionData || {}), ...patch };
    for (const key of Object.keys(unset)) delete biz.sessionData[key];
    await saveBizSafe(biz);
  }

  const setDoc = {};
  const unsetDoc = {};

  for (const [k, v] of Object.entries(patch)) {
    setDoc[`tempData.${k}`] = v;
  }

  for (const k of Object.keys(unset)) {
    unsetDoc[`tempData.${k}`] = "";
  }

  const update = {};
  if (Object.keys(setDoc).length) update.$set = setDoc;
  if (Object.keys(unsetDoc).length) update.$unset = unsetDoc;

  if (Object.keys(update).length) {
    await UserSession.findOneAndUpdate({ phone }, update, { upsert: true });
  }
}




async function clearBuyerOrderContext({ biz, phone, keepSupplierSearch = true }) {
  if (biz) {
    const nextSessionData = { ...(biz.sessionData || {}) };

    delete nextSessionData.orderSupplierId;
    delete nextSessionData.orderCart;
    delete nextSessionData.orderItems;
    delete nextSessionData.orderProduct;
    delete nextSessionData.orderQuantity;
    delete nextSessionData.orderIsService;
    delete nextSessionData.orderBrowseMode;
    delete nextSessionData.orderCataloguePage;
    delete nextSessionData.orderCatalogueSearch;

    if (!keepSupplierSearch) {
      delete nextSessionData.supplierSearch;
      delete nextSessionData.searchResults;
      delete nextSessionData.searchPage;
    }

    biz.sessionData = nextSessionData;

    // only reset state if it was part of buyer ordering
    if (
      biz.sessionState === "supplier_order_picking" ||
      biz.sessionState === "supplier_order_product" ||
      biz.sessionState === "supplier_order_address"
    ) {
      biz.sessionState = "ready";
    }

    await saveBizSafe(biz);
  }

  await UserSession.findOneAndUpdate(
    { phone },
    {
      $unset: {
        "tempData.orderState": "",
        "tempData.orderSupplierId": "",
        "tempData.orderCart": "",
        "tempData.orderItems": "",
        "tempData.orderProduct": "",
        "tempData.orderQuantity": "",
        "tempData.orderIsService": "",
        "tempData.orderBrowseMode": "",
        "tempData.orderCataloguePage": "",
        "tempData.orderCatalogueSearch": ""
      }
    },
    { upsert: true }
  );
}



async function _sendPostSearchActions(from, opts = {}) {
  const isOfferResults = opts.resultMode === "offers";
  const label = opts.product ? ` for *${opts.product}*` : "";

  return sendButtons(from, {
    text:
      `What would you like to do next${label}?`,
    buttons: [
      {
        id: isOfferResults ? "sup_request_quote_search" : "sup_request_quote_search",
        title: "📋 Request Quote"
      },
      {
        id: "sup_save_search_current",
        title: "💾 Save Search"
      },
      {
        id: "find_supplier",
        title: "🔍 Search Again"
      }
    ]
  });
}

async function _sendSelectedItemExtraActions(from, supplier, selectedItem, opts = {}) {
  const isService = supplier?.profileType === "service";

  return sendButtons(from, {
    text:
      `${isService ? "Need pricing first or want to ask before ordering?" : "Need pricing first or want to ask before ordering?"}`,
    buttons: [
      {
        id: `sup_request_quote_supplier_${supplier._id}_${encodeURIComponent(selectedItem.product)}`,
        title: "📋 Request Quote"
      },
      {
        id: `sup_ask_availability_${supplier._id}_${encodeURIComponent(selectedItem.product)}`,
        title: isService ? "❓ Ask Availability" : "❓ Ask Stock"
      },
      {
        id: `sup_cart_view_${supplier._id}`,
        title: "🛒 View Cart"
      }
    ]
  });
}

async function _saveCurrentSearchForBuyer({ phone, biz, fallback = {} }) {
  const product =
    biz?.sessionData?.supplierSearch?.product ||
    fallback.product ||
    null;

  const city =
    biz?.sessionData?.supplierSearch?.city ||
    fallback.city ||
    null;

  const area =
    biz?.sessionData?.supplierSearch?.area ||
    fallback.area ||
    null;

  const profileType =
    biz?.sessionData?.supplierSearch?.type ||
    fallback.profileType ||
    null;

  const payload = {
    product,
    city,
    area,
    profileType,
    savedAt: new Date()
  };

  await UserSession.findOneAndUpdate(
    { phone },
    {
      $push: {
        "tempData.savedSearches": {
          $each: [payload],
          $slice: -20
        }
      }
    },
    { upsert: true }
  );

  return payload;
}

async function notifySuppliersOfLiveDemand({
  product,
  city = null,
  area = null,
  profileType = null,
  results = []
}) {
  try {
    const cleanProduct = normalizeProductName(product || "");
    if (!cleanProduct) return;

    const supplierIds = [
      ...new Set(
        (results || [])
          .map(r =>
            r?.supplierId ||
            r?.supplier?._id ||
            r?._id ||
            null
          )
          .filter(Boolean)
          .map(String)
      )
    ];

    if (!supplierIds.length) return;

    const suppliers = await SupplierProfile.find({
      _id: { $in: supplierIds },
      active: true
    }).lean();

    for (const supplier of suppliers) {
      try {
        const locationLine = area
          ? `📍 ${area}${city ? `, ${city}` : ""}`
          : city
            ? `📍 ${city}`
            : `📍 Zimbabwe`;

        const typeLine =
          profileType === "service"
            ? "\n🔧 Buyer is searching for a service"
            : profileType === "product"
              ? "\n📦 Buyer is searching for a product"
              : "";

        await sendButtons(supplier.phone, {
          text:
            `🔥 *New Buyer Search*\n\n` +
            `🔎 ${product}\n` +
            `${locationLine}` +
            `${typeLine}\n\n` +
            `A buyer is actively searching on ZimQuote right now.`,
          buttons: [
            { id: "my_supplier_account", title: "🏪 My Store" },
            { id: "suppliers_home", title: "🛒 Marketplace" }
          ]
        });
      } catch (innerErr) {
        console.error("[LIVE DEMAND ALERT]", innerErr.message);
      }
    }
  } catch (err) {
    console.error("[notifySuppliersOfLiveDemand]", err.message);
  }
}



function isBuyerRequestHeadingLine(line = "") {
  const raw = String(line || "").trim();
  if (!raw) return true;

  const clean = raw
    .replace(/[–-]/g, "-")
    .replace(/\s+/g, " ")
    .trim();

  if (!clean) return true;

  if (/^stage\s*\d+/i.test(clean)) return true;
  if (/^(bonding material|remainder waste fittings|appliances\/setting|water\/tubing|sewer\/drainlaying)$/i.test(clean)) return true;

  // short label-style headings without qty
  if (
    clean.length <= 40 &&
    !/(?:x\s*\d+|\d+\s*(?:length|lengths|pair|pairs|bag|bags|tonne|tonnes|kg|g|mm|ml|mls|job|hr|hours?))/i.test(clean) &&
    !/\d/.test(clean)
  ) {
    return true;
  }

  return false;
}

function normalizeBuyerRequestLine(line = "") {
  return String(line || "")
    .replace(/[’′`]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[•▪◦●]/g, "")
    .replace(/\s*x\s*/gi, " x")
    .replace(/\)\s*x/gi, ") x")
    .replace(/,+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function parseSingleBuyerRequestLine(line = "") {
  const clean = normalizeBuyerRequestLine(line);
  if (!clean || isBuyerRequestHeadingLine(clean)) return null;

  // examples:
  // 110 Access tees x2
  // Vent valves x2
  // 15mm cu elbws x 78
  // Bath tub(standard) x1
  // Cement x2 bags
  // Pitsand x1 tonne
  // ── Measurement suffixes - keep attached to product name, never treat as unit ──
  const _MSUF = new Set([
    "mm","cm","m","km","ml","l","kg","g","mg","lb","lbs","oz","ft","in","inch",
    "psi","bar","kpa","mpa","kw","kva","hp","v","volt","amp","amps","watt","w","a","ah",
    "litre","litres","liter","liters","tonne","tonnes","ton","tons","metre","metres",
    "meter","meters","gallon","gallons","sqm","sqft","kwh","mhz","ghz","mb","gb","tb"
  ]);

  // Case 1: explicit "x N unit?" - always treat as qty
  const _xm = clean.match(/^(.+?)\s+x\s*(\d+(?:\.\d+)?)\s*([a-zA-Z]*)$/i);
  if (_xm) {
    const _prod = String(_xm[1] || "").trim().replace(/[,:;.\-]+$/g, "").trim();
    const _qty  = Number(_xm[2] || 1);
    const _unit = String(_xm[3] || "units").trim().toLowerCase() || "units";
    if (_prod) return { product: _prod, quantity: Number.isFinite(_qty) && _qty > 0 ? _qty : 1, unitLabel: _unit, notes: "", valid: true };
  }

  // Case 2: "N unit" at end - only qty if unit is not a measurement suffix
  const _bm = clean.match(/^(.+?)\s+(\d+(?:\.\d+)?)\s*([a-zA-Z]+)$/i);
  if (_bm) {
    const _prod = String(_bm[1] || "").trim().replace(/[,:;.\-]+$/g, "").trim();
    const _qty  = Number(_bm[2] || 1);
    const _unit = String(_bm[3] || "").trim().toLowerCase();
    const _isMeas = _MSUF.has(_unit);
    const _prodEndsMeas = /\d+(mm|cm|kg|ml|m|ft|in|psi|bar|v|w|a|kw|kva|hp|ah|litre|liter)$/i.test(_prod);
    if (!_isMeas && !_prodEndsMeas && _prod) {
      return { product: _prod, quantity: Number.isFinite(_qty) && _qty > 0 ? _qty : 1, unitLabel: _unit, notes: "", valid: true };
    }
  }

  // Case 3: No quantity found - default qty=1, whole clean string is product
  return {
    product: clean.replace(/[,:;.\-]+$/g, "").trim(),
    quantity: 1,
    unitLabel: "units",
    notes: "",
    valid: false
  };
}

function parseBuyerRequestItems(text = "") {
  const raw = String(text || "").trim();
  if (!raw) return [];

  const rawLines = raw
    .split(/\n+/)
    .map(line => normalizeBuyerRequestLine(line))
    .filter(Boolean);

  const mergedLines = [];
  for (let i = 0; i < rawLines.length; i++) {
    let current = rawLines[i];
    if (isBuyerRequestHeadingLine(current)) continue;

    const currentHasQty = /\bx\s*\d+/i.test(current);

    // join wrapped lines like:
    // "22mm cu to cu"
    // "couplings x6"
    if (!currentHasQty && i + 1 < rawLines.length) {
      const next = rawLines[i + 1];
      if (next && !isBuyerRequestHeadingLine(next) && /\bx\s*\d+/i.test(next)) {
        current = `${current} ${next}`.replace(/\s+/g, " ").trim();
        i += 1;
      }
    }

    mergedLines.push(current);
  }

  const parsed = mergedLines
    .map(parseSingleBuyerRequestLine)
    .filter(Boolean)
    .filter(item => normalizeProductName(item.product || ""));

  // fallback for very small comma-style input
  if (!parsed.length) {
    const loose = parseBulkOrderInput(raw)
      .filter(i => i && normalizeProductName(i.product || ""))
      .map(i => ({
        product: String(i.product || "").trim(),
        quantity: Number(i.quantity || 1),
        unitLabel: i.unitLabel || "units",
        notes: ""
      }));

    return loose;
  }

  return parsed.map(item => ({
    product: item.product,
    quantity: Number(item.quantity || 1),
    unitLabel: item.unitLabel || "units",
    notes: item.notes || ""
  }));
}

function formatBuyerRequestItems(items = [], limit = 15) {
  const visible = items.slice(0, limit);
  const lines = visible.map((item, idx) => {
    const qty = Number(item.quantity || 1);
    const unitLabel = item.unitLabel || "units";
    return `${idx + 1}. ${item.product} x${qty}${unitLabel && unitLabel !== "units" ? ` ${unitLabel}` : ""}`;
  });

  if (items.length > limit) {
    lines.push(`… and ${items.length - limit} more item${items.length - limit === 1 ? "" : "s"}`);
  }

  return lines.join("\n");
}

function parseBuyerRequestLocationInput(text = "") {
  const raw = String(text || "").trim();
  if (!raw) return { city: null, area: null };

  const lower = raw.toLowerCase();
  const matchedCity = SUPPLIER_CITIES.find(c => lower.includes(String(c).toLowerCase())) || null;

  let area = null;
  if (matchedCity) {
    area = raw
      .replace(new RegExp(matchedCity, "i"), "")
      .replace(/^[,\-\s]+|[,\-\s]+$/g, "")
      .trim() || null;
  }

  if (!matchedCity && raw.includes(",")) {
    const parts = raw.split(",").map(p => p.trim()).filter(Boolean);
    if (parts.length >= 2) {
      const cityCandidate = parts[parts.length - 1];
      const exactCity = SUPPLIER_CITIES.find(c => c.toLowerCase() === cityCandidate.toLowerCase()) || null;
      if (exactCity) {
        return {
          city: exactCity,
          area: parts.slice(0, -1).join(", ").trim() || null
        };
      }
    }
  }

  return {
    city: matchedCity,
    area
  };
}

function parseInlineSimpleBuyerRequest(text = "") {
  const raw = String(text || "").trim();
  if (!raw) {
    return {
      items: [],
      city: null,
      area: null,
      itemText: ""
    };
  }

  // Reuse the same shortcode parser used by Browse & Shop
  const parsed =
    parseShortcodeSearch(raw) ||
    parseShortcodeSearch(raw.startsWith("find ") ? raw : `find ${raw}`);

  if (!parsed || !parsed.product) {
    return {
      items: [],
      city: null,
      area: null,
      itemText: raw
    };
  }

  let productText = String(parsed.product || "").trim();

  // ── Quantity extraction ───────────────────────────────────────────────────────
  // Rules:
  //  1. "x 5" or "x5" anywhere at end → explicit qty, always accepted
  //  2. Bare trailing number with NO unit → qty, e.g. "cement 10"
  //  3. Bare trailing number WITH a measurement unit suffix → PART OF PRODUCT NAME
  //     e.g. "ball valve 20mm" → product="ball valve 20mm", qty=1 (NOT qty=20)
  //
  // Measurement suffixes that must stay attached to the product (not treated as units):
  const MEASUREMENT_SUFFIXES = new Set([
    "mm","cm","m","km","ml","l","kg","g","mg","lb","lbs","oz","ft","in","inch",
    "psi","bar","kpa","mpa","kw","kva","hp","v","volt","amp","amps","watt","w","a","ah",
    "litre","litres","liter","liters","tonne","tonnes","ton","tons","metre","metres",
    "meter","meters","gallon","gallons","inch","inches","sqm","sqft","kwh","mhz","ghz",
    "mb","gb","tb","rpm","nm","khz","mw","gw"
  ]);

  let quantity = 1;
  let unitLabel = "units";

  // Case 1: explicit "x N unit?" at end - always treat as qty
  const explicitQtyMatch = productText.match(/^(.+?)\s+x\s*(\d+(?:\.\d+)?)\s*([a-zA-Z]*)$/i);
  if (explicitQtyMatch) {
    const maybeProduct = String(explicitQtyMatch[1] || "").trim();
    const maybeQty     = Number(explicitQtyMatch[2] || 1);
    const maybeUnit    = String(explicitQtyMatch[3] || "").trim().toLowerCase();
    if (maybeProduct && Number.isFinite(maybeQty) && maybeQty > 0) {
      return {
        items: [{ product: maybeProduct, quantity: maybeQty, unitLabel: maybeUnit || "units", notes: "" }],
        city: parsed.city || null, area: parsed.area || null, itemText: maybeProduct
      };
    }
  }

  // Case 2: bare trailing "N unit?" - only treat as qty if unit is NOT a measurement suffix
  const bareQtyMatch = productText.match(/^(.+?)\s+(\d+(?:\.\d+)?)\s*([a-zA-Z]*)$/i);
  if (bareQtyMatch) {
    const maybeProduct = String(bareQtyMatch[1] || "").trim();
    const maybeQty     = Number(bareQtyMatch[2] || 1);
    const maybeUnit    = String(bareQtyMatch[3] || "").trim().toLowerCase();

    // If the unit part is a measurement suffix → keep whole string as product name, qty=1
    const isMeasurement = maybeUnit && MEASUREMENT_SUFFIXES.has(maybeUnit);
    // Also guard: if the "product" part itself ends with a measurement-looking pattern
    // e.g. "20mm" → don't split
    const productEndsMeasurement = /\d+\s*(mm|cm|kg|ml|l|m|ft|in|psi|bar|v|w|a|hp|kw|kva|ah|litre|litr)$/i.test(maybeProduct);

    if (!isMeasurement && !productEndsMeasurement && maybeProduct && Number.isFinite(maybeQty) && maybeQty > 0 && maybeQty < 10000) {
      return {
        items: [{ product: maybeProduct, quantity: maybeQty, unitLabel: maybeUnit || "units", notes: "" }],
        city: parsed.city || null, area: parsed.area || null, itemText: maybeProduct
      };
    }
  }

  // Case 3: No quantity - default qty=1, full productText is the product name
  return {
    items: [{ product: productText, quantity: 1, unitLabel: "units", notes: "" }],
    city: parsed.city || null, area: parsed.area || null, itemText: productText
  };
}


function tokenizeProductText(value = "") {
  return normalizeProductName(value)
    .split(" ")
    .map(t => t.trim())
    .filter(Boolean)
    .filter(t => t.length > 1);
}

function scoreVariantCandidate(requestedProduct = "", candidateName = "") {
  const req = normalizeProductName(requestedProduct);
  const cand = normalizeProductName(candidateName);

  if (!req || !cand) return 0;
  if (req === cand) return 100;

  let score = 0;

  if (cand.startsWith(req)) score += 40;
  if (cand.includes(req)) score += 25;
  if (req.includes(cand)) score += 10;

  const reqTokens = tokenizeProductText(req);
  const candTokens = tokenizeProductText(cand);

  for (const token of reqTokens) {
    if (candTokens.includes(token)) score += 8;
    else if (cand.includes(token)) score += 4;
  }

  if (reqTokens.length === 1 && candTokens.length > 1 && cand.includes(reqTokens[0])) {
    score += 12;
  }

  return score;
}

function getSupplierVariantMatches(supplier, requestedProduct = "", opts = {}) {
  const limit = Number(opts.limit || 5);

  const catalogueItems = getSupplierCatalogueSourceItems(supplier) || [];
  const scored = catalogueItems
    .map(item => ({
      ...item,
      score: scoreVariantCandidate(requestedProduct, item.name)
    }))
    .filter(item => item.score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;

      const aPriced = typeof a.rawPrice === "number" ? 1 : 0;
      const bPriced = typeof b.rawPrice === "number" ? 1 : 0;
      if (bPriced !== aPriced) return bPriced - aPriced;

      return String(a.name).localeCompare(String(b.name));
    });

  return scored.slice(0, limit);
}

function isStrongSingleVariantMatch(matches = []) {
  if (!matches.length) return false;
  if (matches.length === 1) return true;

  const first = matches[0];
  const second = matches[1];

  if (!first) return false;
  if (!second) return true;

  // clear winner if score gap is good enough
  return (first.score - second.score) >= 12;
}

async function findSuppliersForBuyerRequest({ items = [], city = null, area = null }) {
  const scoreMap = new Map();
  const topItems = items.slice(0, 5);

  for (const item of topItems) {
    // Always search BOTH product and service suppliers for buyer requests
    const productResults = await runSupplierSearch({
      city: city || null, product: item.product, area: area || null, profileType: "product"
    });
    const serviceResults = await runSupplierSearch({
      city: city || null, product: item.product, area: area || null, profileType: "service"
    });
    const results = [...productResults, ...serviceResults];

    for (const supplier of results || []) {
      const key = String(supplier._id);
      const current = scoreMap.get(key) || { supplier, score: 0 };
      current.score += 1;
      scoreMap.set(key, current);
    }
  }

  return [...scoreMap.values()]
    .sort((a, b) => b.score - a.score)
    .map(entry => entry.supplier)
    .filter(s => s && s.active)
    .slice(0, 10);
}

function buildBuyerRequestRef(request) {
  return `REQ-${String(request._id).slice(-6).toUpperCase()}`;
}


async function sendBuyerQuotePdf({ request, supplier, response }) {
  try {
    if (!response || !Array.isArray(response.items) || !response.items.length) {
      return null;
    }

    const ref          = buildBuyerRequestRef(request);
    const supplierName = supplier?.businessName || response?.supplierName || "Supplier";
    const site         = (process.env.SITE_URL || "").replace(/\/$/, "");

    // ── Supplier contact details for the PDF ──────────────────────────────────
    const supplierPhone   = supplier?.contactDetails || response?.supplierPhone || supplier?.phone || "";
    const supplierAddress = [
      supplier?.address,
      supplier?.location?.area,
      supplier?.location?.city
    ].filter(Boolean).join(", ") || "";
    const supplierWebsite = supplier?.website || "";

    // ── Delivery / collection note ────────────────────────────────────────────
    const deliveryNote = request.deliveryRequired
      ? "Delivery to buyer required"
      : response.deliveryAvailable === true
        ? "Delivery available"
        : "Collection only";

    // ── Buyer info shown on the quote ─────────────────────────────────────────
    const buyerRef  = request.buyerPhone
      ? `WhatsApp: ${request.buyerPhone}`
      : "";
    const buyerArea = request.area
      ? `${request.area}, ${request.city || "Zimbabwe"}`
      : (request.city || "Zimbabwe");

    // ── Build billingTo block - buyer details ─────────────────────────────────
    const billingTo = [
      `Request Ref: ${ref}`,
      `Location: ${buyerArea}`,
      buyerRef,
      deliveryNote
    ].filter(Boolean).join("\n");

    // ── Build supplier address block for bizMeta ──────────────────────────────
    const supplierAddressBlock = [
      supplierAddress,
      supplierPhone  ? `Tel: ${supplierPhone}` : "",
      supplierWebsite ? `Web: ${supplierWebsite}` : ""
    ].filter(Boolean).join("\n");

    // ── Notes / message from supplier ─────────────────────────────────────────
    const supplierNote = response.message
      ? `Note from seller: ${response.message}`
      : "";

    const { filename } = await generatePDF({
      type:      "quote",
      number:    ref,
      date:      new Date(),
      billingTo,
      notes:     supplierNote || undefined,
      items: (response.items || []).map(i => ({
        item:  i.product,
        qty:   Number(i.quantity || 1),
        unit:  Number(i.pricePerUnit || 0),
        total: Number(i.total || 0)
      })),
      bizMeta: {
        name:     supplierName,
        logoUrl:  supplier?.logoUrl || "",
        address:  supplierAddressBlock,
        _id:      String(supplier?._id || request._id),
        status:   "quotation"
      }
    });

    // Use /quotes/ path - same folder used by working invoice/quote sendDocument calls
    const link = `${site}/docs/generated/quotes/${filename}`;

    // ── Normalize buyer phone ─────────────────────────────────────────────────
    const _normBuyerPdf  = String(request.buyerPhone || "").replace(/\D+/g, "");
    const _fullBuyerPdf  = _normBuyerPdf.startsWith("0") && _normBuyerPdf.length === 10
      ? "263" + _normBuyerPdf.slice(1) : _normBuyerPdf;

    // ── Send the PDF document - same call signature as working invoice/receipt sends ─
    await sendDocument(_fullBuyerPdf, { link, filename });
    console.log(`[BUYER QUOTE PDF] PDF dispatched to ${_fullBuyerPdf}: ${filename}`);

    // ── Follow-up text so buyer knows to scroll up for the PDF ───────────────────
    const _followUpText =
      `📄 *Quotation PDF sent above ↑*\n` +
      `📞 To order, contact: ${response.supplierPhone || supplierPhone}\n` +
      `_Reference: ${ref}_`;
    try {
      await sendText(_fullBuyerPdf, _followUpText);
    } catch (_) {}

    return link;
  } catch (err) {
    console.error("[BUYER QUOTE PDF]", err.message);
    return null;
  }
}
async function buildAutoQuoteForSupplier({ supplier, items = [] }) {
  const responseItems = [];
  let matchedCount = 0;
  let totalAmount = 0;

  const ambiguousItems = [];
  const unmatchedItems = [];

  for (const item of items) {
    const requestedName = item.product;

    // 1) try current exact/partial priced match logic first
    const directMatch = findMatchingSupplierPrice(supplier, requestedName);

    if (directMatch && typeof directMatch.amount === "number" && !Number.isNaN(directMatch.amount)) {
      const qty = Number(item.quantity || 1);
      const total = Number((qty * Number(directMatch.amount)).toFixed(2));

      responseItems.push({
        product: directMatch.product || requestedName,
        quantity: qty,
        unit: directMatch.unit || item.unitLabel || "each",
        pricePerUnit: Number(directMatch.amount),
        total,
        available: true
      });

      matchedCount += 1;
      totalAmount += total;
      continue;
    }

    // 2) try broader catalogue variant matching
    const variantMatches = getSupplierVariantMatches(supplier, requestedName, { limit: 5 });

    // only auto-use if there is one strong clear winner AND it has a price
    if (isStrongSingleVariantMatch(variantMatches)) {
      const best = variantMatches[0];

      if (typeof best.rawPrice === "number" && !Number.isNaN(best.rawPrice)) {
        const qty = Number(item.quantity || 1);
        const total = Number((qty * Number(best.rawPrice)).toFixed(2));

        responseItems.push({
          product: best.name || requestedName,
          quantity: qty,
          unit: best.unit || item.unitLabel || "each",
          pricePerUnit: Number(best.rawPrice),
          total,
          available: true
        });

        matchedCount += 1;
        totalAmount += total;
        continue;
      }
    }

    // 3) multiple possible matches = ambiguous, do not fail silently
    if (variantMatches.length) {
      ambiguousItems.push({
        requested: requestedName,
        suggestions: variantMatches.slice(0, 3).map(v => ({
          name: v.name,
          priced: typeof v.rawPrice === "number" && !Number.isNaN(v.rawPrice),
          priceLabel: v.priceLabel || ""
        }))
      });
      continue;
    }

    // 4) nothing similar found
    unmatchedItems.push(requestedName);
  }

  return {
    matchedCount,
    responseItems,
    totalAmount: responseItems.length ? Number(totalAmount.toFixed(2)) : null,
    fullyPriced: responseItems.length === items.length && items.length > 0,
    ambiguousItems,
    unmatchedItems
  };
}

async function sendBuyerRequestResponseToBuyer({ request, supplier, response }) {
  const supplierName = supplier?.businessName || response?.supplierName || "Supplier";
  const ref = buildBuyerRequestRef(request);

  if (response.mode === "unavailable") {
    return sendButtons(request.buyerPhone, {
      text:
        `📭 *Response for ${ref}*\n\n` +
        `🏪 ${supplierName}\n` +
        `This seller is not available for your request right now.`,
      buttons: [
        { id: "find_supplier", title: "🔍 Browse & Shop" },
        { id: "my_orders", title: "📋 My Orders" }
      ]
    });
  }

  const itemLines = (response.items || []).length
    ? response.items.map(i =>
        `• ${i.product} x${Number(i.quantity || 1)} @ $${Number(i.pricePerUnit || 0).toFixed(2)}/${i.unit || "each"} = $${Number(i.total || 0).toFixed(2)}`
      ).join("\n")
    : "• Seller sent a custom offer";

  const totalLine =
    typeof response.totalAmount === "number"
      ? `\n💵 Total: $${Number(response.totalAmount).toFixed(2)}`
      : "";

  const noteLine = response.message ? `\n📝 ${response.message}` : "";
  const etaLine = response.etaText ? `\n⏱ ${response.etaText}` : "";

 // Count valid quotes received so far including this one
  const _quoteCount = (request.responses || []).filter(
    r => r.mode !== "unavailable" && (r.items?.length || r.message)
  ).length;
 
  const _moreComingLine = request.status === "open"
    ? `\n_Request still open - more quotes may arrive._`
    : "";
 
  // ── Try to reach buyer with interactive message ──────────────────────────────
  // If buyer hasn't messaged in 24hrs, fall back to Meta template to re-open session
  const _buyerMsg = {
    text:
      `📨 *New Seller Quote* (${ref})\n` +
      `💬 ${_quoteCount} quote${_quoteCount === 1 ? "" : "s"} received so far\n\n` +
      `🏪 *${supplierName}*\n\n` +
      `${itemLines}` +
      `${totalLine}` +
      `${etaLine}` +
      `${noteLine}\n\n` +
      `📞 Contact: ${response.supplierPhone}` +
      `${_moreComingLine}`,
    buttons: [
      { id: `buyer_view_all_quotes_${request._id}`, title: "📊 Compare All Quotes" },
      { id: "find_supplier",                        title: "🛒 Marketplace" }
    ]
  };

  let _buyerMsgSent = false;
  try {
    await sendButtons(request.buyerPhone, _buyerMsg);
    _buyerMsgSent = true;
  } catch (btnErr) {
    console.warn(`[BUYER QUOTE NOTIFY] sendButtons failed for ${request.buyerPhone}: ${btnErr.message} - trying template`);
  }

  // ── Template fallback: buyer is outside 24hr session ─────────────────────────
  // Uses supplier_new_buyer_request template (already approved) as a session opener,
  // then immediately sends the full interactive quote details.
  if (!_buyerMsgSent) {
    try {
      const _axiosBuyer  = (await import("axios")).default;
      const _PHONEID_B   = process.env.WHATSAPP_PHONE_NUMBER_ID || process.env.META_PHONE_NUMBER_ID || process.env.PHONE_NUMBER_ID;
      const _TOKEN_B     = process.env.META_ACCESS_TOKEN || process.env.WHATSAPP_ACCESS_TOKEN;
      const _normBuyer   = String(request.buyerPhone).replace(/\D+/g, "");
      const _fullBuyer   = _normBuyer.startsWith("0") && _normBuyer.length === 10
        ? "263" + _normBuyer.slice(1) : _normBuyer;

      const _totalStr    = typeof response.totalAmount === "number"
        ? `$${Number(response.totalAmount).toFixed(2)}`
        : "Price on request";
      const _cityStr     = request.city || "Zimbabwe";

      // Ping buyer via approved template to re-open their session
      await _axiosBuyer.post(
        `https://graph.facebook.com/v24.0/${_PHONEID_B}/messages`,
        {
          messaging_product: "whatsapp",
          to:   _fullBuyer,
          type: "template",
          template: {
            name:     "supplier_new_buyer_request",
            language: { code: "en" },
            components: [{
              type: "body",
              parameters: [
                { type: "text", text: ref },
                { type: "text", text: _cityStr },
                { type: "text", text: `Quote from ${supplierName}: ${_totalStr}` },
                { type: "text", text: "Tap to view full quote" }
              ]
            }]
          }
        },
        { headers: { Authorization: `Bearer ${_TOKEN_B}`, "Content-Type": "application/json" } }
      );
      console.log(`[BUYER QUOTE NOTIFY] Template sent to buyer ${_fullBuyer} (${ref})`);

      // Session now open - send full interactive quote after 2s
      await new Promise(r => setTimeout(r, 2000));
      await sendButtons(_fullBuyer, _buyerMsg);
    } catch (tplErr) {
      console.error(`[BUYER QUOTE NOTIFY] Template also failed for ${request.buyerPhone}: ${tplErr.message}`);
    }
  }

  // Send PDF quotation whenever there are priced line items
  // (message-only quotes skip PDF - nothing meaningful to put on paper)
  if (Array.isArray(response.items) && response.items.length > 0) {
    // Non-blocking: don't let PDF failure break the quote delivery
    sendBuyerQuotePdf({ request, supplier, response }).catch(pdfErr =>
      console.error("[BUYER QUOTE PDF] Failed:", pdfErr.message)
    );
  }

  return;
}
async function notifySuppliersOfBuyerRequest(request) {
  const suppliers = await findSuppliersForBuyerRequest({
    items: request.items || [],
    city: request.city || null,
    area: request.area || null
    // profileType intentionally omitted: findSuppliersForBuyerRequest always searches both product & service
  });

  const notifiedIds = [];

  for (const supplier of suppliers) {
    try {
      const ref = buildBuyerRequestRef(request);
      const itemLines = formatBuyerRequestItems(request.items || [], 12);
      const locationLine = request.area
        ? `📍 ${request.area}${request.city ? `, ${request.city}` : ""}`
        : request.city
          ? `📍 ${request.city}`
          : `📍 Zimbabwe`;

        // Build numbered item list with quick-reply guidance
      const _notifItemLines = (request.items || []).map((item, i) => {
        const qty  = Number(item.quantity || 1);
        const unit = item.unitLabel && item.unitLabel !== "units" ? ` ${item.unitLabel}` : "";
        return `${i + 1}. ${item.product} (${qty}${unit})`;
      }).join("\n");
 
      const _notifItemCount  = (request.items || []).length;
      const _notifExamples   = _notifItemCount === 1
        ? `1=12.50`
        : Array.from({ length: Math.min(_notifItemCount, 3) }, (_, i) => `${i + 1}=${(i * 5 + 10).toFixed(2)}`).join(", ");
 
      // Build compact item summary for the template (single line, max 1024 chars)
 // Template variable must be single-line - no newlines allowed
     // Template ping only - full item list shown when supplier taps into chatbot
      const _templateItemCount = (request.items || []).length;

      const _templateLocation = request.area
        ? `${request.area}${request.city ? `, ${request.city}` : ""}`
        : request.city || "Zimbabwe";

      const _isServiceNotif = request.isServiceRequest || _buyerRequestIsService(request.items || []);
      const _deliveryLine = _isServiceNotif
        ? (request.serviceAddress
            ? `📍 Service at: ${request.serviceAddress}`
            : "📍 Client will share their address")
        : request.deliveryRequired
          ? "🚚 Delivery to buyer needed"
          : "🏠 Collection / flexible";

   // Step 1: Send template ping - reaches supplier even outside 24-hour window
      await notifySupplierNewRequestTemplate({
        supplierPhone: supplier.phone,
        requestId:     String(request._id),
        ref,
        locationText:  _templateLocation,
        itemCount:     _templateItemCount,
        itemSummary:   _notifItemLines,
        deliveryLine:  _deliveryLine,
        fullItemLines: _notifItemLines,
        replyExamples: _notifExamples
      });

      // Step 2: Immediately send interactive pricing form - template opens the session
      // so this sendButtons is always deliverable right after the template ping.
      const _supplierPhone = String(supplier.phone).replace(/\D+/g, "");
      const _normalizedSupplierPhone = _supplierPhone.startsWith("0") && _supplierPhone.length === 10
        ? "263" + _supplierPhone.slice(1) : _supplierPhone;

      // ── Step 2: Set state to "awaiting_offer_intro" ─────────────────────────────
      // We do NOT send a follow-up message here - Meta only opens a real session
      // when the supplier sends a message back to us, not when we send to them.
      // Instead, the FIRST message the supplier sends (even "hi") will show
      // them the full item list + View & Quote button. See awaiting_offer_intro handler.
      await UserSession.findOneAndUpdate(
        { phone: _normalizedSupplierPhone },
        {
          $set: {
            "tempData.sellerRequestReplyState": "awaiting_offer_intro",
            "tempData.sellerRequestId":         String(request._id)
          }
        },
        { upsert: true }
      );
      console.log(`[BUYER REQ] Session set to awaiting_offer_intro for ${_normalizedSupplierPhone}`);
      notifiedIds.push(supplier._id);
    } catch (err) {
      console.error("[BUYER REQUEST NOTIFY]", err.message);
    }
  }

  request.notifiedSuppliers = notifiedIds;
  await request.save();

  return notifiedIds.length;
}


// ── Detect whether a buyer request is for services (vs. physical products) ──
// Checks item names against known service keywords so we can use correct
// language ("service address" instead of "delivery") in the buyer flow.
function _buyerRequestIsService(items = []) {
  const SERVICE_KEYWORDS = [
    "install","repair","fix","service","replace","fitting","fit","plumb","drain",
    "electric","wire","wiring","paint","build","construct","renovate","plaster",
    "weld","clean","garden","lawn","trim","tutor","teach","lesson","photograph",
    "video","cater","chef","design","print","security","guard","account",
    "tax","audit","legal","transport","courier","mechanic","beat",
    "geyser","borehole","fumigat","pest","massage","barber","haircut","hair",
    "nail","makeup","booking","hire","maintenance","thermostat","element"
  ];
  if (!items || !items.length) return false;
  return items.some(item => {
    const name = (item.product || item.service || item.raw || "").toLowerCase();
    return SERVICE_KEYWORDS.some(kw => name.includes(kw));
  });
}

async function finalizeBuyerRequestSubmission({ from, phone, pendingRequest, deliveryRequired = false, serviceAddress = null }) {
  const _isServiceReq = pendingRequest.isServiceRequest || _buyerRequestIsService(pendingRequest.items || []);
  const request = await BuyerRequest.create({
    buyerPhone: from,
    requestType: pendingRequest.requestType || "simple",
    profileType: pendingRequest.profileType || "product",  // DB storage only - search always covers both
    rawText: pendingRequest.rawText || "",
    items: pendingRequest.items || [],
    city: pendingRequest.city || null,
    area: pendingRequest.area || null,
    deliveryRequired: _isServiceReq ? false : Boolean(deliveryRequired),
    serviceAddress: serviceAddress || pendingRequest.serviceAddress || null,
    status: "open"
  });

  const sentCount = await notifySuppliersOfBuyerRequest(request);

  await UserSession.findOneAndUpdate(
    { phone },
    {
      $unset: {
        "tempData.buyerRequestState": "",
        "tempData.pendingBuyerRequest": "",
        "tempData.buyerRequestMode": ""
      }
    },
    { upsert: true }
  );

  const ref = buildBuyerRequestRef(request);

  const _locationLine = request.area
    ? `📍 ${request.area}${request.city ? `, ${request.city}` : ""}\n`
    : request.city ? `📍 ${request.city}\n` : "";
  const _deliveryLine = _isServiceReq
    ? (request.serviceAddress
        ? `📍 Service address: ${request.serviceAddress}\n`
        : "📍 You will share your address with the provider\n")
    : (deliveryRequired ? "🚚 Delivery required\n" : "🏠 Collection / no delivery needed\n");
  const _sellerWord = _isServiceReq ? "service provider" : "seller";

  return sendButtons(from, {
    text:
      `✅ *Request sent* (${ref})\n\n` +
      `${formatBuyerRequestItems(request.items || [], 10)}\n\n` +
      `${_locationLine}` +
      `${_deliveryLine}` +
      `📣 Sent to ${sentCount} matching ${_sellerWord}${sentCount === 1 ? "" : "s"}.\n\n` +
      `You will receive quotes here in the chatbot.`,
    buttons: [
      { id: "sup_request_sellers", title: "⚡ Request Again" },
      { id: "my_orders", title: "📋 My Orders" },
      { id: "find_supplier", title: "🔍 Browse & Shop" }
    ]
  });
}

async function _sendSupplierCatalogueBrowser(from, supplier, cart = [], opts = {}) {
  const searchTerm = opts.searchTerm || "";
  const pageSize = opts.pageSize || 6;
  const selectionMode = opts.selectionMode || "catalogue";

  const allItems = getFilteredSupplierCatalogueItems(supplier, searchTerm);
  const totalItems = allItems.length;

  if (!totalItems) {
    return sendButtons(from, {
      text:
        `😕 No ${supplier.profileType === "service" ? "services" : "products"} found` +
        (searchTerm ? ` for *${searchTerm}*.` : "."),
      buttons: [
     { id: `sup_catalogue_search_${supplier._id}`, title: "🔎 Search Again" },
        { id: `sup_catalog_page_open_${supplier._id}`, title: "📚 Full Catalogue" },
        { id: `sup_cart_view_${supplier._id}`, title: "🛒 View Cart" }
      ]
    });
  }

  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
  const page = Math.max(0, Math.min(Number(opts.page || 0), totalPages - 1));
  const start = page * pageSize;
  const visible = allItems.slice(start, start + pageSize);

  const rows = visible.map(item => ({
    id: `sup_cart_add_${supplier._id}_${encodeURIComponent(item.name)}`,
    title: item.name.slice(0, 72),
    description:
      item.priceLabel ||
      (supplier.profileType === "service" ? "Tap to select this service" : "Tap to select this item")
  }));
  if (page > 0) {
    rows.push({
      id: `sup_catalog_page_prev_${supplier._id}`,
      title: opts.selectionMode === "search_pick" ? "⬅ Previous Matches" : "⬅ Previous Products"
    });
  }

  if (page < totalPages - 1) {
    rows.push({
      id: `sup_catalog_page_next_${supplier._id}`,
      title: opts.selectionMode === "search_pick" ? "➡ More Matches" : "➡ More Products"
    });
  }

  if (page === 0 && opts.selectionMode === "search_pick") {
    rows.push({ id: `sup_catalog_page_open_${supplier._id}`, title: "📚 Full Catalogue" });
  }

  if (page === 0) {
    rows.push({ id: `sup_number_page_open_${supplier._id}`, title: "⚡ Quick Order" });
  }

  rows.push({ id: `sup_cart_view_${supplier._id}`, title: "🛒 View Cart" });

  if (rows.length > 10) rows.splice(10);

   const header = formatCatalogueHeader({
    supplier,
    page,
    totalPages,
    totalItems,
    searchTerm,
    cartCount: cart.length,
    selectionMode: opts.selectionMode || "catalogue"
  });

  return sendList(from, header, rows);
}


async function _sendSupplierNumberedCatalogueText(from, supplier, cart = [], opts = {}) {
  const searchTerm = opts.searchTerm || "";
  const pageSize = opts.pageSize || 25;

  const allItems = getFilteredSupplierCatalogueItems(supplier, searchTerm);
  const totalItems = allItems.length;

  if (!totalItems) {
    return sendButtons(from, {
      text:
        `😕 No ${supplier.profileType === "service" ? "services" : "products"} found` +
        (searchTerm ? ` for *${searchTerm}*.` : "."),
      buttons: [
        { id: `sup_catalogue_search_${supplier._id}`, title: "🔎 Search Again" },
        { id: `sup_catalog_page_open_${supplier._id}`, title: "📚 Full Catalogue" },
        { id: `sup_cart_view_${supplier._id}`, title: "🛒 View Cart" }
      ]
    });
  }

  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
  const page = Math.max(0, Math.min(Number(opts.page || 0), totalPages - 1));
  const start = page * pageSize;
  const visible = allItems.slice(start, start + pageSize);

  const numbered = visible
    .map((item, i) => {
      const absoluteIndex = start + i + 1;
      return `${absoluteIndex}. ${item.name}${item.priceLabel ? ` - ${item.priceLabel}` : ""}`;
    })
    .join("\n");

  const cartLine = cart.length ? `\n🛒 Cart: ${cart.length} item${cart.length === 1 ? "" : "s"}` : "";
  const searchLine = searchTerm ? `\n🔎 Filtered: *${searchTerm}*` : "";
  const modeLine = searchTerm
    ? `\nShowing matching items first. You can open the full catalogue below.`
    : "";

  await sendText(
    from,
`⚡ *Quick Order by Number*
${supplier.businessName}${searchLine}${cartLine}${modeLine}

Page ${page + 1} of ${totalPages} • ${totalItems} item${totalItems === 1 ? "" : "s"}

${numbered}

*Send item number + quantity*
Examples:
_2x3_
_7x1, 10x4_
_12x2, 15x1, 18x6_`
  );

  const navButtons = [];
  if (page > 0) {
    navButtons.push({ id: `sup_number_page_prev_${supplier._id}`, title: "⬅ Prev Numbers" });
  }
  if (page < totalPages - 1) {
    navButtons.push({ id: `sup_number_page_next_${supplier._id}`, title: "➡ Next Numbers" });
  }

  if (navButtons.length) {
    await sendButtons(from, {
      text: "Choose next page:",
      buttons: navButtons
    });
  }

  const utilityButtons = [];

  if (searchTerm) {
    utilityButtons.push({ id: `sup_number_full_${supplier._id}`, title: "📚 Full Catalogue" });
  } else {
    utilityButtons.push({ id: `sup_catalog_page_open_${supplier._id}`, title: "📚 Browse Catalogue" });
  }

  utilityButtons.push({ id: `sup_cart_view_${supplier._id}`, title: "🛒 View Cart" });
  utilityButtons.push({ id: "sup_back_to_search_results", title: "⬅ Back" });

  return sendButtons(from, {
    text: "Other options:",
    buttons: utilityButtons
  });
}



async function _sendSupplierCartMenu(from, supplier, cart = []) {
  const sess = await UserSession.findOne({ phone: from.replace(/\D+/g, "") });
  const focusedItem = sess?.tempData?.selectedSupplierItem || null;

  if (!cart.length) {
    return sendButtons(from, {
      text: "🛒 Your cart is empty.",
      buttons: [
        { id: `sup_catalog_page_open_${supplier._id}`, title: "📚 Browse Catalogue" },
        { id: `sup_catalogue_search_${supplier._id}`, title: "🔎 Search Supplier" },
        { id: "suppliers_home", title: "⬅ Suppliers" }
      ]
    });
  }

  const rows = cart.slice(0, 5).map(item => ({
    id: `sup_cart_remove_${supplier._id}_${encodeURIComponent(item.product)}`,
    title: `➖ Remove ${item.product}`.slice(0, 72),
    description:
      `Qty ${item.quantity}` +
      (typeof item.pricePerUnit === "number"
        ? ` • $${Number(item.pricePerUnit).toFixed(2)}/${item.unit || "each"}`
        : "")
  }));

  rows.push({
    id: `sup_cart_confirm_${supplier._id}`,
    title: supplier.profileType === "service" ? "✅ Confirm Booking" : "✅ Confirm & Send Order"
  });

  rows.push({ id: `sup_cart_clear_${supplier._id}`, title: "🗑 Clear Cart" });
  rows.push({ id: `sup_catalog_page_open_${supplier._id}`, title: "📚 Add More Items" });
  rows.push({ id: `sup_catalogue_search_${supplier._id}`, title: "🔎 Search Supplier" });
  rows.push({ id: `sup_cart_custom_${supplier._id}`, title: "✍ Type Custom Item" });

  const summary = cart
    .map(i => {
      const price = typeof i.pricePerUnit === "number" ? ` @ $${Number(i.pricePerUnit).toFixed(2)}` : "";
      return `• ${i.product} x${i.quantity}${price}`;
    })
    .join("\n");

  const focusedLine = focusedItem?.product
    ? `🎯 *Selected now:* ${focusedItem.product}\n\n`
    : "";

  if (rows.length > 10) rows.splice(10);

  return sendList(
    from,
    `${focusedLine}🛒 *Your Cart* (${cart.length} item${cart.length === 1 ? "" : "s"})\n\n${summary}`,
    rows
  );
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

async function showSalesDocs(from, type, ownerBranchId = undefined, page = 0, search = null, dateFilter = null) {
  const biz = await getBizForPhone(from);
  if (!biz) return sendMainMenu(from);

  const phone  = from.replace(/\D+/g, "");
  const caller = await UserRole.findOne({ businessId: biz._id, phone, pending: false });
  const query  = { businessId: biz._id, type };

  if (caller?.role === "owner" && ownerBranchId !== undefined) {
    if (ownerBranchId !== null) query.branchId = ownerBranchId;
  } else if (caller && ["clerk", "manager"].includes(caller.role) && caller.branchId) {
    query.branchId = caller.branchId;
  }

  // ── Date filter ───────────────────────────────────────────────────────────
  if (dateFilter) {
    const now   = new Date();
    const year  = now.getFullYear();
    const month = now.getMonth();
    if (dateFilter === "this_month") {
      query.createdAt = { $gte: new Date(year, month, 1), $lt: new Date(year, month + 1, 1) };
    } else if (dateFilter === "last_month") {
      query.createdAt = { $gte: new Date(year, month - 1, 1), $lt: new Date(year, month, 1) };
    } else if (dateFilter === "this_year") {
      query.createdAt = { $gte: new Date(year, 0, 1), $lt: new Date(year + 1, 0, 1) };
    } else if (dateFilter === "last_7") {
      const d = new Date(); d.setDate(d.getDate() - 7);
      query.createdAt = { $gte: d };
    }
  }

  // ── Text search - invoice number or client name ───────────────────────────
  if (search) {
    const Client       = (await import("../models/client.js")).default;
    const matchClients = await Client.find({
      businessId: biz._id,
      name: { $regex: search, $options: "i" }
    }).distinct("_id");

    query.$or = [
      { number: { $regex: search, $options: "i" } },
      ...(matchClients.length ? [{ clientId: { $in: matchClients } }] : [])
    ];
  }

  const PAGE_SIZE  = 8;
  const total      = await Invoice.countDocuments(query);

  if (!total) {
    const label = dateFilter === "this_month" ? "this month"
                : dateFilter === "last_month" ? "last month"
                : dateFilter === "this_year"  ? "this year"
                : dateFilter === "last_7"     ? "last 7 days"
                : search ? `"${search}"` : "";
    await sendText(from, `📄 No ${type}s found${label ? ` for ${label}` : ""}.`);
    return sendSalesMenu(from);
  }

  const totalPages = Math.ceil(total / PAGE_SIZE);
  const safePage   = Math.min(page, totalPages - 1);
  const docs       = await Invoice.find(query)
    .sort({ createdAt: -1 })
    .skip(safePage * PAGE_SIZE)
    .limit(PAGE_SIZE)
    .lean();

  // Load client names
  const Client    = (await import("../models/client.js")).default;
  const clientIds = [...new Set(docs.map(d => d.clientId?.toString()).filter(Boolean))];
  const clients   = await Client.find({ _id: { $in: clientIds } }).lean();
  const clientMap = Object.fromEntries(clients.map(c => [c._id.toString(), c.name || c.phone || "-"]));

  // Build header
  let header = `📄 ${type[0].toUpperCase() + type.slice(1)}s`;
  if (ownerBranchId && caller?.role === "owner") {
    const branch = await Branch.findById(ownerBranchId);
    if (branch) header += ` - ${branch.name}`;
  } else if (caller?.role === "owner" && ownerBranchId === null) {
    header += ` - All`;
  }
  if (dateFilter === "this_month") header += " · This Month";
  else if (dateFilter === "last_month") header += " · Last Month";
  else if (dateFilter === "this_year")  header += " · This Year";
  else if (dateFilter === "last_7")     header += " · Last 7 Days";
  if (search) header += ` 🔍 "${search}"`;

  // Store in session so user can type number to open
  const typeCode    = type === "invoice" ? "inv" : type === "quote" ? "qt" : "rct";
  const branchCode  = ownerBranchId || "all";
  const filterCode  = dateFilter  || "none";
  const searchCode  = search ? encodeURIComponent(search).slice(0, 30) : "0";

  biz.sessionState = "sales_doc_list";
  biz.sessionData  = {
    docListType:    type,
    docListPage:    safePage,
    docListBranch:  ownerBranchId,
    docListSearch:  search,
    docListFilter:  dateFilter,
    docListIds:     docs.map(d => d._id.toString()),
    docListOffset:  safePage * PAGE_SIZE
  };
  await saveBizSafe(biz);

  // Numbered text list - no WhatsApp row limits
  let msg = `${header}\nPage ${safePage + 1}/${totalPages} · ${total} total\n\n`;
  docs.forEach((d, i) => {
    const statusIcon = d.status === "paid" ? "✅" : d.status === "partial" ? "⏳" : "🔴";
    const clientName = clientMap[d.clientId?.toString()] || "";
    const dateStr    = d.createdAt ? new Date(d.createdAt).toLocaleDateString("en-GB", { day: "numeric", month: "short" }) : "";
    msg += `${safePage * PAGE_SIZE + i + 1}. *${d.number}* ${statusIcon}\n`;
    msg += `   $${Number(d.total || 0).toFixed(2)} ${d.currency || ""}`;
    if (clientName) msg += ` · ${clientName}`;
    if (dateStr)    msg += ` · ${dateStr}`;
    msg += "\n";
  });
  msg += `\nType a number (1–${docs.length}) to open it.`;

  await sendText(from, msg);

  // Build 3 navigation/filter buttons
  const navBtns = [];
  if (safePage > 0)
    navBtns.push({ id: `vdoc_prev_${typeCode}_${branchCode}_${safePage}_${filterCode}_${searchCode}`, title: "⬅ Prev" });
  if (safePage < totalPages - 1)
    navBtns.push({ id: `vdoc_next_${typeCode}_${branchCode}_${safePage}_${filterCode}_${searchCode}`, title: "➡ Next" });

  // Filter button - show most useful one based on current state
  if (!dateFilter && !search)
    navBtns.push({ id: `vdoc_filter_${typeCode}_${branchCode}`, title: "📅 Filter by Date" });
  else
    navBtns.push({ id: `vdoc_filter_${typeCode}_${branchCode}`, title: "🔄 Change Filter" });

  return sendButtons(from, {
    text: "Open by number, filter, or search:",
    buttons: navBtns.slice(0, 3)
  });
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

  // ── NEW CONTACT TRACKING ─────────────────────────────────────────────────
  // Fire-and-forget: only writes on first contact, never overwrites.
  PhoneContact.findOneAndUpdate(
    { phone },
    { $setOnInsert: { phone, firstMessage: String(action || "").slice(0, 200), channel: "whatsapp" } },
    { upsert: true, new: false }
  ).catch(err => console.error("[PHONE CONTACT TRACK]", err.message));
  // ─────────────────────────────────────────────────────────────────────────

  const text = typeof action === "string" ? action.trim() : "";
  const al = text.toLowerCase();
  const a = typeof action === "string" ? action.trim().toLowerCase() : "";

const isMetaAction =
    typeof action === "string" &&
    (
 Object.values(ACTIONS).some(v => (v || "").toLowerCase() === a) ||
      a === "__document_uploaded__" ||
       a === "expense_generate_receipt" ||
      a.startsWith("report_branch_") ||
      a.startsWith("sup_") ||
      a.startsWith("rate_order_") ||
      a.startsWith("sup_plan_") ||
a.startsWith("sup_accept_") ||
      a.startsWith("sup_decline_") ||
      a.startsWith("sup_view_order_") ||
      a.startsWith("sup_contact_buyer_") ||
      a.startsWith("dec_out_of_stock") ||
      a.startsWith("dec_min_not_met") ||
      a.startsWith("dec_no_delivery") ||
      a.startsWith("dec_price_changed") ||
      a.startsWith("dec_other") ||
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
      a.startsWith("my_orders_page_") ||
      a.startsWith("order_detail_") ||
      a.startsWith("sup_book_") ||
      a.startsWith("sup_book_confirm_") ||
      a === "exp_show_categories" ||
      a.startsWith("exp_quick_save_") ||
  a === "reg_type_product" ||
      a === "reg_type_service" ||
      a === "reg_type_school" ||
      a.startsWith("sup_collar_") ||
      a === "sup_travel_yes" ||
      a === "sup_travel_no" ||
      a === "sup_preset_confirm" ||
a === "sup_preset_prices_yes" ||
a.startsWith("sup_load_preset_") ||
      a === "sup_skip_products" ||
a === "sup_enter_own_products" ||
a === "sup_request_upload" ||
a === "sup_addr_skip" ||
a === "sup_contact_skip" ||
a === "sup_website_skip" ||
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
      a === "sup_quick_edit_products" ||
      a === "sup_toggle_delivery" ||
      a === "sup_toggle_active" ||
      a === "sup_edit_area" ||
      a === "sup_my_orders" ||
      a === "sup_my_earnings" ||
      a === "sup_my_reviews" ||
      a === "sup_upgrade_plan" ||
      a === "sup_renew_plan" ||
      a === "onboard_business" ||
        a === "main_menu_back" ||
      a.startsWith("payinv_full_") ||
      a === "biz_tools_menu" ||
       a.startsWith("inv_cat_page_") ||


             a === "sup_request_quote_search" ||
      a === "sup_save_search_current" ||
      a.startsWith("sup_request_quote_supplier_") ||
      a.startsWith("sup_ask_availability_") ||



      a === "sup_request_sellers" ||
      a === "sup_request_mode_simple" ||
      a === "sup_request_mode_bulk" ||
      a === "sup_request_delivery_yes" ||
      a === "sup_request_delivery_no" ||
      buyerRequestState === "awaiting_service_address" ||
      a.startsWith("req_offer_") ||
      a.startsWith("req_unavail_") ||
      a === "view_and_quote" ||
      a === "not_available" ||
      a.startsWith("buyer_view_all_quotes_") ||
      a === "buyer_my_requests" ||


        a.startsWith("view_invoices_page_") ||
      a.startsWith("view_quotes_page_") ||
        a.startsWith("view_receipts_page_") ||
      a.startsWith("view_all_products_page_") ||
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
      a === "sup_search_prev_page" ||
 a.startsWith("vdoc_prev_") ||
      a.startsWith("vdoc_next_") ||
      a.startsWith("vdoc_search_") ||
      a.startsWith("vdoc_filter_") ||
      a.startsWith("vdoc_date_") ||
    a === "exp_show_categories" ||
      a === "exp_bulk_confirm_yes" ||
      a === "exp_bulk_confirm_no" ||
      a === "exp_bulk_keep_adding" ||
      a.startsWith("paylist_prev_") ||
      a.startsWith("paylist_next_") ||
      a.startsWith("paylist_search_") ||
      // ── Schools ────────────────────────────────────────────────────────────
      a === "find_school" ||
      a === "school_register" ||
      a === "school_account" ||
      a === "school_pay_plan" ||
      a === "school_search_refine" ||
      a === "school_toggle_admissions" ||
      a === "school_update_fees" ||
      a === "school_reg_confirm_yes" ||
      a === "school_reg_confirm_no" ||
      a === "school_reg_address_skip" ||
      a === "school_reg_principal_skip" ||
      a === "school_reg_email_skip" ||
      a === "school_reg_cur_done" ||
      a === "school_reg_fac_done" ||
      a === "school_reg_ext_done" ||
      a === "school_reg_city_other" ||
      a.startsWith("school_reg_type_") ||
      a.startsWith("school_reg_city_") ||
      a.startsWith("school_reg_cur_") ||
      a.startsWith("school_reg_gender_") ||
      a.startsWith("school_reg_boarding_") ||
    a.startsWith("school_reg_fac_") ||
      a.startsWith("school_reg_ext_") ||
      a === "school_reg_city_more" ||
      a === "school_search_city_more" ||
      a.startsWith("school_plan_") ||
      a.startsWith("school_search_city_") ||
      a.startsWith("school_search_type_") ||
      a.startsWith("school_search_fees_") ||
      a.startsWith("school_search_fac_") ||
      a.startsWith("school_search_page_") ||
      a.startsWith("school_view_") ||
    a.startsWith("school_dl_profile_") ||
      a.startsWith("school_apply_") ||
      a.startsWith("school_enquiry_") ||
      a === "school_my_profile" ||
      a === "school_my_facilities" ||
      a === "school_my_fees" ||
      a === "school_my_reviews" ||
      a === "school_my_inquiries" ||
      a === "school_more_options" ||
 a === "school_update_reg_link" ||
      a === "school_update_email" ||
      a === "school_update_website" ||
      a === "school_upload_brochure" ||
      // ── school admin facility/extramural toggles ──
      a === "school_admin_manage_facilities" ||
      a === "school_admin_manage_extramural" ||
      a === "school_admin_edit_fees" ||
      a === "school_admin_edit_reg_link" ||
      a === "school_admin_edit_email" ||
      a === "school_admin_edit_website" ||
      a === "school_admin_upload_brochure" ||
      a.startsWith("school_fac_toggle_") ||
      a.startsWith("school_fac_page_") ||
      a.startsWith("school_ext_toggle_") ||
      a.startsWith("school_ext_page_") ||
      a === "school_get_zq_link" ||
      a === "school_share_link_wa" ||
      a === "school_smart_card_menu" ||
      a === "school_my_leads" ||
      a.startsWith("school_sc_src_") ||
      a.startsWith("school_followup_") ||
      a.startsWith("school_leads_page_") ||
      a.startsWith("sfaq_") ||
      a.startsWith("sc_")
    
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
  const isGhostSupplierBiz = !!(biz && biz.name?.startsWith("pending_supplier_"));

  // ── ZQ CHATBOT LINK INTERCEPT ─────────────────────────────────────────────
  // Must be placed HERE - after biz is declared, but before the supplier
  // search text handler (which was treating ZQ:SCHOOL:... as a product search).
  // ZQ:SCHOOL:<id> and ZQ:SUPPLIER:<id> arrive as plain text from wa.me links.
  if (/^ZQ:(SCHOOL|SUPPLIER):[a-f0-9]{24}/i.test(text)) {
    const _zqHandled = await handleZqDeepLink({
      from, text, biz,
      saveBiz: saveBizSafe.bind(null, biz)
    });
    if (_zqHandled) return;
  }

    // ── GLOBAL school shortcode trigger ──────────────────────────────────────
  // Must run before supplier shortcode search and before no-biz early returns,
  // but only after isMetaAction and biz are available.
  const SCHOOL_TRIGGER_PHRASES = [
  "find school", "find schools",
  "find primary", "find secondary", "find combined", "find preschool",
  "find ecd", "find kindergarten", "find boarding school", "find day school",
  "find girls school", "find boys school", "find mixed school",
  "find budget school", "find affordable school", "find cheap school",
  "find premium school",
  "find cambridge school", "find cambridge",
  "find zimsec school", "find zimsec",
  "find ib school", "find ib",
  "find a school", "look for school", "search school",
  "school in ", "schools in ", "primary school in ", "secondary school in "
];

  const isSchoolShortcodeQuery =
    typeof action === "string" &&
    SCHOOL_TRIGGER_PHRASES.some(phrase => al.startsWith(phrase) || al.includes(phrase));

  if (!isMetaAction && text.trim().length > 2 && isSchoolShortcodeQuery) {
    const handled = await runSchoolShortcodeSearch({
      from,
      text,
      biz,
      saveBiz: biz ? saveBizSafe : async () => {}
    });
    if (handled !== false) return handled;
  }

  // AUTO-RESET: If a real (non-ghost) supplier's biz is stuck in a registration
  // payment state but their subscription is already active, clear the stale state.
  // This happens when payment completes asynchronously and sessionState is never
  // cleared, leaving the seller's searches routed to the EcoCash handler.
  if (
    biz &&
    !isGhostSupplierBiz &&
    biz.isSupplier &&
    biz.subscriptionStatus === "active" &&
    (biz.sessionState === "supplier_reg_enter_ecocash" ||
     biz.sessionState === "supplier_reg_payment_pending")
  ) {
    biz.sessionState = "ready";
    await saveBizSafe(biz);
  }

  // =========================
  // 📨 BUYER REQUEST / SELLER RESPONSE TEXT STATES
  // =========================
const isBuyerRequestMetaReply =
  a === "view_and_quote" ||
  al === "view & quote" ||
  al === "view and quote" ||
  a === "not_available" ||
  al === "not available" ||
  al === "confirm" ||
  al === "send";

if (!isMetaAction || isBuyerRequestMetaReply) {
    const flowSess = await UserSession.findOne({ phone });
    const buyerRequestState = flowSess?.tempData?.buyerRequestState || null;
    const pendingBuyerRequest = flowSess?.tempData?.pendingBuyerRequest || null;

    // Handle plain text "accept ORD-XXXXXX" or "decline ORD-XXXXXX" replies
    // from suppliers who received the template outside the 24hr window
    const _orderReplyMatch = al.match(/^(accept|decline)\s+(ord-[a-f0-9]+)$/i);
    if (_orderReplyMatch) {
      const _action = _orderReplyMatch[1].toLowerCase();
      const _orderRefSuffix = _orderReplyMatch[2].replace("ord-", "").toLowerCase();
      const _matchedOrder = await SupplierOrder.findOne({
        supplierPhone: { $in: [from, phone] },
        status: "pending"
      }).sort({ createdAt: -1 }).lean();

      if (_matchedOrder && String(_matchedOrder._id).slice(-6).toLowerCase() === _orderRefSuffix) {
        if (_action === "accept") {
          return handleOrderAccepted(from, String(_matchedOrder._id), biz, saveBiz);
        } else {
          return handleOrderDeclined(from, String(_matchedOrder._id), biz, saveBiz);
        }
      }
      return sendText(from, `❌ Order not found. Please open the chatbot menu to view your orders.`);
    }

    
    const sellerRequestReplyState = flowSess?.tempData?.sellerRequestReplyState || null;
    const sellerRequestId = flowSess?.tempData?.sellerRequestId || null;
    let pendingDraftQuote = null;
    try {
      const _rawDraft = flowSess?.tempData?.pendingDraftQuote;
      pendingDraftQuote = _rawDraft
        ? (typeof _rawDraft === "string" ? JSON.parse(_rawDraft) : _rawDraft)
        : null;
    } catch (_) { pendingDraftQuote = null; }

    // ── awaiting_offer_intro: supplier's FIRST reply after template ──────────────
    // Fires regardless of what they typed ("hi", "hello", a price, anything).
    // Shows them the full item list + View & Quote button properly.
    // This is the reliable entry point for outside-24hr-session suppliers.
    if (sellerRequestReplyState === "awaiting_offer_intro" && sellerRequestId) {
      const _introRequest  = await BuyerRequest.findById(sellerRequestId);

      if (!_introRequest) {
        await UserSession.findOneAndUpdate(
          { phone },
          { $unset: { "tempData.sellerRequestReplyState": "", "tempData.sellerRequestId": "" } },
          { upsert: true }
        );
        return sendText(from,
          `⏰ *That request has closed.*\n\n` +
          `The buyer's request has expired or been filled.\n\n` +
          `New requests will be sent to you automatically when buyers need your products or services.`
        );
      }

      // ── Multi-format phone lookup ─────────────────────────────────────────────
      const _introPhone2   = phone.startsWith("263") ? "0" + phone.slice(3) : "263" + phone.slice(1);
      const _introSupplier = await SupplierProfile.findOne({
        phone: { $in: [phone, _introPhone2, "+" + phone] }
      }).lean();

      const _introRef       = buildBuyerRequestRef(_introRequest);
      const _introItems     = (_introRequest.items || []);
      const _introIsService = _introSupplier?.profileType === "service";

      // ── If supplier tapped "View & Quote" from the v2 template ───────────────
      // Go DIRECTLY to the pricing form - skip the intermediate buttons message.
      if (a === "view_and_quote" || al === "view & quote" || al === "view and quote") {
        // ── Build auto-priced draft from supplier's own prices + preset prices ──
        const _draft = buildDraftQuoteFromRequest(_introSupplier, _introRequest);

        // Build the full response object now so req_offer_confirm_ can send it directly
        const _draftResponse = {
          supplierId:        _introSupplier?._id || null,
          supplierPhone:     _introSupplier?.phone || from,
          supplierName:      _introSupplier?.businessName || "Supplier",
          mode:              "manual_offer",
          message:           _draft.missingItems?.length
            ? `Quoted available items. Not priced: ${_draft.missingItems.join(", ")}`
            : "",
          items:             _draft.responseItems || [],
          totalAmount:       _draft.totalAmount   || null,
          deliveryAvailable: _introSupplier?.delivery?.available ?? null,
          etaText:           ""
        };

        await UserSession.findOneAndUpdate(
          { phone },
          {
            $set: {
              "tempData.sellerRequestReplyState": "awaiting_offer",
              "tempData.sellerRequestId":         sellerRequestId,
              "tempData.pendingDraftQuote":        _draft,
              "tempData.pendingOfferResponse":     JSON.stringify(_draftResponse)
            }
          },
          { upsert: true }
        );

        const _directLocation = _introRequest.area
          ? `📍 ${_introRequest.area}, ${_introRequest.city || ""}`
          : _introRequest.city ? `📍 ${_introRequest.city}` : "";
        const _introIsServiceA = _introRequest.isServiceRequest || _buyerRequestIsService(_introRequest.items || []);
        const _directDelivery = _introIsServiceA
          ? (_introRequest.serviceAddress ? `📍 Service at: ${_introRequest.serviceAddress}` : "📍 Client will share address")
          : _introRequest.deliveryRequired ? "🚚 Delivery needed" : "🏠 Collection / flexible";

        // ── Case 1: All items auto-priced ────────────────────────────────────
        if (_draft.responseItems.length === _introItems.length && _introItems.length > 0 && !_draft.missingItems.length) {
          const _allLines = _draft.responseItems.map((item, i) =>
            `${i + 1}. *${item.product}* × ${item.quantity} - $${Number(item.pricePerUnit).toFixed(2)} = $${Number(item.total).toFixed(2)}`
          ).join("\n");

          // Always send two messages: list then buttons (no length limit issues)
          await sendText(from,
            `📋 *Quote Preview - ${_introRef}*\n` +
            `${_directLocation}  ${_directDelivery}\n` +
            `─────────────────\n` +
            `${_allLines}\n\n` +
            `💵 *Total: $${Number(_draft.totalAmount || 0).toFixed(2)}*\n\n` +
            `_Prices from your catalogue. All ${_draft.responseItems.length} items matched._`
          );
          return sendButtons(from, {
            text:
              `*What would you like to do?*\n\n` +
              `✏️ *Edit a price:* _edit 1x12.50_ or _edit 1x5 3x8_\n` +
              `❌ *Skip items you don't have:* _skip 3_ or _skip 3,7,15_\n` +
              `⚡ *Only have a few items:* _have 3,7_ (skips everything else)\n` +
              `🗑️ *Discard:* _cancel_`,
            buttons: [
              { id: `req_offer_confirm_${sellerRequestId}`, title: "Confirm & Send" },
              { id: `req_offer_${sellerRequestId}`,         title: "Edit Prices"    }
            ]
          });
        }

        // ── Case 2: Some items priced, some missing ───────────────────────────
        if (_draft.responseItems.length > 0) {
          const _pricedLines = _draft.responseItems.map((item, i) =>
            `${i + 1}. *${item.product}* × ${item.quantity} - $${Number(item.pricePerUnit).toFixed(2)} = $${Number(item.total).toFixed(2)} ✅`
          ).join("\n");
          const _missingLines = _draft.missingItems.map((m, i) => `${_draft.responseItems.length + i + 1}. ${m} - ❓ add price`).join("\n");

          await sendText(from,
            `📋 *Quote Preview - ${_introRef}*\n` +
            `${_directLocation}  ${_directDelivery}\n` +
            `─────────────────\n` +
            `*✅ Auto-priced (${_draft.responseItems.length} items):*\n${_pricedLines}\n\n` +
            `💵 *Priced total: $${Number(_draft.totalAmount || 0).toFixed(2)}*\n\n` +
            `*❓ Still needs your price (${_draft.missingItems.length} items):*\n${_missingLines}`
          );
          return sendButtons(from, {
            text:
              `*What would you like to do?*\n\n` +
              `• Type *send* to quote only the ✅ priced items\n` +
              `• Add missing prices: _edit 30x12.50 31x8_\n` +
              `• Skip items you don't have: _skip 30,31_\n` +
              `• Only have a few: _have 1,2,3_ (skips rest)\n` +
              `• Discard: _cancel_`,
            buttons: [
              { id: `req_offer_confirm_${sellerRequestId}`, title: "Send Priced Items" },
              { id: `req_offer_${sellerRequestId}`,         title: "Edit Prices"       }
            ]
          });
        }

        // ── Case 3: No prices found - show blank form with item list ──────────
        const _blankItemLines = _introItems.map((item, i) =>
          `${i + 1}. *${item.product}* × ${Number(item.quantity || 1)}`
        ).join("\n");
        const _blankEx     = _introItems.slice(0, 3).map((_, i) => `${i+1}x${(i*5+8).toFixed(2)}`).join("  ");
        const _blankSingle = _introItems.length === 1;

        return sendText(from,
          `📋 *${_introRef} - Enter your prices*\n` +
          `${_directLocation}  ${_directDelivery}\n` +
          `─────────────────\n` +
          `*Items requested:*\n${_blankItemLines}\n` +
          `─────────────────\n\n` +
          `💰 *How to send your price:*\n` +
          (_blankSingle
            ? `Type the price, e.g: *12.00*  or  *12.00/${_introIsService ? "job" : "each"}*`
            : `Type each price:\n*${_blankEx}*\n\n_(item number x price)_`) +
          (_blankSingle ? "" : `\nCan't supply an item? Type *0* for it.`) +
          `\n\nAdd a note: start with *msg* e.g: _12.00 msg available tomorrow_\n` +
          `Type *cancel* to go back.`
        );
      }

      // ── If supplier tapped "Not Available" from the v2 template ─────────────
      if (a === "not_available" || al === "not available") {
        await UserSession.findOneAndUpdate(
          { phone },
          { $unset: { "tempData.sellerRequestReplyState": "", "tempData.sellerRequestId": "" } },
          { upsert: true }
        );
        if (_introSupplier) {
          const _naResponse = {
            supplierId: _introSupplier._id, supplierPhone: _introSupplier.phone,
            supplierName: _introSupplier.businessName, mode: "unavailable",
            message: "", items: [], totalAmount: null,
            deliveryAvailable: _introSupplier.delivery?.available ?? null, etaText: ""
          };
          _introRequest.responses.push(_naResponse);
          await _introRequest.save();
          await sendBuyerRequestResponseToBuyer({ request: _introRequest, supplier: _introSupplier, response: _naResponse });
        }
        return sendButtons(from, {
          text: "✅ *Response sent.* The buyer has been notified you are not available.",
          buttons: [
            { id: "my_supplier_account", title: "🏪 My Store"   },
            { id: "suppliers_home",      title: "🛒 Marketplace" }
          ]
        });
      }

      // ── Any other message (e.g. "hi") → show item list + buttons ─────────────
      const _introItemLines = _introItems.map((item, i) =>
        `${i + 1}. *${item.product}* × ${Number(item.quantity || 1)}`
      ).join("\n");
      const _introLocation  = _introRequest.area
        ? `${_introRequest.area}, ${_introRequest.city || ""}`
        : (_introRequest.city || "Zimbabwe");
      const _introIsServiceB = _introRequest.isServiceRequest || _buyerRequestIsService(_introRequest.items || []);
      const _introDelivery = _introIsServiceB
        ? (_introRequest.serviceAddress ? `📍 Service at: ${_introRequest.serviceAddress}` : "📍 Client will share address")
        : _introRequest.deliveryRequired ? "🚚 Delivery needed" : "🏠 Collection / flexible";

      await UserSession.findOneAndUpdate(
        { phone },
        { $set: { "tempData.sellerRequestReplyState": "awaiting_offer" } },
        { upsert: true }
      );

      return sendButtons(from, {
        text:
          `🔔 *New ${_introIsService ? "Service" : "Product"} Request - ${_introRef}*\n\n` +
          `📍 *Location:* ${_introLocation}\n` +
          `${_introDelivery}\n\n` +
          `📦 *${_introItems.length} item${_introItems.length === 1 ? "" : "s"} needed:*\n` +
          `${_introItemLines}\n\n` +
          `─────────────────\n` +
          `Tap *View & Quote* to enter your price${_introItems.length === 1 ? "" : "s"}.\n` +
          `The buyer receives your quote instantly.`,
        buttons: [
          { id: `req_offer_${sellerRequestId}`,   title: "View & Quote"  },
          { id: `req_unavail_${sellerRequestId}`, title: "Not Available" }
        ]
      });
    }

    // ── pendingQuoteReply: seller received a browse-and-shop quote request ────────
    // They reply with a price/message and we forward it directly to the buyer.
    const _pendingQuote = flowSess?.tempData?.pendingQuoteReply;
    if (_pendingQuote === "true" && text && !a) {
      const _pqItem      = flowSess?.tempData?.pendingQuoteItem       || "your item";
      const _pqBuyer     = flowSess?.tempData?.pendingQuoteBuyerPhone || "";
      const _pqCity      = flowSess?.tempData?.pendingQuoteCity       || "";
      const _pqArea      = flowSess?.tempData?.pendingQuoteArea       || "";
      const _pqSupplier  = await findSupplierByPhone(phone);

      // Handle cancel
      if (text.trim().toLowerCase() === "cancel") {
        await UserSession.findOneAndUpdate(
          { phone },
          { $unset: {
            "tempData.pendingQuoteReply":      "",
            "tempData.pendingQuoteItem":       "",
            "tempData.pendingQuoteBuyerPhone": "",
            "tempData.pendingQuoteCity":       "",
            "tempData.pendingQuoteArea":       ""
          }},
          { upsert: true }
        );
        return sendText(from, "✅ Quote request ignored.");
      }

      // Clear session
      await UserSession.findOneAndUpdate(
        { phone },
        { $unset: {
          "tempData.pendingQuoteReply":      "",
          "tempData.pendingQuoteItem":       "",
          "tempData.pendingQuoteBuyerPhone": "",
          "tempData.pendingQuoteCity":       "",
          "tempData.pendingQuoteArea":       ""
        }},
        { upsert: true }
      );

      const _pqSupplierName = _pqSupplier?.businessName || "A seller";
      const _pqSupplierPhone = _pqSupplier?.phone || from;
      const _pqLocation = _pqArea ? `${_pqArea}, ${_pqCity}` : _pqCity;

      // Forward quote to buyer
      if (_pqBuyer) {
        const _pqNormBuyer = String(_pqBuyer).replace(/\D+/g, "");
        const _pqFullBuyer = _pqNormBuyer.startsWith("0") && _pqNormBuyer.length === 10
          ? "263" + _pqNormBuyer.slice(1) : _pqNormBuyer;
        try {
          await sendButtons(_pqFullBuyer, {
            text:
              `💬 *Quote received for: ${_pqItem}*\n\n` +
              `🏪 *${_pqSupplierName}*\n` +
              (_pqLocation ? `📍 ${_pqLocation}\n` : "") +
              `📞 ${_pqSupplierPhone}\n\n` +
              `💵 *Quote:* ${text.trim()}\n\n` +
              `Contact the seller directly to confirm your order.`,
            buttons: [
              { id: "find_supplier",       title: "🔍 Browse & Shop" },
              { id: "sup_request_sellers", title: "⚡ Request Sellers" }
            ]
          });
          console.log(`[PENDING QUOTE] Forwarded quote from ${from} to buyer ${_pqFullBuyer}`);
        } catch (fwdErr) {
          console.error(`[PENDING QUOTE] Failed to forward to buyer: ${fwdErr.message}`);
        }
      }

      // Confirm to seller
      return sendButtons(from, {
        text:
          `✅ *Quote sent to buyer!*\n\n` +
          `You quoted: _${text.trim()}_\n` +
          `For: *${_pqItem}*\n\n` +
          `The buyer will see your price and contact details. Good luck! 🎯`,
        buttons: [
          { id: "my_supplier_account", title: "🏪 My Store"   },
          { id: "suppliers_home",      title: "🛒 Marketplace" }
        ]
      });
    }

    // If supplier types while in confirm state, treat as wanting to edit → re-enter pricing
    if (sellerRequestReplyState === "awaiting_offer_confirm" && sellerRequestId && text && !a) {
      await UserSession.findOneAndUpdate(
        { phone },
        {
          $set: {
            "tempData.sellerRequestReplyState": "awaiting_offer",
            "tempData.sellerRequestId": sellerRequestId
          },
          $unset: { "tempData.pendingOfferResponse": "" }
        },
        { upsert: true }
      );
      // Re-show the item list so they can re-enter
      const _editRequest = await BuyerRequest.findById(sellerRequestId);
      if (_editRequest) {
        const _editItems = (_editRequest.items || []);
        const _editLines = _editItems.map((item, i) => `${i+1}. *${item.product}* × ${Number(item.quantity||1)}`).join("\n");
        const _editEx    = _editItems.slice(0,3).map((_,i) => `${i+1}x${(i*5+8).toFixed(2)}`).join("  ");
        return sendText(from,
          `✏️ *Edit your prices - ${buildBuyerRequestRef(_editRequest)}*\n\n` +
          `*Items:*\n${_editLines}\n\n` +
          `*Re-enter prices:*\n` +
          `*${_editEx || "12.50"}*  or  *1x12.50  2x8.00*\n\n` +
          `Type *cancel* to go back.`
        );
      }
    }

   if (sellerRequestReplyState === "awaiting_offer" && sellerRequestId) {

  // ── cancel ───────────────────────────────────────────────────────────────
  if (al === "cancel") {
    await UserSession.findOneAndUpdate(
      { phone },
      { $unset: { "tempData.sellerRequestReplyState": "", "tempData.sellerRequestId": "", "tempData.pendingDraftQuote": "", "tempData.pendingOfferResponse": "" } },
      { upsert: true }
    );
    return sendSupplierAccountMenu(from, await findSupplierByPhone(phone));
  }

  const request = await BuyerRequest.findById(sellerRequestId);
  if (!request) {
    await UserSession.findOneAndUpdate(
      { phone },
      { $unset: { "tempData.sellerRequestReplyState": "", "tempData.sellerRequestId": "", "tempData.pendingDraftQuote": "", "tempData.pendingOfferResponse": "" } },
      { upsert: true }
    );
    return sendText(from, "❌ Request not found or expired.");
  }

  const supplier = await findSupplierByPhone(phone);
  if (!supplier) {
    await UserSession.findOneAndUpdate(
      { phone },
      { $unset: { "tempData.sellerRequestReplyState": "", "tempData.sellerRequestId": "", "tempData.pendingDraftQuote": "", "tempData.pendingOfferResponse": "" } },
      { upsert: true }
    );
    return sendText(from, "❌ Supplier profile not found.");
  }

  // ── Helper: build a preview text of current draft items ───────────────────
  // Returns {text, short} - short=true means fits in sendButtons (≤900 chars)
  // ── _sendDraftPreview: ALWAYS sends two messages ──────────────────────────
  // 1. Full item list as sendText (no length limit)
  // 2. Action buttons as sendButtons (always shows tap buttons)
  async function _sendDraftPreview(items, skippedNames, ref, totalAmt, reqId) {
    const editedCount = items.filter(i => i._edited).length;
    const lines = items.map((item, i) =>
      `${i + 1}. *${item.product}* × ${item.quantity} - $${Number(item.pricePerUnit).toFixed(2)} = $${Number(item.total).toFixed(2)}${item._edited ? " ✏️" : ""}`
    ).join("\n");
    const skippedLine = skippedNames?.length
      ? `\n\n❌ *Skipped - not in stock (${skippedNames.length}):*\n${skippedNames.map(s => `• ${s}`).join("\n")}`
      : "";
    const editNote = editedCount > 0 ? `\n_✏️ = price you edited_` : "";

    // Message 1: the full item list
    await sendText(from,
      `📋 *Quote Preview - ${ref}*\n` +
      `─────────────────\n` +
      `${lines}\n\n` +
      `💵 *Total: $${Number(totalAmt).toFixed(2)}*${skippedLine}${editNote}`
    );

    // Message 2: action buttons + short command guide
    return sendButtons(from, {
      text:
        `*What would you like to do?*\n\n` +
        `✏️ *Edit a price:* _edit 1x12.50_ or _edit 1x5 3x8_\n` +
        `❌ *Skip items:* _skip 3_ or _skip 3,7,15_\n` +
        `⚡ *Only have some items:* _have 3,7,15_ (skips all others)\n` +
        `🗑️ *Discard:* _cancel_`,
      buttons: [
        { id: `req_offer_confirm_${reqId}`, title: "Confirm & Send" },
        { id: `req_offer_${reqId}`,         title: "Edit Prices"    }
      ]
    });
  }

  // ── Parse skip / edit commands ────────────────────────────────────────────
  // Supports: "skip 3,7,15"  "edit 1x5, 3x15"  "skip 3 edit 1x5"
  function _parseEditSkip(inputText, draftItems) {
    const raw = String(inputText || "").trim();
    let editUpdates = {};   // { itemIndex(1-based): newPrice }
    let skipIndices = new Set();
    let hasEditCmd = false;
    let hasSkipCmd = false;

    // ── "have 3,7,15" - I ONLY have these items, skip all others ────────────
    let haveMode = false;
    const haveMatch = raw.match(/\bhave\s+([\d,\s]+)/i);
    if (haveMatch) {
      hasSkipCmd = true;
      haveMode = true;
      const haveSet = new Set();
      haveMatch[1].split(/[,\s]+/).forEach(n => {
        const idx = parseInt(n);
        if (!isNaN(idx)) haveSet.add(idx);
      });
      // Skip everything NOT in the have list
      for (let i = 1; i <= draftItems.length; i++) {
        if (!haveSet.has(i)) skipIndices.add(i);
      }
    }

    // ── "skip 3,7,15" - skip specific items ──────────────────────────────────
    if (!haveMode) {
      const skipMatch = raw.match(/\bskip\s+([\d,\s]+)/i);
      if (skipMatch) {
        hasSkipCmd = true;
        skipMatch[1].split(/[,\s]+/).forEach(n => {
          const idx = parseInt(n);
          if (!isNaN(idx) && idx >= 1 && idx <= draftItems.length) skipIndices.add(idx);
        });
      }
    }

    // ── "edit 1x5 3x15" or "1x5, 3x15" - edit specific prices ───────────────
    const editSection = raw
      .replace(/\bhave\s+[\d,\s]+/i, "")
      .replace(/\bskip\s+[\d,\s]+/i, "")
      .replace(/^\bedit\b\s*/i, "").trim();
    const pairPattern = /(\d+)\s*x\s*(\d+(?:\.\d+)?)/gi;
    let m;
    while ((m = pairPattern.exec(editSection)) !== null) {
      hasEditCmd = true;
      editUpdates[parseInt(m[1])] = parseFloat(m[2]);
    }

    return { editUpdates, skipIndices, hasEditCmd, hasSkipCmd, haveMode };
  }

  const _isService = supplier.profileType === "service";
  const _ref = buildBuyerRequestRef(request);

  // ── CONFIRM: send the current stored draft ────────────────────────────────
  if (al === "confirm" || al === "send") {
    const _confirmDraft = pendingDraftQuote;
    if (!_confirmDraft?.responseItems?.length) {
      return sendText(from,
        `⚠️ No draft found. Please tap *View & Quote* again from the request message.`
      );
    }

    const responseItems = _confirmDraft.responseItems.map(item => ({
      product:      item.product,
      quantity:     Number(item.quantity || 1),
      unit:         item.unit || "each",
      pricePerUnit: Number(item.pricePerUnit || 0),
      total:        Number(item.total || 0),
      available:    true
    }));

    const totalAmount = Number(responseItems.reduce((sum, i) => sum + Number(i.total || 0), 0).toFixed(2));
    const skippedNote = (_confirmDraft.skippedItems?.length)
      ? `Not in stock: ${_confirmDraft.skippedItems.join(", ")}`
      : (_confirmDraft.missingItems?.length ? `Not priced: ${_confirmDraft.missingItems.join(", ")}` : "");

    const response = {
      supplierId:        supplier._id,
      supplierPhone:     supplier.phone,
      supplierName:      supplier.businessName,
      mode:              "manual_offer",
      message:           skippedNote,
      items:             responseItems,
      totalAmount,
      deliveryAvailable: supplier.delivery?.available ?? null,
      etaText:           ""
    };

    request.responses.push(response);
    await request.save();

    await UserSession.findOneAndUpdate(
      { phone },
      { $unset: { "tempData.sellerRequestReplyState": "", "tempData.sellerRequestId": "", "tempData.pendingDraftQuote": "", "tempData.pendingOfferResponse": "" } },
      { upsert: true }
    );

    trackSupplierResponseSpeed(supplier.phone, request.createdAt).catch(console.error);
    await sendBuyerRequestResponseToBuyer({ request, supplier, response });

    return sendButtons(from, {
      text:
        `✅ *Quote sent!*\n\n` +
        `🏪 ${supplier.businessName}\n` +
        `📦 ${responseItems.length} item${responseItems.length === 1 ? "" : "s"} quoted\n` +
        `💵 Total: $${totalAmount.toFixed(2)}\n\n` +
        `The buyer will see your prices and can contact you directly.`,
      buttons: [
        { id: "my_supplier_account", title: "🏪 My Store" },
        { id: "suppliers_home",      title: "🛒 Marketplace" }
      ]
    });
  }

  // ── EDIT / SKIP commands - update draft and show preview ──────────────────
  const { editUpdates, skipIndices, hasEditCmd, hasSkipCmd } = _parseEditSkip(text, pendingDraftQuote?.responseItems || []);

  if ((hasEditCmd || hasSkipCmd) && pendingDraftQuote?.responseItems?.length) {
    // Apply edits to the draft
    const updatedItems = (pendingDraftQuote.responseItems || [])
      .filter((_, idx) => !skipIndices.has(idx + 1))  // remove skipped items
      .map((item, _newIdx) => {
        // find original 1-based index before filtering for skip
        const origIdx = (pendingDraftQuote.responseItems || []).indexOf(item) + 1;
        if (editUpdates[origIdx] !== undefined) {
          const newPrice = Number(editUpdates[origIdx]);
          const qty = Number(item.quantity || 1);
          return {
            ...item,
            pricePerUnit: newPrice,
            total:        Number((qty * newPrice).toFixed(2)),
            _edited:      true
          };
        }
        return item;
      });

    const skippedNames = (pendingDraftQuote.responseItems || [])
      .filter((_, idx) => skipIndices.has(idx + 1))
      .map(i => i.product);

    const newTotal = Number(updatedItems.reduce((sum, i) => sum + Number(i.total || 0), 0).toFixed(2));

    // Persist the updated draft
    const updatedDraft = {
      ...pendingDraftQuote,
      responseItems: updatedItems,
      skippedItems:  [...(pendingDraftQuote.skippedItems || []), ...skippedNames],
      totalAmount:   newTotal
    };

    // Also update pendingOfferResponse so "Confirm & Send" button works
    const _editedResponse = {
      supplierId: supplier._id, supplierPhone: supplier.phone, supplierName: supplier.businessName,
      mode: "manual_offer",
      message: updatedDraft.skippedItems?.length ? `Not in stock: ${updatedDraft.skippedItems.join(", ")}` : "",
      items: updatedItems.map(item => ({
        product: item.product, quantity: Number(item.quantity || 1), unit: item.unit || "each",
        pricePerUnit: Number(item.pricePerUnit || 0), total: Number(item.total || 0), available: true
      })),
      totalAmount: newTotal, deliveryAvailable: supplier.delivery?.available ?? null, etaText: ""
    };
    await UserSession.findOneAndUpdate(
      { phone },
      { $set: { "tempData.pendingDraftQuote": updatedDraft, "tempData.pendingOfferResponse": JSON.stringify(_editedResponse) } },
      { upsert: true }
    );

    return _sendDraftPreview(updatedItems, updatedDraft.skippedItems, _ref, newTotal, sellerRequestId);
  }

  // ── GREETING / confusion while in awaiting_offer - re-show the draft ─────
  const _looksLikeGreeting = !hasEditCmd && !hasSkipCmd &&
    !/\d/.test(text) && text.trim().length < 30 &&
    /^(hi|hello|hey|yes|ok|okay|sure|what|how|hie|help|good|fine|yeah|send|go|start|ready|quote|pricing|price|available|avail|\?+|\!+)$/i
      .test(text.trim().replace(/[.,!?]+$/, "").trim());

  if (_looksLikeGreeting && pendingDraftQuote?.responseItems?.length) {
    return _sendDraftPreview(pendingDraftQuote.responseItems, pendingDraftQuote.skippedItems || [], _ref, pendingDraftQuote.totalAmount || 0, sellerRequestId);
  }

  // ── TYPED PRICES (no draft, or seller typed raw prices directly) ──────────
  {
    const requestedProducts = (request.items || []).map(i => i.product);
    const parsed = parseSupplierPriceInput(text, requestedProducts, _isService);

    let responseItems = [];
    let totalAmount = null;
    let message = "";

    if (parsed.updated.length) {
      // If we have a draft, MERGE typed prices into it (don't discard auto-priced items)
      if (pendingDraftQuote?.responseItems?.length) {
        const updatedMap = new Map(parsed.updated.map(u => [normalizeProductName(u.product), u]));
        const mergedItems = (pendingDraftQuote.responseItems || []).map(item => {
          const match = updatedMap.get(normalizeProductName(item.product));
          if (match) {
            const qty = Number(item.quantity || 1);
            const unitPrice = Number(match.amount || 0);
            return { ...item, pricePerUnit: unitPrice, total: Number((qty * unitPrice).toFixed(2)), _edited: true };
          }
          return item;
        });

        const newTotal = Number(mergedItems.reduce((sum, i) => sum + Number(i.total || 0), 0).toFixed(2));
        const updatedDraft = { ...pendingDraftQuote, responseItems: mergedItems, totalAmount: newTotal };

        await UserSession.findOneAndUpdate(
          { phone },
          { $set: { "tempData.pendingDraftQuote": updatedDraft } },
          { upsert: true }
        );

        return _sendDraftPreview(mergedItems, updatedDraft.skippedItems || [], _ref, newTotal, sellerRequestId);
      }

      // No draft - build response from parsed prices only
      const updatedMap = new Map(parsed.updated.map(u => [normalizeProductName(u.product), u]));
      responseItems = (request.items || []).map(item => {
        const match = updatedMap.get(normalizeProductName(item.product));
        if (!match) return null;
        const qty = Number(item.quantity || 1);
        const unitPrice = Number(match.amount || 0);
        return { product: item.product, quantity: qty, unit: match.unit || item.unitLabel || "each", pricePerUnit: unitPrice, total: Number((qty * unitPrice).toFixed(2)), available: true };
      }).filter(Boolean);

      if (responseItems.length) {
        totalAmount = Number(responseItems.reduce((sum, i) => sum + Number(i.total || 0), 0).toFixed(2));
      }
      if (parsed.failed.length) message = `Some parts skipped: ${parsed.failed.slice(0, 3).join(", ")}`;

      // Show preview and ask for confirm
      const _newDraft = { responseItems, missingItems: [], totalAmount };
      await UserSession.findOneAndUpdate(
        { phone },
        { $set: { "tempData.pendingDraftQuote": _newDraft } },
        { upsert: true }
      );
      return _sendDraftPreview(responseItems, [], _ref, totalAmount, sellerRequestId);

    } else {
      // No prices parsed - message-only or greeting
      message = String(text || "").trim();
      if (!message || _looksLikeGreeting) {
        return sendText(from,
          `⚠️ I couldn't read prices from that.\n\n` +
          `• Type *confirm* to send the draft as-is\n` +
          `• *edit 1x12.50* - change a price\n` +
          `• *skip 3,7* - remove items you don't have\n` +
          `• *cancel* to go back`
        );
      }

      // Treat as a message-only quote (send immediately with note)
      const _msgResp = {
        supplierId: supplier._id, supplierPhone: supplier.phone, supplierName: supplier.businessName,
        mode: "manual_offer", message, items: [], totalAmount: null,
        deliveryAvailable: supplier.delivery?.available ?? null, etaText: ""
      };
      request.responses.push(_msgResp);
      await request.save();
      await UserSession.findOneAndUpdate(
        { phone },
        { $unset: { "tempData.sellerRequestReplyState": "", "tempData.sellerRequestId": "", "tempData.pendingDraftQuote": "", "tempData.pendingOfferResponse": "" } },
        { upsert: true }
      );
      await sendBuyerRequestResponseToBuyer({ request, supplier, response: _msgResp });
      return sendButtons(from, {
        text: `✅ *Message sent to buyer.*\n\n_"${message.slice(0, 80)}"_`,
        buttons: [{ id: "my_supplier_account", title: "🏪 My Store" }, { id: "suppliers_home", title: "🛒 Marketplace" }]
      });
    }
  }
}



 if (buyerRequestState === "awaiting_items") {
  if (al === "cancel") {
    await UserSession.findOneAndUpdate(
      { phone },
      {
        $unset: {
          "tempData.buyerRequestState": "",
          "tempData.pendingBuyerRequest": "",
          "tempData.buyerRequestMode": ""
        }
      },
      { upsert: true }
    );
    return sendButtons(from, {
      text: "✅ Request cancelled.",
      buttons: [{ id: "find_supplier", title: "🔍 Browse & Shop" }]
    });
  }

  const requestMode = flowSess?.tempData?.buyerRequestMode || pendingBuyerRequest?.requestType || "simple";

  // SIMPLE MODE = one-line item + suburb/city
   // SIMPLE MODE = one-line item + suburb/city
  if (requestMode === "simple") {
    const parsedInline = parseInlineSimpleBuyerRequest(text);

    if (!parsedInline.items.length) {
      return sendText(
        from,
        `❌ Please use the format: *find [item] [city]*\n\n` +
        `*Examples:*\n` +
        `_find ball valve 20mm harare_\n` +
        `_find cement harare_\n` +
        `_find school uniform size 8 chitungwiza_\n` +
        `_find plumber mbare harare_\n\n` +
        `*Need more than 1?* Add the quantity at the end with x:\n` +
        `_find cement harare x10_\n` +
        `_find pipes 20mm harare x5_\n\n` +
        `_Size/spec like 20mm stays part of the product name._\n` +
        `Type *cancel* to stop.`
      );
    }

    const vagueItems = getVagueBuyerRequestItems(parsedInline.items || []);
    if (vagueItems.length) {
      return sendText(from, buildBuyerSpecificityPrompt(vagueItems));
    }

    if (!parsedInline.city) {
      return sendText(
        from,
        `❌ Please include the *city* in the same request line.\n\n` +
        `*Format:* find [item] [city]\n\n` +
        `*Examples:*\n` +
        `_find ball valve brass 20mm harare_\n` +
        `_find cement harare_\n` +
        `_find school uniform size 8 chitungwiza_\n` +
        `_find plumber avondale harare_\n\n` +
        `*Need more than 1?* Add x2, x3 etc at the end:\n` +
        `_find cement harare x10_\n` +
        `_find ball valve 20mm harare x5_`
      );
    }

    await UserSession.findOneAndUpdate(
      { phone },
      {
        $set: {
          "tempData.buyerRequestState": "awaiting_delivery",
          "tempData.pendingBuyerRequest": {
            ...(pendingBuyerRequest || {}),
            requestType: "simple",
            items: parsedInline.items,
            rawText: text,
            profileType: "product",  // DB enum value - findSuppliersForBuyerRequest searches both
            city: parsedInline.city,
            area: parsedInline.area
          }
        }
      },
      { upsert: true }
    );

    // ── Show clear confirmation with qty so buyer can spot any misread ───────────
    const _confirmItemLines = (parsedInline.items || []).map((item, i) => {
      const qty  = Number(item.quantity || 1);
      const unit = item.unitLabel && item.unitLabel !== "units" ? ` ${item.unitLabel}` : "";
      const qtyStr = qty === 1 ? "_(qty: 1 - add x2 or x3 if you need more)_" : `qty: ${qty}${unit}`;
      return `${i + 1}. *${item.product}*\n   ${qtyStr}`;
    }).join("\n");

    const _simpleIsService = _buyerRequestIsService(parsedInline.items);

    if (_simpleIsService) {
      await UserSession.findOneAndUpdate(
        { phone },
        {
          $set: {
            "tempData.buyerRequestState": "awaiting_service_address",
            "tempData.pendingBuyerRequest": {
              ...(pendingBuyerRequest || {}),
              requestType: "simple",
              items: parsedInline.items,
              rawText: text,
              profileType: "product",
              city: parsedInline.city,
              area: parsedInline.area,
              isServiceRequest: true
            }
          }
        },
        { upsert: true }
      );
      return sendText(
        from,
        `✅ *Request captured:*\n\n` +
        `${_confirmItemLines}\n\n` +
        `${parsedInline.area ? `📍 ${parsedInline.area}, ${parsedInline.city}` : `📍 ${parsedInline.city}`}\n\n` +
        `📍 *Where should the service provider come?*\n\n` +
        `Type your address or location:\n` +
        `_Examples:_\n` +
        `_24 Mabelreign Drive, Harare_\n` +
        `_House 7, Borrowdale, Harare_\n\n` +
        `Type *skip* to share your address directly with the provider.\n` +
        `Type *cancel* to stop.`
      );
    }

    return sendButtons(from, {
      text:
        `✅ *Request captured - please check:*\n\n` +
        `${_confirmItemLines}\n\n` +
        `${parsedInline.area ? `📍 ${parsedInline.area}, ${parsedInline.city}` : `📍 ${parsedInline.city}`}\n\n` +
        `_To change quantity, type your request again with e.g. x3 at the end:_\n` +
        `_find ball valve brass 20mm harare x3_\n\n` +
        `🚚 Do you need delivery?`,
      buttons: [
        { id: "sup_request_delivery_yes", title: "✅ Yes, delivery" },
        { id: "sup_request_delivery_no",  title: "🏠 No, collection" }
      ]
    });
  }

  // BULK MODE = item list first, location second
   // BULK MODE = item list first, location second
  const items = parseBuyerRequestItems(text);
  if (!items.length) {
    return sendText(
      from,
      `❌ Please send the items you need.\n\nExamples:\n_ball valve brass 20mm 5_\n_hp laptop core i7 3_\n_school uniform size 8 10_\n_geyser installation 2_\n\nFor long lists, send one item per line.\n\nType *cancel* to stop.`
    );
  }

  const vagueItems = getVagueBuyerRequestItems(items || []);
  if (vagueItems.length) {
    return sendText(
      from,
      buildBuyerSpecificityPrompt(vagueItems) +
        `\n\nFor bulk requests, fix the vague lines first, then send the full list again.`
    );
  }

  await UserSession.findOneAndUpdate(
    { phone },
    {
      $set: {
        "tempData.buyerRequestState": "awaiting_location",
        "tempData.pendingBuyerRequest": {
          ...(pendingBuyerRequest || {}),
          requestType: "bulk",
          items,
          rawText: text,
          profileType: "product",  // DB enum value - findSuppliersForBuyerRequest searches both
        }
      }
    },
    { upsert: true }
  );

  return sendText(
    from,
    `📍 *Where do you need these items?*\n\nReply with city or suburb + city.\n\nExamples:\n_Harare_\n_Mbare, Harare_\n_Borrowdale, Harare_`
  );
}

    if (buyerRequestState === "awaiting_location") {
      if (al === "cancel") {
        await UserSession.findOneAndUpdate(
          { phone },
          {
            $unset: {
              "tempData.buyerRequestState": "",
              "tempData.pendingBuyerRequest": "",
              "tempData.buyerRequestMode": ""
            }
          },
          { upsert: true }
        );
        return sendButtons(from, {
          text: "✅ Request cancelled.",
          buttons: [{ id: "find_supplier", title: "🔍 Browse & Shop" }]
        });
      }

      const parsedLocation = parseBuyerRequestLocationInput(text);
      if (!parsedLocation.city) {
        return sendText(
          from,
          `❌ Please include at least the *city*.\n\nExamples:\n_Harare_\n_Mbare, Harare_\n_Avondale, Harare_`
        );
      }

      await UserSession.findOneAndUpdate(
        { phone },
        {
          $set: {
            "tempData.buyerRequestState": "awaiting_delivery",
            "tempData.pendingBuyerRequest": {
              ...(pendingBuyerRequest || {}),
              city: parsedLocation.city,
              area: parsedLocation.area
            }
          }
        },
        { upsert: true }
      );

      const _bulkIsService = _buyerRequestIsService(pendingBuyerRequest?.items || []);
      if (_bulkIsService) {
        await UserSession.findOneAndUpdate(
          { phone },
          {
            $set: {
              "tempData.buyerRequestState": "awaiting_service_address",
              "tempData.pendingBuyerRequest": {
                ...(pendingBuyerRequest || {}),
                city: parsedLocation.city,
                area: parsedLocation.area,
                isServiceRequest: true
              }
            }
          },
          { upsert: true }
        );
        return sendText(
          from,
          `📍 *Where should the service provider come?*\n\n` +
          `${parsedLocation.area ? `📍 ${parsedLocation.area}, ${parsedLocation.city}` : `📍 ${parsedLocation.city}`}\n\n` +
          `Type your full address:\n` +
          `_24 Mabelreign Drive, Harare_\n` +
          `_House 7, Borrowdale, Harare_\n\n` +
          `Type *skip* to share your address directly with the provider.\n` +
          `Type *cancel* to stop.`
        );
      }

      return sendButtons(from, {
        text:
          `🚚 *Do you need delivery?*\n\n` +
          `${parsedLocation.area ? `📍 ${parsedLocation.area}, ${parsedLocation.city}` : `📍 ${parsedLocation.city}`}`,
        buttons: [
          { id: "sup_request_delivery_yes", title: "✅ Yes, delivery" },
          { id: "sup_request_delivery_no", title: "🏠 No, collection" }
        ]
      });
    }
  }



    if (buyerRequestState === "awaiting_service_address") {
      const _isExitSA = al === "cancel" || al === "0" || al === "menu" || al === "main menu" || al === "main_menu";
      if (_isExitSA) {
        await UserSession.findOneAndUpdate(
          { phone },
          { $unset: { "tempData.buyerRequestState": "", "tempData.pendingBuyerRequest": "", "tempData.buyerRequestMode": "" } },
          { upsert: true }
        );
        return sendSuppliersMenu(from);
      }
      if (al === "back") {
        await UserSession.findOneAndUpdate(
          { phone },
          { $set: { "tempData.buyerRequestState": "awaiting_items" } },
          { upsert: true }
        );
        return sendText(from, `↩️ Back to your request.\n\nType your item + city again.\n\nType *cancel* to stop.`);
      }
      const _saAddress = al === "skip" ? null : text.trim();
      if (_saAddress && _saAddress.length < 3) {
        return sendText(from, `❌ Please enter a valid address or type *skip*.\n\nType *cancel* to stop.`);
      }
      await UserSession.findOneAndUpdate(
        { phone },
        { $unset: { "tempData.buyerRequestState": "", "tempData.pendingBuyerRequest": "", "tempData.buyerRequestMode": "" } },
        { upsert: true }
      );
      return finalizeBuyerRequestSubmission({
        from, phone,
        pendingRequest: { ...(pendingBuyerRequest || {}), serviceAddress: _saAddress || null, isServiceRequest: true },
        deliveryRequired: false,
        serviceAddress: _saAddress || null
      });
    }

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

const GREETING_WORDS = new Set([
  "hi", "hello", "hey", "hie", "howzit", "helo", "sup", "yo",
  "yes", "no", "ok", "okay", "k", "sure", "thanks", "thank you",
  "help", "start", "menu", "home", "back", "cancel"
]);

// ── Global greeting/menu guard ─────────────────────────────────────────────
if (
  GREETING_WORDS.has(al) &&
  !isMetaAction &&
  (!biz || biz.sessionState === "ready" || biz.sessionState === "supplier_search_city")
) {
  if (biz && biz.sessionState !== "ready") {
    biz.sessionState = "ready";
    biz.sessionData = {};
    await saveBizSafe(biz);
  }

  if (al === "help") {
    await sendText(from, "👋 Welcome to ZimQuote. Choose an option below:");
  }

  return sendMainMenu(from);
}

// ── All users: handle typed school enquiry message (biz and non-biz) ───────────
if (!isMetaAction) {
  const _enquirySess = await UserSession.findOne({ phone });
  if (_enquirySess?.tempData?.schoolEnquiryState === "school_parent_enquiry") {
    const message  = (text || "").trim();
    const schoolId = _enquirySess.tempData.enquirySchoolId;

    if (message.toLowerCase() === "cancel") {
      await UserSession.findOneAndUpdate(
        { phone },
        { $unset: { "tempData.schoolEnquiryState": "", "tempData.enquirySchoolId": "" } },
        { upsert: true }
      );
      return sendButtons(from, {
        text: "❌ Enquiry cancelled.",
        buttons: [{ id: "school_search_refine", title: "🔄 Back to Schools" }]
      });
    }

    if (!message || message.length < 3) {
      await sendText(from, "❌ Please type your question or message (at least 3 characters).");
      return;
    }

    if (!schoolId) {
      await UserSession.findOneAndUpdate(
        { phone },
        { $unset: { "tempData.schoolEnquiryState": "", "tempData.enquirySchoolId": "" } },
        { upsert: true }
      );
      return sendButtons(from, {
        text: "❌ Session expired. Please search for the school again.",
        buttons: [{ id: "find_school", title: "🏫 Find a School" }]
      });
    }

    const { default: SchoolProfile } = await import("../models/schoolProfile.js");
    const school = await SchoolProfile.findById(schoolId).lean();

    if (!school) {
      await UserSession.findOneAndUpdate(
        { phone },
        { $unset: { "tempData.schoolEnquiryState": "", "tempData.enquirySchoolId": "" } },
        { upsert: true }
      );
      return sendButtons(from, {
        text: "❌ School not found. Please search again.",
        buttons: [{ id: "find_school", title: "🏫 Find a School" }]
      });
    }

    // Increment enquiry counter
    await SchoolProfile.findByIdAndUpdate(schoolId, { $inc: { inquiries: 1 } });

    // Send notification to school with parent's message
    const { notifySchoolEnquiry } = await import("./schoolNotifications.js");
    notifySchoolEnquiry(school.phone, school.schoolName, from, message).catch(() => {});

    // Clear the enquiry session state (UserSession for all users)
    await UserSession.findOneAndUpdate(
      { phone },
      { $unset: { "tempData.schoolEnquiryState": "", "tempData.enquirySchoolId": "" } },
      { upsert: true }
    );

    // Also reset biz.sessionState if user has a biz account (e.g. a supplier browsing schools)
    if (biz && biz.sessionState === "school_parent_enquiry") {
      biz.sessionState = "ready";
      biz.sessionData  = { ...(biz.sessionData || {}), enquirySchoolId: null };
      await saveBizSafe(biz);
    }

    // Confirm to parent
    return sendButtons(from, {
      text:
`✅ *Enquiry Sent to ${school.schoolName}!*

Your message:
_${message}_

The school has been notified and will contact you on this WhatsApp number.

📞 ${school.contactPhone || school.phone}`,
      buttons: [
        { id: `school_apply_${schoolId}`, title: "📝 Apply Online" },
        { id: "school_search_refine",      title: "🔄 More Schools" }
      ]
    });
  }
}

if (!biz) {
  const supplierExists = await SupplierProfile.findOne({ phone });
  const sess = await UserSession.findOne({ phone });

const searchMode = sess?.tempData?.supplierSearchMode;
const supplierAccountState = sess?.tempData?.supplierAccountState;
const supplierRegState = sess?.supplierRegState;

if (
  searchMode === "product" &&
  !GREETING_WORDS.has(text.trim().toLowerCase()) &&
  supplierAccountState !== "supplier_update_prices" &&
  supplierRegState !== "supplier_reg_prices"
) {
  const productQuery = text.trim();
  if (!productQuery || productQuery.length < 1) {
    return sendButtons(from, {
      text: "❌ Please type what you're looking for:\n\n_e.g. find cement, find plumber harare_",
      buttons: [{ id: "find_supplier", title: "⬅ Back" }]
    });
  }
function _inlineParseLocation(txt) {
    const _S = {"avondale":"Harare","borrowdale":"Harare","cbd":"Harare","mbare":"Harare","highfield":"Harare","hatfield":"Harare","greendale":"Harare","msasa":"Harare","eastlea":"Harare","waterfalls":"Harare","mufakose":"Harare","chitungwiza":"Harare","ruwa":"Harare","epworth":"Harare","tafara":"Harare","mabvuku":"Harare","highlands":"Harare","greencroft":"Harare","mount pleasant":"Harare","belgravia":"Harare","milton park":"Harare","newlands":"Harare","chisipite":"Harare","gunhill":"Harare","strathaven":"Harare","braeside":"Harare","arcadia":"Harare","southerton":"Harare","workington":"Harare","willowvale":"Harare","graniteside":"Harare","seke":"Harare","norton":"Harare","kambuzuma":"Harare","warren park":"Harare","glen view":"Harare","glenview":"Harare","budiriro":"Harare","kuwadzana":"Harare","dzivarasekwa":"Harare","mabelreign":"Harare","malborough":"Harare","marlborough":"Harare","malbro":"Harare","glen norah":"Harare","glennorah":"Harare","nkulumane":"Bulawayo","luveve":"Bulawayo","entumbane":"Bulawayo","njube":"Bulawayo","mpopoma":"Bulawayo","lobengula":"Bulawayo","makokoba":"Bulawayo","tshabalala":"Bulawayo","pumula":"Bulawayo","cowdray park":"Bulawayo","mahatshula":"Bulawayo","magwegwe":"Bulawayo","hillside":"Bulawayo","white city":"Bulawayo","sakubva":"Mutare","dangamvura":"Mutare","chikanga":"Mutare","mambo":"Gweru","mkoba":"Gweru","senga":"Gweru","ascot":"Gweru","mucheke":"Masvingo","rujeko":"Masvingo","mbizo":"Kwekwe","amaveni":"Kwekwe","macheke":"Murehwa"};
    const _C = ["harare","bulawayo","mutare","gweru","masvingo","kwekwe","kadoma","chinhoyi","victoria falls","bindura","murehwa"];
    const _tc = v => String(v||"").split(" ").filter(Boolean).map(p=>p[0].toUpperCase()+p.slice(1)).join(" ");
    const raw = txt.toLowerCase().trim().replace(/^find\s+/i,"").replace(/^search\s+/i,"").replace(/\s+/g," ");
    const words = raw.split(" ").filter(Boolean);
    let city=null,area=null,ci=-1,cl=0,ai=-1,al=0;
    outer1: for(let len=Math.min(2,words.length);len>=1;len--){for(let i=0;i<=words.length-len;i++){const c=words.slice(i,i+len).join(" ");if(_C.includes(c)){city=_tc(c);ci=i;cl=len;break outer1;}}}
    outer2: for(let len=Math.min(3,words.length);len>=1;len--){for(let i=0;i<=words.length-len;i++){if(i===ci&&len===cl)continue;const c=words.slice(i,i+len).join(" ");if(_S[c]){area=_tc(c);ai=i;al=len;if(!city)city=_S[c];break outer2;}}}
    const rem=[];if(ci>=0)rem.push([ci,ci+cl]);if(ai>=0)rem.push([ai,ai+al]);rem.sort((a,b)=>a[0]-b[0]);
    const prod=words.filter((_,i)=>!rem.some(([s,e])=>i>=s&&i<e)).join(" ").trim();
    return{product:prod||raw,city,area};
  }

  const _loc = _inlineParseLocation(productQuery);
  const parsed = (_loc.city || _loc.area) ? _loc : (parseShortcodeSearch(productQuery) || parseShortcodeSearch(`find ${productQuery}`) || { product: productQuery, city: null, area: null });

  const cleanProduct = String(parsed.product || "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ");

  await UserSession.findOneAndUpdate(
    { phone },
    {
      $set: {
        "tempData.supplierSearchProduct": cleanProduct,
        ...(parsed.city ? { "tempData.lastSearchCity": parsed.city } : {}),
        ...(parsed.area ? { "tempData.lastSearchArea": parsed.area } : {})
      },
      $unset: { "tempData.supplierSearchMode": "" }
    }
  );

if (parsed.city || parsed.area) {
   const locationLabel = parsed.area
    ? `${parsed.area}, ${parsed.city}`
    : parsed.city;

  // First check supplier/business-name matches in the same city/area context.
  // This prevents business-name searches like "prime dental avondale"
  // from being turned into offer-level service results.
  const supplierResults = await runSupplierSearch({
    city: parsed.city || null,
    product: cleanProduct,
    area: parsed.area || null,
    profileType: sess?.tempData?.supplierSearchType || null
  });

  const normalizedQuery = normalizeProductName(cleanProduct);
  const directBusinessMatches = supplierResults.filter(s => {
    const businessName = normalizeProductName(s.businessName || "");
    return businessName === normalizedQuery || businessName.includes(normalizedQuery);
  });

  if (directBusinessMatches.length > 0) {
    await UserSession.findOneAndUpdate(
      { phone },
      {
        $set: {
          "tempData.searchResults": directBusinessMatches,
          "tempData.searchPage": 0,
          "tempData.searchResultMode": "suppliers"
        }
      },
      { upsert: true }
    );

    const pageResults = directBusinessMatches.slice(0, 9);
    const rows = formatSupplierResults(
      pageResults,
      parsed.city || parsed.area || "",
      cleanProduct
    );

    if (directBusinessMatches.length > 9) {
      rows.push({
        id: "sup_search_next_page",
        title: `➡ More results (${directBusinessMatches.length - 9} more)`
      });
    }

        await UserSession.findOneAndUpdate(
      { phone },
      {
        $set: {
          "tempData.currentSearchContext": {
            product: cleanProduct,
            city: parsed.city || null,
            area: parsed.area || null,
            profileType: sess?.tempData?.supplierSearchType || null,
            resultMode: "suppliers"
          }
        }
      },
      { upsert: true }
    );

    await sendList(
      from,
      `🏪 *Business matches for ${cleanProduct}* in ${locationLabel} - ${directBusinessMatches.length} found`,
      rows
    );

    await _sendPostSearchActions(from, {
      product: cleanProduct,
      resultMode: "suppliers"
    });

    notifySuppliersOfLiveDemand({
      product: cleanProduct,
      city: parsed.city || null,
      area: parsed.area || null,
      profileType: sess?.tempData?.supplierSearchType || null,
      results: directBusinessMatches
    }).catch(err => console.error("[LIVE DEMAND DIRECT MATCH]", err.message));

    return;
  }

  // Keep existing offer-first behavior for real item/service searches
  const offerResults = await runSupplierOfferSearch({
    city: parsed.city || null,
    product: cleanProduct,
    area: null,
    profileType: sess?.tempData?.supplierSearchType || null
  });

  if (Array.isArray(offerResults) && offerResults.length > 0) {
    await UserSession.findOneAndUpdate(
      { phone },
      {
        $set: {
          "tempData.searchResults": offerResults,
          "tempData.searchPage": 0,
          "tempData.searchResultMode": "offers"
        }
      },
      { upsert: true }
    );

    const pageOffers = offerResults.slice(0, 9);
    const rows = formatSupplierOfferResults(pageOffers, cleanProduct);

    if (offerResults.length > 9) {
      rows.push({
        id: "sup_search_next_page",
        title: `➡ More results (${offerResults.length - 9} more)`
      });
    }

     await UserSession.findOneAndUpdate(
      { phone },
      {
        $set: {
          "tempData.currentSearchContext": {
            product: cleanProduct,
            city: parsed.city || null,
            area: parsed.area || null,
            profileType: sess?.tempData?.supplierSearchType || null,
            resultMode: "offers"
          }
        }
      },
      { upsert: true }
    );

    await sendList(
      from,
      `🔍 *${cleanProduct}* in ${locationLabel} - ${offerResults.length} found`,
      rows
    );

    await _sendPostSearchActions(from, {
      product: cleanProduct,
      resultMode: "offers"
    });

    notifySuppliersOfLiveDemand({
      product: cleanProduct,
      city: parsed.city || null,
      area: parsed.area || null,
      profileType: sess?.tempData?.supplierSearchType || null,
      results: offerResults
    }).catch(err => console.error("[LIVE DEMAND OFFER MATCH]", err.message));

    return;
  }

  if (!supplierResults.length) {
    return sendButtons(from, {
      text: `😕 No results for *${cleanProduct}*${parsed.city ? ` in *${parsed.city}*` : ""}.\n\nTry a different city or search term.`,
      buttons: [
        { id: "find_supplier", title: "🔍 Search Again" },
        { id: "sup_search_city_all", title: "📍 Try All Cities" }
      ]
    });
  }

  await UserSession.findOneAndUpdate(
    { phone },
    {
      $set: {
        "tempData.searchResults": supplierResults,
        "tempData.searchPage": 0,
        "tempData.searchResultMode": "suppliers"
      }
    },
    { upsert: true }
  );

  const pageResults = supplierResults.slice(0, 9);
  const rows = formatSupplierResults(
    pageResults,
    parsed.city || parsed.area || "",
    cleanProduct
  );

  if (supplierResults.length > 9) {
    rows.push({
      id: "sup_search_next_page",
      title: `➡ More results (${supplierResults.length - 9} more)`
    });
  }

  await UserSession.findOneAndUpdate(
    { phone },
    {
      $set: {
        "tempData.currentSearchContext": {
          product: cleanProduct,
          city: parsed.city || null,
          area: parsed.area || null,
          profileType: sess?.tempData?.supplierSearchType || null,
          resultMode: "suppliers"
        }
      }
    },
    { upsert: true }
  );

  await sendList(
    from,
    `🔍 *${cleanProduct}*${parsed.city ? ` in ${parsed.city}` : ""} - ${supplierResults.length} found`,
    rows
  );

  await _sendPostSearchActions(from, {
    product: cleanProduct,
    resultMode: "suppliers"
  });

  notifySuppliersOfLiveDemand({
    product: cleanProduct,
    city: parsed.city || null,
    area: parsed.area || null,
    profileType: sess?.tempData?.supplierSearchType || null,
    results: supplierResults
  }).catch(err => console.error("[LIVE DEMAND SUPPLIER MATCH]", err.message));

  return;
}

  return sendList(from, `🔍 Looking for: *${cleanProduct}*\n\nWhich city?`, [
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
  a === "sup_upgrade_plan" ||
  a === "sup_renew_plan" ||
 a === "sup_search_type_product" ||
      a === "sup_search_type_service" ||
     a === "reg_type_school" ||
  a === "sup_search_more_categories" ||
  a === "sup_search_all" ||

  // ── school admin actions must not fall through to marketplace search ──
  a === "school_admin_manage_facilities" ||
  a === "school_admin_manage_extramural" ||
  a === "school_admin_edit_fees" ||
  a === "school_admin_edit_reg_link" ||
  a === "school_admin_edit_email" ||
  a === "school_admin_edit_website" ||
  a === "school_admin_upload_brochure" ||
  a.startsWith("school_fac_page_") ||
  a.startsWith("school_fac_toggle_") ||
  a.startsWith("school_ext_page_") ||
  a.startsWith("school_ext_toggle_") ||
  a.startsWith("sup_shop_") ||
  a === "sup_back_to_search_results" ||
  a.startsWith("sup_number_full_") ||
  a.startsWith("sup_catalog_page_") ||
  a.startsWith("sup_cart_view_") ||
  a.startsWith("sup_catalogue_search_") ||
  a === "sup_catalogue_search_cancel" ||
  a.startsWith("sup_search_cat_") ||
  a.startsWith("sup_search_city_") ||
  a.startsWith("sup_view_") ||
  a.startsWith("sup_order_") ||
  a.startsWith("sup_save_") ||
  a.startsWith("rate_order_") ||
a.startsWith("sup_accept_") ||
  a.startsWith("sup_decline_") ||
  a.startsWith("sup_view_order_") ||
  a.startsWith("sup_contact_buyer_") ||
  a.startsWith("sup_cart_add_") ||
  a.startsWith("sup_cart_confirm_") ||
  a.startsWith("sup_cart_clear_") ||
  a.startsWith("sup_cart_remove_") ||
  a.startsWith("sup_cart_custom_") ||
  a.startsWith("paylist_prev_") ||
      a.startsWith("paylist_next_") ||
      a.startsWith("paylist_search_") ||

  a === "sup_request_sellers" ||
  a === "sup_request_mode_simple" ||
  a === "sup_request_mode_bulk" ||
  a === "sup_request_delivery_yes" ||
  a === "sup_request_delivery_no" ||
  a.startsWith("req_offer_") ||
  a.startsWith("req_unavail_") ||
  a === "view_and_quote" ||
  a === "not_available" ||
  a.startsWith("buyer_view_all_quotes_") ||
  a === "buyer_my_requests" ||


a === "sup_search_next_page" ||
  a === "sup_search_prev_page" ||
  a === "my_supplier_account" ||
  a === "main_menu_back" ||
      a.startsWith("payinv_full_") ||
    a === "biz_tools_menu" ||


      a === "sup_request_quote_search" ||
  a === "sup_save_search_current" ||
  a.startsWith("sup_request_quote_supplier_") ||
  a.startsWith("sup_ask_availability_") ||
  // ── Schools ──────────────────────────────────────────────────────────────
  a === "find_school" ||
  a === "school_register" ||
  a === "school_account" ||
  a === "school_pay_plan" ||
  a === "school_search_refine" ||
  a === "school_toggle_admissions" ||
  a === "school_update_fees" ||
  a === "school_reg_confirm_yes" ||
  a === "school_reg_confirm_no" ||
  a === "school_reg_address_skip" ||
  a === "school_reg_principal_skip" ||
  a === "school_reg_email_skip" ||
  a === "school_reg_cur_done" ||
  a === "school_reg_fac_done" ||
  a === "school_reg_ext_done" ||
  a === "school_reg_city_other" ||
  a.startsWith("school_reg_type_") ||
  a.startsWith("school_reg_city_") ||
  a.startsWith("school_reg_cur_") ||
  a.startsWith("school_reg_gender_") ||
  a.startsWith("school_reg_boarding_") ||
  a.startsWith("school_reg_fac_") ||
  a.startsWith("school_reg_ext_") ||
  a.startsWith("school_plan_") ||
  a.startsWith("school_search_city_") ||
  a.startsWith("school_search_type_") ||
  a.startsWith("school_search_fees_") ||
  a.startsWith("school_search_fac_") ||
  a.startsWith("school_search_page_") ||
  a.startsWith("school_view_") ||
 a.startsWith("school_dl_profile_") ||
  a.startsWith("school_apply_") ||
  a.startsWith("school_enquiry_") ||
  a === "school_my_profile" ||
  a === "school_my_facilities" ||
  a === "school_my_fees" ||
  a === "school_my_reviews" ||
  a === "school_my_inquiries" ||
  a === "school_more_options" ||
  a === "school_update_reg_link" ||
  a === "school_update_email" ||
  a === "school_update_website";

// ── Shortcode search intercept: "find cement", "s plumber harare" etc ─────
// ── Shortcode search intercept: "find cement", "find mushambahuro harare" etc ─────


if (GREETING_WORDS.has(text.trim().toLowerCase())) {
  await UserSession.findOneAndUpdate(
    { phone },
    {
      $unset: {
        "tempData.supplierSearchMode": "",
        "tempData.supplierSearchProduct": "",
        "tempData.supplierSearchCategory": "",
        "tempData.lastSearchCity": "",
        "tempData.lastSearchArea": ""
      }
    },
    { upsert: true }
  );
}

const _sessForOrderCheck = await UserSession.findOne({ phone });
const _activeOrderState = _sessForOrderCheck?.tempData?.orderState;
const _orderBlockedStates = new Set([
  "supplier_order_address",
  "supplier_order_picking",
  "supplier_order_enter_price"
]);

// AFTER:
const _schoolEnquiryState = _sessForOrderCheck?.tempData?.schoolEnquiryState;

if (
  !isMetaAction &&
  text.trim().length > 2 &&
  !GREETING_WORDS.has(text.trim().toLowerCase()) &&
  !_orderBlockedStates.has(_activeOrderState) &&
  _schoolEnquiryState !== "school_parent_enquiry"
) {
  console.log(`[HIT-NOBIZ-SHORTCODE] text="${text}"`);
  const { parseShortcodeSearch } = await import("./supplierSearch.js");
  const shortcode = parseShortcodeSearch(text);

  if (shortcode) {
    await UserSession.findOneAndUpdate(
      { phone },
      {
        $set: {
          "tempData.supplierSearchProduct": shortcode.product,
          ...(shortcode.city ? { "tempData.lastSearchCity": shortcode.city } : {}),
          ...(shortcode.area ? { "tempData.lastSearchArea": shortcode.area } : {})
        }
      },
      { upsert: true }
    );

        // INLINE CITY/SUBURB SEARCH MUST BE OFFER-FIRST
    if (shortcode.city || shortcode.area) {
      const locationLabel = shortcode.area
        ? `${shortcode.area}, ${shortcode.city}`
        : shortcode.city || "Zimbabwe";

      console.log(
        `[TRACE-NOBIZ-OFFER-FIRST] city="${shortcode.city}" area="${shortcode.area}" product="${shortcode.product}"`
      );

      // Behave like city-picker flow:
      // city-level offer search first, without forcing area
      let offerResults = await runSupplierOfferSearch({
        city: shortcode.city || null,
        product: shortcode.product,
        area: null
      });

      console.log(`[TRACE-NOBIZ-OFFER-FIRST-RESULT1] offerResults.length=${offerResults.length}`);

      // Retry across all cities, still without forcing area
      if (!offerResults.length) {
        offerResults = await runSupplierOfferSearch({
          city: null,
          product: shortcode.product,
          area: null
        });
        console.log(`[TRACE-NOBIZ-OFFER-FIRST-RESULT2] offerResults.length=${offerResults.length}`);
      }

      if (offerResults.length) {
        await UserSession.findOneAndUpdate(
          { phone },
          {
            $set: {
              "tempData.searchResults": offerResults,
              "tempData.searchPage": 0,
              "tempData.searchResultMode": "offers",
              "tempData.supplierSearchProduct": shortcode.product,
              ...(shortcode.city ? { "tempData.lastSearchCity": shortcode.city } : {}),
              ...(shortcode.area ? { "tempData.lastSearchArea": shortcode.area } : {})
            }
          },
          { upsert: true }
        );

        const pageOffers = offerResults.slice(0, 9);
        const rows = formatSupplierOfferResults(pageOffers, shortcode.product);

        if (offerResults.length > 9) {
          rows.push({
            id: "sup_search_next_page",
            title: `➡ More results (${offerResults.length - 9} more)`
          });
        }

        return sendList(
          from,
          `🔍 *${shortcode.product}* in ${locationLabel} - ${offerResults.length} found`,
          rows
        );
      }

      // Only now fallback to supplier-level results
      const searchArgs = {
        ...(shortcode.city ? { city: shortcode.city } : {}),
        product: shortcode.product,
        area: shortcode.area || null
      };

      console.log(`[TRACE-NOBIZ-SUPPLIER-FALLBACK] searchArgs=${JSON.stringify(searchArgs)}`);
      const results = await runSupplierSearch(searchArgs);
      console.log(`[TRACE-NOBIZ-SUPPLIER-FALLBACK2] runSupplierSearch returned ${results.length} results`);

      if (results.length) {
        const rows = formatSupplierResults(
          results.slice(0, 9),
          shortcode.city || shortcode.area || "",
          shortcode.product
        );

        if (results.length > 9) {
          rows.push({
            id: "sup_search_next_page",
            title: `➡ More results (${results.length - 9} more)`
          });
        }

        return sendList(
          from,
          `🔍 *${shortcode.product}* in ${locationLabel} - ${results.length} found`,
          rows
        );
      }

      return sendButtons(from, {
        text: `😕 No results for *${shortcode.product}*${shortcode.city ? ` in *${shortcode.city}*` : ""}.\n\nTry a different city or search term.`,
        buttons: [
          { id: "find_supplier", title: "🔍 Search Again" },
          { id: "sup_search_city_all", title: "📍 Try All Cities" }
        ]
      });
    }

    // NO LOCATION: keep existing supplier-first behavior
    const searchArgs = {
      ...(shortcode.city ? { city: shortcode.city } : {}),
      product: shortcode.product,
      area: shortcode.area || null
    };

    console.log(`[TRACE-NOBIZ] non-biz shortcode path: searchArgs=${JSON.stringify(searchArgs)}`);
    const results = await runSupplierSearch(searchArgs);
    console.log(`[TRACE-NOBIZ2] runSupplierSearch returned ${results.length} results`);

        const normalizedQuery = normalizeProductName(shortcode.product);
    const directBusinessMatches = results.filter(s => {
      const businessName = normalizeProductName(s.businessName || "");
      return businessName === normalizedQuery || businessName.includes(normalizedQuery);
    });

    // BUSINESS-NAME SEARCH:
    // always show a selectable results list first,
    // even if there is only one clear business match.
    if (directBusinessMatches.length > 0) {
      const pageResults = directBusinessMatches.slice(0, 9);
      const rows = formatSupplierResults(
        pageResults,
        shortcode.city || shortcode.area || null,
        shortcode.product
      );

      if (directBusinessMatches.length > 9) {
        await UserSession.findOneAndUpdate(
          { phone },
          {
            $set: {
              "tempData.searchResults": directBusinessMatches,
              "tempData.searchPage": 0,
              "tempData.searchResultMode": "suppliers"
            }
          },
          { upsert: true }
        );
        rows.push({
          id: "sup_search_next_page",
          title: `➡ More results (${directBusinessMatches.length - 9} more)`
        });
      } else {
        await UserSession.findOneAndUpdate(
          { phone },
          {
            $set: {
              "tempData.searchResults": directBusinessMatches,
              "tempData.searchPage": 0,
              "tempData.searchResultMode": "suppliers"
            }
          },
          { upsert: true }
        );
      }

      const locationLabel = shortcode.area
        ? `${shortcode.area}, ${shortcode.city}`
        : shortcode.city || null;

      return sendList(
        from,
        locationLabel
          ? `🔍 *${shortcode.product}* in ${locationLabel} - ${directBusinessMatches.length} found`
          : `🏪 *Business matches for ${shortcode.product}* - ${directBusinessMatches.length} found`,
        rows
      );
    }


if (shortcode.city && results.length) {
      const locationLabel = shortcode.area
        ? `${shortcode.area}, ${shortcode.city}`
        : shortcode.city;

      // Try offers with city first
      console.log(`[TRACE-B] calling runSupplierOfferSearch city="${shortcode.city}" product="${shortcode.product}" area="${shortcode.area}"`);
         // IMPORTANT:
      // For inline suburb/city text like "find valve mbare",
      // do NOT force area on offer search.
      // Use city-level offer search first so this matches the city-picker flow.
      let offerResults = await runSupplierOfferSearch({
        city: shortcode.city,
        product: shortcode.product,
        area: null
      });

      // If city-level offer search returns nothing, retry across all cities
      // but still do NOT force area here.
      if (!offerResults.length) {
        offerResults = await runSupplierOfferSearch({
          city: null,
          product: shortcode.product,
          area: null
        });
      }
      if (offerResults.length) {
        await UserSession.findOneAndUpdate(
          { phone },
          {
            $set: {
              "tempData.searchResults": offerResults,
              "tempData.searchPage": 0,
              "tempData.searchResultMode": "offers"
            }
          },
          { upsert: true }
        );
        if (biz) {
          biz.sessionData = {
            ...(biz.sessionData || {}),
            supplierSearch: { product: shortcode.product, city: shortcode.city },
            searchResults: offerResults,
            searchPage: 0,
            searchResultMode: "offers"
          };
          await saveBizSafe(biz);
        }
        const pageOffers = offerResults.slice(0, 9);
        const rows = formatSupplierOfferResults(pageOffers, shortcode.product);
        if (offerResults.length > 9) {
          rows.push({ id: "sup_search_next_page", title: `➡ More results (${offerResults.length - 9} more)` });
        }
        return sendList(from, `🔍 *${shortcode.product}* in ${locationLabel} - ${offerResults.length} found`, rows);
      }

      // Only reach here if no offers found anywhere - show businesses as last resort
      const pageResults = results.slice(0, 9);
      const rows = formatSupplierResults(pageResults, shortcode.city, shortcode.product);
      if (results.length > 9) {
        await UserSession.findOneAndUpdate(
          { phone },
          {
            $set: {
              "tempData.searchResults": results,
              "tempData.searchPage": 0,
              "tempData.searchResultMode": "suppliers"
            }
          },
          { upsert: true }
        );
        rows.push({ id: "sup_search_next_page", title: `➡ More results (${results.length - 9} more)` });
      }
      return sendList(from, `🔍 *${shortcode.product}* in ${locationLabel} - ${results.length} found`, rows);
    }

    if (!shortcode.city && directBusinessMatches.length > 0) {
      const pageResults = directBusinessMatches.slice(0, 9);
      const rows = formatSupplierResults(pageResults, null, shortcode.product);

      if (directBusinessMatches.length > 9) {
        await UserSession.findOneAndUpdate(
          { phone },
          {
            $set: {
              "tempData.searchResults": directBusinessMatches,
              "tempData.searchPage": 0,
              "tempData.searchResultMode": "suppliers"
            }
          },
          { upsert: true }
        );
        rows.push({ id: "sup_search_next_page", title: `➡ More results (${directBusinessMatches.length - 9} more)` });
      }

      return sendList(from, `🏪 *Business matches for ${shortcode.product}* - ${directBusinessMatches.length} found`, rows);
    }

 // City was given but no results found - say so, offer to try all cities
    if (shortcode.city) {
      return sendButtons(from, {
        text: `😕 No results for *${shortcode.product}* in *${shortcode.city}*.\n\nTry a different city or search all of Zimbabwe?`,
        buttons: [
          { id: "sup_search_city_all", title: "📍 Search All Cities" },
          { id: "find_supplier",       title: "🔍 Search Again" }
        ]
      });
    }

    // No city given - ask for it
   // No city given - store product in session then ask for city
    await UserSession.findOneAndUpdate(
      { phone },
      { $set: { "tempData.supplierSearchProduct": shortcode.product, "tempData.supplierSearchMode": "product" } },
      { upsert: true }
    );
    if (biz) {
      biz.sessionData = { ...(biz.sessionData || {}), supplierSearch: { product: shortcode.product } };
      biz.sessionState = "supplier_search_city";
      await saveBizSafe(biz);
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
  return sendList(from, "👋 *Welcome to ZimQuote!*\n\nZimbabwe's marketplace for products & services.", [
    { id: "find_supplier",    title: "🔍 Browse & Shop" },
    { id: "find_school",      title: "🏫 Find a School" },
    { id: "my_orders",        title: "📋 My Orders" },
    { id: "register_supplier",title: "📦 List My Business" },
  ]);
}


}



if (a === "sup_save_search_current") {
  const sess = await UserSession.findOne({ phone });
  const ctx = sess?.tempData?.currentSearchContext || {};

  const saved = await _saveCurrentSearchForBuyer({
    phone,
    biz,
    fallback: ctx
  });

  return sendButtons(from, {
    text:
      `✅ Search saved.\n\n` +
      `🔎 ${saved.product || "Search"}\n` +
      `${saved.area ? `📍 ${saved.area}${saved.city ? `, ${saved.city}` : ""}\n` : saved.city ? `📍 ${saved.city}\n` : ""}` +
      `You can search again anytime.`,
    buttons: [
      { id: "find_supplier", title: "🔍 Search Again" },
      { id: "suppliers_home", title: "🛒 Marketplace" }
    ]
  });
}




if (a === "sup_request_quote_search") {
  const sess = await UserSession.findOne({ phone });
  const ctx = sess?.tempData?.currentSearchContext || {};
  const results = sess?.tempData?.searchResults || [];

  if (!results.length) {
    return sendButtons(from, {
      text: "❌ Search session expired. Please search again.",
      buttons: [{ id: "find_supplier", title: "🔍 Search Again" }]
    });
  }

  const uniqueSupplierIds = [
    ...new Set(
      results
        .map(r => String(r?.supplierId || r?._id || r?.supplier?._id || ""))
        .filter(Boolean)
    )
  ].slice(0, 5);

  const suppliers = await SupplierProfile.find({
    _id: { $in: uniqueSupplierIds }
  }).lean();

  if (!suppliers.length) {
    return sendButtons(from, {
      text: "❌ No suppliers available for quote request right now.",
      buttons: [{ id: "find_supplier", title: "🔍 Search Again" }]
    });
  }

  // ── Shared helper: send quote request notification with template fallback ──
  async function _sendQuoteNotification(supplierPhone, supplierProfile, item, buyerPhone, ctx) {
    const normalizedPhone = String(supplierPhone).replace(/\D+/, "");
    const fullPhone = normalizedPhone.startsWith("0") && normalizedPhone.length === 10
      ? "263" + normalizedPhone.slice(1) : normalizedPhone;

    const isService = supplierProfile?.profileType === "service";
    const label     = item || ctx.product || "your request";
    const cityText  = ctx.city || supplierProfile?.location?.city || "Zimbabwe";
    const areaText  = ctx.area ? `${ctx.area}, ${cityText}` : cityText;

    // ── Set session state so seller's price reply is handled correctly ──────────
    const _normPhoneKey = fullPhone.replace(/\D+/g, "");
    await UserSession.findOneAndUpdate(
      { phone: _normPhoneKey },
      {
        $set: {
          "tempData.pendingQuoteReply":      "true",
          "tempData.pendingQuoteItem":       label,
          "tempData.pendingQuoteBuyerPhone": buyerPhone,
          "tempData.pendingQuoteCity":       ctx.city || "",
          "tempData.pendingQuoteArea":       ctx.area || ""
        }
      },
      { upsert: true }
    );

    const interactiveBody = {
      text:
        `📋 *New Quote Request*\n\n` +
        `${isService ? "🔧 Service" : "🔎 Item"}: *${label}*\n` +
        `${ctx.area ? `📍 Area: ${ctx.area}\n` : ""}` +
        `${ctx.city ? `🏙 City: ${ctx.city}\n` : ""}` +
        `📞 Buyer: ${buyerPhone}\n\n` +
        `─────────────────\n` +
        `💰 *Reply with your price to send the buyer a quote.*\n\n` +
        `*Examples:*\n` +
        `• *25* - flat price\n` +
        `• *25/hour* or *25/job* - rate\n` +
        `• *From 50, depends on scope* - range\n\n` +
        `Or type a full message e.g: _250 includes labour and materials_\n\n` +
        `Type *cancel* to ignore this request.`,
      buttons: [
        { id: "my_supplier_account", title: "🏪 My Store"   },
        { id: "suppliers_home",      title: "🛒 Marketplace" }
      ]
    };

    // ── Try interactive first (works within 24-hour session) ──────────────────
    try {
      await sendButtons(fullPhone, interactiveBody);
      return;
    } catch (btnErr) {
      console.warn(`[QUOTE NOTIFY] sendButtons failed for ${fullPhone}: ${btnErr.message} - trying template`);
    }

    // ── Outside 24-hour window - use approved Meta template ───────────────────
    // Reuses supplier_new_buyer_request template (already approved & active).
    // Template body:
    //   New buyer request on ZimQuote!
    //   Ref: {{1}} | Location: {{2}} | Items: {{3}} | {{4}}
    try {
      const _axios = (await import("axios")).default;
      const _PHONE_ID    = process.env.WHATSAPP_PHONE_NUMBER_ID || process.env.META_PHONE_NUMBER_ID || process.env.PHONE_NUMBER_ID;
      const _TOKEN       = process.env.META_ACCESS_TOKEN || process.env.WHATSAPP_ACCESS_TOKEN;
      const _quoteRef    = `QR-${Date.now().toString(36).toUpperCase().slice(-5)}`;

      await _axios.post(
        `https://graph.facebook.com/v24.0/${_PHONE_ID}/messages`,
        {
          messaging_product: "whatsapp",
          to:   fullPhone,
          type: "template",
          template: {
            name:     "supplier_new_buyer_request",
            language: { code: "en" },
            components: [{
              type: "body",
              parameters: [
                { type: "text", text: _quoteRef },
                { type: "text", text: areaText  },
                { type: "text", text: `Quote requested: ${label}` },
                { type: "text", text: "Buyer wants your price" }
              ]
            }]
          }
        },
        { headers: { Authorization: `Bearer ${_TOKEN}`, "Content-Type": "application/json" } }
      );
      console.log(`[QUOTE NOTIFY] Template sent to ${fullPhone} (${_quoteRef})`);

      // After template opens session, send full interactive details after 2s
      await new Promise(r => setTimeout(r, 2000));
      await sendButtons(fullPhone, interactiveBody);
    } catch (tplErr) {
      console.error(`[QUOTE NOTIFY] Template also failed for ${fullPhone}: ${tplErr.message}`);
    }
  }

  for (const supplier of suppliers) {
    try {
      await _sendQuoteNotification(supplier.phone, supplier, ctx.product, from, ctx);
    } catch (err) {
      console.error("[QUOTE REQUEST SEARCH NOTIFY]", err.message);
    }
  }

  return sendButtons(from, {
    text:
      `✅ Quote request sent to matching suppliers for *${ctx.product || "your search"}*.\n\n` +
      `Suppliers can now respond to you directly.`,
    buttons: [
      { id: "my_orders", title: "📋 My Orders" },
      { id: "find_supplier", title: "🔍 Search Again" }
    ]
  });
}




if (a.startsWith("sup_request_quote_supplier_")) {
  const raw = a.replace("sup_request_quote_supplier_", "");
  const parts = raw.split("_");
  const supplierId = parts.shift();
  const productName = parts.length ? decodeURIComponent(parts.join("_")) : null;

  const supplier = await SupplierProfile.findById(supplierId).lean();
  if (!supplier) return sendText(from, "❌ Supplier not found.");

  const sess = await UserSession.findOne({ phone });
  const ctx = sess?.tempData?.currentSearchContext || {};
  const requestedItem =
    productName ||
    ctx.product ||
    sess?.tempData?.supplierSearchProduct ||
    "item/service";

  // ── Notify supplier with template fallback (reaches outside 24-hour window) ──
  try {
    const _normPhone2  = String(supplier.phone).replace(/\D+/g, "");
    const _fullPhone2  = _normPhone2.startsWith("0") && _normPhone2.length === 10
      ? "263" + _normPhone2.slice(1) : _normPhone2;
    const _isService2  = supplier?.profileType === "service";
    const _cityText2   = ctx.city || supplier?.location?.city || "Zimbabwe";
    const _areaText2   = ctx.area ? `${ctx.area}, ${_cityText2}` : _cityText2;

    // ── Set session state so seller's price reply is handled correctly ──────────
    const _normPhone2Key = _fullPhone2.replace(/\D+/g, "");
    await UserSession.findOneAndUpdate(
      { phone: _normPhone2Key },
      {
        $set: {
          "tempData.pendingQuoteReply":      "true",
          "tempData.pendingQuoteItem":       requestedItem,
          "tempData.pendingQuoteBuyerPhone": from,
          "tempData.pendingQuoteCity":       ctx.city || "",
          "tempData.pendingQuoteArea":       ctx.area || ""
        }
      },
      { upsert: true }
    );

    const _interactiveBody2 = {
      text:
        `📋 *New Quote Request*\n\n` +
        `🏪 A buyer selected your business\n` +
        `${_isService2 ? "🔧 Service" : "🔎 Item"}: *${requestedItem}*\n` +
        `${ctx.area ? `📍 Area: ${ctx.area}\n` : ""}` +
        `${ctx.city ? `🏙 City: ${ctx.city}\n` : ""}` +
        `📞 Buyer: ${from}\n\n` +
        `─────────────────\n` +
        `💰 *Reply with your price to send the buyer a quote.*\n\n` +
        `*Examples:*\n` +
        `• *25* - flat price\n` +
        `• *25/hour* or *25/job* - rate\n` +
        `• *From 50, depends on scope* - range\n\n` +
        `Or type a full message e.g: _250 includes labour and materials_\n\n` +
        `Type *cancel* to ignore this request.`,
      buttons: [
        { id: "my_supplier_account", title: "🏪 My Store"   },
        { id: "suppliers_home",      title: "🛒 Marketplace" }
      ]
    };

    // Try interactive first (within 24hr session)
    let _sentInteractive = false;
    try {
      await sendButtons(_fullPhone2, _interactiveBody2);
      _sentInteractive = true;
    } catch (btnErr) {
      console.warn(`[QUOTE NOTIFY SINGLE] sendButtons failed for ${_fullPhone2}: ${btnErr.message} - trying template`);
    }

    // Outside 24-hour window - send approved Meta template to open session
    if (!_sentInteractive) {
      try {
        const _axios2    = (await import("axios")).default;
        const _PHONE_ID2 = process.env.WHATSAPP_PHONE_NUMBER_ID || process.env.META_PHONE_NUMBER_ID || process.env.PHONE_NUMBER_ID;
        const _TOKEN2    = process.env.META_ACCESS_TOKEN || process.env.WHATSAPP_ACCESS_TOKEN;
        const _qRef2     = `QR-${Date.now().toString(36).toUpperCase().slice(-5)}`;

        await _axios2.post(
          `https://graph.facebook.com/v24.0/${_PHONE_ID2}/messages`,
          {
            messaging_product: "whatsapp",
            to:   _fullPhone2,
            type: "template",
            template: {
              name:     "supplier_new_buyer_request",
              language: { code: "en" },
              components: [{
                type: "body",
                parameters: [
                  { type: "text", text: _qRef2 },
                  { type: "text", text: _areaText2 },
                  { type: "text", text: `Quote requested: ${requestedItem}` },
                  { type: "text", text: "Buyer wants your price" }
                ]
              }]
            }
          },
          { headers: { Authorization: `Bearer ${_TOKEN2}`, "Content-Type": "application/json" } }
        );
        console.log(`[QUOTE NOTIFY SINGLE] Template sent to ${_fullPhone2} (${_qRef2})`);

        // Template opens the session - send full interactive details after 2s
        await new Promise(r => setTimeout(r, 2000));
        await sendButtons(_fullPhone2, _interactiveBody2);
      } catch (tplErr) {
        console.error(`[QUOTE NOTIFY SINGLE] Template also failed for ${_fullPhone2}: ${tplErr.message}`);
      }
    }
  } catch (err) {
    console.error("[QUOTE REQUEST SINGLE SUPPLIER]", err.message);
  }

  return sendButtons(from, {
    text:
      `✅ Quote request sent to *${supplier.businessName}* for *${requestedItem}*.`,
    buttons: [
      { id: `sup_view_${supplier._id}`, title: "🏪 View Supplier" },
      { id: "find_supplier", title: "🔍 Search Again" }
    ]
  });
}




if (a.startsWith("sup_ask_availability_")) {
  const raw = a.replace("sup_ask_availability_", "");
  const parts = raw.split("_");
  const supplierId = parts.shift();
  const productName = parts.length ? decodeURIComponent(parts.join("_")) : null;

  const supplier = await SupplierProfile.findById(supplierId).lean();
  if (!supplier) return sendText(from, "❌ Supplier not found.");

  const sess = await UserSession.findOne({ phone });
  const ctx = sess?.tempData?.currentSearchContext || {};
  const requestedItem =
    productName ||
    ctx.product ||
    sess?.tempData?.supplierSearchProduct ||
    "item/service";

  // ── Notify supplier with template fallback (reaches outside 24-hour window) ──
  try {
    const _normPhoneAv  = String(supplier.phone).replace(/\D+/g, "");
    const _fullPhoneAv  = _normPhoneAv.startsWith("0") && _normPhoneAv.length === 10
      ? "263" + _normPhoneAv.slice(1) : _normPhoneAv;
    const _isServiceAv  = supplier?.profileType === "service";
    const _cityTextAv   = ctx.city || supplier?.location?.city || "Zimbabwe";
    const _areaTextAv   = ctx.area ? `${ctx.area}, ${_cityTextAv}` : _cityTextAv;

    const _avBody = {
      text:
        `❓ *Buyer Availability Check*\n\n` +
        `${_isServiceAv ? "🔧 Service" : "🔎 Item"}: *${requestedItem}*\n` +
        `${ctx.area ? `📍 Area: ${ctx.area}\n` : ""}` +
        `${ctx.city ? `🏙 City: ${ctx.city}\n` : ""}` +
        `📞 Buyer: ${from}\n\n` +
        `${_isServiceAv
          ? "Buyer wants to know if you are available. Reply to confirm."
          : "Buyer wants to know if this is in stock. Reply to confirm."}`,
      buttons: [
        { id: "my_supplier_account", title: "🏪 My Store"   },
        { id: "suppliers_home",      title: "🛒 Marketplace" }
      ]
    };

    let _avSent = false;
    try {
      await sendButtons(_fullPhoneAv, _avBody);
      _avSent = true;
    } catch (btnErr) {
      console.warn(`[AVAIL NOTIFY] sendButtons failed for ${_fullPhoneAv}: ${btnErr.message} - trying template`);
    }

    if (!_avSent) {
      try {
        const _axiosAv   = (await import("axios")).default;
        const _PHONE_IDAv = process.env.WHATSAPP_PHONE_NUMBER_ID || process.env.META_PHONE_NUMBER_ID || process.env.PHONE_NUMBER_ID;
        const _TOKENAv    = process.env.META_ACCESS_TOKEN || process.env.WHATSAPP_ACCESS_TOKEN;
        const _avRef      = `AV-${Date.now().toString(36).toUpperCase().slice(-5)}`;

        await _axiosAv.post(
          `https://graph.facebook.com/v24.0/${_PHONE_IDAv}/messages`,
          {
            messaging_product: "whatsapp",
            to:   _fullPhoneAv,
            type: "template",
            template: {
              name:     "supplier_new_buyer_request",
              language: { code: "en" },
              components: [{
                type: "body",
                parameters: [
                  { type: "text", text: _avRef },
                  { type: "text", text: _areaTextAv },
                  { type: "text", text: `Availability check: ${requestedItem}` },
                  { type: "text", text: _isServiceAv ? "Are you available?" : "Is this in stock?" }
                ]
              }]
            }
          },
          { headers: { Authorization: `Bearer ${_TOKENAv}`, "Content-Type": "application/json" } }
        );
        console.log(`[AVAIL NOTIFY] Template sent to ${_fullPhoneAv} (${_avRef})`);
        await new Promise(r => setTimeout(r, 2000));
        await sendButtons(_fullPhoneAv, _avBody);
      } catch (tplErr) {
        console.error(`[AVAIL NOTIFY] Template also failed for ${_fullPhoneAv}: ${tplErr.message}`);
      }
    }
  } catch (err) {
    console.error("[ASK AVAILABILITY]", err.message);
  }

  return sendButtons(from, {
    text:
      `✅ Your availability request was sent to *${supplier.businessName}*.`,
    buttons: [
      { id: `sup_view_${supplier._id}`, title: "🏪 View Supplier" },
      { id: "find_supplier", title: "🔍 Search Again" }
    ]
  });
}




// =========================
// 📦 NO-BIZ SUPPLIER REGISTRATION PRICE FLOW
// =========================
if ((!biz || isGhostSupplierBiz) && !isMetaAction) {
  const sess = await UserSession.findOne({ phone });
  const regState = sess?.supplierRegState;
  const reg = sess?.supplierRegData || {};

  if (regState === "supplier_reg_prices") {
    const raw = (text || "").trim();
    const isService = reg.profileType === "service";
    const products = (reg.products || []).filter(p => p !== "pending_upload");

    if (!raw) {
      await sendText(from, "❌ Please send your prices or rates, or tap Skip.");
      return true;
    }

    if (!products.length) {
      await sendText(from, "❌ No products/services found in registration. Please go back and add them first.");
      return true;
    }

    const { updated, failed } = parseSupplierPriceInput(raw, products, isService);

    if (!updated.length) {
      const numbered = products.map((p, i) => `${i + 1}. ${p}`).join("\n");

   await sendText(from,
`❌ Couldn't read your ${isService ? "rates" : "prices"}.

*Your items:*
${numbered}

─────────────────
*Fastest way: update by item number*

*Single item:*
_${isService ? "1x20/job" : "1x5.50"}_
_${isService ? "1 x 20/job" : "1 x 5.50"}_

*Same ${isService ? "rate" : "price"} for selected items:*
_${isService ? "1,3,5x20/job" : "1,3,5x5.50"}_
_${isService ? "1,3,5 x 20/job" : "1,3,5 x 5.50"}_

*Same ${isService ? "rate" : "price"} for a range:*
_${isService ? "1-4x15/hr" : "1-4x5.50"}_
_${isService ? "1-4 x 15/hr" : "1-4 x 5.50"}_

*Mixed updates:*
_${isService ? "1x20/job,2x15/trip,3x10/hr" : "1x5.50,2x8.00,3x12.00"}_
_${isService ? "1 x 20/job, 2 x 15/trip, 3 x 10/hr" : "1 x 5.50, 2 x 8.00, 3 x 12.00"}_

*Other options still work:*

*Update ALL in order:*
_${products.slice(0, 3).map((_, i) => (((i + 1) * 4)).toFixed(2)).join(", ")}_

*Update selected items by name:*
_${products.slice(0, 2).map(p => `${p}: ${isService ? "20/job" : "6.00"}`).join(", ")}_

Type *skip* to add them later.`
);
      return true;
    }

    const previewLines = updated
      .map(u => `• ${u.product} - $${Number(u.amount).toFixed(2)}/${u.unit}`)
      .join("\n");

    const failNote = failed.length
      ? `\n\n⚠️ Skipped ${failed.length}: _${failed.slice(0, 2).join(", ")}_`
      : "";

    await UserSession.findOneAndUpdate(
      { phone },
      {
        $set: {
          "supplierRegData.pendingPriceUpdate": updated
        }
      },
      { upsert: true }
    );

    return sendButtons(from, {
      text:
`💰 *${isService ? "Rate" : "Price"} Preview* (${updated.length} items)

${previewLines}${failNote}

Save these ${isService ? "rates" : "prices"}?`,
      buttons: [
        { id: "sup_price_update_confirm", title: "✅ Save" },
        { id: "sup_skip_prices", title: "⏭ Skip For Now" }
      ]
    });
  }
}


// =========================
// 🏪 NO-BIZ SUPPLIER ACCOUNT PRICE UPDATE FLOW
// =========================
if ((!biz || isGhostSupplierBiz) && !isMetaAction) {
  const sess = await UserSession.findOne({ phone });
  const accountState = sess?.tempData?.supplierAccountState;

  if (accountState === "supplier_update_prices") {
    const supplier = await SupplierProfile.findOne({ phone });
    if (!supplier) {
      await UserSession.findOneAndUpdate(
        { phone },
        { $unset: { "tempData.supplierAccountState": "", "tempData.pendingPriceUpdate": "" } }
      );
      return sendSuppliersMenu(from);
    }

    const raw = (text || "").trim();
    const isService = supplier.profileType === "service";
    const products = (supplier.products || []).filter(p => p !== "pending_upload");

    if (!raw) {
      await sendText(from, `❌ Please send your ${isService ? "rates" : "prices"}, or type *cancel*.`);
      return true;
    }

    if (al === "cancel") {
      await UserSession.findOneAndUpdate(
        { phone },
        { $unset: { "tempData.supplierAccountState": "", "tempData.pendingPriceUpdate": "", "tempData.supplierAccountType": "" } }
      );
      return sendSupplierAccountMenu(from, supplier);
    }

    if (!products.length) {
      await UserSession.findOneAndUpdate(
        { phone },
        { $unset: { "tempData.supplierAccountState": "", "tempData.pendingPriceUpdate": "", "tempData.supplierAccountType": "" } }
      );
      return sendButtons(from, {
        text: `❌ No ${isService ? "services" : "products"} found. Add items first.`,
        buttons: [{ id: "sup_edit_products", title: "✏️ Manage Items" }]
      });
    }

    const { updated, failed } = parseSupplierPriceInput(raw, products, isService);

    if (!updated.length) {
      await sendSupplierItemsInChunks(
        from,
        products,
        `💰 Update ${isService ? "Rates" : "Prices"}`
      );
      await sendSupplierQuickPriceHelp(from, products, isService);

      return sendButtons(from, {
        text: `❌ Couldn't read your ${isService ? "rates" : "prices"}.\n\nTry again or go back to your account.`,
        buttons: [{ id: "my_supplier_account", title: "🏪 My Account" }]
      });
    }

    const previewLines = updated
      .map(u => `• ${u.product} - $${Number(u.amount).toFixed(2)}/${u.unit}`)
      .join("\n");

    const failNote = failed.length
      ? `\n\n⚠️ Skipped ${failed.length}: _${failed.slice(0, 2).join(", ")}_`
      : "";

    await UserSession.findOneAndUpdate(
      { phone },
      {
        $set: {
          "tempData.pendingPriceUpdate": updated
        }
      },
      { upsert: true }
    );

    return sendButtons(from, {
      text:
`💰 *${isService ? "Rate" : "Price"} Preview* (${updated.length} items)

${previewLines}${failNote}

Save these ${isService ? "rates" : "prices"}?`,
      buttons: [
        { id: "sup_price_update_confirm", title: "✅ Save" },
        { id: "my_supplier_account", title: "🏪 My Account" }
      ]
    });
  }
}

if (!isMetaAction) {
  const sess = await UserSession.findOne({ phone });
  const browseMode =
    biz?.sessionData?.orderBrowseMode ??
    sess?.tempData?.orderBrowseMode;

  const supplierId =
    biz?.sessionData?.orderSupplierId ??
    sess?.tempData?.orderSupplierId;

  if (browseMode === "catalogue_search" && supplierId) {
    const supplier = await SupplierProfile.findById(supplierId).lean();
    if (!supplier) return sendSuppliersMenu(from);

    const searchTerm = text.trim();
    const cart = await getCurrentOrderCart({ biz, phone });

    if (!searchTerm) {
      return sendText(from, "❌ Type a product name to search.");
    }

    await persistOrderFlowState({
      biz,
      phone,
      patch: {
        orderBrowseMode: "catalogue",
        orderCatalogueSearch: searchTerm,
        orderCataloguePage: 0
      }
    });

    return _sendSupplierCatalogueBrowser(from, supplier, cart, {
      page: 0,
      searchTerm
    });
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
    { id: "find_supplier", title: "🔍 Browse & Shop" },
    { id: "my_orders", title: "📋 My Orders" },
    
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

  // Fetch supplier to check if delivery is required
  const _sess2 = await UserSession.findOne({ phone });
  const _sid2 = _sess2?.tempData?.orderSupplierId;
  const _sup2 = _sid2 ? await SupplierProfile.findById(_sid2).lean() : null;
  const isServiceSupplier = _sup2?.profileType === "service";
 const _needsAddress2 = (isServiceSupplier && _sup2?.travelAvailable) || (!isServiceSupplier && _sup2?.delivery?.available === true);

  const preview = parsedItems
    .map(i => `• ${i.product} x${i.quantity}${i.unitLabel && i.unitLabel !== "units" ? " " + i.unitLabel : ""}`)
    .join("\n");

  if (!_needsAddress2 && _sup2) {
    // Collection-only: submit the order immediately, no address needed
    await UserSession.findOneAndUpdate(
      { phone },
      {
        $set: { "tempData.orderItems": parsedItems },
        $unset: { "tempData.orderProduct": "", "tempData.orderQuantity": "" }
      }
    );

    let totalAmount = 0; let pricedCount = 0;
    const finalItems = parsedItems.filter(i => i.valid).map(entry => {
      const quantity = Number(entry.quantity) || 1;
      const matchedPrice = findMatchingSupplierPrice(_sup2, entry.product);
      let pricePerUnit = null, total = null, finalUnit = entry.unitLabel || "units";
      if (matchedPrice && typeof matchedPrice.amount === "number") {
        pricePerUnit = matchedPrice.amount;
        total = quantity * matchedPrice.amount;
        finalUnit = matchedPrice.unit || finalUnit;
        totalAmount += total; pricedCount++;
      }
      return { product: entry.product, quantity, unit: finalUnit, pricePerUnit, currency: "USD", total };
    });

    const order = await SupplierOrder.create({
      supplierId: _sup2._id, supplierPhone: _sup2.phone,
      buyerPhone: phone, items: finalItems, totalAmount, currency: "USD",
      delivery: { required: false, address: "Collection" }, status: "pending"
    });
    await notifySupplierNewOrder(_sup2.phone, order);

    await UserSession.findOneAndUpdate(
      { phone },
      { $unset: { "tempData.orderState": "", "tempData.orderSupplierId": "", "tempData.orderItems": "", "tempData.orderProduct": "", "tempData.orderQuantity": "" } }
    );

    const itemSummary = finalItems.map(i => `• ${i.product} x${i.quantity}`).join("\n");
    await sendText(from,
`✅ *Order sent to ${_sup2.businessName}!*

${itemSummary}
🏠 *Collection only* - contact the supplier to arrange pickup
${pricedCount > 0 ? `💵 Estimated total: $${totalAmount.toFixed(2)}\n` : ""}📞 Supplier: ${_sup2.phone}

${pricedCount === finalItems.length ? "All items were auto-priced. Supplier can confirm immediately. 🎉" : "Supplier will confirm pricing shortly. 🎉"}`);
    return sendButtons(from, {
      text: "What would you like to do next?",
      buttons: [
        { id: "find_supplier", title: "🔍 Browse & Shop" },
        { id: "my_orders", title: "📋 My Orders" },
        
      ]
    });
  }

  // Delivery/service supplier: ask for address
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

return sendText(from,
`${isServiceSupplier ? "📅" : "🛒"} *${isServiceSupplier ? "Booking Summary" : "Order Summary"}*

${preview}

*Now enter your ${isServiceSupplier ? "location or contact note" : "delivery address"}:*

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
    { id: "find_supplier", title: "🔍 Browse & Shop" },
    { id: "register_supplier", title: "📦 Become a Supplier" },
    
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
    { id: "find_supplier", title: "🔍 Browse & Shop" },
    { id: "register_supplier", title: "📦 Become a Supplier" },
    
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
    if (!biz) return sendMainMenu(from);
    // Handle "Pay Full Balance" shortcut button: payinv_full_{id}
    const isFullPay = a.startsWith("payinv_full_");
    const invoiceId = isFullPay
      ? a.replace("payinv_full_", "")
      : a.replace("payinv_", "");

    const invoice = await Invoice.findById(invoiceId);
    if (!invoice) return sendText(from, "Invoice not found.");

    if (isFullPay) {
      // Skip amount entry - go straight to method
      biz.sessionState = "payment_method";
      biz.sessionData = { invoiceId: invoice._id, amount: invoice.balance };
      await saveBizSafe(biz);
      return sendButtons(from, {
        text:
`💳 *${invoice.number}*
Paying full balance: *${formatMoney(invoice.balance, invoice.currency)}*

How was it paid?`,
        buttons: [
          { id: "pay_method_cash",    title: "💵 Cash" },
          { id: "pay_method_ecocash", title: "📱 EcoCash" },
          { id: "pay_method_bank",    title: "🏦 Bank" }
        ]
      });
    }

    // Normal flow - show balance and ask for amount with "Pay Full" shortcut
    biz.sessionState = "payment_amount";
    biz.sessionData = { invoiceId: invoice._id };
    await saveBizSafe(biz);

    return sendButtons(from, {
      text:
`💳 *${invoice.number}*
Total:   ${formatMoney(invoice.total, invoice.currency)}
Paid:    ${formatMoney(invoice.amountPaid, invoice.currency)}
Balance: *${formatMoney(invoice.balance, invoice.currency)}*

Type amount or tap Full:`,
      buttons: [
        { id: `payinv_full_${invoice._id}`, title: "✅ Pay Full Balance" },
        { id: ACTIONS.MAIN_MENU,            title: "❌ Cancel" }
      ]
    });
  }

  // ── Invoice confirm actions ────────────────────────────────────────────────

// ── Payment invoice list: prev / next / search ────────────────────────────
  if (a.startsWith("paylist_prev_") || a.startsWith("paylist_next_")) {
    if (!biz) return sendMainMenu(from);
    const raw       = a.replace("paylist_prev_", "").replace("paylist_next_", "");
    const parts     = raw.split("_");
    const branchRaw = parts[0] === "br0" ? null : parts[0];
    const curPage   = parseInt(parts[1]) || 0;
    const newPage   = a.startsWith("paylist_prev_") ? curPage - 1 : curPage + 1;
    await showUnpaidInvoices(from, branchRaw, Math.max(0, newPage));
    return;
  }

  if (a.startsWith("paylist_search_")) {
    if (!biz) return sendMainMenu(from);
    const branchRaw = a.replace("paylist_search_", "");
    biz.sessionState = "payment_invoice_search";
    biz.sessionData  = { invoiceSearchBranch: branchRaw === "br0" ? null : branchRaw };
    await saveBizSafe(biz);
    return sendButtons(from, {
      text: "🔍 *Search Invoices*\n\nType invoice number:\n_e.g. INV-000005_",
      buttons: [{ id: ACTIONS.PAYMENTS_MENU, title: "❌ Cancel" }]
    });
  }

  // ── Doc search result - triggered after user types search term ────────────
  if (biz?.sessionState === "sales_doc_search_ready") {
    const docType    = biz.sessionData?.docSearchType   || "invoice";
    const branchRaw  = biz.sessionData?.docSearchBranch;
    const search     = biz.sessionData?.docSearchTerm   || null;
    const branch     = branchRaw === undefined ? undefined : (branchRaw || null);
    biz.sessionState = "ready"; biz.sessionData = {};
    await saveBizSafe(biz);
    return showSalesDocs(from, docType, branch, 0, search);
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

if (a === "inv_item_catalogue" || a.startsWith("inv_cat_page_")) {
    if (!biz) return sendMainMenu(from);

    const query = { businessId: biz._id, isActive: true };
    let branchFilter = null;
    if (caller && ["clerk", "manager"].includes(caller.role) && caller.branchId) {
      branchFilter = caller.branchId;
    } else if (caller?.role === "owner" && biz.sessionData?.targetBranchId) {
      branchFilter = biz.sessionData.targetBranchId;
    }
    if (branchFilter) {
      query.$or = [
        { branchId: branchFilter },
        { branchId: null },
        { branchId: { $exists: false } }
      ];
    }

    const allProducts = await Product.find(query).sort({ name: 1 }).lean();

    if (!allProducts.length) {
      biz.sessionState = "creating_invoice_add_items";
      biz.sessionData.itemMode = "choose_catalogue_or_custom";
      await saveBizSafe(biz);
      return sendButtons(from, {
        text: "📦 No items in catalogue yet.\n\nWhat would you like to do?",
        buttons: [
          { id: "inv_add_new_product", title: "➕ Add new product" },
          { id: "inv_item_custom",     title: "✍️ Custom item" }
        ]
      });
    }

    const PAGE_SIZE = 20;
    const page = a.startsWith("inv_cat_page_") ? parseInt(a.replace("inv_cat_page_", ""), 10) || 0 : 0;
    const totalPages = Math.ceil(allProducts.length / PAGE_SIZE);
    const start = page * PAGE_SIZE;
    const visible = allProducts.slice(start, start + PAGE_SIZE);

    // Store full product list in session for quick-pick lookup by number
    biz.sessionState = "creating_invoice_pick_product";
    biz.sessionData.catalogueProducts = allProducts.map(p => ({
      _id: p._id.toString(),
      name: p.name,
      unitPrice: p.unitPrice
    }));
    biz.sessionData.cataloguePage = page;
    await saveBizSafe(biz);

    // Build numbered text list
    const numbered = visible
      .map((p, i) => `${start + i + 1}. *${p.name}* - ${formatMoney(p.unitPrice, biz.currency)}`)
      .join("\n");

    await sendText(from,
`📦 *Product Catalogue*
Page ${page + 1} of ${totalPages} · ${allProducts.length} item${allProducts.length === 1 ? "" : "s"}

${numbered}

─────────────────
*Quick-pick: type number × quantity*
_One item:_  3x2
_Multiple:_  3x2, 7x1, 12x5
_Add all prices automatically_`
    );

    // Navigation + action buttons
    const navBtns = [];
    if (page > 0)              navBtns.push({ id: `inv_cat_page_${page - 1}`, title: "⬅ Prev" });
    if (page < totalPages - 1) navBtns.push({ id: `inv_cat_page_${page + 1}`, title: "➡ Next" });
    navBtns.push({ id: "inv_item_custom", title: "✍️ Custom item" });

    return sendButtons(from, {
      text: "Pick items by number or tap an option:",
      buttons: navBtns.slice(0, 3)
    });
  }

if (a === "add_another_expense") {
    if (!biz) return sendMainMenu(from);
    biz.sessionState = "expense_smart_entry";
    biz.sessionData  = { targetBranchId: biz.sessionData?.targetBranchId, bulkExpenses: [] };
    await saveBizSafe(biz);
    return sendButtons(from, {
      text:
`💸 *Add More Expenses*

_fuel 30, lunch 15, zesa 50_

Or tap to pick a category:`,
      buttons: [
        { id: "exp_show_categories", title: "📂 Pick by Category" },
        { id: ACTIONS.MAIN_MENU,     title: "🏠 Done" }
      ]
    });
  }

// "Pick by Category" button from smart entry → show category list
  if (a === "exp_show_categories") {
    if (!biz) return sendMainMenu(from);
    biz.sessionState = ACTIONS.EXPENSE_CATEGORY;
    // preserve branch context
    biz.sessionData = {
      targetBranchId: biz.sessionData?.targetBranchId,
      bulkExpenses:   biz.sessionData?.bulkExpenses || []
    };
    await saveBizSafe(biz);
    return sendList(from, "📂 Select Category", [
      { id: "exp_cat_rent",        title: "🏢 Rent" },
      { id: "exp_cat_utilities",   title: "💡 Utilities" },
      { id: "exp_cat_transport",   title: "🚗 Transport & Fuel" },
      { id: "exp_cat_supplies",    title: "📦 Supplies & Stock" },
      { id: "exp_cat_salaries",    title: "👷 Salaries & Wages" },
      { id: "exp_cat_maintenance", title: "🔧 Maintenance" },
      { id: "exp_cat_other",       title: "📝 Other" }
    ]);
  }

  // ── Expense bulk: button taps route into continueTwilioFlow ──────────────
  if (
    a === "exp_bulk_confirm_yes" ||
    a === "exp_bulk_confirm_no"  ||
    a === "exp_bulk_keep_adding"
  ) {
    if (!biz) return sendMainMenu(from);
    // Pass the button ID as text so twilioStateBridge state handler picks it up
    const handled = await continueTwilioFlow({ from, text: a });
    if (handled) return;
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

    biz.sessionState = "expense_smart_entry";
    biz.sessionData  = {
      targetBranchId: branchId,
      bulkExpenses: []
    };

    // clear any stale marketplace search context
    delete biz.sessionData.supplierSearch;
    delete biz.sessionData.searchResults;
    delete biz.sessionData.searchPage;
    delete biz.sessionData.orderSupplierId;
    delete biz.sessionData.orderCart;
    delete biz.sessionData.orderItems;
    delete biz.sessionData.orderProduct;
    delete biz.sessionData.orderQuantity;
    delete biz.sessionData.orderIsService;
    delete biz.sessionData.orderBrowseMode;
    delete biz.sessionData.orderCataloguePage;
    delete biz.sessionData.orderCatalogueSearch;

    await saveBizSafe(biz);
    return sendButtons(from, {
      text:
`💸 *Record Expenses*

Type one or many - same format either way:

Single:  _fuel 30_
Many:  _fuel 30, lunch 15, zesa 50, rent 500_
With method:  _salary 850 bank, fuel 30 ecocash_

─────────────────
Type *list* to review  ·  *done* to save  ·  *cancel* to quit`,
      buttons: [
        { id: "exp_show_categories", title: "📂 Pick by Category" },
        { id: ACTIONS.MAIN_MENU,     title: "❌ Cancel" }
      ]
    });
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


  // ── Doc list: prev/next page navigation ───────────────────────────────────
if (a.startsWith("vdoc_prev_") || a.startsWith("vdoc_next_")) {
    if (!biz) return sendMainMenu(from);
    // format: vdoc_prev_inv_all_2_none_0
    const raw    = a.replace("vdoc_prev_", "").replace("vdoc_next_", "");
    const parts  = raw.split("_");
    const typeMap = { inv: "invoice", qt: "quote", rct: "receipt" };
    const docType    = typeMap[parts[0]] || "invoice";
    const branchRaw  = parts[1] === "all" ? null : parts[1];
    const curPage    = parseInt(parts[2]) || 0;
    const filterCode = parts[3] || "none";
    const searchRaw  = parts.slice(4).join("_");
    const dateFilter = filterCode === "none" ? null : filterCode;
    const search     = searchRaw === "0" ? null : decodeURIComponent(searchRaw);
    const newPage    = a.startsWith("vdoc_prev_") ? curPage - 1 : curPage + 1;
    return showSalesDocs(from, docType, branchRaw ?? undefined, Math.max(0, newPage), search, dateFilter);
  }

  // ── Doc list: search trigger ────────────────────────────────────────────────
// ── Filter by date - show date picker buttons ──────────────────────────────
  if (a.startsWith("vdoc_filter_")) {
    if (!biz) return sendMainMenu(from);
    const parts   = a.replace("vdoc_filter_", "").split("_");
    const typeMap = { inv: "invoice", qt: "quote", rct: "receipt" };
    const docType = typeMap[parts[0]] || "invoice";
    const branchCode = parts[1] || "all";

    // Store context for date selection
    biz.sessionState = "sales_doc_filter";
    biz.sessionData  = { docFilterType: docType, docFilterBranch: branchCode === "all" ? null : branchCode };
    await saveBizSafe(biz);

    const typeLabel = docType[0].toUpperCase() + docType.slice(1);
    return sendList(from, `📅 *Filter ${typeLabel}s*\n\nChoose a time period:`, [
      { id: `vdoc_date_${docType}_${branchCode}_this_month`, title: "📅 This Month" },
      { id: `vdoc_date_${docType}_${branchCode}_last_month`, title: "📅 Last Month" },
      { id: `vdoc_date_${docType}_${branchCode}_last_7`,     title: "📅 Last 7 Days" },
      { id: `vdoc_date_${docType}_${branchCode}_this_year`,  title: "📅 This Year" },
      { id: `vdoc_date_${docType}_${branchCode}_none`,       title: "📋 All Time" },
      { id: `vdoc_search_${docType}_${branchCode}`,         title: "🔍 Search Docs" }
    ]);
  }

  // ── Date filter selected ──────────────────────────────────────────────────
  if (a.startsWith("vdoc_date_")) {
    if (!biz) return sendMainMenu(from);
    const raw    = a.replace("vdoc_date_", "");
    // format: vdoc_date_invoice_all_this_month
    const parts  = raw.split("_");
    const typeMap = { invoice: "invoice", quote: "quote", receipt: "receipt" };
    const docType    = typeMap[parts[0]] || "invoice";
    const branchCode = parts[1] || "all";
    const filterKey  = parts.slice(2).join("_"); // this_month, last_month, etc
    const dateFilter = filterKey === "none" ? null : filterKey;
    const branchId   = branchCode === "all" ? null : branchCode;
    return showSalesDocs(from, docType, branchId ?? undefined, 0, null, dateFilter);
  }

  // ── Search by text ────────────────────────────────────────────────────────
  if (a.startsWith("vdoc_search_")) {
    if (!biz) return sendMainMenu(from);
    const parts   = a.replace("vdoc_search_", "").split("_");
    const typeMap = { inv: "invoice", qt: "quote", rct: "receipt",
                      invoice: "invoice", quote: "quote", receipt: "receipt" };
    const docType    = typeMap[parts[0]] || "invoice";
    const branchCode = parts[1] || "all";
    biz.sessionState = "sales_doc_search";
    biz.sessionData  = {
      docSearchType:   docType,
      docSearchBranch: branchCode === "all" ? null : branchCode
    };
    await saveBizSafe(biz);
    return sendButtons(from, {
      text: `🔍 *Search ${docType[0].toUpperCase() + docType.slice(1)}s*\n\nType client name or part of invoice number:\n_e.g.  John  or  INV-0003_`,
      buttons: [{ id: ACTIONS.SALES_MENU, title: "❌ Cancel" }]
    });
  }


  // ── Doc list: search result (triggered after user types search term) ───────
  if (biz?.sessionState === "sales_doc_search_ready") {
    const docType   = biz.sessionData?.docSearchType   || "invoice";
    const branchRaw = biz.sessionData?.docSearchBranch;
    const search    = biz.sessionData?.docSearchTerm   || null;
    const branch    = branchRaw === undefined ? undefined : (branchRaw || null);
    biz.sessionState = "ready"; biz.sessionData = {};
    await saveBizSafe(biz);
    return showSalesDocs(from, docType, branch, 0, search);
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
    if (caller?.role === "owner") return sendBranchSelectorExpense(from);
    biz.sessionState = "expense_smart_entry";
    biz.sessionData  = { bulkExpenses: [] };
    await saveBizSafe(biz);
    return sendButtons(from, {
      text:
`💸 *Record Expenses*

Single:  _fuel 30_
Many:  _fuel 30, lunch 15, zesa 50_
With method:  _salary 850 bank_

Type *done* to save`,
      buttons: [
        { id: "exp_show_categories", title: "📂 Pick by Category" },
        { id: ACTIONS.MAIN_MENU,     title: "❌ Cancel" }
      ]
    });
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
        { id: "add_another_product", title: "➕ Add Product" },
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

   if (!response.success || !response.pollUrl) {
  biz.sessionState = "subscription_enter_ecocash";
  biz.sessionData = { ...(biz.sessionData || {}), ecocashPhone };
  await saveBizSafe(biz);
  await sendText(from, "❌ Failed to start EcoCash payment.\n\nPlease enter your EcoCash number again.\nSend like: 0772123456\nOr type *same* to use this WhatsApp number.");
  return;
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

//const escapeWords = ["menu", "hi", "hello", "start", "cancel"];
const escapeWords = ["menu", "hi", "hie", "hey", "hello", "helo", "howzit", "help", "start", "cancel", "yo", "sup"];

  // Pass supplier registration states to the state bridge
const supplierStates = [
 "supplier_reg_name", "supplier_reg_area", "supplier_reg_address", "supplier_reg_products",
  "supplier_reg_contact_details", "supplier_reg_website", "supplier_reg_collar", "supplier_reg_subcat",
  "supplier_reg_prices", "supplier_update_prices",
  "supplier_edit_products", "supplier_edit_area",
  "supplier_reg_confirm", "supplier_reg_enter_ecocash",
  "supplier_reg_payment_pending", "supplier_search_city", "supplier_decline_reason",
  "supplier_reg_type",
  "supplier_reg_travel",
  "supplier_reg_city",
  "supplier_reg_category",
  "supplier_reg_delivery",
  "supplier_search_product",
  "supplier_order_product",
  "supplier_order_address",
  "supplier_order_enter_price",
  "supplier_order_confirm_price",
  "supplier_order_picking",
  "supplier_reg_biz_currency",
"supplier_select_listed_products",
  "supplier_add_listed_products",
  // ── School registration states (go through same biz session machine) ──────
  "supplier_reg_listing_type",
  "school_reg_name",
  "school_reg_city_text",
  "school_reg_suburb",
  "school_reg_address",
  "school_reg_fees",
  "school_reg_principal",
  "school_reg_email",
  "school_reg_enter_ecocash",
  "school_reg_payment_pending",
  "school_reg_choose_plan",
  "school_reg_confirm",
  "school_reg_type",
  "school_reg_curriculum",
  "school_reg_gender",
  "school_reg_boarding",
  "school_reg_facilities",
  "school_reg_extramural",
  "school_search_city",
  "school_search_results",
"school_admin_update_fees",
  "school_admin_awaiting_brochure",
  "school_parent_enquiry"
];
 
// ── School text-input states (free-text WhatsApp replies during school flow) ─
const schoolTextStates = [
  "school_reg_name",
  "school_reg_city_text",
  "school_reg_suburb",
  "school_reg_address",
  "school_reg_fees",
  "school_reg_principal",
  "school_reg_email",
  "school_reg_enter_ecocash",
  "school_reg_payment_pending"
];
 
// ── School admin text-input states ───────────────────────────────────────────
const schoolAdminStates = [
  "school_admin_update_fees",
  "school_admin_update_reg_link",
  "school_admin_update_email",
  "school_admin_update_website",
  "school_admin_awaiting_brochure",
  "school_parent_enquiry"
];

// ── Shortcode search for any user (runs BEFORE state machine) ─────────────
// supplier_search_city is excluded from the block - typed text in that state
// ── Shortcode search for any user (runs BEFORE state machine) ─────────────
// IMPORTANT:
// Business-tools free-text states must NEVER be intercepted here.
// They belong to continueTwilioFlow(...), not marketplace shortcode search.
const shortcodeBlockedStates = [
  ...supplierStates.filter(s =>
    s !== "supplier_search_city" &&
    s !== "supplier_order_product" &&
    s !== "supplier_order_enter_price"
  ),

 // Business tools text-entry states
  "expense_smart_entry",
  "expense_bulk_confirm",
  "bulk_expense_input",
  "payment_amount",
  "payment_method",
  "expense_amount",
  "expense_category",
  "cash_set_opening_balance",
  "cash_payout_amount",
  "cash_payout_reason",
  "sales_doc_search",
  "sales_doc_list",
  "sales_doc_filter",
  "client_statement_generate",

  // Invoice / quote / receipt text-entry states
  "creating_invoice_new_client",
  "creating_invoice_new_client_phone",
  "invoice_quick_add_product_name",
  "invoice_quick_add_product_price",
  "creating_invoice_add_items",
  "creating_invoice_qty",
  "creating_invoice_add_item_text",

  "quote_quick_add_product_name",
  "quote_quick_add_product_price",
  "receipt_quick_add_product_name",
  "receipt_quick_add_product_price",

  // Products & services text-entry states
  "product_add_name",
  "product_add_price",
  "product_edit_name",
  "product_edit_price",

  // Clients / branches / settings
  "settings_currency",
  "settings_terms",
  "settings_inv_prefix",
  "settings_qt_prefix",
  "settings_rcpt_prefix",
  "branch_add_name",
  "invite_user_phone",
  "add_client_name",
  "add_client_phone",

  // School parent enquiry text input
  "school_parent_enquiry",
  "school_admin_update_fees",
  "school_admin_update_reg_link",
  "school_admin_update_email",
  "school_admin_update_website",
  "school_admin_awaiting_brochure"
];

if (
  !isMetaAction &&
  biz &&
  !isGhostSupplierBiz &&
  text.trim().length > 2 &&
  !shortcodeBlockedStates.includes(biz.sessionState) &&
  !settingsStates.includes(biz.sessionState) &&
  !schoolAdminStates.includes(biz.sessionState) &&
  !schoolTextStates.includes(biz.sessionState)
) {


  console.log(`[HIT-BIZ-SHORTCODE] text="${text}" sessionState="${biz?.sessionState}"`);
  const shortcode = parseShortcodeSearch(text);
  console.log(`[TRACE-A] biz shortcode handler: text="${text}" sessionState="${biz?.sessionState}" shortcode=${JSON.stringify(shortcode)}`);
  if (shortcode) {
if (shortcode.city) {
  const locationLabel = shortcode.area
    ? `${shortcode.area}, ${shortcode.city}`
    : shortcode.city;

  biz.sessionData = {
    ...(biz.sessionData || {}),
    supplierSearch: { product: shortcode.product, city: shortcode.city }
  };

  await UserSession.findOneAndUpdate(
    { phone },
    {
      $set: {
        "tempData.supplierSearchProduct": shortcode.product,
        ...(shortcode.city ? { "tempData.lastSearchCity": shortcode.city } : {}),
        ...(shortcode.area ? { "tempData.lastSearchArea": shortcode.area } : {})
      }
    },
    { upsert: true }
  );

  // IMPORTANT:
  // For inline text like "find valve mbare", behave like city-picker flow.
  // Do NOT force suburb/area on offer search.
  console.log(
    `[TRACE-B] calling runSupplierOfferSearch city="${shortcode.city}" product="${shortcode.product}" area=NULL_FIRST_PASS originalArea="${shortcode.area}"`
  );

  let offerResults = await runSupplierOfferSearch({
    city: shortcode.city,
    product: shortcode.product,
    area: null
  });
  console.log(`[TRACE-B2] offerResults.length=${offerResults.length}`);

  // If city-level offer search returns nothing, retry across all cities,
  // but still do NOT force area here.
  if (!offerResults.length) {
    offerResults = await runSupplierOfferSearch({
      city: null,
      product: shortcode.product,
      area: null
    });
  }

  if (offerResults.length) {
    await UserSession.findOneAndUpdate(
      { phone },
      {
        $set: {
          "tempData.searchResults": offerResults,
          "tempData.searchPage": 0,
          "tempData.searchResultMode": "offers"
        }
      },
      { upsert: true }
    );

    biz.sessionData = {
      ...(biz.sessionData || {}),
      supplierSearch: {
        product: shortcode.product,
        city: shortcode.city,
        ...(shortcode.area ? { area: shortcode.area } : {})
      },
      searchResults: offerResults,
      searchPage: 0,
      searchResultMode: "offers"
    };
    await saveBizSafe(biz);

    const pageOffers = offerResults.slice(0, 9);
    const rows = formatSupplierOfferResults(pageOffers, shortcode.product);

    if (offerResults.length > 9) {
      rows.push({
        id: "sup_search_next_page",
        title: `➡ More results (${offerResults.length - 9} more)`
      });
    }

    return sendList(
      from,
      `🔍 *${shortcode.product}* in ${locationLabel} - ${offerResults.length} found`,
      rows
    );
  }

  // Offers exhausted - fall back to supplier-level results before giving up,
  // mirroring the no-biz and ghost-biz paths exactly.
  const supplierFallback = await runSupplierSearch({
    city: shortcode.city || null,
    product: shortcode.product,
    area: shortcode.area || null
  });

  if (supplierFallback.length) {
    biz.sessionData = {
      ...(biz.sessionData || {}),
      supplierSearch: { product: shortcode.product, city: shortcode.city },
      searchResults: supplierFallback,
      searchPage: 0,
      searchResultMode: "suppliers"
    };
    await saveBizSafe(biz);
    await UserSession.findOneAndUpdate(
      { phone },
      { $set: { "tempData.searchResults": supplierFallback, "tempData.searchPage": 0, "tempData.searchResultMode": "suppliers" } },
      { upsert: true }
    );
    const supplierRows = formatSupplierResults(supplierFallback.slice(0, 9), shortcode.city || shortcode.area || "", shortcode.product);
    if (supplierFallback.length > 9) {
      supplierRows.push({ id: "sup_search_next_page", title: `➡ More results (${supplierFallback.length - 9} more)` });
    }
    return sendList(from, `🔍 *${shortcode.product}* in ${locationLabel} - ${supplierFallback.length} found`, supplierRows);
  }
}
 // City was given but 0 results - show no-results message, NOT city picker
    if (shortcode.city) {
      biz.sessionData = { ...(biz.sessionData || {}), supplierSearch: { product: shortcode.product, city: shortcode.city } };
      await saveBizSafe(biz);
      return sendButtons(from, {
        text: `😕 No results for *${shortcode.product}* in *${shortcode.city}*.\n\nTry searching all of Zimbabwe?`,
        buttons: [
          { id: "sup_search_city_all", title: "📍 Search All Cities" },
          { id: "find_supplier",       title: "🔍 Search Again" }
        ]
      });
    }

    // No city at all - ask for it
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


if (!isMetaAction && biz && biz.sessionState && !escapeWords.includes(al) && !settingsStates.includes(biz.sessionState) && !schoolAdminStates.includes(biz.sessionState) && !schoolTextStates.includes(biz.sessionState)) {
    if (al === "cancel" && supplierStates.includes(biz.sessionState)) {
      biz.sessionState = "ready";
      biz.sessionData = {};
      await saveBizSafe(biz);
      await sendText(from, "❌ Registration cancelled. Sending you back to the main menu.");
      return sendMainMenu(from);
    }

    // ── If in supplier_search_city state and user types a shortcode, treat as new search ──
if (biz.sessionState === "supplier_search_city" && !isMetaAction && !schoolAdminStates.includes(biz.sessionState)) {

  console.log(`[HIT-SUPPLIER-SEARCH-CITY] text="${text}" sessionState="${biz.sessionState}"`);

  // ── Greeting while in city-picker → reset and show main menu ─────────────
  if (GREETING_WORDS.has(text.trim().toLowerCase())) {
    biz.sessionState = "ready";
    biz.sessionData  = { ...(biz.sessionData || {}), supplierSearch: {} };
    await saveBizSafe(biz);
    return sendMainMenu(from);
  }

  const shortcode = parseShortcodeSearch(text);
  console.log(`[TRACE-C] supplier_search_city handler: text="${text}" shortcode=${JSON.stringify(shortcode)}`);
  if (shortcode) {
    const cleanProduct = String(shortcode.product || "")
      .toLowerCase()
      .trim()
      .replace(/\s+/g, " ");

  if (shortcode.city || shortcode.area) {
    const locationLabel = shortcode.area
      ? `${shortcode.area}, ${shortcode.city}`
      : shortcode.city || "Zimbabwe";

    // IMPORTANT:
    // In supplier_search_city state, inline text like "find valve mbare"
    // must behave like the working city-picker flow.
    // Do NOT force suburb/area on offer search.
    console.log(
      `[TRACE-D] calling runSupplierOfferSearch city="${shortcode.city}" product="${cleanProduct}" area=NULL_FIRST_PASS originalArea="${shortcode.area}"`
    );

    let offerResults = await runSupplierOfferSearch({
      city: shortcode.city || null,
      product: cleanProduct,
      area: null
    });
    console.log(`[TRACE-D2] first attempt offerResults.length=${offerResults.length}`);

    // Retry across all cities, still without forcing area
    if (!offerResults.length) {
      offerResults = await runSupplierOfferSearch({
        city: null,
        product: cleanProduct,
        area: null
      });
      console.log(`[TRACE-D3] second attempt (no city) offerResults.length=${offerResults.length}`);
    }

    if (offerResults.length) {
      biz.sessionState = "ready";
      biz.sessionData = {
        ...(biz.sessionData || {}),
        supplierSearch: {
          product: cleanProduct,
          ...(shortcode.city ? { city: shortcode.city } : {}),
          ...(shortcode.area ? { area: shortcode.area } : {})
        },
        searchResults: offerResults,
        searchPage: 0,
        searchResultMode: "offers"
      };
      await saveBizSafe(biz);

      const rows = formatSupplierOfferResults(offerResults.slice(0, 9), cleanProduct);
      if (offerResults.length > 9) {
        rows.push({
          id: "sup_search_next_page",
          title: `➡ More results (${offerResults.length - 9} more)`
        });
      }

      return sendList(
        from,
        `🔍 *${cleanProduct}* in ${locationLabel} - ${offerResults.length} found`,
        rows
      );
    }

    // No offers found anywhere - show no-results message
    biz.sessionData = {
      ...(biz.sessionData || {}),
      supplierSearch: {
        product: cleanProduct,
        ...(shortcode.city ? { city: shortcode.city } : {}),
        ...(shortcode.area ? { area: shortcode.area } : {})
      }
    };
    await saveBizSafe(biz);

    return sendButtons(from, {
      text: `😕 No results for *${cleanProduct}*${shortcode.city ? ` in *${shortcode.city}*` : ""}.\n\nTry searching all of Zimbabwe?`,
      buttons: [
        { id: "sup_search_city_all", title: "📍 Search All Cities" },
        { id: "find_supplier", title: "🔍 Search Again" }
      ]
    });
  }

    biz.sessionData = {
      ...(biz.sessionData || {}),
      supplierSearch: { product: cleanProduct }
    };
    biz.sessionState = "supplier_search_city";
    await saveBizSafe(biz);

    return sendList(from, `🔍 Looking for: *${cleanProduct}*\n\nWhich city?`, [
      ...SUPPLIER_CITIES.map(c => ({ id: `sup_search_city_${c.toLowerCase()}`, title: c })),
      { id: "sup_search_city_all", title: "📍 All Cities" }
    ]);
  }

 const productQuery = text.trim().toLowerCase().replace(/\s+/g, " ");

  // Greetings/reset words while in search-city state → drop state, go to main menu
  if (GREETING_WORDS.has(productQuery)) {
    biz.sessionState = "ready";
    biz.sessionData  = { ...(biz.sessionData || {}), supplierSearch: {} };
    await saveBizSafe(biz);
    return sendMainMenu(from);
  }

  if (productQuery.length > 1) {
    biz.sessionData = {
      ...(biz.sessionData || {}),
      supplierSearch: { product: productQuery }
    };
    biz.sessionState = "supplier_search_city";
    await saveBizSafe(biz);

    return sendList(from, `🔍 Looking for: *${productQuery}*\n\nWhich city?`, [
      ...SUPPLIER_CITIES.map(c => ({ id: `sup_search_city_${c.toLowerCase()}`, title: c })),
      { id: "sup_search_city_all", title: "📍 All Cities" }
    ]);
  }
}

    if (schoolTextStates.includes(biz.sessionState)) {
      const handled = await handleSchoolRegistrationStates({
        state: biz.sessionState, from, text, biz, saveBiz: saveBizSafe
      });
      if (handled) return;
    }
 
    // ── School FAQ chatbot text states ──────────────────────────────────────
    if (biz.sessionState?.startsWith("sfaq_")) {
      const handled = await handleSchoolFAQState({
        state: biz.sessionState, from, text, biz, saveBiz: saveBizSafe.bind(null, biz)
      });
      if (handled) return;
    }

    // ── Seller chatbot text states ────────────────────────────────────────────
    if (biz.sessionState?.startsWith("sc_")) {
      const handled = await handleSellerChatState({
        state: biz.sessionState, from, text, biz, saveBiz: saveBizSafe
      });
      if (handled) return;
    }

    // ── School admin text-input states (e.g. fee updates) ────────────────────
    if (schoolAdminStates.includes(biz.sessionState)) {
      const handled = await handleSchoolAdminStates({
        state: biz.sessionState, from, text, biz, saveBiz: saveBizSafe
      });
      if (handled) return;
    }
 
    if (supplierStates.includes(biz.sessionState)) {
      const handled = await handleSupplierRegistrationStates({
        state: biz.sessionState, from, text, biz, saveBiz: saveBizSafe
      });
      if (handled) return;
    }
 
    // Only pass to Twilio for real businesses - ghost supplier biz returns "Access denied"
  
    // Business-tool text states are now handled earlier, before marketplace free-text search.
    // Keep only the ghost-supplier-biz bypass here.
    if (biz.name?.startsWith("pending_supplier_")) {
      // ── If ghost biz user is mid-order or mid-listed-selection, let handlers below process it ──
      if (
        biz.sessionState === "supplier_order_product" ||
        biz.sessionState === "supplier_order_address" ||
        biz.sessionState === "supplier_order_enter_price" ||
        biz.sessionState === "supplier_order_picking" ||
        biz.sessionState === "supplier_select_listed_products"
      ) {
        // Do nothing here - fall through to the state handlers below
     } else {
        // Ghost biz user typed something unrecognised - try as a search first
        const shortcode = parseShortcodeSearch(text);
        if (shortcode) {
          if (shortcode.city || shortcode.area) {
            const locationLabel = shortcode.area
              ? `${shortcode.area}, ${shortcode.city}`
              : shortcode.city || "Zimbabwe";

            // Offer-first: behave like city-picker flow, do NOT force area on first pass
            let offerResults = await runSupplierOfferSearch({
              city: shortcode.city || null,
              product: shortcode.product,
              area: null
            });

            // Retry across all cities if city-level found nothing
            if (!offerResults.length) {
              offerResults = await runSupplierOfferSearch({
                city: null,
                product: shortcode.product,
                area: null
              });
            }

        if (offerResults.length) {
              // Write to BOTH biz.sessionData AND UserSession.tempData so the
              // sup_search_next_page handler (which branches on biz presence) can
              // always find the full result set regardless of which branch it takes.
              biz.sessionData = {
                ...(biz.sessionData || {}),
                searchResults: offerResults,
                searchPage: 0,
                searchResultMode: "offers"
              };
              await saveBizSafe(biz);
              await UserSession.findOneAndUpdate(
                { phone },
                {
                  $set: {
                    "tempData.searchResults": offerResults,
                    "tempData.searchPage": 0,
                    "tempData.searchResultMode": "offers",
                    "tempData.supplierSearchProduct": shortcode.product,
                    ...(shortcode.city ? { "tempData.lastSearchCity": shortcode.city } : {}),
                    ...(shortcode.area ? { "tempData.lastSearchArea": shortcode.area } : {})
                  }
                },
                { upsert: true }
              );
              const pageOffers = offerResults.slice(0, 9);
              const rows = formatSupplierOfferResults(pageOffers, shortcode.product);
              if (offerResults.length > 9) {
                rows.push({ id: "sup_search_next_page", title: `➡ More results (${offerResults.length - 9} more)` });
              }
              return sendList(from, `🔍 *${shortcode.product}* in ${locationLabel} - ${offerResults.length} found`, rows);
            }

            // Offers exhausted - fall back to supplier-level results
            const results = await runSupplierSearch({ city: shortcode.city || null, product: shortcode.product, area: shortcode.area || null });
            if (results.length) {
              biz.sessionData = {
                ...(biz.sessionData || {}),
                searchResults: results,
                searchPage: 0,
                searchResultMode: "suppliers"
              };
              await saveBizSafe(biz);
              await UserSession.findOneAndUpdate(
                { phone },
                {
                  $set: {
                    "tempData.searchResults": results,
                    "tempData.searchPage": 0,
                    "tempData.searchResultMode": "suppliers"
                  }
                },
                { upsert: true }
              );
              const rows = formatSupplierResults(results.slice(0, 9), shortcode.city || shortcode.area || "", shortcode.product);
              if (results.length > 9) {
                rows.push({ id: "sup_search_next_page", title: `➡ More results (${results.length - 9} more)` });
              }
              return sendList(from, `🔍 *${shortcode.product}* in ${locationLabel} - ${results.length} found`, rows);
            }
            return sendButtons(from, {
              text: `😕 No results for *${shortcode.product}*${shortcode.city ? ` in *${shortcode.city}*` : ""}.\n\nTry a different city or search term.`,
              buttons: [
                { id: "find_supplier", title: "🔍 Search Again" },
                { id: "sup_search_city_all", title: "📍 Try All Cities" }
              ]
            });
          }

          // No city or area - store product and ask for city (no-location flow unchanged)
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
          text: `🔍 *Looking for something?*\n\nTry:\n_find cement_\n_find plumber harare_\n_find teacher_\n_find car hire -_\n\nOr type *menu* to see all options.`,
          buttons: [
            { id: "find_supplier", title: "🔍 Browse & Shop" },
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
    { id: "find_supplier", title: "🔍 Browse & Shop" },
    { id: "my_orders", title: "📋 My Orders" },
    
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

    const isManager = caller && ["owner", "manager"].includes(caller.role);
    const cur = doc.currency || biz.currency || "USD";

    // Build doc summary text
    const statusEmoji = doc.status === "paid" ? "✅" : doc.status === "partial" ? "⏳" : "🔴";
    const docText =
`📄 *${doc.number}*
Type: ${doc.type} | ${statusEmoji} ${doc.status}
Total: $${Number(doc.total || 0).toFixed(2)} ${cur}
Paid: $${Number(doc.amountPaid || 0).toFixed(2)} | Balance: $${Number(doc.balance || 0).toFixed(2)}`;

    // Max 3 buttons - priority: View PDF, Delete (managers only), Back
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

  // ── HANDLE SUPPLIER LISTED PRODUCT SELECTION ──
if (biz?.sessionState === "supplier_select_listed_products") {
  const supplier = await SupplierProfile.findOne({ phone });
  if (!supplier) {
    await sendText(from, "❌ Supplier profile not found.");
    return true;
  }

  const uploaded = (supplier.products || []).filter(p => p && p !== "pending_upload");

  const capMap = { basic: 20, pro: 60, featured: 150 };
  const cap =
    Number(biz?.sessionData?.listedSelectionCap) ||
    capMap[supplier.tier] ||
    20;

  const indexes = findSupplierItemIndexes(text, uploaded);

  if (!indexes.length) {
    await sendText(
      from,
      `❌ Invalid selection.\n\nReply with item numbers only.\nExample: *1,2,5*`
    );
    return true;
  }

  const uniqueIndexes = [...new Set(indexes)].slice(0, cap);
  const selected = uniqueIndexes.map(i => uploaded[i]).filter(Boolean);

  supplier.listedProducts = selected;
  await supplier.save();

  biz.sessionState = "ready";
  biz.sessionData = {};
  await saveBizSafe(biz);

  await sendText(
    from,
    `✅ *${selected.length} item${selected.length === 1 ? "" : "s"} listed live now.*`
  );

  return sendSupplierAccountMenu(from, supplier);
}

  // ── Welcome screen: Find Suppliers or register ────────────────────────────
if (a === "find_supplier") {
  // Clear previous search state in BOTH biz and UserSession
  if (biz) {
    biz.sessionData = {
      ...(biz.sessionData || {}),
      supplierSearch: {}
    };
    biz.sessionState = "supplier_search_product";
    await saveBizSafe(biz);
  }
  // Always clear UserSession - covers ghost-biz users who have biz but also buy
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
return sendText(from,
`🔍 *Find Suppliers on ZimQuote*

Type what you need. Add a suburb or city to narrow results.

*📦 Products:*
_find cement harare_, _find cooking oil bulawayo_, _find mealie meal borrowdale_, _find tyres avondale_, _find school uniforms glen view_, _find solar panels highlands_

*🧹 Cleaning Services:*
_find deep cleaning harare_, _find house cleaning borrowdale_, _find office cleaning harare_, _find industrial cleaning harare_, _find restaurant cleaning harare_, _find carpet cleaning highlands_, _find end of tenancy cleaning harare_

*🔧 Services:*
_find plumber highlands_, _find electrician borrowdale_, _find teacher harare_, _find tutor glen view_, _find painter avondale_, _find welder harare_, _find catering harare_, _find photographer bulawayo_, _find it support harare_

*🚗 Transport:*
_find car hire harare_, _find delivery bulawayo_, _find moving company harare_

Or pick a category 👇`,
  ).then(() => sendList(from, "📂 Choose how you want to buy:", [
    { id: "sup_search_type_product", title: "📦 Browse Products" },
    { id: "sup_search_type_service", title: "🧰 Browse Services" },
    { id: "sup_request_sellers", title: "⚡ Request Sellers" }
  ]));

}

if (a === "sup_search_type_product" || a === "sup_search_type_service") {
  const searchType = a === "sup_search_type_service" ? "service" : "product";

  // Save search type to session
  if (biz) {
    biz.sessionData = {
      ...(biz.sessionData || {}),
      supplierSearch: { ...(biz.sessionData?.supplierSearch || {}), type: searchType }
    };
    await saveBizSafe(biz);
  } else {
    await UserSession.findOneAndUpdate(
      { phone },
      { $set: { "tempData.supplierSearchType": searchType } },
      { upsert: true }
    );
  }

  // ── Services: show collar groups first (same as seller registration) ──
  // WhatsApp list limit is 10 rows - 21 service categories can't fit in one list.
  if (searchType === "service") {
    return sendList(from, "🔧 What type of service are you looking for?", [
      { id: "sup_search_collar_white_collar", title: "💼 Professional" },
      { id: "sup_search_collar_trade",        title: "🔧 Trade & Artisan" },
      { id: "sup_search_collar_blue_collar",  title: "🧹 General Services" },
      { id: "sup_search_all",                 title: "🔍 Search Services" },
      { id: "find_supplier",                  title: "⬅ Back" }
    ]);
  }

  // ── Products: show first 8 categories + overflow ──
  const filteredCategories = getSupplierCategoriesForType(searchType);
  const categoryRows = [
    ...filteredCategories.slice(0, 8).map(c => ({
      id: `sup_search_cat_${c.id}`,
      title: c.label
    })),
    { id: "sup_search_all", title: "🔍 Search Products" },
    ...(filteredCategories.length > 8
      ? [{ id: "sup_search_more_categories", title: "➕ More Categories" }]
      : [])
  ];

  return sendList(from, "📦 Choose a product category", categoryRows);
}



// ── NEW: Service collar group selected by buyer ───────────────────────────────
// Mirrors the seller registration collar flow - shows only the categories
// ── NEW: Service collar group selected by buyer ───────────────────────────────
// Shows only service categories in the chosen collar group
// WhatsApp list max is 10 rows, so reserve space for More/Back when needed
if (a.startsWith("sup_search_collar_")) {
  const collarKey = a.replace("sup_search_collar_", "");
  const validCollars = ["white_collar", "trade", "blue_collar"];
  if (!validCollars.includes(collarKey)) return startSupplierSearch(from, biz, saveBizSafe);

  const collarLabels = {
    white_collar: "💼 Professional Services",
    trade:        "🔧 Trade & Artisan",
    blue_collar:  "🧹 General Services"
  };

  const collarCategories = SUPPLIER_CATEGORIES.filter(
    c => c.types.includes("service") && c.collar === collarKey
  );

  const hasMore = collarCategories.length > 8;

  // If there is a More button, only show 8 categories here:
  // 8 categories + More + Back = 10 rows max
  // If there is no More button, show up to 9 categories + Back = 10 rows max
  const firstBatch = hasMore
    ? collarCategories.slice(0, 8)
    : collarCategories.slice(0, 9);

  const rows = [
    ...firstBatch.map(c => ({ id: `sup_search_cat_${c.id}`, title: c.label })),
    ...(hasMore ? [{ id: `sup_search_collar_more_${collarKey}`, title: "➕ More" }] : []),
    { id: "sup_search_type_service", title: "⬅ Back" }
  ];

  return sendList(from, collarLabels[collarKey] || "🔧 Choose a category", rows);
}

// ── NEW: Overflow page for a collar group ─────────────────────────────────────
if (a.startsWith("sup_search_collar_more_")) {
  const collarKey = a.replace("sup_search_collar_more_", "");

  const collarCategories = SUPPLIER_CATEGORIES.filter(
    c => c.types.includes("service") && c.collar === collarKey
  );

  const rows = [
    ...collarCategories.slice(8, 17).map(c => ({
      id: `sup_search_cat_${c.id}`,
      title: c.label
    })),
    { id: `sup_search_collar_${collarKey}`, title: "⬅ Back" }
  ];

  return sendList(from, "🔧 More categories", rows);
}




if (a === "sup_search_more_categories") {
  // This handler is only reached from the product category list (services use collar flow)
  let searchType = biz?.sessionData?.supplierSearch?.type || null;
  if (!searchType) {
    const sess = await UserSession.findOne({ phone });
    searchType = sess?.tempData?.supplierSearchType || "product";
  }

  // If somehow service reaches here, redirect to collar picker
  if (searchType === "service") {
    return sendList(from, "🔧 What type of service are you looking for?", [
      { id: "sup_search_collar_white_collar", title: "💼 Professional" },
      { id: "sup_search_collar_trade",        title: "🔧 Trade & Artisan" },
      { id: "sup_search_collar_blue_collar",  title: "🧹 General Services" },
      { id: "sup_search_all",                 title: "🔍 Search Services" },
      { id: "find_supplier",                  title: "⬅ Back" }
    ]);
  }

  const filteredCategories = getSupplierCategoriesForType(searchType);
  // WhatsApp max 10 rows - products overflow: items 9–17, capped at 9 + Back
  const overflowRows = filteredCategories.slice(9, 18).map(c => ({
    id: `sup_search_cat_${c.id}`,
    title: c.label
  }));

  return sendList(from, "📦 More Product Categories", [
    ...overflowRows,
    { id: "sup_search_type_product", title: "⬅ Back" }
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
  isSupplier: false,
  sessionState: "supplier_reg_listing_type",
  sessionData: { supplierReg: {} },
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

// ── Main Menu back button - always goes to start menu ────────────────────
if (a === "main_menu_back") {
  return sendMainMenu(from);
}
 
// ── Handle sfaq_ FAQ text states for users who may not have a biz record ────────
// This must run BEFORE supplier registration guards that would short-circuit
if (isMetaAction && a.startsWith("sfaq_")) {
  const handled = await handleSchoolFAQAction({ from, action: a, biz, saveBiz: saveBizSafe.bind(null, biz) });
  if (handled) return;
}

// ═══════════════════════════════════════════════════════════════════════════════
// 🏫 SCHOOLS - Action handlers
// ═══════════════════════════════════════════════════════════════════════════════
 
// ── Parent taps "🏫 Find a School" ───────────────────────────────────────────
if (a === "find_school") {
  return startSchoolSearch(from, biz, saveBizSafe.bind(null, biz));
}
 

// ── School admin: facility toggle & paging (must come BEFORE parent search block)
if (
  a === "school_admin_manage_facilities" ||
  a.startsWith("school_fac_toggle_") ||
  a.startsWith("school_fac_page_")
) {
  const handled = await handleSchoolSearchActions({
    action: a,
    from,
    biz,
    saveBiz: saveBizSafe.bind(null, biz)
  });
  if (handled) return;
}
// ── Parent school search funnel steps (city → type → fees → facility → results)
if (
  a.startsWith("school_search_city_") ||
  a === "school_search_city_more" ||
  a.startsWith("school_search_type_") ||
  a.startsWith("school_search_fees_") ||
  a.startsWith("school_search_fac_") ||
  a.startsWith("school_search_page_") ||
  a === "school_search_refine"
) {
  if (biz) {
    biz.sessionData = biz.sessionData || {};
    biz.sessionData.schoolSearch = biz.sessionData.schoolSearch || {};
  }
  const handled = await handleSchoolSearchActions({
    action: a, from, biz, saveBiz: saveBizSafe.bind(null, biz)
  });
  if (handled) return;
}
 
// ── Parent taps a school card (view detail / download / apply / contact) ─────
if (
  a.startsWith("school_view_") ||
  a.startsWith("school_dl_profile_") ||
  a.startsWith("school_apply_") ||
  a.startsWith("school_enquiry_")
) {
  const handled = await handleSchoolSearchActions({
    action: a, from, biz, saveBiz: saveBizSafe.bind(null, biz)
  });
  if (handled) return;
}
 
// ── School admin actions (toggle admissions, update fees) ─────────────────────
if (a === "school_toggle_admissions" || a === "school_update_fees") {
  const handled = await handleSchoolSearchActions({
    action: a, from, biz, saveBiz: saveBizSafe.bind(null, biz)
  });
  if (handled) return;
}
 
// ── ZQ deep-link intercept (ZQ:SCHOOL:id and ZQ:SUPPLIER:id) ────────────────
if (!isMetaAction && /^ZQ:(SCHOOL|SUPPLIER):/i.test(text)) {
  const _handled = await handleZqDeepLink({ from, text, biz, saveBiz: saveBizSafe.bind(null, biz) });
  if (_handled) return;
}

// ── ZQ slug shortcode "zq huxton-academy" ────────────────────────────────────
if (!isMetaAction && /^zq /i.test(text) && text.trim().length > 4) {
  const _handled = await handleSchoolSlugSearch({ from, text, biz, saveBiz: saveBizSafe.bind(null, biz) });
  if (_handled) return;
}

// ── School FAQ chatbot (sfaq_ actions) ───────────────────────────────────────
if (a.startsWith("sfaq_")) {
  const handled = await handleSchoolFAQAction({ from, action: a, biz, saveBiz: saveBizSafe.bind(null, biz) });
  if (handled) return;
}

// ── Seller chatbot (sc_ actions) ─────────────────────────────────────────────
if (a.startsWith("sc_")) {
  const handled = await handleSellerChatAction({ from, action: a, biz, saveBiz: saveBizSafe.bind(null, biz) });
  if (handled) return;
}

// ── Smart Card / ZQ Link admin actions ───────────────────────────────────────
if (a === "school_get_zq_link" || a === "school_share_link_wa" ||
    a === "school_smart_card_menu" || a === "school_my_leads" ||
    a.startsWith("school_sc_src_") || a.startsWith("school_followup_") ||
    a.startsWith("school_leads_page_")) {
  const handled = await handleSchoolSearchActions({ action: a, from, biz, saveBiz: saveBizSafe.bind(null, biz) });
  if (handled) return;
}

// ── School registration entry (tapped from main menu or account) ──────────────
if (a === "school_register") {
  return startSchoolRegistration(from, biz);
}
 
// ── School account dashboard (for registered school admins) ──────────────────
if (a === "school_account") {
  const schoolPhone = from.replace(/\D+/g, "");
  const school = await SchoolProfile.findOne({ phone: schoolPhone });
  const { sendSchoolAccountMenu } = await import("./metaMenus.js");
  return sendSchoolAccountMenu(from, school);
}

// ── School profile summary ────────────────────────────────────────────────────
if (a === "school_my_profile") {
  const school = await SchoolProfile.findOne({ phone });
  if (!school) return sendMainMenu(from);
  const { SCHOOL_FACILITIES, SCHOOL_EXTRAMURALACTIVITIES } = await import("./schoolPlans.js");
 const typeLabels    = { ecd: "ECD / Preschool Only", ecd_primary: "ECD + Primary", primary: "Primary (Grade 1–7)", secondary: "Secondary (Form 1–6)", combined: "Combined (ECD–Form 6)" };
  const genderLabels  = { mixed: "Mixed (Co-ed)", boys: "Boys Only", girls: "Girls Only" };
  const boardingLabels= { day: "Day School", boarding: "Boarding", both: "Day & Boarding" };
  const curricText    = (school.curriculum || []).map(c => c.toUpperCase()).join(" + ") || "Not set";
  const facList       = (school.facilities || []).map(id => SCHOOL_FACILITIES.find(f => f.id === id)?.label || id).join("\n  ") || "None added";
  const extList       = (school.extramuralActivities || []).slice(0, 8).map(id => SCHOOL_EXTRAMURALACTIVITIES.find(e => e.id === id)?.label || id).join(", ") || "None added";
  const feeLine       = school.fees?.term1 ? `$${school.fees.term1} / $${school.fees.term2} / $${school.fees.term3} per term (USD)` : "Not set";
const profileMsg = [
    `🏫 *${school.schoolName}*${school.verified ? " ✅" : ""}`,
    `📍 ${school.suburb || ""}, ${school.city}${school.address ? "\n🏠 " + school.address : ""}`,
    school.principalName ? `👤 Principal: ${school.principalName}` : "",
    `📧 ${school.email || "No email set"}`,
    `🌐 ${school.website || "No website set"}`,
    "",
    `📗 *Type:* ${typeLabels[school.type] || school.type}`,
    `📚 *Curriculum:* ${curricText}`,
    `👫 *Gender:* ${genderLabels[school.gender] || school.gender}`,
    `🏠 *Boarding:* ${boardingLabels[school.boarding] || school.boarding}`,
    `📐 *Grades:* ${school.grades?.from || "ECD A"} – ${school.grades?.to || "Form 6"}`,
    "",
    `💵 *Fees:* ${feeLine}`,
    "",
    `🏊 *Facilities (${(school.facilities || []).length}):*`,
    `  ${facList}`,
    "",
    `🏃 *Extramural:* ${extList}`,
    "",
    `📝 *Admissions:* ${school.admissionsOpen ? "🟢 Currently OPEN" : "🔴 Currently CLOSED"}`,
    `🔗 *Apply link:* ${school.registrationLink || "Not set"}`
  ].filter(l => l !== null).join("\n");
  await sendText(from, profileMsg);
  const { sendSchoolAccountMenu } = await import("./metaMenus.js");
  return sendSchoolAccountMenu(from, school);
}

// ── School facilities manager ─────────────────────────────────────────────────
if (a === "school_my_facilities") {
  const school = await SchoolProfile.findOne({ phone });
  if (!school) return sendMainMenu(from);
  const { SCHOOL_FACILITIES } = await import("./schoolPlans.js");
  const selected = (school.facilities || []).map(id => SCHOOL_FACILITIES.find(f => f.id === id)?.label || id).join("\n") || "None selected yet";
  const FAC_PAGE_SIZE = 7;
  const facRows = SCHOOL_FACILITIES.slice(0, FAC_PAGE_SIZE).map(f => ({
    id:    `school_fac_toggle_${f.id}`,
    title: (school.facilities || []).includes(f.id) ? `✅ ${f.label}` : f.label
  }));
  facRows.push({ id: "school_fac_page_1", title: "➡ More Facilities" });
  facRows.push({ id: "school_account",    title: "💾 Done" });
  await sendText(from, `🏊 *Your Current Facilities:*\n\n${selected}\n\nTap to add or remove:`);
  return sendList(from, "🏊 *Manage Facilities* - tap to toggle:", facRows);
}

// ── Facility toggle (school admin toggling their own facilities) ───────────────
if (a.startsWith("school_fac_toggle_")) {
  const facId = a.replace("school_fac_toggle_", "");
  const school = await SchoolProfile.findOne({ phone });
  if (!school) return sendMainMenu(from);
  school.facilities = school.facilities || [];
  if (school.facilities.includes(facId)) {
    school.facilities = school.facilities.filter(f => f !== facId);
  } else {
    school.facilities.push(facId);
  }
  await school.save();
  const { SCHOOL_FACILITIES } = await import("./schoolPlans.js");
  const FAC_PAGE_SIZE = 7;
  const facPage = Number(biz?.sessionData?.schoolFacPage || 0);
  const facRows = SCHOOL_FACILITIES.slice(facPage * FAC_PAGE_SIZE, (facPage + 1) * FAC_PAGE_SIZE).map(f => ({
    id:    `school_fac_toggle_${f.id}`,
    title: school.facilities.includes(f.id) ? `✅ ${f.label}` : f.label
  }));
  const hasMore = (facPage + 1) * FAC_PAGE_SIZE < SCHOOL_FACILITIES.length;
  if (facPage > 0) facRows.push({ id: `school_fac_page_${facPage - 1}`, title: "⬅ Previous" });
  if (hasMore)     facRows.push({ id: `school_fac_page_${facPage + 1}`, title: "➡ More" });
  facRows.push({ id: "school_account", title: "💾 Done" });
  return sendList(from, `🏊 *${school.facilities.length} selected* - tap to toggle:`, facRows);
}

// ── Facility page navigation (school admin) ────────────────────────────────────
if (a.startsWith("school_fac_page_")) {
  const newPage = parseInt(a.replace("school_fac_page_", ""), 10) || 0;
  if (biz) { biz.sessionData = { ...(biz.sessionData || {}), schoolFacPage: newPage }; await saveBizSafe(biz); }
  const school = await SchoolProfile.findOne({ phone });
  if (!school) return sendMainMenu(from);
  const { SCHOOL_FACILITIES } = await import("./schoolPlans.js");
  const FAC_PAGE_SIZE = 7;
  const facRows = SCHOOL_FACILITIES.slice(newPage * FAC_PAGE_SIZE, (newPage + 1) * FAC_PAGE_SIZE).map(f => ({
    id:    `school_fac_toggle_${f.id}`,
    title: school.facilities.includes(f.id) ? `✅ ${f.label}` : f.label
  }));
  const hasMore = (newPage + 1) * FAC_PAGE_SIZE < SCHOOL_FACILITIES.length;
  if (newPage > 0) facRows.push({ id: `school_fac_page_${newPage - 1}`, title: "⬅ Previous" });
  if (hasMore)     facRows.push({ id: `school_fac_page_${newPage + 1}`, title: "➡ More" });
  facRows.push({ id: "school_account", title: "💾 Done" });
  return sendList(from, `🏊 *Facilities (page ${newPage + 1})* - ${school.facilities.length} selected:`, facRows);
}

// ── Update fees ────────────────────────────────────────────────────────────────
if (a === "school_my_fees") {
  if (biz) { biz.sessionState = "school_admin_update_fees"; await saveBizSafe(biz); }
  return sendText(from,
`💵 *Update School Fees*

Enter your fees per term in USD as: *term1, term2, term3*
Example: *900, 900, 850*

Or one amount if all terms are equal: *900*`
  );
}

// ── Reviews summary ───────────────────────────────────────────────────────────
if (a === "school_my_reviews") {
  const school = await SchoolProfile.findOne({ phone });
  if (!school) return sendMainMenu(from);
  const { sendSchoolAccountMenu } = await import("./metaMenus.js");
  if (!school.reviewCount) {
    await sendText(from,
`⭐ *My Reviews*

No reviews yet.

Once parents interact with your listing and submit ratings, they will appear here.

💡 Tip: Make sure your admissions are open and your profile is complete - parents are more likely to rate schools they engaged with.`
    );
    return sendSchoolAccountMenu(from, school);
  }
  await sendText(from,
`⭐ *My Reviews*

Rating: ${school.rating.toFixed(1)} / 5
Total reviews: ${school.reviewCount}

${school.verified ? "🏅 Your school is Verified - this builds parent trust." : "💡 Tip: A verified badge from ZimQuote boosts parent confidence. Contact support to apply."}`
  );
  return sendSchoolAccountMenu(from, school);
}

// ── Inquiries summary ─────────────────────────────────────────────────────────
if (a === "school_my_inquiries") {
  const school = await SchoolProfile.findOne({ phone });
  if (!school) return sendMainMenu(from);
  const { sendSchoolAccountMenu } = await import("./metaMenus.js");
  await sendText(from,
`📬 *Parent Inquiries*

Total inquiries received: *${school.inquiries || 0}*
Profile views this month: *${school.monthlyViews || 0}*

Every time a parent taps "Contact School", "Apply Online", or "Download Profile" on your listing, it counts as an inquiry.

💡 *Tips to get more inquiries:*
- Keep admissions marked as 🟢 Open when accepting
- Add your online application link so parents can apply instantly
- Complete your facilities list - parents filter by swimming pool, lab, etc.
- Ask parents to rate your school after interactions`
  );
  return sendSchoolAccountMenu(from, school);
}

// ── More options menu ─────────────────────────────────────────────────────────
if (a === "school_more_options") {
  const school = await SchoolProfile.findOne({ phone });
  if (!school) return sendMainMenu(from);
  const { sendSchoolMoreOptionsMenu } = await import("./metaMenus.js");
  return sendSchoolMoreOptionsMenu(from, school);
}

// ── Update online application link ────────────────────────────────────────────
if (a === "school_update_reg_link") {
  const school = await SchoolProfile.findOne({ phone });
  if (biz) { biz.sessionState = "school_admin_update_reg_link"; await saveBizSafe(biz); }
  const currentLink = school?.registrationLink
    ? `\n\n_Current link:_ ${school.registrationLink}\n\nSend a new link to replace it, or type *cancel* to keep the current one.`
    : "";
  return sendText(from,
`🔗 *Online Registration Form Link*

Enter the URL of your school's online application form.${currentLink}

_Accepted formats:_
- Google Form: _https://forms.gle/abc123_
- School website: _https://stdavids.ac.zw/apply_
- Any form builder link

Parents tap "📝 Apply Online" and are sent directly to this link.

Type *cancel* to go back.`
  );
}

// ── Update email ──────────────────────────────────────────────────────────────
if (a === "school_update_email") {
  if (biz) { biz.sessionState = "school_admin_update_email"; await saveBizSafe(biz); }
  return sendText(from, "📧 *Update Email*\n\nEnter your school's email address:\n\n_e.g. admin@stjohns.ac.zw_");
}

// ── Update website ────────────────────────────────────────────────────────────
if (a === "school_update_website") {
  if (biz) { biz.sessionState = "school_admin_update_website"; await saveBizSafe(biz); }
  return sendText(from, "🌐 *Update Website*\n\nEnter your school's website:\n\n_e.g. www.stjohns.ac.zw_");
}
 

// ── Upload school brochure / prospectus ───────────────────────────────────────
if (a === "school_upload_brochure") {
  const school = await SchoolProfile.findOne({ phone });
  if (!school) return sendMainMenu(from);
  if (biz) { biz.sessionState = "school_admin_awaiting_brochure"; await saveBizSafe(biz); }
  const currentStatus = school.profilePdfUrl
    ? `✅ *You already have a brochure uploaded.*\n\nSend a new PDF to replace it, or type *cancel* to keep the current one.`
    : `📄 *Upload Your School Brochure*\n\nSend your school prospectus or brochure as a *PDF file*.\n\nParents will be able to download it when they find your school.\n\nType *cancel* to go back.`;
  return sendText(from, currentStatus);
}
// ── School plan selection / activation payment ────────────────────────────────
if (a === "school_pay_plan") {
  const schoolPhone = from.replace(/\D+/g, "");
  const school = await SchoolProfile.findOne({ phone: schoolPhone });
  if (!school) return startSchoolRegistration(from, biz);
  return sendList(from,
    "💳 *Choose Your Plan*\n\nAll plans include:\n✅ Listed in parent search\n✅ Downloadable school profile PDF\n✅ Online application link\n✅ Parent inquiry alerts on WhatsApp",
    [
      { id: "school_plan_basic_monthly",    title: "✅ Basic - $15/month",    description: "Listed in search + profile PDF + application link" },
      { id: "school_plan_basic_annual",     title: "✅ Basic - $150/year",    description: "Save $30 vs monthly" },
      { id: "school_plan_featured_monthly", title: "🔥 Featured $35/mo", description: "Top of results + verified badge + analytics" },
      { id: "school_plan_featured_annual",  title: "🔥 Featured $350/yr", description: "Save $70 vs monthly" }
    ]
  );
}
 
// ── School registration button taps (multi-select steps, confirm, plan pick) ──
// ── School registration + school admin actions (buttons/lists, incl. plan pick) ──
if (
  a.startsWith("school_reg_type_") ||
  a.startsWith("school_reg_city_") ||
  a.startsWith("school_reg_cur_") ||
  a.startsWith("school_reg_gender_") ||
  a.startsWith("school_reg_boarding_") ||
  a.startsWith("school_reg_fac_") ||
  a.startsWith("school_reg_ext_") ||
  a === "school_reg_city_more" ||
  a.startsWith("school_plan_") ||
  a === "school_reg_address_skip" ||
  a === "school_reg_principal_skip" ||
  a === "school_reg_email_skip" ||
  a === "school_reg_cur_done" ||
  a === "school_reg_fac_done" ||
  a === "school_reg_ext_done" ||
  a === "school_reg_city_other" ||
  a === "school_reg_confirm_yes" ||
  a === "school_reg_confirm_no" ||

  // ── school admin actions ───────────────────────────────────────────────
  a === "school_admin_manage_facilities" ||
  a === "school_admin_manage_extramural" ||
  a === "school_admin_edit_fees" ||
  a === "school_admin_edit_reg_link" ||
  a === "school_admin_edit_email" ||
  a === "school_admin_edit_website" ||
  a === "school_admin_upload_brochure" ||
  a.startsWith("school_fac_page_") ||
  a.startsWith("school_fac_toggle_") ||
  a.startsWith("school_ext_page_") ||
  a.startsWith("school_ext_toggle_")
) {
  if (!biz) {
    await sendText(from, "❌ Session expired. Type *menu* to start again.");
    return;
  }

  // school registration actions
  if (
    a.startsWith("school_reg_") ||
    a.startsWith("school_plan_")
  ) {
    const handled = await handleSchoolRegistrationActions({
      action: a, from, biz, saveBiz: saveBizSafe.bind(null, biz)
    });
    if (handled) return;
  }

  // school admin actions
if (
    a === "school_admin_manage_facilities" ||
    a.startsWith("school_fac_page_") ||
    a.startsWith("school_fac_toggle_")
  ) {
    const handled = await handleSchoolSearchActions({
      action: a,
      from,
      biz,
      saveBiz: saveBizSafe.bind(null, biz)   // ← FIXED
    });
    if (handled) return;
  }
  // other school admin actions
  if (
    a === "school_admin_manage_extramural" ||
    a === "school_admin_edit_fees" ||
    a === "school_admin_edit_reg_link" ||
    a === "school_admin_edit_email" ||
    a === "school_admin_edit_website" ||
    a === "school_admin_upload_brochure" ||
    a.startsWith("school_ext_page_") ||
    a.startsWith("school_ext_toggle_")
  ) {
    const handled = await handleSchoolAdminStates({
      state: biz.sessionState,
      from,
      text: "",
      action: a,
      biz,
      saveBiz: saveBizSafe
    });
    if (handled) return;
  }
}

if (a === "my_supplier_account") {
  // Smart router: one button, correct destination based on account state
  const supplier = await SupplierProfile.findOne({ phone });

  if (!supplier) {
    // No supplier profile at all → send to registration
    return startSupplierRegistration(from, biz);
  }

  if (!supplier.active) {
    const isComplete = Boolean(
      supplier.businessName &&
      supplier.products?.length > 0
    );
    if (!isComplete) {
      await sendText(from,
`⚠️ *Your registration is incomplete.*\n\nLet's finish setting up your listing first.`
      );
      return startSupplierRegistration(from, biz);
    }
    await sendText(from,
`🔒 *Listing not yet active.*\n\nYour profile is saved but buyers cannot find you yet. Choose a plan to go live and unlock invoicing, quotes and more.`
    );
    return sendSupplierUpgradeMenu(from, supplier.tier);
  }

  return sendSupplierAccountMenu(from, supplier);
}

// ── Business tools menu (for active suppliers wanting invoicing etc.) ────
// ── Business tools menu (for active suppliers wanting invoicing etc.) ────
if (a === "biz_tools_menu") {
  if (!biz) {
    await sendText(from, "❌ No business account found. Please register first.");
    return sendMainMenu(from);
  }
  const { sendBusinessToolsMenu } = await import("./metaMenus.js");
  return sendBusinessToolsMenu(from, biz);
}


if (a === "sup_more_options") {
  const supplier = await SupplierProfile.findOne({ phone });
  return sendSupplierMoreOptionsMenu(from, supplier);
}


if (a === "sup_view_listed_products") {
  const supplier = await SupplierProfile.findOne({ phone });
  if (!supplier) return sendSuppliersMenu(from);

  const isService = supplier.profileType === "service";
  const listed = (supplier.listedProducts || []).filter(Boolean);

  if (!listed.length) {
    return sendButtons(from, {
      text: `📋 No listed ${isService ? "services" : "products"} yet.`,
      buttons: [
        { id: "sup_manage_listed_products", title: "⬅ Back" }
      ]
    });
  }

  await sendSupplierItemsInChunks(
    from,
    listed,
    `📋 Current Listed ${isService ? "Services" : "Products"}`
  );

  return sendButtons(from, {
    text: "What would you like to do next?",
    buttons: [
      { id: "sup_add_listed_products", title: "➕ Add More" },
      { id: "sup_remove_listed_products", title: "🗑 Remove" },
      { id: "sup_replace_listed_products", title: "🔄 Replace" }
    ]
  });
}



if (a === "sup_add_listed_products") {
  const supplier = await SupplierProfile.findOne({ phone });
  if (!supplier) return sendSuppliersMenu(from);

  const capMap = { basic: 20, pro: 60, featured: 150 };
  const cap = capMap[supplier.tier] || 20;
  const listed = supplier.listedProducts || [];
  const uploaded = (supplier.products || []).filter(p => p && p !== "pending_upload");

  const available = uploaded.filter(p =>
    !listed.some(lp => normalizeProductName(lp) === normalizeProductName(p))
  );

  const slotsLeft = cap - listed.length;
  if (slotsLeft <= 0) {
    return sendButtons(from, {
      text: `❌ You have reached your listing limit (${listed.length}/${cap}). Upgrade or replace some listed items first.`,
      buttons: [
        { id: "sup_upgrade_plan", title: "⬆️ Upgrade Plan" },
        { id: "sup_manage_listed_products", title: "⬅ Back" }
      ]
    });
  }

  if (!available.length) {
    return sendButtons(from, {
      text: "✅ All uploaded items are already listed.",
      buttons: [
        { id: "sup_manage_listed_products", title: "⬅ Back" }
      ]
    });
  }

  if (biz) {
    biz.sessionState = "supplier_add_listed_products";
    await saveBizSafe(biz);
  }

  await sendSupplierItemsInChunks(
    from,
    available,
    `➕ Choose Items to Add (${slotsLeft} slot${slotsLeft === 1 ? "" : "s"} left)`
  );

  return sendText(from, `Reply with the numbers you want to add to your live listing.\n\nExample:\n*2, 5, 8*`);
}


if (biz?.sessionState === "supplier_add_listed_products") {
  const supplier = await SupplierProfile.findOne({ phone });
  if (!supplier) return true;

  const uploaded = (supplier.products || []).filter(p => p && p !== "pending_upload");

  const capMap = { basic: 20, pro: 60, featured: 150 };
  const cap = capMap[supplier.tier] || 20;

  const current = supplier.listedProducts || [];
  const remainingSlots = cap - current.length;

  const indexes = findSupplierItemIndexes(text, uploaded);
  if (!indexes.length) {
    await sendText(from, "❌ Invalid selection. Example: 1,2,5");
    return true;
  }

  const selected = indexes.slice(0, remainingSlots).map(i => uploaded[i]);

  supplier.listedProducts = [...current, ...selected].slice(0, cap);
  await supplier.save();

  biz.sessionState = "ready";
  await saveBizSafe(biz);

  await sendText(
    from,
    `✅ Added *${selected.length}* items.\n\nYou now have *${supplier.listedProducts.length}/${cap}* live items.`
  );

  return sendSupplierAccountMenu(from, supplier);
}


if (a === "sup_replace_listed_products") {
  const supplier = await SupplierProfile.findOne({ phone });
  if (!supplier) return sendText(from, "❌ Supplier not found.");

  const capMap = { basic: 20, pro: 60, featured: 150 };
  const cap = capMap[supplier.tier] || 20;

  const uploaded = (supplier.products || []).filter(p => p && p !== "pending_upload");

  biz.sessionState = "supplier_replace_listed_products";
  await saveBizSafe(biz);

  const preview = uploaded.map((p, i) => `${i + 1}. ${p}`).join("\n");

  return sendText(
    from,
    `♻️ *Replace Live Items*\n\n` +
    `Choose *up to ${cap}* items to keep live.\n` +
    `_You don't need to fill all slots now._\n\n` +
    `${preview}\n\nExample: *1,2,5*`
  );
}

if (a === "sup_manage_listed_products") {
  const supplier = await SupplierProfile.findOne({ phone });
  if (!supplier) return sendSuppliersMenu(from);

  const capMap = { basic: 20, pro: 60, featured: 150 };
  const cap = capMap[supplier.tier] || 20;
  const listed = (supplier.listedProducts || []).filter(Boolean);
  const isService = supplier.profileType === "service";

  return sendList(
    from,
    `📋 *Manage Listed ${isService ? "Services" : "Products"}*\n\n` +
    `Live now: ${listed.length}/${cap}\n\nWhat would you like to do?`,
    [
      { id: "sup_view_listed_products", title: `👀 View Listed ${isService ? "Services" : "Products"}` },
      { id: "sup_add_listed_products", title: `➕ Add More Listed ${isService ? "Items" : "Products"}` },
      { id: "sup_remove_listed_products", title: `🗑 Remove Listed ${isService ? "Items" : "Products"}` },
      { id: "sup_replace_listed_products", title: `🔄 Replace Listed ${isService ? "Items" : "Products"}` },
      { id: "my_supplier_account", title: "🏪 My Account" }
    ]
  );
}





  // ── Buyer: My Orders list ─────────────────────────────────────────────────
if (a === "my_orders" || a.startsWith("my_orders_page_")) {
    const PAGE_SIZE = 9;
    const page = a.startsWith("my_orders_page_")
      ? Math.max(0, parseInt(a.replace("my_orders_page_", "")) || 0)
      : 0;

    const totalCount = await SupplierOrder.countDocuments({ buyerPhone: phone });

    if (!totalCount) {
      return sendButtons(from, {
        text: "📋 *My Orders*\n\nYou haven't placed any orders yet.",
        buttons: [
          { id: "find_supplier", title: "🔍 Browse & Shop" },
          { id: "suppliers_home", title: "🛒 Marketplace" }
        ]
      });
    }

    const orders = await SupplierOrder.find({ buyerPhone: phone })
      .sort({ createdAt: -1 })          // ← newest first
      .skip(page * PAGE_SIZE)
      .limit(PAGE_SIZE)
      .populate("supplierId", "businessName");

    const si = { pending: "⏳ Pending", accepted: "✅ Accepted", declined: "❌ Declined", completed: "🏁 Completed" };

    const rows = orders.map(o => {
      const itemCount = o.items?.length || 0;
      const firstItem = o.items?.[0]?.product || "Item";
      const label = itemCount > 1 ? `${firstItem} +${itemCount - 1} more` : firstItem;
      const total = o.totalAmount > 0 ? ` · $${Number(o.totalAmount).toFixed(2)}` : "";
      const date = new Date(o.createdAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "2-digit" });
      return {
        id: `order_detail_${o._id}`,
        title: `${o.supplierId?.businessName || "Supplier"} · ${date}`,
        description: `${si[o.status] || "⏳ Pending"} · ${label}${total}`
      };
    });

    const hasMore = (page + 1) * PAGE_SIZE < totalCount;
    const hasPrev = page > 0;
    if (hasMore) rows.push({ id: `my_orders_page_${page + 1}`, title: `➡ Next page` });
    if (hasPrev) rows.push({ id: `my_orders_page_${page - 1}`, title: `⬅ Previous page` });

    const showing = `${page * PAGE_SIZE + 1}–${Math.min((page + 1) * PAGE_SIZE, totalCount)} of ${totalCount}`;
    return sendList(from, `📋 *My Orders* (${showing})\nNewest first - tap any order to view details.`, rows);
  }

  // ── Buyer: Order detail ───────────────────────────────────────────────────
if (a.startsWith("order_detail_")) {
    const orderId = a.replace("order_detail_", "");
    const order = await SupplierOrder.findById(orderId).populate("supplierId", "businessName phone");
    if (!order) {
      return sendButtons(from, {
        text: "❌ Order not found.",
        buttons: [{ id: "my_orders", title: "⬅ My Orders" }]
      });
    }

    const si = { pending: "⏳ Pending", accepted: "✅ Accepted", declined: "❌ Declined", completed: "🏁 Completed" };
    const isService = order.supplierId?.profileType === "service";

    const itemLines = (order.items || []).map(i => {
      const unitSuffix = i.unit && i.unit !== "units" ? ` ${i.unit}` : "";
      const pricePart = typeof i.pricePerUnit === "number"
        ? ` @ $${Number(i.pricePerUnit).toFixed(2)}${unitSuffix} = $${Number(i.total || 0).toFixed(2)}`
        : unitSuffix;
      return `• ${i.product} x${i.quantity}${pricePart}`;
    }).join("\n");

    const totalLine = order.totalAmount > 0
      ? `\n💵 *Total: $${Number(order.totalAmount).toFixed(2)}*`
      : "\n💵 Total: Pending supplier confirmation";

    const deliveryLine = order.delivery?.required
      ? `🚚 Deliver to: ${order.delivery.address}`
      : isService
        ? `📍 Location: ${order.delivery?.address || "Not specified"}`
        : `🏠 Collection`;

    const date = new Date(order.createdAt).toLocaleDateString("en-GB", {
      day: "numeric", month: "short", year: "numeric",
      hour: "2-digit", minute: "2-digit"
    });

    const msg = [
      `📋 *Order Details*`,
      ``,
      `🏪 *Supplier:* ${order.supplierId?.businessName || "Unknown"}`,
      `📞 *Contact:* ${order.supplierId?.phone || "-"}`,
      `📅 *Placed:* ${date}`,
      ``,
      `*Items:*`,
      itemLines,
      totalLine,
      ``,
      deliveryLine,
      ``,
      `*Status:* ${si[order.status] || "⏳ Pending"}`,
      order.declineReason ? `❌ *Reason:* ${order.declineReason}` : "",
      order.eta ? `🕐 *ETA:* ${order.eta}` : ""
    ].filter(l => l !== "").join("\n");

    const btns = [];
    if (order.status === "accepted" || order.status === "completed") {
      if (!order.buyerRating) btns.push({ id: `rate_order_${order._id}`, title: "⭐ Rate Order" });
    }
    btns.push({ id: "my_orders", title: "⬅ My Orders" });
    if (btns.length < 3) btns.push({ id: "find_supplier", title: "🔍 Find Suppliers" });

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

  const isService = supplier.profileType === "service";
  const label = isService ? "Services" : "Products";
  const items = (supplier.products || []).filter(p => p !== "pending_upload");

  if (biz) {
    biz.sessionState = "supplier_manage_products_menu";
    await saveBizSafe(biz);
  }

return sendList(from, `✏️ Manage ${label}`, [
  { id: "sup_view_products", title: `📋 View Current ${label}` },
  { id: "sup_add_products", title: `➕ Add ${isService ? "Services" : "Products"}` },
  { id: "sup_delete_products", title: `🗑 Delete ${isService ? "Services" : "Products"}` },
  { id: "sup_quick_edit_products", title: `⚡ Quick Edit ${isService ? "Services" : "Products"}` },
  { id: "sup_replace_products", title: `♻️ Replace Full ${label} List` },
  { id: "my_supplier_account", title: "🏪 My Account" }
]);
}


if (a === "sup_view_products") {
  const supplier = await SupplierProfile.findOne({ phone });
  if (!supplier) return sendSuppliersMenu(from);

  const isService = supplier.profileType === "service";
  const label = isService ? "Services" : "Products";
  const capMap = { basic: 20, pro: 60, featured: 150 };
  const cap = capMap[supplier.tier] || 20;

  const allItems = (supplier.products || []).filter(p => p !== "pending_upload");
  const listedSet = new Set(
    (supplier.listedProducts || []).filter(Boolean).map(p => normalizeProductName(p))
  );

  const listed   = allItems.filter(p => listedSet.has(normalizeProductName(p)));
  const unlisted = allItems.filter(p => !listedSet.has(normalizeProductName(p)));

  // ── Listed items ────────────────────────────────────────────────────────
  if (listed.length) {
    await sendSupplierItemsInChunks(
      from,
      listed,
      `🟢 Live ${label} (${listed.length}/${cap})`
    );
  } else {
    await sendText(from, `🟢 *Live ${label}:* None listed yet.`);
  }

  // ── Unlisted items ──────────────────────────────────────────────────────
  if (unlisted.length) {
    await sendSupplierItemsInChunks(
      from,
      unlisted,
      `⚪ Unlisted ${label} (${unlisted.length} - not visible to buyers)`
    );
  } else {
    await sendText(from, `⚪ *Unlisted ${label}:* None - all items are live.`);
  }

  return sendList(from, "What would you like to do next?", [
    { id: "sup_add_products",          title: `➕ Add ${label}` },
    { id: "sup_delete_products",       title: `🗑 Delete ${label}` },
    { id: "sup_replace_products",      title: `♻️ Replace Full ${label} List` },
    { id: "sup_manage_listed_products", title: `🟢 Manage Live ${label}` },
    { id: "my_supplier_account",       title: "🏪 My Account" }
  ]);
}

if (a === "sup_add_products") {
  const supplier = await SupplierProfile.findOne({ phone });
  if (!supplier) return sendSuppliersMenu(from);

  const isService = supplier.profileType === "service";
  if (biz) {
    biz.sessionState = "supplier_add_products";
    await saveBizSafe(biz);
  }

  return sendText(
    from,
`➕ *Add ${isService ? "Services" : "Products"}*

Send only the new ${isService ? "services" : "products"} you want to add.
Use commas or one per line.

Example:
${isService ? "geyser fitting, blocked drain, toilet installation" : "25mm pvc elbow, basin mixer, toilet seat"}

Duplicates will be ignored.

Type *cancel* to go back.`
  );
}

if (a === "sup_delete_products") {
  const supplier = await SupplierProfile.findOne({ phone });
  if (!supplier) return sendSuppliersMenu(from);

  const isService = supplier.profileType === "service";
  const items = (supplier.products || []).filter(p => p !== "pending_upload");

  if (!items.length) {
    return sendText(from, `❌ No ${isService ? "services" : "products"} listed yet.`);
  }

  if (biz) {
    biz.sessionState = "supplier_delete_products";
    await saveBizSafe(biz);
  }

  const listedSet = new Set(
    (supplier.listedProducts || []).filter(Boolean).map(p => normalizeProductName(p))
  );
  const listedItems   = items.filter(p => listedSet.has(normalizeProductName(p)));
  const unlistedItems = items.filter(p => !listedSet.has(normalizeProductName(p)));

  // Build one combined numbered list with section headers inline
  const allLines = [];
  if (listedItems.length) {
    allLines.push(`🟢 *Live (${listedItems.length}):*`);
    listedItems.forEach((p, i) => allLines.push(`${i + 1}. ${p}`));
  }
  if (unlistedItems.length) {
    allLines.push(`\n⚪ *Unlisted (${unlistedItems.length}):*`);
    unlistedItems.forEach((p, i) => allLines.push(`${listedItems.length + i + 1}. ${p}`));
  }

  const CHUNK = 25;
  for (let i = 0; i < allLines.length; i += CHUNK) {
    const chunk = allLines.slice(i, i + CHUNK).join("\n");
    const isFirst = i === 0;
    await sendText(from,
      isFirst
        ? `🗑 *Select ${isService ? "Services" : "Products"} to Delete*\n\n${chunk}`
        : chunk
    );
  }

  return sendText(
    from,
`Reply with the *numbers* or *exact names* you want to delete.

Examples:
*2, 5, 9*
*5-8*
*basin mixer, shower trap*

⚠️ Deleting a live item will also remove it from your listing.

You can delete just a few items - you do NOT need to resend the whole list.

Type *cancel* to go back.`
  );
}
if (a === "sup_replace_products") {
  const supplier = await SupplierProfile.findOne({ phone });
  if (!supplier) return sendSuppliersMenu(from);

  const isService = supplier.profileType === "service";
  if (biz) {
    biz.sessionState = "supplier_replace_products";
    await saveBizSafe(biz);
  }

  return sendText(
    from,
`♻️ *Replace Full ${isService ? "Service" : "Product"} List*

Send the full updated ${isService ? "service" : "product"} list, comma-separated or one per line.

⚠️ This replaces your whole list.
Any old item not included will be removed.

Example:
${isService ? "plumbing, geyser fitting, blocked drain" : "cooking oil, rice, sugar, flour"}

Type *cancel* to go back.`
  );
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
Example: *Avondale, -*

_Type *cancel* to go back to your account._`
    );
  }

if (a === "sup_my_orders") {
  const supplier = await SupplierProfile.findOne({ phone });
  if (!supplier) return sendSuppliersMenu(from);

  if (!supplier.active) {
    await sendText(from,
`🔒 *Activate your listing first.*

Once your listing is live, buyers will start sending you orders. Choose a plan to activate.`
    );
    return sendSupplierUpgradeMenu(from, supplier.tier);
  }

  const SupplierOrder = (await import("../models/supplierOrder.js")).default;
  const orders = await SupplierOrder.find({ supplierId: supplier._id })
    .sort({ createdAt: -1 })
    .limit(10)
    .lean();

  if (!orders.length) {
    return sendButtons(from, {
      text: "📦 *My Orders*\n\nNo orders yet. Make sure your listing is active so buyers can find you!",
      buttons: [{ id: "my_supplier_account", title: "🏪 My Account" }]
    });
  }

  // Show list of orders - each tappable to drill into
  const rows = orders.map((o) => {
    const statusIcon = { pending: "⏳", accepted: "✅", declined: "❌", completed: "🏁" }[o.status] || "•";
    const date = new Date(o.createdAt).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
    const orderRef = String(o._id).slice(-6).toUpperCase();
    const amount = typeof o.totalAmount === "number" ? ` · $${o.totalAmount.toFixed(2)}` : "";
    const itemCount = Array.isArray(o.items) ? o.items.length : 0;
    return {
      id: `sup_view_order_${o._id}`,
      title: `${statusIcon} #${orderRef} (${date})`,
      description: `${itemCount} item${itemCount !== 1 ? "s" : ""}${amount} · ${o.status}`
    };
  });

  rows.push({ id: "my_supplier_account", title: "⬅ Back" });

  return sendList(from, `📦 *My Orders* - last ${orders.length}`, rows);
}

// ── Supplier drills into a single order ───────────────────────────────────────
if (a.startsWith("sup_view_order_")) {
  const orderId = a.replace("sup_view_order_", "");
  const supplier = await SupplierProfile.findOne({ phone });
  if (!supplier) return sendSuppliersMenu(from);

  const SupplierOrder = (await import("../models/supplierOrder.js")).default;
  const order = await SupplierOrder.findById(orderId).lean();
  if (!order) {
    await sendText(from, "❌ Order not found.");
    return sendSupplierAccountMenu(from, supplier);
  }

  const isService = supplier.profileType === "service";
  const orderRef = String(order._id).slice(-6).toUpperCase();
  const date = new Date(order.createdAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
  const statusIcon = { pending: "⏳", accepted: "✅", declined: "❌", completed: "🏁" }[order.status] || "•";

  const itemLines = Array.isArray(order.items) && order.items.length
    ? order.items.map(item => {
        const name = item.product || "Item";
        const qty = item.quantity ?? 1;
        const unitSuffix = item.unit && item.unit !== "units" ? ` ${item.unit}` : "";
        const lineTotal = typeof item.total === "number" ? ` = $${item.total.toFixed(2)}` : "";
        const unitPrice = typeof item.pricePerUnit === "number" ? ` @ $${item.pricePerUnit.toFixed(2)}` : "";
        return `• ${name} x${qty}${unitSuffix}${unitPrice}${lineTotal}`;
      }).join("\n")
    : "• No items";

  const deliveryLine = order.delivery?.required
    ? `🚚 Delivery: ${order.delivery.address || "Address not provided"}`
    : isService
      ? `📍 Service location: ${order.delivery?.address || "Not specified"}`
      : "🏠 Collection";

  const amount = typeof order.totalAmount === "number" ? `$${order.totalAmount.toFixed(2)}` : "Pending pricing";

  const detailText =
    `${statusIcon} *Order #${orderRef}*\n` +
    `📅 ${date}\n\n` +
    `${itemLines}\n\n` +
    `${deliveryLine}\n` +
    `💵 Total: ${amount}\n` +
    `📞 Buyer: ${order.buyerPhone}\n` +
    `📌 Status: *${order.status}*`;

  // Pending orders get Accept / Decline / Contact buttons
  if (order.status === "pending") {
    return sendButtons(from, {
      text: detailText,
      buttons: [
        { id: `sup_accept_${order._id}`, title: isService ? "✅ Accept Booking" : "✅ Accept" },
        { id: `sup_decline_${order._id}`, title: "❌ Decline" },
        { id: `sup_contact_buyer_${order._id}`, title: "📞 Contact Buyer" }
      ]
    });
  }

  // Accepted / other statuses - contact + back
  return sendButtons(from, {
    text: detailText,
    buttons: [
      { id: `sup_contact_buyer_${order._id}`, title: "📞 Contact Buyer" },
      { id: "sup_my_orders", title: "⬅ My Orders" }
    ]
  });
}

// ── Supplier contacts buyer from order detail view ────────────────────────────
if (a.startsWith("sup_contact_buyer_")) {
  const orderId = a.replace("sup_contact_buyer_", "");
  const SupplierOrder = (await import("../models/supplierOrder.js")).default;
  const order = await SupplierOrder.findById(orderId).lean();
  if (!order) {
    await sendText(from, "❌ Order not found.");
    return sendSupplierAccountMenu(from, null);
  }
  const orderRef = String(order._id).slice(-6).toUpperCase();
  return sendButtons(from, {
    text:
      `📞 *Contact Buyer*\n\n` +
      `Order #${orderRef}\n` +
      `Buyer's WhatsApp number: *${order.buyerPhone}*\n\n` +
      `You can call or message them directly on WhatsApp.`,
    buttons: [
      { id: `sup_view_order_${order._id}`, title: "⬅ Back to Order" }
    ]
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
      `💳 *Choose Your Plan*\n\nAll plans include:\n✅ Listed in search\n✅ Phone number visible\n✅ Unlimited uploads\n✅ Unlimited orders\n\nPick a plan to continue:`,
      [
        { id: "sup_plan_basic_monthly", title: "✅ Basic - $5/month", description: "Up to 20 live items" },
        { id: "sup_plan_basic_annual", title: "✅ Basic - $50/year", description: "Up to 20 live items · save $10" },
        { id: "sup_plan_pro_monthly", title: "⭐ Pro - $12/month", description: "Up to 60 live items" },
        { id: "sup_plan_pro_annual", title: "⭐ Pro - $120/year", description: "Up to 60 live items · save $24" },
        { id: "sup_plan_featured_monthly", title: "🔥 Featured $25/mo", description: "Up to 150 live items + featured badge" }
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

Example: *Avondale, Mbare, Belgravia*

_Type *cancel* to return to main menu._`
    );
  }


  // ── Profile type: Products or Services ───────────────────────────────────

// ── School listing type selected - pivot the entire reg flow into school mode ─
if (a === "reg_type_school") {
  if (!biz) {
    await sendText(from, "❌ Session expired. Type *menu* to start again.");
    return;
  }

  // Check if already has a school profile
  const existingSchool = await SchoolProfile.findOne({ phone });
  if (existingSchool?.active) {
    const { sendSchoolAccountMenu } = await import("./metaMenus.js");
    return sendSchoolAccountMenu(from, existingSchool);
  }
  if (existingSchool && !existingSchool.active) {
    return sendList(from, `🏫 *${existingSchool.schoolName}* is saved but not yet live.`, [
      { id: "school_pay_plan",  title: "💳 Activate Listing" },
      { id: "school_account",   title: "👁 View My Profile" },
      { id: "main_menu_back",   title: "⬅ Main Menu" }
    ]);
  }

  biz.sessionData = { supplierReg: { profileType: "school" } };
  biz.sessionState = "school_reg_name";
  await saveBizSafe(biz);

  return sendText(from,
`🏫 *Register Your School on ZimQuote*

Parents across Zimbabwe will be able to find your school, view fees, facilities, and apply online.

What is your *school's full name*?

_Type *cancel* at any time to stop._`
  );
}

if (a === "reg_type_product" || a === "reg_type_service") {
  if (!biz) return sendMainMenu(from);

  const profileType = a === "reg_type_service" ? "service" : "product";

  biz.sessionData = biz.sessionData || {};
  biz.sessionData.supplierReg = {
    profileType
  };

  biz.sessionState = "supplier_reg_name";
  await saveBizSafe(biz);

  return sendText(
    from,
    `🏪 *What is your business name?*\n\nExample: *Mudziyashe Hardware*`
  );
}


// ── Supplier collar group selected during service registration ────────────
if (a.startsWith("sup_collar_")) {
  if (!biz) return sendMainMenu(from);

  const collarKey = a.replace("sup_collar_", "");
  const validCollars = ["white_collar", "trade", "blue_collar"];
  if (!validCollars.includes(collarKey)) {
    await sendText(from, "❌ Invalid selection. Please try again.");
    return sendMainMenu(from);
  }

  biz.sessionData = biz.sessionData || {};
  biz.sessionData.supplierReg = biz.sessionData.supplierReg || {};
  biz.sessionData.supplierReg.collarGroup = collarKey;
  biz.sessionState = "supplier_reg_category";
  await saveBizSafe(biz);

  // Show only categories belonging to this collar group
  const filteredCategories = SUPPLIER_CATEGORIES.filter(
    c => c.types.includes("service") && c.collar === collarKey
  );

  const collarLabels = {
    white_collar: "💼 Professional Services",
    trade: "🔧 Trade & Artisan",
    blue_collar: "🧹 General Services"
  };

  const categoryRows = [
    ...filteredCategories.slice(0, 9).map(c => ({
      id: `sup_cat_${c.id}`,
      title: c.label
    })),
    ...(filteredCategories.length > 9
      ? [{ id: `sup_collar_more_${collarKey}`, title: "➕ More Categories" }]
      : [])
  ];

  return sendList(
    from,
    `${collarLabels[collarKey]}\n\n_Choose your main category:_`,
    categoryRows
  );
}

// ── More categories for a specific collar group ───────────────────────────
if (a.startsWith("sup_collar_more_")) {
  if (!biz) return sendMainMenu(from);

  const collarKey = a.replace("sup_collar_more_", "");
  const filteredCategories = SUPPLIER_CATEGORIES.filter(
    c => c.types.includes("service") && c.collar === collarKey
  );

  return sendList(from, "🗂 More Categories", [
    ...filteredCategories.slice(9).map(c => ({
      id: `sup_cat_${c.id}`,
      title: c.label
    })),
    { id: `sup_collar_${collarKey}`, title: "⬅ Back" }
  ]);
}


if (a === "sup_cat_more") {
  if (!biz) return sendMainMenu(from);

  const profileType = biz.sessionData?.supplierReg?.profileType || "product";
  const filteredCategories = getSupplierCategoriesForType(profileType);

  // For services, "More Categories" should return service groups, not a huge flat list
  if (profileType === "service") {
    return sendList(from, "🗂 Service Groups", [
      { id: "sup_grp_trades_technical", title: "🛠️ Trades" },
      { id: "sup_grp_home_property", title: "🏠 Home & Property" },
      { id: "sup_grp_professional_corporate", title: "💼 Professional" },
      { id: "sup_grp_health_personal", title: "🩺 Health & Care" },
      { id: "sup_grp_creative_events_media", title: "🎨 Creative & Media" },
      { id: "sup_grp_education_digital", title: "💻 Education" },
      { id: "sup_grp_transport_logistics", title: "🚚 Transport" },
      { id: "sup_grp_other_services_group", title: "🧰 Other Services" }
    ]);
  }

  // Keep product flow paginated and valid
  const moreRows = filteredCategories.slice(9, 18).map(c => ({
    id: `sup_cat_${c.id}`,
    title: c.label
  }));

  if (filteredCategories.length > 18) {
    moreRows.push({ id: "sup_cat_more_2", title: "➡ More Categories" });
  }

  return sendList(from, "🗂 More Categories", moreRows);
}

if (a === "sup_cat_more_2") {
  if (!biz) return sendMainMenu(from);

  const profileType = biz.sessionData?.supplierReg?.profileType || "product";
  const filteredCategories = getSupplierCategoriesForType(profileType);

  const moreRows = filteredCategories.slice(18, 27).map(c => ({
    id: `sup_cat_${c.id}`,
    title: c.label
  }));

  return sendList(from, "🗂 More Categories (Page 2)", moreRows);
}

  // ── Travel yes/no during service registration ─────────────────────────────
if (a === "sup_travel_yes") {
    if (!biz) return sendMainMenu(from);
    biz.sessionData.supplierReg = biz.sessionData.supplierReg || {};
    biz.sessionData.supplierReg.travelAvailable = true;
    biz.sessionData.supplierReg.minOrder = 0;
    biz.sessionState = "supplier_reg_biz_currency";
    await saveBizSafe(biz);
    return sendButtons(from, {
      text: "💱 *Almost done! What currency does your business use?*\n\nThis will be your default for invoices and quotes.",
      buttons: [
        { id: "sup_biz_cur_USD", title: "💵 USD ($)" },
        { id: "sup_biz_cur_ZWL", title: "🇿🇼 ZWL (Z$)" },
        { id: "sup_biz_cur_ZAR", title: "🇿🇦 ZAR (R)" }
      ]
    });
  }


if (a === "sup_travel_no") {
    if (!biz) return sendMainMenu(from);
    biz.sessionData.supplierReg = biz.sessionData.supplierReg || {};
    biz.sessionData.supplierReg.travelAvailable = false;
    biz.sessionData.supplierReg.minOrder = 0;
    biz.sessionState = "supplier_reg_biz_currency";
    await saveBizSafe(biz);
    return sendButtons(from, {
      text: "💱 *Almost done! What currency does your business use?*\n\nThis will be your default for invoices and quotes.",
      buttons: [
        { id: "sup_biz_cur_USD", title: "💵 USD ($)" },
        { id: "sup_biz_cur_ZWL", title: "🇿🇼 ZWL (Z$)" },
        { id: "sup_biz_cur_ZAR", title: "🇿🇦 ZAR (R)" }
      ]
    });
  }
  // ── Supplier category selected during registration ────────────────────────

if (a.startsWith("sup_grp_")) {
  if (!biz) return sendMainMenu(from);

  const groupId = a.replace("sup_grp_", "");
  const group = SERVICE_CATEGORY_GROUPS.find(g => g.id === groupId);

  if (!group) {
    return sendText(from, "❌ Service group not found. Please try again.");
  }

  const rows = group.categoryIds
    .map(catId => SUPPLIER_CATEGORIES.find(c => c.id === catId && c.types?.includes("service")))
    .filter(Boolean)
    .slice(0, 9)
    .map(c => ({
      id: `sup_cat_${c.id}`,
      title: c.label
    }));

  rows.push({ id: "reg_type_service", title: "⬅ Service Groups" });

  return sendList(from, group.label, rows);
}







if (a.startsWith("sup_cat_")) {
  const catId = a.replace("sup_cat_", "");
  if (!biz) return sendMainMenu(from);

  const profileType = biz.sessionData?.supplierReg?.profileType || "product";

  biz.sessionData = biz.sessionData || {};
  biz.sessionData.supplierReg = biz.sessionData.supplierReg || {};
  const existing = biz.sessionData.supplierReg.categories || [];
  if (!existing.includes(catId)) existing.push(catId);
  biz.sessionData.supplierReg.categories = existing;

  // ── NEW: if this category has subcats, ask the supplier to pick one ───────
  const selectedCat = SUPPLIER_CATEGORIES.find(c => c.id === catId);
  if (selectedCat?.subcats?.length) {
    biz.sessionState = "supplier_reg_subcat";
    await saveBizSafe(biz);

    const subcatRows = [
      { id: "sup_subcat_all", title: "📋 All / General" },
      ...selectedCat.subcats.slice(0, 9).map(s => ({
        id: `sup_subcat_${s.id}`,
        title: s.label
      }))
    ];

    return sendList(
      from,
      `📂 *${selectedCat.label}*\n\nWhich area do you specialise in?\n_You can always add more services later._`,
      subcatRows
    );
  }

  // ── No subcats: continue directly to products/services step ──────────────
  biz.sessionState = "supplier_reg_products";
  await saveBizSafe(biz);

  const { CATEGORY_PRODUCT_EXAMPLES, CATEGORY_SERVICE_EXAMPLES } = await import("./supplierRegistration.js");
  const { getTemplateForCategoryWithDB } = await import("./supplierProductTemplates.js");
  const template = await getTemplateForCategoryWithDB(catId);

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






// ── Supplier subcategory selected during service registration ─────────────
if (a.startsWith("sup_subcat_")) {
  if (!biz) return sendMainMenu(from);

  const subcatId = a.replace("sup_subcat_", "");
  const profileType = biz.sessionData?.supplierReg?.profileType || "service";

  biz.sessionData = biz.sessionData || {};
  biz.sessionData.supplierReg = biz.sessionData.supplierReg || {};
  // Store subcategory (null means "All / General")
  biz.sessionData.supplierReg.subcategory = subcatId === "all" ? null : subcatId;
  biz.sessionState = "supplier_reg_products";
  await saveBizSafe(biz);

 const catId = (biz.sessionData.supplierReg.categories || [])[0];
  const { CATEGORY_SERVICE_EXAMPLES, CATEGORY_PRODUCT_EXAMPLES } = await import("./supplierRegistration.js");

  if (profileType === "service") {
    const catExamples = CATEGORY_SERVICE_EXAMPLES[catId] || ["service a", "service b"];
    const exampleText = catExamples.slice(0, 2).join(", ");

    return sendButtons(from, {
      text: `✅ *Specialisation saved!*\n\nHow would you like to add your services?\n\n_e.g. ${exampleText}_`,
      buttons: [
        { id: "sup_request_upload",     title: "📤 Send Us Your List" },
        { id: "sup_enter_own_products", title: "✍️ Type My Own" },
        { id: "sup_skip_products",      title: "⏭ Skip For Now" }
      ]
    });
  }

  // ── Product path: check for admin preset template (same as sup_cat_ handler) ──
  const { getTemplateForCategoryWithDB } = await import("./supplierProductTemplates.js");
  const template = await getTemplateForCategoryWithDB(catId);
  const catExamples = CATEGORY_PRODUCT_EXAMPLES[catId] || ["product a", "product b"];

  if (template) {
    const preview = template.products.slice(0, 6).join(", ");
    const moreCount = template.products.length - 6;

    return sendButtons(from, {
      text:
`✅ *Subcategory saved!*

📦 *Preset available:* _${preview}${moreCount > 0 ? ` + ${moreCount} more` : ""}_

How would you like to add your products?`,
      buttons: [
        { id: "sup_request_upload",       title: "📤 Send Us Your List" },
        { id: "sup_enter_own_products",   title: "✍️ Type My Own" },
        { id: `sup_load_preset_${catId}`, title: "📦 Use Preset List" }
      ]
    });
  }

  return sendButtons(from, {
    text: `✅ *Subcategory saved!*\n\nHow would you like to add your products?\n\n_e.g. ${catExamples.slice(0, 3).join(", ")}_`,
    buttons: [
      { id: "sup_request_upload",     title: "📤 Send Us Your List" },
      { id: "sup_enter_own_products", title: "✍️ Type My Own" },
      { id: "sup_skip_products",      title: "⏭ Skip For Now" }
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

─────────────────
*Fastest way: update by item number*

*Single item:*
_${isService ? "1x20/job" : "1x5.50"}_
_${isService ? "1 x 20/job" : "1 x 5.50"}_

*Same ${isService ? "rate" : "price"} for selected items:*
_${isService ? "1,3,5x20/job" : "1,3,5x5.50"}_
_${isService ? "1,3,5 x 20/job" : "1,3,5 x 5.50"}_

*Same ${isService ? "rate" : "price"} for a range:*
_${isService ? "1-4x15/hr" : "1-4x5.50"}_
_${isService ? "1-4 x 15/hr" : "1-4 x 5.50"}_

*Mixed updates:*
_${isService ? "1x20/job,2x15/trip,3x10/hr" : "1x5.50,2x8.00,3x12.00"}_
_${isService ? "1 x 20/job, 2 x 15/trip, 3 x 10/hr" : "1 x 5.50, 2 x 8.00, 3 x 12.00"}_

*Other options still work:*

*Update ALL in order:*
_${isService
  ? productList.slice(0, 3).map((_, i) => ((i + 1) * 10)).join(", ")
  : productList.slice(0, 4).map((_, i) => ((i + 1) * 3 + 2) + ".00").join(", ")}${productList.length > 4 ? ", ..." : ""}_

*Update selected items by name:*
_${productList.slice(0, 2).map(p => `${p}: ${isService ? "20/job" : "5.00"}`).join(", ")}_

Type *skip* to skip pricing.`);
}

// ── Load preset products - show full preview before confirming ────────────
if (a.startsWith("sup_load_preset_")) {
  if (!biz) return sendMainMenu(from);

  const catId = a.replace("sup_load_preset_", "");
  const { getTemplateForCategoryWithDB } = await import("./supplierProductTemplates.js");
  const template = await getTemplateForCategoryWithDB(catId);

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

  const allProducts = template.products;
  const priceHint = template.prices?.length
    ? `💰 Suggested prices included for ${template.prices.length} items\n\n`
    : "";

  // ── Send the full product list as a plain TEXT message (no 1024 char limit)
  // then send a separate BUTTON message for the confirm/reject action
  const PREVIEW_PER_ROW = 4;
  const rows = [];
  for (let i = 0; i < allProducts.length; i += PREVIEW_PER_ROW) {
    rows.push(
      allProducts.slice(i, i + PREVIEW_PER_ROW)
        .map((p, j) => `${i + j + 1}. ${p}`)
        .join("   ")
    );
  }
  const productPreview = rows.join("\n");

  // Step 1: send the full list as a plain text message (limit = 4096, safe)
  await sendText(from,
`📦 *Preset Product List* (${allProducts.length} items)

${productPreview}

${priceHint}Scroll up to review the full list 👆`
  );

  // Step 2: send confirm buttons as a SHORT separate message
  return sendButtons(from, {
    text: `Load all ${allProducts.length} products to your listing?`,
    buttons: [
      { id: "sup_preset_confirm",     title: "✅ Yes, Load These" },
      { id: "sup_enter_own_products", title: "✍️ No, Type My Own" }
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

  const { getTemplateForCategoryWithDB } = await import("./supplierProductTemplates.js");
  const template = await getTemplateForCategoryWithDB(catId);

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


if (a === "sup_addr_skip") {
  if (!biz) return sendMainMenu(from);

  biz.sessionData.supplierReg = biz.sessionData.supplierReg || {};
  biz.sessionData.supplierReg.address = "";
  biz.sessionState = "supplier_reg_contact_details";
  await saveBizSafe(biz);

  return sendButtons(from, {
    text:
`📞 *Contact Details (Optional)*

Enter any extra contact details buyers should see.

Examples:
_0772123456 / 0712345678_
_Call or WhatsApp 0772123456_
_sales@mybusiness.co.zw_

You can also skip this step.`,
    buttons: [
      { id: "sup_contact_skip", title: "⏭ Skip Contact" }
    ]
  });
}

if (a === "sup_contact_skip") {
  if (!biz) return sendMainMenu(from);

  biz.sessionData.supplierReg = biz.sessionData.supplierReg || {};
  biz.sessionData.supplierReg.contactDetails = "";
  biz.sessionState = "supplier_reg_website";
  await saveBizSafe(biz);

  return sendButtons(from, {
    text:
`🌐 *Website (Optional)*

Enter your website, Facebook page, Instagram page, or business link buyers should see.

Examples:
_www.mybusiness.co.zw_
_facebook.com/mybusiness_
_instagram.com/mybusiness_

You can also skip this step.`,
    buttons: [
      { id: "sup_website_skip", title: "⏭ Skip Website" }
    ]
  });
}

if (a === "sup_website_skip") {
  if (!biz) return sendMainMenu(from);

  biz.sessionData = biz.sessionData || {};
  biz.sessionData.supplierReg = biz.sessionData.supplierReg || {};
  biz.sessionData.supplierReg.website = "";

  const profileType = biz.sessionData.supplierReg.profileType || "product";

  if (profileType === "service") {
    biz.sessionState = "supplier_reg_collar";
    await saveBizSafe(biz);

    return sendList(from, "🧑‍💼 *What type of services do you offer?*\n\nThis helps buyers find you faster.", [
      { id: "sup_collar_white_collar", title: "💼 Professional" },
      { id: "sup_collar_trade",        title: "🔧 Trade & Artisan" },
      { id: "sup_collar_blue_collar",  title: "🧹 General Services" }
    ]);
  }

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

  return sendList(from, "🗂 What product do you mainly offer?", categoryRows);
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
    biz.sessionData.supplierReg.minOrder = 0;
    biz.sessionState = "supplier_reg_biz_currency";
    await saveBizSafe(biz);
    return sendButtons(from, {
      text: "💱 *Almost done! What currency does your business use?*\n\nThis will be your default for invoices and quotes.",
      buttons: [
        { id: "sup_biz_cur_USD", title: "💵 USD ($)" },
        { id: "sup_biz_cur_ZWL", title: "🇿🇼 ZWL (Z$)" },
        { id: "sup_biz_cur_ZAR", title: "🇿🇦 ZAR (R)" }
      ]
    });
  }

if (a === "sup_del_no") {
    if (!biz) return sendMainMenu(from);
    biz.sessionData.supplierReg = biz.sessionData.supplierReg || {};
    biz.sessionData.supplierReg.delivery = { available: false };
    biz.sessionData.supplierReg.minOrder = 0;
    biz.sessionState = "supplier_reg_biz_currency";
    await saveBizSafe(biz);
    return sendButtons(from, {
      text: "💱 *Almost done! What currency does your business use?*\n\nThis will be your default for invoices and quotes.",
      buttons: [
        { id: "sup_biz_cur_USD", title: "💵 USD ($)" },
        { id: "sup_biz_cur_ZWL", title: "🇿🇼 ZWL (Z$)" },
        { id: "sup_biz_cur_ZAR", title: "🇿🇦 ZAR (R)" }
      ]
    });
  }



  // ── Supplier registration: currency selected → show confirm ──────────────
if (a.startsWith("sup_biz_cur_")) {
  const currency = a.replace("sup_biz_cur_", "").toUpperCase();
  if (!["USD", "ZWL", "ZAR"].includes(currency)) return true;
  if (!biz) return sendMainMenu(from);

  biz.sessionData.supplierReg = biz.sessionData.supplierReg || {};
  biz.sessionData.supplierReg.currency = currency;

  // Pre-fill business name and currency onto the Business record now
  const reg = biz.sessionData.supplierReg;
  if (reg.businessName && (!biz.name || biz.name.startsWith("pending_"))) {
    biz.name = reg.businessName;
  }
  biz.currency = currency;
  biz.isSupplier = true;
  biz.sessionState = "supplier_reg_confirm";
  await saveBizSafe(biz);

  return _sendSupplierConfirmPrompt(from, reg);
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
      businessId: biz._id,                         // ← LINK TO BUSINESS
      location: { city: reg.city || "Harare", area: reg.area || "" },
      address: reg.address || "",
      contactDetails: reg.contactDetails || "",
      website: reg.website || "",
      categories: reg.categories || [],
      products: reg.products || [],
      prices: reg.prices || [],
      delivery: reg.delivery || { available: false },
      minOrder: reg.minOrder || 0,
      profileType: reg.profileType || "product",
      rates: reg.rates || null,
      travelAvailable: reg.travelAvailable ?? null,
      active: false,
      subscriptionStatus: "pending",
      priceUpdatedAt: reg.prices?.length ? new Date() : null
    });

    // Link the supplier profile back onto the Business record
      biz.supplierProfileId = supplier._id;
    biz.isSupplier = true;
    if (reg.businessName && (!biz.name || biz.name.startsWith("pending_"))) {
      biz.name = reg.businessName;
    }
    if (reg.address) {
      biz.address = reg.address;
    }
    if (reg.contactDetails) {
      biz.contactDetails = reg.contactDetails;
    }
    if (reg.website) {
      biz.website = reg.website;
    }
    biz.sessionData.pendingSupplierId = supplier._id.toString();
    biz.sessionState = "supplier_reg_choose_plan";
    await saveBizSafe(biz);

return sendList(from,
`🎉 *Your listing is ready!*

But right now *buyers cannot find you yet.*

To go live and start receiving orders, you need to choose a plan and pay. It's like paying for a market stall - once you pay, your business shows up when buyers search.

💳 *Choose a plan below to activate your listing:*`,
      [
        { id: "sup_plan_basic_monthly", title: "✅ Basic - $5/month", description: "Up to 20 live items. Good to start." },
        { id: "sup_plan_basic_annual", title: "✅ Basic $50/yr", description: "Pay once for the whole year" },
        { id: "sup_plan_pro_monthly", title: "⭐ Pro - $12/month", description: "Up to 60 live items" },
        { id: "sup_plan_pro_annual", title: "⭐ Pro $120/yr", description: "Most popular choice" },
        { id: "sup_plan_featured_monthly", title: "🔥 Featured $25/mo", description: "Top of search - buyers see you first" }
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

  let category = biz?.sessionData?.supplierSearch?.category || null;
  let product = biz?.sessionData?.supplierSearch?.product || null;
  let profileType = biz?.sessionData?.supplierSearch?.type || null;

  if (!category && !product && !profileType) {
    const sess = await UserSession.findOne({ phone });
    category = sess?.tempData?.supplierSearchCategory || null;
    product = sess?.tempData?.supplierSearchProduct || null;
    profileType = sess?.tempData?.supplierSearchType || null;
  }

  const locationLabel = city || "All Cities";

  // OFFER-FIRST SEARCH FLOW (products + services)
  if (product) {
    const supplierResults = await runSupplierSearch({
      city,
      category,
      product,
      profileType,
      area: null
    });

    const normalizedQuery = normalizeProductName(product);
    const directBusinessMatches = supplierResults.filter(s => {
      const businessName = normalizeProductName(s.businessName || "");
      return businessName === normalizedQuery || businessName.includes(normalizedQuery);
    });

    // Only direct-open when there is one clear business-name hit
    if (directBusinessMatches.length === 1) {
      const supplier = directBusinessMatches[0];
      const cart = await getCurrentOrderCart({ biz, phone });

      await persistOrderFlowState({
        biz,
        phone,
        patch: {
          orderSupplierId: String(supplier._id),
          orderBrowseMode: "catalogue",
          orderCataloguePage: 0,
          orderCatalogueSearch: ""
        }
      });

      return _sendSupplierShoppingHub(from, supplier, cart);
    }

    const offerResults = await runSupplierOfferSearch({
      city,
      category,
      product,
      profileType,
      area: null
    });

    // Use offer-level results first for normal product/service searches
    if (offerResults.length) {
      if (biz) {
        biz.sessionData = {
          ...(biz.sessionData || {}),
          supplierSearch: {
            ...(biz.sessionData?.supplierSearch || {}),
            city
          },
          searchResults: offerResults,
          searchPage: 0,
          searchResultMode: "offers"
        };
        await saveBizSafe(biz);
      } else {
        await UserSession.findOneAndUpdate(
          { phone },
          {
            $set: {
              "tempData.searchResults": offerResults,
              "tempData.searchPage": 0,
              "tempData.searchResultMode": "offers"
            }
          },
          { upsert: true }
        );
      }

      const pageResults = offerResults.slice(0, 9);
     const rows = formatSupplierOfferResults(pageResults, product);

      if (offerResults.length > 9) {
        rows.push({ id: "sup_search_next_page", title: `➡ More results (${offerResults.length - 9} more)` });
      }

      return sendList(
        from,
        `🔍 *${product}* in ${locationLabel} - ${offerResults.length} found`,
        rows
      );
    }

    // If there are no offer-level matches, then fall back to supplier-level business matches
    if (directBusinessMatches.length > 1) {
      if (biz) {
        biz.sessionData = {
          ...(biz.sessionData || {}),
          supplierSearch: {
            ...(biz.sessionData?.supplierSearch || {}),
            city
          },
          searchResults: directBusinessMatches,
          searchPage: 0,
          searchResultMode: "suppliers"
        };
        await saveBizSafe(biz);
      } else {
        await UserSession.findOneAndUpdate(
          { phone },
          {
            $set: {
              "tempData.searchResults": directBusinessMatches,
              "tempData.searchPage": 0,
              "tempData.searchResultMode": "suppliers"
            }
          },
          { upsert: true }
        );
      }

      const pageResults = directBusinessMatches.slice(0, 9);
      const rows = formatSupplierResults(pageResults, city, product);

      if (directBusinessMatches.length > 9) {
        rows.push({ id: "sup_search_next_page", title: `➡ More results (${directBusinessMatches.length - 9} more)` });
      }

      return sendList(
        from,
        `🏪 *Business matches for ${product}*${city ? ` in ${city}` : ""} - ${directBusinessMatches.length} found`,
        rows
      );
    }

    return sendButtons(from, {
      text: `😕 No matching offers found for *${product}*${city ? ` in ${city}` : ""}.\n\nTry another search term or city.`,
      buttons: [
        { id: "find_supplier", title: "🔍 Search Again" },
        { id: "suppliers_home", title: "🛒 Marketplace" }
      ]
    });
  }

  // CATEGORY-BROWSE FLOW (category + type, no typed product)
  if (category && profileType) {
    const supplierResults = await runSupplierSearch({
      city,
      category,
      product: null,
      profileType,
      area: null
    });

    if (!supplierResults.length) {
      const label = category.replace(/_/g, " ");
      return sendButtons(from, {
        text: `😕 No matching ${profileType === "service" ? "providers" : "suppliers"} found for *${label}*${city ? ` in ${city}` : ""}.\n\nTry another city or category.`,
        buttons: [
          { id: "find_supplier", title: "🔍 Search Again" },
          { id: "suppliers_home", title: "🛒 Marketplace" }
        ]
      });
    }

    if (biz) {
      biz.sessionData = {
        ...(biz.sessionData || {}),
        supplierSearch: {
          ...(biz.sessionData?.supplierSearch || {}),
          city
        },
        searchResults: supplierResults,
        searchPage: 0,
        searchResultMode: "suppliers"
      };
      await saveBizSafe(biz);
    } else {
      await UserSession.findOneAndUpdate(
        { phone },
        {
          $set: {
            "tempData.searchResults": supplierResults,
            "tempData.searchPage": 0,
            "tempData.searchResultMode": "suppliers"
          }
        },
        { upsert: true }
      );
    }

    const pageResults = supplierResults.slice(0, 9);
    const rows = formatSupplierResults(pageResults, city, null);

    if (supplierResults.length > 9) {
      rows.push({ id: "sup_search_next_page", title: `➡ More results (${supplierResults.length - 9} more)` });
    }

    return sendList(
      from,
      `📂 *${category.replace(/_/g, " ")}* in ${locationLabel} - ${supplierResults.length} found`,
      rows
    );
  }

  return sendButtons(from, {
    text: "❌ Search session expired. Please start again.",
    buttons: [
      { id: "find_supplier", title: "🔍 Search Again" },
      { id: "suppliers_home", title: "🛒 Marketplace" }
    ]
  });
}

if (a.startsWith("sup_offer_pick_")) {
  const raw = a.replace("sup_offer_pick_", "");
  const firstUnderscore = raw.indexOf("_");
  const supplierId = raw.slice(0, firstUnderscore);
  const productName = decodeURIComponent(raw.slice(firstUnderscore + 1));

  const supplier = await SupplierProfile.findById(supplierId).lean();
  if (!supplier) return sendText(from, "❌ Supplier not found.");

   const matched = findMatchingSupplierPrice(supplier, productName);

  let pricePerUnit = typeof matched?.amount === "number" ? matched.amount : null;
  let unit = matched?.unit || (supplier.profileType === "service" ? "job" : "each");

  const selectedItem = {
    product: productName,
    quantity: 1,
    unit,
    pricePerUnit,
    total: pricePerUnit !== null ? Number((1 * pricePerUnit).toFixed(2)) : null
  };

  const cart = await getCurrentOrderCart({ biz, phone });

  await persistOrderFlowState({
    biz,
    phone,
    patch: {
      orderSupplierId: String(supplier._id),
      orderIsService: supplier.profileType === "service",
      orderBrowseMode: "selected_offer",
      orderCatalogueSearch: productName,
      selectedSupplierItem: selectedItem
    }
  });

// For services, skip qty picker - default to 1 and go straight to preview
  if (supplier.profileType === "service") {
    return _sendSelectedSupplierItemPreview(from, supplier, selectedItem, cart, {
      quantity: 1,
      searchTerm: productName
    });
  }

  return _sendSupplierQuantityPicker(from, supplier, selectedItem, cart, {
    backId: "sup_offer_results_back"
  });
}

if (a === "sup_offer_results_back") {
  let allResults = [];
  let currentPage = 0;

  if (biz) {
    allResults = biz.sessionData?.searchResults || [];
    currentPage = biz.sessionData?.searchPage || 0;
  } else {
    const sess = await UserSession.findOne({ phone });
    allResults = sess?.tempData?.searchResults || [];
    currentPage = sess?.tempData?.searchPage || 0;
  }

  if (!allResults.length) {
    return sendButtons(from, {
      text: "❌ Search session expired. Please search again.",
      buttons: [{ id: "find_supplier", title: "🔍 Search Again" }]
    });
  }

  const PAGE_SIZE = 9;
  const start = currentPage * PAGE_SIZE;
  const pageResults = allResults.slice(start, start + PAGE_SIZE);
const rows = formatSupplierOfferResults(pageResults, biz?.sessionData?.supplierSearch?.product || "");

  const hasMore = allResults.length > start + PAGE_SIZE;
  const hasPrev = currentPage > 0;

  if (hasPrev) rows.push({ id: "sup_search_prev_page", title: "⬅ Back" });
  if (hasMore) rows.push({ id: "sup_search_next_page", title: `➡ More (${allResults.length - start - PAGE_SIZE} more)` });

  if (rows.length > 10) rows.splice(10);

  return sendList(
    from,
    `🔎 Matching products\nResults ${start + 1}-${Math.min(start + PAGE_SIZE, allResults.length)} of ${allResults.length}`,
    rows
  );
}


  // ── View supplier detail ───────────────────────────────────────────────────
if (a.startsWith("sup_view_")) {
  const supplierId = a.replace("sup_view_", "");
  const supplier = await SupplierProfile.findById(supplierId).lean();
  if (!supplier) return sendText(from, "❌ Supplier not found.");

  await SupplierProfile.findByIdAndUpdate(supplierId, {
    $inc: { viewCount: 1, monthlyViews: 1 }
  });

  const sess = await UserSession.findOne({ phone });
  const cart = await getCurrentOrderCart({ biz, phone });
  const fromCategoryBrowse = isCategoryBrowseContext({ biz, sess });

  const deliveryText = supplier.profileType === "service"
    ? (supplier.travelAvailable ? "🚗 Mobile service - travels to you" : "📍 Visit required - client comes to provider")
    : (supplier.delivery?.available
        ? `🚚 Delivers (${(supplier.delivery.range || "").replace("_", " ")})`
        : "🏠 Collection only");

  const badge = supplier.topSupplierBadge ? "\n🏅 Top Supplier" : "";
  const tierBadge = supplier.tier === "featured" ? " 🔥" : supplier.tier === "pro" ? " ⭐" : "";
  const offeringLabel = supplier.profileType === "service" ? "🔧" : "📦";
    const offeringText = getSupplierCatalogueSourceItems(supplier)
    .slice(0, 5)
    .map(item => item.priceLabel ? `${item.name} (${item.priceLabel})` : item.name)
    .join(", ");

  if (fromCategoryBrowse) {
    await persistOrderFlowState({
      biz,
      phone,
      patch: {
        orderSupplierId: String(supplier._id),
        orderIsService: supplier.profileType === "service",
        orderBrowseMode: "supplier_shop_hub",
        selectedSupplierItem: null
      }
    });

    return _sendSupplierShoppingHub(from, supplier, cart, {
      fromCategory: true
    });
  }

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
      { id: "find_supplier", title: "🔍 Search Again" }
    ]
  });
}


if (a.startsWith("sup_shop_")) {
  const supplierId = a.replace("sup_shop_", "");
  const supplier = await SupplierProfile.findById(supplierId).lean();
  if (!supplier) return sendText(from, "❌ Supplier not found.");

  const cart = await getCurrentOrderCart({ biz, phone });

  await persistOrderFlowState({
    biz,
    phone,
    patch: {
      orderSupplierId: String(supplier._id),
      orderIsService: supplier.profileType === "service",
      orderBrowseMode: "supplier_shop_hub",
      selectedSupplierItem: null
    }
  });

  return _sendSupplierShoppingHub(from, supplier, cart, {
    fromCategory: true
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


if (a === "sup_quick_edit_products") {
  const supplier = await SupplierProfile.findOne({ phone });
  if (!supplier) return sendSuppliersMenu(from);

  if (!supplier.active) {
    await sendText(from, "🔒 *Activate your listing first.*\n\nYou can edit products after your listing is live.");
    return sendSupplierUpgradeMenu(from, supplier.tier);
  }

  const isService = supplier.profileType === "service";
  const items = (supplier.products || []).filter(p => p !== "pending_upload");

  if (!items.length) {
    return sendText(from, `❌ No ${isService ? "services" : "products"} listed yet.`);
  }

  if (biz) {
    biz.sessionState = "supplier_quick_edit_products";
    await saveBizSafe(biz);
  }

   await sendSupplierItemsInChunks(
    from,
    items,
    `⚡ Quick Edit ${isService ? "Services" : "Products"}`
  );

  return sendSupplierQuickEditHelp(from, isService);

}
  // ── Update supplier prices ─────────────────────────────────────────────────
if (a === "sup_update_prices") {
  const supplier = await SupplierProfile.findOne({ phone });
  if (!supplier) return sendSuppliersMenu(from);

  if (!supplier.active) {
    await sendText(from, "🔒 *Activate your listing first.*\n\nYou can update prices after your listing is live.");
    return sendSupplierUpgradeMenu(from, supplier.tier);
  }

  const isService = supplier.profileType === "service";
  const products = (supplier.products || []).filter(p => p !== "pending_upload");

 if (biz) {
  biz.sessionData = {
    ...(biz.sessionData || {}),
    updatingPrices: true
  };
  biz.sessionState = "supplier_update_prices";
  await saveBizSafe(biz);
}

await UserSession.findOneAndUpdate(
  { phone },
  {
    $set: {
      "tempData.supplierAccountState": "supplier_update_prices",
      "tempData.pendingPriceUpdate": [],
      "tempData.supplierAccountType": isService ? "service" : "product"
    },
    $unset: {
      "tempData.supplierSearchMode": "",
      "tempData.supplierSearchProduct": "",
      "tempData.supplierSearchCategory": "",
      "tempData.searchResults": "",
      "tempData.searchPage": "",
      "tempData.lastSearchCity": ""
    }
  },
  { upsert: true }
);

 
  if (!products.length) {
    return sendButtons(from, {
      text: "❌ Add your products first before setting prices.",
      buttons: [{ id: "sup_edit_products", title: "✏️ Add Products" }]
    });
  }

  // ── Send numbered list in chunks of 25 (each chunk safely under 4096) ────
  const listedSet = new Set(
    (supplier.listedProducts || []).filter(Boolean).map(p => normalizeProductName(p))
  );
  const listedProducts   = products.filter(p => listedSet.has(normalizeProductName(p)));
  const unlistedProducts = products.filter(p => !listedSet.has(normalizeProductName(p)));

  function buildPriceLines(items, startIndex) {
    const CHUNK = 25;
    const lines = [];
    for (let i = 0; i < items.length; i++) {
      const p = items[i];
      const globalIdx = startIndex + i;
      const existing = isService
        ? supplier.rates?.find(r => r.service?.toLowerCase() === p.toLowerCase())
        : supplier.prices?.find(pr => pr.product?.toLowerCase() === p.toLowerCase());
      const priceStr = isService
        ? (existing ? ` - ${existing.rate}` : " - _(not set)_")
        : (existing ? ` - $${Number(existing.amount).toFixed(2)}/${existing.unit}` : " - _(not set)_");
      lines.push(`${globalIdx + 1}. ${p}${priceStr}`);
    }
    return lines;
  }

  // ── Section 1: Live (listed) items ───────────────────────────────────────
  if (listedProducts.length) {
    const lines = buildPriceLines(listedProducts, 0);
    const CHUNK = 25;
    for (let i = 0; i < lines.length; i += CHUNK) {
      const chunk = lines.slice(i, i + CHUNK).join("\n");
      const isFirst = i === 0;
      const isLast  = i + CHUNK >= lines.length;
      await sendText(from,
        isFirst
          ? `💰 *Update ${isService ? "Rates" : "Prices"}*\n\n🟢 *Live ${isService ? "Services" : "Products"} (${listedProducts.length})*\n\n${chunk}${isLast ? "" : "\n_(continued...)_"}`
          : `${chunk}${isLast ? "" : "\n_(continued...)_"}`
      );
    }
  }

  // ── Section 2: Unlisted items ────────────────────────────────────────────
  if (unlistedProducts.length) {
    const lines = buildPriceLines(unlistedProducts, listedProducts.length);
    const CHUNK = 25;
    for (let i = 0; i < lines.length; i += CHUNK) {
      const chunk = lines.slice(i, i + CHUNK).join("\n");
      const isFirst = i === 0;
      const isLast  = i + CHUNK >= lines.length;
      await sendText(from,
        isFirst
          ? `⚪ *Unlisted ${isService ? "Services" : "Products"} (${unlistedProducts.length} - not visible to buyers)*\n\n${chunk}${isLast ? "" : "\n_(continued...)_"}`
          : `${chunk}${isLast ? "" : "\n_(continued...)_"}`
      );
    }
  }

  return sendSupplierQuickPriceHelp(from, products, isService);
}


if (biz?.sessionState === "supplier_quick_edit_products" && !isMetaAction) {
  const supplier = await SupplierProfile.findOne({ phone });
  if (!supplier) return sendSuppliersMenu(from);

  const isService = supplier.profileType === "service";
  const items = (supplier.products || []).filter(p => p !== "pending_upload");
  if (!items.length) {
    biz.sessionState = "ready";
    await saveBizSafe(biz);
    await sendText(from, `❌ No ${isService ? "services" : "products"} listed.`);
    return sendSupplierAccountMenu(from, supplier);
  }

  const raw = (text || "").trim();

  // 1) rename: 5=new name
  const renameCmd = parseQuickRenameCommand(raw, items);
  if (renameCmd) {
    const oldName = items[renameCmd.index];
    const nextItems = [...items];
    nextItems[renameCmd.index] = renameCmd.newName;

    supplier.products = dedupeSupplierItems(nextItems);

    if (isService) {
      supplier.rates = (supplier.rates || []).map(r => {
        if (normalizeProductName(r.service) === normalizeProductName(oldName)) {
          return { ...r.toObject?.() || r, service: renameCmd.newName };
        }
        return r;
      });
    } else {
      supplier.prices = (supplier.prices || []).map(pr => {
        if (normalizeProductName(pr.product) === normalizeProductName(oldName)) {
          return { ...pr.toObject?.() || pr, product: renameCmd.newName };
        }
        return pr;
      });
    }

       await supplier.save();

    await sendText(from, `✅ Renamed:\n• ${oldName}\n→ ${renameCmd.newName}`);
    await sendSupplierItemsInChunks(
      from,
      supplier.products,
      `📋 Updated ${isService ? "Services" : "Products"}`
    );
    await sendSupplierQuickEditHelp(from, isService);
    return true;
  }

  // 2) delete: del 5,8,10
  const deleteIndexes = parseQuickDeleteCommand(raw, items);
  if (deleteIndexes.length) {
    const removed = deleteIndexes.map(i => items[i]);
    const remaining = items.filter((_, i) => !deleteIndexes.includes(i));

    supplier.products = remaining;
    if (isService) {
      supplier.rates = filterRatesForRemainingServices(supplier.rates || [], remaining);
    } else {
      supplier.prices = filterPricesForRemainingProducts(supplier.prices || [], remaining);
    }

     await supplier.save();

    await sendText(
      from,
      `✅ Deleted *${removed.length}* ${isService ? "service" : "product"}${removed.length === 1 ? "" : "s"}:\n${removed.map(p => `• ${p}`).join("\n")}`
    );

    if (remaining.length) {
      await sendSupplierItemsInChunks(
        from,
        remaining,
        `📋 Remaining ${isService ? "Services" : "Products"}`
      );
      await sendSupplierQuickEditHelp(from, isService);
      return true;
    }

    await sendText(from, `ℹ️ No ${isService ? "services" : "products"} left.`);
    await sendSupplierQuickEditHelp(from, isService);
    return true;
  }

  // 3) add: add hammer, pliers
  const addItems = parseQuickAddCommand(raw);
  if (addItems.length) {
    const merged = dedupeSupplierItems([...items, ...addItems]);
    const addedCount = merged.length - items.length;

       supplier.products = merged;
    await supplier.save();

    await sendText(
      from,
      `✅ Added *${addedCount}* ${isService ? "service" : "product"}${addedCount === 1 ? "" : "s"}.\n\nTotal now: *${merged.length}*`
    );

    await sendSupplierItemsInChunks(
      from,
      merged,
      `📋 Updated ${isService ? "Services" : "Products"}`
    );
    await sendSupplierQuickEditHelp(from, isService);
    return true;
  }

  await sendText(
    from,
`❌ I couldn't read that quick edit command.

Use:
_5=new name_
_del 5,8,10_
_add hammer, pliers_

Type *cancel* to go back.`
  );
  return true;
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

    const isService = supplier.profileType === "service";
  const products = (supplier.products || []).filter(p => p !== "pending_upload");
  const parts = raw.split(/[,\n]+/).map(s => s.trim()).filter(Boolean);
  const allNumbers = parts.length > 0 && parts.every(s => /^\d+(\.\d+)?$/.test(s));
  const updated = [];
  const failed = [];

  // Supports:
  // 75 x 3.50
  // 5,7,9 x 3.50
  // 20-30 x 1.25
  // 5 x 3.50, 7 x 4.20
  // 3 x 20/job
  const quick = parseQuickPriceUpdates(raw, products, isService);



 if (quick.matchedAny) {
  quick.updates.forEach(u => {
    updated.push({
      product: u.product.toLowerCase(),
      amount: u.amount,
      unit: u.unit,
      inStock: true
    });
  });

  failed.push(...quick.failed);
}
else if (allNumbers) {
    // Strategy 1: numbers in order
    if (parts.length !== products.length) {
      const numbered = products.map((p, i) => `${i + 1}. ${p}`).join("\n");
      await sendText(from,
`❌ You have *${products.length} product${products.length > 1 ? "s" : ""}* but sent *${parts.length} price${parts.length > 1 ? "s" : ""}*.

Send one price per ${isService ? "service" : "product"} in order:
${numbered}

Example: *${products.slice(0, 3).map((_, i) => ((i + 1) * 10)).join(", ")}*`
      );
      return true;
    }
    parts.forEach((numStr, i) => {
      updated.push({
        product: products[i].toLowerCase(),
        amount: parseFloat(numStr),
        unit: isService ? "job" : "each",  // ← FIX: services get "job" not "each"
        inStock: true
      });
    });
 } else {
    // Strategy 2: named pricing OR rate-style "NUMBER/UNIT" format
    for (const line of parts) {
      const clean = line
        .replace(/^[-•*►▪✓]\s*/, "")
        .replace(/^\d+[.)]\s*/, "")
        .replace(/\$/g, "")
        .trim();

      if (!clean) continue;

      // ── Strategy 2a: "NUMBER/UNIT" format e.g. "20/job", "50/hr", "15/trip" ──
      // This is how service suppliers naturally type rates - number/unit without name
      // We assign them positionally to the products list (in order)
      const rateOnlyMatch = clean.match(/^(\d+(?:\.\d+)?)\/([a-zA-Z]+)$/);
      if (rateOnlyMatch) {
        const posIdx = updated.length; // assign to next product in order
        if (posIdx < products.length) {
          updated.push({
            product: products[posIdx].toLowerCase(),
            amount: parseFloat(rateOnlyMatch[1]),
            unit: rateOnlyMatch[2].toLowerCase(),
            inStock: true
          });
        } else {
          failed.push(line); // more rates than products
        }
        continue;
      }

      // ── Strategy 2b: named pricing e.g. "burst pipe repair: 20", "plumbing 50/hr" ──
      let match =
        clean.match(/^(.+?)\s*[:]\s*(\d+(?:\.\d+)?)\s*([a-zA-Z/]*)$/) ||
        clean.match(/^(.+?)\s+(\d+(?:\.\d+)?)\s*([a-zA-Z/]*)$/);

      if (!match) { failed.push(line); continue; }

      const product = match[1].replace(/[$@\-:,]+$/, "").trim().toLowerCase();
      const amount = parseFloat(match[2]);
      // Parse unit: "50/hr" → "hr", "50" alone → default based on type
      const rawUnit = match[3]?.trim().toLowerCase() || "";
      const unit = rawUnit
        ? rawUnit.replace(/^\//, "") // strip leading slash if any
        : (isService ? "job" : "each");  // ← FIX: services default to "job"

      if (!product || isNaN(amount)) { failed.push(line); continue; }
      updated.push({ product, amount, unit, inStock: true });
    }
  }

    if (!updated.length) {
    const numbered = products.map((p, i) => `${i + 1}. ${p}`).join("\n");
    await sendText(from,
`❌ Couldn't read your prices.

*Your items:*
${numbered}

Try any of these:

*Single item:*
_75 x 3.50_
${isService ? `_3 x 20/job_` : ""}

*Same price for selected items:*
_5,7,9 x 3.50_

*Same price for a range:*
_20-30 x 1.25_

*Mixed updates:*
_5 x 3.50, 7 x 4.20${isService ? ", 9 x 15/job" : ""}_

*Update ALL in order:*
_${products.slice(0, 3).map((_, i) => (((i + 1) * 4)).toFixed(2)).join(", ")}_

*Update selected items by name:*
_${products.slice(0, 2).map(p => `${p}: 6.00`).join(", ")}_

Type *cancel* to go back.`
    );
    return true;
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


// ── Supplier confirms price they just entered ─────────────────────────────
  if (a === "sup_price_confirm_yes") {
    const orderId = biz?.sessionData?.pricingOrderId;
    const pendingPrices = biz?.sessionData?.pendingPrices;

    if (!orderId || !pendingPrices?.length) {
      biz.sessionState = "ready";
      biz.sessionData = {};
      await saveBizSafe(biz);
      await sendText(from, "❌ Pricing session expired. Please check the order and try again.");
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

  const supplier = await SupplierProfile.findOne({ phone: from }).lean();
const isServiceSupplier = supplier?.profileType === "service";
const missingIndexes = biz?.sessionData?.pricingMissingIndexes || [];

// Apply prices only to missing items
for (let i = 0; i < missingIndexes.length; i++) {
  const idx = missingIndexes[i];
  const item = order.items[idx];
  const qty = Number(item.quantity) || 1;
  const unitPrice = Number(pendingPrices[i]);

  order.items[idx] = {
    ...item.toObject?.() || item,
    pricePerUnit: unitPrice,
    total: Number((qty * unitPrice).toFixed(2)),
    currency: "USD"
  };
}

const grandTotal = order.items.reduce((sum, item) => sum + Number(item.total || 0), 0);

order.totalAmount = Number(grandTotal.toFixed(2));
order.currency = "USD";
order.status = "accepted";
await order.save();

    await SupplierProfile.findOneAndUpdate(
      { phone: from },
      { $inc: { monthlyOrders: 1, completedOrders: 1 } }
    );

    biz.sessionState = "ready";
    biz.sessionData = {};
    await saveBizSafe(biz);

    // Build confirmed item lines for buyer notification
    const itemLines = order.items.map(i => {
      const unitLabel = i.unit && i.unit !== "units" ? i.unit : (isServiceSupplier ? "job" : "unit");
      return `• ${i.product} × ${i.quantity} ${unitLabel} @ $${Number(i.pricePerUnit).toFixed(2)} = *$${Number(i.total).toFixed(2)}*`;
    }).join("\n");

    const deliveryLine = order.delivery?.required
      ? `🚚 Delivery to: ${order.delivery.address}`
      : isServiceSupplier
        ? `📍 Location: ${order.delivery?.address || "TBC"}`
        : `🏠 Collection`;

    // Notify buyer
    try {
      await sendButtons(order.buyerPhone, {
        text:
          `✅ *${isServiceSupplier ? "Booking" : "Order"} Accepted!*\n\n` +
          `*${supplier?.businessName || from}* has accepted your ${isServiceSupplier ? "booking" : "order"}:\n\n` +
          `${itemLines}\n\n` +
          `${deliveryLine}\n` +
          `💵 *Total: $${grandTotal.toFixed(2)}*\n` +
          `📞 Contact: ${from}\n\n` +
          `They will be in touch to arrange ${isServiceSupplier ? "the service" : "payment & delivery"}.`,
        buttons: [
          { id: `rate_order_${order._id}`, title: isServiceSupplier ? "⭐ Rate Service" : "⭐ Rate Order" },
          { id: "suppliers_home",          title: "🏪 Suppliers" }
        ]
      });
    } catch (err) {
      console.error("[SUPPLIER PRICE CONFIRM → BUYER NOTIFY FAILED]", err?.response?.data || err.message);
    }

    // Ask supplier for ETA
// Ask supplier for ETA -include delivery address so they have it handy
   // Ask supplier for ETA - include delivery address so they have it handy
    const confirmDeliveryLine = order.delivery?.required
      ? `🚚 *Deliver to:* ${order.delivery.address}`
      : isServiceSupplier
        ? `📍 *Service location:* ${order.delivery?.address || "TBC"}`
        : `🏠 *Collection* (buyer will pick up)`;

    // ── Generate PDF order summary and send to supplier ───────────────────
  // ── Generate ORDER PDF and send to supplier ───────────────────────────
    try {
      const orderRef = `ORD-${String(order._id).slice(-8).toUpperCase()}`;
      const deliveryNote = order.delivery?.required
        ? `Deliver to: ${order.delivery.address}`
        : isServiceSupplier
          ? `Service location: ${order.delivery?.address || "TBC"}`
          : "Collection - buyer will pick up";
      const { filename } = await generatePDF({
        type: "order",
        number: orderRef,
        date: new Date(),
        billingTo: `Buyer: ${order.buyerPhone}\n${deliveryNote}`,
        items: order.items.map(i => ({
          item: i.product,
          qty: Number(i.quantity) || 1,
          unit: Number(i.pricePerUnit || 0),
          total: Number(i.total || 0)
        })),
        bizMeta: {
          name: supplier?.businessName || from,
          logoUrl: "",
          address: `${supplier?.location?.area || ""}, ${supplier?.location?.city || ""}`,
          _id: String(order._id),
          status: "accepted"
        }
      });
      const site = (process.env.SITE_URL || "").replace(/\/$/, "");
      await sendDocument(from, { link: `${site}/docs/generated/orders/${filename}`, filename });
    } catch (pdfErr) {
      console.error("[PRICE CONFIRM PDF]", pdfErr.message);
    }

    return sendList(from,
      `✅ *${isServiceSupplier ? "Booking" : "Order"} confirmed at $${grandTotal.toFixed(2)}.*\n\n${confirmDeliveryLine}\n\n${isServiceSupplier ? "When will you do the job?" : "When will the order be ready?"}`,
      [
        { id: `sup_eta_today_${orderId}`,    title: "Today" },
        { id: `sup_eta_tomorrow_${orderId}`, title: "Tomorrow" },
        { id: `sup_eta_twodays_${orderId}`,  title: "2-3 days" },
        { id: `sup_eta_contact_${orderId}`,  title: "I'll contact buyer" }
      ]
    );

  }

  // ── Supplier wants to re-enter prices ─────────────────────────────────────
  if (a === "sup_price_confirm_no") {
    const orderId = biz?.sessionData?.pricingOrderId;
    if (!orderId) return sendSuppliersMenu(from);

    const order = await SupplierOrder.findById(orderId).lean();
    if (!order) return sendSuppliersMenu(from);

    const isServiceSupplier = (await SupplierProfile.findOne({ phone: from }).lean())?.profileType === "service";

    // Reset to enter_price state, clear pending prices
const missingPriceIndexes = (order.items || [])
  .map((item, idx) => (
    typeof item.pricePerUnit === "number" && !Number.isNaN(item.pricePerUnit)
      ? null
      : idx
  ))
  .filter(idx => idx !== null);

biz.sessionState = "supplier_order_enter_price";
biz.sessionData = {
  ...(biz.sessionData || {}),
  pricingOrderId: orderId,
  pricingMissingIndexes: missingPriceIndexes
};
await saveBiz(biz);

  // ── Clear any stale buyer/picking session state for this phone.

  // ── Clear any stale buyer/picking session state for this phone.
  // This prevents the supplier's typed price input (e.g. "12") from being
  // misrouted to the cart picking handler due to stale UserSession data.
  const UserSession = (await import("../models/userSession.js")).default;
  await UserSession.findOneAndUpdate(
    { phone: from.replace(/\D+/g, "") },
    {
      $unset: {
        "tempData.orderState":      "",
        "tempData.orderSupplierId": "",
        "tempData.orderCart":       "",
        "tempData.orderIsService":  "",
        "tempData.orderItems":      ""
      }
    }
  );

  // Build a numbered pricing form -each line shows exactly what needs a price

    // Show the pricing form again
 const pricedItems = (order.items || []).filter(
  item => typeof item.pricePerUnit === "number" && !Number.isNaN(item.pricePerUnit)
);

const pricingTargets = (order.items || []).filter(
  item => !(typeof item.pricePerUnit === "number" && !Number.isNaN(item.pricePerUnit))
);

const pricingLines = pricingTargets.map((item, i) => {
  const qty = Number(item.quantity) || 1;
  const unitLabel = item.unit && item.unit !== "units"
    ? item.unit
    : (isServiceSupplier ? "job" : "unit");

  return `${i + 1}. *${item.product}* × ${qty} ${unitLabel}\n   → Your price per ${unitLabel}: ❓`;
}).join("\n\n");

const alreadyPricedLines = pricedItems.length
  ? pricedItems.map(item => {
      const qty = Number(item.quantity) || 1;
      const unitLabel = item.unit && item.unit !== "units"
        ? item.unit
        : (isServiceSupplier ? "job" : "unit");
      const lineTotal =
        typeof item.total === "number"
          ? item.total
          : qty * Number(item.pricePerUnit || 0);

      return `✅ ${item.product} × ${qty} ${unitLabel} @ $${Number(item.pricePerUnit).toFixed(2)} = $${Number(lineTotal).toFixed(2)}`;
    }).join("\n")
  : "";

const firstItem = pricingTargets[0];
const firstQty = Number(firstItem?.quantity) || 1;
const firstUnit = firstItem?.unit && firstItem.unit !== "units"
  ? firstItem.unit
  : (isServiceSupplier ? "job" : "unit");

let instructions;

if (pricingTargets.length === 1) {
  instructions =
    `💡 *Enter the price only for the missing item.*\n\n` +
    `Example: If *${firstItem?.product}* costs *$12* per ${firstUnit},\n` +
    `and the buyer wants *${firstQty}*, total = *$${12 * firstQty}*.\n\n` +
    `So just type: *12*`;
} else {
  const examplePrices = pricingTargets.map((_, i) => ((i + 1) * 5 + 7)).join(", ");
  const exampleLines = pricingTargets.map((item, i) => {
    const qty = Number(item.quantity) || 1;
    const unitPrice = (i + 1) * 5 + 7;
    const exUnit = item.unit && item.unit !== "units"
      ? item.unit
      : (isServiceSupplier ? "job" : "unit");
    return `  ${i + 1}. ${item.product}: $${unitPrice}/per ${exUnit} × ${qty} = $${unitPrice * qty}`;
  }).join("\n");

  instructions =
    `💡 *Enter price per unit only for the missing items, in order, separated by commas.*\n\n` +
    `Example: *${examplePrices}*\n` +
    `That means:\n${exampleLines}\n\n` +
    `_${pricingTargets.length} price${pricingTargets.length > 1 ? "s" : ""}, separated by commas_`;
}

const pricingDeliveryLine = order.delivery?.required
  ? `🚚 *Deliver to:* ${order.delivery.address}`
  : isServiceSupplier
    ? `📍 *Service location:* ${order.delivery?.address || "TBC"}`
    : `🏠 *Collection* (buyer will pick up)`;

return sendButtons(from, {
  text:
    `✏️ *Re-enter Your Prices*\n` +
    `_Buyer: ${order.buyerPhone}_\n\n` +
    `─────────────────\n` +
    (alreadyPricedLines
      ? `*Already priced:*\n${alreadyPricedLines}\n\n─────────────────\n`
      : "") +
    `*Still needs pricing:*\n\n` +
    `${pricingLines}\n\n` +
    `─────────────────\n` +
    `${pricingDeliveryLine}\n\n` +
    `─────────────────\n` +
    `${instructions}`,
  buttons: [{ id: "suppliers_home", title: "⬅ Cancel" }]
});
  }



// ── Registration: confirm saved price update (no-biz supplier flow) ────────
// ── Registration / supplier account: confirm saved price update ───────────
if (a === "sup_price_update_confirm" && (!biz || isGhostSupplierBiz)) {
  const sess = await UserSession.findOne({ phone });
  const regState = sess?.supplierRegState;
  const reg = sess?.supplierRegData || {};
  const accountState = sess?.tempData?.supplierAccountState;

  // 1) Registration flow confirm
  if (regState === "supplier_reg_prices") {
    const pending = reg.pendingPriceUpdate || [];

    if (!pending.length) {
      await sendText(from, "❌ No pending prices found. Please re-enter.");
      return true;
    }

    const isService = reg.profileType === "service";

    await UserSession.findOneAndUpdate(
      { phone },
      {
        $set: {
          "supplierRegData.prices": isService ? [] : pending,
          "supplierRegData.rates": isService
            ? pending.map(u => ({ service: u.product, rate: `${u.amount}/${u.unit}` }))
            : [],
          "supplierRegData.pendingPriceUpdate": [],
          supplierRegState: isService ? "supplier_reg_travel" : "supplier_reg_delivery"
        }
      },
      { upsert: true }
    );

    if (isService) {
      return sendButtons(from, {
        text: "✅ *Rates saved!*\n\n🚗 *Do you travel to clients?*",
        buttons: [
          { id: "sup_travel_yes", title: "✅ Yes I Travel" },
          { id: "sup_travel_no", title: "🏠 Client Comes to Me" }
        ]
      });
    }

    return sendButtons(from, {
      text: "✅ *Prices saved!*\n\n🚚 *Do you deliver?*",
      buttons: [
        { id: "sup_del_yes", title: "✅ Yes I Deliver" },
        { id: "sup_del_no", title: "🏠 Collection Only" }
      ]
    });
  }

  // 2) Supplier account price update confirm
  if (accountState === "supplier_update_prices") {
    const supplier = await SupplierProfile.findOne({ phone });
    if (!supplier) return sendSuppliersMenu(from);

    const pending = sess?.tempData?.pendingPriceUpdate || [];

    if (!pending.length) {
      await sendText(from, "❌ No pending prices found. Please re-enter.");
      return true;
    }

if (supplier.profileType === "service") {
  const existingRates = Array.isArray(supplier.rates) ? [...supplier.rates] : [];

  for (const u of pending) {
    const idx = existingRates.findIndex(r =>
      String(r?.service || "").toLowerCase() === String(u.product || "").toLowerCase()
    );

    const nextRate = {
      service: u.product,
      rate: `${u.amount}/${u.unit}`
    };

    if (idx >= 0) existingRates[idx] = nextRate;
    else existingRates.push(nextRate);
  }

  supplier.rates = existingRates;
  supplier.markModified("rates");
} else {
  const existingPrices = Array.isArray(supplier.prices) ? [...supplier.prices] : [];

  for (const u of pending) {
    const idx = existingPrices.findIndex(p =>
      String(p?.product || "").toLowerCase() === String(u.product || "").toLowerCase()
    );

    const nextPrice = {
      ...(idx >= 0 && existingPrices[idx]?._id ? { _id: existingPrices[idx]._id } : {}),
      product: u.product,
      amount: Number(u.amount),
      currency: "USD",
      unit: u.unit || "each",
      inStock: u.inStock !== false
    };

    if (idx >= 0) existingPrices[idx] = nextPrice;
    else existingPrices.push(nextPrice);
  }

  supplier.prices = existingPrices;
  supplier.markModified("prices");
}

supplier.priceUpdatedAt = new Date();
await supplier.save();

    await UserSession.findOneAndUpdate(
      { phone },
      {
        $unset: {
          "tempData.supplierAccountState": "",
          "tempData.pendingPriceUpdate": "",
          "tempData.supplierAccountType": ""
        }
      }
    );

    if (biz && isGhostSupplierBiz) {
      biz.sessionState = "ready";
      biz.sessionData = {};
      await saveBizSafe(biz);
    }

    await sendText(
      from,
      `✅ Your ${supplier.profileType === "service" ? "rates" : "prices"} were updated.`
    );
    return sendSupplierAccountMenu(from, supplier);
  }
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


  // ── Buyer types item name while browsing catalogue (supplier_order_picking) ──
// Handles both biz session and no-biz UserSession
// ── Buyer types while browsing catalogue (supplier_order_picking) ──────────
const pickingStateBiz = biz?.sessionState === "supplier_order_picking";

// ── IMPORTANT: Never let stale UserSession picking state interfere when
// the supplier's biz session is in price-entry or confirm-price mode.
// This prevents "12" being treated as a product name instead of a price.
const supplierIsPricingOrder =
  biz?.sessionState === "supplier_order_enter_price" ||
  biz?.sessionState === "supplier_order_confirm_price";

const pickingStateSess = await (async () => {
  if (pickingStateBiz) return null;
  if (supplierIsPricingOrder) return null; // ← KEY FIX: biz pricing takes priority
  const s = await UserSession.findOne({ phone });
  return s?.tempData?.orderState === "supplier_order_picking" ? s : null;
})();

if (
  !isMetaAction &&
  (
    (biz && biz.sessionState === "supplier_order_picking") ||
    (!biz && pickingStateSess?.tempData?.orderState === "supplier_order_picking")
  )
) {


  const raw = text.trim();
  if (!raw || raw.length < 1) return;

  const rawLower = raw.toLowerCase();

  // ── CANCEL ──────────────────────────────────────────────────────────────
  if (rawLower === "cancel") {
    if (biz) { biz.sessionState = "ready"; biz.sessionData = {}; await saveBizSafe(biz); }
    await UserSession.findOneAndUpdate({ phone }, {
      $unset: { "tempData.orderState": "", "tempData.orderSupplierId": "", "tempData.orderCart": "", "tempData.orderIsService": "" }
    });
    await sendText(from, "❌ Order cancelled.");
    return sendButtons(from, {
      text: "What would you like to do next?",
      buttons: [
        { id: "find_supplier", title: "🔍 Browse & Shop" },
        { id: "my_orders",     title: "📋 My Orders" }
      ]
    });
  }

const supplierId = biz?.sessionData?.orderSupplierId
    || pickingStateSess?.tempData?.orderSupplierId;
  if (!supplierId) return;

  const supplier = await SupplierProfile.findById(supplierId).lean();
  if (!supplier) return;

  const isService = supplier.profileType === "service";

  let cart = [...(biz?.sessionData?.orderCart
    || pickingStateSess?.tempData?.orderCart
    || [])];

  // ── Rebuild source items for numbered selection (Option C) ────────────────
const currentSearchTerm =
  biz?.sessionData?.orderCatalogueSearch ??
  pickingStateSess?.tempData?.orderCatalogueSearch ??
  "";

const sourceItems = getFilteredSupplierCatalogueItems(supplier, currentSearchTerm).map(item => ({
  id: item.name,
  label: item.name,
  price: item.priceLabel || null
}));

  // ── NUMBERED ITEM SELECTION: "1x5, 3x2" or "1x5" or "1 x 5" ─────────────
  // Matches patterns like: 1x5  1x5,3x2  1x5, 3x2  1 x 5  1:5
const numberedSelectionPattern = /^\d+\s*[x:]\s*\d/i;
if (numberedSelectionPattern.test(rawLower.trim())) {
  const pairs = raw.match(/(\d+)\s*[xX:]\s*(\d+(?:\.\d+)?)/g);

  if (pairs && pairs.length) {
    const errors = [];

    for (const pair of pairs) {
      const m = pair.match(/(\d+)\s*[xX:]\s*(\d+(?:\.\d+)?)/);
      if (!m) continue;

      const itemNum = parseInt(m[1]);
      const qty = parseFloat(m[2]);

      if (itemNum < 1 || itemNum > sourceItems.length) {
        errors.push(`❌ No item #${itemNum} -list has ${sourceItems.length} items`);
        continue;
      }

   const selectedItem = sourceItems[itemNum - 1];
const match = findMatchingSupplierPrice(supplier, selectedItem.id);

const cartProduct = match?.product || selectedItem.id;
const cartUnit = match?.unit || (isService ? "job" : "each");
const cartPrice = typeof match?.amount === "number" ? match.amount : null;

const existing = cart.find(c => c.product.toLowerCase() === cartProduct.toLowerCase());

if (existing) {
  existing.quantity += qty;
  if (existing.pricePerUnit !== null && existing.pricePerUnit !== undefined) {
    existing.total = existing.quantity * existing.pricePerUnit;
  }
} else {
  cart.push({
    product: cartProduct,
    quantity: qty,
    unit: cartUnit,
    pricePerUnit: cartPrice,
    total: cartPrice !== null ? qty * cartPrice : null
  });
}
    }

    if (errors.length) {
      await sendText(from, errors.join("\n") + `\n\nList has ${sourceItems.length} items. Check the product list above.`);
    }

    if (biz) {
      biz.sessionData = { ...(biz.sessionData || {}), orderCart: cart };
      await saveBizSafe(biz);
    }

    await UserSession.findOneAndUpdate(
      { phone },
      { $set: { "tempData.orderCart": cart } },
      { upsert: true }
    );

    await persistOrderFlowState({
      biz,
      phone,
      patch: {
        orderBrowseMode: "cart",
        orderSupplierId: String(supplier._id),
        orderCart: cart
      }
    });

    return _sendSupplierCartMenu(from, supplier, cart);
  }
}


  // ── CONFIRM shortcut ─────────────────────────────────────────────────────
if (rawLower === "confirm" || rawLower === "done" || rawLower === "send") {
    if (!cart.length) {
      return sendText(from, "❌ Your cart is empty. Tap items or type to add them first.");
    }
    // For collection-only product suppliers, route straight to sup_cart_confirm_
    // which will skip the address step automatically
  // Only ask for address if: product supplier with delivery, OR service supplier who travels to clients
const needsAddress = (isService && supplier.travelAvailable) || (!isService && supplier.delivery?.available);
    if (!needsAddress) {
      // Redirect to the confirm handler which handles collection-only path
      return handleIncomingMessage({ from, action: `sup_cart_confirm_${supplierId}` });
    }
    if (biz) {
      biz.sessionState = "supplier_order_address";
      await saveBizSafe(biz);
    }
    await UserSession.findOneAndUpdate(
      { phone },
      { $set: { "tempData.orderState": "supplier_order_address" } },
      { upsert: true }
    );
    const previewLines = cart.map(c => {
      const priceStr = c.pricePerUnit ? ` -$${(c.quantity * c.pricePerUnit).toFixed(2)}` : "";
      return `• ${c.product} ×${c.quantity}${priceStr}`;
    }).join("\n");
    const knownTotal = cart.filter(c=>c.pricePerUnit).reduce((s,c)=>s+(c.quantity*c.pricePerUnit),0);
    const totalLine = knownTotal > 0 ? `\n💵 *Estimated total: $${knownTotal.toFixed(2)}*` : "";
    return sendButtons(from, {
      text:
`${isService ? "📅" : "🛒"} *${isService ? "Booking" : "Order"} Summary*

${previewLines}${totalLine}

─────────────────
⚠️ *Your order has NOT been sent yet.*
─────────────────

*Step 2 of 2 -Enter your ${isService ? "location" : "delivery address"}* 👇

${isService
  ? `📍 *Add a contact note for the provider:*\n\nExamples:\n• _Call me on arrival_\n• _Preferred time: Mon 10am_\n• _+263 7XX XXX XXX_`
  : `📍 *Where should we deliver?*\n\nExamples:\n• _123 Samora Machel Ave, Harare_\n• _I will collect - call me_`}
_Type your address below and send_ ✍️`,
   buttons: [
        ...(isService ? [{ id: `sup_skip_note_${supplierId}`, title: "⏭ Skip & Send" }] : []),
        { id: `sup_cart_clear_${supplierId}`, title: "✏️ Edit Order" },
        { id: "find_supplier", title: "❌ Cancel" }
      ].slice(0, 3)
    });
  }

  // ── CLEAR cart ───────────────────────────────────────────────────────────
 // ── CLEAR cart ───────────────────────────────────────────────────────────
if (rawLower === "clear") {
  cart = [];

  if (biz) {
    biz.sessionData = { ...(biz.sessionData || {}), orderCart: [] };
    await saveBizSafe(biz);
  }

  await UserSession.findOneAndUpdate(
    { phone },
    { $set: { "tempData.orderCart": [] } },
    { upsert: true }
  );

  await persistOrderFlowState({
    biz,
    phone,
    patch: {
      orderBrowseMode: "cart",
      orderSupplierId: String(supplier._id),
      orderCart: []
    }
  });

  await sendText(from, "🗑 Cart cleared.");
  return _sendSupplierCartMenu(from, supplier, []);
}

  // ── REMOVE by position: r2, r 2, remove 2 ────────────────────────────────
 // ── REMOVE by position: r2, r 2, remove 2 ────────────────────────────────
const removeByPos = rawLower.match(/^(?:remove|r)\s*(\d+)$/);
if (removeByPos) {
  const idx = parseInt(removeByPos[1]) - 1;

  if (idx >= 0 && idx < cart.length) {
    const removed = cart.splice(idx, 1)[0];

    if (biz) {
      biz.sessionData = { ...(biz.sessionData || {}), orderCart: cart };
      await saveBizSafe(biz);
    }

    await UserSession.findOneAndUpdate(
      { phone },
      { $set: { "tempData.orderCart": cart } },
      { upsert: true }
    );

    await persistOrderFlowState({
      biz,
      phone,
      patch: {
        orderBrowseMode: "cart",
        orderSupplierId: String(supplier._id),
        orderCart: cart
      }
    });

    await sendText(from, `✅ Removed *${removed.product}* from cart.`);
    return _sendSupplierCartMenu(from, supplier, cart);
  } else {
    return sendText(from, `❌ No item #${idx + 1} in cart. You have ${cart.length} item${cart.length !== 1 ? "s" : ""}.`);
  }
}
  // ── REMOVE by name: "remove cement" ──────────────────────────────────────
 // ── REMOVE by name: "remove cement" ──────────────────────────────────────
const removeByName = rawLower.match(/^remove\s+(.+)$/);
if (removeByName) {
  const nameToRemove = removeByName[1].trim();
  const idx = cart.findIndex(c => c.product.toLowerCase().includes(nameToRemove));

  if (idx >= 0) {
    const removed = cart.splice(idx, 1)[0];

    if (biz) {
      biz.sessionData = { ...(biz.sessionData || {}), orderCart: cart };
      await saveBizSafe(biz);
    }

    await UserSession.findOneAndUpdate(
      { phone },
      { $set: { "tempData.orderCart": cart } },
      { upsert: true }
    );

    await persistOrderFlowState({
      biz,
      phone,
      patch: {
        orderBrowseMode: "cart",
        orderSupplierId: String(supplier._id),
        orderCart: cart
      }
    });

    await sendText(from, `✅ Removed *${removed.product}* from cart.`);
    return _sendSupplierCartMenu(from, supplier, cart);
  } else {
    return sendText(from, `❌ *${nameToRemove}* not found in cart.`);
  }
}
  // ── HELP command ─────────────────────────────────────────────────────────
  if (rawLower === "help" || rawLower === "?") {
    return sendText(from,
`📋 *Ordering Help -${supplier.businessName}*

*➕ Add items:*
Type: _cement 10_ or _cement 10 bags_
Multiple: _cement 10, sand 2, bricks 500_

*➕ Increase qty:*
Type the item name alone: _cement_ adds 1 more
Or: _cement 5_ adds 5 more

*🗑 Remove items:*
_remove cement_ -remove by name
_r2_ or _remove 2_ -remove item #2

*🗑 Clear cart:*
_clear_ -empty entire cart

*✅ Confirm order:*
_confirm_ -go to delivery step
Or tap ✅ Confirm in the list below

*❌ Cancel:*
_cancel_ -cancel this order`);
  }

  // ── PARSE as order input: "cement 10", "cement 10 bags", "cement 10, sand 2" ──
 const parsedBulk = parseBulkOrderInput(raw);

if (parsedBulk.length && parsedBulk.some(i => i.valid)) {
  const validEntries = parsedBulk.filter(i => i.valid);
  const matchedEntries = [];
  const unmatchedEntries = [];

  for (const entry of validEntries) {
    const match = findMatchingSupplierPrice(supplier, entry.product);
    if (!match) {
      unmatchedEntries.push(entry.product);
      continue;
    }
    matchedEntries.push({ entry, match });
  }

  if (!matchedEntries.length) {
    return sendText(
      from,
      `❌ None of those items were found in *${supplier.businessName}*.\n\n` +
      `Please search the catalogue, use *Quick Order by Number*, or type an exact product name from this supplier.`
    );
  }

  for (const { entry, match } of matchedEntries) {
    const cartProduct = match.product;
    const existing = cart.find(c => c.product.toLowerCase() === cartProduct.toLowerCase());

    if (existing) {
      existing.quantity += entry.quantity;
      if (existing.pricePerUnit) existing.total = existing.quantity * existing.pricePerUnit;
    } else {
      cart.push({
        product: cartProduct,
        quantity: entry.quantity,
        unit: match.unit || entry.unitLabel || (isService ? "job" : "units"),
        pricePerUnit: match.amount || null,
        total: match.amount ? entry.quantity * match.amount : null
      });
    }
  }

  if (biz) {
    biz.sessionData = { ...(biz.sessionData || {}), orderCart: cart };
    await saveBizSafe(biz);
  }

  await UserSession.findOneAndUpdate(
    { phone },
    { $set: { "tempData.orderCart": cart } },
    { upsert: true }
  );

  if (unmatchedEntries.length) {
    await sendText(
      from,
      `⚠️ Some items were not found and were skipped: _${unmatchedEntries.slice(0, 5).join(", ")}_${unmatchedEntries.length > 5 ? "..." : ""}`
    );
  }

  await persistOrderFlowState({
    biz,
    phone,
    patch: {
      orderBrowseMode: "cart",
      orderSupplierId: String(supplier._id),
      orderCart: cart
    }
  });

  return _sendSupplierCartMenu(from, supplier, cart);
}
  // ── SINGLE WORD -treat as item name, add qty 1 (or increase existing) ───
  // e.g. buyer types "cement" → adds 1 cement or increments qty
  const singleItemName = raw.trim();

if (singleItemName.length >= 2) {
  const match = findMatchingSupplierPrice(supplier, singleItemName);

  if (!match) {
    return sendText(
      from,
      `❌ *${singleItemName}* was not found in *${supplier.businessName}*.\n\n` +
      `Use *Browse Catalogue*, *Quick Order by Number*, or type an exact product name from this supplier.`
    );
  }

  const cartProduct = match.product;
  const existing = cart.find(c => c.product.toLowerCase() === cartProduct.toLowerCase());

  if (existing) {
    existing.quantity += 1;
    if (existing.pricePerUnit) existing.total = existing.quantity * existing.pricePerUnit;
  } else {
    cart.push({
      product: cartProduct,
      quantity: 1,
      unit: match.unit || (isService ? "job" : "units"),
      pricePerUnit: match.amount || null,
      total: match.amount || null
    });
  }

  if (biz) {
    biz.sessionData = { ...(biz.sessionData || {}), orderCart: cart };
    await saveBizSafe(biz);
  }

  await UserSession.findOneAndUpdate(
    { phone },
    { $set: { "tempData.orderCart": cart } },
    { upsert: true }
  );

  await persistOrderFlowState({
    biz,
    phone,
    patch: {
      orderBrowseMode: "cart",
      orderSupplierId: String(supplier._id),
      orderCart: cart
    }
  });

  return _sendSupplierCartMenu(from, supplier, cart);
}
}



if (a === "sup_back_to_search_results") {
  let allResults = [];
  let currentPage = 0;

  if (biz) {
    allResults = biz.sessionData?.searchResults || [];
    currentPage = biz.sessionData?.searchPage || 0;
  } else {
    const sess = await UserSession.findOne({ phone });
    allResults = sess?.tempData?.searchResults || [];
    currentPage = sess?.tempData?.searchPage || 0;
  }

  if (!allResults.length) {
    return sendButtons(from, {
      text: "❌ Search session expired. Please search again.",
      buttons: [{ id: "find_supplier", title: "🔍 Search Again" }]
    });
  }

  const PAGE_SIZE = 9;
  const start = currentPage * PAGE_SIZE;
  const pageResults = allResults.slice(start, start + PAGE_SIZE);
  const rows = formatSupplierResults(pageResults, null, null);
  const hasMore = allResults.length > start + PAGE_SIZE;
  const hasPrev = currentPage > 0;

  if (hasPrev) {
    rows.push({ id: "sup_search_prev_page", title: "⬅ Back" });
  }
  if (hasMore) {
    rows.push({ id: "sup_search_next_page", title: "➡ More results" });
  }

  if (rows.length > 10) rows.splice(10);

  const showing = `${start + 1}–${Math.min(start + PAGE_SIZE, allResults.length)}`;
  return sendList(
    from,
    `🔍 Results ${showing} of ${allResults.length}\n_Tap a supplier to continue shopping_`,
    rows
  );
}

// ── Paginate search results: next page ───────────────────────────────────
if (a === "sup_search_next_page") {
  let allResults = [];
  let currentPage = 0;

  if (biz) {
    allResults = biz.sessionData?.searchResults || [];
    currentPage = (biz.sessionData?.searchPage || 0) + 1;
    biz.sessionData = { ...(biz.sessionData || {}), searchPage: currentPage };
    await saveBizSafe(biz);
  } else {
    const sess = await UserSession.findOne({ phone });
    allResults = sess?.tempData?.searchResults || [];
    currentPage = (sess?.tempData?.searchPage || 0) + 1;
    await UserSession.findOneAndUpdate(
      { phone },
      { $set: { "tempData.searchPage": currentPage } },
      { upsert: true }
    );
  }

  if (!allResults.length) {
    return sendButtons(from, {
      text: "❌ Search session expired. Please search again.",
      buttons: [{ id: "find_supplier", title: "🔍 Search Again" }]
    });
  }

  const PAGE_SIZE = 9;
  const start = currentPage * PAGE_SIZE;
  const pageResults = allResults.slice(start, start + PAGE_SIZE);

  if (!pageResults.length) {
    return sendButtons(from, {
      text: "❌ No more results on this page.",
      buttons: [{ id: "find_supplier", title: "🔍 Search Again" }]
    });
  }

  let resultMode = "suppliers";
  if (biz) {
    resultMode = biz.sessionData?.searchResultMode || "suppliers";
  } else {
    const sess = await UserSession.findOne({ phone });
    resultMode = sess?.tempData?.searchResultMode || "suppliers";
  }

  const rows = resultMode === "offers"
    ? formatSupplierOfferResults(pageResults)
    : formatSupplierResults(pageResults, null, null);
  const hasMore = allResults.length > start + PAGE_SIZE;
  const hasPrev = currentPage > 0;

  // Nav rows -always last, within the 10 row budget
  // rows is max 9 items so we have room for nav
  if (hasPrev) {
    rows.push({ id: "sup_search_prev_page", title: `⬅ Back (prev ${PAGE_SIZE})` });
  }
  if (hasMore) {
    rows.push({ id: "sup_search_next_page", title: `➡ More (${allResults.length - start - PAGE_SIZE} more)` });
  }

  if (rows.length > 10) rows.splice(10);

  const showing = `${start + 1}–${Math.min(start + PAGE_SIZE, allResults.length)}`;
  return sendList(
    from,
    `🔍 Results ${showing} of ${allResults.length}\n_Tap a supplier to view details_`,
    rows
  );
}

// ── Paginate search results: previous page ────────────────────────────────
if (a === "sup_search_prev_page") {
  let allResults = [];
  let currentPage = 0;

  if (biz) {
    allResults = biz.sessionData?.searchResults || [];
    currentPage = Math.max(0, (biz.sessionData?.searchPage || 1) - 1);
    biz.sessionData = { ...(biz.sessionData || {}), searchPage: currentPage };
    await saveBizSafe(biz);
  } else {
    const sess = await UserSession.findOne({ phone });
    allResults = sess?.tempData?.searchResults || [];
    currentPage = Math.max(0, (sess?.tempData?.searchPage || 1) - 1);
    await UserSession.findOneAndUpdate(
      { phone },
      { $set: { "tempData.searchPage": currentPage } },
      { upsert: true }
    );
  }

  if (!allResults.length) {
    return sendButtons(from, {
      text: "❌ Search session expired. Please search again.",
      buttons: [{ id: "find_supplier", title: "🔍 Search Again" }]
    });
  }

  const PAGE_SIZE = 9;
  const start = currentPage * PAGE_SIZE;
  const pageResults = allResults.slice(start, start + PAGE_SIZE);
  let resultMode = "suppliers";
  if (biz) {
    resultMode = biz.sessionData?.searchResultMode || "suppliers";
  } else {
    const sess = await UserSession.findOne({ phone });
    resultMode = sess?.tempData?.searchResultMode || "suppliers";
  }

 const rows = resultMode === "offers"
  ? formatSupplierOfferResults(pageResults, biz?.sessionData?.supplierSearch?.product || "")
    : formatSupplierResults(pageResults, null, null);
  const hasMore = allResults.length > start + PAGE_SIZE;
  const hasPrev = currentPage > 0;

  if (hasPrev) {
    rows.push({ id: "sup_search_prev_page", title: `⬅ Back` });
  }
  if (hasMore) {
    rows.push({ id: "sup_search_next_page", title: `➡ More results` });
  }

  if (rows.length > 10) rows.splice(10);

  const showing = `${start + 1}–${Math.min(start + PAGE_SIZE, allResults.length)}`;
  return sendList(
    from,
    `🔍 Results ${showing} of ${allResults.length}\n_Tap a supplier to view details_`,
    rows
  );
}

// ── Start order: show supplier's product/service list as selectable menu ──
if (a.startsWith("sup_order_")) {
  const supplierId = a.replace("sup_order_", "");
  const supplier = await SupplierProfile.findById(supplierId).lean();
  if (!supplier) return sendText(from, "❌ Supplier not found.");

  const isService = supplier.profileType === "service";

  const sess = await UserSession.findOne({ phone });
  const searchedProduct =
    sess?.tempData?.supplierSearchProduct ||
    biz?.sessionData?.supplierSearch?.product ||
    "";

  const initialCart = [];

  await UserSession.findOneAndUpdate(
    { phone },
    {
      $set: {
        "tempData.orderSupplierId": supplierId,
        "tempData.orderState": "supplier_order_picking",
        "tempData.orderCart": initialCart,
        "tempData.orderIsService": isService
      }
    },
    { upsert: true }
  );

  if (biz) {
    biz.sessionData = {
      ...(biz.sessionData || {}),
      orderSupplierId: supplierId,
      orderCart: initialCart,
      orderIsService: isService
    };
    biz.sessionState = "supplier_order_picking";
    await saveBizSafe(biz);
  }

// For service suppliers, only pre-filter by search term if the supplier
  // actually has a service whose name contains that term.
  // Otherwise open full catalogue - the search found them via synonym/category match,
  // not a literal service name match.
  let effectiveSearch = searchedProduct;
  if (isService && searchedProduct) {
    const { getFilteredSupplierCatalogueItems: _gf } = { getFilteredSupplierCatalogueItems };
    const matched = getFilteredSupplierCatalogueItems(supplier, searchedProduct);
    if (!matched.length) effectiveSearch = "";
  }

  await persistOrderFlowState({
    biz,
    phone,
    patch: {
      orderSupplierId: String(supplier._id),
      orderCart: initialCart,
      orderIsService: isService,
      orderBrowseMode: effectiveSearch ? "search_pick" : "catalogue",
      orderCataloguePage: 0,
      orderCatalogueSearch: effectiveSearch,
      selectedSupplierItem: null
    }
  });

  return _sendSupplierCatalogueBrowser(from, supplier, initialCart, {
    page: 0,
    searchTerm: effectiveSearch,
    selectionMode: effectiveSearch ? "search_pick" : "catalogue"
  });
}


if (a.startsWith("sup_number_page_open_")) {
  const supplierId = a.replace("sup_number_page_open_", "");
  const supplier = await SupplierProfile.findById(supplierId).lean();
  if (!supplier) return sendText(from, "❌ Supplier not found.");

  const cart = await getCurrentOrderCart({ biz, phone });

  if (biz) {
    biz.sessionState = "supplier_order_picking";
    biz.sessionData = {
      ...(biz.sessionData || {}),
      orderSupplierId: supplierId
    };
    await saveBizSafe(biz);
  }

  await UserSession.findOneAndUpdate(
    { phone },
    {
      $set: {
        "tempData.orderState": "supplier_order_picking",
        "tempData.orderSupplierId": supplierId
      }
    },
    { upsert: true }
  );

  await persistOrderFlowState({
    biz,
    phone,
    patch: {
      orderBrowseMode: "numbered_catalogue",
      orderSupplierId: supplierId,
      orderCataloguePage: 0,
      orderCatalogueSearch: ""
    }
  });

  return _sendSupplierNumberedCatalogueText(from, supplier, cart, {
    page: 0,
    searchTerm: ""
  });
}
if (a.startsWith("sup_number_page_next_") || a.startsWith("sup_number_page_prev_")) {
  const isNext = a.startsWith("sup_number_page_next_");
  const supplierId = a.replace(isNext ? "sup_number_page_next_" : "sup_number_page_prev_", "");
  const supplier = await SupplierProfile.findById(supplierId).lean();
  if (!supplier) return sendText(from, "❌ Supplier not found.");

  const sess = await UserSession.findOne({ phone });
  const currentPage =
    Number(
      biz?.sessionData?.orderCataloguePage ??
      sess?.tempData?.orderCataloguePage ??
      0
    ) || 0;

  const searchTerm =
    biz?.sessionData?.orderCatalogueSearch ??
    sess?.tempData?.orderCatalogueSearch ??
    "";

  const nextPage = Math.max(0, currentPage + (isNext ? 1 : -1));
  const cart = await getCurrentOrderCart({ biz, phone });

  if (biz) {
    biz.sessionState = "supplier_order_picking";
    biz.sessionData = {
      ...(biz.sessionData || {}),
      orderSupplierId: supplierId
    };
    await saveBizSafe(biz);
  }

  await UserSession.findOneAndUpdate(
    { phone },
    {
      $set: {
        "tempData.orderState": "supplier_order_picking",
        "tempData.orderSupplierId": supplierId
      }
    },
    { upsert: true }
  );

  await persistOrderFlowState({
    biz,
    phone,
    patch: {
      orderBrowseMode: "numbered_catalogue",
      orderSupplierId: supplierId,
      orderCataloguePage: nextPage
    }
  });

  return _sendSupplierNumberedCatalogueText(from, supplier, cart, {
    page: nextPage,
    searchTerm
  });
}


if (a.startsWith("sup_number_full_")) {
  const supplierId = a.replace("sup_number_full_", "");
  const supplier = await SupplierProfile.findById(supplierId).lean();
  if (!supplier) return sendText(from, "❌ Supplier not found.");

  const cart = await getCurrentOrderCart({ biz, phone });

  await persistOrderFlowState({
    biz,
    phone,
    patch: {
      orderBrowseMode: "numbered_catalogue",
      orderSupplierId: supplierId,
      orderCataloguePage: 0,
      orderCatalogueSearch: ""
    }
  });

  return _sendSupplierNumberedCatalogueText(from, supplier, cart, {
    page: 0,
    searchTerm: ""
  });
}

if (a.startsWith("sup_catalog_page_open_")) {
  const supplierId = a.replace("sup_catalog_page_open_", "");
  const supplier = await SupplierProfile.findById(supplierId).lean();
  if (!supplier) return sendText(from, "❌ Supplier not found.");

  const cart = await getCurrentOrderCart({ biz, phone });

  await persistOrderFlowState({
    biz,
    phone,
    patch: {
      orderBrowseMode: "catalogue",
      orderSupplierId: supplierId,
      orderCataloguePage: 0,
      orderCatalogueSearch: ""
    }
  });

  return _sendSupplierCatalogueBrowser(from, supplier, cart, {
    page: 0,
    searchTerm: ""
  });
}

if (a.startsWith("sup_catalog_page_next_") || a.startsWith("sup_catalog_page_prev_")) {
  const isNext = a.startsWith("sup_catalog_page_next_");
  const supplierId = a.replace(isNext ? "sup_catalog_page_next_" : "sup_catalog_page_prev_", "");
  const supplier = await SupplierProfile.findById(supplierId).lean();
  if (!supplier) return sendText(from, "❌ Supplier not found.");

  const sess = await UserSession.findOne({ phone });
  const currentPage =
    Number(
      biz?.sessionData?.orderCataloguePage ??
      sess?.tempData?.orderCataloguePage ??
      0
    ) || 0;

  const searchTerm =
    biz?.sessionData?.orderCatalogueSearch ??
    sess?.tempData?.orderCatalogueSearch ??
    "";

  const nextPage = Math.max(0, currentPage + (isNext ? 1 : -1));
  const cart = await getCurrentOrderCart({ biz, phone });

  await persistOrderFlowState({
    biz,
    phone,
    patch: {
      orderBrowseMode: "catalogue",
      orderSupplierId: supplierId,
      orderCataloguePage: nextPage
    }
  });

  return _sendSupplierCatalogueBrowser(from, supplier, cart, {
    page: nextPage,
    searchTerm
  });
}


if (a.startsWith("sup_cart_view_")) {
  const supplierId = a.replace("sup_cart_view_", "");
  const supplier = await SupplierProfile.findById(supplierId).lean();
  if (!supplier) return sendText(from, "❌ Supplier not found.");

  const cart = await getCurrentOrderCart({ biz, phone });

  await persistOrderFlowState({
    biz,
    phone,
    patch: {
      orderBrowseMode: "cart",
      orderSupplierId: supplierId
    }
  });

  return _sendSupplierCartMenu(from, supplier, cart);
}


if (a.startsWith("sup_catalogue_search_")) {
  const supplierId = a.replace("sup_catalogue_search_", "");
  const supplier = await SupplierProfile.findById(supplierId).lean();
  if (!supplier) return sendText(from, "❌ Supplier not found.");

  await persistOrderFlowState({
    biz,
    phone,
    patch: {
      orderBrowseMode: "catalogue_search",
      orderSupplierId: supplierId
    }
  });

  return sendButtons(from, {
    text:
      `🔎 *Search ${supplier.businessName} catalogue*\n\n` +
      `Type part of the ${supplier.profileType === "service" ? "service" : "product"} name.\n\n` +
      `Examples:\n` +
      `${supplier.profileType === "service"
        ? "• blocked drain\n• toilet installation"
        : "• ball valve\n• tee 25mm\n• solvent cement"}`,
    buttons: [{ id: "sup_catalogue_search_cancel", title: "⬅ Cancel" }]
  });
}

if (a === "sup_catalogue_search_cancel") {
  const sess = await UserSession.findOne({ phone });
  const supplierId =
    biz?.sessionData?.orderSupplierId ??
    sess?.tempData?.orderSupplierId;

  if (!supplierId) return sendSuppliersMenu(from);

  const supplier = await SupplierProfile.findById(supplierId).lean();
  if (!supplier) return sendSuppliersMenu(from);

  const cart = await getCurrentOrderCart({ biz, phone });

  await persistOrderFlowState({
    biz,
    phone,
    patch: {
      orderBrowseMode: "catalogue",
      orderCataloguePage: 0,
      orderCatalogueSearch: ""
    }
  });

  return _sendSupplierCatalogueBrowser(from, supplier, cart, {
    page: 0,
    searchTerm: ""
  });
}

// ── Cart: buyer taps an item from catalogue ───────────────────────────────
if (a.startsWith("sup_cart_add_")) {
  const withoutPrefix = a.replace("sup_cart_add_", "");
  const firstUnderscore = withoutPrefix.indexOf("_");
  const supplierId = withoutPrefix.slice(0, firstUnderscore);
  const encodedProduct = withoutPrefix.slice(firstUnderscore + 1);
  const productName = decodeURIComponent(encodedProduct);

  const supplier = await SupplierProfile.findById(supplierId).lean();
  if (!supplier) return sendText(from, "❌ Supplier not found.");

  const sess = await UserSession.findOne({ phone });
  const cart = biz?.sessionData?.orderCart || sess?.tempData?.orderCart || [];

  const currentBrowseMode =
    biz?.sessionData?.orderBrowseMode ??
    sess?.tempData?.orderBrowseMode ??
    "catalogue";

  const currentSearchTerm =
    biz?.sessionData?.orderCatalogueSearch ??
    sess?.tempData?.orderCatalogueSearch ??
    "";

   const isService = supplier.profileType === "service";
  const matched = findMatchingSupplierPrice(supplier, productName);

  const priceInfo = matched
    ? {
        amount: matched.amount,
        unit: matched.unit
      }
    : null;

  const selectedItem = {
    product: productName,
    quantity: 1,
    unit: priceInfo?.unit || (isService ? "job" : "each"),
    pricePerUnit: typeof priceInfo?.amount === "number" ? priceInfo.amount : null,
    total: typeof priceInfo?.amount === "number" ? Number(priceInfo.amount.toFixed(2)) : null
  };

  await persistOrderFlowState({
    biz,
    phone,
    patch: {
      orderSupplierId: String(supplier._id),
      orderIsService: isService,
      orderBrowseMode: currentBrowseMode === "numbered_catalogue" ? "numbered_catalogue" : "selected_offer",
      orderCatalogueSearch: currentSearchTerm,
      selectedSupplierItem: selectedItem
    }
  });

// For services, quantity is always 1 - skip the qty picker entirely
  if (isService) {
    selectedItem.quantity = 1;
    selectedItem.total =
      typeof selectedItem.pricePerUnit === "number" && !Number.isNaN(selectedItem.pricePerUnit)
        ? Number((1 * selectedItem.pricePerUnit).toFixed(2))
        : null;

    await persistOrderFlowState({
      biz,
      phone,
      patch: {
        orderSupplierId: String(supplier._id),
        orderIsService: true,
        orderBrowseMode: "selected_offer",
        orderCatalogueSearch: currentSearchTerm,
        selectedSupplierItem: selectedItem
      }
    });

    return _sendSelectedSupplierItemPreview(from, supplier, selectedItem, cart, {
      quantity: 1,
      searchTerm: currentSearchTerm
    });
  }

  return _sendSupplierQuantityPicker(from, supplier, selectedItem, cart, {
    backId: currentSearchTerm && currentBrowseMode !== "numbered_catalogue"
      ? "sup_offer_results_back"
      : `sup_catalog_page_open_${supplier._id}`
  });
}


if (a.startsWith("sup_qty_pick_")) {
  const raw = a.replace("sup_qty_pick_", "");
  const parts = raw.split("_");
  const qty = Number(parts.pop() || 1);
  const supplierId = parts.shift();
  const productName = decodeURIComponent(parts.join("_"));

  const supplier = await SupplierProfile.findById(supplierId).lean();
  if (!supplier) return sendText(from, "❌ Supplier not found.");

  const sess = await UserSession.findOne({ phone });
  const cart = biz?.sessionData?.orderCart || sess?.tempData?.orderCart || [];
  const currentSearchTerm =
    biz?.sessionData?.orderCatalogueSearch ??
    sess?.tempData?.orderCatalogueSearch ??
    "";

  const storedSelected =
    biz?.sessionData?.selectedSupplierItem ||
    sess?.tempData?.selectedSupplierItem;

  let selectedItem = storedSelected?.product === productName
    ? { ...storedSelected }
    : {
        product: productName,
        quantity: qty,
        unit: supplier.profileType === "service" ? "job" : "each",
        pricePerUnit: null,
        total: null
      };

  selectedItem.quantity = qty;
  selectedItem.total =
    typeof selectedItem.pricePerUnit === "number" && !Number.isNaN(selectedItem.pricePerUnit)
      ? Number((qty * selectedItem.pricePerUnit).toFixed(2))
      : null;

  await persistOrderFlowState({
    biz,
    phone,
    patch: {
      orderSupplierId: String(supplier._id),
      orderIsService: supplier.profileType === "service",
      orderBrowseMode: "selected_offer",
      selectedSupplierItem: selectedItem
    }
  });

  return _sendSelectedSupplierItemPreview(from, supplier, selectedItem, cart, {
    quantity: qty,
    searchTerm: currentSearchTerm
  });
}


if (a.startsWith("sup_item_preview_add_")) {
  const raw = a.replace("sup_item_preview_add_", "");
  const firstUnderscore = raw.indexOf("_");
  const supplierId = raw.slice(0, firstUnderscore);
  const productName = decodeURIComponent(raw.slice(firstUnderscore + 1));

  const supplier = await SupplierProfile.findById(supplierId).lean();
  if (!supplier) return sendText(from, "❌ Supplier not found.");

  const sess = await UserSession.findOne({ phone });
  let cart = biz?.sessionData?.orderCart || sess?.tempData?.orderCart || [];

  const storedSelected =
    biz?.sessionData?.selectedSupplierItem ||
    sess?.tempData?.selectedSupplierItem;

  const itemToAdd = storedSelected?.product === productName
    ? {
        ...storedSelected,
        quantity: Number(storedSelected.quantity || 1),
        total:
          typeof storedSelected.pricePerUnit === "number" && !Number.isNaN(storedSelected.pricePerUnit)
            ? Number((Number(storedSelected.quantity || 1) * storedSelected.pricePerUnit).toFixed(2))
            : null
      }
    : {
        product: productName,
        quantity: 1,
        unit: supplier.profileType === "service" ? "job" : "each",
        pricePerUnit: null,
        total: null
      };

  cart = upsertCartItemToFront(cart, itemToAdd);

  if (biz) {
    biz.sessionData = { ...(biz.sessionData || {}), orderCart: cart };
    await saveBizSafe(biz);
  }

  await UserSession.findOneAndUpdate(
    { phone },
    { $set: { "tempData.orderCart": cart } },
    { upsert: true }
  );

  await persistOrderFlowState({
    biz,
    phone,
    patch: {
      orderSupplierId: String(supplier._id),
      orderIsService: supplier.profileType === "service",
      orderBrowseMode: "cart",
      orderCart: cart,
      selectedSupplierItem: itemToAdd
    }
  });

  return _sendSupplierCartMenu(from, supplier, cart);
}




if (a.startsWith("sup_item_preview_order_")) {
  const raw = a.replace("sup_item_preview_order_", "");
  const firstUnderscore = raw.indexOf("_");
  const supplierId = raw.slice(0, firstUnderscore);
  const productName = decodeURIComponent(raw.slice(firstUnderscore + 1));

  const supplier = await SupplierProfile.findById(supplierId).lean();
  if (!supplier) return sendText(from, "❌ Supplier not found.");

  const sess = await UserSession.findOne({ phone });
  let cart = biz?.sessionData?.orderCart || sess?.tempData?.orderCart || [];

  const storedSelected =
    biz?.sessionData?.selectedSupplierItem ||
    sess?.tempData?.selectedSupplierItem;

  const itemToAdd = storedSelected?.product === productName
    ? {
        ...storedSelected,
        quantity: Number(storedSelected.quantity || 1),
        total:
          typeof storedSelected.pricePerUnit === "number" && !Number.isNaN(storedSelected.pricePerUnit)
            ? Number((Number(storedSelected.quantity || 1) * storedSelected.pricePerUnit).toFixed(2))
            : null
      }
    : {
        product: productName,
        quantity: 1,
        unit: supplier.profileType === "service" ? "job" : "each",
        pricePerUnit: null,
        total: null
      };

  cart = upsertCartItemToFront(cart, itemToAdd);

  if (biz) {
    biz.sessionData = { ...(biz.sessionData || {}), orderCart: cart };
    await saveBizSafe(biz);
  }

  await UserSession.findOneAndUpdate(
    { phone },
    { $set: { "tempData.orderCart": cart } },
    { upsert: true }
  );

  await persistOrderFlowState({
    biz,
    phone,
    patch: {
      orderSupplierId: String(supplier._id),
      orderIsService: supplier.profileType === "service",
      orderBrowseMode: "cart",
      orderCart: cart,
      selectedSupplierItem: itemToAdd
    }
  });

  return handleIncomingMessage({ from, action: `sup_cart_confirm_${supplierId}` });
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
  const sess = await UserSession.findOne({ phone });
  const selectedSupplierItem =
    biz?.sessionData?.selectedSupplierItem ||
    sess?.tempData?.selectedSupplierItem ||
    null;

  const previewLines = cart.map(c => {
    const priceStr = c.pricePerUnit ? ` - $${Number(c.pricePerUnit).toFixed(2)}/${c.unit}` : "";
    return `• ${c.product} x${c.quantity}${priceStr}`;
  }).join("\n");

  const selectedTopLine = selectedSupplierItem?.product
    ? `🎯 *Selected Item:* ${selectedSupplierItem.product}\n\n`
    : "";

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

// For collection-only product suppliers, no address needed - use a placeholder
  const needsAddress = isService || supplier.delivery?.available;

  if (!needsAddress) {
    // Collection only - no address needed, send order immediately with placeholder
    if (biz) { biz.sessionState = "ready"; biz.sessionData = {}; await saveBizSafe(biz); }
    await UserSession.findOneAndUpdate(
      { phone },
      { $unset: { "tempData.orderState": "", "tempData.orderSupplierId": "", "tempData.orderCart": "", "tempData.orderIsService": "" } },
      { upsert: true }
    );

    // Build and submit order directly
    let totalAmount = 0;
    let pricedCount = 0;
    const finalItems = cart.map(entry => {
      const quantity = Number(entry.quantity) || 1;
      const pricePerUnit = entry.pricePerUnit || null;
      const total = pricePerUnit ? quantity * pricePerUnit : null;
      if (total) { totalAmount += total; pricedCount++; }
      return { product: entry.product, quantity, unit: entry.unit || "each", pricePerUnit, currency: "USD", total };
    });

    const order = await SupplierOrder.create({
      supplierId: supplier._id,
      supplierPhone: supplier.phone,
      buyerPhone: phone,
      items: finalItems,
      totalAmount,
      currency: "USD",
      delivery: { required: false, address: "Collection" },
      status: "pending"
    });
    await notifySupplierNewOrder(supplier.phone, order);

       const itemSummary = finalItems.map(i => `• ${i.product} ×${i.quantity}`).join("\n");

    const selectedTopLine = selectedSupplierItem?.product
      ? `🎯 *Selected Item:* ${selectedSupplierItem.product}\n\n`
      : "";
    await sendText(from,
`✅ *Order sent to ${supplier.businessName}!*

${selectedTopLine}${itemSummary}
🏠 Collection only - you will pick up from the supplier
${pricedCount > 0 ? `💵 Estimated total: $${totalAmount.toFixed(2)}\n` : ""}📞 Supplier: ${supplier.phone}

${pricedCount === finalItems.length ? "All items were auto-priced. Supplier can confirm immediately. 🎉" : "Supplier will confirm pricing shortly. 🎉"}`);
    return sendButtons(from, {
      text: "What would you like to do next?",
      buttons: [
        { id: "find_supplier", title: "🔍 Browse & Shop" },
        { id: "my_orders", title: "📋 My Orders" }
      ]
    });
  }

  return sendButtons(from, {
    text:
`${isService ? "📅" : "🛒"} *${isService ? "Booking Summary" : "Order Summary"}*

${selectedTopLine}${previewLines}${totalLine}

─────────────────
⚠️ *Your order has NOT been sent yet.*
─────────────────

*Step 2 of 2 - Enter your ${isService ? "location" : "delivery address"}* 👇

${isService
  ? `📍 *Add a contact note for the provider:*\n\nExamples:\n• _Call me on arrival_\n• _Preferred time: Mon 10am_\n• _+263 7XX XXX XXX_`
  : `📍 *Where should we deliver?*\n\nExamples:\n• _123 Samora Machel Ave, Harare_\n• _Deliver to Avondale after 4pm_\n• _I will collect - call me_`
}

_Type your address below and send to complete your ${isService ? "booking" : "order"}_ ✍️`,
   buttons: [
      ...(isService ? [{ id: `sup_skip_note_${supplierId}`, title: "⏭ Skip & Send" }] : []),
      { id: `sup_cart_clear_${supplierId}`, title: "✏️ Edit Order" },
      { id: "find_supplier", title: "❌ Cancel" }
    ].slice(0, 3)
  });
}

// ── Skip contact note - submit booking without address ────────────────────
if (a.startsWith("sup_skip_note_")) {
  const supplierId = a.replace("sup_skip_note_", "");
  const supplier = await SupplierProfile.findById(supplierId).lean();
  if (!supplier) return sendText(from, "❌ Supplier not found.");

  const sess = await UserSession.findOne({ phone });
  const cart = biz?.sessionData?.orderCart || sess?.tempData?.orderCart || [];

  if (!cart.length) return sendText(from, "❌ Your cart is empty.");

  let totalAmount = 0;
  let pricedCount = 0;
  const finalItems = cart.map(entry => {
    const quantity = Number(entry.quantity) || 1;
    const pricePerUnit = entry.pricePerUnit || null;
    const total = pricePerUnit ? quantity * pricePerUnit : null;
    if (total) { totalAmount += total; pricedCount++; }
    return { product: entry.product, quantity, unit: entry.unit || "job", pricePerUnit, currency: "USD", total };
  });

  const order = await SupplierOrder.create({
    supplierId: supplier._id,
    supplierPhone: supplier.phone,
    buyerPhone: phone,
    items: finalItems,
    totalAmount,
    currency: "USD",
    delivery: { required: false, address: "Client visits provider" },
    status: "pending"
  });

  await notifySupplierNewOrder(supplier.phone, order, phone, { isBooking: true });

  if (biz) { biz.sessionState = "ready"; biz.sessionData = {}; await saveBizSafe(biz); }
  await UserSession.findOneAndUpdate(
    { phone },
    { $unset: { "tempData.orderState": "", "tempData.orderSupplierId": "", "tempData.orderCart": "", "tempData.orderIsService": "" } },
    { upsert: true }
  );

  const itemSummary = finalItems.map(i => `• ${i.product} ×${i.quantity}`).join("\n");
  await sendText(from,
`✅ *Booking sent to ${supplier.businessName}!*

${itemSummary}
📍 You will visit the provider
${pricedCount > 0 ? `💵 Estimated total: $${totalAmount.toFixed(2)}\n` : ""}📞 Contact: ${supplier.phone}

Supplier will confirm your booking shortly. 🎉`);

  return sendButtons(from, {
    text: "What would you like to do next?",
    buttons: [
      { id: "find_supplier", title: "🔍 Browse & Shop" },
      { id: "my_orders", title: "📋 My Orders" }
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

  await persistOrderFlowState({
    biz,
    phone,
    patch: {
      orderBrowseMode: "cart",
      orderSupplierId: supplierId,
      orderCart: []
    },
    unset: {
      selectedSupplierItem: ""
    }
  });s

return _sendSupplierCartMenu(from, supplier, []);
}


// ── Cart: buyer removes one unit of an item ───────────────────────────────
if (a.startsWith("sup_cart_remove_")) {
  const withoutPrefix = a.replace("sup_cart_remove_", "");
  const firstUnderscore = withoutPrefix.indexOf("_");
  const supplierId = withoutPrefix.slice(0, firstUnderscore);
  const encodedProduct = withoutPrefix.slice(firstUnderscore + 1);
  const productName = decodeURIComponent(encodedProduct);

  const supplier = await SupplierProfile.findById(supplierId).lean();
  if (!supplier) return sendText(from, "❌ Supplier not found.");

  let cart = [];
  if (biz) {
    cart = biz.sessionData?.orderCart || [];
  } else {
    const sess = await UserSession.findOne({ phone });
    cart = sess?.tempData?.orderCart || [];
  }

  const idx = cart.findIndex(c => c.product.toLowerCase() === productName.toLowerCase());
  if (idx >= 0) {
    if (cart[idx].quantity > 1) {
      cart[idx].quantity -= 1;
      // Recalculate total
      if (cart[idx].pricePerUnit) {
        cart[idx].total = cart[idx].quantity * cart[idx].pricePerUnit;
      }
    } else {
      cart.splice(idx, 1); // Remove entirely if qty reaches 0
    }
  }

  if (biz) {
    biz.sessionData = { ...(biz.sessionData || {}), orderCart: cart };
    await saveBizSafe(biz);
  }
  await UserSession.findOneAndUpdate(
    { phone },
    { $set: { "tempData.orderCart": cart } },
    { upsert: true }
  );

await persistOrderFlowState({
  biz,
  phone,
  patch: {
    orderBrowseMode: "cart",
    orderSupplierId: supplierId,
    orderCart: cart
  }
});

return _sendSupplierCartMenu(from, supplier, cart);
}
// ── Cart: buyer wants to type a custom item not in catalogue ─────────────
if (a.startsWith("sup_cart_custom_")) {
  const supplierId = a.replace("sup_cart_custom_", "");
  const supplier = await SupplierProfile.findById(supplierId).lean();
  if (!supplier) return sendText(from, "❌ Supplier not found.");

  const isService = supplier.profileType === "service";

  // Stay in picking state - typed input will be caught by the picking handler above
  if (biz) {
    biz.sessionState = "supplier_order_picking";
    biz.sessionData = { ...(biz.sessionData || {}), orderSupplierId: supplierId };
    await saveBizSafe(biz);
  }
  await UserSession.findOneAndUpdate(
    { phone },
    { $set: {
      "tempData.orderState": "supplier_order_picking",
      "tempData.orderSupplierId": supplierId
    }},
    { upsert: true }
  );

  return sendText(from,
isService
  ? `✍️ *Type the service + quantity*\n\nExamples:\n_plumbing 2 hr_\n_welding 1 job_\n_electrical inspection_\n\nOr multiple:\n_plumbing 2, painting 1_\n\nType *cancel* to go back.`
  : `✍️ *Type item name + quantity*\n\nExamples:\n_cement 10_\n_river sand 2, pit sand 1_\n_roofing sheets 20_\n\nType *cancel* to go back.`
  );
}


// ── Buyer request lane: entry menu ───────────────────────────────────────────
if (a === "sup_request_sellers") {
  await UserSession.findOneAndUpdate(
    { phone },
    {
      $set: {
        "tempData.buyerRequestState": "awaiting_items",
        "tempData.buyerRequestMode": "simple",
        "tempData.pendingBuyerRequest": {
          requestType: "simple",
          profileType: "product",
          items: []
        }
      }
    },
    { upsert: true }
  );

  return sendButtons(from, {
    text:
      `⚡ *Request Sellers*\n\n` +
      `Ask multiple sellers to quote the *exact* product or service you need.\n\n` +
      `Please type the full name so sellers can quote correctly.\n\n` +
      `Good examples:\n` +
      `_find ball valve brass 20mm harare_\n` +
      `_find hp laptop core i7 cbd harare_\n` +
      `_find school uniform size 8 chitungwiza_\n` +
      `_find geyser installation avondale harare_\n\n` +
      `Avoid general requests like:\n` +
      `_find valve harare_\n` +
      `_find laptop harare_\n` +
      `_find plumber harare_\n\n` +
      `For long lists, use Bulk Request instead.`,
    buttons: [
      { id: "sup_request_mode_bulk", title: "📋 Bulk Request" },
      { id: "find_supplier", title: "🔍 Browse & Shop" }
    ]
  });
}

if (a === "sup_request_mode_simple" || a === "sup_request_mode_bulk") {
  const requestType = a === "sup_request_mode_bulk" ? "bulk" : "simple";

  await UserSession.findOneAndUpdate(
    { phone },
    {
      $set: {
        "tempData.buyerRequestState": "awaiting_items",
        "tempData.buyerRequestMode": requestType,
        "tempData.pendingBuyerRequest": {
          requestType,
          profileType: "product",
          items: []
        }
      }
    },
    { upsert: true }
  );

  return sendText(
    from,
    requestType === "bulk"
      ? `📋 *Bulk Request*\n\nSend your full item list.\nUse one item per line or comma-separated.\n\nPlease make each line specific enough for quoting.\n\nGood examples:\n_110 access tees x2_\n_ball valve brass 20mm x5_\n_hp laptop core i7 x3_\n_school uniform size 8 x10_\n_geyser installation x2_\n\nWe ignore headings like _Stage 1_.\nAfter that, send suburb/city.\n\nType *cancel* to stop.`
      : `⚡ *Request Sellers*\n\nUse the same shortcode/search style as Browse & Shop, but type the *full* product or service name.\n\nGood examples:\n_find ball valve brass 20mm harare_\n_find hp laptop core i7 cbd harare_\n_find school uniform size 8 chitungwiza_\n_find geyser installation avondale harare_\n\nAvoid vague requests like:\n_find valve harare_\n_find laptop harare_\n_find plumber harare_\n\nType *cancel* to stop.`
  );
}

if (a === "sup_request_delivery_yes" || a === "sup_request_delivery_no") {
  const reqSess = await UserSession.findOne({ phone });
  const pendingBuyerRequest = reqSess?.tempData?.pendingBuyerRequest || null;

  if (!pendingBuyerRequest?.items?.length) {
    await UserSession.findOneAndUpdate(
      { phone },
      {
        $unset: {
          "tempData.buyerRequestState": "",
          "tempData.pendingBuyerRequest": "",
          "tempData.buyerRequestMode": ""
        }
      },
      { upsert: true }
    );

    return sendButtons(from, {
      text: "❌ Request session expired. Please start again.",
      buttons: [{ id: "sup_request_sellers", title: "⚡ Request Sellers" }]
    });
  }

  return finalizeBuyerRequestSubmission({
    from,
    phone,
    pendingRequest: pendingBuyerRequest,
    deliveryRequired: a === "sup_request_delivery_yes"
  });
}

if (a.startsWith("req_offer_confirm_")) {
  // ── Supplier tapped "Send Quote" from the preview ─────────────────────────
  // Retrieve stored pending response and send it to the buyer.
  const _confirmReqId  = a.replace("req_offer_confirm_", "");
  const _confirmReq    = await BuyerRequest.findById(_confirmReqId);
  const _confirmSup    = await SupplierProfile.findOne({ phone }).lean();

  if (!_confirmReq || !_confirmSup) {
    return sendText(from, "❌ Request has expired. The buyer may have already received quotes.");
  }

  // Read the pending offer stored during the preview step
  const _confirmSess = await UserSession.findOne({ phone }).lean();
  let _confirmedResp;
  try {
    _confirmedResp = JSON.parse(_confirmSess?.tempData?.pendingOfferResponse || "{}");
  } catch (_) {
    _confirmedResp = null;
  }

  // Clear state immediately regardless
  await UserSession.findOneAndUpdate(
    { phone },
    {
      $unset: {
        "tempData.sellerRequestReplyState": "",
        "tempData.sellerRequestId":         "",
        "tempData.pendingOfferResponse":    ""
      }
    },
    { upsert: true }
  );

  if (!_confirmedResp?.supplierPhone) {
    // Pending response lost - drop back to price entry
    const _lostItems = (_confirmReq.items || []);
    const _lostLines = _lostItems.map((it, i) => `${i+1}. *${it.product}* × ${Number(it.quantity||1)}`).join("\n");
    await UserSession.findOneAndUpdate(
      { phone },
      { $set: { "tempData.sellerRequestReplyState": "awaiting_offer", "tempData.sellerRequestId": _confirmReqId } },
      { upsert: true }
    );
    return sendText(from,
      `⚠️ Session expired - please re-enter your prices.\n\n` +
      `*Items:*\n${_lostLines}\n\n` +
      `Type price(s) e.g. *250* or *1x250  2x80*`
    );
  }

  // Save and send the confirmed response
  _confirmReq.responses.push(_confirmedResp);
  await _confirmReq.save();

  trackSupplierResponseSpeed(_confirmSup.phone, _confirmReq.createdAt).catch(console.error);
  await sendBuyerRequestResponseToBuyer({ request: _confirmReq, supplier: _confirmSup, response: _confirmedResp });

  const _confOtherCount = (_confirmReq.responses || []).filter(
    r => String(r.supplierPhone) !== String(_confirmSup.phone) &&
         r.mode !== "unavailable" && (r.items?.length || r.message)
  ).length;

  const _confCompLine = _confOtherCount > 0
    ? `\n_${_confOtherCount} other seller${_confOtherCount === 1 ? "" : "s"} also quoted this buyer._`
    : `\n_⚡ You're the first to respond - great timing!_`;

  return sendButtons(from, {
    text:
      `✅ *Quote sent successfully!*${_confCompLine}\n\n` +
      `The buyer will see your prices and can contact you directly.`,
    buttons: [
      { id: "my_supplier_account", title: "🏪 My Store"   },
      { id: "suppliers_home",      title: "🛒 Marketplace" }
    ]
  });
}

if (a.startsWith("req_offer_")) {
  const requestId = a.replace("req_offer_", "");
  const request = await BuyerRequest.findById(requestId);
  if (!request) return sendText(from, "❌ Request not found or expired.");

  const supplier = await SupplierProfile.findOne({ phone }).lean();
  if (!supplier) return sendText(from, "❌ Supplier profile not found.");

  const draft = buildDraftQuoteFromRequest(supplier, request);

  await UserSession.findOneAndUpdate(
    { phone },
    {
      $set: {
        "tempData.sellerRequestReplyState": "awaiting_offer",
        "tempData.sellerRequestId": requestId,
        "tempData.pendingDraftQuote": draft
      }
    },
    { upsert: true }
  );

  const draftLines = draft.responseItems.length
    ? draft.responseItems
        .map((item, i) =>
          `${i + 1}. ${item.product} x${item.quantity} @ $${Number(item.pricePerUnit).toFixed(2)}/${item.unit} = $${Number(item.total).toFixed(2)}`
        )
        .join("\n")
    : "No auto-priced items found yet.";

  const missingLines = draft.missingItems.length
    ? `\n\n⚠️ *Needs review / no price found yet:*\n${draft.missingItems.map(i => `• ${i}`).join("\n")}`
    : "";

  return sendText(
    from,
    `💬 *Review and send quotation*\n\n` +
      `${formatBuyerRequestItems(request.items || [], 20)}\n\n` +
      `*Suggested draft quote:*\n${draftLines}` +
      `${draft.responseItems.length ? `\n\n💵 Draft total: $${Number(draft.totalAmount || 0).toFixed(2)}` : ""}` +
      `${missingLines}\n\n` +
      `Reply in any of these ways:\n\n` +
      `*1. Send draft as is*\n_send_\n\n` +
      `*2. Edit prices by number*\n_1x12, 2x8.5, 3x4.20_\n\n` +
      `*3. Send prices in order*\n_12, 8.5, 4.20, 16_\n\n` +
      `*4. Send named prices*\n_110 access tees: 12_\n_vent valves: 8.5_\n\n` +
      `*5. Partial quote*\n_110 access tees: 12_\n_vent valves: 8.5_\nOnly these are available now._\n\n` +
      `Type *cancel* to stop.`
  );
}


if (a.startsWith("req_auto_")) {
  const requestId = a.replace("req_auto_", "");
  const request = await BuyerRequest.findById(requestId);
  if (!request) return sendText(from, "❌ Request not found or expired.");

  return sendButtons(from, {
    text:
      `⚠️ Auto Quote has been removed for Request Sellers.\n\n` +
      `Please send a manual quotation so the buyer gets the correct item and price.`,
    buttons: [
      { id: `req_offer_${requestId}`, title: "View & Quote" },
      { id: `req_unavail_${requestId}`, title: "Not Available" }
    ]
  });
}

if (a.startsWith("req_unavail_")) {
  const requestId = a.replace("req_unavail_", "");
  const request = await BuyerRequest.findById(requestId);
  if (!request) return sendText(from, "❌ Request not found or expired.");

  const supplier = await SupplierProfile.findOne({ phone }).lean();
  if (!supplier) return sendText(from, "❌ Supplier profile not found.");

  const response = {
    supplierId: supplier._id,
    supplierPhone: supplier.phone,
    supplierName: supplier.businessName,
    mode: "unavailable",
    message: "",
    items: [],
    totalAmount: null,
    deliveryAvailable: supplier.delivery?.available ?? null,
    etaText: ""
  };

  request.responses.push(response);
  await request.save();

  await sendBuyerRequestResponseToBuyer({ request, supplier, response });

  return sendButtons(from, {
    text: "✅ Buyer has been notified that you are unavailable.",
    buttons: [
      { id: "my_supplier_account", title: "🏪 My Store" },
      { id: "suppliers_home", title: "🛒 Marketplace" }
    ]
  });
}

if (a.startsWith("buyer_view_all_quotes_")) {
  const _bvqRequestId = a.replace("buyer_view_all_quotes_", "");
  const _bvqRequest   = await BuyerRequest.findById(_bvqRequestId).lean();
 
  if (!_bvqRequest) {
    return sendButtons(from, {
      text: "❌ Request not found or has expired.",
      buttons: [
        { id: "sup_request_sellers", title: "⚡ New Request" },
        { id: "find_supplier",       title: "🔍 Browse & Shop" }
      ]
    });
  }
 
  const _bvqQuotes = (_bvqRequest.responses || []).filter(
    r => r.mode !== "unavailable" && (r.items?.length || r.message)
  );
 
  if (!_bvqQuotes.length) {
    const _bvqRef = `REQ-${String(_bvqRequest._id).slice(-4).toUpperCase()}`;
    return sendButtons(from, {
      text:
        `📭 *No quotes yet* (${_bvqRef})\n\n` +
        `${formatBuyerRequestItems(_bvqRequest.items || [], 10)}\n\n` +
        `${_bvqRequest.status === "open" ? "🟢 Sellers have been notified. Check back soon." : "🔴 This request is closed with no quotes."}`,
      buttons: [
        { id: "sup_request_sellers", title: "⚡ New Request" },
        { id: "find_supplier",       title: "🔍 Browse & Shop" }
      ]
    });
  }
 
  // Send full comparison as text (can be long - plain text handles it best)
  const _bvqComparison = formatBuyerQuoteComparison(_bvqRequest);
  await sendText(from, _bvqComparison);
 
  return sendButtons(from, {
    text: "What would you like to do next?",
    buttons: [
      { id: "sup_request_sellers", title: "⚡ New Request" },
      { id: "find_supplier",       title: "🔍 Browse & Shop" }
    ]
  });
}
 
// ── View buyer's request history ──────────────────────────────────────────────
if (a === "buyer_my_requests") {
  const _bmrPhone    = from.replace(/\D+/g, "");
  const _bmrRequests = await getBuyerOpenRequests(_bmrPhone, 10);
 
  if (!_bmrRequests.length) {
    return sendButtons(from, {
      text:
        `📋 *My Quote Requests*\n\n` +
        `You haven't submitted any requests yet.\n\n` +
        `Use Request Sellers to ask multiple sellers to quote your exact item.`,
      buttons: [
        { id: "sup_request_sellers", title: "⚡ Request Sellers" },
        { id: "find_supplier",       title: "🔍 Browse & Shop" }
      ]
    });
  }
 
  const _bmrRows = _bmrRequests.slice(0, 7).map(req => {
    const quoteCount   = (req.responses || []).filter(
      r => r.mode !== "unavailable" && (r.items?.length || r.message)
    ).length;
    const statusIcon   = req.status === "open" ? "🟢" : "🔴";
    const firstProduct = (req.items || [])[0]?.product || "Request";
    const ref          = `REQ-${String(req._id).slice(-4).toUpperCase()}`;
    return {
      id:          `buyer_view_all_quotes_${req._id}`,
      title:       firstProduct.slice(0, 24),
      description: `${statusIcon} ${ref} · ${quoteCount} quote${quoteCount === 1 ? "" : "s"}`
    };
  });
 
  _bmrRows.push({ id: "sup_request_sellers", title: "⚡ New Request" });
  _bmrRows.push({ id: "find_supplier",       title: "🔍 Browse & Shop" });
 
  return sendList(
    from,
    `📋 *My Quote Requests* (${_bmrRequests.length} recent)\n_Tap any request to compare quotes_`,
    _bmrRows
  );
}
  // ── sup_search_all: buyer wants to search by product name (free text) ─────
  if (a === "sup_search_all") {

      await clearBuyerOrderContext({ biz, phone, keepSupplierSearch: true });
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

  delete biz.sessionData.orderSupplierId;
  delete biz.sessionData.orderCart;
  delete biz.sessionData.orderItems;
  delete biz.sessionData.orderProduct;
  delete biz.sessionData.orderQuantity;
  delete biz.sessionData.orderIsService;
  delete biz.sessionData.orderBrowseMode;
  delete biz.sessionData.orderCataloguePage;
  delete biz.sessionData.orderCatalogueSearch;

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




    // ── IMPORTANT: business-tools text states must be handled BEFORE marketplace free-text search
  // This prevents expense/sales/product-entry text from being hijacked by supplier city search.
  if (!isMetaAction && biz && !biz.name?.startsWith("pending_supplier_")) {
    const handled = await continueTwilioFlow({ from, text });
    if (handled) return;
  }

  // ── Buyer: free-text product search ──────────────────────────────────────
if (biz?.sessionState === "supplier_search_product" && !isMetaAction) {
  const rawQuery = text.trim();
  const productQuery = rawQuery.replace(/^find\s+/i, "").trim();

  if (!productQuery || productQuery.length < 1) {
    return sendButtons(from, {
      text: "❌ Please type what you're looking for.\n\nExample:\n_find valve brass_",
      buttons: [{ id: "find_supplier", title: "⬅ Back" }]
    });
  }

  // ── Parse location out of the free-text query ──────────────────────────
  const parsed = parseShortcodeSearch(rawQuery) || { product: productQuery, city: null, area: null };
  const cleanProduct = String(parsed.product || productQuery).trim();

  // ── If city/area was already in the query, search immediately ──────────
  if (parsed.city || parsed.area) {
    const locationLabel = parsed.area ? `${parsed.area}, ${parsed.city}` : parsed.city;
    biz.sessionData = {
      ...(biz.sessionData || {}),
      supplierSearch: { ...(biz.sessionData?.supplierSearch || {}), product: cleanProduct, city: parsed.city }
    };
    biz.sessionState = "ready";
    await saveBizSafe(biz);

    // ── Step 1: Check for a single direct business-name match first ──────────
    // Mirrors the working sup_search_city_* flow: if exactly 1 supplier's
    // businessName matches the query, open their shopping hub directly.
    const allSupplierResults = await runSupplierSearch({
      city: parsed.city || null,
      product: cleanProduct,
      area: parsed.area || null
    });

    const normalizedQuery = normalizeProductName(cleanProduct);
    const directBusinessMatches = allSupplierResults.filter(s => {
      const bn = normalizeProductName(s.businessName || "");
      return bn === normalizedQuery || bn.includes(normalizedQuery);
    });

    if (directBusinessMatches.length === 1) {
      const supplier = directBusinessMatches[0];
      const cart = await getCurrentOrderCart({ biz, phone });
      await persistOrderFlowState({
        biz,
        phone,
        patch: {
          orderSupplierId: String(supplier._id),
          orderBrowseMode: "catalogue",
          orderCataloguePage: 0,
          orderCatalogueSearch: ""
        }
      });
      return _sendSupplierShoppingHub(from, supplier, cart);
    }

    // ── Step 2: Not a single business-name match - run offer-first search ────
    let offerResults = await runSupplierOfferSearch({ city: parsed.city || null, product: cleanProduct, area: null });

    // Retry across all cities if city-level returns nothing
    if (!offerResults.length) {
      offerResults = await runSupplierOfferSearch({ city: null, product: cleanProduct, area: null });
    }

    if (offerResults.length) {
      biz.sessionData = {
        ...(biz.sessionData || {}),
        supplierSearch: { ...(biz.sessionData?.supplierSearch || {}), product: cleanProduct, city: parsed.city },
        searchResults: offerResults,
        searchPage: 0,
        searchResultMode: "offers"
      };
      await saveBizSafe(biz);
      await UserSession.findOneAndUpdate(
        { phone },
        { $set: { "tempData.searchResults": offerResults, "tempData.searchPage": 0, "tempData.searchResultMode": "offers" } },
        { upsert: true }
      );
      const pageOffers = offerResults.slice(0, 9);
      const rows = formatSupplierOfferResults(pageOffers, cleanProduct);
      if (offerResults.length > 9) {
        rows.push({ id: "sup_search_next_page", title: `➡ More results (${offerResults.length - 9} more)` });
      }
      return sendList(from, `🔍 *${cleanProduct}* in ${locationLabel} - ${offerResults.length} found`, rows);
    }

    // ── Step 3: No offers - fall back to supplier cards ──────────────────────
    if (!allSupplierResults.length) {
      return sendButtons(from, {
        text: `😕 No results for *${cleanProduct}* in *${locationLabel}*.\n\nTry a different city or search all of Zimbabwe?`,
        buttons: [
          { id: "sup_search_city_all", title: "📍 Search All Cities" },
          { id: "find_supplier", title: "🔍 Search Again" }
        ]
      });
    }

    const pageResults = allSupplierResults.slice(0, 9);
    const rows = formatSupplierResults(pageResults, parsed.city || parsed.area || "", cleanProduct);
    if (allSupplierResults.length > 9) {
      biz.sessionData = { ...(biz.sessionData || {}), searchResults: allSupplierResults, searchPage: 0, searchResultMode: "suppliers" };
      rows.push({ id: "sup_search_next_page", title: `➡ More results (${allSupplierResults.length - 9} more)` });
      await saveBizSafe(biz);
    }
    return sendList(from, `🔍 *${cleanProduct}* in ${locationLabel} - ${allSupplierResults.length} found`, rows);
  }

  // ── No location found - ask for city ───────────────────────────────────
  biz.sessionData = {
    ...(biz.sessionData || {}),
    supplierSearch: { ...(biz.sessionData?.supplierSearch || {}), product: cleanProduct }
  };
  biz.sessionState = "supplier_search_city";
  await saveBizSafe(biz);

  return sendList(from, `🔍 Looking for: *${cleanProduct}*\n\nWhich city?`, [
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

  const _sidBiz = biz.sessionData?.orderSupplierId;
  const _supBiz = _sidBiz ? await SupplierProfile.findById(_sidBiz).lean() : null;
  const isServiceSupplier = _supBiz?.profileType === "service";
 const _needsAddressBiz = (isServiceSupplier && _supBiz?.travelAvailable) || (!isServiceSupplier && _supBiz?.delivery?.available === true);

  const preview = parsedItems
    .map(i => `• ${i.product} x${i.quantity}${i.unitLabel && i.unitLabel !== "units" ? " " + i.unitLabel : ""}`)
    .join("\n");

  if (!_needsAddressBiz && _supBiz) {
    // Collection-only: submit immediately, no address needed
    let totalAmount = 0; let pricedCount = 0;
    const finalItems = parsedItems.filter(i => i.valid).map(entry => {
      const quantity = Number(entry.quantity) || 1;
      const matchedPrice = findMatchingSupplierPrice(_supBiz, entry.product);
      let pricePerUnit = null, total = null, finalUnit = entry.unitLabel || "units";
      if (matchedPrice && typeof matchedPrice.amount === "number") {
        pricePerUnit = matchedPrice.amount;
        total = quantity * matchedPrice.amount;
        finalUnit = matchedPrice.unit || finalUnit;
        totalAmount += total; pricedCount++;
      }
      return { product: entry.product, quantity, unit: finalUnit, pricePerUnit, currency: "USD", total };
    });

    const order = await SupplierOrder.create({
      supplierId: _supBiz._id, supplierPhone: _supBiz.phone,
      buyerPhone: phone, items: finalItems, totalAmount, currency: "USD",
      delivery: { required: false, address: "Collection" }, status: "pending"
    });
    await notifySupplierNewOrder(_supBiz.phone, order);

    biz.sessionState = "ready"; biz.sessionData = {};
    await saveBizSafe(biz);

    const itemSummary = finalItems.map(i => `• ${i.product} x${i.quantity}`).join("\n");
    await sendText(from,
`✅ *Order sent to ${_supBiz.businessName}!*

${itemSummary}
🏠 *Collection only* - contact the supplier to arrange pickup
${pricedCount > 0 ? `💵 Estimated total: $${totalAmount.toFixed(2)}\n` : ""}📞 Supplier: ${_supBiz.phone}

${pricedCount === finalItems.length ? "All items were auto-priced. Supplier can confirm immediately. 🎉" : "Supplier will confirm pricing shortly. 🎉"}`);
    return sendButtons(from, {
      text: "What would you like to do next?",
      buttons: [
        { id: "find_supplier", title: "🔍 Browse & Shop" },
        { id: "my_orders", title: "📋 My Orders" },
        { id: ACTIONS.MAIN_MENU, title: "🏠 Main Menu" }
      ]
    });
  }

  // Delivery/service: ask for address
  biz.sessionData = { ...(biz.sessionData || {}), orderItems: parsedItems };
  biz.sessionState = "supplier_order_address";
  await saveBizSafe(biz);

return sendButtons(from, {
  text:
`${isServiceSupplier ? "📅" : "🛒"} *${isServiceSupplier ? "Booking Summary" : "Order Summary"}*

${preview}

─────────────────
⚠️ *Your ${isServiceSupplier ? "booking" : "order"} has NOT been sent yet.*
─────────────────

*Step 2 of 2 - Enter your ${isServiceSupplier ? "location" : "delivery address"}* 👇

${isServiceSupplier
  ? `📍 *Add a contact note for the provider:*\n\nExamples:\n• _Call me on arrival_\n• _Preferred time: Mon 10am_\n• _+263 7XX XXX XXX_`
  : `📍 *Where should we deliver?*\n\nExamples:\n• _123 Samora Machel Ave, Harare_\n• _Deliver to Avondale after 4pm_\n• _I will collect - call me_`
}

_Type your address below and send to complete your ${isServiceSupplier ? "booking" : "order"}_ ✍️`,
 buttons: [
    ...(isServiceSupplier ? [{ id: `sup_skip_note_${supplierId}`, title: "⏭ Skip & Send" }] : []),
    { id: "find_supplier", title: "❌ Cancel Order" }
  ].slice(0, 3)
});
}

  // ── Buyer order: quantity text input ──────────────────────────────────────


  // ── Buyer order: address / contact note text input ────────────────────────
const _addrSess = await UserSession.findOne({ phone });
const _addrViaSess = !biz && _addrSess?.tempData?.orderState === "supplier_order_address";

if ((biz?.sessionState === "supplier_order_address" || _addrViaSess) && !isMetaAction) {
  const address = text.trim();
  if (!address || address.length < 2) {
    return sendText(from, `❌ Please enter your delivery address or contact note:\n\nType *cancel* to stop this order.`);
  }

  const supplierId = biz?.sessionData?.orderSupplierId
    || _addrSess?.tempData?.orderSupplierId;
  const orderItemsInput = biz?.sessionData?.orderCart?.length
    ? biz.sessionData.orderCart
    : _addrSess?.tempData?.orderCart?.length
      ? _addrSess.tempData.orderCart
      : (biz?.sessionData?.orderItems || []);

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
    if (biz) { biz.sessionState = "ready"; biz.sessionData = {}; await saveBizSafe(biz); }
    await UserSession.findOneAndUpdate(
      { phone },
      { $unset: { "tempData.orderState": "", "tempData.orderSupplierId": "", "tempData.orderCart": "", "tempData.orderIsService": "" } }
    );

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
    { id: "find_supplier", title: "🔍 Browse & Shop" },
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

  // ── Decline reason selected ────────────────────────────────────────────────
  if (
    a === "dec_out_of_stock" ||
    a === "dec_min_not_met"  ||
    a === "dec_no_delivery"  ||
    a === "dec_price_changed"||
    a === "dec_other"
  ) {
    const reasonMap = {
      dec_out_of_stock:  "Out of stock",
      dec_min_not_met:   "Minimum order not met",
      dec_no_delivery:   "Cannot deliver to area",
      dec_price_changed: "Price has changed",
      dec_other:         "Unable to fulfill"
    };
    const reason = reasonMap[a] || "Declined";
    const orderId = biz?.sessionData?.declineOrderId;

    if (!orderId) {
      await sendText(from, "❌ Session expired. Please try again.");
      return sendMainMenu(from);
    }

    const SupplierOrder = (await import("../models/supplierOrder.js")).default;
    const order = await SupplierOrder.findById(orderId);

    if (!order) {
      await sendText(from, "❌ Order not found.");
      return sendMainMenu(from);
    }

    order.status = "declined";
    order.declineReason = reason;
    await order.save();

    // Notify buyer
    try {
      await sendButtons(order.buyerPhone, {
        text:
          `❌ *Order Declined*\n\n` +
          `Your order has been declined.\n` +
          `*Reason:* ${reason}\n\n` +
          `You can search for another supplier.`,
        buttons: [
          { id: "find_supplier", title: "🔍 Find Another" },
          { id: "suppliers_home", title: "🛒 Marketplace" }
        ]
      });
    } catch (err) {
      console.error("[DECLINE NOTIFY BUYER]", err.message);
    }

    // Reset supplier session
    if (biz) {
      biz.sessionState = "ready";
      biz.sessionData  = {};
      await saveBizSafe(biz);
    }

    return sendButtons(from, {
      text: `✅ Order declined.\n*Reason sent to buyer:* ${reason}`,
      buttons: [
        { id: "my_supplier_account", title: "🏪 My Store" },
        { id: ACTIONS.MAIN_MENU,     title: "🏠 Main Menu" }
      ]
    });
  }


  if (a.startsWith("sup_biz_cur_")) {
  const currency = a.replace("sup_biz_cur_", "").toUpperCase();
  if (!["USD", "ZWL", "ZAR"].includes(currency)) return true;
  if (!biz) return sendMainMenu(from);

  biz.sessionData.supplierReg = biz.sessionData.supplierReg || {};
  biz.sessionData.supplierReg.currency = currency;

  // Pre-fill the Business name and currency from supplier reg data
  const reg = biz.sessionData.supplierReg;
  if (reg.businessName && !biz.name) {
    biz.name = reg.businessName;
  }
  biz.currency = currency;
  biz.isSupplier = true;
  biz.sessionState = "supplier_reg_confirm";
  await saveBizSafe(biz);

  const isService = reg.profileType === "service";
  const itemCount = (reg.products || []).filter(p => p && p !== "pending_upload").length;

  return sendButtons(from, {
    text:
`📋 *Confirm your listing*\n\n🏢 *${reg.businessName}*\n📍 ${reg.city || "-"}, ${reg.area || "-"}\n📦 Type: ${isService ? "Services" : "Products"} (${itemCount} items)\n💱 Currency: *${currency}*\n\n✅ Once you pay, your business listing goes live AND your invoicing/quoting tools unlock automatically.\n\nIs everything correct?`,
    buttons: [
      { id: "sup_confirm_yes", title: "✅ Confirm & Continue" },
      { id: "sup_confirm_no",  title: "✏️ Edit Details" }
    ]
  });
}

if (biz?.sessionState === "supplier_order_enter_price" && !isMetaAction) {
    const orderId = biz.sessionData?.pricingOrderId;
    if (!orderId) {
      biz.sessionState = "ready";
      biz.sessionData = {};
      await saveBizSafe(biz);
      await sendText(from, "❌ Pricing session expired. Please check your orders.");
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

    const isServiceSupplier = (await SupplierProfile.findOne({ phone: from }).lean())?.profileType === "service";

   const raw = (text || "").trim();

const missingIndexes = biz.sessionData?.pricingMissingIndexes || [];
const pricingTargets = missingIndexes.map(idx => order.items[idx]).filter(Boolean);

// Use one consistent display name everywhere in this pricing step
const getPricingItemName = (item, idx) => {
  const name = String(item?.product || "").trim();
  if (name) return name;

  // Better fallback than plain "Item"
  return `Item #${idx + 1}`;
};

    // ── Handle cancel ────────────────────────────────────────────────────────
    if (raw.toLowerCase() === "cancel") {
      biz.sessionState = "ready";
      biz.sessionData = {};
      await saveBizSafe(biz);
      await sendText(from, "❌ Pricing cancelled. The order is still pending.");
      return sendSuppliersMenu(from);
    }

if (!raw) {
  await sendText(from,
    pricingTargets.length === 1
      ? `❌ Please enter the price per unit.\n\nExample: *12* (means $12 per unit)`
      : `❌ Please enter ${pricingTargets.length} prices separated by commas.\n\nExample: *12, 45, 0.08*`
  );
  return;
}

    // ── Parse the entered values ─────────────────────────────────────────────
    const values = raw
      .split(",")
      .map(v => Number(v.trim()))
      .filter(v => !Number.isNaN(v) && v >= 0);

    if (!values.length) {
  await sendText(from,
    `❌ Couldn't read your prices. Use numbers only, separated by commas.\n\n` +
    `Example for ${pricingTargets.length} item${pricingTargets.length > 1 ? "s" : ""}: ` +
    `*${pricingTargets.map((_, i) => ((i + 1) * 5 + 7)).join(", ")}*`
  );
  return;
}

    // ── Wrong count ───────────────────────────────────────────────────────────
if (values.length !== pricingTargets.length) {
  const itemList = pricingTargets.map((item, i) => {
    const qty = Number(item.quantity) || 1;
    const unitLabel = item.unit && item.unit !== "units"
      ? item.unit
      : (isServiceSupplier ? "job" : "unit");

    return `${i + 1}. ${getPricingItemName(item, i)} × ${qty} ${unitLabel}`;
  }).join("\n");

  await sendText(from,
    `❌ You still need to price *${pricingTargets.length} item${pricingTargets.length > 1 ? "s" : ""}* but sent *${values.length} price${values.length > 1 ? "s" : ""}*.\n\n` +
    `Items to price:\n${itemList}\n\n` +
    `Send exactly *${pricingTargets.length}* price${pricingTargets.length > 1 ? "s" : ""}, one per item, in order.\n` +
    `Example: *${pricingTargets.map((_, i) => ((i + 1) * 5 + 7)).join(", ")}*`
  );
  return;
}
    // ── Build preview -show the supplier exactly what they entered and what it means ──
    // This is the key UX fix: show "per unit × qty = line total" BEFORE saving
  let previewGrandTotal = 0;
const previewLines = pricingTargets.map((item, idx) => {
  const unitPrice = values[idx];
  const qty = Number(item.quantity) || 1;
  const lineTotal = unitPrice * qty;
  previewGrandTotal += lineTotal;

  const unitLabel = item.unit && item.unit !== "units"
    ? item.unit
    : (isServiceSupplier ? "job" : "unit");

  return `${idx + 1}. *${getPricingItemName(item, idx)}*\n   $${unitPrice.toFixed(2)} per ${unitLabel} × ${qty} = *$${lineTotal.toFixed(2)}*`;
}).join("\n\n");

    // ── Save preview to sessionData so the confirm handler can use it ─────────
    biz.sessionData = {
      ...biz.sessionData,
      pendingPrices: values,
      pricingOrderId: orderId
    };
    biz.sessionState = "supplier_order_confirm_price";
    await saveBizSafe(biz);

 // ── Delivery line for price summary ───────────────────────────────────────
    const previewDeliveryLine = order.delivery?.required
      ? `🚚 *Deliver to:* ${order.delivery.address}`
      : isServiceSupplier
        ? `📍 *Service location:* ${order.delivery?.address || "TBC"}`
        : `🏠 *Collection* (buyer will pick up)`;

    return sendButtons(from, {
      text:
        `💰 *Price Summary -Please Confirm*\n` +
        `_Buyer: ${order.buyerPhone}_\n\n` +
        `─────────────────\n` +
        `${previewLines}\n\n` +
        `─────────────────\n` +
        `${previewDeliveryLine}\n` +
        `💵 *Order Total: $${previewGrandTotal.toFixed(2)}*\n\n` +
        `Does this look correct?\n` +
        `_Tap ✅ Confirm to accept the order at these prices._`,
      buttons: [
        { id: "sup_price_confirm_yes", title: "✅ Confirm & Accept" },
        { id: "sup_price_confirm_no",  title: "✏️ Re-enter Prices" },
        { id: "suppliers_home",        title: "⬅ Cancel" }
      ]
    });
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

      // Allow reports for all active paid packages (bronze/silver/gold/enterprise)
      // Trial only gets blocked
      const PAID_PACKAGES = ["bronze", "silver", "gold", "enterprise"];
      const hasPaidPackage = PAID_PACKAGES.includes(biz.package);
      const isActive = biz.subscriptionStatus === "active";

      if (!hasPaidPackage || !isActive) {
        return promptUpgrade({ biz, from, feature: "Reports" });
      }

      biz.sessionState = "reports_menu"; biz.sessionData = {}; await saveBizSafe(biz);
      const isGold   = biz.package === "gold"   || biz.package === "enterprise";
      const isSilver = biz.package === "silver"  || isGold;
      return sendReportsMenu(from, isGold, isSilver);
    }

case "overall_reports": {
      if (!biz) return sendMainMenu(from);
      const { sendOverallReportsMenu } = await import("./metaMenus.js");
      const isGold   = ["gold", "enterprise"].includes(biz.package);
      const isSilver = ["silver", "gold", "enterprise"].includes(biz.package);
      return sendOverallReportsMenu(from, isGold, isSilver);
    }

    case "branch_reports": {
      if (!biz) return sendMainMenu(from);
      const { sendBranchReportsMenu } = await import("./metaMenus.js");
      const isGold   = ["gold", "enterprise"].includes(biz.package);
      const isSilver = ["silver", "gold", "enterprise"].includes(biz.package);
      return sendBranchReportsMenu(from, isGold, isSilver);
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
      if (caller?.role === "owner") return sendBranchSelectorExpense(from);
      biz.sessionState = "expense_smart_entry";
      biz.sessionData  = { bulkExpenses: [] };
      await saveBizSafe(biz);
      return sendButtons(from, {
        text:
`💸 *Record Expenses*

Single:  _fuel 30_
Many:  _fuel 30, lunch 15, zesa 50_
With method:  _salary 850 bank_

Type *done* to save  ·  *cancel* to quit`,
        buttons: [
          { id: "exp_show_categories", title: "📂 Pick by Category" },
          { id: ACTIONS.MAIN_MENU,     title: "❌ Cancel" }
        ]
      });
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
      // Paginated doc navigation: view_invoices_page_{branchId|all}_{page}
      if (a.startsWith("view_invoices_page_") || a.startsWith("view_quotes_page_") || a.startsWith("view_receipts_page_")) {
        const typeMap = { view_invoices_page_: "invoice", view_quotes_page_: "quote", view_receipts_page_: "receipt" };
        const prefix = Object.keys(typeMap).find(k => a.startsWith(k));
        const docType = typeMap[prefix];
        const rest = a.replace(prefix, "");
        const lastUnderscore = rest.lastIndexOf("_");
        const branchPart = rest.slice(0, lastUnderscore);
        const pageNum = parseInt(rest.slice(lastUnderscore + 1), 10) || 0;
        const branchId = branchPart === "all" ? null : branchPart;
        return showSalesDocs(from, docType, branchId, pageNum);
      }
      if (a.startsWith("view_invoices_branch_")) return showSalesDocs(from, "invoice", a.replace("view_invoices_branch_", ""));
      if (a === "view_all_quotes") return showSalesDocs(from, "quote", null);
      if (a.startsWith("view_quotes_branch_")) return showSalesDocs(from, "quote", a.replace("view_quotes_branch_", ""));
      if (a === "view_all_receipts") return showSalesDocs(from, "receipt", null);
      if (a.startsWith("view_receipts_branch_")) return showSalesDocs(from, "receipt", a.replace("view_receipts_branch_", ""));

      // ── Product branch selectors ───────────────────────────────────────────
if (a === "view_all_products" || a.startsWith("view_all_products_page_")) {
        if (!biz) return sendMainMenu(from);
        const products = await Product.find({ businessId: biz._id, isActive: true }).sort({ name: 1 }).lean();
        if (!products.length) { await sendText(from, "📦 No products found."); return sendProductsMenu(from); }
        const PAGE = 25;
        const page = a.startsWith("view_all_products_page_") ? parseInt(a.replace("view_all_products_page_", ""), 10) || 0 : 0;
        const totalPages = Math.ceil(products.length / PAGE);
        const slice = products.slice(page * PAGE, page * PAGE + PAGE);
        let msg = `📦 *All Products* - Page ${page + 1}/${totalPages} (${products.length} total)\n\n`;
        slice.forEach((p, i) => { msg += `${page * PAGE + i + 1}. *${p.name}* - ${formatMoney(p.unitPrice, biz.currency)}\n`; });
        await sendText(from, msg);
        const navBtns = [];
        if (page > 0)              navBtns.push({ id: `view_all_products_page_${page - 1}`, title: "⬅ Prev" });
        if (page < totalPages - 1) navBtns.push({ id: `view_all_products_page_${page + 1}`, title: "➡ Next" });
        navBtns.push({ id: ACTIONS.PRODUCTS_MENU, title: "⬅ Back" });
        return sendButtons(from, { text: "Navigate products:", buttons: navBtns.slice(0, 3) });
      }

   if (a.startsWith("view_products_branch_")) {
        // format: view_products_branch_{branchId}  OR  view_products_branch_{branchId}_page_{N}
        if (!biz) return sendMainMenu(from);
        const pageMatch = a.match(/_page_(\d+)$/);
        const page = pageMatch ? parseInt(pageMatch[1], 10) : 0;
        const branchId = a.replace(/_page_\d+$/, "").replace("view_products_branch_", "");
        const branch = await Branch.findById(branchId);
        const products = await Product.find({ businessId: biz._id, isActive: true, $or: [{ branchId }, { branchId: null }, { branchId: { $exists: false } }] }).sort({ name: 1 }).lean();
        if (!products.length) { await sendText(from, `📦 No products for ${branch?.name || "this branch"}.`); return sendProductsMenu(from); }
        const PAGE = 25;
        const totalPages = Math.ceil(products.length / PAGE);
        const slice = products.slice(page * PAGE, page * PAGE + PAGE);
        let msg = `📦 *${branch?.name || "Branch"} Products* - Page ${page + 1}/${totalPages}\n\n`;
        slice.forEach((p, i) => { msg += `${page * PAGE + i + 1}. *${p.name}* - ${formatMoney(p.unitPrice, biz.currency)}\n`; });
        await sendText(from, msg);
        const navBtns = [];
        if (page > 0)              navBtns.push({ id: `view_products_branch_${branchId}_page_${page - 1}`, title: "⬅ Prev" });
        if (page < totalPages - 1) navBtns.push({ id: `view_products_branch_${branchId}_page_${page + 1}`, title: "➡ Next" });
        navBtns.push({ id: ACTIONS.PRODUCTS_MENU, title: "⬅ Back" });
        return sendButtons(from, { text: "Navigate:", buttons: navBtns.slice(0, 3) });
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
  const phone = from.replace(/\D+/g, "");

   const sourceItems = getSupplierCatalogueSourceItems(supplier).map(item => ({
    id: item.name,
    label: item.name,
    price: item.priceLabel || null
  }));
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
        title: "🗑 Clear Cart"
      });
      actionRows.push({
        id: "find_supplier",
        title: "❌ Cancel"
      });
    } else {
      // No cart yet -just show guidance rows
      actionRows.push({
        id: `sup_cart_custom_${supplier._id}`,
        title: "✍️ Type Your Order"
      });
      actionRows.push({
        id: "find_supplier",
        title: "🔍 Other Suppliers"
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
    rows.push({ id: `sup_cart_confirm_${supplier._id}`, title: "✅ Confirm Order" });
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