// routes/steuritApplyRouter.js
// ─────────────────────────────────────────────────────────────────────────────
// ST EURIT INTERNATIONAL SCHOOL — WEBSITE APPLICATION ENDPOINT
//
// Receives JSON application submissions from the school's static website
// (https://steuritinternationalschool.org.zw → apply.html) cross-origin,
// emails the application to info@zimqoute.co.zw, saves the parent as a
// SchoolContact lead, and (when the St Eurit school profile is found)
// reuses the existing notifySchoolWebSubmission service so the school's
// admin numbers also get the usual WhatsApp notification.
//
// MOUNTED IN server.js (before zq-admin):
//   import steuritApplyRouter from "./routes/steuritApplyRouter.js";
//   app.use("/", steuritApplyRouter);
//
// Routes:
//   OPTIONS /apply/steurit/web    → CORS preflight
//   POST    /apply/steurit/web    → process submission (JSON body)
//   GET     /apply/steurit/ping   → health check for the website's fetch()
//
// Optional .env:
//   STEURIT_SCHOOL_ID=<mongo id>   pin the school profile instead of name lookup
//   STEURIT_NOTIFY_EMAIL=...       override recipient (default info@zimqoute.co.zw)
// ─────────────────────────────────────────────────────────────────────────────

import express from "express";
import nodemailer from "nodemailer";

const router = express.Router();

const NOTIFY_EMAIL = process.env.STEURIT_NOTIFY_EMAIL || "info@zimqoute.co.zw";
const FROM_DISPLAY = "ZimQuote Schools <info@zimqoute.co.zw>";
const REPLY_TO     = "info@zimqoute.co.zw";
const SCHOOL_NAME  = "St Eurit International School";

const ALLOWED_ORIGINS = [
  "https://steuritinternationalschool.org.zw",
  "https://www.steuritinternationalschool.org.zw",
  "https://steuritinternationalschool.org",
  "https://www.steuritinternationalschool.org",
  "http://localhost:5500",
  "http://127.0.0.1:5500"
];

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function applyCors(req, res) {
  const origin = req.headers.origin || "";
  if (origin && !ALLOWED_ORIGINS.includes(origin)) {
    console.warn(`[STEURIT APPLY] ⚠ origin not in allowlist: "${origin}"`);
  }
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Access-Control-Max-Age", "86400");
  }
}

// ── SELF-CONTAINED MAILER (same SMTP pattern as schoolApplicationForm.js) ────
function _makeTransporter() {
  const host   = process.env.SMTP_HOST || "smtp.gmail.com";
  const port   = parseInt(process.env.SMTP_PORT || "465");
  const secure = (process.env.SMTP_SECURE || "true") === "true";
  const user   = process.env.SMTP_USER;
  const pass   = process.env.SMTP_PASS;

  if (!user) console.error("[STEURIT APPLY] ❌ SMTP_USER not set in .env - emails will fail");
  if (!pass) console.error("[STEURIT APPLY] ❌ SMTP_PASS not set in .env - emails will fail");

  return nodemailer.createTransport({
    host, port, secure,
    auth: { user, pass },
    tls: { rejectUnauthorized: false }
  });
}

