// scripts/fixTutorIndex.js
// One-off: drops the stale two-array (subjects + teachingLevels) index that
// blocks tutor inserts with "cannot index parallel arrays".
// Run once:  node fixTutorIndex.js
//
// It only DROPS the bad index. The fixed supplierProfile.js recreates the
// correct single-array indexes on next app startup, so no rebuild needed here.

import mongoose from "mongoose";
import dotenv from "dotenv";
dotenv.config();

// Adjust the var name if yours differs (check your .env).
const uri =
  process.env.MONGODB_URI ||
  process.env.MONGO_URI ||
  process.env.DATABASE_URL ||
  process.env.MONGO_URL;

if (!uri) {
  console.error("❌ No Mongo connection string found. Set MONGODB_URI (or edit this file).");
  process.exit(1);
}

(async () => {
  try {
    await mongoose.connect(uri);
    const coll = mongoose.connection.db.collection("supplierprofiles");
    const indexes = await coll.indexes();

    let dropped = 0;
    for (const idx of indexes) {
      const keys = Object.keys(idx.key || {});
      if (keys.includes("subjects") && keys.includes("teachingLevels")) {
        console.log("→ Dropping bad index:", idx.name, JSON.stringify(idx.key));
        await coll.dropIndex(idx.name);
        dropped++;
      }
    }

    console.log(dropped
      ? `✅ Dropped ${dropped} parallel-array index(es). You can register tutors now.`
      : "ℹ️ No parallel-array index found - nothing to drop (already clean).");
  } catch (err) {
    console.error("❌ Failed:", err.message);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
  }
})();