// ==============================
// ⏱️  CHANGE THE $1 PACKAGE: 2 HOURS → 3 HOURS  (safe, idempotent, additive)
// Updates ONLY the duration (and the "2 hours" wording in its name). Price,
// devices and speed are left exactly as they are. Nothing else is touched.
//
// Existing codes already sold keep their original time (each voucher carries
// its own snapshot). New codes and EcoCash self-service buys become 3 hours.
//
// Run once from your app root (the folder with server.js):
//     node hotspot/set-lunch-3hrs.js
// ==============================
import mongoose from "mongoose";
import "dotenv/config";
import HotspotPlan from "./models/hotspotPlan.js";

async function run() {
  await mongoose.connect(process.env.MONGODB_URI || process.env.MONGO_URI || "mongodb://127.0.0.1:27017/cripfcnt");

  // Find the "$1 for 2 hours" package: its seeded key first, else 120 min @ $1.
  let plan = await HotspotPlan.findOne({ key: "lunch2h" });
  if (!plan) plan = await HotspotPlan.findOne({ durationMinutes: 120, price: 1 });

  if (!plan) {
    console.log("⚠️  No 2-hour $1 package found (key 'lunch2h' or 120 min @ $1). Nothing changed.");
    await mongoose.disconnect();
    return;
  }
  if (plan.durationMinutes === 180) {
    console.log(`✓ "${plan.label}" (${plan.key}) is already 3 hours. Nothing to do.`);
    await mongoose.disconnect();
    return;
  }

  const beforeLabel = plan.label, beforeMin = plan.durationMinutes;
  plan.durationMinutes = 180;
  if (/2\s*(hours?|hrs?)/i.test(plan.label)) {
    plan.label = plan.label.replace(/2(\s*(?:hours?|hrs?))/i, "3$1");
  }
  await plan.save();

  console.log(`✓ Updated package "${plan.key}":`);
  console.log(`    time  : ${beforeMin} min  →  ${plan.durationMinutes} min (3 hours)`);
  console.log(`    name  : "${beforeLabel}"  →  "${plan.label}"`);
  console.log(`    price : $${plan.price} (unchanged) · ${plan.deviceCap} device(s) (unchanged)`);
  console.log("\nThe EcoCash buy page shows the new time automatically. Existing codes keep their original time.");
  await mongoose.disconnect();
}
run().catch((e) => { console.error(e); process.exit(1); });
