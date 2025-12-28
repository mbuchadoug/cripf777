// routes/scoi_marketplace.js
import { Router } from "express";
import PlacementAudit from "../models/placementAudit.js";
import SpecialScoiAudit from "../models/specialScoiAudit.js";

const router = Router();

router.get("/scoi", async (req, res) => {
  try {
    /* ─────────────────────────────────────────
       1️⃣ Load archived PLACEMENT audits
    ───────────────────────────────────────── */
    const placementAudits = await PlacementAudit.find({
      status: "archived_reference"
    })
      .sort({ "assessmentWindow.label": -1 })
      .lean();

    /* ─────────────────────────────────────────
       2️⃣ Load SPECIAL SCOI audits (sellable)
       Only unpaid → marketplace items
    ───────────────────────────────────────── */
    const specialAudits = await SpecialScoiAudit.find({
      isPaid: false
    })
      .sort({ createdAt: -1 })
      .lean();

    /* ─────────────────────────────────────────
       3️⃣ Normalize for marketplace view
       (so the SAME template works)
    ───────────────────────────────────────── */
    const normalizedSpecial = specialAudits.map(a => ({
      ...a,
      assessmentWindow: {
        label: a.assessmentWindow?.label || "Special Audit"
      }
    }));

    /* ─────────────────────────────────────────
       4️⃣ Merge both
    ───────────────────────────────────────── */
    const audits = [
      ...normalizedSpecial,
      ...placementAudits
    ];

    res.render("scoi/marketplace", {
      user: req.user || null,
      audits,
      price: 149   // UI price remains unchanged (as requested)
    });

  } catch (err) {
    console.error("[SCOI marketplace]", err);
    res.status(500).send("Failed to load SCOI marketplace");
  }
});

export default router;
