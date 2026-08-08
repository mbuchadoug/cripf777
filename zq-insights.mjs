/**
 * zq-insights.mjs — ZimQuote database analysis (READ-ONLY)
 * ─────────────────────────────────────────────────────────────────────────────
 * Scans your live collections and prints a full growth/behaviour report, then
 * writes a timestamped JSON snapshot you can keep or chart later.
 *
 * IT NEVER WRITES TO YOUR DATABASE. Every query is a read/aggregate.
 *
 * HOW TO RUN (from your project root, where mongoose is installed):
 *   MONGODB_URI="your-connection-string" node zq-insights.mjs
 *
 * or, if your app already loads a .env with MONGODB_URI / MONGO_URI / DATABASE_URL:
 *   node -r dotenv/config zq-insights.mjs        (if you use CommonJS dotenv)
 *   node --env-file=.env zq-insights.mjs         (Node 20+, native .env)
 *
 * You can also pass the URI as the first argument:
 *   node zq-insights.mjs "mongodb+srv://..."
 *
 * Optional: write a CSV of unmet-demand searches for your sales team:
 *   node zq-insights.mjs --csv
 * ─────────────────────────────────────────────────────────────────────────────
 */

import mongoose from "mongoose";
import fs from "fs";

const URI =
  process.argv.find(a => a.startsWith("mongodb")) ||
  process.env.MONGODB_URI ||
  process.env.MONGO_URI ||
  process.env.MONGODB_URL ||
  process.env.DATABASE_URL ||
  "";

const WRITE_CSV = process.argv.includes("--csv");

if (!URI) {
  console.error(
    "\n❌ No connection string found.\n" +
    "   Run:  MONGODB_URI=\"mongodb+srv://...\" node zq-insights.mjs\n" +
    "   (or pass it as the first argument, or set MONGO_URI/DATABASE_URL)\n"
  );
  process.exit(1);
}

// ── tiny formatting helpers ──────────────────────────────────────────────────
const pct = (n, d) => (d > 0 ? ((n / d) * 100).toFixed(1) + "%" : "—");
const pad = (s, n) => String(s).padEnd(n);
const num = n => (n || 0).toLocaleString("en-US");
const line = (c = "─", n = 66) => c.repeat(n);
function h1(t) { console.log("\n" + line("═")); console.log("  " + t.toUpperCase()); console.log(line("═")); }
function h2(t) { console.log("\n" + t); console.log(line("─", t.length + 2)); }
function bar(n, max, width = 30) {
  if (!max) return "";
  const len = Math.round((n / max) * width);
  return "█".repeat(Math.max(0, len)) + "·".repeat(Math.max(0, width - len));
}
function table(rows) {
  // rows: array of [label, value, extra?]
  const w = Math.min(38, Math.max(...rows.map(r => String(r[0]).length), 6));
  for (const r of rows) {
    console.log("  " + pad(r[0], w) + "  " + pad(r[1], 10) + (r[2] ? "  " + r[2] : ""));
  }
}

// ── resolve real collection names (mongoose lowercases + pluralises) ──────────
async function resolveCollections(db) {
  const existing = (await db.listCollections().toArray()).map(c => c.name);
  const lower = existing.map(n => n.toLowerCase());
  const find = (...cands) => {
    for (const c of cands) {
      const i = lower.indexOf(c.toLowerCase());
      if (i !== -1) return existing[i];
    }
    return null;
  };
  return {
    _all: existing,
    suppliers: find("supplierprofiles", "supplierprofile", "suppliers"),
    schools:   find("schoolprofiles", "schoolprofile", "schools"),
    schoolContacts: find("schoolcontacts", "schoolcontact"),
    phoneContacts:  find("phonecontacts", "phonecontact"),
    searchLogs:     find("searchcommandlogs", "searchcommandlog", "searchlogs"),
    quotes:         find("supplierquotes", "supplierquote"),
    requests:       find("buyerrequests", "buyerrequest"),
  };
}

const safe = async (label, fn) => {
  try { return await fn(); }
  catch (e) { console.log(`  ⚠ ${label}: ${e.message}`); return null; }
};

const report = { generatedAt: new Date().toISOString(), sections: {} };

// ── group/count helper on a collection ───────────────────────────────────────
async function groupCount(col, field, limit = 12, match = {}) {
  return col.aggregate([
    { $match: match },
    { $group: { _id: `$${field}`, n: { $sum: 1 } } },
    { $sort: { n: -1 } },
    { $limit: limit }
  ]).toArray();
}

