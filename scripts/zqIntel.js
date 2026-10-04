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
//   node scripts/zqIntel.js --ai                 # + Claude strategy memo (uses ANTHROPIC_API_KEY)
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
  since:  arg("since", null),
  uri:    arg("uri", null) || process.env.MONGODB_URI,
  db:     arg("db", null),
  out:    arg("out", null) || path.join(ROOT, "reports", "zq-intel"),
  quiet:  !!arg("quiet", false)
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
    const k = (s.resultMode === "none" || s.resultMode === "error" || (s.resultCount === 0 && s.resultMode !== "unknown")) ? "none" : "found";
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
    if (s.resultMode === "none" || (s.resultCount === 0 && ["offers", "suppliers", "schools", "none"].includes(s.resultMode))) {
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
  const appear = {};            // supplierId → { all, d30, people:Set, people30:Set }
  for (const s of buyerSearches) {
    const d = toDate(s.createdAt), ph = normPhone(s.phone);
    for (const r of s.resultsPreview || []) {
      const id = idStr(r.supplierId); if (!id) continue;
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
    }
    for (const resp of r.responses || []) inc(reqResponded, idStr(resp.supplierId));
  }
  const ordersBy = {};
  for (const o of data.orders || []) {
    const k = idStr(o.supplierId); const x = ordersBy[k] = ordersBy[k] || { all: 0, d30: 0, value: 0 };
    x.all++; if (toDate(o.createdAt) >= D30) x.d30++; x.value += Number(o.totalAmount) || 0;
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
    const hadNone = lastS ? (lastS.resultMode === "none" || lastS.resultCount === 0) : false;
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
      zeroResultPct: pct(realSearches.filter(s => s.resultMode === "none").length, realSearches.length),
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
  // Aggregates + business names only. No phone numbers.
  const strip = (r) => ({ name: r.businessName, city: r.city, type: r.profileType, cats: r.categories, segment: r.segment,
    searchersReached30: r.searchersReached30, linkVisitors30: r.linkVisitors30, requests30: r.requestsNotified30,
    orders: r.orders, market30: r.market30, priceCount: r.priceCount, completeness: r.completeness, daysToEnd: r.daysToEnd });
  return {
    context: "ZimQuote: WhatsApp-first marketplace for Zimbabwe's informal/SME economy. Buyers search via the WhatsApp bot; " +
      "sellers (suppliers, service providers, tutors, lodges) and schools list for a monthly fee (prices in 'prices'). " +
      "Most sellers were onboarded by the founder on free admin trials and have not paid. Facebook ads used to drive most traffic " +
      "but there is no ad budget now; free SEO pages and web tools (calculators, quote generators) link into the bot with ZQ:GROUP codes. " +
      "Payments are EcoCash via Paynow. WhatsApp Cloud API: outbound outside the 24h window requires approved templates (cost per message).",
    window: S.window, prices: S.prices, kpi: S.kpi,
    acquisition: { channelTotals: S.acquisition.channelTotals, channelReturn: S.acquisition.channelReturn,
      newByMonth: S.acquisition.newByMonth, seoPages: topN(S.acquisition.seoPages, 15), linkSources: topN(S.acquisition.linkSources, 15) },
    retention: { activeDayHist: S.retention.activeDayHist, firstResult: S.retention.firstResult, cohorts: S.retention.cohortRows.slice(-16) },
    demand: { topTerms: S.demand.topTerms.slice(0, 40), byCity: S.demand.byCity.slice(0, 12), byMode: S.demand.byMode,
      zeroTop: S.demand.zeroTop.slice(0, 30).map(z => ({ term: z.term, city: z.city, people: z.people, count: z.count })),
      gaps: S.demand.gapRows.slice(0, 25), heatByHour: S.demand.heat[0].map((_, h) => S.demand.heat.reduce((t, row) => t + row[h], 0)) },
    suppliers: { segCounts: S.suppliers.segCounts, status: S.suppliers.supplierStatus,
      topTargets: S.suppliers.conversionTargets.slice(0, 30).map(strip), expiringSoon: S.suppliers.expiringSoon.length },
    schools: S.schools.rows.slice(0, 15).map(r => ({ name: r.schoolName, city: r.city, segment: r.segment, contacts30: r.contacts30, applications: r.applications, leadActions: r.leadActions })),
    lapsedBuyers: { count: S.lapsed.length, withUnmetSearchNowAvailable: S.lapsed.filter(l => l.lastHadNoResults && l.suppliersNowAvailable).length },
    money: { mrr: S.money.mrr, paymentsByMonth: S.money.paymentsByMonth, potential: S.money.potential },
    dataQuality: S.dataQuality
  };
}

async function runAi(S, outDir) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) { log("  --ai requested but ANTHROPIC_API_KEY is not set - skipping"); return null; }
  const model = process.env.ZQ_INTEL_MODEL || "claude-sonnet-5-5";
  const payload = aiPayload(S);
  fs.writeFileSync(path.join(outDir, "ai_payload.json"), JSON.stringify(payload, null, 2));
  const system = "You are a pragmatic growth and monetisation analyst for a bootstrapped Zimbabwean marketplace startup with no ad budget. " +
    "Work only from the data supplied; when a number is missing say so rather than guessing. Be specific: name sellers, cities, search terms and dollar amounts from the data. " +
    "Prefer actions one founder can execute this week with WhatsApp, EcoCash, free SEO pages and the existing chatbot.";
  const prompt = `Here is the full business-intelligence summary as JSON:\n\n${JSON.stringify(payload)}\n\n` +
    "Write a strategy memo in Markdown with these sections:\n" +
    "1. What the data says (the 5 most important findings, each with the numbers behind it)\n" +
    "2. Cash this month: which unpaid sellers to convert first and exactly what to say to them, plus a pricing/offer recommendation (e.g. pay-per-lead, annual discount, founding-member price) justified by the data\n" +
    "3. Retention: why buyers don't come back and 3-5 concrete bot or content changes to fix it, tied to the zero-result and cohort data\n" +
    "4. Free acquisition without Facebook ads: which SEO pages/tools/smart-link channels are working, which to build next (specific page titles + target terms from the demand data)\n" +
    "5. Supply gaps: which seller categories/cities to recruit first and how\n" +
    "6. A 30-day plan as a week-by-week checklist with a revenue target for each week\n" +
    "7. Metrics to watch weekly and data-quality fixes needed\n" +
    "Keep it under 1,800 words.";
  log(`  asking ${model} for a strategy memo...`);
  let res, body = {};
  for (let attempt = 1; attempt <= 5; attempt++) {
    res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model, max_tokens: 6000, system, messages: [{ role: "user", content: prompt }] })
    });
    body = await res.json().catch(() => ({}));
    if (![429, 500, 529].includes(res.status)) break;
    const wait = Math.min(attempt * 20000, 90000);
    log(`  Claude busy (${res.status}), retry ${attempt}/5 in ${wait / 1000}s...`);
    await new Promise(r => setTimeout(r, wait));
  }
  if (!res.ok) { log(`  AI call failed (${res.status}): ${body?.error?.message || "unknown error"}`); return null; }
  const text = (body.content || []).filter(b => b.type === "text").map(b => b.text).join("\n").trim();
  fs.writeFileSync(path.join(outDir, "ai_strategy.md"), text, "utf8");
  log(`  AI memo saved (${body.usage?.input_tokens || "?"} in / ${body.usage?.output_tokens || "?"} out tokens)`);
  return text;
}

