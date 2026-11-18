// services/bikerDispatch.js
// ═════════════════════════════════════════════════════════════════════════════
// ZimQuote BIKERS - delivery / errand dispatch over WhatsApp
// ─────────────────────────────────────────────────────────────────────────────
// CUSTOMER:  "Request a Biker" → ONE message ("Collect order, CBD to Belgravia")
//            → city auto-detected → riders alerted → prices arrive → tap Choose
//            → rider's number shared → rider updates Picked up / Delivered
//            → customer confirms + rates (+ optional note). Cancel any time with a reason.
//
// RIDER:     Own Rider Menu (Online/Offline, Open Jobs, My Jobs, Points & Earnings,
//            Areas, Rider Link, Verify, Help). Tap a job → tap a price → tap ETA.
//            Picked up → Delivered (+ quick note). Points + levels for good service.
//
// ENGINE:    chatbotEngine calls ONE function early:
//              const handled = await handleBikerMessage({ from, text, action, biz, saveBiz, imageUrl });
//              if (handled) return;
//
// RELIABILITY (many messages at once):
//  • All biker conversation state lives in UserSession.tempData (atomic $set) -
//    never on Business, so no VersionError / lost saves.
//  • A per-phone lock serialises a user's own messages (double taps, bursts).
//  • Every job transition is ONE atomic findOneAndUpdate guarded by status, so
//    two customers / two taps / two server instances can never double-book.
//  • Button taps always win over a typed-text state (a rider typing a fare can
//    still tap a different job). States expire (30-60 min) so a forgotten flow
//    never swallows tomorrow's unrelated message.
//  • A background sweep re-pings riders, expires dead requests, auto-completes
//    delivered jobs and reminds riders of stale jobs.
// ═════════════════════════════════════════════════════════════════════════════

import axios from "axios";
import mongoose from "mongoose";
import { sendText, sendButtons, sendList } from "./metaSender.js";
import { _sendTemplate } from "./buyerRequestNotifications.js";
import { SUPPLIER_CITIES } from "./supplierPlans.js";
import { detectCity, metroGroup, parseWhatWhere, splitRoute, findPlaces, KNOWN_CITIES } from "./bikerPlaces.js";
import SupplierProfile from "../models/supplierProfile.js";
import BikerJob from "../models/bikerJob.js";
import UserSession from "../models/userSession.js";
import Business from "../models/business.js";
import UserRole from "../models/userRole.js";

// ── Config ────────────────────────────────────────────────────────────────────
const GRAPH_API_VERSION = "v24.0";
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID || process.env.META_PHONE_NUMBER_ID || process.env.PHONE_NUMBER_ID;
const ACCESS_TOKEN    = process.env.META_ACCESS_TOKEN || process.env.WHATSAPP_ACCESS_TOKEN;
const BOT_NUMBER      = String(process.env.ZQ_BOT_NUMBER || process.env.WHATSAPP_BOT_NUMBER || "263771143904").replace(/\D+/g, "");
const ADMIN_PHONE     = String(process.env.ZQ_ADMIN_PHONE || process.env.ADMIN_WHATSAPP_PHONE || "").replace(/\D+/g, "");

export const BIKER_CONFIG = {
  MAX_RIDERS_PER_JOB:   10,  // riders alerted per job (first wave)
  MAX_ACTIVE_JOBS:       3,  // a rider can carry at most this many jobs at once
  MAX_OPEN_PER_CUSTOMER: 5,  // spam guard
  OPEN_JOB_WINDOW_MIN:  45,  // "Open Jobs" shows jobs younger than this
  REPING_AFTER_MIN:      8,  // no price yet → alert more riders
  PREFERRED_EXPAND_MIN:  5,  // rider-link booking: if that rider is silent, alert others
  EXPIRE_NO_OFFER_MIN:  30,  // nobody responded → close + tell customer
  EXPIRE_NOT_CHOSEN_MIN:60,  // prices came but customer never chose → close
  AUTO_COMPLETE_HOURS:  12,  // rider marked delivered, customer silent → auto-confirm
  STALE_REMIND_HOURS:    4,  // assigned job with no "delivered" → remind rider once
  MISSED_PINGS_OFFLINE: 15,  // rider ignored this many alerts in a row → auto-offline
  FAST_RESPONSE_MIN:     5,  // price sent within N min of the request = fast bonus
  OFFER_BURST_SEC:      25,  // several prices at once → one combined list, not 8 messages
  STATE_TTL_MIN:        45,  // typed-flow states expire after this
  // Jobs only go to riders who are PAID *and* ID-APPROVED by admin.
  // Set ZQ_BIKER_REQUIRE_VERIFIED=off only in an emergency (e.g. launch week).
  REQUIRE_VERIFIED: String(process.env.ZQ_BIKER_REQUIRE_VERIFIED || "on").toLowerCase() !== "off",
  CODE_MAX_TRIES:        3,  // wrong handover codes before we stop asking
  VIEW_ALERT_HOURS:      6   // same visitor opening the same rider → one alert per N hours
};

export const RIDER_POINTS = {
  complete: 10, fast: 3, autoComplete: 8,
  rate5: 5, rate4: 2, rateLow: -5,
  cancel: -10, cancelCustomerFault: -2
};

export const RIDER_LEVELS = [
  { min: 700, name: "Platinum", emoji: "💎" },
  { min: 300, name: "Gold",     emoji: "🥇" },
  { min: 100, name: "Silver",   emoji: "🥈" },
  { min: 0,   name: "Bronze",   emoji: "🥉" }
];

const ACTIVE_STATUSES = ["assigned", "picked_up"];
const LIVE_STATUSES   = ["open", "assigned", "picked_up", "delivered"];

const CUSTOMER_CANCEL_REASONS = [
  { code: "found",  title: "Found another way",      desc: "Got someone else / going myself" },
  { code: "late",   title: "Rider too slow / late",  desc: "Took too long to arrive" },
  { code: "price",  title: "Price too high",         desc: "Fare was more than I expected" },
  { code: "mind",   title: "Changed my mind",        desc: "Don't need it anymore" },
  { code: "wrong",  title: "Wrong details",          desc: "Will send a new request" },
  { code: "other",  title: "✍️ Other reason",        desc: "Type your own reason" }
];
const RIDER_CANCEL_REASONS = [
  { code: "bike",    title: "Bike breakdown",          desc: "Puncture / mechanical problem" },
  { code: "fuel",    title: "No fuel",                 desc: "Ran out of fuel" },
  { code: "unreach", title: "Customer not answering",  desc: "Called/messaged, no reply" },
  { code: "custask", title: "Customer asked to cancel",desc: "Customer told me to cancel" },
  { code: "far",     title: "Too far / wrong address", desc: "Location different from request" },
  { code: "emerg",   title: "Emergency",               desc: "Personal emergency" },
  { code: "other",   title: "✍️ Other reason",         desc: "Type your own reason" }
];
const CUSTOMER_FAULT_CODES = new Set(["unreach", "custask"]);

const FARE_CHOICES = [2, 3, 4, 5, 6, 8, 10, 15, 20];
const CITY_ROWS    = (SUPPLIER_CITIES || ["Harare", "Bulawayo"]).slice(0, 10);

