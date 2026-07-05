/**
 * services/reportHelpers.js  - FULL REPLACEMENT
 * ─────────────────────────────────────────────────────────────
 * Builds all data structures consumed by the three report types:
 *
 *   SUMMARY REPORT    - totals, P&L, staff table, overdue
 *   DETAILED LEDGER   - every transaction as a running-balance row
 *   CLERK STATEMENT   - one clerk's shift: custody, transactions, handover
 *
 * ─────────────────────────────────────────────────────────────
 * EXPORTS
 * ─────────────────────────────────────────────────────────────
 *  Shared
 *    resolveStaff            phone → { name, role }
 *    clearStaffCache
 *    fmtMoney                number → "$1,234.56"
 *    fmtDT                   Date   → "21 Jun 14:02"
 *    fmtDate                 Date   → "21 Jun 2026"
 *
 *  Summary report
 *    buildProductSummary
 *    buildPaymentStatus
 *    buildOverdueAnalysis
 *    calculateKeyMetrics
 *    generateInsights
 *    generateActionItems
 *    formatInsightsList
 *    formatActionsList
 *    buildDrawingsSection
 *    buildHandoverLog
 *    buildDailyBreakdown
 *    buildStaffActivityTable
 *    buildIncomeStatement
 *
 *  Detailed ledger
 *    buildLedger             → chronological transaction rows + running balance
 *
 *  Clerk statement
 *    buildClerkStatement     → one clerk's custody statement
 */

import Client   from "../models/client.js";
import UserRole from "../models/userRole.js";

// ═══════════════════════════════════════════════════════════════
// SHARED UTILITIES
// ═══════════════════════════════════════════════════════════════

const _staffCache = {};

