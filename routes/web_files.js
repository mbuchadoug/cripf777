import express from "express";
import { requireWebAuth } from "../middleware/webAuth.js";
import Invoice from "../models/invoice.js";

const router = express.Router();

router.use(requireWebAuth);

/**
 * GET /web/files
 * File download center
 */
router.get("/files", async (req, res) => {
  try {
    const { businessId, branchId, role } = req.webUser;
    
    // Build query
    const query = { businessId };
    if (role !== "owner" && branchId) {
      query.branchId = branchId;
    }
    
    // Get all documents
    const documents = await Invoice.find(query)
      .populate("clientId", "name phone")
      .sort({ createdAt: -1 })
      .limit(100)
      .lean();
    
    res.render("web/files/list", {
      layout: "web",
      title: "Files - ZimQuote",
      user: req.webUser,
      documents: documents.map(doc => ({
        ...doc,
        clientName: doc.clientId?.name || doc.clientId?.phone || "Unknown",
        folder: doc.type === "invoice" ? "invoices" : doc.type === "quote" ? "quotes" : "receipts"
      }))
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