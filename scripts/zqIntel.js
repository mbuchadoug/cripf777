// scripts/zqIntel.js
// ─── ZimQuote Business Intelligence Scanner ──────────────────────────────────
//
// Read-only. Scans the whole MongoDB history (first record → now) and produces:
//   reports/zq-intel/<run>/report.html            human report (open in browser)
//   reports/zq-intel/<run>/summary.json           every computed number
//   reports/zq-intel/<run>/supplier_scorecard.csv every supplier, scored + segmented
//   reports/zq-intel/<run>/conversion_targets.csv unpaid sellers ranked by proof-of-value, with a ready pitch
//   reports/zq-intel/<run>/school_scorecard.csv
//   reports/zq-intel/<run>/lapsed_buyers.csv      people who came, searched, and left - with what they wanted
//   reports/zq-intel/<run>/unmet_demand.csv       searches with zero results (recruit these sellers)
//   reports/zq-intel/<run>/cohort_retention.csv
//   reports/zq-intel/<run>/ai_strategy.md         (only with --ai) Claude's written strategy
//
// Usage (from the project root, e.g. /var/www/cripf777):
//   node scripts/zqIntel.js                      # full history, no AI
//   node scripts/zqIntel.js --ai                 # + Claude strategy memo + playbook (uses ANTHROPIC_API_KEY)
//   node scripts/zqIntel.js --ai --model claude-opus-5-5   # deepest analysis
//   node scripts/zqIntel.js --no-pdf             # skip PDF export (PDFs need puppeteer)
//   node scripts/zqIntel.js --since 2026-01-01   # limit window
//   node scripts/zqIntel.js --uri "mongodb://..." --db cripDB
//
// Env (.env):
//   MONGODB_URI              same one server.js uses
//   ANTHROPIC_API_KEY        only for --ai
//   ZQ_INTEL_MODEL           default claude-sonnet-5-5
//   ZQ_INTEL_EXCLUDE_PHONES  comma list of admin/test numbers to ignore (bot number is always ignored)
//   ZQ_INTEL_PRICES          JSON override, e.g. {"basic":5,"pro":15,"featured":30,"school":10}
//
// Nothing is written to the database. Phone numbers never leave the server:
// the --ai payload contains aggregates and business names only.
// ─────────────────────────────────────────────────────────────────────────────

import fs from "fs";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import dotenv from "dotenv";
import mongoose from "mongoose";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
dotenv.config({ path: path.join(ROOT, ".env") });

// ── CLI ──────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const arg = (name, def = null) => {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return def;
  const v = argv[i + 1];
  return (!v || v.startsWith("--")) ? true : v;
};
const OPT = {
  ai:     !!arg("ai", false),
  model:  arg("model", null),
  since:  arg("since", null),
  uri:    arg("uri", null) || process.env.MONGODB_URI,
  db:     arg("db", null),
  out:    arg("out", null) || path.join(ROOT, "reports", "zq-intel"),
  quiet:  !!arg("quiet", false),
  pdf:    !arg("no-pdf", false)
};

const log = (...a) => { if (!OPT.quiet) console.log("[zq-intel]", ...a); };

// ── Constants ────────────────────────────────────────────────────────────────
const DAY = 86400000;
const TZ_OFFSET_MS = 2 * 3600000;               // Africa/Harare, UTC+2, no DST
const BOT_NUMBER = "263771143904";
const HOT_LEADS_30D = 5;                         // leads in 30 days that make an unpaid seller "hot"

const DEFAULT_PRICES = { basic: 5, pro: 15, featured: 30, school: 10 };

const GREETING_RE = /^(hi+|hey+|hello+|helo|hie|hy|howzit|good\s*(morning|afternoon|evening|day)|menu|start|mhoro|makadii|sawubona|yo|ok|okay|\.)[\s!.,?]*$/i;
const FB_DEFAULT_RE = /can i get more info|i('m| am) interested in this|more information on this|i want to know more/i;

// ── Small helpers ────────────────────────────────────────────────────────────
export function normPhone(p) {
  if (p === null || p === undefined) return "";
  let d = String(p).replace(/\D/g, "");
  if (!d) return "";
  if (d.startsWith("00")) d = d.slice(2);
  if (d.length === 10 && d.startsWith("0")) d = "263" + d.slice(1);
  if (d.length === 9 && d.startsWith("7")) d = "263" + d;
  return d;
}
const idStr = (v) => (v === null || v === undefined) ? "" : String(v);
const toDate = (v) => { if (!v) return null; const d = v instanceof Date ? v : new Date(v); return isNaN(d) ? null : d; };
const localDay = (d) => new Date(d.getTime() + TZ_OFFSET_MS).toISOString().slice(0, 10);
const localHour = (d) => new Date(d.getTime() + TZ_OFFSET_MS).getUTCHours();
const localWeekday = (d) => new Date(d.getTime() + TZ_OFFSET_MS).getUTCDay(); // 0 = Sun
export function weekKey(d) {
  const l = new Date(d.getTime() + TZ_OFFSET_MS);
  const dow = (l.getUTCDay() + 6) % 7;           // Monday = 0
  return new Date(Date.UTC(l.getUTCFullYear(), l.getUTCMonth(), l.getUTCDate() - dow)).toISOString().slice(0, 10);
}
const monthKey = (d) => localDay(d).slice(0, 7);
const daysBetween = (a, b) => Math.floor((b - a) / DAY);
const pct = (n, d) => d ? Math.round((n / d) * 1000) / 10 : 0;
const inc = (obj, k, by = 1) => { obj[k] = (obj[k] || 0) + by; return obj; };
const topN = (obj, n = 20) => Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, n);
const lc = (s) => String(s || "").trim().toLowerCase();

const STOP = new Set(("find a an the in at for of and or to my me i we you near me please need want looking "
  + "buy get sell price prices cost how much where is are can do does any some with from on by "
  + "harare bulawayo mutare chitungwiza gweru masvingo kwekwe kadoma marondera norton ruwa zimbabwe zim "
  + "cheap best good new used supplier suppliers shop shops service services hi hello menu").split(/\s+/));

export function tokens(text) {
  return lc(text).replace(/[^a-z0-9\s]/g, " ").split(/\s+/)
    .filter(t => t.length >= 3 && !STOP.has(t) && !/^\d+$/.test(t))
    .map(t => (t.length > 4 && t.endsWith("s") && !t.endsWith("ss")) ? t.slice(0, -1) : t);
}

const csvCell = (v) => {
  if (v === null || v === undefined) return "";
  const s = Array.isArray(v) ? v.join("; ") : (v instanceof Date ? v.toISOString() : String(v));
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
function writeCsv(file, rows, cols) {
  const head = cols.map(c => c.label || c.key).join(",");
  const body = rows.map(r => cols.map(c => csvCell(typeof c.get === "function" ? c.get(r) : r[c.key])).join(","));
  fs.writeFileSync(file, "\uFEFF" + [head, ...body].join("\r\n"), "utf8");
}

// A search "failed" if it returned nothing (logged as none/error, or a count of 0 on a result mode).
export const isZeroResult = (s) => ["none", "error"].includes(s?.resultMode) ||
  (Number(s?.resultCount) === 0 && ["offers", "suppliers", "schools"].includes(s?.resultMode));

// ── Time-frame engine for conversion targets ─────────────────────────────────
// Every seller's buyer touches are stored as day numbers (days since 2024-01-01,
// Harare time) so any window - 7 days, a month, all time, or a custom range - can
// be computed without the database. These three functions are self-contained on
// purpose: the report page runs the exact same code in the browser.
const TL_DAY0 = Date.UTC(2024, 0, 1);
const dayIndex = (d) => Math.floor((new Date(localDay(d) + "T00:00:00Z").getTime() - TL_DAY0) / DAY);

export function zqRangeStats(T, from, to) {
  var lo = from == null ? -1e9 : from, hi = to == null ? 1e9 : to, out = [];
  for (var k = 0; k < T.sellers.length; k++) {
    var x = T.sellers[k], seen = {}, seenN = 0, times = 0, vis = {}, visN = 0, req = 0, ord = 0, mkt = 0, i, d;
    for (i = 0; i < x.s.length; i += 2) { d = x.s[i]; if (d < lo || d > hi) continue; times++; if (!seen[x.s[i + 1]]) { seen[x.s[i + 1]] = 1; seenN++; } }
    for (i = 0; i < x.v.length; i += 2) { d = x.v[i]; if (d < lo || d > hi) continue; if (!vis[x.v[i + 1]]) { vis[x.v[i + 1]] = 1; visN++; } }
    for (i = 0; i < x.r.length; i++) if (x.r[i] >= lo && x.r[i] <= hi) req++;
    for (i = 0; i < x.o.length; i++) if (x.o[i] >= lo && x.o[i] <= hi) ord++;
    for (i = 0; i < x.m.length; i += 2) if (x.m[i] >= lo && x.m[i] <= hi) mkt += x.m[i + 1];
    var leads = seenN + visN + req + ord;
    out.push({ k: k, seen: seenN, times: times, vis: visN, req: req, ord: ord, mkt: mkt, leads: leads,
      proof: Math.round((leads * 3 + ord * 10 + Math.min(mkt, 30) * 0.5) * 10) / 10 });
  }
  return out.sort(function (a, b) { return b.proof - a.proof || b.mkt - a.mkt; });
}

export function zqRangeLabel(T, from, to) {
  var M = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  var fmt = function (d) { var t = new Date(T.day0ms + d * 86400000); return t.getUTCDate() + " " + M[t.getUTCMonth()] + " " + t.getUTCFullYear(); };
  if (from == null && to == null) return "since you joined ZimQuote";
  if (from == null) return "up to " + fmt(to) + ",";
  if (to == null || to >= T.today) return "in the last " + (T.today - from + 1) + " days";
  return "between " + fmt(from) + " and " + fmt(to) + ",";
}

export function zqRangePitch(x, st, label) {
  var name = x.n || "there", bits = [], proof;
  if (st.seen) bits.push(st.seen + " buyer" + (st.seen === 1 ? "" : "s") + " saw " + name + " in ZimQuote search results");
  if (st.vis) bits.push(st.vis + " opened your ZimQuote link");
  if (st.req) bits.push(st.req + " buyer request" + (st.req === 1 ? " was" : "s were") + " sent to you");
  if (st.ord) bits.push("you received " + st.ord + " order" + (st.ord === 1 ? "" : "s"));
  if (bits.length) proof = label + " " + bits.join(", ") + ".";
  else if (st.mkt) proof = label + " people" + (x.c ? " in " + x.c : "") + " searched ZimQuote " + st.mkt + " time" + (st.mkt === 1 ? "" : "s") + " for what you sell.";
  else return "";
  var fix = x.pr === 0 ? " Add your prices so buyers can order straight away." : "";
  var when = (x.de !== null && x.de !== undefined && x.de >= 0 && x.de <= 30)
    ? (x.de === 0 ? " Your free listing ends today." : " Your free listing ends in " + x.de + " day" + (x.de === 1 ? "" : "s") + ".")
    : (x.seg === "lapsed_payer" ? " Your listing has lapsed." : " Your free trial period is over.");
  return "Hi " + name + ", " + proof + fix + when + " Keep receiving these buyers for $" + x.p + "/month - reply PAY and we'll send the EcoCash prompt.";
}

// Day number <-> YYYY-MM-DD
export const tlDayFromIso = (iso) => iso ? Math.floor((Date.parse(iso + "T00:00:00Z") - TL_DAY0) / DAY) : null;
export const tlIsoFromDay = (d) => new Date(TL_DAY0 + d * DAY).toISOString().slice(0, 10);

// ── Entry-channel classifier (what the person typed / tapped first) ─────────
export function classifyEntry(text) {
  const t = String(text || "").trim();
  if (!t) return { channel: "unknown", detail: "" };
  let m;
  if ((m = t.match(/^ZQ:GROUP:([a-z0-9_-]+)/i)))  return { channel: "web_seo_page", detail: m[1].toLowerCase() };
  if (/^ZQ:SGROUP:/i.test(t))                     return { channel: "web_seo_page", detail: "schools" };
  if (/^ZQ:TGROUP:/i.test(t))                     return { channel: "web_seo_page", detail: "tutors" };
  if ((m = t.match(/^ZQ:S:([a-z0-9_-]+)/i)))      return { channel: "seller_smart_link", detail: m[1].toLowerCase() };
  if (/^ZQ:STAFF/i.test(t))                       return { channel: "seller_smart_link", detail: "staff_card" };
  if (/^ZQ:SUPPLIER:/i.test(t))                   return { channel: "seller_smart_link", detail: "supplier_id" };
  if (/^ZQ:SCHOOL/i.test(t))                      return { channel: "school_smart_link", detail: "" };
  if (/^ZQ:REGISTER/i.test(t))                    return { channel: "web_list_business", detail: "" };
  if (/^ZQ:REQUEST/i.test(t))                     return { channel: "request_link", detail: "" };
  if (/^ZQ:/i.test(t))                            return { channel: "other_deep_link", detail: t.slice(0, 30) };
  if (FB_DEFAULT_RE.test(t))                      return { channel: "facebook_ad_default", detail: "" };
  if (/^(find|i want|register my school|looking for)\b/i.test(t) && t.split(/\s+/).length <= 7)
                                                  return { channel: "web_tool_prefill", detail: lc(t).slice(0, 40) };
  if (GREETING_RE.test(t))                        return { channel: "greeting_only", detail: lc(t) };
  return { channel: "typed_request", detail: lc(t).slice(0, 40) };
}

const CHANNEL_LABEL = {
  web_seo_page: "Website SEO pages (ZQ:GROUP)",
  web_tool_prefill: "Website tools / prefilled search",
  web_list_business: "Website 'list your business'",
  seller_smart_link: "A seller's smart link / QR",
  school_smart_link: "A school's smart link / QR",
  request_link: "Request link",
  other_deep_link: "Other ZQ deep link",
  facebook_ad_default: "Facebook click-to-WhatsApp ad",
  greeting_only: "Just 'Hi' (ads, word of mouth, unknown)",
  typed_request: "Typed a request directly",
  unknown: "Unknown"
};

// ── Collections ──────────────────────────────────────────────────────────────
// Prefer the real model's collection name; fall back to Mongoose's default
// pluralised names. Missing collections are simply skipped.
const COLLECTIONS = {
  suppliers:      { model: "supplierProfile.js",             names: ["supplierprofiles"] },
  schools:        { model: "schoolProfile.js",               names: ["schoolprofiles"] },
  searches:       { model: "searchCommandLog.js",            names: ["searchcommandlogs"] },
  contacts:       { model: "phoneContact.js",                names: ["phonecontacts"] },
  schoolContacts: { model: "schoolContact.js",               names: ["schoolcontacts"] },
  schoolLeads:    { model: "schoolLead.js",                  names: ["schoolleads"] },
  linkVisitors:   { model: "supplierLinkVisitor.js",         names: ["supplierlinkvisitors"] },
  orders:         { model: "supplierOrder.js",               names: ["supplierorders"] },
  requests:       { model: "buyerRequest2.js",               names: ["buyerrequests", "buyerrequest2s"] },
  supPayments:    { model: "supplierSubscriptionPayment.js", names: ["suppliersubscriptionpayments"] },
  schoolPayments: { model: "schoolSubscriptionPayment.js",   names: ["schoolsubscriptionpayments"] },
  bizPayments:    { model: "subscriptionPayment.js",         names: ["subscriptionpayments"] },
  sessions:       { model: "userSession.js",                 names: ["usersessions"] }
};

const PROJECTIONS = {
  suppliers: { phone: 1, businessName: 1, location: 1, categories: 1, products: 1, listedProducts: 1, prices: 1,
    rates: 1, tier: 1, subscriptionStatus: 1, subscriptionStartedAt: 1, subscriptionEndsAt: 1, subscriptionPlan: 1,
    active: 1, verified: 1, suspended: 1, viewCount: 1, monthlyViews: 1, zqSlug: 1, zqLinkViews: 1,
    zqLinkConversions: 1, zqSourceViews: 1, profileType: 1, subjects: 1, tourismSubtype: 1, smartLinkPitch: 1,
    smartLinkFlyers: 1, brochures: 1, priceUpdatedAt: 1, lastRespondedAt: 1, completedOrders: 1, rating: 1,
    reviewCount: 1, savedBy: 1, createdAt: 1, updatedAt: 1, notificationContacts: 1 },
  schools: { phone: 1, contactPhone: 1, schoolName: 1, city: 1, suburb: 1, institutionType: 1, type: 1, feeRange: 1,
    active: 1, tier: 1, subscriptionPlan: 1, subscriptionEndsAt: 1, zqSlug: 1, zqLinkViews: 1, zqLinkConversions: 1,
    monthlyViews: 1, inquiries: 1, admissionsOpen: 1, smartLinkPitch: 1, smartLinkFlyers: 1, brochures: 1,
    schoolFees: 1, createdAt: 1, updatedAt: 1, notificationContacts: 1 },
  searches: { phone: 1, rawText: 1, normalizedText: 1, source: 1, flow: 1, parsed: 1, resultMode: 1,
    resultCount: 1, "resultsPreview.supplierId": 1, helped: 1, createdAt: 1 },
  contacts: { phone: 1, firstSeen: 1, firstMessage: 1, channel: 1, createdAt: 1 },
  schoolContacts: { schoolId: 1, phone: 1, source: 1, firstSeen: 1, lastSeen: 1, viewCount: 1, converted: 1,
    appliedAt: 1, status: 1, gradeInterest: 1, createdAt: 1 },
  schoolLeads: { schoolId: 1, phone: 1, source: 1, actionType: 1, contacted: 1, createdAt: 1 },
  linkVisitors: { supplierId: 1, staffCardId: 1, linkType: 1, phone: 1, source: 1, firstSeen: 1, lastSeen: 1,
    converted: 1, viewCount: 1, visitCount: 1, createdAt: 1, updatedAt: 1 },
  orders: { supplierId: 1, supplierPhone: 1, buyerPhone: 1, totalAmount: 1, currency: 1, status: 1, createdAt: 1 },
  requests: { buyerPhone: 1, requestType: 1, profileType: 1, rawText: 1, "items.product": 1, "items.name": 1,
    city: 1, area: 1, status: 1, notifiedSuppliers: 1, "responses.supplierId": 1, "responses.supplierPhone": 1,
    createdAt: 1 },
  supPayments: { supplierPhone: 1, supplierId: 1, tier: 1, plan: 1, amount: 1, currency: 1, reference: 1,
    status: 1, paidAt: 1, ecocashPhone: 1, createdAt: 1 },
  schoolPayments: { phone: 1, schoolId: 1, tier: 1, plan: 1, amount: 1, currency: 1, reference: 1, status: 1,
    paidAt: 1, endsAt: 1, createdAt: 1 },
  bizPayments: { businessId: 1, packageKey: 1, amount: 1, currency: 1, reference: 1, status: 1, ecocashPhone: 1,
    createdAt: 1 },
  sessions: { phone: 1, updatedAt: 1, createdAt: 1 }
};

async function resolveCollectionNames(db) {
  const existing = new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map(c => c.name));
  const resolved = {};
  for (const [key, spec] of Object.entries(COLLECTIONS)) {
    let name = null;
    try {
      const modPath = path.join(ROOT, "models", spec.model);
      if (fs.existsSync(modPath)) {
        const mod = await import(pathToFileURL(modPath).href);
        const n = mod?.default?.collection?.collectionName;
        if (n && existing.has(n)) name = n;
      }
    } catch { /* model import is best-effort */ }
    if (!name) name = spec.names.find(n => existing.has(n)) || null;
    resolved[key] = name;
  }
  return { resolved, existing: [...existing].sort() };
}

