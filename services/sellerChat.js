// services/sellerChat.js  v3.1
// ─── ZimQuote Seller Chatbot - Quote, Order, Smart Booking, Enquiry ───────────
//
// Full buyer interaction flow when a buyer opens a seller's ZimQuote smart link.
//
// KEY IMPROVEMENTS IN v3:
//   • Profile shows top 5 items with "X more - tap Get Quote to see all" hint
//   • Quote flow: full numbered catalogue → buyer picks by number×qty → cart review
//     → seller notified via Meta template (outside 24hr) → PDF quote sent to buyer
//   • Correct terminology: services use "service/book/rate/job", products use
//     "product/order/price/each" - never mixed
//   • Intelligent booking: travelAvailable=true → seller comes to YOU (ask YOUR address)
//                          travelAvailable=false → YOU go to seller (show their address)
//   • Seller notifications for quotes/bookings use Meta template (outside 24hr window)
//   • PDF quotation sent to buyer after seller approves (both priced + RFQ paths)
//   • Urgent booking button - buyer can skip date/time typing
//
// QUOTE FLOWS:
//   PRICED: Full catalogue → buyer picks → cart → seller approves → PDF to buyer
//   RFQ:    Free text list → seller gets template → seller prices → PDF to buyer
//
// BOOKING FLOWS:
//   PATH A (seller travels): services → YOUR location → date/time [→ Urgent btn]
//   PATH B (client visits):  services/job desc → date/time [→ Urgent btn]
//
// Wire in chatbotEngine.js (sc_ prefix already handled globally):
//   if (a.startsWith("sc_"))        return handleSellerChatAction(...)
//   if (state?.startsWith("sc_"))   return handleSellerChatState(...)

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
// ─────────────────────────────────────────────────────────────────────────────
// NOTIFY SELLER - someone opened their smart link
// ─────────────────────────────────────────────────────────────────────────────
// UTILITY notification (not marketing) - triggered by user action, not ZimQuote blast.
// Compare to: bank transaction alerts, "someone viewed your listing" notifications.
//
// Strategy:
//   1. Try sendButtons first (within 24hr WhatsApp session window)
//   2. Fall back to supplier_new_buyer_request template (already approved, utility)
//
// NEW TEMPLATE to submit to Meta (optional improvement, recommended):
//   Name:     supplier_link_opened
//   Category: UTILITY  ← IMPORTANT: submit as UTILITY not MARKETING
//   Body:
//     👁 Someone opened your ZimQuote profile!
//     Business: {{1}}
//     Via: {{2}}
//     Time: {{3}}
//     They can request a quote, book, or send an enquiry directly.
//     Type *menu* to see your store.
//     This is an automated activity alert from ZimQuote.
//   WHY UTILITY: triggered by buyer action on seller's account (not promotional content).
//
async function _notifySellerLinkOpened(seller, buyerPhone, source) {
  try {
    const sourceLabels = {
      fb: "Facebook", wa: "WhatsApp Status", tt: "TikTok",
      qr: "QR Code scan", sms: "SMS / Flyer", ig: "Instagram",
      yt: "YouTube", direct: "Direct link", whatsapp_link: "WhatsApp link"
    };
    const sourceLabel = sourceLabels[source] || "ZimQuote link";
    const timeStr     = new Date().toLocaleString("en-GB", {
      day: "numeric", month: "short", hour: "2-digit", minute: "2-digit"
    });
    const sellerPhone = _normPhone(seller.phone);

    const PHONE_ID = process.env.WHATSAPP_PHONE_NUMBER_ID || process.env.META_PHONE_NUMBER_ID || process.env.PHONE_NUMBER_ID;
    const TOKEN    = process.env.META_ACCESS_TOKEN || process.env.WHATSAPP_ACCESS_TOKEN;
    const axios    = (await import("axios")).default;

    // ── Try dedicated supplier_link_opened template (UTILITY - works outside 24hr) ──
    // Submit to Meta as UTILITY with body:
    //   👁 Someone just opened your ZimQuote profile!
    //   Business: {{1}}
    //   Via: {{2}}
    //   Time: {{3}}
    //   They can request a quote, book, or send an enquiry directly.
    //   Type *menu* to see your store.
    //   This is an automated activity alert from ZimQuote.
    try {
      await axios.post(
        `https://graph.facebook.com/v24.0/${PHONE_ID}/messages`,
        {
          messaging_product: "whatsapp",
          to:   sellerPhone,
          type: "template",
          template: {
            name: "supplier_link_opened",
            language: { code: "en" },
            components: [{
              type: "body",
              parameters: [
                { type: "text", text: seller.businessName || "Your business" },
                { type: "text", text: sourceLabel },
                { type: "text", text: timeStr }
              ]
            }]
          }
        },
        { headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" } }
      );
      console.log(`[SMART LINK NOTIFY] supplier_link_opened → ${sellerPhone} (via ${sourceLabel})`);
      return;
    } catch (templateErr) {
      // Template not yet approved or not submitted - fall through to sendButtons
      console.warn(`[SMART LINK NOTIFY] supplier_link_opened template failed (${templateErr.message}), trying sendButtons`);
    }

    // ── Fallback: sendButtons (within 24hr session only) ────────────────────
    await sendButtons(sellerPhone, {
      text:
        `👁 *Someone just opened your ZimQuote profile!*\n\n` +
        `📱 Via: ${sourceLabel}\n` +
        `⏰ ${timeStr}\n\n` +
        `They can see your services, request a quote, or book directly.\n\n` +
        `💡 _Tip: Keep your services and rates updated so visitors convert._`,
      buttons: [
        { id: "my_supplier_account", title: "🏪 My Store" },
        { id: "sup_request_sellers", title: "⚡ Marketplace" }
      ]
    });
  } catch (err) {
    // Non-critical - never rethrow
    console.warn("[SMART LINK NOTIFY]", err.message);
  }
}

export async function showSellerMenu(from, supplierId, biz, saveBiz, { source = "direct", parentName = "" } = {}) {
  const seller = await SupplierProfile.findById(supplierId).lean();
  if (!seller) return sendText(from, "❌ Seller profile not found. Please try again.");

  const isService  = seller.profileType === "service";
  const PREVIEW_MAX = 5; // Items shown on profile card (teaser only - full list via View Catalogue button)

  // ── Build services/products sample (max PREVIEW_MAX shown on card) ────────
  // Fall through: rates → listedProducts → products - always show something real.
  let productSample = "";
  if (isService) {
    const hasRates = Array.isArray(seller.rates) && seller.rates.length > 0;
    if (hasRates) {
      productSample = seller.rates.slice(0, PREVIEW_MAX)
        .map(r => `• ${r.service}${r.rate ? "  -  " + r.rate : ""}`)
        .join("\n");
    } else {
      const serviceList = (seller.listedProducts?.length ? seller.listedProducts : seller.products) || [];
      productSample = serviceList
        .filter(p => p && p !== "pending_upload")
        .slice(0, PREVIEW_MAX)
        .map(s => `• ${s}`)
        .join("\n");
    }
  } else {
    const priced = (seller.prices || []).filter(p => p.inStock !== false);
    if (priced.length) {
      productSample = priced.slice(0, PREVIEW_MAX)
        .map(p => `• ${p.product}${p.amount ? "  -  $" + Number(p.amount).toFixed(2) + "/" + (p.unit || "each") : ""}`)
        .join("\n");
    } else {
      const listed = (seller.listedProducts?.length ? seller.listedProducts : seller.products) || [];
      productSample = listed.filter(p => p && p !== "pending_upload").slice(0, PREVIEW_MAX).map(s => `• ${s}`).join("\n");
    }
  }

  const hasPrices = isService
    ? (Array.isArray(seller.rates) && seller.rates.length > 0)
    : (Array.isArray(seller.prices) && seller.prices.length > 0);

  // ── BUG FIX: Correct travel/delivery line ─────────────────────────────────
  // Service providers with travelAvailable=true TRAVEL TO CLIENTS.
  // NEVER show "Collection only" for a cleaning/plumbing/electrical service.
  let deliveryLine = "";
  if (isService) {
    if (seller.travelAvailable) {
      const svcArea = seller.serviceArea
        || [seller.location?.area, seller.location?.city].filter(Boolean).join(", ");
      deliveryLine = `🚗 Travels to clients · ${svcArea}`;
    } else {
      deliveryLine = `📍 Client visits provider · ${[seller.location?.area, seller.location?.city].filter(Boolean).join(", ")}`;
    }
  } else {
    if (seller.delivery?.available) {
      const rangeLabel = { area_only: "area only", city_wide: "citywide", nationwide: "nationwide" }[seller.delivery.range] || "";
      deliveryLine = `🚚 Delivery available${rangeLabel ? " · " + rangeLabel : ""}`;
    } else {
      deliveryLine = `🏠 Collection · ${[seller.location?.area, seller.location?.city].filter(Boolean).join(", ")}`;
    }
  }

  // ── Credibility signals ────────────────────────────────────────────────────
  const ratingStr = (seller.reviewCount || 0) > 0
    ? `⭐ ${Number(seller.rating).toFixed(1)}/5 (${seller.reviewCount} review${seller.reviewCount === 1 ? "" : "s"})` : "";
  const ordersStr = (seller.completedOrders || 0) > 0
    ? `✅ ${seller.completedOrders} job${seller.completedOrders === 1 ? "" : "s"} done` : "";
  const respMin   = seller.avgResponseMinutes;
  const respStr   = (respMin !== null && respMin !== undefined && respMin <= 240)
    ? `⚡ Replies ${respMin <= 5 ? "instantly" : respMin <= 30 ? "within 30 min" : "within a few hours"}` : "";
  const credLine  = [ratingStr, ordersStr, respStr].filter(Boolean).join("  ·  ");

  const area     = seller.location?.area || "";
  const city     = seller.location?.city || "";
  const location = [area, city].filter(Boolean).join(", ");

  // ── Store session context ─────────────────────────────────────────────────
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

  // ── Notify seller someone opened their link (non-blocking) ────────────────
  _notifySellerLinkOpened(seller, from, source).catch(() => {});

  // ── Track analytics (non-blocking) ───────────────────────────────────────
  import("./supplierSmartLink.js").then(({ trackLinkEvent }) =>
    trackLinkEvent(supplierId, { source, isConversion: false }).catch(() => {})
  ).catch(() => {});

  const hasHistory = biz?.sessionData?.scLastOrder;
  const repeatBtn  = hasHistory
    ? [{ id: `sc_repeat_${supplierId}`, title: "🔄 Repeat last order" }] : [];

  // ── Profile card ─────────────────────────────────────────────────────────
  // ── X more hint - tells buyer there's more and how to see it ─────────────
  const catalogueTotal = isService
    ? ((seller.rates?.length > 0 ? seller.rates : (seller.listedProducts || seller.products || [])).length)
    : ((seller.prices?.length > 0 ? seller.prices : (seller.listedProducts || seller.products || [])).length);
  const extraCount = Math.max(0, catalogueTotal - PREVIEW_MAX);
  // moreHint shown as text AND as a button below - button is the primary CTA
  const moreHint   = extraCount > 0
    ? `_...and ${extraCount} more - tap "View Full Catalogue" below_`
    : null;

  const profileCard = [
    `${isService ? "🔧" : "🏪"} *${seller.businessName}*${seller.verified ? " ✅" : ""}${seller.topSupplierBadge ? " 🏅" : ""}`,
    `📍 ${location}`,
    credLine || null,
    ``,
    isService ? `🛠 *Services offered:*` : `📦 *Products available:*`,
    productSample || `_(Contact seller for full list)_`,
    moreHint,
    ``,
    deliveryLine,
    seller.address        ? `🏠 ${seller.address}` : null,
    seller.contactDetails ? `📞 ${seller.contactDetails}` : null,
    seller.website        ? `🌐 ${seller.website}` : null,
  ].filter(l => l !== null).join("\n");

  await sendText(from, profileCard);

  // ── "View Full Catalogue" button - only shown when seller has more than PREVIEW_MAX ──
  const catalogueBtn = extraCount > 0
    ? [{ id: `sc_catalogue_${supplierId}`, title: `📋 View All ${isService ? "Services" : "Products"} (${catalogueTotal})` }]
    : [];

  if (isService) {
    return sendList(from, "What would you like to do?", [
      { id: `sc_quote_${supplierId}`,   title: hasPrices ? "💵 Get instant quote" : "💵 Request a quote" },
      ...catalogueBtn,
      { id: `sc_book_${supplierId}`,    title: "📅 Book a service" },
      { id: `sc_enquiry_${supplierId}`, title: "💬 Send an enquiry" },
      ...repeatBtn,
      { id: `sc_contact_${supplierId}`, title: "📞 Contact details" },
      { id: `sc_review_${supplierId}`,  title: "⭐ Leave a review" }
    ]);
  } else {
    return sendList(from, "What would you like to do?", [
      { id: `sc_quote_${supplierId}`,   title: hasPrices ? "💵 Get instant quote" : "💵 Request a quote" },
      ...catalogueBtn,
      { id: `sc_order_${supplierId}`,   title: "🛒 Place an order" },
      { id: `sc_enquiry_${supplierId}`, title: "💬 Send an enquiry" },
      ...repeatBtn,
      { id: `sc_contact_${supplierId}`, title: "📞 Contact details" },
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
    case "catalogue":       return _scCatalogue(from, supplierId, biz, saveBiz);
    case "book":            return _scBook(from, supplierId, biz, saveBiz);
    case "book_confirm":    return _scBookConfirm(from, supplierId, biz, saveBiz);
    case "book_urgent":     return _scBookUrgent(from, supplierId, biz, saveBiz);
    case "enquiry":         return _scEnquiry(from, supplierId, biz, saveBiz);
    case "smart_link":      return _scSmartLinkMenu(from, supplierId, biz, saveBiz);
    case "smart_link_share":return _scSmartLinkShareMenu(from, supplierId, biz, saveBiz);
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

  // ── Enquiry: buyer typed their message to seller ─────────────────────────
  if (state === "sc_awaiting_enquiry") {
    return _scProcessEnquiry(from, supplierId, raw, biz, saveBiz);
  }

  // ── Quote: buyer typed item numbers/names ────────────────────────────────
  if (state === "sc_awaiting_items") {
    return _scProcessItemList(from, supplierId, raw, biz, saveBiz);
  }

  // ── Order: buyer typed delivery address ──────────────────────────────────
  if (state === "sc_awaiting_address") {
    return _scProcessAddress(from, supplierId, raw, biz, saveBiz);
  }

  // ── Booking: buyer chose services (PATH A - seller travels) ────────────────
  if (state === "sc_awaiting_booking_service") {
    return _scProcessBookingService(from, supplierId, raw, biz, saveBiz);
  }

  // ── Booking: buyer typed preferred date/time ─────────────────────────────
  if (state === "sc_awaiting_booking_datetime") {
    return _scProcessBookingDateTime(from, supplierId, raw, biz, saveBiz);
  }

  // ── Booking: buyer typed job description (PATH B - client visits seller) ──
  if (state === "sc_awaiting_job_desc") {
    return _scProcessJobDescription(from, supplierId, raw, biz, saveBiz);
  }

  // ── Booking: buyer typed their location (PATH A step 2) ──────────────────
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
// VIEW FULL CATALOGUE
// ─────────────────────────────────────────────────────────────────────────────
// Triggered when buyer taps "📋 View All Services/Products (N)" button.
// Sends the complete numbered catalogue without starting a quote session.
// After viewing, buyer is shown the action menu again so they can request a quote.
//
// WHY A SEPARATE BUTTON:
//   Profile card shows 5 items max (keeps it clean and fast to load).
//   Buyer needs to see everything before deciding. This gives them the full picture
//   in one tap, then they can go to "Request a quote" knowing exactly what to pick.
// ─────────────────────────────────────────────────────────────────────────────
async function _scCatalogue(from, supplierId, biz, saveBiz) {
  const seller    = await SupplierProfile.findById(supplierId).lean();
  if (!seller) return false;

  const isService = seller.profileType === "service";

  // Build the full item list - same fallback chain as profile card
  let allItems = [];
  if (isService) {
    if (Array.isArray(seller.rates) && seller.rates.length > 0) {
      allItems = seller.rates;
    } else {
      const sl = (seller.listedProducts?.length ? seller.listedProducts : seller.products) || [];
      allItems = sl.filter(s => s && s !== "pending_upload").map(s => ({ service: s, rate: "" }));
    }
  } else {
    if (Array.isArray(seller.prices) && seller.prices.length > 0) {
      allItems = seller.prices.filter(p => p.inStock !== false);
    } else {
      const pl = (seller.listedProducts?.length ? seller.listedProducts : seller.products) || [];
      allItems = pl.filter(p => p && p !== "pending_upload").map(p => ({ product: p, amount: 0, unit: "each" }));
    }
  }

  const total = allItems.length;
  const CHUNK = 30;
  const hasPrices = isService
    ? (Array.isArray(seller.rates) && seller.rates.length > 0)
    : (Array.isArray(seller.prices) && seller.prices.length > 0);

  const header = `${isService ? "🛠" : "📦"} *${seller.businessName} - Full ${isService ? "Services" : "Catalogue"} (${total} ${isService ? "service" : "item"}${total === 1 ? "" : "s"})*`;

  // Send in chunks (handles sellers with 50+ items)
  for (let i = 0; i < total; i += CHUNK) {
    const chunk  = allItems.slice(i, i + CHUNK);
    const isLast = i + CHUNK >= total;
    const lines  = chunk.map((item, j) => {
      const idx      = i + j + 1;
      const name     = isService ? item.service : item.product;
      const priceStr = isService
        ? (item.rate ? `  -  ${item.rate}` : "")
        : (item.amount ? `  -  $${Number(item.amount).toFixed(2)}/${item.unit || "each"}` : "");
      return `${idx}. ${name}${priceStr}`;
    }).join("\n");

    if (i === 0) {
      await sendText(from, `${header}\n\n${lines}${isLast ? "" : "\n_(list continues...)_"}`);
    } else {
      await sendText(from, `${lines}${isLast ? "" : "\n_(list continues...)_"}`);
    }
  }

  // After showing full catalogue → show action menu so buyer can request a quote
  return sendButtons(from, {
    text: `Ready to request a quote or book a ${isService ? "service" : "product"}?`,
    buttons: [
      { id: `sc_quote_${supplierId}`, title: hasPrices ? "💵 Get instant quote" : "💵 Request a quote" },
      { id: isService ? `sc_book_${supplierId}` : `sc_order_${supplierId}`, title: isService ? "📅 Book a service" : "🛒 Place an order" },
      { id: `sc_back_${supplierId}`,  title: "⬅ Back" }
    ]
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// QUOTE FLOW
// ─────────────────────────────────────────────────────────────────────────────
// HOW IT WORKS:
//   PRICED (seller has rates/prices set):
//     1. Full catalogue sent to buyer in numbered list (all items, chunked 30/msg)
//     2. Buyer replies "1×2, 3×1, 5×3" (item# × qty) - or types item names
//     3. Cart summary shown with prices and total
//     4. Buyer taps "✅ Confirm & Send" → draft stored on seller session
//     5. Seller notified via Meta template (works outside 24hr window)
//     6. Seller taps "View & Quote" → confirms or edits prices
//     7. PDF quotation auto-generated and sent to buyer via sendDocument
//
//   UNPRICED (no rates/prices - RFQ mode):
//     1. Buyer lists services/items in free text
//     2. Seller notified via Meta template with item list
//     3. Seller replies with prices (1=50, 2=30)
//     4. PDF auto-generated and sent to buyer
//
// TERMINOLOGY: services use "service/rate/per job", products use "product/price/each"
// ─────────────────────────────────────────────────────────────────────────────
async function _scQuote(from, supplierId, biz, saveBiz) {
  const seller    = await SupplierProfile.findById(supplierId).lean();
  if (!seller) return false;

  const isService = seller.profileType === "service";

  // ── Full catalogue: rates[] for services, prices[] for products ───────────
  // Also fall back to listedProducts/products for services without rates set
  let allItems = [];
  let hasPrices = false;

  if (isService) {
    if (Array.isArray(seller.rates) && seller.rates.length > 0) {
      allItems  = seller.rates;
      hasPrices = true;
    } else {
      // Service provider without rates - use listedProducts as item names, go RFQ
      const serviceList = (seller.listedProducts?.length ? seller.listedProducts : seller.products) || [];
      allItems  = serviceList.filter(s => s && s !== "pending_upload").map(s => ({ service: s, rate: "" }));
      hasPrices = false;
    }
  } else {
    if (Array.isArray(seller.prices) && seller.prices.length > 0) {
      allItems  = seller.prices.filter(p => p.inStock !== false);
      hasPrices = true;
    } else {
      const productList = (seller.listedProducts?.length ? seller.listedProducts : seller.products) || [];
      allItems  = productList.filter(p => p && p !== "pending_upload").map(p => ({ product: p, amount: 0, unit: "each" }));
      hasPrices = false;
    }
  }

  // ── Store session with catalogue for item-number resolution ──────────────
  if (biz) {
    biz.sessionState = "sc_awaiting_items";
    biz.sessionData  = {
      ...(biz.sessionData || {}),
      scSellerId:      supplierId,
      scQuoteItems:    [],
      scRFQ:           !hasPrices,
      scCatalogue:     JSON.stringify(allItems),  // stored for item# lookup
      scCatalogueType: isService ? "service" : "product"
    };
    await saveBiz(biz);
  }

  const total = allItems.length;
  const CHUNK = 30;

  // ── Send full catalogue in chunks (handles 100+ item sellers) ────────────
  // Profile shows 5 items as teaser. Quote flow shows EVERYTHING.
  // This is the key UX improvement: buyer sees the full menu before choosing.
  for (let i = 0; i < total; i += CHUNK) {
    const chunk   = allItems.slice(i, i + CHUNK);
    const isFirst = i === 0;
    const isLast  = i + CHUNK >= total;

    const lines = chunk.map((item, j) => {
      const idx  = i + j + 1;
      const name = isService ? item.service : item.product;
      const priceStr = isService
        ? (item.rate ? `  -  ${item.rate}` : "  -  rate on request")
        : (item.amount ? `  -  $${Number(item.amount).toFixed(2)}/${item.unit || "each"}` : "  -  price on request");
      return `${idx}. ${name}${priceStr}`;
    }).join("\n");

    if (isFirst) {
      const header = hasPrices
        ? `${isService ? "🛠" : "📦"} *${seller.businessName} - ${isService ? "Services & Rates" : "Products & Prices"} (${total} ${isService ? "service" : "item"}${total === 1 ? "" : "s"})*`
        : `${isService ? "🛠" : "📦"} *${seller.businessName} - ${isService ? "Services" : "Products"} (${total} ${isService ? "service" : "item"}${total === 1 ? "" : "s"})*`;
      await sendText(from, `${header}\n\n${lines}${isLast ? "" : "\n_(continued in next message...)_"}`);
    } else {
      await sendText(from, `${lines}${isLast ? "" : "\n_(continued in next message...)_"}`);
    }
  }

  // ── Instructions - always sent last so buyer sees them ───────────────────
  // Build dynamic examples from the seller's actual items (first 2-3 items)
  // so the buyer never sees examples from a different industry.
  const _ex = (idx, item) => isService
    ? (item.service || item)
    : (item.product || item);

  if (hasPrices) {
    // Priced: show "number × qty" examples using real item numbers
    const ex1 = allItems[0] ? `1×1` : "1×1";
    const ex2 = allItems[2] ? `, 3×2` : (allItems[1] ? `, 2×1` : "");
    const exampleLine = `_e.g. ${ex1}${ex2}_`;

    const singleHint = allItems[0]
      ? `_${_ex(0, allItems[0])}_ → type *1×1*`
      : "";
    const multiHint = allItems[1]
      ? `_${_ex(0, allItems[0])} + ${_ex(1, allItems[1])}_ → type *1×1, 2×1*`
      : "";

    return sendText(from,
`📝 *Select what you need:*

Type *item number × quantity*, e.g:
${exampleLine}
${singleHint ? "\n" + singleHint : ""}${multiHint ? "\n" + multiHint : ""}

${isService
  ? "Qty = number of times / rooms / jobs needed."
  : "Qty = how many units you need."}

Type *done* when finished, or *cancel* to go back.`
    );

  } else if (isService) {
    // RFQ service - buyer picks by number, optionally adds scope
    // Build examples using the seller's actual service names
    const name1 = allItems[0] ? _ex(0, allItems[0]) : null;
    const name2 = allItems[1] ? _ex(1, allItems[1]) : null;
    const name3 = allItems[2] ? _ex(2, allItems[2]) : null;

    // Pick 1-2 realistic scope hints based on what the service is
    // (e.g. a cleaner gets "3-bed house", a plumber gets "blocked drain")
    const scopeHints = _guessServiceScopeHint(name1);

    const ex_single  = `_1_ - just pick service 1`;
    const ex_multi   = name2 ? `_1, 2_ - pick services 1 & 2` : null;
    const ex_scope1  = name1 ? `_1: ${scopeHints[0]}_ - service 1 + detail` : null;
    const ex_scope2  = name1 && name2 && scopeHints[1]
      ? `_1: ${scopeHints[0]}, 2: ${scopeHints[1]}_ - multiple with detail`
      : null;

    const examples = [ex_single, ex_multi, ex_scope1, ex_scope2]
      .filter(Boolean).join("\n");

    return sendText(from,
`📝 *Which services do you need?*

Type the *number(s)* from the list above.
Add details after a colon if needed.

${examples}

Type *done* when finished, or *cancel* to go back.`
    );

  } else {
    // RFQ product - numbers work, free text also accepted
    const name1 = allItems[0] ? _ex(0, allItems[0]) : null;
    const name2 = allItems[1] ? _ex(1, allItems[1]) : null;

    const ex_num  = name1 && name2 ? `_1, 3_ - pick by number` : `_1_ - pick by number`;
    const ex_text = name1 ? `_${name1} ×5_ - or type name + qty` : null;

    const examples = [ex_num, ex_text].filter(Boolean).join("\n");

    return sendText(from,
`📝 *Which products do you need?*

Type item *number(s)* from the list, or type the name + quantity.

${examples}

Include size or brand if needed.
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

  // ── Resolve items using stored catalogue (set in _scQuote) ────────────────
  // This allows buyer to type "1×2, 5×1" and get real item names + prices
  // even if they are mid-session and the seller has 80 items in their catalogue.
  let knownItems = [];
  try {
    const catalogueRaw = biz?.sessionData?.scCatalogue;
    if (catalogueRaw) knownItems = JSON.parse(catalogueRaw);
  } catch (_) {}
  if (!knownItems.length) {
    // Fallback: re-read from DB
    knownItems = isService
      ? (seller.rates?.length > 0 ? seller.rates : (seller.listedProducts || seller.products || []).map(s => ({ service: s, rate: "" })))
      : (seller.prices?.length > 0 ? seller.prices : (seller.listedProducts || seller.products || []).map(p => ({ product: p, amount: 0, unit: "each" })));
  }

  const existingItems = biz?.sessionData?.scQuoteItems || [];
  // For service RFQ, support "1: scope, 2: scope" shorthand (buyer types number + optional detail)
  let newItems;
  if (isRFQ && isService) {
    newItems = _parseServiceRFQInput(raw, knownItems);
  } else {
    newItems = _parseItemInput(raw, knownItems, isService);
  }
  const allItems      = [...existingItems, ...newItems];

  if (biz) {
    biz.sessionData = { ...(biz.sessionData || {}), scQuoteItems: allItems };
    await saveBiz(biz);
  }

  // ── Cart summary - show price per item if available ───────────────────────
  // Services: "1× deep cleaning - $50/job" or "1× deep cleaning - rate TBC"
  // Products: "50× 20mm pipe - $2.00/m" or "10× valve - price TBC"
  const priceMap = {};
  for (const item of knownItems) {
    const key = (isService ? item.service : item.product)?.toLowerCase().trim();
    if (key) priceMap[key] = isService ? (item.rate || "") : (item.amount ? `$${Number(item.amount).toFixed(2)}/${item.unit || "each"}` : "");
  }

  const summary = allItems.map(it => {
    const priceStr = priceMap[it.name?.toLowerCase().trim()];
    return priceStr
      ? `• ${it.qty}× ${it.name}  -  ${priceStr}`
      : `• ${it.qty}× ${it.name}`;
  }).join("\n");

  const termAdd     = isService ? "service" : "item";
  const termDone    = isRFQ ? "📤 Send Request" : (isService ? "✅ Get Service Quote" : "✅ Get Quote");

  return sendButtons(from, {
    text:
`🛒 *${isService ? "Services" : "Items"} selected (${allItems.length}):*
${summary}

Add more ${termAdd}s, or tap below when ready.`,
    buttons: [
      { id: `sc_quote_done_${supplierId}`,  title: termDone },
      { id: `sc_quote_clear_${supplierId}`, title: "🗑 Start Over" },
      { id: `sc_back_${supplierId}`,         title: "⬅ Back" }
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
        scLastRFQ: { refNum, supplierId, buyerPhone, buyerName, items, isService, timestamp: Date.now() }
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
`✅ *${isService ? "Service quote" : "Quote"} request sent to ${seller.businessName}!*

Reference: *${refNum}*
${isService ? "Services" : "Items"}: ${items.length} ${isService ? "service" : "item"}${items.length > 1 ? "s" : ""}

${itemList}

The seller will review and price your request.
📄 You will receive a PDF quotation on WhatsApp once the seller responds.

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
`⏳ *${isService ? "Service quote" : "Quote"} sent to ${seller.businessName} for approval*

Reference: *${refNum}*

${itemRows}
${"─".repeat(28)}
*Estimated total: $${total.toFixed(2)} USD*
Valid until: ${expiry}

The seller will approve or adjust prices.
📄 You will receive a *PDF quotation* on WhatsApp after the seller confirms.

📞 ${seller.contactDetails || seller.phone}`,
    buttons: [
      { id: `sc_back_${supplierId}`,    title: "⬅ Back to Seller" },
      { id: `sc_contact_${supplierId}`, title: "📞 Contact seller" }
    ]
  });
}

async function _scQuoteClear(from, supplierId, biz, saveBiz) {
  if (biz) {
    // Clear items but keep catalogue cache so we don't re-read DB
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
    isService: draft.isService || false,
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
`✅ *Quote ${refNum} approved and sent to buyer!*

${itemRows}
${"─".repeat(28)}
*Total: $${total.toFixed(2)} USD*

${pdfSent ? "📄 PDF quotation delivered to buyer." : "✅ Quote confirmed and sent to buyer."}
Valid until: ${expiry}`,
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
async function _sendBuyerQuoteNotification({ buyerPhone, sellerName, refNum, total, expiry, pdfSent = false, isService = false }) {
  try {
    await sendButtons(_normPhone(buyerPhone), {
      text:
`✅ *Your ${isService ? "service quote" : "quote"} is ready - ${refNum}*

From: *${sellerName}*
Total: *$${Number(total).toFixed(2)} USD*
Valid until: ${expiry}

${pdfSent ? "📄 PDF quotation sent above - tap to open and save." : "✅ Quote approved by seller."}

This quote is valid for 48 hours. Contact the seller to confirm your order.`,
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
// SERVICE BOOKING FLOW - INTELLIGENT & TRAVEL-AWARE
// ─────────────────────────────────────────────────────────────────────────────
//
// REAL-WORLD PROBLEM SOLVED:
//   In Zimbabwe, many service providers (cleaners, plumbers, electricians) travel
//   to the client's home or business. Others (mechanics, workshops) require the
//   client to come to them. The booking flow was treating all services identically.
//
//   A cleaning crew needs: YOUR address, what rooms, preferred date.
//   A mechanic workshop needs: what car problem, when will you bring it, their address.
//   These are fundamentally different conversations.
//
// PATH A - Seller travels to client (travelAvailable: true):
//   Step 1: Which services do you need? (numbered list from their catalogue)
//   Step 2: What is your location/address? (where should we come to?)
//   Step 3: Preferred date & time + urgency button
//   Step 4: Review summary → Confirm
//   Result: Seller gets BK notification via Meta template + full details
//
// PATH B - Client visits seller (travelAvailable: false):
//   Step 1: Shows seller's address upfront. Which services do you need?
//   Step 2: Describe the job (what's the problem / what do you need?)
//   Step 3: Preferred date & time
//   Step 4: Review summary → Confirm
//   Result: Seller gets BK notification via Meta template + full details
//
// SELLER NOTIFICATION: Uses Meta template (outside 24hr window).
// ─────────────────────────────────────────────────────────────────────────────
async function _scBook(from, supplierId, biz, saveBiz) {
  const seller = await SupplierProfile.findById(supplierId).lean();
  if (!seller) return false;

  const travels  = seller.travelAvailable !== false && seller.travelAvailable !== null;
  const area     = seller.location?.area || "";
  const city     = seller.location?.city || "";
  const location = [area, city].filter(Boolean).join(", ");

  // ── Build service list for step 1 ─────────────────────────────────────────
  const serviceList = seller.rates?.length > 0
    ? seller.rates.map((r, i) => `${i + 1}. ${r.service}${r.rate ? "  -  " + r.rate : ""}`)
    : ((seller.listedProducts || seller.products || []).filter(s => s && s !== "pending_upload")
        .map((s, i) => `${i + 1}. ${s}`));
  const serviceMenu = serviceList.slice(0, 20).join("\n");
  const totalSvcs   = serviceList.length;

  if (biz) {
    biz.sessionState = travels ? "sc_awaiting_booking_service" : "sc_awaiting_job_desc";
    biz.sessionData  = {
      ...(biz.sessionData || {}),
      scSellerId:      supplierId,
      scBookingTravels: travels,
      scServiceMenu:   JSON.stringify(seller.rates?.length > 0 ? seller.rates : (seller.listedProducts || seller.products || []).map(s => ({ service: s, rate: "" })))
    };
    await saveBiz(biz);
  }

  if (travels) {
    // PATH A: Seller comes to client - ask what service(s) first
    return sendText(from,
`📅 *Book a service - ${seller.businessName}*
🚗 _We come to you_

${serviceMenu}${totalSvcs > 20 ? "\n_(+ more services available)_" : ""}

Type the *number(s)* of the service(s) you need.
_e.g. "1" or "1, 3" or "2, 4: office block"_
_(Add a colon after the number for extra detail)_

Type *cancel* to go back.`
    );
  } else {
    // PATH B: Client visits seller - show their address first
    return sendText(from,
`📅 *Book a service - ${seller.businessName}*
📍 _${seller.address || location}_

${serviceMenu}${totalSvcs > 20 ? "\n_(+ more services available)_" : ""}

Type the *number(s)* of the service(s) you need.
_e.g. "1" or "1, 3" or "2: gearbox, 4: oil change"_

Type *cancel* to go back.`
    );
  }
}

// Stub for book_confirm (mirrors back to booking start)
async function _scBookConfirm(from, supplierId, biz, saveBiz) {
  return _scBook(from, supplierId, biz, saveBiz);
}

// ── PATH A step 1 → step 2: Buyer chose services, now ask their location ─────
async function _scProcessBookingService(from, supplierId, raw, biz, saveBiz) {
  if (biz) {
    biz.sessionState = "sc_awaiting_service_location";
    biz.sessionData  = { ...(biz.sessionData || {}), scBookingServices: raw };
    await saveBiz(biz);
  }

  // Resolve service names from input - supports:
  //   Numbers:           "1, 2, 4"  → resolved to service names
  //   Names:             "deep cleaning, carpet cleaning"  → kept as-is
  //   Mixed:             "1, carpet cleaning"  → numbers resolved, names kept
  let resolvedServices = raw.trim();
  try {
    const menu = JSON.parse(biz?.sessionData?.scServiceMenu || "[]");
    if (menu.length > 0) {
      // Split input by comma, process each part
      const parts = raw.split(/,\s*/);
      const resolved = parts.map(part => {
        const num = parseInt(part.trim(), 10);
        if (!isNaN(num) && num >= 1 && num <= menu.length) {
          // Number → look up service name
          return menu[num - 1].service || menu[num - 1] || part.trim();
        }
        return part.trim(); // keep as-is (name or description)
      }).filter(Boolean);
      if (resolved.length > 0) {
        resolvedServices = resolved.join(", ");
      }
    }
    if (biz) {
      biz.sessionData = { ...biz.sessionData, scBookingServices: resolvedServices };
      await saveBiz(biz);
    }
  } catch (_) {}

  return sendText(from,
`📍 *Where should we come to?*

${resolvedServices ? "Services: _" + resolvedServices + "_\n\n" : ""}Type your address or suburb.
_e.g. "15 Samora Machel Ave, Highfield" or "Borrowdale, Harare"_

Type *cancel* to go back.`
  );
}

// ── PATH A step 2 → step 3: Got location, now ask date/time ──────────────────
async function _scProcessServiceLocation(from, supplierId, raw, biz, saveBiz) {
  if (biz) {
    biz.sessionState = "sc_awaiting_booking_datetime";
    biz.sessionData  = { ...(biz.sessionData || {}), scServiceLocation: raw };
    await saveBiz(biz);
  }

  const services = biz?.sessionData?.scBookingServices || "";

  return sendButtons(from, {
    text:
`📅 *When would you like this done?*

${services ? "Services: _" + services + "_\n" : ""}Location: _${raw}_

Type your preferred date and time.
_e.g. "Saturday morning", "Any weekday after 3pm", "Monday 10am"_

Or tap Urgent if you need it done today or tomorrow.`,
    buttons: [
      { id: `sc_book_urgent_${supplierId}`, title: "⚡ Urgent - ASAP" },
    ]
  });
}

// ── PATH B: Job description (client visits seller) → then date/time ───────────
async function _scProcessJobDescription(from, supplierId, raw, biz, saveBiz) {
  if (biz) {
    biz.sessionState = "sc_awaiting_booking_datetime";
    biz.sessionData  = { ...(biz.sessionData || {}), scJobDesc: raw };
    await saveBiz(biz);
  }

  return sendButtons(from, {
    text:
`📅 *When will you bring it in / visit?*

Job: _${raw}_

Type your preferred date and time.
_e.g. "Tomorrow morning", "Saturday 9am", "Monday after 2pm"_

Or tap Urgent if you need it done today.`,
    buttons: [
      { id: `sc_book_urgent_${supplierId}`, title: "⚡ Urgent - Today/Tomorrow" }
    ]
  });
}

// ── Final booking step - date/time confirmed, submit ─────────────────────────
async function _scProcessBookingDateTime(from, supplierId, raw, biz, saveBiz) {
  const seller    = await SupplierProfile.findById(supplierId).lean();
  if (!seller) return false;

  const travels     = biz?.sessionData?.scBookingTravels !== false;
  const location    = biz?.sessionData?.scServiceLocation || "not specified";
  const jobDesc     = biz?.sessionData?.scJobDesc         || "";
  const services    = biz?.sessionData?.scBookingServices || jobDesc || "not specified";
  const buyerName   = biz?.sessionData?.scBuyerName       || "";
  const refNum      = "BK-" + Date.now().toString(36).toUpperCase().slice(-6);

  if (biz) { biz.sessionState = "ready"; await saveBiz(biz); }

  // ── Notify seller via Meta template (works outside 24hr window) ───────────
  const bookingDetails = travels
    ? `${services} at ${location}`
    : `${services}`;

  await _sendSellerNotification({
    sellerPhone:  seller.phone,
    refNum,
    buyerDisplay: buyerName || _normPhone(from),
    itemList:     `Service: ${services}\nLocation: ${travels ? location : seller.address || "at your premises"}\nTime: ${raw}`,
    itemCount:    1,
    total:        null,
    isRFQ:        true,
  });

  _trackConversion({ sessionData: { scSource: biz?.sessionData?.scSource, scSellerId: supplierId } });

  const area = seller.location?.area || "";
  const city = seller.location?.city || "";

  const isServiceType = seller.profileType === "service";

  return sendButtons(from, {
    text:
`✅ *Booking request sent - ${refNum}*

🏪 ${seller.businessName}
🔧 ${isServiceType ? "Services" : "Job"}: ${services}
📍 ${travels ? "Location: " + location : "At: " + (seller.address || [area, city].filter(Boolean).join(", "))}
📅 Preferred time: ${raw}

The seller will contact you to confirm and quote.
📞 ${seller.contactDetails || seller.phone}

_Keep your WhatsApp open - seller will respond here._`,
    buttons: [
      { id: `sc_contact_${supplierId}`, title: "📞 Contact seller" },
      { id: `sc_back_${supplierId}`,    title: "⬅ Back to Seller" }
    ]
  });
}


// ─────────────────────────────────────────────────────────────────────────────
// URGENT BOOKING - buyer taps "⚡ Urgent" instead of typing a date
// Skips date/time text entry, goes straight to booking confirmation
// ─────────────────────────────────────────────────────────────────────────────
async function _scBookUrgent(from, supplierId, biz, saveBiz) {
  return _scProcessBookingDateTime(from, supplierId, "URGENT - as soon as possible", biz, saveBiz);
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
// ENQUIRY FLOW
// ─────────────────────────────────────────────────────────────────────────────
// Buyer sends a free-text message directly to the seller.
// Works for any seller/service type - no rigid form, just a message.
//
// WHY THIS MATTERS IN ZIM CONTEXT:
// In Zimbabwe business is conversational. Buyers want to ask:
//   "Do you come to Mbare on Saturdays?"
//   "Do you have 15mm ball valves? I need 20."
//   "Can you do a 3-bed house? How much roughly?"
// This mirrors how business is done in the street markets and suburbs -
// conversation first, price negotiation second, deal third.
// No app needed, works on the cheapest Android or feature phone via WhatsApp.
// ─────────────────────────────────────────────────────────────────────────────
async function _scEnquiry(from, supplierId, biz, saveBiz) {
  const seller = await SupplierProfile.findById(supplierId).lean();
  if (!seller) return false;

  const isService = seller.profileType === "service";

  if (biz) {
    biz.sessionState = "sc_awaiting_enquiry";
    biz.sessionData  = { ...(biz.sessionData || {}), scSellerId: supplierId };
    await saveBiz(biz);
  }

  const hint = isService
    ? `_e.g. "Do you come to Mbare? How much for a 3-bed house clean?_\n_Are you available this Saturday morning?"_`
    : `_e.g. "Do you have 15mm ball valves in stock?"_\n_"What is the price for a bag of cement? Do you deliver to Highfield?"_`;

  return sendText(from,
`💬 *Send an enquiry to ${seller.businessName}*

Type your message or question below. Be as specific as you can.

${hint}

Type *cancel* to go back.`
  );
}

async function _scProcessEnquiry(from, supplierId, raw, biz, saveBiz) {
  const seller = await SupplierProfile.findById(supplierId).lean();
  if (!seller) return false;

  if (!raw || raw.trim().length < 2) {
    return sendText(from, "❌ Please type your message (at least a few words).");
  }

  if (biz) { biz.sessionState = "ready"; await saveBiz(biz); }

  const buyerDisplay = _normPhone(from);
  const sellerPhone  = _normPhone(seller.phone);
  const refNum       = "ENQ-" + Date.now().toString(36).toUpperCase().slice(-5);

  // ── Notify seller - try sendButtons (within 24hr), then template ─────────
  try {
    await sendButtons(sellerPhone, {
      text:
        `💬 *New enquiry via ZimQuote!*\n\n` +
        `📱 From: ${buyerDisplay}\n\n` +
        `_"${raw.slice(0, 400)}"_\n\n` +
        `Reply directly on WhatsApp to respond.`,
      buttons: [{ id: "my_supplier_account", title: "🏪 My Store" }]
    });
  } catch (_) {
    // Outside 24hr - use utility template
    try {
      const axios  = (await import("axios")).default;
      const PID    = process.env.WHATSAPP_PHONE_NUMBER_ID || process.env.META_PHONE_NUMBER_ID || process.env.PHONE_NUMBER_ID;
      const TOKEN  = process.env.META_ACCESS_TOKEN || process.env.WHATSAPP_ACCESS_TOKEN;
      await axios.post(
        `https://graph.facebook.com/v24.0/${PID}/messages`,
        {
          messaging_product: "whatsapp",
          to:   sellerPhone,
          type: "template",
          template: {
            name: "supplier_new_buyer_request",
            language: { code: "en" },
            components: [{
              type: "body",
              parameters: [
                { type: "text", text: refNum },
                { type: "text", text: buyerDisplay },
                { type: "text", text: String(raw).slice(0, 200) },
                { type: "text", text: "Buyer enquiry via ZimQuote Smart Link" }
              ]
            }]
          }
        },
        { headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" } }
      );
    } catch (tplErr) {
      console.warn(`[SC ENQUIRY] template failed for ${sellerPhone}: ${tplErr.message}`);
    }
  }

  _trackConversion(biz);

  return sendButtons(from, {
    text:
      `✅ *Enquiry sent to ${seller.businessName}!*\n\n` +
      `Your message:\n_"${raw.slice(0, 120)}"_\n\n` +
      `📞 ${seller.contactDetails || seller.phone}\n\n` +
      `The seller will reply on WhatsApp. You can also contact them directly.`,
    buttons: [
      { id: `sc_back_${supplierId}`,    title: "⬅ Back to Seller" },
      { id: `sc_contact_${supplierId}`, title: "📞 Contact details" }
    ]
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// SMART LINK MENU - shown to SELLERS from My Store → 📲 My Smart Link
// ─────────────────────────────────────────────────────────────────────────────
// WHY SELLERS NEED THIS IN ZIM:
//   Most sellers in Zimbabwe have never tracked where their customers come from.
//   They post on Facebook, share in WhatsApp groups, print flyers.
//   ZimQuote Smart Link tells them EXACTLY which platform is working.
//   That is game-changing for a seller spending $5/month on a listing -
//   they can double down on what works and stop wasting money on what doesn't.
//
// WHAT MAKES IT DIFFERENT:
//   vs WhatsApp Business: we reach outside 24hr window, auto-PDF quotes, analytics
//   vs Facebook page:     instant quoting, order management, no algorithm
//   vs a website:         costs $200+ to build, $15+/month to host. Our link is FREE.
//   Zim reality:          works on cheapest Android, WhatsApp already installed,
//                         no data-heavy app download, operates in a $1 bundle
// ─────────────────────────────────────────────────────────────────────────────
async function _scSmartLinkMenu(from, supplierId, biz, saveBiz) {
  const seller = await SupplierProfile.findById(supplierId).lean();
  if (!seller) return false;

  const { buildSmartLinkBenefitsCard, buildDeepLink } = await import("./supplierSmartLink.js");
  const card       = buildSmartLinkBenefitsCard(seller);
  const directLink = buildDeepLink(String(seller._id));

  await sendText(from, card);

  return sendButtons(from, {
    text:
      `🔗 *Your ZimQuote Link:*\n\n` +
      `${directLink}\n\n` +
      `Share this link anywhere. Buyers tap it and land straight on your profile. No app download, no website needed.`,
    buttons: [
      { id: `sc_smart_link_share_${supplierId}`, title: "📤 Get Share Captions" },
      { id: "my_supplier_account",                title: "🏪 Back to My Store" }
    ]
  });
}

async function _scSmartLinkShareMenu(from, supplierId, biz, saveBiz) {
  const seller = await SupplierProfile.findById(supplierId).lean();
  if (!seller) return false;

  const { buildSharableCaption, buildQrImageUrl } = await import("./supplierSmartLink.js");

  const waCap  = buildSharableCaption(seller, "wa");
  const fbCap  = buildSharableCaption(seller, "fb");
  const ttCap  = buildSharableCaption(seller, "tt");
  const smsCap = buildSharableCaption(seller, "sms");
  const qrUrl  = buildQrImageUrl(String(seller._id));

  // Send captions as a single message so seller can copy each section
  await sendText(from,
`📤 *Smart Link Sharing Kit - ${seller.businessName}*

─────────────────
📱 *WhatsApp Status caption:*
(Copy this and add to your status)

${waCap}

─────────────────
📘 *Facebook caption:*

${fbCap}

─────────────────
🎵 *TikTok bio:*

${ttCap}

─────────────────
📄 *SMS / Flyer text:*

${smsCap}

─────────────────
📸 *QR Code for printing:*
Open in your browser to download:
${qrUrl}

_Print this QR on your receipts, cards, and flyers._
_Customers scan it with their phone camera - no typing needed._

Each link is tracked. You will see which platform (Facebook, WhatsApp, TikTok, QR) brings the most buyers.`
  );

  return sendButtons(from, {
    text: `Tip: Post your WhatsApp Status link right now - it's the fastest way to get your first views tracked.`,
    buttons: [
      { id: `sc_smart_link_${supplierId}`, title: "📊 View My Stats" },
      { id: "my_supplier_account",          title: "🏪 Back to My Store" }
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
    await _sendBuyerQuoteNotification({
      buyerPhone: _normPhone(pending.buyerPhone),
      sellerName: "Seller",
      refNum,
      total,
      expiry,
      pdfSent,
      isService: !!pending.isService,
    });
  } catch (e) { console.warn("[SC RFQ BUYER NOTIF]", e.message); }

  if (biz) { biz.sessionState = "ready"; await saveBiz(biz); }

  return sendButtons(from, {
    text:
`✅ *Quote ${refNum} sent to buyer!*

Total: $${total.toFixed(2)} USD
${pdfSent ? "📄 PDF quotation delivered to buyer." : "✅ Quote sent to buyer."}`,
    buttons: [{ id: "my_supplier_account", title: "🏪 My Account" }]
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────
// ─── Guess realistic scope hints from a service name ─────────────────────────
// Returns 2 short scope examples tailored to what kind of service this is.
// Used so the buyer sees "1: blocked drain" not "1: 3-bed house" on a plumber's page.
function _guessServiceScopeHint(serviceName = "") {
  const s = serviceName.toLowerCase();

  if (/plumb|pipe|drain|tap|geyser|borehole|water|leak/.test(s))
    return ["blocked drain", "leaking pipe"];
  if (/electr|wiring|install|panel|socket|switch|fault/.test(s))
    return ["fault finding", "new socket"];
  if (/car|vehicle|auto|tyre|wheel|brake|engine|gearbox|service|oil/.test(s))
    return ["sedan", "oil change"];
  if (/roof|tile|ceiling|waterproof|gutter/.test(s))
    return ["leaking roof", "flat roof"];
  if (/paint|wall|interior|exterior|plaster/.test(s))
    return ["2-room interior", "full exterior"];
  if (/garden|lawn|grass|landscap|trim|hedge|tree/.test(s))
    return ["small yard", "large garden"];
  if (/pest|termite|mosquito|rodent|fumigat/.test(s))
    return ["3-bed house", "office block"];
  if (/weld|fabricat|gate|fence|steel|metal/.test(s))
    return ["burglar bars", "driveway gate"];
  if (/move|relocat|transport|deliver|truck/.test(s))
    return ["2-bed house", "office move"];
  if (/IT|computer|laptop|network|CCTV|camera|security/.test(s))
    return ["home network", "CCTV setup"];
  if (/tutor|lesson|teach|coach|train/.test(s))
    return ["Grade 7", "A-Level"];
  if (/cook|cater|food|meal|event/.test(s))
    return ["50 guests", "wedding"];
  if (/hair|salon|beauty|nail|makeup|spa/.test(s))
    return ["relaxer", "braids"];
  if (/sofa|upholster|furniture/.test(s))
    return ["2-seater sofa", "dining chairs"];

  // Default: cleaning (most common in ZW smart links)
  return ["3-bed house", "office block"];
}

// ─── Parse service RFQ input: "1, 3: 3-bed house, 5: office block" ──────────
// Supports:
//   "1"            → service 1, qty 1, no scope
//   "1, 3"         → services 1 and 3
//   "1: 3-bed house"  → service 1 with scope detail
//   "2: sofa, 4: carpet 3 rooms"  → multiple with scopes
//   Falls back gracefully to comma-split names if no numbers found
function _parseServiceRFQInput(raw, knownItems = []) {
  const results = [];

  // Split by comma, but not commas inside a scope clause (after the colon)
  // Strategy: split on ", " only when followed by a digit (next item number)
  const parts = raw.split(/,\s*(?=\d)/).map(s => s.trim()).filter(Boolean);

  for (const part of parts) {
    // Match: number optionally followed by colon + scope
    const m = part.match(/^(\d+)(?:\s*[:–\-]\s*(.+))?$/);
    if (m) {
      const idx   = parseInt(m[1], 10) - 1;
      const scope = (m[2] || "").trim();
      const item  = knownItems[idx];
      if (item) {
        const serviceName = item.service || String(item);
        results.push({
          name:  scope ? `${serviceName} (${scope})` : serviceName,
          qty:   1,
          price: parseFloat(item.rate) || 0
        });
      }
    } else {
      // Not a number - treat as typed service name
      results.push({ name: part, qty: 1, price: 0 });
    }
  }

  // If nothing resolved (e.g. buyer typed only names), fall back to name splitting
  if (!results.length) {
    return raw.split(/[,\n]+/).map(s => s.trim()).filter(Boolean)
      .map(name => ({ name, qty: 1, price: 0 }));
  }

  return results;
}

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
}