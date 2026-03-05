// routes/web_receipts.js
import express from "express";
import { requireWebAuth } from "../middleware/webAuth.js";
import Invoice from "../models/invoice.js";
import Client from "../models/client.js";
import Product from "../models/product.js";
import Business from "../models/business.js";
import { generatePDF } from "./twilio_biz.js";

const router = express.Router();
router.use(requireWebAuth);

/**
 * GET /web/receipts
 */
router.get("/receipts", async (req, res) => {
  try {
    const { businessId, branchId, role } = req.webUser;
    const { page = 1, search, branchFilter } = req.query;

    const query = { businessId, type: "receipt" };

    if (role !== "owner" && branchId) query.branchId = branchId;
    else if (role === "owner" && branchFilter) query.branchId = branchFilter;

    if (search) {
      const clients = await Client.find({
        businessId,
        $or: [
          { name: { $regex: search, $options: "i" } },
          { phone: { $regex: search, $options: "i" } }
        ]
      }).distinct("_id");

      query.$or = [
        { number: { $regex: search, $options: "i" } },
        { clientId: { $in: clients } }
      ];
    }

    const limit = 20;
    const skip = (Number(page) - 1) * limit;

    const [receipts, total, branches] = await Promise.all([
      Invoice.find(query)
        .populate("clientId", "name phone")
        .populate("branchId", "name")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Invoice.countDocuments(query),
      role === "owner"
        ? (await import("../models/branch.js")).default.find({ businessId }).lean()
        : []
    ]);

    res.render("web/receipts/list", {
      layout: "web",
      pageTitle: "Receipts",
      pageKey: "receipts",
      user: req.webUser,
      receipts: receipts.map(r => ({
        ...r,
        clientName: r.clientId?.name || r.clientId?.phone || "Unknown",
        branchName: r.branchId?.name || "—"
      })),
      branches,
      isOwner: role === "owner",
      filters: { search, branchFilter },
      pagination: {
        currentPage: Number(page),
        totalPages: Math.ceil(total / limit),
        hasNext: Number(page) < Math.ceil(total / limit),
        hasPrev: Number(page) > 1,
        total
      }
    });
  } catch (error) {
    console.error("Receipts list error:", error);
    res.status(500).render("web/error", {
      layout: "web",
      pageTitle: "Error",
      pageKey: "",
      message: "Failed to load receipts",
      user: req.webUser
    });
  }
});

/**
 * GET /web/receipts/create
 */

router.get("/receipts/create", async (req, res) => {
  try {
    const { businessId, branchId, role } = req.webUser;

    const clients = await Client.find({ businessId }).sort({ name: 1 }).lean();

    // ✅ Products visibility:
    // staff: see their branch + global
    // owner: see all (we'll filter in UI based on chosen branch)
    const productQuery = { businessId, isActive: true };

    if (role !== "owner") {
      productQuery.$or = [
        { branchId: branchId || null },
        { branchId: null }
      ];
    }

    const products = await Product.find(productQuery).sort({ name: 1 }).lean();

    const business = await Business.findById(businessId).lean();

    // ✅ Owner branch list for dropdown
    let branches = [];
    if (role === "owner") {
      const BranchModel = (await import("../models/branch.js")).default;
      branches = await BranchModel.find({ businessId }).sort({ name: 1 }).lean();
    }

    res.render("web/receipts/create", {
      layout: "web",
      pageTitle: "Create Receipt",
      pageKey: "receipts",
      user: req.webUser,
      clients,
      products,
      branches,
      isOwner: role === "owner",
      business: { currency: business.currency }
    });
  } catch (error) {
    console.error("Receipt create page error:", error);
    res.status(500).render("web/error", {
      layout: "web",
      pageTitle: "Error",
      pageKey: "",
      message: "Failed to load receipt form",
      user: req.webUser
    });
  }
});
/**
 * POST /web/receipts/create
 */
