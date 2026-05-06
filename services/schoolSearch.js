// services/schoolSearch.js
// ─── ZimQuote Schools - Parent Search Engine ──────────────────────────────────

import SchoolProfile from "../models/schoolProfile.js";
import { sendText, sendList, sendButtons } from "./metaSender.js";
import {
  SCHOOL_CITIES, SCHOOL_SUBURB_TO_CITY, SCHOOL_FACILITIES,
  SCHOOL_TYPES, SCHOOL_FEE_RANGES, SCHOOL_CURRICULA,
  SCHOOL_GENDERS, SCHOOL_BOARDING, feeRangeLabel, facilityIcon
} from "./schoolPlans.js";

import {
  notifySchoolProfileView,
  notifySchoolEnquiry,
  notifySchoolApplicationInterest
} from "./schoolNotifications.js";

import SupplierProfile from "../models/supplierProfile.js";

// ── ZQ FAQ + Seller Chat (lazy-imported to avoid circular deps) ───────────────
// These are called when a buyer taps a ZimQuote bot link via handleZqDeepLink.
// Imported lazily to prevent circular dependency with chatbotEngine.

// ── ZQ Link base URL ──────────────────────────────────────────────────────────
const BASE_URL   = (process.env.SITE_URL || process.env.APP_BASE_URL || "https://zimquote.co.zw").replace(/\/$/, "");
const BOT_NUMBER = (process.env.WHATSAPP_BOT_NUMBER || "263771143904").replace(/\D/g, "");



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

    const shortLabel = _normSchoolText(fac.label).replace(/^\S+\s+/, "").trim();
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
// ZQ DEEP-LINK HANDLER
// Intercepts payloads fired by the ZQ Link landing page via wa.me deep-link.
// Payload format: "ZQ:SCHOOL:<mongoId>"  or  "ZQ:SUPPLIER:<mongoId>"
//
// Wire in chatbotEngine BEFORE the state machine:
//   const deepHandled = await handleZqDeepLink({ from, text, biz, saveBiz });
//   if (deepHandled) return;
// ─────────────────────────────────────────────────────────────────────────────
export async function handleZqDeepLink({ from, text, biz, saveBiz }) {
  const raw = String(text || "").trim();

  if (/^ZQ:SCHOOL:[a-f0-9]{24}$/i.test(raw)) {
    const schoolId = raw.split(":")[2];
    SchoolProfile.findByIdAndUpdate(schoolId, {
      $inc: { monthlyViews: 1, zqLinkConversions: 1 }
    }).catch(() => {});
    try {
      const { showSchoolFAQMenu } = await import("./schoolFAQ.js");
      await showSchoolFAQMenu(from, schoolId, biz, saveBiz, { source: "whatsapp_link" });
    } catch (e) {
      await _showSchoolDetail(from, schoolId, biz, "zq_link");
    }
    return true;
  }

  if (/^ZQ:SUPPLIER:[a-f0-9]{24}/i.test(raw)) {
    const parts      = raw.split(":");
    const supplierId = parts[2];
    const supKVs     = parts.slice(3);
    const supParams  = {};
    for (const kv of supKVs) {
      const eq = kv.indexOf("=");
      if (eq > 0) supParams[kv.slice(0,eq)] = decodeURIComponent(kv.slice(eq+1));
    }
    SupplierProfile.findByIdAndUpdate(supplierId, {
      $inc: { zqLinkViews: 1, zqLinkConversions: 1 }
    }).catch(() => {});
    try {
      const { showSellerMenu } = await import("./sellerChat.js");
      await showSellerMenu(from, supplierId, biz, saveBiz, {
        source: "whatsapp_link", parentName: supParams.name || ""
      });
    } catch (e) {
      await _showSupplierCard(from, supplierId);
    }
    return true;
  }

  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// ZQ SLUG SHORTCODE HANDLER
// "zq st-ignatius" or "zq mama-bakers" typed directly in WhatsApp.
//
// Wire in chatbotEngine BEFORE the state machine:
//   const slugHandled = await handleSchoolSlugSearch({ from, text, biz, saveBiz });
//   if (slugHandled) return;
// ─────────────────────────────────────────────────────────────────────────────
export async function handleSchoolSlugSearch({ from, text, biz, saveBiz }) {
  const raw = String(text || "").trim().toLowerCase();
  if (!raw.startsWith("zq ") || raw.length < 5) return false;

  const slug = raw.slice(3).trim().replace(/\s+/g, "-");

  const school = await SchoolProfile.findOne({ zqSlug: slug, active: true }).lean();
  if (school) {
    SchoolProfile.findByIdAndUpdate(school._id, {
      $inc: { monthlyViews: 1, zqLinkConversions: 1 }
    }).catch(() => {});
    await _showSchoolDetail(from, String(school._id), biz, "slug_search");
    return true;
  }

  const supplier = await SupplierProfile.findOne({ zqSlug: slug }).lean();
  if (supplier) {
    await _showSupplierCard(from, String(supplier._id));
    return true;
  }

  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// SCHOOL ADMIN BOT: "Get My ZQ Link"
// Wire into handleSchoolSearchActions:
//   if (a === "school_get_zq_link")   return handleGetSchoolZqLink(from);
//   if (a === "school_share_link_wa") return handleShareSchoolLinkWa(from);
// ─────────────────────────────────────────────────────────────────────────────
export async function handleGetSchoolZqLink(from) {
  const phone  = from.replace(/\D+/g, "");
  const school = await SchoolProfile.findOne({ phone }).lean();

  if (!school) {
    return sendText(from, "❌ No school profile found for this number.");
  }

  if (!school.zqSlug) {
    return sendText(from,
`⚠️ *Your ZQ Link is not set up yet.*

Please contact ZimQuote to activate your shareable link.

📞 0789 901 058`
    );
  }

  const link = `${BASE_URL}/s/${school.zqSlug}`;

  return sendButtons(from, {
    text:
`🔗 *Your ZimQuote Profile Link*

${link}

*Share this link everywhere you market your school:*

📱 *TikTok* → Paste as your bio link. Every video drives parents straight to your profile.
📘 *Facebook* → Paste in posts, stories, and your page description.
🐦 *Twitter / X* → Add to your profile bio - it shows as a rich preview card.
💬 *WhatsApp Status* → Share it weekly so your contacts can tap and enquire.
🖨️ *Posters* → Your admin can print a QR code for school gates and events.
📧 *Email signature* → One tap takes parents to your profile.

When anyone taps this link, WhatsApp opens and your full profile appears instantly - fees, facilities, admissions, and an Enquire button. No searching needed.`,
    buttons: [
      { id: "school_share_link_wa", title: "📤 Get Share Message" },
      { id: "school_account",       title: "⬅ Back to Menu" }
    ]
  });
}

export async function handleShareSchoolLinkWa(from) {
  const phone  = from.replace(/\D+/g, "");
  const school = await SchoolProfile.findOne({ phone }).lean();
  if (!school || !school.zqSlug) return false;

  const link = `${BASE_URL}/s/${school.zqSlug}`;

  await sendText(from,
`📤 *Copy and paste this into any Facebook post, WhatsApp group, or TikTok caption:*

━━━━━━━━━━━━━━━━━━
🏫 *${school.schoolName}*
📍 ${school.suburb ? school.suburb + ", " : ""}${school.city}
${school.admissionsOpen ? "🟢 Admissions currently OPEN\n" : ""}
See our full profile, fees, facilities & apply online:
👉 ${link}

_Found us on ZimQuote – Zimbabwe's school finder_
━━━━━━━━━━━━━━━━━━

_Tip: Put this link in your TikTok bio. Every video you post drives parents directly to your school profile._`
  );

  const { sendSchoolAccountMenu } = await import("./metaMenus.js");
  return sendSchoolAccountMenu(from, school);
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
  // For non-biz users, load search state from UserSession
  let _userSess = null;
  if (!biz) {
    const { default: UserSession } = await import("../models/userSession.js");
    const phone = from.replace(/\D+/g, "");
    _userSess = await UserSession.findOne({ phone });
  }

  const search = biz?.sessionData?.schoolSearch || _userSess?.tempData?.schoolSearch || {};

  // Helper: persist search for both biz and non-biz users
  async function _saveSearch(updatedSearch) {
    if (biz) {
      biz.sessionData = { ...(biz.sessionData || {}), schoolSearch: updatedSearch };
      await saveBiz(biz);
    } else {
      const { default: UserSession } = await import("../models/userSession.js");
      const phone = from.replace(/\D+/g, "");
      await UserSession.findOneAndUpdate(
        { phone },
        { $set: { "tempData.schoolSearch": updatedSearch } },
        { upsert: true }
      );
    }
  }
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
    await _saveSearch(search);

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
    await _saveSearch(search);

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
    await _saveSearch(search);

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
    await _saveSearch(search);
    if (biz) biz.sessionState = "school_search_results";
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

  // ── Send Enquiry: parent taps button → bot asks for their message ────────
if (a.startsWith("school_enquiry_")) {
    const schoolId = a.replace("school_enquiry_", "");
    const school   = await SchoolProfile.findById(schoolId).lean();
    if (!school) return false;

    // Store in biz session if available
    if (biz) {
      biz.sessionState = "school_parent_enquiry";
      biz.sessionData  = { ...(biz.sessionData || {}), enquirySchoolId: schoolId };
      await saveBiz(biz);
    }

    // ALWAYS store in UserSession so non-biz parents are covered
    const phone = from.replace(/\D+/g, "");
    const { default: UserSession } = await import("../models/userSession.js");
    await UserSession.findOneAndUpdate(
      { phone },
      {
        $set: {
          "tempData.schoolEnquiryState": "school_parent_enquiry",
          "tempData.enquirySchoolId":    schoolId
        }
      },
      { upsert: true }
    );

    return sendText(from,
`✉️ *Send an Enquiry to ${school.schoolName}*

Type your question or message below and we will send it to the school on your behalf.

_Example: "Do you have space for Grade 3 in 2026?" or "What are your boarding fees?"_

Type *cancel* to go back.`
    );
  }

  // ── Refine search ─────────────────────────────────────────────────────────
  if (a === "school_search_refine") {
    return startSchoolSearch(from, biz, saveBiz);
  }

  // ── Pagination ────────────────────────────────────────────────────────────
  if (a.startsWith("school_search_page_")) {
    const page = parseInt(a.replace("school_search_page_", ""), 10) || 0;
    search.page = page;
    await _saveSearch(search);
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
  if (a === "school_admin_manage_facilities") {
    const phone = from.replace(/\D+/g, "");
    const school = await SchoolProfile.findOne({ phone });
    if (!school) return false;

    if (biz) {
      biz.sessionState = "school_admin_manage_facilities";
      biz.sessionData = { ...(biz.sessionData || {}), schoolFacPage: 0 };
      await saveBiz(biz);
    }

    const FAC_PAGE_SIZE = 7;

    const selected = (school.facilities || [])
      .map(id => SCHOOL_FACILITIES.find(f => f.id === id)?.label || id)
      .join("\n") || "None selected yet";

    const facRows = SCHOOL_FACILITIES
      .slice(0, FAC_PAGE_SIZE)
      .map(f => ({
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

    return sendList(from, "🏊 *Manage Facilities* - tap to toggle:", facRows);
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

    const FAC_PAGE_SIZE = 7;
    const facPage = Number(biz?.sessionData?.schoolFacPage || 0);

    if (biz) {
      biz.sessionState = "school_admin_manage_facilities";
      biz.sessionData = { ...(biz.sessionData || {}), schoolFacPage: facPage };
      await saveBiz(biz);
    }

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

    return sendList(
      from,
      `🏊 *Manage Facilities* - ${(school.facilities || []).length} selected:`,
      facRows
    );
  }

  // ── School admin: facilities paging ──────────────────────────────────────
  if (a.startsWith("school_fac_page_")) {
    const phone = from.replace(/\D+/g, "");
    const school = await SchoolProfile.findOne({ phone });
    if (!school) return false;

    const newPage = parseInt(a.replace("school_fac_page_", ""), 10) || 0;
    const FAC_PAGE_SIZE = 7;

    if (biz) {
      biz.sessionState = "school_admin_manage_facilities";
      biz.sessionData = { ...(biz.sessionData || {}), schoolFacPage: newPage };
      await saveBiz(biz);
    }

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

    return sendList(
      from,
      `🏊 *Manage Facilities* - page ${newPage + 1}:`,
      facRows
    );
  }

  // ── School admin: get ZQ Link ─────────────────────────────────────────────
  if (a === "school_get_zq_link") {
    return handleGetSchoolZqLink(from);
  }

  // ── School admin: get share message ──────────────────────────────────────
  if (a === "school_share_link_wa") {
    return handleShareSchoolLinkWa(from);
  }

  // ── School admin: Smart Card platform-specific link menu ─────────────────
  if (a === "school_smart_card_menu") {
    return handleSmartCardMenu(from);
  }

  // ── School admin: generate a source-tagged link ───────────────────────────
  if (a.startsWith("school_sc_src_")) {
    const src = a.replace("school_sc_src_", "");
    return handleSmartCardSourceLink(from, src);
  }

  // ── School admin: view lead database ─────────────────────────────────────
  if (a === "school_my_leads") {
    return handleMyLeads(from, biz, saveBiz);
  }

  // ── School admin: follow up a specific lead ───────────────────────────────
  if (a.startsWith("school_followup_")) {
    const leadId = a.replace("school_followup_", "");
    return handleFollowUpLead(from, leadId);
  }

  // ── School admin: leads pagination ───────────────────────────────────────
  if (a.startsWith("school_leads_page_")) {
    const page = parseInt(a.replace("school_leads_page_", ""), 10) || 0;
    return handleMyLeads(from, biz, saveBiz, page);
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

  // ── Parent typed their enquiry message ──────────────────────────────────
  if (state === "school_parent_enquiry") {
    const message = (text || "").trim();

    if (message.toLowerCase() === "cancel") {
      if (biz) { biz.sessionState = "ready"; await saveBiz(biz); }
      return sendButtons(from, {
        text: "❌ Enquiry cancelled.",
        buttons: [{ id: "school_search_refine", title: "🔄 Back to Schools" }]
      });
    }

    if (!message || message.length < 3) {
      await sendText(from, "❌ Please type your question or message (at least 3 characters).");
      return true;
    }

    const schoolId = biz?.sessionData?.enquirySchoolId;
    if (!schoolId) {
      if (biz) { biz.sessionState = "ready"; await saveBiz(biz); }
      return false;
    }

    const school = await SchoolProfile.findById(schoolId).lean();
    if (!school) {
      if (biz) { biz.sessionState = "ready"; await saveBiz(biz); }
      return false;
    }

    // Increment enquiry counter
    await SchoolProfile.findByIdAndUpdate(schoolId, { $inc: { inquiries: 1 } });

    // Notify school with the actual parent message via template
    notifySchoolEnquiry(school.phone, school.schoolName, from, message).catch(() => {});

    // Reset session
    if (biz) {
      biz.sessionState = "ready";
      biz.sessionData  = { ...(biz.sessionData || {}), enquirySchoolId: null };
      await saveBiz(biz);
    }

    // Confirm to parent
    return sendButtons(from, {
      text:
`✅ *Enquiry Sent to ${school.schoolName}!*

Your message:
_${message}_

The school has been notified and will contact you on this WhatsApp number.

📞 ${school.contactPhone || school.phone}`,
      buttons: [
        { id: `school_apply_${schoolId}`, title: "📝 Apply Online" },
        { id: "school_search_refine",         title: "🔄 More Schools" }
      ]
    });
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
  // "combined" schools span ECD–Form 6, so they must appear in ALL type searches
  if (search.type === "ecd") {
    query.type = { $in: ["ecd", "ecd_primary", "combined"] };
  } else if (search.type === "primary") {
    query.type = { $in: ["primary", "ecd_primary", "combined"] };
  } else if (search.type === "secondary") {
    query.type = { $in: ["secondary", "combined"] };
  } else {
    query.type = search.type;
  }
}
if (search.feeRange)  query.feeRange   = search.feeRange;
if (search.facility)  query.facilities = search.facility;
if (search.curriculum) {
  if (search.curriculum === "cambridge") {
    // matches schools whose curriculum array contains "cambridge" OR "cambridge_primary"
    query.curriculum = { $in: ["cambridge", "cambridge_primary"] };
  } else {
    // for all other curricula (zimsec, ib, combined), match against the array field
    query.curriculum = { $elemMatch: { $eq: search.curriculum } };
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
// source: "zq_link" | "slug_search" | undefined
// ─────────────────────────────────────────────────────────────────────────────
async function _showSchoolDetail(from, schoolId, biz, source) {
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
// Notify school admin - uses Meta template for out-of-session delivery
  notifySchoolProfileView(school.phone, school.schoolName, from).catch(() => {});

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

let feeLine = feeRangeLabel(school.feeRange);
  if (school.fees?.term1) {
    feeLine = `Day: $${school.fees.term1} / $${school.fees.term2} / $${school.fees.term3}`;
    if ((school.fees.boardingTerm1 || 0) > 0) {
      feeLine += `\n  Boarding: $${school.fees.boardingTerm1} / $${school.fees.boardingTerm2} / $${school.fees.boardingTerm3}`;
    }
    if ((school.fees.ecdTerm1 || 0) > 0 && school.fees.ecdTerm1 !== school.fees.term1) {
      feeLine += `\n  ECD: $${school.fees.ecdTerm1} / $${school.fees.ecdTerm2} / $${school.fees.ecdTerm3}`;
    }
    feeLine += " (USD per term)";
  }

  const rating         = school.reviewCount > 0
    ? `⭐ ${school.rating.toFixed(1)} (${school.reviewCount} reviews)`
    : "⭐ No reviews yet";

  const gradeText      = (school.grades?.from && school.grades?.to)
    ? `${school.grades.from} – ${school.grades.to}`
    : "Not specified";

  // ── ZQ Link footer - shown when the school has a slug ────────────────────
  const zqLinkLine = school.zqSlug
    ? `\n\n🔗 *Share this school:*\n${BASE_URL}/s/${school.zqSlug}`
    : "";

  // Source note for parents who arrived via a shared link
  const sourceNote = source === "zq_link" || source === "slug_search"
    ? "\n_You arrived via a ZimQuote share link._"
    : "";

  const detailText =
`🏫 *${school.schoolName}*${verifiedBadge}${featuredBadge}
📍 ${school.suburb ? school.suburb + ", " : ""}${school.city}${school.address ? "\n🏠 " + school.address : ""}

${admissions}${sourceNote}

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
👀 ${school.monthlyViews || 0} views this month${zqLinkLine}`;

 // Show download button only if school has documents
  const hasDocuments = (school.brochures || []).length > 0 || !!school.profilePdfUrl;
  const docCount     = (school.brochures || []).length || (school.profilePdfUrl ? 1 : 0);
  const dlLabel      = docCount > 1 ? `📄 Download (${docCount} docs)` : "📄 Download Profile";

  const buttons = [];
  if (hasDocuments) buttons.push({ id: `school_dl_profile_${schoolId}`, title: dlLabel });
  buttons.push({ id: `school_apply_${schoolId}`,  title: "📝 Apply Online" });
  buttons.push({ id: `school_enquiry_${schoolId}`, title: "✉️ Send Enquiry" });

  return sendButtons(from, { text: detailText, buttons });
}

// ─────────────────────────────────────────────────────────────────────────────
// PRIVATE: supplier detail card (for ZQ deep-link / slug search)
// ─────────────────────────────────────────────────────────────────────────────
async function _showSupplierCard(from, supplierId) {
  const supplier = await SupplierProfile.findById(supplierId).lean();
  if (!supplier) {
    return sendButtons(from, {
      text: "❌ This seller profile is not currently available.",
      buttons: [{ id: "main_menu_back", title: "🏠 Main Menu" }]
    });
  }

  const isService   = supplier.serviceType === "service";
  const productList = (supplier.products || []).slice(0, 8).join(", ") || "See catalogue";
  const delivery    = supplier.delivery?.available ? "🚚 Delivers to buyers" : "🏠 Collection only";
  const rating      = (supplier.reviewCount || 0) > 0
    ? `⭐ ${Number(supplier.rating).toFixed(1)} (${supplier.reviewCount} reviews)`
    : "⭐ No reviews yet";

  const priceSummary = isService
    ? (Array.isArray(supplier.rates) && supplier.rates.length
        ? supplier.rates.slice(0, 3).map(r => `${r.service} (${r.rate})`).join(", ")
        : "_Rates on request_")
    : (Array.isArray(supplier.prices) && supplier.prices.length
        ? supplier.prices.slice(0, 3).map(p => `${p.product} $${Number(p.amount).toFixed(2)}`).join(", ")
        : "_Prices on request_");

  const zqLinkLine = supplier.zqSlug
    ? `\n\n🔗 *Share this seller:*\n${BASE_URL}/p/${supplier.zqSlug}`
    : "";

  const detailText =
`🏪 *${supplier.businessName}*
📍 ${supplier.area ? supplier.area + ", " : ""}${supplier.city}

${isService ? "🔧" : "📦"} *${isService ? "Services" : "Products"}:* ${productList}

💰 *Pricing:* ${priceSummary}
${delivery}

${rating}${zqLinkLine}`;

  return sendButtons(from, {
    text: detailText,
    buttons: [
      { id: `sup_enquire_${supplierId}`, title: "✉️ Send Enquiry" },
      { id: `sup_view_${supplierId}`,    title: "📋 Full Profile" }
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

// Collect all available documents: admin brochures first, then legacy profilePdfUrl
  const { sendDocument } = await import("./metaSender.js");
  const allDocs = [];

  // Admin-uploaded brochures (the new system)
  if ((school.brochures || []).length > 0) {
    for (const b of school.brochures) {
      allDocs.push({ label: b.label || "School Brochure", url: b.url });
    }
  }

  // Legacy single PDF (old system - keep working)
  if (school.profilePdfUrl && !allDocs.some(d => d.url === school.profilePdfUrl)) {
    allDocs.push({ label: `${school.schoolName} Profile`, url: school.profilePdfUrl });
  }

if (allDocs.length > 0) {
    // ── Try sendDocument first, fall back to text link ────────────────────────
    for (const doc of allDocs) {
      const directUrl = doc.url;
      const filename  = doc.label.replace(/[^a-zA-Z0-9 _-]/g, "").replace(/\s+/g, "_") + ".pdf";
      try {
        await sendDocument(from, { link: directUrl, filename });
        doc._sent = true; // mark as successfully sent as file
      } catch (docErr) {
        console.error(`[School DL] sendDocument failed for "${doc.label}":`, docErr.message);
        doc._sent = false;
      }
      doc._directUrl = directUrl;
    }

    // ── Build the reply message ───────────────────────────────────────────────
    const sentAsDocs  = allDocs.filter(d => d._sent);
    const failedDocs  = allDocs.filter(d => !d._sent);

    let replyText = `📄 *${school.schoolName} - Documents*\n\n`;

    if (sentAsDocs.length > 0) {
      replyText += `The following ${sentAsDocs.length > 1 ? "documents were" : "document was"} sent above as a file:\n`;
      replyText += sentAsDocs.map(d => `• ${d.label}`).join("\n");
      replyText += `\n\nTap the file${sentAsDocs.length > 1 ? "s" : ""} above to open.\n\n`;
    }

    // For any that failed (e.g. Drive permission issues), send as tappable links
    if (failedDocs.length > 0) {
      replyText += `Tap to open:\n`;
      replyText += failedDocs.map(d => `📎 *${d.label}*\n${d._directUrl}`).join("\n\n");
      replyText += "\n\n";
    }

    replyText += `_Contact the school if you have any questions._`;

    return sendButtons(from, {
      text: replyText,
      buttons: [
        { id: `school_apply_${schoolId}`, title: "📝 Apply Online" },
        { id: "school_search_refine",      title: "🔄 More Schools" }
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
      { id: `school_enquiry_${schoolId}`, title: "✉️ Send Enquiry" },
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
notifySchoolApplicationInterest(school.phone, school.schoolName, from).catch(() => {});

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
      { id: `school_enquiry_${schoolId}`, title: "✉️ Send Enquiry" },
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
notifySchoolEnquiry(school.phone, school.schoolName, from).catch(() => {});

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
// ─────────────────────────────────────────────────────────────────────────────
// SMART CARD MENU - school admin picks platform for source-tagged link
// ─────────────────────────────────────────────────────────────────────────────
export async function handleSmartCardMenu(from) {
  const phone  = from.replace(/\D+/g, "");
  const school = await SchoolProfile.findOne({ phone }).lean();
  if (!school) return sendText(from, "❌ No school profile found.");

  if (!school.zqSlug) {
    return sendText(from,
`⚠️ *Your Smart Card link is not set up yet.*

Please contact ZimQuote admin to activate your Smart Card.
📞 0789 901 058`
    );
  }

  const baseLink = `${BASE_URL}/s/${school.zqSlug}`;

  return sendList(from,
`🔗 *Your ZimQuote Smart Card*

${baseLink}

Choose where you want to share it - we will generate a version that tracks leads from that platform:`,
    [
      { id: "school_sc_src_tiktok",          title: "📱 TikTok bio link" },
      { id: "school_sc_src_facebook",         title: "📘 Facebook post / page" },
      { id: "school_sc_src_twitter",          title: "🐦 Twitter / X profile" },
      { id: "school_sc_src_whatsapp_status",  title: "💬 WhatsApp Status" },
      { id: "school_sc_src_qr",              title: "🖨️ QR poster / print" },
      { id: "school_sc_src_sms",             title: "📲 SMS blast" },
      { id: "school_my_leads",               title: "👥 View My Leads" },
      { id: "school_account",                title: "⬅ Back to Menu" }
    ]
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// SMART CARD SOURCE LINK - return a source-tagged link + ready-to-paste copy
// ─────────────────────────────────────────────────────────────────────────────
export async function handleSmartCardSourceLink(from, source) {
  const phone  = from.replace(/\D+/g, "");
  const school = await SchoolProfile.findOne({ phone }).lean();
  if (!school || !school.zqSlug) return false;

  const link = `${BASE_URL}/s/${school.zqSlug}?src=${source}`;

  const TIPS = {
    tiktok:         "Paste this in TikTok → Edit Profile → Add link. End every video caption with: \"Link in bio 👆\"",
    facebook:       "Paste this in your Facebook post caption or in your Page's About section → Website field.",
    twitter:        "Add this to your Twitter/X profile bio under the website field. It unfurls into a preview card.",
    whatsapp_status: "Copy the share message below and post it to your WhatsApp Status. Tap it at any time to update.",
    qr:             `Open this URL on your phone or laptop:\n${BASE_URL}/s/${school.zqSlug}/qr\nThen tap 🖨️ Print Poster.`,
    sms:            "Paste this link into your bulk SMS message. It works on all phones, even without data."
  };
  const tip = TIPS[source] || "Share this link on any platform.";

  const admLine = school.admissionsOpen ? "🟢 Admissions currently OPEN" : "";
  const shareMsg =
`🏫 *${school.schoolName}*
📍 ${school.suburb ? school.suburb + ", " : ""}${school.city}
${admLine}

See our full profile, fees & enquire:
👉 ${link}

_Found via ZimQuote – Zimbabwe's school finder_`;

  await sendText(from,
`🔗 *Your ${source.replace("_"," ")} Smart Card link:*

${link}

📋 *Ready-to-paste message:*
━━━━━━━━━━━━━━━━━━
${shareMsg}
━━━━━━━━━━━━━━━━━━

💡 *Tip:* ${tip}`
  );

  return sendButtons(from, {
    text: "What would you like to do next?",
    buttons: [
      { id: "school_smart_card_menu", title: "🔗 Other Platforms" },
      { id: "school_my_leads",        title: "👥 My Leads" },
      { id: "school_account",         title: "⬅ Back to Menu" }
    ]
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// MY LEADS - shows the school's uncontacted leads with follow-up buttons
// ─────────────────────────────────────────────────────────────────────────────
export async function handleMyLeads(from, biz, saveBiz, page = 0) {
  const SchoolLead = (await import("../models/schoolLead.js")).default;
  const phone      = from.replace(/\D+/g, "");
  const school     = await SchoolProfile.findOne({ phone }).lean();
  if (!school) return false;

  const PAGE_SIZE    = 5;
  const totalLeads   = await SchoolLead.countDocuments({ schoolId: school._id });
  const uncontacted  = await SchoolLead.countDocuments({ schoolId: school._id, contacted: false, actionType: { $ne: "view" } });
  const leads        = await SchoolLead.find({ schoolId: school._id, actionType: { $ne: "view" } })
    .sort({ createdAt: -1 })
    .skip(page * PAGE_SIZE)
    .limit(PAGE_SIZE)
    .lean();

  if (!leads.length && page === 0) {
    return sendButtons(from, {
      text:
`👥 *Your Smart Card Leads*

No leads yet.

Share your Smart Card link on TikTok, Facebook, or WhatsApp Status to start receiving leads.`,
      buttons: [
        { id: "school_smart_card_menu", title: "🔗 Get My Smart Card" },
        { id: "school_account",         title: "⬅ Back to Menu" }
      ]
    });
  }

  const ACTION_LABELS = {
    fees: "Requested fees", visit: "Requested visit",
    place: "Asked about place", pdf: "Downloaded profile",
    enquiry: "Sent enquiry", apply: "Wants to apply"
  };
  const SOURCE_ICONS = {
    tiktok:"TikTok", facebook:"FB", twitter:"X", whatsapp_status:"WA Status",
    qr:"QR poster", sms:"SMS", direct:"Direct link", other:"Other"
  };

  let text = `👥 *Smart Card Leads* (page ${page + 1})\n`;
  text    += `📊 Total: ${totalLeads} · ⚠️ Not yet contacted: ${uncontacted}\n\n`;

  for (const lead of leads) {
    const date    = new Date(lead.createdAt).toLocaleDateString("en-GB", { day:"numeric", month:"short" });
    const name    = lead.parentName || "Anonymous";
    const action  = ACTION_LABELS[lead.actionType] || lead.actionType;
    const src     = SOURCE_ICONS[lead.source] || lead.source;
    const status  = lead.contacted ? "✅ Contacted" : "🔴 Not contacted";
    const grade   = lead.gradeInterest ? ` (${lead.gradeInterest})` : "";
    text += `${status} · ${date}\n👤 ${name}${lead.parentPhone ? " · " + lead.parentPhone : ""}\n📌 ${action}${grade} · ${src}\n\n`;
  }

  const buttons = [];
  // Show follow-up button for first uncontacted lead
  const firstUncontacted = leads.find(l => !l.contacted);
  if (firstUncontacted) {
    buttons.push({ id: `school_followup_${firstUncontacted._id}`, title: "📲 Follow Up Next" });
  }
  if ((page + 1) * PAGE_SIZE < totalLeads) {
    buttons.push({ id: `school_leads_page_${page + 1}`, title: "➡ Next Page" });
  }
  buttons.push({ id: "school_account", title: "⬅ Back to Menu" });

  return sendButtons(from, { text: text.trim(), buttons });
}

// ─────────────────────────────────────────────────────────────────────────────
// FOLLOW UP LEAD - mark as contacted, send school admin a pre-filled WA link
// ─────────────────────────────────────────────────────────────────────────────
export async function handleFollowUpLead(from, leadId) {
  const SchoolLead = (await import("../models/schoolLead.js")).default;
  const lead = await SchoolLead.findById(leadId).lean();
  if (!lead) return sendText(from, "❌ Lead not found.");

  // Mark as contacted
  await SchoolLead.findByIdAndUpdate(leadId, {
    $set: { contacted: true, contactedAt: new Date(), contactedBy: from.replace(/\D+/g,"") }
  });

  const ACTION_LABELS = {
    fees:"requested fees", visit:"requested a school visit",
    place:"asked about a place", pdf:"downloaded your school profile",
    enquiry:"sent an enquiry", apply:"asked about applying"
  };
  const actionLabel = ACTION_LABELS[lead.actionType] || "enquired via ZimQuote";

  const greeting = lead.parentName
    ? `Hi ${lead.parentName.split(" ")[0]}`
    : "Good morning";

  const prefilledMsg = lead.gradeInterest
    ? `${greeting}, I'm following up from ${lead.schoolName}. You ${actionLabel} for ${lead.gradeInterest} via ZimQuote. I'd love to help - do you have any questions?`
    : `${greeting}, I'm following up from ${lead.schoolName}. You ${actionLabel} via ZimQuote. I'd love to help - do you have any questions?`;

  const buttons = [];

  if (lead.parentPhone) {
    const waLink = `https://wa.me/${lead.parentPhone.replace(/\D+/g,"")}?text=${encodeURIComponent(prefilledMsg)}`;
    await sendText(from,
`✅ *Lead marked as contacted.*

👤 *${lead.parentName || "Anonymous"}*${lead.parentPhone ? "\n📞 " + lead.parentPhone : ""}
📌 ${ACTION_LABELS[lead.actionType] || lead.actionType}${lead.gradeInterest ? " - " + lead.gradeInterest : ""}

*Tap below to open a pre-filled WhatsApp message to this parent:*
${waLink}`
    );
    buttons.push({ id: "school_my_leads", title: "👥 Back to Leads" });
    buttons.push({ id: "school_account",  title: "⬅ Main Menu" });
  } else {
    await sendText(from,
`✅ *Lead marked as contacted.*

👤 *${lead.parentName || "Anonymous"}*
📌 ${ACTION_LABELS[lead.actionType] || lead.actionType}${lead.gradeInterest ? " - " + lead.gradeInterest : ""}

No phone number captured for this lead (they may not have entered their name on the Smart Card page).`
    );
    buttons.push({ id: "school_my_leads", title: "👥 Back to Leads" });
    buttons.push({ id: "school_account",  title: "⬅ Main Menu" });
  }

  return sendButtons(from, { text: "What would you like to do next?", buttons });
}