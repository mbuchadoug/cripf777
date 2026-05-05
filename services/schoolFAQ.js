// services/schoolFAQ.js
// ─── ZimQuote School - 24/7 Admissions Assistant ─────────────────────────────
//
// Fee data is read from school.schoolFees[] (canonical) with fallback to
// legacy school.feeSections and school.fees for older records.
//
// WHATSAPP LIMITS:
//   Button title:  ≤20 chars (enforced by _btn())
//   List row title: ≤24 chars
//   List rows: ≤10 per message
//   Reply buttons: ≤3 per message

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
// LEVEL METADATA - Zimbabwe school structure
// ─────────────────────────────────────────────────────────────────────────────
const LEVEL = {
  nursery:   { label: "Nursery",              short: "Nursery",    ageGuide: "age 3",    emoji: "🌱" },
  ecd_a:     { label: "ECD A",                short: "ECD A",      ageGuide: "age 4",    emoji: "🌱" },
  ecd_b:     { label: "ECD B",                short: "ECD B",      ageGuide: "age 5",    emoji: "🌿" },
  grade1_4:  { label: "Lower Primary (Gr 1–4)", short: "Grade 1–4", ageGuide: "ages 6–10",emoji: "📗" },
  grade5_7:  { label: "Upper Primary (Gr 5–7)", short: "Grade 5–7", ageGuide: "ages 11–13",emoji: "📗" },
  primary:   { label: "Primary (Gr 1–7)",      short: "Primary",   ageGuide: "ages 6–13", emoji: "📗" },
  form1_4:   { label: "O-Level (Form 1–4)",    short: "Form 1–4",  ageGuide: "ages 13–17",emoji: "📙" },
  form5_6:   { label: "A-Level (Form 5–6)",    short: "Form 5–6",  ageGuide: "ages 17–19",emoji: "📘" },
  boarding:  { label: "Boarding",              short: "Boarding",  ageGuide: "",          emoji: "🛏️" },
  transport: { label: "Transport",             short: "Transport", ageGuide: "",          emoji: "🚌" },
  all:       { label: "School-wide",           short: "All",       ageGuide: "",          emoji: "🏫" },
};

const MAX_BTN  = 20;
const PAGE_SIZE = 8;

function _btn(t)  { return (t || "").trim().slice(0, MAX_BTN); }

// ── Fee helpers ───────────────────────────────────────────────────────────────

// Get all tuition fee items from schoolFees, in display order
function _tuitionFees(school) {
  const sf = school.schoolFees || [];
  const TUITION_ORDER = ["nursery","ecd_a","ecd_b","grade1_4","grade5_7","primary","form1_4","form5_6"];
  return TUITION_ORDER
    .map(lvl => sf.find(f => f.appliesTo === lvl && f.feeType === "tuition" && f.amount > 0))
    .filter(Boolean);
}

// Get all boarding fee items
function _boardingFees(school) {
  return (school.schoolFees || []).filter(f => f.feeType === "boarding" && f.amount > 0);
}

// Get all levy/other fee items
function _levyFees(school) {
  const LEVY_TYPES = ["development","sports","it","library","exam","transport","other"];
  return (school.schoolFees || []).filter(f => LEVY_TYPES.includes(f.feeType) && f.amount > 0);
}

// Get once-off fees
function _onceOffFees(school) {
  return (school.schoolFees || []).filter(f => f.per === "once_off" && f.amount > 0);
}

// Representative fee for feeText display
function _feeText(school) {
  const sf = school.schoolFees || [];
  const PREF = ["grade5_7","grade1_4","primary","form1_4","ecd_b","ecd_a","nursery","form5_6"];
  for (const lvl of PREF) {
    const f = sf.find(x => x.appliesTo === lvl && x.feeType === "tuition" && x.amount > 0);
    if (f) return `$${f.amount}/term`;
  }
  if (school.fees?.term1 > 0) return `$${school.fees.term1}/term`;
  return { budget:"Under $300/term", mid:"$300–$800/term", premium:"$800+/term" }[school.feeRange] || null;
}

// Does the school have any fees entered?
function _hasFees(school) {
  return (school.schoolFees || []).some(f => f.amount > 0) ||
         (school.fees?.term1 > 0) ||
         Object.values(school.feeSections || {}).some(s => s?.day?.term1 > 0);
}

// Build fee schedule answer text
function _buildFeeAnswer(school) {
  const tuition  = _tuitionFees(school);
  const boarding = _boardingFees(school);
  const levies   = _levyFees(school);
  const onceOff  = _onceOffFees(school);

  let text = `💵 *Fee schedule - ${school.schoolName}*\n\n`;

  if (tuition.length > 0) {
    text += "*Tuition fees (per term):*\n";
    tuition.forEach(f => {
      const lv = LEVEL[f.appliesTo] || {};
      text += `${lv.emoji || "•"} ${f.label || lv.label}: *$${f.amount}*`;
      if (f.note) text += ` _(${f.note})_`;
      text += "\n";
    });
  }

  if (boarding.length > 0) {
    text += "\n*Boarding fees (per term):*\n";
    boarding.forEach(f => {
      text += `🛏️ ${f.label}: *$${f.amount}*`;
      if (f.note) text += ` _(${f.note})_`;
      text += "\n";
    });
  }

  if (levies.length > 0) {
    text += "\n*Annual levies:*\n";
    levies.forEach(f => {
      text += `• ${f.label}: $${f.amount}/${f.per.replace("_"," ")}`;
      if (f.note) text += ` _(${f.note})_`;
      text += "\n";
    });
  }

  if (onceOff.length > 0) {
    text += "\n*Once-off fees:*\n";
    onceOff.forEach(f => {
      text += `• ${f.label}: *$${f.amount}*`;
      if (f.note) text += ` _(${f.note})_`;
      text += "\n";
    });
  }

  // Fallback to legacy fees if no schoolFees
  if (!tuition.length && !boarding.length) {
    const fs = school.feeSections || {};
    const legacyLines = [];
    const SEC = {ecd:"ECD",lowerPrimary:"Lower Primary",upperPrimary:"Upper Primary",primary:"Primary",olevel:"O-Level",alevel:"A-Level"};
    for (const [k,v] of Object.entries(fs)) {
      if (v?.day?.term1 > 0) legacyLines.push(`${SEC[k]}: *$${v.day.term1}*/term`);
    }
    if (school.fees?.term1 > 0 && !legacyLines.length) {
      legacyLines.push(`Day fees: *$${school.fees.term1}*/term`);
    }
    if (legacyLines.length) {
      text += legacyLines.join("\n") + "\n";
    } else {
      text += `Contact us for the current fee schedule.\n📞 ${school.contactPhone || school.phone}\n`;
    }
  }

  text += "\n_All fees are in USD._";

  // Annual estimate
  const firstTuition = tuition[0]?.amount || school.fees?.term1 || 0;
  if (firstTuition > 0) {
    text += `\n💡 _Annual day estimate (3 terms): ~$${firstTuition * 3}_`;
  }

  return text;
}

