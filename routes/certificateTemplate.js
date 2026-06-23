/**
 * certificateTemplate.js
 * ──────────────────────────────────────────────────────────────────────────────
 * CRIPFCNT — Option C certificate design.
 *
 * Layout anatomy (inspired by Afreximbank):
 *  ✅ Teal sidebar spine — CRIPFCNT brand mark + vertical wordmark + chevron texture
 *  ✅ Dark teal header band — logo left, cert type + date right
 *  ✅ "This is to certify that" → recipient name centrepiece
 *  ✅ Quiz title in mint left-accent block
 *  ✅ Skill/topic tags (pill chips)
 *  ✅ Score + Grade + Achievement stats row
 *  ✅ SVG signature of director + signature line
 *  ✅ Completion badge (circle with checkmark)
 *  ✅ Credential strip — ID + verify URL
 *  ✅ CRIPFCNT logo watermark behind content
 *
 * Portrait A4 (210 × 297 mm).
 * Puppeteer call should use:
 *   format: "A4", printBackground: true,
 *   margin: { top:"0", bottom:"0", left:"0", right:"0" }
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

  const moduleTitle   = esc(quizTitle || moduleName || "Assessment");
  const categoryLabel = (moduleName && quizTitle && moduleName !== quizTitle)
    ? esc(moduleName) : "";
  const recipientName = esc(name  || "Recipient");
  const orgLabel      = esc(orgName || "CRIPFCNT");
  const pctDisplay    = percentage != null ? esc(String(percentage)) : null;
  const scoreDisplay  = score      != null ? esc(String(score))      : null;

  /* Grade label */
  let gradeLabel = "";
  if (percentage != null) {
    const p = Number(percentage);
    if      (p >= 90) gradeLabel = "Distinction";
    else if (p >= 75) gradeLabel = "Merit";
    else if (p >= 50) gradeLabel = "Pass";
  }

  /* ── brand defaults (CRIPFCNT) ── */
  const orgLow = (orgName || "").toLowerCase();

  let SIDEBAR_BG  = "#0B4F45";
  let HEADER_BG   = "#0B4F45";
  let MINT        = "#1DE9B6";
  let MINT_DARK   = "#0D9B77";
  let MINT_BG     = "#E1F5EE";
  let MINT_BORDER = "#9FE1CB";
  let abbrev      = "CRIPFCNT";
  let series      = "CRIPFCNT Learning &amp; Assessment Platform";
  let sig1Name    = "Donald Mataranyika";
  let sig1Role    = "Chair, Board of Directors";

  /* org-specific overrides */
  if (/nyaradzo/.test(orgLow)) {
    SIDEBAR_BG = "#062A5E"; HEADER_BG = "#062A5E";
    MINT = "#C9A227"; MINT_DARK = "#7A5F0A"; MINT_BG = "#FBF3DA"; MINT_BORDER = "#E8CC7E";
    abbrev = "NGT"; series = "Nyaradzo Group Training";
  }
  if (/winchester/.test(orgLow)) {
    SIDEBAR_BG = "#1F3C88"; HEADER_BG = "#1F3C88";
    MINT = "#E8C95A"; MINT_DARK = "#7A5F0A"; MINT_BG = "#FBF5DA"; MINT_BORDER = "#E8CC7E";
    abbrev = "WS"; series = "Winchester School";
  }
  if (/st[\s-]?eurit|eurit/.test(orgLow)) {
    SIDEBAR_BG = "#111111"; HEADER_BG = "#111111";
    MINT = "#D4AF37"; MINT_DARK = "#7A5F0A"; MINT_BG = "#FBF5DA"; MINT_BORDER = "#E8CC7E";
    abbrev = "SEIS"; series = "St Eurit International School";
  }

  /* ── Credential ID ── */
  const credId = `${abbrev}-${dateStr.replace(/-/g,"")}-${(name||"X").replace(/\s+/g,"").toUpperCase().slice(0,6).padEnd(6,"0")}`;

  /* ── Skill tags ── */
  const tagSources = [quizTitle || null, moduleName || null, orgName || null]
    .filter(Boolean);
  const tags = [...new Set(tagSources)].slice(0, 3);
  const tagHtml = tags.map(t =>
    `<span class="tag">${esc(t)}</span>`
  ).join("\n              ");

  /* ── SVG: CRIPFCNT logo mark ── */
  const logoMark = (color = "#1DE9B6", w = 28, h = 28) =>
    `<svg width="${w}" height="${h}" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M20 10 L20 90 Q20 90 50 90 Q80 90 80 60 L80 52 L54 52 L54 70 Q54 74 50 74 Q46 74 46 70 L46 30 Q46 26 50 26 Q54 26 54 30 L54 48 L80 48 L80 40 Q80 10 50 10 Z" fill="${color}"/>
    </svg>`;

  /* ── SVG: Director signature (Donald Mataranyika — stylised cursive path) ── */
  const signatureSvg = `<svg width="140" height="48" viewBox="0 0 140 48" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M8 34 C12 20 18 14 26 16 C32 17 34 24 30 30 C26 36 20 36 18 32 C16 28 22 22 30 26 C38 30 44 24 50 18"
      stroke="#1a1a2e" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
    <path d="M50 18 C56 12 60 14 62 20 C64 26 60 32 56 30 C52 28 54 22 60 24 C68 27 74 20 80 16"
      stroke="#1a1a2e" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
    <path d="M80 16 C86 12 90 16 88 24 C86 30 82 34 84 38 C86 42 92 40 96 36"
      stroke="#1a1a2e" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
    <path d="M96 36 C100 32 106 28 110 32 C114 36 110 42 106 40 C102 38 104 32 110 30 C118 28 124 34 130 38"
      stroke="#1a1a2e" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
    <path d="M8 40 C30 38 80 38 130 40"
      stroke="#1a1a2e" stroke-width="0.5" stroke-linecap="round" fill="none" opacity="0.3"/>
  </svg>`;

  /* ── SVG: Completion badge ── */
  const completionBadge = `<svg width="64" height="64" viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
    <circle cx="32" cy="32" r="30" stroke="${MINT}" stroke-width="2" fill="none"/>
    <circle cx="32" cy="32" r="24" stroke="${MINT}" stroke-width="0.8" stroke-dasharray="3 2.5" fill="none" opacity="0.5"/>
    <path d="M21 32 L28 39 L43 24" stroke="${MINT}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
    <text x="32" y="56" font-family="'Inter',Arial,sans-serif" font-size="6" font-weight="600"
      fill="${MINT}" text-anchor="middle" letter-spacing="1.5">CERTIFIED</text>
  </svg>`;

  /* ── SVG: Sidebar chevron texture pattern ── */
  const chevronPattern = `<svg width="52" height="300" viewBox="0 0 52 300" fill="none" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid slice">
    ${Array.from({length: 18}, (_, i) => {
      const y = 10 + i * 16;
      return `<polyline points="8,${y} 26,${y+8} 44,${y}" stroke="${MINT}" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" opacity="0.22"/>`;
    }).join("\n    ")}
  </svg>`;

  /* ── Watermark logo (large, faint, behind content) ── */
  const watermark = `<svg width="220" height="220" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M20 10 L20 90 Q20 90 50 90 Q80 90 80 60 L80 52 L54 52 L54 70 Q54 74 50 74 Q46 74 46 70 L46 30 Q46 26 50 26 Q54 26 54 30 L54 48 L80 48 L80 40 Q80 10 50 10 Z" fill="${SIDEBAR_BG}"/>
  </svg>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<title>Certificate — ${recipientName}</title>
