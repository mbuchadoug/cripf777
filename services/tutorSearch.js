// services/tutorSearch.js
// ─── ZimQuote Education - PARENT: Find a Private Tutor (TYPE-TO-SEARCH) ───────
//
// A tutor IS a SupplierProfile (profileType: "tutor"). This module is ONLY the
// parent-facing search. Opening a tutor hands off to showSellerMenu() (in
// chatbotEngine), which already gives the tutor seller-chat AND the "someone
// viewed your profile" alert WITH the parent's phone number.
//
// NEW MODEL: instead of tapping subject → level → city → rate buttons, the parent
// picks "Private Tutor" then simply TYPES what they want, e.g.:
//     maths olevel harare
//     english a level borrowdale
//     science tutor online
//     accounts olevel under 10
//     shona primary chitungwiza
// parseTutorQuery() pulls out subject + level + city (or online) + max rate.
// There is NO city button/step at all, so the "select city" issue cannot occur.
//
// Arming (so the next typed message is read as a tutor search):
//   • biz users     → biz.sessionState = "tutor_search_input"
//   • non-biz users → UserSession.tempData.tutorSearchActive = true
// The engine's free-text router calls handleTutorFreeTextSearch() when armed.
// ─────────────────────────────────────────────────────────────────────────────

import SupplierProfile from "../models/supplierProfile.js";
import { sendText, sendButtons, sendList } from "./metaSender.js";
import {
  TUTOR_SUBJECTS, TUTOR_LEVELS,
  SCHOOL_CITIES, SCHOOL_SUBURB_TO_CITY,
  tutorSubjectLabel, tutorLevelLabel
} from "./schoolPlans.js";

const PAGE_SIZE = 6;

// ── Synonyms → canonical subject id ──────────────────────────────────────────
const SUBJECT_SYNONYMS = {
  mathematics: ["maths","math","mathematics","additional maths","add maths","pure maths","stats","statistics"],
  english:     ["english","language","literature","english lit","comprehension","grammar"],
  sciences:    ["science","sciences","biology","bio","chemistry","chem","physics","physical science","combined science","integrated science"],
  accounts:    ["accounts","accounting","principles of accounts","poa","commerce","business studies","economics","econ"],
  shona:       ["shona","chishona"],
  ndebele:     ["ndebele","isindebele"],
  ict:         ["ict","computers","computer science","computing","coding","programming","it lessons"],
  geography:   ["geography","geo"],
  history:     ["history"],
  heritage:    ["heritage","fareme","religious studies","divinity","family religion"],
  agriculture: ["agriculture","agric"],
  french:      ["french"],
  art:         ["art","fine art","art and design"],
  music:       ["music","piano","guitar"],
  early_learning: ["early learning","early childhood"]
};

// ── Synonyms → canonical level id (order matters: check longer phrases first) ─
const LEVEL_SYNONYMS = {
  cambridge: ["cambridge","igcse","gcse","as level","a2","checkpoint"],
  alevel:    ["a level","a-level","alevel","advanced level","form 5","form 6","form5","form6","lower 6","upper 6","l6","u6","f5","f6"],
  olevel:    ["o level","o-level","olevel","ordinary level","form 3","form 4","form3","form4","f3","f4"],
  zjc:       ["zjc","form 1","form 2","form1","form2","f1","f2","junior secondary"],
  primary:   ["primary","grade 1","grade 2","grade 3","grade 4","grade 5","grade 6","grade 7","grade one","grade two"],
  ecd:       ["ecd","pre-school","preschool","nursery","reception","grade 0"],
  college:   ["college","university","uni","tertiary","degree","diploma","hexco"],
  adult:     ["adult","professional","corporate"]
};

