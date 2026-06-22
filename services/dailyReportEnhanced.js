/**
 * services/dailyReportEnhanced.js
 * ─────────────────────────────────────────────────────────────
 * WHERE TO PUT THIS FILE:  services/dailyReportEnhanced.js
 * (full replacement of your existing dailyReportEnhanced.js)
 * ─────────────────────────────────────────────────────────────
 *
 * All three report runners are now in this one file:
 *   runDailyReportMetaEnhanced   ← already called by twilioStateBridge
 *   runWeeklyReportMetaEnhanced  ← already called by twilioStateBridge
 *   runMonthlyReportMetaEnhanced ← already called by twilioStateBridge
 *
 * No changes needed to twilioStateBridge.js — the imports at the
 * top of that file already point to these three function names.
 */

import { sendText }           from "./metaSender.js";
import { sendDocument }       from "./metaSender.js";
import { sendMainMenu }       from "./metaMenus.js";
import { generateReportPDF }  from "./reportPDF.js";

import {
  buildProductSummary,
  buildOverdueAnalysis,
  buildDailyBreakdown,
  buildIncomeStatement,
  generateInsights,
  generateActionItems,
  formatInsightsList,
  formatActionsList
} from "./reportHelpers.js";


// ─── Formatters ───────────────────────────────────────────────────────────────
export const fmt = (n, cur) => {
  const sym = cur === "ZWL" ? "ZWL " : cur === "ZAR" ? "R " : "$ ";
  return `${sym}${Number(n || 0).toFixed(2)}`;
};
export const pct = (a, b) => (b > 0 ? Math.round((a / b) * 100) : 0);

export function dateLabel(d) {
  return d.toLocaleDateString("en-GB", {
    weekday: "long", day: "numeric", month: "long", year: "numeric"
  });
}

function shortDateTime(d) {
  return new Date(d).toLocaleDateString("en-GB", {
    day: "numeric", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit"
  });
}


// ─── Fetch raw data for any period ────────────────────────────────────────────
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


// ─── Quick totals (kept for backward compat & PDF generator) ─────────────────
export function calcTotals({ invoices, receipts, payments, expenses }) {
  const invoicePayments = payments.reduce((s, p) => s + (p.amount || 0), 0);
  const cashSales       = receipts.reduce((s, r) => s + (r.total  || 0), 0);
  const moneyIn         = invoicePayments + cashSales;
  const moneyOut        = expenses.reduce((s, e) => s + (e.amount || 0), 0);
  const profit          = moneyIn - moneyOut;
  const totalInvoiced   = invoices.reduce((s, i) => s + (i.total  || 0), 0);
  const outstanding     = invoices.reduce((s, i) => s + (i.balance || 0), 0);
  return { invoicePayments, cashSales, moneyIn, moneyOut, profit, totalInvoiced, outstanding };
}


// ─── Resolve caller and branch ────────────────────────────────────────────────
export async function resolveCallerAndBranch(biz, from) {
  const UserRole           = (await import("../models/userRole.js")).default;
  const { normalizePhone } = await import("./phone.js");

  let phone = normalizePhone(from);
  if (phone.startsWith("0")) phone = "263" + phone.slice(1);

  const caller = await UserRole.findOne({ phone, pending: false });

  const sessionBranchId = biz.sessionData?.reportBranchId || null;
  if (sessionBranchId) {
    delete biz.sessionData.reportBranchId;
    await biz.save();
  }

  const branchId = sessionBranchId ||
    (caller?.role !== "owner" ? caller?.branchId : null);

  let branchName = null;
  if (branchId) {
    const Branch  = (await import("../models/branch.js")).default;
    const br      = await Branch.findById(branchId).lean();
    branchName    = br?.name || null;
  }

  return { caller, branchId: branchId || null, branchName };
}


// ─── Fetch opening balance for a branch on a given date ──────────────────────
async function fetchOpeningBalance(biz, branchId, date) {
  try {
    const CashBalance = (await import("../models/cashBalance.js")).default;
    const day = new Date(date); day.setHours(0, 0, 0, 0);
    const rec = await CashBalance.findOne({
      businessId: biz._id, branchId: branchId || null, date: day
    }).lean();
    return rec?.openingBalance ?? 0;
  } catch (_) { return 0; }
}


