/**
 * certificateTemplate.js
 * ──────────────────────
 * Drop-in replacement for buildCertificateHtml() in lms_api.js.
 *
 * Usage (same signature as before):
 *   import { buildCertificateHtml } from "./certificateTemplate.js";
 *
 *   const html = buildCertificateHtml({ name, orgName, moduleName, quizTitle,
 *                                        score, percentage, date });
 *
 * Puppeteer settings (already in generateCertificatePdf):
 *   format: "A4", printBackground: true,
 *   margin: { top: "0", bottom: "0", left: "0", right: "0" }
 *
 * NOTE: remove the old margin values (top/bottom/left/right: "20mm") so the
 * full-bleed design renders correctly.  The certificate has its own internal
 * padding.
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
    s == null
      ? ""
      : String(s)
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;");

  const dateStr = date
    ? new Date(date).toISOString().slice(0, 10)
    : new Date().toISOString().slice(0, 10);

  const moduleTitle = esc(quizTitle || moduleName || "Module");
  const recipientName = esc(name || "Recipient");
  const institution = esc(orgName || "CRIPFCnt Institute");
  const scoreDisplay = esc(score != null ? String(score) : "-");
  const pctDisplay = esc(percentage != null ? String(percentage) : "-");

  /* ── brand config by org ── */
  const orgLow = (orgName || "").toLowerCase();
  let brand = {
    primary: "#0a1628",    // deep navy
    accent:  "#b8973a",    // antique gold
    accent2: "#c9a84c",    // lighter gold
    cream:   "#fdf8ee",    // warm cream
    series:  "CRIPFCnt Learning Management System",
    logoUrl: "",
  };

  if (/nyaradzo/.test(orgLow)) {
    brand = { ...brand, primary: "#0a2e5c", accent: "#c9a227", accent2: "#dbb84a", series: "Nyaradzo Group Training" };
  } else if (/winchester/.test(orgLow)) {
    brand = { ...brand, primary: "#1F3C88", accent: "#8B1E2D", accent2: "#a83040", series: "Winchester School" };
  } else if (/st[\s-]?eurit|eurit/.test(orgLow)) {
    brand = { ...brand, primary: "#111111", accent: "#D4AF37", accent2: "#e8c95a", series: "St Eurit International School" };
  }

  /* ── certificate ID (short hash from date + name) ── */
  const certId = `CERT-${dateStr.replace(/-/g, "")}-${(name || "X")
    .replace(/\s+/g, "")
    .toUpperCase()
    .slice(0, 6)
    .padEnd(6, "0")}`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<title>Certificate of Completion</title>
<style>
/* ── Google Fonts ── */
@import url('https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,300;0,400;0,600;1,300;1,400;1,600&family=Cinzel:wght@400;600;700&display=swap');

/* ── Reset ── */
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

@page { margin: 0; size: A4; }

html, body {
  width: 210mm;
  height: 297mm;
  overflow: hidden;
}

body {
  background: #0a1628;
  display: flex;
  align-items: center;
  justify-content: center;
  font-family: 'Cormorant Garamond', Georgia, serif;
}

/* ── Outer navy frame ── */
.frame-outer {
  width: 190mm;
  min-height: 277mm;
  background: ${brand.cream};
  padding: 5px;
  position: relative;
}

/* ── Double-rule border ── */
.frame-border-1 {
  border: 2.5px solid ${brand.accent};
  padding: 6px;
  position: relative;
  min-height: calc(277mm - 10px);
}

.frame-border-2 {
  border: 1px solid ${brand.accent};
  padding: 32px 44px 36px;
  position: relative;
  min-height: calc(277mm - 22px);
  background: ${brand.cream};
  display: flex;
  flex-direction: column;
  align-items: center;
}

/* ── Watermark ── */
.watermark {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%) rotate(-30deg);
  font-family: 'Cinzel', serif;
  font-size: 80px;
  font-weight: 700;
  color: ${brand.accent};
  opacity: 0.04;
  white-space: nowrap;
  letter-spacing: 10px;
  pointer-events: none;
  text-transform: uppercase;
  z-index: 0;
}

