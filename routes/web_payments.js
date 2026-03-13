// routes/web_payments.js
import express from "express";
import { requireWebAuth } from "../middleware/webAuth.js";
import Invoice from "../models/invoice.js";
import InvoicePayment from "../models/invoicePayment.js";
import Business from "../models/business.js";
import Client from "../models/client.js";
import { generatePDF } from "./twilio_biz.js";

const router = express.Router();
router.use(requireWebAuth);

/**
 * GET /web/payments
 */
router.get("/payments", async (req, res) => {
  try {
    const { businessId, branchId, role } = req.webUser;
    const { page = 1, search, branchFilter } = req.query;

    const query = { businessId };

    // Branch scoping
    if (role !== "owner" && branchId) query.branchId = branchId;
    else if (role === "owner" && branchFilter) query.branchId = branchFilter;

    // Simple search on receiptNumber/method (invoice/client search is handled via populated fields below)
    if (search) {
      query.$or = [
        { receiptNumber: { $regex: search, $options: "i" } },
        { method: { $regex: search, $options: "i" } }
      ];
    }

    const limit = 20;
    const skip = (Number(page) - 1) * limit;

    const [payments, total, branches] = await Promise.all([
      InvoicePayment.find(query)
        .populate("invoiceId", "number")
        .populate("clientId", "name phone")
        .populate("branchId", "name")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      InvoicePayment.countDocuments(query),
      role === "owner"
        ? (await import("../models/branch.js")).default.find({ businessId }).lean()
        : []
    ]);

    // If user searched invoice number/client, filter in-memory (fast enough for 20/page)
    let rows = payments.map(p => ({
      ...p,
      invoiceNumber: p.invoiceId?.number || "-",
      clientName: p.clientId?.name || p.clientId?.phone || "Unknown",
      branchName: p.branchId?.name || "-"
    }));

    if (search) {
      const s = String(search).toLowerCase();
      rows = rows.filter(r =>
        (r.invoiceNumber || "").toLowerCase().includes(s) ||
        (r.clientName || "").toLowerCase().includes(s) ||
        (r.receiptNumber || "").toLowerCase().includes(s) ||
        (r.method || "").toLowerCase().includes(s)
      );
    }

    res.render("web/payments/list", {
      layout: "web",
      pageTitle: "Payments",
      pageKey: "payments",
      user: req.webUser,
      payments: rows,
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
    console.error("Payments list error:", error);
    res.status(500).render("web/error", {
      layout: "web",
      pageTitle: "Error",
      pageKey: "",
      message: "Failed to load payments",
      user: req.webUser
    });
  }
});

/**
 * GET /web/payments/create
 * Show invoices that are unpaid/partial
 */
router.get("/payments/create", async (req, res) => {
  try {
    const { businessId, branchId, role } = req.webUser;
    const { search, branchFilter } = req.query;

    const query = { businessId, type: "invoice", status: { $in: ["unpaid", "partial"] } };

    // Branch scoping
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

    const invoices = await Invoice.find(query)
      .populate("clientId", "name phone")
      .populate("branchId", "name")
      .sort({ createdAt: -1 })
      .limit(80)
      .lean();

    const branches =
      role === "owner"
        ? await (await import("../models/branch.js")).default.find({ businessId }).lean()
        : [];

    res.render("web/payments/create", {
      layout: "web",
      pageTitle: "Record Payment",
      pageKey: "payments",
      user: req.webUser,
      invoices: invoices.map(inv => ({
        ...inv,
        clientName: inv.clientId?.name || inv.clientId?.phone || "Unknown",
        branchName: inv.branchId?.name || "-"
      })),
      branches,
      isOwner: role === "owner",
      filters: { search, branchFilter }
    });
  } catch (error) {
    console.error("Payments create page error:", error);
    res.status(500).render("web/error", {
      layout: "web",
      pageTitle: "Error",
      pageKey: "",
      message: "Failed to load payment form",
      user: req.webUser
    });
  }
});

/**
 * POST /web/payments/create
 * Create InvoicePayment + update invoice totals/status + generate receipt PDF
 */
router.post("/payments/create", async (req, res) => {
  try {
    const { businessId, branchId, role, phone } = req.webUser;
    const { invoiceId, amount, method = "Other" } = req.body;

    if (!invoiceId) return res.status(400).json({ error: "invoiceId is required" });
    if (!amount || Number(amount) <= 0) return res.status(400).json({ error: "Valid amount required" });

    // Load invoice with branch scoping
    const invQuery = { _id: invoiceId, businessId, type: "invoice" };
    if (role !== "owner" && branchId) invQuery.branchId = branchId;

    const invoice = await Invoice.findOne(invQuery).lean();
    if (!invoice) return res.status(404).json({ error: "Invoice not found" });
    if (invoice.status === "paid") return res.status(400).json({ error: "Invoice already paid" });

    const payAmount = Number(amount);
    const balance = Number(invoice.balance ?? (invoice.total - (invoice.amountPaid || 0)));

    if (payAmount > balance) return res.status(400).json({ error: "Payment exceeds invoice balance" });

    // Generate receipt number using business receipt counter/prefix
    const business = await Business.findById(businessId);
    if (!business) return res.status(404).json({ error: "Business not found" });

    business.counters = business.counters || { invoice: 0, quote: 0, receipt: 0 };
    business.counters.receipt = (business.counters.receipt || 0) + 1;

    const prefix = business.receiptPrefix || "RCPT";
    const receiptNumber = `${prefix}-${String(business.counters.receipt).padStart(6, "0")}`;
    await business.save();

    // Create payment record
    const payment = await InvoicePayment.create({
      businessId,
      clientId: invoice.clientId,
      branchId: invoice.branchId || null,
      invoiceId: invoice._id,
      amount: payAmount,
      method,
      receiptNumber,
      createdBy: phone
    });

    // Update invoice totals
    const newAmountPaid = Number(invoice.amountPaid || 0) + payAmount;
    const newBalance = Math.max(0, Number(invoice.total) - newAmountPaid);
    const newStatus = newBalance === 0 ? "paid" : "partial";

    await Invoice.updateOne(
      { _id: invoice._id },
      {
        $set: { amountPaid: newAmountPaid, balance: newBalance, status: newStatus, updatedBy: phone }
      }
    );

    // Generate a receipt PDF using the invoice items, but with payment receipt number
    const client = await Client.findById(invoice.clientId).lean();

    const { filename } = await generatePDF({
      type: "receipt",
      number: receiptNumber,
      date: payment.createdAt,
      billingTo: client?.name || client?.phone || "Unknown",
      items: invoice.items || [],
      bizMeta: {
        name: business.name,
        logoUrl: business.logoUrl,
        address: business.address || "",
        discountPercent: invoice.discountPercent || 0,
        vatPercent: invoice.vatPercent || 0,
        applyVat: false,
        _id: business._id.toString(),
        status: newStatus
      }
    });

    const site = (process.env.SITE_URL || "").replace(/\/$/, "");
    const url = `${site}/docs/generated/receipts/${filename}`;

    res.json({
      success: true,
      receiptUrl: url,
      redirectUrl: `/web/invoices/${invoice._id}`
    });
  } catch (error) {
    console.error("Create payment error:", error);
    res.status(500).json({ error: "Failed to record payment" });
  }
});

/**
 * GET /web/payments/:id/pdf
 * Re-generate payment receipt PDF anytime
 */
router.get("/payments/:id/pdf", async (req, res) => {
  try {
    const { businessId, branchId, role } = req.webUser;

    const payQuery = { _id: req.params.id, businessId };
    if (role !== "owner" && branchId) payQuery.branchId = branchId;

    const payment = await InvoicePayment.findOne(payQuery)
      .populate("invoiceId")
      .populate("clientId")
      .lean();

    if (!payment) return res.status(404).json({ error: "Payment not found" });

    const business = await Business.findById(businessId).lean();

    const { filename } = await generatePDF({
      type: "receipt",
      number: payment.receiptNumber || "RCPT",
      date: payment.createdAt,
      billingTo: payment.clientId?.name || payment.clientId?.phone || "Unknown",
      items: payment.invoiceId?.items || [],
      bizMeta: {
        name: business.name,
        logoUrl: business.logoUrl,
        address: business.address || "",
        discountPercent: payment.invoiceId?.discountPercent || 0,
        vatPercent: payment.invoiceId?.vatPercent || 0,
        applyVat: false,
        _id: business._id.toString(),
        status: payment.invoiceId?.status || "partial"
      }
    });

    const site = (process.env.SITE_URL || "").replace(/\/$/, "");
    const url = `${site}/docs/generated/receipts/${filename}`;

    res.json({ url, filename });
  } catch (error) {
    console.error("Payment PDF error:", error);
    res.status(500).json({ error: "Failed to generate receipt PDF" });
  }
});

export default router;