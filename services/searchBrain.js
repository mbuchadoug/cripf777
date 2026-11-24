// services/searchBrain.js
// ─── ZimQuote search understanding ───────────────────────────────────────────
//
// Turns what a buyer types into an INTENT the ranker can use:
//   { kind, profileType, categories[], canonical, source }
//
//   "electrician"            → service · electrical          (hire a person)
//   "cable 10mm"             → product · electrical_supplies (buy an item)
//   "mealie meal"            → product · groceries
//   "mupombi" / "plumer"     → rules miss → Claude → service · plumbing
//
// Two layers:
//   1. RULES  - instant, free, cover ~90% of real searches.
//   2. CLAUDE - only when rules can't read the query, or a search found
//               nothing. Needs ANTHROPIC_API_KEY in .env. Cached, capped per
//               day, 3.5 s timeout. If the key is missing or the call fails,
//               search simply works on rules - it never errors or blocks.
//
// .env (optional):
//   ANTHROPIC_API_KEY=sk-ant-...
//   ZQ_AI_MODEL=claude-haiku-5-5        (small fast model is right for this)
//   ZQ_AI_DAILY_CAP=3000                (max AI calls per day; default 3000)
//   ZQ_AI_SEARCH=off                    (kill switch)
// ─────────────────────────────────────────────────────────────────────────────

