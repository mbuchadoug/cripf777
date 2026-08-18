// services/institutionSearch.js
// ─── ZimQuote Education - PARENT: Find a College / Training (TYPE-TO-SEARCH) ──
//
// Specialised institutions (culinary, driving, music, vocational, college, etc.)
// are SchoolProfile docs with institutionType !== "academic". Searched SEPARATELY
// from academic schools (schoolSearch.js excludes them), and now via TYPED
// commands - no category button maze, no city button, so no "select city" step.
//
// The parent picks "College / Course" then TYPES, e.g.:
//     driving school harare
//     culinary bulawayo
//     IT college harare
//     hairdressing mutare
//     welding gweru
// parseInstitutionQuery() pulls out the category + city.
//
// Arming:
//   • biz users     → biz.sessionState = "inst_search_input"
//   • non-biz users → UserSession.tempData.instSearchActive = true
// ─────────────────────────────────────────────────────────────────────────────

import SchoolProfile from "../models/schoolProfile.js";
import { sendText, sendButtons, sendList } from "./metaSender.js";
import {
  INSTITUTION_CATEGORIES, institutionLabel,
  SCHOOL_CITIES, SCHOOL_SUBURB_TO_CITY, feeRangeLabel
} from "./schoolPlans.js";

const PAGE_SIZE = 6;

// ── Synonyms → institutionType id ────────────────────────────────────────────
const CATEGORY_SYNONYMS = {
  culinary:   ["culinary","cooking","chef","catering","cookery","pastry","baking","food preparation"],
  driving:    ["driving","drivers","driver","class 4","class 2","vid","motoring"],
  music_arts: ["music","piano","guitar","dance","drama","theatre","fine art","arts academy","art school","ballet","singing","voice"],
  vocational: ["vocational","welding","tailoring","dressmaking","carpentry","plumbing","mechanic","motor mechanic","electrical","building","brick","skills training","trade"],
  beauty:     ["beauty","cosmetology","hairdressing","hair","nails","spa","makeup","barber"],
  computer:   ["computer","it college","ict","coding","software","programming","graphic design","web design","networking","cisco"],
  language:   ["language","english school","french","chinese","mandarin","portuguese","spanish","tefl"],
  sports:     ["sport","sports academy","football academy","soccer academy","tennis academy","cricket academy","athletics"],
  college:    ["college","polytechnic","university","tertiary","acca","cima","degree","diploma","professional","institute"],
  special_ed: ["special needs","remedial","special education","learning support","autism","therapy school"],
  other:      ["other","training centre","training center"]
};

function _titleCase(s = "") {
  return s.split(/\s+/).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}
function _resolveCity(normText) {
  const cities = [...SCHOOL_CITIES].sort((a, b) => b.length - a.length);
  for (const c of cities) {
    const re = new RegExp(`\\b${c.toLowerCase().replace(/\s+/g, "\\s+")}\\b`, "i");
    if (re.test(normText)) return c;
  }
  const suburbs = Object.keys(SCHOOL_SUBURB_TO_CITY || {}).sort((a, b) => b.length - a.length);
  for (const sub of suburbs) {
    const re = new RegExp(`\\b${sub.toLowerCase().replace(/\s+/g, "\\s+")}\\b`, "i");
    if (re.test(normText)) return SCHOOL_SUBURB_TO_CITY[sub];
  }
  return null;
}

