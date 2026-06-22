/**
 * services/reportHelpers.js
 * ─────────────────────────────────────────────────────────────
 * WHERE TO PUT THIS FILE:  services/reportHelpers.js
 * (full replacement of your existing reportHelpers.js)
 * ─────────────────────────────────────────────────────────────
 *
 * Exports:
 *  1.  buildProductSummary        – items sold across invoices + receipts
 *  2.  buildPaymentStatus         – paid / partial / unpaid breakdown
 *  3.  buildOverdueAnalysis       – overdue invoices with client names
 *  4.  calculateKeyMetrics        – avg sale, collection rate, margin
 *  5.  generateInsights           – plain-language performance notes
 *  6.  generateActionItems        – specific to-dos from the data
 *  7.  formatProductList          – WhatsApp-ready product string
 *  8.  formatOverdueList          – WhatsApp-ready overdue string
 *  9.  formatCurrentList          – WhatsApp-ready current outstanding
 * 10.  formatInsightsList         – WhatsApp-ready insights string
 * 11.  formatActionsList          – WhatsApp-ready actions string
 * 12.  buildStaffActivityTable    – who recorded what (name + role)
 * 13.  buildDrawingsSection       – owner drawings vs other payouts
 * 14.  buildHandoverLog           – shift handover timeline
 * 15.  buildDailyBreakdown        – per-day rows for weekly/monthly trend
 * 16.  buildIncomeStatement       – full P&L object (used by report builder)
 */

import Client   from "../models/client.js";
import UserRole from "../models/userRole.js";

// ─── Per-run staff name/role cache (cleared between report runs) ──────────────
const _staffCache = {};

async function resolveStaff(phone) {
  if (!phone) return { name: "System", role: "system" };
  const key = String(phone).replace(/\D/g, "");
  if (_staffCache[key]) return _staffCache[key];

  let p = key;
  if (p.startsWith("0")) p = "263" + p.slice(1);

  const u = await UserRole.findOne({ phone: p, pending: false })
    .select("name firstName lastName role")
    .lean();

  const name = u
    ? (u.name || `${u.firstName || ""} ${u.lastName || ""}`.trim() || p)
    : p;

  const result = { name: name || p, role: u?.role || "clerk" };
  _staffCache[key] = result;
  return result;
}

export function clearStaffCache() {
  Object.keys(_staffCache).forEach(k => delete _staffCache[k]);
}


// ═══════════════════════════════════════════════════════════════
// 1. PRODUCT SALES SUMMARY
// ═══════════════════════════════════════════════════════════════
export async function buildProductSummary(invoices, receipts) {
  const productMap = {};

  const addItems = docs => {
    docs.forEach(doc => {
      (doc.items || []).forEach(item => {
        const name = (item.item || item.name || "Unknown Item").slice(0, 40);
        if (!productMap[name]) productMap[name] = { qty: 0, revenue: 0, count: 0 };
        productMap[name].qty     += Number(item.qty   || 0);
        productMap[name].revenue += Number(item.total || 0);
        productMap[name].count   += 1;
      });
    });
  };

  addItems(invoices);
  addItems(receipts);

  const sorted       = Object.entries(productMap).sort((a, b) => b[1].revenue - a[1].revenue);
  const totalUnits   = Object.values(productMap).reduce((s, p) => s + p.qty, 0);
  const uniqueProducts = Object.keys(productMap).length;

  return {
    topProducts: sorted.map(([name, data]) => ({
      name, qty: data.qty, revenue: data.revenue, count: data.count
    })),
    totalUnits,
    uniqueProducts
  };
}


// ═══════════════════════════════════════════════════════════════
// 2. PAYMENT STATUS BREAKDOWN
// ═══════════════════════════════════════════════════════════════
export async function buildPaymentStatus(invoices) {
  const paid    = invoices.filter(i => i.status === "paid");
  const partial = invoices.filter(i => i.status === "partial");
  const unpaid  = invoices.filter(i => i.status === "unpaid");
  return {
    paid:    { count: paid.length,    amount: paid.reduce((s, i)    => s + (i.total || 0), 0) },
    partial: {
      count:       partial.length,
      amount:      partial.reduce((s, i) => s + (i.total   || 0), 0),
      outstanding: partial.reduce((s, i) => s + (i.balance || 0), 0)
    },
    unpaid:  { count: unpaid.length,  amount: unpaid.reduce((s, i)  => s + (i.total || 0), 0) }
  };
}


