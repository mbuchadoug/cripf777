// services/courseCertTemplate.js
// ---------------------------------------------------------------------------
// CRIPFCnt Course - Certificate of Competence (landscape A4, 297 x 210mm)
//
// Adapted from services/eightQTCertTemplate.js so the two credentials share one
// house style (forest + gold, gold frame, QR verify, dummy signatory). What
// changed for a COURSE:
//   * radar (8 quotients)         -> circular GRADE RING (overall attainment)
//   * 8 quotient meters           -> one meter PER ASSESSMENT in the course
//   * "Dominant Quotient"         -> CLASSIFICATION (Pass / Merit / Distinction)
//   * "Designation"               -> ASSESSMENTS PASSED (e.g. "5 of 5")
//   * "Certificate of Assessment" -> "Certificate of Competence"
//
// This module ONLY builds HTML. Rendering the PDF (Puppeteer), files, verify
// code and email stay in the wrapper services/courseCertPdf.js - identical
// pattern to your eightQTCertPdf.js.
//
// INPUT CONTRACT (all display-ready; thresholds are decided by the course
// logic, NOT here - this file just prints what it's given):
//   buildCourseCertHtml({
//     cert: {
//       recipientName, orgName,
//       courseTitle, moduleName, level,
//       classification,                 // "Distinction" | "Merit" | "Pass" | custom
//       overallPercentage,              // 0-100
//       assessmentsPassed, assessmentsTotal,
//       totalQuestions,
//       assessments: [ { title, percentage, band? }, ... ],
//       issuedAt, verifyCode
//     },
//     template = {},   // optional admin overrides (certTitle, signatory, etc.)
//     qrDataUrl        // optional precomputed QR data URL
//   })
//
// Fonts: drop the SAME Fraunces/Archivo .ttf files used by 8QT into
//   services/assets/course-fonts/   (or point COURSE_FONT_DIR at the 8qt-fonts
//   folder you already ship). Missing files fall back to serif/sans gracefully.
// ---------------------------------------------------------------------------

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// --- Signatory (dummy by default, same convention as 8QT) -----------------
const USE_TEMPLATE_SIGNATORY = false;

// --- Fonts: embed as base64 once (deterministic render, no network) --------
let _fontCss = null;
function fontFaceCss() {
  if (_fontCss !== null) return _fontCss;
  const dir =
    process.env.COURSE_FONT_DIR ||
    process.env.EIGHTQT_FONT_DIR ||
    path.join(__dirname, "assets", "course-fonts");
  const load = (file) => {
    try {
      const b = fs.readFileSync(path.join(dir, file));
      return `url('data:font/ttf;base64,${b.toString("base64")}')`;
    } catch { return null; }
  };
  const fr   = load("Fraunces.ttf");
  const frIt = load("Fraunces-Italic.ttf");
  const ar   = load("Archivo.ttf");
  const faces = [];
  if (fr)   faces.push(`@font-face{font-family:'Fraunces';src:${fr};font-weight:100 900;font-style:normal;}`);
  if (frIt) faces.push(`@font-face{font-family:'FrauncesIt';src:${frIt};font-weight:100 900;font-style:italic;}`);
  if (ar)   faces.push(`@font-face{font-family:'Archivo';src:${ar};font-weight:100 900;font-style:normal;}`);
  _fontCss = faces.join("\n");
  return _fontCss;
}
const FF_DISPLAY = "'Fraunces', Georgia, 'Times New Roman', serif";
const FF_ITALIC  = "'FrauncesIt', Georgia, serif";
const FF_SANS    = "'Archivo', 'Helvetica Neue', Arial, sans-serif";

