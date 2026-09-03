// ==============================
// 🌐 HOTSPOT API   (mounted at /hotspot/api)
// Everything the admin UI calls. JSON in, JSON out.
// ==============================

import { Router } from "express";
import crypto from "crypto";

import HotspotAdmin from "../models/hotspotAdmin.js";
import HotspotPlan from "../models/hotspotPlan.js";
import Voucher from "../models/voucher.js";
import BypassDevice from "../models/bypassDevice.js";
import * as mt from "../services/mikrotik.js";
import { signToken, authRequired, ownerRequired } from "../middleware/hotspotAuth.js";

const router = Router();

const WIFI_NAME = process.env.HOTSPOT_WIFI_NAME || "Lodge WiFi";
const CODE_PREFIX = (process.env.HOTSPOT_CODE_PREFIX || "").toUpperCase();

// Unambiguous alphabet - no 0/O/1/I/L to avoid customer typos.
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
function randomCode() {
  const pick = (n) =>
    Array.from({ length: n }, () => ALPHABET[crypto.randomInt(ALPHABET.length)]).join("");
  const body = `${pick(3)}-${pick(3)}`;
  return CODE_PREFIX ? `${CODE_PREFIX}-${body}` : body;
}

async function uniqueCode() {
  for (let i = 0; i < 12; i++) {
    const code = randomCode();
    const clash = await Voucher.exists({ code });
    if (!clash) return code;
  }
  return `${randomCode()}-${Date.now().toString(36).slice(-3).toUpperCase()}`;
}

// ============================================================
// 🔑 AUTH
// ============================================================
router.post("/auth/login", async (req, res) => {
  try {
    const { username, password } = req.body || {};
    const admin = await HotspotAdmin.findOne({ username: String(username || "").toLowerCase().trim() });
    if (!admin || !admin.active) return res.status(401).json({ error: "Wrong username or password" });
    const ok = await admin.verifyPassword(password);
    if (!ok) return res.status(401).json({ error: "Wrong username or password" });
    admin.lastLogin = new Date();
    await admin.save();
    res.json({
      token: signToken(admin),
      admin: { id: admin._id, name: admin.displayName, role: admin.role, username: admin.username }
    });
  } catch (err) {
    console.error("[hotspot login]", err);
    res.status(500).json({ error: "Login failed, try again" });
  }
});

router.get("/auth/me", authRequired, (req, res) => {
  const a = req.hsAdmin;
  res.json({ id: a._id, name: a.displayName, role: a.role, username: a.username });
});

// ============================================================
// 📦 PLANS
// ============================================================
router.get("/plans", authRequired, async (req, res) => {
  const plans = await HotspotPlan.find().sort({ sortOrder: 1, createdAt: 1 }).lean();
  res.json({ plans });
});

router.post("/plans", authRequired, ownerRequired, async (req, res) => {
  try {
    const b = req.body || {};
    const key = String(b.key || "").toLowerCase().replace(/[^a-z0-9]/g, "");
    if (!key) return res.status(400).json({ error: "Give the plan a short key (e.g. lunch2h)" });
    const doc = {
      key,
      label: b.label || key,
      durationType: b.durationType === "clock" ? "clock" : "uptime",
      durationMinutes: Math.max(1, Number(b.durationMinutes || 60)),
      deviceCap: Math.max(1, Number(b.deviceCap || 1)),
      downKbps: Math.max(0, Number(b.downKbps || 0)),
      upKbps: Math.max(0, Number(b.upKbps || 0)),
      price: Math.max(0, Number(b.price || 0)),
      currency: b.currency || "USD",
      active: b.active !== false,
      sortOrder: Number(b.sortOrder || 0)
    };
    const plan = await HotspotPlan.findOneAndUpdate({ key }, doc, { upsert: true, new: true, setDefaultsOnInsert: true });
    // Make sure the router profile exists (best effort).
    try { await mt.ensureProfile({ name: plan.rosProfile(), sharedUsers: plan.deviceCap, rateLimit: plan.rateLimitString() }); } catch { /* offline ok */ }
    res.json({ plan });
  } catch (err) {
    console.error("[hotspot plan]", err);
    res.status(500).json({ error: "Could not save plan" });
  }
});

// ============================================================
// 🎟️ VOUCHERS
// ============================================================

