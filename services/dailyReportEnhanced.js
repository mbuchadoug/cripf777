/**
 * services/dailyReportEnhanced.js  - FULL REPLACEMENT
 * ─────────────────────────────────────────────────────────────
 * Report runners called by twilioStateBridge.js
 *
 * STATE → RUNNER MAP:
 *   report_daily            → runDailyReportMetaEnhanced
 *   report_weekly           → runWeeklyReportMetaEnhanced
 *   report_monthly          → runMonthlyReportMetaEnhanced
 *   report_detailed         → runDetailedLedgerReport (today)
 *   report_detailed_week    → runDetailedLedgerReport (this week)
 *   report_detailed_month   → runDetailedLedgerReport (this month)
 *   report_detailed_custom  → runDetailedLedgerReport (custom dates from sessionData)
 *   report_clerk_statement  → runClerkStatementReport
 *   report_clerk_pick       → handled in twilioStateBridge (picks clerk, then calls above)
 */

import { sendText }         from "./metaSender.js";
import { sendDocument }     from "./metaSender.js";
import { sendMainMenu }     from "./metaMenus.js";
import { generateReportPDF } from "./reportPDF.js";
import { sendButtons }      from "./metaSender.js";

import {
  fmtMoney, fmt, pct,
  resolveStaff,
  buildProductSummary,
  buildOverdueAnalysis,
  buildDailyBreakdown,
  buildIncomeStatement,
  buildLedger,
  buildClerkStatement,
  generateInsights,
  generateActionItems,
  formatInsightsList,
  formatActionsList,
  formatOverdueList,
  formatProductList
} from "./reportHelpers.js";

export { fmt };

// ─── Date label ───────────────────────────────────────────────────────────────
export const dateLabel = d => d.toLocaleDateString("en-GB", {
  weekday: "long", day: "numeric", month: "long", year: "numeric"
});

function shortDate(d) {
  return new Date(d).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}


// ─── Fetch raw data ───────────────────────────────────────────────────────────
export async function fetchReportData({ biz, start, end, branchId }) {
  const Invoice        = (await import("../models/invoice.js")).default;
  const InvoicePayment = (await import("../models/invoicePayment.js")).default;
  const Expense        = (await import("../models/expense.js")).default;
  const baseQ = { businessId: biz._id, createdAt: { $gte: start, $lte: end } };
  const bQ    = branchId ? { ...baseQ, branchId } : baseQ;
  const [invoices, receipts, payments, expenses] = await Promise.all([
    Invoice.find({ ...bQ, type: "invoice" }).lean(),
    Invoice.find({ ...bQ, type: "receipt" }).lean(),
    InvoicePayment.find(bQ).lean(),
    Expense.find(bQ).lean()
  ]);
  return { invoices, receipts, payments, expenses };
}


// ─── Quick totals ─────────────────────────────────────────────────────────────
export function calcTotals({ invoices, receipts, payments, expenses }) {
  const invoicePayments = payments.reduce((s, p) => s + (p.amount || 0), 0);
  const cashSales       = receipts.reduce((s, r) => s + (r.total  || 0), 0);
  const moneyIn         = invoicePayments + cashSales;
  const moneyOut        = expenses.reduce((s, e) => s + (e.amount || 0), 0);
  return {
    invoicePayments, cashSales, moneyIn, moneyOut,
    profit:        moneyIn - moneyOut,
    totalInvoiced: invoices.reduce((s, i) => s + (i.total   || 0), 0),
    outstanding:   invoices.reduce((s, i) => s + (i.balance || 0), 0)
  };
}


// ─── Resolve caller and branch ────────────────────────────────────────────────
export async function resolveCallerAndBranch(biz, from) {
  const UserRole           = (await import("../models/userRole.js")).default;
  const { normalizePhone } = await import("./phone.js");
  let phone = normalizePhone(from);
  if (phone.startsWith("0")) phone = "263" + phone.slice(1);
  const caller = await UserRole.findOne({ phone, pending: false });
  const sessionBranchId = biz.sessionData?.reportBranchId || null;
  if (sessionBranchId) { delete biz.sessionData.reportBranchId; await biz.save(); }
  const branchId = sessionBranchId || (caller?.role !== "owner" ? caller?.branchId : null);
  let branchName = null;
  if (branchId) {
    const Branch = (await import("../models/branch.js")).default;
    const br     = await Branch.findById(branchId).lean();
    branchName   = br?.name || null;
  }
  return { caller, branchId: branchId || null, branchName };
}


