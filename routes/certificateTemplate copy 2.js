/**
 * certificateTemplate.js
 * ──────────────────────────────────────────────────────────────────────────────
 * PMP-INSPIRED corporate international standard certificate.
 *
 * Design based directly on the PMP (Project Management Professional) certificate:
 *  ✅ Clean cream/white background - NOT dark background
 *  ✅ Dark institution header band at top
 *  ✅ "THIS IS TO CERTIFY THAT" eyebrow small-caps
 *  ✅ Large italic recipient name as the visual centrepiece
 *  ✅ Tracked-caps achievement body paragraph
 *  ✅ Bold qualification designation in dark box
 *  ✅ "IN TESTIMONY WHEREOF" statement above signatures
 *  ✅ Two signature blocks flanking official seal, bottom-aligned
 *  ✅ Credential reference strip at very bottom
 *
 * Elevated over PMP baseline:
 *  + Richer double-rule gold border with corner filigree
 *  + Cinzel + Cormorant Garamond luxury editorial font pair
 *  + SVG guild seal (multi-ring, arc text, radiating lines, star)
 *  + Org-branded colour theming
 *  + Grade badge (Distinction / Merit / Pass)
 *  + Print-safe colour rendering
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

  const moduleTitle   = esc(quizTitle || moduleName || "Module");
  const recipientName = esc(name || "Recipient");
  const pctDisplay    = percentage != null ? esc(String(percentage)) : null;
  const scoreDisplay  = score      != null ? esc(String(score))      : null;

  /* Grade label */
  let gradeLabel = "";
  if (percentage != null) {
    const p = Number(percentage);
    if      (p >= 90) gradeLabel = "With Distinction";
    else if (p >= 75) gradeLabel = "With Merit";
    else if (p >= 50) gradeLabel = "Pass";
  }

  /* ── brand ── */
  const orgLow = (orgName || "").toLowerCase();
  let B = {
    primary:    "#0A1628",
    accent:     "#B8943A",
    accent2:    "#D4AA50",
    accentPale: "#F5EDD6",
    cream:      "#FDFAF2",
    text:       "#1A1A2E",
    subtext:    "#6B5B35",
    series:     "CRIPFCnt Learning Management System",
    abbrev:     "CRIPFCNT",
    displayName:"CRIPFCnt",
    sig1Name:   "Donald Mataranyika",
    sig1Role:   "Chair, Board of Directors",
    sig1Script: "Donald",
    sig2Name:   "Chief Academic Officer",
    sig2Role:   "Director of Learning",
    sig2Script: "Academic",
  };
  if (/nyaradzo/.test(orgLow))     B = { ...B, primary:"#062A5E", accent:"#C9A227", accent2:"#DDB84A", series:"Nyaradzo Group Training",        abbrev:"NGT",  displayName:"Nyaradzo" };
  if (/winchester/.test(orgLow))   B = { ...B, primary:"#1F3C88", accent:"#8B1E2D", accent2:"#A83040", series:"Winchester School",               abbrev:"WS",   displayName:"Winchester" };
  if (/st[\s-]?eurit|eurit/.test(orgLow)) B = { ...B, primary:"#111111", accent:"#D4AF37", accent2:"#E8C95A", series:"St Eurit International School", abbrev:"SEIS", displayName:"St Eurit" };

  /* ── Credential ID ── */
  const credId = `${B.abbrev}-${dateStr.replace(/-/g,"")}-${(name||"X").replace(/\s+/g,"").toUpperCase().slice(0,6).padEnd(6,"0")}`;

  /* ── SVG Seal (PMP-inspired: solid ring, radiating lines, star, arc text) ── */
  const rays = Array.from({length:24},(_,i)=>{
    const a=(i*15)*Math.PI/180, x1=70+49*Math.cos(a), y1=70+49*Math.sin(a), x2=70+59*Math.cos(a), y2=70+59*Math.sin(a);
    return `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="${B.accent2}" stroke-width="0.9" opacity="0.65"/>`;
  }).join("");

  const seal = `<svg viewBox="0 0 140 140" fill="none" xmlns="http://www.w3.org/2000/svg">
    <circle cx="70" cy="70" r="68" fill="${B.primary}" stroke="${B.accent}" stroke-width="2.5"/>
    <circle cx="70" cy="70" r="61" fill="none" stroke="${B.accent2}" stroke-width="1"/>
    <circle cx="70" cy="70" r="55" fill="none" stroke="${B.accent}" stroke-width="0.6" stroke-dasharray="4 3"/>
    ${rays}
    <path d="M70 26 L74.8 41.8 L91.5 41.8 L78.4 51.4 L83.2 67.2 L70 57.6 L56.8 67.2 L61.6 51.4 L48.5 41.8 L65.2 41.8 Z" fill="${B.accent2}" opacity="0.95"/>
    <path d="M70 33 L73.5 44.2 L85.5 44.2 L76.3 50.8 L79.8 62 L70 55.4 L60.2 62 L63.7 50.8 L54.5 44.2 L66.5 44.2 Z" fill="${B.accent}" opacity="0.35"/>
    <path id="arc-t" d="M13,70 a57,57 0 0,1 114,0" fill="none"/>
    <path id="arc-b" d="M15,72 a55,55 0 0,0 110,0" fill="none"/>
    <text font-family="'Cinzel',serif" font-size="9.5" font-weight="700" fill="${B.accent2}" letter-spacing="3.5"><textPath href="#arc-t" startOffset="50%" text-anchor="middle">${B.abbrev}</textPath></text>
    <text font-family="'Cinzel',serif" font-size="7" fill="${B.accent}" letter-spacing="2"><textPath href="#arc-b" startOffset="50%" text-anchor="middle">VERIFIED · OFFICIAL RECORD</textPath></text>
    <circle cx="70" cy="127" r="3.5" fill="${B.accent}" opacity="0.85"/>
  </svg>`;

  /* ── Corner filigree ── */
  const corner = `<svg viewBox="0 0 72 72" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M3 69V9.5C3 6 6 3 9.5 3H69" stroke="${B.accent}" stroke-width="2.2"/>
    <path d="M3 48V9.5C3 6 6 3 9.5 3H48" stroke="${B.accent2}" stroke-width="0.9"/>
    <path d="M3 30V9.5C3 6 6 3 9.5 3H30" stroke="${B.accent}" stroke-width="0.4" opacity="0.45"/>
    <circle cx="9.5" cy="9.5" r="4.2" fill="${B.accent}"/>
    <circle cx="3" cy="3" r="2.6" fill="${B.accent2}"/>
    <path d="M20 3H27M3 20V27" stroke="${B.accent}" stroke-width="1.2"/>
    <path d="M9 3H13M3 9V13" stroke="${B.accent2}" stroke-width="0.65"/>
    <path d="M34 3L37 6L34 9L31 6Z" fill="${B.accent}" opacity="0.6"/>
  </svg>`;

  /* ── Star divider ── */
  const star = `<svg width="20" height="20" viewBox="0 0 22 22" fill="none"><path d="M11 1.5l2.2 6.8H21l-5.8 4.2 2.2 6.8L11 15l-6.4 4.3 2.2-6.8L0.8 8.3H8.8Z" fill="${B.accent}"/></svg>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<title>Certificate - ${recipientName}</title>
<style>
@import url('https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,300;0,400;0,500;0,600;0,700;1,300;1,400;1,600;1,700&family=Cinzel:wght@400;500;600;700&display=swap');

*,*::before,*::after{box-sizing:border-box;margin:0;padding:0;}
@page{margin:0;size:A4 portrait;}

html,body{
  width:210mm;height:297mm;overflow:hidden;
  background:${B.primary};
  display:flex;align-items:center;justify-content:center;
  font-family:'Cormorant Garamond',Georgia,serif;
  -webkit-font-smoothing:antialiased;
}

/* ── FRAMES ── */
.fo{width:196mm;height:283mm;background:${B.cream};padding:6px;position:relative;-webkit-print-color-adjust:exact;print-color-adjust:exact;}
.fb1{width:100%;height:100%;border:2.8px solid ${B.accent};padding:5px;position:relative;display:flex;}
.fb2{flex:1;border:1px solid ${B.accent};position:relative;overflow:hidden;display:flex;flex-direction:column;background:${B.cream};}

/* ── CORNERS ── */
.co{position:absolute;width:72px;height:72px;z-index:3;}
.co.tl{top:-3px;left:-3px;}
.co.tr{top:-3px;right:-3px;transform:scaleX(-1);}
.co.bl{bottom:-3px;left:-3px;transform:scaleY(-1);}
.co.br{bottom:-3px;right:-3px;transform:scale(-1,-1);}

/* ── WATERMARK ── */
.wm{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%) rotate(-28deg);font-family:'Cinzel',serif;font-size:86px;font-weight:700;color:${B.accent};opacity:0.033;white-space:nowrap;letter-spacing:14px;pointer-events:none;z-index:0;-webkit-print-color-adjust:exact;print-color-adjust:exact;}

/* ── TOP INSTITUTION BAND ── */
.top-band{
  background:${B.primary};
  height:48px;padding:0 50px;
  display:flex;align-items:center;justify-content:space-between;
  position:relative;z-index:2;flex-shrink:0;
  -webkit-print-color-adjust:exact;print-color-adjust:exact;
}
.top-band::after{content:'';position:absolute;bottom:0;left:0;right:0;height:2.5px;background:linear-gradient(90deg,transparent,${B.accent} 15%,${B.accent2} 50%,${B.accent} 85%,transparent);}
.tb-left{display:flex;flex-direction:column;gap:2px;}
.tb-name{font-family:'Cinzel',serif;font-size:12px;font-weight:700;letter-spacing:5px;color:${B.accent2};text-transform:uppercase;}
.tb-sub{font-family:'Cinzel',serif;font-size:6.5px;letter-spacing:3px;color:rgba(255,255,255,0.4);text-transform:uppercase;}
.tb-right{font-family:'Cinzel',serif;font-size:7px;letter-spacing:2.5px;color:rgba(255,255,255,0.4);text-transform:uppercase;}

/* ── BODY ── */
.body{flex:1;display:flex;flex-direction:column;align-items:center;padding:26px 52px 8px;position:relative;z-index:1;text-align:center;}

/* ── EYEBROW (PMP: "THIS IS TO CERTIFY THAT") ── */
.eyebrow{font-family:'Cinzel',serif;font-size:8.5px;font-weight:500;letter-spacing:5px;color:${B.subtext};text-transform:uppercase;margin-bottom:10px;}

/* ── RECIPIENT - centrepiece ── */
.recipient{font-family:'Cormorant Garamond',serif;font-size:54px;font-weight:600;font-style:italic;color:${B.text};line-height:1.05;letter-spacing:0.5px;margin-bottom:14px;max-width:450px;word-break:break-word;}

/* ── ACHIEVEMENT TEXT (PMP tracked caps paragraph) ── */
.achieve{font-family:'Cormorant Garamond',serif;font-size:11.5px;color:${B.subtext};letter-spacing:1.6px;text-transform:uppercase;line-height:1.9;max-width:380px;margin-bottom:14px;}

/* ── DIVIDER ── */
.div-row{display:flex;align-items:center;gap:10px;width:280px;margin-bottom:14px;}
.div-ln{flex:1;height:1px;background:linear-gradient(90deg,transparent,${B.accent} 35%,${B.accent} 65%,transparent);}

/* ── QUALIFICATION BOX (PMP dark box) ── */
.qual{background:${B.primary};width:86%;max-width:410px;padding:14px 30px 16px;margin-bottom:16px;position:relative;-webkit-print-color-adjust:exact;print-color-adjust:exact;}
.qual::before,.qual::after{content:'';position:absolute;left:0;right:0;height:2px;background:linear-gradient(90deg,transparent,${B.accent} 15%,${B.accent2} 50%,${B.accent} 85%,transparent);}
.qual::before{top:0;}.qual::after{bottom:0;}
.q-series{font-family:'Cinzel',serif;font-size:7px;letter-spacing:4px;color:${B.accent};text-transform:uppercase;margin-bottom:8px;}
.q-title{font-family:'Cinzel',serif;font-size:13.5px;font-weight:700;color:${B.cream};letter-spacing:1.8px;line-height:1.55;text-transform:uppercase;}

/* ── GRADE BADGE ── */
.grade{display:inline-flex;align-items:center;gap:8px;background:${B.accentPale};border:1px solid ${B.accent};padding:5px 20px;margin-bottom:12px;}
.g-dot{width:5px;height:5px;border-radius:50%;background:${B.accent};}
.g-txt{font-family:'Cinzel',serif;font-size:8px;font-weight:700;letter-spacing:3px;color:${B.accent};text-transform:uppercase;}

/* ── STATS ── */
.stats{display:flex;align-items:center;justify-content:center;margin-bottom:12px;}
.stat{padding:0 20px;text-align:center;}
.sv{font-family:'Cinzel',serif;font-size:21px;font-weight:700;color:${B.text};line-height:1;margin-bottom:4px;}
.sv.gold{color:${B.accent};}
.sl{font-family:'Cormorant Garamond',serif;font-size:9px;color:${B.subtext};letter-spacing:2.5px;text-transform:uppercase;}
.ss{width:1px;height:40px;background:linear-gradient(180deg,transparent,${B.accent} 30%,${B.accent} 70%,transparent);}

/* ── TESTIMONY ── */
.testimony{font-family:'Cormorant Garamond',serif;font-size:9px;color:${B.subtext};letter-spacing:1.5px;text-transform:uppercase;margin-bottom:14px;}

/* ── FOOTER SIGNATURES ── */
.footer{border-top:1px solid rgba(184,148,58,0.28);padding:12px 52px 0;display:flex;align-items:flex-start;justify-content:space-between;z-index:2;flex-shrink:0;}
.sig{text-align:center;width:140px;}
.ss2{font-family:'Cormorant Garamond',serif;font-size:25px;font-style:italic;color:${B.text};margin-bottom:2px;line-height:1;}
.sr{width:125px;height:0.8px;background:${B.text};margin:0 auto 4px;}
.sn{font-family:'Cinzel',serif;font-size:7px;letter-spacing:1.8px;color:${B.text};text-transform:uppercase;font-weight:600;margin-bottom:2px;}
.so{font-family:'Cormorant Garamond',serif;font-size:9.5px;font-style:italic;color:${B.subtext};line-height:1.3;}
.seal{width:98px;height:98px;flex-shrink:0;margin-top:-14px;}

/* ── CREDENTIAL STRIP ── */
.cstrip{background:${B.primary};height:26px;display:flex;align-items:center;justify-content:space-between;padding:0 52px;position:relative;z-index:2;flex-shrink:0;margin-top:auto;-webkit-print-color-adjust:exact;print-color-adjust:exact;}
.cstrip::before{content:'';position:absolute;top:0;left:0;right:0;height:2px;background:linear-gradient(90deg,transparent,${B.accent} 15%,${B.accent2} 50%,${B.accent} 85%,transparent);}
.ci{font-family:'Cormorant Garamond',serif;font-size:8.5px;color:rgba(255,255,255,0.48);letter-spacing:1.5px;}
.cv{font-family:'Cinzel',serif;font-size:6.5px;color:${B.accent};letter-spacing:2.5px;text-transform:uppercase;}
</style>
</head>
<body>

<div class="fo">
  <div class="fb1">

    <div class="co tl">${corner}</div>
    <div class="co tr">${corner}</div>
    <div class="co bl">${corner}</div>
    <div class="co br">${corner}</div>

    <div class="fb2">
      <div class="wm">${B.abbrev}</div>

      <!-- TOP INSTITUTION BAND -->
      <div class="top-band">
        <div class="tb-left">
          <div class="tb-name">${esc(B.abbrev)}</div>
          <div class="tb-sub">${esc(B.series)}</div>
        </div>
        <div class="tb-right">Official Certification Record</div>
      </div>

      <!-- BODY -->
      <div class="body">

        <p class="eyebrow">This Is To Certify That</p>

        <div class="recipient">${recipientName}</div>

        <p class="achieve">
          Has been formally evaluated for demonstrated experience,<br>
          knowledge and performance in achieving an organisational<br>
          objective and is hereby bestowed the global professional certification
        </p>

        <div class="div-row">
          <div class="div-ln"></div>${star}<div class="div-ln"></div>
        </div>

        <div class="qual">
          <p class="q-series">${esc(B.series)} &nbsp;·&nbsp; Official Record</p>
          <p class="q-title">${moduleTitle}</p>
        </div>

        ${gradeLabel ? `<div class="grade"><span class="g-dot"></span><span class="g-txt">${esc(gradeLabel)}</span><span class="g-dot"></span></div>` : ""}

        ${(scoreDisplay || pctDisplay) ? `
        <div class="stats">
          ${scoreDisplay ? `<div class="stat"><div class="sv">${scoreDisplay}</div><div class="sl">Final Score</div></div><div class="ss"></div>` : ""}
          ${pctDisplay  ? `<div class="stat"><div class="sv gold">${pctDisplay}%</div><div class="sl">Grade</div></div><div class="ss"></div>` : ""}
          <div class="stat"><div class="sv" style="font-size:14px;font-weight:600;">${dateLong}</div><div class="sl">Date Awarded</div></div>
        </div>` : `
        <div class="stats">
          <div class="stat"><div class="sv" style="font-size:14px;font-weight:600;">${dateLong}</div><div class="sl">Date Awarded</div></div>
        </div>`}

        <p class="testimony">In Testimony Whereof, We Have Subscribed Our Signatures Under the Seal of the Institute</p>

      </div><!-- /body -->

      <!-- SIGNATURES -->
      <div class="footer">
        <div class="sig">
          <div class="ss2">${esc(B.sig1Script)}</div>
          <div class="sr"></div>
          <div class="sn">${esc(B.sig1Name)}</div>
          <div class="so">${esc(B.sig1Role)}</div>
        </div>

        <div class="seal">${seal}</div>

        <div class="sig">
          <div class="ss2">${esc(B.sig2Script)}</div>
          <div class="sr"></div>
          <div class="sn">${esc(B.sig2Name)}</div>
          <div class="so">${esc(B.sig2Role)}</div>
        </div>
      </div>

      <!-- CREDENTIAL STRIP -->
      <div class="cstrip">
        <span class="ci">Certificate ID: ${credId} &nbsp;&middot;&nbsp; Awarded by ${esc(B.abbrev)}</span>
        <span class="cv">${esc(B.abbrev)} &nbsp;&middot;&nbsp; Verified</span>
      </div>

    </div><!-- /fb2 -->
  </div><!-- /fb1 -->
</div><!-- /fo -->

</body>
</html>`;
}