<style>
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap');

*,*::before,*::after{box-sizing:border-box;margin:0;padding:0;}
@page{margin:0;size:A4 portrait;}

html,body{
  width:210mm;height:297mm;overflow:hidden;
  background:#E8E8E8;
  display:flex;align-items:center;justify-content:center;
  font-family:'Inter',Arial,sans-serif;
  -webkit-font-smoothing:antialiased;
}

/* ── OUTER CARD ── */
.card{
  width:192mm;
  height:272mm;
  background:#ffffff;
  border:0.5px solid #D0D0D0;
  border-radius:2px;
  overflow:hidden;
  display:flex;
  flex-direction:row;
  -webkit-print-color-adjust:exact;
  print-color-adjust:exact;
}

/* ── SIDEBAR ── */
.sidebar{
  width:52px;
  background:${SIDEBAR_BG};
  flex-shrink:0;
  display:flex;
  flex-direction:column;
  align-items:center;
  padding:0;
  position:relative;
  overflow:hidden;
}
.sidebar-pattern{
  position:absolute;
  top:0;left:0;right:0;bottom:0;
}
.sidebar-bottom{
  position:absolute;
  bottom:0;left:0;right:0;
  display:flex;
  flex-direction:column;
  align-items:center;
  padding-bottom:16px;
  z-index:2;
}
.sidebar-wordmark{
  writing-mode:vertical-rl;
  transform:rotate(180deg);
  font-family:'Inter',Arial,sans-serif;
  font-size:9px;
  font-weight:700;
  color:${MINT};
  letter-spacing:3px;
  opacity:0.85;
  margin-bottom:10px;
}
.sidebar-mark{
  opacity:0.6;
}

