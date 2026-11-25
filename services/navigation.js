// services/navigation.js
// ─── ZimQuote WhatsApp navigation: Back · Main Menu · Help ───────────────────
//
// Makes the chatbot easy to move around in, for first-time users and everyone
// else, WITHOUT changing any existing flow:
//
//   ↩️  back / previous / dzoka       → the screen you were on before
//   🏠  menu / 0 / cancel / hi         → main menu   (unchanged - engine hard reset)
//   ❓  help / ? / commands            → one simple "how to use" screen
//   🔎  find / schools / my orders     → shortcuts when no flow is open
//   Buttons: "⬅ Back" (nav_back), "❓ Help" (nav_help), "🏠 Main Menu" (main_menu_back)
//
// HOW "BACK" WORKS
//   Every screen the user opens is pushed on a small stack in
//   UserSession.tempData.zqNav = { s: [screen ids], c: current, at }.
//   A screen id is something the engine can re-open on its own:
//     • a browse button id      find_school, grc_cart, sup_search_cat_…, *_menu
//     • a canonical profile id  sc_back_<seller>, sfaq_back_<school>, zqtg_tut_<tutor>
//       (pushed by the profile screens themselves, however they were opened)
//     • a Find level            zqf_sec_<section>, zqf_cat_<category>
//     • a typed search          t:electrician harare
//   "back" drops the current screen and re-opens the one before it, with any
//   half-typed step (quote items, enquiry text, checkout…) cleared first.
//   Buttons that START something (Get Quote, Pay, Confirm, Apply…) are never
//   replayed - from those, back simply re-opens the screen they came from.
//   The main menu clears the stack (it is the root).
//
// SAFETY
//   • Flows that already understand "back" keep it: registration, payments,
//     business tools input steps, the school enquiry/tour/grade steps, the
//     quote-request address step, mail, bikers, quote desk.
//   • Re-opening a profile on "back" never re-sends "someone viewed your
//     profile" alerts to the seller / school / admin (navContext.isNavReplay).
//   • Never throws into the engine: any error → the engine carries on as before.
// ─────────────────────────────────────────────────────────────────────────────

import { navStore, isNavReplay } from "./navContext.js";
export { isNavReplay };

const STACK_MAX = 15;
const STALE_MS  = 3 * 60 * 60 * 1000;      // 3 h without activity → start fresh

// ── Text snippets other modules append to their screens ──────────────────────
export const NAV_HINT      = "↩️ *back* · 🏠 *menu* · ❓ *help*";
export const NAV_HINT_LINE = "_Type *back* to go back, *menu* for the main menu, or *help*._";

export const WELCOME_GUIDE =
  "👋 *Welcome to ZimQuote!*\n" +
  "Find products, services, schools & groceries in Zimbabwe - all here on WhatsApp.\n\n" +
  "*How it works:*\n" +
  "1️⃣ Tap *Menu* below and pick an option\n" +
  "2️⃣ Or just type what you need - e.g. _plumber harare_, _cement 20 bags_, _form 1 boarding_\n" +
  "3️⃣ In a list? *Reply with the number* to open it\n\n" +
  "🏠 *menu* = start again · ↩️ *back* = go back · ❓ *help* = this guide";

// ── Words ─────────────────────────────────────────────────────────────────────
const BACK_RE = /^(?:back|go back|goback|previous|prev|dzoka|dzokera|buyela|⬅️?|↩️?|🔙)$/iu;
const HELP_RE = /^(?:help|\?|help me|helpme|commands|command|how|how to use|how does this work|how does it work|guide|instructions|rubatsiro|ndibatsirei|ndibatsirewo|usizo|ncedo)$/i;
const SHORTCUTS = [
  { re: /^(?:schools?|tutors?|find a school|education|colleges?)$/i, action: "find_school" },
  { re: /^(?:find|search|browse|shop|shopping|marketplace|market|buy|hire|find buy (?:&|and) hire)$/i, action: "find_supplier" },
  { re: /^(?:my orders|my order)$/i, action: "my_orders" }
];

// Words that are never stored as a "typed search" screen
const NOT_A_SEARCH = new Set([
  "hi","hie","hey","hello","helo","howzit","yo","sup","start","home","menu","main menu","0","00","000",
  "cancel","stop","exit","quit","bye","back","b","more","list","results","yes","no","y","n","ok","okay",
  "k","sure","thanks","thank you","done","skip","none","same","this","pay","paid","unsubscribe",
  "subscribe","opt out","opt in","pause","resume","quotes","my quotes","my requests","request","help","?"
]);

