// services/schoolSearch.js
// ─── ZimQuote Schools — Parent Search Engine ──────────────────────────────────

import SchoolProfile from "../models/schoolProfile.js";
import { sendText, sendList, sendButtons } from "./metaSender.js";
import {
  SCHOOL_CITIES, SCHOOL_SUBURB_TO_CITY, SCHOOL_FACILITIES,
  SCHOOL_TYPES, SCHOOL_FEE_RANGES, SCHOOL_CURRICULA,
  SCHOOL_GENDERS, SCHOOL_BOARDING, feeRangeLabel, facilityIcon
} from "./schoolPlans.js";




const SCHOOL_TYPE_ALIASES = {
  primary: "primary",
  secondary: "secondary",
  combined: "combined",
  preschool: "primary",
  kindergarten: "primary",
  ecd: "primary",
  highschool: "secondary",
  "high school": "secondary"
};

const SCHOOL_FEE_ALIASES = {
  budget: "budget",
  cheap: "budget",
  affordable: "budget",
  low: "budget",
  mid: "mid",
  middle: "mid",
  medium: "mid",
  average: "mid",
  premium: "premium",
  elite: "premium",
  expensive: "premium"
};

const SCHOOL_GENDER_ALIASES = {
  boys: "boys",
  girls: "girls",
  mixed: "mixed",
  coed: "mixed",
  "co-ed": "mixed"
};

const SCHOOL_BOARDING_ALIASES = {
  day: "day",
  boarding: "boarding",
  boarder: "boarding",
  both: "both"
};

function _normSchoolText(value = "") {
  return String(value || "")
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, " ")
    .replace(/\s+/g, " ");
}

function _includesWholePhrase(haystack = "", phrase = "") {
  const h = ` ${_normSchoolText(haystack)} `;
  const p = ` ${_normSchoolText(phrase)} `;
  return h.includes(p);
}

function _findSchoolCity(text = "") {
  const normalized = _normSchoolText(text);
  const cities = [...SCHOOL_CITIES].sort((a, b) => b.length - a.length);
  for (const city of cities) {
    if (_includesWholePhrase(normalized, city)) return city;
  }
  return null;
}

function _findSchoolSuburb(text = "") {
  const normalized = _normSchoolText(text);
  const suburbs = Object.keys(SCHOOL_SUBURB_TO_CITY || {}).sort((a, b) => b.length - a.length);
  for (const suburb of suburbs) {
    if (_includesWholePhrase(normalized, suburb)) {
      return {
        suburb: _titleCase(suburb),
        city: SCHOOL_SUBURB_TO_CITY[suburb] || null
      };
    }
  }
  return null;
}

function _findSchoolFacility(text = "") {
  const normalized = _normSchoolText(text);

  for (const fac of SCHOOL_FACILITIES) {
    if (_includesWholePhrase(normalized, fac.id)) return fac.id;
    if (_includesWholePhrase(normalized, fac.label)) return fac.id;

    const shortLabel = _normSchoolText(fac.label).replace(/^.*?\s/, "");
    if (shortLabel && _includesWholePhrase(normalized, shortLabel)) return fac.id;
  }

  if (_includesWholePhrase(normalized, "pool")) return "swimming_pool";
  if (_includesWholePhrase(normalized, "lab")) return "science_lab";
  if (_includesWholePhrase(normalized, "computer")) return "computer_lab";
  if (_includesWholePhrase(normalized, "wifi")) return "wifi";
  if (_includesWholePhrase(normalized, "bus")) return "school_bus";
  if (_includesWholePhrase(normalized, "boarding")) return null;

  return null;
}

function _findSchoolCurriculum(text = "") {
  const normalized = _normSchoolText(text);

  for (const cur of SCHOOL_CURRICULA) {
    if (_includesWholePhrase(normalized, cur.id)) return cur.id;
    if (_includesWholePhrase(normalized, cur.label)) return cur.id;
  }

  if (_includesWholePhrase(normalized, "cambridge")) return "cambridge";
  if (_includesWholePhrase(normalized, "zimsec")) return "zimsec";

  return null;
}

// schoolSearch.js — replace the entire _parseSchoolShortcodeSearch function

