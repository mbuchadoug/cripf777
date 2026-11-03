// services/bikerDispatch.js
// ═════════════════════════════════════════════════════════════════════════════
// ZimQuote BIKERS (riders / couriers) - self-contained dispatch engine
// ─────────────────────────────────────────────────────────────────────────────
// A biker is a SupplierProfile with profileType "biker" (rides on the SAME rails
// as tutors: EcoCash activation, smart links, ratings). A "job" is a customer
// request for a rider, stored in the isolated BikerJob model.
//
// This module is ADDITIVE and ISOLATED. The chatbot calls ONE function early in
// its pipeline:
//
//     const handled = await handleBikerMessage({ from, text, action, biz, saveBiz });
//     if (handled) return;                     // biker flow took the message
//
// Because it runs BEFORE the product/city search blocks and OWNS every "biker_"
// session state and action, typed input (incl. a city name) inside a biker flow
// can NEVER fall through to the generic "Which city?" selector. That is the fix
// for the select-city error, by construction.
//
// Registration FINISHES by handing off to the existing, already-fixed
// "sup_plan_basic_monthly" → supplier_reg_enter_ecocash → PAY-GUARD payment path.
// No new payment code, no new payment hook.
// ═════════════════════════════════════════════════════════════════════════════

import axios from "axios";
import crypto from "crypto";
import { sendText, sendButtons, sendList } from "./metaSender.js";
import { _sendTemplate } from "./buyerRequestNotifications.js";
import { SUPPLIER_CITIES } from "./supplierPlans.js";
import SupplierProfile from "../models/supplierProfile.js";
import BikerJob from "../models/bikerJob.js";

// ── Meta template plumbing (same env the rest of the app uses) ───────────────
const GRAPH_API_VERSION = "v24.0";
const PHONE_NUMBER_ID =
  process.env.WHATSAPP_PHONE_NUMBER_ID ||
  process.env.META_PHONE_NUMBER_ID ||
  process.env.PHONE_NUMBER_ID;
const ACCESS_TOKEN =
  process.env.META_ACCESS_TOKEN ||
  process.env.WHATSAPP_ACCESS_TOKEN;

// How many riders to ping per job, and how many cities to show as tappable rows.
const MAX_RIDERS_PER_JOB = 8;
const CITY_ROWS = SUPPLIER_CITIES.slice(0, 9);

// ── Helpers ───────────────────────────────────────────────────────────────────
function normPhone(raw = "") {
  let p = String(raw).replace(/\D+/g, "");
  if (p.startsWith("0") && p.length === 10) p = "263" + p.slice(1);
  return p;
}
function displayPhone(raw = "") {
  const d = normPhone(raw);
  if (d.startsWith("263") && d.length >= 12) return `+263 ${d.slice(3, 5)} ${d.slice(5, 8)} ${d.slice(8)}`;
  return `+${d}`;
}
function titleCity(s = "") {
  const t = String(s).trim();
  const hit = SUPPLIER_CITIES.find(c => c.toLowerCase() === t.toLowerCase());
  return hit || (t ? t.charAt(0).toUpperCase() + t.slice(1) : "");
}
function cityEq(a = "", b = "") {
  return String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
}
function jobRef(id) {
  return `RIDE-${String(id).slice(-4).toUpperCase()}`;
}
// Split "CBD to Avondale" / "CBD → Avondale" / "from CBD to Avondale" / "CBD - Avondale"
// into { pickup, dropoff }. Returns empty strings if it can't find two places.
function splitRoute(raw = "") {
  let s = String(raw || "").trim().replace(/^from\s+/i, "");
  let parts = s.split(/\s*(?:→|->|=>|-|–)\s*|\s+to\s+/i).map(x => x.trim()).filter(Boolean);
  if (parts.length >= 2) return { pickup: parts[0].slice(0, 120), dropoff: parts.slice(1).join(" to ").slice(0, 120) };
  parts = s.split(/\s+-\s+/).map(x => x.trim()).filter(Boolean);
  if (parts.length >= 2) return { pickup: parts[0].slice(0, 120), dropoff: parts[1].slice(0, 120) };
  return { pickup: "", dropoff: "" };
}
// Parse one combined message: "<what>, <from> to <to>"  OR  "<what> from X to Y".
function parseWhatWhere(raw = "") {
  const s = String(raw || "").trim();
  if (s.includes(",")) {
    const i = s.indexOf(",");
    const task = s.slice(0, i).trim();
    const { pickup, dropoff } = splitRoute(s.slice(i + 1));
    return { task: task.slice(0, 200), pickup, dropoff };
  }
  // no comma: try to find a route inside the whole sentence
  const { pickup, dropoff } = splitRoute(s);
  return { task: s.slice(0, 200), pickup, dropoff };
}
function isEscape(text) {
  return /^(0|00|menu|main menu|back|cancel|exit|home|stop)$/i.test(String(text || "").trim());
}
async function _save(biz, saveBiz) {
  if (typeof saveBiz === "function") return saveBiz(biz);
  try {
    const Business = (await import("../models/business.js")).default;
    if (biz?._id) return Business.findByIdAndUpdate(biz._id, biz);
  } catch (_) {}
}