// ── State keys that mean "the user is in the middle of typing an answer" ─────
const INPUT_KEYS = [
  "buyerRequestState", "orderState", "sellerRequestReplyState", "schoolApplyState",
  "schoolEnquiryState", "supplierAccountState", "scState", "scSellerQuoteState",
  "tutorEnquiryState", "mailState", "bikerState", "supplierSearchState", "zqPay",
  "zqPaySetup", "zqp", "grc", "pendingQuoteReply", "pendingOfferResponse",
  "pendingPriceUpdate", "sellerPendingQuestion", "sfaqState"
];
// Business (biz.sessionState) states that are just browsing
const BIZ_IDLE_RE  = /^(?:ready|supplier_search_city|sfaq_menu|sfaq_branch_pick|school_search.*)$/;
// Buyer-side biz states where our "back" is safe (reset to ready, re-open screen)
const BIZ_BUYER_RE = /^(?:sc_|supplier_search|school_search|tutor_search)/;

// Cleared before re-opening an earlier screen (half-done buyer steps only)
const CLEAR_KEYS = [
  "buyerRequestState", "pendingBuyerRequest", "buyerRequestMode", "orderState",
  "scSellerQuoteState", "schoolEnquiryState", "tutorEnquiryState",
  "schoolApplyState", "schoolApplyData", "schoolApplyId", "pendingQuoteReply",
  "sellerRequestReplyState", "pendingOfferResponse", "pendingDraftQuote",
  "grc", "zqp", "zqFind"
];

// ── Which taps are re-openable screens ───────────────────────────────────────
const SCREEN_EXACT = new Set([
  "find_supplier", "find_school", "find_education", "my_orders", "buyer_my_requests",
  "my_supplier_account", "school_account", "school_my_profile", "biz_tools_menu",
  "marketplace_menu", "school_marketplace", "sup_more_options", "school_more_options",
  "suppliers_home", "sup_search_all", "school_search_refine",
  "grc_home", "grc_pkgs", "grc_aisles", "grc_cart", "grc_orders"
]);
const SCREEN_PREFIX = [
  "zqf_", "sup_search_cat_", "sup_search_city_", "school_search_", "grc_pkg_",
  "sc_catalogue_", "zqtg_tut_", "sfaq_brmenu_", "edu_", "tutor_open_", "inst_"
];
// Ids with these words start/commit something - never replayed even if a
// prefix above matches.
const NEVER_RE = /(?:toggle|confirm|_pay|pay_|_add|add_|remove|delete|clear|checkout|submit|send|save|apply|register|_reg_|upgrade|activate|plan_|share|edit|update)/;

export function isScreenAction(a = "") {
  const s = String(a || "").toLowerCase();
  if (!s || s === "main_menu_back" || s === "main_menu" || s.startsWith("nav_")) return false;
  if (SCREEN_EXACT.has(s)) return true;
  if (NEVER_RE.test(s)) return false;
  if (SCREEN_PREFIX.some(p => s.startsWith(p))) return true;
  return /_menu$/.test(s);           // business-tools sub menus (sales_menu, stock_menu …)
}

// ── Stack helpers ────────────────────────────────────────────────────────────
const _digits = (p) => String(p || "").replace(/\D+/g, "");
async function _US() { return (await import("../models/userSession.js")).default; }

function _norm(raw) {
  const n = raw && typeof raw === "object" ? raw : {};
  const at = n.at ? new Date(n.at).getTime() : 0;
  if (!at || Date.now() - at > STALE_MS) return { s: [], c: "home", at: new Date() };
  return { s: Array.isArray(n.s) ? n.s.filter(Boolean).map(String).slice(-STACK_MAX) : [], c: n.c || "", at: new Date() };
}
function _push(nav, id) {
  id = String(id || "").slice(0, 120);
  if (!id) return nav;
  const i = nav.s.lastIndexOf(id);
  if (i >= 0) nav.s = nav.s.slice(0, i + 1);   // re-visiting = jump back to it (no ping-pong)
  else nav.s.push(id);
  if (nav.s.length > STACK_MAX) nav.s = nav.s.slice(-STACK_MAX);
  nav.c = id;
  nav.at = new Date();
  return nav;
}
async function _save(phone, nav) {
  const US = await _US();
  await US.updateOne({ phone }, { $set: { "tempData.zqNav": { s: nav.s, c: nav.c, at: nav.at || new Date() } } }, { upsert: true });
}

/**
 * A screen opened by TYPING (a number, a link) tells the stack where the user
 * now is, e.g. showSellerMenu → pushScreen(from, "sc_back_<id>").
 * No-op while "back" is re-opening a screen. Never throws.
 */
export async function pushScreen(from, id) {
  try {
    if (!id || isNavReplay()) return;
    const phone = _digits(from);
    if (!phone) return;
    const US = await _US();
    const sess = await US.findOne({ phone }, { "tempData.zqNav": 1 }).lean();
    await _save(phone, _push(_norm(sess?.tempData?.zqNav), id));
  } catch (e) { console.warn("[NAV PUSH]", e.message); }
}

