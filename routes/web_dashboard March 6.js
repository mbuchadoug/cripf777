import express from "express";
import { requireWebAuth } from "../middleware/webAuth.js";
import Invoice from "../models/invoice.js";
import Expense from "../models/expense.js";
import Client from "../models/client.js";
import Product from "../models/product.js";
import Branch from "../models/branch.js";
import UserRole from "../models/userRole.js";

const router = express.Router();

router.use(requireWebAuth);

/**
 * GET /web/dashboard
 * Main dashboard — owners see all branches + overall, clerks/managers see their branch only
 */
router.get("/dashboard", async (req, res) => {
  try {
    const { businessId, branchId, role } = req.webUser;

    // Build base query
    const query = { businessId };
    if (role !== "owner" && branchId) {
      query.branchId = branchId;
    }

    // Date ranges
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const thisMonth = new Date(today.getFullYear(), today.getMonth(), 1);
    const lastMonth = new Date(today.getFullYear(), today.getMonth() - 1, 1);

    const [
      todayRevenue,
      monthRevenue,
      lastMonthRevenue,
      unpaidInvoices,
      paidInvoices,
      totalClients,
      totalProducts,
      recentInvoices
    ] = await Promise.all([
      Invoice.aggregate([
        { $match: { ...query, createdAt: { $gte: today }, type: "invoice" } },
        { $group: { _id: null, total: { $sum: "$total" } } }
      ]),
      Invoice.aggregate([
        { $match: { ...query, createdAt: { $gte: thisMonth }, type: "invoice" } },
        { $group: { _id: null, total: { $sum: "$total" } } }
      ]),
      Invoice.aggregate([
        { $match: { ...query, createdAt: { $gte: lastMonth, $lt: thisMonth }, type: "invoice" } },
        { $group: { _id: null, total: { $sum: "$total" } } }
      ]),
      Invoice.countDocuments({ ...query, type: "invoice", status: { $in: ["unpaid", "partial"] } }),
      Invoice.countDocuments({ ...query, type: "invoice", status: "paid" }),
      Client.countDocuments({ businessId }),
      Product.countDocuments({
        businessId,
        isActive: true,
        ...(role !== "owner" && branchId ? { branchId } : {})
      }),
      Invoice.find(query)
        .populate("clientId", "name phone")
        .sort({ createdAt: -1 })
        .limit(5)
        .lean()
    ]);

    const currentMonth = monthRevenue[0]?.total || 0;
    const previousMonth = lastMonthRevenue[0]?.total || 0;
    const growth = previousMonth > 0
      ? ((currentMonth - previousMonth) / previousMonth * 100).toFixed(1)
      : 0;

    // ── Branch performance (owners only) ─────────────────────────────────────
    let branchPerformance = [];
    if (role === "owner") {
      const branches = await Branch.find({ businessId }).lean();

      branchPerformance = await Promise.all(
        branches.map(async (branch) => {
          const bQuery = { businessId, branchId: branch._id };

          const [rev, unpaid, expenses, users] = await Promise.all([
            Invoice.aggregate([
              { $match: { ...bQuery, createdAt: { $gte: thisMonth }, type: "invoice" } },
              { $group: { _id: null, total: { $sum: "$total" }, paid: { $sum: "$amountPaid" } } }
            ]),
            Invoice.countDocuments({ ...bQuery, type: "invoice", status: { $in: ["unpaid", "partial"] } }),
            Expense.aggregate([
              { $match: { ...bQuery, createdAt: { $gte: thisMonth } } },
              { $group: { _id: null, total: { $sum: "$amount" } } }
            ]),
            UserRole.countDocuments({ businessId, branchId: branch._id, pending: false })
          ]);

          return {
            _id: branch._id,
            name: branch.name,
            revenue: rev[0]?.total || 0,
            collected: rev[0]?.paid || 0,
            unpaidCount: unpaid,
            expenses: expenses[0]?.total || 0,
            userCount: users
          };
        })
      );
    }

    res.render("web/dashboard", {
      layout: "web",
      title: "Dashboard - ZimQuote",
      user: req.webUser,
       user: req.webUser,
      stats: {
        todayRevenue: todayRevenue[0]?.total || 0,
        monthRevenue: currentMonth,
        growth: parseFloat(growth),
        unpaidInvoices,
        paidInvoices,
        totalClients,
        totalProducts
      },
      recentInvoices: recentInvoices.map(inv => ({
        ...inv,
        clientName: inv.clientId?.name || inv.clientId?.phone || "Unknown"
      })),
      branchPerformance,
      isOwner: role === "owner"
    });

  } catch (error) {
    console.error("Dashboard error:", error);
    res.status(500).render("web/error", {
      layout: "web",
      title: "Error",
      message: "Failed to load dashboard",
      user: req.webUser
    });
  }
});

