import { Router } from "express";
import multer from "multer";
import fs from "fs";
import PlacementAudit from "../models/placementAudit.js";
import { ensureAuth } from "../middleware/authGuard.js";

const router = Router();

// ─────────────────────────────────────────────
// Multer (memory-safe JSON upload)
// ─────────────────────────────────────────────
const upload = multer({
  limits: { fileSize: 2 * 1024 * 1024 }, // 2MB
  fileFilter(req, file, cb) {
    if (!file.originalname.endsWith(".json")) {
      return cb(new Error("Only JSON files allowed"));
    }
    cb(null, true);
  }
});

// ─────────────────────────────────────────────
// GET — Import page
// ─────────────────────────────────────────────
router.get(
  "/admin/placement-import",
  ensureAuth,
  (req, res) => {
    res.render("admin/placement_import", {
      title: "Import Placement SCOI Audits",
      user: req.user
    });
  }
);

// ─────────────────────────────────────────────
// POST — Import JSON
// ─────────────────────────────────────────────
router.post(
  "/admin/placement-import",
  ensureAuth,
  upload.single("auditFile"),
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).render("admin/placement_import", {
          error: "No file uploaded"
        });
      }

      const raw = req.file.buffer.toString("utf8");
      const audits = JSON.parse(raw);

      if (!Array.isArray(audits)) {
        throw new Error("JSON must be an array of audits");
      }

      let imported = 0;
      let skipped = 0;

      for (const audit of audits) {
        if (!audit.subject?.name || !audit.assessmentWindow?.label) {
          skipped++;
          continue;
        }

        const exists = await PlacementAudit.findOne({
          "subject.name": audit.subject.name,
          "assessmentWindow.label": audit.assessmentWindow.label
        });

        if (exists) {
          skipped++;
          continue;
        }

        await PlacementAudit.create({
          auditType: "placement",
          matrix: "dual",
          ...audit
        });

        imported++;
      }

      return res.render("admin/placement_import", {
        success: `Imported ${imported} audits. Skipped ${skipped}.`
      });
    } catch (err) {
      console.error("[placement import]", err);
      return res.status(500).render("admin/placement_import", {
        error: err.message || "Import failed"
      });
    }
  }
);

export default router;
