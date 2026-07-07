/**
 * services/stockService.js
 * ─────────────────────────────────────────────────────────────────────────────
 * WHERE TO PUT THIS FILE:  services/stockService.js
 *
 * The whole stock module lives behind this one service. Nothing in the sales
 * flow imports it or is changed by it - stock READS sales, never the reverse,
 * so enabling stock cannot break invoicing/receipts.
 *
 * WHAT IT DOES:
 *   • Opt-in         : isEnabled / enable / disable  (StockSettings)
 *   • Items          : create / list / find / recompute quantity
 *   • Sale matching  : match an Invoice line item name → a tracked StockItem
 *                      (auto by name/alias; also used by the "pick from list"
 *                      path which just stores the exact item name)
 *   • Derived qty    : currentQty = opening + manual movements − quantity sold
 *                      (quantity sold is summed live from real Invoices)
 *   • Reports        : per-branch movement + business-wide roll-up, with money
 *                      RECEIVED (receipts) vs YET TO BE RECEIVED (invoices)
 *   • PDF            : A4 stock & sales statement
 * ─────────────────────────────────────────────────────────────────────────────
 */

import path from "path";
import fs   from "fs";
import mongoose from "mongoose";

const getModels = async () => ({
  StockSettings: (await import("../models/stockSettings.js")).default,
  StockItem:     (await import("../models/stockItem.js")).default,
  StockMovement: (await import("../models/stockMovement.js")).default,
  Invoice:       (await import("../models/invoice.js")).default,
});

const oid = v => (v instanceof mongoose.Types.ObjectId ? v : new mongoose.Types.ObjectId(String(v)));

// ── Normalisation for matching sale lines to products ─────────────────────────
function norm(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")   // strip punctuation
    .replace(/\s+/g, " ")
    .trim();
}

function fmtMoney(n, cur = "USD") {
  const sym = cur === "ZWL" ? "ZWL " : cur === "ZAR" ? "R " : "$ ";
  return `${sym}${Number(n || 0).toFixed(2)}`;
}
function fmtQty(n) {
  const v = Number(n || 0);
  return Number.isInteger(v) ? String(v) : v.toFixed(2);
}
function fmtDate(d) {
  return new Date(d).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}