// Standalone keyword that STARTS a "request a rider" (short, exact-ish messages only,
// so we never hijack a normal product/service search).
const RIDER_REQUEST_RE =
  /^(request\s+(a\s+)?rider|find\s+(a\s+)?rider|need\s+(a\s+)?rider|i\s+want\s+(a\s+)?rider|get\s+(a\s+)?rider|rider|biker|boda|courier\s+rider)$/i;

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC ENTRY - called once, early, by chatbotEngine.
// Returns true  → this module handled the message (engine must `return`).
// Returns false → not a biker message (engine continues normally).
// ─────────────────────────────────────────────────────────────────────────────
export async function handleBikerMessage({ from, text = "", action = "", biz = null, saveBiz = null }) {
  try {
    const a   = String(action || "").trim();
    const txt = String(text || "").trim();
    const state = biz?.sessionState || "";

    // 1) Continue an in-progress biker flow (state owns the message).
    if (state.startsWith("biker_")) {
      if (isEscape(txt)) {                 // let the user bail out cleanly
        biz.sessionState = "ready";
        if (biz.sessionData) { delete biz.sessionData.bikerReg; delete biz.sessionData.bikerJob; }
        await _save(biz, saveBiz);
        return false;                      // hand back to engine (shows menu)
      }
      return _routeState({ from, txt, a, biz, saveBiz, state });
    }

    // 2) Action taps that belong to bikers.
    if (a === "reg_type_biker")        return startBikerRegistration({ from, biz, saveBiz });
    if (a === "biker_request_rider")   return startRiderRequest({ from, biz, saveBiz });
    if (a === "biker_my_account" || a === "biker_toggle_online")
                                       return bikerAccount({ from, biz, saveBiz, toggle: a === "biker_toggle_online" });
    if (a.startsWith("biker_regcity_"))  return _regCityPicked({ from, biz, saveBiz, city: a.replace("biker_regcity_", "") });
    if (a.startsWith("biker_reqcity_"))  return _reqCityPicked({ from, biz, saveBiz, city: a.replace("biker_reqcity_", "") });
    if (a.startsWith("biker_when_"))     return _reqWhenPicked({ from, biz, saveBiz, when: a.replace("biker_when_", "") });
    if (a.startsWith("biker_accept_"))   return _riderAccept({ from, biz, saveBiz, jobId: a.replace("biker_accept_", "") });
    if (a.startsWith("biker_busy_"))     return _riderBusy({ from, jobId: a.replace("biker_busy_", "") });
    if (a.startsWith("biker_choose_"))   return _customerChoose({ from, saveBiz, payload: a.replace("biker_choose_", "") });
    if (a.startsWith("biker_skipphoto")) return _regPhoto({ from, biz, saveBiz, imageUrl: null });
    if (a === "biker_areas_whole")       return _regAreas({ from, biz, saveBiz, areas: "__whole__" });

    // 3) Group link  ZQ:BGROUP:<city>
    if (/^ZQ:BGROUP:/i.test(txt)) return _bikerGroupLink({ from, slug: txt.replace(/^ZQ:BGROUP:/i, "").trim() });

    // 4) Keyword entry (only when it is NOT a button tap).
    if (!a && RIDER_REQUEST_RE.test(txt)) return startRiderRequest({ from, biz, saveBiz });
    if (!a && /^(become a rider|register as rider|list as rider|rider signup|i am a rider|im a rider)$/i.test(txt))
      return startBikerRegistration({ from, biz, saveBiz });

    return false;
  } catch (err) {
    console.error("[BIKER] handleBikerMessage error:", err.message, err.stack);
    try { await sendText(from, "❌ Something went wrong with the rider service. Please type *menu* to continue."); } catch (_) {}
    return true; // we already messaged the user; don't let the engine double-handle
  }
}

