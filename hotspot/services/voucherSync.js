// ==============================
// 🔄 VOUCHER SYNC
// Runs on a timer. Does four jobs each pass:
//   1. Reads who's online → records which phone (MAC) used each voucher.
//   2. Updates uptime / data used, flips finished uptime vouchers to "used".
//   3. Expires "clock" vouchers whose window has passed (disable + kick).
//   4. Retries any vouchers/bypass devices that failed to reach the router.
// Everything is wrapped so a router outage never crashes the app.
// ==============================

import Voucher from "../models/voucher.js";
import BypassDevice from "../models/bypassDevice.js";
import HotspotPlan from "../models/hotspotPlan.js";
import * as mt from "./mikrotik.js";

let timer = null;
let running = false;

export function startSync(intervalMs = Number(process.env.HOTSPOT_SYNC_MS || 20000)) {
  if (timer) return;
  timer = setInterval(() => { syncOnce().catch(() => {}); }, intervalMs);
  // First pass shortly after boot.
  setTimeout(() => { syncOnce().catch(() => {}); }, 4000);
  console.log(`[hotspot] sync loop every ${Math.round(intervalMs / 1000)}s`);
}

export async function syncOnce() {
  if (running) return;
  running = true;
  try {
    if (mt.isConfigured()) {
      await pullUsage();
      await resyncPending();
    }
    await expireClockVouchers();
  } catch (err) {
    console.error("[hotspot sync]", err?.message || err);
  } finally {
    running = false;
  }
}

// 1 + 2 - read live sessions and per-user usage, write back to Mongo.
async function pullUsage() {
  const { sessions, usageByCode } = await mt.snapshot();
  const now = new Date();

  // Live sessions → record devices + mark active.
  for (const s of sessions) {
    if (!s.code) continue;
    const v = await Voucher.findOne({ code: s.code });
    if (!v) continue;

    if (!v.firstUsedAt) v.firstUsedAt = now;
    v.lastSeenAt = now;
    if (v.status === "unused") v.status = "active";

    // Start the clock window on first login for "clock" plans.
    if (v.durationType === "clock" && !v.validUntil) {
      v.validUntil = new Date(now.getTime() + v.durationMinutes * 60000);
    }

    if (s.mac) {
      const dev = v.devices.find((d) => d.mac === s.mac);
      if (dev) {
        dev.lastSeen = now;
        if (s.ip) dev.ip = s.ip;
        if (s.hostname) dev.hostname = s.hostname;
      } else {
        v.devices.push({ mac: s.mac, ip: s.ip, hostname: s.hostname, firstSeen: now, lastSeen: now });
      }
    }
    await v.save();
  }

  // Per-user counters (works even after they log out).
  for (const [code, u] of Object.entries(usageByCode)) {
    const v = await Voucher.findOne({ code });
    if (!v) continue;
    let changed = false;
    if (u.uptimeUsedSec > v.uptimeUsedSec) { v.uptimeUsedSec = u.uptimeUsedSec; changed = true; }
    if (u.bytesIn  !== v.bytesIn)  { v.bytesIn  = u.bytesIn;  changed = true; }
    if (u.bytesOut !== v.bytesOut) { v.bytesOut = u.bytesOut; changed = true; }

    // Uptime plan fully consumed → router already logged them out.
    if (v.durationType === "uptime" &&
        v.status !== "used" && v.status !== "disabled" &&
        v.uptimeUsedSec >= v.durationMinutes * 60) {
      v.status = "used"; changed = true;
    }
    if (changed) await v.save();
  }
}

// 3 - clock vouchers past their window.
async function expireClockVouchers() {
  const now = new Date();
  const due = await Voucher.find({
    durationType: "clock",
    status: { $in: ["active"] },
    validUntil: { $lte: now }
  });
  for (const v of due) {
    v.status = "expired";
    await v.save();
    if (mt.isConfigured()) {
      try { await mt.setUserDisabled(v.code, true); await mt.kick(v.code); } catch { /* retried next pass */ }
    }
  }
}

// 4 - push anything that never reached the router.
async function resyncPending() {
  const vouchers = await Voucher.find({ syncedToRouter: false, status: { $ne: "disabled" } }).limit(50);
  for (const v of vouchers) {
    try {
      const plan = await HotspotPlan.findOne({ key: v.planKey });
      const profileName = plan ? plan.rosProfile() : `hs_${v.planKey}`;
      if (plan) await mt.ensureProfile({
        name: profileName,
        sharedUsers: v.deviceCap,
        rateLimit: plan.rateLimitString()
      });
      const id = await mt.addVoucherUser({
        code: v.code,
        profile: profileName,
        limitUptimeMinutes: v.durationType === "uptime" ? v.durationMinutes : 0
      });
      v.rosUserId = id;
      v.syncedToRouter = true;
      v.lastSyncError = null;
      await v.save();
    } catch (err) {
      v.lastSyncError = err?.message || String(err);
      await v.save();
    }
  }

  const devices = await BypassDevice.find({ syncedToRouter: false, active: true }).limit(50);
  for (const d of devices) {
    try {
      const id = await mt.addBypass(d.mac, d.label);
      d.rosBindingId = id;
      d.syncedToRouter = true;
      d.lastSyncError = null;
      await d.save();
    } catch (err) {
      d.lastSyncError = err?.message || String(err);
      await d.save();
    }
  }
}