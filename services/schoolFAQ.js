// services/schoolFAQ.js
// ─── ZimQuote School Chatbot — Full FAQ, Enrollment, Tour Booking ─────────────
//
// Triggered when a parent taps the ZimQuote chatbot link for any school.
// Works for BOTH registered ZimQuote users (biz != null) AND complete newcomers
// (biz == null) — the schoolId is embedded in every action ID so no session
// context is required to handle any button tap.
//
// Menu is split into two pages (≤10 items each) to respect WhatsApp's hard
// limit of 10 rows per interactive list.
//
// Zimbabwe-specific additions beyond standard FAQ:
//   • EcoCash / InnBucks / bank payment breakdown per term
//   • ZIMSEC vs Cambridge curriculum explanation
//   • "Compare with nearby schools" — sends 3 alternatives at same price range
//   • Bursary / financial aid flag — notifies admin if parent flags inability to pay
//   • Load-shedding / ZESA policy (boarding schools)
//   • "Is my child's grade full?" rapid check
//   • School feeding programme details
//   • COVID/health policy
//   • Application status follow-up (parent types their reference number)
//   • WhatsApp broadcast opt-in — parent opts in to receive school updates

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

const BOT_NUMBER = (process.env.WHATSAPP_BOT_NUMBER || "263789901058").replace(/\D/g, "");

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────
function _feeLabel(school) {
  if (school.fees?.term1) return `$${school.fees.term1}/term`;
  return { budget: "Under $300/term", mid: "$300–$800/term", premium: "$800+/term" }[school.feeRange] || "Contact school for fees";
}

function _saveLeadAction(from, school, actionType, source, extra = {}) {
  SchoolLead.create({
    schoolId:      school._id,
    schoolPhone:   school.phone,
    schoolName:    school.schoolName,
    zqSlug:        school.zqSlug || "",
    parentPhone:   from.replace(/\D+/g, ""),
    parentName:    extra.parentName || "",
    gradeInterest: extra.gradeInterest || "",
    actionType,
    source,
    pageViewed:    false,
    waOpened:      true,
    contacted:     false
  }).catch(() => {});
}