async function _sess(biz, saveBiz, state, data = {}) {
  if (!biz || !saveBiz) return;
  biz.sessionState = state;
  biz.sessionData  = { ...(biz.sessionData || {}), ...data };
  try { await saveBiz(biz); } catch (_) {}
}

function _saveLead(from, school, action, source, extra = {}) {
  SchoolLead.create({
    schoolId: school._id, schoolPhone: school.phone,
    schoolName: school.schoolName, zqSlug: school.zqSlug || "",
    parentPhone: from.replace(/\D+/g,""),
    parentName: extra.parentName || "", gradeInterest: extra.gradeInterest || "",
    levelInterest: extra.levelInterest || "",
    actionType: action, source, waOpened: true, contacted: false
  }).catch(() => {});
}

// ─────────────────────────────────────────────────────────────────────────────
// SYSTEM CATEGORIES
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

// ─────────────────────────────────────────────────────────────────────────────
// DEFAULT QUESTION GENERATOR
// Reads school.schoolFees[] + profile and generates relevant preloaded Q&A.
// Admin Q&A is mixed in by _mergeItems() - parents see no distinction.
// ─────────────────────────────────────────────────────────────────────────────
function _generateDefaults(school) {
  const defaults = [];
  const phone     = school.contactPhone || school.phone;
  const hasBoarding  = school.boarding === "boarding" || school.boarding === "both";
  const hasTrans     = (school.facilities || []).includes("transport");
  const hasCambridge = (school.curriculum || []).includes("cambridge") ||
                       (school.curriculum || []).includes("cambridge_primary");
  const hasZimsec    = (school.curriculum || []).includes("zimsec") ||
                       !(school.curriculum || []).length;
  const admOpen      = school.admissionsOpen;
  const r            = school.academicResults || {};
  const pl           = school.preschoolLevels || {};

  // Tuition fees by level
  const tuitionFees  = _tuitionFees(school);
  const boardingFees = _boardingFees(school);
  const hasFees      = _hasFees(school);
  const feeText      = _feeText(school);

  let o = 0;

  // ════════════════════════════════════════════════════════════════════════════
  // FEES CATEGORY
  // ════════════════════════════════════════════════════════════════════════════

  // Full fee schedule (always shown if any fees exist)
  if (hasFees) {
    defaults.push({ categoryId:"fees", id:"def_fees_full", order:o++, isDefault:true,
      question: "What are the school fees?",
      answer: _buildFeeAnswer(school),
      pdfUrl: school.feeSchedulePdfUrl || undefined,
      pdfLabel: school.feeSchedulePdfUrl ? `${school.schoolName} Fee Schedule` : undefined
    });
  } else if (feeText) {
    defaults.push({ categoryId:"fees", id:"def_fees_range", order:o++, isDefault:true,
      question: "What are the school fees?",
      answer: `💵 *Fees - ${school.schoolName}*\n\nFee range: *${feeText}*\n\nContact us for the full fee schedule.\n📞 ${phone}`
    });
  }

  // Individual level fee questions - only for levels that exist
  // Preschool levels
  const preschoolFeeItems = tuitionFees.filter(f => ["nursery","ecd_a","ecd_b"].includes(f.appliesTo));
  for (const f of preschoolFeeItems) {
    const lv = LEVEL[f.appliesTo];
    defaults.push({ categoryId:"fees", id:`def_fees_${f.appliesTo}`, order:o++, isDefault:true,
      question: `${lv.emoji} How much is ${lv.short}?`,
      answer: `${lv.emoji} *${lv.label} fees - ${school.schoolName}*\n\n` +
        `Tuition: *$${f.amount} per term*\n` +
        (f.note ? `_${f.note}_\n` : "") +
        (boardingFees.length > 0 ? `\nBoarding fees are separate - tap "What are boarding fees?"\n` : "") +
        `\n📞 ${phone}`
    });
  }

  // Primary levels
  const primaryFeeItems = tuitionFees.filter(f => ["grade1_4","grade5_7","primary"].includes(f.appliesTo));
  if (primaryFeeItems.length === 1 && primaryFeeItems[0].appliesTo === "primary") {
    defaults.push({ categoryId:"fees", id:"def_fees_primary", order:o++, isDefault:true,
      question: "📗 How much is primary?",
      answer: `📗 *Primary fees - ${school.schoolName}*\n\nTuition: *$${primaryFeeItems[0].amount} per term*\n\n📞 ${phone}`
    });
  } else if (primaryFeeItems.length > 0) {
    for (const f of primaryFeeItems) {
      const lv = LEVEL[f.appliesTo];
      defaults.push({ categoryId:"fees", id:`def_fees_${f.appliesTo}`, order:o++, isDefault:true,
        question: `${lv.emoji} How much is ${lv.short}?`,
        answer: `${lv.emoji} *${lv.label} fees - ${school.schoolName}*\n\nTuition: *$${f.amount} per term*\n\n📞 ${phone}`
      });
    }
  }

  // Secondary levels
  const oLevel = tuitionFees.find(f => f.appliesTo === "form1_4");
  if (oLevel) {
    defaults.push({ categoryId:"fees", id:"def_fees_olevel", order:o++, isDefault:true,
      question: "📙 How much is O-Level?",
      answer: `📙 *O-Level fees (Form 1–4) - ${school.schoolName}*\n\nTuition: *$${oLevel.amount} per term*\n\n📞 ${phone}`
    });
  }
  const aLevel = tuitionFees.find(f => f.appliesTo === "form5_6");
  if (aLevel) {
    defaults.push({ categoryId:"fees", id:"def_fees_alevel", order:o++, isDefault:true,
      question: "📘 How much is A-Level?",
      answer: `📘 *A-Level fees (Form 5–6) - ${school.schoolName}*\n\nTuition: *$${aLevel.amount} per term*\n\n📞 ${phone}`
    });
  }

  // Payment methods
  const payMethods = school.paymentMethods?.length
    ? school.paymentMethods : ["EcoCash","InnBucks","Bank transfer","Cash at school"];
  defaults.push({ categoryId:"fees", id:"def_fees_pay", order:o++, isDefault:true,
    question: "How do I pay fees?",
    answer: `💳 *Payment - ${school.schoolName}*\n\n` +
      payMethods.map(m => `• ${m}`).join("\n") +
      (school.ecocashNumber ? `\n\n📲 EcoCash: *${school.ecocashNumber}*` : "") +
      (school.bankDetails   ? `\n🏦 ${school.bankDetails}` : "") +
      `\n\n_Use child's full name + grade as payment reference._`
  });

  // Discounts
  if (school.feeDiscounts || school.bursaryInfo) {
    defaults.push({ categoryId:"fees", id:"def_fees_disc", order:o++, isDefault:true,
      question: "Are discounts available?",
      answer: `🎁 *Discounts - ${school.schoolName}*\n\n` +
        (school.feeDiscounts || school.bursaryInfo)
    });
  }

  // Registration fee
  const regFee = (school.schoolFees || []).find(f => f.feeType === "registration" && f.amount > 0)
    || (school.admissionFee > 0 ? { amount: school.admissionFee, label: "Registration fee" } : null);
  if (regFee) {
    defaults.push({ categoryId:"fees", id:"def_fees_reg", order:o++, isDefault:true,
      question: "Is there a registration fee?",
      answer: `💳 *Registration fee - ${school.schoolName}*\n\n` +
        `${regFee.label || "Admission fee"}: *$${regFee.amount}* (once-off, paid on joining)\n\n` +
        (school.cautionMoney > 0 ? `Caution deposit (refundable): *$${school.cautionMoney}*\n\n` : "") +
        `📞 ${phone}`
    });
  }

  // ════════════════════════════════════════════════════════════════════════════
  // ADMISSIONS CATEGORY
  // ════════════════════════════════════════════════════════════════════════════
  o = 0;
  defaults.push({ categoryId:"admissions", id:"def_adm_status", order:o++, isDefault:true,
    question: "Are admissions open?",
    answer: admOpen
      ? `🟢 *Admissions OPEN - ${school.schoolName}*\n\n` +
        (school.registrationLink ? `Apply online:\n👉 ${school.registrationLink}\n\n` : "") +
        `Contact admissions to start the process.\n📞 ${phone}`
      : `🔴 *Admissions closed - ${school.schoolName}*\n\nRegister your interest and we'll contact you when admissions open.\n📞 ${phone}`
  });

  defaults.push({ categoryId:"admissions", id:"def_adm_docs", order:o++, isDefault:true,
    question: "What documents do I need?",
    answer: `📑 *Documents - ${school.schoolName}*\n\n` +
      (school.enrollmentDocs ||
       "• Child's birth certificate (certified copy)\n• Parents' national IDs or passports\n• Previous school report (last term)\n• Transfer letter (if from another school)\n• 4 passport photos of child\n• Proof of residence (utility bill)") +
      (hasBoarding ? "\n• Medical certificate (boarding pupils)" : "") +
      `\n\n_Bring originals + certified copies._\n📍 ${school.address || school.city}`
  });

  // Age guide per level
  const AGE_GUIDE = {
    nursery:  "• Nursery: turning 3 by 1 March",
    ecd_a:    "• ECD A: turning 4 by 1 March",
    ecd_b:    "• ECD B: turning 5 by 1 March (before Grade 1 the following year)",
    grade1_4: "• Grade 1: turning 6 by 31 March",
    primary:  "• Grade 1: turning 6 by 31 March\n• Grade 2+: according to previous school level",
    form1_4:  "• Form 1: completion of Grade 7 / primary school",
    form5_6:  "• Form 5: 5 O-Level passes at C or above (minimum)"
  };
  const levelKeys = tuitionFees.map(f => f.appliesTo);
  const ageLines = [...new Set(levelKeys)].map(k => AGE_GUIDE[k]).filter(Boolean);
  defaults.push({ categoryId:"admissions", id:"def_adm_age", order:o++, isDefault:true,
    question: "What are the age requirements?",
    answer: `🎂 *Age requirements - ${school.schoolName}*\n\n` +
      (school.ageRequirements || (ageLines.length ? ageLines.join("\n") : "Contact admissions for age requirements.")) +
      `\n\n_Per Zimbabwe Ministry of Education guidelines._`
  });

  // Preschool-specific admissions questions
  if (pl.nursery || tuitionFees.some(f => f.appliesTo === "nursery")) {
    defaults.push({ categoryId:"admissions", id:"def_adm_nursery", order:o++, isDefault:true,
      question: "🌱 How do I enroll for Nursery?",
      answer: `🌱 *Nursery enrollment - ${school.schoolName}*\n\n` +
        `Age: children turning 3 by 1 March\n\n` +
        (school.registrationLink ? `Apply online:\n👉 ${school.registrationLink}\n\n` : "") +
        `Required documents:\n• Birth certificate\n• Parent/guardian ID\n• Passport photo of child\n\n📞 ${phone}`
    });
  }
  if (pl.ecd_a || tuitionFees.some(f => f.appliesTo === "ecd_a")) {
    defaults.push({ categoryId:"admissions", id:"def_adm_ecd_a", order:o++, isDefault:true,
      question: "🌱 How do I enroll for ECD A?",
      answer: `🌱 *ECD A enrollment - ${school.schoolName}*\n\n` +
        `Age: children turning 4 by 1 March\n\n` +
        `Required documents:\n• Birth certificate (certified)\n• Parent/guardian ID\n• 2 passport photos\n• Proof of residence\n\n📞 ${phone}`
    });
  }
  if (pl.ecd_b || tuitionFees.some(f => f.appliesTo === "ecd_b")) {
    defaults.push({ categoryId:"admissions", id:"def_adm_ecd_b", order:o++, isDefault:true,
      question: "🌿 How do I enroll for ECD B?",
      answer: `🌿 *ECD B enrollment - ${school.schoolName}*\n\n` +
        `Age: children turning 5 by 1 March\n` +
        `_(ECD B is the year before Grade 1)_\n\n` +
        `Required documents:\n• Birth certificate (certified)\n• Parent/guardian ID\n• 2 passport photos\n• Proof of residence\n\n📞 ${phone}`
    });
  }

  if (school.registrationLink) {
    defaults.push({ categoryId:"admissions", id:"def_adm_apply", order:o++, isDefault:true,
      question: "How do I apply online?",
      answer: `📋 *Apply online - ${school.schoolName}*\n\n` +
        `${admOpen ? "🟢 Admissions are open." : "🔴 Closed - you may still register interest."}\n\n` +
        `👉 ${school.registrationLink}\n\n📞 ${phone}`,
      actionType: "apply"
    });
  }

  defaults.push({ categoryId:"admissions", id:"def_adm_tour", order:o++, isDefault:true,
    question: "Can I visit the school?",
    answer: `📅 *School tours - ${school.schoolName}*\n\n` +
      (school.tourInfo || "School tours are available on weekdays by appointment.") +
      `\n\n📞 ${phone}\n⏰ ${school.officeHours || "Mon–Fri, 7am–4pm"}`,
    actionType: "tour"
  });

  // ════════════════════════════════════════════════════════════════════════════
  // BOARDING CATEGORY (only if hasBoarding)
  // ════════════════════════════════════════════════════════════════════════════
  if (hasBoarding) {
    o = 0;
    if (boardingFees.length > 0) {
      let brdAnswer = `🛏️ *Boarding fees - ${school.schoolName}*\n\n`;
      boardingFees.forEach(f => {
        brdAnswer += `• ${f.label}: *$${f.amount}/term*\n`;
      });
      const caution = (school.schoolFees || []).find(f => f.feeType === "caution" && f.amount > 0);
      if (caution) brdAnswer += `\n💰 Caution deposit (refundable): *$${caution.amount}*`;
      brdAnswer += `\n\n_Boarding is inclusive of accommodation and meals._`;
      defaults.push({ categoryId:"boarding", id:"def_brd_fees", order:o++, isDefault:true,
        question: "What are boarding fees?",
        answer: brdAnswer
      });
    } else if ((school.fees?.boardingTerm1 || 0) > 0) {
      defaults.push({ categoryId:"boarding", id:"def_brd_fees", order:o++, isDefault:true,
        question: "What are boarding fees?",
        answer: `🛏️ *Boarding fees - ${school.schoolName}*\n\n$${school.fees.boardingTerm1}/term\n\n_Inclusive of accommodation and meals._`
      });
    } else {
      defaults.push({ categoryId:"boarding", id:"def_brd_fees_tbc", order:o++, isDefault:true,
        question: "What are boarding fees?",
        answer: `🛏️ *Boarding fees - ${school.schoolName}*\n\nBoarding fee information is available on request.\n📞 ${phone}`,
        actionType: "message"
      });
    }

    defaults.push({ categoryId:"boarding", id:"def_brd_info", order:o++, isDefault:true,
      question: "What does boarding include?",
      answer: `🏠 *Boarding - ${school.schoolName}*\n\n` +
        (school.boardingInfo || "Our boarding provides safe accommodation, meals, supervised evening prep, and pastoral care.\n\nContact us for the boarding application and requirements.") +
        `\n📞 ${phone}`
    });

    defaults.push({ categoryId:"boarding", id:"def_brd_apply", order:o++, isDefault:true,
      question: "How do I apply for boarding?",
      answer: `📋 *Boarding application - ${school.schoolName}*\n\n` +
        (school.boardingApplicationInfo || `Contact admissions for boarding application requirements.\n📞 ${phone}`)
    });

    defaults.push({ categoryId:"boarding", id:"def_brd_visits", order:o++, isDefault:true,
      question: "When are visiting days?",
      answer: `📅 *Visiting days - ${school.schoolName}*\n\n` +
        (school.visitingDays || `Contact the boarding master for the visiting day schedule.\n📞 ${phone}`)
    });
  }

  // ════════════════════════════════════════════════════════════════════════════
  // TRANSPORT CATEGORY (only if hasTrans)
  // ════════════════════════════════════════════════════════════════════════════
  if (hasTrans) {
    o = 0;
    const transFeeItem = (school.schoolFees || []).find(f => f.feeType === "transport" && f.amount > 0);
    defaults.push({ categoryId:"transport", id:"def_trans_routes", order:o++, isDefault:true,
      question: "What areas does transport cover?",
      answer: `🗺️ *Transport routes - ${school.schoolName}*\n\n` +
        (school.transportRoutes || `Contact the transport office for current routes.\n📞 ${school.transportContact || phone}`)
    });
    defaults.push({ categoryId:"transport", id:"def_trans_cost", order:o++, isDefault:true,
      question: "How much is school transport?",
      answer: `💵 *Transport fees - ${school.schoolName}*\n\n` +
        (transFeeItem ? `$${transFeeItem.amount}/${transFeeItem.per.replace("_"," ")}` :
         school.transportFees || `Contact the transport office for pricing.\n📞 ${school.transportContact || phone}`)
    });
    defaults.push({ categoryId:"transport", id:"def_trans_times", order:o++, isDefault:true,
      question: "What are the pick-up times?",
      answer: `⏰ *Transport times - ${school.schoolName}*\n\n` +
        (school.transportTimes || `Contact the transport coordinator for pick-up times.\n📞 ${school.transportContact || phone}`)
    });
  }

  // ════════════════════════════════════════════════════════════════════════════
  // ACADEMICS CATEGORY
  // ════════════════════════════════════════════════════════════════════════════
  o = 0;
  if (r.oLevelPassRate > 0 || r.aLevelPassRate > 0) {
    let resText = `📊 *Exam results - ${school.schoolName}*\n\n`;
    if (r.oLevelPassRate > 0) resText += `O-Level (${r.oLevelYear||"latest"}): *${r.oLevelPassRate}%* pass rate\n`;
    if (r.oLevel5Plus > 0)    resText += `5+ subjects: *${r.oLevel5Plus}%*\n`;
    if (r.aLevelPassRate > 0) resText += `\nA-Level (${r.aLevelYear||"latest"}): *${r.aLevelPassRate}%* pass rate\n`;
    if (r.cambridgePassRate > 0) resText += `Cambridge: *${r.cambridgePassRate}%* pass rate\n`;
    if (r.nationalRanking > 0) resText += `\n🏆 National ranking: *#${r.nationalRanking}*`;
    defaults.push({ categoryId:"academics", id:"def_acad_results", order:o++, isDefault:true,
      question: "What are the exam results?",
      answer: resText
    });
  }

  if (hasCambridge) {
    defaults.push({ categoryId:"academics", id:"def_acad_cambridge", order:o++, isDefault:true,
      question: "Do you offer Cambridge?",
      answer: `📚 *Cambridge - ${school.schoolName}*\n\nYes, we offer Cambridge International curriculum` +
        (hasZimsec ? " alongside ZIMSEC." : ".") + `\n\n📞 ${phone}`
    });
  }

  if (hasZimsec) {
    defaults.push({ categoryId:"academics", id:"def_acad_zimsec", order:o++, isDefault:true,
      question: "What curriculum do you follow?",
      answer: `📘 *Curriculum - ${school.schoolName}*\n\n` +
        (hasCambridge ? "We offer both ZIMSEC and Cambridge curricula." :
         "We follow the ZIMSEC curriculum, preparing pupils for O-Level and A-Level national examinations.") +
        `\n\n📞 ${phone}`
    });
  }

  if (aLevel || tuitionFees.find(f => f.appliesTo === "form5_6")) {
    defaults.push({ categoryId:"academics", id:"def_acad_alevel", order:o++, isDefault:true,
      question: "Do you offer A-Level?",
      answer: `📘 *A-Level - ${school.schoolName}*\n\nYes, we offer Form 5 and Form 6 (A-Level / Upper 6).\n\nContact admissions for subject offerings.\n📞 ${phone}`
    });
  }

  // ════════════════════════════════════════════════════════════════════════════
  // FACILITIES CATEGORY
  // ════════════════════════════════════════════════════════════════════════════
  o = 0;
  const FAC = Object.fromEntries((SCHOOL_FACILITIES||[]).map(f=>[f.id,f.label]));
  const facList = (school.facilities||[]).map(id=>FAC[id]||id).filter(Boolean);
  if (facList.length) {
    defaults.push({ categoryId:"facilities", id:"def_fac_list", order:o++, isDefault:true,
      question: "What facilities do you have?",
      answer: `🏊 *Facilities - ${school.schoolName}*\n\n${facList.join("\n")}`
    });
  }
  const EXT = Object.fromEntries((SCHOOL_EXTRAMURALACTIVITIES||[]).map(e=>[e.id,e.label]));
  const sportsList = (school.extramuralActivities||[]).map(id=>EXT[id]||id).filter(Boolean);
  if (sportsList.length) {
    defaults.push({ categoryId:"facilities", id:"def_fac_sports", order:o++, isDefault:true,
      question: "What sports and clubs are available?",
      answer: `⚽ *Sports & extramural - ${school.schoolName}*\n\n${sportsList.join(", ")}` +
        (school.sportsAchievements ? `\n\n${school.sportsAchievements}` : "")
    });
  }

  // ════════════════════════════════════════════════════════════════════════════
  // UNIFORMS CATEGORY
  // ════════════════════════════════════════════════════════════════════════════
  o = 0;
  const uniformFee = (school.schoolFees||[]).find(f=>f.feeType==="uniform"&&f.amount>0) ||
    (school.uniformEstimate > 0 ? { amount: school.uniformEstimate } : null);
  defaults.push({ categoryId:"uniforms", id:"def_uni_info", order:o++, isDefault:true,
    question: "Where do I get the uniform?",
    answer: `👕 *Uniform - ${school.schoolName}*\n\n` +
      (school.uniformInfo || `Uniforms are available from the school shop or an approved supplier.\n📞 ${phone}`) +
      (uniformFee ? `\n\n💡 Estimated uniform cost: ~$${uniformFee.amount}` : "")
  });

  // ════════════════════════════════════════════════════════════════════════════
  // CALENDAR CATEGORY
  // ════════════════════════════════════════════════════════════════════════════
  o = 0;
  defaults.push({ categoryId:"calendar", id:"def_cal_terms", order:o++, isDefault:true,
    question: "What are the term dates?",
    answer: `📆 *Term calendar - ${school.schoolName}*\n\n` +
      (school.termCalendar || `Contact the school for the current term calendar.\n📞 ${phone}`)
  });

  // ════════════════════════════════════════════════════════════════════════════
  // CONTACT CATEGORY
  // ════════════════════════════════════════════════════════════════════════════
  o = 0;
  let contactText = `📞 *Contact - ${school.schoolName}*\n\n`;
  if (school.principalName) contactText += `Principal: *${school.principalName}*\n`;
  contactText += `\n📞 ${phone}`;
  if (school.email)   contactText += `\n📧 ${school.email}`;
  if (school.website) contactText += `\n🌐 ${school.website}`;
  contactText += `\n\n📍 ${school.address || school.city}\n⏰ ${school.officeHours || "Mon–Fri, 7am–4pm"}`;
  defaults.push({ categoryId:"contact", id:"def_con_contact", order:o++, isDefault:true,
    question: "How do I contact the school?",
    answer: contactText
  });

  const allDocs = [
    school.profilePdfUrl && { label:"School Prospectus", url:school.profilePdfUrl },
    school.feeSchedulePdfUrl && { label:"Fee Schedule", url:school.feeSchedulePdfUrl },
    school.applicationFormUrl && { label:"Application Form", url:school.applicationFormUrl },
    ...(school.brochures||[]).map(b=>({ label:b.label, url:b.url }))
  ].filter(Boolean);

  if (allDocs.length) {
    defaults.push({ categoryId:"contact", id:"def_con_docs", order:o++, isDefault:true,
      question: "Can I download the prospectus?",
      answer: `📄 *Documents - ${school.schoolName}*\n\n${allDocs.map(d=>`• ${d.label}`).join("\n")}\n\nTap below to receive on WhatsApp.`,
      pdfUrl: allDocs[0]?.url,
      pdfLabel: allDocs[0]?.label,
      actionType: "docs"
    });
  }

  return defaults;
}

