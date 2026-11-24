// routes/categoryAdmin.js
// ─── Categories, seller classification & search tester (/zq-admin) ──────────
//
// Wired at the bottom of routes/supplierAdmin.js:
//   registerCategoryAdminRoutes(router, { requireSupplierAdmin, layout, esc, badge });
//
// Pages
//   /zq-admin/categories      Every category (built-in + yours): seller counts,
//                             buyer keywords, Find-menu group, add / rename / hide,
//                             MERGE one category into another (moves sellers),
//                             unknown category ids still on sellers → map them.
//   /zq-admin/categorize      Every seller in one table: categories (many per
//                             seller), search tags, type. Filters, bulk actions,
//                             "✨ Suggest" (Claude proposes categories + tags,
//                             you approve), one-click city/suburb clean-up.
//   /zq-admin/search-tester   Type a search like a buyer and see exactly who
//                             comes back, in order, with the scores - and fix
//                             a seller straight from there.
//
// Nothing here changes how sellers register on WhatsApp; it only makes them
// findable. All writes are logged with classifiedBy/updatedBy.
// ─────────────────────────────────────────────────────────────────────────────

import SupplierProfile from "../models/supplierProfile.js";
import SearchCategory from "../models/searchCategory.js";
import { getAllCategories, invalidateCategories, slugifyCategory } from "../services/categoryRegistry.js";

const FIND_GROUP_NAMES = [
  "", "🔧 Home repairs & trades", "🛒 Groceries & food", "🧱 Building & hardware", "☀️ Solar & power",
  "🚗 Cars, spares & mechanics", "🏠 Home, tech & fashion", "💼 Professional services", "🎉 Events, beauty & cleaning"
];
const PAGE = 50;

const _items = s => [
  ...(s.listedProducts || []), ...(s.products || []),
  ...((s.rates || []).map(r => r?.service || ""))
].flatMap(x => String(x || "").split(/[\r\n,]+/)).map(x => x.trim()).filter(x => x && x !== "pending_upload");
const _searchable = s => s.active === true && s.suspended !== true && ["active", "trial"].includes(s.subscriptionStatus);
const _who = req => String(req.session?.adminUser || req.session?.user || req.user?.email || "admin");
const _csv = v => String(v || "").split(/[,\n]+/).map(x => x.trim()).filter(Boolean);
const _tc = s => String(s || "").trim().replace(/\s+/g, " ").toLowerCase().replace(/\b\w/g, c => c.toUpperCase());

const CSS = `<style>
.zc-wrap{max-width:1280px}
.zc-card{background:#fff;border:1px solid #e5e7eb;border-radius:10px;padding:16px;margin:0 0 16px}
.zc-row{display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end}
.zc-row label{font-size:12px;color:#555;display:flex;flex-direction:column;gap:4px}
.zc-row input,.zc-row select,.zc-row textarea{padding:7px 9px;border:1px solid #d1d5db;border-radius:7px;font:inherit}
.zc-btn{background:#0f766e;color:#fff;border:0;border-radius:7px;padding:8px 13px;cursor:pointer;font:inherit;text-decoration:none;display:inline-block}
.zc-btn.sec{background:#e5e7eb;color:#111}.zc-btn.warn{background:#b45309}.zc-btn.sm{padding:4px 9px;font-size:12px}
.zc-t{width:100%;border-collapse:collapse;font-size:13px}
.zc-t th{text-align:left;background:#f9fafb;padding:8px;border-bottom:1px solid #e5e7eb;position:sticky;top:0}
.zc-t td{padding:8px;border-bottom:1px solid #f1f5f9;vertical-align:top}
.zc-chip{display:inline-block;background:#ecfdf5;color:#065f46;border-radius:999px;padding:2px 8px;margin:2px;font-size:12px}
.zc-chip.bad{background:#fef2f2;color:#991b1b}.zc-chip.tag{background:#eff6ff;color:#1e40af}
.zc-muted{color:#6b7280;font-size:12px}
.zc-pill{font-size:11px;border-radius:6px;padding:1px 6px;background:#f3f4f6}
.zc-pill.ok{background:#dcfce7;color:#166534}.zc-pill.no{background:#fee2e2;color:#991b1b}
dialog.zc{border:0;border-radius:12px;padding:0;width:min(860px,96vw);box-shadow:0 20px 60px rgba(0,0,0,.25)}
dialog.zc .hd{padding:14px 18px;border-bottom:1px solid #eee;font-weight:600}
dialog.zc .bd{padding:14px 18px;max-height:65vh;overflow:auto}
dialog.zc .ft{padding:12px 18px;border-top:1px solid #eee;display:flex;gap:8px;justify-content:flex-end}
.zc-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:4px 12px}
.zc-grid label{font-size:13px;display:flex;gap:6px;align-items:center}
.zc-bulk{position:sticky;bottom:0;background:#111827;color:#fff;padding:10px 14px;border-radius:10px;display:none;gap:8px;align-items:center;flex-wrap:wrap}
.zc-bulk select,.zc-bulk input{padding:6px;border-radius:6px;border:0}
.zc-hl{background:#fffbeb}
</style>`;

