import fs from "fs";
import path from "path";

export async function generateScoiAuditPdf({ audit, req }) {
  const baseDir = path.join(process.cwd(), "public", "docs", "scoi-audits");
  await fs.promises.mkdir(baseDir, { recursive: true });

  const filename = `scoi-${audit._id}-${Date.now().toString(36)}.pdf`;
  const filepath = path.join(baseDir, filename);

  let puppeteer;
  try {
    puppeteer = (await import("puppeteer")).default;
  } catch {
    throw new Error("Puppeteer not available");
  }

  const browser = await puppeteer.launch({
    args: ["--no-sandbox", "--disable-setuid-sandbox"]
  });

  try {
    const page = await browser.newPage();

    // ✅ CRITICAL FIX:
    // Convert Mongoose document → plain object
    const safeAudit =
      typeof audit.toObject === "function"
        ? audit.toObject({ getters: true, virtuals: false })
        : audit;

    // 🔑 Render EXISTING view using safe data
    const html = await new Promise((resolve, reject) => {
      req.app.render(
        "admin/placement_audit_view",
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
      printBackground: true
    });

    return {
      filename,
      filepath,
      url: `/docs/scoi-audits/${filename}`
    };
  } finally {
    await browser.close();
  }
}
