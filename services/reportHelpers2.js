/**
 * ═══════════════════════════════════════════════════════════════
 * COMPREHENSIVE REPORT HELPER FUNCTIONS
 * ═══════════════════════════════════════════════════════════════
 * 
 * These functions provide detailed analytics for business reports:
 * - Product performance analysis
 * - Payment status breakdown
 * - Overdue invoice tracking
 * - Key business metrics
 * - Actionable insights generation
 */

import Client from "../models/client.js";

/**
 * ═══════════════════════════════════════════════════════════════
 * 1. PRODUCT SALES SUMMARY
 * ═══════════════════════════════════════════════════════════════
 * 
 * Aggregates all items sold from invoices and receipts
 * Returns top 5 products by revenue with quantities
 */
export async function buildProductSummary(invoices, receipts) {
  const productMap = {};

  // Aggregate items from invoices
  invoices.forEach(inv => {
    if (!inv.items || !Array.isArray(inv.items)) return;
    
    inv.items.forEach(item => {
      const name = item.item || "Unknown Item";
      
      if (!productMap[name]) {
        productMap[name] = { 
          qty: 0, 
          revenue: 0,
          count: 0 // Number of times sold
        };
      }
      
      productMap[name].qty += item.qty || 0;
      productMap[name].revenue += item.total || 0;
      productMap[name].count += 1;
    });
  });

  // Aggregate items from receipts (direct sales)
  receipts.forEach(rec => {
    if (!rec.items || !Array.isArray(rec.items)) return;
    
    rec.items.forEach(item => {
      const name = item.item || "Unknown Item";
      
      if (!productMap[name]) {
        productMap[name] = { 
          qty: 0, 
          revenue: 0,
          count: 0
        };
      }
      
      productMap[name].qty += item.qty || 0;
      productMap[name].revenue += item.total || 0;
      productMap[name].count += 1;
    });
  });

  // Sort by revenue (highest first) and take top 5
  const sorted = Object.entries(productMap)
    .sort((a, b) => b[1].revenue - a[1].revenue)
    .slice(0, 5);

  // Calculate totals
  const totalUnits = Object.values(productMap)
    .reduce((sum, p) => sum + p.qty, 0);
  
  const uniqueProducts = Object.keys(productMap).length;

  return {
    topProducts: sorted.map(([name, data]) => ({
      name,
      qty: data.qty,
      revenue: data.revenue,
      count: data.count
    })),
    totalUnits,
    uniqueProducts
  };
}


/**
 * ═══════════════════════════════════════════════════════════════
 * 2. PAYMENT STATUS BREAKDOWN
 * ═══════════════════════════════════════════════════════════════
 * 
 * Categorizes invoices by payment status
 * Returns counts and amounts for paid/partial/unpaid
 */
export async function buildPaymentStatus(invoices) {
  const paid = invoices.filter(i => i.status === "paid");
  const partial = invoices.filter(i => i.status === "partial");
  const unpaid = invoices.filter(i => i.status === "unpaid");

  return {
    paid: {
      count: paid.length,
      amount: paid.reduce((s, i) => s + (i.total || 0), 0)
    },
    partial: {
      count: partial.length,
      amount: partial.reduce((s, i) => s + (i.total || 0), 0),
      outstanding: partial.reduce((s, i) => s + (i.balance || 0), 0)
    },
    unpaid: {
      count: unpaid.length,
      amount: unpaid.reduce((s, i) => s + (i.total || 0), 0)
    }
  };
}


/**
 * ═══════════════════════════════════════════════════════════════
 * 3. OVERDUE INVOICE ANALYSIS
 * ═══════════════════════════════════════════════════════════════
 * 
 * Identifies overdue invoices based on payment terms
 * Fetches client names for better reporting
 */
