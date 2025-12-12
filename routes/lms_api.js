// routes/lms_api.js
import { Router } from "express";
import mongoose from "mongoose";
import fs from "fs";
import path from "path";

import Organization from "../models/organization.js";
import Question from "../models/question.js";         // Question model (used throughout)
import ExamInstance from "../models/examInstance.js";
import Attempt from "../models/attempt.js";
import User from "../models/user.js"; // <-- added for certificate user info

const router = Router();

/* ---------- Begin: Puppeteer + PDFKit helpers (added) ---------- */

// robustly import pdfkit like you used elsewhere (async top-level not possible here so attempt sync-ish)
let PDFDocument = null;
try {
  // try dynamic import style — wrapped in try/catch to be permissive in different node setups
  const maybePdfkit = (() => {
    try { return require("pdfkit"); } catch (e) { return null; }
  })();
  PDFDocument = maybePdfkit || null;
} catch (e) {
  PDFDocument = null;
}

// try to load puppeteer (prefer user-installed puppeteer/pupeteer-core)
let puppeteer = null;
try {
  try { puppeteer = require("puppeteer"); } catch (e) { try { puppeteer = require("puppeteer-core"); } catch (er) { puppeteer = null; } }
} catch (e) {
  puppeteer = null;
}

// helper: ensure cert dir exists
function ensureCertsDir() {
  const certsDir = path.join(process.cwd(), "public", "certs");
  try {
    if (!fs.existsSync(certsDir)) fs.mkdirSync(certsDir, { recursive: true });
  } catch (e) { console.warn("[certs] ensure dir failed:", e && e.message); }
  return certsDir;
}

// render HTML to PDF using puppeteer (throws if puppeteer not available or fails)
async function renderHtmlToPdf(html, filepath) {
  if (!puppeteer) throw new Error("Puppeteer not available");
  const launchOptions = {
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"]
  };
  if (process.env.PUPPETEER_EXECUTABLE_PATH) launchOptions.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
  if (process.env.PUPPETEER_LAUNCH_OPTS) {
    try {
      const extra = JSON.parse(process.env.PUPPETEER_LAUNCH_OPTS);
      Object.assign(launchOptions, extra);
    } catch (e) { console.warn("Invalid PUPPETEER_LAUNCH_OPTS JSON, ignoring"); }
  }

  const browser = await puppeteer.launch(launchOptions);
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "networkidle0", timeout: 30000 });
    await page.emulateMediaType("screen");
    await page.pdf({
      path: filepath,
      format: "A4",
      printBackground: true,
      landscape: true,
      margin: { top: "18pt", bottom: "18pt", left: "18pt", right: "18pt" }
    });
    await page.close();
  } finally {
    try { await browser.close(); } catch (e) {}
  }
}