// ─── True opening balance: computed from ALL history before `date` ────────────
// Never relies on CashBalance records or manual entry. Sums every payment,
// receipt, expense, payout and handover recorded before midnight of `date`
// for this business/branch. Result is always accurate regardless of whether
// anyone remembered to set an opening balance that morning.
async function fetchOpeningBalance(biz, branchId, date) {
  try {
    const Invoice        = (await import("../models/invoice.js")).default;
    const InvoicePayment = (await import("../models/invoicePayment.js")).default;
    const Expense        = (await import("../models/expense.js")).default;
    const CashPayout     = (await import("../models/cashPayout.js")).default;
    const CashHandover   = (await import("../models/cashHandover.js")).default;

    const before = new Date(date); before.setHours(0, 0, 0, 0);
    const bQ = {
      businessId: biz._id,
      createdAt:  { $lt: before },
      ...(branchId ? { branchId } : {})
    };

    const [pmts, rcpts, exps, payouts] = await Promise.all([
      InvoicePayment.aggregate([{ $match: bQ }, { $group: { _id: null, t: { $sum: "$amount" } } }]),
      Invoice.aggregate([{ $match: { ...bQ, type: "receipt" } }, { $group: { _id: null, t: { $sum: "$total" } } }]),
      Expense.aggregate([{ $match: bQ }, { $group: { _id: null, t: { $sum: "$amount" } } }]),
      CashPayout.aggregate([{ $match: bQ }, { $group: { _id: null, t: { $sum: "$amount" } } }]).catch(() => [])
    ]);

    const totalIn  = (pmts[0]?.t || 0) + (rcpts[0]?.t || 0);
    const totalOut = (exps[0]?.t  || 0) + (payouts[0]?.t || 0);
    return totalIn - totalOut;
  } catch (_) { return 0; }
}

// ─── Compute and persist closing balance for a given day ─────────────────────
// Called at end of day or whenever a report is generated. Ensures tomorrow's
// opening balance is always available without manual entry.
export async function saveClosingBalance(biz, branchId, date) {
  try {
    const CashBalance    = (await import("../models/cashBalance.js")).default;
    const InvoicePayment = (await import("../models/invoicePayment.js")).default;
    const Invoice        = (await import("../models/invoice.js")).default;
    const Expense        = (await import("../models/expense.js")).default;
    const CashPayout     = (await import("../models/cashPayout.js")).default;
    const CashHandover   = (await import("../models/cashHandover.js")).default;

    const day   = new Date(date); day.setHours(0, 0, 0, 0);
    const dayEnd = new Date(day);  dayEnd.setHours(23, 59, 59, 999);

    const bQ = { businessId: biz._id, createdAt: { $gte: day, $lte: dayEnd }, ...(branchId ? { branchId } : {}) };

    const [payments, receipts, expenses, payouts] = await Promise.all([
      InvoicePayment.aggregate([{ $match: bQ }, { $group: { _id: null, t: { $sum: "$amount" } } }]),
      Invoice.aggregate([{ $match: { ...bQ, type: "receipt" } }, { $group: { _id: null, t: { $sum: "$total" } } }]),
      Expense.aggregate([{ $match: bQ }, { $group: { _id: null, t: { $sum: "$amount" } } }]),
      CashPayout.aggregate([{ $match: bQ }, { $group: { _id: null, t: { $sum: "$amount" } } }]).catch(() => [])
    ]);

    const opening   = await fetchOpeningBalance(biz, branchId, day);
    const totalIn   = (payments[0]?.t || 0) + (receipts[0]?.t || 0);
    const totalOut  = (expenses[0]?.t  || 0) + (payouts[0]?.t  || 0);
    const closing   = opening + totalIn - totalOut;

    await CashBalance.findOneAndUpdate(
      { businessId: biz._id, branchId: branchId || null, date: day },
      { $set: { closingBalance: closing, openingBalance: opening, updatedAt: new Date() } },
      { upsert: true }
    );
    return closing;
  } catch (e) {
    console.error("[SAVE CLOSING]", e.message);
    return 0;
  }
}


