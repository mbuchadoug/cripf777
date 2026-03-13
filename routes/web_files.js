import express from "express";
import { requireWebAuth } from "../middleware/webAuth.js";
import Invoice from "../models/invoice.js";

const router = express.Router();

router.use(requireWebAuth);

/**
 * GET /web/files
 * Document download centre - all invoices, quotes, receipts
 */
router.get("/files", async (req, res) => {
  try {
    const { businessId, branchId, role } = req.webUser;
    const { type, search, branchFilter } = req.query;

    const query = { businessId };

    if (role !== "owner" && branchId) {
      query.branchId = branchId;
    } else if (role === "owner" && branchFilter) {
      query.branchId = branchFilter;
    }

    if (type && ["invoice", "quote", "receipt"].includes(type)) {
      query.type = type;
    }

    if (search) {
      const Client = (await import("../models/client.js")).default;
      const matchedClients = await Client.find({
        businessId,
        $or: [
          { name: { $regex: search, $options: "i" } },
          { phone: { $regex: search, $options: "i" } }
        ]
      }).distinct("_id");

      query.$or = [
        { number: { $regex: search, $options: "i" } },
        { clientId: { $in: matchedClients } }
      ];
    }

    const documents = await Invoice.find(query)
      .populate("clientId", "name phone")
      .populate("branchId", "name")
      .sort({ createdAt: -1 })
      .limit(200)
      .lean();

    let branches = [];
    if (role === "owner") {
      const Branch = (await import("../models/branch.js")).default;
      branches = await Branch.find({ businessId }).lean();
    }

    const site = (process.env.SITE_URL || "").replace(/\/$/, "");

    res.render("web/files/list", {
      layout: "web",
      title: "Files - ZimQuote",
      user: req.webUser,
      documents: documents.map(doc => {
        const folder = doc.type === "invoice" ? "invoices"
          : doc.type === "quote" ? "quotes"
          : "receipts";
        return {
          ...doc,
          clientName: doc.clientId?.name || doc.clientId?.phone || "Unknown",
          branchName: doc.branchId?.name || "-",
          folder,
          // The PDF filename follows the naming convention used in generatePDF
          pdfUrl: `${site}/docs/generated/${folder}/${doc.number.replace(/\//g, "-")}.pdf`
        };
      }),
      branches,
      filters: { type, search, branchFilter },
      isOwner: role === "owner"
    });

  } catch (error) {
    console.error("Files list error:", error);
    res.status(500).render("web/error", {
      layout: "web",
      title: "Error",
      message: "Failed to load files",
      user: req.webUser
    });
  }
});

export default router;