// routes/admin_scoi_reports.js - ADMIN SCOI REPORTS MANAGEMENT

import { Router } from "express";
import fs from "fs";
import path from "path";
import PlacementAudit from "../models/placementAudit.js";
import SpecialScoiAudit from "../models/specialScoiAudit.js";
import { ensureAuth } from "../middleware/authGuard.js";
import { generateScoiAuditPdf as generateScoiPdf } from "../utils/generateScoiAuditPdf.js";

const router = Router();

/**
 * GET - List all SCOI reports (admin view)
 */
router.get("/admin/scoi/reports", ensureAuth, async (req, res) => {
  try {
    const placementAudits = await PlacementAudit.find({})
      .sort({ "assessmentWindow.label": -1 })
      .lean();

    const specialAudits = await SpecialScoiAudit.find({})
      .sort({ createdAt: -1 })
      .lean();

    const normalizedPlacement = placementAudits.map(a => ({
      ...a,
      auditKind: "placement"
    }));

    const normalizedSpecial = specialAudits.map(a => ({
      ...a,
      auditKind: "special",
      assessmentWindow: {
        label: a.assessmentWindow?.label || "N/A"
      }
    }));

    const reports = [...normalizedSpecial, ...normalizedPlacement];

    const stats = {
      total:     reports.length,
      placement: normalizedPlacement.length,
      special:   normalizedSpecial.length,
      withPdf:   reports.filter(r => r.pdfUrl).length
    };

    res.render("admin/scoi_reports_list", {
      user: req.user,
      reports,
      stats
    });
  } catch (err) {
    console.error("[admin scoi reports]", err);
    res.status(500).send("Failed to load reports");
  }
});

/**
 * GET - View single report (admin)
 */
router.get("/admin/scoi/reports/:id/view", ensureAuth, async (req, res) => {
  try {
    let audit = await PlacementAudit.findById(req.params.id).lean();

    if (audit) {
      return res.render("scoi/audit_view", {
        audit,
        user: req.user,
        layout: false
      });
    }

    // Not a placement - try special (use non-lean for getters)
    audit = await SpecialScoiAudit.findById(req.params.id);

    if (!audit) {
      return res.status(404).send("Report not found");
    }

    return res.render("admin/special_scoi_audit_view", {
      title: `Special SCOI Audit - ${audit.subject?.name || "Report"}`,
      audit,
      user: req.user,
      layout: false
    });
  } catch (err) {
    console.error("[admin view report]", err);
    res.status(500).send("Failed to load report");
  }
});

/**
 * POST - Generate PDF for single report
 */
router.post("/admin/scoi/reports/:id/generate-pdf", ensureAuth, async (req, res) => {
  try {
    let audit = await PlacementAudit.findById(req.params.id);
    let Model = PlacementAudit;

    if (!audit) {
      audit = await SpecialScoiAudit.findById(req.params.id);
      Model = SpecialScoiAudit;
    }

    if (!audit) {
      return res.status(404).json({ success: false, error: "Report not found" });
    }

    // Re-generate even if pdfUrl exists (admin may want a fresh copy)
    const pdf = await generateScoiPdf({ audit, req });
    audit.pdfUrl = pdf.url;
    await audit.save();

    console.log(`[PDF Generation] ✅ PDF generated: ${pdf.url}`);

    res.json({ success: true, pdfUrl: pdf.url, url: pdf.url });
  } catch (err) {
    console.error("[PDF generation error]", err);
    res.status(500).json({ success: false, error: err.message || "Failed to generate PDF" });
  }
});

/**
 * POST - Generate PDFs for all reports without PDFs
 */