// ── 1. RULES ─────────────────────────────────────────────────────────────────
// Each rule: regex on the lower-cased query, what kind of thing it is, and the
// SUPPLIER_CATEGORIES ids (services/supplierPlans.js) it belongs to.
// Order matters only for `canonical` (first hit wins); categories are merged.
const RULES = [
  // ── Hire a person (services) ──────────────────────────────────────────────
  { re: /\b(electrician|electricians|electric(al)? (repair|fault|work|contractor)s?|re-?wir(e|ing)|wiring|house wiring|db board install|fault finding)\b/, kind: "service", type: "service", cats: ["electrical"], canonical: "electrician" },
  { re: /\b(plumb(er|ers|ing)|burst pipe|blocked (drain|toilet|sink)|geyser (repair|install|fix|fitting)|no hot water|leaking (tap|pipe|geyser))\b/, kind: "service", type: "service", cats: ["plumbing"], canonical: "plumber" },
  { re: /\b(solar install(er|ers|ation)?|install(ing)? solar)\b/, kind: "service", type: "service", cats: ["electrical", "solar_energy"], canonical: "solar installation" },
  { re: /\b(builder|builders|bricklay(er|ing)|construction (company|work)|contractor|renovat(e|ion|ions)|plaster(er|ing)|roof(er|ing) (repair|work)|extension)\b/, kind: "service", type: "service", cats: ["construction"], canonical: "builder" },
  { re: /\b(painter|painters|house painting|paint(ing)? (my|a|the) (house|room|wall))\b/, kind: "service", type: "service", cats: ["painting"], canonical: "painter" },
  { re: /\b(welder|welders|welding|burglar bars?|gate (fabrication|repair)|steel gate|carport)\b/, kind: "service", type: "service", cats: ["welding"], canonical: "welder" },
  { re: /\b(carpenter|carpentry|joiner|built.?in cupboards?|kitchen units?|wardrobe fitting)\b/, kind: "service", type: "service", cats: ["carpentry"], canonical: "carpenter" },
  { re: /\b(tiler|tiling|floor tiles? fitting|laminate floor)\b/, kind: "service", type: "service", cats: ["tiling_flooring", "construction"], canonical: "tiler" },
  { re: /\b(clean(er|ers|ing)( service| company)?|maid|domestic worker|carpet cleaning|deep clean)\b/, kind: "service", type: "service", cats: ["cleaning"], canonical: "cleaning" },
  { re: /\b(pest control|fumigat(e|ion)|termites?|cockroach(es)?)\b/, kind: "service", type: "service", cats: ["other_services", "cleaning"], canonical: "pest control" },
  { re: /\b(gardener|gardening|lawn|grass cutting|landscap(e|er|ing)|tree (felling|cutting|trimming))\b/, kind: "service", type: "service", cats: ["landscaping"], canonical: "gardener" },
  { re: /\b(mechanic|mechanics|panel beat(er|ing)?|car (service|repair|servicing)|gearbox repair|engine repair)\b/, kind: "service", type: "service", cats: ["car_supplies", "other_services"], canonical: "mechanic" },
  { re: /\b(aircon|air con(ditioner)? (repair|install|service)|fridge repair|refrigeration|cold room)\b/, kind: "service", type: "service", cats: ["air_conditioning"], canonical: "air conditioning repair" },
  { re: /\b(tutor|tutors|tutoring|teacher|lessons|extra lessons|home tuition)\b/, kind: "service", type: "service", cats: ["tutoring"], canonical: "tutor" },
  { re: /\b(photograph(er|ers|y)|videograph(er|y)|wedding (photos|video))\b/, kind: "service", type: "service", cats: ["photography"], canonical: "photographer" },
  { re: /\b(cater(er|ers|ing)|chef|lunch boxes|event food)\b/, kind: "service", type: "service", cats: ["food_cooked"], canonical: "catering" },
  { re: /\b(hair ?dresser|salon|barber|braids?|braiding|nails|nail tech|makeup artist|lashes)\b/, kind: "service", type: "service", cats: ["beauty"], canonical: "salon" },
  { re: /\b(lawyer|lawyers|attorney|legal (advice|services)|conveyanc(er|ing))\b/, kind: "service", type: "service", cats: ["legal"], canonical: "lawyer" },
  { re: /\b(accountant|accounting|bookkeep(er|ing)|tax (returns?|consultant)|zimra|audit(or|ing)?)\b/, kind: "service", type: "service", cats: ["accounting"], canonical: "accountant" },
  { re: /\b(doctor|dentist|dental|clinic|physio|nurse|optometrist)\b/, kind: "service", type: "service", cats: ["medical_health"], canonical: "doctor" },
  { re: /\b(security guards?|guarding|cctv install(ation)?|alarm install(ation)?|electric fenc(e|ing))\b/, kind: "service", type: "service", cats: ["security"], canonical: "security company" },
  { re: /\b(laptop repair|phone repair|computer repair|it support|wifi (setup|install)|networking|web design|website (design|developer))\b/, kind: "service", type: "service", cats: ["it_support", "marketing_digital"], canonical: "it support" },
  { re: /\b(printing|printer services|branding|banners?|t-?shirt printing|business cards|signage)\b/, kind: "service", type: "service", cats: ["printing"], canonical: "printing" },
  { re: /\b(event planner|wedding planner|dj|mc|tent hire|decor hire)\b/, kind: "service", type: "service", cats: ["events_management"], canonical: "events" },
  { re: /\b(architect|plans? drawing|house plans?|quantity surveyor|structural engineer)\b/, kind: "service", type: "service", cats: ["architecture_design"], canonical: "architect" },

  // ── Move something / deliver ──────────────────────────────────────────────
  { re: /\b(deliver(y|ies)?|courier|transport|truck hire|lorry|moving|removals?|relocat(e|ion)|car hire|airport transfer)\b/, kind: "delivery", type: "service", cats: ["transport"], canonical: "delivery" },

  // ── Buy an item (products) ────────────────────────────────────────────────
  { re: /\b(groceries|grocery|mealie ?meal|roller meal|cooking oil|sugar|rice|flour|bread|eggs|milk|kapenta|matemba|beef|chicken|vegetables|fruit|drinks|soft drinks)\b/, kind: "grocery", type: "product", cats: ["groceries"], canonical: "groceries" },
  { re: /\b(cement|river sand|pit sand|quarry|stones?|bricks?|blocks|iron sheets|roofing sheets|ibr|timber|rafters|steel bars?|rebar|brick force|lintels?)\b/, kind: "product", type: "product", cats: ["building_materials", "hardware_tools"], canonical: null },
  { re: /\b(cables?|wire|breakers?|db box|sockets?|switches|conduit|bulbs?|light fittings?)\b/, kind: "product", type: "product", cats: ["electrical_supplies"], canonical: null },
  { re: /\b(solar panels?|inverters?|lithium|batteries|battery|charge controller)\b/, kind: "product", type: "product", cats: ["solar_energy"], canonical: null },
  { re: /\b(pipes?|pvc|fittings|taps?|valves?|jojo|water tanks?|basins?|toilet seat)\b/, kind: "product", type: "product", cats: ["plumbing_supplies"], canonical: null },
  { re: /\b(tyres?|tires?|spares|spare parts|car parts|brake pads|shocks|filters|engine oil)\b/, kind: "product", type: "product", cats: ["car_supplies"], canonical: null },
  { re: /\b(phones?|smartphones?|laptops?|tv|television|speakers?|tablets?)\b/, kind: "product", type: "product", cats: ["electronics"], canonical: null },
  { re: /\b(fridge|freezer|stove|cooker|washing machine|microwave|kettle|blender)\b/, kind: "product", type: "product", cats: ["appliances"], canonical: null },
  { re: /\b(sofa|couch|beds?|mattress|wardrobes?|dining (table|set)|office chairs?|desks?)\b/, kind: "product", type: "product", cats: ["furniture"], canonical: null },
  { re: /\b(uniforms?|clothes|clothing|shoes|sneakers|dresses|suits)\b/, kind: "product", type: "product", cats: ["clothing"], canonical: null },
  { re: /\b(stationery|exercise books|pens|printing paper|bond paper|a4 paper)\b/, kind: "product", type: "product", cats: ["stationery"], canonical: null },
  { re: /\b(fertili[sz]er|seeds?|day old chicks|chicks|stock ?feed|pesticides?|herbicides?|compound d|ammonium nitrate)\b/, kind: "product", type: "product", cats: ["agriculture"], canonical: null },
  { re: /\b(paint|primer|varnish|tools|drill|grinder|wheelbarrow|padlock|nails|screws)\b/, kind: "product", type: "product", cats: ["hardware_tools", "building_materials"], canonical: null },
  { re: /\b(lotion|perfume|skin ?care|cosmetics|weave|wigs?)\b/, kind: "product", type: "product", cats: ["cosmetics"], canonical: null },
  { re: /\b(medicine|pharmacy|chemist|tablets for|pills)\b/, kind: "product", type: "product", cats: ["health"], canonical: null }
];

