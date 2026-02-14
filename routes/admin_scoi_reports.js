// routes/admin_scoi_reports.js - ADMIN SCOI REPORTS MANAGEMENT

import { Router } from "express";
import PlacementAudit from "../models/placementAudit.js";
import SpecialScoiAudit from "../models/specialScoiAudit.js";
import { ensureAuth } from "../middleware/authGuard.js";
import { generateScoiPdf } from "../utils/generateScoiPdf.js";

const router = Router();

/**
 * GET - List all SCOI reports (admin view)
 */
router.get("/admin/scoi/reports", ensureAuth, async (req, res) => {
  try {
    // Fetch both types of audits
    const placementAudits = await PlacementAudit.find({})
      .sort({ "assessmentWindow.label": -1 })
      .lean();

    const specialAudits = await SpecialScoiAudit.find({})
      .sort({ createdAt: -1 })
      .lean();

    // Normalize data
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

    // Combine
    const reports = [...normalizedSpecial, ...normalizedPlacement];

    // Calculate stats
    const stats = {
      total: reports.length,
      placement: normalizedPlacement.length,
      special: normalizedSpecial.length,
      withPdf: reports.filter(r => r.pdfUrl).length
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
    // Try placement first
    let audit = await PlacementAudit.findById(req.params.id).lean();
    
    // Try special if not found
    if (!audit) {
      audit = await SpecialScoiAudit.findById(req.params.id).lean();
    }

    if (!audit) {
      return res.status(404).send("Report not found");
    }

    res.render("scoi/audit_view", {
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
    // Try placement first
    let audit = await PlacementAudit.findById(req.params.id);
    let Model = PlacementAudit;
    
    // Try special if not found
    if (!audit) {
      audit = await SpecialScoiAudit.findById(req.params.id);
      Model = SpecialScoiAudit;
    }

    if (!audit) {
      return res.status(404).json({ 
        success: false, 
        error: "Report not found" 
      });
    }

    // Check if PDF already exists
    if (audit.pdfUrl) {
      return res.json({ 
        success: true, 
        message: "PDF already exists",
        pdfUrl: audit.pdfUrl 
      });
    }

    // Generate PDF
    console.log(`[PDF Generation] Generating PDF for audit: ${audit._id}`);
    const pdf = await generateScoiPdf(audit);

    // Update audit with PDF URL
    audit.pdfUrl = pdf.url;
    await audit.save();

    console.log(`[PDF Generation] ✅ PDF generated: ${pdf.url}`);

    res.json({ 
      success: true, 
      message: "PDF generated successfully",
      pdfUrl: pdf.url 
    });
  } catch (err) {
    console.error("[PDF generation error]", err);
    res.status(500).json({ 
      success: false, 
      error: err.message || "Failed to generate PDF" 
    });
  }
});

/**
 * POST - Generate PDFs for all reports without PDFs
 */
router.post("/admin/scoi/reports/generate-all-pdfs", ensureAuth, async (req, res) => {
  try {
    // Find all audits without PDFs
    const placementAuditsNoPdf = await PlacementAudit.find({
      $or: [
        { pdfUrl: { $exists: false } },
        { pdfUrl: null },
        { pdfUrl: "" }
      ]
    });

    const specialAuditsNoPdf = await SpecialScoiAudit.find({
      $or: [
        { pdfUrl: { $exists: false } },
        { pdfUrl: null },
        { pdfUrl: "" }
      ]
    });

    const allAudits = [...placementAuditsNoPdf, ...specialAuditsNoPdf];

    if (allAudits.length === 0) {
      return res.json({ 
        success: true, 
        message: "All reports already have PDFs",
        generated: 0 
      });
    }

    console.log(`[Bulk PDF Generation] Generating PDFs for ${allAudits.length} reports...`);

    let generated = 0;
    let failed = 0;

    // Generate PDFs sequentially to avoid overwhelming the system
    for (const audit of allAudits) {
      try {
        const pdf = await generateScoiPdf(audit);
        audit.pdfUrl = pdf.url;
        await audit.save();
        generated++;
        console.log(`[Bulk PDF] ✅ Generated: ${audit.subject.name}`);
      } catch (err) {
        failed++;
        console.error(`[Bulk PDF] ❌ Failed: ${audit.subject.name}`, err.message);
      }
    }

    console.log(`[Bulk PDF Generation] Complete: ${generated} generated, ${failed} failed`);

    res.json({ 
      success: true, 
      message: `Generated ${generated} PDFs`,
      generated,
      failed 
    });
  } catch (err) {
    console.error("[Bulk PDF generation error]", err);
    res.status(500).json({ 
      success: false, 
      error: err.message || "Failed to generate PDFs" 
    });
  }
});

/**
 * GET - Download PDF directly
 */
router.get("/scoi/audits/:id/download", async (req, res) => {
  try {
    // Try placement first
    let audit = await PlacementAudit.findById(req.params.id);
    
    // Try special if not found
    if (!audit) {
      audit = await SpecialScoiAudit.findById(req.params.id);
    }

    if (!audit) {
      return res.status(404).send("Report not found");
    }

    // Generate PDF if it doesn't exist
    if (!audit.pdfUrl) {
      console.log(`[Download] Generating PDF on-demand for: ${audit._id}`);
      const pdf = await generateScoiPdf(audit);
      audit.pdfUrl = pdf.url;
      await audit.save();
    }

    // Redirect to PDF file
    res.redirect(audit.pdfUrl);
  } catch (err) {
    console.error("[PDF download error]", err);
    res.status(500).send("Failed to download PDF");
  }
});

/**
 * GET - View audit (for purchased users)
 */
router.get("/scoi/audits/:id/view", async (req, res) => {
  try {
    // Try placement first
    let audit = await PlacementAudit.findById(req.params.id).lean();
    
    // Try special if not found
    if (!audit) {
      audit = await SpecialScoiAudit.findById(req.params.id).lean();
    }

    if (!audit) {
      return res.status(404).send("Report not found");
    }

    // TODO: Add purchase verification here
    // const purchase = await AuditPurchase.findOne({
    //   userId: req.user._id,
    //   auditId: audit._id
    // });
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