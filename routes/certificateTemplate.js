/**
 * certificateTemplate.js
 * ──────────────────────────────────────────────────────────────────────────────
 * CRIPFCNT — LinkedIn-inspired modern certificate.
 *
 * Design language:
 *  ✅ Clean white background, mint/teal (#1DE9B6) brand accent
 *  ✅ Thin mint top bar — brand anchor
 *  ✅ CRIPFCNT logo mark + wordmark header
 *  ✅ Quiz title as the main headline (LinkedIn "course title" equivalent)
 *  ✅ "Course completed by" → "Awarded to" learner name centrepiece
 *  ✅ Module/category row below name
 *  ✅ Skill/topic tags (pill chips)
 *  ✅ Score + Grade stats row (no duration)
 *  ✅ Signature line + completion badge footer
 *  ✅ Credential strip with serial / verify URL
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
  const categoryLabel = esc(moduleName && quizTitle && moduleName !== quizTitle ? moduleName : "");
  const recipientName = esc(name || "Recipient");
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

  /* ── brand ── */
  const MINT       = "#1DE9B6";
  const MINT_DARK  = "#0D9B77";
  const MINT_BG    = "#E1F5EE";
  const MINT_BORDER= "#9FE1CB";
  const INK        = "#111111";
  const MUTED      = "#777777";
  const LIGHT      = "#AAAAAA";
  const DIVIDER    = "#E8E8E8";
  const STRIP_BG   = "#F7F7F7";

  /* org-specific overrides (keep existing orgs working) */
  const orgLow = (orgName || "").toLowerCase();
  let accentMain = MINT;
  let accentDark = MINT_DARK;
  let accentBg   = MINT_BG;
  let accentBdr  = MINT_BORDER;
  let sig1Name   = "Donald Mataranyika";
  let sig1Role   = "Chair, Board of Directors";
  let abbrev     = "CRIPFCNT";
  let series     = "CRIPFCNT Learning Management System";

  if (/nyaradzo/.test(orgLow)) {
    accentMain = "#C9A227"; accentDark = "#7A5F0A"; accentBg = "#FBF3DA"; accentBdr = "#E8CC7E";
    abbrev = "NGT"; series = "Nyaradzo Group Training";
  }
  if (/winchester/.test(orgLow)) {
    accentMain = "#1F3C88"; accentDark = "#0F1F4A"; accentBg = "#E8EDF8"; accentBdr = "#8DA0D1";
    abbrev = "WS"; series = "Winchester School";
  }
  if (/st[\s-]?eurit|eurit/.test(orgLow)) {
    accentMain = "#D4AF37"; accentDark = "#7A5F0A"; accentBg = "#FBF5DA"; accentBdr = "#E8CC7E";
    abbrev = "SEIS"; series = "St Eurit International School";
  }

  /* ── Credential ID ── */
  const credId = `${abbrev}-${dateStr.replace(/-/g,"")}-${(name||"X").replace(/\s+/g,"").toUpperCase().slice(0,6).padEnd(6,"0")}`;

  /* ── CRIPFCNT logo mark SVG (inline, no external fetch) ── */
  const logoMark = `<svg width="32" height="32" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M20 10 L20 90 Q20 90 50 90 Q80 90 80 60 L80 52 L54 52 L54 70 Q54 74 50 74 Q46 74 46 70 L46 30 Q46 26 50 26 Q54 26 54 30 L54 48 L80 48 L80 40 Q80 10 50 10 Z" fill="${accentMain}"/>
  </svg>`;

  /* ── Completion badge SVG ── */
  const badge = `<svg width="72" height="72" viewBox="0 0 72 72" fill="none" xmlns="http://www.w3.org/2000/svg">
    <circle cx="36" cy="36" r="34" stroke="${accentMain}" stroke-width="2" fill="none"/>
    <circle cx="36" cy="36" r="28" stroke="${accentMain}" stroke-width="0.8" fill="none" stroke-dasharray="3 2" opacity="0.5"/>
    <text x="36" y="33" font-family="'Inter',Arial,sans-serif" font-size="7.5" font-weight="600" fill="${accentMain}" text-anchor="middle" letter-spacing="1">COURSE</text>
    <text x="36" y="44" font-family="'Inter',Arial,sans-serif" font-size="7.5" font-weight="600" fill="${accentMain}" text-anchor="middle" letter-spacing="1">COMPLETE</text>
    <path d="M28 38 L33.5 43.5 L44.5 32" stroke="${accentMain}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`;

  /* ── Skill tags — derive from moduleName / quizTitle ── */
  const tagSources = [
    quizTitle   || null,
    moduleName  || null,
    orgName     || null,
  ].filter(Boolean);
  const tags = [...new Set(tagSources)].slice(0, 3);
  const tagHtml = tags.map(t =>
    `<span class="tag">${esc(t)}</span>`
  ).join("\n          ");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<title>Certificate — ${recipientName}</title>