// ═════════════════════════════════════════════════════════════════════════════
// SMALL HELPERS
// ═════════════════════════════════════════════════════════════════════════════
export function normPhone(raw = "") {
  let p = String(raw).replace(/\D+/g, "");
  if (p.startsWith("0") && p.length === 10) p = "263" + p.slice(1);
  if (p.length === 9 && /^7/.test(p)) p = "263" + p;
  return p;
}
function phoneVariants(raw = "") {
  const p = normPhone(raw);
  const v = new Set([p, "+" + p]);
  if (p.startsWith("263")) v.add("0" + p.slice(3));
  return [...v];
}
function displayPhone(raw = "") {
  const d = normPhone(raw);
  if (d.startsWith("263") && d.length >= 12) return `+263 ${d.slice(3, 5)} ${d.slice(5, 8)} ${d.slice(8)}`;
  return d ? `+${d}` : "-";
}
function titleCity(s = "") {
  const t = String(s || "").trim();
  if (!t) return "";
  const hit = (SUPPLIER_CITIES || []).find(c => c.toLowerCase() === t.toLowerCase());
  return hit || t.replace(/\b\w/g, ch => ch.toUpperCase());
}
function escRe(s = "") { return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function cut(s = "", n = 24) {
  const t = String(s || "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, Math.max(1, n - 1)) + "…" : t;
}
function firstName(s = "") { return String(s || "Rider").replace(/\s*\(Rider\)$/i, "").trim().split(/\s+/)[0] || "Rider"; }
function riderName(r) { return String(r?.businessName || "Rider").replace(/\s*\(Rider\)$/i, "").trim() || "Rider"; }
export function jobRef(jobOrId) {
  const id = jobOrId?._id || jobOrId;
  return jobOrId?.reference && /^RIDE-[A-Z0-9]{4,6}$/.test(jobOrId.reference)
    ? jobOrId.reference
    : `RIDE-${String(id).slice(-5).toUpperCase()}`;
}
function ago(d) {
  const m = Math.max(0, Math.round((Date.now() - new Date(d).getTime()) / 60000));
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}
export function riderLevel(points = 0) {
  const p = Number(points) || 0;
  const lvl = RIDER_LEVELS.find(l => p >= l.min) || RIDER_LEVELS[RIDER_LEVELS.length - 1];
  const idx = RIDER_LEVELS.indexOf(lvl);
  const next = idx > 0 ? RIDER_LEVELS[idx - 1] : null;
  return { ...lvl, next, toNext: next ? next.min - p : 0 };
}
function stars(n = 0) { return "⭐".repeat(Math.max(0, Math.min(5, Math.round(n)))); }
// "CBd" → "CBD", "belgravia" → "Belgravia", "mt pleasant" → "Mt Pleasant" (only fixes all-lower / odd casing)
function tidyPlace(s = "") {
  const t = String(s || "").replace(/\s+/g, " ").trim();
  if (!t) return t;
  if (/[A-Z]/.test(t) && !/^[a-z]/.test(t) && !/[A-Z][a-z]*[A-Z]/.test(t.replace(/\s/g, " "))) return t;
  return t.split(" ").map(w => (w.length <= 3 && /^[a-z]+$/i.test(w) && !/^(to|of|by|at|in|on|and|the|mt|st|dr)$/i.test(w))
    ? w.toUpperCase()
    : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(" ");
}
function plural(n, w) { return `${n} ${w}${Number(n) === 1 ? "" : "s"}`; }
function isObjId(s) { return /^[a-f0-9]{24}$/i.test(String(s || "")); }

// Parse a fare like "3", "$3.50", "usd 5", "ZiG 100", "3, 15 min"
function parseFare(input = "") {
  const s = String(input || "").trim();
  const etaM = s.match(/(\d+(?:\s*[-–]\s*\d+)?)\s*(min|mins|minutes|minute|m\b|hr|hrs|hour|hours|h\b)/i);
  let eta = "";
  if (etaM) eta = `${etaM[1].replace(/\s+/g, "")} ${/^h/i.test(etaM[2]) ? "hr" : "min"}`;
  const withoutEta = etaM ? s.replace(etaM[0], " ") : s;
  const numM = withoutEta.match(/(\d+(?:[.,]\d{1,2})?)/);
  if (!numM) return { ok: false };
  const amount = Number(numM[1].replace(",", "."));
  if (!(amount > 0)) return { ok: false };
  const isZig = /\b(zig|zwg|zwl|zw\$|bond)\b/i.test(s);
  const fare = isZig ? `ZiG ${amount}` : `$${amount % 1 ? amount.toFixed(2) : amount}`;
  return { ok: true, fare, amount, eta, isZig };
}

// ── Safe senders (never throw into the engine; respect WhatsApp limits) ───────
function _btns(buttons = []) {
  return buttons.filter(Boolean).slice(0, 3).map(b => ({ id: String(b.id).slice(0, 256), title: cut(b.title, 20) }));
}
function _rows(rows = []) {
  return rows.filter(Boolean).slice(0, 10).map(r => ({
    id: String(r.id).slice(0, 200),
    title: cut(r.title, 24),
    ...(r.description ? { description: cut(r.description, 72) } : {})
  }));
}
async function say(to, text) {
  try { await sendText(to, String(text).slice(0, 4000)); return true; }
  catch (e) { console.warn(`[BIKER] sendText → ${to} failed: ${e.message}`); return false; }
}
async function ask(to, text, buttons) {
  try { await sendButtons(to, { text: String(text).slice(0, 1020), buttons: _btns(buttons) }); return true; }
  catch (e) {
    console.warn(`[BIKER] sendButtons → ${to} failed: ${e.message}`);
    return say(to, text);
  }
}
async function pick(to, text, rows) {
  try { await sendList(to, String(text).slice(0, 1020), _rows(rows)); return true; }
  catch (e) { console.warn(`[BIKER] sendList → ${to} failed: ${e.message}`); return false; }
}
// Message to the OTHER party. Interactive first (they are usually inside the
// 24h window because they just used the bot); if Meta rejects it, fall back to
// the generic utility template zq_ride_update ({{1}} ref, {{2}} update line).
async function notifyParty(to, { text, buttons = null, ref = "", line = "" }) {
  const ok = buttons?.length ? await ask(to, text, buttons) : await say(to, text);
  if (ok) return true;
  try {
    await _sendTemplate(to, "zq_ride_update", [ref || "ZimQuote delivery", cut(line || text.replace(/\n+/g, " "), 900)]);
    return true;
  } catch (e) {
    console.warn(`[BIKER] zq_ride_update template → ${to} failed: ${e.message}`);
    return false;
  }
}
async function notifyAdmin(text) {
  if (!ADMIN_PHONE || ADMIN_PHONE.length < 10) return;
  await say(ADMIN_PHONE, `🏍️ *Bikers - admin alert*\n\n${text}`);
}

// ── Per-phone lock: one user's messages are processed one at a time ──────────
const _locks = new Map();
function withLock(key, fn) {
  const prev = _locks.get(key) || Promise.resolve();
  let release;
  const mine = new Promise(r => (release = r));
  const chain = prev.then(() => mine);
  _locks.set(key, chain);
  const waitPrev = Promise.race([prev, new Promise(r => setTimeout(r, 20000))]);   // never deadlock
  return waitPrev.then(async () => {
    try { return await fn(); }
    finally { release(); if (_locks.get(key) === chain) _locks.delete(key); }
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// SESSION STATE  (UserSession.tempData.bikerState / bikerData / bikerStateAt)
// ═════════════════════════════════════════════════════════════════════════════
async function getSess(phone) {
  const s = await UserSession.findOne({ phone }).lean().catch(() => null);
  const td = s?.tempData || {};
  let state = td.bikerState || "";
  const at = td.bikerStateAt ? new Date(td.bikerStateAt).getTime() : 0;
  const ttl = (state.startsWith("biker_reg_") || state.startsWith("biker_kyc_") ? 90 : BIKER_CONFIG.STATE_TTL_MIN) * 60000;
  if (state && at && Date.now() - at > ttl) {          // expired: forget silently
    state = "";
    await clearState(phone);
  }
  return { state, data: { ...(td.bikerData || {}) }, lastCity: td.bikerLastCity || "", activeBusinessId: s?.activeBusinessId || null,
           lead: td.bikerLead && Number(td.bikerLead.until) > Date.now() ? td.bikerLead : null };
}
async function setState(phone, state, data = {}) {
  await UserSession.findOneAndUpdate(
    { phone },
    { $set: { "tempData.bikerState": state, "tempData.bikerData": data, "tempData.bikerStateAt": new Date() } },
    { upsert: true }
  );
}
async function clearState(phone) {
  await UserSession.findOneAndUpdate(
    { phone },
    { $unset: { "tempData.bikerState": "", "tempData.bikerData": "", "tempData.bikerStateAt": "" } },
    { upsert: true }
  ).catch(() => {});
}
async function setLastCity(phone, city) {
  if (!city) return;
  await UserSession.findOneAndUpdate({ phone }, { $set: { "tempData.bikerLastCity": city } }, { upsert: true }).catch(() => {});
}
// Starting a biker flow abandons other half-finished searches, so a stale
// marker (e.g. tutorSearchActive) can never grab the next typed message.
async function clearCompetingFlows(phone) {
  await UserSession.findOneAndUpdate(
    { phone },
    { $unset: {
        "tempData.tutorSearchActive": "", "tempData.schoolSearchActive": "", "tempData.instSearchActive": "",
        "tempData.tutorEnquiryState": "", "tempData.schoolEnquiryState": "", "tempData.supplierSearchMode": "",
        "tempData.buyerRequestState": "", "tempData.pendingBuyerRequest": "", "tempData.buyerRequestMode": "",
        "tempData.grpListIds": "", "tempData.grpListType": "",
        "tempData.sellerRequestReplyState": "", "tempData.scSellerQuoteState": "", "tempData.pendingQuoteReply": ""
    } },
    { upsert: true }
  ).catch(() => {});
}

// ═════════════════════════════════════════════════════════════════════════════
// RIDER PROFILE ACCESS
// ═════════════════════════════════════════════════════════════════════════════
const _riderCache = new Map();   // phone → { id|null, t }
export function invalidateRiderCache(phone) { _riderCache.delete(normPhone(phone)); }

export async function getRider(phoneRaw) {
  const phone = normPhone(phoneRaw);
  const r = await SupplierProfile.findOne({ phone: { $in: phoneVariants(phone) }, profileType: "biker" }).lean().catch(() => null);
  _riderCache.set(phone, { id: r?._id || null, t: Date.now() });
  return r;
}
async function isRider(phone) {
  const c = _riderCache.get(phone);
  if (c && Date.now() - c.t < 5 * 60000) return !!c.id;
  return !!(await getRider(phone));
}
// Writes biker-only fields even if the SupplierProfile schema doesn't declare them.
async function updateRider(filter, update, opts = {}) {
  return SupplierProfile.findOneAndUpdate(filter, update, { new: true, strict: false, ...opts }).lean().catch(e => {
    console.warn("[BIKER] updateRider failed:", e.message); return null;
  });
}
export async function addRiderPoints(phoneOrId, delta, extraInc = {}) {
  const filter = isObjId(phoneOrId) ? { _id: phoneOrId } : { phone: { $in: phoneVariants(phoneOrId) }, profileType: "biker" };
  const inc = { riderPoints: Number(delta) || 0, ...extraInc };
  const r = await updateRider(filter, { $inc: inc });
  if (r && (r.riderPoints || 0) < 0) {
    await updateRider({ _id: r._id }, { $set: { riderPoints: 0 } });
    r.riderPoints = 0;
  }
  return r;
}
async function activeJobCount(riderPhone) {
  return BikerJob.countDocuments({ assignedRiderPhone: normPhone(riderPhone), status: { $in: ACTIVE_STATUSES } }).catch(() => 0);
}
function riderBadgeLine(r) {
  const lvl = riderLevel(r?.riderPoints);
  const rating = Number(r?.rating) || 0;
  return `${lvl.emoji} ${lvl.name}${rating ? ` · ⭐ ${rating.toFixed(1)}` : ""} · ${plural(r?.completedTrips || 0, "trip")}${isRiderVerified(r) ? " · 🪪 ID verified" : ""}`;
}

// ── Identity / privacy helpers ───────────────────────────────────────────────
// Customers see the DISPLAY name (rider's chosen name) while choosing; after
// booking they see the LEGAL FIRST NAME + plate. The ID photo and full legal
// name are admin-only.
export function isRiderVerified(r) {
  return r?.riderKyc?.status === "approved" || !!r?.bike?.verifiedAt;
}
export function canTakeJobs(r) {
  return !!r && r.active === true && r.suspended !== true && (!BIKER_CONFIG.REQUIRE_VERIFIED || isRiderVerified(r));
}
function kycStatus(r) {
  if (isRiderVerified(r)) return "approved";
  return r?.riderKyc?.status || (r?.bike?.photoUrl ? "pending" : "none");
}
export function publicName(r) {
  return String(r?.riderDisplayName || "").trim() || firstName(r?.riderLegalName || riderName(r));
}
function legalFirst(r) { return firstName(r?.riderLegalName || riderName(r)); }
// "263772123456" → "+263 77 2XX XXXX"  (enough to feel real, not enough to use)
export function maskPhone(raw = "") {
  const d = normPhone(raw);
  if (d.startsWith("263") && d.length >= 12) return `+263 ${d.slice(3, 5)} ${d.slice(5, 6)}XX XXXX`;
  return d ? `+${d.slice(0, 5)}XXXX` : "";
}
function kycLine(r) {
  const st = kycStatus(r);
  if (st === "approved") return "🪪 ID: ✅ approved";
  if (st === "pending")  return "🪪 ID: ⏳ being checked by ZimQuote";
  if (st === "rejected") return `🪪 ID: ⚠️ not approved${r?.riderKyc?.rejectReason ? ` - ${r.riderKyc.rejectReason}` : ""}`;
  return "🪪 ID: ❌ not sent yet";
}

// ═════════════════════════════════════════════════════════════════════════════
// PUBLIC ENTRY
// Returns true  → handled (engine must return)
// Returns false → not a biker message (engine continues)
// ═════════════════════════════════════════════════════════════════════════════
const ESCAPE_RE    = /^(0|00|000|menu|main menu|back|cancel|exit|home|stop|hi|hie|hey|hello|helo|howzit)$/i;
const MENU_WORD_RE = /^(0|menu|main menu|hi|hie|hey|hello|helo|howzit|start|home|rider|rider menu|biker|biker menu|jobs|my jobs)$/i;
const REQUEST_RE   = /^(request\s+(a\s+)?(rider|biker)|find\s+(a\s+)?(rider|biker)|need\s+(a\s+)?(rider|biker)|i\s+want\s+(a\s+)?(rider|biker)|get\s+(a\s+)?(rider|biker)|book\s+(a\s+)?(rider|biker)|rider|biker|boda|delivery|courier|courier\s+rider|send\s+a\s+parcel)$/i;
const REGISTER_RE  = /^(become\s+a\s+(rider|biker)|register\s+as\s+(a\s+)?(rider|biker)|list\s+as\s+(a\s+)?(rider|biker)|(rider|biker)\s+signup|i\s*a?m\s+a\s+(rider|biker)|join\s+as\s+(a\s+)?(rider|biker))$/i;
const RIDER_WORD_RE = /^((go\s+)?online|(go\s+)?offline|open jobs|new jobs|jobs near me|points|my points|earnings|stats)$/i;
const MYDEL_RE     = /^(my deliveries|deliveries|my rides|track|track delivery|my delivery|my bikers?)$/i;

export async function handleBikerMessage({ from, text = "", action = "", biz = null, saveBiz = null, imageUrl = null }) {
  const phone = normPhone(from);
  if (!phone) return false;
  return withLock(phone, async () => {
    try {
      const a   = String(action || "").trim().toLowerCase();
      const txt = String(text || "").trim();
      const ctx = { from, phone, biz, saveBiz };

      // Legacy: an older version kept biker state on Business - clear it once.
      if (biz && String(biz.sessionState || "").startsWith("biker_") && typeof saveBiz === "function") {
        biz.sessionState = "ready";
        if (biz.sessionData) { delete biz.sessionData.bikerReg; delete biz.sessionData.bikerJob; }
        try { await saveBiz(biz); } catch (_) {}
      }

      const sess = await getSess(phone);
      ctx.sess = sess;

      // A) ID / selfie photo for verification
      if (imageUrl && /^biker_(photo_wait|kyc_id|kyc_selfie)$/.test(sess.state)) return saveKycPhoto(ctx, imageUrl);

      // B) Biker button / list taps always win (even mid-flow)
      if (a && (a === "reg_type_biker" || a.startsWith("biker_"))) return handleAction(ctx, a);

      // C) Deep links (typed text from wa.me links)
      // Shareable hub link: "ZQ:BIKERS" or "ZQ:BIKERS:HARARE" anywhere in the text
      // (the wa.me prefill wraps it in a friendly sentence). Always wins, even mid-flow.
      const hub = txt.match(/ZQ:BIKERS?(?::([A-Za-z][A-Za-z -]{1,30}?))?(?=$|[\s).,!🏍])/i);
      if (hub) return bikerHub(ctx, (hub[1] || "").trim());
      // Short, normal-looking link text: "Bikers" / "ZimQuote Bikers" / "Bikers Harare"
      const plainHub = !a && matchPlainHub(txt);
      if (plainHub) return bikerHub(ctx, plainHub.city);
      const riderLink = txt.match(/ZQ:RIDER:([a-f0-9]{24})/i);
      if (riderLink) return bookSpecificRider(ctx, riderLink[1]);
      if (/^ZQ:BGROUP:/i.test(txt)) return bikerGroupLink(ctx, txt.replace(/^ZQ:BGROUP:/i, "").trim());

      // D) An in-progress biker flow owns typed text
      if (sess.state) {
        if (a) { await clearState(phone); return false; }      // tapped something non-biker → leave flow
        if (ESCAPE_RE.test(txt)) {
          await clearState(phone);
          if (await isRider(phone)) return sendRiderMenu(from, null, biz);
          return false;                                         // engine shows the normal menu
        }
        return routeState(ctx, txt);
      }
      if (a) return false;

      // D2) An unactivated rider we just sent a masked lead to replies with anything →
      //     show the lead teaser + how to unlock it (once).
      if (sess.lead) {
        await UserSession.updateOne({ phone }, { $unset: { "tempData.bikerLead": "" } }).catch(() => {});
        const lr = await getRider(phone);
        if (lr && !canTakeJobs(lr)) return showLockedLead(ctx, lr, sess.lead);
      }

      // E) Typed shortcuts (rider lookup only when the text could be a rider shortcut)
      const riderish = MENU_WORD_RE.test(txt) || RIDER_WORD_RE.test(txt);
      const rider = riderish ? await isRider(phone) : false;
      if (rider && MENU_WORD_RE.test(txt)) {
        await clearCompetingFlows(phone);
        if (biz && biz.sessionState && biz.sessionState !== "ready" && typeof saveBiz === "function") {
          biz.sessionState = "ready"; biz.sessionData = {}; try { await saveBiz(biz); } catch (_) {}
        }
        return sendRiderMenu(from, null, biz);
      }
      if (rider && /^(go\s+)?online$/i.test(txt))  return toggleOnline(ctx, true);
      if (rider && /^(go\s+)?offline$/i.test(txt)) return toggleOnline(ctx, false);
      if (rider && /^(open jobs|new jobs|jobs near me)$/i.test(txt)) return sendOpenJobs(ctx);
      if (rider && /^(points|my points|earnings|stats)$/i.test(txt)) return sendRiderStats(ctx);
      if (MYDEL_RE.test(txt)) return sendMyDeliveries(ctx);
      if (REGISTER_RE.test(txt)) return startBikerRegistration(ctx);
      if (REQUEST_RE.test(txt)) return startRiderRequest(ctx);
      return false;
    } catch (err) {
      console.error("[BIKER] handleBikerMessage error:", err.message, err.stack);
      await say(from, "⚠️ Something went wrong on our side. Please try again, or type *menu*.");
      return true;
    }
  });
}

// ── Action router ─────────────────────────────────────────────────────────────
async function handleAction(ctx, a) {
  const { phone } = ctx;
  if (a === "reg_type_biker") return startBikerRegistration(ctx);
  const m = a.match(/^biker_([a-z]+)(?:_(.*))?$/);
  if (!m) return false;
  const verb = m[1], arg = m[2] || "";

  // Actions that don't continue the current typed state drop it.
  const keepsState = ["regcity", "reqcity", "areas", "dname"].includes(verb);
  if (!keepsState && ctx.sess.state) { await clearState(phone); ctx.sess.state = ""; }

  switch (verb) {
    // customer
    case "request":   return startRiderRequest(ctx);                  // biker_request_rider
    case "reqcity":   return reqCityPicked(ctx, arg);
    case "mydel":     return sendMyDeliveries(ctx);
    case "job":       return sendJobCard(ctx, arg);
    case "offers":    return sendOffers(ctx, arg);
    case "choose":    return customerChoose(ctx, arg);
    case "rcv":       return customerReceived(ctx, arg);
    case "prob":      return startProblem(ctx, arg);
    case "rate":      { const [id, n] = arg.split("_"); return customerRate(ctx, id, Number(n)); }
    case "cnskip":    await clearState(phone); return ask(ctx.from, "🙏 Thanks for using ZimQuote Bikers!", [
                        { id: "biker_rebook_" + arg, title: "🔁 Same trip again" }, { id: "main_menu_back", title: "🏠 Menu" }]);
    case "rebook":    return rebook(ctx, arg);
    case "viewrider": return viewRider(ctx, arg);
    case "bookrider": return bookSpecificRider(ctx, arg);
    // both
    case "cx":        return startCancel(ctx, arg);
    case "cxr":       { const i = arg.lastIndexOf("_"); return cancelWithCode(ctx, arg.slice(0, i), arg.slice(i + 1)); }
    // rider
    case "menu": case "my": return sendRiderMenu(ctx.from, null, ctx.biz); // biker_menu / biker_my_account
    case "toggle":    return toggleOnline(ctx);
    case "openjobs":  return sendOpenJobs(ctx);
    case "active":    return sendActiveJobs(ctx);
    case "stats":     return sendRiderStats(ctx);
    case "areas":     return arg === "whole" ? areasWhole(ctx) : startAreasEdit(ctx);
    case "photo":     { if (arg === "again") { const r = await getRider(phone); return r ? askIdPhoto(ctx, r) : startBikerRegistration(ctx); } return startPhoto(ctx); }
    case "skipphoto": await clearState(phone); return afterKycSkip(ctx);
    case "dname":     return regDisplayName(ctx, arg === "first" ? "__first__" : "");
    case "nocode":    return riderDeliveredNoCode(ctx, arg);
    case "mylink":    return sendRiderLink(ctx);
    case "help":      return sendRiderHelp(ctx);
    case "activate":  return sendActivate(ctx);
    case "zqmenu":    return sendZqMenu(ctx);
    case "regcity":   return regCityPicked(ctx, arg);
    case "accept":    return riderAccept(ctx, arg);
    case "busy":      return riderBusy(ctx, arg);
    case "fare":      { const i = arg.lastIndexOf("_"); return riderFareTap(ctx, arg.slice(0, i), arg.slice(i + 1)); }
    case "eta":       { const [id, amt, min] = arg.split("_"); return riderEtaTap(ctx, id, amt, min); }
    case "pick":      return riderPickedUp(ctx, arg);
    case "done":      return riderDeliveredStart(ctx, arg);
    case "dn":        { const i = arg.lastIndexOf("_"); return riderQuickNote(ctx, arg.slice(0, i), arg.slice(i + 1)); }
    case "when":      return startRiderRequest(ctx);                  // legacy id
  }
  return false;
}

// ── Typed-text router (state owns the message) ───────────────────────────────
async function routeState(ctx, txt) {
  const st = ctx.sess.state;
  if (st === "biker_reg_name")   return regName(ctx, txt);
  if (st === "biker_reg_city")   return regCityPicked(ctx, txt);
  if (st === "biker_reg_areas")  return regAreas(ctx, txt);
  if (st === "biker_reg_plate")  return regPlate(ctx, txt);
  if (st === "biker_reg_dname")  return regDisplayName(ctx, txt);
  if (st === "biker_kyc_id" || st === "biker_kyc_selfie") {
    return ask(ctx.from, st === "biker_kyc_id"
      ? "🪪 Please send a *photo* of your National ID (not text)."
      : "📸 Please send a *photo* of you with your bike - number plate visible.",
      [{ id: "biker_skipphoto", title: "⏭ Later" }]);
  }
  if (st === "biker_req_what")   return reqWhat(ctx, txt);
  if (st === "biker_req_route")  return reqRoute(ctx, txt);
  if (st === "biker_req_city")   return reqCityPicked(ctx, txt);
  if (st === "biker_areas_set")  return saveAreas(ctx, txt);
  if (st === "biker_photo_wait") {
    return ask(ctx.from, "📸 Please send a *photo* (not text) of you with your bike, plate visible.\n\nOr tap below to skip for now.",
      [{ id: "biker_skipphoto", title: "⏭ Skip for now" }]);
  }
  const m = st.match(/^biker_(fare|dnote|cnote|prob|cxnote|code)_([a-f0-9]{24})$/);
  if (m) {
    const [, kind, jobId] = m;
    if (kind === "fare")   return riderFareTyped(ctx, jobId, txt);
    if (kind === "dnote")  return saveRiderNote(ctx, jobId, txt);
    if (kind === "cnote")  return saveCustomerNote(ctx, jobId, txt);
    if (kind === "prob")   return saveProblem(ctx, jobId, txt);
    if (kind === "cxnote") return cancelWithCode(ctx, jobId, "other", txt);
    if (kind === "code")   return riderCodeTyped(ctx, jobId, txt);
  }
  await clearState(ctx.phone);
  return false;
}

// ═════════════════════════════════════════════════════════════════════════════
// RIDER REGISTRATION  (4 quick steps → existing EcoCash activation)
// ═════════════════════════════════════════════════════════════════════════════
export async function startBikerRegistration(ctx) {
  ctx = await _ctx(ctx);
  const rider = await getRider(ctx.phone);
  if (rider && rider.active) return sendRiderMenu(ctx.from, rider, ctx.biz);
  if (rider && !rider.active) {
    await say(ctx.from, `👋 Welcome back ${publicName(rider)}! Your rider profile is saved - just activate it to start getting jobs.`);
    return sendActivate(ctx, rider);
  }
  await clearCompetingFlows(ctx.phone);
  await setState(ctx.phone, "biker_reg_name", { reg: {} });
  await say(ctx.from,
    "🏍️ *Become a ZimQuote Rider*\n\n" +
    "✅ Get delivery jobs on WhatsApp\n✅ You set your own price\n✅ Keep 100% of every fare\n💳 Just $5/month\n" +
    "🪪 Every rider is ID-checked - customers trust verified riders.\n\n" +
    "5 quick steps.\n\n*1/5 - Your FULL name, exactly as on your National ID?*\n_e.g. Tapiwa Moyo_\n🔒 Customers only ever see your first name."
  );
  return true;
}
async function regName(ctx, name) {
  const n = String(name || "").replace(/\s+/g, " ").trim();
  if (n.length < 3 || /^\d+$/.test(n) || !/\s/.test(n)) { await say(ctx.from, "Please type your *full name* as on your ID (first name and surname), e.g. *Tapiwa Moyo*."); return true; }
  await setState(ctx.phone, "biker_reg_city", { reg: { ...(ctx.sess.data.reg || {}), name: n.slice(0, 60) } });
  await pick(ctx.from,
    `👍 Thanks ${firstName(n)}!\n\n*2/5 - Which city do you ride in?*\nTap one, or type it.`,
    CITY_ROWS.map(c => ({ id: `biker_regcity_${c.toLowerCase()}`, title: c })));
  return true;
}
async function regCityPicked(ctx, raw) {
  if (ctx.sess.state !== "biker_reg_city") return startBikerRegistration(ctx);
  const det = detectCity(raw);
  const c = titleCity(det.city || raw);
  if (!c || c.length < 3) { await say(ctx.from, "Please tap or type your city, e.g. *Harare*."); return true; }
  const reg = { ...(ctx.sess.data.reg || {}), city: c };
  // Typed a suburb ("Glen View")? Keep it as their first area.
  const hits = findPlaces(raw).filter(h => h.name !== c.toLowerCase());
  if (hits.length && det.city) reg.areaHint = raw.trim();
  await setState(ctx.phone, "biker_reg_areas", { reg });
  await ask(ctx.from,
    `📍 *${c}*\n\n*3/5 - Which areas do you cover?*\nType them with commas:\n_e.g. CBD, Avondale, Mt Pleasant_\n\nOr tap *Whole city* to get jobs from anywhere in ${c}.`,
    [{ id: "biker_areas_whole", title: "🌍 Whole city" }]);
  return true;
}
async function regAreas(ctx, raw) {
  const list = raw === "__whole__" ? [] : String(raw || "").split(/[,\n;]+/).map(s => s.trim()).filter(Boolean).slice(0, 12);
  if (raw !== "__whole__" && !list.length) {
    await ask(ctx.from, "Type the areas you cover (e.g. *CBD, Avondale*), or tap *Whole city*.", [{ id: "biker_areas_whole", title: "🌍 Whole city" }]);
    return true;
  }
  await setState(ctx.phone, "biker_reg_plate", { reg: { ...(ctx.sess.data.reg || {}), areas: list } });
  await say(ctx.from, "✅ Got it.\n\n*4/5 - Your bike number plate?*\n_e.g. AEX 1234_");
  return true;
}
async function regPlate(ctx, plate) {
  const p = String(plate || "").trim().toUpperCase().replace(/\s+/g, " ").slice(0, 16);
  if (p.length < 3) { await say(ctx.from, "Please type your number plate, e.g. *AEX 1234*."); return true; }
  const reg = { ...(ctx.sess.data.reg || {}), plate: p };
  await setState(ctx.phone, "biker_reg_dname", { reg });
  const fn = firstName(reg.name);
  await ask(ctx.from,
    `🏍️ *${p}* saved.\n\n*5/5 - Your rider name?*\nThis is what customers see when you send a price - your first name, or a bike name.\n_e.g. ${fn}, Speedy T, Blue Bike_\n\nType it, or tap below.`,
    [{ id: "biker_dname_first", title: cut(`👤 Use "${fn}"`, 20) }]);
  return true;
}
async function regDisplayName(ctx, raw) {
  if (ctx.sess.state !== "biker_reg_dname") return startBikerRegistration(ctx);
  const reg = { ...(ctx.sess.data.reg || {}) };
  let d = raw === "__first__" ? firstName(reg.name) : String(raw || "").replace(/\s+/g, " ").trim();
  d = d.replace(/[^\p{L}\p{N} .'&-]/gu, "").slice(0, 20).trim();
  if (d.length < 2) { await say(ctx.from, "Please type a rider name (2-20 letters), e.g. *Speedy T*."); return true; }
  return finishBikerRegistration(ctx, { ...reg, displayName: d });
}
async function finishBikerRegistration(ctx, reg) {
  const name  = reg.name || "Rider";
  const dname = reg.displayName || firstName(name);
  const city  = titleCity(reg.city || "Harare");
  const areas = Array.isArray(reg.areas) ? reg.areas : [];
  const realBiz = await ensureRealBiz(ctx);

  // Upsert - never create a second rider profile for the same phone.
  let supplier = await getRider(ctx.phone);
  try {
    if (!supplier) {
      supplier = await SupplierProfile.create({
        phone: ctx.phone,
        businessName: `${dname} (Rider)`,
        businessId: realBiz?._id || null,
        profileType: "biker",
        location: { city, area: areas[0] || city },
        categories: ["transport"],
        revealVisitorPhone: true,
        canViewContacts: true,
        tier: "basic", tierRank: 1,
        subscriptionStatus: "pending",
        active: false
      });
    }
    supplier = await updateRider({ _id: supplier._id }, { $set: {
      businessName: `${dname} (Rider)`,
      riderLegalName: name, riderDisplayName: dname,
      "location.city": city, "location.area": areas[0] || city,
      riderAreas: areas, riderActive: true,
      "bike.plate": reg.plate || "",
      ...(supplier.businessId ? {} : { businessId: realBiz?._id || null })
    } }) || supplier;
  } catch (err) {
    console.error("[BIKER REG] save failed:", err.message);
    await clearState(ctx.phone);
    await say(ctx.from, "❌ We couldn't save your rider profile (this number may already be listed as a seller). Please contact ZimQuote support, or type *menu*.");
    return true;
  }
  invalidateRiderCache(ctx.phone);
  await setLastCity(ctx.phone, city);
  await notifyAdmin(`New rider signed up (not yet paid / ID not checked):\n👤 ${name} ("${dname}")\n📞 ${displayPhone(ctx.phone)}\n📍 ${city}${areas.length ? " · " + areas.join(", ") : ""}\n🏍️ ${reg.plate || "-"}`);
  // Next: ID photo → selfie with bike → payment.
  return askIdPhoto({ ...ctx, biz: realBiz }, supplier, true);
}

// ═════════════════════════════════════════════════════════════════════════════
// IDENTITY CHECK (KYC): National ID photo + photo with bike → admin approves
// ─────────────────────────────────────────────────────────────────────────────
// Riders get jobs only when PAID *and* APPROVED. The ID photo and legal name are
// seen by ZimQuote admin only. Paying never skips the check.
// ═════════════════════════════════════════════════════════════════════════════
async function askIdPhoto(ctx, rider, afterSignup = false) {
  await setState(ctx.phone, "biker_kyc_id", { afterSignup });
  await ask(ctx.from,
    (afterSignup ? `✅ *Profile saved!* One last thing - ID check.\n\n` : `🪪 *Get your ID checked*\n\n`) +
    `📸 Send a clear photo of your *National ID* (front).\n` +
    `The name must match: *${rider?.riderLegalName || riderName(rider)}*\n\n` +
    `🔒 Only the ZimQuote team sees it - never customers.\n✅ Verified riders get all the jobs.`,
    [{ id: "biker_skipphoto", title: "⏭ Later" }]);
  return true;
}
async function askSelfie(ctx, rider, afterSignup = false) {
  await setState(ctx.phone, "biker_kyc_selfie", { afterSignup });
  await ask(ctx.from,
    `✅ ID received.\n\n📸 Now a photo of *you with your bike* - face and number plate *${rider?.bike?.plate || ""}* visible.`,
    [{ id: "biker_skipphoto", title: "⏭ Later" }]);
  return true;
}
async function saveKycPhoto(ctx, imageUrl) {
  const rider = await getRider(ctx.phone);
  const st = ctx.sess.state;
  const afterSignup = !!ctx.sess.data?.afterSignup;
  if (!rider) { await clearState(ctx.phone); return false; }
  if (st === "biker_kyc_id") {
    await updateRider({ _id: rider._id }, { $set: { "riderKyc.idPhotoUrl": imageUrl, "riderKyc.status": rider.riderKyc?.status === "approved" ? "approved" : "none" } });
    return askSelfie(ctx, rider, afterSignup);
  }
  // selfie (or legacy "Get Verified" photo)
  await clearState(ctx.phone);
  const hasId = !!rider.riderKyc?.idPhotoUrl;
  const set = { "bike.photoUrl": imageUrl, "bike.photoSubmittedAt": new Date(), "riderKyc.selfieUrl": imageUrl };
  if (hasId && !isRiderVerified(rider)) Object.assign(set, { "riderKyc.status": "pending", "riderKyc.submittedAt": new Date(), "riderKyc.rejectReason": "" });
  await updateRider({ _id: rider._id }, { $set: set });
  invalidateRiderCache(ctx.phone);
  if (!hasId) return askIdPhoto(ctx, rider, afterSignup);   // legacy path: still need the ID
  await notifyAdmin(`🪪 ID check needed: *${rider.riderLegalName || riderName(rider)}* ("${publicName(rider)}") ${displayPhone(rider.phone)} · 🏍️ ${rider.bike?.plate || "-"}${rider.active ? " · PAID" : ""}\nOpen admin → Riders → 🪪 IDs to check.`);
  if (!rider.active) {
    await say(ctx.from, "✅ *Photos received!* Our team checks them (usually same day).\n\nActivate now so you're ready the moment you're approved 👇");
    return sendActivate(ctx, { ...rider, riderKyc: { ...(rider.riderKyc || {}), status: "pending" } });
  }
  await ask(ctx.from, "✅ *Photos received!* Our team will check them and switch on your job alerts - usually the same day. We'll message you here.",
    [{ id: "biker_menu", title: "🏍️ Rider Menu" }]);
  return true;
}
async function afterKycSkip(ctx) {
  const rider = await getRider(ctx.phone);
  if (!rider) return sendRiderMenu(ctx.from, null, ctx.biz);
  await say(ctx.from, "👌 No problem. You can send your ID any time from the Rider Menu → *🪪 Verify my ID*.\n\n⚠️ You'll only get jobs once your ID is checked.");
  if (!rider.active) return sendActivate(ctx, rider);
  return sendRiderMenu(ctx.from, rider, ctx.biz);
}

// Rider REGISTRATION / ACTIVATION needs a real Business (the existing EcoCash
// plan → payment path requires one). Reuse the user's own, or create a pending one.
async function ensureRealBiz(ctx) {
  if (ctx.biz && ctx.biz._id && typeof ctx.biz.save === "function") return ctx.biz;
  const phone = ctx.phone;
  let real = await Business.findOne({ ownerPhone: phone, name: "pending_supplier_" + phone });
  if (!real) {
    real = await Business.create({
      name: "pending_supplier_" + phone, currency: "USD", package: "trial",
      subscriptionStatus: "inactive", isSupplier: false, sessionState: "ready", sessionData: {}, ownerPhone: phone
    });
  }
  await UserRole.findOneAndUpdate(
    { phone, businessId: real._id },
    { $setOnInsert: { phone, businessId: real._id, role: "owner", pending: false } },
    { upsert: true }
  );
  await UserSession.findOneAndUpdate({ phone }, { $set: { activeBusinessId: real._id } }, { upsert: true });
  return real;
}
async function saveBizAny(ctx, b) {
  if (b === ctx.biz && typeof ctx.saveBiz === "function") return ctx.saveBiz(b);
  if (typeof b?.markModified === "function") b.markModified("sessionData");
  if (typeof b?.save === "function") return b.save();
  // Plain object (e.g. a lean read) - write the fields the payment step needs.
  if (b?._id) return Business.updateOne({ _id: b._id }, { $set: {
    sessionState: b.sessionState, sessionData: b.sessionData || {}, name: b.name,
    isSupplier: !!b.isSupplier, ...(b.supplierProfileId ? { supplierProfileId: b.supplierProfileId } : {})
  } }).catch(() => {});
}

async function sendActivate(ctx, rider = null, justRegistered = false) {
  rider = rider || await getRider(ctx.phone);
  if (!rider) return startBikerRegistration(ctx);
  if (rider.active) { await say(ctx.from, "✅ Your rider account is already active."); return sendRiderMenu(ctx.from, rider, ctx.biz); }
  const biz = await ensureRealBiz(ctx);
  biz.sessionData = { ...(biz.sessionData || {}), pendingSupplierId: String(rider._id) };
  if (!biz.supplierProfileId) biz.supplierProfileId = rider._id;
  biz.isSupplier = true;
  if (!biz.name || String(biz.name).startsWith("pending_")) biz.name = riderName(rider) + " (Rider)";
  biz.sessionState = "supplier_reg_choose_plan";
  await saveBizAny(ctx, biz);
  if (!rider.businessId) await updateRider({ _id: rider._id }, { $set: { businessId: biz._id } });

  const areas = rider.riderAreas || [];
  await pick(ctx.from,
    (justRegistered ? `✅ *Almost done, ${firstName(rider.businessName)}!*\n\n` : `💳 *Activate your Rider account*\n\n`) +
    `• 📍 ${rider.location?.city || "-"} · ${areas.length ? areas.join(", ") : "Whole city"}\n` +
    `• 🏍️ Plate: ${rider.bike?.plate || "-"}\n• ${kycLine(rider)}\n\n` +
    `Activate to start getting jobs. Pay by EcoCash on the next step.\n_Jobs start once you're paid AND your ID is approved._`,
    [
      { id: "sup_plan_basic_monthly", title: "✅ Activate - $5/month", description: "Get delivery jobs on WhatsApp" },
      { id: "sup_plan_basic_annual",  title: "⭐ Save - $50/year",     description: "2 months free" }
    ]);
  return true;
}

// ═════════════════════════════════════════════════════════════════════════════
// RIDER MENU + RIDER SCREENS
// ═════════════════════════════════════════════════════════════════════════════
export async function sendRiderMenu(to, rider = null, biz = null) {
  const phone = normPhone(to);
  rider = rider || await getRider(phone);
  if (!rider) return false;
  const online   = rider.riderActive !== false;
  const lvl      = riderLevel(rider.riderPoints);
  const [mine, open] = await Promise.all([activeJobCount(phone), countOpenNear(rider)]);
  const ks = kycStatus(rider);
  const ready = canTakeJobs(rider);
  const areas    = rider.riderAreas || [];

  const rows = [
    ...(!rider.active ? [{ id: "biker_activate", title: "💳 Activate - $5/mo", description: "Start getting delivery jobs" }] : []),
    { id: "biker_toggle_online", title: online ? "⏸ Go Offline" : "🟢 Go Online", description: online ? "Stop job alerts (on a break)" : "Start getting job alerts" },
    { id: "biker_openjobs", title: `🔔 Open Jobs (${open})`, description: "Jobs near you waiting for a rider" },
    { id: "biker_active",   title: `📋 My Jobs (${mine})`,   description: "Update picked up / delivered" },
    { id: "biker_stats",    title: "🏆 Points & Earnings",   description: `${lvl.emoji} ${lvl.name} · ${rider.riderPoints || 0} pts` },
    { id: "biker_areas",    title: "📍 My Areas",            description: areas.length ? areas.join(", ") : "Whole city" },
    { id: "biker_mylink",   title: "🔗 My Rider Link",       description: "Share it - customers book YOU" },
    ...(ks === "none" || ks === "rejected" ? [{ id: "biker_photo", title: "🪪 Verify my ID", description: ks === "rejected" ? "Send new photos - needed for jobs" : "Needed before you get jobs" }] : []),
    ...(ks === "pending" ? [{ id: "biker_photo", title: "⏳ ID being checked", description: "We'll message you when approved" }] : []),
    { id: "biker_help",     title: "❓ How It Works",        description: "Prices, points, tips" },
    { id: "biker_zqmenu",   title: "🛍️ More (ZimQuote)",     description: "Shop, request sellers, business" }
  ].slice(0, 10);

  await pick(to,
    `🏍️ *Rider Menu* - ${publicName(rider)}\n\n` +
    `${online ? "🟢 *ONLINE* - you'll get job alerts" : "⚪ *OFFLINE* - no job alerts"}\n` +
    `${riderBadgeLine(rider)}\n` +
    `💰 ${rider.riderPoints || 0} points${lvl.next ? ` · ${lvl.toNext} to ${lvl.next.emoji} ${lvl.next.name}` : ""}` +
    `\n${kycLine(rider)}` +
    (!rider.active ? `\n\n⚠️ *Not activated* - tap *Activate* to start getting jobs.` : "") +
    (rider.active && !ready && !rider.suspended ? `\n\n⚠️ *No job alerts yet* - your ID must be approved first.` : "") +
    (rider.suspended ? `\n\n⛔ Your account is suspended. Contact ZimQuote support.` : ""),
    rows);
  return true;
}

async function countOpenNear(rider) {
  const group = metroGroup(rider.location?.city || "");
  if (!group.length) return 0;
  const phone = normPhone(rider.phone);
  return BikerJob.countDocuments({
    status: "open",
    openSince: { $gte: new Date(Date.now() - BIKER_CONFIG.OPEN_JOB_WINDOW_MIN * 60000) },
    city: { $in: group.map(c => new RegExp(`^${escRe(c)}$`, "i")) },
    cancelledRiderPhones: { $ne: phone },
    customerPhone: { $ne: phone },
    "responses.riderPhone": { $ne: phone }
  }).catch(() => 0);
}

async function toggleOnline(ctx, force = null) {
  const rider = await getRider(ctx.phone);
  if (!rider) return startBikerRegistration(ctx);
  const now = force === null ? rider.riderActive === false : !!force;
  const r = await updateRider({ _id: rider._id }, { $set: { riderActive: now, riderMissedPings: 0, riderLastSeenAt: new Date() } }) || { ...rider, riderActive: now };
  if (!now) {
    await ask(ctx.from, "⏸ *You're OFFLINE.* No job alerts until you go online again.\n\n_Tip: go offline when you're on a break - ignoring alerts lowers your ranking._",
      [{ id: "biker_toggle_online", title: "🟢 Go Online" }, { id: "biker_menu", title: "🏍️ Rider Menu" }]);
    return true;
  }
  if (!canTakeJobs(r)) return lockedJobPrompt(ctx, r);
  const open = await countOpenNear(r);
  if (open) { await say(ctx.from, `🟢 *You're ONLINE!* ${open} job${open === 1 ? "" : "s"} waiting near you 👇`); return sendOpenJobs(ctx, r); }
  await ask(ctx.from, "🟢 *You're ONLINE!* We'll alert you the moment a job comes in near you.",
    [{ id: "biker_menu", title: "🏍️ Rider Menu" }]);
  return true;
}

async function guardRider(ctx, { needActive = true, job = null } = {}) {
  const rider = await getRider(ctx.phone);
  if (!rider) {
    await ask(ctx.from, "🏍️ Only registered ZimQuote riders can take jobs.\n\nWant to earn with your bike?",
      [{ id: "reg_type_biker", title: "🏍️ Become a Rider" }, { id: "main_menu_back", title: "🏠 Menu" }]);
    return null;
  }
  if (rider.suspended) { await say(ctx.from, "⛔ Your rider account is suspended. Please contact ZimQuote support."); return null; }
  if (needActive && !canTakeJobs(rider)) { await lockedJobPrompt(ctx, rider, job ? [job] : null); return null; }
  return rider;
}

// A rider who can't take jobs yet (not paid / ID not approved) tries to view or
// answer a request: show a MASKED teaser of what's waiting + the one step to unlock it.
function jobTeaser(j) {
  return `📦 ${cut(j.task || "Delivery", 40)}\n📍 ${cut(j.pickup, 30)} → ${cut(j.dropoff, 30)}\n👤 Customer ${maskPhone(j.customerPhone)} · ${ago(j.openSince || j.createdAt)}`;
}
async function lockedJobPrompt(ctx, rider, jobs = null) {
  if (!jobs) {
    const group = metroGroup(rider.location?.city || "");
    jobs = group.length ? await BikerJob.find({
      status: "open", openSince: { $gte: new Date(Date.now() - BIKER_CONFIG.OPEN_JOB_WINDOW_MIN * 60000) },
      city: { $in: group.map(c => new RegExp(`^${escRe(c)}$`, "i")) }, customerPhone: { $ne: ctx.phone }
    }).sort({ openSince: -1 }).limit(3).lean().catch(() => []) : [];
  }
  jobs = (jobs || []).filter(Boolean).filter(j => j.status === "open");
  const teaser = jobs.length
    ? `🔔 *${plural(jobs.length, "delivery request")} waiting near you:*\n\n${jobs.map(jobTeaser).join("\n\n")}\n\n🔒 `
    : "";
  if (!rider.active) {
    await say(ctx.from, `${teaser}${teaser ? "Activate your rider account to see the full request, send your price and get the customer's number." : "⚠️ Activate your rider account to take jobs."}`);
    return sendActivate(ctx, rider);
  }
  const ks = kycStatus(rider);
  if (ks === "pending") {
    await ask(ctx.from, `${teaser}${teaser ? "" : "⏳ "}Your ID is being checked by ZimQuote - job alerts switch on as soon as it's approved. We'll message you here.`,
      [{ id: "biker_menu", title: "🏍️ Rider Menu" }]);
    return true;
  }
  await say(ctx.from, `${teaser}${teaser ? "" : "🪪 "}You're paid ✅ - now verify your ID to start getting jobs (takes 1 minute).`);
  return askIdPhoto(ctx, rider, false);
}

// The masked lead an unactivated rider was alerted about (admin activity / real views).
async function showLockedLead(ctx, rider, lead) {
  const what = lead.kind === "job"
    ? `🔔 *A customer needs a rider*${lead.route ? `\n📍 ${lead.route}` : ""}`
    : `👀 *Someone opened your rider profile*${lead.via ? ` (via ${lead.via})` : ""}`;
  await say(ctx.from, `${what}${lead.note ? `\n📝 ${lead.note}` : ""}${lead.masked ? `\n👤 ${lead.masked}` : ""}\n\n🔒 ${rider.active ? "Verify your ID" : "Activate your account"} to see their number and take the job.`);
  return rider.active ? lockedJobPrompt(ctx, rider, []) : sendActivate(ctx, rider);
}

async function sendOpenJobs(ctx, rider = null) {
  rider = rider || await getRider(ctx.phone);
  if (rider && !canTakeJobs(rider) && !rider.suspended) return lockedJobPrompt(ctx, rider);
  rider = rider && canTakeJobs(rider) ? rider : await guardRider(ctx);
  if (!rider) return true;
  const group = metroGroup(rider.location?.city || "");
  const jobs = await BikerJob.find({
    status: "open",
    openSince: { $gte: new Date(Date.now() - BIKER_CONFIG.OPEN_JOB_WINDOW_MIN * 60000) },
    city: { $in: group.map(c => new RegExp(`^${escRe(c)}$`, "i")) },
    cancelledRiderPhones: { $ne: ctx.phone },
    customerPhone: { $ne: ctx.phone },
    "responses.riderPhone": { $ne: ctx.phone }
  }).sort({ openSince: -1 }).limit(10).lean().catch(() => []);

  if (!jobs.length) {
    await ask(ctx.from, `🔔 *No open jobs right now* in ${rider.location?.city || "your city"}.\n\n${rider.riderActive !== false ? "You're ONLINE - we'll alert you when one comes in." : "⚪ You're OFFLINE - go online to get alerts."}`,
      [rider.riderActive !== false ? { id: "biker_menu", title: "🏍️ Rider Menu" } : { id: "biker_toggle_online", title: "🟢 Go Online" }]);
    return true;
  }
  await pick(ctx.from,
    `🔔 *Open jobs near you* (${jobs.length})\nNewest first. Tap one to send your price 👇`,
    jobs.map(j => ({
      id: `biker_accept_${j._id}`,
      title: `${cut(j.pickup, 10)}→${cut(j.dropoff, 10)}`,
      description: `${cut(j.task || "Delivery", 34)} · ${ago(j.openSince)} · ${(j.responses || []).length} price(s)`
    })));
  return true;
}

async function sendActiveJobs(ctx) {
  const jobs = await BikerJob.find({ assignedRiderPhone: ctx.phone, status: { $in: ["assigned", "picked_up", "delivered"] } })
    .sort({ assignedAt: -1 }).limit(10).lean().catch(() => []);
  if (!jobs.length) {
    await ask(ctx.from, "📋 *No active jobs.*\n\nTap *Open Jobs* to find one.", [{ id: "biker_openjobs", title: "🔔 Open Jobs" }, { id: "biker_menu", title: "🏍️ Rider Menu" }]);
    return true;
  }
  if (jobs.length === 1) return sendJobCard(ctx, String(jobs[0]._id), jobs[0]);
  await pick(ctx.from, `📋 *Your jobs* (${jobs.length})\nTap one to update it 👇`,
    jobs.map(j => ({
      id: `biker_job_${j._id}`,
      title: `${statusEmoji(j.status)} ${cut(j.dropoff, 20)}`,
      description: `${cut(j.pickup, 18)}→${cut(j.dropoff, 18)} · ${j.agreedFare || "-"} · ${jobRef(j)}`
    })));
  return true;
}

async function sendRiderStats(ctx) {
  const rider = await getRider(ctx.phone);
  if (!rider) return startBikerRegistration(ctx);
  const lvl = riderLevel(rider.riderPoints);
  const now = new Date();
  const weekStart = new Date(now); weekStart.setHours(0, 0, 0, 0);
  weekStart.setDate(weekStart.getDate() - ((weekStart.getDay() + 6) % 7)); // Monday
  const dayStart = new Date(now); dayStart.setHours(0, 0, 0, 0);

  const done = await BikerJob.find({ assignedRiderPhone: ctx.phone, status: "completed" }, { agreedFareAmount: 1, agreedFare: 1, completedAt: 1 }).lean().catch(() => []);
  const usd = j => (/zig/i.test(j.agreedFare || "") ? 0 : Number(j.agreedFareAmount) || 0);
  const sum = arr => arr.reduce((s, j) => s + usd(j), 0);
  const today = done.filter(j => j.completedAt && new Date(j.completedAt) >= dayStart);
  const week  = done.filter(j => j.completedAt && new Date(j.completedAt) >= weekStart);

  const group = metroGroup(rider.location?.city || "");
  const better = await SupplierProfile.countDocuments({
    profileType: "biker", active: true,
    "location.city": { $in: group.map(c => new RegExp(`^${escRe(c)}$`, "i")) },
    riderPoints: { $gt: Number(rider.riderPoints) || 0 }
  }).setOptions({ strictQuery: false }).catch(() => 0);

  await ask(ctx.from,
    `🏆 *Points & Earnings*\n\n` +
    `${lvl.emoji} *${lvl.name}* · ${rider.riderPoints || 0} points\n` +
    (lvl.next ? `➡️ ${lvl.toNext} more to ${lvl.next.emoji} ${lvl.next.name}\n` : `👑 Top level!\n`) +
    `📊 Rank #${better + 1} in ${rider.location?.city || "your city"}\n` +
    `⭐ ${(Number(rider.rating) || 0).toFixed(1)} rating (${rider.reviewCount || 0}) · ${plural(rider.completedTrips || 0, "trip")} · ${plural(rider.riderCancels || 0, "cancel")}\n\n` +
    `💵 *Earnings (USD jobs)*\nToday: $${sum(today).toFixed(2)} (${today.length})\nThis week: $${sum(week).toFixed(2)} (${week.length})\nAll time: $${sum(done).toFixed(2)} (${done.length})\n\n` +
    `*How to earn points*\n✅ Delivery confirmed +${RIDER_POINTS.complete}\n⚡ Price sent within ${BIKER_CONFIG.FAST_RESPONSE_MIN} min +${RIDER_POINTS.fast}\n⭐⭐⭐⭐⭐ rating +${RIDER_POINTS.rate5} · ⭐⭐⭐⭐ +${RIDER_POINTS.rate4}\n❌ You cancel a job ${RIDER_POINTS.cancel}\n\n_More points = shown first to customers._`,
    [{ id: "biker_openjobs", title: "🔔 Open Jobs" }, { id: "biker_menu", title: "🏍️ Rider Menu" }]);
  return true;
}

async function startAreasEdit(ctx) {
  const rider = await getRider(ctx.phone);
  if (!rider) return startBikerRegistration(ctx);
  await setState(ctx.phone, "biker_areas_set", {});
  await ask(ctx.from,
    `📍 *Your areas:* ${(rider.riderAreas || []).length ? rider.riderAreas.join(", ") : "Whole city"}\n\nType your new areas with commas:\n_e.g. CBD, Avondale, Mbare_\n\nJobs from your areas reach you first. Or tap *Whole city*.`,
    [{ id: "biker_areas_whole", title: "🌍 Whole city" }, { id: "biker_menu", title: "🏍️ Rider Menu" }]);
  return true;
}
async function areasWhole(ctx) {
  if (ctx.sess.state === "biker_reg_areas") return regAreas(ctx, "__whole__");
  return saveAreas(ctx, "__whole__");
}
async function saveAreas(ctx, raw) {
  const rider = await getRider(ctx.phone);
  if (!rider) { await clearState(ctx.phone); return startBikerRegistration(ctx); }
  const list = raw === "__whole__" ? [] : String(raw || "").split(/[,\n;]+/).map(s => s.trim()).filter(Boolean).slice(0, 12);
  await updateRider({ _id: rider._id }, { $set: { riderAreas: list, "location.area": list[0] || rider.location?.city || "" } });
  await clearState(ctx.phone);
  await ask(ctx.from, `✅ Areas saved: *${list.length ? list.join(", ") : "Whole city"}*`, [{ id: "biker_menu", title: "🏍️ Rider Menu" }]);
  return true;
}

async function startPhoto(ctx) {
  const rider = await getRider(ctx.phone);
  if (!rider) return startBikerRegistration(ctx);
  if (isRiderVerified(rider)) { await ask(ctx.from, "🪪 Your ID is already verified ✅", [{ id: "biker_menu", title: "🏍️ Rider Menu" }]); return true; }
  if (kycStatus(rider) === "pending" && rider.riderKyc?.idPhotoUrl) {
    await ask(ctx.from, "⏳ Your ID is being checked by the ZimQuote team. We'll message you here when it's approved.\n\nSent the wrong photo? Tap *Send again*.",
      [{ id: "biker_photo_again", title: "📸 Send again" }, { id: "biker_menu", title: "🏍️ Rider Menu" }]);
    return true;
  }
  return askIdPhoto(ctx, rider, false);
}
// Back-compat export (older engine image handler may call this).
export async function _regPhoto({ from, imageUrl = null }) {
  if (!imageUrl) return false;
  const phone = normPhone(from);
  return saveKycPhoto({ from, phone, sess: { state: "biker_kyc_selfie", data: {} } }, imageUrl);
}

export function riderLink(riderId) {
  return `https://wa.me/${BOT_NUMBER}?text=${encodeURIComponent("ZQ:RIDER:" + riderId)}`;
}
async function sendRiderLink(ctx) {
  const rider = await getRider(ctx.phone);
  if (!rider) return startBikerRegistration(ctx);
  await say(ctx.from,
    `🔗 *Your Rider Link*\n\nShare this on your WhatsApp Status, groups and with regular customers. When they tap it, the job comes *straight to you first*:\n\n${riderLink(rider._id)}`);
  await say(ctx.from,
    `🏍️ Need something delivered? Book me on WhatsApp - fast, safe, fair price.\n${riderName(rider)} · ${rider.bike?.plate || ""}\n👉 ${riderLink(rider._id)}`);
  await ask(ctx.from, "☝️ Forward the message above to your contacts or post it on your Status.", [{ id: "biker_menu", title: "🏍️ Rider Menu" }]);
  return true;
}
async function sendRiderHelp(ctx) {
  await ask(ctx.from,
    `❓ *How ZimQuote Bikers works*\n\n` +
    `1️⃣ Stay *ONLINE* → job alerts come to you\n` +
    `2️⃣ Tap *I'll do it* → tap your price → tap ETA (3 taps)\n` +
    `3️⃣ Customer picks you → you get their number. *Call them* to confirm the address\n` +
    `4️⃣ Tap *Picked up* → then *Delivered*\n` +
    `5️⃣ Customer confirms → you earn points ⭐\n\n` +
    `💵 *Pricing tips (USD):* $2-$4 nearby · $5-$8 across town · $10+ far/heavy. Customers pay you directly - cash or EcoCash on delivery.\n\n` +
    `🛡 *Safety:* never pay for goods with your own money unless agreed. Take a photo of the parcel at pickup. Don't carry illegal items.\n\n` +
    `⌨️ *Shortcuts:* type *online*, *offline*, *jobs*, *points* or *menu* any time.`,
    [{ id: "biker_openjobs", title: "🔔 Open Jobs" }, { id: "biker_menu", title: "🏍️ Rider Menu" }]);
  return true;
}
async function sendZqMenu(ctx) {
  try {
    const mm = await import("./metaMenus.js");
    const realBiz = ctx.biz && ctx.biz.name && !String(ctx.biz.name).startsWith("pending_") && !String(ctx.biz.name).endsWith("(Rider)");
    if (realBiz && typeof mm.sendBusinessHomeMenu === "function") return mm.sendBusinessHomeMenu(ctx.from, ctx.biz, { isOwner: true }), true;
    if (typeof mm.sendMarketplaceMenu === "function") { await mm.sendMarketplaceMenu(ctx.from, ctx.biz, { isOwner: false }); return true; }
  } catch (e) { console.warn("[BIKER] zq menu failed:", e.message); }
  return false;
}

// ═════════════════════════════════════════════════════════════════════════════
// CUSTOMER: REQUEST A BIKER
// ═════════════════════════════════════════════════════════════════════════════
export async function startRiderRequest(ctx, { preferredRider = null, prefill = null } = {}) {
  ctx = await _ctx(ctx);
  const live = await BikerJob.find({ customerPhone: ctx.phone, status: { $in: LIVE_STATUSES } }, { status: 1 }).lean().catch(() => []);
  const openCount = live.filter(j => j.status === "open").length;
  if (openCount >= BIKER_CONFIG.MAX_OPEN_PER_CUSTOMER) {
    await ask(ctx.from, `⚠️ You already have *${openCount}* open requests. Please wait for riders or cancel one first.`,
      [{ id: "biker_mydel", title: `📦 My Deliveries` }, { id: "main_menu_back", title: "🏠 Menu" }]);
    return true;
  }
  await clearCompetingFlows(ctx.phone);
  await setState(ctx.phone, "biker_req_what", { req: { preferredRiderId: preferredRider ? String(preferredRider._id) : null, ...(prefill || {}) } });

  const head = preferredRider
    ? `🏍️ *Book ${publicName(preferredRider)}*\n${riderBadgeLine(preferredRider)}\n\n`
    : `🏍️ *Request a Biker*\n\n`;
  const body = head +
    `Send *what* + *from → to* in ONE message:\n\n` +
    `📝 _Collect documents, CBD to Avondale_\n` +
    `📝 _Buy 2 loaves, Mbare to Highfield_\n` +
    `📝 _Parcel from Joina City to Borrowdale_\n\n` +
    `💡 Include the suburb. ${preferredRider ? "The rider will send you a price." : "Riders send you prices - you choose."}`;
  if (live.length) await ask(ctx.from, body, [{ id: "biker_mydel", title: `📦 My Deliveries (${live.length})` }]);
  else await say(ctx.from, body);
  return true;
}

async function reqWhat(ctx, raw) {
  const s = String(raw || "").trim();
  if (s.length < 3) {
    await say(ctx.from, "Please tell us *what* and *from → to* in one message.\n_e.g. Collect documents, CBD to Avondale_");
    return true;
  }
  const { task, pickup, dropoff } = parseWhatWhere(s);
  const req = { ...(ctx.sess.data.req || {}), task: task || "Delivery", pickup, dropoff, raw: s.slice(0, 300) };
  if (pickup && dropoff) return resolveCityAndCreate(ctx, req);
  await setState(ctx.phone, "biker_req_route", { req });
  await say(ctx.from, `📦 *${cut(req.task, 60)}*\n\n📍 From where → to where? (one line)\n_e.g. CBD to Avondale_`);
  return true;
}
async function reqRoute(ctx, raw) {
  let { pickup, dropoff } = splitRoute(raw);
  if (!pickup || !dropoff) { const p = parseWhatWhere(raw); pickup = p.pickup; dropoff = p.dropoff; }
  if (!pickup || !dropoff) {
    await say(ctx.from, "Please send it as *from → to*.\n_e.g. Mbare to Highfield_");
    return true;
  }
  return resolveCityAndCreate(ctx, { ...(ctx.sess.data.req || {}), pickup, dropoff });
}
async function resolveCityAndCreate(ctx, req) {
  const det = detectCity(`${req.pickup} | ${req.dropoff} | ${req.task} | ${req.raw || ""}`, ctx.sess.lastCity);
  let city = det.city ? titleCity(det.city) : "";
  if (!city && req.preferredRiderId) {
    const pr = await SupplierProfile.findById(req.preferredRiderId).lean().catch(() => null);
    city = pr?.location?.city || "";
  }
  // Nothing recognisable at all ("CBD to town")? Use the customer's last city
  // (set by previous trips or a city share link). The confirmation shows the city.
  if (!city && !(det.options || []).length && ctx.sess.lastCity) city = titleCity(ctx.sess.lastCity);
  if (city) return createAndDispatchJob(ctx, { ...req, city });

  // Couldn't tell - ask once. Likely towns first, then the rest.
  await setState(ctx.phone, "biker_req_city", { req });
  const order = [...new Set([...(det.options || []), ctx.sess.lastCity, ...CITY_ROWS].filter(Boolean).map(titleCity))].slice(0, 10);
  await pick(ctx.from,
    `📍 *${cut(req.pickup, 40)} → ${cut(req.dropoff, 40)}*\n\nWhich city? (tap, or type it)`,
    order.map(c => ({ id: `biker_reqcity_${c.toLowerCase()}`, title: c })));
  return true;
}
async function reqCityPicked(ctx, raw) {
  if (ctx.sess.state !== "biker_req_city" || !ctx.sess.data.req?.pickup) {
    await say(ctx.from, "⌛ That request timed out - let's start again.");
    return startRiderRequest(ctx);
  }
  const det = detectCity(raw);
  const c = titleCity(det.city || raw);
  if (!c || c.length < 3) { await say(ctx.from, "Please tap or type the city, e.g. *Harare*."); return true; }
  return createAndDispatchJob(ctx, { ...ctx.sess.data.req, city: c });
}

async function createAndDispatchJob(ctx, req, { source = "whatsapp", adminName = "", silent = false, noDispatch = false } = {}) {
  const phone = ctx.phone;
  const city = titleCity(req.city || "Harare");
  let job;
  try {
    job = new BikerJob({
      source, createdByAdmin: adminName,
      customerPhone: phone, customerName: req.customerName || "",
      task: (req.task || "Delivery").slice(0, 200),
      city, pickup: tidyPlace(req.pickup).slice(0, 120), dropoff: tidyPlace(req.dropoff).slice(0, 120),
      when: req.when || "Now", status: "open", openSince: new Date(),
      preferredRiderId: isObjId(req.preferredRiderId) ? req.preferredRiderId : null,
      history: [{ by: source === "admin" ? "admin" : "customer", phone, event: "created", note: adminName ? `by ${adminName}` : "" }]
    });
    job.reference = jobRef(job);
    await job.save();
  } catch (err) {
    console.error("[BIKER JOB] create failed:", err.message);
    if (!silent) await say(ctx.from, "❌ Could not create your request. Please try again, or type *menu*.");
    await clearState(phone);
    return silent ? null : true;
  }
  await clearState(phone);
  await setLastCity(phone, city);

  const notified = noDispatch ? 0 : await dispatchJob(job);
  const ref = jobRef(job);
  if (silent) return job;

  if (!notified) {
    await ask(ctx.from,
      `🔎 *Request saved* (${ref})\n📦 ${job.task}\n📍 ${job.pickup} → ${job.dropoff}\n🏙 ${city}\n\n` +
      `No riders are online in ${city} right now. Your request stays open for ${BIKER_CONFIG.EXPIRE_NO_OFFER_MIN} min - riders coming online will see it, and prices will arrive here.`,
      [{ id: `biker_cx_${job._id}`, title: "❌ Cancel request" }, { id: "main_menu_back", title: "🏠 Menu" }]);
    return true;
  }
  await ask(ctx.from,
    `✅ *Request sent!* (${ref})\n📦 ${job.task}\n📍 ${job.pickup} → ${job.dropoff}\n🏙 ${city}\n\n` +
    (job.preferredRiderId
      ? `We've sent it to your rider. If they don't respond in ${BIKER_CONFIG.PREFERRED_EXPAND_MIN} min we'll alert other riders.`
      : `We alerted *${notified}* rider${notified === 1 ? "" : "s"} nearby. Their prices will arrive here - tap *Choose* on the one you like.`) +
    `\n\n💡 Typical fares: $2-$4 nearby, $5-$8 across town.`,
    [{ id: `biker_cx_${job._id}`, title: "❌ Cancel request" }, { id: "biker_mydel", title: "📦 My Deliveries" }]);
  return true;
}

// ═════════════════════════════════════════════════════════════════════════════
// MATCHING + RIDER ALERTS
// ═════════════════════════════════════════════════════════════════════════════
async function findRiders({ city, pickup = "", exclude = [], limit = BIKER_CONFIG.MAX_RIDERS_PER_JOB }) {
  const group = metroGroup(city);
  if (!group.length) return [];
  const all = await SupplierProfile.find({
    profileType: "biker", active: true, suspended: { $ne: true }, riderActive: { $ne: false },
    "location.city": { $in: group.map(c => new RegExp(`^${escRe(c)}$`, "i")) }
  }).setOptions({ strictQuery: false }).limit(500).lean().catch(() => []);
  const ex = new Set(exclude.map(normPhone));
  const pool = all.filter(r => r.phone && !ex.has(normPhone(r.phone)) && canTakeJobs(r));
  if (!pool.length) return [];

  // Riders already carrying MAX_ACTIVE_JOBS are skipped.
  const busy = await BikerJob.aggregate([
    { $match: { status: { $in: ACTIVE_STATUSES }, assignedRiderPhone: { $in: pool.map(r => normPhone(r.phone)) } } },
    { $group: { _id: "$assignedRiderPhone", n: { $sum: 1 } } }
  ]).catch(() => []);
  const busyMap = new Map(busy.map(b => [b._id, b.n]));

  const pickL = String(pickup || "").toLowerCase();
  return pool
    .filter(r => (busyMap.get(normPhone(r.phone)) || 0) < BIKER_CONFIG.MAX_ACTIVE_JOBS)
    .map(r => {
      const areas = (r.riderAreas || []).map(x => String(x).toLowerCase()).filter(Boolean);
      const areaMatch = pickL && areas.some(ar => pickL.includes(ar) || ar.includes(pickL));
      const score =
        (areaMatch ? 500 : areas.length ? 0 : 150) +          // "whole city" riders sit between
        (r.bike?.verifiedAt ? 100 : 0) +
        Math.min(Number(r.riderPoints) || 0, 1000) * 0.2 +
        (Number(r.rating) || 0) * 20 -
        (Number(r.riderMissedPings) || 0) * 10 +
        Math.random() * 120;                                    // fair rotation between similar riders
      return { r, score };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(s => s.r);
}

// Alert riders about a job. Returns how many were alerted.
async function dispatchJob(job, { expand = false } = {}) {
  const exclude = [job.customerPhone, ...(job.notifiedRiderPhones || []), ...(job.cancelledRiderPhones || []), ...(job.busyRiderPhones || [])];
  let riders = [];
  if (job.preferredRiderId && !expand) {
    const pr = await SupplierProfile.findById(job.preferredRiderId).lean().catch(() => null);
    if (pr && canTakeJobs(pr) && !exclude.map(normPhone).includes(normPhone(pr.phone)) &&
        (await activeJobCount(pr.phone)) < BIKER_CONFIG.MAX_ACTIVE_JOBS) riders = [pr];
  }
  if (!riders.length) riders = await findRiders({ city: job.city, pickup: job.pickup, exclude });
  if (!riders.length) return 0;

  const phones = riders.map(r => normPhone(r.phone));
  await BikerJob.updateOne({ _id: job._id }, { $addToSet: { notifiedRiderPhones: { $each: phones } }, $set: { lastNotifiedAt: new Date() } }).catch(() => {});
  await Promise.allSettled(riders.map(r => notifyRiderNewJob(r, job)));

  // Missed-ping counter: riders who keep ignoring alerts are paused automatically.
  await SupplierProfile.updateMany({ _id: { $in: riders.map(r => r._id) } }, { $inc: { riderMissedPings: 1 } }, { strict: false }).catch(() => {});
  const toPause = riders.filter(r => (Number(r.riderMissedPings) || 0) + 1 >= BIKER_CONFIG.MISSED_PINGS_OFFLINE);
  for (const r of toPause) {
    await updateRider({ _id: r._id }, { $set: { riderActive: false, riderMissedPings: 0 } });
    await ask(r.phone, `⏸ *We paused your job alerts* - you missed ${BIKER_CONFIG.MISSED_PINGS_OFFLINE} jobs in a row.\n\nTap *Go Online* when you're ready to ride again.`,
      [{ id: "biker_toggle_online", title: "🟢 Go Online" }]);
  }
  return riders.length;
}

async function notifyRiderNewJob(rider, job) {
  const phone = normPhone(rider.phone);
  const id = String(job._id);
  const ref = jobRef(job);
  const preferred = job.preferredRiderId && String(job.preferredRiderId) === String(rider._id);
  // Template first: riders are often outside the 24h window when a job appears.
  try {
    await sendJobTemplate(phone, [job.task || "Delivery", `${job.pickup} → ${job.dropoff}`, job.when || "Now", ref], id);
    return;
  } catch (err) {
    console.warn(`[BIKER] zq_rider_new_job → ${phone} failed: ${err?.response?.data?.error?.message || err.message}. Using buttons.`);
  }
  await ask(phone,
    `🏍️ *${preferred ? "A customer booked YOU!" : "New job near you!"}* (${ref})\n\n📦 ${job.task}\n📍 ${job.pickup} → ${job.dropoff}\n🏙 ${job.city}\n🕒 ${job.when || "Now"}\n\nTap *I'll do it* to send your price.`,
    [{ id: `biker_accept_${id}`, title: "✅ I'll do it" }, { id: `biker_busy_${id}`, title: "❌ Busy" }]);
}

// Template zq_rider_new_job: {{1}} task {{2}} route {{3}} when {{4}} ref, 2 quick replies.
async function sendJobTemplate(to, variables, jobId) {
  const components = [
    { type: "body", parameters: variables.map(v => ({ type: "text", text: String(v || "-").replace(/[\n\t]+/g, " ").slice(0, 900) })) },
    { type: "button", sub_type: "quick_reply", index: "0", parameters: [{ type: "payload", payload: `biker_accept_${jobId}` }] },
    { type: "button", sub_type: "quick_reply", index: "1", parameters: [{ type: "payload", payload: `biker_busy_${jobId}` }] }
  ];
  const res = await axios.post(
    `https://graph.facebook.com/${GRAPH_API_VERSION}/${PHONE_NUMBER_ID}/messages`,
    { messaging_product: "whatsapp", to: normPhone(to), type: "template", template: { name: "zq_rider_new_job", language: { code: "en" }, components } },
    { headers: { Authorization: `Bearer ${ACCESS_TOKEN}`, "Content-Type": "application/json" }, timeout: 15000 }
  );
  return res.data;
}

// ═════════════════════════════════════════════════════════════════════════════
// RIDER: ACCEPT → PRICE → ETA
// ═════════════════════════════════════════════════════════════════════════════
async function getJob(id) {
  if (!isObjId(id)) return null;
  return BikerJob.findById(id).lean().catch(() => null);
}

async function riderAccept(ctx, jobId) {
  const rider = await guardRider(ctx, { job: await getJob(jobId) });
  if (!rider) return true;
  await updateRider({ _id: rider._id }, { $set: { riderMissedPings: 0, riderLastSeenAt: new Date() } });
  const job = await getJob(jobId);
  if (!job || job.status !== "open") {
    await ask(ctx.from, `⌛ ${job ? jobRef(job) + " was already taken or closed." : "That job is no longer available."}`,
      [{ id: "biker_openjobs", title: "🔔 Other open jobs" }, { id: "biker_menu", title: "🏍️ Rider Menu" }]);
    return true;
  }
  if (normPhone(job.customerPhone) === ctx.phone) { await say(ctx.from, "ℹ️ That's your own request."); return true; }
  if ((job.cancelledRiderPhones || []).includes(ctx.phone)) { await say(ctx.from, "ℹ️ You dropped this job earlier, so it went to other riders."); return true; }
  if ((await activeJobCount(ctx.phone)) >= BIKER_CONFIG.MAX_ACTIVE_JOBS) {
    await ask(ctx.from, `🚦 You already have ${BIKER_CONFIG.MAX_ACTIVE_JOBS} active jobs. Finish one first, then take more.`,
      [{ id: "biker_active", title: "📋 My Jobs" }]);
    return true;
  }
  const mine = (job.responses || []).find(r => normPhone(r.riderPhone) === ctx.phone);
  await setState(ctx.phone, `biker_fare_${job._id}`, {});
  await pick(ctx.from,
    `💵 *Your price for ${jobRef(job)}?*\n📦 ${job.task}\n📍 ${job.pickup} → ${job.dropoff}\n` +
    `${mine ? `\n_You offered ${mine.fare} - pick again to change it._\n` : ""}` +
    `\nTap a price 👇 or *type* it with your ETA, e.g. _4, 15 min_ or _ZiG 100_`,
    [...FARE_CHOICES.map(n => ({ id: `biker_fare_${job._id}_${n}`, title: `$${n}`, description: n <= 4 ? "Short trip" : n <= 8 ? "Across town" : "Far / heavy" })),
     { id: `biker_fare_${job._id}_x`, title: "✍️ Other amount", description: "Type your own price (USD or ZiG)" }]);
  return true;
}

async function riderBusy(ctx, jobId) {
  if (isObjId(jobId)) await BikerJob.updateOne({ _id: jobId }, { $addToSet: { busyRiderPhones: ctx.phone } }).catch(() => {});
  await updateRider({ phone: { $in: phoneVariants(ctx.phone) }, profileType: "biker" }, { $set: { riderMissedPings: 0, riderLastSeenAt: new Date() } });
  await ask(ctx.from, "👌 No problem - we'll send you the next one.\n\n_On a break? Go offline so customers get faster replies._",
    [{ id: "biker_toggle_online", title: "⏸ Go Offline" }, { id: "biker_openjobs", title: "🔔 Other jobs" }]);
  return true;
}

async function riderFareTap(ctx, jobId, amt) {
  if (!isObjId(jobId)) return false;
  if (amt === "x") {
    await setState(ctx.phone, `biker_fare_${jobId}`, {});
    await say(ctx.from, "✍️ Type your price (and ETA if you like):\n_e.g. 4, 15 min_  ·  _ZiG 100, 30 min_");
    return true;
  }
  const n = Number(amt);
  if (!(n > 0)) return false;
  return askEta(ctx, jobId, String(n), `$${n}`);
}
async function askEta(ctx, jobId, amtToken, fareLabel) {
  const job = await getJob(jobId);
  if (!job || job.status !== "open") { await say(ctx.from, "⌛ That job is no longer open."); return true; }
  await ask(ctx.from, `⏱ *How soon can you pick it up?*\n${jobRef(job)} · ${fareLabel}`, [
    { id: `biker_eta_${jobId}_${amtToken}_10`, title: "⚡ 10 min" },
    { id: `biker_eta_${jobId}_${amtToken}_20`, title: "🕐 20 min" },
    { id: `biker_eta_${jobId}_${amtToken}_40`, title: "🕑 30-45 min" }
  ]);
  return true;
}
async function riderEtaTap(ctx, jobId, amtToken, min) {
  if (!isObjId(jobId)) return false;
  let fare, amount;
  if (amtToken === "d") {                 // typed fare stored as draft (loaded before the tap cleared state)
    const d = ctx.sess.data?.fareDraft;
    if (!d || d.jobId !== jobId) {
      await say(ctx.from, "⌛ Please send your price again.");
      return riderAccept(ctx, jobId);
    }
    fare = d.fare; amount = d.amount;
  } else {
    amount = Number(amtToken); fare = `$${amount}`;
  }
  const eta = min === "40" ? "30-45 min" : `${Number(min) || 20} min`;
  return submitOffer(ctx, jobId, fare, amount, eta);
}
async function riderFareTyped(ctx, jobId, input) {
  const f = parseFare(input);
  if (!f.ok) { await say(ctx.from, "Please type a price, e.g. *3* or *$5, 15 min* or *ZiG 100*."); return true; }
  if (f.eta) { await clearState(ctx.phone); return submitOffer(ctx, jobId, f.fare, f.amount, f.eta); }
  await setState(ctx.phone, `biker_fare_${jobId}`, { fareDraft: { jobId, fare: f.fare, amount: f.amount } });
  return askEta(ctx, jobId, "d", f.fare);
}

async function submitOffer(ctx, jobId, fare, amount, eta) {
  const rider = await guardRider(ctx);
  if (!rider) return true;
  const job = await getJob(jobId);
  if (!job || job.status !== "open") {
    await ask(ctx.from, "⌛ Too late - that job was taken or closed.", [{ id: "biker_openjobs", title: "🔔 Other open jobs" }]);
    return true;
  }
  const resp = {
    riderId: rider._id, riderPhone: ctx.phone, riderName: publicName(rider), plate: rider.bike?.plate || "",
    fare, fareAmount: Number(amount) || null, eta,
    verified: isRiderVerified(rider), rating: Number(rider.rating) || 0,
    points: Number(rider.riderPoints) || 0, trips: Number(rider.completedTrips) || 0,
    respondedAt: new Date()
  };
  // Update an existing offer, or push a new one - only while the job is open.
  let r = await BikerJob.updateOne({ _id: job._id, status: "open", "responses.riderPhone": ctx.phone }, { $set: { "responses.$": resp } });
  let updatedExisting = r.modifiedCount > 0 || r.nModified > 0;
  if (!updatedExisting) {
    r = await BikerJob.updateOne(
      { _id: job._id, status: "open", "responses.riderPhone": { $ne: ctx.phone }, cancelledRiderPhones: { $ne: ctx.phone } },
      { $push: { responses: resp, history: { by: "rider", phone: ctx.phone, event: "offer", note: `${fare} · ${eta}` } } });
    if (!(r.modifiedCount > 0 || r.nModified > 0)) {
      await ask(ctx.from, "⌛ Too late - that job was taken or closed.", [{ id: "biker_openjobs", title: "🔔 Other open jobs" }]);
      return true;
    }
  }
  await clearState(ctx.phone);
  await ask(ctx.from,
    `✅ *Price sent!* ${jobRef(job)} · ${fare} · ⏱ ${eta}\n\nIf the customer picks you, we'll send their number here right away.`,
    [{ id: "biker_openjobs", title: "🔔 More jobs" }, { id: "biker_menu", title: "🏍️ Rider Menu" }]);

  const fresh = await getJob(jobId);
  await notifyCustomerOffer(fresh || job, resp, updatedExisting);
  return true;
}

// ── Customer side of offers (burst-safe) ─────────────────────────────────────
const _offerBurst = new Map(); // jobId → { last, timer }
async function notifyCustomerOffer(job, resp, isUpdate) {
  const id = String(job._id);
  const n = (job.responses || []).length;
  const st = _offerBurst.get(id) || { last: 0, timer: null };
  const since = Date.now() - st.last;
  if (since < BIKER_CONFIG.OFFER_BURST_SEC * 1000) {
    // Many riders answering at once: send ONE combined list shortly, not N messages.
    if (!st.timer) {
      st.timer = setTimeout(async () => {
        st.timer = null; st.last = Date.now();
        try {
          const j = await getJob(id);
          if (j && j.status === "open") await sendOffers({ from: j.customerPhone, phone: normPhone(j.customerPhone), sess: { state: "" } }, id, j, true);
        } catch (e) { console.warn("[BIKER] burst offers failed:", e.message); }
      }, BIKER_CONFIG.OFFER_BURST_SEC * 1000 - since);
      if (st.timer.unref) st.timer.unref();
    }
    _offerBurst.set(id, st);
    return;
  }
  st.last = Date.now();
  _offerBurst.set(id, st);
  if (_offerBurst.size > 5000) _offerBurst.clear();

  const lvl = riderLevel(resp.points);
  const buttons = [
    { id: `biker_choose_${id}__${resp.riderPhone}`, title: `✅ Choose ${firstName(resp.riderName)}` },
    n > 1 ? { id: `biker_offers_${id}`, title: `📋 All prices (${n})` } : null,
    { id: `biker_cx_${id}`, title: "❌ Cancel" }
  ];
  await notifyParty(job.customerPhone, {
    ref: jobRef(job), line: `${resp.riderName} offered ${resp.fare}, ETA ${resp.eta}. Reply to this message to choose.`,
    text:
      `🏍️ *${isUpdate ? "Updated price" : "New price"} for your delivery* (${jobRef(job)})\n\n` +
      `👤 *${resp.riderName}*${resp.verified ? " · 🪪 ID verified" : ""} · ${lvl.emoji} ${lvl.name}\n` +
      `⭐ ${resp.rating ? resp.rating.toFixed(1) : "New"} · ${plural(resp.trips || 0, "trip")}\n` +
      `💵 *${resp.fare}* · ⏱ ${resp.eta}\n\n` +
      (n > 1 ? `You have *${n}* prices - tap *All prices* to compare.` : `More prices may come - choose now or wait a bit.`),
    buttons: buttons.filter(Boolean)
  });
}

async function sendOffers(ctx, jobId, job = null, fromBurst = false) {
  job = job || await getJob(jobId);
  if (!job || normPhone(job.customerPhone) !== ctx.phone) { await say(ctx.from, "That request was not found."); return true; }
  if (job.status !== "open") return sendJobCard(ctx, String(job._id), job);
  const offers = [...(job.responses || [])].sort((a, b) =>
    (a.fareAmount ?? 9999) - (b.fareAmount ?? 9999) || (b.rating || 0) - (a.rating || 0));
  if (!offers.length) {
    await ask(ctx.from, `⏳ No prices yet for ${jobRef(job)}. Riders have been alerted - prices will arrive here.`,
      [{ id: `biker_cx_${job._id}`, title: "❌ Cancel request" }]);
    return true;
  }
  await pick(ctx.from,
    `📋 *${fromBurst ? "Prices are coming in" : "Prices"} for ${jobRef(job)}* (${offers.length})\n📍 ${job.pickup} → ${job.dropoff}\n\nCheapest first. Tap a rider to choose 👇`,
    offers.slice(0, 10).map(o => ({
      id: `biker_choose_${job._id}__${normPhone(o.riderPhone)}`,
      title: `${o.fare} · ${firstName(o.riderName)}`,
      description: `⏱ ${o.eta || "-"} · ⭐${o.rating ? o.rating.toFixed(1) : "new"} · ${o.trips || 0} trips · ${riderLevel(o.points).emoji}${o.verified ? " · 🪪" : ""}`
    })));
  return true;
}

// ═════════════════════════════════════════════════════════════════════════════
// CUSTOMER CHOOSES A RIDER  (atomic - no double booking)
// ═════════════════════════════════════════════════════════════════════════════
async function customerChoose(ctx, payload) {
  const [jobId, riderPhoneRaw] = String(payload || "").split("__");
  const rPhone = normPhone(riderPhoneRaw);
  const job = await getJob(jobId);
  if (!job || normPhone(job.customerPhone) !== ctx.phone) { await say(ctx.from, "That request was not found."); return true; }
  if (job.status !== "open") {
    if (normPhone(job.assignedRiderPhone) === rPhone) return sendJobCard(ctx, jobId, job);
    await say(ctx.from, job.status === "cancelled" || job.status === "expired"
      ? `ℹ️ ${jobRef(job)} is ${job.status}.` : `ℹ️ You already chose a rider for ${jobRef(job)}.`);
    return sendJobCard(ctx, jobId, job);
  }
  const resp = (job.responses || []).find(r => normPhone(r.riderPhone) === rPhone);
  if (!resp) { await say(ctx.from, "⚠️ That rider withdrew their price."); return sendOffers(ctx, jobId, job); }
  if ((await activeJobCount(rPhone)) >= BIKER_CONFIG.MAX_ACTIVE_JOBS) {
    await say(ctx.from, `⚠️ ${resp.riderName} just became fully booked. Please choose another rider.`);
    return sendOffers(ctx, jobId, job);
  }
  return assignRider(job, resp, { by: "customer", customerCtx: ctx });
}

// Shared by customer choice + admin assignment.
async function assignRider(job, resp, { by = "customer", customerCtx = null, adminName = "" } = {}) {
  const rPhone = normPhone(resp.riderPhone);
  const rider = await getRider(rPhone);
  const plate = rider?.bike?.plate || resp.plate || "";
  const code = String(1000 + Math.floor(Math.random() * 9000));   // handover code for the receiver
  const updated = await BikerJob.findOneAndUpdate(
    { _id: job._id, status: "open" },
    { $set: {
        status: "assigned", assignedRiderId: rider?._id || resp.riderId || null, assignedRiderPhone: rPhone,
        assignedRiderName: resp.riderName || publicName(rider), agreedFare: resp.fare || "", agreedFareAmount: resp.fareAmount ?? null,
        agreedEta: resp.eta || "", assignedAt: new Date(),
        assignedRiderFirstName: rider ? legalFirst(rider) : firstName(resp.riderName), assignedPlate: plate,
        handoverCode: code, codeVerified: false, codeAttempts: 0
      },
      $push: { history: { by, phone: by === "customer" ? normPhone(job.customerPhone) : "", event: "assigned", note: `${resp.riderName} ${resp.fare || ""}${adminName ? " · " + adminName : ""}` } } },
    { new: true }
  ).lean();
  if (!updated) {
    if (customerCtx) await say(customerCtx.from, "ℹ️ This request was just updated - here's the latest.");
    if (customerCtx) return sendJobCard(customerCtx, String(job._id));
    return null;
  }
  const ref = jobRef(updated);
  const id = String(updated._id);

  // Customer
  await notifyParty(updated.customerPhone, {
    ref, line: `Rider ${updated.assignedRiderFirstName}, plate ${plate || "-"}, ${updated.agreedFare}. Handover code ${code}. Call ${displayPhone(rPhone)}.`,
    text:
      `✅ *Rider booked!* (${ref})\n\n` +
      `👤 *${updated.assignedRiderFirstName}*${updated.assignedRiderName && updated.assignedRiderName !== updated.assignedRiderFirstName ? ` ("${updated.assignedRiderName}")` : ""}${isRiderVerified(rider) ? " · 🪪 ID verified" : ""}\n` +
      `🏍️ Plate: *${plate || "-"}*\n` +
      `💵 ${updated.agreedFare || "Agree on pickup"}${updated.agreedEta ? ` · ⏱ ${updated.agreedEta}` : ""}\n` +
      `📞 *${displayPhone(rPhone)}*\n\n` +
      `🔐 *Handover code: ${code}*\nGive it ONLY to the person receiving the item - the rider types it at drop-off to prove delivery. Never share it before the item arrives.\n\n` +
      `👉 Call the rider to share the exact address.\n🛡 Check the plate matches before you hand anything over. Pay on delivery.`,
    buttons: [
      { id: `biker_rcv_${id}`, title: "✅ I received it" },
      { id: `biker_cx_${id}`,  title: "❌ Cancel" },
      { id: "biker_mydel",     title: "📦 My Deliveries" }
    ]
  });

  // Rider (interactive first - they just responded; template fallback)
  const riderText =
    `🎉 *You got the job!* (${ref})\n\n📦 ${updated.task}\n📍 ${updated.pickup} → ${updated.dropoff}\n🏙 ${updated.city}\n` +
    `💵 ${updated.agreedFare || "Agree with customer"}\n📞 Customer: *${displayPhone(updated.customerPhone)}*` +
    (updated.customerName ? ` (${updated.customerName})` : "") +
    `\n\n👉 Call the customer now to confirm the exact address. Tap *Picked up* when you collect.\n🔐 At drop-off, ask the receiver for the *4-digit handover code* - you'll type it when you tap *Delivered*.`;
  const okRider = await ask(rPhone, riderText, [
    { id: `biker_pick_${id}`, title: "📦 Picked up" },
    { id: `biker_done_${id}`, title: "✅ Delivered" },
    { id: `biker_cx_${id}`,   title: "❌ Cancel job" }
  ]);
  if (!okRider) {
    await _sendTemplate(rPhone, "zq_rider_matched", [
      updated.assignedRiderName || "Rider", resp.plate || "-", updated.agreedFare || "-", updated.agreedEta || "-", displayPhone(updated.customerPhone)
    ]).catch(e => console.warn(`[BIKER] zq_rider_matched → ${rPhone} failed: ${e.message}`));
  }
  await updateRider({ phone: { $in: phoneVariants(rPhone) }, profileType: "biker" }, { $set: { riderMissedPings: 0 } });

  // Other riders who sent prices: let them know (courtesy, keeps them engaged)
  const others = (updated.responses || []).map(r => normPhone(r.riderPhone)).filter(p => p && p !== rPhone);
  await Promise.allSettled(others.map(p => say(p, `🙏 ${ref} went to another rider. Stay online - more jobs are coming.`)));
  return updated;
}

// ═════════════════════════════════════════════════════════════════════════════
// JOB CARD + MY DELIVERIES
// ═════════════════════════════════════════════════════════════════════════════
function statusEmoji(s) {
  return { open: "🟡", assigned: "🏍️", picked_up: "📦", delivered: "📬", completed: "✅", cancelled: "❌", expired: "⌛" }[s] || "•";
}
function statusLabel(s) {
  return { open: "Waiting for riders", assigned: "Rider on the way", picked_up: "Picked up - on the way", delivered: "Delivered - please confirm",
           completed: "Completed", cancelled: "Cancelled", expired: "Expired" }[s] || s;
}

async function sendMyDeliveries(ctx) {
  await clearState(ctx.phone);
  const jobs = await BikerJob.find({ customerPhone: ctx.phone }).sort({ createdAt: -1 }).limit(10).lean().catch(() => []);
  if (!jobs.length) {
    await ask(ctx.from, "📦 You have no deliveries yet.", [{ id: "biker_request_rider", title: "🏍️ Request a Biker" }, { id: "main_menu_back", title: "🏠 Menu" }]);
    return true;
  }
  const live = jobs.filter(j => LIVE_STATUSES.includes(j.status));
  if (live.length === 1 && jobs.length === 1) return sendJobCard(ctx, String(live[0]._id), live[0]);
  await pick(ctx.from, `📦 *My Deliveries*\n${live.length} active · newest first. Tap one 👇`,
    jobs.map(j => ({
      id: `biker_job_${j._id}`,
      title: `${statusEmoji(j.status)} ${cut(j.dropoff, 20)}`,
      description: `${cut(j.pickup, 16)}→${cut(j.dropoff, 16)} · ${statusLabel(j.status)} · ${jobRef(j)}`
    })));
  return true;
}

async function sendJobCard(ctx, jobId, job = null) {
  job = job || await getJob(jobId);
  if (!job) { await say(ctx.from, "That job was not found."); return true; }
  const id = String(job._id);
  const ref = jobRef(job);
  const isCustomer = normPhone(job.customerPhone) === ctx.phone;
  const isRiderOfJob = normPhone(job.assignedRiderPhone) === ctx.phone;
  const head = `${statusEmoji(job.status)} *${ref}* - ${statusLabel(job.status)}\n📦 ${job.task}\n📍 ${job.pickup} → ${job.dropoff}\n🏙 ${job.city}`;

  if (isRiderOfJob) {
    const body = `${head}\n💵 ${job.agreedFare || "-"}\n📞 Customer: ${displayPhone(job.customerPhone)}`;
    if (job.status === "assigned")  return ask(ctx.from, body, [{ id: `biker_pick_${id}`, title: "📦 Picked up" }, { id: `biker_done_${id}`, title: "✅ Delivered" }, { id: `biker_cx_${id}`, title: "❌ Cancel job" }]);
    // (rider never sees the handover code)
    if (job.status === "picked_up") return ask(ctx.from, body, [{ id: `biker_done_${id}`, title: "✅ Delivered" }, { id: `biker_cx_${id}`, title: "❌ Cancel job" }, { id: "biker_menu", title: "🏍️ Rider Menu" }]);
    return ask(ctx.from, body + (job.status === "delivered" ? "\n\n⏳ Waiting for the customer to confirm." : ""), [{ id: "biker_active", title: "📋 My Jobs" }, { id: "biker_menu", title: "🏍️ Rider Menu" }]);
  }
  if (isCustomer) {
    const riderLine = job.assignedRiderPhone
      ? `\n\n👤 ${job.assignedRiderFirstName || job.assignedRiderName || "Rider"}${job.assignedPlate ? ` · 🏍️ ${job.assignedPlate}` : ""} · 📞 ${displayPhone(job.assignedRiderPhone)}\n💵 ${job.agreedFare || "-"}${job.agreedEta ? ` · ⏱ ${job.agreedEta}` : ""}` +
        (job.handoverCode && ACTIVE_STATUSES.includes(job.status) ? `\n🔐 Handover code: *${job.handoverCode}* (give it to the receiver only)` : "") : "";
    if (job.status === "open") {
      const n = (job.responses || []).length;
      return ask(ctx.from, `${head}\n\n${n ? `💬 ${n} price(s) received.` : "⏳ No prices yet - riders have been alerted."}`, [
        n ? { id: `biker_offers_${id}`, title: `📋 See prices (${n})` } : null,
        { id: `biker_cx_${id}`, title: "❌ Cancel request" },
        { id: "biker_mydel", title: "📦 My Deliveries" }
      ].filter(Boolean));
    }
    if (ACTIVE_STATUSES.includes(job.status)) return ask(ctx.from, head + riderLine, [
      { id: `biker_rcv_${id}`, title: "✅ I received it" }, { id: `biker_cx_${id}`, title: "❌ Cancel" }, { id: "biker_mydel", title: "📦 My Deliveries" }]);
    if (job.status === "delivered") return ask(ctx.from, head + riderLine + (job.riderNote ? `\n📝 Rider: ${job.riderNote}` : "") + "\n\nDid you receive it?", [
      { id: `biker_rcv_${id}`, title: "✅ Yes, received" }, { id: `biker_prob_${id}`, title: "⚠️ Problem" }]);
    return ask(ctx.from, head + riderLine +
      (job.cancelReason ? `\n❌ Reason: ${job.cancelReason}` : "") +
      (job.customerRating ? `\n⭐ You rated ${job.customerRating}/5` : ""), [
      { id: `biker_rebook_${id}`, title: "🔁 Same trip again" }, { id: "biker_mydel", title: "📦 My Deliveries" }]);
  }
  // A rider looking at an open job (from an alert)
  if (job.status === "open") return ask(ctx.from, head, [{ id: `biker_accept_${id}`, title: "✅ I'll do it" }, { id: `biker_busy_${id}`, title: "❌ Busy" }]);
  await say(ctx.from, `ℹ️ ${ref} is no longer available.`);
  return true;
}

// ═════════════════════════════════════════════════════════════════════════════
// RIDER: PICKED UP → DELIVERED (+ note)
// ═════════════════════════════════════════════════════════════════════════════
async function riderPickedUp(ctx, jobId) {
  const updated = await BikerJob.findOneAndUpdate(
    { _id: isObjId(jobId) ? jobId : null, assignedRiderPhone: ctx.phone, status: "assigned" },
    { $set: { status: "picked_up", pickedUpAt: new Date() }, $push: { history: { by: "rider", phone: ctx.phone, event: "picked_up" } } },
    { new: true }).lean().catch(() => null);
  if (!updated) return sendJobCard(ctx, jobId);
  const ref = jobRef(updated), id = String(updated._id);
  await ask(ctx.from, `📦 *Picked up* (${ref}). Ride safe! Tap *Delivered* when you hand it over.`,
    [{ id: `biker_done_${id}`, title: "✅ Delivered" }, { id: `biker_cx_${id}`, title: "❌ Cancel job" }]);
  await notifyParty(updated.customerPhone, {
    ref, line: `Your rider collected it and is on the way to ${updated.dropoff}.`,
    text: `📦 *Your rider has collected it!* (${ref})\n🏍️ ${updated.assignedRiderName} is on the way to *${updated.dropoff}*.\n📞 ${displayPhone(updated.assignedRiderPhone)}`,
    buttons: [{ id: `biker_rcv_${id}`, title: "✅ I received it" }, { id: "biker_mydel", title: "📦 My Deliveries" }]
  });
  return true;
}

// Tapping "Delivered" first asks for the receiver's 4-digit handover code.
// Right code → delivery is proven: completed instantly + points straight away.
// No code (receiver not there / customer was the sender) → old flow: customer confirms.
async function riderDeliveredStart(ctx, jobId) {
  const job = await getJob(jobId);
  if (!job || normPhone(job.assignedRiderPhone) !== ctx.phone || !ACTIVE_STATUSES.includes(job.status)) return sendJobCard(ctx, jobId, job);
  if (!job.handoverCode || job.codeVerified || (job.codeAttempts || 0) >= BIKER_CONFIG.CODE_MAX_TRIES) {
    return riderDelivered(ctx, jobId, { codeOk: job.handoverCode && !job.codeVerified ? false : null });
  }
  await setState(ctx.phone, `biker_code_${job._id}`, {});
  await ask(ctx.from,
    `🔐 *Handover code* (${jobRef(job)})\n\nAsk the person receiving the item for the *4-digit code* and type it here.\n_Right code = delivery confirmed + points straight away._`,
    [{ id: `biker_nocode_${job._id}`, title: "⏭ No code" }, { id: `biker_job_${job._id}`, title: "⬅ Back" }]);
  return true;
}
async function riderCodeTyped(ctx, jobId, txt) {
  const job = await getJob(jobId);
  if (!job || normPhone(job.assignedRiderPhone) !== ctx.phone || !ACTIVE_STATUSES.includes(job.status)) { await clearState(ctx.phone); return sendJobCard(ctx, jobId, job); }
  const digits = String(txt || "").replace(/\D+/g, "");
  if (digits && digits === String(job.handoverCode)) {
    await clearState(ctx.phone);
    await BikerJob.updateOne({ _id: job._id }, { $set: { codeVerified: true }, $push: { history: { by: "rider", phone: ctx.phone, event: "code_ok" } } });
    return riderDelivered(ctx, jobId, { codeOk: true });
  }
  const upd = await BikerJob.findOneAndUpdate({ _id: job._id }, { $inc: { codeAttempts: 1 }, $push: { history: { by: "rider", phone: ctx.phone, event: "code_wrong", note: digits.slice(0, 6) } } }, { new: true }).lean().catch(() => null);
  const left = BIKER_CONFIG.CODE_MAX_TRIES - (upd?.codeAttempts || 0);
  if (left > 0) {
    await ask(ctx.from, `❌ Wrong code. ${plural(left, "try")} left.\nCheck with the receiver and type the 4 digits again.`,
      [{ id: `biker_nocode_${job._id}`, title: "⏭ No code" }]);
    return true;
  }
  await clearState(ctx.phone);
  await notifyAdmin(`🔐 ${BIKER_CONFIG.CODE_MAX_TRIES} wrong handover codes on ${jobRef(job)}\nRider: ${job.assignedRiderName || "-"} ${displayPhone(job.assignedRiderPhone)}\nCustomer: ${displayPhone(job.customerPhone)}\n📍 ${job.pickup} → ${job.dropoff}`);
  await ask(ctx.from, "⚠️ Too many wrong codes. Tap *No code* to mark it delivered - the customer will be asked to confirm.",
    [{ id: `biker_nocode_${job._id}`, title: "⏭ No code" }]);
  return true;
}
async function riderDeliveredNoCode(ctx, jobId) {
  await clearState(ctx.phone);
  return riderDelivered(ctx, jobId, { codeOk: false });
}

async function riderDelivered(ctx, jobId, { codeOk = null } = {}) {
  const updated = await BikerJob.findOneAndUpdate(
    { _id: isObjId(jobId) ? jobId : null, assignedRiderPhone: ctx.phone, status: { $in: ACTIVE_STATUSES } },
    { $set: { status: "delivered", deliveredAt: new Date() }, $push: { history: { by: "rider", phone: ctx.phone, event: "delivered", note: codeOk ? "handover code confirmed" : codeOk === false ? "no handover code" : "" } } },
    { new: true }).lean().catch(() => null);
  if (!updated) return sendJobCard(ctx, jobId);
  const ref = jobRef(updated), id = String(updated._id);

  if (codeOk) {
    // Proven delivery → complete now (points to the rider) and invite a rating.
    await completeJob(updated._id, { by: "code", note: "handover code" });
    await setState(ctx.phone, `biker_dnote_${id}`, {});
    await ask(ctx.from, `✅ *Code correct - delivery confirmed!* (${ref})\n\nQuick note for the record? Tap one, or type your own.`, [
      { id: `biker_dn_${id}_hand`,  title: "👤 Handed over" },
      { id: `biker_dn_${id}_guard`, title: "🛡 Left with guard" },
      { id: `biker_dn_${id}_skip`,  title: "⏭ Skip" }
    ]);
    await notifyParty(updated.customerPhone, {
      ref, line: `Delivered to ${updated.dropoff} - handover code confirmed. Reply to rate your rider.`,
      text: `📬 *Delivered!* (${ref})\n🔐 Handover code confirmed at ${updated.dropoff}.\n\n⭐ How was ${updated.assignedRiderFirstName || "your rider"}?`,
      buttons: [{ id: `biker_rate_${id}_5`, title: "⭐⭐⭐⭐⭐ Great" }, { id: `biker_rate_${id}_3`, title: "⭐⭐⭐ Okay" }, { id: `biker_prob_${id}`, title: "⚠️ Problem" }]
    });
    return true;
  }

  await setState(ctx.phone, `biker_dnote_${id}`, {});
  await ask(ctx.from, `✅ *Marked delivered* (${ref})\n\nQuick note for the record? Tap one, or type your own (e.g. _Given to Mrs Moyo_).`, [
    { id: `biker_dn_${id}_hand`,  title: "👤 Handed over" },
    { id: `biker_dn_${id}_guard`, title: "🛡 Left with guard" },
    { id: `biker_dn_${id}_skip`,  title: "⏭ Skip" }
  ]);
  await notifyParty(updated.customerPhone, {
    ref, line: `Rider says it was delivered to ${updated.dropoff}. Reply to confirm.`,
    text: `📬 *Your rider says it's delivered!* (${ref})\n📍 ${updated.pickup} → ${updated.dropoff}` +
      (codeOk === false && updated.handoverCode ? `\n⚠️ The handover code was *not* used.` : "") + `\n\nDid you receive it?`,
    buttons: [{ id: `biker_rcv_${id}`, title: "✅ Yes, received" }, { id: `biker_prob_${id}`, title: "⚠️ Problem" }]
  });
  return true;
}
async function riderQuickNote(ctx, jobId, code) {
  const note = code === "hand" ? "Handed over to the customer" : code === "guard" ? "Left with security / guard" : "";
  return saveRiderNote(ctx, jobId, note, true);
}
async function saveRiderNote(ctx, jobId, note, quick = false) {
  await clearState(ctx.phone);
  const clean = String(note || "").trim().slice(0, 300);
  const job = await getJob(jobId);
  if (job && clean && normPhone(job.assignedRiderPhone) === ctx.phone) {
    await BikerJob.updateOne({ _id: job._id }, { $set: { riderNote: clean }, $push: { history: { by: "rider", phone: ctx.phone, event: "note", note: clean } } });
    if (job.status === "delivered" || job.status === "completed") {
      await say(job.customerPhone, `📝 *Rider note* (${jobRef(job)}): ${clean}`);
    }
  }
  await ask(ctx.from, `👍 ${clean ? "Note saved. " : ""}Points are added when the customer confirms (or automatically after ${BIKER_CONFIG.AUTO_COMPLETE_HOURS}h).`,
    [{ id: "biker_openjobs", title: "🔔 More jobs" }, { id: "biker_menu", title: "🏍️ Rider Menu" }]);
  return true;
}

// ═════════════════════════════════════════════════════════════════════════════
// CUSTOMER: RECEIVED → RATE → NOTE   |   PROBLEM
// ═════════════════════════════════════════════════════════════════════════════
async function completeJob(jobId, { by = "customer", note = "" } = {}) {
  const updated = await BikerJob.findOneAndUpdate(
    { _id: jobId, status: { $in: ["assigned", "picked_up", "delivered"] }, disputed: { $ne: true } },
    { $set: { status: "completed", completedAt: new Date(), completedBy: by },
      $push: { history: { by, event: "completed", note } } },
    { new: true }).lean().catch(() => null);
  if (!updated) return null;
  // Points: base (or auto), + fast-response bonus
  const resp = (updated.responses || []).find(r => normPhone(r.riderPhone) === normPhone(updated.assignedRiderPhone));
  const fast = resp && updated.openSince && (new Date(resp.respondedAt) - new Date(updated.openSince)) <= BIKER_CONFIG.FAST_RESPONSE_MIN * 60000;
  const pts = (by === "auto" ? RIDER_POINTS.autoComplete : RIDER_POINTS.complete) + (fast ? RIDER_POINTS.fast : 0);
  const r = await addRiderPoints(updated.assignedRiderPhone, pts, { completedTrips: 1 });
  await BikerJob.updateOne({ _id: updated._id }, { $inc: { pointsAwarded: pts } }).catch(() => {});
  if (r) {
    const lvl = riderLevel(r.riderPoints);
    await notifyParty(updated.assignedRiderPhone, {
      ref: jobRef(updated), line: `Delivery confirmed. +${pts} points.`,
      text: `🎉 *Delivery confirmed* (${jobRef(updated)})${by === "auto" ? " - auto-confirmed" : ""}\n+${pts} points${fast ? " (incl. ⚡ fast bonus)" : ""} · Total *${r.riderPoints}* ${lvl.emoji} ${lvl.name}`,
      buttons: [{ id: "biker_openjobs", title: "🔔 More jobs" }, { id: "biker_menu", title: "🏍️ Rider Menu" }]
    });
  }
  return updated;
}

async function customerReceived(ctx, jobId) {
  const job = await getJob(jobId);
  if (!job || normPhone(job.customerPhone) !== ctx.phone) { await say(ctx.from, "That request was not found."); return true; }
  if (job.status === "open") { await say(ctx.from, "ℹ️ No rider has been chosen yet for this request."); return sendJobCard(ctx, jobId, job); }
  if (job.status === "completed") return askRating(ctx, job);
  const done = await completeJob(job._id, { by: "customer" });
  if (!done) return sendJobCard(ctx, jobId);
  return askRating(ctx, done);
}
async function askRating(ctx, job) {
  if (job.customerRating) {
    await ask(ctx.from, `✅ ${jobRef(job)} is complete. Thanks!`, [{ id: `biker_rebook_${job._id}`, title: "🔁 Same trip again" }, { id: "main_menu_back", title: "🏠 Menu" }]);
    return true;
  }
  const id = String(job._id);
  await pick(ctx.from, `✅ *Delivery complete!* (${jobRef(job)})\n\n⭐ How was *${job.assignedRiderName || "your rider"}*?`, [
    { id: `biker_rate_${id}_5`, title: "⭐⭐⭐⭐⭐ Excellent" },
    { id: `biker_rate_${id}_4`, title: "⭐⭐⭐⭐ Good" },
    { id: `biker_rate_${id}_3`, title: "⭐⭐⭐ Okay" },
    { id: `biker_rate_${id}_2`, title: "⭐⭐ Poor" },
    { id: `biker_rate_${id}_1`, title: "⭐ Very bad" }
  ]);
  return true;
}
async function customerRate(ctx, jobId, n) {
  if (!isObjId(jobId) || !(n >= 1 && n <= 5)) return false;
  const job = await BikerJob.findOneAndUpdate(
    { _id: jobId, customerPhone: ctx.phone, status: "completed", customerRating: null },
    { $set: { customerRating: n }, $push: { history: { by: "customer", phone: ctx.phone, event: "rated", note: `${n}/5` } } },
    { new: true }).lean().catch(() => null);
  if (!job) {
    // Double tap / already rated: keep the optional note step alive.
    const j = await getJob(jobId);
    if (j && normPhone(j.customerPhone) === ctx.phone && j.customerRating && !j.customerNote) {
      await setState(ctx.phone, `biker_cnote_${j._id}`, {});
      await ask(ctx.from, `✅ Rated ${stars(j.customerRating)} already. Anything to add? Type a short note, or tap Skip.`,
        [{ id: `biker_cnskip_${j._id}`, title: "⏭ Skip" }, { id: `biker_rebook_${j._id}`, title: "🔁 Same trip again" }]);
      return true;
    }
    await say(ctx.from, "ℹ️ You already rated this delivery. Thanks!");
    return true;
  }

  const rider = await getRider(job.assignedRiderPhone);
  if (rider) {
    const cnt = Number(rider.reviewCount) || 0;
    const avg = ((Number(rider.rating) || 0) * cnt + n) / (cnt + 1);
    const bonus = n === 5 ? RIDER_POINTS.rate5 : n === 4 ? RIDER_POINTS.rate4 : n <= 2 ? RIDER_POINTS.rateLow : 0;
    await updateRider({ _id: rider._id }, { $set: { rating: Math.round(avg * 10) / 10 }, $inc: { reviewCount: 1, riderPoints: bonus } });
    if (bonus) await BikerJob.updateOne({ _id: job._id }, { $inc: { pointsAwarded: bonus } }).catch(() => {});
    if (n >= 4) await say(rider.phone, `⭐ Customer rated you *${n}/5* for ${jobRef(job)}${bonus ? ` (+${bonus} pts)` : ""}. Keep it up!`);
    if (n <= 2) await notifyAdmin(`Low rating ${n}/5 on ${jobRef(job)}\nRider: ${riderName(rider)} ${displayPhone(rider.phone)}\nCustomer: ${displayPhone(job.customerPhone)}`);
  }
  await setState(ctx.phone, `biker_cnote_${job._id}`, {});
  await ask(ctx.from, `🙏 Thanks for rating ${stars(n)}\n\nAnything to add about the rider? Type a short note, or tap Skip.`,
    [{ id: `biker_cnskip_${job._id}`, title: "⏭ Skip" }, { id: `biker_rebook_${job._id}`, title: "🔁 Same trip again" }]);
  return true;
}
async function saveCustomerNote(ctx, jobId, note) {
  await clearState(ctx.phone);
  const clean = String(note || "").trim().slice(0, 300);
  const job = await getJob(jobId);
  if (job && clean && normPhone(job.customerPhone) === ctx.phone) {
    await BikerJob.updateOne({ _id: job._id }, { $set: { customerNote: clean }, $push: { history: { by: "customer", phone: ctx.phone, event: "note", note: clean } } });
    if ((job.customerRating || 0) >= 4 && job.assignedRiderPhone) await say(job.assignedRiderPhone, `💬 *Customer note* (${jobRef(job)}): ${clean}`);
    if ((job.customerRating || 5) <= 2) await notifyAdmin(`Customer note on low-rated ${jobRef(job)}: ${clean}`);
  }
  await ask(ctx.from, "🙏 Thank you! Your feedback keeps riders reliable.", [{ id: `biker_rebook_${jobId}`, title: "🔁 Same trip again" }, { id: "main_menu_back", title: "🏠 Menu" }]);
  return true;
}

async function startProblem(ctx, jobId) {
  const job = await getJob(jobId);
  if (!job || normPhone(job.customerPhone) !== ctx.phone) { await say(ctx.from, "That request was not found."); return true; }
  await setState(ctx.phone, `biker_prob_${job._id}`, {});
  await say(ctx.from, `⚠️ *What went wrong?* (${jobRef(job)})\nType it in one message, e.g. _not delivered_, _item damaged_, _rider asked for more money_.`);
  return true;
}
async function saveProblem(ctx, jobId, text) {
  await clearState(ctx.phone);
  const clean = String(text || "").trim().slice(0, 500);
  const job = await BikerJob.findOneAndUpdate(
    { _id: jobId, customerPhone: ctx.phone },
    { $set: { disputed: true, problemReport: clean }, $push: { history: { by: "customer", phone: ctx.phone, event: "problem", note: clean } } },
    { new: true }).lean().catch(() => null);
  if (!job) { await say(ctx.from, "That request was not found."); return true; }
  await notifyAdmin(`⚠️ PROBLEM on ${jobRef(job)}\n${clean}\n\nCustomer: ${displayPhone(job.customerPhone)}\nRider: ${job.assignedRiderName || "-"} ${displayPhone(job.assignedRiderPhone)}\n📍 ${job.pickup} → ${job.dropoff}`);
  if (job.assignedRiderPhone) await say(job.assignedRiderPhone, `⚠️ The customer reported a problem on ${jobRef(job)}: "${clean}"\nZimQuote will contact you. Points for this job are on hold.`);
  await ask(ctx.from,
    `✅ We've logged it (${jobRef(job)}). Our team will contact you shortly.${job.assignedRiderPhone ? `\n\nYou can also call the rider: ${displayPhone(job.assignedRiderPhone)}` : ""}`,
    [{ id: "biker_mydel", title: "📦 My Deliveries" }, { id: "main_menu_back", title: "🏠 Menu" }]);
  return true;
}

// ═════════════════════════════════════════════════════════════════════════════
// CANCEL  (customer or rider, with a reason)
// ═════════════════════════════════════════════════════════════════════════════
async function startCancel(ctx, jobId) {
  const job = await getJob(jobId);
  if (!job) { await say(ctx.from, "That job was not found."); return true; }
  const id = String(job._id);
  const isCustomer = normPhone(job.customerPhone) === ctx.phone;
  const isAssigned = normPhone(job.assignedRiderPhone) === ctx.phone && ACTIVE_STATUSES.includes(job.status);
  const hasOffer   = job.status === "open" && (job.responses || []).some(r => normPhone(r.riderPhone) === ctx.phone);

  if (isCustomer) {
    if (!["open", ...ACTIVE_STATUSES].includes(job.status)) return sendJobCard(ctx, id, job);
    await pick(ctx.from, `❌ *Cancel ${jobRef(job)}?*\n📍 ${job.pickup} → ${job.dropoff}\n\nWhy are you cancelling? 👇${job.status === "picked_up" ? "\n\n⚠️ The rider has already collected your item." : ""}`,
      CUSTOMER_CANCEL_REASONS.map(r => ({ id: `biker_cxr_${id}_${r.code}`, title: r.title, description: r.desc })));
    return true;
  }
  if (isAssigned) {
    await pick(ctx.from, `❌ *Drop job ${jobRef(job)}?*\n\nThe customer is told and the job goes to other riders.\n⚠️ Cancelling costs ${Math.abs(RIDER_POINTS.cancel)} points (${Math.abs(RIDER_POINTS.cancelCustomerFault)} if it's the customer's fault).\n\nWhy? 👇`,
      RIDER_CANCEL_REASONS.map(r => ({ id: `biker_cxr_${id}_${r.code}`, title: r.title, description: r.desc })));
    return true;
  }
  if (hasOffer) {
    await BikerJob.updateOne({ _id: job._id, status: "open" }, { $pull: { responses: { riderPhone: ctx.phone } }, $push: { history: { by: "rider", phone: ctx.phone, event: "offer_withdrawn" } } });
    await ask(ctx.from, `↩️ Your price for ${jobRef(job)} was withdrawn.`, [{ id: "biker_openjobs", title: "🔔 Open Jobs" }]);
    return true;
  }
  return sendJobCard(ctx, id, job);
}

async function cancelWithCode(ctx, jobId, code, typed = "") {
  const job = await getJob(jobId);
  if (!job) { await clearState(ctx.phone); await say(ctx.from, "That job was not found."); return true; }
  const isCustomer = normPhone(job.customerPhone) === ctx.phone;
  const list = isCustomer ? CUSTOMER_CANCEL_REASONS : RIDER_CANCEL_REASONS;
  if (code === "other" && !typed) {
    await setState(ctx.phone, `biker_cxnote_${job._id}`, {});
    await say(ctx.from, "✍️ Type the reason in a few words:");
    return true;
  }
  await clearState(ctx.phone);
  const reason = code === "other" ? String(typed).trim().slice(0, 200) : (list.find(r => r.code === code)?.title || "No reason given");
  if (isCustomer) return customerCancel(ctx, job, code, reason);
  return riderCancel(ctx, job, code, reason);
}

async function customerCancel(ctx, job, code, reason, { by = "customer" } = {}) {
  const prev = await BikerJob.findOneAndUpdate(
    { _id: job._id, status: { $in: ["open", ...ACTIVE_STATUSES] } },
    { $set: { status: "cancelled", cancelledAt: new Date(), cancelledBy: by, cancelReason: reason, cancelCode: code },
      $push: { history: { by, phone: by === "customer" ? ctx?.phone || "" : "", event: "cancelled", note: reason } } },
    { new: false }).lean().catch(() => null);
  if (!prev) { if (ctx) return sendJobCard(ctx, String(job._id)); return null; }
  const ref = jobRef(prev);
  const who = by === "admin" ? "ZimQuote" : "the customer";

  if (prev.assignedRiderPhone) {
    await notifyParty(prev.assignedRiderPhone, {
      ref, line: `Cancelled by ${who}. Reason: ${reason}`,
      text: `❌ *Job cancelled by ${who}* (${ref})\nReason: ${reason}` +
        (prev.status === "picked_up" ? `\n\n⚠️ You already collected the item - call the customer on ${displayPhone(prev.customerPhone)} to arrange the return and your fare.` : "") +
        `\n\nNo points lost.`,
      buttons: [{ id: "biker_openjobs", title: "🔔 Open Jobs" }, { id: "biker_menu", title: "🏍️ Rider Menu" }]
    });
  } else {
    const responders = (prev.responses || []).map(r => normPhone(r.riderPhone));
    await Promise.allSettled(responders.map(p => say(p, `ℹ️ ${ref} was cancelled by ${who}. No action needed.`)));
  }
  if (ctx) {
    await ask(ctx.from,
      `✅ *Cancelled* (${ref})` +
      (prev.status === "picked_up" ? `\n\n⚠️ The rider already collected your item - call them on ${displayPhone(prev.assignedRiderPhone)} to arrange the return.` : ""),
      [{ id: `biker_rebook_${prev._id}`, title: "🔁 Request again" }, { id: "main_menu_back", title: "🏠 Menu" }]);
  } else if (by === "admin") {
    await say(prev.customerPhone, `❌ Your delivery ${ref} was cancelled by ZimQuote.\nReason: ${reason}`);
  }
  return prev;
}

async function riderCancel(ctx, job, code, reason) {
  const wasPickedUp = job.status === "picked_up";
  const updated = await BikerJob.findOneAndUpdate(
    { _id: job._id, assignedRiderPhone: ctx.phone, status: { $in: ACTIVE_STATUSES } },
    { $set: { status: "open", openSince: new Date(), assignedRiderId: null, assignedRiderPhone: "", assignedRiderName: "",
              agreedFare: "", agreedFareAmount: null, agreedEta: "", assignedAt: null, pickedUpAt: null,
              repingCount: 0, staleReminderSent: false },
      $addToSet: { cancelledRiderPhones: ctx.phone },
      $pull: { responses: { riderPhone: ctx.phone } },
      $push: { history: { by: "rider", phone: ctx.phone, event: "cancelled", note: reason } } },
    { new: true }).lean().catch(() => null);
  if (!updated) return sendJobCard(ctx, String(job._id));

  const penalty = CUSTOMER_FAULT_CODES.has(code) ? RIDER_POINTS.cancelCustomerFault : RIDER_POINTS.cancel;
  const r = await addRiderPoints(ctx.phone, penalty, { riderCancels: 1 });
  const ref = jobRef(updated), id = String(updated._id);
  await ask(ctx.from,
    `↩️ *Job dropped* (${ref}). ${penalty} points${r ? ` · Total ${r.riderPoints}` : ""}.\n\n_Tip: only accept jobs you can finish - cancels lower your ranking._`,
    [{ id: "biker_openjobs", title: "🔔 Open Jobs" }, { id: "biker_menu", title: "🏍️ Rider Menu" }]);

  // Re-dispatch to fresh riders; tell the customer
  const notified = await dispatchJob(updated);
  const others = (updated.responses || []).length;
  await notifyParty(updated.customerPhone, {
    ref, line: `Your rider cancelled (${reason}). We're finding another rider.`,
    text:
      `⚠️ *Your rider cancelled* (${ref})\nReason: ${reason}` +
      (wasPickedUp ? `\n\n❗ They had already collected your item - please call them on ${displayPhone(job.assignedRiderPhone)}.` : "") +
      `\n\n🔎 ${notified ? `We alerted ${notified} more rider${notified === 1 ? "" : "s"}.` : "We're looking for another rider."}` +
      (others ? ` You also have ${others} other price(s).` : ""),
    buttons: [others ? { id: `biker_offers_${id}`, title: `📋 Other prices (${others})` } : null, { id: `biker_cx_${id}`, title: "❌ Cancel request" }].filter(Boolean)
  });
  if (!CUSTOMER_FAULT_CODES.has(code)) {
    const rc = (r?.riderCancels || 0);
    if (rc && rc % 5 === 0) await notifyAdmin(`Rider ${r ? riderName(r) : ctx.phone} (${displayPhone(ctx.phone)}) has now cancelled ${rc} jobs.`);
  }
  return true;
}

// ═════════════════════════════════════════════════════════════════════════════
// REBOOK / RIDER LINK / GROUP LINK
// ═════════════════════════════════════════════════════════════════════════════
async function rebook(ctx, jobId) {
  const job = await getJob(jobId);
  if (!job || normPhone(job.customerPhone) !== ctx.phone) return startRiderRequest(ctx);
  // Happy with the last rider? Send it to them first.
  const preferred = job.status === "completed" && (job.customerRating || 5) >= 4 && job.assignedRiderId ? String(job.assignedRiderId) : null;
  ctx.sess = await getSess(ctx.phone);
  const res = await createAndDispatchJob(ctx, {
    task: job.task, pickup: job.pickup, dropoff: job.dropoff, city: job.city, preferredRiderId: preferred
  });
  return res;
}

async function viewRider(ctx, riderId) {
  const r = isObjId(riderId) ? await SupplierProfile.findById(riderId).lean().catch(() => null) : null;
  if (!r || r.profileType !== "biker") { await say(ctx.from, "Rider not found."); return true; }
  if (normPhone(r.phone) !== ctx.phone) notifyRiderProfileView(r, ctx.phone, "riders list").catch(() => {});
  await ask(ctx.from,
    `🏍️ *${publicName(r)}*\n${riderBadgeLine(r)}\n📍 ${r.location?.city || ""}${(r.riderAreas || []).length ? " · " + r.riderAreas.join(", ") : ""}\n\n🔒 You'll see the rider's first name, plate and number once you book.`,
    [{ id: `biker_bookrider_${r._id}`, title: "📦 Book this rider" }, { id: "biker_request_rider", title: "🏍️ Any rider" }]);
  return true;
}
async function bookSpecificRider(ctx, riderId) {
  const r = isObjId(riderId) ? await SupplierProfile.findById(riderId).lean().catch(() => null) : null;
  if (r && r.profileType === "biker" && normPhone(r.phone) !== ctx.phone) notifyRiderProfileView(r, ctx.phone, "rider link").catch(() => {});
  if (!r || r.profileType !== "biker" || !canTakeJobs(r)) {
    await say(ctx.from, "ℹ️ That rider isn't available right now - we'll send your request to riders near you.");
    return startRiderRequest(ctx);
  }
  if (normPhone(r.phone) === ctx.phone) { await say(ctx.from, "🔗 That's your own rider link - share it with customers!"); return sendRiderMenu(ctx.from, r, ctx.biz); }
  return startRiderRequest(ctx, { preferredRider: r });
}

// ═════════════════════════════════════════════════════════════════════════════
// SHAREABLE HUB LINK  - one link for BOTH "Request a Biker" and "Become a Rider"
//   https://wa.me/<BOT>?text=...ZQ:BIKERS          (any city)
//   https://wa.me/<BOT>?text=...ZQ:BIKERS:HARARE   (city-specific - remembers city)
// ═════════════════════════════════════════════════════════════════════════════
// "Bikers", "zimquote bikers", "hi bikers", "Bikers Harare", "bikers in bulawayo" → hub.
// A trailing word that is NOT a known town means it's something else ("bikers jacket"),
// so we don't intercept it.
function matchPlainHub(txt = "") {
  const m = String(txt).trim().match(/^(?:hi\s+|hello\s+)?(?:zimquote\s+)?bikers(?:\s+(?:in\s+)?([a-z][a-z .-]{2,30}?))?[\s!.🏍️]*$/i);
  if (!m) return null;
  if (!m[1]) return { city: "" };
  const c = m[1].trim().toLowerCase().replace(/-/g, " ");
  const all = [...KNOWN_CITIES, ...(SUPPLIER_CITIES || [])].map(x => String(x).toLowerCase());
  return all.includes(c) ? { city: c } : null;
}

// Direct WhatsApp links - the message box just says "Bikers" (or a clear action).
export function bikerHubLink(city = "") {
  const t = city ? `Bikers ${titleCity(String(city).replace(/-/g, " "))}` : "Bikers";
  return `https://wa.me/${BOT_NUMBER}?text=${encodeURIComponent(t)}`;
}
export function bikerWaLink(kind = "hub", city = "") {
  if (kind === "request")  return `https://wa.me/${BOT_NUMBER}?text=${encodeURIComponent("Request a biker")}`;
  if (kind === "register") return `https://wa.me/${BOT_NUMBER}?text=${encodeURIComponent("Become a rider")}`;
  return bikerHubLink(city);
}
export function bikerHubCaption(city = "", link = "") {
  const where = city ? ` in ${titleCity(city)}` : "";
  return `🏍️ *ZimQuote Bikers*${where}\n\n` +
    `📦 Need something delivered or an errand run? Riders send you prices on WhatsApp - you choose.\n` +
    `🏍️ Have a motorbike? Join as a rider, get jobs on WhatsApp and keep 100% of every fare.\n\n` +
    `👉 Tap to chat on WhatsApp: ${link || bikerHubLink(city)}`;
}

async function bikerHub(ctx, rawCity = "") {
  const city = rawCity ? titleCity(rawCity.replace(/-/g, " ")) : "";
  if (ctx.sess?.state) await clearState(ctx.phone);           // a link always starts clean
  if (city) await setLastCity(ctx.phone, city);               // helps the request skip "Which city?"

  const rider = await getRider(ctx.phone);
  let online = 0;
  try {
    const q = { profileType: "biker", active: true, suspended: { $ne: true }, riderActive: { $ne: false } };
    if (city) q["location.city"] = { $in: metroGroup(city).map(c => new RegExp(`^${escRe(c)}$`, "i")) };
    online = await SupplierProfile.countDocuments(q).setOptions({ strictQuery: false });
  } catch (_) {}
  console.log(`[BIKER HUB] ${ctx.phone} opened bikers link${city ? " (" + city + ")" : ""} · rider=${!!rider}`);

  if (rider) {
    await ask(ctx.from,
      `🏍️ *ZimQuote Bikers*${city ? ` - ${city}` : ""}\n\nYou're registered as a rider ✅\n\n` +
      `• Tap *Rider Menu* to go online and see jobs\n• Tap *Request a Biker* if you need a delivery yourself`,
      [{ id: "biker_menu", title: "🏍️ Rider Menu" }, { id: "biker_request_rider", title: "📦 Request a Biker" }]);
    return true;
  }
  await ask(ctx.from,
    `🏍️ *ZimQuote Bikers*${city ? ` - ${city}` : ""}\nFast deliveries & errands on WhatsApp.\n\n` +
    `📦 *Need something delivered?*\nTap *Request a Biker* - nearby riders send you prices, you choose.\n_e.g. Collect documents, CBD to Avondale_\n\n` +
    `🏍️ *Have a motorbike?*\nTap *Become a Rider* - get jobs on WhatsApp, set your own price, keep 100% of the fare.` +
    (online ? `\n\n🟢 ${online} rider${online === 1 ? "" : "s"} online${city ? ` in ${city}` : ""} now` : ""),
    [{ id: "biker_request_rider", title: "📦 Request a Biker" }, { id: "reg_type_biker", title: "🏍️ Become a Rider" }, { id: "main_menu_back", title: "🏠 Main Menu" }]);
  return true;
}

async function bikerGroupLink(ctx, slug) {
  const city = titleCity(slug || "Harare");
  const group = metroGroup(city);
  const riders = await SupplierProfile.find({
    profileType: "biker", active: true, suspended: { $ne: true },
    "location.city": { $in: group.map(c => new RegExp(`^${escRe(c)}$`, "i")) }
  }).sort({ riderPoints: -1 }).limit(30).lean().then(list => list.filter(canTakeJobs).slice(0, 8)).catch(() => []);
  const ctaRow = { id: "reg_type_biker", title: "🏍️ Become a Rider", description: "Earn with your bike - get jobs on WhatsApp" };
  const reqRow = { id: "biker_request_rider", title: "📦 Request a Biker", description: "Riders send prices - you choose" };
  if (!riders.length) {
    await pick(ctx.from, `🏍️ *ZimQuote Riders - ${city}*\n\nRequest a rider for any errand, or become one yourself.`, [reqRow, ctaRow]);
    return true;
  }
  await pick(ctx.from, `🏍️ *ZimQuote Riders - ${city}*\n\nRequest any rider, pick a top rider, or join as a rider.`,
    [reqRow, ...riders.map(r => ({
      id: `biker_viewrider_${r._id}`,
      title: `${riderLevel(r.riderPoints).emoji} ${cut(publicName(r), 20)}`,
      description: [`⭐ ${(Number(r.rating) || 0).toFixed(1)}`, `${r.completedTrips || 0} trips`, (r.riderAreas || []).slice(0, 2).join(", "), "🪪"].filter(Boolean).join(" · ")
    })), ctaRow].slice(0, 10));
  return true;
}

// Accept older call shape ({from, biz, saveBiz}) used by previous versions.
async function _ctx(ctx) {
  if (ctx.phone && ctx.sess) return ctx;
  const phone = normPhone(ctx.from);
  return { ...ctx, phone, sess: await getSess(phone) };
}

// ═════════════════════════════════════════════════════════════════════════════
// BACKGROUND SWEEP  (every 2 minutes; safe with several server instances)
// ═════════════════════════════════════════════════════════════════════════════
export async function sweepBikerJobs() {
  const now = Date.now();
  const minAgo = m => new Date(now - m * 60000);

  // 1) Re-ping: rider-link jobs with a silent rider, and normal jobs with no price yet
  const reping = await BikerJob.find({
    status: "open", repingCount: 0, "responses.0": { $exists: false },
    $or: [
      { preferredRiderId: { $ne: null }, openSince: { $lte: minAgo(BIKER_CONFIG.PREFERRED_EXPAND_MIN) } },
      { openSince: { $lte: minAgo(BIKER_CONFIG.REPING_AFTER_MIN) } }
    ]
  }).limit(50).lean().catch(() => []);
  for (const j of reping) {
    const claimed = await BikerJob.findOneAndUpdate({ _id: j._id, repingCount: 0, status: "open" }, { $inc: { repingCount: 1 } }, { new: true }).lean().catch(() => null);
    if (claimed) await dispatchJob(claimed, { expand: true }).catch(e => console.warn("[BIKER SWEEP] reping:", e.message));
  }

  // 2) Expire: no price after N min
  const dead = await BikerJob.find({ status: "open", "responses.0": { $exists: false }, openSince: { $lte: minAgo(BIKER_CONFIG.EXPIRE_NO_OFFER_MIN) } }).limit(50).lean().catch(() => []);
  for (const j of dead) {
    const x = await BikerJob.findOneAndUpdate({ _id: j._id, status: "open", "responses.0": { $exists: false } },
      { $set: { status: "expired" }, $push: { history: { by: "system", event: "expired", note: "no prices" } } }, { new: true }).lean().catch(() => null);
    if (x) await notifyParty(x.customerPhone, {
      ref: jobRef(x), line: "No rider was available. Reply to try again.",
      text: `⌛ *No rider was available* for ${jobRef(x)} (${x.pickup} → ${x.dropoff}).\n\nRiders may be busy - please try again in a few minutes.`,
      buttons: [{ id: `biker_rebook_${x._id}`, title: "🔁 Try again" }, { id: "main_menu_back", title: "🏠 Menu" }]
    });
  }

  // 3) Expire: prices came but customer never chose
  const unchosen = await BikerJob.find({ status: "open", "responses.0": { $exists: true }, openSince: { $lte: minAgo(BIKER_CONFIG.EXPIRE_NOT_CHOSEN_MIN) } }).limit(50).lean().catch(() => []);
  for (const j of unchosen) {
    const x = await BikerJob.findOneAndUpdate({ _id: j._id, status: "open" },
      { $set: { status: "expired" }, $push: { history: { by: "system", event: "expired", note: "customer did not choose" } } }, { new: true }).lean().catch(() => null);
    if (x) await notifyParty(x.customerPhone, {
      ref: jobRef(x), line: "Request closed because no rider was chosen.",
      text: `⌛ ${jobRef(x)} closed - no rider was chosen within ${BIKER_CONFIG.EXPIRE_NOT_CHOSEN_MIN} min.`,
      buttons: [{ id: `biker_rebook_${x._id}`, title: "🔁 Request again" }, { id: "main_menu_back", title: "🏠 Menu" }]
    });
  }

  // 4) Auto-complete: rider marked delivered, customer silent
  const delivered = await BikerJob.find({ status: "delivered", disputed: { $ne: true }, deliveredAt: { $lte: minAgo(BIKER_CONFIG.AUTO_COMPLETE_HOURS * 60) } }).limit(50).lean().catch(() => []);
  for (const j of delivered) await completeJob(j._id, { by: "auto", note: "customer did not respond" }).catch(() => {});

  // 5) Stale reminder to rider
  const stale = await BikerJob.find({ status: { $in: ACTIVE_STATUSES }, staleReminderSent: { $ne: true }, assignedAt: { $lte: minAgo(BIKER_CONFIG.STALE_REMIND_HOURS * 60) } }).limit(50).lean().catch(() => []);
  for (const j of stale) {
    const x = await BikerJob.findOneAndUpdate({ _id: j._id, staleReminderSent: { $ne: true } }, { $set: { staleReminderSent: true } }, { new: true }).lean().catch(() => null);
    if (x) await notifyParty(x.assignedRiderPhone, {
      ref: jobRef(x), line: "Is this delivery done? Reply to update.",
      text: `⏰ *Is ${jobRef(x)} delivered?*\n📍 ${x.pickup} → ${x.dropoff}\n\nPlease update it so you get your points.`,
      buttons: [{ id: `biker_done_${x._id}`, title: "✅ Delivered" }, { id: `biker_cx_${x._id}`, title: "❌ Cancel job" }]
    });
  }
}

if (!globalThis.__zqBikerSweep && process.env.BIKER_SWEEP !== "off" && process.env.NODE_ENV !== "test") {
  globalThis.__zqBikerSweep = setInterval(() => {
    sweepBikerJobs().catch(e => console.warn("[BIKER SWEEP]", e.message));
  }, 2 * 60 * 1000);
  if (globalThis.__zqBikerSweep.unref) globalThis.__zqBikerSweep.unref();
}

// ═════════════════════════════════════════════════════════════════════════════
// RIDER PROFILE ACTIVITY  (masked views & leads - same idea as sellers / schools)
// ─────────────────────────────────────────────────────────────────────────────
// • REAL views: a customer opens a rider's link or taps them in a riders list →
//   the rider is told. Active + verified riders see the full number; everyone
//   else sees a masked teaser (+263 77 2XX XXXX) and "activate / verify to unlock".
// • ADMIN activity: /zq-admin/bikers/activity sends the same alert ("profile
//   view" or "delivery request near you") to chosen riders - e.g. unpaid riders.
// Approved templates are used, so alerts land even outside the 24h window.
// Every alert is logged (BikerActivity) - powers history + "don't repeat".
// ═════════════════════════════════════════════════════════════════════════════
const BikerActivitySchema = new mongoose.Schema({
  riderId:     { type: mongoose.Schema.Types.ObjectId, index: true },
  riderPhone:  { type: String, index: true },
  riderName:   String,
  kind:        { type: String, default: "view" },      // view | job
  source:      { type: String, default: "admin" },     // admin | rider link | riders list | manual request
  visitorPhone:String,
  note:        String,
  route:       String,
  jobId:       { type: mongoose.Schema.Types.ObjectId, default: null },
  contactShown:Boolean,
  riderReady:  Boolean,   // paid + verified at send time
  alertSent:   Boolean,
  createdBy:   String
}, { timestamps: true });
export const BikerActivity = mongoose.models.BikerActivity || mongoose.model("BikerActivity", BikerActivitySchema);

const _viewSeen = new Map();   // `${riderId}:${visitor}` → time (cheap per-instance throttle)

export async function notifyRiderProfileView(rider, visitorPhone, via = "rider link") {
  const key = `${rider._id}:${normPhone(visitorPhone)}`;
  const last = _viewSeen.get(key) || 0;
  if (Date.now() - last < BIKER_CONFIG.VIEW_ALERT_HOURS * 3600000) return { ok: false, skipped: true };
  _viewSeen.set(key, Date.now());
  if (_viewSeen.size > 20000) _viewSeen.clear();
  await updateRider({ _id: rider._id }, { $inc: { viewCount: 1, monthlyViews: 1, zqLinkViews: 1 } });
  return sendRiderActivityAlert({ rider, kind: "view", via, visitorPhone, contactMode: "auto", source: via });
}

/**
 * Send one activity alert to a rider (and log it).
 * contactMode: "auto" (full to ready riders, masked to the rest) | "mask" | "hide" | "show"
 */
export async function sendRiderActivityAlert({ rider, kind = "view", via = "", note = "", route = "", visitorPhone = "",
                                               contactMode = "auto", source = "admin", jobId = null, createdBy = "", dryRunTo = "" }) {
  const ready = canTakeJobs(rider);
  const mode = contactMode === "auto" ? (ready ? "show" : "mask") : contactMode;
  const hasV = !!normPhone(visitorPhone);
  const showFull = hasV && (mode === "show" || ready);
  const showMask = hasV && !showFull && mode === "mask";
  const name = publicName(rider);
  const noteClean = String(note || "").replace(/[\r\n\t]+/g, " ").replace(/ {2,}/g, " ").trim().slice(0, 140);
  const routeClean = String(route || "").replace(/[\r\n\t]+/g, " ").trim().slice(0, 80);
  const unlock = !rider.active ? "reply *menu* to activate & unlock" : !isRiderVerified(rider) ? "reply *menu* & verify your ID to unlock" : "";

  let line = kind === "job" ? `Delivery request near you${routeClean ? ": " + routeClean : ""}` : `Rider profile${via ? " via " + via : ""}`;
  if (noteClean) line += " · " + noteClean;
  if (ready) line += kind === "job" ? " · reply to see it & send your price" : " · reply to respond";
  else if (showMask) line += ` · From ${maskPhone(visitorPhone)} - ${unlock}`;
  else line += ` · ${unlock || "reply to view"}`;
  line = line.slice(0, 300);

  const to = normPhone(dryRunTo || rider.phone);
  const timeStr = new Date().toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  let ok = false, error = "";
  // 1) Optional one-tap template (ZQ_ENQUIRY_TEMPLATE) for riders who must activate/verify
  const NEWTPL = String(process.env.ZQ_ENQUIRY_TEMPLATE || "").trim();
  if (NEWTPL && !ready) {
    try {
      const contactVar = showFull ? displayPhone(visitorPhone) : showMask ? maskPhone(visitorPhone) : "-";
      await axios.post(`https://graph.facebook.com/${GRAPH_API_VERSION}/${PHONE_NUMBER_ID}/messages`, {
        messaging_product: "whatsapp", to, type: "template",
        template: { name: NEWTPL, language: { code: "en" }, components: [
          { type: "body", parameters: [name, (kind === "job" ? `Delivery request${routeClean ? ": " + routeClean : ""}` : "Someone opened your rider profile") + (noteClean ? " · " + noteClean : ""),
            contactVar, rider.active ? "👇 Tap below and verify your ID to unlock jobs." : "👇 Tap *Activate Now* below to unlock the customer and take jobs."]
            .map(v => ({ type: "text", text: String(v).slice(0, 1024) })) },
          { type: "button", sub_type: "quick_reply", index: "0", parameters: [{ type: "payload", payload: rider.active ? "biker_photo" : "biker_activate" }] }
        ] }
      }, { headers: { Authorization: `Bearer ${ACCESS_TOKEN}`, "Content-Type": "application/json" }, timeout: 15000 });
      ok = true;
    } catch (e) { error = e?.response?.data?.error?.message || e.message; }
  }
  // 2) Approved fallback templates (same as sellers' profile-view alerts)
  if (!ok) {
    try {
      await _sendTemplate(to, showFull ? "supplier_link_opened_with_phone" : "supplier_link_opened",
        showFull ? [name, line, timeStr, displayPhone(visitorPhone)] : [name, line, timeStr]);
      ok = true; error = "";
    } catch (e) { error = e?.response?.data?.error?.message || e.message; }
  }
  // 3) Inside the 24h window plain text still works
  if (!ok) {
    ok = await say(to, `${kind === "job" ? "🔔" : "👀"} *${name}* - ${line}${showFull ? `\n📞 ${displayPhone(visitorPhone)}` : ""}`).then(Boolean).catch(() => false);
  }
  if (dryRunTo) return { ok, error };

  // Not ready yet → their next message shows the masked lead + how to unlock.
  if (ok && !ready) {
    await UserSession.updateOne({ phone: normPhone(rider.phone) }, { $set: { "tempData.bikerLead": {
      kind, via, note: noteClean, route: routeClean, masked: showMask ? maskPhone(visitorPhone) : "", jobId: jobId ? String(jobId) : "",
      until: Date.now() + 72 * 3600000
    } } }, { upsert: true }).catch(() => {});
  }
  await BikerActivity.create({
    riderId: rider._id, riderPhone: normPhone(rider.phone), riderName: name, kind, source, visitorPhone: normPhone(visitorPhone) || "",
    note: noteClean, route: routeClean, jobId: jobId || null, contactShown: showFull, riderReady: ready, alertSent: ok, createdBy
  }).catch(() => {});
  return { ok, error, masked: showMask, shown: showFull, ready };
}

// ═════════════════════════════════════════════════════════════════════════════
// ADMIN API  (used by routes/bikerAdmin.js)
// ═════════════════════════════════════════════════════════════════════════════
export async function adminCreateJob({ customerPhone, customerName = "", task, pickup, dropoff, city = "", when = "Now",
                                       assignRiderId = null, fare = "", notifyCustomer = true, adminName = "admin",
                                       targetRiderIds = [], alsoDispatch = true }) {
  const phone = normPhone(customerPhone);
  if (!phone || phone.length < 11) throw new Error("A valid customer phone is required.");
  if (!pickup || !dropoff) throw new Error("Pickup and drop-off are required.");
  const det = detectCity(`${pickup} | ${dropoff} | ${task || ""}`);
  const finalCity = titleCity(city || det.city || "Harare");
  const ctx = { from: phone, phone, sess: { state: "", data: {}, lastCity: finalCity } };

  // Direct assignment: create without alerting other riders, then assign.
  const job = await createAndDispatchJob(ctx, {
    task: task || "Delivery", pickup, dropoff, city: finalCity, when, customerName,
    preferredRiderId: null
  }, { source: "admin", adminName, silent: true, noDispatch: !!(assignRiderId && isObjId(assignRiderId)) || (targetRiderIds || []).length > 0 });
  if (!job) throw new Error("Could not create the job.");

  // Manual request to CHOSEN riders: ready riders get the normal job alert;
  // unpaid / unverified riders get a masked teaser + "activate / verify to unlock".
  const targets = { alerted: 0, teased: 0, failed: 0 };
  const ids = (targetRiderIds || []).filter(isObjId);
  if (ids.length && !(assignRiderId && isObjId(assignRiderId))) {
    const riders = await SupplierProfile.find({ _id: { $in: ids }, profileType: "biker", suspended: { $ne: true } }).lean().catch(() => []);
    const ready = riders.filter(canTakeJobs);
    if (ready.length) {
      await BikerJob.updateOne({ _id: job._id }, { $addToSet: { notifiedRiderPhones: { $each: ready.map(r => normPhone(r.phone)) } }, $set: { lastNotifiedAt: new Date() } }).catch(() => {});
      const out = await Promise.allSettled(ready.map(r => notifyRiderNewJob(r, job)));
      targets.alerted = out.filter(o => o.status === "fulfilled").length;
    }
    for (const r of riders.filter(r => !canTakeJobs(r))) {
      const o = await sendRiderActivityAlert({ rider: r, kind: "job", route: `${job.pickup} → ${job.dropoff}`, note: job.task,
        visitorPhone: phone, contactMode: "mask", source: "manual request", jobId: job._id, createdBy: adminName }).catch(() => ({ ok: false }));
      if (o.ok) targets.teased++; else targets.failed++;
    }
    if (alsoDispatch) await dispatchJob(await BikerJob.findById(job._id).lean()).catch(() => 0);
  }

  if (assignRiderId && isObjId(assignRiderId)) {
    await adminAssignJob(job._id, assignRiderId, fare, adminName);
  } else if (notifyCustomer) {
    await notifyParty(phone, {
      ref: jobRef(job), line: `Your delivery ${pickup} to ${dropoff} was logged. Rider prices will arrive here.`,
      text: `🏍️ *ZimQuote logged your delivery* (${jobRef(job)})\n📦 ${job.task}\n📍 ${pickup} → ${dropoff}\n🏙 ${finalCity}\n\nRiders have been alerted - their prices will arrive here. Tap *Choose* on the one you like.`,
      buttons: [{ id: `biker_cx_${job._id}`, title: "❌ Cancel request" }, { id: "biker_mydel", title: "📦 My Deliveries" }]
    });
  }
  const out = await BikerJob.findById(job._id).lean();
  return Object.assign(out || {}, { _targets: targets });
}

export async function adminAssignJob(jobId, riderId, fare = "", adminName = "admin") {
  const job = await BikerJob.findById(jobId).lean();
  if (!job) throw new Error("Job not found.");
  if (job.status !== "open") throw new Error(`Job is ${job.status} - only open jobs can be assigned.`);
  const rider = await SupplierProfile.findById(riderId).lean();
  if (!rider || rider.profileType !== "biker") throw new Error("Rider not found.");
  const existing = (job.responses || []).find(r => normPhone(r.riderPhone) === normPhone(rider.phone));
  const f = fare ? parseFare(fare) : { ok: false };
  const resp = existing && !fare ? existing : {
    riderId: rider._id, riderPhone: normPhone(rider.phone), riderName: publicName(rider), plate: rider.bike?.plate || "",
    fare: f.ok ? f.fare : (fare || ""), fareAmount: f.ok ? f.amount : null, eta: f.ok ? f.eta : "",
    verified: isRiderVerified(rider), rating: Number(rider.rating) || 0, points: Number(rider.riderPoints) || 0, trips: rider.completedTrips || 0,
    respondedAt: new Date()
  };
  const res = await assignRider(job, resp, { by: "admin", adminName });
  if (!res) throw new Error("Could not assign - the job changed. Refresh and try again.");
  return res;
}

export async function adminCancelJob(jobId, reason = "Cancelled by admin") {
  const job = await BikerJob.findById(jobId).lean();
  if (!job) throw new Error("Job not found.");
  const r = await customerCancel(null, job, "admin", reason, { by: "admin" });
  if (!r) throw new Error(`Job is ${job.status} - cannot cancel.`);
  return r;
}

export async function adminCompleteJob(jobId, { awardPoints = true } = {}) {
  const job = await BikerJob.findById(jobId).lean();
  if (!job) throw new Error("Job not found.");
  if (job.disputed) await BikerJob.updateOne({ _id: job._id }, { $set: { disputed: false, disputeResolved: true } });
  if (!awardPoints) {
    const x = await BikerJob.findOneAndUpdate({ _id: job._id, status: { $in: ["assigned", "picked_up", "delivered"] } },
      { $set: { status: "completed", completedAt: new Date(), completedBy: "admin" }, $push: { history: { by: "admin", event: "completed", note: "no points" } } }, { new: true }).lean();
    if (!x) throw new Error(`Job is ${job.status} - cannot complete.`);
    if (x.assignedRiderPhone) await addRiderPoints(x.assignedRiderPhone, 0, { completedTrips: 1 });
    return x;
  }
  const x = await completeJob(job._id, { by: "admin" });
  if (!x) throw new Error(`Job is ${job.status} - cannot complete.`);
  return x;
}

export async function adminRedispatchJob(jobId) {
  const job = await BikerJob.findById(jobId).lean();
  if (!job) throw new Error("Job not found.");
  if (job.status === "expired") {
    await BikerJob.updateOne({ _id: job._id }, { $set: { status: "open", openSince: new Date(), repingCount: 0 }, $push: { history: { by: "admin", event: "reopened" } } });
  } else if (job.status !== "open") throw new Error(`Job is ${job.status} - only open/expired jobs can be re-sent.`);
  const fresh = await BikerJob.findById(jobId).lean();
  return dispatchJob(fresh, { expand: true });
}

export async function adminResolveDispute(jobId, { outcome = "rider_ok", note = "" } = {}) {
  const job = await BikerJob.findById(jobId).lean();
  if (!job) throw new Error("Job not found.");
  await BikerJob.updateOne({ _id: job._id }, { $set: { disputed: false, disputeResolved: true, adminNote: note },
    $push: { history: { by: "admin", event: "admin", note: `dispute: ${outcome}${note ? " - " + note : ""}` } } });
  if (outcome === "rider_ok" && job.status !== "completed") return completeJob(job._id, { by: "admin", note: "dispute resolved for rider" });
  if (outcome === "rider_fault" && job.assignedRiderPhone) {
    await addRiderPoints(job.assignedRiderPhone, -15, { riderDisputesLost: 1 });
    if (job.status !== "completed") await BikerJob.updateOne({ _id: job._id }, { $set: { status: "completed", completedAt: new Date(), completedBy: "admin" } });
  }
  return BikerJob.findById(jobId).lean();
}

// Approve / reject a rider's identity check (admin).
export async function adminReviewKyc(riderId, { action, reason = "", idLast4 = "", checks = {}, by = "admin" } = {}) {
  const r = await SupplierProfile.findById(riderId).lean();
  if (!r || r.profileType !== "biker") throw new Error("Rider not found.");
  if (action === "approve") {
    if (!checks.name || !checks.face || !checks.plate) throw new Error("Tick all three checks (name on ID, face, plate) before approving.");
    await updateRider({ _id: r._id }, { $set: {
      "riderKyc.status": "approved", "riderKyc.reviewedAt": new Date(), "riderKyc.reviewedBy": by, "riderKyc.rejectReason": "",
      "riderKyc.nameMatch": true, "riderKyc.faceMatch": true, "riderKyc.plateMatch": true,
      ...(idLast4 ? { "riderKyc.idLast4": String(idLast4).trim().slice(-4).toUpperCase() } : {}),
      "bike.verifiedAt": new Date(), "bike.idOnFile": true
    } });
    invalidateRiderCache(r.phone);
    await notifyParty(r.phone, {
      ref: "ID", line: r.active ? "Your ID is approved - you'll now get delivery jobs." : "Your ID is approved - activate your account to get jobs.",
      text: `✅ *Your ID is approved!* You're a 🪪 verified ZimQuote rider.\n\n` +
        (r.active ? "Job alerts are now ON - stay online to get deliveries." : "Last step: activate your account to start getting jobs."),
      buttons: [r.active ? { id: "biker_openjobs", title: "🔔 Open Jobs" } : { id: "biker_activate", title: "💳 Activate" }, { id: "biker_menu", title: "🏍️ Rider Menu" }]
    }).catch(() => {});
    return "approved";
  }
  if (action === "reject") {
    const why = String(reason || "Photos not clear").trim().slice(0, 140);
    await updateRider({ _id: r._id }, { $set: {
      "riderKyc.status": "rejected", "riderKyc.reviewedAt": new Date(), "riderKyc.reviewedBy": by, "riderKyc.rejectReason": why,
      "bike.verifiedAt": null
    } });
    invalidateRiderCache(r.phone);
    await notifyParty(r.phone, {
      ref: "ID", line: `Your ID check was not approved: ${why}. Reply to send new photos.`,
      text: `⚠️ *Your ID check was not approved*\nReason: ${why}\n\nPlease send new photos - it takes 1 minute.`,
      buttons: [{ id: "biker_photo_again", title: "📸 Send new photos" }, { id: "biker_menu", title: "🏍️ Rider Menu" }]
    }).catch(() => {});
    return "rejected";
  }
  if (action === "reset") {
    await updateRider({ _id: r._id }, { $set: { "riderKyc.status": "none", "bike.verifiedAt": null } });
    invalidateRiderCache(r.phone);
    return "reset";
  }
  throw new Error("Unknown action.");
}

export async function adminMessage(phone, text) {
  return say(normPhone(phone), text);
}

export default {
  handleBikerMessage, startBikerRegistration, startRiderRequest, sendRiderMenu,
  sweepBikerJobs, adminCreateJob, adminAssignJob, adminCancelJob, adminCompleteJob,
  adminRedispatchJob, adminResolveDispute, addRiderPoints, riderLevel, riderLink, getRider,
  isRiderVerified, canTakeJobs, publicName, maskPhone, sendRiderActivityAlert, notifyRiderProfileView, adminReviewKyc
};