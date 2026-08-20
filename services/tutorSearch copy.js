// services/tutorSearch.js
// ─── ZimQuote Education - PARENT: Find a Private Tutor (TYPE-TO-SEARCH) ───────
//
// A tutor IS a SupplierProfile (profileType: "tutor"), but parents see a
// SCHOOL-STYLE profile - NOT the supplier "products / get quote" store. Opening a
// tutor shows: their pitch, any flyers/brochures, then a clean card (subjects,
// levels, price per hour, mode, qualifications) with an ✉️ Send Enquiry button.
// The tutor is notified of the view WITH the parent's phone number.
//
// Search: parent picks "Private Tutor" then TYPES, e.g.
//     maths olevel harare      english a level borrowdale
//     science tutor online     accounts olevel under $10/hr
// Results are a NUMBERED list - the parent replies with a number to open a tutor
// (so the list can grow without page-by-page tapping).
//
// Arming:  biz → sessionState "tutor_search_input"; non-biz → tempData.tutorSearchActive
// Enquiry: biz → sessionState "tutor_parent_enquiry"; non-biz → tempData.tutorEnquiryState
// ─────────────────────────────────────────────────────────────────────────────

import SupplierProfile from "../models/supplierProfile.js";
import { sendText, sendButtons, sendImage, sendDocument } from "./metaSender.js";
import {
  TUTOR_SUBJECTS, TUTOR_LEVELS, TUTOR_MODES,
  SCHOOL_CITIES, SCHOOL_SUBURB_TO_CITY,
  tutorSubjectLabel, tutorLevelLabel
} from "./schoolPlans.js";

const MAX_RESULTS = 40;

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

// ── Synonyms → canonical level id (longer phrases first) ─────────────────────
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

