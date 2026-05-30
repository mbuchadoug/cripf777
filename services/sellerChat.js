// services/sellerChat.js  v3.2
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
import { notifyAllSupplierLinkOpened } from "./supplierNotifications.js";

const BOT_NUMBER = (process.env.WHATSAPP_BOT_NUMBER || "263771143904").replace(/\D/g, "");

// Normalize Zimbabwean phone to international format
function _normPhone(raw = "") {
  let p = String(raw).replace(/\D+/g, "");
  if (p.startsWith("0") && p.length === 10) p = "263" + p.slice(1);
  return p;
}

// ─── Draft map helpers ────────────────────────────────────────────────────────
// Drafts are stored as scPendingDrafts: { [refNum]: draftPayload } so a phone
// that is a notification contact for multiple sellers never has one draft
// overwrite another. Legacy scPendingSellerQuote scalar kept for backward compat.

async function _getSellerDraft(phone, refNum) {
  const UserSession = (await import("../models/userSession.js")).default;
  const sess = await UserSession.findOne({ phone: _normPhone(phone) }).lean();
  if (!sess) return null;

  // Try map first (new format)
  const _mapRaw = sess?.tempData?.scPendingDrafts;
  if (_mapRaw) {
    try {
      const _map = typeof _mapRaw === "string" ? JSON.parse(_mapRaw) : _mapRaw;
      const key = (refNum || "").toUpperCase();
      if (_map[key]) {
        const val = _map[key];
        return typeof val === "string" ? JSON.parse(val) : val;
      }
    } catch (_) {}
  }

  // Fallback: legacy scalar - only if refNum matches
  const _raw = sess?.tempData?.scPendingSellerQuote;
  if (!_raw) return null;
  try {
    const _draft = typeof _raw === "string" ? JSON.parse(_raw) : _raw;
    if (_draft && (_draft.refNum || "").toUpperCase() === (refNum || "").toUpperCase()) {
      return _draft;
    }
  } catch (_) {}
  return null;
}

async function _clearSellerDraft(phone, refNum) {
  const UserSession = (await import("../models/userSession.js")).default;
  const sess = await UserSession.findOne({ phone: _normPhone(phone) }).lean();
  let _draftsMap = {};
  try {
    const _raw = sess?.tempData?.scPendingDrafts;
    _draftsMap = _raw ? (typeof _raw === "string" ? JSON.parse(_raw) : _raw) : {};
  } catch (_) {}
  delete _draftsMap[(refNum || "").toUpperCase()];

  await UserSession.findOneAndUpdate(
    { phone: _normPhone(phone) },
    {
      $set:   { "tempData.scPendingDrafts": JSON.stringify(_draftsMap) },
      $unset: {
        "tempData.scPendingSellerQuote": "",
        "tempData.scSellerQuoteState":   "",
        "tempData.scBuyerPhone":         ""
      }
    },
    { upsert: true }
  );
}

// ─── No-biz sc session helpers ───────────────────────────────────────────────
// Buyers who have no Business record (not registered on the platform) still need
// to complete the quote flow.  We store their sc_ state in UserSession.tempData
// so the state machine can carry them through quote → items → done.
//
// Keys stored under tempData:
//   scState        - current state string, e.g. "sc_awaiting_items"
//   scSellerId     - 24-char supplier ObjectId
//   scQuoteItems   - JSON array of cart items
//   scRFQ          - boolean
//   scIsHospitality- boolean
//   scIsService    - boolean
//   scCatalogue    - JSON string of full catalogue (same as biz.sessionData.scCatalogue)
//   scCatalogueType- "service" | "product"
//   scTouristNote  - optional buyer note
//   scPeopleCount  - optional people/scope count

async function _getScNoBizSession(phone) {
  const UserSession = (await import("../models/userSession.js")).default;
  const sess = await UserSession.findOne({ phone: _normPhone(phone) }).lean();
  if (!sess?.tempData?.scState) return null;
  return sess.tempData;
}

async function _saveScNoBizSession(phone, data) {
  const UserSession = (await import("../models/userSession.js")).default;
  const updates = {};
  for (const [k, v] of Object.entries(data)) {
    updates[`tempData.${k}`] = v;
  }
  await UserSession.findOneAndUpdate(
    { phone: _normPhone(phone) },
    { $set: updates },
    { upsert: true }
  );
}

