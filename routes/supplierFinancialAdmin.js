// routes/supplierFinancialAdmin.js
// ─────────────────────────────────────────────────────────────────────────────
// Admin-side financial record management for any seller/business.
// Lets Typhon (ZQ admin) enter, edit, or delete Expenses, Cash Payouts
// (including Owner Drawings), and Cash Handovers on behalf of any clerk
// or owner, for any supplier/business. Every write recomputes that day's
// CashBalance snapshot so the Daily/Weekly/Monthly reports, the Ledger,
// and the Clerk Statement all reflect the change immediately — those
// reports already build themselves live from these same collections
// (see reportHelpers.js: buildLedger, buildClerkStatement, buildDrawingsSection,
// buildHandoverLog), so editing a record here is enough; nothing else
// needs to be touched by hand.
//
// MOUNT THIS in supplierAdmin.js with:
//   import financialAdminRoutes from "./supplierFinancialAdmin.js";
//   router.use("/suppliers/:id/finance", financialAdminRoutes);
//
// and make sure supplierAdmin.js exports `layout` and `esc`:
//   export { layout, esc };
// (added at the bottom of supplierAdmin.js — see patch notes)
// ─────────────────────────────────────────────────────────────────────────────

import express from "express";
import { requireSupplierAdmin } from "../middleware/supplierAdminAuth.js";
import SupplierProfile from "../models/supplierProfile.js";
import { layout, esc } from "./supplierAdmin.js";

const router = express.Router({ mergeParams: true });

router.use(express.json());
router.use(express.urlencoded({ extended: true }));

// ── Shared helpers ──────────────────────────────────────────────────────────

// Resolve supplier → linked Business (the financial collections key off
// businessId, not supplierId, so every route starts here).
async function loadBizContext(req) {
  const supplier = await SupplierProfile.findById(req.params.id).lean();
  if (!supplier || !supplier.businessId) return { supplier, biz: null };
  const Business = (await import("../models/business.js")).default;
  const biz = await Business.findById(supplier.businessId).lean();
  return { supplier, biz };
}

// Recompute the stored CashBalance snapshot for the day a record falls on.
// Opening balances are always derived live from full history (see
// fetchOpeningBalance in dailyReportEnhanced.js), so this alone is enough
// to keep the cached daily snapshot correct after any add/edit/delete —
// nothing else needs to be recalculated by hand.
async function recomputeDay(businessId, branchId, date) {
  try {
    const { saveClosingBalance } = await import("./dailyReportEnhanced.js");
    await saveClosingBalance({ _id: businessId }, branchId || null, new Date(date));
  } catch (e) {
    console.error("[FinanceAdmin recompute]", e.message);
  }
}

async function listBranches(businessId) {
  const Branch = (await import("../models/branch.js")).default;
  return Branch.find({ businessId }).sort({ isDefault: -1, name: 1 }).lean();
}

async function listStaff(businessId) {
  const UserRole = (await import("../models/userRole.js")).default;
  return UserRole.find({ businessId, pending: false }).lean();
}

function staffOptions(staff, selectedPhone) {
  return staff.map(s =>
    `<option value="${esc(s.phone)}" ${s.phone === selectedPhone ? "selected" : ""}>
      ${esc(s.name || s.phone)} — ${esc(s.role)}
    </option>`
  ).join("");
}

function branchOptions(branches, selectedId) {
  return [`<option value="">— No specific branch (whole business) —</option>`]
    .concat(branches.map(b =>
      `<option value="${b._id}" ${String(b._id) === String(selectedId) ? "selected" : ""}>${esc(b.name)}</option>`
    )).join("");
}

const fieldStyle = `width:100%;padding:9px 12px;border:1px solid var(--border);border-radius:7px;font-size:14px`;
function field(label, inputHtml) {
  return `<div style="margin-bottom:14px">
    <label style="font-weight:600;display:block;margin-bottom:6px">${label}</label>
    ${inputHtml}
  </div>`;
}

function backLink(supplierId) {
  return `<a href="/zq-admin/suppliers/${supplierId}/finance" style="color:var(--blue);text-decoration:none">← Back to Financial Records</a>`;
}

function alertBlock(req) {
  const err = req.query.error ? `<div class="alert red">❌ ${esc(req.query.error)}</div>` : "";
  const ok  = req.query.success ? `<div class="alert green">✅ ${esc(req.query.success)}</div>` : "";
  return err + ok;
}

