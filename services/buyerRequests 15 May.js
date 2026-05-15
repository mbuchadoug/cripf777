// services/buyerRequests.js
// ─── Buyer Request Service ────────────────────────────────────────────────────
//
// Handles:
//   - Auto-close / timeout of open requests
//   - Buyer request history queries
//   - Supplier response speed tracking
//   - Quote comparison formatting
//   - Request summary formatting
//   - Quantity parsing (spec vs qty disambiguation)
//   - Repeat request support
//
// Usage: import named exports into chatbotEngine.js and your cron runner.
//
// IMPORTANT: This file uses the buyerRequest2 model filename.
// If yours is at models/buyerRequest.js, update the import path below.

import BuyerRequest from "../models/buyerRequest2.js";
import SupplierProfile from "../models/supplierProfile.js";
import { sendText, sendButtons } from "./metaSender.js";

// ─────────────────────────────────────────────────────────────────────────────
// QUANTITY PARSING - spec numbers vs quantity numbers
// ─────────────────────────────────────────────────────────────────────────────
// Rule: measurement/spec suffixes (mm, kg, kW, V, etc.) stay attached to the
// product name. Quantity is the LAST standalone number or "x N unit" pattern.
//
// Examples:
//   "copper pipe 15mm, 5 lengths"  → product="copper pipe 15mm"  qty=5 unit="lengths"
//   "HDPE pipe 20mm x10m, 3 rolls" → product="HDPE pipe 20mm x10m" qty=3 unit="rolls"
//   "cement 50kg, 20 bags"         → product="cement 50kg"         qty=20 unit="bags"
//   "gate valve ½\", 6"             → product="gate valve ½\""      qty=6 unit="units"
//   "MCB 20A x4"                   → product="MCB 20A"             qty=4 unit="units"
//   "copper pipe 15mm x20m"        → product="copper pipe 15mm x20m" qty=1 (no qty given)

const SPEC_UNITS = new Set([
  "mm","cm","m","km","ml","l","kg","g","mg","lb","lbs","oz","ft","in","inch",
  "psi","bar","kpa","mpa","kw","kva","hp","v","volt","amp","amps","watt","w","a","ah",
  "litre","litres","liter","liters","tonne","tonnes","ton","tons","metre","metres",
  "meter","meters","gallon","gallons","sqm","sqft","kwh","mhz","ghz","mb","gb","tb",
  "rpm","nm","khz","mw","gw","x10m","x20m","x6m","x3m","x1m","x2m"
]);

const QTY_UNITS = new Set([
  "bags","bag","lengths","length","rolls","roll","sheets","sheet",
  "pieces","pcs","pc","piece","units","unit","boxes","box","sets","set",
  "pairs","pair","tons","coils","coil","drums","drum","metres","meters",
  "litres","liters","lengths","tins","tin","bottles","bottle","cans","can",
  "buckets","bucket","packs","pack","cartons","carton"
]);

/**
 * Parse a single buyer request line, correctly separating spec from quantity.
 * Returns { product, quantity, unitLabel }
 */