export async function buildOverdueAnalysis(invoices, biz) {
  const now = new Date();
  const termsDays = biz.paymentTermsDays || 30;

  const overdueList = [];
  const currentList = [];

  // Only analyze unpaid/partial invoices
  const unpaidInvoices = invoices.filter(
    i => i.status === "unpaid" || i.status === "partial"
  );

  for (const inv of unpaidInvoices) {
    if (inv.balance <= 0) continue; // Skip if no balance

    // Calculate due date
    const dueDate = new Date(inv.createdAt);
    dueDate.setDate(dueDate.getDate() + termsDays);

    // Days overdue (negative = not yet due)
    const daysOverdue = Math.floor((now - dueDate) / (1000 * 60 * 60 * 24));

    // Fetch client name
    let clientName = "Unknown Client";
    try {
      const client = await Client.findById(inv.clientId).lean();
      if (client) {
        clientName = client.name || client.phone || "Unknown Client";
      }
    } catch (err) {
      console.error("Error fetching client:", err);
    }

    const invoiceData = {
      number: inv.number,
      balance: inv.balance,
      total: inv.total,
      clientName,
      daysOverdue: Math.abs(daysOverdue),
      dueDate
    };

    if (daysOverdue > 0) {
      overdueList.push(invoiceData);
    } else {
      currentList.push(invoiceData);
    }
  }

  // Sort overdue by days (most overdue first)
  overdueList.sort((a, b) => b.daysOverdue - a.daysOverdue);

  // Sort current by balance (highest first)
  currentList.sort((a, b) => b.balance - a.balance);

  return {
    overdue: overdueList,
    current: currentList,
    totalOverdue: overdueList.reduce((s, i) => s + i.balance, 0),
    totalCurrent: currentList.reduce((s, i) => s + i.balance, 0)
  };
}


/**
 * ═══════════════════════════════════════════════════════════════
 * 4. KEY BUSINESS METRICS
 * ═══════════════════════════════════════════════════════════════
 * 
 * Calculates critical KPIs:
 * - Average sale value
 * - Collection rate
 * - Profit margin
 */
export function calculateKeyMetrics({
  invoiced,
  cashReceived,
  spent,
  invoiceCount,
  receiptCount
}) {
  const totalSales = invoiceCount + receiptCount;

  // Average sale value
  const avgSale = totalSales > 0 
    ? Math.round(invoiced / totalSales) 
    : 0;

  // Collection rate (% of invoiced amount collected)
  const collectionRate = invoiced > 0 
    ? Math.round((cashReceived / invoiced) * 100) 
    : 0;

  // Profit margin (% of revenue retained as profit)
  const profitMargin = cashReceived > 0 
    ? Math.round(((cashReceived - spent) / cashReceived) * 100) 
    : 0;

  // Net profit
  const netProfit = cashReceived - spent;

  return {
    avgSale,
    collectionRate,
    profitMargin,
    netProfit,
    totalSales
  };
}


/**
 * ═══════════════════════════════════════════════════════════════
 * 5. BUSINESS INSIGHTS GENERATOR
 * ═══════════════════════════════════════════════════════════════
 * 
 * Generates actionable insights based on business performance
 * Returns personalized recommendations
 */
export function generateInsights({
  profitMargin,
  collectionRate,
  topProduct,
  overdueCount,
  overdueAmount,
  netProfit,
  currency
}) {
  const insights = [];

  // ✅ PERFORMANCE INSIGHTS
  if (profitMargin > 50) {
    insights.push(`✅ Excellent profit margin (${profitMargin}%)`);
  } else if (profitMargin > 30) {
    insights.push(`✅ Healthy profit margin (${profitMargin}%)`);
  } else if (profitMargin > 0) {
    insights.push(`⚠️ Low profit margin (${profitMargin}%) - Review expenses`);
  } else {
    insights.push(`❌ Operating at a loss - Immediate action needed`);
  }

  // 📦 PRODUCT INSIGHTS
  if (topProduct) {
    insights.push(`📦 Top seller: ${topProduct.name} (${topProduct.revenue} ${currency})`);
  }

  // 💰 COLLECTION INSIGHTS
  if (collectionRate < 60) {
    insights.push(`⚠️ Low collection rate (${collectionRate}%) - Focus on follow-ups`);
  } else if (collectionRate < 80) {
    insights.push(`💡 Collection rate at ${collectionRate}% (Target: 80%+)`);
  } else {
    insights.push(`✅ Strong collections (${collectionRate}%)`);
  }

  // ⚠️ OVERDUE ALERTS
  if (overdueCount > 0) {
    insights.push(`⚠️ ${overdueCount} overdue invoice${overdueCount > 1 ? 's' : ''} (${overdueAmount} ${currency})`);
  }

  // 📈 PROFITABILITY
  if (netProfit > 0) {
    insights.push(`📈 Profitable period: +${netProfit} ${currency}`);
  } else if (netProfit < 0) {
    insights.push(`📉 Loss period: ${netProfit} ${currency}`);
  } else {
    insights.push(`⚖️ Break-even period`);
  }

  return insights;
}


/**
 * ═══════════════════════════════════════════════════════════════
 * 6. ACTION ITEMS GENERATOR
 * ═══════════════════════════════════════════════════════════════
 * 
 * Creates specific action items based on business data
 */
