/**
 * services/recurringBilling.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Core business logic for the Recurring Billing system.
 *
 * Covers:
 *   - Invoice number generation
 *   - Bulk invoice generation (raise invoices for all active accounts)
 *   - Account statement builder (unit/flat ledger with running balance)
 *   - Tenant statement builder (per-person running balance across periods)
 *   - PDF generation for invoices, account statements, tenant statements
 *   - WhatsApp broadcast helpers (send invoices / reminders to tenants)
 *   - Tenant self-service balance lookup
 *
 * WHERE TO PUT THIS FILE: services/recurringBilling.js
 */

import path      from "path";
import fs        from "fs";
import puppeteer from "puppeteer";
import { sendText, sendDocument } from "./metaSender.js";

// ── Lazy model imports ────────────────────────────────────────────────────────
const getModels = async () => ({
  RecurringAccount: (await import("../models/recurringAccount.js")).default,
  RecurringTenant:  (await import("../models/recurringTenant.js")).default,
  RecurringInvoice: (await import("../models/recurringInvoice.js")).default,
  RecurringPayment: (await import("../models/recurringPayment.js")).default,
  RecurringExpense: (await import("../models/recurringExpense.js")).default,
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtMoney(n, cur = "USD") {
  const sym = cur === "ZWL" ? "ZWL " : cur === "ZAR" ? "R " : "$ ";
  return `${sym}${Number(n || 0).toFixed(2)}`;
}

function fmtDate(d) {
  return new Date(d).toLocaleDateString("en-GB", {
    day: "numeric", month: "short", year: "numeric"
  });
}

function fmtDateTime(d) {
  return new Date(d).toLocaleDateString("en-GB", {
    day: "numeric", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit"
  });
}

function periodLabel(date = new Date()) {
  return new Date(date).toLocaleDateString("en-GB", { month: "long", year: "numeric" });
}

function periodBounds(cycle, referenceDate = new Date()) {
  const d = new Date(referenceDate);
  if (cycle === "monthly") {
    const start = new Date(d.getFullYear(), d.getMonth(), 1, 0, 0, 0, 0);
    const end   = new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59, 999);
    return { start, end, label: periodLabel(start) };
  }
  if (cycle === "quarterly") {
    const q     = Math.floor(d.getMonth() / 3);
    const start = new Date(d.getFullYear(), q * 3, 1, 0, 0, 0, 0);
    const end   = new Date(d.getFullYear(), q * 3 + 3, 0, 23, 59, 59, 999);
    return { start, end, label: `Q${q + 1} ${d.getFullYear()}` };
  }
  if (cycle === "annual") {
    const start = new Date(d.getFullYear(), 0, 1, 0, 0, 0, 0);
    const end   = new Date(d.getFullYear(), 11, 31, 23, 59, 59, 999);
    return { start, end, label: `Year ${d.getFullYear()}` };
  }
  // termly / custom: default to current month
  const start = new Date(d.getFullYear(), d.getMonth(), 1, 0, 0, 0, 0);
  const end   = new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59, 999);
  return { start, end, label: periodLabel(start) };
}

