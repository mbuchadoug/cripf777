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
  "/admin/special-scoi-audits",
  ensureAuth,
  async (req, res) => {
    const audits = await SpecialScoiAudit.find({})
      .sort({ createdAt: -1 })
      .lean();

    res.render("admin/special_scoi_list", { audits });
  }
);

/* ─────────────────────────────────────────────
   GET — Import Special SCOI Page
───────────────────────────────────────────── */
router.get(
  "/admin/special-scoi-import",
  ensureAuth,
  (req, res) => {
    res.render("admin/special_scoi_import", {
      title: "Import Special SCOI Audit",
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
        return res.render("admin/special_scoi_import", {
          error: "No file uploaded"
        });
      }

      const raw = req.file.buffer.toString("utf8");
      const parsed = JSON.parse(raw);

      // ✅ Support single object OR array
      const audits = Array.isArray(parsed) ? parsed : [parsed];

      let imported = 0;
      let skipped = 0;

      for (const audit of audits) {

        // 🔐 Minimal, correct validation for SPECIAL SCOI
        if (!audit.auditType || !audit.subject?.name || !audit.purpose) {
          skipped++;
          continue;
        }

        const exists = await SpecialScoiAudit.findOne({
          "subject.name": audit.subject.name,
          auditType: audit.auditType
        });

        if (exists) {
          skipped++;
          continue;
        }

        await SpecialScoiAudit.create({
          framework: "CRIPFCnt SCOI",
          auditClass: "special_report",
          price: 29900,
          isPaid: false,
          ...audit
        });

        imported++;
      }

      return res.render("admin/special_scoi_import", {
        success: `Imported ${imported} Special SCOI Audit(s). Skipped ${skipped}.`
      });

    } catch (err) {
      console.error("[special scoi import]", err);
      return res.render("admin/special_scoi_import", {
        error: err.message || "Import failed"
      });
    }
  }
);
///////////////////////////////


router.get(
  "/admin/special-scoi-audits/:id",
  ensureAuth,
  async (req, res) => {
    const audit = await SpecialScoiAudit.findById(req.params.id).lean();
    if (!audit) return res.status(404).send("Not found");

    res.render("admin/special_scoi_view", {
      audit,
      layout: false
    });
  }
);

export default router;