export function generateActionItems({
  overdueInvoices,
  currentOutstanding,
  collectionRate,
  profitMargin
}) {
  const actions = [];

  // Overdue invoices
  if (overdueInvoices.length > 0) {
    const topOverdue = overdueInvoices.slice(0, 2);
    topOverdue.forEach(inv => {
      actions.push(
        `📞 Contact ${inv.clientName} - ${inv.number} (${inv.daysOverdue}d overdue)`
      );
    });
  }

  // Low collection rate
  if (collectionRate < 70 && currentOutstanding.length > 0) {
    actions.push(`💰 Send reminders to ${currentOutstanding.length} client${currentOutstanding.length > 1 ? 's' : ''}`);
  }

  // Low profit margin
  if (profitMargin < 20 && profitMargin > 0) {
    actions.push(`📊 Review pricing - profit margin only ${profitMargin}%`);
  }

  // No urgent actions
  if (actions.length === 0) {
    actions.push(`✅ No urgent actions - business running smoothly`);
  }

  return actions;
}


/**
 * ═══════════════════════════════════════════════════════════════
 * 7. FORMAT PRODUCT LIST
 * ═══════════════════════════════════════════════════════════════
 * 
 * Creates formatted string for top products section
 */
export function formatProductList(topProducts, currency) {
  if (!topProducts || topProducts.length === 0) {
    return "  No products sold\n";
  }

  let output = "";
  topProducts.forEach((product, idx) => {
    output += `${idx + 1}. ${product.name} - ${product.qty} units → ${product.revenue} ${currency}\n`;
  });

  return output;
}


/**
 * ═══════════════════════════════════════════════════════════════
 * 8. FORMAT OVERDUE LIST
 * ═══════════════════════════════════════════════════════════════
 * 
 * Creates formatted string for overdue invoices section
 */
export function formatOverdueList(overdueInvoices, currency, limit = 3) {
  if (!overdueInvoices || overdueInvoices.length === 0) {
    return "└─ No overdue invoices ✅\n";
  }

  let output = "";
  const limited = overdueInvoices.slice(0, limit);

  limited.forEach(inv => {
    output += `├─ ${inv.clientName}: ${inv.balance} ${currency} (${inv.number}) - ${inv.daysOverdue}d overdue\n`;
  });

  // Show count if there are more
  if (overdueInvoices.length > limit) {
    const remaining = overdueInvoices.length - limit;
    output += `└─ ...and ${remaining} more\n`;
  } else {
    // Replace last ├─ with └─
    output = output.replace(/├─(?=[^├─]*$)/, '└─');
  }

  return output;
}


/**
 * ═══════════════════════════════════════════════════════════════
 * 9. FORMAT CURRENT OUTSTANDING LIST
 * ═══════════════════════════════════════════════════════════════
 * 
 * Creates formatted string for current outstanding invoices
 */
export function formatCurrentList(currentInvoices, currency, limit = 3) {
  if (!currentInvoices || currentInvoices.length === 0) {
    return "└─ No current outstanding\n";
  }

  let output = "";
  const limited = currentInvoices.slice(0, limit);

  limited.forEach(inv => {
    output += `├─ ${inv.clientName}: ${inv.balance} ${currency} (${inv.number})\n`;
  });

  // Show count if there are more
  if (currentInvoices.length > limit) {
    const remaining = currentInvoices.length - limit;
    output += `└─ ...and ${remaining} more\n`;
  } else {
    // Replace last ├─ with └─
    output = output.replace(/├─(?=[^├─]*$)/, '└─');
  }

  return output;
}


/**
 * ═══════════════════════════════════════════════════════════════
 * 10. FORMAT INSIGHTS LIST
 * ═══════════════════════════════════════════════════════════════
 * 
 * Creates formatted string for business insights
 */
export function formatInsightsList(insights) {
  if (!insights || insights.length === 0) {
    return "  No insights available\n";
  }

  return insights.map(insight => `  ${insight}`).join("\n") + "\n";
}


/**
 * ═══════════════════════════════════════════════════════════════
 * 11. FORMAT ACTION ITEMS LIST
 * ═══════════════════════════════════════════════════════════════
 * 
 * Creates formatted string for action items
 */
export function formatActionsList(actions) {
  if (!actions || actions.length === 0) {
    return "  No actions required\n";
  }

  return actions.map(action => `  ${action}`).join("\n") + "\n";
}
