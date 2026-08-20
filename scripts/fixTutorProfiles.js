// scripts/fixTutorProfiles.js
// ─────────────────────────────────────────────────────────────────────────────
// Some tutors were saved with profileType "product"/"service" by an earlier build
// of the admin "Register Tutor" form. The tutor search filters strictly on
// profileType:"tutor", so those records never appear. This script finds them
// (they still carry tutor-only fields) and sets profileType:"tutor".
//
// USAGE:
//   node fixTutorProfiles.js                → DRY RUN. Reports only, changes nothing.
//   APPLY=1 node fixTutorProfiles.js        → Converts detected tutors to profileType:"tutor".
//   PHONES="263772489448,2637..." APPLY=1 node fixTutorProfiles.js
//                                           → ALSO force-convert these exact numbers.
//
// "Detected tutor" = NOT already profileType:"tutor" AND carries a tutor-only
// signal: teachingLevels[], hourlyRate>0, subjects[], or gradesOffered[].
// Normal product/service suppliers have none of these, so they are never touched.
// It does NOT change `active` - the three known records are already active:true.
// ─────────────────────────────────────────────────────────────────────────────

import mongoose from "mongoose";
import dotenv from "dotenv";
dotenv.config();

const uri =
  process.env.MONGODB_URI || process.env.MONGO_URI ||
  process.env.DATABASE_URL || process.env.MONGO_URL;

if (!uri) {
  console.error("❌ No Mongo connection string. Set MONGODB_URI (or edit this file).");
  process.exit(1);
}

const APPLY  = process.env.APPLY === "1";
const PHONES = (process.env.PHONES || "")
  .split(",").map(s => s.replace(/\D+/g, "")).filter(Boolean);

(async () => {
  await mongoose.connect(uri);
  const coll = mongoose.connection.db.collection("supplierprofiles");

  // ── Overview ───────────────────────────────────────────────────────────────
  const byType = await coll.aggregate([
    { $group: { _id: "$profileType", n: { $sum: 1 } } },
    { $sort: { _id: 1 } }
  ]).toArray();
  console.log("\n📊 Suppliers by profileType:");
  for (const r of byType) console.log(`   ${String(r._id || "(none)").padEnd(12)} → ${r.n}`);
  console.log(`\n👩‍🏫 Active tutors the search sees now: ${await coll.countDocuments({ profileType: "tutor", active: true })}`);

  // ── Detect mis-typed tutors ────────────────────────────────────────────────
  const detectFilter = {
    profileType: { $ne: "tutor" },
    $or: [
      { teachingLevels: { $exists: true, $ne: [] } },
      { hourlyRate:     { $gt: 0 } },
      { subjects:       { $exists: true, $ne: [] } },
      { gradesOffered:  { $exists: true, $ne: [] } }
    ]
  };

  const detected = await coll.find(detectFilter)
    .project({ businessName: 1, phone: 1, profileType: 1, active: 1, subjects: 1, teachingLevels: 1, hourlyRate: 1 })
    .toArray();

  console.log(`\n🔎 Detected ${detected.length} record(s) that look like tutors but aren't profileType "tutor":`);
  for (const d of detected) {
    console.log(`   • ${String(d.businessName).padEnd(22)} ${String(d.phone).padEnd(16)} type=${d.profileType} active=${d.active}` +
                `  levels=[${(d.teachingLevels || []).join(",")}] rate=${d.hourlyRate || 0}`);
  }

  // Optional force-by-phone (for tutors with no signal fields yet)
  let forced = [];
  if (PHONES.length) {
    forced = await coll.find({ phone: { $in: PHONES } })
      .project({ businessName: 1, phone: 1, profileType: 1, active: 1 }).toArray();
    console.log(`\n📌 Force-convert by phone (${PHONES.length} requested, ${forced.length} matched):`);
    for (const f of forced) console.log(`   • ${String(f.businessName).padEnd(22)} ${f.phone} type=${f.profileType} active=${f.active}`);
  }

  // ── Apply ──────────────────────────────────────────────────────────────────
  if (!APPLY) {
    console.log(`\nℹ️  DRY RUN - nothing changed. Re-run with APPLY=1 to convert the records above.`);
    await mongoose.disconnect();
    process.exit(0);
  }

  const ids = [...detected.map(d => d._id), ...forced.map(f => f._id)];
  const uniqueIds = [...new Map(ids.map(id => [String(id), id])).values()];

  if (!uniqueIds.length) {
    console.log(`\n✅ Nothing to convert.`);
    await mongoose.disconnect();
    process.exit(0);
  }

  const result = await coll.updateMany(
    { _id: { $in: uniqueIds } },
    { $set: { profileType: "tutor" } }
  );

  console.log(`\n✅ Converted ${result.modifiedCount} record(s) to profileType:"tutor".`);
  console.log(`👩‍🏫 Active tutors the search now sees: ${await coll.countDocuments({ profileType: "tutor", active: true })}`);

  await mongoose.disconnect();
  process.exit(0);
})().catch(e => { console.error("❌ Failed:", e); process.exit(1); });