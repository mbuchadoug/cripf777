// routes/financeReports.js
// ─────────────────────────────────────────────────────────────────────────────
// WEB FINANCE REPORTS - running-balance ledgers for the /zq-admin portal.
//
// Three views, one branch/site selector, one date range:
//   • Sales ledger      - invoice payments, cash sales, expenses, payouts,
//                         handovers  (via reportHelpers.buildLedger)
//   • Recurring ledger  - rent/fee charges, collections, unit expenses, other
//                         income, with the dual cash + entity running balance
//                         (via recurringLedger.buildRecurringLedger)
//   • Combined ledger   - BOTH cash streams merged into ONE chronological
//                         running balance = the comprehensive cash position
//
// WHY A SEPARATE FILE / SEPARATE MOUNT PATH:
//   Mounted at  /zq-admin/suppliers/:id/finance-reports  - a SIBLING of the
//   existing /finance router, so it can never collide with that router's
//   "/:phone" catch-all and needs ZERO edits to supplierFinancialAdmin.js.
//   It only READS, through engines that are already live, so it cannot affect
//   the chatbot, the clerk workspace, or any recompute.
//
// MOUNT in supplierAdmin.js (next to the finance mount), BEFORE the /:phone
// finance router is fine since the path differs:
//   import financeReportsRoutes from "./financeReports.js";
//   router.use("/suppliers/:id/finance-reports", financeReportsRoutes);
//
// supplierAdmin.js already exports { layout, esc } (used by the finance router).
// ─────────────────────────────────────────────────────────────────────────────

import express from "express";
import mongoose from "mongoose";
import { requireSupplierAdmin } from "../middleware/supplierAdminAuth.js";
import SupplierProfile from "../models/supplierProfile.js";
import { layout, esc } from "./supplierAdmin.js";
import { financeNav } from "./financeNav.js";
import { buildLedger } from "../services/reportHelpers.js";
import {
  buildRecurringLedger,
  generateRecurringLedgerPDF,
  accountIdsForBranch
} from "../services/recurringLedger.js";

const router = express.Router({ mergeParams: true });
router.use(express.json());
router.use(express.urlencoded({ extended: true }));

// ── small formatters ─────────────────────────────────────────────────────────
const money = (n, cur = "USD") =>
  `${cur === "ZWL" ? "Z$" : cur === "ZAR" ? "R" : "$"}${Number(n || 0).toFixed(2)}`;