export async function resolveStaff(phone) {
  if (!phone) return { name: "Unknown", role: "unknown" };
  const key = String(phone).replace(/\D/g, "");
  if (_staffCache[key]) return _staffCache[key];
  let p = key;
  if (p.startsWith("0")) p = "263" + p.slice(1);
  const u = await UserRole.findOne({ phone: p, pending: false })
    .select("name firstName lastName role").lean();
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

export function fmtMoney(n, cur = "USD") {
  const sym = cur === "ZWL" ? "ZWL " : cur === "ZAR" ? "R " : "$ ";
  return `${sym}${Number(n || 0).toFixed(2)}`;
}

export function fmtDT(d) {
  return new Date(d).toLocaleDateString("en-GB", {
    day: "numeric", month: "short",
    hour: "2-digit", minute: "2-digit"
  });
}

export function fmtDate(d) {
  return new Date(d).toLocaleDateString("en-GB", {
    day: "numeric", month: "short", year: "numeric"
  });
}

// Keep the old fmt export so weeklyReportEnhanced.js doesn't break
export const fmt = fmtMoney;
export const pct = (a, b) => (b > 0 ? Math.round((a / b) * 100) : 0);


// ═══════════════════════════════════════════════════════════════
// 1. PRODUCT SALES SUMMARY
// ═══════════════════════════════════════════════════════════════
export async function buildProductSummary(invoices, receipts) {
  const productMap = {};
  const addItems = docs => {
    for (const doc of docs) {
      for (const item of doc.items || []) {
        const name = (item.item || item.name || "Unknown Item").slice(0, 40);
        if (!productMap[name]) productMap[name] = { qty: 0, revenue: 0, count: 0 };
        productMap[name].qty     += Number(item.qty   || 0);
        productMap[name].revenue += Number(item.total || 0);
        productMap[name].count++;
      }
    }
  };
  addItems(invoices);
  addItems(receipts);
  const sorted = Object.entries(productMap).sort((a, b) => b[1].revenue - a[1].revenue);
  return {
    topProducts: sorted.map(([name, d]) => ({ name, qty: d.qty, revenue: d.revenue, count: d.count })),
    totalUnits:   Object.values(productMap).reduce((s, p) => s + p.qty, 0),
    uniqueProducts: Object.keys(productMap).length
  };
}


// ═══════════════════════════════════════════════════════════════
// 2. PAYMENT STATUS
// ═══════════════════════════════════════════════════════════════
export async function buildPaymentStatus(invoices) {
  const paid    = invoices.filter(i => i.status === "paid");
  const partial = invoices.filter(i => i.status === "partial");
  const unpaid  = invoices.filter(i => i.status === "unpaid");
  return {
    paid:    { count: paid.length,    amount: paid.reduce((s, i)    => s + (i.total || 0), 0) },
    partial: { count: partial.length, amount: partial.reduce((s, i) => s + (i.total || 0), 0),
               outstanding: partial.reduce((s, i) => s + (i.balance || 0), 0) },
    unpaid:  { count: unpaid.length,  amount: unpaid.reduce((s, i)  => s + (i.total || 0), 0) }
  };
}


// ═══════════════════════════════════════════════════════════════
// 3. OVERDUE INVOICE ANALYSIS
// ═══════════════════════════════════════════════════════════════
export async function buildOverdueAnalysis(invoices, biz) {
  const now       = new Date();
  const termsDays = biz.paymentTermsDays || 30;
  const overdueList = [], currentList = [];
  for (const inv of invoices.filter(i => (i.status === "unpaid" || i.status === "partial") && (i.balance || 0) > 0)) {
    const dueDate = new Date(inv.createdAt);
    dueDate.setDate(dueDate.getDate() + termsDays);
    const daysOverdue = Math.floor((now - dueDate) / 86_400_000);
    let clientName = "Unknown Client";
    try { const c = await Client.findById(inv.clientId).lean(); if (c) clientName = c.name || c.phone || clientName; } catch (_) {}
    const row = { number: inv.number, balance: inv.balance, total: inv.total, clientName, daysOverdue: Math.abs(daysOverdue), dueDate };
    daysOverdue > 0 ? overdueList.push(row) : currentList.push(row);
  }
  overdueList.sort((a, b) => b.daysOverdue - a.daysOverdue);
  currentList.sort((a, b) => b.balance - a.balance);
  return {
    overdue: overdueList, current: currentList,
    totalOverdue: overdueList.reduce((s, i) => s + i.balance, 0),
    totalCurrent: currentList.reduce((s, i) => s + i.balance, 0)
  };
}


// ═══════════════════════════════════════════════════════════════
// 4. KEY METRICS
// ═══════════════════════════════════════════════════════════════
export function calculateKeyMetrics({ invoiced, cashReceived, spent, invoiceCount, receiptCount }) {
  const totalSales     = invoiceCount + receiptCount;
  const avgSale        = totalSales > 0    ? Math.round(invoiced / totalSales) : 0;
  const collectionRate = invoiced > 0      ? Math.round((cashReceived / invoiced) * 100) : 0;
  const profitMargin   = cashReceived > 0  ? Math.round(((cashReceived - spent) / cashReceived) * 100) : 0;
  return { avgSale, collectionRate, profitMargin, netProfit: cashReceived - spent, totalSales };
}


// ═══════════════════════════════════════════════════════════════
// 5. INSIGHTS
// ═══════════════════════════════════════════════════════════════
export function generateInsights({ profitMargin, collectionRate, topProduct, overdueCount, overdueAmount, netProfit, currency }) {
  const i = [];
  if      (profitMargin > 50) i.push(`✅ Excellent - keeping ${profitMargin}% of revenue as profit`);
  else if (profitMargin > 30) i.push(`✅ Healthy - ${profitMargin}% profit margin`);
  else if (profitMargin > 0)  i.push(`⚠️ Thin margin (${profitMargin}%) - review costs`);
  else                         i.push(`❌ Operating at a loss`);
  if (topProduct) i.push(`📦 Best seller: ${topProduct.name}`);
  if      (collectionRate < 60) i.push(`⚠️ Only ${collectionRate}% of invoices collected - urgent`);
  else if (collectionRate < 80) i.push(`💡 ${collectionRate}% collection - aim for 80%+`);
  else                           i.push(`✅ Strong collection rate: ${collectionRate}%`);
  if (overdueCount > 0) i.push(`⚠️ ${overdueCount} overdue invoice${overdueCount > 1 ? "s" : ""} - ${currency} ${overdueAmount.toFixed(2)} owed`);
  if      (netProfit > 0) i.push(`📈 Net profit: ${currency} ${netProfit.toFixed(2)}`);
  else if (netProfit < 0) i.push(`📉 Net loss: ${currency} ${Math.abs(netProfit).toFixed(2)}`);
  else                     i.push(`⚖️ Break-even`);
  return i;
}


// ═══════════════════════════════════════════════════════════════
// 6. ACTION ITEMS
// ═══════════════════════════════════════════════════════════════
export function generateActionItems({ overdueInvoices, currentOutstanding, collectionRate, profitMargin }) {
  const a = [];
  overdueInvoices.slice(0, 2).forEach(inv =>
    a.push(`📞 Call ${inv.clientName} - ${inv.number} (${inv.daysOverdue}d overdue, bal ${inv.balance})`)
  );
  if (collectionRate < 70 && currentOutstanding.length > 0)
    a.push(`💰 Send ${currentOutstanding.length} payment reminder${currentOutstanding.length > 1 ? "s" : ""}`);
  if (profitMargin < 20 && profitMargin > 0)
    a.push(`📊 Review pricing - margin only ${profitMargin}%`);
  if (!a.length) a.push(`✅ All good - keep it up!`);
  return a;
}


// ═══════════════════════════════════════════════════════════════
// 7. TEXT FORMATTERS
// ═══════════════════════════════════════════════════════════════
export function formatInsightsList(insights) {
  return insights?.length ? insights.map(i => `  ${i}`).join("\n") + "\n" : "  No insights\n";
}
export function formatActionsList(actions) {
  return actions?.length ? actions.map(a => `  ${a}`).join("\n") + "\n" : "  No actions required\n";
}
export function formatOverdueList(list, currency, limit = 3) {
  if (!list?.length) return "  ✅ No overdue invoices\n";
  return list.slice(0, limit).map(inv =>
    `  ⚠️ ${inv.clientName.slice(0, 20).padEnd(20)} ${fmtMoney(inv.balance, currency)} - ${inv.number} (${inv.daysOverdue}d)`
  ).join("\n") + (list.length > limit ? `\n  ...and ${list.length - limit} more` : "") + "\n";
}
export function formatCurrentList(list, currency, limit = 3) {
  if (!list?.length) return "  No current outstanding\n";
  return list.slice(0, limit).map(inv =>
    `  ${inv.clientName.slice(0, 20).padEnd(20)} ${fmtMoney(inv.balance, currency)} - ${inv.number}`
  ).join("\n") + (list.length > limit ? `\n  ...and ${list.length - limit} more` : "") + "\n";
}
export function formatProductList(products, currency) {
  if (!products?.length) return "  No products sold\n";
  return products.map((p, i) =>
    `  ${(i + 1 + ".").padEnd(3)} ${p.name.slice(0, 28).padEnd(28)} ${fmtMoney(p.revenue, currency)} (qty: ${p.qty})`
  ).join("\n") + "\n";
}


// ═══════════════════════════════════════════════════════════════
// 8. STAFF ACTIVITY TABLE
// ═══════════════════════════════════════════════════════════════
export async function buildStaffActivityTable({ invoices, receipts, expenses, payments }) {
  clearStaffCache();
  const map = {};
  const get = phone => {
    const k = (phone || "unknown").replace(/\D/g, "") || "unknown";
    if (!map[k]) map[k] = { phone: k, invoiceCount: 0, receiptCount: 0, expenseCount: 0, paymentCount: 0, totalRevenue: 0, totalExpenses: 0 };
    return map[k];
  };
  for (const x of invoices)  { const s = get(x.createdBy || x.recordedBy); s.invoiceCount++;  s.totalRevenue  += Number(x.total  || 0); }
  for (const x of receipts)  { const s = get(x.createdBy || x.recordedBy); s.receiptCount++;  s.totalRevenue  += Number(x.total  || 0); }
  for (const x of expenses)  { const s = get(x.createdBy || x.recordedBy); s.expenseCount++;  s.totalExpenses += Number(x.amount || 0); }
  for (const x of payments)  { const s = get(x.createdBy || x.recordedBy); s.paymentCount++; }
  const result = [];
  for (const [phone, stats] of Object.entries(map)) {
    const { name, role } = await resolveStaff(phone === "unknown" ? null : phone);
    result.push({ name, role, ...stats });
  }
  return result.sort((a, b) => b.totalRevenue - a.totalRevenue);
}


// ═══════════════════════════════════════════════════════════════
// 9. DRAWINGS SECTION
// ═══════════════════════════════════════════════════════════════
export async function buildDrawingsSection({ businessId, branchId, start, end }) {
  const CashPayout = (await import("../models/cashPayout.js")).default;
  const q = { businessId, createdAt: { $gte: start, $lte: end } };
  if (branchId) q.branchId = branchId;
  const payouts = await CashPayout.find(q).lean();
  const RE = /draw|owner|personal|private|director/i;
  const drawings = [], otherPayouts = [];
  for (const p of payouts) {
    const { name, role } = await resolveStaff(p.createdBy || null);
    const e = { ...p, recordedByName: name, recordedByRole: role };
    RE.test(p.reason || "") ? drawings.push(e) : otherPayouts.push(e);
  }
  return {
    drawings, otherPayouts,
    totalDrawings:     drawings.reduce((s, p) => s + (p.amount || 0), 0),
    totalOtherPayouts: otherPayouts.reduce((s, p) => s + (p.amount || 0), 0)
  };
}


// ═══════════════════════════════════════════════════════════════
// 10. HANDOVER LOG
// ═══════════════════════════════════════════════════════════════
export async function buildHandoverLog({ businessId, branchId, start, end }) {
  let CashHandover;
  try { CashHandover = (await import("../models/cashHandover.js")).default; }
  catch (_) { return { handovers: [], totalHandovers: 0 }; }
  const q = { businessId, handoverAt: { $gte: start, $lte: end } };
  if (branchId) q.branchId = branchId;
  const rows = await CashHandover.find(q).sort({ handoverAt: 1 }).lean();
  return {
    handovers: rows.map(h => ({
      outgoing:      h.outgoingName || h.outgoingPhone || "Unknown",
      outgoingRole:  h.outgoingRole || "clerk",
      incoming:      h.incomingName || h.incomingPhone || "Unknown",
      incomingRole:  h.incomingRole || "clerk",
      amountCounted: h.amountCounted || 0,
      notes:         h.notes || "",
      handoverAt:    h.handoverAt,
      time: new Date(h.handoverAt).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }),
      date: new Date(h.handoverAt).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })
    })),
    totalHandovers: rows.length
  };
}