// Generate a batch.
router.post("/vouchers/generate", authRequired, async (req, res) => {
  try {
    const b = req.body || {};
    const count = Math.min(200, Math.max(1, Number(b.count || 1)));
    const plan = await HotspotPlan.findOne({ key: String(b.planKey || "").toLowerCase() });
    if (!plan) return res.status(400).json({ error: "Choose a valid plan" });

    const batchId = `B-${Date.now().toString(36).toUpperCase()}`;
    const admin = req.hsAdmin;
    const profileName = plan.rosProfile();

    // Ensure profile once for the whole batch.
    let routerOnline = true;
    try { await mt.ensureProfile({ name: profileName, sharedUsers: plan.deviceCap, rateLimit: plan.rateLimitString() }); }
    catch { routerOnline = false; }

    const made = [];
    for (let i = 0; i < count; i++) {
      const code = await uniqueCode();
      const v = new Voucher({
        code,
        planKey: plan.key,
        planLabel: plan.label,
        durationType: plan.durationType,
        durationMinutes: plan.durationMinutes,
        deviceCap: plan.deviceCap,
        downKbps: plan.downKbps,
        upKbps: plan.upKbps,
        batchId,
        createdBy: admin._id,
        createdByName: admin.displayName,
        price: b.price != null ? Number(b.price) : plan.price,
        currency: plan.currency,
        paymentMethod: ["cash", "ecocash", "complimentary", "other"].includes(b.paymentMethod) ? b.paymentMethod : "cash",
        note: String(b.note || "")
      });

      if (routerOnline) {
        try {
          v.rosUserId = await mt.addVoucherUser({
            code, profile: profileName,
            limitUptimeMinutes: plan.durationType === "uptime" ? plan.durationMinutes : 0
          });
          v.syncedToRouter = true;
        } catch (err) {
          v.syncedToRouter = false;
          v.lastSyncError = err?.message || String(err);
          routerOnline = false;
        }
      }
      await v.save();
      made.push(v);
    }

    res.json({
      batchId,
      routerOnline,
      wifiName: WIFI_NAME,
      plan: { label: plan.label, durationMinutes: plan.durationMinutes, durationType: plan.durationType, deviceCap: plan.deviceCap },
      vouchers: made.map(shapeVoucher)
    });
  } catch (err) {
    console.error("[hotspot generate]", err);
    res.status(500).json({ error: "Could not generate vouchers" });
  }
});

// List with filters + pagination.
router.get("/vouchers", authRequired, async (req, res) => {
  try {
    const q = {};
    if (req.query.status) q.status = req.query.status;
    if (req.query.planKey) q.planKey = req.query.planKey;
    if (req.query.batchId) q.batchId = req.query.batchId;
    if (req.query.createdBy) q.createdBy = req.query.createdBy;
    if (req.query.from || req.query.to) {
      q.createdAt = {};
      if (req.query.from) q.createdAt.$gte = new Date(req.query.from);
      if (req.query.to) q.createdAt.$lte = new Date(req.query.to);
    }
    const search = String(req.query.q || "").trim().toUpperCase();
    if (search) {
      q.$or = [{ code: new RegExp(search, "i") }, { "devices.mac": new RegExp(search, "i") }, { note: new RegExp(search, "i") }];
    }

    const page = Math.max(1, Number(req.query.page || 1));
    const limit = Math.min(100, Number(req.query.limit || 25));
    const [rows, total] = await Promise.all([
      Voucher.find(q).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      Voucher.countDocuments(q)
    ]);
    res.json({ total, page, pages: Math.ceil(total / limit), vouchers: rows.map(shapeVoucher) });
  } catch (err) {
    console.error("[hotspot list]", err);
    res.status(500).json({ error: "Could not load vouchers" });
  }
});

router.get("/vouchers/:code", authRequired, async (req, res) => {
  const v = await Voucher.findOne({ code: req.params.code.toUpperCase() }).lean();
  if (!v) return res.status(404).json({ error: "Voucher not found" });
  res.json({ voucher: shapeVoucher(v, true) });
});

// Extend duration.
router.post("/vouchers/:code/extend", authRequired, async (req, res) => {
  try {
    const add = Math.max(1, Number(req.body?.addMinutes || 0));
    const v = await Voucher.findOne({ code: req.params.code.toUpperCase() });
    if (!v) return res.status(404).json({ error: "Voucher not found" });

    v.durationMinutes += add;
    if (v.durationType === "clock" && v.validUntil) {
      v.validUntil = new Date(v.validUntil.getTime() + add * 60000);
    }
    if (["used", "expired"].includes(v.status)) v.status = "active";

    if (mt.isConfigured()) {
      try {
        if (v.durationType === "uptime") await mt.setUptimeLimit(v.code, v.durationMinutes);
        await mt.setUserDisabled(v.code, false);
        v.syncedToRouter = true; v.lastSyncError = null;
      } catch (err) { v.syncedToRouter = false; v.lastSyncError = err?.message; }
    }
    await v.save();
    res.json({ voucher: shapeVoucher(v, true) });
  } catch (err) {
    console.error("[hotspot extend]", err);
    res.status(500).json({ error: "Could not extend voucher" });
  }
});