const dt = d => new Date(d).toLocaleString("en-GB",
  { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
const oid = v => (v instanceof mongoose.Types.ObjectId ? v : new mongoose.Types.ObjectId(String(v)));
const fs = `width:100%;padding:9px 12px;border:1px solid var(--border);border-radius:7px;font-size:14px`;

// ── context loaders (same pattern as supplierFinancialAdmin.js) ───────────────
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
function branchOptions(branches, selectedId) {
  return [`<option value="">All branches / whole business</option>`]
    .concat(branches.map(b =>
      `<option value="${b._id}" ${String(b._id) === String(selectedId) ? "selected" : ""}>${esc(b.name)}</option>`
    )).join("");
}

// ── parse ?branchId=&from=&to=&view= with sane 30-day default ─────────────────
function parseRange(req) {
  const view = ["sales", "recurring", "combined"].includes(req.query.view) ? req.query.view : "combined";
  const branchId = (req.query.branchId || "").trim() || null;
  const today = new Date();
  const toStr = req.query.to || today.toISOString().slice(0, 10);
  const fromStr = req.query.from ||
    new Date(today.getTime() - 30 * 864e5).toISOString().slice(0, 10);
  const start = new Date(fromStr); start.setHours(0, 0, 0, 0);
  const end = new Date(toStr); end.setHours(23, 59, 59, 999);
  return { view, branchId, fromStr, toStr, start, end };
}

// ── sales opening cash carried forward from all history before `start` ────────
// Mirrors what buildLedger nets: (payments + cash sales) − (expenses + payouts).
// Reversed rows contribute 0 because their amount/total is zeroed on reverse.
async function salesOpeningBalance(biz, branchId, start) {
  const Invoice        = (await import("../models/invoice.js")).default;
  const InvoicePayment = (await import("../models/invoicePayment.js")).default;
  const Expense        = (await import("../models/expense.js")).default;
  let CashPayout = null;
  try { CashPayout = (await import("../models/cashPayout.js")).default; } catch (_) {}

  const bMatch = { businessId: oid(biz._id), ...(branchId ? { branchId: oid(branchId) } : {}) };
  const sum = async (Model, dateField, extra = {}) => {
    const r = await Model.aggregate([
      { $match: { ...bMatch, ...extra, [dateField]: { $lt: start } } },
      { $group: { _id: null, t: { $sum: dateField === "total" ? "$total" : "$amount" } } }
    ]).catch(() => []);
    return r[0]?.t || 0;
  };

  const [payIn, expOut] = await Promise.all([
    sum(InvoicePayment, "createdAt"),
    sum(Expense, "createdAt"),
  ]);
  // cash sales sum `total`, filtered by createdAt
  const saleAgg = await Invoice.aggregate([
    { $match: { ...bMatch, type: "receipt", createdAt: { $lt: start } } },
    { $group: { _id: null, t: { $sum: "$total" } } }
  ]).catch(() => []);
  const saleIn = saleAgg[0]?.t || 0;

  let payoutOut = 0;
  if (CashPayout) {
    const pr = await CashPayout.aggregate([
      { $match: { ...bMatch, date: { $lt: start } } },
      { $group: { _id: null, t: { $sum: "$amount" } } }
    ]).catch(() => []);
    payoutOut = pr[0]?.t || 0;
  }
  return payIn + saleIn - expOut - payoutOut;
}

// ── fetch the four collections buildLedger needs, branch + date scoped ────────
async function fetchSalesData(biz, branchId, start, end) {
  const Invoice        = (await import("../models/invoice.js")).default;
  const InvoicePayment = (await import("../models/invoicePayment.js")).default;
  const Expense        = (await import("../models/expense.js")).default;
  const bQ = { businessId: biz._id, ...(branchId ? { branchId } : {}) };

  const [payments, receipts, expenses] = await Promise.all([
    InvoicePayment.find({ ...bQ, createdAt: { $gte: start, $lte: end } }).lean(),
    Invoice.find({ ...bQ, type: "receipt", createdAt: { $gte: start, $lte: end } }).lean(),
    Expense.find({ ...bQ, createdAt: { $gte: start, $lte: end } }).lean(),
  ]);
  // invoices are only needed so payments can resolve their number/client
  const invIds = [...new Set(payments.map(p => p.invoiceId && String(p.invoiceId)).filter(Boolean))];
  const invoices = invIds.length
    ? await Invoice.find({ _id: { $in: invIds } }).lean()
    : [];
  return { invoices, receipts, payments, expenses };
}

// ── normalise a sales-ledger row + a recurring-ledger row into one shape ──────
function normSales(r) {
  return {
    at: r.at, stream: "SALES",
    label: r.typeLabel, detail: r.description, recorder: r.recorder,
    in: r.credit || 0, out: r.debit || 0, isHandover: !!r.isHandover
  };
}
function normRecurring(r) {
  return {
    at: r.at, stream: "BILLING",
    label: r.typeLabel, detail: `${r.entity} · ${r.description}`, recorder: r.recorder,
    in: r.cashIn || 0, out: r.cashOut || 0, isHandover: false
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN REPORTS PAGE  - GET /suppliers/:id/finance-reports
// ═══════════════════════════════════════════════════════════════════════════
router.get("/", requireSupplierAdmin, async (req, res) => {
  try {
    const { supplier, biz } = await loadBizContext(req);
    if (!biz) {
      return res.send(layout("Finance Reports", `
        <a href="/zq-admin/suppliers/${req.params.id}" class="back-link">← Back to Profile</a>
        <div class="alert red" style="margin-top:16px">This supplier has no linked Business record yet.</div>`));
    }

    const { view, branchId, fromStr, toStr, start, end } = parseRange(req);
    const cur = biz.currency || "USD";
    const branches = await listBranches(biz._id);
    const branchName = branchId ? (branches.find(b => String(b._id) === String(branchId))?.name || "Branch") : "";

    // ── Build whichever ledgers this view needs ──────────────────────────────
    let salesLedger = null, recurring = null;
    if (view === "sales" || view === "combined") {
      const data = await fetchSalesData(biz, branchId, start, end);
      const opening = await salesOpeningBalance(biz, branchId, start);
      salesLedger = await buildLedger({ biz, data, branchId, start, end, openingBalance: opening });
    }
    if (view === "recurring" || view === "combined") {
      recurring = await buildRecurringLedger({ biz, branchId, periodStart: start, periodEnd: end });
    }

    // ── Filter bar (branch + date range + view tabs) ─────────────────────────
    const q = v => `?view=${v}&branchId=${encodeURIComponent(branchId || "")}&from=${fromStr}&to=${toStr}`;
    const tab = (v, label) =>
      `<a href="${q(v)}" class="rtab ${view === v ? "on" : ""}">${label}</a>`;

    const filterBar = `
      <form method="GET" class="rfilter">
        <input type="hidden" name="view" value="${view}">
        <div><label>Branch / site</label>
          <select name="branchId" style="${fs}">${branchOptions(branches, branchId)}</select></div>
        <div><label>From</label><input type="date" name="from" value="${fromStr}" style="${fs}"></div>
        <div><label>To</label><input type="date" name="to" value="${toStr}" style="${fs}"></div>
        <div style="align-self:end"><button class="btn btn-blue" style="width:100%">Apply</button></div>
      </form>
      <div class="rtabs">${tab("combined", "🧮 Combined")}${tab("sales", "🧾 Sales")}${tab("recurring", "🏠 Recurring")}</div>`;

    // ── Render the chosen view ───────────────────────────────────────────────
    let body = "";
    if (view === "sales")     body = renderSales(salesLedger, cur);
    if (view === "recurring") body = renderRecurring(recurring, cur, supplier, branchId, fromStr, toStr);
    if (view === "combined")  body = renderCombined(salesLedger, recurring, cur);

    res.send(layout(`Finance Reports${branchName ? " · " + branchName : ""}`, `
      <a href="/zq-admin/suppliers/${supplier._id}/finance" class="back-link">← Finance workspace</a>
      ${financeNav(supplier._id, "reports")}
      <div class="panel-head" style="margin-top:10px">
        <h3>📊 Finance Reports - ${esc(supplier.businessName)}</h3>
        <span style="font-size:12px;color:var(--muted)">
          Running-balance ledgers you can filter by branch and date. Combined merges
          everyday sales and recurring billing into one cash position.
        </span>
      </div>
      <style>
        .rfilter{display:grid;grid-template-columns:2fr 1fr 1fr auto;gap:12px;margin:16px 0 10px;
          background:var(--white);border:1px solid var(--border);border-radius:12px;padding:14px 16px}
        .rfilter label{font-weight:600;font-size:12px;display:block;margin-bottom:5px}
        .rtabs{display:flex;gap:8px;margin:6px 0 18px}
        .rtab{padding:8px 16px;border-radius:20px;border:1px solid var(--border);text-decoration:none;
          font-size:13px;font-weight:600;color:var(--text);background:var(--white)}
        .rtab.on{background:var(--blue,#2563eb);color:#fff;border-color:transparent}
        .kgrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:20px}
        .kcard{background:var(--white);border:1px solid var(--border);border-radius:12px;padding:14px}
        .kval{font-size:19px;font-weight:800}
        .klbl{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.4px;margin-top:3px}
        .lt{width:100%;border-collapse:collapse;font-size:12.5px;background:var(--white);
          border:1px solid var(--border);border-radius:12px;overflow:hidden}
        .lt th{background:#0f172a;color:#fff;padding:9px 10px;text-align:left;font-size:11px}
        .lt td{padding:8px 10px;border-bottom:1px solid #f1f5f9;vertical-align:top}
        .lt .r{text-align:right}
        .cin{color:#16a34a;font-weight:700}.cout{color:#dc2626;font-weight:700}
        .bal{font-weight:800}.rev{opacity:.55;text-decoration:line-through}
        .pill{font-size:10px;padding:2px 7px;border-radius:20px;font-weight:700}
        .pill.s{background:#dbeafe;color:#1e40af}.pill.b{background:#dcfce7;color:#166534}
      </style>
      ${filterBar}
      ${body}
    `));
  } catch (e) {
    res.send(layout("Error", `<div class="alert red">${esc(e.message)}<pre style="font-size:11px">${esc(e.stack || "")}</pre></div>`));
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// RECURRING PDF  - GET /suppliers/:id/finance-reports/recurring.pdf
// ═══════════════════════════════════════════════════════════════════════════
router.get("/recurring.pdf", requireSupplierAdmin, async (req, res) => {
  try {
    const { supplier, biz } = await loadBizContext(req);
    if (!biz) return res.redirect(`/zq-admin/suppliers/${req.params.id}/finance-reports`);
    const { branchId, fromStr, toStr, start, end } = parseRange(req);
    const branches = await listBranches(biz._id);
    const branchName = branchId ? (branches.find(b => String(b._id) === String(branchId))?.name || "") : "";
    const stmt = await buildRecurringLedger({ biz, branchId, periodStart: start, periodEnd: end });
    const { url } = await generateRecurringLedgerPDF({
      biz, stmt, branchName,
      periodLabel: `${fromStr} → ${toStr}`
    });
    return res.redirect(url);
  } catch (e) {
    res.send(layout("Error", `<div class="alert red">${esc(e.message)}</div>`));
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// RENDERERS
// ═══════════════════════════════════════════════════════════════════════════
function kpi(val, lbl, cls = "") {
  return `<div class="kcard"><div class="kval ${cls}">${val}</div><div class="klbl">${lbl}</div></div>`;
}

function renderSales(L, cur) {
  const rows = L.rows.map(r => {
    if (r.isHandover) {
      return `<tr>
        <td style="white-space:nowrap;color:var(--muted)">${dt(r.at)}</td>
        <td><span class="pill s">SALES</span> ${esc(r.typeLabel)}</td>
        <td>${esc(r.description)} ${r.flag ? `· ${esc(r.flag)}` : ""}</td>
        <td class="r muted">counted ${money(r.amountCounted, cur)}</td>
        <td class="r">-</td><td class="r bal">${money(r.balance, cur)}</td></tr>`;
    }
    return `<tr>
      <td style="white-space:nowrap;color:var(--muted)">${dt(r.at)}</td>
      <td><span class="pill s">SALES</span> ${esc(r.typeLabel)}</td>
      <td>${esc(r.description)}<div style="font-size:11px;color:var(--muted)">by ${esc(r.recorder || "-")}</div></td>
      <td class="r">${r.credit ? `<span class="cin">+${money(r.credit, cur)}</span>` : ""}</td>
      <td class="r">${r.debit ? `<span class="cout">−${money(r.debit, cur)}</span>` : ""}</td>
      <td class="r bal">${money(r.balance, cur)}</td></tr>`;
  }).join("");

  return `
    <div class="kgrid">
      ${kpi(money(L.openingBalance, cur), "Opening cash")}
      ${kpi(money(L.totalCredits, cur), "Money in", "cin")}
      ${kpi(money(L.totalDebits, cur), "Money out", "cout")}
      ${kpi(money(L.closingBalance, cur), "Closing cash")}
    </div>
    <table class="lt"><thead><tr>
      <th>When</th><th>Type</th><th>Detail</th><th class="r">In</th><th class="r">Out</th><th class="r">Balance</th>
    </tr></thead><tbody>
      <tr><td colspan="5"><b>Opening balance carried forward</b></td><td class="r bal">${money(L.openingBalance, cur)}</td></tr>
      ${rows || `<tr><td colspan="6" style="text-align:center;color:var(--muted);padding:20px">No sales activity in range</td></tr>`}
      <tr><td colspan="5"><b>Closing balance</b></td><td class="r bal">${money(L.closingBalance, cur)}</td></tr>
    </tbody></table>`;
}

function renderRecurring(S, cur, supplier, branchId, fromStr, toStr) {
  const rows = S.rows.map(r => `
    <tr>
      <td style="white-space:nowrap;color:var(--muted)">${dt(r.at)}</td>
      <td><span class="pill b">BILLING</span> ${esc(r.typeLabel)}</td>
      <td>${esc(r.entity)}<div style="font-size:11px;color:var(--muted)">${esc(r.description)} · by ${esc(r.recorder || "-")}</div></td>
      <td class="r">${r.cashIn ? `<span class="cin">+${money(r.cashIn, cur)}</span>` : ""}</td>
      <td class="r">${r.cashOut ? `<span class="cout">−${money(r.cashOut, cur)}</span>` : ""}</td>
      <td class="r bal">${money(r.cashBalance, cur)}</td>
      <td class="r ${r.entityBalance > 0 ? "cout" : "cin"}">${r.entityBalance == null ? "" : money(r.entityBalance, cur)}</td>
    </tr>`).join("");

  const rate = S.totalCharged > 0 ? Math.round((S.totalCollected / S.totalCharged) * 100) : null;
  const pdfHref = `/zq-admin/suppliers/${supplier._id}/finance-reports/recurring.pdf?branchId=${encodeURIComponent(branchId || "")}&from=${fromStr}&to=${toStr}`;

  return `
    <div class="kgrid">
      ${kpi(money(S.openingCash, cur), "Opening cash")}
      ${kpi(money(S.totalCharged, cur), "Charged")}
      ${kpi("+" + money(S.totalCollected, cur), "Collected" + (rate !== null ? ` · ${rate}%` : ""), "cin")}
      ${kpi("+" + money(S.totalOtherIncome || 0, cur), "Other income", "cin")}
      ${kpi("−" + money(S.totalExpenses, cur), "Unit expenses", "cout")}
      ${kpi(money(S.closingCash, cur), "Closing cash")}
      ${kpi(money(S.outstandingReceivables, cur), "Owed now", S.outstandingReceivables > 0 ? "cout" : "cin")}
    </div>
    <div style="margin-bottom:12px"><a class="btn btn-gray" href="${pdfHref}">⬇ Download PDF statement</a></div>
    <table class="lt"><thead><tr>
      <th>When</th><th>Type</th><th>Account / Tenant</th><th class="r">In</th><th class="r">Out</th>
      <th class="r">Cash bal</th><th class="r">A/C owes</th>
    </tr></thead><tbody>
      <tr><td colspan="5"><b>Opening cash carried forward</b></td><td class="r bal">${money(S.openingCash, cur)}</td><td></td></tr>
      ${rows || `<tr><td colspan="7" style="text-align:center;color:var(--muted);padding:20px">No recurring activity in range</td></tr>`}
      <tr><td colspan="5"><b>Closing cash</b></td><td class="r bal">${money(S.closingCash, cur)}</td><td></td></tr>
    </tbody></table>`;
}

function renderCombined(L, S, cur) {
  const salesRows = (L?.rows || []).filter(r => !r.isHandover).map(normSales);
  const billRows  = (S?.rows || []).map(normRecurring);
  const merged = [...salesRows, ...billRows].sort((a, b) => new Date(a.at) - new Date(b.at));

  const openingCombined = (L?.openingBalance || 0) + (S?.openingCash || 0);
  let bal = openingCombined;
  const rowHtml = merged.map(r => {
    bal += (r.in || 0) - (r.out || 0);
    const pill = r.stream === "SALES" ? `<span class="pill s">SALES</span>` : `<span class="pill b">BILLING</span>`;
    return `<tr>
      <td style="white-space:nowrap;color:var(--muted)">${dt(r.at)}</td>
      <td>${pill} ${esc(r.label)}</td>
      <td>${esc(r.detail)}<div style="font-size:11px;color:var(--muted)">by ${esc(r.recorder || "-")}</div></td>
      <td class="r">${r.in ? `<span class="cin">+${money(r.in, cur)}</span>` : ""}</td>
      <td class="r">${r.out ? `<span class="cout">−${money(r.out, cur)}</span>` : ""}</td>
      <td class="r bal">${money(bal, cur)}</td></tr>`;
  }).join("");

  const totIn  = merged.reduce((s, r) => s + (r.in || 0), 0);
  const totOut = merged.reduce((s, r) => s + (r.out || 0), 0);

  return `
    <div class="kgrid">
      ${kpi(money(openingCombined, cur), "Opening cash (both)")}
      ${kpi("+" + money(totIn, cur), "Total in", "cin")}
      ${kpi("−" + money(totOut, cur), "Total out", "cout")}
      ${kpi(money(bal, cur), "Closing cash (both)")}
      ${kpi(money(S?.outstandingReceivables || 0, cur), "Recurring owed", (S?.outstandingReceivables || 0) > 0 ? "cout" : "cin")}
    </div>
    <p style="font-size:12px;color:var(--muted);margin:-6px 0 14px">
      One cash position across everyday sales <span class="pill s">SALES</span> and recurring billing
      <span class="pill b">BILLING</span>. Charges raised (no cash movement) and shift handovers are
      excluded here - see the separate Recurring and Sales tabs for those.
    </p>
    <table class="lt"><thead><tr>
      <th>When</th><th>Type</th><th>Detail</th><th class="r">In</th><th class="r">Out</th><th class="r">Balance</th>
    </tr></thead><tbody>
      <tr><td colspan="5"><b>Opening balance (sales + recurring)</b></td><td class="r bal">${money(openingCombined, cur)}</td></tr>
      ${rowHtml || `<tr><td colspan="6" style="text-align:center;color:var(--muted);padding:20px">No activity in range</td></tr>`}
      <tr><td colspan="5"><b>Closing balance</b></td><td class="r bal">${money(bal, cur)}</td></tr>
    </tbody></table>`;
}

export default router;