// ═══════════════════════════════════════════════════════════════
// 11. DAILY BREAKDOWN (for weekly/monthly trend table)
// ═══════════════════════════════════════════════════════════════
export function buildDailyBreakdown({ invoices, receipts, payments, expenses, start, end }) {
  const map   = {};
  const key   = d => new Date(d).toISOString().slice(0, 10);
  const label = k => new Date(k).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
  const cursor = new Date(start);
  while (cursor <= end) {
    map[key(cursor)] = { revenue: 0, expenses: 0, invoiceCount: 0, receiptCount: 0 };
    cursor.setDate(cursor.getDate() + 1);
  }
  for (const x of invoices) if (map[key(x.createdAt)]) { map[key(x.createdAt)].revenue += Number(x.total || 0); map[key(x.createdAt)].invoiceCount++; }
  for (const x of receipts) if (map[key(x.createdAt)]) { map[key(x.createdAt)].revenue += Number(x.total || 0); map[key(x.createdAt)].receiptCount++; }
  for (const x of expenses) if (map[key(x.createdAt)]) map[key(x.createdAt)].expenses += Number(x.amount || 0);
  return Object.entries(map).sort().map(([k, v]) => ({
    date: k, dayLabel: label(k),
    revenue: v.revenue, expenses: v.expenses, profit: v.revenue - v.expenses,
    invoiceCount: v.invoiceCount, receiptCount: v.receiptCount
  }));
}


