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

// ─── EMAIL CONFIG ─────────────────────────────────────────────────────────────
// Uses Gmail SMTP (SMTP_HOST / SMTP_USER / SMTP_PASS already in .env).
// FROM address is set to "ZimQuote Schools <info@zimqoute.co.zw>" so schools
// see that sender. Gmail accepts this as long as the Gmail account is the
// authenticated sender - the display name and from-header are cosmetic.
// replyTo is also set to info@zimqoute.co.zw so replies land there.
//
// No new env vars needed. Uses existing SMTP_* vars.

function _makeTransporter() {
  const host   = process.env.SMTP_HOST || "smtp.gmail.com";
  const port   = parseInt(process.env.SMTP_PORT || "465");
  const secure = (process.env.SMTP_SECURE || "true") === "true";
  const user   = process.env.SMTP_USER;
  const pass   = process.env.SMTP_PASS;

  console.log(`[SCHOOL EMAIL TRANSPORT] host=${host} port=${port} secure=${secure} user=${user ? user : "NOT SET"} pass=${pass ? "SET" : "NOT SET"}`);

  if (!user) console.error("[SCHOOL APPLY EMAIL] ❌ SMTP_USER not set in .env - emails will fail");
  if (!pass) console.error("[SCHOOL APPLY EMAIL] ❌ SMTP_PASS not set in .env - emails will fail");

  return nodemailer.createTransport({
    host,
    port,
    secure,
    auth: { user, pass },
    tls: { rejectUnauthorized: false }
  });
}

const FROM_DISPLAY = "ZimQuote Schools <info@zimqoute.co.zw>";
const REPLY_TO     = "info@zimqoute.co.zw";