export function parseBuyerRequestLineWithQty(raw = "") {
  const line = String(raw || "").trim();
  if (!line) return { product: line, quantity: 1, unitLabel: "units" };

  // Case 1: explicit "x N unit?" at the END - always qty
  // e.g. "copper pipe 15mm x5", "cement 50kg x 20 bags"
  const xMatch = line.match(/^(.+?)\s+x\s*(\d+(?:\.\d+)?)\s*([a-zA-Z]*)$/i);
  if (xMatch) {
    const prod = xMatch[1].trim();
    const qty  = Number(xMatch[2]);
    const unit = xMatch[3].toLowerCase() || "units";
    // If the unit is a spec unit (e.g. "x20m") - it's the pipe length, not qty
    if (!SPEC_UNITS.has(unit) && qty > 0) {
      return { product: prod, quantity: qty, unitLabel: unit || "units" };
    }
    // It's a spec - whole line is the product, qty defaults to 1
    return { product: line, quantity: 1, unitLabel: "units" };
  }

  // Case 2: trailing "N unit" - qty only if unit is a known QTY unit
  // e.g. "cement 50kg, 20 bags" → product="cement 50kg", qty=20, unit="bags"
  const trailMatch = line.match(/^(.+?),?\s+(\d+(?:\.\d+)?)\s+([a-zA-Z]+)$/i);
  if (trailMatch) {
    const prod = trailMatch[1].replace(/,\s*$/, "").trim();
    const qty  = Number(trailMatch[2]);
    const unit = trailMatch[3].toLowerCase();
    if (QTY_UNITS.has(unit) && qty > 0) {
      return { product: prod, quantity: qty, unitLabel: unit };
    }
  }

  // Case 3: trailing bare number - only if no spec suffix follows
  // e.g. "gate valve ½\", 6" or "copper pipe 15mm, 5"
  const bareNumMatch = line.match(/^(.+?),?\s+(\d+(?:\.\d+)?)$/);
  if (bareNumMatch) {
    const prod = bareNumMatch[1].replace(/,\s*$/, "").trim();
    const qty  = Number(bareNumMatch[2]);
    // Check if the product part ends with a measurement spec already (e.g. "20mm")
    const endsWithSpec = /\d+\s*(mm|cm|kg|ml|l|m|ft|in|psi|bar|v|w|a|kw|kva|hp|ah|litre|liter)$/i.test(prod);
    if (!endsWithSpec && qty > 0 && qty < 100000) {
      return { product: prod, quantity: qty, unitLabel: "units" };
    }
  }

  // Case 4: No quantity found - whole line is product, qty=1
  return { product: line.replace(/,\s*$/, "").trim(), quantity: 1, unitLabel: "units" };
}

/**
 * Parse a full item list text into structured items.
 * Handles comma-separated and newline-separated lists.
 * Each item goes through parseBuyerRequestLineWithQty.
 */
export function parseItemListWithQty(text = "") {
  const raw = String(text || "").trim();
  if (!raw) return [];

  // Split by newline first, then by comma if single-line
  let lines = raw.split(/\n+/).map(l => l.trim()).filter(Boolean);
  if (lines.length === 1) {
    // Single line - might be comma-separated list
    lines = raw.split(/,\s*/).map(l => l.trim()).filter(Boolean);
  }

  return lines
    .map(parseBuyerRequestLineWithQty)
    .filter(item => item.product && item.product.length > 1);
}

// ─────────────────────────────────────────────────────────────────────────────
// AUTO-CLOSE EXPIRED REQUESTS
// ─────────────────────────────────────────────────────────────────────────────
// Finds all "open" requests older than timeoutMinutes and closes them.
// Sends the buyer a final summary notification.
// Call from: cron job (every 5 min) OR at top of handleIncoming() (non-blocking).

export async function autoCloseExpiredRequests({
  timeoutMinutes = 15,
  notifyBuyer    = true
} = {}) {
  const cutoff = new Date(Date.now() - timeoutMinutes * 60 * 1000);

  const expiredRequests = await BuyerRequest.find({
    status:    "open",
    createdAt: { $lt: cutoff }
  }).lean();

  if (!expiredRequests.length) return 0;

  console.log(`[AUTO-CLOSE] Processing ${expiredRequests.length} expired request(s)`);

  for (const req of expiredRequests) {
    try {
      // Mark closed first so concurrent runs skip it
      const updated = await BuyerRequest.findOneAndUpdate(
        { _id: req._id, status: "open" },   // guard: only close if still open
        { $set: { status: "closed" } },
        { new: false }                        // returns original - if null, already closed
      );
      if (!updated) continue;                 // another process beat us to it

      if (!notifyBuyer || !req.buyerPhone) continue;

      const validQuotes = (req.responses || []).filter(
        r => r.mode !== "unavailable" && (r.items?.length || r.message)
      );

      if (validQuotes.length > 0) {
        // Build mini comparison for the close notification
        const topQuotes = validQuotes.slice(0, 3).map((q, i) => {
          const name      = q.supplierName || `Supplier ${i + 1}`;
          const totalLine = typeof q.totalAmount === "number"
            ? ` - $${Number(q.totalAmount).toFixed(2)}`
            : "";
          return `${i + 1}. 🏪 ${name}${totalLine}`;
        }).join("\n");

        const moreCount = validQuotes.length > 3 ? ` (+${validQuotes.length - 3} more)` : "";
        const ref       = _buildRef(req);

        await sendButtons(req.buyerPhone, {
          text:
            `⏱ *Request Closed* (${ref})\n\n` +
            `You received *${validQuotes.length} quote${validQuotes.length === 1 ? "" : "s"}*:\n\n` +
            `${topQuotes}${moreCount}\n\n` +
            `Tap below to compare all quotes and contact a seller.`,
          buttons: [
            { id: `buyer_view_all_quotes_${req._id}`, title: "📊 Compare All Quotes" },
            { id: "sup_request_sellers",               title: "⚡ New Request" }
          ]
        });
      } else {
        // Zero quotes - never a dead end: give 3 clear options
        await sendButtons(req.buyerPhone, {
          text:
            `⏱ *No quotes received* (${_buildRef(req)})\n\n` +
            `No sellers responded within ${timeoutMinutes} minutes.\n\n` +
            `This can happen when items are specialised or no sellers in your area stock them right now.\n\n` +
            `Your request is saved - new sellers will be notified automatically if they match.`,
          buttons: [
            { id: "sup_request_sellers", title: "⚡ New Request" },
            { id: "find_supplier",       title: "🔍 Browse & Shop" }
          ]
        });
      }
    } catch (err) {
      console.error(`[AUTO-CLOSE] Error on request ${req._id}:`, err.message);
    }
  }

  return expiredRequests.length;
}

