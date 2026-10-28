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
import HotspotAccount from "../models/hotspotAccount.js";
import HotspotSetting from "../models/hotspotSetting.js";
import * as mt from "../services/mikrotik.js";
import { suggestPrice } from "../services/pricing.js";
import { signToken, authRequired, ownerRequired, adminRequired } from "../middleware/hotspotAuth.js";

const router = Router();

// ── shared helpers (speed + profile naming, reused by vouchers & accounts) ──
// RouterOS rate-limit is "rx/tx" = client-upload/client-download.
function rateLimitFrom(downKbps, upKbps) {
  return (upKbps || downKbps) ? `${upKbps || 0}k/${downKbps || 0}k` : null;
}
// A voucher batch reuses the plan's base profile when its caps match the plan,
// otherwise it gets its own profile named by those caps (so the caps are real
// on the router without touching the plan).
function voucherProfileName(plan, deviceCap, downKbps, upKbps) {
  const isCustom = deviceCap !== plan.deviceCap || downKbps !== plan.downKbps || upKbps !== plan.upKbps;
  return isCustom ? `${plan.rosProfile()}_d${deviceCap}_${downKbps || 0}_${upKbps || 0}` : plan.rosProfile();
}
function accountProfileName(a) {
  return `ha_${a.upKbps || 0}_${a.downKbps || 0}_d${a.deviceCap || 1}`;
}
function acctRemainingMin(a) {
  if (a.billing === "prepaid") return Math.max(0, (a.timeAllowanceMin || 0) - Math.floor((a.uptimeUsedSec || 0) / 60));
  if (a.validUntil) return Math.max(0, Math.round((new Date(a.validUntil) - new Date()) / 60000));
  return 0;
}
// Create/refresh an account's hotspot user + profile on the router (best effort).
async function ensureAccountOnRouter(a) {
  if (!mt.isConfigured()) { a.syncedToRouter = false; return; }
  try {
    const profileName = accountProfileName(a);
    await mt.ensureProfile({ name: profileName, sharedUsers: a.deviceCap, rateLimit: rateLimitFrom(a.downKbps, a.upKbps) });
    a.rosUserId = await mt.upsertAccountUser({
      username: a.username, password: a.password, profile: profileName,
      limitUptimeMinutes: a.billing === "prepaid" ? a.timeAllowanceMin : 0
    });
    a.syncedToRouter = true; a.lastSyncError = null;
  } catch (err) { a.syncedToRouter = false; a.lastSyncError = err?.message; }
}
function applyAccountTopup(a, minutes) {
  if (a.billing === "prepaid") {
    a.timeAllowanceMin = (a.timeAllowanceMin || 0) + minutes;
  } else {
    const base = (a.validUntil && new Date(a.validUntil) > new Date()) ? new Date(a.validUntil) : new Date();
    a.validUntil = new Date(base.getTime() + minutes * 60000);
  }
}

// Auto price for a duration + devices (whole-dollar). Used by the plan editor.
router.get("/price/suggest", authRequired, (req, res) => {
  res.json(suggestPrice({
    durationMinutes: Number(req.query.durationMinutes || 0),
    devices: Number(req.query.devices || 1)
  }));
});

const WIFI_NAME = process.env.HOTSPOT_WIFI_NAME || "Central Cyber WiFi";
const CODE_PREFIX = (process.env.HOTSPOT_CODE_PREFIX || "").toUpperCase();