// ═══════════════════════════════════════════════════════════════════════════════
// INCOME STATEMENT WhatsApp TEXT BUILDER
// ═══════════════════════════════════════════════════════════════════════════════
export async function buildIncomeStatementSummary({
  biz, label, periodLabel, branchName, branchId,
  data, start, end, openingBalance = 0, dailyBreakdown = null
}) {
  const cur = biz.currency || "USD";

  // Build full income statement object
  const is = await buildIncomeStatement({ biz, data, branchId, start, end, openingBalance });
  const { revenue, expenses, drawings, profit, cashPosition, invoiceSummary, staffActivity, handoverLog } = is;

  // ── Net verdict ──────────────────────────────────────────────────────────────
  const verdict = profit.netProfit >= 0
    ? `✅ *NET PROFIT:*  ${fmt(profit.netProfit, cur)}`
    : `❌ *NET LOSS:*    ${fmt(Math.abs(profit.netProfit), cur)}`;

  // ── Expenses by category ─────────────────────────────────────────────────────
  const expLines = Object.entries(expenses.byCategory)
    .sort((a, b) => b[1] - a[1])
    .map(([cat, amt]) => `   ${cat.padEnd(22)} ${fmt(amt, cur)}`)
    .join("\n") || "   Nothing spent";

  // ── Drawings lines ───────────────────────────────────────────────────────────
  const drawingLines = drawings.drawings.length > 0
    ? drawings.drawings.map(d =>
        `   ${fmt(d.amount, cur).padEnd(14)} ${(d.reason || "Drawing").slice(0, 25)}\n` +
        `   By: ${d.recordedByName} (${d.recordedByRole}) · ${shortDateTime(d.createdAt)}`
      ).join("\n")
    : "   None recorded";

  const otherPayoutLines = drawings.otherPayouts.length > 0
    ? "\n" + drawings.otherPayouts.map(d =>
        `   ${fmt(d.amount, cur).padEnd(14)} ${(d.reason || "Payout").slice(0, 25)}\n` +
        `   By: ${d.recordedByName} (${d.recordedByRole}) · ${shortDateTime(d.createdAt)}`
      ).join("\n")
    : "";

  // ── Staff activity ───────────────────────────────────────────────────────────
  const staffLines = staffActivity.length > 0
    ? staffActivity.map(s => {
        const roleLabel = (s.role || "clerk").charAt(0).toUpperCase() + (s.role || "clerk").slice(1);
        const txns = `${s.invoiceCount} inv · ${s.receiptCount} rcpt · ${s.expenseCount} exp`;
        return (
          `   👤 ${s.name} (${roleLabel})\n` +
          `      Transactions: ${txns}\n` +
          `      Revenue recorded: ${fmt(s.totalRevenue, cur)}`
        );
      }).join("\n\n")
    : "   No staff activity found";

  // ── Shift handovers ──────────────────────────────────────────────────────────
  const handoverLines = handoverLog.length > 0
    ? handoverLog.map((h, i) =>
        `   ${i > 0 ? "─────────────────────\n   " : ""}` +
        `🕐 ${h.date} ${h.time}\n` +
        `   OUT: ${h.outgoing} (${h.outgoingRole})\n` +
        `   IN:  ${h.incoming} (${h.incomingRole})\n` +
        `   💵 Cash counted: ${fmt(h.amountCounted, cur)}` +
        (h.notes ? `\n   📝 ${h.notes}` : "")
      ).join("\n")
    : "   No shift handovers recorded";

  // ── Top products ─────────────────────────────────────────────────────────────
  const { topProducts } = await buildProductSummary(data.invoices, data.receipts);
  const productLines = topProducts.slice(0, 5).length > 0
    ? topProducts.slice(0, 5).map((p, i) =>
        `   ${i + 1}. ${p.name.slice(0, 30).padEnd(30)} ${fmt(p.revenue, cur)} (qty: ${p.qty})`
      ).join("\n")
    : "   No products sold";

  // ── Overdue ──────────────────────────────────────────────────────────────────
  const overdueData  = await buildOverdueAnalysis(data.invoices, biz);
  const overdueLines = overdueData.overdue.length > 0
    ? overdueData.overdue.slice(0, 3).map(i =>
        `   ⚠️  ${i.clientName.slice(0, 22).padEnd(22)} ${fmt(i.balance, cur)} — ${i.number} (${i.daysOverdue}d)`
      ).join("\n")
    : "   ✅ No overdue invoices";

  // ── Insights + actions ───────────────────────────────────────────────────────
  const collRate  = pct(revenue.grossRevenue, invoiceSummary.totalInvoiced + revenue.cashSales);
  const profitMgn = revenue.grossRevenue > 0
    ? Math.round((profit.operatingProfit / revenue.grossRevenue) * 100) : 0;

  const insights = generateInsights({
    profitMargin: profitMgn, collectionRate: collRate,
    topProduct: topProducts[0] || null,
    overdueCount: overdueData.overdue.length, overdueAmount: overdueData.totalOverdue,
    netProfit: profit.netProfit, currency: cur
  });
  const actions = generateActionItems({
    overdueInvoices: overdueData.overdue, currentOutstanding: overdueData.current,
    collectionRate: collRate, profitMargin: profitMgn
  });

  // ── Optional daily trend table (weekly / monthly) ────────────────────────────
  let trendSection = "";
  if (dailyBreakdown?.length) {
    const rows = dailyBreakdown.map(d => {
      const sign = d.profit >= 0 ? "+" : "-";
      return `   ${d.dayLabel.padEnd(14)} ${fmt(d.revenue, cur).padEnd(12)} ${fmt(d.expenses, cur).padEnd(12)} ${sign}${fmt(Math.abs(d.profit), cur)}`;
    }).join("\n");
    trendSection =
      `\n━━━━━━━━━━━━━━━━━━━━` +
      `\n📅 DAY-BY-DAY BREAKDOWN` +
      `\n   ${"DATE".padEnd(14)} ${"REVENUE".padEnd(12)} ${"EXPENSES".padEnd(12)} PROFIT` +
      `\n${rows}`;
  }

  const branchLine = branchName ? `📍 *Branch:* ${branchName}\n` : "";

  return `📊 *${(biz.name || "").toUpperCase()}*
${label.toUpperCase()} — INCOME STATEMENT
${periodLabel}
${branchLine}
━━━━━━━━━━━━━━━━━━━━
REVENUE
   Invoice Payments:       ${fmt(revenue.invoicePaymentsReceived, cur)}  (${invoiceSummary.payments} payments)
   Cash Sales (Receipts):  ${fmt(revenue.cashSales, cur)}  (${invoiceSummary.receipts} receipts)
   ─────────────────────────────────
   GROSS REVENUE:          ${fmt(revenue.grossRevenue, cur)}
━━━━━━━━━━━━━━━━━━━━
OPERATING EXPENSES         ${fmt(expenses.totalExpenses, cur)}
${expLines}
   ─────────────────────────────────
   OPERATING PROFIT:       ${fmt(profit.operatingProfit, cur)}
━━━━━━━━━━━━━━━━━━━━
OWNER DRAWINGS             ${fmt(drawings.totalDrawings, cur)}
${drawingLines}${drawings.otherPayouts.length > 0 ? `\n\nOTHER PAYOUTS              ${fmt(drawings.totalOtherPayouts, cur)}${otherPayoutLines}` : ""}
   ─────────────────────────────────
   ${verdict}
━━━━━━━━━━━━━━━━━━━━
CASH POSITION
   Opening Balance:        ${fmt(cashPosition.openingBalance, cur)}
   + Cash In:              ${fmt(cashPosition.cashIn, cur)}
   - Cash Out:             ${fmt(cashPosition.cashOut, cur)}
   ─────────────────────────────────
   CLOSING BALANCE:        ${fmt(cashPosition.closingBalance, cur)}
━━━━━━━━━━━━━━━━━━━━
INVOICES
   Raised:                 ${fmt(invoiceSummary.totalInvoiced, cur)}  (${invoiceSummary.count})
   Payments Collected:     ${fmt(revenue.invoicePaymentsReceived, cur)}
   Still Outstanding:      ${fmt(invoiceSummary.totalOutstanding, cur)}
   Collection Rate:        ${collRate}%
━━━━━━━━━━━━━━━━━━━━
👥 STAFF ACTIVITY
${staffLines}
━━━━━━━━━━━━━━━━━━━━
🔄 SHIFT HANDOVERS
${handoverLines}
━━━━━━━━━━━━━━━━━━━━
🏆 TOP PRODUCTS / SERVICES
${productLines}
━━━━━━━━━━━━━━━━━━━━
⚠️  OVERDUE INVOICES
${overdueLines}${trendSection}
━━━━━━━━━━━━━━━━━━━━
💡 INSIGHTS
${formatInsightsList(insights)}
📋 ACTION ITEMS
${formatActionsList(actions)}━━━━━━━━━━━━━━━━━━━━
${invoiceSummary.count} invoices · ${invoiceSummary.payments} payments · ${invoiceSummary.receipts} receipts · ${expenses.list.length} expenses`;
}


