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
//
// IMPORTANT: This file uses the buyerRequest2 model filename.
// If yours is at models/buyerRequest.js, update the import path below.

import BuyerRequest from "../models/buyerRequest2.js";
import SupplierProfile from "../models/supplierProfile.js";
import { sendText, sendButtons } from "./metaSender.js";

// ─────────────────────────────────────────────────────────────────────────────
// QUANTITY PARSING - spec numbers vs quantity numbers
// ─────────────────────────────────────────────────────────────────────────────
// Rule: measurement/spec suffixes (mm, kg, kW, V, mm2 etc.) stay attached to
// the product name. Quantity is the LAST standalone number or "x N unit" pattern.
//
// Examples:
//   "copper pipe 15mm, 5 lengths"               → product="copper pipe 15mm"             qty=5  unit="lengths"
//   "cement 50kg, 20 bags"                       → product="cement 50kg"                  qty=20 unit="bags"
//   "gate valve 20mm, 6"                         → product="gate valve 20mm"              qty=6  unit="units"
//   "10kw growatt inverter x2"                   → product="10kw growatt inverter"         qty=2  unit="units"
//   "16mm2 x4 core cu pvc swa cable 200m"        → product (full string)                  qty=1
//   "6mm2 solar cable red 100m"                  → product (full string)                  qty=1
//   "6mm2 solar cable red x5 reels"              → product="6mm2 solar cable red"         qty=5  unit="reels"

const SPEC_UNITS = new Set([
  "mm","cm","m","km","ml","l","kg","g","mg","lb","lbs","oz","ft","in","inch",
  "psi","bar","kpa","mpa","kw","kva","hp","v","volt","amp","amps","watt","w","a","ah",
  "litre","litres","liter","liters","tonne","tonnes","ton","tons","metre","metres",
  "meter","meters","gallon","gallons","sqm","sqft","kwh","mhz","ghz","mb","gb","tb",
  "rpm","nm","khz","mw","gw","x10m","x20m","x6m","x3m","x1m","x2m",
  // ── Electrical cable spec units ─────────────────────────────────────────────
  "mm2","kv","mva","core"
]);

const QTY_UNITS = new Set([
  "bags","bag","lengths","length","rolls","roll","reels","reel","sheets","sheet",
  "pieces","pcs","pc","piece","units","unit","boxes","box","sets","set",
  "pairs","pair","coils","coil","drums","drum","metres","meters",
  "litres","liters","tins","tin","bottles","bottle","cans","can",
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
  // EXCEPTION: "x4 core" is part of a cable spec (e.g. "16mm2 x4 core cu pvc swa cable")
  const xMatch = line.match(/^(.+?)\s+x\s*(\d+(?:\.\d+)?)\s*([a-zA-Z]*)$/i);
  if (xMatch) {
    const prod = xMatch[1].trim();
    const qty  = Number(xMatch[2]);
    const unit = xMatch[3].toLowerCase() || "units";
    // "core" after a number = cable spec, not qty
    if (unit === "core") {
      return { product: line, quantity: 1, unitLabel: "units" };
    }
    if (!SPEC_UNITS.has(unit) && qty > 0) {
      return { product: prod, quantity: qty, unitLabel: unit || "units" };
    }
    return { product: line, quantity: 1, unitLabel: "units" };
  }

  // Case 2: trailing "N unit" - qty only if unit is a known QTY unit
  const trailMatch = line.match(/^(.+?),?\s+(\d+(?:\.\d+)?)\s+([a-zA-Z]+)$/i);
  if (trailMatch) {
    const prod = trailMatch[1].replace(/,\s*$/, "").trim();
    const qty  = Number(trailMatch[2]);
    const unit = trailMatch[3].toLowerCase();
    if (QTY_UNITS.has(unit) && qty > 0) {
      return { product: prod, quantity: qty, unitLabel: unit };
    }
  }

  // Case 3: trailing bare number - only if product doesn't end with a measurement spec
  const bareNumMatch = line.match(/^(.+?),?\s+(\d+(?:\.\d+)?)$/);
  if (bareNumMatch) {
    const prod = bareNumMatch[1].replace(/,\s*$/, "").trim();
    const qty  = Number(bareNumMatch[2]);
    const endsWithSpec = /\d+\s*(mm|cm|kg|ml|l|m|ft|in|psi|bar|v|w|a|kw|kva|hp|ah|litre|liter|mm2|core|kv)$/i.test(prod);
    if (!endsWithSpec && qty > 0 && qty < 100000) {
      return { product: prod, quantity: qty, unitLabel: "units" };
    }
  }

  // Case 4: no quantity found - whole line is product, qty=1
  return { product: line.replace(/,\s*$/, "").trim(), quantity: 1, unitLabel: "units" };
}

/**
 * Parse a full item list text into structured items.
 * Handles newline-separated and comma-separated lists.
 */
export function parseItemListWithQty(text = "") {
  const raw = String(text || "").trim();
  if (!raw) return [];

  let lines = raw.split(/\n+/).map(l => l.trim()).filter(Boolean);
  if (lines.length === 1) {
    // Single line - split on commas only where next char is not a digit
    // This prevents splitting cable specs like "16mm2 x4 core cu pvc swa cable, 100m"
    lines = raw.split(/,\s*(?=[^\d])/).map(l => l.trim()).filter(Boolean);
  }

  return lines
    .map(parseBuyerRequestLineWithQty)
    .filter(item => item.product && item.product.length > 1);
}

// ─────────────────────────────────────────────────────────────────────────────
// AUTO-CLOSE EXPIRED REQUESTS
// ─────────────────────────────────────────────────────────────────────────────

export async function autoCloseExpiredRequests({
  timeoutMinutes = 60,   // raised from 15 → 60 min so sellers have time to respond
  notifyBuyer    = true
} = {}) {
  const cutoff = new Date(Date.now() - timeoutMinutes * 60 * 1000);
  // Grace period: if a request was notified recently, keep it open for at least
  // this long AFTER the last notification, so sellers can still respond.
  const notifiedGraceMs = 30 * 60 * 1000; // 30 minutes after last notification

  const expiredRequests = await BuyerRequest.find({
    status:    "open",
    createdAt: { $lt: cutoff }
  }).lean();

  // Filter out requests that were notified recently - give sellers their grace period
  const now = Date.now();
  const filteredRequests = expiredRequests.filter(req => {
    const lastNotified = req.lastNotifiedAt ? new Date(req.lastNotifiedAt).getTime() : 0;
    if (lastNotified && (now - lastNotified) < notifiedGraceMs) {
      console.log(`[AUTO-CLOSE] Skipping recently-notified request ${req._id} (notified ${Math.round((now - lastNotified) / 60000)}m ago)`);
      return false;
    }
    return true;
  });

  if (!filteredRequests.length) return 0;

  console.log(`[AUTO-CLOSE] Processing ${filteredRequests.length} expired request(s)`);

  for (const req of filteredRequests) {
    try {
      const updated = await BuyerRequest.findOneAndUpdate(
        { _id: req._id, status: "open" },
        { $set: { status: "closed" } },
        { new: false }
      );
      if (!updated) continue;

      if (!notifyBuyer || !req.buyerPhone) continue;

      const validQuotes = (req.responses || []).filter(
        r => r.mode !== "unavailable" && (r.items?.length || r.message)
      );

      if (validQuotes.length > 0) {
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
            { id: "sup_request_sellers",               title: "⚡ New Request"        }
          ]
        });
      } else {
        await sendButtons(req.buyerPhone, {
          text:
            `⏱ *No quotes received* (${_buildRef(req)})\n\n` +
            `No sellers responded within ${timeoutMinutes} minutes.\n\n` +
            `This can happen when items are specialised or no sellers in your area stock them right now.\n\n` +
            `Your request is saved - new matching sellers will be notified automatically.`,
          buttons: [
            { id: "sup_request_sellers", title: "⚡ New Request"   },
            { id: "find_supplier",       title: "🔍 Browse & Shop" }
          ]
        });
      }
    } catch (err) {
      console.error(`[AUTO-CLOSE] Error on request ${req._id}:`, err.message);
    }
  }

  return filteredRequests.length;
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