router.post("/receipts/create", async (req, res) => {
  try {
    const { businessId, branchId: userBranchId, phone, role } = req.webUser;
    const { clientId, items, discountPercent = 0, branchId } = req.body;

    if (!clientId || !items || items.length === 0) {
      return res.status(400).json({ error: "Client and items required" });
    }

    const business = await Business.findById(businessId);
    if (!business) return res.status(404).json({ error: "Business not found" });

    const subtotal = items.reduce((sum, item) => sum + item.qty * item.unit, 0);
    const discountAmount = subtotal * (Number(discountPercent) / 100);
    const total = subtotal - discountAmount;

    business.counters = business.counters || { invoice: 0, quote: 0, receipt: 0 };
    business.counters.receipt += 1;
    const prefix = business.receiptPrefix || "RCPT";
    const number = `${prefix}-${String(business.counters.receipt).padStart(6, "0")}`;
    await business.save();

   const receipt = await Invoice.create({
  businessId,
  branchId: finalBranchId,
  clientId,
  number,
  type: "receipt",
  currency: business.currency,
  status: "paid",
  items: items.map(i => ({ item: i.item, qty: i.qty, unit: i.unit, total: i.qty * i.unit })),
  subtotal,
  discountPercent: Number(discountPercent),
  discountAmount,
  vatPercent: 0,
  vatAmount: 0,
  total,
  amountPaid: total,
  balance: 0,
  createdBy: phone
});

    // ✅ Decide branch for the receipt
let finalBranchId = userBranchId || null;

// Owner/admin can choose branch (or global)
if (role === "owner") {
  finalBranchId = branchId ? String(branchId) : null;

  // Validate chosen branch belongs to this business (if provided)
  if (finalBranchId) {
    const BranchModel = (await import("../models/branch.js")).default;
    const exists = await BranchModel.findOne({ _id: finalBranchId, businessId }).lean();
    if (!exists) return res.status(400).json({ error: "Invalid branch selected" });
  }
}

    res.json({ success: true, redirectUrl: `/web/receipts/${receipt._id}` });
  } catch (error) {
    console.error("Create receipt error:", error);
    res.status(500).json({ error: "Failed to create receipt" });
  }
});

/**
 * GET /web/receipts/:id
 */
router.get("/receipts/:id", async (req, res) => {
  try {
    const { businessId, branchId, role } = req.webUser;

    const query = { _id: req.params.id, businessId, type: "receipt" };
    if (role !== "owner" && branchId) query.branchId = branchId;

    const receipt = await Invoice.findOne(query)
      .populate("clientId")
      .populate("branchId", "name")
      .lean();

    if (!receipt) {
      return res.status(404).render("web/error", {
        layout: "web",
        pageTitle: "Not Found",
        pageKey: "",
        message: "Receipt not found",
        user: req.webUser
      });
    }

    res.render("web/receipts/view", {
      layout: "web",
      pageTitle: "Receipt",
      pageKey: "receipts",
      user: req.webUser,
      receipt: {
        ...receipt,
        clientName: receipt.clientId?.name || receipt.clientId?.phone || "Unknown",
        branchName: receipt.branchId?.name || "—"
      }
    });
  } catch (error) {
    console.error("View receipt error:", error);
    res.status(500).render("web/error", {
      layout: "web",
      pageTitle: "Error",
      pageKey: "",
      message: "Failed to load receipt",
      user: req.webUser
    });
  }
});

/**
 * GET /web/receipts/:id/pdf
 */
router.get("/receipts/:id/pdf", async (req, res) => {
  try {
    const { businessId, branchId, role } = req.webUser;

    const query = { _id: req.params.id, businessId, type: "receipt" };
    if (role !== "owner" && branchId) query.branchId = branchId;

    const receipt = await Invoice.findOne(query).populate("clientId").lean();
    if (!receipt) return res.status(404).json({ error: "Receipt not found" });

    const business = await Business.findById(businessId).lean();

    const { filename } = await generatePDF({
      type: "receipt",
      number: receipt.number,
      date: receipt.createdAt,
      billingTo: receipt.clientId?.name || receipt.clientId?.phone || "Unknown",
      items: receipt.items,
      bizMeta: {
        name: business.name,
        logoUrl: business.logoUrl,
        address: business.address || "",
        discountPercent: receipt.discountPercent || 0,
        vatPercent: 0,
        applyVat: false,
        _id: business._id.toString(),
        status: receipt.status
      }
    });

    const site = (process.env.SITE_URL || "").replace(/\/$/, "");
    const url = `${site}/docs/generated/receipts/${filename}`;
    res.json({ url, filename });
  } catch (error) {
    console.error("Receipt PDF error:", error);
    res.status(500).json({ error: "Failed to generate PDF" });
  }
});

export default router;