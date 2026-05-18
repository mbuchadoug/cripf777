import { Router } from "express";
import SpecialScoiAudit from "../models/specialScoiAudit.js";
import { ensureAuth } from "../middleware/authGuard.js";
import { generateScoiAuditPdf } from "../utils/generateScoiAuditPdf.js";
import fs from "fs";
import path from "path";

const router = Router();

/**
 * LIST - Special SCOI Audits
 */
router.get("/admin/special-scoi-audits", ensureAuth, async (req, res) => {
  try {
    const audits = await SpecialScoiAudit.find({})
      .sort({ createdAt: -1 })
      .lean();

    res.render("admin/special_scoi_audits_list", {
      title: "Special SCOI Audit Reports",
      audits
    });
  } catch (err) {
    console.error("[special scoi list]", err);
    res.status(500).send("Failed to load special SCOI audits");
  }
});

/**
 * VIEW - Single Special SCOI Audit
 * ❗ DO NOT use .lean() (needed for getters, formatting, etc.)
 */
router.get(
  "/admin/special-scoi-audits/:id",
  ensureAuth,
  async (req, res) => {
    try {
      const audit = await SpecialScoiAudit.findById(req.params.id);

      if (!audit) {
        return res.status(404).send("Special SCOI audit not found");
      }

      res.render("admin/special_scoi_audit_view", {
        title: `Special SCOI Audit - ${audit.subject?.name || "Report"}`,
        audit,
        layout: "main"
      });
    } catch (err) {
      console.error("[special scoi view]", err);
      res.status(500).send("Failed to load special SCOI audit");
    }
  }
);

/**
 * GENERATE PDF - POST /admin/special-scoi-audits/:id/generate-pdf
 * Called from the list/view page "Gen PDF" button.
 * Returns JSON { success, url } so the frontend can reload.
 */
router.post(
  "/admin/special-scoi-audits/:id/generate-pdf",
  ensureAuth,
  async (req, res) => {
    try {
      // Use non-lean so Mongoose getters work inside the template
      const audit = await SpecialScoiAudit.findById(req.params.id);
      if (!audit) {
        return res.status(404).json({ success: false, error: "Audit not found" });
      }

      const result = await generateScoiAuditPdf({ audit, req });

      // Save pdfUrl back to DB so it shows on the list
      await SpecialScoiAudit.findByIdAndUpdate(audit._id, {
        $set: { pdfUrl: result.url }
      });

      return res.json({ success: true, url: result.url, filename: result.filename });

    } catch (err) {
      console.error("[special scoi generate-pdf]", err);
      return res.status(500).json({
        success: false,
        error: err.message || "PDF generation failed"
      });
    }
  }
);

/**
 * DOWNLOAD PDF - GET /admin/special-scoi-audits/:id/download-pdf
 * Streams the PDF directly to the browser as a download.
 * If PDF doesn't exist yet, generates it first.
 */
router.get(
  "/admin/special-scoi-audits/:id/download-pdf",
  ensureAuth,
  async (req, res) => {
    try {
      const audit = await SpecialScoiAudit.findById(req.params.id);
      if (!audit) {
        return res.status(404).send("Audit not found");
      }

      const safeFilename = `SCOI-Audit-${(audit.subject?.name || audit._id).replace(/[^a-zA-Z0-9-_]/g, "-")}.pdf`;

      // If we already have a stored PDF URL, try to serve it
      if (audit.pdfUrl) {
        const existingPath = path.join(process.cwd(), "public", audit.pdfUrl);
        if (fs.existsSync(existingPath)) {
          res.setHeader("Content-Type", "application/pdf");
          res.setHeader("Content-Disposition", `attachment; filename="${safeFilename}"`);
          return fs.createReadStream(existingPath).pipe(res);
        }
      }

      // Otherwise generate fresh
      const result = await generateScoiAuditPdf({ audit, req });

      // Save URL for future requests
      await SpecialScoiAudit.findByIdAndUpdate(audit._id, {
        $set: { pdfUrl: result.url }
      });

      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename="${safeFilename}"`);
      return fs.createReadStream(result.filepath).pipe(res);

    } catch (err) {
      console.error("[special scoi download-pdf]", err);
      return res.status(500).send(`PDF download failed: ${err.message}`);
    }
  }
);

/**
 * DELETE - Single Special SCOI Audit
 */
router.delete(
  "/admin/special-scoi-audits/:id",
  ensureAuth,
  async (req, res) => {
    try {
      const audit = await SpecialScoiAudit.findByIdAndDelete(req.params.id);
      if (!audit) {
        return res.status(404).json({ success: false, error: "Not found" });
      }

      // Optionally remove the PDF file
      if (audit.pdfUrl) {
        const pdfPath = path.join(process.cwd(), "public", audit.pdfUrl);
        fs.unlink(pdfPath, () => {}); // silent fail
      }

      return res.json({ success: true });
    } catch (err) {
      console.error("[special scoi delete]", err);
      return res.status(500).json({ success: false, error: err.message });
    }
  }
);

export default router;