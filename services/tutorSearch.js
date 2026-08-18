// services/tutorSearch.js
// ─── ZimQuote Education - PARENT: Find a Private Tutor ────────────────────────
//
// A tutor IS a SupplierProfile (profileType: "tutor"). This module is ONLY the
// parent-facing search funnel. When a parent taps a tutor result we hand off to
// showSellerMenu() in sellerChat.js, which already:
//   • sends the tutor the "someone opened your profile" alert WITH the parent's
//     phone number (via notifyAllSupplierLinkOpened → revealVisitorPhone), and
//   • opens the seller chat so the parent can enquire / book.
// So there is NO new notification or chat code here - we reuse the supplier rails.
//
// Funnel (all button-driven - no free-text states, so none of the
// shortcodeBlockedStates / _bizActiveStates invariants need touching):
//   subject → level → city (or Online) → rate → results → open tutor
//
// State is persisted the same way schoolSearch does it:
//   • biz users     → biz.sessionData.tutorSearch
//   • non-biz users → UserSession.tempData.tutorSearch
// ─────────────────────────────────────────────────────────────────────────────

import SupplierProfile from "../models/supplierProfile.js";
import { sendText, sendButtons, sendList } from "./metaSender.js";
import {
  TUTOR_SUBJECTS, TUTOR_LEVELS, TUTOR_RATE_RANGES,
  SCHOOL_CITIES, SCHOOL_SUBURB_TO_CITY,
  tutorSubjectLabel, tutorLevelLabel
} from "./schoolPlans.js";

const PAGE_SIZE = 6;

// ── City helpers (robust, multi-word safe - avoids the "select city" pitfalls) ─
function _titleCase(s = "") {
  return s.split(/\s+/).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}
function _citySlug(c = "") { return c.toLowerCase().replace(/\s+/g, "_"); }
function _cityFromSlug(slug = "") { return _titleCase(slug.replace(/_/g, " ").trim()); }

