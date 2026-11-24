// services/categoryRegistry.js
// ─── ZimQuote taxonomy: SECTIONS → CATEGORIES (one source for search + menus) ─
//
//   Section  (key area)       Categories inside it
//   🔧 Trades & Repairs   →  Electricians, Plumbers, Welders, Carpenters, Painters…
//   🧱 Construction        →  Builders, Building Materials, Tiling, Architects…
//   ⚡ Electrical & Solar  →  Electrical Supplies, Solar & Energy…
//   🛒 Groceries & Food    →  Groceries, Catering…
//   …
//
// Built-in sections/categories live in code (SUPPLIER_CATEGORIES + DEFAULT_*
// below). The admin can, on /zq-admin/categories:
//   • add sections and categories, rename, hide, reorder, move a category to
//     another section,
//   • give every section/category BUYER KEYWORDS (what people type).
// Those records are stored in the SearchCategory collection (kind = "section"
// or "category") and merged here. Search, the Find, Buy & Hire menu and the
// admin pages all read from this one registry. Cached 60 s; admin saves call
// invalidateCategories() so changes are live at once.
// ─────────────────────────────────────────────────────────────────────────────
import { SUPPLIER_CATEGORIES } from "./supplierPlans.js";

// ── Built-in sections (order = order in Find, Buy & Hire) ────────────────────
// Section ids never reuse a category id (they share one unique index).
export const DEFAULT_SECTIONS = [
  { id: "trades",        label: "🔧 Trades & Repairs",        type: "service", order: 10, keywords: ["trades", "artisan", "artisans", "handyman", "repairs", "fundi"] },
  { id: "building",      label: "🧱 Construction & Building", type: "both",    order: 20, keywords: ["construction", "building", "builders", "building materials", "hardware"] },
  { id: "power",         label: "⚡ Electrical & Solar",      type: "both",    order: 30, keywords: ["electrical", "electricals", "solar", "power", "energy"] },
  { id: "food",          label: "🛒 Groceries & Food",        type: "both",    order: 40, keywords: ["groceries", "food", "supermarket", "catering"] },
  { id: "auto",          label: "🚗 Cars & Spares",           type: "both",    order: 50, keywords: ["car", "cars", "spares", "auto", "vehicle"] },
  { id: "home",          label: "🏠 Home, Tech & Fashion",     type: "product", order: 60, keywords: ["appliances", "electronics", "furniture", "fashion", "clothes"] },
  { id: "professional",  label: "💼 Professional Services",   type: "service", order: 70, keywords: ["professional", "consultant", "consultants", "office services"] },
  { id: "lifestyle",     label: "🎉 Events, Beauty & Cleaning", type: "service", order: 80, keywords: ["events", "beauty", "cleaning", "wedding"] },
  { id: "moving",        label: "🚚 Transport & Deliveries",  type: "service", order: 90, keywords: ["transport", "delivery", "deliveries", "logistics", "moving"] },
  { id: "farming",       label: "🌱 Farming & Agriculture",   type: "both",    order: 95, keywords: ["farming", "agriculture", "farm"] },
  { id: "travel",        label: "🦁 Tourism & Stay",          type: "service", order: 98, keywords: ["tourism", "travel", "holiday", "accommodation"] },
  { id: "other",         label: "📦 Other",                    type: "both",    order: 999, keywords: [] }
];

