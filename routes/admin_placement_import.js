import { Router } from "express";
import multer from "multer";
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
// Shared import logic - accepts parsed array
// ─────────────────────────────────────────────
async function runPlacementImport(audits) {
  if (!Array.isArray(audits)) {
    throw new Error("JSON must be an array of audits");
  }

  let imported = 0;
  let skipped  = 0;

  for (const audit of audits) {
    if (!audit.subject?.name || !audit.assessmentWindow?.label) {
      skipped++;
      continue;
    }

    const exists = await PlacementAudit.findOne({
      "subject.name":           audit.subject.name,
      "assessmentWindow.label": audit.assessmentWindow.label
    });

    if (exists) {
      skipped++;
      continue;
    }

    await PlacementAudit.create({
      auditType: "placement",
      matrix:    "dual",
      ...audit
    });

    imported++;
  }

  return { imported, skipped };
}

// ─────────────────────────────────────────────
// GET - Import page
// ─────────────────────────────────────────────
router.get(
  "/admin/placement-import",
  ensureAuth,
  (req, res) => {
    res.render("admin/placement_import", {
      title: "Import Placement SCOI Audits",
      user:  req.user
    });
  }
);

// ─────────────────────────────────────────────
// POST - Import via file upload OR pasted JSON
//
// How it works:
//   1. multer runs - if a file was sent it populates req.file, otherwise no-op
//   2. We check req.file first (file upload path, unchanged behaviour)
//   3. If no file, we look for req.body.auditJson (the textarea input)
//   4. Both paths feed the same runPlacementImport() function
// ─────────────────────────────────────────────
router.post(
  "/admin/placement-import",
  ensureAuth,
  upload.single("auditFile"),   // multer is always present; harmless when no file sent
  async (req, res) => {
    const renderPage = (props) =>
      res.render("admin/placement_import", { user: req.user, ...props });

    try {
      let raw;

      if (req.file) {
        // ── Path A: file upload (original behaviour) ──
        raw = req.file.buffer.toString("utf8");
      } else if (req.body?.auditJson?.trim()) {
        // ── Path B: pasted JSON text ──
        raw = req.body.auditJson.trim();
      } else {
        return res.status(400).render("admin/placement_import", {
          error: "Please upload a JSON file or paste JSON text",
          user:  req.user
        });
      }

      let audits;
      try {
        const parsed = JSON.parse(raw);
        // Accept both a bare object (single audit) and an array
        audits = Array.isArray(parsed) ? parsed : [parsed];
      } catch (parseErr) {
        return renderPage({ error: `Invalid JSON: ${parseErr.message}` });
      }

      const { imported, skipped } = await runPlacementImport(audits);

      return renderPage({
        success: `Imported ${imported} audit${imported !== 1 ? "s" : ""}. Skipped ${skipped}.`
      });
    } catch (err) {
      console.error("[placement import]", err);
      return res.status(500).render("admin/placement_import", {
        error: err.message || "Import failed",
        user:  req.user
      });
    }
  }
);

export default router;