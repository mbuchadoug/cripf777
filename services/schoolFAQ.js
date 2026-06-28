// services/schoolFAQ.js
// ─── ZimQuote School Smart Link ───────────────────────────────────────────────
// v3: instant smart card - no category menus, everything sent immediately.
//
// WHATSAPP LIMITS:
//   Button title:  ≤20 chars
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
// LEVEL METADATA
// ─────────────────────────────────────────────────────────────────────────────
const LEVEL = {
  nursery:   { label: "Nursery",                short: "Nursery",    ageGuide: "age 3",     emoji: "🌱" },
  ecd_a:     { label: "ECD A",                  short: "ECD A",      ageGuide: "age 4",     emoji: "🌱" },
  ecd_b:     { label: "ECD B",                  short: "ECD B",      ageGuide: "age 5",     emoji: "🌿" },
  grade1_4:  { label: "Lower Primary (Gr 1–4)", short: "Grade 1–4",  ageGuide: "ages 6–10", emoji: "📗" },
  grade5_7:  { label: "Upper Primary (Gr 5–7)", short: "Grade 5–7",  ageGuide: "ages 11–13",emoji: "📗" },
  primary:   { label: "Primary (Gr 1–7)",       short: "Primary",    ageGuide: "ages 6–13", emoji: "📗" },
  form1_4:   { label: "O-Level (Form 1–4)",     short: "Form 1–4",   ageGuide: "ages 13–17",emoji: "📙" },
  form5_6:   { label: "A-Level (Form 5–6)",     short: "Form 5–6",   ageGuide: "ages 17–19",emoji: "📘" },
  boarding:  { label: "Boarding",               short: "Boarding",   ageGuide: "",           emoji: "🛏️" },
  all:       { label: "School-wide",            short: "All",        ageGuide: "",           emoji: "🏫" },
};

const MAX_BTN = 20;
function _btn(t) { return (t || "").trim().slice(0, MAX_BTN); }

// ─────────────────────────────────────────────────────────────────────────────
// FEE HELPERS
// ─────────────────────────────────────────────────────────────────────────────
function _tuitionFees(school) {
  const sf = school.schoolFees || [];
  const ORDER = ["nursery","ecd_a","ecd_b","grade1_4","grade5_7","primary","form1_4","form5_6"];
  return ORDER
    .map(lvl => sf.find(f => f.appliesTo === lvl && f.feeType === "tuition" && f.amount > 0))
    .filter(Boolean);
}
function _boardingFees(school) {
  return (school.schoolFees || []).filter(f => f.feeType === "boarding" && f.amount > 0);
}
function _levyFees(school) {
  const LEVY = ["development","sports","it","library","exam","transport","other"];
  return (school.schoolFees || []).filter(f => LEVY.includes(f.feeType) && f.amount > 0);
}
function _onceOffFees(school) {
  return (school.schoolFees || []).filter(f => f.per === "once_off" && f.amount > 0);
}
function _hasFees(school) {
  return (school.schoolFees || []).some(f => f.amount > 0) ||
         (school.fees?.term1 > 0) ||
         Object.values(school.feeSections || {}).some(s => s?.day?.term1 > 0);
}
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

