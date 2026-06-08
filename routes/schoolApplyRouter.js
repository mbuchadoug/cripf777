// routes/schoolApplyRouter.js
// ─── Public School Application Form Router ────────────────────────────────────
//
// MOUNT THIS AT ROOT in server.js / app.js:
//   import schoolApplyRouter from "./routes/schoolApplyRouter.js";
//   app.use("/", schoolApplyRouter);
//
// This gives:
//   GET  https://cripfcnt.com/apply/school/:id          → web form
//   POST https://cripfcnt.com/apply/school/:id/submit   → handle submission
//
// NO AUTH REQUIRED — public-facing pages for parents.
// ─────────────────────────────────────────────────────────────────────────────

import express from "express";
const router = express.Router();

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ── GET /apply/school/:id ─────────────────────────────────────────────────────
router.get("/apply/school/:id", async (req, res) => {
  try {
    const SP     = (await import("../models/schoolProfile.js")).default;
    const school = await SP.findById(req.params.id).lean();
    if (!school) return res.status(404).send(`
      <html><body style="font-family:sans-serif;padding:40px;text-align:center">
        <h2>School not found</h2><p>This link may have expired. Please contact the school directly.</p>
      </body></html>`);

    const form       = school.applicationForm || {};
    const feesRaw    = school.fees;
    const feesStr    = feesRaw?.term1
      ? `$${feesRaw.term1}/term`
      : (typeof feesRaw === "number" ? `$${feesRaw}/term` : "");
    const curriculum = (school.curriculum || []).map(c => c.toUpperCase()).join(" + ") || "";
    const location   = school.location?.area
      ? `${school.location.area}, ${school.location.city || ""}`
      : school.location?.city || school.suburb || "";
    const gradeOpts  = form.gradeOptions || [];
    const intakeYear = form.intakeYear || "";
    const phone      = school.contactPhone || school.phone || "";
    const ok         = req.query.success === "1";
    const errMsg     = req.query.error ? decodeURIComponent(req.query.error) : "";

    // Capture contact in background (web visit)
    try {
      const SC = (await import("../models/schoolContact.js")).default;
      const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress || "web";
      await SC.findOneAndUpdate(
        { schoolId: school._id, phone: `web_${ip.replace(/[.:]/g,"_")}` },
        { $set: { lastSeen: new Date(), source: "apply" }, $inc: { viewCount: 1 }, $setOnInsert: { firstSeen: new Date(), schoolId: school._id } },
        { upsert: true }
      );
    } catch (_) {}

    // Notify school of web form open
    try {
      const { notifyAllSchoolApplicationInterest } = await import("../services/schoolNotifications.js");
      notifyAllSchoolApplicationInterest(school, "Web visitor").catch(() => {});
    } catch (_) {}

    const gradeSelect = gradeOpts.length
      ? `<select name="grade" required style="width:100%;padding:12px 14px;border:2px solid #e2e8f0;border-radius:8px;font-size:16px;background:white;-webkit-appearance:none">
           <option value="">— Select grade / form —</option>
           ${gradeOpts.map(g => `<option value="${esc(g)}">${esc(g)}</option>`).join("")}
         </select>`
      : `<input name="grade" type="text" required placeholder="e.g. Form 1, Grade 7, ECD A" style="width:100%;padding:12px 14px;border:2px solid #e2e8f0;border-radius:8px;font-size:16px">`;

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<title>Apply — ${esc(school.schoolName)}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#f0f4f8;min-height:100vh}
.wrap{max-width:580px;margin:0 auto;padding:0 0 32px}
.header{background:linear-gradient(135deg,#1a3c5e 0%,#1e6091 100%);color:white;padding:28px 24px 24px;text-align:center}
.header .icon{font-size:40px;margin-bottom:8px}
.header h1{font-size:22px;font-weight:800;margin-bottom:4px;line-height:1.2}
.header .intake{font-size:13px;opacity:.85;margin-top:4px}
.school-info{background:#1a3c5e;padding:14px 20px;font-size:13px;color:#bfdbfe;line-height:1.8;border-bottom:1px solid rgba(255,255,255,.1)}
.school-info span{color:white;font-weight:600}
.card{background:white;margin:0;padding:22px 20px;border-bottom:1px solid #e2e8f0}
.card:last-child{border-bottom:none;border-radius:0 0 12px 12px}
.section-title{font-size:11px;font-weight:800;color:#64748b;text-transform:uppercase;letter-spacing:1px;margin-bottom:14px;padding-bottom:8px;border-bottom:2px solid #f0f4f8}
.field{margin-bottom:14px}
label{display:block;font-size:13px;font-weight:700;color:#374151;margin-bottom:6px}
.req{color:#ef4444;margin-left:2px}
input[type=text],input[type=date],input[type=email],input[type=tel],select,textarea{
  width:100%;padding:12px 14px;border:2px solid #e2e8f0;border-radius:8px;font-size:16px;
  outline:none;font-family:inherit;-webkit-appearance:none;transition:border-color .15s}
input:focus,select:focus,textarea:focus{border-color:#1a3c5e}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:12px}
@media(max-width:460px){.grid2{grid-template-columns:1fr}}
.btn-submit{width:100%;padding:16px;background:linear-gradient(135deg,#1a3c5e,#1e6091);
  color:white;border:none;border-radius:10px;font-size:17px;font-weight:800;cursor:pointer;
  margin-top:4px;letter-spacing:.3px;-webkit-tap-highlight-color:transparent}
.btn-submit:active{opacity:.88}
.success{text-align:center;padding:32px 20px}
.success .tick{font-size:56px;margin-bottom:12px}
.success h2{color:#16a34a;font-size:20px;font-weight:800;margin-bottom:8px}
.success p{color:#374151;font-size:14px;line-height:1.6}
.success .next{background:#f0fdf4;border:1px solid #bbf7d0;border-radius:10px;padding:14px;margin-top:16px;text-align:left;font-size:13px;color:#166534}
.error-box{background:#fef2f2;border:2px solid #fecaca;border-radius:8px;padding:12px 16px;margin-bottom:16px;color:#dc2626;font-size:14px}
.downloads{background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:16px;margin-top:16px}
.downloads h3{font-size:12px;font-weight:800;color:#64748b;text-transform:uppercase;letter-spacing:.6px;margin-bottom:12px}
.dl-btn{display:flex;align-items:center;gap:10px;padding:12px 14px;background:white;
  border:1.5px solid #e2e8f0;border-radius:8px;text-decoration:none;color:#1a3c5e;
  font-size:14px;font-weight:600;margin-bottom:8px}
.dl-btn:last-child{margin-bottom:0}
.dl-icon{font-size:20px;flex-shrink:0}
.note{font-size:12px;color:#94a3b8;margin-top:5px;line-height:1.4}
.footer{text-align:center;font-size:12px;color:#94a3b8;padding:20px;background:#f8fafc;border-top:1px solid #e2e8f0}
.footer a{color:#1a3c5e;font-weight:600;text-decoration:none}
.required-note{font-size:12px;color:#94a3b8;margin-bottom:16px}
</style>
</head>
<body>
<div class="wrap">
  <div class="header">
    <div class="icon">🏫</div>
    <h1>${esc(school.schoolName)}${school.verified ? " ✅" : ""}</h1>
    ${intakeYear ? `<div class="intake">📋 ${esc(intakeYear)}</div>` : ""}
  </div>

  <div class="school-info">
    ${location ? `📍 <span>${esc(location)}</span>&nbsp;&nbsp;` : ""}
    ${feesStr  ? `💰 <span>${esc(feesStr)}</span>${curriculum ? `&nbsp;·&nbsp;<span>${esc(curriculum)}</span>` : ""}` : ""}
    ${phone ? `<br>📞 <span>${esc(phone)}</span>` : ""}
    ${school.email ? `&nbsp;·&nbsp; ✉️ <span>${esc(school.email)}</span>` : ""}
  </div>

  <div class="card">
    ${ok ? `
    <div class="success">
      <div class="tick">✅</div>
      <h2>Application Submitted!</h2>
      <p>Your application has been sent to <strong>${esc(school.schoolName)}</strong>.</p>
      <div class="next">
        📞 The school will call or WhatsApp you shortly.<br>
        📧 A copy has been sent to the school by email.<br><br>
        <strong>What to do now:</strong> Keep your phone on — ${esc(school.schoolName)} will be in touch.
      </div>
    </div>
    ` : `
    ${errMsg ? `<div class="error-box">❌ ${esc(errMsg)}</div>` : ""}

    <div class="section-title">Student Application Form</div>
    <p class="required-note">Fields marked <span style="color:#ef4444">*</span> are required</p>

    <form method="POST" action="/apply/school/${esc(req.params.id)}/submit" novalidate>

      <div class="section-title" style="margin-top:4px">👤 Student Details</div>

      <div class="field">
        <label>Student Full Name <span class="req">*</span></label>
        <input name="studentName" type="text" required placeholder="e.g. Tatenda Moyo" autocomplete="name">
      </div>

      <div class="grid2">
        <div class="field">
          <label>Grade Applying For <span class="req">*</span></label>
          ${gradeSelect}
        </div>
        <div class="field">
          <label>Date of Birth <span class="req">*</span></label>
          <input name="dob" type="date" required>
        </div>
      </div>

      <div class="grid2">
        <div class="field">
          <label>Gender</label>
          <select name="gender" style="width:100%;padding:12px 14px;border:2px solid #e2e8f0;border-radius:8px;font-size:16px;background:white;-webkit-appearance:none">
            <option value="">— Select —</option>
            <option>Male</option>
            <option>Female</option>
          </select>
        </div>
        <div class="field">
          <label>Nationality</label>
          <input name="nationality" type="text" placeholder="e.g. Zimbabwean">
        </div>
      </div>

      <div class="field">
        <label>Current School (if any)</label>
        <input name="currentSchool" type="text" placeholder="e.g. Churchill Primary School">
      </div>

      <div class="field">
        <label>Home Address</label>
        <input name="homeAddress" type="text" placeholder="e.g. 12 Borrowdale Road, Harare">
      </div>

      <div class="section-title" style="margin-top:20px">👪 Parent / Guardian Details</div>

      <div class="field">
        <label>Parent / Guardian Full Name <span class="req">*</span></label>
        <input name="parentName" type="text" required placeholder="e.g. Blessing Moyo" autocomplete="name">
      </div>

      <div class="grid2">
        <div class="field">
          <label>Relationship</label>
          <select name="relationship" style="width:100%;padding:12px 14px;border:2px solid #e2e8f0;border-radius:8px;font-size:16px;background:white;-webkit-appearance:none">
            <option value="">— Select —</option>
            <option>Father</option>
            <option>Mother</option>
            <option>Guardian</option>
            <option>Other</option>
          </select>
        </div>
        <div class="field">
          <label>Occupation</label>
          <input name="occupation" type="text" placeholder="e.g. Teacher">
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

      <div class="section-title" style="margin-top:20px">🏥 Emergency &amp; Medical</div>

      <div class="grid2">
        <div class="field">
          <label>Emergency Contact Name</label>
          <input name="emergencyName" type="text" placeholder="e.g. Chipo Moyo">
        </div>
        <div class="field">
          <label>Emergency Contact Phone</label>
          <input name="emergencyPhone" type="tel" placeholder="e.g. 0712345678">
        </div>
      </div>

      <div class="field">
        <label>Known Allergies / Medical Conditions</label>
        <textarea name="medical" rows="2" placeholder="None, or describe any conditions..."
          style="width:100%;padding:12px 14px;border:2px solid #e2e8f0;border-radius:8px;font-size:15px;resize:none;font-family:inherit"></textarea>
      </div>

      <div class="field">
        <label>Additional Notes (optional)</label>
        <textarea name="notes" rows="2" placeholder="Anything else the school should know..."
          style="width:100%;padding:12px 14px;border:2px solid #e2e8f0;border-radius:8px;font-size:15px;resize:none;font-family:inherit"></textarea>
      </div>

      <p style="font-size:12px;color:#94a3b8;margin:16px 0 12px;line-height:1.5">
        By submitting this form I confirm that all information provided is true and correct.
        This application will be sent directly to ${esc(school.schoolName)}.
      </p>

      <button type="submit" class="btn-submit">📩 Submit Application to ${esc(school.schoolName)}</button>
    </form>
    `}

    ${form.brochureUrl || form.rawFormUrl ? `
    <div class="downloads">
      <h3>📥 Downloads</h3>
      ${form.brochureUrl ? `
      <a href="${esc(form.brochureUrl)}" target="_blank" class="dl-btn">
        <span class="dl-icon">📄</span>
        <div><div>${esc(form.brochureName || "School Brochure")}</div>
        <div style="font-size:12px;color:#64748b;font-weight:400">Tap to open or download</div></div>
      </a>` : ""}
      ${form.rawFormUrl ? `
      <a href="${esc(form.rawFormUrl)}" target="_blank" class="dl-btn">
        <span class="dl-icon">📋</span>
        <div><div>${esc(form.rawFormName || "Printable Application Form")}</div>
        <div style="font-size:12px;color:#64748b;font-weight:400">Print, fill in &amp; hand in at the school office</div></div>
      </a>` : ""}
    </div>` : ""}
  </div>

  <div class="footer">
    Powered by <a href="https://zimquote.co.zw">ZimQuote</a> · School Management Platform
  </div>
</div>
</body></html>`;

    res.send(html);
  } catch (err) {
    console.error("[SCHOOL WEB FORM]", err.message);
    res.status(500).send(`<html><body style="font-family:sans-serif;padding:40px;text-align:center">
      <h2>Something went wrong</h2><p>Please try again or contact the school directly.</p>
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

    // Validate required fields
    if (!studentName?.trim() || !grade?.trim() || !dob?.trim() || !parentName?.trim() || !parentPhone?.trim()) {
      return res.redirect(`/apply/school/${req.params.id}?error=${encodeURIComponent("Please fill in all required fields: Student name, Grade, Date of birth, Parent name, and Phone number.")}`);
    }

    const data = {
      studentName:   studentName.trim(),
      grade:         grade.trim(),
      dob:           dob.trim(),
      gender:        gender?.trim() || "",
      nationality:   nationality?.trim() || "",
      currentSchool: currentSchool?.trim() || "",
      homeAddress:   homeAddress?.trim() || "",
      parentName:    parentName.trim(),
      relationship:  relationship?.trim() || "",
      parentPhone:   parentPhone.trim(),
      parentEmail:   parentEmail?.trim() || "",
      occupation:    occupation?.trim() || "",
      emergencyName: emergencyName?.trim() || "",
      emergencyPhone:emergencyPhone?.trim() || "",
      medical:       medical?.trim() || "",
      notes:         notes?.trim() || "",
      intakeYear:    school.applicationForm?.intakeYear || "",
      submittedVia:  "web"
    };

    // Normalise phone for DB and WhatsApp
    const normP = parentPhone.replace(/\D/g, "");
    const fullP = normP.startsWith("0") ? "263" + normP.slice(1) : normP;

    // 1. Save contact record
    try {
      const SC = (await import("../models/schoolContact.js")).default;
      await SC.findOneAndUpdate(
        { schoolId: school._id, phone: fullP },
        {
          $set:        { lastSeen: new Date(), source: "apply", converted: true, appliedAt: new Date(),
                         studentName: data.studentName, parentName: data.parentName,
                         gradeInterest: data.grade, applicationData: data },
          $inc:        { viewCount: 1 },
          $setOnInsert: { firstSeen: new Date(), phone: fullP, schoolId: school._id }
        },
        { upsert: true }
      );
    } catch (_ce) { console.warn("[SCHOOL WEB CONTACT]", _ce.message); }

    // 2. Email school + WhatsApp notifications
    try {
      const { notifySchoolWebSubmission } = await import("../services/schoolApplicationForm.js");
      await notifySchoolWebSubmission({ school, data, applicantPhone: fullP });
    } catch (_ne) { console.warn("[SCHOOL WEB NOTIFY]", _ne.message); }

    res.redirect(`/apply/school/${req.params.id}?success=1`);
  } catch (err) {
    console.error("[SCHOOL WEB SUBMIT]", err.message);
    res.redirect(`/apply/school/${req.params.id}?error=${encodeURIComponent("Submission failed. Please try again or contact the school directly.")}`);
  }
});

export default router;