async function emailApplication(data, applicantPhone) {
  const transporter = _makeTransporter();

  const timeStr = new Date().toLocaleString("en-GB", {
    weekday: "long", day: "numeric", month: "long", year: "numeric",
    hour: "2-digit", minute: "2-digit", timeZone: "Africa/Harare"
  });

  const rows = [
    ["Section",               data.section === "senior" ? "High School" : data.section === "nursery" ? "Nursery / ECD" : "Primary"],
    ["Grade / Form",          data.grade],
    ["Intake Year",           data.intakeYear],
    ["Student Full Name",     data.studentName],
    ["Date of Birth",         data.dob],
    ["Gender",                data.gender],
    ["Nationality",           data.nationality],
    ["Current School",        data.currentSchool],
    ["Home Address / Suburb", data.homeAddress],
    ["Day / Boarding",        data.boardingOption],
    ["Parent / Guardian",     data.parentName],
    ["Relationship",          data.relationship],
    ["Parent Phone (WhatsApp)", data.parentPhone],
    ["Normalised Phone",      applicantPhone ? "+" + applicantPhone : ""],
    ["Parent Email",          data.parentEmail],
    ["Optional Extras",       data.extras],
    ["Medical / Allergies",   data.medical],
    ["Notes",                 data.notes],
    ["Fees Estimate (calculator)", data.feesEstimate],
    ["Submitted Via",         "St Eurit website (steuritinternationalschool.org.zw)"],
    ["Submitted",             timeStr]
  ].filter(([, v]) => String(v ?? "").trim() !== "");

  const tableRows = rows.map(([k, v]) =>
    `<tr>` +
    `<td style="padding:8px 12px;border:1px solid #e2e8f0;font-weight:600;background:#f8fafc;white-space:nowrap">${esc(k)}</td>` +
    `<td style="padding:8px 12px;border:1px solid #e2e8f0">${esc(v)}</td>` +
    `</tr>`
  ).join("");

  const html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"></head>
<body style="font-family:-apple-system,sans-serif;color:#1a1a1a;margin:0;padding:0;background:#f8fafc">
<div style="max-width:640px;margin:24px auto;background:white;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.08)">
  <div style="background:#1B3673;padding:24px;text-align:center">
    <h1 style="color:white;margin:0;font-size:20px">New Website Application</h1>
    <p style="color:#FFD108;margin:8px 0 0;font-size:14px">${esc(SCHOOL_NAME)}</p>
  </div>
  <div style="padding:24px">
    <p style="color:#64748b;font-size:14px;margin:0 0 16px">
      A new application was submitted on the <strong>St Eurit website</strong> (no documents uploaded — parent brings them on assessment day).
    </p>
    <table style="width:100%;border-collapse:collapse;font-size:14px">${tableRows}</table>
    <div style="margin-top:20px;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:14px;font-size:14px">
      <strong style="color:#16a34a">Next step:</strong>
      contact the parent on WhatsApp to book the free assessment (Mon–Fri, 0900–1500hrs)
      ${applicantPhone ? `— <a href="https://wa.me/${esc(applicantPhone)}" style="color:#16a34a;font-weight:700">wa.me/${esc(applicantPhone)}</a>` : ""}.
    </div>
  </div>
</div>
</body></html>`;

  const info = await transporter.sendMail({
    from: FROM_DISPLAY,
    to: NOTIFY_EMAIL,
    replyTo: REPLY_TO,
    subject: `📥 St Eurit Application — ${data.studentName} (${data.grade}, ${data.intakeYear})`,
    html
  });
  console.log(`[STEURIT APPLY] ✅ email sent to ${NOTIFY_EMAIL} id=${info.messageId}`);
}

// ── FIND THE ST EURIT SCHOOL PROFILE (optional, for contact capture + WA) ────
async function findSchool() {
  try {
    const SP = (await import("../models/schoolProfile.js")).default;
    if (process.env.STEURIT_SCHOOL_ID) {
      const byId = await SP.findById(process.env.STEURIT_SCHOOL_ID).lean();
      if (byId) return byId;
    }
    return await SP.findOne({ schoolName: /eurit/i }).lean();
  } catch (e) {
    console.warn("[STEURIT APPLY] school lookup skipped:", e.message);
    return null;
  }
}

// ── ROUTES ───────────────────────────────────────────────────────────────────
// CORS on every /apply/steurit request (incl. errors), before anything else.
router.use("/apply/steurit", (req, res, next) => {
  applyCors(req, res);
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

router.options("/apply/steurit/web", (req, res) => {
  applyCors(req, res);
  res.sendStatus(204);
});

router.get("/apply/steurit/ping", (req, res) => {
  applyCors(req, res);
  res.json({ ok: true, service: "steurit-apply", time: new Date().toISOString() });
});

router.post(
  "/apply/steurit/web",
  express.json({ limit: "200kb" }),
  express.text({ type: "text/plain", limit: "200kb" }),
  async (req, res) => {
  applyCors(req, res);
  try {
    // Body may arrive as parsed JSON (application/json) or as a raw string
    // (text/plain - sent by the website to avoid CORS preflight entirely).
    let b = req.body || {};
    if (typeof b === "string") {
      try { b = JSON.parse(b); } catch { b = {}; }
    }

    // Honeypot — bots fill the hidden "website" field; pretend success.
    if (String(b.website || "").trim() !== "") {
      console.warn("[STEURIT APPLY] 🍯 honeypot tripped - dropping submission");
      return res.json({ ok: true });
    }

    const clean = (v, max = 400) => String(v ?? "").trim().slice(0, max);
    const data = {
      section:        clean(b.section, 20),
      grade:          clean(b.grade, 60),
      intakeYear:     clean(b.intakeYear, 8),
      studentName:    clean(b.studentName, 120),
      dob:            clean(b.dob, 20),
      gender:         clean(b.gender, 20),
      nationality:    clean(b.nationality, 60),
      currentSchool:  clean(b.currentSchool, 160),
      homeAddress:    clean(b.homeAddress, 240),
      boardingOption: clean(b.boardingOption, 30),
      parentName:     clean(b.parentName, 120),
      relationship:   clean(b.relationship, 40),
      parentPhone:    clean(b.parentPhone, 30),
      parentEmail:    clean(b.parentEmail, 120),
      extras:         clean(b.extras, 240),
      medical:        clean(b.medical, 600),
      notes:          clean(b.notes, 600),
      feesEstimate:   clean(b.feesEstimate, 800),
      submittedVia:   "steurit-website"
    };

    if (!data.studentName || !data.grade || !data.dob || !data.parentName || !data.parentPhone) {
      return res.status(400).json({
        ok: false,
        error: "Please fill in all required fields: student name, grade, date of birth, parent name and phone number."
      });
    }

    // Normalise Zim phone: 07XXXXXXXX → 2637XXXXXXXX
    const normP = data.parentPhone.replace(/\D/g, "");
    const fullP = normP.startsWith("0") ? "263" + normP.slice(1) : normP;

    // 1. Email to info@zimqoute.co.zw (the primary requirement — awaited)
    await emailApplication(data, fullP);

    // 2. Respond to the browser NOW. The remaining work (lead capture,
    //    school email copy, WhatsApp alerts) runs in the background — a
    //    second SMTP send plus Meta Graph API calls can take 15-30s, and
    //    keeping the HTTP response open that long makes proxies/browsers
    //    give up and report a network error even when everything succeeds.
    res.json({ ok: true });

    // 3. Background: lead capture + notifications (best-effort, fully guarded)
    setImmediate(async () => {
      try {
        const school = await findSchool();
        if (!school) return;

        try {
          const SC = (await import("../models/schoolContact.js")).default;
          await SC.findOneAndUpdate(
            { schoolId: school._id, phone: fullP },
            {
              $set: { lastSeen: new Date(), source: "apply", converted: true,
                      appliedAt: new Date(), studentName: data.studentName,
                      parentName: data.parentName, gradeInterest: data.grade,
                      applicationData: data },
              $inc: { viewCount: 1 },
              $setOnInsert: { firstSeen: new Date(), phone: fullP, schoolId: school._id }
            },
            { upsert: true }
          );
        } catch (ce) { console.warn("[STEURIT APPLY CONTACT]", ce.message); }

        try {
          // Reuse the existing web-submission notifier untouched:
          // → school gets its usual email copy (notifyEmail/school.email),
          // → school notifyPhone gets the WhatsApp alert,
          // → parent gets the WhatsApp confirmation.
          // info@zimqoute.co.zw already received the dedicated email above.
          const { notifySchoolWebSubmission } =
            await import("../services/schoolApplicationForm.js");
          await notifySchoolWebSubmission({ school, data, applicantPhone: fullP });
        } catch (ne) { console.warn("[STEURIT APPLY NOTIFY]", ne.message); }
      } catch (bg) { console.warn("[STEURIT APPLY BG]", bg.message); }
    });
  } catch (err) {
    console.error("[STEURIT APPLY] ❌", err.message);
    res.status(500).json({ ok: false, error: "Submission failed. Please try again or contact the school on WhatsApp." });
  }
  }
);

export default router;