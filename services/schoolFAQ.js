// services/schoolFAQ.js
// ─── ZimQuote School Chatbot — Full FAQ with Preloaded Answers ────────────────
//
// WHATSAPP BUTTON TITLE LIMIT: 20 characters maximum (hard limit enforced by Meta)
// All button titles in this file are ≤20 chars. Counted carefully.
//
// FAQ Categories (each is a separate sendList with ≤10 items):
//   CATEGORY 1: Fees & Payments
//   CATEGORY 2: Admissions & Enrollment
//   CATEGORY 3: Academic & Results
//   CATEGORY 4: School Life (transport, facilities, sports, uniforms, calendar)
//   CATEGORY 5: Contact & Admin (staff, docs, compare, message)
//   CATEGORY 6: Custom FAQ (school-specific Q&A set by school admin)
//
// SchoolProfile schema additions needed:
//   faqItems: [{
//     id: String,           // unique, auto-generated
//     category: String,     // "fees"|"admissions"|"academic"|"life"|"admin"|"custom"
//     question: String,     // shown as button title (truncated to 20 chars on button)
//     answer: String,       // full answer text sent to parent
//     pdfUrl: String,       // optional: PDF sent instead of/alongside text answer
//     pdfLabel: String,     // filename label for the PDF
//     active: Boolean,      // true = shown to parents
//     order: Number,        // position within category (0 = first)
//     addedBy: String,      // "school" | "zimquote_admin"
//   }]

import SchoolProfile from "../models/schoolProfile.js";
import SchoolLead    from "../models/schoolLead.js";
import { sendText, sendButtons, sendList } from "./metaSender.js";
import {
  notifySchoolEnquiry,
  notifySchoolApplicationInterest,
  notifySchoolVisitRequest,
  notifySchoolPlaceEnquiry,
  notifySchoolNewLead
} from "./schoolNotifications.js";
import { SCHOOL_FACILITIES, SCHOOL_EXTRAMURALACTIVITIES } from "./schoolPlans.js";

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────
const MAX_BTN = 20; // WhatsApp button title hard limit

// Safe button title — trims and enforces ≤20 chars
function _btn(title) {
  return title.trim().slice(0, MAX_BTN);
}

function _feeLabel(s) {
  if (s.fees?.term1) return `$${s.fees.term1}/term`;
  return { budget:"Under $300/term", mid:"$300–$800/term", premium:"$800+/term" }[s.feeRange] || "Ask school";
}

async function _saveSession(biz, saveBiz, state, data = {}) {
  if (!biz || !saveBiz) return;
  biz.sessionState = state;
  biz.sessionData  = { ...(biz.sessionData || {}), ...data };
  try { await saveBiz(biz); } catch (e) { /* ignore */ }
}