import { getCategoriesSync, getAllCategories } from "./categoryRegistry.js";

const _escRx = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Admin keywords (Categories & Tags page) become rules too: if the buyer's text
// contains a keyword of category X, X is part of the intent. This is how a new
// category like "borehole_drilling" with keywords "borehole, drilling" starts
// working in search without a code change.
function _adminHits(q) {
  const hits = [];
  for (const c of getCategoriesSync()) {
    if (c.active === false || !(c.keywords || []).length) continue;
    const kw = c.keywords.map(k => String(k || "").toLowerCase().trim()).filter(k => k.length >= 3);
    if (kw.some(k => new RegExp(`(^|\\s)${_escRx(k)}(s|es)?(\\s|$)`).test(q.trim()))) {
      hits.push({ kind: c.type === "product" ? "product" : "service",
                  type: c.type === "both" ? null : c.type, cats: [c.id], canonical: null });
    }
  }
  return hits;
}

export function ruleIntent(text = "") {
  const q = " " + String(text || "").toLowerCase().replace(/[^a-z0-9\s-]/g, " ").replace(/\s+/g, " ").trim() + " ";
  if (!q.trim()) return null;
  const hits = [...RULES.filter(r => r.re.test(q)), ..._adminHits(q)];
  if (!hits.length) return null;
  const first = hits[0];
  const types = new Set(hits.map(h => h.type).filter(Boolean));
  return {
    kind: first.kind,
    profileType: types.size === 1 ? [...types][0] : null,   // mixed → don't push either way
    categories: [...new Set(hits.flatMap(h => h.cats))],
    canonical: first.canonical || null,
    source: "rules"
  };
}

