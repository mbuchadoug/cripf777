// services/supplierSmartLink.js
// ─── ZimQuote Supplier Smart Link Engine ─────────────────────────────────────
//
// Handles:
//   1. Slug generation & assignment (human-readable, collision-safe)
//   2. Deep link & QR code URL building
//   3. Source-aware link generation (Facebook, TikTok, WhatsApp Status, QR, SMS)
//   4. Analytics increment (views, conversions, per-source)
//   5. Intelligent profile card text for the chatbot (shown when buyer opens link)
//   6. Sharable caption text per source channel
//
// Deep link format (WhatsApp only):
//   https://wa.me/<BOT_NUMBER>?text=ZQ:SUPPLIER:<supplierId>
//   With source tracking:
//   https://wa.me/<BOT_NUMBER>?text=ZQ:SUPPLIER:<supplierId>:SRC:<source>
//
// QR code: uses Google Charts API (no extra dependency)
//   https://chart.googleapis.com/chart?cht=qr&chs=400x400&chl=<encoded_wa_link>
//
// Admin generates links at:
//   GET /zq-admin/suppliers/:id/smart-link        → view page
//   POST /zq-admin/suppliers/:id/smart-link/assign → assign / regenerate slug
//   GET /zq-admin/suppliers/:id/smart-link/qr      → redirect to QR image URL
//
// Chatbot intercepts:
//   ZQ:SUPPLIER:<id>           → standard deep link (source = "direct")
//   ZQ:SUPPLIER:<id>:SRC:fb    → Facebook (source = "fb")
//   ZQ:SUPPLIER:<id>:SRC:wa    → WhatsApp Status (source = "wa")
//   ZQ:SUPPLIER:<id>:SRC:tt    → TikTok (source = "tt")
//   ZQ:SUPPLIER:<id>:SRC:qr    → QR scan (source = "qr")
//   ZQ:SUPPLIER:<id>:SRC:sms   → SMS/flyer (source = "sms")
//   ZQ:SUPPLIER:<id>:SRC:ig    → Instagram (source = "ig")
//   ZQ:SUPPLIER:<id>:SRC:yt    → YouTube (source = "yt")

import SupplierProfile from "../models/supplierProfile.js";

// ─── Config ───────────────────────────────────────────────────────────────────
const BOT_NUMBER   = (process.env.WHATSAPP_BOT_NUMBER || "263771143904").replace(/\D/g, "");
const BOT_WA_URL   = `https://wa.me/${BOT_NUMBER}`;

// Source codes for tracking - keep short so URLs stay clean
export const LINK_SOURCES = {
  fb:     "Facebook",
  wa:     "WhatsApp Status",
  tt:     "TikTok",
  qr:     "QR Scan",
  sms:    "SMS / Flyer",
  ig:     "Instagram",
  yt:     "YouTube",
  direct: "Direct / Unknown",
};

// ─── Slug generation ──────────────────────────────────────────────────────────

/**
 * Generate a candidate slug from businessName.
 * e.g. "Chipo's Plumbing & Hardware (Harare)" → "chipos-plumbing-hardware"
 */