function _lead(from, school, action, source, extra = {}) {
  SchoolLead.create({
    schoolId: school._id, schoolPhone: school.phone,
    schoolName: school.schoolName, zqSlug: school.zqSlug || "",
    parentPhone: from.replace(/\D+/g,""),
    parentName: extra.parentName || "", gradeInterest: extra.gradeInterest || "",
    actionType: action, source, waOpened: true, contacted: false
  }).catch(() => {});
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN MENU — entry point when parent taps school's ZimQuote bot link
// ─────────────────────────────────────────────────────────────────────────────
export async function showSchoolFAQMenu(from, schoolId, biz, saveBiz, { source = "direct", parentName = "" } = {}) {
  const school = await SchoolProfile.findById(schoolId).lean();
  if (!school) return sendText(from, "❌ School not found. Please try the link again.");

  SchoolProfile.findByIdAndUpdate(schoolId, { $inc: { monthlyViews: 1, zqLinkConversions: 1 } }).catch(() => {});
  _lead(from, school, "view", source, { parentName });

  await _saveSession(biz, saveBiz, "sfaq_menu", {
    faqSchoolId:   String(schoolId),
    faqParentName: parentName,
    faqSource:     source
  });

  const adm  = school.admissionsOpen ? "🟢 Open" : "🔴 Closed";
  const fee  = _feeLabel(school);
  const cur  = (school.curriculum || []).map(c => c.toUpperCase()).join("+") || "ZIMSEC";
  const TYPE = { ecd:"ECD/Preschool", ecd_primary:"ECD+Primary", primary:"Primary", secondary:"Secondary", combined:"Combined" };
  const greet = parentName ? `Hi ${parentName.split(" ")[0]}! ` : "";

  // Count active custom FAQ items by category
  const custom = (school.faqItems || []).filter(f => f.active !== false);

  await sendText(from,
`🏫 *${school.schoolName}*${school.verified ? " ✅" : ""}
📍 ${school.suburb ? school.suburb + ", " : ""}${school.city}
${adm} · ${fee} · ${TYPE[school.type] || "School"} · ${cur}

${greet}Welcome! What would you like to know?`
  );

  // Categories shown as list — ≤10 items, all titles ≤20 chars
  const rows = [
    { id: `sfaq_cat_fees_${schoolId}`,    title: "💵 Fees & payments",    description: "Term fees, payment, EcoCash" },
    { id: `sfaq_cat_admissions_${schoolId}`, title: "📝 Admissions",      description: "Apply, documents, age guide" },
    { id: `sfaq_cat_academic_${schoolId}`, title: "📊 Academic & results", description: "Pass rates, subjects, ranks" },
    { id: `sfaq_cat_life_${schoolId}`,    title: "🏫 School life",         description: "Transport, facilities, sports" },
    { id: `sfaq_cat_admin_${schoolId}`,   title: "📞 Contact & docs",      description: "Staff, phone, downloads" },
  ];

  // Add custom category if school has active custom items
  if (custom.length > 0) {
    rows.push({ id: `sfaq_cat_custom_${schoolId}`, title: "❓ More Q&A", description: `${custom.length} school-specific answers` });
  }

  rows.push({ id: `sfaq_message_${schoolId}`, title: "✉️ Send a message", description: "Ask anything directly" });

  return sendList(from, "Select a topic:", rows);
}

// ─────────────────────────────────────────────────────────────────────────────
// ACTION ROUTER
// ─────────────────────────────────────────────────────────────────────────────
export async function handleSchoolFAQAction({ from, action: a, biz, saveBiz }) {
  const lastUs   = a.lastIndexOf("_");
  const schoolId = a.slice(lastUs + 1);
  const topic    = a.slice(5, lastUs); // strip "sfaq_" prefix

  if (!schoolId || schoolId.length !== 24) return false;

  // Refresh session
  await _saveSession(biz, saveBiz, biz?.sessionState || "sfaq_menu", { faqSchoolId: schoolId });

  // Custom FAQ item answer: sfaq_ans_<itemId>_<schoolId>
  if (topic.startsWith("ans_")) {
    const itemId = topic.slice(4);
    return _answerCustomItem(from, schoolId, itemId, biz, saveBiz);
  }

  // Category pages
  if (topic.startsWith("cat_")) {
    const cat = topic.slice(4);
    return _showCategory(from, schoolId, cat, 0, biz, saveBiz);
  }

  // Category pagination: sfaq_pg_<cat>_<page>_<schoolId>
  if (topic.startsWith("pg_")) {
    const parts2 = topic.split("_");
    const page   = parseInt(parts2[parts2.length - 1], 10) || 0;
    const cat    = parts2.slice(1, -1).join("_");
    return _showCategory(from, schoolId, cat, page, biz, saveBiz);
  }

  switch (topic) {
    // ── Fees sub-actions
    case "fees_pay":         return _faqFeesPayment(from, schoolId);
    case "fees_disc":        return _faqFeesDiscount(from, schoolId);
    case "fees_pdf":         return _faqFeesPDF(from, schoolId);
    case "fees_boarding":    return _faqFeesBoarding(from, schoolId);

    // ── Admissions sub-actions
    case "enroll_apply":     return _faqEnrollApply(from, schoolId, biz, saveBiz);
    case "enroll_docs":      return _faqEnrollDocs(from, schoolId);
    case "enroll_age":       return _faqEnrollAge(from, schoolId);
    case "enroll_grade":     return _faqGradeCheck(from, schoolId, biz, saveBiz);
    case "enroll_status":    return _faqAppStatus(from, schoolId, biz, saveBiz);

    // ── Academic sub-actions
    case "results_subs":     return _faqResultsSubs(from, schoolId);
    case "results_uni":      return _faqResultsUni(from, schoolId);

    // ── School life sub-actions
    case "transport_routes": return _faqTransportRoutes(from, schoolId);
    case "transport_cost":   return _faqTransportCost(from, schoolId);
    case "sports":           return _faqSports(from, schoolId);

    // ── Contact & docs sub-actions
    case "compare":          return _faqCompare(from, schoolId);
    case "bursary":          return _faqBursary(from, schoolId, biz, saveBiz);

    // ── Utility
    case "message":          return _faqMessage(from, schoolId, biz, saveBiz);
    case "back":             return showSchoolFAQMenu(from, schoolId, biz, saveBiz);
    case "tour_book":        return _faqTourBook(from, schoolId, biz, saveBiz);

    default: return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// STATE HANDLER
// ─────────────────────────────────────────────────────────────────────────────
export async function handleSchoolFAQState({ state, from, text, biz, saveBiz }) {
  if (!state?.startsWith("sfaq_")) return false;
  const schoolId = biz?.sessionData?.faqSchoolId;
  if (!schoolId) return false;

  const raw = (text || "").trim();
  if (["cancel","back","menu"].includes(raw.toLowerCase())) {
    await _saveSession(biz, saveBiz, "sfaq_menu");
    return showSchoolFAQMenu(from, schoolId, biz, saveBiz);
  }

  switch (state) {

    case "sfaq_awaiting_message": {
      if (raw.length < 3) return sendText(from, "Please type your message. Type *cancel* to go back.");
      const school = await SchoolProfile.findById(schoolId).lean();
      if (!school) return false;
      notifySchoolEnquiry(school.phone, school.schoolName, from, raw).catch(() => {});
      _lead(from, school, "enquiry", "whatsapp_link");
      SchoolProfile.findByIdAndUpdate(schoolId, { $inc: { inquiries: 1 } }).catch(() => {});
      await _saveSession(biz, saveBiz, "sfaq_menu");
      return sendButtons(from, {
        text: `✅ *Message sent to ${school.schoolName}*\n\n_"${raw}"_\n\nThey will reply on WhatsApp.\n📞 ${school.contactPhone || school.phone}`,
        buttons: [
          { id: `sfaq_cat_admissions_${schoolId}`, title: _btn("📝 Admissions") },
          { id: `sfaq_tour_book_${schoolId}`,       title: _btn("📅 Book a tour") },
          { id: `sfaq_back_${schoolId}`,             title: _btn("⬅ Main menu") }
        ]
      });
    }

    case "sfaq_awaiting_tour_date": {
      if (raw.length < 3) return sendText(from, "Please enter a date, e.g. *Monday 9am*. Type *cancel* to go back.");
      const school = await SchoolProfile.findById(schoolId).lean();
      if (!school) return false;
      const pName = biz?.sessionData?.faqParentName || "";
      notifySchoolVisitRequest(school.phone, school.schoolName, pName || from, "WhatsApp Bot").catch(() => {});
      _lead(from, school, "visit", "whatsapp_link", { parentName: pName });
      await _saveSession(biz, saveBiz, "sfaq_menu");
      return sendButtons(from, {
        text: `✅ *Tour request sent!*\n\n*${school.schoolName}*\nPreferred: _${raw}_\n\nThey will confirm + send directions.\n📞 ${school.contactPhone || school.phone}`,
        buttons: [
          { id: `sfaq_enroll_apply_${schoolId}`, title: _btn("📋 Apply now") },
          { id: `sfaq_cat_fees_${schoolId}`,      title: _btn("💵 See fees") },
          { id: `sfaq_back_${schoolId}`,           title: _btn("⬅ Main menu") }
        ]
      });
    }

    case "sfaq_awaiting_grade": {
      const school = await SchoolProfile.findById(schoolId).lean();
      if (!school) return false;
      const pName = biz?.sessionData?.faqParentName || "";
      notifySchoolPlaceEnquiry(school.phone, school.schoolName, pName || from, raw, "WhatsApp Bot").catch(() => {});
      _lead(from, school, "place", "whatsapp_link", { parentName: pName, gradeInterest: raw });
      await _saveSession(biz, saveBiz, "sfaq_menu");
      const admText = school.admissionsOpen
        ? `🟢 *Admissions OPEN.*\nYour interest in *${raw}* sent to ${school.schoolName}.`
        : `🔴 *Admissions closed.*\nYour interest in *${raw}* recorded.`;
      return sendButtons(from, {
        text: `📝 *Grade enquiry sent*\n\n${admText}`,
        buttons: [
          { id: `sfaq_enroll_apply_${schoolId}`, title: _btn("📋 Apply online") },
          { id: `sfaq_tour_book_${schoolId}`,    title: _btn("📅 Book a tour") },
          { id: `sfaq_back_${schoolId}`,          title: _btn("⬅ Main menu") }
        ]
      });
    }

    case "sfaq_awaiting_appref": {
      const school = await SchoolProfile.findById(schoolId).lean();
      if (!school) return false;
      notifySchoolEnquiry(school.phone, school.schoolName, from, `APPLICATION STATUS: "${raw}"`).catch(() => {});
      await _saveSession(biz, saveBiz, "sfaq_menu");
      return sendButtons(from, {
        text: `🔎 *Status enquiry sent*\n\nRef: _${raw}_\n\n${school.schoolName} admissions will follow up on this number.\n📞 ${school.contactPhone || school.phone}`,
        buttons: [{ id: `sfaq_back_${schoolId}`, title: _btn("⬅ Main menu") }]
      });
    }

    default: return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CATEGORY PAGES — paginated lists of FAQ items per category
// ─────────────────────────────────────────────────────────────────────────────
async function _showCategory(from, schoolId, cat, page, biz, saveBiz) {
  const school = await SchoolProfile.findById(schoolId).lean();
  if (!school) return false;

  const PAGE_SIZE = 9; // leave 1 slot for Back button

  switch (cat) {
    case "fees":       return _catFees(from, school, page, biz, saveBiz);
    case "admissions": return _catAdmissions(from, school, page, biz, saveBiz);
    case "academic":   return _catAcademic(from, school, page, biz, saveBiz);
    case "life":       return _catLife(from, school, page, biz, saveBiz);
    case "admin":      return _catAdmin(from, school, page, biz, saveBiz);
    case "custom":     return _catCustom(from, school, page, biz, saveBiz);
    default:           return showSchoolFAQMenu(from, schoolId, biz, saveBiz);
  }
}

// ── FEES CATEGORY ─────────────────────────────────────────────────────────────
async function _catFees(from, school, page, biz, saveBiz) {
  const id = String(school._id);
  const fee = _feeLabel(school);
  const rows = [
    { id: `sfaq_cat_fees_main_${id}`,      title: "💵 Term fees",              description: fee },
    { id: `sfaq_fees_pay_${id}`,           title: "💳 How to pay",             description: "EcoCash, InnBucks, bank" },
    { id: `sfaq_fees_disc_${id}`,          title: "🎁 Discounts",              description: "Sibling, bursary, aid" },
    { id: `sfaq_fees_boarding_${id}`,      title: "🏠 Boarding fees",          description: "Full boarding costs" },
    { id: `sfaq_fees_pdf_${id}`,           title: "📄 Fee schedule PDF",       description: "Download fee document" },
  ];

  // Add custom fee FAQ items from school
  const custom = _getCustomItems(school, "fees");
  custom.forEach(fq => rows.push({
    id:          `sfaq_ans_${fq.id || fq.order}_${id}`,
    title:       fq.question.slice(0, MAX_BTN),
    description: fq.answer.slice(0, 72)
  }));

  rows.push({ id: `sfaq_back_${id}`, title: "⬅ Back" });
  return sendList(from, `💵 Fees — ${school.schoolName}:`, rows.slice(0, 10));
}

async function _catFees_main(from, school) {
  return _faqFeesInline(from, String(school._id), school);
}

// ── ADMISSIONS CATEGORY ───────────────────────────────────────────────────────
async function _catAdmissions(from, school, page, biz, saveBiz) {
  const id  = String(school._id);
  const adm = school.admissionsOpen ? "🟢 Open now" : "🔴 Currently closed";
  const rows = [
    { id: `sfaq_admissions_status_${id}`,  title: "📋 Apply now",              description: adm },
    { id: `sfaq_enroll_apply_${id}`,       title: "📝 How to apply",           description: "Online form or in person" },
    { id: `sfaq_enroll_docs_${id}`,        title: "📑 Documents needed",       description: "Birth cert, ID, report" },
    { id: `sfaq_enroll_age_${id}`,         title: "🎂 Age requirements",       description: "ECD A to Form 1 ages" },
    { id: `sfaq_enroll_grade_${id}`,       title: "🎓 Grade availability",     description: "Check specific grade" },
    { id: `sfaq_tour_book_${id}`,          title: "📅 Book a school tour",     description: "Visit before enrolling" },
    { id: `sfaq_enroll_status_${id}`,      title: "🔎 Application status",     description: "Follow up your application" },
  ];

  const custom = _getCustomItems(school, "admissions");
  custom.forEach(fq => rows.push({
    id:          `sfaq_ans_${fq.id || fq.order}_${id}`,
    title:       fq.question.slice(0, MAX_BTN),
    description: fq.answer.slice(0, 72)
  }));

  rows.push({ id: `sfaq_back_${id}`, title: "⬅ Back" });
  return sendList(from, `📝 Admissions — ${school.schoolName}:`, rows.slice(0, 10));
}

// ── ACADEMIC CATEGORY ─────────────────────────────────────────────────────────
async function _catAcademic(from, school, page, biz, saveBiz) {
  const id = String(school._id);
  const r  = school.academicResults;
  const passRate = r?.oLevelPassRate ? `O-Level: ${r.oLevelPassRate}%` : "Tap for results";
  const rows = [
    { id: `sfaq_academic_results_${id}`,   title: "📊 Exam results",           description: passRate },
    { id: `sfaq_results_subs_${id}`,       title: "📘 Top subjects",           description: "Best-performing subjects" },
    { id: `sfaq_results_uni_${id}`,        title: "🎓 University placement",   description: "How many go to uni" },
    { id: `sfaq_academic_curriculum_${id}`,title: "📚 Curriculum",             description: "ZIMSEC, Cambridge, IB" },
    { id: `sfaq_academic_staff_${id}`,     title: "👩‍🏫 Teaching staff",         description: "Qualifications, ratio" },
  ];

  const custom = _getCustomItems(school, "academic");
  custom.forEach(fq => rows.push({
    id:          `sfaq_ans_${fq.id || fq.order}_${id}`,
    title:       fq.question.slice(0, MAX_BTN),
    description: fq.answer.slice(0, 72)
  }));

  rows.push({ id: `sfaq_back_${id}`, title: "⬅ Back" });
  return sendList(from, `📊 Academic — ${school.schoolName}:`, rows.slice(0, 10));
}

// ── SCHOOL LIFE CATEGORY ──────────────────────────────────────────────────────
async function _catLife(from, school, page, biz, saveBiz) {
  const id = String(school._id);
  const hasTrans = (school.facilities || []).includes("transport");
  const rows = [
    { id: `sfaq_life_transport_${id}`,     title: "🚌 Transport",              description: hasTrans ? "Routes available" : "No school bus" },
    { id: `sfaq_life_facilities_${id}`,    title: "🏊 Facilities",             description: "Labs, pool, library" },
    { id: `sfaq_sports_${id}`,             title: "⚽ Sports & clubs",         description: "Extramural activities" },
    { id: `sfaq_life_uniforms_${id}`,      title: "👕 Uniforms",               description: "List, sizes, where to buy" },
    { id: `sfaq_life_calendar_${id}`,      title: "📆 Term calendar",          description: "Terms, exams, holidays" },
    { id: `sfaq_life_feeding_${id}`,       title: "🍽️ Meals & feeding",        description: "Tuck shop, boarding meals" },
    { id: `sfaq_life_boarding_${id}`,      title: "🛏️ Boarding",               description: "Boarding rules, costs" },
  ];

  const custom = _getCustomItems(school, "life");
  custom.forEach(fq => rows.push({
    id:          `sfaq_ans_${fq.id || fq.order}_${id}`,
    title:       fq.question.slice(0, MAX_BTN),
    description: fq.answer.slice(0, 72)
  }));

  rows.push({ id: `sfaq_back_${id}`, title: "⬅ Back" });
  return sendList(from, `🏫 School life — ${school.schoolName}:`, rows.slice(0, 10));
}

// ── CONTACT & DOCS CATEGORY ───────────────────────────────────────────────────
async function _catAdmin(from, school, page, biz, saveBiz) {
  const id   = String(school._id);
  const docs = _countDocs(school);
  const rows = [
    { id: `sfaq_admin_contact_${id}`,      title: "📞 Phone & email",          description: `📞 ${school.contactPhone || school.phone}` },
    { id: `sfaq_admin_location_${id}`,     title: "📍 Location & hours",       description: school.officeHours || "Mon–Fri 7am–4pm" },
    { id: `sfaq_admin_docs_${id}`,         title: "📄 Download documents",     description: `${docs} document${docs !== 1 ? "s" : ""} available` },
    { id: `sfaq_compare_${id}`,            title: "🔍 Compare schools",        description: "See similar schools nearby" },
    { id: `sfaq_bursary_${id}`,            title: "🎓 Bursary / aid",          description: "Financial assistance" },
  ];

  const custom = _getCustomItems(school, "admin");
  custom.forEach(fq => rows.push({
    id:          `sfaq_ans_${fq.id || fq.order}_${id}`,
    title:       fq.question.slice(0, MAX_BTN),
    description: fq.answer.slice(0, 72)
  }));

  rows.push({ id: `sfaq_message_${id}`, title: "✉️ Send a message" });
  rows.push({ id: `sfaq_back_${id}`,    title: "⬅ Back" });
  return sendList(from, `📞 Contact — ${school.schoolName}:`, rows.slice(0, 10));
}

// ── CUSTOM FAQ CATEGORY ───────────────────────────────────────────────────────
async function _catCustom(from, school, page, biz, saveBiz) {
  const id     = String(school._id);
  const active = (school.faqItems || [])
    .filter(f => f.active !== false)
    .sort((a, b) => (a.order || 0) - (b.order || 0));

  if (!active.length) {
    return sendButtons(from, {
      text: `❓ No custom Q&A set up yet for ${school.schoolName}.`,
      buttons: [
        { id: `sfaq_message_${id}`, title: _btn("✉️ Send a message") },
        { id: `sfaq_back_${id}`,    title: _btn("⬅ Main menu") }
      ]
    });
  }

  const PAGE_SIZE = 9;
  const start = page * PAGE_SIZE;
  const slice = active.slice(start, start + PAGE_SIZE);
  const rows  = slice.map(fq => ({
    id:          `sfaq_ans_${fq.id || fq.order}_${id}`,
    title:       fq.question.slice(0, MAX_BTN),
    description: fq.answer.slice(0, 72)
  }));

  // Pagination
  if (start + PAGE_SIZE < active.length) {
    const nextPage = page + 1;
    rows.push({ id: `sfaq_pg_custom_${nextPage}_${id}`, title: "➡ Next page" });
  }
  if (page > 0) {
    rows.push({ id: `sfaq_pg_custom_${page - 1}_${id}`, title: "⬅ Previous" });
  }
  rows.push({ id: `sfaq_back_${id}`, title: "⬅ Main menu" });

  const total = active.length;
  const pages = Math.ceil(total / PAGE_SIZE);
  return sendList(from,
    `❓ ${school.schoolName} FAQ (${page + 1}/${pages}):`,
    rows.slice(0, 10)
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ANSWER CUSTOM ITEM — serves a school-configured Q&A item
// ─────────────────────────────────────────────────────────────────────────────
async function _answerCustomItem(from, schoolId, itemRef, biz, saveBiz) {
  const school = await SchoolProfile.findById(schoolId).lean();
  if (!school) return false;
  const id = String(school._id);

  const item = (school.faqItems || []).find(fq =>
    String(fq.id) === itemRef || String(fq.order) === itemRef
  );
  if (!item) return showSchoolFAQMenu(from, schoolId, biz, saveBiz);

  // Send PDF if attached
  if (item.pdfUrl) {
    try {
      const { sendDocument } = await import("./metaSender.js");
      await sendDocument(from, {
        link: item.pdfUrl,
        filename: (item.pdfLabel || item.question).replace(/[^a-zA-Z0-9 ]/g, "").replace(/\s+/g, "_").slice(0, 40) + ".pdf"
      });
    } catch (e) { /* fallback to text */ }
  }

  return sendButtons(from, {
    text: `❓ *${item.question}*\n\n${item.answer}`,
    buttons: [
      { id: `sfaq_cat_custom_${id}`, title: _btn("❓ More Q&A") },
      { id: `sfaq_message_${id}`,    title: _btn("✉️ Follow up") },
      { id: `sfaq_back_${id}`,       title: _btn("⬅ Main menu") }
    ]
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// INLINE CATEGORY HANDLERS — dispatched from action router
// ─────────────────────────────────────────────────────────────────────────────

// ── Fees inline answers ───────────────────────────────────────────────────────
async function _faqFeesInline(from, schoolId, school) {
  school = school || await SchoolProfile.findById(schoolId).lean();
  if (!school) return false;
  _lead(from, school, "fees", "whatsapp_link");
  const id = String(school._id);

  let text = `💵 *Fees — ${school.schoolName}*\n\n`;
  if (school.fees?.term1) {
    text += `*Day school (USD per term):*\nTerm 1: *$${school.fees.term1}*`;
    if (school.fees.term2) text += ` | T2: *$${school.fees.term2}*`;
    if (school.fees.term3) text += ` | T3: *$${school.fees.term3}*`;
    if (school.fees.devLevy)   text += `\nDev levy: $${school.fees.devLevy}/term`;
    if (school.fees.sportsFee) text += `\nSports: $${school.fees.sportsFee}/term`;
    if (school.fees.examFee)   text += `\nExam: $${school.fees.examFee}/year`;
    const t1 = Number(school.fees.term1)||0, t2 = Number(school.fees.term2)||t1, t3 = Number(school.fees.term3)||t1;
    if (t1 > 0) text += `\n\n💡 _Annual ~$${t1+t2+t3}_`;
  } else if (school.feeRange) {
    text += `Range: *${{ budget:"Under $300", mid:"$300–$800", premium:"$800+" }[school.feeRange]}/term*`;
  } else {
    text += `Contact school for fees.\n📞 ${school.contactPhone || school.phone}`;
  }

  return sendButtons(from, {
    text,
    buttons: [
      { id: `sfaq_fees_pay_${id}`,  title: _btn("💳 How to pay") },
      { id: `sfaq_fees_pdf_${id}`,  title: _btn("📄 Fee PDF") },
      { id: `sfaq_back_${id}`,      title: _btn("⬅ Main menu") }
    ]
  });
}

async function _faqFeesPayment(from, schoolId) {
  const school = await SchoolProfile.findById(schoolId).lean();
  if (!school) return false;
  const id = String(school._id);
  const methods = school.paymentMethods?.length
    ? school.paymentMethods
    : ["EcoCash", "InnBucks", "Bank transfer", "Cash at school office"];

  let text = `💳 *Payment — ${school.schoolName}*\n\n`;
  methods.forEach(m => { text += `• ${m}\n`; });
  if (school.ecocashNumber) text += `\n📲 EcoCash: *${school.ecocashNumber}*`;
  if (school.bankDetails)   text += `\n🏦 Bank: ${school.bankDetails}`;
  text += `\n\n_Use child's name + grade as reference._`;

  return sendButtons(from, {
    text,
    buttons: [
      { id: `sfaq_fees_disc_${id}`,    title: _btn("🎁 Discounts?") },
      { id: `sfaq_cat_fees_${id}`,     title: _btn("⬅ Fees menu") },
      { id: `sfaq_back_${id}`,         title: _btn("⬅ Main menu") }
    ]
  });
}

async function _faqFeesDiscount(from, schoolId) {
  const school = await SchoolProfile.findById(schoolId).lean();
  if (!school) return false;
  const id = String(school._id);
  const info = school.feeDiscounts || "Sibling discounts and bursary assistance may be available. Contact admissions.";
  return sendButtons(from, {
    text: `🎁 *Discounts — ${school.schoolName}*\n\n${info}\n\n📞 ${school.contactPhone || school.phone}`,
    buttons: [
      { id: `sfaq_bursary_${id}`,   title: _btn("🎓 Ask bursary") },
      { id: `sfaq_cat_fees_${id}`,  title: _btn("⬅ Fees menu") },
      { id: `sfaq_back_${id}`,      title: _btn("⬅ Main menu") }
    ]
  });
}

async function _faqFeesBoarding(from, schoolId) {
  const school = await SchoolProfile.findById(schoolId).lean();
  if (!school) return false;
  const id = String(school._id);
  let text = `🛏️ *Boarding fees — ${school.schoolName}*\n\n`;
  if (school.fees?.boardingTerm1 > 0) {
    text += `Term 1: *$${school.fees.boardingTerm1}*`;
    if (school.fees.boardingTerm2) text += ` | T2: *$${school.fees.boardingTerm2}*`;
    if (school.fees.boardingTerm3) text += ` | T3: *$${school.fees.boardingTerm3}*`;
    text += `\n\n_Boarding fees are inclusive of accommodation and meals._`;
  } else {
    text += `Contact the school for boarding fee information.\n📞 ${school.contactPhone || school.phone}`;
  }
  return sendButtons(from, {
    text,
    buttons: [
      { id: `sfaq_cat_fees_${id}`,  title: _btn("⬅ Fees menu") },
      { id: `sfaq_back_${id}`,      title: _btn("⬅ Main menu") }
    ]
  });
}

async function _faqFeesPDF(from, schoolId) {
  const school = await SchoolProfile.findById(schoolId).lean();
  if (!school) return false;
  const id = String(school._id);
  _lead(from, school, "pdf", "whatsapp_link");
  notifySchoolNewLead(school.phone, school.schoolName, from, "pdf", "WhatsApp Bot").catch(() => {});

  if (school.feeSchedulePdfUrl || school.profilePdfUrl) {
    try {
      const { sendDocument } = await import("./metaSender.js");
      await sendDocument(from, {
        link: school.feeSchedulePdfUrl || school.profilePdfUrl,
        filename: school.schoolName.replace(/\s+/g,"_") + "_Fees.pdf"
      });
    } catch (e) { /* fallback */ }
    return sendButtons(from, {
      text: `📄 *Fee schedule sent above.* Tap to open and save.\n\n_Forward it to family on WhatsApp._`,
      buttons: [
        { id: `sfaq_enroll_apply_${id}`, title: _btn("📋 Apply now") },
        { id: `sfaq_back_${id}`,          title: _btn("⬅ Main menu") }
      ]
    });
  }

  return sendButtons(from, {
    text: `📄 Fee schedule PDF not yet available online.\n\nContact school:\n📞 ${school.contactPhone || school.phone}`,
    buttons: [
      { id: `sfaq_admin_contact_${id}`, title: _btn("📞 Contact school") },
      { id: `sfaq_back_${id}`,           title: _btn("⬅ Main menu") }
    ]
  });
}

// ── Admissions inline answers ─────────────────────────────────────────────────
async function _faqEnrollApply(from, schoolId, biz, saveBiz) {
  const school = await SchoolProfile.findById(schoolId).lean();
  if (!school) return false;
  const id = String(school._id);
  notifySchoolApplicationInterest(school.phone, school.schoolName, from).catch(() => {});
  _lead(from, school, "apply", "whatsapp_link");

  if (school.registrationLink) {
    return sendButtons(from, {
      text: `📋 *Apply — ${school.schoolName}*\n\n${school.admissionsOpen ? "🟢 Admissions OPEN." : "🔴 Closed — register interest."}\n\nOnline form:\n👉 ${school.registrationLink}\n\n📞 ${school.contactPhone || school.phone}`,
      buttons: [
        { id: `sfaq_enroll_docs_${id}`,  title: _btn("📑 Documents") },
        { id: `sfaq_tour_book_${id}`,    title: _btn("📅 Book a tour") },
        { id: `sfaq_back_${id}`,          title: _btn("⬅ Main menu") }
      ]
    });
  }

  await _saveSession(biz, saveBiz, "sfaq_awaiting_grade", { faqSchoolId: id });
  return sendText(from, `📝 *Enrollment — ${school.schoolName}*\n\nWhich grade are you enquiring for?\n\n_e.g. "Grade 3", "Form 1", "ECD B"_\n_Type *cancel* to go back._`);
}

async function _faqEnrollDocs(from, schoolId) {
  const school = await SchoolProfile.findById(schoolId).lean();
  if (!school) return false;
  const id = String(school._id);
  const docs = school.enrollmentDocs ||
`• Child's birth certificate (certified)
• Parents' national IDs or passports
• Previous school report (latest)
• Transfer letter (if from another school)
• 4 passport photos of child
• Proof of residence (utility bill)`;

  return sendButtons(from, {
    text: `📑 *Documents — ${school.schoolName}*\n\n${docs}\n\n_Bring originals + certified copies._\n📍 ${school.address || school.city}`,
    buttons: [
      { id: `sfaq_enroll_apply_${id}`, title: _btn("📋 Apply now") },
      { id: `sfaq_enroll_age_${id}`,   title: _btn("🎂 Age guide") },
      { id: `sfaq_back_${id}`,          title: _btn("⬅ Main menu") }
    ]
  });
}

async function _faqEnrollAge(from, schoolId) {
  const school = await SchoolProfile.findById(schoolId).lean();
  if (!school) return false;
  const id = String(school._id);
  const ages = school.ageRequirements ||
`• ECD A: turning 3 by 1 March
• ECD B: turning 4 by 1 March
• Grade 1: turning 6 by 31 March
• Grade 2+: per previous school level`;
  return sendButtons(from, {
    text: `🎂 *Age requirements — ${school.schoolName}*\n\n${ages}`,
    buttons: [
      { id: `sfaq_enroll_apply_${id}`, title: _btn("📋 Apply now") },
      { id: `sfaq_enroll_docs_${id}`,  title: _btn("📑 Documents") },
      { id: `sfaq_back_${id}`,          title: _btn("⬅ Main menu") }
    ]
  });
}

async function _faqGradeCheck(from, schoolId, biz, saveBiz) {
  await _saveSession(biz, saveBiz, "sfaq_awaiting_grade", { faqSchoolId: schoolId });
  return sendText(from, `🎓 *Grade check*\n\nWhich grade?\n\n_e.g. "Grade 5", "Form 2"_\n_Type *cancel* to go back._`);
}

async function _faqAppStatus(from, schoolId, biz, saveBiz) {
  await _saveSession(biz, saveBiz, "sfaq_awaiting_appref", { faqSchoolId: schoolId });
  return sendText(from, `🔎 *Application status*\n\nType your reference number or child's name + grade:\n\n_e.g. "APP-2026-012" or "Rudo Moyo Grade 1"_\n_Type *cancel* to go back._`);
}

// ── Academic inline answers ───────────────────────────────────────────────────
async function _faqResultsSubs(from, schoolId) {
  const school = await SchoolProfile.findById(schoolId).lean();
  if (!school) return false;
  const id = String(school._id);
  const info = school.academicResults?.topSubjects || `Contact school for subject breakdown.\n📞 ${school.contactPhone || school.phone}`;
  return sendButtons(from, {
    text: `📘 *Top subjects — ${school.schoolName}*\n\n${info}`,
    buttons: [
      { id: `sfaq_cat_academic_${id}`, title: _btn("⬅ Academic menu") },
      { id: `sfaq_back_${id}`,          title: _btn("⬅ Main menu") }
    ]
  });
}

async function _faqResultsUni(from, schoolId) {
  const school = await SchoolProfile.findById(schoolId).lean();
  if (!school) return false;
  const id = String(school._id);
  const info = school.academicResults?.universityInfo || `Contact school for university placement stats.\n📞 ${school.contactPhone || school.phone}`;
  return sendButtons(from, {
    text: `🎓 *University placement — ${school.schoolName}*\n\n${info}`,
    buttons: [
      { id: `sfaq_cat_academic_${id}`, title: _btn("⬅ Academic menu") },
      { id: `sfaq_enroll_apply_${id}`, title: _btn("📋 Apply now") }
    ]
  });
}

// ── School life inline answers ─────────────────────────────────────────────────
async function _faqSports(from, schoolId) {
  const school = await SchoolProfile.findById(schoolId).lean();
  if (!school) return false;
  const id = String(school._id);
  const EXT = Object.fromEntries((SCHOOL_EXTRAMURALACTIVITIES||[]).map(e=>[e.id,e.label]));
  const list = (school.extramuralActivities||[]).map(i=>EXT[i]||i).join(", ") || `Contact school.\n📞 ${school.contactPhone || school.phone}`;
  return sendButtons(from, {
    text: `⚽ *Sports & extramural — ${school.schoolName}*\n\n${list}${school.sportsAchievements?"\n\n"+school.sportsAchievements:""}`,
    buttons: [
      { id: `sfaq_cat_life_${id}`, title: _btn("⬅ School life") },
      { id: `sfaq_back_${id}`,     title: _btn("⬅ Main menu") }
    ]
  });
}

// ── Transport inline ───────────────────────────────────────────────────────────
async function _faqTransportRoutes(from, schoolId) {
  const school = await SchoolProfile.findById(schoolId).lean();
  if (!school) return false;
  const id = String(school._id);
  const routes = school.transportRoutes || `Contact school for routes.\n📞 ${school.transportContact || school.contactPhone || school.phone}`;
  return sendButtons(from, {
    text: `🗺️ *Transport routes — ${school.schoolName}*\n\n${routes}`,
    buttons: [
      { id: `sfaq_transport_cost_${id}`, title: _btn("💵 Transport cost") },
      { id: `sfaq_message_${id}`,         title: _btn("✉️ Ask my area") },
      { id: `sfaq_back_${id}`,             title: _btn("⬅ Main menu") }
    ]
  });
}

async function _faqTransportCost(from, schoolId) {
  const school = await SchoolProfile.findById(schoolId).lean();
  if (!school) return false;
  const id = String(school._id);
  const cost = school.transportFees || `Contact school for transport pricing.\n📞 ${school.contactPhone || school.phone}`;
  return sendButtons(from, {
    text: `💵 *Transport fees — ${school.schoolName}*\n\n${cost}`,
    buttons: [
      { id: `sfaq_transport_routes_${id}`, title: _btn("🗺️ View routes") },
      { id: `sfaq_back_${id}`,              title: _btn("⬅ Main menu") }
    ]
  });
}

// ── Contact inline ─────────────────────────────────────────────────────────────
async function _faqCompare(from, schoolId) {
  const school = await SchoolProfile.findById(schoolId).lean();
  if (!school) return false;
  const id = String(school._id);
  const ranges = { budget:["budget"], mid:["budget","mid"], premium:["mid","premium"] };
  const others = await SchoolProfile.find({
    _id: { $ne: school._id }, city: school.city, active: true,
    feeRange: { $in: ranges[school.feeRange] || ["budget","mid","premium"] }
  }).limit(3).lean();

  if (!others.length) {
    return sendButtons(from, {
      text: `🔍 No similar schools found in ${school.city} on ZimQuote right now.`,
      buttons: [{ id: `sfaq_back_${id}`, title: _btn("⬅ Main menu") }]
    });
  }

  const FEE = { budget:"<$300/term", mid:"$300–800/term", premium:"$800+/term" };
  let text = `🔍 *Similar schools in ${school.city}*\n\n`;
  others.forEach((s, i) => {
    text += `*${i+1}. ${s.schoolName}*\n📍 ${s.suburb?s.suburb+", ":""}${s.city} · ${s.admissionsOpen?"🟢":"🔴"} · ${FEE[s.feeRange]||""}\n\n`;
  });

  const btns = others.slice(0, 2).map(s => ({
    id: `sfaq_cat_fees_${String(s._id)}`, title: _btn(s.schoolName.slice(0, MAX_BTN))
  }));
  btns.push({ id: `sfaq_back_${id}`, title: _btn("⬅ Main menu") });
  return sendButtons(from, { text, buttons: btns });
}

async function _faqBursary(from, schoolId, biz, saveBiz) {
  const school = await SchoolProfile.findById(schoolId).lean();
  if (!school) return false;
  const info = school.bursaryInfo || school.feeDiscounts || "Bursary and financial assistance may be available. Contact admissions confidentially.";
  await _saveSession(biz, saveBiz, "sfaq_awaiting_message", { faqSchoolId: schoolId });
  return sendText(from, `🎓 *Bursary — ${school.schoolName}*\n\n${info}\n\nDescribe your situation below and it will be sent to the school:\n\n_e.g. "Single parent, 2 children, asking about partial fee assistance for 2026"_\n_Type *cancel* to go back._`);
}

async function _faqMessage(from, schoolId, biz, saveBiz) {
  await _saveSession(biz, saveBiz, "sfaq_awaiting_message", { faqSchoolId: schoolId });
  const school = await SchoolProfile.findById(schoolId).lean();
  return sendText(from, `✉️ *Message — ${school?.schoolName || "school"}*\n\nType your question. The school will reply on WhatsApp.\n\n_Type *cancel* to go back._`);
}

async function _faqTourBook(from, schoolId, biz, saveBiz) {
  await _saveSession(biz, saveBiz, "sfaq_awaiting_tour_date", { faqSchoolId: schoolId });
  const school = await SchoolProfile.findById(schoolId).lean();
  return sendText(from, `📅 *Book a tour — ${school?.schoolName || "school"}*\n\nType your preferred date and time:\n\n_e.g. "Monday 9am", "Any weekday morning"_\n_Type *cancel* to go back._`);
}

// ─────────────────────────────────────────────────────────────────────────────
// DYNAMIC INLINE HANDLERS (called from action router by action name)
// ─────────────────────────────────────────────────────────────────────────────

// These are dispatched from the switch in handleSchoolFAQAction
// for action IDs like sfaq_cat_fees_main_<id>, sfaq_admissions_status_<id> etc.
// They're handled by the category router above. Any unmatched cat_ prefixed
// actions fall through to _showCategory which handles them.

// ─────────────────────────────────────────────────────────────────────────────
// HELPER UTILITIES
// ─────────────────────────────────────────────────────────────────────────────
function _getCustomItems(school, category) {
  return (school.faqItems || [])
    .filter(f => f.active !== false && (!f.category || f.category === category || f.category === "custom"))
    .sort((a, b) => (a.order || 0) - (b.order || 0))
    .slice(0, 3); // max 3 custom items per category (to stay under 10 total)
}

function _countDocs(school) {
  let n = 0;
  if (school.profilePdfUrl)      n++;
  if (school.feeSchedulePdfUrl)  n++;
  if (school.applicationFormUrl) n++;
  n += (school.brochures || []).length;
  return n;
}