// utils/generateScoiAuditPdf.js - FIXED VERSION

import fs from "fs";
import path from "path";

export async function generateScoiAuditPdf({ audit, req }) {
  // ✅ FIX: Convert to plain object first
  const safeAudit = 
    typeof audit.toObject === "function" 
      ? audit.toObject({ getters: true, virtuals: false }) 
      : audit;

  // ✅ FIX: Validate audit has required data
  if (!safeAudit || !safeAudit._id) {
    throw new Error("Invalid audit object - missing _id");
  }

  const baseDir = path.join(process.cwd(), "public", "docs", "scoi-audits");
  await fs.promises.mkdir(baseDir, { recursive: true });

  const filename = `scoi-${safeAudit._id}-${Date.now().toString(36)}.pdf`;
  const filepath = path.join(baseDir, filename);

  let puppeteer;
  try {
    puppeteer = (await import("puppeteer")).default;
  } catch (err) {
    console.error("[PDF Generator] Puppeteer not available:", err.message);
    throw new Error("Puppeteer not available - PDF generation disabled");
  }

  const browser = await puppeteer.launch({
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
    headless: true
  });

  try {
    const page = await browser.newPage();

    // 🔑 Render EXISTING view using safe data
    const html = await new Promise((resolve, reject) => {
      // Use the audit view template
      req.app.render(
        "scoi/audit_view", // ← Updated to correct template
        {
          audit: safeAudit,
          layout: false // important for clean PDF
        },
        (err, rendered) => (err ? reject(err) : resolve(rendered))
      );
    });

    await page.setContent(html, { waitUntil: "networkidle0" });
    await page.emulateMediaType("screen");

    await page.pdf({
      path: filepath,
      format: "A4",
      printBackground: true,
      margin: {
        top: "20px",
        right: "20px",
        bottom: "20px",
        left: "20px"
      }
    });

    console.log(`[PDF Generator] ✅ Generated: ${filename}`);

    return {
      filename,
      filepath,
      url: `/docs/scoi-audits/${filename}`
    };
  } catch (err) {
    console.error("[PDF Generator] Error:", err);
    throw err;
  } finally {
    await browser.close();
  }
}