export async function loadData(db, { since = null } = {}) {
  const { resolved, existing } = await resolveCollectionNames(db);
  const data = { _collections: resolved, _allCollections: existing };
  for (const key of Object.keys(COLLECTIONS)) {
    const name = resolved[key];
    if (!name) { data[key] = []; log(`  - ${key}: (collection not found, skipped)`); continue; }
    const filter = {};
    // Only event-style collections are windowed; profiles are always loaded in full.
    if (since && ["searches", "contacts", "linkVisitors", "orders", "requests", "schoolContacts", "schoolLeads"].includes(key)) {
      filter.createdAt = { $gte: since };
    }
    data[key] = await db.collection(name).find(filter, { projection: PROJECTIONS[key] }).toArray();
    log(`  - ${key}: ${data[key].length} docs from "${name}"`);
  }
  return data;
}

// ── Plan prices ──────────────────────────────────────────────────────────────
async function loadPrices() {
  const prices = { ...DEFAULT_PRICES };
  for (const rel of ["services/supplierPlans.js", "routes/supplierPlans.js", "supplierPlans.js", "lib/supplierPlans.js"]) {
    const p = path.join(ROOT, rel);
    if (!fs.existsSync(p)) continue;
    try {
      const mod = await import(pathToFileURL(p).href);
      const SP = mod.SUPPLIER_PLANS || mod.default?.SUPPLIER_PLANS;
      if (SP) {
        for (const tier of ["basic", "pro", "featured"]) {
          const m = SP[tier]?.monthly?.price;
          if (typeof m === "number" && m > 0) prices[tier] = m;
        }
        log(`  plan prices read from ${rel}`);
        break;
      }
    } catch { /* ignore */ }
  }
  if (process.env.ZQ_INTEL_PRICES) {
    try { Object.assign(prices, JSON.parse(process.env.ZQ_INTEL_PRICES)); } catch { log("  ZQ_INTEL_PRICES is not valid JSON - ignored"); }
  }
  return prices;
}

// A payment only counts as real money if it has an amount and isn't an
// admin-granted trial record (those are logged as status "paid", amount 0).
export function isRealPayment(p) {
  const ok = ["paid", "completed", "success", "successful"].includes(lc(p.status));
  const amt = Number(p.amount) || 0;
  const ref = String(p.reference || "");
  return ok && amt > 0 && !/^ADMIN_/i.test(ref) && p.ecocashPhone !== "admin-registered";
}