<style>
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600&display=swap');

*,*::before,*::after{box-sizing:border-box;margin:0;padding:0;}
@page{margin:0;size:A4 portrait;}

html,body{
  width:210mm;height:297mm;overflow:hidden;
  background:#F0F0F0;
  display:flex;align-items:center;justify-content:center;
  font-family:'Inter',Arial,sans-serif;
  -webkit-font-smoothing:antialiased;
}

/* ── CARD SHELL ── */
.card{
  width:184mm;
  min-height:260mm;
  background:#FFFFFF;
  border:0.5px solid #DEDEDE;
  border-radius:3px;
  overflow:hidden;
  display:flex;
  flex-direction:column;
  -webkit-print-color-adjust:exact;
  print-color-adjust:exact;
}

/* ── TOP ACCENT BAR ── */
.top-bar{
  height:5px;
  background:${accentMain};
  flex-shrink:0;
}

/* ── BODY ── */
.body{
  flex:1;
  padding:36px 56px 28px;
  display:flex;
  flex-direction:column;
  align-items:center;
  text-align:center;
}

/* ── LOGO HEADER ── */
.logo-row{
  display:flex;
  align-items:center;
  gap:10px;
  margin-bottom:32px;
}
.logo-text{
  font-size:19px;
  font-weight:600;
  color:${accentMain};
  letter-spacing:1.5px;
}

/* ── DIVIDER ── */
.divider{
  width:100%;
  height:0.5px;
  background:${DIVIDER};
  margin:20px 0;
}
.divider-short{
  width:60px;
  height:2px;
  background:${accentMain};
  border-radius:2px;
  margin:0 auto 20px;
}

/* ── QUIZ TITLE (main headline) ── */
.quiz-title{
  font-size:22px;
  font-weight:600;
  color:${INK};
  line-height:1.3;
  margin-bottom:6px;
  max-width:420px;
}

/* ── CATEGORY ── */
.category{
  font-size:12px;
  color:${accentDark};
  font-weight:500;
  letter-spacing:0.4px;
  margin-bottom:20px;
  text-transform:uppercase;
}

/* ── AWARDED LABEL ── */
.awarded-label{
  font-size:11px;
  color:${LIGHT};
  letter-spacing:1px;
  text-transform:uppercase;
  margin-bottom:6px;
}

/* ── RECIPIENT NAME ── */
.recipient{
  font-size:30px;
  font-weight:500;
  color:${INK};
  line-height:1.15;
  margin-bottom:6px;
  max-width:400px;
  word-break:break-word;
}

/* ── ORG + DATE ── */
.org-date{
  font-size:12.5px;
  color:${MUTED};
  margin-bottom:20px;
}
.sep{ color:${DIVIDER}; margin:0 8px; }

/* ── ACHIEVEMENT SENTENCE ── */
.achieve{
  font-size:12.5px;
  color:${MUTED};
  line-height:1.7;
  max-width:360px;
  margin-bottom:20px;
}

/* ── SKILL TAGS ── */
.tags{
  display:flex;
  flex-wrap:wrap;
  justify-content:center;
  gap:8px;
  margin-bottom:20px;
}
.tag{
  font-size:11.5px;
  color:${accentDark};
  background:${accentBg};
  border:0.5px solid ${accentBdr};
  border-radius:20px;
  padding:5px 14px;
  letter-spacing:0.2px;
}

/* ── STATS ROW ── */
.stats{
  display:flex;
  align-items:center;
  justify-content:center;
  gap:0;
  margin-bottom:20px;
}
.stat{
  padding:0 28px;
  text-align:center;
}
.stat-val{
  font-size:22px;
  font-weight:600;
  color:${accentMain};
  line-height:1;
  margin-bottom:4px;
}
.stat-lbl{
  font-size:10px;
  color:${LIGHT};
  letter-spacing:0.8px;
  text-transform:uppercase;
}
.stat-sep{
  width:0.5px;
  height:36px;
  background:${DIVIDER};
}

