import express from "express";
import { Router } from "express";
import twilio from "twilio";
import fs from "fs";
import path from "path";
import axios from "axios";
import MessagingResponse from "twilio/lib/twiml/MessagingResponse.js";
import { dispatchAction } from "../services/actionDispatcher.js";
import Business from "../models/business.js";
import Client from "../models/client.js";
import { sendButtons } from "../services/metaSender.js";

import Branch from "../models/branch.js";
import UserRole from "../models/userRole.js";
import Invoice from "../models/invoice.js";
import Payment from "../models/payment.js";
import Receipt from "../models/receipt.js";
import Expense from "../models/expense.js";

import UserSession from "../models/userSession.js";

//import { PACKAGES } from "../config/packages.js";

import PACKAGES from "../config/packages.js";
import { PACKAGE_FEATURES } from "../config/packageFeatures.js";

function canUseFeature(biz, featureKey) {
  const pkg = biz?.package || "trial";
  return !!PACKAGE_FEATURES[pkg]?.[featureKey];
}
function blockedMessage(res) {
  return sendTwimlText(
    res,
`🔒 Feature locked

Upgrade to *Gold* to unlock weekly & monthly reports.

Reply *upgrade* to see plans.`
  );
}


function isTrial(biz) {
  return biz?.subscriptionStatus === "trial";
}

function isTrialExpired(biz) {
  if (!biz) return false;
  if (biz.subscriptionStatus !== "trial") return false;
  if (!biz.trialEndsAt) return false;

  return Date.now() > new Date(biz.trialEndsAt).getTime();
}



function checkMonthlyLimit(biz) {
  const pkg = PACKAGES[biz.package || "bronze"];
  const monthKey = new Date().toISOString().slice(0, 7);

  if (biz.documentCountMonthKey !== monthKey) {
    biz.documentCountMonth = 0;
    biz.documentCountMonthKey = monthKey;
  }

  if (biz.documentCountMonth >= pkg.documentsPerMonth) {
    return {
      allowed: false,
      limit: pkg.documentsPerMonth
    };
  }

  return { allowed: true };
}

function canAccessAdvancedReports(biz) {
  const pkgKey = biz.package || "bronze";
  // Only Gold and above get advanced reports
  return ["gold", "enterprise"].includes(pkgKey);
}

let PDFDocument;
try {
  PDFDocument = await (async () => {
    try {
      return (await import("pdfkit")).default || (await import("pdfkit"));
    } catch (e) {
      try { return require("pdfkit"); } catch (er) { return null; }
    }
  })();
} catch (e) {
  PDFDocument = null;
}

// optional: try to use puppeteer-core if present (or puppeteer)
let puppeteer = null;
try {
  // prefer puppeteer-core/pupeteer if installed
  puppeteer = await (async () => {
    try { return (await import("puppeteer")).default || (await import("puppeteer")); } catch (e) {}
    try { return (await import("puppeteer-core")).default || (await import("puppeteer-core")); } catch (e) {}
    return null;
  })();
} catch (e) {
  puppeteer = null;
}

const router = Router();
router.use(express.urlencoded({ extended: true }));

/* ---------- Helpers ---------- */

function sendTwimlText(res, text) {
  try {
    const twiml = new MessagingResponse();
    twiml.message(text || "");
    res.set("Content-Type", "text/xml");
    return res.send(twiml.toString());
  } catch (e) {
    res.set("Content-Type", "text/plain");
    return res.send(String(text || ""));
  }
}


function sendWithMenuHint(res, text) {
  const suffix = "\n\n👉 Reply *menu* to continue.";
  return sendTwimlText(res, (text || "") + suffix);
}

function sendTwimlWithMedia(res, text, mediaUrls = []) {
  try {
    const twiml = new MessagingResponse();
    const msg = twiml.message();
    // if text is null/undefined/empty we do not set body (so no download/link text)
    if (text) msg.body(text);
    for (const m of (mediaUrls || [])) {
      if (m) msg.media(m);
    }
    res.set("Content-Type", "text/xml");
    return res.send(twiml.toString());
  } catch (e) {
    console.error("sendTwimlWithMedia error:", e);
    return sendTwimlText(res, text || "");
  }
}

function formatMoney(n) { return Number(n || 0).toFixed(2); }

function normalizePhone(input) {
  if (!input) return null;

  let phone = input.replace(/\D+/g, "");

  // Zimbabwe normalization
  if (phone.startsWith("0")) {
    phone = "263" + phone.slice(1);
  }

  if (phone.startsWith("263") && phone.length === 12) {
    return phone;
  }

  return null;
}


/* ---------- Role guard ---------- */
async function requireRole(biz, providerId, allowed = []) {
  const role = await UserRole.findOne({
    businessId: biz._id,
    phone: providerId
  });

  if (!role || !allowed.includes(role.role)) {
    return false;
  }
  return true;
}

async function getUserBranchContext(biz, providerId) {
  const role = await UserRole.findOne({
    businessId: biz._id,
    phone: providerId
  });

  if (!role) {
    return { role: null, branchId: null };
  }

  return {
    role: role.role,          // owner | manager | clerk
    branchId: role.branchId   // ObjectId
  };
}


/* ---------- small save helper to mark sessionData modified ---------- */
async function saveBiz(biz) {
  try {
    if (biz && typeof biz.markModified === "function") biz.markModified("sessionData");
    return biz.save();
  } catch (e) {
    return biz.save();
  }
}

/* ---------- Twilio request verification (unchanged) ---------- */
function verifyTwilioRequest(req) {
  if (process.env.DEBUG_TWILIO_BIZ_SKIP_VERIFY === "1" || process.env.DEBUG_TWILIO_SKIP_VERIFY === "1") {
    console.log("TWILIO_VERIFY (biz): DEBUG skip enabled");
    return true;
  }
  const authToken = process.env.TWILIO_BIZ_AUTH_TOKEN || process.env.TWILIO_AUTH_TOKEN;
  if (!authToken) {
    console.warn("TWILIO_VERIFY (biz): TWILIO_BIZ_AUTH_TOKEN and TWILIO_AUTH_TOKEN not set — skipping verification (dev)");
    return true;
  }
  try {
    const signature = req.header("x-twilio-signature");
    const configuredSite = (process.env.SITE_URL || "").replace(/\/$/, "");
    let url;
    if (configuredSite) {
      url = `${configuredSite}${req.originalUrl}`;
    } else {
      const proto = (req.get("x-forwarded-proto") || req.protocol || "https").split(",")[0].trim();
      const host = req.get("host");
      if (!host) {
        console.warn("TWILIO_VERIFY (biz): no host header; cannot verify");
        return false;
      }
      url = `${proto}://${host}${req.originalUrl}`;
    }
    const params = Object.assign({}, req.body || {});
    const ok = twilio.validateRequest(authToken, signature, url, params);
    if (!ok) console.warn("TWILIO_VERIFY (biz): signature invalid for", url, "signature:", signature);
    return ok;
  } catch (e) {
    console.warn("TWILIO_VERIFY (biz): error:", e?.message || e);
    return false;
  }
}

/* ---------- File counters (fallback) ---------- */
const DATA_DIR = path.join(process.cwd(), "data");
const COUNTER_FILE = path.join(DATA_DIR, "admin_counters.json");
async function ensureDataDir() { try { await fs.promises.mkdir(DATA_DIR, { recursive: true }); } catch (e) {} }
async function loadCounters() {
  await ensureDataDir();
  try { const raw = await fs.promises.readFile(COUNTER_FILE, "utf8"); return JSON.parse(raw || "{}"); } catch (e) { return { invoice: 0, quote: 0, receipt: 0 }; }
}
async function saveCounters(obj) { await ensureDataDir(); await fs.promises.writeFile(COUNTER_FILE, JSON.stringify(obj, null, 2), "utf8"); }
async function incrementCounter(type) { const counters = await loadCounters(); if (!counters[type]) counters[type] = 0; counters[type] = Number(counters[type]) + 1; await saveCounters(counters); return counters[type]; }

/* ---------- PDF helpers (attempt puppeteer HTML render, fallback to pdfkit) ---------- */
async function ensurePublicSubdirs() {
  const base = path.join(process.cwd(), "public", "docs", "generated");
  await fs.promises.mkdir(base, { recursive: true });

  // ✅ ADD "statements" HERE
  for (const sub of ["invoices", "quotes", "receipts", "statements"]) {
    await fs.promises.mkdir(path.join(base, sub), { recursive: true });
  }

  return base;
}

/**
 * Renders given HTML to a PDF file path using Puppeteer (preferred).
 * Throws if puppeteer is not available or fails to launch.
 */
async function renderHtmlToPdf(html, filepath) {
  if (!puppeteer) throw new Error("Puppeteer not available");
  // launch options: prefer environment executable path if provided
  const launchOptions = {
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  };
  // If user set an explicit executable path (for system Chrome/Chromium)
  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    launchOptions.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
  }
  // Allow custom options via env (stringified JSON)
  if (process.env.PUPPETEER_LAUNCH_OPTS) {
    try {
      const extra = JSON.parse(process.env.PUPPETEER_LAUNCH_OPTS);
      Object.assign(launchOptions, extra);
    } catch (e) {
      console.warn("Invalid PUPPETEER_LAUNCH_OPTS JSON, ignoring");
    }
  }

  // Try to launch
  const browser = await puppeteer.launch(launchOptions);
  try {
    const page = await browser.newPage();
    // allow remote content (bootstrap), set timeout
    await page.setContent(html, { waitUntil: "networkidle0", timeout: 30000 });
    await page.emulateMediaType("screen");
    await page.pdf({ path: filepath, format: "A4", printBackground: true, margin: { top: "20mm", bottom: "20mm", left: "12mm", right: "12mm" } });
  } finally {
    try { await browser.close(); } catch (e) {}
  }
}

/**
 * Fallback pdfkit generator (keeps the earlier simple layout)
 * used if Puppeteer isn't available or fails.
 *
 * NOTE: Updated to remove "Description" column (prints item name instead) and include discount/vat.
 */
function drawTablePdfkit(doc, items, startX, startY, columnWidths, docDiscountPercent = 0) {
  const lineHeight = 18;
  let y = startY;
  doc.fontSize(10).fillColor("black");
  // header: Item | Qty | Unit | Discount | Total
  doc.text("Item", startX, y, { width: columnWidths[0] });
  doc.text("Qty", startX + columnWidths[0] + 10, y, { width: columnWidths[1], align: "right" });
  doc.text("Unit", startX + columnWidths[0] + 10 + columnWidths[1] + 10, y, { width: columnWidths[2], align: "right" });
  doc.text("Discount (%)", startX + columnWidths[0] + 10 + columnWidths[1] + 10 + columnWidths[2] + 10, y, { width: columnWidths[3], align: "right" });
  doc.text("Total", startX + columnWidths[0] + 10 + columnWidths[1] + 10 + columnWidths[2] + 10 + columnWidths[3] + 10, y, { width: columnWidths[4], align: "right" });
  y += lineHeight;
  try {
    const totalColsWidth = columnWidths.reduce((a,b) => a + b, 0) + 40;
    doc.moveTo(startX, y - 6).lineTo(startX + totalColsWidth, y - 6).strokeOpacity(0.08).stroke();
  } catch(e) {}
  for (const it of items) {
    doc.fontSize(10).fillColor("black");
    const itemName = it.item || it.description || "";
    const qty = Number(it.qty || it.quantity || 1);
    const unit = Number(it.unit || it.rate || 0);
    const amount = qty * unit;
    const rowDiscount = (typeof it.discount !== "undefined" && it.discount !== null) ? Number(it.discount) : Number(docDiscountPercent || 0);

    doc.text(itemName, startX, y, { width: columnWidths[0] });
    doc.text(String(qty), startX + columnWidths[0] + 10, y, { width: columnWidths[1], align: "right" });
    doc.text(formatMoney(unit), startX + columnWidths[0] + 10 + columnWidths[1] + 10, y, { width: columnWidths[2], align: "right" });
    doc.text(formatMoney(rowDiscount), startX + columnWidths[0] + 10 + columnWidths[1] + 10 + columnWidths[2] + 10, y, { width: columnWidths[3], align: "right" });
    doc.text(formatMoney(amount), startX + columnWidths[0] + 10 + columnWidths[1] + 10 + columnWidths[2] + 10 + columnWidths[3] + 10, y, { width: columnWidths[4], align: "right" });
    y += lineHeight;
  }
  return y;
}

