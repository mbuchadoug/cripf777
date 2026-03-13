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
function calcGrowth(curr, prev) {
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

    const effectiveBranchId =
      role !== "owner" && branchId ? String(branchId) :
      branchFilter || null;

    const baseQ = { businessId };
    if (effectiveBranchId) baseQ.branchId = effectiveBranchId;

    const dr     = { $gte: start,     $lte: end };
    const prevDr = { $gte: prevStart, $lte: prevEnd };

    // ═════════════════════════════════════════════════════════════════════════
    // ACCOUNTING MODEL (mirrors chatbot engine):
    //
    //   Invoice (type="invoice") → billed to client; collected via InvoicePayment
    //   Invoice (type="receipt") → DIRECT CASH SALE; instantly fully paid
    //     • balance=0, status="paid", amountPaid=total always
    //     • Income received IN FULL on createdAt date
    //     • No InvoicePayment record - the receipt IS the payment
    //
    //   invoiced       = sum invoice.total      (what was billed)
    //   paymentCash    = sum InvoicePayment.amount  (cash collected on invoices)
    //   receiptCash    = sum receipt.total      (direct cash sales - 100% instant income)
    //   cashReceived   = paymentCash + receiptCash
    //   spent          = sum Expense.amount
    //   netProfit      = cashReceived - spent
    //   outstanding    = sum invoice.balance where balance > 0
    //
    //   collectionRate = paymentCash / invoiced
    //     ↑ Receipts excluded: not billed-then-collected, so irrelevant to invoice collection %
    //   profitMargin   = netProfit / cashReceived
    // ═════════════════════════════════════════════════════════════════════════

    const [
      invoices,
      receipts,       // direct cash sales - income received in full on creation
      payments,
      expenses,
      prevInvoices,
      prevReceipts,
      prevPayments,
      prevExpenses,
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

    // ── Core metrics ──────────────────────────────────────────────────────────
    const invoiced    = fmt(invoices.reduce((s, i) => s + (i.total  || 0), 0));
    const paymentCash = fmt(payments.reduce((s, p) => s + (p.amount || 0), 0));
    const receiptCash = fmt(receipts.reduce((s, r) => s + (r.total  || 0), 0));  // instant income
    const cashReceived = fmt(paymentCash + receiptCash);
    const spent       = fmt(expenses.reduce((s, e) => s + (e.amount || 0), 0));
    const outstanding = fmt(invoices.filter(i => (i.balance || 0) > 0).reduce((s, i) => s + (i.balance || 0), 0));
    const netProfit   = fmt(cashReceived - spent);
    const totalRevenue = fmt(invoiced + receiptCash);   // total business revenue

    // Collection rate = invoice payments only / invoiced
    // (receipts are NOT "collected" - they are direct instant sales)
    const collectionRate = pct(paymentCash, invoiced);
    const profitMargin   = pct(netProfit, cashReceived);
    const avgSale        = invoices.length > 0 ? fmt(invoiced / invoices.length) : 0;

    // ── Previous period ────────────────────────────────────────────────────────
    const prevInvoiced     = fmt(prevInvoices.reduce((s, i) => s + (i.total  || 0), 0));
    const prevPaymentCash  = fmt(prevPayments.reduce((s, p) => s + (p.amount || 0), 0));
    const prevReceiptCash  = fmt(prevReceipts.reduce((s, r) => s + (r.total  || 0), 0));
    const prevCashReceived = fmt(prevPaymentCash + prevReceiptCash);
    const prevSpent        = fmt(prevExpenses.reduce((s, e) => s + (e.amount || 0), 0));
    const prevNetProfit    = fmt(prevCashReceived - prevSpent);

    // ── Invoice status breakdown ───────────────────────────────────────────────
    // Only type=invoice docs have a meaningful unpaid/partial/paid status
    // Receipts are always "paid" (direct sales) and are shown separately
    const statusMap = {
      paid:    { count: 0, total: 0, amountPaid: 0, balance: 0 },
      partial: { count: 0, total: 0, amountPaid: 0, balance: 0 },
      unpaid:  { count: 0, total: 0, amountPaid: 0, balance: 0 }
    };
    invoices.forEach(inv => {
      const k = inv.status === "paid" ? "paid" : inv.status === "partial" ? "partial" : "unpaid";
      statusMap[k].count++;
      statusMap[k].total     += inv.total      || 0;
      statusMap[k].amountPaid += inv.amountPaid || 0;
      statusMap[k].balance   += inv.balance    || 0;
    });
    const salesData = Object.entries(statusMap)
      .filter(([, d]) => d.count > 0)
      .map(([id, d]) => ({
        _id:    id,
        count:  d.count,
        total:  fmt(d.total),
        paid:   fmt(d.amountPaid),
        balance: fmt(d.balance)
      }));

    // ── Expense breakdown by category ──────────────────────────────────────────
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

    // ── Payment method breakdown ───────────────────────────────────────────────
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

    // ── Top products/services ──────────────────────────────────────────────────
    // Include items from BOTH invoices AND receipts - both generate revenue
    const prodMap = {};
    [...invoices, ...receipts].forEach(doc => {
      (doc.items || []).forEach(item => {
        const name = item.item || item.description || "Unknown";
        if (!prodMap[name]) prodMap[name] = { qty: 0, revenue: 0 };
        prodMap[name].qty     += item.qty   || 0;
        prodMap[name].revenue += item.total || 0;
      });
    });
    const topProducts = Object.entries(prodMap)
      .map(([name, d]) => ({ name, qty: d.qty, revenue: fmt(d.revenue) }))
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 10);

    // ── Top customers ──────────────────────────────────────────────────────────
    // Include spend from BOTH invoices AND receipts
    const custSpend = {};
    [...invoices, ...receipts].forEach(doc => {
      if (!doc.clientId) return;
      const id = String(doc.clientId);
      custSpend[id] = (custSpend[id] || 0) + (doc.total || 0);
    });
    const topClientIds = Object.entries(custSpend).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([id]) => id);
    const topClientDocs = topClientIds.length ? await Client.find({ _id: { $in: topClientIds } }).lean() : [];
    const clientNameMap = Object.fromEntries(topClientDocs.map(c => [String(c._id), c.name || c.phone || "Unknown"]));
    const topCustomers = Object.entries(custSpend)
      .sort((a, b) => b[1] - a[1]).slice(0, 5)
      .map(([id, amount]) => ({ name: clientNameMap[id] || "Unknown", amount: fmt(amount) }));

    // ── Best / worst day ───────────────────────────────────────────────────────
    // Revenue from BOTH invoices AND receipts per day
    const dailyMap = {};
    [...invoices, ...receipts].forEach(doc => {
      const day = new Date(doc.createdAt).toISOString().slice(0, 10);
      dailyMap[day] = (dailyMap[day] || 0) + (doc.total || 0);
    });
    const sortedDays = Object.entries(dailyMap).sort((a, b) => b[1] - a[1]);
    const bestDay  = sortedDays.length ? { date: sortedDays[0][0], amount: fmt(sortedDays[0][1]) } : null;
    const worstDay = sortedDays.length ? { date: sortedDays[sortedDays.length - 1][0], amount: fmt(sortedDays[sortedDays.length - 1][1]) } : null;

    // ── Overdue analysis ───────────────────────────────────────────────────────
    // Only invoices can be overdue - receipts are always instantly paid
    const termsDays = req.webUser.paymentTermsDays || 30;
    const nowMs     = Date.now();
    const overdueList = [];
    const currentList = [];
    invoices.filter(i => (i.balance || 0) > 0).forEach(inv => {
      const ageDays = Math.round((nowMs - new Date(inv.createdAt).getTime()) / 86400000);
      (ageDays > termsDays ? overdueList : currentList).push({
        number: inv.number, balance: fmt(inv.balance), ageDays
      });
    });
    overdueList.sort((a, b) => b.balance - a.balance);
    currentList.sort((a, b) => b.balance - a.balance);
    const totalOverdue = fmt(overdueList.reduce((s, i) => s + i.balance, 0));

    // ── Top 5 largest invoices ─────────────────────────────────────────────────
    const topInvoices = [...invoices]
      .sort((a, b) => b.total - a.total).slice(0, 5)
      .map(i => ({ number: i.number, total: fmt(i.total), status: i.status }));

    // ── Activity log - BOTH invoices AND receipts ──────────────────────────────
    // Receipts are income records - must appear in activity log
    const recentDocs = await Invoice.find({ ...baseQ, type: { $in: ["invoice", "receipt"] }, createdAt: dr })
      .populate("clientId", "name phone")
      .sort({ createdAt: -1 })
      .limit(50)
      .lean();

    const branchMap = Object.fromEntries(allBranches.map(b => [String(b._id), b.name]));
    const activityLog = recentDocs.map(doc => ({
      _id:        doc._id,
      number:     doc.number,
      type:       doc.type,             // "invoice" or "receipt"
      total:      fmt(doc.total),
      balance:    fmt(doc.balance),
      status:     doc.status,
      clientName: doc.clientId?.name || doc.clientId?.phone || "-",
      branchName: branchMap[String(doc.branchId)] || "-",
      createdAt:  doc.createdAt
    }));

    // ── Branch breakdown (owner only) ──────────────────────────────────────────
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
        // Receipts per branch: direct cash sales - add full amount to collected
        Invoice.aggregate([
          { $match: { businessId, type: "receipt", createdAt: dr } },
          { $group: { _id: { $ifNull: ["$branchId", "NONE"] }, rcptCash: { $sum: "$total" }, rcptCount: { $sum: 1 } } }
        ]),
        Expense.aggregate([
          { $match: { businessId, createdAt: dr } },
          { $group: { _id: { $ifNull: ["$branchId", "NONE"] }, spent: { $sum: "$amount" } } }
        ])
      ]);

      const rows = new Map();
      const ensure = id => {
        const k = String(id);
        if (!rows.has(k)) rows.set(k, {
          branchName: k === "NONE" ? "Unassigned" : (branchMap[k] || "Unknown"),
          revenue: 0, invPayCash: 0, rcptCash: 0, rcptCount: 0, spent: 0, outstanding: 0, count: 0
        });
        return rows.get(k);
      };
      invAgg.forEach(r  => { const row = ensure(r._id); row.revenue = r.revenue; row.outstanding = r.outstanding; row.count = r.count; });
      payAgg.forEach(r  => { ensure(r._id).invPayCash = r.cashIn; });
      rcptAgg.forEach(r => { const row = ensure(r._id); row.rcptCash = r.rcptCash; row.rcptCount = r.rcptCount; });
      expAgg.forEach(r  => { ensure(r._id).spent = r.spent; });

      branchBreakdown = [...rows.values()].map(r => {
        const collected = fmt(r.invPayCash + r.rcptCash);
        return {
          branchName:  r.branchName,
          revenue:     fmt(r.revenue),
          collected,                       // invoice payments + direct sales
          rcptCash:    fmt(r.rcptCash),    // direct sales portion
          rcptCount:   r.rcptCount,
          spent:       fmt(r.spent),
          outstanding: fmt(r.outstanding),
          profit:      fmt(collected - r.spent),
          count:       r.count            // invoice count
        };
      });
    }

    // ── Revenue chart data (last 30 days) ──────────────────────────────────────
    const now = new Date();
    const chartDays = [];
    for (let i = 29; i >= 0; i--) {
      const d = new Date(now); d.setDate(d.getDate() - i);
      chartDays.push(d.toISOString().slice(0, 10));
    }
    const chartRevenue = chartDays.map(day => ({ day, amount: fmt(dailyMap[day] || 0) }));

    res.render("web/reports/sales", {
      layout:  "web",
      title:   "Reports - ZimQuote",
      pageKey: "reports",
      user:    req.webUser,
      isOwner: role === "owner",
      filters: {
        period,
        startDate:    startDate    || "",
        endDate:      endDate      || "",
        branchFilter: effectiveBranchId || ""
      },
      branches: allBranches,

      summary: {
        invoiced,         // billed via invoices
        receiptCash,      // direct cash sales (receipts - instant income)
        totalRevenue,     // invoiced + receiptCash
        paymentCash,      // cash collected on invoices
        cashReceived,     // paymentCash + receiptCash (total money in)
        spent,
        outstanding,
        netProfit,
        collectionRate,   // paymentCash / invoiced (receipts NOT included in rate)
        profitMargin,
        avgSale,
        invoiceCount: invoices.length,
        receiptCount: receipts.length,
        paymentCount: payments.length,
        expenseCount: expenses.length
      },

      prev: {
        invoiced:     prevInvoiced,
        cashReceived: prevCashReceived,
        receiptCash:  prevReceiptCash,
        spent:        prevSpent,
        netProfit:    prevNetProfit
      },

      growth: {
        revenue:  calcGrowth(invoiced,     prevInvoiced),
        cash:     calcGrowth(cashReceived, prevCashReceived),
        expenses: calcGrowth(spent,        prevSpent),
        profit:   calcGrowth(netProfit,    prevNetProfit)
      },

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
      layout:  "web",
      title:   "Error",
      message: "Failed to load reports",
      user:    req.webUser
    });
  }
});

