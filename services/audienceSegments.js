// services/audienceSegments.js
// ─── Interest groups for broadcasting ────────────────────────────────────────
//
// Groups every WhatsApp contact by WHAT THEY SHOWED INTEREST IN, so a broadcast
// goes only to the people it is relevant to:
//
//   🔧 Trades · 🧱 Building · ⚡ Electrical & solar · 🛒 Groceries & food ·
//   🚗 Cars & spares · 🏠 Home & tech · 💼 Professional · 🎉 Events & beauty ·
//   🚚 Transport · 🌱 Farming · 🦁 Tourism            (= the SECTIONS on /zq-admin/categories)
//   🎓 Schools & tutors                                 (school searches + school/tutor link opens)
//   🔗 Opened a seller smart link · 📝 Asked for a quote · 🛒 Ordered groceries
//   ❓ Searched but not classified yet
//
// Where the signals come from (read-only - nothing in those collections changes):
//   SearchCommandLog     every typed search      → classified to a section
//   SupplierLinkVisitor  seller smart-link opens → seller's categories → section(s)
//   SchoolContact        school link opens / applications / enquiries → schools
//   QuoteRequest         quote desk requests     → text classified + "asked for a quote"
//   BuyerRequest         old request-sellers     → items classified + "asked for a quote"
//   GroceryOrder         grocery orders          → groceries + "ordered groceries"
//
// How a search text is classified (first hit wins):
//   1. admin override / earlier Claude answer   (SearchTextClass collection)
//   2. school words / school flow               → schools
//   3. the search brain's rules + admin keywords (services/searchBrain.js ruleIntent)
//   4. category & section buyer keywords        (services/categoryRegistry.js)
//   5. otherwise "unclassified" - the admin can let Claude classify those in
//      batches (ANTHROPIC_API_KEY, same key as the search) or set them by hand.
//
// The result is stored per phone in AudienceMember (rebuilt every 6 hours and
// on demand), so counts and audiences load instantly. People who reply
// UNSUBSCRIBE are kept with optOut:true and never included in a broadcast.
// ─────────────────────────────────────────────────────────────────────────────

import mongoose from "mongoose";

// ── Models ───────────────────────────────────────────────────────────────────
const memberSchema = new mongoose.Schema({
  phone:     { type: String, unique: true, index: true },
  segs:      [{ s: String, n: Number, last: Date, _id: false }],
  searches:  { type: Number, default: 0 },
  linkOpens: { type: Number, default: 0 },
  firstSeen: Date,
  lastSeen:  { type: Date, index: true },
  city:      { type: String, default: "" },
  terms:     { type: [String], default: [] },          // last few things they searched
  isSeller:  { type: Boolean, default: false },
  optOut:    { type: Boolean, default: false, index: true },
  optOutAt:  Date,
  buildId:   String
}, { timestamps: true });
memberSchema.index({ "segs.s": 1, "segs.last": -1 });
export const AudienceMember = mongoose.models.AudienceMember || mongoose.model("AudienceMember", memberSchema);

const classSchema = new mongoose.Schema({
  key:     { type: String, unique: true },     // normalised search text
  section: String,                              // section id | "schools" | "none"
  by:      { type: String, default: "ai" },     // ai | admin
  n:       { type: Number, default: 0 }
}, { timestamps: true });
export const SearchTextClass = mongoose.models.SearchTextClass || mongoose.model("SearchTextClass", classSchema);

const metaSchema = new mongoose.Schema({
  _id: String, lastBuiltAt: Date, buildMs: Number, building: Boolean, buildStartedAt: Date,
  stats: mongoose.Schema.Types.Mixed, unclassified: mongoose.Schema.Types.Mixed, lastAi: mongoose.Schema.Types.Mixed
}, { timestamps: true });
export const AudienceMeta = mongoose.models.AudienceMeta || mongoose.model("AudienceMeta", metaSchema);

