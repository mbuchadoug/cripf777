// services/schoolFAQ.js
// ─── ZimQuote School Chatbot — Preloaded FAQ with Custom Questions ────────────
//
// HOW IT WORKS:
//   1. Parent taps school's ZimQuote chatbot link → showSchoolFAQMenu()
//   2. Bot shows 9 topic buttons (WhatsApp max 10 per list)
//   3. Parent taps a topic → gets PRELOADED ANSWER from school's profile data
//   4. If school has added custom FAQ items (school.faqItems[]), those appear too
//   5. Schools can add/edit/delete their own Q&A pairs via bot menu (school admin)
//
// NULL-SAFE: Works for first-time users with no biz session.
// schoolId is embedded in every action ID so no session context is ever required
// to deliver an answer.
//
// SchoolProfile fields used (add to schema if not present):
//   faqItems: [{ question: String, answer: String, order: Number }]
//   All other fields (fees, termCalendar, etc.) already exist.

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
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────
function _feeLabel(school) {
  if (school.fees?.term1) return `$${school.fees.term1}/term`;
  return { budget: "Under $300/term", mid: "$300–$800/term", premium: "$800+/term" }[school.feeRange] || "Contact school";
}

// Null-safe session save — never crashes when biz is null
async function _saveSession(biz, saveBiz, state, extraData = {}) {
  if (!biz || !saveBiz) return;
  biz.sessionState = state;
  biz.sessionData  = { ...(biz.sessionData || {}), ...extraData };
  try { await saveBiz(biz); } catch (e) { /* ignore */ }
}

function _saveLead(from, school, actionType, source, extra = {}) {
  SchoolLead.create({
    schoolId: school._id, schoolPhone: school.phone,
    schoolName: school.schoolName, zqSlug: school.zqSlug || "",
    parentPhone: from.replace(/\D+/g, ""),
    parentName: extra.parentName || "", gradeInterest: extra.gradeInterest || "",
    actionType, source, waOpened: true, contacted: false
  }).catch(() => {});
}

// ─────────────────────────────────────────────────────────────────────────────
// ENTRY POINT — called by handleZqDeepLink in schoolSearch.js
// ─────────────────────────────────────────────────────────────────────────────
export async function showSchoolFAQMenu(from, schoolId, biz, saveBiz, { source = "direct", parentName = "" } = {}) {
  const school = await SchoolProfile.findById(schoolId).lean();
  if (!school) return sendText(from, "❌ School not found. Please try the link again.");

  // Track visit (fire-and-forget)
  SchoolProfile.findByIdAndUpdate(schoolId, { $inc: { monthlyViews: 1, zqLinkConversions: 1 } }).catch(() => {});

  // Save lead stub
  _saveLead(from, school, "view", source, { parentName });

  // Save session context (safe for null biz)
  await _saveSession(biz, saveBiz, "sfaq_menu", {
    faqSchoolId:   String(schoolId),
    faqParentName: parentName
  });

  // ── Build school header ─────────────────────────────────────────────────────
  const admBadge = school.admissionsOpen ? "🟢 Admissions Open" : "🔴 Admissions Closed";
  const fee      = _feeLabel(school);
  const verified = school.verified ? " ✅" : "";
  const typeMap  = { ecd:"ECD/Preschool", ecd_primary:"ECD + Primary", primary:"Primary School", secondary:"Secondary School", combined:"Combined School" };
  const cur      = (school.curriculum || []).map(c => c.toUpperCase()).join(" + ") || "ZIMSEC";
  const greeting = parentName ? `Hi ${parentName.split(" ")[0]}! ` : "";

  await sendText(from,
`🏫 *${school.schoolName}*${verified}
📍 ${school.suburb ? school.suburb + ", " : ""}${school.city}
${admBadge} · ${fee}
📚 ${typeMap[school.type] || "School"} · ${cur}

${greeting}Welcome to *${school.schoolName}* on ZimQuote.
Choose what you'd like to know:`
  );

  // ── Build menu — default topics + custom FAQ items from school ──────────────
  // WhatsApp hard limit: 10 rows per list section
  const customFAQ = (school.faqItems || [])
    .sort((a, b) => (a.order || 0) - (b.order || 0))
    .slice(0, 1); // show 1 custom item in main menu (rest in "More")

  const rows = [
    { id: `sfaq_fees_${schoolId}`,       title: "💵 School fees",           description: "Fees per term, payment methods" },
    { id: `sfaq_enroll_${schoolId}`,     title: "📝 Enrollment",            description: "How to apply, documents needed" },
    { id: `sfaq_tour_${schoolId}`,       title: "📅 Book a school visit",   description: "Schedule a tour or open day" },
    { id: `sfaq_results_${schoolId}`,    title: "📊 Academic results",      description: "Pass rates, rankings, subjects" },
    { id: `sfaq_transport_${schoolId}`,  title: "🚌 Transport",             description: "Routes, suburbs covered, costs" },
    { id: `sfaq_facilities_${schoolId}`, title: "🏊 Facilities & sports",   description: "Labs, pool, clubs, activities" },
    { id: `sfaq_calendar_${schoolId}`,   title: "📆 Term dates",            description: "Term 1/2/3, exams, holidays" },
    { id: `sfaq_staff_${schoolId}`,      title: "👤 Contact & staff",       description: "Phone, email, office hours" },
    ...customFAQ.map(fq => ({
      id:          `sfaq_custom_${fq._id || fq.order || "0"}_${schoolId}`,
      title:       fq.question.slice(0, 24),
      description: fq.answer.slice(0, 72)
    })),
    { id: `sfaq_more_${schoolId}`,       title: "➕ More options",           description: "Uniforms, docs, message school" }
  ].slice(0, 10); // enforce WhatsApp 10-row limit

  return sendList(from, "Select a topic:", rows);
}