// ═════════════════════════════════════════════════════════════════════════════
// ANALYSIS (pure - takes loaded arrays, returns a summary object)
// ═════════════════════════════════════════════════════════════════════════════
export function analyze(data, { now = new Date(), prices = DEFAULT_PRICES, excludePhones = [] } = {}) {
  const NOW = now.getTime();
  const D7 = NOW - 7 * DAY, D30 = NOW - 30 * DAY, D90 = NOW - 90 * DAY;

  const suppliers = data.suppliers || [];
  const schools = data.schools || [];
  const searches = (data.searches || []).filter(s => toDate(s.createdAt));

  // ── Who is a seller (excluded from buyer metrics) ─────────────────────────
  const sellerPhones = new Set([BOT_NUMBER, ...excludePhones.map(normPhone)]);
  for (const s of suppliers) {
    sellerPhones.add(normPhone(s.phone));
    (s.notificationContacts || []).forEach(p => sellerPhones.add(normPhone(p)));
  }
  for (const s of schools) {
    sellerPhones.add(normPhone(s.phone)); sellerPhones.add(normPhone(s.contactPhone));
    (s.notificationContacts || []).forEach(p => sellerPhones.add(normPhone(p)));
  }
  sellerPhones.delete("");
  const isBuyer = (p) => p && !sellerPhones.has(p);

  // ── Build a per-person timeline ───────────────────────────────────────────
  const people = new Map();
  const person = (phone) => {
    let p = people.get(phone);
    if (!p) { p = { phone, first: null, last: null, days: new Set(), searches: [], entry: null, entryText: "",
      linkVisits: 0, schoolVisits: 0, requests: 0, orders: 0 }; people.set(phone, p); }
    return p;
  };
  const touch = (p, d, countsAsActiveDay = true) => {
    if (!d) return;
    if (!p.first || d < p.first) p.first = d;
    if (!p.last || d > p.last) p.last = d;
    if (countsAsActiveDay) p.days.add(localDay(d));
  };

  for (const c of data.contacts || []) {
    const ph = normPhone(c.phone); if (!isBuyer(ph)) continue;
    const p = person(ph); const d = toDate(c.firstSeen) || toDate(c.createdAt);
    touch(p, d);
    p.entryText = c.firstMessage || "";
  }
  for (const s of searches) {
    const ph = normPhone(s.phone); if (!isBuyer(ph)) continue;
    const p = person(ph); const d = toDate(s.createdAt);
    touch(p, d);
    p.searches.push(s);
  }
  for (const v of data.linkVisitors || []) {
    const ph = normPhone(v.phone); if (!isBuyer(ph)) continue;
    const p = person(ph);
    touch(p, toDate(v.firstSeen) || toDate(v.createdAt));
    touch(p, toDate(v.lastSeen) || toDate(v.updatedAt));
    p.linkVisits++;
  }
  for (const v of data.schoolContacts || []) {
    const ph = normPhone(v.phone); if (!isBuyer(ph)) continue;
    const p = person(ph);
    touch(p, toDate(v.firstSeen) || toDate(v.createdAt));
    touch(p, toDate(v.lastSeen));
    p.schoolVisits++;
  }
  for (const r of data.requests || []) {
    const ph = normPhone(r.buyerPhone); if (!isBuyer(ph)) continue;
    const p = person(ph); touch(p, toDate(r.createdAt)); p.requests++;
  }
  for (const o of data.orders || []) {
    const ph = normPhone(o.buyerPhone); if (!isBuyer(ph)) continue;
    const p = person(ph); touch(p, toDate(o.createdAt)); p.orders++;
  }
  for (const s of data.sessions || []) {
    const ph = normPhone(s.phone); if (!people.has(ph)) continue;   // sessions only extend known people
    touch(people.get(ph), toDate(s.updatedAt), false);
  }

  const allPeople = [...people.values()].filter(p => p.first);
  for (const p of allPeople) {
    p.searches.sort((a, b) => toDate(a.createdAt) - toDate(b.createdAt));
    const firstText = p.entryText || (p.searches[0] && (p.searches[0].rawText || p.searches[0].normalizedText)) || "";
    p.entry = classifyEntry(firstText);
    p.activeDays = p.days.size;
    p.returned7 = p.last && (p.last - p.first) >= 7 * DAY && p.activeDays >= 2;
    p.returnedAny = p.activeDays >= 2;
  }

  // ── Acquisition ───────────────────────────────────────────────────────────
  const newByWeek = {}, newByMonth = {}, channelTotals = {}, channelByMonth = {}, channelReturn = {}, seoPages = {};
  for (const p of allPeople) {
    const w = weekKey(p.first), m = monthKey(p.first), ch = p.entry.channel;
    inc(newByWeek, w); inc(newByMonth, m); inc(channelTotals, ch);
    channelByMonth[m] = channelByMonth[m] || {}; inc(channelByMonth[m], ch);
    channelReturn[ch] = channelReturn[ch] || { people: 0, returned: 0, searched: 0 };
    channelReturn[ch].people++;
    if (p.returnedAny) channelReturn[ch].returned++;
    if (p.searches.length) channelReturn[ch].searched++;
    if (ch === "web_seo_page") inc(seoPages, p.entry.detail);
  }
  const linkSources = {};
  for (const v of data.linkVisitors || []) inc(linkSources, lc(v.source) || "direct");
  for (const s of suppliers) {
    // zqSourceViews counts every open (not unique) - shown separately
    for (const [k, n] of Object.entries(s.zqSourceViews || {})) inc(linkSources, `opens:${lc(k)}`, Number(n) || 0);
  }

  // ── Activity / retention ──────────────────────────────────────────────────
  const activeByWeek = {};
  for (const p of allPeople) for (const d of p.days) inc(activeByWeek, weekKey(new Date(d + "T12:00:00Z")));
  const wau = allPeople.filter(p => p.last >= D7).length;
  const mau = allPeople.filter(p => p.last >= D30).length;
  const oneAndDone = allPeople.filter(p => p.activeDays <= 1).length;
  const activeDayHist = { "1": 0, "2": 0, "3-4": 0, "5-9": 0, "10+": 0 };
  for (const p of allPeople) {
    const n = p.activeDays;
    inc(activeDayHist, n <= 1 ? "1" : n === 2 ? "2" : n <= 4 ? "3-4" : n <= 9 ? "5-9" : "10+");
  }

  // Weekly cohorts: % of each first-week cohort active N weeks later
  const cohorts = {};
  const OFFSETS = [1, 2, 4, 8, 12];
  for (const p of allPeople) {
    const ck = weekKey(p.first);
    const c = cohorts[ck] = cohorts[ck] || { week: ck, size: 0, hits: Object.fromEntries(OFFSETS.map(o => [o, 0])) };
    c.size++;
    const weeks = new Set([...p.days].map(d => weekKey(new Date(d + "T12:00:00Z"))));
    for (const o of OFFSETS) {
      const target = new Date(new Date(ck + "T00:00:00Z").getTime() + o * 7 * DAY).toISOString().slice(0, 10);
      if (weeks.has(target)) c.hits[o]++;
    }
  }
  const cohortRows = Object.values(cohorts).sort((a, b) => a.week.localeCompare(b.week)).map(c => {
    const row = { week: c.week, size: c.size };
    for (const o of OFFSETS) {
      const target = new Date(c.week + "T00:00:00Z").getTime() + o * 7 * DAY;
      row[`w${o}`] = target > NOW ? null : pct(c.hits[o], c.size);
    }
    return row;
  });

  // Does a failed first search kill retention?
  const firstResult = { found: { people: 0, returned: 0 }, none: { people: 0, returned: 0 } };
  for (const p of allPeople) {
    const s = p.searches[0]; if (!s) continue;
    const k = isZeroResult(s) ? "none" : "found";
    firstResult[k].people++; if (p.returnedAny) firstResult[k].returned++;
  }

  // ── Demand (searches) ─────────────────────────────────────────────────────
  const buyerSearches = searches.filter(s => isBuyer(normPhone(s.phone)));
  const isDeepLink = (s) => /^zq:/i.test(String(s.rawText || s.normalizedText || ""));
  const realSearches = buyerSearches.filter(s => !isDeepLink(s) && !GREETING_RE.test(String(s.rawText || "").trim()));
  const searchesByWeek = {}, byFlow = {}, bySource = {}, byMode = {}, byCity = {}, terms = {}, termPeople = {},
    parsedWhat = {}, heat = Array.from({ length: 7 }, () => Array(24).fill(0));
  const zero = {};          // key term|city → { term, city, count, people:Set, last }
  for (const s of buyerSearches) {
    const d = toDate(s.createdAt);
    inc(searchesByWeek, weekKey(d)); inc(byFlow, s.flow || "unknown"); inc(bySource, s.source || "unknown");
    inc(byMode, s.resultMode || "unknown");
    heat[localWeekday(d)][localHour(d)]++;
  }
  for (const s of realSearches) {
    const city = lc(s.parsed?.city) || "(no city)";
    inc(byCity, city);
    const term = lc(s.parsed?.product || s.parsed?.service || s.normalizedText || s.rawText).slice(0, 60);
    if (term) {
      inc(terms, term);
      (termPeople[term] = termPeople[term] || new Set()).add(normPhone(s.phone));
    }
    const what = lc(s.parsed?.category || s.parsed?.service || s.parsed?.product);
    if (what) inc(parsedWhat, what);
    if (isZeroResult(s)) {
      const key = `${term}|${city}`;
      const z = zero[key] = zero[key] || { term, city, count: 0, people: new Set(), last: null, flow: s.flow };
      z.count++; z.people.add(normPhone(s.phone));
      const dd = toDate(s.createdAt); if (!z.last || dd > z.last) z.last = dd;
    }
  }
  const zeroRows = Object.values(zero).map(z => ({ ...z, people: z.people.size }))
    .sort((a, b) => b.people - a.people || b.count - a.count);
  const searchesPerSearcher = { "1": 0, "2-3": 0, "4-9": 0, "10+": 0 };
  const bySearcher = {};
  for (const s of realSearches) inc(bySearcher, normPhone(s.phone));
  for (const n of Object.values(bySearcher)) inc(searchesPerSearcher, n === 1 ? "1" : n <= 3 ? "2-3" : n <= 9 ? "4-9" : "10+");

  // Inverted index token → search indices (for "market size" per seller)
  const tokIndex = new Map();
  realSearches.forEach((s, i) => {
    for (const t of new Set(tokens(`${s.normalizedText || s.rawText || ""} ${s.parsed?.product || ""} ${s.parsed?.service || ""} ${s.parsed?.category || ""}`))) {
      let arr = tokIndex.get(t); if (!arr) tokIndex.set(t, arr = []); arr.push(i);
    }
  });

  // ── Supplier scorecard ────────────────────────────────────────────────────
  // timeline: supplierId → { s:[day,buyer,...], v:[day,buyer,...], r:[day...], o:[day...], m:{day:count} }
  const tl = {}, tlx = (id) => tl[id] || (tl[id] = { s: [], v: [], r: [], o: [], m: {} });
  const buyerNo = new Map(), bno = (ph) => { let n = buyerNo.get(ph); if (n === undefined) { n = buyerNo.size; buyerNo.set(ph, n); } return n; };
  const appear = {};            // supplierId → { all, d30, people:Set, people30:Set }
  for (const s of buyerSearches) {
    const d = toDate(s.createdAt), ph = normPhone(s.phone), di = dayIndex(d), bn = bno(ph);
    const seenHere = new Set();
    for (const r of s.resultsPreview || []) {
      const id = idStr(r.supplierId); if (!id) continue;
      if (!seenHere.has(id)) { seenHere.add(id); tlx(id).s.push(di, bn); }
      const a = appear[id] = appear[id] || { all: 0, d30: 0, people: new Set(), people30: new Set() };
      a.all++; a.people.add(ph);
      if (d >= D30) { a.d30++; a.people30.add(ph); }
    }
  }
  const visitors = {};
  for (const v of data.linkVisitors || []) {
    const id = idStr(v.supplierId); if (!id) continue;
    const ph = normPhone(v.phone); if (!isBuyer(ph)) continue;
    const x = visitors[id] = visitors[id] || { unique: new Set(), d30: new Set(), converted: 0, sources: {} };
    x.unique.add(ph);
    const last = toDate(v.lastSeen) || toDate(v.updatedAt) || toDate(v.createdAt);
    const first = toDate(v.firstSeen) || toDate(v.createdAt) || last;
    if (first) tlx(id).v.push(dayIndex(first), bno(ph));
    if (last && first && localDay(last) !== localDay(first)) tlx(id).v.push(dayIndex(last), bno(ph));
    if (last && last >= D30) x.d30.add(ph);
    if (v.converted) x.converted++;
    inc(x.sources, lc(v.source) || "direct");
  }
  const reqNotified = {}, reqResponded = {};
  for (const r of data.requests || []) {
    const d = toDate(r.createdAt);
    for (const id of r.notifiedSuppliers || []) {
      const k = idStr(id); const x = reqNotified[k] = reqNotified[k] || { all: 0, d30: 0 };
      x.all++; if (d >= D30) x.d30++;
      if (d) tlx(k).r.push(dayIndex(d));
    }
    for (const resp of r.responses || []) inc(reqResponded, idStr(resp.supplierId));
  }
  const ordersBy = {};
  for (const o of data.orders || []) {
    const k = idStr(o.supplierId); const x = ordersBy[k] = ordersBy[k] || { all: 0, d30: 0, value: 0 };
    x.all++; if (toDate(o.createdAt) >= D30) x.d30++; x.value += Number(o.totalAmount) || 0;
    if (toDate(o.createdAt)) tlx(k).o.push(dayIndex(toDate(o.createdAt)));
  }
  const paidBy = {}, paymentsByMonth = {}, paymentsTotal = { count: 0, amount: 0, adminTrials: 0, pending: 0 };
  const supById = new Map(suppliers.map(s => [idStr(s._id), s]));
  const supByPhone = new Map(suppliers.map(s => [normPhone(s.phone), s]));
  for (const p of data.supPayments || []) {
    if (isRealPayment(p)) {
      const sup = supById.get(idStr(p.supplierId)) || supByPhone.get(normPhone(p.supplierPhone));
      const k = sup ? idStr(sup._id) : `phone:${normPhone(p.supplierPhone)}`;
      const x = paidBy[k] = paidBy[k] || { amount: 0, count: 0, last: null };
      x.amount += Number(p.amount); x.count++;
      const d = toDate(p.paidAt) || toDate(p.createdAt); if (d && (!x.last || d > x.last)) x.last = d;
      if (d) inc(paymentsByMonth, monthKey(d), Number(p.amount));
      paymentsTotal.count++; paymentsTotal.amount += Number(p.amount);
    } else if (lc(p.status) === "pending") paymentsTotal.pending++;
    else paymentsTotal.adminTrials++;
  }

  const supplierRows = suppliers.map(s => {
    const id = idStr(s._id);
    const a = appear[id] || { all: 0, d30: 0, people: new Set(), people30: new Set() };
    const v = visitors[id] || { unique: new Set(), d30: new Set(), converted: 0, sources: {} };
    const rq = reqNotified[id] || { all: 0, d30: 0 };
    const od = ordersBy[id] || { all: 0, d30: 0, value: 0 };
    const pay = paidBy[id] || null;
    const ends = toDate(s.subscriptionEndsAt);
    const city = lc(s.location?.city);

    // market: buyer searches (30d) matching this seller's keywords, same city or no city
    const kw = new Set(tokens([...(s.categories || []), ...(s.subjects || []), ...(s.tourismSubtype || []),
      ...(s.products || []).slice(0, 40), ...(s.listedProducts || []).slice(0, 40),
      ...(s.rates || []).map(r => r.service)].join(" ")));
    const hitIdx = new Set();
    for (const t of kw) for (const i of tokIndex.get(t) || []) hitIdx.add(i);
    let market30 = 0, marketAll = 0; const marketPeople30 = new Set(); const marketTerms = {};
    for (const i of hitIdx) {
      const sr = realSearches[i]; const sc = lc(sr.parsed?.city);
      if (sc && city && sc !== city) continue;
      marketAll++;
      { const md = tlx(id).m, dd = dayIndex(toDate(sr.createdAt)); md[dd] = (md[dd] || 0) + 1; }
      if (toDate(sr.createdAt) >= D30) {
        market30++; marketPeople30.add(normPhone(sr.phone));
        inc(marketTerms, lc(sr.parsed?.product || sr.parsed?.service || sr.normalizedText || sr.rawText).slice(0, 40));
      }
    }

    const priceCount = (s.prices || []).length + (s.rates || []).length;
    const completeness =
      (priceCount >= 5 ? 30 : priceCount > 0 ? 15 : 0) +
      ((s.products || []).length + (s.listedProducts || []).length > 0 ? 15 : 0) +
      (s.zqSlug ? 15 : 0) + (s.smartLinkPitch ? 15 : 0) +
      ((s.smartLinkFlyers || []).length ? 15 : 0) + (s.location?.area ? 10 : 0);

    const leadsAll = a.people.size + v.unique.size + rq.all + od.all;
    const leads30 = a.people30.size + v.d30.size + rq.d30 + od.d30;
    const currentlyPaid = !!pay && ((ends && ends.getTime() > NOW) || (pay.last && pay.last.getTime() > NOW - (s.subscriptionPlan === "annual" ? 370 : 35) * DAY));
    const accessActive = s.active && !s.suspended && (!ends || ends.getTime() > NOW);

    let segment;
    if (currentlyPaid) segment = "paying";
    else if (pay) segment = "lapsed_payer";
    else if (leads30 >= HOT_LEADS_30D || od.all > 0) segment = "hot_unpaid";
    else if (leadsAll > 0 || market30 >= 3) segment = "warm_unpaid";
    else segment = "no_signal";

    const price = prices[s.tier] || prices.basic;
    // Proof-of-value score: what we can show the seller, weighted by recency
    const proof = leads30 * 3 + od.all * 10 + Math.min(leadsAll, 50) + Math.min(market30, 30) * 0.5;

    return {
      id, businessName: s.businessName, phone: normPhone(s.phone), city: s.location?.city || "", area: s.location?.area || "",
      profileType: s.profileType || "product", categories: (s.categories || []).slice(0, 5), tier: s.tier || "basic",
      subscriptionStatus: s.subscriptionStatus || "", active: !!s.active, accessActive,
      endsAt: ends, daysToEnd: ends ? daysBetween(NOW, ends.getTime()) : null,
      createdAt: toDate(s.createdAt), lastUpdated: toDate(s.updatedAt), priceUpdatedAt: toDate(s.priceUpdatedAt),
      paidTotal: pay ? pay.amount : 0, lastPaidAt: pay ? pay.last : null,
      appearancesAll: a.all, appearances30: a.d30, searchersReached: a.people.size, searchersReached30: a.people30.size,
      linkVisitorsAll: v.unique.size, linkVisitors30: v.d30.size, linkOpens: s.zqLinkViews || 0,
      linkSources: topN(v.sources, 4).map(([k, n]) => `${k}:${n}`),
      requestsNotified: rq.all, requestsNotified30: rq.d30, requestResponses: reqResponded[id] || 0,
      orders: od.all, orders30: od.d30, orderValue: Math.round(od.value),
      profileViews: s.viewCount || 0, savedBy: (s.savedBy || []).length,
      market30, marketAll, marketPeople30: marketPeople30.size, marketTopTerms: topN(marketTerms, 3).map(x => x[0]),
      priceCount, completeness, leadsAll, leads30, segment, price, proof: Math.round(proof * 10) / 10
    };
  });

  for (const r of supplierRows) r.pitch = buildPitch(r);

  // Compact timeline of every unpaid seller (paying sellers don't need converting)
  const timeline = { day0: "2024-01-01", day0ms: TL_DAY0, today: dayIndex(now), sellers: [] };
  for (const r of supplierRows) {
    if (r.segment === "paying") continue;
    const t = tl[r.id] || { s: [], v: [], r: [], o: [], m: {} };
    timeline.sellers.push({ id: r.id, n: r.businessName || "", ph: r.phone, c: r.city, a: r.area, seg: r.segment,
      pr: r.priceCount, de: r.daysToEnd, p: r.price, joined: r.createdAt ? dayIndex(r.createdAt) : null,
      s: t.s, v: t.v, r: t.r, o: t.o, m: Object.entries(t.m).flatMap(([d, c]) => [Number(d), c]) });
  }

  const segCounts = {};
  supplierRows.forEach(r => inc(segCounts, r.segment));
  const supplierStatus = {};
  supplierRows.forEach(r => inc(supplierStatus, `${r.subscriptionStatus || "none"}${r.accessActive ? "" : " (no access)"}`));
  const conversionTargets = supplierRows
    .filter(r => ["hot_unpaid", "warm_unpaid", "lapsed_payer"].includes(r.segment))
    .sort((a, b) => b.proof - a.proof);
  const expiringSoon = supplierRows.filter(r => r.segment !== "paying" && r.daysToEnd !== null && r.daysToEnd >= 0 && r.daysToEnd <= 14)
    .sort((a, b) => a.daysToEnd - b.daysToEnd);

  // Supply vs demand per city × keyword (for recruitment)
  const supplyKw = {};
  for (const s of suppliers) {
    if (!s.active) continue;
    const city = lc(s.location?.city);
    for (const t of new Set(tokens([...(s.categories || []), ...(s.products || []).slice(0, 40), ...(s.rates || []).map(r => r.service)].join(" ")))) {
      inc(supplyKw, `${t}|${city}`); inc(supplyKw, `${t}|*`);
    }
  }
  const demandKw = {};
  for (const s of realSearches) {
    if (toDate(s.createdAt) < D90) continue;
    const city = lc(s.parsed?.city) || "*";
    for (const t of new Set(tokens(`${s.parsed?.product || ""} ${s.parsed?.service || ""} ${s.normalizedText || s.rawText || ""}`))) {
      inc(demandKw, `${t}|${city}`);
    }
  }
  const gapRows = Object.entries(demandKw).map(([k, n]) => {
    const [kwd, city] = k.split("|");
    const supply = city === "*" ? (supplyKw[`${kwd}|*`] || 0) : (supplyKw[k] || 0);
    return { keyword: kwd, city: city === "*" ? "(any)" : city, searches90: n, activeSuppliers: supply, ratio: Math.round((n / (supply + 1)) * 10) / 10 };
  }).filter(r => r.searches90 >= 3).sort((a, b) => b.ratio - a.ratio).slice(0, 60);

  // ── Schools ───────────────────────────────────────────────────────────────
  const sc = {}, sl = {}, sp = {};
  for (const c of data.schoolContacts || []) {
    const k = idStr(c.schoolId); const x = sc[k] = sc[k] || { contacts: 0, d30: 0, applied: 0 };
    x.contacts++; if ((toDate(c.lastSeen) || toDate(c.createdAt)) >= D30) x.d30++; if (c.converted) x.applied++;
  }
  for (const l of data.schoolLeads || []) {
    const k = idStr(l.schoolId); const x = sl[k] = sl[k] || { leads: 0, actions: 0, uncontacted: 0 };
    x.leads++; if (l.actionType && l.actionType !== "view") { x.actions++; if (!l.contacted) x.uncontacted++; }
  }
  for (const p of data.schoolPayments || []) {
    if (!isRealPayment(p)) continue;
    const k = idStr(p.schoolId); const x = sp[k] = sp[k] || { amount: 0, last: null };
    x.amount += Number(p.amount); const d = toDate(p.paidAt) || toDate(p.createdAt);
    if (d && (!x.last || d > x.last)) x.last = d;
    if (d) inc(paymentsByMonth, monthKey(d), Number(p.amount));
    paymentsTotal.count++; paymentsTotal.amount += Number(p.amount);
  }
  const schoolRows = schools.map(s => {
    const id = idStr(s._id), c = sc[id] || { contacts: 0, d30: 0, applied: 0 }, l = sl[id] || { leads: 0, actions: 0, uncontacted: 0 };
    const pay = sp[id]; const ends = toDate(s.subscriptionEndsAt);
    const paying = !!pay && ((ends && ends.getTime() > NOW) || (pay.last && pay.last.getTime() > NOW - 35 * DAY));
    const leads = c.contacts + l.actions;
    return {
      id, schoolName: s.schoolName, phone: normPhone(s.phone), city: s.city || "", suburb: s.suburb || "",
      institutionType: s.institutionType || "academic", active: !!s.active, tier: s.tier || "",
      endsAt: ends, daysToEnd: ends ? daysBetween(NOW, ends.getTime()) : null,
      linkOpens: s.zqLinkViews || 0, monthlyViews: s.monthlyViews || 0, inquiries: s.inquiries || 0,
      contacts: c.contacts, contacts30: c.d30, applications: c.applied, leadActions: l.actions, uncontactedLeads: l.uncontacted,
      paidTotal: pay ? pay.amount : 0,
      segment: paying ? "paying" : pay ? "lapsed_payer" : (c.d30 + l.actions >= 3 || c.applied > 0) ? "hot_unpaid" : leads > 0 ? "warm_unpaid" : "no_signal",
      price: prices.school
    };
  }).sort((a, b) => (b.contacts30 + b.applications * 5 + b.leadActions) - (a.contacts30 + a.applications * 5 + a.leadActions));

  // ── Re-engagement list (lapsed buyers) ────────────────────────────────────
  const supplierKwCity = (term, city) => {
    const ts = tokens(term); if (!ts.length) return 0;
    let best = 0;
    for (const t of ts) best = Math.max(best, city ? (supplyKw[`${t}|${city}`] || 0) : (supplyKw[`${t}|*`] || 0));
    return best;
  };
  const lapsed = allPeople.filter(p => p.last < NOW - 14 * DAY && p.last >= NOW - 180 * DAY).map(p => {
    const real = p.searches.filter(s => !isDeepLink(s) && !GREETING_RE.test(String(s.rawText || "").trim()));
    const lastS = real[real.length - 1];
    const term = lastS ? lc(lastS.parsed?.product || lastS.parsed?.service || lastS.normalizedText || lastS.rawText).slice(0, 60) : "";
    const city = lastS ? lc(lastS.parsed?.city) : "";
    const hadNone = lastS ? isZeroResult(lastS) : false;
    const nowAvail = term ? supplierKwCity(term, city) : 0;
    const score = (term ? 2 : 0) + (hadNone && nowAvail ? 4 : 0) + Math.min(p.activeDays, 5) + (p.requests ? 2 : 0) + (p.orders ? 3 : 0);
    return { phone: p.phone, firstSeen: p.first, lastSeen: p.last, daysSince: daysBetween(p.last.getTime(), NOW),
      activeDays: p.activeDays, searches: real.length, lastTerm: term, city, lastHadNoResults: hadNone,
      suppliersNowAvailable: nowAvail, entry: p.entry.channel, requests: p.requests, orders: p.orders, score };
  }).sort((a, b) => b.score - a.score);

  // ── Money ─────────────────────────────────────────────────────────────────
  const payingSup = supplierRows.filter(r => r.segment === "paying");
  const payingSch = schoolRows.filter(r => r.segment === "paying");
  const mrr = payingSup.reduce((t, r) => t + r.price, 0) + payingSch.reduce((t, r) => t + r.price, 0);
  const hot = supplierRows.filter(r => r.segment === "hot_unpaid");
  const warm = supplierRows.filter(r => r.segment === "warm_unpaid");
  const hotSch = schoolRows.filter(r => r.segment === "hot_unpaid");
  const potential = {
    hotSuppliers: hot.reduce((t, r) => t + r.price, 0),
    warmSuppliers: warm.reduce((t, r) => t + r.price, 0),
    hotSchools: hotSch.reduce((t, r) => t + r.price, 0),
    // realistic: 40% of hot, 10% of warm convert
    realistic: Math.round(hot.reduce((t, r) => t + r.price, 0) * 0.4 + warm.reduce((t, r) => t + r.price, 0) * 0.1 + hotSch.reduce((t, r) => t + r.price, 0) * 0.4)
  };

  // ── Buyer requests & orders ───────────────────────────────────────────────
  const reqs = data.requests || [];
  const requestStats = { total: reqs.length, last30: reqs.filter(r => toDate(r.createdAt) >= D30).length,
    byStatus: {}, byProfileType: {}, byCity: {}, withResponse: 0, notifiedNone: 0, byMonth: {} };
  for (const r of reqs) {
    inc(requestStats.byStatus, r.status || "unknown"); inc(requestStats.byProfileType, r.profileType || "product");
    inc(requestStats.byCity, lc(r.city) || "(none)");
    if ((r.responses || []).length) requestStats.withResponse++;
    if (!(r.notifiedSuppliers || []).length) requestStats.notifiedNone++;
    const d = toDate(r.createdAt); if (d) inc(requestStats.byMonth, monthKey(d));
  }
  requestStats.responseRatePct = pct(requestStats.withResponse, reqs.length);
  const ords = data.orders || [];
  const orderStats = { total: ords.length, last30: ords.filter(o => toDate(o.createdAt) >= D30).length, byStatus: {},
    byMonth: {}, value: Math.round(ords.reduce((t, o) => t + (Number(o.totalAmount) || 0), 0)),
    uniqueBuyers: new Set(ords.map(o => normPhone(o.buyerPhone))).size,
    uniqueSellers: new Set(ords.map(o => idStr(o.supplierId))).size };
  for (const o of ords) { inc(orderStats.byStatus, o.status || "unknown"); const d = toDate(o.createdAt); if (d) inc(orderStats.byMonth, monthKey(d)); }
  const bizPay = { total: (data.bizPayments || []).length, real: (data.bizPayments || []).filter(isRealPayment).length,
    byStatus: (data.bizPayments || []).reduce((m, p) => inc(m, p.status || "unknown"), {}) };

  // ── Data quality flags ────────────────────────────────────────────────────
  const dq = {
    searchesWithoutCity: pct(realSearches.filter(s => !s.parsed?.city).length, realSearches.length),
    searchesUnknownResult: pct(buyerSearches.filter(s => !s.resultMode || s.resultMode === "unknown").length, buyerSearches.length),
    suppliersWithoutPrices: suppliers.filter(s => !(s.prices || []).length && !(s.rates || []).length).length,
    suppliersWithoutSlug: suppliers.filter(s => !s.zqSlug).length,
    activeButNoEndDate: suppliers.filter(s => s.active && !s.subscriptionEndsAt).length,
    duplicateSupplierPhones: Object.values(suppliers.reduce((m, s) => inc(m, normPhone(s.phone)), {})).filter(n => n > 1).length,
    contactsWithoutFirstMessage: (data.contacts || []).filter(c => !c.firstMessage).length,
    followUpsMarkedHelped: buyerSearches.filter(s => s.helped).length
  };

  const allDates = allPeople.map(p => p.first).concat(suppliers.map(s => toDate(s.createdAt)).filter(Boolean));
  const firstDay = allDates.length ? new Date(Math.min(...allDates)) : null;

  return {
    generatedAt: now.toISOString(),
    window: { firstDay, days: firstDay ? daysBetween(firstDay.getTime(), NOW) : 0 },
    collections: data._collections || {},
    prices,
    kpi: {
      peopleEver: allPeople.length, wau, mau, oneAndDonePct: pct(oneAndDone, allPeople.length),
      returnedPct: pct(allPeople.filter(p => p.returnedAny).length, allPeople.length),
      returned7Pct: pct(allPeople.filter(p => p.returned7).length, allPeople.length),
      searchesTotal: buyerSearches.length, realSearches: realSearches.length,
      zeroResultPct: pct(realSearches.filter(isZeroResult).length, realSearches.length),
      suppliers: suppliers.length, suppliersAccessActive: supplierRows.filter(r => r.accessActive).length,
      suppliersPaying: payingSup.length, schools: schools.length, schoolsPaying: payingSch.length,
      mrr, cashCollected: Math.round(paymentsTotal.amount), paymentsCount: paymentsTotal.count,
      adminTrialRecords: paymentsTotal.adminTrials, pendingPayments: paymentsTotal.pending,
      buyerRequests: (data.requests || []).length, orders: (data.orders || []).length
    },
    acquisition: {
      newByWeek, newByMonth, channelTotals, channelByMonth, seoPages,
      channelReturn: Object.fromEntries(Object.entries(channelReturn).map(([k, v]) => [k, { ...v, returnPct: pct(v.returned, v.people) }])),
      linkSources
    },
    retention: { activeByWeek, activeDayHist, cohortRows,
      firstResult: { found: { ...firstResult.found, returnPct: pct(firstResult.found.returned, firstResult.found.people) },
                     none:  { ...firstResult.none,  returnPct: pct(firstResult.none.returned,  firstResult.none.people) } } },
    demand: { searchesByWeek, byFlow, bySource, byMode, byCity: topN(byCity, 25),
      topTerms: topN(terms, 50).map(([t, n]) => [t, n, termPeople[t]?.size || 0]),
      parsedWhat: topN(parsedWhat, 30), heat, searchesPerSearcher, zeroTop: zeroRows.slice(0, 60), gapRows },
    suppliers: { segCounts, supplierStatus, rows: supplierRows, conversionTargets, expiringSoon },
    schools: { rows: schoolRows },
    lapsed,
    money: { mrr, paymentsByMonth, potential, paymentsTotal },
    requestStats, orderStats, bizPayments: bizPay, timeline,
    dataQuality: dq
  };
}