// small HTML escape util
function escapeHtmlForCert(s) {
  if (!s && s !== 0) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/**
 * renderCertificatePdf(attemptObj, userObj, orgObj)
 * - attemptObj: plain object representing attemptDoc (examId, score, maxScore, finishedAt, module)
 * - userObj: plain user object (name/email/_id)
 * - orgObj: organization object (name, logoUrl)
 *
 * Returns: { ok: true, filePath, url } or { ok:false, error }
 */
async function renderCertificatePdf(attemptObj = {}, userObj = {}, orgObj = {}) {
  try {
    const certsDir = ensureCertsDir();

    const userName = (userObj && (userObj.displayName || userObj.name || userObj.email)) ? (userObj.displayName || userObj.name || userObj.email) : "Learner";
    const moduleLabel = attemptObj.module || "Module";
    const score = (typeof attemptObj.score === "number") ? attemptObj.score : (attemptObj.score || 0);
    const maxScore = (typeof attemptObj.maxScore === "number") ? attemptObj.maxScore : (attemptObj.maxScore || 0);
    const percentage = Math.round((score / Math.max(1, maxScore)) * 100);
    const issuedAt = new Date(attemptObj.finishedAt || Date.now());
    const issuedAtPretty = issuedAt.toLocaleDateString();
    const issuedAtIso = issuedAt.toISOString();

    const orgName = (orgObj && orgObj.name) ? orgObj.name : (attemptObj.organization || "");
    const rawLogoUrl = (orgObj && orgObj.logoUrl) ? orgObj.logoUrl : (attemptObj.organizationLogo || "");

    // inline local logo if available under public/docs/logos/...
    let logoForHtml = "";
    try {
      if (rawLogoUrl) {
        let logoPathPart = null;
        const site = (process.env.SITE_URL || "").replace(/\/$/, "");
        if (rawLogoUrl.startsWith("/")) logoPathPart = rawLogoUrl;
        else if (site && rawLogoUrl.startsWith(site)) logoPathPart = rawLogoUrl.slice(site.length);
        else {
          const idx = rawLogoUrl.indexOf("/docs/logos/");
          if (idx !== -1) logoPathPart = rawLogoUrl.slice(idx);
        }
        if (logoPathPart && logoPathPart.startsWith("/docs/logos/")) {
          const logoFilename = path.basename(logoPathPart);
          const localLogo = path.join(process.cwd(), "public", "docs", "logos", logoFilename);
          if (fs.existsSync(localLogo)) {
            const data = fs.readFileSync(localLogo);
            const ext = path.extname(localLogo).toLowerCase();
            let mime = "image/png";
            if (ext === ".jpg" || ext === ".jpeg") mime = "image/jpeg";
            else if (ext === ".gif") mime = "image/gif";
            else if (ext === ".svg") mime = "image/svg+xml";
            const b64 = data.toString("base64");
            logoForHtml = `data:${mime};base64,${b64}`;
          } else {
            logoForHtml = rawLogoUrl;
          }
        } else {
          logoForHtml = rawLogoUrl;
        }
      }
    } catch (e) {
      console.warn("[cert] logo inline failed:", e && e.message);
      logoForHtml = rawLogoUrl || "";
    }

    // certificate HTML (clean, printable)
    const certId = escapeHtmlForCert(attemptObj.examId || attemptObj._id || ("cert-" + Date.now()));
    const html = `
      <!doctype html>
      <html>
      <head>
        <meta charset="utf-8"/>
        <title>Certificate - ${escapeHtmlForCert(userName)}</title>
        <style>
          @page { size: A4 landscape; margin: 18pt; }
          body { font-family: Arial, Helvetica, sans-serif; margin:0; background:#f6f7fb; color:#222; }
          .container { width:100%; height:100%; display:flex; align-items:center; justify-content:center; padding:24px; }
          .card { width:1000px; height:640px; background:linear-gradient(#fff,#fcfcff); border-radius:12px; border:6px solid #efe6c3; padding:28px; box-shadow:0 12px 40px rgba(0,0,0,0.08); display:flex; flex-direction:column; }
          .top { display:flex; gap:18px; align-items:center; }
          .logo { width:110px; height:110px; border-radius:8px; overflow:hidden; display:flex; align-items:center; justify-content:center; background:#fff; border:1px solid #eee; }
          .logo img { max-width:100%; max-height:100%; object-fit:contain; }
          .org { font-size:18px; font-weight:700; color:#2b3b6f; }
          .cert-title { text-align:center; margin-top:18px; font-size:36px; font-weight:800; color:#143063; }
          .subtitle { text-align:center; color:#444; margin-top:6px; font-size:15px; }
          .recipient { text-align:center; margin-top:28px; }
          .recipient .name { font-size:28px; font-weight:800; color:#111; }
          .recipient .module { margin-top:8px; color:#666; font-size:15px; }
          .metaRow { display:flex; justify-content:center; gap:18px; margin-top:18px; color:#555; font-size:13px; }
          .scoreBox { background:#f1f7ff; padding:12px 18px; border-radius:8px; border:1px solid #dbeafe; font-weight:700; color:#0b4a9e; }
          .footer { margin-top:30px; display:flex; justify-content:space-between; align-items:center; width:100%; }
          .sig { text-align:right; }
          .sig .line { width:220px; border-top:1px solid #aaa; margin-top:40px; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="card" role="document" aria-label="Certificate">
            <div class="top">
              <div class="logo">
                ${logoForHtml ? `<img src="${escapeHtmlForCert(logoForHtml)}" alt="logo" />` : `<svg width="80" height="80" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg"><rect width="100" height="100" rx="12" fill="#eef2ff"/></svg>`}
              </div>
              <div>
                <div class="org">${escapeHtmlForCert(orgName || "")}</div>
                <div style="color:#666; font-size:13px; margin-top:6px;">Certificate of Completion</div>
              </div>
            </div>

            <div style="flex:1; display:flex; flex-direction:column; align-items:center; justify-content:center;">
              <div class="cert-title">Certificate of Achievement</div>
              <div class="subtitle">This is to certify that</div>

              <div class="recipient">
                <div class="name">${escapeHtmlForCert(userName)}</div>
                <div class="module">has successfully completed the <strong>${escapeHtmlForCert(moduleLabel)}</strong> module</div>
              </div>

              <div class="metaRow" role="note">
                <div class="scoreBox">${score} / ${maxScore} (${percentage}%)</div>
                <div>Issued: ${escapeHtmlForCert(issuedAtPretty)}</div>
                <div>Certificate ID: ${certId}</div>
              </div>
            </div>

            <div class="footer">
              <div style="font-size:12px; color:#888;">Verified on ${escapeHtmlForCert(issuedAtIso)}</div>
              <div class="sig">
                <div class="line"></div>
                <div style="font-weight:700; margin-top:6px;">Programme Lead</div>
              </div>
            </div>
          </div>
        </div>
      </body>
      </html>
    `;

    // ensure unique filename
    const safeUser = (userObj && (userObj._id || userObj.email)) ? String(userObj._id || userObj.email).replace(/[^A-Za-z0-9_-]/g, "") : "learner";
    const filename = `certificate_${safeUser}_${Date.now()}.pdf`;
    const filePath = path.join(certsDir, filename);

    // attempt puppeteer first
    if (puppeteer) {
      try {
        await renderHtmlToPdf(html, filePath);
        const publicUrl = `/certs/${filename}`;
        return { ok: true, filePath, url: publicUrl };
      } catch (e) {
        console.warn("[cert] Puppeteer render failed, falling back to pdfkit:", e && (e.message || e));
      }
    } else {
      console.info("[cert] Puppeteer not installed, using pdfkit fallback");
    }

    // fallback to pdfkit if available
    if (!PDFDocument) {
      return { ok: false, error: "No renderer available (puppeteer and pdfkit missing)" };
    }

    // Render a simple PDF with pdfkit (not as pretty, but sufficient)
    try {
      const doc = new PDFDocument({ size: "A4", layout: "landscape", margin: 36 });
      const stream = fs.createWriteStream(filePath);
      doc.pipe(stream);

      // Simple layout: big title, name, module, small footer
      doc.fontSize(20).fillColor("#1f3d7a").text(orgName || "", { align: "left" });
      doc.moveDown(1);
      doc.fontSize(30).fillColor("#143063").text("Certificate of Achievement", { align: "center" });
      doc.moveDown(1.5);
      doc.fontSize(12).fillColor("#444").text("This is to certify that", { align: "center" });
      doc.moveDown(0.5);
      doc.fontSize(28).fillColor("#000").text(userName, { align: "center" });
      doc.moveDown(0.5);
      doc.fontSize(14).fillColor("#444").text(`has successfully completed the "${moduleLabel}" module`, { align: "center" });
      doc.moveDown(1.2);
      doc.fontSize(16).fillColor("#0b4a9e").text(`${score} / ${maxScore} (${percentage}%)`, { align: "center" });
      doc.moveDown(3);
      doc.fontSize(10).fillColor("#666").text(`Issued: ${issuedAtPretty} — Certificate ID: ${certId}`, { align: "center" });

      doc.end();

      await new Promise((resolve, reject) => {
        stream.on("finish", resolve);
        stream.on("error", reject);
      });

      const publicUrl = `/certs/${filename}`;
      return { ok: true, filePath, url: publicUrl };
    } catch (err) {
      console.error("[cert] pdfkit render error:", err && (err.stack || err));
      return { ok: false, error: err && err.message ? err.message : "pdfkit failed" };
    }
  } catch (err) {
    console.error("[cert] unexpected error:", err && (err.stack || err));
    return { ok: false, error: err && err.message ? err.message : "unexpected error" };
  }
}

/* ---------- End: Puppeteer + PDFKit helpers (added) ---------- */

/* ---------- existing code continues (unchanged) ---------- */
/* Your existing functions: fetchRandomQuestionsFromFile, normalizeIds, quiz GET route, etc. */

/* 
  (I did not remove or alter any of your original logic here. 
   The rest of your file remains unchanged except for the insertion below inside POST /quiz/submit 
   where, when passed === true, we call renderCertificatePdf and include certificateUrl in the response.)
*/

/* ---------- POST /api/lms/quiz/submit (only small insertion added) ---------- */

router.post("/quiz/submit", async (req, res) => {
  try {
    const payload = req.body || {};
    const answers = Array.isArray(payload.answers) ? payload.answers : [];
    if (!answers.length) return res.status(400).json({ error: "No answers submitted" });

    const examId = String(payload.examId || "").trim() || null;
    const moduleKey = String(payload.module || "").trim() || null;
    const orgSlugOrId = payload.org || null;

    // map of question ids supplied
    const qIds = answers.map(a => a.questionId).filter(Boolean).map(String);

    // try to load ExamInstance (may be null)
    let exam = null;
    if (examId) {
      try {
        exam = await ExamInstance.findOne({ examId }).lean().exec();
      } catch (e) {
        console.error("[quiz/submit] exam lookup error:", e && (e.stack || e));
      }
    }

    // load DB questions for any ObjectId-like ids (use Question model)
    const byId = {};
    const dbIds = qIds.filter(id => mongoose.isValidObjectId(id));
    if (dbIds.length) {
      try {
        const qDocs = await Question.find({ _id: { $in: dbIds } }).lean().exec();
        for (const q of qDocs) byId[String(q._id)] = q;
      } catch (e) {
        console.error("[quiz/submit] DB lookup error:", e && (e.stack || e));
      }
    }

    // file fallback: include file questions by id (for fid-... items)
    try {
      const p = path.join(process.cwd(), "data", "data_questions.json");
      if (fs.existsSync(p)) {
        const fileQ = JSON.parse(fs.readFileSync(p, "utf8"));
        for (const fq of fileQ) {
          const fid = String(fq.id || fq._id || fq.uuid || "");
          if (fid && !byId[fid]) byId[fid] = fq;
        }
      }
    } catch (e) {
      console.error("[quiz/submit] file fallback error:", e && (e.stack || e));
    }

    // Build a quick lookup for exam question order & choicesOrder if exam exists
    const examIndexMap = {}; // questionId -> index in exam.questionIds
    const examChoicesOrder = Array.isArray(exam && exam.choicesOrder) ? exam.choicesOrder : [];

    if (exam && Array.isArray(exam.questionIds)) {
      for (let i = 0; i < exam.questionIds.length; i++) {
        const qidStr = String(exam.questionIds[i]);
        examIndexMap[qidStr] = i;
      }
    }

    // Scoring & saved answers
    let score = 0;
    const details = [];
    const savedAnswers = [];

    for (const a of answers) {
      const qid = String(a.questionId || "");
      const shownIndex = (typeof a.choiceIndex === "number") ? a.choiceIndex : null;

      let canonicalIndex = (typeof shownIndex === "number") ? shownIndex : null;

      if (exam && examIndexMap.hasOwnProperty(qid)) {
        const qPos = examIndexMap[qid];
        const mapping = Array.isArray(examChoicesOrder[qPos]) ? examChoicesOrder[qPos] : null;
        if (mapping && typeof shownIndex === "number") {
          const mapped = mapping[shownIndex];
          if (typeof mapped === "number") canonicalIndex = mapped;
        }
      }

      const qdoc = byId[qid] || null;

      let correctIndex = null;
      if (qdoc) {
        if (typeof qdoc.correctIndex === "number") correctIndex = qdoc.correctIndex;
        else if (typeof qdoc.answerIndex === "number") correctIndex = qdoc.answerIndex;
        else if (typeof qdoc.correct === "number") correctIndex = qdoc.correct;
      }

      let selectedText = "";
      if (qdoc) {
        const choices = qdoc.choices || [];
        const tryChoice = (idx) => {
          if (idx === null || idx === undefined) return "";
          const c = choices[idx];
          if (!c) return "";
          return (typeof c === "string") ? c : (c.text || "");
        };
        selectedText = tryChoice(canonicalIndex);
      }

      const correct = (correctIndex !== null && canonicalIndex !== null && correctIndex === canonicalIndex);
      if (correct) score++;

      details.push({
        questionId: qid,
        correctIndex: (correctIndex !== null) ? correctIndex : null,
        yourIndex: canonicalIndex,
        correct: !!correct
      });

      const qObjId = mongoose.isValidObjectId(qid) ? mongoose.Types.ObjectId(qid) : qid;
      savedAnswers.push({
        questionId: qObjId,
        choiceIndex: (typeof canonicalIndex === "number") ? canonicalIndex : null,
        shownIndex: (typeof shownIndex === "number") ? shownIndex : null,
        selectedText,
        correctIndex: (typeof correctIndex === "number") ? correctIndex : null,
        correct: !!correct
      });
    }

    const total = answers.length;
    const percentage = Math.round((score / Math.max(1, total)) * 100);
    const passThreshold = parseInt(process.env.QUIZ_PASS_THRESHOLD || "60", 10);
    const passed = percentage >= passThreshold;

    // Find / update or create Attempt
    let attemptFilter = {};
    if (examId) attemptFilter.examId = examId;
    else {
      attemptFilter = {
        userId: (req.user && req.user._id) ? req.user._id : undefined,
        organization: (exam && exam.org) ? exam.org : undefined,
        module: exam ? exam.module : (moduleKey || undefined)
      };
    }
    Object.keys(attemptFilter).forEach(k => attemptFilter[k] === undefined && delete attemptFilter[k]);

    let attempt = null;
    try {
      if (Object.keys(attemptFilter).length) {
        attempt = await Attempt.findOne(attemptFilter).sort({ createdAt: -1 }).exec();
      }
    } catch (e) {
      console.error("[quiz/submit] attempt lookup error:", e && (e.stack || e));
    }

    const now = new Date();
    const attemptDoc = {
      examId: examId || ("exam-" + Date.now().toString(36)),
      userId: (req.user && req.user._id) ? req.user._id : (exam && exam.user) ? exam.user : null,
      organization: (exam && exam.org) ? exam.org : (typeof orgSlugOrId === 'string' ? orgSlugOrId : null),
      module: (exam && exam.module) ? exam.module : (moduleKey || null),
      questionIds: (exam && Array.isArray(exam.questionIds)) ? exam.questionIds : qIds.map(id => (mongoose.isValidObjectId(id) ? mongoose.Types.ObjectId(id) : id)),
      answers: savedAnswers,
      score,
      maxScore: total,
      passed: !!passed,
      status: "finished",
      startedAt: (exam && exam.createdAt) ? exam.createdAt : now,
      finishedAt: now,
      updatedAt: now,
      createdAt: attempt ? attempt.createdAt : now
    };

    let savedAttempt = null;
    if (attempt) {
      try {
        await Attempt.updateOne({ _id: attempt._id }, { $set: attemptDoc }).exec();
        savedAttempt = await Attempt.findById(attempt._id).lean().exec();
      } catch (e) {
        console.error("[quiz/submit] attempt update failed:", e && (e.stack || e));
      }
    } else {
      try {
        const newA = await Attempt.create(attemptDoc);
        savedAttempt = await Attempt.findById(newA._id).lean().exec();
      } catch (e) {
        console.error("[quiz/submit] attempt create failed:", e && (e.stack || e));
      }
    }

    // mark exam instance as used (optional)
    if (exam) {
      try {
        await ExamInstance.updateOne({ examId: exam.examId }, { $set: { updatedAt: now, expiresAt: now } }).exec();
      } catch (e) {
        console.error("[quiz/submit] failed to update examInstance:", e && (e.stack || e));
      }
    }

    // ---------- NEW: generate certificate if passed ----------
    let certResult = null;
    if (passed) {
      try {
        // build attempt object to pass to renderer (use attemptDoc / savedAttempt as best available)
        const attemptForCert = savedAttempt || attemptDoc;

        // try to resolve user info
        let userForCert = null;
        try {
          if (attemptForCert.userId) {
            if (mongoose.isValidObjectId(String(attemptForCert.userId))) {
              userForCert = await User.findById(attemptForCert.userId).lean().exec();
            } else {
              // maybe it's not an ObjectId, skip
              userForCert = null;
            }
          } else if (req.user) {
            userForCert = req.user;
          }
        } catch (e) {
          console.warn("[cert] user lookup failed:", e && e.message);
          userForCert = null;
        }

        // try to resolve org info
        let orgForCert = null;
        try {
          if (attemptForCert.organization) {
            if (mongoose.isValidObjectId(String(attemptForCert.organization))) {
              orgForCert = await Organization.findById(attemptForCert.organization).lean().exec();
            } else {
              // try slug
              orgForCert = await Organization.findOne({ slug: String(attemptForCert.organization) }).lean().exec();
            }
          } else if (orgSlugOrId) {
            const maybeOrg = await Organization.findOne({ slug: String(orgSlugOrId) }).lean().exec();
            if (maybeOrg) orgForCert = maybeOrg;
          }
        } catch (e) {
          console.warn("[cert] organization lookup failed:", e && e.message);
          orgForCert = null;
        }

        certResult = await renderCertificatePdf(attemptForCert, userForCert || {}, orgForCert || {});
        if (!certResult || !certResult.ok) {
          console.warn("[quiz/submit] certificate generation failed:", certResult && certResult.error);
        }
      } catch (err) {
        console.error("[quiz/submit] cert creation error:", err && (err.stack || err));
      }
    }
    // ---------- END certificate generation ----------

    return res.json({
      examId: attemptDoc.examId,
      total,
      score,
      percentage,
      passThreshold,
      passed,
      details,
      debug: {
        examFound: !!exam,
        attemptSaved: !!savedAttempt
      },
      certificateUrl: (certResult && certResult.ok) ? certResult.url : null
    });
  } catch (err) {
    console.error("[POST /api/lms/quiz/submit] error:", err && (err.stack || err));
    return res.status(500).json({ error: "Failed to score quiz", detail: String(err && err.message) });
  }
});

export default router;
