// services/courseCertPdf.js
// Generates the Course "Certificate of Competence" PDF using Puppeteer.
// Same proven pattern as services/eightQTCertPdf.js - only the builder and
// output folder differ.
//
//   1. launch  2. newPage  3. emulateMediaType("print")  BEFORE setContent
//   4. setContent(html, {waitUntil:"networkidle0"})  5. 1200ms font settle
//   6. page.pdf format:"A4", landscape:true, printBackground:true, zero margins
//
// Fonts: point COURSE_FONT_DIR at the same folder as your 8QT fonts, or drop
// Fraunces.ttf / Fraunces-Italic.ttf / Archivo.ttf into
// services/assets/course-fonts/. Optional: `npm i qrcode` for the QR image.

import puppeteer from "puppeteer";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import { buildCourseCertHtml } from "./courseCertTemplate.js";

export { buildCourseCertHtml };

const BASE_DIR = path.join(process.cwd(), "public", "certificates");

/**
 * @param {Object} p
 * @param {Object} p.cert  - display-ready course cert data (see template contract)
 * @param {Object} [p.template] - optional admin overrides (certTitle, signatory)
 * @returns {Promise<{url:string, verifyCode:string}>}
 */
export async function generateCourseCertPdf({ cert, template = {} }) {
  const tier = template?.tier === "module" ? "module" : "course";
  const OUTPUT_DIR = path.join(BASE_DIR, tier);
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  const verifyCode = (cert && cert.verifyCode) ||
    crypto.randomBytes(6).toString("hex").toUpperCase();

  const certData = { ...cert, verifyCode };

  const html = await buildCourseCertHtml({ cert: certData, template, verifyCode });

  const browser = await puppeteer.launch({
    headless: "new",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--font-render-hinting=none"
    ]
  });

  let page;
  try {
    page = await browser.newPage();
    await page.emulateMediaType("print");
    await page.setContent(html, { waitUntil: "networkidle0", timeout: 45000 });
    await new Promise(r => setTimeout(r, 1200));

    const filename   = `${tier}-cert-${verifyCode}.pdf`;
    const outputPath = `${OUTPUT_DIR}/${filename}`;

    await page.pdf({
      path:            outputPath,
      format:          "A4",
      landscape:       true,
      printBackground: true,
      margin:          { top: "0", bottom: "0", left: "0", right: "0" }
    });

    const url = `/certificates/${tier}/${filename}`;
    console.log(`[${tier} cert] ✅ Generated: ${url} (verify: ${verifyCode})`);
    return { url, verifyCode };
  } finally {
    try { await browser.close(); } catch (_) {}
  }
}