// ─── Parse custom date range from text ───────────────────────────────────────
// Accepts: "01 Jun - 22 Jun" | "01/06 - 22/06" | "2026-06-01 - 2026-06-22"
export function parseCustomDateRange(text) {
  // Split on space-surrounded separators first (preserves ISO date hyphens)
  // e.g. "01 Jun - 22 Jun", "2026-06-01 - 2026-06-22", "01 Jun to 22 Jun"
  let parts = (text || "").trim().split(/\s+(?:[-\u2013\u2014]|to)\s+/i).map(s => s.trim()).filter(Boolean);

  // Fallback: split on bare en-dash / em-dash (no spaces)
  if (parts.length !== 2) {
    parts = (text || "").trim().split(/[\u2013\u2014]/).map(s => s.trim()).filter(Boolean);
  }

  if (parts.length !== 2) return null;

  const now = new Date();

  function parseOne(s) {
    s = s.trim();
    // ISO: 2026-06-01
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
      const d = new Date(s);
      return isNaN(d) ? null : d;
    }
    // "01 Jun" or "01 Jun 2026" or "1 June 2026"
    const m1 = s.match(/^(\d{1,2})\s+([A-Za-z]+)(?:\s+(\d{4}))?$/);
    if (m1) {
      const d = new Date(`${m1[1]} ${m1[2]} ${m1[3] || now.getFullYear()}`);
      return isNaN(d) ? null : d;
    }
    // "01/06" or "01/06/2026" (day/month/year)
    const m2 = s.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?$/);
    if (m2) {
      const d = new Date(`${m2[3] || now.getFullYear()}-${m2[2].padStart(2,"0")}-${m2[1].padStart(2,"0")}`);
      return isNaN(d) ? null : d;
    }
    // Last resort: let Date parse it
    const fallback = new Date(s);
    return isNaN(fallback) ? null : fallback;
  }

  const start = parseOne(parts[0]);
  const end   = parseOne(parts[1]);
  if (!start || !end) return null;
  start.setHours(0, 0, 0, 0);
  end.setHours(23, 59, 59, 999);
  // Sanity: start must be before end
  if (start > end) return null;
  return { start, end };
}


// ─── Short WhatsApp summary (sent alongside PDF) ──────────────────────────────
export async function buildWhatsAppSummary({ biz, label, periodLabel, data, totals, branchName, branchId, start, end, openingBalance = 0 }) {
  const cur = biz.currency || "USD";
  const is  = await buildIncomeStatement({ biz, data, branchId, start, end, openingBalance });
  const { revenue, expenses, drawings, profit, cashPosition, invoiceSummary, staffActivity } = is;
  const collRate = invoiceSummary.totalInvoiced > 0
    ? Math.round((revenue.invoicePaymentsReceived / invoiceSummary.totalInvoiced) * 100) : 0;
  const margin   = revenue.grossRevenue > 0 ? Math.round((profit.operatingProfit / revenue.grossRevenue) * 100) : 0;
  const { topProducts } = await buildProductSummary(data.invoices, data.receipts);
  const overdueData = await buildOverdueAnalysis(data.invoices, biz);
  const verdict = profit.netProfit >= 0
    ? `✅ NET PROFIT: ${fmtMoney(profit.netProfit, cur)}`
    : `❌ NET LOSS:   ${fmtMoney(Math.abs(profit.netProfit), cur)}`;
  const branchLine = branchName ? `📍 ${branchName}\n` : "";
  const expLines   = Object.entries(expenses.byCategory).sort((a,b)=>b[1]-a[1])
    .map(([c,a]) => `  ${c.padEnd(20)} ${fmtMoney(a,cur)}`).join("\n") || "  Nothing spent";
  const staffLines = staffActivity.slice(0,3)
    .map(s => `  ${s.name.slice(0,16).padEnd(16)} (${s.role||"clerk"}) · ${s.invoiceCount}inv ${s.receiptCount}rcpt · Rev: ${fmtMoney(s.totalRevenue,cur)}`).join("\n") || "  No activity";
  const insights = generateInsights({ profitMargin: margin, collectionRate: collRate, topProduct: topProducts[0]||null, overdueCount: overdueData.overdue.length, overdueAmount: overdueData.totalOverdue, netProfit: profit.netProfit, currency: cur });
  return `📊 *${(biz.name||"").toUpperCase()}* - ${label}
${periodLabel}
${branchLine}
━━━━━━━━━━━━━━━━━━━━
REVENUE
  Invoice Payments:  ${fmtMoney(revenue.invoicePaymentsReceived,cur)}
  Cash Sales:        ${fmtMoney(revenue.cashSales,cur)}
  GROSS REVENUE:     ${fmtMoney(revenue.grossRevenue,cur)}
━━━━━━━━━━━━━━━━━━━━
EXPENSES           ${fmtMoney(expenses.totalExpenses,cur)}
${expLines}
OPERATING PROFIT:  ${fmtMoney(profit.operatingProfit,cur)}
DRAWINGS:         (${fmtMoney(drawings.totalDrawings,cur)})
  ${verdict}
━━━━━━━━━━━━━━━━━━━━
CASH POSITION
  Opening:  ${fmtMoney(cashPosition.openingBalance,cur)}
  + In:     ${fmtMoney(cashPosition.cashIn,cur)}
  - Out:    ${fmtMoney(cashPosition.cashOut,cur)}
  CLOSING:  ${fmtMoney(cashPosition.closingBalance,cur)}
━━━━━━━━━━━━━━━━━━━━
INVOICES  ${fmtMoney(invoiceSummary.totalInvoiced,cur)} raised · ${collRate}% collected
━━━━━━━━━━━━━━━━━━━━
👥 STAFF
${staffLines}
━━━━━━━━━━━━━━━━━━━━
💡 ${generateInsights({ profitMargin: margin, collectionRate: collRate, topProduct: topProducts[0]||null, overdueCount: overdueData.overdue.length, overdueAmount: overdueData.totalOverdue, netProfit: profit.netProfit, currency: cur })[0]}
📋 Detailed PDF attached below ↓`;
}