// ─────────────────────────────────────────────────────────────────────────────
// MERGE: defaults + admin items → sorted unified list (no labels)
// ─────────────────────────────────────────────────────────────────────────────
function _mergeItems(defaults, adminItems, categoryId) {
  const overridden = new Set(adminItems.map(a=>a.overridesDefaultId).filter(Boolean));
  const visibleDef = defaults.filter(d=>d.categoryId===categoryId && !overridden.has(d.id) && d.active!==false);
  const visibleAdm = adminItems.filter(a=>a.categoryId===categoryId && a.active!==false);
  return [...visibleDef, ...visibleAdm].sort((a,b)=>(a.order||0)-(b.order||0));
}

function _getCategories(school, defaults) {
  const defaultCatIds = new Set(defaults.map(d=>d.categoryId));
  const adminItems    = (school.faqItems||[]).filter(f=>f.active!==false);
  const adminCatIds   = new Set(adminItems.map(a=>a.categoryId));
  const adminCats     = (school.faqCategories||[]).filter(c=>c.active!==false).sort((a,b)=>(a.order||0)-(b.order||0));
  const systemIds     = new Set(SYSTEM_CATEGORIES.map(s=>s.id));

  const systemCats = SYSTEM_CATEGORIES
    .filter(sc => {
      const ov = adminCats.find(a=>a.id===sc.id);
      if (ov?.hidden) return false;
      return defaultCatIds.has(sc.id) || adminCatIds.has(sc.id);
    })
    .map(sc => {
      const ov = adminCats.find(a=>a.id===sc.id);
      return { id:sc.id, name:ov?.name||sc.name, emoji:ov?.emoji||sc.emoji, order:ov?.order??sc.order };
    });

  const pureCats = adminCats.filter(c=>!systemIds.has(c.id));
  return [...systemCats, ...pureCats].sort((a,b)=>(a.order||0)-(b.order||0));
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN ENTRY - parent taps school chatbot link
// ─────────────────────────────────────────────────────────────────────────────
export async function showSchoolFAQMenu(from, schoolId, biz, saveBiz, { source="direct", parentName="" } = {}) {
  const school = await SchoolProfile.findById(schoolId).lean();
  if (!school) return sendText(from,"❌ School not found. Please try the link again.");

  SchoolProfile.findByIdAndUpdate(schoolId,{$inc:{monthlyViews:1,zqLinkConversions:1}}).catch(()=>{});
  _saveLead(from, school, "view", source, { parentName });
  await _sess(biz, saveBiz, "sfaq_menu", { faqSchoolId:String(schoolId), faqParentName:parentName, faqSource:source });

  const defaults   = _generateDefaults(school);
  const categories = _getCategories(school, defaults);
  const feeText    = _feeText(school);
  const adm        = school.admissionsOpen ? "🟢 Open" : "🔴 Closed";
  const TYPE       = {ecd:"ECD/Preschool",ecd_primary:"ECD+Primary",primary:"Primary",secondary:"Secondary",combined:"Combined"};
  const cur        = (school.curriculum||[]).map(c=>c.toUpperCase()).join("+") || "ZIMSEC";
  const greet      = parentName ? `Hi ${parentName.split(" ")[0]}! ` : "";

  // Show preschool levels in header if school has them
  const pl = school.preschoolLevels || {};
  const preLevels = [pl.nursery&&"Nursery", pl.ecd_a&&"ECD A", pl.ecd_b&&"ECD B"].filter(Boolean);

  await sendText(from,
    `🏫 *${school.schoolName}*${school.verified?" ✅":""}\n` +
    `📍 ${school.suburb?school.suburb+", ":""}${school.city}\n` +
    `${adm}${feeText?" · "+feeText:""} · ${TYPE[school.type]||"School"} · ${cur}` +
    (preLevels.length ? `\n🌱 Preschool: ${preLevels.join(" · ")}` : "") +
    `\n\n${greet}Welcome! What would you like to know about ${school.schoolName}?`
  );

  const rows = categories.slice(0,9).map(cat => ({
    id:          `sfaq_cat_${cat.id}_${schoolId}`,
    title:       `${cat.emoji} ${cat.name}`.slice(0,24),
    description: _catDesc(cat.id, school, defaults)
  }));
  rows.push({ id:`sfaq_act_message_${schoolId}`, title:"✉️ Send a message", description:"Ask us anything directly" });

  return sendList(from,"What would you like to know?",rows);
}

function _catDesc(catId, school, defaults) {
  const DESCS = {
    fees:"Tuition, payment, levies", admissions:"Apply, documents, age guide",
    boarding:"Costs, rules, visiting", transport:"Routes, suburbs, pricing",
    academics:"Results, curriculum, A-Level", facilities:"Labs, pool, clubs",
    uniforms:"List, prices, supplier", calendar:"Terms, exams, holidays",
    contact:"Phone, email, documents"
  };
  return DESCS[catId] || `${defaults.filter(d=>d.categoryId===catId).length + (school.faqItems||[]).filter(a=>a.categoryId===catId).length} answers`;
}

// ─────────────────────────────────────────────────────────────────────────────
// ACTION ROUTER
// ─────────────────────────────────────────────────────────────────────────────
export async function handleSchoolFAQAction({ from, action:a, biz, saveBiz }) {
  const lastUs   = a.lastIndexOf("_");
  const schoolId = a.slice(lastUs+1);
  const topic    = a.slice(5,lastUs);
  if (!schoolId || schoolId.length!==24) return false;

  await _sess(biz, saveBiz, biz?.sessionState||"sfaq_menu", { faqSchoolId:schoolId });

  if (topic.startsWith("cat_"))  return _showCategoryPage(from, schoolId, topic.slice(4), 0, biz, saveBiz);
  if (topic.startsWith("pg_"))   {
    const parts = topic.split("_");
    const page  = parseInt(parts[parts.length-1],10)||0;
    const catId = parts.slice(1,-1).join("_");
    return _showCategoryPage(from, schoolId, catId, page, biz, saveBiz);
  }
  if (topic.startsWith("q_"))    return _showAnswer(from, schoolId, topic.slice(2), biz, saveBiz);
  if (topic.startsWith("act_"))  return _handleAction(from, schoolId, topic.slice(4), biz, saveBiz);
  if (topic === "back")          return showSchoolFAQMenu(from, schoolId, biz, saveBiz);
  return false;
}

async function _showCategoryPage(from, schoolId, catId, page, biz, saveBiz) {
  const school = await SchoolProfile.findById(schoolId).lean();
  if (!school) return false;
  const sid       = String(school._id);
  const defaults  = _generateDefaults(school);
  const items     = _mergeItems(defaults, school.faqItems||[], catId);
  const sysCat    = SYSTEM_CATEGORIES.find(s=>s.id===catId);
  const adminCat  = (school.faqCategories||[]).find(c=>c.id===catId);
  const catName   = adminCat?.name||sysCat?.name||catId;
  const catEmoji  = adminCat?.emoji||sysCat?.emoji||"❓";

  if (!items.length) {
    return sendButtons(from, {
      text:`${catEmoji} *${catName} - ${school.schoolName}*\n\nNo information available yet.\n\n📞 ${school.contactPhone||school.phone}`,
      buttons:[
        {id:`sfaq_act_message_${sid}`,title:_btn("✉️ Ask us directly")},
        {id:`sfaq_back_${sid}`,title:_btn("⬅ Main menu")}
      ]
    });
  }

  const start = page*PAGE_SIZE;
  const slice = items.slice(start, start+PAGE_SIZE);
  const rows  = slice.map(item=>({
    id:`sfaq_q_${item.id}_${sid}`,
    title:item.question.slice(0,24),
    description:item.answer?(item.answer.slice(0,72).replace(/\n/g," ")):""
  }));

  const hasNext = start+PAGE_SIZE < items.length;
  const hasPrev = page > 0;
  if (hasNext) rows.push({id:`sfaq_pg_${catId}_${page+1}_${sid}`,title:"➡ Next"});
  if (hasPrev) rows.push({id:`sfaq_pg_${catId}_${page-1}_${sid}`,title:"⬅ Previous"});
  rows.push({id:`sfaq_back_${sid}`,title:"⬅ Main menu"});

  const totalPages = Math.ceil(items.length/PAGE_SIZE);
  const pageLabel  = totalPages>1?` (${page+1}/${totalPages})`:"";
  return sendList(from,`${catEmoji} ${catName}${pageLabel} - ${school.schoolName}:`,rows.slice(0,10));
}

// ── Helper: send all attachments for a FAQ item (PDFs + images) ──────────────
// Send text answer first, then attachments one by one.
// PDFs → sendDocument; images (PNG/JPG/JPEG/WEBP) → sendImage (falls back to sendDocument)
async function _sendFaqAttachments(from, item) {
  const { sendDocument } = await import("./metaSender.js");

  // Try to get sendImage - may not be in metaSender yet; fall back gracefully
  let sendImage = null;
  try {
    const meta = await import("./metaSender.js");
    if (typeof meta.sendImage === "function") sendImage = meta.sendImage;
  } catch (_) {}

  const IMAGE_TYPES = ["image/png","image/jpeg","image/jpg","image/webp"];

  // Build unified attachment list: new attachments[] first, then legacy pdfUrl
  const attachments = [];

  // 1. New multi-attachment array
  for (const att of (item.attachments || [])) {
    if (!att.url && !att.fileId) continue;
    attachments.push({
      url:      att.url,
      label:    att.label || att.originalName || "Attachment",
      mimeType: att.mimeType || "",
      type:     att.type || "other",
      name:     att.originalName || att.label || "attachment"
    });
  }

  // 2. Legacy pdfUrl field (single PDF)
  if (!attachments.length && item.pdfUrl) {
    attachments.push({
      url:      item.pdfUrl,
      label:    item.pdfLabel || item.question || "Document",
      mimeType: "application/pdf",
      type:     "pdf",
      name:     ((item.pdfLabel || item.question || "document").replace(/[^a-zA-Z0-9 ]/g,"").replace(/\s+/g,"_").slice(0,40)) + ".pdf"
    });
  }

  for (const att of attachments) {
    try {
      const isImage = att.type === "image" || IMAGE_TYPES.includes(att.mimeType);
      const safeFilename = (att.name || att.label || "file")
        .replace(/[^a-zA-Z0-9._-]/g, "_")
        .slice(0, 60);

      if (isImage && sendImage) {
        // Send as WhatsApp image with caption
        try {
          await sendImage(from, { link: att.url, caption: att.label });
          continue;
        } catch (_) {
          // fall through to sendDocument
        }
      }

      // PDF or image fallback - send as document
      await sendDocument(from, {
        link:     att.url,
        filename: safeFilename,
        caption:  att.label
      });
    } catch (_) {
      // Don't let one failed attachment block the others
    }
  }
}

async function _showAnswer(from, schoolId, itemId, biz, saveBiz) {
  const school = await SchoolProfile.findById(schoolId).lean();
  if (!school) return false;
  const sid      = String(school._id);
  const defaults = _generateDefaults(school);
  const item     = defaults.find(d=>d.id===itemId) || (school.faqItems||[]).find(a=>a.id===itemId);
  if (!item) return showSchoolFAQMenu(from, schoolId, biz, saveBiz);

  _saveLead(from, school, "faq_view", "whatsapp_link");

  // 1. Send text answer first
  const buttons = _answerButtons(item, school, sid);
  await sendButtons(from, { text: item.answer, buttons });

  // 2. Send attachments after the text answer (non-blocking)
  const hasAttachments = (item.attachments && item.attachments.length > 0) || item.pdfUrl;
  if (hasAttachments) {
    _sendFaqAttachments(from, item).catch(() => {});
  }

  return true;
}

function _answerButtons(item, school, sid) {
  const btns = [];
  if (item.actionType==="apply" && school.registrationLink) btns.push({id:`sfaq_act_apply_${sid}`,title:_btn("📋 Apply online")});
  if (item.actionType==="tour")  btns.push({id:`sfaq_act_tour_${sid}`,title:_btn("📅 Book a tour")});
  if (item.actionType==="docs" && item.pdfUrl) btns.push({id:`sfaq_act_docs_${sid}`,title:_btn("📄 Get documents")});
  if (item.categoryId==="fees" && btns.length<2) btns.push({id:`sfaq_act_enquire_${sid}`,title:_btn("📝 Enquire now")});
  if (item.categoryId==="admissions" && btns.length<2) btns.push({id:`sfaq_act_tour_${sid}`,title:_btn("📅 Book a tour")});
  if (btns.length<2) btns.push({id:`sfaq_act_message_${sid}`,title:_btn("✉️ Ask more")});
  btns.push({id:`sfaq_back_${sid}`,title:_btn("⬅ Main menu")});
  return btns.slice(0,3);
}

async function _handleAction(from, schoolId, act, biz, saveBiz) {
  const school = await SchoolProfile.findById(schoolId).lean();
  if (!school) return false;
  const sid   = String(school._id);
  const phone = school.contactPhone || school.phone;

  switch (act) {
    case "message":
    case "enquire":
      await _sess(biz, saveBiz, "sfaq_awaiting_message", {faqSchoolId:sid});
      return sendText(from,`✉️ *Message - ${school.schoolName}*\n\nType your question. The school will reply on WhatsApp.\n\n_Type *cancel* to go back._`);

    case "tour":
      await _sess(biz, saveBiz, "sfaq_awaiting_tour_date", {faqSchoolId:sid});
      return sendText(from,`📅 *Book a tour - ${school.schoolName}*\n\nType your preferred date and time:\n\n_e.g. "Monday 9am", "Any weekday morning"_\n_Type *cancel* to go back._`);

    case "apply":
      notifySchoolApplicationInterest(school.phone,school.schoolName,from).catch(()=>{});
      _saveLead(from,school,"apply","whatsapp_link");
      if (school.registrationLink) {
        return sendButtons(from,{
          text:`📋 *Apply - ${school.schoolName}*\n\n${school.admissionsOpen?"🟢 Admissions OPEN.":"🔴 Closed - register interest."}\n\n👉 ${school.registrationLink}\n\n📞 ${phone}`,
          buttons:[{id:`sfaq_act_tour_${sid}`,title:_btn("📅 Book a tour")},{id:`sfaq_back_${sid}`,title:_btn("⬅ Main menu")}]
        });
      }
      await _sess(biz,saveBiz,"sfaq_awaiting_grade",{faqSchoolId:sid});
      return sendText(from,`📝 *Enrollment enquiry - ${school.schoolName}*\n\nWhich level are you enquiring for?\n\n_e.g. "Nursery", "ECD A", "Grade 3", "Form 1"_\n_Type *cancel* to go back._`);

    case "level_enquiry":
      // Shown as a list of available levels for targeted enquiry
      return _showLevelEnquiry(from, school, sid, biz, saveBiz);

    case "docs": {
      _saveLead(from,school,"pdf","whatsapp_link");
      const docs = [
        school.profilePdfUrl&&{label:"Prospectus",url:school.profilePdfUrl},
        school.feeSchedulePdfUrl&&{label:"Fee Schedule",url:school.feeSchedulePdfUrl},
        school.applicationFormUrl&&{label:"Application",url:school.applicationFormUrl},
        ...(school.brochures||[]).map(b=>({label:b.label,url:b.url}))
      ].filter(Boolean);
      if (!docs.length) return sendButtons(from,{text:`📄 No documents available yet.\n📞 ${phone}`,buttons:[{id:`sfaq_back_${sid}`,title:_btn("⬅ Main menu")}]});
      const {sendDocument} = await import("./metaSender.js");
      for (const d of docs) { try { await sendDocument(from,{link:d.url,filename:d.label.replace(/[^a-zA-Z0-9 ]/g,"").replace(/\s+/g,"_")+".pdf"}); } catch(_){} }
      return sendButtons(from,{text:`📄 Documents sent above. Tap to open.`,buttons:[{id:`sfaq_act_apply_${sid}`,title:_btn("📋 Apply now")},{id:`sfaq_back_${sid}`,title:_btn("⬅ Main menu")}]});
    }

    default: return showSchoolFAQMenu(from,schoolId,biz,saveBiz);
  }
}

// Level-specific enquiry - lists available school levels for parent to choose
async function _showLevelEnquiry(from, school, sid, biz, saveBiz) {
  const tuitionFees = _tuitionFees(school);
  const rows = tuitionFees.map(f => {
    const lv = LEVEL[f.appliesTo] || { label:f.label, emoji:"📚" };
    return { id:`sfaq_act_level_${f.appliesTo}_${sid}`, title:`${lv.emoji} ${lv.short||lv.label}`.slice(0,24), description:`$${f.amount}/term · ${lv.ageGuide}` };
  });
  if (!rows.length) {
    return _handleAction(from, sid, "message", biz, saveBiz);
  }
  rows.push({id:`sfaq_back_${sid}`,title:"⬅ Main menu"});
  return sendList(from,`Which level are you interested in?`,rows.slice(0,10));
}

// ─────────────────────────────────────────────────────────────────────────────
// STATE HANDLER
// ─────────────────────────────────────────────────────────────────────────────
export async function handleSchoolFAQState({ state, from, text, biz, saveBiz }) {
  if (!state?.startsWith("sfaq_")) return false;
  const schoolId = biz?.sessionData?.faqSchoolId;
  if (!schoolId) return false;
  const raw = (text||"").trim();
  if (["cancel","back","menu"].includes(raw.toLowerCase())) {
    await _sess(biz,saveBiz,"sfaq_menu");
    return showSchoolFAQMenu(from,schoolId,biz,saveBiz);
  }

  switch (state) {
    case "sfaq_awaiting_message": {
      if (raw.length<3) return sendText(from,"Please type your message. Type *cancel* to go back.");
      const school = await SchoolProfile.findById(schoolId).lean();
      if (!school) return false;
      const sid = String(school._id);
      notifySchoolEnquiry(school.phone,school.schoolName,from,raw).catch(()=>{});
      _saveLead(from,school,"enquiry","whatsapp_link");
      SchoolProfile.findByIdAndUpdate(schoolId,{$inc:{inquiries:1}}).catch(()=>{});
      await _sess(biz,saveBiz,"sfaq_menu");
      return sendButtons(from,{
        text:`✅ *Message sent to ${school.schoolName}*\n\n_"${raw}"_\n\nThey will reply on WhatsApp.\n📞 ${school.contactPhone||school.phone}`,
        buttons:[
          {id:`sfaq_act_tour_${sid}`,title:_btn("📅 Book a tour")},
          {id:`sfaq_act_level_enquiry_${sid}`,title:_btn("📚 Our levels")},
          {id:`sfaq_back_${sid}`,title:_btn("⬅ Main menu")}
        ]
      });
    }
    case "sfaq_awaiting_tour_date": {
      if (raw.length<3) return sendText(from,"Please enter a date, e.g. *Monday 9am*. Type *cancel* to go back.");
      const school = await SchoolProfile.findById(schoolId).lean();
      if (!school) return false;
      const sid = String(school._id);
      notifySchoolVisitRequest(school.phone,school.schoolName,biz?.sessionData?.faqParentName||from,"WhatsApp Bot").catch(()=>{});
      _saveLead(from,school,"visit","whatsapp_link");
      await _sess(biz,saveBiz,"sfaq_menu");
      return sendButtons(from,{
        text:`✅ *Tour request sent!*\n\n*${school.schoolName}*\nPreferred: _${raw}_\n\nThey will confirm and send directions.\n📞 ${school.contactPhone||school.phone}`,
        buttons:[
          {id:`sfaq_act_apply_${sid}`,title:_btn("📋 Apply now")},
          {id:`sfaq_cat_fees_${sid}`,title:_btn("💵 View fees")},
          {id:`sfaq_back_${sid}`,title:_btn("⬅ Main menu")}
        ]
      });
    }
    case "sfaq_awaiting_grade": {
      const school = await SchoolProfile.findById(schoolId).lean();
      if (!school) return false;
      const sid = String(school._id);
      notifySchoolPlaceEnquiry(school.phone,school.schoolName,biz?.sessionData?.faqParentName||from,raw,"WhatsApp Bot").catch(()=>{});
      _saveLead(from,school,"place","whatsapp_link",{gradeInterest:raw,levelInterest:raw});
      await _sess(biz,saveBiz,"sfaq_menu");
      return sendButtons(from,{
        text:`📝 *Enquiry received*\n\n${school.admissionsOpen?"🟢 Admissions OPEN. Your enquiry for *"+raw+"* has been sent.":"🔴 Admissions closed. Your interest in *"+raw+"* has been recorded."}`,
        buttons:[
          {id:`sfaq_act_tour_${sid}`,title:_btn("📅 Book a tour")},
          {id:`sfaq_cat_fees_${sid}`,title:_btn("💵 View fees")},
          {id:`sfaq_back_${sid}`,title:_btn("⬅ Main menu")}
        ]
      });
    }
    default: return false;
  }
}