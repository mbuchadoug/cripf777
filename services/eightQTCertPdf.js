// services/eightQTCertPdf.js
// Generates the 8QT certificate PDF using Puppeteer (same pattern as generateScoiPdf)

import puppeteer from "puppeteer";
import path from "path";
import fs from "fs";
import crypto from "crypto";

const OUTPUT_DIR = path.join(process.cwd(), "public", "certificates", "8qt");

/**
 * Generate and save certificate PDF for an 8QT attempt.
 *
 * @param {Object} attempt  - populated EightQTAttempt doc
 * @param {Object} template - active EightQTCertTemplate doc
 * @param {Object} archetype - matched EightQTArchetype doc (may be null)
 * @returns {{ url: string, verifyCode: string }}
 */
export async function generateEightQTCertPdf({ attempt, template, archetype }) {
  // Ensure output directory exists
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  const verifyCode = attempt.certificateVerifyCode ||
    crypto.randomBytes(6).toString("hex").toUpperCase();

  const participantName = attempt.certificateName ||
    attempt.profile?.firstName ||
    attempt.participantName ||
    "Participant";

  const issuedDate = new Date().toLocaleDateString("en-GB", {
    day: "numeric", month: "long", year: "numeric"
  });

  const scores = attempt.quotientScores || [];
  const dominant = scores.find(s => s.code === attempt.dominantQuotient);
  const edge = scores.find(s => s.code === attempt.developmentEdge);
  const archetypeName = archetype?.name || attempt.archetypeName || "CRIPFCnt Thinker";
  const archetypeTagline = archetype?.tagline || "";

  // Build score rows HTML
  const scoreRows = scores.map(s => `
    <tr>
      <td style="padding:4px 12px;font-family:serif;font-size:13px;color:#1E3A5F;font-weight:600">${s.name}</td>
      <td style="padding:4px 12px;font-family:serif;font-size:13px;color:#333">${s.score}/100</td>
      <td style="padding:4px 12px;font-family:serif;font-size:13px;color:#C9A961;font-weight:600">${s.band}</td>
    </tr>
  `).join("");

  const bgStyle = template?.backgroundUrl
    ? `background-image:url('${template.backgroundUrl}');background-size:cover;background-position:center;`
    : `background: linear-gradient(135deg,#1E3A5F 0%,#0F1C2E 60%,#1E3A5F 100%);`;

  const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  @import url('https://fonts.googleapis.com/css2?family=Crimson+Pro:ital,wght@0,400;0,600;0,700;1,400&family=Inter:wght@400;500;600&display=swap');
  *{margin:0;padding:0;box-sizing:border-box}
  html,body{width:1122px;height:794px;overflow:hidden}
  body{
    font-family:'Crimson Pro',serif;
    ${bgStyle}
    display:flex;flex-direction:column;align-items:center;justify-content:center;
    position:relative;padding:40px 60px;
  }
  .overlay{
    position:absolute;inset:0;
    background:rgba(15,28,46,0.82);
    z-index:0;
  }
  .content{position:relative;z-index:1;width:100%;text-align:center;color:#fff}
  .org-label{
    font-family:'Inter',sans-serif;
    font-size:10px;letter-spacing:4px;text-transform:uppercase;
    color:#C9A961;font-weight:600;margin-bottom:8px;
  }
  .cert-title{
    font-size:13px;letter-spacing:3px;text-transform:uppercase;
    color:#E5D4A6;font-weight:400;margin-bottom:20px;font-family:'Inter',sans-serif;
  }
  .cert-of{font-size:16px;color:#C9A961;font-weight:400;font-style:italic;margin-bottom:6px}
  .name{font-size:42px;font-weight:700;color:#fff;margin-bottom:4px;line-height:1.1}
  .archetype{
    font-size:18px;color:#C9A961;font-style:italic;margin-bottom:18px;
  }
  .body-text{
    font-size:13px;color:#E5D4A6;max-width:640px;margin:0 auto 20px;line-height:1.6;
    font-family:'Inter',sans-serif;font-weight:400;
  }
  .scores-table{
    border-collapse:collapse;margin:0 auto 20px;
    background:rgba(255,255,255,0.05);border-radius:6px;overflow:hidden;
  }
  .scores-table th{
    padding:6px 12px;font-family:'Inter',sans-serif;font-size:10px;
    letter-spacing:2px;text-transform:uppercase;color:#C9A961;font-weight:600;
    border-bottom:1px solid rgba(201,169,97,0.3);
  }
  .scores-table td{color:#fff}
  .footer{
    display:flex;justify-content:space-between;align-items:flex-end;
    width:100%;margin-top:auto;padding-top:16px;
    border-top:1px solid rgba(201,169,97,0.3);
  }
  .signatory{text-align:left}
  .sig-name{font-size:15px;font-weight:700;color:#fff}
  .sig-title{font-size:10px;color:#C9A961;font-family:'Inter',sans-serif;letter-spacing:1px}
  .verify-block{text-align:right}
  .verify-label{font-size:9px;font-family:'Inter',sans-serif;color:#C9A961;
    letter-spacing:2px;text-transform:uppercase;margin-bottom:2px}
  .verify-code{font-family:'Inter',sans-serif;font-size:14px;font-weight:700;
    color:#E5D4A6;letter-spacing:2px}
  .verify-url{font-family:'Inter',sans-serif;font-size:8px;color:#C9A961;margin-top:2px}
  .date-block{text-align:center}
  .date-label{font-size:9px;font-family:'Inter',sans-serif;color:#C9A961;
    letter-spacing:2px;text-transform:uppercase}
  .date-val{font-size:13px;color:#fff;font-weight:600}
  .gold-bar{width:80px;height:3px;background:#C9A961;margin:8px auto 16px}
</style>
</head>
<body>
<div class="overlay"></div>
<div class="content">
  <div class="org-label">CRIPFCnt Framework</div>
  <div class="cert-title">Certificate of Assessment</div>
  <div class="cert-of">This certifies that</div>
  <div class="name">${participantName}</div>
  <div class="gold-bar"></div>
  <div class="archetype">${archetypeName}${archetypeTagline ? ' — ' + archetypeTagline : ''}</div>
  <p class="body-text">
    has completed the CRIPFCnt 8 Quotients Assessment and has been mapped across the eight
    dimensions of Placement Intelligence as developed by Donald Mataranyika.
  </p>

  ${template?.showAllScores && scoreRows ? `
  <table class="scores-table">
    <thead><tr>
      <th>Quotient</th><th>Score</th><th>Level</th>
    </tr></thead>
    <tbody>${scoreRows}</tbody>
  </table>` : `
  <p class="body-text" style="font-size:15px;color:#C9A961;font-weight:600">
    Dominant Quotient: ${dominant?.name || ""} (${dominant?.score || 0}/100 — ${dominant?.band || ""})
  </p>
  `}

  <div class="footer">
    <div class="signatory">
      <div class="sig-name">${template?.signatoryName || "Donald Mataranyika"}</div>
      <div class="sig-title">${template?.signatoryTitle || "Founder, CRIPFCnt"}</div>
    </div>
    <div class="date-block">
      <div class="date-label">Date Issued</div>
      <div class="date-val">${issuedDate}</div>
    </div>
    <div class="verify-block">
      <div class="verify-label">Verification Code</div>
      <div class="verify-code">${verifyCode}</div>
      <div class="verify-url">cripfcnt.com/verify/8qt/${verifyCode}</div>
    </div>
  </div>
</div>
</body>
</html>`;

  // Launch Puppeteer and render PDF
  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"]
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1122, height: 794 });
  await page.setContent(html, { waitUntil: "networkidle0" });

  const filename = `8qt-cert-${verifyCode}.pdf`;
  const outputPath = path.join(OUTPUT_DIR, filename);

  await page.pdf({
    path: outputPath,
    width: "1122px",
    height: "794px",
    printBackground: true,
    landscape: true
  });
  await browser.close();

  const url = `/certificates/8qt/${filename}`;
  return { url, verifyCode };
}
