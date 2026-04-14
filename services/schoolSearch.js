// services/schoolSearch.js
// ─── ZimQuote Schools - Parent Search Engine ──────────────────────────────────

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
  preschool: "ecd",
  kindergarten: "ecd",
  ecd: "ecd",
  "ecd only": "ecd",
  "ecd primary": "ecd_primary",
  preparatory: "ecd_primary",
  prep: "ecd_primary",
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

  // Check cambridge_primary first (more specific) before cambridge
  if (_includesWholePhrase(normalized, "cambridge primary") ||
      _includesWholePhrase(normalized, "cambridge checkpoint") ||
      _includesWholePhrase(normalized, "cambridge_primary")) {
    return "cambridge_primary";
  }

  for (const cur of SCHOOL_CURRICULA) {
    if (_includesWholePhrase(normalized, cur.id)) return cur.id;
    if (_includesWholePhrase(normalized, cur.label)) return cur.id;
  }

  if (_includesWholePhrase(normalized, "cambridge")) return "cambridge";
  if (_includesWholePhrase(normalized, "zimsec")) return "zimsec";

  return null;
}

// schoolSearch.js - replace the entire _parseSchoolShortcodeSearch function

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
// ENTRY POINT - called when parent taps "🏫 Find a School"
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
// ACTION ROUTER - handles all school_search_* button taps
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
    return sendList(from, "🏫 *More Cities* - which city?", moreCityRows);
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
      `🏫 *${city || "All Cities"}* - What type of school?`,
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

  // ── School admin: open facilities manager ────────────────────────────────
  if (a === "school_admin_manage_facilities" || biz?.sessionState === "school_admin_manage_facilities") {
    const phone = from.replace(/\D+/g, "");
    const school = await SchoolProfile.findOne({ phone });
    if (!school) return false;

    if (biz) {
      biz.sessionState = "school_admin_manage_facilities";
      biz.sessionData = { ...(biz.sessionData || {}), schoolFacPage: 0 };
      await saveBiz(biz);
    }

    const { SCHOOL_FACILITIES } = await import("./schoolPlans.js");
    const FAC_PAGE_SIZE = 7;

    const selected = (school.facilities || [])
      .map(id => SCHOOL_FACILITIES.find(f => f.id === id)?.label || id)
      .join("\n") || "None selected yet";

    const facRows = SCHOOL_FACILITIES.slice(0, FAC_PAGE_SIZE).map(f => ({
      id: `school_fac_toggle_${f.id}`,
      title: (school.facilities || []).includes(f.id) ? `✅ ${f.label}` : f.label
    }));

    if (SCHOOL_FACILITIES.length > FAC_PAGE_SIZE) {
      facRows.push({ id: "school_fac_page_1", title: "➡ More Facilities" });
    }
    facRows.push({ id: "school_account", title: "💾 Done" });

    await sendText(
      from,
      `🏊 *Your Current Facilities:*\n\n${selected}\n\nTap to add or remove:`
    );

    await sendList(from, "🏊 *Manage Facilities* - tap to toggle:", facRows);
    return true;
  }

  // ── School admin: toggle facility ────────────────────────────────────────
  if (a.startsWith("school_fac_toggle_")) {
    const phone = from.replace(/\D+/g, "");
    const facId = a.replace("school_fac_toggle_", "");
    const school = await SchoolProfile.findOne({ phone });
    if (!school) return false;

    school.facilities = Array.isArray(school.facilities) ? school.facilities : [];

    if (school.facilities.includes(facId)) {
      school.facilities = school.facilities.filter(f => f !== facId);
    } else {
      school.facilities.push(facId);
    }

    await school.save();

    const { SCHOOL_FACILITIES } = await import("./schoolPlans.js");
    const FAC_PAGE_SIZE = 7;
    const facPage = Number(biz?.sessionData?.schoolFacPage || 0);

    const facRows = SCHOOL_FACILITIES
      .slice(facPage * FAC_PAGE_SIZE, (facPage + 1) * FAC_PAGE_SIZE)
      .map(f => ({
        id: `school_fac_toggle_${f.id}`,
        title: school.facilities.includes(f.id) ? `✅ ${f.label}` : f.label
      }));

    const hasMore = (facPage + 1) * FAC_PAGE_SIZE < SCHOOL_FACILITIES.length;

    if (facPage > 0) {
      facRows.push({ id: `school_fac_page_${facPage - 1}`, title: "⬅ Previous" });
    }
    if (hasMore) {
      facRows.push({ id: `school_fac_page_${facPage + 1}`, title: "➡ More" });
    }
    facRows.push({ id: "school_account", title: "💾 Done" });

    await sendList(
      from,
      `🏊 *${school.facilities.length} selected* - tap to toggle:`,
      facRows
    );
    return true;
  }

  // ── School admin: facilities paging ──────────────────────────────────────
  if (a.startsWith("school_fac_page_")) {
    const phone = from.replace(/\D+/g, "");
    const newPage = parseInt(a.replace("school_fac_page_", ""), 10) || 0;

    if (biz) {
      biz.sessionState = "school_admin_manage_facilities";
      biz.sessionData = { ...(biz.sessionData || {}), schoolFacPage: newPage };
      await saveBiz(biz);
    }

    const school = await SchoolProfile.findOne({ phone });
    if (!school) return false;

    const { SCHOOL_FACILITIES } = await import("./schoolPlans.js");
    const FAC_PAGE_SIZE = 7;

    const facRows = SCHOOL_FACILITIES
      .slice(newPage * FAC_PAGE_SIZE, (newPage + 1) * FAC_PAGE_SIZE)
      .map(f => ({
        id: `school_fac_toggle_${f.id}`,
        title: (school.facilities || []).includes(f.id) ? `✅ ${f.label}` : f.label
      }));

    const hasMore = (newPage + 1) * FAC_PAGE_SIZE < SCHOOL_FACILITIES.length;

    if (newPage > 0) {
      facRows.push({ id: `school_fac_page_${newPage - 1}`, title: "⬅ Previous" });
    }
    if (hasMore) {
      facRows.push({ id: `school_fac_page_${newPage + 1}`, title: "➡ More" });
    }
    facRows.push({ id: "school_account", title: "💾 Done" });

    await sendList(
      from,
      `🏊 *Facilities (page ${newPage + 1})* - ${(school.facilities || []).length} selected:`,
      facRows
    );
    return true;
  }

  return false;
}
  const a = action || String(text || "").trim();

  // ── School admin: open facilities manager ────────────────────────────────
  if (a === "school_admin_manage_facilities" || state === "school_admin_manage_facilities") {
    const phone = from.replace(/\D+/g, "");
    const school = await SchoolProfile.findOne({ phone });
    if (!school) return false;

    if (biz) {
      biz.sessionState = "school_admin_manage_facilities";
      biz.sessionData = { ...(biz.sessionData || {}), schoolFacPage: 0 };
      await saveBiz(biz);
    }

    const { SCHOOL_FACILITIES } = await import("./schoolPlans.js");
    const FAC_PAGE_SIZE = 7;

    const selected = (school.facilities || [])
      .map(id => SCHOOL_FACILITIES.find(f => f.id === id)?.label || id)
      .join("\n") || "None selected yet";

    const facRows = SCHOOL_FACILITIES.slice(0, FAC_PAGE_SIZE).map(f => ({
      id: `school_fac_toggle_${f.id}`,
      title: (school.facilities || []).includes(f.id) ? `✅ ${f.label}` : f.label
    }));

    if (SCHOOL_FACILITIES.length > FAC_PAGE_SIZE) {
      facRows.push({ id: "school_fac_page_1", title: "➡ More Facilities" });
    }
    facRows.push({ id: "school_account", title: "💾 Done" });

    await sendText(
      from,
      `🏊 *Your Current Facilities:*\n\n${selected}\n\nTap to add or remove:`
    );

    await sendList(from, "🏊 *Manage Facilities* - tap to toggle:", facRows);
    return true;
  }

  // ── School admin: toggle facility ────────────────────────────────────────
  if (a.startsWith("school_fac_toggle_")) {
    const phone = from.replace(/\D+/g, "");
    const facId = a.replace("school_fac_toggle_", "");
    const school = await SchoolProfile.findOne({ phone });
    if (!school) return false;

    school.facilities = Array.isArray(school.facilities) ? school.facilities : [];

    if (school.facilities.includes(facId)) {
      school.facilities = school.facilities.filter(f => f !== facId);
    } else {
      school.facilities.push(facId);
    }

    await school.save();

    const { SCHOOL_FACILITIES } = await import("./schoolPlans.js");
    const FAC_PAGE_SIZE = 7;
    const facPage = Number(biz?.sessionData?.schoolFacPage || 0);

    const facRows = SCHOOL_FACILITIES
      .slice(facPage * FAC_PAGE_SIZE, (facPage + 1) * FAC_PAGE_SIZE)
      .map(f => ({
        id: `school_fac_toggle_${f.id}`,
        title: school.facilities.includes(f.id) ? `✅ ${f.label}` : f.label
      }));

    const hasMore = (facPage + 1) * FAC_PAGE_SIZE < SCHOOL_FACILITIES.length;

    if (facPage > 0) {
      facRows.push({ id: `school_fac_page_${facPage - 1}`, title: "⬅ Previous" });
    }
    if (hasMore) {
      facRows.push({ id: `school_fac_page_${facPage + 1}`, title: "➡ More" });
    }
    facRows.push({ id: "school_account", title: "💾 Done" });

    await sendList(
      from,
      `🏊 *${school.facilities.length} selected* - tap to toggle:`,
      facRows
    );
    return true;
  }

  // ── School admin: facilities paging ──────────────────────────────────────
  if (a.startsWith("school_fac_page_")) {
    const phone = from.replace(/\D+/g, "");
    const newPage = parseInt(a.replace("school_fac_page_", ""), 10) || 0;

    if (biz) {
      biz.sessionState = "school_admin_manage_facilities";
      biz.sessionData = { ...(biz.sessionData || {}), schoolFacPage: newPage };
      await saveBiz(biz);
    }

    const school = await SchoolProfile.findOne({ phone });
    if (!school) return false;

    const { SCHOOL_FACILITIES } = await import("./schoolPlans.js");
    const FAC_PAGE_SIZE = 7;

    const facRows = SCHOOL_FACILITIES
      .slice(newPage * FAC_PAGE_SIZE, (newPage + 1) * FAC_PAGE_SIZE)
      .map(f => ({
        id: `school_fac_toggle_${f.id}`,
        title: (school.facilities || []).includes(f.id) ? `✅ ${f.label}` : f.label
      }));

    const hasMore = (newPage + 1) * FAC_PAGE_SIZE < SCHOOL_FACILITIES.length;

    if (newPage > 0) {
      facRows.push({ id: `school_fac_page_${newPage - 1}`, title: "⬅ Previous" });
    }
    if (hasMore) {
      facRows.push({ id: `school_fac_page_${newPage + 1}`, title: "➡ More" });
    }
    facRows.push({ id: "school_account", title: "💾 Done" });

    await sendList(
      from,
      `🏊 *Facilities (page ${newPage + 1})* - ${(school.facilities || []).length} selected:`,
      facRows
    );
    return true;
  }

  // ── School admin: open extramural manager ────────────────────────────────
  if (a === "school_admin_manage_extramural" || state === "school_admin_manage_extramural") {
    const phone = from.replace(/\D+/g, "");
    const school = await SchoolProfile.findOne({ phone });
    if (!school) return false;

    if (biz) {
      biz.sessionState = "school_admin_manage_extramural";
      biz.sessionData = { ...(biz.sessionData || {}), schoolExtPage: 0 };
      await saveBiz(biz);
    }

    const extEntries = Object.entries(SCHOOL_EXTRAMURALACTIVITIES_MAP);
    const EXT_PAGE_SIZE = 7;

    const selected = (school.extramuralActivities || [])
      .map(id => SCHOOL_EXTRAMURALACTIVITIES_MAP[id] || id)
      .join("\n") || "None selected yet";

    const extRows = extEntries.slice(0, EXT_PAGE_SIZE).map(([id, label]) => ({
      id: `school_ext_toggle_${id}`,
      title: (school.extramuralActivities || []).includes(id) ? `✅ ${label}` : label
    }));

    if (extEntries.length > EXT_PAGE_SIZE) {
      extRows.push({ id: "school_ext_page_1", title: "➡ More Activities" });
    }
    extRows.push({ id: "school_account", title: "💾 Done" });

    await sendText(
      from,
      `🏃 *Your Current Extramural Activities:*\n\n${selected}\n\nTap to add or remove:`
    );

    await sendList(from, "🏃 *Manage Extramural* - tap to toggle:", extRows);
    return true;
  }

  // ── School admin: toggle extramural ──────────────────────────────────────
  if (a.startsWith("school_ext_toggle_")) {
    const phone = from.replace(/\D+/g, "");
    const extId = a.replace("school_ext_toggle_", "");
    const school = await SchoolProfile.findOne({ phone });
    if (!school) return false;

    school.extramuralActivities = Array.isArray(school.extramuralActivities)
      ? school.extramuralActivities
      : [];

    if (school.extramuralActivities.includes(extId)) {
      school.extramuralActivities = school.extramuralActivities.filter(x => x !== extId);
    } else {
      school.extramuralActivities.push(extId);
    }

    await school.save();

    const extEntries = Object.entries(SCHOOL_EXTRAMURALACTIVITIES_MAP);
    const EXT_PAGE_SIZE = 7;
    const extPage = Number(biz?.sessionData?.schoolExtPage || 0);

    const extRows = extEntries
      .slice(extPage * EXT_PAGE_SIZE, (extPage + 1) * EXT_PAGE_SIZE)
      .map(([id, label]) => ({
        id: `school_ext_toggle_${id}`,
        title: school.extramuralActivities.includes(id) ? `✅ ${label}` : label
      }));

    const hasMore = (extPage + 1) * EXT_PAGE_SIZE < extEntries.length;

    if (extPage > 0) {
      extRows.push({ id: `school_ext_page_${extPage - 1}`, title: "⬅ Previous" });
    }
    if (hasMore) {
      extRows.push({ id: `school_ext_page_${extPage + 1}`, title: "➡ More" });
    }
    extRows.push({ id: "school_account", title: "💾 Done" });

    await sendList(
      from,
      `🏃 *${school.extramuralActivities.length} selected* - tap to toggle:`,
      extRows
    );
    return true;
  }

  // ── School admin: extramural paging ──────────────────────────────────────
  if (a.startsWith("school_ext_page_")) {
    const phone = from.replace(/\D+/g, "");
    const newPage = parseInt(a.replace("school_ext_page_", ""), 10) || 0;

    if (biz) {
      biz.sessionState = "school_admin_manage_extramural";
      biz.sessionData = { ...(biz.sessionData || {}), schoolExtPage: newPage };
      await saveBiz(biz);
    }

    const school = await SchoolProfile.findOne({ phone });
    if (!school) return false;

    const extEntries = Object.entries(SCHOOL_EXTRAMURALACTIVITIES_MAP);
    const EXT_PAGE_SIZE = 7;

    const extRows = extEntries
      .slice(newPage * EXT_PAGE_SIZE, (newPage + 1) * EXT_PAGE_SIZE)
      .map(([id, label]) => ({
        id: `school_ext_toggle_${id}`,
        title: (school.extramuralActivities || []).includes(id) ? `✅ ${label}` : label
      }));

    const hasMore = (newPage + 1) * EXT_PAGE_SIZE < extEntries.length;

    if (newPage > 0) {
      extRows.push({ id: `school_ext_page_${newPage - 1}`, title: "⬅ Previous" });
    }
    if (hasMore) {
      extRows.push({ id: `school_ext_page_${newPage + 1}`, title: "➡ More" });
    }
    extRows.push({ id: "school_account", title: "💾 Done" });

    await sendList(
      from,
      `🏃 *Extramural (page ${newPage + 1})* - ${(school.extramuralActivities || []).length} selected:`,
      extRows
    );
    return true;
  }






