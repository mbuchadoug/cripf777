// services/quoteDesk.js
// ═════════════════════════════════════════════════════════════════════════════
// ZimQuote "📝 Request a Quote" - a simple, admin-facilitated quote desk
// ─────────────────────────────────────────────────────────────────────────────
// WHY: "Request Sellers" confused people and the automatic matcher is not
// accurate enough to run unsupervised. So the customer does ONE simple thing
// (describe what they need), and ZimQuote - the admin - stays in control:
//
//   CUSTOMER  taps "📝 Request a Quote" → types what + where in one message
//             (photo optional) → gets a ref → later receives a PDF quotation
//             with ✅ Accept / 💬 Ask / ❌ No thanks. Can message ZimQuote anytime.
//
//   ADMIN     gets every request on WhatsApp (ZQ_ADMIN_PHONE) with buttons:
//             🏪 Pick sellers (suggested, admin chooses - final say)
//             🧾 Make quote   (type lines → PDF → sent to the customer)
//                             as a ZimQuote quote OR in a seller's name
//             ⚙️ More         (message customer, connect contacts, won/lost…)
//             The same is available on the web: /zq-admin/quote-desk
//
//   SELLER    gets the request (customer number hidden unless admin shares it),
//             replies with prices → goes to the ADMIN, never straight to the
//             customer. Admin forwards, turns it into a quote, or connects them.
//
// ENGINE:   const handled = await handleQuoteDesk({ from, text, action, biz, saveBiz, imageUrl });
//           if (handled) return;
//
// RELIABILITY: state in UserSession (atomic), per-phone lock, taps beat typed
// state, states expire, messages to customers outside WhatsApp's 24h window
// are queued and delivered the moment they message again (template nudge).
// ═════════════════════════════════════════════════════════════════════════════

import axios from "axios";
import { sendText, sendButtons, sendList, sendDocument, sendImage } from "./metaSender.js";
import { _sendTemplate } from "./buyerRequestNotifications.js";
import { detectCity, findPlaces, metroGroup } from "./bikerPlaces.js";
import QuoteRequest from "../models/quoteRequest.js";
import SupplierProfile from "../models/supplierProfile.js";
import UserSession from "../models/userSession.js";
import { getHouseBiz, bookQuote, convertQuoteToInvoice, recordInvoicePayment, recordCostOfSale, normMethod } from "./zqBooks.js";
import { nextDocNumber } from "./docNumbers.js";

// ── Config ────────────────────────────────────────────────────────────────────
const GRAPH = "v24.0";
const PNID  = () => process.env.WHATSAPP_PHONE_NUMBER_ID || process.env.META_PHONE_NUMBER_ID || process.env.PHONE_NUMBER_ID;
const TOKEN = () => process.env.META_ACCESS_TOKEN || process.env.WHATSAPP_ACCESS_TOKEN;
const SITE  = () => String(process.env.SITE_URL || "").replace(/\/$/, "");
const BOT   = () => String(process.env.ZQ_BOT_NUMBER || process.env.WHATSAPP_BOT_NUMBER || "263771143904").replace(/\D+/g, "");

// One or more admin phones (comma-separated). ZQ_QUOTE_ADMINS wins, else ZQ_ADMIN_PHONE.
export function adminPhones() {
  return String(process.env.ZQ_QUOTE_ADMINS || process.env.ZQ_ADMIN_PHONE || process.env.ADMIN_WHATSAPP_PHONE || "")
    .split(/[,\s]+/).map(normPhone).filter(p => p.length >= 11);
}
export function isQuoteAdmin(phone) { return adminPhones().includes(normPhone(phone)); }

export const QD_CONFIG = {
  STATE_TTL_MIN: 45,         // typed-text states expire
  EXTRA_WINDOW_MIN: 30,      // after submitting, photos / extra details are added to the request
  WINDOW_HOURS: 23,          // WhatsApp customer-service window (24h, with margin)
  SUGGEST_LIMIT: 15
};
const OPEN_STATUSES = ["new", "working", "sent_to_sellers", "quoted", "accepted"];
const STATUS_LABEL = {
  new: "🆕 New", working: "🛠 Working on it", sent_to_sellers: "🏪 With sellers", quoted: "🧾 Quoted",
  accepted: "✅ Accepted", won: "🏆 Done", lost: "➖ Not taken", closed: "🔒 Closed", cancelled: "❌ Cancelled"
};
const CUSTOMER_STATUS = {
  new: "Received - we're on it", working: "Getting prices", sent_to_sellers: "Getting prices",
  quoted: "Quotation sent", accepted: "Accepted - we'll arrange it", won: "Completed",
  lost: "Closed", closed: "Closed", cancelled: "Cancelled"
};

