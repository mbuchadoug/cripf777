// services/schoolFAQ.js
// ─── ZimQuote School — 24/7 Admissions Assistant ─────────────────────────────
//
// ARCHITECTURE:
//   school.faqCategories = [{ id, name, emoji, order, active }]
//   school.faqItems      = [{ id, categoryId, question, answer, pdfUrl, pdfLabel,
//                              active, order, isDefault, actionType }]
//
//   "default" items are generated from school profile data and stored permanently
//   alongside admin items. Parents NEVER see any distinction.
//   Both types are sorted by `order` and rendered identically.
//
// WHATSAPP LIMITS:
//   - Button title:    ≤20 chars  (hard Meta limit — enforced by _btn())
//   - List row title:  ≤24 chars
//   - List rows:       ≤10 per message
//   - Button replies:  ≤3 buttons per message
//
// ACTION ID FORMAT:
//   sfaq_menu_<schoolId>          → show main category menu
//   sfaq_cat_<catId>_<schoolId>   → show questions in a category
//   sfaq_q_<itemId>_<schoolId>    → show answer for a question
//   sfaq_pg_<catId>_<page>_<sid>  → paginate a category
//   sfaq_act_<action>_<schoolId>  → specific actions (tour, apply, message)
//   sfaq_back_<schoolId>          → return to main menu
//
// SCHEMA ADDITIONS NEEDED (add to SchoolProfile model):
//   faqCategories: [{ id: String, name: String, emoji: String, order: Number, active: Boolean }]
//   faqItems:      [{ id: String, categoryId: String, question: String, answer: String,
//                     pdfUrl: String, pdfLabel: String, active: Boolean, order: Number,
//                     isDefault: Boolean, actionType: String }]

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
// CONSTANTS & HELPERS
// ─────────────────────────────────────────────────────────────────────────────
const MAX_BTN  = 20;  // WhatsApp button title hard limit
const PAGE_SIZE = 8;  // Questions per category page (leave 2 slots for navigation)

function _btn(t)  { return (t || "").trim().slice(0, MAX_BTN); }
function _uid()   { return Date.now().toString(36) + Math.random().toString(36).slice(2, 5); }

function _feeText(s) {
  if (s.fees?.term1) return `$${s.fees.term1}/term`;
  return { budget: "Under $300/term", mid: "$300–$800/term", premium: "$800+/term" }[s.feeRange] || null;
}

async function _sess(biz, saveBiz, state, data = {}) {
  if (!biz || !saveBiz) return;
  biz.sessionState = state;
  biz.sessionData  = { ...(biz.sessionData || {}), ...data };
  try { await saveBiz(biz); } catch (_) { /* ignore */ }
}

function _saveLead(from, school, action, source, extra = {}) {
  SchoolLead.create({
    schoolId: school._id, schoolPhone: school.phone,
    schoolName: school.schoolName, zqSlug: school.zqSlug || "",
    parentPhone: from.replace(/\D+/g, ""),
    parentName: extra.parentName || "", gradeInterest: extra.gradeInterest || "",
    actionType: action, source, waOpened: true, contacted: false
  }).catch(() => {});
}

// ─────────────────────────────────────────────────────────────────────────────
// DEFAULT CATEGORY + QUESTION GENERATOR
// Reads the school profile and returns smart defaults relevant to THIS school.
// Results are deterministic — same profile always produces same questions.
// ─────────────────────────────────────────────────────────────────────────────

const SYSTEM_CATEGORIES = [
  { id: "fees",       name: "Fees & Payments",  emoji: "💵", order: 10 },
  { id: "admissions", name: "Admissions",        emoji: "📝", order: 20 },
  { id: "boarding",   name: "Boarding",          emoji: "🛏️", order: 30 },
  { id: "transport",  name: "Transport",         emoji: "🚌", order: 40 },
  { id: "academics",  name: "Academics",         emoji: "📊", order: 50 },
  { id: "facilities", name: "Facilities",        emoji: "🏊", order: 60 },
  { id: "uniforms",   name: "Uniforms",          emoji: "👕", order: 70 },
  { id: "calendar",   name: "Term Calendar",     emoji: "📆", order: 80 },
  { id: "contact",    name: "Contact & Admin",   emoji: "📞", order: 90 },
];