function _resolveCity(normText) {
  const cities = [...SCHOOL_CITIES].sort((a, b) => b.length - a.length);
  for (const c of cities) {
    if (new RegExp(`\\b${c.toLowerCase().replace(/\s+/g, "\\s+")}\\b`, "i").test(normText)) return c;
  }
  const suburbs = Object.keys(SCHOOL_SUBURB_TO_CITY || {}).sort((a, b) => b.length - a.length);
  for (const sub of suburbs) {
    if (new RegExp(`\\b${sub.toLowerCase().replace(/\s+/g, "\\s+")}\\b`, "i").test(normText)) return SCHOOL_SUBURB_TO_CITY[sub];
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// PARSER
// ─────────────────────────────────────────────────────────────────────────────
export function parseTutorQuery(text = "") {
  const norm = String(text).toLowerCase().replace(/[’']/g, "").replace(/\s+/g, " ").trim();

  let subject = null;
  for (const [id, syns] of Object.entries(SUBJECT_SYNONYMS)) {
    if (syns.some(s => new RegExp(`\\b${s.replace(/\s+/g, "\\s+")}\\b`, "i").test(norm))) { subject = id; break; }
  }
  let level = null;
  for (const [id, syns] of Object.entries(LEVEL_SYNONYMS)) {
    if (syns.some(s => new RegExp(`\\b${s.replace(/\s+/g, "\\s+")}\\b`, "i").test(norm))) { level = id; break; }
  }
  const onlineOnly = /\bonline\b|\bvirtual\b|\bwhatsapp lesson/i.test(norm);
  const city = onlineOnly ? null : _resolveCity(norm);

  let maxRate = null;
  const m =
    norm.match(/(?:under|below|less than|max|up to|upto|<)\s*\$?\s*(\d+)/) ||
    norm.match(/\$\s*(\d+)/) ||
    norm.match(/(\d+)\s*(?:\/\s*hr|\/\s*hour|per hour|dollars?|usd|bucks)/);
  if (m) maxRate = parseInt(m[1], 10);

  return { subject, level, city, onlineOnly, maxRate, raw: text };
}

// ─────────────────────────────────────────────────────────────────────────────
// ARM / ENTRY
// ─────────────────────────────────────────────────────────────────────────────
export async function startTutorSearch(from, biz, saveBiz) {
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

Type the *subject*, *level*, *area* (or "online"), and your *budget per hour*.

📝 *Examples:*
• _maths olevel harare_
• _english a level borrowdale_
• _science tutor online_
• _accounts olevel under $10/hr_
• _shona primary chitungwiza_
• _ict form 4 under $8 an hour_

_You don't need all of it - even just "maths harare" works._
_"under $8/hr" means you want a tutor who charges $8 an hour or less._`,
    buttons: [
      { id: "tutor_show_all", title: "🔎 Show All Tutors" },
      { id: "main_menu_back", title: "🏠 Main Menu" }
    ]
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// FREE-TEXT HANDLER  (armed) - a number opens a tutor, anything else = new search
// ─────────────────────────────────────────────────────────────────────────────
export async function handleTutorFreeTextSearch({ from, text, biz, saveBiz }) {
  const raw = (text || "").trim();
  const search = await _load(from, biz);

  // Reply with a number → open that tutor from the last result list.
  if (/^\d{1,3}$/.test(raw) && Array.isArray(search.resultIds) && search.resultIds.length) {
    const idx = parseInt(raw, 10) - 1;
    if (idx >= 0 && idx < search.resultIds.length) {
      return showTutorProfile(from, search.resultIds[idx], biz, saveBiz, { source: "direct" });
    }
    await sendText(from, `Please reply with a number between 1 and ${search.resultIds.length}.`);
    return true;
  }

  const parsed = parseTutorQuery(raw);
  if (!parsed.subject && !parsed.level && !parsed.city && !parsed.onlineOnly && parsed.maxRate == null) {
    await sendText(from,
`🤔 I didn't catch that. Try a subject and an area, for example:
• _maths olevel harare_
• _english online_
• _accounts form 4 under $10 an hour_`
    );
    return true;
  }

  parsed.page = 0;
  await _persist(from, biz, saveBiz, parsed);   // stays armed so numbers/new searches keep working
  return _renderResults(from, biz, saveBiz, parsed);
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
async function _load(from, biz) {
  if (biz) return biz?.sessionData?.tutorSearch || {};
  const { default: UserSession } = await import("../models/userSession.js");
  const phone = from.replace(/\D+/g, "");
  const sess = await UserSession.findOne({ phone });
  return sess?.tempData?.tutorSearch || {};
}

// ─────────────────────────────────────────────────────────────────────────────
// BUTTON ROUTER
// ─────────────────────────────────────────────────────────────────────────────
export async function handleTutorSearchAction({ action: a, from, biz, saveBiz }) {
  if (typeof a !== "string") return false;

  if (a === "tutor_refine")   return startTutorSearch(from, biz, saveBiz);
  if (a === "tutor_show_all") {
    const search = {};
    await _persist(from, biz, saveBiz, search);
    return _renderResults(from, biz, saveBiz, search);
  }
  if (a.startsWith("tutor_open_"))    return showTutorProfile(from, a.replace("tutor_open_", "").trim(), biz, saveBiz, { source: "direct" });
  if (a.startsWith("tutor_enquiry_")) return startTutorEnquiry(from, a.replace("tutor_enquiry_", "").trim(), biz, saveBiz);
  if (a.startsWith("tutor_contact_")) return _showTutorContact(from, a.replace("tutor_contact_", "").trim());
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
    .limit(MAX_RESULTS)
    .lean();
}

// ── One-line summary used in the numbered list ───────────────────────────────
function _tutorLine(t) {
  const subj = (t.subjects || []).slice(0, 3).map(tutorSubjectLabel).join(", ") || "Lessons";
  const lvl  = (t.teachingLevels || []).slice(0, 2).map(tutorLevelLabel).join("/");
  const rate = t.hourlyRate > 0 ? `$${t.hourlyRate}/hr` : "rate on request";
  const mode = t.teachingMode === "online" ? "online"
             : t.teachingMode === "both"   ? "in person or online"
             : (t.location?.area || t.location?.city || "in person");
  return [subj, lvl, rate, mode].filter(Boolean).join(" · ");
}

async function _renderResults(from, biz, saveBiz, search) {
  let tutors = await runTutorSearch(search);

  let note = "";
  if (!tutors.length && search.maxRate != null) {
    tutors = await runTutorSearch({ ...search, maxRate: null });
    if (tutors.length) note = "No tutors within that budget - showing all prices:";
  }
  if (!tutors.length && search.city && !search.onlineOnly) {
    tutors = await runTutorSearch({ ...search, city: null, onlineOnly: true });
    if (tutors.length) note = "No tutors in that area yet - showing online tutors who teach anywhere:";
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

We don't have a tutor for that on ZimQuote yet.

📣 Know a good teacher? Tell them to list on ZimQuote - it's just $5 a month and parents will find them here.`
    );
    return sendButtons(from, {
      text: "What would you like to do?",
      buttons: [
        { id: "tutor_refine",   title: "🔄 Search Again" },
        { id: "main_menu_back", title: "🏠 Main Menu" }
      ]
    });
  }

  // Save the ordered ids so a typed number opens the right tutor.
  search.resultIds = tutors.map(t => String(t._id));
  await _persist(from, biz, saveBiz, search);

  const lines = tutors.map((t, i) => {
    const badge = t.tierRank >= 3 ? " 🔥" : (t.verified ? " ✅" : "");
    return `*${i + 1}.* 👩‍🏫 ${t.businessName}${badge}\n     ${_tutorLine(t)}`;
  }).join("\n\n");

  const header = note ? `\u26a0\ufe0f ${note}` : `👩‍🏫 *Tutors found: ${tutors.length}*`;

  await sendText(from,
`${header}

${lines}

👉 *Reply with a number* (1-${tutors.length}) to see that tutor's full profile and message them.

_Or type a new search, e.g. "maths online under $10/hr"._`
  );

  return sendButtons(from, {
    text: "Or:",
    buttons: [
      { id: "tutor_refine",   title: "🔄 New Search" },
      { id: "main_menu_back", title: "🏠 Main Menu" }
    ]
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// TUTOR PROFILE  (school-style: pitch → flyers → brochures → card → Enquiry)
// ─────────────────────────────────────────────────────────────────────────────
export async function showTutorProfile(from, tutorId, biz, saveBiz, { source = "direct" } = {}) {
  const t = await SupplierProfile.findById(tutorId).lean();
  if (!t || t.profileType !== "tutor") {
    return sendButtons(from, {
      text: "❌ That tutor profile isn't available. Try another search.",
      buttons: [{ id: "tutor_refine", title: "🔄 Search Again" }]
    });
  }

  // Count the view + notify the tutor WITH the parent's phone number.
  SupplierProfile.findByIdAndUpdate(tutorId, { $inc: { monthlyViews: 1, viewCount: 1 } }).catch(() => {});
  try {
    const { notifyAllSupplierLinkOpened } = await import("./supplierNotifications.js");
    notifyAllSupplierLinkOpened(t, source, from).catch(() => {});
  } catch (_) {}

  // 1) Pitch
  if (t.smartLinkPitch && t.smartLinkPitch.trim()) {
    await sendText(from, t.smartLinkPitch.trim());
  }

  // 2) Flyers (images)
  for (const f of (t.smartLinkFlyers || [])) {
    if (!f?.url) continue;
    try { await sendImage(from, { imageUrl: f.url, caption: f.label || "" }); }
    catch (e) { console.warn("[Tutor flyer] send failed:", e.message); }
  }

  // 3) Brochures (documents / images)
  for (const b of (t.brochures || [])) {
    if (!b?.url) continue;
    try {
      if (b.isImage) await sendImage(from, { imageUrl: b.url, caption: b.label || "" });
      else await sendDocument(from, { link: b.url, filename: (b.label || "Brochure") + ".pdf" });
    } catch (e) { console.warn("[Tutor brochure] send failed:", e.message); }
  }

  // 4) Profile card
  const verified = t.verified ? " ✅ *Verified*" : "";
  const featured = t.tierRank >= 3 ? " 🔥 *Featured*" : "";
  const subjects = (t.subjects || []).map(tutorSubjectLabel).join(", ") || "Not specified";
  const levels   = (t.teachingLevels || []).map(tutorLevelLabel).join(", ") || "Not specified";
  const modeLabel = (TUTOR_MODES.find(m => m.id === t.teachingMode)?.label || "In person")
                      .replace(/^[^\w]+/, "").trim();
  const area     = [t.location?.area, t.location?.city].filter(Boolean).join(", ");

  const rateLine = t.hourlyRate > 0
    ? `💵 *Price:* $${t.hourlyRate} per hour${t.hourlyCurrency && t.hourlyCurrency !== "USD" ? " " + t.hourlyCurrency : ""}`
    : "💵 *Price:* on request";
  const groupLine = t.groupRate > 0 ? `\n👥 *Group lessons:* $${t.groupRate} per student/hour` : "";
  const examLine  = t.offersExamPrep ? "\n🔥 *Offers exam-prep / holiday intensives*" : "";
  const qualLine  = t.qualifications ? `\n🎓 *Qualifications:* ${t.qualifications}` : "";
  const expLine   = t.experienceYears > 0 ? `\n📅 *Experience:* ${t.experienceYears} year${t.experienceYears === 1 ? "" : "s"}` : "";
  const availLine = t.availability ? `\n🕒 *Available:* ${t.availability}` : "";
  const rating    = (t.reviewCount || 0) > 0
    ? `⭐ ${Number(t.rating).toFixed(1)} (${t.reviewCount} review${t.reviewCount === 1 ? "" : "s"})`
    : "⭐ No reviews yet";

  const card =
`👩‍🏫 *${t.businessName}*${verified}${featured}
${area ? "📍 " + area : ""}

📚 *Subjects:* ${subjects}
🎯 *Levels:* ${levels}
🖥 *Lessons:* ${modeLabel}
${rateLine}${groupLine}${examLine}${qualLine}${expLine}${availLine}

${rating}
👀 ${t.monthlyViews || 0} views this month`;

  return sendButtons(from, {
    text: card,
    buttons: [
      { id: `tutor_enquiry_${tutorId}`, title: "✉️ Send Enquiry" },
      { id: `tutor_contact_${tutorId}`, title: "📞 Show Contact" },
      { id: "tutor_refine",             title: "🔄 More Tutors" }
    ]
  });
}

async function _showTutorContact(from, id) {
  const t = await SupplierProfile.findById(id).lean();
  if (!t) return sendText(from, "❌ Not found.");
  const raw = t.contactDetails || t.phone || "";
  const display = raw.startsWith("263") ? "0" + raw.slice(3) : raw;
  return sendButtons(from, {
    text:
`📞 *${t.businessName}*

WhatsApp / Call: *${display}*

_Tell them you found them on ZimQuote._`,
    buttons: [
      { id: `tutor_enquiry_${id}`, title: "✉️ Send Enquiry" },
      { id: "tutor_refine",        title: "🔄 More Tutors" }
    ]
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// ENQUIRY  (parent → tutor, with the parent's phone number attached)
// ─────────────────────────────────────────────────────────────────────────────
export async function startTutorEnquiry(from, tutorId, biz, saveBiz) {
  const t = await SupplierProfile.findById(tutorId).lean();
  if (!t) return sendText(from, "❌ Tutor not found.");

  if (biz) {
    biz.sessionState = "tutor_parent_enquiry";
    biz.sessionData  = { ...(biz.sessionData || {}), enquiryTutorId: String(tutorId) };
    if (saveBiz) await saveBiz(biz);
  }
  const { default: UserSession } = await import("../models/userSession.js");
  const phone = from.replace(/\D+/g, "");
  await UserSession.findOneAndUpdate(
    { phone },
    { $set: { "tempData.tutorEnquiryState": "tutor_parent_enquiry", "tempData.enquiryTutorId": String(tutorId) } },
    { upsert: true }
  );

  return sendText(from,
`✉️ *Send an Enquiry to ${t.businessName}*

Type your question or message below and we'll send it to the tutor with your number so they can reply.

_Example: "Do you have space for O-Level Maths on weekends? What are your rates?"_

Type *cancel* to go back.`
  );
}

// Called by the engine when the parent is in the enquiry state.
export async function handleTutorEnquiryState({ from, text, biz, saveBiz }) {
  const message = (text || "").trim();
  const phone = from.replace(/\D+/g, "");
  const { default: UserSession } = await import("../models/userSession.js");

  const _clear = async () => {
    if (biz) { biz.sessionState = "ready"; biz.sessionData = { ...(biz.sessionData || {}), enquiryTutorId: null }; if (saveBiz) await saveBiz(biz); }
    await UserSession.updateOne({ phone }, { $unset: { "tempData.tutorEnquiryState": "", "tempData.enquiryTutorId": "" } });
  };

  if (message.toLowerCase() === "cancel") {
    await _clear();
    return sendButtons(from, { text: "❌ Enquiry cancelled.", buttons: [{ id: "tutor_refine", title: "🔄 Back to Tutors" }] });
  }
  if (!message || message.length < 3) {
    await sendText(from, "❌ Please type your question or message (at least 3 characters).");
    return true;
  }

  let tutorId = biz?.sessionData?.enquiryTutorId;
  if (!tutorId) {
    const sess = await UserSession.findOne({ phone }).lean();
    tutorId = sess?.tempData?.enquiryTutorId;
  }
  const t = tutorId ? await SupplierProfile.findById(tutorId).lean() : null;
  if (!t) { await _clear(); return false; }

  SupplierProfile.findByIdAndUpdate(tutorId, { $inc: { responseCount: 0, zqLinkConversions: 1 } }).catch(() => {});
  await _notifyTutorEnquiry(t, from, message);
  await _clear();

  const display = (t.contactDetails || t.phone || "");
  return sendButtons(from, {
    text:
`✅ *Enquiry sent to ${t.businessName}!*

Your message:
_${message}_

The tutor has your number and will contact you on this WhatsApp.${display ? "\n\n📞 " + (display.startsWith("263") ? "0" + display.slice(3) : display) : ""}`,
    buttons: [
      { id: `tutor_contact_${tutorId}`, title: "📞 Show Contact" },
      { id: "tutor_refine",             title: "🔄 More Tutors" }
    ]
  });
}

async function _notifyTutorEnquiry(tutor, parentPhone, message) {
  const display = parentPhone.startsWith("263") ? "0" + parentPhone.slice(3) : parentPhone;
  const targets = [...new Set([tutor.phone, ...(tutor.notificationContacts || [])].filter(Boolean))];
  const body =
`📩 *New tutor enquiry from ZimQuote!*

A parent is interested in your lessons.

💬 _"${message}"_

📞 Reply to them on: *${display}*

Contact them soon - fast replies win students.`;
  for (const to of targets) {
    try { await sendText(to, body); }
    catch (e) { console.warn("[Tutor enquiry notify] failed for", to, e.message); }
  }
}