/** Main menu = root: forget the trail. Never throws. */
export async function resetNav(from) {
  try {
    const phone = _digits(from);
    if (!phone) return;
    await _save(phone, { s: [], c: "home", at: new Date() });
  } catch (_) {}
}

// ── State checks ─────────────────────────────────────────────────────────────
function _activeInput(td, k) {
  const v = td[k];
  if (!v || v === "ready") return false;
  if (k === "sfaqState") return /awaiting/.test(String(v));
  if (k === "schoolApplyState") return v !== "awaiting_start";
  return true;
}
function _isIdle(td, sess, biz, ignore = []) {
  if (sess?.supplierRegState) return false;
  if (biz?.sessionState && !BIZ_IDLE_RE.test(biz.sessionState)) return false;
  if (INPUT_KEYS.some(k => !ignore.includes(k) && _activeInput(td, k))) return false;
  if (Object.keys(td).some(k => /^qd/.test(k) && td[k])) return false;
  return true;
}
// Flows that already handle a typed "back" themselves → leave it to them
function _flowOwnsBack(td, sess, biz) {
  if (sess?.supplierRegState) return true;
  const st = String(biz?.sessionState || "");
  if (st && !BIZ_IDLE_RE.test(st) && !BIZ_BUYER_RE.test(st)) return true;
  if (td.zqPay || td.zqPaySetup || td.mailState || td.bikerState || td.supplierAccountState || td.pendingPriceUpdate) return true;
  if (Object.keys(td).some(k => /^qd/.test(k) && td[k])) return true;
  if (td.buyerRequestState === "awaiting_service_address") return true;
  if (/awaiting/.test(String(td.sfaqState || ""))) return true;   // schoolFAQ: back → school card
  return false;
}
function _isSearchText(t) {
  const s = String(t || "").trim();
  if (s.length < 2 || s.length > 80) return false;
  if (!/[a-z]/i.test(s)) return false;
  if (NOT_A_SEARCH.has(s.toLowerCase())) return false;
  if (/\d{7,}/.test(s.replace(/[\s().+-]/g, "")) || /@|^(?:admin|pay|push)\b/i.test(s)) return false;   // phone numbers, emails, admin commands
  if (/^(?:zq:|apply:)/i.test(s)) return false;
  return true;
}

async function _clearForBack(phone, td, biz, saveBiz) {
  const unset = {};
  const set = {};
  for (const k of CLEAR_KEYS) if (td[k] !== undefined) unset["tempData." + k] = "";
  if (/awaiting/.test(String(td.sfaqState || ""))) set["tempData.sfaqState"] = "sfaq_menu";
  if (td.scState && td.scState !== "ready") set["tempData.scState"] = "ready";
  if (Object.keys(unset).length || Object.keys(set).length) {
    const US = await _US();
    await US.updateOne({ phone }, { ...(Object.keys(unset).length ? { $unset: unset } : {}), ...(Object.keys(set).length ? { $set: set } : {}) });
  }
  if (biz && saveBiz && biz.sessionState && !BIZ_IDLE_RE.test(biz.sessionState)) {
    biz.sessionState = "ready";
    try { await saveBiz(biz); } catch (_) {}
  }
}

// ── Screens ──────────────────────────────────────────────────────────────────
async function _sender() { return import("./metaSender.js"); }

export async function sendHelp(from) {
  const { sendText, sendButtons } = await _sender();
  await sendText(from,
    "❓ *How to use ZimQuote*\n\n" +
    "👉 *Tap a button*, or *reply with a number* when you see a list.\n" +
    "👉 Or just *type what you need* - e.g. _electrician harare_, _cement 20 bags_, _form 1 boarding school_.\n\n" +
    "*Words that work anywhere:*\n" +
    "🏠 *menu* or *0* - main menu\n" +
    "↩️ *back* - previous screen\n" +
    "✖️ *cancel* - stop what you are doing\n" +
    "❓ *help* - this guide\n\n" +
    "*Quick ways in:*\n" +
    "🔍 *find* - Find, Buy & Hire\n" +
    "🎓 *schools* - schools & tutors\n" +
    "🛒 *groceries* - order groceries\n" +
    "📝 *request* - get quotes from many sellers\n" +
    "📋 *my orders* · *quotes* - your orders & quotes\n" +
    "🏪 Selling? *pause* / *resume* request alerts"
  );
  return sendButtons(from, {
    text: "Where would you like to go?",
    buttons: [
      { id: "find_supplier",  title: "🔍 Find, Buy & Hire" },
      { id: "find_school",    title: "🎓 Schools & Tutors" },
      { id: "main_menu_back", title: "🏠 Main Menu" }
    ]
  });
}

async function _mainMenu(from) {
  const { sendMainMenu } = await import("./metaMenus.js");
  return sendMainMenu(from);
}

