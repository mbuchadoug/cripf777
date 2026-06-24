/**
 * certificateTemplate.js - CRIPFCNT Final
 *
 * SIZE: A4 landscape (297 × 210 mm)
 *
 * GAP FIX - uses CSS display:table layout instead of flexbox.
 * Table cells stretch to fill row height by definition.
 * No flex quirks, no empty space possible.
 *
 * Layout:
 *   ROW 1 (48px)  : header band - sidebar | logo+wordmark | cert type+date
 *   ROW 2 (auto)  : body       - sidebar | content        | dark right panel
 *   ROW 3 (62px)  : footer     - sidebar | sig+badge      | (dark)
 *   ROW 4 (22px)  : cstrip     - sidebar | cert ID        | verify URL
 *
 * Puppeteer MUST use:
 *   format:"A4", landscape:true, printBackground:true,
 *   margin:{top:"0",bottom:"0",left:"0",right:"0"}
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
  const esc = (s) =>
    s == null ? "" : String(s)
      .replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");

  const dateObj  = date ? new Date(date) : new Date();
  const dateStr  = dateObj.toISOString().slice(0,10);
  const dateLong = dateObj.toLocaleDateString("en-GB",{day:"numeric",month:"long",year:"numeric"});

  const moduleTitle   = esc(quizTitle || moduleName || "Assessment");
  const categoryLabel = (moduleName && quizTitle && moduleName !== quizTitle) ? esc(moduleName) : "";
  const recipientName = esc(name || "Recipient");
  const orgLabel      = esc(orgName || "CRIPFCNT");
  const pctDisplay    = percentage != null ? esc(String(percentage)) : null;
  const scoreDisplay  = score      != null ? esc(String(score))      : null;

  let gradeLabel = "";
  if (percentage != null) {
    const p = Number(percentage);
    if      (p >= 90) gradeLabel = "Distinction";
    else if (p >= 75) gradeLabel = "Merit";
    else if (p >= 50) gradeLabel = "Pass";
  }

  /* brand */
  const orgLow = (orgName||"").toLowerCase();
  let DARK="#0B4F45", MINT="#1DE9B6", MINT_DARK="#0D9B77",
      MINT_BG="#E1F5EE", MINT_BORDER="#9FE1CB",
      abbrev="CRIPFCNT", series="CRIPFCNT Learning &amp; Assessment Platform",
      sig1Name="Donald Mataranyika", sig1Role="Chair, Board of Directors";

  if (/nyaradzo/.test(orgLow))             { DARK="#062A5E"; MINT="#C9A227"; MINT_DARK="#7A5F0A"; MINT_BG="#FBF3DA"; MINT_BORDER="#E8CC7E"; abbrev="NGT";  series="Nyaradzo Group Training"; }
  if (/winchester/.test(orgLow))           { DARK="#1F3C88"; MINT="#E8C95A"; MINT_DARK="#7A5F0A"; MINT_BG="#FBF5DA"; MINT_BORDER="#E8CC7E"; abbrev="WS";   series="Winchester School"; }
  if (/st[\s-]?eurit|eurit/.test(orgLow)) { DARK="#111111"; MINT="#D4AF37"; MINT_DARK="#7A5F0A"; MINT_BG="#FBF5DA"; MINT_BORDER="#E8CC7E"; abbrev="SEIS"; series="St Eurit International School"; }

  const credId = `${abbrev}-${dateStr.replace(/-/g,"")}-${(name||"X").replace(/\s+/g,"").toUpperCase().slice(0,6).padEnd(6,"0")}`;

  const tagSources = [quizTitle||null, moduleName||null].filter(Boolean);
  const tags = [...new Set(tagSources)].slice(0,3);
  const tagHtml = tags.map(t=>`<span class="tag">${esc(t)}</span>`).join(" ");

  const logo = (color,w,h) =>
    `<svg width="${w}" height="${h}" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M20 10 L20 90 Q20 90 50 90 Q80 90 80 60 L80 52 L54 52 L54 70 Q54 74 50 74 Q46 74 46 70 L46 30 Q46 26 50 26 Q54 26 54 30 L54 48 L80 48 L80 40 Q80 10 50 10 Z" fill="${color}"/></svg>`;

  /* sidebar chevron stripes */
  const sbStripes = Array.from({length:60},(_,i)=>{
    const y=4+i*13;
    return `<polyline points="2,${y} 21,${y+9} 40,${y}" stroke="${MINT}" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" opacity="0.18"/>`;
  }).join("");

  /* right panel chevron stripes */
  const rpStripes = Array.from({length:60},(_,i)=>{
    const y=4+i*13;
    return `<polyline points="0,${y} 65,${y+21} 130,${y}" stroke="${MINT}" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" opacity="0.09"/>`;
  }).join("");

  /* signature */
  const sig = `<svg width="124" height="40" viewBox="0 0 128 42" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M5 30 C9 19 15 12 23 14 C29 16 31 23 27 29 C23 35 17 34 15 30 C13 26 19 20 27 24 C35 28 41 22 47 16" stroke="#1a1a2e" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
    <path d="M47 16 C53 10 57 12 59 18 C61 24 57 30 53 28 C49 26 51 20 57 22 C65 25 71 18 77 14" stroke="#1a1a2e" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
    <path d="M77 14 C83 10 87 14 85 22 C83 28 79 32 81 36 C83 39 89 37 93 33" stroke="#1a1a2e" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
    <path d="M93 33 C97 29 103 26 107 30 C111 34 107 39 103 37 C99 35 102 29 108 28 C116 26 121 32 125 35" stroke="#1a1a2e" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
  </svg>`;

  /* badge */
  const badge = `<svg width="50" height="50" viewBox="0 0 60 60" fill="none" xmlns="http://www.w3.org/2000/svg">
    <circle cx="30" cy="30" r="28" stroke="${MINT}" stroke-width="1.8" fill="none"/>
    <circle cx="30" cy="30" r="22" stroke="${MINT}" stroke-width="0.8" stroke-dasharray="3 2" fill="none" opacity="0.4"/>
    <path d="M19 30 L26 37 L41 22" stroke="${MINT}" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"/>
    <text x="30" y="53" font-family="'Inter',Arial,sans-serif" font-size="5.5" font-weight="600" fill="${MINT}" text-anchor="middle" letter-spacing="1">CERTIFIED</text>
  </svg>`;

  /* watermark */
  const wm = `<svg width="190" height="190" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg" style="position:absolute;right:-20px;bottom:-20px;opacity:0.03;pointer-events:none;">
    <path d="M20 10 L20 90 Q20 90 50 90 Q80 90 80 60 L80 52 L54 52 L54 70 Q54 74 50 74 Q46 74 46 70 L46 30 Q46 26 50 26 Q54 26 54 30 L54 48 L80 48 L80 40 Q80 10 50 10 Z" fill="${DARK}"/>
  </svg>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<title>Certificate - ${recipientName}</title>
<style>
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0;}
@page{margin:0;size:A4 landscape;}

html,body{
  width:297mm;height:210mm;
  overflow:hidden;
  background:${DARK};
  font-family:'Inter',Arial,sans-serif;
  -webkit-font-smoothing:antialiased;
}

/* ── TABLE SHELL - fills the entire page, zero gaps possible ── */
.cert{
  width:297mm;
  height:210mm;
  display:table;
  table-layout:fixed;
  border-collapse:collapse;
  -webkit-print-color-adjust:exact;
  print-color-adjust:exact;
}

/* ── ROWS ── */
.r-hdr,.r-body,.r-foot,.r-strip{display:table-row;}

/* fixed-height rows */
.r-hdr  > td{height:48px;}
.r-foot > td{height:62px;}
.r-strip> td{height:22px;}
/* body row: height:auto fills ALL remaining space */

/* ── COLUMN WIDTHS ── */
td{padding:0;vertical-align:top;}
.c-sb  {width:44px;}
.c-main{/* flex:1 equivalent - takes all remaining width */}
.c-rp  {width:132px;}

/* ── SIDEBAR col ── */
.c-sb{background:${DARK};position:relative;overflow:hidden;}
.sb-svg{position:absolute;top:0;left:0;width:44px;height:100%;}
.sb-foot{position:absolute;bottom:0;left:0;right:0;display:flex;flex-direction:column;align-items:center;padding-bottom:10px;gap:5px;z-index:2;}
.sb-word{writing-mode:vertical-rl;transform:rotate(180deg);font-size:7.5px;font-weight:700;color:${MINT};letter-spacing:3px;opacity:0.75;}

/* ── HEADER row ── */
.r-hdr .c-sb{background:${DARK};}
.r-hdr .c-main{background:${DARK};vertical-align:middle;padding:0 20px;}
.r-hdr .c-rp{background:${DARK};vertical-align:middle;padding:0 14px;text-align:right;}
.hdr-logo{display:flex;align-items:center;gap:9px;}
.hdr-wm{font-size:13px;font-weight:700;color:${MINT};letter-spacing:1.5px;}
.hdr-sub{font-size:6.5px;color:rgba(255,255,255,0.3);letter-spacing:2px;text-transform:uppercase;margin-top:2px;}
.hdr-lbl{font-size:6px;color:rgba(255,255,255,0.35);letter-spacing:2px;text-transform:uppercase;margin-bottom:2px;}
.hdr-type{font-size:10.5px;font-weight:600;color:rgba(255,255,255,0.92);}
.hdr-date{font-size:7.5px;color:${MINT};margin-top:3px;font-weight:500;}

/* ── BODY row ── */
.r-body .c-sb{background:${DARK};}
.r-body .c-main{
  background:#fff;
  vertical-align:top;
  padding:20px 22px 16px 20px;
  position:relative;
  overflow:hidden;
}
.r-body .c-rp{
  background:${DARK};
  vertical-align:middle;
  padding:0 14px;
  position:relative;
  overflow:hidden;
}
.rp-svg{position:absolute;top:0;left:0;width:132px;height:100%;}
.rp-inner{position:relative;z-index:2;}
.rp-item{padding:10px 0;border-bottom:0.5px solid rgba(255,255,255,0.1);}
.rp-item:last-child{border-bottom:none;}
.rp-lbl{font-size:6.5px;color:rgba(255,255,255,0.38);letter-spacing:1.5px;text-transform:uppercase;margin-bottom:4px;}
.rp-val{font-size:10.5px;font-weight:600;color:${MINT};line-height:1.3;}
.rp-val-sm{font-size:7.5px;font-weight:600;color:${MINT};line-height:1.4;word-break:break-word;}

/* ── LEFT CONTENT: block stacking only, no flex ── */
.certify-lbl{font-size:8.5px;color:#AAA;letter-spacing:1.5px;text-transform:uppercase;margin-bottom:5px;}
.recipient{font-size:28px;font-weight:600;color:#0B1F1A;line-height:1.1;margin-bottom:3px;word-break:break-word;}
.succeed{font-size:10.5px;color:#888;margin-bottom:16px;}
.quiz-block{border-left:3px solid ${MINT};padding:8px 12px;background:${MINT_BG};border-radius:0 3px 3px 0;margin-bottom:12px;}
.quiz-cat{font-size:7px;font-weight:600;color:${MINT_DARK};letter-spacing:1.5px;text-transform:uppercase;margin-bottom:3px;}
.quiz-title{font-size:13px;font-weight:600;color:#0B1F1A;line-height:1.25;}
.tags{display:flex;flex-wrap:wrap;gap:5px;margin-bottom:16px;}
.tag{font-size:9px;color:${MINT_DARK};background:${MINT_BG};border:0.5px solid ${MINT_BORDER};border-radius:20px;padding:3px 10px;}
.divider{height:0.5px;background:#E8E8E8;margin-bottom:13px;}
.stats{display:flex;align-items:flex-end;gap:0;}
.stat{padding-right:18px;margin-right:18px;border-right:0.5px solid #E0E0E0;}
.stat:last-child{border-right:none;padding-right:0;margin-right:0;}
.stat-val{font-size:24px;font-weight:700;color:${MINT};line-height:1;margin-bottom:3px;}
.stat-val-sm{font-size:13px;font-weight:700;color:${MINT};line-height:1;margin-bottom:3px;padding-top:5px;}
.stat-lbl{font-size:7.5px;color:#AAA;letter-spacing:0.8px;text-transform:uppercase;}

/* ── FOOTER row ── */
.r-foot .c-sb{background:${DARK};}
.r-foot .c-main{background:#fff;vertical-align:middle;padding:0 22px 0 20px;border-top:0.5px solid #E8E8E8;}
.r-foot .c-rp{background:${DARK};}
.foot-inner{display:flex;align-items:center;justify-content:space-between;}
.sig-rule{width:115px;height:0.5px;background:#CCC;margin-bottom:4px;}
.sig-name{font-size:9px;font-weight:600;color:#1a1a2e;margin-bottom:1px;}
.sig-role{font-size:8px;color:#888;}

/* ── STRIP row ── */
.r-strip .c-sb{background:${DARK};}
.r-strip .c-main{background:#F5F5F5;vertical-align:middle;padding:0 20px;border-top:0.5px solid #E8E8E8;}
.r-strip .c-rp{background:#F5F5F5;vertical-align:middle;padding:0 14px;text-align:right;border-top:0.5px solid #E8E8E8;}
.strip-id{font-size:6.5px;color:#BBB;letter-spacing:0.3px;}
.strip-verify{font-size:6.5px;color:${MINT_DARK};font-weight:500;}
</style>
</head>
<body>
<table class="cert">

  <!-- ROW 1: HEADER -->
  <tr class="r-hdr">
    <td class="c-sb"></td>
    <td class="c-main">
      <div class="hdr-logo">
        ${logo(MINT,26,26)}
        <div>
          <div class="hdr-wm">${abbrev}</div>
          <div class="hdr-sub">${series}</div>
        </div>
      </div>
    </td>
    <td class="c-rp">
      <div class="hdr-lbl">Official Document</div>
      <div class="hdr-type">Certificate of Completion</div>
      <div class="hdr-date">${dateLong}</div>
    </td>
  </tr>

  <!-- ROW 2: BODY -->
  <tr class="r-body">

    <!-- sidebar -->
    <td class="c-sb">
      <svg class="sb-svg" viewBox="0 0 44 800" fill="none" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMin slice">
        ${sbStripes}
      </svg>
      <div class="sb-foot">
        <span class="sb-word">${abbrev}</span>
        ${logo(MINT,18,18)}
      </div>
    </td>

    <!-- left content - pure block stacking -->
    <td class="c-main">
      ${wm}
      <p class="certify-lbl">This is to certify that</p>
      <p class="recipient">${recipientName}</p>
      <p class="succeed">has successfully completed the assessment</p>
      <div class="quiz-block">
        ${categoryLabel ? `<div class="quiz-cat">${categoryLabel}</div>` : ""}
        <div class="quiz-title">${moduleTitle}</div>
      </div>
      <div class="tags">${tagHtml}</div>
      <div class="divider"></div>
      ${(scoreDisplay||pctDisplay||gradeLabel) ? `
      <div class="stats">
        ${scoreDisplay ? `<div class="stat"><div class="stat-val">${scoreDisplay}</div><div class="stat-lbl">Score</div></div>` : ""}
        ${pctDisplay  ? `<div class="stat"><div class="stat-val">${pctDisplay}%</div><div class="stat-lbl">Grade</div></div>` : ""}
        ${gradeLabel  ? `<div class="stat"><div class="stat-val-sm">${esc(gradeLabel).toUpperCase()}</div><div class="stat-lbl">Achievement</div></div>` : ""}
      </div>` : ""}
    </td>

    <!-- right dark panel -->
    <td class="c-rp">
      <svg class="rp-svg" viewBox="0 0 132 800" fill="none" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMin slice">
        ${rpStripes}
      </svg>
      <div class="rp-inner">
        <div class="rp-item"><div class="rp-lbl">Organisation</div><div class="rp-val">${orgLabel}</div></div>
        <div class="rp-item"><div class="rp-lbl">Issued by</div><div class="rp-val">${abbrev}</div></div>
        <div class="rp-item"><div class="rp-lbl">Date issued</div><div class="rp-val" style="font-size:9px;">${dateLong}</div></div>
        <div class="rp-item"><div class="rp-lbl">Credential ID</div><div class="rp-val-sm">${credId}</div></div>
      </div>
    </td>

  </tr>

  <!-- ROW 3: FOOTER -->
  <tr class="r-foot">
    <td class="c-sb"></td>
    <td class="c-main">
      <div class="foot-inner">
        <div>
          ${sig}
          <div class="sig-rule"></div>
          <div class="sig-name">${esc(sig1Name)}</div>
          <div class="sig-role">${esc(sig1Role)}</div>
        </div>
        ${badge}
      </div>
    </td>
    <td class="c-rp"></td>
  </tr>

  <!-- ROW 4: CREDENTIAL STRIP -->
  <tr class="r-strip">
    <td class="c-sb"></td>
    <td class="c-main"><span class="strip-id">Certificate ID: ${credId} &nbsp;·&nbsp; ${series}</span></td>
    <td class="c-rp"><span class="strip-verify">cripfcnt.com/verify</span></td>
  </tr>

</table>
</body>
</html>`;
}