/* ── MAIN COLUMN ── */
.main{
  flex:1;
  display:flex;
  flex-direction:column;
  overflow:hidden;
}

/* ── HEADER BAND ── */
.header{
  background:${HEADER_BG};
  padding:16px 28px 14px;
  display:flex;
  align-items:center;
  justify-content:space-between;
  flex-shrink:0;
}
.header-left{
  display:flex;
  align-items:center;
  gap:10px;
}
.header-wordmark{
  font-family:'Inter',Arial,sans-serif;
  font-size:15px;
  font-weight:700;
  color:${MINT};
  letter-spacing:1.5px;
}
.header-sub{
  font-family:'Inter',Arial,sans-serif;
  font-size:8px;
  color:rgba(255,255,255,0.38);
  letter-spacing:2px;
  text-transform:uppercase;
  margin-top:2px;
}
.header-right{
  text-align:right;
}
.header-cert-label{
  font-family:'Inter',Arial,sans-serif;
  font-size:8px;
  color:rgba(255,255,255,0.42);
  letter-spacing:2px;
  text-transform:uppercase;
  margin-bottom:3px;
}
.header-cert-type{
  font-family:'Inter',Arial,sans-serif;
  font-size:11px;
  font-weight:600;
  color:rgba(255,255,255,0.88);
  letter-spacing:0.5px;
}
.header-date{
  font-family:'Inter',Arial,sans-serif;
  font-size:9px;
  color:${MINT};
  margin-top:3px;
  font-weight:500;
}

/* ── BODY ── */
.body{
  flex:1;
  padding:28px 32px 0 28px;
  position:relative;
  overflow:hidden;
  display:flex;
  flex-direction:column;
}
.watermark{
  position:absolute;
  right:-30px;
  bottom:-30px;
  opacity:0.035;
  pointer-events:none;
}

/* ── CERTIFY BLOCK ── */
.certify-label{
  font-family:'Inter',Arial,sans-serif;
  font-size:10px;
  color:#AAAAAA;
  letter-spacing:1.5px;
  text-transform:uppercase;
  margin-bottom:6px;
}
.recipient{
  font-family:'Inter',Arial,sans-serif;
  font-size:30px;
  font-weight:600;
  color:#0B1F1A;
  line-height:1.15;
  margin-bottom:4px;
  max-width:420px;
  word-break:break-word;
}
.succeed-line{
  font-family:'Inter',Arial,sans-serif;
  font-size:12px;
  color:#888888;
  margin-bottom:20px;
}

/* ── QUIZ TITLE BLOCK (accent left border) ── */
.quiz-block{
  border-left:3px solid ${MINT};
  padding:10px 16px;
  background:${MINT_BG};
  border-radius:0 4px 4px 0;
  margin-bottom:20px;
  max-width:100%;
}
.quiz-category{
  font-family:'Inter',Arial,sans-serif;
  font-size:9px;
  font-weight:600;
  color:${MINT_DARK};
  letter-spacing:1.5px;
  text-transform:uppercase;
  margin-bottom:4px;
}
.quiz-title{
  font-family:'Inter',Arial,sans-serif;
  font-size:15px;
  font-weight:600;
  color:#0B1F1A;
  line-height:1.35;
}

/* ── DIVIDER ── */
.divider{
  height:0.5px;
  background:#EBEBEB;
  margin:0 0 18px;
}

/* ── TAGS ── */
.tags{
  display:flex;
  flex-wrap:wrap;
  gap:7px;
  margin-bottom:20px;
}
.tag{
  font-family:'Inter',Arial,sans-serif;
  font-size:10.5px;
  color:${MINT_DARK};
  background:${MINT_BG};
  border:0.5px solid ${MINT_BORDER};
  border-radius:20px;
  padding:4px 13px;
  letter-spacing:0.2px;
}

/* ── STATS ROW ── */
.stats{
  display:flex;
  align-items:stretch;
  gap:0;
  margin-bottom:22px;
}
.stat{
  padding:0 24px 0 0;
  margin-right:24px;
  border-right:0.5px solid #E8E8E8;
}
.stat:last-child{
  border-right:none;
  margin-right:0;
}
.stat-val{
  font-family:'Inter',Arial,sans-serif;
  font-size:22px;
  font-weight:700;
  color:${MINT};
  line-height:1;
  margin-bottom:4px;
}
.stat-val-sm{
  font-family:'Inter',Arial,sans-serif;
  font-size:13px;
  font-weight:700;
  color:${MINT};
  line-height:1;
  margin-bottom:4px;
  padding-top:4px;
}
.stat-label{
  font-family:'Inter',Arial,sans-serif;
  font-size:9px;
  color:#AAAAAA;
  letter-spacing:1px;
  text-transform:uppercase;
}

