/**
 * services/recurringLedger.js
 * ─────────────────────────────────────────────────────────────────────────────
 * WHERE TO PUT THIS FILE:  services/recurringLedger.js
 * (same folder as recurringBilling.js, dailyReportEnhanced.js, etc.)
 *
 * NEW FILE - nothing existing imports it yet except the surgical edits in:
 *   - reportHelpers.js        (buildClerkStatement → clerk's recurring rows)
 *   - dailyReportEnhanced.js  (fetchClerkCumulativeBalance → recurring opening)
 *   - twilioStateBridge.js    (rb_billing_stmt_* states → statement + PDF)
 *
 * WHY A SEPARATE FILE (and not inside recurringBilling.js):
 *   The deployed recurringBilling.js contains listBillablesForChatbot() which
 *   is NOT in the copy that was uploaded here - regenerating that whole file
 *   would have deleted it and broken payment recording. A brand-new file has
 *   ZERO risk of clobbering anything already live.
 *
 * WHAT LIVES HERE:
 *   1. buildRecurringLedger()          - the new business-wide RECURRING
 *      BILLING STATEMENT: every charge raised, payment collected, and unit
 *      expense across the whole business (or one branch), chronological,
 *      with TWO running balances per row:
 *        • CASH balance   (money physically collected − unit expenses)
 *        • ENTITY balance (the tenant's/account's own arrears AFTER that row
 *          - charges/expenses add to it, payments subtract from it)
 *      Plus opening/closing figures carried forward from all prior history,
 *      per-day grouping and the name of the clerk who recorded each row.
 *
 *   2. generateRecurringLedgerPDF()    - A4 PDF in the same visual style as
 *      the existing account/tenant statement PDFs.
 *
 *   3. fetchClerkRecurringRows()       - one clerk's recurring payments and
 *      unit expenses for a period, with account + tenant names and current
 *      balances resolved. Consumed by buildClerkStatement so the money a
 *      clerk collects from tenants appears ON THEIR OWN statement.
 *
 *   4. fetchClerkRecurringTotals()     - sums of the same before a cut-off
 *      date. Consumed by fetchClerkCumulativeBalance so the clerk's OPENING
 *      custody carries recurring money forward correctly (opening/closing
 *      stay cumulative day-to-day and the statement always reconciles).
 *
 * BRANCH SCOPING NOTE:
 *   RecurringPayment / RecurringExpense have NO branchId field - only the
 *   parent RecurringAccount does. When a branchId filter is requested we
 *   resolve the set of accountIds belonging to that branch and filter by
 *   accountId instead. When branchId is null nothing is filtered (whole
 *   business), which exactly matches how every other recurring flow works.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import path      from "path";
import fs        from "fs";
import mongoose  from "mongoose";

// ── Lazy model imports (same pattern as recurringBilling.js) ──────────────────
const getModels = async () => ({
  RecurringAccount: (await import("../models/recurringAccount.js")).default,
  RecurringTenant:  (await import("../models/recurringTenant.js")).default,
  RecurringInvoice: (await import("../models/recurringInvoice.js")).default,
  RecurringPayment: (await import("../models/recurringPayment.js")).default,
  RecurringExpense: (await import("../models/recurringExpense.js")).default,
});

// ── Small shared helpers ──────────────────────────────────────────────────────

function fmtMoney(n, cur = "USD") {
  const sym = cur === "ZWL" ? "ZWL " : cur === "ZAR" ? "R " : "$ ";
  return `${sym}${Number(n || 0).toFixed(2)}`;
}

function fmtDate(d) {
  return new Date(d).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

function fmtDateTime(d) {
  return new Date(d).toLocaleDateString("en-GB", {
    day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit"
  });
}

function esc(str) {
  return String(str || "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const oid = v => (v instanceof mongoose.Types.ObjectId ? v : new mongoose.Types.ObjectId(String(v)));

// ── Resolve the accountIds that belong to a branch (null = no filter) ─────────
export async function accountIdsForBranch(businessId, branchId) {
  if (!branchId) return null;
  const { RecurringAccount } = await getModels();
  const accts = await RecurringAccount.find({ businessId, branchId }).select("_id").lean();
  return accts.map(a => a._id);
}

// Builds { accountId: {...} } scoping fragment for payment/expense queries
function acctScope(accountIds) {
  return accountIds ? { accountId: { $in: accountIds } } : {};
}

// ── Resolve staff phone → name map (one query, no per-row lookups) ────────────
async function staffNameMap(businessId) {
  try {
    const UserRole = (await import("../models/userRole.js")).default;
    const staff = await UserRole.find({ businessId }).select("phone name role").lean();
    const map = {};
    for (const s of staff) map[String(s.phone || "").replace(/\D/g, "")] = s.name || s.phone;
    return map;
  } catch (_) { return {}; }
}

function recorderName(map, phone) {
  if (!phone) return "System";
  const p = String(phone).replace(/\D/g, "");
  return map[p] || phone;
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. CLERK-SCOPED HELPERS  (consumed by clerk statements)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * All recurring payments + unit expenses RECORDED BY one clerk in a period,
 * with account/tenant names and the tenant's (or account's) CURRENT
 * outstanding balance attached - so the clerk statement can read:
 *   "Billing Payment · Flat 3A – John Moyo (ecocash) · owing $120.00"
 *
 * Returns { paymentRows, expenseRows } where each row already has the shape
 * buildClerkStatement expects: { at, typeLabel, description, credit, debit }.
 */
