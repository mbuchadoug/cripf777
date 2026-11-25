// services/findMenu.js
// ─── "Find, Buy & Hire" - the one front door for buyers ──────────────────────
//
// Replaces the old "Browse & Shop" wall of text + paginated category lists.
//
//   1. One short message: "type what you need" + a NUMBERED list of 11 groups.
//   2. Reply a number → numbered list of that group's categories (no paging).
//   3. Reply a number → results. The city is NEVER asked: we use the city in
//      the message ("plumber bulawayo"), else the buyer's last search city,
//      else all of Zimbabwe. Sellers from nearby cities top up thin results.
//
// The search itself reuses the existing, proven "sup_search_city_<x>" handler
// in chatbotEngine.js, so results, numbering, ordering and seller menus behave
// exactly as before - we only removed the "Which city?" question in front.
// ─────────────────────────────────────────────────────────────────────────────

import { sendText } from "./metaSender.js";

export const FIND_LABEL = "🔍 Find, Buy & Hire";

const ARM_MS = 20 * 60 * 1000;   // numbered menu stays answerable for 20 min

// Groups shown on the home screen. `cats` are SUPPLIER_CATEGORIES ids.
// `action` = hand off to an existing flow instead of a category list.
export const FIND_GROUPS = [
  { label: "🔧 Home repairs & trades",     hint: "electrician, plumber, builder, welder",
    cats: ["electrical", "plumbing", "construction", "painting", "welding", "carpentry", "tiling_flooring", "air_conditioning", "glazing_aluminium"] },
  { label: "🎓 Schools & tutors",           action: "find_school" },
  { label: "🛒 Groceries & food",           hint: "mealie meal, cooking oil, meat, catering",
    cats: ["groceries", "food_cooked", "agriculture"] },
  { label: "🧱 Building & hardware",        hint: "cement, bricks, roofing, pipes, tools",
    cats: ["building_materials", "hardware_tools", "plumbing_supplies", "electrical_supplies"] },
  { label: "☀️ Solar & power",              hint: "panels, inverters, batteries, installers",
    cats: ["solar_energy", "electrical_supplies", "electrical"] },
  { label: "🚗 Cars, spares & mechanics",   hint: "tyres, spares, car parts",
    cats: ["car_supplies"] },
  { label: "🏠 Home, tech & fashion",       hint: "appliances, phones, furniture, clothes",
    cats: ["appliances", "electronics", "furniture", "clothing", "cosmetics", "stationery", "health"] },
  { label: "💼 Professional services",      hint: "accountants, lawyers, IT, printing",
    cats: ["accounting", "legal", "it_support", "printing", "marketing_digital", "architecture_design", "engineering_services", "hr_recruitment", "financial_advisory", "real_estate"] },
  { label: "🎉 Events, beauty & cleaning",  hint: "catering, photos, salons, cleaners",
    cats: ["events_management", "photography", "beauty", "cleaning", "landscaping", "security", "tourism"] },
  { label: "🚚 Deliveries & transport",     hint: "send a parcel, trucks, moving",
    sub: [
      { label: "🏍️ Send a parcel now (biker)", action: "biker_request_rider" },
      { label: "🚚 Trucks, moving & car hire",  cat: "transport" }
    ] },
  { label: "📝 Get quotes from many sellers", action: "sup_request_sellers" }
];