// ═══════════════════════════════════════════════════════════════
// 3. OVERDUE INVOICE ANALYSIS
// ═══════════════════════════════════════════════════════════════
export async function buildOverdueAnalysis(invoices, biz) {
  const now       = new Date();
  const termsDays = biz.paymentTermsDays || 30;
  const overdueList = [];
  const currentList = [];

  const unpaidInvoices = invoices.filter(
    i => (i.status === "unpaid" || i.status === "partial") && (i.balance || 0) > 0
  );

  for (const inv of unpaidInvoices) {
    const dueDate = new Date(inv.createdAt);
    dueDate.setDate(dueDate.getDate() + termsDays);
    const daysOverdue = Math.floor((now - dueDate) / 86_400_000);

    let clientName = "Unknown Client";
    try {
      const client = await Client.findById(inv.clientId).lean();
      if (client) clientName = client.name || client.phone || "Unknown Client";
    } catch (_) {}

    const row = {
      number: inv.number, balance: inv.balance, total: inv.total,
      clientName, daysOverdue: Math.abs(daysOverdue), dueDate
    };

    daysOverdue > 0 ? overdueList.push(row) : currentList.push(row);
  }

  overdueList.sort((a, b) => b.daysOverdue - a.daysOverdue);
  currentList.sort((a, b) => b.balance     - a.balance);

  return {
    overdue:      overdueList,
    current:      currentList,
    totalOverdue: overdueList.reduce((s, i) => s + i.balance, 0),
    totalCurrent: currentList.reduce((s, i) => s + i.balance, 0)
  };
}


// ═══════════════════════════════════════════════════════════════
// 4. KEY BUSINESS METRICS
// ═══════════════════════════════════════════════════════════════
export function calculateKeyMetrics({ invoiced, cashReceived, spent, invoiceCount, receiptCount }) {
  const totalSales     = invoiceCount + receiptCount;
  const avgSale        = totalSales > 0 ? Math.round(invoiced / totalSales) : 0;
  const collectionRate = invoiced > 0   ? Math.round((cashReceived / invoiced) * 100) : 0;
  const profitMargin   = cashReceived > 0
    ? Math.round(((cashReceived - spent) / cashReceived) * 100) : 0;
  const netProfit      = cashReceived - spent;
  return { avgSale, collectionRate, profitMargin, netProfit, totalSales };
}


// ═══════════════════════════════════════════════════════════════
// 5. INSIGHTS GENERATOR
// ═══════════════════════════════════════════════════════════════
export function generateInsights({ profitMargin, collectionRate, topProduct, overdueCount, overdueAmount, netProfit, currency }) {
  const insights = [];
  if      (profitMargin > 50) insights.push(`✅ Excellent — keeping ${profitMargin}% of revenue as profit`);
  else if (profitMargin > 30) insights.push(`✅ Healthy margin — ${profitMargin}% profit on revenue`);
  else if (profitMargin > 0)  insights.push(`⚠️ Thin margin (${profitMargin}%) — review your cost structure`);
  else                         insights.push(`❌ Operating at a loss — expenses exceed revenue`);
  if (topProduct) insights.push(`📦 Best seller: ${topProduct.name}`);
  if      (collectionRate < 60) insights.push(`⚠️ Only ${collectionRate}% of invoiced revenue collected — follow up urgently`);
  else if (collectionRate < 80) insights.push(`💡 ${collectionRate}% collection rate — room to improve`);
  else                           insights.push(`✅ Strong collection rate: ${collectionRate}%`);
  if (overdueCount > 0) insights.push(`⚠️ ${overdueCount} overdue invoice${overdueCount > 1 ? "s" : ""} — ${currency} ${overdueAmount.toFixed(2)} owed`);
  if      (netProfit > 0) insights.push(`📈 Net profit: ${currency} ${netProfit.toFixed(2)}`);
  else if (netProfit < 0) insights.push(`📉 Net loss: ${currency} ${Math.abs(netProfit).toFixed(2)}`);
  else                     insights.push(`⚖️ Break-even — no profit, no loss`);
  return insights;
}


