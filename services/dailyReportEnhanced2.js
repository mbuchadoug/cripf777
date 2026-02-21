/**
 * ═══════════════════════════════════════════════════════════════
 * ENHANCED DAILY REPORT - COMPLETE IMPLEMENTATION
 * ═══════════════════════════════════════════════════════════════
 * 
 * This replaces the existing runDailyReportMeta function
 * Provides comprehensive business insights with:
 * - Executive Summary
 * - Revenue Breakdown
 * - Top Products
 * - Overdue Analysis
 * - Expense Breakdown
 * - Business Insights & Actions
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

export async function runDailyReportMetaEnhanced({ biz, from }) {
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

  const start = new Date();
  start.setHours(0, 0, 0, 0);

  const end = new Date();
  end.setHours(23, 59, 59, 999);

  // ═══════════════════════════════════════════════════════════════
  // MANAGER REPORT (Branch-Specific)
  // ═══════════════════════════════════════════════════════════════

  if (effectiveCaller?.role === "manager" && effectiveCaller.branchId) {
    const branchFilter = { branchId: effectiveCaller.branchId };

    const invoices = await Invoice.find({
      businessId: biz._id,
      type: "invoice",
      ...branchFilter,
      createdAt: { $gte: start, $lte: end }
    }).lean();

    const payments = await InvoicePayment.find({
      businessId: biz._id,
      ...branchFilter,
      createdAt: { $gte: start, $lte: end }
    }).lean();

    const receipts = await Invoice.find({
      businessId: biz._id,
      type: "receipt",
      ...branchFilter,
      createdAt: { $gte: start, $lte: end }
    }).lean();

    const expenses = await Expense.find({
      businessId: biz._id,
      ...branchFilter,
      createdAt: { $gte: start, $lte: end }
    }).lean();

    // Basic calculations
    const invoiced = invoices.reduce((s, i) => s + (i.total || 0), 0);
    const paymentCash = payments.reduce((s, p) => s + (p.amount || 0), 0);
    const receiptCash = receipts.reduce((s, r) => s + (r.total || 0), 0);
    const cashReceived = paymentCash + receiptCash;
    const spent = expenses.reduce((s, e) => s + (e.amount || 0), 0);
    const outstanding = invoices.reduce((s, i) => s + (i.balance || 0), 0);

    // ═══════════════════════════════════════════════════════════════
    // ENHANCED ANALYTICS
    // ═══════════════════════════════════════════════════════════════

    // 1. Product Summary
    const productData = await buildProductSummary(invoices, receipts);

    // 2. Payment Status
    const paymentStatus = await buildPaymentStatus(invoices);

    // 3. Key Metrics
    const metrics = calculateKeyMetrics({
      invoiced,
      cashReceived,
      spent,
      invoiceCount: invoices.length,
      receiptCount: receipts.length
    });

    // 4. Overdue Analysis
    const overdueData = await buildOverdueAnalysis(invoices, biz);

    // 5. Expense Breakdown
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

    // 6. Generate Insights
    const insights = generateInsights({
      profitMargin: metrics.profitMargin,
      collectionRate: metrics.collectionRate,
      topProduct: productData.topProducts[0],
      overdueCount: overdueData.overdue.length,
      overdueAmount: overdueData.totalOverdue,
      netProfit: metrics.netProfit,
      currency: biz.currency
    });

    // 7. Generate Actions
    const actions = generateActionItems({
      overdueInvoices: overdueData.overdue,
      currentOutstanding: overdueData.current,
      collectionRate: metrics.collectionRate,
      profitMargin: metrics.profitMargin
    });

    // ═══════════════════════════════════════════════════════════════
    // BUILD REPORT MESSAGE
    // ═══════════════════════════════════════════════════════════════

    const msg = `📊 Daily Report (${start.toISOString().slice(0,10)})

━━━━━━━━━━━━━━━━━━━━

💰 BOTTOM LINE
Revenue: ${invoiced} ${biz.currency}
Cash Collected: ${cashReceived} ${biz.currency} (${metrics.collectionRate}%)
Expenses: ${spent} ${biz.currency}
📈 NET PROFIT: ${metrics.netProfit >= 0 ? '+' : ''}${metrics.netProfit} ${biz.currency}

⚡ KEY METRICS
Average Sale: ${metrics.avgSale} ${biz.currency}
Collection Rate: ${metrics.collectionRate}%
Profit Margin: ${metrics.profitMargin}%

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

📦 TOP SELLING ITEMS
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

  // ═══════════════════════════════════════════════════════════════
  // OWNER REPORT (All Branches Combined)
  // ═══════════════════════════════════════════════════════════════

  const Branch = (await import("../models/branch.js")).default;
 

  const branches = await Branch.find({ businessId: biz._id }).lean();
  const branchMap = new Map(branches.map(b => [String(b._id), b.name]));

  // Fetch all data
  const allInvoices = await Invoice.find({
    businessId: biz._id,
    type: "invoice",
    createdAt: { $gte: start, $lte: end }
  }).lean();

  const allReceipts = await Invoice.find({
    businessId: biz._id,
    type: "receipt",
    createdAt: { $gte: start, $lte: end }
  }).lean();

  const allPayments = await InvoicePayment.find({
    businessId: biz._id,
    createdAt: { $gte: start, $lte: end }
  }).lean();

  const allExpenses = await Expense.find({
    businessId: biz._id,
    createdAt: { $gte: start, $lte: end }
  }).lean();

  // Calculate totals
  const tInvoiced = allInvoices.reduce((s, i) => s + (i.total || 0), 0);
  const tPaymentCash = allPayments.reduce((s, p) => s + (p.amount || 0), 0);
  const tReceiptCash = allReceipts.reduce((s, r) => s + (r.total || 0), 0);
  const tCash = tPaymentCash + tReceiptCash;
  const tSpent = allExpenses.reduce((s, e) => s + (e.amount || 0), 0);
  const tOut = allInvoices.reduce((s, i) => s + (i.balance || 0), 0);

  // ═══════════════════════════════════════════════════════════════
  // ENHANCED ANALYTICS (Owner Level)
  // ═══════════════════════════════════════════════════════════════

  const productData = await buildProductSummary(allInvoices, allReceipts);
  const paymentStatus = await buildPaymentStatus(allInvoices);
  const metrics = calculateKeyMetrics({
    invoiced: tInvoiced,
    cashReceived: tCash,
    spent: tSpent,
    invoiceCount: allInvoices.length,
    receiptCount: allReceipts.length
  });
  const overdueData = await buildOverdueAnalysis(allInvoices, biz);

  // Expense breakdown
  const expensesByCategory = {};
  allExpenses.forEach(e => {
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
  // BUILD OWNER REPORT WITH BRANCH BREAKDOWN
  // ═══════════════════════════════════════════════════════════════

  // Branch aggregations
  const invAgg = await Invoice.aggregate([
    {
      $match: {
        businessId: biz._id,
        type: "invoice",
        createdAt: { $gte: start, $lte: end }
      }
    },
    {
      $group: {
        _id: { $ifNull: ["$branchId", "UNASSIGNED"] },
        count: { $sum: 1 },
        invoiced: { $sum: { $ifNull: ["$total", 0] } },
        outstanding: { $sum: { $ifNull: ["$balance", 0] } }
      }
    }
  ]);

  const payAgg = await InvoicePayment.aggregate([
    {
      $match: {
        businessId: biz._id,
        createdAt: { $gte: start, $lte: end }
      }
    },
    {
      $group: {
        _id: { $ifNull: ["$branchId", "UNASSIGNED"] },
        cashReceived: { $sum: { $ifNull: ["$amount", 0] } }
      }
    }
  ]);

  const receiptAgg = await Invoice.aggregate([
    {
      $match: {
        businessId: biz._id,
        type: "receipt",
        createdAt: { $gte: start, $lte: end }
      }
    },
    {
      $group: {
        _id: { $ifNull: ["$branchId", "UNASSIGNED"] },
        receiptsTotal: { $sum: { $ifNull: ["$total", 0] } }
      }
    }
  ]);

  const expAgg = await Expense.aggregate([
    {
      $match: {
        businessId: biz._id,
        createdAt: { $gte: start, $lte: end }
      }
    },
    {
      $group: {
        _id: { $ifNull: ["$branchId", "UNASSIGNED"] },
        spent: { $sum: { $ifNull: ["$amount", 0] } }
      }
    }
  ]);

  // Merge branch data
  const rows = new Map();

  function ensureRow(branchKey) {
    const k = String(branchKey);
    if (!rows.has(k)) {
      const name =
        k === "UNASSIGNED"
          ? "Unassigned/Main"
          : (branchMap.get(k) || "Unknown");
      rows.set(k, { 
        name, 
        invoices: 0, 
        invoiced: 0, 
        cashReceived: 0, 
        spent: 0, 
        outstanding: 0 
      });
    }
    return rows.get(k);
  }

  for (const r of invAgg) {
    const row = ensureRow(r._id);
    row.invoices = r.count || 0;
    row.invoiced = r.invoiced || 0;
    row.outstanding = r.outstanding || 0;
  }

  for (const r of payAgg) {
    const row = ensureRow(r._id);
    row.cashReceived = r.cashReceived || 0;
  }

  for (const r of receiptAgg) {
    const row = ensureRow(r._id);
    row.cashReceived += r.receiptsTotal || 0;
  }

  for (const r of expAgg) {
    const row = ensureRow(r._id);
    row.spent = r.spent || 0;
  }

  // Build branch section
  let branchSection = "";
  for (const row of rows.values()) {
    const profit = row.cashReceived - row.spent;
    branchSection += `🏬 ${row.name}\n` +
           `Invoices: ${row.invoices}\n` +
           `Invoiced: ${row.invoiced} ${biz.currency}\n` +
           `Cash in: ${row.cashReceived} ${biz.currency}\n` +
           `Cash out: ${row.spent} ${biz.currency}\n` +
           `💰 Profit: ${profit >= 0 ? "+" : ""}${profit} ${biz.currency}\n` +
           `Unpaid: ${row.outstanding} ${biz.currency}\n\n`;
  }

  // ═══════════════════════════════════════════════════════════════
  // FINAL OWNER REPORT MESSAGE
  // ═══════════════════════════════════════════════════════════════

  const msg = `📊 Daily Report (${start.toISOString().slice(0,10)})

━━━━━━━━━━━━━━━━━━━━

💰 BOTTOM LINE
Revenue: ${tInvoiced} ${biz.currency}
Cash Collected: ${tCash} ${biz.currency} (${metrics.collectionRate}%)
Expenses: ${tSpent} ${biz.currency}
📈 NET PROFIT: ${metrics.netProfit >= 0 ? '+' : ''}${metrics.netProfit} ${biz.currency}

⚡ KEY METRICS
Average Sale: ${metrics.avgSale} ${biz.currency}
Collection Rate: ${metrics.collectionRate}%
Profit Margin: ${metrics.profitMargin}%

━━━━━━━━━━━━━━━━━━━━

💵 REVENUE SOURCES
Total Invoiced: ${tInvoiced} ${biz.currency}

Sales Breakdown:
├─ Invoice Payments: ${tPaymentCash} ${biz.currency} (${allPayments.length} payments)
└─ Direct Sales: ${tReceiptCash} ${biz.currency} (${allReceipts.length} receipts)

Status Breakdown:
├─ ✅ Paid: ${paymentStatus.paid.amount} ${biz.currency} (${paymentStatus.paid.count} invoices)
├─ 🟡 Partial: ${paymentStatus.partial.amount} ${biz.currency} (${paymentStatus.partial.count} invoices)
└─ ⚠️ Unpaid: ${paymentStatus.unpaid.amount} ${biz.currency} (${paymentStatus.unpaid.count} invoices)

━━━━━━━━━━━━━━━━━━━━

📦 TOP SELLING ITEMS
${formatProductList(productData.topProducts, biz.currency)}
💡 ${productData.totalUnits} units sold across ${productData.uniqueProducts} product${productData.uniqueProducts !== 1 ? 's' : ''}

━━━━━━━━━━━━━━━━━━━━

⚠️ MONEY OWED (${tOut} ${biz.currency})

Overdue (>${biz.paymentTermsDays || 30} days):
${formatOverdueList(overdueData.overdue, biz.currency)}
Current Outstanding (0-${biz.paymentTermsDays || 30} days):
${formatCurrentList(overdueData.current, biz.currency)}
━━━━━━━━━━━━━━━━━━━━

💸 EXPENSES (${tSpent} ${biz.currency})
${expenseDetails || "  None\n"}
━━━━━━━━━━━━━━━━━━━━

🏬 BY BRANCH

${branchSection}
━━━━━━━━━━━━━━━━━━━━

💡 BUSINESS INSIGHTS
${formatInsightsList(insights)}
🎯 ACTION ITEMS
${formatActionsList(actions)}
━━━━━━━━━━━━━━━━━━━━

📋 Summary: ${allInvoices.length} invoices | ${allPayments.length} payments | ${allReceipts.length} receipts | ${allExpenses.length} expenses`;

  biz.sessionState = "ready";
  biz.sessionData = {};
  await biz.save();

  await sendText(from, msg);
  await sendMainMenu(from);
  return true;
}
