// services/staffSmartLink.js
// ─── ZimQuote Staff E-Business Card Smart Link Engine ─────────────────────────
//
// WHAT THIS DOES:
//   Full smart link engine for staff/salesperson e-business cards.
//   Mirrors supplierSmartLink.js in structure but operates on StaffCard docs.
//
// EACH STAFF MEMBER GETS:
//   • Their own WhatsApp deep link   ZQ:STAFF:<cardId>:SRC:fb
//   • Their own slug                 zibugold-construction-muchaneta
//   • Their own QR code              printable, 400px or 600px (for business cards)
//   • Their own analytics            views / conversions per source channel
//   • Their own notification         outside 24hr window via Meta template
//   • Sharable captions              per channel (WA, FB, TikTok, SMS, IG)
//
// NOTIFICATION FLOW (outside 24hr Meta window):
//   When buyer opens staff link:
//     1. staff_card_opened template → salesperson's phone
//     2. supplier_link_opened template → owner + notificationContacts (existing)
//   When buyer sends enquiry/quote via staff link:
//     1. staff_card_enquiry template → salesperson's phone
//     2. supplier_new_buyer_request template → owner (existing)
//
// CHATBOT INTERCEPT (add to chatbotEngine.js):
//   } else if (/ZQ:STAFF:/i.test(text)) {
//     const handled = await handleStaffDeepLink({ from, text, biz, saveBiz });
//     if (handled) return;
//   }
//
// ALSO NEEDED IN schoolSearch.js handleZqDeepLink():
//   See bottom of this file for the exact patch.
//
// ─────────────────────────────────────────────────────────────────────────────

import StaffCard       from "../models/staffCard.js";
import SupplierProfile from "../models/supplierProfile.js";

const BOT_NUMBER = (process.env.WHATSAPP_BOT_NUMBER || "263771143904").replace(/\D/g, "");
const BOT_WA_URL = `https://wa.me/${BOT_NUMBER}`;

function _normPhone(raw = "") {
  let p = String(raw).replace(/\D+/g, "");
  if (p.startsWith("0") && p.length === 10) p = "263" + p.slice(1);
  return p;
}

function _formatPhoneDisplay(raw = "") {
  const d = _normPhone(raw);
  if (d.startsWith("263") && d.length >= 12) {
    return `+263 ${d.slice(3, 5)} ${d.slice(5, 8)} ${d.slice(8)}`;
  }
  return d ? `+${d}` : raw;
}