// ═══════════════════════════════════════════════════════════════
// 6. ACTION ITEMS GENERATOR
// ═══════════════════════════════════════════════════════════════
export function generateActionItems({ overdueInvoices, currentOutstanding, collectionRate, profitMargin }) {
  const actions = [];
  overdueInvoices.slice(0, 2).forEach(inv => {
    actions.push(`📞 Call ${inv.clientName} — ${inv.number} (${inv.daysOverdue}d overdue, balance ${inv.balance})`);
  });
  if (collectionRate < 70 && currentOutstanding.length > 0)
    actions.push(`💰 Send ${currentOutstanding.length} payment reminder${currentOutstanding.length > 1 ? "s" : ""}`);
  if (profitMargin < 20 && profitMargin > 0)
    actions.push(`📊 Review pricing — profit margin is only ${profitMargin}%`);
  if (actions.length === 0) actions.push(`✅ All good — keep it up!`);
  return actions;
}


// ═══════════════════════════════════════════════════════════════
// 7–11. TEXT FORMATTERS (WhatsApp ready)
// ═══════════════════════════════════════════════════════════════
export function formatProductList(topProducts, currency) {
  if (!topProducts?.length) return "  No products sold\n";
  return topProducts.map((p, i) =>
    `${i + 1}. ${p.name} — ${p.qty} units → ${currency} ${p.revenue.toFixed(2)}`
  ).join("\n") + "\n";
}

export function formatOverdueList(overdueInvoices, currency, limit = 3) {
  if (!overdueInvoices?.length) return "└─ No overdue invoices ✅\n";
  let out = overdueInvoices.slice(0, limit).map(inv =>
    `├─ ${inv.clientName}: ${currency} ${inv.balance.toFixed(2)} (${inv.number}) — ${inv.daysOverdue}d overdue`
  ).join("\n") + "\n";
  if (overdueInvoices.length > limit) out += `└─ ...and ${overdueInvoices.length - limit} more\n`;
  else out = out.replace(/├─(?=[^├─]*$)/, "└─");
  return out;
}

export function formatCurrentList(currentInvoices, currency, limit = 3) {
  if (!currentInvoices?.length) return "└─ No current outstanding\n";
  let out = currentInvoices.slice(0, limit).map(inv =>
    `├─ ${inv.clientName}: ${currency} ${inv.balance.toFixed(2)} (${inv.number})`
  ).join("\n") + "\n";
  if (currentInvoices.length > limit) out += `└─ ...and ${currentInvoices.length - limit} more\n`;
  else out = out.replace(/├─(?=[^├─]*$)/, "└─");
  return out;
}

export function formatInsightsList(insights) {
  if (!insights?.length) return "  No insights available\n";
  return insights.map(i => `  ${i}`).join("\n") + "\n";
}

export function formatActionsList(actions) {
  if (!actions?.length) return "  No actions required\n";
  return actions.map(a => `  ${a}`).join("\n") + "\n";
}


// ═══════════════════════════════════════════════════════════════
// 12. STAFF ACTIVITY TABLE
// ═══════════════════════════════════════════════════════════════
/**
 * Groups invoices, receipts, expenses, payments by the phone
 * stored in createdBy / recordedBy, then resolves each phone
 * to a real name and role via UserRole.
 */
