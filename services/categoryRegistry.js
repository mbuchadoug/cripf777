// services/categoryRegistry.js
// ─── One list of categories for search, admin and menus ──────────────────────
// Built-in SUPPLIER_CATEGORIES (code) + admin categories/keyword overrides
// (SearchCategory collection). Cached in memory for 60 s; admin saves call
// invalidateCategories() so changes apply immediately on this server.
import { SUPPLIER_CATEGORIES } from "./supplierPlans.js";

let _cache = null, _at = 0, _loading = null;
const TTL = 60 * 1000;

function _merge(custom = []) {
  const byId = new Map();
  for (const c of SUPPLIER_CATEGORIES) {
    byId.set(c.id, {
      id: c.id, label: c.label, type: (c.types || ["product"]).length > 1 ? "both" : (c.types || ["product"])[0],
      keywords: [], group: 0, builtIn: true, active: true, subcats: c.subcats || []
    });
  }
  for (const d of custom) {
    const prev = byId.get(d.id);
    if (prev) {
      byId.set(d.id, { ...prev, label: d.label || prev.label, keywords: d.keywords || [],
                       group: d.group || 0, active: d.active !== false, type: d.type || prev.type, override: true });
    } else {
      byId.set(d.id, { id: d.id, label: d.label || d.id, type: d.type || "service", keywords: d.keywords || [],
                       group: d.group || 0, builtIn: false, active: d.active !== false, subcats: [] });
    }
  }
  return [...byId.values()];
}

/** All categories (built-in + admin). Never throws - falls back to built-ins. */
export async function getAllCategories() {
  if (_cache && Date.now() - _at < TTL) return _cache;
  if (_loading) return _loading;
  _loading = (async () => {
    try {
      const { default: SearchCategory } = await import("../models/searchCategory.js");
      const custom = await SearchCategory.find({}).lean();
      _cache = _merge(custom);
    } catch (e) {
      console.warn("[CATEGORY REGISTRY]", e.message);
      _cache = _cache || _merge([]);
    }
    _at = Date.now(); _loading = null;
    return _cache;
  })();
  return _loading;
}

/** Last loaded list without waiting (built-ins if not loaded yet). */
export function getCategoriesSync() {
  if (!_cache) getAllCategories().catch(() => {});
  return _cache || _merge([]);
}

export function invalidateCategories() { _cache = null; _at = 0; }

export function categoryLabel(id) {
  const c = getCategoriesSync().find(x => x.id === id);
  return c ? c.label : String(id || "").replace(/_/g, " ");
}

export function slugifyCategory(s = "") {
  return String(s).toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40);
}