const SCHOOL_PARSE_TRIGGERS = [
  "find school", "find schools", "find a school",
  "find primary", "find secondary", "find combined",
  "find preschool", "find ecd", "find kindergarten",
  "find boarding", "find day school",
  "find girls school", "find boys school", "find mixed school",
  "find budget school", "find affordable school", "find cheap school", "find premium school",
  "find cambridge", "find zimsec",
  "school in", "schools in", "primary school in", "secondary school in",
  "look for school", "search school"
];

function _parseSchoolShortcodeSearch(text = "") {
  const raw = String(text || "").trim();
  const normalized = _normSchoolText(raw);

  // Accept if it starts with any known trigger phrase OR contains "school" + location hint
  const isSchoolTrigger =
    SCHOOL_PARSE_TRIGGERS.some(p => normalized.startsWith(p) || normalized.includes(p)) ||
    (normalized.includes("school") && (
      _findSchoolCity(normalized) ||
      _findSchoolSuburb(normalized) ||
      Object.keys(SCHOOL_TYPE_ALIASES).some(k => _includesWholePhrase(normalized, k))
    ));

  if (!isSchoolTrigger) return null;

  const search = {
    city: null,
    suburb: null,
    type: null,
    feeRange: null,
    facility: null,
    curriculum: null,
    gender: null,
    boarding: null,
    keyword: null,
    admissionsOpen: null,
    page: 0
  };

  // Suburb first (more specific)
  const suburbMatch = _findSchoolSuburb(normalized);
  if (suburbMatch) {
    search.suburb = suburbMatch.suburb;
    if (suburbMatch.city) search.city = suburbMatch.city;
  }

  // City
  const cityMatch = _findSchoolCity(normalized);
  if (cityMatch && !search.city) search.city = cityMatch;

  // Type
  for (const [word, value] of Object.entries(SCHOOL_TYPE_ALIASES)) {
    if (_includesWholePhrase(normalized, word)) { search.type = value; break; }
  }

  // Fee range
  for (const [word, value] of Object.entries(SCHOOL_FEE_ALIASES)) {
    if (_includesWholePhrase(normalized, word)) { search.feeRange = value; break; }
  }

  // Facility
  search.facility = _findSchoolFacility(normalized);

  // Curriculum
  search.curriculum = _findSchoolCurriculum(normalized);

  // Gender
  for (const [word, value] of Object.entries(SCHOOL_GENDER_ALIASES)) {
    if (_includesWholePhrase(normalized, word)) { search.gender = value; break; }
  }

  // Boarding
  for (const [word, value] of Object.entries(SCHOOL_BOARDING_ALIASES)) {
    if (_includesWholePhrase(normalized, word)) { search.boarding = value; break; }
  }

  // Grade/level
  if (_includesWholePhrase(normalized, "grade 1") || _includesWholePhrase(normalized, "form 1")) search.type = "primary";
  if (_includesWholePhrase(normalized, "o level") || _includesWholePhrase(normalized, "a level")) search.type = "secondary";

  // Admissions
  if (_includesWholePhrase(normalized, "admissions open") || _includesWholePhrase(normalized, "open admissions") || _includesWholePhrase(normalized, "accepting")) {
    search.admissionsOpen = true;
  } else if (_includesWholePhrase(normalized, "admissions closed") || _includesWholePhrase(normalized, "closed admissions")) {
    search.admissionsOpen = false;
  }

  const hasFilters = Boolean(
    search.city || search.suburb || search.type || search.feeRange ||
    search.facility || search.curriculum || search.gender || search.boarding ||
    typeof search.admissionsOpen === "boolean"
  );

  return { search, hasFilters };
}