export async function fetchClerkRecurringRows({ businessId, clerkPhone, branchId = null, start, end }) {
  const { RecurringPayment, RecurringExpense, RecurringAccount, RecurringTenant } = await getModels();

  const accountIds = await accountIdsForBranch(businessId, branchId);
  const scope      = acctScope(accountIds);

  const [payments, expenses] = await Promise.all([
    RecurringPayment.find({
      businessId, createdBy: clerkPhone,
      date: { $gte: start, $lte: end }, ...scope
    }).sort({ date: 1 }).lean(),
    RecurringExpense.find({
      businessId, createdBy: clerkPhone,
      date: { $gte: start, $lte: end }, ...scope
    }).sort({ date: 1 }).lean()
  ]);

  if (!payments.length && !expenses.length) return { paymentRows: [], expenseRows: [] };

  // Batch-resolve every account and tenant referenced (no N+1 queries)
  const acctIds   = [...new Set([...payments, ...expenses].map(r => String(r.accountId)).filter(Boolean))];
  const tenantIds = [...new Set(payments.map(p => p.tenantId && String(p.tenantId)).filter(Boolean))];

  const [accts, tenants] = await Promise.all([
    acctIds.length   ? RecurringAccount.find({ _id: { $in: acctIds } }).select("name ref currentBalance currency").lean()   : [],
    tenantIds.length ? RecurringTenant.find({ _id: { $in: tenantIds } }).select("name currentBalance").lean() : []
  ]);
  const acctMap   = Object.fromEntries(accts.map(a => [String(a._id), a]));
  const tenantMap = Object.fromEntries(tenants.map(t => [String(t._id), t]));

  const paymentRows = payments.map(p => {
    const acct   = acctMap[String(p.accountId)];
    const tenant = p.tenantId ? tenantMap[String(p.tenantId)] : null;
    const who    = tenant ? `${acct?.name || "Account"} – ${tenant.name}` : (acct?.name || "Account");
    const owing  = tenant ? (tenant.currentBalance || 0) : (acct?.currentBalance || 0);
    const method = p.method && p.method !== "cash" ? ` (${p.method})` : "";
    return {
      at: new Date(p.date || p.createdAt),
      typeLabel: "Billing Payment",
      description: `${who}${method}${p.reference ? " · " + p.reference : ""} · owing ${owing.toFixed(2)}`,
      credit: p.amount || 0, debit: 0,
      _rb: { kind: "payment", accountId: p.accountId, tenantId: p.tenantId || null }
    };
  });

  const expenseRows = expenses.map(e => {
    const acct = acctMap[String(e.accountId)];
    return {
      at: new Date(e.date || e.createdAt),
      typeLabel: "Unit Expense",
      description: `${acct?.name || "Account"} – ${e.description || e.category || "Expense"}`,
      credit: 0, debit: e.amount || 0,
      _rb: { kind: "expense", accountId: e.accountId }
    };
  });

  return { paymentRows, expenseRows };
}

