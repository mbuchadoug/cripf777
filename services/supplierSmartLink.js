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

// Source codes for tracking — keep short so URLs stay clean
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
 * Assign a slug to a supplier (idempotent — won't overwrite an existing slug
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
 * Uses Google Charts API — no additional npm package needed.
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
 */
export async function trackLinkEvent(supplierId, { source = "direct", isConversion = false } = {}) {
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
  } catch (err) {
    // Non-critical — never throw
    console.error("[SMART LINK TRACK]", err.message);
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
    const rates = (supplier.rates || []).slice(0, 4);
    if (rates.length) {
      catalogueLines = rates
        .map(r => `• ${r.service}${r.rate ? "  —  " + r.rate : ""}`)
        .join("\n");
    } else if ((supplier.listedProducts || []).length) {
      catalogueLines = (supplier.listedProducts || []).slice(0, 4)
        .map(p => `• ${p}`)
        .join("\n");
    }
  } else {
    // Product supplier — prefer prices list (has amounts), fall back to listedProducts
    const priced = (supplier.prices || []).filter(p => p.inStock !== false).slice(0, 6);
    if (priced.length) {
      catalogueLines = priced
        .map(p => {
          const price = p.amount ? `$${Number(p.amount).toFixed(2)}/${p.unit || "each"}` : "price on request";
          return `• ${p.product}  —  ${price}`;
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
  let deliveryLine = "";
  if (isService) {
    if (supplier.travelAvailable) {
      deliveryLine = `🚗 Travels to clients · ${supplier.serviceArea || city}`;
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

  // ── Assemble card ─────────────────────────────────────────────────────────
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

  // Top 3 items/services as a teaser
  const items = isService
    ? (supplier.rates || []).slice(0, 3).map(r => r.service)
    : (supplier.prices || []).filter(p => p.inStock !== false).slice(0, 3).map(p => {
        return p.amount ? `${p.product} @ $${Number(p.amount).toFixed(2)}` : p.product;
      });

  const itemTeaser = items.length
    ? items.join(" · ")
    : (supplier.listedProducts || []).slice(0, 3).join(" · ");

  const link = buildDeepLink(String(supplier._id), source);

  const captions = {
    wa: [
      `🏪 *${name}* — ${location}`,
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
      `📲 Tap the link to browse, get a quote, or place an order — all on WhatsApp. No app downloads needed.`,
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
      `${name} — ${location}`,
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