export const STAFF_LINK_SOURCES = {
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

export function generateStaffSlugCandidate(businessName = "", staffName = "") {
  const cleanBiz = String(businessName)
    .toLowerCase().replace(/[''`]/g, "").replace(/[^a-z0-9\s-]/g, " ")
    .trim().replace(/\s+/g, "-").replace(/-{2,}/g, "-")
    .slice(0, 28).replace(/-$/, "");

  const firstName = String(staffName).trim().split(/\s+/)[0]
    .toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 15);

  if (!cleanBiz && !firstName) return null;
  return [cleanBiz, firstName].filter(Boolean).join("-");
}

export async function findUniqueStaffSlug(businessName, staffName, excludeCardId = null) {
  const base = generateStaffSlugCandidate(businessName, staffName);
  if (!base) return null;
  for (let attempt = 1; attempt <= 99; attempt++) {
    const candidate = attempt === 1 ? base : `${base}-${attempt}`;
    const query = { zqSlug: candidate };
    if (excludeCardId) query._id = { $ne: excludeCardId };
    const existing = await StaffCard.findOne(query).lean();
    if (!existing) return candidate;
  }
  return null;
}

export async function assignSlugToStaffCard(cardId, { force = false } = {}) {
  const card = await StaffCard.findById(cardId).lean();
  if (!card) throw new Error("Staff card not found");
  if (card.zqSlug && !force) return card.zqSlug;
  const supplier = await SupplierProfile.findById(card.supplierId).lean();
  const bizName  = supplier?.businessName || "staff";
  const slug = await findUniqueStaffSlug(bizName, card.name, cardId);
  if (!slug) throw new Error("Could not generate a unique staff slug");
  await StaffCard.findByIdAndUpdate(cardId, { $set: { zqSlug: slug } });
  return slug;
}

// ─── Link builders ────────────────────────────────────────────────────────────

export function buildStaffDeepLink(cardId, source = null) {
  const payload = source
    ? `ZQ:STAFF:${cardId}:SRC:${source}`
    : `ZQ:STAFF:${cardId}`;
  return `${BOT_WA_URL}?text=${encodeURIComponent(payload)}`;
}

export function buildAllStaffLinks(cardId) {
  const links = {};
  for (const src of Object.keys(STAFF_LINK_SOURCES)) {
    links[src] = buildStaffDeepLink(cardId, src === "direct" ? null : src);
  }
  return links;
}

export function buildStaffQrImageUrl(cardId, sizePx = 400) {
  // Build the raw WA link that the QR code should encode.
  // IMPORTANT: pass the payload UNENCODED to encodeURIComponent exactly once.
  // buildStaffDeepLink() already calls encodeURIComponent on the payload,
  // so calling encodeURIComponent on the whole URL again produces %253A (double-encode)
  // which breaks Google Charts. We build the raw URL ourselves here.
  const rawPayload = `ZQ:STAFF:${cardId}:SRC:qr`;
  const rawWaLink  = `${BOT_WA_URL}?text=${rawPayload}`;
  return `https://chart.googleapis.com/chart?cht=qr&chs=${sizePx}x${sizePx}&chl=${encodeURIComponent(rawWaLink)}&choe=UTF-8`;
}

// ─── Analytics tracking ───────────────────────────────────────────────────────

export async function trackStaffLinkEvent(cardId, { source = "direct", isConversion = false } = {}) {
  try {
    const srcKey = Object.keys(STAFF_LINK_SOURCES).includes(source) ? source : "direct";
    const inc = {
      zqLinkViews: 1,
      [`zqSourceViews.${srcKey}`]: 1,
    };
    if (isConversion) {
      inc.zqLinkConversions = 1;
      inc[`zqSourceConversions.${srcKey}`] = 1;
    }
    await StaffCard.findByIdAndUpdate(cardId, { $inc: inc });
  } catch (err) {
    console.error("[STAFF LINK TRACK]", err.message);
  }
}

// ─── Parse deep link payloads ─────────────────────────────────────────────────

export function parseStaffDeepLink(text = "") {
  const clean = String(text || "").trim();
  const m = clean.match(/^ZQ:STAFF:([a-f0-9]{24})(?::SRC:([a-z]+))?/i);
  if (!m) return null;
  return { cardId: m[1], source: m[2] || "direct" };
}

export function parseStaffSlugLink(text = "") {
  const clean = String(text || "").trim();
  const m = clean.match(/^ZQ:STAFF:SLUG:([a-z0-9-]+)(?::SRC:([a-z]+))?/i);
  if (!m) return null;
  return { slug: m[1].toLowerCase(), source: m[2] || "direct" };
}

export async function resolveStaffCardBySlug(slug) {
  return StaffCard.findOne({ zqSlug: slug.toLowerCase() }).lean();
}

// ─── Chatbot deep link handler ────────────────────────────────────────────────
// Wire into chatbotEngine.js before the ZQ:SUPPLIER block:
//
//   import { handleStaffDeepLink } from "./staffSmartLink.js";
//   ...
//   if (!isMetaAction && /ZQ:STAFF:/i.test(text)) {
//     const _handled = await handleStaffDeepLink({ from, text, biz, saveBiz });
//     if (_handled) return;
//   }
//
// ─────────────────────────────────────────────────────────────────────────────

export async function handleStaffDeepLink({ from, text, biz, saveBiz }) {
  const raw = String(text || "").trim();

  let cardId = null, source = "direct";

  // Try ID-based format first: ZQ:STAFF:<24-hex>[:SRC:<src>]
  const parsedById = parseStaffDeepLink(raw);
  if (parsedById) {
    cardId = parsedById.cardId;
    source = parsedById.source;
  } else {
    // Try slug-based: ZQ:STAFF:SLUG:<slug>[:SRC:<src>]
    const parsedBySlug = parseStaffSlugLink(raw);
    if (parsedBySlug) {
      const slugCard = await resolveStaffCardBySlug(parsedBySlug.slug);
      if (slugCard) { cardId = String(slugCard._id); source = parsedBySlug.source; }
    }
  }

  if (!cardId) return false;

  // Load card + parent supplier
  const card     = await StaffCard.findById(cardId).lean();
  const supplier = card ? await SupplierProfile.findById(card.supplierId).lean() : null;

  // Always track the view - even for inactive cards, so admin sees stale links still firing
  trackStaffLinkEvent(cardId, { source, isConversion: false }).catch(() => {});

  // Notify salesperson on their own phone (outside 24hr via Meta template)
  if (card?.phone) {
    _notifyStaffCardOpened(card, supplier, source, from).catch(() => {});
  }

  // Also notify business owner via existing supplier_link_opened flow
  // (they already receive notifications for all smart link opens)
  if (supplier?.phone) {
    import("./supplierNotifications.js")
      .then(({ notifyAllSupplierLinkOpened }) =>
        notifyAllSupplierLinkOpened(supplier, source, from).catch(() => {})
      ).catch(() => {});
  }

  if (!card || !supplier) {
    // Card deleted - send a generic fallback message
    const { sendText } = await import("./metaSender.js");
    await sendText(from, "This business card link is no longer active. Please contact the business directly.");
    return true;
  }

  if (!card.active) {
    // Card deactivated - fall through to parent supplier seamlessly
    // The buyer gets the full business experience, just without the staff attribution
    try {
      const { showSellerMenu } = await import("./sellerChat.js");
      await showSellerMenu(from, String(supplier._id), biz, saveBiz, { source, staffCardId: null });
    } catch (_) {
      const { sendText } = await import("./metaSender.js");
      await sendText(from, `Please contact ${supplier.businessName || "the business"} directly.`);
    }
    return true;
  }

  // Active card: send the staff member's personal profile card to the buyer FIRST,
  // so they see Muchaneta's name, title, phone and tagline before the catalogue menu.
  // This is what differentiates a staff card link from a plain company smart link.
  try {
    const { sendText }    = await import("./metaSender.js");
    const { showSellerMenu } = await import("./sellerChat.js");

    // ── Show the salesperson's personal card header to the buyer ─────────────
    const profileCardText = buildStaffProfileCard(card, supplier, source);
    await sendText(from, profileCardText);

    // ── Then load the full seller menu (catalogue, quote, book, enquire) ─────
    await showSellerMenu(from, String(supplier._id), biz, saveBiz, {
      source,
      staffCardId: cardId,    // stored in session → enquiries/quotes notify salesperson
      parentName:  card.name, // used in quote/enquiry attribution
    });
  } catch (err) {
    console.error("[STAFF DEEP LINK] showSellerMenu failed:", err.message);
    // Fallback: show profile card + manual action buttons
    const { sendText, sendButtons } = await import("./metaSender.js");
    const profileCard = buildStaffProfileCard(card, supplier);
    await sendText(from, profileCard);
    await sendButtons(from, {
      text: `What would you like to do?`,
      buttons: [
        { id: `sc_quote_${String(supplier._id)}`,   title: "💵 Get a quote" },
        { id: `sc_enquiry_${String(supplier._id)}`, title: "💬 Send enquiry" },
      ]
    });
  }

  return true;
}

// ─── Staff card profile card text (WhatsApp message to buyer) ─────────────────
// This is shown as the header above the normal seller menu buttons.
// The buyer sees: the salesperson's name + title + the business details.
// Then the normal sellerChat flow handles quote/booking/enquiry as usual.

export function buildStaffProfileCard(card, supplier, source = "direct") {
  const name     = card.name        || "Staff Member";
  const title    = card.title       || "";
  const phone    = card.phone       || "";
  const email    = card.email       || "";
  const tagline  = card.tagline     || "";
  const locLabel = card.locationLabel || "";

  const bizName  = supplier?.businessName || "";
  const city     = supplier?.location?.city || "";
  const area     = supplier?.location?.area || "";
  const location = locLabel || [area, city].filter(Boolean).join(", ");
  const isService = supplier?.profileType === "service";

  const displayPhone = phone.length >= 11
    ? `+${phone.slice(0, 3)} ${phone.slice(3, 5)} ${phone.slice(5, 8)} ${phone.slice(8)}`
    : phone;

  // Top 3 teaser items from parent supplier
  const items = isService
    ? (supplier?.rates || []).slice(0, 3).map(r => r.service).filter(Boolean)
    : (supplier?.prices || []).filter(p => p.inStock !== false).slice(0, 3)
        .map(p => p.amount ? `${p.product} @ $${Number(p.amount).toFixed(2)}` : p.product);
  const itemTeaser = items.join(" · ") || (supplier?.listedProducts || []).slice(0, 3).join(" · ");

  const lines = [
    `👤 *${name}*${title ? ` | ${title}` : ""}`,
    locLabel ? `🏪 ${bizName} · ${locLabel}` : `🏪 ${bizName}${location ? ` · ${location}` : ""}`,
    displayPhone ? `📱 ${displayPhone}` : "",
    email        ? `📧 ${email}` : "",
    tagline      ? `\n_"${tagline}"_` : "",
    ``,
    itemTeaser   ? `${isService ? "🔧" : "📦"} ${itemTeaser}` : "",
  ].filter(l => l !== null && l !== undefined && l !== "");

  return lines.join("\n");
}

// ─── Sharable captions per channel ───────────────────────────────────────────

export function buildStaffSharableCaption(card, supplier, source = "wa") {
  const name     = card.name      || "";
  const title    = card.title     || "";
  const tagline  = card.tagline   || "";
  const bizName  = supplier?.businessName || "";
  const city     = supplier?.location?.city || "";
  const area     = supplier?.location?.area || "";
  const location = card.locationLabel || [area, city].filter(Boolean).join(", ");
  const isService = supplier?.profileType === "service";
  const phone    = card.phone || "";

  const items = isService
    ? (supplier?.rates || []).slice(0, 3).map(r => r.service).filter(Boolean)
    : (supplier?.prices || []).filter(p => p.inStock !== false).slice(0, 3)
        .map(p => p.amount ? `${p.product} @ $${Number(p.amount).toFixed(2)}` : p.product);
  const itemTeaser = items.join(" · ");
  const link       = buildStaffDeepLink(String(card._id), source);
  const displayPhone = _formatPhoneDisplay(phone);

  const captions = {
    wa: [
      `👤 *${name}*${title ? ` | ${title}` : ""}`,
      `🏪 ${bizName}${location ? ` · ${location}` : ""}`,
      tagline ? `"${tagline}"` : "",
      ``,
      itemTeaser ? `${isService ? "🔧" : "📦"} ${itemTeaser}` : "",
      ``,
      `💬 Chat with me directly on ZimQuote:`,
      link,
    ].filter(Boolean).join("\n"),

    fb: [
      `Hi! I'm ${name}${title ? `, ${title}` : ""} at ${bizName}.`,
      ``,
      itemTeaser ? `We offer: ${itemTeaser}` : `Serving clients in ${location}.`,
      tagline ? `"${tagline}"` : "",
      ``,
      `📲 Tap the link below to chat on WhatsApp and get an instant quote - no app downloads needed:`,
      ``,
      link,
      `#ZimQuote #Zimbabwe${city ? ` #${city.replace(/\s/g,"")}` : ""} #${isService ? "Services" : "Shopping"}`,
    ].filter(Boolean).join("\n"),

    tt: [
      `Chat with me directly on ZimQuote 👇`,
      `${name} @ ${bizName}`,
      link,
      `#ZimQuote #Zimbabwe #${bizName.replace(/\s/g,"")}`,
    ].join("\n"),

    sms: [
      `${name}${title ? ` - ${title}` : ""} | ${bizName}`,
      itemTeaser || location,
      displayPhone ? `Call/WhatsApp: ${displayPhone}` : "",
      `Instant quote via ZimQuote: ${link}`,
    ].filter(Boolean).join("\n"),

    ig: [
      `👤 ${name}${title ? ` | ${title}` : ""}`,
      `🏪 ${bizName} · ${location}`,
      tagline ? `"${tagline}"` : "",
      itemTeaser ? `${isService ? "🔧" : "📦"} ${itemTeaser}` : "",
      ``,
      `Get an instant quote on WhatsApp 👇`,
      link,
      `#ZimQuote #Zimbabwe${city ? ` #${city.replace(/\s/g,"")}` : ""} #${bizName.replace(/\s/g,"")}`,
    ].filter(Boolean).join("\n"),
  };

  return captions[source] || captions.wa;
}

// ─── Admin analytics summary ──────────────────────────────────────────────────

export function buildStaffAnalyticsSummary(card) {
  const views    = card.zqLinkViews       || 0;
  const converts = card.zqLinkConversions || 0;
  const sources  = card.zqSourceViews     || {};
  const topSource = Object.entries(sources).sort(([,a],[,b]) => b - a).find(([,v]) => v > 0);
  return {
    views,
    converts,
    convRate: views > 0 ? ((converts / views) * 100).toFixed(0) : "0",
    topSource: topSource ? `${topSource[0].toUpperCase()}: ${topSource[1]}` : "-",
  };
}

// ─── Notify salesperson: someone opened their card ────────────────────────────
// Uses the ALREADY-APPROVED supplier_link_opened template (same one the company
// smart link uses) so notifications work immediately without any new Meta approval.
// The salesperson receives the SAME notification format as the business owner,
// addressed to their own phone - no new template submission needed.
//
// supplier_link_opened template body (already approved):
//   Business: {{1}}    ← we pass "Muchaneta Horinda (Zibugold Construction Group)"
//   Via: {{2}}         ← source label e.g. "WhatsApp Status"
//   Time: {{3}}        ← "08:15 4 Jun"
//
async function _notifyStaffCardOpened(card, supplier, source, visitorPhone) {
  try {
    const PHONE_ID = process.env.WHATSAPP_PHONE_NUMBER_ID || process.env.META_PHONE_NUMBER_ID || process.env.PHONE_NUMBER_ID;
    const TOKEN    = process.env.META_ACCESS_TOKEN || process.env.WHATSAPP_ACCESS_TOKEN;
    if (!PHONE_ID || !TOKEN) return;

    const axios       = (await import("axios")).default;
    const targetPhone = _normPhone(card.phone);
    if (!targetPhone || targetPhone.length < 10) return;

    const sourceLabels = {
      fb: "Facebook", wa: "WhatsApp Status", tt: "TikTok",
      qr: "QR Code scan", sms: "SMS / Flyer", ig: "Instagram",
      yt: "YouTube", direct: "Direct link"
    };
    const sourceLabel = sourceLabels[source] || "ZimQuote link";
    const timeStr = new Date().toLocaleTimeString("en-GB", {
      hour: "2-digit", minute: "2-digit", timeZone: "Africa/Harare"
    }) + " " + new Date().toLocaleDateString("en-GB", {
      day: "numeric", month: "short", timeZone: "Africa/Harare"
    });

    const cardName = card.name || "Your card";
    const bizName  = supplier?.businessName || "Your business";

    // ── Use the ALREADY-APPROVED supplier_link_opened template ───────────────
    // We pass the staff name + business as the first parameter so the notification
    // clearly identifies it's a staff card view, not a company link view.
    // Format: "Muchaneta Horinda · Zibugold Construction Group"
    const businessParam = `${cardName} · ${bizName}`;

    try {
      await axios.post(
        `https://graph.facebook.com/v24.0/${PHONE_ID}/messages`,
        {
          messaging_product: "whatsapp",
          to:   targetPhone,
          type: "template",
          template: {
            name:     "supplier_link_opened",
            language: { code: "en" },
            components: [{
              type: "body",
              parameters: [
                { type: "text", text: businessParam },
                { type: "text", text: sourceLabel },
                { type: "text", text: timeStr }
              ]
            }]
          }
        },
        { headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" } }
      );
      console.log(`[STAFF CARD NOTIFY] supplier_link_opened (staff) → ${targetPhone} (${cardName} via ${sourceLabel})`);
      return;
    } catch (tplErr) {
      console.warn(`[STAFF CARD NOTIFY] template failed for ${targetPhone}: ${tplErr.message}`);
    }

    // ── Fallback: sendButtons (within 24hr session only) ─────────────────────
    const { sendButtons } = await import("./metaSender.js");
    await sendButtons(targetPhone, {
      text:
        `👁 *Someone just viewed your ZimQuote card!*\n\n` +
        `📛 Card: ${cardName}\n` +
        `🏪 ${bizName}\n` +
        `📱 Via: ${sourceLabel}\n` +
        `⏰ ${timeStr}\n\n` +
        `They can browse your services, request a quote, or send an enquiry.\n\n` +
        `💡 _Tip: Respond quickly - buyers in Zimbabwe compare multiple suppliers._`,
      buttons: [
        { id: "my_supplier_account",                  title: "🏪 My Store" },
        { id: `sc_staff_stats_${String(card._id)}`,   title: "📊 My Card Stats" }
      ]
    });
  } catch (err) {
    console.warn("[STAFF CARD NOTIFY]", err.message);
  }
}

// ─── Notify salesperson: they received an enquiry via their card ──────────────
// Uses the ALREADY-APPROVED supplier_new_buyer_request template (same one used
// for company enquiry notifications) - no new Meta template approval needed.
//
// supplier_new_buyer_request template body (already approved):
//   Ref: {{1}}          ← enquiry reference number
//   From: {{2}}         ← buyer's display phone
//   Items: {{3}}        ← message preview
//   {{4}}               ← "via Muchaneta Horinda's card"
//
export async function notifyStaffEnquiry({ card, supplier, buyerPhone, message, refNum }) {
  if (!card?.phone) return;
  try {
    const PHONE_ID = process.env.WHATSAPP_PHONE_NUMBER_ID || process.env.META_PHONE_NUMBER_ID || process.env.PHONE_NUMBER_ID;
    const TOKEN    = process.env.META_ACCESS_TOKEN || process.env.WHATSAPP_ACCESS_TOKEN;
    if (!PHONE_ID || !TOKEN) return;

    const axios        = (await import("axios")).default;
    const targetPhone  = _normPhone(card.phone);
    if (!targetPhone || targetPhone.length < 10) return;

    const cardName     = card.name || "Staff Card";
    const buyerDisplay = _formatPhoneDisplay(buyerPhone);
    const msgPreview   = String(message || "").slice(0, 200);
    // The 4th parameter tells the salesperson which card/route brought this enquiry
    const viaLabel     = `via ${cardName}'s ZimQuote card`;

    // ── Use the ALREADY-APPROVED supplier_new_buyer_request template ─────────
    try {
      await axios.post(
        `https://graph.facebook.com/v24.0/${PHONE_ID}/messages`,
        {
          messaging_product: "whatsapp",
          to:   targetPhone,
          type: "template",
          template: {
            name:     "supplier_new_buyer_request",
            language: { code: "en" },
            components: [{
              type: "body",
              parameters: [
                { type: "text", text: refNum       },
                { type: "text", text: buyerDisplay },
                { type: "text", text: msgPreview   },
                { type: "text", text: viaLabel     }
              ]
            }]
          }
        },
        { headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" } }
      );
      console.log(`[STAFF ENQUIRY NOTIFY] supplier_new_buyer_request (staff) → ${targetPhone} (ref ${refNum})`);
      return;
    } catch (tplErr) {
      console.warn(`[STAFF ENQUIRY NOTIFY] template failed for ${targetPhone}: ${tplErr.message}`);
    }

    // ── Fallback: sendButtons (within 24hr session only) ─────────────────────
    const { sendButtons } = await import("./metaSender.js");
    await sendButtons(targetPhone, {
      text:
        `💬 *New enquiry via your ZimQuote card!*\n\n` +
        `📋 Ref: ${refNum}\n` +
        `📱 From: ${buyerDisplay}\n\n` +
        `_"${msgPreview}"_\n\n` +
        `Reply on WhatsApp to follow up directly.`,
      buttons: [{ id: "my_supplier_account", title: "🏪 My Store" }]
    });
  } catch (err) {
    console.warn("[STAFF ENQUIRY NOTIFY]", err.message);
  }
}

// ─── Salesperson's "my card" bot command ──────────────────────────────────────
// When a salesperson messages the bot "my card" or "staff card", show their stats
// and smart link. This lets each salesperson check how their card is performing
// without needing access to the admin panel.
//
// Wire in chatbotEngine.js after the ZQ:STAFF intercept:
//   if (!isMetaAction && /^(my card|staff card|my link|my qr)$/i.test(text.trim())) {
//     const handled = await handleStaffCardSelfMenu({ from });
//     if (handled) return;
//   }
//
export async function handleStaffCardSelfMenu({ from }) {
  try {
    const phone = _normPhone(from);
    const card  = await StaffCard.findOne({ phone, active: true }).lean();
    if (!card) return false; // Not a staff member - ignore

    const supplier = await SupplierProfile.findById(card.supplierId).lean();
    const stats    = buildStaffAnalyticsSummary(card);
    const directLink = buildStaffDeepLink(String(card._id), null);

    const { sendText, sendButtons } = await import("./metaSender.js");

    const statsMsg = [
      `📊 *Your ZimQuote Card Stats*`,
      ``,
      `👤 ${card.name}${card.title ? ` | ${card.title}` : ""}`,
      `🏪 ${supplier?.businessName || ""}`,
      ``,
      `👁 *${stats.views}* profile views total`,
      `✅ *${stats.converts}* buyer actions (enquiries / quotes)`,
      `📈 Conversion rate: *${stats.convRate}%*`,
      `🏆 Top source: *${stats.topSource}*`,
      ``,
      `🔗 Your link:`,
      directLink,
    ].join("\n");

    await sendText(from, statsMsg);

    const waCap = buildStaffSharableCaption(card, supplier, "wa");
    await sendText(from,
      `📤 *Share this on your WhatsApp Status:*\n\n${waCap}`
    );

    return await sendButtons(from, {
      text: `Tap to get more captions or your QR code:`,
      buttons: [
        { id: `sc_staff_share_${String(card._id)}`, title: "📤 Get Share Captions" },
        { id: "my_supplier_account",                 title: "🏪 Business Dashboard" }
      ]
    });
  } catch (err) {
    console.error("[STAFF SELF MENU]", err.message);
    return false;
  }
}

// ─── Handle sc_staff_share_<cardId> and sc_staff_stats_<cardId> actions ───────
// Wire in chatbotEngine.js inside the sc_ action block, or as its own block:
//   if (a.startsWith("sc_staff_")) {
//     const handled = await handleStaffCardAction({ from, action: a });
//     if (handled) return;
//   }
//
export async function handleStaffCardAction({ from, action }) {
  try {
    const shareMatch = action.match(/^sc_staff_share_([a-f0-9]{24})$/);
    const statsMatch = action.match(/^sc_staff_stats_([a-f0-9]{24})$/);
    const cardId = (shareMatch || statsMatch)?.[1];
    if (!cardId) return false;

    const card     = await StaffCard.findById(cardId).lean();
    if (!card) return false;

    const supplier = await SupplierProfile.findById(card.supplierId).lean();
    const { sendText, sendButtons } = await import("./metaSender.js");

    if (statsMatch) {
      const stats      = buildStaffAnalyticsSummary(card);
      const directLink = buildStaffDeepLink(cardId, null);
      const sources    = card.zqSourceViews || {};
      const srcLines   = Object.entries(STAFF_LINK_SOURCES)
        .map(([k, label]) => sources[k] > 0 ? `  • ${label}: ${sources[k]} view${sources[k]===1?"":"s"}` : null)
        .filter(Boolean).join("\n");

      await sendText(from, [
        `📊 *Card Stats: ${card.name}*`,
        ``,
        `👁 Total views: *${stats.views}*`,
        `✅ Buyer actions: *${stats.converts}*`,
        `📈 Conversion: *${stats.convRate}%*`,
        srcLines ? `\n📱 *By source:*\n${srcLines}` : "",
        ``,
        `🔗 Your link: ${directLink}`,
      ].filter(l => l !== "").join("\n"));

      return sendButtons(from, {
        text: "What next?",
        buttons: [
          { id: `sc_staff_share_${cardId}`, title: "📤 Share Captions" },
          { id: "my_supplier_account",       title: "🏪 My Store" }
        ]
      });
    }

    if (shareMatch) {
      // Send one caption per channel - WA first, then others
      const channels = [
        { src: "wa",  label: "WhatsApp Status" },
        { src: "fb",  label: "Facebook" },
        { src: "sms", label: "SMS / Flyer" },
      ];
      for (const { src, label } of channels) {
        const caption = buildStaffSharableCaption(card, supplier, src);
        await sendText(from, `*${label} caption:*\n\n${caption}`);
      }
      const qrUrl = buildStaffQrImageUrl(cardId, 400);
      await sendText(from, `🖨 *QR Code for business card print:*\n${qrUrl}\n\n_(Open in browser, save image, print on your physical card)_`);
      return true;
    }

    return false;
  } catch (err) {
    console.error("[STAFF CARD ACTION]", err.message);
    return false;
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// PATCH INSTRUCTIONS FOR EXISTING FILES
// Read carefully - these are MINIMAL changes to existing files.
// ═════════════════════════════════════════════════════════════════════════════
//
// ── PATCH 1: chatbotEngine.js ─────────────────────────────────────────────────
// Add the import at the top alongside other service imports:
//
//   import { handleStaffDeepLink, handleStaffCardSelfMenu, handleStaffCardAction } from "./staffSmartLink.js";
//
// Add this block BEFORE the ZQ:SUPPLIER intercept block (around line 12125):
//
//   // ── ZQ:STAFF deep link ────────────────────────────────────────────────────
//   if (!isMetaAction && /ZQ:STAFF:/i.test(text)) {
//     const _handled = await handleStaffDeepLink({ from, text, biz, saveBiz: saveBizSafe.bind(null, biz) });
//     if (_handled) return;
//   }
//
// Add this block alongside the ZQ:S: and ZQ:GROUP: early intercepts (around line 6625):
//
//   if (!isMetaAction && /ZQ:STAFF:/i.test(text.trim())) {
//     const _handled = await handleStaffDeepLink({ from, text: text.trim(), biz, saveBiz: saveBizSafe.bind(null, biz) });
//     if (_handled) return;
//   }
//
// Add this block for the salesperson "my card" self-service (around line 12160, near "zq "):
//
//   if (!isMetaAction && /^(my card|staff card|my link|my qr)$/i.test(text.trim())) {
//     const _handled = await handleStaffCardSelfMenu({ from });
//     if (_handled) return;
//   }
//
// Inside the sc_ action block (around line 12184, before the main sc_ handler):
//
//   if (a.startsWith("sc_staff_")) {
//     const _handled = await handleStaffCardAction({ from, action: a });
//     if (_handled) return;
//   }
//
// ── PATCH 2: sellerChat.js _scProcessEnquiry ──────────────────────────────────
// After the existing seller notification block in _scProcessEnquiry (~line 2570),
// add this block to ALSO notify the salesperson whose card the buyer used:
//
//   // ── Notify salesperson if buyer came via a staff card ─────────────────
//   const _scStaffCardId = biz?.sessionData?.scStaffCardId;
//   if (_scStaffCardId) {
//     try {
//       const { notifyStaffEnquiry } = await import("./staffSmartLink.js");
//       const StaffCard = (await import("../models/staffCard.js")).default;
//       const _staffCard = await StaffCard.findById(_scStaffCardId).lean();
//       if (_staffCard) {
//         notifyStaffEnquiry({
//           card:       _staffCard,
//           supplier:   seller,
//           buyerPhone: from,
//           message:    raw,
//           refNum
//         }).catch(() => {});
//         // Track as conversion on the staff card
//         const { trackStaffLinkEvent } = await import("./staffSmartLink.js");
//         trackStaffLinkEvent(_scStaffCardId, { source: "direct", isConversion: true }).catch(() => {});
//       }
//     } catch (_staffErr) {
//       // Non-critical
//     }
//   }
//
// Also inject scStaffCardId into saveBiz calls - in showSellerMenu, update the
// biz.sessionData block to include staffCardId passed via opts:
//
//   biz.sessionData = {
//     ...(biz.sessionData || {}),
//     scSellerId:      supplierId,
//     scIsService:     isService,
//     scIsHospitality: isHospitality,
//     scHasPrices:     hasPrices,
//     scSource:        source,
//     scBuyerName:     parentName,
//     scStaffCardId:   opts.staffCardId || biz?.sessionData?.scStaffCardId || null, // ← ADD THIS
//   };
//
// ── PATCH 3: sellerChat.js _scQuoteDone ───────────────────────────────────────
// Similarly, after the seller quote notification in _scQuoteDone, add:
//
//   const _scStaffCardIdQ = biz?.sessionData?.scStaffCardId;
//   if (_scStaffCardIdQ) {
//     try {
//       const { trackStaffLinkEvent } = await import("./staffSmartLink.js");
//       trackStaffLinkEvent(_scStaffCardIdQ, { source: "direct", isConversion: true }).catch(() => {});
//       // Also notify staff of the quote request
//       const { notifyStaffEnquiry } = await import("./staffSmartLink.js");
//       const StaffCard = (await import("../models/staffCard.js")).default;
//       const _sc = await StaffCard.findById(_scStaffCardIdQ).lean();
//       if (_sc) {
//         notifyStaffEnquiry({
//           card:       _sc,
//           supplier:   seller,
//           buyerPhone: from,
//           message:    `Quote request: ${(biz?.sessionData?.scQuoteItems || []).map(i => i.name || i.item).join(", ")}`,
//           refNum:     quoteRef
//         }).catch(() => {});
//       }
//     } catch (_) {}
//   }
//
// ─────────────────────────────────────────────────────────────────────────────