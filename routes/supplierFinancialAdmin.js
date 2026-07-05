// routes/supplierFinancialAdmin.js
// ─────────────────────────────────────────────────────────────────────────────
// "Act as clerk" financial admin workspace.
//
// Lets Typhon (ZQ admin) pick a specific staff member of a business - e.g.
// Stella - and enter/view/edit/reverse/delete Income (cash in), Expenses
// (cash out), Payouts, Owner Drawings, and Cash Handovers exactly as that
// person would on the WhatsApp chatbot.
//
// ── THE ROOT CAUSE OF THE MISSING INCOME BUG ─────────────────────────────────
// Clerks record income on WhatsApp as Invoice (type="receipt") and
// InvoicePayment documents, NOT as CashIncome. The previous version of this
// file only queried CashIncome - a new model that no WhatsApp flow ever
// writes to - so the clerk's sales/income was always missing here, even
// though it appeared correctly in chatbot reports (which query Invoice +
// InvoicePayment). CashIncome is still supported as a parallel model for
// records entered directly through this admin workspace, so admin entries
// don't pollute the formal document numbering sequence.
//
// ── HOW INCOME IS NOW QUERIED ────────────────────────────────────────────────
// For display (view): Invoice (type=receipt) + InvoicePayment + CashIncome
// For add via admin:  CashIncome only (keeps Invoice numbering clean)
// For balance calc:   all three (matches reportHelpers.js exactly)
//
// ── RECOMPUTE ────────────────────────────────────────────────────────────────
// Every write calls saveClosingBalance() for the affected day (and old day
// if date was changed). Reports (reportHelpers.js buildLedger,
// buildClerkStatement, etc.) read live from the collections, so they pick
// up the change immediately.
//
// MOUNT in supplierAdmin.js:
//   import financialAdminRoutes from "./supplierFinancialAdmin.js";
//   router.use("/suppliers/:id/finance", financialAdminRoutes);
//
// supplierAdmin.js must also export layout and esc:
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