// ── Home groups = the SECTIONS from /zq-admin/categories (live) ─────────────
// Each active section that has at least one active category becomes a numbered
// line, in the admin's order, with its first category names as the hint. Two
// shortcuts are always added at the end (schools, quotes from many sellers),
// and "Send a parcel now (biker)" leads the transport section.
async function _homeGroups() {
  try {
    const { getAllSections, getAllCategories, sortCategories } = await import("./categoryRegistry.js");
    const [secs, cats] = await Promise.all([getAllSections(), getAllCategories()]);
    const groups = [];
    for (const sec of secs) {
      if (sec.active === false || sec.id === "other") continue;
      const inSec = sortCategories(cats.filter(c => c.section === sec.id && c.active !== false));
      if (!inSec.length) continue;
      const hint = inSec.slice(0, 4).map(c => c.label.replace(/^[^\p{L}\p{N}]+/u, "").toLowerCase()).join(", ");
      groups.push({ label: sec.label, hint, section: sec.id });
    }
    if (groups.length) {
      // Schools & tutors is one of the most searched - keep it near the top.
      // ZQ_FIND_SCHOOLS_POS (1-based, default 2) moves it.
      const pos = Math.max(1, parseInt(process.env.ZQ_FIND_SCHOOLS_POS || "2", 10) || 2);
      groups.splice(Math.min(pos - 1, groups.length), 0, { label: "🎓 Schools & tutors", hint: "schools, colleges, tutors, lessons", action: "find_school" });
      groups.push({ label: "📝 Get quotes from many sellers", action: "sup_request_sellers" });
      return groups;
    }
  } catch (e) { console.warn("[FIND] sections", e.message); }
  return FIND_GROUPS;   // fallback: fixed list
}

async function _session() { return (await import("../models/userSession.js")).default; }

// Opening Find, Buy & Hire (or running a marketplace search) must switch OFF
// any earlier school / tutor / college / group browsing. Those handlers run
// before the product search, so a leftover flag made "electrician harare"
// come back as "no exact match - here are schools".
export const OTHER_SEARCH_MARKERS = {
  "tempData.schoolSearchActive": "", "tempData.schoolResultIds": "",
  "tempData.tutorSearchActive": "", "tempData.instSearchActive": "",
  "tempData.grpListIds": "", "tempData.grpListType": "",
  "tempData.sfaqState": "", "tempData.sfaqBranchId": ""
};
export function resetBizBrowseState(biz) {
  if (!biz) return false;
  const st = String(biz.sessionState || "");
  if (/^(school_search|tutor_search|inst_search|sfaq_|supplier_search_city)/.test(st)) {
    biz.sessionState = "ready";
    return true;
  }
  return false;
}
const _phone = (from) => String(from || "").replace(/\D+/g, "");

async function _arm(from, data) {
  const UserSession = await _session();
  await UserSession.findOneAndUpdate(
    { phone: _phone(from) },
    { $set: { "tempData.zqFind": { ...data, at: new Date() } } },
    { upsert: true }
  );
}

export async function disarmFind(from) {
  try {
    const UserSession = await _session();
    await UserSession.updateOne({ phone: _phone(from) }, { $unset: { "tempData.zqFind": "" } });
  } catch (_) {}
}

// ── Home screen ──────────────────────────────────────────────────────────────
export async function sendFindHome(from) {
  const UserSession = await _session();
  const sess = await UserSession.findOne({ phone: _phone(from) }, { tempData: 1 }).lean();
  const city = sess?.tempData?.lastSearchCity || null;

  const groups = await _homeGroups();
  const lines = groups.map((g, i) => `*${i + 1}.* ${g.label}${g.hint ? `\n      _${g.hint}_` : ""}`).join("\n");

  await UserSession.updateOne({ phone: _phone(from) }, { $unset: OTHER_SEARCH_MARKERS });
  // Store the exact list shown, so "3" always means what the buyer saw
  await _arm(from, { level: "home", groups: groups.map(g => ({ label: g.label, hint: g.hint || "", section: g.section || null, action: g.action || null, cats: g.cats || null, sub: g.sub || null })) });
  return sendText(from,
`🔍 *Find, Buy & Hire*

*Type what you need* - a product, a service or a business name:
_electrician borrowdale_ · _cement 20 bags_ · _mealie meal avondale_ · _Prime Dental_

📍 ${city ? `Searching *${city}* first` : "Searching *all of Zimbabwe*"} - add a city or suburb to change it.

Or *reply with a number* to browse:

${lines}`);
}

// ── Numbered replies ─────────────────────────────────────────────────────────
/**
 * Returns true if the typed text was a number for an armed Find menu.
 * `dispatch(action)` re-enters the engine with a button action.
 */
