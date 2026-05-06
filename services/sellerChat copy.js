// services/sellerChat.js
// ─── ZimQuote Seller Chatbot — Quote, Order, Booking, Delivery ───────────────
//
// Full buyer interaction flow when a buyer taps a seller's ZimQuote bot link.
//
// Covers:
//   1. Seller profile display — name, location, products/services, ratings
//   2. Instant quote (seller has prices) — select items, auto PDF, 48h validity
//   3. RFQ flow (no prices) — structured list to seller, seller replies, PDF sent
//   4. Product order — confirm items, qty, delivery/collection choice, location
//   5. Service booking — date/time, location, job description, confirmation
//   6. Delivery options — deliver to buyer, collection from seller, both
//   7. Location capture — buyer suburb/address for delivery quotes
//   8. Repeat order — returning buyer one-tap repeat
//   9. Stock check — buyer asks if specific item is available
//  10. Complaint / after-sales — escalation flow
//
// Wire in chatbotEngine.js handleSchoolSearchActions:
//   if (a.startsWith("sc_")) return handleSellerChatAction({ from, action: a, biz, saveBiz });
// Wire in handleSchoolAdminStates:
//   if (state?.startsWith("sc_")) return handleSellerChatState({ state, from, text, biz, saveBiz });
// Wire in handleZqDeepLink for ZQ:SUPPLIER:id:action payloads.

import SupplierProfile from "../models/supplierProfile.js";
import SchoolLead      from "../models/schoolLead.js";
import { sendText, sendButtons, sendList, sendDocument } from "./metaSender.js";
import { notifySupplierNewOrder } from "./supplierOrders.js";

const BOT_NUMBER = (process.env.WHATSAPP_BOT_NUMBER || "263771143904").replace(/\D/g, "");