// Route an in-progress state to its step handler.
async function _routeState({ from, txt, a, biz, saveBiz, state }) {
  // Registration states
  if (state === "biker_reg_name")   return _regName({ from, biz, saveBiz, name: txt });
  if (state === "biker_reg_city")   return _regCityPicked({ from, biz, saveBiz, city: a.startsWith("biker_regcity_") ? a.replace("biker_regcity_", "") : txt });
  if (state === "biker_reg_areas")  return _regAreas({ from, biz, saveBiz, areas: a === "biker_areas_whole" ? "__whole__" : txt });
  if (state === "biker_reg_plate")  return _regPlate({ from, biz, saveBiz, plate: txt });
  if (state === "biker_reg_photo")  return _regPhoto({ from, biz, saveBiz, imageUrl: null }); // photo arrives via engine image handler; typed = skip
  // Request states (fast flow: what+where → city → go)
  if (state === "biker_req_what")   return _reqWhat({ from, biz, saveBiz, raw: txt });
  if (state === "biker_req_route")  return _reqRoute({ from, biz, saveBiz, raw: txt });
  if (state === "biker_req_city")   return _reqCityPicked({ from, biz, saveBiz, city: a.startsWith("biker_reqcity_") ? a.replace("biker_reqcity_", "") : txt });
  // Rider entering a fare for a job
  if (state.startsWith("biker_fare_")) return _riderFare({ from, biz, saveBiz, jobId: state.replace("biker_fare_", ""), input: txt });
  return false;
}

// ═════════════════════════════════════════════════════════════════════════════
// REGISTRATION  (5 steps → existing EcoCash activation)
// ═════════════════════════════════════════════════════════════════════════════
export async function startBikerRegistration({ from, biz, saveBiz }) {
  const phone = normPhone(from);

  // Already a registered biker? Show the account menu instead of re-registering.
  const existing = await SupplierProfile.findOne({ phone, profileType: "biker" }).lean().catch(() => null);
  if (existing && existing.active) {
    return bikerAccount({ from, biz, saveBiz, existing });
  }

  if (biz) {
    biz.sessionState = "biker_reg_name";
    biz.sessionData = { ...(biz.sessionData || {}), bikerReg: {} };
    await _save(biz, saveBiz);
  }
  await sendText(from,
    "🏍️ *Become a ZimQuote Rider*\n\n" +
    "Get delivery jobs on WhatsApp. Keep 100% of every fare. Just $5/month.\n\n" +
    "Quick setup - 4 short steps.\n\n" +
    "*1. Your name?*\n_e.g. Tapiwa Moyo_"
  );
  return true;
}

async function _regName({ from, biz, saveBiz, name }) {
  if (!name || name.length < 2) { await sendText(from, "Please type your name."); return true; }
  biz.sessionData.bikerReg = { ...(biz.sessionData.bikerReg || {}), name: name.slice(0, 60) };
  biz.sessionState = "biker_reg_city";
  await _save(biz, saveBiz);
  await sendList(from,
    `👍 Thanks ${name.split(/\s+/)[0]}!\n\n*2. Which city do you ride in?*\n(Tap one, or just type your city.)`,
    CITY_ROWS.map(c => ({ id: `biker_regcity_${c}`, title: c }))
  );
  return true;
}

async function _regCityPicked({ from, biz, saveBiz, city }) {
  const c = titleCity(city);
  if (!c) { await sendText(from, "Please tap or type your city."); return true; }
  biz.sessionData.bikerReg = { ...(biz.sessionData.bikerReg || {}), city: c };
  biz.sessionState = "biker_reg_areas";
  await _save(biz, saveBiz);
  await sendButtons(from, {
    text:
      `📍 *${c}*.\n\n*3. Which areas do you cover?*\n` +
      `Type them with commas - _e.g. CBD, Avondale, Mount Pleasant_\n\n` +
      `Or tap *Whole city* to get jobs from anywhere in ${c}.`,
    buttons: [{ id: "biker_areas_whole", title: `🌍 Whole city` }]
  });
  return true;
}

async function _regAreas({ from, biz, saveBiz, areas }) {
  let list;
  if (areas === "__whole__") {
    list = [];  // empty = covers the whole city
  } else {
    list = String(areas || "").split(",").map(s => s.trim()).filter(Boolean).slice(0, 12);
    if (!list.length) { await sendText(from, "Type the areas you cover (e.g. CBD, Avondale), or tap *Whole city*."); return true; }
  }
  biz.sessionData.bikerReg = { ...(biz.sessionData.bikerReg || {}), areas: list };
  biz.sessionState = "biker_reg_plate";
  await _save(biz, saveBiz);
  await sendText(from,
    `✅ Got it.\n\n*4. Your bike number plate?*\n_e.g. AEX 1234_`
  );
  return true;
}