// ── Where each built-in category sits + its default buyer keywords ───────────
const DEFAULT_PLACEMENT = {
  electrical:            ["trades",       ["electrician", "electricians", "sparky", "wiring", "rewiring", "magetsi", "db board", "electrical repairs"]],
  plumbing:              ["trades",       ["plumber", "plumbers", "mupombi", "geyser repair", "burst pipe", "blocked drain"]],
  welding:               ["trades",       ["welder", "welders", "burglar bars", "gates", "fabrication"]],
  carpentry:             ["trades",       ["carpenter", "carpenters", "joinery", "cupboards", "kitchen units"]],
  painting:              ["trades",       ["painter", "painters", "house painting"]],
  air_conditioning:      ["trades",       ["aircon", "air conditioning", "fridge repair", "refrigeration"]],
  glazing_aluminium:     ["trades",       ["glass", "glazier", "aluminium windows", "shower screens"]],
  tiling_flooring:       ["building", ["tiler", "tiling", "flooring"]],
  construction:          ["building", ["builder", "builders", "contractor", "renovations", "bricklayer"]],
  building_materials:    ["building", ["cement", "bricks", "river sand", "roofing sheets", "timber"]],
  hardware_tools:        ["building", ["hardware", "tools", "hardware shop"]],
  plumbing_supplies:     ["building", ["pipes", "plumbing supplies", "fittings", "water tanks"]],
  architecture_design:   ["building", ["architect", "house plans", "quantity surveyor"]],
  engineering_services:  ["building", ["engineer", "engineering"]],
  electrical_supplies:   ["power",      ["electrical supplies", "cables", "breakers", "sockets"]],
  solar_energy:          ["power",      ["solar panels", "inverter", "batteries", "solar"]],
  industrial_equipment:  ["power",      ["industrial equipment", "generators", "machinery"]],
  groceries:             ["food",         ["groceries", "mealie meal", "cooking oil", "supermarket"]],
  food_cooked:           ["food",         ["catering", "caterer", "cakes", "lunch boxes"]],
  car_supplies:          ["auto",         ["car parts", "spares", "tyres", "mechanic"]],
  appliances:            ["home",         ["appliances", "fridge", "stove", "washing machine"]],
  electronics:           ["home",         ["phones", "laptops", "tv", "electronics"]],
  furniture:             ["home",         ["furniture", "sofa", "beds"]],
  clothing:              ["home",         ["clothes", "uniforms", "shoes"]],
  cosmetics:             ["home",         ["cosmetics", "skin care", "perfume"]],
  health:                ["home",         ["pharmacy", "medicine"]],
  stationery:            ["home",         ["stationery", "office supplies"]],
  accounting:            ["professional", ["accountant", "bookkeeping", "tax"]],
  legal:                 ["professional", ["lawyer", "attorney", "legal"]],
  financial_advisory:    ["professional", ["financial advisor", "insurance advice"]],
  hr_recruitment:        ["professional", ["recruitment", "hr"]],
  marketing_digital:     ["professional", ["marketing", "website design", "social media"]],
  it_support:            ["professional", ["it support", "computer repair", "laptop repair", "phone repair"]],
  printing:              ["professional", ["printing", "branding", "banners"]],
  real_estate:           ["professional", ["estate agent", "property", "rentals"]],
  medical_health:        ["professional", ["doctor", "dentist", "clinic"]],
  tutoring:              ["professional", ["tutor", "lessons", "teacher"]],
  events_management:     ["lifestyle",    ["events", "event planner", "tent hire", "dj"]],
  photography:           ["lifestyle",    ["photographer", "videographer"]],
  beauty:                ["lifestyle",    ["salon", "hairdresser", "barber", "nails"]],
  cleaning:              ["lifestyle",    ["cleaners", "cleaning", "fumigation"]],
  landscaping:           ["lifestyle",    ["gardener", "landscaping", "lawn"]],
  security:              ["lifestyle",    ["security guards", "cctv", "alarm"]],
  transport:             ["moving",     ["transport", "truck hire", "moving", "courier", "car hire"]],
  agriculture:           ["farming",      ["fertilizer", "seeds", "chicks", "stock feed"]],
  tourism:               ["travel",     ["lodge", "safari", "tours", "hotel"]],
  other_services:        ["other",        []],
  other_products:        ["other",        []]
};

let _cache = null, _at = 0, _loading = null;
const TTL = 60 * 1000;

