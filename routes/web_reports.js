import express from "express";
import { requireWebAuth } from "../middleware/webAuth.js";
import Invoice from "../models/invoice.js";
import Expense from "../models/expense.js";
import InvoicePayment from "../models/invoicePayment.js";
import Branch from "../models/branch.js";
import Client from "../models/client.js";

const router = express.Router();
router.use(requireWebAuth);

// ─── helpers ──────────────────────────────────────────────────────────────────

function buildDateRange(period, startDate, endDate) {
  const now = new Date();
  let start, end, prevStart, prevEnd;

  if (startDate && endDate) {
    start = new Date(startDate); start.setHours(0, 0, 0, 0);
    end   = new Date(endDate);   end.setHours(23, 59, 59, 999);
    const span = end - start;
    prevEnd   = new Date(start.getTime() - 1);
    prevStart = new Date(prevEnd.getTime() - span);
  } else {
    switch (period) {
      case "today":
        start = new Date(now); start.setHours(0, 0, 0, 0);
        end   = new Date(now); end.setHours(23, 59, 59, 999);
        prevStart = new Date(start); prevStart.setDate(prevStart.getDate() - 1);
        prevEnd   = new Date(end);   prevEnd.setDate(prevEnd.getDate() - 1);
        break;
      case "week":
        end   = new Date(now); end.setHours(23, 59, 59, 999);
        start = new Date(end); start.setDate(start.getDate() - 6); start.setHours(0, 0, 0, 0);
        prevEnd   = new Date(start.getTime() - 1);
        prevStart = new Date(prevEnd); prevStart.setDate(prevStart.getDate() - 6); prevStart.setHours(0, 0, 0, 0);
        break;
      case "lastmonth":
        start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
        end   = new Date(now.getFullYear(), now.getMonth(), 0); end.setHours(23, 59, 59, 999);
        prevStart = new Date(now.getFullYear(), now.getMonth() - 2, 1);
        prevEnd   = new Date(start.getTime() - 1);
        break;
      case "year":
        start = new Date(now.getFullYear(), 0, 1);
        end   = new Date(now); end.setHours(23, 59, 59, 999);
        prevStart = new Date(now.getFullYear() - 1, 0, 1);
        prevEnd   = new Date(now.getFullYear() - 1, 11, 31); prevEnd.setHours(23, 59, 59, 999);
        break;
      case "month":
      default:
        start = new Date(now.getFullYear(), now.getMonth(), 1);
        end   = new Date(now); end.setHours(23, 59, 59, 999);
        prevStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
        prevEnd   = new Date(start.getTime() - 1);
        break;
    }
  }
  return { start, end, prevStart, prevEnd };
}

function fmt(n) { return Math.round((n || 0) * 100) / 100; }
function pct(a, b) { return b > 0 ? Math.round((a / b) * 100) : 0; }
function growth(curr, prev) {
  if (prev === 0) return curr > 0 ? 100 : 0;
  return Math.round(((curr - prev) / prev) * 100);
}

