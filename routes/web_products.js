import express from "express";
import { requireWebAuth } from "../middleware/webAuth.js";
import Invoice from "../models/invoice.js";
import Expense from "../models/expense.js";
import InvoicePayment from "../models/invoicePayment.js";
import Branch from "../models/branch.js";
import Product from "../models/product.js";

const router = express.Router();

router.use(requireWebAuth);

//import Product from "../models/product.js";

// -----------------------------
// PRODUCTS CRUD + LIST
// Mounted under /web in server.js
// So routes must start with /products
// -----------------------------

/**
 * GET /web/products
 * Render products list page + search + pagination
 */
router.get("/products", async (req, res) => {
  try {
    const { businessId, branchId: userBranchId, role } = req.webUser;
    const { search = "", page = 1 } = req.query;

    const limit = 18;
    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const skip = (pageNum - 1) * limit;

    const query = { businessId };

    // ✅ Branch visibility logic:
    // staff: see their branch + global (branchId null)
    // owner: see everything
    if (role !== "owner") {
      query.$or = [{ branchId: userBranchId || null }, { branchId: null }];
    }

    // ✅ Search
    if (search.trim()) {
      const s = search.trim();
      query.$and = query.$and || [];
      query.$and.push({
        $or: [
          { name: { $regex: s, $options: "i" } },
          { description: { $regex: s, $options: "i" } }
        ]
      });
    }

    const [products, total] = await Promise.all([
      Product.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      Product.countDocuments(query)
    ]);

    const totalPages = Math.max(1, Math.ceil(total / limit));

    return res.render("web/products/list", {
      layout: "web",
      pageTitle: "Products",
      pageKey: "products",
      user: req.webUser,
      products,
      isOwner: role === "owner",
      branches: role === "owner" ? await Branch.find({ businessId }).lean() : [],
      search,
      pagination: {
        currentPage: pageNum,
        totalPages,
        hasPrev: pageNum > 1,
        hasNext: pageNum < totalPages
      }
    });
  } catch (err) {
    console.error("Products list error:", err);
    return res.status(500).render("web/error", {
      layout: "web",
      title: "Error",
      message: "Failed to load products",
      user: req.webUser
    });
  }
});

/**
 * POST /web/products/create
 * Body: { name, description, unitPrice }
 */
router.post("/products/create", async (req, res) => {
  try {
    const { businessId, branchId: userBranchId, role } = req.webUser;
    const { name, description = "", unitPrice } = req.body || {};

    if (!name || !String(name).trim()) {
      return res.status(400).json({ error: "Product name is required" });
    }

    const priceNum = Number(unitPrice);
    if (!Number.isFinite(priceNum) || priceNum < 0) {
      return res.status(400).json({ error: "Unit price must be a valid number" });
    }

    // ✅ Branch rules:
    // staff: forced to their branchId
    // owner: allow global product (null) for now (or you can add a UI branch picker later)
    const finalBranchId = role === "owner" ? null : (userBranchId || null);

    const product = await Product.create({
      businessId,
      branchId: finalBranchId,
      name: String(name).trim(),
      description: String(description || "").trim(),
      unitPrice: priceNum,
      isActive: true
    });

    return res.json({ ok: true, product });
  } catch (err) {
    console.error("Create product error:", err);
    return res.status(500).json({ error: "Failed to create product" });
  }
});

/**
 * PUT /web/products/:id
 * Body: { name, description, unitPrice }
 */
router.put("/products/:id", async (req, res) => {
  try {
    const { businessId, branchId: userBranchId, role } = req.webUser;
    const { id } = req.params;
    const { name, description, unitPrice } = req.body || {};

    const existing = await Product.findOne({ _id: id, businessId }).lean();
    if (!existing) return res.status(404).json({ error: "Product not found" });

    // ✅ Staff can only edit:
    // - their branch products
    // - OR global products
    if (role !== "owner") {
      const allowed =
        String(existing.branchId || "") === String(userBranchId || "") ||
        existing.branchId === null;
      if (!allowed) return res.status(403).json({ error: "Not allowed" });
    }

    const updates = {};

    if (name !== undefined) {
      if (!String(name).trim()) return res.status(400).json({ error: "Name required" });
      updates.name = String(name).trim();
    }

    if (description !== undefined) {
      updates.description = String(description || "").trim();
    }

    if (unitPrice !== undefined) {
      const priceNum = Number(unitPrice);
      if (!Number.isFinite(priceNum) || priceNum < 0) {
        return res.status(400).json({ error: "Unit price must be valid" });
      }
      updates.unitPrice = priceNum;
    }

    const updated = await Product.findOneAndUpdate(
      { _id: id, businessId },
      { $set: updates },
      { new: true }
    ).lean();

    return res.json({ ok: true, product: updated });
  } catch (err) {
    console.error("Update product error:", err);
    return res.status(500).json({ error: "Failed to update product" });
  }
});

/**
 * DELETE /web/products/:id
 */
router.delete("/products/:id", async (req, res) => {
  try {
    const { businessId, branchId: userBranchId, role } = req.webUser;
    const { id } = req.params;

    const existing = await Product.findOne({ _id: id, businessId }).lean();
    if (!existing) return res.status(404).json({ error: "Product not found" });

    if (role !== "owner") {
      const allowed =
        String(existing.branchId || "") === String(userBranchId || "") ||
        existing.branchId === null;
      if (!allowed) return res.status(403).json({ error: "Not allowed" });
    }

    await Product.deleteOne({ _id: id, businessId });
    return res.json({ ok: true });
  } catch (err) {
    console.error("Delete product error:", err);
    return res.status(500).json({ error: "Failed to delete product" });
  }
});

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
    branchName: inv.branchId?.name || "-"
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
      branch: inv.branchId?.name || "-",
      total: inv.total,
      amountPaid: inv.amountPaid,
      balance: inv.balance,
      status: inv.status,
      createdBy: inv.createdBy || "-"
    }));

    res.json({ rows });

  } catch (error) {
    console.error("Export error:", error);
    res.status(500).json({ error: "Failed to export" });
  }
});

export default router;