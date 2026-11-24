// scripts/searchAudit.mjs
// ─── ZimQuote search audit - read-only, changes NOTHING in the database ──────
//
// Run on the server from the project folder:
//   cd /var/www/cripf777
//   node scripts/searchAudit.mjs                       # default queries, Harare
//   node scripts/searchAudit.mjs "electrician" harare   # one query
//   node scripts/searchAudit.mjs "electrician,plumber,cement" bulawayo
//
// Writes the full report to ./search-audit-<date>.txt and prints a summary.
//
// PART A - database health: sellers that can never appear in search and why
//          (inactive, unpaid, suspended, no items, bad city spelling, unknown
//          category ids, wrong profile type...).
// PART B - per query: what the live search returns (with scores), and every
//          seller that LOOKS relevant but is missing - with the exact reason.
// ─────────────────────────────────────────────────────────────────────────────

import "dotenv/config";
import fs from "fs";
import mongoose from "mongoose";

const DEFAULT_QUERIES = [
  "electrician", "plumber", "builder", "welder", "mechanic", "cleaning",
  "cement", "mealie meal", "solar panels", "inverter", "tyres", "cable"
];
const qArg = process.argv[2];
const QUERIES = qArg ? qArg.split(",").map(s => s.trim()).filter(Boolean) : DEFAULT_QUERIES;
const CITY = process.argv[3] ? process.argv[3].replace(/\b\w/g, c => c.toUpperCase()) : "Harare";

const out = [];
const log = (...a) => out.push(a.join(" "));
const realLog = console.log;

const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
if (!uri) { realLog("No MONGODB_URI in .env"); process.exit(1); }
await mongoose.connect(uri);

const { default: SupplierProfile } = await import("../models/supplierProfile.js");
const S  = await import("../services/supplierSearch.js");
const SB = await import("../services/searchBrain.js");
// Built-in + admin categories (Categories page) count as known ids
const { getAllCategories } = await import("../services/categoryRegistry.js");
const CAT_IDS = new Set((await getAllCategories()).map(c => c.id));

const items = s => [
  ...(s.listedProducts || []), ...(s.products || []),
  ...((s.rates || []).map(r => r?.service || ""))
].flatMap(x => String(x || "").split(/[\r\n,]+/)).map(x => x.trim()).filter(x => x && x !== "pending_upload");
const blob = s => [s.businessName, ...(s.categories || []), ...(s.searchTags || []), ...items(s)].join(" | ").toLowerCase();
const short = (s, n = 70) => { s = String(s || ""); return s.length > n ? s.slice(0, n - 1) + "…" : s; };
const isSearchable = s =>
  s.active === true && s.suspended !== true &&
  ["active", "trial"].includes(s.subscriptionStatus) && items(s).length > 0;

const all = await SupplierProfile.find({}).lean();

// ═════════════════════════════════════════════════════════════════════════════
// PART A - DATABASE HEALTH
// ═════════════════════════════════════════════════════════════════════════════
log("═".repeat(78));
log(`ZIMQUOTE SEARCH AUDIT  ${new Date().toISOString()}   city=${CITY}`);
log("═".repeat(78));
log(`\nPART A - DATABASE HEALTH  (${all.length} seller records)\n`);

const count = (arr, f) => arr.reduce((m, x) => { const k = f(x); m[k] = (m[k] || 0) + 1; return m; }, {});
log("By profileType:      ", JSON.stringify(count(all, s => s.profileType || "(none)")));
log("By subscriptionStatus:", JSON.stringify(count(all, s => s.subscriptionStatus || "(none)")));
log("active=true:         ", all.filter(s => s.active).length, "  searchable (active+paid/trial+not suspended+has items):", all.filter(isSearchable).length);

const issues = [];
for (const s of all) {
  if (s.profileType === "biker") continue;
  const why = [];
  if (!s.active) why.push("active=false");
  if (s.suspended) why.push("suspended");
  if (!["active", "trial"].includes(s.subscriptionStatus)) why.push(`subscriptionStatus=${s.subscriptionStatus}`);
  if (s.active && !["active", "trial"].includes(s.subscriptionStatus)) why.push("ACTIVE BUT NOT PAID/TRIAL → hidden from search");
  if (!items(s).length) why.push("NO products/listed items/rates → filtered out");
  if (!(s.categories || []).length) why.push("no categories");
  const badCats = (s.categories || []).filter(c => !CAT_IDS.has(c));
  if (badCats.length) why.push(`unknown category ids: ${badCats.join(",")}`);
  const c = s.location?.city || "";
  if (c !== c.trim() || /\s{2,}/.test(c) || (c && c !== c.replace(/\b\w/g, x => x.toUpperCase()) && c.toLowerCase() === c)) why.push(`city spelling "${c}"`);
  if (s.location?.area && s.location.area.toLowerCase() === c.toLowerCase()) why.push("area = city (no suburb)");
  if (s.profileType === "product" && (s.rates || []).length && !(s.listedProducts || []).length) why.push("profileType=product but only has service rates");
  if (why.length) issues.push({ s, why });
}
log(`\nSellers with issues (${issues.length}):`);
log("name | type | city/area | status | issues");
for (const { s, why } of issues.sort((a, b) => (b.s.active ? 1 : 0) - (a.s.active ? 1 : 0))) {
  log(`- ${short(s.businessName, 40)} | ${s.profileType} | ${s.location?.city}/${s.location?.area} | ${s.active ? "ACTIVE" : "inactive"} ${s.subscriptionStatus} | ${why.join("; ")}`);
}

