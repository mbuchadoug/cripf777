// services/sellerSearchList.js
// ─── ZimQuote Numbered Seller Search Results ──────────────────────────────────
//
// Replaces the Meta interactive-list search results (capped at 10 rows) with a
// single numbered TEXT message of SELLERS. The buyer replies with a number and
// the seller's smart-link store opens (showSellerMenu) - profile card, Get Quote,
// Place Order, Enquiry, Contact - and the seller is notified exactly as if the
// buyer had opened their smart link (source = "search").
//
// WHY THIS DESIGN (WhatsApp behaviour on the ground in Zimbabwe):
//   • Meta lists cap at 10 rows → old flow forced "➡ More results" paging.
//     Impatient buyers never tap page 2. A numbered text list shows 15 sellers
//     in ONE message with zero taps.
//   • Typing "2" is the most natural WhatsApp action there is - people already
//     reply to airtime menus and EcoCash prompts by number.
//   • Numbers are STABLE: "more" extends the list (16, 17, 18...) instead of
//     replacing pages, so "seller 3" always means the same seller. A buyer can
//     open seller 2, come back, and type 5 to compare - no re-searching.
//   • Sellers are DEDUPLICATED (the old offer list showed one row per product,
//     so one supplier could flood the whole list). One line per business,
//     with their best matching item + price as the hint.
//
// SESSION STORAGE:
//   UserSession.tempData.sellerPick = {
//     ts:      epoch ms of when the list was built (freshness window: 48h)
//     term:    the search term ("cement")
//     loc:     location label ("Mbare, Harare")
//     shown:   how many entries have been rendered so far
//     entries: [{ id, name, info }]   (info = pre-built detail line)
//   }
//
// SAFETY / "don't hijack numbers" GUARDS (tryHandleSellerPickText):
//   1. Only bare 1-999 or "more" reach this module (caller regex).
//   2. A sellerPick list must exist AND be fresh (< 48h).
//   3. biz.sessionState must be "ready" / "supplier_search_city" / empty.
//      Every invoice, expense, registration, order-picking and sc_ flow sets a
//      different state, so typed numbers inside those flows are never touched.
//   4. Any UserSession.tempData key ending in "State" with a truthy value
//      (scState, schoolApplyState, sellerRequestReplyState, buyerRequestState,
//      sfaqState, ...) blocks the pick - covers all no-biz text flows,
//      including future ones, without maintaining a manual list.
//
// Wire-up in chatbotEngine.js:
//   • Top-level intercept:  tryHandleSellerPickText(...)  (runs before states)
//   • Result render sites:  sendNumberedSellerResults(...) replaces sendList

import { sendText, sendButtons } from "./metaSender.js";
import { expandSearchTerms, scoreSupplierMatch } from "./supplierSearch.js";

const BATCH_SIZE       = 15;          // sellers per message
const MAX_STORED       = 60;          // hard cap of ranked sellers kept in session
const FRESH_WINDOW_MS  = 48 * 60 * 60 * 1000; // 48h - buyers often reply hours later
const MAX_MSG_CHARS    = 3800;        // stay well under WhatsApp's 4096 limit

// ─── Helpers ──────────────────────────────────────────────────────────────────

function _norm(v = "") {
  return String(v || "")
    .toLowerCase()
    .trim()
    .replace(/[^\w\s]/g, "")
    .replace(/\s+/g, " ");
}

function _tierBadge(tier) {
  return tier === "featured" ? "🔥 " : tier === "pro" ? "⭐ " : "";
}

function _ratingStr(rating, reviewCount) {
  const r = Number(rating || 0);
  if (!r) return "";
  return `⭐${r.toFixed(1)}${reviewCount ? "" : ""}`;
}

