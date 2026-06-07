// services/schoolApplicationForm.js
// ─── School Application Form Service ─────────────────────────────────────────
//
// Handles:
//   1. Per-school form configuration (active, fields, notify email/phone)
//   2. Contact capture on QR/link open
//   3. WhatsApp application form flow (multi-step)
//   4. Email notification to school using info@zimquote.co.zw
//   5. WhatsApp notification to school's admin phone (with applicant number)
//   6. Brochure/PDF attachment link storage and sending
//
// ─────────────────────────────────────────────────────────────────────────────

import nodemailer from "nodemailer";
import { sendText, sendButtons, sendDocument } from "./metaSender.js";

// ─── EMAIL CONFIG (info@zimquote.co.zw) ──────────────────────────────────────
function _makeTransporter() {
  return nodemailer.createTransport({
    host:   process.env.SMTP_HOST   || "smtp.gmail.com",
    port:   parseInt(process.env.SMTP_PORT  || "587"),
    secure: (process.env.SMTP_SECURE || "false") === "true",
    auth: {
      user: process.env.SMTP_USER   || process.env.EMAIL_FROM || "info@zimquote.co.zw",
      pass: process.env.SMTP_PASS   || process.env.EMAIL_PASS
    }
  });
}

const FROM_EMAIL = process.env.EMAIL_FROM || "info@zimquote.co.zw";
const FROM_NAME  = "ZimQuote Schools";

// ─── HELPER: normalise phone ──────────────────────────────────────────────────
function _normPhone(p = "") {
  const d = String(p).replace(/\D/g, "");
  if (d.startsWith("263")) return d;
  if (d.startsWith("0"))   return "263" + d.slice(1);
  return d;
}
function _displayPhone(p = "") {
  const d = _normPhone(p);
  return d.startsWith("263") ? "0" + d.slice(3) : d;
}

// ─── CONTACT CAPTURE ─────────────────────────────────────────────────────────
// Called whenever someone opens a school smart link or apply link.
// Upserts a SchoolContact record (one per phone+school).
export async function captureSchoolContact({
  schoolId,
  phone,
  source = "profile",   // "profile" | "apply" | "enquiry" | "brochure"
  extraData = {}        // { studentName, parentName, gradeInterest, etc. }
}) {
  try {
    const SchoolContact = (await import("../models/schoolContact.js")).default;
    const update = {
      $set:  { lastSeen: new Date(), source, ...extraData },
      $inc:  { viewCount: 1 },
      $setOnInsert: { firstSeen: new Date(), phone, schoolId }
    };
    await SchoolContact.findOneAndUpdate(
      { schoolId, phone: _normPhone(phone) },
      update,
      { upsert: true, new: true }
    );
  } catch (err) {
    console.warn("[SCHOOL CONTACT CAPTURE]", err.message);
  }
}

// ─── NOTIFY SCHOOL VIA WHATSAPP: someone opened their apply link ─────────────
export async function notifySchoolApplyLinkOpened({ school, visitorPhone, source = "qr" }) {
  if (!school?.applicationForm?.notifyPhone) return;
  try {
    const notifyNum = _normPhone(school.applicationForm.notifyPhone);
    const sourceLabels = {
      qr: "QR code scan", wa: "WhatsApp link", direct: "direct link",
      flyer: "flyer QR", social: "social media"
    };
    const sourceLabel = sourceLabels[source] || "link";
    const timeStr = new Date().toLocaleString("en-GB", {
      day: "numeric", month: "short", hour: "2-digit", minute: "2-digit",
      timeZone: "Africa/Harare"
    });
    await sendButtons(notifyNum, {
      text:
        `📝 *Someone opened your Application Form!*\n\n` +
        `🏫 ${school.schoolName}\n` +
        `📱 Via: ${sourceLabel}\n` +
        `⏰ ${timeStr}\n` +
        (visitorPhone ? `📞 Visitor: *${_displayPhone(visitorPhone)}*\n` : "") +
        `\n_They may be interested in enrolling. Follow up if no application arrives._`,
      buttons: [
        { id: "school_my_profile", title: "🏫 My School" }
      ]
    });
    console.log(`[SCHOOL APPLY NOTIFY] → ${notifyNum} (${school.schoolName}, visitor: ${visitorPhone})`);
  } catch (err) {
    console.warn("[SCHOOL APPLY NOTIFY]", err.message);
  }
}