// ═════════════════════════════════════════════════════════════════════════════
// HTML report
// ═════════════════════════════════════════════════════════════════════════════
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtDate = (d) => d ? new Date(d).toISOString().slice(0, 10) : "";
const money = (n) => `$${Math.round(n || 0).toLocaleString("en-US")}`;
const maskPhone = (p) => p ? `0${p.slice(3, 5)}…${p.slice(-3)}` : "";

function mdToHtml(md) {
  const lines = String(md || "").split(/\r?\n/); let html = "", inList = false;
  const inline = (t) => esc(t).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>").replace(/`([^`]+)`/g, "<code>$1</code>");
  for (const ln of lines) {
    const h = ln.match(/^(#{1,4})\s+(.*)/); const li = ln.match(/^\s*(?:[-*]|\d+\.)\s+(.*)/);
    if (!li && inList) { html += "</ul>"; inList = false; }
    if (h) html += `<h${Math.min(h[1].length + 2, 5)}>${inline(h[2])}</h${Math.min(h[1].length + 2, 5)}>`;
    else if (li) { if (!inList) { html += "<ul>"; inList = true; } html += `<li>${inline(li[1])}</li>`; }
    else if (ln.trim()) html += `<p>${inline(ln)}</p>`;
  }
  if (inList) html += "</ul>";
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

export function renderHtml(S, aiText = null) {
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
.kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:0;border:1px solid var(--line);margin:18px 0}
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
.pitch{display:block;font-size:12px;color:var(--muted);min-width:300px;max-width:52ch}.empty,.more{color:var(--muted);font-size:13px}
.ai{border-left:4px solid var(--gold);padding:4px 0 4px 18px}
nav{display:flex;flex-wrap:wrap;gap:4px 14px;font-size:14px;margin:8px 0 0}nav a{color:var(--green)}
a:focus-visible{outline:2px solid var(--gold);outline-offset:2px}
@media (max-width:640px){.kpis{grid-template-columns:repeat(2,1fr)}h1{font-size:26px}.ladder li{grid-template-columns:30px 1fr}.ladder .cash{grid-column:2}}`;

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
<h3>Conversion targets (unpaid, ranked by proof of value)</h3>
${table(S.suppliers.conversionTargets, [
    { label: "Business", key: "businessName" }, { label: "City", key: "city" }, { label: "Segment", get: r => segTag(r.segment), html: true },
    { label: "Seen by (30d)", key: "searchersReached30", num: true }, { label: "Link visitors (30d)", key: "linkVisitors30", num: true },
    { label: "Requests (30d)", key: "requestsNotified30", num: true }, { label: "Orders", key: "orders", num: true },
    { label: "Market (30d)", key: "market30", num: true }, { label: "Prices", key: "priceCount", num: true },
    { label: "Trial ends", get: r => r.daysToEnd === null ? "" : r.daysToEnd < 0 ? `${-r.daysToEnd}d ago` : `in ${r.daysToEnd}d` },
    { label: "Message to send", get: r => `<span class="pitch">${esc(r.pitch)}</span>`, html: true }
  ], { limit: 40 })}
<h3>Trials ending in the next 14 days</h3>
${table(S.suppliers.expiringSoon, [{ label: "Business", key: "businessName" }, { label: "City", key: "city" }, { label: "Days left", key: "daysToEnd", num: true },
    { label: "Leads (30d)", key: "leads30", num: true }, { label: "Segment", get: r => segTag(r.segment), html: true }], { limit: 30 })}

<h2 id="schools">Schools</h2>
${table(S.schools.rows, [{ label: "School", key: "schoolName" }, { label: "City", key: "city" }, { label: "Segment", get: r => segTag(r.segment), html: true },
    { label: "Link opens", key: "linkOpens", num: true }, { label: "Parent contacts", key: "contacts", num: true }, { label: "Contacts (30d)", key: "contacts30", num: true },
    { label: "Applications", key: "applications", num: true }, { label: "Lead actions", key: "leadActions", num: true }, { label: "Not followed up", key: "uncontactedLeads", num: true },
    { label: "Paid", get: r => money(r.paidTotal), num: true }], { limit: 30 })}

<h2 id="demand">What people search for</h2>
<div class="cols"><div><h3>Top search terms</h3>${bars(S.demand.topTerms.slice(0, 25).map(([t, n]) => [t, n]), { max: 25 })}</div>
<div><h3>Cities</h3>${bars(S.demand.byCity, { max: 15 })}<h3>Result outcome</h3>${bars(S.demand.byMode)}</div></div>
<h3>Searches per week</h3>${bars(Object.entries(S.demand.searchesByWeek).sort(), { max: 30 })}
<h3>When people search (Harare time)</h3><p class="sub">Send broadcasts just before the darkest cells.</p>${heatmap(S.demand.heat)}
<h3>Searches with no results (unmet demand)</h3>
${table(S.demand.zeroTop, [{ label: "Searched for", key: "term" }, { label: "City", key: "city" }, { label: "People", key: "people", num: true },
    { label: "Times", key: "count", num: true }, { label: "Last", get: r => fmtDate(r.last) }], { limit: 30 })}

<h2 id="gaps">Supply gaps: demand per active seller (last 90 days)</h2>
${table(S.demand.gapRows, [{ label: "Keyword", key: "keyword" }, { label: "City", key: "city" }, { label: "Searches", key: "searches90", num: true },
    { label: "Active sellers", key: "activeSuppliers", num: true }, { label: "Searches per seller", key: "ratio", num: true }], { limit: 30 })}

<h2 id="retention">Do people come back?</h2>
<div class="cols"><div><h3>Days active per person</h3>${bars(S.retention.activeDayHist)}</div>
<div><h3>First search outcome vs coming back</h3>
<p>First search found something: <strong>${fr.found.returnPct}%</strong> came back (${fr.found.people} people).<br>
First search found nothing: <strong>${fr.none.returnPct}%</strong> came back (${fr.none.people} people).</p>
<h3>Searches per searcher</h3>${bars(S.demand.searchesPerSearcher)}</div></div>
<h3>Weekly cohorts: % active again after N weeks</h3>
${table(S.retention.cohortRows.slice(-20).reverse(), [{ label: "First week", key: "week" }, { label: "People", key: "size", num: true },
    ...[1, 2, 4, 8, 12].map(o => ({ label: `+${o}w`, get: r => r[`w${o}`] === null ? "" : r[`w${o}`] + "%", num: true }))], { limit: 20 })}

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
${table(S.lapsed, [{ label: "Phone", get: r => maskPhone(r.phone) }, { label: "Last wanted", key: "lastTerm" }, { label: "City", key: "city" },
    { label: "Days away", key: "daysSince", num: true }, { label: "Active days", key: "activeDays", num: true },
    { label: "Failed then, sellers now", get: r => r.lastHadNoResults && r.suppliersNowAvailable ? `yes (${r.suppliersNowAvailable})` : "" }], { limit: 25 })}

<h2 id="dq">Data quality</h2>
${table(Object.entries(S.dataQuality).map(([k2, v]) => ({ k2, v })), [{ label: "Check", key: "k2" }, { label: "Value", key: "v", num: true }])}
<p class="sub">Collections read: ${esc(Object.entries(S.collections).map(([a, b]) => `${a}=${b || "missing"}`).join(", "))}</p>

${aiText ? `<h2 id="ai">Claude's strategy memo</h2><div class="ai">${mdToHtml(aiText)}</div>` : ""}
</main></body></html>`;
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

  const slim = { ...S, suppliers: { ...S.suppliers, rows: undefined, conversionTargets: S.suppliers.conversionTargets.length,
    expiringSoon: S.suppliers.expiringSoon.length }, schools: { count: S.schools.rows.length }, lapsed: S.lapsed.length };
  fs.writeFileSync(path.join(outDir, "summary.json"), JSON.stringify(slim, null, 2));
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
  const aiText = OPT.ai ? await runAi(S, outDir) : null;
  writeOutputs(S, outDir, aiText);
  fs.writeFileSync(path.join(OPT.out, "LATEST"), run);
  log(`done in ${((Date.now() - t0) / 1000).toFixed(1)}s → ${outDir}`);
  log(`MRR ${money(S.kpi.mrr)} · paying sellers ${S.kpi.suppliersPaying}/${S.kpi.suppliers} · hot unpaid ${S.suppliers.segCounts.hot_unpaid || 0} · realistic new MRR ${money(S.money.potential.realistic)}`);
  await mongoose.disconnect();
}

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) {
  main().catch(async (e) => { console.error("[zq-intel] failed:", e); try { await mongoose.disconnect(); } catch {} process.exit(1); });
}