// Best matching item + price for a supplier doc, used as the hint line.
// Mirrors formatSupplierResults' matchHint logic but returns a compact string.
function _matchHintFromSupplier(s, searchTerm) {
  const term = _norm(searchTerm || "");
  if (!term) return "";
  const terms = [term, ...expandSearchTerms(term)].filter(Boolean);

  const _hits = (name) => {
    const n = _norm(name);
    if (!n) return false;
    return terms.some(t => t && (n.includes(t) || t.includes(n)));
  };

  // Service rates first (has "$20/job" style text)
  if (s.profileType === "service" && (s.rates || []).length) {
    const m = (s.rates || []).find(r => _hits(r?.service));
    if (m) return `${m.service}${m.rate ? " " + m.rate : ""}`;
  }

  // Priced products
  const priceMatch = (s.prices || []).find(p =>
    p?.inStock !== false && _hits(p?.product)
  );
  if (priceMatch) {
    const amt = typeof priceMatch.amount === "number"
      ? `$${Number(priceMatch.amount).toFixed(2)}/${priceMatch.unit || "each"}`
      : "";
    return `${priceMatch.product}${amt ? " - " + amt : ""}`;
  }

  // Unpriced listed items
  const allItems = [
    ...(s.listedProducts || []),
    ...(s.products || []),
    ...((s.rates || []).map(r => r?.service))
  ].filter(p => p && p !== "pending_upload");
  const itemMatch = allItems.find(p => _hits(p));
  if (itemMatch) return String(itemMatch);

  return "";
}

function _deliveryStr(entry) {
  if (entry.profileType === "service") {
    return entry.travelAvailable ? "🚗 Mobile" : "📍 Visit";
  }
  if (entry.profileType === "hospitality") return "🏨";
  return entry.deliveryAvailable ? "🚚 Delivers" : "🏠 Collect";
}

// ─── Entry builders ───────────────────────────────────────────────────────────

// From a full SupplierProfile doc (suppliers / business-name / category mode)
function _entryFromSupplier(s, searchTerm) {
  const loc = [s.location?.area, s.location?.city].filter(Boolean).join(", ");
  const hint = _matchHintFromSupplier(s, searchTerm);
  const bits = [
    loc ? `📍 ${loc}` : "",
    _ratingStr(s.rating, s.reviewCount),
    _deliveryStr({
      profileType: s.profileType,
      travelAvailable: s.travelAvailable,
      deliveryAvailable: s.delivery?.available
    }),
    hint ? `💵 ${hint}` : ""
  ].filter(Boolean);

  return {
    id:   String(s._id),
    name: `${_tierBadge(s.tier)}${s.businessName || "Seller"}${s.verified ? " ✅" : ""}`,
    info: bits.join(" · ").slice(0, 110),
    _score: 0,
    _tierRank: typeof s.tierRank === "number" ? s.tierRank : 0,
    _cred: typeof s.credibilityScore === "number" ? s.credibilityScore : 0,
    _rating: typeof s.rating === "number" ? s.rating : 0
  };
}

// From offer rows produced by runSupplierOfferSearch (offers mode).
// Collapses one-row-per-product into ONE entry per seller; the first offer
// (already sorted priced-first / tier-first upstream) becomes the hint.
function _entriesFromOffers(offers = []) {
  const seen = new Map();
  for (const o of offers) {
    if (!o?.supplierId) continue;
    if (seen.has(o.supplierId)) {
      // Count extra matching items so buyers see depth: "cement + 3 more"
      seen.get(o.supplierId)._extra += 1;
      continue;
    }
    const price = o.pricePerUnit !== null && o.pricePerUnit !== undefined
      ? `$${Number(o.pricePerUnit).toFixed(2)}/${o.unit || "each"}`
      : "";
    const loc = [o.supplierArea, o.supplierCity].filter(Boolean).join(", ");
    seen.set(o.supplierId, {
      id:   String(o.supplierId),
      name: `${_tierBadge(o.supplierTier)}${o.supplierName || "Seller"}`,
      _hintProduct: o.product || "",
      _hintPrice: price,
      _loc: loc,
      _deliveryText: o.deliveryText || "",
      _rating: typeof o.supplierRating === "number" ? o.supplierRating : 0,
      _extra: 0
    });
  }

  return [...seen.values()].map(e => {
    const hint = e._hintProduct
      ? `💵 ${e._hintProduct}${e._hintPrice ? " - " + e._hintPrice : ""}${e._extra > 0 ? ` (+${e._extra} more)` : ""}`
      : "";
    const bits = [
      e._loc ? `📍 ${e._loc}` : "",
      e._rating ? `⭐${e._rating.toFixed(1)}` : "",
      e._deliveryText,
      hint
    ].filter(Boolean);
    return { id: e.id, name: e.name, info: bits.join(" · ").slice(0, 110) };
  });
}

