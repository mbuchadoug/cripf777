// services/institutionSearch.js
// ─── ZimQuote Education - PARENT: Find a College / Training Institution ───────
//
// Specialised institutions (culinary, driving, music, vocational, college, etc.)
// are stored as SchoolProfile with institutionType !== "academic". They use the
// SAME SCHOOL_PLANS pricing, but are searched SEPARATELY from academic schools so
// primary/secondary results are never polluted (schoolSearch.js excludes them).
//
// Funnel (button-driven): category → city → results → view card → contact.
// State persistence mirrors tutorSearch / schoolSearch (biz vs UserSession).
// ─────────────────────────────────────────────────────────────────────────────

import SchoolProfile from "../models/schoolProfile.js";
import { sendText, sendButtons, sendList } from "./metaSender.js";
import {
  INSTITUTION_CATEGORIES, institutionLabel,
  SCHOOL_CITIES, feeRangeLabel
} from "./schoolPlans.js";

const PAGE_SIZE = 6;

// Only the specialised categories are searchable here (academic has its own funnel).
const SPECIALISED = INSTITUTION_CATEGORIES.filter(c => c.specialised);

function _titleCase(s = "") {
  return s.split(/\s+/).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}
function _citySlug(c = "") { return c.toLowerCase().replace(/\s+/g, "_"); }
function _cityFromSlug(slug = "") { return _titleCase(slug.replace(/_/g, " ").trim()); }

async function _loadSearch(from, biz) {
  if (biz) return biz?.sessionData?.instSearch || {};
  const { default: UserSession } = await import("../models/userSession.js");
  const phone = from.replace(/\D+/g, "");
  const sess = await UserSession.findOne({ phone });
  return sess?.tempData?.instSearch || {};
}
async function _saveSearch(from, biz, saveBiz, search) {
  if (biz) {
    biz.sessionData = { ...(biz.sessionData || {}), instSearch: search };
    if (saveBiz) await saveBiz(biz);
    return;
  }
  const { default: UserSession } = await import("../models/userSession.js");
  const phone = from.replace(/\D+/g, "");
  await UserSession.findOneAndUpdate(
    { phone },
    { $set: { "tempData.instSearch": search } },
    { upsert: true }
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ENTRY - parent chose "College / Course" in the Education hub
// ─────────────────────────────────────────────────────────────────────────────
export async function startInstitutionSearch(from, biz, saveBiz) {
  await _saveSearch(from, biz, saveBiz, {});
  return _sendCategoryPicker(from, 0);
}

function _sendCategoryPicker(from, page = 0) {
  const start = page * 8;
  const slice = SPECIALISED.slice(start, start + 8);
  const rows  = slice.map(c => ({ id: `inst_cat_${c.id}`, title: c.label }));
  if (start + 8 < SPECIALISED.length) {
    rows.push({ id: `inst_cat_more_${page + 1}`, title: "➡ More" });
  }
  rows.push({ id: "inst_cat_any", title: "🔍 Any / All Colleges" });
  return sendList(
    from,
`🎓 *Colleges, Academies & Training*

What kind of course or training are you looking for?`,
    rows
  );
}

function _sendCityPicker(from, page = 0) {
  const start = page * 8;
  const slice = SCHOOL_CITIES.slice(start, start + 8);
  const rows  = slice.map(c => ({ id: `inst_city_${_citySlug(c)}`, title: `📍 ${c}` }));
  if (start + 8 < SCHOOL_CITIES.length) {
    rows.push({ id: `inst_city_more_${page + 1}`, title: "➡ More Cities" });
  }
  rows.push({ id: "inst_city_all", title: "🌍 All Cities" });
  return sendList(from, "📍 Which city?", rows);
}

// ─────────────────────────────────────────────────────────────────────────────
// ACTION ROUTER - handles every inst_* button tap. Returns true if handled.
// ─────────────────────────────────────────────────────────────────────────────
export async function handleInstitutionSearchAction({ action: a, from, biz, saveBiz }) {
  if (typeof a !== "string" || !a.startsWith("inst_")) return false;

  const search = await _loadSearch(from, biz);

  if (a.startsWith("inst_cat_more_")) {
    await _sendCategoryPicker(from, parseInt(a.replace("inst_cat_more_", ""), 10) || 0);
    return true;
  }
  if (a.startsWith("inst_cat_")) {
    const raw = a.replace("inst_cat_", "");
    search.category = raw === "any" ? null : raw;
    await _saveSearch(from, biz, saveBiz, search);
    await _sendCityPicker(from, 0);
    return true;
  }

  if (a.startsWith("inst_city_more_")) {
    await _sendCityPicker(from, parseInt(a.replace("inst_city_more_", ""), 10) || 0);
    return true;
  }
  if (a.startsWith("inst_city_")) {
    const raw = a.replace("inst_city_", "");
    search.city = raw === "all" ? null : _cityFromSlug(raw);
    search.page = 0;
    await _saveSearch(from, biz, saveBiz, search);
    return _runAndRender(from, biz, saveBiz, search);
  }

  if (a.startsWith("inst_page_")) {
    search.page = parseInt(a.replace("inst_page_", ""), 10) || 0;
    await _saveSearch(from, biz, saveBiz, search);
    return _runAndRender(from, biz, saveBiz, search);
  }

  if (a.startsWith("inst_view_")) {
    return _showInstitutionDetail(from, a.replace("inst_view_", ""));
  }

  if (a.startsWith("inst_contact_")) {
    return _showInstitutionContact(from, a.replace("inst_contact_", ""));
  }

  if (a === "inst_refine") {
    return startInstitutionSearch(from, biz, saveBiz);
  }

  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// QUERY
// ─────────────────────────────────────────────────────────────────────────────
export async function runInstitutionSearch({ category, city }) {
  const query = { active: true, institutionType: { $ne: "academic" } };
  if (category) query.institutionType = category;   // overrides the $ne with an exact match
  if (city)     query.city = new RegExp(`^${city}$`, "i");

  return SchoolProfile.find(query)
    .sort({ tier: -1, rating: -1, qualityScore: -1 })
    .limit(60)
    .lean();
}

async function _runAndRender(from, biz, saveBiz, search) {
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
// DETAIL CARD
// ─────────────────────────────────────────────────────────────────────────────
async function _showInstitutionDetail(from, id) {
  const s = await SchoolProfile.findById(id).lean();
  if (!s) {
    return sendButtons(from, {
      text: "❌ Not found. Try another search.",
      buttons: [{ id: "inst_refine", title: "🔄 Search Again" }]
    });
  }

  // Track view + notify the institution a parent is interested (reuses school view notify).
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