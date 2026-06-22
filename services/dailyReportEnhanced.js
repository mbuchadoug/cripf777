/**
 * services/dailyReportEnhanced.js  — FULL REPLACEMENT
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


// ─── Opening balance ─────────────────────────────────────────────────────────
async function fetchOpeningBalance(biz, branchId, date) {
  try {
    const CashBalance = (await import("../models/cashBalance.js")).default;
    const day = new Date(date); day.setHours(0, 0, 0, 0);
    const rec = await CashBalance.findOne({ businessId: biz._id, branchId: branchId || null, date: day }).lean();
    return rec?.openingBalance ?? 0;
  } catch (_) { return 0; }
}


// ─── Parse custom date range from text ───────────────────────────────────────
// Accepts: "01 Jun - 22 Jun" | "01/06 - 22/06" | "2026-06-01 - 2026-06-22"
export function parseCustomDateRange(text) {
  const parts = text.split(/\s*[-–—to]\s*/i).map(s => s.trim()).filter(Boolean);
  if (parts.length < 2) return null;
  const now = new Date();

  function parseOne(s) {
    // Try ISO
    const iso = Date.parse(s);
    if (!isNaN(iso)) return new Date(iso);
    // Try "01 Jun" or "01 Jun 2026"
    const m1 = s.match(/(\d{1,2})\s+([A-Za-z]+)(?:\s+(\d{4}))?/);
    if (m1) return new Date(`${m1[1]} ${m1[2]} ${m1[3] || now.getFullYear()}`);
    // Try "01/06" or "01/06/2026"
    const m2 = s.match(/(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?/);
    if (m2) return new Date(`${m2[3] || now.getFullYear()}-${m2[2].padStart(2,"0")}-${m2[1].padStart(2,"0")}`);
    return null;
  }

  const start = parseOne(parts[0]);
  const end   = parseOne(parts[1]);
  if (!start || !end || isNaN(start) || isNaN(end)) return null;
  start.setHours(0, 0, 0, 0);
  end.setHours(23, 59, 59, 999);
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
  return `📊 *${(biz.name||"").toUpperCase()}* — ${label}
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
  const periodLabel = `${shortDate(start)} — ${shortDate(end)}`;
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
// ═══════════════════════════════════════════════════════════════════════════════
export async function runDetailedLedgerReport({ biz, from, period = "day", customStart = null, customEnd = null }) {
  const { branchId, branchName } = await resolveCallerAndBranch(biz, from);

  let start, end, periodLabel;

  if (period === "custom" && customStart && customEnd) {
    start = customStart; end = customEnd;
    periodLabel = `${shortDate(start)} — ${shortDate(end)}`;
  } else if (period === "week") {
    const now = new Date(); const dow = now.getDay(); const diff = dow === 0 ? -6 : 1 - dow;
    start = new Date(now); start.setDate(now.getDate() + diff); start.setHours(0, 0, 0, 0);
    end   = new Date(start); end.setDate(start.getDate() + 6); end.setHours(23, 59, 59, 999);
    periodLabel = `${shortDate(start)} — ${shortDate(end)}`;
  } else if (period === "month") {
    const now = new Date();
    start = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
    end   = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
    periodLabel = start.toLocaleDateString("en-GB", { month: "long", year: "numeric" });
  } else {
    start = new Date(); start.setHours(0,  0,  0,   0);
    end   = new Date(); end.setHours(23, 59, 59, 999);
    periodLabel = dateLabel(start);
  }

  const data           = await fetchReportData({ biz, start, end, branchId });
  const openingBalance = await fetchOpeningBalance(biz, branchId, start);
  const ledger         = await buildLedger({ biz, data, branchId, start, end, openingBalance });

  biz.sessionState = "ready"; biz.sessionData = {}; await biz.save();

  const cur = biz.currency || "USD";
  const net = ledger.closingBalance - openingBalance;

  // Short WhatsApp message — full detail is in the PDF
  await sendText(from,
`📋 *DETAILED LEDGER*
${biz.name}${branchName ? ` · ${branchName}` : ""}
${periodLabel}
━━━━━━━━━━━━━━━━━━━━
Opening Balance: ${fmtMoney(openingBalance, cur)}
Total In  (+):   ${fmtMoney(ledger.totalCredits, cur)}
Total Out (−):   ${fmtMoney(ledger.totalDebits, cur)}
Closing Balance: ${fmtMoney(ledger.closingBalance, cur)}
Net Change: ${net >= 0 ? "▲ +" : "▼ "}${fmtMoney(Math.abs(net), cur)}
${ledger.rows.filter(r => !r.isHandover).length} transactions · ${ledger.rows.filter(r => r.isHandover).length} handovers

📄 Full ledger PDF with all transactions and running balances is attached below ↓`
  );

  try {
    const { filename, url } = await generateReportPDF({
      biz, reportType: "Detailed Ledger", periodLabel, branchName,
      ledgerRows: ledger.rows, openingBalance, closingBalance: ledger.closingBalance
    });
    await sendDocument(from, { link: url, filename });
  } catch (e) { console.error("[LEDGER PDF]", e.message); await sendText(from, "⚠️ PDF generation failed. Please try again."); }

  await sendMainMenu(from);
  return true;
}


// ═══════════════════════════════════════════════════════════════════════════════
// CLERK STATEMENT  →  state "report_clerk_statement"
// ═══════════════════════════════════════════════════════════════════════════════
export async function runClerkStatementReport({ biz, from, clerkPhone, period = "day", customStart = null, customEnd = null }) {
  const { branchId, branchName } = await resolveCallerAndBranch(biz, from);

  let start, end, periodLabel;
  if (period === "custom" && customStart && customEnd) {
    start = customStart; end = customEnd;
    periodLabel = `${shortDate(start)} — ${shortDate(end)}`;
  } else if (period === "week") {
    const now = new Date(); const dow = now.getDay(); const diff = dow === 0 ? -6 : 1 - dow;
    start = new Date(now); start.setDate(now.getDate() + diff); start.setHours(0, 0, 0, 0);
    end   = new Date(start); end.setDate(start.getDate() + 6); end.setHours(23, 59, 59, 999);
    periodLabel = `${shortDate(start)} — ${shortDate(end)}`;
  } else if (period === "month") {
    const now = new Date();
    start = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
    end   = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
    periodLabel = start.toLocaleDateString("en-GB", { month: "long", year: "numeric" });
  } else {
    start = new Date(); start.setHours(0,  0,  0,   0);
    end   = new Date(); end.setHours(23, 59, 59, 999);
    periodLabel = dateLabel(start);
  }

  biz.sessionState = "ready"; biz.sessionData = {}; await biz.save();

  const stmt = await buildClerkStatement({ biz, clerkPhone, branchId, start, end });
  const cur  = biz.currency || "USD";
  const { clerkName, clerkRole, openingCustody, totalIn, totalOut, expectedClosing, handedOver, discrepancy } = stmt;

  const recLine = handedOver !== null
    ? (Math.abs(discrepancy) < 0.01
        ? `✅ Balanced — Counted ${fmtMoney(handedOver, cur)}`
        : discrepancy > 0
          ? `⚠️ Surplus +${fmtMoney(discrepancy, cur)}`
          : `❌ Short ${fmtMoney(Math.abs(discrepancy), cur)}`)
    : `⏳ Shift open — Balance: ${fmtMoney(expectedClosing, cur)}`;

  await sendText(from,
`👤 *CLERK STATEMENT*
${clerkName} (${clerkRole})
${biz.name}${branchName ? ` · ${branchName}` : ""}
${periodLabel}
━━━━━━━━━━━━━━━━━━━━
Opening Custody: ${fmtMoney(openingCustody, cur)}
Total In  (+):   ${fmtMoney(totalIn, cur)}
Total Out (−):   ${fmtMoney(totalOut, cur)}
Closing Balance: ${fmtMoney(expectedClosing, cur)}
${stmt.txRows.length} transactions recorded
━━━━━━━━━━━━━━━━━━━━
RECONCILIATION: ${recLine}

📄 Full clerk statement PDF attached below ↓`
  );

  try {
    const { filename, url } = await generateReportPDF({
      biz, reportType: "Clerk Statement",
      periodLabel: `${clerkName} · ${periodLabel}`,
      branchName, clerkData: stmt
    });
    await sendDocument(from, { link: url, filename });
  } catch (e) { console.error("[CLERK STMT PDF]", e.message); await sendText(from, "⚠️ PDF generation failed."); }

  await sendMainMenu(from);
  return true;
}