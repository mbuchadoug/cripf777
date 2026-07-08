// services/eightQTCertPdf.js
// Generates the 8QT certificate PDF using Puppeteer.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THE OLD (teal/chevron) CERTIFICATE KEPT BEING ISSUED
//
// BUG A: This file used to contain its OWN buildEightQTCertHtml function —
//   ~390 lines of the old teal table-layout design — defined right here.
//   generateEightQTCertPdf() called that LOCAL function, so the new
//   services/eightQTCertTemplate.js sat on disk completely unused. JavaScript
//   resolves the local name first; no error, no warning, old design forever.
//   THE FIX: the old builder is DELETED from this file. The HTML now comes
//   exclusively from ./eightQTCertTemplate.js (forest-green / gold design,
//   dummy "Authorised Signatory", octagonal radar, QR verify).
//
// BUG B: The new builder is ASYNC (it embeds fonts and generates the QR).
//   The old call site was synchronous: `const html = buildEightQTCertHtml(...)`.
//   Splicing the import without `await` would have rendered the literal string
//   "[object Promise]" into the PDF.
//   THE FIX: `const html = await buildEightQTCertHtml(...)`.
//
// BUG C: Name collision. Both files exported buildEightQTCertHtml, so any
//   other module importing it from HERE still got the old design.
//   THE FIX: this file now RE-EXPORTS the new builder, so existing imports
//   from "./eightQTCertPdf.js" keep working and get the new design.
//
// Nothing else changed: same OUTPUT_DIR, same verifyCode format (12 hex,
// uppercase), same filename pattern, same { url, verifyCode } return shape.
// All four call sites — admin preview-cert, issue-cert, regenerate-cert, and
// the Stripe webhook — keep working with ZERO changes to them.
//
// REQUIREMENTS on the server:
//   services/eightQTCertTemplate.js            (the new HTML builder)
//   services/assets/8qt-fonts/Fraunces.ttf
//   services/assets/8qt-fonts/Fraunces-Italic.ttf
//   services/assets/8qt-fonts/Archivo.ttf
//   npm i qrcode        (optional — QR box renders text-only without it)
// ─────────────────────────────────────────────────────────────────────────────

import puppeteer from "puppeteer";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import { buildEightQTCertHtml } from "./eightQTCertTemplate.js";

// Re-export so any module that imported the builder from this file
// automatically gets the NEW design (fixes the name-collision path).
export { buildEightQTCertHtml };

const OUTPUT_DIR = path.join(process.cwd(), "public", "certificates", "8qt");

// ─────────────────────────────────────────────────────────────────────────────
// PDF GENERATION — proven working sequence, unchanged:
//   1. launch
//   2. newPage
//   3. emulateMediaType("print")   ← BEFORE setContent
//   4. setContent(html, {waitUntil:"networkidle0"})
//   5. 1200ms font-settle delay
//   6. page.pdf with format:"A4", landscape:true, printBackground:true, zero margins
//
// Do NOT use setViewport — it conflicts with page.pdf's paper size.
// Do NOT pass width/height to page.pdf when using format — they override each other.
// ─────────────────────────────────────────────────────────────────────────────
export async function generateEightQTCertPdf({ attempt, template, archetype }) {
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  const verifyCode = attempt.certificateVerifyCode ||
    crypto.randomBytes(6).toString("hex").toUpperCase();

  // Stamp verifyCode onto attempt object so the builder can embed it
  attempt = { ...attempt, certificateVerifyCode: verifyCode };

  // NEW DESIGN — built by services/eightQTCertTemplate.js.
  // MUST be awaited: the builder is async (font embed + QR generation).
  const html = await buildEightQTCertHtml({ attempt, template, archetype, verifyCode });

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
      // Do NOT pass width/height here — format:"A4" already sets the paper size.
    });

    const url = `/certificates/8qt/${filename}`;
    console.log(`[8qt cert] ✅ Generated (new design): ${url} (verify: ${verifyCode})`);
    return { url, verifyCode };

  } finally {
    try { await browser.close(); } catch (_) {}
  }
}