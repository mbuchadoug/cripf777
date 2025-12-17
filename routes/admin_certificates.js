import express from "express";
import Certificate from "../models/certificate.js";
import User from "../models/user.js";
import Organization from "../models/organization.js";
import { ensureAuth } from "../middleware/authGuard.js";

const router = express.Router();

/**
 * View all certificates
 */
router.get("/admin/certificates", ensureAuth, async (req, res) => {
  const certs = await Certificate.find()
    .sort({ issuedAt: -1 })
    .populate("userId", "name email")
    .populate("orgId", "name slug")
    .lean();

  res.render("admin/certificates", {
    title: "Certificates",
    certs
  });
});

/**
 * Download certificate as JSON (simple + safe)
 */
router.get("/admin/certificates/:id/download", ensureAuth, async (req, res) => {
  const cert = await Certificate.findById(req.params.id)
    .populate("userId", "name email")
    .populate("orgId", "name slug")
    .lean();

  if (!cert) return res.status(404).send("Certificate not found");

  res.setHeader(
    "Content-Disposition",
    `attachment; filename=${cert.serial}.json`
  );
  res.json(cert);
});

export default router;
