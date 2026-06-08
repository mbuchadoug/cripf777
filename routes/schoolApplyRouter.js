// routes/schoolApplyRouter.js
// ─────────────────────────────────────────────────────────────────────────────
// Public school application form — NO auth required.
//
// MOUNTED IN server.js:
//   import schoolApplyRouter from "./routes/schoolApplyRouter.js";
//   app.use("/", schoolApplyRouter);   ← BEFORE app.use("/zq-admin", ...)
//
// Routes:
//   GET  /apply/school/:id          → web application form
//   POST /apply/school/:id/submit   → process submission → email + WhatsApp notify
// ─────────────────────────────────────────────────────────────────────────────

import express from "express";
const router  = express.Router();

function esc(s) {
  return String(s ?? "")
    .replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")
    .replace(/"/g,"&quot;").replace(/'/g,"&#39;");
}

// ── GET /apply/school/:id ─────────────────────────────────────────────────────
router.get("/apply/school/:id", async (req, res) => {
  try {
    const SP     = (await import("../models/schoolProfile.js")).default;
    const school = await SP.findById(req.params.id).lean();
    if (!school) return res.status(404).send(
      `<html><body style="font-family:sans-serif;padding:40px;text-align:center">
        <h2>School not found</h2>
        <p>This application link may have expired. Please contact the school directly.</p>
      </body></html>`);

    const form       = school.applicationForm || {};
    const feesRaw    = school.fees;
    const feesStr    = feesRaw?.term1 ? `$${feesRaw.term1}/term` : "";
    const curriculum = (school.curriculum || []).map(c => c.toUpperCase()).join(" + ") || "";
    const locStr     = [school.suburb || school.location?.area, school.city || school.location?.city].filter(Boolean).join(", ");
    const phone      = school.contactPhone || school.phone || "";
    const gradeOpts  = form.gradeOptions || [];
    const intakeYear = form.intakeYear || "";
    // Resolve brochure: applicationForm.brochureUrl first, then first uploaded brochure
    const brochureUrl  = form.brochureUrl  || school.brochures?.[0]?.url   || "";
    const brochureName = form.brochureName || school.brochures?.[0]?.label  || "School Brochure";
    // Resolve form PDF: applicationForm.rawFormUrl first, then applicationFormUrl
    const rawFormUrl   = form.rawFormUrl   || school.applicationFormUrl || "";
    const rawFormName  = form.rawFormName  || "Application Form";
    const ok           = req.query.success === "1";
    const errMsg       = req.query.error ? decodeURIComponent(req.query.error) : "";

    // Notify school of web form open (background, no await)
    try {
      const { notifyAllSchoolApplicationInterest } =
        await import("../services/schoolNotifications.js");
      notifyAllSchoolApplicationInterest(school, "Web visitor").catch(() => {});
    } catch (_) {}

    const gradeSelect = gradeOpts.length
      ? `<select name="grade" required style="width:100%;padding:13px 14px;border:2px solid #e2e8f0;border-radius:8px;font-size:16px;background:white;-webkit-appearance:none">
           <option value="">— Select grade / form —</option>
           ${gradeOpts.map(g => `<option value="${esc(g)}">${esc(g)}</option>`).join("")}
         </select>`
      : `<input name="grade" type="text" required placeholder="e.g. Form 1, Grade 7, ECD A"
           style="width:100%;padding:13px 14px;border:2px solid #e2e8f0;border-radius:8px;font-size:16px">`;

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<title>Apply — ${esc(school.schoolName)}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#f0f4f8;min-height:100vh}
.wrap{max-width:580px;margin:0 auto;padding-bottom:40px}
.hdr{background:linear-gradient(135deg,#1a3c5e,#1e6091);color:#fff;padding:28px 24px 22px;text-align:center}
.hdr .ico{font-size:44px;margin-bottom:8px}
.hdr h1{font-size:22px;font-weight:800;line-height:1.2;margin-bottom:4px}
.hdr .sub{font-size:13px;opacity:.85;margin-top:4px}
.sinfo{background:#16355a;padding:13px 20px;font-size:13px;color:#bfdbfe;line-height:1.9}
.sinfo strong{color:#fff}
.card{background:#fff;padding:22px 20px}
.stitle{font-size:11px;font-weight:800;color:#64748b;text-transform:uppercase;
  letter-spacing:1px;margin-bottom:14px;padding-bottom:8px;border-bottom:2px solid #f0f4f8;margin-top:20px}
.stitle:first-child{margin-top:4px}
.field{margin-bottom:14px}
label{display:block;font-size:13px;font-weight:700;color:#374151;margin-bottom:6px}
.req{color:#ef4444}
input,select,textarea{width:100%;padding:13px 14px;border:2px solid #e2e8f0;border-radius:8px;
  font-size:16px;font-family:inherit;outline:none;-webkit-appearance:none;transition:border-color .15s}
input:focus,select:focus,textarea:focus{border-color:#1a3c5e}
.g2{display:grid;grid-template-columns:1fr 1fr;gap:12px}
@media(max-width:440px){.g2{grid-template-columns:1fr}}
.btn-sub{width:100%;padding:16px;background:linear-gradient(135deg,#1a3c5e,#1e6091);
  color:#fff;border:none;border-radius:10px;font-size:17px;font-weight:800;
  cursor:pointer;letter-spacing:.3px;-webkit-tap-highlight-color:transparent;margin-top:4px}
.btn-sub:active{opacity:.88}
.success{text-align:center;padding:32px 20px}
.success .tick{font-size:60px;margin-bottom:14px}
.success h2{color:#16a34a;font-size:22px;font-weight:800;margin-bottom:8px}
.success p{color:#374151;font-size:14px;line-height:1.7;margin-bottom:12px}
.nxt{background:#f0fdf4;border:1px solid #bbf7d0;border-radius:10px;
  padding:14px;font-size:13px;color:#166534;text-align:left}
.errbx{background:#fef2f2;border:2px solid #fecaca;border-radius:8px;
  padding:13px 16px;margin-bottom:16px;color:#dc2626;font-size:14px}
.note{font-size:12px;color:#94a3b8;margin-top:5px;line-height:1.4}
.dl-sec{background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:16px;margin-top:20px}
.dl-sec h3{font-size:11px;font-weight:800;color:#64748b;text-transform:uppercase;
  letter-spacing:.8px;margin-bottom:12px}
.dl-link{display:flex;align-items:center;gap:12px;padding:12px 14px;background:#fff;
  border:1.5px solid #e2e8f0;border-radius:8px;text-decoration:none;color:#1a3c5e;
  font-size:14px;font-weight:600;margin-bottom:8px}
.dl-link:last-child{margin-bottom:0}
.dl-link .ico{font-size:22px;flex-shrink:0}
.dl-link .meta{font-size:12px;color:#64748b;font-weight:400;margin-top:2px}
.legal{font-size:12px;color:#94a3b8;margin:16px 0 12px;line-height:1.5}
footer{text-align:center;font-size:12px;color:#94a3b8;padding:20px;border-top:1px solid #e2e8f0}
footer a{color:#1a3c5e;font-weight:600;text-decoration:none}
</style>
</head>
<body>
<div class="wrap">
  <div class="hdr">
    <div class="ico">🏫</div>
    <h1>${esc(school.schoolName)}${school.verified?" ✅":""}</h1>
    ${intakeYear?`<div class="sub">📋 ${esc(intakeYear)}</div>`:""}
  </div>
  <div class="sinfo">
    ${locStr?`📍 <strong>${esc(locStr)}</strong>&ensp;`:""}
    ${feesStr?`💰 <strong>${esc(feesStr)}</strong>${curriculum?`&ensp;·&ensp;<strong>${esc(curriculum)}</strong>`:""}`:""}
    ${phone?`<br>📞 <strong>${esc(phone)}</strong>`:""}
    ${school.email?`&ensp;·&ensp;✉️ <strong>${esc(school.email)}</strong>`:""}
  </div>

  <div class="card">
    ${ok?`
    <div class="success">
      <div class="tick">✅</div>
      <h2>Application Received!</h2>
      <p>Your application has been sent to <strong>${esc(school.schoolName)}</strong>.</p>
      <div class="nxt">
        📞 The school will call or WhatsApp you shortly on the number you provided.<br><br>
        <strong>Keep your phone on</strong> — ${esc(school.schoolName)} will be in touch.
      </div>
    </div>`:`

    ${errMsg?`<div class="errbx">❌ ${esc(errMsg)}</div>`:""}

    <div class="stitle">Student Application Form</div>
    <p style="font-size:12px;color:#94a3b8;margin-bottom:16px">
      Fields marked <span style="color:#ef4444">*</span> are required
    </p>

    <form method="POST" action="/apply/school/${esc(req.params.id)}/submit">

      <div class="stitle">👤 Student Details</div>
      <div class="field">
        <label>Student Full Name <span class="req">*</span></label>
        <input name="studentName" type="text" required placeholder="e.g. Tatenda Moyo" autocomplete="name">
      </div>
      <div class="g2">
        <div class="field">
          <label>Grade / Form <span class="req">*</span></label>
          ${gradeSelect}
        </div>
        <div class="field">
          <label>Date of Birth <span class="req">*</span></label>
          <input name="dob" type="date" required>
        </div>
      </div>
      <div class="g2">
        <div class="field">
          <label>Gender</label>
          <select name="gender">
            <option value="">— Select —</option>
            <option>Male</option><option>Female</option>
          </select>
        </div>
        <div class="field">
          <label>Nationality</label>
          <input name="nationality" placeholder="e.g. Zimbabwean">
        </div>
      </div>
      <div class="field">
        <label>Current School (if any)</label>
        <input name="currentSchool" placeholder="e.g. Churchill Primary School">
      </div>
      <div class="field">
        <label>Home Address</label>
        <input name="homeAddress" placeholder="e.g. 12 Borrowdale Road, Harare">
      </div>

      <div class="stitle">👪 Parent / Guardian Details</div>
      <div class="field">
        <label>Parent / Guardian Full Name <span class="req">*</span></label>
        <input name="parentName" type="text" required placeholder="e.g. Blessing Moyo" autocomplete="name">
      </div>
      <div class="g2">
        <div class="field">
          <label>Relationship</label>
          <select name="relationship">
            <option value="">— Select —</option>
            <option>Father</option><option>Mother</option>
            <option>Guardian</option><option>Other</option>
          </select>
        </div>
        <div class="field">
          <label>Occupation</label>
          <input name="occupation" placeholder="e.g. Teacher">
        </div>
      </div>
      <div class="field">
        <label>WhatsApp / Phone Number <span class="req">*</span></label>
        <input name="parentPhone" type="tel" required placeholder="e.g. 0771234567" autocomplete="tel">
        <div class="note">The school will call or WhatsApp you on this number</div>
      </div>
      <div class="field">
        <label>Email Address (optional)</label>
        <input name="parentEmail" type="email" placeholder="parent@email.com" autocomplete="email">
      </div>

      <div class="stitle">🏥 Emergency &amp; Medical</div>
      <div class="g2">
        <div class="field">
          <label>Emergency Contact Name</label>
          <input name="emergencyName" placeholder="e.g. Chipo Moyo">
        </div>
        <div class="field">
          <label>Emergency Contact Phone</label>
          <input name="emergencyPhone" type="tel" placeholder="e.g. 0712345678">
        </div>
      </div>
      <div class="field">
        <label>Allergies / Medical Conditions</label>
        <textarea name="medical" rows="2" placeholder="None, or describe any conditions..."
          style="width:100%;padding:13px 14px;border:2px solid #e2e8f0;border-radius:8px;font-size:15px;resize:none;font-family:inherit"></textarea>
      </div>
      <div class="field">
        <label>Additional Notes (optional)</label>
        <textarea name="notes" rows="2" placeholder="Anything else the school should know..."
          style="width:100%;padding:13px 14px;border:2px solid #e2e8f0;border-radius:8px;font-size:15px;resize:none;font-family:inherit"></textarea>
      </div>

      <p class="legal">
        By submitting this form I confirm that all information provided is true and correct.
        This application will be sent directly to ${esc(school.schoolName)}.
      </p>
      <button type="submit" class="btn-sub">📩 Submit Application to ${esc(school.schoolName)}</button>
    </form>`}

    ${brochureUrl||rawFormUrl?`
    <div class="dl-sec">
      <h3>📥 Downloads</h3>
      ${brochureUrl?`
      <a href="${esc(brochureUrl)}" target="_blank" class="dl-link">
        <span class="ico">📄</span>
        <div><div>${esc(brochureName)}</div>
        <div class="meta">School Brochure — tap to view &amp; save</div></div>
      </a>`:""}
      ${rawFormUrl?`
      <a href="${esc(rawFormUrl)}" target="_blank" class="dl-link">
        <span class="ico">📋</span>
        <div><div>${esc(rawFormName)}</div>
        <div class="meta">Printable form — print &amp; hand in at school office</div></div>
      </a>`:""}
    </div>`:""}
  </div>
  <footer>
    Powered by <a href="https://zimquote.co.zw">ZimQuote</a> · School Management Platform
  </footer>
</div>
</body></html>`;

    res.send(html);
  } catch (err) {
    console.error("[SCHOOL WEB FORM]", err.message);
    res.status(500).send(
      `<html><body style="font-family:sans-serif;padding:40px;text-align:center">
        <h2>Something went wrong</h2>
        <p style="color:#dc2626">${esc(err.message)}</p>
        <p style="margin-top:12px">Please try again or contact the school directly.</p>
      </body></html>`);
  }
});

// ── POST /apply/school/:id/submit ─────────────────────────────────────────────
router.post("/apply/school/:id/submit", async (req, res) => {
  try {
    const SP     = (await import("../models/schoolProfile.js")).default;
    const school = await SP.findById(req.params.id).lean();
    if (!school) return res.status(404).send("School not found.");

    const {
      studentName, grade, dob, gender, nationality, currentSchool, homeAddress,
      parentName, relationship, parentPhone, parentEmail, occupation,
      emergencyName, emergencyPhone, medical, notes
    } = req.body;

    if (!studentName?.trim() || !grade?.trim() || !dob?.trim() ||
        !parentName?.trim() || !parentPhone?.trim()) {
      return res.redirect(`/apply/school/${req.params.id}?error=${encodeURIComponent(
        "Please fill in all required fields: Student name, Grade, Date of birth, Parent name, and Phone number."
      )}`);
    }

    const data = {
      studentName:    studentName.trim(),
      grade:          grade.trim(),
      dob:            dob.trim(),
      gender:         gender?.trim()         || "",
      nationality:    nationality?.trim()    || "",
      currentSchool:  currentSchool?.trim()  || "",
      homeAddress:    homeAddress?.trim()    || "",
      parentName:     parentName.trim(),
      relationship:   relationship?.trim()   || "",
      parentPhone:    parentPhone.trim(),
      parentEmail:    parentEmail?.trim()    || "",
      occupation:     occupation?.trim()     || "",
      emergencyName:  emergencyName?.trim()  || "",
      emergencyPhone: emergencyPhone?.trim() || "",
      medical:        medical?.trim()        || "",
      notes:          notes?.trim()          || "",
      intakeYear:     school.applicationForm?.intakeYear || "",
      submittedVia:   "web"
    };

    // Normalise phone for contact record + WhatsApp
    const normP = parentPhone.replace(/\D/g, "");
    const fullP = normP.startsWith("0") ? "263" + normP.slice(1) : normP;

    // 1. Save/update contact record
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
    } catch (_ce) { console.warn("[SCHOOL WEB CONTACT]", _ce.message); }

    // 2. Email school + WhatsApp notify all school numbers
    try {
      const { notifySchoolWebSubmission } =
        await import("../services/schoolApplicationForm.js");
      await notifySchoolWebSubmission({ school, data, applicantPhone: fullP });
    } catch (_ne) { console.warn("[SCHOOL WEB NOTIFY]", _ne.message); }

    res.redirect(`/apply/school/${req.params.id}?success=1`);
  } catch (err) {
    console.error("[SCHOOL WEB SUBMIT]", err.message);
    res.redirect(`/apply/school/${req.params.id}?error=${encodeURIComponent(
      "Submission failed. Please try again or contact the school directly."
    )}`);
  }
});

export default router;