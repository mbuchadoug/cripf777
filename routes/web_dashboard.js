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

    const now        = new Date();
    const today      = new Date(now); today.setHours(0, 0, 0, 0);
    const thisMonth  = new Date(now.getFullYear(), now.getMonth(), 1);
    const lastMonth  = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const lastMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0); lastMonthEnd.setHours(23, 59, 59, 999);

    // ── Base query with branch scope ──────────────────────────────────────────
    const baseQ = { businessId };
    if (role !== "owner" && branchId) baseQ.branchId = branchId;

    // ── Parallel fetch everything needed ─────────────────────────────────────
    const [
      // Today
      todayPayments, todayReceipts,
      // This month
      monthInvoices, monthPayments, monthReceipts, monthExpenses,
      // Last month (for growth)
      lastMonthPayments, lastMonthReceipts,
      // Counts
      unpaidCount, totalClients, totalProducts,
      // Last 30 days revenue chart
      chartInvoices,
      // Branch performance (owner only)
      allBranches
    ] = await Promise.all([
      // Today cash collected
      InvoicePayment.aggregate([
        { $match: { ...baseQ, createdAt: { $gte: today } } },
        { $group: { _id: null, total: { $sum: "$amount" } } }
      ]),
      Invoice.aggregate([
        { $match: { ...baseQ, type: "receipt", createdAt: { $gte: today } } },
        { $group: { _id: null, total: { $sum: "$total" } } }
      ]),

      // This month invoices
      Invoice.find({ ...baseQ, type: "invoice", createdAt: { $gte: thisMonth } }).lean(),
      // This month payments
      InvoicePayment.aggregate([
        { $match: { ...baseQ, createdAt: { $gte: thisMonth } } },
        { $group: { _id: null, total: { $sum: "$amount" } } }
      ]),
      // This month receipts
      Invoice.aggregate([
        { $match: { ...baseQ, type: "receipt", createdAt: { $gte: thisMonth } } },
        { $group: { _id: null, total: { $sum: "$total" } } }
      ]),
      // This month expenses
      Expense.aggregate([
        { $match: { ...baseQ, createdAt: { $gte: thisMonth } } },
        { $group: { _id: null, total: { $sum: "$amount" } } }
      ]),
      // Last month payments
      InvoicePayment.aggregate([
        { $match: { ...baseQ, createdAt: { $gte: lastMonth, $lte: lastMonthEnd } } },
        { $group: { _id: null, total: { $sum: "$amount" } } }
      ]),
      // Last month receipts
      Invoice.aggregate([
        { $match: { ...baseQ, type: "receipt", createdAt: { $gte: lastMonth, $lte: lastMonthEnd } } },
        { $group: { _id: null, total: { $sum: "$total" } } }
      ]),

      // Unpaid invoice count
      Invoice.countDocuments({ ...baseQ, type: "invoice", status: { $in: ["unpaid", "partial"] } }),
      // Total clients
      Client.countDocuments({ businessId }),
      // Total products/services (unique item names)
      Invoice.distinct("items.item", { businessId }),

      // Last 30 days chart data
      Invoice.find({ ...baseQ, type: "invoice", createdAt: { $gte: new Date(now.getTime() - 30 * 86400000) } }).lean(),

      // Branches for owner
      role === "owner" ? Branch.find({ businessId }).lean() : Promise.resolve([])
    ]);

    // ── Compute KPI values ────────────────────────────────────────────────────
    const todayCash      = (todayPayments[0]?.total || 0) + (todayReceipts[0]?.total || 0);
    const monthInvoiced  = monthInvoices.reduce((s, i) => s + (i.total || 0), 0);
    const monthPayCash   = monthPayments[0]?.total || 0;
    const monthRcptCash  = monthReceipts[0]?.total || 0;
    const monthCollected = monthPayCash + monthRcptCash;
    const monthSpent     = monthExpenses[0]?.total || 0;
    const monthProfit    = monthCollected - monthSpent;
    const outstanding    = monthInvoices.reduce((s, i) => s + (i.balance || 0), 0);

    const lastMonthCash  = (lastMonthPayments[0]?.total || 0) + (lastMonthReceipts[0]?.total || 0);
    const revenueGrowth  = lastMonthCash > 0
      ? ((monthCollected - lastMonthCash) / lastMonthCash * 100).toFixed(1)
      : (monthCollected > 0 ? "100.0" : "0.0");

    const collectionRate = monthInvoiced > 0
      ? Math.round((monthCollected / monthInvoiced) * 100)
      : 0;

    // ── Revenue chart (last 30 days, by day) ──────────────────────────────────
    const dayMap = {};
    chartInvoices.forEach(inv => {
      const day = new Date(inv.createdAt).toISOString().slice(0, 10);
      dayMap[day] = (dayMap[day] || 0) + (inv.total || 0);
    });
    const chartDays = [];
    for (let i = 29; i >= 0; i--) {
      const d = new Date(now); d.setDate(d.getDate() - i);
      const key = d.toISOString().slice(0, 10);
      chartDays.push({ day: key, label: d.toLocaleDateString("en-US", { month: "short", day: "numeric" }), amount: Math.round((dayMap[key] || 0) * 100) / 100 });
    }

    // ── Branch performance (owner only) ───────────────────────────────────────
    let branchPerformance = [];
    if (role === "owner" && allBranches.length > 0) {
      const branchMap = Object.fromEntries(allBranches.map(b => [String(b._id), b.name]));

      const [bInvAgg, bPayAgg, bRcptAgg, bExpAgg, bUserCounts] = await Promise.all([
        Invoice.aggregate([
          { $match: { businessId, type: "invoice", createdAt: { $gte: thisMonth } } },
          { $group: { _id: { $ifNull: ["$branchId", "NONE"] }, revenue: { $sum: "$total" }, outstanding: { $sum: "$balance" }, unpaid: { $sum: { $cond: [{ $in: ["$status", ["unpaid", "partial"]] }, 1, 0] } } } }
        ]),
        InvoicePayment.aggregate([
          { $match: { businessId, createdAt: { $gte: thisMonth } } },
          { $group: { _id: { $ifNull: ["$branchId", "NONE"] }, cashIn: { $sum: "$amount" } } }
        ]),
        Invoice.aggregate([
          { $match: { businessId, type: "receipt", createdAt: { $gte: thisMonth } } },
          { $group: { _id: { $ifNull: ["$branchId", "NONE"] }, rcptCash: { $sum: "$total" } } }
        ]),
        Expense.aggregate([
          { $match: { businessId, createdAt: { $gte: thisMonth } } },
          { $group: { _id: { $ifNull: ["$branchId", "NONE"] }, spent: { $sum: "$amount" } } }
        ]),
        // We import UserRole lazily to avoid circular dep issues
        Promise.resolve([])
      ]);

      const rows = new Map();
      const ensure = id => {
        const k = String(id);
        if (!rows.has(k)) rows.set(k, { name: k === "NONE" ? "Unassigned" : (branchMap[k] || "Unknown"), revenue: 0, collected: 0, spent: 0, outstanding: 0, unpaid: 0 });
        return rows.get(k);
      };
      bInvAgg.forEach(r  => { const row = ensure(r._id); row.revenue = Math.round(r.revenue * 100) / 100; row.outstanding = Math.round(r.outstanding * 100) / 100; row.unpaid = r.unpaid; });
      bPayAgg.forEach(r  => { ensure(r._id).collected += r.cashIn; });
      bRcptAgg.forEach(r => { ensure(r._id).collected += r.rcptCash; });
      bExpAgg.forEach(r  => { ensure(r._id).spent = Math.round(r.spent * 100) / 100; });

      branchPerformance = [...rows.values()].map(r => ({
        ...r,
        collected: Math.round(r.collected * 100) / 100,
        profit:    Math.round((r.collected - r.spent) * 100) / 100
      })).sort((a, b) => b.collected - a.collected);
    }

    // ── Recent activity (last 10 invoices) ────────────────────────────────────
    const recentInvoices = await Invoice.find({ ...baseQ, type: "invoice" })
      .populate("clientId", "name phone")
      .sort({ createdAt: -1 })
      .limit(10)
      .lean();

    const bMap = Object.fromEntries(allBranches.map(b => [String(b._id), b.name]));

    res.render("web/dashboard", {
      layout: "web",
      title: "Dashboard — ZimQuote",
      pageKey: "dashboard",
      user: req.webUser,
      isOwner: role === "owner",

      stats: {
        todayRevenue:    Math.round(todayCash * 100) / 100,
        monthRevenue:    Math.round(monthInvoiced * 100) / 100,
        monthCollected:  Math.round(monthCollected * 100) / 100,
        monthProfit:     Math.round(monthProfit * 100) / 100,
        monthSpent:      Math.round(monthSpent * 100) / 100,
        outstanding:     Math.round(outstanding * 100) / 100,
        revenueGrowth:   parseFloat(revenueGrowth),
        collectionRate,
        unpaidCount,
        totalClients,
        totalProducts:   totalProducts.length
      },

      chartData: JSON.stringify(chartDays),
      branchPerformance,
      recentInvoices: recentInvoices.map(inv => ({
        ...inv,
        clientName: inv.clientId?.name || inv.clientId?.phone || "Unknown",
        branchName: bMap[String(inv.branchId)] || "—"
      }))
    });

  } catch (err) {
    console.error("Dashboard error:", err);
    res.status(500).render("web/error", {
      layout: "web",
      title: "Error",
      message: "Failed to load dashboard",
      user: req.webUser
    });
  }
});

export default router;