/* ── Corner ornaments ── */
.corner {
  position: absolute;
  width: 52px;
  height: 52px;
  z-index: 2;
}
.corner svg { width: 100%; height: 100%; }
.corner.tl { top: -2px; left: -2px; }
.corner.tr { top: -2px; right: -2px; transform: scaleX(-1); }
.corner.bl { bottom: -2px; left: -2px; transform: scaleY(-1); }
.corner.br { bottom: -2px; right: -2px; transform: scale(-1); }

/* ── All content above watermark ── */
.cert-content {
  position: relative;
  z-index: 1;
  width: 100%;
  text-align: center;
  display: flex;
  flex-direction: column;
  align-items: center;
  flex: 1;
}

/* ── Org badge ── */
.org-badge {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  background: ${brand.primary};
  color: ${brand.accent2};
  padding: 5px 22px 5px 16px;
  font-family: 'Cinzel', serif;
  font-size: 8px;
  letter-spacing: 3.5px;
  text-transform: uppercase;
  margin-bottom: 20px;
}
.org-badge .dot {
  width: 6px; height: 6px;
  background: ${brand.accent};
  border-radius: 50%;
  flex-shrink: 0;
}

/* ── Main title ── */
.cert-title {
  font-family: 'Cinzel', serif;
  font-size: 36px;
  font-weight: 700;
  color: ${brand.primary};
  letter-spacing: 4px;
  text-transform: uppercase;
  line-height: 1.05;
  margin-bottom: 5px;
}

.cert-subtitle {
  font-family: 'Cormorant Garamond', serif;
  font-size: 16px;
  font-style: italic;
  color: #7a6a3a;
  letter-spacing: 2px;
  margin-bottom: 18px;
}

/* ── Gold divider ── */
.divider {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 320px;
  margin-bottom: 20px;
}
.divider-line {
  flex: 1;
  height: 1px;
  background: linear-gradient(90deg, transparent, ${brand.accent} 40%, ${brand.accent} 60%, transparent);
}

/* ── Certifies copy ── */
.certifies {
  font-family: 'Cormorant Garamond', serif;
  font-size: 13px;
  color: #7a6040;
  letter-spacing: 2.5px;
  text-transform: uppercase;
  margin-bottom: 8px;
}

/* ── Recipient name ── */
.recipient-name {
  font-family: 'Cormorant Garamond', serif;
  font-size: 46px;
  font-weight: 600;
  font-style: italic;
  color: ${brand.primary};
  line-height: 1.1;
  letter-spacing: 1px;
  margin-bottom: 16px;
  max-width: 480px;
  word-break: break-word;
}

.completed-text {
  font-family: 'Cormorant Garamond', serif;
  font-size: 13px;
  color: #7a6040;
  letter-spacing: 2.5px;
  text-transform: uppercase;
  margin-bottom: 14px;
}

/* ── Module box ── */
.module-box {
  background: ${brand.primary};
  padding: 14px 30px 16px;
  width: 90%;
  max-width: 480px;
  margin-bottom: 22px;
  position: relative;
}
.module-box::before,
.module-box::after {
  content: '';
  position: absolute;
  left: 0; right: 0;
  height: 2px;
  background: linear-gradient(90deg, transparent, ${brand.accent} 20%, ${brand.accent} 80%, transparent);
}
.module-box::before { top: 0; }
.module-box::after  { bottom: 0; }

.module-series {
  font-family: 'Cinzel', serif;
  font-size: 7.5px;
  letter-spacing: 4px;
  color: ${brand.accent};
  text-transform: uppercase;
  margin-bottom: 7px;
}

.module-title {
  font-family: 'Cinzel', serif;
  font-size: 11.5px;
  font-weight: 600;
  color: ${brand.cream};
  letter-spacing: 1.5px;
  line-height: 1.6;
  text-transform: uppercase;
}

/* ── Stats row ── */
.stats {
  display: flex;
  justify-content: center;
  align-items: center;
  gap: 0;
  margin-bottom: 26px;
  width: 80%;
  max-width: 420px;
}

.stat {
  flex: 1;
  text-align: center;
}

.stat-value {
  font-family: 'Cinzel', serif;
  font-size: 22px;
  font-weight: 700;
  color: ${brand.primary};
  line-height: 1;
  margin-bottom: 5px;
}
.stat-value.gold { color: ${brand.accent}; }