function _rankSupplierEntries(suppliers, searchTerm) {
  const entries = (suppliers || []).map(s => {
    const e = _entryFromSupplier(s, searchTerm);
    e._score = searchTerm ? scoreSupplierMatch(s, searchTerm) : 0;
    return e;
  });
  entries.sort((a, b) => {
    if (b._score !== a._score)       return b._score - a._score;
    if (b._tierRank !== a._tierRank) return b._tierRank - a._tierRank;
    if (b._cred !== a._cred)         return b._cred - a._cred;
    return (b._rating || 0) - (a._rating || 0);
  });
  return entries.map(({ id, name, info }) => ({ id, name, info }));
}

// ─── Message rendering ────────────────────────────────────────────────────────

function _renderBatch(pick, startIdx) {
  const total = pick.entries.length;
  const slice = pick.entries.slice(startIdx, startIdx + BATCH_SIZE);

  const header = startIdx === 0
    ? `🔍 *${pick.term || "Sellers"}*${pick.loc ? ` — ${pick.loc}` : ""}\n` +
      `${total} seller${total === 1 ? "" : "s"} found\n`
    : `🔍 *${pick.term || "Sellers"}* — more sellers\n`;

  const body = slice.map((e, i) => {
    const n = startIdx + i + 1;
    return `*${n}. ${e.name}*\n${e.info}`;
  });

  const shownAfter = startIdx + slice.length;
  const remaining  = total - shownAfter;

  const footerLines = [
    "━━━━━━━━━━━━━━",
    `💬 *Reply with a number* (e.g. *1*) to open that seller — see their full profile, prices & request a quote.`
  ];
  if (remaining > 0) footerLines.push(`➕ Type *more* to see ${Math.min(remaining, BATCH_SIZE)} more sellers`);
  footerLines.push(`🔎 New search? Just type it, e.g. *find cement mbare*`);

  // Assemble and trim if a batch of long names would overflow WhatsApp's limit
  let parts = [header, ...body, footerLines.join("\n")];
  let msg = parts.join("\n\n");
  let used = slice.length;
  while (msg.length > MAX_MSG_CHARS && used > 3) {
    used -= 1;
    parts = [header, ...body.slice(0, used), footerLines.join("\n")];
    msg = parts.join("\n\n");
  }

  return { msg, shownAfter: startIdx + used };
}

// ─── Public: send numbered seller results ─────────────────────────────────────

/**
 * Send search results as a numbered seller list and store the pick map.
 *
 * @param {Object} p
 * @param {string} p.from            WhatsApp sender id
 * @param {string} p.phone           normalized phone (UserSession key)
 * @param {Array}  [p.suppliers]     SupplierProfile docs (suppliers mode)
 * @param {Array}  [p.offers]        offer rows from runSupplierOfferSearch (offers mode)
 * @param {string} [p.searchTerm]    what the buyer searched
 * @param {string} [p.locationLabel] "Mbare, Harare" / "All Cities" / ""
 * @param {string} [p.titleLabel]    optional header override (category browse)
 */
export async function sendNumberedSellerResults({
  from,
  phone,
  suppliers = null,
  offers = null,
  searchTerm = "",
  locationLabel = "",
  titleLabel = ""
}) {
  let entries = [];
  if (Array.isArray(offers) && offers.length) {
    entries = _entriesFromOffers(offers);
  } else if (Array.isArray(suppliers) && suppliers.length) {
    entries = _rankSupplierEntries(suppliers, searchTerm);
  }

  if (!entries.length) {
    return sendButtons(from, {
      text: `😕 No sellers found${searchTerm ? ` for *${searchTerm}*` : ""}${locationLabel ? ` in *${locationLabel}*` : ""}.`,
      buttons: [{ id: "find_supplier", title: "🔍 Search Again" }]
    });
  }

  entries = entries.slice(0, MAX_STORED);

  const pick = {
    ts:      Date.now(),
    term:    titleLabel || searchTerm || "",
    loc:     locationLabel || "",
    shown:   0,
    entries
  };

  const { msg, shownAfter } = _renderBatch(pick, 0);
  pick.shown = shownAfter;

  try {
    const UserSession = (await import("../models/userSession.js")).default;
    await UserSession.findOneAndUpdate(
      { phone },
      { $set: { "tempData.sellerPick": pick } },
      { upsert: true }
    );
  } catch (err) {
    console.warn("[SELLER PICK SAVE]", err.message);
  }

  return sendText(from, msg);
}