log("\nDistinct city values (search matches the city name exactly, case-insensitive):");
for (const [c, n] of Object.entries(count(all.filter(s => s.active), s => JSON.stringify(s.location?.city || ""))).sort((a, b) => b[1] - a[1])) {
  log(`  ${c.padEnd(28)} ${n}`);
}

// ═════════════════════════════════════════════════════════════════════════════
// PART B - QUERY AUDIT
// ═════════════════════════════════════════════════════════════════════════════
log(`\n\nPART B - QUERY AUDIT  (city: ${CITY})`);
const summary = [];

for (const q of QUERIES) {
  log("\n" + "─".repeat(78));
  const intent = SB.ruleIntent(q);
  log(`QUERY "${q}"  intent=${intent ? `${intent.kind}/${intent.profileType || "any"} [${intent.categories.join(",")}]` : "none (rules)"}`);
  log(`synonyms: ${S.expandSearchTerms(q).join(", ")}`);

  console.log = () => {}; console.warn = () => {};
  let offers = [];
  try { offers = await S.runSupplierOfferSearch({ city: CITY, product: q, _aiTried: true }); }
  catch (e) { log("  !! SEARCH THREW:", e.stack || e.message); }
  console.log = realLog;

  const shownIds = [];
  for (const o of offers) if (!shownIds.includes(o.supplierId)) shownIds.push(o.supplierId);
  log(`\nRETURNED (${shownIds.length} sellers, in order):`);
  shownIds.forEach((id, i) => {
    const s = all.find(x => String(x._id) === id);
    const best = Math.max(...offers.filter(o => o.supplierId === id).map(o => o.matchScore || 0));
    const firstOffer = offers.find(o => o.supplierId === id);
    log(`  ${i + 1}. ${short(s?.businessName, 38)} [${s?.profileType}] ${s?.location?.city}` +
        ` | itemScore=${best} scoreSupplierMatch=${s ? S.scoreSupplierMatch(s, q) : "?"} intentBonus=${s ? SB.intentBonus(s, intent) : "?"}` +
        ` | shown item: "${short(firstOffer?.product, 40)}"${firstOffer?._nonLocal ? " (other city)" : ""}`);
  });

  // Candidates: any non-biker seller that looks relevant by text or category
  const words = q.toLowerCase().split(/\s+/).filter(w => w.length > 2);
  const stems = new Set(words.flatMap(w => S.stemVariants(w)).filter(v => v.length >= 4));
  const syn = S.expandSearchTerms(q).map(x => x.toLowerCase());
  const cand = all.filter(s => s.profileType !== "biker").filter(s => {
    const b = blob(s);
    const catHit = intent && (s.categories || []).some(c => intent.categories.includes(c));
    const textHit = [...stems].some(st => new RegExp("\\b" + st.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).test(b)) ||
                    syn.slice(0, 4).some(t => t.length > 3 && b.includes(t));
    return catHit || textHit;
  });

  const missing = cand.filter(s => !shownIds.includes(String(s._id)));
  log(`\nLOOKS RELEVANT BUT NOT RETURNED (${missing.length}):`);
  for (const s of missing) {
    const why = [];
    if (!s.active) why.push("inactive");
    if (s.suspended) why.push("suspended");
    if (!["active", "trial"].includes(s.subscriptionStatus)) why.push(`subscription=${s.subscriptionStatus}`);
    if (!items(s).length) why.push("no items listed");
    const sc = (s.location?.city || "").trim().toLowerCase();
    if (sc && sc !== CITY.toLowerCase()) why.push(`city="${s.location?.city}"`);
    if (!why.length) {
      const score = S.scoreSupplierMatch(s, q);
      why.push(`searchable but not matched (scoreSupplierMatch=${score}, intentBonus=${SB.intentBonus(s, intent)}) - items don't mention "${q}"; categories=[${(s.categories || []).join(",")}]`);
    }
    log(`  - ${short(s.businessName, 38)} [${s.profileType}] ${s.location?.city}/${s.location?.area} → ${why.join("; ")}`);
    log(`      items: ${short(items(s).slice(0, 6).join(", "), 110)}`);
  }
  summary.push({ q, returned: shownIds.length, missing: missing.length,
                 fixable: missing.filter(s => isSearchable(s) && (s.location?.city || "").trim().toLowerCase() === CITY.toLowerCase()).length });
}

log("\n" + "═".repeat(78));
log("SUMMARY  (fixable = paid, active, same city, but the search still missed them)");
for (const r of summary) log(`  ${r.q.padEnd(16)} returned=${String(r.returned).padEnd(3)} looks-relevant-but-missing=${String(r.missing).padEnd(3)} fixable=${r.fixable}`);

const file = `search-audit-${new Date().toISOString().slice(0, 10)}.txt`;
fs.writeFileSync(file, out.join("\n"));
realLog(out.slice(-(summary.length + 2)).join("\n"));
realLog(`\nFull report: ${process.cwd()}/${file}  - send me this file.`);
await mongoose.disconnect();
process.exit(0);
