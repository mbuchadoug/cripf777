// routes/supplierFinancialAdmin.js
// ─────────────────────────────────────────────────────────────────────────────
// "Act as clerk" financial admin workspace.
//
// Lets Typhon (ZQ admin) pick a specific staff member of a business — e.g.
// Stella — and enter Income (cash in), Expenses (cash out), Payouts,
// Owner Drawings, and Cash Handovers exactly as that person would on the
// WhatsApp chatbot, with the record attributed to them (createdBy).
// Admin can also view, edit, reverse, or delete that person's records.
//
// WHY "reverse" instead of only "delete":
// Deleting a record removes it from history entirely. Reversing keeps the
// original entry visible for audit (who entered what, and who reversed it,
// and when) but zeroes out its effect on cash totals by setting amount -> 0
// and storing the original amount separately. Existing reports
// (reportHelpers.js, dailyReportEnhanced.js) sum the amount/total field
// directly, so a reversed record naturally contributes $0 everywhere
// without needing any change to those report files. Delete is still
// available for records that should never have existed (data-entry typos).
//
// RECOMPUTE:
// Reports build themselves live from these same collections on every view
// (buildLedger, buildClerkStatement, buildDrawingsSection, buildHandoverLog
// in reportHelpers.js), so editing a record here is enough. The one cached
// value - CashBalance's daily snapshot - is refreshed via
// saveClosingBalance() after every add / edit / reverse / delete.
//
// MOUNT THIS in supplierAdmin.js with:
//   import financialAdminRoutes from "./supplierFinancialAdmin.js";
//   router.use("/suppliers/:id/finance", financialAdminRoutes);
//
// and make sure supplierAdmin.js exports `layout` and `esc`:
//   export { layout, esc };
// ─────────────────────────────────────────────────────────────────────────────

import express from "express";
import { requireSupplierAdmin } from "../middleware/supplierAdminAuth.js";
import SupplierProfile from "../models/supplierProfile.js";
import { layout, esc } from "./supplierAdmin.js";

const router = express.Router({ mergeParams: true });

router.use(express.json());
router.use(express.urlencoded({ extended: true }));

// ═══════════════════════════════════════════════════════════════════════════
// SHARED HELPERS
// ═══════════════════════════════════════════════════════════════════════════

async function loadBizContext(req) {
  const supplier = await SupplierProfile.findById(req.params.id).lean();
  if (!supplier || !supplier.businessId) return { supplier, biz: null };
  const Business = (await import("../models/business.js")).default;
  const biz = await Business.findById(supplier.businessId).lean();
  return { supplier, biz };
}

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
  return UserRole.find({ businessId, pending: false }).sort({ role: 1, name: 1 }).lean();
}

async function findStaffByPhone(businessId, phone) {
  const UserRole = (await import("../models/userRole.js")).default;
  return UserRole.findOne({ businessId, phone }).lean();
}

function branchOptions(branches, selectedId) {
  return [`<option value="">— Whole business (no specific branch) —</option>`]
    .concat(branches.map(b =>
      `<option value="${b._id}" ${String(b._id) === String(selectedId) ? "selected" : ""}>${esc(b.name)}</option>`
    )).join("");
}

const fieldStyle = `width:100%;padding:9px 12px;border:1px solid var(--border);border-radius:7px;font-size:14px`;
function field(label, inputHtml) {
  return `<div style="margin-bottom:14px">
    <label style="font-weight:600;display:block;margin-bottom:6px;font-size:13px">${label}</label>
    ${inputHtml}
  </div>`;
}

function alertBlock(req) {
  const err = req.query.error ? `<div class="alert red">❌ ${esc(req.query.error)}</div>` : "";
  const ok  = req.query.success ? `<div class="alert green">✅ ${esc(req.query.success)}</div>` : "";
  return err + ok;
}