function _merge(docs = []) {
  // Sections
  const secById = new Map(DEFAULT_SECTIONS.map(s => [s.id, { ...s, builtIn: true, active: true }]));
  for (const d of docs.filter(d => d.kind === "section")) {
    const prev = secById.get(d.id) || { builtIn: false, keywords: [], order: 500, type: "both" };
    secById.set(d.id, {
      ...prev, id: d.id, label: d.label || prev.label || d.id,
      type: d.type || prev.type, order: typeof d.order === "number" && d.order ? d.order : prev.order,
      keywords: (d.keywords && d.keywords.length) ? d.keywords : (prev.keywords || []),
      active: d.active !== false, override: !!prev.builtIn
    });
  }

  // Categories
  const catById = new Map();
  const _placeOrder = Object.keys(DEFAULT_PLACEMENT);
  for (const c of SUPPLIER_CATEGORIES) {
    const [sec, kw] = DEFAULT_PLACEMENT[c.id] || ["other", []];
    const _ord = _placeOrder.indexOf(c.id);
    const types = c.types || ["product"];
    catById.set(c.id, {
      id: c.id, label: c.label, type: types.length > 1 ? "both" : types[0],
      section: sec, keywords: kw, builtIn: true, active: true, subcats: c.subcats || [],
      order: _ord >= 0 ? (_ord + 1) * 10 : 900   // most-searched first (electricians, plumbers…)
    });
  }
  for (const d of docs.filter(d => (d.kind || "category") === "category")) {
    const prev = catById.get(d.id);
    const base = prev || { builtIn: false, keywords: [], section: "other", type: "service", subcats: [], order: 100 };
    catById.set(d.id, {
      ...base, id: d.id, label: d.label || base.label || d.id,
      type: d.type || base.type,
      section: d.section || base.section || "other",
      // Admin keywords ADD to the built-in ones (never lose defaults by accident)
      keywords: [...new Set([...(base.builtIn ? base.keywords : []), ...(d.keywords || [])])],
      active: d.active !== false, order: d.order || (prev ? base.order : 800), override: !!prev
    });
  }
  // A category pointing at a missing/hidden section falls back to "other"
  for (const c of catById.values()) if (!secById.has(c.section)) c.section = "other";

  const sections = [...secById.values()].sort((a, b) => a.order - b.order || a.label.localeCompare(b.label));
  const categories = [...catById.values()];
  return { sections, categories };
}

async function _load() {
  if (_cache && Date.now() - _at < TTL) return _cache;
  if (_loading) return _loading;
  _loading = (async () => {
    try {
      const { default: SearchCategory } = await import("../models/searchCategory.js");
      _cache = _merge(await SearchCategory.find({}).lean());
    } catch (e) {
      console.warn("[CATEGORY REGISTRY]", e.message);
      _cache = _cache || _merge([]);
    }
    _at = Date.now(); _loading = null;
    return _cache;
  })();
  return _loading;
}

/** All categories (built-in + admin), each with .section. Never throws. */
export async function getAllCategories() { return (await _load()).categories; }
/** All sections, ordered. */
export async function getAllSections() { return (await _load()).sections; }
/** Without waiting (built-ins until the first load finishes). */
export function getCategoriesSync() { if (!_cache) _load().catch(() => {}); return (_cache || _merge([])).categories; }
export function getSectionsSync()   { if (!_cache) _load().catch(() => {}); return (_cache || _merge([])).sections; }

export function invalidateCategories() { _cache = null; _at = 0; }

export function categoryLabel(id) {
  const c = getCategoriesSync().find(x => x.id === id);
  return c ? c.label : String(id || "").replace(/_/g, " ");
}
export function sectionOf(catId) {
  return getCategoriesSync().find(c => c.id === catId)?.section || "other";
}

export function slugifyCategory(s = "") {
  return String(s).toLowerCase().normalize("NFKD")
    .replace(/\p{Extended_Pictographic}/gu, "").replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40);
}

/** Sort categories for display: admin/built-in order, then name without emoji. */
export function sortCategories(list = []) {
  const bare = l => String(l || "").replace(/^[^\p{L}\p{N}]+/u, "").toLowerCase();
  return [...list].sort((a, b) => (a.order || 900) - (b.order || 900) || bare(a.label).localeCompare(bare(b.label)));
}
