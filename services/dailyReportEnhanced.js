/**
 * services/dailyReportEnhanced.js  — FULL REPLACEMENT
 * ─────────────────────────────────────────────────────────────
 * Three report runners consumed by twilioStateBridge.js:
 *
 *   runDailyReportMetaEnhanced    → state "report_daily"
 *   runWeeklyReportMetaEnhanced   → state "report_weekly"
 *   runMonthlyReportMetaEnhanced  → state "report_monthly"
 *
 * Plus two new runners:
 *   runDetailedLedgerReport       → state "report_detailed"
 *   runClerkStatementReport       → state "report_clerk_statement"
 *
 * And builders/helpers re-exported for weeklyReportEnhanced.js compat:
 *   fetchReportData, calcTotals, buildWhatsAppSummary,
 *   resolveCallerAndBranch, sendReport, fmt, dateLabel
 */

import { sendText }          from "./metaSender.js";
import { sendDocument }      from "./metaSender.js";
import { sendMainMenu }      from "./metaMenus.js";
import { generateReportPDF } from "./reportPDF.js";

import {
  fmtMoney, fmtDT, fmtDate, fmt, pct,
  resolveStaff, clearStaffCache,
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


// ─── Formatters ───────────────────────────────────────────────────────────────
export { fmt };

export const dateLabel = d => d.toLocaleDateString("en-GB", {
  weekday: "long", day: "numeric", month: "long", year: "numeric"
});


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


// ─── Quick totals (for backward compat + weekly runner) ──────────────────────
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


// ─── Opening balance from CashBalance model ───────────────────────────────────
async function fetchOpeningBalance(biz, branchId, date) {
  try {
    const CashBalance = (await import("../models/cashBalance.js")).default;
    const day = new Date(date); day.setHours(0, 0, 0, 0);
    const rec = await CashBalance.findOne({ businessId: biz._id, branchId: branchId || null, date: day }).lean();
    return rec?.openingBalance ?? 0;
  } catch (_) { return 0; }
}


// ═══════════════════════════════════════════════════════════════════════════════
// SUMMARY REPORT WhatsApp text builder
// ═══════════════════════════════════════════════════════════════════════════════
export async function buildWhatsAppSummary({ biz, label, periodLabel, data, totals, branchName, branchId, start, end, openingBalance = 0 }) {
  const cur = biz.currency || "USD";

  const is = await buildIncomeStatement({ biz, data, branchId, start, end, openingBalance });
  const { revenue, expenses, drawings, profit, cashPosition, invoiceSummary, staffActivity, handoverLog } = is;

  // ── Verdict ─────────────────────────────────────────────────────────────────
  const verdict = profit.netProfit >= 0
    ? `✅ *NET PROFIT:*    ${fmtMoney(profit.netProfit, cur)}`
    : `❌ *NET LOSS:*      ${fmtMoney(Math.abs(profit.netProfit), cur)}`;

  // ── Expenses by category ─────────────────────────────────────────────────────
  const expLines = Object.entries(expenses.byCategory)
    .sort((a, b) => b[1] - a[1])
    .map(([cat, amt]) => `   ${cat.padEnd(24)} ${fmtMoney(amt, cur)}`)
    .join("\n") || "   Nothing spent";

  // ── Drawing lines ────────────────────────────────────────────────────────────
  const drawLines = drawings.drawings.length
    ? drawings.drawings.map(d =>
        `   ${fmtMoney(d.amount, cur).padEnd(12)} ${(d.reason || "Drawing").slice(0, 28)}\n` +
        `   Recorded by: ${d.recordedByName} (${d.recordedByRole}) · ${fmtDT(d.createdAt)}`
      ).join("\n")
    : "   None";

  // ── Staff summary ────────────────────────────────────────────────────────────
  const staffLines = staffActivity.length
    ? staffActivity.map(s =>
        `   ${s.name.slice(0, 18).padEnd(18)} (${(s.role || "clerk")})\n` +
        `      ${s.invoiceCount}inv ${s.receiptCount}rcpt ${s.expenseCount}exp · Rev: ${fmtMoney(s.totalRevenue, cur)}`
      ).join("\n\n")
    : "   No activity";

  // ── Handover summary ─────────────────────────────────────────────────────────
  const handoverLines = handoverLog.length
    ? handoverLog.map(h =>
        `   🕐 ${h.date} ${h.time}  ${h.outgoing} → ${h.incoming}\n` +
        `   Cash counted: ${fmtMoney(h.amountCounted, cur)}`
      ).join("\n")
    : "   No handovers";

  // ── Products ─────────────────────────────────────────────────────────────────
  const { topProducts } = await buildProductSummary(data.invoices, data.receipts);
  const productLines = formatProductList(topProducts.slice(0, 5), cur);

  // ── Overdue ──────────────────────────────────────────────────────────────────
  const overdueData = await buildOverdueAnalysis(data.invoices, biz);
  const overdueLines = formatOverdueList(overdueData.overdue, cur, 3);

  // ── Insights ─────────────────────────────────────────────────────────────────
  const collRate = pct(revenue.grossRevenue, invoiceSummary.totalInvoiced + revenue.cashSales);
  const margin   = revenue.grossRevenue > 0 ? Math.round((profit.operatingProfit / revenue.grossRevenue) * 100) : 0;
  const insights = generateInsights({ profitMargin: margin, collectionRate: collRate, topProduct: topProducts[0] || null, overdueCount: overdueData.overdue.length, overdueAmount: overdueData.totalOverdue, netProfit: profit.netProfit, currency: cur });
  const actions  = generateActionItems({ overdueInvoices: overdueData.overdue, currentOutstanding: overdueData.current, collectionRate: collRate, profitMargin: margin });

  const branchLine = branchName ? `📍 Branch: ${branchName}\n` : "";

  return `📊 *${(biz.name || "").toUpperCase()}* — ${label.toUpperCase()}
${periodLabel}
${branchLine}
━━━━━━━━━━━━━━━━━━━━━━━
REVENUE
   Invoice Payments:       ${fmtMoney(revenue.invoicePaymentsReceived, cur).padStart(12)}
   Cash Sales:             ${fmtMoney(revenue.cashSales, cur).padStart(12)}
                           ────────────
   GROSS REVENUE:          ${fmtMoney(revenue.grossRevenue, cur).padStart(12)}
━━━━━━━━━━━━━━━━━━━━━━━
OPERATING EXPENSES         ${fmtMoney(expenses.totalExpenses, cur).padStart(12)}
${expLines}
                           ────────────
   OPERATING PROFIT:       ${fmtMoney(profit.operatingProfit, cur).padStart(12)}
━━━━━━━━━━━━━━━━━━━━━━━
OWNER DRAWINGS             ${fmtMoney(drawings.totalDrawings, cur).padStart(12)}
${drawLines}${drawings.otherPayouts.length ? `\nOTHER PAYOUTS              ${fmtMoney(drawings.totalOtherPayouts, cur).padStart(12)}\n${drawings.otherPayouts.map(d => `   ${fmtMoney(d.amount, cur)} — ${d.reason || "Payout"} [${d.recordedByName}]`).join("\n")}` : ""}
                           ────────────
   ${verdict}
━━━━━━━━━━━━━━━━━━━━━━━
CASH POSITION
   Opening Balance:        ${fmtMoney(cashPosition.openingBalance, cur).padStart(12)}
   + Cash In:              ${fmtMoney(cashPosition.cashIn, cur).padStart(12)}
   - Cash Out:             ${fmtMoney(cashPosition.cashOut, cur).padStart(12)}
                           ────────────
   CLOSING BALANCE:        ${fmtMoney(cashPosition.closingBalance, cur).padStart(12)}
━━━━━━━━━━━━━━━━━━━━━━━
INVOICES
   Raised:     ${fmtMoney(invoiceSummary.totalInvoiced, cur).padStart(12)}  (${invoiceSummary.count})
   Collected:  ${fmtMoney(revenue.invoicePaymentsReceived, cur).padStart(12)}
   Outstanding:${fmtMoney(invoiceSummary.totalOutstanding, cur).padStart(12)}
   Collection Rate: ${collRate}%
━━━━━━━━━━━━━━━━━━━━━━━
👥 STAFF SUMMARY
${staffLines}
━━━━━━━━━━━━━━━━━━━━━━━
🔄 SHIFT HANDOVERS
${handoverLines}
━━━━━━━━━━━━━━━━━━━━━━━
🏆 TOP PRODUCTS / SERVICES
${productLines}
━━━━━━━━━━━━━━━━━━━━━━━
⚠️  OVERDUE INVOICES
${overdueLines}
━━━━━━━━━━━━━━━━━━━━━━━
💡 INSIGHTS
${formatInsightsList(insights)}📋 ACTIONS
${formatActionsList(actions)}━━━━━━━━━━━━━━━━━━━━━━━
${invoiceSummary.count} invoices · ${invoiceSummary.payments} payments · ${invoiceSummary.receipts} receipts · ${expenses.list.length} expenses`;
}


// ═══════════════════════════════════════════════════════════════════════════════
// DETAILED LEDGER WhatsApp text builder
// ═══════════════════════════════════════════════════════════════════════════════
export async function buildDetailedLedgerText({ biz, label, periodLabel, branchName, branchId, data, start, end, openingBalance = 0 }) {
  const cur    = biz.currency || "USD";
  const ledger = await buildLedger({ biz, data, branchId, start, end, openingBalance });
  const { rows, closingBalance, totalCredits, totalDebits } = ledger;

  const branchLine = branchName ? `📍 Branch: ${branchName}\n` : "";

  // Column widths for WhatsApp monospace alignment
  const W_DATE  = 14;
  const W_TYPE  = 14;
  const W_DESC  = 22;
  const W_AMT   = 10;
  const W_BAL   = 10;

  const header =
    `${"DATE/TIME".padEnd(W_DATE)} ` +
    `${"TYPE".padEnd(W_TYPE)} ` +
    `${"DESCRIPTION".padEnd(W_DESC)} ` +
    `${"RECORDER".padEnd(14)} ` +
    `${"IN (+)".padStart(W_AMT)} ` +
    `${"OUT (-)".padStart(W_AMT)} ` +
    `${"BALANCE".padStart(W_BAL)}`;

  const divider = "─".repeat(header.length);

  const opening = `${"OPENING BALANCE".padEnd(W_DATE + 1 + W_TYPE + 1 + W_DESC + 1 + 14 + 1)} ${"".padStart(W_AMT)} ${"".padStart(W_AMT)} ${fmtMoney(openingBalance, cur).padStart(W_BAL)}`;

  const bodyLines = rows.map(row => {
    const dateStr = fmtDT(row.at).padEnd(W_DATE);
    const typeStr = (row.typeLabel || "").slice(0, W_TYPE).padEnd(W_TYPE);
    const descStr = (row.description || "").slice(0, W_DESC).padEnd(W_DESC);
    const recStr  = (row.recorder    || "").slice(0, 14).padEnd(14);

    if (row.isHandover) {
      const handoverDesc = `↕ HANDOVER: ${row.description}`.slice(0, W_DESC).padEnd(W_DESC);
      const counted = `${fmtMoney(row.amountCounted, cur)} counted`.padEnd(W_AMT + W_AMT + 3);
      return `${dateStr} ${"─ SHIFT ─".padEnd(W_TYPE)} ${handoverDesc} ${recStr} ${counted} ${row.flag || ""}`;
    }

    const inStr  = row.credit > 0 ? fmtMoney(row.credit, cur).padStart(W_AMT) : "".padStart(W_AMT);
    const outStr = row.debit  > 0 ? fmtMoney(row.debit,  cur).padStart(W_AMT) : "".padStart(W_AMT);
    const balStr = fmtMoney(row.balance, cur).padStart(W_BAL);

    return `${dateStr} ${typeStr} ${descStr} ${recStr} ${inStr} ${outStr} ${balStr}`;
  });

  const totalsLine =
    `${"TOTALS".padEnd(W_DATE + 1 + W_TYPE + 1 + W_DESC + 1 + 14 + 1)} ${fmtMoney(totalCredits, cur).padStart(W_AMT)} ${fmtMoney(totalDebits, cur).padStart(W_AMT)} ${fmtMoney(closingBalance, cur).padStart(W_BAL)}`;

  const verdict = closingBalance >= openingBalance
    ? `✅ Net position: +${fmtMoney(closingBalance - openingBalance, cur)}`
    : `📉 Net position: -${fmtMoney(openingBalance - closingBalance, cur)}`;

  return `📋 *${(biz.name || "").toUpperCase()}* — ${label.toUpperCase()}
${periodLabel}
${branchLine}
\`\`\`
${header}
${divider}
${opening}
${divider}
${bodyLines.join("\n")}
${divider}
${totalsLine}
\`\`\`
${verdict}
${rows.length} transactions recorded`;
}


// ═══════════════════════════════════════════════════════════════════════════════
// CLERK STATEMENT WhatsApp text builder
// ═══════════════════════════════════════════════════════════════════════════════
export async function buildClerkStatementText({ biz, clerkPhone, branchName, branchId, start, end }) {
  const cur  = biz.currency || "USD";
  const stmt = await buildClerkStatement({ biz, clerkPhone, branchId, start, end });
  const {
    clerkName, clerkRole, openingCustody, openingSource,
    txRows, handoversIn, handoversOut,
    expectedClosing, handedOver, discrepancy,
    totalIn, totalOut
  } = stmt;

  const periodLabel = `${fmtDate(start)} — ${fmtDate(end)}`;
  const branchLine  = branchName ? `📍 Branch: ${branchName}\n` : "";

  const txLines = txRows.length
    ? txRows.map(row => {
        const d    = fmtDT(row.at).padEnd(14);
        const type = (row.typeLabel || "").slice(0, 16).padEnd(16);
        const desc = (row.description || "").slice(0, 26).padEnd(26);
        const inS  = row.credit > 0 ? `+${fmtMoney(row.credit, cur)}` : "".padStart(10);
        const outS = row.debit  > 0 ? `-${fmtMoney(row.debit,  cur)}` : "".padStart(10);
        const bal  = fmtMoney(row.balance, cur).padStart(10);
        return `${d} ${type} ${desc} ${inS.padStart(10)} ${outS.padStart(10)} ${bal}`;
      }).join("\n")
    : "   No transactions recorded this period";

  // Handovers received
  const handInLines = handoversIn.length
    ? handoversIn.map(h =>
        `   ↓ Received ${fmtMoney(h.amountCounted, cur)} from ${h.outgoingName || "?"} at ${new Date(h.handoverAt).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}`
      ).join("\n")
    : "   None (opening balance used)";

  // Handovers given out
  const handOutLines = handoversOut.length
    ? handoversOut.map(h => {
        const diff = h.amountCounted - expectedClosing;
        const flag = Math.abs(diff) < 0.01 ? "✅ BALANCED" : diff > 0 ? `⚠️ SURPLUS +${fmtMoney(diff, cur)}` : `⚠️ SHORT ${fmtMoney(diff, cur)}`;
        return `   ↑ Handed ${fmtMoney(h.amountCounted, cur)} to ${h.incomingName || "?"} at ${new Date(h.handoverAt).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })} — ${flag}`;
      }).join("\n")
    : "   No handover recorded yet";

  // Reconciliation
  const recLine = handedOver !== null
    ? (Math.abs(discrepancy) < 0.01
        ? `✅ BALANCED — Expected ${fmtMoney(expectedClosing, cur)}, Counted ${fmtMoney(handedOver, cur)}`
        : discrepancy > 0
          ? `⚠️ SURPLUS of ${fmtMoney(discrepancy, cur)} — Counted ${fmtMoney(handedOver, cur)}, Expected ${fmtMoney(expectedClosing, cur)}`
          : `❌ SHORT by ${fmtMoney(Math.abs(discrepancy), cur)} — Counted ${fmtMoney(handedOver, cur)}, Expected ${fmtMoney(expectedClosing, cur)}`)
    : `⏳ Shift still open — Balance in custody: ${fmtMoney(expectedClosing, cur)}`;

  return `👤 *CLERK STATEMENT*
${clerkName.toUpperCase()} (${clerkRole})
${periodLabel}
${branchLine}
━━━━━━━━━━━━━━━━━━━━━━━
OPENING CUSTODY:     ${fmtMoney(openingCustody, cur)}
Source: ${openingSource}
━━━━━━━━━━━━━━━━━━━━━━━
CASH RECEIVED (IN)
${handInLines}
━━━━━━━━━━━━━━━━━━━━━━━
TRANSACTIONS RECORDED
\`\`\`
${"DATE/TIME".padEnd(14)} ${"TYPE".padEnd(16)} ${"DESCRIPTION".padEnd(26)} ${"IN (+)".padStart(10)} ${"OUT (-)".padStart(10)} ${"BALANCE".padStart(10)}
${"─".repeat(90)}
${txLines}
${"─".repeat(90)}
TOTALS${" ".repeat(52)} ${`+${fmtMoney(totalIn, cur)}`.padStart(10)} ${`-${fmtMoney(totalOut, cur)}`.padStart(10)} ${fmtMoney(expectedClosing, cur).padStart(10)}
\`\`\`
━━━━━━━━━━━━━━━━━━━━━━━
CASH HANDED OUT
${handOutLines}
━━━━━━━━━━━━━━━━━━━━━━━
RECONCILIATION
${recLine}
━━━━━━━━━━━━━━━━━━━━━━━
${txRows.length} transactions recorded by ${clerkName}`;
}


// ─── Send helper ──────────────────────────────────────────────────────────────
async function sendReportText(from, text, biz, periodLabel, branchName, data, totals, prevTotals, reportType) {
  await sendText(from, text);
  try {
    const { filename } = await generateReportPDF({ biz, reportType, periodLabel, branchName, data, totals, prevTotals, weeks: null });
    const site = (process.env.SITE_URL || "").replace(/\/$/, "");
    await sendDocument(from, { link: `${site}/docs/generated/reports/${filename}`, filename });
  } catch (e) { console.error("[REPORT PDF]", e.message); }
}


// ═══════════════════════════════════════════════════════════════════════════════
// DAILY SUMMARY REPORT  →  state "report_daily"
// ═══════════════════════════════════════════════════════════════════════════════
export async function runDailyReportMetaEnhanced({ biz, from }) {
  const { branchId, branchName } = await resolveCallerAndBranch(biz, from);
  const start = new Date(); start.setHours(0,  0,  0,   0);
  const end   = new Date(); end.setHours(23, 59, 59, 999);
  const data  = await fetchReportData({ biz, start, end, branchId });
  const totals = calcTotals(data);
  const openingBalance = await fetchOpeningBalance(biz, branchId, start);
  biz.sessionState = "ready"; biz.sessionData = {}; await biz.save();
  const text = await buildWhatsAppSummary({
    biz, label: "Daily Report", periodLabel: dateLabel(start),
    branchName, branchId, data, totals, start, end, openingBalance
  });
  await sendReportText(from, text, biz, dateLabel(start), branchName, data, totals, null, "Daily Report");
  await sendMainMenu(from);
  return true;
}


// ═══════════════════════════════════════════════════════════════════════════════
// WEEKLY SUMMARY REPORT  →  state "report_weekly"
// ═══════════════════════════════════════════════════════════════════════════════
export async function runWeeklyReportMetaEnhanced({ biz, from }) {
  const { branchId, branchName } = await resolveCallerAndBranch(biz, from);
  const now  = new Date();
  const dow  = now.getDay();
  const diff = dow === 0 ? -6 : 1 - dow;
  const start = new Date(now); start.setDate(now.getDate() + diff); start.setHours(0, 0, 0, 0);
  const end   = new Date(start); end.setDate(start.getDate() + 6); end.setHours(23, 59, 59, 999);
  const data   = await fetchReportData({ biz, start, end, branchId });
  const totals = calcTotals(data);
  const prevStart = new Date(start); prevStart.setDate(prevStart.getDate() - 7);
  const prevEnd   = new Date(end);   prevEnd.setDate(prevEnd.getDate()   - 7);
  const prevTotals = calcTotals(await fetchReportData({ biz, start: prevStart, end: prevEnd, branchId }));
  const openingBalance = await fetchOpeningBalance(biz, branchId, start);
  const dailyBreakdown = buildDailyBreakdown({ invoices: data.invoices, receipts: data.receipts, payments: data.payments, expenses: data.expenses, start, end });
  const periodLabel = `${dateLabel(start)} → ${dateLabel(end)}`;
  biz.sessionState = "ready"; biz.sessionData = {}; await biz.save();

  // Growth comparison section
  const growth = (c, p) => { if (p === 0) return c > 0 ? " ▲ New" : ""; const pct2 = Math.round(((c - p) / p) * 100); return pct2 > 0 ? ` ▲ +${pct2}%` : pct2 < 0 ? ` ▼ ${pct2}%` : " → 0%"; };
  const cur = biz.currency || "USD";

  const trendRows = dailyBreakdown.map(d => {
    const sign = d.profit >= 0 ? "+" : "-";
    return `   ${d.dayLabel.padEnd(14)} ${fmtMoney(d.revenue, cur).padEnd(12)} ${fmtMoney(d.expenses, cur).padEnd(12)} ${sign}${fmtMoney(Math.abs(d.profit), cur)}`;
  }).join("\n");

  const summaryText = await buildWhatsAppSummary({
    biz, label: "Weekly Report", periodLabel, branchName, branchId, data, totals, start, end, openingBalance
  });
  const weekText = summaryText + `
━━━━━━━━━━━━━━━━━━━━━━━
📅 DAY BY DAY
   ${"DAY".padEnd(14)} ${"REVENUE".padEnd(12)} ${"EXPENSES".padEnd(12)} PROFIT
${trendRows}
━━━━━━━━━━━━━━━━━━━━━━━
VS PREVIOUS WEEK
   Revenue:  ${fmtMoney(prevTotals.moneyIn, cur)} → ${fmtMoney(totals.moneyIn, cur)}${growth(totals.moneyIn, prevTotals.moneyIn)}
   Expenses: ${fmtMoney(prevTotals.moneyOut, cur)} → ${fmtMoney(totals.moneyOut, cur)}${growth(totals.moneyOut, prevTotals.moneyOut)}
   Profit:   ${fmtMoney(prevTotals.profit, cur)} → ${fmtMoney(totals.profit, cur)}${growth(totals.profit, prevTotals.profit)}`;

  await sendReportText(from, weekText, biz, periodLabel, branchName, data, totals, prevTotals, "Weekly Report");
  await sendMainMenu(from);
  return true;
}


// ═══════════════════════════════════════════════════════════════════════════════
// MONTHLY SUMMARY REPORT  →  state "report_monthly"
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
  const text = await buildWhatsAppSummary({ biz, label: "Monthly Report", periodLabel, branchName, branchId, data, totals, start, end, openingBalance });
  await sendReportText(from, text, biz, periodLabel, branchName, data, totals, prevTotals, "Monthly Report");
  await sendMainMenu(from);
  return true;
}


