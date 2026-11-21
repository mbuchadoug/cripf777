// services/pageSellers.js
// Shared by routes/tradesApi.js (public API) and routes/pageSellersAdmin.js (admin).
import PageSellers from "../models/pageSellers.js";
import SupplierProfile from "../models/supplierProfile.js";

export const ZQ_WA = "263771143904";
export const waLink = text => `https://wa.me/${ZQ_WA}?text=${encodeURIComponent(text)}`;
export const sellerLink = slug => slug ? waLink("ZQ:S:" + slug) : "";

// "/blog/x/", "/blog/x/index.html", "/Blog/X" -> "/blog/x"
export function normPath(p) {
  let s = String(p || "/").trim();
  try { if (/^https?:\/\//i.test(s)) s = new URL(s).pathname; } catch (_) {}
  s = s.split("?")[0].split("#")[0].toLowerCase();
  s = s.replace(/\/index\d*\.html?$/, "/").replace(/\.html?$/, "");
  s = s.replace(/\/{2,}/g, "/").replace(/\/+$/, "");
  if (!s.startsWith("/")) s = "/" + s;
  return s.slice(0, 200) || "/";
}

export function safeLink(u) {
  const s = String(u || "").trim();
  return /^https:\/\/[^\s"'<>]+$/i.test(s) ? s.slice(0, 500) : "";
}

// ── tiny cache so busy pages don't hit Mongo on every view ────────────────────
const TTL = 60 * 1000;
const cache = new Map();
export function clearPageSellersCache() { cache.clear(); }

const SUP_FIELDS = "businessName location zqSlug tier active verified topSupplierBadge rating reviewCount";

function cityOk(item, city) {
  if (!city || !item.cities) return true;
  const want = String(city).toLowerCase().trim();
  return item.cities.split(",").map(x => x.trim().toLowerCase()).filter(Boolean).includes(want);
}

// Turns a page doc into ready-to-render cards. Inactive / deleted suppliers are skipped.
async function buildCards(doc) {
  const ids = [...(doc.items || []).filter(i => i.kind === "supplier" && i.supplier).map(i => i.supplier),
               ...(doc.ctaSupplier ? [doc.ctaSupplier] : [])];
  const sups = ids.length ? await SupplierProfile.find({ _id: { $in: ids } }).select(SUP_FIELDS).lean() : [];
  const byId = new Map(sups.map(s => [String(s._id), s]));

  const cards = [];
  for (const it of doc.items || []) {
    if (it.kind === "custom") {
      const link = safeLink(it.link);
      if (!it.name || !link) continue;
      cards.push({ name: it.name, meta: it.meta || "", badge: it.badge || "", top: !!it.top,
                   link, slug: "", city: "", area: "", cities: it.cities || "" });
      continue;
    }
    const s = byId.get(String(it.supplier));
    if (!s || s.active === false) continue;           // hidden until the seller is active again
    const slug = s.zqSlug || "";
    if (!slug) continue;                              // no smart link yet -> nothing to tap
    const loc = s.location || {};
    cards.push({
      name:  it.name || s.businessName || "Listed business",
      meta:  it.meta || [loc.area, loc.city].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join(", "),
      badge: it.badge || "", top: !!it.top,
      link: sellerLink(slug), slug,
      city: loc.city || "", area: loc.area || loc.city || "",
      rating: s.rating || 0, reviews: s.reviewCount || 0,
      cities: it.cities || "",
    });
  }
  let cta = null;
  if (doc.ctaSupplier) {
    const s = byId.get(String(doc.ctaSupplier));
    if (s && s.active !== false && s.zqSlug) cta = { name: s.businessName, link: sellerLink(s.zqSlug) };
  }
  return { cards, cta };
}

export async function getPageConfig(path) {
  const key = normPath(path);
  const hit = cache.get(key);
  if (hit && hit.at > Date.now() - TTL) return hit.val;
  let val = null;
  const doc = await PageSellers.findOne({ path: key }).lean();
  if (doc) {
    const { cards, cta } = await buildCards(doc);
    val = { doc, cards, cta };
  }
  cache.set(key, { at: Date.now(), val });
  if (cache.size > 500) cache.delete(cache.keys().next().value);
  return val;
}

// Payload for the static-site loader (assets/zq-sellers.js). Never exposes phones.
export async function publicPagePayload(path) {
  const cfg = await getPageConfig(path);
  if (!cfg) return { managed: false };
  const d = cfg.doc;
  return {
    managed: true,
    status: d.status,
    heading: d.heading || "",
    sub: d.sub || "",
    showListCard: d.showListCard !== false,
    listCard: { title: d.listCardTitle || "", text: d.listCardText || "", link: waLink("ZQ:REGISTER") },
    cta: cfg.cta,
    // live-list pages pin these themselves (via /api/suppliers?page=), so the
    // loader must not add a second box there unless the page already has one.
    pinLive: !!d.pinLive,
    sellers: cfg.cards.map(c => ({ name: c.name, meta: c.meta, badge: c.badge, top: c.top, link: c.link })),
  };
}

// For the live strips on tool pages: cards in the same shape as tradesApi mapSupplier().
export async function pinnedForLive(path, city) {
  if (!path) return null;
  const cfg = await getPageConfig(path);
  if (!cfg || cfg.doc.status !== "managed" || !cfg.doc.pinLive) return null;
  const list = cfg.cards.filter(c => cityOk(c, city)).map(c => ({
    name: c.name, area: c.meta || c.area || c.city || "", city: c.city || city || "",
    badge: c.badge || (c.top ? "Featured" : null), rating: c.rating || 0, reviews: c.reviews || 0,
    slug: c.slug || "", smartLink: c.link, top: !!c.top, pinned: true,
  }));
  return { mode: cfg.doc.liveMode === "only" ? "only" : "pin", list };
}

// Merge pinned cards in front of the live search results (dedupe by slug / name).
export function mergePinned(pinned, live, max) {
  if (!pinned) return live;
  if (pinned.mode === "only") return pinned.list.slice(0, max);
  const seen = new Set(pinned.list.map(p => p.slug || p.name));
  return [...pinned.list, ...live.filter(s => !seen.has(s.slug || s.name))].slice(0, max);
}
