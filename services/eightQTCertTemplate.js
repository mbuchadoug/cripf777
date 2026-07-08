// services/eightQTCertTemplate.js
// ---------------------------------------------------------------------------
// CRIPFCnt 8 Quotients - Certificate of Assessment (landscape A4, 297 x 210mm)
//
// This module ONLY builds the certificate HTML. It does NOT render the PDF,
// write files, or touch verifyCode / email. That stays in your existing
// services/eightQTCertPdf.js wrapper, so nothing in the issue / preview /
// regenerate / webhook pipeline changes.
//
// TO WIRE IT IN (2 lines inside services/eightQTCertPdf.js):
//   import { buildEightQTCertHtml } from "./eightQTCertTemplate.js";
//   ...
//   const html = await buildEightQTCertHtml({ attempt, template, archetype, verifyCode });
//   // then feed `html` to your existing puppeteer page.setContent(...) call.
//
// Puppeteer settings (unchanged from your working pattern):
//   await page.emulateMediaType("print");
//   await page.pdf({ format:"A4", landscape:true, printBackground:true,
//                    margin:{top:"0",right:"0",bottom:"0",left:"0"} });
// ---------------------------------------------------------------------------

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// --- Signatory ------------------------------------------------------------
// Dummy signature for now (Donald Mataranyika removed). Flip this to true and
// set template.signatoryName / template.signatoryTitle to use a real one.
const USE_TEMPLATE_SIGNATORY = false;

// --- Canonical quotient order + display names (enum is fixed) --------------
const Q_ORDER = [
  ["CsQ", "Consciousness"],
  ["RQ",  "Responsibility"],
  ["IQ",  "Interpretation"],
  ["PQ",  "Purpose"],
  ["FQ",  "Frequencies"],
  ["CvQ", "Civilization"],
  ["NQ",  "Negotiation"],
  ["TQ",  "Technology"],
];
const Q_NAME = Object.fromEntries(Q_ORDER);