export async function handleFindNumber({ from, text, biz, saveBiz, dispatch }) {
  const t = String(text || "").trim();
  if (!/^\d{1,2}$/.test(t)) return false;

  const UserSession = await _session();
  const sess = await UserSession.findOne({ phone: _phone(from) }, { tempData: 1 }).lean();
  const f = sess?.tempData?.zqFind;
  if (!f || !f.at || Date.now() - new Date(f.at).getTime() > ARM_MS) return false;

  const n = parseInt(t, 10);
  if (n === 0) { await disarmFind(from); return false; }   // "0" stays the main-menu shortcut

  if (f.level === "home") {
    const shown = Array.isArray(f.groups) && f.groups.length ? f.groups : FIND_GROUPS;
    const g = shown[n - 1];
    if (!g) { await sendText(from, `Please reply with a number from 1 to ${shown.length}, or type what you need.`); return true; }
    if (g.action) { await disarmFind(from); await dispatch(g.action); return true; }

    // A section → its categories WITH seller counts (empty ones hidden), or
    // straight to a numbered seller list when that is all there is.
    if (g.section) {
      await showSection({ from, sectionId: g.section, label: g.label, biz, saveBiz, dispatch, groupIndex: n - 1 });
      return true;
    }

    // Categories of this section (built-in + admin), admin-ordered
    const { getAllCategories } = await import("./categoryRegistry.js");
    const allCats = await getAllCategories();
    let items;
    if (g.sub) items = g.sub;
    else if (g.section) {
      const { sortCategories } = await import("./categoryRegistry.js");
      items = sortCategories(allCats.filter(c => c.section === g.section && c.active !== false))
        .map(c => ({ label: c.label, cat: c.id }));
      if (g.section === "moving") items.unshift({ label: "🏍️ Send a parcel now (biker)", action: "biker_request_rider" });
    } else {
      items = (g.cats || []).map(id => allCats.find(c => c.id === id)).filter(c => c && c.active !== false).map(c => ({ label: c.label, cat: c.id }));
    }
    if (items.length === 1 && items[0].cat) {
      await disarmFind(from);
      return runCategoryBrowse({ from, biz, saveBiz, category: items[0].cat, dispatch }).then(() => true);
    }
    await _arm(from, { level: "group", group: n - 1, items });
    await sendText(from,
`${g.label}

${items.map((it, i) => `*${i + 1}.* ${it.label}`).join("\n")}

👉 *Reply with a number*, or type exactly what you need (e.g. _${(g.hint || "what you need").split(",")[0].trim()}_).`);
    return true;
  }

  if (f.level === "group") {
    const it = (f.items || [])[n - 1];
    if (!it) { await sendText(from, `Please reply with a number from 1 to ${(f.items || []).length}.`); return true; }
    await disarmFind(from);
    if (it.action) { await dispatch(it.action); return true; }
    if (it.all && f.section) {
      await sendSellersFor({ from, biz, saveBiz, catIds: f.catIds || [], title: f.sectionLabel || "Sellers" });
      return true;
    }
    await runCategoryBrowse({ from, biz, saveBiz, category: it.cat, dispatch });
    return true;
  }
  return false;
}

// ── City choice without asking ───────────────────────────────────────────────
async function _pickCity(from, explicitCity) {
  if (explicitCity) return explicitCity;
  try {
    const UserSession = await _session();
    const sess = await UserSession.findOne({ phone: _phone(from) }, { tempData: 1 }).lean();
    if (sess?.tempData?.lastSearchCity) return sess.tempData.lastSearchCity;
  } catch (_) {}
  return null; // all of Zimbabwe
}
const _cityAction = (city) => `sup_search_city_${city ? String(city).toLowerCase().replace(/\s+/g, "_") : "all"}`;

/**
 * Product / service search without the "Which city?" question.
 * Stores the query where the existing city handler reads it, then fires it.
 */