/**
 * GET /web/api/revenue-chart
 * Revenue chart data (last 30 days)
 */
router.get("/api/revenue-chart", async (req, res) => {
  try {
    const { businessId, branchId, role } = req.webUser;

    const query = { businessId, type: "invoice" };
    if (role !== "owner" && branchId) {
      query.branchId = branchId;
    }

    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const data = await Invoice.aggregate([
      { $match: { ...query, createdAt: { $gte: thirtyDaysAgo } } },
      {
        $group: {
          _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } },
          revenue: { $sum: "$total" },
          count: { $sum: 1 }
        }
      },
      { $sort: { _id: 1 } }
    ]);

    res.json(data.map(d => ({ date: d._id, revenue: d.revenue, count: d.count })));

  } catch (error) {
    console.error("Revenue chart error:", error);
    res.status(500).json({ error: "Failed to load chart data" });
  }
});

/**
 * GET /web/api/branch-chart
 * Branch comparison chart data for current month (owners only)
 */
router.get("/api/branch-chart", async (req, res) => {
  try {
    const { businessId, role } = req.webUser;

    if (role !== "owner") {
      return res.status(403).json({ error: "Owners only" });
    }

    const thisMonth = new Date();
    thisMonth.setDate(1);
    thisMonth.setHours(0, 0, 0, 0);

    const data = await Invoice.aggregate([
      {
        $match: {
          businessId,
          type: "invoice",
          createdAt: { $gte: thisMonth }
        }
      },
      {
        $group: {
          _id: "$branchId",
          revenue: { $sum: "$total" },
          count: { $sum: 1 }
        }
      }
    ]);

    // Populate branch names
    const Branch = (await import("../models/branch.js")).default;
    const branches = await Branch.find({ businessId }).lean();

    const result = data.map(d => {
      const branch = branches.find(b => b._id.toString() === d._id?.toString());
      return {
        branch: branch?.name || "Unknown",
        revenue: d.revenue,
        count: d.count
      };
    });

    res.json(result);

  } catch (error) {
    console.error("Branch chart error:", error);
    res.status(500).json({ error: "Failed to load branch chart data" });
  }
});

/**
 * POST /web/users/invite
 * Quick invite from dashboard modal (mirrors chatbot invite_user_phone flow)
 */
router.post("/users/invite", async (req, res) => {
  try {
    const { businessId, role } = req.webUser;
    if (role !== "owner") return res.status(403).json({ error: "Owners only" });

    const UserRole = (await import("../models/userRole.js")).default;
    let { phone, role: inviteRole, branchId } = req.body;

    // Normalize phone — mirrors chatbot invite_user_phone state
    const raw = (phone || "").replace(/\D+/g, "");
    let p = raw;
    if (p.startsWith("0")) p = "263" + p.slice(1);
    if (!p.startsWith("263") || p.length !== 12)
      return res.status(400).json({ error: "Invalid WhatsApp number. Use 0772123456 or +263772123456" });

    if (!["clerk", "manager"].includes(inviteRole))
      return res.status(400).json({ error: "Invalid role" });

    const exists = await UserRole.findOne({ businessId, phone: p, pending: false });
    if (exists) return res.status(409).json({ error: "User already exists in this business" });

    await UserRole.findOneAndUpdate(
      { businessId, phone: p },
      { businessId, phone: p, role: inviteRole, branchId: branchId || undefined, pending: true },
      { upsert: true }
    );

    res.json({ ok: true });
  } catch (err) {
    console.error("Invite error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

export default router;