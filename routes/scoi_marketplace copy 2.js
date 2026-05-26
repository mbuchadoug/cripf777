// routes/scoi_marketplace.js
// Default sort: newest uploaded first (special by createdAt desc, placement by createdAt desc)

import { Router } from "express";
import PlacementAudit from "../models/placementAudit.js";
import SpecialScoiAudit from "../models/specialScoiAudit.js";

const router = Router();

router.get("/scoi", async (req, res) => {
  try {
    // ── Fetch both types, newest first ──────────────────────────
    const placementAudits = await PlacementAudit.find({
      status: "archived_reference"
    })
      .sort({ createdAt: -1 })   // newest uploaded first
      .lean();

    const specialAudits = await SpecialScoiAudit.find({
      isPaid: false
    })
      .sort({ createdAt: -1 })   // newest uploaded first
      .lean();

    // ── Normalize ────────────────────────────────────────────────
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

    // ── Merge: special first, then placement, both newest-first ──
    // If you want a single interleaved newest-first list across both types,
    // use the merge below instead.
    //
    // Option A - special block first, then placement block (current):
    const audits = [...normalizedSpecial, ...normalizedPlacement];
    //
    // Option B - true interleaved newest-first (uncomment to use):
    // const audits = [...normalizedSpecial, ...normalizedPlacement].sort(
    //   (a, b) => new Date(b.createdAt) - new Date(a.createdAt)
    // );

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