// ─────────────────────────────────────────────────────────────────────────────
// ACTION ROUTER — handles every sfaq_ button tap
// schoolId is ALWAYS the last segment after the final underscore
// This works even when biz is null — no session needed
// ─────────────────────────────────────────────────────────────────────────────
export async function handleSchoolFAQAction({ from, action: a, biz, saveBiz }) {
  // Parse: last 24-char hex segment is always the schoolId
  const lastUs  = a.lastIndexOf("_");
  const schoolId = a.slice(lastUs + 1);
  const topic    = a.slice(5, lastUs); // strip "sfaq_" prefix

  if (!schoolId || schoolId.length !== 24) return false;

  // Always keep session fresh with current school
  await _saveSession(biz, saveBiz, biz?.sessionState || "sfaq_menu", {
    faqSchoolId: schoolId
  });

  // Custom FAQ items: sfaq_custom_<itemId>_<schoolId>
  if (topic.startsWith("custom_")) {
    const itemId = topic.slice(7); // strip "custom_"
    return _faqCustomAnswer(from, schoolId, itemId);
  }

  switch (topic) {
    case "fees":              return _faqFees(from, schoolId);
    case "fees_pay":          return _faqFeesPayment(from, schoolId);
    case "fees_pdf":          return _faqFeesPDF(from, schoolId, biz, saveBiz);
    case "fees_disc":         return _faqFeesDiscount(from, schoolId);
    case "enroll":            return _faqEnroll(from, schoolId, biz, saveBiz);
    case "enroll_apply":      return _faqEnrollApply(from, schoolId, biz, saveBiz);
    case "enroll_docs":       return _faqEnrollDocs(from, schoolId);
    case "enroll_age":        return _faqEnrollAge(from, schoolId);
    case "enroll_grade":      return _faqGradeCheck(from, schoolId, biz, saveBiz);
    case "tour":              return _faqTour(from, schoolId, biz, saveBiz);
    case "tour_book":         return _faqTourBook(from, schoolId, biz, saveBiz);
    case "results":           return _faqResults(from, schoolId);
    case "results_sub":       return _faqResultsSubs(from, schoolId);
    case "results_uni":       return _faqResultsUni(from, schoolId);
    case "transport":         return _faqTransport(from, schoolId);
    case "transport_routes":  return _faqTransportRoutes(from, schoolId);
    case "transport_cost":    return _faqTransportCost(from, schoolId);
    case "facilities":        return _faqFacilities(from, schoolId);
    case "sports":            return _faqSports(from, schoolId);
    case "calendar":          return _faqCalendar(from, schoolId);
    case "staff":             return _faqStaff(from, schoolId);
    case "more":              return _faqMore(from, schoolId, biz, saveBiz);
    case "uniforms":          return _faqUniforms(from, schoolId);
    case "docs":              return _faqDocs(from, schoolId);
    case "compare":           return _faqCompare(from, schoolId);
    case "bursary":           return _faqBursary(from, schoolId, biz, saveBiz);
    case "message":           return _faqMessage(from, schoolId, biz, saveBiz);
    case "back":              return showSchoolFAQMenu(from, schoolId, biz, saveBiz);

    // ── School admin: manage custom FAQ (from school admin bot menu) ──────────
    case "admin_faq":         return _adminFAQMenu(from, schoolId, biz, saveBiz);
    case "admin_faq_list":    return _adminFAQList(from, schoolId);
    case "admin_faq_add":     return _adminFAQAdd(from, schoolId, biz, saveBiz);
    case "admin_faq_clear":   return _adminFAQClear(from, schoolId);

    default: return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// STATE HANDLER — handles typed text in sfaq_ states
// ─────────────────────────────────────────────────────────────────────────────
export async function handleSchoolFAQState({ state, from, text, biz, saveBiz }) {
  if (!state?.startsWith("sfaq_")) return false;

  const schoolId = biz?.sessionData?.faqSchoolId;
  if (!schoolId) return false;

  const raw = (text || "").trim();
  const lo  = raw.toLowerCase();

  // Universal escape
  if (lo === "cancel" || lo === "back" || lo === "menu") {
    await _saveSession(biz, saveBiz, "sfaq_menu");
    return showSchoolFAQMenu(from, schoolId, biz, saveBiz);
  }

  switch (state) {

    // ── Parent sent a typed message to school ────────────────────────────────
    case "sfaq_awaiting_message": {
      if (raw.length < 3) return sendText(from, "Please type your message (minimum 3 characters). Type *cancel* to go back.");
      const school = await SchoolProfile.findById(schoolId).lean();
      if (!school) return false;
      notifySchoolEnquiry(school.phone, school.schoolName, from, raw).catch(() => {});
      _saveLead(from, school, "enquiry", "whatsapp_link");
      await _saveSession(biz, saveBiz, "sfaq_menu");
      return sendButtons(from, {
        text: `✅ *Message sent to ${school.schoolName}*\n\n_"${raw}"_\n\nThe school will reply to you on WhatsApp.\n📞 ${school.contactPhone || school.phone}`,
        buttons: [
          { id: `sfaq_tour_${schoolId}`,   title: "📅 Book a tour" },
          { id: `sfaq_enroll_${schoolId}`, title: "📝 Enrollment" },
          { id: `sfaq_back_${schoolId}`,   title: "⬅ Back to menu" }
        ]
      });
    }

    // ── Parent chose preferred tour date ────────────────────────────────────
    case "sfaq_awaiting_tour_date": {
      if (raw.length < 3) return sendText(from, "Please enter a preferred date, e.g. *Monday 9am*. Type *cancel* to go back.");
      const school = await SchoolProfile.findById(schoolId).lean();
      if (!school) return false;
      const pName = biz?.sessionData?.faqParentName || "";
      notifySchoolVisitRequest(school.phone, school.schoolName, pName || from.replace(/\D+/g, ""), "WhatsApp Bot").catch(() => {});
      _saveLead(from, school, "visit", "whatsapp_link", { parentName: pName });
      await _saveSession(biz, saveBiz, "sfaq_menu");
      return sendButtons(from, {
        text:
`✅ *School tour request sent!*

*${school.schoolName}* has been notified.
Preferred date: _${raw}_

They will confirm your visit and send directions.
📍 ${school.address || (school.suburb ? school.suburb + ", " : "") + school.city}
📞 ${school.contactPhone || school.phone}`,
        buttons: [
          { id: `sfaq_enroll_${schoolId}`, title: "📝 Start enrollment" },
          { id: `sfaq_fees_${schoolId}`,    title: "💵 See fees" },
          { id: `sfaq_back_${schoolId}`,    title: "⬅ Back to menu" }
        ]
      });
    }

    // ── Parent typed which grade they're asking about ────────────────────────
    case "sfaq_awaiting_grade": {
      const school = await SchoolProfile.findById(schoolId).lean();
      if (!school) return false;
      const pName = biz?.sessionData?.faqParentName || "";
      notifySchoolPlaceEnquiry(school.phone, school.schoolName, pName || from.replace(/\D+/g, ""), raw, "WhatsApp Bot").catch(() => {});
      _saveLead(from, school, "place", "whatsapp_link", { parentName: pName, gradeInterest: raw });
      await _saveSession(biz, saveBiz, "sfaq_menu");
      const admText = school.admissionsOpen
        ? `🟢 *Admissions are OPEN.*\n\nYour interest in *${raw}* has been sent to ${school.schoolName}.`
        : `🔴 *Admissions are closed.*\n\nYour interest in *${raw}* has been recorded. You'll be contacted when admissions re-open.`;
      return sendButtons(from, {
        text: `📝 *Grade enquiry sent*\n\n${admText}`,
        buttons: [
          { id: `sfaq_enroll_apply_${schoolId}`, title: "📋 Apply online" },
          { id: `sfaq_tour_${schoolId}`,          title: "📅 Book a tour" },
          { id: `sfaq_back_${schoolId}`,           title: "⬅ Back to menu" }
        ]
      });
    }

    // ── School admin adding a custom FAQ question ────────────────────────────
    case "sfaq_admin_adding_question": {
      if (raw.length < 5) return sendText(from, "Please type the question (at least 5 characters). Type *cancel* to go back.");
      await _saveSession(biz, saveBiz, "sfaq_admin_adding_answer", { faqPendingQuestion: raw });
      return sendText(from, `✅ Question noted: _"${raw}"_\n\nNow type the *answer* parents will see:\n\n_Type *cancel* to go back._`);
    }

    // ── School admin typed the answer for their new FAQ item ────────────────
    case "sfaq_admin_adding_answer": {
      if (raw.length < 5) return sendText(from, "Please type the answer (at least 5 characters). Type *cancel* to go back.");
      const question = biz?.sessionData?.faqPendingQuestion;
      if (!question) return showSchoolFAQMenu(from, schoolId, biz, saveBiz);

      const school = await SchoolProfile.findById(schoolId);
      if (!school) return false;

      const existing = school.faqItems || [];
      existing.push({ question, answer: raw, order: existing.length });
      await SchoolProfile.findByIdAndUpdate(schoolId, { $set: { faqItems: existing } });

      await _saveSession(biz, saveBiz, "sfaq_menu", { faqPendingQuestion: "" });
      return sendButtons(from, {
        text:
`✅ *FAQ item added!*

Q: _${question}_
A: _${raw}_

Parents will now see this in the "More options" section of your ZimQuote chatbot link.

You can add more or return to your menu.`,
        buttons: [
          { id: `sfaq_admin_faq_add_${schoolId}`, title: "➕ Add another" },
          { id: `sfaq_admin_faq_list_${schoolId}`,title: "📋 View all FAQ" },
          { id: `school_account`,                  title: "⬅ My account" }
        ]
      });
    }

    default: return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ── FEES ──────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
async function _faqFees(from, schoolId) {
  const school = await SchoolProfile.findById(schoolId).lean();
  if (!school) return false;
  _saveLead(from, school, "fees", "whatsapp_link");

  // Build fee answer from school data
  let answer = `💵 *School fees — ${school.schoolName}*\n\n`;

  if (school.fees?.term1) {
    answer += `*Day school fees (USD per term):*\n`;
    if (school.fees.ecdTerm1 && String(school.fees.ecdTerm1) !== String(school.fees.term1)) {
      answer += `ECD: $${school.fees.ecdTerm1}\n`;
    }
    answer += `Term 1: *$${school.fees.term1}*\n`;
    if (school.fees.term2) answer += `Term 2: *$${school.fees.term2}*\n`;
    if (school.fees.term3) answer += `Term 3: *$${school.fees.term3}*\n`;
    if (school.fees.devLevy)   answer += `\nDevelopment levy: $${school.fees.devLevy}/term`;
    if (school.fees.sportsFee) answer += `\nSports levy: $${school.fees.sportsFee}/term`;
    if (school.fees.examFee)   answer += `\nExam fees: $${school.fees.examFee}/year`;
    if (school.fees.boardingTerm1 > 0) {
      answer += `\n\n*Boarding fees (USD per term):*\nTerm 1: *$${school.fees.boardingTerm1}*`;
      if (school.fees.boardingTerm2) answer += ` | Term 2: *$${school.fees.boardingTerm2}*`;
      if (school.fees.boardingTerm3) answer += ` | Term 3: *$${school.fees.boardingTerm3}*`;
    }
    // Helpful annual estimate
    const t1 = Number(school.fees.term1) || 0;
    const t2 = Number(school.fees.term2) || t1;
    const t3 = Number(school.fees.term3) || t1;
    if (t1 > 0) answer += `\n\n💡 _Approx. annual: ~$${t1 + t2 + t3}_`;
  } else if (school.feeRange) {
    const label = { budget:"Under $300/term", mid:"$300–$800/term", premium:"$800+/term" }[school.feeRange];
    answer += `Fee range: *${label}*\n\nContact the school for the exact fee schedule.`;
  } else {
    answer += `Contact the school for the current fee schedule.\n📞 ${school.contactPhone || school.phone}`;
  }

  // Check for custom FAQ answer on fees
  const customFeesItem = (school.faqItems || []).find(fq =>
    fq.question.toLowerCase().includes("fee") || fq.question.toLowerCase().includes("cost")
  );
  if (customFeesItem) {
    answer += `\n\n_Additional info from ${school.schoolName}:_\n${customFeesItem.answer}`;
  }

  return sendButtons(from, {
    text: answer,
    buttons: [
      { id: `sfaq_fees_pay_${schoolId}`, title: "💳 Payment methods" },
      { id: `sfaq_fees_pdf_${schoolId}`, title: "📄 Get fee schedule PDF" },
      { id: `sfaq_back_${schoolId}`,     title: "⬅ Back to menu" }
    ]
  });
}

async function _faqFeesPayment(from, schoolId) {
  const school = await SchoolProfile.findById(schoolId).lean();
  if (!school) return false;

  const methods = (school.paymentMethods || []).length > 0
    ? school.paymentMethods
    : ["EcoCash", "InnBucks", "Bank transfer (CABS, CBZ, ZB, Steward Bank)", "Cash at school office"];

  let answer = `💳 *Payment methods — ${school.schoolName}*\n\n`;
  methods.forEach(m => { answer += `• ${m}\n`; });
  if (school.ecocashNumber) answer += `\n📲 *EcoCash:* ${school.ecocashNumber}`;
  if (school.bankDetails)   answer += `\n🏦 *Bank details:* ${school.bankDetails}`;
  answer += `\n\n_Use your child's full name + grade as the payment reference._`;

  return sendButtons(from, {
    text: answer,
    buttons: [
      { id: `sfaq_fees_disc_${schoolId}`, title: "🎁 Discounts?" },
      { id: `sfaq_fees_${schoolId}`,      title: "⬅ Back to fees" },
      { id: `sfaq_back_${schoolId}`,      title: "⬅ Main menu" }
    ]
  });
}

async function _faqFeesDiscount(from, schoolId) {
  const school = await SchoolProfile.findById(schoolId).lean();
  if (!school) return false;
  const info = school.feeDiscounts || "Sibling discounts and bursary assistance may be available. Contact the admissions office to enquire.";
  return sendButtons(from, {
    text: `🎁 *Discounts & bursaries — ${school.schoolName}*\n\n${info}\n\n📞 ${school.contactPhone || school.phone}`,
    buttons: [
      { id: `sfaq_bursary_${schoolId}`, title: "🎓 Ask about bursary" },
      { id: `sfaq_fees_${schoolId}`,    title: "⬅ Back to fees" }
    ]
  });
}

async function _faqFeesPDF(from, schoolId, biz, saveBiz) {
  const school = await SchoolProfile.findById(schoolId).lean();
  if (!school) return false;
  _saveLead(from, school, "pdf", "whatsapp_link");
  notifySchoolNewLead(school.phone, school.schoolName, from.replace(/\D+/g, ""), "pdf", "WhatsApp Bot").catch(() => {});

  if (school.feeSchedulePdfUrl || school.profilePdfUrl) {
    try {
      const { sendDocument } = await import("./metaSender.js");
      await sendDocument(from, {
        link: school.feeSchedulePdfUrl || school.profilePdfUrl,
        filename: school.schoolName.replace(/\s+/g, "_") + "_Fees.pdf"
      });
    } catch (e) { /* fallback to text */ }
    return sendButtons(from, {
      text: `📄 Fee schedule PDF sent above. Tap to open and save.\n\n_Share it with your family on WhatsApp._`,
      buttons: [
        { id: `sfaq_enroll_${schoolId}`, title: "📝 Start enrollment" },
        { id: `sfaq_back_${schoolId}`,   title: "⬅ Back to menu" }
      ]
    });
  }

  return sendButtons(from, {
    text: `📄 The fee schedule is not yet available as a PDF.\n\nContact the school:\n📞 ${school.contactPhone || school.phone}`,
    buttons: [
      { id: `sfaq_staff_${schoolId}`,  title: "📞 Contact school" },
      { id: `sfaq_back_${schoolId}`,   title: "⬅ Back to menu" }
    ]
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// ── ENROLLMENT ────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
async function _faqEnroll(from, schoolId, biz, saveBiz) {
  const school = await SchoolProfile.findById(schoolId).lean();
  if (!school) return false;

  const admText = school.admissionsOpen
    ? "🟢 *Admissions are currently OPEN.*"
    : "🔴 *Admissions are currently CLOSED.*\n_You can register your interest and the school will contact you when admissions open._";

  // Check for custom enrollment FAQ
  const custom = (school.faqItems || []).find(fq =>
    fq.question.toLowerCase().includes("enroll") || fq.question.toLowerCase().includes("admission") || fq.question.toLowerCase().includes("apply")
  );

  let answer = `📝 *Enrollment — ${school.schoolName}*\n\n${admText}`;
  if (custom) answer += `\n\n${custom.answer}`;

  return sendButtons(from, {
    text: answer,
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
  _saveLead(from, school, "apply", "whatsapp_link");

  if (school.registrationLink) {
    return sendButtons(from, {
      text:
`📋 *Apply to ${school.schoolName}*

${school.admissionsOpen ? "🟢 Admissions are OPEN." : "🔴 Admissions closed — you can still submit interest."}

Complete the online application form:
👉 ${school.registrationLink}

The school will confirm receipt and next steps.
📞 ${school.contactPhone || school.phone}`,
      buttons: [
        { id: `sfaq_enroll_docs_${schoolId}`, title: "📑 Documents needed" },
        { id: `sfaq_tour_${schoolId}`,         title: "📅 Book a tour" },
        { id: `sfaq_back_${schoolId}`,          title: "⬅ Main menu" }
      ]
    });
  }

  // No link — capture grade interest
  await _saveSession(biz, saveBiz, "sfaq_awaiting_grade", { faqSchoolId: schoolId });
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
• Previous school report (last term)
• Transfer letter (if from another school)
• 4 passport-size photos of the child
• Proof of residence (utility bill or council letter)${school.boarding !== "day" ? "\n• Medical certificate (boarding pupils)" : ""}`;

  return sendButtons(from, {
    text: `📑 *Documents for enrollment — ${school.schoolName}*\n\n${docs}\n\n_Bring originals and certified copies._\n📍 ${school.address || (school.suburb ? school.suburb + ", " : "") + school.city}`,
    buttons: [
      { id: `sfaq_enroll_apply_${schoolId}`, title: "📋 Apply now" },
      { id: `sfaq_enroll_age_${schoolId}`,   title: "🎂 Age requirements" },
      { id: `sfaq_back_${schoolId}`,          title: "⬅ Main menu" }
    ]
  });
}

async function _faqEnrollAge(from, schoolId) {
  const school = await SchoolProfile.findById(schoolId).lean();
  if (!school) return false;
  const ages = school.ageRequirements ||
`• ECD A: turning 3 by 1 March
• ECD B: turning 4 by 1 March
• Grade 1: turning 6 by 31 March
• Grade 2+: according to previous school level
_As per Zimbabwe Ministry of Primary & Secondary Education._`;
  return sendButtons(from, {
    text: `🎂 *Age requirements — ${school.schoolName}*\n\n${ages}`,
    buttons: [
      { id: `sfaq_enroll_apply_${schoolId}`, title: "📋 Apply now" },
      { id: `sfaq_enroll_docs_${schoolId}`,  title: "📑 Documents" },
      { id: `sfaq_back_${schoolId}`,          title: "⬅ Main menu" }
    ]
  });
}

async function _faqGradeCheck(from, schoolId, biz, saveBiz) {
  await _saveSession(biz, saveBiz, "sfaq_awaiting_grade", { faqSchoolId: schoolId });
  return sendText(from, `🎓 *Grade availability check*\n\nWhich grade are you asking about?\n\n_e.g. "Grade 5", "Form 2", "ECD A"_\n_Type *cancel* to go back._`);
}

// ─────────────────────────────────────────────────────────────────────────────
// ── SCHOOL TOUR ───────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
async function _faqTour(from, schoolId, biz, saveBiz) {
  const school = await SchoolProfile.findById(schoolId).lean();
  if (!school) return false;
  const info = school.tourInfo || "School tours are available on weekdays by appointment. Tours take approximately 45 minutes and include all key facilities.";
  return sendButtons(from, {
    text:
`📅 *School tour — ${school.schoolName}*

${info}

📍 ${school.address || (school.suburb ? school.suburb + ", " : "") + school.city}
⏰ ${school.officeHours || "Mon–Fri, 7am–4pm"}
📞 ${school.contactPhone || school.phone}`,
    buttons: [
      { id: `sfaq_tour_book_${schoolId}`, title: "✅ Book my tour now" },
      { id: `sfaq_staff_${schoolId}`,     title: "📞 Call admissions" },
      { id: `sfaq_back_${schoolId}`,      title: "⬅ Main menu" }
    ]
  });
}

async function _faqTourBook(from, schoolId, biz, saveBiz) {
  await _saveSession(biz, saveBiz, "sfaq_awaiting_tour_date", { faqSchoolId: schoolId });
  return sendText(from,
`📅 *Book a school tour — ${(await SchoolProfile.findById(schoolId).lean())?.schoolName || "school"}*

Type your preferred date and time:

Examples:
• _"Monday 9am"_
• _"Any weekday morning"_
• _"This Saturday if possible"_
• _"15 August at 10am"_

_Type *cancel* to go back._`
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ── ACADEMIC RESULTS ──────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
async function _faqResults(from, schoolId) {
  const school = await SchoolProfile.findById(schoolId).lean();
  if (!school) return false;
  const r = school.academicResults;
  let answer = `📊 *Academic results — ${school.schoolName}*\n\n`;

  if (r?.oLevelPassRate) {
    answer += `*ZIMSEC O-Level (${r.oLevelYear || "latest"}):*\nPass rate: *${r.oLevelPassRate}%*\n`;
    if (r.oLevel5Plus) answer += `5+ subjects: *${r.oLevel5Plus}%*\n`;
  }
  if (r?.aLevelPassRate) {
    answer += `\n*A-Level (${r.aLevelYear || "latest"}):*\nPass rate: *${r.aLevelPassRate}%*\n`;
    if (r.universityEntry) answer += `University entry: *${r.universityEntry}%*\n`;
  }
  if (r?.cambridgePassRate) {
    answer += `\n*Cambridge IGCSE:* Pass rate *${r.cambridgePassRate}%*\n`;
  }
  if (r?.nationalRanking) answer += `\n🏆 National ranking: *#${r.nationalRanking}*`;
  if (r?.harareRanking)   answer += `\nHarare ranking: *#${r.harareRanking}*`;

  if (!r?.oLevelPassRate && !r?.aLevelPassRate) {
    // Check custom FAQ for results
    const custom = (school.faqItems || []).find(fq => fq.question.toLowerCase().includes("result") || fq.question.toLowerCase().includes("pass"));
    if (custom) {
      answer += custom.answer;
    } else {
      answer += `Contact the school for academic results information.\n📞 ${school.contactPhone || school.phone}`;
    }
  }

  return sendButtons(from, {
    text: answer,
    buttons: [
      { id: `sfaq_results_sub_${schoolId}`, title: "📘 Top subjects" },
      { id: `sfaq_results_uni_${schoolId}`, title: "🎓 University placement" },
      { id: `sfaq_enroll_${schoolId}`,      title: "📝 Enroll now" }
    ]
  });
}

async function _faqResultsSubs(from, schoolId) {
  const school = await SchoolProfile.findById(schoolId).lean();
  if (!school) return false;
  const info = school.academicResults?.topSubjects || `Contact the school for subject breakdown.\n📞 ${school.contactPhone || school.phone}`;
  return sendButtons(from, {
    text: `📘 *Top subjects — ${school.schoolName}*\n\n${info}`,
    buttons: [{ id: `sfaq_results_${schoolId}`, title: "⬅ Back to results" }, { id: `sfaq_back_${schoolId}`, title: "⬅ Main menu" }]
  });
}

async function _faqResultsUni(from, schoolId) {
  const school = await SchoolProfile.findById(schoolId).lean();
  if (!school) return false;
  const info = school.academicResults?.universityInfo || `Contact the school for university placement stats.\n📞 ${school.contactPhone || school.phone}`;
  return sendButtons(from, {
    text: `🎓 *University placement — ${school.schoolName}*\n\n${info}`,
    buttons: [{ id: `sfaq_results_${schoolId}`, title: "⬅ Back to results" }, { id: `sfaq_enroll_${schoolId}`, title: "📝 Enroll" }]
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// ── TRANSPORT ─────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
async function _faqTransport(from, schoolId) {
  const school = await SchoolProfile.findById(schoolId).lean();
  if (!school) return false;
  const hasTransport = (school.facilities || []).includes("transport");
  if (!hasTransport) {
    return sendButtons(from, {
      text: `🚌 *Transport — ${school.schoolName}*\n\nThis school does not operate a school bus service.\n\nParents arrange own transport.\n📍 ${school.address || (school.suburb ? school.suburb + ", " : "") + school.city}`,
      buttons: [{ id: `sfaq_staff_${schoolId}`, title: "📞 Contact school" }, { id: `sfaq_back_${schoolId}`, title: "⬅ Main menu" }]
    });
  }
  return sendButtons(from, {
    text: `🚌 *Transport — ${school.schoolName}*\n\n${school.transportInfo || "School transport is available. Contact the school for routes and costs."}\n📞 ${school.transportContact || school.contactPhone || school.phone}`,
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
    buttons: [{ id: `sfaq_transport_cost_${schoolId}`, title: "💵 Transport costs" }, { id: `sfaq_message_${schoolId}`, title: "✉️ Ask about my area" }, { id: `sfaq_back_${schoolId}`, title: "⬅ Main menu" }]
  });
}

async function _faqTransportCost(from, schoolId) {
  const school = await SchoolProfile.findById(schoolId).lean();
  if (!school) return false;
  const cost = school.transportFees || `Contact the school for transport pricing.\n📞 ${school.contactPhone || school.phone}`;
  return sendButtons(from, {
    text: `💵 *Transport fees — ${school.schoolName}*\n\n${cost}`,
    buttons: [{ id: `sfaq_transport_routes_${schoolId}`, title: "🗺️ View routes" }, { id: `sfaq_back_${schoolId}`, title: "⬅ Main menu" }]
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// ── FACILITIES & SPORTS ───────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
async function _faqFacilities(from, schoolId) {
  const school = await SchoolProfile.findById(schoolId).lean();
  if (!school) return false;
  const FAC = Object.fromEntries((SCHOOL_FACILITIES || []).map(f => [f.id, f.label]));
  const list = (school.facilities || []).map(id => FAC[id] || id).join("\n") || `Contact school for facilities information.\n📞 ${school.contactPhone || school.phone}`;
  return sendButtons(from, {
    text: `🏊 *Facilities — ${school.schoolName}*\n\n${list}`,
    buttons: [
      { id: `sfaq_sports_${schoolId}`, title: "⚽ Sports & clubs" },
      { id: `sfaq_tour_${schoolId}`,    title: "📅 Book a tour to see" },
      { id: `sfaq_back_${schoolId}`,    title: "⬅ Main menu" }
    ]
  });
}

async function _faqSports(from, schoolId) {
  const school = await SchoolProfile.findById(schoolId).lean();
  if (!school) return false;
  const EXT = Object.fromEntries((SCHOOL_EXTRAMURALACTIVITIES || []).map(e => [e.id, e.label]));
  const sports = (school.extramuralActivities || []).map(id => EXT[id] || id).join(", ") || `Contact school for extramural information.\n📞 ${school.contactPhone || school.phone}`;
  return sendButtons(from, {
    text: `⚽ *Sports & extramural — ${school.schoolName}*\n\n${sports}${school.sportsAchievements ? "\n\n" + school.sportsAchievements : ""}`,
    buttons: [{ id: `sfaq_facilities_${schoolId}`, title: "🏊 All facilities" }, { id: `sfaq_back_${schoolId}`, title: "⬅ Main menu" }]
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// ── CALENDAR ──────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
async function _faqCalendar(from, schoolId) {
  const school = await SchoolProfile.findById(schoolId).lean();
  if (!school) return false;
  const cal = school.termCalendar || `Contact the school for the current term calendar.\n📞 ${school.contactPhone || school.phone}`;
  return sendButtons(from, {
    text: `📆 *Term calendar — ${school.schoolName}*\n\n${cal}`,
    buttons: [{ id: `sfaq_enroll_${schoolId}`, title: "📝 Enrollment" }, { id: `sfaq_tour_${schoolId}`, title: "📅 Book a tour" }, { id: `sfaq_back_${schoolId}`, title: "⬅ Main menu" }]
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// ── STAFF & CONTACT ───────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
async function _faqStaff(from, schoolId) {
  const school = await SchoolProfile.findById(schoolId).lean();
  if (!school) return false;
  let answer = `👤 *Contact — ${school.schoolName}*\n\n`;
  if (school.principalName) answer += `Principal: *${school.principalName}*\n`;
  if (school.deputyName)    answer += `Deputy: *${school.deputyName}*\n`;
  answer += `\n📞 Office: *${school.contactPhone || school.phone}*\n`;
  if (school.email)   answer += `📧 ${school.email}\n`;
  if (school.website) answer += `🌐 ${school.website}\n`;
  if (school.address) answer += `\n📍 ${school.address}\n`;
  answer += `\n⏰ ${school.officeHours || "Monday–Friday, 7am–4pm"}`;
  return sendButtons(from, {
    text: answer,
    buttons: [{ id: `sfaq_message_${schoolId}`, title: "✉️ Send a message" }, { id: `sfaq_tour_${schoolId}`, title: "📅 Book a tour" }, { id: `sfaq_back_${schoolId}`, title: "⬅ Main menu" }]
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// ── MORE OPTIONS PAGE ─────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
async function _faqMore(from, schoolId, biz, saveBiz) {
  const school = await SchoolProfile.findById(schoolId).lean();
  if (!school) return false;

  const customItems = (school.faqItems || [])
    .sort((a, b) => (a.order || 0) - (b.order || 0))
    .slice(0, 4); // up to 4 custom items in "More" page

  const rows = [
    { id: `sfaq_uniforms_${schoolId}`, title: "👕 Uniforms & supplies",  description: "List, sizes, where to buy" },
    { id: `sfaq_docs_${schoolId}`,     title: "📄 Download documents",   description: "Prospectus, forms, fee schedule" },
    { id: `sfaq_compare_${schoolId}`,  title: "🔍 Compare schools",      description: "See similar schools nearby" },
    { id: `sfaq_bursary_${schoolId}`,  title: "🎓 Bursary / financial aid", description: "Ask about fee assistance" },
    ...customItems.map(fq => ({
      id:          `sfaq_custom_${fq._id || fq.order || "0"}_${schoolId}`,
      title:       fq.question.slice(0, 24),
      description: fq.answer.slice(0, 72)
    })),
    { id: `sfaq_message_${schoolId}`,  title: "✉️ Send a message",       description: "Ask anything not listed here" },
    { id: `sfaq_back_${schoolId}`,     title: "⬅ Back to main menu" }
  ].slice(0, 10);

  return sendList(from, `More — ${school.schoolName}:`, rows);
}

// ─────────────────────────────────────────────────────────────────────────────
// ── UNIFORMS ──────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
async function _faqUniforms(from, schoolId) {
  const school = await SchoolProfile.findById(schoolId).lean();
  if (!school) return false;
  const info = school.uniformInfo || `Uniforms are available from the school tuck shop or an approved supplier.\nContact the school for sizes and prices.\n📞 ${school.contactPhone || school.phone}`;
  return sendButtons(from, {
    text: `👕 *Uniforms — ${school.schoolName}*\n\n${info}`,
    buttons: [{ id: `sfaq_fees_${schoolId}`, title: "💵 View school fees" }, { id: `sfaq_back_${schoolId}`, title: "⬅ Main menu" }]
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// ── DOCUMENTS ─────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
async function _faqDocs(from, schoolId) {
  const school = await SchoolProfile.findById(schoolId).lean();
  if (!school) return false;

  const docs = [];
  if (school.profilePdfUrl)      docs.push({ label:"School Prospectus",  url: school.profilePdfUrl });
  if (school.feeSchedulePdfUrl)  docs.push({ label:"Fee Schedule",        url: school.feeSchedulePdfUrl });
  if (school.applicationFormUrl) docs.push({ label:"Application Form",    url: school.applicationFormUrl });
  for (const b of (school.brochures || [])) docs.push(b);

  if (!docs.length) {
    return sendButtons(from, {
      text: `📄 *Documents — ${school.schoolName}*\n\nNo documents uploaded yet.\n\n📞 ${school.contactPhone || school.phone}`,
      buttons: [{ id: `sfaq_message_${schoolId}`, title: "✉️ Request documents" }, { id: `sfaq_back_${schoolId}`, title: "⬅ Main menu" }]
    });
  }

  _saveLead(from, school, "pdf", "whatsapp_link");
  const { sendDocument } = await import("./metaSender.js");
  let sent = 0;
  for (const doc of docs) {
    try {
      await sendDocument(from, { link: doc.url, filename: (doc.label || "Doc").replace(/[^a-zA-Z0-9 ]/g,"").replace(/\s+/g,"_") + ".pdf" });
      sent++;
    } catch (e) { /* ignore */ }
  }
  return sendButtons(from, {
    text: sent > 0 ? `📄 *${sent} document${sent>1?"s":""} sent above.* Tap each to open.\n\n_Forward to your family on WhatsApp._` : `📄 Documents:\n${docs.map(d=>`• ${d.label}: ${d.url}`).join("\n")}`,
    buttons: [{ id: `sfaq_enroll_apply_${schoolId}`, title: "📋 Apply online" }, { id: `sfaq_back_${schoolId}`, title: "⬅ Main menu" }]
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// ── COMPARE WITH NEARBY SCHOOLS ───────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
async function _faqCompare(from, schoolId) {
  const school = await SchoolProfile.findById(schoolId).lean();
  if (!school) return false;

  const ranges = { budget:["budget"], mid:["budget","mid"], premium:["mid","premium"] };
  const others = await SchoolProfile.find({
    _id: { $ne: school._id }, city: school.city, active: true,
    feeRange: { $in: ranges[school.feeRange] || ["budget","mid","premium"] }
  }).limit(3).lean();

  if (!others.length) {
    return sendButtons(from, {
      text: `🔍 No other schools found in ${school.city} on ZimQuote at the same price range.\n\nSearch all schools:\nwa.me/263789901058`,
      buttons: [{ id: `sfaq_back_${schoolId}`, title: "⬅ Main menu" }]
    });
  }

  const FEE = { budget:"Under $300/term", mid:"$300–$800/term", premium:"$800+/term" };
  let answer = `🔍 *Similar schools in ${school.city}*\n\nCompared to *${school.schoolName}* (${FEE[school.feeRange]||""})\n\n`;
  others.forEach((s, i) => {
    answer += `*${i+1}. ${s.schoolName}*\n📍 ${s.suburb?s.suburb+", ":""}${s.city}\n💵 ${_feeLabel(s)} · ${s.admissionsOpen?"🟢 Open":"🔴 Closed"}\n\n`;
  });

  const btns = others.slice(0, 2).map(s => ({ id: `sfaq_fees_${String(s._id)}`, title: s.schoolName.slice(0,20) }));
  btns.push({ id: `sfaq_back_${schoolId}`, title: "⬅ Main menu" });
  return sendButtons(from, { text: answer, buttons: btns });
}

// ─────────────────────────────────────────────────────────────────────────────
// ── BURSARY ───────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
async function _faqBursary(from, schoolId, biz, saveBiz) {
  const school = await SchoolProfile.findById(schoolId).lean();
  if (!school) return false;
  const info = school.bursaryInfo || school.feeDiscounts || "Bursary and financial assistance may be available for deserving pupils. Please contact the school admissions office to discuss your situation confidentially.";
  await _saveSession(biz, saveBiz, "sfaq_awaiting_message", { faqSchoolId: schoolId });
  return sendText(from,
`🎓 *Bursary & financial aid — ${school.schoolName}*

${info}

To enquire about financial assistance, briefly describe your situation below and it will be sent to the school:

_e.g. "Single parent, 2 children, asking about partial fee assistance for Grade 3 2026"_

Type *cancel* to go back.`
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ── LEAVE A MESSAGE ───────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
async function _faqMessage(from, schoolId, biz, saveBiz) {
  await _saveSession(biz, saveBiz, "sfaq_awaiting_message", { faqSchoolId: schoolId });
  const school = await SchoolProfile.findById(schoolId).lean();
  return sendText(from, `✉️ *Send a message to ${school?.schoolName || "the school"}*\n\nType your question or message. The school will reply on WhatsApp.\n\n_Type *cancel* to go back._`);
}

// ─────────────────────────────────────────────────────────────────────────────
// ── CUSTOM FAQ ANSWER ─────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
async function _faqCustomAnswer(from, schoolId, itemRef) {
  const school = await SchoolProfile.findById(schoolId).lean();
  if (!school) return false;

  // itemRef is either a MongoDB ObjectId string or the order number
  const item = (school.faqItems || []).find(fq =>
    String(fq._id) === itemRef || String(fq.order) === itemRef
  );

  if (!item) return showSchoolFAQMenu(from, schoolId, null, null);

  return sendButtons(from, {
    text: `❓ *${item.question}*\n\n${item.answer}`,
    buttons: [
      { id: `sfaq_more_${schoolId}`,    title: "⬅ More questions" },
      { id: `sfaq_back_${schoolId}`,    title: "⬅ Main menu" },
      { id: `sfaq_message_${schoolId}`, title: "✉️ Ask follow-up" }
    ]
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// ── SCHOOL ADMIN — MANAGE CUSTOM FAQ (via bot, for school staff) ──────────────
// ─────────────────────────────────────────────────────────────────────────────
async function _adminFAQMenu(from, schoolId, biz, saveBiz) {
  const school = await SchoolProfile.findById(schoolId).lean();
  if (!school) return false;
  const count = (school.faqItems || []).length;
  return sendButtons(from, {
    text:
`📋 *Manage your FAQ — ${school.schoolName}*

You have *${count}* custom question${count !== 1 ? "s" : ""} set up.

Parents see your custom Q&A in the "More options" section of your ZimQuote chatbot.

What would you like to do?`,
    buttons: [
      { id: `sfaq_admin_faq_add_${schoolId}`,   title: "➕ Add a question" },
      { id: `sfaq_admin_faq_list_${schoolId}`,  title: "📋 View my questions" },
      { id: `sfaq_admin_faq_clear_${schoolId}`, title: "🗑️ Clear all custom FAQ" }
    ]
  });
}

async function _adminFAQList(from, schoolId) {
  const school = await SchoolProfile.findById(schoolId).lean();
  if (!school) return false;
  const items = school.faqItems || [];
  if (!items.length) {
    return sendText(from, `📋 *Your custom FAQ — ${school.schoolName}*\n\nNo custom questions yet.\n\nAdd questions parents frequently ask — things not covered by the default topics.`);
  }
  let list = `📋 *Your custom FAQ — ${school.schoolName}*\n\n`;
  items.forEach((fq, i) => {
    list += `*${i+1}. ${fq.question}*\n_${fq.answer.slice(0, 80)}${fq.answer.length > 80 ? "..." : ""}_\n\n`;
  });
  return sendButtons(from, {
    text: list.trim(),
    buttons: [
      { id: `sfaq_admin_faq_add_${schoolId}`,   title: "➕ Add more" },
      { id: `sfaq_admin_faq_clear_${schoolId}`, title: "🗑️ Clear all" },
      { id: `school_account`,                    title: "⬅ My account" }
    ]
  });
}

async function _adminFAQAdd(from, schoolId, biz, saveBiz) {
  await _saveSession(biz, saveBiz, "sfaq_admin_adding_question", { faqSchoolId: schoolId });
  return sendText(from,
`➕ *Add a custom FAQ question*

Type the *question* parents frequently ask about your school:

Examples:
• _"Do you offer after-school care?"_
• _"When is the next open day?"_
• _"What is the school's WhatsApp group policy?"_
• _"Is the school affiliated with any church?"_

Type *cancel* to go back.`
  );
}

async function _adminFAQClear(from, schoolId) {
  await SchoolProfile.findByIdAndUpdate(schoolId, { $set: { faqItems: [] } });
  return sendText(from, `🗑️ All custom FAQ questions cleared.\n\nYour ZimQuote chatbot will now show the default topics only. You can add new questions any time.`);
}