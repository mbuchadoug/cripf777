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

function getSupplierCatalogueSourceItems(supplier) {
  if (!supplier) return [];

  if (supplier.profileType === "service") {
    return (supplier.rates || [])
      .filter(r => r?.service)
      .map(r => ({
        name: String(r.service).trim(),
        priceLabel: formatSupplierRateDisplay(r.rate || ""),
        rawPrice: parseSupplierRateValue(r.rate || ""),
        unit: parseSupplierRateUnit(r.rate || "") || "job"
      }));
  }

  const pricedMap = new Map();
  for (const p of (supplier.prices || [])) {
    if (!p?.product) continue;
    pricedMap.set(normalizeProductName(p.product), p);
  }

  const allProducts = Array.isArray(supplier.products) ? supplier.products : [];
  return allProducts
    .filter(Boolean)
    .filter(p => p !== "pending_upload")
    .map(name => {
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
        { id: `sup_catalog_page_open_${supplier._id}`, title: "📚 View Full Catalogue" },
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
      title: selectionMode === "search_pick" ? "⬅ Previous Matches" : "⬅ Previous Products"
    });
  }

  if (page < totalPages - 1) {
    rows.push({
      id: `sup_catalog_page_next_${supplier._id}`,
      title: selectionMode === "search_pick" ? "➡ More Matches" : "➡ More Products"
    });
  }

  if (page === 0 && selectionMode === "search_pick") {
    rows.push({ id: `sup_catalog_page_open_${supplier._id}`, title: "📚 View Full Catalogue" });
  }

  if (page === 0) {
    rows.push({ id: `sup_number_page_open_${supplier._id}`, title: "⚡ Quick Order by Number" });
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
    selectionMode
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
        { id: `sup_catalog_page_open_${supplier._id}`, title: "📚 Browse Catalogue" },
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
  const searchLine = searchTerm ? `\n🔎 Search: *${searchTerm}*` : "";

  await sendText(
    from,
`⚡ *Quick Order by Number*
${supplier.businessName}${searchLine}${cartLine}

Page ${page + 1} of ${totalPages} • ${totalItems} item${totalItems === 1 ? "" : "s"}

${numbered}

*Send item number + quantity*
Examples:
_2x3_
_7x1, 10x4_
_12x2, 15x1, 18x6_`
  );

  const buttons = [];

  if (page > 0) {
    buttons.push({ id: `sup_number_page_prev_${supplier._id}`, title: "⬅ Prev Numbers" });
  }
  if (page < totalPages - 1) {
    buttons.push({ id: `sup_number_page_next_${supplier._id}`, title: "➡ Next Numbers" });
  }

  if (buttons.length === 2) {
    await sendButtons(from, {
      text: "Choose next step:",
      buttons
    });
  } else if (buttons.length === 1) {
    await sendButtons(from, {
      text: "Choose next step:",
      buttons
    });
  }

  return sendButtons(from, {
    text: "Other options:",
    buttons: [
      { id: `sup_catalog_page_open_${supplier._id}`, title: "📚 Browse Catalogue" },
      { id: `sup_cart_view_${supplier._id}`, title: "🛒 View Cart" },
      { id: `sup_catalogue_search_${supplier._id}`, title: "🔎 Search" }
    ]
  });
}
async function _sendSupplierCartMenu(from, supplier, cart = []) {
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
      (typeof item.pricePerUnit === "number" ? ` • $${Number(item.pricePerUnit).toFixed(2)}/${item.unit || "each"}` : "")
  }));

  rows.push({
    id: `sup_cart_confirm_${supplier._id}`,
    title: supplier.profileType === "service" ? "✅ Confirm & Send Booking" : "✅ Confirm & Send Order"
  });

  rows.push({ id: `sup_cart_clear_${supplier._id}`, title: "🗑 Clear Cart" });
  rows.push({ id: `sup_catalog_page_open_${supplier._id}`, title: "📚 Add More Items" });
  rows.push({ id: `sup_catalogue_search_${supplier._id}`, title: "🔎 Search This Supplier" });
  rows.push({ id: `sup_cart_custom_${supplier._id}`, title: "✍ Type Custom Item" });

  const summary = cart
    .map(i => {
      const price = typeof i.pricePerUnit === "number" ? ` @ $${Number(i.pricePerUnit).toFixed(2)}` : "";
      return `• ${i.product} x${i.quantity}${price}`;
    })
    .join("\n");

    if (rows.length > 10) rows.splice(10);
  return sendList(
    from,
    `🛒 *Your Cart* (${cart.length} item${cart.length === 1 ? "" : "s"})\n\n${summary}`,
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
  const isGhostSupplierBiz = !!(biz && biz.name?.startsWith("pending_supplier_"));

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
const supplierAccountState = sess?.tempData?.supplierAccountState;
const supplierRegState = sess?.supplierRegState;

if (
  searchMode === "product" &&
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

  // Fetch supplier to check if delivery is required
  const _sess2 = await UserSession.findOne({ phone });
  const _sid2 = _sess2?.tempData?.orderSupplierId;
  const _sup2 = _sid2 ? await SupplierProfile.findById(_sid2).lean() : null;
  const isServiceSupplier = _sup2?.profileType === "service";
  const _needsAddress2 = isServiceSupplier || (_sup2?.delivery?.available === true);

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
        { id: "find_supplier", title: "🔍 Find Suppliers" },
        { id: "my_orders", title: "📋 My Orders" },
        { id: "onboard_business", title: "🧾 Run My Business" }
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
if (
  !isMetaAction &&
  biz &&
  !isGhostSupplierBiz &&
  text.trim().length > 2 &&
  !shortcodeBlockedStates.includes(biz.sessionState) &&
  !settingsStates.includes(biz.sessionState)
) {
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
        await saveBizSafe(biz); // save supplierSearch.product + optional searchResults
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
  // Clear previous search state in BOTH biz and UserSession
  if (biz) {
    biz.sessionData = {
      ...(biz.sessionData || {}),
      supplierSearch: {}
    };
    biz.sessionState = "supplier_search_product";
    await saveBizSafe(biz);
  }
  // Always clear UserSession — covers ghost-biz users who have biz but also buy
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

Type what you need. Add a city or suburb at the end for nearby results.

*📦 Products:*
_find cement_, _find cement mbare_, _find cooking oil harare_, _find mealie meal_, _find river sand avondale_, _find tyres bulawayo_, _find school uniforms_, _find solar panels_

*🔧 Services:*
_find plumber_, _find plumber borrowdale_, _find electrician harare_, _find teacher mabelreign_, _find tutor_, _find cleaner bulawayo_, _find painter_, _find welder workington_, _find catering_, _find photographer_, _find it support_

*🚗 Transport:*
_find car hire_, _find delivery harare_, _find moving company bulawayo_

*💡 Tip: Include your suburb for closer results!*
_find plumber avondale_, _find electrician glen view_, _find delivery chitungwiza_

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
  const items = (supplier.products || []).filter(p => p !== "pending_upload");

  await sendSupplierItemsInChunks(
    from,
    items,
    `📋 Current ${isService ? "Services" : "Products"}`
  );

  return sendList(from, "What would you like to do next?", [
    { id: "sup_add_products", title: `➕ Add ${isService ? "Services" : "Products"}` },
    { id: "sup_delete_products", title: `🗑 Delete ${isService ? "Services" : "Products"}` },
    { id: "sup_replace_products", title: `♻️ Replace Full ${isService ? "Services" : "Products"} List` },
    { id: "my_supplier_account", title: "🏪 My Account" }
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

  await sendSupplierItemsInChunks(
    from,
    items,
    `🗑 Select ${isService ? "Services" : "Products"} to Delete`
  );

  return sendText(
    from,
`Reply with the *numbers* or *exact names* you want to delete.

Examples:
*2, 5, 9*
*5-8*
*basin mixer, shower trap*

You can delete just a few items — you do NOT need to resend the whole list.

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
    biz.sessionData.supplierReg.minOrder = 0;
    biz.sessionState = "supplier_reg_confirm";
    await saveBizSafe(biz);
    return _sendSupplierConfirmPrompt(from, biz.sessionData.supplierReg);
  }


if (a === "sup_travel_no") {
    if (!biz) return sendMainMenu(from);
    biz.sessionData.supplierReg = biz.sessionData.supplierReg || {};
    biz.sessionData.supplierReg.travelAvailable = false;
    biz.sessionData.supplierReg.minOrder = 0;
    biz.sessionState = "supplier_reg_confirm";
    await saveBizSafe(biz);
    return _sendSupplierConfirmPrompt(from, biz.sessionData.supplierReg);
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
    biz.sessionState = "supplier_reg_confirm";
    await saveBizSafe(biz);
    // Use the local helper _sendSupplierConfirmPrompt - buildSupplierConfirmText
    // is not exported from supplierRegistration.js
    return _sendSupplierConfirmPrompt(from, biz.sessionData.supplierReg);
  }

if (a === "sup_del_no") {
    if (!biz) return sendMainMenu(from);
    biz.sessionData.supplierReg = biz.sessionData.supplierReg || {};
    biz.sessionData.supplierReg.delivery = { available: false };
    biz.sessionData.supplierReg.minOrder = 0;
    biz.sessionState = "supplier_reg_confirm";
    await saveBizSafe(biz);
    return _sendSupplierConfirmPrompt(from, biz.sessionData.supplierReg);
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

const results = await runSupplierSearch({ city, category, product, profileType, area: null });
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
const pageResults = results.slice(0, 9);
    const rows = formatSupplierResults(pageResults, city, category || product);
    const locationLabel = city || "All Cities";
    const searchLabel = category || product || "Suppliers";
    const hasMore = results.length > 9;
    if (hasMore) {
      if (biz) {
        biz.sessionData = { ...(biz.sessionData || {}), searchResults: results, searchPage: 0 };
        await saveBizSafe(biz);
      } else {
        await UserSession.findOneAndUpdate({ phone }, {
          $set: { "tempData.searchResults": results, "tempData.searchPage": 0 }
        }, { upsert: true });
      }
      rows.push({ id: "sup_search_next_page", title: `➡ More results (${results.length - 9} more)` });
    }
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
    // Encode the last searched product into the button so cart can pre-fill
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
  const CHUNK = 25;
  for (let i = 0; i < products.length; i += CHUNK) {
    const chunk = products.slice(i, i + CHUNK);
    const lines = chunk.map((p, j) => {
      const idx = i + j;
      const existing = supplier.prices?.find(pr =>
        pr.product?.toLowerCase() === p.toLowerCase()
      );
      const priceStr = existing
        ? ` - $${Number(existing.amount).toFixed(2)}/${existing.unit}`
        : " - _(not set)_";
      return `${idx + 1}. ${p}${priceStr}`;
    }).join("\n");

    const isFirst = i === 0;
    const isLast = i + CHUNK >= products.length;
    await sendText(from,
      isFirst
        ? `💰 *Update Prices* (${products.length} ${isService ? "services" : "products"})\n\n${lines}${isLast ? "" : "\n_(continued...)_"}`
        : `${lines}${isLast ? "" : "\n_(continued...)_"}`
    );
  }

  // ── Send instruction message separately (always short) ───────────────────
   // ── Send instruction message separately (always short) ───────────────────
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
    try {
      const orderRef = `ORD-${String(order._id).slice(-8).toUpperCase()}`;
      const deliveryNote = order.delivery?.required
        ? `Deliver to: ${order.delivery.address}`
        : isServiceSupplier
          ? `Service location: ${order.delivery?.address || "TBC"}`
          : "Collection - buyer will pick up";
      const { filename } = await generatePDF({
        type: "receipt",
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
          status: "paid"
        }
      });
      const site = (process.env.SITE_URL || "").replace(/\/$/, "");
      await sendDocument(from, { link: `${site}/docs/generated/receipts/${filename}`, filename });
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
        { id: "find_supplier", title: "🔍 Find Suppliers" },
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
    const needsAddress = isService || supplier.delivery?.available;
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
  ? `📍 *Where should we come to?*\n\nExamples:\n• _24 Borrowdale Rd, Harare_\n• _Come tomorrow 10am_`
  : `📍 *Where should we deliver?*\n\nExamples:\n• _123 Samora Machel Ave, Harare_\n• _I will collect -call me_`}

_Type your address below and send_ ✍️`,
      buttons: [
        { id: `sup_cart_clear_${supplierId}`, title: "✏️ Edit Order" },
        { id: "find_supplier", title: "❌ Cancel" }
      ]
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

  const rows = formatSupplierResults(pageResults, null, null);
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
  const rows = formatSupplierResults(pageResults, null, null);
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

  // Recover the search term that led the buyer here.
  // Prefer UserSession because it is updated on every buyer search.
  const sess = await UserSession.findOne({ phone });
  const searchedProduct =
    sess?.tempData?.supplierSearchProduct ||
    biz?.sessionData?.supplierSearch?.product ||
    "";

  // IMPORTANT FIX:
  // Do NOT pre-seed the cart from a guessed partial match.
  // Buyer must explicitly choose the exact item first.
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

  const hasSearchTerm = Boolean(String(searchedProduct || "").trim());

  await persistOrderFlowState({
    biz,
    phone,
    patch: {
      orderSupplierId: String(supplier._id),
      orderCart: initialCart,
      orderIsService: isService,
      orderBrowseMode: "catalogue",
      orderCataloguePage: 0,
      orderCatalogueSearch: hasSearchTerm ? searchedProduct : ""
    }
  });

  return _sendSupplierCatalogueBrowser(from, supplier, initialCart, {
    page: 0,
    searchTerm: hasSearchTerm ? searchedProduct : "",
    selectionMode: hasSearchTerm ? "search_pick" : "catalogue"
  });
}


if (a.startsWith("sup_number_page_open_")) {
  const supplierId = a.replace("sup_number_page_open_", "");
  const supplier = await SupplierProfile.findById(supplierId).lean();
  if (!supplier) return sendText(from, "❌ Supplier not found.");

  const cart = await getCurrentOrderCart({ biz, phone });

  await persistOrderFlowState({
    biz,
    phone,
    patch: {
      orderBrowseMode: "numbered_catalogue",
      orderSupplierId: supplierId,
      orderCataloguePage: 0
    }
  });

  const sess = await UserSession.findOne({ phone });
  const searchTerm =
    biz?.sessionData?.orderCatalogueSearch ??
    sess?.tempData?.orderCatalogueSearch ??
    "";

  return _sendSupplierNumberedCatalogueText(from, supplier, cart, {
    page: 0,
    searchTerm
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
      orderCataloguePage: 0
    }
  });

  const sess = await UserSession.findOne({ phone });
  const searchTerm =
    biz?.sessionData?.orderCatalogueSearch ??
    sess?.tempData?.orderCatalogueSearch ??
    "";

  return _sendSupplierCatalogueBrowser(from, supplier, cart, {
    page: 0,
    searchTerm
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

  // Check if item already in cart - increment qty
const existing = cart.find(c => c.product.toLowerCase() === productName.toLowerCase());
  if (existing) {
    existing.quantity += 1;
    // Recalculate total when increasing qty
    if (existing.pricePerUnit) {
      existing.total = existing.quantity * existing.pricePerUnit;
    }
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
// ── After adding to cart: for services (and small catalogues with cart items),
  // send a short confirmation nudge BEFORE the catalogue refresh.
  // This tells the buyer "added ✓ - confirm or keep browsing".
  const isServiceCart = supplier.profileType === "service";
  const addedItem = existing ? `${productName} (×${existing.quantity} total)` : productName;

  if (isServiceCart) {
    // For services: buyer added a service - tell them clearly what's next
    await sendText(from,
      `✅ *${addedItem}* added.\n\n_Tap ✅ Confirm Booking below to send your request, or add more services._`
    );
  }

// ── After adding to cart: for services, send a brief confirmation nudge ──
  // This tells the buyer what they added and what to do next.
  if (supplier.profileType === "service" && cart.length > 0) {
    const addedItem = existing
      ? `${productName} ×${existing.quantity} total`
      : productName;
    await sendText(from,
      `✅ *${addedItem}* added to your booking.\n\n_Tap ✅ Confirm Booking to send your request, or add more services below._`
    );
  }

  // Show updated catalogue with cart
 const sessAfterAdd = await UserSession.findOne({ phone });
const pageAfterAdd =
  biz?.sessionData?.orderCataloguePage ??
  sessAfterAdd?.tempData?.orderCataloguePage ??
  0;

const searchAfterAdd =
  biz?.sessionData?.orderCatalogueSearch ??
  sessAfterAdd?.tempData?.orderCatalogueSearch ??
  "";

await persistOrderFlowState({
  biz,
  phone,
  patch: {
    orderBrowseMode: "catalogue",
    orderCataloguePage: pageAfterAdd,
    orderCatalogueSearch: searchAfterAdd,
    orderSupplierId: String(supplier._id),
    orderCart: cart
  }
});

return _sendSupplierCatalogueBrowser(from, supplier, cart, {
  page: pageAfterAdd,
  searchTerm: searchAfterAdd
});
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
    const priceStr = c.pricePerUnit ? ` - $${Number(c.pricePerUnit).toFixed(2)}/${c.unit}` : "";
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

// For collection-only product suppliers, no address needed — use a placeholder
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
    await sendText(from,
`✅ *Order sent to ${supplier.businessName}!*

${itemSummary}
🏠 Collection only - you will pick up from the supplier
${pricedCount > 0 ? `💵 Estimated total: $${totalAmount.toFixed(2)}\n` : ""}📞 Supplier: ${supplier.phone}

${pricedCount === finalItems.length ? "All items were auto-priced. Supplier can confirm immediately. 🎉" : "Supplier will confirm pricing shortly. 🎉"}`);
    return sendButtons(from, {
      text: "What would you like to do next?",
      buttons: [
        { id: "find_supplier", title: "🔍 Find Suppliers" },
        { id: "my_orders", title: "📋 My Orders" }
      ]
    });
  }

  return sendButtons(from, {
    text:
`${isService ? "📅" : "🛒"} *${isService ? "Booking Summary" : "Order Summary"}*

${previewLines}${totalLine}

─────────────────
⚠️ *Your order has NOT been sent yet.*
─────────────────

*Step 2 of 2 - Enter your ${isService ? "location" : "delivery address"}* 👇

${isService
  ? `📍 *Where should we come to?*\n\nExamples:\n• _24 Borrowdale Rd, Harare_\n• _Call me when you arrive_\n• _Come tomorrow 10am, Mabelreign_`
  : `📍 *Where should we deliver?*\n\nExamples:\n• _123 Samora Machel Ave, Harare_\n• _Deliver to Avondale after 4pm_\n• _I will collect - call me_`
}

_Type your address below and send to complete your ${isService ? "booking" : "order"}_ ✍️`,
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

  await persistOrderFlowState({
  biz,
  phone,
  patch: {
    orderBrowseMode: "cart",
    orderSupplierId: supplierId,
    orderCart: []
  }
});

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

  biz.sessionData = {
    ...(biz.sessionData || {}),
    supplierSearch: {
      ...(biz.sessionData?.supplierSearch || {}),
      product: productQuery
    }
  };
  biz.sessionState = "supplier_search_city";
  await saveBizSafe(biz);

  return sendList(from, `🔍 Looking for: *${productQuery}*\n\nWhich city?`, [
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
  const _needsAddressBiz = isServiceSupplier || (_supBiz?.delivery?.available === true);

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
        { id: "find_supplier", title: "🔍 Find Suppliers" },
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
  ? `📍 *Where should we come to?*\n\nExamples:\n• _24 Borrowdale Rd, Harare_\n• _Call me when you arrive_\n• _Come tomorrow 10am_`
  : `📍 *Where should we deliver?*\n\nExamples:\n• _123 Samora Machel Ave, Harare_\n• _Deliver to Avondale after 4pm_\n• _I will collect - call me_`
}

_Type your address below and send to complete your ${isServiceSupplier ? "booking" : "order"}_ ✍️`,
  buttons: [
    { id: "find_supplier", title: "❌ Cancel Order" }
  ]
});
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