// ─────────────────────────────────────────────────────────────────────────────
// GET BUYER REQUEST HISTORY
// ─────────────────────────────────────────────────────────────────────────────

export async function getBuyerOpenRequests(buyerPhone, limit = 10) {
  const phone = String(buyerPhone || "").replace(/\D+/g, "");
  if (!phone) return [];

  return BuyerRequest.find({
    buyerPhone: { $in: [phone, `263${phone.slice(1)}`, `+263${phone.slice(1)}`] },
    status: { $in: ["open", "closed"] }
  })
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean();
}

// ─────────────────────────────────────────────────────────────────────────────
// TRACK SUPPLIER RESPONSE SPEED
// ─────────────────────────────────────────────────────────────────────────────
// Call this (non-blocking) immediately after a supplier submits a quote.
// Updates a rolling average on SupplierProfile.

export async function trackSupplierResponseSpeed(supplierPhone, requestCreatedAt) {
  try {
    if (!supplierPhone || !requestCreatedAt) return;

    const now          = new Date();
    const requestTime  = new Date(requestCreatedAt);
    const minutesTaken = Math.max(0, Math.round((now - requestTime) / 60000));

    const supplier = await SupplierProfile.findOne({ phone: supplierPhone }).lean();
    if (!supplier) return;

    const prevCount = supplier.responseCount       || 0;
    const prevAvg   = supplier.avgResponseMinutes  || 0;

    // Weighted rolling average (cap at 99 for the count denominator to avoid
    // one ancient outlier dominating forever)
    const effectiveCount = Math.min(prevCount, 99);
    const newAvg = effectiveCount === 0
      ? minutesTaken
      : Math.round(((prevAvg * effectiveCount) + minutesTaken) / (effectiveCount + 1));

    await SupplierProfile.findOneAndUpdate(
      { phone: supplierPhone },
      {
        $set: {
          lastRespondedAt:    now,
          avgResponseMinutes: newAvg
        },
        $inc: { responseCount: 1 }
      }
    );

    console.log(
      `[RESP SPEED] ${supplierPhone}: ${minutesTaken} min | new avg: ${newAvg} min | count: ${prevCount + 1}`
    );
  } catch (err) {
    // Non-critical - never throw
    console.error("[RESP SPEED TRACK]", err.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// FORMAT REQUEST SUMMARY (single request, for buyer's overview)
// ─────────────────────────────────────────────────────────────────────────────

export function formatRequestSummary(request) {
  if (!request) return "No request found.";

  const items = (request.items || [])
    .map((item, i) => {
      const qty  = Number(item.quantity || 1);
      const unit = item.unitLabel && item.unitLabel !== "units" ? ` ${item.unitLabel}` : "";
      return `${i + 1}. ${item.product} x${qty}${unit}`;
    })
    .join("\n");

  const locationLine = request.area
    ? `📍 ${request.area}${request.city ? `, ${request.city}` : ""}`
    : request.city
      ? `📍 ${request.city}`
      : `📍 Location not specified`;

  const statusIcon  = request.status === "open" ? "🟢" : "🔴";
  const statusLabel = request.status === "open"  ? "Open - waiting for quotes"
    : request.status === "closed"                ? "Closed"
    : "Expired";

  const validQuotes = (request.responses || []).filter(
    r => r.mode !== "unavailable" && (r.items?.length || r.message)
  );
  const unavailCount = (request.responses || []).filter(r => r.mode === "unavailable").length;

  const ref = _buildRef(request);

  return [
    `📋 *Request ${ref}*`,
    "",
    items,
    "",
    locationLine,
    (() => {
      const _isSvc = request.isServiceRequest || (request.items || []).some(item => {
        const n = (item.product || item.service || "").toLowerCase();
        return ["install","repair","fix","service","replace","plumb","geyser","electric","paint","build","clean","weld","garden","tutor","photograph","cater","design","print"].some(k => n.includes(k));
      });
      if (_isSvc) return request.serviceAddress ? `📍 Service address: ${request.serviceAddress}` : "📍 Client will share address";
      return request.deliveryRequired ? "🚚 Delivery needed" : "🏠 Collection / flexible";
    })(),
    `${statusIcon} ${statusLabel}`,
    `💬 Quotes received: ${validQuotes.length}`,
    unavailCount > 0 ? `❌ Unavailable responses: ${unavailCount}` : ""
  ].filter(l => l !== "").join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// FORMAT BUYER QUOTE COMPARISON (all quotes side-by-side)
// ─────────────────────────────────────────────────────────────────────────────

export function formatBuyerQuoteComparison(request) {
  if (!request) return "❌ Request not found.";

  const quotes = (request.responses || []).filter(
    r => r.mode !== "unavailable" && (r.items?.length || r.message)
  );

  if (!quotes.length) {
    return (
      `📭 *No quotes received yet.*\n\n` +
      `Sellers have been notified. Check back in a few minutes or wait for the chatbot to notify you automatically.`
    );
  }

  const divider = "─────────────────";

  const blocks = quotes.map((q, qi) => {
    const name  = q.supplierName || `Supplier ${qi + 1}`;
    const lines = [];

    // Fast-responder badge: responded within 5 min of request creation
    const responseTime = q.respondedAt
      ? Math.round((new Date(q.respondedAt) - new Date(request.createdAt)) / 60000)
      : null;
    const fastBadge = responseTime !== null && responseTime <= 5 ? ` ⚡ ${responseTime} min` : "";

    lines.push(`🏪 *${qi + 1}. ${name}*${fastBadge}`);

    if ((q.items || []).length) {
      q.items.forEach(item => {
        const qty   = Number(item.quantity || 1);
        const price = typeof item.pricePerUnit === "number" && !isNaN(item.pricePerUnit)
          ? `$${Number(item.pricePerUnit).toFixed(2)}/${item.unit || "each"} = $${Number(item.total || 0).toFixed(2)}`
          : "❌ Not available";
        lines.push(`  • ${item.product} x${qty} → ${price}`);
      });
    }

    if (typeof q.totalAmount === "number" && !isNaN(q.totalAmount)) {
      lines.push(`  💵 *Total: $${Number(q.totalAmount).toFixed(2)}*`);
    }

    if (q.etaText)  lines.push(`  ⏱ ${q.etaText}`);
    if (q.message)  lines.push(`  📝 ${q.message}`);

    lines.push(`  📞 ${q.supplierPhone}`);

    return lines.join("\n");
  });

  const ref = _buildRef(request);

  return [
    `💼 *Quote Comparison* (${ref})`,
    `${quotes.length} seller${quotes.length === 1 ? "" : "s"} responded`,
    "",
    ...blocks.join(`\n\n${divider}\n\n`).split("\n")
  ].join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// GET BUYER'S LAST CLOSED REQUEST (for "Repeat last request" feature)
// ─────────────────────────────────────────────────────────────────────────────

export async function getBuyerLastRequest(buyerPhone) {
  const phone = String(buyerPhone || "").replace(/\D+/g, "");
  if (!phone) return null;

  return BuyerRequest.findOne({
    buyerPhone: { $in: [phone, `263${phone.slice(1)}`, `+263${phone.slice(1)}`] }
  })
    .sort({ createdAt: -1 })
    .lean();
}

// ─────────────────────────────────────────────────────────────────────────────
// INTERNAL: build a short human-readable reference like REQ-A1B2
// (mirrors the same logic in chatbotEngine.js - keep in sync)
// ─────────────────────────────────────────────────────────────────────────────
function _buildRef(request) {
  if (!request?._id) return "REQ-????";
  const hex = String(request._id).slice(-4).toUpperCase();
  return `REQ-${hex}`;
}