// ─────────────────────────────────────────────────────────────────────────────
// MAIN SELLER PROFILE + MENU
// Called when buyer taps a seller's ZimQuote bot link
// ─────────────────────────────────────────────────────────────────────────────
export async function showSellerMenu(from, supplierId, biz, saveBiz, { source = "direct", parentName = "" } = {}) {
  const seller = await SupplierProfile.findById(supplierId).lean();
  if (!seller) return sendText(from, "❌ Seller profile not found. Please try again.");

  const isService  = seller.serviceType === "service";
  const delivery   = seller.delivery?.available;
  const hasPrices  = (Array.isArray(seller.prices) && seller.prices.length > 0) ||
                     (Array.isArray(seller.rates)  && seller.rates.length  > 0);
  const rating     = (seller.reviewCount || 0) > 0
    ? `⭐ ${Number(seller.rating).toFixed(1)} (${seller.reviewCount} reviews)` : "";
  const productSample = isService
    ? (seller.rates  || []).slice(0, 3).map(r => `• ${r.service}${r.rate ? " — " + r.rate : ""}`).join("\n")
    : (seller.prices || []).slice(0, 5).map(p => `• ${p.product}${p.amount ? " — $" + Number(p.amount).toFixed(2) : " — price on request"}`).join("\n");

  // Store seller context in session
  if (biz) {
    biz.sessionData = {
      ...(biz.sessionData || {}),
      scSellerId: supplierId,
      scIsService: isService,
      scHasPrices: hasPrices,
      scSource: source,
      scBuyerName: parentName
    };
    await saveBiz(biz);
  }

  // Check if returning buyer (has previous quote/order)
  const hasHistory = biz?.sessionData?.scLastOrder;
  const repeatBtn  = hasHistory
    ? [{ id: `sc_repeat_${supplierId}`, title: "🔄 Repeat last order" }] : [];

  await sendText(from,
`${isService ? "🔧" : "🏪"} *${seller.businessName}*${seller.verified ? " ✅" : ""}
📍 ${seller.area ? seller.area + ", " : ""}${seller.city}
${rating}

${isService ? "Services offered:" : "Products available:"}
${productSample || "Contact seller for full catalogue"}

${delivery ? "🚚 Delivery available" : "🏠 Collection only"}${seller.delivery?.areas?.length ? " — " + seller.delivery.areas.slice(0,3).join(", ") : ""}`
  );

 if (isService) {
    return sendList(from, "What would you like to do?", [
      { id: `sc_quote_${supplierId}`,   title: hasPrices ? "💵 Get instant quote" : "💵 Request a quote" },
      { id: `sc_book_${supplierId}`,    title: "📅 Book a service" },
      ...repeatBtn,
      { id: `sc_contact_${supplierId}`, title: "📞 Contact seller" },
      { id: `sc_review_${supplierId}`,  title: "⭐ Leave a review" }
    ]);
  } else {
    return sendList(from, "What would you like to do?", [
      { id: `sc_quote_${supplierId}`,   title: hasPrices ? "💵 Get instant quote" : "💵 Request a quote" },
      { id: `sc_order_${supplierId}`,   title: "🛒 Place an order" },
      ...repeatBtn,
      { id: `sc_contact_${supplierId}`, title: "📞 Contact seller" },
      { id: `sc_review_${supplierId}`,  title: "⭐ Leave a review" }
    ]);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ACTION ROUTER
// ─────────────────────────────────────────────────────────────────────────────
export async function handleSellerChatAction({ from, action: a, biz, saveBiz }) {
  const parts      = a.split("_");
  const supplierId = parts[parts.length - 1];
  const topic      = parts.slice(1, -1).join("_");

  if (!supplierId || supplierId.length !== 24) return false;

  switch (topic) {
    case "quote":           return _scQuote(from, supplierId, biz, saveBiz);
    case "quote_item":      return _scQuoteAddItem(from, supplierId, biz, saveBiz);
    case "quote_done":      return _scQuoteDone(from, supplierId, biz, saveBiz);
    case "quote_clear":     return _scQuoteClear(from, supplierId, biz, saveBiz);
    case "order":           return _scOrder(from, supplierId, biz, saveBiz);
    case "order_deliver":   return _scOrderDeliver(from, supplierId, biz, saveBiz);
    case "order_collect":   return _scOrderCollect(from, supplierId, biz, saveBiz);
    case "order_confirm":   return _scOrderConfirm(from, supplierId, biz, saveBiz);
    case "book":            return _scBook(from, supplierId, biz, saveBiz);
    case "book_confirm":    return _scBookConfirm(from, supplierId, biz, saveBiz);
    case "stock":           return _scStock(from, supplierId, biz, saveBiz);
    case "repeat":          return _scRepeat(from, supplierId, biz, saveBiz);
    case "contact":         return _scContact(from, supplierId);
    case "review":          return _scReview(from, supplierId, biz, saveBiz);
    case "back":            return showSellerMenu(from, supplierId, biz, saveBiz);
    default:                return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// STATE HANDLER — handles typed text in seller chat states
// ─────────────────────────────────────────────────────────────────────────────
export async function handleSellerChatState({ state, from, text, biz, saveBiz }) {
  if (!state?.startsWith("sc_")) return false;

  const supplierId = biz?.sessionData?.scSellerId;
  if (!supplierId) return false;

  const raw = (text || "").trim();
  if (raw.toLowerCase() === "cancel") {
    if (biz) { biz.sessionState = "ready"; await saveBiz(biz); }
    return showSellerMenu(from, supplierId, biz, saveBiz);
  }

  // ── Quote: buyer typed item list ───────────────────────────────────────────
  if (state === "sc_awaiting_items") {
    return _scProcessItemList(from, supplierId, raw, biz, saveBiz);
  }

  // ── Order: buyer typed delivery address ───────────────────────────────────
  if (state === "sc_awaiting_address") {
    return _scProcessAddress(from, supplierId, raw, biz, saveBiz);
  }

  // ── Booking: buyer typed preferred date/time ──────────────────────────────
  if (state === "sc_awaiting_booking_datetime") {
    return _scProcessBookingDateTime(from, supplierId, raw, biz, saveBiz);
  }

  // ── Booking: buyer typed job description ──────────────────────────────────
  if (state === "sc_awaiting_job_desc") {
    return _scProcessJobDescription(from, supplierId, raw, biz, saveBiz);
  }

  // ── Booking: buyer typed location for service ─────────────────────────────
  if (state === "sc_awaiting_service_location") {
    return _scProcessServiceLocation(from, supplierId, raw, biz, saveBiz);
  }

  // ── Seller pricing reply (unpriced RFQ) ───────────────────────────────────
  if (state === "sc_seller_awaiting_prices") {
    return _scProcessSellerPriceReply(from, supplierId, raw, biz, saveBiz);
  }

  // ── Stock check: buyer typed item name ────────────────────────────────────
  if (state === "sc_awaiting_stock_query") {
    return _scProcessStockQuery(from, supplierId, raw, biz, saveBiz);
  }

  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// QUOTE FLOW
// ─────────────────────────────────────────────────────────────────────────────
async function _scQuote(from, supplierId, biz, saveBiz) {
  const seller    = await SupplierProfile.findById(supplierId).lean();
  if (!seller) return false;
  const isService = seller.serviceType === "service";
  const hasPrices = isService
    ? (Array.isArray(seller.rates) && seller.rates.length > 0)
    : (Array.isArray(seller.prices) && seller.prices.length > 0);

  if (hasPrices) {
    // Show full catalogue for buyer to select from — chunked for large lists
    const allItems = isService ? seller.rates : seller.prices;
    const total    = allItems.length;
    const CHUNK    = 30; // ~30 items per message stays safely under 4096 chars

    if (biz) {
      biz.sessionState = "sc_awaiting_items";
      biz.sessionData  = { ...(biz.sessionData || {}), scSellerId: supplierId, scQuoteItems: [] };
      await saveBiz(biz);
    }

    // Send all items across as many messages as needed
    for (let i = 0; i < total; i += CHUNK) {
      const chunk    = allItems.slice(i, i + CHUNK);
      const isFirst  = i === 0;
      const isLast   = i + CHUNK >= total;

      const lines = chunk.map((item, j) => {
        const idx   = i + j + 1;
        const name  = isService ? item.service : item.product;
        const price = isService
          ? (item.rate || "rate on request")
          : `$${Number(item.amount).toFixed(2)}/${item.unit || "each"}`;
        return `${idx}. ${name} — ${price}`;
      }).join("\n");

      if (isFirst) {
        await sendText(from,
`💵 *${seller.businessName} — ${isService ? "Services" : "Products & prices"} (${total} item${total === 1 ? "" : "s"})*

${lines}${isLast ? "" : "\n_(list continues...)_"}`
        );
      } else {
        await sendText(from, `${lines}${isLast ? "" : "\n_(list continues...)_"}`);
      }
    }

    // Send instructions as a final separate message after the list
    return sendText(from,
`*To get your quote:*
Type item numbers and quantities, e.g:
_1×50, 3×10, 5×2_

Or type item names: _"20mm pipe 30 metres, ball valve 10"_

Type *done* when finished, or *cancel* to go back.`
    );
  } else {
    // No prices — collect structured list, send to seller
    if (biz) {
      biz.sessionState = "sc_awaiting_items";
      biz.sessionData  = { ...(biz.sessionData || {}), scSellerId: supplierId, scQuoteItems: [], scRFQ: true };
      await saveBiz(biz);
    }

    const productHint = isService
      ? "e.g. _geyser installation, electrical rewiring 3-bed house_"
      : "e.g. _20mm PVC pipe 30m, ball valve 15mm ×10, 110mm drain pipe 5m_";

    return sendText(from,
`💵 *Quote request — ${seller.businessName}*

List everything you need. Be as specific as possible — sizes, quantities, brands.

${productHint}

Type each item on a new line or separate with commas.
Type *done* when finished, or *cancel* to go back.`
    );
  }
}

async function _scProcessItemList(from, supplierId, raw, biz, saveBiz) {
  const seller = await SupplierProfile.findById(supplierId).lean();
  if (!seller) return false;

  const isService = seller.serviceType === "service";
  const isRFQ     = biz?.sessionData?.scRFQ;

  if (raw.toLowerCase() === "done") {
    return _scQuoteDone(from, supplierId, biz, saveBiz);
  }

  // Parse items — try numbered format first (1×50, 2×10), then free text
  const existingItems = biz?.sessionData?.scQuoteItems || [];
  const newItems = _parseItemInput(raw, isService ? seller.rates : seller.prices, isService);
  const allItems  = [...existingItems, ...newItems];

  if (biz) {
    biz.sessionData = { ...(biz.sessionData || {}), scQuoteItems: allItems };
    await saveBiz(biz);
  }

  if (!isRFQ && (seller.prices || seller.rates || []).length > 0) {
    // Calculate known prices
    const priced   = [];
    const unpriced = [];
    const priceMap = {};
    const items    = isService ? seller.rates : seller.prices;
    for (const item of (items || [])) {
      const key = (isService ? item.service : item.product).toLowerCase();
      priceMap[key] = isService ? item.rate : item.amount;
    }
    for (const item of allItems) {
      const key   = item.name.toLowerCase();
      const price = priceMap[key] || null;
      if (price) priced.push({ ...item, price });
      else       unpriced.push(item);
    }

    const summary = allItems.map(it => `• ${it.name} × ${it.qty}`).join("\n");
    return sendButtons(from, {
      text:
`🛒 *Items in your quote:*
${summary}

Type more items to add, or tap *Get Quote* to see pricing.`,
      buttons: [
        { id: `sc_quote_done_${supplierId}`, title: "✅ Get Quote" },
        { id: `sc_quote_clear_${supplierId}`, title: "🗑️ Start Over" }
      ]
    });
  }

  // Just acknowledge and continue
  const summary = allItems.map(it => `• ${it.name} × ${it.qty}`).join("\n");
  return sendButtons(from, {
    text:
`🛒 *Items added:*
${summary}

Add more items, or tap *Send Request* to submit.`,
    buttons: [
      { id: `sc_quote_done_${supplierId}`,  title: "📤 Send Request" },
      { id: `sc_quote_clear_${supplierId}`, title: "🗑️ Start Over" }
    ]
  });
}

async function _scQuoteDone(from, supplierId, biz, saveBiz) {
  const seller = await SupplierProfile.findById(supplierId).lean();
  if (!seller) return false;

  const isService = seller.serviceType === "service";
  const items     = biz?.sessionData?.scQuoteItems || [];
  const isRFQ     = biz?.sessionData?.scRFQ;
  const buyerName = biz?.sessionData?.scBuyerName || "";

  if (!items.length) {
    return sendText(from, "❌ No items added. Please list the items you need first.");
  }

  if (isRFQ) {
    // Send structured request to seller
    const itemList = items.map((it, i) => `${i+1}. ${it.name} × ${it.qty}`).join("\n");
    const refNum   = "RFQ-" + Date.now().toString(36).toUpperCase().slice(-6);

    // Notify seller via Meta template
    const notifMsg =
`📋 New quote request on ZimQuote.

Reference: ${refNum}
Buyer: ${buyerName || from.replace(/\D+/g, "")}

Items requested:
${itemList}

Reply with prices to auto-generate and send the PDF quote.
Format: 1=price, 2=price, 3=price`;

    // Store pending RFQ so we can match seller's price reply
    if (biz) {
      biz.sessionState = "ready";
      biz.sessionData  = {
        ...(biz.sessionData || {}),
        scLastRFQ: { refNum, supplierId, buyerPhone: from, items, timestamp: Date.now() }
      };
      await saveBiz(biz);
    }

    // Notify seller (use existing sendText — template preferred if available)
    try {
      const { sendText: _st } = await import("./metaSender.js");
      await _st(seller.phone, notifMsg);
    } catch (e) { /* ignore */ }

     // Track smart link conversion (non-blocking)
   if (biz?.sessionData?.scSource && biz.sessionData.scSellerId) {
     const { trackLinkEvent } = await import("./supplierSmartLink.js");
     trackLinkEvent(biz.sessionData.scSellerId, {
       source: biz.sessionData.scSource,
       isConversion: true
     }).catch(() => {});
   }
    return sendButtons(from, {
      text:
`✅ *Quote request sent to ${seller.businessName}*

Reference: *${refNum}*
Items: ${items.length} item${items.length > 1 ? "s" : ""}

The seller will price your request and you'll receive a PDF quote on WhatsApp.

📞 ${seller.contactPhone || seller.phone}`,
      buttons: [
        { id: `sc_back_${supplierId}`,    title: "⬅ Back to Seller" },
        { id: `sc_contact_${supplierId}`, title: "📞 Contact seller" }
      ]
    });
  }

  // Priced seller — calculate total and generate PDF
  const priceItems = isService ? seller.rates : seller.prices;
  const priceMap   = {};
  for (const item of (priceItems || [])) {
    const key = (isService ? item.service : item.product).toLowerCase().trim();
    priceMap[key] = isService ? (parseFloat(item.rate) || 0) : (parseFloat(item.amount) || 0);
  }

  let total    = 0;
  let hasPrice = false;
  const lineItems = items.map(it => {
    const price = priceMap[it.name.toLowerCase().trim()] || it.price || 0;
    const line  = price * (it.qty || 1);
    total += line;
    if (price > 0) hasPrice = true;
    return { name: it.name, qty: it.qty || 1, unitPrice: price, lineTotal: line };
  });

  const refNum   = "QT-" + Date.now().toString(36).toUpperCase().slice(-6);
  const expiry   = new Date(Date.now() + 48 * 3600 * 1000).toLocaleDateString("en-GB", { day:"numeric", month:"short", year:"numeric" });
  const itemRows = lineItems.map(l =>
    `${l.name} × ${l.qty}${l.unitPrice > 0 ? ` @ $${l.unitPrice.toFixed(2)} = $${l.lineTotal.toFixed(2)}` : " — price on request"}`
  ).join("\n");

  // Save pending order state
  if (biz) {
    biz.sessionData = {
      ...(biz.sessionData || {}),
      scPendingQuote: { refNum, supplierId, items: lineItems, total, expiry }
    };
    await saveBiz(biz);
  }

  // Notify seller
  const sellerNotif =
`📋 New quote generated on ZimQuote.

Reference: ${refNum}
Buyer: ${buyerName || from.replace(/\D+/g,"")}
Total: $${total.toFixed(2)}

Items:
${itemRows}

Valid until: ${expiry}`;
  try {
    const { sendText: _st } = await import("./metaSender.js");
    await _st(seller.phone, sellerNotif);
  } catch (e) { /* ignore */ }

  //   // Track smart link conversion (non-blocking)
   if (biz?.sessionData?.scSource && biz.sessionData.scSellerId) {
     const { trackLinkEvent } = await import("./supplierSmartLink.js");
     trackLinkEvent(biz.sessionData.scSellerId, {
       source: biz.sessionData.scSource,
       isConversion: true
     }).catch(() => {});
   }


  // Try to generate and send PDF
  let pdfSent = false;
  try {
    const { generateQuotePDF } = await import("./quotePdfGenerator.js");
    const pdf = await generateQuotePDF({
      refNum, sellerName: seller.businessName, sellerPhone: seller.phone,
      sellerCity: seller.city, buyerPhone: from, buyerName,
      items: lineItems, total, expiry
    });
    if (pdf?.url) {
      const { sendDocument } = await import("./metaSender.js");
      await sendDocument(from, { link: pdf.url, filename: `Quote_${refNum}.pdf` });
      pdfSent = true;
    }
  } catch (e) { /* PDF generation optional */ }

  return sendButtons(from, {
    text:
`✅ *Quote ${refNum}*
${seller.businessName}

${itemRows}
${"─".repeat(28)}
*Total: $${total.toFixed(2)} USD*

Valid until: ${expiry}
${pdfSent ? "\nPDF sent above — tap to open." : ""}`,
    buttons: [
      { id: `sc_order_${supplierId}`,   title: "🛒 Place order" },
      { id: `sc_contact_${supplierId}`, title: "📞 Contact seller" },
      { id: `sc_back_${supplierId}`,    title: "⬅ Back to Seller" }
    ]
  });
}

async function _scQuoteClear(from, supplierId, biz, saveBiz) {
  if (biz) {
    biz.sessionData = { ...(biz.sessionData || {}), scQuoteItems: [], scRFQ: false };
    await saveBiz(biz);
  }
  return _scQuote(from, supplierId, biz, saveBiz);
}

// ─────────────────────────────────────────────────────────────────────────────
// ORDER FLOW
// ─────────────────────────────────────────────────────────────────────────────
async function _scOrder(from, supplierId, biz, saveBiz) {
  const seller   = await SupplierProfile.findById(supplierId).lean();
  if (!seller) return false;
  const delivery = seller.delivery?.available;
  const collect  = seller.delivery?.collectionAvailable !== false;

  if (delivery && collect) {
    return sendButtons(from, {
      text:
`🛒 *Place an order — ${seller.businessName}*

How would you like to receive your order?`,
      buttons: [
        { id: `sc_order_deliver_${supplierId}`,  title: "🚚 Deliver to me" },
        { id: `sc_order_collect_${supplierId}`,  title: "🏠 I'll collect" },
        { id: `sc_back_${supplierId}`,            title: "⬅ Back" }
      ]
    });
  } else if (delivery) {
    return _scOrderDeliver(from, supplierId, biz, saveBiz);
  } else {
    return _scOrderCollect(from, supplierId, biz, saveBiz);
  }
}

async function _scOrderDeliver(from, supplierId, biz, saveBiz) {
  const seller = await SupplierProfile.findById(supplierId).lean();
  if (!seller) return false;

  const areas = (seller.delivery?.areas || []).slice(0, 6);
  const areaList = areas.length ? `\nDelivery areas: ${areas.join(", ")}` : "";
  const minOrder = seller.delivery?.minimumOrder ? `\nMinimum order: $${seller.delivery.minimumOrder}` : "";
  const fee      = seller.delivery?.fee ? `\nDelivery fee: $${seller.delivery.fee}` : "";

  if (biz) {
    biz.sessionState = "sc_awaiting_address";
    biz.sessionData  = { ...(biz.sessionData || {}), scDelivery: true };
    await saveBiz(biz);
  }

  return sendText(from,
`🚚 *Delivery — ${seller.businessName}*
${areaList}${minOrder}${fee}

Please type your delivery address or suburb so we can confirm delivery is available to you.

_e.g. "Highfield, Harare" or "15 Samora Machel Ave, Harare"_
Type *cancel* to go back.`
  );
}

async function _scProcessAddress(from, supplierId, raw, biz, saveBiz) {
  const seller = await SupplierProfile.findById(supplierId).lean();
  if (!seller) return false;

  if (biz) {
    biz.sessionState = "ready";
    biz.sessionData  = { ...(biz.sessionData || {}), scDeliveryAddress: raw };
    await saveBiz(biz);
  }

  const pendingQuote = biz?.sessionData?.scPendingQuote;

  return sendButtons(from, {
    text:
`✅ *Order confirmed*

${seller.businessName}
Delivery to: *${raw}*
${pendingQuote ? `Quote ref: *${pendingQuote.refNum}*\nTotal: *$${pendingQuote.total?.toFixed(2)}*` : ""}

The seller has been notified and will contact you to confirm delivery schedule and payment.

📞 ${seller.contactPhone || seller.phone}`,
    buttons: [
      { id: `sc_contact_${supplierId}`, title: "📞 Contact seller" },
      { id: `sc_back_${supplierId}`,    title: "⬅ Back to Seller" }
    ]
  });
}

async function _scOrderCollect(from, supplierId, biz, saveBiz) {
  const seller = await SupplierProfile.findById(supplierId).lean();
  if (!seller) return false;

  const pendingQuote = biz?.sessionData?.scPendingQuote;
  if (biz) { biz.sessionState = "ready"; await saveBiz(biz); }

  // Notify seller of collection order
  try {
    const { sendText: _st } = await import("./metaSender.js");
    await _st(seller.phone,
`📦 New collection order on ZimQuote.

Buyer: ${from.replace(/\D+/g,"")}
${pendingQuote ? `Quote: ${pendingQuote.refNum}\nTotal: $${pendingQuote.total?.toFixed(2)}` : ""}

Contact buyer to confirm collection time.`
    );
  } catch (e) { /* ignore */ }

  return sendButtons(from, {
    text:
`✅ *Collection order confirmed*

${seller.businessName}
${pendingQuote ? `Quote: *${pendingQuote.refNum}* · Total: *$${pendingQuote.total?.toFixed(2)}*\n` : ""}
📍 Collect from:
${seller.address || seller.area + ", " + seller.city}

📞 ${seller.contactPhone || seller.phone}

Contact the seller to arrange collection time and payment.`,
    buttons: [
      { id: `sc_contact_${supplierId}`, title: "📞 Contact seller" },
      { id: `sc_back_${supplierId}`,    title: "⬅ Back to Seller" }
    ]
  });
}

async function _scOrderConfirm(from, supplierId, biz, saveBiz) {
  return _scOrder(from, supplierId, biz, saveBiz);
}

// ─────────────────────────────────────────────────────────────────────────────
// SERVICE BOOKING FLOW
// ─────────────────────────────────────────────────────────────────────────────
async function _scBook(from, supplierId, biz, saveBiz) {
  const seller = await SupplierProfile.findById(supplierId).lean();
  if (!seller) return false;

  if (biz) {
    biz.sessionState = "sc_awaiting_service_location";
    biz.sessionData  = { ...(biz.sessionData || {}), scSellerId: supplierId };
    await saveBiz(biz);
  }

  return sendText(from,
`📅 *Book a service — ${seller.businessName}*

Where do you need the service?

_Type your address or suburb, e.g. "Borrowdale, Harare" or "15 Jason Moyo Ave Avondale"_
Type *cancel* to go back.`
  );
}

async function _scProcessServiceLocation(from, supplierId, raw, biz, saveBiz) {
  if (biz) {
    biz.sessionState = "sc_awaiting_job_desc";
    biz.sessionData  = { ...(biz.sessionData || {}), scServiceLocation: raw };
    await saveBiz(biz);
  }
  return sendText(from,
`📋 *Service booking — describe the job*

Location: _${raw}_

Now describe what needs to be done. Be as specific as possible.

_e.g. "Fix leaking geyser, bathroom, first floor" or "Full house rewiring, 3-bedroom"_
Type *cancel* to go back.`
  );
}

async function _scProcessJobDescription(from, supplierId, raw, biz, saveBiz) {
  if (biz) {
    biz.sessionState = "sc_awaiting_booking_datetime";
    biz.sessionData  = { ...(biz.sessionData || {}), scJobDesc: raw };
    await saveBiz(biz);
  }
  return sendText(from,
`📅 *Preferred date and time?*

Job: _${raw}_

When would you like this done?

_e.g. "Monday morning", "Any weekday after 2pm", "Urgent — today or tomorrow"_
Type *cancel* to go back.`
  );
}

async function _scProcessBookingDateTime(from, supplierId, raw, biz, saveBiz) {
  const seller    = await SupplierProfile.findById(supplierId).lean();
  if (!seller) return false;

  const location  = biz?.sessionData?.scServiceLocation || "not specified";
  const jobDesc   = biz?.sessionData?.scJobDesc || "not specified";
  const buyerName = biz?.sessionData?.scBuyerName || "";
  const refNum    = "BK-" + Date.now().toString(36).toUpperCase().slice(-6);

  if (biz) {
    biz.sessionState = "ready";
    await saveBiz(biz);
  }

  // Notify seller
  try {
    const { sendText: _st } = await import("./metaSender.js");
    await _st(seller.phone,
`📅 New service booking on ZimQuote.

Reference: ${refNum}
Buyer: ${buyerName || from.replace(/\D+/g,"")}
Location: ${location}
Job: ${jobDesc}
Preferred time: ${raw}

Contact buyer to confirm.`
    );
  } catch (e) { /* ignore */ }

  return sendButtons(from, {
    text:
`✅ *Booking request sent — ${refNum}*

${seller.businessName}
📍 Location: ${location}
🔧 Job: ${jobDesc}
📅 Preferred time: ${raw}

The seller will contact you to confirm the booking and quote.
📞 ${seller.contactPhone || seller.phone}`,
    buttons: [
      { id: `sc_contact_${supplierId}`, title: "📞 Contact seller" },
      { id: `sc_back_${supplierId}`,    title: "⬅ Back to Seller" }
    ]
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// STOCK CHECK
// ─────────────────────────────────────────────────────────────────────────────
async function _scStock(from, supplierId, biz, saveBiz) {
  const seller    = await SupplierProfile.findById(supplierId).lean();
  if (!seller) return false;
  const isService = seller.serviceType === "service";

  if (biz) {
    biz.sessionState = "sc_awaiting_stock_query";
    biz.sessionData  = { ...(biz.sessionData || {}), scSellerId: supplierId };
    await saveBiz(biz);
  }

  return sendText(from,
`🔍 *${isService ? "Check availability" : "Check stock"} — ${seller.businessName}*

What are you looking for?

_Type the item or service name, e.g. "20mm PVC pipe" or "geyser installation"_
Type *cancel* to go back.`
  );
}

async function _scProcessStockQuery(from, supplierId, raw, biz, saveBiz) {
  const seller    = await SupplierProfile.findById(supplierId).lean();
  if (!seller) return false;
  const isService = seller.serviceType === "service";

  // Check against known stock/items
  const items   = isService ? (seller.rates || []) : (seller.prices || []);
  const rawLow  = raw.toLowerCase();
  const matched = items.filter(item => {
    const name = (isService ? item.service : item.product).toLowerCase();
    return name.includes(rawLow) || rawLow.includes(name.slice(0, 6));
  });

  if (biz) { biz.sessionState = "ready"; await saveBiz(biz); }

  if (matched.length > 0) {
    const list = matched.slice(0, 5).map(item => {
      const name  = isService ? item.service : item.product;
      const price = isService ? (item.rate || "Rates on request") : `$${Number(item.amount).toFixed(2)}`;
      return `✅ ${name} — ${price}`;
    }).join("\n");

    return sendButtons(from, {
      text:
`🔍 *Stock check result*

${list}

${matched.length > 5 ? `...and ${matched.length - 5} more.` : ""}`,
      buttons: [
        { id: `sc_quote_${supplierId}`,  title: "💵 Get a quote" },
        { id: `sc_order_${supplierId}`,  title: "🛒 Place an order" },
        { id: `sc_back_${supplierId}`,   title: "⬅ Back" }
      ]
    });
  }

  // Not found — notify seller
  try {
    const { sendText: _st } = await import("./metaSender.js");
    await _st(seller.phone,
`🔍 Stock enquiry on ZimQuote.

Buyer asking about: "${raw}"
Buyer number: ${from.replace(/\D+/g,"")}

Please contact them if you have this available.`
    );
  } catch (e) { /* ignore */ }

  return sendButtons(from, {
    text:
`🔍 *"${raw}"* was not found in the current catalogue.

The seller has been notified of your enquiry and will contact you if available.
📞 ${seller.contactPhone || seller.phone}`,
    buttons: [
      { id: `sc_quote_${supplierId}`,   title: "💵 Request quote anyway" },
      { id: `sc_contact_${supplierId}`, title: "📞 Contact seller" },
      { id: `sc_back_${supplierId}`,    title: "⬅ Back" }
    ]
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// REPEAT ORDER
// ─────────────────────────────────────────────────────────────────────────────
async function _scRepeat(from, supplierId, biz, saveBiz) {
  const lastOrder = biz?.sessionData?.scLastOrder;
  if (!lastOrder) return _scOrder(from, supplierId, biz, saveBiz);

  const seller = await SupplierProfile.findById(supplierId).lean();
  if (!seller) return false;

  const itemSummary = (lastOrder.items || [])
    .map(it => `• ${it.name} × ${it.qty}`)
    .join("\n");

  return sendButtons(from, {
    text:
`🔄 *Repeat last order — ${seller.businessName}*

Last order (${lastOrder.refNum}):
${itemSummary}

Do you want to order the same again?`,
    buttons: [
      { id: `sc_order_confirm_${supplierId}`, title: "✅ Yes, same order" },
      { id: `sc_order_${supplierId}`,          title: "✏️ Modify order" },
      { id: `sc_back_${supplierId}`,            title: "⬅ Cancel" }
    ]
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// CONTACT & REVIEW
// ─────────────────────────────────────────────────────────────────────────────
async function _scContact(from, supplierId) {
  const seller = await SupplierProfile.findById(supplierId).lean();
  if (!seller) return false;

  return sendButtons(from, {
    text:
`📞 *Contact ${seller.businessName}*

Phone: *${seller.contactPhone || seller.phone}*
${seller.email ? "Email: " + seller.email + "\n" : ""}${seller.address ? "📍 " + seller.address + "\n" : ""}${seller.city ? "📍 " + seller.area + (seller.area?", ":"") + seller.city : ""}

${seller.whatsappNumber ? `WhatsApp: ${seller.whatsappNumber}` : ""}`,
    buttons: [
      { id: `sc_back_${supplierId}`, title: "⬅ Back to Seller" }
    ]
  });
}

async function _scReview(from, supplierId, biz, saveBiz) {
  const seller = await SupplierProfile.findById(supplierId).lean();
  if (!seller) return false;

  return sendButtons(from, {
    text:
`⭐ *Leave a review for ${seller.businessName}*

Your review helps other buyers on ZimQuote.

How was your experience?`,
    buttons: [
      { id: `sc_back_${supplierId}`, title: "⬅ Back" }
    ]
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// SELLER PRICE REPLY HANDLER (for unpriced RFQ)
// Called when a seller number sends a price reply matching a pending RFQ
// ─────────────────────────────────────────────────────────────────────────────
export async function handleSellerPriceReply(from, text, biz, saveBiz) {
  // Check if this sender is a seller with a pending outbound RFQ that needs pricing
  // This is called from handleIncomingMessage for sellers in sc_seller_awaiting_prices state
  const state = biz?.sessionState;
  if (state !== "sc_seller_awaiting_prices") return false;

  const pending = biz?.sessionData?.scPendingRFQ;
  if (!pending) return false;

  return _scProcessSellerPriceReply(from, pending.supplierId, text, biz, saveBiz);
}

async function _scProcessSellerPriceReply(from, supplierId, raw, biz, saveBiz) {
  const pending = biz?.sessionData?.scPendingRFQ;
  if (!pending) return false;

  // Parse price reply: "1=2.50, 2=3.00, 3=15.00" or "1×2.50 2×3.00 3×15.00"
  const prices = {};
  const matches = raw.matchAll(/(\d+)\s*[=×x@:]\s*(\d+(?:\.\d+)?)/gi);
  for (const m of matches) {
    prices[parseInt(m[1]) - 1] = parseFloat(m[2]);
  }

  if (!Object.keys(prices).length) {
    return sendText(from, "❌ Could not read prices. Format: 1=price, 2=price, 3=price\nExample: 1=2.50, 2=3.00, 3=15.00");
  }

  const items      = pending.items || [];
  const lineItems  = items.map((item, i) => ({
    name:      item.name,
    qty:       item.qty || 1,
    unitPrice: prices[i] || 0,
    lineTotal: (prices[i] || 0) * (item.qty || 1)
  }));
  const total   = lineItems.reduce((s, l) => s + l.lineTotal, 0);
  const refNum  = pending.refNum;
  const expiry  = new Date(Date.now() + 48 * 3600 * 1000).toLocaleDateString("en-GB", { day:"numeric", month:"short" });

  // Try to generate PDF
  let pdfSent = false;
  try {
    const { generateQuotePDF } = await import("./quotePdfGenerator.js");
    const seller = await SupplierProfile.findById(supplierId).lean();
    const pdf    = await generateQuotePDF({
      refNum, sellerName: seller?.businessName, sellerPhone: from,
      sellerCity: seller?.city, buyerPhone: pending.buyerPhone,
      buyerName: pending.buyerName, items: lineItems, total, expiry
    });
    if (pdf?.url) {
      const { sendDocument } = await import("./metaSender.js");
      await sendDocument(pending.buyerPhone, { link: pdf.url, filename: `Quote_${refNum}.pdf` });
      pdfSent = true;
    }
  } catch (e) { /* ignore */ }

  // Notify buyer
  const itemRows = lineItems.map(l =>
    `${l.name} × ${l.qty} @ $${l.unitPrice.toFixed(2)} = $${l.lineTotal.toFixed(2)}`
  ).join("\n");

  try {
    const { sendText: _st } = await import("./metaSender.js");
    const buyerMsg =
`💵 *Your quote is ready — ${refNum}*

${itemRows}
${"─".repeat(28)}
*Total: $${total.toFixed(2)} USD*
Valid until: ${expiry}

${pdfSent ? "PDF sent above — tap to open." : ""}`;
    await _st(pending.buyerPhone, buyerMsg);
  } catch (e) { /* ignore */ }

  if (biz) { biz.sessionState = "ready"; await saveBiz(biz); }

  return sendText(from,
`✅ Quote ${refNum} has been sent to the buyer.
Total: $${total.toFixed(2)}${pdfSent ? "\nPDF delivered to buyer." : ""}`
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────
function _parseItemInput(raw, knownItems = [], isService = false) {
  const results = [];

  // Try numbered format: 1×50, 2×10 or 1=50, 2=10
  const numbered = [...raw.matchAll(/(\d+)\s*[×xX=@]\s*(\d+(?:\.\d+)?)/g)];
  if (numbered.length > 0) {
    for (const m of numbered) {
      const idx  = parseInt(m[1]) - 1;
      const qty  = parseFloat(m[2]);
      const item = knownItems[idx];
      if (item) {
        results.push({
          name:  isService ? item.service : item.product,
          qty,
          price: isService ? (parseFloat(item.rate) || 0) : (parseFloat(item.amount) || 0)
        });
      }
    }
    if (results.length) return results;
  }

  // Free text: split by comma or newline
  const parts = raw.split(/[,\n]+/).map(s => s.trim()).filter(Boolean);
  for (const part of parts) {
    const qtyMatch = part.match(/^(.*?)\s*[×x×*@]\s*(\d+(?:\.\d+)?)$/i)
                  || part.match(/^(\d+(?:\.\d+)?)\s*[×x×*@]\s*(.*?)$/i);
    if (qtyMatch) {
      results.push({ name: qtyMatch[1].trim() || qtyMatch[2].trim(), qty: parseFloat(qtyMatch[2]) || parseFloat(qtyMatch[1]) || 1, price: 0 });
    } else {
      results.push({ name: part, qty: 1, price: 0 });
    }
  }
  return results;
}