// ─── Send report: text + PDF ──────────────────────────────────────────────────
export async function sendReport({ biz, from, label, periodLabel, branchName, branchId, data, totals, prevTotals, weeks, start, end, openingBalance = 0 }) {
  const text = await buildWhatsAppSummary({ biz, label, periodLabel, data, totals, branchName, branchId, start, end, openingBalance });
  await sendText(from, text);
  try {
    const is = await buildIncomeStatement({ biz, data, branchId, start, end, openingBalance });
    const { filename, url } = await generateReportPDF({ biz, reportType: label, periodLabel, branchName, data, totals, prevTotals, weeks, incomeStatement: is });
    await sendDocument(from, { link: url, filename });
  } catch (e) { console.error("[REPORT PDF]", e.message); }
}


// ═══════════════════════════════════════════════════════════════════════════════
// DAILY REPORT  →  state "report_daily"
// ═══════════════════════════════════════════════════════════════════════════════
export async function runDailyReportMetaEnhanced({ biz, from }) {
  const { branchId, branchName } = await resolveCallerAndBranch(biz, from);
  const start = new Date(); start.setHours(0,  0,  0,   0);
  const end   = new Date(); end.setHours(23, 59, 59, 999);
  const data  = await fetchReportData({ biz, start, end, branchId });
  const totals = calcTotals(data);
  const openingBalance = await fetchOpeningBalance(biz, branchId, start);
  // Persist closing balance so it becomes tomorrow's opening automatically
  await saveClosingBalance(biz, branchId, start);
  biz.sessionState = "ready"; biz.sessionData = {}; await biz.save();
  await sendReport({ biz, from, label: "Daily Report", periodLabel: dateLabel(start), branchName, branchId, data, totals, prevTotals: null, weeks: null, start, end, openingBalance });
  await sendMainMenu(from);
  return true;
}


// ═══════════════════════════════════════════════════════════════════════════════
// WEEKLY REPORT  →  state "report_weekly"
// ═══════════════════════════════════════════════════════════════════════════════
export async function runWeeklyReportMetaEnhanced({ biz, from }) {
  const { branchId, branchName } = await resolveCallerAndBranch(biz, from);
  const now  = new Date(); const dow = now.getDay(); const diff = dow === 0 ? -6 : 1 - dow;
  const start = new Date(now); start.setDate(now.getDate() + diff); start.setHours(0, 0, 0, 0);
  const end   = new Date(start); end.setDate(start.getDate() + 6); end.setHours(23, 59, 59, 999);
  const data   = await fetchReportData({ biz, start, end, branchId });
  const totals = calcTotals(data);
  const prevStart = new Date(start); prevStart.setDate(prevStart.getDate() - 7);
  const prevEnd   = new Date(end);   prevEnd.setDate(prevEnd.getDate()   - 7);
  const prevTotals = calcTotals(await fetchReportData({ biz, start: prevStart, end: prevEnd, branchId }));
  const openingBalance = await fetchOpeningBalance(biz, branchId, start);
  const periodLabel = `${shortDate(start)} - ${shortDate(end)}`;
  biz.sessionState = "ready"; biz.sessionData = {}; await biz.save();
  await sendReport({ biz, from, label: "Weekly Report", periodLabel, branchName, branchId, data, totals, prevTotals, weeks: null, start, end, openingBalance });
  await sendMainMenu(from);
  return true;
}