// ═══════════════════════════════════════════════════════════════
// 12. FULL INCOME STATEMENT OBJECT  (Summary report backbone)
// ═══════════════════════════════════════════════════════════════
export async function buildIncomeStatement({ biz, data, branchId, start, end, openingBalance = 0 }) {
  const { invoices, receipts, payments, expenses } = data;
  const invoicePaymentsReceived = payments.reduce((s, p) => s + (p.amount || 0), 0);
  const cashSales               = receipts.reduce((s, r) => s + (r.total  || 0), 0);
  const grossRevenue            = invoicePaymentsReceived + cashSales;
  const byCategory              = {};
  for (const e of expenses) { const c = e.category || "Uncategorised"; byCategory[c] = (byCategory[c] || 0) + (e.amount || 0); }
  const totalExpenses    = expenses.reduce((s, e) => s + (e.amount || 0), 0);
  const drawingsData     = await buildDrawingsSection({ businessId: biz._id, branchId, start, end });
  const operatingProfit  = grossRevenue - totalExpenses;
  const netProfit        = operatingProfit - drawingsData.totalDrawings;
  const cashOut          = totalExpenses + drawingsData.totalDrawings + drawingsData.totalOtherPayouts;
  const closingBalance   = openingBalance + grossRevenue - cashOut;
  const staffActivity    = await buildStaffActivityTable({ invoices, receipts, expenses, payments });
  const handoverData     = await buildHandoverLog({ businessId: biz._id, branchId, start, end });
  return {
    revenue:  { invoicePaymentsReceived, cashSales, grossRevenue },
    expenses: { byCategory, totalExpenses, list: expenses },
    drawings: drawingsData,
    profit:   { grossProfit: grossRevenue, operatingProfit, netProfit },
    cashPosition: { openingBalance, cashIn: grossRevenue, cashOut, closingBalance },
    invoiceSummary: {
      totalInvoiced:    invoices.reduce((s, i) => s + (i.total   || 0), 0),
      totalOutstanding: invoices.reduce((s, i) => s + (i.balance || 0), 0),
      count: invoices.length, payments: payments.length, receipts: receipts.length
    },
    staffActivity,
    handoverLog: handoverData.handovers,
    rawData: data
  };
}


// ═══════════════════════════════════════════════════════════════
// 13. DETAILED LEDGER  ← the main new function
// ═══════════════════════════════════════════════════════════════
/**
 * Builds a chronological list of every transaction as a row
 * in a running-balance ledger, like a bank statement.
 *
 * Row shape:
 *   { at, type, typeLabel, description, recorder, role,
 *     debit, credit, balance, ref, isHandover, flag }
 *
 * Types: INVOICE_PMT | CASH_SALE | EXPENSE | DRAWING | PAYOUT | HANDOVER
 *
 * Every row carries the running balance.
 * Handover rows do NOT change the balance but mark custody transfers.
 */
