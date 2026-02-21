/**
 * ═══════════════════════════════════════════════════════════════
 * ENHANCED WEEKLY REPORT - COMPLETE IMPLEMENTATION
 * ═══════════════════════════════════════════════════════════════
 * 
 * Includes all daily report features PLUS:
 * - Week-over-week comparison
 * - Growth trends
 * - Performance indicators
 */

import {
  buildProductSummary,
  buildPaymentStatus,
  buildOverdueAnalysis,
  calculateKeyMetrics,
  generateInsights,
  generateActionItems,
  formatProductList,
  formatOverdueList,
  formatCurrentList,
  formatInsightsList,
  formatActionsList
} from "./reportHelpers.js";

export async function runWeeklyReportMetaEnhanced({ biz, from }) {
  const UserRole = (await import("../models/userRole.js")).default;
  const InvoicePayment = (await import("../models/invoicePayment.js")).default;
  const Invoice = (await import("../models/invoice.js")).default;
  const Expense = (await import("../models/expense.js")).default;
  const { sendText } = await import("./metaSender.js");
  const { sendMainMenu } = await import("./metaMenus.js");

  const caller = await UserRole.findOne({
    businessId: biz._id,
    phone: from.replace(/\D+/g, ""),
    pending: false
  });

  // Current week
  const end = new Date();
  end.setHours(23, 59, 59, 999);

  const start = new Date(end);
  start.setDate(start.getDate() - 6);
  start.setHours(0, 0, 0, 0);

  // Previous week (for comparison)
  const prevEnd = new Date(start);
  prevEnd.setSeconds(prevEnd.getSeconds() - 1);

  const prevStart = new Date(prevEnd);
  prevStart.setDate(prevStart.getDate() - 6);
  prevStart.setHours(0, 0, 0, 0);

  const query = {
    businessId: biz._id,
    createdAt: { $gte: start, $lte: end }
  };

  const prevQuery = {
    businessId: biz._id,
    createdAt: { $gte: prevStart, $lte: prevEnd }
  };

  if (caller?.role === "manager" && caller.branchId) {
    query.branchId = caller.branchId;
    prevQuery.branchId = caller.branchId;
  }

  // ═══════════════════════════════════════════════════════════════
  // FETCH CURRENT WEEK DATA
  // ═══════════════════════════════════════════════════════════════

  const invoices = await Invoice.find({
    ...query,
    type: "invoice"
  }).lean();
  
  const receipts = await Invoice.find({
    ...query,
    type: "receipt"
  }).lean();
  
  const payments = await InvoicePayment.find(query).lean();
  const expenses = await Expense.find(query).lean();

  // ═══════════════════════════════════════════════════════════════
  // FETCH PREVIOUS WEEK DATA (for comparison)
  // ═══════════════════════════════════════════════════════════════

  const prevInvoices = await Invoice.find({
    ...prevQuery,
    type: "invoice"
  }).lean();

  const prevReceipts = await Invoice.find({
    ...prevQuery,
    type: "receipt"
  }).lean();

  const prevPayments = await InvoicePayment.find(prevQuery).lean();
  const prevExpenses = await Expense.find(prevQuery).lean();

  // ═══════════════════════════════════════════════════════════════
  // CURRENT WEEK CALCULATIONS
  // ═══════════════════════════════════════════════════════════════

  const invoiced = invoices.reduce((s, i) => s + (i.total || 0), 0);
  const paymentCash = payments.reduce((s, p) => s + (p.amount || 0), 0);
  const receiptCash = receipts.reduce((s, r) => s + (r.total || 0), 0);
  const cashReceived = paymentCash + receiptCash;
  const spent = expenses.reduce((s, e) => s + (e.amount || 0), 0);
  const outstanding = invoices.reduce((s, i) => s + (i.balance || 0), 0);

  // ═══════════════════════════════════════════════════════════════
  // PREVIOUS WEEK CALCULATIONS (for comparison)
  // ═══════════════════════════════════════════════════════════════

  const prevInvoiced = prevInvoices.reduce((s, i) => s + (i.total || 0), 0);
  const prevPaymentCash = prevPayments.reduce((s, p) => s + (p.amount || 0), 0);
  const prevReceiptCash = prevReceipts.reduce((s, r) => s + (r.total || 0), 0);
  const prevCashReceived = prevPaymentCash + prevReceiptCash;
  const prevSpent = prevExpenses.reduce((s, e) => s + (e.amount || 0), 0);
  const prevProfit = prevCashReceived - prevSpent;

  // ═══════════════════════════════════════════════════════════════
  // CALCULATE GROWTH RATES
  // ═══════════════════════════════════════════════════════════════

  function calculateGrowth(current, previous) {
    if (previous === 0) {
      return current > 0 ? 100 : 0;
    }
    return Math.round(((current - previous) / previous) * 100);
  }

  const revenueGrowth = calculateGrowth(invoiced, prevInvoiced);
  const cashGrowth = calculateGrowth(cashReceived, prevCashReceived);
  const expenseGrowth = calculateGrowth(spent, prevSpent);
  const profit = cashReceived - spent;
  const profitGrowth = calculateGrowth(profit, prevProfit);

  // ═══════════════════════════════════════════════════════════════
  // ENHANCED ANALYTICS
  // ═══════════════════════════════════════════════════════════════

  const productData = await buildProductSummary(invoices, receipts);
  const paymentStatus = await buildPaymentStatus(invoices);
  const metrics = calculateKeyMetrics({
    invoiced,
    cashReceived,
    spent,
    invoiceCount: invoices.length,
    receiptCount: receipts.length
  });
  const overdueData = await buildOverdueAnalysis(invoices, biz);

  // Expense breakdown
  const expensesByCategory = {};
  expenses.forEach(e => {
    const cat = e.category || "Other";
    if (!expensesByCategory[cat]) {
      expensesByCategory[cat] = [];
    }
    expensesByCategory[cat].push({
      desc: e.description || cat,
      amount: e.amount
    });
  });

  let expenseDetails = "";
  Object.keys(expensesByCategory).forEach(cat => {
    const items = expensesByCategory[cat];
    const total = items.reduce((s, i) => s + i.amount, 0);
    
    expenseDetails += `${cat} (${total} ${biz.currency}):\n`;
    
    const grouped = {};
    items.forEach(item => {
      if (!grouped[item.desc]) {
        grouped[item.desc] = { count: 0, total: 0 };
      }
      grouped[item.desc].count++;
      grouped[item.desc].total += item.amount;
    });
    
    Object.keys(grouped).forEach(desc => {
      const g = grouped[desc];
      if (g.count > 1) {
        expenseDetails += `  • ${desc} (×${g.count}): ${g.total} ${biz.currency}\n`;
      } else {
        expenseDetails += `  • ${desc}: ${g.total} ${biz.currency}\n`;
      }
    });
  });

  const insights = generateInsights({
    profitMargin: metrics.profitMargin,
    collectionRate: metrics.collectionRate,
    topProduct: productData.topProducts[0],
    overdueCount: overdueData.overdue.length,
    overdueAmount: overdueData.totalOverdue,
    netProfit: metrics.netProfit,
    currency: biz.currency
  });

  const actions = generateActionItems({
    overdueInvoices: overdueData.overdue,
    currentOutstanding: overdueData.current,
    collectionRate: metrics.collectionRate,
    profitMargin: metrics.profitMargin
  });

  // ═══════════════════════════════════════════════════════════════
  // FORMAT GROWTH INDICATORS
  // ═══════════════════════════════════════════════════════════════

  function formatGrowth(growth) {
    if (growth > 0) return `📈 +${growth}%`;
    if (growth < 0) return `📉 ${growth}%`;
    return `━ 0%`;
  }

  // ═══════════════════════════════════════════════════════════════
  // BUILD REPORT MESSAGE
  // ═══════════════════════════════════════════════════════════════

  const msg = `📊 Weekly Report (${start.toISOString().slice(0,10)} → ${end.toISOString().slice(0,10)})

━━━━━━━━━━━━━━━━━━━━

💰 BOTTOM LINE
Revenue: ${invoiced} ${biz.currency} ${formatGrowth(revenueGrowth)}
Cash Collected: ${cashReceived} ${biz.currency} ${formatGrowth(cashGrowth)}
Expenses: ${spent} ${biz.currency} ${formatGrowth(expenseGrowth)}
📈 NET PROFIT: ${profit >= 0 ? '+' : ''}${profit} ${biz.currency} ${formatGrowth(profitGrowth)}

⚡ KEY METRICS
Average Sale: ${metrics.avgSale} ${biz.currency}
Collection Rate: ${metrics.collectionRate}%
Profit Margin: ${metrics.profitMargin}%

━━━━━━━━━━━━━━━━━━━━

📊 WEEK-OVER-WEEK TRENDS
Revenue: ${prevInvoiced} → ${invoiced} ${biz.currency} ${formatGrowth(revenueGrowth)}
Cash: ${prevCashReceived} → ${cashReceived} ${biz.currency} ${formatGrowth(cashGrowth)}
Expenses: ${prevSpent} → ${spent} ${biz.currency} ${formatGrowth(expenseGrowth)}
Profit: ${prevProfit >= 0 ? '+' : ''}${prevProfit} → ${profit >= 0 ? '+' : ''}${profit} ${biz.currency} ${formatGrowth(profitGrowth)}

━━━━━━━━━━━━━━━━━━━━

💵 REVENUE SOURCES
Total Invoiced: ${invoiced} ${biz.currency}

Sales Breakdown:
├─ Invoice Payments: ${paymentCash} ${biz.currency} (${payments.length} payments)
└─ Direct Sales: ${receiptCash} ${biz.currency} (${receipts.length} receipts)

Status Breakdown:
├─ ✅ Paid: ${paymentStatus.paid.amount} ${biz.currency} (${paymentStatus.paid.count} invoices)
├─ 🟡 Partial: ${paymentStatus.partial.amount} ${biz.currency} (${paymentStatus.partial.count} invoices)
└─ ⚠️ Unpaid: ${paymentStatus.unpaid.amount} ${biz.currency} (${paymentStatus.unpaid.count} invoices)

━━━━━━━━━━━━━━━━━━━━

📦 TOP SELLING ITEMS (This Week)
${formatProductList(productData.topProducts, biz.currency)}
💡 ${productData.totalUnits} units sold across ${productData.uniqueProducts} product${productData.uniqueProducts !== 1 ? 's' : ''}

━━━━━━━━━━━━━━━━━━━━

⚠️ MONEY OWED (${outstanding} ${biz.currency})

Overdue (>${biz.paymentTermsDays || 30} days):
${formatOverdueList(overdueData.overdue, biz.currency)}
Current Outstanding (0-${biz.paymentTermsDays || 30} days):
${formatCurrentList(overdueData.current, biz.currency)}
━━━━━━━━━━━━━━━━━━━━

💸 EXPENSES (${spent} ${biz.currency})
${expenseDetails || "  None\n"}
━━━━━━━━━━━━━━━━━━━━

💡 BUSINESS INSIGHTS
${formatInsightsList(insights)}
🎯 ACTION ITEMS
${formatActionsList(actions)}
━━━━━━━━━━━━━━━━━━━━

📋 Summary: ${invoices.length} invoices | ${payments.length} payments | ${receipts.length} receipts | ${expenses.length} expenses`;

  biz.sessionState = "ready";
  biz.sessionData = {};
  await biz.save();

  await sendText(from, msg);
  await sendMainMenu(from);
  return true;
}