// ── State persistence (mirrors handleSchoolSearchActions) ────────────────────
async function _loadSearch(from, biz) {
  if (biz) return biz?.sessionData?.tutorSearch || {};
  const { default: UserSession } = await import("../models/userSession.js");
  const phone = from.replace(/\D+/g, "");
  const sess = await UserSession.findOne({ phone });
  return sess?.tempData?.tutorSearch || {};
}
async function _saveSearch(from, biz, saveBiz, search) {
  if (biz) {
    biz.sessionData = { ...(biz.sessionData || {}), tutorSearch: search };
    if (saveBiz) await saveBiz(biz);
    return;
  }
  const { default: UserSession } = await import("../models/userSession.js");
  const phone = from.replace(/\D+/g, "");
  await UserSession.findOneAndUpdate(
    { phone },
    { $set: { "tempData.tutorSearch": search } },
    { upsert: true }
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ENTRY - parent chose "Private Tutor" in the Education hub
// ─────────────────────────────────────────────────────────────────────────────
export async function startTutorSearch(from, biz, saveBiz) {
  await _saveSearch(from, biz, saveBiz, {});   // fresh funnel
  return _sendSubjectPicker(from, 0);
}

function _sendSubjectPicker(from, page = 0) {
  // WhatsApp caps lists at 10 rows. Page the subjects 8 at a time.
  const start = page * 8;
  const slice = TUTOR_SUBJECTS.slice(start, start + 8);
  const rows  = slice.map(s => ({ id: `tutor_sub_${s.id}`, title: s.label }));
  if (start + 8 < TUTOR_SUBJECTS.length) {
    rows.push({ id: `tutor_sub_more_${page + 1}`, title: "➡ More Subjects" });
  }
  rows.push({ id: "tutor_sub_any", title: "🔍 Any Subject" });

  return sendList(
    from,
`👩‍🏫 *Find a Private Tutor*

Which subject does your child need help with?

_Tip: online tutors can teach anywhere in Zimbabwe over WhatsApp video._`,
    rows
  );
}

function _sendLevelPicker(from, subjectLabel) {
  const rows = TUTOR_LEVELS.map(l => ({ id: `tutor_lvl_${l.id}`, title: l.label }));
  rows.push({ id: "tutor_lvl_any", title: "🎓 Any Level" });
  return sendList(from, `📚 *${subjectLabel}* - which level?`, rows);
}

function _sendCityPicker(from, page = 0) {
  const start = page * 8;
  const slice = SCHOOL_CITIES.slice(start, start + 8);
  const rows  = slice.map(c => ({ id: `tutor_city_${_citySlug(c)}`, title: `📍 ${c}` }));
  if (start + 8 < SCHOOL_CITIES.length) {
    rows.push({ id: `tutor_city_more_${page + 1}`, title: "➡ More Cities" });
  }
  rows.push({ id: "tutor_city_online", title: "💻 Online / Any City" });
  return sendList(from, "📍 Where do you want lessons?", rows);
}

function _sendRatePicker(from) {
  const rows = TUTOR_RATE_RANGES.map(r => ({ id: `tutor_rate_${r.id}`, title: r.label }));
  rows.push({ id: "tutor_rate_any", title: "💰 Any Budget" });
  return sendList(from, "💵 *Budget per hour?*", rows);
}

// ─────────────────────────────────────────────────────────────────────────────
// ACTION ROUTER - handles every tutor_* button tap. Returns true if handled.
// ─────────────────────────────────────────────────────────────────────────────
export async function handleTutorSearchAction({ action: a, from, biz, saveBiz }) {
  if (typeof a !== "string" || !a.startsWith("tutor_")) return false;

  const search = await _loadSearch(from, biz);

  // ── Subject paging ─────────────────────────────────────────────────────────
  if (a.startsWith("tutor_sub_more_")) {
    const page = parseInt(a.replace("tutor_sub_more_", ""), 10) || 0;
    await _sendSubjectPicker(from, page);
    return true;
  }
  // ── Subject chosen ─────────────────────────────────────────────────────────
  if (a.startsWith("tutor_sub_")) {
    const raw = a.replace("tutor_sub_", "");
    search.subject = raw === "any" ? null : raw;
    await _saveSearch(from, biz, saveBiz, search);
    const label = search.subject ? tutorSubjectLabel(search.subject) : "Any subject";
    await _sendLevelPicker(from, label);
    return true;
  }

  // ── Level chosen ───────────────────────────────────────────────────────────
  if (a.startsWith("tutor_lvl_")) {
    const raw = a.replace("tutor_lvl_", "");
    search.level = raw === "any" ? null : raw;
    await _saveSearch(from, biz, saveBiz, search);
    await _sendCityPicker(from, 0);
    return true;
  }

  // ── City paging ────────────────────────────────────────────────────────────
  if (a.startsWith("tutor_city_more_")) {
    const page = parseInt(a.replace("tutor_city_more_", ""), 10) || 0;
    await _sendCityPicker(from, page);
    return true;
  }
  // ── City / Online chosen ───────────────────────────────────────────────────
  if (a.startsWith("tutor_city_")) {
    const raw = a.replace("tutor_city_", "");
    if (raw === "online") {
      search.city       = null;
      search.onlineOnly = true;
    } else {
      search.city       = _cityFromSlug(raw);
      search.onlineOnly = false;
    }
    await _saveSearch(from, biz, saveBiz, search);
    await _sendRatePicker(from);
    return true;
  }

  // ── Rate chosen → run search ───────────────────────────────────────────────
  if (a.startsWith("tutor_rate_")) {
    const raw = a.replace("tutor_rate_", "");
    search.maxRate = null;
    if (raw !== "any") {
      const r = TUTOR_RATE_RANGES.find(x => x.id === raw);
      search.maxRate = r?.max ?? null;   // null max ("$20+") = no ceiling
      search.rateId  = raw;
    }
    search.page = 0;
    await _saveSearch(from, biz, saveBiz, search);
    return _runAndRender(from, biz, saveBiz, search);
  }

  // ── Pagination ─────────────────────────────────────────────────────────────
  if (a.startsWith("tutor_page_")) {
    search.page = parseInt(a.replace("tutor_page_", ""), 10) || 0;
    await _saveSearch(from, biz, saveBiz, search);
    return _runAndRender(from, biz, saveBiz, search);
  }

  // ── New search ─────────────────────────────────────────────────────────────
  if (a === "tutor_refine") {
    return startTutorSearch(from, biz, saveBiz);
  }

  // Note: tutor_open_<supplierId> is intentionally handled in chatbotEngine.js,
  // which owns the showSellerMenu import and the seller-chat session wiring.
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// QUERY - find matching tutors
// ─────────────────────────────────────────────────────────────────────────────
export async function runTutorSearch({ subject, level, city, onlineOnly, maxRate }) {
  const query = { profileType: "tutor", active: true };

  if (subject) query.subjects       = subject;
  if (level)   query.teachingLevels = level;

  if (onlineOnly) {
    query.teachingMode = { $in: ["online", "both"] };
  } else if (city) {
    // In-person tutors in the city PLUS online tutors (who reach any city).
    query.$or = [
      { "location.city": new RegExp(`^${city}$`, "i") },
      { teachingMode: { $in: ["online", "both"] } }
    ];
  }

  // Rate ceiling. hourlyRate 0 = "on request" - keep those visible.
  if (maxRate != null) {
    query.$and = [{ $or: [{ hourlyRate: { $lte: maxRate } }, { hourlyRate: 0 }] }];
  }

  return SupplierProfile.find(query)
    .sort({ tierRank: -1, rating: -1, hourlyRate: 1 })
    .limit(60)
    .lean();
}

async function _runAndRender(from, biz, saveBiz, search) {
  let tutors = await runTutorSearch(search);

  // Progressive fallback so a parent is never dead-ended.
  let note = "";
  if (!tutors.length && search.maxRate != null) {
    const s2 = { ...search, maxRate: null };
    tutors = await runTutorSearch(s2);
    if (tutors.length) note = "No tutors in that budget - showing all rates:";
  }
  if (!tutors.length && search.city && !search.onlineOnly) {
    const s3 = { ...search, city: null, onlineOnly: true };
    tutors = await runTutorSearch(s3);
    if (tutors.length) note = "No local tutors yet - showing online tutors who teach anywhere:";
  }
  if (!tutors.length && search.subject) {
    const s4 = { subject: search.subject };
    tutors = await runTutorSearch(s4);
    if (tutors.length) note = "Showing all tutors for that subject:";
  }

  if (!tutors.length) {
    await sendText(from,
`👩‍🏫 *No tutors yet for that search*

We don't have a matching tutor on ZimQuote yet.

📣 Know a great teacher? Tell them to list on ZimQuote - it's just $5/month and parents will find them here.`
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
    const where = t.onlineOnly || t.teachingMode === "online"
      ? "Online"
      : (t.location?.area || t.location?.city || "");
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