router.post("/admin/scoi/reports/generate-all-pdfs", ensureAuth, async (req, res) => {
  try {
    const noPdfQuery = {
      $or: [
        { pdfUrl: { $exists: false } },
        { pdfUrl: null },
        { pdfUrl: "" }
      ]
    };

    const placementNoPdf = await PlacementAudit.find(noPdfQuery);
    const specialNoPdf   = await SpecialScoiAudit.find(noPdfQuery);
    const allAudits      = [...placementNoPdf, ...specialNoPdf];

    if (allAudits.length === 0) {
      return res.json({ success: true, message: "All reports already have PDFs", generated: 0 });
    }

    console.log(`[Bulk PDF] Generating for ${allAudits.length} reports…`);

    let generated = 0, failed = 0;

    for (const audit of allAudits) {
      try {
        const pdf = await generateScoiPdf({ audit, req });
        audit.pdfUrl = pdf.url;
        await audit.save();
        generated++;
        console.log(`[Bulk PDF] ✅ ${audit.subject?.name}`);
      } catch (err) {
        failed++;
        console.error(`[Bulk PDF] ❌ ${audit.subject?.name}`, err.message);
      }
    }

    res.json({ success: true, generated, failed });
  } catch (err) {
    console.error("[Bulk PDF error]", err);
    res.status(500).json({ success: false, error: err.message || "Failed to generate PDFs" });
  }
});

/**
 * DELETE - Delete SCOI report
 */
router.delete("/admin/scoi/reports/:id", ensureAuth, async (req, res) => {
  try {
    let deleted = await PlacementAudit.findByIdAndDelete(req.params.id);
    if (!deleted) deleted = await SpecialScoiAudit.findByIdAndDelete(req.params.id);

    if (!deleted) {
      return res.status(404).json({ success: false, error: "Report not found" });
    }

    // Clean up PDF file if it exists
    if (deleted.pdfUrl) {
      const pdfPath = path.join(process.cwd(), "public", deleted.pdfUrl);
      fs.unlink(pdfPath, () => {});
    }

    return res.json({ success: true });
  } catch (err) {
    console.error("[delete scoi report]", err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET - Download PDF directly (streams the file as an attachment)
 * FIX: Uses res.download() / stream instead of res.redirect() so the
 *      browser always triggers a file save rather than trying to navigate.
 */
router.get("/scoi/audits/:id/download", async (req, res) => {
  try {
    let audit = await PlacementAudit.findById(req.params.id);
    if (!audit) audit = await SpecialScoiAudit.findById(req.params.id);

    if (!audit) {
      return res.status(404).send("Report not found");
    }

    // Generate if missing
    if (!audit.pdfUrl) {
      console.log(`[Download] Generating PDF on-demand for: ${audit._id}`);
      const pdf = await generateScoiPdf({ audit, req });
      audit.pdfUrl = pdf.url;
      await audit.save();
    }

    // Build absolute filesystem path from the stored relative URL
    // pdfUrl is like "/docs/scoi-audits/scoi-xxx.pdf"
    const filePath = path.join(process.cwd(), "public", audit.pdfUrl);

    if (!fs.existsSync(filePath)) {
      // File missing on disk - regenerate
      console.warn(`[Download] PDF file missing on disk, regenerating: ${filePath}`);
      const pdf = await generateScoiPdf({ audit, req });
      audit.pdfUrl = pdf.url;
      await audit.save();
      const newPath = path.join(process.cwd(), "public", audit.pdfUrl);
      const safeFilename = `SCOI-Report-${(audit.subject?.name || String(audit._id)).replace(/[^a-zA-Z0-9-_]/g, "-")}.pdf`;
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename="${safeFilename}"`);
      return fs.createReadStream(newPath).pipe(res);
    }

    const safeFilename = `SCOI-Report-${(audit.subject?.name || String(audit._id)).replace(/[^a-zA-Z0-9-_]/g, "-")}.pdf`;
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${safeFilename}"`);
    return fs.createReadStream(filePath).pipe(res);

  } catch (err) {
    console.error("[PDF download error]", err);
    res.status(500).send(`Failed to download PDF: ${err.message}`);
  }
});

/**
 * GET - View audit (for purchased users)
 */
router.get("/scoi/audits/:id/view", async (req, res) => {
  try {
    let audit = await PlacementAudit.findById(req.params.id).lean();
    if (!audit) audit = await SpecialScoiAudit.findById(req.params.id).lean();

    if (!audit) {
      return res.status(404).send("Report not found");
    }

    // TODO: Add purchase verification
    // const purchase = await AuditPurchase.findOne({ userId: req.user._id, auditId: audit._id });
    // if (!purchase) return res.status(403).send("Not purchased");

    res.render("scoi/audit_view", {
      audit,
      user: req.user,
      layout: false
    });
  } catch (err) {
    console.error("[audit view error]", err);
    res.status(500).send("Failed to load report");
  }
});

export default router;