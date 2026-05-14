/**
 * invoiceHelpers.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Shared helpers for invoice / quotation / receipt flows.
 * Supports both products (qty × unit price) and services (units × rate/type).
 *
 * Place this file at:  services/invoiceHelpers.js
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { sendButtons } from "./metaSender.js";
import { sendInvoiceConfirmMenu } from "./metaMenus.js";

// ─── Currency ────────────────────────────────────────────────────────────────

function currencySymbol(cur) {
  const c = (cur || "").toUpperCase();
  if (c === "USD") return "$";
  if (c === "ZWL") return "Z$";
  if (c === "ZAR") return "R";
  return c ? c + " " : "";
}

export function formatMoney(amount, currency) {
  const sym = currencySymbol(currency);
  const n   = Number(amount);
  if (Number.isNaN(n)) return `${sym}${amount}`;
  return `${sym}${n.toFixed(2)}`;
}

// ─── Service rate types ───────────────────────────────────────────────────────

export const VALID_RATE_UNITS = [
  "job", "hour", "day", "meter", "room", "visit", "project", "km", "piece", "sqm", "night"
];

/**
 * Parse a rate string like "50/job" or "20/hour".
 * Returns { amount: number, unit: string } or null if format is invalid.
 */
export function parseServiceRate(text) {
  if (!text || typeof text !== "string") return null;
  const match = text.trim().match(/^(\d+(?:\.\d+)?)\s*\/\s*(\w+)$/i);
  if (!match) return null;
  const amount = parseFloat(match[1]);
  const unit   = match[2].toLowerCase();
  if (isNaN(amount) || amount < 0) return null;
  return { amount, unit };
}

/**
 * Format a service rate for display: "$50/job"
 */
export function formatServiceRate(amount, unit, currency) {
  return `${formatMoney(amount, currency)}/${unit}`;
}

// ─── 1. Parse comma-separated product/service names ──────────────────────────
/**
 * "house wiring, solar installation, geyser repair"
 *   → ["house wiring", "solar installation", "geyser repair"]
 * Drops entries shorter than 2 characters.
 */
export function parseCommaNames(text) {
  if (!text || typeof text !== "string") return [];
  return text
    .split(",")
    .map(s => s.trim())
    .filter(s => s.length >= 2);
}

// ─── 2. Build numbered catalogue list text ───────────────────────────────────
/**
 * Builds a WhatsApp-formatted numbered list of products or services.
 * Services show their rate unit where available (e.g. "$50/job").
 * Items with no price show "(no price)".
 *
 * @param {Array<{name, unitPrice, rateUnit?, isService?}>} products
 * @param {string} currency
 * @param {number} startAt  1-based offset for pagination (default 1)
 * @returns {string}
 */
export function buildNumberedCatalogueText(products, currency, startAt = 1) {
  if (!products || products.length === 0) return "_(empty)_";
  return products
    .map((p, i) => {
      const num      = startAt + i;
      const hasPrice = Number(p.unitPrice) > 0;
      let priceTag;
      if (!hasPrice) {
        priceTag = " - _(no price)_";
      } else if (p.rateUnit) {
        priceTag = ` - ${formatServiceRate(p.unitPrice, p.rateUnit, currency)}`;
      } else {
        priceTag = ` - ${formatMoney(p.unitPrice, currency)}`;
      }
      const icon = p.isService ? " 🔧" : "";
      return `${num}. *${p.name}*${icon}${priceTag}`;
    })
    .join("\n");
}

// ─── 3. Parse "NxQTY" quick-pick entries ─────────────────────────────────────
/**
 * Parses "3x2, 7x1, 12x5" against a catalogue.
 * Also supports service unit suffixes: "1x2 hours", "2x1 job".
 *
 * Returns:
 *   picked → [{ item, qty, unit, rateUnit, source, isService }]
 *   errors → [string]
 */
