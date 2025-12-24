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

export default router;
