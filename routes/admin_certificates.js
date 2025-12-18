import express from "express";
import Certificate from "../models/certificate.js";
import User from "../models/user.js";
import Organization from "../models/organization.js";
import { ensureAuth } from "../middleware/authGuard.js";
import path from "path";
import fs from "fs";
import { generateCertificatePdf } from "../routes/lms_api.js"; // 👈 export it (next step)



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
    certs,
      user: req.user,
    isAdmin: true
  });
});

/**
 * Download certificate as JSON (simple + safe)
 */
router.get("/admin/certificates/:id/download", ensureAuth, async (req, res) => {
  const cert = await Certificate.findById(req.params.id)
    //.populate("userId", "name email")
    .populate("userId", "displayName firstName lastName email")
    .populate("orgId", "name slug")
    .lean();

  if (!cert) return res.status(404).send("Certificate not found");

  res.setHeader(
    "Content-Disposition",
    `attachment; filename=${cert.serial}.json`
  );
  res.json(cert);
});


/**
 * Download certificate as PDF (ADMIN)
 */
router.get(
  "/admin/certificates/:id/download/pdf",
  ensureAuth,
  async (req, res) => {
    const cert = await Certificate.findById(req.params.id)
      //.populate("userId", "name email")
      .populate("userId", "displayName firstName lastName email")
      .populate("orgId", "name slug")
      .lean();

    if (!cert) return res.status(404).send("Certificate not found");

    /*const recipientName =
      cert.userId?.name || cert.userId?.email || "Learner";*/

const recipientName =
  cert.userId?.displayName ||
  [cert.userId?.firstName, cert.userId?.lastName]
    .filter(Boolean)
    .join(" ") ||
  cert.userId?.email ||
  "Learner";



    const orgName = cert.orgId?.name || "Organization";

    // 🔁 REGENERATE PDF FROM DB DATA
    const result = await generateCertificatePdf({
      name: recipientName,
      orgName,
      moduleName: cert.moduleName,
      quizTitle: cert.quizTitle,
      score: cert.score,
      percentage: cert.percentage,
      date: cert.issuedAt,
      req,
    });

    if (!result || !result.filepath) {
      return res.status(500).send("Failed to generate certificate PDF");
    }

    res.download(
      result.filepath,
      `${cert.serial}.pdf`,
      (err) => {
        if (err) {
          console.error("PDF download error:", err);
        }

        // 🧹 Optional cleanup (recommended)
        fs.unlink(result.filepath, () => {});
      }
    );
  }
);


export default router;