/* ── GRADE BADGE inline ── */
.grade-chip{
  display:inline-block;
  font-size:10px;
  font-weight:600;
  color:${accentDark};
  background:${accentBg};
  border:0.5px solid ${accentBdr};
  border-radius:20px;
  padding:3px 12px;
  letter-spacing:0.4px;
  text-transform:uppercase;
  margin-bottom:20px;
}

/* ── FOOTER ── */
.footer{
  border-top:0.5px solid ${DIVIDER};
  padding:18px 56px 0;
  display:flex;
  align-items:flex-end;
  justify-content:space-between;
  flex-shrink:0;
}
.sig-block{ text-align:left; }
.sig-line{
  width:120px;
  height:0.5px;
  background:#CCCCCC;
  margin-bottom:5px;
}
.sig-name{
  font-size:11.5px;
  font-weight:500;
  color:${INK};
  margin-bottom:2px;
}
.sig-role{
  font-size:10.5px;
  color:${MUTED};
}
.badge-wrap{ flex-shrink:0; }

/* ── CREDENTIAL STRIP ── */
.cstrip{
  background:${STRIP_BG};
  border-top:0.5px solid ${DIVIDER};
  padding:9px 56px;
  display:flex;
  align-items:center;
  justify-content:space-between;
  flex-shrink:0;
  margin-top:18px;
}
.cstrip-id{
  font-size:9px;
  color:${LIGHT};
  letter-spacing:0.5px;
}
.cstrip-verify{
  font-size:9px;
  color:${accentDark};
  font-weight:500;
  letter-spacing:0.3px;
}
</style>
</head>
<body>

<div class="card">
  <div class="top-bar"></div>

  <div class="body">

    <!-- LOGO -->
    <div class="logo-row">
      ${logoMark}
      <span class="logo-text">${abbrev}</span>
    </div>

    <!-- QUIZ TITLE -->
    <p class="quiz-title">${moduleTitle}</p>
    ${categoryLabel ? `<p class="category">${categoryLabel}</p>` : `<div style="height:16px;"></div>`}

    <div class="divider"></div>

    <!-- AWARDED TO -->
    <p class="awarded-label">Awarded to</p>
    <p class="recipient">${recipientName}</p>
    <p class="org-date">
      ${orgLabel}<span class="sep">·</span>${dateLong}
    </p>

    <!-- ACHIEVEMENT TEXT -->
    <p class="achieve">
      Has successfully completed the assessment and demonstrated
      proficiency in this subject area on the CRIPFCNT platform.
    </p>

    <!-- SKILL TAGS -->
    <div class="tags">
      ${tagHtml}
    </div>

    <div class="divider-short"></div>

    <!-- GRADE CHIP -->
    ${gradeLabel ? `<div class="grade-chip">${esc(gradeLabel)}</div>` : ""}

    <!-- STATS -->
    ${(scoreDisplay || pctDisplay) ? `
    <div class="stats">
      ${scoreDisplay ? `
        <div class="stat">
          <div class="stat-val">${scoreDisplay}</div>
          <div class="stat-lbl">Final Score</div>
        </div>
        <div class="stat-sep"></div>` : ""}
      ${pctDisplay ? `
        <div class="stat">
          <div class="stat-val">${pctDisplay}%</div>
          <div class="stat-lbl">Grade</div>
        </div>` : ""}
    </div>` : ""}

  </div><!-- /body -->

  <!-- FOOTER -->
  <div class="footer">
    <div class="sig-block">
      <div class="sig-line"></div>
      <div class="sig-name">${esc(sig1Name)}</div>
      <div class="sig-role">${esc(sig1Role)}</div>
    </div>
    <div class="badge-wrap">${badge}</div>
  </div>

  <!-- CREDENTIAL STRIP -->
  <div class="cstrip">
    <span class="cstrip-id">Certificate ID: ${credId} &nbsp;·&nbsp; ${esc(series)}</span>
    <span class="cstrip-verify">cripfcnt.com/verify</span>
  </div>

</div><!-- /card -->

</body>
</html>`;
}