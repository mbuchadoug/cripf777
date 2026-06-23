/**
 * certificateTemplate.js — CRIPFCNT Option A
 * A4 LANDSCAPE (297 × 210 mm)
 *
 * GAP FIX: .col-left uses justify-content:space-between with three explicit
 * zones (top / middle / bottom) so the full column height is always consumed.
 * .body is NOT flex:1 — it has an explicit calculated height so Puppeteer
 * cannot stretch it beyond content.
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

  let gradeLabel = "";
  if (percentage != null) {
    const p = Number(percentage);
    if      (p >= 90) gradeLabel = "Distinction";
    else if (p >= 75) gradeLabel = "Merit";
    else if (p >= 50) gradeLabel = "Pass";
  }

  /* brand */
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
    DARK="#062A5E"; MINT="#C9A227"; MINT_DARK="#7A5F0A"; MINT_BG="#FBF3DA"; MINT_BORDER="#E8CC7E";
    abbrev="NGT"; series="Nyaradzo Group Training";
  }
  if (/winchester/.test(orgLow)) {
    DARK="#1F3C88"; MINT="#E8C95A"; MINT_DARK="#7A5F0A"; MINT_BG="#FBF5DA"; MINT_BORDER="#E8CC7E";
    abbrev="WS"; series="Winchester School";
  }
  if (/st[\s-]?eurit|eurit/.test(orgLow)) {
    DARK="#111111"; MINT="#D4AF37"; MINT_DARK="#7A5F0A"; MINT_BG="#FBF5DA"; MINT_BORDER="#E8CC7E";
    abbrev="SEIS"; series="St Eurit International School";
  }

  const credId = `${abbrev}-${dateStr.replace(/-/g,"")}-${(name||"X").replace(/\s+/g,"").toUpperCase().slice(0,6).padEnd(6,"0")}`;

  const tagSources = [quizTitle||null, moduleName||null].filter(Boolean);
  const tags = [...new Set(tagSources)].slice(0, 3);
  const tagHtml = tags.map(t => `<span class="tag">${esc(t)}</span>`).join("\n            ");

  const logoMark = (color, w, h) =>
    `<svg width="${w}" height="${h}" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M20 10 L20 90 Q20 90 50 90 Q80 90 80 60 L80 52 L54 52 L54 70 Q54 74 50 74 Q46 74 46 70 L46 30 Q46 26 50 26 Q54 26 54 30 L54 48 L80 48 L80 40 Q80 10 50 10 Z" fill="${color}"/>
    </svg>`;

  /* Sidebar chevron stripes — right-pointing, matches stripes.png */
  const sidebarStripes = Array.from({length:50},(_,i)=>{
    const y = 4 + i*14;
    return `<polyline points="2,${y} 22,${y+9} 42,${y}" stroke="${MINT}" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" opacity="0.18"/>`;
  }).join("");

  /* Right panel chevron stripes — wider */
  const panelStripes = Array.from({length:50},(_,i)=>{
    const y = 4 + i*14;
    return `<polyline points="0,${y} 68,${y+22} 136,${y}" stroke="${MINT}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" opacity="0.09"/>`;
  }).join("");

  /* Director signature SVG */
  const signatureSvg = `<svg width="128" height="42" viewBox="0 0 128 42" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M5 30 C9 19 15 12 23 14 C29 16 31 23 27 29 C23 35 17 34 15 30 C13 26 19 20 27 24 C35 28 41 22 47 16" stroke="#1a1a2e" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
    <path d="M47 16 C53 10 57 12 59 18 C61 24 57 30 53 28 C49 26 51 20 57 22 C65 25 71 18 77 14" stroke="#1a1a2e" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
    <path d="M77 14 C83 10 87 14 85 22 C83 28 79 32 81 36 C83 39 89 37 93 33" stroke="#1a1a2e" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
    <path d="M93 33 C97 29 103 26 107 30 C111 34 107 39 103 37 C99 35 102 29 108 28 C116 26 121 32 125 35" stroke="#1a1a2e" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
  </svg>`;

  /* Completion badge */
  const badge = `<svg width="52" height="52" viewBox="0 0 60 60" fill="none" xmlns="http://www.w3.org/2000/svg">
    <circle cx="30" cy="30" r="28" stroke="${MINT}" stroke-width="1.8" fill="none"/>
    <circle cx="30" cy="30" r="22" stroke="${MINT}" stroke-width="0.8" stroke-dasharray="3 2" fill="none" opacity="0.4"/>
    <path d="M19 30 L26 37 L41 22" stroke="${MINT}" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"/>
    <text x="30" y="53" font-family="'Inter',Arial,sans-serif" font-size="5.5" font-weight="600" fill="${MINT}" text-anchor="middle" letter-spacing="1">CERTIFIED</text>
  </svg>`;

  /* Watermark */
  const watermark = `<svg width="200" height="200" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg">
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
  width:297mm;height:210mm;
  overflow:hidden;
  background:#D4D4D4;
  display:flex;align-items:center;justify-content:center;
  font-family:'Inter',Arial,sans-serif;
  -webkit-font-smoothing:antialiased;
}

/* ── CARD: fills the page exactly ── */
.card{
  width:297mm;
  height:210mm;
  background:#fff;
  overflow:hidden;
  display:flex;
  flex-direction:row;
  -webkit-print-color-adjust:exact;
  print-color-adjust:exact;
}

/* ── SIDEBAR ── */
.sidebar{
  width:44px;
  background:${DARK};
  flex-shrink:0;
  position:relative;
  overflow:hidden;
}
.sb-stripes{position:absolute;top:0;left:0;width:100%;height:100%;}
.sb-foot{
  position:absolute;bottom:0;left:0;right:0;
  display:flex;flex-direction:column;align-items:center;
  padding-bottom:10px;gap:5px;z-index:2;
}
.sb-word{
  writing-mode:vertical-rl;transform:rotate(180deg);
  font-size:7.5px;font-weight:700;color:${MINT};
  letter-spacing:3px;opacity:0.75;
}

/* ── MAIN ── */
.main{
  flex:1;
  display:flex;
  flex-direction:column;
  /* explicit height so flex children obey their sizes */
  height:210mm;
}

/* ── HEADER: fixed height ── */
.hdr{
  height:48px;
  flex-shrink:0;
  background:${DARK};
  padding:0 22px;
  display:flex;align-items:center;justify-content:space-between;
}
.hdr-l{display:flex;align-items:center;gap:9px;}
.hdr-wm{font-size:13px;font-weight:700;color:${MINT};letter-spacing:1.5px;}
.hdr-sub{font-size:6.5px;color:rgba(255,255,255,0.3);letter-spacing:2px;text-transform:uppercase;margin-top:2px;}
.hdr-r{text-align:right;}
.hdr-lbl{font-size:6px;color:rgba(255,255,255,0.35);letter-spacing:2px;text-transform:uppercase;margin-bottom:2px;}
.hdr-type{font-size:10.5px;font-weight:600;color:rgba(255,255,255,0.9);}
.hdr-date{font-size:7.5px;color:${MINT};margin-top:2px;font-weight:500;}

/* ── FOOTER: fixed height ── */
.footer{
  height:60px;
  flex-shrink:0;
  border-top:0.5px solid #E8E8E8;
  padding:0 22px;
  display:flex;align-items:center;justify-content:space-between;
}
.sig-rule{width:115px;height:0.5px;background:#CCCCCC;margin-bottom:4px;}
.sig-name{font-size:9px;font-weight:600;color:#1a1a2e;margin-bottom:1px;}
.sig-role{font-size:8px;color:#888;}

/* ── CSTRIP: fixed height ── */
.cstrip{
  height:24px;
  flex-shrink:0;
  background:#F5F5F5;
  border-top:0.5px solid #E8E8E8;
  padding:0 22px;
  display:flex;align-items:center;justify-content:space-between;
}
.cstrip-id{font-size:7px;color:#BBBBBB;letter-spacing:0.3px;}
.cstrip-verify{font-size:7px;color:${MINT_DARK};font-weight:500;}

/* ── BODY ROW: fills remaining space exactly ── */
/* 210mm total − 48px hdr − 60px footer − 24px cstrip = remaining */
/* We let flex do it: footer+cstrip are fixed, body gets the rest */
.body{
  flex:1;
  min-height:0;
  display:flex;
  flex-direction:row;
  overflow:hidden;
}

/* ── LEFT CONTENT COLUMN ──
   THE KEY FIX: justify-content:space-between with three hard zones.
   Top zone, middle zone, bottom zone — no dead flex space possible.
── */
.col-left{
  flex:1;
  min-width:0;
  padding:16px 22px 14px 20px;
  display:flex;
  flex-direction:column;
  justify-content:space-between;  /* ← distributes 3 zones to fill height */
  position:relative;
  overflow:hidden;
}
.wm{
  position:absolute;right:-20px;bottom:-20px;
  opacity:0.03;pointer-events:none;
}

/* Zone 1 — who */
.zone-top{}
.certify-lbl{font-size:8.5px;color:#AAAAAA;letter-spacing:1.5px;text-transform:uppercase;margin-bottom:4px;}
.recipient{font-size:26px;font-weight:600;color:#0B1F1A;line-height:1.1;margin-bottom:3px;word-break:break-word;}
.succeed{font-size:10.5px;color:#888;}

/* Zone 2 — what */
.zone-mid{}
.quiz-block{
  border-left:3px solid ${MINT};
  padding:8px 12px;
  background:${MINT_BG};
  border-radius:0 3px 3px 0;
  margin-bottom:10px;
}
.quiz-cat{font-size:7px;font-weight:600;color:${MINT_DARK};letter-spacing:1.5px;text-transform:uppercase;margin-bottom:3px;}
.quiz-title{font-size:13px;font-weight:600;color:#0B1F1A;line-height:1.25;}
.tags{display:flex;flex-wrap:wrap;gap:5px;}
.tag{font-size:9px;color:${MINT_DARK};background:${MINT_BG};border:0.5px solid ${MINT_BORDER};border-radius:20px;padding:3px 10px;}

/* Zone 3 — results */
.zone-bot{}
.divider-line{height:0.5px;background:#E8E8E8;margin-bottom:10px;}
.stats{display:flex;align-items:flex-end;gap:0;}
.stat{padding:0 18px 0 0;margin-right:18px;border-right:0.5px solid #E8E8E8;}
.stat:last-child{border-right:none;margin-right:0;padding-right:0;}
.stat-val{font-size:24px;font-weight:700;color:${MINT};line-height:1;margin-bottom:3px;}
.stat-val-sm{font-size:13px;font-weight:700;color:${MINT};line-height:1;margin-bottom:3px;padding-top:5px;}
.stat-lbl{font-size:7.5px;color:#AAAAAA;letter-spacing:0.8px;text-transform:uppercase;}

/* ── RIGHT DARK PANEL ── */
.col-right{
  width:132px;
  flex-shrink:0;
  background:${DARK};
  position:relative;
  overflow:hidden;
  display:flex;
  flex-direction:column;
  justify-content:center;
  padding:0 14px;
}
.rp-stripes{position:absolute;top:0;left:0;width:100%;height:100%;}
.rp-inner{position:relative;z-index:2;}
.rp-item{padding:11px 0;border-bottom:0.5px solid rgba(255,255,255,0.1);}
.rp-item:last-child{border-bottom:none;}
.rp-lbl{font-size:6.5px;color:rgba(255,255,255,0.38);letter-spacing:1.5px;text-transform:uppercase;margin-bottom:4px;}
.rp-val{font-size:11px;font-weight:600;color:${MINT};line-height:1.3;}
.rp-val-sm{font-size:8px;font-weight:600;color:${MINT};line-height:1.4;word-break:break-word;}
</style>
</head>
<body>
<div class="card">

  <!-- SIDEBAR -->
  <div class="sidebar">
    <svg class="sb-stripes" viewBox="0 0 44 800" fill="none" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMin slice">
      ${sidebarStripes}
    </svg>
    <div class="sb-foot">
      <span class="sb-word">${abbrev}</span>
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
          <div class="hdr-wm">${abbrev}</div>
          <div class="hdr-sub">${series}</div>
        </div>
      </div>
      <div class="hdr-r">
        <div class="hdr-lbl">Official Document</div>
        <div class="hdr-type">Certificate of Completion</div>
        <div class="hdr-date">${dateLong}</div>
      </div>
    </div>

    <!-- BODY -->
    <div class="body">

      <!-- LEFT: three zones, space-between -->
      <div class="col-left">
        <div class="wm">${watermark}</div>

        <!-- ZONE 1: who -->
        <div class="zone-top">
          <p class="certify-lbl">This is to certify that</p>
          <p class="recipient">${recipientName}</p>
          <p class="succeed">has successfully completed the assessment</p>
        </div>

        <!-- ZONE 2: what -->
        <div class="zone-mid">
          <div class="quiz-block">
            ${categoryLabel ? `<div class="quiz-cat">${categoryLabel}</div>` : ""}
            <div class="quiz-title">${moduleTitle}</div>
          </div>
          <div class="tags">${tagHtml}</div>
        </div>

        <!-- ZONE 3: results -->
        <div class="zone-bot">
          <div class="divider-line"></div>
          ${(scoreDisplay || pctDisplay || gradeLabel) ? `
          <div class="stats">
            ${scoreDisplay ? `<div class="stat"><div class="stat-val">${scoreDisplay}</div><div class="stat-lbl">Score</div></div>` : ""}
            ${pctDisplay  ? `<div class="stat"><div class="stat-val">${pctDisplay}%</div><div class="stat-lbl">Grade</div></div>` : ""}
            ${gradeLabel  ? `<div class="stat"><div class="stat-val-sm">${esc(gradeLabel).toUpperCase()}</div><div class="stat-lbl">Achievement</div></div>` : ""}
          </div>` : ""}
        </div>

      </div><!-- /col-left -->

      <!-- RIGHT DARK PANEL -->
      <div class="col-right">
        <svg class="rp-stripes" viewBox="0 0 136 800" fill="none" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMin slice">
          ${panelStripes}
        </svg>
        <div class="rp-inner">
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
            <div class="rp-val" style="font-size:9px;">${dateLong}</div>
          </div>
          <div class="rp-item">
            <div class="rp-lbl">Credential ID</div>
            <div class="rp-val-sm">${credId}</div>
          </div>
        </div>
      </div>

    </div><!-- /body -->

    <!-- FOOTER -->
    <div class="footer">
      <div>
        ${signatureSvg}
        <div class="sig-rule"></div>
        <div class="sig-name">${esc(sig1Name)}</div>
        <div class="sig-role">${esc(sig1Role)}</div>
      </div>
      ${badge}
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