export async function buildLedger({ biz, data, branchId, start, end, openingBalance = 0 }) {
  const { invoices, receipts, payments, expenses } = data;
  const cur = biz.currency || "USD";

  clearStaffCache();
  const rows = [];

  // ── Invoice payments (money IN) ─────────────────────────────────────────────
  for (const pay of payments) {
    // Find the linked invoice for its number and client name
    const inv = invoices.find(i => i._id?.toString() === pay.invoiceId?.toString());
    let description = inv ? `Inv ${inv.number}` : "Invoice payment";
    if (inv?.clientId) {
      try {
        const c = await Client.findById(inv.clientId).lean();
        if (c) description = `${description} - ${c.name || c.phone}`;
      } catch (_) {}
    }
    const { name, role } = await resolveStaff(pay.createdBy || null);
    rows.push({
      at: new Date(pay.createdAt),
      type: "INVOICE_PMT", typeLabel: "Invoice Payment",
      description,
      recorder: name, role,
      credit: pay.amount || 0, debit: 0,
      ref: inv?.number || pay._id?.toString()?.slice(-6),
      isHandover: false, flag: null
    });
  }

  // ── Cash sales / receipts (money IN, line by line) ──────────────────────────
  for (const rec of receipts) {
    const items = (rec.items || []).slice(0, 3).map(it => it.item || it.name || "Item").join(", ");
    const description = items || `Receipt ${rec.number || ""}`;
    const { name, role } = await resolveStaff(rec.createdBy || rec.recordedBy || null);
    rows.push({
      at: new Date(rec.createdAt),
      type: "CASH_SALE", typeLabel: "Cash Sale",
      description: `${rec.number ? rec.number + " - " : ""}${description}`,
      recorder: name, role,
      credit: rec.total || 0, debit: 0,
      ref: rec.number,
      isHandover: false, flag: null
    });
  }

  // ── Expenses (money OUT, specific name) ─────────────────────────────────────
  for (const exp of expenses) {
    // Use the actual description/notes as the item name - "Fuel 40L diesel" not "Transport"
    const description = exp.description || exp.notes || exp.category || "Expense";
    const { name, role } = await resolveStaff(exp.createdBy || exp.recordedBy || null);
    rows.push({
      at: new Date(exp.createdAt),
      type: "EXPENSE", typeLabel: `Expense - ${exp.category || ""}`,
      description,
      recorder: name, role,
      credit: 0, debit: exp.amount || 0,
      ref: exp._id?.toString()?.slice(-6),
      isHandover: false, flag: null
    });
  }

  // ── Drawings + other payouts (money OUT) ────────────────────────────────────
  let CashPayout;
  try { CashPayout = (await import("../models/cashPayout.js")).default; } catch (_) {}
  if (CashPayout) {
    const q = { businessId: biz._id, createdAt: { $gte: start, $lte: end } };
    if (branchId) q.branchId = branchId;
    const payouts = await CashPayout.find(q).lean();
    const RE = /draw|owner|personal|private|director/i;
    for (const p of payouts) {
      const { name, role } = await resolveStaff(p.createdBy || null);
      const isDrawing = RE.test(p.reason || "");
      rows.push({
        at: new Date(p.createdAt),
        type: isDrawing ? "DRAWING" : "PAYOUT",
        typeLabel: isDrawing ? "Owner Drawing" : "Cash Payout",
        description: p.reason || (isDrawing ? "Owner drawing" : "Payout"),
        recorder: name, role,
        credit: 0, debit: p.amount || 0,
        ref: p._id?.toString()?.slice(-6),
        isHandover: false, flag: null
      });
    }
  }

  // ── Shift handovers (custody transfers - no monetary change) ────────────────
  let CashHandover;
  try { CashHandover = (await import("../models/cashHandover.js")).default; } catch (_) {}
  if (CashHandover) {
    const q = { businessId: biz._id, handoverAt: { $gte: start, $lte: end } };
    if (branchId) q.branchId = branchId;
    const handovers = await CashHandover.find(q).lean();
    for (const h of handovers) {
      rows.push({
        at: new Date(h.handoverAt),
        type: "HANDOVER", typeLabel: "Shift Handover",
        description: `${h.outgoingName || "Unknown"} → ${h.incomingName || "Unknown"}`,
        recorder: h.outgoingName || "Unknown", role: h.outgoingRole || "clerk",
        credit: 0, debit: 0,
        amountCounted: h.amountCounted || 0,
        notes: h.notes || "",
        isHandover: true, flag: null
      });
    }
  }

  // ── Sort all rows chronologically ───────────────────────────────────────────
  rows.sort((a, b) => a.at - b.at);

  // ── Calculate running balance ────────────────────────────────────────────────
  let balance = openingBalance;
  for (const row of rows) {
    if (!row.isHandover) {
      balance += (row.credit || 0) - (row.debit || 0);
      row.balance = balance;
    } else {
      // For handovers: expected balance is current running balance
      // flag a discrepancy if counted ≠ expected
      row.balance = balance;
      const diff  = (row.amountCounted || 0) - balance;
      if (Math.abs(diff) > 0.01) {
        row.flag = diff > 0
          ? `⚠️ SURPLUS +${fmtMoney(diff, cur)}`
          : `⚠️ SHORT  ${fmtMoney(diff, cur)}`;
      } else {
        row.flag = "✅ BALANCED";
      }
    }
  }

  return {
    rows,
    openingBalance,
    closingBalance: balance,
    currency: cur,
    totalCredits: rows.reduce((s, r) => s + (r.credit || 0), 0),
    totalDebits:  rows.reduce((s, r) => s + (r.debit  || 0), 0)
  };
}


// ═══════════════════════════════════════════════════════════════
// 14. CLERK STATEMENT  ← custody view per staff member
// ═══════════════════════════════════════════════════════════════
/**
 * Builds a full custody statement for one clerk for a date range.
 *
 * Shows:
 *  - What cash they received at the start of their shift (via handover)
 *  - Every transaction they personally recorded
 *  - Running balance of cash in their custody
 *  - Any handovers out (what they passed on and to whom)
 *  - Drawings they processed
 *  - Balance reconciliation
 */
// ─────────────────────────────────────────────────────────────────────────────
// Shared payout DEBIT matcher - which payouts reduce THIS clerk's till.
// Returns a Mongo match fragment so buildClerkStatement (rows) and
// fetchClerkCumulativeBalance (opening) always agree.
//
//   1. fromPhone === clerk                  → explicit cash source (this round)
//   2. no fromPhone, recorder === clerk     → legacy attribution / fallback
//   3. ORPHAN RESCUE: no fromPhone, no createdBy, no recordedBy, AND the
//      payout is at a branch where this clerk is the SOLE clerk → attribute
//      to them. This rescues pre-fix WhatsApp drawings that carry NO
//      attribution at all (createdBy null, recordedBy field absent) - exactly
//      the "$167 owner drawing" case. Guarded to sole-clerk branches so a
//      multi-clerk till never double-counts an orphan.
// ─────────────────────────────────────────────────────────────────────────────
const _normPhone = p => {
  let x = String(p || "").replace(/\D/g, "");
  if (x.startsWith("0")) x = "263" + x.slice(1);
  return x;
};

