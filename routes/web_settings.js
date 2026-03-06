import express from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import { requireWebAuth } from "../middleware/webAuth.js";
import Business from "../models/business.js";

const router = express.Router();

// ── Logo upload storage ──────────────────────────────────────────────────────
const logoStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(process.cwd(), "public", "logos");
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `logo_${req.webUser.businessId}_${Date.now()}${ext}`);
  }
});

const upload = multer({
  storage: logoStorage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = [".jpg", ".jpeg", ".png", ".webp"];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) cb(null, true);
    else cb(new Error("Only JPG, PNG or WebP images allowed"));
  }
});

// ── GET /web/settings ────────────────────────────────────────────────────────
router.get("/settings", requireWebAuth, async (req, res) => {
  try {
    const business = await Business.findById(req.webUser.businessId).lean();
    if (!business) return res.redirect("/web/dashboard");

    res.render("web/settings", {
      layout: "web",
      pageTitle: "Settings",
      pageKey: "settings",
      user: req.webUser,
      business,
      saved: req.query.saved || null,
      error: req.query.error || null
    });
  } catch (err) {
    console.error("Settings GET error:", err);
    res.redirect("/web/dashboard");
  }
});

// ── POST /web/settings/general ───────────────────────────────────────────────
// Fields: name, currency, address, paymentTermsDays
router.post("/settings/general", requireWebAuth, async (req, res) => {
  try {
    const { name, currency, address, paymentTermsDays } = req.body;

    const allowed = ["USD", "ZWL", "ZAR", "ZIG", "GBP", "EUR"];
    const cur = (currency || "").toUpperCase().trim();
    if (!allowed.includes(cur)) {
      return res.redirect("/web/settings?error=invalid_currency");
    }

    await Business.findByIdAndUpdate(req.webUser.businessId, {
      name:            (name || "").trim(),
      currency:        cur,
      address:         (address || "").trim(),
      paymentTermsDays: Math.max(0, parseInt(paymentTermsDays) || 0)
    });

    res.redirect("/web/settings?saved=general");
  } catch (err) {
    console.error("Settings general error:", err);
    res.redirect("/web/settings?error=save_failed");
  }
});

// ── POST /web/settings/prefixes ──────────────────────────────────────────────
// Fields: invoicePrefix, quotePrefix, receiptPrefix
router.post("/settings/prefixes", requireWebAuth, async (req, res) => {
  try {
    const { invoicePrefix, quotePrefix, receiptPrefix } = req.body;

    await Business.findByIdAndUpdate(req.webUser.businessId, {
      invoicePrefix:  (invoicePrefix || "INV").trim().toUpperCase().slice(0, 6),
      quotePrefix:    (quotePrefix   || "QT").trim().toUpperCase().slice(0, 6),
      receiptPrefix:  (receiptPrefix || "RCP").trim().toUpperCase().slice(0, 6)
    });

    res.redirect("/web/settings?saved=prefixes");
  } catch (err) {
    console.error("Settings prefixes error:", err);
    res.redirect("/web/settings?error=save_failed");
  }
});

// ── POST /web/settings/logo ──────────────────────────────────────────────────
router.post("/settings/logo", requireWebAuth, upload.single("logo"), async (req, res) => {
  try {
    if (!req.file) return res.redirect("/web/settings?error=no_file");

    const siteUrl = (process.env.SITE_URL || "").replace(/\/$/, "");
    const logoUrl = `${siteUrl}/logos/${req.file.filename}`;

    await Business.findByIdAndUpdate(req.webUser.businessId, { logoUrl });

    res.redirect("/web/settings?saved=logo");
  } catch (err) {
    console.error("Settings logo error:", err);
    res.redirect("/web/settings?error=upload_failed");
  }
});

// ── POST /web/settings/logo/remove ──────────────────────────────────────────
router.post("/settings/logo/remove", requireWebAuth, async (req, res) => {
  try {
    const business = await Business.findById(req.webUser.businessId);
    if (business?.logoUrl) {
      const filename = path.basename(business.logoUrl);
      const localPath = path.join(process.cwd(), "public", "logos", filename);
      if (fs.existsSync(localPath)) fs.unlinkSync(localPath);
    }
    await Business.findByIdAndUpdate(req.webUser.businessId, { logoUrl: null });
    res.redirect("/web/settings?saved=logo");
  } catch (err) {
    console.error("Settings logo remove error:", err);
    res.redirect("/web/settings?error=remove_failed");
  }
});

export default router;