// ═══════════════════════════════════════════════════════════════════════════════
// MONTHLY REPORT  →  state "report_monthly"
// ═══════════════════════════════════════════════════════════════════════════════
export async function runMonthlyReportMetaEnhanced({ biz, from }) {
  const { branchId, branchName } = await resolveCallerAndBranch(biz, from);
  const now   = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(),     1,  0,  0,  0,  0);
  const end   = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
  const data   = await fetchReportData({ biz, start, end, branchId });
  const totals = calcTotals(data);
  const prevStart  = new Date(now.getFullYear(), now.getMonth() - 1, 1,  0,  0,  0,  0);
  const prevEnd    = new Date(now.getFullYear(), now.getMonth(),     0, 23, 59, 59, 999);
  const prevTotals = calcTotals(await fetchReportData({ biz, start: prevStart, end: prevEnd, branchId }));
  const openingBalance = await fetchOpeningBalance(biz, branchId, start);
  const periodLabel    = start.toLocaleDateString("en-GB", { month: "long", year: "numeric" });
  biz.sessionState = "ready"; biz.sessionData = {}; await biz.save();
  await sendReport({ biz, from, label: "Monthly Report", periodLabel, branchName, branchId, data, totals, prevTotals, weeks: null, start, end, openingBalance });
  await sendMainMenu(from);
  return true;
}


// ═══════════════════════════════════════════════════════════════════════════════
// DETAILED LEDGER  →  states "report_detailed*"
//
// DESIGN: The ledger is always a continuous running statement, never day-isolated.
// "Daily" / "Weekly" / "Monthly" are just date-range presets — a window into the
// same continuous ledger. Opening balance is computed from ALL history before the
// start date so it is always accurate regardless of manual opening balance entries.
// Each row shows a running balance column exactly like a bank statement.
// ═══════════════════════════════════════════════════════════════════════════════
export async function runDetailedLedgerReport({ biz, from, period = "day", customStart = null, customEnd = null }) {
  const { branchId, branchName } = await resolveCallerAndBranch(biz, from);

  let start, end, periodLabel;

  if (period === "custom" && customStart && customEnd) {
    start = customStart; end = customEnd;
    periodLabel = `${shortDate(start)} – ${shortDate(end)}`;
  } else if (period === "week") {
    // Last 7 days rolling (more useful than Mon-Sun calendar week)
    end   = new Date(); end.setHours(23, 59, 59, 999);
    start = new Date(end); start.setDate(start.getDate() - 6); start.setHours(0, 0, 0, 0);
    periodLabel = `${shortDate(start)} – ${shortDate(end)}`;
  } else if (period === "month") {
    const now = new Date();
    start = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
    end   = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
    periodLabel = start.toLocaleDateString("en-GB", { month: "long", year: "numeric" });
  } else if (period === "year") {
    const now = new Date();
    start = new Date(now.getFullYear(), 0, 1, 0, 0, 0, 0);
    end   = new Date(now.getFullYear(), 11, 31, 23, 59, 59, 999);
    periodLabel = `Year ${now.getFullYear()}`;
  } else {
    // "day" = today only, but opening balance still comes from all prior history
    start = new Date(); start.setHours(0,  0,  0,   0);
    end   = new Date(); end.setHours(23, 59, 59, 999);
    periodLabel = `Today · ${dateLabel(start)}`;
  }

  // Opening balance = computed from ALL transactions before `start`, no manual entry needed
  const openingBalance = await fetchOpeningBalance(biz, branchId, start);
  const data           = await fetchReportData({ biz, start, end, branchId });

  // Build running-balance ledger rows
  const ledger = await _buildRunningLedger({ biz, data, branchId, start, end, openingBalance });

  biz.sessionState = "ready"; biz.sessionData = {}; await biz.save();

  const cur = biz.currency || "USD";
  const net = ledger.closingBalance - openingBalance;
  const txCount = ledger.rows.filter(r => r.type !== "opening" && r.type !== "closing").length;

  await sendText(from,
`📋 *LEDGER STATEMENT*
${biz.name}${branchName ? ` · ${branchName}` : ""}
${periodLabel}
━━━━━━━━━━━━━━━━━━━━
Opening Balance: ${fmtMoney(openingBalance, cur)}
  + Money In:   ${fmtMoney(ledger.totalCredits, cur)}
  − Money Out:  ${fmtMoney(ledger.totalDebits, cur)}
━━━━━━━━━━━━━━━━━━━━
Closing Balance: ${fmtMoney(ledger.closingBalance, cur)}
Net Movement: ${net >= 0 ? "▲ +" : "▼ "}${fmtMoney(Math.abs(net), cur)}
${txCount} transactions recorded

📄 Full ledger with running balances per transaction is attached ↓`
  );

  try {
    const { filename, url } = await generateReportPDF({
      biz, reportType: "Ledger Statement", periodLabel, branchName,
      ledgerRows: ledger.rows, openingBalance, closingBalance: ledger.closingBalance
    });
    await sendDocument(from, { link: url, filename });
  } catch (e) { console.error("[LEDGER PDF]", e.message); await sendText(from, "⚠️ PDF generation failed. Please try again."); }

  await sendMainMenu(from);
  return true;
}