export async function runSchoolShortcodeSearch({ from, text, biz, saveBiz }) {
  const parsed = _parseSchoolShortcodeSearch(text);
  if (!parsed) return false;

  if (!parsed.hasFilters) {
    return startSchoolSearch(from, biz, saveBiz);
  }

  if (biz) {
    biz.sessionState = "school_search_results";
    biz.sessionData = {
      ...(biz.sessionData || {}),
      schoolSearch: parsed.search
    };
    await saveBiz(biz);
  }

  return _runSchoolSearch(from, parsed.search);
}
// ─────────────────────────────────────────────────────────────────────────────
// ENTRY POINT — called when parent taps "🏫 Find a School"
// ─────────────────────────────────────────────────────────────────────────────
export async function startSchoolSearch(from, biz, saveBiz) {
  if (biz) {
    biz.sessionState = "school_search_city";
    biz.sessionData  = { ...(biz.sessionData || {}), schoolSearch: {} };
    await saveBiz(biz);
  }

 // WhatsApp limit: 10 rows. Show first 8 cities + More + All Cities.
  const searchCityRows = SCHOOL_CITIES.slice(0, 8).map(c => ({
    id:    `school_search_city_${c.toLowerCase().replace(/\s+/g, "_")}`,
    title: `📍 ${c}`
  }));
  searchCityRows.push({ id: "school_search_city_more", title: "➡ More Cities" });
  searchCityRows.push({ id: "school_search_city_all",  title: "🌍 All Cities" });

 return sendList(
    from,
    `🏫 *Find a School in Zimbabwe*

Which city? Or type a shortcut:

_find primary borrowdale_
_find secondary glen view_
_find boarding school bulawayo_
_find cambridge girls harare_
_find budget primary kuwadzana_
_find school with pool highlands_
_find schools admissions open_`,
    searchCityRows
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ACTION ROUTER — handles all school_search_* button taps
// Returns true if handled, false to fall through.
// ─────────────────────────────────────────────────────────────────────────────
export async function handleSchoolSearchActions({ action: a, from, biz, saveBiz }) {
  const search = biz?.sessionData?.schoolSearch || {};
// ── More cities page 2 ────────────────────────────────────────────────────
  if (a === "school_search_city_more") {
    const moreCityRows = SCHOOL_CITIES.slice(8).map(c => ({
      id:    `school_search_city_${c.toLowerCase().replace(/\s+/g, "_")}`,
      title: `📍 ${c}`
    }));
    moreCityRows.push({ id: "school_search_city_all", title: "🌍 All Cities" });
    return sendList(from, "🏫 *More Cities* — which city?", moreCityRows);
  }
  // ── Step 1: City selected ─────────────────────────────────────────────────
  if (a.startsWith("school_search_city_")) {
    const cityRaw = a.replace("school_search_city_", "").replace(/_/g, " ");
    const city    = cityRaw === "all" ? null : _titleCase(cityRaw);

    search.city   = city;
    if (biz) {
      biz.sessionData = { ...(biz.sessionData || {}), schoolSearch: search };
      await saveBiz(biz);
    }

    return sendList(from,
      `🏫 *${city || "All Cities"}* — What type of school?`,
      [
        ...SCHOOL_TYPES.map(t => ({ id: `school_search_type_${t.id}`, title: t.label })),
        { id: "school_search_type_any", title: "🔍 Any Type" }
      ]
    );
  }

  // ── Step 2: School type selected ──────────────────────────────────────────
  if (a.startsWith("school_search_type_")) {
    const typeId  = a.replace("school_search_type_", "");
    search.type   = typeId === "any" ? null : typeId;
    if (biz) {
      biz.sessionData = { ...(biz.sessionData || {}), schoolSearch: search };
      await saveBiz(biz);
    }

    return sendList(from,
      "💵 *Fees range per term?*",
      [
        ...SCHOOL_FEE_RANGES.map(f => ({ id: `school_search_fees_${f.id}`, title: f.label })),
        { id: "school_search_fees_any", title: "💰 Any Budget" }
      ]
    );
  }

  // ── Step 3: Fee range selected ────────────────────────────────────────────
  if (a.startsWith("school_search_fees_")) {
    const feeId       = a.replace("school_search_fees_", "");
    search.feeRange   = feeId === "any" ? null : feeId;
    if (biz) {
      biz.sessionData = { ...(biz.sessionData || {}), schoolSearch: search };
      await saveBiz(biz);
    }

    // Build facility filter list (top 10 most common)
 // WhatsApp limit: 10 rows. Cap at 9 facilities + No Filter.
    const topFacilities = SCHOOL_FACILITIES.slice(0, 9);
    return sendList(from,
      "🏊 *Filter by facility?* (optional)\n\nPick one must-have facility, or skip:",
      [
        ...topFacilities.map(f => ({ id: `school_search_fac_${f.id}`, title: f.label })),
        { id: "school_search_fac_any", title: "🔍 No Facility Filter" }
      ]
    );
  }

  // ── Step 4: Facility filter ───────────────────────────────────────────────
  if (a.startsWith("school_search_fac_")) {
    const facId       = a.replace("school_search_fac_", "");
    search.facility   = facId === "any" ? null : facId;
    if (biz) {
      biz.sessionData = { ...(biz.sessionData || {}), schoolSearch: search };
      biz.sessionState = "school_search_results";
      await saveBiz(biz);
    }
    return _runSchoolSearch(from, search);
  }

  // ── Result: parent taps a school card ─────────────────────────────────────
  if (a.startsWith("school_view_")) {
    const schoolId = a.replace("school_view_", "");
    return _showSchoolDetail(from, schoolId, biz);
  }

  // ── Download school profile PDF ───────────────────────────────────────────
  if (a.startsWith("school_dl_profile_")) {
    const schoolId = a.replace("school_dl_profile_", "");
    return _downloadSchoolProfile(from, schoolId);
  }

  // ── Get application link ──────────────────────────────────────────────────
  if (a.startsWith("school_apply_")) {
    const schoolId = a.replace("school_apply_", "");
    return _sendApplicationLink(from, schoolId);
  }

  // ── Contact school ────────────────────────────────────────────────────────
  if (a.startsWith("school_contact_")) {
    const schoolId = a.replace("school_contact_", "");
    return _contactSchool(from, schoolId);
  }

  // ── Refine search ─────────────────────────────────────────────────────────
  if (a === "school_search_refine") {
    return startSchoolSearch(from, biz, saveBiz);
  }

  // ── Pagination ────────────────────────────────────────────────────────────
  if (a.startsWith("school_search_page_")) {
    const page = parseInt(a.replace("school_search_page_", ""), 10) || 0;
    search.page = page;
    if (biz) {
      biz.sessionData = { ...(biz.sessionData || {}), schoolSearch: search };
      await saveBiz(biz);
    }
    return _runSchoolSearch(from, search);
  }

  // ── Toggle admissions (school admin) ─────────────────────────────────────
  if (a === "school_toggle_admissions") {
    const phone  = from.replace(/\D+/g, "");
    const school = await SchoolProfile.findOne({ phone });
    if (!school) return false;
    school.admissionsOpen = !school.admissionsOpen;
    await school.save();
    await sendText(from,
      school.admissionsOpen
        ? "🟢 Admissions are now *OPEN*. Parents searching will see this."
        : "🔴 Admissions are now *CLOSED*. We will hide the 'Admissions Open' badge."
    );
    const { sendSchoolAccountMenu } = await import("./metaMenus.js");
    return sendSchoolAccountMenu(from, school);
  }

  // ── Update fees (school admin) ────────────────────────────────────────────
  if (a === "school_update_fees") {
    if (biz) {
      biz.sessionState = "school_admin_update_fees";
      await saveBiz(biz);
    }
    return sendText(from,
`💵 *Update School Fees*

Enter the new fee per term as: *term1, term2, term3*
Example: *900, 900, 850*

Or one number for equal terms: *900*`
    );
  }

  return false;
}

// ── School admin: update fees state handler ───────────────────────────────────
export async function handleSchoolAdminStates({ state, from, text, biz, saveBiz }) {
  if (state === "school_admin_update_fees") {
    const phone  = from.replace(/\D+/g, "");
    const school = await SchoolProfile.findOne({ phone });
    if (!school) return false;

    const parts = text.trim().split(/[,\s\/]+/).map(s => Number(s.replace(/[^\d.]/g, ""))).filter(n => !isNaN(n) && n >= 0);
    if (!parts.length) {
      await sendText(from, "❌ Invalid fees. Try again: *800, 800, 750*");
      return true;
    }

    school.fees = {
      term1: parts[0],
      term2: parts[1] !== undefined ? parts[1] : parts[0],
      term3: parts[2] !== undefined ? parts[2] : parts[0],
      currency: "USD"
    };
    await school.save(); // pre-save hook updates feeRange

    if (biz) { biz.sessionState = "ready"; await saveBiz(biz); }

    await sendText(from,
      `✅ Fees updated:\nTerm 1: $${school.fees.term1} | Term 2: $${school.fees.term2} | Term 3: $${school.fees.term3}`
    );
    const { sendSchoolAccountMenu } = await import("./metaMenus.js");
    return sendSchoolAccountMenu(from, school);
  }

  if (state === "school_admin_update_reg_link") {
    const phone  = from.replace(/\D+/g, "");
    const school = await SchoolProfile.findOne({ phone });
    if (!school) return false;
    const link = text.trim();
    if (!link.startsWith("http")) {
      await sendText(from, "❌ Please enter a valid link starting with https://\n\nExample: *https://forms.gle/abc123*");
      return true;
    }
    school.registrationLink = link;
    await school.save();
    if (biz) { biz.sessionState = "ready"; await saveBiz(biz); }
    await sendText(from, `✅ *Application link updated!*\n\nParents will now see:\n${link}`);
    const { sendSchoolAccountMenu } = await import("./metaMenus.js");
    return sendSchoolAccountMenu(from, school);
  }

  if (state === "school_admin_update_email") {
    const phone  = from.replace(/\D+/g, "");
    const school = await SchoolProfile.findOne({ phone });
    if (!school) return false;
    school.email = text.trim();
    await school.save();
    if (biz) { biz.sessionState = "ready"; await saveBiz(biz); }
    await sendText(from, `✅ *Email updated to:* ${school.email}`);
    const { sendSchoolAccountMenu } = await import("./metaMenus.js");
    return sendSchoolAccountMenu(from, school);
  }

  if (state === "school_admin_update_website") {
    const phone  = from.replace(/\D+/g, "");
    const school = await SchoolProfile.findOne({ phone });
    if (!school) return false;
    school.website = text.trim();
    await school.save();
    if (biz) { biz.sessionState = "ready"; await saveBiz(biz); }
    await sendText(from, `✅ *Website updated to:* ${school.website}`);
    const { sendSchoolAccountMenu } = await import("./metaMenus.js");
    return sendSchoolAccountMenu(from, school);
  }

  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// PRIVATE: run the MongoDB query and format results
// ─────────────────────────────────────────────────────────────────────────────
async function _runSchoolSearch(from, search = {}) {
  const PAGE_SIZE = 5;
  const page      = search.page || 0;
  const skip      = page * PAGE_SIZE;

const query = { active: true };
if (search.city)            query.city            = new RegExp(`^${search.city}$`, "i");
if (search.suburb)          query.suburb          = new RegExp(search.suburb, "i");
if (search.type)            query.type            = search.type;
if (search.feeRange)        query.feeRange        = search.feeRange;
if (search.facility)        query.facilities      = search.facility;
if (search.curriculum)      query.curriculum      = search.curriculum;
if (search.gender)          query.gender          = search.gender;
if (search.boarding)        query.boarding        = search.boarding;
if (typeof search.admissionsOpen === "boolean") {
  query.admissionsOpen = search.admissionsOpen;
}

  const total   = await SchoolProfile.countDocuments(query);
  const schools = await SchoolProfile.find(query)
    .sort({ tier: -1, rating: -1, qualityScore: -1 })  // featured first, then by rating
    .skip(skip)
    .limit(PAGE_SIZE)
    .lean();

  if (!schools.length) {
    const filterSummary = _buildFilterSummary(search);
    await sendText(from,
`🏫 *No schools found*

Filters: ${filterSummary}

Try broadening your search — remove the facility filter or select "Any Type".`
    );
    return sendButtons(from, {
      text: "What would you like to do?",
      buttons: [
        { id: "school_search_refine", title: "🔄 Search Again" },
        { id: "main_menu_back",       title: "🏠 Main Menu" }
      ]
    });
  }

  // ── Build result cards ────────────────────────────────────────────────────
  const rows = schools.map(s => {
    const verifiedBadge  = s.verified ? " ✅" : "";
    const featuredBadge  = s.tier === "featured" ? " 🔥" : "";
    const admissions     = s.admissionsOpen ? "🟢 Open" : "🔴 Closed";
    const topFacilities  = (s.facilities || []).slice(0, 4).map(facilityIcon).join(" ");
    const feeText        = s.fees?.term1 ? `$${s.fees.term1}/term` : feeRangeLabel(s.feeRange);

    return {
      id:          `school_view_${s._id}`,
      title:       `🏫 ${s.schoolName}${verifiedBadge}${featuredBadge}`,
      description: `${s.suburb ? s.suburb + ", " : ""}${s.city} · ${feeText} · ${admissions}`
    };
  });

  // Pagination rows
  const paginationRows = [];
  if (page > 0) {
    paginationRows.push({ id: `school_search_page_${page - 1}`, title: "⬅ Previous" });
  }
  if (skip + PAGE_SIZE < total) {
    paginationRows.push({ id: `school_search_page_${page + 1}`, title: "➡ Next" });
  }
  paginationRows.push({ id: "school_search_refine", title: "🔄 New Search" });

  const filterSummary = _buildFilterSummary(search);

  return sendList(from,
    `🏫 *Schools Found: ${total}*\n📍 ${filterSummary}\n\n_Tap a school to see details_`,
    [...rows, ...paginationRows]
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// PRIVATE: full school detail card
// ─────────────────────────────────────────────────────────────────────────────
async function _showSchoolDetail(from, schoolId, biz) {
  const school = await SchoolProfile.findById(schoolId).lean();
  if (!school) {
    await sendText(from, "❌ School not found.");
    return sendButtons(from, {
      text: "What would you like to do?",
      buttons: [{ id: "school_search_refine", title: "🔄 Search Again" }]
    });
  }

  // Track views
  await SchoolProfile.findByIdAndUpdate(schoolId, { $inc: { monthlyViews: 1 } });

  const verifiedBadge  = school.verified  ? " ✅ *Verified*"   : "";
  const featuredBadge  = school.tier === "featured" ? " 🔥 *Featured*" : "";
  const admissions     = school.admissionsOpen ? "🟢 *Admissions Open*" : "🔴 *Admissions Closed*";

  const typeLabels     = { primary: "Primary", secondary: "Secondary", combined: "Combined" };
  const genderLabels   = { mixed: "Mixed (Co-ed)", boys: "Boys Only", girls: "Girls Only" };
  const boardLabels    = { day: "Day School", boarding: "Boarding", both: "Day & Boarding" };

  const curriculumText = (school.curriculum || []).map(c => c.toUpperCase()).join(" + ") || "Not specified";
  const facilitiesList = (school.facilities || [])
    .map(id => SCHOOL_FACILITIES.find(f => f.id === id)?.label || id)
    .join("\n  ") || "Not specified";
  const extraList      = (school.extramuralActivities || [])
    .slice(0, 8)
    .map(id => SCHOOL_EXTRAMURALACTIVITIES_MAP[id] || id)
    .join(", ") || "Not specified";

  const feeLine        = school.fees?.term1
    ? `Term 1: $${school.fees.term1} | Term 2: $${school.fees.term2} | Term 3: $${school.fees.term3} (USD)`
    : feeRangeLabel(school.feeRange);

  const rating         = school.reviewCount > 0
    ? `⭐ ${school.rating.toFixed(1)} (${school.reviewCount} reviews)`
    : "⭐ No reviews yet";

  const gradeText      = (school.grades?.from && school.grades?.to)
    ? `${school.grades.from} – ${school.grades.to}`
    : "Not specified";

  const detailText =
`🏫 *${school.schoolName}*${verifiedBadge}${featuredBadge}
📍 ${school.suburb ? school.suburb + ", " : ""}${school.city}${school.address ? "\n🏠 " + school.address : ""}

${admissions}

📗 *Type:* ${typeLabels[school.type] || school.type}
📚 *Curriculum:* ${curriculumText}
👫 *Gender:* ${genderLabels[school.gender] || school.gender}
🏠 *Boarding:* ${boardLabels[school.boarding] || school.boarding}
📐 *Grades:* ${gradeText}

💵 *Fees:*
  ${feeLine}

🏊 *Facilities:*
  ${facilitiesList}

🏃 *Extramural:* ${extraList}

${school.principalName ? `👤 *Principal:* ${school.principalName}\n` : ""}${school.email ? `📧 ${school.email}\n` : ""}
${rating}
👀 ${school.monthlyViews || 0} views this month`;

  return sendButtons(from, {
    text: detailText,
    buttons: [
      { id: `school_dl_profile_${schoolId}`,  title: "📄 Download Profile" },
      { id: `school_apply_${schoolId}`,        title: "📝 Apply Online" },
      { id: `school_contact_${schoolId}`,      title: "📞 Contact School" }
    ]
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// PRIVATE: download school profile PDF
// ─────────────────────────────────────────────────────────────────────────────
async function _downloadSchoolProfile(from, schoolId) {
  const school = await SchoolProfile.findById(schoolId).lean();
  if (!school) { await sendText(from, "❌ School not found."); return; }

  // Track inquiry
  await SchoolProfile.findByIdAndUpdate(schoolId, { $inc: { inquiries: 1 } });

  if (school.profilePdfUrl) {
    const { sendDocument } = await import("./metaSender.js");
    const filename = `${school.schoolName.replace(/\s+/g, "_")}_Profile.pdf`;
    await sendDocument(from, { link: school.profilePdfUrl, filename });
    return sendButtons(from, {
      text: `📄 *${school.schoolName} — School Profile*\n\nDownloading now... If it doesn't open, tap the link above.`,
      buttons: [
        { id: `school_apply_${schoolId}`,   title: "📝 Apply Online" },
        { id: "school_search_refine",        title: "🔄 More Schools" }
      ]
    });
  }

  // PDF not yet generated — generate on demand
  try {
    const { generateSchoolProfilePDF } = await import("./schoolPdfGenerator.js");
    const pdfResult = await generateSchoolProfilePDF(school);
    if (pdfResult?.url) {
      await SchoolProfile.findByIdAndUpdate(schoolId, { profilePdfUrl: pdfResult.url });
      const { sendDocument } = await import("./metaSender.js");
      await sendDocument(from, { link: pdfResult.url, filename: pdfResult.filename });
      return sendButtons(from, {
        text: `📄 Here is the *${school.schoolName}* school profile.`,
        buttons: [
          { id: `school_apply_${schoolId}`, title: "📝 Apply Online" },
          { id: "school_search_refine",      title: "🔄 More Schools" }
        ]
      });
    }
  } catch (err) {
    console.error("[School Profile PDF]", err.message);
  }

  return sendButtons(from, {
    text: `⚠️ The school profile PDF for *${school.schoolName}* is not yet available. Please contact the school directly.`,
    buttons: [
      { id: `school_contact_${schoolId}`, title: "📞 Contact School" },
      { id: "school_search_refine",        title: "🔄 More Schools" }
    ]
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// PRIVATE: send online application link
// ─────────────────────────────────────────────────────────────────────────────
async function _sendApplicationLink(from, schoolId) {
  const school = await SchoolProfile.findById(schoolId).lean();
  if (!school) { await sendText(from, "❌ School not found."); return; }

  await SchoolProfile.findByIdAndUpdate(schoolId, { $inc: { inquiries: 1 } });

  const admissionsText = school.admissionsOpen
    ? "🟢 *Admissions are currently OPEN.*"
    : "🔴 *Admissions are currently CLOSED.* You can still submit an expression of interest.";

  // Notify the school that a parent wants to apply
  try {
    const { sendText: notify } = await import("./metaSender.js");
    await notify(school.phone,
`📝 *New Application Interest!*

A parent is interested in applying to *${school.schoolName}*.

They have been given your application link. Please be ready to follow up.

📞 Parent number: ${from}`
    );
  } catch (e) { /* non-critical */ }

  if (school.registrationLink) {
    return sendButtons(from, {
      text:
`📝 *Apply to ${school.schoolName}*

${admissionsText}

Tap the link below to fill in your child's application form online:
${school.registrationLink}

After submitting, the school will contact you directly.`,
      buttons: [
        { id: `school_dl_profile_${schoolId}`, title: "📄 Download Profile" },
        { id: "school_search_refine",           title: "🔄 More Schools" }
      ]
    });
  }

  // No online link — fall back to contact
  return sendButtons(from, {
    text:
`📝 *Apply to ${school.schoolName}*

${admissionsText}

This school does not have an online application form yet.
Contact them directly to request an application form.`,
    buttons: [
      { id: `school_contact_${schoolId}`, title: "📞 Contact School" },
      { id: "school_search_refine",        title: "🔄 More Schools" }
    ]
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// PRIVATE: show school contact details
// ─────────────────────────────────────────────────────────────────────────────
async function _contactSchool(from, schoolId) {
  const school = await SchoolProfile.findById(schoolId).lean();
  if (!school) { await sendText(from, "❌ School not found."); return; }

  await SchoolProfile.findByIdAndUpdate(schoolId, { $inc: { inquiries: 1 } });

  const contactText =
`📞 *Contact ${school.schoolName}*

📱 WhatsApp/Phone: *${school.phone}*
${school.email    ? `📧 Email: ${school.email}\n`   : ""}${school.address  ? `🏠 Address: ${school.address}\n` : ""}${school.website  ? `🌐 Website: ${school.website}\n` : ""}
📍 ${school.suburb ? school.suburb + ", " : ""}${school.city}

You can message or call the school directly on their number above.`;

  // Notify school of interest
  try {
    const { sendText: notify } = await import("./metaSender.js");
    await notify(school.phone,
`📞 *Parent Inquiry!*

A parent is trying to contact *${school.schoolName}* via ZimQuote.

Parent number: ${from}

Please reach out to them.`
    );
  } catch (e) { /* non-critical */ }

  return sendButtons(from, {
    text: contactText,
    buttons: [
      { id: `school_apply_${schoolId}`, title: "📝 Apply Online" },
      { id: "school_search_refine",      title: "🔄 More Schools" }
    ]
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// PRIVATE: helpers
// ─────────────────────────────────────────────────────────────────────────────
function _buildFilterSummary(search = {}) {
  const parts = [];
  if (search.city)     parts.push(search.city);
  if (search.suburb)   parts.push(search.suburb);
  if (search.type)     parts.push({ primary: "Primary", secondary: "Secondary", combined: "Combined" }[search.type] || search.type);
  if (search.feeRange) parts.push(feeRangeLabel(search.feeRange));

  if (search.facility) {
    const fac = SCHOOL_FACILITIES.find(f => f.id === search.facility);
    if (fac) parts.push(fac.label);
  }

  if (search.curriculum) {
    const cur = SCHOOL_CURRICULA.find(c => c.id === search.curriculum);
    if (cur) parts.push(cur.label);
  }

  if (search.gender) {
    const g = SCHOOL_GENDERS.find(x => x.id === search.gender);
    if (g) parts.push(g.label);
  }

  if (search.boarding) {
    const b = SCHOOL_BOARDING.find(x => x.id === search.boarding);
    if (b) parts.push(b.label);
  }

  if (typeof search.admissionsOpen === "boolean") {
    parts.push(search.admissionsOpen ? "Admissions Open" : "Admissions Closed");
  }

  return parts.length ? parts.join(" · ") : "All Schools";
}

function _titleCase(str = "") {
  return str.split(" ").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

// Flat lookup map for extramural labels
const SCHOOL_EXTRAMURALACTIVITIES_MAP = {
  football: "⚽ Football", netball: "🏐 Netball", cricket: "🏏 Cricket",
  athletics: "🏃 Athletics", swimming: "🏊 Swimming", tennis: "🎾 Tennis",
  basketball: "🏀 Basketball", volleyball: "🏐 Volleyball", chess: "♟️ Chess",
  debating: "🎤 Debating", music: "🎵 Music", drama: "🎭 Drama",
  dance: "💃 Dance", art: "🎨 Art", scouts: "⚜️ Scouts",
  environmental: "🌿 Env. Club", coding: "💻 Coding Club", science_club: "🔬 Science Club"
};