function _buildFeeBlock(school) {
  const tuition  = _tuitionFees(school);
  const boarding = _boardingFees(school);
  const levies   = _levyFees(school);
  const onceOff  = _onceOffFees(school);

  let text = `💵 *Fee Schedule - ${school.schoolName}*\n\n`;

  if (tuition.length > 0) {
    text += "*Tuition (per term):*\n";
    // If every tuition entry has the same amount, collapse to one line
    // using the school's actual grade range (e.g. "Form 1 - Form 6")
    const _amounts = [...new Set(tuition.map(f => f.amount))];
    if (_amounts.length === 1) {
      const _gFrom  = (school.grades?.from || "").trim();
      const _gTo    = (school.grades?.to   || "").trim();
      const _gLabel = (_gFrom && _gTo) ? `${_gFrom} – ${_gTo}` : "All Forms / Grades";
      text += `🏫 ${_gLabel}: *$${_amounts[0]}*\n`;
    } else {
      tuition.forEach(f => {
        const lv = LEVEL[f.appliesTo] || {};
        text += `${lv.emoji || "•"} ${f.label || lv.label}: *$${f.amount}*`;
        if (f.note) text += ` _(${f.note})_`;
        text += "\n";
      });
    }
  }
  if (boarding.length > 0) {
    text += "\n*Boarding (per term):*\n";
    boarding.forEach(f => {
      text += `🛏️ ${f.label}: *$${f.amount}*`;
      if (f.note) text += ` _(${f.note})_`;
      text += "\n";
    });
  }
  if (levies.length > 0) {
    text += "\n*Levies:*\n";
    levies.forEach(f => {
      text += `• ${f.label}: $${f.amount}/${f.per.replace("_"," ")}`;
      if (f.note) text += ` _(${f.note})_`;
      text += "\n";
    });
  }
  if (onceOff.length > 0) {
    text += "\n*Once-off:*\n";
    onceOff.forEach(f => {
      text += `• ${f.label}: *$${f.amount}*`;
      if (f.note) text += ` _(${f.note})_`;
      text += "\n";
    });
  }

  // Legacy fallback
  if (!tuition.length && !boarding.length) {
    const fs = school.feeSections || {};
    const SEC = {ecd:"ECD",lowerPrimary:"Lower Primary",upperPrimary:"Upper Primary",
                 primary:"Primary",olevel:"O-Level",alevel:"A-Level"};
    const lines = [];
    for (const [k,v] of Object.entries(fs)) {
      if (v?.day?.term1 > 0) lines.push(`${SEC[k] || k}: *$${v.day.term1}*/term`);
    }
    if (!lines.length && school.fees?.term1 > 0) {
      lines.push(`Day fees: *$${school.fees.term1}*/term`);
    }
    if (lines.length) text += lines.join("\n") + "\n";
    else text += `Contact us for the current fee schedule.\n📞 ${school.contactPhone || school.phone}\n`;
  }

  text += "\n_All fees in USD._";
  const firstTuition = tuition[0]?.amount || school.fees?.term1 || 0;
  // Annual estimate line removed - boarding schools have different day/boarding totals
  if (school.ecocashNumber) text += `\n📲 EcoCash: *${school.ecocashNumber}*`;
  if (school.bankDetails)   text += `\n🏦 ${school.bankDetails}`;

  return text;
}

// ─────────────────────────────────────────────────────────────────────────────
// COLLECT ALL DOCUMENTS for this school
// Reads from every location documents can be stored:
//   - school.profilePdfUrl
//   - school.feeSchedulePdfUrl
//   - school.applicationFormUrl  (legacy top-level)
//   - school.applicationForm.rawFormUrl  (WhatsApp/web form PDF)
//   - school.applicationForm.brochureUrl (brochure stored via apply-qr page)
//   - school.brochures[]  (PDFs uploaded via Brochures panel)
// ─────────────────────────────────────────────────────────────────────────────
function _getAllDocs(school) {
  const af = school.applicationForm || {};
  return [
    school.profilePdfUrl       && { label: "School Prospectus",  url: school.profilePdfUrl },
    school.feeSchedulePdfUrl   && { label: "Fee Schedule",        url: school.feeSchedulePdfUrl },
    // applicationForm.brochureUrl - set via the Apply QR / Application Form Settings page
    af.brochureUrl             && { label: af.brochureName || "School Brochure", url: af.brochureUrl },
    // applicationForm.rawFormUrl - printable application form PDF
    af.rawFormUrl              && { label: af.rawFormName  || "Application Form", url: af.rawFormUrl },
    // legacy top-level applicationFormUrl
    (!af.rawFormUrl && school.applicationFormUrl)
                               && { label: "Application Form",    url: school.applicationFormUrl },
    // brochures[] - PDFs uploaded via the Brochures panel
    ...(school.brochures || []).map(b => ({ label: b.label || "School Brochure", url: b.url }))
  ].filter(Boolean);
}

