// scripts/activateProfessional.js
//
// Manually unlock the full Professionals catalogue for one account — the
// "activated by admin" path, no payment required. This flips exactly the
// flags that mobileProfessional.js -> isPaidPro() reads, so the moment the
// user reopens the Learn tab every tier is unlocked.
//
// Usage:
//     node scripts/activateProfessional.js someone@email.com
//     node scripts/activateProfessional.js someone@email.com --plan=professional --days=365
//     node scripts/activateProfessional.js someone@email.com --off        # revoke
//
// Env: reuses MONGO_URI / MONGODB_URI / DATABASE_URL like the rest of the app.

try { await import("dotenv/config"); } catch {}

import mongoose from "mongoose";
import User from "../models/user.js";

const argv = process.argv.slice(2);
const email = (argv.find((a) => !a.startsWith("--")) || "").trim().toLowerCase();
const off = argv.includes("--off");
const planArg = (argv.find((a) => a.startsWith("--plan=")) || "").split("=")[1];
const daysArg = (argv.find((a) => a.startsWith("--days=")) || "").split("=")[1];

const plan = planArg || "professional";
const days = Number(daysArg || 365);

const uri =
  process.env.MONGO_URI ||
  process.env.MONGODB_URI ||
  process.env.DATABASE_URL;

async function main() {
  if (!email) {
    console.error("Usage: node scripts/activateProfessional.js <email> [--plan=professional] [--days=365] [--off]");
    process.exit(1);
  }
  if (!uri) {
    console.error("No Mongo connection string in env (MONGO_URI / MONGODB_URI / DATABASE_URL).");
    process.exit(1);
  }

  await mongoose.connect(uri);
  console.log(`Connected. Looking up ${email} …`);

  const user = await User.findOne({ email: new RegExp(`^${email.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i") });
  if (!user) {
    console.error(`No user with email ${email}. (They must have signed up on the app first.)`);
    await mongoose.disconnect();
    process.exit(1);
  }

  if (off) {
    user.employeeSubscriptionStatus = "trial";
    user.employeeSubscriptionPlan = "none";
    user.employeeFullAccess = false;
    user.employeeSubscriptionExpiresAt = null;
    await user.save();
    console.log(`✅ Revoked. ${email} is back to the free tier (one quiz per module).`);
    await mongoose.disconnect();
    return;
  }

  const now = new Date();
  const expires = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);

  user.employeeSubscriptionStatus = "paid";     // isPaidPro() = true
  user.employeeSubscriptionPlan = plan;         // "professional" (also satisfies isPaidPro)
  user.employeeFullAccess = true;               // belt-and-braces
  user.employeeSubscriptionExpiresAt = expires;
  user.employeePaidAt = now;
  await user.save();

  console.log(`✅ Activated ${email}`);
  console.log(`   plan:    ${plan}`);
  console.log(`   expires: ${expires.toISOString().slice(0, 10)} (${days} days)`);
  console.log(`   Every quiz tier is now unlocked for this account.`);

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error("Activation failed:", err);
  try { await mongoose.disconnect(); } catch {}
  process.exit(1);
});