import { Router } from "express";
import SpecialScoiAudit from "../models/specialScoiAudit.js";
import { ensureAuth } from "../middleware/authGuard.js";

const router = Router();

/**
 * LIST — Special SCOI Audits
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
 * VIEW — Single Special SCOI Audit
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
        title: `Special SCOI Audit – ${audit.subject?.name || "Report"}`,
        audit,
        layout: "main"
      });
    } catch (err) {
      console.error("[special scoi view]", err);
      res.status(500).send("Failed to load special SCOI audit");
    }
  }
);

export default router;