async function _regPlate({ from, biz, saveBiz, plate }) {
  const p = String(plate || "").trim().toUpperCase().slice(0, 16);
  if (!p || p.length < 3) { await sendText(from, "Please type your bike number plate, e.g. AEX 1234."); return true; }
  const reg = { ...(biz.sessionData.bikerReg || {}), plate: p };
  biz.sessionData.bikerReg = reg;
  await _save(biz, saveBiz);
  // Straight to activation - no photo step. Riders can add a photo later from
  // "My Rider Account" to earn the ✅ Verified badge.
  await _finishBikerRegistration({ from, biz, saveBiz, reg });
  return true;
}

// Called by the engine's image handler (pass imageUrl) OR when the user skips.
export async function _regPhoto({ from, biz, saveBiz, imageUrl = null }) {
  const reg = biz?.sessionData?.bikerReg || {};
  reg.photoUrl = imageUrl || "";
  await _finishBikerRegistration({ from, biz, saveBiz, reg });
  return true;
}

async function _finishBikerRegistration({ from, biz, saveBiz, reg }) {
  const phone = normPhone(from);
  const name  = reg.name || "Rider";
  const city  = titleCity(reg.city || "Harare");
  const areas = Array.isArray(reg.areas) ? reg.areas : [];

  // Create the rider as an INACTIVE SupplierProfile - identical lifecycle to a
  // tutor: pending until the EcoCash payment activates it.
  let supplier;
  try {
    supplier = await SupplierProfile.create({
      phone,
      businessName: `${name} (Rider)`,
      businessId:   biz?._id || null,
      profileType:  "biker",
      location:     { city, area: areas[0] || city },
      riderAreas:   areas,
      riderActive:  true,
      bike: {
        plate:         reg.plate || "",
        licenceOnFile: false,
        idOnFile:      false,
        insurance:     false,
        photoUrl:      reg.photoUrl || ""
      },
      categories:         ["transport"],
      revealVisitorPhone: true,
      canViewContacts:    true,
      tier: "basic", tierRank: 1,
      subscriptionStatus: "pending",
      active: false
    });
  } catch (err) {
    console.error("[BIKER REG] create failed:", err.message);
    await sendText(from, "❌ Could not save your rider profile. Please type *menu* and try again.");
    biz.sessionState = "ready";
    await _save(biz, saveBiz);
    return;
  }

  // Hand off to the EXISTING plan/payment flow (same as tutors & other sellers).
  // Tapping the plan row routes into chatbotEngine's sup_plan_ handler →
  // supplier_reg_enter_ecocash → PAY-GUARD → handleSupplierRegistrationStates.
  biz.supplierProfileId = supplier._id;
  biz.isSupplier = true;
  if (!biz.name || String(biz.name).startsWith("pending_")) biz.name = `${name} (Rider)`;
  biz.sessionData = { ...(biz.sessionData || {}), pendingSupplierId: supplier._id.toString() };
  delete biz.sessionData.bikerReg;
  biz.sessionState = "supplier_reg_choose_plan";
  await _save(biz, saveBiz);

  await sendList(from,
    `✅ *Almost done, ${name.split(/\s+/)[0]}!*\n\n` +
    `Your rider profile is ready. Activate to start getting job requests:\n\n` +
    `• 📍 ${city} · ${areas.length ? areas.join(", ") : "Whole city"}\n` +
    `• 🏍️ Plate: ${reg.plate || "-"}\n\n` +
    `_Pay by EcoCash on the next step. Tip: add a photo later in My Rider Account to get a ✅ Verified badge._`,
    [
      { id: "sup_plan_basic_monthly", title: "✅ Activate - $5/month", description: "Get delivery jobs on WhatsApp" },
      { id: "sup_plan_basic_annual",  title: "⭐ Save - $50/year",     description: "2 months free" }
    ]
  );
  return;
}