function _generateDefaults(school) {
  // Returns array of { categoryId, id, question, answer, pdfUrl, pdfLabel, isDefault, order, actionType }
  // Only generates questions relevant to this school's profile.

  const defaults = [];
  const sid = String(school._id);
  const phone = school.contactPhone || school.phone;
  const hasBoarding  = school.boarding === "boarding" || school.boarding === "both";
  const isDay        = school.boarding === "day";
  const hasTrans     = (school.facilities || []).includes("transport");
  const hasCambridge = (school.curriculum || []).includes("cambridge");
  const hasZimsec    = (school.curriculum || []).includes("zimsec") || !(school.curriculum || []).length;
  const hasFees      = !!(school.fees?.term1);
  const feeText      = _feeText(school);
  const admOpen      = school.admissionsOpen;
  const hasAppLink   = !!school.registrationLink;
  const hasPDF       = !!(school.profilePdfUrl || school.feeSchedulePdfUrl);
  const r            = school.academicResults;

  let o = 0; // order counter per category

  // ── FEES ──────────────────────────────────────────────────────────────────
  const fs = school.feeSections || {};
  const SECTION_LABEL = {
    ecd:          "ECD / Preschool",
    lowerPrimary: "Lower Primary (Grades 1–4)",
    upperPrimary: "Upper Primary (Grades 5–7)",
    primary:      "Primary (Grades 1–7)",
    olevel:       "O-Level (Form 1–4)",
    alevel:       "A-Level (Form 5–6)"
  };

  // Helper: format a section's fees as a line
  function _secLine(data, label, prefix) {
    if (!data?.day?.term1) return "";
    const d = data.day;
    let line = `${prefix || "•"} *${label} (day):* $${d.term1}/T1 · $${d.term2 || d.term1}/T2 · $${d.term3 || d.term1}/T3`;
    if (data.boarding?.term1 > 0) {
      const b = data.boarding;
      line += `\n  ↳ Boarding: $${b.term1}/T1 · $${b.term2 || b.term1}/T2 · $${b.term3 || b.term1}/T3`;
    }
    return line;
  }

  // Build a full fee schedule answer from feeSections
  const ORDER = ["ecd","lowerPrimary","upperPrimary","primary","olevel","alevel"];
  const feeLines = ORDER.map(sec => _secLine(fs[sec], SECTION_LABEL[sec], "")).filter(Boolean);

  // Build levies text
  const levies = school.levies || [];
  const levyLines = levies.map(l => `• ${l.name}: $${l.amount}/${l.per.replace("_"," ")}`);
  const admFee = school.admissionFee > 0 ? `• Admission / Registration fee: *$${school.admissionFee}* (once-off)` : "";
  const cautionFee = school.cautionMoney > 0 ? `• Caution money (refundable): *$${school.cautionMoney}*` : "";

  if (feeLines.length > 0) {
    // Annual estimate from primary or olevel
    const repFee = fs.primary?.day?.term1 || fs.olevel?.day?.term1 || 0;
    const repT2  = fs.primary?.day?.term2 || fs.olevel?.day?.term2 || repFee;
    const repT3  = fs.primary?.day?.term3 || fs.olevel?.day?.term3 || repFee;
    const annual = repFee + repT2 + repT3;

    let feeAnswer = `💵 *Fee schedule — ${school.schoolName}*\n\n`;
    feeAnswer += feeLines.join("\n\n");
    if (levyLines.length) feeAnswer += "\n\n*Annual levies:*\n" + levyLines.join("\n");
    if (admFee) feeAnswer += "\n\n*Once-off fees:*\n" + admFee;
    if (cautionFee) feeAnswer += "\n" + cautionFee;
    if (annual > 0) feeAnswer += `\n\n💡 _Day school annual estimate: ~$${annual} (excl. levies)_`;
    feeAnswer += "\n\n_All fees are in USD._";

    defaults.push({ categoryId: "fees", id: "def_fees_full", order: o++, isDefault: true,
      question: "What are the school fees?",
      answer: feeAnswer,
      pdfUrl: school.feeSchedulePdfUrl || undefined,
      pdfLabel: school.feeSchedulePdfUrl ? `${school.schoolName} Fee Schedule` : undefined
    });

    // Section-specific questions for schools with multiple sections
    if (feeLines.length > 1) {
      for (const sec of ORDER) {
        if (!fs[sec]?.day?.term1) continue;
        const d = fs[sec].day;
        const b = fs[sec].boarding;
        const label = SECTION_LABEL[sec];
        let ans = `💵 *${label} fees — ${school.schoolName}*\n\n`;
        ans += `Day fees per term:\nT1: *$${d.term1}* · T2: *$${d.term2||d.term1}* · T3: *$${d.term3||d.term1}*`;
        if (b?.term1 > 0) ans += `\n\nBoarding fees per term:\nT1: *$${b.term1}* · T2: *$${b.term2||b.term1}* · T3: *$${b.term3||b.term1}*`;
        const annualSec = (d.term1||0) + (d.term2||d.term1||0) + (d.term3||d.term1||0);
        if (annualSec > 0) ans += `\n\n💡 Annual day estimate: ~$${annualSec}`;
        defaults.push({ categoryId: "fees", id: `def_fees_${sec}`, order: o++, isDefault: true,
          question: `${label} fees?`,
          answer: ans
        });
      }
    }
  } else if (hasFees) {
    // Fallback to legacy flat fees
    const fees = school.fees;
    defaults.push({ categoryId: "fees", id: "def_fees_term", order: o++, isDefault: true,
      question: "What are the school fees?",
      answer: `💵 *Fees — ${school.schoolName}*\n\n` +
        (fees.ecdTerm1 > 0 && fees.ecdTerm1 !== fees.term1 ? `ECD: $${fees.ecdTerm1}/term\n` : "") +
        `Grade school: *$${fees.term1}* (T1) · *$${fees.term2||fees.term1}* (T2) · *$${fees.term3||fees.term1}* (T3)` +
        (fees.boardingTerm1 > 0 ? `\nBoarding: *$${fees.boardingTerm1}* (T1) · *$${fees.boardingTerm2||fees.boardingTerm1}* (T2)` : "") +
        `\n\n💡 Annual estimate: ~$${(+fees.term1 + +(fees.term2||fees.term1) + +(fees.term3||fees.term1)).toFixed(0)}`
    });
  } else if (feeText) {
    defaults.push({ categoryId: "fees", id: "def_fees_range", order: o++, isDefault: true,
      question: "What are the fees?",
      answer: `💵 *Fees — ${school.schoolName}*\n\nFee range: *${feeText}*\n\nContact us for the full current fee schedule.\n📞 ${phone}`
    });
  }

  const payMethods = school.paymentMethods?.length
    ? school.paymentMethods : ["EcoCash", "InnBucks", "Bank transfer", "Cash at school"];
  defaults.push({ categoryId: "fees", id: "def_fees_pay", order: o++, isDefault: true,
    question: "How do I pay fees?",
    answer: `💳 *Payment methods — ${school.schoolName}*\n\n` +
      payMethods.map(m => `• ${m}`).join("\n") +
      (school.ecocashNumber ? `\n\n📲 EcoCash: *${school.ecocashNumber}*` : "") +
      (school.bankDetails ? `\n🏦 ${school.bankDetails}` : "") +
      `\n\n_Use child's full name + grade as payment reference._`
  });

  if (school.feeDiscounts || school.bursaryInfo) {
    defaults.push({ categoryId: "fees", id: "def_fees_disc", order: o++, isDefault: true,
      question: "Are discounts available?",
      answer: `🎁 *Discounts & bursaries — ${school.schoolName}*\n\n` +
        (school.feeDiscounts || school.bursaryInfo ||
         "Contact admissions to enquire about sibling discounts and bursary assistance.\n📞 " + phone)
    });
  }

  if (school.admissionFee > 0) {
    defaults.push({ categoryId: "fees", id: "def_fees_admission", order: o++, isDefault: true,
      question: "Is there a registration fee?",
      answer: `💳 *Admission / Registration fee — ${school.schoolName}*\n\n` +
        `Once-off registration fee: *$${school.admissionFee}*\n\n` +
        (school.cautionMoney > 0 ? `Refundable caution deposit: *$${school.cautionMoney}*\n\n` : "") +
        `_This is paid once when a pupil is accepted and joins the school._\n📞 ${phone}`
    });
  }

  if (school.feeSchedulePdfUrl || school.profilePdfUrl) {
    defaults.push({ categoryId: "fees", id: "def_fees_pdf", order: o++, isDefault: true,
      question: "Can I get the fee schedule?",
      answer: "📄 The fee schedule PDF is available. Tap below to download it to WhatsApp.",
      pdfUrl: school.feeSchedulePdfUrl || school.profilePdfUrl,
      pdfLabel: `${school.schoolName} Fee Schedule`
    });
  }

  // ── ADMISSIONS ────────────────────────────────────────────────────────────
  o = 0;
  if (admOpen) {
    defaults.push({ categoryId: "admissions", id: "def_adm_open", order: o++, isDefault: true,
      question: "Are admissions open?",
      answer: `🟢 *Admissions are currently OPEN — ${school.schoolName}*\n\n` +
        (hasAppLink ? `Apply online:\n👉 ${school.registrationLink}\n\n` : "") +
        `Contact admissions to start the process.\n📞 ${phone}`
    });
  } else {
    defaults.push({ categoryId: "admissions", id: "def_adm_closed", order: o++, isDefault: true,
      question: "Are admissions open?",
      answer: `🔴 *Admissions are currently CLOSED — ${school.schoolName}*\n\nYou can register your interest and we will contact you when admissions open for the next intake.\n\nSend us a message below with your child's name and grade.`
    });
  }

  defaults.push({ categoryId: "admissions", id: "def_adm_docs", order: o++, isDefault: true,
    question: "What documents do I need?",
    answer: `📑 *Enrollment documents — ${school.schoolName}*\n\n` +
      (school.enrollmentDocs ||
       "• Child's birth certificate (certified copy)\n• Parents' national IDs or passports\n• Previous school report (last term)\n• Transfer letter (if from another school)\n• 4 passport-size photos of child\n• Proof of residence (utility bill)") +
      (hasBoarding ? "\n• Medical certificate (boarding pupils)" : "") +
      `\n\n_Bring originals and certified copies._\n📍 ${school.address || school.city}`
  });

  defaults.push({ categoryId: "admissions", id: "def_adm_age", order: o++, isDefault: true,
    question: "What are the age requirements?",
    answer: `🎂 *Age requirements — ${school.schoolName}*\n\n` +
      (school.ageRequirements ||
       "• ECD A: turning 3 by 1 March\n• ECD B: turning 4 by 1 March\n• Grade 1: turning 6 by 31 March\n• Grade 2+: according to previous school level\n\n_Requirements follow Zimbabwe Ministry of Education guidelines._")
  });

  if (hasAppLink) {
    defaults.push({ categoryId: "admissions", id: "def_adm_apply", order: o++, isDefault: true,
      question: "How do I apply online?",
      answer: `📋 *Apply online — ${school.schoolName}*\n\n${admOpen ? "🟢 Admissions are open." : "🔴 Admissions are closed — you may still register interest."}\n\nOnline application form:\n👉 ${school.registrationLink}\n\n📞 ${phone}`,
      actionType: "apply"
    });
  }

  defaults.push({ categoryId: "admissions", id: "def_adm_tour", order: o++, isDefault: true,
    question: "Can I visit the school?",
    answer: `📅 *School visits — ${school.schoolName}*\n\n` +
      (school.tourInfo || "School tours are available on weekdays by appointment. Tours take approximately 45 minutes and cover all key facilities.") +
      `\n\n📞 ${phone}\n⏰ ${school.officeHours || "Mon–Fri, 7am–4pm"}`,
    actionType: "tour"
  });

  // ── BOARDING ──────────────────────────────────────────────────────────────
  if (hasBoarding) {
    o = 0;
    const bf = school.fees;
    if (bf?.boardingTerm1 > 0) {
      defaults.push({ categoryId: "boarding", id: "def_brd_fees", order: o++, isDefault: true,
        question: "What are boarding fees?",
        answer: `🛏️ *Boarding fees — ${school.schoolName}*\n\n` +
          `Term 1: *$${bf.boardingTerm1}*` +
          (bf.boardingTerm2 ? ` | T2: *$${bf.boardingTerm2}*` : "") +
          (bf.boardingTerm3 ? ` | T3: *$${bf.boardingTerm3}*` : "") +
          `\n\n_Boarding fees are inclusive of accommodation and meals._`
      });
    }
    defaults.push({ categoryId: "boarding", id: "def_brd_info", order: o++, isDefault: true,
      question: "What does boarding include?",
      answer: `🏠 *Boarding facilities — ${school.schoolName}*\n\n` +
        (school.boardingInfo ||
         "Our boarding facility provides safe accommodation, meals, supervised prep, and pastoral care.\n\nContact us for the boarding application process and visiting days.\n📞 " + phone)
    });
    defaults.push({ categoryId: "boarding", id: "def_brd_apply", order: o++, isDefault: true,
      question: "How do I apply for boarding?",
      answer: `📋 *Boarding application — ${school.schoolName}*\n\n` +
        (school.boardingApplicationInfo ||
         `Contact admissions for the boarding application process and required documents.\n📞 ${phone}`)
    });
    defaults.push({ categoryId: "boarding", id: "def_brd_visit", order: o++, isDefault: true,
      question: "When are visiting days?",
      answer: `📅 *Visiting days — ${school.schoolName}*\n\n` +
        (school.visitingDays || `Contact the boarding master for the visiting day schedule.\n📞 ${phone}`)
    });
    if ((school.facilities || []).includes("medical_centre")) {
      defaults.push({ categoryId: "boarding", id: "def_brd_medical", order: o++, isDefault: true,
        question: "Is there a medical facility?",
        answer: `🏥 *Medical care — ${school.schoolName}*\n\nThe school has an on-site medical centre to care for boarding pupils. A nurse is on duty during school terms.\n📞 ${phone}`
      });
    }
  }

  // ── TRANSPORT ────────────────────────────────────────────────────────────
  if (hasTrans) {
    o = 0;
    defaults.push({ categoryId: "transport", id: "def_trans_routes", order: o++, isDefault: true,
      question: "What areas does transport cover?",
      answer: `🗺️ *Transport routes — ${school.schoolName}*\n\n` +
        (school.transportRoutes || `Contact the transport office for current routes and suburbs covered.\n📞 ${school.transportContact || phone}`)
    });
    defaults.push({ categoryId: "transport", id: "def_trans_cost", order: o++, isDefault: true,
      question: "How much does transport cost?",
      answer: `💵 *Transport fees — ${school.schoolName}*\n\n` +
        (school.transportFees || `Contact the transport office for current pricing.\n📞 ${school.transportContact || phone}`)
    });
    defaults.push({ categoryId: "transport", id: "def_trans_times", order: o++, isDefault: true,
      question: "What are the pick-up times?",
      answer: `⏰ *Transport times — ${school.schoolName}*\n\n` +
        (school.transportTimes || `Contact the transport coordinator for pick-up and drop-off times.\n📞 ${school.transportContact || phone}`)
    });
  }

  // ── ACADEMICS ────────────────────────────────────────────────────────────
  o = 0;
  if (r?.oLevelPassRate || r?.aLevelPassRate) {
    let resText = `📊 *Exam results — ${school.schoolName}*\n\n`;
    if (r.oLevelPassRate) {
      resText += `*ZIMSEC O-Level (${r.oLevelYear || "latest"}):*\nPass rate: *${r.oLevelPassRate}%*`;
      if (r.oLevel5Plus) resText += ` | 5+ subjects: *${r.oLevel5Plus}%*`;
      resText += "\n";
    }
    if (r.aLevelPassRate) {
      resText += `\n*A-Level (${r.aLevelYear || "latest"}):*\nPass rate: *${r.aLevelPassRate}%*`;
      if (r.universityEntry) resText += `\nUniversity entry: *${r.universityEntry}%*`;
      resText += "\n";
    }
    if (r.nationalRanking) resText += `\n🏆 National ranking: *#${r.nationalRanking}*`;
    defaults.push({ categoryId: "academics", id: "def_acad_results", order: o++, isDefault: true,
      question: "What are the exam results?",
      answer: resText
    });
  }

  if (hasCambridge) {
    defaults.push({ categoryId: "academics", id: "def_acad_cambridge", order: o++, isDefault: true,
      question: "Do you offer Cambridge?",
      answer: `📚 *Cambridge curriculum — ${school.schoolName}*\n\nYes, we offer the Cambridge International curriculum` +
        ((school.curriculum || []).includes("zimsec") ? " alongside ZIMSEC." : ".") +
        `\n\nContact us for subject offerings and registration.\n📞 ${phone}`
    });
  }

  if (hasZimsec && !hasCambridge) {
    defaults.push({ categoryId: "academics", id: "def_acad_zimsec", order: o++, isDefault: true,
      question: "What curriculum do you follow?",
      answer: `📘 *Curriculum — ${school.schoolName}*\n\nWe follow the ZIMSEC (Zimbabwe School Examinations Council) curriculum from Grade 1 through Form 6.\n\nWe prepare pupils for O-Level and A-Level national examinations.\n📞 ${phone}`
    });
  }

  if (r?.topSubjects) {
    defaults.push({ categoryId: "academics", id: "def_acad_subjects", order: o++, isDefault: true,
      question: "Which subjects perform best?",
      answer: `📘 *Top subjects — ${school.schoolName}*\n\n${r.topSubjects}`
    });
  }

  if (r?.universityInfo || r?.universityEntry) {
    defaults.push({ categoryId: "academics", id: "def_acad_uni", order: o++, isDefault: true,
      question: "How many pupils go to university?",
      answer: `🎓 *University placement — ${school.schoolName}*\n\n` +
        (r.universityInfo || (r.universityEntry ? `${r.universityEntry}% of Upper 6 pupils proceed to university education.` : ""))
    });
  }

  // ── FACILITIES ────────────────────────────────────────────────────────────
  o = 0;
  const FAC = Object.fromEntries((SCHOOL_FACILITIES || []).map(f => [f.id, f.label]));
  const facList = (school.facilities || []).map(id => FAC[id] || id).filter(Boolean);
  if (facList.length) {
    defaults.push({ categoryId: "facilities", id: "def_fac_list", order: o++, isDefault: true,
      question: "What facilities do you have?",
      answer: `🏊 *Facilities — ${school.schoolName}*\n\n${facList.join("\n")}`
    });
  }

  const EXT = Object.fromEntries((SCHOOL_EXTRAMURALACTIVITIES || []).map(e => [e.id, e.label]));
  const sportsList = (school.extramuralActivities || []).map(id => EXT[id] || id).filter(Boolean);
  if (sportsList.length) {
    defaults.push({ categoryId: "facilities", id: "def_fac_sports", order: o++, isDefault: true,
      question: "What sports and clubs are there?",
      answer: `⚽ *Sports & extramural — ${school.schoolName}*\n\n${sportsList.join(", ")}` +
        (school.sportsAchievements ? `\n\n${school.sportsAchievements}` : "")
    });
  }

  // ── UNIFORMS ─────────────────────────────────────────────────────────────
  o = 0;
  defaults.push({ categoryId: "uniforms", id: "def_uni_info", order: o++, isDefault: true,
    question: "Where can I get the uniform?",
    answer: `👕 *School uniform — ${school.schoolName}*\n\n` +
      (school.uniformInfo ||
       `Uniforms are available from the school tuck shop or an approved supplier.\nContact the school for the full list and current prices.\n📞 ${phone}`)
  });

  // ── CALENDAR ─────────────────────────────────────────────────────────────
  o = 0;
  defaults.push({ categoryId: "calendar", id: "def_cal_terms", order: o++, isDefault: true,
    question: "What are the term dates?",
    answer: `📆 *Term calendar — ${school.schoolName}*\n\n` +
      (school.termCalendar || `Contact the school for the current term calendar.\n📞 ${phone}`)
  });

  // ── CONTACT ───────────────────────────────────────────────────────────────
  o = 0;
  let contactText = `📞 *Contact — ${school.schoolName}*\n\n`;
  if (school.principalName) contactText += `Principal: *${school.principalName}*\n`;
  contactText += `\n📞 ${phone}`;
  if (school.email) contactText += `\n📧 ${school.email}`;
  if (school.website) contactText += `\n🌐 ${school.website}`;
  contactText += `\n\n📍 ${school.address || school.city}\n⏰ ${school.officeHours || "Mon–Fri, 7am–4pm"}`;

  defaults.push({ categoryId: "contact", id: "def_con_contact", order: o++, isDefault: true,
    question: "How do I contact the school?",
    answer: contactText
  });

  const brochures = school.brochures || [];
  const pdfDocs = [];
  if (school.profilePdfUrl) pdfDocs.push({ label: "School Prospectus", url: school.profilePdfUrl });
  if (school.feeSchedulePdfUrl) pdfDocs.push({ label: "Fee Schedule", url: school.feeSchedulePdfUrl });
  if (school.applicationFormUrl) pdfDocs.push({ label: "Application Form", url: school.applicationFormUrl });
  brochures.forEach(b => pdfDocs.push(b));

  if (pdfDocs.length) {
    defaults.push({ categoryId: "contact", id: "def_con_docs", order: o++, isDefault: true,
      question: "Can I download the prospectus?",
      answer: `📄 *Documents — ${school.schoolName}*\n\nAvailable documents:\n${pdfDocs.map(d => `• ${d.label}`).join("\n")}\n\nTap below to receive the document on WhatsApp.`,
      pdfUrl: pdfDocs[0]?.url,
      pdfLabel: pdfDocs[0]?.label,
      actionType: "docs"
    });
  }

  return defaults;
}