// ─── START WHATSAPP APPLICATION FORM ─────────────────────────────────────────
// Called when parent taps Apply or scans APPLY:SCHOOL QR.
// 1. Shows school profile card (location, fees, curriculum, grades, contact)
// 2. Sends brochure/flyer PDF if configured
// 3. Prompts parent to tap "Start Application" before asking questions
export async function startSchoolApplicationForm({ from, school, UserSession }) {
  const form = school.applicationForm || {};

  // ── Build school profile card ─────────────────────────────────────────────
  const _fees     = school.fees?.term1 ? `$${school.fees.term1}/term` : (typeof school.fees === "number" ? `$${school.fees}/term` : "");
  const _type     = [school.schoolType, school.curriculum].filter(Boolean).join(" · ");
  const _location = school.location?.area
    ? `${school.location.area}, ${school.location.city || ""}`
    : school.location?.city || school.address || "";
  const _phone    = school.contactPhone || school.phone || "";
  const _grades   = (form.gradeOptions || []).join(", ");
  const _verified = school.verified ? " ✅" : "";

  const profileCard =
    `🏫 *${school.schoolName}${_verified}*\n` +
    (_location ? `📍 ${_location}\n` : "") +
    (_fees     ? `💰 ${_fees}${_type ? ` · ${_type}` : ""}\n` : (_type ? `📚 ${_type}\n` : "")) +
    (_grades   ? `📋 Grades: ${_grades}\n` : "") +
    (_phone    ? `📞 ${_phone}\n` : "") +
    (school.email ? `📧 ${school.email}\n` : "") +
    (school.website ? `🌐 ${school.website}\n` : "") +
    (school.description ? `\n_${school.description.slice(0, 180)}${school.description.length > 180 ? "…" : ""}_\n` : "");

  // ── Form NOT active: show profile + contact info + any configured links ────
  const _baseUrlInactive = process.env.BASE_URL || process.env.PUBLIC_URL || "https://cripfcnt.com";
  if (!form.active) {
    await sendButtons(from, {
      text:
        profileCard +
        `\n📝 *Applications*\n` +
        (school.registrationLink ? `🔗 Apply online: ${school.registrationLink}\n` : "") +
        `📞 Contact to apply: ${_phone}`,
      buttons: [
        { id: `sfaq_enquiry_${school._id}`, title: "❓ Ask a Question" },
        { id: "school_search_refine",        title: "🏫 More Schools"  }
      ]
    });
    // Still send documents if configured
    if (form.brochureUrl) {
      try {
        await sendDocument(from, { link: form.brochureUrl, filename: form.brochureName || "School_Brochure.pdf", caption: `📄 *${school.schoolName} — Brochure*` });
      } catch (_) {}
    }
    if (form.rawFormUrl) {
      try {
        await sendDocument(from, { link: form.rawFormUrl, filename: form.rawFormName || "Application_Form.pdf",
          caption: `📋 *${school.schoolName} — Printable Application Form*\n_Print, fill in, and hand in at the school office._` });
      } catch (_) {}
    }
    return;
  }

  // ── Form IS active ────────────────────────────────────────────────────────
  const intakeLabel  = form.intakeYear ? `_${form.intakeYear}_` : "";
  const _botNum      = process.env.WHATSAPP_PHONE_NUMBER_ID ? "" : "";
  const _baseUrl     = process.env.BASE_URL || process.env.PUBLIC_URL || "https://cripfcnt.com";
  const webFormUrl   = `${_baseUrl}/apply/school/${school._id}`;

  // ── Step 1: School profile card ───────────────────────────────────────────
  await sendButtons(from, {
    text:
      profileCard +
      `\n📝 *Applications${intakeLabel ? " — " + intakeLabel.replace(/_/g,"") : ""}*\n` +
      `\nYou have *3 ways* to apply:\n` +
      `1️⃣ Fill the form here on WhatsApp\n` +
      `2️⃣ Apply online (web form)\n` +
      `3️⃣ Download & print the paper form\n` +
      `\nAll submissions go directly to the school.`,
    buttons: [
      { id: `school_apply_start_${school._id}`, title: "📝 Apply on WhatsApp" },
      { id: `sfaq_enquiry_${school._id}`,       title: "❓ Ask a Question"    }
    ]
  });

  // ── Step 2: Web form link ─────────────────────────────────────────────────
  await sendText(from,
    `🌐 *Apply online (web form):*\n${webFormUrl}\n` +
    `_Opens in your browser — fill the form on your phone or computer._`
  );

  // ── Step 3: Brochure PDF ──────────────────────────────────────────────────
  if (form.brochureUrl) {
    try {
      const fileName = form.brochureName || `${school.schoolName.replace(/\s+/g, "_")}_Brochure.pdf`;
      await sendDocument(from, {
        link:     form.brochureUrl,
        filename: fileName,
        caption:  `📄 *${school.schoolName} — School Brochure*\n_Save this for your records._`
      });
    } catch (_be) { console.warn("[SCHOOL BROCHURE SEND]", _be.message); }
  }

  // ── Step 4: Raw printable application form ────────────────────────────────
  if (form.rawFormUrl) {
    try {
      const rawName = form.rawFormName || `${school.schoolName.replace(/\s+/g, "_")}_Application_Form.pdf`;
      await sendDocument(from, {
        link:     form.rawFormUrl,
        filename: rawName,
        caption:
          `📋 *Printable Application Form — ${school.schoolName}*\n` +
          `_Print, fill in, and hand in at the school office._`
      });
    } catch (_re) { console.warn("[SCHOOL RAW FORM SEND]", _re.message); }
  }

  // ── Pre-set session for WhatsApp form ─────────────────────────────────────
  await UserSession.findOneAndUpdate(
    { phone: _normPhone(from) },
    { $set: {
        "tempData.schoolApplyId":    String(school._id),
        "tempData.schoolApplyState": "awaiting_start",
        "tempData.schoolApplyData":  JSON.stringify({
          schoolId:     String(school._id),
          schoolName:   school.schoolName,
          intakeYear:   form.intakeYear || "",
          gradeOptions: form.gradeOptions || []
        })
      }
    },
    { upsert: true }
  );
}