const money = (n, cur = "USD") => `${cur === "ZWL" ? "Z$" : cur === "ZAR" ? "R" : "$"}${Number(n || 0).toFixed(2)}`;
const dt = d => new Date(d).toLocaleString("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });


// ═══════════════════════════════════════════════════════════════════════════
// MAIN DASHBOARD — GET /suppliers/:id/finance
// Lists recent Expenses, Payouts/Drawings, Handovers for this business,
// each with Edit/Delete actions, plus quick-add forms for all three.
// Optional ?branchId= and ?days= filters.
// ═══════════════════════════════════════════════════════════════════════════
router.get("/", requireSupplierAdmin, async (req, res) => {
  try {
    const { supplier, biz } = await loadBizContext(req);
    if (!supplier) return res.redirect("/zq-admin/suppliers");
    if (!biz) {
      return res.send(layout("Financial Records", `
        ${backLink(supplier._id).replace("finance", "")}
        <div class="alert red" style="margin-top:16px">
          This supplier has no linked Business record yet (they have not registered
          for the ZimQuote business tools), so there are no expenses, payouts, or
          handovers to manage.
        </div>`));
    }

    const Expense      = (await import("../models/expense.js")).default;
    const CashPayout   = (await import("../models/cashPayout.js")).default;
    const CashHandover = (await import("../models/cashHandover.js")).default;

    const branchId = req.query.branchId || "";
    const days     = parseInt(req.query.days, 10) || 30;
    const since    = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const branches = await listBranches(biz._id);
    const staff    = await listStaff(biz._id);

    const baseQ = { businessId: biz._id, ...(branchId ? { branchId } : {}) };

    const [expenses, payouts, handovers] = await Promise.all([
      Expense.find({ ...baseQ, createdAt: { $gte: since } }).sort({ createdAt: -1 }).limit(100).lean(),
      CashPayout.find({ ...baseQ, date: { $gte: since } }).sort({ date: -1 }).limit(100).lean(),
      CashHandover.find({ ...baseQ, handoverAt: { $gte: since } }).sort({ handoverAt: -1 }).limit(100).lean(),
    ]);

    const DRAW_RE = /draw|owner|personal|private|director/i;

    const expenseRows = expenses.map(e => `
      <tr>
        <td>${dt(e.createdAt)}</td>
        <td>${esc(e.description || "")}</td>
        <td>${esc(e.category || "")}</td>
        <td style="text-align:right;color:var(--red);font-weight:600">${money(e.amount, biz.currency)}</td>
        <td>${esc(e.createdBy || "—")}</td>
        <td style="white-space:nowrap">
          <a href="/zq-admin/suppliers/${supplier._id}/finance/expense/${e._id}/edit" class="btn btn-gray" style="padding:4px 10px;font-size:12px">Edit</a>
          <form method="POST" action="/zq-admin/suppliers/${supplier._id}/finance/expense/${e._id}/delete" style="display:inline" onsubmit="return confirm('Delete this expense? This cannot be undone.')">
            <button class="btn btn-gray" style="padding:4px 10px;font-size:12px;color:var(--red)">Delete</button>
          </form>
        </td>
      </tr>`).join("");

    const payoutRows = payouts.map(p => `
      <tr>
        <td>${dt(p.date)}</td>
        <td>${DRAW_RE.test(p.reason || "") ? '<span class="badge badge-orange">Drawing</span>' : '<span class="badge badge-blue">Payout</span>'}</td>
        <td>${esc(p.reason || "")}</td>
        <td style="text-align:right;color:var(--red);font-weight:600">${money(p.amount, biz.currency)}</td>
        <td>${esc(p.createdBy || "—")}</td>
        <td style="white-space:nowrap">
          <a href="/zq-admin/suppliers/${supplier._id}/finance/payout/${p._id}/edit" class="btn btn-gray" style="padding:4px 10px;font-size:12px">Edit</a>
          <form method="POST" action="/zq-admin/suppliers/${supplier._id}/finance/payout/${p._id}/delete" style="display:inline" onsubmit="return confirm('Delete this payout/drawing? This cannot be undone.')">
            <button class="btn btn-gray" style="padding:4px 10px;font-size:12px;color:var(--red)">Delete</button>
          </form>
        </td>
      </tr>`).join("");

    const handoverRows = handovers.map(h => `
      <tr>
        <td>${dt(h.handoverAt)}</td>
        <td>${esc(h.outgoingName || h.outgoingPhone || "")}</td>
        <td>${esc(h.incomingName || h.incomingPhone || "Owner")}</td>
        <td style="text-align:right;font-weight:600">${money(h.amountCounted, biz.currency)}</td>
        <td>${esc(h.notes || "")}</td>
        <td style="white-space:nowrap">
          <a href="/zq-admin/suppliers/${supplier._id}/finance/handover/${h._id}/edit" class="btn btn-gray" style="padding:4px 10px;font-size:12px">Edit</a>
          <form method="POST" action="/zq-admin/suppliers/${supplier._id}/finance/handover/${h._id}/delete" style="display:inline" onsubmit="return confirm('Delete this handover? This cannot be undone.')">
            <button class="btn btn-gray" style="padding:4px 10px;font-size:12px;color:var(--red)">Delete</button>
          </form>
        </td>
      </tr>`).join("");

    const todayStr = new Date().toISOString().slice(0, 10);

    res.send(layout("Financial Records", `
      <a href="/zq-admin/suppliers/${supplier._id}" class="back-link">← Back to Profile</a>
      ${alertBlock(req)}

      <div class="panel-head" style="margin-top:10px">
        <h3>💰 Financial Records — ${esc(supplier.businessName)}</h3>
        <span style="font-size:12px;color:var(--muted)">
          Admin entries on behalf of owners/clerks. Editing or deleting a record
          automatically recomputes that day's cash balance — all reports and the
          ledger pick up the change instantly.
        </span>
      </div>

      <form method="GET" style="display:flex;gap:10px;align-items:center;margin:14px 0 22px">
        <select name="branchId" style="${fieldStyle}width:auto" onchange="this.form.submit()">
          ${branchOptions(branches, branchId)}
        </select>
        <select name="days" style="${fieldStyle}width:auto" onchange="this.form.submit()">
          ${[7, 30, 90, 365].map(d => `<option value="${d}" ${d === days ? "selected" : ""}>Last ${d} days</option>`).join("")}
        </select>
      </form>

      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:16px;margin-bottom:28px">

        <div class="card">
          <h4 style="margin-bottom:12px">➕ Add Expense</h4>
          <form method="POST" action="/zq-admin/suppliers/${supplier._id}/finance/expense/add">
            ${field("Description *", `<input name="description" required style="${fieldStyle}">`)}
            ${field("Category", `<input name="category" placeholder="e.g. Stock, Rent, Transport" style="${fieldStyle}">`)}
            ${field("Amount *", `<input name="amount" type="number" step="0.01" min="0" required style="${fieldStyle}">`)}
            ${field("Date", `<input name="date" type="date" value="${todayStr}" style="${fieldStyle}">`)}
            ${field("Branch", `<select name="branchId" style="${fieldStyle}">${branchOptions(branches, branchId)}</select>`)}
            ${field("On behalf of (staff)", `<select name="createdBy" style="${fieldStyle}"><option value="admin">Admin (no specific staff)</option>${staffOptions(staff)}</select>`)}
            <button class="btn btn-blue" style="width:100%">Save Expense</button>
          </form>
        </div>

        <div class="card">
          <h4 style="margin-bottom:12px">➕ Add Payout / Drawing</h4>
          <form method="POST" action="/zq-admin/suppliers/${supplier._id}/finance/payout/add">
            ${field("Type", `<select name="kind" style="${fieldStyle}">
              <option value="payout">Cash Payout</option>
              <option value="drawing">Owner Drawing</option>
            </select>`)}
            ${field("Reason / note", `<input name="reason" placeholder="e.g. Owner drawing for personal use" style="${fieldStyle}">`)}
            ${field("Amount *", `<input name="amount" type="number" step="0.01" min="0" required style="${fieldStyle}">`)}
            ${field("Date", `<input name="date" type="date" value="${todayStr}" style="${fieldStyle}">`)}
            ${field("Branch", `<select name="branchId" style="${fieldStyle}">${branchOptions(branches, branchId)}</select>`)}
            ${field("On behalf of (staff)", `<select name="createdBy" style="${fieldStyle}"><option value="admin">Admin (no specific staff)</option>${staffOptions(staff)}</select>`)}
            <button class="btn btn-blue" style="width:100%">Save Payout</button>
          </form>
        </div>

        <div class="card">
          <h4 style="margin-bottom:12px">➕ Add Cash Handover</h4>
          <form method="POST" action="/zq-admin/suppliers/${supplier._id}/finance/handover/add">
            ${field("Outgoing staff *", `<select name="outgoingPhone" required style="${fieldStyle}"><option value="">Select…</option>${staffOptions(staff)}</select>`)}
            ${field("Incoming staff (blank = owner)", `<select name="incomingPhone" style="${fieldStyle}"><option value="">Owner / none</option>${staffOptions(staff)}</select>`)}
            ${field("Amount counted *", `<input name="amountCounted" type="number" step="0.01" min="0" required style="${fieldStyle}">`)}
            ${field("Notes", `<input name="notes" placeholder="e.g. Float discrepancy noted" style="${fieldStyle}">`)}
            ${field("Date/time", `<input name="handoverAt" type="datetime-local" value="${new Date().toISOString().slice(0,16)}" style="${fieldStyle}">`)}
            ${field("Branch", `<select name="branchId" style="${fieldStyle}">${branchOptions(branches, branchId)}</select>`)}
            <button class="btn btn-blue" style="width:100%">Save Handover</button>
          </form>
        </div>

      </div>

      <div class="panel">
        <div class="panel-head"><h3>📤 Expenses (last ${days} days)</h3></div>
        <table class="data-table">
          <thead><tr><th>Date</th><th>Description</th><th>Category</th><th style="text-align:right">Amount</th><th>By</th><th>Actions</th></tr></thead>
          <tbody>${expenseRows || `<tr><td colspan="6" style="text-align:center;color:var(--muted)">No expenses in this period</td></tr>`}</tbody>
        </table>
      </div>

      <div class="panel" style="margin-top:20px">
        <div class="panel-head"><h3>💸 Payouts &amp; Drawings (last ${days} days)</h3></div>
        <table class="data-table">
          <thead><tr><th>Date</th><th>Type</th><th>Reason</th><th style="text-align:right">Amount</th><th>By</th><th>Actions</th></tr></thead>
          <tbody>${payoutRows || `<tr><td colspan="6" style="text-align:center;color:var(--muted)">No payouts in this period</td></tr>`}</tbody>
        </table>
      </div>

      <div class="panel" style="margin-top:20px">
        <div class="panel-head"><h3>🔄 Cash Handovers (last ${days} days)</h3></div>
        <table class="data-table">
          <thead><tr><th>Date</th><th>Outgoing</th><th>Incoming</th><th style="text-align:right">Counted</th><th>Notes</th><th>Actions</th></tr></thead>
          <tbody>${handoverRows || `<tr><td colspan="6" style="text-align:center;color:var(--muted)">No handovers in this period</td></tr>`}</tbody>
        </table>
      </div>
    `));
  } catch (e) {
    res.send(layout("Error", `<div class="alert red">${esc(e.message)}</div>`));
  }
});


// ═══════════════════════════════════════════════════════════════════════════
// EXPENSES
// ═══════════════════════════════════════════════════════════════════════════
router.post("/expense/add", requireSupplierAdmin, async (req, res) => {
  try {
    const { supplier, biz } = await loadBizContext(req);
    if (!biz) return res.redirect(`/zq-admin/suppliers/${req.params.id}/finance`);
    const Expense = (await import("../models/expense.js")).default;
    const { description, category, amount, date, branchId, createdBy } = req.body;
    const d = date ? new Date(date) : new Date();

    const exp = await Expense.create({
      businessId:  biz._id,
      branchId:    branchId || null,
      amount:      parseFloat(amount) || 0,
      description: (description || "").trim(),
      category:    (category || "General").trim(),
      method:      "cash",
      createdBy:   createdBy || "admin",
      createdAt:   d
    });

    await recomputeDay(biz._id, branchId || null, d);
    res.redirect(`/zq-admin/suppliers/${supplier._id}/finance?success=Expense+added`);
  } catch (e) {
    res.redirect(`/zq-admin/suppliers/${req.params.id}/finance?error=${encodeURIComponent(e.message)}`);
  }
});

router.get("/expense/:recId/edit", requireSupplierAdmin, async (req, res) => {
  try {
    const { supplier, biz } = await loadBizContext(req);
    const Expense = (await import("../models/expense.js")).default;
    const exp = await Expense.findById(req.params.recId).lean();
    if (!exp) return res.redirect(`/zq-admin/suppliers/${supplier._id}/finance`);

    const branches = await listBranches(biz._id);
    const staff    = await listStaff(biz._id);

    res.send(layout("Edit Expense", `
      ${backLink(supplier._id)}
      <h2 style="font-size:20px;font-weight:700;margin:10px 0 20px">✏️ Edit Expense</h2>
      ${alertBlock(req)}
      <div class="card" style="max-width:600px">
        <form method="POST" action="/zq-admin/suppliers/${supplier._id}/finance/expense/${exp._id}/edit">
          ${field("Description *", `<input name="description" required value="${esc(exp.description)}" style="${fieldStyle}">`)}
          ${field("Category", `<input name="category" value="${esc(exp.category || "")}" style="${fieldStyle}">`)}
          ${field("Amount *", `<input name="amount" type="number" step="0.01" min="0" required value="${exp.amount}" style="${fieldStyle}">`)}
          ${field("Date", `<input name="date" type="date" value="${new Date(exp.createdAt).toISOString().slice(0,10)}" style="${fieldStyle}">`)}
          ${field("Branch", `<select name="branchId" style="${fieldStyle}">${branchOptions(branches, exp.branchId)}</select>`)}
          ${field("On behalf of (staff)", `<select name="createdBy" style="${fieldStyle}"><option value="admin" ${exp.createdBy === "admin" ? "selected" : ""}>Admin</option>${staffOptions(staff, exp.createdBy)}</select>`)}
          <div style="display:flex;gap:10px;margin-top:20px">
            <button class="btn btn-blue">✅ Save Changes</button>
            <a href="/zq-admin/suppliers/${supplier._id}/finance" class="btn btn-gray">Cancel</a>
          </div>
        </form>
      </div>`));
  } catch (e) {
    res.redirect(`/zq-admin/suppliers/${req.params.id}/finance?error=${encodeURIComponent(e.message)}`);
  }
});

router.post("/expense/:recId/edit", requireSupplierAdmin, async (req, res) => {
  try {
    const { supplier, biz } = await loadBizContext(req);
    const Expense = (await import("../models/expense.js")).default;
    const { description, category, amount, date, branchId, createdBy } = req.body;
    const before = await Expense.findById(req.params.recId).lean();
    if (!before) return res.redirect(`/zq-admin/suppliers/${supplier._id}/finance`);
    const d = date ? new Date(date) : before.createdAt;

    await Expense.findByIdAndUpdate(req.params.recId, {
      description: (description || "").trim(),
      category:    (category || "General").trim(),
      amount:      parseFloat(amount) || 0,
      branchId:    branchId || null,
      createdBy:   createdBy || "admin",
      createdAt:   d
    });

    // Recompute both the old date and new date, in case it was moved.
    await recomputeDay(biz._id, before.branchId, before.createdAt);
    await recomputeDay(biz._id, branchId || null, d);

    res.redirect(`/zq-admin/suppliers/${supplier._id}/finance?success=Expense+updated`);
  } catch (e) {
    res.redirect(`/zq-admin/suppliers/${req.params.id}/finance/expense/${req.params.recId}/edit?error=${encodeURIComponent(e.message)}`);
  }
});

router.post("/expense/:recId/delete", requireSupplierAdmin, async (req, res) => {
  try {
    const { supplier, biz } = await loadBizContext(req);
    const Expense = (await import("../models/expense.js")).default;
    const exp = await Expense.findByIdAndDelete(req.params.recId).lean();
    if (exp) await recomputeDay(biz._id, exp.branchId, exp.createdAt);
    res.redirect(`/zq-admin/suppliers/${supplier._id}/finance?success=Expense+deleted`);
  } catch (e) {
    res.redirect(`/zq-admin/suppliers/${req.params.id}/finance?error=${encodeURIComponent(e.message)}`);
  }
});


// ═══════════════════════════════════════════════════════════════════════════
// PAYOUTS / DRAWINGS  (CashPayout — a "drawing" is just a payout whose
// reason matches /draw|owner|personal|private|director/i, per buildDrawingsSection)
// ═══════════════════════════════════════════════════════════════════════════
router.post("/payout/add", requireSupplierAdmin, async (req, res) => {
  try {
    const { supplier, biz } = await loadBizContext(req);
    if (!biz) return res.redirect(`/zq-admin/suppliers/${req.params.id}/finance`);
    const CashPayout = (await import("../models/cashPayout.js")).default;
    const { kind, reason, amount, date, branchId, createdBy } = req.body;
    const d = date ? new Date(date) : new Date();
    const finalReason = kind === "drawing" && !/draw/i.test(reason || "")
      ? `Owner drawing: ${(reason || "").trim()}`.trim()
      : (reason || "").trim();

    const payout = await CashPayout.create({
      businessId: biz._id,
      branchId:   branchId || null,
      amount:     parseFloat(amount) || 0,
      reason:     finalReason || (kind === "drawing" ? "Owner drawing" : "Cash payout"),
      createdBy:  createdBy || "admin",
      date:       d
    });

    await recomputeDay(biz._id, branchId || null, d);
    res.redirect(`/zq-admin/suppliers/${supplier._id}/finance?success=Payout+added`);
  } catch (e) {
    res.redirect(`/zq-admin/suppliers/${req.params.id}/finance?error=${encodeURIComponent(e.message)}`);
  }
});

router.get("/payout/:recId/edit", requireSupplierAdmin, async (req, res) => {
  try {
    const { supplier, biz } = await loadBizContext(req);
    const CashPayout = (await import("../models/cashPayout.js")).default;
    const p = await CashPayout.findById(req.params.recId).lean();
    if (!p) return res.redirect(`/zq-admin/suppliers/${supplier._id}/finance`);

    const branches = await listBranches(biz._id);
    const staff    = await listStaff(biz._id);
    const isDrawing = /draw|owner|personal|private|director/i.test(p.reason || "");

    res.send(layout("Edit Payout", `
      ${backLink(supplier._id)}
      <h2 style="font-size:20px;font-weight:700;margin:10px 0 20px">✏️ Edit Payout / Drawing</h2>
      ${alertBlock(req)}
      <div class="card" style="max-width:600px">
        <form method="POST" action="/zq-admin/suppliers/${supplier._id}/finance/payout/${p._id}/edit">
          ${field("Type", `<select name="kind" style="${fieldStyle}">
            <option value="payout" ${!isDrawing ? "selected" : ""}>Cash Payout</option>
            <option value="drawing" ${isDrawing ? "selected" : ""}>Owner Drawing</option>
          </select>`)}
          ${field("Reason / note", `<input name="reason" value="${esc(p.reason || "")}" style="${fieldStyle}">`)}
          ${field("Amount *", `<input name="amount" type="number" step="0.01" min="0" required value="${p.amount}" style="${fieldStyle}">`)}
          ${field("Date", `<input name="date" type="date" value="${new Date(p.date).toISOString().slice(0,10)}" style="${fieldStyle}">`)}
          ${field("Branch", `<select name="branchId" style="${fieldStyle}">${branchOptions(branches, p.branchId)}</select>`)}
          ${field("On behalf of (staff)", `<select name="createdBy" style="${fieldStyle}"><option value="admin" ${p.createdBy === "admin" ? "selected" : ""}>Admin</option>${staffOptions(staff, p.createdBy)}</select>`)}
          <div style="display:flex;gap:10px;margin-top:20px">
            <button class="btn btn-blue">✅ Save Changes</button>
            <a href="/zq-admin/suppliers/${supplier._id}/finance" class="btn btn-gray">Cancel</a>
          </div>
        </form>
      </div>`));
  } catch (e) {
    res.redirect(`/zq-admin/suppliers/${req.params.id}/finance?error=${encodeURIComponent(e.message)}`);
  }
});

router.post("/payout/:recId/edit", requireSupplierAdmin, async (req, res) => {
  try {
    const { supplier, biz } = await loadBizContext(req);
    const CashPayout = (await import("../models/cashPayout.js")).default;
    const { kind, reason, amount, date, branchId, createdBy } = req.body;
    const before = await CashPayout.findById(req.params.recId).lean();
    if (!before) return res.redirect(`/zq-admin/suppliers/${supplier._id}/finance`);
    const d = date ? new Date(date) : before.date;
    const finalReason = kind === "drawing" && !/draw/i.test(reason || "")
      ? `Owner drawing: ${(reason || "").trim()}`.trim()
      : (reason || "").trim();

    await CashPayout.findByIdAndUpdate(req.params.recId, {
      amount:    parseFloat(amount) || 0,
      reason:    finalReason || (kind === "drawing" ? "Owner drawing" : "Cash payout"),
      branchId:  branchId || null,
      createdBy: createdBy || "admin",
      date:      d
    });

    await recomputeDay(biz._id, before.branchId, before.date);
    await recomputeDay(biz._id, branchId || null, d);

    res.redirect(`/zq-admin/suppliers/${supplier._id}/finance?success=Payout+updated`);
  } catch (e) {
    res.redirect(`/zq-admin/suppliers/${req.params.id}/finance/payout/${req.params.recId}/edit?error=${encodeURIComponent(e.message)}`);
  }
});

router.post("/payout/:recId/delete", requireSupplierAdmin, async (req, res) => {
  try {
    const { supplier, biz } = await loadBizContext(req);
    const CashPayout = (await import("../models/cashPayout.js")).default;
    const p = await CashPayout.findByIdAndDelete(req.params.recId).lean();
    if (p) await recomputeDay(biz._id, p.branchId, p.date);
    res.redirect(`/zq-admin/suppliers/${supplier._id}/finance?success=Payout+deleted`);
  } catch (e) {
    res.redirect(`/zq-admin/suppliers/${req.params.id}/finance?error=${encodeURIComponent(e.message)}`);
  }
});


// ═══════════════════════════════════════════════════════════════════════════
// CASH HANDOVERS
// ═══════════════════════════════════════════════════════════════════════════
router.post("/handover/add", requireSupplierAdmin, async (req, res) => {
  try {
    const { supplier, biz } = await loadBizContext(req);
    if (!biz) return res.redirect(`/zq-admin/suppliers/${req.params.id}/finance`);
    const CashHandover = (await import("../models/cashHandover.js")).default;
    const UserRole = (await import("../models/userRole.js")).default;
    const { outgoingPhone, incomingPhone, amountCounted, notes, handoverAt, branchId } = req.body;

    if (!outgoingPhone) {
      return res.redirect(`/zq-admin/suppliers/${supplier._id}/finance?error=Outgoing+staff+is+required`);
    }

    const [outgoing, incoming] = await Promise.all([
      UserRole.findOne({ businessId: biz._id, phone: outgoingPhone }).lean(),
      incomingPhone ? UserRole.findOne({ businessId: biz._id, phone: incomingPhone }).lean() : null
    ]);

    const d = handoverAt ? new Date(handoverAt) : new Date();
    const dayBucket = new Date(d); dayBucket.setHours(0, 0, 0, 0);

    await CashHandover.create({
      businessId:    biz._id,
      branchId:      branchId || null,
      outgoingPhone, outgoingName: outgoing?.name || outgoingPhone, outgoingRole: outgoing?.role || "clerk",
      incomingPhone: incomingPhone || null,
      incomingName:  incoming?.name || incomingPhone || "Owner",
      incomingRole:  incoming?.role || "owner",
      amountCounted: parseFloat(amountCounted) || 0,
      notes:         notes || "",
      handoverAt:    d,
      date:          dayBucket
    });

    // Handovers don't move cash in/out, so no balance recompute is required —
    // they only affect custody tracking — but we still refresh the snapshot
    // for consistency with anything that reads CashBalance.updatedAt.
    await recomputeDay(biz._id, branchId || null, d);
    res.redirect(`/zq-admin/suppliers/${supplier._id}/finance?success=Handover+added`);
  } catch (e) {
    res.redirect(`/zq-admin/suppliers/${req.params.id}/finance?error=${encodeURIComponent(e.message)}`);
  }
});

router.get("/handover/:recId/edit", requireSupplierAdmin, async (req, res) => {
  try {
    const { supplier, biz } = await loadBizContext(req);
    const CashHandover = (await import("../models/cashHandover.js")).default;
    const h = await CashHandover.findById(req.params.recId).lean();
    if (!h) return res.redirect(`/zq-admin/suppliers/${supplier._id}/finance`);

    const branches = await listBranches(biz._id);
    const staff    = await listStaff(biz._id);

    res.send(layout("Edit Handover", `
      ${backLink(supplier._id)}
      <h2 style="font-size:20px;font-weight:700;margin:10px 0 20px">✏️ Edit Cash Handover</h2>
      ${alertBlock(req)}
      <div class="card" style="max-width:600px">
        <form method="POST" action="/zq-admin/suppliers/${supplier._id}/finance/handover/${h._id}/edit">
          ${field("Outgoing staff *", `<select name="outgoingPhone" required style="${fieldStyle}">${staffOptions(staff, h.outgoingPhone)}</select>`)}
          ${field("Incoming staff (blank = owner)", `<select name="incomingPhone" style="${fieldStyle}"><option value="">Owner / none</option>${staffOptions(staff, h.incomingPhone)}</select>`)}
          ${field("Amount counted *", `<input name="amountCounted" type="number" step="0.01" min="0" required value="${h.amountCounted}" style="${fieldStyle}">`)}
          ${field("Notes", `<input name="notes" value="${esc(h.notes || "")}" style="${fieldStyle}">`)}
          ${field("Date/time", `<input name="handoverAt" type="datetime-local" value="${new Date(h.handoverAt).toISOString().slice(0,16)}" style="${fieldStyle}">`)}
          ${field("Branch", `<select name="branchId" style="${fieldStyle}">${branchOptions(branches, h.branchId)}</select>`)}
          <div style="display:flex;gap:10px;margin-top:20px">
            <button class="btn btn-blue">✅ Save Changes</button>
            <a href="/zq-admin/suppliers/${supplier._id}/finance" class="btn btn-gray">Cancel</a>
          </div>
        </form>
      </div>`));
  } catch (e) {
    res.redirect(`/zq-admin/suppliers/${req.params.id}/finance?error=${encodeURIComponent(e.message)}`);
  }
});

router.post("/handover/:recId/edit", requireSupplierAdmin, async (req, res) => {
  try {
    const { supplier, biz } = await loadBizContext(req);
    const CashHandover = (await import("../models/cashHandover.js")).default;
    const UserRole = (await import("../models/userRole.js")).default;
    const { outgoingPhone, incomingPhone, amountCounted, notes, handoverAt, branchId } = req.body;
    const before = await CashHandover.findById(req.params.recId).lean();
    if (!before) return res.redirect(`/zq-admin/suppliers/${supplier._id}/finance`);

    const [outgoing, incoming] = await Promise.all([
      UserRole.findOne({ businessId: biz._id, phone: outgoingPhone }).lean(),
      incomingPhone ? UserRole.findOne({ businessId: biz._id, phone: incomingPhone }).lean() : null
    ]);

    const d = handoverAt ? new Date(handoverAt) : before.handoverAt;
    const dayBucket = new Date(d); dayBucket.setHours(0, 0, 0, 0);

    await CashHandover.findByIdAndUpdate(req.params.recId, {
      branchId:      branchId || null,
      outgoingPhone, outgoingName: outgoing?.name || outgoingPhone, outgoingRole: outgoing?.role || "clerk",
      incomingPhone: incomingPhone || null,
      incomingName:  incoming?.name || incomingPhone || "Owner",
      incomingRole:  incoming?.role || "owner",
      amountCounted: parseFloat(amountCounted) || 0,
      notes:         notes || "",
      handoverAt:    d,
      date:          dayBucket
    });

    await recomputeDay(biz._id, before.branchId, before.handoverAt);
    await recomputeDay(biz._id, branchId || null, d);

    res.redirect(`/zq-admin/suppliers/${supplier._id}/finance?success=Handover+updated`);
  } catch (e) {
    res.redirect(`/zq-admin/suppliers/${req.params.id}/finance/handover/${req.params.recId}/edit?error=${encodeURIComponent(e.message)}`);
  }
});

router.post("/handover/:recId/delete", requireSupplierAdmin, async (req, res) => {
  try {
    const { supplier, biz } = await loadBizContext(req);
    const CashHandover = (await import("../models/cashHandover.js")).default;
    const h = await CashHandover.findByIdAndDelete(req.params.recId).lean();
    if (h) await recomputeDay(biz._id, h.branchId, h.handoverAt);
    res.redirect(`/zq-admin/suppliers/${supplier._id}/finance?success=Handover+deleted`);
  } catch (e) {
    res.redirect(`/zq-admin/suppliers/${req.params.id}/finance?error=${encodeURIComponent(e.message)}`);
  }
});

export default router;