async function _clearScNoBizSession(phone) {
  const UserSession = (await import("../models/userSession.js")).default;
  await UserSession.findOneAndUpdate(
    { phone: _normPhone(phone) },
    {
      $unset: {
        "tempData.scState":         "",
        "tempData.scSellerId":      "",
        "tempData.scQuoteItems":    "",
        "tempData.scRFQ":           "",
        "tempData.scIsHospitality": "",
        "tempData.scIsService":     "",
        "tempData.scCatalogue":     "",
        "tempData.scCatalogueType": "",
        "tempData.scTouristNote":   "",
        "tempData.scPeopleCount":   ""
      }
    },
    { upsert: true }
  );
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
// DEPRECATED: superseded by notifyAllSupplierLinkOpened() from supplierNotifications.js
// Kept for reference only - no longer called. VIP phone reveal now handled centrally.
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

    const notifyPhones = [
  sellerPhone,
  ...((seller.notificationContacts || []).map(_normPhone))
].filter(Boolean);

const uniqueNotifyPhones = [...new Set(notifyPhones)];

    const PHONE_ID = process.env.WHATSAPP_PHONE_NUMBER_ID || process.env.META_PHONE_NUMBER_ID || process.env.PHONE_NUMBER_ID;
    const TOKEN    = process.env.META_ACCESS_TOKEN || process.env.WHATSAPP_ACCESS_TOKEN;
    const axios    = (await import("axios")).default;

    // ── Try dedicated supplier_link_opened template (UTILITY - works outside 24hr) ──
    // FIX: iterate over all notify phones for the template (targetPhone was undefined before)
    let _templateSentCount = 0;
    for (const targetPhone of uniqueNotifyPhones) {
      try {
        await axios.post(
          `https://graph.facebook.com/v24.0/${PHONE_ID}/messages`,
          {
            messaging_product: "whatsapp",
            to:   targetPhone,
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
        console.log(`[SMART LINK NOTIFY] supplier_link_opened → ${targetPhone} (via ${sourceLabel})`);
        _templateSentCount++;
      } catch (templateErr) {
        // Template not yet approved - fall through to sendButtons for this phone
      }
    }
    if (_templateSentCount > 0) return;

    // ── Fallback: sendButtons (within 24hr session only) ────────────────────
   for (const targetPhone of uniqueNotifyPhones) {
  await sendButtons(targetPhone, {
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
  }
  } catch (err) {
    // Non-critical - never rethrow
    console.warn("[SMART LINK NOTIFY]", err.message);
  }
}

export async function showSellerMenu(from, supplierId, biz, saveBiz, { source = "direct", parentName = "" } = {}) {
  const seller = await SupplierProfile.findById(supplierId).lean();
  if (!seller) return sendText(from, "❌ Seller profile not found. Please try again.");

  // ── FIX: Clear stale BuyerRequest seller-side state when a BUYER opens this
  // smart link. If the visitor is a SELLER who owns this profile, their BuyerRequest
  // state (awaiting_offer / awaiting_offer_intro) is NOT the buyer-facing sc_ flow,
  // so it should NOT be cleared here - they need that state to respond to requests.
  // We only clear if the visitor is NOT this seller (i.e. it's a buyer visiting).
  // Detection: if biz exists and biz is the supplier's own business, skip.
  try {
    const _fromPhone = String(from).replace(/\D+/g, "");
    const _sellerPhone = String(seller.phone || "").replace(/\D+/g, "");
    const _isOwnProfile = _fromPhone === _sellerPhone ||
      (seller.notificationContacts || []).some(nc => String(nc).replace(/\D+/g,"") === _fromPhone);

    if (!_isOwnProfile) {
      // This is a BUYER visiting the smart link - clear any residual sc_ biz state
      // that could have been left from a previous sc_ interaction, and ensure
      // the BuyerRequest state in UserSession doesn't bleed through.
      // We do NOT touch sellerRequestReplyState here - the seller's quote flow
      // is in a different UserSession (the seller's phone, not the buyer's).
      if (biz && biz.sessionState && biz.sessionState.startsWith("sc_") &&
          biz.sessionData?.scSellerId && biz.sessionData.scSellerId !== supplierId) {
        // Buyer was in a different seller's sc_ flow - reset to start fresh
        biz.sessionState = "ready";
        biz.sessionData  = {};
        if (saveBiz) await saveBiz(biz);
      }
    }
  } catch (_scCleanErr) {
    // Non-critical, never rethrow
  }

  const isHospitality = seller.profileType === "hospitality";
  const isService     = seller.profileType === "service";
  const PREVIEW_MAX = 5; // Items shown on profile card (teaser only - full list via View Catalogue button)

  // ── Build services/products sample (max PREVIEW_MAX shown on card) ────────
  // Fall through: rates → listedProducts → products - always show something real.
  let productSample = "";
  if (isHospitality) {
    // Hospitality: show room types with night + rest rates, then extra services
    const rooms = (seller.roomTypes || []).slice(0, PREVIEW_MAX);
    const extras = (seller.extraServices || []).slice(0, 2);
    const roomLines = rooms.map(rt => {
      const night = rt.pricePerNight > 0 ? "$" + Number(rt.pricePerNight).toFixed(0) + "/night" : null;
      const rest  = rt.restRate       > 0 ? "$" + Number(rt.restRate).toFixed(0)       + "/rest"  : null;
      const rates = [night, rest].filter(Boolean).join(" · ");
      return "• " + rt.name + (rates ? "  -  " + rates : "  -  price on request");
    });
    const extraLines = extras.map(es =>
      "• " + es.name + (es.price > 0 ? "  -  $" + Number(es.price).toFixed(0) + "/" + (es.unit || "service") : "")
    );
    productSample = [...roomLines, ...extraLines].join("\n");
  } else if (isService) {
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

  const hasPrices = isHospitality
    ? ((seller.roomTypes || []).some(rt => rt.pricePerNight > 0 || rt.restRate > 0))
    : isService
      ? (Array.isArray(seller.rates) && seller.rates.length > 0)
      : (Array.isArray(seller.prices) && seller.prices.length > 0);

  // ── Location helpers (must be declared before deliveryLine uses them) ───────
  const area     = seller.location?.area || "";
  const city     = seller.location?.city || "";
  const location = [area, city].filter(Boolean).join(", ");

  // ── BUG FIX: Correct travel/delivery line ─────────────────────────────────
  // Service providers with travelAvailable=true TRAVEL TO CLIENTS.
  // NEVER show "Collection only" for a cleaning/plumbing/electrical service.
  let deliveryLine = "";
  if (isHospitality) {
    deliveryLine = "📍 " + location + (seller.address ? " · " + seller.address : "");
  } else if (isService) {
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

  // ── Store session context ─────────────────────────────────────────────────
  if (biz) {
    biz.sessionData = {
      ...(biz.sessionData || {}),
      scSellerId:      supplierId,
      scIsService:     isService,
      scIsHospitality: isHospitality,
      scHasPrices:     hasPrices,
      scSource:    source,
      scBuyerName: parentName
    };
    if (saveBiz) await saveBiz(biz);
  }

  // ── Notify seller someone opened their link (non-blocking) ────────────────
  // Uses notifyAllSupplierLinkOpened so VIP sellers (revealVisitorPhone=true)
  // receive the visitor phone regardless of entry point (individual link, group link, slug, etc).
  notifyAllSupplierLinkOpened(seller, source, from).catch(() => {});

  // ── Track analytics (non-blocking) ───────────────────────────────────────
  import("./supplierSmartLink.js").then(({ trackLinkEvent }) =>
    trackLinkEvent(supplierId, { source, isConversion: false }).catch(() => {})
  ).catch(() => {});

  const hasHistory = biz?.sessionData?.scLastOrder;
  const repeatBtn  = hasHistory
    ? [{ id: `sc_repeat_${supplierId}`, title: "🔄 Repeat last order" }] : [];

  // ── Profile card ─────────────────────────────────────────────────────────
  // ── X more hint - tells buyer there's more and how to see it ─────────────
  // BUG FIX: listedProducts/prices can be empty arrays ([]) which are truthy,
  // so `arr || fallback` returns [] not the fallback. Must use .length checks.
  const catalogueTotal = isHospitality
    ? ((seller.roomTypes || []).length + (seller.extraServices || []).length + (seller.rates || []).length)
    : isService
      ? ((seller.rates?.length > 0
            ? seller.rates
            : (seller.listedProducts?.length > 0 ? seller.listedProducts : (seller.products || []))
         ).length)
      : ((seller.prices?.length > 0
            ? seller.prices
            : (seller.listedProducts?.length > 0 ? seller.listedProducts : (seller.products || []))
         ).length);
  const extraCount = Math.max(0, catalogueTotal - PREVIEW_MAX);
  // moreHint shown as text AND as a button below - button is the primary CTA
  const moreHint   = extraCount > 0
    ? `_...and ${extraCount} more - tap "View Full Catalogue" below_`
    : null;

  // Build profile card - hospitality uses dedicated layout
  let profileCard;
  if (isHospitality) {
    const FACILITY_LABELS = {
      wifi:"📶 WiFi", pool:"🏊 Pool", hot_shower:"🚿 Hot shower",
      breakfast:"🍳 Breakfast", en_suite:"🚪 En-suite", generator:"⚡ Generator/Solar",
      dstv:"📺 DSTV", braai:"🔥 Braai", aircon:"❄️ AC",
      game_drives:"🦁 Game drives", fishing:"🎣 Fishing", boat_hire:"⛵ Boat hire",
      conference:"🏢 Conference", restaurant:"🍽 Restaurant/Bar", laundry:"👕 Laundry",
      parking:"🅿️ Parking", pets_allowed:"🐕 Pets OK", child_friendly:"👶 Child-friendly"
    };
    const SUBTYPE_LABELS = {
      lodge:"🌿 Lodge", hotel:"🏨 Hotel", guesthouse:"🏡 Guesthouse/B&B",
      self_catering:"🍳 Self-Catering", campsite:"⛺ Campsite",
      safari_operator:"🦁 Safari Operator", tour_guide:"🗺 Tour Guide",
      boat_hire:"⛵ Boat Hire", travel_agency:"✈️ Travel Agency"
    };
    const subtypeLabel = (seller.tourismSubtype || []).map(s => SUBTYPE_LABELS[s] || s).join(" · ") || "🏨 Lodge / Hotel";
    const facilLine = (seller.facilities || []).slice(0, 8).map(f => FACILITY_LABELS[f] || f).join("  ·  ");
    const ciLine = (seller.checkInTime || seller.checkOutTime)
      ? "⏰ In: " + (seller.checkInTime || "?") + "  ·  Out: " + (seller.checkOutTime || "?") : "";

    profileCard = [
      "🏨 *" + seller.businessName + "*" + (seller.verified ? " ✅" : "") + (seller.topSupplierBadge ? " 🏅" : ""),
      subtypeLabel,
      "📍 " + location,
      credLine || null,
      "",
      "🛏 *Rooms & Rates:*",
      productSample || "_(Contact lodge for room availability)_",
      facilLine ? "\n🏷 *Facilities:*\n" + facilLine : null,
      ciLine || null,
      "",
      seller.address        ? "🏠 " + seller.address        : null,
      seller.contactDetails ? "📞 " + seller.contactDetails : null,
    ].filter(l => l !== null).join("\n");
  } else {
  profileCard = [
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
  } // end else (non-hospitality)

  await sendText(from, profileCard);

  // ── "View Full Catalogue" button - only shown when seller has more than PREVIEW_MAX ──
  const catalogueBtn = extraCount > 0
    ? [{ id: `sc_catalogue_${supplierId}`, title: `📋 View All ${isService ? "Services" : "Products"} (${catalogueTotal})` }]
    : [];

  if (isHospitality) {
    return sendList(from, "What would you like to do?", [
      { id: `sc_quote_${supplierId}`,   title: hasPrices ? "💵 Get a quote / Book" : "💵 Request a quote" },
      ...catalogueBtn,
      { id: `sc_book_${supplierId}`,    title: "📅 Book / Reserve" },
      { id: `sc_enquiry_${supplierId}`, title: "💬 Send an enquiry" },
      ...repeatBtn,
      { id: `sc_contact_${supplierId}`, title: "📞 Contact details" },
      { id: `sc_review_${supplierId}`,  title: "⭐ Leave a review" }
    ]);
  } else if (isService) {
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

  // ── Resolve supplierId: prefer biz.sessionData, fall back to UserSession ──
  // No-biz buyers (unregistered users) have their sc_ state in UserSession.
  let supplierId = biz?.sessionData?.scSellerId;
  let _noBizSess = null;
  let _usingNoBizSess = false;
  if (!supplierId) {
    _noBizSess = await _getScNoBizSession(from);
    supplierId = _noBizSess?.scSellerId;
    _usingNoBizSess = !!supplierId;
  }
  if (!supplierId) return false;

  // ── For no-biz users, synthesize a biz-like object from UserSession ───────
  // This lets all downstream functions (which read biz.sessionData.scXxx) work
  // without modification.  We intercept saveBiz to write back to UserSession.
  if (_usingNoBizSess && !biz) {
    const _sess    = _noBizSess;
    let   _sd      = {
      scSellerId:      _sess.scSellerId,
      scQuoteItems:    (() => { try { return typeof _sess.scQuoteItems === "string" ? JSON.parse(_sess.scQuoteItems) : (_sess.scQuoteItems || []); } catch(_){return [];} })(),
      scRFQ:           _sess.scRFQ === true || _sess.scRFQ === "true",
      scIsHospitality: _sess.scIsHospitality === true || _sess.scIsHospitality === "true",
      scIsService:     _sess.scIsService === true || _sess.scIsService === "true",
      scCatalogue:     _sess.scCatalogue || "",
      scCatalogueType: _sess.scCatalogueType || "product",
      scTouristNote:   _sess.scTouristNote || "",
      scPeopleCount:   _sess.scPeopleCount || ""
    };
    const _virtualBiz = {
      sessionState: state,
      sessionData:  _sd
    };
    const _virtualSaveBiz = async (vb) => {
      const sd = vb.sessionData || {};
      await _saveScNoBizSession(from, {
        scState:         vb.sessionState || "ready",
        scSellerId:      sd.scSellerId      || supplierId,
        scQuoteItems:    JSON.stringify(sd.scQuoteItems    || []),
        scRFQ:           sd.scRFQ           || false,
        scIsHospitality: sd.scIsHospitality || false,
        scIsService:     sd.scIsService     || false,
        scCatalogue:     sd.scCatalogue     || "",
        scCatalogueType: sd.scCatalogueType || "product",
        scTouristNote:   sd.scTouristNote   || "",
        scPeopleCount:   sd.scPeopleCount   || ""
      });
    };
    // Clear no-biz session when returning to "ready"
    const _wrappedSaveBiz = async (vb) => {
      if (!vb.sessionState || vb.sessionState === "ready") {
        await _clearScNoBizSession(from);
      } else {
        await _virtualSaveBiz(vb);
      }
    };
    return handleSellerChatState({ state, from, text, biz: _virtualBiz, saveBiz: _wrappedSaveBiz });
  }

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

  // ── Quote: people count for RFQ services ───────────────────────────────
  if (state === "sc_awaiting_quote_people") {
    const peopleText = raw.toLowerCase() === "skip" ? "" : raw.trim();
    if (biz) {
      if (peopleText) biz.sessionData = { ...(biz.sessionData || {}), scPeopleCount: peopleText };
      await saveBiz(biz);
    }
    return _scQuoteDone(from, supplierId, biz, saveBiz);
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

  // ── Booking: buyer typed number of people ────────────────────────────────
  if (state === "sc_awaiting_people_count") {
    return _scProcessPeopleCount(from, supplierId, raw, biz, saveBiz);
  }

  // ── Booking: PATH B - buyer chose services (client visits seller) ─────────
  if (state === "sc_awaiting_booking_service_b") {
    return _scProcessBookingServicePathB(from, supplierId, raw, biz, saveBiz);
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

  const isHospitality = seller.profileType === "hospitality";
  const isService     = seller.profileType === "service";

  // ── Full catalogue ─────────────────────────────────────────────────────────
  let allItems = [];
  let hasPrices = false;

  if (isHospitality) {
    // Hospitality: split each roomType into SEPARATE overnight and rest/day-use items.
    // This lets buyers select ONLY the rate they want (e.g. rest only, or night only).
    // A room with both pricePerNight and restRate becomes TWO numbered catalogue entries.
    const roomItems = (seller.roomTypes || []).flatMap(rt => {
      const items = [];
      if (rt.pricePerNight > 0) {
        items.push({
          service:    rt.name + " (overnight)",
          rate:       "$" + Number(rt.pricePerNight).toFixed(0) + "/night",
          _unitPrice: Number(rt.pricePerNight),
          _unit:      "night",
          _isRoom:    true,
          _rateType:  "night"
        });
      }
      if (rt.restRate > 0) {
        items.push({
          service:    rt.name + " (rest/day use)",
          rate:       "$" + Number(rt.restRate).toFixed(0) + "/rest",
          _unitPrice: Number(rt.restRate),
          _unit:      "rest",
          _isRoom:    true,
          _rateType:  "rest"
        });
      }
      // Room with no prices at all - keep as single unpriced entry
      if (!rt.pricePerNight && !rt.restRate) {
        items.push({ service: rt.name, rate: "", _isRoom: true, _unitPrice: 0, _unit: "night" });
      }
      return items;
    });
    const extraItems = (seller.extraServices || []).map(es => ({
      service:    es.name,
      rate:       es.price > 0 ? "$" + Number(es.price).toFixed(0) + "/" + (es.unit || "service") : "",
      _unitPrice: Number(es.price) || 0,
      _unit:      es.unit || "service",
      _isExtra:   true
    }));
    const activityItems = (seller.rates || []).map(r => ({
      service:    r.service,
      rate:       r.rate || "",
      _unitPrice: _parseServiceRateValue(r.rate),
      _unit:      _parseServiceRateUnit(r.rate, r.service)
    }));
    allItems  = [...roomItems, ...extraItems, ...activityItems];
    hasPrices = allItems.some(i => i.rate && i.rate.length > 0);
  } else if (isService) {
    if (Array.isArray(seller.rates) && seller.rates.length > 0) {
      allItems  = seller.rates;
      hasPrices = true;
    } else {
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
      scIsHospitality: isHospitality,
      scCatalogue:     JSON.stringify(allItems),
      scCatalogueType: (isHospitality || isService) ? "service" : "product"
    };
    await saveBiz(biz);
  } else {
    // No-biz buyer: persist sc_ state in UserSession so typed replies are routed correctly
    await _saveScNoBizSession(from, {
      scState:         "sc_awaiting_items",
      scSellerId:      supplierId,
      scQuoteItems:    JSON.stringify([]),
      scRFQ:           !hasPrices,
      scIsHospitality: isHospitality,
      scIsService:     isService,
      scCatalogue:     JSON.stringify(allItems),
      scCatalogueType: (isHospitality || isService) ? "service" : "product"
    });
  }

  const total = allItems.length;
  const CHUNK = 30;

  for (let i = 0; i < total; i += CHUNK) {
    const chunk   = allItems.slice(i, i + CHUNK);
    const isFirst = i === 0;
    const isLast  = i + CHUNK >= total;

    const lines = chunk.map((item, j) => {
      const idx  = i + j + 1;
      const name = (isHospitality || isService) ? item.service : item.product;
      const priceStr = (isHospitality || isService)
        ? (item.rate ? "  -  " + item.rate : "  -  price on request")
        : (item.amount ? "  -  $" + Number(item.amount).toFixed(2) + "/" + (item.unit || "each") : "  -  price on request");
      return idx + ". " + name + priceStr;
    }).join("\n");

    if (isFirst) {
      const headerIcon = isHospitality ? "🏨" : (isService ? "🛠" : "📦");
      const headerType = isHospitality
        ? ((seller.roomTypes || []).length > 0 && ((seller.extraServices || []).length > 0 || (seller.rates || []).length > 0)
            ? "Rooms, Activities & Services"
            : (seller.roomTypes || []).length > 0 ? "Rooms & Accommodation" : "Activities & Services")
        : (isService ? "Services & Rates" : "Products & Prices");
      const itemWord   = isHospitality ? "option" : (isService ? "service" : "item");
      const header = headerIcon + " *" + seller.businessName + " - " + headerType + " (" + total + " " + itemWord + (total === 1 ? "" : "s") + ")*";
      await sendText(from, header + "\n\n" + lines + (isLast ? "" : "\n_(continued...)_"));
    } else {
      await sendText(from, lines + (isLast ? "" : "\n_(continued...)_"));
    }
  }

  // ── Hospitality instructions prompt ──────────────────────────────────────
  if (isHospitality) {
    // Build a quick-reference reminder of first 4 items so buyer doesn't
    // have to scroll back up to check what number maps to what.
    const _hospRefLines = allItems.slice(0, 4).map((item, i) => {
      const _rateStr = item.rate ? `  -  ${item.rate}` : `  -  price on request`;
      return `${i + 1}. ${item.service}${_rateStr}`;
    }).join("\n");
    const _hospRefSuffix = allItems.length > 4
      ? `\n_...scroll up for full list (${allItems.length} total)_`
      : "";

    // Build concrete examples using the supplier's actual item names
    // Show up to 3 real items so the buyer sees familiar names, not abstract labels.
    // Pick items that represent different service types where possible.
    const ex1 = allItems[0]?.service || "Double Room";
    const ex2 = allItems[3]?.service || allItems[1]?.service || null; // prefer a non-room item
    const ex3 = allItems[4]?.service || allItems[2]?.service || null; // e.g. Boat Cruise / tour

    const exLines = [
      `_1_ → ${ex1}`,
      ex2 ? `_4_ → ${ex2}` : null,
      ex3 ? `_5_ → ${ex3}` : null,
      ex2 ? `_1×2, 4_ → ${ex1} for 2 nights + ${ex2}` : `_1×2_ → ${ex1} for 2 nights`,
    ].filter(Boolean).join("\n");

    return sendButtons(from, {
      text:
        `🏨 *Select what you need:*\n\n` +
        `📌 *Quick reference:*\n${_hospRefLines}${_hospRefSuffix}\n\n` +
        `Type the *number(s)* of what you need.\n\n` +
        `*Examples:*\n${exLines}\n\n` +
        `You can mix and match, e.g. _1×3, 4, 6_\n\n` +
        `Type *done* when ready.\n` +
        `Type *cancel* to go back.`,
      buttons: [{ id: `sc_enquiry_${supplierId}`, title: "💬 Enquiry" }]
    });
  }

  // ── Instructions - always sent last so buyer sees them ───────────────────
  // Build dynamic examples from the seller's actual items (first 2-3 items)
  // so the buyer never sees examples from a different industry.
  const _ex = (idx, item) => isService
    ? (item.service || item)
    : (item.product || item);

  // ── Quick-reference: repeat the first 3 items inline so the buyer doesn't
  // have to scroll back up to check what number maps to what service/product.
  const _qrLines = allItems.slice(0, 3).map((item, i) => {
    const name = (isHospitality || isService) ? item.service : item.product;
    const price = (isHospitality || isService)
      ? (item.rate ? "  " + item.rate : "")
      : (item.amount ? "  $" + Number(item.amount).toFixed(2) + "/" + (item.unit || "each") : "");
    return `${i + 1}. ${name}${price}`;
  }).join("\n");
  const _qrSuffix = allItems.length > 3
    ? `\n_...scroll up for full list (${allItems.length} total)_`
    : "";
  const _quickRef = `📌 *Quick reference:*\n${_qrLines}${_qrSuffix}\n\n`;

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

${_quickRef}Type *item number × quantity*, e.g:
${exampleLine}
${singleHint ? "\n" + singleHint : ""}${multiHint ? "\n" + multiHint : ""}

${isService
  ? "Qty = number of times / jobs needed."
  : "Qty = how many units you need."}

Type *done* when finished, or *cancel* to go back.`
    );

  } else if (isService) {
    // RFQ service - buyer picks by number, optionally adds scope
    // Build examples using the seller's actual service names
    const name1 = allItems[0] ? _ex(0, allItems[0]) : null;
    const name2 = allItems[1] ? _ex(1, allItems[1]) : null;

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

${_quickRef}Type the *number(s)* from the list above.
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

${_quickRef}Type item *number(s)* from the list, or type the name + quantity.

${examples}

Include size or brand if needed.
Type *done* when finished, or *cancel* to go back.`
    );
  }
}

async function _scProcessItemList(from, supplierId, raw, biz, saveBiz) {
  const seller = await SupplierProfile.findById(supplierId).lean();
  if (!seller) return false;

  const isService     = seller.profileType === "service";
  const isHospitality = seller.profileType === "hospitality";
  const isRFQ         = biz?.sessionData?.scRFQ;

  // ── Handle "note: ..." - tourist adds context/details without leaving the flow ──
  const _noteMatch = raw.match(/^note[:\s]+(.+)/i);
  if (_noteMatch) {
    const touristNote = _noteMatch[1].trim().slice(0, 300);
    if (biz) {
      biz.sessionData = { ...(biz.sessionData || {}), scTouristNote: touristNote };
      await saveBiz(biz);
    }
    const existingCart = biz?.sessionData?.scQuoteItems || [];
    if (existingCart.length === 0) {
      return sendText(from,
        `📝 Note saved: _"${touristNote}"_\n\n` +
        `Now type the item numbers you want from the list above, then type *done* to send.`
      );
    }
    return sendButtons(from, {
      text:
        `📝 Note added: _"${touristNote}"_\n\n` +
        `🛒 *Selected (${existingCart.length}):*\n` +
        existingCart.map(it => `• ${it.qty}× ${it.name}`).join("\n") + `\n\n` +
        `Type more item numbers, or tap *Get Quote* to send your request.`,
      buttons: [
        { id: `sc_quote_done_${supplierId}`, title: isHospitality ? "✅ Get Service Quote" : "✅ Get Quote" },
        { id: `sc_quote_clear_${supplierId}`, title: "🗑 Start Over" }
      ]
    });
  }

  // ── Handle "edit: 1: corrected name" - tourist renames a cart item ──────
  const _editMatch = raw.match(/^edit[:\s]+(\d+)[:\s]+(.+)/i);
  if (_editMatch) {
    const editIdx  = parseInt(_editMatch[1]) - 1;
    const newName  = _editMatch[2].trim().slice(0, 100);
    const cartItems = biz?.sessionData?.scQuoteItems || [];
    if (editIdx >= 0 && editIdx < cartItems.length) {
      cartItems[editIdx].name = newName;
      if (biz) { biz.sessionData = { ...(biz.sessionData || {}), scQuoteItems: cartItems }; await saveBiz(biz); }
      return sendButtons(from, {
        text:
          `✏️ *Updated item ${editIdx + 1}:* ${newName}\n\n` +
          `🛒 *Cart (${cartItems.length}):*\n` +
          cartItems.map(it => `• ${it.qty}× ${it.name}`).join("\n") + `\n\n` +
          `Continue selecting, or tap *Get Quote* to send.`,
        buttons: [
          { id: `sc_quote_done_${supplierId}`, title: isHospitality ? "✅ Get Service Quote" : "✅ Get Quote" },
          { id: `sc_quote_clear_${supplierId}`, title: "🗑 Start Over" }
        ]
      });
    }
    return sendText(from, `❌ Item ${editIdx + 1} not in your cart. Type the item numbers from the list above.`);
  }

  if (raw.toLowerCase() === "done") {
    // For hospitality: ask check-in/scope before finalising if not yet captured
    if (isHospitality && !biz?.sessionData?.scPeopleCount) {
      if (biz) { biz.sessionState = "sc_awaiting_quote_people"; await saveBiz(biz); }
      return sendText(from,
        `👥 *How many people, and when?*\n\n` +
        `_e.g. "2 adults 3 nights"_\n` +
        `_e.g. "family of 4, double room, 2 nights"_\n` +
        `_e.g. "4 people game drive Saturday morning"_\n` +
        `_e.g. "2 people sunset cruise Friday"_\n\n` +
        `Type *skip* if not sure yet.`
      );
    }
    // For service RFQ, collect people count before finalising if not yet captured
    if (isService && isRFQ && !biz?.sessionData?.scPeopleCount) {
      const isTourism = _isTourismSupplier(seller);
      if (biz) { biz.sessionState = "sc_awaiting_quote_people"; await saveBiz(biz); }
      return sendText(from,
        isTourism
          ? `👥 *How many people and when?*\n\n` +
            `_e.g. "2 adults Saturday morning"_\n` +
            `_e.g. "4 people full day"_\n` +
            `_e.g. "group of 6 sunset cruise"_\n\n` +
            `Type *skip* if not sure.`
          : `👥 *How many people / how large is the job?*\n\n` +
            `_e.g. "2 people", "3-bed house", "office of 20 staff", "1 car"_\n\n` +
            `Type *skip* if not applicable.`
      );
    }
    return _scQuoteDone(from, supplierId, biz, saveBiz);
  }

  // ── Resolve items using stored catalogue (set in _scQuote) ────────────────
  let knownItems = [];
  try {
    const catalogueRaw = biz?.sessionData?.scCatalogue;
    if (catalogueRaw) knownItems = JSON.parse(catalogueRaw);
  } catch (_) {}

  if (!knownItems.length) {
    // Fallback: re-read from DB using same split logic as _scQuote
    if (isHospitality) {
      const roomItems = (seller.roomTypes || []).flatMap(rt => {
        const items = [];
        if (rt.pricePerNight > 0) items.push({ service: rt.name + " (overnight)",    rate: "$" + Number(rt.pricePerNight).toFixed(0) + "/night", _unitPrice: Number(rt.pricePerNight), _unit: "night" });
        if (rt.restRate       > 0) items.push({ service: rt.name + " (rest/day use)", rate: "$" + Number(rt.restRate).toFixed(0)       + "/rest",  _unitPrice: Number(rt.restRate),       _unit: "rest"  });
        if (!rt.pricePerNight && !rt.restRate) items.push({ service: rt.name, rate: "", _unitPrice: 0, _unit: "night" });
        return items;
      });
      const extraItems    = (seller.extraServices || []).map(es => ({ service: es.name, rate: es.price > 0 ? "$" + Number(es.price).toFixed(2) + "/" + (es.unit || "service") : "", _unitPrice: Number(es.price) || 0, _unit: es.unit || "service" }));
      const activityItems = (seller.rates         || []).map(r  => ({ service: r.service, rate: r.rate || "", _unitPrice: _parseServiceRateValue(r.rate), _unit: _parseServiceRateUnit(r.rate, r.service) }));
      knownItems = [...roomItems, ...extraItems, ...activityItems];
    } else {
      knownItems = isService
        ? (seller.rates?.length > 0 ? seller.rates : (seller.listedProducts || seller.products || []).map(s => ({ service: s, rate: "" })))
        : (seller.prices?.length > 0 ? seller.prices : (seller.listedProducts || seller.products || []).map(p => ({ product: p, amount: 0, unit: "each" })));
    }
  }

  const existingItems = biz?.sessionData?.scQuoteItems || [];

  // ── Parse buyer input ─────────────────────────────────────────────────────
  // Hospitality and services both use item-number based selection.
  // _parseHospitalityInput handles: "1", "1×3", "2", "1×2, 2×1", "1,2"
  // For typed names (no number match), fall back to name lookup.
  let newItems;
  if (isHospitality) {
    newItems = _parseHospitalityInput(raw, knownItems);
  } else if (isRFQ && isService) {
    newItems = _parseServiceRFQInput(raw, knownItems);
  } else {
    newItems = _parseItemInput(raw, knownItems, isService);
  }

  const allItems = [...existingItems, ...newItems];

  if (biz) {
    biz.sessionData = { ...(biz.sessionData || {}), scQuoteItems: allItems };
    await saveBiz(biz);
  }

  // ── Cart summary ──────────────────────────────────────────────────────────
  // Build priceMap keyed on service/product name (lowercase) for display
  const priceMap = {};
  for (const item of knownItems) {
    const key = (isHospitality || isService ? item.service : item.product)?.toLowerCase().trim();
    if (!key) continue;
    if (isHospitality) {
      priceMap[key] = item.rate || "";
    } else if (isService) {
      priceMap[key] = item.rate || "";
    } else {
      priceMap[key] = item.amount ? `$${Number(item.amount).toFixed(2)}/${item.unit || "each"}` : "";
    }
  }

  const savedNote = biz?.sessionData?.scTouristNote || "";

  const summary = allItems.map(it => {
    const priceStr = priceMap[it.name?.toLowerCase().trim()];
    return priceStr
      ? `• ${it.qty}× ${it.name}  -  ${priceStr}`
      : `• ${it.qty}× ${it.name}`;
  }).join("\n");

  const termAdd  = isHospitality ? "room/activity" : (isService ? "service" : "item");
  const termDone = isRFQ && !isHospitality
    ? "📤 Send Request"
    : (isHospitality ? "✅ Get Service Quote" : (isService ? "✅ Get Service Quote" : "✅ Get Quote"));

  const editHint = `\n\n_Type *note: your details* to add info (e.g. dates, group size)._\n_Type *edit: 1: new name* to rename an item._`;

  return sendButtons(from, {
    text:
`🛒 *${isHospitality ? "Selected (rooms/activities)" : (isService ? "Services" : "Items")} - ${allItems.length} item${allItems.length === 1 ? "" : "s"}:*
${summary}${savedNote ? "\n\n📝 _Note: " + savedNote + "_" : ""}${editHint}

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
  const items        = biz?.sessionData?.scQuoteItems || [];
  const isRFQ        = biz?.sessionData?.scRFQ;
  const buyerName    = biz?.sessionData?.scBuyerName || "";
  const buyerPhone   = from;
  const touristNote  = biz?.sessionData?.scTouristNote || "";

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

    // Include people/scope count in notification if captured
    const _rfqPeople     = biz?.sessionData?.scPeopleCount;
    const itemListFull   = [
      itemList,
      _rfqPeople  ? "People / scope: " + _rfqPeople : "",
      touristNote ? "Tourist note: " + touristNote  : ""
    ].filter(Boolean).join("\n");

    // Notify seller via existing Meta template system - works outside 24hr window
    await _sendSellerNotification({
      sellerPhone:          seller.phone,
      notificationContacts: seller.notificationContacts || [],
      refNum,
      buyerDisplay:         buyerName || _normPhone(buyerPhone),
      itemList:             itemListFull,
      itemCount:            items.length,
      isRFQ:        true,
    });

    // ── Write the RFQ draft directly into the seller's UserSession NOW ──────────
    // Critical: must include the real buyerPhone (the buyer who made the request,
    // NOT the seller). This prevents stale drafts from previous sessions bleeding in
    // when the seller later taps "View & Quote" and triggering PDF delivery to wrong phone.
    try {
      const UserSession = (await import("../models/userSession.js")).default;
      const _rfqLineItems = items.map(it => ({
        name:      it.name || it.product || "Item",
        qty:       Number(it.qty || it.quantity || 1),
        unitPrice: 0,
        lineTotal: 0,
        unit:      it.unit || "job"
      }));
      const _rfqDraft = {
        refNum,
        supplierId: String(seller._id),
        buyerPhone,       // ← the REAL buyer's phone (from = buyer in _scQuoteDone)
        buyerName:  buyerName || _normPhone(buyerPhone),
        lineItems:  _rfqLineItems,
        items,
        total:      0,
        isRFQ:      true,
        storedAt:   Date.now()
      };

      const _sellerNormPhone = _normPhone(seller.phone);
      const _allNotifPhones  = [_sellerNormPhone,
        ...(seller.notificationContacts || []).map(_normPhone)
      ].filter(Boolean);

      await Promise.allSettled(_allNotifPhones.map(async (ph) => {
        const _existing = await UserSession.findOne({ phone: ph }).lean();
        let _draftsMap = {};
        try {
          const _raw = _existing?.tempData?.scPendingDrafts;
          _draftsMap = _raw ? (typeof _raw === "string" ? JSON.parse(_raw) : _raw) : {};
        } catch (_) {}
        // Prune drafts older than 48 hours
        const _cutoff = Date.now() - 48 * 60 * 60 * 1000;
        for (const key of Object.keys(_draftsMap)) {
          if ((_draftsMap[key]?.storedAt || 0) < _cutoff) delete _draftsMap[key];
        }
        _draftsMap[refNum.toUpperCase()] = _rfqDraft;

        await UserSession.findOneAndUpdate(
          { phone: ph },
          { $set: {
              "tempData.scPendingDrafts":      JSON.stringify(_draftsMap),
              "tempData.scPendingSellerQuote": JSON.stringify(_rfqDraft),
              "tempData.scLastNotifiedRef":    refNum.toUpperCase()
          }},
          { upsert: true }
        );
      }));
      console.log(`[SC RFQ DRAFT] Stored draft ${refNum} for seller ${_sellerNormPhone} (buyer: ${buyerPhone})`);
    } catch (_rfqStoreErr) {
      console.warn("[SC RFQ DRAFT] Failed to pre-store draft:", _rfqStoreErr.message);
    }

    _trackConversion(biz);

    const _rfqPeopleSummary = _rfqPeople ? `\n👥 People / scope: ${_rfqPeople}` : "";
    const _noteSummary = touristNote ? `\n📝 Your note: _${touristNote}_` : "";
    return sendButtons(from, {
      text:
`✅ *Quote request sent to ${seller.businessName}!*

Reference: *${refNum}*
${isService ? "Services" : "Items"}: ${items.length} ${isService ? "service" : "item"}${items.length > 1 ? "s" : ""}${_rfqPeopleSummary}${_noteSummary}

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
  const isHospitality = seller.profileType === "hospitality";
  const priceMap = {};

  if (isHospitality) {
    // Build price lookup from roomTypes (split into overnight + rest entries, same as catalogue)
    (seller.roomTypes || []).forEach(rt => {
      if (rt.pricePerNight > 0) priceMap[(rt.name + " (overnight)").toLowerCase()]    = { amount: Number(rt.pricePerNight), unit: "night" };
      if (rt.restRate       > 0) priceMap[(rt.name + " (rest/day use)").toLowerCase()] = { amount: Number(rt.restRate),       unit: "rest"  };
      // Unpriced room fallback
      if (!rt.pricePerNight && !rt.restRate) priceMap[rt.name.toLowerCase()] = { amount: 0, unit: "night" };
    });
    (seller.extraServices || []).forEach(es => {
      if (es.name) priceMap[es.name.toLowerCase()] = { amount: Number(es.price) || 0, unit: es.unit || "service" };
    });
    (seller.rates || []).forEach(r => {
      if (r.service) priceMap[r.service.toLowerCase()] = { amount: _parseServiceRateValue(r.rate), unit: _parseServiceRateUnit(r.rate, r.service) };
    });
  } else {
    const priceItems = isService ? seller.rates : seller.prices;
    for (const item of (priceItems || [])) {
      const key = (isService ? item.service : item.product)?.toLowerCase().trim();
      if (!key) continue;
      if (isService) {
        priceMap[key] = { amount: _parseServiceRateValue(item.rate), unit: _parseServiceRateUnit(item.rate, item.service) };
      } else {
        priceMap[key] = { amount: parseFloat(item.amount) || 0, unit: item.unit || "each" };
      }
    }
  }

  let total = 0;
  const lineItems = items.map(it => {
    const key = it.name.toLowerCase().trim();
    const rateInfo = priceMap[key] || { amount: it.price || 0, unit: isService ? "job" : "each" };

    const unitPrice = Number(rateInfo.amount || 0);
    const unit = rateInfo.unit || (isService ? "job" : "each");
    const qty = Number(it.qty || 1);
    const lineTotal = unitPrice * qty;

    total += lineTotal;

    return {
      name: it.name,
      qty,
      unit,
      unitPrice,
      lineTotal
    };
  });

  const refNum = "QT-" + Date.now().toString(36).toUpperCase().slice(-6);
  const expiry = new Date(Date.now() + 48 * 3600 * 1000)
    .toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });

  const itemRows = lineItems.map((l, i) => {
    const _u = l.unit || (isService ? "job" : "each");
    const _unitLabel = ["person","hr","hour","day","night","trip","group"].includes(_u)
      ? `per ${_u}` : `/${_u}`;
    return `${i + 1}. ${l.name} × ${l.qty} - $${l.unitPrice.toFixed(2)} ${_unitLabel} = $${l.lineTotal.toFixed(2)}`;
  }).join("\n");

  // Store draft in SELLER's UserSession (primary + all notification contacts)
  // FIX: store as a MAP keyed by refNum so multiple concurrent requests from
  // different buyers never overwrite each other, especially on shared notification
  // contact phones that may be listed on several sellers' accounts.
  try {
    const UserSession = (await import("../models/userSession.js")).default;
    const _draftPayload = {
      refNum, supplierId, buyerPhone, buyerName, lineItems, total, expiry,
      isService, storedAt: Date.now()
    };

    async function _addDraftToSession(targetPhone) {
      const _existing = await UserSession.findOne({ phone: targetPhone }).lean();
      let _draftsMap = {};
      try {
        const _raw = _existing?.tempData?.scPendingDrafts;
        _draftsMap = _raw ? (typeof _raw === "string" ? JSON.parse(_raw) : _raw) : {};
      } catch (_) { _draftsMap = {}; }

      // Prune drafts older than 72 hours to keep the map tidy
      const _cutoff = Date.now() - 72 * 60 * 60 * 1000;
      for (const key of Object.keys(_draftsMap)) {
        if ((_draftsMap[key]?.storedAt || 0) < _cutoff) delete _draftsMap[key];
      }
      _draftsMap[refNum.toUpperCase()] = _draftPayload;

      await UserSession.findOneAndUpdate(
        { phone: targetPhone },
        {
          $set: {
            // New map format - supports multiple concurrent drafts per phone
            "tempData.scPendingDrafts":      JSON.stringify(_draftsMap),
            "tempData.scLastNotifiedRef":    refNum.toUpperCase(),
            // Legacy scalar - kept so any in-flight sessions before this deploy still work
            "tempData.scPendingSellerQuote": JSON.stringify(_draftPayload),
            "tempData.scSellerQuoteState":   "awaiting_seller_quote_confirm",
            "tempData.scBuyerPhone":         buyerPhone,
          }
        },
        { upsert: true }
      );
    }

    const _primaryPhone = _normPhone(seller.phone);
    await _addDraftToSession(_primaryPhone);

    const _notifPhones = (seller.notificationContacts || []).map(_normPhone).filter(Boolean);
    if (_notifPhones.length > 0) {
      await Promise.allSettled(_notifPhones.map(nc => _addDraftToSession(nc)));
    }
    console.log(`[SC QUOTE] Draft ${refNum} stored on ${1 + _notifPhones.length} session(s) for ${seller.businessName}`);
  } catch (err) {
    console.error("[SC QUOTE] Failed to store draft on seller session:", err.message);
  }

  // Notify seller via Meta template - works outside 24hr window
  await _sendSellerNotification({
    sellerPhone:          seller.phone,
    notificationContacts: seller.notificationContacts || [],
    refNum,
    buyerDisplay:         buyerName || _normPhone(buyerPhone),
    itemList:             itemRows,
    itemCount:            lineItems.length,
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
  // FIX: use map-aware lookup so the correct draft is found even when this phone
  // holds multiple drafts (e.g. notification contact for several sellers).
  const draft = await _getSellerDraft(from, refNum);

  if (!draft) {
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

  // Clear draft from seller's session (removes from map + legacy scalar)
  await _clearSellerDraft(from, refNum);

  const itemRows = lineItems.map((l, i) =>
    `${i + 1}. ${l.name} × ${l.qty} @ $${Number(l.unitPrice || 0).toFixed(2)} = $${Number(l.lineTotal || 0).toFixed(2)}`
  ).join("\n");

  // Default expiry to 48 hours from now if not set
  const _expiryDisplay = expiry && expiry !== "undefined" && expiry !== undefined
    ? expiry
    : new Date(Date.now() + 48 * 60 * 60 * 1000).toLocaleDateString("en-GB", {
        day: "numeric", month: "short", year: "numeric"
      });

  return sendButtons(from, {
    text:
`✅ *Quote ${refNum} approved and sent to buyer!*

${itemRows}
${"─".repeat(28)}
*Total: $${Number(total || 0).toFixed(2)} USD*

${pdfSent ? "📄 PDF quotation delivered to buyer." : "✅ Quote confirmed and sent to buyer."}
Valid until: ${_expiryDisplay}`,
    buttons: [
      { id: "my_supplier_account", title: "🏪 My Account" }
    ]
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// SELLER EDITS DRAFT PRICES → shows numbered list → waits for typed reply
// ─────────────────────────────────────────────────────────────────────────────
async function _scHandleQuoteEdit(from, refNum, biz, saveBiz) {
  // FIX: use map-aware lookup so correct draft is found for this specific refNum
  const draft = await _getSellerDraft(from, refNum);

  if (!draft) {
    return sendText(from, `❌ Quote ${refNum} not found or already sent.`);
  }

  // Set state so next typed message is treated as a price edit
  const UserSession = (await import("../models/userSession.js")).default;
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
  const _tmpSess = await UserSession.findOne({ phone: _normPhone(from) }).lean();
  const _lastRef = _tmpSess?.tempData?.scLastNotifiedRef;
  let draft = _lastRef ? await _getSellerDraft(from, _lastRef) : null;

  // Fallback 1: legacy scPendingSellerQuote scalar
  if (!draft) {
    const _raw = _tmpSess?.tempData?.scPendingSellerQuote;
    if (_raw) {
      try { draft = typeof _raw === "string" ? JSON.parse(_raw) : _raw; } catch (_) {}
    }
  }

  // Fallback 2: scLastRFQ in biz session (RFQ drafts are stored there)
  // This kicks in when the draft was not yet written to UserSession (first price entry after view_and_quote)
  if (!draft && biz?.sessionData?.scLastRFQ) {
    const _rq = biz.sessionData.scLastRFQ;
    if (_rq && (_rq.timestamp || 0) > Date.now() - 48 * 60 * 60 * 1000) {
      draft = {
        refNum:    _rq.refNum,
        supplierId: _rq.supplierId,
        buyerPhone: _rq.buyerPhone,
        buyerName:  _rq.buyerName,
        lineItems: (_rq.items || []).map(it => ({
          name:      it.name || it.product || "Item",
          qty:       Number(it.qty || it.quantity || 1),
          unitPrice: 0,
          lineTotal: 0,
          unit:      it.unit || "job"
        })),
        total:     0,
        isRFQ:     true
      };
    }
  }

  if (!draft) return sendText(from, "❌ No pending quote found. It may have expired.");

  const al = text.trim().toLowerCase();

  if (al === "cancel") {
    await _clearSellerDraft(from, draft.refNum);
    // Also clear the scSellerQuoteState
    await UserSession.findOneAndUpdate(
      { phone: _normPhone(from) },
      { $unset: { "tempData.scSellerQuoteState": "" } },
      { upsert: true }
    );
    return sendText(from, `🗑 Quote ${draft.refNum} discarded.`);
  }

  if (al === "confirm" || al === "send") {
    return _scHandleQuoteConfirm(from, draft.refNum, biz, saveBiz);
  }

  // Parse prices: "1×50, 2×3" or "1x50 2x3" or "1=50, 2=3" - all formats accepted
  const edits = {};
  const matches = text.matchAll(/(\d+)\s*[=×xX@:]\s*(\d+(?:\.\d+)?)(?:\s*\/\s*([a-zA-Z]+))?/g);

  for (const m of matches) {
    const idx = parseInt(m[1]) - 1;
    if (idx >= 0 && idx < draft.lineItems.length) {
      edits[idx] = {
        amount: parseFloat(m[2]),
        unit: m[3] ? m[3].toLowerCase() : draft.lineItems[idx].unit
      };
    }
  }

  if (!Object.keys(edits).length) {
    // Build the item list so seller can see what they need to price
    const _currList = draft.lineItems.map((l, i) => `${i + 1}. *${l.name}* × ${l.qty}`).join("\n");
    const _exParts  = draft.lineItems.slice(0, 3).map((_, i) => `${i + 1}×${[50, 25, 10][i] || 15}`).join("  ");
    return sendText(from,
      `❌ Could not read your prices.\n\n` +
      `*Items to price:*\n${_currList}\n\n` +
      `Type *item number × price per unit*\n` +
      `_e.g. ${_exParts}_\n\n` +
      `Both × and = work: _1×50_ or _1=50_\n` +
      `Type *cancel* to discard.`
    );
  }

  // Apply edits to draft line items
  let newTotal = 0;
  const updatedItems = draft.lineItems.map((l, i) => {
    const edit = edits.hasOwnProperty(i) ? edits[i] : null;
    const unitPrice = edit ? edit.amount : l.unitPrice;
    const unit = edit?.unit || l.unit || "job";
    const lineTotal = unitPrice * l.qty;
    newTotal += lineTotal;
    return { ...l, unit, unitPrice, lineTotal, _edited: edits.hasOwnProperty(i) };
  });

  const updatedDraft = { ...draft, lineItems: updatedItems, total: newTotal };

  // Write updated draft to both map and legacy scalar
  let _dm2 = {};
  try {
    const _r = _tmpSess?.tempData?.scPendingDrafts;
    _dm2 = _r ? (typeof _r === "string" ? JSON.parse(_r) : _r) : {};
  } catch (_) {}
  const _updRef = (updatedDraft.refNum || "").toUpperCase();
  if (_updRef) _dm2[_updRef] = updatedDraft;

  await UserSession.findOneAndUpdate(
    { phone: _normPhone(from) },
    { $set: {
        "tempData.scPendingDrafts":      JSON.stringify(_dm2),
        "tempData.scPendingSellerQuote": JSON.stringify(updatedDraft),
        "tempData.scLastNotifiedRef":    _updRef,
        "tempData.scSellerQuoteState":   "awaiting_seller_price_edit"
    }},
    { upsert: true }
  );

  // Build review lines - show clearly: item name, qty, unit price, total per line
  const _unpriced = updatedItems.filter(l => !l.unitPrice || l.unitPrice === 0);
  const numbered = updatedItems.map((l, i) => {
    const _unitLabel = _formatRateUnit(l.unit) || "/unit";
    if (!l.unitPrice || l.unitPrice === 0) {
      return `${i + 1}. *${l.name}* × ${l.qty} - ❓ _price not set_`;
    }
    return `${i + 1}. *${l.name}* × ${l.qty} @ $${Number(l.unitPrice).toFixed(2)}${_unitLabel} = *$${Number(l.lineTotal).toFixed(2)}*${l._edited ? " ✏️" : ""}`;
  }).join("\n");

  const _editHint = _unpriced.length > 0
    ? `\n\n⚠️ *${_unpriced.length} item${_unpriced.length > 1 ? "s" : ""} still need${_unpriced.length === 1 ? "s" : ""} a price.* Add them before sending.`
    : "";

  return sendButtons(from, {
    text:
`📋 *Quote Review - ${draft.refNum}*

${numbered}
${"─".repeat(28)}
*Total: $${newTotal.toFixed(2)} USD*${_editHint}

_✏️ = price you just set_

To change a price: _1×60, 2×5_
To confirm and send to buyer, tap the button below.`,
    buttons: [
      { id: `sc_quote_confirm_${draft.refNum}`, title: "✅ Send Quote" },
      { id: `sc_quote_edit_${draft.refNum}`,    title: "✏️ Edit Prices" }
    ]
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// SELLER NOTIFICATION - reuses existing approved Meta template infrastructure
// Sends supplier_new_request_v2 (with View & Quote button) or falls back to v1.
// Works outside 24hr window. No new templates needed.
// ─────────────────────────────────────────────────────────────────────────────
async function _sendSellerNotification({ sellerPhone, notificationContacts = [], refNum, buyerDisplay, itemList, itemCount, total, isRFQ }) {
  try {
    const { notifySupplierNewRequestTemplate } = await import("./buyerRequestNotifications.js");

    const totalLine     = typeof total === "number" ? `Total: $${total.toFixed(2)}` : "Prices needed from you";
    // Pass the raw first item name only - notifySupplierNewRequestTemplate builds the "N items: X + more" wrapper
    const firstLine     = String(itemList).split("\n")[0].replace(/^\d+\.\s*/, "").trim();
    const deliveryLine  = isRFQ
      ? "Please reply with prices: 1=price, 2=price"
      : totalLine;

    // FIX: smart-link quotes (RFQ-xxxx / QT-xxxx refs) have NO BuyerRequest document.
    // Passing requestId: refNum makes the button payload "req_offer_RFQ-M5Q5TN"
    // which routes to the BuyerRequest handler → finds nothing → "That request has closed".
    // Fix: pass requestId: null so button payload is "view_and_quote".
    // The view_and_quote handler checks _scDraft (stored in UserSession) first,
    // finds the pending draft by scLastNotifiedRef, and routes correctly.
    await notifySupplierNewRequestTemplate({
      supplierPhone:        sellerPhone,
      notificationContacts: notificationContacts,
      requestId:            null,
      ref:                  refNum,
      locationText:         `Smart Link Quote · ${buyerDisplay}`,
      itemCount,
      itemSummary:          firstLine,
      deliveryLine,
      fullItemLines:        String(itemList),
      replyExamples:        "1=12.50, 2=8.00"
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
  // Default expiry to 48 hours if not set
  expiry = (expiry && expiry !== "undefined") ? expiry : new Date(Date.now() + 48 * 60 * 60 * 1000).toLocaleDateString("en-GB", {
    day: "numeric", month: "short", year: "numeric"
  });
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
    biz.sessionState = travels ? "sc_awaiting_booking_service" : "sc_awaiting_booking_service_b";
    biz.sessionData  = {
      ...(biz.sessionData || {}),
      scSellerId:      supplierId,
      scBookingTravels: travels,
      scServiceMenu:   JSON.stringify(seller.rates?.length > 0 ? seller.rates : (seller.listedProducts || seller.products || []).map(s => ({ service: s, rate: "" })))
    };
    await saveBiz(biz);
  }

  const isHospitality2 = seller.profileType === "hospitality";
  const _bookExampleA = isHospitality2
    ? `"1" or "1, 4" or "3: 2 nights, 5: airport pickup"`
    : `"1" or "1, 3" or "2, 4: office block"`;
  const _bookExampleB = isHospitality2
    ? `"1" or "1, 4" or "3: 2 nights"` 
    : `"1" or "1, 3" or "2: details"`;
  const _bookHeading = isHospitality2 ? "📅 *Book / Reserve*" : "📅 *Book a service*";

  if (travels) {
    // PATH A: Seller comes to client - ask what service(s) first
    return sendText(from,
`${_bookHeading} - ${seller.businessName}
🚗 _We come to you_

${serviceMenu}${totalSvcs > 20 ? "\n_(+ more services available)_" : ""}

Type the *number(s)* of what you need.
_e.g. ${_bookExampleA}_
_(Add a colon after the number for extra detail)_

Type *cancel* to go back.`
    );
  } else {
    // PATH B: Client visits seller - show their address first
    return sendText(from,
`${_bookHeading} - ${seller.businessName}
📍 _${seller.address || location}_

${serviceMenu}${totalSvcs > 20 ? "\n_(+ more services available)_" : ""}

Type the *number(s)* of what you need.
_e.g. ${_bookExampleB}_
_(Add a colon for extra detail)_

Type *cancel* to go back.`
    );
  }
}

// Stub for book_confirm (mirrors back to booking start)
async function _scBookConfirm(from, supplierId, biz, saveBiz) {
  return _scBook(from, supplierId, biz, saveBiz);
}

// ── PATH A step 1 → step 2: Buyer chose services, now ask their location ─────
// ── Helper: resolve numbered/named service input to display names ─────────────
function _resolveServiceInput(raw, menuJson) {
  let resolved = raw.trim();
  try {
    const menu = JSON.parse(menuJson || "[]");
    if (menu.length > 0) {
      const parts = raw.split(/,\s*/);
      const mapped = parts.map(part => {
        const colonIdx = part.indexOf(":");
        const baseNum  = colonIdx > -1 ? part.slice(0, colonIdx).trim() : part.trim();
        const scope    = colonIdx > -1 ? part.slice(colonIdx + 1).trim() : "";
        const num = parseInt(baseNum, 10);
        if (!isNaN(num) && num >= 1 && num <= menu.length) {
          const name = menu[num - 1].service || String(menu[num - 1]) || part.trim();
          return scope ? name + " (" + scope + ")" : name;
        }
        return part.trim();
      }).filter(Boolean);
      if (mapped.length > 0) resolved = mapped.join(", ");
    }
  } catch (_) {}
  return resolved;
}

// ── PATH A step 1: service chosen → ask people count ─────────────────────────
async function _scProcessBookingService(from, supplierId, raw, biz, saveBiz) {
  const resolvedServices = _resolveServiceInput(raw, biz?.sessionData?.scServiceMenu);
  if (biz) {
    biz.sessionState = "sc_awaiting_people_count";
    biz.sessionData  = { ...(biz.sessionData || {}), scBookingServices: resolvedServices, scBookingPath: "A" };
    await saveBiz(biz);
  }
  return sendText(from,
`👥 *How many people?*

Services: _${resolvedServices}_

Type the number of people.
_e.g. "2" or "4 adults" or "2 adults 3 children"_

Type *skip* if not applicable, or *cancel* to go back.`
  );
}

// ── PATH B step 1: service chosen (client visits) → ask people count ──────────
async function _scProcessBookingServicePathB(from, supplierId, raw, biz, saveBiz) {
  const resolvedServices = _resolveServiceInput(raw, biz?.sessionData?.scServiceMenu);
  if (biz) {
    biz.sessionState = "sc_awaiting_people_count";
    biz.sessionData  = { ...(biz.sessionData || {}), scBookingServices: resolvedServices, scBookingPath: "B" };
    await saveBiz(biz);
  }
  return sendText(from,
`👥 *How many people?*

Services: _${resolvedServices}_

Type the number of people.
_e.g. "1" or "2 adults" or "group of 6"_

Type *skip* if not applicable, or *cancel* to go back.`
  );
}

// ── People count received → route to location (PATH A) or job desc (PATH B) ───
async function _scProcessPeopleCount(from, supplierId, raw, biz, saveBiz) {
  const path       = biz?.sessionData?.scBookingPath || "A";
  const peopleText = (raw.toLowerCase() === "skip" || !raw.trim()) ? "" : raw.trim();
  const services   = biz?.sessionData?.scBookingServices || "";

  if (biz && peopleText) {
    biz.sessionData = { ...(biz.sessionData || {}), scPeopleCount: peopleText };
    await saveBiz(biz);
  }

  const peopleLine = peopleText ? `People: _${peopleText}_

` : "";

  if (path === "A") {
    if (biz) { biz.sessionState = "sc_awaiting_service_location"; await saveBiz(biz); }
    return sendText(from,
`📍 *Where should we come to?*

Services: _${services}_
${peopleLine}Type your address or suburb.
_e.g. "15 Samora Machel Ave, Highfield" or "Borrowdale, Harare"_

Type *cancel* to go back.`
    );
  } else {
    if (biz) { biz.sessionState = "sc_awaiting_job_desc"; await saveBiz(biz); }
    // Use hospitality-appropriate examples if available from biz session
    const _isHospB = biz?.sessionData?.scIsHospitality;
    const _jobDescEx = _isHospB
      ? `"3 nights, 2 adults, need airport pickup" or "game drive for 4 people Saturday"`
      : `"3 nights, 2 adults, need airport transfer" or "describe what you need"`;
    return sendText(from,
`📝 *Describe what you need:*

Services: _${services}_
${peopleLine}_e.g. ${_jobDescEx}_

Type *cancel* to go back.`
    );
  }
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

  // PATH B datetime - "bring it in" is mechanic language; use generic for hospitality
  const _isHospD = biz?.sessionData?.scIsHospitality;
  const _dateLabel = _isHospD
    ? "📅 *When would you like to arrive / visit?*"
    : "📅 *When will you visit?*";

  return sendButtons(from, {
    text:
`${_dateLabel}

${_isHospD ? "Booking" : "Job"}: _${raw}_

Type your preferred date and time.
_e.g. "Tomorrow morning", "Saturday 9am", "Monday after 2pm"_

Or tap Urgent if you need it done today.`,
    buttons: [
      { id: `sc_book_urgent_${supplierId}`, title: "⚡ Urgent - ASAP" }
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
  const peopleCount = biz?.sessionData?.scPeopleCount     || "";
  const buyerName   = biz?.sessionData?.scBuyerName       || "";
  const refNum      = "BK-" + Date.now().toString(36).toUpperCase().slice(-6);

  if (biz) { biz.sessionState = "ready"; await saveBiz(biz); }

  // ── Notify seller via Meta template (works outside 24hr window) ───────────
  const bookingDetails = travels
    ? `${services} at ${location}`
    : `${services}`;

  const _peopleLine = peopleCount ? `\nPeople: ${peopleCount}` : "";

  await _sendSellerNotification({
    sellerPhone:          seller.phone,
    notificationContacts: seller.notificationContacts || [],
    refNum,
    buyerDisplay:         buyerName || _normPhone(from),
    itemList:             `Service: ${services}${_peopleLine}\nLocation: ${travels ? location : seller.address || "at your premises"}\nTime: ${raw}`,
    itemCount:            1,
    total:                null,
    isRFQ:                true,
  });

  _trackConversion({ sessionData: { scSource: biz?.sessionData?.scSource, scSellerId: supplierId } });

  const area = seller.location?.area || "";
  const city = seller.location?.city || "";

  const isServiceType = seller.profileType === "service";
  const isHospitalityType = seller.profileType === "hospitality";

  const _peopleSummary = peopleCount ? `\n👥 People: ${peopleCount}` : "";
  const _bookingLabel = isHospitalityType ? "🏨 Booking" : (isServiceType ? "🔧 Services" : "🔧 Job");
  const _locationLine = travels
    ? `📍 Location: ${location}`
    : `📍 At: ${seller.address || [area, city].filter(Boolean).join(", ")}`;

  return sendButtons(from, {
    text:
`✅ *Booking request sent - ${refNum}*

🏪 ${seller.businessName}
${_bookingLabel}: ${services}${_peopleSummary}
${_locationLine}
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
   for (const targetPhone of uniqueNotifyPhones) {
  await sendButtons(targetPhone, {
      text:
        `💬 *New enquiry via ZimQuote!*\n\n` +
        `📱 From: ${buyerDisplay}\n\n` +
        `_"${raw.slice(0, 400)}"_\n\n` +
        `Reply directly on WhatsApp to respond.`,
      buttons: [{ id: "my_supplier_account", title: "🏪 My Store" }]
    });
  }
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
        to:   targetPhone,
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




function _parseServiceRateValue(rate = "") {
  const raw = String(rate || "").trim();
  const m = raw.match(/(\d+(?:\.\d+)?)/);
  return m ? Number(m[1]) : 0;
}

function _parseServiceRateUnit(rate = "", serviceName = "") {
  const raw = String(rate || "").toLowerCase();

  const explicit = raw.match(/\/\s*([a-zA-Z]+)/);
  if (explicit) return explicit[1].toLowerCase();

  return _guessServicePricingUnit(serviceName);
}

function _guessServicePricingUnit(serviceName = "") {
  const s = String(serviceName || "").toLowerCase();

  if (/sunset cruise|game drive|bush walk|bird|cultural|village|guided|tour|safari/.test(s)) return "person";
  if (/airport transfer|transfer|pickup|taxi|shuttle/.test(s)) return "trip";
  if (/lodge|accommodation|room|camping|tent|chalet/.test(s)) return "night";
  if (/houseboat|boat hire|boat charter/.test(s)) return "day";
  if (/fishing trip|full day fishing/.test(s)) return "boat";
  if (/equipment hire|hire/.test(s)) return "day";

  return "job";
}

function _formatRateUnit(unit = "job") {
  const u = String(unit || "job").toLowerCase();
  if (["person", "adult", "child", "group", "trip", "night", "day", "hour", "hr", "boat", "vehicle", "room"].includes(u)) {
    return `/${u}`;
  }
  return `/${u || "job"}`;
}

function _isTourismSupplier(seller = {}) {
  // Correct check: use profileType="hospitality" (set at registration).
  // Fallback to categories for legacy records that predate profileType.
  return seller.profileType === "hospitality" ||
    (seller.categories || []).some(c => ["lodge","hotel","guesthouse","hospitality","tourism","accommodation"].includes(c));
}

// ── Is this supplier an accommodation provider (lodge/hotel/guesthouse)? ─────
// True for property-based providers. False for activity-only providers
// (safari operators, tour guides, boat hire).
function _isAccommodationSupplier(seller = {}) {
  if (!_isTourismSupplier(seller)) return false;
  const subtypes = seller.tourismSubtype || [];
  if (subtypes.length) {
    return subtypes.some(s => ["lodge","hotel","guesthouse","self_catering","campsite"].includes(s));
  }
  // Fallback for legacy
  return (seller.categories || []).some(c => ["lodge","hotel","guesthouse","accommodation"].includes(c));
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

  // Hospitality services
  if (/room|double|twin|suite|chalet|cottage|cabin|unit/.test(s))
    return ["1 night", "2 nights"];
  if (/conference|meeting|board|function|venue/.test(s))
    return ["half day", "full day"];
  if (/pool|swim|braai|lapa|garden/.test(s))
    return ["half day access", "full day access"];
  if (/breakfast|dinner|lunch|meal|restaurant/.test(s))
    return ["per person", "group of 4"];
  if (/airport|transfer|pickup|shuttle|taxi/.test(s))
    return ["airport to town", "return trip"];
  if (/laundry|wash/.test(s))
    return ["per load", "per kg"];

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

// ─── Parse hospitality item input: "1", "2", "1×3", "1×2, 2×1", "1, 2" ────────
// Supports:
//   "1"       → item 1, qty 1
//   "2"       → item 2, qty 1
//   "1×3"     → item 1, qty 3 (e.g. 3 nights)
//   "1×2, 2"  → item 1 qty 2 + item 2 qty 1
//   "1, 2"    → item 1 qty 1 + item 2 qty 1
// Falls back to name lookup if no numbers found
function _parseHospitalityInput(raw, knownItems = []) {
  const results = [];

  // Split on commas - each segment is one item selection
  const parts = raw.split(/,\s*/).map(s => s.trim()).filter(Boolean);

  for (const part of parts) {
    // Match: number optionally followed by ×qty (or xQty)
    const m = part.match(/^(\d+)(?:\s*[×xX]\s*(\d+(?:\.\d+)?))?$/);
    if (m) {
      const idx  = parseInt(m[1], 10) - 1;
      const qty  = m[2] ? parseFloat(m[2]) : 1;
      const item = knownItems[idx];
      if (item) {
        results.push({
          name:  item.service,
          qty,
          price: item._unitPrice || 0,
          unit:  item._unit || "night"
        });
      }
    } else {
      // No number match - try name lookup (buyer typed the name)
      const lc = part.toLowerCase().trim();
      const found = knownItems.find(i => i.service?.toLowerCase().trim() === lc);
      if (found) {
        results.push({ name: found.service, qty: 1, price: found._unitPrice || 0, unit: found._unit || "night" });
      } else {
        results.push({ name: part, qty: 1, price: 0, unit: "night" });
      }
    }
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