.stat-label {
  font-family: 'Cormorant Garamond', serif;
  font-size: 10px;
  color: #7a6040;
  letter-spacing: 2px;
  text-transform: uppercase;
}

.stat-sep {
  width: 1px;
  height: 40px;
  background: linear-gradient(180deg, transparent, ${brand.accent} 30%, ${brand.accent} 70%, transparent);
}

/* ── Bottom signature area ── */
.cert-bottom {
  display: flex;
  justify-content: space-between;
  align-items: flex-end;
  width: 100%;
  margin-top: auto;
  padding-top: 18px;
  border-top: 1px solid #d4c89a;
}

.sig {
  flex: 1;
  text-align: center;
}

.sig-script {
  font-family: 'Cormorant Garamond', serif;
  font-size: 24px;
  font-style: italic;
  color: ${brand.primary};
  margin-bottom: 4px;
  line-height: 1;
}

.sig-line {
  width: 130px;
  height: 1px;
  background: ${brand.primary};
  margin: 0 auto 5px;
}

.sig-name {
  font-family: 'Cinzel', serif;
  font-size: 8px;
  letter-spacing: 2px;
  color: ${brand.primary};
  text-transform: uppercase;
  margin-bottom: 2px;
}

.sig-role {
  font-family: 'Cormorant Garamond', serif;
  font-size: 10px;
  font-style: italic;
  color: #7a6040;
}

/* ── Seal ── */
.seal {
  flex-shrink: 0;
  width: 80px;
  height: 80px;
  margin: 0 12px;
}
.seal svg { width: 100%; height: 100%; }

/* ── Certificate ID ── */
.cert-id {
  font-family: 'Cormorant Garamond', serif;
  font-size: 9px;
  color: #aaa090;
  letter-spacing: 1.2px;
  text-align: center;
  margin-top: 12px;
  width: 100%;
}
</style>
</head>
<body>