export async function payoutDebitMatch({ biz, clerkPhone, branchId = null }) {
  const cp = _normPhone(clerkPhone);

  const noTill = { $or: [{ fromPhone: null }, { fromPhone: { $exists: false } }] };
  const noRecorder = { $and: [
    { $or: [{ createdBy: null }, { createdBy: { $exists: false } }] },
    { $or: [{ recordedBy: null }, { recordedBy: { $exists: false } }] }
  ] };

  const clauses = [
    { fromPhone: cp },                                              // explicit till
    { $and: [ noTill, { $or: [{ createdBy: cp }, { recordedBy: cp }] } ] }  // recorder fallback
  ];

  // Orphan rescue - resolve the clerk's OWN branch (independent of who is
  // viewing) and only rescue when they are the sole clerk at that branch.
  try {
    const UserRole = (await import("../models/userRole.js")).default;
    let clerkBranchId = branchId;
    const me = await UserRole.findOne({ businessId: biz._id, phone: cp }).lean();
    if (me && me.branchId) clerkBranchId = me.branchId;

    if (clerkBranchId) {
      const clerks = await UserRole.find({
        businessId: biz._id, branchId: clerkBranchId,
        pending: false, suspended: { $ne: true },
        role: { $in: ["clerk", "manager"] }
      }).select("phone").lean();
      const sole = clerks.length === 1 && _normPhone(clerks[0].phone) === cp;
      if (sole) {
        clauses.push({ $and: [ noTill, noRecorder, { branchId: clerkBranchId } ] });
      }
    }
  } catch (_) {}

  return { $or: clauses };
}

