import puppeteer from "puppeteer";
import fs from "fs";
import path from "path";

export async function htmlToPdfBuffer(html) {
  const browser = await puppeteer.launch({
    args: ['--no-sandbox','--disable-setuid-sandbox']
  });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "networkidle0" });
    const pdf = await page.pdf({ format: "A4", printBackground: true, margin: { top: "20mm", bottom: "20mm" } });
    return pdf;
  } finally {
    await browser.close();
  }
}

export async function htmlToPdfFile(html, outPath) {
  const buf = await htmlToPdfBuffer(html);
  await fs.promises.mkdir(path.dirname(outPath), { recursive: true });
  await fs.promises.writeFile(outPath, buf);
  return outPath;
}
