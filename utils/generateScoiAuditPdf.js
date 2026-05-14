// utils/generateScoiAuditPdf.js
// Renders the same template used in the browser view so the PDF matches exactly.

import fs from "fs";
import path from "path";

export async function generateScoiAuditPdf({ audit, req }) {

  // ── 1. Normalise to plain object ────────────────────────────────────────────
  const safeAudit =
    typeof audit.toObject === "function"
      ? audit.toObject({ getters: true, virtuals: false })
      : audit;

  if (!safeAudit || !safeAudit._id) {
    throw new Error("Invalid audit object - missing _id");
  }

  // ── 2. Determine which view template to use ─────────────────────────────────
  //   • Special audits  → admin/special_scoi_audit_view
  //   • Placement audits → scoi/audit_view
  //   Both templates must be available to express-handlebars.
  const isSpecial =
    safeAudit.auditKind === "special" ||
    safeAudit.auditType != null;        // SpecialScoiAudit has auditType field

  const templateName = isSpecial
    ? "admin/special_scoi_audit_view"
    : "scoi/audit_view";

  // ── 3. Ensure output directory exists ───────────────────────────────────────
  const baseDir = path.join(process.cwd(), "public", "docs", "scoi-audits");
  await fs.promises.mkdir(baseDir, { recursive: true });

  const filename = `scoi-${safeAudit._id}-${Date.now().toString(36)}.pdf`;
  const filepath  = path.join(baseDir, filename);

  // ── 4. Render HTML from the Handlebars template ─────────────────────────────
  const html = await new Promise((resolve, reject) => {
    req.app.render(
      templateName,
      {
        audit:  safeAudit,
        layout: false   // no wrapper layout - clean standalone HTML for PDF
      },
      (err, rendered) => (err ? reject(err) : resolve(rendered))
    );
  });

  // ── 5. Launch Puppeteer ──────────────────────────────────────────────────────
  let puppeteer;
  try {
    puppeteer = (await import("puppeteer")).default;
  } catch (err) {
    throw new Error("Puppeteer not available - PDF generation disabled");
  }

  const browser = await puppeteer.launch({
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
    headless: true
  });

  try {
    const page = await browser.newPage();

    // ── 6. Set content and wait for fonts / images to load ────────────────────
    await page.setContent(html, { waitUntil: "networkidle0" });

    // Load Google Fonts inline so they render in the PDF
    // (Puppeteer can't fetch external fonts unless they're embedded or the
    //  page is served over a real URL. The safest approach: inject a CSS block
    //  that falls back to system serif/sans so the layout matches.)
    await page.addStyleTag({
      content: `
        /* PDF font fallbacks - mirrors the view's font stack */
        @import url('https://fonts.googleapis.com/css2?family=Crimson+Pro:ital,wght@0,400;0,600;0,700;1,400;1,700&family=Inter:wght@400;500;600;700;800&display=swap');
      `
    });

    // Give fonts a moment to load
    await page.waitForTimeout(800).catch(() => {});

    await page.emulateMediaType("print");

    // ── 7. Generate PDF ────────────────────────────────────────────────────────
    await page.pdf({
      path: filepath,
      format: "A4",
      printBackground: true,   // required for the dark cover band, gold rules, etc.
      displayHeaderFooter: true,
      headerTemplate: `
        <div style="font-family:Inter,system-ui,sans-serif;font-size:9px;color:#94A3B8;
                    width:100%;padding:0 40px;box-sizing:border-box;text-align:right;">
          CRIPFCnt SCOI Framework - Confidential Intelligence Report
        </div>`,
      footerTemplate: `
        <div style="font-family:Inter,system-ui,sans-serif;font-size:9px;color:#94A3B8;
                    width:100%;padding:0 40px;box-sizing:border-box;
                    display:flex;justify-content:space-between;align-items:center;">
          <span>Donald Mataranyika · Chartered Secretary &amp; Governance Specialist</span>
          <span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span>
        </div>`,
      margin: {
        top:    "52px",
        right:  "0",
        bottom: "52px",
        left:   "0"
      }
    });

    console.log(`[PDF Generator] ✅ Generated: ${filename}`);

    return {
      filename,
      filepath,
      url: `/docs/scoi-audits/${filename}`
    };

  } finally {
    await browser.close();
  }
}