// ═══════════════════════════════════════════════════════════════════════════════
// DETAILED LEDGER REPORT  →  state "report_detailed"
// ═══════════════════════════════════════════════════════════════════════════════
export async function runDetailedLedgerReport({ biz, from, period = "day" }) {
  const { branchId, branchName } = await resolveCallerAndBranch(biz, from);

  let start, end, label, periodLabel;
  if (period === "week") {
    const now = new Date(); const dow = now.getDay(); const diff = dow === 0 ? -6 : 1 - dow;
    start = new Date(now); start.setDate(now.getDate() + diff); start.setHours(0, 0, 0, 0);
    end   = new Date(start); end.setDate(start.getDate() + 6); end.setHours(23, 59, 59, 999);
    label = "Detailed Weekly Ledger"; periodLabel = `${dateLabel(start)} → ${dateLabel(end)}`;
  } else if (period === "month") {
    const now = new Date();
    start = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
    end   = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
    label = "Detailed Monthly Ledger";
    periodLabel = start.toLocaleDateString("en-GB", { month: "long", year: "numeric" });
  } else {
    start = new Date(); start.setHours(0,  0,  0,   0);
    end   = new Date(); end.setHours(23, 59, 59, 999);
    label = "Detailed Daily Ledger"; periodLabel = dateLabel(start);
  }

  const data          = await fetchReportData({ biz, start, end, branchId });
  const openingBalance = await fetchOpeningBalance(biz, branchId, start);

  biz.sessionState = "ready"; biz.sessionData = {}; await biz.save();

  const text = await buildDetailedLedgerText({ biz, label, periodLabel, branchName, branchId, data, start, end, openingBalance });
  await sendText(from, text);
  await sendMainMenu(from);
  return true;
}


// ═══════════════════════════════════════════════════════════════════════════════
// CLERK STATEMENT REPORT  →  state "report_clerk_statement"
// ═══════════════════════════════════════════════════════════════════════════════
export async function runClerkStatementReport({ biz, from, clerkPhone, period = "day" }) {
  const { branchId, branchName } = await resolveCallerAndBranch(biz, from);

  let start, end;
  if (period === "week") {
    const now = new Date(); const dow = now.getDay(); const diff = dow === 0 ? -6 : 1 - dow;
    start = new Date(now); start.setDate(now.getDate() + diff); start.setHours(0, 0, 0, 0);
    end   = new Date(start); end.setDate(start.getDate() + 6); end.setHours(23, 59, 59, 999);
  } else if (period === "month") {
    const now = new Date();
    start = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
    end   = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
  } else {
    start = new Date(); start.setHours(0,  0,  0,   0);
    end   = new Date(); end.setHours(23, 59, 59, 999);
  }

  biz.sessionState = "ready"; biz.sessionData = {}; await biz.save();

  const text = await buildClerkStatementText({ biz, clerkPhone, branchName, branchId, start, end });
  await sendText(from, text);
  await sendMainMenu(from);
  return true;
}