// ── School admin: update fees state handler ───────────────────────────────────
export async function handleSchoolAdminStates({ state, from, text, action, biz, saveBiz }) {
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

// ── Brochure upload: school sends a PDF document ──────────────────────────
  if (state === "school_admin_awaiting_brochure") {
    const phone  = from.replace(/\D+/g, "");
    const school = await SchoolProfile.findOne({ phone });
    if (!school) return false;

    // Allow cancellation
    if ((text || "").trim().toLowerCase() === "cancel") {
      if (biz) { biz.sessionState = "ready"; await saveBiz(biz); }
      const { sendSchoolMoreOptionsMenu } = await import("./metaMenus.js");
      return sendSchoolMoreOptionsMenu(from, school);
    }

    // The actual PDF URL is set by the webhook route before calling handleIncomingMessage.
    // It is stored on biz.sessionData.pendingDocumentUrl by the webhook handler.
    const docUrl = biz?.sessionData?.pendingDocumentUrl;

    if (!docUrl) {
      await sendText(from,
`📄 *Waiting for your PDF...*

Please send your school brochure as a *PDF file* (tap the 📎 attachment icon in WhatsApp).

Type *cancel* to go back.`
      );
      return true;
    }

    // Save the PDF URL on the school profile
    school.profilePdfUrl = docUrl;
    await school.save();

    // Clear pending doc from session
    if (biz) {
      biz.sessionData = { ...(biz.sessionData || {}), pendingDocumentUrl: null };
      biz.sessionState = "ready";
      await saveBiz(biz);
    }

    await sendText(from,
`✅ *Brochure uploaded successfully!*

Parents who tap "📄 Download Profile" on your listing will now receive this PDF.

You can upload a new one anytime from ⚙️ More Options.`
    );

    const { sendSchoolMoreOptionsMenu } = await import("./metaMenus.js");
    return sendSchoolMoreOptionsMenu(from, school);
  }

 // ── School admin: brochure upload state ──────────────────────────────────
  if (state === "school_admin_awaiting_brochure") {
    const phone  = from.replace(/\D+/g, "");
    const school = await SchoolProfile.findOne({ phone });
    if (!school) return false;

    // Cancel command
    if ((text || "").trim().toLowerCase() === "cancel") {
      if (biz) { biz.sessionState = "ready"; await saveBiz(biz); }
      const { sendSchoolMoreOptionsMenu } = await import("./metaMenus.js");
      return sendSchoolMoreOptionsMenu(from, school);
    }

    // The PDF URL was stored in biz.sessionData by the webhook before calling engine
    const docUrl = biz?.sessionData?.pendingDocumentUrl;

    if (!docUrl) {
      // No PDF received yet - remind them
      await sendText(from,
`📄 *Waiting for your PDF...*

Please send your school brochure as a *PDF file* using the 📎 attachment icon in WhatsApp.

Type *cancel* to go back.`
      );
      return true;
    }

    // Save the uploaded PDF URL on the school profile
    school.profilePdfUrl = docUrl;
    await school.save();

    // Clear the pending URL from session and reset state
    if (biz) {
      biz.sessionData  = { ...(biz.sessionData || {}), pendingDocumentUrl: null };
      biz.sessionState = "ready";
      await saveBiz(biz);
    }

    await sendText(from,
`✅ *School brochure uploaded successfully!*

Parents who tap "📄 Download Profile" on your listing will now receive this PDF.

You can replace it anytime from ⚙️ More Options → 📄 Upload School Brochure.`
    );
    const { sendSchoolMoreOptionsMenu } = await import("./metaMenus.js");
    return sendSchoolMoreOptionsMenu(from, school);
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
if (search.city)     query.city    = new RegExp(`^${search.city}$`, "i");
if (search.suburb)   query.suburb  = new RegExp(search.suburb, "i");
if (search.type) {
  // ecd search returns both "ecd" and "ecd_primary" schools
  // primary search also includes "ecd_primary" since those schools teach primary grades
  if (search.type === "ecd") {
    query.type = { $in: ["ecd", "ecd_primary"] };
  } else if (search.type === "primary") {
    query.type = { $in: ["primary", "ecd_primary"] };
  } else {
    query.type = search.type;
  }
}
if (search.feeRange)  query.feeRange   = search.feeRange;
if (search.facility)  query.facilities = search.facility;
if (search.curriculum) {
  // "cambridge" search should find both cambridge (IGCSE) AND cambridge_primary schools
  // "cambridge_primary" search finds only cambridge_primary schools
  if (search.curriculum === "cambridge") {
    query.curriculum = { $in: ["cambridge", "cambridge_primary"] };
  } else {
    query.curriculum = search.curriculum;
  }
}
if (search.gender)    query.gender     = search.gender;
if (search.boarding)  query.boarding   = search.boarding;
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

Try broadening your search - remove the facility filter or select "Any Type".`
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

  // Notify school admin that a parent opened/clicked their school
  try {
    const { sendText: notify } = await import("./metaSender.js");
    await notify(
      school.phone,
`👀 *New School Profile View!*

A parent clicked on *${school.schoolName}* on ZimQuote and opened your school profile.

📞 Parent number: ${from}
💬 Message: A parent is viewing your school profile and may be interested in your school.

Please follow up with them if needed.`
    );
  } catch (e) { /* non-critical */ }

  const verifiedBadge  = school.verified  ? " ✅ *Verified*"   : "";
  const featuredBadge  = school.tier === "featured" ? " 🔥 *Featured*" : "";
  const admissions     = school.admissionsOpen ? "🟢 *Admissions Open*" : "🔴 *Admissions Closed*";

 const typeLabels     = { ecd: "ECD / Preschool", ecd_primary: "ECD + Primary", primary: "Primary", secondary: "Secondary", combined: "Combined" };
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

${school.principalName ? `👤 *Principal:* ${school.principalName}\n` : ""}${school.contactPhone ? `📞 *Contact:* ${school.contactPhone}\n` : ""}${school.email ? `📧 ${school.email}\n` : ""}
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

    // Try to send as WhatsApp document - log error if Meta rejects it
    try {
      await sendDocument(from, { link: school.profilePdfUrl, filename });
    } catch (docErr) {
      console.error("[School DL] sendDocument failed:", docErr.message, "url:", school.profilePdfUrl);
    }

    // Always send the direct link as text too - so parent can tap it even if document delivery fails
 return sendButtons(from, {
      text:
`📄 *${school.schoolName} - School Profile*

Your download has been sent above as a PDF file. Tap it to open.

_Can't see it? Scroll up or tap 📞 Contact School for a copy._`,
      buttons: [
        { id: `school_apply_${schoolId}`,   title: "📝 Apply Online" },
        { id: "school_search_refine",        title: "🔄 More Schools" }
      ]
    });
  }

  // PDF not yet generated - generate on demand
  try {
    const { generateSchoolProfilePDF } = await import("./schoolPdfGenerator.js");
    const pdfResult = await generateSchoolProfilePDF(school);
 if (pdfResult?.url) {
      await SchoolProfile.findByIdAndUpdate(schoolId, { profilePdfUrl: pdfResult.url });
      const { sendDocument } = await import("./metaSender.js");

      try {
        await sendDocument(from, { link: pdfResult.url, filename: pdfResult.filename });
      } catch (docErr) {
        console.error("[School DL] sendDocument (generated) failed:", docErr.message, "url:", pdfResult.url);
      }

    return sendButtons(from, {
        text:
`📄 *${school.schoolName} - School Profile*

Your download has been sent above as a PDF file. Tap it to open.

_Can't see it? Scroll up or tap 📞 Contact School for a copy._`,

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

  // No online link - fall back to contact
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

  const displayPhone = school.contactPhone || school.phone;

  const contactText =
`📞 *Contact ${school.schoolName}*

📱 Phone: *${displayPhone}*
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
 if (search.type)     parts.push({ ecd: "ECD / Preschool", ecd_primary: "ECD + Primary", primary: "Primary", secondary: "Secondary", combined: "Combined" }[search.type] || search.type);
  if (search.feeRange) parts.push(feeRangeLabel(search.feeRange));

  if (search.facility) {
    const fac = SCHOOL_FACILITIES.find(f => f.id === search.facility);
    if (fac) parts.push(fac.label);
  }

 if (search.curriculum) {
    // When search.curriculum is "cambridge", it also matches cambridge_primary schools.
    // Show a broader label so parents aren't confused when they see cambridge_primary results.
    if (search.curriculum === "cambridge") {
      parts.push("🎓 Cambridge (all levels)");
    } else {
      const cur = SCHOOL_CURRICULA.find(c => c.id === search.curriculum);
      if (cur) parts.push(cur.label);
    }
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