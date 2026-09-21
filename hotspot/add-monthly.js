// ==============================
// 📆 ADD MONTHLY PACKAGE  (safe, idempotent, additive)
// Adds/updates ONLY the monthly plans by key. Never deletes or changes your
// other packages. Run once:   node hotspot/add-monthly.js
// Monthly is a clock package → the 30 days start on FIRST LOGIN and it expires
// at the end of that window (same proven behaviour as your other clock plans).
// ==============================
import mongoose from "mongoose";
import "dotenv/config";
import HotspotPlan from "./models/hotspotPlan.js";

const MONTHLY = [
  // Core monthly — unlimited data, 30 days from first login, 3 devices.
  { key: "month",      label: "Monthly",      durationType: "clock", durationMinutes: 43200, deviceCap: 3, downKbps: 8000,  upKbps: 2000, price: 20, currency: "USD", active: true, sortOrder: 20 },
  // Optional upsell for heavier tenants — more devices + speed.
  { key: "month_plus", label: "Monthly Plus", durationType: "clock", durationMinutes: 43200, deviceCap: 5, downKbps: 12000, upKbps: 3000, price: 35, currency: "USD", active: true, sortOrder: 21 }
];

async function run() {
  await mongoose.connect(process.env.MONGODB_URI || process.env.MONGO_URI || "mongodb://127.0.0.1:27017/cripfcnt");
  for (const p of MONTHLY) {
    await HotspotPlan.findOneAndUpdate({ key: p.key }, p, { upsert: true, new: true, setDefaultsOnInsert: true });
    console.log("✓", p.label, "— $" + p.price + " (30 days, " + p.deviceCap + " devices)");
  }
  console.log("\n✅ Monthly package(s) ready. Edit or hide any in Admins → Plans.");
  await mongoose.disconnect();
}
run().catch((e) => { console.error(e); process.exit(1); });