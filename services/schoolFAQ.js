// services/schoolFAQ.js
// ─── ZimQuote School Chatbot — Full FAQ + Enrollment + Tour Booking ──────────
//
// This is the complete parent-facing chatbot for every school.
// Triggered when a parent taps the ZimQuote bot link for a specific school.
//
// Covers:
//   1. Fees & payment (per grade, boarding, ECD, payment methods, discounts)
//   2. Enrollment enquiry (grade, documents, age, waitlist, acceptance)
//   3. School tour booking (available dates, confirmation, cancellation)
//   4. Academic results (O/A-Level pass rates, subjects, university placement)
//   5. Transport (routes, suburbs served, cost, times, contacts)
//   6. Facilities & sports (full list, photos prompt, extramural)
//   7. Uniforms (list, sizes, where to buy, pricing)
//   8. Calendar (term dates, exams, open day, prize giving)
//   9. Staff & contact (principal, heads, HODs, office hours)
//  10. Admissions status (open/closed, requirements, application link)
//  11. PDF downloads (fee schedule, prospectus, application form)
//  12. Leave a message (generic typed enquiry for anything not covered)
//
// Wire in chatbotEngine.js:
//   import { handleSchoolFAQAction, handleSchoolFAQState } from "./schoolFAQ.js";
//   // In handleSchoolSearchActions, after ZQ deep-link handling:
//   if (a.startsWith("sfaq_")) return handleSchoolFAQAction({ from, action: a, biz, saveBiz });
//   // In handleSchoolAdminStates:
//   if (state?.startsWith("sfaq_")) return handleSchoolFAQState({ state, from, text, biz, saveBiz });
//
// Also wire into handleZqDeepLink: when action === "visit" or "fees" or "place",
// call _showSchoolFAQMenu() instead of a raw text message.

import SchoolProfile from "../models/schoolProfile.js";
import SchoolLead    from "../models/schoolLead.js";
import { sendText, sendButtons, sendList, sendDocument } from "./metaSender.js";
import {
  notifySchoolEnquiry,
  notifySchoolApplicationInterest,
  notifySchoolVisitRequest,
  notifySchoolPlaceEnquiry,
  notifySchoolNewLead
} from "./schoolNotifications.js";
import { SCHOOL_FACILITIES, SCHOOL_EXTRAMURALACTIVITIES } from "./schoolPlans.js";

const BOT_NUMBER = (process.env.WHATSAPP_BOT_NUMBER || "263771143904").replace(/\D/g, "");

// ─────────────────────────────────────────────────────────────────────────────
// MAIN FAQ MENU — shown when parent first arrives at a school profile
// ─────────────────────────────────────────────────────────────────────────────
export async function showSchoolFAQMenu(from, schoolId, biz, saveBiz, { source = "direct", parentName = "" } = {}) {
  const school = await SchoolProfile.findById(schoolId).lean();
  if (!school) return sendText(from, "❌ School not found. Please try again.");

  // Track this visit
  SchoolProfile.findByIdAndUpdate(schoolId, { $inc: { monthlyViews: 1, zqLinkConversions: 1 } }).catch(() => {});

  // Save a lead stub
  if (parentName || source !== "direct") {
    SchoolLead.create({
      schoolId: school._id, schoolPhone: school.phone,
      schoolName: school.schoolName, zqSlug: school.zqSlug || "",
      parentName, parentPhone: from.replace(/\D+/g, ""),
      actionType: "view", source, pageViewed: true, waOpened: true,
      nameEntered: !!parentName, contacted: false
    }).catch(() => {});
  }

  // Store school context in session so subsequent actions know which school
  if (biz) {
    biz.sessionState  = "sfaq_menu";
    biz.sessionData   = { ...(biz.sessionData || {}), faqSchoolId: schoolId, faqParentName: parentName };
    await saveBiz(biz);
  }

  const admBadge   = school.admissionsOpen ? "🟢 Admissions Open" : "🔴 Admissions Closed";
  const greeting   = parentName ? `Hi ${parentName.split(" ")[0]}! ` : "";
  const verBadge   = school.verified ? " ✅" : "";
  const feeText    = school.fees?.term1 ? `$${school.fees.term1}/term` :
    { budget:"Under $300/term", mid:"$300–$800/term", premium:"$800+/term" }[school.feeRange] || "";

  await sendText(from,
`🏫 *${school.schoolName}*${verBadge}
📍 ${school.suburb ? school.suburb + ", " : ""}${school.city}
${admBadge}${feeText ? " · " + feeText : ""}

${greeting}Welcome to ${school.schoolName} on ZimQuote. How can we help you?`
  );

  return sendList(from, "Choose a topic:", [
    { id: `sfaq_fees_${schoolId}`,        title: "💵 Fees & payments" },
    { id: `sfaq_enroll_${schoolId}`,      title: "📝 Enrollment enquiry" },
    { id: `sfaq_tour_${schoolId}`,        title: "📅 Book a school tour" },
    { id: `sfaq_results_${schoolId}`,     title: "📊 Academic results" },
    { id: `sfaq_transport_${schoolId}`,   title: "🚌 Transport & routes" },
    { id: `sfaq_facilities_${schoolId}`,  title: "🏊 Facilities & sports" },
    { id: `sfaq_uniforms_${schoolId}`,    title: "👕 Uniforms & supplies" },
    { id: `sfaq_calendar_${schoolId}`,    title: "📆 Term dates & calendar" },
    { id: `sfaq_staff_${schoolId}`,       title: "👤 Staff & contact" },
    { id: `sfaq_docs_${schoolId}`,        title: "📄 Download documents" },
    { id: `sfaq_message_${schoolId}`,     title: "✉️ Leave a message" }
  ]);
}

