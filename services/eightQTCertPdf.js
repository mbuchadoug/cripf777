// services/eightQTCertPdf.js
// Generates the 8QT certificate PDF using Puppeteer.
//
// ROOT CAUSE ANALYSIS - why you had a huge white empty space:
//
// BUG 1: eightQTCertPdf.js used display:flex + justify-content:center on body.
//   Flex on a fixed-height container (794px) centres the content block vertically,
//   leaving whatever empty pixels above and below as blank white space.
//   THE FIX: use CSS display:table on the outer wrapper - same battle-tested approach
//   as the working lms_api.js certificateTemplate. Table cells fill 100% of their
//   row height by definition; there is no concept of "remaining empty space".
//
// BUG 2: eightQTCertPdf.js called page.setViewport({width:1122,height:794}) BEFORE
//   setContent, then passed width:"1122px"/height:"794px" to page.pdf().
//   When Puppeteer's page.pdf() receives explicit pixel width/height it applies them
//   as the paper size - but the viewport was already set independently, causing a
//   mismatch where the HTML renders at one size and the PDF clips or pads to another.
//   THE FIX: do NOT use setViewport at all. Use format:"A4" + landscape:true +
//   emulateMediaType("print") before setContent. The @page{size:A4 landscape;margin:0}
//   CSS rule then controls everything and Puppeteer honours it faithfully.
//
// BUG 3: emulateMediaType("print") was called AFTER setContent.
//   In newer Puppeteer versions this can cause the layout engine to re-evaluate styles
//   but fonts are already loaded, producing inconsistent results.
//   THE FIX: call emulateMediaType("print") BEFORE setContent.
//
// BUG 4: generateEightQTCertPdf was never imported/called anywhere.
//   The admin route (eightQTAdmin.js) used inline dynamic imports of
//   buildCertificateHtml from certificateTemplate.js - the WRONG template for 8QT.
//   THE FIX: this service now exports generateEightQTCertPdf and
//   eightQTAdmin.js must import it instead of inlining.
//
// BUG 5: The 8QT cert HTML used Google Fonts via @import.
//   Puppeteer in headless mode blocks network requests by default under some
//   configurations, so fonts silently fall back to system fonts and the layout
//   shifts, which can push content and create gaps.
//   THE FIX: embed the Inter font as a base64 data-URI, or use a system-safe
//   font stack that renders identically whether Google Fonts loads or not.
//   We also add a 1200ms delay after setContent to let fonts settle before pdf().

import puppeteer from "puppeteer";
import path from "path";
import fs from "fs";
import crypto from "crypto";

const OUTPUT_DIR = path.join(process.cwd(), "public", "certificates", "8qt");