export function parsePickEntries(text, catalogue) {
  const entries = (text || "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);

  const picked = [];
  const errors = [];

  for (const entry of entries) {
    // Accepts: "3x2" | "3 x 2" | "3x2 hours" | "3 x 2 jobs"
    const match = entry.match(/^(\d+)\s*[xX×]\s*(\d+(?:\.\d+)?)(?:\s+(\w+))?$/);
    if (!match) { errors.push(`"${entry}" - use _NxQTY_ format`); continue; }

    const itemNum   = parseInt(match[1], 10);
    const qty       = parseFloat(match[2]);
    const rateLabel = match[3] ? match[3].toLowerCase() : null;

    if (itemNum < 1 || itemNum > catalogue.length) {
      errors.push(`#${itemNum} out of range`); continue;
    }
    if (isNaN(qty) || qty <= 0) {
      errors.push(`bad qty for #${itemNum}`); continue;
    }

    const product = catalogue[itemNum - 1];
    picked.push({
      item:      product.name,
      qty,
      unit:      Number(product.unitPrice) || 0,
      rateUnit:  product.rateUnit || rateLabel || null,
      source:    product.source || "catalogue",
      isService: product.isService || false
    });
  }

  return { picked, errors };
}

// ─── 4. Find indexes of unpriced items ───────────────────────────────────────
export function findUnpricedIndexes(items) {
  return (items || [])
    .map((item, idx) => (Number(item.unit) === 0 ? idx : null))
    .filter(idx => idx !== null);
}

// ─── 5. Build unpriced items prompt ──────────────────────────────────────────
export function buildUnpricedPromptText(items, unpricedIndexes, currency) {
  const lines = unpricedIndexes
    .map((idx, i) => `${i + 1}. *${items[idx].item}* × ${items[idx].qty}`)
    .join("\n");

  const exPrices = unpricedIndexes
    .map((_, i) => ((i + 1) * 5).toFixed(2))
    .join(", ");

  const allNote = unpricedIndexes.length > 1
    ? `\n\n_Or send ONE price to apply to all ${unpricedIndexes.length} items._`
    : "";

  return (
    `💰 *${unpricedIndexes.length} item${unpricedIndexes.length === 1 ? " needs" : "s need"} a price:*\n\n` +
    `${lines}\n\n─────────────────\n` +
    `Enter prices in order, separated by commas:\n` +
    `_Example:_ *${exPrices}*${allNote}`
  );
}

// ─── 6. Apply bulk prices to unpriced items ───────────────────────────────────
/**
 * Parses comma-separated price input and applies it to unpriced items.
 * Mutates `items` in-place. Returns { ok: true } or { ok: false, message }.
 */
export function applyBulkPrices(trimmed, items, unpricedIndexes) {
  const parts    = trimmed.split(",").map(s => s.trim()).filter(Boolean);
  const allValid = parts.length > 0 && parts.every(p => !isNaN(Number(p)) && Number(p) >= 0);

  if (!allValid) {
    return { ok: false, message: "❌ Numbers only, separated by commas.\n_Example: 5.50, 3.00, 12.50_" };
  }

  if (parts.length === 1) {
    const price = Number(parts[0]);
    for (const idx of unpricedIndexes) items[idx].unit = price;
    return { ok: true };
  }

  if (parts.length === unpricedIndexes.length) {
    unpricedIndexes.forEach((idx, i) => { items[idx].unit = Number(parts[i]); });
    return { ok: true };
  }

  return {
    ok: false,
    message:
      `❌ You sent *${parts.length} price${parts.length === 1 ? "" : "s"}* but ` +
      `there ${unpricedIndexes.length === 1 ? "is" : "are"} ` +
      `*${unpricedIndexes.length} item${unpricedIndexes.length === 1 ? "" : "s"}* needing prices.\n\n` +
      `Send *${unpricedIndexes.length}* prices in order, or *one* price for all.`
  };
}

// ─── 7. Build full document preview text ─────────────────────────────────────
/**
 * Builds the WhatsApp preview for invoice / quote / receipt.
 * Services show rate + units; products show qty × price.
 */
export function buildDocPreviewText(biz, extraNote = "") {
  const items       = biz.sessionData.items || [];
  const currency    = biz.currency || "USD";
  const docType     = biz.sessionData.docType || "invoice";
  const label       = docType === "invoice" ? "Invoice" : docType === "quote" ? "Quotation" : "Receipt";
  const discountPct = Number(biz.sessionData.discountPercent || 0);
  const vatPct      = Number(biz.sessionData.vatPercent || 0);
  const subtotal    = items.reduce((s, i) => s + Number(i.qty) * Number(i.unit), 0);
  const discountAmt = subtotal * (discountPct / 100);
  const vatAmt      = (subtotal - discountAmt) * (vatPct / 100);
  const total       = subtotal - discountAmt + vatAmt;

  const itemLines = items
    .map((it, idx) => {
      const lineTotal = Number(it.qty) * Number(it.unit);
      if (it.isService && it.rateUnit) {
        return (
          `${idx + 1}. *${it.item}*\n` +
          `   Rate: ${formatServiceRate(it.unit, it.rateUnit, currency)}\n` +
          `   Units: ${it.qty} ${it.rateUnit}${it.qty !== 1 ? "s" : ""}\n` +
          `   Total: *${formatMoney(lineTotal, currency)}*`
        );
      }
      return (
        `${idx + 1}. *${it.item}*\n` +
        `   Qty: ${it.qty} × ${formatMoney(it.unit, currency)} = *${formatMoney(lineTotal, currency)}*`
      );
    })
    .join("\n");

  const discountLine = discountPct > 0 ? `\n💸 Discount ${discountPct}%: -${formatMoney(discountAmt, currency)}` : "";
  const vatLine      = vatPct > 0      ? `\n🧾 VAT ${vatPct}%: +${formatMoney(vatAmt, currency)}`               : "";
  const extraLine    = extraNote       ? `\n${extraNote}`                                                         : "";

  return (
    `🧾 *${label} Preview*${extraLine}\n\n` +
    `${itemLines}\n` +
    `─────────────────\n` +
    `Subtotal: ${formatMoney(subtotal, currency)}${discountLine}${vatLine}\n` +
    `*TOTAL: ${formatMoney(total, currency)}*`
  );
}

// ─── 8. Send document preview + confirm menu ─────────────────────────────────
export async function sendDocPreview(to, biz, extraNote = "") {
  const text = buildDocPreviewText(biz, extraNote);
  return sendInvoiceConfirmMenu(to, text);
}

// ─── 9. Preserve core session fields across resets ───────────────────────────
export function preserveSessionCore(biz) {
  return {
    docType:        biz.sessionData?.docType        || "invoice",
    targetBranchId: biz.sessionData?.targetBranchId || null
  };
}

// ─── 10. Send "add item" prompt ───────────────────────────────────────────────
export async function sendAddItemPrompt(to) {
  return sendButtons(to, {
    text: "➕ *How would you like to add an item?*",
    buttons: [
      { id: "inv_item_catalogue", title: "📦 Catalogue" },
      { id: "inv_item_custom",    title: "✍️ Custom item" }
    ]
  });
}

// ─── 11. Build save-preview text (before saving products/services) ────────────
/**
 * Preview shown to the user before names are committed to the database.
 *
 * @param {string[]} names
 * @param {boolean}  isService
 * @returns {string}
 */
export function buildSavePreviewText(names, isService = false) {
  const label  = isService ? "service" : "product";
  const plural = isService ? "services" : "products";
  const numbered = names.map((n, i) => `${i + 1}. ${n}`).join("\n");
  return (
    `📋 *You are about to save these ${plural}:*\n\n` +
    `${numbered}\n\n` +
    `💡 Prices: _Not added yet_\n` +
    `_You can add prices later from the ${label.charAt(0).toUpperCase() + label.slice(1)}s menu._`
  );
}

// ─── 12. Parse price-update entries: "1 x 12, 2 x 35" ────────────────────────
/**
 * Parses "1 x 12, 2 x 35, 3 x 28" for product price updates.
 * Also accepts service rates: "1 x 20/hour, 2 x 50/job".
 *
 * @param {string} text
 * @param {Array<{name}>} catalogue
 * @returns {{ updates: Array<{index, name, price, rateUnit}>, errors: string[] }}
 */
export function parsePriceUpdates(text, catalogue) {
  const entries = (text || "").split(",").map(s => s.trim()).filter(Boolean);
  const updates = [];
  const errors  = [];

  for (const entry of entries) {
    // "1 x 20/hour"  |  "1 x 50"  |  "1x50"
    const match = entry.match(/^(\d+)\s*[xX×]\s*(\d+(?:\.\d+)?)(?:\/(\w+))?$/);
    if (!match) { errors.push(`"${entry}" - use _N x price_ or _N x price/rate_`); continue; }

    const itemNum = parseInt(match[1], 10);
    const price   = parseFloat(match[2]);
    const unit    = match[3] ? match[3].toLowerCase() : null;

    if (itemNum < 1 || itemNum > catalogue.length) {
      errors.push(`#${itemNum} out of range`); continue;
    }
    if (isNaN(price) || price < 0) {
      errors.push(`bad price for #${itemNum}`); continue;
    }

    updates.push({ index: itemNum - 1, name: catalogue[itemNum - 1].name, price, rateUnit: unit });
  }

  return { updates, errors };
}

// ─── 13. Build price-update preview text ─────────────────────────────────────
/**
 * Preview shown before price updates are saved.
 *
 * @param {Array<{name, price, rateUnit}>} updates
 * @param {string}  currency
 * @param {boolean} isService
 * @returns {string}
 */
export function buildPriceUpdatePreviewText(updates, currency, isService = false) {
  const label = isService ? "service rates" : "product prices";
  const lines = updates.map((u, i) => {
    const display = u.rateUnit
      ? formatServiceRate(u.price, u.rateUnit, currency)
      : formatMoney(u.price, currency);
    return `${i + 1}. ${u.name} - *${display}*`;
  }).join("\n");

  return (
    `💰 *You are about to update ${label}:*\n\n` +
    `${lines}`
  );
}