/* ---------- generatePDF: Puppeteer-first, Bootstrap 3.3.7 design, PDFKit fallback ---------- */
/* ---------- generatePDF: Puppeteer-first, Bootstrap 3.3.7 design, PDFKit fallback ---------- */
async function generatePDF({ 
  type,
  number,
  date,
  dueDate,
  billingTo,
  email,
  items = [],
  ledger = [],   // 👈 ADD THIS
  notes = "",
  bizMeta = {}
}) {

    // ✅ ADD THIS LINE
  const baseDir = await ensurePublicSubdirs();
const folder = path.join(
  baseDir,
  type === "invoice"
    ? "invoices"
    : type === "quote"
    ? "quotes"
    : type === "statement"
    ? "statements"
    : "receipts"
);

  const safeNumber = number || "statement";
const filename = `${type}-${safeNumber}-${Date.now()}.pdf`;

  const filepath = path.join(folder, filename);

  // --- Resolve and possibly inline logo as data URI (prefer local file under public/docs/logos) ---
  const rawLogoUrl = (bizMeta.logoUrl || "").trim();
  let logoForHtml = ""; // will be either data:... or an absolute/http url or empty

  try {
    if (rawLogoUrl) {
      // if logoUrl is root-relative (/docs/...), or full SITE_URL + /docs/..., map to local path
      const site = (process.env.SITE_URL || "").replace(/\/$/, "");
      // extract the path part (e.g. /docs/logos/logo-<id>.png)
      let logoPathPart = null;
      if (rawLogoUrl.startsWith("/")) {
        logoPathPart = rawLogoUrl;
      } else if (site && rawLogoUrl.startsWith(site)) {
        logoPathPart = rawLogoUrl.slice(site.length);
      } else {
        // maybe it's already absolute with different host; try to find `/docs/logos/...` segment
        const idx = rawLogoUrl.indexOf("/docs/logos/");
        if (idx !== -1) logoPathPart = rawLogoUrl.slice(idx);
      }

      if (logoPathPart && logoPathPart.startsWith("/img/")) {
        const logoFilename = path.basename(logoPathPart);
       const localLogo = path.join(process.cwd(), "public", logoPathPart);

        if (fs.existsSync(localLogo)) {
          try {
            const data = await fs.promises.readFile(localLogo);
            // try to determine mime type by extension
            const ext = path.extname(localLogo).toLowerCase();
            let mime = "image/png";
            if (ext === ".jpg" || ext === ".jpeg") mime = "image/jpeg";
            else if (ext === ".gif") mime = "image/gif";
            else if (ext === ".svg") mime = "image/svg+xml";
            const b64 = data.toString("base64");
            logoForHtml = `data:${mime};base64,${b64}`;
          } catch (readErr) {
            console.warn("generatePDF: failed to read local logo, falling back to URL", readErr);
            logoForHtml = rawLogoUrl; // fallback to using URL
          }
        } else {
          // local file not present, fallback to using the provided URL
          logoForHtml = rawLogoUrl;
        }
      } else {
        // not a local docs path; use URL as-is
        logoForHtml = rawLogoUrl;
      }
    }
  } catch (e) {
    console.warn("generatePDF: logo inlining failed, using URL fallback", e);
    logoForHtml = rawLogoUrl || "";
  }

  // Build HTML from template (bootstrap 3.3.7 + your layout)
  function buildHtml() {
const typeLabel =
  type === "invoice" ? "INVOICE" :
  type === "quote" ? "QUOTATION" :
  type === "statement" ? "STATEMENT" :
  "RECEIPT";
if (type === "statement") {
  const rows = ledger.map(r => `
    <tr>
      <td>${new Date(r.date).toISOString().slice(0,10)}</td>
      <td>${escapeHtml(r.ref || "")}</td>
      <td style="text-align:right">${r.debit ? formatMoney(r.debit) : "-"}</td>
      <td style="text-align:right">${r.credit ? formatMoney(r.credit) : "-"}</td>
      <td style="text-align:right">${formatMoney(r.balance)}</td>
    </tr>
  `).join("");

  return `
<!doctype html>
<html>
<head>
  <meta charset="utf-8"/>
  <title>Client Statement</title>
  <style>
    body { font-family: Arial; padding: 20px; }
    table { width:100%; border-collapse:collapse; margin-top:20px; }
    th, td { border:1px solid #333; padding:8px; font-size:12px; }
    th { background:#f2f2f2; }
  </style>
</head>
<body>

  <h2>${escapeHtml(bizMeta.name || "")}</h2>
  <div style="margin-top:6px; font-weight:600;">
    Client: ${escapeHtml(billingTo || "—")}
  </div>
  <div style="font-size:12px; color:#666;">
    Date: ${new Date().toISOString().slice(0,10)}
  </div>

  <h3 style="margin-top:20px;">Statement</h3>

  <table>
    <thead>
      <tr>
        <th>Date</th>
        <th>Ref</th>
        <th>Debit</th>
        <th>Credit</th>
        <th>Balance</th>
      </tr>
    </thead>
    <tbody>
      ${rows}
    </tbody>
  </table>

</body>
</html>`;
}

    const companyName = bizMeta.name || "";
    const logoUrl = logoForHtml || "";
    const companyAddress = bizMeta.address || "";

    const discountPercentDoc = Number(bizMeta.discountPercent || 0);
const rowsHtml =
  type === "statement"
    ? ledger.map(r => `
        <tr>
          <td>${r.date}</td>
          <td>${r.ref}</td>
          <td style="text-align:right;">${formatMoney(r.debit)}</td>
          <td style="text-align:right;">${formatMoney(r.credit)}</td>
          <td style="text-align:right;">${formatMoney(r.balance)}</td>
        </tr>
      `).join("")
    : items.map(it => {
        const qty = Number(it.qty || 1);
        const rate = Number(it.unit || it.rate || 0);
        const discount = Number(it.discount || 0);
        const amount = qty * rate;

        return `
          <tr>
            <td style="text-align:center;">${qty}</td>
            <td>${escapeHtml(it.item || "")}</td>
            <td style="text-align:right;">${formatMoney(rate)}</td>
            <td style="text-align:right;">${formatMoney(discount)}</td>
            <td style="text-align:right;">${formatMoney(amount)}</td>
          </tr>
        `;
      }).join("");


    const subtotal = items.reduce((s, it) => s + (Number(it.qty || it.quantity || 0) * Number(it.unit || it.rate || 0)), 0);
    const discountPercent = Number(bizMeta.discountPercent || 0);
    const discountAmount = +(subtotal * (discountPercent / 100));
    const taxableBase = subtotal - discountAmount;
    const vatPercent = Number(bizMeta.vatPercent || 0);
    const applyVat = (bizMeta.applyVat === false) ? false : true;
    const vat = applyVat ? +(taxableBase * (vatPercent/100)) : 0;
    const total = taxableBase + vat;

    return `
<!doctype html>
<html>
<head>
  <meta charset="utf-8"/>
  <title>${escapeHtml(typeLabel)} ${escapeHtml(number)}</title>
  <link rel="stylesheet" href="https://maxcdn.bootstrapcdn.com/bootstrap/3.3.7/css/bootstrap.min.css">
  <style>
    @page{ margin:0; }
    body{ font-family: Arial, Helvetica, sans-serif; padding:18px; color:#222; }
    .top{ display:flex; align-items:center; justify-content:space-between; }
    .brand{ display:flex; align-items:center; gap:12px; }
    .brand img{ max-height:90px; max-width:200px; object-fit:contain; }
    .company-name{ font-size:20px; font-weight:700; }
    .meta{text-align:right;}
    table.items{ width:100%; border-collapse:collapse; margin-top:18px; }
    table.items th, table.items td{ border:1px solid #222; padding:8px; font-size:12px; }
    table.items th{ background:#f2f2f2; font-weight:700; text-align:center; }
    .totals{ width:320px; float:right; margin-top:12px; border:1px solid #222; border-collapse:collapse; }
    .totals td{ padding:8px; border-bottom:1px solid #222; }
    .totals tr:last-child td{ font-weight:800; font-size:14px; }
    body { margin: 0!important; }
  </style>
</head>
<body>
  <div class="top">
    <div class="brand">
    ${logoUrl
      ? `<div style="display:flex; align-items:center; gap:12px;"><img src="${escapeHtml(logoUrl)}" alt="logo" /><div><div class="company-name">${escapeHtml(companyName)}</div><div style="font-size:12px; color:#555;">${escapeHtml(companyAddress)}</div></div></div>`
      : `<div><div class="company-name">${escapeHtml(companyName)}</div><div style="font-size:12px; color:#555;">${escapeHtml(companyAddress)}</div></div>`
    }
  </div>

    <div class="meta">
      <div style="font-weight:700; font-size:16px">${escapeHtml(typeLabel)}</div>
      <div style="margin-top:6px">No: <strong>${escapeHtml(number)}</strong></div>
      <div style="margin-top:6px">Date: ${escapeHtml(date.toISOString().slice(0,10))}</div>
      ${ dueDate ? `<div>Due: ${escapeHtml(dueDate.toISOString().slice(0,10))}</div>` : ""}
    </div>
  </div>

  <div style="margin-top:18px; display:flex; justify-content:space-between;">
    <div>
      <div style="font-size:12px; color:#666;">Bill To</div>
      <div style="font-weight:700; margin-top:6px;">${escapeHtml(billingTo || "")}</div>
      ${ email ? `<div style="font-size:12px; color:#666;">${escapeHtml(email)}</div>` : "" }
    </div>

    <div style="text-align:right; font-size:12px; color:#666;">
      Document #: <strong>${escapeHtml(number)}</strong>
    </div>
  </div>

  <table class="items">
    <thead>
      <tr>
        <th style="width:6%;">Qty</th>
        <th style="width:40%;">Item</th>
        <th style="width:12%;">Rate ($)</th>
        <th style="width:8%;">Discount (%)</th>
        <th style="width:20%;">Amount ($)</th>
      </tr>
    </thead>
    <tbody>
     ${rowsHtml}

    </tbody>
  </table>

  <table class="totals" cellpadding="0" cellspacing="0">
    <tr><td style="width:60%;">Subtotal</td><td style="text-align:right;">${formatMoney(subtotal)}</td></tr>
    <tr><td>Discount (${formatMoney(discountPercent)}%)</td><td style="text-align:right;">${formatMoney(discountAmount)}</td></tr>
    <tr><td>VAT (${formatMoney(vatPercent)}%)</td><td style="text-align:right;">${formatMoney(vat)}</td></tr>
    <tr><td>Total</td><td style="text-align:right;">${formatMoney(total)}</td></tr>
  </table>

  ${ notes ? `<div style="clear:both; margin-top:16px; border-left:4px solid #1f6feb; background:#fbfdff; padding:10px; border-radius:4px;">${escapeHtml(notes)}</div>` : "" }

</body>
</html>
    `;
  }

  function escapeHtml(s) {
    if (s === undefined || s === null) return "";
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  // Try puppeteer first
  try {
    const html = buildHtml();
    if (puppeteer) {
      try {
        await renderHtmlToPdf(html, filepath);
        return { filepath, filename, method: "puppeteer" };
      } catch (e) {
        console.error("generatePDF: Puppeteer render failed:", e && (e.stack || e.message) ? (e.stack || e.message) : e);
        // continue to pdfkit fallback
      }
    } else {
      console.info("generatePDF: puppeteer not installed; falling back to pdfkit");
    }
  } catch (errHtml) {
    console.warn("generatePDF: building HTML failed, falling back to pdfkit", errHtml && errHtml.message);
  }

  // Fallback: pdfkit (keeps original behavior)
  if (!PDFDocument) throw new Error("pdfkit not available. Install with: npm install pdfkit");

  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: "A4", margin: 50 });
      const stream = fs.createWriteStream(filepath);
      doc.pipe(stream);

      // header (logo or company name) - pdfkit uses local file if present
      if (bizMeta.logoUrl && bizMeta.logoUrl.startsWith("http")) {
        try {
          const localLogo = path.join(process.cwd(), "public", "docs", "logos", `logo-${bizMeta._id || "biz"}.png`);
          if (fs.existsSync(localLogo)) doc.image(localLogo, 50, 45, { width: 90 });
        } catch (e) {}
      } else if (bizMeta.name) {
        doc.fontSize(18).text(bizMeta.name, 50, 50);
      }

      doc.fontSize(20).fillColor("#111").text(type === "invoice" ? "INVOICE" : type === "quote" ? "QUOTATION" : "RECEIPT", 400, 50, { align: "right" });
      doc.fontSize(10).fillColor("#333").text(`No: ${number}`, 400, 75, { align: "right" });
      doc.text(`Date: ${date.toISOString().slice(0,10)}`, 400, 90, { align: "right" });
      if (dueDate) doc.text(`Due: ${dueDate.toISOString().slice(0,10)}`, 400, 105, { align: "right" });

      doc.moveDown(2);
      doc.fontSize(12).fillColor("#000").text("Bill To:", 50, 140);
      doc.fontSize(11).fillColor("#111").text(billingTo || "-", 50, 155);
      if (email) doc.fontSize(10).fillColor("#666").text(email, 50, 170);

      const startY = 210;
      const columnWidths = [220, 60, 70, 70, 80];
      const afterTableY = drawTablePdfkit(doc, items, 50, startY, columnWidths, Number(bizMeta.discountPercent || 0));
      let subtotal2 = items.reduce((s, it) => s + (Number(it.qty||0) * Number(it.unit||0)), 0);

      const discountPercentUsed = Number(bizMeta.discountPercent || 0);
      const discountAmount = +(subtotal2 * (discountPercentUsed / 100));
      const taxableBase = subtotal2 - discountAmount;
      const vatPercentUsed = Number(bizMeta.vatPercent || 0);
      const applyVatUsed = (Number(bizMeta.vatPercent || 0) > 0) ? true : ((bizMeta.applyVat === false) ? false : true);
      const vat = applyVatUsed ? +(taxableBase * (vatPercentUsed / 100)) : 0;
      const total = taxableBase + vat;

      const tx = 400, ty = afterTableY + 10;
      doc.rect(tx - 10, ty - 6, 180, 110).strokeOpacity(0.08).stroke();
      doc.fontSize(10).fillColor("#111").text(`Subtotal: ${formatMoney(subtotal2)}`, tx, ty, { align: "right" });
      doc.fontSize(10).fillColor("#111").text(`Discount (${formatMoney(discountPercentUsed)}%): ${formatMoney(discountAmount)}`, tx, ty + 15, { align: "right" });
      doc.fontSize(10).fillColor("#111").text(`VAT (${formatMoney(vatPercentUsed)}%): ${formatMoney(vat)}`, tx, ty + 30, { align: "right" });
      doc.fontSize(12).fillColor("#000").text(`Total: ${formatMoney(total)}`, tx, ty + 50, { align: "right" });

      if (notes) { doc.moveDown(2); doc.fontSize(10).fillColor("#333").text("Notes:", 50, afterTableY + 80); doc.fontSize(9).fillColor("#444").text(notes, 50, afterTableY + 95, { width: 400 }); }

      doc.fontSize(9).fillColor("gray").text("-----------", 50, 760, { align: "center", width: 500 });

      doc.end();
      stream.on("finish", () => resolve({ filepath, filename, method: "pdfkit" }));
      stream.on("error", (err) => reject(err));
    } catch (err) { reject(err); }
  });
}