export async function trackSupplierResponseSpeed(supplierPhone, requestCreatedAt) {
  try {
    if (!supplierPhone || !requestCreatedAt) return;

    const now          = new Date();
    const requestTime  = new Date(requestCreatedAt);
    const minutesTaken = Math.max(0, Math.round((now - requestTime) / 60000));

    const supplier = await SupplierProfile.findOne({ phone: supplierPhone }).lean();
    if (!supplier) return;

    const prevCount      = supplier.responseCount      || 0;
    const prevAvg        = supplier.avgResponseMinutes || 0;
    const effectiveCount = Math.min(prevCount, 99);

    const newAvg = effectiveCount === 0
      ? minutesTaken
      : Math.round(((prevAvg * effectiveCount) + minutesTaken) / (effectiveCount + 1));

    await SupplierProfile.findOneAndUpdate(
      { phone: supplierPhone },
      {
        $set: { lastRespondedAt: now, avgResponseMinutes: newAvg },
        $inc: { responseCount: 1 }
      }
    );

    console.log(`[RESP SPEED] ${supplierPhone}: ${minutesTaken} min | new avg: ${newAvg} min | count: ${prevCount + 1}`);
  } catch (err) {
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

  const statusIcon  = request.status === "open"   ? "🟢" : "🔴";
  const statusLabel = request.status === "open"   ? "Open - waiting for quotes"
    : request.status === "closed"                 ? "Closed"
    : "Expired";

  const validQuotes  = (request.responses || []).filter(r => r.mode !== "unavailable" && (r.items?.length || r.message));
  const unavailCount = (request.responses || []).filter(r => r.mode === "unavailable").length;
  const ref          = _buildRef(request);
  const notesLine    = request.notes ? `📝 Notes: ${request.notes}` : "";

  const deliveryLine = (() => {
    const _isSvc = request.isServiceRequest || (request.items || []).some(item => {
      const n = (item.product || item.service || "").toLowerCase();
      return ["install","repair","fix","service","replace","plumb","geyser","electric",
              "paint","build","clean","weld","garden","tutor","photograph","cater","design","print"
      ].some(k => n.includes(k));
    });
    if (_isSvc) return request.serviceAddress ? `📍 Service address: ${request.serviceAddress}` : "📍 Client will share address";
    return request.deliveryRequired ? "🚚 Delivery needed" : "🏠 Collection / flexible";
  })();

  return [
    `📋 *Request ${ref}*`, "",
    items, "",
    locationLine,
    deliveryLine,
    notesLine,
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

    if (typeof q.totalAmount === "number" && !isNaN(q.totalAmount)) lines.push(`  💵 *Total: $${Number(q.totalAmount).toFixed(2)}*`);
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
// INTERNAL: build a short human-readable reference like REQ-A1B2
// ─────────────────────────────────────────────────────────────────────────────
function _buildRef(request) {
  if (!request?._id) return "REQ-????";
  return `REQ-${String(request._id).slice(-4).toUpperCase()}`;
}