const esc = (s) => s == null ? "" : String(s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function fmtDateLong(d) {
  const dt = d ? new Date(d) : new Date();
  return dt.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
}
function ymd(d) {
  const dt = d ? new Date(d) : new Date();
  return dt.toISOString().slice(0, 10).replace(/-/g, "");
}

// Classification -> accent colour (drives ring, seal, top bars)
function classColour(classification) {
  const c = String(classification || "").toLowerCase();
  if (c.includes("distinction")) return { a: "#c9a765", b: "#a6853f" }; // gold
  if (c.includes("merit"))       return { a: "#3fbf87", b: "#1f9d6b" }; // emerald
  return { a: "#1f9d6b", b: "#0b3a2a" };                                // forest (pass)
}

// Per-assessment band label from a percentage (display only)
function bandFor(pct) {
  const p = Number(pct) || 0;
  if (p >= 90) return "Distinction";
  if (p >= 75) return "Merit";
  if (p >= 60) return "Pass";
  return "Not passed";
}

// Optional QR (same behaviour as 8QT)
async function qrDataUrl(text, provided) {
  if (provided) return provided;
  try {
    const mod = await import("qrcode");
    const QR = mod.default || mod;
    return await QR.toDataURL(text, { margin: 0, color: { dark: "#0b3a2a", light: "#ffffff" }, width: 220 });
  } catch { return null; }
}

/**
 * Build the course certificate HTML.
 * @returns {Promise<string>} full HTML document
 */
export async function buildCourseCertHtml({ cert = {}, template = {}, verifyCode = null, qrDataUrl: qrProvided = null } = {}) {
  const recipient = esc(cert.recipientName || "Recipient");

  const tier = (template?.tier === "module") ? "module" : "area";
  const L = tier === "module"
    ? { subtitle: "MODULE CERTIFICATION", attainCap: "MODULE ATTAINMENT", countLabel: "COURSES PASSED", resultsHead: "COURSES COMPLETED", sealTop: "MASTERY", verifyKind: "module" }
    : { subtitle: "PROFESSIONAL CERTIFICATION", attainCap: "OVERALL ATTAINMENT", countLabel: "ASSESSMENTS PASSED", resultsHead: "ASSESSMENT RESULTS", sealTop: "CERTIFIED", verifyKind: "course" };
  const certTitle   = esc(template?.certTitle || (tier === "module" ? "Certificate of Mastery" : "Certificate of Competence"));
  const orgName     = esc(cert.orgName || "CRIPFCnt");
  const issuedBy    = "CRIPFCnt";
  const dateSrc     = cert.issuedAt || new Date();
  const dateLong    = fmtDateLong(dateSrc);

  const courseTitle = esc(cert.courseTitle || "Course");
  const moduleName  = esc(cert.moduleName || "Professional Area");
  const level       = esc(cert.level || "Foundation");

  const overall     = Math.max(0, Math.min(100, Math.round(Number(cert.overallPercentage) || 0)));
  const classification = esc(cert.classification || bandFor(overall));
  const passed      = Number(cert.assessmentsPassed) || 0;
  const totalA      = Number(cert.assessmentsTotal) || (cert.assessments || []).length || 0;
  const totalQ      = Number(cert.totalQuestions) || 0;
  const cc          = classColour(cert.classification || bandFor(overall));

  const vCode = (verifyCode || cert.verifyCode || "").toString().toUpperCase() || "PENDING";
  const verifyPath = `cripfcnt.com/verify/${L.verifyKind}/${vCode}`;
  const verifyUrl  = `https://cripfcnt.com/verify/${L.verifyKind}/${vCode}`;

  const nameKey = (cert.recipientName || recipient || "X").replace(/\s+/g, "").toUpperCase().slice(0, 6).padEnd(6, "0");
  const credId  = `CRIPFCnt-${ymd(dateSrc)}-${esc(nameKey)}`;

  // ---- Grade ring (replaces the radar) -----------------------------------
  const R = 76, C = 2 * Math.PI * R;
  const arc = (overall / 100) * C;
  const ring = `<svg viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg" class="ring">
    <circle cx="100" cy="100" r="${R}" fill="none" stroke="rgba(255,255,255,.10)" stroke-width="10"/>
    <circle cx="100" cy="100" r="${R}" fill="none" stroke="${cc.a}" stroke-width="10"
      stroke-linecap="round" stroke-dasharray="${arc.toFixed(2)} ${(C - arc).toFixed(2)}"
      transform="rotate(-90 100 100)"/>
    <circle cx="100" cy="100" r="58" fill="#082a1f" stroke="rgba(201,167,101,.35)" stroke-width="1"/>
    <text x="100" y="94" text-anchor="middle" font-family="Fraunces" font-size="38" fill="#f4fbf7" font-weight="600">${overall}<tspan font-size="18">%</tspan></text>
    <text x="100" y="118" text-anchor="middle" font-family="Archivo" font-size="10" letter-spacing="2" fill="${cc.a}" font-weight="700">${esc(classification).toUpperCase()}</text>
  </svg>`;

  // ---- Per-assessment meters (replaces the 8 quotient meters) -------------
  const list = (cert.assessments || []).slice(0, 8);
  const meters = list.map(a => {
    const pct = Math.max(0, Math.min(100, Math.round(Number(a.percentage) || 0)));
    const band = esc(a.band || bandFor(pct));
    const pass = pct >= 60;
    return `<div class="q${pass ? "" : " qfail"}">
      <div class="qtop">
        <span class="qname">${esc(a.title || "Assessment")}</span>
        <span class="qval"><b>${pct}</b><span class="qband">${band}</span></span>
      </div>
      <div class="track"><span style="width:${pct}%"></span></div>
    </div>`;
  }).join("");

  // ---- QR -----------------------------------------------------------------
  const qr = await qrDataUrl(verifyUrl, qrProvided);
  const qrImg = qr ? `<img src="${qr}"/>` : "";

  // ---- Signatory ----------------------------------------------------------
  const sigName  = (USE_TEMPLATE_SIGNATORY && template?.signatoryName)  ? esc(template.signatoryName)  : "Authorised Signatory";
  const sigTitle = (USE_TEMPLATE_SIGNATORY && template?.signatoryTitle) ? esc(template.signatoryTitle) : "CRIPFCnt \u00b7 Professional Certification";

  const sigFlourish = `<svg width="150" height="46" viewBox="0 0 150 46" xmlns="http://www.w3.org/2000/svg">
    <path d="M6 34 C14 12 24 10 30 20 C34 27 28 36 22 33 C16 30 22 18 34 22 C46 26 52 16 60 12
             C70 7 74 16 70 26 C67 33 62 33 64 39 M60 24 C70 16 82 14 90 22 C96 28 90 38 84 34
             C78 30 84 20 96 24 C108 28 120 20 130 12 C136 8 142 12 144 20"
          fill="none" stroke="#0b3a2a" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`;

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Certificate - ${recipient}</title><style>
${fontFaceCss()}
:root{
 --forest:#0b3a2a; --forest-deep:#072519; --emerald:#1f9d6b; --emerald-lite:#3fbf87;
 --gold:#c9a765; --gold-deep:#a6853f; --ivory:#faf8f1; --panel:#f2eee1;
 --ink:#16241d; --muted:#71827a; --line:rgba(16,36,29,.12);
}
*{margin:0;padding:0;box-sizing:border-box;-webkit-print-color-adjust:exact;print-color-adjust:exact;}
@page{size:297mm 210mm;margin:0;}
html,body{width:297mm;height:210mm;}
body{font-family:${FF_SANS};color:var(--ink);background:#fff;}
.page{position:relative;width:297mm;height:210mm;background:var(--ivory);overflow:hidden;}
.frame{position:absolute;inset:8mm;border:1.4px solid var(--gold);}
.frame:before{content:'';position:absolute;inset:2mm;border:0.6px solid rgba(166,133,63,.5);}
.grid{position:absolute;inset:8mm;display:grid;grid-template-columns:88mm 1fr;}
.mast{position:relative;background:linear-gradient(160deg,var(--forest) 0%,var(--forest-deep) 100%);
  color:#eafff4;padding:11mm 9mm 8mm;display:flex;flex-direction:column;overflow:hidden;}
.mast:after{content:'';position:absolute;right:-40mm;top:-30mm;width:120mm;height:120mm;
  background:radial-gradient(circle,rgba(201,167,101,.10),transparent 62%);}
.brandrow{display:flex;align-items:center;gap:3.4mm;position:relative;z-index:2;}
.mono{width:12mm;height:12mm;border:1.4px solid var(--gold);border-radius:2px;display:flex;
  align-items:center;justify-content:center;font-family:${FF_DISPLAY};font-weight:600;font-size:20px;color:var(--gold);}
.wm{font-family:${FF_DISPLAY};font-weight:600;font-size:22px;letter-spacing:.5px;line-height:1;color:#f4fbf7;}
.wsub{font-family:${FF_SANS};font-size:7.4px;letter-spacing:.32em;color:rgba(201,167,101,.9);margin-top:2.4px;font-weight:600;}
.mdiv{height:1px;background:linear-gradient(90deg,var(--gold),transparent);margin:7mm 0 2mm;position:relative;z-index:2;}
.ring{width:58mm;height:58mm;display:block;margin:2mm auto 0;position:relative;z-index:2;}
.emblemcap{text-align:center;font-size:7px;letter-spacing:.34em;color:rgba(234,255,244,.55);font-weight:600;margin-top:2mm;}
.mfoot{margin-top:auto;position:relative;z-index:2;}
.mrow{margin-bottom:5.5mm;}
.mlabel{font-size:7px;letter-spacing:.3em;color:rgba(201,167,101,.85);font-weight:700;margin-bottom:1.6mm;}
.mval{font-family:${FF_DISPLAY};font-size:15px;font-weight:600;color:#f4fbf7;line-height:1.15;}
.mval small{font-family:${FF_SANS};font-size:9px;font-weight:500;color:rgba(234,255,244,.72);display:block;letter-spacing:.02em;}
.qrbox{display:flex;align-items:center;gap:3.4mm;padding-top:5mm;border-top:1px solid rgba(201,167,101,.28);}
.qrbox img{width:17mm;height:17mm;background:#fff;padding:1mm;border-radius:2px;}
.qrtxt{font-size:7.6px;line-height:1.5;color:rgba(234,255,244,.72);}
.qrtxt b{color:var(--gold);font-weight:700;letter-spacing:.05em;display:block;font-size:7px;margin-bottom:.8mm;}
.main{position:relative;padding:11mm 12mm 9mm;display:flex;flex-direction:column;}
.eyebrow{display:flex;justify-content:space-between;align-items:flex-start;}
.eyebrow .tag{font-size:7.6px;letter-spacing:.34em;color:var(--muted);font-weight:700;}
.eyebrow .doc{text-align:right;}
.eyebrow .doc .t{font-family:${FF_DISPLAY};font-size:17px;font-weight:600;color:var(--forest);line-height:1;}
.eyebrow .doc .d{font-size:8px;letter-spacing:.2em;color:var(--gold-deep);margin-top:1.6mm;font-weight:600;}
.grule{height:1.2px;background:linear-gradient(90deg,var(--gold),rgba(201,167,101,.15));margin:6mm 0 5.5mm;}
.certify{font-size:8px;letter-spacing:.38em;color:var(--muted);font-weight:700;}
.name{font-family:${FF_DISPLAY};font-weight:600;font-size:50px;line-height:1;color:var(--ink);margin:3.4mm 0 2mm;letter-spacing:-.5px;}
.arche{font-family:${FF_ITALIC};font-style:italic;font-size:18px;color:var(--emerald);font-weight:500;}
.cite{font-size:10px;line-height:1.62;color:#3f4f47;max-width:150mm;margin-top:3.6mm;}
.cite b{color:var(--forest);font-weight:600;}
.framework{margin-top:4mm;padding:3mm 4mm;background:var(--panel);border-left:2.4px solid var(--emerald);}
.framework .fl{font-size:7px;letter-spacing:.3em;color:var(--muted);font-weight:700;}
.framework .fv{font-family:${FF_DISPLAY};font-size:12.5px;font-weight:600;color:var(--forest);margin-top:1mm;}
.profhead{display:flex;align-items:center;gap:4mm;margin:6mm 0 4mm;}
.profhead .ph{font-size:8px;letter-spacing:.3em;color:var(--muted);font-weight:700;white-space:nowrap;}
.profhead .phline{flex:1;height:1px;background:var(--line);}
.meters{display:grid;grid-template-columns:1fr 1fr;gap:3mm 9mm;}
.qtop{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:1.6mm;}
.qname{font-size:9px;letter-spacing:.06em;color:var(--ink);font-weight:600;max-width:52mm;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.qval{display:flex;align-items:baseline;gap:2.4mm;}
.qval b{font-family:${FF_DISPLAY};font-size:18px;font-weight:600;color:var(--forest);line-height:1;}
.qband{font-size:7px;letter-spacing:.14em;text-transform:uppercase;color:var(--muted);font-weight:600;}
.track{height:3.2px;background:rgba(16,36,29,.09);border-radius:3px;overflow:hidden;}
.track span{display:block;height:100%;background:linear-gradient(90deg,var(--emerald),var(--emerald-lite));border-radius:3px;}
.qfail .track span{background:linear-gradient(90deg,#b06a4f,#d08a6f);}
.qfail .qval b{color:#a6533a;}
.foot{margin-top:auto;display:flex;justify-content:space-between;align-items:flex-end;padding-top:6mm;}
.sig{width:74mm;}
.sigmark{height:12mm;margin-bottom:1mm;padding-left:1mm;}
.sigline{height:1px;background:var(--ink);opacity:.55;margin-bottom:1.8mm;}
.sigwho{font-size:9px;font-weight:700;color:var(--ink);letter-spacing:.03em;}
.sigrole{font-size:7.6px;color:var(--muted);letter-spacing:.05em;margin-top:.6mm;}
.seal{width:26mm;height:26mm;position:relative;}
.meta{position:absolute;left:12mm;right:12mm;bottom:4.5mm;display:flex;justify-content:space-between;
  gap:4mm;padding-top:3mm;border-top:1px solid var(--line);}
.mi{font-size:6.8px;line-height:1.5;color:var(--muted);letter-spacing:.06em;}
.mi b{display:block;color:var(--forest);font-weight:700;letter-spacing:.12em;font-size:6.6px;margin-bottom:.6mm;}
</style></head><body>
<div class="page">
 <div class="frame"></div>
 <div class="grid">
  <div class="mast">
    <div class="brandrow">
      <div class="mono">C</div>
      <div><div class="wm">CRIPFCnt</div><div class="wsub">${L.subtitle}</div></div>
    </div>
    <div class="mdiv"></div>
    ${ring}
    <div class="emblemcap">${L.attainCap}</div>
    <div class="mfoot">
      <div class="mrow"><div class="mlabel">CLASSIFICATION</div>
        <div class="mval">${esc(classification)}<small>Overall grade across the course</small></div></div>
      <div class="mrow"><div class="mlabel">${L.countLabel}</div>
        <div class="mval" style="font-size:13px">${passed} of ${totalA}<small>${tier === "module" ? "area courses completed" : `${totalQ} questions in total`}</small></div></div>
      <div class="qrbox">
        ${qrImg}
        <div class="qrtxt"><b>VERIFY AUTHENTICITY</b>Scan to validate this credential at<br>${esc(verifyPath)}</div>
      </div>
    </div>
  </div>
  <div class="main">
    <div class="eyebrow">
      <div class="tag">OFFICIAL DOCUMENT</div>
      <div class="doc"><div class="t">${certTitle}</div><div class="d">${esc(dateLong.toUpperCase())}</div></div>
    </div>
    <div class="grule"></div>
    <div class="certify">THIS IS TO CERTIFY THAT</div>
    <div class="name">${recipient}</div>
    <div class="arche">${courseTitle}</div>
    <div class="cite">${tier === "module"
      ? `has demonstrated mastery of the <b>${moduleName}</b> module by completing <b>${totalA} area courses</b>, with an overall attainment of <b>${overall}%</b> &mdash; classified as <b>${esc(classification)}</b>.`
      : `has successfully completed the <b>${courseTitle}</b> course within the <b>${moduleName}</b> professional area, meeting the required standard of competence across <b>${totalA} assessments</b> (${totalQ} questions) with an overall attainment of <b>${overall}%</b> &mdash; classified as <b>${esc(classification)}</b>.`}</div>
    <div class="framework"><div class="fl">PROFESSIONAL AREA &middot; LEVEL</div>
      <div class="fv">${moduleName} &mdash; ${level}</div></div>
    <div class="profhead"><div class="ph">${L.resultsHead}</div><div class="phline"></div></div>
    <div class="meters">${meters}</div>
    <div class="foot">
      <div class="sig">
        <div class="sigmark">${sigFlourish}</div>
        <div class="sigline"></div>
        <div class="sigwho">${sigName}</div>
        <div class="sigrole">${sigTitle}</div>
      </div>
      <div class="seal">
        <svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
          <circle cx="50" cy="50" r="47" fill="none" stroke="#c9a765" stroke-width="1.2"/>
          <circle cx="50" cy="50" r="40" fill="none" stroke="rgba(166,133,63,.5)" stroke-width="0.6"/>
          <circle cx="50" cy="50" r="26" fill="#0b3a2a"/>
          <path d="M40 50 l7 7 l14 -16" fill="none" stroke="#c9a765" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>
          <text x="50" y="20" text-anchor="middle" font-family="Archivo" font-size="6" letter-spacing="1.4" fill="#a6853f" font-weight="700">${L.sealTop}</text>
          <text x="50" y="86" text-anchor="middle" font-family="Archivo" font-size="5.4" letter-spacing="1.2" fill="#a6853f" font-weight="700">CRIPFCnt</text>
        </svg>
      </div>
    </div>
    <div class="meta">
      <div class="mi"><b>CREDENTIAL ID</b>${credId}</div>
      <div class="mi"><b>ORGANISATION</b>${orgName}</div>
      <div class="mi"><b>ISSUED BY</b>${issuedBy}</div>
      <div class="mi"><b>DATE ISSUED</b>${esc(dateLong)}</div>
      <div class="mi" style="text-align:right"><b>VERIFY</b>${esc(verifyPath)}</div>
    </div>
  </div>
 </div>
</div>
</body></html>`;
}