////////////////////////////////////////////////////////////////////////////
async function sendWhatsAppMessage(toPhone, message) {
  const client = twilio(
    process.env.TWILIO_BIZ_ACCOUNT_SID,
    process.env.TWILIO_BIZ_AUTH_TOKEN
  );

  return client.messages.create({
    from: "whatsapp:" + process.env.TWILIO_WHATSAPP_NUMBER,
    to: "whatsapp:" + toPhone,
    body: message
  });
}


/* ---------- Logo saving helpers ---------- */
async function ensureLogosDir() {
  const imgDir = path.join(process.cwd(), "public", "img");
  try { await fs.promises.mkdir(imgDir, { recursive: true }); } catch (e) {}
  return imgDir;
}

/**
 * Improved saveLogoFromTwilio:
 * - Detects Twilio account SID embedded in media URL (if present)
 * - Chooses credentials automatically:
 *    - If media URL SID matches TWILIO_BIZ_ACCOUNT_SID -> uses TWILIO_BIZ_AUTH_TOKEN
 *    - Else if matches TWILIO_ACCOUNT_SID -> uses TWILIO_AUTH_TOKEN
 *    - Otherwise prefers TWILIO_BIZ_* then TWILIO_* envs (so subaccount setups work)
 * - Falls back to plain GET for public URLs
 * - Provides clearer error messages when auth is missing/incorrect
 */
