import { Router } from "express";
import multer from "multer";
import PlacementAudit from "../models/placementAudit.js";
import SpecialScoiAudit from "../models/specialScoiAudit.js";
import { ensureAuth } from "../middleware/authGuard.js";

const router = Router();

// Multer config for JSON uploads
const upload = multer({
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter(req, file, cb) {
    if (!file.originalname.endsWith(".json")) {
      return cb(new Error("Only JSON files allowed"));
    }
    cb(null, true);
  }
});

// Import page
router.get("/admin/scoi/import", ensureAuth, (req, res) => {
  res.render("admin/scoi_import_redesigned", {
    title: "Import SCOI Reports",
    user: req.user
  });
});

// Handle import
router.post(
  "/admin/scoi/import",
  ensureAuth,
  upload.single("auditFile"),
  async (req, res) => {
    try {
      if (!req.file) {
        return res.render("admin/scoi_import_redesigned", {
          error: "No file uploaded",
          user: req.user
        });
      }

      const { auditType } = req.body; // 'placement' or 'special'
      const raw = req.file.buffer.toString("utf8");
      const data = JSON.parse(raw);

      // Support single object or array
      const audits = Array.isArray(data) ? data : [data];

      let imported = 0;
      let skipped = 0;

      for (const audit of audits) {
        // Validate required fields
        if (!audit.subject?.name || !audit.purpose) {
          skipped++;
          continue;
        }

        // Check for duplicates
        const Model = auditType === 'special' ? SpecialScoiAudit : PlacementAudit;
        const exists = await Model.findOne({
          "subject.name": audit.subject.name,
          "assessmentWindow.label": audit.assessmentWindow?.label
        });

        if (exists) {
          skipped++;
          continue;
        }

        // Create audit
        await Model.create({
          framework: "CRIPFCnt SCOI",
          ...audit
        });

        imported++;
      }

      return res.render("admin/scoi_import_redesigned", {
        success: `✅ Imported ${imported} reports. Skipped ${skipped} duplicates.`,
        user: req.user
      });

    } catch (err) {
      console.error("[SCOI import]", err);
      return res.render("admin/scoi_import_redesigned", {
        error: err.message || "Import failed",
        user: req.user
      });
    }
  }
);

export default router;