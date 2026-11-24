// routes/categoryAdmin.js
// ─── Sections → Categories, fast seller classification, search tester ───────
//
// Wired at the bottom of routes/supplierAdmin.js:
//   registerCategoryAdminRoutes(router, { requireSupplierAdmin, layout, esc, badge });
//
//   /zq-admin/categories     The taxonomy. SECTIONS (Trades, Construction,
//                            Electrical & Solar…) each holding CATEGORIES
//                            (Electricians, Plumbers…). Add/rename/hide/reorder,
//                            move a category to another section, buyer keywords,
//                            guided "new category" (section → name → keywords →
//                            preview matching sellers → add them in one go),
//                            merge categories, fix unknown ids.
//   /zq-admin/categorize     Every seller, edited INLINE (no pop-ups): add/remove
//                            categories, tags, type - saved instantly. Bulk on the
//                            ticked sellers OR on every seller matching the filter.
//                            "Auto-assign by words": all sellers whose name/items
//                            contain "plumb" → Plumbers, in one click.
//   /zq-admin/search-tester  Run the real WhatsApp search and see the order.
//
// Everything here feeds the search straight away (categoryRegistry cache is
// cleared on every save): category keywords decide what a buyer means, and
// sellers classified in the named category are listed first.
// ─────────────────────────────────────────────────────────────────────────────

import SupplierProfile from "../models/supplierProfile.js";
import SearchCategory from "../models/searchCategory.js";
import {
  getAllCategories, getAllSections, invalidateCategories, slugifyCategory, sortCategories
} from "../services/categoryRegistry.js";

