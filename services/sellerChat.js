// services/sellerChat.js
// ─── ZimQuote Seller Chatbot - Quote, Order, Booking, Delivery ───────────────
//
// Full buyer interaction flow when a buyer taps a seller's ZimQuote smart link.
//
// Covers:
//   1. Seller profile display - name, location, products/services, ratings
//   2. Instant quote (seller has prices) - full chunked catalogue, seller confirms, PDF sent
//   3. RFQ flow (no prices) - structured list to seller via Meta template, seller prices, PDF sent
//   4. Product order - confirm items, qty, delivery/collection choice, location
//   5. Service booking - date/time, location, job description, confirmation
//   6. Delivery options - deliver to buyer, collection from seller, both
//   7. Location capture - buyer suburb/address for delivery quotes
//   8. Repeat order - returning buyer one-tap repeat
//   9. Complaint / after-sales - escalation flow
//
// Wire in chatbotEngine.js:
//   if (a.startsWith("sc_"))        return handleSellerChatAction({ from, action: a, biz, saveBiz });
//   if (state?.startsWith("sc_"))   return handleSellerChatState({ state, from, text, biz, saveBiz });

import SupplierProfile from "../models/supplierProfile.js";
import SchoolLead      from "../models/schoolLead.js";
import { sendText, sendButtons, sendList, sendDocument } from "./metaSender.js";
import { notifySupplierNewOrder } from "./supplierOrders.js";

const BOT_NUMBER = (process.env.WHATSAPP_BOT_NUMBER || "263771143904").replace(/\D/g, "");

// Normalize Zimbabwean phone to international format
function _normPhone(raw = "") {
  let p = String(raw).replace(/\D+/g, "");
  if (p.startsWith("0") && p.length === 10) p = "263" + p.slice(1);
  return p;
}