export function generateSlugCandidate(businessName = "") {
  return String(businessName)
    .toLowerCase()
    .replace(/[''`]/g, "")             // strip apostrophes
    .replace(/[^a-z0-9\s-]/g, " ")    // non-alphanum → space
    .trim()
    .replace(/\s+/g, "-")             // spaces → hyphens
    .replace(/-{2,}/g, "-")           // collapse double hyphens
    .slice(0, 40)                      // max 40 chars
    .replace(/-$/, "");               // strip trailing hyphen
}

/**
 * Find a unique slug for a supplier.
 * Tries: slug → slug-2 → slug-3 … up to slug-99
 * Returns the available slug string, or null if exhausted (shouldn't happen).
 */
export async function findUniqueSlug(businessName, excludeSupplierId = null) {
  const base = generateSlugCandidate(businessName);
  if (!base) return null;

  for (let attempt = 1; attempt <= 99; attempt++) {
    const candidate = attempt === 1 ? base : `${base}-${attempt}`;
    const query = { zqSlug: candidate };
    if (excludeSupplierId) query._id = { $ne: excludeSupplierId };

    const existing = await SupplierProfile.findOne(query).lean();
    if (!existing) return candidate;
  }
  return null;
}

/**
 * Assign a slug to a supplier (idempotent - won't overwrite an existing slug
 * unless force=true).
 * Returns the final slug string.
 */
export async function assignSlugToSupplier(supplierId, { force = false } = {}) {
  const supplier = await SupplierProfile.findById(supplierId);
  if (!supplier) throw new Error("Supplier not found");

  if (supplier.zqSlug && !force) return supplier.zqSlug;

  const slug = await findUniqueSlug(supplier.businessName, supplierId);
  if (!slug) throw new Error("Could not generate a unique slug");

  supplier.zqSlug = slug;
  await supplier.save();
  return slug;
}

// ─── Link builders ────────────────────────────────────────────────────────────

/**
 * Build the WhatsApp deep link for a supplier.
 * source: one of the LINK_SOURCES keys, or null for plain link
 */
export function buildDeepLink(supplierId, source = null) {
  const payload = source
    ? `ZQ:SUPPLIER:${supplierId}:SRC:${source}`
    : `ZQ:SUPPLIER:${supplierId}`;
  return `${BOT_WA_URL}?text=${encodeURIComponent(payload)}`;
}

/**
 * Build all source-tagged links for a supplier in one call.
 * Returns { direct, fb, wa, tt, qr, sms, ig, yt }
 */
export function buildAllLinks(supplierId) {
  const links = {};
  for (const src of Object.keys(LINK_SOURCES)) {
    links[src] = buildDeepLink(supplierId, src === "direct" ? null : src);
  }
  return links;
}

/**
 * Build the QR code image URL for a supplier's direct deep link.
 * Uses Google Charts API - no additional npm package needed.
 */
export function buildQrImageUrl(supplierId, sizePx = 400) {
  const link = buildDeepLink(supplierId, "qr");
  const encoded = encodeURIComponent(link);
  return `https://chart.googleapis.com/chart?cht=qr&chs=${sizePx}x${sizePx}&chl=${encoded}&choe=UTF-8`;
}

// ─── Analytics ────────────────────────────────────────────────────────────────

/**
 * Record a link view/open. Call from chatbot ZQ:SUPPLIER intercept.
 * source: "fb" | "wa" | "tt" | "qr" | "sms" | "ig" | "yt" | "direct"
 * isConversion: true when buyer completes an action (quote request, order, booking)
 * visitorPhone: the WhatsApp number of the person who opened the link (from chatbot `from`)
 */
export async function trackLinkEvent(supplierId, { source = "direct", isConversion = false, visitorPhone = null } = {}) {
  try {
    const inc = {
      zqLinkViews: 1,
      viewCount: 1,
      monthlyViews: 1,
    };
    if (isConversion) inc.zqLinkConversions = 1;

    // Per-source view counters stored as zqSourceViews.fb, zqSourceViews.wa etc.
    const srcKey = Object.keys(LINK_SOURCES).includes(source) ? source : "direct";
    inc[`zqSourceViews.${srcKey}`] = 1;
    if (isConversion) inc[`zqSourceConversions.${srcKey}`] = 1;

    await SupplierProfile.findByIdAndUpdate(supplierId, { $inc: inc });

    // ── Capture visitor phone in SupplierLinkVisitor (non-blocking) ──────────
    // This powers the "my contacts" chatbot command and the admin contacts page.
    if (visitorPhone) {
      _captureSupplierVisitor({ supplierId, phone: visitorPhone, source, isConversion }).catch(() => {});
    }
  } catch (err) {
    // Non-critical - never throw
    console.error("[SMART LINK TRACK]", err.message);
  }
}

/**
 * Upsert a SupplierLinkVisitor record for a supplier smart link open.
 * One document per phone+supplierId (linkType="supplier").
 * Non-blocking: called fire-and-forget from trackLinkEvent.
 */
async function _captureSupplierVisitor({ supplierId, phone, source = "direct", isConversion = false }) {
  try {
    const SupplierLinkVisitor = (await import("../models/supplierLinkVisitor.js")).default;
    const normPhone = String(phone).replace(/\D+/g, "");
    if (!normPhone || normPhone.length < 9) return;

    const update = {
      $set:  { lastSeen: new Date(), source },
      $inc:  { viewCount: 1 },
      $setOnInsert: { firstSeen: new Date(), phone: normPhone, supplierId, linkType: "supplier" }
    };
    if (isConversion) {
      update.$set.converted   = true;
      update.$set.convertedAt = new Date();
    }
    await SupplierLinkVisitor.findOneAndUpdate(
      { supplierId, phone: normPhone, linkType: "supplier" },
      update,
      { upsert: true }
    );
  } catch (err) {
    console.warn("[SUPPLIER VISITOR CAPTURE]", err.message);
  }
}

// ─── Chatbot: parse ZQ:SUPPLIER payload ───────────────────────────────────────

/**
 * Parse a ZQ:SUPPLIER text payload into its components.
 * Input:  "ZQ:SUPPLIER:6630a1b2c3d4e5f678901234"
 *         "ZQ:SUPPLIER:6630a1b2c3d4e5f678901234:SRC:fb"
 * Returns: { supplierId, source } or null if not a valid payload
 */
export function parseSupplierDeepLink(text = "") {
  const clean = String(text || "").trim();
  // Match: ZQ:SUPPLIER:<24-char hex>  optionally :SRC:<src>
  const m = clean.match(/^ZQ:SUPPLIER:([a-f0-9]{24})(?::SRC:([a-z]+))?/i);
  if (!m) return null;
  return {
    supplierId: m[1],
    source:     (m[2] || "direct").toLowerCase()
  };
}

// ─── Intelligent chatbot profile card ────────────────────────────────────────

/**
 * Build the smart profile card text shown to a buyer when they open a supplier link.
 * This replaces the basic showSellerMenu text with a richer, structured card.
 *
 * Covers:
 *   - Business name, verification badge
 *   - Stock status with last-updated freshness
 *   - Top 5 items with prices (or top 3 service rates)
 *   - Credibility signals: rating, order count, response speed
 *   - Delivery / collection indicator
 *   - Min order / payment methods
 *   - Contextual calls to action based on what the seller has set up
 */
export function buildProfileCard(supplier) {
  if (!supplier) return null;

  const isService = supplier.profileType === "service";
  const name      = supplier.businessName || "Seller";
  const area      = supplier.location?.area || "";
  const city      = supplier.location?.city || "";
  const location  = [area, city].filter(Boolean).join(", ");

  // ── Verification / badge line ─────────────────────────────────────────────
  const verifiedBadge = supplier.verified       ? " ✅"  : "";
  const topBadge      = supplier.topSupplierBadge ? " 🏅" : "";

  // ── Stock status ──────────────────────────────────────────────────────────
  const stockIcon = {
    in_stock:     "🟢 In Stock",
    low_stock:    "🟡 Low Stock",
    out_of_stock: "🔴 Out of Stock"
  }[supplier.stockStatus] || "🟢 In Stock";

  const priceUpdated = supplier.priceUpdatedAt
    ? _relativeTime(new Date(supplier.priceUpdatedAt))
    : null;
  const stockLine = priceUpdated
    ? `${stockIcon} · Prices updated ${priceUpdated}`
    : stockIcon;

  // ── Rating & credibility ──────────────────────────────────────────────────
  const hasRating  = (supplier.reviewCount || 0) > 0;
  const ratingLine = hasRating
    ? `⭐ ${Number(supplier.rating).toFixed(1)}/5 (${supplier.reviewCount} review${supplier.reviewCount === 1 ? "" : "s"})`
    : "";
  const ordersLine = (supplier.completedOrders || 0) > 0
    ? `✅ ${supplier.completedOrders} completed order${supplier.completedOrders === 1 ? "" : "s"}`
    : "";
  const responseTimeLabel = _formatResponseTime(supplier.avgResponseMinutes);
  const responseLine = responseTimeLabel ? `⚡ Replies ${responseTimeLabel}` : "";

  // ── Products / services preview ───────────────────────────────────────────
  let catalogueLines = "";
  if (isService) {
    // BUG FIX: rates[] often empty even when listedProducts[]/products[] has services.
    // Fall through: rates → listedProducts → products - always show something real.
    const hasRates = (supplier.rates || []).length > 0;
    if (hasRates) {
      const allRates = (supplier.rates || []).filter(r => r.service);
      catalogueLines = allRates.slice(0, 5)
        .map(r => `• ${r.service}${r.rate ? "  -  " + r.rate : ""}`)
        .join("\n");
      const extraRates = allRates.length - 5;
      if (extraRates > 0) catalogueLines += `\n_...and ${extraRates} more services_`;
    } else {
      const serviceList = (supplier.listedProducts?.length
        ? supplier.listedProducts
        : (supplier.products || [])
      ).filter(p => p && p !== "pending_upload");
      catalogueLines = serviceList
        .slice(0, 6)
        .map(p => `• ${p}`)
        .join("\n");
      const extraSvcs = serviceList.length - 6;
      if (extraSvcs > 0) catalogueLines += `\n_...and ${extraSvcs} more services_`;
    }
  } else {
    // Product supplier - prefer prices list (has amounts), fall back to listedProducts
    const priced = (supplier.prices || []).filter(p => p.inStock !== false).slice(0, 6);
    if (priced.length) {
      catalogueLines = priced
        .map(p => {
          const price = p.amount ? `$${Number(p.amount).toFixed(2)}/${p.unit || "each"}` : "price on request";
          return `• ${p.product}  -  ${price}`;
        })
        .join("\n");
      const extra = (supplier.prices || []).length - priced.length;
      if (extra > 0) catalogueLines += `\n_...and ${extra} more items_`;
    } else if ((supplier.listedProducts || []).length) {
      catalogueLines = (supplier.listedProducts || []).slice(0, 6)
        .map(p => `• ${p}`)
        .join("\n");
    }
  }

  // ── Delivery ──────────────────────────────────────────────────────────────
  // BUG FIX: Service providers with travelAvailable=true TRAVEL TO CLIENTS.
  // NEVER show "Collection only" for cleaning/plumbing/service providers.
  let deliveryLine = "";
  if (isService) {
    if (supplier.travelAvailable) {
      const svcArea = supplier.serviceArea || city || location;
      deliveryLine = `🚗 Travels to clients · ${svcArea}`;
    } else {
      deliveryLine = `📍 Based in ${location}`;
    }
  } else {
    const del = supplier.delivery;
    if (del?.available) {
      const rangeLabel = { area_only: "area only", city_wide: "citywide", nationwide: "nationwide" }[del.range] || "";
      const feeLabel   = del.fee > 0 ? ` · Delivery fee: $${Number(del.fee).toFixed(2)}` : " · Free delivery";
      deliveryLine = `🚚 Delivers ${rangeLabel}${feeLabel}`;
    } else {
      deliveryLine = `🏠 Collection only · ${location}`;
    }
  }

  // ── Min order ─────────────────────────────────────────────────────────────
  const minOrderLine = supplier.minOrder > 0
    ? `Min order: $${Number(supplier.minOrder).toFixed(2)}`
    : "";

  // ── HOSPITALITY card - route to dedicated builder ────────────────────────
  if (supplier.profileType === "hospitality") {
    return _buildHospitalityCard(supplier, {
      name, location, city, area, verifiedBadge, topBadge,
      ratingLine, ordersLine, responseLine
    });
  }

  // ── Standard card (product / service) ─────────────────────────────────────
  const lines = [
    `${isService ? "🔧" : "🏪"} *${name}*${verifiedBadge}${topBadge}`,
    `📍 ${location}`,
    stockLine,
  ];

  const credibility = [ratingLine, ordersLine, responseLine].filter(Boolean).join(" · ");
  if (credibility) lines.push(credibility);

  if (catalogueLines) {
    lines.push(""); // blank separator
    lines.push(isService ? "🛠 *Services:*" : "📦 *Items & Prices:*");
    lines.push(catalogueLines);
  }

  lines.push(""); // separator before logistics
  lines.push(deliveryLine);
  if (minOrderLine) lines.push(minOrderLine);

  return lines.join("\n");
}

// ─── Hospitality profile card builder ────────────────────────────────────────
function _buildHospitalityCard(supplier, { name, location, city, verifiedBadge, topBadge, ratingLine, ordersLine, responseLine }) {
  const SUBTYPE_LABELS = {
    lodge:"🌿 Lodge", hotel:"🏨 Hotel", guesthouse:"🏡 Guesthouse/B&B",
    self_catering:"🍳 Self-Catering", campsite:"⛺ Campsite",
    safari_operator:"🦁 Safari Operator", tour_guide:"🗺 Tour Guide",
    boat_hire:"⛵ Boat Hire", travel_agency:"✈️ Travel Agency"
  };
  const FACILITY_LABELS = {
    wifi:"📶 WiFi", pool:"🏊 Pool", hot_shower:"🚿 Hot shower",
    breakfast:"🍳 Breakfast", en_suite:"🚪 En-suite", generator:"⚡ Generator/Solar",
    dstv:"📺 DSTV", braai:"🔥 Braai", aircon:"❄️ AC",
    game_drives:"🦁 Game drives", fishing:"🎣 Fishing", boat_hire:"⛵ Boat hire",
    conference:"🏢 Conference", restaurant:"🍽 Restaurant/Bar", laundry:"👕 Laundry",
    parking:"🅿️ Parking", pets_allowed:"🐕 Pets OK", child_friendly:"👶 Child-friendly"
  };

  const subtypes = supplier.tourismSubtype || [];
  const subtypeLabel = subtypes.length
    ? subtypes.map(s => SUBTYPE_LABELS[s] || s).join(" · ")
    : "🏨 Hospitality";

  const isAccom = subtypes.length === 0 ||
    subtypes.some(s => ["lodge","hotel","guesthouse","self_catering","campsite"].includes(s));

  // ── Areas served ──────────────────────────────────────────────────────────
  const areas = (supplier.tourismAreas || []);
  const locLine = areas.length
    ? "📍 " + location + "  ·  🌍 " + areas.join(", ")
    : "📍 " + location;

  // ── Room types with night + rest rates ────────────────────────────────────
  let roomLines = "";
  if ((supplier.roomTypes || []).length > 0) {
    roomLines = (supplier.roomTypes || []).slice(0, 6).map(rt => {
      const night = rt.pricePerNight > 0 ? "$" + Number(rt.pricePerNight).toFixed(0) + "/night" : null;
      const rest  = rt.restRate > 0      ? "$" + Number(rt.restRate).toFixed(0) + "/rest"        : null;
      const rates = [night, rest].filter(Boolean).join(" · ");
      const cap   = rt.capacity > 0 ? " (sleeps " + rt.capacity + ")" : "";
      return "• " + rt.name + (rates ? " - " + rates : "") + cap;
    }).join("\n");
  }

  // ── Activities / rates - shown for ALL hospitality providers that have them ─
  // Mixed operators (e.g. lodge + safari + boat hire) show BOTH rooms AND activities.
  let activityLines = "";
  if ((supplier.rates || []).length > 0) {
    const allRates = (supplier.rates || []).filter(r => r.service);
    activityLines = allRates.slice(0, 6).map(r =>
      "• " + r.service + (r.rate ? " - " + r.rate : " - price on request")
    ).join("\n");
    const moreRates = allRates.length - 6;
    if (moreRates > 0) activityLines += "\n_...and " + moreRates + " more activities_";
  }

  // ── Extra services (activities, tours, etc.) ─────────────────────────────
  let extraLines = "";
  if ((supplier.extraServices || []).length > 0) {
    const allExtras = supplier.extraServices || [];
    extraLines = allExtras.slice(0, 8).map(es =>
      "• " + es.name + (es.price > 0 ? " - $" + Number(es.price).toFixed(0) + "/" + (es.unit || "service") : " - price on request")
    ).join("\n");
    const moreExtras = allExtras.length - 8;
    if (moreExtras > 0) extraLines += "\n_...and " + moreExtras + " more services_";
  }

  // ── Facilities ────────────────────────────────────────────────────────────
  const facilLine = (supplier.facilities || []).length
    ? (supplier.facilities || []).slice(0, 8).map(f => FACILITY_LABELS[f] || f).join("  ·  ")
    : "";

  // ── Check-in/out ──────────────────────────────────────────────────────────
  const ciLine = (supplier.checkInTime || supplier.checkOutTime)
    ? "⏰ Check-in: " + (supplier.checkInTime || "?") + "  ·  Check-out: " + (supplier.checkOutTime || "?")
    : "";

  // ── Capacity ──────────────────────────────────────────────────────────────
  const capLine = supplier.maxCapacity > 0
    ? "👥 Sleeps up to " + supplier.maxCapacity + " guests"
    : "";

  // ── Rating / credibility ──────────────────────────────────────────────────
  const credibility = [ratingLine, ordersLine, responseLine].filter(Boolean).join(" · ");

  // ── Build card ────────────────────────────────────────────────────────────
  const lines = [
    "🏨 *" + name + "*" + verifiedBadge + topBadge,
    subtypeLabel,
    locLine,
  ];

  if (credibility) lines.push(credibility);
  if (capLine)     lines.push(capLine);

  // Show rooms section if provider has rooms
  if (roomLines) {
    lines.push("");
    lines.push("🛏 *Rooms & Rates:*");
    lines.push(roomLines);
    const moreRooms = (supplier.roomTypes || []).length - 6;
    if (moreRooms > 0) lines.push("_...and " + moreRooms + " more room types_");
  }

  // Show activities section if provider has rates (shown for ALL - mixed operators get both)
  if (activityLines) {
    lines.push("");
    lines.push("🎯 *Activities & Tours:*");
    lines.push(activityLines);
  }

  // Extra services (e.g. airport transfer, fishing, canoe hire entered in admin)
  if (extraLines) {
    lines.push("");
    // If no rates but has extraServices, use Activities label; else "Additional Services"
    const extraLabel = !activityLines ? "🎯 *Activities & Services:*" : "➕ *Also Available:*";
    lines.push(extraLabel);
    lines.push(extraLines);
  }

  if (facilLine) {
    lines.push("");
    lines.push("🏷 *Facilities:*");
    lines.push(facilLine);
  }

  if (ciLine) lines.push(ciLine);

  return lines.join("\n");
}

// ─── Sharable caption text per channel ───────────────────────────────────────

/**
 * Build ready-to-copy caption text for each sharing channel.
 * The seller can copy-paste this alongside their QR or link.
 */
export function buildSharableCaption(supplier, source = "wa") {
  if (!supplier) return "";

  const name     = supplier.businessName || "My Business";
  const area     = supplier.location?.area || "";
  const city     = supplier.location?.city || "";
  const location = [area, city].filter(Boolean).join(", ");
  const isService = supplier.profileType === "service";

  // For hospitality: build teaser from roomTypes and extraServices
  if (supplier.profileType === "hospitality") {
    const hospLink = buildDeepLink(String(supplier._id), source);
    const subtypes = (supplier.tourismSubtype || []);
    const isAccom  = subtypes.length === 0 || subtypes.some(s => ["lodge","hotel","guesthouse","self_catering","campsite"].includes(s));
    const rooms    = (supplier.roomTypes || []).slice(0, 3).map(r => {
      const rates = [
        r.pricePerNight > 0 ? "$" + Number(r.pricePerNight).toFixed(0) + "/night" : null,
        r.restRate > 0      ? "$" + Number(r.restRate).toFixed(0) + "/rest"        : null
      ].filter(Boolean).join(" · ");
      return r.name + (rates ? " - " + rates : "");
    });
    const facilities = (supplier.facilities || []).slice(0, 4).map(f => ({
      wifi:"WiFi",pool:"Pool",breakfast:"Breakfast",en_suite:"En-suite",
      braai:"Braai",aircon:"AC",game_drives:"Game Drives",fishing:"Fishing",
      hot_shower:"Hot shower",restaurant:"Restaurant",parking:"Parking",
      dstv:"DSTV",generator:"Power backup",child_friendly:"Child-friendly"
    }[f] || f)).join(" · ");
    const roomTeaser = rooms.join("\n");

    const hospCaptions = {
      wa:  ["🏨 *" + name + "* - " + location, subtypes.length ? subtypes.map(s => ({lodge:"🌿 Lodge",hotel:"🏨 Hotel",guesthouse:"🏡 Guesthouse",self_catering:"🍳 Self-Catering",campsite:"⛺ Campsite",safari_operator:"🦁 Safari",tour_guide:"🗺 Tours",boat_hire:"⛵ Boat hire",travel_agency:"✈️ Travel"}[s]||s)).join(" · ") : "🏨 Hospitality", roomTeaser, facilities ? "✅ " + facilities : "", "", "📲 Book or request a quote on WhatsApp:", hospLink].filter(Boolean).join("\n"),
      fb:  [isAccom ? "🌿 Looking for a perfect stay? " + name + " is now on ZimQuote!" : "🦁 Adventures await! " + name + " is now on ZimQuote!", "", roomTeaser || "Accommodation in " + location, facilities ? "✅ " + facilities : "", "", "📲 Request a quote instantly on WhatsApp - no app download needed.", "", hospLink, "#ZimQuote #Zimbabwe #Tourism #" + city.replace(/\s/g,"")].filter(Boolean).join("\n"),
      tt:  ["Book your stay at " + name + " on ZimQuote 👇", hospLink, "#ZimQuote #ZimbabweTourism #" + name.replace(/\s/g,"")].join("\n"),
      sms: [name + " - " + location, roomTeaser || "", "Book on WhatsApp: " + hospLink].filter(Boolean).join("\n"),
      ig:  ["🏨 " + name + " | " + location, roomTeaser, facilities ? "✅ " + facilities : "", "", "Request a quote on WhatsApp 👇", hospLink, "#ZimQuote #Zimbabwe #" + city.replace(/\s/g,"") + " #Tourism"].filter(Boolean).join("\n"),
    };
    return hospCaptions[source] || hospCaptions.wa;
  }

  // Top 3 items/services as a teaser - same fallback chain: rates → listedProducts → products
  const items = isService
    ? ((supplier.rates || []).length > 0
        ? (supplier.rates || []).slice(0, 3).map(r => r.service)
        : ((supplier.listedProducts || supplier.products || []).filter(p => p && p !== "pending_upload").slice(0, 3)))
    : (supplier.prices || []).filter(p => p.inStock !== false).slice(0, 3).map(p =>
        p.amount ? `${p.product} @ $${Number(p.amount).toFixed(2)}` : p.product
      );

  const itemTeaser = items.length
    ? items.join(" · ")
    : (supplier.listedProducts || []).slice(0, 3).join(" · ");

  const link = buildDeepLink(String(supplier._id), source);

  const captions = {
    wa: [
      `🏪 *${name}* - ${location}`,
      itemTeaser ? `📦 ${itemTeaser}` : "",
      ``,
      `💬 Get prices & quotes instantly on WhatsApp:`,
      link,
    ].filter(l => l !== null).join("\n"),

    fb: [
      `🔥 ${name} is now on ZimQuote!`,
      ``,
      itemTeaser ? `We stock: ${itemTeaser}` : `${isService ? "Services" : "Products"} available in ${location}`,
      ``,
      `📲 Tap the link to browse, get a quote, or place an order - all on WhatsApp. No app downloads needed.`,
      ``,
      link,
      `#ZimQuote #Zimbabwe #${city.replace(/\s/g, "")} #${isService ? "Services" : "Shopping"}`,
    ].filter(l => l !== null).join("\n"),

    tt: [
      `See my prices on ZimQuote 👇`,
      link,
      `#ZimQuote #Zimbabwe #${city.replace(/\s/g, "")} #${name.replace(/\s/g, "")}`,
    ].join("\n"),

    sms: [
      `${name} - ${location}`,
      itemTeaser || "",
      `Get prices & quotes: ${link}`,
    ].filter(Boolean).join("\n"),

    ig: [
      `📦 ${name} | ${location}`,
      itemTeaser ? `✔ ${itemTeaser}` : "",
      ``,
      `Get instant quotes on WhatsApp 👇`,
      link,
      `#ZimQuote #Zimbabwe #${city.replace(/\s/g, "")}`,
    ].filter(Boolean).join("\n"),
  };

  return captions[source] || captions.wa;
}

// ─────────────────────────────────────────────────────────────────────────────
// SMART LINK BENEFITS CARD
// ─────────────────────────────────────────────────────────────────────────────
// Explains to a seller why their ZimQuote link is better than WhatsApp Business,
// Facebook, or a website - with real Zimbabwe context.
//
// ZIM REALITY:
//   • Building a website costs $200-500 upfront + $15/mo hosting - most sellers can't afford it
//   • Facebook algorithm hides posts unless you pay to boost
//   • WhatsApp Business can't reach outside 24hr window, no PDF quotes, no analytics
//   • ZimQuote link: FREE with subscription, works on any phone, WhatsApp-native,
//     instant quotes, PDF delivery, seller notified every view, tracks which platform works
//   • Economy is USD cash-based: buyers want a quote before committing, not guessing
//   • Power cuts, data costs, bad internet: ZimQuote is lightweight, works on $1 bundles
//
export function buildSmartLinkBenefitsCard(supplier) {
  const views    = supplier?.zqLinkViews || 0;
  const converts = supplier?.zqLinkConversions || 0;
  const sources  = supplier?.zqSourceViews || {};

  const sourceLabels = {
    fb: "Facebook", wa: "WhatsApp", tt: "TikTok",
    qr: "QR Code", sms: "SMS/Flyer", ig: "Instagram",
    yt: "YouTube", direct: "Direct"
  };
  const sourceBreakdown = Object.entries(sources)
    .filter(([, v]) => v > 0)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 4)
    .map(([k, v]) => `  • ${sourceLabels[k] || k}: ${v} view${v === 1 ? "" : "s"}`)
    .join("\n");

  const lines = [
    `🔗 *Your ZimQuote Smart Link*`,
    ``,
    `📊 *Your stats so far:*`,
    `  👁 ${views} profile view${views === 1 ? "" : "s"} total`,
    `  ✅ ${converts} buyer action${converts === 1 ? "" : "s"} (quote/booking/enquiry)`,
    sourceBreakdown ? `\n📱 *Where buyers come from:*\n${sourceBreakdown}` : "",
    ``,
    `─────────────────`,
    `💡 *Why your ZimQuote link beats other options:*`,
    ``,
    `📱 *vs WhatsApp Business:*`,
    `  • We reach buyers outside 24hr window - they can't`,
    `  • We send PDF quotes automatically - they can't`,
    `  • We show analytics per source - they don't`,
    `  • We notify you every time someone opens your link`,
    ``,
    `📘 *vs Facebook page:*`,
    `  • Facebook: buyer messages you, you quote manually (1-2 hrs lost)`,
    `  • ZimQuote: buyer taps → quote generated → PDF sent instantly`,
    `  • Facebook algorithm hides your posts unless you pay to boost`,
    `  • ZimQuote: your link always works, no algorithm`,
    ``,
    `🌐 *vs a website:*`,
    `  • Website: $200-500 to build, $15+/month to host`,
    `  • ZimQuote link: FREE with your $5/month subscription`,
    `  • Your link lives on WhatsApp - where your buyers already are`,
    `  • No data-heavy app download needed`,
    ``,
    `─────────────────`,
    `🎯 *How to get more from your link:*`,
    `  1. Add it to your Facebook / TikTok bio`,
    `  2. Print as QR code on flyers, receipts, business cards`,
    `  3. Post it in your WhatsApp Status`,
    `  4. Share in neighbourhood WhatsApp groups`,
    `  5. Put it in your email signature / SMS`,
    ``,
    `Each source is tracked separately - you will see exactly`,
    `which platform brings you the most buyers.`,
  ].filter(l => l !== "").join("\n");

  return lines;
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

function _relativeTime(date) {
  if (!date || !(date instanceof Date)) return null;
  const ms   = Date.now() - date.getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 60)  return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24)   return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7)   return `${days}d ago`;
  return date.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

function _formatResponseTime(avgMinutes) {
  if (avgMinutes === null || avgMinutes === undefined) return null;
  const m = Number(avgMinutes);
  if (m <= 5)   return "instantly";
  if (m <= 30)  return "within 30 mins";
  if (m <= 60)  return "within the hour";
  if (m <= 240) return "within a few hours";
  if (m <= 1440)return "same day";
  return null; // too slow to advertise
}