/**
 * Sum of recurring payments (IN) and unit expenses (OUT) recorded by a clerk
 * BEFORE a cut-off date. Feeds the clerk's cumulative opening custody so
 * yesterday's rent collections roll into today's opening balance - the whole
 * point of a cumulative statement.
 */
export async function fetchClerkRecurringTotals({ businessId, clerkPhone, branchId = null, before }) {
  try {
    const { RecurringPayment, RecurringExpense } = await getModels();
    const accountIds = await accountIdsForBranch(businessId, branchId);
    const scope      = acctScope(accountIds);
    const beforeDate = new Date(before); beforeDate.setHours(0, 0, 0, 0);

    const [pays, exps] = await Promise.all([
      RecurringPayment.aggregate([
        { $match: { businessId: oid(businessId), createdBy: clerkPhone, date: { $lt: beforeDate }, ...(accountIds ? { accountId: { $in: accountIds } } : {}) } },
        { $group: { _id: null, t: { $sum: "$amount" } } }
      ]).catch(() => []),
      RecurringExpense.aggregate([
        { $match: { businessId: oid(businessId), createdBy: clerkPhone, date: { $lt: beforeDate }, ...(accountIds ? { accountId: { $in: accountIds } } : {}) } },
        { $group: { _id: null, t: { $sum: "$amount" } } }
      ]).catch(() => [])
    ]);

    return { in: pays[0]?.t || 0, out: exps[0]?.t || 0 };
  } catch (_) {
    return { in: 0, out: 0 };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 2. BUSINESS-WIDE RECURRING BILLING STATEMENT
// ═══════════════════════════════════════════════════════════════════════════

/**
 * A bank-statement-style, CUMULATIVE ledger of the whole recurring billing
 * operation for a period:
 *
 *   • Every CHARGE raised (invoice)         → no cash movement, entity +
 *   • Every PAYMENT collected               → cash IN,  entity −
 *   • Every UNIT EXPENSE                    → cash OUT, entity +
 *
 * Per row it shows: date/time, type, account + tenant, description, who
 * recorded it, money in, money out, the running CASH balance, and the
 * tenant's/account's own running balance AFTER that transaction (the "with
 * the money subtracted" figure).
 *
 * Opening cash = all payments − all expenses recorded before periodStart
 * (so closing of the previous period always equals opening of this one).
 * Entity opening balances are seeded per tenant/account from their migrated
 * openingBalance + charges − payments before periodStart, exactly matching
 * buildAccountStatement / buildTenantStatement maths.
 */
export async function buildRecurringLedger({ biz, branchId = null, periodStart, periodEnd }) {
  const { RecurringInvoice, RecurringPayment, RecurringExpense, RecurringAccount, RecurringTenant } = await getModels();
  const businessId = biz._id;
  const cur = biz.currency || "USD";

  const accountIds = await accountIdsForBranch(businessId, branchId);
  const scope      = acctScope(accountIds);
  const invScope   = accountIds ? { accountId: { $in: accountIds } } : {};

  // ── Opening CASH balance (cumulative carry-forward) ─────────────────────────
  const [prevPaid, prevSpent] = await Promise.all([
    RecurringPayment.aggregate([
      { $match: { businessId: oid(businessId), date: { $lt: periodStart }, ...(accountIds ? { accountId: { $in: accountIds } } : {}) } },
      { $group: { _id: null, t: { $sum: "$amount" } } }
    ]).catch(() => []),
    RecurringExpense.aggregate([
      { $match: { businessId: oid(businessId), date: { $lt: periodStart }, ...(accountIds ? { accountId: { $in: accountIds } } : {}) } },
      { $group: { _id: null, t: { $sum: "$amount" } } }
    ]).catch(() => [])
  ]);
  const openingCash = (prevPaid[0]?.t || 0) - (prevSpent[0]?.t || 0);

  // ── This period's rows ───────────────────────────────────────────────────────
  const [invoices, payments, expenses] = await Promise.all([
    RecurringInvoice.find({
      businessId, status: { $ne: "cancelled" },
      periodStart: { $gte: periodStart }, periodEnd: { $lte: periodEnd }, ...invScope
    }).sort({ periodStart: 1 }).lean(),
    RecurringPayment.find({
      businessId, date: { $gte: periodStart, $lte: periodEnd }, ...scope
    }).sort({ date: 1 }).lean(),
    RecurringExpense.find({
      businessId, date: { $gte: periodStart, $lte: periodEnd }, ...scope
    }).sort({ date: 1 }).lean()
  ]);

  // ── Batch-resolve names ──────────────────────────────────────────────────────
  const allAcctIds = [...new Set(
    [...invoices, ...payments, ...expenses].map(r => String(r.accountId)).filter(Boolean)
  )];
  const allTenantIds = [...new Set(
    [...invoices, ...payments].map(r => r.tenantId && String(r.tenantId)).filter(Boolean)
  )];

  const [accts, tenants, staffMap] = await Promise.all([
    allAcctIds.length   ? RecurringAccount.find({ _id: { $in: allAcctIds } }).select("name ref currentBalance").lean() : [],
    allTenantIds.length ? RecurringTenant.find({ _id: { $in: allTenantIds } }).select("name phone accountId openingBalance currentBalance").lean() : [],
    staffNameMap(businessId)
  ]);
  const acctMap   = Object.fromEntries(accts.map(a => [String(a._id), a]));
  const tenantMap = Object.fromEntries(tenants.map(t => [String(t._id), t]));

  // ── Seed each entity's balance AS AT periodStart ─────────────────────────────
  // Entity = tenant when the row is tenant-scoped, else the account. This is
  // what lets the statement print the tenant's own arrears after every row.
  //
  // tenant  opening = tenant.openingBalance + charges(tenant, before) − payments(tenant, before)
  // account opening = Σ tenant openingBalances + charges(acct, before) − payments(acct, before)
  const [tPrevCharged, tPrevPaid, aPrevCharged, aPrevPaid, aTenantOpen] = await Promise.all([
    allTenantIds.length ? RecurringInvoice.aggregate([
      { $match: { businessId: oid(businessId), tenantId: { $in: allTenantIds.map(oid) }, status: { $ne: "cancelled" }, periodStart: { $lt: periodStart } } },
      { $group: { _id: "$tenantId", t: { $sum: "$amount" } } }
    ]).catch(() => []) : [],
    allTenantIds.length ? RecurringPayment.aggregate([
      { $match: { businessId: oid(businessId), tenantId: { $in: allTenantIds.map(oid) }, date: { $lt: periodStart } } },
      { $group: { _id: "$tenantId", t: { $sum: "$amount" } } }
    ]).catch(() => []) : [],
    allAcctIds.length ? RecurringInvoice.aggregate([
      { $match: { businessId: oid(businessId), accountId: { $in: allAcctIds.map(oid) }, status: { $ne: "cancelled" }, periodStart: { $lt: periodStart } } },
      { $group: { _id: "$accountId", t: { $sum: "$amount" } } }
    ]).catch(() => []) : [],
    allAcctIds.length ? RecurringPayment.aggregate([
      { $match: { businessId: oid(businessId), accountId: { $in: allAcctIds.map(oid) }, date: { $lt: periodStart } } },
      { $group: { _id: "$accountId", t: { $sum: "$amount" } } }
    ]).catch(() => []) : [],
    allAcctIds.length ? RecurringTenant.aggregate([
      { $match: { accountId: { $in: allAcctIds.map(oid) } } },
      { $group: { _id: "$accountId", t: { $sum: "$openingBalance" } } }
    ]).catch(() => []) : []
  ]);

  const sumMap = rows => Object.fromEntries(rows.map(r => [String(r._id), r.t || 0]));
  const tCharged = sumMap(tPrevCharged), tPaid = sumMap(tPrevPaid);
  const aCharged = sumMap(aPrevCharged), aPaid = sumMap(aPrevPaid), aOpen = sumMap(aTenantOpen);

  const entityBal = {};   // key: "T:<tenantId>" or "A:<accountId>" → running balance
  for (const tid of allTenantIds) {
    entityBal[`T:${tid}`] = (tenantMap[tid]?.openingBalance || 0) + (tCharged[tid] || 0) - (tPaid[tid] || 0);
  }
  for (const aid of allAcctIds) {
    entityBal[`A:${aid}`] = (aOpen[aid] || 0) + (aCharged[aid] || 0) - (aPaid[aid] || 0);
  }

  const entityKey  = r => (r.tenantId ? `T:${String(r.tenantId)}` : `A:${String(r.accountId)}`);
  const entityName = r => {
    const acct   = acctMap[String(r.accountId)];
    const tenant = r.tenantId ? tenantMap[String(r.tenantId)] : null;
    const a = acct ? `${acct.name}${acct.ref ? " (" + acct.ref + ")" : ""}` : "Account";
    return tenant ? `${a} – ${tenant.name}` : a;
  };

  // ── Flatten into chronological rows ─────────────────────────────────────────
  const rows = [];

  for (const inv of invoices) {
    rows.push({
      at: new Date(inv.periodStart),
      type: "CHARGE", typeLabel: "Charge Raised",
      entity: entityName(inv), entityK: entityKey(inv),
      description: `${inv.number} · ${inv.period}`,
      recorder: recorderName(staffMap, inv.createdBy),
      cashIn: 0, cashOut: 0, entityDelta: +(inv.amount || 0)
    });
  }
  for (const pay of payments) {
    rows.push({
      at: new Date(pay.date),
      type: "PAYMENT", typeLabel: "Payment Received",
      entity: entityName(pay), entityK: entityKey(pay),
      description: `${pay.method || "cash"}${pay.reference ? " · " + pay.reference : ""}${pay.period ? " · " + pay.period : ""}`,
      recorder: recorderName(staffMap, pay.createdBy),
      cashIn: pay.amount || 0, cashOut: 0, entityDelta: -(pay.amount || 0)
    });
  }
  for (const exp of expenses) {
    rows.push({
      at: new Date(exp.date),
      type: "EXPENSE", typeLabel: `Expense${exp.category ? " · " + exp.category : ""}`,
      entity: entityName(exp), entityK: entityKey(exp),
      description: exp.description || "Expense",
      recorder: recorderName(staffMap, exp.createdBy),
      cashIn: 0, cashOut: exp.amount || 0, entityDelta: +(exp.amount || 0)
    });
  }

  rows.sort((a, b) => a.at - b.at);

  // ── Both running balances ────────────────────────────────────────────────────
  let cash = openingCash;
  for (const row of rows) {
    cash += (row.cashIn || 0) - (row.cashOut || 0);
    row.cashBalance = cash;

    const k = row.entityK;
    if (entityBal[k] === undefined) entityBal[k] = 0;
    entityBal[k] += row.entityDelta;
    row.entityBalance = entityBal[k];
  }

  // ── Totals + receivables snapshot ────────────────────────────────────────────
  const totalCharged   = rows.filter(r => r.type === "CHARGE").reduce((s, r) => s + r.entityDelta, 0);
  const totalCollected = rows.reduce((s, r) => s + (r.cashIn  || 0), 0);
  const totalExpenses  = rows.reduce((s, r) => s + (r.cashOut || 0), 0);

  // Outstanding receivables right now (cached account balances - whole scope)
  const recvAgg = await RecurringAccount.aggregate([
    { $match: { businessId: oid(businessId), isActive: true, ...(accountIds ? { _id: { $in: accountIds.map(oid) } } : {}) } },
    { $group: { _id: null, t: { $sum: "$currentBalance" } } }
  ]).catch(() => []);
  const outstandingReceivables = recvAgg[0]?.t || 0;

  return {
    cur,
    periodStart, periodEnd,
    openingCash,
    closingCash: cash,
    totalCharged, totalCollected, totalExpenses,
    outstandingReceivables,
    rows,
    counts: { charges: invoices.length, payments: payments.length, expenses: expenses.length }
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// 3. PDF - same visual language as the account/tenant statement PDFs
// ═══════════════════════════════════════════════════════════════════════════

const OUTPUT_DIR = path.resolve(process.cwd(), "public", "docs", "generated", "recurring");

async function ensureDir() {
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

async function renderHtmlToPdf(html, filepath) {
  const puppeteer = (await import("puppeteer")).default;
  const browser = await puppeteer.launch({ args: ["--no-sandbox", "--disable-setuid-sandbox"] });
  const page    = await browser.newPage();
  await page.emulateMediaType("print");
  await page.setContent(html, { waitUntil: "networkidle0" });
  await new Promise(r => setTimeout(r, 500));
  await page.pdf({ path: filepath, format: "A4", printBackground: true, landscape: true,
    margin: { top: "14mm", bottom: "14mm", left: "10mm", right: "10mm" } });
  await browser.close();
}

function pdfCSS() {
  return `
    <style>
      * { box-sizing: border-box; margin: 0; padding: 0; }
      body { font-family: Arial, Helvetica, sans-serif; font-size: 11px; color: #1e293b; }
      .header { display: flex; justify-content: space-between; align-items: flex-start;
                padding-bottom: 14px; border-bottom: 2px solid #0f172a; margin-bottom: 16px; }
      .biz-name { font-size: 19px; font-weight: 700; color: #0f172a; }
      .biz-sub  { font-size: 11px; color: #64748b; margin-top: 4px; }
      .doc-title { font-size: 14px; font-weight: 700; color: #0f172a; text-align: right; }
      .doc-meta  { font-size: 11px; color: #64748b; text-align: right; margin-top: 4px; line-height: 1.6; }
      .section-title { font-size: 11px; font-weight: 700; color: #64748b;
                       text-transform: uppercase; letter-spacing: .5px;
                       border-bottom: 1px solid #e2e8f0; padding-bottom: 6px; margin: 16px 0 10px; }
      .kpi-row { display: flex; gap: 10px; margin-bottom: 16px; flex-wrap: wrap; }
      .kpi { flex: 1; min-width: 95px; background: #f8fafc; border: 1px solid #e2e8f0;
             border-radius: 8px; padding: 10px 12px; }
      .kpi-label { font-size: 9.5px; color: #64748b; text-transform: uppercase; letter-spacing: .5px; }
      .kpi-val   { font-size: 15px; font-weight: 700; color: #0f172a; margin-top: 4px; }
      .kpi-sub   { font-size: 9px; color: #94a3b8; margin-top: 2px; }
      .kpi-val.green { color: #16a34a; }
      .kpi-val.red   { color: #dc2626; }
      table { width: 100%; border-collapse: collapse; font-size: 10.5px; }
      th { background: #0f172a; color: white; padding: 7px 8px; text-align: left; font-size: 9.5px; }
      td { padding: 6px 8px; border-bottom: 1px solid #f1f5f9; vertical-align: top; }
      .r { text-align: right; }
      .debit  { color: #dc2626; }
      .credit { color: #16a34a; }
      .muted  { color: #64748b; }
      .bold   { font-weight: 700; }
      .day-row td { background: #1e3a5f !important; color: #e0f2fe; font-weight: 600; font-size: 10.5px;
                    border-top: 2px solid #0c2a4a; }
      .day-close-row td { background: #dbeafe !important; color: #1e40af; font-weight: 600; }
      .opening-row td { background: #eff6ff !important; font-weight: 700; color: #1d4ed8; }
      .closing-row td { background: #f0fdf4 !important; font-weight: 700; font-size: 11px; }
      .footer { margin-top: 26px; padding-top: 12px; border-top: 1px solid #e2e8f0;
                font-size: 9.5px; color: #94a3b8; display: flex; justify-content: space-between; }
      @media print { body { -webkit-print-color-adjust: exact; print-color-adjust: exact; } }
    </style>`;
}

export async function generateRecurringLedgerPDF({ biz, stmt, periodLabel: pl, branchName = "" }) {
  await ensureDir();
  const filename = `billing-stmt-${biz._id}-${Date.now()}.pdf`;
  const filepath = path.join(OUTPUT_DIR, filename);
  const cur = stmt.cur;

  // ── Group rows by day, carrying the cash balance across day boundaries ──────
  const dayMap = new Map();
  for (const row of stmt.rows) {
    const key = new Date(row.at).toLocaleDateString("en-GB", { weekday: "long", day: "2-digit", month: "short", year: "numeric" });
    if (!dayMap.has(key)) dayMap.set(key, []);
    dayMap.get(key).push(row);
  }

  let bodyHtml = "";
  let dayOpening = stmt.openingCash;

  if (dayMap.size === 0) {
    bodyHtml = `<tr><td colspan="9" style="text-align:center;padding:28px;color:#9ca3af;font-style:italic">No recurring billing activity in this period</td></tr>`;
  }

  for (const [dayKey, rows] of dayMap) {
    const dayIn    = rows.reduce((s, r) => s + (r.cashIn  || 0), 0);
    const dayOut   = rows.reduce((s, r) => s + (r.cashOut || 0), 0);
    const dayClose = rows[rows.length - 1].cashBalance;

    bodyHtml += `
      <tr class="day-row">
        <td colspan="5">&#x1F4C5; ${esc(dayKey)}</td>
        <td class="r" style="color:#86efac">In: ${fmtMoney(dayIn, cur)}</td>
        <td class="r" style="color:#fca5a5">Out: ${fmtMoney(dayOut, cur)}</td>
        <td class="r" colspan="2">Open: ${fmtMoney(dayOpening, cur)} &rarr; Close: ${fmtMoney(dayClose, cur)}</td>
      </tr>`;

    rows.forEach((row, i) => {
      const stripe   = i % 2 === 1 ? ' style="background:#f8fafc"' : "";
      const timeStr  = new Date(row.at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
      const typeCol  = row.type === "PAYMENT" ? "credit" : row.type === "EXPENSE" ? "debit" : "muted";
      bodyHtml += `
      <tr${stripe}>
        <td class="muted" style="white-space:nowrap">${timeStr}</td>
        <td class="${typeCol} bold">${esc(row.typeLabel)}</td>
        <td>${esc(row.entity)}</td>
        <td class="muted">${esc(row.description)}</td>
        <td class="muted">${esc(row.recorder)}</td>
        <td class="r credit">${row.cashIn  > 0 ? fmtMoney(row.cashIn,  cur) : ""}</td>
        <td class="r debit">${row.cashOut > 0 ? fmtMoney(row.cashOut, cur) : ""}</td>
        <td class="r bold">${fmtMoney(row.cashBalance, cur)}</td>
        <td class="r bold ${row.entityBalance > 0 ? "debit" : "credit"}">${fmtMoney(row.entityBalance, cur)}</td>
      </tr>`;
    });

    bodyHtml += `
      <tr class="day-close-row">
        <td colspan="5">End of ${esc(dayKey.split(",")[0].trim())}</td>
        <td class="r credit">${fmtMoney(dayIn, cur)}</td>
        <td class="r debit">${fmtMoney(dayOut, cur)}</td>
        <td class="r">${fmtMoney(dayClose, cur)}</td>
        <td></td>
      </tr>`;

    dayOpening = dayClose;
  }

  const collectionRate = stmt.totalCharged > 0
    ? Math.round((stmt.totalCollected / stmt.totalCharged) * 100)
    : null;

  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8">${pdfCSS()}</head><body>
    <div class="header">
      <div>
        <div class="biz-name">${esc(biz.name)}</div>
        <div class="biz-sub">${esc(biz.address || "")}${biz.address ? " · " : ""}${esc(cur)}${branchName ? " · " + esc(branchName) : ""}</div>
      </div>
      <div>
        <div class="doc-title">Recurring Billing Statement</div>
        <div class="doc-meta">${esc(pl)}<br>Generated ${fmtDateTime(new Date())}</div>
      </div>
    </div>

    <div class="kpi-row">
      <div class="kpi"><div class="kpi-label">Opening Cash</div>
        <div class="kpi-val">${fmtMoney(stmt.openingCash, cur)}</div>
        <div class="kpi-sub">Carried forward</div></div>
      <div class="kpi"><div class="kpi-label">Charges Raised</div>
        <div class="kpi-val">${fmtMoney(stmt.totalCharged, cur)}</div>
        <div class="kpi-sub">${stmt.counts.charges} invoice(s)</div></div>
      <div class="kpi"><div class="kpi-label">Collected</div>
        <div class="kpi-val green">+${fmtMoney(stmt.totalCollected, cur)}</div>
        <div class="kpi-sub">${stmt.counts.payments} payment(s)${collectionRate !== null ? " · " + collectionRate + "% of charges" : ""}</div></div>
      <div class="kpi"><div class="kpi-label">Unit Expenses</div>
        <div class="kpi-val red">&minus;${fmtMoney(stmt.totalExpenses, cur)}</div>
        <div class="kpi-sub">${stmt.counts.expenses} expense(s)</div></div>
      <div class="kpi"><div class="kpi-label">Closing Cash</div>
        <div class="kpi-val">${fmtMoney(stmt.closingCash, cur)}</div>
        <div class="kpi-sub">Opening + In &minus; Out</div></div>
      <div class="kpi"><div class="kpi-label">Outstanding Owed</div>
        <div class="kpi-val ${stmt.outstandingReceivables > 0 ? "red" : "green"}">${fmtMoney(stmt.outstandingReceivables, cur)}</div>
        <div class="kpi-sub">All tenants, right now</div></div>
    </div>

    <div class="section-title">Cumulative Ledger &mdash; every charge, payment &amp; expense with running balances</div>
    <table>
      <thead><tr>
        <th style="width:44px">Time</th>
        <th style="width:95px">Type</th>
        <th>Account / Tenant</th>
        <th>Detail</th>
        <th style="width:80px">Recorded by</th>
        <th class="r" style="width:70px">In (+)</th>
        <th class="r" style="width:70px">Out (&minus;)</th>
        <th class="r" style="width:78px">Cash Bal</th>
        <th class="r" style="width:78px">A/C Owes</th>
      </tr></thead>
      <tbody>
        <tr class="opening-row">
          <td colspan="7" class="bold">Opening Cash Balance (carried forward from all history before ${fmtDate(stmt.periodStart)})</td>
          <td class="r bold">${fmtMoney(stmt.openingCash, cur)}</td>
          <td></td>
        </tr>
        ${bodyHtml}
        <tr class="closing-row">
          <td colspan="5" class="bold">CLOSING &mdash; End of Period</td>
          <td class="r bold credit">+${fmtMoney(stmt.totalCollected, cur)}</td>
          <td class="r bold debit">&minus;${fmtMoney(stmt.totalExpenses, cur)}</td>
          <td class="r bold">${fmtMoney(stmt.closingCash, cur)}</td>
          <td></td>
        </tr>
      </tbody>
    </table>

    <div style="margin-top:12px;font-size:9.5px;color:#94a3b8;line-height:1.6">
      <b>How to read this:</b> "Cash Bal" is the cumulative money physically collected minus unit expenses
      (charges don't move cash). "A/C Owes" is that tenant's (or account's) own balance immediately AFTER
      the row - a charge or expense pushes it up, a payment pulls it down. Red = they owe, green = cleared / in credit.
    </div>

    <div class="footer">
      <span>${esc(biz.name)} - Recurring Billing Statement</span>
      <span>Generated ${fmtDateTime(new Date())} · ZimQuote</span>
    </div>
  </body></html>`;

  await renderHtmlToPdf(html, filepath);
  const site = (process.env.SITE_URL || "").replace(/\/$/, "");
  const url  = `${site}/docs/generated/recurring/${filename}`;
  return { filename, filepath, url };
}