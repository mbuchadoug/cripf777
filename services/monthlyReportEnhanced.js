/**
 * ═══════════════════════════════════════════════════════════════
 * ENHANCED MONTHLY REPORT - COMPLETE IMPLEMENTATION
 * ═══════════════════════════════════════════════════════════════
 * 
 * Includes all weekly features PLUS:
 * - Month-over-month comparison
 * - Top customers analysis
 * - Best/worst performing days
 * - Monthly targets tracking
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

export async function runMonthlyReportMetaEnhanced({ biz, from }) {
  const UserRole = (await import("../models/userRole.js")).default;
  const InvoicePayment = (await import("../models/invoicePayment.js")).default;
  const Invoice = (await import("../models/invoice.js")).default;
  const Expense = (await import("../models/expense.js")).default;
  const Client = (await import("../models/client.js")).default;
  const { sendText } = await import("./metaSender.js");
  const { sendMainMenu } = await import("./metaMenus.js");

  const caller = await UserRole.findOne({
    businessId: biz._id,
    phone: from.replace(/\D+/g, ""),
    pending: false
  });

  // Current month
  const start = new Date();
  start.setDate(1);
  start.setHours(0, 0, 0, 0);

  const end = new Date();
  end.setHours(23, 59, 59, 999);

  // Previous month (for comparison)
  const prevStart = new Date(start);
  prevStart.setMonth(prevStart.getMonth() - 1);

  const prevEnd = new Date(start);
  prevEnd.setSeconds(prevEnd.getSeconds() - 1);

  const query = {
    businessId: biz._id,
    createdAt: { $gte: start, $lte: end }
  };

  const prevQuery = {
    businessId: biz._id,
    createdAt: { $gte: prevStart, $lte: prevEnd }
  };

 // Managers AND Clerks see branch-restricted reports
  if (caller?.role === "manager" || caller?.role === "clerk") {
    if (caller.branchId) {
      query.branchId = caller.branchId;
      prevQuery.branchId = caller.branchId;
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // FETCH CURRENT MONTH DATA
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
  // FETCH PREVIOUS MONTH DATA (for comparison)
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
  // CURRENT MONTH CALCULATIONS
  // ═══════════════════════════════════════════════════════════════

  const invoiced = invoices.reduce((s, i) => s + (i.total || 0), 0);
  const paymentCash = payments.reduce((s, p) => s + (p.amount || 0), 0);
  const receiptCash = receipts.reduce((s, r) => s + (r.total || 0), 0);
  const cashReceived = paymentCash + receiptCash;
  const spent = expenses.reduce((s, e) => s + (e.amount || 0), 0);
  const outstanding = invoices.reduce((s, i) => s + (i.balance || 0), 0);

  // ═══════════════════════════════════════════════════════════════
  // PREVIOUS MONTH CALCULATIONS
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
  // TOP CUSTOMERS ANALYSIS
  // ═══════════════════════════════════════════════════════════════

  const customerSpending = {};

  // Aggregate from invoices
  invoices.forEach(inv => {
    const clientId = String(inv.clientId);
    if (!customerSpending[clientId]) {
      customerSpending[clientId] = 0;
    }
    customerSpending[clientId] += inv.total || 0;
  });

  // Aggregate from receipts
  receipts.forEach(rec => {
    const clientId = String(rec.clientId);
    if (!customerSpending[clientId]) {
      customerSpending[clientId] = 0;
    }
    customerSpending[clientId] += rec.total || 0;
  });

  // Get top 5 customers
  const topCustomers = await Promise.all(
    Object.entries(customerSpending)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(async ([clientId, amount]) => {
        try {
          const client = await Client.findById(clientId).lean();
          return {
            name: client?.name || client?.phone || "Unknown",
            amount
          };
        } catch (err) {
          return {
            name: "Unknown",
            amount
          };
        }
      })
  );

  // ═══════════════════════════════════════════════════════════════
  // BEST/WORST PERFORMING DAYS
  // ═══════════════════════════════════════════════════════════════

  const dailySales = {};

  // Aggregate sales by day
  [...invoices, ...receipts].forEach(doc => {
    const day = new Date(doc.createdAt).toISOString().slice(0, 10);
    if (!dailySales[day]) {
      dailySales[day] = 0;
    }
    dailySales[day] += doc.total || 0;
  });

  const sortedDays = Object.entries(dailySales).sort((a, b) => b[1] - a[1]);
  const bestDay = sortedDays[0] || null;
  const worstDay = sortedDays[sortedDays.length - 1] || null;

  // ═══════════════════════════════════════════════════════════════
  // TOP INVOICES (Largest)
  // ═══════════════════════════════════════════════════════════════

  const topInvoices = invoices
    .sort((a, b) => b.total - a.total)
    .slice(0, 5);

  let topInvoicesList = "";
  topInvoices.forEach(inv => {
    topInvoicesList += `  ${inv.number}: ${inv.total} ${biz.currency}\n`;
  });

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

 const msg = `📊 Monthly Report (${start.toISOString().slice(0,7)})

━━━━━━━━━━━━━━━━━━━━

💰 YOUR MONEY THIS MONTH
Total Sales: ${invoiced} ${biz.currency} ${formatGrowth(revenueGrowth)}
Money In: ${cashReceived} ${biz.currency} ${formatGrowth(cashGrowth)}
Money Out: ${spent} ${biz.currency} ${formatGrowth(expenseGrowth)}
📈 PROFIT: ${profit >= 0 ? '+' : ''}${profit} ${biz.currency} ${formatGrowth(profitGrowth)}

⚡ QUICK STATS
Avg Sale: ${metrics.avgSale} ${biz.currency}
${metrics.collectionRate}% Paid
${metrics.profitMargin}% Profit

━━━━━━━━━━━━━━━━━━━━

📊 COMPARED TO LAST MONTH
Sales: ${prevInvoiced} → ${invoiced} ${biz.currency} ${formatGrowth(revenueGrowth)}
Money In: ${prevCashReceived} → ${cashReceived} ${biz.currency} ${formatGrowth(cashGrowth)}
Costs: ${prevSpent} → ${spent} ${biz.currency} ${formatGrowth(expenseGrowth)}
Profit: ${prevProfit >= 0 ? '+' : ''}${prevProfit} → ${profit >= 0 ? '+' : ''}${profit} ${biz.currency} ${formatGrowth(profitGrowth)}

━━━━━━━━━━━━━━━━━━━━

💵 WHERE MONEY CAME FROM
Total Sales: ${invoiced} ${biz.currency}

Cash Received:
├─ From Invoices: ${paymentCash} ${biz.currency} (${payments.length} payments)
└─ Direct Sales: ${receiptCash} ${biz.currency} (${receipts.length} sales)

Invoice Status:
├─ ✅ Fully Paid: ${paymentStatus.paid.count} invoices
├─ 🟡 Partly Paid: ${paymentStatus.partial.count} invoices
└─ ⚠️ Not Paid Yet: ${paymentStatus.unpaid.count} invoices

━━━━━━━━━━━━━━━━━━━━

📦 WHAT WAS SOLD
${formatProductList(productData.topProducts, biz.currency)}
💡 Sold ${productData.totalUnits} items (${productData.uniqueProducts} different products)

━━━━━━━━━━━━━━━━━━━━

👥 BEST CUSTOMERS THIS MONTH
${topCustomers.map((c, i) => `${i + 1}. ${c.name} - ${c.amount} ${biz.currency}`).join('\n') || '  No customer data'}

━━━━━━━━━━━━━━━━━━━━

📅 BEST & WORST DAYS
${bestDay ? `Best Day: ${bestDay[0]} (${bestDay[1]} ${biz.currency})` : 'No sales data'}
${worstDay && worstDay !== bestDay ? `Slowest Day: ${worstDay[0]} (${worstDay[1]} ${biz.currency})` : ''}

━━━━━━━━━━━━━━━━━━━━

🔝 BIGGEST INVOICES
${topInvoicesList || "  None\n"}
━━━━━━━━━━━━━━━━━━━━

⚠️ CUSTOMERS OWE YOU (${outstanding} ${biz.currency})

Late Payments (more than ${biz.paymentTermsDays || 30} days):
${formatOverdueList(overdueData.overdue, biz.currency)}
Recent (less than ${biz.paymentTermsDays || 30} days):
${formatCurrentList(overdueData.current, biz.currency)}
━━━━━━━━━━━━━━━━━━━━

💸 WHAT YOU SPENT (${spent} ${biz.currency})
${expenseDetails || "  Nothing spent\n"}
━━━━━━━━━━━━━━━━━━━━

💡 WHAT THIS MEANS
${formatInsightsList(insights)}
🎯 WHAT TO DO NEXT
${formatActionsList(actions)}
━━━━━━━━━━━━━━━━━━━━

📋 ${invoices.length} invoices | ${payments.length} payments | ${receipts.length} direct sales | ${expenses.length} expenses`;

  biz.sessionState = "ready";
  biz.sessionData = {};
  await biz.save();

  await sendText(from, msg);
  await sendMainMenu(from);
  return true;
}
