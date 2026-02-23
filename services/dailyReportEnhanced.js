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

const { normalizePhone } = await import("./phone.js");

let phone = normalizePhone(from);
if (phone.startsWith("0")) phone = "263" + phone.slice(1);

const caller = await UserRole.findOne({
  businessId: biz._id,
  phone,
  pending: false
});

  // ✅ CHECK FOR BRANCH FILTER FROM SESSION
  const sessionBranchId = biz.sessionData?.reportBranchId;
  
  // ✅ CRITICAL: Clear IMMEDIATELY to prevent re-triggering
  if (sessionBranchId) {
    delete biz.sessionData.reportBranchId;
    biz.sessionState = "ready"; // ✅ FORCE STATE TO READY
    await biz.save();
  }
  
  // If owner selected a specific branch, treat them as a manager
  const effectiveCaller = sessionBranchId && caller?.role === "owner"
    ? { role: "manager", branchId: sessionBranchId }
    : caller;

  const start = new Date();
  start.setHours(0, 0, 0, 0);

  const end = new Date();
  end.setHours(23, 59, 59, 999);

  // ═══════════════════════════════════════════════════════════════
  // MANAGER REPORT (Branch-Specific)
  // ═══════════════════════════════════════════════════════════════
  // Managers AND Clerks see branch-restricted reports
  if ((effectiveCaller?.role === "manager" || caller?.role === "clerk" || caller?.role === "manager") && 
      (effectiveCaller?.branchId || caller?.branchId)) {
    const branchFilter = { branchId: effectiveCaller?.branchId || caller.branchId };
    //const branchFilter = { branchId: caller.branchId };

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

💰 YOUR MONEY TODAY
Total Sales: ${invoiced} ${biz.currency}
Money In: ${cashReceived} ${biz.currency} (${metrics.collectionRate}% paid)
Money Out: ${spent} ${biz.currency}
📈 PROFIT: ${metrics.netProfit >= 0 ? '+' : ''}${metrics.netProfit} ${biz.currency}

⚡ QUICK STATS
Avg Sale: ${metrics.avgSale} ${biz.currency}
${metrics.collectionRate}% Paid
${metrics.profitMargin}% Profit

━━━━━━━━━━━━━━━━━━━━

💵 WHERE MONEY CAME FROM
Total Sales: ${invoiced} ${biz.currency}

Cash Received:
├─ From Invoices: ${paymentCash} ${biz.currency} (${payments.length} payments)
└─ Direct Sales: ${receiptCash} ${biz.currency} (${receipts.length} sales)

Invoice Status:
├─ ✅ Fully Paid: ${paymentStatus.paid.count} invoices (${paymentStatus.paid.amount} ${biz.currency})
├─ 🟡 Partly Paid: ${paymentStatus.partial.count} invoices (${paymentStatus.partial.amount} ${biz.currency})
└─ ⚠️ Not Paid Yet: ${paymentStatus.unpaid.count} invoices (${paymentStatus.unpaid.amount} ${biz.currency})

━━━━━━━━━━━━━━━━━━━━

📦 WHAT WAS SOLD
${formatProductList(productData.topProducts, biz.currency)}
💡 Sold ${productData.totalUnits} items (${productData.uniqueProducts} different products)

━━━━━━━━━━━━━━━━━━━━

⚠️ CUSTOMERS OWE YOU (${outstanding} ${biz.currency})

Late Payments (more than ${biz.paymentTermsDays || 30} days):
${formatOverdueList(overdueData.overdue, biz.currency)}
Recent (less than ${biz.paymentTermsDays || 30} days):
${formatCurrentList(overdueData.current, biz.currency)}
━━━━━━━━━━━━━━━━━━━━

💸 WHAT YOU SPENT (${spent} ${biz.currency})
${expenseDetails || "  Nothing spent today\n"}
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

💰 YOUR MONEY TODAY
Total Sales: ${tInvoiced} ${biz.currency}
Money In: ${tCash} ${biz.currency} (${metrics.collectionRate}% paid)
Money Out: ${tSpent} ${biz.currency}
📈 PROFIT: ${metrics.netProfit >= 0 ? '+' : ''}${metrics.netProfit} ${biz.currency}

⚡ QUICK STATS
Avg Sale: ${metrics.avgSale} ${biz.currency}
${metrics.collectionRate}% Paid
${metrics.profitMargin}% Profit

━━━━━━━━━━━━━━━━━━━━

💵 WHERE MONEY CAME FROM
Total Sales: ${tInvoiced} ${biz.currency}

Cash Received:
├─ From Invoices: ${tPaymentCash} ${biz.currency} (${allPayments.length} payments)
└─ Direct Sales: ${tReceiptCash} ${biz.currency} (${allReceipts.length} sales)

Invoice Status:
├─ ✅ Fully Paid: ${paymentStatus.paid.count} invoices (${paymentStatus.paid.amount} ${biz.currency})
├─ 🟡 Partly Paid: ${paymentStatus.partial.count} invoices (${paymentStatus.partial.amount} ${biz.currency})
└─ ⚠️ Not Paid Yet: ${paymentStatus.unpaid.count} invoices (${paymentStatus.unpaid.amount} ${biz.currency})

━━━━━━━━━━━━━━━━━━━━

📦 Products / Services Sold
${formatProductList(productData.topProducts, biz.currency)}
💡 Sold ${productData.totalUnits} items (${productData.uniqueProducts} different products)

━━━━━━━━━━━━━━━━━━━━

⚠️ CUSTOMERS OWE YOU (${tOut} ${biz.currency})

Late Payments (more than ${biz.paymentTermsDays || 30} days):
${formatOverdueList(overdueData.overdue, biz.currency)}
Recent (less than ${biz.paymentTermsDays || 30} days):
${formatCurrentList(overdueData.current, biz.currency)}
━━━━━━━━━━━━━━━━━━━━

💸 WHAT YOU SPENT (${tSpent} ${biz.currency})
${expenseDetails || "  Nothing spent today\n"}
━━━━━━━━━━━━━━━━━━━━

🏬 BY BRANCH

${branchSection}
━━━━━━━━━━━━━━━━━━━━

💡 WHAT THIS MEANS
${formatInsightsList(insights)}
🎯 WHAT TO DO NEXT
${formatActionsList(actions)}
━━━━━━━━━━━━━━━━━━━━

📋 ${allInvoices.length} invoices | ${allPayments.length} payments | ${allReceipts.length} direct sales | ${allExpenses.length} expenses`;

  biz.sessionState = "ready";
  biz.sessionData = {};
  await biz.save();

  await sendText(from, msg);
  await sendMainMenu(from);
  return true;
}