// Merge defaults with admin items for a category, sorted by order
// Defaults that have been overridden by admin items are deduplicated.
function _mergeItems(defaults, adminItems, categoryId) {
  const catDefaults  = defaults.filter(d => d.categoryId === categoryId && d.active !== false);
  const catAdmin     = adminItems.filter(a => a.categoryId === categoryId && a.active !== false);

  // Admin items that override a default (same id prefix or explicit override)
  const overriddenIds = new Set(catAdmin.map(a => a.overridesDefaultId).filter(Boolean));
  const visibleDefaults = catDefaults.filter(d => !overriddenIds.has(d.id));

  // Merge and sort by order
  return [...visibleDefaults, ...catAdmin].sort((a, b) => (a.order || 0) - (b.order || 0));
}

// Get active categories for this school (system categories + admin custom categories)
function _getCategories(school, defaults) {
  // Start with system categories that have at least one default or admin item
  const defaultCatIds = new Set(defaults.map(d => d.categoryId));
  const adminItems    = (school.faqItems || []).filter(f => f.active !== false);
  const adminCatIds   = new Set(adminItems.map(a => a.categoryId));

  // Admin-defined custom categories
  const adminCats = (school.faqCategories || [])
    .filter(c => c.active !== false)
    .sort((a, b) => (a.order || 0) - (b.order || 0));

  // System categories that are relevant + have content
  const systemCats = SYSTEM_CATEGORIES
    .filter(sc => {
      // Check if this school has a hidden override for this system category
      const adminCat = adminCats.find(ac => ac.id === sc.id);
      if (adminCat && adminCat.hidden) return false;
      // Show if has defaults or admin items
      return defaultCatIds.has(sc.id) || adminCatIds.has(sc.id);
    })
    .map(sc => {
      // Admin may have renamed a system category
      const adminCat = adminCats.find(ac => ac.id === sc.id);
      return {
        id:    sc.id,
        name:  adminCat?.name  || sc.name,
        emoji: adminCat?.emoji || sc.emoji,
        order: adminCat?.order ?? sc.order,
        isSystem: true
      };
    });

  // Pure admin-created categories (not in SYSTEM_CATEGORIES)
  const systemIds  = new Set(SYSTEM_CATEGORIES.map(s => s.id));
  const pureCats   = adminCats.filter(c => !systemIds.has(c.id));

  return [...systemCats, ...pureCats].sort((a, b) => (a.order || 0) - (b.order || 0));
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN ENTRY POINT — called when parent taps the school's ZimQuote bot link
// ─────────────────────────────────────────────────────────────────────────────
export async function showSchoolFAQMenu(from, schoolId, biz, saveBiz, { source = "direct", parentName = "" } = {}) {
  const school = await SchoolProfile.findById(schoolId).lean();
  if (!school) return sendText(from, "❌ School not found. Please try the link again.");

  SchoolProfile.findByIdAndUpdate(schoolId, { $inc: { monthlyViews: 1, zqLinkConversions: 1 } }).catch(() => {});
  _saveLead(from, school, "view", source, { parentName });
  await _sess(biz, saveBiz, "sfaq_menu", { faqSchoolId: String(schoolId), faqParentName: parentName, faqSource: source });

  const defaults   = _generateDefaults(school);
  const categories = _getCategories(school, defaults);

  const adm   = school.admissionsOpen ? "🟢 Admissions Open" : "🔴 Admissions Closed";
  const fee   = _feeText(school);
  const cur   = (school.curriculum || []).map(c => c.toUpperCase()).join("+") || "ZIMSEC";
  const TYPE  = { ecd:"ECD/Preschool", ecd_primary:"ECD+Primary", primary:"Primary", secondary:"Secondary", combined:"Combined" };
  const greet = parentName ? `Hi ${parentName.split(" ")[0]}! ` : "";

  await sendText(from,
    `🏫 *${school.schoolName}*${school.verified ? " ✅" : ""}\n` +
    `📍 ${school.suburb ? school.suburb + ", " : ""}${school.city}\n` +
    `${adm}${fee ? " · " + fee : ""} · ${TYPE[school.type] || "School"} · ${cur}\n\n` +
    `${greet}Welcome! I can help you with admissions, fees, and more.\n` +
    `What would you like to know?`
  );

  // Build category list (max 9 + send message = 10)
  const rows = categories.slice(0, 9).map(cat => ({
    id:          `sfaq_cat_${cat.id}_${schoolId}`,
    title:       `${cat.emoji} ${cat.name}`.slice(0, 24),
    description: _catDescription(cat.id, school, defaults)
  }));

  rows.push({ id: `sfaq_act_message_${schoolId}`, title: "✉️ Send a message", description: "Ask anything directly" });

  return sendList(from, "What would you like to know?", rows);
}

function _catDescription(catId, school, defaults) {
  const catDefs = defaults.filter(d => d.categoryId === catId);
  const adminItems = (school.faqItems || []).filter(a => a.categoryId === catId && a.active !== false);
  const total = catDefs.length + adminItems.length;
  const DESCS = {
    fees:       "Fees, payment, EcoCash",
    admissions: "Apply, documents, age guide",
    boarding:   "Costs, rules, visiting days",
    transport:  "Routes, suburbs, costs",
    academics:  "Results, subjects, curriculum",
    facilities: "Labs, pool, sports, clubs",
    uniforms:   "List, sizes, where to buy",
    calendar:   "Terms, exams, holidays",
    contact:    "Phone, email, documents"
  };
  return DESCS[catId] || `${total} question${total !== 1 ? "s" : ""}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// ACTION ROUTER
// ─────────────────────────────────────────────────────────────────────────────
export async function handleSchoolFAQAction({ from, action: a, biz, saveBiz }) {
  // Parse schoolId from the end of the action string
  const lastUs   = a.lastIndexOf("_");
  const schoolId = a.slice(lastUs + 1);
  const topic    = a.slice(5, lastUs); // strip "sfaq_" prefix

  if (!schoolId || schoolId.length !== 24) return false;

  await _sess(biz, saveBiz, biz?.sessionState || "sfaq_menu", { faqSchoolId: schoolId });

  // sfaq_cat_<catId>_<schoolId>
  if (topic.startsWith("cat_")) {
    const catId = topic.slice(4);
    return _showCategoryPage(from, schoolId, catId, 0, biz, saveBiz);
  }

  // sfaq_pg_<catId>_<page>_<schoolId>  — pagination
  if (topic.startsWith("pg_")) {
    const parts = topic.split("_");   // ["pg","catId","page"]
    const page  = parseInt(parts[parts.length - 1], 10) || 0;
    const catId = parts.slice(1, -1).join("_");
    return _showCategoryPage(from, schoolId, catId, page, biz, saveBiz);
  }

  // sfaq_q_<itemId>_<schoolId>  — show answer
  if (topic.startsWith("q_")) {
    const itemId = topic.slice(2);
    return _showAnswer(from, schoolId, itemId, biz, saveBiz);
  }

  // sfaq_act_<action>_<schoolId>  — specific action flows
  if (topic.startsWith("act_")) {
    const act = topic.slice(4);
    return _handleAction(from, schoolId, act, biz, saveBiz);
  }

  // sfaq_back_<schoolId>
  if (topic === "back") return showSchoolFAQMenu(from, schoolId, biz, saveBiz);

  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// CATEGORY PAGE — shows questions for a category, paginated
// ─────────────────────────────────────────────────────────────────────────────
async function _showCategoryPage(from, schoolId, catId, page, biz, saveBiz) {
  const school = await SchoolProfile.findById(schoolId).lean();
  if (!school) return false;

  const sid      = String(school._id);
  const defaults = _generateDefaults(school);
  const items    = _mergeItems(defaults, school.faqItems || [], catId);

  // Find category display info
  const adminCats  = (school.faqCategories || []);
  const sysCat     = SYSTEM_CATEGORIES.find(s => s.id === catId);
  const adminCat   = adminCats.find(c => c.id === catId);
  const catName    = adminCat?.name  || sysCat?.name  || catId;
  const catEmoji   = adminCat?.emoji || sysCat?.emoji || "❓";

  if (!items.length) {
    return sendButtons(from, {
      text: `${catEmoji} *${catName} — ${school.schoolName}*\n\nNo questions available in this section yet.\n\n📞 ${school.contactPhone || school.phone}`,
      buttons: [
        { id: `sfaq_act_message_${sid}`, title: _btn("✉️ Send a message") },
        { id: `sfaq_back_${sid}`,        title: _btn("⬅ Main menu") }
      ]
    });
  }

  const start = page * PAGE_SIZE;
  const slice = items.slice(start, start + PAGE_SIZE);

  const rows = slice.map(item => ({
    id:          `sfaq_q_${item.id}_${sid}`,
    title:       item.question.slice(0, 24),
    description: item.answer ? item.answer.slice(0, 72).replace(/\n/g, " ") : ""
  }));

  // Navigation
  const hasNext = start + PAGE_SIZE < items.length;
  const hasPrev = page > 0;
  const totalPages = Math.ceil(items.length / PAGE_SIZE);

  if (hasNext) rows.push({ id: `sfaq_pg_${catId}_${page + 1}_${sid}`, title: "➡ Next" });
  if (hasPrev) rows.push({ id: `sfaq_pg_${catId}_${page - 1}_${sid}`, title: "⬅ Previous" });
  rows.push({ id: `sfaq_back_${sid}`, title: "⬅ Main menu" });

  const pageLabel = totalPages > 1 ? ` (${page + 1}/${totalPages})` : "";

  return sendList(from, `${catEmoji} ${catName}${pageLabel} — ${school.schoolName}:`, rows.slice(0, 10));
}

// ─────────────────────────────────────────────────────────────────────────────
// SHOW ANSWER — serves any question (default or admin-created, same code path)
// ─────────────────────────────────────────────────────────────────────────────
async function _showAnswer(from, schoolId, itemId, biz, saveBiz) {
  const school = await SchoolProfile.findById(schoolId).lean();
  if (!school) return false;
  const sid = String(school._id);

  // Look in defaults first, then admin items
  const defaults  = _generateDefaults(school);
  const allDefaults = defaults;
  const adminItems = school.faqItems || [];

  const item = allDefaults.find(d => d.id === itemId)
             || adminItems.find(a => a.id === itemId);

  if (!item) return showSchoolFAQMenu(from, schoolId, biz, saveBiz);

  _saveLead(from, school, "faq_view", "whatsapp_link");

  // Send PDF if attached
  if (item.pdfUrl) {
    try {
      const { sendDocument } = await import("./metaSender.js");
      await sendDocument(from, {
        link:     item.pdfUrl,
        filename: ((item.pdfLabel || item.question).replace(/[^a-zA-Z0-9 ]/g, "").replace(/\s+/g, "_").slice(0, 40)) + ".pdf"
      });
    } catch (_) { /* fallback to text */ }
  }

  // Build context-aware action buttons based on the question
  const buttons = _getAnswerButtons(item, school, sid);

  return sendButtons(from, { text: item.answer, buttons });
}

function _getAnswerButtons(item, school, sid) {
  const btns = [];

  // Action-type-specific CTA
  if (item.actionType === "apply" && school.registrationLink) {
    btns.push({ id: `sfaq_act_apply_${sid}`, title: _btn("📋 Apply online") });
  }
  if (item.actionType === "tour") {
    btns.push({ id: `sfaq_act_tour_${sid}`, title: _btn("📅 Book a tour") });
  }
  if (item.actionType === "docs" && item.pdfUrl) {
    btns.push({ id: `sfaq_act_docs_${sid}`, title: _btn("📄 Get documents") });
  }

  // Category-smart CTAs
  const catId = item.categoryId;
  if (catId === "fees" && btns.length < 2) {
    btns.push({ id: `sfaq_act_apply_${sid}`, title: _btn("📝 Enquire now") });
  }
  if (catId === "admissions" && btns.length < 2) {
    btns.push({ id: `sfaq_act_tour_${sid}`, title: _btn("📅 Book a tour") });
  }

  // Always offer message and back
  if (btns.length < 2) btns.push({ id: `sfaq_act_message_${sid}`, title: _btn("✉️ Ask more") });
  btns.push({ id: `sfaq_back_${sid}`, title: _btn("⬅ Main menu") });

  return btns.slice(0, 3); // WhatsApp max 3 buttons
}

// ─────────────────────────────────────────────────────────────────────────────
// ACTION FLOWS
// ─────────────────────────────────────────────────────────────────────────────
async function _handleAction(from, schoolId, act, biz, saveBiz) {
  const school = await SchoolProfile.findById(schoolId).lean();
  if (!school) return false;
  const sid = String(school._id);
  const phone = school.contactPhone || school.phone;

  switch (act) {
    case "message":
      await _sess(biz, saveBiz, "sfaq_awaiting_message", { faqSchoolId: sid });
      return sendText(from,
        `✉️ *Send a message to ${school.schoolName}*\n\n` +
        `Type your question or message. The school will reply on WhatsApp.\n\n` +
        `_Type *cancel* to go back._`
      );

    case "tour":
      await _sess(biz, saveBiz, "sfaq_awaiting_tour_date", { faqSchoolId: sid });
      return sendText(from,
        `📅 *Book a school tour — ${school.schoolName}*\n\n` +
        `Type your preferred date and time:\n\n` +
        `_e.g. "Monday 9am", "Any weekday morning", "This Saturday"_\n` +
        `_Type *cancel* to go back._`
      );

    case "apply":
      notifySchoolApplicationInterest(school.phone, school.schoolName, from).catch(() => {});
      _saveLead(from, school, "apply", "whatsapp_link");
      if (school.registrationLink) {
        return sendButtons(from, {
          text: `📋 *Apply — ${school.schoolName}*\n\n` +
            (school.admissionsOpen ? "🟢 Admissions are OPEN.\n\n" : "🔴 Admissions closed — register interest.\n\n") +
            `Complete the online application form:\n👉 ${school.registrationLink}\n\n📞 ${phone}`,
          buttons: [
            { id: `sfaq_act_tour_${sid}`,    title: _btn("📅 Book a tour") },
            { id: `sfaq_back_${sid}`,         title: _btn("⬅ Main menu") }
          ]
        });
      }
      await _sess(biz, saveBiz, "sfaq_awaiting_grade", { faqSchoolId: sid });
      return sendText(from,
        `📝 *Enrollment enquiry — ${school.schoolName}*\n\n` +
        `Which grade are you enquiring for?\n\n` +
        `_e.g. "Grade 3", "Form 1", "ECD B"_\n_Type *cancel* to go back._`
      );

    case "docs": {
      _saveLead(from, school, "pdf", "whatsapp_link");
      const docs = [];
      if (school.profilePdfUrl)      docs.push({ label: "Prospectus",   url: school.profilePdfUrl });
      if (school.feeSchedulePdfUrl)  docs.push({ label: "Fee Schedule",  url: school.feeSchedulePdfUrl });
      if (school.applicationFormUrl) docs.push({ label: "Application",   url: school.applicationFormUrl });
      (school.brochures || []).forEach(b => docs.push(b));
      if (!docs.length) {
        return sendButtons(from, {
          text: `📄 No documents uploaded yet.\n\n📞 ${phone}`,
          buttons: [{ id: `sfaq_act_message_${sid}`, title: _btn("✉️ Request docs") }, { id: `sfaq_back_${sid}`, title: _btn("⬅ Main menu") }]
        });
      }
      const { sendDocument } = await import("./metaSender.js");
      let sent = 0;
      for (const doc of docs) {
        try {
          await sendDocument(from, { link: doc.url, filename: (doc.label || "Doc").replace(/[^a-zA-Z0-9 ]/g,"").replace(/\s+/g,"_") + ".pdf" });
          sent++;
        } catch (_) { /* ignore */ }
      }
      return sendButtons(from, {
        text: sent > 0 ? `📄 ${sent} document${sent > 1 ? "s" : ""} sent above. Tap to open.` : `📄 Contact school for documents.\n📞 ${phone}`,
        buttons: [{ id: `sfaq_act_apply_${sid}`, title: _btn("📋 Apply now") }, { id: `sfaq_back_${sid}`, title: _btn("⬅ Main menu") }]
      });
    }

    default:
      return showSchoolFAQMenu(from, schoolId, biz, saveBiz);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// STATE HANDLER — typed text in sfaq_ states
// ─────────────────────────────────────────────────────────────────────────────
export async function handleSchoolFAQState({ state, from, text, biz, saveBiz }) {
  if (!state?.startsWith("sfaq_")) return false;
  const schoolId = biz?.sessionData?.faqSchoolId;
  if (!schoolId) return false;

  const raw = (text || "").trim();
  if (["cancel", "back", "menu"].includes(raw.toLowerCase())) {
    await _sess(biz, saveBiz, "sfaq_menu");
    return showSchoolFAQMenu(from, schoolId, biz, saveBiz);
  }

  switch (state) {

    case "sfaq_awaiting_message": {
      if (raw.length < 3) return sendText(from, "Please type your message (at least 3 characters). Type *cancel* to go back.");
      const school = await SchoolProfile.findById(schoolId).lean();
      if (!school) return false;
      const sid = String(school._id);
      notifySchoolEnquiry(school.phone, school.schoolName, from, raw).catch(() => {});
      _saveLead(from, school, "enquiry", "whatsapp_link");
      SchoolProfile.findByIdAndUpdate(schoolId, { $inc: { inquiries: 1 } }).catch(() => {});
      await _sess(biz, saveBiz, "sfaq_menu");
      return sendButtons(from, {
        text: `✅ *Message sent to ${school.schoolName}*\n\n_"${raw}"_\n\nThey will reply on WhatsApp.\n📞 ${school.contactPhone || school.phone}`,
        buttons: [
          { id: `sfaq_act_tour_${sid}`,   title: _btn("📅 Book a tour") },
          { id: `sfaq_act_apply_${sid}`,  title: _btn("📝 Enquire") },
          { id: `sfaq_back_${sid}`,        title: _btn("⬅ Main menu") }
        ]
      });
    }

    case "sfaq_awaiting_tour_date": {
      if (raw.length < 3) return sendText(from, "Please enter a date, e.g. *Monday 9am*. Type *cancel* to go back.");
      const school = await SchoolProfile.findById(schoolId).lean();
      if (!school) return false;
      const sid = String(school._id);
      const pName = biz?.sessionData?.faqParentName || "";
      notifySchoolVisitRequest(school.phone, school.schoolName, pName || from, "WhatsApp Bot").catch(() => {});
      _saveLead(from, school, "visit", "whatsapp_link", { parentName: pName });
      await _sess(biz, saveBiz, "sfaq_menu");
      return sendButtons(from, {
        text: `✅ *Tour request sent!*\n\n*${school.schoolName}*\nPreferred: _${raw}_\n\nThey will confirm and send directions.\n📞 ${school.contactPhone || school.phone}`,
        buttons: [
          { id: `sfaq_act_apply_${sid}`, title: _btn("📋 Apply now") },
          { id: `sfaq_cat_fees_${sid}`,   title: _btn("💵 See fees") },
          { id: `sfaq_back_${sid}`,        title: _btn("⬅ Main menu") }
        ]
      });
    }

    case "sfaq_awaiting_grade": {
      const school = await SchoolProfile.findById(schoolId).lean();
      if (!school) return false;
      const sid = String(school._id);
      const pName = biz?.sessionData?.faqParentName || "";
      notifySchoolPlaceEnquiry(school.phone, school.schoolName, pName || from, raw, "WhatsApp Bot").catch(() => {});
      _saveLead(from, school, "place", "whatsapp_link", { parentName: pName, gradeInterest: raw });
      await _sess(biz, saveBiz, "sfaq_menu");
      const admText = school.admissionsOpen
        ? `🟢 *Admissions are OPEN.*\nYour enquiry for *${raw}* has been sent to ${school.schoolName}.`
        : `🔴 *Admissions are currently closed.*\nYour interest in *${raw}* has been recorded.`;
      return sendButtons(from, {
        text: `📝 *Enquiry received*\n\n${admText}`,
        buttons: [
          { id: `sfaq_act_tour_${sid}`,    title: _btn("📅 Book a tour") },
          { id: `sfaq_cat_fees_${sid}`,     title: _btn("💵 View fees") },
          { id: `sfaq_back_${sid}`,          title: _btn("⬅ Main menu") }
        ]
      });
    }

    default: return false;
  }
}