// ─── Send report: WhatsApp text first, then PDF ───────────────────────────────
export async function sendReport({
  biz, from, label, periodLabel, branchName, branchId,
  data, totals, prevTotals, weeks, start, end,
  openingBalance = 0, dailyBreakdown = null
}) {
  const summary = await buildIncomeStatementSummary({
    biz, label, periodLabel, branchName, branchId,
    data, start, end, openingBalance, dailyBreakdown
  });
  await sendText(from, summary);

  try {
    const { filename } = await generateReportPDF({
      biz, reportType: label, periodLabel, branchName,
      data, totals, prevTotals, weeks
    });
    const site      = (process.env.SITE_URL || "").replace(/\/$/, "");
    const reportUrl = `${site}/docs/generated/reports/${filename}`;
    await sendDocument(from, { link: reportUrl, filename });
  } catch (pdfErr) {
    console.error("[REPORT PDF]", pdfErr.message);
  }
}


// ═══════════════════════════════════════════════════════════════════════════════
// DAILY REPORT  (called by twilioStateBridge → state "report_daily")
// ═══════════════════════════════════════════════════════════════════════════════
export async function runDailyReportMetaEnhanced({ biz, from }) {
  const { branchId, branchName } = await resolveCallerAndBranch(biz, from);

  const start = new Date(); start.setHours(0,  0,  0,   0);
  const end   = new Date(); end.setHours(23, 59, 59, 999);

  const data          = await fetchReportData({ biz, start, end, branchId });
  const totals        = calcTotals(data);
  const openingBalance = await fetchOpeningBalance(biz, branchId, start);

  biz.sessionState = "ready"; biz.sessionData = {};
  await biz.save();

  await sendReport({
    biz, from,
    label:        "Daily Report",
    periodLabel:  dateLabel(start),
    branchName, branchId, data, totals,
    prevTotals:   null, weeks: null,
    start, end, openingBalance,
    dailyBreakdown: null
  });

  await sendMainMenu(from);
  return true;
}