function esc(s) {
  return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ═══════════════════════════════════════════════════════════════════════════
// OPT-IN
// ═══════════════════════════════════════════════════════════════════════════
export async function isStockEnabled(businessId) {
  try {
    const { StockSettings } = await getModels();
    const s = await StockSettings.findOne({ businessId }).lean();
    return !!(s && s.enabled);
  } catch (_) { return false; }
}

export async function getStockSettings(businessId) {
  const { StockSettings } = await getModels();
  let s = await StockSettings.findOne({ businessId });
  if (!s) s = await StockSettings.create({ businessId });
  return s;
}

export async function enableStock(businessId, byPhone) {
  const { StockSettings } = await getModels();
  return StockSettings.findOneAndUpdate(
    { businessId },
    { $set: { enabled: true, enabledBy: byPhone, enabledAt: new Date() } },
    { upsert: true, new: true }
  );
}

export async function disableStock(businessId) {
  const { StockSettings } = await getModels();
  return StockSettings.findOneAndUpdate(
    { businessId }, { $set: { enabled: false } }, { upsert: true, new: true }
  );
}

// Turn the "sales reduce stock automatically" behaviour on/off.
export async function setAutoMatchSales(businessId, on) {
  const { StockSettings } = await getModels();
  return StockSettings.findOneAndUpdate(
    { businessId }, { $set: { autoMatchSales: !!on } }, { upsert: true, new: true }
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// CATALOGUE (for the "pick a product to track" picker - no typing)
// ═══════════════════════════════════════════════════════════════════════════
// Returns the business's existing catalogue product names (price list, listed
// products, uploaded products) that are NOT already tracked, de-duplicated and
// in their original display casing. The chatbot/admin show these as a numbered
// list so the owner picks instead of typing - which keeps the tracked name
// IDENTICAL to what appears on invoices, so sale auto-matching actually works.
export async function getTrackableCatalogue({ businessId, branchId = null }) {
  const { StockItem } = await getModels();
  const rawNames = [];

  // ── Source 1 (primary): the Product catalogue used by Business Tools ────────
  // This is what "View Products & Services" shows. Services are excluded - you
  // keep stock of physical goods, not services. Branch-scoped like View Products
  // (a branch also sees products with no branch set).
  try {
    const Product = (await import("../models/product.js")).default;
    const pq = { businessId, isActive: true, isService: { $ne: true } };
    if (branchId) pq.$or = [{ branchId }, { branchId: null }, { branchId: { $exists: false } }];
    const products = await Product.find(pq).select("name").sort({ name: 1 }).lean();
    products.forEach(p => { if (p && p.name) rawNames.push(String(p.name)); });
  } catch (_) {}

  // ── Source 2 (fallback): the marketplace SupplierProfile catalogue ─────────
  // Some businesses list products on their SupplierProfile instead. Union both
  // so the picker works regardless of which subsystem a business uses.
  try {
    const SupplierProfile = (await import("../models/supplierProfile.js")).default;
    const supplier = await SupplierProfile.findOne({ businessId }).lean();
    if (supplier) {
      (supplier.prices || []).forEach(p => { if (p && p.product) rawNames.push(String(p.product)); });
      (supplier.listedProducts || []).forEach(p => { if (p) rawNames.push(String(p)); });
      (supplier.products || []).forEach(p => { if (p && p !== "pending_upload") rawNames.push(String(p)); });
    }
  } catch (_) {}

  // Exclude products already tracked (compared on the normalised name)
  const q = { businessId, isActive: true };
  if (branchId) q.branchId = branchId;
  const tracked = await StockItem.find(q).select("name").lean();
  const trackedNorm = new Set(tracked.map(t => norm(t.name)));

  // De-dupe by normalised name, keep first display casing, drop already-tracked.
  const seen = new Set();
  const out = [];
  for (const raw of rawNames) {
    const name = String(raw).trim();
    const key  = norm(name);
    if (!key || seen.has(key) || trackedNorm.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════
// ITEMS
// ═══════════════════════════════════════════════════════════════════════════
export async function createStockItem({ businessId, branchId = null, name, unit = "each",
  sku = "", costPrice = 0, sellPrice = 0, openingQty = 0, reorderLevel = 0,
  aliases = [], currency = "USD", createdBy = null }) {
  const { StockItem } = await getModels();
  const item = await StockItem.create({
    businessId, branchId, name: name.trim(), unit, sku,
    costPrice, sellPrice, currency,
    openingQty, currentQty: openingQty, openingDate: new Date(),
    reorderLevel,
    aliases: (aliases || []).map(a => norm(a)).filter(Boolean),
    createdBy, lastRecomputedAt: new Date()
  });
  return item;
}

export async function listStockItems(businessId, branchId = null, activeOnly = true) {
  const { StockItem } = await getModels();
  const q = { businessId };
  if (branchId) q.branchId = branchId;
  if (activeOnly) q.isActive = true;
  return StockItem.find(q).sort({ name: 1 }).lean();
}

// Record a manual movement and refresh the cached qty.
export async function recordMovement({ businessId, stockItemId, branchId = null,
  type, qty, unitCost = 0, reason = "", date = new Date(), createdBy = null, currency = "USD" }) {
  const { StockMovement } = await getModels();
  await StockMovement.create({
    businessId, branchId, stockItemId, type, qty, unitCost, currency,
    reason, date, createdBy
  });
  return recomputeItemQty(stockItemId);
}

// ═══════════════════════════════════════════════════════════════════════════
// MATCHING  (auto-match sale line items → tracked products)
// ═══════════════════════════════════════════════════════════════════════════
// Returns the best-matching StockItem for a free-text sale line name, or null.
// Prefers the item whose canonical name/alias is the LONGEST whole match, so
// "Coca-Cola 500ml" beats a generic "Cola" alias. Scoped to the sale's branch
// first, then business-wide as a fallback.
function bestMatch(lineName, items) {
  const ln = norm(lineName);
  if (!ln) return null;
  let best = null, bestLen = 0;
  for (const it of items) {
    const candidates = [norm(it.name), ...(it.aliases || [])].filter(Boolean);
    for (const c of candidates) {
      const isMatch =
        ln === c ||
        ln.includes(` ${c} `) || ln.startsWith(`${c} `) || ln.endsWith(` ${c}`) ||
        ln.includes(c) && c.length >= 4;
      if (isMatch && c.length > bestLen) { best = it; bestLen = c.length; }
    }
  }
  return best;
}

// ═══════════════════════════════════════════════════════════════════════════
// SOLD-QUANTITY ENGINE  (derived from real Invoices - no hook in the sale flow)
// ═══════════════════════════════════════════════════════════════════════════
// For a set of tracked items, walk the business's receipts + invoices in a
// window and attribute each matching line's qty and value to an item.
// Returns Map(stockItemId → { soldQty, receivedValue, receivableValue, lines[] }).
async function computeSales({ businessId, branchId, items, start, end }) {
  const { Invoice, StockSettings } = await getModels();

  // ── "Connect to sales" switch ──────────────────────────────────────────────
  // When the owner has turned Sales Auto-Deduct OFF, sales must NOT reduce stock.
  // We short-circuit here so every downstream consumer (recompute, report,
  // ledger) sees zero sold and stock only moves on manual entries.
  try {
    const _st = await StockSettings.findOne({ businessId }).select("autoMatchSales").lean();
    if (_st && _st.autoMatchSales === false) {
      const zero = new Map();
      for (const it of items) zero.set(String(it._id), {
        item: it, soldQty: 0, receivedValue: 0, receivableValue: 0, lines: []
      });
      return zero;
    }
  } catch (_) {}

  const q = {
    businessId,
    type: { $in: ["receipt", "invoice"] },
    status: { $ne: "cancelled" }
  };
  if (branchId) q.branchId = branchId;
  if (start || end) {
    q.createdAt = {};
    if (start) q.createdAt.$gte = start;
    if (end)   q.createdAt.$lte = end;
  }

  const docs = await Invoice.find(q).select("type items total createdAt branchId status").lean();

  const result = new Map();
  for (const it of items) result.set(String(it._id), {
    item: it, soldQty: 0, receivedValue: 0, receivableValue: 0, lines: []
  });

  for (const doc of docs) {
    const isReceipt = doc.type === "receipt";
    for (const line of (doc.items || [])) {
      const match = bestMatch(line.item, items);
      if (!match) continue;
      const bucket = result.get(String(match._id));
      if (!bucket) continue;
      const qty   = Number(line.qty || 0);
      const value = Number(line.total != null ? line.total : (line.qty || 0) * (line.unit || 0));
      bucket.soldQty += qty;
      // Simple rule (user's choice): receipts = received, invoices = receivable
      if (isReceipt) bucket.receivedValue += value;
      else           bucket.receivableValue += value;
      bucket.lines.push({
        at: doc.createdAt, qty, value, docType: doc.type,
        received: isReceipt
      });
    }
  }
  return result;
}

// Recompute one item's cached currentQty from opening + manual movements − sold.
export async function recomputeItemQty(stockItemId) {
  const { StockItem, StockMovement } = await getModels();
  const item = await StockItem.findById(stockItemId);
  if (!item) return null;

  const moves = await StockMovement.find({ stockItemId: item._id, reversed: { $ne: true } })
    .select("qty").lean();
  const manual = moves.reduce((s, m) => s + (m.qty || 0), 0);

  const sales = await computeSales({
    businessId: item.businessId, branchId: item.branchId ? item.branchId : null,
    items: [item], start: null, end: null
  });
  const soldQty = sales.get(String(item._id))?.soldQty || 0;

  item.currentQty = (item.openingQty || 0) + manual - soldQty;
  item.lastRecomputedAt = new Date();
  await item.save();
  return item;
}

// ═══════════════════════════════════════════════════════════════════════════
// REPORT
// ═══════════════════════════════════════════════════════════════════════════
// Builds the Stock & Sales statement for a branch (or business-wide when
// branchId is null) over [start,end]. Each row: opening at start, purchased,
// sold, adjustments/wastage, closing, plus money received vs receivable.
export async function buildStockReport({ biz, branchId = null, start, end }) {
  const { StockItem, StockMovement } = await getModels();
  const businessId = biz._id;
  const cur = biz.currency || "USD";

  const itemQ = { businessId, isActive: true };
  if (branchId) itemQ.branchId = branchId;
  const items = await StockItem.find(itemQ).sort({ name: 1 }).lean();

  if (!items.length) {
    return { cur, start, end, rows: [], totals: emptyTotals(), branchScoped: !!branchId };
  }

  const itemIds = items.map(i => i._id);

  // Manual movements split into before-start and in-period
  const moves = await StockMovement.find({
    stockItemId: { $in: itemIds }, reversed: { $ne: true }
  }).select("stockItemId type qty unitCost date").lean();

  // Sales before start (for opening) and in period
  const [salesBefore, salesInPeriod] = await Promise.all([
    computeSales({ businessId, branchId, items, start: null, end: new Date(start.getTime() - 1) }),
    computeSales({ businessId, branchId, items, start, end })
  ]);

  const rows = [];
  const totals = emptyTotals();

  for (const it of items) {
    const id = String(it._id);
    const itemMoves = moves.filter(m => String(m.stockItemId) === id);

    const sum = (types, from, to) => itemMoves
      .filter(m => types.includes(m.type) && (!from || m.date >= from) && (!to || m.date <= to))
      .reduce((s, m) => s + (m.qty || 0), 0);

    // Opening balance AS AT start = openingQty + manual(before start) − sold(before start)
    const manualBefore = sum(["purchase", "return", "adjustment", "wastage"], null, new Date(start.getTime() - 1));
    const soldBefore   = salesBefore.get(id)?.soldQty || 0;
    const openingAtStart = (it.openingQty || 0) + manualBefore - soldBefore;

    // In-period movements
    const purchasedIn  = sum(["purchase", "return"], start, end);
    const adjustmentsIn = sum(["adjustment", "wastage"], start, end);
    const sp = salesInPeriod.get(id) || { soldQty: 0, receivedValue: 0, receivableValue: 0 };
    const soldIn = sp.soldQty;

    const closing = openingAtStart + purchasedIn + adjustmentsIn - soldIn;

    const stockValueCost = closing * (it.costPrice || 0);
    const lowStock = it.reorderLevel > 0 && closing <= it.reorderLevel;

    // Decision metrics: cost of goods sold and gross margin on what was sold
    const salesValue = sp.receivedValue + sp.receivableValue;
    const cogs       = soldIn * (it.costPrice || 0);
    const grossProfit = salesValue - cogs;
    const marginPct   = salesValue > 0 ? Math.round((grossProfit / salesValue) * 100) : null;

    rows.push({
      name: it.name, unit: it.unit, sku: it.sku,
      openingAtStart, purchasedIn, soldIn, adjustmentsIn, closing,
      costPrice: it.costPrice || 0, sellPrice: it.sellPrice || 0,
      receivedValue: sp.receivedValue, receivableValue: sp.receivableValue,
      salesValue, cogs, grossProfit, marginPct,
      stockValueCost, reorderLevel: it.reorderLevel, lowStock,
      branchId: it.branchId
    });

    totals.soldQty        += soldIn;
    totals.purchasedQty   += purchasedIn;
    totals.receivedValue  += sp.receivedValue;
    totals.receivableValue += sp.receivableValue;
    totals.stockValueCost += stockValueCost;
    totals.potentialSales += closing * (it.sellPrice || 0);
    totals.cogs           += cogs;
    totals.grossProfit    += grossProfit;
    if (lowStock) totals.lowStockCount += 1;
  }

  return { cur, start, end, rows, totals, branchScoped: !!branchId, itemCount: items.length };
}

function emptyTotals() {
  return {
    soldQty: 0, purchasedQty: 0,
    receivedValue: 0, receivableValue: 0,
    stockValueCost: 0, potentialSales: 0, lowStockCount: 0,
    cogs: 0, grossProfit: 0
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// PDF
// ═══════════════════════════════════════════════════════════════════════════
const OUTPUT_DIR = path.resolve(process.cwd(), "public", "docs", "generated", "stock");
function ensureDir() { if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true }); }

async function renderPdf(html, filepath, landscape = true) {
  const puppeteer = (await import("puppeteer")).default;
  const browser = await puppeteer.launch({ args: ["--no-sandbox", "--disable-setuid-sandbox"] });
  const page = await browser.newPage();
  await page.emulateMediaType("print");
  await page.setContent(html, { waitUntil: "networkidle0" });
  await new Promise(r => setTimeout(r, 400));
  await page.pdf({ path: filepath, format: "A4", printBackground: true, landscape,
    margin: { top: "14mm", bottom: "14mm", left: "10mm", right: "10mm" } });
  await browser.close();
}

function css() {
  return `<style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:Arial,Helvetica,sans-serif;font-size:11px;color:#1e293b}
    .header{display:flex;justify-content:space-between;align-items:flex-start;
      padding-bottom:14px;border-bottom:2px solid #0f172a;margin-bottom:16px}
    .biz{font-size:19px;font-weight:700;color:#0f172a}
    .sub{font-size:11px;color:#64748b;margin-top:4px}
    .title{font-size:14px;font-weight:700;text-align:right}
    .meta{font-size:11px;color:#64748b;text-align:right;margin-top:4px;line-height:1.6}
    .kpis{display:flex;gap:10px;margin-bottom:16px;flex-wrap:wrap}
    .kpi{flex:1;min-width:110px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:10px 12px}
    .kpi .l{font-size:9.5px;color:#64748b;text-transform:uppercase;letter-spacing:.5px}
    .kpi .v{font-size:15px;font-weight:700;margin-top:4px}
    .kpi .s{font-size:9px;color:#94a3b8;margin-top:2px}
    .green{color:#16a34a}.red{color:#dc2626}.amber{color:#b45309}
    table{width:100%;border-collapse:collapse;font-size:10.5px}
    th{background:#0f172a;color:#fff;padding:7px 8px;text-align:left;font-size:9.5px}
    td{padding:6px 8px;border-bottom:1px solid #f1f5f9}
    .r{text-align:right}
    .sec{font-size:11px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.5px;
      border-bottom:1px solid #e2e8f0;padding-bottom:6px;margin:16px 0 10px}
    .low{background:#fef2f2}
    .low td:first-child::after{content:" ⚠";color:#dc2626}
    .foot{margin-top:24px;padding-top:12px;border-top:1px solid #e2e8f0;font-size:9.5px;color:#94a3b8;
      display:flex;justify-content:space-between}
    @media print{body{-webkit-print-color-adjust:exact;print-color-adjust:exact}}
  </style>`;
}

export async function generateStockReportPDF({ biz, report, periodLabel, branchName = "", branchBreakdown = null }) {
  ensureDir();
  const filename = `stock-report-${biz._id}-${Date.now()}.pdf`;
  const filepath = path.join(OUTPUT_DIR, filename);
  const cur = report.cur;
  const t = report.totals;

  const rowsHtml = report.rows.length ? report.rows.map(r => `
    <tr class="${r.lowStock ? "low" : ""}">
      <td>${esc(r.name)}${r.sku ? ` <span style="color:#94a3b8">(${esc(r.sku)})</span>` : ""}</td>
      <td class="r">${fmtQty(r.openingAtStart)}</td>
      <td class="r green">${r.purchasedIn ? "+" + fmtQty(r.purchasedIn) : "—"}</td>
      <td class="r red">${r.soldIn ? "−" + fmtQty(r.soldIn) : "—"}</td>
      <td class="r">${r.adjustmentsIn ? (r.adjustmentsIn > 0 ? "+" : "") + fmtQty(r.adjustmentsIn) : "—"}</td>
      <td class="r" style="font-weight:700">${fmtQty(r.closing)} <span style="color:#94a3b8;font-weight:400">${esc(r.unit)}</span></td>
      <td class="r green">${fmtMoney(r.receivedValue, cur)}</td>
      <td class="r amber">${fmtMoney(r.receivableValue, cur)}</td>
      <td class="r">${fmtMoney(r.stockValueCost, cur)}</td>
    </tr>`).join("") : `<tr><td colspan="9" style="text-align:center;padding:24px;color:#9ca3af;font-style:italic">No tracked stock items</td></tr>`;

  // Optional per-branch roll-up section (business-wide report only)
  let breakdownHtml = "";
  if (branchBreakdown && branchBreakdown.length) {
    breakdownHtml = `
      <div class="sec">Per-branch roll-up</div>
      <table><thead><tr>
        <th>Branch</th><th class="r">Items</th><th class="r">Sold (qty)</th>
        <th class="r">Received</th><th class="r">Receivable</th><th class="r">Stock value</th>
      </tr></thead><tbody>
      ${branchBreakdown.map(b => `
        <tr>
          <td>${esc(b.branchName)}</td>
          <td class="r">${b.itemCount}</td>
          <td class="r">${fmtQty(b.totals.soldQty)}</td>
          <td class="r green">${fmtMoney(b.totals.receivedValue, cur)}</td>
          <td class="r amber">${fmtMoney(b.totals.receivableValue, cur)}</td>
          <td class="r">${fmtMoney(b.totals.stockValueCost, cur)}</td>
        </tr>`).join("")}
      </tbody></table>`;
  }

  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8">${css()}</head><body>
    <div class="header">
      <div>
        <div class="biz">${esc(biz.name)}</div>
        <div class="sub">${esc(biz.address || "")}${biz.address ? " · " : ""}${esc(cur)}${branchName ? " · " + esc(branchName) : " · All branches"}</div>
      </div>
      <div>
        <div class="title">Stock &amp; Sales Report</div>
        <div class="meta">${esc(periodLabel)}<br>Generated ${fmtDate(new Date())}</div>
      </div>
    </div>

    <div class="kpis">
      <div class="kpi"><div class="l">Units Sold</div><div class="v">${fmtQty(t.soldQty)}</div><div class="s">in period</div></div>
      <div class="kpi"><div class="l">Money Received</div><div class="v green">${fmtMoney(t.receivedValue, cur)}</div><div class="s">cash receipts</div></div>
      <div class="kpi"><div class="l">Yet To Receive</div><div class="v amber">${fmtMoney(t.receivableValue, cur)}</div><div class="s">on unpaid invoices</div></div>
      <div class="kpi"><div class="l">Stock On Hand</div><div class="v">${fmtMoney(t.stockValueCost, cur)}</div><div class="s">at cost</div></div>
      <div class="kpi"><div class="l">Potential Sales</div><div class="v">${fmtMoney(t.potentialSales, cur)}</div><div class="s">on-hand at sell price</div></div>
      <div class="kpi"><div class="l">Low Stock</div><div class="v ${t.lowStockCount ? "red" : "green"}">${t.lowStockCount}</div><div class="s">item(s) at/below reorder</div></div>
    </div>

    <div class="sec">Stock movement &amp; sales per product</div>
    <table>
      <thead><tr>
        <th>Product</th>
        <th class="r">Opening</th>
        <th class="r">In</th>
        <th class="r">Sold</th>
        <th class="r">Adj</th>
        <th class="r">Closing</th>
        <th class="r">Received</th>
        <th class="r">Receivable</th>
        <th class="r">Stock value</th>
      </tr></thead>
      <tbody>${rowsHtml}</tbody>
    </table>

    ${breakdownHtml}

    <div style="margin-top:12px;font-size:9.5px;color:#94a3b8;line-height:1.6">
      <b>How to read this:</b> "Sold" is quantity matched to your real sales in the period.
      "Received" is money from cash receipts; "Receivable" is money still owed on unpaid invoices
      for these products. "Closing" = Opening + In − Sold ± Adjustments. Rows shaded red are at or
      below their reorder level.
    </div>

    <div class="foot">
      <span>${esc(biz.name)} — Stock &amp; Sales Report</span>
      <span>ZimQuote · ${fmtDate(new Date())}</span>
    </div>
  </body></html>`;

  await renderPdf(html, filepath, true);
  const site = (process.env.SITE_URL || "").replace(/\/$/, "");
  return { filename, filepath, url: `${site}/docs/generated/stock/${filename}` };
}

// ═══════════════════════════════════════════════════════════════════════════
// ADMIN HELPERS  (used by the web admin panel)
// ═══════════════════════════════════════════════════════════════════════════
export async function getStockItem(id) {
  const { StockItem } = await getModels();
  return StockItem.findById(id).lean();
}

export async function updateStockItem(id, fields) {
  const { StockItem } = await getModels();
  const clean = {};
  ["name", "unit", "sku", "notes"].forEach(k => { if (fields[k] != null) clean[k] = fields[k]; });
  ["costPrice", "sellPrice", "reorderLevel"].forEach(k => { if (fields[k] != null) clean[k] = Number(fields[k]) || 0; });
  if (fields.aliases != null) {
    clean.aliases = (Array.isArray(fields.aliases) ? fields.aliases : String(fields.aliases).split(","))
      .map(a => norm(a)).filter(Boolean);
  }
  await StockItem.findByIdAndUpdate(id, { $set: clean });
  return recomputeItemQty(id);
}

// Soft-delete (deactivate) - keeps history and lets it be re-enabled.
export async function deactivateStockItem(id) {
  const { StockItem } = await getModels();
  return StockItem.findByIdAndUpdate(id, { $set: { isActive: false } }, { new: true });
}

export async function listMovements(stockItemId, limit = 200) {
  const { StockMovement } = await getModels();
  return StockMovement.find({ stockItemId }).sort({ date: -1, createdAt: -1 }).limit(limit).lean();
}

// Soft-reverse a manual movement (purchase/adjustment/wastage/etc). Sales are
// derived from invoices and are NOT movements, so they can't be reversed here -
// correct a wrong sale by editing/deleting the receipt in Financial Records.
export async function reverseMovement(movementId, byPhone) {
  const { StockMovement } = await getModels();
  const m = await StockMovement.findById(movementId);
  if (!m || m.reversed) return null;
  m.reversed = true; m.reversedAt = new Date(); m.reversedBy = byPhone;
  await m.save();
  await recomputeItemQty(m.stockItemId);
  return m;
}

// ═══════════════════════════════════════════════════════════════════════════
// DAILY STOCK LEDGER  (running balances: opening & closing stock per day)
// ═══════════════════════════════════════════════════════════════════════════
// For ONE item over [start,end]: a bank-statement-style ledger. Each day shows
// opening stock, every movement (stock-in +, sale −, adjustment/wastage ±)
// with the running quantity after it, and the closing stock carried into the
// next day. Also the money made that day (received vs receivable) and COGS, so
// an owner can read profitability and reorder timing straight off the page.
export async function buildStockLedger({ biz, stockItemId, start, end }) {
  const { StockItem, StockMovement } = await getModels();
  const item = await StockItem.findById(stockItemId).lean();
  if (!item) return null;
  const cur = item.currency || biz.currency || "USD";

  const movesAll = await StockMovement.find({ stockItemId: item._id, reversed: { $ne: true } })
    .sort({ date: 1 }).lean();

  // Opening stock as at `start`
  const manualBefore = movesAll.filter(m => m.date < start).reduce((s, m) => s + (m.qty || 0), 0);
  const salesBefore  = await computeSales({ businessId: item.businessId, branchId: item.branchId || null, items: [item], start: null, end: new Date(start.getTime() - 1) });
  const soldBefore   = salesBefore.get(String(item._id))?.soldQty || 0;
  const opening = (item.openingQty || 0) + manualBefore - soldBefore;

  // In-period rows: manual movements + derived sale lines
  const manualIn = movesAll.filter(m => m.date >= start && m.date <= end).map(m => ({
    at: m.date, type: m.type, qty: m.qty, note: m.reason || "", value: 0, received: null
  }));
  const salesIn = await computeSales({ businessId: item.businessId, branchId: item.branchId || null, items: [item], start, end });
  const saleLines = (salesIn.get(String(item._id))?.lines || []).map(l => ({
    at: l.at, type: "sale", qty: -Math.abs(l.qty), note: l.received ? "Cash sale" : "Credit (invoice)",
    value: l.value, received: l.received
  }));

  const all = [...manualIn, ...saleLines].sort((a, b) => new Date(a.at) - new Date(b.at));

  // Group by calendar day
  const dayMap = new Map();
  for (const r of all) {
    const k = new Date(r.at).toLocaleDateString("en-GB", { weekday: "short", day: "2-digit", month: "short", year: "numeric" });
    if (!dayMap.has(k)) dayMap.set(k, []);
    dayMap.get(k).push(r);
  }

  let running = opening;
  const days = [];
  const totals = { inQty: 0, soldQty: 0, adjQty: 0, salesValue: 0, received: 0, receivable: 0, cogs: 0 };

  for (const [dayKey, rows] of dayMap) {
    const dayOpening = running;
    let inQty = 0, soldQty = 0, adjQty = 0, salesValue = 0, received = 0, receivable = 0;
    for (const r of rows) {
      running += r.qty;
      r.runningQty = running;
      if (r.type === "sale") {
        const q = -r.qty; soldQty += q; salesValue += r.value;
        if (r.received) received += r.value; else receivable += r.value;
      } else if (r.type === "purchase" || r.type === "return" || r.type === "opening") {
        inQty += r.qty;
      } else {
        adjQty += r.qty;   // adjustment / wastage
      }
    }
    const cogs = soldQty * (item.costPrice || 0);
    days.push({ dayKey, opening: dayOpening, closing: running, rows, inQty, soldQty, adjQty, salesValue, received, receivable, cogs });
    totals.inQty += inQty; totals.soldQty += soldQty; totals.adjQty += adjQty;
    totals.salesValue += salesValue; totals.received += received; totals.receivable += receivable; totals.cogs += cogs;
  }

  totals.grossProfit = totals.salesValue - totals.cogs;
  return { item, cur, start, end, opening, closing: running, days, totals };
}

export { norm as _normStockName, bestMatch as _bestStockMatch };