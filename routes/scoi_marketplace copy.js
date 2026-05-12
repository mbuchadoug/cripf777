import { Router } from "express";
import PlacementAudit from "../models/placementAudit.js";
import SpecialScoiAudit from "../models/specialScoiAudit.js";

const router = Router();

router.get("/scoi", async (req, res) => {
  try {
    // Fetch both audit types
    const placementAudits = await PlacementAudit.find({
      status: "archived_reference"
    }).sort({ "assessmentWindow.label": -1 }).lean();

    const specialAudits = await SpecialScoiAudit.find({
      isPaid: false
    }).sort({ createdAt: -1 }).lean();

    // Normalize data structure
    const normalizedPlacement = placementAudits.map(a => ({
      ...a,
      displayPrice: 149,
      auditKind: "placement"
    }));

    const normalizedSpecial = specialAudits.map(a => ({
      ...a,
      assessmentWindow: {
        label: a.assessmentWindow?.label || "Special Audit"
      },
      displayPrice: 299,
      auditKind: "special"
    }));

    // Combine and sort
    const audits = [...normalizedSpecial, ...normalizedPlacement];

    res.render("scoi/marketplace", {
      user: req.user || null,
      audits,
      pageTitle: "SCOI Intelligence Marketplace"
    });
  } catch (err) {
    console.error("[SCOI marketplace]", err);
    res.status(500).send("Failed to load marketplace");
  }
});

export default router;