// ═══════════════════════════════════════════════════════════════════════════════
// WEEKLY REPORT  (called by twilioStateBridge → state "report_weekly")
// ═══════════════════════════════════════════════════════════════════════════════
export async function runWeeklyReportMetaEnhanced({ biz, from }) {
  const { branchId, branchName } = await resolveCallerAndBranch(biz, from);

  // Monday 00:00 → Sunday 23:59 of current ISO week
  const now  = new Date();
  const dow  = now.getDay(); // 0 = Sun
  const diff = dow === 0 ? -6 : 1 - dow;
  const start = new Date(now); start.setDate(now.getDate() + diff); start.setHours(0, 0, 0, 0);
  const end   = new Date(start); end.setDate(start.getDate() + 6); end.setHours(23, 59, 59, 999);

  const data   = await fetchReportData({ biz, start, end, branchId });
  const totals = calcTotals(data);

  // Previous week for PDF comparison
  const prevStart = new Date(start); prevStart.setDate(prevStart.getDate() - 7);
  const prevEnd   = new Date(end);   prevEnd.setDate(prevEnd.getDate()   - 7);
  const prevTotals = calcTotals(await fetchReportData({ biz, start: prevStart, end: prevEnd, branchId }));

  const openingBalance  = await fetchOpeningBalance(biz, branchId, start);
  const dailyBreakdown  = buildDailyBreakdown({
    invoices: data.invoices, receipts: data.receipts,
    payments: data.payments, expenses: data.expenses,
    start, end
  });

  biz.sessionState = "ready"; biz.sessionData = {};
  await biz.save();

  await sendReport({
    biz, from,
    label:       "Weekly Report",
    periodLabel: `${dateLabel(start)} → ${dateLabel(end)}`,
    branchName, branchId, data, totals, prevTotals,
    weeks: null, start, end, openingBalance, dailyBreakdown
  });

  await sendMainMenu(from);
  return true;
}


// ═══════════════════════════════════════════════════════════════════════════════
// MONTHLY REPORT  (called by twilioStateBridge → state "report_monthly")
// ═══════════════════════════════════════════════════════════════════════════════
export async function runMonthlyReportMetaEnhanced({ biz, from }) {
  const { branchId, branchName } = await resolveCallerAndBranch(biz, from);

  const now   = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(),     1,  0,  0,  0,  0);
  const end   = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);

  const data   = await fetchReportData({ biz, start, end, branchId });
  const totals = calcTotals(data);

  // Previous month for PDF comparison
  const prevStart = new Date(now.getFullYear(), now.getMonth() - 1, 1,  0,  0,  0,  0);
  const prevEnd   = new Date(now.getFullYear(), now.getMonth(),     0, 23, 59, 59, 999);
  const prevTotals = calcTotals(await fetchReportData({ biz, start: prevStart, end: prevEnd, branchId }));

  const openingBalance  = await fetchOpeningBalance(biz, branchId, start);
  const dailyBreakdown  = buildDailyBreakdown({
    invoices: data.invoices, receipts: data.receipts,
    payments: data.payments, expenses: data.expenses,
    start, end
  });

  biz.sessionState = "ready"; biz.sessionData = {};
  await biz.save();

  await sendReport({
    biz, from,
    label:       "Monthly Report",
    periodLabel: start.toLocaleDateString("en-GB", { month: "long", year: "numeric" }),
    branchName, branchId, data, totals, prevTotals,
    weeks: null, start, end, openingBalance, dailyBreakdown
  });

  await sendMainMenu(from);
  return true;
}