// ── Seller pitch (deterministic; Claude can rewrite these with --ai) ────────
export function buildPitch(r) {
  const name = r.businessName || "there";
  const bits = [];
  if (r.searchersReached30) bits.push(`${r.searchersReached30} buyer${r.searchersReached30 === 1 ? "" : "s"} saw ${name} in ZimQuote search results`);
  if (r.linkVisitors30) bits.push(`${r.linkVisitors30} opened your ZimQuote link`);
  if (r.requestsNotified30) bits.push(`${r.requestsNotified30} buyer request${r.requestsNotified30 === 1 ? " was" : "s were"} sent to you`);
  if (r.orders30) bits.push(`you received ${r.orders30} order${r.orders30 === 1 ? "" : "s"}`);
  let proof;
  if (bits.length) proof = `in the last 30 days ${bits.join(", ")}.`;
  else if (r.marketPeople30) proof = `in the last 30 days ${r.marketPeople30} people${r.city ? " in " + r.city : ""} searched ZimQuote for ${r.marketTopTerms.slice(0, 2).join(" and ") || "what you sell"}.`;
  else if (r.leadsAll) proof = `since you joined, ${r.leadsAll} buyer interaction${r.leadsAll === 1 ? " has" : "s have"} come through ZimQuote for you.`;
  else return "";
  const fix = r.priceCount === 0 ? " Add your prices so buyers can order straight away." : "";
  const when = r.daysToEnd !== null && r.daysToEnd >= 0 && r.daysToEnd <= 30
    ? (r.daysToEnd === 0 ? "Your free listing ends today." : `Your free listing ends in ${r.daysToEnd} day${r.daysToEnd === 1 ? "" : "s"}.`)
    : (r.segment === "lapsed_payer" ? "Your listing has lapsed." : "Your free trial period is over.");
  return `Hi ${name}, ${proof}${fix} ${when} Keep receiving these buyers for $${r.price}/month - reply PAY and we'll send the EcoCash prompt.`;
}

// ═════════════════════════════════════════════════════════════════════════════
// AI strategy memo (optional)
// ═════════════════════════════════════════════════════════════════════════════
export function aiPayload(S) {
  // Aggregates + business names only. No phone numbers ever leave the server.
  const seller = (r) => ({
    name: r.businessName, city: r.city, area: r.area, type: r.profileType, cats: r.categories, tier: r.tier,
    status: r.subscriptionStatus, segment: r.segment, access: r.accessActive, daysToEnd: r.daysToEnd, paid: r.paidTotal,
    joined: fmtDate(r.createdAt), lastUpdated: fmtDate(r.lastUpdated),
    seen30: r.searchersReached30, seenAll: r.searchersReached, visitors30: r.linkVisitors30, visitorsAll: r.linkVisitorsAll,
    linkOpens: r.linkOpens, linkSources: r.linkSources, req30: r.requestsNotified30, reqAll: r.requestsNotified,
    replies: r.requestResponses, orders: r.orders, orderValue: r.orderValue, market30: r.market30,
    marketTerms: r.marketTopTerms, prices: r.priceCount, completeness: r.completeness, savedBy: r.savedBy
  });
  const L = S.lapsed;
  const bucket = (d) => d <= 30 ? "14-30d" : d <= 60 ? "31-60d" : d <= 90 ? "61-90d" : "91-180d";
  const lapsedAgg = {
    total: L.length,
    byDaysAway: L.reduce((m, l) => inc(m, bucket(l.daysSince)), {}),
    byEntryChannel: L.reduce((m, l) => inc(m, l.entry), {}),
    byCity: topN(L.reduce((m, l) => inc(m, l.city || "(none)"), {}), 12),
    lastWanted: topN(L.reduce((m, l) => l.lastTerm ? inc(m, l.lastTerm) : m, {}), 40),
    failedThenNowAvailable: L.filter(l => l.lastHadNoResults && l.suppliersNowAvailable).length,
    neverSearched: L.filter(l => !l.searches).length,
    madeRequestOrOrder: L.filter(l => l.requests || l.orders).length
  };
  const hourTotals = S.demand.heat[0].map((_, h) => S.demand.heat.reduce((t, row) => t + row[h], 0));
  const dayTotals = S.demand.heat.map(row => row.reduce((a, b) => a + b, 0)); // index 0 = Sunday

  return {
    platform: {
      name: "ZimQuote (zimqoute.co.zw)",
      what: "WhatsApp-first marketplace for Zimbabwe's informal economy and SMEs. Buyers message the WhatsApp bot to search for " +
        "products, services, tutors, lodges and schools, see prices, send requests to multiple sellers, and place orders. " +
        "Sellers and schools pay a monthly listing fee (see prices) via EcoCash through Paynow. Each seller has a smart link/QR " +
        "(ZQ:S:<slug>) and gets notified of buyer requests. Schools get an application form, enquiry capture and parent contacts.",
      history: "The founder (a solo developer in Harare) onboarded most sellers himself on free admin trials; almost none have paid. " +
        "Earlier traffic came mostly from Facebook ads; there is now no ad budget. Replacement acquisition is free: SEO landing pages " +
        "(e.g. plumbers-in-harare, grocery-delivery-borrowdale-harare, schools-zimbabwe), web tools (plumbing cost calculator, " +
        "plumber quote generator, car service calculator, solar panel), all linking into the bot with ZQ:GROUP:<slug> codes. " +
        "Buyers tend to come once and not return; sellers don't come back to update prices.",
      constraints: "Solo founder, very small budget, can write code quickly (Node/MongoDB chatbot). WhatsApp Cloud API: free replies " +
        "within 24h of the user's last message; anything outside that window needs a Meta-approved template and is charged per " +
        "message (marketing templates cost the most). Every outbound marketing message therefore has a real cost."
    },
    scale_note: "This is an early-stage dataset - treat small counts carefully and say when a number is too small to act on.",
    window: S.window, prices: S.prices, kpi: S.kpi,
    acquisition: {
      channelTotals: S.acquisition.channelTotals, channelReturn: S.acquisition.channelReturn,
      newByMonth: S.acquisition.newByMonth, newByWeek: S.acquisition.newByWeek, channelByMonth: S.acquisition.channelByMonth,
      seoPages: topN(S.acquisition.seoPages, 30), linkSources: topN(S.acquisition.linkSources, 20)
    },
    retention: { activeByWeek: S.retention.activeByWeek, activeDayHist: S.retention.activeDayHist,
      firstResult: S.retention.firstResult, cohorts: S.retention.cohortRows },
    demand: {
      searchesByWeek: S.demand.searchesByWeek, byFlow: S.demand.byFlow, bySource: S.demand.bySource, byMode: S.demand.byMode,
      byCity: S.demand.byCity, topTerms: S.demand.topTerms.slice(0, 60), parsedWhat: S.demand.parsedWhat,
      searchesPerSearcher: S.demand.searchesPerSearcher,
      zeroResults: S.demand.zeroTop.slice(0, 60).map(z => ({ term: z.term, city: z.city, people: z.people, count: z.count, last: fmtDate(z.last) })),
      supplyGaps: S.demand.gapRows.slice(0, 40),
      searchesByHourHarare: hourTotals, searchesByWeekdaySunFirst: dayTotals
    },
    buyerRequests: S.requestStats, orders: S.orderStats, invoicingSubscriptions: S.bizPayments,
    sellers: { segCounts: S.suppliers.segCounts, status: S.suppliers.supplierStatus, all: S.suppliers.rows.map(seller) },
    schools: S.schools.rows.map(r => ({ name: r.schoolName, city: r.city, suburb: r.suburb, type: r.institutionType,
      segment: r.segment, active: r.active, daysToEnd: r.daysToEnd, linkOpens: r.linkOpens, contacts: r.contacts,
      contacts30: r.contacts30, applications: r.applications, leadActions: r.leadActions, notFollowedUp: r.uncontactedLeads, paid: r.paidTotal })),
    lapsedBuyers: lapsedAgg,
    money: { mrr: S.money.mrr, paymentsByMonth: S.money.paymentsByMonth, potential: S.money.potential, payments: S.money.paymentsTotal },
    dataQuality: S.dataQuality
  };
}

const ZW_CONTEXT = `Zimbabwe operating context - use it, but let the data override any assumption, and flag anything you are unsure of:
- Money: trade is mostly priced in US dollars; ZiG (ZWG) is the official local currency. EcoCash dominates mobile money; InnBucks, OneMoney, bank transfers and cash USD are common. Small US change is scarce, so odd amounts are awkward - round prices ($3, $5, $10) work best. Many small sellers think week-to-week, so a monthly fee feels big next to a data bundle; weekly, per-lead or prepaid-bundle options may convert better than monthly.
- Cash cycles: month-end salaries (civil servants are often paid mid-to-late month), school terms starting around January, May and September (fees, uniforms, stationery, transport, school searches peak before term), December festive and diaspora-remittance season, rainy season roughly November to March (affects construction, roofing, boreholes, solar), and power cuts driving solar, inverter and generator demand.
- Channels: WhatsApp is the internet for many people and is often on cheap WhatsApp-only bundles, so WhatsApp beats web links and heavy images. WhatsApp Status, community/WhatsApp groups, Facebook groups (free organic posting), TikTok and word of mouth are the free channels. Trust is low because of scams, so verification, real reviews, a visible human, and referrals from someone you know matter more than ads.
- Supply side: much of the informal economy clusters in known markets and industrial areas (e.g. Mbare, Siyaso, Gulf complex, Magaba, Glen View furniture, light industry in each town), which makes in-person onboarding days efficient. Many sellers are not tech-confident; anything that needs them to "log in" or "update a profile" fails unless it happens inside WhatsApp in one or two taps.
- Language: English is fine for business, but short Shona (and Ndebele for Bulawayo/Matabeleland) lines lift response and trust.
- Distances and transport costs mean buyers care about area/suburb and delivery more than city.`;

const AI_SYSTEM = `You are a senior growth, retention and monetisation strategist who has built marketplaces in African informal economies. You are advising a bootstrapped solo founder in Harare.
Rules:
- Work only from the JSON data supplied plus the context notes. Quote the specific numbers behind every claim. If a number is too small to act on, say so.
- Be specific: name sellers, schools, cities, search terms, SEO pages and dollar amounts from the data. No generic startup advice.
- Prefer actions one person can do with WhatsApp, EcoCash, the existing chatbot, free SEO pages and physical visits, with no ad spend.
- Be honest when the data says something uncomfortable (e.g. a vertical isn't working, the price is wrong, sellers get no value).
- Write in clear Markdown with headings, short paragraphs, bullet lists and tables where they help.

${ZW_CONTEXT}`;

const PASS1 = `PART 1 - DEEP ANALYSIS. Using the data above, write:

## 1. Executive summary
The 7 most important things the data says, ranked by money impact, each with its numbers.

## 2. Funnel diagnosis
Walk the full funnel - acquisition (by channel), first search, result found or not, request/order, return visit, seller response, seller payment. For each stage give the numbers, the leak, and the most likely cause in the Zimbabwe context.

## 3. Buyers: who comes, what they want, why they leave
Demand by category and city, time-of-day/weekday patterns, the cohort and one-and-done figures, the impact of zero-result searches, and which entry channels bring people who actually come back.

## 4. Sellers: who is getting value and who isn't
Segment the sellers. Name the sellers with the strongest proof of value and the ones getting nothing (and why - wrong category, no prices, wrong city, no demand). Assess whether the current price and plan structure fit this market, and propose the pricing/offer you would test, justified by the data.

## 5. Schools and education
What the school and tutor data shows and the realistic revenue path there, tied to the term calendar.

## 6. Verticals: double down, fix, or drop
A table of each vertical/category with demand, supply, conversion signals and your verdict.

## 7. Free acquisition without Facebook ads
Which SEO pages, tools and link sources work, which don't, and the next 10 pages or tools to build (exact page titles + target search terms taken from the demand and zero-result data).

## 8. Risks and data gaps
What could be misleading in this data and what tracking to add.`;

const PASS2 = `PART 2 - ACTION PLAYBOOK. Your Part 1 analysis is above. Now turn it into things the founder can execute. Write:

## 9. This week: cash conversations
A ranked list of the first 15 sellers/schools to approach, why each, the offer, and the channel (call, visit, WhatsApp).

## 10. Ready-to-send messages
Write each message in English with a short Shona line, sized for WhatsApp (under 600 characters), with {{placeholders}} for personal numbers:
- Seller conversion: proof-of-value message, follow-up 48h later, last-day reminder, "founding member" offer
- Seller re-activation for sellers getting zero leads (fix profile/prices)
- School pitch tied to the coming term
- Buyer win-back as a Meta MARKETING TEMPLATE (follow template rules: variables as {{1}}, {{2}}; a clear opt-out line; no misleading claims) - one for "we now have sellers for what you searched", one general
- Buyer retention nudge inside the free 24-hour window after a search
- Referral message buyers/sellers can forward

## 11. Bot and product changes
The 10 highest-impact changes to the WhatsApp bot and web pages, ranked by impact over effort, each with what to build, why (data), and how to measure it. Include what to do when a search returns nothing, how to bring buyers back without paid templates, and how to make sellers interact weekly inside WhatsApp.

## 12. Retention system
A concrete weekly rhythm for buyers and sellers (what is sent, when in Harare time, to whom, what it costs in templates) that fits the data on when people search.

## 13. Free growth plan
Week-by-week plan for SEO pages, tools, WhatsApp Status/groups, Facebook groups, TikTok and physical onboarding days at specific markets - with a target for each.

## 14. 30/60/90-day plan
A table with weekly actions, owner hours, and targets for: new buyers, returning buyers, paying sellers, paying schools, MRR.

## 15. Weekly scorecard
The 8 numbers to check every Monday from this report and the thresholds that mean "change course".`;

// Streams the response so long outputs never hit fetch's header timeout.
async function claudeStream({ key, model, system, messages, max_tokens }) {
  for (let attempt = 1; attempt <= 5; attempt++) {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model, max_tokens, system, messages, stream: true })
    });
    if ([429, 500, 529].includes(res.status)) {
      const wait = Math.min(attempt * 20000, 90000);
      log(`  Claude busy (${res.status}), retry ${attempt}/5 in ${wait / 1000}s...`);
      await new Promise(r => setTimeout(r, wait));
      continue;
    }
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(`API ${res.status}: ${body?.error?.message || "unknown error"}`);
    }
    let text = "", buf = "", stop = null;
    const usage = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
    const dec = new TextDecoder();
    for await (const chunk of res.body) {
      buf += dec.decode(chunk, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        let ev; try { ev = JSON.parse(line.slice(5)); } catch { continue; }
        if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta") {
          text += ev.delta.text;
          if (!OPT.quiet && text.length % 2000 < ev.delta.text.length) process.stdout.write(".");
        } else if (ev.type === "message_start") {
          const u = ev.message?.usage || {};
          usage.input = u.input_tokens || 0; usage.cacheWrite = u.cache_creation_input_tokens || 0; usage.cacheRead = u.cache_read_input_tokens || 0;
        } else if (ev.type === "message_delta") {
          usage.output = ev.usage?.output_tokens || usage.output; stop = ev.delta?.stop_reason || stop;
        } else if (ev.type === "error") {
          throw new Error(ev.error?.message || "stream error");
        }
      }
    }
    if (!OPT.quiet) process.stdout.write("\n");
    return { text: text.trim(), usage, stop };
  }
  throw new Error("Claude stayed busy after 5 retries");
}

