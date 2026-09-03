// ==============================
// 🚪 HOTSPOT MODULE ENTRY
// One import + one call in your server.js:
//
//     import mountHotspot from "./hotspot/index.js";
//     mountHotspot(app);
//
// It mounts the API at /hotspot/api, serves the admin panel at /hotspot,
// seeds a first owner + starter plans, and starts the background sync.
// Nothing else in your app is touched.
// ==============================

import path from "path";
import { fileURLToPath } from "url";
import express from "express";

import HotspotAdmin from "./models/hotspotAdmin.js";
import HotspotPlan from "./models/hotspotPlan.js";
import hotspotApi from "./routes/hotspotApi.js";
import { startSync } from "./services/voucherSync.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Starter plans - tweak or delete from the UI later.
const DEFAULT_PLANS = [
  { key: "lunch2h",   label: "Lunch - 2 hours",   durationType: "uptime", durationMinutes: 120,  deviceCap: 1, downKbps: 4000, upKbps: 1000, price: 1,  sortOrder: 1 },
  { key: "day",       label: "Day pass - 1 day",  durationType: "clock",  durationMinutes: 1440, deviceCap: 2, downKbps: 6000, upKbps: 1500, price: 2,  sortOrder: 2 },
  { key: "week",      label: "Week - 7 days",     durationType: "clock",  durationMinutes: 10080, deviceCap: 3, downKbps: 8000, upKbps: 2000, price: 8,  sortOrder: 3 }
];

async function seed() {
  // First owner
  if ((await HotspotAdmin.countDocuments()) === 0) {
    const owner = new HotspotAdmin({
      username: (process.env.HOTSPOT_OWNER_USERNAME || "owner").toLowerCase(),
      displayName: process.env.HOTSPOT_OWNER_NAME || "Owner",
      role: "owner",
      createdByName: "system"
    });
    await owner.setPassword(process.env.HOTSPOT_OWNER_PASSWORD || "changeme123");
    await owner.save();
    console.log(`[hotspot] 👤 seeded owner "${owner.username}" - CHANGE THE PASSWORD after first login`);
  }
  // Starter plans
  if ((await HotspotPlan.countDocuments()) === 0) {
    await HotspotPlan.insertMany(DEFAULT_PLANS);
    console.log(`[hotspot] 📦 seeded ${DEFAULT_PLANS.length} starter plans`);
  }
}

export default function mountHotspot(app, opts = {}) {
  const base = opts.base || "/hotspot";

  app.use(express.json());                             // safe: parses only /hotspot bodies it sees
  app.use(`${base}/api`, hotspotApi);                  // JSON API
  app.use(base, express.static(path.join(__dirname, "public")));  // serves hotspot-admin.html as index

  seed().catch((e) => console.error("[hotspot seed]", e));
  startSync();

  console.log(`[hotspot] ✅ admin panel at ${base}  •  api at ${base}/api`);
  return app;
}