function esc(str) {
  return String(str || "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ── Invoice number generator ──────────────────────────────────────────────────

export async function nextRecurringInvoiceNumber(businessId, prefix = "RENT") {
  const { RecurringInvoice } = await getModels();
  const last = await RecurringInvoice
    .findOne({ businessId })
    .sort({ createdAt: -1 })
    .select("number")
    .lean();
  let seq = 1;
  if (last?.number) {
    const m = last.number.match(/(\d+)$/);
    if (m) seq = parseInt(m[1], 10) + 1;
  }
  return `${prefix}-${String(seq).padStart(4, "0")}`;
}

// ── Generate invoices for all active accounts ─────────────────────────────────
// Raises one invoice per active account for the current billing period.
// Skips any account that already has an invoice for that period.
// Returns { created, skipped, errors[] }

export async function bulkGenerateInvoices({ biz, branchId = null, clerkPhone = null, referenceDate = new Date() }) {
  const { RecurringAccount, RecurringTenant, RecurringInvoice } = await getModels();

  const q = { businessId: biz._id, isActive: true };
  if (branchId) q.branchId = branchId;
  const accounts = await RecurringAccount.find(q).lean();

  let created = 0, skipped = 0;
  const errors = [];

  for (const acct of accounts) {
    try {
      const bounds = periodBounds(acct.billingCycle, referenceDate);

      // Check if already invoiced for this period
      const existing = await RecurringInvoice.findOne({
        businessId: biz._id,
        accountId:  acct._id,
        periodStart: { $gte: bounds.start },
        periodEnd:   { $lte: bounds.end }
      }).lean();

      if (existing) { skipped++; continue; }

      // Find primary tenant for this account
      const { RecurringTenant: RT } = await getModels();
      const tenant = await RT.findOne({ accountId: acct._id, isActive: true }).lean();

      const number = await nextRecurringInvoiceNumber(biz._id, biz.recurringPrefix || "RENT");
      const dueDate = new Date(bounds.start);
      dueDate.setDate(acct.billingDay || 1);

      await RecurringInvoice.create({
        businessId:  biz._id,
        branchId:    acct.branchId || null,
        accountId:   acct._id,
        tenantId:    tenant?._id || null,
        number,
        period:      bounds.label,
        periodStart: bounds.start,
        periodEnd:   bounds.end,
        dueDate,
        amount:      acct.billingAmount,
        amountPaid:  0,
        balance:     acct.billingAmount,
        currency:    acct.currency || biz.currency || "USD",
        status:      "unpaid",
        lines:       [{ description: `${bounds.label} charge`, amount: acct.billingAmount }],
        createdBy:   clerkPhone
      });

      // Update account's lastInvoicedAt
      await RecurringAccount.findByIdAndUpdate(acct._id, { lastInvoicedAt: new Date() });

      created++;
    } catch (e) {
      errors.push(`${acct.name}: ${e.message}`);
    }
  }

  return { created, skipped, total: accounts.length, errors };
}

// ── Record a payment against an account ──────────────────────────────────────
// Finds the oldest unpaid/partial invoice and applies payment to it.
// Returns the updated invoice and payment record.

export async function recordRecurringPayment({
  businessId, accountId, tenantId, amount, method = "cash",
  reference = "", notes = "", clerkPhone = null, date = new Date()
}) {
  const { RecurringInvoice, RecurringPayment, RecurringAccount } = await getModels();

  // Find oldest outstanding invoice for this account
  const invoice = await RecurringInvoice.findOne({
    businessId, accountId,
    status: { $in: ["unpaid", "partial", "overdue"] }
  }).sort({ periodStart: 1 }).lean();

  let invoiceId = null;
  let curPeriod = "";

  if (invoice) {
    invoiceId = invoice._id;
    curPeriod = invoice.period;
    const newPaid    = (invoice.amountPaid || 0) + amount;
    const newBalance = Math.max(0, (invoice.amount || 0) - newPaid);
    const newStatus  = newBalance <= 0 ? "paid" : newPaid > 0 ? "partial" : "unpaid";
    await RecurringInvoice.findByIdAndUpdate(invoice._id, {
      amountPaid: newPaid,
      balance:    newBalance,
      status:     newStatus
    });
  }

  const payment = await RecurringPayment.create({
    businessId, accountId,
    tenantId:  tenantId || null,
    invoiceId,
    amount,
    currency: "USD",
    method, reference, notes,
    date,
    period: curPeriod,
    createdBy: clerkPhone
  });

  // Update cached balance on account
  await recomputeAccountBalance(businessId, accountId);

  return { payment, invoice: invoiceId ? await RecurringInvoice.findById(invoiceId).lean() : null };
}

// ── Recompute and cache the account's current balance ────────────────────────

export async function recomputeAccountBalance(businessId, accountId) {
  const { RecurringInvoice, RecurringPayment, RecurringExpense, RecurringAccount } = await getModels();
  const [invoices, payments] = await Promise.all([
    RecurringInvoice.aggregate([
      { $match: { businessId, accountId, status: { $ne: "cancelled" } } },
      { $group: { _id: null, t: { $sum: "$amount" } } }
    ]),
    RecurringPayment.aggregate([
      { $match: { businessId, accountId } },
      { $group: { _id: null, t: { $sum: "$amount" } } }
    ])
  ]);
  const totalCharged = invoices[0]?.t || 0;
  const totalPaid    = payments[0]?.t || 0;
  const balance      = totalCharged - totalPaid;
  await RecurringAccount.findByIdAndUpdate(accountId, { currentBalance: balance });
  return balance;
}

// ── Account Statement ─────────────────────────────────────────────────────────
// Produces a bank-statement-style ledger for ONE account (unit/flat/room)
// for a given period. Previous period closing = this period opening.

export async function buildAccountStatement({ businessId, accountId, periodStart, periodEnd }) {
  const { RecurringInvoice, RecurringPayment, RecurringExpense, RecurringAccount, RecurringTenant } = await getModels();

  const account = await RecurringAccount.findById(accountId).lean();
  if (!account) throw new Error("Account not found");

  const tenant = await RecurringTenant.findOne({ accountId, isActive: true }).lean();

  // Opening balance = all charges - all payments before periodStart
  const bQ = { businessId, accountId };
  const [prevCharged, prevPaid] = await Promise.all([
    RecurringInvoice.aggregate([
      { $match: { ...bQ, status: { $ne: "cancelled" }, periodStart: { $lt: periodStart } } },
      { $group: { _id: null, t: { $sum: "$amount" } } }
    ]),
    RecurringPayment.aggregate([
      { $match: { ...bQ, date: { $lt: periodStart } } },
      { $group: { _id: null, t: { $sum: "$amount" } } }
    ])
  ]);
  const openingBalance = (prevCharged[0]?.t || 0) - (prevPaid[0]?.t || 0);

  // This period's transactions
  const [invoices, payments, expenses] = await Promise.all([
    RecurringInvoice.find({ ...bQ, periodStart: { $gte: periodStart }, periodEnd: { $lte: periodEnd } })
      .sort({ periodStart: 1 }).lean(),
    RecurringPayment.find({ ...bQ, date: { $gte: periodStart, $lte: periodEnd } })
      .sort({ date: 1 }).lean(),
    RecurringExpense.find({ ...bQ, date: { $gte: periodStart, $lte: periodEnd } })
      .sort({ date: 1 }).lean()
  ]);

  // Flatten into chronological rows
  const rows = [];
  for (const inv of invoices) {
    rows.push({
      date:        inv.periodStart,
      type:        "CHARGE",
      typeLabel:   "Rent / Charge",
      description: `${inv.period} charge — ${inv.number}`,
      debit:       inv.amount,
      credit:      0
    });
  }
  for (const pay of payments) {
    rows.push({
      date:        pay.date,
      type:        "PAYMENT",
      typeLabel:   "Payment Received",
      description: `Payment${pay.method !== "cash" ? ` (${pay.method})` : ""}${pay.reference ? " · " + pay.reference : ""}`,
      debit:       0,
      credit:      pay.amount
    });
  }
  for (const exp of expenses) {
    rows.push({
      date:        exp.date,
      type:        "EXPENSE",
      typeLabel:   `Expense — ${exp.category}`,
      description: exp.description,
      debit:       exp.amount,
      credit:      0
    });
  }

  rows.sort((a, b) => new Date(a.date) - new Date(b.date));

  // Add running balance
  let balance = openingBalance;
  for (const row of rows) {
    balance += row.debit - row.credit;
    row.balance = balance;
  }

  const closingBalance = balance;
  const cur = account.currency || "USD";
  const totalCharged = rows.filter(r => r.type !== "PAYMENT").reduce((s, r) => s + (r.debit || 0), 0);
  const totalPaid    = rows.filter(r => r.type === "PAYMENT").reduce((s, r) => s + (r.credit || 0), 0);

  return {
    account, tenant, cur,
    openingBalance, closingBalance,
    totalCharged, totalPaid,
    rows,
    invoices, payments, expenses
  };
}

// ── Tenant Statement ──────────────────────────────────────────────────────────
// Shows a tenant's full history across all periods — cumulative running balance.

export async function buildTenantStatement({ businessId, tenantId, periodStart, periodEnd }) {
  const { RecurringInvoice, RecurringPayment, RecurringTenant, RecurringAccount } = await getModels();

  const tenant  = await RecurringTenant.findById(tenantId).lean();
  if (!tenant) throw new Error("Tenant not found");
  const account = await RecurringAccount.findById(tenant.accountId).lean();
  const cur = account?.currency || "USD";

  // Opening balance before periodStart
  const bQ = { businessId, tenantId };
  const [prevCharged, prevPaid] = await Promise.all([
    RecurringInvoice.aggregate([
      { $match: { ...bQ, status: { $ne: "cancelled" }, periodStart: { $lt: periodStart } } },
      { $group: { _id: null, t: { $sum: "$amount" } } }
    ]),
    RecurringPayment.aggregate([
      { $match: { ...bQ, date: { $lt: periodStart } } },
      { $group: { _id: null, t: { $sum: "$amount" } } }
    ])
  ]);
  const openingBalance = (prevCharged[0]?.t || 0) - (prevPaid[0]?.t || 0);

  const [invoices, payments] = await Promise.all([
    RecurringInvoice.find({ ...bQ, periodStart: { $gte: periodStart }, periodEnd: { $lte: periodEnd } })
      .sort({ periodStart: 1 }).lean(),
    RecurringPayment.find({ ...bQ, date: { $gte: periodStart, $lte: periodEnd } })
      .sort({ date: 1 }).lean()
  ]);

  const rows = [];
  for (const inv of invoices) {
    rows.push({
      date: inv.periodStart, type: "CHARGE",
      description: `${inv.period} — ${inv.number}`,
      debit: inv.amount, credit: 0
    });
  }
  for (const pay of payments) {
    rows.push({
      date: pay.date, type: "PAYMENT",
      description: `Payment received${pay.method !== "cash" ? ` (${pay.method})` : ""}${pay.reference ? " · " + pay.reference : ""}`,
      debit: 0, credit: pay.amount
    });
  }
  rows.sort((a, b) => new Date(a.date) - new Date(b.date));

  let balance = openingBalance;
  for (const row of rows) {
    balance += row.debit - row.credit;
    row.balance = balance;
  }

  return {
    tenant, account, cur,
    openingBalance, closingBalance: balance,
    totalCharged: rows.filter(r => r.type !== "PAYMENT").reduce((s, r) => s + r.debit, 0),
    totalPaid:    rows.filter(r => r.type === "PAYMENT").reduce((s, r) => s + r.credit, 0),
    rows
  };
}

// ── PDF generation ────────────────────────────────────────────────────────────

const OUTPUT_DIR = path.resolve(process.cwd(), "public", "docs", "generated", "recurring");

async function ensureDir() {
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

async function renderHtmlToPdf(html, filepath) {
  const browser = await puppeteer.launch({ args: ["--no-sandbox", "--disable-setuid-sandbox"] });
  const page    = await browser.newPage();
  await page.emulateMediaType("print");
  await page.setContent(html, { waitUntil: "networkidle0" });
  await new Promise(r => setTimeout(r, 500));
  await page.pdf({ path: filepath, format: "A4", printBackground: true,
    margin: { top: "18mm", bottom: "18mm", left: "16mm", right: "16mm" } });
  await browser.close();
}

// Common CSS for all recurring billing PDFs
function pdfCSS() {
  return `
    <style>
      * { box-sizing: border-box; margin: 0; padding: 0; }
      body { font-family: Arial, Helvetica, sans-serif; font-size: 12px; color: #1e293b; }
      .header { display: flex; justify-content: space-between; align-items: flex-start;
                padding-bottom: 16px; border-bottom: 2px solid #0f172a; margin-bottom: 20px; }
      .biz-name { font-size: 20px; font-weight: 700; color: #0f172a; }
      .biz-sub  { font-size: 11px; color: #64748b; margin-top: 4px; }
      .doc-title { font-size: 14px; font-weight: 700; color: #0f172a; text-align: right; }
      .doc-meta  { font-size: 11px; color: #64748b; text-align: right; margin-top: 4px; line-height: 1.6; }
      .section-title { font-size: 11px; font-weight: 700; color: #64748b;
                       text-transform: uppercase; letter-spacing: .5px;
                       border-bottom: 1px solid #e2e8f0; padding-bottom: 6px; margin: 18px 0 10px; }
      .kpi-row { display: flex; gap: 12px; margin-bottom: 20px; flex-wrap: wrap; }
      .kpi { flex: 1; min-width: 100px; background: #f8fafc; border: 1px solid #e2e8f0;
             border-radius: 8px; padding: 12px; }
      .kpi-label { font-size: 10px; color: #64748b; text-transform: uppercase; letter-spacing: .5px; }
      .kpi-val   { font-size: 16px; font-weight: 700; color: #0f172a; margin-top: 4px; }
      .kpi-val.green { color: #16a34a; }
      .kpi-val.red   { color: #dc2626; }
      table { width: 100%; border-collapse: collapse; font-size: 11px; }
      th { background: #0f172a; color: white; padding: 8px 10px; text-align: left; font-size: 10px; }
      td { padding: 7px 10px; border-bottom: 1px solid #f1f5f9; vertical-align: top; }
      tr:nth-child(even) td { background: #f8fafc; }
      .r { text-align: right; }
      .debit  { color: #dc2626; }
      .credit { color: #16a34a; }
      .bold   { font-weight: 700; }
      .footer { margin-top: 30px; padding-top: 12px; border-top: 1px solid #e2e8f0;
                font-size: 10px; color: #94a3b8; display: flex; justify-content: space-between; }
      .badge { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 10px; font-weight: 700; }
      .badge-red    { background: #fee2e2; color: #dc2626; }
      .badge-green  { background: #dcfce7; color: #16a34a; }
      .badge-yellow { background: #fef3c7; color: #92400e; }
      .opening-row td { background: #eff6ff !important; font-weight: 700; color: #1d4ed8; }
      .closing-row td { background: #f0fdf4 !important; font-weight: 700; font-size: 12px; }
      @media print { body { -webkit-print-color-adjust: exact; print-color-adjust: exact; } }
    </style>`;
}

function pdfHeader(biz, docTitle, meta) {
  return `
    <div class="header">
      <div>
        <div class="biz-name">${esc(biz.name)}</div>
        <div class="biz-sub">${esc(biz.address || "")}${biz.address ? " · " : ""}${esc(biz.currency || "USD")}</div>
      </div>
      <div>
        <div class="doc-title">${esc(docTitle)}</div>
        <div class="doc-meta">${meta}</div>
      </div>
    </div>`;
}

function pdfFooter(biz, docTitle) {
  return `
    <div class="footer">
      <span>${esc(biz.name)} — ${esc(docTitle)}</span>
      <span>Generated ${fmtDateTime(new Date())} · ZimQuote</span>
    </div>`;
}

// ── Generate Account Statement PDF ────────────────────────────────────────────

export async function generateAccountStatementPDF({ biz, stmt, periodLabel: pl }) {
  await ensureDir();
  const filename = `acct-stmt-${stmt.account._id}-${Date.now()}.pdf`;
  const filepath = path.join(OUTPUT_DIR, filename);
  const cur = stmt.cur;

  const rowsHtml = stmt.rows.map(r => `
    <tr>
      <td>${fmtDate(r.date)}</td>
      <td>${esc(r.typeLabel || r.type)}</td>
      <td>${esc(r.description)}</td>
      <td class="r debit">${r.debit > 0 ? fmtMoney(r.debit, cur) : ""}</td>
      <td class="r credit">${r.credit > 0 ? fmtMoney(r.credit, cur) : ""}</td>
      <td class="r bold ${r.balance > 0 ? "debit" : "credit"}">${fmtMoney(r.balance, cur)}</td>
    </tr>`).join("");

  const status = stmt.closingBalance > 0
    ? `<span class="badge badge-red">BALANCE DUE: ${fmtMoney(stmt.closingBalance, cur)}</span>`
    : `<span class="badge badge-green">CLEARED</span>`;

  const tenantLine = stmt.tenant
    ? `<div class="biz-sub">Tenant: ${esc(stmt.tenant.name)}${stmt.tenant.phone ? " · " + esc(stmt.tenant.phone) : ""}</div>`
    : "";

  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8">${pdfCSS()}</head><body>
    ${pdfHeader(biz, "Account Statement", `${esc(stmt.account.name)}${stmt.account.ref ? " · " + esc(stmt.account.ref) : ""}<br>${esc(pl)}`)}
    ${tenantLine}
    <div class="kpi-row" style="margin-top:16px">
      <div class="kpi"><div class="kpi-label">Opening Balance</div>
        <div class="kpi-val ${stmt.openingBalance > 0 ? "red" : ""}">${fmtMoney(stmt.openingBalance, cur)}</div></div>
      <div class="kpi"><div class="kpi-label">Total Charged</div>
        <div class="kpi-val red">${fmtMoney(stmt.totalCharged, cur)}</div></div>
      <div class="kpi"><div class="kpi-label">Total Paid</div>
        <div class="kpi-val green">${fmtMoney(stmt.totalPaid, cur)}</div></div>
      <div class="kpi"><div class="kpi-label">Closing Balance</div>
        <div class="kpi-val ${stmt.closingBalance > 0 ? "red" : "green"}">${fmtMoney(stmt.closingBalance, cur)}</div></div>
    </div>
    <div class="section-title">Transaction Ledger</div>
    <table>
      <thead><tr>
        <th>Date</th><th>Type</th><th>Description</th>
        <th class="r">Charges</th><th class="r">Payments</th><th class="r">Balance</th>
      </tr></thead>
      <tbody>
        <tr class="opening-row">
          <td colspan="5" class="bold">Opening Balance (carried forward)</td>
          <td class="r bold">${fmtMoney(stmt.openingBalance, cur)}</td>
        </tr>
        ${rowsHtml}
        <tr class="closing-row">
          <td colspan="4" class="bold">CLOSING BALANCE</td>
          <td colspan="2" class="r bold">${fmtMoney(stmt.closingBalance, cur)}</td>
        </tr>
      </tbody>
    </table>
    <div style="margin-top:16px">${status}</div>
    ${pdfFooter(biz, "Account Statement")}
  </body></html>`;

  await renderHtmlToPdf(html, filepath);
  const site = (process.env.SITE_URL || "").replace(/\/$/, "");
  const url  = `${site}/docs/generated/recurring/${filename}`;
  return { filename, filepath, url };
}

// ── Generate Tenant Statement PDF ─────────────────────────────────────────────

export async function generateTenantStatementPDF({ biz, stmt, periodLabel: pl }) {
  await ensureDir();
  const filename = `tenant-stmt-${stmt.tenant._id}-${Date.now()}.pdf`;
  const filepath = path.join(OUTPUT_DIR, filename);
  const cur = stmt.cur;

  const rowsHtml = stmt.rows.map(r => `
    <tr>
      <td>${fmtDate(r.date)}</td>
      <td>${esc(r.type === "CHARGE" ? "Charge" : "Payment")}</td>
      <td>${esc(r.description)}</td>
      <td class="r debit">${r.debit > 0 ? fmtMoney(r.debit, cur) : ""}</td>
      <td class="r credit">${r.credit > 0 ? fmtMoney(r.credit, cur) : ""}</td>
      <td class="r bold ${r.balance > 0 ? "debit" : "credit"}">${fmtMoney(r.balance, cur)}</td>
    </tr>`).join("");

  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8">${pdfCSS()}</head><body>
    ${pdfHeader(biz, "Tenant Statement", `${esc(stmt.tenant.name)}<br>${stmt.account ? esc(stmt.account.name) : ""}<br>${esc(pl)}`)}
    <div class="kpi-row" style="margin-top:16px">
      <div class="kpi"><div class="kpi-label">Opening Balance</div>
        <div class="kpi-val ${stmt.openingBalance > 0 ? "red" : ""}">${fmtMoney(stmt.openingBalance, cur)}</div></div>
      <div class="kpi"><div class="kpi-label">Total Charged</div>
        <div class="kpi-val red">${fmtMoney(stmt.totalCharged, cur)}</div></div>
      <div class="kpi"><div class="kpi-label">Total Paid</div>
        <div class="kpi-val green">${fmtMoney(stmt.totalPaid, cur)}</div></div>
      <div class="kpi"><div class="kpi-label">Balance Due</div>
        <div class="kpi-val ${stmt.closingBalance > 0 ? "red" : "green"}">${fmtMoney(stmt.closingBalance, cur)}</div></div>
    </div>
    <div class="section-title">Statement of Account</div>
    <table>
      <thead><tr>
        <th>Date</th><th>Type</th><th>Description</th>
        <th class="r">Debit</th><th class="r">Credit</th><th class="r">Balance</th>
      </tr></thead>
      <tbody>
        <tr class="opening-row">
          <td colspan="5" class="bold">Opening Balance (b/f)</td>
          <td class="r bold">${fmtMoney(stmt.openingBalance, cur)}</td>
        </tr>
        ${rowsHtml}
        <tr class="closing-row">
          <td colspan="4" class="bold">CLOSING BALANCE</td>
          <td colspan="2" class="r bold">${fmtMoney(stmt.closingBalance, cur)}</td>
        </tr>
      </tbody>
    </table>
    ${pdfFooter(biz, "Tenant Statement")}
  </body></html>`;

  await renderHtmlToPdf(html, filepath);
  const site = (process.env.SITE_URL || "").replace(/\/$/, "");
  const url  = `${site}/docs/generated/recurring/${filename}`;
  return { filename, filepath, url };
}

// ── Generate Recurring Invoice PDF ───────────────────────────────────────────

export async function generateRecurringInvoicePDF({ biz, invoice, account, tenant }) {
  await ensureDir();
  const filename = `rec-inv-${invoice._id}-${Date.now()}.pdf`;
  const filepath = path.join(OUTPUT_DIR, filename);
  const cur = invoice.currency || "USD";

  const statusBadge = {
    unpaid:  `<span class="badge badge-red">UNPAID</span>`,
    partial: `<span class="badge badge-yellow">PARTIAL</span>`,
    paid:    `<span class="badge badge-green">PAID</span>`,
    overdue: `<span class="badge badge-red">OVERDUE</span>`
  }[invoice.status] || "";

  const lineRows = (invoice.lines || []).map(l => `
    <tr><td>${esc(l.description)}</td>
        <td class="r">${fmtMoney(l.amount, cur)}</td></tr>`).join("");

  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8">${pdfCSS()}</head><body>
    ${pdfHeader(biz, "Invoice", `${esc(invoice.number)}<br>${esc(invoice.period)}<br>Due: ${fmtDate(invoice.dueDate)}`)}
    <div style="margin-bottom:16px">
      <div class="section-title" style="margin-top:0">Billed To</div>
      <div class="bold" style="font-size:14px">${esc(tenant?.name || account?.name || "Tenant")}</div>
      ${tenant?.phone ? `<div style="color:#64748b">${esc(tenant.phone)}</div>` : ""}
      ${account?.name ? `<div style="color:#64748b">${esc(account.name)}${account.ref ? " · " + esc(account.ref) : ""}</div>` : ""}
    </div>
    <table>
      <thead><tr><th>Description</th><th class="r">Amount</th></tr></thead>
      <tbody>
        ${lineRows}
        <tr style="border-top:2px solid #0f172a">
          <td class="bold">TOTAL</td>
          <td class="r bold">${fmtMoney(invoice.amount, cur)}</td></tr>
        <tr><td style="color:#64748b">Amount Paid</td>
          <td class="r credit">${fmtMoney(invoice.amountPaid, cur)}</td></tr>
        <tr class="closing-row">
          <td class="bold">BALANCE DUE</td>
          <td class="r bold debit">${fmtMoney(invoice.balance, cur)}</td></tr>
      </tbody>
    </table>
    <div style="margin-top:16px">${statusBadge}</div>
    ${pdfFooter(biz, "Invoice")}
  </body></html>`;

  await renderHtmlToPdf(html, filepath);
  const site = (process.env.SITE_URL || "").replace(/\/$/, "");
  const url  = `${site}/docs/generated/recurring/${filename}`;
  return { filename, filepath, url };
}

// ── WhatsApp broadcast helpers ────────────────────────────────────────────────

/**
 * Send a payment reminder to all tenants with outstanding balances.
 * Returns { sent, skipped, errors }.
 */
export async function broadcastPaymentReminders({ biz, branchId = null }) {
  const { RecurringTenant, RecurringAccount } = await getModels();

  const q = { businessId: biz._id, isActive: true, notificationsEnabled: true, phone: { $ne: "" } };
  const tenants = await RecurringTenant.find(q).lean();

  let sent = 0, skipped = 0;
  const errors = [];

  for (const tenant of tenants) {
    try {
      const account = await RecurringAccount.findById(tenant.accountId).lean();
      if (!account) { skipped++; continue; }

      const balance = await recomputeAccountBalance(biz._id, account._id);
      if (balance <= 0) { skipped++; continue; }

      const cur = account.currency || biz.currency || "USD";
      const msg =
`🏠 *Payment Reminder — ${biz.name}*

Dear ${account.name} ${tenant.name},
You have an outstanding balance of *${fmtMoney(balance, cur)}*.

Please make payment at your earliest convenience.

Reply *menu* to open ZimQuote and check your account.`;

      await sendText(tenant.phone, msg);
      sent++;
    } catch (e) {
      errors.push(`${tenant.name}: ${e.message}`);
    }
  }

  return { sent, skipped, errors };
}

/**
 * Send invoice PDF to tenant via WhatsApp.
 */
export async function sendInvoiceToTenant({ biz, invoice, account, tenant }) {
  if (!tenant?.phone) return false;
  const { filename, url } = await generateRecurringInvoicePDF({ biz, invoice, account, tenant });
  const cur = invoice.currency || "USD";
  await sendText(tenant.phone,
`🧾 *Invoice — ${biz.name}*
${account?.name ? `🏠 ${account.name}` : ""}
📅 Period: ${invoice.period}
💵 Amount: *${fmtMoney(invoice.amount, cur)}*
📆 Due: ${fmtDate(invoice.dueDate)}

Your invoice is attached below.`);
  await sendDocument(tenant.phone, { link: url, filename });
  return true;
}

// ── Tenant self-service balance check ─────────────────────────────────────────

export async function getTenantBalanceSummary(phone, businessId) {
  const { RecurringTenant, RecurringAccount, RecurringInvoice } = await getModels();

  // Normalise phone
  let p = String(phone).replace(/\D/g, "");
  if (p.startsWith("0")) p = "263" + p.slice(1);

  const tenant = await RecurringTenant.findOne({ phone: p, businessId, isActive: true, canSelfServe: true }).lean();
  if (!tenant) return null;

  const account = await RecurringAccount.findById(tenant.accountId).lean();
  const balance = await recomputeAccountBalance(businessId, tenant.accountId);
  const cur     = account?.currency || "USD";

  const outstanding = await RecurringInvoice.find({
    businessId, accountId: tenant.accountId,
    status: { $in: ["unpaid", "partial", "overdue"] }
  }).sort({ periodStart: 1 }).lean();

  return { tenant, account, balance, outstanding, cur };
}

// ── Chatbot helper: list accounts for a business ──────────────────────────────

export async function listAccountsForChatbot(businessId, branchId = null) {
  const { RecurringAccount, RecurringTenant } = await getModels();
  const q = { businessId, isActive: true };
  if (branchId) q.branchId = branchId;
  const accounts = await RecurringAccount.find(q).sort({ name: 1 }).lean();
  // Attach primary tenant to each
  for (const acct of accounts) {
    acct._tenant = await RecurringTenant.findOne({ accountId: acct._id, isActive: true }).lean();
  }
  return accounts;
}