export async function buildClerkStatement({ biz, clerkPhone, branchId, start, end, openingCustody: openingCustodyOverride = null }) {
  const cur = biz.currency || "USD";

  // Normalise clerk phone
  let cp = String(clerkPhone).replace(/\D/g, "");
  if (cp.startsWith("0")) cp = "263" + cp.slice(1);

  const { name: clerkName, role: clerkRole } = await resolveStaff(cp);

  // ── All handovers involving this clerk ──────────────────────────────────────
  let CashHandover;
  try { CashHandover = (await import("../models/cashHandover.js")).default; } catch (_) {}

  const handoversIn  = [];
  const handoversOut = [];
  if (CashHandover) {
    const q = { businessId: biz._id, handoverAt: { $gte: start, $lte: end } };
    if (branchId) q.branchId = branchId;
    const all = await CashHandover.find(q).sort({ handoverAt: 1 }).lean();
    for (const h of all) {
      const outN = String(h.outgoingPhone || "").replace(/\D/g, "");
      const inN  = String(h.incomingPhone || "").replace(/\D/g, "");
      if (outN === cp) handoversOut.push(h);
      if (inN  === cp) handoversIn.push(h);
    }
  }

  // ── Opening custody ────────────────────────────────────────────────────────
  // Use the cumulative carry-forward if provided (computed from all history
  // before `start`). This is always accurate - never relies on manual entry.
  // Fall back to handover-in amount only if no override given.
  let openingCustody = openingCustodyOverride !== null ? openingCustodyOverride : 0;
  let openingSource  = openingCustodyOverride !== null ? "Carried forward from previous period" : "Opening Balance";
  if (openingCustodyOverride === null && handoversIn.length > 0) {
    openingCustody = handoversIn[0].amountCounted || 0;
    openingSource  = `Received from ${handoversIn[0].outgoingName || "Unknown"} at ${new Date(handoversIn[0].handoverAt).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}`;
  }

  // ── All transactions recorded by this clerk ─────────────────────────────────
  const Invoice        = (await import("../models/invoice.js")).default;
  const InvoicePayment = (await import("../models/invoicePayment.js")).default;
  const Expense        = (await import("../models/expense.js")).default;

  const baseQ = { businessId: biz._id, createdAt: { $gte: start, $lte: end }, createdBy: cp };
  const bQ    = branchId ? { ...baseQ, branchId } : baseQ;

  const [invoices, receipts, payments, expenses] = await Promise.all([
    Invoice.find({ ...bQ, type: "invoice" }).lean(),
    Invoice.find({ ...bQ, type: "receipt" }).lean(),
    InvoicePayment.find(bQ).lean(),
    Expense.find(bQ).lean()
  ]);

  // ── Payouts recorded by this clerk (money OUT of their custody) ────────────
  // Matches createdBy OR recordedBy: the WhatsApp payout flow historically
  // wrote `recordedBy` which the old CashPayout schema silently discarded
  // (createdBy stayed null) - THE reason payouts never showed on clerk
  // statements. The schema now persists both fields and the flow writes both,
  // so the $or catches every record however it was attributed.
  //
  // ── Payouts RECEIVED by this clerk (money INTO their custody) ──────────────
  // Directed payouts (paidToPhone = this clerk) appear as credits on the
  // receiver's statement and increase their running balance - this is how a
  // clerk (or the OWNER) is held accountable for money handed to them via a
  // payout, symmetrical to how the payer's side shows the debit.
  let CashPayout;
  let payouts = [];
  let payoutsReceived = [];
  try {
    CashPayout = (await import("../models/cashPayout.js")).default;
    const noWhoQ = { businessId: biz._id, createdAt: { $gte: start, $lte: end }, ...(branchId ? { branchId } : {}) };
    // ── Payouts that DEBIT this clerk's till ────────────────────────────────
    // Explicit cash source (fromPhone), legacy recorder fallback, OR an
    // orphan rescue for pre-fix drawings with no attribution at all - see
    // payoutDebitMatch. This is what finally reduces the clerk's balance for
    // the "$167 owner drawing" (createdBy null, recordedBy absent).
    const debitsThisClerk = await payoutDebitMatch({ biz, clerkPhone: cp, branchId });
    [payouts, payoutsReceived] = await Promise.all([
      CashPayout.find({ ...noWhoQ, ...debitsThisClerk }).lean(),
      CashPayout.find({ ...noWhoQ, paidToPhone: cp }).lean()
    ]);
    // A payout can never be from-and-to the same person: if the money both
    // left and returned to this clerk's own till, drop the received side.
    payoutsReceived = payoutsReceived.filter(p => {
      const source = p.fromPhone || p.createdBy || p.recordedBy || "";
      return String(source) !== cp;
    });
  } catch (_) {}

  // ── Admin-entered income attributed to this clerk (CashIncome) ─────────────
  // fetchClerkCumulativeBalance already counts CashIncome in the OPENING
  // custody, but the period rows never showed it - so an admin-entered income
  // yesterday moved today's opening while the transaction itself was
  // invisible. Fetching it here closes that gap: every figure in the opening
  // now has a visible row behind it.
  let adminIncome = [];
  try {
    const CashIncome = (await import("../models/cashIncome.js")).default;
    adminIncome = await CashIncome.find({ ...bQ, createdBy: cp }).lean();
  } catch (_) {}

  // ── Recurring billing recorded by this clerk (rent collections + unit
  //    expenses) - the money they collect from tenants is cash in THEIR
  //    custody and must appear on THEIR statement, with the tenant/account
  //    name and that tenant's outstanding balance on the row. Wrapped so a
  //    business that never uses recurring billing is completely unaffected.
  let rbPaymentRows = [], rbExpenseRows = [];
  try {
    const { fetchClerkRecurringRows } = await import("./recurringLedger.js");
    const rb = await fetchClerkRecurringRows({
      businessId: biz._id, clerkPhone: cp, branchId: branchId || null, start, end
    });
    rbPaymentRows = rb.paymentRows;
    rbExpenseRows = rb.expenseRows;
  } catch (_) {}

  // ── Build transaction rows ──────────────────────────────────────────────────
  const txRows = [];

  for (const pay of payments) {
    const inv = invoices.find(i => i._id?.toString() === pay.invoiceId?.toString());
    let desc = inv ? `Inv ${inv.number}` : "Invoice payment";
    if (inv?.clientId) {
      try { const c = await Client.findById(inv.clientId).lean(); if (c) desc += ` - ${c.name || c.phone}`; } catch (_) {}
    }
    txRows.push({ at: new Date(pay.createdAt), typeLabel: "Invoice Payment", description: desc, credit: pay.amount || 0, debit: 0 });
  }

  for (const rec of receipts) {
    const items = (rec.items || []).slice(0, 2).map(it => it.item || it.name || "Item").join(", ");
    txRows.push({ at: new Date(rec.createdAt), typeLabel: "Cash Sale", description: `${rec.number ? rec.number + " - " : ""}${items || "Sale"}`, credit: rec.total || 0, debit: 0 });
  }

  for (const exp of expenses) {
    txRows.push({ at: new Date(exp.createdAt), typeLabel: `Expense`, description: exp.description || exp.notes || exp.category || "Expense", credit: 0, debit: exp.amount || 0 });
  }

  const RE = /draw|owner|personal|private|director/i;
  for (const p of payouts) {
    const isDrawing = RE.test(p.reason || "");
    const toWhom = p.paidToName ? ` → ${p.paidToName}` : "";
    // When this row is on the statement because the payout's till (fromPhone)
    // is this clerk, but SOMEONE ELSE recorded it (e.g. the owner entered a
    // drawing from the clerk's drawer), name the recorder for accountability.
    let byWhom = "";
    if (p.fromPhone && String(p.fromPhone) === cp) {
      const recorder = String(p.createdBy || p.recordedBy || "");
      if (recorder && recorder !== cp) {
        try { const r = await resolveStaff(recorder); byWhom = ` (recorded by ${r.name || recorder})`; } catch (_) {}
      }
    }
    txRows.push({
      at: new Date(p.createdAt),
      typeLabel: isDrawing ? "Owner Drawing" : "Cash Payout",
      description: `${p.reason || (isDrawing ? "Drawing" : "Payout")}${toWhom}${byWhom}${p.reversed ? " (REVERSED)" : ""}`,
      credit: 0, debit: p.amount || 0
    });
  }

  // Payouts received from another staff member (or recorded on their behalf
  // by admin) - money INTO this clerk's custody, so a credit. Reversed
  // payouts already carry amount 0, so both sides self-correct together.
  for (const p of payoutsReceived) {
    let fromName = "Staff";
    try { const r = await resolveStaff(p.fromPhone || p.createdBy || p.recordedBy || null); fromName = r.name || "Staff"; } catch (_) {}
    txRows.push({
      at: new Date(p.createdAt),
      typeLabel: "Payout Received",
      description: `From ${fromName}${p.reason ? " · " + p.reason : ""}${p.reversed ? " (REVERSED)" : ""}`,
      credit: p.amount || 0, debit: 0
    });
  }

  // ── Shift handovers as REAL rows in the running balance ────────────────────
  // Previously handovers were only listed in side tables: a mid-period
  // handover-out never reduced the running balance, yet the NEXT period's
  // cumulative opening DID subtract it - so closing ≠ next opening whenever a
  // handover happened mid-period. Making handovers first-class rows restores
  // the invariant: cash received (handover-in) credits the balance, cash
  // handed away (handover-out) debits it, and the closing figure is genuinely
  // "cash still in this person's hands".
  //
  // Guard 1: when the opening custody FELL BACK to the first handover-in
  // (no cumulative override supplied), that same handover must not also be a
  // credit row - it IS the opening. Skipped by _id.
  // Guard 2: reversed handovers are excluded from the maths (matching
  // fetchClerkCumulativeBalance) but stay visible in the handover tables.
  const openingHandoverId = (openingCustodyOverride === null && handoversIn.length > 0)
    ? String(handoversIn[0]._id) : null;

  for (const h of handoversIn) {
    if (h.reversed) continue;
    if (openingHandoverId && String(h._id) === openingHandoverId) continue;
    txRows.push({
      at: new Date(h.handoverAt),
      typeLabel: "Cash Received",
      description: `Handover from ${h.outgoingName || h.outgoingPhone || "Owner"}${h.notes ? " · " + h.notes : ""}`,
      credit: h.amountCounted || 0, debit: 0
    });
  }

  for (const h of handoversOut) {
    if (h.reversed) continue;
    txRows.push({
      at: new Date(h.handoverAt),
      typeLabel: "Cash Handed Over",
      description: `Handover to ${h.incomingName || h.incomingPhone || "Owner"}${h.notes ? " · " + h.notes : ""}`,
      credit: 0, debit: h.amountCounted || 0,
      _handoverOutId: String(h._id)
    });
  }

  // Admin-entered income (reversed entries already carry amount 0 - shown
  // with a marker so the audit trail stays visible without touching totals)
  for (const inc of adminIncome) {
    txRows.push({
      at: new Date(inc.createdAt),
      typeLabel: "Income",
      description: `${inc.description || inc.category || "Income"}${inc.reversed ? " (REVERSED)" : ""}`,
      credit: inc.amount || 0, debit: 0
    });
  }

  // Recurring billing: rent/fee collections (credit) and unit expenses (debit)
  // recorded by this clerk - rows arrive pre-shaped with tenant + account
  // names and the tenant's outstanding balance in the description.
  for (const row of rbPaymentRows) txRows.push(row);
  for (const row of rbExpenseRows) txRows.push(row);

  txRows.sort((a, b) => a.at - b.at);

  // ── Running balance ─────────────────────────────────────────────────────────
  // For every handover-out row we snapshot the balance the clerk SHOULD have
  // been holding just before the handover - that is the number the counted
  // amount is checked against (per-row surplus/short flags for the PDF).
  let balance = openingCustody;
  const handoverOutMeta = {};   // handoverId → { expectedBefore, diff }
  for (const row of txRows) {
    if (row._handoverOutId) {
      const expectedBefore = balance;
      const diff = (row.debit || 0) - expectedBefore;
      handoverOutMeta[row._handoverOutId] = { expectedBefore, diff };
    }
    balance += (row.credit || 0) - (row.debit || 0);
    row.balance = balance;
  }

  // Attach per-handover expectations to the handover docs (consumed by
  // buildClerkStatementHTML so each handover-out line can show
  // "held X, handed Y" instead of a single end-of-period comparison)
  for (const h of handoversOut) {
    const m = handoverOutMeta[String(h._id)];
    if (m) { h._expectedBefore = m.expectedBefore; h._diff = m.diff; }
  }

  // ── Closing reconciliation ──────────────────────────────────────────────────
  // expectedClosing        = cash still in the clerk's hands NOW (handovers
  //                          already deducted - after a full end-of-shift
  //                          handover this reads 0, which is the honest truth)
  // handedOver             = amount counted at the LAST handover-out
  // expectedAtLastHandover = what they should have been holding at that moment
  // discrepancy            = handedOver − expectedAtLastHandover
  //                          (same meaning as before - "did they hand over as
  //                          much as they should have held" - but now correct
  //                          even with several handovers in one period,
  //                          because earlier ones are already deducted)
  const expectedClosing = balance;
  const liveHandoversOut = handoversOut.filter(h => !h.reversed);
  const lastOut = liveHandoversOut.length > 0 ? liveHandoversOut[liveHandoversOut.length - 1] : null;
  const handedOver             = lastOut ? (lastOut.amountCounted || 0) : null;
  const expectedAtLastHandover = lastOut ? (lastOut._expectedBefore ?? null) : null;
  const discrepancy            = (handedOver !== null && expectedAtLastHandover !== null)
    ? handedOver - expectedAtLastHandover : null;

  return {
    clerkName, clerkPhone: cp, clerkRole,
    openingCustody, openingSource,
    txRows,
    handoversIn, handoversOut,
    expectedClosing,
    expectedAtLastHandover,
    handedOver,
    discrepancy,
    totalIn:   txRows.reduce((s, r) => s + (r.credit || 0), 0),
    totalOut:  txRows.reduce((s, r) => s + (r.debit  || 0), 0),
    currency:  cur
  };
}