async function main() {
  console.log("\nConnecting (read-only)…");
  await mongoose.connect(URI, { serverSelectionTimeoutMS: 15000 });
  const db = mongoose.connection.db;
  console.log("✅ Connected to DB:", db.databaseName);

  const C = await resolveCollections(db);
  const now = new Date();
  const daysAgo = d => new Date(now.getTime() - d * 864e5);

  // =========================================================================
  h1("1 · Acquisition — every phone that ever messaged the bot");
  // =========================================================================
  if (C.phoneContacts) {
    const pc = db.collection(C.phoneContacts);
    const total = await pc.countDocuments();
    const last30 = await pc.countDocuments({ firstSeen: { $gte: daysAgo(30) } });
    const last90 = await pc.countDocuments({ firstSeen: { $gte: daysAgo(90) } });
    console.log(`  Total unique contacts: ${num(total)}`);
    console.log(`  New in last 30 days:   ${num(last30)}`);
    console.log(`  New in last 90 days:   ${num(last90)}`);
    report.sections.acquisition = { total, last30, last90 };

    // Daily histogram (last 45 days) — this visually exposes the 3-day ad bursts
    const daily = await safe("daily histogram", () => pc.aggregate([
      { $match: { firstSeen: { $gte: daysAgo(45) } } },
      { $group: { _id: { $dateToString: { format: "%Y-%m-%d", date: "$firstSeen" } }, n: { $sum: 1 } } },
      { $sort: { _id: 1 } }
    ]).toArray());
    if (daily && daily.length) {
      h2("New contacts per day (last 45d) — spikes = your ad days");
      const max = Math.max(...daily.map(d => d.n));
      const activeDays = daily.filter(d => d.n > 0).length;
      for (const d of daily) console.log(`  ${d._id}  ${pad(d.n, 5)} ${bar(d.n, max, 28)}`);
      const spikeDays = daily.filter(d => d.n >= max * 0.4).length;
      console.log(`\n  → ${activeDays}/45 days brought any new contact; ${spikeDays} clear spike day(s).`);
      report.sections.acquisition.dailyActiveDays = activeDays;
      report.sections.acquisition.spikeDays = spikeDays;
    }

    // Monthly signups
    const monthly = await safe("monthly", () => pc.aggregate([
      { $match: { firstSeen: { $type: "date" } } },
      { $group: { _id: { $dateToString: { format: "%Y-%m", date: "$firstSeen" } }, n: { $sum: 1 } } },
      { $sort: { _id: 1 } }, { $limit: 18 }
    ]).toArray());
    if (monthly && monthly.length) {
      h2("New contacts per month");
      const max = Math.max(...monthly.map(m => m.n));
      for (const m of monthly) console.log(`  ${m._id}  ${pad(m.n, 6)} ${bar(m.n, max, 24)}`);
    }

    // What did people type FIRST — raw intent / demand signal
    const firstMsgs = await safe("first messages", () => pc.aggregate([
      { $match: { firstMessage: { $nin: [null, ""] } } },
      { $project: { t: { $toLower: { $trim: { input: "$firstMessage" } } } } },
      { $group: { _id: "$t", n: { $sum: 1 } } },
      { $sort: { n: -1 } }, { $limit: 20 }
    ]).toArray());
    if (firstMsgs && firstMsgs.length) {
      h2("Top 20 first-messages (what people opened the bot to do)");
      firstMsgs.forEach(m => console.log(`  ${pad(m.n, 5)}  ${String(m._id).slice(0, 54)}`));
    }
  } else console.log("  (no phonecontacts collection found)");

  // =========================================================================
  h1("2 · Suppliers — supply side + monetisation funnel");
  // =========================================================================
  if (C.suppliers) {
    const sp = db.collection(C.suppliers);
    const total = await sp.countDocuments();
    const active = await sp.countDocuments({ active: true });
    const verified = await sp.countDocuments({ verified: true });
    console.log(`  Total suppliers: ${num(total)}   Active: ${num(active)} (${pct(active, total)})   Verified: ${num(verified)}`);

    h2("Subscription status (your trial→paid funnel)");
    const byStatus = await groupCount(sp, "subscriptionStatus");
    table(byStatus.map(s => [s._id || "unset", num(s.n), pct(s.n, total)]));
    const paid = byStatus.filter(s => s._id === "active").reduce((a, s) => a + s.n, 0);
    const trial = byStatus.filter(s => s._id === "trial").reduce((a, s) => a + s.n, 0);
    console.log(`\n  → Paid (active): ${num(paid)}   Trial: ${num(trial)}   Trial→Paid ratio: ${pct(paid, paid + trial)}`);

    h2("Plan (monthly vs annual) among paid");
    const byPlan = await groupCount(sp, "subscriptionPlan", 6, { subscriptionStatus: "active" });
    table(byPlan.map(s => [s._id || "unset", num(s.n)]));

    h2("Tier distribution");
    table((await groupCount(sp, "tier")).map(s => [s._id || "unset", num(s.n), pct(s.n, total)]));

    h2("Profile type");
    table((await groupCount(sp, "profileType")).map(s => [s._id || "unset", num(s.n), pct(s.n, total)]));

    h2("Top cities (supply concentration)");
    table((await groupCount(sp, "location.city", 12)).map(s => [s._id || "unknown", num(s.n)]));

    h2("Top categories");
    const cats = await safe("cats", () => sp.aggregate([
      { $unwind: "$categories" },
      { $group: { _id: { $toLower: "$categories" }, n: { $sum: 1 } } },
      { $sort: { n: -1 } }, { $limit: 15 }
    ]).toArray());
    if (cats) table(cats.map(s => [s._id, num(s.n)]));

    h2("Engagement & marketplace activity");
    const eng = await safe("eng", () => sp.aggregate([{ $group: {
      _id: null,
      views: { $sum: "$monthlyViews" },
      orders: { $sum: "$monthlyOrders" },
      completed: { $sum: "$completedOrders" },
      responded: { $sum: "$responseCount" },
      revenue: { $sum: "$monthlyRevenue" },
      linkViews: { $sum: "$zqLinkViews" },
      linkConv: { $sum: "$zqLinkConversions" },
      withOrders: { $sum: { $cond: [{ $gt: ["$monthlyOrders", 0] }, 1, 0] } },
      dead: { $sum: { $cond: [{ $and: [{ $eq: ["$monthlyViews", 0] }, { $eq: ["$monthlyOrders", 0] }] }, 1, 0] } }
    } }]).toArray());
    if (eng && eng[0]) {
      const e = eng[0];
      table([
        ["Monthly profile views", num(e.views)],
        ["Monthly orders", num(e.orders)],
        ["Completed orders (all-time)", num(e.completed)],
        ["Suppliers with ≥1 order", num(e.withOrders), pct(e.withOrders, total)],
        ["Suppliers with 0 views & 0 orders", num(e.dead), pct(e.dead, total)],
        ["Smart-link views", num(e.linkViews)],
        ["Smart-link conversions", num(e.linkConv), pct(e.linkConv, e.linkViews)],
      ]);
      report.sections.suppliers = { total, active, verified, paid, trial, engagement: e };
    }

    h2("Signups per month");
    const smon = await safe("supplier signups", () => sp.aggregate([
      { $match: { createdAt: { $type: "date" } } },
      { $group: { _id: { $dateToString: { format: "%Y-%m", date: "$createdAt" } }, n: { $sum: 1 } } },
      { $sort: { _id: 1 } }, { $limit: 18 }
    ]).toArray());
    if (smon && smon.length) {
      const max = Math.max(...smon.map(m => m.n));
      for (const m of smon) console.log(`  ${m._id}  ${pad(m.n, 5)} ${bar(m.n, max, 24)}`);
    }
  } else console.log("  (no supplierprofiles collection found)");

  // =========================================================================
  h1("3 · Schools — supply side + parent funnel");
  // =========================================================================
  if (C.schools) {
    const sc = db.collection(C.schools);
    const total = await sc.countDocuments();
    const active = await sc.countDocuments({ active: true });
    console.log(`  Total schools: ${num(total)}   Active: ${num(active)} (${pct(active, total)})`);
    h2("Subscription status");
    table((await groupCount(sc, "subscriptionStatus")).map(s => [s._id || "unset", num(s.n), pct(s.n, total)]));
    h2("Tier");
    table((await groupCount(sc, "tier")).map(s => [s._id || "unset", num(s.n)]));
    h2("Top cities");
    table((await groupCount(sc, "city", 12)).map(s => [s._id || "unknown", num(s.n)]));
    const feng = await safe("school eng", () => sc.aggregate([{ $group: {
      _id: null, views: { $sum: "$monthlyViews" }, inq: { $sum: "$inquiries" },
      canView: { $sum: { $cond: ["$canViewContacts", 1, 0] } }
    } }]).toArray());
    if (feng && feng[0]) {
      h2("Parent engagement");
      table([
        ["Monthly profile views", num(feng[0].views)],
        ["Total inquiries", num(feng[0].inq)],
        ["View→inquiry rate", pct(feng[0].inq, feng[0].views)],
        ["Schools with contact-viewer ON", num(feng[0].canView)],
      ]);
      report.sections.schools = { total, active, ...feng[0] };
    }
  } else console.log("  (no schoolprofiles collection found)");

  // =========================================================================
  h1("4 · School contacts — parent view→apply→enrol funnel");
  // =========================================================================
  if (C.schoolContacts) {
    const cc = db.collection(C.schoolContacts);
    const total = await cc.countDocuments();
    const converted = await cc.countDocuments({ converted: true });
    console.log(`  Total parent contacts: ${num(total)}   Applied: ${num(converted)} (${pct(converted, total)})`);
    h2("By source");
    table((await groupCount(cc, "source")).map(s => [s._id || "unset", num(s.n), pct(s.n, total)]));
    h2("By status (admin follow-up)");
    table((await groupCount(cc, "status")).map(s => [s._id || "unset", num(s.n)]));
    h2("Top schools by captured contacts");
    const topS = await safe("top schools", () => cc.aggregate([
      { $group: { _id: "$schoolId", n: { $sum: 1 }, applied: { $sum: { $cond: ["$converted", 1, 0] } } } },
      { $sort: { n: -1 } }, { $limit: 10 }
    ]).toArray());
    if (topS) table(topS.map(s => [String(s._id).slice(-6), num(s.n), `${s.applied} applied`]));
    report.sections.schoolContacts = { total, converted };
  } else console.log("  (no schoolcontacts collection found)");

  // =========================================================================
  h1("5 · Search logs — DEMAND INTELLIGENCE (your recruitment goldmine)");
  // =========================================================================
  if (C.searchLogs) {
    const sl = db.collection(C.searchLogs);
    const total = await sl.countDocuments();
    console.log(`  Total searches logged: ${num(total)}`);

    h2("By flow");
    table((await groupCount(sl, "flow")).map(s => [s._id || "unknown", num(s.n), pct(s.n, total)]));

    h2("By result outcome");
    const byRes = await groupCount(sl, "resultMode");
    table(byRes.map(s => [s._id || "unknown", num(s.n), pct(s.n, total)]));
    const none = byRes.filter(s => ["none", "error"].includes(s._id)).reduce((a, s) => a + s.n, 0);
    console.log(`\n  → ${num(none)} searches returned NOTHING (${pct(none, total)}). Each is unmet demand.`);

    h2("Helped rate");
    const helped = await sl.countDocuments({ helped: true });
    console.log(`  Marked 'helped': ${num(helped)} (${pct(helped, total)})`);

    // THE money query: what people searched for but got zero results
    h2("🔥 Top UNMET-DEMAND searches (0 results) — who to recruit / stock");
    const unmet = await safe("unmet", () => sl.aggregate([
      { $match: { $or: [{ resultMode: { $in: ["none", "error"] } }, { resultCount: { $lte: 0 } }] } },
      { $project: { t: { $toLower: { $trim: { input: { $ifNull: ["$normalizedText", "$rawText"] } } } },
                    city: "$parsed.city" } },
      { $match: { t: { $nin: [null, ""] } } },
      { $group: { _id: "$t", n: { $sum: 1 }, cities: { $addToSet: "$city" } } },
      { $sort: { n: -1 } }, { $limit: 30 }
    ]).toArray());
    if (unmet && unmet.length) {
      unmet.forEach(u => {
        const cities = (u.cities || []).filter(Boolean).slice(0, 3).join(", ");
        console.log(`  ${pad(u.n, 4)}  ${pad(String(u._id).slice(0, 40), 42)} ${cities}`);
      });
      report.sections.unmetDemand = unmet.map(u => ({ term: u._id, count: u.n, cities: (u.cities || []).filter(Boolean) }));
      if (WRITE_CSV) {
        const csv = "term,count,cities\n" + unmet.map(u =>
          `"${String(u._id).replace(/"/g, "'")}",${u.n},"${(u.cities || []).filter(Boolean).join("; ")}"`
        ).join("\n");
        fs.writeFileSync("zq-unmet-demand.csv", csv);
        console.log("\n  📄 Wrote zq-unmet-demand.csv (hand this to your sales team).");
      }
    } else console.log("  (none found — great, or logging is new)");

    h2("Top searched products/services (all searches)");
    const topSearch = await safe("top search", () => sl.aggregate([
      { $project: { t: { $toLower: { $ifNull: ["$parsed.product", { $ifNull: ["$parsed.service", "$normalizedText"] }] } } } },
      { $match: { t: { $nin: [null, ""] } } },
      { $group: { _id: "$t", n: { $sum: 1 } } },
      { $sort: { n: -1 } }, { $limit: 20 }
    ]).toArray());
    if (topSearch) topSearch.forEach(s => console.log(`  ${pad(s.n, 4)}  ${String(s._id).slice(0, 50)}`));

    h2("Top searched cities (geographic demand)");
    const cityDemand = await safe("city demand", () => sl.aggregate([
      { $match: { "parsed.city": { $nin: [null, ""] } } },
      { $group: { _id: { $toLower: "$parsed.city" }, n: { $sum: 1 } } },
      { $sort: { n: -1 } }, { $limit: 12 }
    ]).toArray());
    if (cityDemand) table(cityDemand.map(s => [s._id, num(s.n)]));

    // WHEN are people active — informs when to run your 3 ad-days
    h2("Searches by day-of-week (1=Sun … 7=Sat)");
    const dow = await safe("dow", () => sl.aggregate([
      { $match: { createdAt: { $type: "date" } } },
      { $group: { _id: { $dayOfWeek: "$createdAt" }, n: { $sum: 1 } } }, { $sort: { _id: 1 } }
    ]).toArray());
    if (dow && dow.length) {
      const names = { 1: "Sun", 2: "Mon", 3: "Tue", 4: "Wed", 5: "Thu", 6: "Fri", 7: "Sat" };
      const max = Math.max(...dow.map(d => d.n));
      dow.forEach(d => console.log(`  ${pad(names[d._id] || d._id, 4)} ${pad(d.n, 6)} ${bar(d.n, max, 24)}`));
    }
    h2("Searches by hour-of-day (UTC — shift for CAT +2)");
    const hod = await safe("hod", () => sl.aggregate([
      { $match: { createdAt: { $type: "date" } } },
      { $group: { _id: { $hour: "$createdAt" }, n: { $sum: 1 } } }, { $sort: { _id: 1 } }
    ]).toArray());
    if (hod && hod.length) {
      const max = Math.max(...hod.map(d => d.n));
      hod.forEach(d => console.log(`  ${pad(String(d._id).padStart(2, "0") + "h", 4)} ${pad(d.n, 6)} ${bar(d.n, max, 24)}`));
    }
    report.sections.search = { total, none, helped };
  } else console.log("  (no searchcommandlogs collection found)");

  // =========================================================================
  h1("6 · Quotes — marketplace liquidity");
  // =========================================================================
  if (C.quotes) {
    const q = db.collection(C.quotes);
    const total = await q.countDocuments();
    const seen = await q.countDocuments({ seen: true });
    console.log(`  Total quotes sent: ${num(total)}   Seen by buyer: ${num(seen)} (${pct(seen, total)})`);
    if (C.requests) {
      const reqs = await db.collection(C.requests).countDocuments();
      console.log(`  Buyer requests: ${num(reqs)}   Avg quotes/request: ${(total / Math.max(reqs, 1)).toFixed(2)}`);
      report.sections.marketplace = { quotes: total, seen, requests: reqs };
    }
  } else console.log("  (no supplierquotes collection found)");

  // =========================================================================
  h1("7 · Auto takeaways");
  // =========================================================================
  const t = [];
  const s = report.sections;
  if (s.suppliers) {
    t.push(`Trial→paid conversion is ${pct(s.suppliers.paid, s.suppliers.paid + s.suppliers.trial)} — ${num(s.suppliers.paid)} paid of ${num(s.suppliers.paid + s.suppliers.trial)}.`);
    if (s.suppliers.engagement) {
      t.push(`${pct(s.suppliers.engagement.dead, s.suppliers.total)} of suppliers have 0 views AND 0 orders — dormant listings to re-activate or win back.`);
      t.push(`Smart-link conversion is ${pct(s.suppliers.engagement.linkConv, s.suppliers.engagement.linkViews)} — the organic channel you barely use yet.`);
    }
  }
  if (s.acquisition?.dailyActiveDays != null)
    t.push(`Only ${s.acquisition.dailyActiveDays}/45 recent days brought new contacts — acquisition is bursty (ad-day dependent).`);
  if (s.search) t.push(`${pct(s.search.none, s.search.total)} of searches return nothing — that list is a ready-made supplier-recruitment pipeline.`);
  if (s.schools) t.push(`Schools: ${pct(s.schools.inq, s.schools.views)} view→inquiry rate.`);
  t.forEach((x, i) => console.log(`  ${i + 1}. ${x}`));

  const outfile = `zq-insights-${now.toISOString().slice(0, 10)}.json`;
  fs.writeFileSync(outfile, JSON.stringify(report, null, 2));
  console.log(`\n📦 Full snapshot written to ${outfile}\n`);

  await mongoose.disconnect();
}

main().catch(async e => {
  console.error("\n❌ Error:", e.message);
  try { await mongoose.disconnect(); } catch {}
  process.exit(1);
});
