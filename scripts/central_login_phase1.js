// scripts/central_login_phase1.js
// ─────────────────────────────────────────────────────────────────────────────
// One-off, SAFE migration for central login Phase 1. Additive only: it never
// deletes or rewrites existing data.
//
//   node scripts/central_login_phase1.js           ← dry run: report only
//   node scripts/central_login_phase1.js --apply   ← make the changes
//
// What it does (with --apply):
//   1. Creates the new indexes (User.phone unique+sparse, verification lookups).
//      Uses createIndexes(), which only ADDS indexes - it never drops any.
//   2. Marks emailVerified=true for accounts that signed in with Google
//      (Google already verified those addresses).
// What it reports (always):
//   • accounts sharing the same email (duplicates to merge later)
//   • accounts with no password AND no email (can only sign in with Google
//     or can't recover a password today)
//   • how many accounts have extra personas (mobileRoles)
// ─────────────────────────────────────────────────────────────────────────────
import "dotenv/config";
import mongoose from "mongoose";
import User from "../models/user.js";
import MobileVerification from "../models/mobileVerification.js";

const APPLY = process.argv.includes("--apply");

async function main() {
  if (!process.env.MONGODB_URI) throw new Error("MONGODB_URI missing in .env");
  await mongoose.connect(process.env.MONGODB_URI);
  console.log(`Connected. Mode: ${APPLY ? "APPLY" : "DRY RUN (add --apply to make changes)"}\n`);

  // 1) Indexes
  if (APPLY) {
    for (const [name, M] of [["User", User], ["MobileVerification", MobileVerification]]) {
      try { await M.createIndexes(); console.log(`✅ Indexes ensured on ${name}`); }
      catch (e) { console.log(`⚠️  ${name} indexes: ${e.message}`); }
    }
  } else {
    console.log("• Would ensure indexes: User.phone (unique, sparse), MobileVerification target+purpose");
  }

  // 2) Google-verified emails
  const googleFilter = { googleId: { $exists: true, $ne: null }, email: { $exists: true, $ne: "" }, emailVerified: { $ne: true } };
  const googleCount = await User.countDocuments(googleFilter);
  if (APPLY && googleCount) {
    const r = await User.updateMany(googleFilter, { $set: { emailVerified: true } });
    console.log(`✅ emailVerified=true on ${r.modifiedCount} Google accounts`);
  } else {
    console.log(`• Google accounts to mark emailVerified: ${googleCount}`);
  }

  // 3) Reports (read-only)
  const withEmail = await User.find({ email: { $type: "string", $ne: "" } }).select("email role").lean();
  const groups = new Map();
  for (const u of withEmail) {
    const k = u.email.trim().toLowerCase();
    const g = groups.get(k) || { _id: k, n: 0, ids: [], roles: [] };
    g.n++; g.ids.push(String(u._id)); g.roles.push(u.role); groups.set(k, g);
  }
  const dupes = [...groups.values()].filter((g) => g.n > 1).sort((a, b) => b.n - a.n).slice(0, 50);
  console.log(`\n• Emails used by more than one account: ${dupes.length}${dupes.length ? " (first 50):" : ""}`);
  for (const d of dupes) console.log(`   ${d._id}  ×${d.n}  roles=${d.roles.join(",")}  ids=${d.ids.join(",")}`);

  const stranded = await User.countDocuments({
    $and: [
      { $or: [{ passwordHash: null }, { passwordHash: { $exists: false } }] },
      { $or: [{ email: null }, { email: "" }, { email: { $exists: false } }] },
      { $or: [{ googleId: null }, { googleId: { $exists: false } }] }
    ]
  });
  console.log(`• Accounts with no password, no email and no Google (cannot sign in): ${stranded}`);

  const noRecovery = await User.countDocuments({
    passwordHash: { $type: "string" },
    $or: [{ email: null }, { email: "" }, { email: { $exists: false } }],
    role: { $ne: "student" }
  });
  console.log(`• Adult accounts with a password but no email (no self-service reset yet): ${noRecovery}`);

  const multi = await User.countDocuments({ "mobileRoles.0": { $exists: true } });
  console.log(`• Accounts with extra personas (mobileRoles): ${multi}`);

  await mongoose.disconnect();
  console.log("\nDone.");
}

main().catch((e) => { console.error("❌", e.message); process.exit(1); });