// routes/mobilePush.js - device registers its Expo push token here. Mount at /api/mobile/push.
import express, { Router } from "express";
import PushToken from "../models/pushToken.js";
import { requireMobileAuth } from "./mobileApi.js";

const router = Router();
router.use(express.json({ limit: "64kb" }));

router.post("/register", requireMobileAuth, async (req, res) => {
  try {
    const token = String(req.body?.token || "").trim();
    if (!token) return res.status(400).json({ error: "No token." });
    const platform = ["ios", "android", "web"].includes(req.body?.platform) ? req.body.platform : "android";
    await PushToken.updateOne(
      { user: req.mobileUser._id, token },
      { $set: { platform, active: true } },
      { upsert: true }
    );
    res.json({ ok: true });
  } catch (e) { console.error("[push register]", e); res.status(500).json({ error: "Failed" }); }
});

router.post("/unregister", requireMobileAuth, async (req, res) => {
  try {
    const token = String(req.body?.token || "").trim();
    if (token) await PushToken.updateOne({ user: req.mobileUser._id, token }, { $set: { active: false } });
    res.json({ ok: true });
  } catch (e) { console.error("[push unregister]", e); res.status(500).json({ error: "Failed" }); }
});

export default router;