// ═════════════════════════════════════════════════════════════════════════════
// RIDER ACCOUNT  (online/offline toggle + status)
// ═════════════════════════════════════════════════════════════════════════════
export async function bikerAccount({ from, biz, saveBiz, toggle = false, existing = null }) {
  const phone = normPhone(from);
  const rider = existing || await SupplierProfile.findOne({ phone, profileType: "biker" }).lean().catch(() => null);
  if (!rider) { return startBikerRegistration({ from, biz, saveBiz }); }

  if (toggle) {
    const now = !rider.riderActive;
    await SupplierProfile.updateOne({ _id: rider._id }, { $set: { riderActive: now } }).catch(() => {});
    rider.riderActive = now;
  }
  const online = rider.riderActive !== false;
  const verified = !!rider.bike?.verifiedAt;
  await sendButtons(from, {
    text:
      `🏍️ *Your Rider Account*\n\n` +
      `${online ? "🟢 You're ONLINE - you'll get job alerts." : "⚪ You're OFFLINE - no alerts."}\n` +
      `${verified ? "✅ Verified" : "⏳ Verification pending"}\n` +
      `📍 ${rider.location?.city || ""}${(rider.riderAreas || []).length ? " · " + rider.riderAreas.join(", ") : ""}\n` +
      `⭐ ${Number(rider.rating || 0).toFixed(1)} · ${rider.completedTrips || 0} trips\n\n` +
      (rider.active ? "" : "⚠️ Your subscription is not active. Reply *menu* → become a rider to activate.\n\n") +
      `_Toggle below to go on/off duty._`,
    buttons: [
      { id: "biker_toggle_online", title: online ? "⏸ Go OFFLINE" : "▶️ Go ONLINE" },
      { id: "main_menu_back",      title: "🏠 Main Menu" }
    ]
  });
  return true;
}

// ═════════════════════════════════════════════════════════════════════════════
// REQUEST A RIDER  (customer side, 5 taps → match → notify)
// ═════════════════════════════════════════════════════════════════════════════
export async function startRiderRequest({ from, biz, saveBiz }) {
  if (biz) {
    biz.sessionState = "biker_req_what";
    biz.sessionData = { ...(biz.sessionData || {}), bikerJob: {} };
    await _save(biz, saveBiz);
  }
  // ONE message captures what + where. Default time is "Now" (no extra step).
  await sendText(from,
    "🏍️ *Request a Rider*\n\n" +
    "In *one message*, tell us *what* you need and *where* (from → to):\n\n" +
    "📝 _Collect documents, CBD to Avondale_\n" +
    "📝 _Buy & deliver 2 loaves, Mbare to Highfield_\n" +
    "📝 _Pick parcel from Joina City to Borrowdale_"
  );
  return true;
}

// Step 1: combined what + where. If the route is clear, go straight to city.
async function _reqWhat({ from, biz, saveBiz, raw }) {
  if (!raw || raw.length < 3) {
    await sendText(from, "Please tell us what you need and where.\n_e.g. Collect documents, CBD to Avondale_");
    return true;
  }
  const { task, pickup, dropoff } = parseWhatWhere(raw);
  biz.sessionData.bikerJob = { ...(biz.sessionData.bikerJob || {}), task, pickup, dropoff };
  if (pickup && dropoff) {
    biz.sessionState = "biker_req_city";
    await _save(biz, saveBiz);
    return _askReqCity(from, biz, saveBiz, { pickup, dropoff });
  }
  // Route unclear → one quick follow-up, keep the task.
  biz.sessionState = "biker_req_route";
  await _save(biz, saveBiz);
  await sendText(from,
    "📍 *From → To?* (one line)\n" +
    "_e.g. CBD to Avondale_"
  );
  return true;
}

// Step 1b (only if route wasn't clear): capture "from → to".
async function _reqRoute({ from, biz, saveBiz, raw }) {
  const { pickup, dropoff } = splitRoute(raw);
  if (!pickup || !dropoff) {
    await sendText(from, "Please send it as *from → to*.\n_e.g. CBD to Avondale_");
    return true;
  }
  biz.sessionData.bikerJob = { ...(biz.sessionData.bikerJob || {}), pickup, dropoff };
  biz.sessionState = "biker_req_city";
  await _save(biz, saveBiz);
  return _askReqCity(from, biz, saveBiz, { pickup, dropoff });
}

async function _askReqCity(from, biz, saveBiz, { pickup, dropoff }) {
  await sendList(from,
    `📍 *${pickup} → ${dropoff}*\n\nLast thing - *which city?* (tap one, or type it)`,
    CITY_ROWS.map(c => ({ id: `biker_reqcity_${c}`, title: c }))
  );
  return true;
}

// Step 2: city → dispatch immediately (time defaults to "Now").
async function _reqCityPicked({ from, biz, saveBiz, city }) {
  const c = titleCity(city);
  if (!c) { await sendText(from, "Please tap or type the city."); return true; }
  biz.sessionData.bikerJob = { ...(biz.sessionData.bikerJob || {}), city: c, when: "Now" };
  await _save(biz, saveBiz);
  return _createAndDispatchJob({ from, biz, saveBiz });
}