// --- Fonts: embed as base64 once (deterministic render, no network) --------
// Drop the .ttf files into services/assets/8qt-fonts/ (shipped alongside this).
// If a file is missing, we fall back to system serif/sans and still render.
let _fontCss = null;
function fontFaceCss() {
  if (_fontCss !== null) return _fontCss;
  const dir = process.env.EIGHTQT_FONT_DIR || path.join(__dirname, "assets", "8qt-fonts");
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
// Graceful family fallbacks if a face didn't load
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

// Optional QR. Pass a precomputed data URL, or we try the `qrcode` npm package,
// else we render the verify block without an image (still valid).
async function qrDataUrl(text, provided) {
  if (provided) return provided;
  try {
    const mod = await import("qrcode");
    const QR = mod.default || mod;
    return await QR.toDataURL(text, { margin: 0, color: { dark: "#0b3a2a", light: "#ffffff" }, width: 220 });
  } catch { return null; }
}

/**
 * Build the certificate HTML.
 * @param {Object} p
 * @param {Object} p.attempt    - EightQTAttempt (plain object)
 * @param {Object} [p.template] - EightQTCertTemplate (active)
 * @param {Object} [p.archetype]- EightQTArchetype
 * @param {String} [p.verifyCode] - the code your wrapper generated/reused
 * @param {String} [p.qrDataUrl]  - optional precomputed QR data URL
 * @returns {Promise<string>} full HTML document
 */
export async function buildEightQTCertHtml({ attempt = {}, template = {}, archetype = null, verifyCode = null, qrDataUrl: qrProvided = null } = {}) {
  const recipient = esc(attempt.certificateName || attempt.participantName || "Recipient");
  const archName  = esc(archetype?.name || attempt.archetypeName || "The Emerging Thinker");
  const orgName   = esc(attempt.certificateOrg || "CRIPFCnt");
  const issuedBy  = "CRIPFCnt";
  const dateSrc   = attempt.certificateIssuedAt || new Date();
  const dateLong  = fmtDateLong(dateSrc);

  const vCode = (verifyCode || attempt.certificateVerifyCode || "").toString().toUpperCase() || "PENDING";
  const verifyPath = `cripfcnt.com/verify/8qt/${vCode}`;
  const verifyUrl  = `https://cripfcnt.com/verify/8qt/${vCode}`;

  const nameKey  = (attempt.certificateName || recipient || "X").replace(/\s+/g, "").toUpperCase().slice(0, 6).padEnd(6, "0");
  const credId   = `CRIPFCnt-${ymd(dateSrc)}-${esc(nameKey)}`;

  const domCode = attempt.dominantQuotient || null;
  const domName = domCode ? (Q_NAME[domCode] || domCode) : "\u2014";

  // Scores map (fill all 8 in canonical order; missing => 0 / Emerging)
  const scoreMap = {};
  for (const s of (attempt.quotientScores || [])) scoreMap[s.code] = s;
  const scored = Q_ORDER.map(([code, name]) => {
    const s = scoreMap[code];
    return { code, name, score: Math.max(0, Math.min(100, Number(s?.score ?? 0))), band: esc(s?.band || "Emerging") };
  });

  // Signatory (dummy by default)
  const sigName  = (USE_TEMPLATE_SIGNATORY && template?.signatoryName)  ? esc(template.signatoryName)  : "Authorised Signatory";
  const sigTitle = (USE_TEMPLATE_SIGNATORY && template?.signatoryTitle) ? esc(template.signatoryTitle) : "CRIPFCnt \u00b7 8 Quotients Assessment";

  // ---- Radar emblem (octagon) --------------------------------------------
  const cx = 100, cy = 100, R = 76;
  const pt = (i, frac) => {
    const a = (-90 + i * 45) * Math.PI / 180;
    return [cx + R * frac * Math.cos(a), cy + R * frac * Math.sin(a)];
  };
  const ring = (frac) => Array.from({ length: 8 }, (_, i) => pt(i, frac).map(n => n.toFixed(2)).join(",")).join(" ");
  const grid = [0.25, 0.5, 0.75].map(f =>
    `<polygon points="${ring(f)}" fill="none" stroke="rgba(255,255,255,.14)" stroke-width="0.8"/>`).join("");
  const spokes = Array.from({ length: 8 }, (_, i) => {
    const [x, y] = pt(i, 1);
    return `<line x1="${cx}" y1="${cy}" x2="${x.toFixed(2)}" y2="${y.toFixed(2)}" stroke="rgba(255,255,255,.12)" stroke-width="0.7"/>`;
  }).join("");
  const outer = `<polygon points="${ring(1)}" fill="none" stroke="#c9a765" stroke-width="1.4"/>`;
  const profPts = scored.map((q, i) => pt(i, q.score / 100).map(n => n.toFixed(2)).join(",")).join(" ");
  const prof = `<polygon points="${profPts}" fill="rgba(63,191,135,.30)" stroke="#3fbf87" stroke-width="1.6" stroke-linejoin="round"/>`;
  const dots = scored.map((q, i) => {
    const [x, y] = pt(i, q.score / 100);
    return `<circle cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="2.1" fill="#eafff4"/>`;
  }).join("");
  const labels = scored.map((q, i) => {
    const [lx, ly] = pt(i, 1.17);
    return `<text x="${lx.toFixed(2)}" y="${(ly + 2).toFixed(2)}" text-anchor="middle" font-family="Archivo" font-size="8.5" letter-spacing="0.5" fill="rgba(234,255,244,.82)" font-weight="600">${q.code}</text>`;
  }).join("");
  const radar = `<svg viewBox="-14 -14 228 228" xmlns="http://www.w3.org/2000/svg" class="radar">
    ${grid}${spokes}${outer}${prof}${dots}${labels}
    <circle cx="${cx}" cy="${cy}" r="15" fill="#082a1f" stroke="#c9a765" stroke-width="1"/>
    <text x="${cx}" y="${cy + 3.5}" text-anchor="middle" font-family="Fraunces" font-size="12" fill="#c9a765" font-weight="600">8Q</text>
  </svg>`;

  // ---- Meter grid ---------------------------------------------------------
  const meters = scored.map(q => {
    const isDom = q.code === domCode;
    const domtag = isDom ? '<span class="dom">\u25c6 Dominant</span>' : "";
    return `<div class="q${isDom ? " qdom" : ""}">
      <div class="qtop">
        <span class="qname">${esc(q.name)}${domtag}</span>
        <span class="qval"><b>${q.score}</b><span class="qband">${q.band}</span></span>
      </div>
      <div class="track"><span style="width:${q.score}%"></span></div>
    </div>`;
  }).join("");

  // ---- QR -----------------------------------------------------------------
  const qr = await qrDataUrl(verifyUrl, qrProvided);
  const qrImg = qr ? `<img src="${qr}"/>` : "";

  // ---- Dummy signature flourish (name-agnostic) ---------------------------
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
.radar{width:60mm;height:60mm;display:block;margin:1mm auto 0;position:relative;z-index:2;}
.emblemcap{text-align:center;font-size:7px;letter-spacing:.34em;color:rgba(234,255,244,.55);font-weight:600;margin-top:1mm;}
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
.profhead{display:flex;align-items:center;gap:4mm;margin:6.5mm 0 4mm;}
.profhead .ph{font-size:8px;letter-spacing:.3em;color:var(--muted);font-weight:700;white-space:nowrap;}
.profhead .phline{flex:1;height:1px;background:var(--line);}
.meters{display:grid;grid-template-columns:1fr 1fr;gap:3mm 9mm;}
.qtop{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:1.6mm;}
.qname{font-size:9px;letter-spacing:.12em;text-transform:uppercase;color:var(--ink);font-weight:600;display:flex;align-items:center;gap:2.4mm;}
.dom{font-family:${FF_SANS};font-size:6.6px;letter-spacing:.14em;color:var(--gold-deep);background:rgba(201,167,101,.16);
  padding:.5mm 1.6mm;border-radius:2px;font-weight:700;}
.qval{display:flex;align-items:baseline;gap:2.4mm;}
.qval b{font-family:${FF_DISPLAY};font-size:18px;font-weight:600;color:var(--forest);line-height:1;}
.qband{font-size:7px;letter-spacing:.14em;text-transform:uppercase;color:var(--muted);font-weight:600;}
.track{height:3.2px;background:rgba(16,36,29,.09);border-radius:3px;overflow:hidden;}
.track span{display:block;height:100%;background:linear-gradient(90deg,var(--emerald),var(--emerald-lite));border-radius:3px;}
.qdom .track span{background:linear-gradient(90deg,var(--gold-deep),var(--gold));}
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
      <div><div class="wm">CRIPFCnt</div><div class="wsub">8 QUOTIENTS ASSESSMENT</div></div>
    </div>
    <div class="mdiv"></div>
    ${radar}
    <div class="emblemcap">PLACEMENT INTELLIGENCE PROFILE</div>
    <div class="mfoot">
      <div class="mrow"><div class="mlabel">DOMINANT QUOTIENT</div>
        <div class="mval">${esc(domCode || "\u2014")}<small>${esc(domName)}</small></div></div>
      <div class="mrow"><div class="mlabel">ARCHETYPE</div>
        <div class="mval" style="font-size:13px">${archName}</div></div>
      <div class="qrbox">
        ${qrImg}
        <div class="qrtxt"><b>VERIFY AUTHENTICITY</b>Scan to validate this credential at<br>${esc(verifyPath)}</div>
      </div>
    </div>
  </div>
  <div class="main">
    <div class="eyebrow">
      <div class="tag">OFFICIAL DOCUMENT</div>
      <div class="doc"><div class="t">Certificate of Assessment</div><div class="d">${esc(dateLong.toUpperCase())}</div></div>
    </div>
    <div class="grule"></div>
    <div class="certify">THIS IS TO CERTIFY THAT</div>
    <div class="name">${recipient}</div>
    <div class="arche">${archName}</div>
    <div class="cite">has completed the <b>CRIPFCnt 8 Quotients Assessment</b> and has been mapped across the eight
      dimensions of Placement Intelligence &mdash; the framework developed by Donald Mataranyika for locating an
      individual&rsquo;s optimal contribution within an organisation.</div>
    <div class="framework"><div class="fl">ASSESSMENT INSTRUMENT</div>
      <div class="fv">Placement Intelligence Framework &mdash; CRIPFCnt</div></div>
    <div class="profhead"><div class="ph">EIGHT-DIMENSION PROFILE</div><div class="phline"></div></div>
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
          <text x="50" y="20" text-anchor="middle" font-family="Archivo" font-size="6" letter-spacing="1.4" fill="#a6853f" font-weight="700">CERTIFIED</text>
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

export default { buildEightQTCertHtml };