// ─────────────────────────────────────────────────────────────────────────────
// HTML BUILDER
// Layout: CSS display:table shell, 4 rows, 3 columns.
//   Row 1 (48px)  : header - dark sidebar | logo + wordmark | cert type + date
//   Row 2 (auto)  : body   - dark sidebar | white content   | dark right panel
//   Row 3 (62px)  : footer - dark sidebar | signature       | dark
//   Row 4 (22px)  : strip  - dark sidebar | credential ID   | verify URL
//
// The table shell is width:297mm height:210mm - exactly A4 landscape.
// The body row has no explicit height so it fills ALL remaining space.
// There is no flex, no empty space possible.
// ─────────────────────────────────────────────────────────────────────────────
export function buildEightQTCertHtml({ attempt, template, archetype }) {
  const esc = s => s == null ? "" : String(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  const participantName = esc(
    attempt.certificateName ||
    attempt.profile?.firstName ||
    attempt.participantName ||
    "Participant"
  );
  const orgName  = esc(attempt.certificateOrg || "CRIPFCnt");
  const archetypeName    = esc(archetype?.name || attempt.archetypeName || "CRIPFCnt Thinker");
  const archetypeTagline = esc(archetype?.tagline || "");

  const dateObj  = new Date();
  const dateLong = dateObj.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
  const dateStr  = dateObj.toISOString().slice(0, 10).replace(/-/g, "");

  const scores    = attempt.quotientScores || [];
  const dominant  = scores.find(s => s.code === attempt.dominantQuotient);
  const devEdge   = scores.find(s => s.code === attempt.developmentEdge);

  const verifyCode = attempt.certificateVerifyCode ||
    crypto.randomBytes(6).toString("hex").toUpperCase();

  // Brand colours - CRIPFCnt defaults, override per org if needed
  const DARK        = "#0B4F45";
  const MINT        = "#1DE9B6";
  const MINT_DARK   = "#0D9B77";
  const MINT_BG     = "#E1F5EE";
  const MINT_BORDER = "#9FE1CB";
  const ABBREV      = "CRIPFCnt";
  const SERIES      = "CRIPFCnt 8 Quotients Assessment";
  const SIG_NAME    = esc(template?.signatoryName  || "Donald Mataranyika");
  const SIG_ROLE    = esc(template?.signatoryTitle || "Founder, CRIPFCnt");

  const credId = `${ABBREV}-${dateStr}-${(attempt.certificateName || "X")
    .replace(/\s+/g, "").toUpperCase().slice(0, 6).padEnd(6, "0")}`;

  // ── SVG helpers ────────────────────────────────────────────────
  const logo = (color, w, h) =>
    `<svg width="${w}" height="${h}" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg">` +
    `<path d="M20 10 L20 90 Q20 90 50 90 Q80 90 80 60 L80 52 L54 52 L54 70 Q54 74 50 74 Q46 74 46 70 L46 30 Q46 26 50 26 Q54 26 54 30 L54 48 L80 48 L80 40 Q80 10 50 10 Z" fill="${color}"/>` +
    `</svg>`;

  const sbStripes = Array.from({ length: 60 }, (_, i) => {
    const y = 4 + i * 13;
    return `<polyline points="2,${y} 21,${y + 9} 40,${y}" stroke="${MINT}" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" opacity="0.18"/>`;
  }).join("");

  const rpStripes = Array.from({ length: 60 }, (_, i) => {
    const y = 4 + i * 13;
    return `<polyline points="0,${y} 65,${y + 21} 130,${y}" stroke="${MINT}" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" opacity="0.09"/>`;
  }).join("");

  const sig = `<svg width="124" height="40" viewBox="0 0 128 42" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M5 30 C9 19 15 12 23 14 C29 16 31 23 27 29 C23 35 17 34 15 30 C13 26 19 20 27 24 C35 28 41 22 47 16" stroke="#1a1a2e" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
    <path d="M47 16 C53 10 57 12 59 18 C61 24 57 30 53 28 C49 26 51 20 57 22 C65 25 71 18 77 14" stroke="#1a1a2e" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
    <path d="M77 14 C83 10 87 14 85 22 C83 28 79 32 81 36 C83 39 89 37 93 33" stroke="#1a1a2e" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
    <path d="M93 33 C97 29 103 26 107 30 C111 34 107 39 103 37 C99 35 102 29 108 28 C116 26 121 32 125 35" stroke="#1a1a2e" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
  </svg>`;

  const badge = `<svg width="56" height="56" viewBox="0 0 60 60" fill="none" xmlns="http://www.w3.org/2000/svg">
    <circle cx="30" cy="30" r="28" stroke="${MINT}" stroke-width="1.8" fill="none"/>
    <circle cx="30" cy="30" r="22" stroke="${MINT}" stroke-width="0.8" stroke-dasharray="3 2" fill="none" opacity="0.4"/>
    <path d="M19 30 L26 37 L41 22" stroke="${MINT}" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"/>
    <text x="30" y="53" font-family="'Inter',Arial,sans-serif" font-size="5.5" font-weight="600" fill="${MINT}" text-anchor="middle" letter-spacing="1">CERTIFIED</text>
  </svg>`;

  const wm = `<svg width="190" height="190" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg"
    style="position:absolute;right:-20px;bottom:-20px;opacity:0.03;pointer-events:none;">
    <path d="M20 10 L20 90 Q20 90 50 90 Q80 90 80 60 L80 52 L54 52 L54 70 Q54 74 50 74 Q46 74 46 70 L46 30 Q46 26 50 26 Q54 26 54 30 L54 48 L80 48 L80 40 Q80 10 50 10 Z" fill="${DARK}"/>
  </svg>`;

  // ── Score content block ────────────────────────────────────────
  // showAllScores: render compact 8-row table
  // otherwise: show dominant + development edge prominently
  const showAll = template?.showAllScores !== false; // default true

  let scoreBlock = "";
  if (showAll && scores.length > 0) {
    // 2-column grid so 8 scores fit without overflow
    const cells = scores.map(s => `
      <div style="display:table-cell;padding:4px 8px 4px 0;vertical-align:top;width:50%">
        <span style="font-size:7.5px;color:#AAA;letter-spacing:0.5px;text-transform:uppercase">${esc(s.name)}</span>
        <div style="display:flex;align-items:center;gap:5px;margin-top:2px">
          <div style="flex:1;height:4px;background:#E8E8E8;border-radius:2px;overflow:hidden">
            <div style="width:${s.score}%;height:100%;background:${MINT};border-radius:2px"></div>
          </div>
          <span style="font-size:9px;font-weight:700;color:${MINT_DARK};min-width:22px;text-align:right">${s.score}</span>
          <span style="font-size:7.5px;color:#888;min-width:60px">${esc(s.band)}</span>
        </div>
      </div>
    `).join("");

    // Pair into rows of 2
    const rows = scores.map((s, i) => i % 2 === 0
      ? `<div style="display:table-row">${cells.split("</div>").slice(i, i + 2).join("</div>") + "</div>"}</div>`
      : ""
    ).filter(Boolean);

    // Simpler approach: use a plain table for 2-col layout
    const tableRows = [];
    for (let i = 0; i < scores.length; i += 2) {
      const a = scores[i];
      const b = scores[i + 1];
      const cell = (s) => s ? `
        <td style="padding:3px 10px 3px 0;vertical-align:top;width:50%">
          <span style="font-size:7px;color:#AAA;letter-spacing:0.5px;text-transform:uppercase;display:block">${esc(s.name)}</span>
          <div style="display:flex;align-items:center;gap:5px;margin-top:2px">
            <div style="flex:1;height:3px;background:#E8E8E8;border-radius:2px;overflow:hidden">
              <div style="width:${s.score}%;height:100%;background:${MINT};border-radius:2px"></div>
            </div>
            <span style="font-size:8.5px;font-weight:700;color:${MINT_DARK};min-width:20px;text-align:right">${s.score}</span>
            <span style="font-size:7px;color:#888;min-width:62px">${esc(s.band)}</span>
          </div>
        </td>` : "<td></td>";
      tableRows.push(`<tr>${cell(a)}${cell(b)}</tr>`);
    }

    scoreBlock = `
      <table style="width:100%;border-collapse:collapse;margin-bottom:0">
        ${tableRows.join("")}
      </table>`;
  } else if (dominant) {
    // Dominant only mode
    scoreBlock = `
      <div style="display:flex;align-items:flex-end;gap:20px">
        <div>
          <div style="font-size:8.5px;color:#AAA;letter-spacing:1px;text-transform:uppercase;margin-bottom:3px">Dominant Quotient</div>
          <div style="font-size:22px;font-weight:700;color:${MINT};line-height:1">${dominant.score}</div>
          <div style="font-size:8px;color:#888;margin-top:2px">${esc(dominant.name)} · ${esc(dominant.band)}</div>
        </div>
        ${devEdge ? `
        <div style="border-left:0.5px solid #E0E0E0;padding-left:20px">
          <div style="font-size:8.5px;color:#AAA;letter-spacing:1px;text-transform:uppercase;margin-bottom:3px">Development Edge</div>
          <div style="font-size:22px;font-weight:700;color:#0B4F45;line-height:1">${devEdge.score}</div>
          <div style="font-size:8px;color:#888;margin-top:2px">${esc(devEdge.name)} · ${esc(devEdge.band)}</div>
        </div>` : ""}
      </div>`;
  }

  // Archetype line - only show tagline if it exists and is short enough
  const archetypeLine = archetypeTagline
    ? `${archetypeName} &mdash; ${archetypeTagline}`
    : archetypeName;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<title>Certificate - ${participantName}</title>
<style>
/* ── CRITICAL: no external font imports. Use system safe stack.
   Google Fonts via @import is blocked or slow in headless Chromium,
   causing font fallback + layout shifts = empty space.
   Inter is preinstalled on most Linux systems (Chromium bundles it).
   The visual difference is negligible. ── */
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0;}

/* @page controls the PDF paper size. MUST match format in page.pdf(). */
@page{margin:0;size:A4 landscape;}

html,body{
  width:297mm;
  height:210mm;
  overflow:hidden;
  background:${DARK};
  font-family:'Inter','Segoe UI','Helvetica Neue',Arial,sans-serif;
  -webkit-font-smoothing:antialiased;
  font-size:14px;
}

/* ── OUTER SHELL: display:table forces rows to fill 100% height ── */
/* This is THE fix for empty white space. Table cells stretch     */
/* to fill their row. The body row (no explicit height) takes     */
/* all remaining space after header/footer/strip rows.            */
table.cert{
  width:297mm;
  height:210mm;
  display:table;
  table-layout:fixed;
  border-collapse:collapse;
  -webkit-print-color-adjust:exact;
  print-color-adjust:exact;
}

/* Fixed-height rows */
tr.r-hdr  > td { height:48px; }
tr.r-foot > td { height:62px; }
tr.r-strip> td { height:22px; }
/* r-body has NO height - it fills everything remaining */

/* Column widths */
td{padding:0;vertical-align:top;}
td.c-sb{width:44px;background:${DARK};position:relative;overflow:hidden;}
td.c-rp{width:132px;}

/* ── HEADER ── */
tr.r-hdr td{background:${DARK};}
tr.r-hdr td.c-main{vertical-align:middle;padding:0 20px;}
tr.r-hdr td.c-rp{vertical-align:middle;padding:0 14px;text-align:right;}

/* ── SIDEBAR ── */
.sb-svg{position:absolute;top:0;left:0;width:44px;height:100%;}
.sb-foot{position:absolute;bottom:0;left:0;right:0;display:flex;flex-direction:column;align-items:center;padding-bottom:10px;gap:5px;z-index:2;}
.sb-word{writing-mode:vertical-rl;transform:rotate(180deg);font-size:7.5px;font-weight:700;color:${MINT};letter-spacing:3px;opacity:0.75;}

/* ── BODY: white content pane ── */
tr.r-body td.c-sb{background:${DARK};}
tr.r-body td.c-main{
  background:#fff;
  vertical-align:top;
  padding:18px 20px 14px 18px;
  position:relative;
  overflow:hidden;
}
tr.r-body td.c-rp{
  background:${DARK};
  vertical-align:middle;
  padding:0 14px;
  position:relative;
  overflow:hidden;
}

/* ── RIGHT DARK PANEL ── */
.rp-svg{position:absolute;top:0;left:0;width:132px;height:100%;}
.rp-inner{position:relative;z-index:2;}
.rp-item{padding:9px 0;border-bottom:0.5px solid rgba(255,255,255,0.1);}
.rp-item:last-child{border-bottom:none;}
.rp-lbl{font-size:6.5px;color:rgba(255,255,255,0.38);letter-spacing:1.5px;text-transform:uppercase;margin-bottom:4px;}
.rp-val{font-size:10.5px;font-weight:600;color:${MINT};line-height:1.3;}
.rp-val-sm{font-size:7.5px;font-weight:600;color:${MINT};line-height:1.4;word-break:break-word;}

/* ── LEFT CONTENT ── */
.certify-lbl{font-size:8.5px;color:#AAA;letter-spacing:1.5px;text-transform:uppercase;margin-bottom:4px;}
.recipient{font-size:26px;font-weight:700;color:#0B1F1A;line-height:1.1;margin-bottom:2px;word-break:break-word;}
.archetype-line{font-size:11px;color:${MINT_DARK};font-weight:600;margin-bottom:3px;}
.succeed{font-size:9.5px;color:#888;margin-bottom:12px;}
.quiz-block{border-left:3px solid ${MINT};padding:7px 11px;background:${MINT_BG};border-radius:0 3px 3px 0;margin-bottom:10px;}
.quiz-cat{font-size:7px;font-weight:600;color:${MINT_DARK};letter-spacing:1.5px;text-transform:uppercase;margin-bottom:2px;}
.quiz-title{font-size:12px;font-weight:600;color:#0B1F1A;line-height:1.25;}
.divider{height:0.5px;background:#E8E8E8;margin-bottom:11px;}

/* ── FOOTER ── */
tr.r-foot td.c-sb,tr.r-foot td.c-rp{background:${DARK};}
tr.r-foot td.c-main{background:#fff;vertical-align:middle;padding:0 20px 0 18px;border-top:0.5px solid #E8E8E8;}
.foot-inner{display:flex;align-items:center;justify-content:space-between;}
.sig-rule{width:115px;height:0.5px;background:#CCC;margin-bottom:4px;}
.sig-name{font-size:9px;font-weight:600;color:#1a1a2e;margin-bottom:1px;}
.sig-role{font-size:8px;color:#888;}

/* ── CREDENTIAL STRIP ── */
tr.r-strip td.c-sb{background:${DARK};}
tr.r-strip td.c-main{background:#F5F5F5;vertical-align:middle;padding:0 18px;border-top:0.5px solid #E8E8E8;}
tr.r-strip td.c-rp{background:#F5F5F5;vertical-align:middle;padding:0 14px;text-align:right;border-top:0.5px solid #E8E8E8;}
.strip-id{font-size:6.5px;color:#BBB;letter-spacing:0.3px;}
.strip-verify{font-size:6.5px;color:${MINT_DARK};font-weight:500;}

/* ── HEADER TYPOGRAPHY ── */
.hdr-logo{display:flex;align-items:center;gap:9px;}
.hdr-wm{font-size:13px;font-weight:700;color:${MINT};letter-spacing:1.5px;}
.hdr-sub{font-size:6px;color:rgba(255,255,255,0.3);letter-spacing:2px;text-transform:uppercase;margin-top:2px;}
.hdr-lbl{font-size:6px;color:rgba(255,255,255,0.35);letter-spacing:2px;text-transform:uppercase;margin-bottom:2px;}
.hdr-type{font-size:10.5px;font-weight:600;color:rgba(255,255,255,0.92);}
.hdr-date{font-size:7.5px;color:${MINT};margin-top:3px;font-weight:500;}
</style>
</head>
<body>
<table class="cert">

<!-- ROW 1: HEADER -->
<tr class="r-hdr">
  <td class="c-sb"></td>
  <td class="c-main">
    <div class="hdr-logo">
      ${logo(MINT, 26, 26)}
      <div>
        <div class="hdr-wm">${ABBREV}</div>
        <div class="hdr-sub">${SERIES}</div>
      </div>
    </div>
  </td>
  <td class="c-rp">
    <div class="hdr-lbl">Official Document</div>
    <div class="hdr-type">Certificate of Assessment</div>
    <div class="hdr-date">${dateLong}</div>
  </td>
</tr>

<!-- ROW 2: BODY (fills all remaining height - no whitespace possible) -->
<tr class="r-body">

  <!-- Sidebar -->
  <td class="c-sb">
    <svg class="sb-svg" viewBox="0 0 44 800" fill="none" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMin slice">
      ${sbStripes}
    </svg>
    <div class="sb-foot">
      <span class="sb-word">${ABBREV}</span>
      ${logo(MINT, 18, 18)}
    </div>
  </td>

  <!-- White content pane -->
  <td class="c-main">
    ${wm}
    <p class="certify-lbl">This is to certify that</p>
    <p class="recipient">${participantName}</p>
    <p class="archetype-line">${archetypeLine}</p>
    <p class="succeed">has completed the CRIPFCnt 8 Quotients Assessment and has been mapped across<br>
      the eight dimensions of Placement Intelligence as developed by Donald Mataranyika.</p>
    <div class="quiz-block">
      <div class="quiz-cat">8 Quotients Assessment</div>
      <div class="quiz-title">Placement Intelligence Framework &mdash; CRIPFCnt</div>
    </div>
    <div class="divider"></div>
    ${scoreBlock}
  </td>

  <!-- Right dark panel -->
  <td class="c-rp">
    <svg class="rp-svg" viewBox="0 0 132 800" fill="none" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMin slice">
      ${rpStripes}
    </svg>
    <div class="rp-inner">
      <div class="rp-item">
        <div class="rp-lbl">Participant</div>
        <div class="rp-val" style="font-size:9px;line-height:1.4">${participantName}</div>
      </div>
      <div class="rp-item">
        <div class="rp-lbl">Organisation</div>
        <div class="rp-val">${orgName}</div>
      </div>
      <div class="rp-item">
        <div class="rp-lbl">Archetype</div>
        <div class="rp-val-sm">${esc(archetype?.name || attempt.archetypeName || "-")}</div>
      </div>
      <div class="rp-item">
        <div class="rp-lbl">Dominant Quotient</div>
        <div class="rp-val">${esc(attempt.dominantQuotient || "-")}</div>
      </div>
      <div class="rp-item">
        <div class="rp-lbl">Issued by</div>
        <div class="rp-val">${ABBREV}</div>
      </div>
      <div class="rp-item">
        <div class="rp-lbl">Date issued</div>
        <div class="rp-val" style="font-size:8.5px">${dateLong}</div>
      </div>
      <div class="rp-item">
        <div class="rp-lbl">Credential ID</div>
        <div class="rp-val-sm">${credId}</div>
      </div>
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
        <div class="sig-name">${SIG_NAME}</div>
        <div class="sig-role">${SIG_ROLE}</div>
      </div>
      ${badge}
    </div>
  </td>
  <td class="c-rp"></td>
</tr>

<!-- ROW 4: CREDENTIAL STRIP -->
<tr class="r-strip">
  <td class="c-sb"></td>
  <td class="c-main">
    <span class="strip-id">Certificate ID: ${credId} &nbsp;&middot;&nbsp; ${SERIES} &nbsp;&middot;&nbsp; Verify: cripfcnt.com/verify/8qt/${verifyCode}</span>
  </td>
  <td class="c-rp">
    <span class="strip-verify">cripfcnt.com/verify</span>
  </td>
</tr>

</table>
</body>
</html>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// PDF GENERATOR
// Correct Puppeteer sequence:
//   1. launch
//   2. newPage
//   3. emulateMediaType("print")   ← BEFORE setContent
//   4. setContent(html, {waitUntil:"networkidle0"})
//   5. wait 1200ms for any remaining render
//   6. page.pdf with format:"A4", landscape:true, printBackground:true, zero margins
//   7. close
//
// Do NOT use setViewport - it conflicts with page.pdf's paper size.
// Do NOT pass width/height to page.pdf when using format - they override each other.
// ─────────────────────────────────────────────────────────────────────────────
export async function generateEightQTCertPdf({ attempt, template, archetype }) {
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  const verifyCode = attempt.certificateVerifyCode ||
    crypto.randomBytes(6).toString("hex").toUpperCase();

  // Stamp verifyCode onto attempt object so buildEightQTCertHtml can embed it
  attempt = { ...attempt, certificateVerifyCode: verifyCode };

  const html = buildEightQTCertHtml({ attempt, template, archetype });

  const browser = await puppeteer.launch({
    headless: "new",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--font-render-hinting=none" // prevents font hinting differences between runs
    ]
  });

  let page;
  try {
    page = await browser.newPage();

    // CRITICAL: emulateMediaType BEFORE setContent
    // This ensures the CSS @page rule and print media queries are active
    // during the initial layout pass, not after fonts/images have loaded.
    await page.emulateMediaType("print");

    await page.setContent(html, { waitUntil: "networkidle0", timeout: 45000 });

    // Allow fonts to fully paint before capture
    await new Promise(r => setTimeout(r, 1200));

    const filename   = `8qt-cert-${verifyCode}.pdf`;
    const outputPath = `${OUTPUT_DIR}/${filename}`;

    await page.pdf({
      path:            outputPath,
      format:          "A4",
      landscape:       true,
      printBackground: true,
      margin:          { top: "0", bottom: "0", left: "0", right: "0" }
      // Do NOT pass width/height here - format:"A4" already sets the paper size.
      // Passing both causes Chromium to prefer the explicit dimensions, which
      // can differ from A4 by fractional pixels and create hairline gaps.
    });

    const url = `/certificates/8qt/${filename}`;
    console.log(`[8qt cert] ✅ Generated: ${url} (verify: ${verifyCode})`);
    return { url, verifyCode };

  } finally {
    try { await browser.close(); } catch (_) {}
  }
}