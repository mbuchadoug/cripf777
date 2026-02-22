import express from "express";
import { requireWebAuth } from "../middleware/webAuth.js";
import Invoice from "../models/invoice.js";
import Expense from "../models/expense.js";
import InvoicePayment from "../models/invoicePayment.js";

const router = express.Router();

router.use(requireWebAuth);

/**
 * GET /web/reports
 * Reports dashboard
 */
router.get("/reports", async (req, res) => {
  try {
    const { businessId, branchId, role } = req.webUser;
    const { startDate, endDate, branchFilter } = req.query;
    
    // Build query
    const query = { businessId };
    
    // Branch filtering
    if (role !== "owner" && branchId) {
      query.branchId = branchId;
    } else if (branchFilter) {
      query.branchId = branchFilter;
    }
    
    // Date filtering
    if (startDate || endDate) {
      query.createdAt = {};
      if (startDate) query.createdAt.$gte = new Date(startDate);
      if (endDate) query.createdAt.$lte = new Date(endDate);
    }
    
    // Get sales data
    const [salesData, expenseData, paymentData] = await Promise.all([
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
        }
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
      ])
    ]);
    
    res.render("web/reports/sales", {
      layout: "web",
      title: "Reports - ZimQuote",
      user: req.webUser,
      salesData,
      expenseData,
      paymentData,
      filters: {
        startDate,
        endDate,
        branchFilter
      }
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

export default router;