// ─────────────────────────────────────────────────────────────────────────────
// ACTION ROUTER — handles all sfaq_ button taps
// ─────────────────────────────────────────────────────────────────────────────
export async function handleSchoolFAQAction({ from, action: a, biz, saveBiz }) {
  // Extract schoolId from action string: sfaq_<topic>_<id>
  const parts    = a.split("_");
  const schoolId = parts[parts.length - 1];
  const topic    = parts.slice(1, -1).join("_");

  if (!schoolId || schoolId.length !== 24) return false;

  switch (topic) {
    case "fees":        return _faqFees(from, schoolId, biz, saveBiz);
    case "fees_pdf":    return _faqFeesPDF(from, schoolId);
    case "fees_pay":    return _faqFeesPayment(from, schoolId);
    case "fees_disc":   return _faqFeesDiscount(from, schoolId);
    case "fees_boarding": return _faqFeesBoarding(from, schoolId);
    case "enroll":      return _faqEnroll(from, schoolId, biz, saveBiz);
    case "enroll_apply": return _faqEnrollApply(from, schoolId, biz, saveBiz);
    case "enroll_docs": return _faqEnrollDocs(from, schoolId);
    case "enroll_age":  return _faqEnrollAge(from, schoolId);
    case "enroll_wait": return _faqEnrollWaitlist(from, schoolId, biz, saveBiz);
    case "tour":        return _faqTour(from, schoolId, biz, saveBiz);
    case "tour_confirm": return _faqTourConfirm(from, schoolId, biz, saveBiz);
    case "tour_cancel": return _faqTourCancel(from, schoolId, biz, saveBiz);
    case "results":     return _faqResults(from, schoolId);
    case "results_sub": return _faqResultsSubjects(from, schoolId);
    case "results_uni": return _faqResultsUniversity(from, schoolId);
    case "transport":   return _faqTransport(from, schoolId);
    case "transport_routes": return _faqTransportRoutes(from, schoolId);
    case "transport_cost": return _faqTransportCost(from, schoolId);
    case "facilities":  return _faqFacilities(from, schoolId);
    case "sports":      return _faqSports(from, schoolId);
    case "uniforms":    return _faqUniforms(from, schoolId);
    case "calendar":    return _faqCalendar(from, schoolId);
    case "staff":       return _faqStaff(from, schoolId);
    case "docs":        return _faqDocs(from, schoolId);
    case "message":     return _faqMessage(from, schoolId, biz, saveBiz);
    case "back":        return showSchoolFAQMenu(from, schoolId, biz, saveBiz);
    default:            return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// STATE HANDLER — handles text typed while in an sfaq_ state
// ─────────────────────────────────────────────────────────────────────────────
export async function handleSchoolFAQState({ state, from, text, biz, saveBiz }) {
  if (!state?.startsWith("sfaq_")) return false;

  const schoolId   = biz?.sessionData?.faqSchoolId;
  const parentName = biz?.sessionData?.faqParentName || "";
  if (!schoolId) return false;

  const raw = (text || "").trim();

  // ── Typed general message ──────────────────────────────────────────────────
  if (state === "sfaq_awaiting_message") {
    if (raw.toLowerCase() === "cancel") {
      if (biz) { biz.sessionState = "sfaq_menu"; await saveBiz(biz); }
      return showSchoolFAQMenu(from, schoolId, biz, saveBiz);
    }
    if (raw.length < 3) {
      return sendText(from, "❌ Please type your message (at least 3 characters). Or type *cancel* to go back.");
    }
    const school = await SchoolProfile.findById(schoolId).lean();
    if (!school) return false;
    await SchoolProfile.findByIdAndUpdate(schoolId, { $inc: { inquiries: 1 } });
    notifySchoolEnquiry(school.phone, school.schoolName, from, raw).catch(() => {});
    _saveLeadAction(from, school, "enquiry", biz?.sessionData?.faqSource || "whatsapp_link");

    if (biz) { biz.sessionState = "sfaq_menu"; await saveBiz(biz); }
    return sendButtons(from, {
      text:
`✅ *Message sent to ${school.schoolName}*

Your message:
_"${raw}"_

The school will contact you on this number shortly.
📞 ${school.contactPhone || school.phone}`,
      buttons: [
        { id: `sfaq_back_${schoolId}`,  title: "⬅ Back to Menu" },
        { id: `sfaq_enroll_${schoolId}`, title: "📝 Enrollment" }
      ]
    });
  }

  // ── Tour booking: parent typed preferred date/time ─────────────────────────
  if (state === "sfaq_awaiting_tour_date") {
    if (raw.toLowerCase() === "cancel") {
      if (biz) { biz.sessionState = "sfaq_menu"; await saveBiz(biz); }
      return showSchoolFAQMenu(from, schoolId, biz, saveBiz);
    }
    if (raw.length < 3) {
      return sendText(from, "❌ Please enter a preferred date and time, e.g. *Monday 9am* or *15 August afternoon*. Type *cancel* to go back.");
    }
    const school = await SchoolProfile.findById(schoolId).lean();
    if (!school) return false;

    const displayName = parentName || from.replace(/\D+/g, "");
    notifySchoolVisitRequest(school.phone, school.schoolName, displayName, "WhatsApp Bot").catch(() => {});
    _saveLeadAction(from, school, "visit", "whatsapp_link", { parentName });

    if (biz) { biz.sessionState = "sfaq_menu"; await saveBiz(biz); }
    return sendButtons(from, {
      text:
`✅ *School tour request sent to ${school.schoolName}!*

Preferred date: _${raw}_

The school will confirm your visit and send directions to this number.

📍 Address: ${school.address || school.suburb + ", " + school.city}
📞 Contact: ${school.contactPhone || school.phone}`,
      buttons: [
        { id: `sfaq_enroll_${schoolId}`, title: "📝 Start enrollment" },
        { id: `sfaq_fees_${schoolId}`,    title: "💵 View fees" },
        { id: `sfaq_back_${schoolId}`,    title: "⬅ Back to Menu" }
      ]
    });
  }

  // ── Enrollment: parent typed child's grade ─────────────────────────────────
  if (state === "sfaq_awaiting_grade") {
    if (raw.toLowerCase() === "cancel") {
      if (biz) { biz.sessionState = "sfaq_menu"; await saveBiz(biz); }
      return showSchoolFAQMenu(from, schoolId, biz, saveBiz);
    }
    const school = await SchoolProfile.findById(schoolId).lean();
    if (!school) return false;

    const grade = raw;
    const displayName = parentName || from.replace(/\D+/g, "");
    notifySchoolPlaceEnquiry(school.phone, school.schoolName, displayName, grade, "WhatsApp Bot").catch(() => {});
    _saveLeadAction(from, school, "place", "whatsapp_link", { parentName, gradeInterest: grade });
    await SchoolProfile.findByIdAndUpdate(schoolId, { $inc: { inquiries: 1 } });

    if (biz) { biz.sessionState = "sfaq_menu"; await saveBiz(biz); }

    const admText = school.admissionsOpen
      ? `🟢 *Admissions are currently OPEN.*\n\nThe school has been notified of your interest in ${grade}.`
      : `🔴 *Admissions are currently CLOSED.*\n\nYour interest in ${grade} has been recorded. The school will contact you when admissions re-open.`;

    return sendButtons(from, {
      text:
`📝 *Place enquiry sent — ${grade}*

${school.schoolName}
${admText}

You will be contacted on this number.`,
      buttons: [
        { id: `sfaq_enroll_apply_${schoolId}`, title: "📝 Apply online" },
        { id: `sfaq_fees_${schoolId}`,          title: "💵 View fees" },
        { id: `sfaq_tour_${schoolId}`,          title: "📅 Book a tour" },
        { id: `sfaq_back_${schoolId}`,          title: "⬅ Back to Menu" }
      ]
    });
  }

  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// FAQ SECTION HANDLERS
// ─────────────────────────────────────────────────────────────────────────────

// ── FEES ──────────────────────────────────────────────────────────────────────
async function _faqFees(from, schoolId, biz, saveBiz) {
  const school = await SchoolProfile.findById(schoolId).lean();
  if (!school) return false;
  _saveLeadAction(from, school, "fees", "whatsapp_link");

  let feesText = `💵 *Fees — ${school.schoolName}*\n\n`;

  if (school.fees?.term1) {
    feesText += `*Day school fees (USD per term):*\n`;
    if (school.fees.ecdTerm1 && school.fees.ecdTerm1 !== school.fees.term1) {
      feesText += `ECD A/B: $${school.fees.ecdTerm1} / $${school.fees.ecdTerm2} / $${school.fees.ecdTerm3}\n`;
    }
    feesText += `Term 1: $${school.fees.term1} | Term 2: $${school.fees.term2} | Term 3: $${school.fees.term3}\n`;
    if (school.fees.boardingTerm1 > 0) {
      feesText += `\n*Boarding fees:*\n$${school.fees.boardingTerm1} / $${school.fees.boardingTerm2} / $${school.fees.boardingTerm3} per term\n`;
    }
    if (school.fees.devLevy) feesText += `\nDevelopment levy: $${school.fees.devLevy}/term\n`;
    if (school.fees.sportsFee) feesText += `Sports levy: $${school.fees.sportsFee}/term\n`;
    if (school.fees.examFee) feesText += `Exam fees: $${school.fees.examFee}/year\n`;
  } else {
    const label = { budget:"Under $300/term", mid:"$300–$800/term", premium:"$800+/term" }[school.feeRange] || "Contact school for fees";
    feesText += `Fee range: *${label}*\n\nContact the school for the full fee schedule.`;
  }

  feesText += `\n\n_All fees are in USD unless stated otherwise._`;

  return sendButtons(from, {
    text: feesText,
    buttons: [
      { id: `sfaq_fees_pdf_${schoolId}`,      title: "📄 Get PDF schedule" },
      { id: `sfaq_fees_pay_${schoolId}`,      title: "💳 Payment methods" },
      { id: `sfaq_fees_disc_${schoolId}`,     title: "🎁 Discounts" },
      { id: `sfaq_back_${schoolId}`,           title: "⬅ Back to Menu" }
    ]
  });
}

async function _faqFeesPayment(from, schoolId) {
  const school = await SchoolProfile.findById(schoolId).lean();
  if (!school) return false;

  const methods = (school.paymentMethods || []).length > 0
    ? school.paymentMethods.join("\n• ")
    : "EcoCash · Bank transfer (CABS, CBZ, ZB, Steward) · Cash at school office · InnBucks";

  return sendButtons(from, {
    text:
`💳 *Payment Methods — ${school.schoolName}*

Accepted payment methods:
• ${methods}

${school.ecocashNumber ? `EcoCash number: *${school.ecocashNumber}*\n` : ""}${school.bankDetails ? `Bank: ${school.bankDetails}\n` : ""}
_Please include your child's name and grade as payment reference._
_Proof of payment should be sent to the school office._`,
    buttons: [
      { id: `sfaq_fees_${schoolId}`,  title: "⬅ Back to Fees" },
      { id: `sfaq_back_${schoolId}`,   title: "⬅ Back to Menu" }
    ]
  });
}

async function _faqFeesDiscount(from, schoolId) {
  const school = await SchoolProfile.findById(schoolId).lean();
  if (!school) return false;

  const discounts = school.feeDiscounts || "Contact the school office to enquire about sibling discounts and bursary availability.";

  return sendButtons(from, {
    text:
`🎁 *Discounts & Bursaries — ${school.schoolName}*

${discounts}

_Sibling discounts and financial assistance may be available. Contact the school directly._
📞 ${school.contactPhone || school.phone}`,
    buttons: [
      { id: `sfaq_fees_${schoolId}`,    title: "⬅ Back to Fees" },
      { id: `sfaq_message_${schoolId}`, title: "✉️ Enquire directly" }
    ]
  });
}

async function _faqFeesBoarding(from, schoolId) {
  const school = await SchoolProfile.findById(schoolId).lean();
  if (!school) return false;
  return _faqFees(from, schoolId, null, null);
}

async function _faqFeesPDF(from, schoolId) {
  const school = await SchoolProfile.findById(schoolId).lean();
  if (!school) return false;
  _saveLeadAction(from, school, "pdf", "whatsapp_link");
  notifySchoolNewLead(school.phone, school.schoolName, from.replace(/\D+/g,""), "pdf", "WhatsApp Bot").catch(() => {});

  // Try to send existing PDF
  if (school.feeSchedulePdfUrl || school.profilePdfUrl) {
    const url = school.feeSchedulePdfUrl || school.profilePdfUrl;
    try {
      const { sendDocument } = await import("./metaSender.js");
      await sendDocument(from, { link: url, filename: `${school.schoolName.replace(/\s+/g,"_")}_Fees.pdf` });
    } catch (e) { /* fallback to text */ }
  }

  return sendButtons(from, {
    text:
`📄 *Fee schedule — ${school.schoolName}*

${school.feeSchedulePdfUrl || school.profilePdfUrl
  ? "Your fee schedule has been sent above as a PDF. Tap the file to open it."
  : "The school will send you the current fee schedule directly.\n\nPlease contact them:\n📞 " + (school.contactPhone || school.phone)}`,
    buttons: [
      { id: `sfaq_enroll_${schoolId}`, title: "📝 Start enrollment" },
      { id: `sfaq_tour_${schoolId}`,    title: "📅 Book a tour" },
      { id: `sfaq_back_${schoolId}`,    title: "⬅ Back to Menu" }
    ]
  });
}

// ── ENROLLMENT ────────────────────────────────────────────────────────────────
async function _faqEnroll(from, schoolId, biz, saveBiz) {
  const school = await SchoolProfile.findById(schoolId).lean();
  if (!school) return false;

  const admText = school.admissionsOpen
    ? "🟢 *Admissions are currently OPEN.*"
    : "🔴 *Admissions are currently CLOSED* for new students.\n_You can register your interest for when admissions re-open._";

  return sendButtons(from, {
    text:
`📝 *Enrollment — ${school.schoolName}*

${admText}

What would you like to know?`,
    buttons: [
      { id: `sfaq_enroll_apply_${schoolId}`, title: "📋 Apply online" },
      { id: `sfaq_enroll_docs_${schoolId}`,  title: "📑 Required documents" },
      { id: `sfaq_enroll_age_${schoolId}`,   title: "🎂 Age requirements" },
      { id: `sfaq_enroll_wait_${schoolId}`,  title: "⏳ Waitlist / interest" },
      { id: `sfaq_back_${schoolId}`,          title: "⬅ Back to Menu" }
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

${school.admissionsOpen ? "🟢 Admissions are OPEN." : "🔴 Admissions are closed — submit an expression of interest."}

Tap the link below to complete the online application form:
👉 ${school.registrationLink}

The school will contact you to confirm receipt and next steps.
📞 ${school.contactPhone || school.phone}`,
      buttons: [
        { id: `sfaq_enroll_docs_${schoolId}`, title: "📑 Documents needed" },
        { id: `sfaq_tour_${schoolId}`,         title: "📅 Book a school tour" },
        { id: `sfaq_back_${schoolId}`,          title: "⬅ Back to Menu" }
      ]
    });
  }

  // No link — prompt grade enquiry instead
  if (biz) {
    biz.sessionState = "sfaq_awaiting_grade";
    biz.sessionData  = { ...(biz.sessionData || {}), faqSchoolId: schoolId };
    await saveBiz(biz);
  }
  return sendText(from,
`📝 *Enrollment Enquiry — ${school.schoolName}*

Which grade are you enquiring for?

_Type the grade, e.g. "Grade 3", "Form 1", "ECD B"_
_Type *cancel* to go back._`
  );
}

async function _faqEnrollDocs(from, schoolId) {
  const school = await SchoolProfile.findById(schoolId).lean();
  if (!school) return false;

  const docs = school.enrollmentDocs || `• Child's birth certificate (certified copy)
• Parents' national IDs or passports
• Previous school report (latest)
• Transfer letter (if transferring)
• 4 passport photos of child
• Proof of residence (utility bill)
${school.boarding !== "day" ? "• Medical certificate (for boarding)" : ""}`;

  return sendButtons(from, {
    text:
`📑 *Documents required for enrollment*
${school.schoolName}

${docs}

_Please bring originals and copies to the admissions office._
📍 ${school.address || school.suburb + ", " + school.city}
📞 ${school.contactPhone || school.phone}`,
    buttons: [
      { id: `sfaq_enroll_apply_${schoolId}`, title: "📋 Apply online" },
      { id: `sfaq_tour_${schoolId}`,          title: "📅 Book a tour" },
      { id: `sfaq_back_${schoolId}`,           title: "⬅ Back to Menu" }
    ]
  });
}

async function _faqEnrollAge(from, schoolId) {
  const school = await SchoolProfile.findById(schoolId).lean();
  if (!school) return false;

  const ageGuide = school.ageRequirements || `• ECD A: 3–4 years by 1 March
• ECD B: 4–5 years by 1 March
• Grade 1: turning 6 by 31 March
• Grade 2+: according to previous school level`;

  return sendButtons(from, {
    text:
`🎂 *Age requirements — ${school.schoolName}*

${ageGuide}

_Age requirements follow the Zimbabwe Ministry of Education guidelines._`,
    buttons: [
      { id: `sfaq_enroll_apply_${schoolId}`, title: "📋 Apply online" },
      { id: `sfaq_enroll_docs_${schoolId}`,  title: "📑 Documents needed" },
      { id: `sfaq_back_${schoolId}`,          title: "⬅ Back to Menu" }
    ]
  });
}

async function _faqEnrollWaitlist(from, schoolId, biz, saveBiz) {
  const school = await SchoolProfile.findById(schoolId).lean();
  if (!school) return false;

  // Register interest — notify school
  notifySchoolApplicationInterest(school.phone, school.schoolName, from).catch(() => {});
  _saveLeadAction(from, school, "apply", "whatsapp_link");

  if (biz) {
    biz.sessionState = "sfaq_awaiting_grade";
    biz.sessionData  = { ...(biz.sessionData || {}), faqSchoolId: schoolId };
    await saveBiz(biz);
  }
  return sendText(from,
`⏳ *Register your interest — ${school.schoolName}*

${school.admissionsOpen ? "Admissions are open — you can apply now." : "Admissions are currently closed, but you can register your interest."}

Which grade are you enquiring for?

_Type the grade, e.g. "Grade 3", "Form 1"_
_Type *cancel* to go back._`
  );
}

// ── SCHOOL TOUR ───────────────────────────────────────────────────────────────
async function _faqTour(from, schoolId, biz, saveBiz) {
  const school = await SchoolProfile.findById(schoolId).lean();
  if (!school) return false;

  const tourInfo = school.tourInfo ||
    "Tours are available on weekdays by appointment. Tours take approximately 45 minutes and are conducted by a member of staff.";

  return sendButtons(from, {
    text:
`📅 *Book a school tour — ${school.schoolName}*

${tourInfo}

📍 ${school.address || school.suburb + ", " + school.city}
📞 ${school.contactPhone || school.phone}

What would you like to do?`,
    buttons: [
      { id: `sfaq_tour_confirm_${schoolId}`, title: "✅ Book a tour now" },
      { id: `sfaq_staff_${schoolId}`,         title: "📞 Contact admissions" },
      { id: `sfaq_back_${schoolId}`,           title: "⬅ Back to Menu" }
    ]
  });
}

async function _faqTourConfirm(from, schoolId, biz, saveBiz) {
  if (biz) {
    biz.sessionState = "sfaq_awaiting_tour_date";
    biz.sessionData  = { ...(biz.sessionData || {}), faqSchoolId: schoolId };
    await saveBiz(biz);
  }
  return sendText(from,
`📅 *School tour booking*

Please type your preferred date and time for the school tour.

Examples:
• _"Monday 9am"_
• _"Any weekday morning"_
• _"15 August at 10am"_
• _"This Saturday if possible"_

Type *cancel* to go back.`
  );
}

async function _faqTourCancel(from, schoolId, biz, saveBiz) {
  if (biz) { biz.sessionState = "sfaq_menu"; await saveBiz(biz); }
  return showSchoolFAQMenu(from, schoolId, biz, saveBiz);
}

// ── ACADEMIC RESULTS ──────────────────────────────────────────────────────────
async function _faqResults(from, schoolId) {
  const school = await SchoolProfile.findById(schoolId).lean();
  if (!school) return false;

  const results = school.academicResults;
  let resultsText = `📊 *Academic Results — ${school.schoolName}*\n\n`;

  if (results?.oLevelPassRate) {
    resultsText += `*ZIMSEC O-Level:*\n`;
    resultsText += `Pass rate: *${results.oLevelPassRate}%* (${results.oLevelYear || "latest"})\n`;
    if (results.oLevel5Plus) resultsText += `5+ subjects: *${results.oLevel5Plus}%*\n`;
  }
  if (results?.aLevelPassRate) {
    resultsText += `\n*A-Level:*\n`;
    resultsText += `Pass rate: *${results.aLevelPassRate}%* (${results.aLevelYear || "latest"})\n`;
    if (results.universityEntry) resultsText += `University entry: *${results.universityEntry}%*\n`;
  }
  if (results?.cambridgePassRate) {
    resultsText += `\n*Cambridge IGCSE:*\n`;
    resultsText += `Pass rate: *${results.cambridgePassRate}%*\n`;
  }
  if (results?.nationalRanking) {
    resultsText += `\n🏆 National ranking: *#${results.nationalRanking}*\n`;
  }
  if (results?.harareRanking) {
    resultsText += `Harare ranking: *#${results.harareRanking}*\n`;
  }
  if (!results?.oLevelPassRate && !results?.aLevelPassRate) {
    resultsText += `Contact the school for academic results information.\n📞 ${school.contactPhone || school.phone}`;
  }

  return sendButtons(from, {
    text: resultsText,
    buttons: [
      { id: `sfaq_results_sub_${schoolId}`,  title: "📘 Top subjects" },
      { id: `sfaq_results_uni_${schoolId}`,  title: "🎓 University placement" },
      { id: `sfaq_enroll_${schoolId}`,        title: "📝 Enroll now" },
      { id: `sfaq_back_${schoolId}`,           title: "⬅ Back to Menu" }
    ]
  });
}

async function _faqResultsSubjects(from, schoolId) {
  const school = await SchoolProfile.findById(schoolId).lean();
  if (!school) return false;

  const subjects = school.academicResults?.topSubjects ||
    "Contact the school for a subject performance breakdown.";

  return sendButtons(from, {
    text: `📘 *Top-performing subjects — ${school.schoolName}*\n\n${subjects}`,
    buttons: [
      { id: `sfaq_results_${schoolId}`, title: "⬅ Back to Results" },
      { id: `sfaq_back_${schoolId}`,     title: "⬅ Back to Menu" }
    ]
  });
}

async function _faqResultsUniversity(from, schoolId) {
  const school = await SchoolProfile.findById(schoolId).lean();
  if (!school) return false;

  const uniInfo = school.academicResults?.universityInfo ||
    "Contact the school for university placement statistics.";

  return sendButtons(from, {
    text: `🎓 *University placement — ${school.schoolName}*\n\n${uniInfo}`,
    buttons: [
      { id: `sfaq_results_${schoolId}`, title: "⬅ Back to Results" },
      { id: `sfaq_enroll_${schoolId}`,   title: "📝 Enroll now" }
    ]
  });
}

// ── TRANSPORT ─────────────────────────────────────────────────────────────────
async function _faqTransport(from, schoolId) {
  const school = await SchoolProfile.findById(schoolId).lean();
  if (!school) return false;

  const hasTransport = (school.facilities || []).includes("transport");

  if (!hasTransport) {
    return sendButtons(from, {
      text:
`🚌 *Transport — ${school.schoolName}*

This school does not operate a school bus service.

Parents are responsible for own transport.
📍 ${school.address || school.suburb + ", " + school.city}`,
      buttons: [
        { id: `sfaq_back_${schoolId}`, title: "⬅ Back to Menu" }
      ]
    });
  }

  return sendButtons(from, {
    text:
`🚌 *Transport — ${school.schoolName}*

${school.transportInfo || "School transport is available. Contact the school for routes and costs."}

📞 Transport enquiries: ${school.transportContact || school.contactPhone || school.phone}`,
    buttons: [
      { id: `sfaq_transport_routes_${schoolId}`, title: "🗺️ Routes & suburbs" },
      { id: `sfaq_transport_cost_${schoolId}`,   title: "💵 Transport fees" },
      { id: `sfaq_back_${schoolId}`,              title: "⬅ Back to Menu" }
    ]
  });
}

async function _faqTransportRoutes(from, schoolId) {
  const school = await SchoolProfile.findById(schoolId).lean();
  if (!school) return false;

  const routes = school.transportRoutes ||
    "Contact the school transport office for route information.\n📞 " + (school.transportContact || school.contactPhone || school.phone);

  return sendButtons(from, {
    text: `🗺️ *Transport routes — ${school.schoolName}*\n\n${routes}`,
    buttons: [
      { id: `sfaq_transport_cost_${schoolId}`, title: "💵 Transport costs" },
      { id: `sfaq_message_${schoolId}`,         title: "✉️ Enquire about my area" },
      { id: `sfaq_back_${schoolId}`,             title: "⬅ Back to Menu" }
    ]
  });
}

async function _faqTransportCost(from, schoolId) {
  const school = await SchoolProfile.findById(schoolId).lean();
  if (!school) return false;

  const cost = school.transportFees ||
    "Contact the school for transport pricing.\n📞 " + (school.contactPhone || school.phone);

  return sendButtons(from, {
    text: `💵 *Transport fees — ${school.schoolName}*\n\n${cost}`,
    buttons: [
      { id: `sfaq_transport_routes_${schoolId}`, title: "🗺️ View routes" },
      { id: `sfaq_back_${schoolId}`,              title: "⬅ Back to Menu" }
    ]
  });
}

// ── FACILITIES ────────────────────────────────────────────────────────────────
async function _faqFacilities(from, schoolId) {
  const school = await SchoolProfile.findById(schoolId).lean();
  if (!school) return false;

  const facList = (school.facilities || [])
    .map(id => SCHOOL_FACILITIES.find(f => f.id === id)?.label || id)
    .join("\n") || "Contact school for facilities information.";

  return sendButtons(from, {
    text:
`🏊 *Facilities — ${school.schoolName}*

${facList}`,
    buttons: [
      { id: `sfaq_sports_${schoolId}`,  title: "⚽ Sports & clubs" },
      { id: `sfaq_tour_${schoolId}`,     title: "📅 Book a tour to see" },
      { id: `sfaq_back_${schoolId}`,     title: "⬅ Back to Menu" }
    ]
  });
}

async function _faqSports(from, schoolId) {
  const school = await SchoolProfile.findById(schoolId).lean();
  if (!school) return false;

  const EXTRACURR = Object.fromEntries((SCHOOL_EXTRAMURALACTIVITIES || []).map(e => [e.id, e.label]));
  const sportsList = (school.extramuralActivities || [])
    .map(id => EXTRACURR[id] || id)
    .join(", ") || "Contact school for extramural activities information.";

  return sendButtons(from, {
    text:
`⚽ *Sports & Extramural — ${school.schoolName}*

${sportsList}

${school.sportsAchievements || ""}`,
    buttons: [
      { id: `sfaq_facilities_${schoolId}`, title: "🏊 Facilities" },
      { id: `sfaq_back_${schoolId}`,        title: "⬅ Back to Menu" }
    ]
  });
}

// ── UNIFORMS ──────────────────────────────────────────────────────────────────
async function _faqUniforms(from, schoolId) {
  const school = await SchoolProfile.findById(schoolId).lean();
  if (!school) return false;

  const info = school.uniformInfo ||
    `The school uniform must be purchased from the school tuck shop or approved supplier.\nContact the school for the full uniform list and pricing.\n📞 ${school.contactPhone || school.phone}`;

  return sendButtons(from, {
    text: `👕 *Uniforms & supplies — ${school.schoolName}*\n\n${info}`,
    buttons: [
      { id: `sfaq_fees_${schoolId}`,    title: "💵 View school fees" },
      { id: `sfaq_enroll_${schoolId}`,  title: "📝 Enrollment" },
      { id: `sfaq_back_${schoolId}`,    title: "⬅ Back to Menu" }
    ]
  });
}

// ── CALENDAR ──────────────────────────────────────────────────────────────────
async function _faqCalendar(from, schoolId) {
  const school = await SchoolProfile.findById(schoolId).lean();
  if (!school) return false;

  const calendar = school.termCalendar ||
    `Contact the school for the full term calendar.\n📞 ${school.contactPhone || school.phone}`;

  return sendButtons(from, {
    text: `📆 *Term calendar — ${school.schoolName}*\n\n${calendar}`,
    buttons: [
      { id: `sfaq_enroll_${schoolId}`,  title: "📝 Enrollment" },
      { id: `sfaq_tour_${schoolId}`,     title: "📅 Book a tour" },
      { id: `sfaq_back_${schoolId}`,     title: "⬅ Back to Menu" }
    ]
  });
}

// ── STAFF & CONTACT ───────────────────────────────────────────────────────────
async function _faqStaff(from, schoolId) {
  const school = await SchoolProfile.findById(schoolId).lean();
  if (!school) return false;

  let staffText = `👤 *Staff & Contact — ${school.schoolName}*\n\n`;
  if (school.principalName) staffText += `Principal: *${school.principalName}*\n`;
  if (school.deputyName)    staffText += `Deputy Principal: *${school.deputyName}*\n`;
  staffText += `\n📞 School office: *${school.contactPhone || school.phone}*\n`;
  if (school.email)    staffText += `📧 Email: *${school.email}*\n`;
  if (school.website)  staffText += `🌐 Website: ${school.website}\n`;
  if (school.address)  staffText += `\n📍 Address: ${school.address}\n`;
  staffText += `\n🕐 Office hours: ${school.officeHours || "Monday–Friday, 7am–4pm"}`;

  return sendButtons(from, {
    text: staffText,
    buttons: [
      { id: `sfaq_message_${schoolId}`, title: "✉️ Send a message" },
      { id: `sfaq_tour_${schoolId}`,     title: "📅 Book a tour" },
      { id: `sfaq_back_${schoolId}`,     title: "⬅ Back to Menu" }
    ]
  });
}

// ── DOCUMENTS ─────────────────────────────────────────────────────────────────
async function _faqDocs(from, schoolId) {
  const school = await SchoolProfile.findById(schoolId).lean();
  if (!school) return false;

  const docs = [];
  if (school.profilePdfUrl)     docs.push({ label: `${school.schoolName} Profile / Prospectus`, url: school.profilePdfUrl });
  if (school.feeSchedulePdfUrl) docs.push({ label: "Fee Schedule", url: school.feeSchedulePdfUrl });
  if (school.applicationFormUrl) docs.push({ label: "Application Form", url: school.applicationFormUrl });
  for (const b of (school.brochures || [])) docs.push(b);

  if (!docs.length) {
    return sendButtons(from, {
      text:
`📄 *Documents — ${school.schoolName}*

Documents are not yet uploaded for this school.

Contact the school directly:
📞 ${school.contactPhone || school.phone}
${school.email ? "📧 " + school.email : ""}`,
      buttons: [
        { id: `sfaq_message_${schoolId}`, title: "✉️ Request documents" },
        { id: `sfaq_back_${schoolId}`,     title: "⬅ Back to Menu" }
      ]
    });
  }

  _saveLeadAction(from, school, "pdf", "whatsapp_link");
  const { sendDocument } = await import("./metaSender.js");
  let sentCount = 0;
  for (const doc of docs) {
    try {
      const fname = doc.label.replace(/[^a-zA-Z0-9 _-]/g, "").replace(/\s+/g, "_") + ".pdf";
      await sendDocument(from, { link: doc.url, filename: fname });
      sentCount++;
    } catch (e) { /* ignore */ }
  }

  return sendButtons(from, {
    text:
`📄 *Documents — ${school.schoolName}*

${sentCount > 0
  ? `${sentCount} document${sentCount > 1 ? "s" : ""} sent above. Tap to open each file.`
  : "Documents available:\n" + docs.map(d => `• ${d.label}: ${d.url}`).join("\n")}`,
    buttons: [
      { id: `sfaq_enroll_apply_${schoolId}`, title: "📋 Apply online" },
      { id: `sfaq_back_${schoolId}`,          title: "⬅ Back to Menu" }
    ]
  });
}

// ── LEAVE A MESSAGE ───────────────────────────────────────────────────────────
async function _faqMessage(from, schoolId, biz, saveBiz) {
  if (biz) {
    biz.sessionState = "sfaq_awaiting_message";
    biz.sessionData  = { ...(biz.sessionData || {}), faqSchoolId: schoolId };
    await saveBiz(biz);
  }
  const school = await SchoolProfile.findById(schoolId).lean();
  const name   = school ? school.schoolName : "the school";
  return sendText(from,
`✉️ *Send a message to ${name}*

Type your question or message below. The school will reply to you directly on WhatsApp.

_Type *cancel* to go back._`
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// PRIVATE HELPERS
// ─────────────────────────────────────────────────────────────────────────────
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