export async function runAi(S, outDir) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) { log("  --ai requested but ANTHROPIC_API_KEY is not set - skipping"); return null; }
  const model = (typeof OPT.model === "string" && OPT.model) || process.env.ZQ_INTEL_MODEL || "claude-sonnet-5-5";
  const payload = aiPayload(S);
  const dataText = `ZIMQUOTE DATA (generated ${S.generatedAt}, full history from ${fmtDate(S.window.firstDay)}):\n\n${JSON.stringify(payload)}`
    // scrub any phone numbers buyers typed into searches
    .replace(/(?:\+?263|\b0)7\d{8}\b/g, "[phone]").replace(/\b7[1378]\d{7}\b/g, "[phone]");
  fs.writeFileSync(path.join(outDir, "ai_payload.json"), JSON.stringify(payload, null, 2));
  log(`  payload ${Math.round(dataText.length / 1024)} KB (no phone numbers) → ${model}`);

  // The data block is cached so Part 2 re-reads it at a fraction of the price.
  const dataBlock = { type: "text", text: dataText, cache_control: { type: "ephemeral" } };
  const sys = [{ type: "text", text: AI_SYSTEM }];
  const totals = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
  const add = (u) => { for (const k of Object.keys(totals)) totals[k] += u[k] || 0; };

  try {
    log("  part 1/2: deep analysis...");
    const p1 = await claudeStream({ key, model, system: sys, max_tokens: 14000,
      messages: [{ role: "user", content: [dataBlock, { type: "text", text: PASS1 }] }] });
    add(p1.usage);
    fs.writeFileSync(path.join(outDir, "ai_strategy.md"), p1.text, "utf8");
    if (p1.stop === "max_tokens") log("  note: part 1 hit max_tokens and may be cut short");

    log("  part 2/2: action playbook...");
    const p2 = await claudeStream({ key, model, system: sys, max_tokens: 16000,
      messages: [
        { role: "user", content: [dataBlock, { type: "text", text: PASS1 }] },
        { role: "assistant", content: p1.text },
        { role: "user", content: PASS2 }
      ] });
    add(p2.usage);
    if (p2.stop === "max_tokens") log("  note: part 2 hit max_tokens and may be cut short");

    const full = `# ZimQuote strategy memo\n\n_Model: ${model} · data to ${fmtDate(S.generatedAt)}_\n\n${p1.text}\n\n---\n\n${p2.text}`;
    fs.writeFileSync(path.join(outDir, "ai_strategy.md"), full, "utf8");
    fs.writeFileSync(path.join(outDir, "ai_playbook.md"), p2.text, "utf8");
    log(`  AI done - tokens: input ${totals.input}, cache write ${totals.cacheWrite}, cache read ${totals.cacheRead}, output ${totals.output}`);
    return full;
  } catch (e) {
    log(`  AI call failed: ${e.message}`);
    const p = path.join(outDir, "ai_strategy.md");
    return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null;   // keep part 1 if part 2 failed
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// HTML report
// ═════════════════════════════════════════════════════════════════════════════
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtDate = (d) => d ? new Date(d).toISOString().slice(0, 10) : "";
const money = (n) => `$${Math.round(n || 0).toLocaleString("en-US")}`;
const maskPhone = (p) => p ? `0${p.slice(3, 5)}…${p.slice(-3)}` : "";

function mdToHtml(md) {
  const lines = String(md || "").split(/\r?\n/); let html = "", list = null, tbl = null;
  const inline = (t) => esc(t).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>").replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>")
    .replace(/_([^_]+)_/g, "<em>$1</em>").replace(/`([^`]+)`/g, "<code>$1</code>");
  const closeList = () => { if (list) { html += `</${list}>`; list = null; } };
  const closeTbl = () => { if (tbl) { html += `<div class="tw"><table>${tbl.join("")}</table></div>`; tbl = null; } };
  const cells = (ln) => ln.trim().replace(/^\||\|$/g, "").split("|").map(c => c.trim());
  for (const ln of lines) {
    if (/^\s*\|.*\|\s*$/.test(ln)) {
      closeList();
      if (/^\s*\|[\s:|-]+\|\s*$/.test(ln)) continue;          // separator row
      const tag = tbl ? "td" : "th"; tbl = tbl || [];
      tbl.push(`<tr>${cells(ln).map(c => `<${tag}>${inline(c)}</${tag}>`).join("")}</tr>`); continue;
    }
    closeTbl();
    const h = ln.match(/^(#{1,4})\s+(.*)/), ul = ln.match(/^\s*[-*]\s+(.*)/), ol = ln.match(/^\s*\d+[.)]\s+(.*)/);
    if (h) { closeList(); const n = Math.min(h[1].length + 1, 5); html += `<h${n}>${inline(h[2])}</h${n}>`; }
    else if (ul || ol) { const t = ul ? "ul" : "ol"; if (list !== t) { closeList(); html += `<${t}>`; list = t; } html += `<li>${inline((ul || ol)[1])}</li>`; }
    else if (/^\s*---+\s*$/.test(ln)) { closeList(); html += "<hr>"; }
    else if (ln.trim()) { closeList(); html += `<p>${inline(ln)}</p>`; }
  }
  closeList(); closeTbl();
  return html;
}

function bars(obj, { max = 26, labelFmt = (k) => k, valueFmt = (v) => v } = {}) {
  const entries = Array.isArray(obj) ? obj : Object.entries(obj);
  const rows = entries.slice(-max);
  const top = Math.max(1, ...rows.map(r => r[1]));
  return `<div class="bars">${rows.map(([k, v]) =>
    `<div class="bar"><span class="bl">${esc(labelFmt(k))}</span><span class="bt"><i style="width:${(v / top * 100).toFixed(1)}%"></i></span><span class="bv">${esc(valueFmt(v))}</span></div>`).join("")}</div>`;
}

function table(rows, cols, { limit = 50 } = {}) {
  if (!rows.length) return `<p class="empty">Nothing here yet.</p>`;
  return `<div class="tw"><table><thead><tr>${cols.map(c => `<th${c.num ? ' class="n"' : ""}>${esc(c.label)}</th>`).join("")}</tr></thead><tbody>${
    rows.slice(0, limit).map(r => `<tr>${cols.map(c => {
      const v = c.get ? c.get(r) : r[c.key];
      return `<td${c.num ? ' class="n"' : ""}>${c.html ? v : esc(v)}</td>`;
    }).join("")}</tr>`).join("")}</tbody></table></div>${rows.length > limit ? `<p class="more">Showing ${limit} of ${rows.length}. Full list in the CSV.</p>` : ""}`;
}

function heatmap(heat) {
  const max = Math.max(1, ...heat.flat());
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return `<div class="tw"><table class="heat"><thead><tr><th></th>${Array.from({ length: 24 }, (_, h) => `<th>${h}</th>`).join("")}</tr></thead><tbody>${
    [1, 2, 3, 4, 5, 6, 0].map(d => `<tr><th>${days[d]}</th>${heat[d].map(v => `<td style="--a:${(v / max).toFixed(2)}" title="${v} searches">${v || ""}</td>`).join("")}</tr>`).join("")
  }</tbody></table></div>`;
}

// ── Conversion-target views over any time frame ──────────────────────────────
const TL_WINDOWS = [["7d", 7], ["30d", 30], ["90d", 90], ["all", null]];
export function windowedTargets(T) {
  if (!T || !Array.isArray(T.sellers)) return [];
  const per = {};
  for (const [key, n] of TL_WINDOWS) {
    for (const st of zqRangeStats(T, n ? T.today - n + 1 : null, null)) (per[st.k] = per[st.k] || {})[key] = st;
  }
  return Object.entries(per).map(([k, w]) => ({ x: T.sellers[k], w }))
    .filter(r => r.w.all.leads > 0 || r.w.all.mkt > 0)
    .sort((a, b) => b.w.all.proof - a.w.all.proof || b.w["30d"].proof - a.w["30d"].proof);
}

function windowedTable(T, { phones = false } = {}) {
  const rows = windowedTargets(T);
  if (!rows.length) return `<p class="empty">No unpaid seller has any buyer activity yet.</p>`;
  const segTag = (x) => `<span class="tag ${x}">${String(x).replace("_", " ")}</span>`;
  const ends = (de) => de === null || de === undefined ? "" : de < 0 ? `${-de}d ago` : de === 0 ? "today" : `in ${de}d`;
  return table(rows, [
    { label: "Business", get: r => r.x.n }, ...(phones ? [{ label: "Phone", get: r => r.x.ph }] : []), { label: "City", get: r => r.x.c },
    { label: "Segment", get: r => segTag(r.x.seg), html: true },
    { label: "Leads 7d", get: r => r.w["7d"].leads, num: true }, { label: "Leads 30d", get: r => r.w["30d"].leads, num: true },
    { label: "Leads 90d", get: r => r.w["90d"].leads, num: true }, { label: "Leads all", get: r => r.w.all.leads, num: true },
    { label: "Seen all", get: r => r.w.all.seen, num: true }, { label: "Visitors all", get: r => r.w.all.vis, num: true },
    { label: "Requests all", get: r => r.w.all.req, num: true }, { label: "Orders all", get: r => r.w.all.ord, num: true },
    { label: "Market 30d", get: r => r.w["30d"].mkt, num: true }, { label: "Market all", get: r => r.w.all.mkt, num: true },
    { label: "Prices", get: r => r.x.pr, num: true }, { label: "Trial", get: r => ends(r.x.de) }
  ], { limit: 1e6 });
}

function windowedMessages(T, { phones = false, limit = 1e6 } = {}) {
  const rows = windowedTargets(T).slice(0, limit);
  const items = rows.map(r => {
    // use the strongest recent window that has something to say
    const pick = ["30d", "90d", "all"].find(k => r.w[k].leads > 0) || (r.w["30d"].mkt ? "30d" : "all");
    const n = TL_WINDOWS.find(w => w[0] === pick)[1];
    const msg = zqRangePitch(r.x, r.w[pick], zqRangeLabel(T, n ? T.today - n + 1 : null, null));
    return msg ? `<li><strong>${esc(r.x.n)}</strong>${phones ? ` · ${esc(r.x.ph)}` : ""} · ${esc(r.x.c)}<br><span class="pitch">${esc(msg)}</span></li>` : "";
  }).filter(Boolean);
  return items.length ? `<ol class="msgs">${items.join("")}</ol>` : `<p class="empty">No messages - no seller has activity to point to.</p>`;
}

// Interactive version for the web report: presets + any custom date range.
function interactiveTargets(S) {
  const T = S.timeline;
  if (!T || !Array.isArray(T.sellers)) return `<p class="empty">Run a new scan to enable the time-frame filter.</p>`;
  const json = JSON.stringify(T).replace(/</g, "\\u003c");
  const run = S.run || "";
  return `<div class="ctl" id="ct-ctl">
  <span>Time frame:</span>
  <button type="button" data-r="7">7 days</button><button type="button" data-r="30">30 days</button><button type="button" data-r="90">90 days</button>
  <button type="button" data-r="month">This month</button><button type="button" data-r="lastmonth">Last month</button><button type="button" data-r="all">All time</button>
  <label>From <input type="date" id="ct-from"></label><label>to <input type="date" id="ct-to"></label><button type="button" id="ct-apply">Apply</button>
  <label><input type="checkbox" id="ct-zero"> include sellers with no activity</label>