// SESSION HELPER
async function _sess(biz, saveBiz, state, data = {}, from = null) {
  if (from) {
    try {
      const phone = String(from).replace(/\D+/g,"");
      const { default: UserSession } = await import("../models/userSession.js");
      const setFields = { "tempData.sfaqState": state };
      if (data.faqSchoolId)   setFields["tempData.sfaqSchoolId"]   = data.faqSchoolId;
      if (data.faqCategoryId) setFields["tempData.sfaqCategoryId"] = data.faqCategoryId;
      if (data.faqParentName) setFields["tempData.sfaqParentName"] = data.faqParentName;
      if (data.faqSource)     setFields["tempData.sfaqSource"]     = data.faqSource;
      await UserSession.findOneAndUpdate({ phone }, { $set: setFields }, { upsert: true });
    } catch (_) {}
  }
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
// MAIN ENTRY - called when parent opens ZQ:SCHOOL:<id> link
// Sends everything immediately. Zero navigation required.
// ─────────────────────────────────────────────────────────────────────────────
export async function showSchoolFAQMenu(from, schoolId, biz, saveBiz, { source = "direct", parentName = "" } = {}) {
  const school = await SchoolProfile.findById(schoolId).lean();
  if (!school) return sendText(from, "❌ School not found. Please try the link again.");

  SchoolProfile.findByIdAndUpdate(schoolId, { $inc: { monthlyViews: 1, zqLinkConversions: 1 } }).catch(() => {});
  _saveLead(from, school, "view", source, { parentName });
  await _sess(biz, saveBiz, "sfaq_menu", { faqSchoolId: String(schoolId), faqParentName: parentName, faqSource: source }, from);

  const sid   = String(school._id);
  const phone = school.contactPhone || school.phone;
  const adm   = school.admissionsOpen ? "🟢 Admissions OPEN" : "🔴 Admissions closed";

  const TYPE = {
    ecd: "ECD / Preschool", ecd_primary: "ECD + Primary",
    primary: "Primary", secondary: "Secondary", combined: "Combined"
  };
  const cur = (school.curriculum || []).map(c => c.toUpperCase()).join(" + ") || "ZIMSEC";
  const pl  = school.preschoolLevels || {};
  const preLevels = [pl.nursery && "Nursery", pl.ecd_a && "ECD A", pl.ecd_b && "ECD B"].filter(Boolean);

  const r = school.academicResults || {};
  const resultLine = r.oLevelPassRate > 0
    ? `🏆 O-Level ${r.oLevelYear || ""}: *${r.oLevelPassRate}%* pass rate${r.nationalRanking > 0 ? ` · Ranked #${r.nationalRanking} nationally` : ""}`
    : "";

  const FAC = Object.fromEntries((SCHOOL_FACILITIES || []).map(f => [f.id, f.label]));
  const facList = (school.facilities || []).map(id => FAC[id] || id).filter(Boolean);
  const facLine = facList.length ? `🏫 ${facList.join(" · ")}` : "";

  const EXT = Object.fromEntries((SCHOOL_EXTRAMURALACTIVITIES || []).map(e => [e.id, e.label]));
  const extList = (school.extramuralActivities || []).map(id => EXT[id] || id).filter(Boolean);
  const extLine = extList.length ? `⚽ ${extList.join(", ")}` : "";

  const feeText = _feeText(school);

  // ── MESSAGE 0: School description / pitch ──────────────────────────
  // Sent FIRST, above everything else, so parents see the school pitch/announcement
  // prominently before the identity card. Reads from:
  //   1. school.smartLinkPitch  - set via the "Smart Link" panel in schoolAdmin.js
  //   2. school.description     - set via "Edit School Profile" in supplierAdmin.js
  //   3. Nothing - falls through to auto-highlights inline in msg1
  const _pitch = (school.smartLinkPitch || school.description || "").trim();
  if (_pitch) {
    const _pitchMsg = (parentName ? `Hi ${parentName.split(" ")[0]}! 👋\n\n` : "") + _pitch;
    await sendText(from, _pitchMsg);
  }

  // ── MESSAGE 1: Identity card ────────────────────────────────────────────
  let msg1 = `🏫 *${school.schoolName}*${school.verified ? " ✅" : ""}\n`;
  msg1 += `📍 ${school.suburb ? school.suburb + ", " : ""}${school.city}\n`;
  msg1 += `${adm}${feeText ? " · " + feeText : ""} · ${TYPE[school.type] || "School"} · ${cur}`;
  if (preLevels.length) msg1 += `\n🌱 Preschool: ${preLevels.join(" · ")}`;
  if (school.grades?.from && school.grades?.to) msg1 += `\n📚 Grades: ${school.grades.from} – ${school.grades.to}`;
  if (school.boarding === "boarding" || school.boarding === "both") msg1 += " · 🛏️ Boarding";

  // Always show facilities, extramural & results in msg1 as factual highlights
  // The pitch/description (msg0) is marketing text - these are separate factual data
  {
    const lines = [];
    if (resultLine) lines.push(resultLine);
    if (facLine)    lines.push(facLine);
    if (extLine)    lines.push(extLine);
    if (school.principalName) lines.push(`👤 Principal: ${school.principalName}`);
    if (lines.length) msg1 += "\n\n" + lines.join("\n");
  }

  // ── Contact number: school public number only ───────────
  // notificationContacts[] is for internal delivery alerts only -
  // those numbers are system/admin numbers, NOT shown to parents.
  const _fmtPhone = p => (p || "").startsWith("263") ? "0" + p.slice(3) : p;
  msg1 += `\n\n📞 ${_fmtPhone(phone)}`;
    if (school.email)       msg1 += `  📧 ${school.email}`;
  if (school.website)     msg1 += `\n🌐 ${school.website}`;
  if (school.address)     msg1 += `\n📍 ${school.address}`;
  if (school.officeHours) msg1 += `\n⏰ ${school.officeHours}`;

  // Prepend greeting here only if no pitch was sent (pitch carries its own greeting)
  if (!_pitch && parentName) msg1 = `Hi ${parentName.split(" ")[0]}! 👋\n\n` + msg1;

  await sendText(from, msg1);

  // ── MESSAGE 2: Fee schedule ─────────────────────────────────────────────────
  if (_hasFees(school)) {
    await sendText(from, _buildFeeBlock(school));
  }

  // ── MESSAGE 3: Flyers as WhatsApp images ────────────────────────────────────
  const flyers = school.smartLinkFlyers || [];
  if (flyers.length > 0) {
    let sendImage = null;
    try {
      const meta = await import("./metaSender.js");
      if (typeof meta.sendImage === "function") sendImage = meta.sendImage;
    } catch (_) {}

    for (const flyer of flyers) {
      if (!flyer.url) continue;
      try {
        if (sendImage) {
          try {
            await sendImage(from, { imageUrl: flyer.url, caption: flyer.label || school.schoolName });
            continue;
          } catch (_) {}
        }
        const { sendDocument } = await import("./metaSender.js");
        await sendDocument(from, {
          link:     flyer.url,
          filename: (flyer.label || "flyer").replace(/[^a-zA-Z0-9 ]/g, "_").slice(0, 40) + ".jpg",
          caption:  flyer.label || school.schoolName
        });
      } catch (_) {}
    }
  }

  // ── MESSAGE 4: All documents (PDFs + brochures) ─────────────────────────────
  // Reads from ALL storage locations: profilePdfUrl, feeSchedulePdfUrl,
  // applicationForm.brochureUrl, applicationForm.rawFormUrl, brochures[]
  const allDocs = _getAllDocs(school);
  if (allDocs.length > 0) {
    const { sendDocument } = await import("./metaSender.js");
    for (const doc of allDocs) {
      if (!doc.url) continue;
      try {
        const safeName = (doc.label || "document")
          .replace(/[^a-zA-Z0-9 ]/g, "")
          .replace(/\s+/g, "_")
          .slice(0, 40);
        // Detect if it's an image by URL extension or mime
        const isImage = /\.(jpg|jpeg|png|webp)$/i.test(doc.url);
        if (isImage) {
          let sendImage = null;
          try {
            const meta = await import("./metaSender.js");
            if (typeof meta.sendImage === "function") sendImage = meta.sendImage;
          } catch (_) {}
          if (sendImage) {
            try { await sendImage(from, { imageUrl: doc.url, caption: doc.label }); continue; } catch (_) {}
          }
        }
        await sendDocument(from, {
          link:     doc.url,
          filename: safeName + (isImage ? ".jpg" : ".pdf"),
          caption:  doc.label
        });
      } catch (_) {}
    }
  }

  // ── MESSAGE 5: Action buttons ────────────────────────────────────────────────
  const applyBtn = school.admissionsOpen
    ? { id: `sfaq_act_apply_${sid}`,    title: _btn("📋 Apply Now") }
    : { id: `sfaq_act_interest_${sid}`, title: _btn("📝 Register Interest") };

  const actionText = school.admissionsOpen
    ? `${school.schoolName} is *accepting applications* for ${school.applicationForm?.intakeYear || "the next intake"}.\n\nTap *Apply Now* to start your application, book a tour to visit us, or send us a message.`
    : `*${school.schoolName}* admissions are currently closed.\n\nTap *Register Interest* to be notified when we open, book a tour, or ask us a question.`;

  return sendButtons(from, {
    text: actionText,
    buttons: [
      applyBtn,
      { id: `sfaq_act_tour_${sid}`,    title: _btn("📅 Book a Tour") },
      { id: `sfaq_act_message_${sid}`, title: _btn("✉️ Ask a Question") }
    ]
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// ACTION ROUTER
// ─────────────────────────────────────────────────────────────────────────────
export async function handleSchoolFAQAction({ from, action, biz, saveBiz }) {
  const a = String(action || "").trim();
  if (!a.startsWith("sfaq_")) return false;

  // Back to smart card
  const backMatch = a.match(/^sfaq_back_([a-f0-9]{24})$/i);
  if (backMatch) {
    return showSchoolFAQMenu(from, backMatch[1], biz, saveBiz);
  }

  // Action buttons: sfaq_act_<act>_<schoolId>
  const actMatch = a.match(/^sfaq_act_([a-zA-Z0-9_-]+)_([a-f0-9]{24})$/i);
  if (actMatch) {
    const act      = actMatch[1];
    const schoolId = actMatch[2];
    await _sess(biz, saveBiz, "sfaq_menu", { faqSchoolId: schoolId }, from);
    return _handleAction(from, schoolId, act, biz, saveBiz);
  }

  // Legacy category / item / page taps - redirect to smart card
  const catMatch  = a.match(/^sfaq_cat_([a-zA-Z0-9_-]+)_([a-f0-9]{24})$/i);
  const itemMatch = a.match(/^sfaq_item_(.+)_([a-f0-9]{24})$/i);
  const pageMatch = a.match(/^sfaq_page_([a-zA-Z0-9_-]+)_(\d+)_([a-f0-9]{24})$/i);
  if (catMatch)  return showSchoolFAQMenu(from, catMatch[2],  biz, saveBiz);
  if (itemMatch) return showSchoolFAQMenu(from, itemMatch[2], biz, saveBiz);
  if (pageMatch) return showSchoolFAQMenu(from, pageMatch[3], biz, saveBiz);

  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// ACTION HANDLERS
// ─────────────────────────────────────────────────────────────────────────────
async function _handleAction(from, schoolId, act, biz, saveBiz) {
  const school = await SchoolProfile.findById(schoolId).lean();
  if (!school) return false;
  const sid   = String(school._id);
  const phone = school.contactPhone || school.phone;

  switch (act) {

    case "message":
    case "enquire":
      await _sess(biz, saveBiz, "sfaq_awaiting_message", { faqSchoolId: sid }, from);
      return sendText(from,
        `✉️ *Message ${school.schoolName}*\n\nType your question - the school will reply on WhatsApp.\n\n_Type *cancel* to go back._`
      );

    case "tour":
      await _sess(biz, saveBiz, "sfaq_awaiting_tour_date", { faqSchoolId: sid }, from);
      return sendText(from,
        `📅 *Book a Tour - ${school.schoolName}*\n\nType your preferred date and time:\n\n_e.g. "Monday 9am", "Any weekday morning"_\n\n_Type *cancel* to go back._`
      );

    case "apply": {
      notifySchoolApplicationInterest(school.phone, school.schoolName, from).catch(() => {});
      _saveLead(from, school, "apply", "whatsapp_link");

      if (school.registrationLink) {
        return sendButtons(from, {
          text:
            `📋 *Apply to ${school.schoolName}*\n\n` +
            `${school.admissionsOpen ? "🟢 Admissions OPEN." : "🔴 Admissions closed - you can still register interest."}\n\n` +
            `👉 *${school.registrationLink}*\n\n📞 ${phone}`,
          buttons: [
            { id: `sfaq_act_tour_${sid}`,    title: _btn("📅 Book a Tour") },
            { id: `sfaq_act_message_${sid}`, title: _btn("✉️ Ask a Question") }
          ]
        });
      }

      if (school.applicationForm?.active) {
        try {
          const { startSchoolApplicationForm } = await import("./schoolApplicationForm.js");
          const { default: UserSession } = await import("../models/userSession.js");
          await startSchoolApplicationForm({ from, school, UserSession });
          return true;
        } catch (_) {}
      }

      await _sess(biz, saveBiz, "sfaq_awaiting_grade", { faqSchoolId: sid }, from);
      return sendText(from,
        `📝 *Apply - ${school.schoolName}*\n\nWhich level or grade are you enquiring for?\n\n_e.g. "Grade 1", "Form 1", "ECD B"_\n\n_Type *cancel* to go back._`
      );
    }

    case "interest":
      await _sess(biz, saveBiz, "sfaq_awaiting_grade", { faqSchoolId: sid }, from);
      return sendText(from,
        `📝 *Register Interest - ${school.schoolName}*\n\nWe'll notify you when admissions open.\n\nWhich grade or level are you interested in?\n\n_e.g. "Grade 1", "Form 1", "ECD B"_\n_Type *cancel* to go back._`
      );

    case "docs": {
      _saveLead(from, school, "pdf", "whatsapp_link");
      const docs = _getAllDocs(school);
      if (!docs.length) {
        return sendButtons(from, {
          text: `📄 No documents available yet.\n📞 ${phone}`,
          buttons: [{ id: `sfaq_act_message_${sid}`, title: _btn("✉️ Ask us") }]
        });
      }
      const { sendDocument } = await import("./metaSender.js");
      for (const d of docs) {
        try {
          await sendDocument(from, {
            link:     d.url,
            filename: (d.label || "document").replace(/[^a-zA-Z0-9 ]/g, "").replace(/\s+/g, "_").slice(0, 40) + ".pdf",
            caption:  d.label
          });
        } catch (_) {}
      }
      return sendButtons(from, {
        text: `📄 Documents sent above. Tap to open.`,
        buttons: [
          { id: `sfaq_act_apply_${sid}`,   title: _btn("📋 Apply Now") },
          { id: `sfaq_act_message_${sid}`, title: _btn("✉️ Ask a Question") }
        ]
      });
    }

    default:
      return showSchoolFAQMenu(from, schoolId, biz, saveBiz);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// STATE HANDLER - processes typed replies (tour date, message, grade)
// ─────────────────────────────────────────────────────────────────────────────
export async function handleSchoolFAQState({ state, from, text, biz, saveBiz }) {
  if (!state?.startsWith("sfaq_")) return false;

  let schoolId = biz?.sessionData?.faqSchoolId;
  if (!schoolId) {
    try {
      const phone = String(from).replace(/\D+/g,"");
      const { default: UserSession } = await import("../models/userSession.js");
      const sess = await UserSession.findOne({ phone }).lean();
      schoolId = sess?.tempData?.sfaqSchoolId;
    } catch (_) {}
  }
  if (!schoolId) return false;

  const raw = (text || "").trim();
  if (["cancel","back","menu"].includes(raw.toLowerCase())) {
    await _sess(biz, saveBiz, "sfaq_menu", {}, from);
    return showSchoolFAQMenu(from, schoolId, biz, saveBiz);
  }

  switch (state) {

    case "sfaq_awaiting_message": {
      if (raw.length < 3) return sendText(from, "Please type your message. Type *cancel* to go back.");
      const school = await SchoolProfile.findById(schoolId).lean();
      if (!school) return false;
      const sid = String(school._id);
      notifySchoolEnquiry(school.phone, school.schoolName, from, raw).catch(() => {});
      _saveLead(from, school, "enquiry", "whatsapp_link");
      SchoolProfile.findByIdAndUpdate(schoolId, { $inc: { inquiries: 1 } }).catch(() => {});
      await _sess(biz, saveBiz, "sfaq_menu", {}, from);
      return sendButtons(from, {
        text: `✅ *Message sent to ${school.schoolName}*\n\n_"${raw}"_\n\nThey will reply on WhatsApp.\n📞 ${school.contactPhone || school.phone}`,
        buttons: [
          { id: `sfaq_act_tour_${sid}`,    title: _btn("📅 Book a Tour") },
          { id: `sfaq_act_apply_${sid}`,   title: _btn("📋 Apply Now") },
          { id: `sfaq_back_${sid}`,        title: _btn("⬅ Back") }
        ]
      });
    }

    case "sfaq_awaiting_tour_date": {
      if (raw.length < 3) return sendText(from, "Please enter a date, e.g. *Monday 9am*. Type *cancel* to go back.");
      const school = await SchoolProfile.findById(schoolId).lean();
      if (!school) return false;
      const sid = String(school._id);
      notifySchoolVisitRequest(school.phone, school.schoolName, biz?.sessionData?.faqParentName || from, "WhatsApp Bot").catch(() => {});
      _saveLead(from, school, "visit", "whatsapp_link");
      await _sess(biz, saveBiz, "sfaq_menu", {}, from);
      return sendButtons(from, {
        text: `✅ *Tour request sent!*\n\n*${school.schoolName}*\nPreferred: _${raw}_\n\nThey will confirm and send directions.\n📞 ${school.contactPhone || school.phone}`,
        buttons: [
          { id: `sfaq_act_apply_${sid}`,   title: _btn("📋 Apply Now") },
          { id: `sfaq_act_message_${sid}`, title: _btn("✉️ Ask a Question") },
          { id: `sfaq_back_${sid}`,        title: _btn("⬅ Back") }
        ]
      });
    }

    case "sfaq_awaiting_grade": {
      const school = await SchoolProfile.findById(schoolId).lean();
      if (!school) return false;
      const sid = String(school._id);
      notifySchoolPlaceEnquiry(school.phone, school.schoolName, biz?.sessionData?.faqParentName || from, raw, "WhatsApp Bot").catch(() => {});
      _saveLead(from, school, "place", "whatsapp_link", { gradeInterest: raw, levelInterest: raw });
      await _sess(biz, saveBiz, "sfaq_menu", {}, from);
      return sendButtons(from, {
        text: school.admissionsOpen
          ? `📝 *Enquiry received*\n\n🟢 Your enquiry for *${raw}* has been sent to ${school.schoolName}.\n\nThey will contact you on WhatsApp.`
          : `📝 *Interest registered*\n\n🔴 Admissions are currently closed. Your interest in *${raw}* at ${school.schoolName} has been recorded.\n\nWe will notify you when admissions open.`,
        buttons: [
          { id: `sfaq_act_tour_${sid}`,    title: _btn("📅 Book a Tour") },
          { id: `sfaq_act_message_${sid}`, title: _btn("✉️ Ask More") },
          { id: `sfaq_back_${sid}`,        title: _btn("⬅ Back") }
        ]
      });
    }

    default:
      return false;
  }
}