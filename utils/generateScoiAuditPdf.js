// utils/generateScoiAuditPdf.js
// Renders the same Handlebars template used in the browser view so the PDF matches exactly.
//
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ROOT-CAUSE FIX  (ProtocolError: Protocol error (Target.createTarget): Target closed)
// ──────────────────────────────────────────────────────────────────────────────
//
//  The flags  --single-process  and  --no-zygote  cause Chrome to crash with
//  "Trace/breakpoint trap" (SIGTRAP) immediately after launch on Linux VPS
//  kernels with seccomp enforcement (kernel 5.18+).
//
//  Chrome exits before the DevTools protocol can accept commands, so the very
//  next Puppeteer call — browser.newPage() — receives "Target closed."
//
//  FIX: remove both flags entirely. Chrome then runs in standard multi-process
//  mode, which works correctly on this server (confirmed by direct testing).
//
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

import fs   from "fs";
import path from "path";

export async function generateScoiAuditPdf({ audit, req }) {

  // ── 1. Normalise to plain object ────────────────────────────────────────────
  const safeAudit =
    typeof audit.toObject === "function"
      ? audit.toObject({ getters: true, virtuals: false })
      : audit;

  if (!safeAudit || !safeAudit._id) {
    throw new Error("Invalid audit object — missing _id");
  }

  // ── 2. Choose template ──────────────────────────────────────────────────────
  const isSpecial =
    safeAudit.auditClass === "special_report" ||
    safeAudit.auditType  != null;

  const templateName = isSpecial
    ? "admin/special_scoi_audit_view"
    : "scoi/audit_view";

  // ── 3. Ensure output directory exists ───────────────────────────────────────
  const baseDir  = path.join(process.cwd(), "public", "docs", "scoi-audits");
  await fs.promises.mkdir(baseDir, { recursive: true });

  const filename = `scoi-${safeAudit._id}-${Date.now().toString(36)}.pdf`;
  const filepath  = path.join(baseDir, filename);

  // ── 4. Render HTML from Handlebars template ─────────────────────────────────
  let html;
  try {
    html = await new Promise((resolve, reject) => {
      req.app.render(
        templateName,
        { audit: safeAudit, layout: false },
        (err, rendered) => (err ? reject(err) : resolve(rendered))
      );
    });
  } catch (renderErr) {
    throw new Error(`Template render failed (${templateName}): ${renderErr.message}`);
  }

  // ── 5. Import Puppeteer ─────────────────────────────────────────────────────
  let puppeteer;
  try {
    puppeteer = (await import("puppeteer")).default;
  } catch {
    try {
      puppeteer = (await import("puppeteer-core")).default;
    } catch {
      throw new Error("Puppeteer not installed — run: npm install puppeteer");
    }
  }

  // ── 6. Launch Chrome ────────────────────────────────────────────────────────
  //
  //  ✅  CORRECT flags for a Linux VPS:
  //
  //    --no-sandbox              Required when running as root or in containers
  //    --disable-setuid-sandbox  Same as above
  //    --disable-dev-shm-usage   Use /tmp instead of /dev/shm (safe on all VPS)
  //    --disable-gpu             Headless server — no GPU available
  //    --no-first-run            Skip first-run setup dialog
  //    --no-default-browser-check  Skip browser-check prompt
  //
  //  ❌  REMOVED — these crash Chrome on this server:
  //
  //    --single-process   Causes SIGTRAP on Linux kernel 5.18+ with seccomp;
  //                       Chrome exits instantly → browser.newPage() = "Target closed"
  //    --no-zygote        Paired with --single-process; removing that flag makes
  //                       this one unnecessary and potentially destabilising

  const browser = await puppeteer.launch({
    headless: "new",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--disable-background-networking",
      "--disable-sync",
      "--metrics-recording-only",
      "--mute-audio"
    ]
  });

  try {
    const page = await browser.newPage();

    // ── 7. Inject fonts and render HTML ────────────────────────────────────────
    // Inject the Google Fonts @import directly into <head> so Puppeteer can
    // load them from the CDN. networkidle2 waits for fonts to finish loading.
    const fontsBlock = `<style>
      @import url('https://fonts.googleapis.com/css2?family=Crimson+Pro:ital,wght@0,400;0,600;0,700;1,400;1,700&family=Inter:wght@400;500;600;700;800&display=swap');
    </style>`;

    const htmlWithFonts = html.includes("<head>")
      ? html.replace("<head>", `<head>${fontsBlock}`)
      : fontsBlock + html;

    await page.setContent(htmlWithFonts, {
      waitUntil: "networkidle2",
      timeout:   30000
    });

    // Extra 1s for fonts to render after network settles
    await new Promise(r => setTimeout(r, 1000));

    await page.emulateMediaType("print");

    // ── 8. Print to PDF ─────────────────────────────────────────────────────────
    await page.pdf({
      path:                filepath,
      format:              "A4",
      printBackground:     true,
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
    // Always close — even if pdf() throws — to avoid zombie Chrome processes
    await browser.close().catch(() => {});
  }
}