// Revoke (disable) / restore.
router.post("/vouchers/:code/disable", authRequired, async (req, res) => {
  const v = await Voucher.findOne({ code: req.params.code.toUpperCase() });
  if (!v) return res.status(404).json({ error: "Voucher not found" });
  v.status = "disabled";
  await v.save();
  if (mt.isConfigured()) { try { await mt.setUserDisabled(v.code, true); await mt.kick(v.code); } catch { /* retried */ } }
  res.json({ voucher: shapeVoucher(v, true) });
});

router.post("/vouchers/:code/enable", authRequired, async (req, res) => {
  const v = await Voucher.findOne({ code: req.params.code.toUpperCase() });
  if (!v) return res.status(404).json({ error: "Voucher not found" });
  v.status = v.firstUsedAt ? "active" : "unused";
  await v.save();
  if (mt.isConfigured()) { try { await mt.setUserDisabled(v.code, false); } catch { /* retried */ } }
  res.json({ voucher: shapeVoucher(v, true) });
});

router.delete("/vouchers/:code", authRequired, ownerRequired, async (req, res) => {
  const v = await Voucher.findOne({ code: req.params.code.toUpperCase() });
  if (!v) return res.status(404).json({ error: "Voucher not found" });
  if (mt.isConfigured()) { try { await mt.removeVoucherUser(v.code); } catch { /* ignore */ } }
  await v.deleteOne();
  res.json({ ok: true });
});

// ============================================================
// 🎥 BYPASS DEVICES
// ============================================================
router.get("/bypass", authRequired, async (req, res) => {
  const devices = await BypassDevice.find().sort({ category: 1, label: 1 }).lean();
  res.json({ devices });
});

router.post("/bypass", authRequired, async (req, res) => {
  try {
    const mac = BypassDevice.normaliseMac(req.body?.mac);
    if (!mac) return res.status(400).json({ error: "That MAC address doesn't look right" });
    const doc = {
      mac,
      label: String(req.body?.label || "Device").trim(),
      category: ["camera", "reception", "staff", "other"].includes(req.body?.category) ? req.body.category : "camera",
      active: true,
      createdByName: req.hsAdmin.displayName
    };
    const device = await BypassDevice.findOneAndUpdate({ mac }, doc, { upsert: true, new: true, setDefaultsOnInsert: true });
    if (mt.isConfigured()) {
      try { device.rosBindingId = await mt.addBypass(mac, device.label); device.syncedToRouter = true; device.lastSyncError = null; }
      catch (err) { device.syncedToRouter = false; device.lastSyncError = err?.message; }
      await device.save();
    }
    res.json({ device });
  } catch (err) {
    console.error("[hotspot bypass add]", err);
    res.status(500).json({ error: "Could not add device" });
  }
});

router.delete("/bypass/:id", authRequired, async (req, res) => {
  const device = await BypassDevice.findById(req.params.id);
  if (!device) return res.status(404).json({ error: "Device not found" });
  if (mt.isConfigured()) { try { await mt.removeBypass(device.mac); } catch { /* ignore */ } }
  await device.deleteOne();
  res.json({ ok: true });
});

// ============================================================
// 📊 LIVE + REPORTS + STATS
// ============================================================
router.get("/live", authRequired, async (req, res) => {
  // Prefer the router's live truth; fall back to DB if offline.
  if (mt.isConfigured()) {
    try {
      const { sessions } = await mt.snapshot();
      return res.json({ online: sessions, source: "router" });
    } catch { /* fall through */ }
  }
  const active = await Voucher.find({ status: "active" }).sort({ lastSeenAt: -1 }).limit(100).lean();
  res.json({
    online: active.map((v) => ({
      code: v.code,
      mac: v.devices?.[v.devices.length - 1]?.mac || "",
      hostname: v.devices?.[v.devices.length - 1]?.hostname || "",
      planLabel: v.planLabel
    })),
    source: "db"
  });
});