const PAGE = 50;
const _rx = s => String(s || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const _items = s => [
  ...(s.listedProducts || []), ...(s.products || []),
  ...((s.rates || []).map(r => r?.service || ""))
].flatMap(x => String(x || "").split(/[\r\n,]+/)).map(x => x.trim()).filter(x => x && x !== "pending_upload");
const _searchable = s => s.active === true && s.suspended !== true && ["active", "trial"].includes(s.subscriptionStatus);
const _who = req => String(req.session?.adminUser || req.session?.user || req.user?.email || "admin");
const _csv = v => (Array.isArray(v) ? v : String(v || "").split(/[,\n]+/)).map(x => String(x).trim()).filter(Boolean);
const _tc = s => String(s || "").trim().replace(/\s+/g, " ").toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
const _stamp = req => ({ classifiedAt: new Date(), classifiedBy: _who(req) });

// Text match on a seller's name, items, rates and tags (for previews / auto-assign)
function _wordsFilter(words) {
  const ws = _csv(words).map(w => w.toLowerCase()).filter(w => w.length >= 3);
  if (!ws.length) return null;
  const or = [];
  for (const w of ws) {
    const r = new RegExp(`\\b${_rx(w)}`, "i");
    or.push({ businessName: r }, { products: r }, { listedProducts: r }, { "rates.service": r }, { searchTags: r });
  }
  return { profileType: { $ne: "biker" }, $or: or };
}

// The Classify page filter (also used by "apply to ALL matching")
async function _sellerFilter(q = {}) {
  const cats = await getAllCategories();
  const known = new Set(cats.map(c => c.id));
  const { q: text = "", city = "", cat = "", section = "", type = "", status = "", focus = "" } = q;
  const f = { profileType: { $ne: "biker" } };
  const and = [];
  if (type) f.profileType = type;
  if (city) f["location.city"] = new RegExp(`^\\s*${_rx(city)}\\s*$`, "i");
  if (cat === "__none") and.push({ $or: [{ categories: { $exists: false } }, { categories: { $size: 0 } }] });
  else if (cat === "__unknown") f.categories = { $elemMatch: { $nin: [...known] } };
  else if (cat) f.categories = cat;
  if (section) f.categories = { $in: cats.filter(c => c.section === section).map(c => c.id) };
  if (status === "live") Object.assign(f, { active: true, subscriptionStatus: { $in: ["active", "trial"] } });
  if (status === "hidden") and.push({ $or: [{ active: { $ne: true } }, { subscriptionStatus: { $nin: ["active", "trial"] } }, { suspended: true }] });
  if (status === "untagged") and.push({ $or: [{ searchTags: { $exists: false } }, { searchTags: { $size: 0 } }] });
  if (focus && /^[a-f0-9]{24}$/i.test(focus)) f._id = focus;
  if (text) {
    const r = new RegExp(_rx(text), "i");
    and.push({ $or: [{ businessName: r }, { phone: r }, { products: r }, { listedProducts: r }, { "rates.service": r }, { searchTags: r }] });
  }
  if (and.length) f.$and = and;
  return f;
}

const CSS = `<style>
.zc-wrap{max-width:1320px}
.zc-card{background:#fff;border:1px solid #e5e7eb;border-radius:10px;padding:14px 16px;margin:0 0 14px}
.zc-row{display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end}
.zc-row label{font-size:12px;color:#555;display:flex;flex-direction:column;gap:4px}
.zc input,.zc select,.zc textarea,.zc-row input,.zc-row select,.zc-row textarea{padding:7px 9px;border:1px solid #d1d5db;border-radius:7px;font:inherit}
.zc-btn{background:#0f766e;color:#fff;border:0;border-radius:7px;padding:8px 13px;cursor:pointer;font:inherit;text-decoration:none;display:inline-block}
.zc-btn.sec{background:#e5e7eb;color:#111}.zc-btn.warn{background:#b45309}.zc-btn.sm{padding:4px 9px;font-size:12px}
.zc-t{width:100%;border-collapse:collapse;font-size:13px}
.zc-t th{text-align:left;background:#f9fafb;padding:7px 8px;border-bottom:1px solid #e5e7eb}
.zc-t td{padding:7px 8px;border-bottom:1px solid #f1f5f9;vertical-align:top}
.zc-chip{display:inline-flex;align-items:center;gap:4px;background:#ecfdf5;color:#065f46;border-radius:999px;padding:2px 8px;margin:2px;font-size:12px}
.zc-chip.bad{background:#fef2f2;color:#991b1b}.zc-chip.tag{background:#eff6ff;color:#1e40af}.zc-chip.sec{background:#f5f3ff;color:#5b21b6}
.zc-chip b{cursor:pointer;opacity:.6}.zc-chip b:hover{opacity:1}
.zc-muted{color:#6b7280;font-size:12px}
.zc-pill{font-size:11px;border-radius:6px;padding:1px 6px;background:#f3f4f6}
.zc-pill.ok{background:#dcfce7;color:#166534}.zc-pill.no{background:#fee2e2;color:#991b1b}
.zc-sec{border-left:4px solid #0f766e}
.zc-sec h3{margin:0 0 6px;display:flex;gap:10px;align-items:center;flex-wrap:wrap}
dialog.zcd{border:0;border-radius:12px;padding:0;width:min(760px,96vw);box-shadow:0 20px 60px rgba(0,0,0,.25)}
dialog.zcd .hd{padding:14px 18px;border-bottom:1px solid #eee;font-weight:600}
dialog.zcd .bd{padding:14px 18px;max-height:70vh;overflow:auto}
dialog.zcd .ft{padding:12px 18px;border-top:1px solid #eee;display:flex;gap:8px;justify-content:flex-end}
.zc-step{font-size:12px;font-weight:700;color:#0f766e;margin:12px 0 4px}
.zc-bulk{position:sticky;bottom:8px;background:#111827;color:#fff;padding:10px 14px;border-radius:10px;display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:10px}
.zc-bulk select,.zc-bulk input{padding:6px;border-radius:6px;border:0;font:inherit}
.zc-add{width:170px;padding:3px 6px!important;font-size:12px!important}
.zc-tags{width:100%;min-width:180px;padding:4px 6px!important;font-size:12px!important}
.zc-saved{outline:2px solid #34d399;transition:outline .3s}
.zc-hl{background:#fffbeb}
.zc-toast{position:fixed;right:18px;bottom:18px;background:#111827;color:#fff;padding:10px 14px;border-radius:8px;display:none;z-index:9}
</style>`;

const TOAST = `<div class="zc-toast" id="zcToast"></div>
<script>function zcToast(m){const t=document.getElementById('zcToast');t.textContent=m;t.style.display='block';clearTimeout(window._zt);window._zt=setTimeout(()=>t.style.display='none',2200)}
async function zcPost(u,b){const r=await fetch(u,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)});return r.json()}</script>`;

export function registerCategoryAdminRoutes(router, { requireSupplierAdmin, layout, esc }) {

  // ═══════════════════════════════════════════════════════════════════════════
  // TAXONOMY: SECTIONS → CATEGORIES
  // ═══════════════════════════════════════════════════════════════════════════
  router.get("/categories", requireSupplierAdmin, async (req, res) => {
    invalidateCategories();
    const [cats, secs] = await Promise.all([getAllCategories(), getAllSections()]);
    const known = new Set(cats.map(c => c.id));
    const counts = await SupplierProfile.aggregate([
      { $match: { profileType: { $ne: "biker" } } },
      { $unwind: "$categories" },
      { $group: { _id: "$categories", n: { $sum: 1 },
        live: { $sum: { $cond: [{ $and: [{ $eq: ["$active", true] }, { $in: ["$subscriptionStatus", ["active", "trial"]] }] }, 1, 0] } } } }
    ]);
    const cnt = Object.fromEntries(counts.map(c => [c._id, c]));
    const unknown = counts.filter(c => c._id && !known.has(c._id)).sort((a, b) => b.n - a.n);
    const uncategorised = await SupplierProfile.countDocuments({ profileType: { $ne: "biker" }, $or: [{ categories: { $exists: false } }, { categories: { $size: 0 } }] });

    const catOpts = secs.map(s => `<optgroup label="${esc(s.label)}">${cats.filter(c => c.section === s.id && c.active !== false)
      .map(c => `<option value="${esc(c.id)}">${esc(c.label)}</option>`).join("")}</optgroup>`).join("");
    const J = o => JSON.stringify(o).replace(/</g, "\\u003c").replace(/'/g, "&#39;");

    const secCards = secs.map(sec => {
      const list = sortCategories(cats.filter(c => c.section === sec.id));
      const secTotal = list.reduce((n, c) => n + (cnt[c.id]?.n || 0), 0);
      return `<div class="zc-card zc-sec" ${sec.active === false ? 'style="opacity:.55"' : ""}>
        <h3>${esc(sec.label)} <span class="zc-muted">${list.length} categories · ${secTotal} sellers</span>
          ${sec.active === false ? '<span class="zc-pill no">hidden</span>' : ""}
          <button class="zc-btn sm sec" onclick='zcSec(${J({ id: sec.id, label: sec.label, type: sec.type, keywords: (sec.keywords || []).join(", "), order: sec.order, active: sec.active !== false })})'>Edit section</button>
          <button class="zc-btn sm" onclick='zcCat(${J({ id: "", label: "", section: sec.id, type: sec.type === "both" ? "service" : sec.type, keywords: "", active: true, isNew: true })})'>＋ Category here</button>
          <a class="zc-btn sm sec" href="/zq-admin/categorize?section=${esc(sec.id)}">Sellers</a>
        </h3>
        <div class="zc-muted" style="margin-bottom:6px">Section words: ${(sec.keywords || []).map(k => `<span class="zc-chip sec">${esc(k)}</span>`).join("") || "-"}</div>
        <table class="zc-t"><tr><th style="width:26%">Category</th><th>Type</th><th>Sellers</th><th>Buyer keywords (what people type)</th><th></th></tr>
        ${list.map(c => `<tr ${c.active === false ? 'style="opacity:.5"' : ""}>
          <td><b>${esc(c.label)}</b><div class="zc-muted">${esc(c.id)}${c.builtIn ? "" : " · yours"}${c.active === false ? " · hidden" : ""}</div></td>
          <td>${esc(c.type)}</td>
          <td><a href="/zq-admin/categorize?cat=${esc(c.id)}">${cnt[c.id]?.n || 0}</a> <span class="zc-muted">(${cnt[c.id]?.live || 0} live)</span></td>
          <td>${(c.keywords || []).map(k => `<span class="zc-chip tag">${esc(k)}</span>`).join("") || '<span class="zc-pill no">no keywords - search can\'t recognise it</span>'}</td>
          <td style="white-space:nowrap"><button class="zc-btn sm sec" onclick='zcCat(${J({ id: c.id, label: c.label, section: c.section, type: c.type, keywords: (c.keywords || []).join(", "), active: c.active !== false, isNew: false })})'>Edit</button></td>
        </tr>`).join("") || `<tr><td colspan="5" class="zc-muted">No categories yet.</td></tr>`}
        </table></div>`;
    }).join("");

    const unknownHtml = unknown.length ? `<div class="zc-card" style="border-color:#fca5a5">
      <b>⚠️ ${unknown.length} category ids on sellers don't exist</b> <span class="zc-muted">- these sellers lose category ranking. Move them into a real category:</span>
      <table class="zc-t" style="margin-top:6px">${unknown.map(u => `<tr><td><span class="zc-chip bad">${esc(u._id)}</span> ${u.n} sellers</td><td>
        <form method="post" action="/zq-admin/categories/merge" class="zc-row" style="gap:6px"><input type="hidden" name="from" value="${esc(u._id)}">
        <select name="to">${catOpts}</select><button class="zc-btn sm">Move sellers</button></form></td></tr>`).join("")}</table></div>` : "";

    res.send(layout("Categories", `${CSS}${TOAST}<div class="zc-wrap">
      <h2>🗂️ Sections &amp; Categories</h2>
      <p class="zc-muted"><b>Sections</b> are the big areas buyers browse (Trades, Construction…). <b>Categories</b> sit inside them (Electricians, Plumbers…). A seller can be in several categories. <b>Buyer keywords</b> are how search recognises a category - when a buyer types one, sellers in that category are listed first.</p>
      ${req.query.msg ? `<div class="zc-card" style="background:#ecfdf5">${esc(req.query.msg)}</div>` : ""}
      <div class="zc-row" style="margin-bottom:12px">
        <button class="zc-btn" onclick='zcCat(${J({ id: "", label: "", section: "trades", type: "service", keywords: "", active: true, isNew: true })})'>＋ New category</button>
        <button class="zc-btn sec" onclick='zcSec(${J({ id: "", label: "", type: "service", keywords: "", order: 500, active: true })})'>＋ New section</button>
        <a class="zc-btn sec" href="/zq-admin/categorize">🏷️ Classify sellers</a>
        <a class="zc-btn sec" href="/zq-admin/categorize?cat=__none">⚠️ ${uncategorised} sellers without a category</a>
        <a class="zc-btn sec" href="/zq-admin/search-tester">🔎 Search tester</a>
      </div>
      ${unknownHtml}
      ${secCards}
      <div class="zc-card"><b>Merge two categories</b> <span class="zc-muted">(moves every seller, e.g. duplicates)</span>
        <form method="post" action="/zq-admin/categories/merge" class="zc-row" style="margin-top:8px">
          <label>Move sellers from<select name="from">${catOpts}</select></label>
          <label>into<select name="to">${catOpts}</select></label>
          <label><span><input type="checkbox" name="hideFrom" value="1" checked> hide the old one</span></label>
          <button class="zc-btn warn" onclick="return confirm('Move all sellers?')">Merge</button>
        </form></div>
    </div>

    <dialog class="zcd" id="catDlg"><div class="hd" id="cTitle">Category</div><div class="bd zc">
      <div class="zc-step">1 · Which section?</div>
      <select id="cSection" style="width:100%">${secs.map(s => `<option value="${esc(s.id)}">${esc(s.label)}</option>`).join("")}</select>
      <div class="zc-step">2 · Name buyers will see</div>
      <div class="zc-row"><input id="cLabel" style="flex:1" placeholder="e.g. 🚰 Borehole Drilling" oninput="zcSimilar()">
        <select id="cType"><option value="service">service - people hire them</option><option value="product">product - people buy items</option><option value="both">both</option></select></div>
      <div class="zc-muted" id="cSimilar"></div>
      <div class="zc-step">3 · Buyer keywords - the words people type (at least 2)</div>
      <textarea id="cKw" rows="3" style="width:100%" placeholder="borehole, borehole drilling, water well, siting, mupombi wemvura"></textarea>
      <div class="zc-row" style="margin-top:6px">
        <button type="button" class="zc-btn sm sec" onclick="zcSuggestKw()">✨ Suggest keywords</button>
        <button type="button" class="zc-btn sm sec" onclick="zcPreview()">👀 Which sellers match these words?</button>
        <span class="zc-muted" id="cMsg"></span></div>
      <div id="cPrev" class="zc-muted" style="margin-top:6px"></div>
      <label style="display:none;margin-top:6px;font-size:13px" id="cAddWrap"><input type="checkbox" id="cAdd" checked> Add these matching sellers to this category when I save</label>
      <div class="zc-step">4 · Show it</div>
      <select id="cActive"><option value="1">on - searchable &amp; in the menu</option><option value="0">hidden</option></select>
      <input type="hidden" id="cId"><input type="hidden" id="cNew">
    </div><div class="ft"><button class="zc-btn sec" onclick="catDlg.close()">Cancel</button><button class="zc-btn" onclick="zcSaveCat()">Save</button></div></dialog>

    <dialog class="zcd" id="secDlg"><div class="hd">Section</div><div class="bd zc">
      <div class="zc-row">
        <label style="flex:1">Name<input id="sLabel" placeholder="🔧 Trades & Repairs"></label>
        <label>Usually<select id="sType"><option value="service">services</option><option value="product">products</option><option value="both">both</option></select></label>
        <label>Order in menu<input id="sOrder" type="number" style="width:90px"></label>
        <label>Status<select id="sActive"><option value="1">on</option><option value="0">hidden</option></select></label>
      </div>
      <label style="display:block;margin-top:10px;font-size:12px;color:#555">Section words (a buyer typing one sees the whole section)
        <textarea id="sKw" rows="2" style="width:100%" placeholder="trades, artisans, handyman, fundi"></textarea></label>
      <input type="hidden" id="sId">
    </div><div class="ft"><button class="zc-btn sec" onclick="secDlg.close()">Cancel</button><button class="zc-btn" onclick="zcSaveSec()">Save</button></div></dialog>

    <script>
    const ALL = ${J(cats.map(c => ({ id: c.id, label: c.label, section: c.section })))};
    let PREV_IDS = [];
    function zcCat(c){ cTitle.textContent = c.isNew ? 'New category' : 'Edit: ' + c.label;
      cId.value = c.id; cNew.value = c.isNew ? '1' : ''; cSection.value = c.section; cLabel.value = c.label;
      cType.value = c.type || 'service'; cKw.value = c.keywords || ''; cActive.value = c.active ? '1' : '0';
      cPrev.innerHTML = ''; cMsg.textContent = ''; cSimilar.textContent = ''; cAddWrap.style.display = 'none'; PREV_IDS = []; catDlg.showModal(); }
    function zcSec(s){ sId.value = s.id; sLabel.value = s.label; sType.value = s.type || 'service'; sOrder.value = s.order || 500;
      sKw.value = s.keywords || ''; sActive.value = s.active ? '1' : '0'; secDlg.showModal(); }
    function zcSimilar(){ const v = cLabel.value.toLowerCase().replace(/[^a-z ]/g,'').trim(); if (v.length < 3) { cSimilar.textContent=''; return; }
      const w = v.split(' ').filter(x => x.length > 3).map(x => x.slice(0,5));
      const hit = ALL.filter(c => c.id !== cId.value && w.some(x => c.label.toLowerCase().includes(x)));
      cSimilar.innerHTML = hit.length ? '⚠️ Similar existing: ' + hit.slice(0,5).map(c => '<b>' + c.label + '</b>').join(', ') + ' - add keywords there instead of a duplicate?' : ''; }
    async function zcSuggestKw(){ cMsg.textContent = 'Asking Claude…';
      const j = await zcPost('/zq-admin/categories/suggest-keywords', { label: cLabel.value, section: cSection.value, keywords: cKw.value });
      if (!j.ok) { cMsg.textContent = j.error; return; }
      const have = cKw.value.split(',').map(x=>x.trim()).filter(Boolean);
      cKw.value = [...new Set([...have, ...j.keywords])].join(', '); cMsg.textContent = 'Added suggestions - edit freely.'; }
    async function zcPreview(){ const j = await zcPost('/zq-admin/categories/preview', { keywords: cKw.value, exclude: cId.value });
      if (!j.ok) { cPrev.textContent = j.error; return; }
      PREV_IDS = j.ids; cPrev.innerHTML = '<b>' + j.count + '</b> sellers match' + (j.count ? ': ' + j.names.join(', ') + (j.count > j.names.length ? '…' : '') : '');
      cAddWrap.style.display = j.count ? 'block' : 'none'; }
    async function zcSaveCat(){
      const kw = cKw.value.split(',').map(x=>x.trim()).filter(Boolean);
      if (!cLabel.value.trim()) return alert('Give the category a name.');
      if (cNew.value && kw.length < 2) return alert('Add at least 2 buyer keywords - this is how search recognises the category.');
      const j = await zcPost('/zq-admin/categories/save', { id: cId.value, isNew: cNew.value, label: cLabel.value, section: cSection.value,
        type: cType.value, keywords: cKw.value, active: cActive.value, addSellerIds: (cAddWrap.style.display !== 'none' && cAdd.checked) ? PREV_IDS : [] });
      if (!j.ok) return alert(j.error); location.href = '/zq-admin/categories?msg=' + encodeURIComponent(j.msg); }
    async function zcSaveSec(){
      const j = await zcPost('/zq-admin/sections/save', { id: sId.value, label: sLabel.value, type: sType.value, order: sOrder.value, keywords: sKw.value, active: sActive.value });
      if (!j.ok) return alert(j.error); location.href = '/zq-admin/categories?msg=' + encodeURIComponent(j.msg); }
    </script>`));
  });

  router.post("/categories/save", requireSupplierAdmin, async (req, res) => {
    try {
      const b = req.body || {};
      const label = String(b.label || "").trim().slice(0, 60);
      const id = b.id ? String(b.id) : slugifyCategory(label);
      if (!id || !label) return res.json({ ok: false, error: "Give the category a name." });
      const [cats, secs] = await Promise.all([getAllCategories(), getAllSections()]);
      if (b.isNew && cats.some(c => c.id === id)) return res.json({ ok: false, error: `"${id}" already exists - edit it instead.` });
      if (secs.some(s => s.id === id)) return res.json({ ok: false, error: "That name is used by a section - pick another." });
      const section = secs.some(s => s.id === b.section) ? b.section : "other";
      const keywords = [...new Set(_csv(b.keywords).map(k => k.toLowerCase().slice(0, 40)))].slice(0, 50);
      if (b.isNew && keywords.length < 2) return res.json({ ok: false, error: "Add at least 2 buyer keywords." });
      await SearchCategory.findOneAndUpdate({ id }, { $set: {
        kind: "category", id, label, section,
        type: ["product", "service", "both"].includes(b.type) ? b.type : "service",
        keywords, active: String(b.active ?? "1") !== "0",
        builtIn: cats.some(c => c.id === id && c.builtIn), updatedBy: _who(req)
      } }, { upsert: true });
      let added = 0;
      const ids = (Array.isArray(b.addSellerIds) ? b.addSellerIds : []).filter(x => /^[a-f0-9]{24}$/i.test(x)).slice(0, 2000);
      if (ids.length) {
        const r = await SupplierProfile.updateMany({ _id: { $in: ids } }, { $addToSet: { categories: id }, $set: _stamp(req) });
        added = r.modifiedCount ?? r.nModified ?? 0;
      }
      invalidateCategories();
      res.json({ ok: true, msg: `Saved "${label}"${added ? ` and added ${added} sellers to it` : ""}. Search uses it now.` });
    } catch (e) { res.json({ ok: false, error: e.message }); }
  });

  router.post("/sections/save", requireSupplierAdmin, async (req, res) => {
    try {
      const b = req.body || {};
      const label = String(b.label || "").trim().slice(0, 60);
      const id = b.id ? String(b.id) : slugifyCategory(label);
      if (!id || !label) return res.json({ ok: false, error: "Give the section a name." });
      const cats = await getAllCategories();
      if (cats.some(c => c.id === id)) return res.json({ ok: false, error: "That name is used by a category - pick another." });
      await SearchCategory.findOneAndUpdate({ id }, { $set: {
        kind: "section", id, label,
        type: ["product", "service", "both"].includes(b.type) ? b.type : "both",
        order: parseInt(b.order, 10) || 500,
        keywords: [...new Set(_csv(b.keywords).map(k => k.toLowerCase().slice(0, 40)))].slice(0, 30),
        active: String(b.active ?? "1") !== "0", updatedBy: _who(req)
      } }, { upsert: true });
      invalidateCategories();
      res.json({ ok: true, msg: `Saved section "${label}".` });
    } catch (e) { res.json({ ok: false, error: e.message }); }
  });

  // How many sellers do these words find? (guided new-category step)
  router.post("/categories/preview", requireSupplierAdmin, async (req, res) => {
    const f = _wordsFilter(req.body?.keywords);
    if (!f) return res.json({ ok: false, error: "Type some keywords first (3+ letters)." });
    if (req.body?.exclude) f.categories = { $ne: req.body.exclude };
    const list = await SupplierProfile.find(f, { businessName: 1 }).limit(2000).lean();
    res.json({ ok: true, count: list.length, ids: list.map(s => String(s._id)), names: list.slice(0, 12).map(s => s.businessName) });
  });

  router.post("/categories/suggest-keywords", requireSupplierAdmin, async (req, res) => {
    try {
      const { aiEnabled, aiSuggestKeywords } = await import("../services/searchBrain.js");
      if (!aiEnabled()) return res.json({ ok: false, error: "Add ANTHROPIC_API_KEY to .env for suggestions." });
      const kws = await aiSuggestKeywords(String(req.body?.label || ""), String(req.body?.keywords || ""));
      res.json(kws ? { ok: true, keywords: kws } : { ok: false, error: "No suggestion - try again." });
    } catch (e) { res.json({ ok: false, error: e.message }); }
  });

  router.post("/categories/merge", requireSupplierAdmin, async (req, res) => {
    const from = String(req.body.from || "").trim(), to = String(req.body.to || "").trim();
    if (!from || !to || from === to) return res.redirect("/zq-admin/categories?msg=" + encodeURIComponent("Pick two different categories."));
    const r1 = await SupplierProfile.updateMany({ categories: from }, { $addToSet: { categories: to } });
    await SupplierProfile.updateMany({ categories: from }, { $pull: { categories: from } });
    if (req.body.hideFrom) {
      await SearchCategory.findOneAndUpdate({ id: from }, { $set: { id: from, kind: "category", active: false, updatedBy: _who(req) } }, { upsert: true });
    }
    invalidateCategories();
    res.redirect("/zq-admin/categories?msg=" + encodeURIComponent(`Moved ${r1.modifiedCount ?? r1.nModified ?? 0} sellers from ${from} to ${to}.`));
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // CLASSIFY SELLERS - inline + bulk
  // ═══════════════════════════════════════════════════════════════════════════
  router.get("/categorize", requireSupplierAdmin, async (req, res) => {
    const [cats, secs] = await Promise.all([getAllCategories(), getAllSections()]);
    const known = new Set(cats.map(c => c.id));
    const secLabel = id => secs.find(s => s.id === id)?.label || "";
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const filter = await _sellerFilter(req.query);
    const total = await SupplierProfile.countDocuments(filter);
    const sellers = await SupplierProfile.find(filter, {
      businessName: 1, phone: 1, profileType: 1, location: 1, categories: 1, searchTags: 1, active: 1,
      subscriptionStatus: 1, suspended: 1, products: 1, listedProducts: 1, rates: 1
    }).sort({ active: -1, classifiedAt: 1, businessName: 1 }).skip((page - 1) * PAGE).limit(PAGE).lean();
    const cities = [...new Set((await SupplierProfile.distinct("location.city", { profileType: { $ne: "biker" } })).map(_tc).filter(Boolean))].sort();
    const { q = "", city = "", cat = "", section = "", type = "", status = "" } = req.query;
    const J = o => JSON.stringify(o).replace(/</g, "\\u003c").replace(/'/g, "&#39;");

    // "Section › Category" options for the add boxes and bulk bar
    const catList = secs.flatMap(s => cats.filter(c => c.section === s.id && c.active !== false)
      .map(c => ({ id: c.id, text: `${s.label.replace(/^\S+\s/, "")} › ${c.label}` })));
    const catOptsGrouped = secs.map(s => `<optgroup label="${esc(s.label)}">${cats.filter(c => c.section === s.id && c.active !== false)
      .map(c => `<option value="${esc(c.id)}">${esc(c.label)}</option>`).join("")}</optgroup>`).join("");

    const chip = (id, sid) => `<span class="zc-chip ${known.has(id) ? "" : "bad"}" title="${esc(secLabel(cats.find(c => c.id === id)?.section))}">${esc(cats.find(c => c.id === id)?.label || id)}<b onclick="zcRm('${sid}','${esc(id)}')">✕</b></span>`;

    const rows = sellers.map(s => {
      const sid = String(s._id), items = _items(s);
      return `<tr id="r_${sid}">
        <td><input type="checkbox" class="zcSel" value="${sid}"></td>
        <td style="min-width:190px"><b>${esc(s.businessName)}</b><div class="zc-muted">${esc(s.location?.area || "")}, ${esc(s.location?.city || "")}</div>
          ${_searchable(s) ? '<span class="zc-pill ok">in search</span>' : `<span class="zc-pill no">hidden: ${esc(!s.active ? "inactive" : s.suspended ? "suspended" : s.subscriptionStatus)}</span>`}
          ${items.length ? "" : '<span class="zc-pill no">nothing listed</span>'}</td>
        <td><select class="zc-type" data-id="${sid}" style="font-size:12px;padding:3px">${["product", "service", "tutor", "hospitality"].map(t => `<option${t === s.profileType ? " selected" : ""}>${t}</option>`).join("")}</select></td>
        <td style="min-width:240px"><span class="zcCats">${(s.categories || []).map(c => chip(c, sid)).join("") || '<span class="zc-pill no">none</span>'}</span><br>
          <input class="zc-add" list="zcCatList" data-id="${sid}" placeholder="＋ add category…"></td>
        <td style="min-width:200px"><input class="zc-tags" data-id="${sid}" value="${esc((s.searchTags || []).join(", "))}" placeholder="words buyers type…"></td>
        <td class="zc-muted" style="max-width:240px">${esc(items.slice(0, 6).join(", "))}${items.length > 6 ? ` +${items.length - 6}` : ""}</td>
        <td style="white-space:nowrap"><button class="zc-btn sm sec" onclick="zcAi('${sid}',this)" title="Claude suggests categories + tags and applies them">✨</button>
          <a class="zc-btn sm sec" href="/zq-admin/suppliers/${sid}/edit" title="Full profile">↗</a></td>
      </tr>`;
    }).join("");

    const qs = p => "?" + new URLSearchParams({ q, city, cat, section, type, status, page: p }).toString();
    const pages = Math.ceil(total / PAGE);
    const pager = pages > 1 ? `<div class="zc-row" style="margin:8px 0">Page ${Array.from({ length: pages }, (_, i) => i + 1).map(p =>
      p === page ? `<b>${p}</b>` : `<a href="/zq-admin/categorize${qs(p)}">${p}</a>`).join(" ")}</div>` : "";

    res.send(layout("Categorize Sellers", `${CSS}${TOAST}<div class="zc-wrap">
      <h2>🏷️ Classify sellers</h2>
      <p class="zc-muted">Everything saves as you go. <b>Categories</b>: type in the "add category" box and pick. <b>Search tags</b>: the exact words buyers type - press Enter or click away to save. Tick sellers (or use "all matching") for bulk changes.</p>
      ${req.query.msg ? `<div class="zc-card" style="background:#ecfdf5">${esc(req.query.msg)}</div>` : ""}
      <datalist id="zcCatList">${catList.map(c => `<option value="${esc(c.text)}">`).join("")}</datalist>

      <form class="zc-card zc-row" method="get">
        <label>Search<input name="q" value="${esc(q)}" placeholder="name, item, tag, phone"></label>
        <label>City<select name="city"><option value="">All</option>${cities.map(c => `<option${c.toLowerCase() === String(city).toLowerCase() ? " selected" : ""}>${esc(c)}</option>`).join("")}</select></label>
        <label>Section<select name="section"><option value="">All</option>${secs.map(s => `<option value="${esc(s.id)}"${s.id === section ? " selected" : ""}>${esc(s.label)}</option>`).join("")}</select></label>
        <label>Category<select name="cat"><option value="">All</option><option value="__none"${cat === "__none" ? " selected" : ""}>⚠️ No category</option><option value="__unknown"${cat === "__unknown" ? " selected" : ""}>⚠️ Unknown id</option>${catOptsGrouped.replace(`value="${esc(cat)}"`, `value="${esc(cat)}" selected`)}</select></label>
        <label>Type<select name="type"><option value="">All</option>${["product", "service", "tutor", "hospitality"].map(t => `<option${t === type ? " selected" : ""}>${t}</option>`).join("")}</select></label>
        <label>Show<select name="status"><option value="">All</option><option value="live"${status === "live" ? " selected" : ""}>In search</option><option value="hidden"${status === "hidden" ? " selected" : ""}>Hidden from search</option><option value="untagged"${status === "untagged" ? " selected" : ""}>No search tags</option></select></label>
        <button class="zc-btn">Filter</button><span class="zc-muted"><b>${total}</b> sellers</span>
        <a class="zc-btn sec" href="/zq-admin/categories">🗂️ Sections &amp; categories</a>
        <a class="zc-btn sec" href="/zq-admin/search-tester">🔎 Tester</a>
      </form>

      <div class="zc-card">
        <b>⚡ Auto-assign by words</b> <span class="zc-muted">- every seller whose name, items or tags contain these words gets the category (and the words as tags).</span>
        <div class="zc-row" style="margin-top:8px">
          <label>Words<input id="awWords" placeholder="plumb, geyser, burst pipe" style="width:280px"></label>
          <label>Category<select id="awCat">${catOptsGrouped}</select></label>
          <label><span><input type="checkbox" id="awTags" checked> also add words as tags</span></label>
          <button class="zc-btn sec" onclick="zcAw(false)">Preview</button>
          <button class="zc-btn" onclick="zcAw(true)">Apply</button>
          <span class="zc-muted" id="awMsg"></span>
        </div>
      </div>

      <div class="zc-row" style="margin-bottom:8px">
        <form method="post" action="/zq-admin/categorize/fix-locations" onsubmit="return confirm('Trim spaces and fix capitals in every seller city/suburb?')"><button class="zc-btn sec">🧹 Fix city/suburb spelling</button></form>
      </div>

      <div class="zc-card" style="padding:0;overflow:auto">
        <table class="zc-t"><tr><th><input type="checkbox" id="allChk"></th><th>Seller</th><th>Type</th><th>Categories</th><th>Search tags</th><th>Lists</th><th></th></tr>
        ${rows || '<tr><td colspan="7" class="zc-muted">No sellers match.</td></tr>'}</table>
      </div>
      ${pager}

      <div class="zc-bulk">
        <select id="bScope"><option value="sel">Ticked (0)</option><option value="all">ALL ${total} matching this filter</option></select>
        <select id="bOp">
          <option value="addCat">Add category</option><option value="setCat">Replace categories with</option><option value="removeCat">Remove category</option>
          <option value="addTags">Add tags</option><option value="removeTags">Remove tags</option><option value="setType">Set type</option>
          <option value="ai">✨ Claude: suggest &amp; apply (ticked, max 50)</option></select>
        <select id="bCat">${catOptsGrouped}</select>
        <input id="bText" placeholder="tags, comma separated" style="display:none">
        <select id="bType" style="display:none"><option>service</option><option>product</option></select>
        <button class="zc-btn" onclick="zcBulk()">Apply</button><span id="bMsg"></span>
      </div>
    </div>
    <script>
    const CATS = ${J(catList)};
    const LBL = ${J(Object.fromEntries(cats.map(c => [c.id, c.label])))};
    const FILTER = ${J(req.query)};
    const esc = s => String(s||'').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
    function chips(id, list){ return (list||[]).map(c => '<span class="zc-chip">' + esc(LBL[c]||c) + '<b onclick="zcRm(\\''+id+'\\',\\''+c+'\\')">✕</b></span>').join('') || '<span class="zc-pill no">none</span>'; }
    function flash(id){ const r = document.getElementById('r_'+id); r.classList.add('zc-saved'); setTimeout(()=>r.classList.remove('zc-saved'),700); }
    function paint(id, j){ const r = document.getElementById('r_'+id); if (!r || !j.seller) return;
      r.querySelector('.zcCats').innerHTML = chips(id, j.seller.categories);
      r.querySelector('.zc-tags').value = (j.seller.searchTags||[]).join(', ');
      r.querySelector('.zc-type').value = j.seller.profileType; flash(id); }
    async function one(id, op, value){ const j = await zcPost('/zq-admin/categorize/one', { id, op, value }); if (!j.ok) return zcToast(j.error||'Failed'); paint(id, j); }
    function zcRm(id, cat){ one(id, 'removeCat', cat); }
    document.querySelectorAll('.zc-add').forEach(inp => inp.addEventListener('change', () => {
      const hit = CATS.find(c => c.text === inp.value) || CATS.find(c => c.text.toLowerCase().includes(inp.value.toLowerCase()));
      if (!hit) return zcToast('Pick a category from the list');
      inp.value = ''; one(inp.dataset.id, 'addCat', hit.id); }));
    document.querySelectorAll('.zc-tags').forEach(inp => { inp.dataset.orig = inp.value;
      const save = () => { if (inp.value === inp.dataset.orig) return; inp.dataset.orig = inp.value; one(inp.dataset.id, 'setTags', inp.value); };
      inp.addEventListener('blur', save); inp.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); save(); } }); });
    document.querySelectorAll('.zc-type').forEach(sel => sel.addEventListener('change', () => one(sel.dataset.id, 'setType', sel.value)));
    async function zcAi(id, btn){ btn.disabled = true; btn.textContent = '…';
      const j = await zcPost('/zq-admin/categorize/ai', { id }); btn.disabled = false; btn.textContent = '✨';
      if (!j.ok) return zcToast(j.error); paint(id, j); zcToast(j.reason || 'Applied'); }
    const sel = () => [...document.querySelectorAll('.zcSel:checked')].map(x => x.value);
    function cnt(){ bScope.options[0].text = 'Ticked (' + sel().length + ')'; }
    allChk.addEventListener('change', () => { document.querySelectorAll('.zcSel').forEach(x => x.checked = allChk.checked); cnt(); });
    document.addEventListener('change', e => { if (e.target.classList.contains('zcSel')) cnt();
      if (e.target.id === 'bOp') { const v = bOp.value; bCat.style.display = /Cat/.test(v) ? '' : 'none'; bText.style.display = /Tags/.test(v) ? '' : 'none'; bType.style.display = v === 'setType' ? '' : 'none'; } });
    async function zcBulk(){
      const scope = bScope.value, ids = sel(), v = bOp.value;
      if (scope === 'sel' && !ids.length) return zcToast('Tick some sellers, or choose ALL matching.');
      if (v === 'ai') {
        if (!ids.length) return zcToast('Tick the sellers for Claude (max 50).');
        bMsg.textContent = ' working…';
        for (const id of ids.slice(0, 50)) { const j = await zcPost('/zq-admin/categorize/ai', { id }); if (j.ok) paint(id, j); }
        bMsg.textContent = ' done'; return; }
      if (scope === 'all' && !confirm('Apply to ALL ${total} sellers matching this filter?')) return;
      const value = /Cat/.test(v) ? bCat.value : /Tags/.test(v) ? bText.value : bType.value;
      const j = await zcPost('/zq-admin/categorize/bulk', { ids, scope, filter: FILTER, op: v, value });
      if (!j.ok) return zcToast(j.error || 'Failed'); location.href = location.pathname + location.search.replace(/([?&])msg=[^&]*/,'') + (location.search ? '&' : '?') + 'msg=' + encodeURIComponent('Updated ' + j.modified + ' sellers'); }
    async function zcAw(apply){
      const j = await zcPost('/zq-admin/categorize/auto-assign', { words: awWords.value, category: awCat.value, tags: awTags.checked, apply });
      if (!j.ok) return awMsg.textContent = j.error;
      if (!apply) { awMsg.innerHTML = '<b>' + j.count + '</b> sellers: ' + j.names.join(', ') + (j.count > j.names.length ? '…' : ''); return; }
      location.href = '/zq-admin/categorize?cat=' + encodeURIComponent(awCat.value) + '&msg=' + encodeURIComponent('Added ' + j.modified + ' sellers to ' + (LBL[awCat.value]||awCat.value)); }
    </script>`));
  });

  // Single-seller instant edit (inline controls)
  router.post("/categorize/one", requireSupplierAdmin, async (req, res) => {
    try {
      const { id, op, value } = req.body || {};
      if (!/^[a-f0-9]{24}$/i.test(String(id || ""))) return res.json({ ok: false, error: "Bad seller id" });
      const cats = await getAllCategories();
      const known = new Set(cats.map(c => c.id));
      const st = _stamp(req);
      let u;
      if (op === "addCat" && known.has(value))  u = { $addToSet: { categories: value }, $set: st };
      else if (op === "removeCat")              u = { $pull: { categories: value }, $set: st };
      else if (op === "setTags")                u = { $set: { searchTags: [...new Set(_csv(value).map(t => t.toLowerCase().slice(0, 40)))].slice(0, 30), ...st } };
      else if (op === "setType" && ["product", "service", "tutor", "hospitality"].includes(value)) u = { $set: { profileType: value, ...st } };
      else return res.json({ ok: false, error: "Unknown change" });
      await SupplierProfile.updateOne({ _id: id }, u);
      const seller = await SupplierProfile.findById(id).lean();
      res.json({ ok: true, seller: { categories: seller.categories || [], searchTags: seller.searchTags || [], profileType: seller.profileType } });
    } catch (e) { res.json({ ok: false, error: e.message }); }
  });

  router.post("/categorize/bulk", requireSupplierAdmin, async (req, res) => {
    try {
      const { ids = [], scope, filter: fq = {}, op, value } = req.body || {};
      const f = scope === "all" ? await _sellerFilter(fq) : { _id: { $in: (ids || []).filter(x => /^[a-f0-9]{24}$/i.test(x)) } };
      if (scope !== "all" && !f._id.$in.length) return res.json({ ok: false, error: "Tick sellers first." });
      const known = new Set((await getAllCategories()).map(c => c.id));
      const st = _stamp(req);
      const tags = _csv(value).map(t => t.toLowerCase().slice(0, 40));
      let u;
      if (op === "addCat" && known.has(value))      u = { $addToSet: { categories: value }, $set: st };
      else if (op === "setCat" && known.has(value)) u = { $set: { categories: [value], ...st } };
      else if (op === "removeCat")                  u = { $pull: { categories: value }, $set: st };
      else if (op === "addTags" && tags.length)     u = { $addToSet: { searchTags: { $each: tags } }, $set: st };
      else if (op === "removeTags" && tags.length)  u = { $pull: { searchTags: { $in: tags } }, $set: st };
      else if (op === "setType" && ["product", "service"].includes(value)) u = { $set: { profileType: value, ...st } };
      else return res.json({ ok: false, error: "Choose an action and a value." });
      const r = await SupplierProfile.updateMany(f, u);
      res.json({ ok: true, modified: r.modifiedCount ?? r.nModified ?? 0 });
    } catch (e) { res.json({ ok: false, error: e.message }); }
  });

  router.post("/categorize/auto-assign", requireSupplierAdmin, async (req, res) => {
    try {
      const { words, category, tags, apply } = req.body || {};
      const f = _wordsFilter(words);
      if (!f) return res.json({ ok: false, error: "Type some words (3+ letters)." });
      const known = new Set((await getAllCategories()).map(c => c.id));
      if (!known.has(category)) return res.json({ ok: false, error: "Pick a category." });
      if (!apply) {
        const list = await SupplierProfile.find({ ...f, categories: { $ne: category } }, { businessName: 1 }).limit(2000).lean();
        return res.json({ ok: true, count: list.length, names: list.slice(0, 15).map(s => s.businessName) });
      }
      const u = { $addToSet: { categories: category }, $set: _stamp(req) };
      if (tags) u.$addToSet.searchTags = { $each: _csv(words).map(w => w.toLowerCase().slice(0, 40)) };
      const r = await SupplierProfile.updateMany(f, u);
      res.json({ ok: true, modified: r.modifiedCount ?? r.nModified ?? 0 });
    } catch (e) { res.json({ ok: false, error: e.message }); }
  });

  // Claude suggests categories + tags for ONE seller and applies them (adds, never removes)
  router.post("/categorize/ai", requireSupplierAdmin, async (req, res) => {
    try {
      const { aiClassifySeller, aiEnabled } = await import("../services/searchBrain.js");
      if (!aiEnabled()) return res.json({ ok: false, error: "Add ANTHROPIC_API_KEY to .env to use ✨." });
      const s = await SupplierProfile.findById(req.body.id).lean();
      if (!s) return res.json({ ok: false, error: "Seller not found" });
      const sug = await aiClassifySeller(s);
      if (!sug) return res.json({ ok: false, error: "No suggestion (timeout or daily cap) - try again." });
      const set = {
        categories: [...new Set([...(s.categories || []), ...sug.categories])],
        searchTags: [...new Set([...(s.searchTags || []), ...sug.tags])].slice(0, 30),
        classifiedAt: new Date(), classifiedBy: _who(req) + " (AI)"
      };
      await SupplierProfile.updateOne({ _id: s._id }, { $set: set });
      res.json({ ok: true, reason: sug.reason, seller: { categories: set.categories, searchTags: set.searchTags, profileType: s.profileType } });
    } catch (e) { res.json({ ok: false, error: e.message }); }
  });

  router.post("/categorize/fix-locations", requireSupplierAdmin, async (req, res) => {
    const all = await SupplierProfile.find({}, { location: 1 }).lean();
    let n = 0;
    for (const s of all) {
      const city = _tc(s.location?.city), area = _tc(s.location?.area);
      if (city && (city !== s.location?.city || (area && area !== s.location?.area))) {
        await SupplierProfile.updateOne({ _id: s._id }, { $set: { "location.city": city, ...(area ? { "location.area": area } : {}) } });
        n++;
      }
    }
    res.redirect("/zq-admin/categorize?msg=" + encodeURIComponent(`Fixed city/suburb spelling on ${n} sellers.`));
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // SEARCH TESTER
  // ═══════════════════════════════════════════════════════════════════════════
  router.get("/search-tester", requireSupplierAdmin, async (req, res) => {
    const q = String(req.query.q || "").trim();
    const city = String(req.query.city || "").trim();
    let body = "";
    if (q) {
      const S = await import("../services/supplierSearch.js");
      const SB = await import("../services/searchBrain.js");
      const [cats, secs] = await Promise.all([getAllCategories(), getAllSections()]);
      const label = id => cats.find(c => c.id === id)?.label || id;
      const parsed = S.parseShortcodeSearch(q) || { product: q, city: null };
      const product = String(parsed.product || q).toLowerCase();
      const useCity = city ? _tc(city) : (parsed.city || null);
      const intent = await SB.getSearchIntent(product, { knownToSynonyms: S.expandSearchTerms(product).length > 1 });
      const _log = console.log; console.log = () => {};
      let offers = [];
      try { offers = await S.runSupplierOfferSearch({ city: useCity, product }); } finally { console.log = _log; }
      const order = []; for (const o of offers) if (!order.includes(o.supplierId)) order.push(o.supplierId);
      const sellers = await SupplierProfile.find({ _id: { $in: order } }).lean();
      const intCats = new Set(intent?.categories || []);
      const catFirst = !!(intent && intent.named && intent.kind !== "product" && intCats.size);
      body = `<div class="zc-card">
        <div><b>Buyer typed:</b> "${esc(product)}"${useCity ? ` in <b>${esc(useCity)}</b>` : " (all cities)"}</div>
        <div><b>Understood as:</b> ${intent ? `${esc(intent.kind || "")} · ${(intent.categories || []).map(c => `<span class="zc-chip">${esc(label(c))}</span>`).join("")}${intent.section ? ` (whole section ${esc(secs.find(s => s.id === intent.section)?.label || "")})` : ""} <span class="zc-muted">via ${esc(intent.source)}</span>` : '<span class="zc-pill no">not recognised - add these words as keywords to a category</span>'}</div>
        <div class="zc-muted">${catFirst ? "Category-first: sellers classified in these categories are listed before item-only matches." : intent?.kind === "product" ? "Product search: sellers listing the item come first; category breaks ties." : ""}</div>
        ${offers[0]?._aiRewrite ? `<div>✨ Claude rewrote it to <b>${esc(offers[0]._aiRewrite)}</b></div>` : ""}
      </div>
      <div class="zc-card" style="padding:0;overflow:auto"><table class="zc-t">
        <tr><th>#</th><th>Seller</th><th>In category?</th><th>Type</th><th>City</th><th>Categories</th><th>Tags</th><th>Shown item</th><th>Item</th><th>Tag</th><th>Intent</th><th></th></tr>
        ${order.map((id, i) => {
          const s = sellers.find(x => String(x._id) === id) || {};
          const os = offers.filter(o => o.supplierId === id);
          const inCat = (s.categories || []).some(c => intCats.has(c));
          return `<tr><td>${i + 1}</td><td><b>${esc(s.businessName)}</b></td><td>${inCat ? '<span class="zc-pill ok">yes</span>' : '<span class="zc-pill">no</span>'}</td>
            <td>${esc(s.profileType)}</td><td>${esc(s.location?.city)}${os[0]?._nonLocal ? ' <span class="zc-pill">other city</span>' : ""}</td>
            <td>${(s.categories || []).map(c => `<span class="zc-chip">${esc(label(c))}</span>`).join("")}</td>
            <td>${(s.searchTags || []).map(t => `<span class="zc-chip tag">${esc(t)}</span>`).join("")}</td>
            <td>${esc(os[0]?.product)}</td><td>${Math.max(...os.map(o => o.matchScore || 0))}</td><td>${S.tagScore(s, product)}</td><td>${SB.intentBonus(s, intent)}</td>
            <td><a class="zc-btn sm sec" href="/zq-admin/categorize?focus=${id}">Fix</a></td></tr>`;
        }).join("") || '<tr><td colspan="12">Nothing found. Add the words as keywords to a category, then classify sellers into it.</td></tr>'}
      </table></div>`;
    }
    res.send(layout("Search Tester", `${CSS}<div class="zc-wrap">
      <h2>🔎 Search tester</h2>
      <p class="zc-muted">Runs the real WhatsApp search. Type exactly like a buyer, e.g. <i>electrician borrowdale</i>, <i>plumbers</i>, <i>cement</i>, <i>trades</i>.</p>
      <form class="zc-card zc-row" method="get">
        <label>Buyer types<input name="q" value="${esc(q)}" placeholder="electrician harare" style="width:280px" autofocus></label>
        <label>City (optional)<input name="city" value="${esc(city)}" placeholder="from the text, or all"></label>
        <button class="zc-btn">Search</button>
        <a class="zc-btn sec" href="/zq-admin/categorize">🏷️ Classify</a><a class="zc-btn sec" href="/zq-admin/categories">🗂️ Categories</a>
      </form>${body}</div>`));
  });
}
