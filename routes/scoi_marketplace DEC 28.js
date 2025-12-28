// routes/scoi_marketplace.js
import { Router } from "express";
import PlacementAudit from "../models/placementAudit.js";

const router = Router();

router.get("/scoi", async (req, res) => {
  try {
    const audits = await PlacementAudit.find({
      status: "archived_reference"
    })
      .sort({ "assessmentWindow.label": -1 })
      .lean();

    res.render("scoi/marketplace", {
      user: req.user || null,
      audits,
      price: 149
    });
  } catch (err) {
    console.error("[SCOI marketplace]", err);
    res.status(500).send("Failed to load SCOI marketplace");
  }
});

export default router;
