/**
 * invoiceHelpers.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Shared helpers for invoice / quotation / receipt flows.
 * Drop this file at:  services/invoiceHelpers.js
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

// ─── 1. Parse comma-separated product/service names ──────────────────────────
/**
 * "house wiring, solar installation, geyser repair"
 *   → ["house wiring", "solar installation", "geyser repair"]
 *
 * Drops entries < 2 characters.
 */
export function parseCommaNames(text) {
  if (!text || typeof text !== "string") return [];
  return text
    .split(",")
    .map(s => s.trim())
    .filter(s => s.length >= 2);
}

// ─── 2. Build numbered catalogue text ────────────────────────────────────────
/**
 * Returns a WhatsApp-formatted numbered list of catalogue items.
 *
 * @param {Array<{name:string, unitPrice:number, source?:string}>} products
 * @param {string} currency
 * @param {number} startAt  1-based page offset (default 1)
 * @returns {string}
 */
export function buildNumberedCatalogueText(products, currency, startAt = 1) {
  if (!products || products.length === 0) return "_(empty)_";
  return products
    .map((p, i) => {
      const num      = startAt + i;
      const hasPrice = Number(p.unitPrice) > 0;
      const tag      = hasPrice
        ? ` — ${formatMoney(p.unitPrice, currency)}`
        : " — _(no price)_";
      return `${num}. *${p.name}*${tag}`;
    })
    .join("\n");
}

// ─── 3. Parse "NxQTY" quick-pick entries ─────────────────────────────────────
/**
 * Parses "3x2, 7x1, 12x5" against a catalogue array.
 *
 * Returns:
 *   picked  → [{ item, qty, unit, source }]  unit=0 means price still needed
 *   errors  → [string]  human-readable descriptions of bad entries
 */
export function parsePickEntries(text, catalogue) {
  const entries = (text || "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);

  const picked = [];
  const errors = [];

  for (const entry of entries) {
    const match = entry.match(/^(\d+)\s*[xX×]\s*(\d+(?:\.\d+)?)$/);
    if (!match) { errors.push(`"${entry}" — use _NxQTY_ format`); continue; }

    const itemNum = parseInt(match[1], 10);
    const qty     = parseFloat(match[2]);

    if (itemNum < 1 || itemNum > catalogue.length) {
      errors.push(`#${itemNum} out of range`); continue;
    }
    if (isNaN(qty) || qty <= 0) {
      errors.push(`bad qty for #${itemNum}`); continue;
    }

    const product = catalogue[itemNum - 1];
    picked.push({
      item:   product.name,
      qty,
      unit:   Number(product.unitPrice) || 0,
      source: product.source || "catalogue"
    });
  }

  return { picked, errors };
}

// ─── 4. Find indexes of unpriced items ───────────────────────────────────────
/**
 * Returns indexes into `items` where unit === 0.
 */
export function findUnpricedIndexes(items) {
  return (items || [])
    .map((item, idx) => (Number(item.unit) === 0 ? idx : null))
    .filter(idx => idx !== null);
}

// ─── 5. Build the "enter prices" prompt for unpriced catalogue items ──────────
/**
 * @param {Array}    items
 * @param {number[]} unpricedIndexes
 * @param {string}   currency
 * @returns {string}
 */
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
 * Parses user's comma-separated price input and applies it to unpriced items.
 * Mutates `items` in place.
 *
 * Returns { ok: true } on success, { ok: false, message: string } on error.
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
 * Builds the complete WhatsApp preview for invoice / quote / receipt.
 * Shows item lines, subtotal, discount (if set), VAT (if set), TOTAL.
 *
 * @param {Object} biz
 * @param {string} extraNote  Optional note appended below the label line
 * @returns {string}
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
      return (
        `${idx + 1}. ${it.item} × ${it.qty}` +
        ` @ ${formatMoney(it.unit, currency)}` +
        ` = *${formatMoney(lineTotal, currency)}*`
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
/**
 * Sends the full preview and the confirm/edit/cancel action menu.
 * This is THE single function all three doc types call before PDF generation.
 */
export async function sendDocPreview(to, biz, extraNote = "") {
  const text = buildDocPreviewText(biz, extraNote);
  return sendInvoiceConfirmMenu(to, text);
}

// ─── 9. Preserve core session fields across resets ───────────────────────────
/**
 * Returns { docType, targetBranchId } extracted from the current session.
 * Call this BEFORE any wholesale `biz.sessionData = { ... }` replacement
 * so docType and branch selection are never lost.
 */
export function preserveSessionCore(biz) {
  return {
    docType:        biz.sessionData?.docType        || "invoice",
    targetBranchId: biz.sessionData?.targetBranchId || null
  };
}

// ─── 10. Send "add item" prompt ───────────────────────────────────────────────
/**
 * The standard "Catalogue / Custom item" choice buttons.
 * All three doc flows use this identical prompt.
 */
export async function sendAddItemPrompt(to) {
  return sendButtons(to, {
    text: "➕ *How would you like to add an item?*",
    buttons: [
      { id: "inv_item_catalogue", title: "📦 Catalogue" },
      { id: "inv_item_custom",    title: "✍️ Custom item" }
    ]
  });
}