<div class="frame-outer">
  <div class="frame-border-1">

    <!-- Corner ornaments -->
    <div class="corner tl">
      <svg viewBox="0 0 52 52" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M2 50V7C2 4.2 4.2 2 7 2H50" stroke="${brand.accent}" stroke-width="1.5"/>
        <path d="M2 30V7C2 4.2 4.2 2 7 2H30" stroke="${brand.accent2}" stroke-width="0.5"/>
        <circle cx="7" cy="7" r="3" fill="${brand.accent}"/>
        <circle cx="2" cy="2" r="1.8" fill="${brand.accent2}"/>
        <path d="M13 2H18M2 13V18" stroke="${brand.accent}" stroke-width="0.8"/>
      </svg>
    </div>
    <div class="corner tr">
      <svg viewBox="0 0 52 52" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M2 50V7C2 4.2 4.2 2 7 2H50" stroke="${brand.accent}" stroke-width="1.5"/>
        <path d="M2 30V7C2 4.2 4.2 2 7 2H30" stroke="${brand.accent2}" stroke-width="0.5"/>
        <circle cx="7" cy="7" r="3" fill="${brand.accent}"/>
        <circle cx="2" cy="2" r="1.8" fill="${brand.accent2}"/>
        <path d="M13 2H18M2 13V18" stroke="${brand.accent}" stroke-width="0.8"/>
      </svg>
    </div>
    <div class="corner bl">
      <svg viewBox="0 0 52 52" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M2 50V7C2 4.2 4.2 2 7 2H50" stroke="${brand.accent}" stroke-width="1.5"/>
        <path d="M2 30V7C2 4.2 4.2 2 7 2H30" stroke="${brand.accent2}" stroke-width="0.5"/>
        <circle cx="7" cy="7" r="3" fill="${brand.accent}"/>
        <circle cx="2" cy="2" r="1.8" fill="${brand.accent2}"/>
        <path d="M13 2H18M2 13V18" stroke="${brand.accent}" stroke-width="0.8"/>
      </svg>
    </div>
    <div class="corner br">
      <svg viewBox="0 0 52 52" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M2 50V7C2 4.2 4.2 2 7 2H50" stroke="${brand.accent}" stroke-width="1.5"/>
        <path d="M2 30V7C2 4.2 4.2 2 7 2H30" stroke="${brand.accent2}" stroke-width="0.5"/>
        <circle cx="7" cy="7" r="3" fill="${brand.accent}"/>
        <circle cx="2" cy="2" r="1.8" fill="${brand.accent2}"/>
        <path d="M13 2H18M2 13V18" stroke="${brand.accent}" stroke-width="0.8"/>
      </svg>
    </div>

    <div class="frame-border-2">
      <div class="watermark">CRIPFCNT</div>

      <div class="cert-content">

        <!-- Org badge -->
        <div class="org-badge">
          <span class="dot"></span>
          ${brand.series}
          <span class="dot"></span>
        </div>

        <!-- Title -->
        <h1 class="cert-title">Certificate</h1>
        <p class="cert-subtitle">of Completion</p>

        <!-- Gold divider -->
        <div class="divider">
          <div class="divider-line"></div>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
            <path d="M12 2l2.4 7.4H22l-6.2 4.5 2.4 7.4L12 17l-6.2 4.3 2.4-7.4L2 9.4h7.6L12 2z"
                  fill="${brand.accent}"/>
          </svg>
          <div class="divider-line"></div>
        </div>

        <p class="certifies">This Certifies That</p>

        <h2 class="recipient-name">${recipientName}</h2>

        <p class="completed-text">Has Successfully Completed the Module</p>

        <!-- Module box -->
        <div class="module-box">
          <p class="module-series">${institution} &nbsp;·&nbsp; Official Record</p>
          <p class="module-title">${moduleTitle}</p>
        </div>

        <!-- Stats -->
        <div class="stats">
          <div class="stat">
            <div class="stat-value">${scoreDisplay}</div>
            <div class="stat-label">Final Score</div>
          </div>
          <div class="stat-sep"></div>
          <div class="stat">
            <div class="stat-value gold">${pctDisplay}%</div>
            <div class="stat-label">Distinction</div>
          </div>
          <div class="stat-sep"></div>
          <div class="stat">
            <div class="stat-value">${dateStr}</div>
            <div class="stat-label">Date Awarded</div>
          </div>
        </div>

        <!-- Signature + Seal -->
        <div class="cert-bottom">
          <div class="sig">
            <div class="sig-script">Director</div>
            <div class="sig-line"></div>
            <div class="sig-name">Director of Learning</div>
            <div class="sig-role">${institution}</div>
          </div>

          <div class="seal">
            <svg viewBox="0 0 80 80" fill="none" xmlns="http://www.w3.org/2000/svg">
              <circle cx="40" cy="40" r="37" fill="${brand.primary}" stroke="${brand.accent}" stroke-width="1.5"/>
              <circle cx="40" cy="40" r="32" fill="none" stroke="${brand.accent2}" stroke-width="0.5"/>
              <circle cx="40" cy="40" r="27" fill="none" stroke="${brand.accent}" stroke-width="0.5" stroke-dasharray="2.5 2"/>
              <path d="M40 16l2.8 8.5H51l-7 5.2 2.7 8.5L40 33l-6.7 5.2 2.7-8.5-7-5.2h8.2L40 16z"
                    fill="${brand.accent2}"/>
              <text x="40" y="52" text-anchor="middle"
                    font-family="'Cinzel', serif" font-size="6.5" font-weight="600"
                    fill="${brand.accent2}" letter-spacing="2">CRIPFCNT</text>
              <text x="40" y="60" text-anchor="middle"
                    font-family="'Cinzel', serif" font-size="5"
                    fill="${brand.accent}" letter-spacing="1.5">VERIFIED</text>
              <circle cx="40" cy="65" r="2" fill="${brand.accent}" opacity="0.7"/>
            </svg>
          </div>

          <div class="sig">
            <div class="sig-script">Academic</div>
            <div class="sig-line"></div>
            <div class="sig-name">Chief Academic Officer</div>
            <div class="sig-role">${institution}</div>
          </div>
        </div>

        <!-- Certificate ID -->
        <p class="cert-id">
          Certificate ID: ${certId}
          &nbsp;&middot;&nbsp;
          Awarded by ${institution}
        </p>

      </div><!-- /cert-content -->
    </div><!-- /frame-border-2 -->
  </div><!-- /frame-border-1 -->
</div><!-- /frame-outer -->

</body>
</html>`;
}