// Non-blocking smart link conversion tracker
function _trackConversion(biz) {
  if (biz?.sessionData?.scSource && biz.sessionData.scSellerId) {
    import("./supplierSmartLink.js").then(({ trackLinkEvent }) => {
      trackLinkEvent(biz.sessionData.scSellerId, {
        source: biz.sessionData.scSource,
        isConversion: true
      }).catch(() => {});
    }).catch(() => {});
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN SELLER PROFILE + MENU
// Called when buyer opens a seller's ZimQuote smart link
// ─────────────────────────────────────────────────────────────────────────────
export async function showSellerMenu(from, supplierId, biz, saveBiz, { source = "direct", parentName = "" } = {}) {
  const seller = await SupplierProfile.findById(supplierId).lean();
  if (!seller) return sendText(from, "❌ Seller profile not found. Please try again.");

  // Use profileType (correct field) - not serviceType
  const isService = seller.profileType === "service";
  const delivery  = seller.delivery?.available;
  const hasPrices = (Array.isArray(seller.prices) && seller.prices.length > 0) ||
                    (Array.isArray(seller.rates)   && seller.rates.length  > 0);
  const rating    = (seller.reviewCount || 0) > 0
    ? `⭐ ${Number(seller.rating).toFixed(1)} (${seller.reviewCount} review${seller.reviewCount === 1 ? "" : "s"})` : "";

  const productSample = isService
    ? (seller.rates  || []).slice(0, 3).map(r => `• ${r.service}${r.rate ? " - " + r.rate : ""}`).join("\n")
    : (seller.prices || []).filter(p => p.inStock !== false).slice(0, 5)
        .map(p => `• ${p.product}${p.amount ? " - $" + Number(p.amount).toFixed(2) + "/" + (p.unit || "each") : " - price on request"}`).join("\n");

  // Store seller context in buyer's session
  if (biz) {
    biz.sessionData = {
      ...(biz.sessionData || {}),
      scSellerId:  supplierId,
      scIsService: isService,
      scHasPrices: hasPrices,
      scSource:    source,
      scBuyerName: parentName
    };
    await saveBiz(biz);
  }

  const hasHistory = biz?.sessionData?.scLastOrder;
  const repeatBtn  = hasHistory
    ? [{ id: `sc_repeat_${supplierId}`, title: "🔄 Repeat last order" }] : [];

  const area     = seller.location?.area || seller.area || "";
  const city     = seller.location?.city || seller.city || "";
  const location = [area, city].filter(Boolean).join(", ");

  await sendText(from,
`${isService ? "🔧" : "🏪"} *${seller.businessName}*${seller.verified ? " ✅" : ""}${seller.topSupplierBadge ? " 🏅" : ""}
📍 ${location}
${rating}

${isService ? "Services offered:" : "Products available:"}
${productSample || "Contact seller for full catalogue"}

${delivery ? "🚚 Delivery available" : "🏠 Collection only"}`
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
// Handles button taps (sc_<topic>_<supplierId> or sc_quote_confirm_<refNum>)
// ─────────────────────────────────────────────────────────────────────────────
export async function handleSellerChatAction({ from, action: a, biz, saveBiz }) {
  // ── Special: refNum-based actions (not supplierId-based) ─────────────────
  // sc_quote_confirm_QT-XXXXXX  /  sc_quote_edit_QT-XXXXXX
  // sc_rfq_price_RFQ-XXXXXX
   const _confirmMatch = a.match(/^sc_quote_confirm_(.+)$/);
  const _editMatch    = a.match(/^sc_quote_edit_(.+)$/);
  const _rfqMatch     = a.match(/^sc_rfq_price_(.+)$/);

    if (_confirmMatch) return _scHandleQuoteConfirm(from, _confirmMatch[1].toUpperCase(), biz, saveBiz);
  if (_editMatch)    return _scHandleQuoteEdit(from, _editMatch[1].toUpperCase(), biz, saveBiz);
  if (_rfqMatch) {
    // Seller taps "Enter Prices" on RFQ template - set edit state and prompt
    const UserSession = (await import("../models/userSession.js")).default;
    await UserSession.findOneAndUpdate(
      { phone: _normPhone(from) },
      { $set: { "tempData.scSellerQuoteState": "awaiting_seller_price_edit" } },
      { upsert: true }
    );
    return sendText(from,
      `💵 *Enter prices for ${_rfqMatch[1]}*\n\n` +
      `Format: _1=12.50, 2=8.00, 3=3.00_\n` +
      `Only include items you want to price.\n\n` +
      `Type *cancel* to discard.`
    );
  }

  // ── Standard: supplierId as last segment ─────────────────────────────────
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
    case "repeat":          return _scRepeat(from, supplierId, biz, saveBiz);
    case "contact":         return _scContact(from, supplierId);
    case "review":          return _scReview(from, supplierId, biz, saveBiz);
    case "back":            return showSellerMenu(from, supplierId, biz, saveBiz);
    default:                return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// STATE HANDLER - handles typed text in seller chat states
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

  // ── Seller editing prices on a pending smart-link quote ──────────────────
  // Check UserSession directly - seller's biz.sessionState may be "ready"
  // but they still have a pending quote draft in their session.
  {
    const UserSession = (await import("../models/userSession.js")).default;
    const _sess = await UserSession.findOne({ phone: _normPhone(from) }).lean();
    if (_sess?.tempData?.scSellerQuoteState === "awaiting_seller_price_edit") {
      return _scProcessSellerPriceEdit(from, raw, biz, saveBiz);
    }
  }

  // ── Quote: buyer typed item numbers/names ────────────────────────────────
  if (state === "sc_awaiting_items") {
    return _scProcessItemList(from, supplierId, raw, biz, saveBiz);
  }

  // ── Order: buyer typed delivery address ──────────────────────────────────
  if (state === "sc_awaiting_address") {
    return _scProcessAddress(from, supplierId, raw, biz, saveBiz);
  }

  // ── Booking: buyer typed preferred date/time ─────────────────────────────
  if (state === "sc_awaiting_booking_datetime") {
    return _scProcessBookingDateTime(from, supplierId, raw, biz, saveBiz);
  }

  // ── Booking: buyer typed job description ─────────────────────────────────
  if (state === "sc_awaiting_job_desc") {
    return _scProcessJobDescription(from, supplierId, raw, biz, saveBiz);
  }

  // ── Booking: buyer typed service location ────────────────────────────────
  if (state === "sc_awaiting_service_location") {
    return _scProcessServiceLocation(from, supplierId, raw, biz, saveBiz);
  }

  // ── Seller pricing reply (legacy unpriced RFQ without UserSession draft) ─
  if (state === "sc_seller_awaiting_prices") {
    return _scProcessSellerPriceReply(from, supplierId, raw, biz, saveBiz);
  }

  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// QUOTE FLOW
// ─────────────────────────────────────────────────────────────────────────────
async function _scQuote(from, supplierId, biz, saveBiz) {
  const seller    = await SupplierProfile.findById(supplierId).lean();
  if (!seller) return false;

  const isService = seller.profileType === "service";
  const hasPrices = isService
    ? (Array.isArray(seller.rates)  && seller.rates.length  > 0)
    : (Array.isArray(seller.prices) && seller.prices.length > 0);

  if (hasPrices) {
    // Send full catalogue in chunks of 30 - handles 100+ item sellers
    const allItems = isService ? seller.rates : seller.prices;
    const total    = allItems.length;
    const CHUNK    = 30;

    if (biz) {
      biz.sessionState = "sc_awaiting_items";
      biz.sessionData  = { ...(biz.sessionData || {}), scSellerId: supplierId, scQuoteItems: [] };
      await saveBiz(biz);
    }

    for (let i = 0; i < total; i += CHUNK) {
      const chunk   = allItems.slice(i, i + CHUNK);
      const isFirst = i === 0;
      const isLast  = i + CHUNK >= total;

      const lines = chunk.map((item, j) => {
        const idx   = i + j + 1;
        const name  = isService ? item.service : item.product;
        const price = isService
          ? (item.rate || "rate on request")
          : `$${Number(item.amount).toFixed(2)}/${item.unit || "each"}`;
        return `${idx}. ${name} - ${price}`;
      }).join("\n");

      if (isFirst) {
        await sendText(from,
`💵 *${seller.businessName} - ${isService ? "Services" : "Products & prices"} (${total} item${total === 1 ? "" : "s"})*

${lines}${isLast ? "" : "\n_(list continues...)_"}`
        );
      } else {
        await sendText(from, `${lines}${isLast ? "" : "\n_(list continues...)_"}`);
      }
    }

    // Instructions sent after list so buyer always sees them last
    return sendText(from,
`*To get your quote:*
Type item numbers and quantities, e.g:
_1×50, 3×10, 5×2_

Or type item names: _"20mm pipe 30 metres, ball valve 10"_

Type *done* when finished, or *cancel* to go back.`
    );

  } else {
    // No prices - RFQ mode
    if (biz) {
      biz.sessionState = "sc_awaiting_items";
      biz.sessionData  = { ...(biz.sessionData || {}), scSellerId: supplierId, scQuoteItems: [], scRFQ: true };
      await saveBiz(biz);
    }

    const productHint = isService
      ? "e.g. _geyser installation, electrical rewiring 3-bed house_"
      : "e.g. _20mm PVC pipe 30m, ball valve 15mm ×10, 110mm drain pipe 5m_";

    return sendText(from,
`💵 *Quote request - ${seller.businessName}*

List everything you need. Be as specific as possible - sizes, quantities, brands.

${productHint}

Type each item on a new line or separate with commas.
Type *done* when finished, or *cancel* to go back.`
    );
  }
}

async function _scProcessItemList(from, supplierId, raw, biz, saveBiz) {
  const seller = await SupplierProfile.findById(supplierId).lean();
  if (!seller) return false;

  const isService = seller.profileType === "service";
  const isRFQ     = biz?.sessionData?.scRFQ;

  if (raw.toLowerCase() === "done") {
    return _scQuoteDone(from, supplierId, biz, saveBiz);
  }

  const existingItems = biz?.sessionData?.scQuoteItems || [];
  const newItems      = _parseItemInput(raw, isService ? seller.rates : seller.prices, isService);
  const allItems      = [...existingItems, ...newItems];

  if (biz) {
    biz.sessionData = { ...(biz.sessionData || {}), scQuoteItems: allItems };
    await saveBiz(biz);
  }

  const summary = allItems.map(it => `• ${it.name} × ${it.qty}`).join("\n");

  return sendButtons(from, {
    text:
`🛒 *Items in your quote:*
${summary}

Add more items, or tap below when done.`,
    buttons: [
      { id: `sc_quote_done_${supplierId}`,  title: isRFQ ? "📤 Send Request" : "✅ Get Quote" },
      { id: `sc_quote_clear_${supplierId}`, title: "🗑️ Start Over" }
    ]
  });
}

// ── _scQuoteDone ──────────────────────────────────────────────────────────────
// Both RFQ and priced paths now send the seller a Meta template notification
// (works outside 24hr window) via notifySupplierNewRequestTemplate.
// Priced path: stores draft in seller's UserSession for confirm/edit before
// the quote is delivered to the buyer.
async function _scQuoteDone(from, supplierId, biz, saveBiz) {
  const seller    = await SupplierProfile.findById(supplierId).lean();
  if (!seller) return false;

  const isService = seller.profileType === "service";
  const items     = biz?.sessionData?.scQuoteItems || [];
  const isRFQ     = biz?.sessionData?.scRFQ;
  const buyerName = biz?.sessionData?.scBuyerName || "";
  const buyerPhone = from;

  if (!items.length) {
    return sendText(from, "❌ No items added. Please list the items you need first.");
  }

  // ── RFQ path - seller has no prices set ──────────────────────────────────
  if (isRFQ) {
    const itemList = items.map((it, i) => `${i + 1}. ${it.name} × ${it.qty}`).join("\n");
    const refNum   = "RFQ-" + Date.now().toString(36).toUpperCase().slice(-6);

    // Store pending RFQ in buyer's session for when seller replies with prices
    if (biz) {
      biz.sessionState = "ready";
      biz.sessionData  = {
        ...(biz.sessionData || {}),
        scLastRFQ: { refNum, supplierId, buyerPhone, buyerName, items, timestamp: Date.now() }
      };
      await saveBiz(biz);
    }

    // Notify seller via existing Meta template system - works outside 24hr window
    await _sendSellerNotification({
      sellerPhone:  seller.phone,
      refNum,
      buyerDisplay: buyerName || _normPhone(buyerPhone),
      itemList,
      itemCount:    items.length,
      isRFQ:        true,
    });

    _trackConversion(biz);

    return sendButtons(from, {
      text:
`✅ *Quote request sent to ${seller.businessName}*

Reference: *${refNum}*
Items: ${items.length} item${items.length > 1 ? "s" : ""}

The seller will price your request and you'll receive a PDF quote on WhatsApp.

📞 ${seller.contactDetails || seller.phone}`,
      buttons: [
        { id: `sc_back_${supplierId}`,    title: "⬅ Back to Seller" },
        { id: `sc_contact_${supplierId}`, title: "📞 Contact seller" }
      ]
    });
  }

  // ── Priced path - calculate draft, send to seller for confirmation ────────
  const priceItems = isService ? seller.rates : seller.prices;
  const priceMap   = {};
  for (const item of (priceItems || [])) {
    const key = (isService ? item.service : item.product).toLowerCase().trim();
    priceMap[key] = isService ? (parseFloat(item.rate) || 0) : (parseFloat(item.amount) || 0);
  }

  let total = 0;
  const lineItems = items.map(it => {
    const unitPrice = priceMap[it.name.toLowerCase().trim()] || it.price || 0;
    const lineTotal = unitPrice * (it.qty || 1);
    total += lineTotal;
    return { name: it.name, qty: it.qty || 1, unitPrice, lineTotal };
  });

  const refNum = "QT-" + Date.now().toString(36).toUpperCase().slice(-6);
  const expiry = new Date(Date.now() + 48 * 3600 * 1000)
    .toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });

  const itemRows = lineItems.map((l, i) =>
    `${i + 1}. ${l.name} × ${l.qty} - $${l.unitPrice.toFixed(2)}/${isService ? "job" : "each"} = $${l.lineTotal.toFixed(2)}`
  ).join("\n");

  // Store draft in SELLER's UserSession so they can confirm or edit
  try {
    const UserSession = (await import("../models/userSession.js")).default;
    await UserSession.findOneAndUpdate(
      { phone: _normPhone(seller.phone) },
      {
        $set: {
          "tempData.scPendingSellerQuote": JSON.stringify({
            refNum, supplierId, buyerPhone, buyerName, lineItems, total, expiry, isService
          }),
          "tempData.scSellerQuoteState": "awaiting_seller_quote_confirm",
          "tempData.scBuyerPhone":       buyerPhone,
        }
      },
      { upsert: true }
    );
  } catch (err) {
    console.error("[SC QUOTE] Failed to store draft on seller session:", err.message);
  }

  // Notify seller via Meta template - works outside 24hr window
  await _sendSellerNotification({
    sellerPhone:  seller.phone,
    refNum,
    buyerDisplay: buyerName || _normPhone(buyerPhone),
    itemList:     itemRows,
    itemCount:    lineItems.length,
    total,
    isRFQ:        false,
  });

  _trackConversion(biz);

  // Tell buyer we've sent the draft to the seller for confirmation
  return sendButtons(from, {
    text:
`⏳ *Quote sent to ${seller.businessName} for confirmation*

Reference: *${refNum}*

${itemRows}
${"─".repeat(28)}
*Estimated total: $${total.toFixed(2)} USD*

The seller will confirm or adjust the prices. You'll receive the final quote and PDF automatically.`,
    buttons: [
      { id: `sc_back_${supplierId}`,    title: "⬅ Back to Seller" },
      { id: `sc_contact_${supplierId}`, title: "📞 Contact seller" }
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
// SELLER CONFIRMS DRAFT QUOTE → PDF generated → buyer notified
// ─────────────────────────────────────────────────────────────────────────────
async function _scHandleQuoteConfirm(from, refNum, biz, saveBiz) {
  const UserSession = (await import("../models/userSession.js")).default;
  const sess  = await UserSession.findOne({ phone: _normPhone(from) }).lean();
  const raw   = sess?.tempData?.scPendingSellerQuote;
  const draft = raw ? (typeof raw === "string" ? JSON.parse(raw) : raw) : null;

 if (!draft || draft.refNum.toUpperCase() !== refNum.toUpperCase()) {
    return sendText(from, `❌ Quote ${refNum} not found or already sent. It may have expired.`);
  }

  const seller = await SupplierProfile.findById(draft.supplierId).lean();
  if (!seller) return sendText(from, "❌ Seller profile not found.");

  const { lineItems, total, expiry, buyerPhone, buyerName } = draft;

  // Generate and send PDF using the same generatePDF used throughout chatbotEngine.js
  let pdfSent = false;
  try {
    const { generatePDF } = await import("../routes/twilio_biz.js");
    const site = (process.env.SITE_URL || "").replace(/\/$/, "");

    const { filename } = await generatePDF({
      type:      "quote",
      number:    refNum,
      date:      new Date(),
      billingTo: buyerName || _normPhone(buyerPhone),
      items: lineItems.map(l => ({
        item:  l.name,
        qty:   Number(l.qty       || 1),
        unit:  Number(l.unitPrice || 0),
        total: Number(l.lineTotal || 0)
      })),
      bizMeta: {
        name:    seller.businessName,
        logoUrl: seller.logoUrl || "",
        address: [
          seller.address || "",
          seller.location?.area || seller.area || "",
          seller.location?.city || seller.city || ""
        ].filter(Boolean).join(", "),
        _id:    String(seller._id),
        status: "quotation"
      }
    });

    const pdfLink   = `${site}/docs/generated/quotes/${filename}`;
    const normBuyer = _normPhone(buyerPhone);
    await sendDocument(normBuyer, { link: pdfLink, filename });
    pdfSent = true;
    console.log(`[SC QUOTE PDF] ${filename} → ${normBuyer}`);
  } catch (pdfErr) {
    console.warn(`[SC QUOTE PDF] failed: ${pdfErr.message}`);
  }

  // Notify buyer their quote is ready
  await _sendBuyerQuoteNotification({
    buyerPhone,
    sellerName: seller.businessName,
    refNum,
    total,
    expiry,
    pdfSent,
  });

  // Clear draft from seller's session
  await UserSession.findOneAndUpdate(
    { phone: _normPhone(from) },
    { $unset: {
        "tempData.scPendingSellerQuote": "",
        "tempData.scSellerQuoteState":   "",
        "tempData.scBuyerPhone":         ""
      }
    },
    { upsert: true }
  );

  const itemRows = lineItems.map((l, i) =>
    `${i + 1}. ${l.name} × ${l.qty} @ $${l.unitPrice.toFixed(2)} = $${l.lineTotal.toFixed(2)}`
  ).join("\n");

  return sendButtons(from, {
    text:
`✅ *Quote ${refNum} sent to buyer!*

${itemRows}
${"─".repeat(28)}
*Total: $${total.toFixed(2)} USD*

${pdfSent ? "PDF delivered to buyer." : "Quote delivered to buyer."}`,
    buttons: [
      { id: "my_supplier_account", title: "🏪 My Account" }
    ]
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// SELLER EDITS DRAFT PRICES → shows numbered list → waits for typed reply
// ─────────────────────────────────────────────────────────────────────────────
async function _scHandleQuoteEdit(from, refNum, biz, saveBiz) {
  const UserSession = (await import("../models/userSession.js")).default;
  const sess  = await UserSession.findOne({ phone: _normPhone(from) }).lean();
  const raw   = sess?.tempData?.scPendingSellerQuote;
  const draft = raw ? (typeof raw === "string" ? JSON.parse(raw) : raw) : null;

 if (!draft || draft.refNum.toUpperCase() !== refNum.toUpperCase()) {
    return sendText(from, `❌ Quote ${refNum} not found or already sent.`);
  }

  // Set state so next typed message is treated as a price edit
  await UserSession.findOneAndUpdate(
    { phone: _normPhone(from) },
    { $set: { "tempData.scSellerQuoteState": "awaiting_seller_price_edit" } },
    { upsert: true }
  );

  const numbered = draft.lineItems.map((l, i) =>
    `${i + 1}. ${l.name} × ${l.qty} - current: $${l.unitPrice.toFixed(2)}`
  ).join("\n");

  return sendText(from,
`✏️ *Edit prices - ${refNum}*

${numbered}

Type updated prices (only items you want to change):
_1=12.50, 3=8.00_

Type *confirm* to send as-is, or *cancel* to discard.`
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// PROCESS SELLER'S TYPED PRICE EDITS
// ─────────────────────────────────────────────────────────────────────────────
async function _scProcessSellerPriceEdit(from, text, biz, saveBiz) {
  const UserSession = (await import("../models/userSession.js")).default;
  const sess  = await UserSession.findOne({ phone: _normPhone(from) }).lean();
  const raw   = sess?.tempData?.scPendingSellerQuote;
  const draft = raw ? (typeof raw === "string" ? JSON.parse(raw) : raw) : null;

  if (!draft) return sendText(from, "❌ No pending quote found. It may have expired.");

  const al = text.trim().toLowerCase();

  if (al === "cancel") {
    await UserSession.findOneAndUpdate(
      { phone: _normPhone(from) },
      { $unset: {
          "tempData.scPendingSellerQuote": "",
          "tempData.scSellerQuoteState":   "",
          "tempData.scBuyerPhone":         ""
        }
      },
      { upsert: true }
    );
    return sendText(from, `🗑 Quote ${draft.refNum} discarded.`);
  }

  if (al === "confirm" || al === "send") {
    return _scHandleQuoteConfirm(from, draft.refNum, biz, saveBiz);
  }

  // Parse price edits: "1=12.50, 2=8.00" or "1x12.50 2x8"
  const edits = {};
  const matches = text.matchAll(/(\d+)\s*[=×xX@:]\s*(\d+(?:\.\d+)?)/g);
  for (const m of matches) {
    const idx = parseInt(m[1]) - 1;
    if (idx >= 0 && idx < draft.lineItems.length) {
      edits[idx] = parseFloat(m[2]);
    }
  }

  if (!Object.keys(edits).length) {
    return sendText(from,
      `❌ Could not read prices.\n\n` +
      `Format: _1=12.50, 2=8.00_\n` +
      `Or type *confirm* to send as-is.`
    );
  }

  // Apply edits to draft
  let newTotal = 0;
  const updatedItems = draft.lineItems.map((l, i) => {
    const unitPrice = edits.hasOwnProperty(i) ? edits[i] : l.unitPrice;
    const lineTotal = unitPrice * l.qty;
    newTotal += lineTotal;
    return { ...l, unitPrice, lineTotal, _edited: edits.hasOwnProperty(i) };
  });

  const updatedDraft = { ...draft, lineItems: updatedItems, total: newTotal };
  await UserSession.findOneAndUpdate(
    { phone: _normPhone(from) },
    { $set: { "tempData.scPendingSellerQuote": JSON.stringify(updatedDraft) } },
    { upsert: true }
  );

  const numbered = updatedItems.map((l, i) =>
    `${i + 1}. ${l.name} × ${l.qty} @ $${l.unitPrice.toFixed(2)} = $${l.lineTotal.toFixed(2)}${l._edited ? " ✏️" : ""}`
  ).join("\n");

  return sendButtons(from, {
    text:
`✏️ *Updated quote - ${draft.refNum}*

${numbered}
${"─".repeat(28)}
*New total: $${newTotal.toFixed(2)} USD*

_✏️ = price you changed_

Confirm to send to buyer, or edit again.`,
    buttons: [
      { id: `sc_quote_confirm_${draft.refNum}`, title: "✅ Confirm & Send" },
      { id: `sc_quote_edit_${draft.refNum}`,    title: "✏️ Edit Again" }
    ]
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// SELLER NOTIFICATION - reuses existing approved Meta template infrastructure
// Sends supplier_new_request_v2 (with View & Quote button) or falls back to v1.
// Works outside 24hr window. No new templates needed.
// ─────────────────────────────────────────────────────────────────────────────
async function _sendSellerNotification({ sellerPhone, refNum, buyerDisplay, itemList, itemCount, total, isRFQ }) {
  try {
    const { notifySupplierNewRequestTemplate } = await import("./buyerRequestNotifications.js");

    const totalLine     = typeof total === "number" ? `Total: $${total.toFixed(2)}` : "Prices needed from you";
    const firstLine     = String(itemList).split("\n")[0].replace(/^\d+\.\s*/, "").trim();
    const itemSummary   = `${itemCount} item${itemCount === 1 ? "" : "s"}: ${firstLine}${itemCount > 1 ? " + more" : ""}`;
    const deliveryLine  = isRFQ
      ? "Please reply with prices: 1=price, 2=price"
      : totalLine;

    await notifySupplierNewRequestTemplate({
      supplierPhone: sellerPhone,
      requestId:     refNum,
      ref:           refNum,
      locationText:  `Smart Link Quote · ${buyerDisplay}`,
      itemCount,
      itemSummary,
      deliveryLine,
      fullItemLines: String(itemList),
      replyExamples: "1=12.50, 2=8.00"
    });

    console.log(`[SC NOTIF] notifySupplierNewRequestTemplate → ${sellerPhone} (${refNum})`);

  } catch (err) {
    console.warn(`[SC NOTIF] template failed for ${sellerPhone}: ${err.message}. Falling back.`);
    // Fallback for within-24hr sessions
    try {
      if (isRFQ) {
        await sendButtons(_normPhone(sellerPhone), {
          text:
            `📋 *New Quote Request - ${refNum}*\n\n` +
            `Buyer: ${buyerDisplay}\n\n` +
            `Items:\n${itemList}\n\n` +
            `Reply with prices: _1=12.50, 2=8.00_`,
          buttons: [
            { id: `sc_rfq_price_${refNum}`, title: "💵 Enter Prices" }
          ]
        });
      } else {
        await sendButtons(_normPhone(sellerPhone), {
          text:
            `📋 *New Quote Request - ${refNum}*\n\n` +
            `Buyer: ${buyerDisplay}\n\n` +
            `Items:\n${itemList}\n\n` +
            `${typeof total === "number" ? "Estimated total: $" + total.toFixed(2) : "Prices needed"}\n\n` +
            `Confirm or edit the prices before the buyer receives the quote.`,
          buttons: [
            { id: `sc_quote_confirm_${refNum}`, title: "✅ Confirm & Send" },
            { id: `sc_quote_edit_${refNum}`,    title: "✏️ Edit Prices" }
          ]
        });
      }
    } catch (fallbackErr) {
      console.error(`[SC NOTIF] all fallbacks failed for ${sellerPhone}: ${fallbackErr.message}`);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// BUYER QUOTE DELIVERY - notifies buyer their quote is ready
// Uses sendButtons fallback (PDF already sent via sendDocument above)
// ─────────────────────────────────────────────────────────────────────────────
async function _sendBuyerQuoteNotification({ buyerPhone, sellerName, refNum, total, expiry, pdfSent = false }) {
  try {
    await sendButtons(_normPhone(buyerPhone), {
      text:
`✅ *Your quote is ready - ${refNum}*

From: *${sellerName}*
Total: *$${Number(total).toFixed(2)} USD*
Valid until: ${expiry}

${pdfSent ? "PDF sent above - tap to open." : "Quote confirmed by seller."}`,
      buttons: [
        { id: "sup_request_sellers", title: "⚡ New Request" },
        { id: "find_supplier",       title: "🔍 Browse Sellers" }
      ]
    });
  } catch (err) {
    console.warn(`[SC BUYER NOTIF] failed for ${buyerPhone}: ${err.message}`);
  }
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
`🛒 *Place an order - ${seller.businessName}*

How would you like to receive your order?`,
      buttons: [
        { id: `sc_order_deliver_${supplierId}`, title: "🚚 Deliver to me" },
        { id: `sc_order_collect_${supplierId}`, title: "🏠 I'll collect" },
        { id: `sc_back_${supplierId}`,          title: "⬅ Back" }
      ]
    });
  } else if (delivery) {
    return _scOrderDeliver(from, supplierId, biz, saveBiz);
  } else {
    return _scOrderCollect(from, supplierId, biz, saveBiz);
  }
}

async function _scOrderDeliver(from, supplierId, biz, saveBiz) {
  const seller   = await SupplierProfile.findById(supplierId).lean();
  if (!seller) return false;

  const minOrder = seller.delivery?.minimumOrder ? `\nMinimum order: $${seller.delivery.minimumOrder}` : "";
  const fee      = seller.delivery?.fee ? `\nDelivery fee: $${seller.delivery.fee}` : "";

  if (biz) {
    biz.sessionState = "sc_awaiting_address";
    biz.sessionData  = { ...(biz.sessionData || {}), scDelivery: true };
    await saveBiz(biz);
  }

  return sendText(from,
`🚚 *Delivery - ${seller.businessName}*${minOrder}${fee}

Please type your delivery address or suburb.

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

  // Notify seller
  try {
    const { sendText: _st } = await import("./metaSender.js");
    await _st(seller.phone,
`📦 New delivery order on ZimQuote.

Buyer: ${_normPhone(from)}
Delivery to: ${raw}
${pendingQuote ? `Quote: ${pendingQuote.refNum}\nTotal: $${pendingQuote.total?.toFixed(2)}` : ""}

Contact buyer to confirm.`
    );
  } catch (e) { /* ignore */ }

  return sendButtons(from, {
    text:
`✅ *Order confirmed*

${seller.businessName}
Delivery to: *${raw}*
${pendingQuote ? `Quote ref: *${pendingQuote.refNum}* · Total: *$${pendingQuote.total?.toFixed(2)}*` : ""}

The seller will contact you to confirm delivery schedule and payment.
📞 ${seller.contactDetails || seller.phone}`,
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

  try {
    const { sendText: _st } = await import("./metaSender.js");
    await _st(seller.phone,
`📦 New collection order on ZimQuote.

Buyer: ${_normPhone(from)}
${pendingQuote ? `Quote: ${pendingQuote.refNum}\nTotal: $${pendingQuote.total?.toFixed(2)}` : ""}

Contact buyer to confirm collection time.`
    );
  } catch (e) { /* ignore */ }

  const area = seller.location?.area || seller.area || "";
  const city = seller.location?.city || seller.city || "";

  return sendButtons(from, {
    text:
`✅ *Collection order confirmed*

${seller.businessName}
${pendingQuote ? `Quote: *${pendingQuote.refNum}* · Total: *$${pendingQuote.total?.toFixed(2)}*\n` : ""}
📍 Collect from: ${seller.address || [area, city].filter(Boolean).join(", ")}

📞 ${seller.contactDetails || seller.phone}

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
`📅 *Book a service - ${seller.businessName}*

Where do you need the service?

_Type your address or suburb, e.g. "Borrowdale, Harare"_
Type *cancel* to go back.`
  );
}

// Stub for book_confirm (mirrors order confirm)
async function _scBookConfirm(from, supplierId, biz, saveBiz) {
  return _scBook(from, supplierId, biz, saveBiz);
}

async function _scProcessServiceLocation(from, supplierId, raw, biz, saveBiz) {
  if (biz) {
    biz.sessionState = "sc_awaiting_job_desc";
    biz.sessionData  = { ...(biz.sessionData || {}), scServiceLocation: raw };
    await saveBiz(biz);
  }
  return sendText(from,
`📋 *Service booking - describe the job*

Location: _${raw}_

Describe what needs to be done. Be specific.

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

_e.g. "Monday morning", "Any weekday after 2pm", "Urgent - today or tomorrow"_
Type *cancel* to go back.`
  );
}

async function _scProcessBookingDateTime(from, supplierId, raw, biz, saveBiz) {
  const seller    = await SupplierProfile.findById(supplierId).lean();
  if (!seller) return false;

  const location  = biz?.sessionData?.scServiceLocation || "not specified";
  const jobDesc   = biz?.sessionData?.scJobDesc         || "not specified";
  const buyerName = biz?.sessionData?.scBuyerName       || "";
  const refNum    = "BK-" + Date.now().toString(36).toUpperCase().slice(-6);

  if (biz) { biz.sessionState = "ready"; await saveBiz(biz); }

  try {
    const { sendText: _st } = await import("./metaSender.js");
    await _st(seller.phone,
`📅 New service booking on ZimQuote.

Reference: ${refNum}
Buyer: ${buyerName || _normPhone(from)}
Location: ${location}
Job: ${jobDesc}
Preferred time: ${raw}

Contact buyer to confirm.`
    );
  } catch (e) { /* ignore */ }

  return sendButtons(from, {
    text:
`✅ *Booking request sent - ${refNum}*

${seller.businessName}
📍 Location: ${location}
🔧 Job: ${jobDesc}
📅 Preferred time: ${raw}

The seller will contact you to confirm and quote.
📞 ${seller.contactDetails || seller.phone}`,
    buttons: [
      { id: `sc_contact_${supplierId}`, title: "📞 Contact seller" },
      { id: `sc_back_${supplierId}`,    title: "⬅ Back to Seller" }
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
`🔄 *Repeat last order - ${seller.businessName}*

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

  const area = seller.location?.area || seller.area || "";
  const city = seller.location?.city || seller.city || "";

  return sendButtons(from, {
    text:
`📞 *Contact ${seller.businessName}*

Phone: *${seller.contactDetails || seller.phone}*
📍 ${[area, city].filter(Boolean).join(", ")}
${seller.address ? "\n" + seller.address : ""}`,
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
// SELLER PRICE REPLY HANDLER (legacy RFQ - seller replies with typed prices)
// ─────────────────────────────────────────────────────────────────────────────
export async function handleSellerPriceReply(from, text, biz, saveBiz) {
  const state = biz?.sessionState;
  if (state !== "sc_seller_awaiting_prices") return false;

  const pending = biz?.sessionData?.scPendingRFQ;
  if (!pending) return false;

  return _scProcessSellerPriceReply(from, pending.supplierId, text, biz, saveBiz);
}

async function _scProcessSellerPriceReply(from, supplierId, raw, biz, saveBiz) {
  const pending = biz?.sessionData?.scPendingRFQ;
  if (!pending) return false;

  const prices  = {};
  const matches = raw.matchAll(/(\d+)\s*[=×x@:]\s*(\d+(?:\.\d+)?)/gi);
  for (const m of matches) {
    prices[parseInt(m[1]) - 1] = parseFloat(m[2]);
  }

  if (!Object.keys(prices).length) {
    return sendText(from, "❌ Could not read prices. Format: 1=price, 2=price, 3=price\nExample: 1=2.50, 2=3.00, 3=15.00");
  }

  const items     = pending.items || [];
  const lineItems = items.map((item, i) => ({
    name:      item.name,
    qty:       item.qty || 1,
    unitPrice: prices[i] || 0,
    lineTotal: (prices[i] || 0) * (item.qty || 1)
  }));
  const total  = lineItems.reduce((s, l) => s + l.lineTotal, 0);
  const refNum = pending.refNum;
  const expiry = new Date(Date.now() + 48 * 3600 * 1000)
    .toLocaleDateString("en-GB", { day: "numeric", month: "short" });

  let pdfSent = false;
  try {
    const { generatePDF } = await import("../routes/twilio_biz.js");
    const seller = await SupplierProfile.findById(supplierId).lean();
    const site   = (process.env.SITE_URL || "").replace(/\/$/, "");

    const { filename } = await generatePDF({
      type:      "quote",
      number:    refNum,
      date:      new Date(),
      billingTo: pending.buyerName || _normPhone(pending.buyerPhone),
      items: lineItems.map(l => ({
        item:  l.name,
        qty:   Number(l.qty       || 1),
        unit:  Number(l.unitPrice || 0),
        total: Number(l.lineTotal || 0)
      })),
      bizMeta: {
        name:    seller?.businessName || "Seller",
        logoUrl: seller?.logoUrl || "",
        address: [
          seller?.address || "",
          seller?.location?.area || seller?.area || "",
          seller?.location?.city || seller?.city || ""
        ].filter(Boolean).join(", "),
        _id:    String(seller?._id || supplierId),
        status: "quotation"
      }
    });

    const pdfLink = `${site}/docs/generated/quotes/${filename}`;
    await sendDocument(_normPhone(pending.buyerPhone), { link: pdfLink, filename });
    pdfSent = true;
    console.log(`[SC RFQ PDF] ${filename} → ${_normPhone(pending.buyerPhone)}`);
  } catch (pdfErr) {
    console.warn(`[SC RFQ PDF] failed: ${pdfErr.message}`);
  }

  const itemRows = lineItems.map(l =>
    `${l.name} × ${l.qty} @ $${l.unitPrice.toFixed(2)} = $${l.lineTotal.toFixed(2)}`
  ).join("\n");

  try {
    const { sendText: _st } = await import("./metaSender.js");
    await _st(_normPhone(pending.buyerPhone),
`💵 *Your quote is ready - ${refNum}*

${itemRows}
${"─".repeat(28)}
*Total: $${total.toFixed(2)} USD*
Valid until: ${expiry}

${pdfSent ? "PDF sent above - tap to open." : ""}`
    );
  } catch (e) { /* ignore */ }

  if (biz) { biz.sessionState = "ready"; await saveBiz(biz); }

  return sendText(from,
`✅ Quote ${refNum} sent to buyer.
Total: $${total.toFixed(2)}${pdfSent ? "\nPDF delivered to buyer." : ""}`
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────
function _parseItemInput(raw, knownItems = [], isService = false) {
  const results = [];

  // Numbered format: "1×50, 2×10" or "1=50, 2=10"
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
      const nameCandidate = qtyMatch[1].trim();
      const qtyCandidate  = parseFloat(qtyMatch[2]);
      const isNameFirst   = isNaN(parseFloat(nameCandidate));
      results.push({
        name:  isNameFirst ? nameCandidate : qtyMatch[2].trim(),
        qty:   isNameFirst ? qtyCandidate  : parseFloat(nameCandidate) || 1,
        price: 0
      });
    } else {
      results.push({ name: part, qty: 1, price: 0 });
    }
  }
  return results;
}s