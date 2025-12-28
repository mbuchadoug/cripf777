import { Router } from "express";
import multer from "multer";
import SpecialScoiAudit from "../models/specialScoiAudit.js";
import { ensureAuth } from "../middleware/authGuard.js";

const router = Router();

/* ─────────────────────────────────────────────
   Multer config (JSON only, memory-safe)
───────────────────────────────────────────── */
const upload = multer({
  limits: { fileSize: 3 * 1024 * 1024 }, // 3MB
  fileFilter(req, file, cb) {
    if (!file.originalname.endsWith(".json")) {
      return cb(new Error("Only JSON files allowed"));
    }
    cb(null, true);
  }
});

/* ─────────────────────────────────────────────
   GET — Admin Import Page
───────────────────────────────────────────── */
router.get(
  "/admin/special-scoi-import",
  ensureAuth,
  (req, res) => {
    res.render("admin/special_scoi_import", {
      title: "Import Special SCOI Audit Report",
      user: req.user
    });
  }
);

/* ─────────────────────────────────────────────
   POST — Import Special SCOI JSON
───────────────────────────────────────────── */
router.post(
  "/admin/special-scoi-import",
  ensureAuth,
  upload.single("auditFile"),
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).render("admin/special_scoi_import", {
          error: "No file uploaded"
        });
      }

      const raw = req.file.buffer.toString("utf8");
      const audit = JSON.parse(raw);

      /* ─────────────── Validation ─────────────── */
      if (
        !audit.subject?.name ||
        !audit.auditType ||
        !audit.purpose
      ) {
        return res.status(400).render("admin/special_scoi_import", {
          error: "Invalid SCOI report structure (missing subject, auditType, or purpose)"
        });
      }

      /* ─────────────── Duplicate Guard ─────────────── */
      const exists = await SpecialScoiAudit.findOne({
        "subject.name": audit.subject.name,
        "assessmentWindow.label": audit.assessmentWindow?.label
      });

      if (exists) {
        return res.render("admin/special_scoi_import", {
          error: "This Special SCOI Audit already exists"
        });
      }

      /* ─────────────── Create Record ─────────────── */
      await SpecialScoiAudit.create({
        framework: "CRIPFCnt SCOI",
        auditClass: "special_report",
        price: 29900, // 🔒 Fixed premium price
        isPaid: false,
        ...audit
      });

      return res.render("admin/special_scoi_import", {
        success: "Special SCOI Audit Report imported successfully"
      });

    } catch (err) {
      console.error("[special scoi import]", err);
      return res.status(500).render("admin/special_scoi_import", {
        error: err.message || "Import failed"
      });
    }
  }
);

export default router;
