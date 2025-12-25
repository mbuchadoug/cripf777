import { Router } from "express";
import PlacementAudit from "../models/placementAudit.js";
import { ensureAuth } from "../middleware/authGuard.js";

const router = Router();

router.get("/scoi/audits/:id/download", ensureAuth, async (req, res) => {
  const audit = await PlacementAudit.findById(req.params.id).lean();

  if (!audit || !audit.isPaid || !audit.pdfUrl) {
    return res.status(403).send("Audit not available");
  }

  return res.redirect(audit.pdfUrl);
});


router.get("/scoi/audits/:id/view", ensureAuth, async (req, res) => {
  const audit = await PlacementAudit.findById(req.params.id).lean();

  if (!audit || !audit.isPaid) {
    return res.status(403).send("Audit not available");
  }

  res.render("admin/placement_audit_view", {
    audit,
    layout: false // 🔑 important for clean viewing & printing
  });
});


export default router;