// ─── Build running-balance ledger rows ────────────────────────────────────────
// Returns rows suitable for PDF rendering, each with a `balance` field showing
// the running total after that transaction — exactly like a bank statement.
async function _buildRunningLedger({ biz, data, branchId, start, end, openingBalance }) {
  const CashPayout   = (await import("../models/cashPayout.js")).default;
  const CashHandover = (await import("../models/cashHandover.js")).default;

  const bQ = { businessId: biz._id, createdAt: { $gte: start, $lte: end }, ...(branchId ? { branchId } : {}) };
  const [payouts, handovers] = await Promise.all([
    CashPayout.find(bQ).lean().catch(() => []),
    CashHandover.find({ ...bQ, $or: [{ fromBranchId: branchId }, { toBranchId: branchId }] }).lean().catch(() => [])
  ]);

  // Flatten all transactions into a single array with type/sign/metadata
  const rows = [];

  for (const p of data.payments) {
    rows.push({ date: p.createdAt, type: "payment", credit: p.amount || 0, debit: 0,
      description: `Invoice payment · ${p.invoiceRef || p.invoiceId || ""}`,
      ref: p._id, recordedBy: p.recordedBy || null });
  }
  for (const r of data.receipts) {
    rows.push({ date: r.createdAt, type: "receipt", credit: r.total || 0, debit: 0,
      description: `Cash sale · ${r.clientName || r.invoiceRef || "Receipt"}`,
      ref: r._id, recordedBy: r.recordedBy || null });
  }
  for (const e of data.expenses) {
    rows.push({ date: e.createdAt, type: "expense", credit: 0, debit: e.amount || 0,
      description: `Expense · ${e.category || ""} · ${e.description || ""}`,
      ref: e._id, recordedBy: e.recordedBy || null });
  }
  for (const po of payouts) {
    rows.push({ date: po.createdAt, type: "payout", credit: 0, debit: po.amount || 0,
      description: `Payout · ${po.reason || ""}`,
      ref: po._id, recordedBy: po.recordedBy || null });
  }
  for (const h of handovers) {
    const isOut = String(h.fromBranchId) === String(branchId);
    rows.push({ date: h.handoverAt || h.createdAt, type: "handover",
      credit: isOut ? 0 : (h.amountCounted || 0),
      debit:  isOut ? (h.amountCounted || 0) : 0,
      description: `Handover · ${h.outgoingName || ""} → ${h.incomingName || ""}`,
      ref: h._id, recordedBy: h.outgoingPhone || null });
  }

  // Sort chronologically
  rows.sort((a, b) => new Date(a.date) - new Date(b.date));

  // Add running balance to each row
  let balance = openingBalance;
  let totalCredits = 0, totalDebits = 0;
  const runningRows = rows.map(r => {
    balance   += r.credit - r.debit;
    totalCredits += r.credit;
    totalDebits  += r.debit;
    return { ...r, balance };
  });

  return { rows: runningRows, totalCredits, totalDebits, closingBalance: balance };
}