// ─── Public: handle typed number / "more" ─────────────────────────────────────

/**
 * Intercepts a bare number or "more" typed by a buyer who recently received a
 * numbered seller list. Returns true if handled, false to fall through.
 * Heavily guarded - see file header. NEVER throws.
 */
export async function tryHandleSellerPickText({ from, phone, text, biz, saveBiz }) {
  try {
    const raw = String(text || "").trim().toLowerCase();
    const isMore   = raw === "more";
    const isNumber = /^[1-9][0-9]{0,2}$/.test(raw);
    if (!isMore && !isNumber) return false;

    // Guard 3: biz users must be idle (every text-entry flow sets its own state)
    const _allowedBizStates = ["ready", "supplier_search_city"];
    if (biz && biz.sessionState && !_allowedBizStates.includes(biz.sessionState)) {
      return false;
    }

    const UserSession = (await import("../models/userSession.js")).default;
    const sess = await UserSession.findOne({ phone }).lean();
    let pick = sess?.tempData?.sellerPick;
    if (!pick) return false;
    if (typeof pick === "string") {
      try { pick = JSON.parse(pick); } catch (_) { return false; }
    }
    if (!Array.isArray(pick.entries) || !pick.entries.length) return false;

    // Guard 2: freshness - a week-old "3" should not open a forgotten list
    if (!pick.ts || Date.now() - pick.ts > FRESH_WINDOW_MS) return false;

    // Guard 4: any active no-biz text flow blocks the pick. Every text-entry
    // flow in the platform stores a "...State" key in tempData (scState,
    // schoolApplyState, sellerRequestReplyState, buyerRequestState, sfaqState,
    // scSellerQuoteState, schoolEnquiryState, ...). Scanning generically means
    // new flows added later are automatically protected too.
    const td = sess?.tempData || {};
    for (const key of Object.keys(td)) {
      if (/state$/i.test(key) && td[key]) {
        // schoolApplyState "awaiting_start" is a dormant marker, not an active flow
        if (key === "schoolApplyState" && td[key] === "awaiting_start") continue;
        return false;
      }
    }

    // ── "more": extend the numbered list (numbering continues) ──────────────
    if (isMore) {
      const shown = Number(pick.shown || 0);
      if (shown >= pick.entries.length) {
        await sendText(from,
          `✅ That's all ${pick.entries.length} sellers from your last search.\n\n` +
          `💬 Reply with a number (1-${pick.entries.length}) to open a seller, ` +
          `or type a new search e.g. *find ${pick.term || "cement"} harare*`
        );
        return true;
      }
      const { msg, shownAfter } = _renderBatch(pick, shown);
      await UserSession.findOneAndUpdate(
        { phone },
        { $set: { "tempData.sellerPick.shown": shownAfter } },
        { upsert: true }
      );
      await sendText(from, msg);
      return true;
    }

    // ── Number: open that seller's smart-link store ──────────────────────────
    const idx = parseInt(raw, 10);
    if (idx > pick.entries.length) {
      await sendText(from,
        `Your last search found *${pick.entries.length}* seller${pick.entries.length === 1 ? "" : "s"}.\n` +
        `Reply with a number from *1* to *${pick.entries.length}*` +
        (pick.shown < pick.entries.length ? `, or type *more* to see the rest.` : `.`)
      );
      return true;
    }

    const entry = pick.entries[idx - 1];
    if (!entry?.id) return false;

    // Open the seller exactly like a smart-link visit:
    //   • profile card + action list (Get Quote / Order / Enquiry / Contact)
    //   • seller notified via notifyAllSupplierLinkOpened
    //   • analytics tracked with source "search"
    const { showSellerMenu } = await import("./sellerChat.js");
    await showSellerMenu(from, entry.id, biz, saveBiz, { source: "search" });

    // Gentle compare hint - keeps the list alive without nagging
    await sendText(from,
      `↩️ To compare, reply with another number from your list` +
      (pick.shown < pick.entries.length ? ` or type *more*.` : `.`)
    );
    return true;
  } catch (err) {
    console.error("[SELLER PICK]", err.message);
    return false;
  }
}