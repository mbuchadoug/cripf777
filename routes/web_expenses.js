// routes/web_expenses.js
import express from "express";
import { requireWebAuth } from "../middleware/webAuth.js";
import Expense from "../models/expense.js";

const router = express.Router();
router.use(requireWebAuth);

/**
 * GET /web/expenses
 */
router.get("/expenses", async (req, res) => {
  try {
    const { businessId, branchId, role } = req.webUser;
    const { page = 1, search, category, branchFilter } = req.query;

    const query = { businessId };

    // Branch scoping
    if (role !== "owner" && branchId) {
      query.branchId = branchId;
    } else if (role === "owner" && branchFilter) {
      query.branchId = branchFilter;
    }

    if (category) query.category = { $regex: category, $options: "i" };

    if (search) {
      query.$or = [
        { description: { $regex: search, $options: "i" } },
        { method: { $regex: search, $options: "i" } }
      ];
    }

    const limit = 20;
    const skip = (Number(page) - 1) * limit;

    const [expenses, total, branches] = await Promise.all([
      Expense.find(query)
        .populate("branchId", "name")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Expense.countDocuments(query),
      role === "owner"
        ? (await import("../models/branch.js")).default.find({ businessId }).lean()
        : []
    ]);

    res.render("web/expenses/list", {
      layout: "web",
      pageTitle: "Expenses",
      pageKey: "expenses",
      user: req.webUser,
      expenses: expenses.map(e => ({
        ...e,
        branchName: e.branchId?.name || "—"
      })),
      branches,
      isOwner: role === "owner",
      filters: { search, category, branchFilter },
      pagination: {
        currentPage: Number(page),
        totalPages: Math.ceil(total / limit),
        hasNext: Number(page) < Math.ceil(total / limit),
        hasPrev: Number(page) > 1,
        total
      }
    });
  } catch (error) {
    console.error("Expenses list error:", error);
    res.status(500).render("web/error", {
      layout: "web",
      pageTitle: "Error",
      pageKey: "",
      message: "Failed to load expenses",
      user: req.webUser
    });
  }
});

/**
 * GET /web/expenses/create
 */
router.get("/expenses/create", async (req, res) => {
  try {
    res.render("web/expenses/create", {
      layout: "web",
      pageTitle: "Record Expense",
      pageKey: "expenses",
      user: req.webUser,
      business: { currency: req.webUser.currency }
    });
  } catch (error) {
    console.error("Expense create page error:", error);
    res.status(500).render("web/error", {
      layout: "web",
      pageTitle: "Error",
      pageKey: "",
      message: "Failed to load expense form",
      user: req.webUser
    });
  }
});

/**
 * POST /web/expenses/create
 */
router.post("/expenses/create", async (req, res) => {
  try {
    const { businessId, branchId, role, phone } = req.webUser;
    const { amount, description, category, method } = req.body;

    if (!amount || Number(amount) <= 0) {
      return res.status(400).json({ error: "Valid amount required" });
    }
    if (!category || !description) {
      return res.status(400).json({ error: "Category and description required" });
    }

    await Expense.create({
      businessId,
      branchId: role !== "owner" ? branchId : (branchId || null),
      amount: Number(amount),
      description: String(description || "").trim(),
      category: String(category || "").trim(),
      method: String(method || "Other"),
      createdBy: phone
    });

    res.json({ success: true });
  } catch (error) {
    console.error("Create expense error:", error);
    res.status(500).json({ error: "Failed to create expense" });
  }
});

export default router;