// ─── EMAIL APPLICATION TO SCHOOL ─────────────────────────────────────────────
export async function emailApplicationToSchool({ school, data, applicantPhone }) {
  const toEmail = school.applicationForm?.notifyEmail || school.email;

  console.log(`[SCHOOL APPLY EMAIL] ▶ called - school=${school?.schoolName} toEmail=${toEmail} student=${data?.studentName}`);

  if (!toEmail) {
    console.warn(`[SCHOOL APPLY EMAIL] ⚠ No notify email set for ${school.schoolName} - skipping`);
    return;
  }

  try {
    const transporter = _makeTransporter();

    // Verify SMTP connection before send - surfaces auth/connection errors immediately
    await new Promise((resolve, reject) => {
      transporter.verify((err, success) => {
        if (err) {
          console.error(`[SCHOOL APPLY EMAIL] ❌ SMTP verify failed: ${err.message} (code=${err.code})`);
          reject(err);
        } else {
          console.log(`[SCHOOL APPLY EMAIL] ✅ SMTP verified OK`);
          resolve(success);
        }
      });
    });

    const timeStr = new Date().toLocaleString("en-GB", {
      weekday: "long", day: "numeric", month: "long", year: "numeric",
      hour: "2-digit", minute: "2-digit", timeZone: "Africa/Harare"
    });

    const rows = [
      ["Student Full Name",    data.studentName   || "-"],
      ["Grade / Form",         data.grade         || "-"],
      ["Date of Birth",        data.dob           || "-"],
      ["Parent / Guardian",    data.parentName    || "-"],
      ["Parent Contact Phone", data.parentPhone   || _displayPhone(applicantPhone)],
      ["WhatsApp Number",      _displayPhone(applicantPhone)],
      ["School Applying For",  school.schoolName  || "-"],
      ["Intake Year",          data.intakeYear    || school.applicationForm?.intakeYear || "-"],
      ["Submitted",            timeStr]
    ];
    if (data.customAnswers) {
      for (const [q, a] of Object.entries(data.customAnswers)) {
        rows.push([q, a || "-"]);
      }
    }

    const tableRows = rows.map(([k, v]) =>
      `<tr>` +
      `<td style="padding:8px 12px;border:1px solid #e2e8f0;font-weight:600;background:#f8fafc;white-space:nowrap">${k}</td>` +
      `<td style="padding:8px 12px;border:1px solid #e2e8f0">${v}</td>` +
      `</tr>`
    ).join("");

    const html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"></head>
<body style="font-family:-apple-system,sans-serif;color:#1a1a1a;margin:0;padding:0;background:#f8fafc">
<div style="max-width:600px;margin:24px auto;background:white;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.08)">
  <div style="background:#1a3c5e;padding:24px;text-align:center">
    <h1 style="color:white;margin:0;font-size:20px">New Student Application</h1>
    <p style="color:#93c5fd;margin:8px 0 0;font-size:14px">${school.schoolName}</p>
  </div>
  <div style="padding:24px">
    <p style="color:#64748b;font-size:14px;margin:0 0 16px">
      A new application has been submitted via <strong>ZimQuote WhatsApp</strong>.
    </p>
    <table style="width:100%;border-collapse:collapse;font-size:14px">${tableRows}</table>
    <div style="margin-top:20px;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:14px">
      <strong style="color:#16a34a">What to do next:</strong><br>
      <span style="font-size:13px;color:#166534">
        Call or WhatsApp the parent on <strong>${data.parentPhone || _displayPhone(applicantPhone)}</strong>
        to confirm receipt and share next steps.
      </span>
    </div>
  </div>
  <div style="background:#f8fafc;padding:16px;text-align:center;font-size:12px;color:#94a3b8;border-top:1px solid #e2e8f0">
    Sent by ZimQuote &middot; <a href="https://zimquote.co.zw" style="color:#1a3c5e">zimquote.co.zw</a><br>
    Submitted on ${timeStr} (CAT)
  </div>
</div>
</body></html>`;

    const info = await transporter.sendMail({
      from:    FROM_DISPLAY,
      replyTo: REPLY_TO,
      to:      toEmail,
      subject: `New Application: ${data.studentName || "Student"} - ${data.grade || ""} - ${school.schoolName}`,
      html
    });

    console.log(`[SCHOOL APPLY EMAIL] ✅ Delivered to ${toEmail} | messageId=${info.messageId} | student=${data.studentName} | school=${school.schoolName}`);

  } catch (err) {
    console.error(`[SCHOOL APPLY EMAIL] ❌ FAILED to ${toEmail}: ${err.message}`);
    if (err.response) console.error(`[SCHOOL APPLY EMAIL]    SMTP server said: ${err.response}`);
    if (err.code)     console.error(`[SCHOOL APPLY EMAIL]    Error code: ${err.code}`);
    if (err.command)  console.error(`[SCHOOL APPLY EMAIL]    Failed command: ${err.command}`);
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
          `📋 *New Web Application - ${school.schoolName}*\n\n` +
          `👤 Student: *${data.studentName || "-"}*\n` +
          `📚 Grade: *${data.grade || "-"}*\n` +
          `🎂 DOB: *${data.dob || "-"}*\n` +
          `👪 Parent: *${data.parentName || "-"}*\n` +
          `📞 Contact: *${data.parentPhone || "-"}*\n` +
          `📧 Email: *${data.parentEmail || "-"}*\n` +
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
          `✅ *Application Received - ${school.schoolName}*\n\n` +
          `👤 Student: *${data.studentName || "-"}*\n` +
          `📚 Grade: *${data.grade || "-"}*\n` +
          `👪 Parent: *${data.parentName || "-"}*\n\n` +
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

// ─── NOTIFY SCHOOL VIA WHATSAPP: someone opened their apply link ──────────────
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
      buttons: [{ id: "school_my_profile", title: "🏫 My School" }]
    });
    console.log(`[SCHOOL APPLY NOTIFY] → ${notifyNum} (${school.schoolName}, visitor: ${visitorPhone})`);
  } catch (err) {
    console.warn("[SCHOOL APPLY NOTIFY]", err.message);
  }
}

// ─── START WHATSAPP APPLICATION FORM ─────────────────────────────────────────
// Called when parent taps Apply or scans APPLY:SCHOOL QR.
export async function startSchoolApplicationForm({ from, school, UserSession }) {
  const form = school.applicationForm || {};

  const _brochureUrl  = form.brochureUrl  || (school.brochures?.[0]?.url)   || "";
  const _brochureName = form.brochureName || (school.brochures?.[0]?.label) || "School_Brochure.pdf";
  const _rawFormUrl   = form.rawFormUrl   || school.applicationFormUrl       || "";
  const _rawFormName  = form.rawFormName  || "Application_Form.pdf";

  const _fees     = school.fees?.term1
    ? `$${school.fees.term1}/term`
    : (typeof school.fees === "number" ? `$${school.fees}/term` : "");
  const _curricArr = Array.isArray(school.curriculum) ? school.curriculum : [school.curriculum].filter(Boolean);
  const _curric    = _curricArr.map(c => String(c).toUpperCase()).join(" + ");
  const _location  = school.location?.area
    ? `${school.location.area}, ${school.location.city || ""}`
    : school.location?.city || school.suburb || school.address || "";
  const _phone    = school.contactPhone || school.phone || "";
  const _grades   = (form.gradeOptions || []).join(", ");
  const _verified = school.verified ? " ✅" : "";
  const _baseUrl  = process.env.BASE_URL || process.env.PUBLIC_URL || "https://cripfcnt.com";
  const webFormUrl = `${_baseUrl}/apply/school/${school._id}`;

  const profileCard =
    `🏫 *${school.schoolName}${_verified}*\n` +
    (_location ? `📍 ${_location}\n` : "") +
    (_fees  ? `💰 ${_fees}${_curric ? ` · ${_curric}` : ""}\n` : (_curric ? `📚 ${_curric}\n` : "")) +
    (_grades ? `📋 Grades: ${_grades}\n` : "") +
    (_phone  ? `📞 ${_phone}\n` : "") +
    (school.email   ? `📧 ${school.email}\n`   : "") +
    (school.website ? `🌐 ${school.website}\n` : "") +
    (school.description
      ? `\n_${school.description.slice(0, 160)}${school.description.length > 160 ? "…" : ""}_\n`
      : "");

  const intakeLabel = form.intakeYear ? form.intakeYear : "";

  await sendButtons(from, {
    text:
      profileCard +
      `\n📝 *How to Apply${intakeLabel ? " - " + intakeLabel : ""}*\n\n` +
      `You have *3 options:*\n\n` +
      `1️⃣ *WhatsApp form* - tap button below, answer 5 questions\n\n` +
      `2️⃣ *Web form* - fill online on your phone or computer:\n` +
      `${webFormUrl}\n\n` +
      `3️⃣ *Download PDF* - print and hand in at the school:\n` +
      (_rawFormUrl
        ? `${_rawFormUrl}\n`
        : `_No PDF form set yet - contact school directly_\n`) +
      `\n_All submissions go directly to ${school.schoolName}._`,
    buttons: [
      { id: `school_apply_start_${school._id}`, title: "📝 Apply on WhatsApp" },
      { id: `sfaq_enquiry_${school._id}`,       title: "❓ Ask a Question"    }
    ]
  });

  if (_brochureUrl) {
    try {
      await sendDocument(from, {
        link:     _brochureUrl,
        filename: _brochureName,
        caption:  `📄 *${school.schoolName} - School Brochure*\n_Save this for your records._`
      });
    } catch (_be) { console.warn("[SCHOOL BROCHURE SEND]", _be.message); }
  }

  if (_rawFormUrl) {
    try {
      await sendDocument(from, {
        link:     _rawFormUrl,
        filename: _rawFormName,
        caption:
          `📋 *Printable Application Form - ${school.schoolName}*\n` +
          `_Print, fill in, and hand in at the school office._`
      });
    } catch (_re) { console.warn("[SCHOOL RAW FORM SEND]", _re.message); }
  }

  await UserSession.findOneAndUpdate(
    { phone: _normPhone(from) },
    { $set: {
        "tempData.schoolApplyId":    String(school._id),
        "tempData.schoolApplyState": "awaiting_start",
        "tempData.schoolApplyData":  JSON.stringify({
          schoolId:     String(school._id),
          schoolName:   school.schoolName,
          intakeYear:   intakeLabel,
          gradeOptions: form.gradeOptions || []
        })
      }
    },
    { upsert: true }
  );
}