// ─── EMAIL APPLICATION TO SCHOOL ─────────────────────────────────────────────
export async function emailApplicationToSchool({ school, data, applicantPhone }) {
  const toEmail = school.applicationForm?.notifyEmail || school.email;
  if (!toEmail) {
    console.warn(`[SCHOOL APPLY EMAIL] No email for ${school.schoolName}`);
    return;
  }
  try {
    const transporter = _makeTransporter();
    const timeStr = new Date().toLocaleString("en-GB", {
      weekday: "long", day: "numeric", month: "long", year: "numeric",
      hour: "2-digit", minute: "2-digit", timeZone: "Africa/Harare"
    });
    const rows = [
      ["Student Full Name",     data.studentName    || "—"],
      ["Grade / Form",          data.grade          || "—"],
      ["Date of Birth",         data.dob            || "—"],
      ["Parent / Guardian",     data.parentName     || "—"],
      ["Parent Contact Phone",  data.parentPhone    || _displayPhone(applicantPhone)],
      ["WhatsApp Number",       _displayPhone(applicantPhone)],
      ["School Applying For",   school.schoolName   || "—"],
      ["Intake Year",           data.intakeYear     || school.applicationForm?.intakeYear || "—"],
      ["Submitted",             timeStr]
    ];
    // Add any custom field answers
    if (data.customAnswers) {
      for (const [q, a] of Object.entries(data.customAnswers)) {
        rows.push([q, a || "—"]);
      }
    }
    const tableRows = rows.map(([k, v]) =>
      `<tr><td style="padding:8px 12px;border:1px solid #e2e8f0;font-weight:600;background:#f8fafc;white-space:nowrap">${k}</td>` +
      `<td style="padding:8px 12px;border:1px solid #e2e8f0">${v}</td></tr>`
    ).join("");

    const html = `
<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body style="font-family:-apple-system,sans-serif;color:#1a1a1a;margin:0;padding:0;background:#f8fafc">
<div style="max-width:600px;margin:24px auto;background:white;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.08)">
  <div style="background:#1a3c5e;padding:24px;text-align:center">
    <h1 style="color:white;margin:0;font-size:20px">📝 New Student Application</h1>
    <p style="color:#93c5fd;margin:8px 0 0;font-size:14px">${school.schoolName}</p>
  </div>
  <div style="padding:24px">
    <p style="color:#64748b;font-size:14px;margin:0 0 16px">
      A new application has been submitted via <strong>ZimQuote WhatsApp</strong>.
    </p>
    <table style="width:100%;border-collapse:collapse;font-size:14px">${tableRows}</table>
    <div style="margin-top:20px;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:14px">
      <strong style="color:#16a34a">✅ What to do next:</strong><br>
      <span style="font-size:13px;color:#166534">
        Call or WhatsApp the parent on <strong>${data.parentPhone || _displayPhone(applicantPhone)}</strong> 
        to confirm receipt and share next steps.
      </span>
    </div>
  </div>
  <div style="background:#f8fafc;padding:16px;text-align:center;font-size:12px;color:#94a3b8;border-top:1px solid #e2e8f0">
    Sent by ZimQuote · <a href="https://zimquote.co.zw" style="color:#1a3c5e">zimquote.co.zw</a><br>
    This application was submitted on ${timeStr} (CAT)
  </div>
</div>
</body></html>`;

    await transporter.sendMail({
      from:    `"${FROM_NAME}" <${FROM_EMAIL}>`,
      to:      toEmail,
      subject: `New Application: ${data.studentName || "Student"} — ${data.grade || ""} — ${school.schoolName}`,
      html
    });
    console.log(`[SCHOOL APPLY EMAIL] Sent to ${toEmail} for ${data.studentName} @ ${school.schoolName}`);
  } catch (err) {
    console.warn("[SCHOOL APPLY EMAIL] Failed:", err.message);
  }
}
// ─── NOTIFY SCHOOL + WHATSAPP: web form submission ───────────────────────────
// Called when parent submits the web form at /apply/school/:id
export async function notifySchoolWebSubmission({ school, data, applicantPhone }) {
  // 1. Email
  await emailApplicationToSchool({ school, data, applicantPhone: applicantPhone || "" });

  // 2. WhatsApp to school notify phone
  if (school.applicationForm?.notifyPhone) {
    try {
      const { sendButtons: _sb } = await import("./metaSender.js");
      const notifyNum = _normPhone(school.applicationForm.notifyPhone);
      const timeStr = new Date().toLocaleString("en-GB", {
        day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Africa/Harare"
      });
      await _sb(notifyNum, {
        text:
          `📋 *New Web Application — ${school.schoolName}*\n\n` +
          `👤 Student: *${data.studentName || "—"}*\n` +
          `📚 Grade: *${data.grade || "—"}*\n` +
          `🎂 DOB: *${data.dob || "—"}*\n` +
          `👪 Parent: *${data.parentName || "—"}*\n` +
          `📞 Contact: *${data.parentPhone || "—"}*\n` +
          `📧 Email: *${data.parentEmail || "—"}*\n` +
          `⏰ ${timeStr}\n\n` +
          `_Submitted via ZimQuote web form. Full details sent to your email._`,
        buttons: [{ id: "school_my_profile", title: "🏫 My School" }]
      });
    } catch (_we) { console.warn("[SCHOOL WEB NOTIFY]", _we.message); }
  }

  // 3. Confirmation WhatsApp to parent if they have a phone
  if (applicantPhone) {
    try {
      const { sendButtons: _sb2 } = await import("./metaSender.js");
      const parentNum = _normPhone(applicantPhone);
      await _sb2(parentNum, {
        text:
          `✅ *Application Received — ${school.schoolName}*\n\n` +
          `👤 Student: *${data.studentName || "—"}*\n` +
          `📚 Grade: *${data.grade || "—"}*\n` +
          `👪 Parent: *${data.parentName || "—"}*\n\n` +
          `The school will contact you on *${data.parentPhone || _displayPhone(applicantPhone)}* shortly.\n\n` +
          `📞 ${school.contactPhone || school.phone || ""}`,
        buttons: [
          { id: `sfaq_enquiry_${school._id}`, title: "❓ Ask a Question" },
          { id: "school_search_refine",        title: "🏫 More Schools"  }
        ]
      });
    } catch (_pe) { console.warn("[SCHOOL WEB PARENT CONFIRM]", _pe.message); }
  }
}