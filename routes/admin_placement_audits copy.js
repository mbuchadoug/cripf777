import { Router } from "express";
import PlacementAudit from "../models/placementAudit.js";
import { ensureAuth } from "../middleware/authGuard.js";

const router = Router();

/**
 * GET /admin/placement-audits
 * List all placement SCOI audits
 */
router.get("/admin/placement-audits", ensureAuth, async (req, res) => {
  try {
    const audits = await PlacementAudit.find({})
      .sort({ "assessmentWindow.from": -1, createdAt: -1 })
      .lean();

    res.render("admin/placement_audits_list", {
      audits
    });
  } catch (err) {
    console.error("[placement list] error:", err);
    res.status(500).send("Failed to load placement audits");
  }
});



router.get(
  "/admin/placement-audits/:id",
  ensureAuth,
  async (req, res) => {
    try {
      const audit = await PlacementAudit.findById(req.params.id).lean();
      if (!audit) return res.status(404).send("Audit not found");

      res.render("admin/placement_audit_view", {
        audit
      });
    } catch (err) {
      console.error("[placement audit view]", err);
      res.status(500).send("Failed to load audit");
    }
  }
);



export default router;
