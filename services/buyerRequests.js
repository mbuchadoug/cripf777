// services/buyerRequests.js
// ─── Buyer Request Service ────────────────────────────────────────────────────
//
// Handles:
//   - Auto-close / timeout of open requests
//   - Buyer request history queries
//   - Supplier response speed tracking
//   - Quote comparison formatting
//   - Request summary formatting
//
// Usage: import named exports into chatbotEngine.js and your cron runner.
//
// IMPORTANT: This file uses the buyerRequest2 model filename.
// If yours is at models/buyerRequest.js, update the import path below.

import BuyerRequest from "../models/buyerRequest2.js";
import SupplierProfile from "../models/supplierProfile.js";
import { sendText, sendButtons } from "./metaSender.js";

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
            ? ` — $${Number(q.totalAmount).toFixed(2)}`
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
        // Zero quotes - encourage retry
        await sendButtons(req.buyerPhone, {
          text:
            `⏱ *Request Expired*\n\n` +
            `No sellers responded to your request within ${timeoutMinutes} minutes.\n\n` +
            `This can happen when no sellers in your area stock that item.\n` +
            `Try browsing the marketplace or submit a new request with a broader description.`,
          buttons: [
            { id: "sup_request_sellers", title: "⚡ Try Again" },
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
    // Non-critical — never throw
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
  const statusLabel = request.status === "open"  ? "Open — waiting for quotes"
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
    request.deliveryRequired ? "🚚 Delivery needed" : "🏠 Collection / flexible",
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

    lines.push(`🏪 *${qi + 1}. ${name}*`);

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
// INTERNAL: build a short human-readable reference like REQ-A1B2
// (mirrors the same logic in chatbotEngine.js — keep in sync)
// ─────────────────────────────────────────────────────────────────────────────
function _buildRef(request) {
  if (!request?._id) return "REQ-????";
  const hex = String(request._id).slice(-4).toUpperCase();
  return `REQ-${hex}`;
}