// ── 2. CLAUDE ────────────────────────────────────────────────────────────────
const CATEGORY_IDS = [
  "electrical", "plumbing", "construction", "painting", "welding", "carpentry", "tiling_flooring",
  "cleaning", "landscaping", "air_conditioning", "glazing_aluminium", "security", "transport",
  "tutoring", "photography", "food_cooked", "beauty", "legal", "accounting", "medical_health",
  "it_support", "printing", "events_management", "architecture_design", "marketing_digital",
  "engineering_services", "real_estate", "tourism", "other_services",
  "groceries", "building_materials", "hardware_tools", "electrical_supplies", "solar_energy",
  "plumbing_supplies", "car_supplies", "electronics", "appliances", "furniture", "clothing",
  "cosmetics", "health", "stationery", "agriculture", "industrial_equipment", "other_products"
];

function _catIds() {
  const ids = getCategoriesSync().filter(c => c.active !== false).map(c => c.id);
  return ids.length ? ids : CATEGORY_IDS;
}

const _aiCache = new Map();          // query → { at, value }
const AI_TTL_MS = 24 * 60 * 60 * 1000;
let _aiDay = "", _aiCount = 0;

export function aiEnabled() {
  return !!process.env.ANTHROPIC_API_KEY && String(process.env.ZQ_AI_SEARCH || "").toLowerCase() !== "off";
}

function _underDailyCap() {
  const day = new Date().toISOString().slice(0, 10);
  if (day !== _aiDay) { _aiDay = day; _aiCount = 0; }
  const cap = Number(process.env.ZQ_AI_DAILY_CAP || 3000);
  return _aiCount < cap;
}

/**
 * Ask Claude what the buyer means. Returns
 *   { query, type, categories[], city, area, alternatives[] }  or null.
 * Never throws.
 */
