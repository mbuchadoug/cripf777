import express from "express";
import { requireWebAuth } from "../middleware/webAuth.js";
import Invoice from "../models/invoice.js";
import Client from "../models/client.js";
import Product from "../models/product.js";
import Business from "../models/business.js";
import { generatePDF } from "./twilio_biz.js";

const router = express.Router();

// All routes require authentication
router.use(requireWebAuth);

/**
 * GET /web/invoices
 * List all invoices
 */
router.get("/invoices", async (req, res) => {
  try {
    const { businessId, branchId, role } = req.webUser;
    const { page = 1, status, search } = req.query;
    
    // Build query
    const query = { businessId, type: "invoice" };
    if (role !== "owner" && branchId) {
      query.branchId = branchId;
    }
    if (status) {
      query.status = status;
    }
    
    // Pagination
    const limit = 20;
    const skip = (page - 1) * limit;
    
    // Get invoices
    const [invoices, total] = await Promise.all([
      Invoice.find(query)
        .populate("clientId", "name phone")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Invoice.countDocuments(query)
    ]);
    
    const totalPages = Math.ceil(total / limit);
    
    res.render("web/invoices/list", {
      layout: "web",
      title: "Invoices - ZimQuote",
      user: req.webUser,
      invoices: invoices.map(inv => ({
        ...inv,
        clientName: inv.clientId?.name || inv.clientId?.phone || "Unknown"
      })),
      pagination: {
        currentPage: parseInt(page),
        totalPages,
        hasNext: page < totalPages,
        hasPrev: page > 1
      },
      filters: {
        status
      }
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
 * Show invoice creation form
 */
router.get("/invoices/create", async (req, res) => {
  try {
    const { businessId, branchId, role } = req.webUser;
    
    // Get clients
    const clients = await Client.find({ businessId })
      .sort({ name: 1 })
      .lean();
    
    // Get products
    const productQuery = { businessId, isActive: true };
    if (role !== "owner" && branchId) {
      productQuery.branchId = branchId;
    }
    
    const products = await Product.find(productQuery)
      .sort({ name: 1 })
      .lean();
    
    // Get business settings
    const business = await Business.findById(businessId).lean();
    
    res.render("web/invoices/create", {
      layout: "web",
      title: "Create Invoice - ZimQuote",
      user: req.webUser,
      clients,
      products,
      business: {
        currency: business.currency,
        invoicePrefix: business.invoicePrefix || "INV"
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
 * Create new invoice
 */
router.post("/invoices/create", async (req, res) => {
  try {
    const { businessId, branchId } = req.webUser;
    const {
      clientId,
      items,
      discountPercent = 0,
      vatPercent = 0,
      applyVat = true
    } = req.body;
    
    if (!clientId || !items || items.length === 0) {
      return res.status(400).json({ error: "Client and items required" });
    }
    
    // Get business
    const business = await Business.findById(businessId);
    
    if (!business) {
      return res.status(404).json({ error: "Business not found" });
    }
    
    // Calculate totals
    const subtotal = items.reduce((sum, item) => {
      return sum + (item.qty * item.unit);
    }, 0);
    
    const discountAmount = subtotal * (discountPercent / 100);
    const vatAmount = applyVat ? (subtotal - discountAmount) * (vatPercent / 100) : 0;
    const total = subtotal - discountAmount + vatAmount;
    
    // Generate invoice number
    business.counters = business.counters || { invoice: 0, quote: 0, receipt: 0 };
    business.counters.invoice += 1;
    
    const prefix = business.invoicePrefix || "INV";
    const number = `${prefix}-${String(business.counters.invoice).padStart(6, "0")}`;
    
    await business.save();
    
    // Create invoice
    const invoice = await Invoice.create({
      businessId,
      branchId: branchId || null,
      clientId,
      number,
      type: "invoice",
      currency: business.currency,
      status: "unpaid",
      items: items.map(item => ({
        item: item.item,
        qty: item.qty,
        unit: item.unit,
        total: item.qty * item.unit
      })),
      subtotal,
      discountPercent,
      discountAmount,
      vatPercent,
      vatAmount,
      total,
      amountPaid: 0,
      balance: total,
      createdBy: req.webUser.phone
    });
    
    res.json({
      success: true,
      invoiceId: invoice._id,
      redirectUrl: `/web/invoices/${invoice._id}`
    });
    
  } catch (error) {
    console.error("Create invoice error:", error);
    res.status(500).json({ error: "Failed to create invoice" });
  }
});

/**
 * GET /web/invoices/:id
 * View invoice details
 */
router.get("/invoices/:id", async (req, res) => {
  try {
    const { businessId, branchId, role } = req.webUser;
    
    // Build query
    const query = { _id: req.params.id, businessId };
    if (role !== "owner" && branchId) {
      query.branchId = branchId;
    }
    
    const invoice = await Invoice.findOne(query)
      .populate("clientId")
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
      title: `Invoice ${invoice.number} - ZimQuote`,
      user: req.webUser,
      invoice: {
        ...invoice,
        clientName: invoice.clientId?.name || invoice.clientId?.phone || "Unknown"
      }
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
 * GET /web/invoices/:id/pdf
 * Download invoice PDF
 */
router.get("/invoices/:id/pdf", async (req, res) => {
  try {
    const { businessId, branchId, role } = req.webUser;
    
    const query = { _id: req.params.id, businessId };
    if (role !== "owner" && branchId) {
      query.branchId = branchId;
    }
    
    const invoice = await Invoice.findOne(query)
      .populate("clientId")
      .lean();
    
    if (!invoice) {
      return res.status(404).json({ error: "Invoice not found" });
    }
    
    const business = await Business.findById(businessId).lean();
    
    // Generate PDF
    const { filename } = await generatePDF({
      type: "invoice",
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
        applyVat: invoice.type === "receipt" ? false : true,
        _id: business._id.toString(),
        status: invoice.status
      }
    });
    
    const site = (process.env.SITE_URL || "").replace(/\/$/, "");
    const url = `${site}/docs/generated/invoices/${filename}`;
    
    res.json({ url, filename });
    
  } catch (error) {
    console.error("Invoice PDF error:", error);
    res.status(500).json({ error: "Failed to generate PDF" });
  }
});

/**
 * DELETE /web/invoices/:id
 * Delete invoice (managers and owners only)
 */
router.delete("/invoices/:id", async (req, res) => {
  try {
    const { businessId, branchId, role } = req.webUser;
    
    // Only managers and owners can delete
    if (!["owner", "manager"].includes(role)) {
      return res.status(403).json({ error: "Permission denied" });
    }
    
    const query = { _id: req.params.id, businessId };
    if (role !== "owner" && branchId) {
      query.branchId = branchId;
    }
    
    const invoice = await Invoice.findOne(query);
    
    if (!invoice) {
      return res.status(404).json({ error: "Invoice not found" });
    }
    
    // Cannot delete paid invoices
    if (invoice.status === "paid") {
      return res.status(400).json({ error: "Cannot delete paid invoices" });
    }
    
    await Invoice.deleteOne({ _id: invoice._id });
    
    res.json({ success: true });
    
  } catch (error) {
    console.error("Delete invoice error:", error);
    res.status(500).json({ error: "Failed to delete invoice" });
  }
});

export default router;