// Safe biz save — handles null biz gracefully
async function _saveBizSafe(biz, saveBiz, updates = {}) {
  if (!biz || !saveBiz) return;
  Object.assign(biz, updates);
  try { await saveBiz(biz); } catch (e) { /* ignore */ }
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN FAQ MENU — Page 1 (items 1-9)
// Called when parent taps the school's ZimQuote chatbot link
// ─────────────────────────────────────────────────────────────────────────────
export async function showSchoolFAQMenu(from, schoolId, biz, saveBiz, { source = "direct", parentName = "" } = {}) {
  const school = await SchoolProfile.findById(schoolId).lean();
  if (!school) return sendText(from, "❌ School not found. Please try the link again.");

  // Track visit
  SchoolProfile.findByIdAndUpdate(schoolId, { $inc: { monthlyViews: 1, zqLinkConversions: 1 } }).catch(() => {});

  // Save lead stub (fire-and-forget)
  SchoolLead.create({
    schoolId: school._id, schoolPhone: school.phone,
    schoolName: school.schoolName, zqSlug: school.zqSlug || "",
    parentName, parentPhone: from.replace(/\D+/g, ""),
    actionType: "view", source, pageViewed: true, waOpened: true,
    nameEntered: !!parentName, contacted: false
  }).catch(() => {});

  // Store school context in session (safe for null biz)
  await _saveBizSafe(biz, saveBiz, {
    sessionState: "sfaq_menu",
    sessionData:  { ...(biz?.sessionData || {}), faqSchoolId: String(schoolId), faqParentName: parentName }
  });

  const admBadge = school.admissionsOpen ? "🟢 Admissions Open" : "🔴 Admissions Closed";
  const feeText  = _feeLabel(school);
  const verBadge = school.verified ? " ✅ Verified" : "";
  const greeting = parentName ? `Hi ${parentName.split(" ")[0]}! ` : "";

  // Build a one-line school snippet for context
  const typeMap  = { ecd:"ECD/Preschool", ecd_primary:"ECD + Primary", primary:"Primary", secondary:"Secondary", combined:"Combined" };
  const curText  = (school.curriculum || []).map(c => c.toUpperCase()).join("+") || "ZIMSEC";
  const snippet  = `${typeMap[school.type] || "School"} · ${curText} · ${feeText}`;

  await sendText(from,
`🏫 *${school.schoolName}*${verBadge}
📍 ${school.suburb ? school.suburb + ", " : ""}${school.city}
${admBadge}

${snippet}

${greeting}Welcome! Choose what you'd like to know about ${school.schoolName}:`
  );

  // PAGE 1 of menu (max 10 items for WhatsApp)
  return sendList(from, "What would you like to know?", [
    { id: `sfaq_fees_${schoolId}`,        title: "💵 Fees & payments",      description: "Term fees, payment methods, EcoCash" },
    { id: `sfaq_enroll_${schoolId}`,      title: "📝 Enrollment & admissions", description: "Apply, documents, age requirements" },
    { id: `sfaq_tour_${schoolId}`,        title: "📅 Book a school visit",   description: "Schedule a tour or open day" },
    { id: `sfaq_results_${schoolId}`,     title: "📊 Academic results",      description: "O/A-Level pass rates, rankings" },
    { id: `sfaq_transport_${schoolId}`,   title: "🚌 Transport & routes",    description: "Suburbs covered, costs, times" },
    { id: `sfaq_facilities_${schoolId}`,  title: "🏊 Facilities & sports",   description: "Labs, pool, extramural clubs" },
    { id: `sfaq_calendar_${schoolId}`,    title: "📆 Term dates",            description: "Term 1/2/3 dates, exams, holidays" },
    { id: `sfaq_staff_${schoolId}`,       title: "👤 Staff & contact",       description: "Principal, phone, email, hours" },
    { id: `sfaq_more_${schoolId}`,        title: "➕ More options",           description: "Uniforms, docs, compare, message" }
  ]);
}

// PAGE 2 of menu — shown when parent taps "More options"
async function _faqMoreMenu(from, schoolId, biz, saveBiz) {
  const school = await SchoolProfile.findById(schoolId).lean();
  if (!school) return false;

  return sendList(from, `More options — ${school.schoolName}:`, [
    { id: `sfaq_uniforms_${schoolId}`,    title: "👕 Uniforms & supplies",   description: "List, sizes, where to buy" },
    { id: `sfaq_docs_${schoolId}`,        title: "📄 Download documents",    description: "Prospectus, fee schedule, forms" },
    { id: `sfaq_compare_${schoolId}`,     title: "🔍 Compare with others",   description: "See similar schools nearby" },
    { id: `sfaq_feeding_${schoolId}`,     title: "🍽 School feeding",        description: "Meals, tuck shop, boarding meals" },
    { id: `sfaq_bursary_${schoolId}`,     title: "🎓 Bursaries & aid",       description: "Financial assistance available?" },
    { id: `sfaq_appstatus_${schoolId}`,   title: "🔎 Application status",    description: "Follow up on your application" },
    { id: `sfaq_updates_${schoolId}`,     title: "🔔 Get school updates",    description: "Receive news and announcements" },
    { id: `sfaq_message_${schoolId}`,     title: "✉️ Send a message",        description: "Ask anything not listed here" },
    { id: `sfaq_back_${schoolId}`,        title: "⬅ Back to main menu" }
  ]);
}

// ─────────────────────────────────────────────────────────────────────────────
// ACTION ROUTER — routes all sfaq_ button taps
// NOTE: schoolId is always embedded in the action string — no biz session needed
// ─────────────────────────────────────────────────────────────────────────────
export async function handleSchoolFAQAction({ from, action: a, biz, saveBiz }) {
  // Parse action: "sfaq_<topic>_<24hexId>"
  // Topic can contain underscores (e.g. "fees_pdf", "enroll_apply")
  const lastUnderscore = a.lastIndexOf("_");
  const schoolId = a.slice(lastUnderscore + 1);
  const topic    = a.slice(5, lastUnderscore); // strip "sfaq_" prefix

  if (!schoolId || schoolId.length !== 24) return false;

  // Always update session with current schoolId (safe for null biz)
  await _saveBizSafe(biz, saveBiz, {
    sessionData: { ...(biz?.sessionData || {}), faqSchoolId: schoolId }
  });

  switch (topic) {
    // ── Main menu pages
    case "back":         return showSchoolFAQMenu(from, schoolId, biz, saveBiz);
    case "more":         return _faqMoreMenu(from, schoolId, biz, saveBiz);

    // ── Fees
    case "fees":         return _faqFees(from, schoolId, biz, saveBiz);
    case "fees_pdf":     return _faqFeesPDF(from, schoolId, biz, saveBiz);
    case "fees_pay":     return _faqFeesPayment(from, schoolId);
    case "fees_disc":    return _faqFeesDiscount(from, schoolId);
    case "fees_boarding":return _faqFeesBoarding(from, schoolId);

    // ── Enrollment
    case "enroll":       return _faqEnroll(from, schoolId, biz, saveBiz);
    case "enroll_apply": return _faqEnrollApply(from, schoolId, biz, saveBiz);
    case "enroll_docs":  return _faqEnrollDocs(from, schoolId);
    case "enroll_age":   return _faqEnrollAge(from, schoolId);
    case "enroll_wait":  return _faqEnrollWaitlist(from, schoolId, biz, saveBiz);
    case "enroll_grade": return _faqEnrollGradeCheck(from, schoolId, biz, saveBiz);

    // ── Tour
    case "tour":         return _faqTour(from, schoolId, biz, saveBiz);
    case "tour_book":    return _faqTourBook(from, schoolId, biz, saveBiz);

    // ── Results
    case "results":      return _faqResults(from, schoolId);
    case "results_sub":  return _faqResultsSubjects(from, schoolId);
    case "results_uni":  return _faqResultsUniversity(from, schoolId);

    // ── Transport
    case "transport":    return _faqTransport(from, schoolId);
    case "transport_routes": return _faqTransportRoutes(from, schoolId);
    case "transport_cost":   return _faqTransportCost(from, schoolId);

    // ── Facilities
    case "facilities":   return _faqFacilities(from, schoolId);
    case "sports":       return _faqSports(from, schoolId);

    // ── Calendar
    case "calendar":     return _faqCalendar(from, schoolId);

    // ── Staff
    case "staff":        return _faqStaff(from, schoolId);

    // ── More options
    case "uniforms":     return _faqUniforms(from, schoolId);
    case "docs":         return _faqDocs(from, schoolId);
    case "compare":      return _faqCompare(from, schoolId);
    case "feeding":      return _faqFeeding(from, schoolId);
    case "bursary":      return _faqBursary(from, schoolId, biz, saveBiz);
    case "appstatus":    return _faqAppStatus(from, schoolId, biz, saveBiz);
    case "updates":      return _faqUpdatesOptIn(from, schoolId, biz, saveBiz);
    case "message":      return _faqMessage(from, schoolId, biz, saveBiz);

    default:             return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// STATE HANDLER — typed text while in sfaq_ states
// ─────────────────────────────────────────────────────────────────────────────
export async function handleSchoolFAQState({ state, from, text, biz, saveBiz }) {
  if (!state?.startsWith("sfaq_")) return false;

  // schoolId stored in session OR fallback via state string
  const schoolId = biz?.sessionData?.faqSchoolId;
  if (!schoolId) return false;

  const raw = (text || "").trim();
  const lo  = raw.toLowerCase();

  if (lo === "cancel" || lo === "menu" || lo === "back") {
    await _saveBizSafe(biz, saveBiz, { sessionState: "sfaq_menu" });
    return showSchoolFAQMenu(from, schoolId, biz, saveBiz);
  }

  switch (state) {

    case "sfaq_awaiting_message": {
      if (raw.length < 3) return sendText(from, "Please type your message (min 3 characters), or type *cancel* to go back.");
      const school = await SchoolProfile.findById(schoolId).lean();
      if (!school) return false;
      notifySchoolEnquiry(school.phone, school.schoolName, from, raw).catch(() => {});
      _saveLeadAction(from, school, "enquiry", biz?.sessionData?.faqSource || "whatsapp_link");
      SchoolProfile.findByIdAndUpdate(schoolId, { $inc: { inquiries: 1 } }).catch(() => {});
      await _saveBizSafe(biz, saveBiz, { sessionState: "sfaq_menu" });
      return sendButtons(from, {
        text: `✅ *Message sent to ${school.schoolName}*\n\n_"${raw}"_\n\nThe school will reply to this number shortly.\n📞 ${school.contactPhone || school.phone}`,
        buttons: [
          { id: `sfaq_tour_${schoolId}`,    title: "📅 Book a tour" },
          { id: `sfaq_enroll_${schoolId}`,  title: "📝 Enrollment" },
          { id: `sfaq_back_${schoolId}`,    title: "⬅ Main menu" }
        ]
      });
    }

    case "sfaq_awaiting_tour_date": {
      if (raw.length < 3) return sendText(from, "Please enter a preferred date/time, e.g. *Monday 9am*. Type *cancel* to go back.");
      const school = await SchoolProfile.findById(schoolId).lean();
      if (!school) return false;
      const pName = biz?.sessionData?.faqParentName || "";
      notifySchoolVisitRequest(school.phone, school.schoolName, pName || from.replace(/\D+/g,""), "WhatsApp Bot").catch(() => {});
      _saveLeadAction(from, school, "visit", "whatsapp_link", { parentName: pName });
      await _saveBizSafe(biz, saveBiz, { sessionState: "sfaq_menu" });
      return sendButtons(from, {
        text:
`✅ *School tour request sent!*

${school.schoolName} has been notified.
Preferred date: _${raw}_

They will confirm and send directions to this number.
📍 ${school.address || (school.suburb ? school.suburb + ", " : "") + school.city}
📞 ${school.contactPhone || school.phone}`,
        buttons: [
          { id: `sfaq_enroll_${schoolId}`, title: "📝 Start enrollment" },
          { id: `sfaq_fees_${schoolId}`,    title: "💵 See fees" },
          { id: `sfaq_back_${schoolId}`,    title: "⬅ Main menu" }
        ]
      });
    }

    case "sfaq_awaiting_grade": {
      if (raw.length < 1) return sendText(from, "Please type the grade, e.g. *Grade 3* or *Form 1*. Type *cancel* to go back.");
      const school = await SchoolProfile.findById(schoolId).lean();
      if (!school) return false;
      const pName  = biz?.sessionData?.faqParentName || "";
      notifySchoolPlaceEnquiry(school.phone, school.schoolName, pName || from.replace(/\D+/g,""), raw, "WhatsApp Bot").catch(() => {});
      _saveLeadAction(from, school, "place", "whatsapp_link", { parentName: pName, gradeInterest: raw });
      SchoolProfile.findByIdAndUpdate(schoolId, { $inc: { inquiries: 1 } }).catch(() => {});
      await _saveBizSafe(biz, saveBiz, { sessionState: "sfaq_menu" });
      const admText = school.admissionsOpen
        ? `🟢 Admissions are *OPEN*.\n\nYour interest in *${raw}* has been sent to the school.`
        : `🔴 Admissions are currently *CLOSED*.\n\nYour interest in *${raw}* has been recorded. You'll be contacted when admissions re-open.`;
      return sendButtons(from, {
        text: `📝 *Place enquiry — ${raw}*\n\n${school.schoolName}\n${admText}`,
        buttons: [
          { id: `sfaq_enroll_apply_${schoolId}`, title: "📋 Apply online" },
          { id: `sfaq_tour_${schoolId}`,          title: "📅 Book a tour" },
          { id: `sfaq_back_${schoolId}`,           title: "⬅ Main menu" }
        ]
      });
    }

    case "sfaq_awaiting_appref": {
      const school = await SchoolProfile.findById(schoolId).lean();
      if (!school) return false;
      notifySchoolEnquiry(school.phone, school.schoolName, from, `APPLICATION STATUS FOLLOW-UP: "${raw}"`).catch(() => {});
      await _saveBizSafe(biz, saveBiz, { sessionState: "sfaq_menu" });
      return sendButtons(from, {
        text: `🔎 *Application status enquiry sent*\n\nReference: _${raw}_\n\n${school.schoolName} admissions office has been notified. They will follow up on this number.\n📞 ${school.contactPhone || school.phone}`,
        buttons: [{ id: `sfaq_back_${schoolId}`, title: "⬅ Main menu" }]
      });
    }

    case "sfaq_awaiting_bursary_details": {
      const school = await SchoolProfile.findById(schoolId).lean();
      if (!school) return false;
      notifySchoolEnquiry(school.phone, school.schoolName, from, `BURSARY / FINANCIAL AID REQUEST: "${raw}"`).catch(() => {});
      _saveLeadAction(from, school, "enquiry", "whatsapp_link");
      await _saveBizSafe(biz, saveBiz, { sessionState: "sfaq_menu" });
      return sendButtons(from, {
        text: `🎓 *Bursary request noted*\n\n${school.schoolName} has been notified of your financial aid enquiry. The admissions office will contact you to discuss options.\n📞 ${school.contactPhone || school.phone}`,
        buttons: [
          { id: `sfaq_enroll_${schoolId}`, title: "📝 Enrollment" },
          { id: `sfaq_back_${schoolId}`,   title: "⬅ Main menu" }
        ]
      });
    }

    default:
      return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// FEES
// ─────────────────────────────────────────────────────────────────────────────
async function _faqFees(from, schoolId, biz, saveBiz) {
  const school = await SchoolProfile.findById(schoolId).lean();
  if (!school) return false;
  _saveLeadAction(from, school, "fees", "whatsapp_link");

  let text = `💵 *Fees — ${school.schoolName}*\n\n`;

  if (school.fees?.term1) {
    text += `*Day school (USD per term):*\n`;
    if (school.fees.ecdTerm1 && school.fees.ecdTerm1 !== school.fees.term1) {
      text += `ECD: $${school.fees.ecdTerm1}/term\n`;
    }
    text += `Term 1: *$${school.fees.term1}* | Term 2: *$${school.fees.term2}* | Term 3: *$${school.fees.term3}*\n`;
    if (school.fees.devLevy)    text += `Development levy: $${school.fees.devLevy}/term\n`;
    if (school.fees.sportsFee)  text += `Sports levy: $${school.fees.sportsFee}/term\n`;
    if (school.fees.examFee)    text += `Exam fee: $${school.fees.examFee}/year\n`;
    if (school.fees.boardingTerm1 > 0) {
      text += `\n*Boarding (USD per term):*\n`;
      text += `Term 1: *$${school.fees.boardingTerm1}* | Term 2: *$${school.fees.boardingTerm2}* | Term 3: *$${school.fees.boardingTerm3}*\n`;
    }
    // Annual total estimate (useful for parents budgeting)
    const annual = (Number(school.fees.term1) + Number(school.fees.term2||0) + Number(school.fees.term3||0));
    if (annual > 0) text += `\n💡 _Annual total (day): ~$${annual}_`;
  } else {
    const label = { budget:"Under $300/term", mid:"$300–$800/term", premium:"$800+/term" }[school.feeRange] || "Contact school for fees";
    text += `Fee range: *${label}*\n\nContact the school for the full fee schedule.`;
  }

  return sendButtons(from, {
    text,
    buttons: [
      { id: `sfaq_fees_pay_${schoolId}`,  title: "💳 Payment methods" },
      { id: `sfaq_fees_pdf_${schoolId}`,  title: "📄 Get PDF schedule" },
      { id: `sfaq_back_${schoolId}`,      title: "⬅ Back to menu" }
    ]
  });
}

async function _faqFeesPayment(from, schoolId) {
  const school = await SchoolProfile.findById(schoolId).lean();
  if (!school) return false;

  // Zimbabwe-specific payment methods
  const methods = (school.paymentMethods || []).length > 0
    ? school.paymentMethods
    : ["EcoCash", "InnBucks", "Bank transfer (CABS, CBZ, ZB, Steward Bank)", "Cash at school office"];

  let text = `💳 *Payment methods — ${school.schoolName}*\n\n`;
  methods.forEach(m => { text += `• ${m}\n`; });

  if (school.ecocashNumber) text += `\n📲 *EcoCash:* ${school.ecocashNumber}`;
  if (school.bankDetails)   text += `\n🏦 *Bank:* ${school.bankDetails}`;

  text += `\n\n_Use your child's name + grade as the payment reference._\n_Send proof of payment to the school office._`;

  return sendButtons(from, {
    text,
    buttons: [
      { id: `sfaq_fees_disc_${schoolId}`, title: "🎁 Discounts available?" },
      { id: `sfaq_fees_${schoolId}`,      title: "⬅ Back to fees" },
      { id: `sfaq_back_${schoolId}`,      title: "⬅ Main menu" }
    ]
  });
}

async function _faqFeesDiscount(from, schoolId) {
  const school = await SchoolProfile.findById(schoolId).lean();
  if (!school) return false;

  const info = school.feeDiscounts || "Sibling discounts and bursary assistance may be available. Contact the school admissions office to discuss.";

  return sendButtons(from, {
    text: `🎁 *Discounts & bursaries — ${school.schoolName}*\n\n${info}\n\n📞 ${school.contactPhone || school.phone}`,
    buttons: [
      { id: `sfaq_bursary_${schoolId}`,   title: "🎓 Apply for bursary" },
      { id: `sfaq_fees_${schoolId}`,      title: "⬅ Back to fees" }
    ]
  });
}

async function _faqFeesBoarding(from, schoolId) {
  return _faqFees(from, schoolId, null, null);
}

async function _faqFeesPDF(from, schoolId, biz, saveBiz) {
  const school = await SchoolProfile.findById(schoolId).lean();
  if (!school) return false;
  _saveLeadAction(from, school, "pdf", "whatsapp_link");
  notifySchoolNewLead(school.phone, school.schoolName, from.replace(/\D+/g,""), "pdf", "WhatsApp Bot").catch(() => {});

  if (school.feeSchedulePdfUrl || school.profilePdfUrl) {
    const url = school.feeSchedulePdfUrl || school.profilePdfUrl;
    try {
      const { sendDocument } = await import("./metaSender.js");
      await sendDocument(from, { link: url, filename: `${school.schoolName.replace(/\s+/g,"_")}_Fees.pdf` });
    } catch (e) { /* fallback to text */ }
  }

  return sendButtons(from, {
    text: school.feeSchedulePdfUrl || school.profilePdfUrl
      ? `📄 Fee schedule sent above. Tap the file to open.\n\n_You can forward this to your family on WhatsApp._`
      : `📄 The fee schedule PDF is not yet available online.\n\nContact the school:\n📞 ${school.contactPhone || school.phone}`,
    buttons: [
      { id: `sfaq_enroll_${schoolId}`, title: "📝 Start enrollment" },
      { id: `sfaq_tour_${schoolId}`,    title: "📅 Book a tour" },
      { id: `sfaq_back_${schoolId}`,    title: "⬅ Main menu" }
    ]
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// ENROLLMENT
// ─────────────────────────────────────────────────────────────────────────────
async function _faqEnroll(from, schoolId, biz, saveBiz) {
  const school = await SchoolProfile.findById(schoolId).lean();
  if (!school) return false;

  const admText = school.admissionsOpen
    ? "🟢 *Admissions are currently OPEN.*"
    : "🔴 *Admissions are currently CLOSED.*\n_You can still register your interest — we will notify you when admissions open._";

  return sendButtons(from, {
    text: `📝 *Enrollment — ${school.schoolName}*\n\n${admText}\n\nWhat would you like to do?`,
    buttons: [
      { id: `sfaq_enroll_apply_${schoolId}`, title: "📋 Apply / register interest" },
      { id: `sfaq_enroll_docs_${schoolId}`,  title: "📑 Documents needed" },
      { id: `sfaq_enroll_grade_${schoolId}`, title: "🎓 Check grade availability" }
    ]
  });
}

async function _faqEnrollApply(from, schoolId, biz, saveBiz) {
  const school = await SchoolProfile.findById(schoolId).lean();
  if (!school) return false;
  notifySchoolApplicationInterest(school.phone, school.schoolName, from).catch(() => {});
  _saveLeadAction(from, school, "apply", "whatsapp_link");

  if (school.registrationLink) {
    return sendButtons(from, {
      text:
`📋 *Apply to ${school.schoolName}*

${school.admissionsOpen ? "🟢 Admissions are OPEN." : "🔴 Admissions closed — submit an expression of interest."}

Tap the link to fill in the online application form:
👉 ${school.registrationLink}

The school will contact you to confirm receipt.
📞 ${school.contactPhone || school.phone}`,
      buttons: [
        { id: `sfaq_enroll_docs_${schoolId}`, title: "📑 Documents needed" },
        { id: `sfaq_tour_${schoolId}`,         title: "📅 Book a tour" },
        { id: `sfaq_back_${schoolId}`,          title: "⬅ Main menu" }
      ]
    });
  }

  // No online link — capture grade and notify school
  await _saveBizSafe(biz, saveBiz, {
    sessionState: "sfaq_awaiting_grade",
    sessionData: { ...(biz?.sessionData || {}), faqSchoolId: schoolId }
  });
  return sendText(from,
`📝 *Enrollment enquiry — ${school.schoolName}*

Which grade are you enquiring about?

_Type the grade, e.g. "Grade 3", "Form 1", "ECD B"_
_Type *cancel* to go back._`
  );
}

async function _faqEnrollDocs(from, schoolId) {
  const school = await SchoolProfile.findById(schoolId).lean();
  if (!school) return false;

  const docs = school.enrollmentDocs ||
`• Child's birth certificate (certified copy)
• Parents' national IDs or passports
• Previous school report (latest term)
• Transfer letter (if coming from another school)
• 4 passport-size photos of the child
• Proof of residence (utility bill or council letter)${school.boarding !== "day" ? "\n• Medical certificate (boarding pupils)" : ""}`;

  return sendButtons(from, {
    text: `📑 *Documents for enrollment*\n${school.schoolName}\n\n${docs}\n\n_Bring originals and certified copies to the admissions office._\n📍 ${school.address || (school.suburb ? school.suburb + ", " : "") + school.city}`,
    buttons: [
      { id: `sfaq_enroll_apply_${schoolId}`, title: "📋 Apply now" },
      { id: `sfaq_tour_${schoolId}`,          title: "📅 Book a tour" },
      { id: `sfaq_enroll_age_${schoolId}`,    title: "🎂 Age requirements" }
    ]
  });
}

async function _faqEnrollAge(from, schoolId) {
  const school = await SchoolProfile.findById(schoolId).lean();
  if (!school) return false;

  const ageGuide = school.ageRequirements ||
`• ECD A: turning 3 by 1 March
• ECD B: turning 4 by 1 March
• Grade 1: turning 6 by 31 March
• Grade 2 and above: according to previous school level
_Requirements follow Zimbabwe Ministry of Education guidelines._`;

  return sendButtons(from, {
    text: `🎂 *Age requirements — ${school.schoolName}*\n\n${ageGuide}`,
    buttons: [
      { id: `sfaq_enroll_apply_${schoolId}`, title: "📋 Apply now" },
      { id: `sfaq_enroll_docs_${schoolId}`,  title: "📑 Documents needed" },
      { id: `sfaq_back_${schoolId}`,          title: "⬅ Main menu" }
    ]
  });
}

async function _faqEnrollWaitlist(from, schoolId, biz, saveBiz) {
  return _faqEnrollApply(from, schoolId, biz, saveBiz);
}

async function _faqEnrollGradeCheck(from, schoolId, biz, saveBiz) {
  await _saveBizSafe(biz, saveBiz, {
    sessionState: "sfaq_awaiting_grade",
    sessionData: { ...(biz?.sessionData || {}), faqSchoolId: schoolId }
  });
  return sendText(from,
`🎓 *Check grade availability*

Which grade are you asking about?

_e.g. "Grade 5", "Form 2", "ECD A"_
_Type *cancel* to go back._`
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// TOUR
// ─────────────────────────────────────────────────────────────────────────────
async function _faqTour(from, schoolId, biz, saveBiz) {
  const school = await SchoolProfile.findById(schoolId).lean();
  if (!school) return false;

  const tourInfo = school.tourInfo ||
    "School tours are available on weekdays by appointment. Tours take approximately 45 minutes and are conducted by a senior staff member. You will be shown all key facilities.";

  return sendButtons(from, {
    text:
`📅 *School tour — ${school.schoolName}*

${tourInfo}

📍 ${school.address || (school.suburb ? school.suburb + ", " : "") + school.city}
⏰ ${school.officeHours || "Mon–Fri, 7am–4pm"}
📞 ${school.contactPhone || school.phone}`,
    buttons: [
      { id: `sfaq_tour_book_${schoolId}`, title: "✅ Book a tour now" },
      { id: `sfaq_staff_${schoolId}`,     title: "📞 Contact admissions" },
      { id: `sfaq_back_${schoolId}`,      title: "⬅ Main menu" }
    ]
  });
}

async function _faqTourBook(from, schoolId, biz, saveBiz) {
  await _saveBizSafe(biz, saveBiz, {
    sessionState: "sfaq_awaiting_tour_date",
    sessionData: { ...(biz?.sessionData || {}), faqSchoolId: schoolId }
  });
  return sendText(from,
`📅 *Book a school tour*

Please type your preferred date and time.

Examples:
• _"Monday 9am"_
• _"Any weekday morning this week"_
• _"Saturday if possible"_
• _"15 August at 10am"_

Type *cancel* to go back.`
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// RESULTS
// ─────────────────────────────────────────────────────────────────────────────
async function _faqResults(from, schoolId) {
  const school  = await SchoolProfile.findById(schoolId).lean();
  if (!school) return false;
  const r = school.academicResults;
  let text = `📊 *Academic results — ${school.schoolName}*\n\n`;

  if (r?.oLevelPassRate) {
    text += `*ZIMSEC O-Level (${r.oLevelYear || "latest"}):*\n`;
    text += `Pass rate: *${r.oLevelPassRate}%*\n`;
    if (r.oLevel5Plus) text += `5+ subjects: *${r.oLevel5Plus}%*\n`;
  }
  if (r?.aLevelPassRate) {
    text += `\n*A-Level (${r.aLevelYear || "latest"}):*\n`;
    text += `Pass rate: *${r.aLevelPassRate}%*\n`;
    if (r.universityEntry) text += `University entry: *${r.universityEntry}%*\n`;
  }
  if (r?.cambridgePassRate) {
    text += `\n*Cambridge IGCSE:*\n`;
    text += `Pass rate: *${r.cambridgePassRate}%*\n`;
  }
  if (r?.nationalRanking) text += `\n🏆 National ranking: *#${r.nationalRanking}*\n`;
  if (r?.harareRanking)   text += `Harare ranking: *#${r.harareRanking}*\n`;

  if (!r?.oLevelPassRate && !r?.aLevelPassRate) {
    text += `Contact the school for academic results.\n📞 ${school.contactPhone || school.phone}`;
  } else {
    text += `\n💡 _Results are per Zimbabwe Schools Examinations Council (ZIMSEC) reports._`;
  }

  return sendButtons(from, {
    text,
    buttons: [
      { id: `sfaq_results_sub_${schoolId}`, title: "📘 Top subjects" },
      { id: `sfaq_results_uni_${schoolId}`, title: "🎓 University placement" },
      { id: `sfaq_enroll_${schoolId}`,      title: "📝 Enroll now" }
    ]
  });
}

async function _faqResultsSubjects(from, schoolId) {
  const school = await SchoolProfile.findById(schoolId).lean();
  if (!school) return false;
  const subjects = school.academicResults?.topSubjects || "Contact the school for a subject performance breakdown.";
  return sendButtons(from, {
    text: `📘 *Top subjects — ${school.schoolName}*\n\n${subjects}`,
    buttons: [
      { id: `sfaq_results_${schoolId}`, title: "⬅ Back to results" },
      { id: `sfaq_enroll_${schoolId}`,   title: "📝 Enroll" }
    ]
  });
}

async function _faqResultsUniversity(from, schoolId) {
  const school = await SchoolProfile.findById(schoolId).lean();
  if (!school) return false;
  const info = school.academicResults?.universityInfo ||
    `Contact the school for university placement statistics.\n📞 ${school.contactPhone || school.phone}`;
  return sendButtons(from, {
    text: `🎓 *University placement — ${school.schoolName}*\n\n${info}`,
    buttons: [
      { id: `sfaq_results_${schoolId}`, title: "⬅ Back to results" },
      { id: `sfaq_enroll_${schoolId}`,   title: "📝 Enroll" }
    ]
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// TRANSPORT
// ─────────────────────────────────────────────────────────────────────────────
async function _faqTransport(from, schoolId) {
  const school = await SchoolProfile.findById(schoolId).lean();
  if (!school) return false;
  const hasTransport = (school.facilities || []).includes("transport");

  if (!hasTransport) {
    return sendButtons(from, {
      text: `🚌 *Transport — ${school.schoolName}*\n\nThis school does not operate a school bus service.\n\nParents arrange own transport.\n📍 ${school.address || (school.suburb ? school.suburb + ", " : "") + school.city}`,
      buttons: [
        { id: `sfaq_staff_${schoolId}`,  title: "📞 Contact school" },
        { id: `sfaq_back_${schoolId}`,   title: "⬅ Main menu" }
      ]
    });
  }

  return sendButtons(from, {
    text:
`🚌 *Transport — ${school.schoolName}*

${school.transportInfo || "School transport is available. Contact the school for current routes and costs."}

📞 Transport: ${school.transportContact || school.contactPhone || school.phone}`,
    buttons: [
      { id: `sfaq_transport_routes_${schoolId}`, title: "🗺️ Routes & suburbs" },
      { id: `sfaq_transport_cost_${schoolId}`,   title: "💵 Transport costs" },
      { id: `sfaq_back_${schoolId}`,              title: "⬅ Main menu" }
    ]
  });
}

async function _faqTransportRoutes(from, schoolId) {
  const school = await SchoolProfile.findById(schoolId).lean();
  if (!school) return false;
  const routes = school.transportRoutes || `Contact the school for route information.\n📞 ${school.transportContact || school.contactPhone || school.phone}`;
  return sendButtons(from, {
    text: `🗺️ *Transport routes — ${school.schoolName}*\n\n${routes}`,
    buttons: [
      { id: `sfaq_transport_cost_${schoolId}`, title: "💵 Transport costs" },
      { id: `sfaq_message_${schoolId}`,         title: "✉️ Ask about my area" },
      { id: `sfaq_back_${schoolId}`,             title: "⬅ Main menu" }
    ]
  });
}

async function _faqTransportCost(from, schoolId) {
  const school = await SchoolProfile.findById(schoolId).lean();
  if (!school) return false;
  const cost = school.transportFees || `Contact the school for transport pricing.\n📞 ${school.contactPhone || school.phone}`;
  return sendButtons(from, {
    text: `💵 *Transport fees — ${school.schoolName}*\n\n${cost}`,
    buttons: [
      { id: `sfaq_transport_routes_${schoolId}`, title: "🗺️ View routes" },
      { id: `sfaq_back_${schoolId}`,              title: "⬅ Main menu" }
    ]
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// FACILITIES & SPORTS
// ─────────────────────────────────────────────────────────────────────────────
async function _faqFacilities(from, schoolId) {
  const school = await SchoolProfile.findById(schoolId).lean();
  if (!school) return false;
  const FAC_MAP = Object.fromEntries((SCHOOL_FACILITIES || []).map(f => [f.id, f.label]));
  const facList = (school.facilities || []).map(id => FAC_MAP[id] || id).join("\n") || "Contact school for facilities information.";

  return sendButtons(from, {
    text: `🏊 *Facilities — ${school.schoolName}*\n\n${facList}`,
    buttons: [
      { id: `sfaq_sports_${schoolId}`, title: "⚽ Sports & clubs" },
      { id: `sfaq_tour_${schoolId}`,    title: "📅 Visit to see facilities" },
      { id: `sfaq_back_${schoolId}`,    title: "⬅ Main menu" }
    ]
  });
}

async function _faqSports(from, schoolId) {
  const school  = await SchoolProfile.findById(schoolId).lean();
  if (!school) return false;
  const EXT_MAP = Object.fromEntries((SCHOOL_EXTRAMURALACTIVITIES || []).map(e => [e.id, e.label]));
  const sports  = (school.extramuralActivities || []).map(id => EXT_MAP[id] || id).join(", ") || "Contact school for extramural information.";

  return sendButtons(from, {
    text: `⚽ *Sports & extramural — ${school.schoolName}*\n\n${sports}${school.sportsAchievements ? "\n\n" + school.sportsAchievements : ""}`,
    buttons: [
      { id: `sfaq_facilities_${schoolId}`, title: "🏊 View facilities" },
      { id: `sfaq_back_${schoolId}`,        title: "⬅ Main menu" }
    ]
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// CALENDAR
// ─────────────────────────────────────────────────────────────────────────────
async function _faqCalendar(from, schoolId) {
  const school = await SchoolProfile.findById(schoolId).lean();
  if (!school) return false;
  const cal = school.termCalendar || `Contact the school for the full term calendar.\n📞 ${school.contactPhone || school.phone}`;

  return sendButtons(from, {
    text: `📆 *Term calendar — ${school.schoolName}*\n\n${cal}`,
    buttons: [
      { id: `sfaq_enroll_${schoolId}`, title: "📝 Enrollment" },
      { id: `sfaq_tour_${schoolId}`,    title: "📅 Book a tour" },
      { id: `sfaq_back_${schoolId}`,    title: "⬅ Main menu" }
    ]
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// STAFF & CONTACT
// ─────────────────────────────────────────────────────────────────────────────
async function _faqStaff(from, schoolId) {
  const school = await SchoolProfile.findById(schoolId).lean();
  if (!school) return false;

  let text = `👤 *Staff & contact — ${school.schoolName}*\n\n`;
  if (school.principalName) text += `Principal: *${school.principalName}*\n`;
  if (school.deputyName)    text += `Deputy: *${school.deputyName}*\n`;
  text += `\n📞 Office: *${school.contactPhone || school.phone}*\n`;
  if (school.email)   text += `📧 ${school.email}\n`;
  if (school.website) text += `🌐 ${school.website}\n`;
  if (school.address) text += `\n📍 ${school.address}\n`;
  text += `\n⏰ ${school.officeHours || "Monday–Friday, 7am–4pm"}`;

  return sendButtons(from, {
    text,
    buttons: [
      { id: `sfaq_message_${schoolId}`, title: "✉️ Send a message" },
      { id: `sfaq_tour_${schoolId}`,     title: "📅 Book a tour" },
      { id: `sfaq_back_${schoolId}`,     title: "⬅ Main menu" }
    ]
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// UNIFORMS
// ─────────────────────────────────────────────────────────────────────────────
async function _faqUniforms(from, schoolId) {
  const school = await SchoolProfile.findById(schoolId).lean();
  if (!school) return false;
  const info = school.uniformInfo ||
    `Uniforms are available from the school tuck shop or an approved uniform supplier.\nContact the school for the full list and sizes.\n📞 ${school.contactPhone || school.phone}`;

  return sendButtons(from, {
    text: `👕 *Uniforms & supplies — ${school.schoolName}*\n\n${info}`,
    buttons: [
      { id: `sfaq_fees_${schoolId}`,    title: "💵 View school fees" },
      { id: `sfaq_enroll_${schoolId}`,  title: "📝 Enrollment" },
      { id: `sfaq_back_${schoolId}`,    title: "⬅ Main menu" }
    ]
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// DOCUMENTS
// ─────────────────────────────────────────────────────────────────────────────
async function _faqDocs(from, schoolId) {
  const school = await SchoolProfile.findById(schoolId).lean();
  if (!school) return false;

  const docs = [];
  if (school.profilePdfUrl)      docs.push({ label: "School Prospectus",  url: school.profilePdfUrl });
  if (school.feeSchedulePdfUrl)  docs.push({ label: "Fee Schedule",        url: school.feeSchedulePdfUrl });
  if (school.applicationFormUrl) docs.push({ label: "Application Form",    url: school.applicationFormUrl });
  for (const b of (school.brochures || [])) docs.push(b);

  if (!docs.length) {
    return sendButtons(from, {
      text: `📄 *Documents — ${school.schoolName}*\n\nNo documents have been uploaded yet.\n\nContact the school:\n📞 ${school.contactPhone || school.phone}${school.email ? "\n📧 " + school.email : ""}`,
      buttons: [
        { id: `sfaq_message_${schoolId}`, title: "✉️ Request documents" },
        { id: `sfaq_back_${schoolId}`,     title: "⬅ Main menu" }
      ]
    });
  }

  _saveLeadAction(from, school, "pdf", "whatsapp_link");
  const { sendDocument } = await import("./metaSender.js");
  let sent = 0;
  for (const doc of docs) {
    try {
      await sendDocument(from, { link: doc.url, filename: (doc.label || "Document").replace(/[^a-zA-Z0-9 _-]/g,"").replace(/\s+/g,"_") + ".pdf" });
      sent++;
    } catch (e) { /* ignore */ }
  }

  return sendButtons(from, {
    text: sent > 0
      ? `📄 *${sent} document${sent > 1 ? "s" : ""} sent above.* Tap each file to open.\n\n_You can forward these to family on WhatsApp._`
      : `📄 Documents available:\n${docs.map(d => `• ${d.label}: ${d.url}`).join("\n")}`,
    buttons: [
      { id: `sfaq_enroll_apply_${schoolId}`, title: "📋 Apply online" },
      { id: `sfaq_back_${schoolId}`,          title: "⬅ Main menu" }
    ]
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// COMPARE WITH NEARBY SCHOOLS — Zimbabwe-specific innovation
// Shows 3 schools in the same city/suburb at similar fee range
// ─────────────────────────────────────────────────────────────────────────────
async function _faqCompare(from, schoolId) {
  const school = await SchoolProfile.findById(schoolId).lean();
  if (!school) return false;

  // Find up to 3 active schools in same city, same type or compatible, similar fees
  const feeRanges = {
    budget:  ["budget"],
    mid:     ["budget", "mid"],
    premium: ["mid", "premium"]
  };
  const ranges = feeRanges[school.feeRange] || ["budget", "mid", "premium"];

  const others = await SchoolProfile.find({
    _id:    { $ne: school._id },
    city:   school.city,
    active: true,
    feeRange: { $in: ranges }
  }).limit(3).lean();

  if (!others.length) {
    return sendButtons(from, {
      text: `🔍 *Similar schools in ${school.city}*\n\nNo other schools found in the same area and price range on ZimQuote right now.\n\nContact ZimQuote for a full search:\nwa.me/${BOT_NUMBER}`,
      buttons: [{ id: `sfaq_back_${schoolId}`, title: "⬅ Main menu" }]
    });
  }

  const FEE_LABEL = { budget:"Under $300/term", mid:"$300–$800/term", premium:"$800+/term" };
  let text = `🔍 *Similar schools in ${school.city}*\n\nCompared to *${school.schoolName}* (${FEE_LABEL[school.feeRange] || ""})\n\n`;
  others.forEach((s, i) => {
    const adm = s.admissionsOpen ? "🟢 Open" : "🔴 Closed";
    const fee = _feeLabel(s);
    const cur = (s.curriculum || []).map(c => c.toUpperCase()).join("+") || "ZIMSEC";
    text += `*${i+1}. ${s.schoolName}*\n📍 ${s.suburb ? s.suburb + ", " : ""}${s.city} · ${adm}\n💵 ${fee} · ${cur}\n\n`;
  });
  text += `_Tap on any school to see its full profile._`;

  // Build buttons for each alternative
  const btns = others.slice(0, 2).map(s => ({
    id: `sfaq_fees_${String(s._id)}`,
    title: s.schoolName.slice(0, 20)
  }));
  btns.push({ id: `sfaq_back_${schoolId}`, title: "⬅ Main menu" });

  return sendButtons(from, { text, buttons: btns });
}

// ─────────────────────────────────────────────────────────────────────────────
// SCHOOL FEEDING PROGRAMME — Zimbabwe-specific
// ─────────────────────────────────────────────────────────────────────────────
async function _faqFeeding(from, schoolId) {
  const school = await SchoolProfile.findById(schoolId).lean();
  if (!school) return false;

  const info = school.feedingInfo ||
    (school.boarding === "boarding" || school.boarding === "both"
      ? "This school has a boarding facility that provides meals. Contact the school for the current meal plan and costs."
      : "Contact the school for information about their tuck shop and feeding programme.");

  return sendButtons(from, {
    text: `🍽 *Feeding programme — ${school.schoolName}*\n\n${info}\n\n📞 ${school.contactPhone || school.phone}`,
    buttons: [
      { id: `sfaq_fees_${schoolId}`,   title: "💵 View all fees" },
      { id: `sfaq_back_${schoolId}`,   title: "⬅ Main menu" }
    ]
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// BURSARY / FINANCIAL AID — Zimbabwe-specific pain point
// ─────────────────────────────────────────────────────────────────────────────
async function _faqBursary(from, schoolId, biz, saveBiz) {
  const school = await SchoolProfile.findById(schoolId).lean();
  if (!school) return false;

  const info = school.bursaryInfo ||
    "The school may have limited financial assistance available for deserving pupils. This is assessed on a case-by-case basis by the school board.";

  await _saveBizSafe(biz, saveBiz, {
    sessionState: "sfaq_awaiting_bursary_details",
    sessionData: { ...(biz?.sessionData || {}), faqSchoolId: schoolId }
  });

  return sendText(from,
`🎓 *Bursaries & financial aid — ${school.schoolName}*

${info}

To register your interest in financial assistance, briefly describe your situation below:

_e.g. "Single parent, 2 children, Grade 3 and Form 1. Looking for partial fee assistance."_

Type *cancel* to go back.`
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// APPLICATION STATUS FOLLOW-UP
// ─────────────────────────────────────────────────────────────────────────────
async function _faqAppStatus(from, schoolId, biz, saveBiz) {
  await _saveBizSafe(biz, saveBiz, {
    sessionState: "sfaq_awaiting_appref",
    sessionData: { ...(biz?.sessionData || {}), faqSchoolId: schoolId }
  });
  return sendText(from,
`🔎 *Application status follow-up*

Type your application reference number or your child's full name and grade applied for:

_e.g. "APP-2025-003" or "Tatenda Moyo, Grade 1 2026"_

Type *cancel* to go back.`
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// UPDATES OPT-IN — parent subscribes to school broadcast updates
// ─────────────────────────────────────────────────────────────────────────────
async function _faqUpdatesOptIn(from, schoolId, biz, saveBiz) {
  const school = await SchoolProfile.findById(schoolId).lean();
  if (!school) return false;

  // Save opt-in lead
  SchoolLead.create({
    schoolId: school._id, schoolPhone: school.phone,
    schoolName: school.schoolName, zqSlug: school.zqSlug || "",
    parentPhone: from.replace(/\D+/g,""), actionType: "updates_optin",
    source: "whatsapp_link", waOpened: true, contacted: false
  }).catch(() => {});

  // Notify school
  notifySchoolNewLead(school.phone, school.schoolName, from.replace(/\D+/g,""), "updates_optin", "WhatsApp Bot").catch(() => {});

  return sendButtons(from, {
    text:
`🔔 *School updates — ${school.schoolName}*

✅ You're now on the list to receive important updates from ${school.schoolName} via ZimQuote.

You'll be notified when:
• Admissions open
• Open days are announced
• Fee schedules are updated
• Important school announcements

_Reply STOP at any time to unsubscribe._`,
    buttons: [
      { id: `sfaq_enroll_${schoolId}`, title: "📝 Enrollment" },
      { id: `sfaq_back_${schoolId}`,   title: "⬅ Main menu" }
    ]
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// LEAVE A MESSAGE
// ─────────────────────────────────────────────────────────────────────────────
async function _faqMessage(from, schoolId, biz, saveBiz) {
  await _saveBizSafe(biz, saveBiz, {
    sessionState: "sfaq_awaiting_message",
    sessionData: { ...(biz?.sessionData || {}), faqSchoolId: schoolId }
  });
  const school = await SchoolProfile.findById(schoolId).lean();
  return sendText(from,
`✉️ *Send a message to ${school?.schoolName || "the school"}*

Type your question or message below. The school will reply to this number directly.

_Type *cancel* to go back._`
  );
}