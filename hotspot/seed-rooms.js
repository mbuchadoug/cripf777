// ==============================
// 🏨  SEED LODGE ROOM WIFI ACCOUNTS  (rooms 1-11)  - safe, idempotent, additive
// Creates one capped WiFi account per room, matching the printed room posters.
// Existing accounts are LEFT UNTOUCHED (re-running never changes a password or
// clobbers anything), so it is safe to run more than once.
//
// Each room account: 3 devices max, 10 Mbps down / 5 Mbps up, no price
// (complimentary), active. The app's sync loop pushes them to the MikroTik
// automatically within ~20s - no router commands needed.
//
// To change speed/devices for all rooms, edit DEVICE_CAP / DOWN_KBPS / UP_KBPS.
//
// Run once from your app root (the folder with server.js):
//     node hotspot/seed-rooms.js
// ==============================
import mongoose from "mongoose";
import "dotenv/config";
import HotspotAccount from "./models/hotspotAccount.js";

const DEVICE_CAP = 3;
const DOWN_KBPS  = 10000;   // 10 Mbps
const UP_KBPS    = 5000;    // 5 Mbps

const ROOMS = [
  { n:1, password:"Z7F5C" },
  { n:2, password:"XFEN5" },
  { n:3, password:"K9JFV" },
  { n:4, password:"TPUB5" },
  { n:5, password:"HRYP3" },
  { n:6, password:"F4PJJ" },
  { n:7, password:"2MBEV" },
  { n:8, password:"4E9UD" },
  { n:9, password:"8ZA5R" },
  { n:10, password:"VCM8F" },
  { n:11, password:"PPG3M" }
];

async function run() {
  await mongoose.connect(process.env.MONGODB_URI || process.env.MONGO_URI || "mongodb://127.0.0.1:27017/cripfcnt");
  let created = 0, skipped = 0;
  for (const r of ROOMS) {
    const username = "room" + r.n;
    const existing = await HotspotAccount.findOne({ username });
    if (existing) { console.log(`= room${r.n}: already exists, left untouched`); skipped++; continue; }
    await HotspotAccount.create({
      username,
      password: r.password,
      displayName: "Room " + r.n,
      unit: "Room " + r.n,
      type: "tenant",
      billing: "subscription",
      durationMinutes: 43200,
      validUntil: null,            // always on until staff suspend at checkout
      deviceCap: DEVICE_CAP,
      downKbps: DOWN_KBPS,
      upKbps: UP_KBPS,
      price: 0,
      status: "active",
      syncedToRouter: false,       // the app's sync loop pushes it to the router
      createdByName: "seed-rooms"
    });
    console.log(`+ room${r.n}: created (code ${r.password})`);
    created++;
  }
  console.log(`\nDone. ${created} created, ${skipped} already existed.`);
  console.log("They appear under Accounts, and sync to the MikroTik within ~20s.");
  await mongoose.disconnect();
}
run().catch((e) => { console.error(e); process.exit(1); });