export function registerCategoryAdminRoutes(router, { requireSupplierAdmin, layout, esc, badge }) {

  // ═══════════════════════════════════════════════════════════════════════════
  // CATEGORIES
  // ═══════════════════════════════════════════════════════════════════════════
  router.get("/categories", requireSupplierAdmin, async (req, res) => {
    invalidateCategories();
    const cats = await getAllCategories();
    const known = new Set(cats.map(c => c.id));
    const counts = await SupplierProfile.aggregate([
      { $match: { profileType: { $ne: "biker" } } },
      { $unwind: "$categories" },
      { $group: { _id: "$categories", n: { $sum: 1 }, live: { $sum: { $cond: [{ $and: [{ $eq: ["$active", true] }, { $in: ["$subscriptionStatus", ["active", "trial"]] }] }, 1, 0] } } } }
    ]);
    const cnt = Object.fromEntries(counts.map(c => [c._id, c]));
    const unknown = counts.filter(c => c._id && !known.has(c._id)).sort((a, b) => b.n - a.n);
    const msg = req.query.msg ? `<div class="zc-card" style="background:#ecfdf5">${esc(req.query.msg)}</div>` : "";

    const catOptions = cats.filter(c => c.active !== false).map(c => `<option value="${esc(c.id)}">${esc(c.label)} (${esc(c.id)})</option>`).join("");

    const rows = cats.sort((a, b) => (a.type || "").localeCompare(b.type || "") || a.label.localeCompare(b.label)).map(c => `
      <tr>
        <td><b>${esc(c.label)}</b><div class="zc-muted">${esc(c.id)} ${c.builtIn ? "· built-in" : "· custom"}${c.override ? " · edited" : ""}</div></td>
        <td>${esc(c.type)}</td>
        <td>${cnt[c.id]?.n || 0} <span class="zc-muted">(${cnt[c.id]?.live || 0} live)</span></td>
        <td>${(c.keywords || []).map(k => `<span class="zc-chip tag">${esc(k)}</span>`).join("") || '<span class="zc-muted">-</span>'}</td>
        <td>${c.group ? esc(FIND_GROUP_NAMES[c.group] || c.group) : '<span class="zc-muted">default</span>'}</td>
        <td>${c.active === false ? '<span class="zc-pill no">hidden</span>' : '<span class="zc-pill ok">on</span>'}</td>
        <td style="white-space:nowrap">
          <button class="zc-btn sm sec" onclick='zcEdit(${JSON.stringify({ id: c.id, label: c.label, type: c.type, keywords: (c.keywords || []).join(", "), group: c.group || 0, active: c.active !== false, builtIn: !!c.builtIn }).replace(/'/g, "&#39;")})'>Edit</button>
          <a class="zc-btn sm sec" href="/zq-admin/categorize?cat=${encodeURIComponent(c.id)}">Sellers</a>
        </td>
      </tr>`).join("");

    const unknownHtml = unknown.length ? `
      <div class="zc-card" style="border-color:#fca5a5">
        <h3 style="margin-top:0">⚠️ Category ids on sellers that don't exist (${unknown.length})</h3>
        <p class="zc-muted">These sellers lose the category boost in search. Map each one to a real category (sellers are moved), or create it as a new category.</p>
        <table class="zc-t"><tr><th>Id on sellers</th><th>Sellers</th><th>Map to</th></tr>
        ${unknown.map(u => `<tr><td><span class="zc-chip bad">${esc(u._id)}</span></td><td>${u.n}</td><td>
          <form method="post" action="/zq-admin/categories/merge" class="zc-row" style="gap:6px">
            <input type="hidden" name="from" value="${esc(u._id)}">
            <select name="to">${catOptions}</select>
            <button class="zc-btn sm">Move sellers</button>
          </form>
          <form method="post" action="/zq-admin/categories/save" class="zc-row" style="gap:6px;margin-top:6px">
            <input type="hidden" name="id" value="${esc(u._id)}"><input type="hidden" name="isNew" value="1">
            <input name="label" placeholder="Label for new category" value="${esc(String(u._id).replace(/_/g, " "))}">
            <select name="type"><option>service</option><option>product</option><option>both</option></select>
            <button class="zc-btn sm sec">Create as category</button>
          </form></td></tr>`).join("")}
        </table>
      </div>` : "";

    res.send(layout("Categories", `${CSS}<div class="zc-wrap">
      <h2>🗂️ Categories</h2>
      <p class="zc-muted">Sellers can be in several categories. <b>Keywords</b> are words buyers type ("borehole, drilling") - the search uses them to understand the buyer and rank the right sellers first. The <b>group</b> decides where the category is listed under Find, Buy &amp; Hire.</p>
      ${msg}
      <div class="zc-row" style="margin-bottom:12px">
        <a class="zc-btn" href="/zq-admin/categorize">🏷️ Classify sellers</a>
        <a class="zc-btn sec" href="/zq-admin/search-tester">🔎 Search tester</a>
        <button class="zc-btn sec" onclick="zcEdit({id:'',label:'',type:'service',keywords:'',group:0,active:true,builtIn:false})">➕ New category</button>
      </div>
      ${unknownHtml}
      <div class="zc-card">
        <h3 style="margin-top:0">Merge a category into another</h3>
        <form method="post" action="/zq-admin/categories/merge" class="zc-row">
          <label>Move every seller in<select name="from">${catOptions}</select></label>
          <label>into<select name="to">${catOptions}</select></label>
          <label><span><input type="checkbox" name="hideFrom" value="1"> hide the old one afterwards</span></label>
          <button class="zc-btn warn" onclick="return confirm('Move all sellers?')">Merge</button>
        </form>
      </div>
      <div class="zc-card" style="padding:0;overflow:auto">
        <table class="zc-t"><tr><th>Category</th><th>Type</th><th>Sellers</th><th>Buyer keywords</th><th>Find group</th><th>Status</th><th></th></tr>${rows}</table>
      </div>
    </div>
    <dialog class="zc" id="catDlg"><form method="post" action="/zq-admin/categories/save">
      <div class="hd" id="catTitle">Category</div>
      <div class="bd">
        <input type="hidden" name="isNew" id="cNew">
        <div class="zc-row">
          <label>Label (shown to buyers)<input name="label" id="cLabel" required style="width:300px" placeholder="🚰 Borehole Drilling"></label>
          <label>Id<input name="id" id="cId" style="width:200px" placeholder="auto from label"></label>
          <label>Type<select name="type" id="cType"><option value="service">service (hire)</option><option value="product">product (buy)</option><option value="both">both</option></select></label>
          <label>Find group<select name="group" id="cGroup">${FIND_GROUP_NAMES.map((g, i) => `<option value="${i}">${i ? esc(g) : "default / not listed"}</option>`).join("")}</select></label>
          <label>Status<select name="active" id="cActive"><option value="1">on</option><option value="0">hidden</option></select></label>
        </div>
        <label style="display:block;margin-top:10px;font-size:12px;color:#555">Buyer keywords (comma separated - what people type)
          <textarea name="keywords" id="cKw" rows="3" style="width:100%" placeholder="borehole, borehole drilling, water well, siting"></textarea></label>
        <p class="zc-muted">Tip: include job titles (electrician), local terms (mupombi) and common misspellings.</p>
      </div>
      <div class="ft"><button type="button" class="zc-btn sec" onclick="catDlg.close()">Cancel</button><button class="zc-btn">Save</button></div>
    </form></dialog>
    <script>
    function zcEdit(c){
      catTitle.textContent = c.id ? 'Edit: '+c.label : 'New category';
      cNew.value = c.id ? '' : '1'; cId.value = c.id; cId.readOnly = !!c.id;
      cLabel.value = c.label; cType.value = c.type || 'service'; cKw.value = c.keywords || '';
      cGroup.value = c.group || 0; cActive.value = c.active ? '1' : '0';
      catDlg.showModal();
    }
    </script>`));
  });

  router.post("/categories/save", requireSupplierAdmin, async (req, res) => {
    const b = req.body || {};
    const id = slugifyCategory(b.id || b.label);
    if (!id) return res.redirect("/zq-admin/categories?msg=" + encodeURIComponent("Give the category a label."));
    const cats = await getAllCategories();
    const builtIn = cats.some(c => c.id === id && c.builtIn);
    if (b.isNew && cats.some(c => c.id === id) && !builtIn) {
      return res.redirect("/zq-admin/categories?msg=" + encodeURIComponent(`"${id}" already exists - edit it instead.`));
    }
    await SearchCategory.findOneAndUpdate({ id }, { $set: {
      id, label: String(b.label || "").trim().slice(0, 60),
      type: ["product", "service", "both"].includes(b.type) ? b.type : "service",
      keywords: [...new Set(_csv(b.keywords).map(k => k.toLowerCase().slice(0, 40)))].slice(0, 40),
      group: Math.max(0, Math.min(8, parseInt(b.group, 10) || 0)),
      active: String(b.active ?? "1") !== "0",
      builtIn, updatedBy: _who(req)
    } }, { upsert: true });
    invalidateCategories();
    res.redirect("/zq-admin/categories?msg=" + encodeURIComponent(`Saved ${id}. Search uses it straight away.`));
  });

  router.post("/categories/merge", requireSupplierAdmin, async (req, res) => {
    const from = String(req.body.from || "").trim(), to = String(req.body.to || "").trim();
    if (!from || !to || from === to) return res.redirect("/zq-admin/categories?msg=" + encodeURIComponent("Pick two different categories."));
    const r1 = await SupplierProfile.updateMany({ categories: from }, { $addToSet: { categories: to } });
    await SupplierProfile.updateMany({ categories: from }, { $pull: { categories: from } });
    if (req.body.hideFrom) {
      await SearchCategory.findOneAndUpdate({ id: from }, { $set: { id: from, active: false, updatedBy: _who(req) } }, { upsert: true });
      invalidateCategories();
    }
    res.redirect("/zq-admin/categories?msg=" + encodeURIComponent(`Moved ${r1.modifiedCount ?? r1.nModified ?? 0} sellers from ${from} to ${to}.`));
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // CLASSIFY SELLERS
  // ═══════════════════════════════════════════════════════════════════════════
  router.get("/categorize", requireSupplierAdmin, async (req, res) => {
    const cats = await getAllCategories();
    const known = new Set(cats.map(c => c.id));
    const label = id => cats.find(c => c.id === id)?.label || id;
    const { q = "", city = "", cat = "", type = "", status = "", focus = "" } = req.query;
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);

    const filter = { profileType: { $ne: "biker" } };
    if (type) filter.profileType = type;
    if (city) filter["location.city"] = new RegExp(`^\\s*${city.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "i");
    if (cat === "__none") filter.$or = [{ categories: { $exists: false } }, { categories: { $size: 0 } }];
    else if (cat === "__unknown") filter.categories = { $elemMatch: { $nin: [...known] } };
    else if (cat) filter.categories = cat;
    if (status === "live") Object.assign(filter, { active: true, subscriptionStatus: { $in: ["active", "trial"] } });
    if (status === "hidden") filter.$and = [{ $or: [{ active: { $ne: true } }, { subscriptionStatus: { $nin: ["active", "trial"] } }, { suspended: true }] }];
    if (status === "untagged") filter.$and = [{ $or: [{ searchTags: { $exists: false } }, { searchTags: { $size: 0 } }] }];
    if (focus && /^[a-f0-9]{24}$/i.test(focus)) { filter._id = focus; }
    if (q) {
      const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      (filter.$and = filter.$and || []).push({ $or: [{ businessName: rx }, { phone: rx }, { products: rx }, { listedProducts: rx }, { "rates.service": rx }, { searchTags: rx }] });
    }

    const total = await SupplierProfile.countDocuments(filter);
    const sellers = await SupplierProfile.find(filter, {
      businessName: 1, phone: 1, profileType: 1, location: 1, categories: 1, searchTags: 1, active: 1,
      subscriptionStatus: 1, suspended: 1, products: 1, listedProducts: 1, rates: 1, classifiedAt: 1, tier: 1
    }).sort({ active: -1, classifiedAt: 1, businessName: 1 }).skip((page - 1) * PAGE).limit(PAGE).lean();
    const cities = (await SupplierProfile.distinct("location.city", { profileType: { $ne: "biker" } })).map(c => String(c || "").trim()).filter(Boolean);

    const catOpt = (sel) => `<option value="">All categories</option><option value="__none"${sel === "__none" ? " selected" : ""}>⚠️ No category</option><option value="__unknown"${sel === "__unknown" ? " selected" : ""}>⚠️ Unknown category id</option>` +
      cats.map(c => `<option value="${esc(c.id)}"${sel === c.id ? " selected" : ""}>${esc(c.label)}</option>`).join("");

    const rows = sellers.map(s => {
      const items = _items(s);
      const data = { id: String(s._id), name: s.businessName, type: s.profileType, categories: s.categories || [], tags: s.searchTags || [], items: items.slice(0, 25) };
      return `<tr id="r_${s._id}" ${focus ? 'class="zc-hl"' : ""}>
        <td><input type="checkbox" class="zcSel" value="${s._id}"></td>
        <td><b>${esc(s.businessName)}</b><div class="zc-muted">${esc(s.phone)} · ${esc(s.location?.area || "")}, ${esc(s.location?.city || "")}</div>
          <div>${_searchable(s) ? '<span class="zc-pill ok">in search</span>' : `<span class="zc-pill no">hidden: ${esc(!s.active ? "inactive" : s.suspended ? "suspended" : s.subscriptionStatus)}</span>`}
          ${items.length ? "" : '<span class="zc-pill no">nothing listed</span>'}</div></td>
        <td>${esc(s.profileType)}</td>
        <td class="zcCats">${(s.categories || []).map(c => `<span class="zc-chip ${known.has(c) ? "" : "bad"}">${esc(label(c))}</span>`).join("") || '<span class="zc-pill no">none</span>'}</td>
        <td class="zcTags">${(s.searchTags || []).map(t => `<span class="zc-chip tag">${esc(t)}</span>`).join("") || '<span class="zc-muted">-</span>'}</td>
        <td class="zc-muted" style="max-width:260px">${esc(items.slice(0, 6).join(", "))}${items.length > 6 ? ` +${items.length - 6}` : ""}</td>
        <td style="white-space:nowrap"><button class="zc-btn sm" onclick='zcOpen(${JSON.stringify(data).replace(/'/g, "&#39;")})'>Classify</button>
          <a class="zc-btn sm sec" href="/zq-admin/suppliers/${s._id}/edit">Profile</a></td>
      </tr>`;
    }).join("");

    const qs = (p) => "?" + new URLSearchParams({ q, city, cat, type, status, page: p }).toString();
    const pages = Math.ceil(total / PAGE);
    const pager = pages > 1 ? `<div class="zc-row" style="margin:10px 0">${Array.from({ length: pages }, (_, i) => i + 1).map(p =>
      p === page ? `<b>${p}</b>` : `<a href="/zq-admin/categorize${qs(p)}">${p}</a>`).join(" ")}</div>` : "";

    const catGrid = ["service", "product", "both"].map(t => {
      const list = cats.filter(c => c.active !== false && c.type === t);
      return list.length ? `<div style="margin:8px 0 4px;font-weight:600">${t === "service" ? "Services (hire)" : t === "product" ? "Products (buy)" : "Both"}</div>
        <div class="zc-grid">${list.map(c => `<label><input type="checkbox" class="dCat" value="${esc(c.id)}"> ${esc(c.label)}</label>`).join("")}</div>` : "";
    }).join("");

    res.send(layout("Categorize Sellers", `${CSS}<div class="zc-wrap">
      <h2>🏷️ Classify sellers</h2>
      <p class="zc-muted">Give each seller the right <b>categories</b> (as many as fit) and <b>search tags</b> - the exact words buyers type. Tagged sellers rank as strong matches for those words. Changes are live immediately.</p>
      <div class="zc-row" style="margin-bottom:10px">
        <a class="zc-btn sec" href="/zq-admin/categories">🗂️ Categories</a>
        <a class="zc-btn sec" href="/zq-admin/search-tester">🔎 Search tester</a>
        <form method="post" action="/zq-admin/categorize/fix-locations" onsubmit="return confirm('Trim spaces and fix capitals in every seller city/suburb?')"><button class="zc-btn sec">🧹 Fix city/suburb spelling</button></form>
        <button class="zc-btn sec" onclick="zcAiPage()" title="Claude suggests categories + tags for sellers on this page that have none; you still review">✨ Suggest for untagged on this page</button>
      </div>
      ${req.query.msg ? `<div class="zc-card" style="background:#ecfdf5">${esc(req.query.msg)}</div>` : ""}
      <form class="zc-card zc-row" method="get">
        <label>Search<input name="q" value="${esc(q)}" placeholder="name, phone, item, tag"></label>
        <label>City<select name="city"><option value="">All</option>${[...new Set(cities.map(_tc))].sort().map(c => `<option${c.toLowerCase() === city.toLowerCase() ? " selected" : ""}>${esc(c)}</option>`).join("")}</select></label>
        <label>Category<select name="cat">${catOpt(cat)}</select></label>
        <label>Type<select name="type"><option value="">All</option>${["product", "service", "tutor", "hospitality"].map(t => `<option${t === type ? " selected" : ""}>${t}</option>`).join("")}</select></label>
        <label>Show<select name="status"><option value="">All</option><option value="live"${status === "live" ? " selected" : ""}>In search</option><option value="hidden"${status === "hidden" ? " selected" : ""}>Hidden from search</option><option value="untagged"${status === "untagged" ? " selected" : ""}>No search tags</option></select></label>
        <button class="zc-btn">Filter</button> <span class="zc-muted">${total} sellers</span>
      </form>
      <div class="zc-card" style="padding:0;overflow:auto">
        <table class="zc-t"><tr><th><input type="checkbox" onclick="document.querySelectorAll('.zcSel').forEach(x=>x.checked=this.checked);zcBulkShow()"></th><th>Seller</th><th>Type</th><th>Categories</th><th>Search tags</th><th>Lists</th><th></th></tr>
        ${rows || '<tr><td colspan="7" class="zc-muted">No sellers match.</td></tr>'}</table>
      </div>
      ${pager}
      <div class="zc-bulk" id="zcBulk">
        <b id="zcN">0</b> selected ·
        <select id="bOp"><option value="addCat">Add category</option><option value="removeCat">Remove category</option><option value="addTags">Add tags</option><option value="removeTags">Remove tags</option><option value="setType">Set type</option></select>
        <select id="bCat">${cats.filter(c => c.active !== false).map(c => `<option value="${esc(c.id)}">${esc(c.label)}</option>`).join("")}</select>
        <input id="bText" placeholder="tags, comma separated" style="display:none">
        <select id="bType" style="display:none"><option>service</option><option>product</option></select>
        <button class="zc-btn" onclick="zcBulk()">Apply</button>
      </div>
    </div>

    <dialog class="zc" id="dlg">
      <div class="hd" id="dTitle">Classify</div>
      <div class="bd">
        <div class="zc-muted" id="dItems"></div>
        <div class="zc-row" style="margin:10px 0">
          <label>Type<select id="dType"><option value="service">service (hire)</option><option value="product">product (buy)</option><option value="tutor">tutor</option><option value="hospitality">hospitality</option></select></label>
          <button class="zc-btn sec" id="dAi" onclick="zcAi()">✨ Suggest with Claude</button>
          <span class="zc-muted" id="dAiMsg"></span>
        </div>
        <label style="display:block;font-size:12px;color:#555">Search tags - words buyers type (comma separated)
          <textarea id="dTags" rows="2" style="width:100%" placeholder="electrician, wiring, db board, fault finding"></textarea></label>
        <div id="dCats">${catGrid}</div>
      </div>
      <div class="ft"><button class="zc-btn sec" onclick="dlg.close()">Cancel</button><button class="zc-btn" onclick="zcSave()">Save</button></div>
    </dialog>

    <script>
    let cur = null;
    const esc = s => String(s||'').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
    const LABELS = ${JSON.stringify(Object.fromEntries(cats.map(c => [c.id, c.label])))};
    function zcOpen(d){
      cur = d; dTitle.textContent = d.name; dItems.textContent = d.items.length ? 'Lists: ' + d.items.join(', ') : 'Lists nothing yet.';
      dType.value = ['product','service','tutor','hospitality'].includes(d.type) ? d.type : 'product';
      dTags.value = (d.tags||[]).join(', '); dAiMsg.textContent = '';
      document.querySelectorAll('.dCat').forEach(x => x.checked = (d.categories||[]).includes(x.value));
      dlg.showModal();
    }
    async function zcSave(){
      const body = { id: cur.id, profileType: dType.value, searchTags: dTags.value,
        categories: [...document.querySelectorAll('.dCat:checked')].map(x => x.value) };
      const r = await fetch('/zq-admin/categorize/save', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
      const j = await r.json(); if (!j.ok) return alert(j.error || 'Save failed');
      const row = document.getElementById('r_'+cur.id);
      row.querySelector('.zcCats').innerHTML = j.categories.map(c => '<span class="zc-chip">'+esc(LABELS[c]||c)+'</span>').join('') || '<span class="zc-pill no">none</span>';
      row.querySelector('.zcTags').innerHTML = j.searchTags.map(t => '<span class="zc-chip tag">'+esc(t)+'</span>').join('') || '-';
      row.children[2].textContent = j.profileType; row.classList.add('zc-hl'); dlg.close();
    }
    async function zcAi(){
      dAi.disabled = true; dAiMsg.textContent = 'Asking Claude…';
      const r = await fetch('/zq-admin/categorize/ai', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ id: cur.id }) });
      const j = await r.json(); dAi.disabled = false;
      if (!j.ok) { dAiMsg.textContent = j.error || 'No suggestion'; return; }
      const s = j.suggestion;
      document.querySelectorAll('.dCat').forEach(x => { if (s.categories.includes(x.value)) x.checked = true; });
      const have = dTags.value.split(',').map(x=>x.trim()).filter(Boolean);
      dTags.value = [...new Set([...have, ...s.tags])].join(', ');
      if (s.profileType) dType.value = s.profileType;
      dAiMsg.textContent = 'Suggested - review, then Save. ' + (s.reason||'');
    }
    async function zcAiPage(){
      if (!confirm('Ask Claude to suggest categories + tags for every seller on this page that has no tags, and SAVE them? You can still edit each one after.')) return;
      const r = await fetch('/zq-admin/categorize/ai-batch', { method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ ids: [...document.querySelectorAll('.zcSel')].map(x => x.value) }) });
      const j = await r.json(); alert(j.ok ? ('Updated '+j.updated+' sellers' + (j.skipped ? ', skipped '+j.skipped : '')) : (j.error||'Failed')); location.reload();
    }
    function zcBulkShow(){ const n = document.querySelectorAll('.zcSel:checked').length; zcN.textContent = n; zcBulk.style.display = n ? 'flex' : 'none'; }
    document.addEventListener('change', e => { if (e.target.classList.contains('zcSel')) zcBulkShow();
      if (e.target.id === 'bOp') { const v = bOp.value; bCat.style.display = /Cat/.test(v)?'':'none'; bText.style.display = /Tags/.test(v)?'':'none'; bType.style.display = v==='setType'?'':'none'; } });
    async function zcBulk(){
      const ids = [...document.querySelectorAll('.zcSel:checked')].map(x => x.value);
      const v = bOp.value, value = /Cat/.test(v) ? bCat.value : /Tags/.test(v) ? bText.value : bType.value;
      const r = await fetch('/zq-admin/categorize/bulk', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ ids, op: v, value }) });
      const j = await r.json(); if (!j.ok) return alert(j.error||'Failed'); location.reload();
    }
    </script>`));
  });

  router.post("/categorize/save", requireSupplierAdmin, async (req, res) => {
    try {
      const b = req.body || {};
      const cats = await getAllCategories();
      const known = new Set(cats.map(c => c.id));
      const categories = [...new Set((Array.isArray(b.categories) ? b.categories : _csv(b.categories)).filter(c => known.has(c)))];
      const searchTags = [...new Set(_csv(b.searchTags).map(t => t.toLowerCase().slice(0, 40)))].slice(0, 30);
      const set = { categories, searchTags, classifiedAt: new Date(), classifiedBy: _who(req) };
      if (["product", "service", "tutor", "hospitality"].includes(b.profileType)) set.profileType = b.profileType;
      await SupplierProfile.updateOne({ _id: b.id }, { $set: set });
      res.json({ ok: true, categories, searchTags, profileType: set.profileType || "" });
    } catch (e) { res.json({ ok: false, error: e.message }); }
  });

  router.post("/categorize/bulk", requireSupplierAdmin, async (req, res) => {
    try {
      const { ids = [], op, value } = req.body || {};
      if (!Array.isArray(ids) || !ids.length) return res.json({ ok: false, error: "Select sellers first." });
      const f = { _id: { $in: ids } };
      const stamp = { classifiedAt: new Date(), classifiedBy: _who(req) };
      const tags = _csv(value).map(t => t.toLowerCase().slice(0, 40));
      let r;
      if (op === "addCat")          r = await SupplierProfile.updateMany(f, { $addToSet: { categories: value }, $set: stamp });
      else if (op === "removeCat")  r = await SupplierProfile.updateMany(f, { $pull: { categories: value }, $set: stamp });
      else if (op === "addTags")    r = await SupplierProfile.updateMany(f, { $addToSet: { searchTags: { $each: tags } }, $set: stamp });
      else if (op === "removeTags") r = await SupplierProfile.updateMany(f, { $pull: { searchTags: { $in: tags } }, $set: stamp });
      else if (op === "setType" && ["product", "service"].includes(value)) r = await SupplierProfile.updateMany(f, { $set: { profileType: value, ...stamp } });
      else return res.json({ ok: false, error: "Unknown action" });
      res.json({ ok: true, modified: r.modifiedCount ?? r.nModified ?? 0 });
    } catch (e) { res.json({ ok: false, error: e.message }); }
  });

  router.post("/categorize/ai", requireSupplierAdmin, async (req, res) => {
    try {
      const { aiClassifySeller, aiEnabled } = await import("../services/searchBrain.js");
      if (!aiEnabled()) return res.json({ ok: false, error: "Add ANTHROPIC_API_KEY to .env to use suggestions." });
      const s = await SupplierProfile.findById(req.body.id).lean();
      if (!s) return res.json({ ok: false, error: "Seller not found" });
      const suggestion = await aiClassifySeller(s);
      if (!suggestion) return res.json({ ok: false, error: "No suggestion (timeout or daily cap) - try again." });
      res.json({ ok: true, suggestion });
    } catch (e) { res.json({ ok: false, error: e.message }); }
  });

  // Suggest + save for sellers that have NO tags yet (never overwrites admin work)
  router.post("/categorize/ai-batch", requireSupplierAdmin, async (req, res) => {
    try {
      const { aiClassifySeller, aiEnabled } = await import("../services/searchBrain.js");
      if (!aiEnabled()) return res.json({ ok: false, error: "Add ANTHROPIC_API_KEY to .env to use suggestions." });
      const ids = (req.body.ids || []).slice(0, PAGE);
      const sellers = await SupplierProfile.find({ _id: { $in: ids }, $or: [{ searchTags: { $exists: false } }, { searchTags: { $size: 0 } }] }).lean();
      let updated = 0, skipped = 0;
      for (const s of sellers) {
        const sug = await aiClassifySeller(s);
        if (!sug) { skipped++; continue; }
        const categories = [...new Set([...(s.categories || []), ...sug.categories])];
        await SupplierProfile.updateOne({ _id: s._id }, { $set: {
          categories, searchTags: sug.tags, classifiedAt: new Date(), classifiedBy: _who(req) + " (AI)"
        } });
        updated++;
      }
      res.json({ ok: true, updated, skipped });
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
      const cats = await getAllCategories();
      const label = id => cats.find(c => c.id === id)?.label || id;
      const intent = await SB.getSearchIntent(q, { knownToSynonyms: S.expandSearchTerms(q).length > 1 });
      const _log = console.log; console.log = () => {};
      let offers = [];
      // Same parsing as WhatsApp: "plumber borrowdale" → product + city
      const parsed = S.parseShortcodeSearch(q) || { product: q, city: null };
      const useCity = city ? _tc(city) : (parsed.city || null);
      try { offers = await S.runSupplierOfferSearch({ city: useCity, product: String(parsed.product || q).toLowerCase() }); }
      finally { console.log = _log; }
      const order = []; for (const o of offers) if (!order.includes(o.supplierId)) order.push(o.supplierId);
      const sellers = await SupplierProfile.find({ _id: { $in: order } }).lean();
      body = `<div class="zc-card">
        <div><b>Understood as:</b> ${intent ? `${esc(intent.kind || "")} · ${esc(intent.profileType || "any type")} · ${(intent.categories || []).map(c => `<span class="zc-chip">${esc(label(c))}</span>`).join("")} <span class="zc-muted">(${esc(intent.source)})</span>` : '<span class="zc-muted">no rule matched - Claude is used if enabled</span>'}</div>
        <div class="zc-muted">Synonyms: ${esc(S.expandSearchTerms(q.toLowerCase()).join(", "))}</div>
        ${offers[0]?._aiRewrite ? `<div>✨ Claude rewrote the search to <b>${esc(offers[0]._aiRewrite)}</b></div>` : ""}
      </div>
      <div class="zc-card" style="padding:0;overflow:auto"><table class="zc-t">
        <tr><th>#</th><th>Seller</th><th>Type</th><th>City</th><th>Categories</th><th>Tags</th><th>Shown item</th><th>Item score</th><th>Tag score</th><th>Intent bonus</th><th></th></tr>
        ${order.map((id, i) => {
          const s = sellers.find(x => String(x._id) === id) || {};
          const os = offers.filter(o => o.supplierId === id);
          const best = Math.max(...os.map(o => o.matchScore || 0));
          return `<tr><td>${i + 1}</td><td><b>${esc(s.businessName)}</b></td><td>${esc(s.profileType)}</td>
            <td>${esc(s.location?.city)}${os[0]?._nonLocal ? ' <span class="zc-pill">other city</span>' : ""}</td>
            <td>${(s.categories || []).map(c => `<span class="zc-chip">${esc(label(c))}</span>`).join("")}</td>
            <td>${(s.searchTags || []).map(t => `<span class="zc-chip tag">${esc(t)}</span>`).join("")}</td>
            <td>${esc(os[0]?.product)}</td><td>${best}</td><td>${S.tagScore(s, q)}</td><td>${SB.intentBonus(s, intent)}</td>
            <td><a class="zc-btn sm sec" href="/zq-admin/categorize?focus=${id}">Fix</a></td></tr>`;
        }).join("") || '<tr><td colspan="11">Nothing found. Tag the right sellers with this word on the Classify page.</td></tr>'}
      </table></div>`;
    }
    res.send(layout("Search Tester", `${CSS}<div class="zc-wrap">
      <h2>🔎 Search tester</h2>
      <p class="zc-muted">Runs the real WhatsApp search. Use it after classifying to check who a buyer would see, in order.</p>
      <form class="zc-card zc-row" method="get">
        <label>Buyer types<input name="q" value="${esc(q)}" placeholder="electrician" style="width:260px" autofocus></label>
        <label>City<input name="city" value="${esc(city)}" placeholder="Harare (blank = all)"></label>
        <button class="zc-btn">Search</button>
        <a class="zc-btn sec" href="/zq-admin/categorize">🏷️ Classify sellers</a>
      </form>${body}</div>`));
  });
}