// Resolve a clientId to a display name (for invoice/payment rows)
async function resolveClient(clientId) {
  if (!clientId) return "Walk-in";
  try {
    const Client = (await import("../models/client.js")).default;
    const c = await Client.findById(clientId).lean();
    return c?.name || c?.phone || "Walk-in";
  } catch (_) { return "Walk-in"; }
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
    <label style="font-weight:600;display:block;margin-bottom:6px;font-size:13px">${label}</label>
    ${inputHtml}
  </div>`;
}

function alertBlock(req) {
  const err = req.query.error   ? `<div class="alert red">❌ ${esc(req.query.error)}</div>`     : "";
  const ok  = req.query.success ? `<div class="alert green">✅ ${esc(req.query.success)}</div>` : "";
  return err + ok;
}

const money = (n, cur = "USD") => `${cur === "ZWL" ? "Z$" : cur === "ZAR" ? "R" : "$"}${Number(n || 0).toFixed(2)}`;
const dt    = d => new Date(d).toLocaleString("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
const roleColor = r => ({ owner: "#7c3aed", admin: "#2563eb", manager: "#0d9488", clerk: "#b45309" }[r] || "#64748b");
const initials  = name => (name || "?").trim().split(/\s+/).map(w => w[0]).slice(0, 2).join("").toUpperCase();
const DRAW_RE   = /draw|owner|personal|private|director/i;

function workspaceUrl(supplierId, phone, path = "") {
  return `/zq-admin/suppliers/${supplierId}/finance/${encodeURIComponent(phone)}${path}`;
}

// ── Fetch ALL income rows for a clerk across all three sources ─────────────
// Returns an array of normalised income display rows ready for the activity
// feed. Mirrors exactly what buildClerkStatement in reportHelpers.js queries.
async function fetchClerkIncome(biz, phone, since) {
  const Invoice        = (await import("../models/invoice.js")).default;
  const InvoicePayment = (await import("../models/invoicePayment.js")).default;
  const CashIncome     = (await import("../models/cashIncome.js")).default;

  const dateQ = { $gte: since };
  const bizQ  = { businessId: biz._id };

  const [receipts, payments, adminIncome] = await Promise.all([
    // Cash sales (receipts) created by clerk on WhatsApp
    Invoice.find({ ...bizQ, type: "receipt", createdBy: phone, createdAt: dateQ }).lean(),
    // Invoice payments recorded by clerk on WhatsApp
    InvoicePayment.find({ ...bizQ, createdBy: phone, createdAt: dateQ }).lean(),
    // Manual income entered via this admin workspace on clerk's behalf
    CashIncome.find({ ...bizQ, createdBy: phone, createdAt: dateQ }).lean(),
  ]);

  const rows = [];

  // Receipts (cash sales)
  for (const r of receipts) {
    const items = (r.items || []).slice(0, 2).map(i => i.item || i.name || "Item").join(", ");
    rows.push({
      _id: r._id, type: "receipt", icon: "🧾",
      label: `Cash Sale${r.number ? " · " + r.number : ""}`,
      date: r.createdAt, amount: r.total || 0, sign: 1,
      desc: items || "Receipt",
      rec: r, editable: false, deletable: true, reversible: false  // delete only (sequential numbering)
    });
  }

  // Invoice payments
  for (const p of payments) {
    let label = "Invoice Payment";
    if (p.invoiceId) {
      try {
        const Invoice = (await import("../models/invoice.js")).default;
        const inv = await Invoice.findById(p.invoiceId).lean();
        if (inv) {
          const clientName = await resolveClient(inv.clientId);
          label = `Inv Payment · ${inv.number}${clientName !== "Walk-in" ? " – " + clientName : ""}`;
        }
      } catch (_) {}
    }
    rows.push({
      _id: p._id, type: "invoicepayment", icon: "💳",
      label, date: p.createdAt, amount: p.amount || 0, sign: 1,
      desc: p.method ? `via ${p.method}` : "",
      rec: p, editable: false, deletable: true, reversible: false  // delete only (invoice balance auto-recalculates)
    });
  }

  // Manual admin income (CashIncome)
  for (const r of adminIncome) {
    rows.push({
      _id: r._id, type: "income", icon: "💵",
      label: r.category || "Income",
      date: r.createdAt, amount: r.amount || 0, sign: 1,
      desc: r.description || "",
      rec: r, editable: true, reversible: !r.reversed,
      reversed: r.reversed, originalAmount: r.originalAmount
    });
  }

  return rows;
}

// ── Fetch RECURRING BILLING rows for a clerk (payments IN + unit expenses OUT)
// ── THE ROOT CAUSE OF "RECURRING RECORDS NOT SHOWING" ────────────────────────
// Rent/fee collections and unit expenses recorded on the WhatsApp chatbot are
// written to RecurringPayment / RecurringExpense (createdBy = clerk phone) -
// models this file never queried, so they were invisible here even though the
// clerk demonstrably held that cash. This helper surfaces them with the
// account + tenant name and the tenant's current outstanding balance, exactly
// matching what the clerk statement report now shows.
//
// NOTE: RecurringPayment/RecurringExpense use `date` (not createdAt) and have
// NO branchId - branch context lives on the parent RecurringAccount.
// Deleting a payment must also recompute the linked invoice + cached
// account/tenant balances - the delete routes below use the same service
// functions (recomputeInvoiceFromPayments etc.) the chatbot flows rely on.
async function fetchClerkRecurring(biz, phone, since) {
  try {
    const RecurringPayment = (await import("../models/recurringPayment.js")).default;
    const RecurringExpense = (await import("../models/recurringExpense.js")).default;
    const RecurringAccount = (await import("../models/recurringAccount.js")).default;
    const RecurringTenant  = (await import("../models/recurringTenant.js")).default;

    const q = { businessId: biz._id, createdBy: phone, date: { $gte: since } };
    const [payments, expenses] = await Promise.all([
      RecurringPayment.find(q).lean(),
      RecurringExpense.find(q).lean()
    ]);
    if (!payments.length && !expenses.length) return [];

    // Batch-resolve names (no N+1)
    const acctIds   = [...new Set([...payments, ...expenses].map(r => String(r.accountId)).filter(Boolean))];
    const tenantIds = [...new Set(payments.map(p => p.tenantId && String(p.tenantId)).filter(Boolean))];
    const [accts, tenants] = await Promise.all([
      acctIds.length   ? RecurringAccount.find({ _id: { $in: acctIds } }).select("name ref currentBalance").lean() : [],
      tenantIds.length ? RecurringTenant.find({ _id: { $in: tenantIds } }).select("name currentBalance").lean()   : []
    ]);
    const acctMap   = Object.fromEntries(accts.map(x => [String(x._id), x]));
    const tenantMap = Object.fromEntries(tenants.map(x => [String(x._id), x]));

    const rows = [];
    for (const p of payments) {
      const acct   = acctMap[String(p.accountId)];
      const tenant = p.tenantId ? tenantMap[String(p.tenantId)] : null;
      const owing  = tenant ? (tenant.currentBalance || 0) : (acct?.currentBalance || 0);
      rows.push({
        _id: p._id, type: "rbpayment", icon: "🏠",
        label: `Billing Payment${tenant ? " · " + tenant.name : ""}`,
        date: p.date || p.createdAt, amount: p.amount || 0, sign: 1,
        desc: `${acct?.name || "Account"}${acct?.ref ? " (" + acct.ref + ")" : ""} · ${p.method || "cash"}${p.reference ? " · " + p.reference : ""} · owing ${owing.toFixed(2)}`,
        rec: p, editable: false, deletable: true, reversible: false, reversed: false
      });
    }
    for (const e of expenses) {
      const acct = acctMap[String(e.accountId)];
      rows.push({
        _id: e._id, type: "rbexpense", icon: "🔧",
        label: `Unit Expense${e.category ? " · " + e.category : ""}`,
        date: e.date || e.createdAt, amount: e.amount || 0, sign: -1,
        desc: `${acct?.name || "Account"}${acct?.ref ? " (" + acct.ref + ")" : ""} · ${e.description || ""}`,
        rec: e, editable: false, deletable: true, reversible: false, reversed: false
      });
    }
    return rows;
  } catch (_) { return []; }
}


// ═══════════════════════════════════════════════════════════════════════════
// 1. COMBINED BUSINESS-WIDE VIEW  - GET /suppliers/:id/finance/all
// Must be registered BEFORE /:phone to avoid route collision.
// ═══════════════════════════════════════════════════════════════════════════
router.get("/all", requireSupplierAdmin, async (req, res) => {
  try {
    const { supplier, biz } = await loadBizContext(req);
    if (!biz) return res.redirect(`/zq-admin/suppliers/${req.params.id}/finance`);

    const Invoice        = (await import("../models/invoice.js")).default;
    const InvoicePayment = (await import("../models/invoicePayment.js")).default;
    const Expense        = (await import("../models/expense.js")).default;
    const CashPayout     = (await import("../models/cashPayout.js")).default;
    const CashHandover   = (await import("../models/cashHandover.js")).default;
    const CashIncome     = (await import("../models/cashIncome.js")).default;

    const branchId = req.query.branchId || "";
    const days     = parseInt(req.query.days, 10) || 30;
    const since    = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const branches = await listBranches(biz._id);
    const staff    = await listStaff(biz._id);
    const staffMap = Object.fromEntries(staff.map(s => [s.phone, s.name || s.phone]));

    const bQ = { businessId: biz._id, ...(branchId ? { branchId } : {}) };

    // Recurring billing models: no branchId (branch lives on the parent
    // account) and they use `date`, not createdAt. Loaded with the rest and
    // name-resolved in one batch so rent collections finally appear here.
    const RecurringPayment = (await import("../models/recurringPayment.js")).default;
    const RecurringExpense = (await import("../models/recurringExpense.js")).default;
    const RecurringAccount = (await import("../models/recurringAccount.js")).default;
    const RecurringTenant  = (await import("../models/recurringTenant.js")).default;

    const [receipts, payments, adminIncome, expenses, payouts, handovers, rbPayments, rbExpenses] = await Promise.all([
      Invoice.find({ ...bQ, type: "receipt", createdAt: { $gte: since } }).sort({ createdAt: -1 }).limit(100).lean(),
      InvoicePayment.find({ ...bQ, createdAt: { $gte: since } }).sort({ createdAt: -1 }).limit(100).lean(),
      CashIncome.find({ ...bQ, createdAt: { $gte: since } }).sort({ createdAt: -1 }).limit(50).lean(),
      Expense.find({ ...bQ, createdAt: { $gte: since } }).sort({ createdAt: -1 }).limit(100).lean(),
      CashPayout.find({ ...bQ, date: { $gte: since } }).sort({ date: -1 }).limit(100).lean(),
      CashHandover.find({ ...bQ, handoverAt: { $gte: since } }).sort({ handoverAt: -1 }).limit(100).lean(),
      RecurringPayment.find({ businessId: biz._id, date: { $gte: since } }).sort({ date: -1 }).limit(100).lean().catch(() => []),
      RecurringExpense.find({ businessId: biz._id, date: { $gte: since } }).sort({ date: -1 }).limit(100).lean().catch(() => []),
    ]);

    // Batch-resolve recurring account/tenant names
    const rbAcctIds   = [...new Set([...rbPayments, ...rbExpenses].map(r => String(r.accountId)).filter(Boolean))];
    const rbTenantIds = [...new Set(rbPayments.map(p => p.tenantId && String(p.tenantId)).filter(Boolean))];
    const [rbAccts, rbTenants] = await Promise.all([
      rbAcctIds.length   ? RecurringAccount.find({ _id: { $in: rbAcctIds } }).select("name ref branchId").lean() : [],
      rbTenantIds.length ? RecurringTenant.find({ _id: { $in: rbTenantIds } }).select("name").lean()             : []
    ]);
    const rbAcctMap   = Object.fromEntries(rbAccts.map(x => [String(x._id), x]));
    const rbTenantMap = Object.fromEntries(rbTenants.map(x => [String(x._id), x]));
    // Branch filter (recurring rows are branch-scoped via their parent account)
    const rbBranchOk = r => !branchId || String(rbAcctMap[String(r.accountId)]?.branchId || "") === String(branchId);

    const rows = [];
    receipts.forEach(r => rows.push({ icon: "🧾", label: "Cash Sale", date: r.createdAt, amount: r.total || 0, sign: 1, desc: r.number || "", by: r.createdBy, reversed: false }));
    payments.forEach(r => rows.push({ icon: "💳", label: "Inv Payment", date: r.createdAt, amount: r.amount || 0, sign: 1, desc: r.method || "", by: r.createdBy, reversed: false }));
    rbPayments.filter(rbBranchOk).forEach(r => {
      const acct = rbAcctMap[String(r.accountId)]; const ten = r.tenantId ? rbTenantMap[String(r.tenantId)] : null;
      rows.push({ icon: "🏠", label: "Billing Payment", date: r.date, amount: r.amount || 0, sign: 1, desc: `${acct?.name || "Account"}${ten ? " – " + ten.name : ""} · ${r.method || "cash"}`, by: r.createdBy, reversed: false });
    });
    rbExpenses.filter(rbBranchOk).forEach(r => {
      const acct = rbAcctMap[String(r.accountId)];
      rows.push({ icon: "🔧", label: "Unit Expense", date: r.date, amount: r.amount || 0, sign: -1, desc: `${acct?.name || "Account"} · ${r.description || r.category || ""}`, by: r.createdBy, reversed: false });
    });
    adminIncome.forEach(r => rows.push({ icon: "💵", label: r.category || "Income", date: r.createdAt, amount: r.amount || 0, sign: 1, desc: r.description || "", by: r.createdBy, reversed: r.reversed }));
    expenses.forEach(r => rows.push({ icon: "💸", label: "Expense", date: r.createdAt, amount: r.amount || 0, sign: -1, desc: r.description || r.category || "", by: r.createdBy, reversed: r.reversed }));
    payouts.forEach(r => rows.push({ icon: DRAW_RE.test(r.reason || "") ? "👑" : "🏧", label: DRAW_RE.test(r.reason || "") ? "Drawing" : "Payout", date: r.date, amount: r.amount || 0, sign: -1, desc: `${r.reason || ""}${r.paidToName ? " → " + r.paidToName : ""}`, by: r.createdBy || r.recordedBy, reversed: r.reversed }));
    handovers.forEach(r => rows.push({ icon: "🔄", label: "Handover", date: r.handoverAt, amount: r.amountCounted || 0, sign: 0, desc: `${r.outgoingName || r.outgoingPhone} → ${r.incomingName || r.incomingPhone || "Owner"}`, by: r.outgoingPhone, reversed: r.reversed }));
    rows.sort((a, b) => new Date(b.date) - new Date(a.date));

    const rowHtml = rows.map(r => `<tr>
      <td style="white-space:nowrap;font-size:12.5px;color:var(--muted)">${dt(r.date)}</td>
      <td>${r.icon} ${esc(r.label)}${r.reversed ? ' <span class="badge badge-gray">REVERSED</span>' : ""}</td>
      <td style="font-size:13px;color:var(--muted)">${esc(r.desc || "")}</td>
      <td style="text-align:right">${r.sign === 0
        ? money(r.amount, biz.currency)
        : `<span style="color:${r.sign > 0 ? "var(--green)" : "var(--red)"};font-weight:700">${r.sign > 0 ? "+" : "−"}${money(r.amount, biz.currency)}</span>`
      }</td>
      <td>${r.by ? `<a href="${workspaceUrl(supplier._id, r.by)}" style="color:var(--blue);text-decoration:none">${esc(staffMap[r.by] || r.by)}</a>` : "-"}</td>
    </tr>`).join("");

    res.send(layout("All Financial Records", `
      <a href="/zq-admin/suppliers/${supplier._id}/finance" class="back-link">← Back to Clerk Picker</a>
      <div class="panel-head" style="margin-top:10px"><h3>🏢 All Records - ${esc(supplier.businessName)}</h3></div>

      <form method="GET" style="display:flex;gap:10px;align-items:center;margin:14px 0 22px">
        <select name="branchId" style="${fs}width:auto" onchange="this.form.submit()">${branchOptions(branches, branchId)}</select>
        <select name="days" style="${fs}width:auto" onchange="this.form.submit()">${[7, 30, 90, 365].map(d => `<option value="${d}" ${d === days ? "selected" : ""}>Last ${d} days</option>`).join("")}</select>
      </form>

      <div class="panel">
        <table class="data-table">
          <thead><tr><th>When</th><th>Type</th><th>Detail</th><th style="text-align:right">Amount</th><th>Recorded by</th></tr></thead>
          <tbody>${rowHtml || `<tr><td colspan="5" style="text-align:center;color:var(--muted)">No activity in this period</td></tr>`}</tbody>
        </table>
      </div>
    `));
  } catch (e) {
    res.send(layout("Error", `<div class="alert red">${esc(e.message)}</div>`));
  }
});


// ═══════════════════════════════════════════════════════════════════════════
// 2. CLERK PICKER - GET /suppliers/:id/finance
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
          No staff registered yet. Add staff first from
          <a href="/zq-admin/suppliers/${supplier._id}/staff">👥 Staff &amp; Branches</a>.
        </div>`;

    res.send(layout("Financial Records", `
      <a href="/zq-admin/suppliers/${supplier._id}" class="back-link">← Back to Profile</a>

      <div class="panel-head" style="margin-top:10px">
        <h3>💰 Financial Records - ${esc(supplier.businessName)}</h3>
        <span style="font-size:12px;color:var(--muted)">
          Choose who you want to act as. All sales, income, expenses, payouts,
          drawings and handovers recorded under that person on WhatsApp are
          shown - and you can add or correct records on their behalf.
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
// 3. PER-CLERK WORKSPACE - GET /suppliers/:id/finance/:phone
// Shows ALL income sources (receipts + invoice payments + admin income)
// plus expenses, payouts, handovers. Add forms for everything.
// ═══════════════════════════════════════════════════════════════════════════
router.get("/:phone", requireSupplierAdmin, async (req, res) => {
  try {
    const { supplier, biz } = await loadBizContext(req);
    if (!biz) return res.redirect(`/zq-admin/suppliers/${req.params.id}/finance`);
    const phone  = req.params.phone;
    const person = await findStaffByPhone(biz._id, phone);
    if (!person) return res.redirect(`/zq-admin/suppliers/${supplier._id}/finance?error=Staff+member+not+found`);

    const branches = await listBranches(biz._id);
    const staff    = await listStaff(biz._id);
    const days     = parseInt(req.query.days, 10) || 30;
    const since    = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const Expense      = (await import("../models/expense.js")).default;
    const CashPayout   = (await import("../models/cashPayout.js")).default;
    const CashHandover = (await import("../models/cashHandover.js")).default;

    const baseQ = { businessId: biz._id, createdAt: { $gte: since } };

    // ── Fetch all data in parallel ───────────────────────────────────────────
    const [incomeRows, recurringRows, expenses, payouts, payoutsReceived, handoversOut, handoversIn] = await Promise.all([
      fetchClerkIncome(biz, phone, since),
      fetchClerkRecurring(biz, phone, since),
      Expense.find({ ...baseQ, createdBy: phone }).lean(),
      // $or createdBy/recordedBy: the WhatsApp flow historically wrote
      // recordedBy (discarded by the old schema → createdBy null), so this
      // catches every payout however it was attributed
      CashPayout.find({ businessId: biz._id, date: { $gte: since }, $or: [{ createdBy: phone }, { recordedBy: phone }] }).lean(),
      // Directed payouts RECEIVED by this person - money into their custody
      CashPayout.find({ businessId: biz._id, date: { $gte: since }, paidToPhone: phone }).lean(),
      CashHandover.find({ businessId: biz._id, handoverAt: { $gte: since }, outgoingPhone: phone }).lean(),
      CashHandover.find({ businessId: biz._id, handoverAt: { $gte: since }, incomingPhone: phone }).lean(),
    ]);

    // ── Merge all into one time-sorted activity feed ─────────────────────────
    const rows = [];

    // Income (receipts + invoice payments + admin income)
    for (const r of incomeRows) {
      rows.push({ ...r, sign: 1 });
    }

    // Recurring billing (rent/fee collections + unit expenses) - rows arrive
    // pre-shaped with their own sign (+1 payments, −1 expenses)
    for (const r of recurringRows) {
      rows.push(r);
    }

    // Expenses
    for (const r of expenses) {
      rows.push({
        _id: r._id, type: "expense", icon: "💸",
        label: "Expense",
        date: r.createdAt, amount: r.amount || 0, sign: -1,
        desc: `${r.description || ""}${r.category ? ` (${r.category})` : ""}`,
        rec: r, editable: true, reversible: !r.reversed,
        reversed: r.reversed, originalAmount: r.originalAmount
      });
    }

    // Payouts / drawings (made by this person - money OUT of their custody)
    for (const r of payouts) {
      const isDrawing = DRAW_RE.test(r.reason || "");
      rows.push({
        _id: r._id, type: "payout", icon: isDrawing ? "👑" : "🏧",
        label: isDrawing ? "Owner Drawing" : "Payout",
        date: r.date, amount: r.amount || 0, sign: -1,
        desc: `${r.reason || ""}${r.paidToName ? ` → ${r.paidToName}` : ""}`,
        rec: r, editable: true, reversible: !r.reversed,
        reversed: r.reversed, originalAmount: r.originalAmount
      });
    }

    // Payouts RECEIVED by this person (money INTO their custody). Read-only
    // here - the record is owned by the PAYER's workspace, where edit/reverse/
    // delete live; one document drives both sides so corrections there fix
    // this side automatically.
    for (const r of payoutsReceived) {
      if (String(r.createdBy || r.recordedBy || "") === String(phone)) continue; // self-payout nets zero
      const fromName = staff.find(s => s.phone === (r.createdBy || r.recordedBy))?.name || r.createdBy || r.recordedBy || "Staff";
      rows.push({
        _id: r._id, type: "payoutreceived", icon: "💰",
        label: "Payout Received",
        date: r.date, amount: r.amount || 0, sign: 1,
        desc: `From ${fromName}${r.reason ? " · " + r.reason : ""}`,
        rec: r, editable: false, deletable: false, reversible: false,
        reversed: r.reversed, originalAmount: r.originalAmount
      });
    }

    // Handovers (outgoing)
    for (const r of handoversOut) {
      rows.push({
        _id: r._id, type: "handover", icon: "📤",
        label: `Handed to ${r.incomingName || r.incomingPhone || "Owner"}`,
        date: r.handoverAt, amount: r.amountCounted || 0, sign: 0,
        desc: r.notes || "",
        rec: r, editable: true, reversible: !r.reversed,
        reversed: r.reversed
      });
    }

    // Handovers (incoming)
    for (const r of handoversIn) {
      rows.push({
        _id: r._id, type: "handover", icon: "📥",
        label: `Received from ${r.outgoingName || r.outgoingPhone || "Owner"}`,
        date: r.handoverAt, amount: r.amountCounted || 0, sign: 0,
        desc: r.notes || "",
        rec: r, editable: true, reversible: !r.reversed,
        reversed: r.reversed
      });
    }

    rows.sort((a, b) => new Date(b.date) - new Date(a.date));

    // ── Summary stats ────────────────────────────────────────────────────────
    const totalIn  = rows.filter(r => r.sign === 1 && !r.reversed).reduce((s, r) => s + r.amount, 0);
    const totalOut = rows.filter(r => r.sign === -1 && !r.reversed).reduce((s, r) => s + r.amount, 0);

    // ── Activity feed rows ───────────────────────────────────────────────────
    const rowHtml = rows.map(r => {
      const amountStr = r.sign === 0
        ? `<span style="font-weight:600">${money(r.amount, biz.currency)}</span>`
        : `<span style="color:${r.sign > 0 ? "var(--green)" : "var(--red)"};font-weight:700">${r.sign > 0 ? "+" : "−"}${money(r.amount, biz.currency)}</span>`;

      const reversedTag = r.reversed
        ? `<span class="badge badge-gray" style="margin-left:6px;font-size:11px">REVERSED${r.originalAmount ? " · was " + money(r.originalAmount, biz.currency) : ""}</span>` : "";

      // Only CashIncome, Expense, Payout, Handover are editable here.
      // Invoice/InvoicePayment rows are read-only (managed via invoice admin).
      const editUrl    = r.editable  ? workspaceUrl(supplier._id, phone, `/${r.type}/${r._id}/edit`)    : null;
      const reverseUrl =               workspaceUrl(supplier._id, phone, `/${r.type}/${r._id}/reverse`);
      const deleteUrl  = (r.editable || r.deletable) ? workspaceUrl(supplier._id, phone, `/${r.type}/${r._id}/delete`) : null;

      const actionHtml = (r.editable || r.deletable) ? `
        ${r.editable ? `<a href="${editUrl}" class="btn btn-gray" style="padding:4px 9px;font-size:12px">✏️ Edit</a>` : ""}
        ${r.reversible ? `<form method="POST" action="${reverseUrl}" style="display:inline" onsubmit="return confirm('Reverse this ${esc(r.type)}? It stays visible for audit but no longer affects totals.')"><button class="btn btn-gray" style="padding:4px 9px;font-size:12px;color:#b45309">↩ Reverse</button></form>` : ""}
        ${deleteUrl ? `<form method="POST" action="${deleteUrl}" style="display:inline" onsubmit="return confirm('⚠️ Permanently delete this ${esc(r.type)}?\n\nThis will remove the record and recompute all affected balances.\n\nThis cannot be undone.')"><button class="btn btn-gray" style="padding:4px 9px;font-size:12px;color:var(--red)">🗑 Delete</button></form>` : ""}
      ` : `<span style="font-size:11.5px;color:var(--muted)">-</span>`;

      return `<tr>
        <td style="white-space:nowrap;font-size:12px;color:var(--muted)">${dt(r.date)}</td>
        <td style="font-size:13px">${r.icon} ${esc(r.label)}${reversedTag}</td>
        <td style="font-size:12.5px;color:var(--muted);max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(r.desc)}</td>
        <td style="text-align:right">${amountStr}</td>
        <td style="white-space:nowrap">${actionHtml}</td>
      </tr>`;
    }).join("");

    const todayStr = new Date().toISOString().slice(0, 10);
    const nowLocal = new Date().toISOString().slice(0, 16);

    // ── Render page ──────────────────────────────────────────────────────────
    res.send(layout(`Acting as ${person.name || phone}`, `
      <a href="/zq-admin/suppliers/${supplier._id}/finance" class="back-link">← Choose a different staff member</a>
      ${alertBlock(req)}

      <style>
        .persona-bar{display:flex;align-items:center;gap:14px;background:var(--white);border:1px solid var(--border);
          border-radius:12px;padding:16px 18px;margin:14px 0 22px}
        .persona-avatar{width:50px;height:50px;border-radius:50%;color:white;font-weight:700;font-size:17px;
          display:flex;align-items:center;justify-content:center;flex-shrink:0}
        .quick-actions{display:grid;grid-template-columns:repeat(auto-fit,minmax(145px,1fr));gap:10px;margin-bottom:24px}
        .qa-btn{border:none;border-radius:10px;padding:14px 10px;font-size:13px;font-weight:600;color:white;
          cursor:pointer;text-align:center;line-height:1.3;width:100%}
        .qa-btn .qa-icon{font-size:20px;display:block;margin-bottom:4px}
        .qa-panel{display:none;background:var(--white);border:2px solid var(--border);border-radius:12px;
          padding:20px;margin-bottom:24px;max-width:520px}
        .qa-panel.open{display:block}
        .stat-row{display:grid;grid-template-columns:1fr 1fr 1fr;gap:14px;margin-bottom:22px}
        .info-note{font-size:11.5px;color:var(--muted);padding:6px 0;border-top:1px solid var(--border);margin-top:12px}
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
          <select name="days" style="${fs}width:auto" onchange="this.form.submit()">
            ${[7, 30, 90, 365].map(d => `<option value="${d}" ${d === days ? "selected" : ""}>Last ${d} days</option>`).join("")}
          </select>
        </form>
      </div>

      <div class="stat-row">
        <div class="stat-card stat-green">
          <div class="stat-val">${money(totalIn, biz.currency)}</div>
          <div class="stat-lbl">Total In (${days}d)</div>
        </div>
        <div class="stat-card stat-red">
          <div class="stat-val">${money(totalOut, biz.currency)}</div>
          <div class="stat-lbl">Total Out (${days}d)</div>
        </div>
        <div class="stat-card">
          <div class="stat-val">${money(totalIn - totalOut, biz.currency)}</div>
          <div class="stat-lbl">Net held (${days}d)</div>
        </div>
      </div>

      <div class="quick-actions">
        <button class="qa-btn" style="background:#16a34a" onclick="toggle('income')"><span class="qa-icon">💵</span>Add Income</button>
        <button class="qa-btn" style="background:#dc2626" onclick="toggle('expense')"><span class="qa-icon">💸</span>Add Expense</button>
        <button class="qa-btn" style="background:#b45309" onclick="toggle('payout')"><span class="qa-icon">🏧</span>Add Payout</button>
        <button class="qa-btn" style="background:#7c3aed" onclick="toggle('drawing')"><span class="qa-icon">👑</span>Add Drawing</button>
        <button class="qa-btn" style="background:#0369a1" onclick="toggle('handover')"><span class="qa-icon">🔄</span>Cash Handover</button>
      </div>

      <div id="panel-income" class="qa-panel">
        <h4 style="margin-bottom:4px">💵 Add Income - as ${esc(person.name || phone)}</h4>
        <p class="info-note" style="margin-bottom:14px">
          ℹ️ This records a manual income entry attributed to ${esc(person.name || phone)}.
          WhatsApp sales (receipts &amp; invoice payments) created by this person on the chatbot
          already appear automatically in the activity list below - you don't need to re-enter those.
        </p>
        <form method="POST" action="${workspaceUrl(supplier._id, phone, "/income/add")}">
          ${field("Amount *", `<input name="amount" type="number" step="0.01" min="0" required style="${fs}">`)}
          ${field("Description", `<input name="description" placeholder="e.g. Cash sale - 2 bags cement" style="${fs}">`)}
          ${field("Category", `<select name="category" style="${fs}"><option>Sale</option><option>Other Income</option><option>Refund Received</option><option>Float Received</option></select>`)}
          ${field("Date", `<input name="date" type="date" value="${todayStr}" style="${fs}">`)}
          ${field("Branch", `<select name="branchId" style="${fs}">${branchOptions(branches, person.branchId)}</select>`)}
          <button class="btn btn-blue" style="width:100%">Save Income</button>
        </form>
      </div>

      <div id="panel-expense" class="qa-panel">
        <h4 style="margin-bottom:14px">💸 Add Expense - as ${esc(person.name || phone)}</h4>
        <form method="POST" action="${workspaceUrl(supplier._id, phone, "/expense/add")}">
          ${field("Description *", `<input name="description" required style="${fs}">`)}
          ${field("Category", `<input name="category" placeholder="e.g. Stock, Rent, Fuel" style="${fs}">`)}
          ${field("Amount *", `<input name="amount" type="number" step="0.01" min="0" required style="${fs}">`)}
          ${field("Date", `<input name="date" type="date" value="${todayStr}" style="${fs}">`)}
          ${field("Branch", `<select name="branchId" style="${fs}">${branchOptions(branches, person.branchId)}</select>`)}
          <button class="btn btn-blue" style="width:100%">Save Expense</button>
        </form>
      </div>

      <div id="panel-payout" class="qa-panel">
        <h4 style="margin-bottom:14px">🏧 Add Payout - as ${esc(person.name || phone)}</h4>
        <form method="POST" action="${workspaceUrl(supplier._id, phone, "/payout/add")}">
          <input type="hidden" name="kind" value="payout">
          ${field("Reason *", `<input name="reason" required placeholder="e.g. Paid delivery driver" style="${fs}">`)}
          ${field("Amount *", `<input name="amount" type="number" step="0.01" min="0" required style="${fs}">`)}
          ${field("Cash from (whose till)", `<select name="fromPhone" style="${fs}">
            ${staff.map(s => `<option value="${esc(s.phone)}" ${s.phone === phone ? "selected" : ""}>${esc(s.name || s.phone)} - ${esc(s.role)}${s.phone === phone ? " (this workspace)" : ""}</option>`).join("")}
            <option value="__none__">Not from a staff till (owner's own pocket / float)</option>
          </select>`)}
          ${field("Paid to", `<select name="paidToPhone" style="${fs}">
            <option value="">Outside person / supplier / personal (no staff statement)</option>
            ${staff.filter(s => s.phone !== phone).map(s => `<option value="${esc(s.phone)}">${esc(s.name || s.phone)} - ${esc(s.role)} (credits their statement)</option>`).join("")}
          </select>`)}
          ${field("Date", `<input name="date" type="date" value="${todayStr}" style="${fs}">`)}
          ${field("Branch", `<select name="branchId" style="${fs}">${branchOptions(branches, person.branchId)}</select>`)}
          <button class="btn btn-blue" style="width:100%">Save Payout</button>
        </form>
      </div>

      <div id="panel-drawing" class="qa-panel">
        <h4 style="margin-bottom:14px">👑 Add Owner Drawing - as ${esc(person.name || phone)}</h4>
        <form method="POST" action="${workspaceUrl(supplier._id, phone, "/payout/add")}">
          <input type="hidden" name="kind" value="drawing">
          ${field("Note", `<input name="reason" placeholder="e.g. Personal withdrawal" style="${fs}">`)}
          ${field("Amount *", `<input name="amount" type="number" step="0.01" min="0" required style="${fs}">`)}
          ${field("Cash from (whose till)", `<select name="fromPhone" style="${fs}">
            ${staff.map(s => `<option value="${esc(s.phone)}" ${s.phone === phone ? "selected" : ""}>${esc(s.name || s.phone)} - ${esc(s.role)}${s.phone === phone ? " (this workspace)" : ""}</option>`).join("")}
            <option value="__none__">Not from a staff till (owner's own pocket / float)</option>
          </select>`)}
          ${field("Paid to", `<select name="paidToPhone" style="${fs}">
            <option value="">Personal / outside (no staff statement)</option>
            ${staff.filter(s => s.phone !== phone).map(s => `<option value="${esc(s.phone)}">${esc(s.name || s.phone)} - ${esc(s.role)} (credits their statement)</option>`).join("")}
          </select>`)}
          ${field("Date", `<input name="date" type="date" value="${todayStr}" style="${fs}">`)}
          ${field("Branch", `<select name="branchId" style="${fs}">${branchOptions(branches, person.branchId)}</select>`)}
          <button class="btn btn-blue" style="width:100%">Save Drawing</button>
        </form>
      </div>

      <div id="panel-handover" class="qa-panel">
        <h4 style="margin-bottom:14px">🔄 Cash Handover - involving ${esc(person.name || phone)}</h4>
        <form method="POST" action="${workspaceUrl(supplier._id, phone, "/handover/add")}">
          ${field("Direction *", `<select name="direction" style="${fs}">
            <option value="out">${esc(person.name || phone)} hands cash to someone else (outgoing)</option>
            <option value="in">${esc(person.name || phone)} receives cash from someone else (incoming)</option>
          </select>`)}
          ${field("Other person (blank = Owner/business)", `<select name="otherPhone" style="${fs}">
            <option value="">Owner / business</option>
            ${staff.filter(s => s.phone !== phone).map(s => `<option value="${esc(s.phone)}">${esc(s.name || s.phone)} - ${esc(s.role)}</option>`).join("")}
          </select>`)}
          ${field("Amount counted *", `<input name="amountCounted" type="number" step="0.01" min="0" required style="${fs}">`)}
          ${field("Notes (discrepancy, float, etc.)", `<input name="notes" style="${fs}">`)}
          ${field("Date/time", `<input name="handoverAt" type="datetime-local" value="${nowLocal}" style="${fs}">`)}
          ${field("Branch", `<select name="branchId" style="${fs}">${branchOptions(branches, person.branchId)}</select>`)}
          <button class="btn btn-blue" style="width:100%">Save Handover</button>
        </form>
      </div>

      <div class="panel">
        <div class="panel-head">
          <h3>📋 Activity - ${esc(person.name || phone)} (last ${days} days)</h3>
          <span style="font-size:12px;color:var(--muted)">
            💡 Cash Sales, Invoice Payments &amp; Recurring Billing (🏠 payments / 🔧 unit expenses) from WhatsApp show 🗑 Delete only - deleting a billing payment also restores the linked invoice and tenant/account balances. Admin-entered income shows full Edit/Reverse/Delete. All deletions recompute affected balances.
          </span>
        </div>
        <table class="data-table">
          <thead><tr><th>When</th><th>Type</th><th>Detail</th><th style="text-align:right">Amount</th><th>Actions</th></tr></thead>
          <tbody>${rowHtml || `<tr><td colspan="5" style="text-align:center;color:var(--muted);padding:20px">No activity for ${esc(person.name || phone)} in the last ${days} days</td></tr>`}</tbody>
        </table>
      </div>

      <script>
        function toggle(name) {
          document.querySelectorAll('.qa-panel').forEach(function(p) {
            if (p.id !== 'panel-' + name) p.classList.remove('open');
          });
          var el = document.getElementById('panel-' + name);
          if (el) {
            el.classList.toggle('open');
            if (el.classList.contains('open')) el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
          }
        }
      </script>
    `));
  } catch (e) {
    res.send(layout("Error", `<div class="alert red">${esc(e.message)}<pre style="font-size:11px;margin-top:8px">${esc(e.stack || "")}</pre></div>`));
  }
});


// ═══════════════════════════════════════════════════════════════════════════
// ORPHAN PAYOUT FIX - clickable GET links (admin only)
// ─────────────────────────────────────────────────────────────────────────────
// "Orphan" = a payout/drawing with NO attribution at all: createdBy, recordedBy
// AND fromPhone all null/absent. These are pre-fix WhatsApp drawings that show
// on the ledger (which ignores clerk) but on nobody's clerk statement, so the
// clerk's cash-at-hand is inflated. Both routes are scoped to the given
// person's BRANCH so the assignment is unambiguous, and only ever touch true
// orphans (safe to run repeatedly, never clobbers attributed records).
//
// LINKS (replace <SUPPLIER_ID> with the id already in your admin URL, and the
// phone with the staff member's number):
//   Preview :  /zq-admin/suppliers/<SUPPLIER_ID>/finance/<PHONE>/fix-payouts
//   Apply   :  /zq-admin/suppliers/<SUPPLIER_ID>/finance/<PHONE>/fix-payouts?apply=1
//
// e.g. for Stella (263781603826):
//   .../finance/263781603826/fix-payouts        → shows what WILL change
//   .../finance/263781603826/fix-payouts?apply=1 → performs the update
// ═══════════════════════════════════════════════════════════════════════════
router.get("/:phone/fix-payouts", requireSupplierAdmin, async (req, res) => {
  const phone = req.params.phone;
  try {
    const { supplier, biz } = await loadBizContext(req);
    if (!biz) return res.redirect(`/zq-admin/suppliers/${req.params.id}/finance`);
    const person = await findStaffByPhone(biz._id, phone);
    if (!person) return res.redirect(`/zq-admin/suppliers/${supplier._id}/finance?error=Staff+not+found`);

    const CashPayout = (await import("../models/cashPayout.js")).default;

    const orphanMatch = {
      businessId: biz._id,
      $and: [
        { $or: [{ createdBy: null }, { createdBy: { $exists: false } }] },
        { $or: [{ recordedBy: null }, { recordedBy: { $exists: false } }] },
        { $or: [{ fromPhone: null }, { fromPhone: { $exists: false } }] }
      ],
      ...(person.branchId ? { branchId: person.branchId } : {})
    };

    const orphans = await CashPayout.find(orphanMatch).sort({ date: 1 }).lean();
    const total   = orphans.reduce((s, o) => s + (o.amount || 0), 0);
    const apply   = req.query.apply === "1";
    const cur     = biz.currency || "USD";

    // ── Preview table ────────────────────────────────────────────────────────
    const rowsHtml = orphans.length
      ? orphans.map(o => `
          <tr>
            <td>${new Date(o.date).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })}</td>
            <td>${esc(o.reason || "(no reason)")}</td>
            <td style="text-align:right">${money(o.amount, cur)}</td>
            <td style="font-size:11px;color:var(--muted)">${o._id}</td>
          </tr>`).join("")
      : `<tr><td colspan="4" style="text-align:center;color:var(--muted);padding:18px">
           🎉 No unattributed payouts at ${esc(person.name || phone)}'s branch - nothing to fix.
         </td></tr>`;

    if (!apply || orphans.length === 0) {
      // Just show the preview + an Apply button
      return res.send(layout("Fix Unattributed Payouts", `
        <a href="${workspaceUrl(supplier._id, phone)}" class="back-link">← Back to ${esc(person.name || phone)}'s workspace</a>
        <h2 style="font-size:20px;font-weight:700;margin:12px 0 6px">🔧 Fix Unattributed Payouts</h2>
        <p style="color:var(--muted);font-size:13px;margin-bottom:18px">
          These payouts/drawings were recorded on WhatsApp before the accountability update and carry
          no record of who made them. Assigning them to <b>${esc(person.name || phone)}</b> (the clerk
          holding this branch's till) makes them show on the statement and reduces cash-at-hand.
        </p>
        <div class="card" style="max-width:640px">
          <div style="font-weight:700;margin-bottom:10px">
            ${orphans.length} unattributed payout${orphans.length === 1 ? "" : "s"} · ${money(total, cur)}
          </div>
          <table class="data-table">
            <thead><tr><th>Date</th><th>Reason</th><th style="text-align:right">Amount</th><th>Record ID</th></tr></thead>
            <tbody>${rowsHtml}</tbody>
          </table>
          ${orphans.length ? `
          <a class="btn btn-blue" style="margin-top:16px;display:inline-block"
             href="${workspaceUrl(supplier._id, phone, "/fix-payouts?apply=1")}"
             onclick="return confirm('Assign ${orphans.length} payout(s) totalling ${money(total, cur)} to ${esc(person.name || phone)}?')">
            ✅ Assign all ${orphans.length} to ${esc(person.name || phone)}
          </a>` : ""}
        </div>
      `));
    }

    // ── Apply ─────────────────────────────────────────────────────────────────
    const result = await CashPayout.updateMany(orphanMatch, {
      $set: {
        createdBy:  phone,
        recordedBy: phone,
        fromPhone:  phone,
        fromName:   person.name || phone
      }
    });
    const n = result.modifiedCount ?? result.nModified ?? 0;

    // Recompute affected days (attribution doesn't change business totals, but
    // keeps any stored daily snapshots consistent).
    try {
      const days = [...new Set(orphans.map(o => new Date(o.date).toISOString().slice(0, 10)))];
      for (const dstr of days) await recomputeDay(biz._id, person.branchId || null, new Date(dstr));
    } catch (e) { console.error("[fix-payouts recompute]", e.message); }

    return res.send(layout("Payouts Fixed", `
      <a href="${workspaceUrl(supplier._id, phone)}" class="back-link">← Back to ${esc(person.name || phone)}'s workspace</a>
      <div class="card" style="max-width:640px;margin-top:14px">
        <h2 style="font-size:20px;font-weight:700;color:#16a34a;margin-bottom:8px">✅ Done</h2>
        <p style="font-size:14px;margin-bottom:6px">
          Assigned <b>${n}</b> payout${n === 1 ? "" : "s"} (${money(total, cur)}) to
          <b>${esc(person.name || phone)}</b>.
        </p>
        <p style="color:var(--muted);font-size:13px;margin-bottom:16px">
          They now appear on ${esc(person.name || phone)}'s statement as money out and reduce
          their cash-at-hand. Re-generate the clerk statement on WhatsApp to see it.
        </p>
        <a class="btn btn-blue" href="${workspaceUrl(supplier._id, phone)}">Back to workspace</a>
      </div>
    `));
  } catch (e) {
    res.send(layout("Error", `<div class="alert red">${esc(e.message)}<pre style="font-size:11px;margin-top:8px">${esc(e.stack || "")}</pre></div>`));
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. INCOME (CashIncome) - add / edit / reverse / delete
// Only admin-entered income is editable. WhatsApp receipts and invoice
// payments are read-only here (shown but not touched).
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
          ${field("Amount *", `<input name="amount" type="number" step="0.01" min="0" required value="${rec.amount}" style="${fs}">`)}
          ${field("Description", `<input name="description" value="${esc(rec.description || "")}" style="${fs}">`)}
          ${field("Category", `<select name="category" style="${fs}">${["Sale","Other Income","Refund Received","Float Received"].map(c => `<option ${rec.category === c ? "selected" : ""}>${c}</option>`).join("")}</select>`)}
          ${field("Date", `<input name="date" type="date" value="${new Date(rec.createdAt).toISOString().slice(0,10)}" style="${fs}">`)}
          ${field("Branch", `<select name="branchId" style="${fs}">${branchOptions(branches, rec.branchId)}</select>`)}
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
// 5. EXPENSE - add / edit / reverse / delete
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
          ${field("Description *", `<input name="description" required value="${esc(exp.description || "")}" style="${fs}">`)}
          ${field("Category", `<input name="category" value="${esc(exp.category || "")}" style="${fs}">`)}
          ${field("Amount *", `<input name="amount" type="number" step="0.01" min="0" required value="${exp.amount}" style="${fs}">`)}
          ${field("Date", `<input name="date" type="date" value="${new Date(exp.createdAt).toISOString().slice(0,10)}" style="${fs}">`)}
          ${field("Branch", `<select name="branchId" style="${fs}">${branchOptions(branches, exp.branchId)}</select>`)}
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
// 6. PAYOUT / DRAWING - add / edit / reverse / delete
// ═══════════════════════════════════════════════════════════════════════════
router.post("/:phone/payout/add", requireSupplierAdmin, async (req, res) => {
  const phone = req.params.phone;
  try {
    const { supplier, biz } = await loadBizContext(req);
    const CashPayout = (await import("../models/cashPayout.js")).default;
    const { kind, reason, amount, date, branchId, paidToPhone, fromPhone } = req.body;
    const d = date ? new Date(date) : new Date();
    const finalReason = kind === "drawing" && !/draw/i.test(reason || "")
      ? `Owner drawing${reason ? ": " + reason.trim() : ""}` : (reason || "").trim();
    // Directed payout: resolve the receiver's name once at save time so
    // statements never need a lookup. Blank = external party (old behaviour).
    let paidToName = null;
    const cleanPaidTo = (paidToPhone || "").trim() || null;
    if (cleanPaidTo) {
      const receiver = await findStaffByPhone(biz._id, cleanPaidTo);
      paidToName = receiver?.name || cleanPaidTo;
    }
    // Cash source (whose till is debited). Defaults to the workspace person so
    // a payout entered while acting as a clerk leaves that clerk's till. The
    // sentinel "__none__" means owner's-own-pocket → store null so it debits
    // nobody's custody (falls back to recorder, which is the admin, harmless).
    let fromName = null;
    let cleanFrom = (fromPhone || "").trim();
    if (cleanFrom === "__none__") { cleanFrom = null; }
    else if (!cleanFrom) { cleanFrom = phone; }   // default = this workspace person
    if (cleanFrom) {
      const src = await findStaffByPhone(biz._id, cleanFrom);
      fromName = src?.name || cleanFrom;
    }
    await CashPayout.create({
      businessId: biz._id, branchId: branchId || null,
      amount: parseFloat(amount) || 0,
      reason: finalReason || (kind === "drawing" ? "Owner drawing" : "Cash payout"),
      createdBy: phone, recordedBy: phone,
      fromPhone: cleanFrom, fromName,
      paidToPhone: cleanPaidTo, paidToName,
      date: d
    });
    await recomputeDay(biz._id, branchId || null, d);
    res.redirect(`${workspaceUrl(supplier._id, phone)}?success=${kind === "drawing" ? "Drawing" : "Payout"}+recorded${paidToName ? "+-+credited+to+" + encodeURIComponent(paidToName) : ""}`);
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
    const staff    = await listStaff(biz._id);
    const isDrawing = DRAW_RE.test(p.reason || "");
    res.send(layout("Edit Payout", `
      <a href="${workspaceUrl(supplier._id, phone)}" class="back-link">← Back</a>
      <h2 style="font-size:20px;font-weight:700;margin:10px 0 20px">✏️ Edit Payout / Drawing</h2>
      ${alertBlock(req)}
      <div class="card" style="max-width:520px">
        <form method="POST" action="${workspaceUrl(supplier._id, phone, `/payout/${p._id}/edit`)}">
          ${field("Type", `<select name="kind" style="${fs}">
            <option value="payout" ${!isDrawing ? "selected" : ""}>Cash Payout</option>
            <option value="drawing" ${isDrawing ? "selected" : ""}>Owner Drawing</option>
          </select>`)}
          ${field("Reason", `<input name="reason" value="${esc(p.reason || "")}" style="${fs}">`)}
          ${field("Amount *", `<input name="amount" type="number" step="0.01" min="0" required value="${p.amount}" style="${fs}">`)}
          ${field("Cash from (whose till)", `<select name="fromPhone" style="${fs}">
            ${staff.map(s => `<option value="${esc(s.phone)}" ${s.phone === (p.fromPhone || "") ? "selected" : ""}>${esc(s.name || s.phone)} - ${esc(s.role)}</option>`).join("")}
            <option value="__none__" ${!p.fromPhone ? "selected" : ""}>Not from a staff till (owner's own pocket / float)</option>
          </select>`)}
          ${field("Paid to", `<select name="paidToPhone" style="${fs}">
            <option value="">Outside person / supplier / personal (no staff statement)</option>
            ${staff.filter(s => s.phone !== phone).map(s => `<option value="${esc(s.phone)}" ${s.phone === p.paidToPhone ? "selected" : ""}>${esc(s.name || s.phone)} - ${esc(s.role)} (credits their statement)</option>`).join("")}
          </select>`)}
          ${field("Date", `<input name="date" type="date" value="${new Date(p.date).toISOString().slice(0,10)}" style="${fs}">`)}
          ${field("Branch", `<select name="branchId" style="${fs}">${branchOptions(branches, p.branchId)}</select>`)}
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
    const { kind, reason, amount, date, branchId, paidToPhone, fromPhone } = req.body;
    const d = date ? new Date(date) : before.date;
    const finalReason = kind === "drawing" && !/draw/i.test(reason || "")
      ? `Owner drawing${reason ? ": " + reason.trim() : ""}` : (reason || "").trim();
    let paidToName = null;
    const cleanPaidTo = (paidToPhone || "").trim() || null;
    if (cleanPaidTo) {
      const receiver = await findStaffByPhone(biz._id, cleanPaidTo);
      paidToName = receiver?.name || cleanPaidTo;
    }
    // Cash source (whose till). "__none__" or blank → null (no till debited).
    let fromName = null;
    let cleanFrom = (fromPhone || "").trim();
    if (cleanFrom === "__none__" || !cleanFrom) { cleanFrom = null; }
    if (cleanFrom) {
      const src = await findStaffByPhone(biz._id, cleanFrom);
      fromName = src?.name || cleanFrom;
    }
    await CashPayout.findByIdAndUpdate(req.params.recId, {
      amount: parseFloat(amount) || 0,
      reason: finalReason || (kind === "drawing" ? "Owner drawing" : "Cash payout"),
      fromPhone: cleanFrom, fromName,
      paidToPhone: cleanPaidTo, paidToName,
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
// 7. CASH HANDOVER - add / edit / reverse / delete
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
          ${field("Outgoing (handed cash from)", `<select name="outgoingPhone" style="${fs}"><option value="">Owner / none</option>${staff.map(s => `<option value="${esc(s.phone)}" ${s.phone === h.outgoingPhone ? "selected" : ""}>${esc(s.name || s.phone)}</option>`).join("")}</select>`)}
          ${field("Incoming (received by)", `<select name="incomingPhone" style="${fs}"><option value="">Owner / none</option>${staff.map(s => `<option value="${esc(s.phone)}" ${s.phone === h.incomingPhone ? "selected" : ""}>${esc(s.name || s.phone)}</option>`).join("")}</select>`)}
          ${field("Amount counted *", `<input name="amountCounted" type="number" step="0.01" min="0" required value="${h.amountCounted}" style="${fs}">`)}
          ${field("Notes", `<input name="notes" value="${esc(h.notes || "")}" style="${fs}">`)}
          ${field("Date/time", `<input name="handoverAt" type="datetime-local" value="${new Date(h.handoverAt).toISOString().slice(0,16)}" style="${fs}">`)}
          ${field("Branch", `<select name="branchId" style="${fs}">${branchOptions(branches, h.branchId)}</select>`)}
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



// ═══════════════════════════════════════════════════════════════════════════
// RECEIPT DELETE - admin only, with balance recompute
// Cash sales (Invoice type=receipt) cannot be edited here because receipt
// numbering is sequential. Admin deletes the wrong one and clerk re-records.
// ═══════════════════════════════════════════════════════════════════════════
router.post("/:phone/receipt/:recId/delete", requireSupplierAdmin, async (req, res) => {
  const phone = req.params.phone;
  try {
    const { supplier, biz } = await loadBizContext(req);
    const Invoice = (await import("../models/invoice.js")).default;
    const doc = await Invoice.findOneAndDelete({ _id: req.params.recId, businessId: biz._id, type: "receipt" }).lean();
    if (doc) await recomputeDay(biz._id, doc.branchId, doc.createdAt);
    res.redirect(`${workspaceUrl(supplier._id, phone)}?success=Cash+sale+deleted+and+balance+recomputed`);
  } catch (e) {
    res.redirect(`${workspaceUrl(req.params.id, phone)}?error=${encodeURIComponent(e.message)}`);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// RECURRING BILLING PAYMENT DELETE - admin only
// Deletes the payment, then recomputes the linked recurring invoice
// (amountPaid/balance/status from the remaining payments) and the cached
// account + tenant balances - using the SAME service functions the chatbot
// flows use, so nothing ever drifts. Delete-only (no edit/reverse): the
// recurring models carry no reversal fields, and the clerk simply re-records
// a corrected payment, exactly like invoice payments.
// ═══════════════════════════════════════════════════════════════════════════
router.post("/:phone/rbpayment/:recId/delete", requireSupplierAdmin, async (req, res) => {
  const phone = req.params.phone;
  try {
    const { supplier, biz } = await loadBizContext(req);
    const RecurringPayment = (await import("../models/recurringPayment.js")).default;

    const pmt = await RecurringPayment.findOneAndDelete({ _id: req.params.recId, businessId: biz._id }).lean();
    if (!pmt) return res.redirect(`${workspaceUrl(supplier._id, phone)}?error=Billing+payment+not+found`);

    try {
      const { recomputeInvoiceFromPayments, recomputeAccountBalance, recomputeTenantBalance } =
        await import("./recurringBilling.js");
      if (pmt.invoiceId) await recomputeInvoiceFromPayments(pmt.invoiceId);
      if (pmt.accountId) await recomputeAccountBalance(biz._id, pmt.accountId);
      if (pmt.tenantId)  await recomputeTenantBalance(biz._id, pmt.tenantId);
    } catch (e) { console.error("[FinanceAdmin rb recompute]", e.message); }

    res.redirect(`${workspaceUrl(supplier._id, phone)}?success=Billing+payment+deleted+and+balances+recomputed`);
  } catch (e) {
    res.redirect(`${workspaceUrl(req.params.id, phone)}?error=${encodeURIComponent(e.message)}`);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// RECURRING UNIT EXPENSE DELETE - admin only
// ═══════════════════════════════════════════════════════════════════════════
router.post("/:phone/rbexpense/:recId/delete", requireSupplierAdmin, async (req, res) => {
  const phone = req.params.phone;
  try {
    const { supplier, biz } = await loadBizContext(req);
    const RecurringExpense = (await import("../models/recurringExpense.js")).default;

    const exp = await RecurringExpense.findOneAndDelete({ _id: req.params.recId, businessId: biz._id }).lean();
    if (!exp) return res.redirect(`${workspaceUrl(supplier._id, phone)}?error=Unit+expense+not+found`);

    try {
      const { recomputeAccountBalance } = await import("./recurringBilling.js");
      if (exp.accountId) await recomputeAccountBalance(biz._id, exp.accountId);
    } catch (e) { console.error("[FinanceAdmin rb recompute]", e.message); }

    res.redirect(`${workspaceUrl(supplier._id, phone)}?success=Unit+expense+deleted`);
  } catch (e) {
    res.redirect(`${workspaceUrl(req.params.id, phone)}?error=${encodeURIComponent(e.message)}`);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// INVOICE PAYMENT DELETE - admin only, restores invoice balance + recomputes
// Deleting a payment reverses its effect on the linked invoice's balance and
// recomputes the daily CashBalance snapshot.
// ═══════════════════════════════════════════════════════════════════════════
router.post("/:phone/invoicepayment/:recId/delete", requireSupplierAdmin, async (req, res) => {
  const phone = req.params.phone;
  try {
    const { supplier, biz } = await loadBizContext(req);
    const InvoicePayment = (await import("../models/invoicePayment.js")).default;
    const Invoice        = (await import("../models/invoice.js")).default;

    const pmt = await InvoicePayment.findOneAndDelete({ _id: req.params.recId, businessId: biz._id }).lean();
    if (!pmt) return res.redirect(`${workspaceUrl(supplier._id, phone)}?error=Payment+not+found`);

    // Restore the invoice balance by reversing this payment
    if (pmt.invoiceId) {
      const inv = await Invoice.findById(pmt.invoiceId).lean();
      if (inv) {
        const newAmountPaid = Math.max(0, (inv.amountPaid || 0) - (pmt.amount || 0));
        const newBalance    = (inv.total || 0) - newAmountPaid;
        const newStatus     = newBalance <= 0.01 ? "paid"
                            : newAmountPaid > 0  ? "partial"
                            : "unpaid";
        await Invoice.findByIdAndUpdate(pmt.invoiceId, {
          amountPaid: newAmountPaid,
          balance:    newBalance,
          status:     newStatus
        });
      }
    }

    await recomputeDay(biz._id, pmt.branchId, pmt.createdAt);
    res.redirect(`${workspaceUrl(supplier._id, phone)}?success=Payment+deleted+and+balance+recomputed`);
  } catch (e) {
    res.redirect(`${workspaceUrl(req.params.id, phone)}?error=${encodeURIComponent(e.message)}`);
  }
});

export default router;