const money = (n, cur = "USD") => `${cur === "ZWL" ? "Z$" : cur === "ZAR" ? "R" : "$"}${Number(n || 0).toFixed(2)}`;
const dt = d => new Date(d).toLocaleString("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
const roleColor = r => ({ owner: "#7c3aed", admin: "#2563eb", manager: "#0d9488", clerk: "#b45309" }[r] || "#64748b");
const initials = name => (name || "?").trim().split(/\s+/).map(w => w[0]).slice(0, 2).join("").toUpperCase();

function workspaceUrl(supplierId, phone, path = "") {
  return `/zq-admin/suppliers/${supplierId}/finance/${encodeURIComponent(phone)}${path}`;
}


// ═══════════════════════════════════════════════════════════════════════════
// 1. CLERK PICKER — GET /suppliers/:id/finance
// "Choose who you want to act as" landing page.
// ═══════════════════════════════════════════════════════════════════════════
router.get("/", requireSupplierAdmin, async (req, res) => {
  try {
    const { supplier, biz } = await loadBizContext(req);
    if (!supplier) return res.redirect("/zq-admin/suppliers");
    if (!biz) {
      return res.send(layout("Financial Records", `
        <a href="/zq-admin/suppliers/${supplier._id}" class="back-link">← Back to Profile</a>
        <div class="alert red" style="margin-top:16px">
          This supplier has no linked Business record yet (they have not registered
          for the ZimQuote business tools), so there is no staff or financial
          activity to manage.
        </div>`));
    }

    const staff    = await listStaff(biz._id);
    const branches = await listBranches(biz._id);
    const branchById = Object.fromEntries(branches.map(b => [String(b._id), b.name]));

    const cards = staff.length ? staff.map(s => `
      <a href="${workspaceUrl(supplier._id, s.phone)}" class="clerk-card">
        <div class="clerk-avatar" style="background:${roleColor(s.role)}">${esc(initials(s.name || s.phone))}</div>
        <div class="clerk-info">
          <div class="clerk-name">${esc(s.name || s.phone)}</div>
          <div class="clerk-meta">
            <span class="badge" style="background:${roleColor(s.role)}1a;color:${roleColor(s.role)}">${esc(s.role)}</span>
            ${s.branchId ? `<span style="color:var(--muted)">${esc(branchById[String(s.branchId)] || "Branch")}</span>` : `<span style="color:var(--muted)">All branches</span>`}
          </div>
          <div class="clerk-phone">${esc(s.phone)}</div>
        </div>
        <div class="clerk-arrow">→</div>
      </a>`).join("")
      : `<div class="alert" style="background:#fff7ed;color:#b45309">
          No staff registered yet for this business. Add staff first from
          <a href="/zq-admin/suppliers/${supplier._id}/staff">👥 Staff &amp; Branches</a>.
        </div>`;

    res.send(layout("Financial Records", `
      <a href="/zq-admin/suppliers/${supplier._id}" class="back-link">← Back to Profile</a>

      <div class="panel-head" style="margin-top:10px">
        <h3>💰 Financial Records — ${esc(supplier.businessName)}</h3>
        <span style="font-size:12px;color:var(--muted)">
          Choose who you want to act as. You'll enter income, expenses, payouts,
          drawings, and handovers exactly as that person would on WhatsApp —
          every record is saved under their name.
        </span>
      </div>

      <style>
        .clerk-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:14px;margin:20px 0 28px}
        .clerk-card{display:flex;align-items:center;gap:14px;background:var(--white);border:1px solid var(--border);
          border-radius:12px;padding:16px;text-decoration:none;color:var(--text);transition:box-shadow .15s,transform .15s}
        .clerk-card:hover{box-shadow:0 4px 14px rgba(0,0,0,.08);transform:translateY(-1px);border-color:#cbd5e1}
        .clerk-avatar{width:44px;height:44px;border-radius:50%;color:white;font-weight:700;font-size:15px;
          display:flex;align-items:center;justify-content:center;flex-shrink:0}
        .clerk-info{flex:1;min-width:0}
        .clerk-name{font-weight:700;font-size:14.5px;margin-bottom:3px}
        .clerk-meta{display:flex;gap:8px;align-items:center;font-size:12px;margin-bottom:3px}
        .clerk-meta .badge{padding:2px 8px;border-radius:20px;font-weight:600;text-transform:capitalize}
        .clerk-phone{font-size:11.5px;color:var(--muted)}
        .clerk-arrow{color:var(--muted);font-size:18px}
      </style>

      <div class="clerk-grid">${cards}</div>

      <div style="margin-top:8px">
        <a href="/zq-admin/suppliers/${supplier._id}/finance/all" style="font-size:13px;color:var(--blue);text-decoration:none">
          🏢 View combined records for the whole business (all staff) →
        </a>
      </div>
    `));
  } catch (e) {
    res.send(layout("Error", `<div class="alert red">${esc(e.message)}</div>`));
  }
});


// ═══════════════════════════════════════════════════════════════════════════
// 7. COMBINED BUSINESS-WIDE VIEW (every clerk together) — read-only-ish list
// Kept so nothing from the previous version is lost; reachable from the
// clerk picker via "View combined records for the whole business".
// ═══════════════════════════════════════════════════════════════════════════
router.get("/all", requireSupplierAdmin, async (req, res) => {
  try {
    const { supplier, biz } = await loadBizContext(req);
    if (!biz) return res.redirect(`/zq-admin/suppliers/${req.params.id}/finance`);

    const Expense      = (await import("../models/expense.js")).default;
    const CashPayout   = (await import("../models/cashPayout.js")).default;
    const CashHandover = (await import("../models/cashHandover.js")).default;
    const CashIncome   = (await import("../models/cashIncome.js")).default;

    const branchId = req.query.branchId || "";
    const days     = parseInt(req.query.days, 10) || 30;
    const since    = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const branches = await listBranches(biz._id);
    const baseQ = { businessId: biz._id, ...(branchId ? { branchId } : {}) };

    const [incomes, expenses, payouts, handovers] = await Promise.all([
      CashIncome.find({ ...baseQ, createdAt: { $gte: since } }).sort({ createdAt: -1 }).limit(150).lean(),
      Expense.find({ ...baseQ, createdAt: { $gte: since } }).sort({ createdAt: -1 }).limit(150).lean(),
      CashPayout.find({ ...baseQ, date: { $gte: since } }).sort({ date: -1 }).limit(150).lean(),
      CashHandover.find({ ...baseQ, handoverAt: { $gte: since } }).sort({ handoverAt: -1 }).limit(150).lean(),
    ]);

    const DRAW_RE = /draw|owner|personal|private|director/i;
    const rows = [];
    incomes.forEach(r => rows.push({ icon: "💵", label: "Income", date: r.createdAt, amount: r.amount, sign: 1, desc: r.description, by: r.createdBy, reversed: r.reversed }));
    expenses.forEach(r => rows.push({ icon: "💸", label: "Expense", date: r.createdAt, amount: r.amount, sign: -1, desc: r.description, by: r.createdBy, reversed: r.reversed }));
    payouts.forEach(r => rows.push({ icon: DRAW_RE.test(r.reason || "") ? "👑" : "🏧", label: DRAW_RE.test(r.reason || "") ? "Drawing" : "Payout", date: r.date, amount: r.amount, sign: -1, desc: r.reason, by: r.createdBy, reversed: r.reversed }));
    handovers.forEach(r => rows.push({ icon: "🔄", label: "Handover", date: r.handoverAt, amount: r.amountCounted, sign: 0, desc: `${r.outgoingName || r.outgoingPhone} → ${r.incomingName || r.incomingPhone || "Owner"}`, by: r.outgoingPhone, reversed: r.reversed }));
    rows.sort((a, b) => new Date(b.date) - new Date(a.date));

    const rowHtml = rows.map(r => `<tr>
      <td style="white-space:nowrap;font-size:12.5px;color:var(--muted)">${dt(r.date)}</td>
      <td>${r.icon} ${esc(r.label)}${r.reversed ? ' <span class="badge badge-gray">REVERSED</span>' : ""}</td>
      <td style="font-size:13px;color:var(--muted)">${esc(r.desc || "")}</td>
      <td style="text-align:right">${r.sign === 0 ? money(r.amount, biz.currency) : `<span style="color:${r.sign > 0 ? "var(--green)" : "var(--red)"};font-weight:700">${r.sign > 0 ? "+" : "−"}${money(r.amount, biz.currency)}</span>`}</td>
      <td>${r.by ? `<a href="${workspaceUrl(supplier._id, r.by)}" style="color:var(--blue);text-decoration:none">${esc(r.by)}</a>` : "—"}</td>
    </tr>`).join("");

    res.send(layout("All Financial Records", `
      <a href="/zq-admin/suppliers/${supplier._id}/finance" class="back-link">← Back to Clerk Picker</a>
      <div class="panel-head" style="margin-top:10px"><h3>🏢 All Records — ${esc(supplier.businessName)}</h3></div>

      <form method="GET" style="display:flex;gap:10px;align-items:center;margin:14px 0 22px">
        <select name="branchId" style="${fieldStyle}width:auto" onchange="this.form.submit()">${branchOptions(branches, branchId)}</select>
        <select name="days" style="${fieldStyle}width:auto" onchange="this.form.submit()">${[7, 30, 90, 365].map(d => `<option value="${d}" ${d === days ? "selected" : ""}>Last ${d} days</option>`).join("")}</select>
      </form>

      <div class="panel">
        <table class="data-table">
          <thead><tr><th>When</th><th>Type</th><th>Detail</th><th style="text-align:right">Amount</th><th>Recorded for</th></tr></thead>
          <tbody>${rowHtml || `<tr><td colspan="5" style="text-align:center;color:var(--muted)">No activity in this period</td></tr>`}</tbody>
        </table>
      </div>
    `));
  } catch (e) {
    res.send(layout("Error", `<div class="alert red">${esc(e.message)}</div>`));
  }
});


// ═══════════════════════════════════════════════════════════════════════════
// 2. PER-CLERK WORKSPACE — GET /suppliers/:id/finance/:phone
// Big quick-action buttons + that person's records, editable inline.
// ═══════════════════════════════════════════════════════════════════════════
router.get("/:phone", requireSupplierAdmin, async (req, res) => {
  try {
    const { supplier, biz } = await loadBizContext(req);
    if (!biz) return res.redirect(`/zq-admin/suppliers/${req.params.id}/finance`);
    const phone = req.params.phone;
    const person = await findStaffByPhone(biz._id, phone);
    if (!person) return res.redirect(`/zq-admin/suppliers/${supplier._id}/finance?error=Staff+member+not+found`);

    const branches = await listBranches(biz._id);
    const staff    = await listStaff(biz._id);
    const days     = parseInt(req.query.days, 10) || 30;
    const since    = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const Expense      = (await import("../models/expense.js")).default;
    const CashPayout   = (await import("../models/cashPayout.js")).default;
    const CashHandover = (await import("../models/cashHandover.js")).default;
    const CashIncome   = (await import("../models/cashIncome.js")).default;

    const baseQ = { businessId: biz._id, createdAt: { $gte: since } };

    const [incomes, expenses, payouts, handoversOut, handoversIn] = await Promise.all([
      CashIncome.find({ ...baseQ, createdBy: phone }).lean(),
      Expense.find({ ...baseQ, createdBy: phone }).lean(),
      CashPayout.find({ businessId: biz._id, date: { $gte: since }, createdBy: phone }).lean(),
      CashHandover.find({ businessId: biz._id, handoverAt: { $gte: since }, outgoingPhone: phone }).lean(),
      CashHandover.find({ businessId: biz._id, handoverAt: { $gte: since }, incomingPhone: phone }).lean(),
    ]);

    const DRAW_RE = /draw|owner|personal|private|director/i;

    const rows = [];
    incomes.forEach(r => rows.push({ type: "income", icon: "💵", label: "Income", date: r.createdAt, amount: r.amount, sign: 1, desc: r.description || r.category, rec: r }));
    expenses.forEach(r => rows.push({ type: "expense", icon: "💸", label: "Expense", date: r.createdAt, amount: r.amount, sign: -1, desc: `${r.description || ""}${r.category ? ` (${r.category})` : ""}`, rec: r }));
    payouts.forEach(r => rows.push({ type: "payout", icon: DRAW_RE.test(r.reason || "") ? "👑" : "🏧", label: DRAW_RE.test(r.reason || "") ? "Owner Drawing" : "Payout", date: r.date, amount: r.amount, sign: -1, desc: r.reason || "", rec: r }));
    handoversOut.forEach(r => rows.push({ type: "handover", icon: "📤", label: `Handed to ${r.incomingName || r.incomingPhone || "Owner"}`, date: r.handoverAt, amount: r.amountCounted, sign: 0, desc: r.notes || "", rec: r }));
    handoversIn.forEach(r => rows.push({ type: "handover", icon: "📥", label: `Received from ${r.outgoingName || r.outgoingPhone}`, date: r.handoverAt, amount: r.amountCounted, sign: 0, desc: r.notes || "", rec: r }));
    rows.sort((a, b) => new Date(b.date) - new Date(a.date));

    const totalIn  = incomes.filter(r => !r.reversed).reduce((s, r) => s + r.amount, 0);
    const totalOut = expenses.filter(r => !r.reversed).reduce((s, r) => s + r.amount, 0)
                   + payouts.filter(r => !r.reversed).reduce((s, r) => s + r.amount, 0);

    const rowHtml = rows.map(r => {
      const amountStr = r.sign === 0
        ? `<span style="color:var(--text);font-weight:600">${money(r.amount, biz.currency)}</span>`
        : `<span style="color:${r.sign > 0 ? "var(--green)" : "var(--red)"};font-weight:700">${r.sign > 0 ? "+" : "−"}${money(r.amount, biz.currency)}</span>`;
      const reversedTag = r.rec.reversed
        ? `<span class="badge badge-gray" style="margin-left:6px">REVERSED${r.rec.originalAmount ? ` · was ${money(r.rec.originalAmount, biz.currency)}` : ""}</span>` : "";
      const editUrl    = workspaceUrl(supplier._id, phone, `/${r.type}/${r.rec._id}/edit`);
      const reverseUrl = workspaceUrl(supplier._id, phone, `/${r.type}/${r.rec._id}/reverse`);
      const deleteUrl  = workspaceUrl(supplier._id, phone, `/${r.type}/${r.rec._id}/delete`);
      const canReverse = r.type !== "handover" && !r.rec.reversed;

      return `<tr>
        <td style="white-space:nowrap;font-size:12.5px;color:var(--muted)">${dt(r.date)}</td>
        <td>${r.icon} ${esc(r.label)}${reversedTag}</td>
        <td style="font-size:13px;color:var(--muted)">${esc(r.desc)}</td>
        <td style="text-align:right">${amountStr}</td>
        <td style="white-space:nowrap">
          <a href="${editUrl}" class="btn btn-gray" style="padding:4px 9px;font-size:12px">Edit</a>
          ${canReverse ? `<form method="POST" action="${reverseUrl}" style="display:inline" onsubmit="return confirm('Reverse this ${r.type}? It stays visible for audit but no longer affects totals.')"><button class="btn btn-gray" style="padding:4px 9px;font-size:12px;color:#b45309">Reverse</button></form>` : ""}
          <form method="POST" action="${deleteUrl}" style="display:inline" onsubmit="return confirm('Permanently delete this ${r.type}? This cannot be undone.')"><button class="btn btn-gray" style="padding:4px 9px;font-size:12px;color:var(--red)">Delete</button></form>
        </td>
      </tr>`;
    }).join("");

    const todayStr = new Date().toISOString().slice(0, 10);
    const nowLocal  = new Date().toISOString().slice(0, 16);

    res.send(layout(`Acting as ${person.name || phone}`, `
      <a href="/zq-admin/suppliers/${supplier._id}/finance" class="back-link">← Choose a different staff member</a>
      ${alertBlock(req)}

      <style>
        .persona-bar{display:flex;align-items:center;gap:14px;background:var(--white);border:1px solid var(--border);
          border-radius:12px;padding:16px 18px;margin:14px 0 22px}
        .persona-avatar{width:50px;height:50px;border-radius:50%;color:white;font-weight:700;font-size:17px;
          display:flex;align-items:center;justify-content:center;flex-shrink:0}
        .quick-actions{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-bottom:24px}
        .qa-btn{border:none;border-radius:10px;padding:14px 10px;font-size:13px;font-weight:600;color:white;
          cursor:pointer;text-align:center;line-height:1.3}
        .qa-btn .qa-icon{font-size:20px;display:block;margin-bottom:4px}
        .qa-panel{display:none;background:var(--white);border:1px solid var(--border);border-radius:12px;
          padding:20px;margin-bottom:24px;max-width:520px}
        .qa-panel.open{display:block}
        .stat-row{display:grid;grid-template-columns:1fr 1fr 1fr;gap:14px;margin-bottom:22px}
      </style>

      <div class="persona-bar">
        <div class="persona-avatar" style="background:${roleColor(person.role)}">${esc(initials(person.name || phone))}</div>
        <div style="flex:1">
          <div style="font-weight:700;font-size:16px">Acting as ${esc(person.name || phone)}</div>
          <div style="font-size:12.5px;color:var(--muted)">
            <span class="badge" style="background:${roleColor(person.role)}1a;color:${roleColor(person.role)};padding:2px 8px;border-radius:20px;font-weight:600;text-transform:capitalize">${esc(person.role)}</span>
            &nbsp;•&nbsp; ${esc(phone)}
          </div>
        </div>
        <form method="GET" style="margin:0">
          <select name="days" style="${fieldStyle}width:auto" onchange="this.form.submit()">
            ${[7, 30, 90, 365].map(d => `<option value="${d}" ${d === days ? "selected" : ""}>Last ${d} days</option>`).join("")}
          </select>
        </form>
      </div>

      <div class="stat-row">
        <div class="stat-card stat-green"><div class="stat-val">${money(totalIn, biz.currency)}</div><div class="stat-lbl">Income recorded (${days}d)</div></div>
        <div class="stat-card stat-red"><div class="stat-val">${money(totalOut, biz.currency)}</div><div class="stat-lbl">Out (expenses + payouts)</div></div>
        <div class="stat-card"><div class="stat-val">${money(totalIn - totalOut, biz.currency)}</div><div class="stat-lbl">Net for this person</div></div>
      </div>

      <div class="quick-actions">
        <button class="qa-btn" style="background:var(--green)" onclick="toggle('income')"><span class="qa-icon">💵</span>Cash In / Income</button>
        <button class="qa-btn" style="background:var(--red)" onclick="toggle('expense')"><span class="qa-icon">💸</span>Cash Out / Expense</button>
        <button class="qa-btn" style="background:#b45309" onclick="toggle('payout')"><span class="qa-icon">🏧</span>Payout</button>
        <button class="qa-btn" style="background:#7c3aed" onclick="toggle('drawing')"><span class="qa-icon">👑</span>Owner Drawing</button>
        <button class="qa-btn" style="background:var(--blue)" onclick="toggle('handover')"><span class="qa-icon">🔄</span>Cash Handover</button>
      </div>

      <div id="panel-income" class="qa-panel">
        <h4 style="margin-bottom:14px">💵 Record Income / Cash In — as ${esc(person.name || phone)}</h4>
        <form method="POST" action="${workspaceUrl(supplier._id, phone, "/income/add")}">
          ${field("Amount received *", `<input name="amount" type="number" step="0.01" min="0" required style="${fieldStyle}">`)}
          ${field("What was it for?", `<input name="description" placeholder="e.g. Cash sale - 2x bags cement" style="${fieldStyle}">`)}
          ${field("Category", `<select name="category" style="${fieldStyle}"><option>Sale</option><option>Other Income</option><option>Refund Received</option></select>`)}
          ${field("Date", `<input name="date" type="date" value="${todayStr}" style="${fieldStyle}">`)}
          ${field("Branch", `<select name="branchId" style="${fieldStyle}">${branchOptions(branches, person.branchId)}</select>`)}
          <button class="btn btn-blue" style="width:100%">Save Income</button>
        </form>
      </div>

      <div id="panel-expense" class="qa-panel">
        <h4 style="margin-bottom:14px">💸 Record Expense / Cash Out — as ${esc(person.name || phone)}</h4>
        <form method="POST" action="${workspaceUrl(supplier._id, phone, "/expense/add")}">
          ${field("Description *", `<input name="description" required style="${fieldStyle}">`)}
          ${field("Category", `<input name="category" placeholder="e.g. Stock, Rent, Transport" style="${fieldStyle}">`)}
          ${field("Amount *", `<input name="amount" type="number" step="0.01" min="0" required style="${fieldStyle}">`)}
          ${field("Date", `<input name="date" type="date" value="${todayStr}" style="${fieldStyle}">`)}
          ${field("Branch", `<select name="branchId" style="${fieldStyle}">${branchOptions(branches, person.branchId)}</select>`)}
          <button class="btn btn-blue" style="width:100%">Save Expense</button>
        </form>
      </div>

      <div id="panel-payout" class="qa-panel">
        <h4 style="margin-bottom:14px">🏧 Record Cash Payout — as ${esc(person.name || phone)}</h4>
        <form method="POST" action="${workspaceUrl(supplier._id, phone, "/payout/add")}">
          <input type="hidden" name="kind" value="payout">
          ${field("Reason *", `<input name="reason" required placeholder="e.g. Paid delivery driver cash" style="${fieldStyle}">`)}
          ${field("Amount *", `<input name="amount" type="number" step="0.01" min="0" required style="${fieldStyle}">`)}
          ${field("Date", `<input name="date" type="date" value="${todayStr}" style="${fieldStyle}">`)}
          ${field("Branch", `<select name="branchId" style="${fieldStyle}">${branchOptions(branches, person.branchId)}</select>`)}
          <button class="btn btn-blue" style="width:100%">Save Payout</button>
        </form>
      </div>

      <div id="panel-drawing" class="qa-panel">
        <h4 style="margin-bottom:14px">👑 Record Owner Drawing — as ${esc(person.name || phone)}</h4>
        <form method="POST" action="${workspaceUrl(supplier._id, phone, "/payout/add")}">
          <input type="hidden" name="kind" value="drawing">
          ${field("Note", `<input name="reason" placeholder="e.g. Personal withdrawal" style="${fieldStyle}">`)}
          ${field("Amount *", `<input name="amount" type="number" step="0.01" min="0" required style="${fieldStyle}">`)}
          ${field("Date", `<input name="date" type="date" value="${todayStr}" style="${fieldStyle}">`)}
          ${field("Branch", `<select name="branchId" style="${fieldStyle}">${branchOptions(branches, person.branchId)}</select>`)}
          <button class="btn btn-blue" style="width:100%">Save Drawing</button>
        </form>
      </div>

      <div id="panel-handover" class="qa-panel">
        <h4 style="margin-bottom:14px">🔄 Record Cash Handover — involving ${esc(person.name || phone)}</h4>
        <form method="POST" action="${workspaceUrl(supplier._id, phone, "/handover/add")}">
          ${field("Direction *", `<select name="direction" style="${fieldStyle}">
            <option value="out">${esc(person.name || phone)} hands cash to someone else</option>
            <option value="in">${esc(person.name || phone)} receives cash from someone else</option>
          </select>`)}
          ${field("Other person (blank = Owner)", `<select name="otherPhone" style="${fieldStyle}"><option value="">Owner / none</option>${staff.filter(s => s.phone !== phone).map(s => `<option value="${esc(s.phone)}">${esc(s.name || s.phone)} — ${esc(s.role)}</option>`).join("")}</select>`)}
          ${field("Amount counted *", `<input name="amountCounted" type="number" step="0.01" min="0" required style="${fieldStyle}">`)}
          ${field("Notes", `<input name="notes" placeholder="e.g. Float discrepancy noted" style="${fieldStyle}">`)}
          ${field("Date/time", `<input name="handoverAt" type="datetime-local" value="${nowLocal}" style="${fieldStyle}">`)}
          ${field("Branch", `<select name="branchId" style="${fieldStyle}">${branchOptions(branches, person.branchId)}</select>`)}
          <button class="btn btn-blue" style="width:100%">Save Handover</button>
        </form>
      </div>

      <div class="panel">
        <div class="panel-head"><h3>📋 Activity — ${esc(person.name || phone)} (last ${days} days)</h3></div>
        <table class="data-table">
          <thead><tr><th>When</th><th>Type</th><th>Detail</th><th style="text-align:right">Amount</th><th>Actions</th></tr></thead>
          <tbody>${rowHtml || `<tr><td colspan="5" style="text-align:center;color:var(--muted)">No activity recorded for ${esc(person.name || phone)} in this period</td></tr>`}</tbody>
        </table>
      </div>

      <script>
        function toggle(name) {
          document.querySelectorAll('.qa-panel').forEach(function(p) {
            p.classList.toggle('open', p.id === 'panel-' + name && !p.classList.contains('open'));
          });
          var el = document.getElementById('panel-' + name);
          if (el && el.classList.contains('open')) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      </script>
    `));
  } catch (e) {
    res.send(layout("Error", `<div class="alert red">${esc(e.message)}</div>`));
  }
});


// ═══════════════════════════════════════════════════════════════════════════
// 3. INCOME — add / edit / reverse / delete
// ═══════════════════════════════════════════════════════════════════════════
router.post("/:phone/income/add", requireSupplierAdmin, async (req, res) => {
  const phone = req.params.phone;
  try {
    const { supplier, biz } = await loadBizContext(req);
    const CashIncome = (await import("../models/cashIncome.js")).default;
    const { amount, description, category, date, branchId } = req.body;
    const d = date ? new Date(date) : new Date();

    await CashIncome.create({
      businessId: biz._id, branchId: branchId || null,
      amount: parseFloat(amount) || 0,
      description: (description || "").trim(),
      category: category || "Sale",
      createdBy: phone, createdAt: d
    });

    await recomputeDay(biz._id, branchId || null, d);
    res.redirect(`${workspaceUrl(supplier._id, phone)}?success=Income+recorded`);
  } catch (e) {
    res.redirect(`${workspaceUrl(req.params.id, phone)}?error=${encodeURIComponent(e.message)}`);
  }
});

router.get("/:phone/income/:recId/edit", requireSupplierAdmin, async (req, res) => {
  const phone = req.params.phone;
  try {
    const { supplier, biz } = await loadBizContext(req);
    const CashIncome = (await import("../models/cashIncome.js")).default;
    const rec = await CashIncome.findById(req.params.recId).lean();
    if (!rec) return res.redirect(workspaceUrl(supplier._id, phone));
    const branches = await listBranches(biz._id);

    res.send(layout("Edit Income", `
      <a href="${workspaceUrl(supplier._id, phone)}" class="back-link">← Back</a>
      <h2 style="font-size:20px;font-weight:700;margin:10px 0 20px">✏️ Edit Income</h2>
      ${alertBlock(req)}
      <div class="card" style="max-width:520px">
        <form method="POST" action="${workspaceUrl(supplier._id, phone, `/income/${rec._id}/edit`)}">
          ${field("Amount *", `<input name="amount" type="number" step="0.01" min="0" required value="${rec.amount}" style="${fieldStyle}">`)}
          ${field("Description", `<input name="description" value="${esc(rec.description || "")}" style="${fieldStyle}">`)}
          ${field("Category", `<select name="category" style="${fieldStyle}">${["Sale", "Other Income", "Refund Received"].map(c => `<option ${rec.category === c ? "selected" : ""}>${c}</option>`).join("")}</select>`)}
          ${field("Date", `<input name="date" type="date" value="${new Date(rec.createdAt).toISOString().slice(0,10)}" style="${fieldStyle}">`)}
          ${field("Branch", `<select name="branchId" style="${fieldStyle}">${branchOptions(branches, rec.branchId)}</select>`)}
          <div style="display:flex;gap:10px;margin-top:20px">
            <button class="btn btn-blue">✅ Save Changes</button>
            <a href="${workspaceUrl(supplier._id, phone)}" class="btn btn-gray">Cancel</a>
          </div>
        </form>
      </div>`));
  } catch (e) {
    res.redirect(`${workspaceUrl(req.params.id, phone)}?error=${encodeURIComponent(e.message)}`);
  }
});

router.post("/:phone/income/:recId/edit", requireSupplierAdmin, async (req, res) => {
  const phone = req.params.phone;
  try {
    const { supplier, biz } = await loadBizContext(req);
    const CashIncome = (await import("../models/cashIncome.js")).default;
    const before = await CashIncome.findById(req.params.recId).lean();
    if (!before) return res.redirect(workspaceUrl(supplier._id, phone));
    const { amount, description, category, date, branchId } = req.body;
    const d = date ? new Date(date) : before.createdAt;

    await CashIncome.findByIdAndUpdate(req.params.recId, {
      amount: parseFloat(amount) || 0,
      description: (description || "").trim(),
      category: category || "Sale",
      branchId: branchId || null,
      createdAt: d
    });

    await recomputeDay(biz._id, before.branchId, before.createdAt);
    await recomputeDay(biz._id, branchId || null, d);
    res.redirect(`${workspaceUrl(supplier._id, phone)}?success=Income+updated`);
  } catch (e) {
    res.redirect(`${workspaceUrl(req.params.id, phone, `/income/${req.params.recId}/edit`)}?error=${encodeURIComponent(e.message)}`);
  }
});

router.post("/:phone/income/:recId/reverse", requireSupplierAdmin, async (req, res) => {
  const phone = req.params.phone;
  try {
    const { supplier, biz } = await loadBizContext(req);
    const CashIncome = (await import("../models/cashIncome.js")).default;
    const rec = await CashIncome.findById(req.params.recId).lean();
    if (!rec) return res.redirect(workspaceUrl(supplier._id, phone));
    await CashIncome.findByIdAndUpdate(req.params.recId, {
      reversed: true, originalAmount: rec.amount, amount: 0,
      reversedAt: new Date(), reversedBy: "admin"
    });
    await recomputeDay(biz._id, rec.branchId, rec.createdAt);
    res.redirect(`${workspaceUrl(supplier._id, phone)}?success=Income+reversed`);
  } catch (e) {
    res.redirect(`${workspaceUrl(req.params.id, phone)}?error=${encodeURIComponent(e.message)}`);
  }
});

router.post("/:phone/income/:recId/delete", requireSupplierAdmin, async (req, res) => {
  const phone = req.params.phone;
  try {
    const { supplier, biz } = await loadBizContext(req);
    const CashIncome = (await import("../models/cashIncome.js")).default;
    const rec = await CashIncome.findByIdAndDelete(req.params.recId).lean();
    if (rec) await recomputeDay(biz._id, rec.branchId, rec.createdAt);
    res.redirect(`${workspaceUrl(supplier._id, phone)}?success=Income+deleted`);
  } catch (e) {
    res.redirect(`${workspaceUrl(req.params.id, phone)}?error=${encodeURIComponent(e.message)}`);
  }
});


// ═══════════════════════════════════════════════════════════════════════════
// 4. EXPENSE — add / edit / reverse / delete
// ═══════════════════════════════════════════════════════════════════════════
router.post("/:phone/expense/add", requireSupplierAdmin, async (req, res) => {
  const phone = req.params.phone;
  try {
    const { supplier, biz } = await loadBizContext(req);
    const Expense = (await import("../models/expense.js")).default;
    const { description, category, amount, date, branchId } = req.body;
    const d = date ? new Date(date) : new Date();

    await Expense.create({
      businessId: biz._id, branchId: branchId || null,
      amount: parseFloat(amount) || 0,
      description: (description || "").trim(),
      category: (category || "General").trim(),
      method: "cash", createdBy: phone, createdAt: d
    });

    await recomputeDay(biz._id, branchId || null, d);
    res.redirect(`${workspaceUrl(supplier._id, phone)}?success=Expense+recorded`);
  } catch (e) {
    res.redirect(`${workspaceUrl(req.params.id, phone)}?error=${encodeURIComponent(e.message)}`);
  }
});

router.get("/:phone/expense/:recId/edit", requireSupplierAdmin, async (req, res) => {
  const phone = req.params.phone;
  try {
    const { supplier, biz } = await loadBizContext(req);
    const Expense = (await import("../models/expense.js")).default;
    const exp = await Expense.findById(req.params.recId).lean();
    if (!exp) return res.redirect(workspaceUrl(supplier._id, phone));
    const branches = await listBranches(biz._id);

    res.send(layout("Edit Expense", `
      <a href="${workspaceUrl(supplier._id, phone)}" class="back-link">← Back</a>
      <h2 style="font-size:20px;font-weight:700;margin:10px 0 20px">✏️ Edit Expense</h2>
      ${alertBlock(req)}
      <div class="card" style="max-width:520px">
        <form method="POST" action="${workspaceUrl(supplier._id, phone, `/expense/${exp._id}/edit`)}">
          ${field("Description *", `<input name="description" required value="${esc(exp.description || "")}" style="${fieldStyle}">`)}
          ${field("Category", `<input name="category" value="${esc(exp.category || "")}" style="${fieldStyle}">`)}
          ${field("Amount *", `<input name="amount" type="number" step="0.01" min="0" required value="${exp.amount}" style="${fieldStyle}">`)}
          ${field("Date", `<input name="date" type="date" value="${new Date(exp.createdAt).toISOString().slice(0,10)}" style="${fieldStyle}">`)}
          ${field("Branch", `<select name="branchId" style="${fieldStyle}">${branchOptions(branches, exp.branchId)}</select>`)}
          <div style="display:flex;gap:10px;margin-top:20px">
            <button class="btn btn-blue">✅ Save Changes</button>
            <a href="${workspaceUrl(supplier._id, phone)}" class="btn btn-gray">Cancel</a>
          </div>
        </form>
      </div>`));
  } catch (e) {
    res.redirect(`${workspaceUrl(req.params.id, phone)}?error=${encodeURIComponent(e.message)}`);
  }
});

router.post("/:phone/expense/:recId/edit", requireSupplierAdmin, async (req, res) => {
  const phone = req.params.phone;
  try {
    const { supplier, biz } = await loadBizContext(req);
    const Expense = (await import("../models/expense.js")).default;
    const before = await Expense.findById(req.params.recId).lean();
    if (!before) return res.redirect(workspaceUrl(supplier._id, phone));
    const { description, category, amount, date, branchId } = req.body;
    const d = date ? new Date(date) : before.createdAt;

    await Expense.findByIdAndUpdate(req.params.recId, {
      description: (description || "").trim(),
      category: (category || "General").trim(),
      amount: parseFloat(amount) || 0,
      branchId: branchId || null,
      createdAt: d
    });

    await recomputeDay(biz._id, before.branchId, before.createdAt);
    await recomputeDay(biz._id, branchId || null, d);
    res.redirect(`${workspaceUrl(supplier._id, phone)}?success=Expense+updated`);
  } catch (e) {
    res.redirect(`${workspaceUrl(req.params.id, phone, `/expense/${req.params.recId}/edit`)}?error=${encodeURIComponent(e.message)}`);
  }
});

router.post("/:phone/expense/:recId/reverse", requireSupplierAdmin, async (req, res) => {
  const phone = req.params.phone;
  try {
    const { supplier, biz } = await loadBizContext(req);
    const Expense = (await import("../models/expense.js")).default;
    const rec = await Expense.findById(req.params.recId).lean();
    if (!rec) return res.redirect(workspaceUrl(supplier._id, phone));
    await Expense.findByIdAndUpdate(req.params.recId, {
      reversed: true, originalAmount: rec.amount, amount: 0,
      reversedAt: new Date(), reversedBy: "admin"
    });
    await recomputeDay(biz._id, rec.branchId, rec.createdAt);
    res.redirect(`${workspaceUrl(supplier._id, phone)}?success=Expense+reversed`);
  } catch (e) {
    res.redirect(`${workspaceUrl(req.params.id, phone)}?error=${encodeURIComponent(e.message)}`);
  }
});

router.post("/:phone/expense/:recId/delete", requireSupplierAdmin, async (req, res) => {
  const phone = req.params.phone;
  try {
    const { supplier, biz } = await loadBizContext(req);
    const Expense = (await import("../models/expense.js")).default;
    const rec = await Expense.findByIdAndDelete(req.params.recId).lean();
    if (rec) await recomputeDay(biz._id, rec.branchId, rec.createdAt);
    res.redirect(`${workspaceUrl(supplier._id, phone)}?success=Expense+deleted`);
  } catch (e) {
    res.redirect(`${workspaceUrl(req.params.id, phone)}?error=${encodeURIComponent(e.message)}`);
  }
});


// ═══════════════════════════════════════════════════════════════════════════
// 5. PAYOUT / DRAWING — add / edit / reverse / delete
// ═══════════════════════════════════════════════════════════════════════════
router.post("/:phone/payout/add", requireSupplierAdmin, async (req, res) => {
  const phone = req.params.phone;
  try {
    const { supplier, biz } = await loadBizContext(req);
    const CashPayout = (await import("../models/cashPayout.js")).default;
    const { kind, reason, amount, date, branchId } = req.body;
    const d = date ? new Date(date) : new Date();
    const finalReason = kind === "drawing" && !/draw/i.test(reason || "")
      ? `Owner drawing${reason ? ": " + reason.trim() : ""}` : (reason || "").trim();

    await CashPayout.create({
      businessId: biz._id, branchId: branchId || null,
      amount: parseFloat(amount) || 0,
      reason: finalReason || (kind === "drawing" ? "Owner drawing" : "Cash payout"),
      createdBy: phone, date: d
    });

    await recomputeDay(biz._id, branchId || null, d);
    res.redirect(`${workspaceUrl(supplier._id, phone)}?success=${kind === "drawing" ? "Drawing" : "Payout"}+recorded`);
  } catch (e) {
    res.redirect(`${workspaceUrl(req.params.id, phone)}?error=${encodeURIComponent(e.message)}`);
  }
});

router.get("/:phone/payout/:recId/edit", requireSupplierAdmin, async (req, res) => {
  const phone = req.params.phone;
  try {
    const { supplier, biz } = await loadBizContext(req);
    const CashPayout = (await import("../models/cashPayout.js")).default;
    const p = await CashPayout.findById(req.params.recId).lean();
    if (!p) return res.redirect(workspaceUrl(supplier._id, phone));
    const branches = await listBranches(biz._id);
    const isDrawing = /draw|owner|personal|private|director/i.test(p.reason || "");

    res.send(layout("Edit Payout", `
      <a href="${workspaceUrl(supplier._id, phone)}" class="back-link">← Back</a>
      <h2 style="font-size:20px;font-weight:700;margin:10px 0 20px">✏️ Edit Payout / Drawing</h2>
      ${alertBlock(req)}
      <div class="card" style="max-width:520px">
        <form method="POST" action="${workspaceUrl(supplier._id, phone, `/payout/${p._id}/edit`)}">
          ${field("Type", `<select name="kind" style="${fieldStyle}">
            <option value="payout" ${!isDrawing ? "selected" : ""}>Cash Payout</option>
            <option value="drawing" ${isDrawing ? "selected" : ""}>Owner Drawing</option>
          </select>`)}
          ${field("Reason", `<input name="reason" value="${esc(p.reason || "")}" style="${fieldStyle}">`)}
          ${field("Amount *", `<input name="amount" type="number" step="0.01" min="0" required value="${p.amount}" style="${fieldStyle}">`)}
          ${field("Date", `<input name="date" type="date" value="${new Date(p.date).toISOString().slice(0,10)}" style="${fieldStyle}">`)}
          ${field("Branch", `<select name="branchId" style="${fieldStyle}">${branchOptions(branches, p.branchId)}</select>`)}
          <div style="display:flex;gap:10px;margin-top:20px">
            <button class="btn btn-blue">✅ Save Changes</button>
            <a href="${workspaceUrl(supplier._id, phone)}" class="btn btn-gray">Cancel</a>
          </div>
        </form>
      </div>`));
  } catch (e) {
    res.redirect(`${workspaceUrl(req.params.id, phone)}?error=${encodeURIComponent(e.message)}`);
  }
});

router.post("/:phone/payout/:recId/edit", requireSupplierAdmin, async (req, res) => {
  const phone = req.params.phone;
  try {
    const { supplier, biz } = await loadBizContext(req);
    const CashPayout = (await import("../models/cashPayout.js")).default;
    const before = await CashPayout.findById(req.params.recId).lean();
    if (!before) return res.redirect(workspaceUrl(supplier._id, phone));
    const { kind, reason, amount, date, branchId } = req.body;
    const d = date ? new Date(date) : before.date;
    const finalReason = kind === "drawing" && !/draw/i.test(reason || "")
      ? `Owner drawing${reason ? ": " + reason.trim() : ""}` : (reason || "").trim();

    await CashPayout.findByIdAndUpdate(req.params.recId, {
      amount: parseFloat(amount) || 0,
      reason: finalReason || (kind === "drawing" ? "Owner drawing" : "Cash payout"),
      branchId: branchId || null, date: d
    });

    await recomputeDay(biz._id, before.branchId, before.date);
    await recomputeDay(biz._id, branchId || null, d);
    res.redirect(`${workspaceUrl(supplier._id, phone)}?success=Payout+updated`);
  } catch (e) {
    res.redirect(`${workspaceUrl(req.params.id, phone, `/payout/${req.params.recId}/edit`)}?error=${encodeURIComponent(e.message)}`);
  }
});

router.post("/:phone/payout/:recId/reverse", requireSupplierAdmin, async (req, res) => {
  const phone = req.params.phone;
  try {
    const { supplier, biz } = await loadBizContext(req);
    const CashPayout = (await import("../models/cashPayout.js")).default;
    const rec = await CashPayout.findById(req.params.recId).lean();
    if (!rec) return res.redirect(workspaceUrl(supplier._id, phone));
    await CashPayout.findByIdAndUpdate(req.params.recId, {
      reversed: true, originalAmount: rec.amount, amount: 0,
      reversedAt: new Date(), reversedBy: "admin"
    });
    await recomputeDay(biz._id, rec.branchId, rec.date);
    res.redirect(`${workspaceUrl(supplier._id, phone)}?success=Payout+reversed`);
  } catch (e) {
    res.redirect(`${workspaceUrl(req.params.id, phone)}?error=${encodeURIComponent(e.message)}`);
  }
});

router.post("/:phone/payout/:recId/delete", requireSupplierAdmin, async (req, res) => {
  const phone = req.params.phone;
  try {
    const { supplier, biz } = await loadBizContext(req);
    const CashPayout = (await import("../models/cashPayout.js")).default;
    const rec = await CashPayout.findByIdAndDelete(req.params.recId).lean();
    if (rec) await recomputeDay(biz._id, rec.branchId, rec.date);
    res.redirect(`${workspaceUrl(supplier._id, phone)}?success=Payout+deleted`);
  } catch (e) {
    res.redirect(`${workspaceUrl(req.params.id, phone)}?error=${encodeURIComponent(e.message)}`);
  }
});


// ═══════════════════════════════════════════════════════════════════════════
// 6. CASH HANDOVER — add / edit / reverse / delete
// (audit-only reversal — handovers don't move cash in/out, only custody)
// ═══════════════════════════════════════════════════════════════════════════
router.post("/:phone/handover/add", requireSupplierAdmin, async (req, res) => {
  const phone = req.params.phone;
  try {
    const { supplier, biz } = await loadBizContext(req);
    const CashHandover = (await import("../models/cashHandover.js")).default;
    const { direction, otherPhone, amountCounted, notes, handoverAt, branchId } = req.body;
    const person = await findStaffByPhone(biz._id, phone);
    const other  = otherPhone ? await findStaffByPhone(biz._id, otherPhone) : null;

    const outgoingPhone = direction === "in" ? (otherPhone || null) : phone;
    const incomingPhone = direction === "in" ? phone : (otherPhone || null);
    const outgoing = direction === "in" ? other : person;
    const incoming = direction === "in" ? person : other;

    const d = handoverAt ? new Date(handoverAt) : new Date();
    const dayBucket = new Date(d); dayBucket.setHours(0, 0, 0, 0);

    await CashHandover.create({
      businessId: biz._id, branchId: branchId || null,
      outgoingPhone, outgoingName: outgoing?.name || outgoingPhone || "Owner", outgoingRole: outgoing?.role || "owner",
      incomingPhone, incomingName: incoming?.name || incomingPhone || "Owner", incomingRole: incoming?.role || "owner",
      amountCounted: parseFloat(amountCounted) || 0,
      notes: notes || "", handoverAt: d, date: dayBucket
    });

    await recomputeDay(biz._id, branchId || null, d);
    res.redirect(`${workspaceUrl(supplier._id, phone)}?success=Handover+recorded`);
  } catch (e) {
    res.redirect(`${workspaceUrl(req.params.id, phone)}?error=${encodeURIComponent(e.message)}`);
  }
});

router.get("/:phone/handover/:recId/edit", requireSupplierAdmin, async (req, res) => {
  const phone = req.params.phone;
  try {
    const { supplier, biz } = await loadBizContext(req);
    const CashHandover = (await import("../models/cashHandover.js")).default;
    const h = await CashHandover.findById(req.params.recId).lean();
    if (!h) return res.redirect(workspaceUrl(supplier._id, phone));
    const branches = await listBranches(biz._id);
    const staff    = await listStaff(biz._id);

    res.send(layout("Edit Handover", `
      <a href="${workspaceUrl(supplier._id, phone)}" class="back-link">← Back</a>
      <h2 style="font-size:20px;font-weight:700;margin:10px 0 20px">✏️ Edit Cash Handover</h2>
      ${alertBlock(req)}
      <div class="card" style="max-width:520px">
        <form method="POST" action="${workspaceUrl(supplier._id, phone, `/handover/${h._id}/edit`)}">
          ${field("Outgoing (handed over from)", `<select name="outgoingPhone" style="${fieldStyle}"><option value="">Owner / none</option>${staff.map(s => `<option value="${esc(s.phone)}" ${s.phone === h.outgoingPhone ? "selected" : ""}>${esc(s.name || s.phone)}</option>`).join("")}</select>`)}
          ${field("Incoming (received by)", `<select name="incomingPhone" style="${fieldStyle}"><option value="">Owner / none</option>${staff.map(s => `<option value="${esc(s.phone)}" ${s.phone === h.incomingPhone ? "selected" : ""}>${esc(s.name || s.phone)}</option>`).join("")}</select>`)}
          ${field("Amount counted *", `<input name="amountCounted" type="number" step="0.01" min="0" required value="${h.amountCounted}" style="${fieldStyle}">`)}
          ${field("Notes", `<input name="notes" value="${esc(h.notes || "")}" style="${fieldStyle}">`)}
          ${field("Date/time", `<input name="handoverAt" type="datetime-local" value="${new Date(h.handoverAt).toISOString().slice(0,16)}" style="${fieldStyle}">`)}
          ${field("Branch", `<select name="branchId" style="${fieldStyle}">${branchOptions(branches, h.branchId)}</select>`)}
          <div style="display:flex;gap:10px;margin-top:20px">
            <button class="btn btn-blue">✅ Save Changes</button>
            <a href="${workspaceUrl(supplier._id, phone)}" class="btn btn-gray">Cancel</a>
          </div>
        </form>
      </div>`));
  } catch (e) {
    res.redirect(`${workspaceUrl(req.params.id, phone)}?error=${encodeURIComponent(e.message)}`);
  }
});

router.post("/:phone/handover/:recId/edit", requireSupplierAdmin, async (req, res) => {
  const phone = req.params.phone;
  try {
    const { supplier, biz } = await loadBizContext(req);
    const CashHandover = (await import("../models/cashHandover.js")).default;
    const before = await CashHandover.findById(req.params.recId).lean();
    if (!before) return res.redirect(workspaceUrl(supplier._id, phone));
    const { outgoingPhone, incomingPhone, amountCounted, notes, handoverAt, branchId } = req.body;
    const outgoing = outgoingPhone ? await findStaffByPhone(biz._id, outgoingPhone) : null;
    const incoming = incomingPhone ? await findStaffByPhone(biz._id, incomingPhone) : null;
    const d = handoverAt ? new Date(handoverAt) : before.handoverAt;
    const dayBucket = new Date(d); dayBucket.setHours(0, 0, 0, 0);

    await CashHandover.findByIdAndUpdate(req.params.recId, {
      branchId: branchId || null,
      outgoingPhone: outgoingPhone || null, outgoingName: outgoing?.name || outgoingPhone || "Owner", outgoingRole: outgoing?.role || "owner",
      incomingPhone: incomingPhone || null, incomingName: incoming?.name || incomingPhone || "Owner", incomingRole: incoming?.role || "owner",
      amountCounted: parseFloat(amountCounted) || 0,
      notes: notes || "", handoverAt: d, date: dayBucket
    });

    await recomputeDay(biz._id, before.branchId, before.handoverAt);
    await recomputeDay(biz._id, branchId || null, d);
    res.redirect(`${workspaceUrl(supplier._id, phone)}?success=Handover+updated`);
  } catch (e) {
    res.redirect(`${workspaceUrl(req.params.id, phone, `/handover/${req.params.recId}/edit`)}?error=${encodeURIComponent(e.message)}`);
  }
});

router.post("/:phone/handover/:recId/reverse", requireSupplierAdmin, async (req, res) => {
  const phone = req.params.phone;
  try {
    const { supplier } = await loadBizContext(req);
    const CashHandover = (await import("../models/cashHandover.js")).default;
    await CashHandover.findByIdAndUpdate(req.params.recId, { reversed: true, reversedAt: new Date(), reversedBy: "admin" });
    res.redirect(`${workspaceUrl(supplier._id, phone)}?success=Handover+marked+reversed`);
  } catch (e) {
    res.redirect(`${workspaceUrl(req.params.id, phone)}?error=${encodeURIComponent(e.message)}`);
  }
});

router.post("/:phone/handover/:recId/delete", requireSupplierAdmin, async (req, res) => {
  const phone = req.params.phone;
  try {
    const { supplier } = await loadBizContext(req);
    const CashHandover = (await import("../models/cashHandover.js")).default;
    await CashHandover.findByIdAndDelete(req.params.recId);
    res.redirect(`${workspaceUrl(supplier._id, phone)}?success=Handover+deleted`);
  } catch (e) {
    res.redirect(`${workspaceUrl(req.params.id, phone)}?error=${encodeURIComponent(e.message)}`);
  }
});



export default router;