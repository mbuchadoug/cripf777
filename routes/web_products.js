import express from "express";
import { requireWebAuth } from "../middleware/webAuth.js";
import Invoice from "../models/invoice.js";
import Expense from "../models/expense.js";
import InvoicePayment from "../models/invoicePayment.js";
import Branch from "../models/branch.js";

const router = express.Router();

router.use(requireWebAuth);

/**
 * Helper: build date range from period or custom dates
 */
function getDateRange(period, startDate, endDate) {
  const now = new Date();
  now.setHours(23, 59, 59, 999);

  if (startDate && endDate) {
    return {
      $gte: new Date(startDate),
      $lte: new Date(endDate)
    };
  }

  switch (period) {
    case "today": {
      const start = new Date();
      start.setHours(0, 0, 0, 0);
      return { $gte: start, $lte: now };
    }
    case "week": {
      const start = new Date();
      start.setDate(start.getDate() - 7);
      start.setHours(0, 0, 0, 0);
      return { $gte: start, $lte: now };
    }
    case "month": {
      const start = new Date(now.getFullYear(), now.getMonth(), 1);
      return { $gte: start, $lte: now };
    }
    case "lastmonth": {
      const start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const end = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59);
      return { $gte: start, $lte: end };
    }
    case "year": {
      const start = new Date(now.getFullYear(), 0, 1);
      return { $gte: start, $lte: now };
    }
    default: {
      // Default: current month
      const start = new Date(now.getFullYear(), now.getMonth(), 1);
      return { $gte: start, $lte: now };
    }
  }
}

/**
 * GET /web/reports
 * Sales reports with period/date filtering, branch filtering, activity log
 */
router.get("/reports", async (req, res) => {
  try {
    const { businessId, branchId, role } = req.webUser;
    const {
      period = "month",
      startDate,
      endDate,
      branchFilter
    } = req.query;

    const dateRange = getDateRange(period, startDate, endDate);

    // Build base query
    const query = { businessId, createdAt: dateRange };

    if (role !== "owner" && branchId) {
      query.branchId = branchId;
    } else if (role === "owner" && branchFilter) {
      query.branchId = branchFilter;
    }

    const [salesData, expenseData, paymentData, activityLog] = await Promise.all([
      Invoice.aggregate([
        { $match: { ...query, type: "invoice" } },
        {
          $group: {
            _id: "$status",
            count: { $sum: 1 },
            total: { $sum: "$total" },
            paid: { $sum: "$amountPaid" },
            balance: { $sum: "$balance" }
          }
        }
      ]),

      Expense.aggregate([
        { $match: query },
        {
          $group: {
            _id: "$category",
            count: { $sum: 1 },
            total: { $sum: "$amount" }
          }
        },
        { $sort: { total: -1 } }
      ]),

      InvoicePayment.aggregate([
        { $match: query },
        {
          $group: {
            _id: "$method",
            count: { $sum: 1 },
            total: { $sum: "$amount" }
          }
        }
      ]),

      // ✅ Activity log: recent transactions with createdBy
      Invoice.find(query)
        .populate("clientId", "name phone")
        .populate("branchId", "name")
        .sort({ createdAt: -1 })
        .limit(50)
        .lean()
    ]);

    // Branch performance (owner only, no branchFilter set)
    let branchBreakdown = [];
    if (role === "owner" && !branchFilter) {
      const branches = await Branch.find({ businessId }).lean();
      branchBreakdown = await Promise.all(
        branches.map(async (branch) => {
          const bQuery = { businessId, branchId: branch._id, createdAt: dateRange };
          const [rev, exp] = await Promise.all([
            Invoice.aggregate([
              { $match: { ...bQuery, type: "invoice" } },
              { $group: { _id: null, total: { $sum: "$total" }, paid: { $sum: "$amountPaid" } } }
            ]),
            Expense.aggregate([
              { $match: bQuery },
              { $group: { _id: null, total: { $sum: "$amount" } } }
            ])
          ]);
          return {
            name: branch.name,
            revenue: rev[0]?.total || 0,
            collected: rev[0]?.paid || 0,
            expenses: exp[0]?.total || 0,
            profit: (rev[0]?.paid || 0) - (exp[0]?.total || 0)
          };
        })
      );
    }

    // Total revenue summary
    const totalRevenue = salesData.reduce((s, d) => s + d.total, 0);
    const totalCollected = salesData.reduce((s, d) => s + d.paid, 0);
    const totalExpenses = expenseData.reduce((s, d) => s + d.total, 0);
    const netProfit = totalCollected - totalExpenses;

    // Branches list for filter dropdown
    let branches = [];
    if (role === "owner") {
      branches = await Branch.find({ businessId }).lean();
    }

res.render("web/reports/sales", {
  layout: "web",
  pageTitle: "Reports",
  pageKey: "reports",
  user: req.webUser,
  salesData,
  expenseData,
  paymentData,
  branchBreakdown,
  activityLog: activityLog.map(inv => ({
    ...inv,
    clientName: inv.clientId?.name || inv.clientId?.phone || "Unknown",
    branchName: inv.branchId?.name || "—"
  })),
  summary: { totalRevenue, totalCollected, totalExpenses, netProfit },
  filters: { period, startDate, endDate, branchFilter },
  branches,
  isOwner: role === "owner"
});

  } catch (error) {
    console.error("Reports error:", error);
    res.status(500).render("web/error", {
      layout: "web",
      title: "Error",
      message: "Failed to load reports",
      user: req.webUser
    });
  }
});

/**
 * GET /web/reports/export
 * Export report as JSON (CSV generation happens client-side)
 */
router.get("/reports/export", async (req, res) => {
  try {
    const { businessId, branchId, role } = req.webUser;
    const { period = "month", startDate, endDate, branchFilter } = req.query;

    const dateRange = getDateRange(period, startDate, endDate);
    const query = { businessId, createdAt: dateRange };

    if (role !== "owner" && branchId) {
      query.branchId = branchId;
    } else if (role === "owner" && branchFilter) {
      query.branchId = branchFilter;
    }

    const invoices = await Invoice.find({ ...query, type: "invoice" })
      .populate("clientId", "name phone")
      .populate("branchId", "name")
      .lean();

    // Format for CSV
    const rows = invoices.map(inv => ({
      number: inv.number,
      date: new Date(inv.createdAt).toLocaleDateString(),
      client: inv.clientId?.name || inv.clientId?.phone || "Unknown",
      branch: inv.branchId?.name || "—",
      total: inv.total,
      amountPaid: inv.amountPaid,
      balance: inv.balance,
      status: inv.status,
      createdBy: inv.createdBy || "—"
    }));

    res.json({ rows });

  } catch (error) {
    console.error("Export error:", error);
    res.status(500).json({ error: "Failed to export" });
  }
});

export default router;