export async function buildStaffActivityTable({ invoices, receipts, expenses, payments }) {
  clearStaffCache();
  const staffMap = {};

  function getOrCreate(phone) {
    const key = (phone || "unknown").replace(/\D/g, "") || "unknown";
    if (!staffMap[key]) staffMap[key] = {
      phone: key, invoiceCount: 0, receiptCount: 0,
      expenseCount: 0, paymentCount: 0,
      totalRevenue: 0, totalExpenses: 0
    };
    return staffMap[key];
  }

  for (const inv of invoices) {
    const s = getOrCreate(inv.createdBy || inv.recordedBy || null);
    s.invoiceCount++; s.totalRevenue += Number(inv.total || 0);
  }
  for (const rec of receipts) {
    const s = getOrCreate(rec.createdBy || rec.recordedBy || null);
    s.receiptCount++; s.totalRevenue += Number(rec.total || 0);
  }
  for (const exp of expenses) {
    const s = getOrCreate(exp.createdBy || exp.recordedBy || null);
    s.expenseCount++; s.totalExpenses += Number(exp.amount || 0);
  }
  for (const pay of payments) {
    const s = getOrCreate(pay.createdBy || pay.recordedBy || null);
    s.paymentCount++;
  }

  const result = [];
  for (const [phone, stats] of Object.entries(staffMap)) {
    const { name, role } = await resolveStaff(phone === "unknown" ? null : phone);
    result.push({ name, role, ...stats });
  }

  result.sort((a, b) => b.totalRevenue - a.totalRevenue);
  return result;
}


// ═══════════════════════════════════════════════════════════════
// 13. DRAWINGS SECTION
// ═══════════════════════════════════════════════════════════════
/**
 * Fetches CashPayout records and splits them into:
 *   drawings     — payouts tagged as owner drawings
 *   otherPayouts — petty cash, misc
 * Also resolves the name of each person who recorded the payout.
 */
export async function buildDrawingsSection({ businessId, branchId, start, end }) {
  const CashPayout = (await import("../models/cashPayout.js")).default;
  const query = { businessId, createdAt: { $gte: start, $lte: end } };
  if (branchId) query.branchId = branchId;

  const payouts           = await CashPayout.find(query).lean();
  const drawingKeywords   = /draw|owner|personal|private|director/i;
  const drawings          = [];
  const otherPayouts      = [];

  for (const p of payouts) {
    const { name, role } = await resolveStaff(p.recordedBy || null);
    const enriched = { ...p, recordedByName: name, recordedByRole: role };
    drawingKeywords.test(p.reason || "") ? drawings.push(enriched) : otherPayouts.push(enriched);
  }

  return {
    drawings,
    otherPayouts,
    totalDrawings:     drawings.reduce((s, p)     => s + (p.amount || 0), 0),
    totalOtherPayouts: otherPayouts.reduce((s, p) => s + (p.amount || 0), 0)
  };
}


// ═══════════════════════════════════════════════════════════════
// 14. SHIFT HANDOVER LOG
// ═══════════════════════════════════════════════════════════════
export async function buildHandoverLog({ businessId, branchId, start, end }) {
  let CashHandover;
  try { CashHandover = (await import("../models/cashHandover.js")).default; }
  catch (_) { return { handovers: [], totalHandovers: 0 }; }

  const query = { businessId, handoverAt: { $gte: start, $lte: end } };
  if (branchId) query.branchId = branchId;

  const handovers = await CashHandover.find(query).sort({ handoverAt: 1 }).lean();

  return {
    handovers: handovers.map(h => ({
      outgoing:     h.outgoingName  || h.outgoingPhone  || "Unknown",
      outgoingRole: h.outgoingRole  || "clerk",
      incoming:     h.incomingName  || h.incomingPhone  || "Unknown",
      incomingRole: h.incomingRole  || "clerk",
      amountCounted: h.amountCounted || 0,
      notes:        h.notes || "",
      time: new Date(h.handoverAt).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }),
      date: new Date(h.handoverAt).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })
    })),
    totalHandovers: handovers.length
  };
}