// ── Helpers ──────────────────────────────────────────────────────────────────
const _phone = (p) => {
  let d = String(p || "").replace(/\D+/g, "");
  if (d.startsWith("0") && d.length === 10) d = "263" + d.slice(1);
  return d.length >= 10 && d.length <= 15 ? d : null;
};
const _rx = (s) => String(s || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const _bare = (l) => String(l || "").replace(/^[^\p{L}\p{N}]+/u, "").trim();

export function normText(t) {
  return String(t || "").toLowerCase()
    .replace(/^\s*(find|search|looking for|i need|i want|need|want|where can i (get|buy|find))\s+(an?\s+)?/i, "")
    .replace(/[^\p{L}\p{N}\s&'-]/gu, " ").replace(/\s+/g, " ").trim().slice(0, 80);
}
// Not searches: greetings, numbers, menu words, ids, phones, prices, links
const JUNK = /^(hi+|hie|hey|hello|helo|good (morning|afternoon|evening)|menu|main menu|start|home|back|yes|no|ok|okay|thanks?|thank you|more|list|results|cancel|stop|exit|pay|cart|done|help|join|me|test|\d+([.,]\d+)?)$/i;
function _isSearchy(raw, key) {
  if (!key || key.length < 3 || key.length > 80) return false;
  if (JUNK.test(key)) return false;
  if (/^[a-z]+(_[a-z0-9]+)+$/i.test(String(raw).trim())) return false;      // button ids
  if (/(\+?263|\b0)7\d{8}/.test(String(raw).replace(/\s/g, ""))) return false; // phone numbers
  if (/@|https?:\/\//i.test(raw)) return false;
  if (!/\p{L}{3,}/u.test(key)) return false;
  return true;
}

const SCHOOL_RE = /\b(schools?|college|colleges|tutors?|tuition|lessons|ecd|creche|preschool|pre-school|nursery school|kindergarten|academy|boarding|o level|a level|zimsec|cambridge|university|driving school|primary school|high school|secondary school|teacher|extra lessons)\b/i;
const FOOD_RE = /\b(groceries|grocery|hampers?|mealie ?meal|upfu|cooking oil|mafuta|sugar|rice|flour|bread|eggs|mazai|chicken|huku|beef|meat|nyama|kapenta|matemba|vegetables|tomatoes|onions|potatoes|supermarket|butchery|catering|cakes?)\b/i;

// ── Segments ─────────────────────────────────────────────────────────────────
export const EXTRA_SEGMENTS = [
  { id: "schools",           label: "🎓 Schools & tutors",            kind: "interest" },
  { id: "link_openers",      label: "🔗 Opened a seller smart link",  kind: "behaviour" },
  { id: "quote_requesters",  label: "📝 Asked for a quote",           kind: "behaviour" },
  { id: "grocery_buyers",    label: "🛒 Ordered groceries",           kind: "behaviour" },
  { id: "unclassified",      label: "❓ Searched - not classified yet", kind: "behaviour" }
];
let _reg = null;
async function _registry() {
  if (_reg && Date.now() - _reg.at < 60000) return _reg;
  let sections = [], cats = [];
  try {
    const r = await import("./categoryRegistry.js");
    [sections, cats] = await Promise.all([r.getAllSections(), r.getAllCategories()]);
  } catch (e) { console.warn("[AUDIENCE] registry", e.message); }
  const secOfCat = new Map(cats.map(c => [c.id, c.section]));
  // keyword → section (longest first, word-boundary)
  const kw = [];
  for (const c of cats) if (c.active !== false) for (const k of [...(c.keywords || []), _bare(c.label)]) {
    const w = String(k || "").toLowerCase().trim(); if (w.length >= 3) kw.push([w, c.section]);
  }
  for (const s of sections) if (s.active !== false && s.id !== "other") for (const k of (s.keywords || [])) {
    const w = String(k || "").toLowerCase().trim(); if (w.length >= 3) kw.push([w, s.id]);
  }
  kw.sort((a, b) => b[0].length - a[0].length);
  const kwRx = kw.map(([w, s]) => [new RegExp(`(^|[^\\p{L}])${_rx(w)}`, "iu"), s]);
  _reg = { at: Date.now(), sections, cats, secOfCat, kwRx };
  return _reg;
}

export async function getSegments() {
  const { sections } = await _registry();
  const secs = sections.filter(s => s.active !== false && s.id !== "other")
    .map(s => ({ id: s.id, label: s.label, kind: "interest" }));
  return [...secs, ...EXTRA_SEGMENTS];
}

let _ruleIntent = null;
async function _brain() {
  if (_ruleIntent !== null) return _ruleIntent;
  try { _ruleIntent = (await import("./searchBrain.js")).ruleIntent || false; } catch (_) { _ruleIntent = false; }
  return _ruleIntent;
}

/** Rule-based section for a search text (no AI). null = unknown. */
export async function classifyRule(text, { flow = "", parsedCategory = "" } = {}) {
  const reg = await _registry();
  const t = String(text || "");
  if (flow === "school_search" || SCHOOL_RE.test(t)) return "schools";
  if (parsedCategory && reg.secOfCat.get(parsedCategory)) return reg.secOfCat.get(parsedCategory);
  const ri = await _brain();
  if (ri) {
    try {
      const it = ri(t);
      if (it?.section) return it.section;
      const c = (it?.categories || []).map(id => reg.secOfCat.get(id)).find(Boolean);
      if (c) return c;
    } catch (_) {}
  }
  for (const [rx, sec] of reg.kwRx) if (rx.test(t)) return sec;
  if (FOOD_RE.test(t)) return reg.sections.some(s => s.id === "food") ? "food" : null;
  return null;
}

// ═════════════════════════════════════════════════════════════════════════════
// BUILD
// ═════════════════════════════════════════════════════════════════════════════
let _building = false;
export function isBuilding() { return _building; }

async function _model(path) { try { return (await import(path)).default; } catch (_) { return null; } }

/**
 * Rebuild every AudienceMember from the raw logs. Safe to run any time
 * (one at a time); opt-outs are preserved. Returns stats.
 */
export async function rebuildAudiences({ reason = "manual" } = {}) {
  if (_building) return { busy: true };
  _building = true;
  const t0 = Date.now();
  const buildId = `${t0.toString(36)}`;
  try {
    await AudienceMeta.updateOne({ _id: "main" }, { $set: { building: true, buildStartedAt: new Date() } }, { upsert: true });
    const reg = await _registry();
    const overrides = new Map((await SearchTextClass.find({}, { key: 1, section: 1 }).lean()).map(d => [d.key, d.section]));
    const ruleCache = new Map();
    const classify = async (raw, opts = {}) => {
      const key = normText(raw);
      if (!_isSearchy(raw, key)) return { key: null, sec: null };
      if (overrides.has(key)) { const s = overrides.get(key); return { key, sec: s === "none" ? "__none" : s }; }
      const ck = `${key}|${opts.flow || ""}|${opts.parsedCategory || ""}`;
      if (!ruleCache.has(ck)) ruleCache.set(ck, await classifyRule(raw, opts));
      return { key, sec: ruleCache.get(ck) };
    };

    const M = new Map();
    const mem = (p) => {
      let m = M.get(p);
      if (!m) { m = { segs: new Map(), searches: 0, linkOpens: 0, firstSeen: null, lastSeen: null, city: "", terms: [] }; M.set(p, m); }
      return m;
    };
    const touch = (m, at) => {
      const d = at ? new Date(at) : new Date();
      if (!m.firstSeen || d < m.firstSeen) m.firstSeen = d;
      if (!m.lastSeen || d > m.lastSeen) m.lastSeen = d;
      return d;
    };
    const add = (m, seg, at) => {
      if (!seg) return;
      const d = at ? new Date(at) : new Date();
      const x = m.segs.get(seg) || { n: 0, last: d };
      x.n += 1; if (d > x.last) x.last = d;
      m.segs.set(seg, x);
    };
    const unclassified = new Map();      // key → { n, sample }
    let logs = 0, links = 0;

    // ── 1. Search logs ───────────────────────────────────────────────────────
    const SearchCommandLog = await _model("../models/searchCommandLog.js");
    const slugToSecs = new Map();
    const SP = await _model("../models/supplierProfile.js");
    const supplierSecs = new Map();
    if (SP) {
      for (const s of await SP.find({}, { _id: 1, phone: 1, zqSlug: 1, categories: 1, active: 1 }).lean()) {
        const secs = [...new Set((s.categories || []).map(c => reg.secOfCat.get(c)).filter(x => x && x !== "other"))];
        supplierSecs.set(String(s._id), secs);
        if (s.zqSlug) slugToSecs.set(String(s.zqSlug).toLowerCase(), secs);
      }
    }
    if (SearchCommandLog) {
      const cur = SearchCommandLog.find({ source: { $in: ["text", "smart_link", "unknown"] } },
        { phone: 1, rawText: 1, flow: 1, source: 1, sessionState: 1, parsed: 1, createdAt: 1 }).lean().cursor();
      for await (const l of cur) {
        logs++;
        const p = _phone(l.phone); if (!p) continue;
        const raw = String(l.rawText || "").trim(); if (!raw) continue;
        // Smart links arrive as text: ZQ:S:<slug>, ZQ:SCHOOL:…, ZQ:GROUP:…
        const zl = raw.match(/^zq:([a-z]+):?(.*)$/i);
        if (zl) {
          const kind = zl[1].toLowerCase(), slug = String(zl[2] || "").toLowerCase().replace(/^slug:/, "");
          const m = mem(p); const d = touch(m, l.createdAt);
          if (["school", "sgroup", "tgroup"].includes(kind)) { add(m, "schools", d); m.linkOpens++; }
          else if (["s", "group", "supplier"].includes(kind)) {
            add(m, "link_openers", d); m.linkOpens++;
            for (const s of (slugToSecs.get(slug) || [])) add(m, s, d);
          } else if (/^grocer/.test(kind)) add(m, "food", d);
          continue;
        }
        // Only real searches: skip typing inside other flows (addresses, prices…)
        const st = String(l.sessionState || "");
        if (st && !/^(ready|supplier_search|school_search|tutor_search|inst_search)/.test(st) && l.flow !== "supplier_search" && l.flow !== "school_search") continue;
        const { key, sec } = await classify(raw, { flow: l.flow, parsedCategory: l.parsed?.category || "" });
        if (!key) continue;
        const m = mem(p); const d = touch(m, l.createdAt);
        m.searches++;
        if (m.terms[m.terms.length - 1] !== key) { m.terms.push(key); if (m.terms.length > 6) m.terms.shift(); }
        if (l.parsed?.city) m.city = String(l.parsed.city).slice(0, 40);
        if (sec === "__none") continue;
        if (sec) add(m, sec, d);
        else {
          add(m, "unclassified", d);
          const u = unclassified.get(key) || { n: 0, sample: raw.slice(0, 80) }; u.n++; unclassified.set(key, u);
        }
      }
    }

    // ── 2. Seller smart-link visitors ────────────────────────────────────────
    const SLV = await _model("../models/supplierLinkVisitor.js");
    if (SLV) {
      for await (const v of SLV.find({ linkType: { $ne: "staff" } }, { phone: 1, supplierId: 1, lastSeen: 1, createdAt: 1 }).lean().cursor()) {
        const p = _phone(v.phone); if (!p) continue;
        links++;
        const m = mem(p); const d = touch(m, v.lastSeen || v.createdAt);
        m.linkOpens++; add(m, "link_openers", d);
        for (const s of (supplierSecs.get(String(v.supplierId)) || [])) add(m, s, d);
      }
    }
    // ── 3. School link opens / applications / enquiries ─────────────────────
    const SC = await _model("../models/schoolContact.js");
    if (SC) {
      for await (const c of SC.find({}, { phone: 1, lastSeen: 1, createdAt: 1 }).lean().cursor()) {
        const p = _phone(c.phone); if (!p) continue;
        const m = mem(p); const d = touch(m, c.lastSeen || c.createdAt);
        m.linkOpens++; add(m, "schools", d);
      }
    }
    // ── 4. Quote desk + old buyer requests ───────────────────────────────────
    const QR = await _model("../models/quoteRequest.js");
    if (QR) {
      for await (const q of QR.find({}, { customerPhone: 1, text: 1, city: 1, createdAt: 1 }).lean().cursor()) {
        const p = _phone(q.customerPhone); if (!p) continue;
        const m = mem(p); const d = touch(m, q.createdAt);
        add(m, "quote_requesters", d);
        if (q.city) m.city = String(q.city).slice(0, 40);
        const sec = await classifyRule(String(q.text || "").slice(0, 300));
        if (sec) add(m, sec, d);
      }
    }
    const BR = await _model("../models/buyerRequest2.js");
    if (BR) {
      for await (const r of BR.find({}, { buyerPhone: 1, items: 1, city: 1, createdAt: 1 }).lean().cursor()) {
        const p = _phone(r.buyerPhone); if (!p) continue;
        const m = mem(p); const d = touch(m, r.createdAt);
        add(m, "quote_requesters", d);
        if (r.city && !m.city) m.city = String(r.city).slice(0, 40);
        const sec = await classifyRule((r.items || []).map(i => i.product || i.service || "").join(", ").slice(0, 300));
        if (sec) add(m, sec, d);
      }
    }
    // ── 5. Grocery orders (web + WhatsApp) ───────────────────────────────────
    const GO = await _model("../models/groceryOrder.js");
    if (GO) {
      for await (const o of GO.find({}, { "customer.phone": 1, createdAt: 1 }).lean().cursor()) {
        const p = _phone(o.customer?.phone); if (!p) continue;
        const m = mem(p); const d = touch(m, o.createdAt);
        add(m, "grocery_buyers", d);
        if (reg.sections.some(s => s.id === "food")) add(m, "food", d);
      }
    }
    // ── 6. Who is a seller (so buyer promos can skip them) ───────────────────
    const sellerPhones = new Set();
    if (SP) for (const s of await SP.find({}, { phone: 1 }).lean()) { const p = _phone(s.phone); if (p) sellerPhones.add(p); }

    // ── Write ────────────────────────────────────────────────────────────────
    const ops = [];
    let written = 0;
    for (const [phone, m] of M) {
      if (!m.segs.size && !m.searches && !m.linkOpens) continue;
      ops.push({ updateOne: { filter: { phone }, upsert: true, update: { $set: {
        segs: [...m.segs].map(([s, x]) => ({ s, n: x.n, last: x.last })),
        searches: m.searches, linkOpens: m.linkOpens, firstSeen: m.firstSeen, lastSeen: m.lastSeen,
        city: m.city, terms: m.terms, isSeller: sellerPhones.has(phone), buildId
      } } } });
      if (ops.length >= 500) { await AudienceMember.bulkWrite(ops.splice(0), { ordered: false }); }
      written++;
    }
    if (ops.length) await AudienceMember.bulkWrite(ops, { ordered: false });
    // Drop people no longer in any source - but never forget an opt-out
    await AudienceMember.deleteMany({ buildId: { $ne: buildId }, optOut: { $ne: true } });

    const top = [...unclassified].sort((a, b) => b[1].n - a[1].n).slice(0, 400).map(([key, u]) => ({ key, n: u.n, sample: u.sample }));
    const stats = { members: written, logs, links, unclassifiedTerms: unclassified.size, reason };
    await AudienceMeta.updateOne({ _id: "main" }, { $set: {
      building: false, lastBuiltAt: new Date(), buildMs: Date.now() - t0, stats, unclassified: top
    } }, { upsert: true });
    console.log(`[AUDIENCE] rebuilt ${written} members from ${logs} logs + ${links} link opens in ${Date.now() - t0} ms (${reason})`);
    return stats;
  } catch (e) {
    console.error("[AUDIENCE] rebuild failed", e);
    await AudienceMeta.updateOne({ _id: "main" }, { $set: { building: false } }, { upsert: true }).catch(() => {});
    throw e;
  } finally { _building = false; }
}

// Auto-rebuild: 3 min after boot, then every 6 h (process-local, unref'd)
let _timer = null;
export function startAudienceAutoBuild() {
  if (_timer || process.env.ZQ_AUDIENCE_AUTOBUILD === "off") return;
  const run = () => rebuildAudiences({ reason: "auto" }).catch(() => {});
  const t1 = setTimeout(run, 3 * 60 * 1000); t1.unref?.();
  _timer = setInterval(run, 6 * 60 * 60 * 1000); _timer.unref?.();
}

// ═════════════════════════════════════════════════════════════════════════════
// CLAUDE: classify the searches the rules could not place
// ═════════════════════════════════════════════════════════════════════════════
export function aiReady() { return !!process.env.ANTHROPIC_API_KEY; }

async function _askClaude(texts, segOptions) {
  const list = texts.map((t, i) => `${i + 1}. ${t}`).join("\n");
  const opts = segOptions.map(s => `${s.id} = ${_bare(s.label)}${s.hint ? ` (${s.hint})` : ""}`).join("\n");
  const system =
`You sort WhatsApp marketplace searches from Zimbabwe into interest groups. Searches can be in English, Shona or Ndebele, with typos, brand names and place names (Harare, Bulawayo, Mbare, Borrowdale…). Ignore the place - classify WHAT the person wants.
Groups:
${opts}
none = greetings, names, addresses, payments, gibberish or not a product/service need.
Reply with ONLY a JSON object mapping each number to one group id, e.g. {"1":"trades","2":"none"}.`;
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: process.env.ZQ_AI_MODEL || "claude-haiku-5-5",
      max_tokens: 2000, system,
      messages: [{ role: "user", content: list }]
    })
  });
  if (!res.ok) throw new Error(`Claude ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = await res.json();
  const txt = (j.content || []).map(c => c.text || "").join("");
  const m = txt.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("Claude reply had no JSON");
  return JSON.parse(m[0]);
}

/**
 * Classify the most-searched unclassified texts with Claude and remember the
 * answers (SearchTextClass, by:"ai"). Then rebuild. Returns a summary.
 */
export async function classifyWithClaude({ max = 300, batch = 60 } = {}) {
  if (!aiReady()) throw new Error("Add ANTHROPIC_API_KEY to .env to use Claude.");
  const meta = await AudienceMeta.findById("main").lean();
  const pending = (meta?.unclassified || []).slice(0, max);
  if (!pending.length) return { asked: 0, classified: 0, none: 0 };
  const reg = await _registry();
  const segOptions = [
    ...reg.sections.filter(s => s.active !== false && s.id !== "other").map(s => {
      const inSec = reg.cats.filter(c => c.section === s.id && c.active !== false).slice(0, 6).map(c => _bare(c.label).toLowerCase());
      return { id: s.id, label: s.label, hint: inSec.join(", ") };
    }),
    { id: "schools", label: "Schools, colleges, tutors, lessons" }
  ];
  const valid = new Set([...segOptions.map(s => s.id), "none"]);
  let classified = 0, none = 0, errors = 0;
  for (let i = 0; i < pending.length; i += batch) {
    const chunk = pending.slice(i, i + batch);
    try {
      const ans = await _askClaude(chunk.map(c => c.sample || c.key), segOptions);
      const ops = [];
      chunk.forEach((c, k) => {
        const sec = String(ans[String(k + 1)] || "").trim().toLowerCase();
        if (!valid.has(sec)) return;
        if (sec === "none") none++; else classified++;
        ops.push({ updateOne: { filter: { key: c.key, by: { $ne: "admin" } }, upsert: true, update: { $set: { key: c.key, section: sec, by: "ai", n: c.n } } } });
      });
      if (ops.length) await SearchTextClass.bulkWrite(ops, { ordered: false }).catch(e => { if (e.code !== 11000) throw e; });
    } catch (e) { errors++; console.warn("[AUDIENCE AI]", e.message); }
  }
  const summary = { asked: pending.length, classified, none, errors, at: new Date() };
  await AudienceMeta.updateOne({ _id: "main" }, { $set: { lastAi: summary } }, { upsert: true });
  await rebuildAudiences({ reason: "after Claude" });
  return summary;
}

/** Admin sets/clears a text's group by hand ("none" = ignore, "" = forget). */
export async function setTextClass(key, section) {
  const k = normText(key);
  if (!k) return;
  if (!section) await SearchTextClass.deleteOne({ key: k });
  else await SearchTextClass.updateOne({ key: k }, { $set: { key: k, section, by: "admin" } }, { upsert: true });
}

// ═════════════════════════════════════════════════════════════════════════════
// QUERY: who is in the audience?
// ═════════════════════════════════════════════════════════════════════════════
export function segmentQuery({ segments = [], days = 0, minHits = 1, city = "", excludeSellers = true, match = "any" } = {}) {
  const segs = (Array.isArray(segments) ? segments : String(segments || "").split(","))
    .map(s => String(s).trim()).filter(Boolean);
  const since = Number(days) > 0 ? new Date(Date.now() - Number(days) * 86400000) : null;
  const n = Math.max(1, parseInt(minHits, 10) || 1);
  const q = { optOut: { $ne: true } };
  if (excludeSellers) q.isSeller = { $ne: true };
  if (city) q.city = { $regex: `^\\s*${_rx(city)}`, $options: "i" };
  const conds = segs.map(s => ({ segs: { $elemMatch: { s, n: { $gte: n }, ...(since ? { last: { $gte: since } } : {}) } } }));
  if (conds.length === 1) Object.assign(q, conds[0]);
  else if (conds.length) q[match === "all" ? "$and" : "$or"] = conds;
  else if (since) q.lastSeen = { $gte: since };
  return { q, segs };
}

export async function countSegment(opts) {
  const { q } = segmentQuery(opts);
  return AudienceMember.countDocuments(q);
}

/** Phones + a readable label, for /broadcast and the batch sender. */
export async function resolveSegmentPhones(opts = {}) {
  const { q, segs } = segmentQuery(opts);
  const rows = await AudienceMember.find(q, { phone: 1 }).lean();
  const all = await getSegments();
  const names = segs.map(s => _bare(all.find(x => x.id === s)?.label || s));
  const label = `🎯 ${names.join(opts.match === "all" ? " AND " : " + ") || "everyone"}` +
    `${Number(opts.days) > 0 ? ` · last ${opts.days}d` : ""}${opts.city ? ` · ${opts.city}` : ""}` +
    `${Number(opts.minHits) > 1 ? ` · ${opts.minHits}+ times` : ""}${opts.excludeSellers ? " · buyers only" : ""}`;
  return { phones: rows.map(r => r.phone), label };
}

/** Remove opted-out phones from any list (used by every broadcast mode). */
export async function dropOptOuts(phones = []) {
  if (!phones.length) return { phones, removed: 0 };
  const out = new Set((await AudienceMember.find({ phone: { $in: phones }, optOut: true }, { phone: 1 }).lean()).map(r => r.phone));
  return { phones: phones.filter(p => !out.has(p)), removed: out.size };
}

/** Per-segment counts for the admin pages. */
export async function segmentOverview({ days = 30 } = {}) {
  const since = new Date(Date.now() - days * 86400000);
  const rows = await AudienceMember.aggregate([
    { $match: { optOut: { $ne: true } } },
    { $unwind: "$segs" },
    { $group: {
      _id: "$segs.s", total: { $sum: 1 },
      recent: { $sum: { $cond: [{ $gte: ["$segs.last", since] }, 1, 0] } },
      buyers: { $sum: { $cond: [{ $ne: ["$isSeller", true] }, 1, 0] } }
    } }
  ]);
  const by = Object.fromEntries(rows.map(r => [r._id, r]));
  return (await getSegments()).map(s => ({ ...s, total: by[s.id]?.total || 0, recent: by[s.id]?.recent || 0, buyers: by[s.id]?.buyers || 0 }));
}

// ═════════════════════════════════════════════════════════════════════════════
// OPT-OUT (chatbot): UNSUBSCRIBE / SUBSCRIBE
// ═════════════════════════════════════════════════════════════════════════════
const OPT_OUT_RE = /^(unsubscribe|stop promos?|stop promotions?|stop broadcasts?|stop messages|stop marketing|opt ?out|no more messages)[.!]?$/i;
const OPT_IN_RE  = /^(subscribe|start promos?|opt ?in|resubscribe)[.!]?$/i;
/** Returns a reply text when the message was an opt-out/in, else null. */
export async function handleOptOutText(phone, text) {
  const t = String(text || "").trim();
  const p = _phone(phone);
  if (!p) return null;
  if (OPT_OUT_RE.test(t)) {
    await AudienceMember.updateOne({ phone: p }, { $set: { phone: p, optOut: true, optOutAt: new Date() } }, { upsert: true });
    return "✅ Done - you won't get ZimQuote promotions any more. You can still use ZimQuote any time.\n\nChanged your mind? Reply *SUBSCRIBE*.";
  }
  if (OPT_IN_RE.test(t)) {
    await AudienceMember.updateOne({ phone: p }, { $set: { phone: p, optOut: false }, $unset: { optOutAt: "" } }, { upsert: true });
    return "✅ You're subscribed to ZimQuote updates and offers again. Reply *UNSUBSCRIBE* any time to stop.";
  }
  return null;
}

export default { rebuildAudiences, classifyWithClaude, resolveSegmentPhones, countSegment, segmentOverview, getSegments, handleOptOutText, dropOptOuts };