// ─── GET /web/reports ─────────────────────────────────────────────────────────
router.get("/reports", async (req, res) => {
  try {
    const { businessId, role } = req.webUser;
    const branchId = req.webUser.branchId;
    const { period = "month", startDate, endDate, branchFilter } = req.query;

    const { start, end, prevStart, prevEnd } = buildDateRange(period, startDate, endDate);

    // ── Effective branch scope (mirrors chatbot role guard) ───────────────────
    const effectiveBranchId =
      role !== "owner" && branchId ? String(branchId) :
      branchFilter || null;

    const baseQ = { businessId };
    if (effectiveBranchId) baseQ.branchId = effectiveBranchId;

    const dr     = { $gte: start,     $lte: end };
    const prevDr = { $gte: prevStart, $lte: prevEnd };

    // ── Parallel fetch (current + previous period + meta) ────────────────────
    const [
      invoices, receipts, payments, expenses,
      prevInvoices, prevReceipts, prevPayments, prevExpenses,
      allBranches
    ] = await Promise.all([
      Invoice.find({ ...baseQ, type: "invoice", createdAt: dr }).lean(),
      Invoice.find({ ...baseQ, type: "receipt", createdAt: dr }).lean(),
      InvoicePayment.find({ ...baseQ, createdAt: dr }).lean(),
      Expense.find({ ...baseQ, createdAt: dr }).lean(),
      Invoice.find({ ...baseQ, type: "invoice", createdAt: prevDr }).lean(),
      Invoice.find({ ...baseQ, type: "receipt", createdAt: prevDr }).lean(),
      InvoicePayment.find({ ...baseQ, createdAt: prevDr }).lean(),
      Expense.find({ ...baseQ, createdAt: prevDr }).lean(),
      role === "owner" ? Branch.find({ businessId }).lean() : Promise.resolve([])
    ]);

    // ── Core metrics (mirrors dailyReportEnhanced calculations) ──────────────
    const invoiced     = fmt(invoices.reduce((s, i) => s + (i.total || 0), 0));
    const paymentCash  = fmt(payments.reduce((s, p) => s + (p.amount || 0), 0));
    const receiptCash  = fmt(receipts.reduce((s, r) => s + (r.total || 0), 0));
    const cashReceived = fmt(paymentCash + receiptCash);
    const spent        = fmt(expenses.reduce((s, e) => s + (e.amount || 0), 0));
    const outstanding  = fmt(invoices.reduce((s, i) => s + (i.balance || 0), 0));
    const netProfit    = fmt(cashReceived - spent);
    const collectionRate = pct(cashReceived, invoiced);
    const profitMargin   = pct(netProfit, cashReceived);
    const avgSale        = invoices.length > 0 ? fmt(invoiced / invoices.length) : 0;

    // ── Previous period metrics ───────────────────────────────────────────────
    const prevInvoiced     = fmt(prevInvoices.reduce((s, i) => s + (i.total || 0), 0));
    const prevPaymentCash  = fmt(prevPayments.reduce((s, p) => s + (p.amount || 0), 0));
    const prevReceiptCash  = fmt(prevReceipts.reduce((s, r) => s + (r.total || 0), 0));
    const prevCashReceived = fmt(prevPaymentCash + prevReceiptCash);
    const prevSpent        = fmt(prevExpenses.reduce((s, e) => s + (e.amount || 0), 0));
    const prevNetProfit    = fmt(prevCashReceived - prevSpent);

    // ── Payment status breakdown (mirrors buildPaymentStatus) ────────────────
    const statusMap = { paid: { count: 0, amount: 0 }, partial: { count: 0, amount: 0 }, unpaid: { count: 0, amount: 0 } };
    invoices.forEach(inv => {
      const k = inv.status === "paid" ? "paid" : inv.status === "partial" ? "partial" : "unpaid";
      statusMap[k].count++;
      statusMap[k].amount += inv.total || 0;
    });
    const salesData = Object.entries(statusMap)
      .map(([id, d]) => ({ _id: id, count: d.count, total: fmt(d.amount) }))
      .filter(s => s.count > 0);

    // ── Expense breakdown by category (with %) ────────────────────────────────
    const expCat = {};
    expenses.forEach(e => {
      const c = e.category || "Other";
      if (!expCat[c]) expCat[c] = { count: 0, total: 0 };
      expCat[c].count++;
      expCat[c].total += e.amount || 0;
    });
    const expenseData = Object.entries(expCat)
      .map(([id, d]) => ({ _id: id, count: d.count, total: fmt(d.total), percentage: pct(d.total, spent) }))
      .sort((a, b) => b.total - a.total);

    // ── Payment method breakdown ──────────────────────────────────────────────
    const payMeth = {};
    payments.forEach(p => {
      const m = p.method || "Unknown";
      if (!payMeth[m]) payMeth[m] = { count: 0, total: 0 };
      payMeth[m].count++;
      payMeth[m].total += p.amount || 0;
    });
    const paymentData = Object.entries(payMeth)
      .map(([id, d]) => ({ _id: id, count: d.count, total: fmt(d.total) }))
      .sort((a, b) => b.total - a.total);

    // ── Top products/services (mirrors buildProductSummary) ───────────────────
    const prodMap = {};
    [...invoices, ...receipts].forEach(doc => {
      (doc.items || []).forEach(item => {
        const name = item.item || item.description || "Unknown";
        if (!prodMap[name]) prodMap[name] = { qty: 0, revenue: 0 };
        prodMap[name].qty     += item.qty || 0;
        prodMap[name].revenue += item.total || 0;
      });
    });
    const topProducts = Object.entries(prodMap)
      .map(([name, d]) => ({ name, qty: d.qty, revenue: fmt(d.revenue) }))
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 10);

    // ── Top customers (mirrors monthly report topCustomers) ───────────────────
    const custSpend = {};
    [...invoices, ...receipts].forEach(doc => {
      if (!doc.clientId) return;
      const id = String(doc.clientId);
      custSpend[id] = (custSpend[id] || 0) + (doc.total || 0);
    });
    const topClientIds = Object.entries(custSpend)
      .sort((a, b) => b[1] - a[1]).slice(0, 5).map(([id]) => id);
    const topClientDocs = topClientIds.length
      ? await Client.find({ _id: { $in: topClientIds } }).lean()
      : [];
    const clientNameMap = Object.fromEntries(topClientDocs.map(c => [String(c._id), c.name || c.phone || "Unknown"]));
    const topCustomers = Object.entries(custSpend)
      .sort((a, b) => b[1] - a[1]).slice(0, 5)
      .map(([id, amount]) => ({ name: clientNameMap[id] || "Unknown", amount: fmt(amount) }));

    // ── Best / worst performing day (mirrors monthly report) ─────────────────
    const dailyMap = {};
    [...invoices, ...receipts].forEach(doc => {
      const day = new Date(doc.createdAt).toISOString().slice(0, 10);
      dailyMap[day] = (dailyMap[day] || 0) + (doc.total || 0);
    });
    const sortedDays = Object.entries(dailyMap).sort((a, b) => b[1] - a[1]);
    const bestDay  = sortedDays.length ? { date: sortedDays[0][0],  amount: fmt(sortedDays[0][1]) }  : null;
    const worstDay = sortedDays.length ? { date: sortedDays[sortedDays.length - 1][0], amount: fmt(sortedDays[sortedDays.length - 1][1]) } : null;

    // ── Overdue analysis (mirrors buildOverdueAnalysis) ───────────────────────
    const termsDays = req.webUser.paymentTermsDays || 30;
    const now = new Date();
    const overdueList = [];
    const currentList = [];
    invoices.filter(i => (i.balance || 0) > 0).forEach(inv => {
      const ageDays = Math.round((now - new Date(inv.createdAt)) / 86400000);
      const entry = { number: inv.number, balance: fmt(inv.balance), ageDays };
      ageDays > termsDays ? overdueList.push(entry) : currentList.push(entry);
    });
    overdueList.sort((a, b) => b.balance - a.balance);
    currentList.sort((a, b) => b.balance - a.balance);
    const totalOverdue = fmt(overdueList.reduce((s, i) => s + i.balance, 0));

    // ── Top 5 largest invoices ────────────────────────────────────────────────
    const topInvoices = [...invoices]
      .sort((a, b) => b.total - a.total).slice(0, 5)
      .map(i => ({ number: i.number, total: fmt(i.total), status: i.status }));

    // ── Activity log (last 50, with client + branch names) ───────────────────
    const recentInvoices = await Invoice.find({ ...baseQ, type: "invoice", createdAt: dr })
      .populate("clientId", "name phone")
      .sort({ createdAt: -1 })
      .limit(50)
      .lean();

    const branchMap = Object.fromEntries(allBranches.map(b => [String(b._id), b.name]));
    const activityLog = recentInvoices.map(inv => ({
      number:     inv.number,
      total:      fmt(inv.total),
      balance:    fmt(inv.balance),
      status:     inv.status,
      clientName: inv.clientId?.name || inv.clientId?.phone || "—",
      branchName: branchMap[String(inv.branchId)] || "—",
      createdAt:  inv.createdAt
    }));

    // ── Branch breakdown (owner only — mirrors chatbot invAgg/payAgg/expAgg) ──
    let branchBreakdown = [];
    if (role === "owner" && !effectiveBranchId) {
      const [invAgg, payAgg, rcptAgg, expAgg] = await Promise.all([
        Invoice.aggregate([
          { $match: { businessId, type: "invoice", createdAt: dr } },
          { $group: { _id: { $ifNull: ["$branchId", "NONE"] }, revenue: { $sum: "$total" }, outstanding: { $sum: "$balance" }, count: { $sum: 1 } } }
        ]),
        InvoicePayment.aggregate([
          { $match: { businessId, createdAt: dr } },
          { $group: { _id: { $ifNull: ["$branchId", "NONE"] }, cashIn: { $sum: "$amount" } } }
        ]),
        Invoice.aggregate([
          { $match: { businessId, type: "receipt", createdAt: dr } },
          { $group: { _id: { $ifNull: ["$branchId", "NONE"] }, rcptCash: { $sum: "$total" } } }
        ]),
        Expense.aggregate([
          { $match: { businessId, createdAt: dr } },
          { $group: { _id: { $ifNull: ["$branchId", "NONE"] }, spent: { $sum: "$amount" } } }
        ])
      ]);

      const rows = new Map();
      const ensure = id => {
        const k = String(id);
        if (!rows.has(k)) rows.set(k, { branchName: k === "NONE" ? "Unassigned" : (branchMap[k] || "Unknown"), revenue: 0, collected: 0, spent: 0, outstanding: 0, count: 0 });
        return rows.get(k);
      };
      invAgg.forEach(r  => { const row = ensure(r._id); row.revenue = fmt(r.revenue); row.outstanding = fmt(r.outstanding); row.count = r.count; });
      payAgg.forEach(r  => { ensure(r._id).collected += r.cashIn; });
      rcptAgg.forEach(r => { ensure(r._id).collected += r.rcptCash; });
      expAgg.forEach(r  => { ensure(r._id).spent = fmt(r.spent); });
      branchBreakdown = [...rows.values()].map(r => ({ ...r, collected: fmt(r.collected), profit: fmt(r.collected - r.spent) }));
    }

    // ── Revenue chart data (last 30 days for chart) ───────────────────────────
    const chartDays = [];
    for (let i = 29; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      chartDays.push(d.toISOString().slice(0, 10));
    }
    const chartRevenue = chartDays.map(day => ({ day, amount: fmt(dailyMap[day] || 0) }));

    res.render("web/reports/sales", {
      layout: "web",
      title: "Reports — ZimQuote",
      pageKey: "reports",
      user: req.webUser,
      isOwner: role === "owner",
      filters: {
        period,
        startDate: startDate || "",
        endDate: endDate || "",
        branchFilter: effectiveBranchId || ""
      },
      branches: allBranches,

      // ── Summary block ──────────────────────────────────────────────────────
      summary: {
        invoiced,
        paymentCash,
        receiptCash,
        cashReceived,
        spent,
        outstanding,
        netProfit,
        collectionRate,
        profitMargin,
        avgSale,
        invoiceCount:  invoices.length,
        receiptCount:  receipts.length,
        paymentCount:  payments.length,
        expenseCount:  expenses.length
      },

      // ── Previous period ────────────────────────────────────────────────────
      prev: {
        invoiced:     prevInvoiced,
        cashReceived: prevCashReceived,
        spent:        prevSpent,
        netProfit:    prevNetProfit
      },

      // ── Growth rates ───────────────────────────────────────────────────────
      growth: {
        revenue:  growth(invoiced,     prevInvoiced),
        cash:     growth(cashReceived, prevCashReceived),
        expenses: growth(spent,        prevSpent),
        profit:   growth(netProfit,    prevNetProfit)
      },

      // ── Breakdowns ────────────────────────────────────────────────────────
      salesData,
      paymentData,
      expenseData,
      topProducts,
      topCustomers,
      bestDay,
      worstDay,
      overdueList,
      currentList,
      totalOverdue,
      termsDays,
      topInvoices,
      branchBreakdown,
      activityLog,
      chartRevenue: JSON.stringify(chartRevenue)
    });

  } catch (err) {
    console.error("Reports error:", err);
    res.status(500).render("web/error", {
      layout: "web",
      title: "Error",
      message: "Failed to load reports",
      user: req.webUser
    });
  }
});

export default router;