// ── City resolver (multi-word safe + suburb → city; no button, no error) ─────
function _resolveCity(normText) {
  // Longest city names first so "victoria falls" isn't shadowed by a stray word.
  const cities = [...SCHOOL_CITIES].sort((a, b) => b.length - a.length);
  for (const c of cities) {
    const re = new RegExp(`\\b${c.toLowerCase().replace(/\s+/g, "\\s+")}\\b`, "i");
    if (re.test(normText)) return c;
  }
  // Suburb → city (longest suburb keys first)
  const suburbs = Object.keys(SCHOOL_SUBURB_TO_CITY || {}).sort((a, b) => b.length - a.length);
  for (const sub of suburbs) {
    const re = new RegExp(`\\b${sub.toLowerCase().replace(/\s+/g, "\\s+")}\\b`, "i");
    if (re.test(normText)) return SCHOOL_SUBURB_TO_CITY[sub];
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// PARSER - turns a typed phrase into a structured tutor search
// ─────────────────────────────────────────────────────────────────────────────
export function parseTutorQuery(text = "") {
  const norm = String(text).toLowerCase().replace(/[’']/g, "").replace(/\s+/g, " ").trim();

  // subject
  let subject = null;
  for (const [id, syns] of Object.entries(SUBJECT_SYNONYMS)) {
    if (syns.some(s => new RegExp(`\\b${s.replace(/\s+/g, "\\s+")}\\b`, "i").test(norm))) { subject = id; break; }
  }

  // level
  let level = null;
  for (const [id, syns] of Object.entries(LEVEL_SYNONYMS)) {
    if (syns.some(s => new RegExp(`\\b${s.replace(/\s+/g, "\\s+")}\\b`, "i").test(norm))) { level = id; break; }
  }

  // online?
  const onlineOnly = /\bonline\b|\bvirtual\b|\bwhatsapp lesson/i.test(norm);

  // city (skip if online-only search)
  const city = onlineOnly ? null : _resolveCity(norm);

  // max rate: "under 10", "below 10", "less than 10", "max 10", "up to 10",
  // "<10", "$10", "10/hr", "10 per hour", "10 dollars"
  let maxRate = null;
  const m =
    norm.match(/(?:under|below|less than|max|up to|<|upto)\s*\$?\s*(\d+)/) ||
    norm.match(/\$\s*(\d+)/) ||
    norm.match(/(\d+)\s*(?:\/\s*hr|\/\s*hour|per hour|dollars?|usd)/);
  if (m) maxRate = parseInt(m[1], 10);

  return { subject, level, city, onlineOnly, maxRate, raw: text };
}

// ─────────────────────────────────────────────────────────────────────────────
// ARM / ENTRY - parent chose "Private Tutor" in the Education hub
// ─────────────────────────────────────────────────────────────────────────────
export async function startTutorSearch(from, biz, saveBiz) {
  // Arm the free-text router.
  if (biz) {
    biz.sessionState = "tutor_search_input";
    biz.sessionData  = { ...(biz.sessionData || {}), tutorSearch: {} };
    if (saveBiz) await saveBiz(biz);
  } else {
    const { default: UserSession } = await import("../models/userSession.js");
    const phone = from.replace(/\D+/g, "");
    await UserSession.findOneAndUpdate(
      { phone },
      { $set: { "tempData.tutorSearchActive": true, "tempData.tutorSearch": {} } },
      { upsert: true }
    );
  }

  return sendButtons(from, {
    text:
`👩‍🏫 *Find a Private Tutor*

Just *type* what you need - subject, level, area (or "online"), and budget:

📝 *Examples:*
• _maths olevel harare_
• _english a level borrowdale_
• _science tutor online_
• _accounts olevel under 10_
• _shona primary chitungwiza_
• _ict form 4 under 8_

_You don't need all of them - even just "maths harare" works._`,
    buttons: [
      { id: "tutor_show_all", title: "🔎 Show All Tutors" },
      { id: "main_menu_back", title: "🏠 Main Menu" }
    ]
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// FREE-TEXT HANDLER - engine calls this when the tutor search is armed
// Returns true if it produced a result, false to let other routers try.
// ─────────────────────────────────────────────────────────────────────────────
export async function handleTutorFreeTextSearch({ from, text, biz, saveBiz }) {
  const search = parseTutorQuery(text);

  // Nothing recognisable at all → gently re-prompt (stay armed).
  if (!search.subject && !search.level && !search.city && !search.onlineOnly && search.maxRate == null) {
    await sendText(from,
`🤔 I couldn't read that. Try a subject + area, e.g.:
• _maths olevel harare_
• _english online_
• _accounts form 4 under 10_`
    );
    return true;
  }

  search.page = 0;
  await _persist(from, biz, saveBiz, search);
  await _disarm(from, biz, saveBiz);          // consume the arm so later msgs aren't hijacked
  return _render(from, search);
}

async function _persist(from, biz, saveBiz, search) {
  if (biz) {
    biz.sessionData = { ...(biz.sessionData || {}), tutorSearch: search };
    if (saveBiz) await saveBiz(biz);
  } else {
    const { default: UserSession } = await import("../models/userSession.js");
    const phone = from.replace(/\D+/g, "");
    await UserSession.findOneAndUpdate(
      { phone }, { $set: { "tempData.tutorSearch": search } }, { upsert: true }
    );
  }
}
async function _disarm(from, biz, saveBiz) {
  if (biz) {
    if (biz.sessionState === "tutor_search_input") biz.sessionState = "ready";
    if (saveBiz) await saveBiz(biz);
  } else {
    const { default: UserSession } = await import("../models/userSession.js");
    const phone = from.replace(/\D+/g, "");
    await UserSession.updateOne({ phone }, { $unset: { "tempData.tutorSearchActive": "" } });
  }
}
async function _load(from, biz) {
  if (biz) return biz?.sessionData?.tutorSearch || {};
  const { default: UserSession } = await import("../models/userSession.js");
  const phone = from.replace(/\D+/g, "");
  const sess = await UserSession.findOne({ phone });
  return sess?.tempData?.tutorSearch || {};
}

// ─────────────────────────────────────────────────────────────────────────────
// BUTTON ROUTER - result pagination / refine / show-all. Returns true if handled.
// (tutor_open_<id> is handled in chatbotEngine, which owns showSellerMenu.)
// ─────────────────────────────────────────────────────────────────────────────
export async function handleTutorSearchAction({ action: a, from, biz, saveBiz }) {
  if (typeof a !== "string") return false;

  if (a === "tutor_refine") {
    return startTutorSearch(from, biz, saveBiz);
  }
  if (a === "tutor_show_all") {
    const search = { page: 0 };
    await _persist(from, biz, saveBiz, search);
    await _disarm(from, biz, saveBiz);
    return _render(from, search);
  }
  if (a.startsWith("tutor_page_")) {
    const search = await _load(from, biz);
    search.page = parseInt(a.replace("tutor_page_", ""), 10) || 0;
    await _persist(from, biz, saveBiz, search);
    return _render(from, search);
  }
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// QUERY
// ─────────────────────────────────────────────────────────────────────────────
export async function runTutorSearch({ subject, level, city, onlineOnly, maxRate }) {
  const query = { profileType: "tutor", active: true };
  if (subject) query.subjects       = subject;
  if (level)   query.teachingLevels = level;

  if (onlineOnly) {
    query.teachingMode = { $in: ["online", "both"] };
  } else if (city) {
    query.$or = [
      { "location.city": new RegExp(`^${city}$`, "i") },
      { teachingMode: { $in: ["online", "both"] } }
    ];
  }
  if (maxRate != null) {
    query.$and = [{ $or: [{ hourlyRate: { $lte: maxRate } }, { hourlyRate: 0 }] }];
  }

  return SupplierProfile.find(query)
    .sort({ tierRank: -1, rating: -1, hourlyRate: 1 })
    .limit(60)
    .lean();
}

async function _render(from, search) {
  let tutors = await runTutorSearch(search);

  let note = "";
  if (!tutors.length && search.maxRate != null) {
    tutors = await runTutorSearch({ ...search, maxRate: null });
    if (tutors.length) note = "No tutors in that budget - showing all rates:";
  }
  if (!tutors.length && search.city && !search.onlineOnly) {
    tutors = await runTutorSearch({ ...search, city: null, onlineOnly: true });
    if (tutors.length) note = "No local tutors yet - showing online tutors who teach anywhere:";
  }
  if (!tutors.length && search.subject) {
    tutors = await runTutorSearch({ subject: search.subject });
    if (tutors.length) note = "Showing all tutors for that subject:";
  }
  if (!tutors.length) {
    tutors = await runTutorSearch({});
    if (tutors.length) note = "No exact match - here are tutors on ZimQuote:";
  }

  if (!tutors.length) {
    await sendText(from,
`👩‍🏫 *No tutors yet*

We don't have a tutor on ZimQuote for that yet.

📣 Know a great teacher? Tell them to list on ZimQuote - just $5/month and parents will find them here.`
    );
    return sendButtons(from, {
      text: "What next?",
      buttons: [
        { id: "tutor_refine",   title: "🔄 Search Again" },
        { id: "main_menu_back", title: "🏠 Main Menu" }
      ]
    });
  }

  const total = tutors.length;
  const page  = search.page || 0;
  const slice = tutors.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);

  const rows = slice.map(t => {
    const subj = (t.subjects || []).slice(0, 3).map(tutorSubjectLabel).join(", ") || "Lessons";
    const lvl  = (t.teachingLevels || []).slice(0, 2).map(tutorLevelLabel).join("/");
    const rate = t.hourlyRate > 0 ? `$${t.hourlyRate}/hr` : "rate on request";
    const mode = t.teachingMode === "online" ? "💻 online"
               : t.teachingMode === "both"   ? "💻/🏠"
               : "🏠 in person";
    const where = t.teachingMode === "online" ? "Online" : (t.location?.area || t.location?.city || "");
    const desc = [subj, lvl, rate, mode, where].filter(Boolean).join(" · ");
    const badge = t.tierRank >= 3 ? " 🔥" : (t.verified ? " ✅" : "");
    return {
      id:          `tutor_open_${t._id}`,
      title:       `👩‍🏫 ${t.businessName}${badge}`,
      description: desc
    };
  });

  const nav = [];
  if (page > 0) nav.push({ id: `tutor_page_${page - 1}`, title: "⬅ Previous" });
  if ((page + 1) * PAGE_SIZE < total) nav.push({ id: `tutor_page_${page + 1}`, title: "➡ Next" });
  nav.push({ id: "tutor_refine", title: "🔄 New Search" });

  const header = note
    ? `\u26a0\ufe0f ${note}\n\n_Tap a tutor to see details & message them_`
    : `👩‍🏫 *Tutors found: ${total}*\n\n_Tap a tutor to see details & message them_`;

  return sendList(from, header, [...rows, ...nav]);
}