// ─── GET /web/reports/export ─────────────────────────────────────────────────
router.get("/reports/export", async (req, res) => {
  try {
    const { businessId, role } = req.webUser;
    const branchId = req.webUser.branchId;
    const { period = "month", startDate, endDate, branchFilter } = req.query;

    const { start, end } = buildDateRange(period, startDate, endDate);
    const effectiveBranchId = role !== "owner" && branchId ? String(branchId) : branchFilter || null;
    const baseQ = { businessId, ...(effectiveBranchId ? { branchId: effectiveBranchId } : {}) };
    const dr    = { $gte: start, $lte: end };

    const [docs, branches] = await Promise.all([
      Invoice.find({ ...baseQ, type: { $in: ["invoice", "receipt"] }, createdAt: dr })
        .populate("clientId", "name phone").lean(),
      Branch.find({ businessId }).lean()
    ]);

    const branchMap = Object.fromEntries(branches.map(b => [String(b._id), b.name]));

    const rows = docs.map(doc => ({
      number:     doc.number,
      type:       doc.type,
      date:       new Date(doc.createdAt).toISOString().slice(0, 10),
      client:     doc.clientId?.name || doc.clientId?.phone || "Unknown",
      branch:     branchMap[String(doc.branchId)] || "-",
      total:      doc.total,
      amountPaid: doc.amountPaid,
      balance:    doc.balance,
      status:     doc.status
    }));

    res.json({ rows });
  } catch (err) {
    res.status(500).json({ error: "Export failed" });
  }
});

export default router;