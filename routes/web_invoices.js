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
 * GET /web/invoices
 * List all invoices — owners see all or filter by branch
 */
router.get("/invoices", async (req, res) => {
  try {
    const { businessId, branchId, role } = req.webUser;
    const { page = 1, status, search, branchFilter, type = "invoice" } = req.query;

    const query = { businessId, type };

    // Branch scoping
    if (role !== "owner" && branchId) {
      query.branchId = branchId;
    } else if (role === "owner" && branchFilter) {
      query.branchId = branchFilter;
    }

    if (status) query.status = status;

    // Search by invoice number or client name
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
    const skip = (page - 1) * limit;

    const [invoices, total] = await Promise.all([
      Invoice.find(query)
        .populate("clientId", "name phone")
        .populate("branchId", "name")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Invoice.countDocuments(query)
    ]);

    // Load branches for owner filter
    let branches = [];
    if (role === "owner") {
      const Branch = (await import("../models/branch.js")).default;
      branches = await Branch.find({ businessId }).lean();
    }

    res.render("web/invoices/list", {
      layout: "web",
      title: "Invoices - ZimQuote",
      user: req.webUser,
      invoices: invoices.map(inv => ({
        ...inv,
        clientName: inv.clientId?.name || inv.clientId?.phone || "Unknown",
        branchName: inv.branchId?.name || "—"
      })),
      pagination: {
        currentPage: parseInt(page),
        totalPages: Math.ceil(total / limit),
        hasNext: parseInt(page) < Math.ceil(total / limit),
        hasPrev: parseInt(page) > 1,
        total
      },
      filters: { status, search, branchFilter, type },
      branches,
      isOwner: role === "owner"
    });

  } catch (error) {
    console.error("Invoices list error:", error);
    res.status(500).render("web/error", {
      layout: "web",
      title: "Error",
      message: "Failed to load invoices",
      user: req.webUser
    });
  }
});

/**
 * GET /web/invoices/create
 */
router.get("/invoices/create", async (req, res) => {
  try {
    const { businessId, branchId, role } = req.webUser;
    const { type = "invoice" } = req.query;

    const clients = await Client.find({ businessId }).sort({ name: 1 }).lean();

    const productQuery = { businessId, isActive: true };
    if (role !== "owner" && branchId) productQuery.branchId = branchId;
    const products = await Product.find(productQuery).sort({ name: 1 }).lean();

    const business = await Business.findById(businessId).lean();

    res.render("web/invoices/create", {
      layout: "web",
      title: `Create ${type.charAt(0).toUpperCase() + type.slice(1)} - ZimQuote`,
      user: req.webUser,
      clients,
      products,
      docType: type,
      business: {
        currency: business.currency,
        invoicePrefix: business.invoicePrefix || "INV",
        quotePrefix: business.quotePrefix || "QT",
        receiptPrefix: business.receiptPrefix || "RCPT"
      }
    });

  } catch (error) {
    console.error("Invoice create page error:", error);
    res.status(500).render("web/error", {
      layout: "web",
      title: "Error",
      message: "Failed to load invoice form",
      user: req.webUser
    });
  }
});

/**
 * POST /web/invoices/create
 */
router.post("/invoices/create", async (req, res) => {
  try {
    const { businessId, branchId, phone } = req.webUser;
    const {
      clientId, items, type = "invoice",
      discountPercent = 0, vatPercent = 0, applyVat = true
    } = req.body;

    if (!clientId || !items || items.length === 0) {
      return res.status(400).json({ error: "Client and items required" });
    }

    const business = await Business.findById(businessId);
    if (!business) return res.status(404).json({ error: "Business not found" });

    const subtotal = items.reduce((sum, item) => sum + item.qty * item.unit, 0);
    const discountAmount = subtotal * (discountPercent / 100);
    const isReceipt = type === "receipt";
    const vatAmount = (!isReceipt && applyVat)
      ? (subtotal - discountAmount) * (vatPercent / 100)
      : 0;
    const total = subtotal - discountAmount + vatAmount;

    // Increment counter
    business.counters = business.counters || { invoice: 0, quote: 0, receipt: 0 };
    const counterKey = type === "invoice" ? "invoice" : type === "quote" ? "quote" : "receipt";
    business.counters[counterKey] += 1;

    const prefix =
      type === "invoice" ? business.invoicePrefix || "INV"
      : type === "quote" ? business.quotePrefix || "QT"
      : business.receiptPrefix || "RCPT";

    const number = `${prefix}-${String(business.counters[counterKey]).padStart(6, "0")}`;
    await business.save();

    const invoice = await Invoice.create({
      businessId,
      branchId: branchId || null,
      clientId,
      number,
      type,
      currency: business.currency,
      status: isReceipt ? "paid" : "unpaid",
      items: items.map(i => ({ item: i.item, qty: i.qty, unit: i.unit, total: i.qty * i.unit })),
      subtotal,
      discountPercent: Number(discountPercent),
      discountAmount,
      vatPercent: Number(vatPercent),
      vatAmount,
      total,
      amountPaid: isReceipt ? total : 0,
      balance: isReceipt ? 0 : total,
      createdBy: phone  // ✅ TRACK WHO CREATED IT
    });

    res.json({ success: true, invoiceId: invoice._id, redirectUrl: `/web/invoices/${invoice._id}` });

  } catch (error) {
    console.error("Create invoice error:", error);
    res.status(500).json({ error: "Failed to create invoice" });
  }
});