// ═══════════════════════════════════════════════════════════════
// 15. DAILY BREAKDOWN (trend rows for weekly / monthly reports)
// ═══════════════════════════════════════════════════════════════
export function buildDailyBreakdown({ invoices, receipts, payments, expenses, start, end }) {
  const dayMap = {};
  const dayKey  = d => new Date(d).toISOString().slice(0, 10);
  const dayLabel = k => new Date(k).toLocaleDateString("en-GB", {
    weekday: "short", day: "numeric", month: "short"
  });

  // Seed all days in range (so zero-activity days still appear)
  const cursor = new Date(start);
  while (cursor <= end) {
    const k = dayKey(cursor);
    dayMap[k] = { revenue: 0, expenses: 0, invoiceCount: 0, receiptCount: 0, paymentCount: 0 };
    cursor.setDate(cursor.getDate() + 1);
  }

  for (const inv of invoices) {
    const k = dayKey(inv.createdAt);
    if (dayMap[k]) { dayMap[k].revenue += Number(inv.total || 0); dayMap[k].invoiceCount++; }
  }
  for (const rec of receipts) {
    const k = dayKey(rec.createdAt);
    if (dayMap[k]) { dayMap[k].revenue += Number(rec.total || 0); dayMap[k].receiptCount++; }
  }
  for (const pay of payments) {
    const k = dayKey(pay.createdAt);
    if (dayMap[k]) dayMap[k].paymentCount++;
  }
  for (const exp of expenses) {
    const k = dayKey(exp.createdAt);
    if (dayMap[k]) dayMap[k].expenses += Number(exp.amount || 0);
  }

  return Object.entries(dayMap).sort().map(([k, v]) => ({
    date: k, dayLabel: dayLabel(k),
    revenue: v.revenue, expenses: v.expenses,
    profit: v.revenue - v.expenses,
    invoiceCount: v.invoiceCount, receiptCount: v.receiptCount, paymentCount: v.paymentCount
  }));
}


// ═══════════════════════════════════════════════════════════════
// 16. FULL INCOME STATEMENT OBJECT
// ═══════════════════════════════════════════════════════════════
/**
 * Assembles the complete P&L object consumed by the WhatsApp
 * text builder and the PDF generator.
 */
export async function buildIncomeStatement({ biz, data, branchId, start, end, openingBalance = 0 }) {
  const { invoices, receipts, payments, expenses } = data;

  const invoicePaymentsReceived = payments.reduce((s, p) => s + (p.amount || 0), 0);
  const cashSales               = receipts.reduce((s, r) => s + (r.total  || 0), 0);
  const grossRevenue            = invoicePaymentsReceived + cashSales;

  const byCategory = {};
  for (const e of expenses) {
    const cat = e.category || "Uncategorised";
    byCategory[cat] = (byCategory[cat] || 0) + (e.amount || 0);
  }
  const totalExpenses = expenses.reduce((s, e) => s + (e.amount || 0), 0);

  const drawingsData    = await buildDrawingsSection({ businessId: biz._id, branchId, start, end });
  const operatingProfit = grossRevenue - totalExpenses;
  const netProfit       = operatingProfit - drawingsData.totalDrawings;

  const cashIn          = grossRevenue;
  const cashOut         = totalExpenses + drawingsData.totalDrawings + drawingsData.totalOtherPayouts;
  const closingBalance  = openingBalance + cashIn - cashOut;

  const totalInvoiced    = invoices.reduce((s, i) => s + (i.total   || 0), 0);
  const totalOutstanding = invoices.reduce((s, i) => s + (i.balance || 0), 0);

  const staffActivity = await buildStaffActivityTable({ invoices, receipts, expenses, payments });
  const handoverData  = await buildHandoverLog({ businessId: biz._id, branchId, start, end });

  return {
    revenue:  { invoicePaymentsReceived, cashSales, grossRevenue },
    expenses: { byCategory, totalExpenses, list: expenses },
    drawings: drawingsData,
    profit:   { grossProfit: grossRevenue, operatingProfit, netProfit },
    cashPosition: { openingBalance, cashIn, cashOut, closingBalance },
    invoiceSummary: {
      totalInvoiced, totalOutstanding,
      count: invoices.length, payments: payments.length, receipts: receipts.length
    },
    staffActivity,
    handoverLog: handoverData.handovers,
    rawData: data
  };
}