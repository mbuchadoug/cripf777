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
import mongoose  from "mongoose";
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

// ── Effective billing settings for a (account, tenant) pair ──────────────────
// A tenant's own billingAmount/billingCycle/billingDay/customIntervalDays
// OVERRIDE the account's when set (non-null). This is what lets several
// tenants share one account (e.g. one building, several rooms) while each
// being charged a different amount on a different schedule. When tenant is
// null (vacant account / legacy single-charge account), the account's own
// settings are used as-is.
function effectiveBilling(tenant, account) {
  return {
    amount:             tenant?.billingAmount       ?? account.billingAmount,
    cycle:              tenant?.billingCycle         ?? account.billingCycle,
    billingDay:         tenant?.billingDay           ?? account.billingDay,
    customIntervalDays: tenant?.customIntervalDays   ?? account.customIntervalDays,
    description:        tenant?.billingDescription || ""
  };
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

// ── Raise ONE invoice for a single billable (account, or account+tenant) ─────
// This is the single source of truth for "create an invoice" - the monthly
// bulk run, the admin's manual "Invoice Now" buttons, and the WhatsApp
// per-account invoice flow ALL go through this. tenant=null means a
// vacant/legacy account-level invoice. force=true skips the "already
// invoiced this period" guard - this is the ONLY way to raise a second
// invoice in the same period, and it's intentionally not exposed in the
// WhatsApp flow (admin-panel-only), so a monthly-billed account can never
// be accidentally double-invoiced from the field.
async function raiseInvoiceForBillable({
  biz, acct, tenant = null, referenceDate = new Date(), clerkPhone = null,
  force = false, amountOverride = null, periodLabelOverride = null,
  dueDateOverride = null, descriptionOverride = null
}) {
  const { RecurringInvoice, RecurringAccount } = await getModels();
  const billing = effectiveBilling(tenant, acct);
  const bounds  = periodBounds(billing.cycle, referenceDate);

  if (!force) {
    // Duplicate guard is scoped to (account, tenant) so several tenants
    // sharing one account can each be invoiced once per period without
    // tripping each other's "already invoiced" check. This is the lock
    // that keeps a monthly account from ever getting invoiced twice in
    // the same month through normal use.
    const dupQ = {
      businessId:  biz._id,
      accountId:   acct._id,
      tenantId:    tenant?._id || null,
      periodStart: { $gte: bounds.start },
      periodEnd:   { $lte: bounds.end }
    };
    const existing = await RecurringInvoice.findOne(dupQ).lean();
    if (existing) return { created: false, skipped: true, invoice: existing };
  }

  const amount = amountOverride != null && amountOverride !== "" ? Number(amountOverride) : (billing.amount || 0);
  const number = await nextRecurringInvoiceNumber(biz._id, biz.recurringPrefix || "RENT");
  const dueDate = dueDateOverride ? new Date(dueDateOverride) : (() => {
    const d = new Date(bounds.start);
    d.setDate(billing.billingDay || 1);
    return d;
  })();
  const periodLabelText = periodLabelOverride || bounds.label;
  const lineDescription = descriptionOverride || billing.description || `${periodLabelText} charge`;

  const invoice = await RecurringInvoice.create({
    businessId:  biz._id,
    branchId:    acct.branchId || null,
    accountId:   acct._id,
    tenantId:    tenant?._id || null,
    number,
    period:      periodLabelText,
    periodStart: bounds.start,
    periodEnd:   bounds.end,
    dueDate,
    amount,
    amountPaid:  0,
    balance:     amount,
    currency:    acct.currency || biz.currency || "USD",
    status:      "unpaid",
    lines:       [{ description: lineDescription, amount }],
    createdBy:   clerkPhone
  });

  await RecurringAccount.findByIdAndUpdate(acct._id, { lastInvoicedAt: new Date() });

  return { created: true, skipped: false, invoice };
}

// ── Generate invoices for all active accounts (monthly bulk run) ─────────────
// Raises one invoice per active TENANT (not per account) - this is what lets
// a single account/building with several tenants on different rents each get
// their own correctly-priced invoice. Accounts with zero active tenants
// (vacant units) still get ONE account-level invoice. Skips anything already
// invoiced this period - this is the documented "power command" run once at
// the start of the billing cycle; day-to-day invoicing should normally go
// through generateInvoiceForAccount/generateInvoiceForTenant for ONE account
// at a time (see below), which is calmer and easier to verify.
// Returns { created, skipped, errors[] }

export async function bulkGenerateInvoices({ biz, branchId = null, clerkPhone = null, referenceDate = new Date() }) {
  const { RecurringAccount, RecurringTenant } = await getModels();

  const q = { businessId: biz._id, isActive: true };
  if (branchId) q.branchId = branchId;
  const accounts = await RecurringAccount.find(q).lean();

  let created = 0, skipped = 0, totalBillables = 0;
  const errors = [];

  for (const acct of accounts) {
    try {
      const tenants = await RecurringTenant.find({ accountId: acct._id, isActive: true }).lean();

      if (!tenants.length) {
        totalBillables++;
        const r = await raiseInvoiceForBillable({ biz, acct, tenant: null, referenceDate, clerkPhone });
        if (r.created) created++; else skipped++;
        continue;
      }

      for (const tenant of tenants) {
        totalBillables++;
        const r = await raiseInvoiceForBillable({ biz, acct, tenant, referenceDate, clerkPhone });
        if (r.created) created++; else skipped++;
      }
    } catch (e) {
      errors.push(`${acct.name}: ${e.message}`);
    }
  }

  return { created, skipped, total: totalBillables, errors };
}

// ── Invoice ONE account right now (the normal, recommended path) ─────────────
// Only sensible for vacant accounts (no tenants) or accounts with exactly ONE
// active tenant - a single charge can't apply sensibly to several
// differently-priced tenants at once. For multi-tenant accounts this throws
// a clear error telling the caller to invoice tenants individually (see
// generateInvoiceForTenant below). force=false by default - the once-a-month
// lock is ALWAYS on unless explicitly overridden (admin panel only).
export async function generateInvoiceForAccount({
  biz, accountId, referenceDate = new Date(), clerkPhone = null, force = false,
  amountOverride = null, periodLabelOverride = null, dueDateOverride = null
}) {
  const { RecurringAccount, RecurringTenant } = await getModels();
  const acct = await RecurringAccount.findById(accountId).lean();
  if (!acct) throw new Error("Account not found");

  const tenants = await RecurringTenant.find({ accountId: acct._id, isActive: true }).lean();
  if (tenants.length > 1) {
    throw new Error(`"${acct.name}" has ${tenants.length} tenants on different accounts/rentals - invoice each tenant individually instead.`);
  }

  const tenant = tenants[0] || null;
  return raiseInvoiceForBillable({
    biz, acct, tenant, referenceDate, clerkPhone, force,
    amountOverride, periodLabelOverride, dueDateOverride
  });
}

// ── Invoice ONE specific tenant right now ─────────────────────────────────────
// The multi-tenant path: each tenant is invoiced using THEIR OWN effective
// billing (their override, or the account's default if they don't have one).
export async function generateInvoiceForTenant({
  biz, accountId, tenantId, referenceDate = new Date(), clerkPhone = null, force = false,
  amountOverride = null, periodLabelOverride = null, dueDateOverride = null, descriptionOverride = null
}) {
  const { RecurringAccount, RecurringTenant } = await getModels();
  const acct   = await RecurringAccount.findById(accountId).lean();
  const tenant = await RecurringTenant.findById(tenantId).lean();
  if (!acct)   throw new Error("Account not found");
  if (!tenant) throw new Error("Tenant not found");

  return raiseInvoiceForBillable({
    biz, acct, tenant, referenceDate, clerkPhone, force,
    amountOverride, periodLabelOverride, dueDateOverride, descriptionOverride
  });
}

// ── Record a payment against an account ──────────────────────────────────────
// Finds the oldest unpaid/partial invoice and applies payment to it.
// Returns the updated invoice and payment record.

export async function recordRecurringPayment({
  businessId, accountId, tenantId, amount, method = "cash",
  reference = "", notes = "", clerkPhone = null, date = new Date()
}) {
  const { RecurringInvoice, RecurringPayment, RecurringAccount } = await getModels();

  // Find oldest outstanding invoice. When a tenantId is supplied (the normal
  // case once an account has more than one tenant), the search is scoped to
  // THAT tenant's own invoices only - otherwise a payment from Tenant A could
  // silently get applied to Tenant B's invoice just because it happened to
  // be older. When tenantId is null/omitted it falls back to the whole
  // account (vacant accounts / accounts that never had per-tenant billing).
  const invoiceQuery = tenantId
    ? { businessId, accountId, tenantId, status: { $in: ["unpaid", "partial", "overdue"] } }
    : { businessId, accountId, status: { $in: ["unpaid", "partial", "overdue"] } };
  const invoice = await RecurringInvoice.findOne(invoiceQuery).sort({ periodStart: 1 }).lean();

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

  // Update cached balances - account total, and (if scoped to a tenant) that
  // tenant's own balance, so multi-tenant accounts stay accurate everywhere.
  await recomputeAccountBalance(businessId, accountId);
  if (tenantId) await recomputeTenantBalance(businessId, tenantId);

  return { payment, invoice: invoiceId ? await RecurringInvoice.findById(invoiceId).lean() : null };
}

// ── Recompute an invoice's amountPaid/balance/status from its payments ───────
// Used after a payment is edited or deleted (from the admin panel) so the
// invoice never drifts out of sync with what was actually paid against it.
// Recomputes from the full set of linked payments rather than patching a
// delta, so repeated edits can never accumulate rounding/logic errors.
export async function recomputeInvoiceFromPayments(invoiceId) {
  if (!invoiceId) return null;
  const { RecurringInvoice, RecurringPayment } = await getModels();
  const invoice = await RecurringInvoice.findById(invoiceId).lean();
  if (!invoice) return null;

  const paid = await RecurringPayment.aggregate([
    { $match: { invoiceId: invoice._id } },
    { $group: { _id: null, t: { $sum: "$amount" } } }
  ]);
  const newPaid    = paid[0]?.t || 0;
  const newBalance = Math.max(0, (invoice.amount || 0) - newPaid);
  const newStatus  = invoice.status === "cancelled" ? "cancelled"
    : newBalance <= 0 ? "paid" : newPaid > 0 ? "partial" : "unpaid";

  await RecurringInvoice.findByIdAndUpdate(invoiceId, {
    amountPaid: newPaid, balance: newBalance, status: newStatus
  });
  return { amountPaid: newPaid, balance: newBalance, status: newStatus };
}

// ── Sum of tenant-level migration "opening balances" for an account ──────────
// Tenants can carry a one-time, admin-entered arrears/credit figure
// (RecurringTenant.openingBalance) representing what they owed BEFORE the
// system was set up. This is never auto-updated and is independent of any
// invoice/payment history. Every balance calculation for the account must
// fold this in, or migrated debt silently disappears. We sum across ALL
// tenants ever linked to the account (not just isActive ones) so toggling a
// tenant inactive doesn't make their migrated arrears vanish from the books.
async function getTenantOpeningBalanceTotal(accountId) {
  const { RecurringTenant } = await getModels();
  const agg = await RecurringTenant.aggregate([
    { $match: { accountId: new mongoose.Types.ObjectId(accountId) } },
    { $group: { _id: null, t: { $sum: "$openingBalance" } } }
  ]);
  return agg[0]?.t || 0;
}

// ── Recompute and cache the account's current balance ────────────────────────

export async function recomputeAccountBalance(businessId, accountId) {
  const { RecurringInvoice, RecurringPayment, RecurringExpense, RecurringAccount } = await getModels();
  const [invoices, payments, tenantOpening] = await Promise.all([
    RecurringInvoice.aggregate([
      { $match: { businessId, accountId, status: { $ne: "cancelled" } } },
      { $group: { _id: null, t: { $sum: "$amount" } } }
    ]),
    RecurringPayment.aggregate([
      { $match: { businessId, accountId } },
      { $group: { _id: null, t: { $sum: "$amount" } } }
    ]),
    getTenantOpeningBalanceTotal(accountId)
  ]);
  const totalCharged = invoices[0]?.t || 0;
  const totalPaid    = payments[0]?.t || 0;
  const balance      = tenantOpening + totalCharged - totalPaid;
  await RecurringAccount.findByIdAndUpdate(accountId, { currentBalance: balance });
  return balance;
}

// ── Recompute and cache ONE TENANT's own balance ──────────────────────────────
// Distinct from recomputeAccountBalance, which sums EVERY tenant under an
// account. Scoped to a single tenant's own invoices/payments/opening balance
// - required once an account can host multiple tenants on different
// rentals, so each tenant's self-service balance check, payment reminder,
// and admin display reflect only THEIR debt, never their neighbours'.
export async function recomputeTenantBalance(businessId, tenantId) {
  const { RecurringInvoice, RecurringPayment, RecurringTenant } = await getModels();
  const tenant = await RecurringTenant.findById(tenantId).lean();
  if (!tenant) return 0;

  const [invoices, payments] = await Promise.all([
    RecurringInvoice.aggregate([
      { $match: { businessId, tenantId: tenant._id, status: { $ne: "cancelled" } } },
      { $group: { _id: null, t: { $sum: "$amount" } } }
    ]),
    RecurringPayment.aggregate([
      { $match: { businessId, tenantId: tenant._id } },
      { $group: { _id: null, t: { $sum: "$amount" } } }
    ])
  ]);
  const totalCharged = invoices[0]?.t || 0;
  const totalPaid     = payments[0]?.t || 0;
  const balance        = (tenant.openingBalance || 0) + totalCharged - totalPaid;
  await RecurringTenant.findByIdAndUpdate(tenantId, { currentBalance: balance });
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

  // Opening balance = migrated arrears from BEFORE the system existed
  // (tenant.openingBalance, entered once at setup) + all charges - all
  // payments recorded in-system before periodStart.
  const tenantOpening = await getTenantOpeningBalanceTotal(accountId);
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
  const openingBalance = tenantOpening + (prevCharged[0]?.t || 0) - (prevPaid[0]?.t || 0);

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
      description: `${inv.period} charge - ${inv.number}`,
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
      typeLabel:   `Expense - ${exp.category}`,
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
// Shows a tenant's full history across all periods - cumulative running balance.

export async function buildTenantStatement({ businessId, tenantId, periodStart, periodEnd }) {
  const { RecurringInvoice, RecurringPayment, RecurringTenant, RecurringAccount } = await getModels();

  const tenant  = await RecurringTenant.findById(tenantId).lean();
  if (!tenant) throw new Error("Tenant not found");
  const account = await RecurringAccount.findById(tenant.accountId).lean();
  const cur = account?.currency || "USD";

  // Opening balance = tenant's migrated arrears (entered once at setup) +
  // all in-system charges - all in-system payments before periodStart.
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
  const openingBalance = (tenant.openingBalance || 0) + (prevCharged[0]?.t || 0) - (prevPaid[0]?.t || 0);

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
      description: `${inv.period} - ${inv.number}`,
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
      <span>${esc(biz.name)} - ${esc(docTitle)}</span>
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

      // Each tenant's OWN balance - not the account total, which would
      // include every other tenant sharing that unit/building.
      const balance = await recomputeTenantBalance(biz._id, tenant._id);
      if (balance <= 0) { skipped++; continue; }

      const cur = account.currency || biz.currency || "USD";
      const msg =
`🏠 *Payment Reminder - ${biz.name}*

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
`🧾 *Invoice - ${biz.name}*
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
  // Scoped to THIS tenant only - an account can host several tenants on
  // different rentals, and a tenant must never see another tenant's balance.
  const balance = await recomputeTenantBalance(businessId, tenant._id);
  const cur     = account?.currency || "USD";

  const outstanding = await RecurringInvoice.find({
    businessId, tenantId: tenant._id,
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
  // Attach ALL active tenants (an account can host more than one, each on a
  // different rental). _tenant stays as the first one for any old code that
  // only ever expected a single tenant; _tenants is the full list and is
  // what every NEW listing/picker should use.
  for (const acct of accounts) {
    acct._tenants = await RecurringTenant.find({ accountId: acct._id, isActive: true }).sort({ name: 1 }).lean();
    acct._tenant  = acct._tenants[0] || null;
  }
  return accounts;
}

// ── Flat, numbered "billable list" for payments / pickers ────────────────────
// One row per ACTUAL person who can be invoiced/paid: every active tenant
// gets their own row (with their OWN balance), and any vacant account (no
// tenants) gets one row representing the account itself. This is what fixes
// "only one tenant shows" for good - nothing here ever collapses multiple
// tenants down to one, because each tenant is a separate, independent row.
export async function listBillablesForChatbot(businessId, branchId = null) {
  const accounts = await listAccountsForChatbot(businessId, branchId);
  const { RecurringAccount } = await getModels();
  const rows = [];
  for (const acct of accounts) {
    if (!acct._tenants.length) {
      const balance = await recomputeAccountBalance(businessId, acct._id);
      rows.push({
        accountId: acct._id, tenantId: null,
        accountName: acct.name, tenantName: "Vacant",
        balance, currency: acct.currency || "USD",
        label: `${acct.name} - Vacant`
      });
      continue;
    }
    for (const t of acct._tenants) {
      const balance = await recomputeTenantBalance(businessId, t._id);
      rows.push({
        accountId: acct._id, tenantId: t._id,
        accountName: acct.name, tenantName: t.name,
        balance, currency: acct.currency || "USD",
        label: `${acct.name} - ${t.name}`
      });
    }
  }
  return rows;
}