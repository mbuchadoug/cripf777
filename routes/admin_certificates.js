import { Router } from "express";
import fs from "fs";
import path from "path";
import archiver from "archiver";

import Certificate from "../models/certificate.js";
import { ensureAuth } from "../middleware/authGuard.js";

const router = Router();

/* ------------------------------------------------ */
/*  ADMIN: Download ALL certificates as ZIP         */
/*  GET /admin/certificates/download-all            */
/* ------------------------------------------------ */
router.get(
  "/admin/certificates/download-all",
  ensureAuth,
  async (req, res) => {
    try {
      // OPTIONAL: restrict to platform admins
      const admins = (process.env.ADMIN_EMAILS || "")
        .split(",")
        .map(e => e.trim().toLowerCase())
        .filter(Boolean);

      if (!admins.includes((req.user?.email || "").toLowerCase())) {
        return res.status(403).send("Admins only");
      }

      const certificates = await Certificate.find().lean();
      if (!certificates.length) {
        return res.status(404).send("No certificates found");
      }

      res.setHeader("Content-Type", "application/zip");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="certificates_${Date.now()}.zip"`
      );

      const archive = archiver("zip", { zlib: { level: 9 } });
      archive.pipe(res);

      for (const cert of certificates) {
        if (!cert.pdfPath) continue;

        const fullPath = path.resolve(cert.pdfPath);
        if (!fs.existsSync(fullPath)) continue;

        const filename =
          cert.serial
            ? `certificate_${cert.serial}.pdf`
            : path.basename(fullPath);

        archive.file(fullPath, { name: filename });
      }

      await archive.finalize();
    } catch (err) {
      console.error("[DOWNLOAD CERTIFICATES] error:", err);
      return res.status(500).send("Failed to download certificates");
    }
  }
);

export default router;