router.get("/stats", authRequired, async (req, res) => {
  const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
  const [madeToday, activeNow, unusedStock, revenueAgg, routerStatus] = await Promise.all([
    Voucher.countDocuments({ createdAt: { $gte: startOfDay } }),
    Voucher.countDocuments({ status: "active" }),
    Voucher.aggregate([{ $match: { status: "unused" } }, { $group: { _id: "$planLabel", n: { $sum: 1 } } }]),
    Voucher.aggregate([
      { $match: { createdAt: { $gte: startOfDay }, paymentMethod: { $ne: "complimentary" } } },
      { $group: { _id: "$currency", total: { $sum: "$price" }, n: { $sum: 1 } } }
    ]),
    mt.isConfigured() ? mt.ping().then((r) => ({ online: true, ...r })).catch((e) => ({ online: false, error: e.message })) : Promise.resolve({ online: false, error: "not configured" })
  ]);
  res.json({ madeToday, activeNow, unusedStock, revenueToday: revenueAgg, router: routerStatus });
});

// Seller accountability + sales.
router.get("/reports/sales", authRequired, async (req, res) => {
  const match = { paymentMethod: { $ne: "complimentary" } };
  if (req.query.from || req.query.to) {
    match.createdAt = {};
    if (req.query.from) match.createdAt.$gte = new Date(req.query.from);
    if (req.query.to) match.createdAt.$lte = new Date(req.query.to);
  }
  const bySeller = await Voucher.aggregate([
    { $match: match },
    { $group: { _id: { seller: "$createdByName", currency: "$currency" }, vouchers: { $sum: 1 }, total: { $sum: "$price" } } },
    { $sort: { total: -1 } }
  ]);
  const byPlan = await Voucher.aggregate([
    { $match: match },
    { $group: { _id: "$planLabel", vouchers: { $sum: 1 }, total: { $sum: "$price" } } },
    { $sort: { total: -1 } }
  ]);
  const byMethod = await Voucher.aggregate([
    { $match: match },
    { $group: { _id: "$paymentMethod", vouchers: { $sum: 1 }, total: { $sum: "$price" } } }
  ]);
  res.json({ bySeller, byPlan, byMethod });
});

// ============================================================
// 👤 ADMINS  (owner only)
// ============================================================
router.get("/admins", authRequired, ownerRequired, async (req, res) => {
  const admins = await HotspotAdmin.find().select("-passwordHash").sort({ createdAt: 1 }).lean();
  res.json({ admins });
});

router.post("/admins", authRequired, ownerRequired, async (req, res) => {
  try {
    const b = req.body || {};
    const username = String(b.username || "").toLowerCase().trim();
    if (!username || !b.password) return res.status(400).json({ error: "Username and password are required" });
    if (await HotspotAdmin.exists({ username })) return res.status(400).json({ error: "That username is taken" });
    const admin = new HotspotAdmin({
      username,
      displayName: b.displayName || username,
      role: b.role === "owner" ? "owner" : "admin",
      createdBy: req.hsAdmin._id,
      createdByName: req.hsAdmin.displayName
    });
    await admin.setPassword(b.password);
    await admin.save();
    res.json({ admin: { id: admin._id, username: admin.username, displayName: admin.displayName, role: admin.role, active: admin.active } });
  } catch (err) {
    console.error("[hotspot admin add]", err);
    res.status(500).json({ error: "Could not add admin" });
  }
});

router.patch("/admins/:id", authRequired, ownerRequired, async (req, res) => {
  const admin = await HotspotAdmin.findById(req.params.id);
  if (!admin) return res.status(404).json({ error: "Admin not found" });
  const b = req.body || {};
  if (typeof b.active === "boolean") admin.active = b.active;
  if (b.displayName) admin.displayName = b.displayName;
  if (b.role && ["owner", "admin"].includes(b.role)) admin.role = b.role;
  if (b.password) await admin.setPassword(b.password);
  await admin.save();
  res.json({ admin: { id: admin._id, username: admin.username, displayName: admin.displayName, role: admin.role, active: admin.active } });
});

// ── shaper: safe view of a voucher for the UI ──
function shapeVoucher(v, full = false) {
  const base = {
    code: v.code,
    status: v.status,
    planLabel: v.planLabel,
    durationType: v.durationType,
    durationMinutes: v.durationMinutes,
    deviceCap: v.deviceCap,
    price: v.price,
    currency: v.currency,
    paymentMethod: v.paymentMethod,
    note: v.note,
    createdByName: v.createdByName,
    createdAt: v.createdAt,
    firstUsedAt: v.firstUsedAt,
    lastSeenAt: v.lastSeenAt,
    validUntil: v.validUntil,
    uptimeUsedMin: Math.floor((v.uptimeUsedSec || 0) / 60),
    deviceCount: v.devices?.length || 0,
    syncedToRouter: v.syncedToRouter,
    batchId: v.batchId
  };
  if (full) base.devices = v.devices || [];
  return base;
}

export default router;