import express from "express";
import { requireWebAuth } from "../middleware/webAuth.js";
import Invoice from "../models/invoice.js";
import Expense from "../models/expense.js";
import Client from "../models/client.js";
import Product from "../models/product.js";

const router = express.Router();

// All routes require authentication
router.use(requireWebAuth);

/**
 * GET /web/dashboard
 * Main dashboard page
 */
router.get("/dashboard", async (req, res) => {
  try {
    const { businessId, branchId, role } = req.webUser;
    
    // Build query based on role
    const query = { businessId };
    if (role !== "owner" && branchId) {
      query.branchId = branchId;
    }
    
    // Date ranges
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    const thisMonth = new Date(today.getFullYear(), today.getMonth(), 1);
    const lastMonth = new Date(today.getFullYear(), today.getMonth() - 1, 1);
    
    // Get statistics
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
      // Today's revenue
      Invoice.aggregate([
        { $match: { ...query, createdAt: { $gte: today }, type: "invoice" } },
        { $group: { _id: null, total: { $sum: "$total" } } }
      ]),
      
      // This month's revenue
      Invoice.aggregate([
        { $match: { ...query, createdAt: { $gte: thisMonth }, type: "invoice" } },
        { $group: { _id: null, total: { $sum: "$total" } } }
      ]),
      
      // Last month's revenue
      Invoice.aggregate([
        { $match: { ...query, createdAt: { $gte: lastMonth, $lt: thisMonth }, type: "invoice" } },
        { $group: { _id: null, total: { $sum: "$total" } } }
      ]),
      
      // Unpaid invoices
      Invoice.countDocuments({ ...query, type: "invoice", status: { $in: ["unpaid", "partial"] } }),
      
      // Paid invoices
      Invoice.countDocuments({ ...query, type: "invoice", status: "paid" }),
      
      // Total clients
      Client.countDocuments({ businessId }),
      
      // Total products
      Product.countDocuments({
        businessId,
        isActive: true,
        ...(role !== "owner" && branchId ? { branchId } : {})
      }),
      
      // Recent invoices
      Invoice.find(query)
        .populate("clientId", "name phone")
        .sort({ createdAt: -1 })
        .limit(5)
        .lean()
    ]);
    
    // Calculate growth
    const currentMonth = monthRevenue[0]?.total || 0;
    const previousMonth = lastMonthRevenue[0]?.total || 0;
    const growth = previousMonth > 0
      ? ((currentMonth - previousMonth) / previousMonth * 100).toFixed(1)
      : 0;
    
    res.render("web/dashboard", {
      layout: "web",
      title: "Dashboard - ZimQuote",
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
      }))
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
    
    // Last 30 days
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    
    const data = await Invoice.aggregate([
      {
        $match: {
          ...query,
          createdAt: { $gte: thirtyDaysAgo }
        }
      },
      {
        $group: {
          _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } },
          revenue: { $sum: "$total" },
          count: { $sum: 1 }
        }
      },
      { $sort: { _id: 1 } }
    ]);
    
    res.json(data.map(d => ({
      date: d._id,
      revenue: d.revenue,
      count: d.count
    })));
    
  } catch (error) {
    console.error("Revenue chart error:", error);
    res.status(500).json({ error: "Failed to load chart data" });
  }
});

export default router;