// ═════════════════════════════════════════════════════════════════════════════
// HELPERS
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
export function displayPhone(raw = "") {
  const d = normPhone(raw);
  if (d.startsWith("263") && d.length >= 12) return `+263 ${d.slice(3, 5)} ${d.slice(5, 8)} ${d.slice(8)}`;
  return d ? `+${d}` : "-";
}
function cut(s = "", n = 24) {
  const t = String(s || "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, Math.max(1, n - 1)) + "…" : t;
}
function money(n) { return `$${(Math.round((Number(n) || 0) * 100) / 100).toFixed(2)}`; }
function isObjId(s) { return /^[a-f0-9]{24}$/i.test(String(s || "")); }
function escRe(s = "") { return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function titleCase(s = "") { return String(s || "").trim().replace(/\b\w/g, c => c.toUpperCase()); }
export function qRef(doc) {
  return doc?.ref && /^QR-/.test(doc.ref) ? doc.ref : `QR-${String(doc?._id || doc).slice(-5).toUpperCase()}`;
}
function hararetime() {
  const h = Number(new Date().toLocaleString("en-GB", { hour: "2-digit", hour12: false, timeZone: "Africa/Harare" }));
  return Number.isFinite(h) ? h : 12;
}
function sellerName(s) { return String(s?.businessName || "Seller").trim(); }
function sellerIsActive(s) { return !!s?.active && ["active", "trial"].includes(String(s?.subscriptionStatus || "active")); }

// ── Safe senders (truncate to WhatsApp limits, never throw) ──────────────────
const _btns = b => b.filter(Boolean).slice(0, 3).map(x => ({ id: String(x.id).slice(0, 256), title: cut(x.title, 20) }));
const _rows = r => r.filter(Boolean).slice(0, 10).map(x => ({ id: String(x.id).slice(0, 200), title: cut(x.title, 24), ...(x.description ? { description: cut(x.description, 72) } : {}) }));
async function say(to, text) {
  try { await sendText(to, String(text).slice(0, 4000)); return true; }
  catch (e) { console.warn(`[QDESK] sendText → ${to}: ${e.message}`); return false; }
}
async function ask(to, text, buttons) {
  try { await sendButtons(to, { text: String(text).slice(0, 1020), buttons: _btns(buttons) }); return true; }
  catch (e) { console.warn(`[QDESK] sendButtons → ${to}: ${e.message}`); return say(to, text); }
}
async function pick(to, text, rows) {
  try { await sendList(to, String(text).slice(0, 1020), _rows(rows)); return true; }
  catch (e) { console.warn(`[QDESK] sendList → ${to}: ${e.message}`); return say(to, text); }
}
async function image(to, url, caption = "") {
  try { await sendImage(to, { imageUrl: url, caption: String(caption).slice(0, 1000) }); return true; }
  catch (e) { console.warn(`[QDESK] sendImage → ${to}: ${e.message}`); return say(to, `${caption}\n${url}`); }
}
async function toAdmins(text, buttons = null) {
  const list = adminPhones();
  if (!list.length) { console.warn("[QDESK] No ZQ_ADMIN_PHONE / ZQ_QUOTE_ADMINS set - admin alerts skipped"); return; }
  await Promise.allSettled(list.map(p => buttons ? ask(p, text, buttons) : say(p, text)));
}

// ── Per-phone lock (bursts / double taps processed in order) ─────────────────
const _locks = new Map();
function withLock(key, fn) {
  const prev = _locks.get(key) || Promise.resolve();
  let release; const mine = new Promise(r => (release = r));
  const chain = prev.then(() => mine);
  _locks.set(key, chain);
  return Promise.race([prev, new Promise(r => setTimeout(r, 20000))]).then(async () => {
    try { return await fn(); } finally { release(); if (_locks.get(key) === chain) _locks.delete(key); }
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// SESSION  (UserSession.tempData.qdState / qdData / qdAt / qdOpen / qdOutbox)
// ═════════════════════════════════════════════════════════════════════════════
async function getSess(phone) {
  const s = await UserSession.findOne({ phone }).lean().catch(() => null);
  const td = s?.tempData || {};
  let state = td.qdState || "";
  const at = td.qdAt ? new Date(td.qdAt).getTime() : 0;
  const ttl = (state.startsWith("qd_extra_") ? QD_CONFIG.EXTRA_WINDOW_MIN : QD_CONFIG.STATE_TTL_MIN) * 60000;
  if (state && at && Date.now() - at > ttl) { await clearState(phone); state = ""; }
  return {
    state, data: { ...(td.qdData || {}) },
    open: !!td.qdOpen, outbox: Array.isArray(td.qdOutbox) ? td.qdOutbox : [],
    lastCity: td.qdLastCity || td.bikerLastCity || ""
  };
}
async function setState(phone, state, data = {}, { photoMarker = false } = {}) {
  const $set = { "tempData.qdState": state, "tempData.qdData": data, "tempData.qdAt": new Date() };
  // Lets the existing webhook route an incoming photo here (it fires "__buyer_photo_uploaded__").
  if (photoMarker) $set["tempData.buyerRequestState"] = "awaiting_photo_upload";
  await UserSession.findOneAndUpdate({ phone }, { $set }, { upsert: true });
}
async function clearState(phone) {
  const s = await UserSession.findOne({ phone }, { "tempData.buyerRequestState": 1, "tempData.pendingBuyerRequest": 1 }).lean().catch(() => null);
  const $unset = { "tempData.qdState": "", "tempData.qdData": "", "tempData.qdAt": "" };
  // Remove our photo marker - but never touch a genuine old-flow request in progress.
  if (s?.tempData?.buyerRequestState === "awaiting_photo_upload" && !s?.tempData?.pendingBuyerRequest) $unset["tempData.buyerRequestState"] = "";
  await UserSession.findOneAndUpdate({ phone }, { $unset }, { upsert: true }).catch(() => {});
}
async function clearCompetingFlows(phone) {
  await UserSession.findOneAndUpdate({ phone }, { $unset: {
    "tempData.buyerRequestState": "", "tempData.pendingBuyerRequest": "", "tempData.buyerRequestMode": "",
    "tempData.tutorSearchActive": "", "tempData.schoolSearchActive": "", "tempData.instSearchActive": "",
    "tempData.tutorEnquiryState": "", "tempData.schoolEnquiryState": "", "tempData.supplierSearchMode": "",
    "tempData.grpListIds": "", "tempData.grpListType": "", "tempData.bikerState": "", "tempData.bikerData": ""
  } }, { upsert: true }).catch(() => {});
}
async function markOpen(phone, open = true) {
  await UserSession.findOneAndUpdate({ phone }, open ? { $set: { "tempData.qdOpen": true } } : { $unset: { "tempData.qdOpen": "" } }, { upsert: true }).catch(() => {});
}

// ═════════════════════════════════════════════════════════════════════════════
// CUSTOMER MESSAGING with 24h-window handling
// If the customer hasn't messaged in ~23h, WhatsApp won't deliver free-form
// messages. We queue the message (outbox), send a short approved template
// nudge, and deliver everything the moment they reply.
// ═════════════════════════════════════════════════════════════════════════════
function inWindow(req) {
  const t = req?.customerLastMsgAt ? new Date(req.customerLastMsgAt).getTime() : 0;
  return t && Date.now() - t < QD_CONFIG.WINDOW_HOURS * 3600e3;
}
async function deliverItem(to, item) {
  if (item.type === "doc") {
    try { await sendDocument(to, { link: item.link, filename: item.filename, caption: item.caption || "" }); }
    catch (e) { console.warn(`[QDESK] sendDocument → ${to}: ${e.message}`); await say(to, `${item.caption || "📄 Quotation"}\n${item.link}`); }
  } else if (item.type === "image") {
    await image(to, item.link, item.caption || "");
  }
  if (item.text) {
    if (item.rows?.length) await pick(to, item.text, item.rows);
    else if (item.buttons?.length) await ask(to, item.text, item.buttons);
    else await say(to, item.text);
  }
}
async function toCustomer(req, items, { nudge = "" } = {}) {
  const to = normPhone(req.customerPhone);
  const list = Array.isArray(items) ? items : [items];
  if (inWindow(req)) {
    for (const it of list) await deliverItem(to, it);
    return { delivered: true };
  }
  await UserSession.findOneAndUpdate({ phone: to }, { $push: { "tempData.qdOutbox": { $each: list.map(i => ({ ...i, reqId: String(req._id), at: new Date() })) } } }, { upsert: true }).catch(() => {});
  const line = cut(nudge || "We have an update on your request. Reply to this message to see it.", 900);
  try { await _sendTemplate(to, "zq_quote_update", [qRef(req), line]); }
  catch (e1) {
    try { await _sendTemplate(to, "supplier_clarification_request", [qRef(req), line]); }
    catch (e2) { console.warn(`[QDESK] no template could reach ${to}: ${e2.message}`); }
  }
  return { delivered: false };
}
async function flushOutbox(phone, outbox) {
  if (!outbox?.length) return;
  await UserSession.findOneAndUpdate({ phone }, { $unset: { "tempData.qdOutbox": "" } }).catch(() => {});
  await say(phone, "📬 *Here's your update from ZimQuote:*");
  for (const it of outbox) await deliverItem(phone, it);
  const ids = [...new Set(outbox.map(i => i.reqId).filter(isObjId))];
  if (ids.length) await QuoteRequest.updateMany({ _id: { $in: ids } }, { $set: { "quotes.$[q].deliveryPending": false } }, { arrayFilters: [{ "q.deliveryPending": true }] }).catch(() => {});
}

async function logMsg(reqId, m) {
  await QuoteRequest.updateOne({ _id: reqId }, { $push: { messages: { at: new Date(), ...m, text: String(m.text || "").slice(0, 2000) } }, $set: { lastActivityAt: new Date() } }).catch(() => {});
}
async function getReq(id) {
  if (!isObjId(id)) return null;
  return QuoteRequest.findById(id).lean().catch(() => null);
}

// ═════════════════════════════════════════════════════════════════════════════
// PUBLIC ENTRY
// ═════════════════════════════════════════════════════════════════════════════
const ESCAPE_RE  = /^(0|00|menu|main menu|back|exit|home|stop|hi|hie|hey|hello|cancel)$/i;
const START_RE   = /^(request (a )?quote|request quotes?|get (a )?quote|i need a quote|need a quote|quotation please|request a quotation|quote request|request sellers)[.!]*$/i;
const MYQ_RE     = /^(my quotes?|my requests?|my quotations?)$/i;
const DESK_RE    = /^(desk|quote desk|quotes desk|qdesk|requests desk)$/i;

export async function handleQuoteDesk({ from, text = "", action = "", biz = null, saveBiz = null, imageUrl = null }) {
  const phone = normPhone(from);
  if (!phone) return false;
  return withLock(phone, async () => {
    try {
      const a = String(action || "").trim().toLowerCase();
      const txt = String(text || "").trim();
      const admin = isQuoteAdmin(phone);
      const sess = await getSess(phone);
      const ctx = { from, phone, admin, sess, biz, saveBiz };

      // 0) Customer came back after the 24h window → deliver queued updates first.
      if (sess.outbox.length) await flushOutbox(phone, sess.outbox);
      // Keep the 24h-window clock fresh for customers with open requests.
      if (sess.open && !admin) {
        QuoteRequest.updateMany({ customerPhone: phone, status: { $in: OPEN_STATUSES } }, { $set: { customerLastMsgAt: new Date() } }).catch(() => {});
      }

      // A) Photos
      const photo = imageUrl || (a === "__buyer_photo_uploaded__" ? imageUrl : null);
      if ((imageUrl || a === "__buyer_photo_uploaded__") && /^qd_(extra|chat|sreply|schat)_/.test(sess.state)) {
        if (!photo) { await say(from, "❌ Couldn't read that photo. Please try again."); return true; }
        return onPhoto(ctx, photo);
      }

      // B) Button / list taps
      if (a === "sup_request_sellers" || a === "qd_start") return startRequest(ctx);
      if (a.startsWith("qda_")) {
        if (!admin) { await say(from, "⛔ That option is for ZimQuote staff."); return true; }
        return adminAction(ctx, a);
      }
      if (a.startsWith("qd_")) return customerOrSellerAction(ctx, a);

      // C) Typed text inside one of our flows
      if (sess.state) {
        if (a) { await clearState(phone); return false; }                // tapped something else
        if (ESCAPE_RE.test(txt) && !/^qda_(items|msg|smsg|deal|pay|paym|cost)_/.test(sess.state)) { await clearState(phone); return false; }
        if (/^qda_/.test(sess.state) && /^(cancel|0|00|menu)$/i.test(txt)) { await clearState(phone); await say(from, "👌 Cancelled."); return false; }
        return routeState(ctx, txt);
      }
      if (a) return false;

      // D) Typed shortcuts
      if (admin && DESK_RE.test(txt)) return adminDesk(ctx);
      if (admin && /^QR-[A-Z0-9]{5}$/i.test(txt)) {
        const r = await QuoteRequest.findOne({ ref: txt.toUpperCase() }).lean().catch(() => null);
        if (r) return adminOpen(ctx, String(r._id));
      }
      if (START_RE.test(txt)) return startRequest(ctx);
      if (MYQ_RE.test(txt)) return myQuotes(ctx);
      return false;
    } catch (err) {
      console.error("[QDESK] error:", err.message, err.stack);
      await say(from, "⚠️ Something went wrong on our side. Please try again or type *menu*.");
      return true;
    }
  });
}

async function routeState(ctx, txt) {
  const st = ctx.sess.state;
  if (st === "qd_req") return onRequestText(ctx, txt);
  if (st === "qd_loc") return onLocationText(ctx, txt);
  let m;
  if ((m = st.match(/^qd_extra_([a-f0-9]{24})$/)))  return onExtraText(ctx, m[1], txt);
  if ((m = st.match(/^qd_chat_([a-f0-9]{24})$/)))   return onCustomerChat(ctx, m[1], txt);
  if ((m = st.match(/^qd_sreply_([a-f0-9]{24})$/))) return onSellerReply(ctx, m[1], txt);
  if ((m = st.match(/^qd_schat_([a-f0-9]{24})$/)))  return onSellerChat(ctx, m[1], txt);
  if (ctx.admin) {
    if ((m = st.match(/^qda_pick_([a-f0-9]{24})$/)))  return adminPickTyped(ctx, m[1], txt);
    if ((m = st.match(/^qda_items_([a-f0-9]{24})$/))) return adminItemsTyped(ctx, m[1], txt);
    if ((m = st.match(/^qda_qsname_([a-f0-9]{24})$/))) return adminSellerNameTyped(ctx, m[1], txt);
    if ((m = st.match(/^qda_msg_([a-f0-9]{24})$/)))   return adminMsgTyped(ctx, m[1], txt);
    if ((m = st.match(/^qda_smsg_([a-f0-9]{24})_([a-f0-9]{24})$/))) return adminSellerMsgTyped(ctx, m[1], m[2], txt);
    if ((m = st.match(/^qda_deal_([a-f0-9]{24})$/)))  return adminDealTyped(ctx, m[1], txt);
    if ((m = st.match(/^qda_pay_([a-f0-9]{24})$/)))   return adminPayTyped(ctx, m[1], txt);
    if ((m = st.match(/^qda_paym_([a-f0-9]{24})$/)))  return adminPayMethodTyped(ctx, m[1], txt);
    if ((m = st.match(/^qda_cost_([a-f0-9]{24})$/)))  return adminCostTyped(ctx, m[1], txt);
  }
  await clearState(ctx.phone);
  return false;
}

// ═════════════════════════════════════════════════════════════════════════════
// CUSTOMER: REQUEST A QUOTE
// ═════════════════════════════════════════════════════════════════════════════
export async function startRequest(ctx) {
  await clearCompetingFlows(ctx.phone);
  await setState(ctx.phone, "qd_req", {});
  const openN = await QuoteRequest.countDocuments({ customerPhone: ctx.phone, status: { $in: OPEN_STATUSES } }).catch(() => 0);
  const body =
    `📝 *Request a Quote*\n\n` +
    `Tell us *what you need* and *where* - in one message. Any product or service.\n\n` +
    `📦 _20 bags cement + 3m³ river sand, Avondale_\n` +
    `🔧 _Plumber for a burst pipe, Glen View_\n` +
    `💻 _2 HP laptops, core i5, Harare CBD_\n` +
    `🎉 _Catering for 80 people, 12 Dec, Ruwa_\n\n` +
    `We get the prices for you and send your quotation here on WhatsApp. *Free.*`;
  if (openN) await ask(ctx.from, body, [{ id: "qd_my", title: `📋 My Quotes (${openN})` }]);
  else await say(ctx.from, body);
  return true;
}

// Split "cement 50kg x20, sand 3m3, Avondale" into items, dropping pure place names.
async function parseItems(text) {
  let items = [];
  try {
    const { parseItemListWithQty } = await import("./buyerRequests.js");
    items = parseItemListWithQty(text).map(i => ({ name: i.product, qty: i.quantity || 1, unit: i.unitLabel && i.unitLabel !== "units" ? i.unitLabel : "" }));
  } catch (_) {
    items = String(text).split(/\n|,|;/).map(s => s.trim()).filter(Boolean).map(name => ({ name, qty: 1, unit: "" }));
  }
  items = items.filter(i => {
    const n = String(i.name || "").toLowerCase().replace(/^(in|at|to|deliver(y)? to)\s+/, "");
    const hits = findPlaces(n);
    return !(hits.length && hits.map(h => h.name).join(" ").length >= n.replace(/[^a-z ]/g, "").trim().length - 2);
  });
  // A single long sentence ("I need a plumber to fix…") → short service name + full text as notes.
  if (items.length === 1 && String(items[0].name).split(/\s+/).length > 5) {
    try {
      const { extractNaturalLanguageRequest } = await import("./requestMatchEngine.js");
      const nl = extractNaturalLanguageRequest(text);
      if (nl?.product) items = [{ name: nl.product, qty: 1, unit: "", notes: String(text).slice(0, 300) }];
    } catch (_) {}
  }
  return items.slice(0, 30);
}
function locate(text, lastCity = "") {
  const det = detectCity(text, lastCity);
  const hits = findPlaces(text).filter(h => !det.city || h.cities.includes(det.city));
  const area = hits.find(h => h.name !== String(det.city || "").toLowerCase());
  return { city: det.city ? titleCase(det.city) : "", area: area ? titleCase(area.name) : "" };
}

async function onRequestText(ctx, txt) {
  if (txt.length < 4) { await say(ctx.from, "Please tell us what you need, e.g. _20 bags cement, Avondale_"); return true; }
  const items = await parseItems(txt);
  const loc = locate(txt, ctx.sess.lastCity);
  const draft = { text: txt.slice(0, 1500), items, city: loc.city, area: loc.area };
  if (!draft.city && !draft.area) {
    if (ctx.sess.lastCity) { draft.city = ctx.sess.lastCity; return createRequest(ctx, draft); }
    await setState(ctx.phone, "qd_loc", { draft });
    await say(ctx.from, "📍 *Where are you?* (suburb or town)\n_e.g. Avondale, Harare_");
    return true;
  }
  return createRequest(ctx, draft);
}
async function onLocationText(ctx, txt) {
  const draft = ctx.sess.data.draft;
  if (!draft) return startRequest(ctx);
  const loc = locate(txt, ctx.sess.lastCity);
  draft.city = loc.city || titleCase(txt.split(",").pop().trim()).slice(0, 40);
  draft.area = loc.area || (loc.city ? "" : titleCase(txt.split(",")[0].trim()).slice(0, 60));
  return createRequest(ctx, draft);
}

export async function createRequest(ctx, draft, { source = "whatsapp", customerName = "", silent = false } = {}) {
  const req = new QuoteRequest({
    source, customerPhone: ctx.phone, customerName,
    text: draft.text, items: draft.items || [], city: draft.city || "", area: draft.area || "",
    status: "new", customerLastMsgAt: source === "admin" ? new Date(0) : new Date(), lastActivityAt: new Date(),
    messages: [{ from: source === "admin" ? "admin" : "customer", to: "admin", text: draft.text }]
  });
  req.ref = qRef(req);
  await req.save();
  await clearState(ctx.phone);
  if (draft.city) await UserSession.findOneAndUpdate({ phone: ctx.phone }, { $set: { "tempData.qdLastCity": draft.city } }, { upsert: true }).catch(() => {});
  await markOpen(ctx.phone, true);
  const doc = req.toObject ? req.toObject() : req;

  if (!silent) {
    const h = hararetime();
    const when = h >= 8 && h < 18 ? "⏱ Usually within a few hours." : "🌙 We'll get onto it first thing in the morning.";
    await setState(ctx.phone, `qd_extra_${req._id}`, {}, { photoMarker: true });
    await ask(ctx.from,
      `✅ *Request received!* (${req.ref})\n\n📝 ${cut(draft.text, 300)}\n📍 ${[draft.area, draft.city].filter(Boolean).join(", ") || "-"}\n\n` +
      `Our team is getting you the best prices. Your quotation will come here on WhatsApp.\n${when}\n\n` +
      `📷 Got a *photo*, size or more details? Just send it now - we'll add it.`,
      [{ id: "qd_my", title: "📋 My Quotes" }, { id: "main_menu_back", title: "🏠 Menu" }]);
  }
  await alertAdminNew(doc);
  return silent ? doc : true;
}

async function onExtraText(ctx, reqId, txt) {
  if (/^(done|ok|okay|thanks|thank you|no|nope|that'?s all)$/i.test(txt)) {
    await clearState(ctx.phone);
    await say(ctx.from, "👍 Great - we'll send your quotation here soon.");
    return true;
  }
  await QuoteRequest.updateOne({ _id: reqId, customerPhone: ctx.phone }, { $set: { lastActivityAt: new Date() } });
  await logMsg(reqId, { from: "customer", to: "admin", text: txt });
  const req = await getReq(reqId);
  await setState(ctx.phone, `qd_extra_${reqId}`, {}, { photoMarker: true });          // keep window open
  await say(ctx.from, "✅ Added to your request. Send more, or type *done*.");
  if (req) await toAdmins(`➕ *Extra details* · ${qRef(req)}\n${displayPhone(req.customerPhone)}\n\n"${cut(txt, 700)}"`,
    [{ id: `qda_open_${reqId}`, title: "📂 Open request" }]);
  return true;
}

async function onPhoto(ctx, url) {
  const st = ctx.sess.state;
  const m = st.match(/^qd_(extra|chat|sreply|schat)_([a-f0-9]{24})$/);
  const [, kind, reqId] = m;
  const req = await getReq(reqId);
  if (!req) { await clearState(ctx.phone); return false; }
  if (kind === "extra" || kind === "chat") {
    await QuoteRequest.updateOne({ _id: reqId }, { $push: { photos: url }, $set: { lastActivityAt: new Date() } });
    await logMsg(reqId, { from: "customer", to: "admin", text: "📷 Photo", media: url });
    if (kind === "chat") await clearState(ctx.phone); else await setState(ctx.phone, st, {}, { photoMarker: true });
    await say(ctx.from, "✅ Photo added to your request.");
    for (const p of adminPhones()) await image(p, url, `📷 ${qRef(req)} · photo from ${displayPhone(req.customerPhone)}`);
    return true;
  }
  // seller photo (their own quotation / price list)
  const s = (req.sellers || []).find(x => phoneVariants(x.phone).includes(ctx.phone));
  if (!s) { await clearState(ctx.phone); return false; }
  await QuoteRequest.updateOne({ _id: reqId, "sellers.phone": s.phone },
    { $set: { "sellers.$.replyImage": url, "sellers.$.status": "replied", "sellers.$.replyAt": new Date(), lastActivityAt: new Date() } });
  await logMsg(reqId, { from: "seller", to: "admin", phone: s.phone, name: s.name, text: "📷 Quotation photo", media: url });
  await clearState(ctx.phone);
  await say(ctx.from, `✅ Sent to ZimQuote (${qRef(req)}). If the customer goes ahead, we'll connect you.`);
  for (const p of adminPhones()) await image(p, url, `🏪 ${s.name} · photo/quotation for ${qRef(req)}`);
  await toAdmins(`🏪 *${s.name}* sent a photo for ${qRef(req)} (see above).`, sellerReplyButtons(reqId, s));
  return true;
}

// ── Customer: My Quotes / view / chat / accept / decline / cancel ────────────
async function myQuotes(ctx) {
  await clearState(ctx.phone);
  const list = await QuoteRequest.find({ customerPhone: ctx.phone }).sort({ createdAt: -1 }).limit(10).lean().catch(() => []);
  if (!list.length) {
    await ask(ctx.from, "📋 You have no quote requests yet.", [{ id: "qd_start", title: "📝 Request a Quote" }, { id: "main_menu_back", title: "🏠 Menu" }]);
    return true;
  }
  if (list.length === 1) return customerView(ctx, String(list[0]._id), list[0]);
  await pick(ctx.from, "📋 *My Quotes*\nTap one to see it 👇", list.map(r => ({
    id: `qd_view_${r._id}`, title: `${qRef(r)} · ${(r.quotes || []).length ? "🧾" : "⏳"}`,
    description: `${cut(r.text, 40)} · ${CUSTOMER_STATUS[r.status] || r.status}`
  })));
  return true;
}
async function customerView(ctx, reqId, req = null) {
  req = req || await getReq(reqId);
  if (!req || normPhone(req.customerPhone) !== ctx.phone) { await say(ctx.from, "That request was not found."); return true; }
  const q = (req.quotes || []).filter(x => x.sentAt || x.deliveryPending).slice(-1)[0];
  const open = OPEN_STATUSES.includes(req.status);
  await ask(ctx.from,
    `📝 *${qRef(req)}* - ${CUSTOMER_STATUS[req.status] || req.status}\n\n${cut(req.text, 500)}\n📍 ${[req.area, req.city].filter(Boolean).join(", ") || "-"}` +
    (q ? `\n\n🧾 Latest quotation: *${money(q.total)}*${q.kind === "seller" && q.sellerName ? ` (${q.sellerName})` : ""}` : ""),
    [
      q ? { id: `qd_resend_${req._id}`, title: "📄 Show quotation" } : null,
      { id: `qd_chat_${req._id}`, title: "💬 Message us" },
      open ? { id: `qd_cancel_${req._id}`, title: "❌ Cancel request" } : { id: "qd_start", title: "📝 New request" }
    ]);
  return true;
}

async function customerOrSellerAction(ctx, a) {
  const m = a.match(/^qd_([a-z]+)(?:_(.*))?$/);
  if (!m) return false;
  const [, verb, arg = ""] = m;
  // Taps clear a typed state unless they continue it.
  if (ctx.sess.state && !["extra"].includes(verb)) { await clearState(ctx.phone); ctx.sess.state = ""; }
  const [id, x] = arg.split("_");
  switch (verb) {
    case "start":  return startRequest(ctx);
    case "my":     return myQuotes(ctx);
    case "view":   return customerView(ctx, id);
    case "resend": return customerResend(ctx, id);
    case "chat":   return startCustomerChat(ctx, id);
    case "acc":    return customerRespond(ctx, id, Number(x), "accepted");
    case "dec":    return customerRespond(ctx, id, Number(x), "declined");
    case "more":   return customerWantsMore(ctx, id);
    case "cancel": return customerCancel(ctx, id);
    case "conn":   return customerWantsConnect(ctx, id, x);
    // sellers
    case "sp":     return sellerStartPrice(ctx, id);
    case "sn":     return sellerNotAvailable(ctx, id);
    case "schat":  return sellerStartChat(ctx, id);
  }
  return false;
}

async function customerResend(ctx, reqId) {
  const req = await getReq(reqId);
  if (!req || normPhone(req.customerPhone) !== ctx.phone) { await say(ctx.from, "That request was not found."); return true; }
  const qi = (req.quotes || []).map((q, i) => ({ q, i })).filter(x => x.q.pdfUrl).slice(-1)[0];
  if (!qi) { await say(ctx.from, "⏳ Your quotation isn't ready yet - we'll send it here soon."); return true; }
  for (const it of quoteDeliveryItems(req, qi.q, qi.i)) await deliverItem(ctx.from, it);
  return true;
}
async function startCustomerChat(ctx, reqId) {
  const req = await getReq(reqId);
  if (!req || normPhone(req.customerPhone) !== ctx.phone) { await say(ctx.from, "That request was not found."); return true; }
  await setState(ctx.phone, `qd_chat_${reqId}`, {}, { photoMarker: true });
  await say(ctx.from, `💬 Type your message for the ZimQuote team (${qRef(req)}).\n_You can also send a photo._`);
  return true;
}
async function onCustomerChat(ctx, reqId, txt) {
  const req = await getReq(reqId);
  await clearState(ctx.phone);
  if (!req) return false;
  await logMsg(reqId, { from: "customer", to: "admin", text: txt });
  await QuoteRequest.updateOne({ _id: reqId }, { $set: { customerLastMsgAt: new Date() } }).catch(() => {});
  await ask(ctx.from, "✅ Sent to ZimQuote. We'll reply here.", [{ id: `qd_view_${reqId}`, title: "📋 My request" }]);
  await toAdmins(`💬 *Customer message* · ${qRef(req)}\n${displayPhone(req.customerPhone)}\n\n"${cut(txt, 800)}"`,
    [{ id: `qda_msg_${reqId}`, title: "💬 Reply" }, { id: `qda_quote_${reqId}`, title: "🧾 Make quote" }, { id: `qda_open_${reqId}`, title: "⚙️ More" }]);
  return true;
}
async function customerRespond(ctx, reqId, qi, response) {
  const req = await getReq(reqId);
  if (!req || normPhone(req.customerPhone) !== ctx.phone) { await say(ctx.from, "That request was not found."); return true; }
  const q = (req.quotes || [])[qi];
  if (!q) { await say(ctx.from, "That quotation was not found."); return true; }
  if (q.response) { await say(ctx.from, `ℹ️ You already ${q.response} this quotation.`); return true; }
  await QuoteRequest.updateOne({ _id: reqId }, { $set: {
    [`quotes.${qi}.response`]: response, [`quotes.${qi}.respondedAt`]: new Date(),
    ...(response === "accepted" ? { status: "accepted" } : {}), lastActivityAt: new Date()
  } });
  await logMsg(reqId, { from: "customer", to: "admin", text: `${response === "accepted" ? "✅ Accepted" : "❌ Declined"} quotation ${q.number} (${money(q.total)})` });
  if (response === "accepted") {
    await ask(ctx.from, `🎉 *Thank you!* (${qRef(req)})\nOur team will contact you shortly to arrange payment and delivery.`,
      [{ id: `qd_chat_${reqId}`, title: "💬 Message us" }, { id: "main_menu_back", title: "🏠 Menu" }]);
    if (q.bookId) {
      await toAdmins(`✅ *QUOTE ACCEPTED* · ${qRef(req)}\n${q.number} · *${money(q.total)}* · ZimQuote\n👤 ${displayPhone(req.customerPhone)}\n\nNext: send the invoice, or record the payment when it comes in.`,
        [{ id: `qda_inv_${reqId}`, title: "🧾 Send invoice" }, { id: `qda_pay_${reqId}`, title: "💵 Record payment" }, { id: `qda_open_${reqId}`, title: "⚙️ More" }]);
    } else {
      await toAdmins(`✅ *QUOTE ACCEPTED* · ${qRef(req)}\n${q.number} · *${money(q.total)}*${q.sellerName ? ` · ${q.sellerName}` : ""}\n👤 ${displayPhone(req.customerPhone)}\n\nNext: arrange payment/delivery, or connect the seller.`,
        [{ id: `qda_conn_${reqId}`, title: "🤝 Connect seller" }, { id: `qda_msg_${reqId}`, title: "💬 Message customer" }, { id: `qda_won_${reqId}`, title: "🏆 Mark done" }]);
    }
  } else {
    await ask(ctx.from, "👌 No problem. Want us to look for other options?",
      [{ id: `qd_more_${reqId}`, title: "🔄 Other options" }, { id: `qd_chat_${reqId}`, title: "💬 Tell us why" }, { id: "main_menu_back", title: "🏠 Menu" }]);
    await toAdmins(`❌ Customer declined ${q.number} (${money(q.total)}) · ${qRef(req)}`, [{ id: `qda_open_${reqId}`, title: "⚙️ Open" }]);
  }
  return true;
}
async function customerWantsMore(ctx, reqId) {
  const req = await getReq(reqId);
  if (!req || normPhone(req.customerPhone) !== ctx.phone) return true;
  await QuoteRequest.updateOne({ _id: reqId }, { $set: { status: "working", lastActivityAt: new Date() } });
  await logMsg(reqId, { from: "customer", to: "admin", text: "🔄 Wants other options" });
  await say(ctx.from, "👍 We'll look for other options and send them here.");
  await toAdmins(`🔄 Customer wants *other options* · ${qRef(req)}`, [{ id: `qda_pick_${reqId}`, title: "🏪 Pick sellers" }, { id: `qda_quote_${reqId}`, title: "🧾 Make quote" }]);
  return true;
}
async function customerCancel(ctx, reqId) {
  const r = await QuoteRequest.findOneAndUpdate({ _id: isObjId(reqId) ? reqId : null, customerPhone: ctx.phone, status: { $in: OPEN_STATUSES } },
    { $set: { status: "cancelled", closedAt: new Date(), lastActivityAt: new Date() } }, { new: true }).lean().catch(() => null);
  if (!r) { await say(ctx.from, "ℹ️ That request is already closed."); return true; }
  await logMsg(reqId, { from: "customer", to: "admin", text: "❌ Cancelled by customer" });
  await refreshOpenFlag(ctx.phone);
  await ask(ctx.from, `✅ Cancelled (${qRef(r)}).`, [{ id: "qd_start", title: "📝 New request" }, { id: "main_menu_back", title: "🏠 Menu" }]);
  await toAdmins(`❌ Customer cancelled ${qRef(r)}.`);
  return true;
}
async function customerWantsConnect(ctx, reqId, sid) {
  const req = await getReq(reqId);
  if (!req || normPhone(req.customerPhone) !== ctx.phone) return true;
  const s = (req.sellers || []).find(x => String(x.supplierId) === String(sid));
  await logMsg(reqId, { from: "customer", to: "admin", text: `🤝 Asked to be connected${s ? " with " + s.name : ""}` });
  await say(ctx.from, "👍 Got it - we'll connect you shortly.");
  await toAdmins(`🤝 Customer wants to be *connected*${s ? ` with *${s.name}*` : ""} · ${qRef(req)}`,
    s ? [{ id: `qda_conn_${reqId}_${sid}`, title: "🤝 Connect now" }, { id: `qda_msg_${reqId}`, title: "💬 Message customer" }]
      : [{ id: `qda_conn_${reqId}`, title: "🤝 Connect" }]);
  return true;
}
async function refreshOpenFlag(phone) {
  const n = await QuoteRequest.countDocuments({ customerPhone: phone, status: { $in: OPEN_STATUSES } }).catch(() => 1);
  await markOpen(phone, n > 0);
}

// ═════════════════════════════════════════════════════════════════════════════
// SELLER SIDE
// ═════════════════════════════════════════════════════════════════════════════
function sellerOf(req, phone) { return (req?.sellers || []).find(x => phoneVariants(x.phone).includes(normPhone(phone))); }

async function sellerStartPrice(ctx, reqId) {
  const req = await getReq(reqId);
  const s = sellerOf(req, ctx.phone);
  if (!req || !s) { await say(ctx.from, "ℹ️ That request is no longer available."); return true; }
  if (!OPEN_STATUSES.includes(req.status)) { await say(ctx.from, `ℹ️ ${qRef(req)} is closed. Thanks!`); return true; }
  await setState(ctx.phone, `qd_sreply_${reqId}`, {}, { photoMarker: true });
  await say(ctx.from,
    `💵 *Your price for ${qRef(req)}*\n📝 ${cut(req.text, 400)}\n📍 ${[req.area, req.city].filter(Boolean).join(", ") || "-"}\n\n` +
    `Type your prices in *one message*, e.g.\n_Cement 50kg $9.50 each, sand $45/m³, delivery $20, available today_\n\nOr send a *photo* of your quotation.`);
  return true;
}
async function onSellerReply(ctx, reqId, txt) {
  const req = await getReq(reqId);
  const s = sellerOf(req, ctx.phone);
  await clearState(ctx.phone);
  if (!req || !s) return false;
  await QuoteRequest.updateOne({ _id: reqId, "sellers.phone": s.phone },
    { $set: { "sellers.$.replyText": txt.slice(0, 2000), "sellers.$.status": "replied", "sellers.$.replyAt": new Date(), lastActivityAt: new Date() } });
  await logMsg(reqId, { from: "seller", to: "admin", phone: s.phone, name: s.name, text: txt });
  const sp = s.supplierId ? await SupplierProfile.findById(s.supplierId).lean().catch(() => null) : null;
  await ask(ctx.from,
    `✅ *Sent to ZimQuote* (${qRef(req)}). If the customer goes ahead, we'll connect you.` +
    (sp && !sellerIsActive(sp) ? `\n\n💡 Activate your ZimQuote listing ($5/month) to get more requests like this.` : ""),
    [{ id: `qd_schat_${reqId}`, title: "💬 Message ZimQuote" }]);
  await toAdmins(`🏪 *Price from ${s.name}* · ${qRef(req)}\n📞 ${displayPhone(s.phone)}${sp && !sellerIsActive(sp) ? " · 💤 unpaid" : ""}\n\n"${cut(txt, 800)}"`, sellerReplyButtons(reqId, s));
  return true;
}
function sellerReplyButtons(reqId, s) {
  const sid = String(s.supplierId || "");
  return [
    isObjId(sid) ? { id: `qda_fwd_${reqId}_${sid}`, title: "📤 Forward to cust." } : null,
    { id: `qda_quote_${reqId}`, title: "🧾 Make quote" },
    isObjId(sid) ? { id: `qda_conn_${reqId}_${sid}`, title: "🤝 Connect" } : { id: `qda_open_${reqId}`, title: "⚙️ More" }
  ];
}
async function sellerNotAvailable(ctx, reqId) {
  const req = await getReq(reqId);
  const s = sellerOf(req, ctx.phone);
  if (!req || !s) { await say(ctx.from, "👌 Thanks."); return true; }
  await QuoteRequest.updateOne({ _id: reqId, "sellers.phone": s.phone }, { $set: { "sellers.$.status": "declined", "sellers.$.replyAt": new Date() } });
  await logMsg(reqId, { from: "seller", to: "admin", phone: s.phone, name: s.name, text: "❌ Not available" });
  await say(ctx.from, "👌 Thanks for letting us know. We'll send you the next one.");
  return true;
}
async function sellerStartChat(ctx, reqId) {
  const req = await getReq(reqId);
  if (!req || !sellerOf(req, ctx.phone)) { await say(ctx.from, "ℹ️ That request is no longer available."); return true; }
  await setState(ctx.phone, `qd_schat_${reqId}`, {}, { photoMarker: true });
  await say(ctx.from, `💬 Type your message for ZimQuote about ${qRef(req)}:`);
  return true;
}
async function onSellerChat(ctx, reqId, txt) {
  const req = await getReq(reqId);
  const s = sellerOf(req, ctx.phone);
  await clearState(ctx.phone);
  if (!req || !s) return false;
  await logMsg(reqId, { from: "seller", to: "admin", phone: s.phone, name: s.name, text: txt });
  await say(ctx.from, "✅ Sent to ZimQuote.");
  const sid = String(s.supplierId || "");
  await toAdmins(`💬 *${s.name}* · ${qRef(req)}\n"${cut(txt, 800)}"`,
    [isObjId(sid) ? { id: `qda_smsg_${reqId}_${sid}`, title: "💬 Reply seller" } : null, { id: `qda_open_${reqId}`, title: "⚙️ Open" }]);
  return true;
}

// Send the request to chosen sellers. Template first (sellers are usually
// outside the 24h window), plain buttons as fallback.
export async function sendToSellers(reqId, supplierIds = [], { shareCustomerPhone = false, note = "" } = {}) {
  const req = await getReq(reqId);
  if (!req) throw new Error("Request not found");
  const ids = [...new Set(supplierIds.map(String).filter(isObjId))];
  const sups = await SupplierProfile.find({ _id: { $in: ids } }).lean().catch(() => []);
  const done = [];
  for (const sp of sups) {
    const phone = normPhone(sp.phone);
    if (!phone || phone === normPhone(req.customerPhone)) continue;
    const already = (req.sellers || []).some(x => String(x.supplierId) === String(sp._id));
    const entry = { supplierId: sp._id, phone, name: sellerName(sp), wasActive: sellerIsActive(sp), sentAt: new Date(), status: "sent", customerPhoneShared: !!shareCustomerPhone };
    if (already) await QuoteRequest.updateOne({ _id: reqId, "sellers.supplierId": sp._id }, { $set: { "sellers.$.sentAt": new Date(), ...(shareCustomerPhone ? { "sellers.$.customerPhoneShared": true } : {}) } });
    else await QuoteRequest.updateOne({ _id: reqId }, { $push: { sellers: entry } });
    await notifySellerOfRequest(req, sp, { shareCustomerPhone, note });
    done.push(sellerName(sp));
  }
  if (done.length) {
    await QuoteRequest.updateOne({ _id: reqId, status: { $in: ["new", "working"] } }, { $set: { status: "sent_to_sellers" } });
    await QuoteRequest.updateOne({ _id: reqId }, { $set: { lastActivityAt: new Date() } });
    await logMsg(reqId, { from: "admin", to: "seller", text: `📤 Sent to ${done.length} seller(s): ${done.join(", ")}${shareCustomerPhone ? " (customer number shared)" : ""}` });
  }
  return done;
}
async function notifySellerOfRequest(req, sp, { shareCustomerPhone, note }) {
  const phone = normPhone(sp.phone);
  const ref = qRef(req);
  const itemsLine = (req.items || []).length
    ? req.items.slice(0, 4).map(i => `${i.name}${i.qty > 1 ? ` x${i.qty}${i.unit ? " " + i.unit : ""}` : ""}`).join(", ") + (req.items.length > 4 ? ` +${req.items.length - 4} more` : "")
    : cut(req.text, 200);
  const where = [req.area, req.city].filter(Boolean).join(", ") || "Zimbabwe";
  const reqId = String(req._id);
  // Approved template with quick-reply payloads pointing at THIS desk.
  try {
    const name = shareCustomerPhone ? "supplier_new_request_v2_with_phone" : "supplier_new_request_v2";
    const vars = [cut(itemsLine, 300), where, "To be confirmed", ref, ...(shareCustomerPhone ? [displayPhone(req.customerPhone)] : [])];
    await axios.post(`https://graph.facebook.com/${GRAPH}/${PNID()}/messages`, {
      messaging_product: "whatsapp", to: phone, type: "template",
      template: { name, language: { code: "en" }, components: [
        { type: "body", parameters: vars.map(v => ({ type: "text", text: String(v).replace(/[\n\t]+/g, " ").slice(0, 900) })) },
        { type: "button", sub_type: "quick_reply", index: "0", parameters: [{ type: "payload", payload: `qd_sp_${reqId}` }] },
        { type: "button", sub_type: "quick_reply", index: "1", parameters: [{ type: "payload", payload: `qd_sn_${reqId}` }] }
      ] }
    }, { headers: { Authorization: `Bearer ${TOKEN()}`, "Content-Type": "application/json" }, timeout: 15000 });
    return;
  } catch (e) {
    console.warn(`[QDESK] seller template → ${phone}: ${e?.response?.data?.error?.message || e.message}. Using buttons.`);
  }
  await ask(phone,
    `📝 *New quote request via ZimQuote* (${ref})\n\n${cut(req.text, 500)}\n📍 ${where}` +
    (shareCustomerPhone ? `\n📞 Customer: ${displayPhone(req.customerPhone)}` : "") +
    (note ? `\n\n🗒 ${cut(note, 300)}` : "") +
    `\n\nReply with your best price - ZimQuote will share it with the customer.` +
    (!sellerIsActive(sp) ? `\n\n💡 You're getting this because you're listed on ZimQuote. Activate ($5/month) to get requests directly.` : ""),
    [{ id: `qd_sp_${reqId}`, title: "💵 Send my price" }, { id: `qd_sn_${reqId}`, title: "❌ Not available" }]);
}

// ═════════════════════════════════════════════════════════════════════════════
// SELLER SUGGESTIONS (admin has the final say)
// Mixes the existing request matcher (paid/trial sellers) with a broader scored
// search that ALSO includes unpaid sellers - real requests are the best reason
// for an unpaid seller to activate.
// ═════════════════════════════════════════════════════════════════════════════
export async function suggestSellers(req, limit = QD_CONFIG.SUGGEST_LIMIT) {
  const terms = [...new Set([...(req.items || []).map(i => i.name), (req.items || []).length ? "" : req.text].filter(Boolean).map(t => String(t).toLowerCase().slice(0, 80)))].slice(0, 6);
  const map = new Map();
  const add = (s, pts, why) => {
    const k = String(s._id);
    const cur = map.get(k) || { s, score: 0, why: new Set() };
    cur.score += pts; if (why) cur.why.add(why);
    map.set(k, cur);
  };
  try {
    const { findSuppliersForRequest } = await import("./requestMatchEngine.js");
    const matched = await findSuppliersForRequest({ items: (req.items || []).map(i => ({ product: i.name, quantity: i.qty })), city: req.city || null, area: req.area || null });
    matched.forEach((s, i) => add(s, 60 - i * 2, "matcher"));
  } catch (e) { console.warn("[QDESK] matcher:", e.message); }
  try {
    const { scoreSupplierMatch } = await import("./supplierSearch.js");
    const q = { profileType: { $nin: ["biker"] }, suspended: { $ne: true } };
    if (req.city) q["location.city"] = { $in: metroGroup(req.city).map(c => new RegExp(`^${escRe(c)}$`, "i")) };
    const pool = await SupplierProfile.find(q).limit(600).lean();
    for (const s of pool) {
      let sc = 0;
      for (const t of terms) { try { sc += Number(scoreSupplierMatch(s, t)) || 0; } catch (_) {} }
      if (sc > 0) add(s, sc, "search");
    }
  } catch (e) { console.warn("[QDESK] search scoring:", e.message); }
  const areaL = String(req.area || "").toLowerCase();
  return [...map.values()]
    .map(x => {
      const s = x.s;
      if (areaL && String(s.location?.area || "").toLowerCase().includes(areaL)) x.score += 15;
      if (sellerIsActive(s)) x.score += 10;
      return { supplier: s, score: Math.round(x.score), active: sellerIsActive(s), why: [...x.why] };
    })
    .filter(x => normPhone(x.supplier.phone) !== normPhone(req.customerPhone))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

// ═════════════════════════════════════════════════════════════════════════════
// QUOTATIONS (PDF)  - ZimQuote quote or a seller's quote; admin decides
// ═════════════════════════════════════════════════════════════════════════════
// "Cement 50kg x 20 @ 9.50" · "20 x cement @ 9.5" · "Delivery @ 15" · "note: valid 7 days"
export function parseQuoteLines(text = "") {
  const lines = [], errors = [];
  let notes = "";
  for (let raw of String(text).split(/\n|;/)) {
    raw = raw.replace(/^\s*(\d+[.)]|[-•*])\s+/, "").trim();
    if (!raw) continue;
    const n = raw.match(/^(notes?|terms?)\s*[:\-]\s*(.+)$/i);
    if (n) { notes += (notes ? "\n" : "") + n[2].trim(); continue; }
    const num = s => Number(String(s).replace(",", "."));
    let m, item, qty = 1, price;
    if ((m = raw.match(/^(.*?)\s*[x×*]\s*(\d+(?:[.,]\d+)?)\s*(?:@|at)\s*\$?\s*(\d+(?:[.,]\d+)?)\s*$/i))) { item = m[1]; qty = num(m[2]); price = num(m[3]); }
    else if ((m = raw.match(/^(\d+(?:[.,]\d+)?)\s*[x×*]?\s+(.*?)\s*(?:@|at)\s*\$?\s*(\d+(?:[.,]\d+)?)\s*$/i))) { qty = num(m[1]); item = m[2]; price = num(m[3]); }
    else if ((m = raw.match(/^(.*?)\s*(?:@|at|=|:|-{1,2})\s*\$?\s*(\d+(?:[.,]\d+)?)\s*$/i))) { item = m[1]; price = num(m[2]); }
    if (!item || !(price >= 0) || !(qty > 0)) { errors.push(raw); continue; }
    item = item.replace(/[\s,:-]+$/, "").trim();
    lines.push({ item: item.slice(0, 120), qty, unit: price, total: Math.round(qty * price * 100) / 100 });
  }
  return { lines, notes, errors, total: Math.round(lines.reduce((s, l) => s + l.total, 0) * 100) / 100 };
}

function quoteDeliveryItems(req, q, qi) {
  const id = String(req._id);
  const answered = !!q.response;
  return [{
    type: "doc", link: q.pdfUrl, filename: q.filename || `${q.number}.pdf`,
    caption: `📄 Quotation ${q.number}${q.kind === "seller" && q.sellerName ? ` - ${q.sellerName}` : " - ZimQuote"}`,
    text:
      `🧾 *Your quotation is ready* (${qRef(req)})\n\n` +
      q.lines.slice(0, 8).map(l => `• ${l.item} × ${l.qty} = ${money(l.total)}`).join("\n") +
      (q.lines.length > 8 ? `\n• … +${q.lines.length - 8} more (see PDF)` : "") +
      `\n\n💵 *Total: ${money(q.total)}*` + (q.notes ? `\n🗒 ${cut(q.notes, 300)}` : "") +
      (answered ? "" : `\n\nHappy with it?`),
    buttons: answered
      ? [{ id: `qd_chat_${id}`, title: "💬 Message us" }]
      : [{ id: `qd_acc_${id}_${qi}`, title: "✅ Accept" }, { id: `qd_chat_${id}`, title: "💬 Ask a question" }, { id: `qd_dec_${id}_${qi}`, title: "❌ No thanks" }]
  }];
}

export async function buildAndSendQuote(reqId, { lines, notes = "", kind = "zimquote", supplierId = null, sellerNameOverride = "", send = true } = {}) {
  const req = await getReq(reqId);
  if (!req) throw new Error("Request not found");
  if (!lines?.length) throw new Error("Add at least one line with a price.");
  let sp = null;
  if (kind === "seller" && isObjId(supplierId)) sp = await SupplierProfile.findById(supplierId).lean().catch(() => null);
  const sellerEntry = sp ? (req.sellers || []).find(x => String(x.supplierId) === String(sp._id)) : null;
  const sellerLabel = kind === "seller" ? (sp ? sellerName(sp) : String(sellerNameOverride || "Seller").trim()) : "";
  // ZimQuote quotes are numbered + saved in the admin's own business books
  // (QT-000045) so they can become an invoice and receipts. No house business
  // configured → the old request-based number (QR-7F3A2-1) is used.
  let house = null;
  let number = `${qRef(req)}-${(req.quotes || []).length + 1}`;
  if (kind !== "seller") {
    try { house = await getHouseBiz(); if (house) number = await nextDocNumber(house._id, "quote"); }
    catch (e) { console.warn("[QDESK] books numbering:", e.message); house = null; number = `${qRef(req)}-${(req.quotes || []).length + 1}`; }
  }
  const total = Math.round(lines.reduce((s, l) => s + (Number(l.total) || Number(l.qty) * Number(l.unit) || 0), 0) * 100) / 100;

  const bizMeta = kind === "seller"
    ? {
        name: sellerLabel, logoUrl: sp?.logoUrl || "",
        address: [
          [sp?.location?.area, sp?.location?.city].filter(Boolean).join(", "),
          sellerEntry?.sellerPhoneShared && sp?.phone ? `Tel: ${displayPhone(sp.phone)}` : "",
          "Quoted via ZimQuote"
        ].filter(Boolean).join("\n"),
        _id: String(sp?._id || req._id), status: "quotation"
      }
    : {
        name: process.env.ZQ_QUOTE_BRAND || "ZimQuote",
        logoUrl: process.env.ZQ_LOGO_URL || "",
        address: process.env.ZQ_QUOTE_ADDRESS || `WhatsApp ${displayPhone(BOT())}\nzimquote.co.zw`,
        _id: String(req._id), status: "quotation"
      };
  const { generatePDF } = await import("../routes/twilio_biz.js");
  const { filename } = await generatePDF({
    type: "quote", number, date: new Date(),
    billingTo: `${req.customerName ? req.customerName + "\n" : ""}${displayPhone(req.customerPhone)}\nRequest ${qRef(req)}`,
    notes: [notes, "Valid for 7 days. Prices subject to availability."].filter(Boolean).join("\n"),
    items: lines.map(l => ({ item: l.item, qty: Number(l.qty) || 1, unit: Number(l.unit) || 0, total: Number(l.total) || 0 })),
    bizMeta
  });
  if (!SITE()) throw new Error("SITE_URL is not set - the PDF link can't be built.");
  const pdfUrl = `${SITE()}/docs/generated/quotes/${filename}`;
  const quote = {
    number, kind, supplierId: sp?._id || null, sellerName: sellerLabel, lines, notes, total,
    currency: "USD", pdfUrl, filename, createdAt: new Date(), sentAt: send ? new Date() : null, deliveryPending: false
  };
  if (house) {
    try {
      const booked = await bookQuote({ house, number, customerPhone: req.customerPhone, customerName: req.customerName || "", lines, notes, ref: qRef(req) });
      quote.bookId = booked._id; quote.bookBizId = house._id;
    } catch (e) { console.error("[QDESK] book quote:", e.message); }
  }
  const qi = (req.quotes || []).length;
  let delivered = null;
  if (send) {
    const res = await toCustomer(req, quoteDeliveryItems(req, quote, qi), { nudge: `Your quotation ${number} (${money(total)}) is ready. Reply to this message to view it.` });
    delivered = res.delivered;
    quote.deliveryPending = !res.delivered;
  }
  await QuoteRequest.updateOne({ _id: reqId }, { $push: { quotes: quote }, $set: { lastActivityAt: new Date(), ...(send ? { status: "quoted" } : {}) } });
  await logMsg(reqId, { from: "admin", to: send ? "customer" : "admin", text: `🧾 ${send ? "Sent" : "Created"} quotation ${number} · ${money(total)}${sellerLabel ? " · " + sellerLabel : " · ZimQuote"}${send && !delivered ? " (queued: customer outside 24h window)" : ""}`, media: pdfUrl });
  return { quote, pdfUrl, delivered, qi };
}

export async function resendQuote(reqId, qi) {
  const req = await getReq(reqId);
  const q = req?.quotes?.[qi];
  if (!q) throw new Error("Quotation not found");
  const res = await toCustomer(req, quoteDeliveryItems(req, q, qi), { nudge: `Your quotation ${q.number} (${money(q.total)}) is ready. Reply to this message to view it.` });
  await QuoteRequest.updateOne({ _id: req._id }, { $set: {
    [`quotes.${qi}.sentAt`]: new Date(), [`quotes.${qi}.deliveryPending`]: !res.delivered, lastActivityAt: new Date(),
    ...(["new", "working", "sent_to_sellers"].includes(req.status) ? { status: "quoted" } : {})
  } });
  await logMsg(String(req._id), { from: "admin", to: "customer", text: `📄 ${q.sentAt ? "Resent" : "Sent"} quotation ${q.number} · ${money(q.total)}${res.delivered ? "" : " (queued)"}`, media: q.pdfUrl });
  return res;
}

export async function messageCustomer(reqId, text, { by = "admin" } = {}) {
  const req = await getReq(reqId);
  if (!req) throw new Error("Request not found");
  const id = String(req._id);
  const res = await toCustomer(req, { type: "text", text: `💬 *ZimQuote* (${qRef(req)}):\n\n${text}`, buttons: [{ id: `qd_chat_${id}`, title: "💬 Reply" }, { id: `qd_view_${id}`, title: "📋 My request" }] },
    { nudge: cut(text, 200) });
  await logMsg(id, { from: by, to: "customer", text: text + (res.delivered ? "" : " (queued: outside 24h window)") });
  await QuoteRequest.updateOne({ _id: id, status: "new" }, { $set: { status: "working" } });
  return res;
}
export async function messageSeller(reqId, supplierId, text) {
  const req = await getReq(reqId);
  const s = (req?.sellers || []).find(x => String(x.supplierId) === String(supplierId));
  if (!req || !s) throw new Error("Seller not on this request");
  await ask(s.phone, `💬 *ZimQuote* (${qRef(req)}):\n\n${text}`, [{ id: `qd_schat_${req._id}`, title: "💬 Reply" }, { id: `qd_sp_${req._id}`, title: "💵 Send price" }]);
  await logMsg(String(req._id), { from: "admin", to: "seller", phone: s.phone, name: s.name, text });
}
export async function forwardSellerReply(reqId, supplierId) {
  const req = await getReq(reqId);
  const s = (req?.sellers || []).find(x => String(x.supplierId) === String(supplierId));
  if (!req || !s) throw new Error("Seller not on this request");
  if (!s.replyText && !s.replyImage) throw new Error("This seller hasn't replied yet.");
  const id = String(req._id);
  const who = s.sellerPhoneShared ? `*${s.name}*` : "a seller";
  const items = [];
  if (s.replyImage) items.push({ type: "image", link: s.replyImage, caption: `📷 Price from ${s.sellerPhoneShared ? s.name : "a seller"} · ${qRef(req)}` });
  items.push({ type: "text", text: `💬 *Price from ${who}* (${qRef(req)}):\n\n${s.replyText ? `"${cut(s.replyText, 900)}"` : "(see photo above)"}\n\nWant to go ahead?`,
    buttons: [{ id: `qd_conn_${id}_${s.supplierId}`, title: "✅ Yes, connect me" }, { id: `qd_chat_${id}`, title: "💬 Ask a question" }] });
  const res = await toCustomer(req, items, { nudge: "A seller sent a price for your request. Reply to this message to see it." });
  await logMsg(id, { from: "admin", to: "customer", text: `📤 Forwarded price from ${s.name}` });
  await QuoteRequest.updateOne({ _id: id, status: { $in: ["new", "working", "sent_to_sellers"] } }, { $set: { status: "quoted" } });
  return res;
}
// mode: "c" seller gets customer's number · "s" customer gets seller's number · "b" both
export async function shareContacts(reqId, supplierId, mode = "b") {
  const req = await getReq(reqId);
  const s = (req?.sellers || []).find(x => String(x.supplierId) === String(supplierId));
  if (!req || !s) throw new Error("Seller not on this request");
  const id = String(req._id);
  const set = {};
  if (mode === "c" || mode === "b") {
    await ask(s.phone,
      `🤝 *Customer contact* (${qRef(req)})\n\n📝 ${cut(req.text, 300)}\n📍 ${[req.area, req.city].filter(Boolean).join(", ") || "-"}\n📞 *${displayPhone(req.customerPhone)}*${req.customerName ? ` (${req.customerName})` : ""}\n\nPlease contact them to finalise. Thank you for using ZimQuote!`,
      [{ id: `qd_schat_${id}`, title: "💬 Message ZimQuote" }]);
    set["sellers.$.customerPhoneShared"] = true;
  }
  if (mode === "s" || mode === "b") {
    const sp = s.supplierId ? await SupplierProfile.findById(s.supplierId).lean().catch(() => null) : null;
    await toCustomer(req, { type: "text",
      text: `🤝 *Seller contact* (${qRef(req)})\n\n🏪 *${s.name}*${sp?.location?.city ? `\n📍 ${[sp.location.area, sp.location.city].filter(Boolean).join(", ")}` : ""}\n📞 *${displayPhone(s.phone)}*\n\nYou can call or WhatsApp them directly. 🛡 Tip: confirm the price before paying.`,
      buttons: [{ id: `qd_chat_${id}`, title: "💬 Message ZimQuote" }] }, { nudge: `Here is the seller's contact for ${qRef(req)}. Reply to see it.` });
    set["sellers.$.sellerPhoneShared"] = true;
  }
  await QuoteRequest.updateOne({ _id: id, "sellers.supplierId": s.supplierId }, { $set: { ...set, lastActivityAt: new Date() } });
  await logMsg(id, { from: "admin", to: mode === "c" ? "seller" : mode === "s" ? "customer" : "both", phone: s.phone, name: s.name,
    text: `🤝 Contacts shared with ${s.name}: ${mode === "c" ? "seller got customer's number" : mode === "s" ? "customer got seller's number" : "both ways"}` });
}
export async function setStatus(reqId, status, { dealValue = null, commission = null, note = "" } = {}) {
  const set = { status, lastActivityAt: new Date() };
  if (["won", "lost", "closed", "cancelled"].includes(status)) set.closedAt = new Date();
  if (dealValue !== null && dealValue !== "" && Number.isFinite(Number(dealValue))) set.dealValue = Number(dealValue);
  if (commission !== null && commission !== "" && Number.isFinite(Number(commission))) set.commission = Number(commission);
  const r = await QuoteRequest.findOneAndUpdate({ _id: reqId }, { $set: set }, { new: true }).lean();
  if (!r) throw new Error("Request not found");
  await logMsg(reqId, { from: "admin", to: "admin", text: `Status → ${STATUS_LABEL[status] || status}${note ? " · " + note : ""}` });
  await refreshOpenFlag(normPhone(r.customerPhone));
  return r;
}
// Admin creates a request for a phone-in / walk-in customer.
export async function adminCreateRequest({ customerPhone, customerName = "", text, city = "", notifyCustomer = true }) {
  const phone = normPhone(customerPhone);
  if (!phone || phone.length < 11) throw new Error("A valid customer WhatsApp number is required.");
  if (!String(text || "").trim()) throw new Error("Describe what the customer needs.");
  const items = await parseItems(text);
  const loc = locate(`${text} ${city}`);
  const doc = await createRequest({ from: phone, phone, sess: { lastCity: "" } },
    { text: String(text).trim(), items, city: city || loc.city, area: loc.area }, { source: "admin", customerName, silent: true });
  if (notifyCustomer) {
    await toCustomer({ ...doc, customerLastMsgAt: new Date(0) }, { type: "text",
      text: `📝 *ZimQuote received your request* (${doc.ref})\n\n${cut(doc.text, 400)}\n\nWe're getting you the best prices - your quotation will come here on WhatsApp.`,
      buttons: [{ id: `qd_chat_${doc._id}`, title: "💬 Message us" }] }, { nudge: `We received your request ${doc.ref}. Reply to this message to follow it here.` });
  }
  return doc;
}

// ═════════════════════════════════════════════════════════════════════════════
// ADMIN DESK ON WHATSAPP
// ═════════════════════════════════════════════════════════════════════════════
function deskLink(reqId) { return SITE() ? `${SITE()}/zq-admin/quote-desk/${reqId}` : ""; }

async function alertAdminNew(req) {
  let sugg = [];
  try { sugg = await suggestSellers(req, 8); } catch (_) {}
  const paid = sugg.filter(x => x.active).length;
  const id = String(req._id);
  for (const p of adminPhones()) for (const ph of (req.photos || [])) await image(p, ph, `📷 ${qRef(req)}`);
  await toAdmins(
    `📝 *New quote request* · ${qRef(req)}\n👤 ${displayPhone(req.customerPhone)}${req.customerName ? ` (${req.customerName})` : ""}\n📍 ${[req.area, req.city].filter(Boolean).join(", ") || "-"}\n` +
    `━━━━━━━━━━━━\n${cut(req.text, 700)}\n━━━━━━━━━━━━\n` +
    `🏪 ${sugg.length ? `${sugg.length} possible sellers (${paid} paid)` : "No matching sellers found"}` +
    (deskLink(id) ? `\n🔗 ${deskLink(id)}` : ""),
    [{ id: `qda_pick_${id}`, title: "🏪 Pick sellers" }, { id: `qda_quote_${id}`, title: "🧾 Make quote" }, { id: `qda_open_${id}`, title: "⚙️ More" }]);
}

async function adminDesk(ctx) {
  await clearState(ctx.phone);
  const list = await QuoteRequest.find({ status: { $in: OPEN_STATUSES } }).sort({ lastActivityAt: -1 }).limit(10).lean().catch(() => []);
  const newN = list.filter(r => r.status === "new").length;
  if (!list.length) { await say(ctx.from, "📭 *Quote desk is empty.* No open requests."); return true; }
  await pick(ctx.from, `🗂 *Quote desk* · ${list.length} open${newN ? ` · ${newN} new` : ""}\nTap one 👇 (or type a ref like *QR-7F3A2*)`,
    list.map(r => ({ id: `qda_open_${r._id}`, title: `${qRef(r)} ${(STATUS_LABEL[r.status] || "").split(" ")[0]}`, description: `${cut(r.text, 46)} · ${r.city || ""}` })));
  return true;
}
async function adminOpen(ctx, reqId) {
  const req = await getReq(reqId);
  if (!req) { await say(ctx.from, "Request not found."); return true; }
  const replied = (req.sellers || []).filter(s => s.status === "replied").length;
  const id = String(req._id);
  await pick(ctx.from,
    `📂 *${qRef(req)}* · ${STATUS_LABEL[req.status] || req.status}\n👤 ${displayPhone(req.customerPhone)}${req.customerName ? ` (${req.customerName})` : ""}\n📍 ${[req.area, req.city].filter(Boolean).join(", ") || "-"}\n\n${cut(req.text, 500)}\n\n` +
    `🏪 Sellers: ${(req.sellers || []).length} sent · ${replied} replied\n🧾 Quotes: ${(req.quotes || []).length}` + (deskLink(id) ? `\n🔗 ${deskLink(id)}` : ""),
    [
      { id: `qda_pick_${id}`, title: "🏪 Pick sellers", description: "Suggested sellers - you choose" },
      { id: `qda_quote_${id}`, title: "🧾 Make quote (PDF)", description: "ZimQuote or seller's quote" },
      { id: `qda_msg_${id}`, title: "💬 Message customer" },
      replied ? { id: `qda_replies_${id}`, title: `📥 Seller prices (${replied})`, description: "Forward / connect / quote" } : null,
      (req.sellers || []).length ? { id: `qda_conn_${id}`, title: "🤝 Connect contacts", description: "You decide who gets whose number" } : null,
      (req.quotes || []).length ? { id: `qda_resend_${id}`, title: "📄 Resend last quote" } : null,
      bookedQuote(req) ? { id: `qda_books_${id}`, title: "💰 Invoice & payment", description: booksLine(req) } : null,
      { id: `qda_won_${id}`, title: "🏆 Mark done (won)" },
      { id: `qda_lost_${id}`, title: "➖ Mark lost / closed" },
      { id: "qda_desk", title: "🗂 Back to desk" }
    ]);
  return true;
}

async function adminAction(ctx, a) {
  const m = a.match(/^qda_([a-z]+)(?:_(.*))?$/);
  if (!m) return false;
  const [, verb, arg = ""] = m;
  const parts = arg.split("_");
  const id = parts[0];
  // Taps that continue a typed draft must keep it.
  const keeps = ["send", "qz", "qs", "qsel", "qsother", "pm"].includes(verb);
  const data = ctx.sess.data;
  if (!keeps && ctx.sess.state) { await clearState(ctx.phone); ctx.sess.state = ""; }
  switch (verb) {
    case "desk":    return adminDesk(ctx);
    case "open":    return adminOpen(ctx, id);
    case "pick":    return adminPickStart(ctx, id);
    case "send":    return adminSendPicked(ctx, id, parts[1] === "1", data);
    case "quote":   return adminQuoteStart(ctx, id);
    case "qz":      return adminQuoteFinish(ctx, id, data, { kind: "zimquote" });
    case "qs":      return adminQuoteSellerPick(ctx, id, data);
    case "qsel":    return adminQuoteFinish(ctx, id, data, { kind: "seller", supplierId: parts[1] });
    case "qsother": await setState(ctx.phone, `qda_qsname_${id}`, data); await say(ctx.from, "🏪 Type the seller's *name* or *phone number*:"); return true;
    case "msg":     await setState(ctx.phone, `qda_msg_${id}`, {}); await say(ctx.from, "💬 Type your message to the customer (or *cancel*):"); return true;
    case "smsg":    await setState(ctx.phone, `qda_smsg_${id}_${parts[1]}`, {}); await say(ctx.from, "💬 Type your message to the seller (or *cancel*):"); return true;
    case "replies": return adminReplies(ctx, id);
    case "fwd":     try { const r = await forwardSellerReply(id, parts[1]); await say(ctx.from, r.delivered ? "📤 Forwarded to the customer." : "📤 Queued - the customer will get it when they next message (template nudge sent)."); } catch (e) { await say(ctx.from, "⚠️ " + e.message); } return true;
    case "conn":    return parts[1] ? adminConnectMenu(ctx, id, parts[1]) : adminConnectPickSeller(ctx, id);
    case "share":   try { await shareContacts(id, parts[1], parts[2]); await say(ctx.from, "🤝 Done - contacts shared."); } catch (e) { await say(ctx.from, "⚠️ " + e.message); } return true;
    case "resend":  { const req = await getReq(id); const qi = (req?.quotes || []).length - 1;
                      if (qi < 0) { await say(ctx.from, "No quotation yet."); return true; }
                      const r = await resendQuote(id, qi);
                      await say(ctx.from, r.delivered ? "📄 Resent." : "📄 Queued for when the customer replies."); return true; }
    case "won":     await setStatus(id, "won"); await setState(ctx.phone, `qda_deal_${id}`, {});
                    await say(ctx.from, "🏆 Marked done. Optional - type *deal value, your commission* (e.g. _250, 25_) or *skip*:"); return true;
    case "lost":    await setStatus(id, "lost"); await say(ctx.from, "➖ Marked lost / closed."); return true;
    // ── Books (invoice / payment / cost) ──
    case "books":   return adminBooks(ctx, id);
    case "inv":     return adminSendInvoice(ctx, id);
    case "pay":     return adminPayStart(ctx, id);
    case "pm":      return adminPayFinish(ctx, id, ctx.sess.data?.amount, { c: "Cash", e: "EcoCash", b: "Bank" }[parts[1]] || "Cash");
    case "cost":    await setState(ctx.phone, `qda_cost_${id}`, {});
                    await say(ctx.from, "📉 What did you pay the seller / supplier for this job?\nType the *amount* and a short note, e.g. _180 Paid Harare Hardware_\n(or *cancel*)"); return true;
  }
  return false;
}

async function adminPickStart(ctx, reqId) {
  const req = await getReq(reqId);
  if (!req) { await say(ctx.from, "Request not found."); return true; }
  const sugg = await suggestSellers(req, QD_CONFIG.SUGGEST_LIMIT);
  const sent = new Set((req.sellers || []).map(s => String(s.supplierId)));
  const lines = sugg.map((x, i) => {
    const s = x.supplier;
    return `*${i + 1}.* ${x.active ? "✅" : "💤"} ${sellerName(s)}${sent.has(String(s._id)) ? " _(sent)_" : ""}\n     ${[s.location?.area, s.location?.city].filter(Boolean).join(", ") || "-"}${x.active ? "" : " · unpaid"}`;
  });
  await setState(ctx.phone, `qda_pick_${reqId}`, { ids: sugg.map(x => String(x.supplier._id)) });
  await say(ctx.from,
    `🏪 *Sellers for ${qRef(req)}*\n_${cut(req.text, 120)}_\n\n` +
    (lines.length ? lines.join("\n") : "_No suggestions - type a seller's phone number._") +
    `\n\n✅ paid · 💤 unpaid (a real request is a good reason for them to activate)\n\n` +
    `👉 Reply with numbers, e.g. *1,3,5* · or *all* · or a seller's *phone number*. Type *cancel* to stop.`);
  return true;
}
async function adminPickTyped(ctx, reqId, txt) {
  const ids = ctx.sess.data.ids || [];
  const chosen = new Set();
  const notFound = [];
  if (/^all$/i.test(txt)) ids.forEach(i => chosen.add(i));
  for (const tok of txt.split(/[\s,;]+/).filter(Boolean)) {
    const range = tok.match(/^(\d{1,2})-(\d{1,2})$/);
    if (range) { for (let k = Number(range[1]); k <= Number(range[2]); k++) if (ids[k - 1]) chosen.add(ids[k - 1]); continue; }
    if (/^\d{1,2}$/.test(tok)) { if (ids[Number(tok) - 1]) chosen.add(ids[Number(tok) - 1]); else notFound.push(tok); continue; }
    if (/^\+?\d{9,13}$/.test(tok)) {
      const sp = await SupplierProfile.findOne({ phone: { $in: phoneVariants(tok) }, profileType: { $ne: "biker" } }).lean().catch(() => null);
      if (sp) chosen.add(String(sp._id)); else notFound.push(tok);
    }
  }
  if (!chosen.size) { await say(ctx.from, `⚠️ No sellers matched${notFound.length ? ` (${notFound.join(", ")})` : ""}. Reply with numbers like *1,3* or a phone number.`); return true; }
  const sups = await SupplierProfile.find({ _id: { $in: [...chosen] } }, { businessName: 1 }).lean().catch(() => []);
  await setState(ctx.phone, `qda_ready_${reqId}`, { chosen: [...chosen] });
  await ask(ctx.from,
    `📤 Send ${qRef({ _id: reqId })} to *${sups.length}* seller(s)?\n${sups.map(s => "• " + sellerName(s)).join("\n")}` + (notFound.length ? `\n\n⚠️ Not found: ${notFound.join(", ")}` : "") +
    `\n\nShould sellers see the customer's number?`,
    [{ id: `qda_send_${reqId}_0`, title: "🔒 Keep it private" }, { id: `qda_send_${reqId}_1`, title: "📞 Share number" }, { id: `qda_pick_${reqId}`, title: "✏️ Change" }]);
  return true;
}
async function adminSendPicked(ctx, reqId, share, data) {
  const chosen = data?.chosen || [];
  await clearState(ctx.phone);
  if (!chosen.length) { await say(ctx.from, "⌛ Selection expired - tap *Pick sellers* again."); return true; }
  const done = await sendToSellers(reqId, chosen, { shareCustomerPhone: share });
  await ask(ctx.from, `✅ Sent to ${done.length} seller(s): ${done.join(", ")}.\nTheir prices will come to you here.`,
    [{ id: `qda_quote_${reqId}`, title: "🧾 Make quote" }, { id: `qda_msg_${reqId}`, title: "💬 Msg customer" }, { id: `qda_open_${reqId}`, title: "⚙️ More" }]);
  return true;
}
async function adminReplies(ctx, reqId) {
  const req = await getReq(reqId);
  const reps = (req?.sellers || []).filter(s => s.status === "replied");
  if (!reps.length) { await say(ctx.from, "No seller prices yet."); return true; }
  for (const s of reps.slice(0, 5)) {
    await ask(ctx.from, `🏪 *${s.name}* · ${displayPhone(s.phone)}\n"${cut(s.replyText || "📷 photo", 700)}"`, sellerReplyButtons(reqId, s));
  }
  return true;
}
async function adminConnectPickSeller(ctx, reqId) {
  const req = await getReq(reqId);
  const list = (req?.sellers || []).filter(s => isObjId(String(s.supplierId)));
  if (!list.length) { await say(ctx.from, "This request hasn't been sent to any seller yet."); return true; }
  await pick(ctx.from, `🤝 *Connect* · ${qRef(req)}\nWhich seller?`, list.map(s => ({
    id: `qda_conn_${reqId}_${s.supplierId}`, title: s.name, description: `${s.status}${s.replyText ? " · " + cut(s.replyText, 40) : ""}`
  })));
  return true;
}
async function adminConnectMenu(ctx, reqId, sid) {
  const req = await getReq(reqId);
  const s = (req?.sellers || []).find(x => String(x.supplierId) === String(sid));
  if (!s) { await say(ctx.from, "Seller not on this request."); return true; }
  await pick(ctx.from, `🤝 *${s.name}* ↔ customer ${displayPhone(req.customerPhone)}\nWho gets whose number? You decide.`, [
    { id: `qda_share_${reqId}_${sid}_b`, title: "🔁 Both ways", description: "Each gets the other's number" },
    { id: `qda_share_${reqId}_${sid}_c`, title: "➡️ Seller gets customer #", description: "Seller calls the customer" },
    { id: `qda_share_${reqId}_${sid}_s`, title: "⬅️ Customer gets seller #", description: "Customer calls the seller" }
  ]);
  return true;
}

async function adminQuoteStart(ctx, reqId) {
  const req = await getReq(reqId);
  if (!req) { await say(ctx.from, "Request not found."); return true; }
  const reps = (req.sellers || []).filter(s => s.replyText).slice(0, 3);
  await setState(ctx.phone, `qda_items_${reqId}`, {});
  await say(ctx.from,
    `🧾 *Quote for ${qRef(req)}*\n_${cut(req.text, 200)}_\n` +
    (reps.length ? `\n📥 Seller prices:\n${reps.map(s => `• ${s.name}: ${cut(s.replyText, 120)}`).join("\n")}\n` : "") +
    `\nType the lines, *one per line*:\n_Cement 50kg x 20 @ 9.50_\n_River sand 3m3 x 1 @ 45_\n_Delivery @ 15_\n_note: Delivery Friday, pay on delivery_\n\nType *cancel* to stop.`);
  return true;
}
async function adminItemsTyped(ctx, reqId, txt) {
  const p = parseQuoteLines(txt);
  if (!p.lines.length) {
    await say(ctx.from, `⚠️ I couldn't read any priced lines.${p.errors.length ? `\nCheck: _${cut(p.errors[0], 60)}_` : ""}\nFormat: _Item x qty @ price_ - e.g. _Cement 50kg x 20 @ 9.50_`);
    return true;
  }
  await setState(ctx.phone, `qda_preview_${reqId}`, { lines: p.lines, notes: p.notes });
  await ask(ctx.from,
    `🧾 *Preview* · ${qRef({ _id: reqId })}\n\n` + p.lines.map((l, i) => `${i + 1}. ${l.item} × ${l.qty} @ ${money(l.unit)} = ${money(l.total)}`).join("\n") +
    `\n\n💵 *Total: ${money(p.total)}*` + (p.notes ? `\n🗒 ${p.notes}` : "") +
    (p.errors.length ? `\n\n⚠️ Skipped (no price): ${p.errors.map(e => cut(e, 30)).join("; ")}` : "") +
    `\n\nSend it as…`,
    [{ id: `qda_qz_${reqId}`, title: "🟢 ZimQuote quote" }, { id: `qda_qs_${reqId}`, title: "🏪 Seller's quote" }, { id: `qda_quote_${reqId}`, title: "✏️ Redo" }]);
  return true;
}
async function adminQuoteSellerPick(ctx, reqId, data) {
  if (!data?.lines?.length) { await say(ctx.from, "⌛ Draft expired - tap *Make quote* again."); return true; }
  const req = await getReq(reqId);
  const list = (req?.sellers || []).filter(s => isObjId(String(s.supplierId)))
    .sort((a, b) => (b.status === "replied") - (a.status === "replied")).slice(0, 9);
  await setState(ctx.phone, `qda_preview_${reqId}`, data);
  await pick(ctx.from, "🏪 Which seller's name goes on the quote?", [
    ...list.map(s => ({ id: `qda_qsel_${reqId}_${s.supplierId}`, title: s.name, description: s.status === "replied" ? "replied with a price" : s.status })),
    { id: `qda_qsother_${reqId}`, title: "🔎 Another seller…", description: "Type a name or phone number" }
  ]);
  return true;
}
async function adminSellerNameTyped(ctx, reqId, txt) {
  const data = ctx.sess.data;
  let sp = null;
  if (/^\+?\d{9,13}$/.test(txt.replace(/\s+/g, ""))) sp = await SupplierProfile.findOne({ phone: { $in: phoneVariants(txt) } }).lean().catch(() => null);
  if (!sp) sp = await SupplierProfile.findOne({ businessName: new RegExp(escRe(txt.trim()), "i"), profileType: { $ne: "biker" } }).lean().catch(() => null);
  return adminQuoteFinish(ctx, reqId, data, sp ? { kind: "seller", supplierId: String(sp._id) } : { kind: "seller", sellerNameOverride: txt.trim().slice(0, 80) });
}
async function adminQuoteFinish(ctx, reqId, data, opts) {
  await clearState(ctx.phone);
  if (!data?.lines?.length) { await say(ctx.from, "⌛ Draft expired - tap *Make quote* again."); return true; }
  try {
    const r = await buildAndSendQuote(reqId, { lines: data.lines, notes: data.notes || "", ...opts });
    await ask(ctx.from,
      `✅ *Quotation ${r.quote.number}* · ${money(r.quote.total)}${r.quote.sellerName ? ` · ${r.quote.sellerName}` : " · ZimQuote"}\n` +
      (r.delivered ? "📤 Sent to the customer." : "📬 Customer is outside the 24h window - queued and nudged. They'll get it when they reply.") + `\n📄 ${r.pdfUrl}`,
      [{ id: `qda_msg_${reqId}`, title: "💬 Msg customer" }, { id: `qda_open_${reqId}`, title: "⚙️ More" }]);
  } catch (e) {
    console.error("[QDESK] quote build:", e.message);
    await say(ctx.from, `⚠️ Couldn't create the quotation: ${e.message}`);
  }
  return true;
}
async function adminMsgTyped(ctx, reqId, txt) {
  await clearState(ctx.phone);
  try {
    const r = await messageCustomer(reqId, txt);
    await say(ctx.from, r.delivered ? "✅ Sent to the customer." : "📬 Queued - customer is outside the 24h window (nudge sent).");
  } catch (e) { await say(ctx.from, "⚠️ " + e.message); }
  return true;
}
async function adminSellerMsgTyped(ctx, reqId, sid, txt) {
  await clearState(ctx.phone);
  try { await messageSeller(reqId, sid, txt); await say(ctx.from, "✅ Sent to the seller."); }
  catch (e) { await say(ctx.from, "⚠️ " + e.message); }
  return true;
}
async function adminDealTyped(ctx, reqId, txt) {
  await clearState(ctx.phone);
  if (/^skip$/i.test(txt)) { await say(ctx.from, "👍"); return true; }
  const [v, c] = txt.split(/[,\s]+/).map(x => Number(String(x).replace(/[^\d.]/g, "")));
  await setStatus(reqId, "won", { dealValue: Number.isFinite(v) ? v : null, commission: Number.isFinite(c) ? c : null });
  await say(ctx.from, `💰 Saved${Number.isFinite(v) ? ` · deal ${money(v)}` : ""}${Number.isFinite(c) ? ` · commission ${money(c)}` : ""}.`);
  return true;
}

// ═════════════════════════════════════════════════════════════════════════════
// BOOKS: invoice → payment → receipt, plus cost of sale (ZimQuote quotes only)
// ─────────────────────────────────────────────────────────────────────────────
// A ZimQuote quote is saved as QT-… in the admin's own business books. From
// there: 🧾 Send invoice (INV-…, linked to the QT), 💵 Record payment (receipt
// RCPT-… to the customer; fully paid → request marked won), 📉 Record cost (what
// you paid the seller → Expense "Cost of sales"). Commission = paid − costs.
// Seller quotes are the seller's own sale, so they're not booked.
// ═════════════════════════════════════════════════════════════════════════════
function bookedQuote(req) {
  const qs = (req?.quotes || []).map((q, i) => ({ q, i })).filter(x => x.q.bookId);
  if (!qs.length) return null;
  return qs.filter(x => x.q.response === "accepted").slice(-1)[0] || qs.slice(-1)[0];
}
function booksLine(req) {
  const b = req?.books || {};
  if (!b.invoiceId) return "Send invoice · record payment · costs";
  const bal = Math.max(0, (b.invoiceTotal || 0) - (b.paid || 0));
  return `${b.invoiceNumber} · paid ${money(b.paid)}${bal > 0 ? ` · due ${money(bal)}` : " ✅"}`;
}
export function booksSummary(req) {
  const b = req?.books || {};
  const bq = bookedQuote(req);
  const total = b.invoiceId ? (b.invoiceTotal || 0) : (bq?.q.total || 0);
  const paid = b.paid || 0, costs = b.costTotal || 0;
  return {
    quoteNumber: bq?.q.number || "", quoteTotal: bq?.q.total || 0, booked: !!bq,
    invoiceNumber: b.invoiceNumber || "", invoicePdfUrl: b.invoicePdfUrl || "", hasInvoice: !!b.invoiceId,
    total, paid, balance: Math.max(0, Math.round((total - paid) * 100) / 100), costs,
    profit: Math.round((paid - costs) * 100) / 100,
    payments: b.payments || [], costList: b.costs || []
  };
}
const payInfo = () => String(process.env.ZQ_PAY_INFO || "").trim();   // e.g. "EcoCash 0771 234 567 (ZimQuote)"

export async function sendInvoice(reqId, { by = "admin", send = true } = {}) {
  const req = await getReq(reqId);
  if (!req) throw new Error("Request not found");
  const bq = bookedQuote(req);
  if (!bq) throw new Error("Make a 🟢 ZimQuote quote first - seller quotes are the seller's own sale, so they're not in your books.");
  const r = await convertQuoteToInvoice({ quoteId: bq.q.bookId, by, enforceTrial: false, notify: false });
  const inv = r.invoice;
  await QuoteRequest.updateOne({ _id: req._id }, { $set: {
    "books.bizId": inv.businessId, "books.invoiceId": inv._id, "books.invoiceNumber": inv.number,
    "books.invoicePdfUrl": r.url || "", "books.invoiceTotal": inv.total, lastActivityAt: new Date()
  } });
  let delivered = null;
  if (send) {
    if (!r.url) throw new Error("The invoice was saved but its PDF couldn't be made - check SITE_URL / PDF service.");
    const due = Math.max(0, inv.balance || 0);
    const res = await toCustomer(req, {
      type: "doc", link: r.url, filename: r.filename || `${inv.number}.pdf`, caption: `🧾 Invoice ${inv.number} - ZimQuote`,
      text: `🧾 *Invoice ${inv.number}* (${qRef(req)})\n\n💵 Amount due: *${money(due)}*` +
        (payInfo() ? `\n\n💳 *How to pay:*\n${payInfo()}` : "") + `\n\nPlease send proof of payment here once paid. 🙏`,
      buttons: [{ id: `qd_chat_${req._id}`, title: "💬 Message us" }]
    }, { nudge: `Your invoice ${inv.number} (${money(due)}) is ready. Reply to this message to view it.` });
    delivered = res.delivered;
    await logMsg(String(req._id), { from: by, to: "customer", text: `🧾 ${r.already ? "Resent" : "Sent"} invoice ${inv.number} · ${money(inv.total)}${delivered ? "" : " (queued)"}`, media: r.url });
  } else {
    await logMsg(String(req._id), { from: by, to: "admin", text: `🧾 Invoice ${inv.number} created · ${money(inv.total)}` });
  }
  return { invoice: inv, url: r.url, delivered, already: r.already };
}

export async function recordPayment(reqId, { amount, method = "Cash", by = "admin", sendReceipt = true } = {}) {
  let req = await getReq(reqId);
  if (!req) throw new Error("Request not found");
  if (!req.books?.invoiceId) { await sendInvoice(reqId, { by, send: false }); req = await getReq(reqId); }
  const r = await recordInvoicePayment({ invoiceId: req.books.invoiceId, amount, method, by, notify: false });
  const entry = { at: new Date(), amount: r.applied, method: r.payment.method, number: r.receiptNumber, pdfUrl: r.url || "", refId: r.payment._id };
  const upd = await QuoteRequest.findOneAndUpdate({ _id: req._id },
    { $push: { "books.payments": entry }, $inc: { "books.paid": r.applied }, $set: { lastActivityAt: new Date() } }, { new: true }).lean();
  const paidInFull = r.invoice.status === "paid";
  let delivered = null;
  if (sendReceipt) {
    const items = [];
    if (r.url) items.push({ type: "doc", link: r.url, filename: r.filename || `${r.receiptNumber}.pdf`, caption: `🧾 Receipt ${r.receiptNumber} - ZimQuote` });
    items.push({ type: "text",
      text: `✅ *Payment received - thank you!* (${qRef(req)})\n\n💵 ${money(r.applied)} (${r.payment.method}) · ${r.invoice.number}\n` +
        (paidInFull ? "🎉 Fully paid." : `Balance: *${money(r.invoice.balance)}*`),
      buttons: [{ id: `qd_chat_${req._id}`, title: "💬 Message us" }] });
    const res = await toCustomer(req, items, { nudge: `We received your payment of ${money(r.applied)}. Reply to this message for your receipt.` });
    delivered = res.delivered;
  }
  await logMsg(String(req._id), { from: by, to: sendReceipt ? "customer" : "admin", text: `💵 Payment ${money(r.applied)} (${r.payment.method}) · ${r.receiptNumber}${paidInFull ? " · fully paid" : ` · balance ${money(r.invoice.balance)}`}`, media: r.url || "" });
  if (paidInFull) {
    await setStatus(String(req._id), "won", { dealValue: upd?.books?.invoiceTotal ?? r.invoice.total,
      commission: Math.round(((upd?.books?.paid || 0) - (upd?.books?.costTotal || 0)) * 100) / 100, note: "fully paid" });
  }
  return { ...r, paidInFull, delivered, req: upd };
}

export async function recordCost(reqId, { amount, note = "", method = "Cash", by = "admin" } = {}) {
  const req = await getReq(reqId);
  if (!req) throw new Error("Request not found");
  let bizId = req.books?.bizId || bookedQuote(req)?.q.bookBizId;
  if (!bizId) { const h = await getHouseBiz(); bizId = h?._id; }
  if (!bizId) throw new Error("No ZimQuote business books found - set ZQ_HOUSE_BIZ_ID.");
  const e = await recordCostOfSale({ bizId, amount, method, by, note: `${qRef(req)} · ${note || "Paid seller/supplier"}` });
  const upd = await QuoteRequest.findOneAndUpdate({ _id: req._id }, {
    $push: { "books.costs": { at: new Date(), amount: e.amount, method: e.method, note: note || "", refId: e._id } },
    $inc: { "books.costTotal": e.amount }, $set: { "books.bizId": bizId, lastActivityAt: new Date() } }, { new: true }).lean();
  if (upd?.status === "won" && upd?.books?.invoiceId) {
    await QuoteRequest.updateOne({ _id: req._id }, { $set: { commission: Math.round(((upd.books.paid || 0) - (upd.books.costTotal || 0)) * 100) / 100 } });
  }
  await logMsg(String(req._id), { from: by, to: "admin", text: `📉 Cost ${money(e.amount)} · ${note || "seller/supplier"}` });
  return { expense: e, req: upd };
}

// ── WhatsApp admin screens ───────────────────────────────────────────────────
async function adminBooks(ctx, reqId) {
  const req = await getReq(reqId);
  if (!req) { await say(ctx.from, "Request not found."); return true; }
  const s = booksSummary(req);
  if (!s.booked) { await say(ctx.from, "💰 No ZimQuote quote on this request yet - tap *🧾 Make quote* → *🟢 ZimQuote quote* first."); return true; }
  await ask(ctx.from,
    `💰 *Books · ${qRef(req)}*\n\n📋 Quote: ${s.quoteNumber} · ${money(s.quoteTotal)}\n🧾 Invoice: ${s.hasInvoice ? s.invoiceNumber : "_not sent yet_"}\n` +
    `💵 Paid: *${money(s.paid)}*${s.balance > 0 ? ` · Due: *${money(s.balance)}*` : " ✅"}\n📉 Costs: ${money(s.costs)}\n📈 Profit so far: *${money(s.profit)}*`,
    [{ id: `qda_inv_${reqId}`, title: s.hasInvoice ? "🧾 Resend invoice" : "🧾 Send invoice" },
     s.balance > 0 ? { id: `qda_pay_${reqId}`, title: "💵 Record payment" } : { id: `qda_open_${reqId}`, title: "⚙️ More" },
     { id: `qda_cost_${reqId}`, title: "📉 Record cost" }]);
  return true;
}
async function adminSendInvoice(ctx, reqId) {
  try {
    const r = await sendInvoice(reqId, { by: ctx.phone });
    await ask(ctx.from,
      `🧾 *Invoice ${r.invoice.number}* · ${money(r.invoice.total)}${r.already ? " (resent)" : ""}\n` +
      (r.delivered ? "📤 Sent to the customer." : "📬 Customer is outside the 24h window - queued and nudged.") + (r.url ? `\n📄 ${r.url}` : ""),
      [{ id: `qda_pay_${reqId}`, title: "💵 Record payment" }, { id: `qda_open_${reqId}`, title: "⚙️ More" }]);
  } catch (e) { await say(ctx.from, "⚠️ " + e.message); }
  return true;
}
async function adminPayStart(ctx, reqId) {
  const req = await getReq(reqId);
  if (!req) { await say(ctx.from, "Request not found."); return true; }
  const s = booksSummary(req);
  if (!s.booked) { await say(ctx.from, "💰 Payments are recorded against a 🟢 ZimQuote quote - make one first."); return true; }
  if (s.hasInvoice && s.balance <= 0) { await say(ctx.from, `✅ ${s.invoiceNumber} is already fully paid.`); return true; }
  await setState(ctx.phone, `qda_pay_${reqId}`, {});
  await say(ctx.from, `💵 *Payment for ${qRef(req)}* · due *${money(s.balance)}*\n\nType the amount received, e.g. *${s.balance || 50}* or *${s.balance || 50} ecocash*\n(or *cancel*)`);
  return true;
}
function parseAmount(txt) {
  const m = String(txt || "").replace(/,/g, "").match(/\$?\s*(\d+(?:\.\d{1,2})?)/);
  return m ? Number(m[1]) : NaN;
}
async function adminPayTyped(ctx, reqId, txt) {
  const amount = parseAmount(txt);
  if (!(amount > 0)) { await say(ctx.from, "⚠️ Type just the amount, e.g. *250* or *250 ecocash* (or *cancel*)."); return true; }
  const method = normMethod(txt.replace(/[\d.,$]+/g, " ").trim().split(/\s+/)[0] || "");
  if (method) return adminPayFinish(ctx, reqId, amount, method);
  await setState(ctx.phone, `qda_paym_${reqId}`, { amount });
  await ask(ctx.from, `💵 ${money(amount)} - how was it paid?`,
    [{ id: `qda_pm_${reqId}_c`, title: "💵 Cash" }, { id: `qda_pm_${reqId}_e`, title: "📱 EcoCash" }, { id: `qda_pm_${reqId}_b`, title: "🏦 Bank" }]);
  return true;
}
async function adminPayMethodTyped(ctx, reqId, txt) {
  const method = normMethod(txt);
  if (!method) { await say(ctx.from, "Tap *Cash*, *EcoCash* or *Bank* above (or *cancel*)."); return true; }
  return adminPayFinish(ctx, reqId, ctx.sess.data?.amount, method);
}
async function adminPayFinish(ctx, reqId, amount, method) {
  await clearState(ctx.phone);
  if (!(Number(amount) > 0)) { await say(ctx.from, "⌛ That payment draft expired - tap *💵 Record payment* again."); return true; }
  try {
    const r = await recordPayment(reqId, { amount: Number(amount), method, by: ctx.phone });
    const partial = Number(amount) > r.applied ? `\n⚠️ Only ${money(r.applied)} was due - the extra wasn't recorded.` : "";
    await ask(ctx.from,
      `✅ *Payment saved* · ${r.receiptNumber}\n💵 ${money(r.applied)} (${r.payment.method}) on ${r.invoice.number}\n` +
      (r.paidInFull ? "🎉 Fully paid - request marked 🏆 won." : `Balance: *${money(r.invoice.balance)}*`) + partial +
      `\n${r.delivered === false ? "📬 Receipt queued (customer outside 24h window)." : "🧾 Receipt sent to the customer."}`,
      [{ id: `qda_cost_${reqId}`, title: "📉 Record cost" }, { id: `qda_books_${reqId}`, title: "💰 Books" }, { id: `qda_open_${reqId}`, title: "⚙️ More" }]);
  } catch (e) { await say(ctx.from, "⚠️ " + e.message); }
  return true;
}
async function adminCostTyped(ctx, reqId, txt) {
  const amount = parseAmount(txt);
  if (!(amount > 0)) { await say(ctx.from, "⚠️ Start with the amount, e.g. _180 Paid Harare Hardware_ (or *cancel*)."); return true; }
  await clearState(ctx.phone);
  const note = txt.replace(/^\s*\$?\s*[\d.,]+\s*/, "").trim();
  try {
    const r = await recordCost(reqId, { amount, note, by: ctx.phone });
    const s = booksSummary(r.req);
    await ask(ctx.from, `📉 *Cost saved* · ${money(amount)}${note ? ` · ${note}` : ""}\n💵 Paid in: ${money(s.paid)} · 📉 Costs: ${money(s.costs)}\n📈 Profit: *${money(s.profit)}*`,
      [{ id: `qda_books_${reqId}`, title: "💰 Books" }, { id: `qda_open_${reqId}`, title: "⚙️ More" }]);
  } catch (e) { await say(ctx.from, "⚠️ " + e.message); }
  return true;
}

export function quoteRequestLink() {
  return `https://wa.me/${BOT()}?text=${encodeURIComponent("Request a quote")}`;
}

export default { handleQuoteDesk, sendInvoice, recordPayment, recordCost, booksSummary, resendQuote, startRequest, suggestSellers, sendToSellers, buildAndSendQuote, messageCustomer, messageSeller, forwardSellerReply, shareContacts, setStatus, adminCreateRequest, parseQuoteLines, quoteRequestLink };