export function parseInstitutionQuery(text = "") {
  const norm = String(text).toLowerCase().replace(/[’']/g, "").replace(/\s+/g, " ").trim();
  let category = null;
  for (const [id, syns] of Object.entries(CATEGORY_SYNONYMS)) {
    if (syns.some(s => new RegExp(`\\b${s.replace(/\s+/g, "\\s+")}\\b`, "i").test(norm))) { category = id; break; }
  }
  const city = _resolveCity(norm);
  return { category, city, raw: text };
}

// ─────────────────────────────────────────────────────────────────────────────
// ARM / ENTRY - parent chose "College / Course"
// ─────────────────────────────────────────────────────────────────────────────
export async function startInstitutionSearch(from, biz, saveBiz) {
  if (biz) {
    biz.sessionState = "inst_search_input";
    biz.sessionData  = { ...(biz.sessionData || {}), instSearch: {} };
    if (saveBiz) await saveBiz(biz);
  } else {
    const { default: UserSession } = await import("../models/userSession.js");
    const phone = from.replace(/\D+/g, "");
    await UserSession.findOneAndUpdate(
      { phone },
      { $set: { "tempData.instSearchActive": true, "tempData.instSearch": {} } },
      { upsert: true }
    );
  }

  return sendButtons(from, {
    text:
`🎓 *Find a College / Course*

Just *type* the course and area:

📝 *Examples:*
• _driving school harare_
• _culinary bulawayo_
• _IT college harare_
• _hairdressing mutare_
• _welding gweru_
• _music academy harare_

_Even just "driving harare" or "college bulawayo" works._`,
    buttons: [
      { id: "inst_show_all",  title: "🔎 Show All Colleges" },
      { id: "main_menu_back", title: "🏠 Main Menu" }
    ]
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// FREE-TEXT HANDLER
// ─────────────────────────────────────────────────────────────────────────────
export async function handleInstitutionFreeTextSearch({ from, text, biz, saveBiz }) {
  const search = parseInstitutionQuery(text);
  if (!search.category && !search.city) {
    await sendText(from,
`🤔 I couldn't read that. Try a course + city, e.g.:
• _driving harare_
• _culinary bulawayo_
• _IT college mutare_`
    );
    return true;
  }
  search.page = 0;
  await _persist(from, biz, saveBiz, search);
  await _disarm(from, biz, saveBiz);
  return _render(from, search);
}

async function _persist(from, biz, saveBiz, search) {
  if (biz) {
    biz.sessionData = { ...(biz.sessionData || {}), instSearch: search };
    if (saveBiz) await saveBiz(biz);
  } else {
    const { default: UserSession } = await import("../models/userSession.js");
    const phone = from.replace(/\D+/g, "");
    await UserSession.findOneAndUpdate(
      { phone }, { $set: { "tempData.instSearch": search } }, { upsert: true }
    );
  }
}
async function _disarm(from, biz, saveBiz) {
  if (biz) {
    if (biz.sessionState === "inst_search_input") biz.sessionState = "ready";
    if (saveBiz) await saveBiz(biz);
  } else {
    const { default: UserSession } = await import("../models/userSession.js");
    const phone = from.replace(/\D+/g, "");
    await UserSession.updateOne({ phone }, { $unset: { "tempData.instSearchActive": "" } });
  }
}
async function _load(from, biz) {
  if (biz) return biz?.sessionData?.instSearch || {};
  const { default: UserSession } = await import("../models/userSession.js");
  const phone = from.replace(/\D+/g, "");
  const sess = await UserSession.findOne({ phone });
  return sess?.tempData?.instSearch || {};
}

// ─────────────────────────────────────────────────────────────────────────────
// BUTTON ROUTER - pagination / view / contact / refine / show-all
// ─────────────────────────────────────────────────────────────────────────────
export async function handleInstitutionSearchAction({ action: a, from, biz, saveBiz }) {
  if (typeof a !== "string") return false;

  if (a === "inst_refine") {
    return startInstitutionSearch(from, biz, saveBiz);
  }
  if (a === "inst_show_all") {
    const search = { page: 0 };
    await _persist(from, biz, saveBiz, search);
    await _disarm(from, biz, saveBiz);
    return _render(from, search);
  }
  if (a.startsWith("inst_page_")) {
    const search = await _load(from, biz);
    search.page = parseInt(a.replace("inst_page_", ""), 10) || 0;
    await _persist(from, biz, saveBiz, search);
    return _render(from, search);
  }
  if (a.startsWith("inst_view_")) {
    return _showInstitutionDetail(from, a.replace("inst_view_", ""));
  }
  if (a.startsWith("inst_contact_")) {
    return _showInstitutionContact(from, a.replace("inst_contact_", ""));
  }
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// QUERY
// ─────────────────────────────────────────────────────────────────────────────
export async function runInstitutionSearch({ category, city }) {
  const query = { active: true, institutionType: { $ne: "academic" } };
  if (category) query.institutionType = category;
  if (city)     query.city = new RegExp(`^${city}$`, "i");

  return SchoolProfile.find(query)
    .sort({ tier: -1, rating: -1, qualityScore: -1 })
    .limit(60)
    .lean();
}

async function _render(from, search) {
  let list = await runInstitutionSearch(search);

  let note = "";
  if (!list.length && search.city) {
    list = await runInstitutionSearch({ category: search.category });
    if (list.length) note = `No match in that city - showing ${search.category ? institutionLabel(search.category) : "colleges"} anywhere:`;
  }
  if (!list.length && search.category) {
    list = await runInstitutionSearch({ city: search.city });
    if (list.length) note = "Showing all colleges & training in that city:";
  }
  if (!list.length) {
    list = await runInstitutionSearch({});
    if (list.length) note = "No exact match - here are colleges on ZimQuote:";
  }

  if (!list.length) {
    await sendText(from,
`🎓 *No colleges listed yet*

We don't have a matching college or academy on ZimQuote yet.

📣 Know one? Tell them to list on ZimQuote so students can find them here.`
    );
    return sendButtons(from, {
      text: "What next?",
      buttons: [
        { id: "inst_refine",    title: "🔄 Search Again" },
        { id: "main_menu_back", title: "🏠 Main Menu" }
      ]
    });
  }

  const total = list.length;
  const page  = search.page || 0;
  const slice = list.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);

  const rows = slice.map(s => {
    const cat  = institutionLabel(s.institutionType);
    const cheapest = (s.courses || []).map(c => Number(c.fee) || 0).filter(n => n > 0);
    const feeText = cheapest.length ? `from $${Math.min(...cheapest)}` : feeRangeLabel(s.feeRange);
    const badge = s.tier === "featured" ? " 🔥" : (s.verified ? " ✅" : "");
    return {
      id:          `inst_view_${s._id}`,
      title:       `🎓 ${s.schoolName}${badge}`,
      description: `${cat} · ${s.suburb ? s.suburb + ", " : ""}${s.city} · ${feeText}`
    };
  });

  const nav = [];
  if (page > 0) nav.push({ id: `inst_page_${page - 1}`, title: "⬅ Previous" });
  if ((page + 1) * PAGE_SIZE < total) nav.push({ id: `inst_page_${page + 1}`, title: "➡ Next" });
  nav.push({ id: "inst_refine", title: "🔄 New Search" });

  const header = note
    ? `\u26a0\ufe0f ${note}\n\n_Tap one to see courses & fees_`
    : `🎓 *Colleges found: ${total}*\n\n_Tap one to see courses & fees_`;

  return sendList(from, header, [...rows, ...nav]);
}

// ─────────────────────────────────────────────────────────────────────────────
// DETAIL + CONTACT
// ─────────────────────────────────────────────────────────────────────────────
async function _showInstitutionDetail(from, id) {
  const s = await SchoolProfile.findById(id).lean();
  if (!s) {
    return sendButtons(from, {
      text: "❌ Not found. Try another search.",
      buttons: [{ id: "inst_refine", title: "🔄 Search Again" }]
    });
  }

  SchoolProfile.findByIdAndUpdate(id, { $inc: { monthlyViews: 1 } }).catch(() => {});
  try {
    const { notifyAllSchoolProfileView } = await import("./schoolNotifications.js");
    notifyAllSchoolProfileView(s, from).catch(() => {});
  } catch (_) {}

  const cat = institutionLabel(s.institutionType);
  const courseLines = (s.courses || []).length
    ? (s.courses || []).map(c => {
        const fee = c.fee > 0 ? `$${c.fee}${c.per && c.per !== "course" ? "/" + c.per : ""}` : "fee on request";
        const dur = c.duration ? ` · ${c.duration}` : "";
        return `• *${c.name}* - ${fee}${dur}`;
      }).join("\n")
    : "_Courses on request - contact them below._";

  const detail =
`🎓 *${s.schoolName}*${s.verified ? " ✅" : ""}
🏷 ${cat}
📍 ${s.suburb ? s.suburb + ", " : ""}${s.city}${s.address ? "\n🏠 " + s.address : ""}
${s.accreditation ? "\n🏅 " + s.accreditation : ""}${s.intakeInfo ? "\n📅 Intake: " + s.intakeInfo : ""}${s.ageRange ? "\n👤 " + s.ageRange : ""}

📚 *Courses & Fees:*
${courseLines}
${s.website ? "\n🌐 " + s.website : ""}`;

  await sendText(from, detail);

  return sendButtons(from, {
    text: "Interested?",
    buttons: [
      { id: `inst_contact_${id}`, title: "📞 Contact / Enrol" },
      { id: "inst_refine",        title: "🔄 More Colleges" }
    ]
  });
}

async function _showInstitutionContact(from, id) {
  const s = await SchoolProfile.findById(id).lean();
  if (!s) return sendText(from, "❌ Not found.");

  SchoolProfile.findByIdAndUpdate(id, { $inc: { inquiries: 1 } }).catch(() => {});

  const raw = s.contactPhone || s.phone || "";
  const display = raw.startsWith("263") ? "0" + raw.slice(3) : raw;

  return sendButtons(from, {
    text:
`📞 *${s.schoolName}*

WhatsApp / Call: *${display}*
${s.email ? "📧 " + s.email + "\n" : ""}${s.website ? "🌐 " + s.website + "\n" : ""}
_Tell them you found them on ZimQuote._`,
    buttons: [
      { id: "inst_refine",    title: "🔄 More Colleges" },
      { id: "main_menu_back", title: "🏠 Main Menu" }
    ]
  });
}