/* ── FOOTER ── */
.footer{
  border-top:0.5px solid #EBEBEB;
  padding:16px 32px 16px 28px;
  display:flex;
  align-items:flex-end;
  justify-content:space-between;
  flex-shrink:0;
  margin-top:auto;
}
.sig-block{ text-align:left; }
.sig-svg{ display:block; margin-bottom:0px; }
.sig-rule{
  width:130px;
  height:0.5px;
  background:#CCCCCC;
  margin-bottom:5px;
}
.sig-name{
  font-family:'Inter',Arial,sans-serif;
  font-size:10.5px;
  font-weight:600;
  color:#1a1a2e;
  margin-bottom:2px;
}
.sig-role{
  font-family:'Inter',Arial,sans-serif;
  font-size:9.5px;
  color:#888888;
}

/* ── CREDENTIAL STRIP ── */
.cstrip{
  background:#F6F6F6;
  border-top:0.5px solid #E8E8E8;
  padding:8px 28px;
  display:flex;
  align-items:center;
  justify-content:space-between;
  flex-shrink:0;
}
.cstrip-id{
  font-family:'Inter',Arial,sans-serif;
  font-size:8.5px;
  color:#BBBBBB;
  letter-spacing:0.4px;
}
.cstrip-verify{
  font-family:'Inter',Arial,sans-serif;
  font-size:8.5px;
  color:${MINT_DARK};
  font-weight:500;
  letter-spacing:0.3px;
}
</style>
</head>
<body>

<div class="card">

  <!-- SIDEBAR SPINE -->
  <div class="sidebar">
    <div class="sidebar-pattern">${chevronPattern}</div>
    <div class="sidebar-bottom">
      <div class="sidebar-wordmark">${abbrev}</div>
      <div class="sidebar-mark">${logoMark(MINT, 22, 22)}</div>
    </div>
  </div>

  <!-- MAIN CONTENT -->
  <div class="main">

    <!-- HEADER BAND -->
    <div class="header">
      <div class="header-left">
        ${logoMark(MINT, 30, 30)}
        <div>
          <div class="header-wordmark">${abbrev}</div>
          <div class="header-sub">${series}</div>
        </div>
      </div>
      <div class="header-right">
        <div class="header-cert-label">Official Document</div>
        <div class="header-cert-type">Certificate of Completion</div>
        <div class="header-date">${dateLong}</div>
      </div>
    </div>

    <!-- BODY -->
    <div class="body">

      <!-- WATERMARK -->
      <div class="watermark">${watermark}</div>

      <!-- RECIPIENT -->
      <p class="certify-label">This is to certify that</p>
      <p class="recipient">${recipientName}</p>
      <p class="succeed-line">has successfully completed the assessment</p>

      <!-- QUIZ TITLE BLOCK -->
      <div class="quiz-block">
        ${categoryLabel ? `<div class="quiz-category">${categoryLabel}</div>` : ""}
        <div class="quiz-title">${moduleTitle}</div>
      </div>

      <div class="divider"></div>

      <!-- TAGS -->
      <div class="tags">
        ${tagHtml}
        <span class="tag">${orgLabel}</span>
      </div>

      <!-- STATS -->
      ${(scoreDisplay || pctDisplay || gradeLabel) ? `
      <div class="stats">
        ${scoreDisplay ? `
        <div class="stat">
          <div class="stat-val">${scoreDisplay}</div>
          <div class="stat-label">Final Score</div>
        </div>` : ""}
        ${pctDisplay ? `
        <div class="stat">
          <div class="stat-val">${pctDisplay}%</div>
          <div class="stat-label">Grade</div>
        </div>` : ""}
        ${gradeLabel ? `
        <div class="stat">
          <div class="stat-val-sm">${esc(gradeLabel).toUpperCase()}</div>
          <div class="stat-label">Achievement</div>
        </div>` : ""}
      </div>` : ""}

    </div><!-- /body -->

    <!-- FOOTER: signature + badge -->
    <div class="footer">
      <div class="sig-block">
        <div class="sig-svg">${signatureSvg}</div>
        <div class="sig-rule"></div>
        <div class="sig-name">${esc(sig1Name)}</div>
        <div class="sig-role">${esc(sig1Role)}</div>
      </div>
      ${completionBadge}
    </div>

    <!-- CREDENTIAL STRIP -->
    <div class="cstrip">
      <span class="cstrip-id">Certificate ID: ${credId} &nbsp;·&nbsp; ${series}</span>
      <span class="cstrip-verify">cripfcnt.com/verify</span>
    </div>

  </div><!-- /main -->
</div><!-- /card -->

</body>
</html>`;
}