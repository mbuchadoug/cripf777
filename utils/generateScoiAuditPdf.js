// utils/generateScoiAuditPdf.js
// Renders the same template used in the browser view so the PDF matches exactly.
// FIX: Corrected puppeteer launch, content injection, font loading, and error handling.

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
  const isSpecial =
    safeAudit.auditClass === "special_report" ||
    safeAudit.auditType != null;

  const templateName = isSpecial
    ? "admin/special_scoi_audit_view"
    : "scoi/audit_view";

  // ── 3. Ensure output directory exists ───────────────────────────────────────
  const baseDir = path.join(process.cwd(), "public", "docs", "scoi-audits");
  await fs.promises.mkdir(baseDir, { recursive: true });

  const filename = `scoi-${safeAudit._id}-${Date.now().toString(36)}.pdf`;
  const filepath  = path.join(baseDir, filename);

  // ── 4. Render HTML from the Handlebars template ─────────────────────────────
  let html;
  try {
    html = await new Promise((resolve, reject) => {
      req.app.render(
        templateName,
        {
          audit:  safeAudit,
          layout: false   // no wrapper layout
        },
        (err, rendered) => (err ? reject(err) : resolve(rendered))
      );
    });
  } catch (renderErr) {
    throw new Error(`Template render failed (${templateName}): ${renderErr.message}`);
  }

  // ── 5. Launch Puppeteer ──────────────────────────────────────────────────────
  let puppeteer;
  try {
    puppeteer = (await import("puppeteer")).default;
  } catch {
    throw new Error("Puppeteer not installed — run: npm install puppeteer");
  }

  // FIX: Detect if running in a headless/server environment
  const browser = await puppeteer.launch({
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",    // FIX: prevents crashes in Docker/low-mem
      "--disable-gpu",              // FIX: headless server compatibility
      "--no-zygote",
      "--single-process"            // FIX: avoids fork issues on some hosts
    ],
    headless: "new"                  // FIX: use new headless mode (Puppeteer ≥20)
  });

  try {
    const page = await browser.newPage();

    // ── 6. Inject HTML with fonts pre-loaded ─────────────────────────────────
    // FIX: Use setContent with a base URL so relative assets (CSS, images) resolve
    const baseUrl = process.env.SITE_URL
      ? process.env.SITE_URL.replace(/\/$/, "")
      : `${req.protocol}://${req.get("host")}`;

    // FIX: Inject Google Fonts directly into the HTML before rendering
    // so Puppeteer doesn't need external network access at render time.
    const fontsBlock = `
      <style>
        @import url('https://fonts.googleapis.com/css2?family=Crimson+Pro:ital,wght@0,400;0,600;0,700;1,400;1,700&family=Inter:wght@400;500;600;700;800&display=swap');
      </style>`;

    // Insert font block right after <head>
    const htmlWithFonts = html.includes("<head>")
      ? html.replace("<head>", `<head>${fontsBlock}`)
      : fontsBlock + html;

    // FIX: setContent with networkidle2 (not networkidle0) to avoid font timeout
    await page.setContent(htmlWithFonts, {
      waitUntil: "networkidle2",
      timeout: 30000
    });

    // Give fonts 1.2s to load (covers slow CDN responses)
    await new Promise(r => setTimeout(r, 1200));

    await page.emulateMediaType("print");

    // ── 7. Generate PDF ────────────────────────────────────────────────────────
    await page.pdf({
      path: filepath,
      format: "A4",
      printBackground: true,
      displayHeaderFooter: true,
      headerTemplate: `
        <div style="font-family:Arial,sans-serif;font-size:9px;color:#94A3B8;
                    width:100%;padding:0 40px;box-sizing:border-box;text-align:right;">
          CRIPFCnt SCOI Framework &mdash; Confidential Intelligence Report
        </div>`,
      footerTemplate: `
        <div style="font-family:Arial,sans-serif;font-size:9px;color:#94A3B8;
                    width:100%;padding:0 40px;box-sizing:border-box;
                    display:flex;justify-content:space-between;align-items:center;">
          <span>Donald Mataranyika &middot; Chartered Secretary &amp; Governance Specialist</span>
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


// ── Express route handler ─────────────────────────────────────────────────────
// Mount this in your admin router:
//
//   import { scoiAuditPdfRoute } from "../utils/generateScoiAuditPdf.js";
//   router.post("/admin/special-scoi-audits/:id/generate-pdf", ensureAuth, scoiAuditPdfRoute);
//   router.get("/admin/special-scoi-audits/:id/download-pdf",  ensureAuth, scoiAuditPdfRoute);
//
// OR add these routes directly inside admin_special_scoi_view.js

export async function scoiAuditPdfRoute(req, res) {
  try {
    // Dynamically import the model (avoids circular dep issues)
    let SpecialScoiAudit;
    try {
      SpecialScoiAudit = (await import("../models/specialScoiAudit.js")).default;
    } catch {
      return res.status(500).json({ success: false, error: "Model not found" });
    }

    const audit = await SpecialScoiAudit.findById(req.params.id);
    if (!audit) {
      return res.status(404).json({ success: false, error: "Audit not found" });
    }

    // If PDF already exists and is recent, serve it directly
    if (audit.pdfUrl) {
      const existingPath = path.join(process.cwd(), "public", audit.pdfUrl);
      if (fs.existsSync(existingPath)) {
        // For GET download requests
        if (req.method === "GET") {
          return res.download(existingPath, `SCOI-Audit-${audit.subject?.name || audit._id}.pdf`);
        }
        // For POST generate requests — return existing URL
        return res.json({ success: true, url: audit.pdfUrl, cached: true });
      }
    }

    // Generate new PDF
    const result = await generateScoiAuditPdf({ audit, req });

    // FIX: Save pdfUrl back to the audit record so next request serves from cache
    await SpecialScoiAudit.findByIdAndUpdate(audit._id, {
      $set: { pdfUrl: result.url }
    });

    // For GET download requests — stream the file
    if (req.method === "GET") {
      return res.download(result.filepath, `SCOI-Audit-${audit.subject?.name || audit._id}.pdf`);
    }

    return res.json({ success: true, url: result.url, filename: result.filename });

  } catch (err) {
    console.error("[SCOI PDF route]", err);
    return res.status(500).json({
      success: false,
      error: err.message || "PDF generation failed"
    });
  }
}