/**
 * GET /web/invoices/:id
 */
router.get("/invoices/:id", async (req, res) => {
  try {
    const { businessId, branchId, role } = req.webUser;

    const query = { _id: req.params.id, businessId };
    if (role !== "owner" && branchId) query.branchId = branchId;

    const invoice = await Invoice.findOne(query)
      .populate("clientId")
      .populate("branchId", "name")
      .lean();

    if (!invoice) {
      return res.status(404).render("web/error", {
        layout: "web",
        title: "Not Found",
        message: "Invoice not found",
        user: req.webUser
      });
    }

    res.render("web/invoices/view", {
      layout: "web",
      title: `${invoice.number} - ZimQuote`,
      user: req.webUser,
      invoice: {
        ...invoice,
        clientName: invoice.clientId?.name || invoice.clientId?.phone || "Unknown",
        branchName: invoice.branchId?.name || "—"
      },
      isOwner: role === "owner",
      canEdit: ["owner", "manager"].includes(role)
    });

  } catch (error) {
    console.error("View invoice error:", error);
    res.status(500).render("web/error", {
      layout: "web",
      title: "Error",
      message: "Failed to load invoice",
      user: req.webUser
    });
  }
});

/**
 * PUT /web/invoices/:id
 * Edit invoice — owners and managers only
 */
router.put("/invoices/:id", async (req, res) => {
  try {
    const { businessId, branchId, role, phone } = req.webUser;

    if (!["owner", "manager"].includes(role)) {
      return res.status(403).json({ error: "Permission denied" });
    }

    const query = { _id: req.params.id, businessId };
    if (role !== "owner" && branchId) query.branchId = branchId;

    const invoice = await Invoice.findOne(query);
    if (!invoice) return res.status(404).json({ error: "Invoice not found" });
    if (invoice.status === "paid") return res.status(400).json({ error: "Cannot edit a paid invoice" });

    const { items, discountPercent = 0, vatPercent = 0, applyVat = true } = req.body;

    if (!items || items.length === 0) {
      return res.status(400).json({ error: "Items required" });
    }

    const subtotal = items.reduce((s, i) => s + i.qty * i.unit, 0);
    const discountAmount = subtotal * (discountPercent / 100);
    const vatAmount = applyVat ? (subtotal - discountAmount) * (vatPercent / 100) : 0;
    const total = subtotal - discountAmount + vatAmount;

    invoice.items = items.map(i => ({ item: i.item, qty: i.qty, unit: i.unit, total: i.qty * i.unit }));
    invoice.subtotal = subtotal;
    invoice.discountPercent = Number(discountPercent);
    invoice.discountAmount = discountAmount;
    invoice.vatPercent = Number(vatPercent);
    invoice.vatAmount = vatAmount;
    invoice.total = total;
    invoice.balance = total - invoice.amountPaid;
    invoice.updatedBy = phone;  // ✅ TRACK WHO EDITED
    await invoice.save();

    res.json({ success: true });

  } catch (error) {
    console.error("Edit invoice error:", error);
    res.status(500).json({ error: "Failed to update invoice" });
  }
});

/**
 * GET /web/invoices/:id/pdf
 */
router.get("/invoices/:id/pdf", async (req, res) => {
  try {
    const { businessId, branchId, role } = req.webUser;

    const query = { _id: req.params.id, businessId };
    if (role !== "owner" && branchId) query.branchId = branchId;

    const invoice = await Invoice.findOne(query).populate("clientId").lean();
    if (!invoice) return res.status(404).json({ error: "Invoice not found" });

    const business = await Business.findById(businessId).lean();

    const { filename } = await generatePDF({
      type: invoice.type,
      number: invoice.number,
      date: invoice.createdAt,
      billingTo: invoice.clientId?.name || invoice.clientId?.phone || "Unknown",
      items: invoice.items,
      bizMeta: {
        name: business.name,
        logoUrl: business.logoUrl,
        address: business.address || "",
        discountPercent: invoice.discountPercent || 0,
        vatPercent: invoice.vatPercent || 0,
        applyVat: invoice.type !== "receipt",
        _id: business._id.toString(),
        status: invoice.status
      }
    });

    const site = (process.env.SITE_URL || "").replace(/\/$/, "");
    const folder = invoice.type === "invoice" ? "invoices" : invoice.type === "quote" ? "quotes" : "receipts";
    const url = `${site}/docs/generated/${folder}/${filename}`;

    res.json({ url, filename });

  } catch (error) {
    console.error("Invoice PDF error:", error);
    res.status(500).json({ error: "Failed to generate PDF" });
  }
});

/**
 * DELETE /web/invoices/:id
 * Owners and managers only; cannot delete paid invoices
 */
router.delete("/invoices/:id", async (req, res) => {
  try {
    const { businessId, branchId, role } = req.webUser;

    if (!["owner", "manager"].includes(role)) {
      return res.status(403).json({ error: "Permission denied" });
    }

    const query = { _id: req.params.id, businessId };
    if (role !== "owner" && branchId) query.branchId = branchId;

    const invoice = await Invoice.findOne(query);
    if (!invoice) return res.status(404).json({ error: "Invoice not found" });
    if (invoice.status === "paid") return res.status(400).json({ error: "Cannot delete paid invoices" });

    await Invoice.deleteOne({ _id: invoice._id });
    res.json({ success: true });

  } catch (error) {
    console.error("Delete invoice error:", error);
    res.status(500).json({ error: "Failed to delete invoice" });
  }
});

export default router;