export async function aiInterpret(text = "") {
  const key = String(text || "").toLowerCase().trim().slice(0, 160);
  if (!key || !aiEnabled()) return null;

  const hit = _aiCache.get(key);
  if (hit && Date.now() - hit.at < AI_TTL_MS) return hit.value;
  if (!_underDailyCap()) return null;
  _aiCount++;

  const system =
    "You read search queries typed into ZimQuote, a WhatsApp marketplace in Zimbabwe. " +
    "Queries may be English, Shona, Ndebele, slang, misspelt, or a business name. " +
    "Reply with ONLY a JSON object, no prose:\n" +
    '{"query":"<1-4 word plain English search term a seller would list>",' +
    '"type":"service"|"product"|null,' +
    '"categories":[<0-3 ids from the list>],' +
    '"city":"<Zimbabwe city or null>","area":"<suburb or null>",' +
    '"alternatives":[<up to 3 other short search terms with the same meaning>]}\n' +
    "type=service when the buyer wants to hire a person or business to do work; " +
    "product when they want to buy goods. Never invent a business name.\n" +
    "Category ids: " + _catIds().join(", ");

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 3500);
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: ctrl.signal,
      headers: {
        "content-type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: process.env.ZQ_AI_MODEL || "claude-haiku-5-5",
        max_tokens: 200,
        system,
        messages: [{ role: "user", content: key }]
      })
    });
    if (!res.ok) {
      console.warn("[SEARCH AI] HTTP", res.status);
      return null;
    }
    const data = await res.json();
    const raw = (data?.content || []).map(c => c?.text || "").join("").trim();
    const json = raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1);
    const p = JSON.parse(json);
    const value = {
      query: String(p.query || "").toLowerCase().trim().slice(0, 60),
      type: p.type === "service" || p.type === "product" ? p.type : null,
      categories: (Array.isArray(p.categories) ? p.categories : []).filter(c => _catIds().includes(c)).slice(0, 3),
      city: p.city && p.city !== "null" ? String(p.city).slice(0, 40) : null,
      area: p.area && p.area !== "null" ? String(p.area).slice(0, 40) : null,
      alternatives: (Array.isArray(p.alternatives) ? p.alternatives : [])
        .map(a => String(a || "").toLowerCase().trim().slice(0, 60)).filter(Boolean).slice(0, 3)
    };
    _aiCache.set(key, { at: Date.now(), value });
    if (_aiCache.size > 3000) _aiCache.delete(_aiCache.keys().next().value);
    console.log(`[SEARCH AI] "${key}" → "${value.query}" ${value.type || ""} [${value.categories.join(",")}]`);
    return value;
  } catch (e) {
    console.warn("[SEARCH AI]", e.name === "AbortError" ? "timeout" : e.message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Intent for ranking. Rules first; Claude only for queries the rules can't
 * read AND that the synonym map doesn't know (`knownToSynonyms`).
 */
export async function getSearchIntent(text = "", { knownToSynonyms = false } = {}) {
  try { await getAllCategories(); } catch (_) {}   // admin keywords loaded/cached
  const r = ruleIntent(text);
  if (r) return r;
  if (knownToSynonyms || !aiEnabled()) return null;
  const ai = await aiInterpret(text);
  if (!ai || (!ai.type && !ai.categories.length)) return null;
  return {
    kind: ai.type || null,
    profileType: ai.type,
    categories: ai.categories,
    canonical: ai.query || null,
    source: "ai"
  };
}

/**
 * Score bonus a supplier gets from matching the intent.
 *   category match   +20
 *   right kind        +10   (service for "electrician", product for "cable")
 *   wrong kind        -15   (a cable shop for "electrician")
 */
export function intentBonus(supplier, intent) {
  if (!intent || !supplier) return 0;
  let b = 0;
  const cats = (supplier.categories || []).map(c => String(c || "").toLowerCase());
  if (intent.categories?.length && intent.categories.some(c => cats.includes(c))) b += 20;
  const _p = supplier.profileType;
  const pt = ["service", "tutor", "hospitality"].includes(_p) ? "service"
           : (_p === "product" || !_p) ? "product" : null;   // bikers etc: neutral
  if (intent.profileType && pt) b += pt === intent.profileType ? 10 : -15;
  return b;
}


// ─────────────────────────────────────────────────────────────────────────────
// ADMIN: suggest categories + search tags for a seller (Categories & Tags page)
// Returns { categories[], tags[], profileType, reason } or null. Admin approves.
// ─────────────────────────────────────────────────────────────────────────────
export async function aiClassifySeller(seller = {}) {
  if (!aiEnabled() || !_underDailyCap()) return null;
  _aiCount++;
  const cats = (await getAllCategories()).filter(c => c.active !== false);
  const items = [
    ...(seller.listedProducts || []), ...(seller.products || []),
    ...((seller.rates || []).map(r => r?.service || ""))
  ].flatMap(x => String(x || "").split(/[\r\n,]+/)).map(x => x.trim()).filter(x => x && x !== "pending_upload").slice(0, 60);
  const prompt =
    `Business: ${seller.businessName}\nCurrent type: ${seller.profileType}\nCity: ${seller.location?.city || ""}\n` +
    `Current categories: ${(seller.categories || []).join(", ") || "none"}\n` +
    `What they list: ${items.join("; ") || "nothing listed"}`;
  const system =
    "You classify sellers on ZimQuote, a Zimbabwe WhatsApp marketplace, so buyers can find them. " +
    "Reply with ONLY JSON: " +
    '{"categories":[1-4 ids from the list, best first],"tags":[5-12 short lowercase words/phrases buyers would type to find this business, incl. job titles like electrician/plumber and common Zimbabwe terms],' +
    '"profileType":"product"|"service","reason":"<one short sentence>"}\n' +
    "Only use ids from this list:\n" + cats.map(c => `${c.id} = ${c.label}`).join("\n");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12000);
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST", signal: ctrl.signal,
      headers: { "content-type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: process.env.ZQ_AI_MODEL || "claude-haiku-5-5", max_tokens: 400, system,
                             messages: [{ role: "user", content: prompt }] })
    });
    if (!res.ok) { console.warn("[AI CLASSIFY] HTTP", res.status); return null; }
    const data = await res.json();
    const raw = (data?.content || []).map(c => c?.text || "").join("");
    const p = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1));
    const ids = new Set(cats.map(c => c.id));
    return {
      categories: (p.categories || []).filter(c => ids.has(c)).slice(0, 4),
      tags: (p.tags || []).map(t => String(t || "").toLowerCase().trim().slice(0, 40)).filter(Boolean).slice(0, 12),
      profileType: p.profileType === "service" || p.profileType === "product" ? p.profileType : null,
      reason: String(p.reason || "").slice(0, 200)
    };
  } catch (e) {
    console.warn("[AI CLASSIFY]", e.message);
    return null;
  } finally { clearTimeout(timer); }
}