export async function runAutoCitySearch({ from, biz, saveBiz, product, city = null, profileType, dispatch }) {
  const UserSession = await _session();
  const phone = _phone(from);
  const sess = await UserSession.findOne({ phone }, { tempData: 1 }).lean();
  const type = profileType !== undefined ? profileType : (sess?.tempData?.supplierSearchType || null);
  const useCity = await _pickCity(from, city);

  await UserSession.findOneAndUpdate(
    { phone },
    {
      $set: { "tempData.supplierSearchProduct": product, ...(type ? { "tempData.supplierSearchType": type } : {}) },
      $unset: { "tempData.supplierSearchCategory": "", "tempData.supplierSearchMode": "", "tempData.zqFind": "", ...OTHER_SEARCH_MARKERS }
    },
    { upsert: true }
  );
  if (biz) {
    biz.sessionData = { ...(biz.sessionData || {}), supplierSearch: { product, ...(type ? { type } : {}) } };
    if (biz.sessionState === "supplier_search_product") biz.sessionState = "ready";
    resetBizBrowseState(biz);
    if (saveBiz) await saveBiz(biz);
  }
  console.log(`[FIND] "${product}" → ${useCity || "all cities"} (no city question)`);
  return dispatch(_cityAction(useCity));
}

/**
 * Category browse without the "Which city?" question. Falls back to all
 * cities when the remembered city has nobody in that category.
 */
export async function runCategoryBrowse({ from, biz, saveBiz, category, city = null, dispatch }) {
  // New path: numbered seller list built from the seller index (category,
  // admin tags and - for unclassified sellers - their items). Falls back to
  // the old engine handler only if the index cannot be built.
  try {
    const { getAllCategories } = await import("./categoryRegistry.js");
    const def = (await getAllCategories()).find(c => c.id === category);
    if (def) return await sendSellersFor({ from, biz, saveBiz, catIds: [category], title: def.label, city });
  } catch (e) { console.warn("[FIND] category sellers", e.message); }
  return _legacyCategoryBrowse({ from, biz, saveBiz, category, city, dispatch });
}

async function _legacyCategoryBrowse({ from, biz, saveBiz, category, city = null, dispatch }) {
  const UserSession = await _session();
  const phone = _phone(from);
  const { getAllCategories } = await import("./categoryRegistry.js");
  const def = (await getAllCategories()).find(c => c.id === category);
  const type = def?.type === "service" ? "service" : def?.type === "both" ? "any" : "product";   // "any" = products and services

  let useCity = await _pickCity(from, city);
  if (useCity) {
    try {
      const { runSupplierSearch } = await import("./supplierSearch.js");
      const local = await runSupplierSearch({ city: useCity, category, product: null, profileType: type, area: null });
      if (!local.length) useCity = null;
    } catch (_) {}
  }

  await UserSession.findOneAndUpdate(
    { phone },
    {
      $set: { "tempData.supplierSearchCategory": category, "tempData.supplierSearchType": type },
      $unset: { "tempData.supplierSearchProduct": "", "tempData.supplierSearchMode": "", "tempData.zqFind": "", ...OTHER_SEARCH_MARKERS }
    },
    { upsert: true }
  );
  if (biz) {
    biz.sessionData = { ...(biz.sessionData || {}), supplierSearch: { category, type } };
    if (biz.sessionState === "supplier_search_product") biz.sessionState = "ready";
    resetBizBrowseState(biz);
    if (saveBiz) await saveBiz(biz);
  }
  return dispatch(_cityAction(useCity));
}