// How much value an admin has issued today (excludes complimentary).
async function issuedTodayUsd(adminId) {
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const agg = await Voucher.aggregate([
    { $match: { createdBy: adminId, createdAt: { $gte: start }, paymentMethod: { $ne: "complimentary" } } },
    { $group: { _id: null, total: { $sum: "$price" }, n: { $sum: 1 } } }
  ]);
  return { total: agg[0]?.total || 0, count: agg[0]?.n || 0 };
}


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

    // Devices per voucher - defaults to the plan, but the admin can override it
    // per batch. A custom count gets its own RouterOS profile (hs_<key>_dN) so
    // the device cap (shared-users) is enforced without changing the plan.
    const devices = Math.min(20, Math.max(1, Number(b.devices || plan.deviceCap)));

    // Duration + speed overrides - default to the plan, admin can customise per batch.
    const durationMinutes = Math.max(1, Number(b.durationMinutes || plan.durationMinutes));
    const downKbps = b.downKbps != null ? Math.max(0, Number(b.downKbps)) : plan.downKbps;
    const upKbps   = b.upKbps   != null ? Math.max(0, Number(b.upKbps))   : plan.upKbps;
    const rateLimit = (upKbps || downKbps) ? `${upKbps || 0}k/${downKbps || 0}k` : null;

    // A RouterOS profile is defined by its device cap + speed. If any of those
    // differ from the plan, this batch gets its own profile so the caps are
    // enforced without touching the plan. Duration is per-voucher (limit-uptime).
    const isCustomProfile = devices !== plan.deviceCap || downKbps !== plan.downKbps || upKbps !== plan.upKbps;
    const profileName = isCustomProfile
      ? `${plan.rosProfile()}_d${devices}_${downKbps || 0}_${upKbps || 0}`
      : plan.rosProfile();

    // Price: an explicit override wins; otherwise auto-price for this device count.
    const unitPrice = b.price != null ? Number(b.price) : suggestPrice({ durationMinutes, devices }).price;
    if (admin.role === "issuer" && admin.dailyLimitUsd > 0) {
      const { total } = await issuedTodayUsd(admin._id);
      const batchValue = unitPrice * count;
      if (total + batchValue > admin.dailyLimitUsd) {
        const left = Math.max(0, admin.dailyLimitUsd - total);
        return res.status(403).json({ error: `Daily limit reached. You've issued $${total} of $${admin.dailyLimitUsd} today ($${left} left). This batch is $${batchValue}.` });
      }
    }

    // Ensure profile once for the whole batch.
    let routerOnline = true;
    try { await mt.ensureProfile({ name: profileName, sharedUsers: devices, rateLimit }); }
    catch { routerOnline = false; }

    const made = [];
    for (let i = 0; i < count; i++) {
      const code = await uniqueCode();
      const v = new Voucher({
        code,
        planKey: plan.key,
        planLabel: plan.label,
        durationType: plan.durationType,
        durationMinutes,
        deviceCap: devices,
        downKbps,
        upKbps,
        batchId,
        createdBy: admin._id,
        createdByName: admin.displayName,
        price: unitPrice,
        currency: plan.currency,
        paymentMethod: ["cash", "ecocash", "complimentary", "other"].includes(b.paymentMethod) ? b.paymentMethod : "cash",
        note: String(b.note || "")
      });

      if (routerOnline) {
        try {
          v.rosUserId = await mt.addVoucherUser({
            code, profile: profileName,
            limitUptimeMinutes: plan.durationType === "uptime" ? durationMinutes : 0
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
      plan: { label: plan.label, durationMinutes, durationType: plan.durationType, deviceCap: devices },
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
    if (req.hsAdmin.role === "issuer") q.createdBy = req.hsAdmin._id;   // issuers see only their own
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

// Export ALL matching vouchers (no pagination) for Excel / code list / printing.
// Same filters as the list; issuers still see only their own. Capped for safety.
// MUST stay above "/vouchers/:code" so "export" isn't read as a code.
router.get("/vouchers/export", authRequired, async (req, res) => {
  try {
    const q = {};
    if (req.query.status) q.status = req.query.status;
    if (req.query.planKey) q.planKey = req.query.planKey;
    if (req.query.batchId) q.batchId = req.query.batchId;
    if (req.hsAdmin.role === "issuer") q.createdBy = req.hsAdmin._id;
    if (req.query.from || req.query.to) {
      q.createdAt = {};
      if (req.query.from) q.createdAt.$gte = new Date(req.query.from);
      if (req.query.to) q.createdAt.$lte = new Date(req.query.to);
    }
    const search = String(req.query.q || "").trim().toUpperCase();
    if (search) q.$or = [{ code: new RegExp(search, "i") }, { "devices.mac": new RegExp(search, "i") }, { note: new RegExp(search, "i") }];
    const rows = await Voucher.find(q).sort({ createdAt: -1 }).limit(5000).lean();
    res.json({ count: rows.length, vouchers: rows.map(shapeVoucher) });
  } catch (err) {
    console.error("[hotspot export]", err);
    res.status(500).json({ error: "Could not export vouchers" });
  }
});

router.get("/vouchers/:code", authRequired, async (req, res) => {
  const v = await Voucher.findOne({ code: req.params.code.toUpperCase() }).lean();
  if (!v) return res.status(404).json({ error: "Voucher not found" });
  res.json({ voucher: shapeVoucher(v, true) });
});

// Extend duration.
router.post("/vouchers/:code/extend", authRequired, adminRequired, async (req, res) => {
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

// Edit a voucher - duration, speed, devices, price, note - even while it's ACTIVE.
// Changing speed/devices moves the live session to a matching profile; changing
// duration resets the router's uptime limit (or the clock window) in place.
router.patch("/vouchers/:code", authRequired, adminRequired, async (req, res) => {
  try {
    const v = await Voucher.findOne({ code: req.params.code.toUpperCase() });
    if (!v) return res.status(404).json({ error: "Voucher not found" });
    const b = req.body || {};
    const plan = await HotspotPlan.findOne({ key: v.planKey });

    const oldDev = v.deviceCap, oldDown = v.downKbps, oldUp = v.upKbps;
    const durationChanged = b.durationMinutes != null && Number(b.durationMinutes) !== v.durationMinutes;

    if (b.durationMinutes != null) v.durationMinutes = Math.max(1, Number(b.durationMinutes));
    if (b.deviceCap != null) v.deviceCap = Math.min(20, Math.max(1, Number(b.deviceCap)));
    if (b.downKbps != null) v.downKbps = Math.max(0, Number(b.downKbps));
    if (b.upKbps != null) v.upKbps = Math.max(0, Number(b.upKbps));
    if (b.note != null) v.note = String(b.note);
    if (b.price != null) v.price = Math.max(0, Number(b.price));

    // Clock window follows the new duration once the voucher has started.
    if (v.durationType === "clock" && durationChanged && v.firstUsedAt) {
      v.validUntil = new Date(new Date(v.firstUsedAt).getTime() + v.durationMinutes * 60000);
    }
    // If it had run out but now has time again, bring it back.
    if (["used", "expired"].includes(v.status) && v.remainingMinutes() > 0) {
      v.status = v.firstUsedAt ? "active" : "unused";
    }

    if (mt.isConfigured()) {
      try {
        const capsChanged = v.deviceCap !== oldDev || v.downKbps !== oldDown || v.upKbps !== oldUp;
        if (plan && capsChanged) {
          const profileName = voucherProfileName(plan, v.deviceCap, v.downKbps, v.upKbps);
          await mt.ensureProfile({ name: profileName, sharedUsers: v.deviceCap, rateLimit: rateLimitFrom(v.downKbps, v.upKbps) });
          await mt.setUserProfile(v.code, profileName);
        }
        if (v.durationType === "uptime" && durationChanged) await mt.setUptimeLimit(v.code, v.durationMinutes);
        if (v.status !== "disabled") await mt.setUserDisabled(v.code, false);
        v.syncedToRouter = true; v.lastSyncError = null;
      } catch (err) { v.syncedToRouter = false; v.lastSyncError = err?.message; }
    }
    await v.save();
    res.json({ voucher: shapeVoucher(v, true) });
  } catch (err) {
    console.error("[hotspot voucher edit]", err);
    res.status(500).json({ error: "Could not update voucher" });
  }
});

// Revoke (disable) / restore.
router.post("/vouchers/:code/disable", authRequired, adminRequired, async (req, res) => {
  const v = await Voucher.findOne({ code: req.params.code.toUpperCase() });
  if (!v) return res.status(404).json({ error: "Voucher not found" });
  v.status = "disabled";
  await v.save();
  if (mt.isConfigured()) { try { await mt.setUserDisabled(v.code, true); await mt.kick(v.code); } catch { /* retried */ } }
  res.json({ voucher: shapeVoucher(v, true) });
});

router.post("/vouchers/:code/enable", authRequired, adminRequired, async (req, res) => {
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
router.get("/bypass", authRequired, adminRequired, async (req, res) => {
  const devices = await BypassDevice.find().sort({ category: 1, label: 1 }).lean();
  res.json({ devices });
});

router.post("/bypass", authRequired, adminRequired, async (req, res) => {
  try {
    const mac = BypassDevice.normaliseMac(req.body?.mac);
    if (!mac) return res.status(400).json({ error: "That MAC address doesn't look right" });
    const doc = {
      mac,
      label: String(req.body?.label || "Device").trim(),
      category: ["camera", "reception", "staff", "other"].includes(req.body?.category) ? req.body.category : "camera",
      downKbps: Math.max(0, Number(req.body?.downKbps || 0)),
      upKbps: Math.max(0, Number(req.body?.upKbps || 0)),
      active: true,
      createdByName: req.hsAdmin.displayName
    };
    const device = await BypassDevice.findOneAndUpdate({ mac }, doc, { upsert: true, new: true, setDefaultsOnInsert: true });
    if (mt.isConfigured()) {
      try { device.rosBindingId = await mt.addBypass(mac, device.label, rateLimitFrom(device.downKbps, device.upKbps) || ""); device.syncedToRouter = true; device.lastSyncError = null; }
      catch (err) { device.syncedToRouter = false; device.lastSyncError = err?.message; }
      await device.save();
    }
    res.json({ device });
  } catch (err) {
    console.error("[hotspot bypass add]", err);
    res.status(500).json({ error: "Could not add device" });
  }
});

// Edit a bypass device - rename, re-categorise, or set/clear its speed cap.
router.patch("/bypass/:id", authRequired, adminRequired, async (req, res) => {
  try {
    const device = await BypassDevice.findById(req.params.id);
    if (!device) return res.status(404).json({ error: "Device not found" });
    const b = req.body || {};
    if (b.label != null) device.label = String(b.label).trim() || device.label;
    if (b.category && ["camera", "reception", "staff", "other"].includes(b.category)) device.category = b.category;
    if (b.downKbps != null) device.downKbps = Math.max(0, Number(b.downKbps));
    if (b.upKbps != null) device.upKbps = Math.max(0, Number(b.upKbps));
    if (mt.isConfigured()) {
      try { device.rosBindingId = await mt.addBypass(device.mac, device.label, rateLimitFrom(device.downKbps, device.upKbps) || ""); device.syncedToRouter = true; device.lastSyncError = null; }
      catch (err) { device.syncedToRouter = false; device.lastSyncError = err?.message; }
    }
    await device.save();
    res.json({ device });
  } catch (err) {
    console.error("[hotspot bypass edit]", err);
    res.status(500).json({ error: "Could not update device" });
  }
});

router.delete("/bypass/:id", authRequired, adminRequired, async (req, res) => {
  const device = await BypassDevice.findById(req.params.id);
  if (!device) return res.status(404).json({ error: "Device not found" });
  if (mt.isConfigured()) { try { await mt.removeBypass(device.mac); } catch { /* ignore */ } }
  await device.deleteOne();
  res.json({ ok: true });
});

// ============================================================
// 👤 USER ACCOUNTS  (tenants & regular clients who log in instead of using codes)
// ============================================================

// Global account cap (owner-tunable).
router.get("/accounts/settings", authRequired, adminRequired, async (req, res) => {
  const s = await HotspotSetting.get();
  const accountCount = await HotspotAccount.countDocuments();
  res.json({ maxAccounts: s.maxAccounts, accountCount });
});

router.patch("/accounts/settings", authRequired, ownerRequired, async (req, res) => {
  const s = await HotspotSetting.get();
  if (req.body?.maxAccounts != null) s.maxAccounts = Math.max(0, Number(req.body.maxAccounts));
  s.updatedAt = new Date();
  await s.save();
  res.json({ maxAccounts: s.maxAccounts });
});

router.get("/accounts", authRequired, adminRequired, async (req, res) => {
  try {
    const q = {};
    if (req.query.type) q.type = req.query.type;
    if (req.query.status) q.status = req.query.status;
    const search = String(req.query.q || "").trim();
    if (search) q.$or = [
      { username: new RegExp(search, "i") }, { displayName: new RegExp(search, "i") },
      { phone: new RegExp(search, "i") }, { unit: new RegExp(search, "i") }
    ];
    const rows = await HotspotAccount.find(q).sort({ createdAt: -1 }).lean();
    res.json({ accounts: rows.map((a) => shapeAccount(a)) });
  } catch (err) {
    console.error("[hotspot accounts list]", err);
    res.status(500).json({ error: "Could not load accounts" });
  }
});

router.post("/accounts", authRequired, adminRequired, async (req, res) => {
  try {
    const b = req.body || {};
    const username = String(b.username || "").toLowerCase().replace(/[^a-z0-9._-]/g, "");
    if (!username || !b.password) return res.status(400).json({ error: "Username and password are required" });
    if (await HotspotAccount.exists({ username })) return res.status(400).json({ error: "That username is taken" });
    if (await Voucher.exists({ code: username.toUpperCase() })) return res.status(400).json({ error: "That name clashes with a voucher code" });

    const s = await HotspotSetting.get();
    const count = await HotspotAccount.countDocuments();
    if (s.maxAccounts > 0 && count >= s.maxAccounts) {
      return res.status(403).json({ error: `Account limit reached (${s.maxAccounts}). Raise it in Accounts → settings, or remove an account.` });
    }

    const billing = b.billing === "prepaid" ? "prepaid" : "subscription";
    const durationMinutes = Math.max(1, Number(b.durationMinutes || 43200));
    const a = new HotspotAccount({
      username, password: String(b.password),
      displayName: b.displayName || username, phone: String(b.phone || ""), unit: String(b.unit || ""),
      type: ["client", "tenant", "staff"].includes(b.type) ? b.type : "client",
      billing, durationMinutes,
      deviceCap: Math.min(20, Math.max(1, Number(b.deviceCap || 2))),
      downKbps: Math.max(0, Number(b.downKbps || 0)), upKbps: Math.max(0, Number(b.upKbps || 0)),
      price: Math.max(0, Number(b.price || 0)), currency: b.currency || "USD",
      createdByName: req.hsAdmin.displayName
    });
    if (billing === "subscription") a.validUntil = new Date(Date.now() + durationMinutes * 60000);
    else a.timeAllowanceMin = durationMinutes;

    await ensureAccountOnRouter(a);
    await a.save();
    res.json({ account: shapeAccount(a, true) });
  } catch (err) {
    console.error("[hotspot account add]", err);
    res.status(500).json({ error: "Could not create account" });
  }
});

router.get("/accounts/:id", authRequired, adminRequired, async (req, res) => {
  const a = await HotspotAccount.findById(req.params.id).lean();
  if (!a) return res.status(404).json({ error: "Account not found" });
  res.json({ account: shapeAccount(a, true) });
});

// Edit speed / devices / validity / password / status - applies to the live user.
router.patch("/accounts/:id", authRequired, adminRequired, async (req, res) => {
  try {
    const a = await HotspotAccount.findById(req.params.id);
    if (!a) return res.status(404).json({ error: "Account not found" });
    const b = req.body || {};

    if (b.displayName != null) a.displayName = String(b.displayName);
    if (b.phone != null) a.phone = String(b.phone);
    if (b.unit != null) a.unit = String(b.unit);
    if (b.type && ["client", "tenant", "staff"].includes(b.type)) a.type = b.type;
    if (b.deviceCap != null) a.deviceCap = Math.min(20, Math.max(1, Number(b.deviceCap)));
    if (b.downKbps != null) a.downKbps = Math.max(0, Number(b.downKbps));
    if (b.upKbps != null) a.upKbps = Math.max(0, Number(b.upKbps));
    if (b.price != null) a.price = Math.max(0, Number(b.price));
    if (b.durationMinutes != null) a.durationMinutes = Math.max(1, Number(b.durationMinutes));
    if (b.password) a.password = String(b.password);
    if (b.validUntil) a.validUntil = new Date(b.validUntil);

    let statusChange = null;
    if (b.status && ["active", "suspended", "expired"].includes(b.status)) { a.status = b.status; statusChange = b.status; }

    await ensureAccountOnRouter(a);
    if (mt.isConfigured()) {
      try {
        if (b.password) await mt.setUserPassword(a.username, a.password);
        if (statusChange === "suspended") { await mt.setUserDisabled(a.username, true); await mt.kick(a.username); }
        if (statusChange === "active") await mt.setUserDisabled(a.username, false);
      } catch (err) { a.lastSyncError = err?.message; }
    }
    await a.save();
    res.json({ account: shapeAccount(a, true) });
  } catch (err) {
    console.error("[hotspot account edit]", err);
    res.status(500).json({ error: "Could not update account" });
  }
});

// Manual top-up (cash/complimentary at reception). Online EcoCash top-up lives
// in the public self-service route.
router.post("/accounts/:id/topup", authRequired, adminRequired, async (req, res) => {
  try {
    const a = await HotspotAccount.findById(req.params.id);
    if (!a) return res.status(404).json({ error: "Account not found" });
    const minutes = Math.max(1, Number(req.body?.minutes || a.durationMinutes));
    const amount = Number(req.body?.amount != null ? req.body.amount : a.price) || 0;
    const method = ["cash", "ecocash", "complimentary", "other"].includes(req.body?.method) ? req.body.method : "cash";

    applyAccountTopup(a, minutes);
    a.topups.push({ minutes, amount, currency: a.currency, method, by: req.hsAdmin.displayName, note: String(req.body?.note || "") });
    if (a.status !== "active") a.status = "active";

    await ensureAccountOnRouter(a);
    if (mt.isConfigured()) { try { await mt.setUserDisabled(a.username, false); } catch { /* retried */ } }
    await a.save();
    res.json({ account: shapeAccount(a, true) });
  } catch (err) {
    console.error("[hotspot account topup]", err);
    res.status(500).json({ error: "Could not top up account" });
  }
});

router.delete("/accounts/:id", authRequired, ownerRequired, async (req, res) => {
  const a = await HotspotAccount.findById(req.params.id);
  if (!a) return res.status(404).json({ error: "Account not found" });
  if (mt.isConfigured()) { try { await mt.removeVoucherUser(a.username); } catch { /* ignore */ } }
  await a.deleteOne();
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
router.get("/reports/sales", authRequired, adminRequired, async (req, res) => {
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
  for (const a of admins) {
    const t = await issuedTodayUsd(a._id);
    a.todayIssuedUsd = t.total;
    a.todayIssuedCount = t.count;
  }
  res.json({ admins });
});

// Issuer's own allowance (for the "today: $X of $Y" banner). Any logged-in user.
router.get("/me/allowance", authRequired, async (req, res) => {
  const a = req.hsAdmin;
  const t = await issuedTodayUsd(a._id);
  res.json({
    role: a.role,
    dailyLimitUsd: a.dailyLimitUsd || 0,
    todayIssuedUsd: t.total,
    todayIssuedCount: t.count,
    remainingUsd: a.dailyLimitUsd > 0 ? Math.max(0, a.dailyLimitUsd - t.total) : null
  });
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
      role: ["owner", "admin", "issuer"].includes(b.role) ? b.role : "admin",
      dailyLimitUsd: Math.max(0, Number(b.dailyLimitUsd || 0)),
      createdBy: req.hsAdmin._id,
      createdByName: req.hsAdmin.displayName
    });
    await admin.setPassword(b.password);
    await admin.save();
    res.json({ admin: { id: admin._id, username: admin.username, displayName: admin.displayName, role: admin.role, active: admin.active, dailyLimitUsd: admin.dailyLimitUsd } });
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
  if (b.role && ["owner", "admin", "issuer"].includes(b.role)) admin.role = b.role;
  if (b.dailyLimitUsd != null) admin.dailyLimitUsd = Math.max(0, Number(b.dailyLimitUsd));
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
    downKbps: v.downKbps || 0,
    upKbps: v.upKbps || 0,
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

// ── shaper: safe view of an account for the UI ──
function shapeAccount(a, full = false) {
  const base = {
    id: a._id,
    username: a.username,
    displayName: a.displayName,
    phone: a.phone,
    unit: a.unit,
    type: a.type,
    billing: a.billing,
    durationMinutes: a.durationMinutes,
    deviceCap: a.deviceCap,
    downKbps: a.downKbps || 0,
    upKbps: a.upKbps || 0,
    price: a.price,
    currency: a.currency,
    status: a.status,
    validUntil: a.validUntil || null,
    timeAllowanceMin: a.timeAllowanceMin || 0,
    uptimeUsedMin: Math.floor((a.uptimeUsedSec || 0) / 60),
    remainingMinutes: acctRemainingMin(a),
    deviceCount: a.devices?.length || 0,
    lastSeenAt: a.lastSeenAt,
    syncedToRouter: a.syncedToRouter,
    createdByName: a.createdByName,
    createdAt: a.createdAt
  };
  if (full) { base.devices = a.devices || []; base.topups = a.topups || []; }
  return base;
}

export default router;