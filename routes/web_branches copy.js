import express from "express";
import { requireWebAuth } from "../middleware/webAuth.js";
import Branch from "../models/branch.js";
import Invoice from "../models/invoice.js";
import Expense from "../models/expense.js";
import UserRole from "../models/userRole.js";

const router = express.Router();

router.use(requireWebAuth);

function ownerOnly(req, res, next) {
  if (req.webUser.role !== "owner") {
    return res.status(403).render("web/error", {
      layout: "web",
      title: "Access Denied",
      message: "Only business owners can view branch data.",
      user: req.webUser
    });
  }
  next();
}

/**
 * GET /web/branches
 * Overview of all branches with MTD financials
 */
router.get("/branches", ownerOnly, async (req, res) => {
  try {
    const { businessId } = req.webUser;

    const branches = await Branch.find({ businessId }).lean();

    const thisMonth = new Date();
    thisMonth.setDate(1);
    thisMonth.setHours(0, 0, 0, 0);

    const branchData = await Promise.all(
      branches.map(async (branch) => {
        const bq = { businessId, branchId: branch._id };
        const bqMonth = { ...bq, createdAt: { $gte: thisMonth } };

        const [
          invoiceStats,
          expenseStats,
          totalInvoices,
          unpaidCount,
          userCount
        ] = await Promise.all([
          Invoice.aggregate([
            { $match: { ...bqMonth, type: "invoice" } },
            {
              $group: {
                _id: null,
                revenue: { $sum: "$total" },
                collected: { $sum: "$amountPaid" },
                outstanding: { $sum: "$balance" }
              }
            }
          ]),
          Expense.aggregate([
            { $match: bqMonth },
            { $group: { _id: null, total: { $sum: "$amount" } } }
          ]),
          Invoice.countDocuments({ ...bq, type: "invoice" }),
          Invoice.countDocuments({ ...bq, type: "invoice", status: { $in: ["unpaid", "partial"] } }),
          UserRole.countDocuments({ businessId, branchId: branch._id, pending: false })
        ]);

        const rev = invoiceStats[0] || { revenue: 0, collected: 0, outstanding: 0 };
        const exp = expenseStats[0]?.total || 0;

        return {
          _id: branch._id,
          name: branch.name,
          revenue: rev.revenue,
          collected: rev.collected,
          outstanding: rev.outstanding,
          expenses: exp,
          netProfit: rev.collected - exp,
          totalInvoices,
          unpaidCount,
          userCount
        };
      })
    );

    res.render("web/branches/list", {
      layout: "web",
      title: "Branches - ZimQuote",
      user: req.webUser,
      branches: branchData
    });

  } catch (error) {
    console.error("Branches list error:", error);
    res.status(500).render("web/error", {
      layout: "web",
      title: "Error",
      message: "Failed to load branches",
      user: req.webUser
    });
  }
});

/**
 * GET /web/branches/:id
 * Detailed view of a single branch
 */
router.get("/branches/:id", ownerOnly, async (req, res) => {
  try {
    const { businessId } = req.webUser;
    const { period = "month" } = req.query;

    const branch = await Branch.findOne({ _id: req.params.id, businessId }).lean();
    if (!branch) {
      return res.status(404).render("web/error", {
        layout: "web",
        title: "Not Found",
        message: "Branch not found",
        user: req.webUser
      });
    }

    // Date range
    const now = new Date();
    let since = new Date(now.getFullYear(), now.getMonth(), 1); // default: this month
    if (period === "week") { since = new Date(); since.setDate(since.getDate() - 7); }
    if (period === "year") { since = new Date(now.getFullYear(), 0, 1); }

    const bq = { businessId, branchId: branch._id, createdAt: { $gte: since } };

    const [
      invoiceStats,
      expenseStats,
      recentInvoices,
      topClients,
      users,
      expenseBreakdown
    ] = await Promise.all([
      Invoice.aggregate([
        { $match: { ...bq, type: "invoice" } },
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
        { $match: bq },
        { $group: { _id: null, total: { $sum: "$amount" }, count: { $sum: 1 } } }
      ]),
      Invoice.find({ businessId, branchId: branch._id })
        .populate("clientId", "name phone")
        .sort({ createdAt: -1 })
        .limit(10)
        .lean(),
      Invoice.aggregate([
        { $match: { ...bq, type: "invoice" } },
        { $group: { _id: "$clientId", total: { $sum: "$total" }, count: { $sum: 1 } } },
        { $sort: { total: -1 } },
        { $limit: 5 },
        { $lookup: { from: "clients", localField: "_id", foreignField: "_id", as: "client" } }
      ]),
      UserRole.find({ businessId, branchId: branch._id, pending: false }).lean(),
      Expense.aggregate([
        { $match: bq },
        { $group: { _id: "$category", total: { $sum: "$amount" }, count: { $sum: 1 } } },
        { $sort: { total: -1 } }
      ])
    ]);

    const totalRevenue = invoiceStats.reduce((s, d) => s + d.total, 0);
    const totalCollected = invoiceStats.reduce((s, d) => s + d.paid, 0);
    const totalExpenses = expenseStats[0]?.total || 0;

    res.render("web/branches/detail", {
      layout: "web",
      title: `${branch.name} - ZimQuote`,
      user: req.webUser,
      branch,
      period,
      stats: {
        totalRevenue,
        totalCollected,
        totalExpenses,
        netProfit: totalCollected - totalExpenses,
        unpaidCount: invoiceStats.find(d => d._id === "unpaid")?.count || 0
      },
      invoiceStats,
      recentInvoices: recentInvoices.map(i => ({
        ...i,
        clientName: i.clientId?.name || i.clientId?.phone || "Unknown"
      })),
      topClients: topClients.map(t => ({
        name: t.client[0]?.name || t.client[0]?.phone || "Unknown",
        total: t.total,
        count: t.count
      })),
      users,
      expenseBreakdown
    });

  } catch (error) {
    console.error("Branch detail error:", error);
    res.status(500).render("web/error", {
      layout: "web",
      title: "Error",
      message: "Failed to load branch",
      user: req.webUser
    });
  }
});

export default router;