async function _createAndDispatchJob({ from, biz, saveBiz }) {
  const req = biz?.sessionData?.bikerJob || {};
  const phone = normPhone(from);
  const city  = titleCity(req.city || "Harare");

  let job;
  try {
    const reference = `RIDE-${crypto.randomUUID()}`;
    job = await BikerJob.create({
      reference,
      customerPhone: phone,
      task:    req.task || "",
      city,
      pickup:  req.pickup || "",
      dropoff: req.dropoff || "",
      when:    req.when || "Now",
      status:  "open",
      lastNotifiedAt: new Date()
    });
  } catch (err) {
    console.error("[BIKER JOB] create failed:", err.message);
    await sendText(from, "❌ Could not create your request. Please type *menu* and try again.");
    biz.sessionState = "ready";
    await _save(biz, saveBiz);
    return true;
  }

  // Clear the customer's capture state.
  biz.sessionState = "ready";
  if (biz.sessionData) delete biz.sessionData.bikerJob;
  await _save(biz, saveBiz);

  // Find & notify riders.
  const riders = await _matchRiders(city, req.pickup || "");
  const ref = jobRef(job._id);

  if (!riders.length) {
    await sendButtons(from, {
      text:
        `🔎 *No riders are online in ${city} right now* (${ref}).\n\n` +
        `Your request is saved - we'll alert riders as they come online and connect you here on WhatsApp.`,
      buttons: [{ id: "biker_request_rider", title: "🔁 Try Again" }, { id: "main_menu_back", title: "🏠 Menu" }]
    });
    return true;
  }

  await Promise.allSettled(riders.map(r => _notifyRiderNewJob(r, job, ref)));
  await BikerJob.updateOne(
    { _id: job._id },
    { $set: { notifiedRiderPhones: riders.map(r => normPhone(r.phone)), lastNotifiedAt: new Date() } }
  ).catch(() => {});

  await sendText(from,
    `✅ *Request sent!* (${ref})\n\n` +
    `📦 ${job.task}\n📍 ${job.pickup} → ${job.dropoff}\n🕒 ${job.when}\n\n` +
    `We've alerted *${riders.length}* rider${riders.length === 1 ? "" : "s"} near ${city}. ` +
    `You'll get their fare and ETA here as they respond. Pick the one you like and we'll connect you.`
  );
  return true;
}

