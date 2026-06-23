/**
 * certificateTemplate.js
 * ──────────────────────────────────────────────────────────────────────────────
 * CRIPFCNT — Option A: content left / dark branded right panel.
 *
 * SIZE: A4 LANDSCAPE (297 × 210 mm)
 *
 * Layout:
 *  ✅ Left sidebar spine — chevron/arrow stripe texture (matching stripes.png)
 *  ✅ Dark teal header band — logo + wordmark left, cert type + date right
 *  ✅ Two-column body: left = all content, right = dark teal panel (org/date/ID)
 *  ✅ "This is to certify that" → recipient name → assessment line
 *  ✅ Quiz title in mint left-accent block
 *  ✅ Skill/topic pill tags
 *  ✅ Score + Grade + Achievement stats row
 *  ✅ SVG cursive signature + sig line + completion badge footer
 *  ✅ Credential strip — ID + verify URL
 *  ✅ CRIPFCNT logo watermark behind left content
 *
 * Puppeteer call MUST use:
 *   format: "A4", landscape: true, printBackground: true,
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

  let DARK        = "#0B4F45";
  let MINT        = "#1DE9B6";
  let MINT_DARK   = "#0D9B77";
  let MINT_BG     = "#E1F5EE";
  let MINT_BORDER = "#9FE1CB";
  let abbrev      = "CRIPFCNT";
  let series      = "CRIPFCNT Learning &amp; Assessment Platform";
  let sig1Name    = "Donald Mataranyika";
  let sig1Role    = "Chair, Board of Directors";

  if (/nyaradzo/.test(orgLow)) {
    DARK = "#062A5E";
    MINT = "#C9A227"; MINT_DARK = "#7A5F0A"; MINT_BG = "#FBF3DA"; MINT_BORDER = "#E8CC7E";
    abbrev = "NGT"; series = "Nyaradzo Group Training";
  }
  if (/winchester/.test(orgLow)) {
    DARK = "#1F3C88";
    MINT = "#E8C95A"; MINT_DARK = "#7A5F0A"; MINT_BG = "#FBF5DA"; MINT_BORDER = "#E8CC7E";
    abbrev = "WS"; series = "Winchester School";
  }
  if (/st[\s-]?eurit|eurit/.test(orgLow)) {
    DARK = "#111111";
    MINT = "#D4AF37"; MINT_DARK = "#7A5F0A"; MINT_BG = "#FBF5DA"; MINT_BORDER = "#E8CC7E";
    abbrev = "SEIS"; series = "St Eurit International School";
  }

  /* ── Credential ID ── */
  const credId = `${abbrev}-${dateStr.replace(/-/g,"")}-${(name||"X").replace(/\s+/g,"").toUpperCase().slice(0,6).padEnd(6,"0")}`;

  /* ── Skill tags ── */
  const tagSources = [quizTitle || null, moduleName || null]
    .filter(Boolean);
  const tags = [...new Set(tagSources)].slice(0, 3);
  const tagHtml = tags.map(t =>
    `<span class="tag">${esc(t)}</span>`
  ).join("\n            ");

  /* ── SVG: CRIPFCNT logo mark ── */
  const logoMark = (color, w, h) =>
    `<svg width="${w}" height="${h}" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M20 10 L20 90 Q20 90 50 90 Q80 90 80 60 L80 52 L54 52 L54 70 Q54 74 50 74 Q46 74 46 70 L46 30 Q46 26 50 26 Q54 26 54 30 L54 48 L80 48 L80 40 Q80 10 50 10 Z" fill="${color}"/>
    </svg>`;

  /* ── SVG: Sidebar chevron/arrow stripes (matches stripes.png exactly)
          Stacked right-pointing chevrons, subtle on dark teal ── */
  const stripeRows = Array.from({ length: 40 }, (_, i) => {
    const y = 6 + i * 16;
    /* Each chevron: flat left edge → peak right → flat left edge, pointing right */
    return `<polyline points="2,${y} 22,${y+9} 42,${y}" stroke="${MINT}" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" opacity="0.18"/>`;
  }).join("\n    ");

  /* ── SVG: Right panel chevron stripes (same pattern, slightly larger) ── */
  const rightStripeRows = Array.from({ length: 40 }, (_, i) => {
    const y = 6 + i * 16;
    return `<polyline points="0,${y} 65,${y+22} 130,${y}" stroke="${MINT}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" opacity="0.1"/>`;
  }).join("\n    ");

  /* ── SVG: Director signature ── */
  const signatureSvg = `<svg width="130" height="44" viewBox="0 0 130 44" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M6 32 C10 20 16 13 24 15 C30 17 32 24 28 30 C24 36 18 35 16 31 C14 27 20 21 28 25 C36 29 42 23 48 17"
      stroke="#1a1a2e" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
    <path d="M48 17 C54 11 58 13 60 19 C62 25 58 31 54 29 C50 27 52 21 58 23 C66 26 72 19 78 15"
      stroke="#1a1a2e" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
    <path d="M78 15 C84 11 88 15 86 23 C84 29 80 33 82 37 C84 40 90 38 94 34"
      stroke="#1a1a2e" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
    <path d="M94 34 C98 30 104 27 108 31 C112 35 108 40 104 38 C100 36 103 30 109 29 C117 27 122 33 126 36"
      stroke="#1a1a2e" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
  </svg>`;

  /* ── SVG: Completion badge ── */
  const completionBadge = `<svg width="56" height="56" viewBox="0 0 60 60" fill="none" xmlns="http://www.w3.org/2000/svg">
    <circle cx="30" cy="30" r="28" stroke="${MINT}" stroke-width="1.8" fill="none"/>
    <circle cx="30" cy="30" r="22" stroke="${MINT}" stroke-width="0.8" stroke-dasharray="3 2" fill="none" opacity="0.45"/>
    <path d="M19 30 L26 37 L41 22" stroke="${MINT}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>
    <text x="30" y="53" font-family="'Inter',Arial,sans-serif" font-size="5.5" font-weight="600"
      fill="${MINT}" text-anchor="middle" letter-spacing="1.2">CERTIFIED</text>
  </svg>`;

  /* ── SVG: Watermark ── */
  const watermark = `<svg width="220" height="220" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M20 10 L20 90 Q20 90 50 90 Q80 90 80 60 L80 52 L54 52 L54 70 Q54 74 50 74 Q46 74 46 70 L46 30 Q46 26 50 26 Q54 26 54 30 L54 48 L80 48 L80 40 Q80 10 50 10 Z" fill="${DARK}"/>
  </svg>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<title>Certificate — ${recipientName}</title>
<style>
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap');

*,*::before,*::after{box-sizing:border-box;margin:0;padding:0;}
@page{margin:0;size:A4 landscape;}

html,body{
  width:297mm;height:210mm;overflow:hidden;
  background:#D8D8D8;
  display:flex;align-items:center;justify-content:center;
  font-family:'Inter',Arial,sans-serif;
  -webkit-font-smoothing:antialiased;
}

/* ── OUTER CARD ── */
.card{
  width:289mm;height:202mm;
  background:#ffffff;
  border:0.5px solid #C0C0C0;
  border-radius:2px;
  overflow:hidden;
  display:flex;flex-direction:row;
  -webkit-print-color-adjust:exact;
  print-color-adjust:exact;
}

/* ── LEFT SIDEBAR SPINE ── */
.sidebar{
  width:44px;
  background:${DARK};
  flex-shrink:0;
  position:relative;
  overflow:hidden;
  display:flex;flex-direction:column;align-items:center;
}
.sb-stripes{
  position:absolute;top:0;left:0;width:100%;height:100%;
}
.sb-bottom{
  position:absolute;bottom:0;left:0;right:0;
  display:flex;flex-direction:column;align-items:center;
  padding-bottom:12px;z-index:2;gap:6px;
}
.sb-wordmark{
  writing-mode:vertical-rl;transform:rotate(180deg);
  font-size:8px;font-weight:700;color:${MINT};
  letter-spacing:3px;opacity:0.75;
}

/* ── MAIN COLUMN ── */
.main{flex:1;display:flex;flex-direction:column;overflow:hidden;}

/* ── HEADER BAND ── */
.hdr{
  background:${DARK};
  padding:12px 22px 10px;
  display:flex;align-items:center;justify-content:space-between;
  flex-shrink:0;
}
.hdr-l{display:flex;align-items:center;gap:9px;}
.hdr-wordmark{font-size:13px;font-weight:700;color:${MINT};letter-spacing:1.5px;}
.hdr-sub{font-size:7px;color:rgba(255,255,255,0.32);letter-spacing:2px;text-transform:uppercase;margin-top:2px;}
.hdr-r{text-align:right;}
.hdr-lbl{font-size:6.5px;color:rgba(255,255,255,0.38);letter-spacing:2px;text-transform:uppercase;margin-bottom:2px;}
.hdr-type{font-size:11px;font-weight:600;color:rgba(255,255,255,0.9);}
.hdr-date{font-size:8px;color:${MINT};margin-top:3px;font-weight:500;}

/* ── BODY: two columns ── */
.body{
  flex:1;
  display:flex;flex-direction:row;
  overflow:hidden;
  min-height:0;
}

/* LEFT CONTENT COLUMN */
.col-left{
  flex:1;
  padding:18px 20px 0 20px;
  display:flex;flex-direction:column;
  position:relative;overflow:hidden;
}
.wm{
  position:absolute;right:-28px;bottom:-28px;
  opacity:0.03;pointer-events:none;
}

/* RIGHT DARK PANEL */
.col-right{
  width:136px;flex-shrink:0;
  background:${DARK};
  position:relative;overflow:hidden;
  display:flex;flex-direction:column;
  justify-content:center;
  padding:18px 14px;
  gap:0;
}
.rp-stripes{
  position:absolute;top:0;left:0;width:100%;height:100%;
}
.rp-items{
  position:relative;z-index:2;
  display:flex;flex-direction:column;
  gap:0;
}
.rp-item{
  padding:12px 0;
  border-bottom:0.5px solid rgba(255,255,255,0.1);
}
.rp-item:last-child{border-bottom:none;}
.rp-lbl{font-size:7px;color:rgba(255,255,255,0.42);letter-spacing:1.5px;text-transform:uppercase;margin-bottom:4px;}
.rp-val{font-size:11px;font-weight:600;color:${MINT};line-height:1.3;}
.rp-val-sm{font-size:8.5px;font-weight:600;color:${MINT};line-height:1.3;word-break:break-all;}

/* CONTENT ELEMENTS */
.certify-lbl{font-size:9px;color:#AAAAAA;letter-spacing:1.5px;text-transform:uppercase;margin-bottom:4px;}
.recipient{font-size:27px;font-weight:600;color:#0B1F1A;line-height:1.1;margin-bottom:3px;word-break:break-word;}
.succeed{font-size:11px;color:#888;margin-bottom:12px;}

.quiz-block{
  border-left:3px solid ${MINT};
  padding:8px 12px;
  background:${MINT_BG};
  border-radius:0 3px 3px 0;
  margin-bottom:12px;
}
.quiz-cat{font-size:7.5px;font-weight:600;color:${MINT_DARK};letter-spacing:1.5px;text-transform:uppercase;margin-bottom:3px;}
.quiz-title{font-size:13px;font-weight:600;color:#0B1F1A;line-height:1.3;}

.tags{display:flex;flex-wrap:wrap;gap:5px;margin-bottom:12px;}
.tag{
  font-size:9px;color:${MINT_DARK};
  background:${MINT_BG};border:0.5px solid ${MINT_BORDER};
  border-radius:20px;padding:3px 10px;
}

.stats{display:flex;align-items:center;gap:0;margin-bottom:0;}
.stat{padding:0 16px 0 0;margin-right:16px;border-right:0.5px solid #E8E8E8;}
.stat:last-child{border-right:none;margin-right:0;}
.stat-val{font-size:22px;font-weight:700;color:${MINT};line-height:1;margin-bottom:3px;}
.stat-val-sm{font-size:12px;font-weight:700;color:${MINT};line-height:1;margin-bottom:3px;padding-top:4px;}
.stat-lbl{font-size:8px;color:#AAAAAA;letter-spacing:0.8px;text-transform:uppercase;}

/* FOOTER */
.footer{
  border-top:0.5px solid #EBEBEB;
  padding:10px 20px 10px 20px;
  display:flex;align-items:flex-end;justify-content:space-between;
  flex-shrink:0;
}
.sig-rule{width:120px;height:0.5px;background:#CCCCCC;margin-bottom:4px;}
.sig-name{font-size:9.5px;font-weight:600;color:#1a1a2e;margin-bottom:1px;}
.sig-role{font-size:8.5px;color:#888;}

/* CREDENTIAL STRIP */
.cstrip{
  background:#F5F5F5;border-top:0.5px solid #E8E8E8;
  padding:6px 20px;
  display:flex;align-items:center;justify-content:space-between;
  flex-shrink:0;
}
.cstrip-id{font-size:7px;color:#BBBBBB;letter-spacing:0.3px;}
.cstrip-verify{font-size:7px;color:${MINT_DARK};font-weight:500;}
</style>
</head>
<body>
<div class="card">

  <!-- LEFT SIDEBAR SPINE -->
  <div class="sidebar">
    <svg class="sb-stripes" viewBox="0 0 44 700" fill="none" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMin slice">
      ${stripeRows}
    </svg>
    <div class="sb-bottom">
      <span class="sb-wordmark">${abbrev}</span>
      ${logoMark(MINT, 18, 18)}
    </div>
  </div>

  <!-- MAIN -->
  <div class="main">

    <!-- HEADER -->
    <div class="hdr">
      <div class="hdr-l">
        ${logoMark(MINT, 26, 26)}
        <div>
          <div class="hdr-wordmark">${abbrev}</div>
          <div class="hdr-sub">${series}</div>
        </div>
      </div>
      <div class="hdr-r">
        <div class="hdr-lbl">Official Document</div>
        <div class="hdr-type">Certificate of Completion</div>
        <div class="hdr-date">${dateLong}</div>
      </div>
    </div>

    <!-- BODY: left content + right dark panel -->
    <div class="body">

      <!-- LEFT CONTENT -->
      <div class="col-left">
        <div class="wm">${watermark}</div>

        <p class="certify-lbl">This is to certify that</p>
        <p class="recipient">${recipientName}</p>
        <p class="succeed">has successfully completed the assessment</p>

        <div class="quiz-block">
          ${categoryLabel ? `<div class="quiz-cat">${categoryLabel}</div>` : ""}
          <div class="quiz-title">${moduleTitle}</div>
        </div>

        <div class="tags">
          ${tagHtml}
        </div>

        ${(scoreDisplay || pctDisplay || gradeLabel) ? `
        <div class="stats">
          ${scoreDisplay ? `<div class="stat"><div class="stat-val">${scoreDisplay}</div><div class="stat-lbl">Score</div></div>` : ""}
          ${pctDisplay  ? `<div class="stat"><div class="stat-val">${pctDisplay}%</div><div class="stat-lbl">Grade</div></div>` : ""}
          ${gradeLabel  ? `<div class="stat"><div class="stat-val-sm">${esc(gradeLabel).toUpperCase()}</div><div class="stat-lbl">Achievement</div></div>` : ""}
        </div>` : ""}

      </div><!-- /col-left -->

      <!-- RIGHT DARK PANEL -->
      <div class="col-right">
        <svg class="rp-stripes" viewBox="0 0 136 700" fill="none" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMin slice">
          ${rightStripeRows}
        </svg>
        <div class="rp-items">
          <div class="rp-item">
            <div class="rp-lbl">Organisation</div>
            <div class="rp-val">${orgLabel}</div>
          </div>
          <div class="rp-item">
            <div class="rp-lbl">Issued by</div>
            <div class="rp-val">${abbrev}</div>
          </div>
          <div class="rp-item">
            <div class="rp-lbl">Date issued</div>
            <div class="rp-val" style="font-size:9.5px;">${dateLong}</div>
          </div>
          <div class="rp-item">
            <div class="rp-lbl">Credential ID</div>
            <div class="rp-val-sm">${credId}</div>
          </div>
        </div>
      </div><!-- /col-right -->

    </div><!-- /body -->

    <!-- FOOTER -->
    <div class="footer">
      <div>
        ${signatureSvg}
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