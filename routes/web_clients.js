// routes/web_clients.js
import express from "express";
import { requireWebAuth } from "../middleware/webAuth.js";
import Client from "../models/client.js";
import Invoice from "../models/invoice.js";

const router = express.Router();
router.use(requireWebAuth);

/**
 * GET /web/clients
 * List clients (business-wide; optional search)
 */
router.get("/clients", async (req, res) => {
  try {
    const { businessId } = req.webUser;
    const { page = 1, search } = req.query;

    const query = { businessId };
    if (search) {
      query.$or = [
        { name: { $regex: search, $options: "i" } },
        { phone: { $regex: search, $options: "i" } }
      ];
    }

    const limit = 50;
    const skip = (Number(page) - 1) * limit;

    const [clients, total] = await Promise.all([
      Client.find(query).sort({ name: 1 }).skip(skip).limit(limit).lean(),
      Client.countDocuments(query)
    ]);

    const totalPages = Math.ceil(total / limit);

    res.render("web/clients/list", {
      layout: "web",
      pageTitle: "Clients",
      pageKey: "clients",
      user: req.webUser,
      clients,
      pagination: {
        currentPage: Number(page),
        totalPages,
        hasNext: Number(page) < totalPages,
        hasPrev: Number(page) > 1
      },
      search
    });
  } catch (error) {
    console.error("Clients list error:", error);
    res.status(500).render("web/error", {
      layout: "web",
      pageTitle: "Error",
      pageKey: "",
      message: "Failed to load clients",
      user: req.webUser
    });
  }
});

/**
 * GET /web/clients/:id
 * View client profile (branch-scoped invoices for non-owner)
 */
router.get("/clients/:id", async (req, res) => {
  try {
    const { businessId, branchId, role } = req.webUser;

    const client = await Client.findOne({ _id: req.params.id, businessId }).lean();
    if (!client) {
      return res.status(404).render("web/error", {
        layout: "web",
        pageTitle: "Not Found",
        pageKey: "",
        message: "Client not found",
        user: req.webUser
      });
    }

    const invoiceQuery = { businessId, clientId: client._id };
    if (role !== "owner" && branchId) invoiceQuery.branchId = branchId;

    const invoices = await Invoice.find(invoiceQuery)
      .sort({ createdAt: -1 })
      .limit(10)
      .lean();

    const totals = await Invoice.aggregate([
      { $match: invoiceQuery },
      {
        $group: {
          _id: null,
          totalInvoiced: { $sum: "$total" },
          totalPaid: { $sum: "$amountPaid" },
          totalBalance: { $sum: "$balance" }
        }
      }
    ]);

    res.render("web/clients/profile", {
      layout: "web",
      pageTitle: client.name || client.phone || "Client",
      pageKey: "clients",
      user: req.webUser,
      client,
      invoices,
      totals: totals[0] || { totalInvoiced: 0, totalPaid: 0, totalBalance: 0 }
    });
  } catch (error) {
    console.error("Client profile error:", error);
    res.status(500).render("web/error", {
      layout: "web",
      pageTitle: "Error",
      pageKey: "",
      message: "Failed to load client",
      user: req.webUser
    });
  }
});

/**
 * POST /web/clients/create
 */
router.post("/clients/create", async (req, res) => {
  try {
    const { businessId } = req.webUser;
    const { name, phone } = req.body;

    if (!name && !phone) return res.status(400).json({ error: "Name or phone required" });

    const client = await Client.create({
      businessId,
      name: name || "",
      phone: phone || ""
    });

    res.json({ success: true, client });
  } catch (error) {
    console.error("Create client error:", error);
    res.status(500).json({ error: "Failed to create client" });
  }
});

export default router;