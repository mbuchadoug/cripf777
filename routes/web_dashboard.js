import express from "express";
import { requireWebAuth } from "../middleware/webAuth.js";
import Invoice from "../models/invoice.js";
import Expense from "../models/expense.js";
import InvoicePayment from "../models/invoicePayment.js";
import Branch from "../models/branch.js";
import Client from "../models/client.js";

const router = express.Router();
router.use(requireWebAuth);

// ─── GET /web/dashboard ───────────────────────────────────────────────────────
router.get("/dashboard", async (req, res) => {
  try {
    const { businessId, role } = req.webUser;
    const branchId = req.webUser.branchId;

    const now          = new Date();
    const today        = new Date(now); today.setHours(0, 0, 0, 0);
    const thisMonth    = new Date(now.getFullYear(), now.getMonth(), 1);
    const lastMonth    = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const lastMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0);
    lastMonthEnd.setHours(23, 59, 59, 999);
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 86400000);

    // ── Branch scope ──────────────────────────────────────────────────────────
    const baseQ = { businessId };
    if (role !== "owner" && branchId) baseQ.branchId = branchId;

    // ═══════════════════════════════════════════════════════════════════════════
    // ACCOUNTING MODEL:
    //
    //   Invoice (type="invoice") → a bill to a client; may be unpaid/partial/paid
    //     Cash collected against it = InvoicePayment records
    //
    //   Invoice (type="receipt") → a DIRECT CASH SALE; instantly 100% paid
    //     amountPaid = total, balance = 0, status = "paid" always
    //     Counts as cash income IN FULL on creation date — no InvoicePayment needed
    //
    //   cashReceived  = InvoicePayment.sum  +  Receipt.total.sum
    //   invoiced      = Invoice(type=invoice).total.sum   (what was billed)
    //   collectionRate = InvoicePayment.sum / invoiced
    //     ↑ Receipts excluded: they are NOT billed-then-collected, they are instant sales
    // ═══════════════════════════════════════════════════════════════════════════

    const [
      // Today
      todayInvPay,      // payments received on invoices today
      todayReceipts,    // direct cash sales today (type=receipt, always paid)

      // This month
      monthInvoices,    // invoice docs for outstanding balance calc
      monthInvPay,      // payments received on invoices this month
      monthRcptAgg,     // direct cash sales this month (type=receipt)
      monthExpenses,

      // Last month (for growth)
      lastMonthInvPay,
      lastMonthRcptAgg,

      // Counts
      unpaidCount,
      totalClients,

      // Chart — last 30 days: invoices for billed, receipts for direct cash
      chartInvoices,
      chartReceipts,

      // Branches
      allBranches
    ] = await Promise.all([

      // ── Today ──────────────────────────────────────────────────────────────
      InvoicePayment.aggregate([
        { $match: { ...baseQ, createdAt: { $gte: today } } },
        { $group: { _id: null, total: { $sum: "$amount" } } }
      ]),
      Invoice.aggregate([
        // receipts = direct cash sales, fully paid on creation
        { $match: { ...baseQ, type: "receipt", createdAt: { $gte: today } } },
        { $group: { _id: null, total: { $sum: "$total" } } }
      ]),

      // ── This month ─────────────────────────────────────────────────────────
      Invoice.find({ ...baseQ, type: "invoice", createdAt: { $gte: thisMonth } }).lean(),
      InvoicePayment.aggregate([
        { $match: { ...baseQ, createdAt: { $gte: thisMonth } } },
        { $group: { _id: null, total: { $sum: "$amount" } } }
      ]),
      Invoice.aggregate([
        { $match: { ...baseQ, type: "receipt", createdAt: { $gte: thisMonth } } },
        { $group: { _id: null, total: { $sum: "$total" }, count: { $sum: 1 } } }
      ]),
      Expense.aggregate([
        { $match: { ...baseQ, createdAt: { $gte: thisMonth } } },
        { $group: { _id: null, total: { $sum: "$amount" } } }
      ]),

      // ── Last month ─────────────────────────────────────────────────────────
      InvoicePayment.aggregate([
        { $match: { ...baseQ, createdAt: { $gte: lastMonth, $lte: lastMonthEnd } } },
        { $group: { _id: null, total: { $sum: "$amount" } } }
      ]),
      Invoice.aggregate([
        { $match: { ...baseQ, type: "receipt", createdAt: { $gte: lastMonth, $lte: lastMonthEnd } } },
        { $group: { _id: null, total: { $sum: "$total" } } }
      ]),

      // ── Counts ─────────────────────────────────────────────────────────────
      Invoice.countDocuments({ ...baseQ, type: "invoice", status: { $in: ["unpaid", "partial"] } }),
      Client.countDocuments({ businessId }),

      // ── Chart: last 30 days — invoices billed + receipt cash sales ─────────
      Invoice.find({ ...baseQ, type: "invoice", createdAt: { $gte: thirtyDaysAgo } }).lean(),
      Invoice.find({ ...baseQ, type: "receipt", createdAt: { $gte: thirtyDaysAgo } }).lean(),

      // ── Branches ───────────────────────────────────────────────────────────
      role === "owner" ? Branch.find({ businessId }).lean() : Promise.resolve([])
    ]);

    // ── Derive KPI values ─────────────────────────────────────────────────────
    const todayCash     = (todayInvPay[0]?.total || 0) + (todayReceipts[0]?.total || 0);

    const monthInvoiced = monthInvoices.reduce((s, i) => s + (i.total || 0), 0);
    const monthPayCash  = monthInvPay[0]?.total   || 0;  // collected on invoices
    const monthRcptCash = monthRcptAgg[0]?.total  || 0;  // direct cash sales
    const monthRcptCount = monthRcptAgg[0]?.count || 0;
    const cashReceived  = monthPayCash + monthRcptCash;  // total cash in
    const monthSpent    = monthExpenses[0]?.total  || 0;
    const netProfit     = cashReceived - monthSpent;
    const outstanding   = monthInvoices.reduce((s, i) => s + (i.balance || 0), 0);

    const lastMonthCash = (lastMonthInvPay[0]?.total || 0) + (lastMonthRcptAgg[0]?.total || 0);
    const cashGrowth    = lastMonthCash > 0
      ? ((cashReceived - lastMonthCash) / lastMonthCash * 100).toFixed(1)
      : cashReceived > 0 ? "100.0" : "0.0";

    // Collection rate = invoice payments ONLY / invoiced
    // Receipts are NOT "collected against an invoice" — they are direct sales
    const collectionRate = monthInvoiced > 0
      ? Math.round((monthPayCash / monthInvoiced) * 100)
      : 0;

    // ── Revenue chart (last 30 days) ──────────────────────────────────────────
    // Both invoices (billed) AND receipts (direct cash) shown as total revenue
    const dayMap = {};
    [...chartInvoices, ...chartReceipts].forEach(doc => {
      const day = new Date(doc.createdAt).toISOString().slice(0, 10);
      dayMap[day] = (dayMap[day] || 0) + (doc.total || 0);
    });
    const chartDays = [];
    for (let i = 29; i >= 0; i--) {
      const d = new Date(now); d.setDate(d.getDate() - i);
      const key = d.toISOString().slice(0, 10);
      chartDays.push({
        day:    key,
        label:  d.toLocaleDateString("en-US", { month: "short", day: "numeric" }),
        amount: Math.round((dayMap[key] || 0) * 100) / 100
      });
    }

    // ── Branch performance (owner only) ───────────────────────────────────────
    let branchPerformance = [];
    if (role === "owner" && allBranches.length > 0) {
      const branchMap = Object.fromEntries(allBranches.map(b => [String(b._id), b.name]));

      const [bInvAgg, bPayAgg, bRcptAgg, bExpAgg] = await Promise.all([
        Invoice.aggregate([
          { $match: { businessId, type: "invoice", createdAt: { $gte: thisMonth } } },
          {
            $group: {
              _id:         { $ifNull: ["$branchId", "NONE"] },
              revenue:     { $sum: "$total" },
              outstanding: { $sum: "$balance" },
              unpaid:      { $sum: { $cond: [{ $in: ["$status", ["unpaid", "partial"]] }, 1, 0] } }
            }
          }
        ]),
        InvoicePayment.aggregate([
          { $match: { businessId, createdAt: { $gte: thisMonth } } },
          { $group: { _id: { $ifNull: ["$branchId", "NONE"] }, cashIn: { $sum: "$amount" } } }
        ]),
        // Receipts per branch — direct cash sales, fully paid, add to collected
        Invoice.aggregate([
          { $match: { businessId, type: "receipt", createdAt: { $gte: thisMonth } } },
          { $group: { _id: { $ifNull: ["$branchId", "NONE"] }, rcptCash: { $sum: "$total" } } }
        ]),
        Expense.aggregate([
          { $match: { businessId, createdAt: { $gte: thisMonth } } },
          { $group: { _id: { $ifNull: ["$branchId", "NONE"] }, spent: { $sum: "$amount" } } }
        ])
      ]);

      const rows = new Map();
      const ensure = id => {
        const k = String(id);
        if (!rows.has(k)) rows.set(k, {
          name: k === "NONE" ? "Unassigned" : (branchMap[k] || "Unknown"),
          revenue: 0, invPayCash: 0, rcptCash: 0, spent: 0, outstanding: 0, unpaid: 0
        });
        return rows.get(k);
      };
      bInvAgg.forEach(r  => { const row = ensure(r._id); row.revenue = r.revenue; row.outstanding = r.outstanding; row.unpaid = r.unpaid; });
      bPayAgg.forEach(r  => { ensure(r._id).invPayCash = r.cashIn; });
      bRcptAgg.forEach(r => { ensure(r._id).rcptCash   = r.rcptCash; });
      bExpAgg.forEach(r  => { ensure(r._id).spent      = r.spent; });

      branchPerformance = [...rows.values()].map(r => {
        const collected = Math.round((r.invPayCash + r.rcptCash) * 100) / 100;
        return {
          name:        r.name,
          revenue:     Math.round(r.revenue     * 100) / 100,
          collected,                                                            // invoice payments + direct sales
          rcptCash:    Math.round(r.rcptCash    * 100) / 100,
          spent:       Math.round(r.spent       * 100) / 100,
          outstanding: Math.round(r.outstanding * 100) / 100,
          unpaid:      r.unpaid,
          profit:      Math.round((collected - r.spent) * 100) / 100
        };
      }).sort((a, b) => b.collected - a.collected);
    }

    // ── Recent activity — BOTH invoices AND receipts ──────────────────────────
    // Receipts are income records and must appear in the activity feed
    const recentDocs = await Invoice.find({ ...baseQ, type: { $in: ["invoice", "receipt"] } })
      .populate("clientId", "name phone")
      .sort({ createdAt: -1 })
      .limit(10)
      .lean();

    const bMap = Object.fromEntries(allBranches.map(b => [String(b._id), b.name]));

    res.render("web/dashboard", {
      layout:  "web",
      title:   "Dashboard — ZimQuote",
      pageKey: "dashboard",
      user:    req.webUser,
      isOwner: role === "owner",

      stats: {
        todayRevenue:   Math.round(todayCash      * 100) / 100,  // cash today
        cashReceived:   Math.round(cashReceived   * 100) / 100,  // total cash in this month
        monthInvPayCash:Math.round(monthPayCash   * 100) / 100,  // from invoice payments
        monthRcptCash:  Math.round(monthRcptCash  * 100) / 100,  // from direct sales
        monthRcptCount,
        netProfit:      Math.round(netProfit      * 100) / 100,
        monthSpent:     Math.round(monthSpent     * 100) / 100,
        outstanding:    Math.round(outstanding    * 100) / 100,
        monthInvoiced:  Math.round(monthInvoiced  * 100) / 100,  // billed via invoices
        unpaidCount,
        cashGrowth:     parseFloat(cashGrowth),
        collectionRate,                                           // invoice payments / invoiced
        totalClients
      },

      chartData:        JSON.stringify(chartDays),
      branchPerformance,
      recentDocs: recentDocs.map(doc => ({
        _id:        doc._id,
        number:     doc.number,
        type:       doc.type,                                     // "invoice" or "receipt"
        total:      Math.round((doc.total   || 0) * 100) / 100,
        balance:    Math.round((doc.balance || 0) * 100) / 100,
        status:     doc.status,
        clientName: doc.clientId?.name || doc.clientId?.phone || "—",
        branchName: bMap[String(doc.branchId)] || "—",
        createdAt:  doc.createdAt
      }))
    });

  } catch (err) {
    console.error("Dashboard error:", err);
    res.status(500).render("web/error", {
      layout:  "web",
      title:   "Error",
      message: "Failed to load dashboard",
      user:    req.webUser
    });
  }
});

export default router;