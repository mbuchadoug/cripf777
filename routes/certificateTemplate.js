/**
 * certificateTemplate.js
 * ──────────────────────────────────────────────────────────────────────────────
 * Redesigned to international corporate standard.
 * Inspired by PMP / professional body certificate conventions:
 *  - Landscape A4 orientation (professional standard)
 *  - Dual-logo header band with institution seal
 *  - Heavy typographic hierarchy: title → recipient → designation
 *  - Double-rule gold border with corner ornaments
 *  - Official seal + two signature blocks
 *  - Credential ID and verification footer
 *
 * Usage (same signature):
 *   import { buildCertificateHtml } from "./certificateTemplate.js";
 *   const html = buildCertificateHtml({ name, orgName, moduleName, quizTitle,
 *                                        score, percentage, date });
 *
 * Puppeteer settings (update in your PDF generator):
 *   format: "A4",
 *   landscape: true,          ← NEW: landscape for professional cert proportions
 *   printBackground: true,
 *   margin: { top: "0", bottom: "0", left: "0", right: "0" }
 */

export function buildCertificateHtml({
  name,
  orgName,
  moduleName,
  quizTitle,
  score,
  percentage,
  date,
}) {
  /* ── helpers ── */
  const esc = (s) =>
    s == null ? "" : String(s)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");

  const dateObj  = date ? new Date(date) : new Date();
  const dateStr  = dateObj.toISOString().slice(0, 10);
  const dateLong = dateObj.toLocaleDateString("en-GB", {
    day: "numeric", month: "long", year: "numeric"
  });

  const moduleTitle    = esc(quizTitle || moduleName || "Module");
  const recipientName  = esc(name || "Recipient");
  const institution    = esc(orgName || "CRIPFCnt Institute");
  const scoreDisplay   = score      != null ? esc(String(score))      : null;
  const pctDisplay     = percentage != null ? esc(String(percentage)) : null;

  /* ── brand config by org ── */
  const orgLow = (orgName || "").toLowerCase();
  let brand = {
    primary:  "#0a1628",
    mid:      "#1E3A5F",
    accent:   "#b8973a",
    accent2:  "#d4aa50",
    accentPale: "#f9f3e3",
    cream:    "#fdf9f0",
    series:   "CRIPFCnt Learning Management System",
    abbrev:   "CRIPFCnt",
    signatory1Name: "Donald Mataranyika",
    signatory1Role: "Chartered Secretary & Governance Specialist",
    signatory2Name: "Chief Academic Officer",
    signatory2Role: "Academic Certification Authority",
  };

  if (/nyaradzo/.test(orgLow)) {
    brand = { ...brand, primary: "#0a2e5c", accent: "#c9a227", accent2: "#dbb84a",
              series: "Nyaradzo Group Training", abbrev: "NGT" };
  } else if (/winchester/.test(orgLow)) {
    brand = { ...brand, primary: "#1F3C88", accent: "#8B1E2D", accent2: "#a83040",
              series: "Winchester School", abbrev: "WS" };
  } else if (/st[\s-]?eurit|eurit/.test(orgLow)) {
    brand = { ...brand, primary: "#111111", accent: "#D4AF37", accent2: "#e8c95a",
              series: "St Eurit International School", abbrev: "SEIS" };
  }

  /* ── credential ID ── */
  const credId = `${brand.abbrev.replace(/\s+/g,"")}-${dateStr.replace(/-/g,"")}-${
    (name || "X").replace(/\s+/g,"").toUpperCase().slice(0,6).padEnd(6,"0")}`;

  /* ── SVG ornament helpers ── */
  const cornerSvg = (color1, color2) => `
    <svg viewBox="0 0 60 60" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M3 57V8C3 5.2 5.2 3 8 3H57" stroke="${color1}" stroke-width="2"/>
      <path d="M3 38V8C3 5.2 5.2 3 8 3H38" stroke="${color2}" stroke-width="0.8"/>
      <circle cx="8" cy="8" r="3.5" fill="${color1}"/>
      <circle cx="3" cy="3" r="2" fill="${color2}"/>
      <path d="M16 3H22M3 16V22" stroke="${color1}" stroke-width="1"/>
      <path d="M6 3H9M3 6V9" stroke="${color2}" stroke-width="0.5"/>
    </svg>`;

  const sealSvg = `
    <svg viewBox="0 0 120 120" fill="none" xmlns="http://www.w3.org/2000/svg">
      <!-- Outer ring -->
      <circle cx="60" cy="60" r="57" fill="${brand.primary}" stroke="${brand.accent}" stroke-width="2"/>
      <!-- Inner rings -->
      <circle cx="60" cy="60" r="50" fill="none" stroke="${brand.accent2}" stroke-width="0.8"/>
      <circle cx="60" cy="60" r="44" fill="none" stroke="${brand.accent}" stroke-width="0.5" stroke-dasharray="3 2.5"/>
      <!-- Star burst -->
      <path d="M60 20l3.2 9.8H73l-8.2 6 3.2 9.8L60 39.6l-8 5.9 3.2-9.8-8.2-6h9.8L60 20z"
            fill="${brand.accent2}" opacity="0.9"/>
      <!-- Inner star -->
      <path d="M60 28l2 6.2H68l-5.2 3.8 2 6.2L60 40.3l-4.8 3.9 2-6.2L52 34.2h6L60 28z"
            fill="${brand.accent}" opacity="0.5"/>
      <!-- Text arcs -->
      <path id="arc-top" d="M18,60 a42,42 0 0,1 84,0" fill="none"/>
      <path id="arc-bot" d="M18,62 a42,42 0 0,0 84,0" fill="none"/>
      <text font-family="'Cinzel',serif" font-size="7.5" font-weight="600"
            fill="${brand.accent2}" letter-spacing="3">
        <textPath href="#arc-top" startOffset="50%" text-anchor="middle">
          ${brand.abbrev.toUpperCase()}
        </textPath>
      </text>
      <text font-family="'Cinzel',serif" font-size="6.5"
            fill="${brand.accent}" letter-spacing="2.5">
        <textPath href="#arc-bot" startOffset="50%" text-anchor="middle">
          VERIFIED · OFFICIAL RECORD
        </textPath>
      </text>
      <!-- Bottom dot -->
      <circle cx="60" cy="97" r="3" fill="${brand.accent}" opacity="0.8"/>
    </svg>`;

  const starDivider = `
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
      <path d="M12 2l2.4 7.4H22l-6.2 4.5 2.4 7.4L12 17l-6.2 4.3 2.4-7.4L2 9.4h7.6L12 2z"
            fill="${brand.accent}"/>
    </svg>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<title>Certificate — ${recipientName}</title>
<style>
/* ── Google Fonts ── */
@import url('https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,300;0,400;0,600;0,700;1,300;1,400;1,600&family=Cinzel:wght@400;600;700&display=swap');

/* ── Reset ── */
*, *::before, *::after { box-sizing:border-box; margin:0; padding:0; }

@page { margin:0; size:A4 landscape; }

html, body {
  width:297mm;
  height:210mm;
  overflow:hidden;
  font-family:'Cormorant Garamond', Georgia, serif;
}

body {
  background:${brand.primary};
  display:flex;
  align-items:center;
  justify-content:center;
}

/* ── Outer dark frame ── */
.frame-outer {
  width:287mm;
  height:200mm;
  background:${brand.cream};
  padding:5px;
  position:relative;
  display:flex;
}

/* ── Double-rule border ── */
.frame-border-1 {
  flex:1;
  border:2.5px solid ${brand.accent};
  padding:5px;
  position:relative;
  display:flex;
}
.frame-border-2 {
  flex:1;
  border:1px solid ${brand.accent};
  position:relative;
  display:flex;
  flex-direction:column;
  overflow:hidden;
  background:${brand.cream};
}

/* ── Watermark ── */
.watermark {
  position:absolute;
  top:50%;
  left:50%;
  transform:translate(-50%,-50%) rotate(-25deg);
  font-family:'Cinzel', serif;
  font-size:110px;
  font-weight:700;
  color:${brand.accent};
  opacity:0.03;
  white-space:nowrap;
  letter-spacing:12px;
  pointer-events:none;
  z-index:0;
}

/* ── Corner ornaments ── */
.corner {
  position:absolute;
  width:60px;
  height:60px;
  z-index:3;
}
.corner.tl { top:-2px;    left:-2px; }
.corner.tr { top:-2px;    right:-2px;  transform:scaleX(-1); }
.corner.bl { bottom:-2px; left:-2px;   transform:scaleY(-1); }
.corner.br { bottom:-2px; right:-2px;  transform:scale(-1); }

/* ── TOP HEADER BAND ── */
.cert-header {
  background:${brand.primary};
  padding:0 50px;
  height:36px;
  display:flex;
  align-items:center;
  justify-content:space-between;
  position:relative;
  z-index:2;
  flex-shrink:0;
}
.cert-header::after {
  content:'';
  position:absolute;
  bottom:0; left:0; right:0;
  height:2px;
  background:linear-gradient(90deg, transparent, ${brand.accent} 20%, ${brand.accent} 80%, transparent);
}
.hdr-series {
  font-family:'Cinzel', serif;
  font-size:7px;
  letter-spacing:3.5px;
  color:${brand.accent};
  text-transform:uppercase;
}
.hdr-ref {
  font-family:'Cinzel', serif;
  font-size:7px;
  letter-spacing:2px;
  color:rgba(255,255,255,0.5);
  text-transform:uppercase;
}

/* ── MAIN BODY ── */
.cert-body {
  flex:1;
  display:flex;
  flex-direction:column;
  align-items:center;
  justify-content:center;
  padding:14px 54px 10px;
  position:relative;
  z-index:1;
  text-align:center;
}

/* ── Institution name ── */
.inst-name {
  font-family:'Cinzel', serif;
  font-size:10px;
  font-weight:700;
  letter-spacing:4px;
  text-transform:uppercase;
  color:${brand.primary};
  margin-bottom:4px;
}

/* ── Main title ── */
.cert-title {
  font-family:'Cinzel', serif;
  font-size:38px;
  font-weight:700;
  color:${brand.primary};
  letter-spacing:5px;
  text-transform:uppercase;
  line-height:1;
  margin-bottom:0;
}
.cert-title-sub {
  font-family:'Cormorant Garamond', serif;
  font-size:15px;
  font-style:italic;
  color:${brand.accent};
  letter-spacing:3px;
  margin-bottom:6px;
}

/* ── Divider ── */
.divider {
  display:flex;
  align-items:center;
  gap:10px;
  width:360px;
  margin:5px auto;
}
.divider-line {
  flex:1;
  height:1px;
  background:linear-gradient(90deg, transparent, ${brand.accent} 30%, ${brand.accent} 70%, transparent);
}

/* ── Presented to ── */
.presented-to {
  font-family:'Cormorant Garamond', serif;
  font-size:10px;
  color:${brand.accent};
  letter-spacing:3.5px;
  text-transform:uppercase;
  margin-bottom:2px;
}

/* ── Recipient name ── */
.recipient-name {
  font-family:'Cormorant Garamond', serif;
  font-size:46px;
  font-weight:600;
  font-style:italic;
  color:${brand.primary};
  line-height:1.05;
  letter-spacing:0.5px;
  margin-bottom:4px;
  max-width:560px;
  word-break:break-word;
}

/* ── Body text ── */
.cert-body-text {
  font-family:'Cormorant Garamond', serif;
  font-size:11.5px;
  color:#5a4a2a;
  letter-spacing:1.5px;
  line-height:1.5;
  max-width:520px;
  margin:0 auto 6px;
}

/* ── Module/qualification box ── */
.module-box {
  background:${brand.primary};
  padding:8px 30px 9px;
  width:86%;
  max-width:560px;
  margin:0 auto 8px;
  position:relative;
}
.module-box::before,
.module-box::after {
  content:'';
  position:absolute;
  left:0; right:0;
  height:1.5px;
  background:linear-gradient(90deg, transparent, ${brand.accent} 15%, ${brand.accent} 85%, transparent);
}
.module-box::before { top:0; }
.module-box::after  { bottom:0; }

.module-label {
  font-family:'Cinzel', serif;
  font-size:6.5px;
  letter-spacing:4px;
  color:${brand.accent};
  text-transform:uppercase;
  margin-bottom:4px;
}
.module-title {
  font-family:'Cinzel', serif;
  font-size:11px;
  font-weight:600;
  color:${brand.cream};
  letter-spacing:1.5px;
  line-height:1.5;
  text-transform:uppercase;
}

/* ── Stats row ── */
.stats {
  display:flex;
  align-items:center;
  justify-content:center;
  gap:0;
  margin-bottom:8px;
}
.stat {
  padding:0 20px;
  text-align:center;
}
.stat-value {
  font-family:'Cinzel', serif;
  font-size:20px;
  font-weight:700;
  color:${brand.primary};
  line-height:1;
  margin-bottom:3px;
}
.stat-value.gold { color:${brand.accent}; }
.stat-label {
  font-family:'Cormorant Garamond', serif;
  font-size:8.5px;
  color:#7a6040;
  letter-spacing:2px;
  text-transform:uppercase;
}
.stat-sep {
  width:1px;
  height:36px;
  background:linear-gradient(180deg, transparent, ${brand.accent} 30%, ${brand.accent} 70%, transparent);
}

/* ── FOOTER SIGNATURE ROW ── */
.cert-footer {
  border-top:1px solid rgba(${brand.accent === "#b8973a" ? "184,151,58" : "184,151,58"},0.35);
  padding:8px 54px 0;
  display:flex;
  align-items:flex-start;
  justify-content:space-between;
  position:relative;
  z-index:2;
  flex-shrink:0;
  margin-bottom:6px;
}

.sig {
  text-align:center;
  width:160px;
}
.sig-script {
  font-family:'Cormorant Garamond', serif;
  font-size:22px;
  font-style:italic;
  color:${brand.primary};
  margin-bottom:2px;
  line-height:1;
}
.sig-line {
  width:140px;
  height:0.8px;
  background:${brand.primary};
  margin:0 auto 3px;
}
.sig-name {
  font-family:'Cinzel', serif;
  font-size:7px;
  letter-spacing:1.5px;
  color:${brand.primary};
  text-transform:uppercase;
  margin-bottom:1px;
  font-weight:600;
}
.sig-role {
  font-family:'Cormorant Garamond', serif;
  font-size:9px;
  font-style:italic;
  color:#7a6040;
  line-height:1.3;
}

/* ── Seal (center of footer) ── */
.seal {
  width:90px;
  height:90px;
  flex-shrink:0;
  margin-top:-14px;
}

/* ── BOTTOM STRIP ── */
.cert-strip {
  background:${brand.primary};
  height:22px;
  display:flex;
  align-items:center;
  justify-content:space-between;
  padding:0 50px;
  position:relative;
  z-index:2;
  flex-shrink:0;
}
.cert-strip::before {
  content:'';
  position:absolute;
  top:0; left:0; right:0;
  height:1.5px;
  background:linear-gradient(90deg, transparent, ${brand.accent} 20%, ${brand.accent} 80%, transparent);
}
.strip-id {
  font-family:'Cormorant Garamond', serif;
  font-size:8px;
  color:rgba(255,255,255,0.55);
  letter-spacing:1.2px;
}
.strip-verify {
  font-family:'Cinzel', serif;
  font-size:7px;
  color:${brand.accent};
  letter-spacing:2.5px;
  text-transform:uppercase;
}
</style>
</head>
<body>

<div class="frame-outer">
  <div class="frame-border-1">

    <!-- Corner ornaments -->
    <div class="corner tl">${cornerSvg(brand.accent, brand.accent2)}</div>
    <div class="corner tr">${cornerSvg(brand.accent, brand.accent2)}</div>
    <div class="corner bl">${cornerSvg(brand.accent, brand.accent2)}</div>
    <div class="corner br">${cornerSvg(brand.accent, brand.accent2)}</div>

    <div class="frame-border-2">
      <div class="watermark">${brand.abbrev.toUpperCase()}</div>

      <!-- TOP HEADER BAND -->
      <div class="cert-header">
        <div class="hdr-series">${esc(brand.series)}</div>
        <div class="hdr-ref">Official Certification Record</div>
      </div>

      <!-- MAIN BODY -->
      <div class="cert-body">

        <div class="inst-name">${institution}</div>

        <div class="cert-title">Certificate</div>
        <div class="cert-title-sub">of Achievement</div>

        <div class="divider">
          <div class="divider-line"></div>
          ${starDivider}
          <div class="divider-line"></div>
        </div>

        <p class="presented-to">This is to Certify That</p>

        <div class="recipient-name">${recipientName}</div>

        <p class="cert-body-text">
          Has been formally evaluated for demonstrated knowledge, competence and performance,
          and is hereby awarded the following professional certification:
        </p>

        <div class="module-box">
          <p class="module-label">${esc(brand.series)} &nbsp;·&nbsp; Official Record</p>
          <p class="module-title">${moduleTitle}</p>
        </div>

        ${(scoreDisplay || pctDisplay) ? `
        <div class="stats">
          ${scoreDisplay ? `
          <div class="stat">
            <div class="stat-value">${scoreDisplay}</div>
            <div class="stat-label">Final Score</div>
          </div>
          <div class="stat-sep"></div>` : ""}
          ${pctDisplay ? `
          <div class="stat">
            <div class="stat-value gold">${pctDisplay}%</div>
            <div class="stat-label">Grade</div>
          </div>
          <div class="stat-sep"></div>` : ""}
          <div class="stat">
            <div class="stat-value" style="font-size:14px;">${dateLong}</div>
            <div class="stat-label">Date Awarded</div>
          </div>
        </div>` : `
        <div class="stats">
          <div class="stat">
            <div class="stat-value" style="font-size:14px;">${dateLong}</div>
            <div class="stat-label">Date Awarded</div>
          </div>
        </div>`}

      </div><!-- /cert-body -->

      <!-- SIGNATURE ROW -->
      <div class="cert-footer">
        <div class="sig">
          <div class="sig-script">${esc(brand.signatory1Name.split(" ")[0])}</div>
          <div class="sig-line"></div>
          <div class="sig-name">${esc(brand.signatory1Name)}</div>
          <div class="sig-role">${esc(brand.signatory1Role)}</div>
        </div>

        <div class="seal">${sealSvg}</div>

        <div class="sig">
          <div class="sig-script">Academic</div>
          <div class="sig-line"></div>
          <div class="sig-name">${esc(brand.signatory2Name)}</div>
          <div class="sig-role">${esc(brand.signatory2Role)}</div>
        </div>
      </div>

      <!-- BOTTOM STRIP -->
      <div class="cert-strip">
        <span class="strip-id">Credential ID: ${credId}</span>
        <span class="strip-verify">In Testimony Whereof We Have Subscribed Our Signatures Under the Seal of the Institute</span>
      </div>

    </div><!-- /frame-border-2 -->
  </div><!-- /frame-border-1 -->
</div><!-- /frame-outer -->

</body>
</html>`;
}