</div>
<p id="ct-sum" class="sub"></p>
<p class="sub"><a id="ct-pdf" href="#">Download this view as PDF</a> · <a id="ct-csv" href="#">Download this view as CSV</a></p>
<div id="ct"><p class="empty">Loading the time-frame view…</p></div>
<script type="application/json" id="zq-tl">${json}</script>
<script>
(function () {
  ${zqRangeStats.toString()}
  ${zqRangeLabel.toString()}
  ${zqRangePitch.toString()}
  var T = JSON.parse(document.getElementById("zq-tl").textContent), RUN = ${JSON.stringify(run)};
  var $ = function (id) { return document.getElementById(id); };
  var iso = function (d) { return new Date(T.day0ms + d * 86400000).toISOString().slice(0, 10); };
  var day = function (s) { return s ? Math.floor((Date.parse(s + "T00:00:00Z") - T.day0ms) / 86400000) : null; };
  var esc = function (s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); };
  var ends = function (de) { return de === null || de === undefined ? "" : de < 0 ? (-de) + "d ago" : de === 0 ? "today" : "in " + de + "d"; };
  var cur = { from: T.today - 29, to: null }, lastRows = [];
  function render() {
    var lbl = zqRangeLabel(T, cur.from, cur.to), all = $("ct-zero").checked;
    var rows = zqRangeStats(T, cur.from, cur.to).filter(function (r) { return all || r.leads > 0 || r.mkt > 0; });
    lastRows = rows;
    $("ct-from").value = cur.from == null ? "" : iso(cur.from);
    $("ct-to").value = cur.to == null ? "" : iso(Math.min(cur.to, T.today));
    var totL = 0, totO = 0; rows.forEach(function (r) { totL += r.leads; totO += r.ord; });
    $("ct-sum").textContent = rows.length + " unpaid sellers " + (cur.from == null && cur.to == null ? "across all time" : lbl.replace(/,$/, "")) +
      " · " + totL + " buyer touches · " + totO + " orders. Ranked by proof of value for this time frame.";
    var h = '<div class="tw"><table><thead><tr><th>#</th><th>Business</th><th>Phone</th><th>City</th><th>Segment</th><th class="n">Seen by</th><th class="n">Link visitors</th><th class="n">Requests</th><th class="n">Orders</th><th class="n">Market searches</th><th class="n">Leads</th><th class="n">Prices</th><th>Trial ends</th><th>Message to send</th></tr></thead><tbody>';
    rows.forEach(function (r, i) {
      var x = T.sellers[r.k];
      h += "<tr><td class=n>" + (i + 1) + "</td><td>" + esc(x.n) + "</td><td>" + esc(x.ph) + "</td><td>" + esc(x.c) + '</td><td><span class="tag ' + esc(x.seg) + '">' + esc(String(x.seg).replace("_", " ")) +
        "</span></td><td class=n>" + r.seen + "</td><td class=n>" + r.vis + "</td><td class=n>" + r.req + "</td><td class=n>" + r.ord + "</td><td class=n>" + r.mkt +
        "</td><td class=n><strong>" + r.leads + "</strong></td><td class=n>" + x.pr + "</td><td>" + ends(x.de) + '</td><td><span class="pitch">' + esc(zqRangePitch(x, r, lbl)) + "</span></td></tr>";
    });
    h += "</tbody></table></div>";
    $("ct").innerHTML = rows.length ? h : '<p class="empty">No unpaid seller had buyer activity in this time frame. Try a longer one.</p>';
    var q = "?from=" + (cur.from == null ? "" : iso(cur.from)) + "&to=" + (cur.to == null ? "" : iso(cur.to)) + (all ? "&zero=1" : "");
    $("ct-pdf").href = RUN ? "/zq-admin/intel/r/" + RUN + "/targets" + q : "#";
    var buttons = document.querySelectorAll("#ct-ctl button[data-r]");
    for (var b = 0; b < buttons.length; b++) buttons[b].setAttribute("aria-pressed", buttons[b].getAttribute("data-r") === cur.key ? "true" : "false");
  }
  function preset(r) {
    var t = new Date(T.day0ms + T.today * 86400000), y = t.getUTCFullYear(), m = t.getUTCMonth();
    if (r === "all") cur = { from: null, to: null };
    else if (r === "month") cur = { from: day(new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10)), to: null };
    else if (r === "lastmonth") cur = { from: day(new Date(Date.UTC(y, m - 1, 1)).toISOString().slice(0, 10)), to: day(new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10)) };
    else cur = { from: T.today - Number(r) + 1, to: null };
    cur.key = r; render();
  }
  $("ct-ctl").addEventListener("click", function (e) { var r = e.target.getAttribute && e.target.getAttribute("data-r"); if (r) preset(r); });
  $("ct-apply").addEventListener("click", function () {
    var f = day($("ct-from").value), t = day($("ct-to").value);
    if (f != null && t != null && f > t) { var s = f; f = t; t = s; }
    cur = { from: f, to: t != null && t >= T.today ? null : t, key: "" }; render();
  });
  $("ct-zero").addEventListener("change", render);
  $("ct-csv").addEventListener("click", function (e) {
    e.preventDefault();
    var lbl = zqRangeLabel(T, cur.from, cur.to), q = function (v) { v = String(v == null ? "" : v); return /[",\\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
    var lines = [["rank", "business", "phone", "city", "segment", "seen_by", "link_visitors", "requests", "orders", "market_searches", "leads", "prices", "trial_days_left", "message"].join(",")];
    lastRows.forEach(function (r, i) { var x = T.sellers[r.k]; lines.push([i + 1, x.n, x.ph, x.c, x.seg, r.seen, r.vis, r.req, r.ord, r.mkt, r.leads, x.pr, x.de, zqRangePitch(x, r, lbl)].map(q).join(",")); });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob(["\\ufeff" + lines.join("\\r\\n")], { type: "text/csv" }));
    a.download = "zq-conversion-targets-" + (cur.from == null ? "start" : iso(cur.from)) + "-to-" + (cur.to == null ? "today" : iso(cur.to)) + ".csv";
    document.body.appendChild(a); a.click(); setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  });
  preset("30");
})();
</script>`;
}

// Stand-alone conversion-targets document for one time frame (admin PDF - has phones).
export function renderTargetsHtml(S, fromIso, toIso, { includeZero = false } = {}) {
  const T = S.timeline;
  const from = tlDayFromIso(fromIso), to0 = tlDayFromIso(toIso);
  const to = to0 != null && to0 >= T.today ? null : to0;
  const lbl = zqRangeLabel(T, from, to);
  const rows = zqRangeStats(T, from, to).filter(r => includeZero || r.leads > 0 || r.mkt > 0);
  const title = from == null && to == null ? "all time" : `${from == null ? "start" : tlIsoFromDay(from)} to ${to == null ? fmtDate(S.generatedAt) : tlIsoFromDay(to)}`;
  const segTag = (x) => `<span class="tag ${x}">${String(x).replace("_", " ")}</span>`;
  const ends = (de) => de === null || de === undefined ? "" : de < 0 ? `${-de}d ago` : de === 0 ? "today" : `in ${de}d`;
  const tot = rows.reduce((t, r) => ({ l: t.l + r.leads, o: t.o + r.ord, m: t.m + r.mkt }), { l: 0, o: 0, m: 0 });
  const css = `body{margin:0;font:13px/1.5 "Public Sans","Segoe UI",system-ui,sans-serif;color:#0f2a24}main{padding:0 12mm}
h1{font:800 26px/1.15 "Bricolage Grotesque",system-ui,sans-serif;margin:0 0 4px}h2{font:750 18px/1.2 "Bricolage Grotesque",system-ui,sans-serif;margin:22px 0 8px}
.sub{color:#5d6b66}.tw{margin:8px 0}table{border-collapse:collapse;width:100%;font-size:10px}thead{display:table-header-group}
th,td{padding:4px 6px;border-bottom:1px solid #d5dbd4;text-align:left;vertical-align:top}th{background:#eef3ef;white-space:nowrap}td.n,th.n{text-align:right}
.tag{display:inline-block;padding:0 5px;border:1px solid currentColor;font-size:9.5px;white-space:nowrap}.hot_unpaid,.lapsed_payer{color:#b23a2b}.warm_unpaid{color:#c99400}.no_signal{color:#5d6b66}
.msgs{font-size:11px;padding-left:20px}.msgs li{margin:6px 0;break-inside:avoid}.pitch{color:#41504a}.kp{display:flex;gap:28px;margin:12px 0}.kp b{display:block;font-size:20px}`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>Conversion targets ${title}</title>
<link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:wght@700;800&family=Public+Sans:wght@400;650&display=swap" rel="stylesheet"><style>${css}</style></head><body><main>
<h1>Conversion targets: ${esc(title)}</h1>
<p class="sub">Unpaid ZimQuote sellers ranked by proof of value for this time frame. Seen by = unique buyers who saw them in search results; link visitors = unique buyers who opened their smart link; market searches = buyer searches in their city for what they sell. Data to ${fmtDate(S.generatedAt)}.</p>
<div class="kp"><div><b>${rows.length}</b>sellers with activity</div><div><b>${tot.l}</b>buyer touches</div><div><b>${tot.o}</b>orders</div><div><b>${tot.m}</b>market searches</div></div>
<h2>Ranked list</h2>
${rows.length ? table(rows, [
    { label: "#", get: (r) => rows.indexOf(r) + 1, num: true }, { label: "Business", get: r => T.sellers[r.k].n }, { label: "Phone", get: r => T.sellers[r.k].ph },
    { label: "City", get: r => [T.sellers[r.k].c, T.sellers[r.k].a].filter(Boolean).join(", ") }, { label: "Segment", get: r => segTag(T.sellers[r.k].seg), html: true },
    { label: "Seen by", key: "seen", num: true }, { label: "Times shown", key: "times", num: true }, { label: "Link visitors", key: "vis", num: true },
    { label: "Requests", key: "req", num: true }, { label: "Orders", key: "ord", num: true }, { label: "Market", key: "mkt", num: true },
    { label: "Leads", key: "leads", num: true }, { label: "Prices", get: r => T.sellers[r.k].pr, num: true }, { label: "Trial", get: r => ends(T.sellers[r.k].de) }
  ], { limit: 1e6 }) : `<p>No unpaid seller had buyer activity in this time frame.</p>`}
<h2>Messages to send</h2>
<ol class="msgs">${rows.map(r => { const x = T.sellers[r.k]; const m = zqRangePitch(x, r, lbl);
    return m ? `<li><strong>${esc(x.n)}</strong> · ${esc(x.ph)} · ${esc(x.c)}<br><span class="pitch">${esc(m)}</span></li>` : ""; }).join("")}</ol>
</main></body></html>`;
}

export function renderHtml(S, aiText = null, { full = false } = {}) {
  const L = (n) => full ? 1e6 : n;          // full = every row (PDF), otherwise screen-sized
  const k = S.kpi, seg = S.suppliers.segCounts;
  const hot = S.suppliers.rows.filter(r => r.segment === "hot_unpaid");
  const lapsedUnmet = S.lapsed.filter(l => l.lastHadNoResults && l.suppliersNowAvailable).length;
  const fr = S.retention.firstResult;
  const ch = Object.entries(S.acquisition.channelTotals).sort((a, b) => b[1] - a[1]);
  const adShare = pct((S.acquisition.channelTotals.facebook_ad_default || 0) + (S.acquisition.channelTotals.greeting_only || 0), k.peopleEver);
  const webShare = pct((S.acquisition.channelTotals.web_seo_page || 0) + (S.acquisition.channelTotals.web_tool_prefill || 0) + (S.acquisition.channelTotals.web_list_business || 0), k.peopleEver);

  const actions = [
    { cash: S.money.potential.hotSuppliers, title: `Convert ${hot.length} hot unpaid sellers`,
      body: `They each got ${HOT_LEADS_30D}+ buyer touches in 30 days or an order. Send each one their own numbers (conversion_targets.csv has the message ready). At 40% conversion that is about ${money(S.money.potential.hotSuppliers * 0.4)}/month.` },
    { cash: S.money.potential.hotSchools, title: (() => { const n = S.schools.rows.filter(r => r.segment === "hot_unpaid").length; return `Convert ${n} school${n === 1 ? "" : "s"} with live parent interest`; })(),
      body: `Schools with recent parent contacts or applications but no payment. Show them the contact list they are missing.` },
    { cash: S.money.potential.warmSuppliers * 0.1, title: `Nudge ${seg.warm_unpaid || 0} warm sellers with market-size proof`,
      body: `Some visibility but not enough to prove value alone - pitch with how many people in their city searched their category.` },
    { cash: 0, title: `Win back ${S.lapsed.length} lapsed buyers (${lapsedUnmet} searched for something we now have)`,
      body: `Use an approved marketing template, highest score first (lapsed_buyers.csv). People whose search failed and now has suppliers are the best re-engagement you'll ever get.` },
    { cash: 0, title: `Recruit sellers for the top unmet searches`,
      body: `${S.demand.zeroTop.length} search/city combinations returned nothing. Recruit there - you can tell a new seller exactly how many buyers already asked.` }
  ];

  const css = `
:root{--ink:#0f2a24;--paper:#f6f7f4;--line:#d5dbd4;--muted:#5d6b66;--green:#1f7a4d;--gold:#c99400;--red:#b23a2b;--wash:#e8efe9}
@media (prefers-color-scheme:dark){:root{--ink:#e7efe9;--paper:#101915;--line:#2b3a33;--muted:#9bb0a7;--wash:#17241e}}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--paper);color:var(--ink);font:15px/1.55 "Public Sans","Segoe UI",system-ui,sans-serif}
main{max-width:1180px;margin:0 auto;padding:28px 20px 80px}
h1{font:800 34px/1.1 "Bricolage Grotesque","Public Sans",system-ui,sans-serif;letter-spacing:-.02em;margin:0 0 6px}
h2{font:750 22px/1.2 "Bricolage Grotesque","Public Sans",system-ui,sans-serif;margin:46px 0 6px;padding-top:14px;border-top:2px solid var(--ink)}
h3{font-size:16px;margin:22px 0 8px}h4,h5{margin:16px 0 6px}
p{max-width:76ch}.sub{color:var(--muted);margin:0 0 18px}
.kpis{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:0;border:1px solid var(--line);margin:18px 0}
.kpi{padding:12px 14px;border-right:1px solid var(--line);border-bottom:1px solid var(--line)}
.kpi b{display:block;font:700 24px/1.1 "Bricolage Grotesque",system-ui,sans-serif}.kpi span{color:var(--muted);font-size:13px}
.ladder{counter-reset:a;list-style:none;padding:0;margin:14px 0}
.ladder li{counter-increment:a;display:grid;grid-template-columns:44px 1fr auto;gap:12px;align-items:start;padding:14px 0;border-bottom:1px solid var(--line)}
.ladder li::before{content:counter(a);font:800 26px/1 "Bricolage Grotesque",system-ui;color:var(--gold)}
.ladder strong{display:block;font-size:16px}.ladder .cash{font:700 18px/1.2 system-ui;color:var(--green);white-space:nowrap}
.cols{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:28px}
.bars{display:grid;gap:3px;margin:8px 0}.bar{display:grid;grid-template-columns:minmax(90px,38%) 1fr 64px;gap:8px;align-items:center;font-size:13px}
.bl{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.bt{background:var(--wash);height:14px}.bt i{display:block;height:100%;background:var(--green)}
.bv{text-align:right;font-variant-numeric:tabular-nums}
.tw{overflow-x:auto;border:1px solid var(--line)}table{border-collapse:collapse;width:100%;font-size:13px}
th,td{padding:6px 8px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}th{background:var(--wash);font-weight:650;white-space:nowrap}
td.n,th.n{text-align:right;font-variant-numeric:tabular-nums}tbody tr:hover{background:var(--wash)}
.heat td{text-align:center;min-width:26px;background:color-mix(in srgb,var(--green) calc(var(--a)*100%),transparent);font-size:11px}
.tag{display:inline-block;padding:1px 7px;border:1px solid currentColor;font-size:12px;white-space:nowrap}
.hot_unpaid{color:var(--red)}.paying{color:var(--green)}.warm_unpaid{color:var(--gold)}.lapsed_payer{color:var(--red)}.no_signal{color:var(--muted)}
.pitch{display:block;font-size:12px;color:var(--muted);min-width:300px;max-width:52ch}
.ctl{display:flex;flex-wrap:wrap;gap:6px 10px;align-items:center;margin:10px 0;font-size:14px}.ctl button{font:inherit;padding:4px 10px;border:1px solid var(--line);background:var(--paper);color:var(--ink);cursor:pointer}.ctl button[aria-pressed=true]{background:var(--ink);color:var(--paper);border-color:var(--ink)}.ctl input[type=date]{font:inherit;padding:3px 6px}.msgs{padding-left:22px}.msgs li{margin:6px 0}.empty,.more{color:var(--muted);font-size:13px}
.ai{border-left:4px solid var(--gold);padding:4px 0 4px 18px}
nav{display:flex;flex-wrap:wrap;gap:4px 14px;font-size:14px;margin:8px 0 0}nav a{color:var(--green)}
a:focus-visible{outline:2px solid var(--gold);outline-offset:2px}
@media (max-width:640px){.kpis{grid-template-columns:repeat(2,1fr)}h1{font-size:26px}.ladder li{grid-template-columns:30px 1fr}.ladder .cash{grid-column:2}}
@media print{:root{--paper:#fff;--ink:#0f2a24;--wash:#eef3ef;--line:#d5dbd4;--muted:#5d6b66}main{padding:0 12mm;max-width:none;width:100%}h3{break-after:avoid}.cols{grid-template-columns:repeat(2,minmax(0,1fr))}nav{display:none}.tw{overflow:visible}table{font-size:10px}.bar,.ladder li,.msgs li{break-inside:avoid}h2{break-after:avoid}thead{display:table-header-group}.pitch{min-width:0;max-width:none}.msgs{font-size:11px}.msgs li{margin:5px 0}}`;

  const segTag = (s) => `<span class="tag ${s}">${s.replace("_", " ")}</span>`;

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ZimQuote intelligence ${fmtDate(S.generatedAt)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:wght@700;800&family=Public+Sans:wght@400;650&display=swap" rel="stylesheet">
<style>${css}</style></head><body><main>
<h1>Where the money is on ZimQuote</h1>
<p class="sub">Full history from ${fmtDate(S.window.firstDay)} to ${fmtDate(S.generatedAt)} (${S.window.days} days). Read-only scan of the live database.</p>
<nav><a href="#actions">Actions</a><a href="#sellers">Sellers</a><a href="#schools">Schools</a><a href="#demand">Demand</a><a href="#gaps">Supply gaps</a><a href="#retention">Retention</a><a href="#acq">Acquisition</a><a href="#lapsed">Lapsed buyers</a><a href="#dq">Data quality</a>${aiText ? '<a href="#ai">Claude memo</a>' : ""}</nav>

<div class="kpis">
<div class="kpi"><b>${money(k.mrr)}</b><span>Real monthly revenue now</span></div>
<div class="kpi"><b>${money(k.cashCollected)}</b><span>Cash ever collected (${k.paymentsCount} payments)</span></div>
<div class="kpi"><b>${k.suppliersPaying}/${k.suppliers}</b><span>Sellers paying</span></div>
<div class="kpi"><b>${k.schoolsPaying}/${k.schools}</b><span>Schools paying</span></div>
<div class="kpi"><b>${k.peopleEver.toLocaleString()}</b><span>Buyers ever seen</span></div>
<div class="kpi"><b>${k.wau} / ${k.mau}</b><span>Active this week / 30 days</span></div>
<div class="kpi"><b>${k.oneAndDonePct}%</b><span>Came once, never back</span></div>
<div class="kpi"><b>${k.zeroResultPct}%</b><span>Searches with no results</span></div>
</div>

<h2 id="actions">Money actions, in order</h2>
<p class="sub">Monthly figures are at list price. Realistic month-one target: <strong>${money(S.money.potential.realistic)}/month</strong> new recurring revenue.</p>
<ol class="ladder">${actions.map(a => `<li><div><strong>${esc(a.title)}</strong>${esc(a.body)}</div><div class="cash">${a.cash ? money(a.cash) + "/mo" : ""}</div></li>`).join("")}</ol>

<h2 id="sellers">Sellers</h2>
<div class="cols"><div><h3>Segments</h3>${bars(S.suppliers.segCounts)}</div><div><h3>Subscription status</h3>${bars(S.suppliers.supplierStatus)}</div></div>
${full ? `<h3>Conversion targets across time frames (unpaid sellers, ranked by all-time proof of value)</h3>
<p class="sub">Leads = unique buyers who saw them in search + unique link visitors + requests sent to them + orders, counted for each time frame. Market = buyer searches in their city for what they sell.</p>
${S.timeline ? windowedTable(S.timeline, { phones: true }) : table(S.suppliers.conversionTargets, [
    { label: "Business", key: "businessName" }, { label: "Phone", key: "phone" }, { label: "City", key: "city" }, { label: "Segment", get: r => segTag(r.segment), html: true },
    { label: "Seen 30d", key: "searchersReached30", num: true }, { label: "Seen all", key: "searchersReached", num: true },
    { label: "Visitors all", key: "linkVisitorsAll", num: true }, { label: "Requests all", key: "requestsNotified", num: true }, { label: "Orders", key: "orders", num: true },
    { label: "Market all", key: "marketAll", num: true }, { label: "Prices", key: "priceCount", num: true }], { limit: 1e6 })}
<h3>Messages to send (every conversion target)</h3>
${S.timeline ? windowedMessages(S.timeline, { phones: true }) : `<ol class="msgs">${S.suppliers.conversionTargets.filter(r => r.pitch).map(r =>
    `<li><strong>${esc(r.businessName)}</strong> · ${esc(r.phone)} · ${esc(r.city)}<br><span class="pitch">${esc(r.pitch)}</span></li>`).join("")}</ol>`}` :
`<h3>Conversion targets (unpaid, ranked by proof of value)</h3>
<p class="sub">Pick any time frame - the ranking, numbers and messages all change to match it.</p>
${interactiveTargets(S)}`}
<h3>Trials ending in the next 14 days</h3>
${table(S.suppliers.expiringSoon, [{ label: "Business", key: "businessName" }, { label: "City", key: "city" }, { label: "Days left", key: "daysToEnd", num: true },
    { label: "Leads (30d)", key: "leads30", num: true }, { label: "Segment", get: r => segTag(r.segment), html: true }], { limit: L(30) })}

<h2 id="schools">Schools</h2>
${table(S.schools.rows, [{ label: "School", key: "schoolName" }, { label: "City", key: "city" }, { label: "Segment", get: r => segTag(r.segment), html: true },
    { label: "Link opens", key: "linkOpens", num: true }, { label: "Parent contacts", key: "contacts", num: true }, { label: "Contacts (30d)", key: "contacts30", num: true },
    { label: "Applications", key: "applications", num: true }, { label: "Lead actions", key: "leadActions", num: true }, { label: "Not followed up", key: "uncontactedLeads", num: true },
    { label: "Paid", get: r => money(r.paidTotal), num: true }], { limit: L(30) })}

<h2 id="demand">What people search for</h2>
<div class="cols"><div><h3>Top search terms</h3>${bars(S.demand.topTerms.slice(0, full ? 50 : 25).map(([t, n]) => [t, n]), { max: full ? 50 : 25 })}</div>
<div><h3>Cities</h3>${bars(S.demand.byCity, { max: 15 })}<h3>Result outcome</h3>${bars(S.demand.byMode)}</div></div>
<h3>Searches per week</h3>${bars(Object.entries(S.demand.searchesByWeek).sort(), { max: 30 })}
<h3>When people search (Harare time)</h3><p class="sub">Send broadcasts just before the darkest cells.</p>${heatmap(S.demand.heat)}
<h3>Searches with no results (unmet demand)</h3>
${table(S.demand.zeroTop, [{ label: "Searched for", key: "term" }, { label: "City", key: "city" }, { label: "People", key: "people", num: true },
    { label: "Times", key: "count", num: true }, { label: "Last", get: r => fmtDate(r.last) }], { limit: L(30) })}

<h2 id="gaps">Supply gaps: demand per active seller (last 90 days)</h2>
${table(S.demand.gapRows, [{ label: "Keyword", key: "keyword" }, { label: "City", key: "city" }, { label: "Searches", key: "searches90", num: true },
    { label: "Active sellers", key: "activeSuppliers", num: true }, { label: "Searches per seller", key: "ratio", num: true }], { limit: L(30) })}

<h2 id="retention">Do people come back?</h2>
<div class="cols"><div><h3>Days active per person</h3>${bars(S.retention.activeDayHist)}</div>
<div><h3>First search outcome vs coming back</h3>
<p>First search found something: <strong>${fr.found.returnPct}%</strong> came back (${fr.found.people} people).<br>
First search found nothing: <strong>${fr.none.returnPct}%</strong> came back (${fr.none.people} people).</p>
<h3>Searches per searcher</h3>${bars(S.demand.searchesPerSearcher)}</div></div>
<h3>Weekly cohorts: % active again after N weeks</h3>
${table(S.retention.cohortRows.slice(full ? 0 : -20).reverse(), [{ label: "First week", key: "week" }, { label: "People", key: "size", num: true },
    ...[1, 2, 4, 8, 12].map(o => ({ label: `+${o}w`, get: r => r[`w${o}`] === null ? "" : r[`w${o}`] + "%", num: true }))], { limit: L(20) })}

<h2 id="acq">Where people come from</h2>
<p class="sub">From the first thing each person sent the bot. Website channels: <strong>${webShare}%</strong> of all people. Ads or unknown 'Hi': <strong>${adShare}%</strong>.</p>
<div class="cols"><div><h3>Entry channel</h3>${bars(ch, { labelFmt: c => CHANNEL_LABEL[c] || c })}</div>
<div><h3>Do they come back? (by channel)</h3>${table(Object.entries(S.acquisition.channelReturn).sort((a, b) => b[1].people - a[1].people).map(([c, v]) => ({ c, ...v })),
    [{ label: "Channel", get: r => CHANNEL_LABEL[r.c] || r.c }, { label: "People", key: "people", num: true }, { label: "Searched", key: "searched", num: true }, { label: "Came back", get: r => r.returnPct + "%", num: true }])}</div></div>
<div class="cols"><div><h3>New people per month</h3>${bars(Object.entries(S.acquisition.newByMonth).sort())}</div>
<div><h3>SEO page groups that bring people</h3>${bars(topN(S.acquisition.seoPages, 20))}</div></div>
<h3>Smart-link visitor sources</h3>${bars(topN(S.acquisition.linkSources, 20))}

<h2 id="lapsed">Lapsed buyers worth winning back</h2>
<p class="sub">Last seen 14-180 days ago. Numbers are masked here; the CSV has the full list.</p>
${table(S.lapsed, [{ label: "Phone", get: r => full ? r.phone : maskPhone(r.phone) }, { label: "Last wanted", key: "lastTerm" }, { label: "City", key: "city" },
    { label: "Days away", key: "daysSince", num: true }, { label: "Active days", key: "activeDays", num: true },
    { label: "Failed then, sellers now", get: r => r.lastHadNoResults && r.suppliersNowAvailable ? `yes (${r.suppliersNowAvailable})` : "" }], { limit: L(25) })}

${full ? `<h2 id="all-sellers">Every seller, scored</h2>
<p class="sub">All ${S.suppliers.rows.length} seller profiles, ranked by proof of value. Leads = searchers who saw them + link visitors + requests + orders.</p>
${table([...S.suppliers.rows].sort((a, b) => b.proof - a.proof), [
    { label: "Business", key: "businessName" }, { label: "Phone", key: "phone" }, { label: "City", get: r => [r.city, r.area].filter(Boolean).join(", ") },
    { label: "Type", key: "profileType" }, { label: "Status", get: r => `${r.subscriptionStatus || "-"}${r.accessActive ? "" : " (off)"}` },
    { label: "Segment", get: r => segTag(r.segment), html: true }, { label: "Paid", get: r => money(r.paidTotal), num: true },
    { label: "Leads 30d", key: "leads30", num: true }, { label: "Leads all", key: "leadsAll", num: true },
    { label: "Orders", key: "orders", num: true }, { label: "Market 30d", key: "market30", num: true },
    { label: "Prices", key: "priceCount", num: true }, { label: "Profile %", key: "completeness", num: true },
    { label: "Ends", get: r => fmtDate(r.endsAt) }, { label: "Joined", get: r => fmtDate(r.createdAt) }
  ], { limit: 1e6 })}` : ""}

<h2 id="dq">Data quality</h2>
${table(Object.entries(S.dataQuality).map(([k2, v]) => ({ k2, v })), [{ label: "Check", key: "k2" }, { label: "Value", key: "v", num: true }])}
<p class="sub">Collections read: ${esc(Object.entries(S.collections).map(([a, b]) => `${a}=${b || "missing"}`).join(", "))}</p>

${aiText ? `<h2 id="ai">Claude's strategy memo</h2><div class="ai">${mdToHtml(aiText)}</div>` : ""}
</main></body></html>`;
}

// ═════════════════════════════════════════════════════════════════════════════
// Memo document + PDF export
// ═════════════════════════════════════════════════════════════════════════════
// The memo contains NO phone numbers (Claude never receives them and the data
// appendix leaves them out), so memo.html / memo.pdf are safe to share.
// report.pdf is the internal working copy: every row, with phone numbers.
export function renderMemoHtml(S, aiText) {
  const k = S.kpi || {};
  const rows = Array.isArray(S.suppliers?.rows) ? S.suppliers.rows : null;          // null when built from summary.json
  const targets = Array.isArray(S.suppliers?.conversionTargets) ? S.suppliers.conversionTargets : null;
  const expiring = Array.isArray(S.suppliers?.expiringSoon) ? S.suppliers.expiringSoon : null;
  const schools = Array.isArray(S.schools?.rows) ? S.schools.rows : null;
  const lapsed = Array.isArray(S.lapsed) ? S.lapsed : null;
  const fr = S.retention?.firstResult || { found: {}, none: {} };
  const segTag = (x) => `<span class="tag ${x}">${String(x).replace("_", " ")}</span>`;
  const ends = (r) => r.daysToEnd === null || r.daysToEnd === undefined ? "" : r.daysToEnd < 0 ? `${-r.daysToEnd}d ago` : r.daysToEnd === 0 ? "today" : `in ${r.daysToEnd}d`;
  const kv = (list) => table(list.map(([a, b, c]) => ({ a, b, c })), [{ label: "Measure", key: "a" }, { label: "Value", key: "b", num: true }, { label: "What it means", key: "c" }], { limit: 1e6 });
  const objRows = (o, l1 = "Item", l2 = "Count") => table(Object.entries(o || {}).sort((a, b) => b[1] - a[1]).map(([a, b]) => ({ a, b })),
    [{ label: l1, key: "a" }, { label: l2, key: "b", num: true }], { limit: 1e6 });
  const missing = `<p class="empty">Detailed rows are not in this older run. Click "Run new scan" and rebuild the PDF to include them.</p>`;

  const hourTotals = S.demand?.heat ? S.demand.heat[0].map((_, h) => S.demand.heat.reduce((t, r) => t + r[h], 0)) : [];
  const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const dayTotals = S.demand?.heat ? S.demand.heat.map(r => r.reduce((a, b) => a + b, 0)) : [];

  // Money ladder (same logic as the report)
  const hotN = rows ? rows.filter(r => r.segment === "hot_unpaid").length : (S.suppliers?.segCounts?.hot_unpaid || 0);
  const warmN = S.suppliers?.segCounts?.warm_unpaid || 0;
  const hotSchN = schools ? schools.filter(r => r.segment === "hot_unpaid").length : 0;
  const pot = S.money?.potential || {};
  const lapsedN = lapsed ? lapsed.length : (typeof S.lapsed === "number" ? S.lapsed : 0);
  const lapsedUnmet = lapsed ? lapsed.filter(l => l.lastHadNoResults && l.suppliersNowAvailable).length : 0;

  const css = `
:root{--ink:#0f2a24;--paper:#fff;--line:#d5dbd4;--muted:#5d6b66;--green:#1f7a4d;--gold:#c99400;--red:#b23a2b;--wash:#eef3ef}
*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:14.5px/1.6 "Public Sans","Segoe UI",system-ui,sans-serif}
main{max-width:860px;margin:0 auto;padding:40px 24px 80px}
.cover{border-bottom:3px solid var(--ink);padding-bottom:22px;margin-bottom:22px}
.cover h1{font:800 38px/1.08 "Bricolage Grotesque","Public Sans",system-ui,sans-serif;letter-spacing:-.02em;margin:0 0 10px}
.cover p{color:var(--muted);margin:0}
.strip{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));border:1px solid var(--line);margin:20px 0 0}
.strip div{padding:10px 12px;border-right:1px solid var(--line);border-bottom:1px solid var(--line)}
.strip b{display:block;font:700 21px/1.1 "Bricolage Grotesque",system-ui,sans-serif}.strip span{font-size:12px;color:var(--muted)}
.part{font:800 30px/1.1 "Bricolage Grotesque",system-ui,sans-serif;margin:44px 0 6px;padding-top:16px;border-top:3px solid var(--ink)}
h2{font:750 23px/1.2 "Bricolage Grotesque",system-ui,sans-serif;margin:30px 0 8px}
h3{font:750 18px/1.25 "Bricolage Grotesque",system-ui,sans-serif;margin:26px 0 8px;padding-top:10px;border-top:1px solid var(--line)}
h4,h5{font-size:15.5px;margin:18px 0 6px}
p,li{max-width:76ch}ul,ol{padding-left:22px}li{margin:3px 0}.sub{color:var(--muted)}
.tw{overflow-x:auto;border:1px solid var(--line);margin:10px 0}table{border-collapse:collapse;width:100%;font-size:12.5px}
th,td{padding:5px 7px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}th{background:var(--wash);white-space:nowrap}
td.n,th.n{text-align:right;font-variant-numeric:tabular-nums}
.bars{display:grid;gap:3px;margin:8px 0}.bar{display:grid;grid-template-columns:minmax(90px,40%) 1fr 56px;gap:8px;align-items:center;font-size:12.5px}
.bl{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.bt{background:var(--wash);height:12px}.bt i{display:block;height:100%;background:var(--green)}.bv{text-align:right}
.tag{display:inline-block;padding:0 6px;border:1px solid currentColor;font-size:11px;white-space:nowrap}
.hot_unpaid,.lapsed_payer{color:var(--red)}.paying{color:var(--green)}.warm_unpaid{color:var(--gold)}.no_signal{color:var(--muted)}
.pitch{font-size:11.5px;color:var(--muted)}.ladder{padding-left:20px}.ladder li{margin:8px 0}.ladder b{color:var(--green)}
code{background:var(--wash);padding:0 4px}hr{border:0;border-top:2px solid var(--line);margin:30px 0}
.empty,.more{color:var(--muted);font-size:13px}.cols{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:24px}
@media (max-width:640px){.strip,.cols{grid-template-columns:repeat(2,minmax(0,1fr))}.cols{grid-template-columns:1fr}.cover h1{font-size:28px}}
@media print{main{padding:0 13mm;max-width:none}.part{break-before:page;border-top:0}h2,h3,h4{break-after:avoid}
  tr,li,.bar{break-inside:avoid}.tw{overflow:visible;border:0}table{font-size:10.5px}thead{display:table-header-group}a{color:inherit}}`;

  const memoPart = aiText
    ? mdToHtml(aiText.replace(/^# ZimQuote strategy memo\s*/i, ""))
    : `<p class="empty">This run has no Claude memo. Click "Scan + Claude memo" (or run <code>node scripts/zqIntel.js --ai</code>) to add the written strategy. The data briefing below is complete without it.</p>`;

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ZimQuote strategy memo ${fmtDate(S.generatedAt)}</title>
<link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:wght@700;800&family=Public+Sans:wght@400;650&display=swap" rel="stylesheet">
<style>${css}</style></head><body><main>
<div class="cover"><h1>ZimQuote strategy memo and data briefing</h1>
<p>Data from ${fmtDate(S.window?.firstDay)} to ${fmtDate(S.generatedAt)} (${S.window?.days || 0} days) · ${(k.peopleEver || 0).toLocaleString()} buyers, ${k.suppliers || 0} sellers, ${k.schools || 0} schools, ${(k.searchesTotal || 0).toLocaleString()} searches</p>
<div class="strip">
<div><b>${money(k.mrr)}</b><span>Monthly revenue now</span></div>
<div><b>${money(k.cashCollected)}</b><span>Cash ever collected</span></div>
<div><b>${k.suppliersPaying || 0}/${k.suppliers || 0}</b><span>Sellers paying</span></div>
<div><b>${k.schoolsPaying || 0}/${k.schools || 0}</b><span>Schools paying</span></div>
<div><b>${k.wau || 0} / ${k.mau || 0}</b><span>Active buyers week / 30 days</span></div>
<div><b>${k.oneAndDonePct || 0}%</b><span>Buyers who never return</span></div>
<div><b>${k.zeroResultPct || 0}%</b><span>Searches with no results</span></div>
<div><b>${money(pot.realistic)}</b><span>Realistic new monthly revenue</span></div>
</div></div>
<p>Part A is the written strategy. Part B is the evidence behind it: every number the scan produced, laid out section by section. Phone numbers are deliberately left out so this document can be shared.</p>

<div class="part">Part A. Strategy</div>
${memoPart}

<div class="part">Part B. Data briefing</div>

<h2>B1. Key numbers</h2>
${kv([
  ["Real monthly revenue", money(k.mrr), "Sellers and schools with a real payment that is still current"],
  ["Cash ever collected", `${money(k.cashCollected)} (${k.paymentsCount || 0} payments)`, "Real EcoCash/Paynow payments; $0 admin trials excluded"],
  ["Admin trial records", k.adminTrialRecords || 0, "Free trials logged as 'paid' with $0 - not revenue"],
  ["Pending payments", k.pendingPayments || 0, "EcoCash prompts started but never completed - follow these up"],
  ["Sellers / with live access", `${k.suppliers || 0} / ${k.suppliersAccessActive || 0}`, "Profiles that can currently be found in search"],
  ["Buyers ever seen", k.peopleEver || 0, "Unique non-seller WhatsApp numbers"],
  ["Came back at least once", `${k.returnedPct || 0}%`, "Active on 2 or more different days"],
  ["Came back a week+ later", `${k.returned7Pct || 0}%`, "The real retention number"],
  ["Searches (all / real)", `${k.searchesTotal || 0} / ${k.realSearches || 0}`, "Real = excluding deep-link codes and greetings"],
  ["Buyer requests / orders", `${k.buyerRequests || 0} / ${k.orders || 0}`, "Requests sent to sellers; orders placed through the bot"]
])}

<h2>B2. Money actions, in order</h2>
<ol class="ladder">
<li>Convert <strong>${hotN}</strong> hot unpaid sellers - worth <b>${money(pot.hotSuppliers)}/mo</b> at list price (about ${money((pot.hotSuppliers || 0) * 0.4)}/mo at 40% conversion).</li>
<li>Convert <strong>${hotSchN}</strong> school${hotSchN === 1 ? "" : "s"} with live parent interest - <b>${money(pot.hotSchools)}/mo</b>.</li>
<li>Nudge <strong>${warmN}</strong> warm sellers with market-size proof - about <b>${money((pot.warmSuppliers || 0) * 0.1)}/mo</b> at 10% conversion.</li>
<li>Win back <strong>${lapsedN}</strong> lapsed buyers${lapsed ? `, ${lapsedUnmet} of whom searched for something you now have` : ""}.</li>
<li>Recruit sellers for the top unmet searches (B7) - you can tell each recruit how many buyers already asked.</li>
</ol>

<h2>B3. Sellers</h2>
<div class="cols"><div><h4>Segments</h4>${objRows(S.suppliers?.segCounts, "Segment", "Sellers")}</div><div><h4>Subscription status</h4>${objRows(S.suppliers?.supplierStatus, "Status", "Sellers")}</div></div>
<p class="sub">Hot = 5+ buyer touches in 30 days or an order. Warm = some visibility or clear market demand. No signal = nothing yet.</p>
<h3>Conversion targets across time frames</h3>
${S.timeline ? windowedTable(S.timeline) : ""}
<h3>Conversion targets, last 30 days</h3>
${targets ? table(targets, [
    { label: "Business", key: "businessName" }, { label: "City", key: "city" }, { label: "Segment", get: r => segTag(r.segment), html: true },
    { label: "Seen 30d", key: "searchersReached30", num: true }, { label: "Visitors 30d", key: "linkVisitors30", num: true },
    { label: "Requests 30d", key: "requestsNotified30", num: true }, { label: "Orders", key: "orders", num: true },
    { label: "Market 30d", key: "market30", num: true }, { label: "Prices", key: "priceCount", num: true }, { label: "Trial", get: ends }
  ], { limit: 1e6 }) : missing}
<h3>Ready-made messages</h3>
${S.timeline ? windowedMessages(S.timeline) : targets ? `<ol>${targets.slice(0, 25).filter(r => r.pitch).map(r => `<li><strong>${esc(r.businessName)}</strong> (${esc(r.city)}): <span class="pitch">${esc(r.pitch)}</span></li>`).join("")}</ol>` : missing}
<h3>Trials ending in the next 14 days</h3>
${expiring ? table(expiring, [{ label: "Business", key: "businessName" }, { label: "City", key: "city" }, { label: "Days left", key: "daysToEnd", num: true },
    { label: "Leads 30d", key: "leads30", num: true }, { label: "Segment", get: r => segTag(r.segment), html: true }], { limit: 1e6 }) : missing}
<h3>Every seller at a glance</h3>
${rows ? table([...rows].sort((a, b) => b.proof - a.proof), [
    { label: "Business", key: "businessName" }, { label: "City", key: "city" }, { label: "Type", key: "profileType" },
    { label: "Segment", get: r => segTag(r.segment), html: true }, { label: "Paid", get: r => money(r.paidTotal), num: true },
    { label: "Leads 30d", key: "leads30", num: true }, { label: "Leads all", key: "leadsAll", num: true },
    { label: "Prices", key: "priceCount", num: true }, { label: "Profile %", key: "completeness", num: true }, { label: "Trial", get: ends }
  ], { limit: 1e6 }) : missing}

<h2>B4. Schools</h2>
${schools ? table(schools, [{ label: "School", key: "schoolName" }, { label: "City", key: "city" }, { label: "Segment", get: r => segTag(r.segment), html: true },
    { label: "Link opens", key: "linkOpens", num: true }, { label: "Parent contacts", key: "contacts", num: true }, { label: "Contacts 30d", key: "contacts30", num: true },
    { label: "Applications", key: "applications", num: true }, { label: "Lead actions", key: "leadActions", num: true },
    { label: "Not followed up", key: "uncontactedLeads", num: true }, { label: "Paid", get: r => money(r.paidTotal), num: true }], { limit: 1e6 }) : missing}

<h2>B5. What buyers search for</h2>
<h3>Top search terms</h3>
${table((S.demand?.topTerms || []).map(([t, n, p]) => ({ t, n, p })), [{ label: "Search term", key: "t" }, { label: "Searches", key: "n", num: true }, { label: "People", key: "p", num: true }], { limit: 1e6 })}
<div class="cols"><div><h4>Cities</h4>${table((S.demand?.byCity || []).map(([a, b]) => ({ a, b })), [{ label: "City", key: "a" }, { label: "Searches", key: "b", num: true }], { limit: 1e6 })}</div>
<div><h4>Search outcome</h4>${objRows(S.demand?.byMode, "Result", "Searches")}<h4>Searches per searcher</h4>${objRows(S.demand?.searchesPerSearcher, "Searches", "People")}</div></div>
<h3>When people search (Harare time)</h3>
<div class="cols"><div><h4>By hour</h4>${bars(hourTotals.map((v, h) => [`${String(h).padStart(2, "0")}:00`, v]), { max: 24 })}</div>
<div><h4>By weekday</h4>${bars([1, 2, 3, 4, 5, 6, 0].map(d => [dayNames[d], dayTotals[d] || 0]), { max: 7 })}</div></div>
<h3>Searches per week</h3>
${bars(Object.entries(S.demand?.searchesByWeek || {}).sort(), { max: 60 })}

<h2>B6. Buyer requests and orders</h2>
${kv([
  ["Requests (all / last 30 days)", `${S.requestStats?.total || 0} / ${S.requestStats?.last30 || 0}`, "Buyers asking several sellers at once"],
  ["Requests with a seller reply", `${S.requestStats?.withResponse || 0} (${S.requestStats?.responseRatePct || 0}%)`, "Low here means sellers aren't answering - fix before charging"],
  ["Requests sent to nobody", S.requestStats?.notifiedNone || 0, "No matching seller - pure supply gap"],
  ["Orders (all / last 30 days)", `${S.orderStats?.total || 0} / ${S.orderStats?.last30 || 0}`, ""],
  ["Order value", money(S.orderStats?.value), "Estimated goods value passed to sellers"],
  ["Unique buyers / sellers in orders", `${S.orderStats?.uniqueBuyers || 0} / ${S.orderStats?.uniqueSellers || 0}`, ""]
])}
<div class="cols"><div><h4>Requests by status</h4>${objRows(S.requestStats?.byStatus, "Status")}</div><div><h4>Orders by status</h4>${objRows(S.orderStats?.byStatus, "Status")}</div></div>

<h2>B7. Unmet demand (searches with no results)</h2>
${table(S.demand?.zeroTop || [], [{ label: "Searched for", key: "term" }, { label: "City", key: "city" }, { label: "People", key: "people", num: true },
    { label: "Times", key: "count", num: true }, { label: "Last", get: r => fmtDate(r.last) }], { limit: 1e6 })}

<h2>B8. Supply gaps (last 90 days)</h2>
<p class="sub">Searches per active seller for each keyword and city. High ratios are where a new seller would get the most buyers.</p>
${table(S.demand?.gapRows || [], [{ label: "Keyword", key: "keyword" }, { label: "City", key: "city" }, { label: "Searches", key: "searches90", num: true },
    { label: "Active sellers", key: "activeSuppliers", num: true }, { label: "Searches per seller", key: "ratio", num: true }], { limit: 1e6 })}

<h2>B9. Retention</h2>
<div class="cols"><div><h4>Days active per person</h4>${objRows(S.retention?.activeDayHist, "Active days", "People")}</div>
<div><h4>First search outcome vs coming back</h4>
<p>Found something: <strong>${fr.found?.returnPct || 0}%</strong> came back (${fr.found?.people || 0} people).<br>Found nothing: <strong>${fr.none?.returnPct || 0}%</strong> came back (${fr.none?.people || 0} people).</p></div></div>
<h3>Weekly cohorts: % active again after N weeks</h3>
${table([...(S.retention?.cohortRows || [])].reverse(), [{ label: "First week", key: "week" }, { label: "People", key: "size", num: true },
    ...[1, 2, 4, 8, 12].map(o => ({ label: `+${o}w`, get: r => r[`w${o}`] === null || r[`w${o}`] === undefined ? "" : r[`w${o}`] + "%", num: true }))], { limit: 1e6 })}

<h2>B10. Where buyers come from</h2>
${table(Object.entries(S.acquisition?.channelReturn || {}).sort((a, b) => b[1].people - a[1].people).map(([c, v]) => ({ c, ...v })),
    [{ label: "First message / channel", get: r => CHANNEL_LABEL[r.c] || r.c }, { label: "People", key: "people", num: true },
     { label: "Searched", key: "searched", num: true }, { label: "Came back", get: r => r.returnPct + "%", num: true }], { limit: 1e6 })}
<div class="cols"><div><h4>New people per month</h4>${bars(Object.entries(S.acquisition?.newByMonth || {}).sort())}</div>
<div><h4>SEO page groups that bring people</h4>${bars(topN(S.acquisition?.seoPages || {}, 30))}</div></div>
<h4>Smart-link sources</h4>${bars(topN(S.acquisition?.linkSources || {}, 20))}

<h2>B11. Lapsed buyers</h2>
${lapsed ? `${kv([
  ["Lapsed buyers (14-180 days away)", lapsed.length, "Win-back audience"],
  ["Searched for something you now have", lapsedUnmet, "Best people to message first"],
  ["Made a request or order before", lapsed.filter(l => l.requests || l.orders).length, "Proven intent"],
  ["Never searched", lapsed.filter(l => !l.searches).length, "Arrived but never used the bot"]
])}
<div class="cols"><div><h4>Days away</h4>${objRows(lapsed.reduce((m, l) => inc(m, l.daysSince <= 30 ? "14-30" : l.daysSince <= 60 ? "31-60" : l.daysSince <= 90 ? "61-90" : "91-180"), {}), "Days", "People")}</div>
<div><h4>What they last wanted</h4>${table(topN(lapsed.reduce((m, l) => l.lastTerm ? inc(m, l.lastTerm) : m, {}), 30).map(([a, b]) => ({ a, b })), [{ label: "Search", key: "a" }, { label: "People", key: "b", num: true }], { limit: 1e6 })}</div></div>` : missing}

<h2>B12. Payments by month</h2>
${table(Object.entries(S.money?.paymentsByMonth || {}).sort().map(([m, v]) => ({ m, v })), [{ label: "Month", key: "m" }, { label: "Collected", get: r => money(r.v), num: true }], { limit: 1e6 })}

<h2>B13. Data quality</h2>
${objRows(S.dataQuality, "Check", "Value")}
<p class="sub">Generated ${esc(String(S.generatedAt || ""))} by scripts/zqIntel.js (read-only scan).</p>
</main></body></html>`;
}

export async function renderPdf(html, filepath, { landscape = false } = {}) {
  let puppeteer;
  try { puppeteer = (await import("puppeteer")).default; }
  catch { throw new Error("puppeteer is not installed - run: npm install puppeteer"); }
  const browser = await puppeteer.launch({ headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--font-render-hinting=none"] });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(60000);
    // "load" + a capped wait for web fonts: never hang on a slow/blocked Google Fonts request
    await page.setContent(html, { waitUntil: "load", timeout: 60000 });
    await Promise.race([page.evaluate(() => document.fonts && document.fonts.ready), new Promise(r => setTimeout(r, 6000))]).catch(() => {});
    await page.emulateMediaType("print");
    const tmp = filepath + ".tmp";
    await page.pdf({ path: tmp, format: "A4", landscape, printBackground: true,
      margin: { top: "14mm", bottom: "16mm", left: "0", right: "0" },
      displayHeaderFooter: true, headerTemplate: "<span></span>",
      footerTemplate: `<div style="font:8px sans-serif;color:#777;width:100%;text-align:center">ZimQuote intelligence · page <span class="pageNumber"></span> of <span class="totalPages"></span></div>` });
    if (!fs.existsSync(tmp) || fs.statSync(tmp).size < 1000) throw new Error("PDF came out empty");
    fs.renameSync(tmp, filepath);                       // only replace the old PDF once the new one is good
    return true;
  } finally { await browser.close().catch(() => {}); }
}

// Builds memo.html, memo.pdf and report.pdf for a run folder (CLI + admin route).
// Uses report_data.json (every row) when present; older runs fall back to summary.json.
export async function buildPdfs(runDir, { report = true, memo = true } = {}) {
  const fullPath = path.join(runDir, "report_data.json");
  const detailed = fs.existsSync(fullPath);
  const S = JSON.parse(fs.readFileSync(detailed ? fullPath : path.join(runDir, "summary.json"), "utf8"));
  S.run = S.run || path.basename(runDir);
  const mdPath = path.join(runDir, "ai_strategy.md");
  const memoMd = fs.existsSync(mdPath) ? fs.readFileSync(mdPath, "utf8") : null;
  const made = [], errors = [];
  if (memo) {
    try {
      const html = renderMemoHtml(S, memoMd);
      fs.writeFileSync(path.join(runDir, "memo.html"), html, "utf8");
      await renderPdf(html, path.join(runDir, "memo.pdf"));
      made.push("memo.pdf");
    } catch (e) { errors.push(`memo.pdf: ${e.message}`); }
  }
  if (report) {
    try {
      const html = detailed ? renderHtml(S, memoMd, { full: true })
        : (fs.existsSync(path.join(runDir, "report.html")) ? fs.readFileSync(path.join(runDir, "report.html"), "utf8") : null);
      if (!html) throw new Error("no report data in this run");
      if (detailed) fs.writeFileSync(path.join(runDir, "report_full.html"), html, "utf8");
      await renderPdf(html, path.join(runDir, "report.pdf"), { landscape: true });
      made.push("report.pdf");
    } catch (e) { errors.push(`report.pdf: ${e.message}`); }
  }
  return { made, errors, detailed };
}

// ═════════════════════════════════════════════════════════════════════════════
// Write outputs
// ═════════════════════════════════════════════════════════════════════════════
export function writeOutputs(S, outDir, aiText) {
  fs.mkdirSync(outDir, { recursive: true });
  const supCols = ["businessName", "phone", "city", "area", "profileType", "categories", "tier", "subscriptionStatus", "accessActive",
    "endsAt", "daysToEnd", "segment", "proof", "paidTotal", "lastPaidAt", "searchersReached30", "searchersReached", "appearances30",
    "appearancesAll", "linkVisitors30", "linkVisitorsAll", "linkOpens", "linkSources", "requestsNotified30", "requestsNotified",
    "requestResponses", "orders", "orders30", "orderValue", "market30", "marketPeople30", "marketTopTerms", "priceCount",
    "completeness", "profileViews", "savedBy", "createdAt", "lastUpdated", "priceUpdatedAt", "pitch"].map(key => ({ key }));
  writeCsv(path.join(outDir, "supplier_scorecard.csv"), [...S.suppliers.rows].sort((a, b) => b.proof - a.proof), supCols);
  writeCsv(path.join(outDir, "conversion_targets.csv"), S.suppliers.conversionTargets,
    ["businessName", "phone", "city", "segment", "proof", "daysToEnd", "leads30", "searchersReached30", "linkVisitors30",
     "requestsNotified30", "orders", "market30", "priceCount", "price", "pitch"].map(key => ({ key })));
  writeCsv(path.join(outDir, "school_scorecard.csv"), S.schools.rows,
    ["schoolName", "phone", "city", "suburb", "institutionType", "segment", "active", "endsAt", "daysToEnd", "linkOpens", "monthlyViews",
     "inquiries", "contacts", "contacts30", "applications", "leadActions", "uncontactedLeads", "paidTotal"].map(key => ({ key })));
  writeCsv(path.join(outDir, "lapsed_buyers.csv"), S.lapsed,
    ["phone", "score", "lastTerm", "city", "daysSince", "lastSeen", "firstSeen", "activeDays", "searches", "lastHadNoResults",
     "suppliersNowAvailable", "entry", "requests", "orders"].map(key => ({ key })));
  writeCsv(path.join(outDir, "unmet_demand.csv"), S.demand.zeroTop.concat([]),
    ["term", "city", "people", "count", "last", "flow"].map(key => ({ key })));
  writeCsv(path.join(outDir, "supply_gaps.csv"), S.demand.gapRows, ["keyword", "city", "searches90", "activeSuppliers", "ratio"].map(key => ({ key })));
  writeCsv(path.join(outDir, "cohort_retention.csv"), S.retention.cohortRows,
    ["week", "size", "w1", "w2", "w4", "w8", "w12"].map(key => ({ key })));

  const slim = { ...S, timeline: undefined, suppliers: { ...S.suppliers, rows: undefined, conversionTargets: S.suppliers.conversionTargets.length,
    expiringSoon: S.suppliers.expiringSoon.length }, schools: { count: S.schools.rows.length }, lapsed: S.lapsed.length };
  fs.writeFileSync(path.join(outDir, "summary.json"), JSON.stringify(slim, null, 2));
  // complete dataset (internal - has phone numbers) used to rebuild detailed PDFs later
  fs.writeFileSync(path.join(outDir, "report_data.json"), JSON.stringify(S));
  fs.writeFileSync(path.join(outDir, "report.html"), renderHtml(S, aiText), "utf8");
}

// ═════════════════════════════════════════════════════════════════════════════
// Main
// ═════════════════════════════════════════════════════════════════════════════
async function main() {
  if (!OPT.uri) { console.error("MONGODB_URI is not set (in .env or --uri)."); process.exit(1); }
  const since = OPT.since ? new Date(OPT.since + "T00:00:00Z") : null;
  log(`connecting${OPT.db ? " to db " + OPT.db : ""}...`);
  await mongoose.connect(OPT.uri, { ...(OPT.db ? { dbName: OPT.db } : {}), readPreference: "secondaryPreferred", serverSelectionTimeoutMS: 15000 });
  const db = mongoose.connection.db;
  log(`database: ${db.databaseName}`);
  const t0 = Date.now();
  const data = await loadData(db, { since });
  const prices = await loadPrices();
  const exclude = String(process.env.ZQ_INTEL_EXCLUDE_PHONES || "").split(",").map(s => s.trim()).filter(Boolean);
  log("analysing...");
  const S = analyze(data, { prices, excludePhones: exclude });
  const run = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const outDir = path.join(OPT.out, run);
  fs.mkdirSync(outDir, { recursive: true });
  S.run = run;
  const aiText = OPT.ai ? await runAi(S, outDir) : null;
  writeOutputs(S, outDir, aiText);
  fs.writeFileSync(path.join(OPT.out, "LATEST"), run);
  if (OPT.pdf) {
    log("  building PDFs...");
    try {
      const { made, errors } = await buildPdfs(outDir);
      if (made.length) log(`  PDFs: ${made.join(", ")}`);
      for (const e of errors) console.error(`[zq-intel] PDF problem - ${e}`);
    }
    catch (e) { log(`  PDF step failed (report files are fine): ${e.message}`); }
  }
  log(`done in ${((Date.now() - t0) / 1000).toFixed(1)}s → ${outDir}`);
  log(`MRR ${money(S.kpi.mrr)} · paying sellers ${S.kpi.suppliersPaying}/${S.kpi.suppliers} · hot unpaid ${S.suppliers.segCounts.hot_unpaid || 0} · realistic new MRR ${money(S.money.potential.realistic)}`);
  await mongoose.disconnect();
}

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) {
  main().catch(async (e) => { console.error("[zq-intel] failed:", e); try { await mongoose.disconnect(); } catch {} process.exit(1); });
}