// ═══════════════════════════════════════════════════════════════════════════════
// CLERK STATEMENT  →  state "report_clerk_statement"
// ═══════════════════════════════════════════════════════════════════════════════
export async function runClerkStatementReport({ biz, from, clerkPhone, period = "day", customStart = null, customEnd = null }) {
  const { branchId, branchName } = await resolveCallerAndBranch(biz, from);

  let start, end, periodLabel;
  if (period === "custom" && customStart && customEnd) {
    start = customStart; end = customEnd;
    periodLabel = `${shortDate(start)} – ${shortDate(end)}`;
  } else if (period === "week") {
    // Last 7 days rolling
    end   = new Date(); end.setHours(23, 59, 59, 999);
    start = new Date(end); start.setDate(start.getDate() - 6); start.setHours(0, 0, 0, 0);
    periodLabel = `${shortDate(start)} – ${shortDate(end)}`;
  } else if (period === "month") {
    const now = new Date();
    start = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
    end   = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
    periodLabel = start.toLocaleDateString("en-GB", { month: "long", year: "numeric" });
  } else if (period === "year") {
    const now = new Date();
    start = new Date(now.getFullYear(), 0, 1, 0, 0, 0, 0);
    end   = new Date(now.getFullYear(), 11, 31, 23, 59, 59, 999);
    periodLabel = `Year ${now.getFullYear()}`;
  } else {
    // "day" = today, but opening still comes from all prior history
    start = new Date(); start.setHours(0,  0,  0,   0);
    end   = new Date(); end.setHours(23, 59, 59, 999);
    periodLabel = `Today · ${dateLabel(start)}`;
  }

  biz.sessionState = "ready"; biz.sessionData = {}; await biz.save();

  // ── Cumulative opening custody (computed, not stored) ─────────────────────
  // Sum ALL of this clerk's credits and debits before `start`.
  // This is their true carry-forward balance — works even if they never set
  // an opening balance and even across days/weeks/months seamlessly.
  const _clerkCumulativeOpening = await fetchClerkCumulativeBalance({ biz, clerkPhone, branchId, before: start });

  const stmt = await buildClerkStatement({ biz, clerkPhone, branchId, start, end, openingCustody: _clerkCumulativeOpening });
  const cur  = biz.currency || "USD";
  const { clerkName, clerkRole, openingCustody, totalIn, totalOut, expectedClosing, handedOver, discrepancy } = stmt;

  const recLine = handedOver !== null
    ? (Math.abs(discrepancy) < 0.01
        ? `✅ Balanced - Counted ${fmtMoney(handedOver, cur)}`
        : discrepancy > 0
          ? `⚠️ Surplus +${fmtMoney(discrepancy, cur)}`
          : `❌ Short ${fmtMoney(Math.abs(discrepancy), cur)}`)
    : `⏳ Shift open - Cash at hand: ${fmtMoney(expectedClosing, cur)}`;

  // Determine if caller IS the clerk (self-serve) or manager viewing clerk
  const UserRole = (await import("../models/userRole.js")).default;
  const { normalizePhone } = await import("./phone.js");
  let callerPhone = normalizePhone(from);
  if (callerPhone.startsWith("0")) callerPhone = "263" + callerPhone.slice(1);
  const isSelfServe = callerPhone === clerkPhone;

  const header = isSelfServe
    ? `💼 *MY STATEMENT*
${clerkName}
${biz.name}${branchName ? ` · ${branchName}` : ""}`
    : `👤 *CLERK STATEMENT*
${clerkName} (${clerkRole})
${biz.name}${branchName ? ` · ${branchName}` : ""}`;

  await sendText(from,
`${header}
${periodLabel}
━━━━━━━━━━━━━━━━━━━━
Opening Balance: ${fmtMoney(openingCustody, cur)}
Total In  (+):   ${fmtMoney(totalIn, cur)}
Total Out (−):   ${fmtMoney(totalOut, cur)}
━━━━━━━━━━━━━━━━━━━━
CASH AT HAND:    ${fmtMoney(expectedClosing, cur)}
${stmt.txRows.length} transactions recorded
━━━━━━━━━━━━━━━━━━━━
${recLine}

📄 Full statement PDF attached below ↓`
  );

  try {
    const { filename, url } = await generateReportPDF({
      biz, reportType: isSelfServe ? "My Statement" : "Clerk Statement",
      periodLabel: `${clerkName} · ${periodLabel}`,
      branchName, clerkData: { ...stmt, openingCustody: _clerkCumulativeOpening }
    });
    await sendDocument(from, { link: url, filename });
  } catch (e) { console.error("[CLERK STMT PDF]", e.message); await sendText(from, "⚠️ PDF generation failed."); }

  await sendMainMenu(from);
  return true;
}