async function saveLogoFromTwilio(mediaUrl, businessId) {
  if (!mediaUrl) throw new Error("No media URL");
  const logosDir = await ensureLogosDir();
  const filename = `logo-${businessId}.png`;
  const filepath = path.join(logosDir, filename);

  // Environment credentials
  const envMainSid = process.env.TWILIO_ACCOUNT_SID || null;
  const envMainToken = process.env.TWILIO_AUTH_TOKEN || null;
  const envBizSid = process.env.TWILIO_BIZ_ACCOUNT_SID || null;
  const envBizToken = process.env.TWILIO_BIZ_AUTH_TOKEN || null;

  // Extract account SID if present in the media URL (Twilio API URLs include /Accounts/<SID>/)
  const sidMatch = String(mediaUrl).match(/\/Accounts\/(AC[0-9a-fA-F]{32})\//);
  const accountSidInUrl = sidMatch ? sidMatch[1] : null;

  // Detect twilio API url
  const isTwilioUrl = /:\/\/(api\.)?twilio\.com/i.test(mediaUrl) || /twilio\.com\/2010-04-01/i.test(mediaUrl);

  // Decide which credentials to use
  let useSid = null;
  let useToken = null;

  if (isTwilioUrl) {
    if (accountSidInUrl) {
      // Prefer exact matches first
      if (envBizSid && accountSidInUrl === envBizSid && envBizToken) {
        useSid = envBizSid; useToken = envBizToken;
      } else if (envMainSid && accountSidInUrl === envMainSid && envMainToken) {
        useSid = envMainSid; useToken = envMainToken;
      } else {
        // fallback: try biz then main
        if (envBizSid && envBizToken) { useSid = envBizSid; useToken = envBizToken; }
        else if (envMainSid && envMainToken) { useSid = envMainSid; useToken = envMainToken; }
        else {
          const e = new Error(`Cannot fetch Twilio media: missing TWILIO_BIZ_AUTH_TOKEN or TWILIO_AUTH_TOKEN. Media URL expects account ${accountSidInUrl}.`);
          e.code = "MISSING_TWILIO_AUTH";
          throw e;
        }
      }
    } else {
      // Twilio domain but no SID in URL — pick biz if present, else main
      if (envBizSid && envBizToken) { useSid = envBizSid; useToken = envBizToken; }
      else if (envMainSid && envMainToken) { useSid = envMainSid; useToken = envMainToken; }
      else {
        const e = new Error("Cannot fetch Twilio media: no TWILIO_* credentials found in environment.");
        e.code = "MISSING_TWILIO_AUTH";
        throw e;
      }
    }
  }

  // prepare axios options
  const axiosOpts = {
    responseType: "arraybuffer",
    timeout: 15000,
  };

  if (isTwilioUrl && useSid && useToken) {
    axiosOpts.auth = { username: useSid, password: useToken };
  }

  // Attempt fetch
  let resp;
  try {
    resp = await axios.get(mediaUrl, axiosOpts);
  } catch (err) {
    const status = err?.response?.status || "ERR";
    const twilioErrCode = err?.response?.headers?.["x-twilio-error-code"];
    let message = `Failed to download media from ${mediaUrl} — HTTP ${status}`;
    if (twilioErrCode) message += ` (Twilio error ${twilioErrCode})`;

    if (isTwilioUrl) {
      if (accountSidInUrl && !( (envBizSid && accountSidInUrl === envBizSid) || (envMainSid && accountSidInUrl === envMainSid) )) {
        message += `\nMedia URL belongs to ${accountSidInUrl}. Ensure you have set credentials for that account (TWILIO_BIZ_ACCOUNT_SID / TWILIO_BIZ_AUTH_TOKEN or TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN).`;
      } else {
        message += `\nCheck the corresponding TWILIO_* environment variables and ensure the auth token is valid (not revoked).`;
      }
      if (status === 401) message += `\nHint: Twilio returns 401 (error 20003) when credentials are missing/incorrect for that account.`;
    }

    const wrapped = new Error(message);
    wrapped.original = err;
    throw wrapped;
  }

  // save file
  await fs.promises.writeFile(filepath, resp.data);

  const site = (process.env.SITE_URL || "").replace(/\/$/, "");
  const publicUrl = site
  ? `${site}/img/${filename}`
  : `/img/${filename}`;

  return { filepath, filename, publicUrl };
}
function resolveMenuAction(role, choice) {
  const maps = {
  owner: {
  "1": "create_business",
  "2": "invoice",
  "3": "receipt",
  "4": "quote",
  "5": "add_client",
  "6": "payment",
  "7": "expense",
  "8": "reports_menu",
  "9": "statement",
  "10": "invite_user",
  "11": "upload_logo",
  "12": "settings",
  "13": "upgrade_plan" // ✅ NEW
},

    manager: {
      "1": "invoice",
      "2": "receipt",
      "3": "quote",
      "4": "add_client",
      "5": "payment",
      "6": "expense",
      "7": "reports_menu",
      "8": "statement"
    },
    clerk: {
      "1": "invoice",
      "2": "payment",
      "3": "expense",
      "4": "reports_menu"
    }
  };

  return maps[role]?.[choice] || null;
}

async function resetSession(biz) { biz.sessionState = null; biz.sessionData = {}; return saveBiz(biz); }

/* ---------- Role-based Menus ---------- */
function ownerMenu(biz) {
  let menu = `ZimQuote | Owner Menu
1) Create business
2) New invoice
3) New receipt
4) New quotation
5) Add client
6) Record payment (IN)
7) Record expense (OUT)
8) Reports
9) Client statement
10) Invite user
11) Upload logo
12) Settings
13) 🚀 Upgrade plan
`;

  if (isTrial(biz)) {
    menu += `🕒 Trial mode\n`;
  }

  menu += `0) Menu`;
  return menu;
}



function managerMenu() {
  return `ZimQuote | Manager Menu
1) New invoice
2) New receipt
3) New quotation
4) Add client
5) Record payment (IN)
6) Record expense (OUT)
7) Reports
8) Client statement
0) Menu`;
}


function clerkMenu() {
  return `ZimQuote | Clerk Menu
1) New invoice
2) Record payment (IN)
3) Record expense (OUT)
4) Daily summary
0) Menu`;
}


/* ---------- Menu dispatcher ---------- */
async function sendMenuForUser(res, biz, providerId) {
  const roleRec = await UserRole.findOne({
    businessId: biz._id,
    phone: providerId
  });

  if (!roleRec) {
    return sendTwimlText(res, "⛔ You are not assigned to this business.");
  }

  if (roleRec.role === "owner") {
    return sendTwimlText(res, ownerMenu(biz));
  }

  if (roleRec.role === "manager") {
    return sendTwimlText(res, managerMenu(biz));
  }

  if (roleRec.role === "clerk") {
    return sendTwimlText(res, clerkMenu(biz));
  }

  return sendTwimlText(res, ownerMenu(biz)); // fallback
}



/* ---------- Main webhook (keeps your flow intact) ---------- */
router.post("/webhook", async (req, res) => {
  console.log("🔥 TWILIO WEBHOOK HIT", {
  From: req.body.From,
  Body: req.body.Body
});

  console.log("TWILIO (biz): webhook hit ->", { path: req.path, ip: req.ip || req.connection?.remoteAddress });
  try { console.log("TWILIO (biz): body (raw):", JSON.stringify(req.body)); } catch (e) { console.log("TWILIO (biz): body keys:", Object.keys(req.body || {})); }

  const ok = verifyTwilioRequest(req);
  if (!ok) {
    res.status(403);
    return sendTwimlText(res, "Invalid Twilio signature");
  }

  try {
    const params = req.body || {};
    const rawFrom = String(params.From || params.from || "").trim();
    const bodyRaw = String(params.Body || params.body || "").trim();
    const profileName = String(params.ProfileName || params.profileName || "");


    // ================= META INTERACTIVE PARSING =================
let action = null;

try {
  if (params?.interactive?.button_reply?.id) {
    action = params.interactive.button_reply.id;
  } else if (params?.interactive?.list_reply?.id) {
    action = params.interactive.list_reply.id;
  }
} catch (e) {
  action = null;
}

const isMetaAction =
  typeof action === "string" &&
  action.length > 0;

    const text = bodyRaw || "";
const trimmed = text.trim();

// 🔒 Meta actions should NOT be treated as typed text
if (isMetaAction) {
  console.log("META ACTION RECEIVED:", action);
}

    if (!rawFrom) return sendTwimlText(res, "Missing sender info");
    //const providerId = rawFrom.replace(/^whatsapp:/i, "").trim();

        const providerIdRaw = rawFrom.replace(/^whatsapp:/i, "").trim();
const providerId = normalizePhone(providerIdRaw);

if (!providerId) {
  return sendTwimlText(res, "Invalid WhatsApp number.");
}

// ================= JOIN INVITATION HANDLER =================
if (/^join$/i.test(trimmed)) {

  const phone = providerId.replace(/\D+/g, "");

  console.log("JOIN attempt from:", phone);

  const invite = await UserRole.findOne({
    phone,
    pending: true
  }).populate("businessId branchId");

  if (!invite) {
    return sendTwimlText(
      res,
      "❌ No pending invitation found for this number."
    );
  }

  // activate user
  invite.pending = false;
  await invite.save();

  // activate business context
  await UserSession.findOneAndUpdate(
    { phone },
    { activeBusinessId: invite.businessId._id },
    { upsert: true }
  );

  // 🔔 NOTIFY BUSINESS OWNER
try {
  const ownerRole = await UserRole.findOne({
    businessId: invite.businessId._id,
    role: "owner",
    pending: false
  });

  if (ownerRole) {
    const ownerMsg =
`✅ User joined your business

👤 Phone: ${phone}
🏢 Business: ${invite.businessId.name}
📍 Branch: ${invite.branchId.name}
🔑 Role: ${invite.role}`;

    await sendWhatsAppMessage(ownerRole.phone, ownerMsg);
  }
} catch (e) {
  console.error("Owner notify failed:", e.message);
}


  return sendTwimlText(
    res,
`✅ Invitation accepted!

🏢 Business: ${invite.businessId.name}
📍 Branch: ${invite.branchId.name}
🔑 Role: ${invite.role}

Reply *menu* to start.`
  );
}





  

const session = await UserSession.findOne({ phone: providerId });

let biz = null;
if (session?.activeBusinessId) {
  biz = await Business.findById(session.activeBusinessId);
}

// 🔍 DEBUG: LOGO UPLOAD DIAGNOSTICS
console.log("TWILIO WEBHOOK HIT");
console.log("Body:", req.body.Body);
console.log("NumMedia:", req.body.NumMedia);
console.log("MediaUrl0:", req.body.MediaUrl0);
console.log("SessionState:", biz?.sessionState);


// 🚫 TRIAL EXPIRY CHECK (ALLOW MENU + UPGRADE ONLY)
if (isTrialExpired(biz)) {
  const cmd = trimmed.toLowerCase();

  if (cmd !== "upgrade" && cmd !== "menu") {
    return sendTwimlText(
      res,
      `⏰ Trial expired

Upgrade to *Bronze* to continue.

Reply *upgrade* to see plans.`
    );
  }
}




// Ensure sessionData defaults for vat/discount when starting a document
 // ✅ SAFE: only initialize when biz exists
if (biz) {
  if (!biz.sessionData) biz.sessionData = {};

  biz.sessionData.discountPercent =
    typeof biz.sessionData.discountPercent === "undefined"
      ? 0
      : biz.sessionData.discountPercent;

  if (typeof biz.sessionData.vatPercent === "undefined") {
    biz.sessionData.vatPercent = Number(biz.taxRate || 0);
  }

  if (typeof biz.sessionData.applyVat === "undefined") {
    biz.sessionData.applyVat = true;
  }
}

  

// 🚨 No active business selected
// 🚀 CREATE BUSINESS (ONLY ENTRY POINT)
if (!biz) {

 const wantsCreate =
  /^create$/i.test(trimmed) ||
  action === "create_business";

if (!wantsCreate) {
  return sendButtons(res, {
    text: `👋 Welcome to ZimQuote

You are not linked to any business.`,
    buttons: [
      {
        id: "create_business",
        title: "➕ Create business"
      }
    ]
  });
}


  // 🔒 Ensure user has no businesses
  const roles = await UserRole.find({ phone: providerId });
  if (roles.length > 0) {
    return sendTwimlText(
      res,
      "You are already linked to a business. Reply *menu*."
    );
  }

  // ✅ CREATE BUSINESS
  const now = new Date();
  const biz = await Business.create({
    name: null,
    currency: "USD",
    provider: "whatsapp",
    package: "trial",
    subscriptionStatus: "active",
    trialStartedAt: now,
    trialEndsAt: new Date(now.getTime() + 24 * 60 * 60 * 1000)
  });

  const branch = await Branch.create({
    businessId: biz._id,
    name: "Main Branch",
    isDefault: true
  });

  await UserRole.create({
    businessId: biz._id,
    branchId: branch._id,
    phone: providerId,
    role: "owner",
    pending: false
  });

  await UserSession.findOneAndUpdate(
    { phone: providerId },
    { activeBusinessId: biz._id },
    { upsert: true }
  );

  biz.sessionState = "awaiting_business_name";
  await saveBiz(biz);

  return sendTwimlText(
    res,
    "✅ Business created!\n\nWhat is your business name?"
  );
}






    if (profileName && !biz.name) {
      biz.name = biz.name || profileName;
      await saveBiz(biz).catch(() => {});
    }



const isSingleNumber = /^\d+$/.test(trimmed);
    const state = biz.sessionState || "idle";

if (state === "awaiting_logo_upload") {

  const mediaCount = Number(req.body.NumMedia || 0);

  // ❌ No image sent
  if (mediaCount === 0) {
    return sendTwimlText(
      res,
      "📷 Please send an image (PNG or JPG), or reply 0 to cancel."
    );
  }

  // ✅ Image received
  const mediaUrl = req.body.MediaUrl0;

  if (!mediaUrl) {
    return sendTwimlText(
      res,
      "❌ Image upload failed. Please try again."
    );
  }

  try {
    const saved = await saveLogoFromTwilio(
      mediaUrl,
      biz._id.toString()
    );

    biz.logoUrl = saved.publicUrl;
    biz.sessionState = "settings_menu";
    biz.sessionData = {};
    await saveBiz(biz);

    return sendTwimlText(
      res,
      "✅ Business logo uploaded successfully.\n\nReply *menu* to continue."
    );

  } catch (err) {
    console.error("LOGO SAVE ERROR:", err);

    return sendTwimlText(
      res,
      "❌ Failed to save logo. Please try again."
    );
  }
}




    const ctx = await getUserBranchContext(biz, providerId);
const role = ctx?.role;



// GLOBAL MENU HANDLER (works everywhere)
if (trimmed.toLowerCase() === "menu" || trimmed === "0") {
  await resetSession(biz);
  return sendMenuForUser(res, biz, providerId);
}


// ================= UPGRADE COMMAND =================
if (trimmed.toLowerCase() === "upgrade") {

  const currentPkg = PACKAGES[biz.package || "bronze"];

  biz.sessionState = "upgrade_choose_package";
  await saveBiz(biz);

  return sendTwimlText(
    res,
`🚀 Upgrade your plan

Current package: *${currentPkg.label}*
Monthly limit: ${currentPkg.documentsPerMonth} documents

Choose a new package:

1) Silver - ${PACKAGES.silver.documentsPerMonth} docs / month
2) Gold - ${PACKAGES.gold.documentsPerMonth} docs / month
3) Enterprise - Unlimited

0) Cancel`
  );
}




// ===== ROLE-BASED MAIN MENU ROUTER =====
// ===== ROLE-BASED MAIN MENU ROUTER =====
if ((state === "idle" || state === "ready") && (isSingleNumber || isMetaAction)) {

  const ctx = await getUserBranchContext(biz, providerId);
  const role = ctx?.role || "owner";

  const resolvedAction = isMetaAction
    ? action
    : resolveMenuAction(role, trimmed);

  if (!resolvedAction) {
    return sendTwimlText(res, "Invalid selection.");
  }

  return dispatchAction({
    action: resolvedAction,
    biz,
    providerId,
    req,
    res,
    helpers: {
      saveBiz,
      resetSession,
      sendMenuForUser,
      sendTwimlText
    }
  });
}


// ================= PAYMENT START =================
if (state === "payment_start") {

  const ctx = await getUserBranchContext(biz, providerId);
  const role = ctx?.role || "owner";
  const branchId = ctx?.branchId || null;

;

  const query = {
    businessId: biz._id,
    balance: { $gt: 0 }
  };

 if (role !== "owner" && branchId) {
  query.$or = [
    { branchId },
    { branchId: { $exists: false } },
    { branchId: null }
  ];
}


  const invoices = await Invoice.find(query)
    .sort({ createdAt: -1 })
    .limit(10)
    .lean();

  if (!invoices.length) {
    await resetSession(biz);
    return sendTwimlText(res, "No unpaid invoices found.");
  }

  biz.sessionData.invoiceList = invoices;
  biz.sessionState = "payment_choose_invoice";
  await saveBiz(biz);

  let msg = "Select invoice to record payment:\n";
  invoices.forEach((inv, i) => {
    msg += `${i + 1}) ${inv.number} | Balance: ${formatMoney(inv.balance)} ${inv.currency}\n`;
  });
  msg += "0) Cancel";

  return sendTwimlText(res, msg);
}

/* ================= REPORT COMMANDS (ADD HERE) ================= */


/* ================= REPORTS MENU ================= */

if (state === "reports_menu" && isSingleNumber) {

  // 0) Back
  if (trimmed === "0") {
    await resetSession(biz);
    return sendMenuForUser(res, biz, providerId);
  }

  // 🚫 Block advanced reports for non-Gold
  if (!canUseFeature(biz, "reports_advanced") && trimmed !== "1") {
  await resetSession(biz);
  return blockedMessage(res);
}


  if (trimmed === "1") {
    biz.sessionState = "report_daily";
    await saveBiz(biz);
    return res.redirect(307, req.originalUrl);
  }

  if (trimmed === "2") {
    biz.sessionState = "report_weekly";
    await saveBiz(biz);
    return res.redirect(307, req.originalUrl);
  }

  if (trimmed === "3") {
    biz.sessionState = "report_monthly";
    await saveBiz(biz);
    return res.redirect(307, req.originalUrl);
  }

  if (trimmed === "4") {
    const ok = await requireRole(biz, providerId, ["owner"]);
    if (!ok) {
      await resetSession(biz);
      return sendTwimlText(res, "⛔ Branch reports are for owners only.");
    }

    const branches = await Branch.find({ businessId: biz._id }).lean();
    if (!branches.length) {
      await resetSession(biz);
      return sendTwimlText(res, "No branches found.");
    }

    biz.sessionData.branches = branches;
    biz.sessionState = "report_choose_branch";
    await saveBiz(biz);

    let msg = "Select branch:\n";
    branches.forEach((b, i) => msg += `${i + 1}) ${b.name}\n`);
    msg += "0) Cancel";

    return sendTwimlText(res, msg);
  }

  return sendTwimlText(res, "Invalid report option.");
}

/* ================= REPORT BY BRANCH ================= */

if (state === "report_choose_branch" && isSingleNumber) {

  // 0) Cancel
  if (trimmed === "0") {
    await resetSession(biz);
    return sendMenuForUser(res, biz, providerId);
  }

  const branches = biz.sessionData.branches || [];
  const idx = Number(trimmed) - 1;

  if (!branches[idx]) {
    return sendTwimlText(
      res,
      "Invalid branch selection. Reply with a number shown or 0 to cancel."
    );
  }

  const branch = branches[idx];

  // move to final report state
  biz.sessionData.branchId = branch._id;
  biz.sessionState = "report_branch_summary";
  await saveBiz(biz);

  // auto-trigger report immediately
  return res.redirect(307, req.originalUrl);
}


if (state === "report_branch_summary") {

  const branchId = biz.sessionData.branchId;

  const start = new Date();
  start.setHours(0, 0, 0, 0);

  const end = new Date();
  end.setHours(23, 59, 59, 999);

  const query = {
    businessId: biz._id,
    branchId,
    createdAt: { $gte: start, $lte: end }
  };

  const invoices = await Invoice.find(query).lean();
  const payments = await Payment.find(query).lean();
  const expenses = await Expense.find(query).lean();

  const totalInvoiced = invoices.reduce((s, i) => s + (i.total || 0), 0);
  const totalReceived = payments.reduce((s, p) => s + (p.amount || 0), 0);
  const totalExpenses = expenses.reduce((s, e) => s + (e.amount || 0), 0);
  const outstanding = invoices.reduce((s, i) => s + (i.balance || 0), 0);

  const branch = await Branch.findById(branchId);

  await resetSession(biz);

 return sendWithMenuHint(
  res,
`📍 Branch Report: ${branch?.name || "Branch"}

Invoices: ${invoices.length}
Sales: ${formatMoney(totalInvoiced)} ${biz.currency}
Cash received: ${formatMoney(totalReceived)} ${biz.currency}
Expenses: ${formatMoney(totalExpenses)} ${biz.currency}
Outstanding: ${formatMoney(outstanding)} ${biz.currency}`
);

}

if (state === "report_daily") {

  const ctx = await getUserBranchContext(biz, providerId);
  const role = ctx?.role || "owner";
  const branchId = ctx?.branchId || null;

  const start = new Date();
  start.setHours(0, 0, 0, 0);

  const end = new Date();
  end.setHours(23, 59, 59, 999);

  const query = {
    businessId: biz._id,
    createdAt: { $gte: start, $lte: end }
  };

  if (role !== "owner" && branchId) {
    query.branchId = branchId;
  }

  const invoices = await Invoice.find(query).lean();
  const payments = await Payment.find(query).lean();
  const expenses = await Expense.find(query).lean();

  const invoiced = invoices.reduce((s, i) => s + (i.total || 0), 0);
  const received = payments.reduce((s, p) => s + (p.amount || 0), 0);
  const spent = expenses.reduce((s, e) => s + (e.amount || 0), 0);
  const outstanding = invoices.reduce((s, i) => s + (i.balance || 0), 0);

  await resetSession(biz);

return sendWithMenuHint(
  res,
`📊 Daily Report (${start.toISOString().slice(0,10)})

Invoices: ${invoices.length}
Sales: ${formatMoney(invoiced)} ${biz.currency}
Cash received: ${formatMoney(received)} ${biz.currency}
Expenses: ${formatMoney(spent)} ${biz.currency}
Outstanding: ${formatMoney(outstanding)} ${biz.currency}`
);

}




if (state === "report_weekly") {

  const ctx = await getUserBranchContext(biz, providerId);
  const role = ctx?.role || "owner";
  const branchId = ctx?.branchId || null;

  const start = new Date();
  start.setDate(start.getDate() - 6);
  start.setHours(0, 0, 0, 0);

  const end = new Date();
  end.setHours(23, 59, 59, 999);

  const query = {
    businessId: biz._id,
    createdAt: { $gte: start, $lte: end }
  };

  if (role !== "owner" && branchId) {
    query.branchId = branchId;
  }

  const invoices = await Invoice.find(query).lean();
  const payments = await Payment.find(query).lean();
  const expenses = await Expense.find(query).lean();

  const invoiced = invoices.reduce((s, i) => s + (i.total || 0), 0);
  const received = payments.reduce((s, p) => s + (p.amount || 0), 0);
  const spent = expenses.reduce((s, e) => s + (e.amount || 0), 0);
  const outstanding = invoices.reduce((s, i) => s + (i.balance || 0), 0);

  await resetSession(biz);

 return sendWithMenuHint(
  res,
`📊 Weekly Report

Invoices: ${invoices.length}
Sales: ${formatMoney(invoiced)} ${biz.currency}
Cash received: ${formatMoney(received)} ${biz.currency}
Expenses: ${formatMoney(spent)} ${biz.currency}
Outstanding: ${formatMoney(outstanding)} ${biz.currency}`
);

}





if (state === "report_monthly") {

  const ctx = await getUserBranchContext(biz, providerId);
  const role = ctx?.role || "owner";
  const branchId = ctx?.branchId || null;

  const start = new Date();
  start.setDate(1);
  start.setHours(0, 0, 0, 0);

  const end = new Date();
  end.setHours(23, 59, 59, 999);

  const query = {
    businessId: biz._id,
    createdAt: { $gte: start, $lte: end }
  };

  if (role !== "owner" && branchId) {
    query.branchId = branchId;
  }

  const invoices = await Invoice.find(query).lean();
  const payments = await Payment.find(query).lean();
  const expenses = await Expense.find(query).lean();

  const invoiced = invoices.reduce((s, i) => s + (i.total || 0), 0);
  const received = payments.reduce((s, p) => s + (p.amount || 0), 0);
  const spent = expenses.reduce((s, e) => s + (e.amount || 0), 0);
  const outstanding = invoices.reduce((s, i) => s + (i.balance || 0), 0);

  await resetSession(biz);

return sendWithMenuHint(
  res,
`📊 Monthly Report

Invoices: ${invoices.length}
Sales: ${formatMoney(invoiced)} ${biz.currency}
Cash received: ${formatMoney(received)} ${biz.currency}
Expenses: ${formatMoney(spent)} ${biz.currency}
Outstanding: ${formatMoney(outstanding)} ${biz.currency}`
);

}










// SETTINGS MENU (7)
/*if ((state === "idle" || state === "ready") && trimmed === "7") {
  biz.sessionState = "settings_menu";
  await saveBiz(biz);

  return sendTwimlText(
    res,
`Settings:
1) Currency
2) Payment terms
3) Invoice prefix
4) Quote prefix
5) Change logo
6) View clients
7) Receipt prefix
8) Branches
0) Menu`
  );
}
*/


// ================= UPGRADE: CHOOSE PACKAGE =================
if (state === "upgrade_choose_package" && isSingleNumber) {

  if (trimmed === "0") {
    await resetSession(biz);
    return sendMenuForUser(res, biz, providerId);
  }

  const currentKey = biz.package || "trial";

  let allowedUpgrades = [];

  if (currentKey === "trial") {
    allowedUpgrades = ["bronze", "silver", "gold"];
  } else if (currentKey === "bronze") {
    allowedUpgrades = ["silver", "gold"];
  } else if (currentKey === "silver") {
    allowedUpgrades = ["gold"];
  }

  const idx = Number(trimmed) - 1;
  const chosen = allowedUpgrades[idx];

  if (!chosen) {
    return sendTwimlText(res, "Invalid option. Choose a number from the list or 0 to cancel.");
  }

  // ✅ APPLY UPGRADE
  biz.package = chosen;
  biz.subscriptionStatus = "active";
  biz.trialEndsAt = null;
  biz.trialStartedAt = null;

  await saveBiz(biz);

  return sendTwimlText(
    res,
`✅ Package upgraded successfully!

New package: *${PACKAGES[chosen].label}*
Monthly documents: ${PACKAGES[chosen].documentsPerMonth}

Reply *menu* to continue.`
  );
}


  // Settings menu blocks:
   // Settings menu blocks:



/* ================= CLIENT STATEMENT ================= */



// STEP 2: user enters client name
if (state === "statement_choose_client") {
  const name = trimmed;

  const client = await Client.findOne({
    businessId: biz._id,
    name: new RegExp(`^${name}`, "i")
  });

  if (!client) {
    return sendTwimlText(
      res,
      "Client not found. Try again or reply 0 for menu."
    );
  }

const ctx = await getUserBranchContext(biz, providerId);
const role = ctx?.role || "owner";
const branchId = ctx?.branchId || null;



const invQuery = {
  businessId: biz._id,
  clientId: client._id
};


if (role !== "owner" && branchId) {
  invQuery.branchId = branchId;
}


const invoices = await Invoice.find(invQuery);


  const totalBilled = invoices.reduce((s, i) => s + (i.total || 0), 0);
  const totalPaid = invoices.reduce((s, i) => s + (i.amountPaid || 0), 0);
  const balance = invoices.reduce((s, i) => s + (i.balance || 0), 0);

  await resetSession(biz);

return sendWithMenuHint(
  res,
`📄 Statement: ${client.name}

Invoices: ${invoices.length}
Total billed: ${formatMoney(totalBilled)} ${biz.currency}
Paid: ${formatMoney(totalPaid)} ${biz.currency}
Balance: ${formatMoney(balance)} ${biz.currency}`
);

}

/* ================= PAYMENTS ================= */

// START PAYMENT FLOW
/*if (/^record payment$/i.test(trimmed)) {
  biz.sessionState = "payment_invoice_number";
  biz.sessionData = {};
  await saveBiz(biz);
  return sendTwimlText(res, "Enter invoice number (e.g. INV-000123)");
}*/

/* ================= PAYMENT START ================= */

// PAYMENT START: load unpaid invoices


// PAYMENT: choose invoice from recent unpaid list
if (state === "payment_choose_invoice" && isSingleNumber) {

  const idx = Number(trimmed) - 1;
  const list = biz.sessionData.invoiceList || [];

  if (!list[idx]) {
    return sendTwimlText(
      res,
      "Invalid selection. Choose a number from the list or 0 for menu."
    );
  }

  const invoice = list[idx];

  // safety check
  if (invoice.balance <= 0) {
    await resetSession(biz);
    return sendTwimlText(
      res,
      "Invoice already fully paid. Reply 0 for menu."
    );
  }

  biz.sessionData.invoiceId = invoice._id;

  biz.sessionState = "payment_amount";
  await saveBiz(biz);

  return sendTwimlText(
    res,
`Invoice ${invoice.number}
Total: ${formatMoney(invoice.total)} ${invoice.currency}
Paid: ${formatMoney(invoice.amountPaid || 0)} ${invoice.currency}
Balance: ${formatMoney(invoice.balance)} ${invoice.currency}

Enter amount paid:`
  );
}






/* ================= END REPORT COMMANDS ================= */



    

    /* ================= PAYMENT FLOW STATES ================= */




// STEP 2: amount
if (state === "payment_amount") {
  const amount = Number(trimmed);
  if (isNaN(amount) || amount <= 0) {
    return sendTwimlText(res, "Invalid amount. Enter a number.");
  }

  biz.sessionData.amount = amount;
  biz.sessionState = "payment_method";
  await saveBiz(biz);

  return sendTwimlText(
    res,
`Payment method:
1) Cash
2) Bank
3) EcoCash
4) Other`
  );
}

// STEP 3: method → SAVE + RECEIPT
if (state === "payment_method" && isSingleNumber) {
  const methods = {
    "1": "cash",
    "2": "bank",
    "3": "ecocash",
    "4": "other"
  };

  const method = methods[trimmed];
  if (!method) return sendTwimlText(res, "Invalid choice.");

 const invoice = await Invoice.findById(biz.sessionData.invoiceId);
if (!invoice) {
  await resetSession(biz);
  return sendTwimlText(res, "Invoice not found. Start again.");
}

  const amount = biz.sessionData.amount;

const ctx = await getUserBranchContext(biz, providerId);
const role = ctx?.role || "owner";
const branchId = ctx?.branchId || null;




if (amount > invoice.balance) {
  biz.sessionState = "payment_amount";
  await saveBiz(biz);
  return sendTwimlText(
    res,
    `Payment exceeds invoice balance.\nBalance: ${formatMoney(invoice.balance)} ${invoice.currency}\nEnter a valid amount:`
  );
}


  // SAVE PAYMENT
const payment = await Payment.create({
  businessId: biz._id,
  branchId,
  invoiceId: invoice._id,
  amount,
  method,
  paidBy: providerId
});


 const updatedInvoice = await Invoice.findByIdAndUpdate(
  invoice._id,
  {
    $inc: { amountPaid: amount },
    $set: {
      status: invoice.balance - amount <= 0 ? "paid" : "partial",
      balance: Math.max(invoice.balance - amount, 0)
    }
  },
  { new: true }
);



  // AUTO RECEIPT NUMBER (uses existing counters)
  biz.counters = biz.counters || { receipt: 0 };
  biz.counters.receipt = (biz.counters.receipt || 0) + 1;

  const receiptNumber = `${biz.receiptPrefix}-${String(biz.counters.receipt).padStart(6, "0")}`;

const receipt = await Receipt.create({
  businessId: biz._id,
  branchId,
  clientId: invoice.clientId, // ✅ ADD THIS
  invoiceId: invoice._id,
  paymentId: payment._id,
  number: receiptNumber,
type: updatedInvoice.balance === 0 ? "final" : "partial",

  amount
});


  await saveBiz(biz);
const client = await Client.findById(invoice.clientId);

  // GENERATE RECEIPT PDF
  const { filename } = await generatePDF({
    type: "receipt",
    number: receiptNumber,
    date: new Date(),
    billingTo: client?.name || "Client",
    items: [
      { item: `Payment for ${invoice.number}`, qty: 1, unit: amount }
    ],
    bizMeta: {
      name: biz.name,
      logoUrl: biz.logoUrl,
      address: biz.address || "",
      discountPercent: 0,
      vatPercent: 0,
      applyVat: false,
      _id: biz._id
    }
  });

  const site = (process.env.SITE_URL || "").replace(/\/$/, "");
  const baseForMedia = site || `${(req.get("x-forwarded-proto") || req.protocol)}://${req.get("host")}`;
  const url = `${baseForMedia}/docs/generated/receipts/${filename}`;

  await resetSession(biz);

 return sendTwimlWithMedia(
  res,
  "✅ Payment recorded. Receipt attached.\n\n👉 Reply *menu* to continue.",
  [url]
);

}

/* ================= END PAYMENT FLOW STATES ================= */

/* ================= EXPENSE FLOW STATES ================= */

// STEP 1: expense amount
if (state === "expense_amount") {

  if (trimmed === "0") {
    await resetSession(biz);
    return sendMenuForUser(res, biz, providerId);
  }

  const amount = Number(trimmed);
  if (isNaN(amount) || amount <= 0) {
    return sendTwimlText(res, "Invalid amount. Enter a number or 0 for menu.");
  }


  biz.sessionData.amount = amount;
  biz.sessionState = "expense_category";
  await saveBiz(biz);

  return sendTwimlText(
    res,
`Expense category:
1) Rent
2) Transport
3) Salaries
4) Utilities
5) Supplies
6) Other`
  );
}


// STEP 2: expense category
if (state === "expense_category" && isSingleNumber) {
  const categories = {
    "1": "Rent",
    "2": "Transport",
    "3": "Salaries",
    "4": "Utilities",
    "5": "Supplies",
    "6": "Other"
  };

  const category = categories[trimmed];
  if (!category) return sendTwimlText(res, "Invalid choice.");

  biz.sessionData.category = category;
  biz.sessionState = "expense_method";
  await saveBiz(biz);

  return sendTwimlText(
    res,
`Payment method:
1) Cash
2) Bank
3) EcoCash
4) Other`
  );
}


// STEP 3: expense method → SAVE
if (state === "expense_method" && isSingleNumber) {
  const methods = {
    "1": "cash",
    "2": "bank",
    "3": "ecocash",
    "4": "other"
  };

  const method = methods[trimmed];
  if (!method) return sendTwimlText(res, "Invalid choice.");

const ctx = await getUserBranchContext(biz, providerId);
const role = ctx?.role || "owner";
const branchId = ctx?.branchId || null;




 await Expense.create({
  businessId: biz._id,
  branchId,
    amount: biz.sessionData.amount,
    category: biz.sessionData.category,
    method,
    createdBy: providerId
  });

  await resetSession(biz);

return sendWithMenuHint(res, "✅ Expense recorded successfully.");

}

/* ================= END EXPENSE FLOW STATES ================= */






    // Onboarding and simple states
    if (state === "awaiting_business_name") {
      const name = trimmed;
      if (!name) return sendTwimlText(res, "Please send a business name (e.g. 'ABC Traders').");
      biz.name = name;
      biz.sessionState = "awaiting_logo_choice";
      await saveBiz(biz);
      return sendTwimlText(res, `Thanks | "${name}".\nSend your logo image now, or reply 1 to skip, 2 to add later.`);
    }

    if (state === "awaiting_logo_choice") {
      if (trimmed === "1") { biz.sessionState = "awaiting_currency"; await saveBiz(biz); return sendTwimlText(res, `Logo skipped. What currency do you want? (ZWL, USD, ZAR)`); }
      if (trimmed === "2") { biz.sessionState = "ready"; biz.sessionData = {}; await saveBiz(biz); return sendTwimlText(res, `Setup finished. Reply menu to see commands.`); }
      return sendTwimlText(res, `Send an image file for your logo, or reply 1 to skip, 2 to add later.`);
    }

    if (state === "awaiting_currency") {
      const cur = trimmed.toUpperCase();
      if (!["ZWL","USD","ZAR"].includes(cur)) { biz.sessionState = "awaiting_currency"; await saveBiz(biz); return sendTwimlText(res, "Invalid currency. Reply ZWL, USD or ZAR."); }
      biz.currency = cur; biz.sessionState = "ready"; await saveBiz(biz);
      return sendTwimlText(res, `All set! Business "${biz.name}" created with currency ${cur}. Reply 'menu' or 2 for New invoice.`);
    }

    // Logo upload (media)
    const mediaCount = Number(params.NumMedia || params.MediaCount || 0);



  
// BRANCHES → VIEW BRANCHES
if (state === "branches_menu" && trimmed === "1") {
  const branches = await Branch.find({ businessId: biz._id });

  if (!branches.length) {
    return sendTwimlText(res, "No branches found.");
  }

  let msg = "Branches:\n";
  branches.forEach((b, i) => {
    msg += `${i + 1}) ${b.name}${b.isDefault ? " (default)" : ""}\n`;
  });

  biz.sessionState = "branches_menu";
  await saveBiz(biz);
  return sendTwimlText(res, msg);
}

// BRANCHES → ADD BRANCH (START)
if (state === "branches_menu" && trimmed === "2") {
  biz.sessionState = "branch_add_name";
  await saveBiz(biz);
  return sendTwimlText(res, "Enter new branch name:");
}

// BRANCHES → ADD BRANCH (SAVE)
if (state === "branch_add_name") {
  const name = trimmed;

  if (!name) {
    return sendTwimlText(res, "Branch name cannot be empty.");
  }

  await Branch.create({
    businessId: biz._id,
    name,
    isDefault: false
  });

  biz.sessionState = "branches_menu";
  await saveBiz(biz);

  return sendTwimlText(
    res,
    `✅ Branch "${name}" added.\n\n1) View branches\n2) Add branch\n3) Assign user to branch\n0) Back`
  );
}


// BRANCHES → ASSIGN USER (START)
if (state === "branches_menu" && trimmed === "3") {
  const branches = await Branch.find({ businessId: biz._id }).lean();

  if (!branches.length) {
    return sendTwimlText(res, "No branches available.");
  }

  biz.sessionData.branches = branches;
  biz.sessionState = "assign_user_choose_branch";
  await saveBiz(biz);

  let msg = "Select branch:\n";
  branches.forEach((b, i) => {
    msg += `${i + 1}) ${b.name}\n`;
  });
  msg += "0) Cancel";

  return sendTwimlText(res, msg);
}

// ASSIGN USER → PICK BRANCH
if (state === "assign_user_choose_branch" && isSingleNumber) {
 if (trimmed === "0") {
  biz.sessionState = "branches_menu";
  await saveBiz(biz);
  return sendTwimlText(res, "Cancelled.\n1) View branches\n2) Add branch\n3) Assign user\n0) Back");
}

  const idx = Number(trimmed) - 1;
  const branches = biz.sessionData.branches || [];

  if (!branches[idx]) {
    return sendTwimlText(res, "Invalid selection.");
  }

  biz.sessionData.branch = branches[idx];
  biz.sessionState = "assign_user_phone";
  await saveBiz(biz);

  return sendTwimlText(res, "Enter user phone number (WhatsApp number):");
}

// ASSIGN USER → PHONE
if (state === "assign_user_phone") {
  const phone = normalizePhone(trimmed);

  if (!phone) {
    return sendTwimlText(res, "Invalid phone number.");
  }

  biz.sessionData.userPhone = phone;
  biz.sessionState = "assign_user_role";
  await saveBiz(biz);

  return sendTwimlText(
    res,
`Select role:
1) Owner
2) Manager
3) Clerk`
  );
}

// ASSIGN USER → SAVE
if (state === "assign_user_role" && isSingleNumber) {
  const roles = {
    "1": "owner",
    "2": "manager",
    "3": "clerk"
  };

  const role = roles[trimmed];
  if (!role) {
    return sendTwimlText(res, "Invalid role selection.");
  }

  const branch = biz.sessionData.branch;
  const phone = biz.sessionData.userPhone;



  const pkg = PACKAGES[biz.package || "bronze"];

const activeUsers = await UserRole.countDocuments({
  businessId: biz._id,
  pending: false
});

if (activeUsers >= pkg.users) {
  return sendTwimlText(
    res,
`🚫 User limit reached

Package: ${pkg.label}
Allowed users: ${pkg.users}

Upgrade your package to add more users.`
  );
}

  // save role
await UserRole.findOneAndUpdate(
  {
    businessId: biz._id,
    phone
  },
  {
    role,
    branchId: branch._id,
    pending: true
  },
  { upsert: true }
);


  // 🔔 SEND INVITATION MESSAGE
  const botNumber = process.env.TWILIO_WHATSAPP_NUMBER.replace(/\D+/g, "");
  const joinLink = `https://wa.me/${botNumber}?text=JOIN`;

  const inviteMsg =
`👋 You’ve been invited to ${biz.name}

📍 Branch: ${branch.name}
🔑 Role: ${role}

👉 Click to activate:
${joinLink}

Or reply *JOIN* to this message.`;

  try {
    await sendWhatsAppMessage(phone, inviteMsg);
  } catch (e) {
    console.error("Invite send failed:", e.message);
  }

  // reset session
  biz.sessionState = "branches_menu";
  biz.sessionData = {};
  await saveBiz(biz);

  // confirm to owner
  return sendTwimlText(
    res,
    `✅ Invitation sent

👤 Phone: ${phone}
📍 Branch: ${branch.name}
🔑 Role: ${role}`
  );
}



 

 
  
 

    // Add client flows
    if (state === "adding_client_name") {
      const cname = trimmed;
      if (!cname) return sendTwimlText(res, "Please send a client name.");
      biz.sessionData.clientName = cname;
      biz.sessionState = "adding_client_phone";
      await saveBiz(biz);
      return sendTwimlText(res, "Client phone? (e.g. +263772123456) or reply 1 to cancel.");
    }
    if (state === "adding_client_phone") {
      if (trimmed === "1") { biz.sessionState = "ready"; biz.sessionData = {}; await saveBiz(biz); return sendTwimlText(res, "Cancelled. Reply menu to continue."); }
      const phoneRaw = trimmed;
      const phone = phoneRaw.toLowerCase() === "same" ? providerId : phoneRaw;
      const client = await Client.findOneAndUpdate(
        { businessId: biz._id, phone },
        { $set: { name: biz.sessionData.clientName, phone } },
        { new: true, upsert: true }
      );
      biz.sessionData = {}; biz.sessionState = "ready"; await saveBiz(biz);
      return sendTwimlText(res, `Client saved: ${client.name} (${client.phone}). Reply menu to continue.`);
    }

    // Invoice/Quote/Receipt flows (select client)
    if (state === "creating_invoice_choose_client" && isSingleNumber) {
      const choice = trimmed;
      if (choice === "1") {
        const clients = await Client.find({ businessId: biz._id }).sort({ updatedAt: -1 }).limit(5).lean();

        // Auto-select single client
        if (!clients.length) {
          biz.sessionState = "creating_invoice_new_client";
          await saveBiz(biz);
          return sendTwimlText(res, "No saved clients. Please enter client name:");
        }

        if (clients.length === 1) {
          const client = clients[0];
          biz.sessionData.client = client;
            biz.sessionData.clientId = client._id; // ✅ REQUIRED
          biz.sessionState = "creating_invoice_add_items";
          biz.sessionData.items = biz.sessionData.items || [];
          biz.sessionData.awaitingItemDesc = false;
          biz.sessionData.lastItem = null;
          biz.sessionData.discountPercent = biz.sessionData.discountPercent || 0;
          biz.sessionData.vatPercent = typeof biz.sessionData.vatPercent === "undefined" ? Number(biz.taxRate || 0) : biz.sessionData.vatPercent;
          biz.sessionData.applyVat = typeof biz.sessionData.applyVat === "undefined" ? true : !!biz.sessionData.applyVat;
          await saveBiz(biz);
          const docType = biz.sessionData.docType || "invoice";
          const label = docType === "invoice" ? "Invoice" : docType === "quote" ? "Quotation" : "Receipt";
          return sendTwimlText(res, `Client set to ${client.name || client.phone}. Now send item description for ${label} (e.g. 'Website design')`);
        }

        // multiple clients -> list them
        let lines = ["Choose a client by number:"];
        clients.forEach((c, i) => lines.push(`${i+1}) ${c.name || c.phone} ${c.phone ? "- " + c.phone : ""}`));
        lines.push(`${clients.length+1}) New client`);
        biz.sessionState = "creating_invoice_choose_client_index";
        biz.sessionData.recentClients = clients;
        await saveBiz(biz);
        return sendTwimlText(res, lines.join("\n"));
      }
      if (choice === "2") {
        biz.sessionState = "creating_invoice_new_client"; biz.sessionData = {}; await saveBiz(biz);
        return sendTwimlText(res, "Client name?");
      }
      if (choice === "3") { await resetSession(biz); return sendTwimlText(res, "Cancelled. Reply menu to start again."); }
      return sendTwimlText(res, "Invalid selection. Reply with a number.");
    }

    if (state === "creating_invoice_choose_client_index" && isSingleNumber) {
      const idx = Number(trimmed);
      const clients = biz.sessionData.recentClients || [];
      if (!idx || idx < 1 || idx > clients.length + 1) return sendTwimlText(res, "Invalid selection. Reply the client number or choose New client.");
      if (idx === clients.length + 1) { biz.sessionState = "creating_invoice_new_client"; biz.sessionData = {}; await saveBiz(biz); return sendTwimlText(res, "Client name?"); }
      const client = clients[idx-1];
      biz.sessionData.client = client;
      biz.sessionData.clientId = client._id; // ✅ REQUIRED
      biz.sessionState = "creating_invoice_add_items";
      biz.sessionData.items = biz.sessionData.items || [];
      biz.sessionData.awaitingItemDesc = false;
      biz.sessionData.lastItem = null;
      biz.sessionData.discountPercent = biz.sessionData.discountPercent || 0;
      biz.sessionData.vatPercent = typeof biz.sessionData.vatPercent === "undefined" ? Number(biz.taxRate || 0) : biz.sessionData.vatPercent;
      biz.sessionData.applyVat = typeof biz.sessionData.applyVat === "undefined" ? true : !!biz.sessionData.applyVat;
      await saveBiz(biz);
      const docType = biz.sessionData.docType || "invoice";
      const label = docType === "invoice" ? "Invoice" : docType === "quote" ? "Quotation" : "Receipt";
      return sendTwimlText(res, `Client set to ${client.name || client.phone}. Now send item description for ${label} (e.g. 'Website design')`);
    }

    if (state === "creating_invoice_new_client") {
      if (!biz.sessionData.clientName && trimmed) {
        biz.sessionData.clientName = trimmed; biz.sessionState = "creating_invoice_new_client_phone"; await saveBiz(biz);
        return sendTwimlText(res, "Client phone? (e.g. +263772123456) or reply 1 to cancel.");
      }
    }

    if (state === "creating_invoice_new_client_phone") {
      if (trimmed === "1") { biz.sessionState = "ready"; biz.sessionData = {}; await saveBiz(biz); return sendTwimlText(res, "Cancelled client creation."); }
      const phoneRaw = trimmed;
      const phone = phoneRaw.toLowerCase() === "same" ? providerId : phoneRaw;
      const client = await Client.findOneAndUpdate(
        { businessId: biz._id, phone },
        { $set: { name: biz.sessionData.clientName, phone } },
        { new: true, upsert: true }
      );
      biz.sessionData.client = client; biz.sessionData.items = []; biz.sessionState = "creating_invoice_add_items";
      biz.sessionData.awaitingItemDesc = false;
      biz.sessionData.lastItem = null;
      biz.sessionData.discountPercent = biz.sessionData.discountPercent || 0;
      biz.sessionData.vatPercent = typeof biz.sessionData.vatPercent === "undefined" ? Number(biz.taxRate || 0) : biz.sessionData.vatPercent;
      biz.sessionData.applyVat = typeof biz.sessionData.applyVat === "undefined" ? true : !!biz.sessionData.applyVat;
      await saveBiz(biz);
      const docType = biz.sessionData.docType || "invoice";
      const label = docType === "invoice" ? "Invoice" : docType === "quote" ? "Quotation" : "Receipt";
      return sendTwimlText(res, `Client saved: ${client.name} (${client.phone}). Now send item description for ${label}.`);
    }

    //
    // Items loop: two-phase flow (description/qty first, prices second)
    //
    if (state === "creating_invoice_add_items") {
      const lowered = trimmed.toLowerCase();

      const isCancel = trimmed === "3" || /(^|\s)(cancel|abort|stop)(\s|$)/.test(lowered);
      const wantsEnterPrices = trimmed === "2" || /(^|\s)(prices|enter prices|enter price|enterprices)(\s|$)/.test(lowered);
      const wantsAddAnother = trimmed === "1";

      // expecting qty if awaitingItemDesc
      if (biz.sessionData.awaitingItemDesc && biz.sessionData.lastItem && (!biz.sessionData.lastItem.qty)) {
        const qty = Number(trimmed);
        if (isNaN(qty) || qty <= 0) {
          if (trimmed === "3") { await resetSession(biz); return sendTwimlText(res, "Cancelled. Reply 'menu' to start again."); }
          return sendTwimlText(res, "Invalid qty. Enter a number like '1' (or '3' to cancel).");
        }
        // store as item (we use item field, description still preserved)
        biz.sessionData.lastItem.qty = qty;
        biz.sessionData.items = biz.sessionData.items || [];
        biz.sessionData.items.push({ item: biz.sessionData.lastItem.description, description: biz.sessionData.lastItem.description, qty: qty, unit: null });
        biz.sessionData.lastItem = null;
        biz.sessionData.awaitingItemDesc = false;
        await saveBiz(biz);
        return sendTwimlText(res, `Item recorded (without price). Total items: ${biz.sessionData.items.length}\nReply:\n1) Add another item\n2) Enter prices for added items\n3) Cancel`);
      }

      if (isCancel) {
        await resetSession(biz);
        return sendTwimlText(res, "Invoice creation cancelled.");
      }

      if (wantsEnterPrices) {
        const itemsArr = biz.sessionData.items || [];
        if (!itemsArr.length) return sendTwimlText(res, "No items added yet. Send an item description first.");
        biz.sessionState = "creating_invoice_enter_prices";
        biz.sessionData.priceIndex = 0;
        biz.sessionData.items = itemsArr;
        await saveBiz(biz);
        const next = biz.sessionData.items[0];
        return sendTwimlText(res, `Price entry: item 1) ${next.item || next.description} x${next.qty}\nEnter unit price (e.g. 450) or reply 'skip' to set 0. Reply 'back' to add more items.`);
      }

      if (wantsAddAnother) {
        biz.sessionData.awaitingItemDesc = false;
        biz.sessionData.lastItem = null;
        await saveBiz(biz);
        return sendTwimlText(res, "Send next item description:");
      }

      if (!biz.sessionData.awaitingItemDesc) {
        const desc = trimmed;
        if (!desc) return sendTwimlText(res, "Send an item description (or reply 2 to enter prices).");
        biz.sessionData.awaitingItemDesc = true;
        biz.sessionData.lastItem = { description: desc };
        await saveBiz(biz);
        return sendTwimlText(res, "Qty? (e.g. 1)");
      }

      return sendTwimlText(res, "Send item description or reply 1/2/3.");
    }

    //
    // Price-entry flow
    //
    if (state === "creating_invoice_enter_prices") {
      const items = biz.sessionData.items || [];
      let idx = Number(biz.sessionData.priceIndex || 0);
      if (!Array.isArray(items) || items.length === 0) {
        biz.sessionState = "creating_invoice_add_items"; biz.sessionData.priceIndex = 0; await saveBiz(biz);
        return sendTwimlText(res, "No items to price. Send item description to add items.");
      }

      const lowered = trimmed.toLowerCase();
      if (lowered === "back") {
        biz.sessionState = "creating_invoice_add_items";
        delete biz.sessionData.priceIndex;
        await saveBiz(biz);
        return sendTwimlText(res, "Back to adding items. Send next item description or reply '2' when ready to enter prices.");
      }

      if (/^skip$/i.test(trimmed)) {
        items[idx].unit = 0;
        idx += 1;
        biz.sessionData.priceIndex = idx;
        biz.sessionData.items = items;
        await saveBiz(biz);
      } else {
        const unit = Number(trimmed);
        if (isNaN(unit)) return sendTwimlText(res, "Invalid price. Enter a numeric unit price (e.g. 450), 'skip' to set 0, or 'back' to add more items.");
        items[idx].unit = unit;
        idx += 1;
        biz.sessionData.priceIndex = idx;
        biz.sessionData.items = items;
        await saveBiz(biz);
      }

      if (idx < (biz.sessionData.items || []).length) {
        const next = biz.sessionData.items[idx];
        return sendTwimlText(res, `Price entry: item ${idx+1}) ${next.item || next.description} x${next.qty}\nEnter unit price (e.g. 450) or reply 'skip' to set 0. Reply 'back' to add more items.`);
      }

      // All prices done -> summarize and confirm
      const finalItems = biz.sessionData.items || [];
      const subtotal = finalItems.reduce((s, it) => s + (Number(it.qty||0) * Number(it.unit||0)), 0);

      const discountPercent = Number(biz.sessionData.discountPercent || 0);
      const discountAmount = +(subtotal * (discountPercent / 100));
      const taxable = subtotal - discountAmount;
      const vatPercent = Number(biz.sessionData.vatPercent || 0);
      const applyVat = (biz.sessionData.applyVat === false) ? false : true;
      const vatAmount = applyVat ? +(taxable * (vatPercent / 100)) : 0;
      const total = taxable + vatAmount;

      const docType = biz.sessionData.docType || "invoice";
      const label = docType === "invoice" ? "Invoice" : docType === "quote" ? "Quotation" : "Receipt";
      let summary = `${label} summary for ${biz.sessionData.client?.name || biz.sessionData.client?.phone || "client"}:\n`;
      finalItems.forEach((it, i) => summary += `${i+1}) ${it.item || it.description} x${it.qty} @ ${formatMoney(it.unit||0)} = ${formatMoney((it.qty||0)*(it.unit||0))}\n`);
      summary += `Subtotal: ${formatMoney(subtotal)} ${biz.currency || "ZWL"}\n`;
      if (discountPercent && Number(discountPercent) !== 0) summary += `Discount (${formatMoney(discountPercent)}%): -${formatMoney(discountAmount)} ${biz.currency || "ZWL"}\n`;
      summary += applyVat ? `VAT @ ${formatMoney(vatPercent)}%: ${formatMoney(vatAmount)} ${biz.currency || "ZWL"}\n` : `VAT: Not applied\n`;
      summary += `Total: ${formatMoney(total)} ${biz.currency || "ZWL"}\n\n`;
      summary += `1) Add another item
2) Send & generate PDF
3) Cancel
4) Set discount % (current: ${formatMoney(discountPercent)}%)
5) Set VAT % (current: ${formatMoney(vatPercent)}%)`;
      biz.sessionState = "creating_invoice_confirm";
      delete biz.sessionData.priceIndex;
      await saveBiz(biz);
      return sendTwimlText(res, summary);
    }

    //
    // Set VAT state (new) - sets document-level VAT %
    //
    if (state === "creating_invoice_set_vat") {
      // accept "15" or "15%" etc
      const cleaned = String(trimmed || "").replace(/[^0-9.\-]+/g, "").trim();
      const val = parseFloat(cleaned);
      if (isNaN(val) || val < 0) return sendTwimlText(res, "Invalid VAT percent. Send a number like 15 or 15% (use 0 to clear).");
      biz.sessionData.vatPercent = Number(Math.round(val * 100) / 100);
      // ensure applyVat true when user sets a percent
      biz.sessionData.applyVat = true;
      biz.sessionState = "creating_invoice_confirm";
      await saveBiz(biz);
      // Recompute summary quickly to send to user
      const finalItems = biz.sessionData.items || [];
      const subtotal = finalItems.reduce((s, it) => s + (Number(it.qty||0) * Number(it.unit||0)), 0);
      const discountPercentNow = Number(biz.sessionData.discountPercent || 0);
      const discountAmountNow = +(subtotal * (discountPercentNow / 100));
      const taxableNow = subtotal - discountAmountNow;
      const vatPercentNow = Number(biz.sessionData.vatPercent || 0);
      const applyVatNow = (biz.sessionData.applyVat === false) ? false : true;
      const vatNow = applyVatNow ? +(taxableNow * (vatPercentNow / 100)) : 0;
      const totalNow = taxableNow + vatNow;

      let summary = `VAT set to ${formatMoney(vatPercentNow)}%.\n`;
      finalItems.forEach((it, i) => summary += `${i+1}) ${it.item || it.description} x${it.qty} @ ${formatMoney(it.unit||0)} = ${formatMoney((it.qty||0)*(it.unit||0))}\n`);
      summary += `Subtotal: ${formatMoney(subtotal)} ${biz.currency || "ZWL"}\n`;
      if (discountPercentNow) summary += `Discount (${formatMoney(discountPercentNow)}%): -${formatMoney(discountAmountNow)} ${biz.currency || "ZWL"}\n`;
      summary += applyVatNow ? `VAT @ ${formatMoney(vatPercentNow)}%: ${formatMoney(vatNow)} ${biz.currency || "ZWL"}\n` : `VAT: Not applied\n`;
      summary += `Total: ${formatMoney(totalNow)} ${biz.currency || "ZWL"}\n\n1) Add another item
2) Send & generate PDF
3) Cancel
4) Set discount % (current: ${formatMoney(discountPercentNow)}%)
5) Set VAT % (current: ${formatMoney(vatPercentNow)}%)`;

      return sendTwimlText(res, summary);
    }

    //
    // Set discount % state (existing)
    //
    if (state === "creating_invoice_set_discount") {
      // accept "10" or "10%" etc
      const cleaned = String(trimmed || "").replace(/[^0-9.\-]+/g, "").trim();
      const val = parseFloat(cleaned);
      if (isNaN(val) || val < 0) return sendTwimlText(res, "Invalid discount. Send a number like 10 or 10% (use 0 to clear).");
      biz.sessionData.discountPercent = Number(Math.round(val * 100) / 100);
      biz.sessionState = "creating_invoice_confirm";
      await saveBiz(biz);
      // Recompute summary quickly to send to user
      const finalItems = biz.sessionData.items || [];
      const subtotal = finalItems.reduce((s, it) => s + (Number(it.qty||0) * Number(it.unit||0)), 0);
      const discountPercent = Number(biz.sessionData.discountPercent || 0);
      const discountAmount = +(subtotal * (discountPercent / 100));
      const taxRate = Number(biz.sessionData.vatPercent || 0);
      const applyTax = (biz.sessionData.applyVat === false) ? false : true;
      const taxable = subtotal - discountAmount;
      const tax = applyTax ? +(taxable * (taxRate / 100)) : 0;
      const total = taxable + tax;

      let summary = `Discount set to ${formatMoney(discountPercent)}%.\n`;
      finalItems.forEach((it, i) => summary += `${i+1}) ${it.item || it.description} x${it.qty} @ ${formatMoney(it.unit||0)} = ${formatMoney((it.qty||0)*(it.unit||0))}\n`);
      summary += `Subtotal: ${formatMoney(subtotal)} ${biz.currency || "ZWL"}\n`;
      if (discountPercent) summary += `Discount (${formatMoney(discountPercent)}%): -${formatMoney(discountAmount)} ${biz.currency || "ZWL"}\n`;
      summary += applyTax ? `VAT @ ${formatMoney(taxRate)}%: ${formatMoney(tax)} ${biz.currency || "ZWL"}\n` : `VAT: Not applied\n`;
      summary += `Total: ${formatMoney(total)} ${biz.currency || "ZWL"}\n\n1) Add another item
2) Send & generate PDF
3) Cancel
4) Set discount % (current: ${formatMoney(discountPercent)}%)
5) Set VAT % (current: ${formatMoney(taxRate)}%)`;

      return sendTwimlText(res, summary);
    }

    //
    // Confirmation: generate invoice/quote/receipt
    //
    if (state === "creating_invoice_confirm" && isSingleNumber) {
      const choice = trimmed;
      if (choice === "1") {
        biz.sessionState = "creating_invoice_add_items";
        await saveBiz(biz);
        return sendTwimlText(res, "Send next item description:");
      }
      if (choice === "3") {
        await resetSession(biz); return sendTwimlText(res, "Cancelled.");
      }
      if (choice === "4") {
        biz.sessionState = "creating_invoice_set_discount";
        await saveBiz(biz);
        return sendTwimlText(res, `Send discount percent (e.g. 10 or 10%). Send 0 to clear discount. Current: ${Number(biz.sessionData.discountPercent||0)}%`);
      }
      if (choice === "5") {
        biz.sessionState = "creating_invoice_set_vat";
        await saveBiz(biz);
        return sendTwimlText(res, `Send VAT percent (e.g. 15 or 15%). Send 0 to clear VAT. Current: ${Number(biz.sessionData.vatPercent||0)}%`);
      }
  if (choice === "2") {

  // 🔒 SUBSCRIPTION MONTHLY LIMIT CHECK (STEP 2)
  const limitCheck = checkMonthlyLimit(biz);

  if (!limitCheck.allowed) {
    await saveBiz(biz);
    return sendTwimlText(
      res,
`🚫 Monthly document limit reached

Package: ${limitCheck.package}
Limit: ${limitCheck.limit} documents per month

Reply *upgrade* to unlock more.`
    );
  }

  // ✅ allowed → consume one document
  biz.documentCountMonth += 1;

  const items = biz.sessionData.items || [];

        const client = biz.sessionData.client;
        const docType = (biz.sessionData.docType || "invoice"); // "invoice" | "quote" | "receipt"

        biz.counters = biz.counters || { invoice: 0, quote: 0, receipt: 0 };
        const counterKey = docType === "invoice" ? "invoice" : docType === "quote" ? "quote" : "receipt";
        biz.counters[counterKey] = (biz.counters[counterKey] || 0) + 1;

        const prefix = docType === "invoice" ? (biz.invoicePrefix || "INV") : docType === "quote" ? (biz.quotePrefix || "QT") : (biz.receiptPrefix || "RCPT");
        const numberStr = `${prefix}-${String(biz.counters[counterKey]).padStart(6, "0")}`;

        const date = new Date();
        // ===== NEW: persist invoice before PDF =====
const ctx = await getUserBranchContext(biz, providerId);
const role = ctx?.role || "owner";
const branchId = ctx?.branchId || null;




const subtotal = items.reduce((s, it) => s + (it.qty * it.unit), 0);
const discountPercent = Number(biz.sessionData.discountPercent || 0);
const discountAmount = subtotal * (discountPercent / 100);
const vatPercent = Number(biz.sessionData.vatPercent || 0);
const vatAmount = (biz.sessionData.applyVat !== false)
  ? (subtotal - discountAmount) * (vatPercent / 100)
  : 0;
const total = subtotal - discountAmount + vatAmount;
const invoiceDoc = await Invoice.create({
  businessId: biz._id,
  branchId,
  clientId: client?._id,
  number: numberStr,
  currency: biz.currency,

  items: items.map(i => ({
    item: i.item,
    qty: i.qty,
    unit: i.unit,
    discount: 0,
    total: i.qty * i.unit
  })),

  subtotal,
  discountPercent,
  discountAmount,
  vatPercent,
  vatAmount,
  total,

  // ✅ NEW FIELDS (IMPORTANT)
  amountPaid: 0,
  balance: total,
  status: "unpaid",

  createdBy: providerId
});

        try {
          const { filename } = await generatePDF({
            type: docType === "invoice" ? "invoice" : docType === "quote" ? "quote" : "receipt",
            number: numberStr,
            date,
            dueDate: null,
            billingTo: client?.name || client?.phone,
            email: client?.email || "",
            items,
            notes: "",
            bizMeta: {
              name: biz.name,
              logoUrl: biz.logoUrl,
              address: biz.address || "",
              discountPercent: Number(biz.sessionData.discountPercent || 0),
              vatPercent: Number(biz.sessionData.vatPercent || 0),
              // force applyVat true when a VAT percent > 0 has been set for the document
              applyVat: (Number(biz.sessionData.vatPercent || 0) > 0) ? true : ((biz.sessionData.applyVat === false) ? false : true),
              _id: biz._id?.toString(),
              originalAmount: biz.sessionData.originalAmount || undefined,
              amountPaid: biz.sessionData.amountPaid || undefined,
              currentBalance: biz.sessionData.currentBalance || undefined,
              //status: biz.status || undefined
              status: invoiceDoc.status

            }
          });
          // save updated counters
          await saveBiz(biz);
          const site = (process.env.SITE_URL || "").replace(/\/$/, "");
          const baseForMedia = site || `${(req.get("x-forwarded-proto") || req.protocol)}://${req.get("host")}`;
          const url = `${baseForMedia}/docs/generated/${docType === "invoice" ? "invoices" : docType === "quote" ? "quotes" : "receipts"}/${filename}`;
          await resetSession(biz);
          const label = docType === "invoice" ? "Invoice" : docType === "quote" ? "Quotation" : "Receipt";

          // <-- CHANGED: send only the PDF media with no text body so the download text/link doesn't appear -->
          //return sendTwimlWithMedia(res, null, [url]);
          return sendTwimlWithMedia(
  res,
  "✅ Document created successfully.\n\n👉 Reply *menu* to continue.",
  [url]
);

        } catch (e) {
          console.error("document PDF failed", e && (e.stack || e.message) ? (e.stack || e.message) : e);
          return sendTwimlText(res, `Failed to generate ${docType} PDF; check server logs.`);
        }
      } else {
        await resetSession(biz); return sendTwimlText(res, "Cancelled.");
      }
    }





    // fallback
  // fallback only when truly idle
// FINAL fallback — do NOT override active flows
/*if (state === "idle" || state === "ready") {
  return sendMenuForUser(res, biz, providerId);
}*/

// User is inside a flow, but typed something unexpected
//return sendTwimlText(res, "Invalid option. Reply with a number shown, or 0 for menu.");



// ===== FINAL FALLBACK (ONLY AFTER EVERYTHING ELSE) =====
if (state === "idle" || state === "ready") {
  return sendMenuForUser(res, biz, providerId);
}

// User is inside a flow but typed something invalid
return sendTwimlText(
  res,
  "Invalid option. Reply with a number shown, or 0 for menu."
);


  } catch (err) {
    console.error("TWILIO (biz): webhook handler error:", err && (err.stack || err.message) ? (err.stack || err.message) : err);
    try { return sendTwimlText(res, "Server error; try again later."); } catch (e) { return res.status(500).end(); }
  }
});


export { generatePDF };

export default router;