// Rank: online first, then verified, then rating, then trips. Area match boosts.
async function _matchRiders(city, pickup) {
  const all = await SupplierProfile.find({
    profileType: "biker",
    active: true,
    suspended: { $ne: true }
  }).lean().catch(() => []);

  const pick = String(pickup || "").toLowerCase();
  const inCity = all.filter(r => cityEq(r.location?.city, city));
  const scored = inCity.map(r => {
    const areas = (r.riderAreas || []).map(x => String(x).toLowerCase());
    const areaMatch = pick && areas.some(ar => pick.includes(ar) || ar.includes(pick)) ? 1 : 0;
    return {
      r,
      score:
        (r.riderActive !== false ? 1000 : 0) +
        areaMatch * 500 +
        (r.bike?.verifiedAt ? 100 : 0) +
        (Number(r.rating) || 0) * 10 +
        (Number(r.completedTrips) || 0)
    };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, MAX_RIDERS_PER_JOB).map(s => s.r);
}

// ── Rider job notification (template with buttons, fallback to sendButtons) ──
async function _notifyRiderNewJob(rider, job, ref) {
  const phone = normPhone(rider.phone);
  const jobId = String(job._id);
  try {
    await _sendJobTemplate(phone, [
      job.task || "Errand", `${job.pickup} → ${job.dropoff}`, job.when || "Now", ref
    ], jobId);
    console.log(`[BIKER] zq_rider_new_job → ${phone} (${ref})`);
    return;
  } catch (err) {
    console.warn(`[BIKER] job template failed for ${phone}: ${err.message}. Falling back to buttons.`);
  }
  try {
    await sendButtons(phone, {
      text:
        `🏍️ *New job near you!* (${ref})\n\n` +
        `📦 ${job.task}\n📍 ${job.pickup} → ${job.dropoff}\n🕒 ${job.when}\n\n` +
        `Tap *I'll do it* and send your fare + ETA to take this job.`,
      buttons: [
        { id: `biker_accept_${jobId}`, title: "✅ I'll do it" },
        { id: `biker_busy_${jobId}`,   title: "❌ Busy" }
      ]
    });
  } catch (e) {
    console.warn(`[BIKER] job fallback failed for ${phone}: ${e.message}`);
  }
}

// Meta template with 2 quick-reply buttons (dynamic payloads). Mirrors the
// buyer-request v2 sender. Template name: zq_rider_new_job.
async function _sendJobTemplate(to, variables, jobId) {
  const phone = normPhone(to);
  const components = [
    { type: "body", parameters: variables.map(v => ({ type: "text", text: String(v).slice(0, 1024) })) },
    { type: "button", sub_type: "quick_reply", index: "0", parameters: [{ type: "payload", payload: `biker_accept_${jobId}` }] },
    { type: "button", sub_type: "quick_reply", index: "1", parameters: [{ type: "payload", payload: `biker_busy_${jobId}` }] }
  ];
  const res = await axios.post(
    `https://graph.facebook.com/${GRAPH_API_VERSION}/${PHONE_NUMBER_ID}/messages`,
    { messaging_product: "whatsapp", to: phone, type: "template",
      template: { name: "zq_rider_new_job", language: { code: "en" }, components } },
    { headers: { Authorization: `Bearer ${ACCESS_TOKEN}`, "Content-Type": "application/json" } }
  );
  return res.data;
}

// ═════════════════════════════════════════════════════════════════════════════
// RIDER RESPONDS
// ═════════════════════════════════════════════════════════════════════════════
async function _riderAccept({ from, biz, saveBiz, jobId }) {
  const job = await _getJob(jobId);
  if (!job || job.status !== "open") {
    await sendText(from, "⌛ That job is no longer available. We'll alert you when the next one comes in.");
    return true;
  }
  if (biz) {
    biz.sessionState = `biker_fare_${jobId}`;
    await _save(biz, saveBiz);
  }
  await sendText(from,
    `👍 Great! For *${jobRef(job._id)}* (${job.pickup} → ${job.dropoff})\n\n` +
    `Reply with your *fare and ETA* in one message.\n` +
    `_e.g. $3, 15 min_`
  );
  return true;
}

async function _riderBusy({ from, jobId }) {
  await sendText(from, "👌 No problem - marked as busy. We'll send you the next job.");
  return true;
}

async function _riderFare({ from, biz, saveBiz, jobId, input }) {
  const job = await _getJob(jobId);
  if (!job || job.status !== "open") {
    await sendText(from, "⌛ That job is no longer open.");
    if (biz) { biz.sessionState = "ready"; await _save(biz, saveBiz); }
    return true;
  }
  const phone = normPhone(from);
  const rider = await SupplierProfile.findOne({ phone, profileType: "biker" }).lean().catch(() => null);

  // Parse "fare, eta" (comma or " - " separated); be lenient.
  const parts = String(input || "").split(/[,|·\-–]| and /i).map(s => s.trim()).filter(Boolean);
  const fare = parts[0] || String(input || "").trim();
  const eta  = parts[1] || "";

  await BikerJob.updateOne(
    { _id: job._id, status: "open" },
    { $push: { responses: {
        riderId:   rider?._id || null,
        riderPhone: phone,
        riderName: rider?.businessName?.replace(/\s*\(Rider\)$/i, "") || "Rider",
        plate:     rider?.bike?.plate || "",
        fare, eta,
        verified:  !!rider?.bike?.verifiedAt,
        rating:    Number(rider?.rating) || 0,
        respondedAt: new Date()
    } } }
  ).catch(() => {});

  if (biz) { biz.sessionState = "ready"; await _save(biz, saveBiz); }
  await sendText(from, `✅ Sent to the customer! If they pick you, we'll share their number here. (${jobRef(job._id)})`);

  // Notify the customer that a rider responded.
  await _notifyCustomerResponder(job, {
    riderPhone: phone,
    riderName:  rider?.businessName?.replace(/\s*\(Rider\)$/i, "") || "Rider",
    plate:      rider?.bike?.plate || "",
    fare, eta,
    verified:   !!rider?.bike?.verifiedAt,
    rating:     Number(rider?.rating) || 0
  });
  return true;
}

async function _notifyCustomerResponder(job, resp) {
  const ref = jobRef(job._id);
  try {
    await sendButtons(job.customerPhone, {
      text:
        `🏍️ *A rider responded!* (${ref})\n\n` +
        `👤 ${resp.riderName}${resp.verified ? " ✅" : ""}${resp.rating ? ` · ⭐ ${resp.rating.toFixed(1)}` : ""}\n` +
        `🏍️ Plate: ${resp.plate || "-"}\n` +
        `💵 Fare: ${resp.fare || "-"}${resp.eta ? ` · ⏱ ${resp.eta}` : ""}\n\n` +
        `Tap *Choose* to connect with this rider.`,
      buttons: [
        { id: `biker_choose_${String(job._id)}__${normPhone(resp.riderPhone)}`, title: "✅ Choose this rider" },
        { id: "biker_request_rider", title: "🔁 New request" }
      ]
    });
  } catch (e) {
    console.warn(`[BIKER] customer notify failed: ${e.message}`);
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// CUSTOMER PICKS A RIDER → exchange contacts
// ═════════════════════════════════════════════════════════════════════════════
async function _customerChoose({ from, saveBiz, payload }) {
  const [jobId, riderPhone] = String(payload || "").split("__");
  const job = await _getJob(jobId);
  if (!job) { await sendText(from, "That request was not found."); return true; }
  if (job.status === "assigned" && normPhone(job.assignedRiderPhone) !== normPhone(riderPhone)) {
    await sendText(from, "You've already chosen a rider for this request.");
    return true;
  }

  const rPhone = normPhone(riderPhone);
  const resp = (job.responses || []).find(r => normPhone(r.riderPhone) === rPhone) || {};
  const rider = await SupplierProfile.findOne({ phone: rPhone, profileType: "biker" }).lean().catch(() => null);

  await BikerJob.updateOne(
    { _id: job._id },
    { $set: { status: "assigned", assignedRiderId: rider?._id || null, assignedRiderPhone: rPhone, assignedAt: new Date() } }
  ).catch(() => {});

  const ref = jobRef(job._id);
  // Tell the customer the rider's details.
  await sendText(from,
    `✅ *You're connected!* (${ref})\n\n` +
    `👤 ${resp.riderName || "Your rider"}${resp.verified ? " ✅" : ""}\n` +
    `🏍️ Plate: ${resp.plate || "-"}\n` +
    `💵 Fare: ${resp.fare || "agree on arrival"}${resp.eta ? ` · ⏱ ${resp.eta}` : ""}\n` +
    `📞 Call/chat: ${displayPhone(rPhone)}\n\n` +
    `🛡 *Stay safe:* agree the fare before pickup, share your live location, and pay on delivery (cash or EcoCash).`
  );
  // Tell the rider they got the job + the customer's number.
  try {
    await _sendTemplate(rPhone, "zq_rider_matched", [
      resp.riderName || "You", resp.plate || "-", resp.fare || "-", resp.eta || "-", displayPhone(job.customerPhone)
    ]).catch(async () => {
      await sendText(rPhone,
        `🎉 *You got the job!* (${ref})\n\n` +
        `📦 ${job.task}\n📍 ${job.pickup} → ${job.dropoff}\n🕒 ${job.when}\n` +
        `📞 Customer: ${displayPhone(job.customerPhone)}\n\n` +
        `Call them to confirm. Ride safe 🪖`
      );
    });
  } catch (e) {
    console.warn(`[BIKER] rider matched notify failed: ${e.message}`);
  }
  return true;
}

// ═════════════════════════════════════════════════════════════════════════════
// GROUP LINK  ZQ:BGROUP:<city>  - list online riders + "Become a Rider" CTA
// ═════════════════════════════════════════════════════════════════════════════
async function _bikerGroupLink({ from, slug }) {
  const city = titleCity(slug || "Harare");
  const riders = await SupplierProfile.find({
    profileType: "biker", active: true, suspended: { $ne: true }
  }).lean().catch(() => []);
  const inCity = riders.filter(r => cityEq(r.location?.city, city)).slice(0, 8);

  const ctaRow = { id: "reg_type_biker", title: "🏍️ Become a Rider", description: "List yourself & get delivery jobs" };
  if (!inCity.length) {
    await sendList(from,
      `🏍️ *ZimQuote Riders - ${city}*\n\nNo riders listed here yet. Be the first - or request one and we'll alert riders as they join.`,
      [{ id: "biker_request_rider", title: "📦 Request a Rider" }, ctaRow]
    );
    return true;
  }
  const rows = inCity.map(r => ({
    id: `biker_viewrider_${r._id}`,
    title: (r.businessName || "Rider").replace(/\s*\(Rider\)$/i, "").slice(0, 24),
    description: [(r.riderAreas || []).slice(0, 2).join(", "), r.bike?.verifiedAt ? "✅ Verified" : null].filter(Boolean).join(" · ") || undefined
  }));
  await sendList(from,
    `🏍️ *ZimQuote Riders - ${city}*\n\nRequest a rider for any errand, or become one yourself.`,
    [{ id: "biker_request_rider", title: "📦 Request a Rider" }, ...rows.slice(0, 8), ctaRow].slice(0, 10)
  );
  return true;
}

// ── internal ────────────────────────────────────────────────────────────────
async function _getJob(jobId) {
  if (!jobId || !/^[a-f0-9]{24}$/i.test(String(jobId))) return null;
  return BikerJob.findById(jobId).catch(() => null);
}

export default { handleBikerMessage, startBikerRegistration, startRiderRequest, bikerAccount };