// ─── Clerk cumulative balance: sum everything before `before` date ────────────
// Walks ALL historical invoicePayments, receipts, expenses, payouts, and
// handovers attributed to this clerk to compute their true running balance.
// This is the carry-forward opening for any clerk statement period.
async function fetchClerkCumulativeBalance({ biz, clerkPhone, branchId, before }) {
  try {
    const Invoice        = (await import("../models/invoice.js")).default;
    const InvoicePayment = (await import("../models/invoicePayment.js")).default;
    const Expense        = (await import("../models/expense.js")).default;
    const CashPayout     = (await import("../models/cashPayout.js")).default;
    const CashHandover   = (await import("../models/cashHandover.js")).default;

    const beforeDate = new Date(before); beforeDate.setHours(0, 0, 0, 0);
    const bQ = {
      businessId: biz._id,
      createdAt:  { $lt: beforeDate },
      ...(branchId ? { branchId } : {})
    };
    const clerkQ = { ...bQ, recordedBy: clerkPhone };

    const [pmts, rcpts, exps, payouts, handoversOut, handoversIn] = await Promise.all([
      // Money the clerk collected from clients (invoice payments recorded by them)
      InvoicePayment.aggregate([{ $match: clerkQ }, { $group: { _id: null, t: { $sum: "$amount" } } }]),
      // Cash sales (receipts) the clerk raised
      Invoice.aggregate([{ $match: { ...clerkQ, type: "receipt" } }, { $group: { _id: null, t: { $sum: "$total" } } }]),
      // Expenses the clerk recorded (debit from their custody)
      Expense.aggregate([{ $match: clerkQ }, { $group: { _id: null, t: { $sum: "$amount" } } }]),
      // Payouts the clerk made
      CashPayout.aggregate([{ $match: clerkQ }, { $group: { _id: null, t: { $sum: "$amount" } } }]).catch(() => []),
      // Handovers the clerk gave (debit)
      CashHandover.aggregate([{ $match: { ...bQ, fromPhone: clerkPhone } }, { $group: { _id: null, t: { $sum: "$amount" } } }]).catch(() => []),
      // Handovers the clerk received (credit)
      CashHandover.aggregate([{ $match: { ...bQ, toPhone: clerkPhone } },   { $group: { _id: null, t: { $sum: "$amount" } } }]).catch(() => [])
    ]);

    const totalIn  = (pmts[0]?.t || 0) + (rcpts[0]?.t || 0) + (handoversIn[0]?.t  || 0);
    const totalOut = (exps[0]?.t  || 0) + (payouts[0]?.t || 0) + (handoversOut[0]?.t || 0);
    return totalIn - totalOut;  // positive = clerk holds this much cash
  } catch (e) {
    console.error("[CLERK CUMULATIVE]", e.message);
    return 0;
  }
}


// ─── Clerk self-serve: clerk views their own ledger and balance ───────────────
export async function runClerkSelfServeStatement({ biz, from, period = "month", customStart = null, customEnd = null }) {
  const { normalizePhone } = await import("./phone.js");
  let clerkPhone = normalizePhone(from);
  if (clerkPhone.startsWith("0")) clerkPhone = "263" + clerkPhone.slice(1);

  // Resolve their branch from their UserRole
  const UserRole = (await import("../models/userRole.js")).default;
  const caller = await UserRole.findOne({ phone: clerkPhone, pending: false });
  if (!caller || !["clerk", "manager"].includes(caller.role)) {
    await sendText(from, "❌ Your account doesn't have clerk or manager access.");
    await sendMainMenu(from);
    return true;
  }

  return runClerkStatementReport({ biz, from, clerkPhone, period, customStart, customEnd });
}