async function goBack({ from, phone, td, nav, biz, saveBiz, dispatch }) {
  const s = nav.s.slice();
  if (s.length && nav.c === s[s.length - 1]) s.pop();       // leave the screen you are on
  const target = s[s.length - 1] || null;

  await _clearForBack(phone, td, biz, saveBiz);
  await _save(phone, { s, c: target || "home", at: new Date() });

  if (!target) return _mainMenu(from);
  console.log(`[NAV] back ${phone} → ${target}`);
  try {
    const store = navStore.getStore() || {};
    // Child context: everything this replay starts (even non-awaited alerts)
    // sees replay=true, so "profile viewed" alerts are not sent again.
    await navStore.run({ ...store, replay: true }, () =>
      dispatch(target.startsWith("t:") ? target.slice(2) : target));
  } catch (e) {
    console.warn("[NAV BACK]", e.message);
    return _mainMenu(from);
  }
  return true;
}

// Find, Buy & Hire levels as re-openable screens
async function _findAction({ from, a, biz, saveBiz, dispatch }) {
  const fm = await import("./findMenu.js");
  if (a === "zqf_home") { await fm.sendFindHome(from); return true; }
  const sec = a.match(/^zqf_sec_(.+)$/);
  if (sec) {
    let label = sec[1];
    try {
      const { getAllSections } = await import("./categoryRegistry.js");
      const s = (await getAllSections()).find(x => x.id === sec[1]);
      if (s) label = s.label || s.id;
    } catch (_) {}
    await fm.showSection({ from, sectionId: sec[1], label, biz, saveBiz, dispatch });
    return true;
  }
  const cat = a.match(/^zqf_cat_(.+)$/);
  if (cat) { await fm.runCategoryBrowse({ from, biz, saveBiz, category: cat[1], dispatch }); return true; }
  return false;
}

/**
 * Called by the engine for every message, right after the user's business is
 * loaded and BEFORE any flow handler. Returns true when it fully handled the
 * message (back / help / shortcut / Find level); otherwise it only notes the
 * screen and returns false so the engine carries on exactly as before.
 */
export async function handleNavigation({ from, phone, text = "", a = "", isTap = false, hasImage = false, nested = false, biz = null, saveBiz = null, dispatch }) {
  const t  = String(text || "").trim();
  const lt = t.toLowerCase();
  a = String(a || "").toLowerCase();

  // Find levels must work for internal dispatches (that is how "back" reopens them)
  if (a.startsWith("zqf_")) return _findAction({ from, a, biz, saveBiz, dispatch });
  if (nested) return false;                 // the engine talking to itself - not the user

  phone = phone || _digits(from);
  const US = await _US();
  const sess = await US.findOne({ phone }, { tempData: 1, supplierRegState: 1 }).lean();
  const td  = sess?.tempData || {};
  const nav = _norm(td.zqNav);

  // ── ↩️ BACK ────────────────────────────────────────────────────────────────
  const backTap  = a === "nav_back";
  const backWord = !hasImage && BACK_RE.test(lt);      // typed "back" also arrives as a = "back"
  if (backTap || backWord) {
    if (!backTap && _flowOwnsBack(td, sess, biz)) return false;
    await goBack({ from, phone, td, nav, biz, saveBiz, dispatch });
    return true;
  }

  // ── ❓ HELP ────────────────────────────────────────────────────────────────
  if (a === "nav_help" || (!hasImage && HELP_RE.test(lt) && _isIdle(td, sess, biz, ["grc", "scState"]))) {
    nav.c = "__help__";                       // back from help → the screen before it
    try { await _save(phone, nav); } catch (_) {}
    await sendHelp(from);
    return true;
  }

  const idle = _isIdle(td, sess, biz);

  // ── 🔎 SHORTCUTS (only when no flow is waiting for an answer) ──────────────
  if (!isTap && !hasImage && idle) {
    const sc = SHORTCUTS.find(x => x.re.test(lt));
    if (sc) {
      await _save(phone, _push(nav, sc.action));
      await dispatch(sc.action);
      return true;
    }
  }

  // ── 📝 Note where the user is (never blocks) ───────────────────────────────
  try {
    if (isTap) {
      if (isScreenAction(a)) _push(nav, a);
      else nav.c = "__tap__";
    } else if (hasImage) {
      nav.c = "__tap__";
    } else if (/^\d{1,3}$/.test(t)) {
      nav.c = "__num__";
    } else if (/^zq:(?:group|sgroup|tgroup):[a-z0-9-]+$/i.test(t)) {
      _push(nav, "t:" + t);
    } else if (idle && _isSearchText(t)) {
      _push(nav, "t:" + t);
    } else {
      nav.c = "__text__";
    }
    await _save(phone, nav);
  } catch (e) { console.warn("[NAV NOTE]", e.message); }
  return false;
}
