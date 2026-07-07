/**
 * routes/supplierStockAdmin.js
 * ─────────────────────────────────────────────────────────────────────────────
 * WHERE TO PUT THIS FILE:  routes/supplierStockAdmin.js
 * MOUNT (in supplierAdmin.js, next to the finance mount):
 *     import stockAdminRoutes from "./supplierStockAdmin.js";
 *     router.use("/suppliers/:id/stock", stockAdminRoutes);
 *
 * The web-admin counterpart of the WhatsApp Stock Control feature. Everything
 * here reads/writes the SAME StockItem / StockMovement / StockSettings models
 * and the SAME stockService, so the phone and the panel are always in sync.
 *
 * WHAT AN ADMIN CAN DO HERE:
 *   • Turn stock tracking on/off for the business
 *   • Add / edit tracked products (name, unit, cost, sell, reorder, aliases)
 *   • Record stock IN (purchase), ADJUST (+/-), SET exact count, WASTAGE
 *   • REVERSE any manual movement (soft, keeps the audit trail)
 *   • Read a DAILY running-balance ledger per item (opening→moves→closing)
 *   • Read a Stock & Sales decision report (sold, COGS, gross margin, money
 *     received vs receivable, stock value, low-stock alerts) + PDF
 *
 * Sales themselves are never edited here - they're derived from real invoices/
 * receipts, so a wrong sale is fixed in Financial Records, not here.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import express from "express";
import { requireSupplierAdmin } from "../middleware/supplierAdminAuth.js";
import SupplierProfile from "../models/supplierProfile.js";
import { layout, esc } from "./supplierAdmin.js";

const router = express.Router({ mergeParams: true });
router.use(express.json());
router.use(express.urlencoded({ extended: true }));

// ── Shared helpers (mirrors supplierFinancialAdmin.js) ───────────────────────
async function loadBizContext(req) {
  const supplier = await SupplierProfile.findById(req.params.id).lean();
  if (!supplier || !supplier.businessId) return { supplier, biz: null };
  const Business = (await import("../models/business.js")).default;
  const biz = await Business.findById(supplier.businessId).lean();
  return { supplier, biz };
}
async function listBranches(businessId) {
  const Branch = (await import("../models/branch.js")).default;
  return Branch.find({ businessId }).sort({ isDefault: -1, name: 1 }).lean();
}
function branchName(branches, id) {
  if (!id) return "Whole business";
  const b = branches.find(x => String(x._id) === String(id));
  return b ? b.name : "-";
}
function branchOptions(branches, selectedId) {
  return [`<option value="">- Whole business (no specific branch) -</option>`]
    .concat(branches.map(b =>
      `<option value="${b._id}" ${String(b._id) === String(selectedId) ? "selected" : ""}>${esc(b.name)}</option>`
    )).join("");
}
const fs = `width:100%;padding:9px 12px;border:1px solid var(--border);border-radius:7px;font-size:14px`;
function field(label, inputHtml) {
  return `<div style="margin-bottom:14px">
    <label style="font-weight:600;display:block;margin-bottom:6px;font-size:13px">${label}</label>${inputHtml}</div>`;
}
function alertBlock(req) {
  const err = req.query.error   ? `<div class="alert red">❌ ${esc(req.query.error)}</div>`   : "";
  const ok  = req.query.success ? `<div class="alert green">✅ ${esc(req.query.success)}</div>` : "";
  return err + ok;
}
const money = (n, cur = "USD") => `${cur === "ZWL" ? "Z$" : cur === "ZAR" ? "R" : "$"}${Number(n || 0).toFixed(2)}`;
const qtyFmt = n => { const v = Number(n || 0); return Number.isInteger(v) ? String(v) : v.toFixed(2); };
const stockUrl = (id, path = "") => `/zq-admin/suppliers/${id}/stock${path}`;
const dt = d => new Date(d).toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });

function periodFromQuery(req) {
  // ?period=YYYY-MM  or ?from=&to=  or default = current month
  const now = new Date();
  if (req.query.from && req.query.to) {
    const start = new Date(req.query.from); start.setHours(0, 0, 0, 0);
    const end   = new Date(req.query.to);   end.setHours(23, 59, 59, 999);
    return { start, end, label: `${req.query.from} → ${req.query.to}` };
  }
  if (req.query.period === "all") {
    return { start: new Date(2020, 0, 1), end: new Date(now.getFullYear(), now.getMonth() + 2, 0, 23, 59, 59, 999), label: "All time" };
  }
  let y = now.getFullYear(), m = now.getMonth();
  if (req.query.period && /^\d{4}-\d{2}$/.test(req.query.period)) {
    const [yy, mm] = req.query.period.split("-").map(Number); y = yy; m = mm - 1;
  }
  return {
    start: new Date(y, m, 1, 0, 0, 0, 0),
    end:   new Date(y, m + 1, 0, 23, 59, 59, 999),
    label: new Date(y, m, 1).toLocaleDateString("en-GB", { month: "long", year: "numeric" })
  };
}
function periodPicker(id, basePath, cur) {
  const now = new Date();
  const opts = [];
  for (let i = 0; i < 6; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const val = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    const sel = val === cur ? "selected" : "";
    opts.push(`<option value="${val}" ${sel}>${d.toLocaleDateString("en-GB", { month: "long", year: "numeric" })}</option>`);
  }
  opts.push(`<option value="all" ${cur === "all" ? "selected" : ""}>All time</option>`);
  return `<form method="GET" action="${stockUrl(id, basePath)}" style="display:inline">
    <select name="period" style="${fs};width:auto;display:inline-block" onchange="this.form.submit()">${opts.join("")}</select>
  </form>`;
}

// ═══════════════════════════════════════════════════════════════════════════
// DASHBOARD  - GET /suppliers/:id/stock
// ═══════════════════════════════════════════════════════════════════════════
router.get("/", requireSupplierAdmin, async (req, res) => {
  try {
    const { supplier, biz } = await loadBizContext(req);
    if (!biz) return res.redirect(`/zq-admin/suppliers/${req.params.id}`);
    const cur = biz.currency || "USD";
    const svc = await import("../services/stockService.js");
    const enabled = await svc.isStockEnabled(biz._id);
    const branches = await listBranches(biz._id);

    if (!enabled) {
      return res.send(layout("Stock Control", `
        <a href="/zq-admin/suppliers/${supplier._id}" class="back-link">← Back to profile</a>
        <h2 style="margin:12px 0 6px">📦 Stock Control - ${esc(supplier.businessName)}</h2>
        ${alertBlock(req)}
        <div class="card" style="max-width:560px">
          <p style="color:var(--muted);font-size:14px;margin-bottom:16px">
            Stock tracking is <b>off</b> for this business. Turn it on to track quantities for chosen
            products, have sales reduce stock automatically, and get stock &amp; sales reports with
            daily opening/closing balances.
          </p>
          <form method="POST" action="${stockUrl(supplier._id, "/enable")}">
            <button class="btn btn-blue">✅ Enable Stock Tracking</button>
          </form>
        </div>`));
    }

    // Recompute + list items grouped by branch
    const items = await svc.listStockItems(biz._id, null, true);
    for (const it of items) { try { const r = await svc.recomputeItemQty(it._id); if (r) it.currentQty = r.currentQty; } catch (_) {} }

    let totalValue = 0, lowCount = 0;
    const rows = items.map(it => {
      const val = (it.currentQty || 0) * (it.costPrice || 0);
      totalValue += val;
      const low = it.reorderLevel > 0 && it.currentQty <= it.reorderLevel;
      if (low) lowCount++;
      return `<tr class="${low ? "" : ""}" style="${low ? "background:#fef2f2" : ""}">
        <td><a href="${stockUrl(supplier._id, `/item/${it._id}`)}" style="font-weight:600;color:var(--blue);text-decoration:none">${esc(it.name)}</a>
            ${it.sku ? `<span style="color:var(--muted);font-size:11px"> (${esc(it.sku)})</span>` : ""}</td>
        <td>${esc(branchName(branches, it.branchId))}</td>
        <td style="text-align:right;font-weight:700">${qtyFmt(it.currentQty)} <span style="color:var(--muted);font-weight:400">${esc(it.unit)}</span>${low ? ' <span style="color:#dc2626">⚠</span>' : ""}</td>
        <td style="text-align:right">${money(it.costPrice, cur)}</td>
        <td style="text-align:right">${money(it.sellPrice, cur)}</td>
        <td style="text-align:right">${money(val, cur)}</td>
        <td>
          <a class="btn" style="padding:4px 10px;font-size:12px" href="${stockUrl(supplier._id, `/item/${it._id}`)}">Manage</a>
        </td>
      </tr>`;
    }).join("");

    res.send(layout("Stock Control", `
      <a href="/zq-admin/suppliers/${supplier._id}" class="back-link">← Back to profile</a>
      <h2 style="margin:12px 0 6px">📦 Stock Control - ${esc(supplier.businessName)}</h2>
      ${alertBlock(req)}

      <div style="display:flex;gap:12px;flex-wrap:wrap;margin:14px 0">
        <div class="card" style="flex:1;min-width:150px"><div style="font-size:12px;color:var(--muted)">Tracked products</div><div style="font-size:22px;font-weight:700">${items.length}</div></div>
        <div class="card" style="flex:1;min-width:150px"><div style="font-size:12px;color:var(--muted)">Stock value (cost)</div><div style="font-size:22px;font-weight:700">${money(totalValue, cur)}</div></div>
        <div class="card" style="flex:1;min-width:150px"><div style="font-size:12px;color:var(--muted)">Low-stock items</div><div style="font-size:22px;font-weight:700;color:${lowCount ? "#dc2626" : "#16a34a"}">${lowCount}</div></div>
      </div>

      <div style="margin:14px 0;display:flex;gap:10px;flex-wrap:wrap">
        <a class="btn btn-blue" href="${stockUrl(supplier._id, "/item/new")}">➕ Track a Product</a>
        <a class="btn" style="background:#0369a1;color:#fff" href="${stockUrl(supplier._id, "/report")}">📈 Stock &amp; Sales Report</a>
        <form method="POST" action="${stockUrl(supplier._id, "/disable")}" style="display:inline"
              onsubmit="return confirm('Turn stock tracking OFF? Your products and history are kept.')">
          <button class="btn" style="background:#64748b;color:#fff">Turn Off</button>
        </form>
      </div>

      <div class="card">
        <table class="data-table">
          <thead><tr><th>Product</th><th>Branch</th><th style="text-align:right">On hand</th><th style="text-align:right">Cost</th><th style="text-align:right">Sell</th><th style="text-align:right">Value</th><th></th></tr></thead>
          <tbody>${rows || `<tr><td colspan="7" style="text-align:center;color:var(--muted);padding:20px">No tracked products yet - tap “Track a Product”.</td></tr>`}</tbody>
        </table>
      </div>`));
  } catch (e) {
    res.send(layout("Error", `<div class="alert red">${esc(e.message)}<pre style="font-size:11px">${esc(e.stack || "")}</pre></div>`));
  }
});

router.post("/enable", requireSupplierAdmin, async (req, res) => {
  try {
    const { supplier, biz } = await loadBizContext(req);
    const svc = await import("../services/stockService.js");
    await svc.enableStock(biz._id, "admin");
    res.redirect(stockUrl(supplier._id, "?success=Stock+tracking+enabled"));
  } catch (e) { res.redirect(stockUrl(req.params.id, `?error=${encodeURIComponent(e.message)}`)); }
});

router.post("/disable", requireSupplierAdmin, async (req, res) => {
  try {
    const { supplier, biz } = await loadBizContext(req);
    const svc = await import("../services/stockService.js");
    await svc.disableStock(biz._id);
    res.redirect(stockUrl(supplier._id, "?success=Stock+tracking+turned+off"));
  } catch (e) { res.redirect(stockUrl(req.params.id, `?error=${encodeURIComponent(e.message)}`)); }
});

// ═══════════════════════════════════════════════════════════════════════════
// NEW / ADD ITEM
// ═══════════════════════════════════════════════════════════════════════════
router.get("/item/new", requireSupplierAdmin, async (req, res) => {
  try {
    const { supplier, biz } = await loadBizContext(req);
    const branches = await listBranches(biz._id);
    // Existing catalogue products not yet tracked - the owner PICKS one instead
    // of typing, so the tracked name matches invoices exactly (reliable matching).
    const svc = await import("../services/stockService.js");
    let catalogue = [];
    try { catalogue = await svc.getTrackableCatalogue({ businessId: biz._id }); } catch (_) {}
    const catOptions = [`<option value="">- pick a product from your catalogue -</option>`]
      .concat(catalogue.map(name => `<option value="${esc(name)}">${esc(name)}</option>`))
      .concat([`<option value="__other__">+ Other (type a new name below)</option>`])
      .join("");
    res.send(layout("Track a Product", `
      <a href="${stockUrl(supplier._id)}" class="back-link">← Back to stock</a>
      <h2 style="margin:12px 0 16px">➕ Track a Product</h2>
      ${alertBlock(req)}
      <div class="card" style="max-width:560px">
        <form method="POST" action="${stockUrl(supplier._id, "/item/add")}">
          ${field("Pick a product *", `<select name="pickName" style="${fs}">${catOptions}</select>`)}
          ${field("...or type a new product name", `<input name="customName" placeholder="only used if you picked \u201cOther\u201d above" style="${fs}">`)}
          ${field("Branch", `<select name="branchId" style="${fs}">${branchOptions(branches, "")}</select>`)}
          <div style="display:flex;gap:12px">
            <div style="flex:1">${field("Unit", `<input name="unit" value="each" style="${fs}">`)}</div>
            <div style="flex:1">${field("SKU (optional)", `<input name="sku" style="${fs}">`)}</div>
          </div>
          <div style="display:flex;gap:12px">
            <div style="flex:1">${field("Opening qty", `<input name="openingQty" type="number" step="0.01" value="0" style="${fs}">`)}</div>
            <div style="flex:1">${field("Reorder level", `<input name="reorderLevel" type="number" step="0.01" value="0" style="${fs}">`)}</div>
          </div>
          <div style="display:flex;gap:12px">
            <div style="flex:1">${field("Cost price", `<input name="costPrice" type="number" step="0.01" value="0" style="${fs}">`)}</div>
            <div style="flex:1">${field("Sell price", `<input name="sellPrice" type="number" step="0.01" value="0" style="${fs}">`)}</div>
          </div>
          ${field("Also matches (aliases, comma-separated)", `<input name="aliases" placeholder="coke, coca cola" style="${fs}">`)}
          <p style="font-size:12px;color:var(--muted);margin:-6px 0 14px">Aliases help sales lines like “2x coke” reduce this product automatically.</p>
          <button class="btn btn-blue" style="width:100%">Save Product</button>
        </form>
      </div>`));
  } catch (e) { res.send(layout("Error", `<div class="alert red">${esc(e.message)}</div>`)); }
});

router.post("/item/add", requireSupplierAdmin, async (req, res) => {
  try {
    const { supplier, biz } = await loadBizContext(req);
    const svc = await import("../services/stockService.js");
    const b = req.body;
    // Name comes from the catalogue picker; "Other" (or a blank pick) uses the typed name.
    const pickedName = (b.pickName && b.pickName !== "__other__") ? b.pickName : (b.customName || b.name || "");
    b.name = String(pickedName).trim();
    if (!b.name) return res.redirect(stockUrl(supplier._id, "/item/new?error=Pick+a+product+or+type+a+name"));
    await svc.createStockItem({
      businessId: biz._id, branchId: b.branchId || null,
      name: b.name.trim(), unit: b.unit || "each", sku: b.sku || "",
      costPrice: parseFloat(b.costPrice) || 0, sellPrice: parseFloat(b.sellPrice) || 0,
      openingQty: parseFloat(b.openingQty) || 0, reorderLevel: parseFloat(b.reorderLevel) || 0,
      aliases: (b.aliases || "").split(",").map(s => s.trim()).filter(Boolean),
      currency: biz.currency, createdBy: "admin"
    });
    res.redirect(stockUrl(supplier._id, "?success=Product+added"));
  } catch (e) { res.redirect(stockUrl(req.params.id, `/item/new?error=${encodeURIComponent(e.message)}`)); }
});

// ═══════════════════════════════════════════════════════════════════════════
// ITEM DETAIL  - forms + movement history + daily running-balance ledger
// ═══════════════════════════════════════════════════════════════════════════
router.get("/item/:itemId", requireSupplierAdmin, async (req, res) => {
  try {
    const { supplier, biz } = await loadBizContext(req);
    const cur = biz.currency || "USD";
    const svc = await import("../services/stockService.js");
    const item = await svc.getStockItem(req.params.itemId);
    if (!item) return res.redirect(stockUrl(supplier._id, "?error=Product+not+found"));
    const live = await svc.recomputeItemQty(item._id);
    const onHand = live ? live.currentQty : item.currentQty;

    const p = periodFromQuery(req);
    const ledger = await svc.buildStockLedger({ biz, stockItemId: item._id, start: p.start, end: p.end });
    const moves  = await svc.listMovements(item._id, 100);

    // Daily ledger table
    let ledgerHtml = "";
    if (ledger && ledger.days.length) {
      for (const day of ledger.days) {
        ledgerHtml += `<tr style="background:#1e3a5f;color:#e0f2fe"><td colspan="6" style="font-weight:600">📅 ${esc(day.dayKey)} - opened ${qtyFmt(day.opening)} ${esc(item.unit)}</td></tr>`;
        for (const r of day.rows) {
          const sign = r.qty > 0 ? "green" : "red";
          const label = r.type === "sale" ? `Sale - ${esc(r.note)}` :
                        r.type === "purchase" ? "Stock in" :
                        r.type === "wastage" ? "Wastage/loss" :
                        r.type === "return" ? "Return in" : "Adjustment";
          ledgerHtml += `<tr>
            <td style="color:var(--muted)">${dt(r.at)}</td>
            <td>${label}</td>
            <td style="text-align:right" class="${sign}">${r.qty > 0 ? "+" : ""}${qtyFmt(r.qty)}</td>
            <td style="text-align:right;font-weight:600">${qtyFmt(r.runningQty)}</td>
            <td style="text-align:right">${r.value ? money(r.value, cur) : ""}</td>
            <td>${r.type === "sale" ? (r.received ? '<span style="color:#16a34a">received</span>' : '<span style="color:#b45309">owed</span>') : ""}</td>
          </tr>`;
        }
        ledgerHtml += `<tr style="background:#dbeafe;color:#1e40af"><td colspan="3" style="font-weight:600">End of ${esc(day.dayKey.split(",")[0])} - sold ${qtyFmt(day.soldQty)}, in ${qtyFmt(day.inQty)}</td><td style="text-align:right;font-weight:700">${qtyFmt(day.closing)}</td><td style="text-align:right">${money(day.salesValue, cur)}</td><td></td></tr>`;
      }
    } else {
      ledgerHtml = `<tr><td colspan="6" style="text-align:center;color:var(--muted);padding:18px">No movement in ${esc(p.label)}</td></tr>`;
    }

    // Movement history (reversible)
    const histHtml = moves.length ? moves.map(m => `
      <tr style="${m.reversed ? "opacity:.5;text-decoration:line-through" : ""}">
        <td style="color:var(--muted)">${dt(m.date)}</td>
        <td>${esc(m.type)}</td>
        <td style="text-align:right" class="${m.qty > 0 ? "green" : "red"}">${m.qty > 0 ? "+" : ""}${qtyFmt(m.qty)}</td>
        <td>${esc(m.reason || "")}</td>
        <td>${m.reversed ? "reversed" : `<form method="POST" action="${stockUrl(supplier._id, `/movement/${m._id}/reverse`)}" style="margin:0" onsubmit="return confirm('Reverse this movement?')"><button class="btn" style="padding:3px 9px;font-size:11px;background:#dc2626;color:#fff">↩ Reverse</button></form>`}</td>
      </tr>`).join("") : `<tr><td colspan="5" style="text-align:center;color:var(--muted);padding:14px">No manual movements yet</td></tr>`;

    const low = item.reorderLevel > 0 && onHand <= item.reorderLevel;

    res.send(layout(`Stock - ${esc(item.name)}`, `
      <a href="${stockUrl(supplier._id)}" class="back-link">← Back to stock</a>
      <h2 style="margin:12px 0 4px">${esc(item.name)} ${low ? '<span style="color:#dc2626;font-size:14px">⚠ LOW</span>' : ""}</h2>
      <p style="color:var(--muted);margin-bottom:14px">${esc(branchName(await listBranches(biz._id), item.branchId))} · on hand <b>${qtyFmt(onHand)} ${esc(item.unit)}</b> · cost ${money(item.costPrice, cur)} · sell ${money(item.sellPrice, cur)}${item.aliases?.length ? ` · matches: ${esc(item.aliases.join(", "))}` : ""}</p>
      ${alertBlock(req)}

      <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:18px">
        <details class="card" style="flex:1;min-width:220px">
          <summary style="font-weight:600;cursor:pointer">📥 Stock In</summary>
          <form method="POST" action="${stockUrl(supplier._id, `/item/${item._id}/stock-in`)}" style="margin-top:10px">
            ${field("Quantity received", `<input name="qty" type="number" step="0.01" min="0" required style="${fs}">`)}
            ${field("Unit cost (optional)", `<input name="unitCost" type="number" step="0.01" style="${fs}">`)}
            ${field("Note", `<input name="reason" placeholder="e.g. Restock from supplier" style="${fs}">`)}
            <button class="btn btn-blue" style="width:100%">Add to stock</button>
          </form>
        </details>
        <details class="card" style="flex:1;min-width:220px">
          <summary style="font-weight:600;cursor:pointer">🔧 Adjust / Wastage</summary>
          <form method="POST" action="${stockUrl(supplier._id, `/item/${item._id}/adjust`)}" style="margin-top:10px">
            ${field("Change (+ / −)", `<input name="delta" type="number" step="0.01" placeholder="-3 for loss, +5 to add" required style="${fs}">`)}
            ${field("Reason", `<input name="reason" placeholder="breakage, expiry, count fix…" style="${fs}">`)}
            <button class="btn" style="width:100%;background:#b45309;color:#fff">Apply adjustment</button>
          </form>
        </details>
        <details class="card" style="flex:1;min-width:220px">
          <summary style="font-weight:600;cursor:pointer">🎯 Set exact count</summary>
          <form method="POST" action="${stockUrl(supplier._id, `/item/${item._id}/set`)}" style="margin-top:10px">
            ${field("Counted stock on hand", `<input name="count" type="number" step="0.01" min="0" required style="${fs}">`)}
            ${field("Note", `<input name="reason" value="Stock count" style="${fs}">`)}
            <button class="btn" style="width:100%;background:#0d9488;color:#fff">Set count</button>
          </form>
        </details>
      </div>

      <details class="card" style="margin-bottom:18px">
        <summary style="font-weight:600;cursor:pointer">✏️ Edit product details</summary>
        <form method="POST" action="${stockUrl(supplier._id, `/item/${item._id}/edit`)}" style="margin-top:12px;max-width:520px">
          ${field("Name", `<input name="name" value="${esc(item.name)}" style="${fs}">`)}
          <div style="display:flex;gap:12px">
            <div style="flex:1">${field("Unit", `<input name="unit" value="${esc(item.unit)}" style="${fs}">`)}</div>
            <div style="flex:1">${field("Reorder level", `<input name="reorderLevel" type="number" step="0.01" value="${item.reorderLevel}" style="${fs}">`)}</div>
          </div>
          <div style="display:flex;gap:12px">
            <div style="flex:1">${field("Cost price", `<input name="costPrice" type="number" step="0.01" value="${item.costPrice}" style="${fs}">`)}</div>
            <div style="flex:1">${field("Sell price", `<input name="sellPrice" type="number" step="0.01" value="${item.sellPrice}" style="${fs}">`)}</div>
          </div>
          ${field("Aliases", `<input name="aliases" value="${esc((item.aliases || []).join(", "))}" style="${fs}">`)}
          <button class="btn btn-blue">Save changes</button>
          <button formaction="${stockUrl(supplier._id, `/item/${item._id}/delete`)}" class="btn" style="background:#dc2626;color:#fff;margin-left:8px" onclick="return confirm('Stop tracking this product? History is kept.')">Stop tracking</button>
        </form>
      </details>

      <h3 style="margin:8px 0 10px">📊 Daily stock ledger &nbsp; ${periodPicker(supplier._id, `/item/${item._id}`, req.query.period || `${p.start.getFullYear()}-${String(p.start.getMonth() + 1).padStart(2, "0")}`)}</h3>
      <div class="card" style="margin-bottom:8px;display:flex;gap:16px;flex-wrap:wrap;font-size:13px">
        <span>Opening: <b>${qtyFmt(ledger?.opening || 0)}</b></span>
        <span>In: <b class="green">+${qtyFmt(ledger?.totals.inQty || 0)}</b></span>
        <span>Sold: <b class="red">−${qtyFmt(ledger?.totals.soldQty || 0)}</b></span>
        <span>Adj: <b>${qtyFmt(ledger?.totals.adjQty || 0)}</b></span>
        <span>Closing: <b>${qtyFmt(ledger?.closing || 0)}</b></span>
        <span style="margin-left:auto">Sales: <b>${money(ledger?.totals.salesValue || 0, cur)}</b> · Received <b class="green">${money(ledger?.totals.received || 0, cur)}</b> · Owed <b style="color:#b45309">${money(ledger?.totals.receivable || 0, cur)}</b> · Gross profit <b>${money(ledger?.totals.grossProfit || 0, cur)}</b></span>
      </div>
      <div class="card">
        <table class="data-table">
          <thead><tr><th>When</th><th>Movement</th><th style="text-align:right">Qty</th><th style="text-align:right">Balance</th><th style="text-align:right">Value</th><th>Money</th></tr></thead>
          <tbody>${ledgerHtml}</tbody>
        </table>
      </div>

      <h3 style="margin:18px 0 10px">🧾 Manual movement history <span style="font-size:12px;color:var(--muted)">(reverse a mistaken stock-in / adjustment here)</span></h3>
      <div class="card">
        <table class="data-table">
          <thead><tr><th>When</th><th>Type</th><th style="text-align:right">Qty</th><th>Reason</th><th></th></tr></thead>
          <tbody>${histHtml}</tbody>
        </table>
      </div>`));
  } catch (e) {
    res.send(layout("Error", `<div class="alert red">${esc(e.message)}<pre style="font-size:11px">${esc(e.stack || "")}</pre></div>`));
  }
});

// ── Item mutations ───────────────────────────────────────────────────────────
router.post("/item/:itemId/stock-in", requireSupplierAdmin, async (req, res) => {
  try {
    const { supplier, biz } = await loadBizContext(req);
    const svc = await import("../services/stockService.js");
    const item = await svc.getStockItem(req.params.itemId);
    const qty = parseFloat(req.body.qty);
    if (!item || isNaN(qty) || qty <= 0) return res.redirect(stockUrl(supplier._id, `/item/${req.params.itemId}?error=Enter+a+positive+quantity`));
    await svc.recordMovement({
      businessId: biz._id, stockItemId: item._id, branchId: item.branchId || null,
      type: "purchase", qty, unitCost: parseFloat(req.body.unitCost) || 0,
      reason: req.body.reason || "Stock in", createdBy: "admin", currency: biz.currency
    });
    res.redirect(stockUrl(supplier._id, `/item/${item._id}?success=Stock+added`));
  } catch (e) { res.redirect(stockUrl(req.params.id, `/item/${req.params.itemId}?error=${encodeURIComponent(e.message)}`)); }
});

router.post("/item/:itemId/adjust", requireSupplierAdmin, async (req, res) => {
  try {
    const { supplier, biz } = await loadBizContext(req);
    const svc = await import("../services/stockService.js");
    const item = await svc.getStockItem(req.params.itemId);
    const delta = parseFloat(req.body.delta);
    if (!item || isNaN(delta) || delta === 0) return res.redirect(stockUrl(supplier._id, `/item/${req.params.itemId}?error=Enter+a+non-zero+change`));
    await svc.recordMovement({
      businessId: biz._id, stockItemId: item._id, branchId: item.branchId || null,
      type: delta < 0 ? "wastage" : "adjustment", qty: delta,
      reason: req.body.reason || (delta < 0 ? "Wastage / loss" : "Adjustment"),
      createdBy: "admin", currency: biz.currency
    });
    res.redirect(stockUrl(supplier._id, `/item/${item._id}?success=Adjustment+applied`));
  } catch (e) { res.redirect(stockUrl(req.params.id, `/item/${req.params.itemId}?error=${encodeURIComponent(e.message)}`)); }
});

router.post("/item/:itemId/set", requireSupplierAdmin, async (req, res) => {
  try {
    const { supplier, biz } = await loadBizContext(req);
    const svc = await import("../services/stockService.js");
    const item = await svc.getStockItem(req.params.itemId);
    const count = parseFloat(req.body.count);
    if (!item || isNaN(count) || count < 0) return res.redirect(stockUrl(supplier._id, `/item/${req.params.itemId}?error=Enter+a+valid+count`));
    const live = await svc.recomputeItemQty(item._id);
    const delta = count - (live ? live.currentQty : item.currentQty);
    if (Math.abs(delta) > 0.0001) {
      await svc.recordMovement({
        businessId: biz._id, stockItemId: item._id, branchId: item.branchId || null,
        type: "adjustment", qty: delta, reason: req.body.reason || "Stock count correction",
        createdBy: "admin", currency: biz.currency
      });
    }
    res.redirect(stockUrl(supplier._id, `/item/${item._id}?success=Count+set+to+${count}`));
  } catch (e) { res.redirect(stockUrl(req.params.id, `/item/${req.params.itemId}?error=${encodeURIComponent(e.message)}`)); }
});

router.post("/item/:itemId/edit", requireSupplierAdmin, async (req, res) => {
  try {
    const { supplier } = await loadBizContext(req);
    const svc = await import("../services/stockService.js");
    await svc.updateStockItem(req.params.itemId, {
      name: req.body.name, unit: req.body.unit,
      costPrice: req.body.costPrice, sellPrice: req.body.sellPrice,
      reorderLevel: req.body.reorderLevel, aliases: req.body.aliases
    });
    res.redirect(stockUrl(supplier._id, `/item/${req.params.itemId}?success=Saved`));
  } catch (e) { res.redirect(stockUrl(req.params.id, `/item/${req.params.itemId}?error=${encodeURIComponent(e.message)}`)); }
});

router.post("/item/:itemId/delete", requireSupplierAdmin, async (req, res) => {
  try {
    const { supplier } = await loadBizContext(req);
    const svc = await import("../services/stockService.js");
    await svc.deactivateStockItem(req.params.itemId);
    res.redirect(stockUrl(supplier._id, "?success=Product+is+no+longer+tracked"));
  } catch (e) { res.redirect(stockUrl(req.params.id, `?error=${encodeURIComponent(e.message)}`)); }
});

router.post("/movement/:movId/reverse", requireSupplierAdmin, async (req, res) => {
  try {
    const { supplier } = await loadBizContext(req);
    const svc = await import("../services/stockService.js");
    const m = await svc.reverseMovement(req.params.movId, "admin");
    const back = m ? `/item/${m.stockItemId}?success=Movement+reversed` : "?error=Movement+not+found";
    res.redirect(stockUrl(supplier._id, back));
  } catch (e) { res.redirect(stockUrl(req.params.id, `?error=${encodeURIComponent(e.message)}`)); }
});

// ═══════════════════════════════════════════════════════════════════════════
// STOCK & SALES REPORT  (decision view + PDF)
// ═══════════════════════════════════════════════════════════════════════════
router.get("/report", requireSupplierAdmin, async (req, res) => {
  try {
    const { supplier, biz } = await loadBizContext(req);
    const cur = biz.currency || "USD";
    const svc = await import("../services/stockService.js");
    const branches = await listBranches(biz._id);
    const p = periodFromQuery(req);
    const branchId = req.query.branch || null;

    const report = await svc.buildStockReport({ biz, branchId, start: p.start, end: p.end });
    const t = report.totals;

    const rows = report.rows.map(r => `
      <tr style="${r.lowStock ? "background:#fef2f2" : ""}">
        <td>${esc(r.name)}</td>
        <td style="text-align:right">${qtyFmt(r.openingAtStart)}</td>
        <td style="text-align:right" class="green">${r.purchasedIn ? "+" + qtyFmt(r.purchasedIn) : "-"}</td>
        <td style="text-align:right" class="red">${r.soldIn ? "−" + qtyFmt(r.soldIn) : "-"}</td>
        <td style="text-align:right">${r.adjustmentsIn ? qtyFmt(r.adjustmentsIn) : "-"}</td>
        <td style="text-align:right;font-weight:700">${qtyFmt(r.closing)}</td>
        <td style="text-align:right;color:#16a34a">${money(r.receivedValue, cur)}</td>
        <td style="text-align:right;color:#b45309">${money(r.receivableValue, cur)}</td>
        <td style="text-align:right">${money(r.cogs, cur)}</td>
        <td style="text-align:right;font-weight:600">${money(r.grossProfit, cur)}${r.marginPct != null ? ` <span style="color:var(--muted);font-weight:400">(${r.marginPct}%)</span>` : ""}</td>
        <td style="text-align:right">${money(r.stockValueCost, cur)}</td>
      </tr>`).join("");

    const branchSel = `<form method="GET" style="display:inline">
      <input type="hidden" name="period" value="${req.query.period || ""}">
      <select name="branch" style="${fs};width:auto;display:inline-block" onchange="this.form.submit()">
        <option value="">All branches</option>
        ${branches.map(b => `<option value="${b._id}" ${String(b._id) === String(branchId) ? "selected" : ""}>${esc(b.name)}</option>`).join("")}
      </select></form>`;

    res.send(layout("Stock & Sales Report", `
      <a href="${stockUrl(supplier._id)}" class="back-link">← Back to stock</a>
      <h2 style="margin:12px 0 6px">📈 Stock &amp; Sales Report</h2>
      <p style="color:var(--muted);margin-bottom:12px">${esc(supplier.businessName)} · ${esc(p.label)} · ${esc(branchName(branches, branchId))}</p>
      <div style="margin-bottom:14px;display:flex;gap:10px;flex-wrap:wrap;align-items:center">
        ${periodPicker(supplier._id, "/report", req.query.period || `${p.start.getFullYear()}-${String(p.start.getMonth() + 1).padStart(2, "0")}`)}
        ${branchSel}
        <a class="btn btn-blue" href="${stockUrl(supplier._id, `/report/pdf?period=${req.query.period || ""}&branch=${branchId || ""}`)}">⬇ Download PDF</a>
      </div>

      <div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:16px">
        <div class="card" style="flex:1;min-width:130px"><div style="font-size:11px;color:var(--muted)">Units sold</div><div style="font-size:20px;font-weight:700">${qtyFmt(t.soldQty)}</div></div>
        <div class="card" style="flex:1;min-width:130px"><div style="font-size:11px;color:var(--muted)">Received</div><div style="font-size:20px;font-weight:700;color:#16a34a">${money(t.receivedValue, cur)}</div></div>
        <div class="card" style="flex:1;min-width:130px"><div style="font-size:11px;color:var(--muted)">Yet to receive</div><div style="font-size:20px;font-weight:700;color:#b45309">${money(t.receivableValue, cur)}</div></div>
        <div class="card" style="flex:1;min-width:130px"><div style="font-size:11px;color:var(--muted)">Gross profit</div><div style="font-size:20px;font-weight:700">${money(t.grossProfit, cur)}</div></div>
        <div class="card" style="flex:1;min-width:130px"><div style="font-size:11px;color:var(--muted)">Stock value</div><div style="font-size:20px;font-weight:700">${money(t.stockValueCost, cur)}</div></div>
        <div class="card" style="flex:1;min-width:130px"><div style="font-size:11px;color:var(--muted)">Low stock</div><div style="font-size:20px;font-weight:700;color:${t.lowStockCount ? "#dc2626" : "#16a34a"}">${t.lowStockCount}</div></div>
      </div>

      <div class="card">
        <table class="data-table">
          <thead><tr>
            <th>Product</th><th style="text-align:right">Open</th><th style="text-align:right">In</th>
            <th style="text-align:right">Sold</th><th style="text-align:right">Adj</th><th style="text-align:right">Close</th>
            <th style="text-align:right">Received</th><th style="text-align:right">Receivable</th>
            <th style="text-align:right">COGS</th><th style="text-align:right">Gross profit</th><th style="text-align:right">Stock value</th>
          </tr></thead>
          <tbody>${rows || `<tr><td colspan="11" style="text-align:center;color:var(--muted);padding:20px">No tracked products</td></tr>`}</tbody>
        </table>
      </div>
      <p style="font-size:12px;color:var(--muted);margin-top:10px">
        <b>Reading it:</b> Close = Open + In − Sold ± Adj. “Received” is cash from receipts, “Receivable” is money still owed on unpaid invoices.
        COGS = units sold × cost. Gross profit = sales value − COGS. Red rows are at/below reorder level - time to restock.
      </p>`));
  } catch (e) {
    res.send(layout("Error", `<div class="alert red">${esc(e.message)}<pre style="font-size:11px">${esc(e.stack || "")}</pre></div>`));
  }
});

router.get("/report/pdf", requireSupplierAdmin, async (req, res) => {
  try {
    const { supplier, biz } = await loadBizContext(req);
    const svc = await import("../services/stockService.js");
    const branches = await listBranches(biz._id);
    const p = periodFromQuery(req);
    const branchId = req.query.branch || null;

    const report = await svc.buildStockReport({ biz, branchId, start: p.start, end: p.end });

    let branchBreakdown = null;
    if (!branchId && branches.length > 1) {
      branchBreakdown = [];
      for (const b of branches) {
        const br = await svc.buildStockReport({ biz, branchId: b._id, start: p.start, end: p.end });
        if (br.itemCount) branchBreakdown.push({ branchName: b.name, itemCount: br.itemCount, totals: br.totals });
      }
    }

    const { filepath } = await svc.generateStockReportPDF({
      biz, report, periodLabel: p.label, branchName: branchName(branches, branchId) === "Whole business" ? "" : branchName(branches, branchId),
      branchBreakdown
    });
    res.download(filepath);
  } catch (e) {
    res.send(layout("Error", `<div class="alert red">${esc(e.message)}</div>`));
  }
});

export default router;