// ═════════════════════════════════════════════════════════════════════════════
// SELLERS BY SECTION / CATEGORY - numbered list, never a dead end
// ─────────────────────────────────────────────────────────────────────────────
// Old behaviour: picking "Cars & Spares" ran a strict query
// (categories == car_supplies AND profileType == product) and often answered
// "No matching suppliers found". Now a seller belongs to a category when:
//   3  it is classified in it (categories[] - set on /zq-admin/categorize)
//   2  an admin search tag matches the category's buyer keywords
//   1  it is NOT classified in another section and its name / items / services
//      contain a category keyword (catches sellers nobody classified yet)
// Sellers in the buyer's city come first, then everyone else - never filtered
// out. The list is the same numbered message as search results, so the buyer
// types a number and the seller's store opens (seller is notified).
// ═════════════════════════════════════════════════════════════════════════════
const IDX_TTL = 2 * 60 * 1000;
let _pool = null, _poolAt = 0, _poolLoading = null;
const _rxEsc = s => String(s || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const _bare = l => String(l || "").replace(/^[^\p{L}\p{N}]+/u, "").trim();

async function _sellerPool() {
  if (_pool && Date.now() - _poolAt < IDX_TTL) return _pool;
  if (_poolLoading) return _poolLoading;
  _poolLoading = (async () => {
    try {
      const SP = (await import("../models/supplierProfile.js")).default;
      _pool = await SP.find({
        active: true,
        profileType: { $nin: ["biker"] },
        $and: [
          { $or: [{ suspended: false }, { suspended: { $exists: false } }] },
          { $or: [{ subscriptionStatus: "active" }, { subscriptionStatus: "trial" }] }
        ]
      }, {
        businessName: 1, location: 1, rating: 1, reviewCount: 1, tier: 1, tierRank: 1, verified: 1,
        credibilityScore: 1, profileType: 1, travelAvailable: 1, "delivery.available": 1,
        prices: 1, rates: 1, products: 1, listedProducts: 1, categories: 1, searchTags: 1
      }).lean();
      _poolAt = Date.now();
    } finally { _poolLoading = null; }
    return _pool;
  })();
  return _poolLoading;
}
export function invalidateSellerPool() { _pool = null; _poolAt = 0; }

function _catRegexes(cat) {
  const words = [...(cat.keywords || []), _bare(cat.label)]
    .map(k => String(k || "").trim().toLowerCase()).filter(k => k.length >= 3);
  return [...new Set(words)].map(k => new RegExp(`\\b${_rxEsc(k)}`, "i"));
}

function _scoreFor(s, cat, rxs, secOf) {
  const cats = Array.isArray(s.categories) ? s.categories : [];
  if (cats.includes(cat.id)) return 3;
  const tags = (Array.isArray(s.searchTags) ? s.searchTags : []).join(" | ");
  if (tags && rxs.some(r => r.test(tags))) return 2;
  // Weak text match only for sellers not classified into ANOTHER section
  // (stops "plumbing spares" showing under Cars & Spares).
  if (cats.some(c => { const sec = secOf(c); return sec && sec !== "other" && sec !== cat.section; })) return 0;
  const text = [s.businessName, ...(s.products || []), ...(s.listedProducts || []),
    ...((s.rates || []).map(r => r?.service))].filter(x => x && x !== "pending_upload").join(" | ");
  return text && rxs.some(r => r.test(text)) ? 1 : 0;
}

/**
 * Ranked sellers for one or more category ids.
 * @returns {Promise<Array>} supplier docs (lean) with _catScore
 */
export async function sellersForCategories(catIds = [], city = null) {
  const { getAllCategories } = await import("./categoryRegistry.js");
  const all = await getAllCategories();
  const byId = new Map(all.map(c => [c.id, c]));
  const secOf = id => byId.get(id)?.section || null;
  const defs = catIds.map(id => byId.get(id)).filter(Boolean);
  if (!defs.length) return [];
  const rx = defs.map(d => [d, _catRegexes(d)]);
  const pool = await _sellerPool();
  const cityKey = city ? String(city).trim().toLowerCase() : "";
  const out = [];
  for (const s of pool) {
    let best = 0;
    for (const [d, r] of rx) { const sc = _scoreFor(s, d, r, secOf); if (sc > best) best = sc; if (best === 3) break; }
    if (best > 0) out.push({ ...s, _catScore: best, _local: cityKey && String(s.location?.city || "").trim().toLowerCase() === cityKey ? 1 : 0 });
  }
  out.sort((a, b) =>
    (b._local - a._local) || (b._catScore - a._catScore) ||
    ((b.tierRank || 0) - (a.tierRank || 0)) || ((b.credibilityScore || 0) - (a.credibilityScore || 0)) ||
    ((b.rating || 0) - (a.rating || 0)));
  return out;
}

async function _rememberedCity(from) {
  try {
    const UserSession = await _session();
    const sess = await UserSession.findOne({ phone: _phone(from) }, { tempData: 1 }).lean();
    return sess?.tempData?.lastSearchCity || null;
  } catch (_) { return null; }
}

async function _noSellers(from, title) {
  const { sendButtons } = await import("./metaSender.js");
  return sendButtons(from, {
    text: `😕 No sellers are listed under *${_bare(title)}* yet.\n\nTell us what you need and we'll find sellers and send you their prices - free.`,
    buttons: [
      { id: "sup_request_sellers", title: "📝 Request a Quote" },
      { id: "find_supplier",       title: "🔍 Find, Buy & Hire" }
    ]
  });
}

/** Send the numbered seller list for these categories (city sellers first). */
export async function sendSellersFor({ from, biz, saveBiz, catIds, title, city = null }) {
  const useCity = city || await _rememberedCity(from);
  const list = await sellersForCategories(catIds, useCity);
  await disarmFind(from);
  try {
    const UserSession = await _session();
    await UserSession.updateOne({ phone: _phone(from) }, { $unset: OTHER_SEARCH_MARKERS });
  } catch (_) {}
  if (biz) {
    let changed = resetBizBrowseState(biz);
    if (biz.sessionState === "supplier_search_product") { biz.sessionState = "ready"; changed = true; }
    if (changed && saveBiz) { try { await saveBiz(biz); } catch (_) {} }
  }
  if (!list.length) return _noSellers(from, title);

  // Hint term = the category's main keyword, so each line shows a matching item/price
  let hint = "";
  try {
    const { getAllCategories } = await import("./categoryRegistry.js");
    const d = (await getAllCategories()).find(c => c.id === catIds[0]);
    hint = catIds.length === 1 ? ((d?.keywords || [])[0] || _bare(d?.label)) : "";
  } catch (_) {}

  const hasLocal = useCity && list.some(s => s._local);
  const { sendNumberedSellerResults } = await import("./sellerSearchList.js");
  console.log(`[FIND] sellers for ${catIds.join(",")} → ${list.length} (${useCity || "all"} first)`);
  return sendNumberedSellerResults({
    from, phone: _phone(from),
    suppliers: list,
    searchTerm: hint,
    titleLabel: _bare(title),
    locationLabel: hasLocal ? `${useCity} first` : "All Zimbabwe",
    keepOrder: true
  });
}

/**
 * Section picked on the Find home screen.
 *  • no sellers at all          → friendly "Request a Quote" fallback
 *  • one category / few sellers → straight to the numbered seller list
 *  • otherwise                  → numbered categories WITH seller counts
 *                                 (empty categories hidden) + "All …" first
 */
export async function showSection({ from, sectionId, label, biz, saveBiz, dispatch, groupIndex = 0 }) {
  const { getAllCategories, sortCategories } = await import("./categoryRegistry.js");
  const cats = sortCategories((await getAllCategories()).filter(c => c.section === sectionId && c.active !== false));
  const city = await _rememberedCity(from);

  const counts = [];
  const seen = new Set();
  for (const c of cats) {
    const l = await sellersForCategories([c.id], city);
    l.forEach(s => seen.add(String(s._id)));
    if (l.length) counts.push({ cat: c, n: l.length });
  }
  const total = seen.size;
  const catIds = counts.map(x => x.cat.id);

  const extras = [];
  if (sectionId === "food") extras.push({ label: "🛒 Order groceries - delivered or collect", action: "grc_home" });
  if (sectionId === "moving") extras.push({ label: "🏍️ Send a parcel now (biker)", action: "biker_request_rider" });

  if (!total && !extras.length) { await disarmFind(from); return _noSellers(from, label); }
  if (!extras.length && (counts.length <= 1 || total <= 6)) {
    return sendSellersFor({ from, biz, saveBiz, catIds, title: label, city });
  }

  const items = [
    ...extras,
    ...(counts.length > 1 ? [{ label: `🔎 All ${_bare(label)} (${total})`, all: true }] : []),
    ...counts.map(x => ({ label: `${x.cat.label} (${x.n})`, cat: x.cat.id }))
  ];
  await _arm(from, { level: "group", group: groupIndex, section: sectionId, sectionLabel: label, catIds, items });
  const ex = counts[0] ? _bare(counts[0].cat.label).toLowerCase() : "what you need";
  return sendText(from,
`${label}

${items.map((it, i) => `*${i + 1}.* ${it.label}`).join("\n")}

👉 *Reply with a number* to see the sellers, or type exactly what you need (e.g. _${ex}_).`);
}