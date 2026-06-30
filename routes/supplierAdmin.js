// routes/supplierAdmin.js
import express from "express";
import axios from "axios";
import { requireSupplierAdmin } from "../middleware/supplierAdminAuth.js";
import SupplierProfile from "../models/supplierProfile.js";
import SupplierOrder from "../models/supplierOrder.js";
import SupplierSubscriptionPayment from "../models/supplierSubscriptionPayment.js";
import PhoneContact from "../models/phoneContact.js";   // ← ADD THIS LINE
import SupplierLinkVisitor from "../models/supplierLinkVisitor.js";
import SearchCommandLog from "../models/searchCommandLog.js";
import { sendBuyerSearchHelpTemplate } from "../services/buyerSearchFollowUp.js";
import BuyerRequest from "../models/buyerRequest2.js";
import { notifyBuyerRequestApproved, notifyBuyerRequestRejected, notifyAdminPhotoReview } from "../services/buyerRequestNotifications.js";
import CategoryPreset from "../models/categoryPreset.js";
import { SUPPLIER_CATEGORIES } from "../services/supplierPlans.js";
import { TEMPLATES, getPresetCategories, setTemplateForCategory } from "../services/supplierProductTemplates.js";

import smartLinkRoutes from "./supplierSmartLinkAdmin.js";
import {
  createGroup,
  getAllGroups,
  getGroupBySlug,
  addSellerToGroup,
  removeSellerFromGroup,
  deleteGroup,
  setGroupTagline,
  buildGroupDeepLink,
  buildGroupQrImageUrl,
  validateGroupSlug,
  // ── School group functions ────────────────────────────────────────────
  createSchoolGroup,
  getAllSchoolGroups,
  getSchoolGroupBySlug,
  addSchoolToGroup,
  removeSchoolFromGroup,
  deleteSchoolGroup,
  setSchoolGroupTagline,
  buildSchoolGroupDeepLink,
  buildSchoolGroupQrImageUrl,
} from "../services/groupSmartLink.js";
import { assignSlugToSupplier } from "../services/supplierSmartLink.js";

// ── Staff E-Business Card imports ─────────────────────────────────────────────
// staffCard.js and staffSmartLink.js are loaded lazily so the server starts
// even if they are not yet on disk. Deploy both files then replace this block
// with the static imports and restart.
const STAFF_LINK_SOURCES = { fb:"Facebook", wa:"WhatsApp Status", tt:"TikTok", qr:"QR Scan", sms:"SMS / Flyer", ig:"Instagram", yt:"YouTube", direct:"Direct / Unknown" };

let _staffModulesCache = null;
async function _loadStaffModules() {
  if (_staffModulesCache) return _staffModulesCache;
  try {
    const _sc  = await import("../models/staffCard.js");
    const _ssl = await import("../services/staffSmartLink.js");
    _staffModulesCache = {
      StaffCard:              _sc.default,
      assignSlugToStaffCard:  _ssl.assignSlugToStaffCard,
      buildStaffDeepLink:     _ssl.buildStaffDeepLink,
      buildAllStaffLinks:     _ssl.buildAllStaffLinks,
      buildStaffQrImageUrl:   _ssl.buildStaffQrImageUrl,
      buildStaffProfileCard:  _ssl.buildStaffProfileCard,
      buildStaffSharableCaption:  _ssl.buildStaffSharableCaption,
      buildStaffAnalyticsSummary: _ssl.buildStaffAnalyticsSummary,
    };
    return _staffModulesCache;
  } catch (_err) {
    return null; // files not deployed yet
  }
}


const router = express.Router();



// ─────────────────────────────────────────────────────────────────────────────
// RECEIPT PDF HELPER  –  plain black-and-white A5, logo top-left
// Call:  await _streamReceiptPDF(res, { ...opts })
// Logo resolves from: <projectRoot>/public/zimQouteLogo.jpeg
// ─────────────────────────────────────────────────────────────────────────────
import _receiptPath from "path";
import { fileURLToPath as _receiptFtu } from "url";
import fs       from "fs";
import multer   from "multer";
const _receiptDir = _receiptPath.dirname(_receiptFtu(import.meta.url));

// ── Broadcast media upload setup ──────────────────────────────────────────────
// Files uploaded via the broadcast form are stored in public/broadcasts/
// and served as https://<host>/broadcasts/<filename> for Meta to fetch.
const _broadcastUploadDir = _receiptPath.join(_receiptDir, "..", "public", "broadcasts");
if (!fs.existsSync(_broadcastUploadDir)) fs.mkdirSync(_broadcastUploadDir, { recursive: true });

const _broadcastStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, _broadcastUploadDir),
  filename:    (req, file, cb) => {
    const ext  = _receiptPath.extname(file.originalname) || "";
    const name = "bc_" + Date.now() + "_" + Math.random().toString(36).slice(2, 7) + ext;
    cb(null, name);
  }
});
const _broadcastUpload = multer({
  storage:  _broadcastStorage,
  limits:   { fileSize: 16 * 1024 * 1024 },  // 16 MB max
  fileFilter: (req, file, cb) => {
    const allowed = /\.(jpg|jpeg|png|gif|webp|pdf|mp4|mov)$/i;
    cb(null, allowed.test(file.originalname));
  }
});

async function _streamReceiptPDF(res, {
  filename, ref, isActivation,
  supplierName, phone, location,
  planLabel, cycleLabel,
  amount, currency,
  validFromStr, validUntilStr,
  methodLabel, tableRows
}) {
  const PDFDocument = (await import("pdfkit")).default;
  const doc = new PDFDocument({ size: "A5", margin: 0, info: {
    Title:   `ZimQuote Receipt ${ref}`,
    Author:  "ZimQuote",
    Subject: isActivation ? "Supplier Activation Receipt" : "Supplier Payment Receipt"
  }});

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  doc.pipe(res);

  const W = doc.page.width;   // 419.53 pt
  const H = doc.page.height;  // 595.28 pt
  const MARGIN = 40;
  const CW = W - MARGIN * 2;
  const sym = currency === "ZWL" ? "Z$" : currency === "ZAR" ? "R" : "$";
  const amtNum = Number(amount) || 0;

  // ── LOGO ───────────────────────────────────────────────────────────────────
  const LOGO_SIZE = 52;
  const logoPath = _receiptPath.join(_receiptDir, "..", "public", "zimQouteLogo.jpeg");
  let textX = MARGIN;
  try {
    doc.image(logoPath, MARGIN, H - MARGIN - LOGO_SIZE, { width: LOGO_SIZE, height: LOGO_SIZE });
    textX = MARGIN + LOGO_SIZE + 10;
  } catch (_) { /* logo not found - text only */ }

  doc.fontSize(16).font("Helvetica-Bold").fillColor("#333333")
     .text("ZimQuote", textX, H - MARGIN - 16, { lineBreak: false });
  doc.fontSize(7.5).font("Helvetica").fillColor("#888888")
     .text("Zimbabwe's Marketplace for Products & Services", textX, H - MARGIN - 30, { lineBreak: false })
     .text("support@zimquote.co.zw  |  zimquote.co.zw",    textX, H - MARGIN - 42, { lineBreak: false });

  // ── RECEIPT LABEL / REF / DATE - top right ─────────────────────────────────
  const receiptLabel = isActivation ? "ACTIVATION RECEIPT" : "OFFICIAL RECEIPT";
  doc.fontSize(8).font("Helvetica-Bold").fillColor("#333333")
     .text(receiptLabel, 0, H - MARGIN - 10, { align: "right", width: W - MARGIN, lineBreak: false });
  doc.fontSize(8).font("Helvetica").fillColor("#888888")
     .text(ref,           0, H - MARGIN - 22, { align: "right", width: W - MARGIN, lineBreak: false })
     .text(validFromStr,  0, H - MARGIN - 34, { align: "right", width: W - MARGIN, lineBreak: false });

  // ── HEADER BOTTOM RULE ────────────────────────────────────────────────────
  const ruleY = H - MARGIN - LOGO_SIZE - 14;
  doc.moveTo(MARGIN, ruleY).lineTo(W - MARGIN, ruleY).strokeColor("#000000").lineWidth(1.2).stroke();

  // ── BILLED TO ─────────────────────────────────────────────────────────────
  let y = ruleY - 18;
  doc.fontSize(7).font("Helvetica-Bold").fillColor("#888888")
     .text("BILLED TO", MARGIN, y, { lineBreak: false });

  y -= 14;
  const bizFontSize = supplierName.length < 26 ? 13 : supplierName.length < 34 ? 11 : 9;
  doc.fontSize(bizFontSize).font("Helvetica-Bold").fillColor("#333333")
     .text(supplierName.slice(0, 44), MARGIN, y, { lineBreak: false });

  y -= 14;
  doc.fontSize(9).font("Helvetica").fillColor("#333333")
     .text(phone,    MARGIN, y, { lineBreak: false });
  y -= 13;
  doc.text(location, MARGIN, y, { lineBreak: false });

  // Thin divider
  y -= 12;
  doc.moveTo(MARGIN, y).lineTo(W - MARGIN, y).strokeColor("#cccccc").lineWidth(0.5).stroke();

  // ── PLAN NAME + VALIDITY ──────────────────────────────────────────────────
  y -= 18;
  doc.fontSize(11).font("Helvetica-Bold").fillColor("#333333")
     .text(`${planLabel} Plan  /  ${cycleLabel}`, MARGIN, y, { lineBreak: false });

  y -= 14;
  doc.fontSize(8.5).font("Helvetica").fillColor("#888888")
     .text(`Valid until: ${validUntilStr}`, MARGIN, y, { lineBreak: false });

  // ── AMOUNT (large) ────────────────────────────────────────────────────────
  y -= 22;
  const amtDisplay = amtNum > 0
    ? `${sym}${amtNum.toFixed(2)}`
    : (isActivation ? "Admin Activated" : `${sym}0.00`);
  doc.fontSize(20).font("Helvetica-Bold").fillColor("#333333")
     .text(amtDisplay, MARGIN, y, { lineBreak: false });

  // Status box - right-aligned, same line as amount
  const SW = 74, SH = 22;
  const SX = W - MARGIN - SW;
  const SY = y - 2;
  doc.rect(SX, SY, SW, SH).fillAndStroke("#ffffff", "#000000");
  doc.lineWidth(1);
  const statusText = isActivation ? "ACTIVATED" : "PAID";
  doc.fontSize(9).font("Helvetica-Bold").fillColor("#000000")
     .text(`/ ${statusText}`, SX, SY + 6, { width: SW, align: "center", lineBreak: false });

  // ── RULE ABOVE TABLE ──────────────────────────────────────────────────────
  y -= 20;
  doc.moveTo(MARGIN, y).lineTo(W - MARGIN, y).strokeColor("#000000").lineWidth(0.8).stroke();

  // ── TABLE ─────────────────────────────────────────────────────────────────
  const ROW_H = 22;

  // Header
  y -= ROW_H;
  doc.rect(MARGIN, y, CW, ROW_H).fill("#f5f5f5");
  doc.fontSize(7.5).font("Helvetica-Bold").fillColor("#333333")
     .text("DESCRIPTION", MARGIN + 6, y + 7, { lineBreak: false });
  doc.text("DETAILS", W - MARGIN - 6 - doc.widthOfString("DETAILS"), y + 7, { lineBreak: false });

  tableRows.forEach(([label, value], i) => {
    y -= ROW_H;
    if (i % 2 === 0) doc.rect(MARGIN, y, CW, ROW_H).fill("#f5f5f5");
    doc.moveTo(MARGIN, y).lineTo(W - MARGIN, y).strokeColor("#cccccc").lineWidth(0.4).stroke();
    doc.fontSize(7.5).font("Helvetica-Bold").fillColor("#888888")
       .text(label.toUpperCase(), MARGIN + 6, y + 7, { lineBreak: false });
    const valStr = String(value).slice(0, 54);
    doc.fontSize(8.5).font("Helvetica").fillColor("#333333")
       .text(valStr, W - MARGIN - 6 - doc.widthOfString(valStr), y + 7, { lineBreak: false });
  });

  // Table bottom rule
  doc.moveTo(MARGIN, y).lineTo(W - MARGIN, y).strokeColor("#000000").lineWidth(0.8).stroke();

  // ── FOOTER ────────────────────────────────────────────────────────────────
  const FY = MARGIN + 36;
  doc.moveTo(MARGIN, FY + 30).lineTo(W - MARGIN, FY + 30).strokeColor("#000000").lineWidth(1.2).stroke();

  doc.fontSize(8).font("Helvetica-Bold").fillColor("#333333")
     .text("Thank you for your business.", MARGIN, FY + 18, { lineBreak: false });
  doc.fontSize(7.5).font("Helvetica").fillColor("#888888")
     .text("Type  menu  on WhatsApp to manage your listing.", MARGIN, FY + 7, { lineBreak: false });

  doc.fontSize(7.5).font("Helvetica").fillColor("#888888")
     .text("zimquote.co.zw", 0, FY + 18, { align: "right", width: W - MARGIN, lineBreak: false })
     .text(isActivation ? "Activation Receipt" : "Official Receipt",
           0, FY + 7, { align: "right", width: W - MARGIN, lineBreak: false });

  doc.moveTo(MARGIN, MARGIN).lineTo(W - MARGIN, MARGIN).strokeColor("#000000").lineWidth(1.2).stroke();

  doc.end();
}

router.use(express.json());
router.use(express.urlencoded({ extended: true }));
const ADMIN_PASSWORD = process.env.SUPPLIER_ADMIN_PASSWORD || "zimquote_admin_2026";

// ── Login ──────────────────────────────────────────────────────────────────
router.get("/login", (req, res) => {
  // ← FIX: if already logged in, go to dashboard (prevents redirect loop)
  if (req.session && req.session.isSupplierAdmin) {
    return res.redirect("/zq-admin");
  }
  res.send(`<!DOCTYPE html><html><head><title>ZimQuote Admin</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:system-ui,sans-serif;background:#0f172a;
     display:flex;align-items:center;justify-content:center;min-height:100vh}
.card{background:white;padding:40px;border-radius:12px;width:360px;box-shadow:0 20px 60px rgba(0,0,0,.4)}
h2{margin-bottom:8px;color:#0f172a;font-size:22px}
p{color:#64748b;font-size:14px;margin-bottom:24px}
input{width:100%;padding:12px;border:1px solid #e2e8f0;border-radius:8px;
      margin-bottom:16px;font-size:16px;outline:none}
input:focus{border-color:#2563eb}
button{width:100%;padding:12px;background:#2563eb;color:white;
       border:none;border-radius:8px;font-size:16px;cursor:pointer;font-weight:600}
button:hover{background:#1d4ed8}
.error{color:#ef4444;margin-bottom:12px;font-size:14px;background:#fef2f2;
       padding:10px;border-radius:6px}
</style></head><body>
<div class="card">
  <h2>⚡ ZimQuote Admin</h2>
  <p>Supplier platform management</p>
  ${req.query.error ? '<div class="error">❌ Invalid password. Try again.</div>' : ""}
  <form method="POST" action="/zq-admin/login">
    <input type="password" name="password" placeholder="Enter admin password" autofocus autocomplete="off"/>
    <button type="submit">Login →</button>
  </form>
</div>
</body></html>`);
});

router.post("/login", (req, res) => {
  if (req.body.password === ADMIN_PASSWORD) {
    req.session.isSupplierAdmin = true;
    res.redirect("/zq-admin");
  } else {
    res.redirect("/zq-admin/login?error=1");
  }
});

router.post("/logout", requireSupplierAdmin, (req, res) => {
  req.session.isSupplierAdmin = false;
  res.redirect("/zq-admin/login");
});

// ── Dashboard ──────────────────────────────────────────────────────────────
router.get("/", requireSupplierAdmin, async (req, res) => {
  try {
    const [
      totalSuppliers,
      activeSuppliers,
      pendingSuppliers,
      totalOrders,
      pendingOrders,
      acceptedOrders,
      completedOrders,
      recentSuppliers,
      recentOrders,
      revenue
    ] = await Promise.all([
      SupplierProfile.countDocuments(),
      SupplierProfile.countDocuments({ active: true }),
      SupplierProfile.countDocuments({ active: false }),
      SupplierOrder.countDocuments(),
      SupplierOrder.countDocuments({ status: "pending" }),
      SupplierOrder.countDocuments({ status: "accepted" }),
      SupplierOrder.countDocuments({ status: "completed" }),
      SupplierProfile.find().sort({ createdAt: -1 }).limit(5).lean(),
      SupplierOrder.find().sort({ createdAt: -1 }).limit(5)
        .populate("supplierId", "businessName").lean(),
      SupplierSubscriptionPayment.aggregate([
        { $match: { status: "paid" } },
        { $group: { _id: null, total: { $sum: "$amount" } } }
      ])
    ]);

    const totalRevenue = revenue[0]?.total || 0;

    const [hospitalityActive, productActive, serviceActive] = await Promise.all([
      SupplierProfile.countDocuments({ profileType: "hospitality", active: true }),
      SupplierProfile.countDocuments({ profileType: "product",     active: true }),
      SupplierProfile.countDocuments({ profileType: "service",     active: true })
    ]);

    res.send(layout("Dashboard", `
      <div class="stats-grid">
        ${stat(totalSuppliers, "Total Suppliers", "")}
        ${stat(activeSuppliers, "Active Listings", "green")}
        ${stat(pendingSuppliers, "Inactive", "orange")}
        ${stat(totalOrders, "Total Orders", "blue")}
        ${stat(pendingOrders, "Pending Orders", "yellow")}
        ${stat(completedOrders, "Completed Orders", "teal")}
        ${stat("$" + totalRevenue.toFixed(2), "Subscription Revenue", "purple")}
      </div>

      <div class="stats-grid">
        <a href="/zq-admin/suppliers?type=product" style="text-decoration:none">
          ${stat(productActive, "📦 Product Suppliers", "")}
        </a>
        <a href="/zq-admin/suppliers?type=service" style="text-decoration:none">
          ${stat(serviceActive, "🔧 Service Providers", "")}
        </a>
        <a href="/zq-admin/suppliers?type=hospitality" style="text-decoration:none">
          ${stat(hospitalityActive, "🏨 Hospitality / Tourism", "teal")}
        </a>
      </div>

      <div class="two-col">
        <div class="panel">
          <h3>Recent Suppliers</h3>
          <table>
            <thead><tr><th>Business</th><th>Phone</th><th>Status</th><th></th></tr></thead>
            <tbody>
              ${recentSuppliers.map(s => `
              <tr>
                <td><strong>${esc(s.businessName)}</strong></td>
                <td>${esc(s.phone)}</td>
                <td>${badge(s.active ? "Active" : "Inactive", s.active ? "green" : "gray")}</td>
                <td><a href="/zq-admin/suppliers/${s._id}" class="btn-link">View →</a></td>
              </tr>`).join("")}
            </tbody>
          </table>
        </div>
        <div class="panel">
          <h3>Recent Orders</h3>
          <table>
            <thead><tr><th>Supplier</th><th>Buyer</th><th>Status</th><th>Total</th></tr></thead>
            <tbody>
              ${recentOrders.map(o => `
              <tr>
                <td>${esc(o.supplierId?.businessName || "Unknown")}</td>
                <td>${esc(o.buyerPhone)}</td>
                <td>${badge(o.status, statusColor(o.status))}</td>
                <td>$${(o.totalAmount || 0).toFixed(2)}</td>
              </tr>`).join("")}
            </tbody>
          </table>
        </div>
      </div>
    `));
  } catch (err) {
    res.send(layout("Dashboard", `<div class="alert red">Error: ${err.message}</div>`));
  }
});

// ── Suppliers List ─────────────────────────────────────────────────────────
router.get("/suppliers", requireSupplierAdmin, async (req, res) => {
  try {
    const { search = "", status = "", tier = "", type = "", page = 1 } = req.query;
    const limit = 20;
    const skip = (Number(page) - 1) * limit;

    const query = {};
    if (search) {
      query.$or = [
        { businessName: { $regex: search, $options: "i" } },
        { phone: { $regex: search, $options: "i" } },
        { "location.city": { $regex: search, $options: "i" } }
      ];
    }
    if (status === "active")   query.active = true;
    if (status === "inactive") query.active = false;
    if (tier)   query.tier = tier;
    if (type)   query.profileType = type;

    const [suppliers, total] = await Promise.all([
      SupplierProfile.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      SupplierProfile.countDocuments(query)
    ]);

    const pages = Math.ceil(total / limit);
    const qs = (p) => `?page=${p}&search=${encodeURIComponent(search)}&status=${status}&tier=${tier}&type=${type}`;

    const listSuccess = req.query.success
      ? `<div style="background:#dcfce7;color:#16a34a;padding:12px 16px;border-radius:8px;margin-bottom:14px">✅ ${esc(req.query.success)}</div>`
      : "";
    const listError = req.query.error
      ? `<div style="background:#fee2e2;color:#dc2626;padding:12px 16px;border-radius:8px;margin-bottom:14px">❌ ${esc(req.query.error)}</div>`
      : "";

    res.send(layout("Suppliers", `
      ${listSuccess}${listError}
<div class="panel">
    <div class="panel-head">
          <h3>Suppliers <span class="count">${total}</span></h3>
          <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
            <a href="/zq-admin/suppliers/new" class="btn btn-green btn-sm">➕ Register New</a>
            <form method="GET" class="filter-form">
              <input name="search" placeholder="Name, phone, city..." value="${esc(search)}" />
              <select name="status">
                <option value="">All Status</option>
                <option ${status === "active" ? "selected" : ""} value="active">Active</option>
                <option ${status === "inactive" ? "selected" : ""} value="inactive">Inactive</option>
              </select>
              <select name="tier">
                <option value="">All Tiers</option>
                <option ${tier === "basic" ? "selected" : ""} value="basic">Basic</option>
                <option ${tier === "pro" ? "selected" : ""} value="pro">Pro</option>
                <option ${tier === "featured" ? "selected" : ""} value="featured">Featured</option>
              </select>
              <select name="type">
                <option value="">All Types</option>
                <option ${type === "product" ? "selected" : ""} value="product">📦 Product Suppliers</option>
                <option ${type === "service" ? "selected" : ""} value="service">🔧 Service Providers</option>
                <option ${type === "hospitality" ? "selected" : ""} value="hospitality">🏨 Hospitality / Tourism</option>
              </select>
              <button type="submit">Filter</button>
              <a href="/zq-admin/suppliers" class="btn-reset">Clear</a>
            </form>
          </div>
        </div>
        <table>
          <thead>
            <tr>
              <th>Business</th><th>Phone</th><th>City</th><th>Type</th>
              <th>Tier</th><th>Status</th><th>Orders</th><th>Rating</th><th></th>
            </tr>
          </thead>
          <tbody>
            ${suppliers.map(s => `
            <tr>
              <td><strong>${esc(s.businessName)}</strong></td>
              <td>${esc(s.phone)}</td>
              <td>${esc(s.location?.city || "-")}</td>
              <td><span class="type-pill">${
                s.profileType === "hospitality" ? "🏨 " + (s.tourismSubtype?.[0] || "hospitality") :
                s.profileType === "service" ? "🔧 service" : "📦 product"
              }</span></td>
              <td>${badge(s.tier || "basic", tierColor(s.tier))}</td>
              <td>${badge(s.active ? "Active" : "Inactive", s.active ? "green" : "gray")}</td>
              <td>${s.completedOrders || 0}</td>
              <td>⭐ ${(s.rating || 0).toFixed(1)}</td>
              <td style="white-space:nowrap">
                <a href="/zq-admin/suppliers/${s._id}" class="btn-link">Manage →</a>
                &nbsp;
                <a href="/zq-admin/suppliers/${s._id}/delete-confirm" class="btn-link" style="color:#ef4444">Delete</a>
              </td>
            </tr>`).join("")}
          </tbody>
        </table>
        ${pages > 1 ? `
        <div class="pagination">
          ${Array.from({ length: pages }, (_, i) => i + 1).map(p =>
            `<a href="/zq-admin/suppliers${qs(p)}" class="${Number(page) === p ? "active" : ""}">${p}</a>`
          ).join("")}
        </div>` : ""}
      </div>
    `));
  } catch (err) {
    res.send(layout("Suppliers", `<div class="alert red">Error: ${err.message}</div>`));
  }
});

// ── Register New Supplier (Admin) ──────────────────────────────────────────
router.get("/suppliers/new", requireSupplierAdmin, async (req, res) => {
  const { SUPPLIER_CITIES, SUPPLIER_CATEGORIES, SERVICE_COLLAR_GROUPS } = await import("../services/supplierPlans.js");

  const productCats = SUPPLIER_CATEGORIES.filter(c => c.types?.includes("product"));
  const serviceCats = SUPPLIER_CATEGORIES.filter(c => c.types?.includes("service"));

  // Build category options grouped by collar for services
  const serviceOptgroups = Object.entries(SERVICE_COLLAR_GROUPS).map(([key, group]) => {
    const cats = serviceCats.filter(c => c.collar === key);
    const options = cats.map(c => `<option value="${esc(c.id)}">${esc(c.label)}</option>`).join("");
    return `<optgroup label="${esc(group.label)}">${options}</optgroup>`;
  }).join("");

  const productOptions = productCats.map(c =>
    `<option value="${esc(c.id)}">${esc(c.label)}</option>`
  ).join("");

  const cityOptions = SUPPLIER_CITIES.map(city =>
    `<option value="${esc(city)}">${esc(city)}</option>`
  ).join("");

  const subcatMap = SUPPLIER_CATEGORIES
    .filter(c => c.subcats?.length)
    .reduce((acc, c) => {
      acc[c.id] = c.subcats.map(s => ({ id: s.id, label: s.label }));
      return acc;
    }, {});

      const ADMIN_PRODUCT_PRESETS = {
    plumbing_supplies: {
      products: [
        "110mm pvc pipe",
        "110mm pvc ug pipe",
        "110mm ac pvc pipe",
        "50mm waste pipe",
        "32mm p trap",
        "40mm p trap",
        "50mm p trap",
        "32mm bottle trap",
        "100mm floor drain",
        "110mm inspection eye",
        "110mm plain bend",
        "110mm h t bend",
        "110mm plain tee",
        "110mm access tee",
        "110mm y junction",
        "110-50 reducer tee",
        "110mm vent valve",
        "110mm boss connector",
        "50mm plain bend",
        "50mm ie bend",
        "50mm ic tee",
        "gulley p",
        "gulley heads",
        "15mm pipe clip",
        "20mm pipe clip",
        "15mm male connector",
        "15mm cap elbow",
        "22mm cap elbow",
        "3/4 cu elbow",
        "22mm cu pipe",
        "15mm cu pipe",
        "solvent cement",
        "soldering wire",
        "nasco flux",
        "gas canister",
        "masonry disk",
        "basin pedestal",
        "basin waste",
        "toilet lid",
        "shower rose and arm"
      ],
      prices: [
        "110mm pvc pipe, 10, each",
        "110mm pvc ug pipe, 10, each",
        "110mm ac pvc pipe, 12, each",
        "50mm waste pipe, 6, each",
        "32mm p trap, 5, each",
        "40mm p trap, 5, each",
        "50mm p trap, 5, each",
        "32mm bottle trap, 10, each",
        "100mm floor drain, 10, each",
        "110mm inspection eye, 15, each",
        "110mm plain bend, 3, each",
        "110mm h t bend, 3, each",
        "110mm plain tee, 4, each",
        "110mm access tee, 12, each",
        "110mm y junction, 4, each",
        "110-50 reducer tee, 4, each",
        "110mm vent valve, 3, each",
        "110mm boss connector, 3, each",
        "50mm plain bend, 1, each",
        "50mm ie bend, 0.5, each",
        "50mm ic tee, 1, each",
        "gulley p, 2.5, each",
        "gulley heads, 4, each",
        "15mm pipe clip, 0.5, each",
        "20mm pipe clip, 1, each",
        "15mm male connector, 1.5, each",
        "15mm cap elbow, 0.5, each",
        "22mm cap elbow, 1.5, each",
        "3/4 cu elbow, 1.5, each",
        "22mm cu pipe, 35, each",
        "15mm cu pipe, 20, each",
        "solvent cement, 10, each",
        "soldering wire, 10, each",
        "nasco flux, 5, each",
        "gas canister, 3, each",
        "masonry disk, 10, each",
        "basin pedestal, 30, each",
        "basin waste, 5, each",
        "toilet lid, 10, each",
        "shower rose and arm, 8, each"
      ]
    }
  };
  const error   = req.query.error   ? `<div class="alert red" style="margin-bottom:16px">❌ ${esc(req.query.error)}</div>` : "";
  const success = req.query.success ? `<div style="background:#dcfce7;color:#16a34a;padding:14px;border-radius:8px;margin-bottom:16px">✅ ${esc(req.query.success)}</div>` : "";

  res.send(layout("Register Supplier", `
    <a href="/zq-admin/suppliers" class="back-link">← Back to Suppliers</a>
    ${error}${success}

    <div class="panel" style="max-width:860px">
      <div class="panel-head">
        <h3>➕ Register New Supplier / Service Provider</h3>
        <span style="font-size:12px;color:var(--muted)">Admin-created listing - bypasses WhatsApp flow</span>
      </div>

      <form method="POST" action="/zq-admin/suppliers/new" class="edit-form">

        <!-- ── SECTION 1: Business Info ─────────────────────────────── -->
        <div style="margin-bottom:20px;padding-bottom:16px;border-bottom:1px solid var(--border)">
          <p style="font-weight:700;font-size:13px;margin-bottom:14px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px">
            1. Business Info
          </p>
          <div class="form-grid">
            <div class="fg">
              <label>Business Name <span style="color:red">*</span></label>
              <input name="businessName" placeholder="e.g. Ace Hardware Harare" required />
            </div>
            <div class="fg">
              <label>WhatsApp Phone <span style="color:red">*</span></label>
              <input name="phone" placeholder="e.g. 2637712345678" required
                     title="Include country code, no + sign. e.g. 2637712345678" />
            </div>
            <div class="fg">
              <label>City <span style="color:red">*</span></label>
              <select name="city" required>
                <option value="">Select city...</option>
                ${cityOptions}
                <option value="Other">Other</option>
              </select>
            </div>
                    <div class="fg">
              <label>Area / Suburb <span style="color:red">*</span></label>
              <input name="area" placeholder="e.g. Borrowdale, Avondale" required />
            </div>

<div class="fg">
  <label>Contact Details</label>
  <input name="contactDetails" placeholder="e.g. 0772123456 / 0712345678 / sales@business.co.zw" />
</div>
<div class="fg">
  <label>Website</label>
  <input name="website" placeholder="e.g. www.business.co.zw / facebook.com/business" />
</div>
            <div class="fg">
              <label>Address</label>
              <input name="address" placeholder="e.g. 123 Samora Machel Ave / Shop 12 / Stand 45" />
            </div>
          </div>
        </div>

        <!-- ── SECTION 2: Business Type & Category ──────────────────── -->
        <div style="margin-bottom:20px;padding-bottom:16px;border-bottom:1px solid var(--border)">
          <p style="font-weight:700;font-size:13px;margin-bottom:14px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px">
            2. Type & Category
          </p>
          <div class="form-grid">
            <div class="fg">
              <label>Profile Type <span style="color:red">*</span></label>
              <select name="profileType" id="profileTypeSelect" required onchange="toggleCategoryGroups()">
                <option value="product">📦 Product Supplier</option>
                <option value="service">🔧 Service Provider</option>
                <option value="hospitality">🏨 Lodge / Hotel / Tourism</option>
              </select>
            </div>
            <div class="fg">
              <label>Tier / Plan <span style="color:red">*</span></label>
              <select name="tier" required>
                <option value="basic">Basic - up to 20 items</option>
                <option value="pro">Pro - up to 60 items</option>
                <option value="featured">Featured - up to 150 items</option>
              </select>
            </div>
          </div>
                 <div class="form-grid">
            <div class="fg" id="productCatWrap">
              <label>Product Category</label>
              <select name="productCategory" id="productCategorySelect" onchange="updateSubcats()">
                <option value="">Select category...</option>
                ${productOptions}
              </select>
            </div>
            <div class="fg" id="serviceCatWrap" style="display:none">
              <label>Service Category</label>
              <select name="serviceCategory" id="serviceCategorySelect" onchange="updateSubcats()">
                <option value="">Select category...</option>
                ${serviceOptgroups}
              </select>
            </div>
            <div class="fg" id="subcatWrap" style="display:none">
              <label>Specialisation / Sub-category</label>
              <select name="subcategory" id="subcategorySelect">
                <option value="">All / General</option>
              </select>
            </div>
          </div>

        
        </div>

        <!-- ── SECTION 3: Products / Services ───────────────────────── -->
              <!-- ── SECTION 3: Products / Services ───────────────────────── -->
        <div style="margin-bottom:20px;padding-bottom:16px;border-bottom:1px solid var(--border)">
          <p style="font-weight:700;font-size:13px;margin-bottom:14px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px">
            3. Products / Services
          </p>

          <div class="fg full" id="presetToolsWrap" style="margin-bottom:14px">
            <label>Preset Items</label>
            <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
              <select id="presetSelector" style="min-width:260px;padding:10px;border:1px solid #e2e8f0;border-radius:8px">
                <option value="">Select preset to load...</option>
                <option value="plumbing_supplies">🚿 Plumbing Supplies Preset</option>
              </select>
              <button type="button" class="btn btn-blue btn-sm" onclick="doLoadPreset()">
                📦 Load Preset Items
              </button>
            </div>
            <span id="presetLoadHint" style="font-size:11px;color:var(--muted)">
              Choose a preset and load products plus suggested prices into the form.
            </span>
          </div>


                  <div class="fg full" style="margin-bottom:12px">
            <label id="productsLabel">Products (comma-separated)</label>
            <textarea name="products" id="productsTextarea" rows="4"
              placeholder="cooking oil, rice, sugar, mealie meal 10kg"></textarea>
            <span style="font-size:11px;color:var(--muted)">These become the supplier's searchable catalogue items.</span>
          </div>
          <div class="fg full" id="pricesWrap" style="margin-bottom:12px">
            <label>Prices (one per line: <code>product, amount, unit</code>)</label>
            <textarea name="prices" id="pricesTextarea" rows="4"
              placeholder="cooking oil, 4.50, litre&#10;rice, 8.00, 5kg bag&#10;sugar, 1.20, kg"></textarea>
            <span style="font-size:11px;color:var(--muted)">Optional - leave blank to let supplier set prices later.</span>
          </div>
          <div class="fg full" id="ratesWrap" style="display:none;margin-bottom:12px">
            <label>Service Rates (one per line: <code>service name, rate</code>)</label>
            <textarea name="rates" id="ratesTextarea" rows="4"
              placeholder="burst pipe repair, 30/job&#10;geyser installation, 80/job&#10;blocked drain, 25/hr"></textarea>
            <span style="font-size:11px;color:var(--muted)">Optional - format: <code>service name, amount/unit</code></span>
          </div>
        </div>

        <!-- ── SECTION 4: Delivery / Travel ─────────────────────────── -->
        <div style="margin-bottom:20px;padding-bottom:16px;border-bottom:1px solid var(--border)">
          <p style="font-weight:700;font-size:13px;margin-bottom:14px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px">
            4. Delivery / Travel
          </p>
          <div class="form-grid">
            <div class="fg" id="deliveryWrap">
              <label>Delivery Available?</label>
              <select name="deliveryAvailable">
                <option value="false">🏠 Collection Only</option>
                <option value="true">🚚 Yes, Delivers</option>
              </select>
            </div>
            <div class="fg" id="travelWrap" style="display:none">
              <label>Travel to Clients?</label>
              <select name="travelAvailable">
                <option value="true">🚗 Yes, Travels to Clients</option>
                <option value="false">📍 Clients Come to Provider</option>
              </select>
            </div>
            <div class="fg">
              <label>Min Order ($)</label>
              <input type="number" name="minOrder" value="0" min="0" step="0.5" />
            </div>
          </div>
        </div>

        <!-- ── SECTION 4b: Hospitality / Tourism Details ──────────────── -->
        <div id="hospitalityWrap" style="display:none;margin-bottom:20px;padding-bottom:16px;border-bottom:1px solid var(--border)">
          <p style="font-weight:700;font-size:13px;margin-bottom:14px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px">
            4b. Hospitality & Tourism Details
          </p>

          <div class="form-grid">
            <div class="fg">
              <label>Business Sub-type <span style="font-weight:400;font-size:11px;text-transform:none">(select all that apply)</span></label>
              <div style="display:flex;flex-direction:column;gap:6px;padding:10px;border:1px solid var(--border);border-radius:7px">
                ${[
                  ["lodge","🌿 Lodge / Bush Camp"],["hotel","🏨 Hotel / Motel"],
                  ["guesthouse","🏡 Guesthouse / B&B"],["self_catering","🍳 Self-Catering / Chalet"],
                  ["campsite","⛺ Campsite / Caravan Park"],["safari_operator","🦁 Safari Operator / Game Drives"],
                  ["tour_guide","🗺 Tour Guide / City Tours"],["boat_hire","⛵ Boat Hire / Cruises"],
                  ["travel_agency","✈️ Travel Agency / Packages"]
                ].map(([val,label]) => `
                <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:13px;font-weight:400;text-transform:none;letter-spacing:0;color:var(--text)">
                  <input type="checkbox" name="tourismSubtype" value="${val}" style="width:15px;height:15px"> ${label}
                </label>`).join("")}
              </div>
            </div>
            <div class="fg">
              <label>Tourism Areas / Destinations</label>
              <textarea name="tourismAreas" rows="3"
                placeholder="e.g. Kariba, Hwange, Victoria Falls, Nyanga"></textarea>
              <span style="font-size:11px;color:var(--muted)">Comma-separated. Areas/parks/destinations this operator serves.</span>
            </div>
          </div>

          <div class="form-grid">
            <div class="fg">
              <label>Check-in Time</label>
              <input name="checkInTime" placeholder="e.g. 14:00 or 2pm" />
            </div>
            <div class="fg">
              <label>Check-out Time</label>
              <input name="checkOutTime" placeholder="e.g. 10:00 or 10am" />
            </div>
            <div class="fg">
              <label>Max Capacity (total guests)</label>
              <input type="number" name="maxCapacity" value="0" min="0" placeholder="e.g. 20" />
            </div>
            <div class="fg">
              <label>Meal Plan</label>
              <select name="mealPlan">
                <option value="not_applicable">Not applicable</option>
                <option value="room_only">Room only</option>
                <option value="bed_breakfast">Bed & Breakfast</option>
                <option value="half_board">Half Board</option>
                <option value="full_board">Full Board</option>
                <option value="self_catering">Self-Catering</option>
              </select>
            </div>
          </div>

          <div class="fg full" style="margin-top:10px">
            <label>Facilities</label>
            <div style="display:flex;flex-wrap:wrap;gap:8px;padding:10px;border:1px solid var(--border);border-radius:7px">
              ${[
                ["wifi","📶 WiFi"],["pool","🏊 Pool"],["hot_shower","🚿 Hot shower"],
                ["breakfast","🍳 Breakfast"],["en_suite","🚪 En-suite"],["generator","⚡ Generator/Solar"],
                ["dstv","📺 DSTV"],["braai","🔥 Braai/BBQ"],["aircon","❄️ Air conditioning"],
                ["game_drives","🦁 Game drives"],["fishing","🎣 Fishing"],["boat_hire","⛵ Boat hire"],
                ["conference","🏢 Conference room"],["restaurant","🍽 Restaurant/Bar"],["laundry","👕 Laundry"],
                ["parking","🅿️ Parking"],["pets_allowed","🐕 Pets allowed"],["child_friendly","👶 Child-friendly"]
              ].map(([val,label]) => `
              <label style="display:flex;align-items:center;gap:5px;cursor:pointer;font-size:12px;color:var(--text);font-weight:400;text-transform:none;letter-spacing:0">
                <input type="checkbox" name="facilities" value="${val}" style="width:14px;height:14px"> ${label}
              </label>`).join("")}
            </div>
          </div>

          <div class="fg full" style="margin-top:12px">
            <label>🛏 Room / Accommodation Types <span style="font-weight:400;color:var(--muted)">(one per line - price optional)</span></label>
            <textarea name="roomTypes" rows="5"
              placeholder="Double Room, 2, 80&#10;Twin Room, 2, 80&#10;Family Chalet, 6, 150&#10;Presidential Suite, 2&#10;Camping Site, 4"></textarea>
            <span style="font-size:11px;color:var(--muted)">
              Format: <code>Room name, max guests, price/night</code> &nbsp;-&nbsp; price can be left out (shows "price on request")
            </span>
          </div>

          <div class="fg full" style="margin-top:12px">
            <label>🎯 Activities &amp; Tour Services <span style="font-weight:400;color:var(--muted)">(one per line - price optional)</span></label>
            <textarea name="activityServices" rows="6"
              placeholder="Safari Game Drive, 35&#10;Sunset Boat Cruise, 25&#10;Fishing Trip (half day), 20&#10;Full-Day Tour, 60&#10;Airport Transfer&#10;Canoe Hire (per hour)"></textarea>
            <span style="font-size:11px;color:var(--muted)">
              For safari operators, tour guides, boat hire, travel agencies, etc.
              Format: <code>Service name, price per person/trip</code> &nbsp;-&nbsp; price can be left out.
              These appear in the smart link catalogue and tourist can request a quote for any of them.
            </span>
          </div>
        </div>

        <!-- ── SECTION 5: Subscription & Activation ─────────────────── -->
        <div style="margin-bottom:20px;padding-bottom:16px;border-bottom:1px solid var(--border)">
          <p style="font-weight:700;font-size:13px;margin-bottom:14px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px">
            5. Subscription & Activation
          </p>
          <div class="form-grid">
            <div class="fg">
              <label>Billing Cycle</label>
              <select name="billingCycle">
                <option value="monthly">Monthly</option>
                <option value="annual">Annual</option>
              </select>
            </div>
            <div class="fg">
              <label>Duration (days)</label>
              <input type="number" name="durationDays" value="30" min="1" max="365" />
            </div>
            <div class="fg">
              <label>Set Active Immediately?</label>
              <select name="setActive">
                <option value="true">✅ Yes - visible to buyers now</option>
                <option value="false">⏸ No - save as inactive</option>
              </select>
            </div>
            <div class="fg">
              <label>Currency</label>
              <select name="currency">
                <option value="USD">USD ($)</option>
                <option value="ZWL">ZWL (Z$)</option>
                <option value="ZAR">ZAR (R)</option>
              </select>
            </div>
          </div>
        </div>

        <!-- ── SECTION 6: Admin Note ─────────────────────────────────── -->
        <div class="fg full" style="margin-bottom:20px">
          <label>Admin Note (internal only)</label>
          <textarea name="adminNote" rows="2"
            placeholder="e.g. Registered at trade fair, paid cash, free trial..."></textarea>
        </div>
        <input type="hidden" name="useCategoryPreset" id="useCategoryPreset" value="false" />
        <div class="form-actions">
          <button type="submit" class="btn btn-green">✅ Register Supplier</button>
          <a href="/zq-admin/suppliers" class="btn btn-gray">Cancel</a>
        </div>
      </form>
    </div>

       <script>
    const SUBCATS = ${JSON.stringify(subcatMap)};
    window.ADMIN_PRODUCT_PRESETS = ${JSON.stringify(ADMIN_PRODUCT_PRESETS)};

           function doLoadPreset() {
      var presets = window.ADMIN_PRODUCT_PRESETS || {};
      var sel     = document.getElementById("presetSelector");
      var key     = sel ? sel.value : "";
      if (!key) { alert("Select a preset first."); return; }
      var p = presets[key];
      if (!p) { alert("Preset data not found."); return; }
      var ta   = document.getElementById("productsTextarea");
      var tp   = document.getElementById("pricesTextarea");
      var cat  = document.getElementById("productCategorySelect");
      var hint = document.getElementById("presetLoadHint");
      var ucp  = document.getElementById("useCategoryPreset");
      if (ta && p.products) ta.value = p.products.join(", ");
      if (tp && p.prices)   tp.value = p.prices.join("\\n");
      if (cat) { cat.value = key; }
      if (ucp) { ucp.value = "true"; }
      if (hint) {
        hint.textContent = "✅ Loaded " + (p.products||[]).length + " products and " + (p.prices||[]).length + " prices.";
        hint.style.color = "#16a34a";
        hint.style.fontWeight = "700";
      }
      updateSubcats();
    }

           function toggleCategoryGroups() {
      const pt = document.getElementById("profileTypeSelect").value;
      const isService      = pt === "service";
      const isHospitality  = pt === "hospitality";
      const isProduct      = !isService && !isHospitality;

      document.getElementById("productCatWrap").style.display   = isProduct ? "" : "none";
      document.getElementById("serviceCatWrap").style.display   = isService ? "" : "none";
      document.getElementById("deliveryWrap").style.display     = isProduct ? "" : "none";
      document.getElementById("travelWrap").style.display       = isService ? "" : "none";
      document.getElementById("pricesWrap").style.display       = isProduct ? "" : "none";
      document.getElementById("ratesWrap").style.display        = isService ? "" : "none";
      document.getElementById("hospitalityWrap").style.display  = isHospitality ? "" : "none";

      // For hospitality: the products textarea becomes "Room types / activities"
      const productsSection = document.getElementById("productsTextarea")?.closest("div.fg");
      if (productsSection) productsSection.style.display = isHospitality ? "none" : "";
      document.getElementById("presetToolsWrap").style.display  = isProduct ? "" : "none";

      document.getElementById("productsLabel").textContent = isService
        ? "Services (comma-separated)"
        : "Products (comma-separated)";

      document.getElementById("productsTextarea").placeholder = isService
        ? "burst pipe repair, geyser installation, blocked drain"
        : "cooking oil, rice, sugar, mealie meal 10kg";

      document.getElementById("subcatWrap").style.display = "none";
      document.getElementById("subcategorySelect").innerHTML = '<option value="">All / General</option>';
      document.getElementById("useCategoryPreset").value = "false";
      const presetSelector = document.getElementById("presetSelector");
      if (presetSelector) presetSelector.value = "";
    }


    function updateSubcats() {
      const isService = document.getElementById("profileTypeSelect").value === "service";
      const catId = isService
        ? document.getElementById("serviceCategorySelect").value
        : document.getElementById("productCategorySelect").value;

      const subs = SUBCATS[catId] || [];
      const subcatWrap = document.getElementById("subcatWrap");
      const subcatSelect = document.getElementById("subcategorySelect");

      if (subs.length) {
        subcatSelect.innerHTML =
          '<option value="">All / General</option>' +
          subs.map(s => '<option value="' + s.id + '">' + s.label + '</option>').join("");
        subcatWrap.style.display = "";
      } else {
        subcatSelect.innerHTML = '<option value="">All / General</option>';
        subcatWrap.style.display = "none";
      }

      // keep preset selector aligned with selected product category
      if (!isService) {
        const presetSelector = document.getElementById("presetSelector");
        const presets = window.ADMIN_PRODUCT_PRESETS || {};
        if (presetSelector && presets[catId]) {
          presetSelector.value = catId;
        }
      }
    }
    </script>
  `));
});

router.post("/suppliers/new", requireSupplierAdmin, async (req, res) => {
  try {
const {
  businessName, phone, city, area, address, contactDetails, website, profileType,
  tier, billingCycle, durationDays, setActive,
  productCategory, serviceCategory, subcategory,
  products, prices, rates, useCategoryPreset,
  deliveryAvailable, travelAvailable, minOrder,
  currency, adminNote
} = req.body;

    if (!businessName?.trim()) throw new Error("Business name is required.");
    if (!phone?.trim())        throw new Error("Phone number is required.");
    if (!city?.trim())         throw new Error("City is required.");
    if (!area?.trim())         throw new Error("Area/suburb is required.");

    const cleanPhone = phone.trim().replace(/\s+/g, "");

    const existing = await SupplierProfile.findOne({ phone: cleanPhone });
    if (existing) {
      return res.redirect(
        `/zq-admin/suppliers/new?error=${encodeURIComponent(
          "A supplier with phone " + cleanPhone + " already exists."
        )}`
      );
    }

       const ADMIN_PRODUCT_PRESETS = {
      plumbing_supplies: {
        products: [
          "110mm pvc pipe",
          "110mm pvc ug pipe",
          "110mm ac pvc pipe",
          "50mm waste pipe",
          "32mm p trap",
          "40mm p trap",
          "50mm p trap",
          "32mm bottle trap",
          "100mm floor drain",
          "110mm inspection eye",
          "110mm plain bend",
          "110mm h t bend",
          "110mm plain tee",
          "110mm access tee",
          "110mm y junction",
          "110-50 reducer tee",
          "110mm vent valve",
          "110mm boss connector",
          "50mm plain bend",
          "50mm ie bend",
          "50mm ic tee",
          "gulley p",
          "gulley heads",
          "15mm pipe clip",
          "20mm pipe clip",
          "15mm male connector",
          "15mm cap elbow",
          "22mm cap elbow",
          "3/4 cu elbow",
          "22mm cu pipe",
          "15mm cu pipe",
          "solvent cement",
          "soldering wire",
          "nasco flux",
          "gas canister",
          "masonry disk",
          "basin pedestal",
          "basin waste",
          "toilet lid",
          "shower rose and arm"
        ],
        prices: [
          { product: "110mm pvc pipe", amount: 10, unit: "each" },
          { product: "110mm pvc ug pipe", amount: 10, unit: "each" },
          { product: "110mm ac pvc pipe", amount: 12, unit: "each" },
          { product: "50mm waste pipe", amount: 6, unit: "each" },
          { product: "32mm p trap", amount: 5, unit: "each" },
          { product: "40mm p trap", amount: 5, unit: "each" },
          { product: "50mm p trap", amount: 5, unit: "each" },
          { product: "32mm bottle trap", amount: 10, unit: "each" },
          { product: "100mm floor drain", amount: 10, unit: "each" },
          { product: "110mm inspection eye", amount: 15, unit: "each" },
          { product: "110mm plain bend", amount: 3, unit: "each" },
          { product: "110mm h t bend", amount: 3, unit: "each" },
          { product: "110mm plain tee", amount: 4, unit: "each" },
          { product: "110mm access tee", amount: 12, unit: "each" },
          { product: "110mm y junction", amount: 4, unit: "each" },
          { product: "110-50 reducer tee", amount: 4, unit: "each" },
          { product: "110mm vent valve", amount: 3, unit: "each" },
          { product: "110mm boss connector", amount: 3, unit: "each" },
          { product: "50mm plain bend", amount: 1, unit: "each" },
          { product: "50mm ie bend", amount: 0.5, unit: "each" },
          { product: "50mm ic tee", amount: 1, unit: "each" },
          { product: "gulley p", amount: 2.5, unit: "each" },
          { product: "gulley heads", amount: 4, unit: "each" },
          { product: "15mm pipe clip", amount: 0.5, unit: "each" },
          { product: "20mm pipe clip", amount: 1, unit: "each" },
          { product: "15mm male connector", amount: 1.5, unit: "each" },
          { product: "15mm cap elbow", amount: 0.5, unit: "each" },
          { product: "22mm cap elbow", amount: 1.5, unit: "each" },
          { product: "3/4 cu elbow", amount: 1.5, unit: "each" },
          { product: "22mm cu pipe", amount: 35, unit: "each" },
          { product: "15mm cu pipe", amount: 20, unit: "each" },
          { product: "solvent cement", amount: 10, unit: "each" },
          { product: "soldering wire", amount: 10, unit: "each" },
          { product: "nasco flux", amount: 5, unit: "each" },
          { product: "gas canister", amount: 3, unit: "each" },
          { product: "masonry disk", amount: 10, unit: "each" },
          { product: "basin pedestal", amount: 30, unit: "each" },
          { product: "basin waste", amount: 5, unit: "each" },
          { product: "toilet lid", amount: 10, unit: "each" },
          { product: "shower rose and arm", amount: 8, unit: "each" }
        ]
      }
    };

    const category = profileType === "service" ? serviceCategory : productCategory;
    const categories = category ? [category.trim()] : [];

    // ── Hospitality fields from form ─────────────────────────────────────────
    let tourismSubtype = [];
    if (profileType === "hospitality") {
      const rawSubtypes = req.body.tourismSubtype || [];
      tourismSubtype = Array.isArray(rawSubtypes) ? rawSubtypes : [rawSubtypes].filter(Boolean);
      // Auto-build categories from subtypes so requestMatchEngine can find this supplier
      const subtypeToCat = {
        lodge:"lodge", hotel:"hotel", guesthouse:"guesthouse", self_catering:"self_catering",
        campsite:"campsite", safari_operator:"safari", tour_guide:"tours",
        boat_hire:"boat_hire", travel_agency:"tourism"
      };
      for (const st of tourismSubtype) {
        const cat = subtypeToCat[st];
        if (cat && !categories.includes(cat)) categories.push(cat);
      }
      if (!categories.includes("hospitality"))  categories.push("hospitality");
      if (!categories.includes("accommodation")) categories.push("accommodation");
      if (!categories.includes("tourism"))       categories.push("tourism");
    }

    // Parse room types: "Double room, 2, 30, 15" → { name, capacity, pricePerNight, restRate }
    const roomTypes = [];
    if (profileType === "hospitality" && req.body.roomTypes) {
      for (const line of req.body.roomTypes.split("\n")) {
        const parts = line.split(",").map(s => s.trim());
        const name  = parts[0];
        const cap   = parseInt(parts[1]) || 2;
        const price = parseFloat(parts[2]) || 0;
        const rest  = parseFloat(parts[3]) || 0;   // rest/day-use rate - 4th column
        if (name && name.length > 1) roomTypes.push({ name, capacity: cap, pricePerNight: price, restRate: rest, currency: "USD" });
      }
    }

    // ── Parse activityServices (safari drives, boat hire, tours, etc.) ────────
    // These go into extraServices[] so they appear in smart link + quote catalogue.
    // Format per line: "Service name, price" or just "Service name" (price on request)
    const activityExtras = [];
    if (profileType === "hospitality" && req.body.activityServices) {
      for (const line of req.body.activityServices.split("\n")) {
        const parts = line.trim().split(",").map(s => s.trim());
        const svcName = parts[0];
        const price   = parts[1] ? Number(parts[1].replace(/[^0-9.]/g, "")) || 0 : 0;
        const unit    = parts[2]?.trim() || "per person";
        if (svcName && svcName.length > 1) {
          activityExtras.push({ name: svcName, price, unit });
        }
      }
    }

    const rawFacilities = req.body.facilities || [];
    const facilities = Array.isArray(rawFacilities) ? rawFacilities : [rawFacilities].filter(Boolean);
    const tourismAreas = profileType === "hospitality"
      ? (req.body.tourismAreas || "").split(",").map(s => s.trim()).filter(Boolean)
      : [];

    let productList = (products || "")
      .split(",")
      .map(p => p.trim().toLowerCase())
      .filter(Boolean);

    // Backend fallback: if admin chose plumbing_supplies and left products blank,
    // auto-load the preset products.
      if (
      profileType !== "service" &&
      category === "plumbing_supplies" &&
      (useCategoryPreset === "true" || !productList.length) &&
      ADMIN_PRODUCT_PRESETS.plumbing_supplies
    ) {
      productList = [...ADMIN_PRODUCT_PRESETS.plumbing_supplies.products];
    }

    const priceList = [];
    if (prices && profileType !== "service") {
      for (const line of (prices || "").split("\n")) {
        const parts  = line.split(",").map(s => s.trim());
        const name   = parts[0]?.toLowerCase();
        const amount = parseFloat(parts[1]);
        const unit   = parts[2] || "each";
        if (name && !isNaN(amount) && amount > 0) {
          priceList.push({ product: name, amount, unit, inStock: true, currency: "USD" });
        }
      }
    }

    // Backend fallback: if admin chose plumbing_supplies and left prices blank,
    // auto-load preset prices too.
       if (
      profileType !== "service" &&
      category === "plumbing_supplies" &&
      (useCategoryPreset === "true" || !priceList.length) &&
      ADMIN_PRODUCT_PRESETS.plumbing_supplies
    ) {
      for (const row of ADMIN_PRODUCT_PRESETS.plumbing_supplies.prices) {
        priceList.push({
          product: row.product,
          amount: row.amount,
          unit: row.unit || "each",
          inStock: true,
          currency: "USD"
        });
      }
    }
    const rateList = [];
    if (rates && profileType === "service") {
      for (const line of (rates || "").split("\n")) {
        const parts   = line.split(",").map(s => s.trim());
        const service = parts[0]?.toLowerCase();
        const rate    = parts[1]?.trim();
        if (service && rate) rateList.push({ service, rate });
      }
    }
    // ── FIX: for service suppliers, if no rates were entered but service names
    // were typed into the products textarea, auto-build rateList from productList
    // so that supplier.rates[] is populated and smart link / sellerChat work.
    if (profileType === "service" && rateList.length === 0 && productList.length > 0) {
      for (const svcName of productList) {
        rateList.push({ service: svcName, rate: "" });
      }
    }



    const now       = new Date();
    const days      = Number(durationDays) || 30;
    const expiresAt = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
    const tierRank  = tier === "featured" ? 3 : tier === "pro" ? 2 : 1;

    // Tier → Business package mapping (mirrors supplierRegistration.js)
    const TIER_TO_PACKAGE = { basic: "bronze", pro: "silver", featured: "gold" };
    const bizPackage = TIER_TO_PACKAGE[tier] || "bronze";
    const isActive   = setActive === "true";

    // ── Import models needed for full business account setup ──────────────
    const Business    = (await import("../models/business.js")).default;
    const UserRole    = (await import("../models/userRole.js")).default;
    const Branch      = (await import("../models/branch.js")).default;
    const UserSession = (await import("../models/userSession.js")).default;
    const Product     = (await import("../models/product.js")).default;

    // ── 1. Create the Business record ─────────────────────────────────────
       const newBiz = await Business.create({
      name:                businessName.trim(),
      address:             address?.trim() || "",
      currency:            currency || "USD",
      package:             isActive ? bizPackage : "trial",
      subscriptionStatus:  isActive ? "active" : "inactive",
      subscriptionStartedAt: isActive ? now : undefined,
      subscriptionEndsAt:    isActive ? expiresAt : undefined,
      isSupplier:          true,
      ownerPhone:          cleanPhone,
      sessionState:        "ready",
      sessionData:         {}
    });

    // ── 2. Create UserRole (owner) ────────────────────────────────────────
    await UserRole.create({
      phone:      cleanPhone,
      role:       "owner",
      pending:    false,
      businessId: newBiz._id
    });

    // ── 3. Create main Branch ─────────────────────────────────────────────
    const mainBranch = await Branch.create({
      businessId: newBiz._id,
      name:       "Main Branch",
      isDefault:  true
    });

    // ── 4. Link branch to the owner's UserRole ────────────────────────────
    await UserRole.findOneAndUpdate(
      { phone: cleanPhone, businessId: newBiz._id },
      { branchId: mainBranch._id }
    );

    // ── 5. Set activeBusinessId in UserSession so WhatsApp login works ────
    await UserSession.findOneAndUpdate(
      { phone: cleanPhone },
      { phone: cleanPhone, activeBusinessId: newBiz._id },
      { upsert: true }
    );

    // ── 6. Create SupplierProfile linked to the Business ──────────────────
const supplier = await SupplierProfile.create({
  businessName:          businessName.trim(),
  phone:                 cleanPhone,
  businessId:            newBiz._id,
  mainBranchId:          mainBranch._id,
  location:              { city: city.trim(), area: area.trim() },
  address:               address?.trim() || "",
  contactDetails:        contactDetails?.trim() || "",
  website:               website?.trim() || "",
  profileType:           profileType || "product",
  categories,
  subcategory:           subcategory || null,
  products:              productList,
  listedProducts:        productList,
  prices:                priceList,
  rates:                 rateList,
  tier:                  tier || "basic",
  tierRank,
  subscriptionStatus:    "active",
  subscriptionPlan:      billingCycle || "monthly",
  subscriptionStartedAt: now,
  subscriptionEndsAt:    expiresAt,
  active:                isActive,
  delivery: {
    available: profileType === "service" ? false : deliveryAvailable === "true"
  },
  travelAvailable:  profileType === "service" ? travelAvailable === "true" : false,
  minOrder:         Number(minOrder) || 0,
  rating:           0,
  reviewCount:      0,
  completedOrders:  0,
  monthlyOrders:    0,
  credibilityScore: 0,
  adminNote: adminNote?.trim()
    ? `[Admin registered on ${now.toDateString()}] ${adminNote.trim()}`
    : `[Admin registered on ${now.toDateString()}]`,
  // ── Hospitality fields ──────────────────────────────────────────────────
  tourismSubtype:  tourismSubtype  || [],
  tourismAreas:    tourismAreas    || [],
  facilities:      facilities      || [],
  roomTypes:       roomTypes       || [],
  extraServices:   activityExtras  || [],
  maxCapacity:     Number(req.body.maxCapacity) || 0,
  checkInTime:     (req.body.checkInTime  || "").trim(),
  checkOutTime:    (req.body.checkOutTime || "").trim(),
  mealPlan:        req.body.mealPlan || "not_applicable",
  // Sync products[] and listedProducts[] from roomTypes so smart link + sellerChat work
  products:        roomTypes.length > 0 ? roomTypes.map(rt => rt.name.toLowerCase()) : [],
  listedProducts:  roomTypes.length > 0 ? roomTypes.map(rt => rt.name)               : [],
});

    // ── 7. Link SupplierProfile ID back onto the Business ─────────────────
    await Business.findByIdAndUpdate(newBiz._id, {
      supplierProfileId: supplier._id
    });

    // ── 8. Sync products/services into the Product model ──────────────────
    // (mirrors the sync in supplierRegistration.js so catalogue is ready)
    const capMap   = { basic: 20, pro: 60, featured: 150 };
    const cap      = capMap[tier] || 20;
    const toSync   = productList.slice(0, cap);
    for (const itemName of toSync) {
      const priceEntry = priceList.find(p => p.product === itemName);
      const rateEntry  = rateList.find(r => r.service === itemName);
      const unitPrice  = priceEntry?.amount || 0;
      const description = rateEntry?.rate || null;
      await Product.findOneAndUpdate(
        { businessId: newBiz._id, name: itemName },
        {
          $set: {
            businessId:  newBiz._id,
            branchId:    mainBranch._id,
            unitPrice,
            description,
            isActive:    true
          }
        },
        { upsert: true }
      );
    }

    // ── 9. Log a $0 subscription payment record ───────────────────────────
    await SupplierSubscriptionPayment.create({
      supplierPhone: cleanPhone,
      supplierId:    supplier._id,
      tier:          tier || "basic",
      plan:          billingCycle || "monthly",
      amount:        0,
      currency:      "USD",
      reference:     `ADMIN_REG_${supplier._id}_${Date.now()}`,
      status:        "paid",
      paidAt:        now,
      ecocashPhone:  "admin-registered"
    });

    res.redirect(
      `/zq-admin/suppliers/${supplier._id}?success=${encodeURIComponent("Supplier registered successfully! Business account and WhatsApp access created.")}`
    );
  } catch (err) {
    res.redirect(
      `/zq-admin/suppliers/new?error=${encodeURIComponent(err.message)}`
    );
  }
});

// ── Supplier Detail ────────────────────────────────────────────────────────
router.get("/suppliers/:id", requireSupplierAdmin, async (req, res) => {
  try {
    const supplier = await SupplierProfile.findById(req.params.id).lean();
    if (!supplier) return res.redirect("/zq-admin/suppliers");

    const [orders, payments] = await Promise.all([
      SupplierOrder.find({ supplierId: supplier._id }).sort({ createdAt: -1 }).limit(20).lean(),
      SupplierSubscriptionPayment.find({
        $or: [{ supplierId: supplier._id }, { supplierPhone: supplier.phone }]
      }).sort({ createdAt: -1 }).lean()
    ]);

    const totalRevenue = orders
      .filter(o => o.status === "completed")
      .reduce((sum, o) => sum + (o.totalAmount || 0), 0);

const successMsg = req.query.success
      ? `<div style="background:#dcfce7;color:#16a34a;padding:14px;border-radius:8px;margin-bottom:16px">✅ ${esc(req.query.success)}</div>`
      : "";

    res.send(layout(esc(supplier.businessName), `
      <a href="/zq-admin/suppliers" class="back-link">← Back to Suppliers</a>
      ${successMsg}

      <div class="two-col">
        <div class="panel">
          <div class="panel-head">
            <h3>Profile</h3>
            <a href="/zq-admin/suppliers/${supplier._id}/edit" class="btn-blue btn-sm">✏️ Edit</a>
          </div>
          <dl class="detail-list">
            <dt>Business Name</dt><dd><strong>${esc(supplier.businessName)}</strong></dd>
      <dt>Phone</dt><dd>${esc(supplier.phone)}</dd>
<dt>Contact Details</dt><dd>${esc(supplier.contactDetails || "-")}</dd>
<dt>Website</dt><dd>${esc(supplier.website || "-")}</dd>
<dt>Location</dt><dd>${esc(supplier.location?.area || "")}, ${esc(supplier.location?.city || "")}</dd>
            <dt>Address</dt><dd>${esc(supplier.address || "-")}</dd>
            <dt>Type</dt><dd>${esc(supplier.profileType || "product")}</dd>
            <dt>Categories</dt><dd>${(supplier.categories || []).join(", ") || "-"}</dd>
            ${supplier.profileType === "hospitality" ? `
  <dt>Business Subtype</dt><dd>${(supplier.tourismSubtype || []).map(s =>
    ({lodge:"🌿 Lodge",hotel:"🏨 Hotel",guesthouse:"🏡 Guesthouse/B&B",
      self_catering:"🍳 Self-Catering",campsite:"⛺ Campsite",
      safari_operator:"🦁 Safari Operator",tour_guide:"🗺 Tour Guide",
      boat_hire:"⛵ Boat Hire",travel_agency:"✈️ Travel Agency"}[s] || s)
  ).join(", ") || "-"}</dd>
  <dt>Areas / Destinations</dt><dd>${(supplier.tourismAreas || []).join(", ") || "-"}</dd>
  <dt>Facilities</dt><dd>${(supplier.facilities || []).map(f =>
    ({wifi:"📶 WiFi",pool:"🏊 Pool",hot_shower:"🚿 Hot shower",breakfast:"🍳 Breakfast",
      en_suite:"🚪 En-suite",generator:"⚡ Generator",dstv:"📺 DSTV",braai:"🔥 Braai",
      aircon:"❄️ AC",game_drives:"🦁 Game drives",fishing:"🎣 Fishing",
      boat_hire:"⛵ Boats",conference:"🏢 Conference",restaurant:"🍽 Restaurant",
      laundry:"👕 Laundry",parking:"🅿️ Parking",pets_allowed:"🐕 Pets OK",
      child_friendly:"👶 Kids OK"}[f] || f)
  ).join("  ·  ") || "None set"}</dd>
  <dt>Capacity</dt><dd>${supplier.maxCapacity > 0 ? supplier.maxCapacity + " guests max" : "-"}</dd>
  <dt>Check-in / out</dt><dd>${supplier.checkInTime || supplier.checkOutTime
    ? (supplier.checkInTime || "?") + " / " + (supplier.checkOutTime || "?") : "-"}</dd>
  <dt>Meal Plan</dt><dd>${{room_only:"Room only",bed_breakfast:"Bed & Breakfast",
    half_board:"Half Board",full_board:"Full Board",self_catering:"Self-Catering",
    not_applicable:"-"}[supplier.mealPlan] || "-"}</dd>
  <dt>Room Types</dt><dd>${(supplier.roomTypes || []).length
    ? (supplier.roomTypes || []).map(rt => {
        let s = rt.name;
        if (rt.pricePerNight > 0) s += " ($" + rt.pricePerNight + "/night";
        if (rt.restRate > 0) s += " · $" + rt.restRate + "/rest";
        if (rt.pricePerNight > 0 || rt.restRate > 0) s += ")";
        return s;
      }).join(", ")
    : "-"}</dd>
  <dt>Extra Services</dt><dd>${(supplier.extraServices || []).length
    ? (supplier.extraServices || []).map(es => es.name + (es.price > 0 ? " ($" + Number(es.price).toFixed(2) + "/" + (es.unit||"service") + ")" : "")).join(", ")
    : "-"}</dd>
` : (supplier.categories || []).includes("tourism") ? `
  <dt>Tourism Type</dt><dd>${esc(supplier.tourismType || "-")}</dd>
  <dt>Tourism Areas</dt><dd>${(supplier.tourismAreas || []).map(esc).join(", ") || "-"}</dd>
` : ""}
            <dt>Tier</dt><dd>${badge(supplier.tier || "basic", tierColor(supplier.tier))}</dd>
            <dt>Status</dt><dd>${badge(supplier.active ? "Active" : "Inactive", supplier.active ? "green" : "gray")}</dd>
            <dt>Subscription</dt><dd>${badge(supplier.subscriptionStatus || "pending", supplier.subscriptionStatus === "active" ? "green" : "gray")}</dd>
            <dt>Expires</dt><dd>${supplier.subscriptionExpiresAt ? new Date(supplier.subscriptionExpiresAt).toDateString() : "N/A"}</dd>
            <dt>Rating</dt><dd>⭐ ${(supplier.rating || 0).toFixed(1)} (${supplier.reviewCount || 0} reviews)</dd>
            <dt>Credibility Score</dt><dd>${supplier.credibilityScore || 0}/100</dd>
            <dt>Completed Orders</dt><dd>${supplier.completedOrders || 0}</dd>
            <dt>Monthly Orders</dt><dd>${supplier.monthlyOrders || 0}</dd>
            <dt>Total Revenue</dt><dd><strong>$${totalRevenue.toFixed(2)}</strong></dd>
            <dt>Suspended</dt><dd>${supplier.suspended ? "⛔ Yes" : "✅ No"}</dd>
            <dt>VIP Buyer Phone</dt><dd>${supplier.revealBuyerPhone ? "🔒 Yes - buyer phone revealed on requests" : "⚪ No"}</dd>
            <dt>VIP Visitor Phone</dt><dd>${supplier.revealVisitorPhone ? "🔒 Yes - visitor phone revealed on smart link opens" : "⚪ No"}</dd>
            <dt>Delivery</dt><dd>${supplier.delivery?.available ? "🚚 Yes" : "🏠 Collection only"}</dd>
            <dt>Min Order</dt><dd>$${supplier.minOrder || 0}</dd>
            <dt>Registered</dt><dd>${new Date(supplier.createdAt).toDateString()}</dd>
            ${supplier.adminNote ? `<dt>Admin Note</dt><dd class="admin-note">${esc(supplier.adminNote)}</dd>` : ""}
          </dl>
<div class="action-row">
  <form method="POST" action="/zq-admin/suppliers/${supplier._id}/toggle-active" style="display:inline">
    <button class="btn ${supplier.active ? "btn-orange" : "btn-green"}">
      ${supplier.active ? "⏸ Deactivate" : "✅ Activate"}
    </button>
  </form>

  <form method="POST" action="/zq-admin/suppliers/${supplier._id}/toggle-suspend" style="display:inline">
    <button class="btn ${supplier.suspended ? "btn-green" : "btn-red"}">
      ${supplier.suspended ? "🔓 Unsuspend" : "⛔ Suspend"}
    </button>
  </form>

  <a href="/zq-admin/suppliers/${supplier._id}/activate" class="btn btn-green">
    🎁 Manual Activation
  </a>

  ${supplier.profileType === "hospitality" ? `
  <a href="/zq-admin/suppliers/${supplier._id}/hospitality" class="btn btn-blue">
    🛏 Manage Rooms & Activities
  </a>
  ` : `
  <a href="/zq-admin/suppliers/${supplier._id}/products" class="btn btn-blue">
    📦 Manage Products
  </a>
  `}

  <a href="/zq-admin/suppliers/${supplier._id}/live-items" class="btn btn-purple">
    📌 Manage Live Items
  </a>


  <a href="/zq-admin/suppliers/${supplier._id}/send-offer" class="btn btn-blue">
     📣 Send Offer
   </a>

   <a href="/zq-admin/suppliers/${supplier._id}/receipt" class="btn btn-green">
     🧾 Generate Receipt
 </a>
  <a href="/zq-admin/suppliers/${supplier._id}/chatlink" class="btn btn-teal">
    📲 Chatbot Link
  </a>

  <a href="/zq-admin/suppliers/${supplier._id}/vip-settings" class="btn btn-purple">
    🔒 VIP Notifications
  </a>

  <a href="/zq-admin/suppliers/${supplier._id}/contacts" class="btn" style="background:#0d9488;color:white">
    👥 View Contacts
  </a>

  <a href="/zq-admin/suppliers/${supplier._id}/staff" class="btn" style="background:#0f766e;color:white">
    👥 Staff &amp; Branches
  </a>

  <a href="/zq-admin/suppliers/${supplier._id}/staff-cards" class="btn" style="background:#7c3aed;color:white">
    🪪 Staff E-Business Cards
  </a>

  <a href="/zq-admin/suppliers/${supplier._id}/recurring" class="btn" style="background:#0369a1;color:white">
    🏠 Recurring Billing
  </a>

  <form method="POST" action="/zq-admin/suppliers/${supplier._id}/delete" style="display:inline"
        onsubmit="return confirm('⚠️ PERMANENTLY DELETE ${esc(supplier.businessName)}?\n\nThis removes:\n• Supplier profile\n• Business account & branch\n• Products & prices\n• Subscription payments\n• Search logs\n\nThis cannot be undone.')">
    <button class="btn btn-red">🗑 Delete Supplier</button>
  </form>
</div>
        </div>

        <div>
          <div class="panel">
            <h3>
Products (${(supplier.products || []).length}) 
• Live (${(supplier.listedProducts || []).length})
</h3>
            <div class="tag-cloud">
              ${(supplier.products || []).length
                ? supplier.products.map(p => `<span class="tag">${esc(p)}</span>`).join("")
                : "<em class='muted'>No products listed</em>"}
            </div>
          </div>

          ${supplier.prices?.length ? `
          <div class="panel">
            <h3>Prices (${supplier.prices.length})</h3>
            <table>
              <thead><tr><th>Product</th><th>Price</th><th>Unit</th><th>Stock</th></tr></thead>
              <tbody>
                ${supplier.prices.map(p => `
                <tr>
                  <td>${esc(p.product)}</td>
                  <td>$${p.amount}</td>
                  <td>${esc(p.unit || "each")}</td>
                  <td>${p.inStock !== false ? "✅" : "❌"}</td>
                </tr>`).join("")}
              </tbody>
            </table>
          </div>` : ""}

          ${supplier.rates?.length ? `
          <div class="panel">
            <h3>Service Rates (${supplier.rates.length})</h3>
            <table>
              <thead><tr><th>Service</th><th>Rate</th></tr></thead>
              <tbody>
                ${supplier.rates.map(r => `
                <tr><td>${esc(r.service)}</td><td>${esc(r.rate)}</td></tr>`).join("")}
              </tbody>
            </table>
          </div>` : ""}

          ${supplier.profileType === "hospitality" && (supplier.roomTypes || []).length ? `
          <div class="panel">
            <div class="panel-head">
              <h3>🛏 Rooms & Accommodation (${(supplier.roomTypes || []).length})</h3>
              <a href="/zq-admin/suppliers/${supplier._id}/hospitality" class="btn-link">Manage →</a>
            </div>
            <table>
              <thead><tr><th>Room Type</th><th>Capacity</th><th>Price / Night</th></tr></thead>
              <tbody>
                ${(supplier.roomTypes || []).map(rt => `
                <tr>
                  <td><strong>${esc(rt.name)}</strong></td>
                  <td>${rt.capacity || "-"} guests</td>
                  <td>${rt.pricePerNight > 0 ? "$" + Number(rt.pricePerNight).toFixed(0) : "<em class='muted'>not set</em>"}</td>
                </tr>`).join("")}
              </tbody>
            </table>
          </div>` : ""}

          ${supplier.profileType === "hospitality" && (supplier.facilities || []).length ? `
          <div class="panel">
            <h3>🏷 Facilities</h3>
            <div class="tag-cloud">
              ${(supplier.facilities || []).map(f => facilityTag(f)).join("")}
            </div>
          </div>` : ""}
        </div>
      </div>

      <div class="panel">
        <h3>Orders (${orders.length})</h3>
        ${orders.length ? `
        <table>
          <thead>
            <tr><th>Ref</th><th>Buyer</th><th>Items</th><th>Total</th><th>Status</th><th>Date</th></tr>
          </thead>
          <tbody>
            ${orders.map(o => `
            <tr>
              <td><code>#${String(o._id).slice(-6).toUpperCase()}</code></td>
              <td>${esc(o.buyerPhone)}</td>
              <td class="items-cell">${(o.items || []).map(i => `${esc(i.product)} x${i.quantity}`).join(", ")}</td>
              <td>$${(o.totalAmount || 0).toFixed(2)}</td>
              <td>${badge(o.status, statusColor(o.status))}</td>
              <td>${new Date(o.createdAt).toLocaleDateString()}</td>
            </tr>`).join("")}
          </tbody>
        </table>` : "<em class='muted'>No orders yet</em>"}
      </div>

      <div class="panel">
        <h3>Subscription Payments</h3>
        ${payments.length ? `
        <table>
          <thead><tr><th>Plan</th><th>Amount</th><th>EcoCash</th><th>Status</th><th>Date</th></tr></thead>
          <tbody>
            ${payments.map(p => `
            <tr>
              <td>${esc(p.tier)} / ${esc(p.plan)}</td>
              <td>$${p.amount}</td>
              <td>${esc(p.ecocashPhone || "-")}</td>
              <td>${badge(p.status, p.status === "paid" ? "green" : "gray")}</td>
              <td>${new Date(p.createdAt).toLocaleDateString()}</td>
            </tr>`).join("")}
          </tbody>
        </table>` : "<em class='muted'>No payments yet</em>"}
      </div>
    `));
  } catch (err) {
    res.send(layout("Error", `<div class="alert red">${err.message}</div>`));
  }
});

// ── Edit Supplier ──────────────────────────────────────────────────────────
router.get("/suppliers/:id/edit", requireSupplierAdmin, async (req, res) => {
  try {
    const supplier = await SupplierProfile.findById(req.params.id).lean();
    if (!supplier) return res.redirect("/zq-admin/suppliers");

    const expiryVal = supplier.subscriptionExpiresAt
      ? new Date(supplier.subscriptionExpiresAt).toISOString().split("T")[0]
      : "";

    res.send(layout(`Edit: ${esc(supplier.businessName)}`, `
      <a href="/zq-admin/suppliers/${supplier._id}" class="back-link">← Back to Profile</a>
      <div class="panel">
        <h3>Edit Supplier</h3>
        <form method="POST" action="/zq-admin/suppliers/${supplier._id}/edit" class="edit-form">
          <div class="form-grid">
            <div class="fg">
              <label>Business Name</label>
              <input name="businessName" value="${esc(supplier.businessName)}" required />
            </div>
            <div class="fg">
              <label>Phone</label>
              <input name="phone" value="${esc(supplier.phone)}" required />
            </div>
            <div class="fg">
              <label>City</label>
              <input name="city" value="${esc(supplier.location?.city || "")}" />
            </div>
               <div class="fg">
  <label>Area / Suburb</label>
  <input name="area" value="${esc(supplier.location?.area || "")}" />
</div>
<div class="fg">
  <label>Address</label>
  <input name="address" value="${esc(supplier.address || "")}" />
</div>
<div class="fg">
  <label>Contact Details</label>
  <input name="contactDetails" value="${esc(supplier.contactDetails || "")}" />
</div>

<div class="fg" style="grid-column:1/-1">
  <label>📲 Notification Contacts
    <span style="font-weight:400;font-size:11px;color:var(--muted);text-transform:none;letter-spacing:0">
      - Extra numbers that receive quote request &amp; smart link alerts (outside 24hr sessions via WhatsApp template)
    </span>
  </label>
  <div id="notif-contacts-list" style="display:flex;flex-direction:column;gap:8px;margin-bottom:8px">
    ${(supplier.notificationContacts||[]).map((p,i)=>`
      <div style="display:flex;gap:8px;align-items:center">
        <input name="notifContact_${i}" value="${esc(p)}"
               placeholder="e.g. 2637712345678"
               style="flex:1;padding:9px 11px;border:1px solid var(--border);border-radius:7px;font-size:13px" />
        <button type="button" onclick="this.closest('div').remove();syncNotifCount()"
                style="padding:6px 12px;border:1px solid #dc2626;border-radius:6px;color:#dc2626;background:none;cursor:pointer;font-size:13px">✕</button>
      </div>`).join("")}
  </div>
  <button type="button" onclick="addNotifContact()"
          style="padding:7px 14px;border:1px solid var(--blue);border-radius:6px;color:var(--blue);background:none;cursor:pointer;font-size:13px">
    ➕ Add number
  </button>
  <input type="hidden" name="notifContactCount" id="notifContactCount" value="${(supplier.notificationContacts||[]).length}" />
  <span style="display:block;font-size:11px;color:var(--muted);margin-top:6px">
    Use international format: 2637XXXXXXXX. The primary phone above always receives notifications too.
  </span>
  <script>
    function syncNotifCount() {
      const list = document.getElementById("notif-contacts-list");
      document.getElementById("notifContactCount").value = list ? list.children.length : 0;
    }
    function addNotifContact() {
      const list  = document.getElementById("notif-contacts-list");
      const idx   = list.children.length;
      const div   = document.createElement("div");
      div.style.cssText = "display:flex;gap:8px;align-items:center";
      div.innerHTML = \`<input name="notifContact_\${idx}" placeholder="e.g. 2637712345678"
        style="flex:1;padding:9px 11px;border:1px solid var(--border);border-radius:7px;font-size:13px">
        <button type="button" onclick="this.closest('div').remove();syncNotifCount()"
          style="padding:6px 12px;border:1px solid #dc2626;border-radius:6px;color:#dc2626;background:none;cursor:pointer;font-size:13px">✕</button>\`;
      list.appendChild(div);
      syncNotifCount();
    }
    document.querySelector("form.edit-form")?.addEventListener("submit", syncNotifCount);
  </script>
</div>

<div class="fg">
  <label>Website</label>
  <input name="website" value="${esc(supplier.website || "")}" />
</div>

${(supplier.categories||[]).includes("tutoring") ? `
<!-- ── TEACHER / TUTOR FIELDS ──────────────────────────── -->
<div class="fg" style="grid-column:1/-1">
  <label>📚 Subjects Taught
    <span style="font-weight:400;font-size:11px;color:var(--muted);text-transform:none;letter-spacing:0">
      - Separate with commas
    </span>
  </label>
  <input name="subjects" value="${esc((supplier.subjects||[]).join(", "))}"
         placeholder="e.g. Maths, Physics, English, Accounting" />
</div>
<div class="fg" style="grid-column:1/-1">
  <label>🎓 Grades / Levels Offered
    <span style="font-weight:400;font-size:11px;color:var(--muted);text-transform:none;letter-spacing:0">
      - Separate with commas
    </span>
  </label>
  <input name="gradesOffered" value="${esc((supplier.gradesOffered||[]).join(", "))}"
         placeholder="e.g. O-Level, A-Level, Grade 6, Grade 7" />
</div>` : ""}

${supplier.profileType === "service" ? `
<div style="grid-column:1/-1;margin-top:4px;padding:14px;background:#eff6ff;border-radius:8px;border-left:3px solid #3b82f6">
  <strong style="font-size:12px;color:#1d4ed8;text-transform:uppercase;letter-spacing:.4px">🔧 Service Provider Fields</strong>
</div>

<div class="fg" style="grid-column:1/-1">
  <label>🛠 Services &amp; Rates
    <span style="font-weight:400;font-size:11px;color:var(--muted);text-transform:none;letter-spacing:0">
      - one per line: <code>service name, rate</code> - rate is optional
    </span>
  </label>
  <textarea name="rates" rows="14" style="font-size:13px;font-family:monospace">${(supplier.rates||[]).map(r =>
    r.rate ? r.service + ", " + r.rate : r.service
  ).join("\n")}</textarea>
  <span style="font-size:11px;color:var(--muted)">
    With rate: <code>plumbing, $20/hr</code> &nbsp;·&nbsp;
    No rate: <code>funeral policy services</code> &nbsp;·&nbsp;
    Rate shown on buyer smart card.
  </span>
</div>

<div class="fg">
  <label>🚗 Travels to Clients</label>
  <select name="travelAvailable">
    <option value="true" ${supplier.travelAvailable ? "selected" : ""}>Yes - travels to client sites</option>
    <option value="false" ${!supplier.travelAvailable ? "selected" : ""}>No - clients come to us</option>
  </select>
</div>
<div class="fg">
  <label>📍 Service Area</label>
  <input name="serviceArea" value="${esc(supplier.serviceArea || "")}"
         placeholder="e.g. Harare, Chitungwiza, nationwide" />
</div>
` : ""}

${supplier.profileType === "hospitality" ? `

<div style="grid-column:1/-1;margin-top:4px;padding:14px;background:#f0fdf4;border-radius:8px;border-left:3px solid #22c55e">
  <strong style="font-size:12px;color:#15803d;text-transform:uppercase;letter-spacing:.4px">🏨 Hospitality &amp; Tourism Fields</strong>
</div>

<div class="fg" style="grid-column:1/-1">
  <label>Business Sub-type <span style="font-weight:400;font-size:11px;text-transform:none">(check all that apply)</span></label>
  <div style="display:flex;flex-wrap:wrap;gap:10px;padding:12px;border:1px solid var(--border);border-radius:7px">
    ${[["lodge","🌿 Lodge / Bush Camp"],["hotel","🏨 Hotel / Motel"],
       ["guesthouse","🏡 Guesthouse / B&B"],["self_catering","🍳 Self-Catering"],
       ["campsite","⛺ Campsite"],["safari_operator","🦁 Safari Operator"],
       ["tour_guide","🗺 Tour Guide"],["boat_hire","⛵ Boat Hire"],
       ["travel_agency","✈️ Travel Agency"]
    ].map(([val,label]) =>
      '<label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:13px;font-weight:400;text-transform:none;letter-spacing:0;color:var(--text)">' +
      '<input type="checkbox" name="tourismSubtype" value="' + val + '"' +
      ((supplier.tourismSubtype||[]).includes(val) ? ' checked' : '') +
      ' style="width:15px;height:15px"> ' + label + '</label>'
    ).join("")}
  </div>
</div>

<div class="fg" style="grid-column:1/-1">
  <label>🌍 Areas / Destinations Served</label>
  <input name="tourismAreas" value="${esc((supplier.tourismAreas||[]).join(", "))}"
         placeholder="e.g. Kariba, Hwange, Victoria Falls, Nyanga" />
</div>

<div class="fg">
  <label>⏰ Check-in Time</label>
  <input name="checkInTime" value="${esc(supplier.checkInTime || "")}"
         placeholder="e.g. 14:00 or 2pm" />
</div>
<div class="fg">
  <label>⏰ Check-out Time</label>
  <input name="checkOutTime" value="${esc(supplier.checkOutTime || "")}"
         placeholder="e.g. 10:00 or 10am" />
</div>
<div class="fg">
  <label>👥 Max Capacity (guests)</label>
  <input type="number" name="maxCapacity" value="${supplier.maxCapacity || 0}" min="0" />
</div>
<div class="fg">
  <label>🍽 Meal Plan</label>
  <select name="mealPlan">
    ${[["not_applicable","Not applicable"],["room_only","Room only"],
       ["bed_breakfast","Bed & Breakfast"],["half_board","Half Board"],
       ["full_board","Full Board"],["self_catering","Self-Catering"]
    ].map(([val,lbl]) =>
      '<option value="' + val + '"' + (supplier.mealPlan === val ? ' selected' : '') + '>' + lbl + '</option>'
    ).join("")}
  </select>
</div>

<div class="fg" style="grid-column:1/-1">
  <label>🏷 Facilities</label>
  <div style="display:flex;flex-wrap:wrap;gap:8px;padding:12px;border:1px solid var(--border);border-radius:7px">
    ${[["wifi","📶 WiFi"],["pool","🏊 Pool"],["hot_shower","🚿 Hot shower"],
       ["breakfast","🍳 Breakfast incl."],["en_suite","🚪 En-suite"],["generator","⚡ Generator/Solar"],
       ["dstv","📺 DSTV/TV"],["braai","🔥 Braai/BBQ"],["aircon","❄️ Air con"],
       ["game_drives","🦁 Game drives"],["fishing","🎣 Fishing"],["boat_hire","⛵ Boat hire"],
       ["conference","🏢 Conference"],["restaurant","🍽 Restaurant/Bar"],["laundry","👕 Laundry"],
       ["parking","🅿️ Parking"],["pets_allowed","🐕 Pets OK"],["child_friendly","👶 Child-friendly"]
    ].map(([val,lbl]) =>
      '<label style="display:flex;align-items:center;gap:5px;cursor:pointer;font-size:12px;color:var(--text);font-weight:400;text-transform:none;letter-spacing:0">' +
      '<input type="checkbox" name="facilities" value="' + val + '"' +
      ((supplier.facilities||[]).includes(val) ? ' checked' : '') +
      ' style="width:14px;height:14px"> ' + lbl + '</label>'
    ).join("")}
  </div>
</div>

<div class="fg" style="grid-column:1/-1">
  <label>🛏 Room Types, Night &amp; Rest Rates
    <span style="font-weight:400;font-size:11px;text-transform:none;letter-spacing:0">
      - one per line: <code>name, max guests, price/night, rest rate (optional)</code>
    </span>
  </label>
  <textarea name="roomTypes" rows="7">${(supplier.roomTypes||[]).map(rt =>
    rt.name + ", " + (rt.capacity||2) + ", " + (rt.pricePerNight||0) + (rt.restRate > 0 ? ", " + rt.restRate : "")
  ).join("\n")}</textarea>
  <span style="font-size:11px;color:var(--muted)">
    Night only: <code>Double room, 2, 80</code> &nbsp;·&nbsp;
    With rest rate: <code>Double room, 2, 80, 45</code> &nbsp;·&nbsp;
    Activity: <code>Game drive, 4, 80</code>
  </span>
</div>

<div class="fg" style="grid-column:1/-1">
  <label>➕ Extra Services
    <span style="font-weight:400;font-size:11px;text-transform:none;letter-spacing:0">
      - charged separately: one per line: <code>name, price, unit</code>
    </span>
  </label>
  <textarea name="extraServices" rows="5">${(supplier.extraServices||[]).map(es =>
    es.name + ", " + (es.price||0) + ", " + (es.unit||"service")
  ).join("\n")}</textarea>
  <span style="font-size:11px;color:var(--muted)">
    Examples: <code>Conference room, 50, half day</code> &nbsp;·&nbsp;
    <code>Airport pickup, 15, trip</code> &nbsp;·&nbsp;
    <code>Breakfast, 8, person</code>
  </span>
</div>

` : (supplier.categories||[]).includes("tourism") ? `
<div class="fg">
  <label>🦁 Tourism Type (legacy)</label>
  <input name="tourismType" value="${esc(supplier.tourismType||"")}" />
</div>
<div class="fg" style="grid-column:1/-1">
  <label>📍 Tourism Areas</label>
  <input name="tourismAreas" value="${esc((supplier.tourismAreas||[]).join(", "))}" />
</div>
` : ""}
<div class="fg">
  <label>Tier</label>
              <select name="tier">
                <option ${supplier.tier === "basic" ? "selected" : ""} value="basic">Basic</option>
                <option ${supplier.tier === "pro" ? "selected" : ""} value="pro">Pro</option>
                <option ${supplier.tier === "featured" ? "selected" : ""} value="featured">Featured</option>
              </select>
            </div>
            <div class="fg">
              <label>Subscription Status</label>
              <select name="subscriptionStatus">
                <option ${supplier.subscriptionStatus === "pending" ? "selected" : ""} value="pending">Pending</option>
                <option ${supplier.subscriptionStatus === "active" ? "selected" : ""} value="active">Active</option>
                <option ${supplier.subscriptionStatus === "expired" ? "selected" : ""} value="expired">Expired</option>
              </select>
            </div>
            <div class="fg">
              <label>Subscription Expires</label>
              <input type="date" name="subscriptionExpiresAt" value="${expiryVal}" />
            </div>
            <div class="fg">
              <label>Active</label>
              <select name="active">
                <option ${supplier.active ? "selected" : ""} value="true">Yes</option>
                <option ${!supplier.active ? "selected" : ""} value="false">No</option>
              </select>
            </div>
            <div class="fg">
              <label>Min Order ($)</label>
              <input type="number" name="minOrder" value="${supplier.minOrder || 0}" min="0" />
            </div>
            <div class="fg">
              <label>Profile Type</label>
              <select name="profileType">
                <option ${supplier.profileType === "product" ? "selected" : ""} value="product">Product Supplier</option>
                <option ${supplier.profileType === "service" ? "selected" : ""} value="service">Service Provider</option>
                <option ${supplier.profileType === "hospitality" ? "selected" : ""} value="hospitality">🏨 Hospitality / Tourism</option>
              </select>
            </div>
            <div class="fg">
              <label>Credibility Score (0-100)</label>
              <input type="number" name="credibilityScore" value="${supplier.credibilityScore || 0}" min="0" max="100" />
            </div>
            <div class="fg">
              <label>Rating (0-5)</label>
              <input type="number" name="rating" value="${(supplier.rating || 0).toFixed(1)}" min="0" max="5" step="0.1" />
            </div>
          </div>

          <div class="fg full">
            <label>Products (comma-separated)</label>
            <textarea name="products" rows="3">${(supplier.products || []).join(", ")}</textarea>
          </div>
          <div class="fg full">
            <label>Categories (comma-separated)</label>
            <textarea name="categories" rows="2">${(supplier.categories || []).join(", ")}</textarea>
          </div>
          <div class="fg full">
            <label>Admin Note (internal only)</label>
            <textarea name="adminNote" rows="2" placeholder="Notes about this supplier...">${esc(supplier.adminNote || "")}</textarea>
          </div>

          <div class="form-actions">
            <button type="submit" class="btn btn-blue">💾 Save Changes</button>
            <a href="/zq-admin/suppliers/${supplier._id}" class="btn btn-gray">Cancel</a>
          </div>
        </form>
      </div>
    `));
  } catch (err) {
    res.send(layout("Error", `<div class="alert red">${err.message}</div>`));
  }
});

router.post("/suppliers/:id/edit", requireSupplierAdmin, async (req, res) => {
  try {
const {
  businessName, phone, city, area, address, contactDetails, website, tier, subscriptionStatus,
  subscriptionExpiresAt, active, minOrder, profileType,
  products, categories, adminNote, credibilityScore, rating
} = req.body;

const update = {
  businessName: businessName?.trim(),
  phone: phone?.trim(),
  "location.city": city?.trim(),
  "location.area": area?.trim(),
  address: address?.trim() || "",
  contactDetails: contactDetails?.trim() || "",
  website: website?.trim() || "",
  tier,
      tierRank: tier === "featured" ? 3 : tier === "pro" ? 2 : 1,
      subscriptionStatus,
      active: active === "true",
      minOrder: Number(minOrder) || 0,
      profileType,
      adminNote: adminNote?.trim() || "",
      credibilityScore: Number(credibilityScore) || 0,
      rating: Number(rating) || 0,
      products: products
        ? products.split(",").map(p => p.trim().toLowerCase()).filter(Boolean)
        : [],
      categories: categories
        ? categories.split(",").map(c => c.trim().toLowerCase()).filter(Boolean)
        : []
    };

    if (subscriptionExpiresAt) {
      update.subscriptionExpiresAt = new Date(subscriptionExpiresAt);
    }

    // ── Notification contacts (extra numbers for template alerts) ──────────────
   // ── Notification contacts (extra numbers for template alerts) ──────────────
const _notifCount = parseInt(req.body.notifContactCount || "0", 10);
const _notifRaw = [];

for (let i = 0; i < _notifCount; i++) {
  const raw = String(req.body["notifContact_" + i] || "").trim();
  const digits = raw.replace(/\D+/g, "");
  const normalized =
    digits.startsWith("0") && digits.length === 10
      ? "263" + digits.slice(1)
      : digits;

  if (normalized.length >= 10) {
    _notifRaw.push(normalized);
  }
}

const _primaryPhone = String(phone || "").trim().replace(/\D+/g, "");
const _primaryNormalized =
  _primaryPhone.startsWith("0") && _primaryPhone.length === 10
    ? "263" + _primaryPhone.slice(1)
    : _primaryPhone;

// Deduplicate and exclude the primary phone
update.notificationContacts = [...new Set(_notifRaw)].filter(
  p => p && p !== _primaryNormalized
);
    // ── Teacher fields ──────────────────────────────────────────────────────
    if (req.body.subjects !== undefined) {
      update.subjects = (req.body.subjects || "").split(",").map(s => s.trim()).filter(Boolean);
    }
    if (req.body.gradesOffered !== undefined) {
      update.gradesOffered = (req.body.gradesOffered || "").split(",").map(s => s.trim()).filter(Boolean);
    }
    // ── Hospitality & Tourism fields ─────────────────────────────────────────
    // Always save tourismAreas if present
    if (req.body.tourismAreas !== undefined) {
      update.tourismAreas = (req.body.tourismAreas || "").split(",").map(s => s.trim()).filter(Boolean);
    }
    // New hospitality fields (profileType=hospitality suppliers)
    if (req.body.tourismSubtype !== undefined || update.profileType === "hospitality") {
      const rawSubtypes = req.body.tourismSubtype || [];
      update.tourismSubtype = Array.isArray(rawSubtypes) ? rawSubtypes : [rawSubtypes].filter(Boolean);
      // Auto-sync categories from subtypes
      const subtypeToCat = {
        lodge:"lodge", hotel:"hotel", guesthouse:"guesthouse", self_catering:"self_catering",
        campsite:"campsite", safari_operator:"safari", tour_guide:"tours",
        boat_hire:"boat_hire", travel_agency:"tourism"
      };
      const existingCats = update.categories || [];
      for (const st of update.tourismSubtype) {
        const cat = subtypeToCat[st];
        if (cat && !existingCats.includes(cat)) existingCats.push(cat);
      }
      if (!existingCats.includes("hospitality"))  existingCats.push("hospitality");
      if (!existingCats.includes("accommodation")) existingCats.push("accommodation");
      if (!existingCats.includes("tourism"))       existingCats.push("tourism");
      update.categories = existingCats;
    }
    if (req.body.facilities !== undefined || update.profileType === "hospitality") {
      const rawFac = req.body.facilities || [];
      update.facilities = Array.isArray(rawFac) ? rawFac : [rawFac].filter(Boolean);
    }
    if (req.body.maxCapacity !== undefined) {
      update.maxCapacity = Number(req.body.maxCapacity) || 0;
    }
    if (req.body.checkInTime !== undefined) {
      update.checkInTime = (req.body.checkInTime || "").trim();
    }
    if (req.body.checkOutTime !== undefined) {
      update.checkOutTime = (req.body.checkOutTime || "").trim();
    }
    if (req.body.mealPlan !== undefined) {
      update.mealPlan = req.body.mealPlan || "not_applicable";
    }
    // Parse room types: "Double room, 2, 80" or with rest rate "Double room, 2, 80, 45"
    if (req.body.roomTypes !== undefined || update.profileType === "hospitality") {
      const roomTypes = [];
      for (const line of (req.body.roomTypes || "").split("\n")) {
        const parts = line.split(",").map(s => s.trim());
        const name  = parts[0];
        const cap   = parseInt(parts[1]) || 2;
        const price = parseFloat(parts[2]) || 0;
        const rest  = parseFloat(parts[3]) || 0;
        if (name && name.length > 1) roomTypes.push({ name, capacity: cap, pricePerNight: price, restRate: rest, currency: "USD" });
      }
      update.roomTypes = roomTypes;
      // Always sync products[] from roomTypes so smart link + sellerChat show services
      if (roomTypes.length > 0) {
        update.products       = roomTypes.map(rt => rt.name.toLowerCase());
        update.listedProducts = roomTypes.map(rt => rt.name);
      }
    }
    // Parse extra services: "Conference room, 50, half day"
    if (req.body.extraServices !== undefined || update.profileType === "hospitality") {
      const extraServices = [];
      for (const line of (req.body.extraServices || "").split("\n")) {
        const parts = line.split(",").map(s => s.trim());
        const name  = parts[0];
        if (!name || name.length < 2) continue;
        extraServices.push({ name, price: parseFloat(parts[1]) || 0, unit: parts[2] || "service" });
      }
      update.extraServices = extraServices;
    }

    // ── Service rates (profileType=service suppliers) ────────────────────────
    // Textarea format: one per line - "service name" or "service name, rate"
    if (req.body.rates !== undefined) {
      const parsedRates = [];
      const parsedProducts = [];
      for (const line of (req.body.rates || "").split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const commaIdx = trimmed.indexOf(",");
        const service  = commaIdx >= 0 ? trimmed.slice(0, commaIdx).trim().toLowerCase() : trimmed.toLowerCase();
        const rate     = commaIdx >= 0 ? trimmed.slice(commaIdx + 1).trim() : "";
        if (service) {
          parsedRates.push({ service, rate });
          if (!parsedProducts.includes(service)) parsedProducts.push(service);
        }
      }
      update.rates    = parsedRates;
      // Keep products[] in sync so chatbot search finds this supplier
      if (parsedProducts.length > 0) {
        update.products       = parsedProducts;
        update.listedProducts = parsedProducts;
      }
    }
    // Service-specific travel/area fields
    if (req.body.travelAvailable !== undefined) {
      update.travelAvailable = req.body.travelAvailable === "true";
    }
    if (req.body.serviceArea !== undefined) {
      update.serviceArea = (req.body.serviceArea || "").trim();
    }
    // Legacy field - keep saving if present for backward compat
    if (req.body.tourismType !== undefined) {
      update.tourismType = (req.body.tourismType || "").trim();
    }

    // ── VIP notification flags (set via VIP Settings page, not edit form) ────
    // These are managed via /suppliers/:id/vip-settings - do not overwrite here.

    // Safety guard: never silently downgrade a hospitality supplier to product/service
    // if the form somehow submitted without the hospitality option selected.
    // Fetch the current record and preserve profileType if it's hospitality and
    // the submitted value is missing or invalid.
    if (!update.profileType || !["product","service","hospitality"].includes(update.profileType)) {
      const _existing = await SupplierProfile.findById(req.params.id).select("profileType").lean();
      if (_existing?.profileType) update.profileType = _existing.profileType;
    }

    await SupplierProfile.findByIdAndUpdate(req.params.id, update, { new: true });
    res.redirect(`/zq-admin/suppliers/${req.params.id}`);
  } catch (err) {
    res.redirect(`/zq-admin/suppliers/${req.params.id}/edit?error=${encodeURIComponent(err.message)}`);
  }
});

// ── Toggle actions ─────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// DELETE SUPPLIER
// GET  /zq-admin/suppliers/:id/delete-confirm  → confirmation page
// POST /zq-admin/suppliers/:id/delete           → execute deletion
// ─────────────────────────────────────────────────────────────────────────────
// What gets deleted:
//   SupplierProfile       → the profile itself
//   Business              → the linked business account (via businessId)
//   UserRole              → owner role records for this phone
//   Branch                → all branches linked to the business
//   Product               → all products in the business catalogue
//   SupplierOrder         → all orders (kept as archive if hasOrders=true, unless admin confirms)
//   SupplierSubscriptionPayment → payment history
//   SearchCommandLog      → search logs for this phone
//   UserSession           → active session state
//
// Orders are KEPT by default (financial audit trail). Admin sees the count and
// can choose to also delete them via a checkbox.

router.get("/suppliers/:id/delete-confirm", requireSupplierAdmin, async (req, res) => {
  try {
    const supplier = await SupplierProfile.findById(req.params.id).lean();
    if (!supplier) return res.redirect("/zq-admin/suppliers");

    const [orderCount, paymentCount] = await Promise.all([
      SupplierOrder.countDocuments({ supplierId: supplier._id }),
      SupplierSubscriptionPayment.countDocuments({
        $or: [{ supplierId: supplier._id }, { supplierPhone: supplier.phone }]
      })
    ]);

    const ordersCheckbox = orderCount > 0
      ? '<div style="background:#fffbeb;border:1px solid #fcd34d;border-radius:7px;padding:12px;margin-bottom:16px">' +
        '<label style="display:flex;align-items:flex-start;gap:10px;cursor:pointer;font-size:13px">' +
        '<input type="checkbox" name="deleteOrders" value="true" style="margin-top:2px;width:15px;height:15px">' +
        '<span><strong>Also delete ' + orderCount + ' order record' + (orderCount === 1 ? '' : 's') + '</strong><br>' +
        '<span style="color:var(--muted)">Leave unchecked to keep orders for accounting records.</span>' +
        '</span></label></div>'
      : '';

    res.send(layout(`Delete: ${esc(supplier.businessName)}`, `
      <a href="/zq-admin/suppliers/${supplier._id}" class="back-link">← Back to Profile</a>

      <div class="panel" style="max-width:580px;border:2px solid #ef4444">
        <div style="display:flex;align-items:center;gap:12px;margin-bottom:18px">
          <div style="width:44px;height:44px;background:#fee2e2;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:20px;flex-shrink:0">🗑</div>
          <div>
            <h3 style="color:#dc2626;margin:0">Delete Supplier</h3>
            <p style="margin:2px 0 0;color:var(--muted);font-size:13px">This action is permanent and cannot be undone.</p>
          </div>
        </div>

        <div style="background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:14px;margin-bottom:20px">
          <p style="font-size:13px;margin-bottom:8px"><strong>You are about to permanently delete:</strong></p>
          <dl style="display:grid;grid-template-columns:140px 1fr;gap:4px;font-size:13px">
            <dt style="color:var(--muted)">Business</dt>
            <dd><strong>${esc(supplier.businessName)}</strong></dd>
            <dt style="color:var(--muted)">Phone</dt>
            <dd>${esc(supplier.phone)}</dd>
            <dt style="color:var(--muted)">Type</dt>
            <dd>${esc(supplier.profileType || "product")} · ${esc(supplier.location?.city || "-")}</dd>
            <dt style="color:var(--muted)">Status</dt>
            <dd>${supplier.active ? "🟢 Active" : "⚫ Inactive"} · ${esc(supplier.tier || "basic")} plan</dd>
            <dt style="color:var(--muted)">Orders</dt>
            <dd>${orderCount > 0 ? "<strong style=\"color:#dc2626\">" + orderCount + " order" + (orderCount === 1 ? "" : "s") + " on record</strong>" : "No orders"}</dd>
            <dt style="color:var(--muted)">Payments</dt>
            <dd>${paymentCount > 0 ? paymentCount + " payment record" + (paymentCount === 1 ? "" : "s") : "No payments"}</dd>
          </dl>
        </div>

        <p style="font-size:13px;color:var(--muted);margin-bottom:16px">
          The following will be permanently removed:
          supplier profile · business account · products & prices ·
          subscription records · search logs · WhatsApp session
        </p>

        <form method="POST" action="/zq-admin/suppliers/${supplier._id}/delete">
          ${ordersCheckbox}

          <div style="margin-bottom:16px">
            <label style="display:block;font-size:12px;font-weight:600;color:var(--muted);margin-bottom:6px;text-transform:uppercase;letter-spacing:.4px">
              Type the business name to confirm:
            </label>
            <input type="text" name="confirmName" required
                   placeholder="${esc(supplier.businessName)}"
                   style="width:100%;padding:10px 12px;border:1px solid #fca5a5;border-radius:7px;font-size:13px;outline:none"
                   oninput="checkName(this.value, '${esc(supplier.businessName)}')" />
            <p id="nameHint" style="font-size:11px;color:var(--muted);margin-top:4px">Must match exactly.</p>
          </div>

          <div style="display:flex;gap:10px;flex-wrap:wrap">
            <button type="submit" id="deleteBtn" class="btn btn-red" disabled>🗑 Permanently Delete</button>
            <a href="/zq-admin/suppliers/${supplier._id}" class="btn btn-gray">Cancel</a>
          </div>
        </form>
      </div>

      <script>
        function checkName(typed, expected) {
          const btn  = document.getElementById("deleteBtn");
          const hint = document.getElementById("nameHint");
          const match = typed.trim() === expected.trim();
          btn.disabled = !match;
          hint.textContent = match ? "✅ Name confirmed." : "Must match exactly: " + expected;
          hint.style.color = match ? "#16a34a" : "var(--muted)";
        }
      </script>
    `));
  } catch (err) {
    res.send(layout("Error", `<div class="alert red">${err.message}</div>`));
  }
});

router.post("/suppliers/:id/delete", requireSupplierAdmin, async (req, res) => {
  try {
    const supplier = await SupplierProfile.findById(req.params.id).lean();
    if (!supplier) return res.redirect("/zq-admin/suppliers");

    const { confirmName, deleteOrders } = req.body;

    // Name confirmation guard
    if (
      !confirmName ||
      confirmName.trim().toLowerCase() !== supplier.businessName.trim().toLowerCase()
    ) {
      return res.redirect(
        `/zq-admin/suppliers/${req.params.id}/delete-confirm?error=${encodeURIComponent("Business name did not match. Deletion cancelled.")}`
      );
    }

    const phone = supplier.phone;

    // ── Dynamic imports for models not loaded at module level ──────────────
    const Business    = (await import("../models/business.js")).default;
    const UserRole    = (await import("../models/userRole.js")).default;
    const Branch      = (await import("../models/branch.js")).default;
    const UserSession = (await import("../models/userSession.js")).default;
    const Product     = (await import("../models/product.js")).default;

    // 1. Delete the SupplierProfile
    await SupplierProfile.findByIdAndDelete(supplier._id);
    console.log(`[Admin Delete] SupplierProfile deleted: ${supplier._id} (${phone})`);

    // 2. Delete linked Business + all its Branches + Products
    if (supplier.businessId) {
      const biz = await Business.findById(supplier.businessId).lean();
      if (biz) {
        await Branch.deleteMany({ businessId: biz._id });
        await Product.deleteMany({ businessId: biz._id });
        await Business.findByIdAndDelete(biz._id);
        console.log(`[Admin Delete] Business deleted: ${biz._id}`);
      }
    }

    // 3. Delete UserRole records for this phone
    await UserRole.deleteMany({ phone });
    console.log(`[Admin Delete] UserRole records deleted for ${phone}`);

    // 4. Clear UserSession
    await UserSession.findOneAndUpdate(
      { phone: phone.replace(/\D+/g, "") },
      { $unset: { activeBusinessId: "", sessionState: "", sessionData: "" } }
    );

    // 5. Delete subscription payment history
    await SupplierSubscriptionPayment.deleteMany({
      $or: [{ supplierId: supplier._id }, { supplierPhone: phone }]
    });

    // 6. Optionally delete orders
    if (deleteOrders === "true") {
      await SupplierOrder.deleteMany({ supplierId: supplier._id });
      console.log(`[Admin Delete] Orders deleted for ${supplier._id}`);
    }

    // 7. Delete search logs for this phone
    await SearchCommandLog.deleteMany({ phone: phone.replace(/\D+/g, "") });

    console.log(`[Admin Delete] ✅ Full delete complete: ${supplier.businessName} (${phone})`);

    res.redirect(`/zq-admin/suppliers?success=${encodeURIComponent(
      supplier.businessName + " has been permanently deleted."
    )}`);
  } catch (err) {
    console.error("[Admin Delete] Error:", err.message);
    res.redirect(`/zq-admin/suppliers/${req.params.id}/delete-confirm?error=${encodeURIComponent(err.message)}`);
  }
});

router.post("/suppliers/:id/toggle-active", requireSupplierAdmin, async (req, res) => {
  try {
    const supplier = await SupplierProfile.findById(req.params.id);
    if (!supplier) return res.redirect(`/zq-admin/suppliers/${req.params.id}`);

    supplier.active = !supplier.active;
    await supplier.save();

    // When toggling ON: ensure Business + UserRole + Branch + UserSession exist
    if (supplier.active) {
      const Business    = (await import("../models/business.js")).default;
      const UserRole    = (await import("../models/userRole.js")).default;
      const Branch      = (await import("../models/branch.js")).default;
      const UserSession = (await import("../models/userSession.js")).default;
      const cleanPhone  = supplier.phone;

      const TIER_TO_PACKAGE = { basic: "bronze", pro: "silver", featured: "gold" };
      const bizPackage = TIER_TO_PACKAGE[supplier.tier] || "bronze";

      // Find or create Business
      let bizRecord = supplier.businessId
        ? await Business.findById(supplier.businessId)
        : null;

      if (!bizRecord) {
        const existingRole = await UserRole.findOne({ phone: cleanPhone, role: "owner" });
        if (existingRole?.businessId) bizRecord = await Business.findById(existingRole.businessId);
      }

      if (!bizRecord) {
        bizRecord = await Business.create({
          name:               supplier.businessName,
          currency:           "USD",
          package:            bizPackage,
          subscriptionStatus: "active",
          isSupplier:         true,
          supplierProfileId:  supplier._id,
          ownerPhone:         cleanPhone,
          sessionState:       "ready",
          sessionData:        {}
        });
        await UserRole.create({
          phone: cleanPhone, role: "owner", pending: false, businessId: bizRecord._id
        });
      } else {
        if (bizRecord.name?.startsWith("pending_")) bizRecord.name = supplier.businessName;
        bizRecord.isSupplier        = true;
        bizRecord.supplierProfileId = supplier._id;
        bizRecord.package           = bizPackage;
        bizRecord.subscriptionStatus = "active";
        await bizRecord.save();
      }

      // Ensure Branch
      let mainBranchId;
      const existingBranch = await Branch.findOne({ businessId: bizRecord._id, isDefault: true });
      if (!existingBranch) {
        const b = await Branch.create({ businessId: bizRecord._id, name: "Main Branch", isDefault: true });
        await UserRole.findOneAndUpdate(
          { businessId: bizRecord._id, role: "owner" }, { branchId: b._id }
        );
        mainBranchId = b._id;
      } else {
        mainBranchId = existingBranch._id;
      }

      // Update SupplierProfile with businessId + mainBranchId
      await SupplierProfile.findByIdAndUpdate(req.params.id, {
        businessId: bizRecord._id, mainBranchId
      });

      // Set activeBusinessId in UserSession
  await UserSession.findOneAndUpdate(
        { phone: cleanPhone },
        { phone: cleanPhone, activeBusinessId: bizRecord._id },
        { upsert: true }
      );

      // ── Notify seller on WhatsApp ─────────────────────────────────────────
      try {
        const { sendText } = await import("../services/metaSender.js");
        await sendText(supplier.phone,
`✅ *Your listing is now LIVE on ZimQuote!*

🏪 *${supplier.businessName}*
📍 ${supplier.location?.area || ""}, ${supplier.location?.city || ""}
⭐ Plan: *${supplier.tier?.toUpperCase() || "Basic"}*

Buyers can now find you when they search on WhatsApp.

Type *menu* to access your seller dashboard.`
        );
      } catch (notifyErr) {
        console.error("[Admin Toggle] WhatsApp notify failed:", notifyErr.message);
      }
    }

    res.redirect(`/zq-admin/suppliers/${req.params.id}`);
  } catch (err) {
    res.redirect(`/zq-admin/suppliers/${req.params.id}`);
  }
});

router.post("/suppliers/:id/toggle-suspend", requireSupplierAdmin, async (req, res) => {
  const supplier = await SupplierProfile.findById(req.params.id);
  if (supplier) {
    supplier.suspended = !supplier.suspended;
    if (supplier.suspended) supplier.active = false;
    await supplier.save();
  }
  res.redirect(`/zq-admin/suppliers/${req.params.id}`);
});


// ── Manual Activation ──────────────────────────────────────────────────────
router.get("/suppliers/:id/activate", requireSupplierAdmin, async (req, res) => {
  try {
    const supplier = await SupplierProfile.findById(req.params.id).lean();
    if (!supplier) return res.redirect("/zq-admin/suppliers");

    const { SUPPLIER_PLANS } = await import("../services/supplierPlans.js");

    res.send(layout(`Activate: ${esc(supplier.businessName)}`, `
      <a href="/zq-admin/suppliers/${supplier._id}" class="back-link">← Back to Profile</a>
      <div class="panel">
        <h3>🎁 Manual Activation</h3>
        <p style="color:var(--muted);margin-bottom:20px;font-size:13px">
          Activate this supplier without requiring EcoCash payment. 
          Use for testing, free trials, or manual arrangements.
        </p>
        <form method="POST" action="/zq-admin/suppliers/${supplier._id}/activate" class="edit-form">
          <div class="form-grid">
            <div class="fg">
              <label>Tier / Plan</label>
              <select name="tier" required>
                <option value="">Select a plan...</option>
                <option value="basic">✅ Basic - $5/month</option>
                <option value="pro">⭐ Pro - $12/month</option>
                <option value="featured">🔥 Featured - $25/month</option>
              </select>
            </div>
            <div class="fg">
              <label>Billing Cycle</label>
              <select name="plan">
                <option value="monthly">Monthly</option>
                <option value="annual">Annual</option>
              </select>
            </div>
            <div class="fg">
              <label>Duration (days)</label>
              <input type="number" name="durationDays" value="30" min="1" max="365" />
            </div>
            <div class="fg">
              <label>Reason / Note</label>
              <input name="reason" placeholder="e.g. Free trial, paid cash..." />
            </div>
          </div>
          <div class="fg full" style="margin-bottom:16px">
            <label>Also set active?</label>
            <select name="setActive">
              <option value="true">Yes - make listing visible to buyers</option>
              <option value="false">No - activate subscription only</option>
            </select>
          </div>
          <div class="form-actions">
            <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px;
                        background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:12px">
              <input type="checkbox" name="generateReceipt" value="true" id="genReceipt"
                     style="width:18px;height:18px;accent-color:#16a34a;cursor:pointer">
              <label for="genReceipt" style="font-size:14px;font-weight:600;color:#15803d;cursor:pointer">
                📄 Download professional PDF receipt after activation
              </label>
            </div>
            <button type="submit" class="btn btn-green">✅ Activate Now</button>
            <a href="/zq-admin/suppliers/${supplier._id}" class="btn btn-gray">Cancel</a>
          </div>
        </form>
      </div>
    `));
  } catch (err) {
    res.send(layout("Error", `<div class="alert red">${err.message}</div>`));
  }
});

router.post("/suppliers/:id/activate", requireSupplierAdmin, async (req, res) => {
  try {
    const { tier, plan, durationDays, reason, setActive } = req.body;
    const { SUPPLIER_PLANS } = await import("../services/supplierPlans.js");

    const supplier = await SupplierProfile.findById(req.params.id);
    if (!supplier) return res.redirect("/zq-admin/suppliers");

    const planDetails = SUPPLIER_PLANS[tier]?.[plan];
    const days = Number(durationDays) || planDetails?.durationDays || 30;

    const now = new Date();
    const expiresAt = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);

    // Tier → Business package mapping (mirrors supplierRegistration.js)
    const TIER_TO_PACKAGE = { basic: "bronze", pro: "silver", featured: "gold" };
    const bizPackage = TIER_TO_PACKAGE[tier] || "bronze";
    const isActive   = setActive === "true";

    // ── Import models ─────────────────────────────────────────────────────
    const Business    = (await import("../models/business.js")).default;
    const UserRole    = (await import("../models/userRole.js")).default;
    const Branch      = (await import("../models/branch.js")).default;
    const UserSession = (await import("../models/userSession.js")).default;
    const Product     = (await import("../models/product.js")).default;

    const cleanPhone = supplier.phone;

    // ── 1. Find or create the Business record ─────────────────────────────
    let bizRecord = supplier.businessId
      ? await Business.findById(supplier.businessId)
      : null;

    if (!bizRecord) {
      // Check if a Business already exists for this phone (e.g. from WhatsApp)
      const existingRole = await UserRole.findOne({ phone: cleanPhone, role: "owner" });
      if (existingRole?.businessId) {
        bizRecord = await Business.findById(existingRole.businessId);
      }
    }

    if (!bizRecord) {
      // No Business at all - create one now
      bizRecord = await Business.create({
        name:               supplier.businessName,
        currency:           "USD",
        package:            isActive ? bizPackage : "trial",
        subscriptionStatus: isActive ? "active" : "inactive",
        subscriptionStartedAt: isActive ? now : undefined,
        subscriptionEndsAt:    isActive ? expiresAt : undefined,
        isSupplier:         true,
        supplierProfileId:  supplier._id,
        ownerPhone:         cleanPhone,
        sessionState:       "ready",
        sessionData:        {}
      });

      // Create UserRole for owner
      await UserRole.create({
        phone:      cleanPhone,
        role:       "owner",
        pending:    false,
        businessId: bizRecord._id
      });
    } else {
      // Update existing Business to reflect new plan
      bizRecord.name               = bizRecord.name?.startsWith("pending_") ? supplier.businessName : bizRecord.name;
      bizRecord.package            = isActive ? bizPackage : bizRecord.package;
      bizRecord.subscriptionStatus = isActive ? "active" : bizRecord.subscriptionStatus;
      bizRecord.isSupplier         = true;
      bizRecord.supplierProfileId  = supplier._id;
      if (isActive) {
        bizRecord.subscriptionStartedAt = now;
        bizRecord.subscriptionEndsAt    = expiresAt;
      }
      await bizRecord.save();
    }

    // ── 2. Ensure main Branch exists ──────────────────────────────────────
    let mainBranchId;
    const existingBranch = await Branch.findOne({ businessId: bizRecord._id, isDefault: true });
    if (!existingBranch) {
      const mainBranch = await Branch.create({
        businessId: bizRecord._id,
        name:       "Main Branch",
        isDefault:  true
      });
      await UserRole.findOneAndUpdate(
        { businessId: bizRecord._id, role: "owner" },
        { branchId: mainBranch._id }
      );
      mainBranchId = mainBranch._id;
    } else {
      mainBranchId = existingBranch._id;
    }

    // ── 3. Set activeBusinessId in UserSession so WhatsApp login works ────
    await UserSession.findOneAndUpdate(
      { phone: cleanPhone },
      { phone: cleanPhone, activeBusinessId: bizRecord._id },
      { upsert: true }
    );

    // ── 4. Update SupplierProfile with businessId + mainBranchId ─────────
    const supplierUpdate = {
      tier,
      tierRank:              tier === "featured" ? 3 : tier === "pro" ? 2 : 1,
      subscriptionStatus:    "active",
      subscriptionStartedAt: now,
      subscriptionEndsAt:    expiresAt,
      subscriptionPlan:      plan,
      active:                isActive,
      businessId:            bizRecord._id,
      mainBranchId:          mainBranchId,
      adminNote: reason
        ? `[Admin activated ${tier}/${plan} on ${now.toDateString()}] ${reason}`
        : `[Admin activated ${tier}/${plan} on ${now.toDateString()}]`
    };
    await SupplierProfile.findByIdAndUpdate(req.params.id, supplierUpdate);

    // ── 5. Sync products into the Product model ───────────────────────────
    const capMap  = { basic: 20, pro: 60, featured: 150 };
    const cap     = capMap[tier] || 20;
    const toSync  = (supplier.listedProducts || supplier.products || []).slice(0, cap);
    for (const itemName of toSync) {
      const priceEntry  = (supplier.prices || []).find(p => p.product?.toLowerCase() === itemName.toLowerCase());
      const rateEntry   = (supplier.rates  || []).find(r => r.service?.toLowerCase() === itemName.toLowerCase());
      const unitPrice   = priceEntry?.amount || 0;
      const description = rateEntry?.rate || null;
      await Product.findOneAndUpdate(
        { businessId: bizRecord._id, name: itemName },
        {
          $set: {
            businessId:  bizRecord._id,
            branchId:    mainBranchId,
            unitPrice,
            description,
            isActive:    true
          }
        },
        { upsert: true }
      );
    }

    // ── 6. Log a payment record ───────────────────────────────────────────
    await SupplierSubscriptionPayment.create({
      supplierPhone: cleanPhone,
      supplierId:    req.params.id,
      tier,
      plan,
      amount:        0,
      currency:      "USD",
      reference:     `MANUAL_${req.params.id}_${Date.now()}`,
      status:        "paid",
      paidAt:        now,
      ecocashPhone:  "manual-admin"
    });

   // ── Notify seller on WhatsApp ─────────────────────────────────────────
    if (isActive) {
      try {
        const { sendText } = await import("../services/metaSender.js");
        const planLabel = plan === "annual" ? "Annual" : "Monthly";
        await sendText(supplier.phone,
`✅ *Your listing is now LIVE on ZimQuote!*

🏪 *${supplier.businessName}*
📍 ${supplier.location?.area || ""}, ${supplier.location?.city || ""}
⭐ Plan: *${tier.charAt(0).toUpperCase() + tier.slice(1)} (${planLabel})*
📅 Active until: *${expiresAt.toDateString()}*

Buyers can now find you when they search on WhatsApp.

Type *menu* to access your seller dashboard, manage your products and receive orders.`
        );
      } catch (notifyErr) {
        console.error("[Admin Activate] WhatsApp notify failed:", notifyErr.message);
      }
    }

    // ── 7. Generate & stream PDF receipt if admin requested it ──────────────
    if (req.body.generateReceipt === "true" && isActive) {
      const refAct      = `ZQ-ACT-${Date.now()}`;
      const planLabelA  = tier.charAt(0).toUpperCase() + tier.slice(1);
      const cycleLabelA = plan === "annual" ? "Annual" : "Monthly";
      const locationA   = [supplier.location?.area, supplier.location?.city].filter(Boolean).join(", ");
      await _streamReceiptPDF(res, {
        filename:     `ZimQuote_Activation_${refAct}.pdf`,
        ref:          refAct,
        isActivation: true,
        supplierName: supplier.businessName,
        phone:        supplier.phone,
        location:     locationA,
        planLabel:    planLabelA,
        cycleLabel:   cycleLabelA,
        amount:       0,
        currency:     "USD",
        validFromStr: now.toLocaleString("en-GB", { day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" }),
        validUntilStr: expiresAt.toLocaleString("en-GB", { day: "numeric", month: "long", year: "numeric" }),
        methodLabel:  "Admin",
        tableRows: [
          ["Reference",    refAct],
          ["Activated By", "ZimQuote Admin"],
          ["Plan",         `${planLabelA} / ${cycleLabelA}`],
          ["Duration",     `${days} days`],
          ["Active From",  now.toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric" })],
          ["Active Until", expiresAt.toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric" })],
          ["Status",       "Active & Live on ZimQuote"],
          ...(reason ? [["Note", reason]] : [])
        ]
      });
      return;
    }

    res.redirect(`/zq-admin/suppliers/${req.params.id}?success=${encodeURIComponent("Supplier activated! Business account and WhatsApp access are ready.")}`);
  } catch (err) {
    res.send(layout("Error", `<div class="alert red">${err.message}</div>`));
  }
});


// ── Hospitality: Manage Rooms & Activities ────────────────────────────────
router.get("/suppliers/:id/hospitality", requireSupplierAdmin, async (req, res) => {
  try {
    const supplier = await SupplierProfile.findById(req.params.id).lean();
    if (!supplier) return res.redirect("/zq-admin/suppliers");
    if (supplier.profileType !== "hospitality") {
      return res.redirect(`/zq-admin/suppliers/${supplier._id}/products`);
    }

    const successMsg = req.query.success
      ? `<div style="background:#dcfce7;color:#16a34a;padding:12px 16px;border-radius:8px;margin-bottom:16px">✅ ${esc(req.query.success)}</div>`
      : "";

    const SUBTYPE_LABELS = {
      lodge:"🌿 Lodge",hotel:"🏨 Hotel",guesthouse:"🏡 Guesthouse/B&B",
      self_catering:"🍳 Self-Catering",campsite:"⛺ Campsite",
      safari_operator:"🦁 Safari Operator",tour_guide:"🗺 Tour Guide",
      boat_hire:"⛵ Boat Hire",travel_agency:"✈️ Travel Agency"
    };
    const subtypeLabel = (supplier.tourismSubtype||[]).map(s => SUBTYPE_LABELS[s]||s).join(" · ") || "Hospitality";
    const isAccom = (supplier.tourismSubtype||[]).some(s =>
      ["lodge","hotel","guesthouse","self_catering","campsite"].includes(s)
    );
    const isActivity = (supplier.tourismSubtype||[]).some(s =>
      ["safari_operator","tour_guide","boat_hire","travel_agency"].includes(s)
    );

    const FACILITY_LABELS = {
      wifi:"📶 WiFi",pool:"🏊 Pool",hot_shower:"🚿 Hot shower",breakfast:"🍳 Breakfast",
      en_suite:"🚪 En-suite",generator:"⚡ Generator/Solar",dstv:"📺 DSTV",braai:"🔥 Braai",
      aircon:"❄️ AC",game_drives:"🦁 Game drives",fishing:"🎣 Fishing",boat_hire:"⛵ Boat hire",
      conference:"🏢 Conference",restaurant:"🍽 Restaurant",laundry:"👕 Laundry",
      parking:"🅿️ Parking",pets_allowed:"🐕 Pets OK",child_friendly:"👶 Child-friendly"
    };

    res.send(layout(`Hospitality: ${esc(supplier.businessName)}`, `
      <a href="/zq-admin/suppliers/${supplier._id}" class="back-link">← Back to Profile</a>
      ${successMsg}

      <!-- Profile summary banner -->
      <div style="background:linear-gradient(135deg,#064e3b,#065f46);color:#fff;border-radius:12px;padding:20px 24px;margin-bottom:20px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px">
        <div>
          <div style="font-size:18px;font-weight:700">${esc(supplier.businessName)}</div>
          <div style="font-size:13px;opacity:.85;margin-top:3px">${subtypeLabel} · 📍 ${esc(supplier.location?.area||"")}, ${esc(supplier.location?.city||"")}</div>
          ${(supplier.tourismAreas||[]).length ? `<div style="font-size:12px;opacity:.7;margin-top:2px">🌍 ${supplier.tourismAreas.join(", ")}</div>` : ""}
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          ${supplier.checkInTime||supplier.checkOutTime ? `<div style="background:rgba(255,255,255,.15);padding:6px 12px;border-radius:8px;font-size:12px">⏰ In: ${esc(supplier.checkInTime||"?")} · Out: ${esc(supplier.checkOutTime||"?")}</div>` : ""}
          ${supplier.maxCapacity > 0 ? `<div style="background:rgba(255,255,255,.15);padding:6px 12px;border-radius:8px;font-size:12px">👥 Up to ${supplier.maxCapacity} guests</div>` : ""}
        </div>
      </div>

      <div class="two-col">

        <!-- LEFT: Rooms / Activities -->
        <div>
          ${isAccom ? `
          <div class="panel">
            <div class="panel-head">
              <h3>🛏 Room Types (${(supplier.roomTypes||[]).length})</h3>
            </div>
            ${(supplier.roomTypes||[]).length ? `
            <table>
              <thead><tr><th>Room Type</th><th>Guests</th><th>Night Rate</th><th>Rest Rate</th><th></th></tr></thead>
              <tbody>
                ${(supplier.roomTypes||[]).map((rt,i) => `
                <tr>
                  <td><strong>${esc(rt.name)}</strong></td>
                  <td>${rt.capacity||"-"}</td>
                  <td>${rt.pricePerNight > 0 ? "<strong>$" + Number(rt.pricePerNight).toFixed(0) + "/night</strong>" : "<em class='muted'>not set</em>"}</td>
                  <td>${rt.restRate > 0 ? "$" + Number(rt.restRate).toFixed(0) + "/rest" : "<em class='muted'>-</em>"}</td>
                  <td>
                    <a href="/zq-admin/suppliers/${supplier._id}/hospitality/edit-room/${i}" class="btn-link" style="font-size:12px">Edit</a>
                    &nbsp;
                    <a href="/zq-admin/suppliers/${supplier._id}/hospitality/delete-room/${i}"
                       class="btn-link" style="color:#ef4444;font-size:12px"
                       onclick="return confirm('Delete this room type?')">Del</a>
                  </td>
                </tr>`).join("")}
              </tbody>
            </table>` : `<p class="muted" style="margin-bottom:14px">No room types added yet.</p>`}

            <form method="POST" action="/zq-admin/suppliers/${supplier._id}/hospitality/add-room" style="margin-top:16px;padding-top:14px;border-top:1px solid var(--border)">
              <p style="font-weight:600;font-size:13px;margin-bottom:10px">➕ Add Room Type</p>
              <div class="form-grid" style="margin-bottom:10px">
                <div class="fg">
                  <label>Room Name</label>
                  <input name="roomName" placeholder="e.g. Double room, Family chalet" required />
                </div>
                <div class="fg">
                  <label>Max Guests</label>
                  <input type="number" name="capacity" value="2" min="1" max="50" />
                </div>
                <div class="fg">
                  <label>Night Rate (USD/night)</label>
                  <input type="number" name="pricePerNight" value="0" min="0" step="0.5" />
                </div>
                <div class="fg">
                  <label>Rest Rate (USD/few hours) <span style="font-weight:400;font-size:11px;color:var(--muted)">Optional</span></label>
                  <input type="number" name="restRate" value="0" min="0" step="0.5" placeholder="e.g. 40" />
                </div>
                <div class="fg">
                  <label>Description (optional)</label>
                  <input name="description" placeholder="e.g. Lake view, en-suite bathroom" />
                </div>
              </div>
              <button type="submit" class="btn btn-green btn-sm">➕ Add Room</button>
            </form>
          </div>` : ""}

          ${isActivity ? `
          <div class="panel">
            <div class="panel-head">
              <h3>🎯 Activities & Services (${(supplier.rates||[]).length})</h3>
            </div>
            ${(supplier.rates||[]).length ? `
            <table>
              <thead><tr><th>Activity</th><th>Rate</th><th></th></tr></thead>
              <tbody>
                ${(supplier.rates||[]).map((r,i) => `
                <tr>
                  <td><strong>${esc(r.service)}</strong></td>
                  <td>${esc(r.rate||"not set")}</td>
                  <td>
                    <a href="/zq-admin/suppliers/${supplier._id}/hospitality/delete-activity/${i}"
                       class="btn-link" style="color:#ef4444;font-size:12px"
                       onclick="return confirm('Delete this activity?')">Del</a>
                  </td>
                </tr>`).join("")}
              </tbody>
            </table>` : `<p class="muted" style="margin-bottom:14px">No activities added yet.</p>`}

            <form method="POST" action="/zq-admin/suppliers/${supplier._id}/hospitality/add-activity" style="margin-top:16px;padding-top:14px;border-top:1px solid var(--border)">
              <p style="font-weight:600;font-size:13px;margin-bottom:10px">➕ Add Activity</p>
              <div class="form-grid" style="margin-bottom:10px">
                <div class="fg">
                  <label>Activity Name</label>
                  <input name="activityName" placeholder="e.g. Morning game drive, Sunset cruise" required />
                </div>
                <div class="fg">
                  <label>Rate</label>
                  <input name="rate" placeholder="e.g. $80/person, $150/trip, $200/group" />
                </div>
              </div>
              <button type="submit" class="btn btn-green btn-sm">➕ Add Activity</button>
            </form>
          </div>` : ""}

          <!-- Extra Services panel -->
          <div class="panel">
            <div class="panel-head">
              <h3>➕ Extra Services <span style="font-size:12px;font-weight:400;color:var(--muted)">charged separately from room rate</span></h3>
            </div>
            ${(supplier.extraServices||[]).length ? `
            <table style="margin-bottom:16px">
              <thead><tr><th>Service</th><th>Price</th><th>Unit</th><th></th></tr></thead>
              <tbody>
                ${(supplier.extraServices||[]).map((es,i) => `
                <tr>
                  <td><strong>${esc(es.name)}</strong></td>
                  <td>${es.price > 0 ? "$" + Number(es.price).toFixed(2) : "<em class='muted'>-</em>"}</td>
                  <td>${esc(es.unit||"service")}</td>
                  <td>
                    <a href="/zq-admin/suppliers/${supplier._id}/hospitality/delete-extra/${i}"
                       class="btn-link" style="color:#ef4444;font-size:12px"
                       onclick="return confirm('Delete this extra service?')">Del</a>
                  </td>
                </tr>`).join("")}
              </tbody>
            </table>` : `<p class="muted" style="margin-bottom:14px">No extra services added yet.</p>`}

            <form method="POST" action="/zq-admin/suppliers/${supplier._id}/hospitality/add-extra" style="padding-top:12px;border-top:1px solid var(--border)">
              <p style="font-weight:600;font-size:13px;margin-bottom:10px">➕ Add Extra Service</p>
              <div class="form-grid" style="margin-bottom:10px">
                <div class="fg">
                  <label>Service Name</label>
                  <input name="extraName" placeholder="e.g. Conference room, Airport pickup, Breakfast" required />
                </div>
                <div class="fg">
                  <label>Price (USD)</label>
                  <input type="number" name="extraPrice" value="0" min="0" step="0.5" />
                </div>
                <div class="fg">
                  <label>Unit</label>
                  <input name="extraUnit" placeholder="e.g. half day, trip, person, load, night" value="service" />
                </div>
              </div>
              <button type="submit" class="btn btn-green btn-sm">➕ Add Service</button>
            </form>

            <div style="margin-top:16px;padding-top:14px;border-top:1px solid var(--border)">
              <p style="font-size:12px;color:var(--muted);margin-bottom:8px">
                <strong>Examples:</strong> Conference room $50/half day · Airport pickup $15/trip ·
                Pool access $5/person · Laundry $3/load · Breakfast $8/person · Braai area $20/day
              </p>
            </div>
          </div>

          <!-- Bulk room / activity edit -->
          <div class="panel">
            <h3>✏️ Bulk Edit Rooms / Activities</h3>
            <p style="color:var(--muted);font-size:12px;margin-bottom:12px">
              One per line: <code>name, max guests, price/night</code> (for rooms) or <code>name, rate</code> (for activities)
            </p>
            <form method="POST" action="/zq-admin/suppliers/${supplier._id}/hospitality/bulk-save">
              <div class="fg full" style="margin-bottom:12px">
                <label>Rooms (name, capacity, price/night)</label>
                <textarea name="roomTypes" rows="6">${(supplier.roomTypes||[]).map(rt =>
                  rt.name + ", " + (rt.capacity||2) + ", " + (rt.pricePerNight||0)
                ).join("\n")}</textarea>
              </div>
              <div class="fg full" style="margin-bottom:12px">
                <label>Activities (name, rate)</label>
                <textarea name="activities" rows="5">${(supplier.rates||[]).map(r =>
                  r.service + (r.rate ? ", " + r.rate : "")
                ).join("\n")}</textarea>
              </div>
              <button type="submit" class="btn btn-blue">💾 Save All</button>
            </form>
          </div>
        </div>

        <!-- RIGHT: Facilities + Settings -->
        <div>
          <div class="panel">
            <div class="panel-head">
              <h3>🏷 Facilities</h3>
            </div>
            <form method="POST" action="/zq-admin/suppliers/${supplier._id}/hospitality/save-facilities">
              <div style="display:flex;flex-direction:column;gap:8px;margin-bottom:16px">
                ${[["wifi","📶 WiFi"],["pool","🏊 Swimming pool"],["hot_shower","🚿 Hot shower"],
                   ["breakfast","🍳 Breakfast included"],["en_suite","🚪 En-suite bathrooms"],
                   ["generator","⚡ Generator / Solar power"],["dstv","📺 DSTV / Satellite TV"],
                   ["braai","🔥 Braai / BBQ area"],["aircon","❄️ Air conditioning"],
                   ["game_drives","🦁 Game drives on-site"],["fishing","🎣 Fishing"],
                   ["boat_hire","⛵ Boat hire"],["conference","🏢 Conference facilities"],
                   ["restaurant","🍽 Restaurant / Bar"],["laundry","👕 Laundry service"],
                   ["parking","🅿️ Parking"],["pets_allowed","🐕 Pets allowed"],
                   ["child_friendly","👶 Child-friendly"]
                ].map(([val,lbl]) =>
                  `<label style="display:flex;align-items:center;gap:8px;cursor:pointer;padding:6px 0;border-bottom:1px solid #f8fafc">
                    <input type="checkbox" name="facilities" value="${val}"
                           ${(supplier.facilities||[]).includes(val) ? "checked" : ""}
                           style="width:15px;height:15px">
                    <span style="font-size:13px">${lbl}</span>
                  </label>`
                ).join("")}
              </div>
              <button type="submit" class="btn btn-blue btn-sm">💾 Save Facilities</button>
            </form>
          </div>

          <div class="panel">
            <h3>⚙️ Property Settings</h3>
            <form method="POST" action="/zq-admin/suppliers/${supplier._id}/hospitality/save-settings">
              <div class="fg" style="margin-bottom:12px">
                <label>Check-in Time</label>
                <input name="checkInTime" value="${esc(supplier.checkInTime||"")}" placeholder="e.g. 14:00" />
              </div>
              <div class="fg" style="margin-bottom:12px">
                <label>Check-out Time</label>
                <input name="checkOutTime" value="${esc(supplier.checkOutTime||"")}" placeholder="e.g. 10:00" />
              </div>
              <div class="fg" style="margin-bottom:12px">
                <label>Max Capacity (total guests)</label>
                <input type="number" name="maxCapacity" value="${supplier.maxCapacity||0}" min="0" />
              </div>
              <div class="fg" style="margin-bottom:12px">
                <label>Meal Plan</label>
                <select name="mealPlan">
                  ${[["not_applicable","Not applicable"],["room_only","Room only"],
                     ["bed_breakfast","Bed & Breakfast"],["half_board","Half Board"],
                     ["full_board","Full Board"],["self_catering","Self-Catering"]
                  ].map(([val,lbl]) =>
                    `<option value="${val}"${supplier.mealPlan===val?" selected":""}>${lbl}</option>`
                  ).join("")}
                </select>
              </div>
              <div class="fg" style="margin-bottom:16px">
                <label>Areas / Destinations Served</label>
                <input name="tourismAreas" value="${esc((supplier.tourismAreas||[]).join(", "))}"
                       placeholder="e.g. Kariba, Hwange, Victoria Falls" />
              </div>
              <button type="submit" class="btn btn-blue btn-sm">💾 Save Settings</button>
            </form>
          </div>
        </div>
      </div>
    `));
  } catch (err) {
    res.send(layout("Error", `<div class="alert red">${err.message}</div>`));
  }
});

// ── Hospitality: Add room type ──────────────────────────────────────────────
router.post("/suppliers/:id/hospitality/add-extra", requireSupplierAdmin, async (req, res) => {
  try {
    const supplier = await SupplierProfile.findById(req.params.id);
    if (!supplier) return res.redirect("/zq-admin/suppliers");
    const { extraName, extraPrice, extraUnit } = req.body;
    if (!extraName?.trim()) return res.redirect(`/zq-admin/suppliers/${req.params.id}/hospitality`);
    supplier.extraServices = supplier.extraServices || [];
    supplier.extraServices.push({
      name:  extraName.trim(),
      price: Number(extraPrice) || 0,
      unit:  (extraUnit || "service").trim()
    });
    supplier.markModified("extraServices");
    await supplier.save();
    res.redirect(`/zq-admin/suppliers/${req.params.id}/hospitality?success=${encodeURIComponent("Extra service added: " + extraName.trim())}`);
  } catch (err) {
    res.redirect(`/zq-admin/suppliers/${req.params.id}/hospitality?error=${encodeURIComponent(err.message)}`);
  }
});

router.get("/suppliers/:id/hospitality/delete-extra/:index", requireSupplierAdmin, async (req, res) => {
  try {
    const supplier = await SupplierProfile.findById(req.params.id);
    if (!supplier) return res.redirect("/zq-admin/suppliers");
    const idx = Number(req.params.index);
    if (!isNaN(idx) && idx >= 0 && idx < (supplier.extraServices||[]).length) {
      const removed = supplier.extraServices[idx].name;
      supplier.extraServices.splice(idx, 1);
      supplier.markModified("extraServices");
      await supplier.save();
      return res.redirect(`/zq-admin/suppliers/${req.params.id}/hospitality?success=${encodeURIComponent("Deleted: " + removed)}`);
    }
    res.redirect(`/zq-admin/suppliers/${req.params.id}/hospitality`);
  } catch (err) {
    res.redirect(`/zq-admin/suppliers/${req.params.id}/hospitality`);
  }
});

router.post("/suppliers/:id/hospitality/add-room", requireSupplierAdmin, async (req, res) => {
  try {
    const supplier = await SupplierProfile.findById(req.params.id);
    if (!supplier) return res.redirect("/zq-admin/suppliers");
    const { roomName, capacity, pricePerNight, restRate, description } = req.body;
    if (!roomName?.trim()) return res.redirect(`/zq-admin/suppliers/${req.params.id}/hospitality`);
    supplier.roomTypes = supplier.roomTypes || [];
    supplier.roomTypes.push({
      name:         roomName.trim(),
      capacity:     Number(capacity) || 2,
      pricePerNight:Number(pricePerNight) || 0,
      restRate:     Number(restRate) || 0,
      currency:     "USD",
      description:  (description || "").trim()
    });
    // Sync products[] for catalogue
    supplier.products = supplier.roomTypes.map(rt => rt.name.toLowerCase());
    supplier.markModified("roomTypes");
    await supplier.save();
    res.redirect(`/zq-admin/suppliers/${req.params.id}/hospitality?success=${encodeURIComponent("Room type added: " + roomName.trim())}`);
  } catch (err) {
    res.redirect(`/zq-admin/suppliers/${req.params.id}/hospitality?error=${encodeURIComponent(err.message)}`);
  }
});

// ── Hospitality: Delete room type ───────────────────────────────────────────
router.get("/suppliers/:id/hospitality/delete-room/:index", requireSupplierAdmin, async (req, res) => {
  try {
    const supplier = await SupplierProfile.findById(req.params.id);
    if (!supplier) return res.redirect("/zq-admin/suppliers");
    const idx = Number(req.params.index);
    if (!isNaN(idx) && idx >= 0 && idx < (supplier.roomTypes||[]).length) {
      const removed = supplier.roomTypes[idx].name;
      supplier.roomTypes.splice(idx, 1);
      supplier.products = supplier.roomTypes.map(rt => rt.name.toLowerCase());
      supplier.markModified("roomTypes");
      await supplier.save();
      return res.redirect(`/zq-admin/suppliers/${req.params.id}/hospitality?success=${encodeURIComponent("Deleted: " + removed)}`);
    }
    res.redirect(`/zq-admin/suppliers/${req.params.id}/hospitality`);
  } catch (err) {
    res.redirect(`/zq-admin/suppliers/${req.params.id}/hospitality`);
  }
});

// ── Hospitality: Add activity (rate) ────────────────────────────────────────
router.post("/suppliers/:id/hospitality/add-activity", requireSupplierAdmin, async (req, res) => {
  try {
    const supplier = await SupplierProfile.findById(req.params.id);
    if (!supplier) return res.redirect("/zq-admin/suppliers");
    const { activityName, rate } = req.body;
    if (!activityName?.trim()) return res.redirect(`/zq-admin/suppliers/${req.params.id}/hospitality`);
    supplier.rates = supplier.rates || [];
    supplier.rates.push({ service: activityName.trim(), rate: (rate||"").trim() });
    supplier.markModified("rates");
    await supplier.save();
    res.redirect(`/zq-admin/suppliers/${req.params.id}/hospitality?success=${encodeURIComponent("Activity added: " + activityName.trim())}`);
  } catch (err) {
    res.redirect(`/zq-admin/suppliers/${req.params.id}/hospitality?error=${encodeURIComponent(err.message)}`);
  }
});

// ── Hospitality: Delete activity ────────────────────────────────────────────
router.get("/suppliers/:id/hospitality/delete-activity/:index", requireSupplierAdmin, async (req, res) => {
  try {
    const supplier = await SupplierProfile.findById(req.params.id);
    if (!supplier) return res.redirect("/zq-admin/suppliers");
    const idx = Number(req.params.index);
    if (!isNaN(idx) && idx >= 0 && idx < (supplier.rates||[]).length) {
      const removed = supplier.rates[idx].service;
      supplier.rates.splice(idx, 1);
      supplier.markModified("rates");
      await supplier.save();
      return res.redirect(`/zq-admin/suppliers/${req.params.id}/hospitality?success=${encodeURIComponent("Deleted: " + removed)}`);
    }
    res.redirect(`/zq-admin/suppliers/${req.params.id}/hospitality`);
  } catch (err) {
    res.redirect(`/zq-admin/suppliers/${req.params.id}/hospitality`);
  }
});

// ── Hospitality: Bulk save rooms + activities ───────────────────────────────
router.post("/suppliers/:id/hospitality/bulk-save", requireSupplierAdmin, async (req, res) => {
  try {
    const supplier = await SupplierProfile.findById(req.params.id);
    if (!supplier) return res.redirect("/zq-admin/suppliers");

    // Parse room types
    const roomTypes = [];
    for (const line of (req.body.roomTypes||"").split("\n")) {
      const parts = line.split(",").map(s => s.trim());
      const name  = parts[0];
      if (!name || name.length < 2) continue;
      roomTypes.push({
        name, capacity: parseInt(parts[1])||2,
        pricePerNight: parseFloat(parts[2])||0, currency: "USD", description: ""
      });
    }
    // Parse activities
    const rates = [];
    for (const line of (req.body.activities||"").split("\n")) {
      const parts   = line.split(",").map(s => s.trim());
      const service = parts[0];
      if (!service || service.length < 2) continue;
      rates.push({ service, rate: parts.slice(1).join(",").trim() });
    }

    // Also parse extra services from the bulk save form
    const extraServices = [];
    for (const line of (req.body.extraServices || "").split("\n")) {
      const parts = line.split(",").map(s => s.trim());
      const name  = parts[0];
      if (!name || name.length < 2) continue;
      extraServices.push({ name, price: parseFloat(parts[1]) || 0, unit: parts[2] || "service" });
    }

    supplier.roomTypes     = roomTypes;
    supplier.rates         = rates;
    supplier.extraServices = extraServices;
    supplier.products      = roomTypes.map(rt => rt.name.toLowerCase());
    supplier.markModified("roomTypes");
    supplier.markModified("rates");
    supplier.markModified("extraServices");
    await supplier.save();

    res.redirect(`/zq-admin/suppliers/${req.params.id}/hospitality?success=${encodeURIComponent("Saved " + roomTypes.length + " rooms, " + rates.length + " activities, " + extraServices.length + " extra services")}`);
  } catch (err) {
    res.redirect(`/zq-admin/suppliers/${req.params.id}/hospitality?error=${encodeURIComponent(err.message)}`);
  }
});

// ── Hospitality: Save facilities ────────────────────────────────────────────
router.post("/suppliers/:id/hospitality/save-facilities", requireSupplierAdmin, async (req, res) => {
  try {
    const rawFac   = req.body.facilities || [];
    const facilities = Array.isArray(rawFac) ? rawFac : [rawFac].filter(Boolean);
    await SupplierProfile.findByIdAndUpdate(req.params.id, { facilities });
    res.redirect(`/zq-admin/suppliers/${req.params.id}/hospitality?success=${encodeURIComponent("Facilities saved (" + facilities.length + " selected)")}`);
  } catch (err) {
    res.redirect(`/zq-admin/suppliers/${req.params.id}/hospitality`);
  }
});

// ── Hospitality: Save property settings ─────────────────────────────────────
router.post("/suppliers/:id/hospitality/save-settings", requireSupplierAdmin, async (req, res) => {
  try {
    const { checkInTime, checkOutTime, maxCapacity, mealPlan, tourismAreas } = req.body;
    await SupplierProfile.findByIdAndUpdate(req.params.id, {
      checkInTime:  (checkInTime  || "").trim(),
      checkOutTime: (checkOutTime || "").trim(),
      maxCapacity:  Number(maxCapacity) || 0,
      mealPlan:     mealPlan || "not_applicable",
      tourismAreas: (tourismAreas||"").split(",").map(s => s.trim()).filter(Boolean)
    });
    res.redirect(`/zq-admin/suppliers/${req.params.id}/hospitality?success=${encodeURIComponent("Property settings saved")}`);
  } catch (err) {
    res.redirect(`/zq-admin/suppliers/${req.params.id}/hospitality`);
  }
});

// ── Manage Products ────────────────────────────────────────────────────────
router.get("/suppliers/:id/products", requireSupplierAdmin, async (req, res) => {
  try {
    const supplier = await SupplierProfile.findById(req.params.id).lean();
    if (!supplier) return res.redirect("/zq-admin/suppliers");

    const { SUPPLIER_PRODUCT_TEMPLATES } = await import("../services/supplierProductTemplates.js").catch(() => ({ SUPPLIER_PRODUCT_TEMPLATES: {} }));
    const templateKeys = Object.keys(SUPPLIER_PRODUCT_TEMPLATES || {});

    res.send(layout(`Products: ${esc(supplier.businessName)}`, `
      <a href="/zq-admin/suppliers/${supplier._id}" class="back-link">← Back to Profile</a>

      <div class="two-col">

        <!-- Current products & prices -->
        <div>
          <div class="panel">
            <div class="panel-head">
              <h3>Current Products (${(supplier.products || []).length})</h3>
            </div>
            ${supplier.products?.length ? `
            <form method="POST" action="/zq-admin/suppliers/${supplier._id}/products/update-list">
              <div class="fg full" style="margin-bottom:12px">
                <label>Edit product list (comma-separated)</label>
                <textarea name="products" rows="5" style="font-size:13px">${(supplier.products || []).join(", ")}</textarea>
              </div>
              <button type="submit" class="btn btn-blue btn-sm">💾 Save Product List</button>
            </form>` : `
            <p class="muted" style="margin-bottom:12px">No products yet.</p>
            <form method="POST" action="/zq-admin/suppliers/${supplier._id}/products/update-list">
              <div class="fg full" style="margin-bottom:12px">
                <label>Add products (comma-separated)</label>
                <textarea name="products" rows="4" placeholder="cooking oil, rice, sugar, flour"></textarea>
              </div>
              <button type="submit" class="btn btn-blue btn-sm">💾 Save</button>
            </form>`}
          </div>

          <div class="panel">
            <div class="panel-head">
              <h3>Prices (${(supplier.prices || []).length})</h3>
              <a href="/zq-admin/suppliers/${supplier._id}/products/add-price" class="btn-link">+ Add Price</a>
            </div>
            ${supplier.prices?.length ? `
            <table>
              <thead><tr><th>Product</th><th>Price</th><th>Unit</th><th>Stock</th><th></th></tr></thead>
              <tbody>
                ${supplier.prices.map((p, i) => `
                <tr>
                  <td>${esc(p.product)}</td>
                  <td>$${p.amount}</td>
                  <td>${esc(p.unit || "each")}</td>
                  <td>${p.inStock !== false ? "✅" : "❌"}</td>
                  <td>
                    <a href="/zq-admin/suppliers/${supplier._id}/products/edit-price/${i}" class="btn-link" style="font-size:12px">Edit</a>
                    &nbsp;
                    <a href="/zq-admin/suppliers/${supplier._id}/products/delete-price/${i}" 
                       class="btn-link" style="color:#ef4444;font-size:12px"
                       onclick="return confirm('Delete this price?')">Del</a>
                  </td>
                </tr>`).join("")}
              </tbody>
            </table>` : `<p class="muted">No prices set yet.</p>`}
          </div>

          ${supplier.rates?.length || supplier.profileType === "service" ? `
          <div class="panel">
            <div class="panel-head">
              <h3>Service Rates (${(supplier.rates || []).length})</h3>
              <a href="/zq-admin/suppliers/${supplier._id}/products/add-rate" class="btn-link">+ Add Rate</a>
            </div>
            ${supplier.rates?.length ? `
            <table>
              <thead><tr><th>Service</th><th>Rate</th><th style="width:120px"></th></tr></thead>
              <tbody>
                ${supplier.rates.map((r, i) => `
                <tr>
                  <td>${esc(r.service)}</td>
                  <td>${esc(r.rate) || '<span style="color:#94a3b8;font-size:12px">-</span>'}</td>
                  <td>
                    <a href="/zq-admin/suppliers/${supplier._id}/products/edit-rate/${i}"
                       class="btn-link" style="font-size:12px">Edit</a>
                    &nbsp;
                    <a href="/zq-admin/suppliers/${supplier._id}/products/delete-rate/${i}"
                       class="btn-link" style="color:#ef4444;font-size:12px"
                       onclick="return confirm('Delete this rate?')">Del</a>
                  </td>
                </tr>`).join("")}
              </tbody>
            </table>` : `<p class="muted">No rates set yet.</p>`}
          </div>` : ""}
        </div>

        <!-- Bulk add -->
        <div>
          <div class="panel">
            <h3>📋 Bulk Add Products</h3>
            <p style="color:var(--muted);font-size:12px;margin-bottom:14px">
              Paste products one per line or comma-separated. Format:<br>
              <code>product name, price, unit</code> or just <code>product name</code>
            </p>
            <form method="POST" action="/zq-admin/suppliers/${supplier._id}/products/bulk-add">
              <div class="fg full" style="margin-bottom:12px">
                <label>Products (one per line)</label>
                <textarea name="bulk" rows="10" placeholder="cooking oil, 4.50, litre&#10;rice, 8, bag&#10;sugar, 1.20, kg&#10;bread&#10;flour, 3, 5kg bag"></textarea>
              </div>
              <div class="fg" style="margin-bottom:12px">
                <label>Add mode</label>
                <select name="mode">
                  <option value="append">Append to existing</option>
                  <option value="replace">Replace all products</option>
                </select>
              </div>
              <button type="submit" class="btn btn-blue">📥 Import Products</button>
            </form>
          </div>

          ${templateKeys.length ? `
          <div class="panel">
            <h3>📦 Load from Template</h3>
            <p style="color:var(--muted);font-size:12px;margin-bottom:14px">
              Load a preset product list for this supplier's category.
            </p>
            <form method="POST" action="/zq-admin/suppliers/${supplier._id}/products/load-template">
              <div class="fg" style="margin-bottom:12px">
                <label>Template</label>
                <select name="templateKey">
                  ${templateKeys.map(k => {
                    const t = SUPPLIER_PRODUCT_TEMPLATES[k];
                    return `<option value="${esc(k)}">${esc(t.label)} (${t.products.length} items)</option>`;
                  }).join("")}
                </select>
              </div>
              <div class="fg" style="margin-bottom:12px">
                <label>Mode</label>
                <select name="mode">
                  <option value="append">Append to existing</option>
                  <option value="replace">Replace all</option>
                </select>
              </div>
              <button type="submit" class="btn btn-blue">📦 Load Template</button>
            </form>
          </div>` : ""}
        </div>
      </div>
    `));
  } catch (err) {
    res.send(layout("Error", `<div class="alert red">${err.message}</div>`));
  }
});

// ── Update product list (text area) ───────────────────────────────────────
router.post("/suppliers/:id/products/update-list", requireSupplierAdmin, async (req, res) => {
  const { products } = req.body;
  const list = (products || "").split(",").map(p => p.trim().toLowerCase()).filter(Boolean);
  await SupplierProfile.findByIdAndUpdate(req.params.id, { products: list });
  res.redirect(`/zq-admin/suppliers/${req.params.id}/products`);
});

// ── Bulk add products ──────────────────────────────────────────────────────
router.post("/suppliers/:id/products/bulk-add", requireSupplierAdmin, async (req, res) => {
  try {
    const { bulk, mode } = req.body;
    const supplier = await SupplierProfile.findById(req.params.id);
    if (!supplier) return res.redirect("/zq-admin/suppliers");

    const lines = (bulk || "").split(/[\n,]+/).map(l => l.trim()).filter(Boolean);
    const newProducts = [];
    const newPrices = [];

    for (const line of lines) {
      // Try to parse "product, price, unit" format
      const parts = line.split(",").map(p => p.trim());
      const name = parts[0]?.toLowerCase();
      if (!name) continue;

      newProducts.push(name);

      const price = parseFloat(parts[1]);
      const unit = parts[2] || "each";
      if (!isNaN(price) && price > 0) {
        newPrices.push({ product: name, amount: price, unit, inStock: true });
      }
    }

    if (mode === "replace") {
      supplier.products = newProducts;
      supplier.prices = newPrices.length ? newPrices : supplier.prices;
    } else {
      // Append - avoid duplicates
      const existingNames = new Set(supplier.products || []);
      for (const p of newProducts) {
        if (!existingNames.has(p)) supplier.products.push(p);
      }
      const existingPriceNames = new Set((supplier.prices || []).map(p => p.product));
      for (const p of newPrices) {
        if (!existingPriceNames.has(p.product)) supplier.prices.push(p);
      }
    }

    await supplier.save();
    res.redirect(`/zq-admin/suppliers/${req.params.id}/products`);
  } catch (err) {
    res.send(layout("Error", `<div class="alert red">${err.message}</div>`));
  }
});

// ── Load template ──────────────────────────────────────────────────────────
router.post("/suppliers/:id/products/load-template", requireSupplierAdmin, async (req, res) => {
  try {
    const { templateKey, mode } = req.body;
    const { SUPPLIER_PRODUCT_TEMPLATES } = await import("../services/supplierProductTemplates.js");
    const template = SUPPLIER_PRODUCT_TEMPLATES[templateKey];
    if (!template) return res.redirect(`/zq-admin/suppliers/${req.params.id}/products`);

    const supplier = await SupplierProfile.findById(req.params.id);
    if (!supplier) return res.redirect("/zq-admin/suppliers");

    if (mode === "replace") {
      supplier.products = [...template.products];
    } else {
      const existing = new Set(supplier.products || []);
      for (const p of template.products) {
        if (!existing.has(p)) supplier.products.push(p);
      }
    }

    await supplier.save();
    res.redirect(`/zq-admin/suppliers/${req.params.id}/products`);
  } catch (err) {
    res.send(layout("Error", `<div class="alert red">${err.message}</div>`));
  }
});

// ── Add price ──────────────────────────────────────────────────────────────
router.get("/suppliers/:id/products/add-price", requireSupplierAdmin, async (req, res) => {
  const supplier = await SupplierProfile.findById(req.params.id).lean();
  if (!supplier) return res.redirect("/zq-admin/suppliers");

  res.send(layout("Add Price", `
    <a href="/zq-admin/suppliers/${supplier._id}/products" class="back-link">← Back to Products</a>
    <div class="panel" style="max-width:500px">
      <h3>Add Price</h3>
      <form method="POST" action="/zq-admin/suppliers/${supplier._id}/products/add-price" class="edit-form">
        <div class="fg" style="margin-bottom:12px">
          <label>Product Name</label>
          <input name="product" list="product-suggestions" placeholder="e.g. cooking oil" required />
          <datalist id="product-suggestions">
            ${(supplier.products || []).map(p => `<option value="${esc(p)}">`).join("")}
          </datalist>
        </div>
        <div class="fg" style="margin-bottom:12px">
          <label>Price ($)</label>
          <input type="number" name="amount" step="0.01" min="0" placeholder="4.50" required />
        </div>
        <div class="fg" style="margin-bottom:12px">
          <label>Unit</label>
          <input name="unit" placeholder="each, kg, litre, bag..." value="each" />
        </div>
        <div class="fg" style="margin-bottom:16px">
          <label>In Stock</label>
          <select name="inStock">
            <option value="true">Yes</option>
            <option value="false">No</option>
          </select>
        </div>
        <div class="form-actions">
          <button type="submit" class="btn btn-blue">💾 Add Price</button>
          <a href="/zq-admin/suppliers/${supplier._id}/products" class="btn btn-gray">Cancel</a>
        </div>
      </form>
    </div>
  `));
});

router.post("/suppliers/:id/products/add-price", requireSupplierAdmin, async (req, res) => {
  try {
    const { product, amount, unit, inStock } = req.body;
    const supplier = await SupplierProfile.findById(req.params.id);
    if (!supplier) return res.redirect("/zq-admin/suppliers");

    const newPrice = {
      product: product.trim().toLowerCase(),
      amount: parseFloat(amount),
      unit: unit?.trim() || "each",
      inStock: inStock === "true",
      currency: "USD"
    };

    // Update existing or push new
    const idx = supplier.prices.findIndex(p => p.product === newPrice.product);
    if (idx >= 0) supplier.prices[idx] = newPrice;
    else supplier.prices.push(newPrice);

    // Also add to products list if not there
    if (!supplier.products.includes(newPrice.product)) {
      supplier.products.push(newPrice.product);
    }

    await supplier.save();
    res.redirect(`/zq-admin/suppliers/${supplier._id}/products`);
  } catch (err) {
    res.send(layout("Error", `<div class="alert red">${err.message}</div>`));
  }
});

// ── Edit price ─────────────────────────────────────────────────────────────
router.get("/suppliers/:id/products/edit-price/:idx", requireSupplierAdmin, async (req, res) => {
  const supplier = await SupplierProfile.findById(req.params.id).lean();
  if (!supplier) return res.redirect("/zq-admin/suppliers");

  const idx = parseInt(req.params.idx);
  const price = supplier.prices?.[idx];
  if (!price) return res.redirect(`/zq-admin/suppliers/${supplier._id}/products`);

  res.send(layout("Edit Price", `
    <a href="/zq-admin/suppliers/${supplier._id}/products" class="back-link">← Back to Products</a>
    <div class="panel" style="max-width:500px">
      <h3>Edit Price - ${esc(price.product)}</h3>
      <form method="POST" action="/zq-admin/suppliers/${supplier._id}/products/edit-price/${idx}" class="edit-form">
        <div class="fg" style="margin-bottom:12px">
          <label>Product Name</label>
          <input name="product" value="${esc(price.product)}" required />
        </div>
        <div class="fg" style="margin-bottom:12px">
          <label>Price ($)</label>
          <input type="number" name="amount" step="0.01" min="0" value="${price.amount}" required />
        </div>
        <div class="fg" style="margin-bottom:12px">
          <label>Unit</label>
          <input name="unit" value="${esc(price.unit || "each")}" />
        </div>
        <div class="fg" style="margin-bottom:16px">
          <label>In Stock</label>
          <select name="inStock">
            <option ${price.inStock !== false ? "selected" : ""} value="true">Yes</option>
            <option ${price.inStock === false ? "selected" : ""} value="false">No</option>
          </select>
        </div>
        <div class="form-actions">
          <button type="submit" class="btn btn-blue">💾 Save</button>
          <a href="/zq-admin/suppliers/${supplier._id}/products" class="btn btn-gray">Cancel</a>
        </div>
      </form>
    </div>
  `));
});

router.post("/suppliers/:id/products/edit-price/:idx", requireSupplierAdmin, async (req, res) => {
  try {
    const supplier = await SupplierProfile.findById(req.params.id);
    if (!supplier) return res.redirect("/zq-admin/suppliers");

    const idx = parseInt(req.params.idx);
    const { product, amount, unit, inStock } = req.body;

    if (idx >= 0 && idx < supplier.prices.length) {
      supplier.prices[idx].product = product.trim().toLowerCase();
      supplier.prices[idx].amount = parseFloat(amount);
      supplier.prices[idx].unit = unit?.trim() || "each";
      supplier.prices[idx].inStock = inStock === "true";
      supplier.prices[idx].currency = "USD";
      supplier.markModified("prices");  // ← THIS IS THE KEY FIX
      await supplier.save();
    }

    res.redirect(`/zq-admin/suppliers/${supplier._id}/products`);
  } catch (err) {
    res.send(layout("Error", `<div class="alert red">${err.message}</div>`));
  }
});

// ── Delete price ───────────────────────────────────────────────────────────
router.get("/suppliers/:id/products/delete-price/:idx", requireSupplierAdmin, async (req, res) => {
  try {
    const supplier = await SupplierProfile.findById(req.params.id);
    if (supplier) {
      supplier.prices.splice(parseInt(req.params.idx), 1);
      supplier.markModified("prices");  // ← ADD THIS
      await supplier.save();
    }
    res.redirect(`/zq-admin/suppliers/${supplier._id}/products`);
  } catch (err) {
    res.redirect(`/zq-admin/suppliers/${req.params.id}/products`);
  }
});



// ── Add service rate ───────────────────────────────────────────────────────
router.get("/suppliers/:id/products/add-rate", requireSupplierAdmin, async (req, res) => {
  const supplier = await SupplierProfile.findById(req.params.id).lean();
  if (!supplier) return res.redirect("/zq-admin/suppliers");

  res.send(layout("Add Rate", `
    <a href="/zq-admin/suppliers/${supplier._id}/products" class="back-link">← Back to Products</a>
    <div class="panel" style="max-width:500px">
      <h3>Add Service Rate</h3>
      <form method="POST" action="/zq-admin/suppliers/${supplier._id}/products/add-rate" class="edit-form">
        <div class="fg" style="margin-bottom:12px">
          <label>Service Name</label>
          <input name="service" placeholder="e.g. plumbing, car hire" required />
        </div>
        <div class="fg" style="margin-bottom:16px">
          <label>Rate <span style="font-weight:400;font-size:11px;color:var(--muted)">(optional)</span></label>
          <input name="rate" placeholder="e.g. $20/job, $10/hr, price on request" />
        </div>
        <div class="form-actions">
          <button type="submit" class="btn btn-blue">💾 Add Rate</button>
          <a href="/zq-admin/suppliers/${supplier._id}/products" class="btn btn-gray">Cancel</a>
        </div>
      </form>
    </div>
  `));
});

router.post("/suppliers/:id/products/add-rate", requireSupplierAdmin, async (req, res) => {
  try {
    const { service, rate } = req.body;
    const supplier = await SupplierProfile.findById(req.params.id);
    if (!supplier) return res.redirect("/zq-admin/suppliers");

    if (!supplier.rates) supplier.rates = [];
    supplier.rates.push({
      service: service.trim().toLowerCase(),
      rate: (rate || "").trim().toLowerCase()
    });

    // Also add to products list
    const svcName = service.trim().toLowerCase();
    if (!supplier.products.includes(svcName)) supplier.products.push(svcName);

    await supplier.save();
    res.redirect(`/zq-admin/suppliers/${supplier._id}/products`);
  } catch (err) {
    res.send(layout("Error", `<div class="alert red">${err.message}</div>`));
  }
});

// ── Edit service rate ──────────────────────────────────────────────────────
router.get("/suppliers/:id/products/edit-rate/:idx", requireSupplierAdmin, async (req, res) => {
  try {
    const supplier = await SupplierProfile.findById(req.params.id).lean();
    if (!supplier) return res.redirect("/zq-admin/suppliers");
    const idx = parseInt(req.params.idx, 10);
    const rate = (supplier.rates || [])[idx];
    if (!rate) return res.redirect(`/zq-admin/suppliers/${supplier._id}/products`);

    res.send(layout("Edit Rate", `
      <a href="/zq-admin/suppliers/${supplier._id}/products" class="back-link">← Back to Products</a>
      <div class="panel" style="max-width:500px">
        <h3>Edit Service Rate</h3>
        <form method="POST" action="/zq-admin/suppliers/${supplier._id}/products/edit-rate/${idx}" class="edit-form">
          <div class="fg" style="margin-bottom:12px">
            <label>Service Name</label>
            <input name="service" value="${esc(rate.service)}" placeholder="e.g. plumbing, car hire" required />
          </div>
          <div class="fg" style="margin-bottom:16px">
            <label>Rate <span style="font-weight:400;font-size:11px;color:var(--muted)">(optional)</span></label>
            <input name="rate" value="${esc(rate.rate || "")}" placeholder="e.g. $20/job, $10/hr, price on request" />
          </div>
          <div class="form-actions">
            <button type="submit" class="btn btn-blue">💾 Save Rate</button>
            <a href="/zq-admin/suppliers/${supplier._id}/products" class="btn btn-gray">Cancel</a>
          </div>
        </form>
      </div>
    `));
  } catch (err) {
    res.send(layout("Error", `<div class="alert red">${err.message}</div>`));
  }
});

router.post("/suppliers/:id/products/edit-rate/:idx", requireSupplierAdmin, async (req, res) => {
  try {
    const { service, rate } = req.body;
    const idx = parseInt(req.params.idx, 10);
    const supplier = await SupplierProfile.findById(req.params.id);
    if (!supplier) return res.redirect("/zq-admin/suppliers");

    if (!supplier.rates || !supplier.rates[idx]) {
      return res.redirect(`/zq-admin/suppliers/${supplier._id}/products`);
    }

    const oldService = supplier.rates[idx].service;
    supplier.rates[idx].service = service.trim().toLowerCase();
    supplier.rates[idx].rate    = (rate || "").trim();
    supplier.markModified("rates");

    // Keep products[] in sync - replace old name with new name
    const prodIdx = supplier.products.indexOf(oldService);
    const newName = service.trim().toLowerCase();
    if (prodIdx >= 0) {
      supplier.products[prodIdx] = newName;
      supplier.markModified("products");
    } else if (!supplier.products.includes(newName)) {
      supplier.products.push(newName);
    }

    await supplier.save();
    res.redirect(`/zq-admin/suppliers/${supplier._id}/products`);
  } catch (err) {
    res.send(layout("Error", `<div class="alert red">${err.message}</div>`));
  }
});

// ── Delete service rate ────────────────────────────────────────────────────
router.get("/suppliers/:id/products/delete-rate/:idx", requireSupplierAdmin, async (req, res) => {
  try {
    const supplier = await SupplierProfile.findById(req.params.id);
    if (supplier?.rates) {
      supplier.rates.splice(parseInt(req.params.idx), 1);
      supplier.markModified("rates");  // ← ADD THIS
      await supplier.save();
    }
    res.redirect(`/zq-admin/suppliers/${supplier._id}/products`);
  } catch (err) {
    res.redirect(`/zq-admin/suppliers/${req.params.id}/products`);
  }
});
// ── Orders ─────────────────────────────────────────────────────────────────
router.get("/orders", requireSupplierAdmin, async (req, res) => {
  try {
    const { status = "", page = 1 } = req.query;
    const limit = 25;
    const skip = (Number(page) - 1) * limit;

    const query = {};
    if (status) query.status = status;

    const [orders, total] = await Promise.all([
      SupplierOrder.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit)
        .populate("supplierId", "businessName phone").lean(),
      SupplierOrder.countDocuments(query)
    ]);

    const pages = Math.ceil(total / limit);

    res.send(layout("Orders", `
      <div class="panel">
        <div class="panel-head">
          <h3>Orders <span class="count">${total}</span></h3>
          <form method="GET" class="filter-form">
            <select name="status" onchange="this.form.submit()">
              <option value="">All Status</option>
              ${["pending","accepted","declined","completed","cancelled","disputed"].map(s =>
                `<option ${status === s ? "selected" : ""} value="${s}">${s}</option>`
              ).join("")}
            </select>
            ${status ? `<a href="/zq-admin/orders" class="btn-reset">Clear</a>` : ""}
          </form>
        </div>
        <table>
          <thead>
            <tr><th>Ref</th><th>Supplier</th><th>Buyer</th><th>Items</th><th>Total</th><th>Status</th><th>Date</th></tr>
          </thead>
          <tbody>
            ${orders.map(o => `
            <tr>
              <td><code>#${String(o._id).slice(-6).toUpperCase()}</code></td>
              <td>${esc(o.supplierId?.businessName || o.supplierPhone)}</td>
              <td>${esc(o.buyerPhone)}</td>
              <td class="items-cell">
                ${(o.items || []).slice(0, 2).map(i => `${esc(i.product)} x${i.quantity}`).join(", ")}
                ${o.items?.length > 2 ? `<em>+${o.items.length - 2} more</em>` : ""}
              </td>
              <td>$${(o.totalAmount || 0).toFixed(2)}</td>
              <td>${badge(o.status, statusColor(o.status))}</td>
              <td>${new Date(o.createdAt).toLocaleDateString()}</td>
            </tr>`).join("")}
          </tbody>
        </table>
        ${pages > 1 ? `
        <div class="pagination">
          ${Array.from({ length: pages }, (_, i) => i + 1).map(p =>
            `<a href="/zq-admin/orders?page=${p}&status=${status}" class="${Number(page) === p ? "active" : ""}">${p}</a>`
          ).join("")}
        </div>` : ""}
      </div>
    `));
  } catch (err) {
    res.send(layout("Orders", `<div class="alert red">${err.message}</div>`));
  }
});

// ── Payments ───────────────────────────────────────────────────────────────
router.get("/payments", requireSupplierAdmin, async (req, res) => {
  try {
    const { status = "", page = 1 } = req.query;
    const limit = 30;
    const skip = (Number(page) - 1) * limit;

    const query = {};
    if (status) query.status = status;

    const [payments, total, agg] = await Promise.all([
      SupplierSubscriptionPayment.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      SupplierSubscriptionPayment.countDocuments(query),
      SupplierSubscriptionPayment.aggregate([
        { $match: { status: "paid" } },
        { $group: { _id: null, total: { $sum: "$amount" } } }
      ])
    ]);

    const totalPaid = agg[0]?.total || 0;
    const pages = Math.ceil(total / limit);

    res.send(layout("Payments", `
      <div class="panel">
        <div class="panel-head">
          <h3>Subscription Payments <span class="count">${total}</span></h3>
          <div style="display:flex;align-items:center;gap:12px">
            <strong style="color:#16a34a">Total Paid: $${totalPaid.toFixed(2)}</strong>
            <form method="GET" class="filter-form" style="margin:0">
              <select name="status" onchange="this.form.submit()">
                <option value="">All</option>
                <option ${status === "paid" ? "selected" : ""} value="paid">Paid</option>
                <option ${status === "pending" ? "selected" : ""} value="pending">Pending</option>
                <option ${status === "failed" ? "selected" : ""} value="failed">Failed</option>
              </select>
            </form>
          </div>
        </div>
        <table>
          <thead>
            <tr><th>Phone</th><th>Tier</th><th>Plan</th><th>Amount</th><th>EcoCash</th><th>Status</th><th>Date</th></tr>
          </thead>
          <tbody>
            ${payments.map(p => `
            <tr>
              <td>${esc(p.supplierPhone)}</td>
              <td>${esc(p.tier)}</td>
              <td>${esc(p.plan)}</td>
              <td>$${p.amount}</td>
              <td>${esc(p.ecocashPhone || "-")}</td>
              <td>${badge(p.status, p.status === "paid" ? "green" : p.status === "pending" ? "yellow" : "red")}</td>
              <td>${new Date(p.createdAt).toLocaleDateString()}</td>
            </tr>`).join("")}
          </tbody>
        </table>
        ${pages > 1 ? `
        <div class="pagination">
          ${Array.from({ length: pages }, (_, i) => i + 1).map(p =>
            `<a href="/zq-admin/payments?page=${p}&status=${status}" class="${Number(page) === p ? "active" : ""}">${p}</a>`
          ).join("")}
        </div>` : ""}
      </div>
    `));
  } catch (err) {
    res.send(layout("Payments", `<div class="alert red">${err.message}</div>`));
  }
});


// ── Hospitality facility tag helper (avoids nested template literals) ──────────
function facilityTag(code) {
  const labels = {
    wifi:          "📶 WiFi",
    pool:          "🏊 Pool",
    hot_shower:    "🚿 Hot shower",
    breakfast:     "🍳 Breakfast",
    en_suite:      "🚪 En-suite",
    generator:     "⚡ Generator/Solar",
    dstv:          "📺 DSTV",
    braai:         "🔥 Braai",
    aircon:        "❄️ AC",
    game_drives:   "🦁 Game drives",
    fishing:       "🎣 Fishing",
    boat_hire:     "⛵ Boat hire",
    conference:    "🏢 Conference",
    restaurant:    "🍽 Restaurant",
    laundry:       "👕 Laundry",
    parking:       "🅿️ Parking",
    pets_allowed:  "🐕 Pets OK",
    child_friendly:"👶 Child-friendly"
  };
  return "<span class=\"tag\">" + (labels[code] || code) + "</span>";
}

// ── Hospitality subtype label helper ─────────────────────────────────────────
function subtypeLabel(code) {
  const labels = {
    lodge:          "🌿 Lodge",
    hotel:          "🏨 Hotel",
    guesthouse:     "🏡 Guesthouse/B&B",
    self_catering:  "🍳 Self-Catering",
    campsite:       "⛺ Campsite",
    safari_operator:"🦁 Safari Operator",
    tour_guide:     "🗺 Tour Guide",
    boat_hire:      "⛵ Boat Hire",
    travel_agency:  "✈️ Travel Agency"
  };
  return labels[code] || code;
}

// ── Helpers ────────────────────────────────────────────────────────────────
function esc(str) {
  if (str === null || str === undefined) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function badge(text, color) {
  return `<span class="badge badge-${color}">${esc(text)}</span>`;
}

function stat(value, label, color) {
  return `<div class="stat-card ${color ? "stat-" + color : ""}">
    <div class="stat-val">${value}</div>
    <div class="stat-lbl">${label}</div>
  </div>`;
}

function statusColor(s) {
  const map = { pending: "yellow", accepted: "green", declined: "red",
                completed: "blue", cancelled: "gray", disputed: "orange" };
  return map[s] || "gray";
}

function tierColor(t) {
  const map = { basic: "gray", pro: "blue", featured: "orange" };
  return map[t] || "gray";
}

function layout(title, content) {
  // ── Derive which section is active from the page title ──────────────────────
  const t = title || "";
  const isSuppliers   = t === "Suppliers" || t === "Register Supplier"
                     || t.startsWith("Edit:") || t.startsWith("Activate:")
                     || t.startsWith("Products:") || t.startsWith("Send Offer:")
                     || t.startsWith("Receipt:") || t === "Add Price"
                     || t === "Edit Price" || t === "Add Rate"
                     || t === "Manage Live Items"
                     || t.startsWith("Hospitality:") || t === "VIP Sellers"
                     || t.startsWith("Recurring:");
  const isSchools     = t === "Schools" || t === "Register School"
                     || t.startsWith("School:") || t.startsWith("Edit School:");
  const isOrders      = t === "Orders";
  const isPayments    = t === "Payments";
 const isContacts    = t === "Contacts";
const isSearchLogs  = t === "Search Logs" || t.startsWith("Contact Search Flow:") || t === "Search Log Detail";
const isPresets     = t === "Presets" || t.startsWith("Preset:");
  const isBroadcast    = t === "Broadcast Offer";
  const isBroadcastHub = t === "Broadcast Hub";
  const isExpiry      = t === "Subscription Expiry" || t === "Expiry";
  const isDashboard   = t === "Dashboard";
  const isGroups        = t === "Group Smart Links" || t.startsWith("Group:");
  const isSchoolGroups  = t === "School Group Smart Links" || t.startsWith("School Group:");
  const isAssignSlugs   = t === "Assign Slugs";

  const nav = [
    { href: "/zq-admin",                 label: "📊 Dashboard",          active: isDashboard },
    // ── Suppliers ─────────────────────────────────────────────────────────────
    { divider: "SUPPLIERS" },
    { href: "/zq-admin/suppliers",       label: "🏪 Suppliers",           active: isSuppliers },
    { href: "/zq-admin/suppliers/new",   label: "➕ Register Supplier",   active: t === "Register Supplier" },
    { href: "/zq-admin/groups",          label: "🔗 Group Links",          active: isGroups },
    { href: "/zq-admin/school-groups",   label: "🏫 School Groups",         active: isSchoolGroups },
    { href: "/zq-admin/suppliers/assign-slugs", label: "🏷️ Assign Slugs",      active: isAssignSlugs },
    // ── Schools ───────────────────────────────────────────────────────────────
    { divider: "SCHOOLS" },
    { href: "/zq-admin/schools",         label: "🏫 Schools",             active: isSchools && t !== "Register School" },
    { href: "/zq-admin/schools/new",     label: "➕ Register School",     active: t === "Register School" },
    // ── Platform ──────────────────────────────────────────────────────────────
    { divider: "PLATFORM" },
    { href: "/zq-admin/orders",          label: "📦 Orders",              active: isOrders },
    { href: "/zq-admin/payments",        label: "💳 Payments",            active: isPayments },
   { href: "/zq-admin/contacts",        label: "👥 Contacts",            active: isContacts },
{ href: "/zq-admin/search-logs",     label: "🔎 Search Logs",         active: isSearchLogs },
{ href: "/zq-admin/expiry",          label: "⏰ Subscriptions",       active: isExpiry },
    { href: "/zq-admin/broadcast-offer", label: "📣 Broadcast Offer",  active: isBroadcast },
    { href: "/zq-admin/broadcast",       label: "📡 Broadcast Hub",     active: isBroadcastHub },
    { href: "/zq-admin/reports-hub",      label: "📊 Reports Hub",       active: t === "Reports Hub" },
    { href: "/zq-admin/presets",         label: "🗂️ Presets",             active: isPresets },
    { href: "/zq-admin/vip-sellers",      label: "🔒 VIP Sellers",         active: t === "VIP Sellers" },
  ];

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} - ZimQuote Admin</title>
<style>
:root{
  --bg:#f1f5f9;--sidebar:#0f172a;--sidebar-hover:#1e293b;
  --white:#fff;--border:#e2e8f0;--text:#1e293b;--muted:#64748b;
  --blue:#2563eb;--green:#16a34a;--red:#dc2626;--orange:#ea580c;
  --yellow:#a16207;--purple:#7c3aed;--teal:#0d9488;
  --sidebar-w:220px;
}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:system-ui,-apple-system,sans-serif;background:var(--bg);color:var(--text);font-size:14px}

/* ── Sidebar ────────────────────────────────────────────────────────────── */
.sidebar{
  position:fixed;left:0;top:0;bottom:0;width:var(--sidebar-w);
  background:var(--sidebar);display:flex;flex-direction:column;
  z-index:200;transition:transform .25s ease;overflow-y:auto;
}
.sidebar-brand{
  padding:18px 20px;font-size:17px;font-weight:700;color:white;
  border-bottom:1px solid #1e293b;letter-spacing:-.3px;
  display:flex;align-items:center;justify-content:space-between;
}
.sidebar-brand span{color:#60a5fa}
.sidebar-close{
  display:none;background:none;border:none;color:#94a3b8;
  font-size:20px;cursor:pointer;line-height:1;padding:2px 4px;
}
.sidebar-nav{flex:1;padding:6px 0}
.nav-divider{
  padding:10px 20px 4px;font-size:10px;font-weight:700;
  color:#334155;letter-spacing:1px;text-transform:uppercase;
}
.sidebar-nav a{
  display:flex;align-items:center;gap:9px;padding:10px 20px;
  color:#94a3b8;text-decoration:none;font-size:13px;transition:all .15s;
}
.sidebar-nav a:hover,.sidebar-nav a.active{
  background:var(--sidebar-hover);color:white;
}
.sidebar-footer{padding:14px 20px;border-top:1px solid #1e293b;flex-shrink:0}
.sidebar-footer form button{
  background:none;border:none;color:#94a3b8;
  cursor:pointer;font-size:13px;padding:0;
}
.sidebar-footer form button:hover{color:white}

/* ── Mobile top bar ─────────────────────────────────────────────────────── */
.topbar{
  display:none;position:sticky;top:0;z-index:150;
  background:var(--sidebar);padding:12px 16px;
  align-items:center;gap:12px;
}
.topbar-brand{font-size:16px;font-weight:700;color:white;flex:1}
.topbar-brand span{color:#60a5fa}
.hamburger{
  background:none;border:none;cursor:pointer;
  display:flex;flex-direction:column;gap:5px;padding:4px;
}
.hamburger span{
  display:block;width:22px;height:2px;background:#94a3b8;
  border-radius:2px;transition:background .15s;
}
.hamburger:hover span{background:white}

/* ── Overlay (mobile) ───────────────────────────────────────────────────── */
.overlay{
  display:none;position:fixed;inset:0;background:rgba(0,0,0,.5);
  z-index:190;
}
.overlay.open{display:block}

/* ── Main content ───────────────────────────────────────────────────────── */
.main{margin-left:var(--sidebar-w);padding:24px;min-height:100vh}
.page-title{font-size:22px;font-weight:700;margin-bottom:20px;color:var(--text)}

/* ── Stats ──────────────────────────────────────────────────────────────── */
.stats-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:12px;margin-bottom:20px}
.stat-card{background:var(--white);padding:18px;border-radius:10px;
           box-shadow:0 1px 3px rgba(0,0,0,.08);border-left:3px solid #e2e8f0}
.stat-green{border-left-color:#22c55e}.stat-orange{border-left-color:#f97316}
.stat-blue{border-left-color:#3b82f6}.stat-yellow{border-left-color:#eab308}
.stat-purple{border-left-color:#a855f7}.stat-teal{border-left-color:#14b8a6}
.stat-red{border-left-color:#ef4444}
.stat-val{font-size:26px;font-weight:700;line-height:1}
.stat-lbl{font-size:12px;color:var(--muted);margin-top:5px}

/* ── Panels ─────────────────────────────────────────────────────────────── */
.panel{background:var(--white);border-radius:10px;padding:20px;
       box-shadow:0 1px 3px rgba(0,0,0,.08);margin-bottom:16px}
.panel h3{font-size:15px;font-weight:700;margin-bottom:14px}
.panel-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;flex-wrap:wrap;gap:8px}
.panel-head h3{margin:0}
.two-col{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px}

/* ── Tables ─────────────────────────────────────────────────────────────── */
table{width:100%;border-collapse:collapse;font-size:13px}
th{text-align:left;padding:9px 12px;background:#f8fafc;border-bottom:2px solid var(--border);
   color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.5px;white-space:nowrap}
td{padding:9px 12px;border-bottom:1px solid #f1f5f9;vertical-align:middle}
tr:last-child td{border-bottom:none}
tr:hover td{background:#fafbfc}
.items-cell{max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

/* ── Badges ─────────────────────────────────────────────────────────────── */
.badge{display:inline-flex;align-items:center;padding:3px 9px;border-radius:20px;
       font-size:11px;font-weight:700;text-transform:capitalize}
.badge-green{background:#dcfce7;color:#16a34a}
.badge-red{background:#fee2e2;color:#dc2626}
.badge-gray{background:#f1f5f9;color:#475569}
.badge-blue{background:#dbeafe;color:#1d4ed8}
.badge-yellow{background:#fef9c3;color:#a16207}
.badge-orange{background:#ffedd5;color:#c2410c}
.badge-teal{background:#ccfbf1;color:#0f766e}
.badge-purple{background:#f3e8ff;color:#7c3aed}
.count{background:#f1f5f9;color:#64748b;padding:2px 8px;border-radius:20px;font-size:12px;margin-left:6px}

/* ── Buttons ─────────────────────────────────────────────────────────────── */
.btn{display:inline-block;padding:9px 18px;border:none;border-radius:7px;font-size:13px;
     font-weight:600;cursor:pointer;text-decoration:none;transition:opacity .15s}
.btn:hover{opacity:.88}
.btn-blue{background:var(--blue);color:white}
.btn-green{background:#22c55e;color:white}
.btn-red{background:#ef4444;color:white}
.btn-orange{background:#f97316;color:white}
.btn-purple{background:#7c3aed;color:white}
.btn-gray{background:#e2e8f0;color:#475569}
.btn-sm{padding:5px 12px;font-size:12px}
.btn-link{color:var(--blue);text-decoration:none;font-size:13px;font-weight:600}
.btn-link:hover{text-decoration:underline}
.btn-reset{color:var(--muted);text-decoration:none;font-size:13px}

/* ── Forms ───────────────────────────────────────────────────────────────── */
.filter-form{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.filter-form input,.filter-form select{
  padding:7px 11px;border:1px solid var(--border);border-radius:6px;font-size:13px;outline:none}
.filter-form input:focus,.filter-form select:focus{border-color:var(--blue)}
.filter-form button{padding:7px 14px;background:var(--blue);color:white;
  border:none;border-radius:6px;cursor:pointer;font-size:13px}
.edit-form .form-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:14px}
.fg{display:flex;flex-direction:column;gap:5px}
.fg.full{margin-bottom:12px}
.fg label{font-size:12px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.4px}
.fg input,.fg select,.fg textarea{
  padding:9px 11px;border:1px solid var(--border);border-radius:7px;font-size:13px;outline:none}
.fg input:focus,.fg select:focus,.fg textarea:focus{border-color:var(--blue)}
.fg textarea{resize:vertical}
.form-actions{display:flex;gap:10px;margin-top:16px;flex-wrap:wrap}

/* ── Detail list ─────────────────────────────────────────────────────────── */
.detail-list{display:grid;grid-template-columns:140px 1fr;gap:1px}
.detail-list dt{font-size:12px;font-weight:600;color:var(--muted);
  padding:8px 0;border-bottom:1px solid #f8fafc;text-transform:uppercase;letter-spacing:.3px}
.detail-list dd{padding:8px 0;border-bottom:1px solid #f8fafc;font-size:13px}
.admin-note{background:#fefce8;padding:6px 10px;border-radius:6px;font-style:italic;color:#854d0e}

/* ── Tags / misc ─────────────────────────────────────────────────────────── */
.tag-cloud{display:flex;flex-wrap:wrap;gap:6px}
.tag{background:#e0f2fe;color:#0369a1;padding:4px 10px;border-radius:20px;font-size:12px}
.type-pill{background:#f3e8ff;color:#7c3aed;padding:3px 9px;border-radius:20px;font-size:11px;font-weight:600}
.action-row{display:flex;gap:8px;flex-wrap:wrap;margin-top:16px;padding-top:16px;border-top:1px solid var(--border)}
.back-link{display:inline-block;margin-bottom:16px;color:var(--blue);text-decoration:none;font-size:13px}
.back-link:hover{text-decoration:underline}
.alert.red{background:#fee2e2;color:#dc2626;padding:14px;border-radius:8px}
.muted{color:var(--muted)}
.pagination{display:flex;gap:4px;margin-top:14px;flex-wrap:wrap}
.pagination a{padding:5px 11px;border:1px solid var(--border);border-radius:6px;
  text-decoration:none;color:var(--muted);font-size:13px}
.pagination a.active{background:var(--blue);color:white;border-color:var(--blue)}
code{background:#f1f5f9;padding:2px 6px;border-radius:4px;font-size:12px;font-family:monospace}

/* ── Mobile responsive ───────────────────────────────────────────────────── */
@media(max-width:768px){
  /* Show hamburger topbar, hide desktop sidebar */
  .topbar{display:flex}
  .sidebar-close{display:block}
  /* Sidebar slides in from left */
  .sidebar{transform:translateX(-100%)}
  .sidebar.open{transform:translateX(0)}
  /* Main takes full width */
  .main{margin-left:0;padding:16px}
  .page-title{font-size:18px}
  /* Layout adjustments */
  .two-col,.edit-form .form-grid{grid-template-columns:1fr}
  .stats-grid{grid-template-columns:repeat(2,1fr)}
  .panel-head{flex-direction:column;align-items:flex-start}
  .action-row{gap:6px}
  /* Make tables scroll horizontally */
  .table-wrap{overflow-x:auto;-webkit-overflow-scrolling:touch}
  table{min-width:500px}
}
@media(min-width:769px){
  .sidebar{transform:none !important}
  .overlay{display:none !important}
}
</style>
</head>
<body>

<!-- ── Mobile top bar ──────────────────────────────────────────────────────── -->
<div class="topbar">
  <button class="hamburger" onclick="openSidebar()" aria-label="Open menu">
    <span></span><span></span><span></span>
  </button>
  <div class="topbar-brand">⚡ <span>Zim</span>Quote</div>
</div>

<!-- ── Overlay (closes sidebar on mobile tap) ──────────────────────────────── -->
<div class="overlay" id="overlay" onclick="closeSidebar()"></div>

<!-- ── Sidebar ─────────────────────────────────────────────────────────────── -->
<nav class="sidebar" id="sidebar">
  <div class="sidebar-brand">
    ⚡ <span>Zim</span>Quote
    <button class="sidebar-close" onclick="closeSidebar()" aria-label="Close menu">✕</button>
  </div>
  <div class="sidebar-nav">
    ${nav.map(n => {
      if (n.divider) return `<div class="nav-divider">${n.divider}</div>`;
      return `<a href="${n.href}" ${n.active ? 'class="active"' : ""}>${n.label}</a>`;
    }).join("")}
  </div>
  <div class="sidebar-footer">
    <form method="POST" action="/zq-admin/logout">
      <button>🚪 Logout</button>
    </form>
  </div>
</nav>

<!-- ── Main content ────────────────────────────────────────────────────────── -->
<main class="main">
  <div class="page-title">${esc(title)}</div>
  ${content}
</main>

<script>
function openSidebar(){
  document.getElementById("sidebar").classList.add("open");
  document.getElementById("overlay").classList.add("open");
  document.body.style.overflow="hidden";
}
function closeSidebar(){
  document.getElementById("sidebar").classList.remove("open");
  document.getElementById("overlay").classList.remove("open");
  document.body.style.overflow="";
}
// Close sidebar when a nav link is tapped on mobile
document.querySelectorAll(".sidebar-nav a").forEach(a=>{
  a.addEventListener("click",()=>{ if(window.innerWidth<=768) closeSidebar(); });
});
</script>
</body>
</html>`;
}





// ─── PRESET MANAGEMENT ROUTES ─────────────────────────────────────────────────

// ── GET /zq-admin/presets ────────────────────────────────────────────────────
router.get("/presets", requireSupplierAdmin, async (req, res) => {
  try {
    const dbPresets = await CategoryPreset.find().lean();
    const dbMap = Object.fromEntries(dbPresets.map(p => [p.catId, p]));
    const staticPresets = getPresetCategories();
    const staticMap = Object.fromEntries(staticPresets.map(p => [p.id, p]));

    const allCats = SUPPLIER_CATEGORIES.map(cat => {
      const db = dbMap[cat.id];
      const stat = staticMap[cat.id];
      return {
        id: cat.id,
        label: cat.label,
        types: cat.types,
        hasSubcats: !!(cat.subcats?.length),
        hasPreset: !!(db?.isActive) || !!(stat),
        source: db ? "database" : stat ? "static" : "none",
        productCount: db ? db.products.length : (stat?.productCount || 0),
        priceCount: db ? db.prices.length : (stat?.priceCount || 0),
        isActive: db ? db.isActive : !!(stat),
        adminNote: db?.adminNote || "",
        updatedAt: db?.updatedAt || null,
        updatedBy: db?.updatedBy || ""
      };
    });

    const productCats = allCats.filter(c => c.types?.includes("product"));
    const serviceCats = allCats.filter(c => c.types?.includes("service"));

    const productRows = productCats.map(cat => `
      <tr>
        <td><strong>${esc(cat.label)}</strong><br><small style="color:#888">${esc(cat.id)}</small></td>
        <td>${cat.hasSubcats ? "✅" : "-"}</td>
        <td>${cat.productCount > 0 ? cat.productCount + " items" : "<em style='color:#aaa'>None</em>"}</td>
        <td>${cat.priceCount > 0 ? cat.priceCount + " prices" : "<em style='color:#aaa'>None</em>"}</td>
        <td>${badge(cat.source === "database" ? "DB" : cat.source === "static" ? "Static" : "None",
               cat.source === "database" ? "blue" : cat.source === "static" ? "yellow" : "gray")}</td>
        <td>${cat.hasPreset
          ? badge(cat.isActive ? "✅ Active" : "⏸ Off", cat.isActive ? "green" : "gray")
          : "<em style='color:#aaa'>No preset</em>"}</td>
        <td><small>${cat.updatedAt ? new Date(cat.updatedAt).toLocaleDateString() : "-"}</small></td>
        <td>
          <a href="/zq-admin/presets/${esc(cat.id)}" class="btn-link">Edit →</a>
          ${cat.hasPreset ? `&nbsp;<button onclick="togglePreset('${esc(cat.id)}')" class="btn-sm btn-${cat.isActive ? "orange" : "green"}">${cat.isActive ? "Disable" : "Enable"}</button>` : ""}
        </td>
      </tr>`).join("");

    const serviceRows = serviceCats.map(cat => `
      <tr>
        <td><strong>${esc(cat.label)}</strong><br><small style="color:#888">${esc(cat.id)}</small></td>
        <td>${cat.hasSubcats ? "✅" : "-"}</td>
        <td>${cat.productCount > 0 ? cat.productCount + " services" : "<em style='color:#aaa'>None</em>"}</td>
        <td>${cat.priceCount > 0 ? cat.priceCount + " rates" : "<em style='color:#aaa'>None</em>"}</td>
        <td>${badge(cat.source === "database" ? "DB" : cat.source === "static" ? "Static" : "None",
               cat.source === "database" ? "blue" : cat.source === "static" ? "yellow" : "gray")}</td>
        <td>${cat.hasPreset
          ? badge(cat.isActive ? "✅ Active" : "⏸ Off", cat.isActive ? "green" : "gray")
          : "<em style='color:#aaa'>No preset</em>"}</td>
        <td><small>${cat.updatedAt ? new Date(cat.updatedAt).toLocaleDateString() : "-"}</small></td>
        <td>
          <a href="/zq-admin/presets/${esc(cat.id)}" class="btn-link">Edit →</a>
          ${cat.hasPreset ? `&nbsp;<button onclick="togglePreset('${esc(cat.id)}')" class="btn-sm btn-${cat.isActive ? "orange" : "green"}">${cat.isActive ? "Disable" : "Enable"}</button>` : ""}
        </td>
      </tr>`).join("");

    res.send(layout("Presets", `
      <div class="panel">
        <div class="panel-head">
          <h3>📦 Product Category Presets</h3>
          <span style="font-size:12px;color:var(--muted)">Green = shown to suppliers during registration</span>
        </div>
        <table>
          <thead><tr><th>Category</th><th>Sub-cats</th><th>Products</th><th>Prices</th><th>Source</th><th>Status</th><th>Updated</th><th></th></tr></thead>
          <tbody>${productRows}</tbody>
        </table>
      </div>

      <div class="panel">
        <div class="panel-head">
          <h3>🔧 Service Category Presets</h3>
        </div>
        <table>
          <thead><tr><th>Category</th><th>Sub-cats</th><th>Services</th><th>Rates</th><th>Source</th><th>Status</th><th>Updated</th><th></th></tr></thead>
          <tbody>${serviceRows}</tbody>
        </table>
      </div>

      <script>
        async function togglePreset(catId) {
          const r = await fetch('/zq-admin/presets/' + catId + '/toggle', { method: 'PATCH' });
          const d = await r.json();
          if (d.success) location.reload();
        }
      </script>
    `));
  } catch (err) {
    res.send(layout("Presets", `<div class="alert red">Error: ${err.message}</div>`));
  }
});

// ── GET /zq-admin/presets/:catId ─────────────────────────────────────────────
router.get("/presets/:catId", requireSupplierAdmin, async (req, res) => {
  try {
    const { catId } = req.params;
    const catDef = SUPPLIER_CATEGORIES.find(c => c.id === catId);
    if (!catDef) return res.redirect("/zq-admin/presets");

    let preset = await CategoryPreset.findOne({ catId }).lean();
    let source = "database";

    if (!preset) {
      const staticTemplate = TEMPLATES[catId];
      source = staticTemplate ? "static" : "none";
      preset = {
        catId,
        label: catDef.label,
        profileType: catDef.types[0],
        products: staticTemplate?.products || [],
        prices: staticTemplate?.prices || [],
        subcatMap: staticTemplate?.subcatMap
          ? Object.entries(staticTemplate.subcatMap).map(([lbl, prods]) => ({ label: lbl, products: prods }))
          : [],
        isActive: !!staticTemplate,
        adminNote: staticTemplate?.adminNote || ""
      };
    }

    const subcatDefs = catDef.subcats || [];
    const productListText = (preset.products || []).join("\n");
    const pricesJson = JSON.stringify(preset.prices || [], null, 2);

    const subcatSections = subcatDefs.map(sub => {
      const existing = (preset.subcatMap || []).find(s => s.label === sub.label);
      const existing_products = existing ? existing.products.join("\n") : "";
      return `
        <div class="fg full" style="margin-bottom:14px">
          <label>${esc(sub.label)}</label>
          <textarea name="subcat_${esc(sub.id)}" rows="3" style="font-size:12px"
            placeholder="Product names in this sub-cat, one per line">${esc(existing_products)}</textarea>
        </div>`;
    }).join("");

    res.send(layout(`Preset: ${esc(catDef.label)}`, `
      <a href="/zq-admin/presets" class="back-link">← Back to Presets</a>

      <div class="panel">
        <div class="panel-head">
          <h3>Edit Preset - ${esc(catDef.label)}</h3>
          <div style="font-size:12px;color:var(--muted)">
            ID: <code>${esc(catId)}</code> &nbsp;|&nbsp;
            Type: ${(catDef.types || []).join(", ")} &nbsp;|&nbsp;
            Source: ${badge(source.toUpperCase(), source === "database" ? "blue" : source === "static" ? "yellow" : "gray")}
          </div>
        </div>

        <div class="stats" style="display:flex;gap:12px;margin-bottom:20px">
          <div class="stat" style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:12px 20px;text-align:center">
            <div style="font-size:24px;font-weight:700" id="stat-products">${preset.products?.length || 0}</div>
            <div style="font-size:12px;color:var(--muted)">Products</div>
          </div>
          <div class="stat" style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:12px 20px;text-align:center">
            <div style="font-size:24px;font-weight:700" id="stat-prices">${preset.prices?.length || 0}</div>
            <div style="font-size:12px;color:var(--muted)">With Prices</div>
          </div>
          <div class="stat" style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:12px 20px;text-align:center">
            <div style="font-size:24px;font-weight:700">${subcatDefs.length}</div>
            <div style="font-size:12px;color:var(--muted)">Sub-cats</div>
          </div>
        </div>

        <form id="presetForm">
          <div style="display:flex;align-items:center;gap:10px;margin-bottom:16px">
            <input type="checkbox" id="isActive" ${preset.isActive ? "checked" : ""}>
            <label for="isActive" style="margin:0;font-weight:600">Active - shown to suppliers during registration</label>
          </div>

          <div class="fg full" style="margin-bottom:14px">
            <label>Admin Note (internal only)</label>
            <input type="text" id="adminNote" value="${esc(preset.adminNote || "")}"
              placeholder="e.g. Zimbabwe market prices Jan 2025"
              style="padding:8px;border:1px solid #ddd;border-radius:6px;font-size:13px;width:100%">
          </div>

          <div class="fg full" style="margin-bottom:14px">
            <label>Products / Services (one per line)</label>
            <small style="color:var(--muted);display:block;margin-bottom:6px">Each line = one item shown to the supplier in the preview</small>
            <textarea id="productsArea" rows="20" style="font-family:monospace;font-size:12px;padding:10px;border:1px solid #ddd;border-radius:6px;width:100%">${esc(productListText)}</textarea>
          </div>

          <div class="fg full" style="margin-bottom:14px">
            <label>Suggested Prices (JSON)</label>
            <small style="color:var(--muted);display:block;margin-bottom:6px">
              Format: <code>[{"product":"name","amount":5.50,"unit":"each"}, ...]</code>
              Product name must match exactly what's in the list above.
            </small>
            <textarea id="pricesJson" rows="12" style="font-family:monospace;font-size:11px;padding:10px;border:1px solid #ddd;border-radius:6px;width:100%">${esc(pricesJson)}</textarea>
          </div>

          ${subcatDefs.length ? `
          <div style="margin-bottom:14px">
            <label style="font-weight:bold;display:block;margin-bottom:8px">Sub-category Grouping</label>
            <small style="color:var(--muted);display:block;margin-bottom:10px">Assign products to sub-categories for admin display. Product names must match the list above.</small>
            ${subcatSections}
          </div>` : ""}

          <div id="save-status" style="display:none;padding:10px 16px;border-radius:6px;margin-bottom:12px;font-size:13px"></div>

          <div style="display:flex;gap:10px">
            <button type="button" onclick="savePreset()" class="btn btn-blue">💾 Save Preset</button>
            <a href="/zq-admin/presets" class="btn btn-gray">Cancel</a>
            <button type="button" onclick="deletePreset()" class="btn btn-red" style="margin-left:auto">🗑 Delete Preset</button>
          </div>
        </form>
      </div>

      <script>
        const SUBCAT_IDS = ${JSON.stringify(subcatDefs.map(s => s.id))};
        const SUBCAT_LABELS = ${JSON.stringify(subcatDefs.reduce((m, s) => { m[s.id] = s.label; return m; }, {}))};

        async function savePreset() {
          const status = document.getElementById('save-status');
          const products = document.getElementById('productsArea').value;
          let prices = [];
          try { prices = JSON.parse(document.getElementById('pricesJson').value); }
          catch(e) { showStatus('❌ Prices JSON is invalid: ' + e.message, false); return; }

          const subcatMap = [];
          SUBCAT_IDS.forEach(id => {
            const el = document.querySelector('[name="subcat_' + id + '"]');
            if (!el) return;
            const prods = el.value.split('\\n').map(s=>s.trim()).filter(Boolean);
            if (prods.length) subcatMap.push({ label: SUBCAT_LABELS[id], products: prods });
          });

          const payload = {
            products,
            prices,
            subcatMap,
            isActive: document.getElementById('isActive').checked,
            adminNote: document.getElementById('adminNote').value,
            profileType: '${esc(catDef.types[0])}'
          };

          try {
            const r = await fetch(window.location.pathname, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(payload)
            });
            const d = await r.json();
            if (d.success) {
              showStatus('✅ Saved! ' + d.productCount + ' products, ' + d.priceCount + ' prices.', true);
              document.getElementById('stat-products').textContent = d.productCount;
              document.getElementById('stat-prices').textContent = d.priceCount;
            } else {
              showStatus('❌ Error: ' + d.error, false);
            }
          } catch(e) {
            showStatus('❌ Network error: ' + e.message, false);
          }
        }

        async function deletePreset() {
          if (!confirm('Delete this preset? Suppliers will no longer see "Use Preset List" for this category.')) return;
          const r = await fetch(window.location.pathname, { method: 'DELETE' });
          const d = await r.json();
          if (d.success) window.location.href = '/zq-admin/presets';
        }

        function showStatus(msg, ok) {
          const el = document.getElementById('save-status');
          el.style.display = 'block';
          el.style.background = ok ? '#d1fae5' : '#fee2e2';
          el.style.color = ok ? '#065f46' : '#991b1b';
          el.textContent = msg;
        }
      </script>
    `));
  } catch (err) {
    res.send(layout("Presets", `<div class="alert red">Error: ${err.message}</div>`));
  }
});

// ── POST /zq-admin/presets/:catId ────────────────────────────────────────────
router.post("/presets/:catId", requireSupplierAdmin, async (req, res) => {
  try {
    const { catId } = req.params;
    const catDef = SUPPLIER_CATEGORIES.find(c => c.id === catId);
    if (!catDef) return res.status(404).json({ error: "Category not found" });

    // Products come as a newline-separated string
    const rawProducts = (req.body.products || "")
      .split(/\n/)
      .map(p => p.trim())
      .filter(Boolean);

    // Prices come as an already-parsed array (express.json() handles this)
    const prices = Array.isArray(req.body.prices) ? req.body.prices : [];

    // SubcatMap comes as array of {label, products[]}
    const subcatMap = Array.isArray(req.body.subcatMap) ? req.body.subcatMap : [];

    const updated = await CategoryPreset.findOneAndUpdate(
      { catId },
      {
        $set: {
          catId,
          label: catDef.label,
          profileType: req.body.profileType || catDef.types[0],
          products: rawProducts,
          prices,
          subcatMap,
          isActive: req.body.isActive === true || req.body.isActive === "true",
          adminNote: (req.body.adminNote || "").trim(),
          updatedBy: "admin",
          updatedAt: new Date()
        }
      },
      { upsert: true, new: true }
    );

    // Update in-memory static templates immediately (no server restart needed)
    setTemplateForCategory(catId, {
      isAdminPreset: true,
      adminNote: updated.adminNote,
      products: updated.products,
      prices: updated.prices,
      subcatMap: updated.subcatMap?.length
        ? Object.fromEntries(updated.subcatMap.map(s => [s.label, s.products]))
        : null
    });

    res.json({ success: true, catId, productCount: rawProducts.length, priceCount: prices.length });
  } catch (err) {
    console.error("[Admin Preset Save]", err);
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE /zq-admin/presets/:catId ──────────────────────────────────────────
router.delete("/presets/:catId", requireSupplierAdmin, async (req, res) => {
  try {
    await CategoryPreset.deleteOne({ catId: req.params.catId });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PATCH /zq-admin/presets/:catId/toggle ────────────────────────────────────
router.patch("/presets/:catId/toggle", requireSupplierAdmin, async (req, res) => {
  try {
    const preset = await CategoryPreset.findOne({ catId: req.params.catId });
    if (!preset) return res.status(404).json({ error: "Preset not found in DB. Save it first before toggling." });
    preset.isActive = !preset.isActive;
    await preset.save();
    res.json({ success: true, isActive: preset.isActive });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});





router.get("/suppliers/:id/live-items", requireSupplierAdmin, async (req, res) => {
  const supplier = await SupplierProfile.findById(req.params.id).lean();
  if (!supplier) return res.redirect("/zq-admin/suppliers");

  const capMap = { basic: 20, pro: 60, featured: 150 };
  const cap = capMap[supplier.tier] || 20;

  const uploaded = supplier.products || [];
  const live = supplier.listedProducts || [];

  res.send(layout("Manage Live Items", `
    <a href="/zq-admin/suppliers/${supplier._id}" class="back-link">← Back</a>

    <div class="panel">
      <h3>${supplier.businessName}</h3>

      <p><strong>Tier:</strong> ${supplier.tier || "basic"}</p>
      <p><strong>Live:</strong> ${live.length} / ${cap}</p>
      <p><strong>Uploaded:</strong> ${uploaded.length}</p>

      ${uploaded.length ? `
      <form method="POST" action="/zq-admin/suppliers/${supplier._id}/live-items">

        <p><strong>Select up to ${cap} items:</strong></p>

        <div style="max-height:400px;overflow:auto;border:1px solid #ddd;padding:10px;">
          ${uploaded.map((p, i) => `
            <label style="display:block;margin-bottom:6px;">
              <input type="checkbox" name="items" value="${p}"
                ${live.includes(p) ? "checked" : ""}>
              ${i + 1}. ${p}
            </label>
          `).join("")}
        </div>

        <button type="submit" class="btn btn-blue" style="margin-top:12px;">
          💾 Save Live Items
        </button>
      </form>
      ` : `<em>No uploaded items</em>`}
    </div>
  `));
});















// ── Contacts (Phone Numbers / Users) ──────────────────────────────────────
router.get("/contacts", requireSupplierAdmin, async (req, res) => {
  try {
    const { search = "", period = "", page = 1 } = req.query;
    const limit = 30;
    const skip  = (Number(page) - 1) * limit;

    // ── Date range for "period" filter ─────────────────────────────────────
    const now   = new Date();
    let dateFrom = null;
    if (period === "today") {
      dateFrom = new Date(now); dateFrom.setHours(0,0,0,0);
    } else if (period === "week") {
      dateFrom = new Date(now); dateFrom.setDate(now.getDate() - 7);
    } else if (period === "month") {
      dateFrom = new Date(now); dateFrom.setDate(now.getDate() - 30);
    }

    // ── Build query ─────────────────────────────────────────────────────────
    const query = {};
    if (search) {
      query.$or = [
        { phone:        { $regex: search, $options: "i" } },
        { firstMessage: { $regex: search, $options: "i" } },
        { channel:      { $regex: search, $options: "i" } }
      ];
    }
    if (dateFrom) query.createdAt = { $gte: dateFrom };

    // ── Stats (always unfiltered for accuracy) ──────────────────────────────
    const todayStart  = new Date(now); todayStart.setHours(0,0,0,0);
    const weekStart   = new Date(now); weekStart.setDate(now.getDate() - 7);
    const monthStart  = new Date(now); monthStart.setDate(now.getDate() - 30);

    const [
      total, todayCount, weekCount, monthCount,
      contacts
    ] = await Promise.all([
      PhoneContact.countDocuments(),
      PhoneContact.countDocuments({ createdAt: { $gte: todayStart } }),
      PhoneContact.countDocuments({ createdAt: { $gte: weekStart } }),
      PhoneContact.countDocuments({ createdAt: { $gte: monthStart } }),
      PhoneContact.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit).lean()
    ]);

    const filteredTotal = await PhoneContact.countDocuments(query);
    const pages = Math.ceil(filteredTotal / limit);
    const qs = (p) => `?page=${p}&search=${encodeURIComponent(search)}&period=${period}`;

    res.send(layout("Contacts", `

      <!-- ── Stats row ─────────────────────────────────────────────── -->
      <div class="stats-grid" style="margin-bottom:20px">
        ${stat(total,       "Total Contacts",     "")}
        ${stat(todayCount,  "New Today",          "green")}
        ${stat(weekCount,   "New This Week",      "blue")}
        ${stat(monthCount,  "New This Month",     "teal")}
      </div>

      <div class="panel">
        <div class="panel-head">
          <h3>Phone Contacts <span class="count">${filteredTotal}</span></h3>
          <form method="GET" class="filter-form">
            <input
              name="search"
              placeholder="Search phone or message..."
              value="${esc(search)}"
              style="min-width:200px"
            />
            <select name="period">
              <option value="">All Time</option>
              <option ${period === "today" ? "selected" : ""}  value="today">Today</option>
              <option ${period === "week"  ? "selected" : ""}  value="week">Last 7 Days</option>
              <option ${period === "month" ? "selected" : ""}  value="month">Last 30 Days</option>
            </select>
            <button type="submit">Filter</button>
            <a href="/zq-admin/contacts" class="btn-reset">Clear</a>
          </form>
        </div>

        <!-- ── Mobile-friendly table wrapper ────────────────────── -->
        <div style="overflow-x:auto;-webkit-overflow-scrolling:touch">
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>Phone</th>
                <th>First Message</th>
                <th>Channel</th>
                <th>First Seen</th>
                <th>Last Active</th>
              </tr>
            </thead>
            <tbody>
              ${contacts.length ? contacts.map((c, i) => `
              <tr>
                <td style="color:var(--muted);font-size:11px">${skip + i + 1}</td>
                <td>
                  <strong style="font-size:13px">${esc(c.phone)}</strong>
                </td>
                <td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--muted)">
                  ${c.firstMessage ? esc(c.firstMessage).slice(0, 60) : "<em>-</em>"}
                </td>
                <td>
                  <span class="badge badge-blue" style="font-size:10px">${esc(c.channel || "whatsapp")}</span>
                </td>
                <td style="white-space:nowrap;font-size:12px">
                  ${new Date(c.firstSeen || c.createdAt).toLocaleDateString("en-GB", {
                    day: "numeric", month: "short", year: "2-digit",
                    hour: "2-digit", minute: "2-digit"
                  })}
                </td>
                <td style="white-space:nowrap;font-size:12px;color:var(--muted)">
                  ${new Date(c.updatedAt || c.createdAt).toLocaleDateString("en-GB", {
                    day: "numeric", month: "short", year: "2-digit"
                  })}
                </td>
              </tr>`).join("") : `
              <tr>
                <td colspan="6" style="text-align:center;padding:32px;color:var(--muted)">
                  No contacts found.
                </td>
              </tr>`}
            </tbody>
          </table>
        </div>

        <!-- ── Pagination ─────────────────────────────────────────── -->
        ${pages > 1 ? `
        <div class="pagination">
          ${Number(page) > 1 ? `<a href="${qs(Number(page) - 1)}">← Prev</a>` : ""}
          ${Array.from({ length: Math.min(pages, 10) }, (_, i) => i + 1).map(p =>
            `<a href="${qs(p)}" class="${Number(page) === p ? "active" : ""}">${p}</a>`
          ).join("")}
          ${Number(page) < pages ? `<a href="${qs(Number(page) + 1)}">Next →</a>` : ""}
        </div>
        <p style="font-size:12px;color:var(--muted);margin-top:8px">
          Showing ${skip + 1}–${Math.min(skip + limit, filteredTotal)} of ${filteredTotal}
        </p>` : ""}
      </div>
    `));
  } catch (err) {
    res.send(layout("Contacts", `<div class="alert red">Error: ${err.message}</div>`));
  }
});

router.post("/suppliers/:id/live-items", requireSupplierAdmin, async (req, res) => {
  const supplier = await SupplierProfile.findById(req.params.id);
  if (!supplier) return res.redirect("/zq-admin/suppliers");

  const capMap = { basic: 20, pro: 60, featured: 150 };
  const cap = capMap[supplier.tier] || 20;

  let items = req.body.items || [];
  if (!Array.isArray(items)) items = [items];

  // clean + dedupe
  const cleaned = [...new Set(items.map(i => String(i).trim()).filter(Boolean))];

  if (cleaned.length > cap) {
    return res.send("❌ Cannot exceed plan limit (" + cap + ")");
  }

  supplier.listedProducts = cleaned;
  await supplier.save();

  res.redirect(`/zq-admin/suppliers/${supplier._id}/live-items`);
});
///////////////////////////////////

// ─────────────────────────────────────────────────────────────────────────────
// PATCH: New routes to add to routes/supplierAdmin.js
//
// INSERT POINT: Add all routes below BEFORE the final `
// ═════════════════════════════════════════════════════════════════════════════
// SCHOOL DELETE ROUTES
// ─────────────────────────────────────────────────────────────────────────────
// COPY these two routes into your school admin router file (schoolAdmin.js or
// wherever your /zq-admin/schools/:id routes live).
//
// Also add this Delete button to your school detail page action-row:
//
//   <form method="POST" action="/zq-admin/schools/${school._id}/delete" style="display:inline"
//         onsubmit="return confirm('Permanently delete ${school.schoolName}? This cannot be undone.')">
//     <button class="btn btn-red">🗑 Delete School</button>
//   </form>
//
// And add this to your schools list table row:
//
//   <a href="/zq-admin/schools/${s._id}/delete-confirm"
//      class="btn-link" style="color:#ef4444">Delete</a>
//
// What gets deleted:
//   SchoolProfile         → the school listing itself
//   Business              → linked business account (if any)
//   UserRole              → owner role for this phone
//   Branch                → all branches for this business
//   Product               → all catalogue items
//   UserSession           → clears active session
// ═════════════════════════════════════════════════════════════════════════════


// ─────────────────────────────────────────────────────────────────────────────
// SCHOOL ADMIN SYSTEM
// Routes: GET /schools/:id · POST /schools/:id/apply-toggle
//         POST /schools/:id/apply-settings · GET /schools/:id/apply-qr
//         GET /schools/:id/contacts · GET /schools/:id/contacts/export
//         POST /schools/:id/contacts/:cid/status
// ─────────────────────────────────────────────────────────────────────────────
const _SCHOOL_BOT = (process.env.WHATSAPP_BOT_NUMBER || "263771143904").replace(/\D/g,"");
const _schProfileLink = id => `https://wa.me/${_SCHOOL_BOT}?text=${encodeURIComponent("ZQ:SCHOOL:"+id)}`;
const _schApplyLink   = id => `https://wa.me/${_SCHOOL_BOT}?text=${encodeURIComponent("APPLY:SCHOOL:"+id)}`;
const _schQr = (data,size=300,col="1a3c5e") => `https://api.qrserver.com/v1/create-qr-code/?size=${size}x${size}&data=${encodeURIComponent(data)}&color=${col}&bgcolor=FFFFFF&qzone=2`;

// GET /zq-admin/schools/:id - school profile + settings


router.get("/schools/:id", requireSupplierAdmin, async (req, res) => {
  // Guard: validate ObjectId before querying - "new" and other non-ID strings would cause CastError
  const mongoose = (await import("mongoose")).default;
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
    return res.redirect("/zq-admin/schools");
  }
  try {
    const SchoolProfile = (await import("../models/schoolProfile.js")).default;
    const school = await SchoolProfile.findById(req.params.id).lean();
    if (!school) return res.redirect("/zq-admin/schools");
    let cStats = { total:0, applied:0, enquiries:0, linkOpens:0, convRate:"0%" };
    try {
      const SC = (await import("../models/schoolContact.js")).default;
      const cs = await SC.find({ schoolId: school._id }).lean();
      cStats.total     = cs.length;
      cStats.applied   = cs.filter(c=>c.converted).length;
      cStats.enquiries = cs.filter(c=>c.source==="enquiry").length;
      cStats.linkOpens = cs.reduce((s,c)=>s+(c.viewCount||1),0);
      cStats.convRate  = cStats.total ? Math.round((cStats.applied/cStats.total)*100)+"%": "0%";
    } catch(_){}
    const form       = school.applicationForm || {};
    const profLink   = _schProfileLink(String(school._id));
    const applyLink  = _schApplyLink(String(school._id));
    const profQr     = _schQr(profLink,220,"085041");
    const applyQr    = _schQr(applyLink,220,"1a3c5e");
    const webQr      = school.registrationLink ? _schQr(school.registrationLink,220,"7c3aed") : null;
    const ok         = req.query.success||"";
    const er         = req.query.error||"";
    res.send(layout(`${esc(school.schoolName)} - Admin`, `
<style>
.sg{display:grid;grid-template-columns:1fr 1fr;gap:18px;margin-bottom:22px}
@media(max-width:660px){.sg{grid-template-columns:1fr}}
.sc{background:white;border-radius:12px;padding:20px;box-shadow:0 1px 3px rgba(0,0,0,.08);text-align:center}
.sk{display:grid;grid-template-columns:repeat(5,1fr);gap:12px;margin-bottom:22px}
@media(max-width:660px){.sk{grid-template-columns:repeat(3,1fr)}}
.sm{background:white;border-radius:10px;padding:14px;text-align:center;box-shadow:0 1px 3px rgba(0,0,0,.06)}
.sn{font-size:26px;font-weight:800}.sl{font-size:11px;color:var(--muted);margin-top:2px}
.toggle{position:relative;width:44px;height:24px;display:inline-block}
.toggle input{opacity:0;width:0;height:0}
.slid{position:absolute;cursor:pointer;inset:0;background:#ccc;border-radius:24px;transition:.3s}
.slid:before{position:absolute;content:"";height:18px;width:18px;left:3px;bottom:3px;background:white;border-radius:50%;transition:.3s}
input:checked+.slid{background:#16a34a}
input:checked+.slid:before{transform:translateX(20px)}
</style>
<div style="background:white;border-radius:14px;padding:20px 22px;margin-bottom:20px;box-shadow:0 1px 4px rgba(0,0,0,.08);border:1px solid #e2e8f0">
  <div style="display:flex;align-items:flex-start;justify-content:space-between;flex-wrap:wrap;gap:12px">
    <div style="flex:1;min-width:200px">
      <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:6px">
        <h1 style="font-size:20px;font-weight:800;margin:0">${esc(school.schoolName)}</h1>
        ${school.verified?`<span style="background:#fef9c3;color:#92400e;padding:2px 10px;border-radius:20px;font-size:12px;font-weight:700">✅ Verified</span>`:""}
        <span style="background:${school.active?"#dcfce7":"#f1f5f9"};color:${school.active?"#16a34a":"#94a3b8"};padding:2px 10px;border-radius:20px;font-size:12px;font-weight:700">${school.active?"🟢 Active":"⚫ Inactive"}</span>
      </div>
      <p style="margin:0;color:var(--muted);font-size:13px;line-height:1.5">
        📍 ${esc([school.address,school.suburb,school.city].filter(Boolean).join(", "))}
        ${school.phone?` &nbsp;·&nbsp; 📞 ${esc(school.phone)}`:""}
        ${school.email?` &nbsp;·&nbsp; 📧 ${esc(school.email)}`:""}
      </p>
      <p style="margin:4px 0 0;color:var(--muted);font-size:12px">
        ${[school.schoolType,school.ownership,school.curriculum?.join("+")].filter(Boolean).map(s=>s.toUpperCase()).join(" · ")}
        ${school.fees?.term1?` &nbsp;·&nbsp; 💰 $${school.fees.term1}/term`:""}
      </p>
    </div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-start">
      <a href="/zq-admin/schools/${esc(String(school._id))}/contacts" class="btn btn-sm" style="background:#dbeafe;color:#1d4ed8">👥 Contacts&nbsp;(${cStats.total})</a>
      <a href="/apply/school/${esc(String(school._id))}" target="_blank" class="btn btn-sm" style="background:#f0fdf4;color:#16a34a">🌐 Web Form</a>
      <a href="/zq-admin/schools/${esc(String(school._id))}/apply-qr" class="btn btn-sm" style="background:#eff6ff;color:#1d4ed8">📲 QR Codes</a>
      <a href="/zq-admin/schools/${esc(String(school._id))}/delete-confirm" class="btn btn-sm btn-red">🗑</a>
    </div>
  </div>
</div>
${ok?`<div style="background:#f0fdf4;border:1px solid #bbf7d0;color:#166534;padding:10px 14px;border-radius:8px;margin-bottom:14px">✅ ${esc(ok)}</div>`:""}
${er?`<div style="background:#fef2f2;border:1px solid #fecaca;color:#dc2626;padding:10px 14px;border-radius:8px;margin-bottom:14px">❌ ${esc(er)}</div>`:""}
<div class="sk">
  <div class="sm"><div class="sn" style="color:#0ea5e9">${cStats.linkOpens}</div><div class="sl">Link Opens</div></div>
  <div class="sm"><div class="sn" style="color:#1d4ed8">${cStats.total}</div><div class="sl">Contacts</div></div>
  <div class="sm"><div class="sn" style="color:#16a34a">${cStats.applied}</div><div class="sl">Applications</div></div>
  <div class="sm"><div class="sn" style="color:#7c3aed">${cStats.enquiries}</div><div class="sl">Enquiries</div></div>
  <div class="sm"><div class="sn" style="color:#d97706">${cStats.convRate}</div><div class="sl">Conv. Rate</div></div>
</div>
<div class="sg">
  <div class="sc"><div style="font-size:12px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px">School Profile QR</div>
    <div style="background:#f0fdf4;border-radius:10px;padding:10px;display:inline-block;margin-bottom:10px"><img src="${esc(profQr)}" width="140" height="140"></div>
    <p style="font-size:11px;color:var(--muted);margin-bottom:10px">Scan → browse school profile</p>
    <div style="display:flex;gap:6px;justify-content:center">
      <a href="${esc(_schQr(profLink,600,"085041"))}" download="profile-qr.png" target="_blank" class="btn btn-sm">⬇ Download</a>
      <a href="${esc(profLink)}" target="_blank" class="btn btn-sm" style="background:#dcfce7;color:#16a34a">📱 Test</a>
    </div>
  </div>
  <div class="sc"><div style="font-size:12px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px">Application Form QR</div>
    <div style="background:#eff6ff;border-radius:10px;padding:10px;display:inline-block;margin-bottom:10px"><img src="${esc(applyQr)}" width="140" height="140"></div>
    <p style="font-size:11px;color:var(--muted);margin-bottom:10px">Scan → goes directly to apply form</p>
    <div style="display:flex;gap:6px;justify-content:center">
      <a href="${esc(_schQr(applyLink,600,"1a3c5e"))}" download="apply-qr.png" target="_blank" class="btn btn-sm">⬇ Download</a>
      <a href="${esc(applyLink)}" target="_blank" class="btn btn-sm" style="background:#dbeafe;color:#1d4ed8">📱 Test</a>
    </div>
  </div>
</div>
<div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:10px;padding:14px 18px;margin-bottom:22px">
  <div style="font-size:12px;font-weight:700;color:#16a34a;margin-bottom:8px">🌐 Web Application Form - share this link with parents</div>
  <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:6px">
    <code style="font-size:12px;background:white;padding:7px 10px;border-radius:6px;border:1px solid #bbf7d0;flex:1;word-break:break-all">https://cripfcnt.com/apply/school/${esc(String(school._id))}</code>
    <a href="/apply/school/${esc(String(school._id))}" target="_blank" class="btn btn-sm" style="background:#dcfce7;color:#16a34a;white-space:nowrap">🔗 Open</a>
  </div>
  <p style="font-size:11px;color:#166534;line-height:1.5">
    Share on <strong>Facebook, school website, WhatsApp groups, email</strong> - parents open it in their browser, fill the form, and submission goes directly to your email. 
    No login needed. Works on any phone.
  </p>
  <p style="font-size:11px;color:#94a3b8;margin-top:4px">
    ⚠️ Make sure <code>schoolApplyRouter.js</code> is mounted at root in server.js:
    <code>app.use("/", schoolApplyRouter)</code>
  </p>
</div>
<!-- ── Existing Brochures ──────────────────────────────────────────────────── -->
${(()=>{
  const _brs = school.brochures || [];
  const _af  = school.applicationForm || {};
  const _hasAny = _brs.length || _af.brochureUrl || _af.rawFormUrl;
  if (!_hasAny) return "";
  return `
  <div style="background:white;border-radius:12px;padding:20px;box-shadow:0 1px 3px rgba(0,0,0,.08);margin-bottom:22px">
    <h2 style="font-size:15px;font-weight:700;margin:0 0 14px">📄 Uploaded Documents</h2>
    ${_brs.length ? `
    <table style="width:100%;border-collapse:collapse;margin-bottom:14px;font-size:13px">
      <thead><tr style="background:#f8fafc">
        <th style="padding:8px 12px;text-align:left;border-bottom:1px solid var(--border)">Label</th>
        <th style="padding:8px 12px;text-align:left;border-bottom:1px solid var(--border)">Link</th>
        <th style="padding:8px 12px;text-align:left;border-bottom:1px solid var(--border)">Added</th>
      </tr></thead>
      <tbody>
        ${_brs.map((b,i)=>`<tr>
          <td style="padding:8px 12px;border-bottom:1px solid var(--border)"><strong>${esc(b.label||"Brochure")}</strong></td>
          <td style="padding:8px 12px;border-bottom:1px solid var(--border)"><a href="${esc(b.url)}" target="_blank" style="color:#1d4ed8">View / Download →</a></td>
          <td style="padding:8px 12px;border-bottom:1px solid var(--border);color:var(--muted);font-size:11px">${b.addedAt?new Date(b.addedAt).toLocaleDateString():""}</td>
        </tr>`).join("")}
      </tbody>
    </table>` : ""}
    ${_af.brochureUrl ? `<div style="font-size:13px;margin-bottom:8px">📄 <strong>Brochure (Application Settings):</strong> <a href="${esc(_af.brochureUrl)}" target="_blank" style="color:#1d4ed8">${esc(_af.brochureName||"View →")}</a></div>` : ""}
    ${_af.rawFormUrl  ? `<div style="font-size:13px">📋 <strong>Printable Form (Application Settings):</strong> <a href="${esc(_af.rawFormUrl)}" target="_blank" style="color:#1d4ed8">${esc(_af.rawFormName||"Download →")}</a></div>` : ""}
  </div>`;
})()}

<div style="background:white;border-radius:12px;padding:22px;box-shadow:0 1px 3px rgba(0,0,0,.08);margin-bottom:22px">
  <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:18px;flex-wrap:wrap;gap:10px">
    <div><h2 style="font-size:15px;font-weight:700;margin:0">Application Form Settings</h2>
      <p style="font-size:12px;color:var(--muted);margin-top:3px">Configure per-school application form</p>
    </div>
    <form method="POST" action="/zq-admin/schools/${esc(String(school._id))}/apply-toggle" style="display:flex;align-items:center;gap:8px">
      <label class="toggle"><input type="checkbox" ${form.active?"checked":""} onchange="this.form.submit()"><span class="slid"></span></label>
      <span style="font-size:13px;font-weight:600;color:${form.active?"#16a34a":"#94a3b8"}">${form.active?"✅ Form Active":"⚫ Form Inactive"}</span>
    </form>
  </div>
  <form method="POST" action="/zq-admin/schools/${esc(String(school._id))}/apply-settings">
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:14px">
      <div><label style="display:block;font-size:12px;font-weight:600;margin-bottom:4px">Intake Year / Label</label>
        <input name="intakeYear" value="${esc(form.intakeYear||"")}" placeholder="e.g. 2027 Form 1 Intake" style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;font-size:13px">
        <p style="font-size:11px;color:var(--muted);margin-top:3px">Shown at top of form (e.g. 2027 Form 1 Intake)</p></div>
      <div><label style="display:block;font-size:12px;font-weight:600;margin-bottom:4px">Notify Email (receives applications)</label>
        <input name="notifyEmail" type="email" value="${esc(form.notifyEmail||school.email||"")}" placeholder="admin@school.co.zw" style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;font-size:13px">
        <p style="font-size:11px;color:var(--muted);margin-top:3px">Applications sent from info@zimquote.co.zw to this address</p></div>
      <div><label style="display:block;font-size:12px;font-weight:600;margin-bottom:4px">Notify WhatsApp (link open alerts)</label>
        <input name="notifyPhone" value="${esc(form.notifyPhone||school.phone||"")}" placeholder="0771234567" style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;font-size:13px">
        <p style="font-size:11px;color:var(--muted);margin-top:3px">Gets WhatsApp alert with visitor's number when someone opens apply link</p></div>
      <div><label style="display:block;font-size:12px;font-weight:600;margin-bottom:4px">External Form URL (optional)</label>
        <input name="registrationLink" value="${esc(school.registrationLink||"")}" placeholder="https://forms.gle/..." style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;font-size:13px">
        <p style="font-size:11px;color:var(--muted);margin-top:3px">Google Form / school website. Shown alongside WhatsApp form.</p></div>
    </div>
    <div style="margin-bottom:14px"><label style="display:block;font-size:12px;font-weight:600;margin-bottom:4px">Grade Options (comma-separated)</label>
      <input name="gradeOptions" value="${esc((form.gradeOptions||[]).join(", "))}" placeholder="Form 1, Form 2, Form 3, Form 4, Form 5, Form 6" style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;font-size:13px">
      <p style="font-size:11px;color:var(--muted);margin-top:3px">Shown to parents when completing the application form</p></div>
    <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:16px;margin-bottom:16px">
      <div style="font-size:12px;font-weight:700;margin-bottom:12px;color:#374151">📄 Brochure / Flyer (sent to parents when they open the apply link)</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px">
        <div>
          <label style="display:block;font-size:12px;font-weight:600;margin-bottom:4px">Upload File (PDF, image)</label>
          <input type="file" id="schBrochureFile" accept=".pdf,.jpg,.jpeg,.png,.webp" style="width:100%;padding:6px;border:1px solid var(--border);border-radius:6px;font-size:12px;background:white">
          <p style="font-size:11px;color:var(--muted);margin-top:3px">Upload PDF or image directly - or paste a URL below</p>
          <div id="schUploadStatus" style="font-size:12px;margin-top:6px;display:none"></div>
        </div>
        <div>
          <label style="display:block;font-size:12px;font-weight:600;margin-bottom:4px">Brochure Filename (what parents see)</label>
          <input name="brochureName" id="schBrochureName" value="${esc(form.brochureName||"School_Brochure.pdf")}" style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;font-size:13px">
        </div>
      </div>
      <div>
        <label style="display:block;font-size:12px;font-weight:600;margin-bottom:4px">Brochure URL (paste Google Drive / Dropbox public link, or uploaded above)</label>
        <input name="brochureUrl" id="schBrochureUrl" value="${esc(form.brochureUrl||"")}" placeholder="https://..." style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;font-size:13px">
        ${form.brochureUrl?`<p style="font-size:11px;color:#16a34a;margin-top:4px">✅ Brochure set - <a href="${esc(form.brochureUrl)}" target="_blank" style="color:#1d4ed8">Preview</a></p>`:'<p style="font-size:11px;color:var(--muted);margin-top:3px">Sent automatically to parents when they open the apply form</p>'}
      </div>
    </div>
    <div style="background:#fff7ed;border:1px solid #fed7aa;border-radius:10px;padding:16px;margin-bottom:16px">
      <div style="font-size:12px;font-weight:700;margin-bottom:12px;color:#374151">📋 Raw Application Form (printable PDF parents can download)</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px">
        <div>
          <label style="display:block;font-size:12px;font-weight:600;margin-bottom:4px">Upload Application Form (PDF)</label>
          <input type="file" id="schRawFormFile" accept=".pdf" style="width:100%;padding:6px;border:1px solid var(--border);border-radius:6px;font-size:12px;background:white">
          <div id="schRawUploadStatus" style="font-size:12px;margin-top:6px;display:none"></div>
        </div>
        <div>
          <label style="display:block;font-size:12px;font-weight:600;margin-bottom:4px">Form Filename (what parents see)</label>
          <input name="rawFormName" id="schRawFormName" value="${esc(form.rawFormName||"Application_Form.pdf")}" style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;font-size:13px">
        </div>
      </div>
      <div>
        <label style="display:block;font-size:12px;font-weight:600;margin-bottom:4px">Raw Form URL</label>
        <input name="rawFormUrl" id="schRawFormUrl" value="${esc(form.rawFormUrl||"")}" placeholder="https://..." style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;font-size:13px">
        ${form.rawFormUrl?`<p style="font-size:11px;color:#16a34a;margin-top:4px">✅ Form set - <a href="${esc(form.rawFormUrl)}" target="_blank" style="color:#1d4ed8">Preview / Download</a></p>`:'<p style="font-size:11px;color:var(--muted);margin-top:3px">Parents see a "Download Form" button when they open your apply link</p>'}
      </div>
    </div>
    <button type="submit" class="btn btn-blue">💾 Save Settings</button>
  </form>
  <script>
  (function(){
    // Raw form upload
    const rawFile = document.getElementById("schRawFormFile");
    const rawUrl  = document.getElementById("schRawFormUrl");
    const rawName = document.getElementById("schRawFormName");
    const rawSt   = document.getElementById("schRawUploadStatus");
    if(rawFile) rawFile.addEventListener("change", async function(){
      const file = this.files[0];
      if(!file) return;
      rawSt.style.display = ""; rawSt.style.color = "#2563eb";
      rawSt.textContent = "⏳ Uploading " + file.name + "…";
      try {
        const fd = new FormData(); fd.append("broadcastFile", file);
        const r = await fetch("/zq-admin/broadcast/upload",{method:"POST",body:fd});
        const d = await r.json();
        if(d.url){ rawUrl.value=d.url; rawName.value=file.name; rawSt.style.color="#16a34a"; rawSt.textContent="✅ Uploaded. Save Settings to apply."; }
        else { rawSt.style.color="#dc2626"; rawSt.textContent="❌ "+(d.error||"Upload failed"); }
      } catch(e){ rawSt.style.color="#dc2626"; rawSt.textContent="❌ "+e.message; }
    });

    const fileInput = document.getElementById("schBrochureFile");
    const urlInput  = document.getElementById("schBrochureUrl");
    const nameInput = document.getElementById("schBrochureName");
    const status    = document.getElementById("schUploadStatus");
    if(!fileInput) return;
    fileInput.addEventListener("change", async function(){
      const file = this.files[0];
      if(!file) return;
      status.style.display = "";
      status.style.color   = "#2563eb";
      status.textContent   = "⏳ Uploading " + file.name + "…";
      try {
        const fd = new FormData();
        fd.append("broadcastFile", file);
        const r  = await fetch("/zq-admin/broadcast/upload", { method:"POST", body:fd });
        const d  = await r.json();
        if(d.url) {
          urlInput.value  = d.url;
          nameInput.value = file.name;
          status.style.color   = "#16a34a";
          status.textContent   = "✅ Uploaded: " + file.name + " - Save Settings to apply.";
        } else {
          status.style.color  = "#dc2626";
          status.textContent  = "❌ Upload failed: " + (d.error||"unknown error");
        }
      } catch(e) {
        status.style.color  = "#dc2626";
        status.textContent  = "❌ Upload error: " + e.message;
      }
    });
  })();
  </script>
</div>

<div style="background:white;border-radius:12px;padding:24px;box-shadow:0 1px 3px rgba(0,0,0,.08);margin-bottom:22px;border:1px solid #e2e8f0">
  <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;flex-wrap:wrap;gap:10px">
    <div>
      <h2 style="font-size:15px;font-weight:700;margin:0">✏️ Edit School Profile</h2>
      <p style="font-size:12px;color:var(--muted);margin-top:3px">Update school information, status, and verification</p>
    </div>
    <div style="display:flex;gap:8px;flex-wrap:wrap">
      <form method="POST" action="/zq-admin/schools/${esc(String(school._id))}/toggle-active" style="margin:0">
        <button type="submit" class="btn btn-sm" style="background:${school.active?"#fef2f2":"#f0fdf4"};color:${school.active?"#dc2626":"#16a34a"};border:1.5px solid ${school.active?"#fca5a5":"#bbf7d0"}">
          ${school.active?"⏸ Deactivate":"✅ Activate"}
        </button>
      </form>
      <form method="POST" action="/zq-admin/schools/${esc(String(school._id))}/toggle-verified" style="margin:0">
        <button type="submit" class="btn btn-sm" style="background:${school.verified?"#fffbeb":"#eff6ff"};color:${school.verified?"#b45309":"#1d4ed8"};border:1.5px solid ${school.verified?"#fde68a":"#bfdbfe"}">
          ${school.verified?"❌ Remove Verify":"✅ Verify School"}
        </button>
      </form>
    </div>
  </div>

  <form method="POST" action="/zq-admin/schools/${esc(String(school._id))}/edit">
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:16px">
      <div>
        <label style="display:block;font-size:12px;font-weight:600;margin-bottom:4px;color:#374151">School Name</label>
        <input name="schoolName" value="${esc(school.schoolName||"")}" required style="width:100%;padding:9px 11px;border:1.5px solid var(--border);border-radius:7px;font-size:13px">
      </div>
      <div>
        <label style="display:block;font-size:12px;font-weight:600;margin-bottom:4px;color:#374151">Phone Number</label>
        <input name="phone" value="${esc(school.phone||"")}" style="width:100%;padding:9px 11px;border:1.5px solid var(--border);border-radius:7px;font-size:13px" placeholder="e.g. 263773256276">
      </div>
      <div>
        <label style="display:block;font-size:12px;font-weight:600;margin-bottom:4px;color:#374151">Email</label>
        <input name="email" type="email" value="${esc(school.email||"")}" style="width:100%;padding:9px 11px;border:1.5px solid var(--border);border-radius:7px;font-size:13px">
      </div>
      <div>
        <label style="display:block;font-size:12px;font-weight:600;margin-bottom:4px;color:#374151">Website</label>
        <input name="website" value="${esc(school.website||"")}" style="width:100%;padding:9px 11px;border:1.5px solid var(--border);border-radius:7px;font-size:13px" placeholder="e.g. www.stangela.ac.zw">
      </div>
      <div>
        <label style="display:block;font-size:12px;font-weight:600;margin-bottom:4px;color:#374151">Suburb / Area</label>
        <input name="suburb" value="${esc(school.suburb||school.location?.area||"")}" style="width:100%;padding:9px 11px;border:1.5px solid var(--border);border-radius:7px;font-size:13px" placeholder="e.g. Borrowdale">
      </div>
      <div>
        <label style="display:block;font-size:12px;font-weight:600;margin-bottom:4px;color:#374151">City</label>
        <select name="city" style="width:100%;padding:9px 11px;border:1.5px solid var(--border);border-radius:7px;font-size:13px;background:white">
          ${["Harare","Bulawayo","Mutare","Gweru","Masvingo","Kwekwe","Kadoma","Chinhoyi","Victoria Falls","Bindura","Marondera","Chegutu","Zvishavane","Kariba"].map(c=>`<option value="${c}"${(school.city||"")==c?" selected":""}>${c}</option>`).join("")}
        </select>
      </div>
      <div style="grid-column:1/-1">
        <label style="display:block;font-size:12px;font-weight:600;margin-bottom:4px;color:#374151">Street Address</label>
        <input name="address" value="${esc(school.address||"")}" style="width:100%;padding:9px 11px;border:1.5px solid var(--border);border-radius:7px;font-size:13px" placeholder="e.g. 433 Wheeldon Ave, Borrowdale">
      </div>
    </div>

    <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:14px;margin-bottom:16px">
      <div>
        <label style="display:block;font-size:12px;font-weight:600;margin-bottom:4px;color:#374151">School Type</label>
        <select name="schoolType" style="width:100%;padding:9px 11px;border:1.5px solid var(--border);border-radius:7px;font-size:13px;background:white">
          <option value="">- Select -</option>
          ${[["ecd","ECD / Pre-School"],["primary","Primary"],["secondary","Secondary"],["combined","Combined"]].map(([v,l])=>`<option value="${v}"${(school.schoolType||"")==v?" selected":""}>${l}</option>`).join("")}
        </select>
      </div>
      <div>
        <label style="display:block;font-size:12px;font-weight:600;margin-bottom:4px;color:#374151">Ownership</label>
        <select name="ownership" style="width:100%;padding:9px 11px;border:1.5px solid var(--border);border-radius:7px;font-size:13px;background:white">
          <option value="">- Select -</option>
          ${[["government","Government"],["mission","Mission"],["private","Private"],["council","Council"]].map(([v,l])=>`<option value="${v}"${(school.ownership||"")==v?" selected":""}>${l}</option>`).join("")}
        </select>
      </div>
      <div>
        <label style="display:block;font-size:12px;font-weight:600;margin-bottom:4px;color:#374151">Gender</label>
        <select name="gender" style="width:100%;padding:9px 11px;border:1.5px solid var(--border);border-radius:7px;font-size:13px;background:white">
          ${[["mixed","Mixed (Co-ed)"],["boys","Boys Only"],["girls","Girls Only"]].map(([v,l])=>`<option value="${v}"${(school.gender||"")==v?" selected":""}>${l}</option>`).join("")}
        </select>
      </div>
      <div>
        <label style="display:block;font-size:12px;font-weight:600;margin-bottom:4px;color:#374151">Curriculum</label>
        <input name="curriculum" value="${esc((school.curriculum||[]).join(", "))}" style="width:100%;padding:9px 11px;border:1.5px solid var(--border);border-radius:7px;font-size:13px" placeholder="e.g. cambridge, zimsec">
        <p style="font-size:11px;color:var(--muted);margin-top:3px">Comma-separated: cambridge, zimsec, ib</p>
      </div>
      <div>
        <label style="display:block;font-size:12px;font-weight:600;margin-bottom:4px;color:#374151">Fees - Term 1 ($)</label>
        <input name="fees_term1" type="number" value="${school.fees?.term1||""}" style="width:100%;padding:9px 11px;border:1.5px solid var(--border);border-radius:7px;font-size:13px" placeholder="e.g. 800">
      </div>
      <div>
        <label style="display:block;font-size:12px;font-weight:600;margin-bottom:4px;color:#374151">Fees - Term 2 ($)</label>
        <input name="fees_term2" type="number" value="${school.fees?.term2||""}" style="width:100%;padding:9px 11px;border:1.5px solid var(--border);border-radius:7px;font-size:13px" placeholder="e.g. 800">
      </div>
    </div>

    <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:16px">
      <div>
        <label style="display:block;font-size:12px;font-weight:600;margin-bottom:4px;color:#374151">Fees - Term 3 ($)</label>
        <input name="fees_term3" type="number" value="${school.fees?.term3||""}" style="width:100%;padding:9px 11px;border:1.5px solid var(--border);border-radius:7px;font-size:13px" placeholder="e.g. 800">
      </div>
      <div>
        <label style="display:block;font-size:12px;font-weight:600;margin-bottom:4px;color:#374151">Principal Name</label>
        <input name="principalName" value="${esc(school.principalName||"")}" style="width:100%;padding:9px 11px;border:1.5px solid var(--border);border-radius:7px;font-size:13px" placeholder="e.g. Mrs T. Mutasa">
      </div>
      <div>
        <label style="display:block;font-size:12px;font-weight:600;margin-bottom:4px;color:#374151">Contact Phone (public)</label>
        <input name="contactPhone" value="${esc(school.contactPhone||"")}" style="width:100%;padding:9px 11px;border:1.5px solid var(--border);border-radius:7px;font-size:13px" placeholder="e.g. 0773256276">
      </div>
      <div>
        <label style="display:block;font-size:12px;font-weight:600;margin-bottom:4px;color:#374151">Boarding</label>
        <select name="boarding" style="width:100%;padding:9px 11px;border:1.5px solid var(--border);border-radius:7px;font-size:13px;background:white">
          ${[["day","Day School"],["boarding","Boarding"],["both","Day & Boarding"]].map(([v,l])=>`<option value="${v}"${(school.boarding||"day")==v?" selected":""}>${l}</option>`).join("")}
        </select>
      </div>
      <div style="grid-column:1/-1">
        <label style="display:block;font-size:12px;font-weight:600;margin-bottom:4px;color:#374151">School Description</label>
        <textarea name="description" rows="3" style="width:100%;padding:9px 11px;border:1.5px solid var(--border);border-radius:7px;font-size:13px;resize:vertical;font-family:inherit" placeholder="Brief description shown to parents...">${esc(school.description||"")}</textarea>
      </div>
    </div>

    <!-- ── Facilities ────────────────────────────────────────────────────── -->
    <div style="margin-bottom:20px">
      <div style="font-size:12px;font-weight:700;color:#374151;margin-bottom:10px;padding-bottom:6px;border-bottom:1.5px solid var(--border)">🏊 Facilities (tick all that apply)</div>
      <div id="facilitiesGrid" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:6px">
        ${(()=>{
          const FACS=[
            {id:"swimming_pool",label:"Swimming Pool"},{id:"science_lab",label:"Science Lab"},
            {id:"computer_lab",label:"Computer Lab"},{id:"library",label:"Library"},
            {id:"sports_field",label:"Sports Field"},{id:"gymnasium",label:"Gymnasium"},
            {id:"cafeteria",label:"Cafeteria"},{id:"transport",label:"School Transport"},
            {id:"wifi",label:"WiFi / Internet"},{id:"boarding_house",label:"Boarding House"},
            {id:"chapel",label:"Chapel"},{id:"music_room",label:"Music Room"},
            {id:"art_room",label:"Art Room"},{id:"tennis_court",label:"Tennis Court"},
            {id:"basketball_court",label:"Basketball Court"},{id:"drama_theatre",label:"Drama / Theatre"},
            {id:"photography_lab",label:"Photography Lab"},{id:"nursery",label:"Nursery / Crèche"},
            {id:"special_needs",label:"Special Needs Support"}
          ];
          const current = school.facilities || [];
          return FACS.map(f=>`
            <label style="display:flex;align-items:center;gap:6px;font-size:13px;padding:5px 8px;background:${current.includes(f.id)?"#eff6ff":"white"};border:1px solid var(--border);border-radius:6px;cursor:pointer">
              <input type="checkbox" name="facilities" value="${esc(f.id)}" ${current.includes(f.id)?"checked":""} style="width:14px;height:14px">
              ${esc(f.label)}
            </label>`).join("");
        })()}
      </div>
    </div>

    <!-- ── Extramural Activities ────────────────────────────────────────── -->
    <div style="margin-bottom:20px">
      <div style="font-size:12px;font-weight:700;color:#374151;margin-bottom:10px;padding-bottom:6px;border-bottom:1.5px solid var(--border)">🏃 Extramural Activities</div>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:6px">
        ${(()=>{
          const ACTS=[
            {id:"swimming",label:"Swimming"},{id:"football",label:"Football"},
            {id:"rugby",label:"Rugby"},{id:"cricket",label:"Cricket"},
            {id:"netball",label:"Netball"},{id:"basketball",label:"Basketball"},
            {id:"tennis",label:"Tennis"},{id:"athletics",label:"Athletics"},
            {id:"chess",label:"Chess"},{id:"debate",label:"Debate"},
            {id:"science_club",label:"Science Club"},{id:"music",label:"Music"},
            {id:"drama",label:"Drama"},{id:"art",label:"Art"},
            {id:"dance",label:"Dance"},{id:"computer_club",label:"Computer Club"},
            {id:"environmental_club",label:"Environmental Club"},{id:"rotary_interact",label:"Rotary Interact"}
          ];
          const current = school.extramuralActivities || [];
          return ACTS.map(a=>`
            <label style="display:flex;align-items:center;gap:6px;font-size:13px;padding:5px 8px;background:${current.includes(a.id)?"#f0fdf4":"white"};border:1px solid var(--border);border-radius:6px;cursor:pointer">
              <input type="checkbox" name="extramuralActivities" value="${esc(a.id)}" ${current.includes(a.id)?"checked":""} style="width:14px;height:14px">
              ${esc(a.label)}
            </label>`).join("");
        })()}
      </div>
    </div>

    <!-- ── Notification Contacts ────────────────────────────────────────── -->
    <div style="margin-bottom:20px">
      <div style="font-size:12px;font-weight:700;color:#374151;margin-bottom:6px;padding-bottom:6px;border-bottom:1.5px solid var(--border)">
        📲 Notification Contacts
        <span style="font-weight:400;font-size:11px;color:var(--muted)"> - Extra numbers that receive WhatsApp alerts when parents open school links</span>
      </div>
      <div id="notifContactsList" style="display:flex;flex-direction:column;gap:8px;margin-bottom:10px">
        ${(school.notificationContacts||[]).map((p,i)=>`
          <div style="display:flex;gap:8px;align-items:center">
            <input name="notifContact_${i}" value="${esc(p)}" placeholder="e.g. 2637712345678"
                   style="flex:1;padding:9px 11px;border:1.5px solid var(--border);border-radius:7px;font-size:13px">
            <button type="button" onclick="this.closest('div').remove()"
                    style="padding:6px 12px;border:1.5px solid #dc2626;border-radius:6px;color:#dc2626;background:none;cursor:pointer;font-size:13px">✕</button>
          </div>`).join("")}
      </div>
      <input type="hidden" name="notifContactCount" id="notifContactCount" value="${(school.notificationContacts||[]).length}">
      <button type="button" onclick="addNotifContact()"
              style="padding:7px 14px;border:1.5px solid #1d4ed8;border-radius:6px;color:#1d4ed8;background:none;cursor:pointer;font-size:13px">
        ➕ Add number
      </button>
      <p style="font-size:11px;color:var(--muted);margin-top:6px">
        Use international format: 2637XXXXXXXX. The primary phone always receives notifications too.
      </p>
    </div>

    <button type="submit" class="btn btn-blue" style="padding:10px 24px">💾 Save School Profile</button>
  </form>
  <script>
  function addNotifContact() {
    const list = document.getElementById("notifContactsList");
    const count = document.getElementById("notifContactCount");
    const idx = parseInt(count.value, 10);
    const div = document.createElement("div");
    div.style.cssText = "display:flex;gap:8px;align-items:center";
    div.innerHTML = \`<input name="notifContact_\${idx}" placeholder="e.g. 2637712345678"
      style="flex:1;padding:9px 11px;border:1.5px solid var(--border);border-radius:7px;font-size:13px">
      <button type="button" onclick="this.closest('div').remove()"
        style="padding:6px 12px;border:1.5px solid #dc2626;border-radius:6px;color:#dc2626;background:none;cursor:pointer;font-size:13px">✕</button>\`;
    list.appendChild(div);
    count.value = idx + 1;
  }
  </script>
</div>

<a href="/zq-admin/schools" class="back-link">← All Schools</a>
    `));
  } catch(err){ res.send(layout("Error",`<div class="alert red">${esc(err.message)}</div>`)); }
});

// POST /schools/:id/toggle-active
router.post("/schools/:id/toggle-active", requireSupplierAdmin, async(req,res) => {
  try {
    const SP = (await import("../models/schoolProfile.js")).default;
    const sc = await SP.findById(req.params.id).lean();
    if(!sc) return res.redirect("/zq-admin/schools");
    await SP.findByIdAndUpdate(req.params.id, { $set: { active: !sc.active } });
    res.redirect(`/zq-admin/schools/${req.params.id}?success=${encodeURIComponent(!sc.active ? "School activated - now visible to parents." : "School deactivated - hidden from search.")}`);
  } catch(err) { res.redirect(`/zq-admin/schools/${req.params.id}?error=${encodeURIComponent(err.message)}`); }
});

// POST /schools/:id/toggle-verified
router.post("/schools/:id/toggle-verified", requireSupplierAdmin, async(req,res) => {
  try {
    const SP = (await import("../models/schoolProfile.js")).default;
    const sc = await SP.findById(req.params.id).lean();
    if(!sc) return res.redirect("/zq-admin/schools");
    await SP.findByIdAndUpdate(req.params.id, { $set: { verified: !sc.verified } });
    res.redirect(`/zq-admin/schools/${req.params.id}?success=${encodeURIComponent(!sc.verified ? "School verified ✅ - badge now shown to parents." : "Verification removed.")}`);
  } catch(err) { res.redirect(`/zq-admin/schools/${req.params.id}?error=${encodeURIComponent(err.message)}`); }
});

// POST /schools/:id/edit
router.post("/schools/:id/edit", requireSupplierAdmin, async(req,res) => {
  try {
    const SP = (await import("../models/schoolProfile.js")).default;
    const { schoolName, phone, email, website, suburb, city, address,
            schoolType, ownership, gender, curriculum, fees_term1, fees_term2, fees_term3,
            principalName, contactPhone, boarding, description } = req.body;
    // Parse facilities and extramural checkboxes
    const { facilities, extramuralActivities } = req.body;
    const facilitiesArr       = facilities            ? (Array.isArray(facilities)            ? facilities            : [facilities])            : [];
    const extramuralArr       = extramuralActivities  ? (Array.isArray(extramuralActivities)  ? extramuralActivities  : [extramuralActivities])  : [];

    // Parse notification contacts
    const _notifCount = parseInt(req.body.notifContactCount || "0", 10);
    const _notifRaw = [];
    for (let i = 0; i < _notifCount; i++) {
      const p = String(req.body["notifContact_" + i] || "").trim().replace(/[^0-9]/g, "");
      const normalized = p.startsWith("0") && p.length === 10 ? "263" + p.slice(1) : p;
      if (normalized.length >= 10) _notifRaw.push(normalized);
    }
    const primaryPhone = String(phone || "").replace(/\D/g, "");
    const notificationContacts = [...new Set(_notifRaw)].filter(p => p !== primaryPhone);

    await SP.findByIdAndUpdate(req.params.id, { $set: {
      schoolName:    String(schoolName||"").trim(),
      phone:         primaryPhone,
      email:         String(email||"").trim(),
      website:       String(website||"").trim(),
      suburb:        String(suburb||"").trim(),
      city:          String(city||"").trim(),
      address:       String(address||"").trim(),
      schoolType:    String(schoolType||"").trim(),
      ownership:     String(ownership||"").trim(),
      gender:        String(gender||"mixed").trim(),
      curriculum:    String(curriculum||"").split(",").map(s=>s.trim().toLowerCase()).filter(Boolean),
      fees: {
        term1: parseFloat(fees_term1)||0,
        term2: parseFloat(fees_term2)||0,
        term3: parseFloat(fees_term3)||0
      },
      principalName:          String(principalName||"").trim(),
      contactPhone:           String(contactPhone||"").trim(),
      boarding:               String(boarding||"day").trim(),
      description:            String(description||"").trim(),
      facilities:             facilitiesArr,
      extramuralActivities:   extramuralArr,
      notificationContacts,
      "location.area":        String(suburb||"").trim(),
      "location.city":        String(city||"").trim()
    }});
    res.redirect(`/zq-admin/schools/${req.params.id}?success=School+profile+saved.`);
  } catch(err) { res.redirect(`/zq-admin/schools/${req.params.id}?error=${encodeURIComponent(err.message)}`); }
});

// POST apply-toggle
router.post("/schools/:id/apply-toggle", requireSupplierAdmin, async(req,res) => {
  try {
    const SP = (await import("../models/schoolProfile.js")).default;
    const sc = await SP.findById(req.params.id).lean();
    if(!sc) return res.redirect("/zq-admin/schools");
    await SP.findByIdAndUpdate(req.params.id,{$set:{"applicationForm.active":!sc.applicationForm?.active}}, { strict: false });
    res.redirect(`/zq-admin/schools/${req.params.id}?success=${encodeURIComponent(!sc.applicationForm?.active?"Form enabled.":"Form disabled.")}`);
  }catch(err){res.redirect(`/zq-admin/schools/${req.params.id}?error=${encodeURIComponent(err.message)}`);}
});

// POST apply-settings
router.post("/schools/:id/apply-settings", requireSupplierAdmin, async(req,res) => {
  try {
    const SP = (await import("../models/schoolProfile.js")).default;
    const {intakeYear,notifyEmail,notifyPhone,registrationLink,gradeOptions,brochureUrl,brochureName,rawFormUrl,rawFormName} = req.body;
    // Use { strict: false } so dot-notation saves to Mixed type applicationForm are guaranteed
    await SP.findByIdAndUpdate(req.params.id,{$set:{
      registrationLink: String(registrationLink||"").trim(),
      "applicationForm.intakeYear":   String(intakeYear||"").trim(),
      "applicationForm.notifyEmail":  String(notifyEmail||"").trim(),
      "applicationForm.notifyPhone":  String(notifyPhone||"").trim(),
      "applicationForm.gradeOptions": String(gradeOptions||"").split(",").map(s=>s.trim()).filter(Boolean),
      "applicationForm.brochureUrl":  String(brochureUrl||"").trim(),
      "applicationForm.brochureName": String(brochureName||"School_Brochure.pdf").trim(),
      "applicationForm.rawFormUrl":   String(rawFormUrl||"").trim(),
      "applicationForm.rawFormName":  String(rawFormName||"Application_Form.pdf").trim()
    }}, { strict: false, new: true });
    res.redirect(`/zq-admin/schools/${req.params.id}?success=Settings+saved.`);
  }catch(err){res.redirect(`/zq-admin/schools/${req.params.id}?error=${encodeURIComponent(err.message)}`);}
});

// GET apply-qr - QR poster page
router.get("/schools/:id/apply-qr", requireSupplierAdmin, async(req,res) => {
  try {
    const SP = (await import("../models/schoolProfile.js")).default;
    const school = await SP.findById(req.params.id).lean();
    if(!school) return res.status(404).send("Not found");
    const al  = _schApplyLink(String(school._id));
    const aqr = _schQr(al,500,"1a3c5e");
    const wqr = school.registrationLink ? _schQr(school.registrationLink,500,"7c3aed") : null;
    const nm  = esc(school.schoolName||"School");
    const lo  = esc([school.suburb,school.city].filter(Boolean).join(", "));
    const iy  = esc(school.applicationForm?.intakeYear||"");
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Apply QR - ${nm}</title>
<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:-apple-system,sans-serif;background:#f8fafc;padding:24px}
.hd{text-align:center;margin-bottom:28px}.hd h1{font-size:22px;font-weight:800;color:#1a3c5e}
.hd p{font-size:14px;color:#64748b;margin-top:6px}
.iy{display:inline-block;background:#dbeafe;color:#1d4ed8;padding:4px 14px;border-radius:20px;font-size:13px;font-weight:700;margin-top:10px}
.gr{display:grid;grid-template-columns:${wqr ? "1fr 1fr" : "1fr"};gap:24px;max-width:${wqr ? "900px" : "460px"};margin:0 auto}
@media(max-width:600px){.gr{grid-template-columns:1fr}}
.cd{background:white;border-radius:16px;padding:28px;box-shadow:0 2px 8px rgba(0,0,0,.08);text-align:center}
.bg{display:inline-block;padding:5px 14px;border-radius:20px;font-size:12px;font-weight:700;margin-bottom:12px}
.qw{border-radius:14px;padding:16px;display:inline-block;margin-bottom:16px}
.hw{font-size:12px;color:#64748b;background:#f8fafc;border-radius:8px;padding:10px 14px;margin-bottom:14px;line-height:1.7;text-align:left}
.br{display:flex;gap:8px;justify-content:center;flex-wrap:wrap}
.bt{padding:9px 18px;border-radius:8px;font-size:13px;font-weight:600;text-decoration:none;display:inline-block}
.tp{background:#fffbeb;border:1px solid #fde68a;border-radius:10px;padding:14px 18px;font-size:13px;color:#92400e;max-width:900px;margin:24px auto;line-height:1.7}
.bk{display:block;text-align:center;margin:20px auto;font-size:13px;color:#1a3c5e;text-decoration:none}
@media print{.np{display:none!important}body{padding:0;background:white}}</style></head><body>
<div class="hd"><h1>📝 Application Form QR Codes</h1>
<p>${nm}${lo ? ` · ${lo}` : ""}</p>${iy ? `<br><span class="iy">${iy}</span>` : ""}</div>
<div class="gr">
<div class="cd"><span class="bg" style="background:#dcfce7;color:#16a34a">📱 WhatsApp Form</span>
<h2 style="font-size:16px;font-weight:800;color:#1a3c5e;margin-bottom:4px">Apply via WhatsApp</h2>
<p style="font-size:12px;color:#64748b;margin-bottom:14px">Parent scans → 5-step form → school receives by email</p>
<div class="qw" style="background:#eff6ff"><img src="${esc(aqr)}" style="display:block;width:220px;height:220px" alt="WhatsApp Apply QR"></div>
<div class="hw"><strong>How it works:</strong><br>1. Parent opens camera<br>2. Points at QR code<br>3. WhatsApp opens automatically<br>4. Answers 5 short questions (2 min)<br>5. School gets application by email</div>
<div class="br np">
<a href="${esc(aqr)}" download="apply-wa-qr.png" target="_blank" class="bt" style="background:#1a3c5e;color:white">⬇ Download PNG</a>
<a href="${esc(al)}" target="_blank" class="bt" style="background:#dcfce7;color:#16a34a">📱 Test</a>
</div></div>
${wqr ? `<div class="cd"><span class="bg" style="background:#ede9fe;color:#7c3aed">🌐 Web Form</span>
<h2 style="font-size:16px;font-weight:800;color:#1a3c5e;margin-bottom:4px">Apply Online (Web)</h2>
<p style="font-size:12px;color:#64748b;margin-bottom:14px">Scan to open the school's online application form</p>
<div class="qw" style="background:#f5f3ff"><img src="${esc(wqr)}" style="display:block;width:220px;height:220px" alt="Web Apply QR"></div>
<div class="hw"><strong>Link encoded:</strong><br><span style="word-break:break-all;font-family:monospace;font-size:10px">${esc(school.registrationLink)}</span></div>
<div class="br np">
<a href="${esc(wqr)}" download="apply-web-qr.png" target="_blank" class="bt" style="background:#7c3aed;color:white">⬇ Download PNG</a>
<a href="${esc(school.registrationLink)}" target="_blank" class="bt" style="background:#ede9fe;color:#7c3aed">🌐 Open Form</a>
</div></div>` : ""}
</div>
<div class="tp np"><strong>💡 Where to use these QR codes:</strong><br>
Print on <strong>flyers, gate signage, notice boards</strong> and share on social media (Facebook, WhatsApp Status, Instagram).<br>
The WhatsApp QR works on <strong>any phone with WhatsApp</strong> - no login or download needed.</div>
<a href="/zq-admin/schools/${esc(String(school._id))}" class="bk np">← Back to School Profile</a>
</body></html>`);
  }catch(err){res.status(500).send("Error: "+err.message);}
});

// GET contacts
router.get("/schools/:id/contacts", requireSupplierAdmin, async(req,res) => {
  try {
    const SP = (await import("../models/schoolProfile.js")).default;
    const school = await SP.findById(req.params.id).lean();
    if(!school) return res.redirect("/zq-admin/schools");
    let contacts=[];
    try{ const SC=(await import("../models/schoolContact.js")).default; contacts=await SC.find({schoolId:school._id}).sort({lastSeen:-1}).lean(); }catch(_){}
    const sCol={new:"#dbeafe",contacted:"#fef9c3",enrolled:"#dcfce7",not_interested:"#fee2e2"};
    const sLbl={new:"🆕 New",contacted:"📞 Contacted",enrolled:"✅ Enrolled",not_interested:"❌ Not Interested"};
    const rows=contacts.map(c=>{
      const d=c.applicationData||{};
      const dp=c.phone.startsWith("263")?"0"+c.phone.slice(3):c.phone;
      const _parentPhone = d.parentPhone || c.parentPhone || "";
      const _waLink = `https://wa.me/${c.phone}`;
      const _submittedAt = c.appliedAt ? new Date(c.appliedAt).toLocaleDateString("en-GB",{day:"numeric",month:"short",year:"2-digit"}) : "";
      return `<tr>
<td style="padding:9px 12px;border-bottom:1px solid var(--border)">
  <strong>${esc(dp)}</strong>
  <a href="${esc(_waLink)}" target="_blank" title="Open WhatsApp" style="margin-left:6px;font-size:11px;background:#25d366;color:white;padding:2px 7px;border-radius:10px;text-decoration:none">💬 WA</a>
  <br><span style="font-size:10px;color:var(--muted)">${c.viewCount>1?`${c.viewCount} views · `:""} ${esc(new Date(c.firstSeen).toLocaleDateString("en-GB",{day:"numeric",month:"short"}))}</span>
</td>
<td style="padding:9px 12px;border-bottom:1px solid var(--border);font-size:13px">
  ${esc(d.studentName||c.studentName||"-")}
  <br><span style="font-size:11px;color:#7c3aed">${esc(d.grade||c.gradeInterest||"")}</span>
  ${d.dob?`<br><span style="font-size:10px;color:var(--muted)">DOB: ${esc(d.dob)}</span>`:""}
</td>
<td style="padding:9px 12px;border-bottom:1px solid var(--border);font-size:13px">
  ${esc(d.parentName||c.parentName||"-")}
  ${_parentPhone?`<br><span style="font-size:11px;color:var(--muted)">${esc(_parentPhone)}</span>`:""}
</td>
<td style="padding:9px 12px;border-bottom:1px solid var(--border);font-size:12px">
  <span style="background:${c.converted?"#dcfce7":c.source==="apply"?"#dbeafe":c.source==="enquiry"?"#fef9c3":"#f1f5f9"};color:${c.converted?"#16a34a":c.source==="apply"?"#1d4ed8":c.source==="enquiry"?"#92400e":"#64748b"};padding:2px 8px;border-radius:12px">
    ${c.converted?"✅ Applied":c.source==="apply"?"📝 Apply Started":c.source==="enquiry"?"❓ Enquiry":"👁 Viewed"}
  </span>
  ${_submittedAt?`<br><span style="font-size:10px;color:var(--muted)">${esc(_submittedAt)}</span>`:""}
</td>
<td style="padding:9px 12px;border-bottom:1px solid var(--border);font-size:12px">${new Date(c.lastSeen).toLocaleDateString("en-GB",{day:"numeric",month:"short"})}</td>
<td style="padding:9px 12px;border-bottom:1px solid var(--border)">
<form method="POST" action="/zq-admin/schools/${esc(String(school._id))}/contacts/${esc(String(c._id))}/status" style="margin:0">
<select name="status" onchange="this.form.submit()" style="font-size:11px;padding:3px 6px;border:1px solid var(--border);border-radius:6px;background:${sCol[c.status]||"white"}">
${["new","contacted","enrolled","not_interested"].map(s=>`<option value="${s}"${c.status===s?" selected":""}>${sLbl[s]}</option>`).join("")}
</select></form></td></tr>`;}).join("");
    res.send(layout(`Contacts - ${esc(school.schoolName)}`,`
<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:18px;flex-wrap:wrap;gap:10px">
<div><h1 style="font-size:18px;font-weight:800;margin:0">👥 ${esc(school.schoolName)} Contacts</h1>
<p style="font-size:12px;color:var(--muted);margin-top:3px">${contacts.length} total · ${contacts.filter(c=>c.converted).length} applications</p></div>
<div style="display:flex;gap:8px">
<a href="/zq-admin/schools/${esc(String(school._id))}/contacts/export" class="btn btn-sm" style="background:#f1f5f9">📊 Export CSV</a>
<a href="/zq-admin/schools/${esc(String(school._id))}" class="btn btn-sm">← Back</a>
</div></div>
${contacts.length===0?`<div style="background:white;border-radius:12px;padding:40px;text-align:center;color:var(--muted)">
<p style="font-size:32px;margin-bottom:10px">👥</p><p style="font-weight:600">No contacts yet</p>
<p style="font-size:13px;margin-top:4px">Contacts are captured automatically when parents scan QR codes or tap Apply.</p></div>`
:`<div style="background:white;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.08)">
<table style="width:100%;border-collapse:collapse">
<thead><tr style="background:#f8fafc">
<th style="padding:9px 12px;text-align:left;font-size:12px;color:var(--muted);font-weight:600">Phone</th>
<th style="padding:9px 12px;text-align:left;font-size:12px;color:var(--muted);font-weight:600">Student / Grade</th>
<th style="padding:9px 12px;text-align:left;font-size:12px;color:var(--muted);font-weight:600">Parent / Contact</th>
<th style="padding:9px 12px;text-align:left;font-size:12px;color:var(--muted);font-weight:600">Stage</th>
<th style="padding:9px 12px;text-align:left;font-size:12px;color:var(--muted);font-weight:600">Last Seen</th>
<th style="padding:9px 12px;text-align:left;font-size:12px;color:var(--muted);font-weight:600">Status</th>
</tr></thead><tbody>${rows}</tbody></table></div>`}
    `));
  }catch(err){res.send(layout("Error",`<div class="alert red">${esc(err.message)}</div>`));}
});

// POST contacts status
router.post("/schools/:id/contacts/:cid/status", requireSupplierAdmin, async(req,res) => {
  try{
    const SC=(await import("../models/schoolContact.js")).default;
    await SC.findByIdAndUpdate(req.params.cid,{$set:{status:req.body.status}});
  }catch(_){}
  res.redirect(`/zq-admin/schools/${req.params.id}/contacts`);
});

// GET contacts CSV export
router.get("/schools/:id/contacts/export", requireSupplierAdmin, async(req,res) => {
  try{
    const SP=(await import("../models/schoolProfile.js")).default;
    const SC=(await import("../models/schoolContact.js")).default;
    const [school,contacts]=await Promise.all([SP.findById(req.params.id).lean(), SC.find({schoolId:req.params.id}).sort({lastSeen:-1}).lean()]);
    const hdr="Phone,Student Name,Grade,Parent Name,Parent Phone,Source,Status,First Seen,Last Seen,Applied\n";
    const rows=contacts.map(c=>{
      const d=c.applicationData||{};
      const dp=c.phone.startsWith("263")?"0"+c.phone.slice(3):c.phone;
      return [dp,d.studentName||c.studentName||"",d.grade||c.gradeInterest||"",d.parentName||c.parentName||"",d.parentPhone||"",c.source,c.status,
        new Date(c.firstSeen).toLocaleDateString("en-GB"),new Date(c.lastSeen).toLocaleDateString("en-GB"),c.converted?"Yes":"No"
      ].map(v=>`"${String(v||"").replace(/"/g,'""')}"`).join(",");
    }).join("\n");
    const fn=`${(school?.schoolName||"school").replace(/\s+/g,"-")}-contacts-${new Date().toISOString().slice(0,10)}.csv`;
    res.setHeader("Content-Type","text/csv");
    res.setHeader("Content-Disposition",`attachment; filename="${fn}"`);
    res.send(hdr+rows);
  }catch(err){res.status(500).send("Export failed: "+err.message);}
});

router.get("/schools/:id/delete-confirm", requireSupplierAdmin, async (req, res) => {
  try {
    const SchoolProfile = (await import("../models/schoolProfile.js")).default;
    const school = await SchoolProfile.findById(req.params.id).lean();
    if (!school) return res.redirect("/zq-admin/schools");

    res.send(layout(`Delete School: ${esc(school.schoolName)}`, `
      <a href="/zq-admin/schools/${school._id}" class="back-link">← Back to School Profile</a>

      <div class="panel" style="max-width:560px;border:2px solid #ef4444">
        <div style="display:flex;align-items:center;gap:12px;margin-bottom:18px">
          <div style="width:44px;height:44px;background:#fee2e2;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:20px;flex-shrink:0">🗑</div>
          <div>
            <h3 style="color:#dc2626;margin:0">Delete School</h3>
            <p style="margin:2px 0 0;color:var(--muted);font-size:13px">This is permanent and cannot be undone.</p>
          </div>
        </div>

        <div style="background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:14px;margin-bottom:20px">
          <p style="font-size:13px;margin-bottom:8px"><strong>You are about to permanently delete:</strong></p>
          <dl style="display:grid;grid-template-columns:130px 1fr;gap:4px;font-size:13px">
            <dt style="color:var(--muted)">School</dt>
            <dd><strong>${esc(school.schoolName)}</strong></dd>
            <dt style="color:var(--muted)">Phone</dt>
            <dd>${esc(school.phone || "-")}</dd>
            <dt style="color:var(--muted)">City</dt>
            <dd>${esc(school.city || "-")}</dd>
            <dt style="color:var(--muted)">Type</dt>
            <dd>${esc(school.schoolType || "-")} · ${esc(school.ownership || "-")}</dd>
            <dt style="color:var(--muted)">Status</dt>
            <dd>${school.active ? "🟢 Active" : "⚫ Inactive"}</dd>
          </dl>
        </div>

        <p style="font-size:13px;color:var(--muted);margin-bottom:16px">
          The following will be permanently removed:
          school profile · business account · branches · WhatsApp session · products
        </p>

        <form method="POST" action="/zq-admin/schools/${school._id}/delete">
          <div style="margin-bottom:16px">
            <label style="display:block;font-size:12px;font-weight:600;color:var(--muted);margin-bottom:6px;text-transform:uppercase;letter-spacing:.4px">
              Type the school name to confirm:
            </label>
            <input type="text" name="confirmName" required
                   placeholder="${esc(school.schoolName)}"
                   style="width:100%;padding:10px 12px;border:1px solid #fca5a5;border-radius:7px;font-size:13px;outline:none"
                   oninput="checkName(this.value, '${esc(school.schoolName)}')" />
            <p id="nameHint" style="font-size:11px;color:var(--muted);margin-top:4px">Must match exactly.</p>
          </div>
          <div style="display:flex;gap:10px;flex-wrap:wrap">
            <button type="submit" id="deleteBtn" class="btn btn-red" disabled>🗑 Permanently Delete School</button>
            <a href="/zq-admin/schools/${school._id}" class="btn btn-gray">Cancel</a>
          </div>
        </form>
      </div>

      <script>
        function checkName(typed, expected) {
          const btn  = document.getElementById("deleteBtn");
          const hint = document.getElementById("nameHint");
          const match = typed.trim() === expected.trim();
          btn.disabled = !match;
          hint.textContent = match ? "✅ Name confirmed." : "Must match exactly: " + expected;
          hint.style.color = match ? "#16a34a" : "var(--muted)";
        }
      </script>
    `));
  } catch (err) {
    res.send(layout("Error", `<div class="alert red">${err.message}</div>`));
  }
});

router.post("/schools/:id/delete", requireSupplierAdmin, async (req, res) => {
  try {
    const SchoolProfile = (await import("../models/schoolProfile.js")).default;
    const school = await SchoolProfile.findById(req.params.id).lean();
    if (!school) return res.redirect("/zq-admin/schools");

    const { confirmName } = req.body;

    // Name confirmation guard
    if (
      !confirmName ||
      confirmName.trim().toLowerCase() !== school.schoolName.trim().toLowerCase()
    ) {
      return res.redirect(
        `/zq-admin/schools/${req.params.id}/delete-confirm?error=${encodeURIComponent("School name did not match. Deletion cancelled.")}`
      );
    }

    const phone = school.phone || "";

    // Dynamic model imports
    const Business    = (await import("../models/business.js")).default;
    const UserRole    = (await import("../models/userRole.js")).default;
    const Branch      = (await import("../models/branch.js")).default;
    const UserSession = (await import("../models/userSession.js")).default;
    const Product     = (await import("../models/product.js")).default;

    // 1. Delete SchoolProfile
    await SchoolProfile.findByIdAndDelete(school._id);
    console.log(`[Admin Delete School] SchoolProfile deleted: ${school._id} (${phone})`);

    // 2. Delete linked Business + Branches + Products
    if (school.businessId) {
      const biz = await Business.findById(school.businessId).lean();
      if (biz) {
        await Branch.deleteMany({ businessId: biz._id });
        await Product.deleteMany({ businessId: biz._id });
        await Business.findByIdAndDelete(biz._id);
        console.log(`[Admin Delete School] Business deleted: ${biz._id}`);
      }
    }

    // 3. Delete UserRole records for this phone
    if (phone) {
      await UserRole.deleteMany({ phone });
    }

    // 4. Clear UserSession
    if (phone) {
      const cleanPhone = phone.replace(/\D+/g, "");
      await UserSession.findOneAndUpdate(
        { phone: cleanPhone },
        { $unset: { activeBusinessId: "", sessionState: "", sessionData: "" } }
      );
    }

    console.log(`[Admin Delete School] ✅ Full delete complete: ${school.schoolName} (${phone})`);

    res.redirect(`/zq-admin/schools?success=${encodeURIComponent(
      school.schoolName + " has been permanently deleted."
    )}`);
  } catch (err) {
    console.error("[Admin Delete School] Error:", err.message);
    res.redirect(`/zq-admin/schools/${req.params.id}/delete-confirm?error=${encodeURIComponent(err.message)}`);
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// END OF SCHOOL DELETE ROUTES (copy the block above into your school admin file)
// ═════════════════════════════════════════════════════════════════════════════



// ══════════════════════════════════════════════════════════════════════════════
// ── 1. SEND OFFER (single supplier, from Manage page) ────────────────────────
// ══════════════════════════════════════════════════════════════════════════════

// GET  /zq-admin/suppliers/:id/send-offer  →  Offer form on manage page
router.get("/suppliers/:id/send-offer", requireSupplierAdmin, async (req, res) => {
  try {
    const supplier = await SupplierProfile.findById(req.params.id).lean();
    if (!supplier) return res.redirect("/zq-admin/suppliers");

    const successMsg = req.query.success
      ? `<div style="background:#dcfce7;color:#16a34a;padding:14px;border-radius:8px;margin-bottom:16px">✅ ${esc(req.query.success)}</div>`
      : "";

    res.send(layout(`Send Offer: ${esc(supplier.businessName)}`, `
      <a href="/zq-admin/suppliers/${supplier._id}" class="back-link">← Back to Profile</a>
      ${successMsg}

      <div class="panel" style="max-width:680px">
        <div class="panel-head">
          <h3>📣 Send Discount / Payment Offer</h3>
          <span style="font-size:12px;color:var(--muted)">
            Sends via Meta template - reaches supplier even outside 24hr window
          </span>
        </div>
        <p style="font-size:13px;color:var(--muted);margin-bottom:20px">
          Sending to: <strong>${esc(supplier.businessName)}</strong>
          &nbsp;•&nbsp; <code>${esc(supplier.phone)}</code>
        </p>

        <form method="POST" action="/zq-admin/suppliers/${supplier._id}/send-offer" class="edit-form">
          <div class="form-grid">
            <div class="fg">
              <label>Offer Title / Headline</label>
              <input name="offerTitle" required
                placeholder="e.g. 50% off Pro plan this month!" />
            </div>
            <div class="fg">
              <label>Valid Until</label>
              <input type="date" name="validUntil" />
            </div>
          </div>

          <div class="fg full" style="margin-bottom:14px">
            <label>Offer Details</label>
            <textarea name="offerBody" rows="4" required
              placeholder="e.g. Upgrade to Pro for just $6/month (normally $12). Your listing will appear at the top of search results and reach more buyers."></textarea>
          </div>

          <div class="fg" style="margin-bottom:16px">
            <label>Action Link (URL or WhatsApp)</label>
            <input name="actionLink"
              placeholder="e.g. https://wa.me/263XXXXXXXXX or https://zimquote.co.zw/upgrade" />
          </div>

          <div class="form-actions">
            <button type="submit" class="btn btn-blue">📤 Send Offer via WhatsApp</button>
            <a href="/zq-admin/suppliers/${supplier._id}" class="btn btn-gray">Cancel</a>
          </div>
        </form>
      </div>
    `));
  } catch (err) {
    res.send(layout("Error", `<div class="alert red">${err.message}</div>`));
  }
});

// POST /zq-admin/suppliers/:id/send-offer
router.post("/suppliers/:id/send-offer", requireSupplierAdmin, async (req, res) => {
  try {
    const { offerTitle, offerBody, validUntil, actionLink } = req.body;
    const supplier = await SupplierProfile.findById(req.params.id).lean();
    if (!supplier) return res.redirect("/zq-admin/suppliers");

    const fullOffer = offerTitle
      ? `${offerTitle}\n\n${offerBody || ""}`
      : (offerBody || "");

    const { notifySupplierOffer } = await import("../services/supplierNotifications.js");
    await notifySupplierOffer(
      supplier.phone,
      fullOffer.trim(),
      validUntil || null,
      actionLink || "wa.me/263XXXXXXXXX"
    );

    res.redirect(
      `/zq-admin/suppliers/${req.params.id}/send-offer?success=${encodeURIComponent(
        "Offer sent to " + supplier.businessName + " (" + supplier.phone + ")"
      )}`
    );
  } catch (err) {
    res.send(layout("Error", `<div class="alert red">${err.message}</div>`));
  }
});


// ══════════════════════════════════════════════════════════════════════════════
// ── 2. BROADCAST OFFER (all suppliers or filtered subset) ────────────────────
// ══════════════════════════════════════════════════════════════════════════════

// GET  /zq-admin/broadcast-offer  →  Broadcast form
router.get("/broadcast-offer", requireSupplierAdmin, async (req, res) => {
  try {
    const [totalActive, totalAll] = await Promise.all([
      SupplierProfile.countDocuments({ active: true }),
      SupplierProfile.countDocuments()
    ]);

    const successMsg = req.query.success
      ? `<div style="background:#dcfce7;color:#16a34a;padding:14px;border-radius:8px;margin-bottom:16px">
           ✅ ${esc(req.query.success)}
         </div>`
      : "";

    res.send(layout("Broadcast Offer", `
      ${successMsg}

      <div class="panel" style="max-width:720px">
        <div class="panel-head">
          <h3>📣 Broadcast Discount / Payment Offer</h3>
          <span style="font-size:12px;color:var(--muted)">
            Uses Meta template - reaches suppliers even outside the 24hr chat window
          </span>
        </div>

        <div class="stats-grid" style="margin-bottom:24px">
          ${stat(totalActive, "Active Suppliers", "green")}
          ${stat(totalAll,    "All Suppliers",    "")}
        </div>

        <form method="POST" action="/zq-admin/broadcast-offer" class="edit-form">

          <div class="fg" style="margin-bottom:16px">
            <label>Send To</label>
            <select name="audience" required>
              <option value="active">✅ Active suppliers only (${totalActive})</option>
              <option value="all">👥 All suppliers (${totalAll})</option>
              <option value="tier_basic">📦 Basic tier only</option>
              <option value="tier_pro">⭐ Pro tier only</option>
              <option value="tier_featured">🔥 Featured tier only</option>
              <option value="expired">❌ Expired subscriptions (re-engagement)</option>
            </select>
          </div>

          <div class="form-grid">
            <div class="fg">
              <label>Offer Title / Headline</label>
              <input name="offerTitle" required
                placeholder="e.g. 50% off this month only!" />
            </div>
            <div class="fg">
              <label>Valid Until</label>
              <input type="date" name="validUntil" />
            </div>
          </div>

          <div class="fg full" style="margin-bottom:14px">
            <label>Offer Details</label>
            <textarea name="offerBody" rows="5" required
              placeholder="Describe the offer clearly. This is what suppliers will read on WhatsApp."></textarea>
          </div>

          <div class="fg" style="margin-bottom:20px">
            <label>Action Link (URL or WhatsApp number)</label>
            <input name="actionLink"
              value="wa.me/263XXXXXXXXX"
              placeholder="https://wa.me/263XXXXXXXXX" />
          </div>

          <div style="background:#fef9c3;border:1px solid #fde047;border-radius:8px;
                      padding:14px;margin-bottom:20px;font-size:13px">
            ⚠️ <strong>Before sending:</strong> Make sure the <code>supplier_offer</code>
            template is approved in Meta Business Manager, or the message will fall back
            to plain WhatsApp text (only delivered if supplier messaged in last 24 hours).
          </div>

          <div class="form-actions">
            <button type="submit" class="btn btn-blue"
              onclick="return confirm('Send this offer to the selected audience? This cannot be undone.')">
              📤 Broadcast Offer
            </button>
            <a href="/zq-admin" class="btn btn-gray">Cancel</a>
          </div>
        </form>
      </div>
    `));
  } catch (err) {
    res.send(layout("Broadcast Offer", `<div class="alert red">Error: ${err.message}</div>`));
  }
});

// POST /zq-admin/broadcast-offer
router.post("/broadcast-offer", requireSupplierAdmin, async (req, res) => {
  try {
    const { audience, offerTitle, offerBody, validUntil, actionLink } = req.body;

    // Build DB query based on audience
    const query = {};
    if (audience === "active")       { query.active = true; }
    else if (audience === "tier_basic")    { query.tier = "basic"; }
    else if (audience === "tier_pro")      { query.tier = "pro"; }
    else if (audience === "tier_featured") { query.tier = "featured"; }
    else if (audience === "expired")       { query.subscriptionStatus = "expired"; }
    // "all" = no filter

    const suppliers = await SupplierProfile.find(query, { phone: 1, businessName: 1 }).lean();

    const fullOffer = offerTitle
      ? `${offerTitle}\n\n${offerBody || ""}`
      : (offerBody || "");

    const { broadcastSupplierOffer } = await import("../services/supplierNotifications.js");
    const results = await broadcastSupplierOffer(
      suppliers,
      fullOffer.trim(),
      validUntil || null,
      actionLink || "wa.me/263XXXXXXXXX"
    );

    res.redirect(
      `/zq-admin/broadcast-offer?success=${encodeURIComponent(
        `Broadcast complete: ${results.sent} sent, ${results.failed} failed (out of ${suppliers.length} suppliers)`
      )}`
    );
  } catch (err) {
    res.send(layout("Error", `<div class="alert red">${err.message}</div>`));
  }
});


// ══════════════════════════════════════════════════════════════════════════════
// ── 3. TRIAL ACTIVATED NOTIFICATION (hooks into existing /activate POST) ──────
// ══════════════════════════════════════════════════════════════════════════════
// NOTE: In the existing router.post("/suppliers/:id/activate", ...) route,
// REPLACE the existing WhatsApp notify block (the try/catch that calls sendText)
// with the following:
//
//   // ── 6. Notify seller - trial activated (Meta template) ───────────────────
//   if (isActive) {
//     try {
//       const { notifySupplierTrialActivated } = await import("../services/supplierNotifications.js");
//       await notifySupplierTrialActivated(
//         supplier.phone,
//         supplier.businessName,
//         tier,
//         plan,
//         expiresAt
//       );
//     } catch (notifyErr) {
//       console.error("[Admin Activate] WhatsApp notify failed:", notifyErr.message);
//     }
//   }
//
// The new notifySupplierTrialActivated() function uses the Meta template
// supplier_trial_activated and falls back to sendText automatically.


// ══════════════════════════════════════════════════════════════════════════════
// ── 4. MANUAL PAYMENT RECEIPT ─────────────────────────────────────────────────
// GET  /zq-admin/suppliers/:id/receipt  →  Receipt form
// POST /zq-admin/suppliers/:id/receipt  →  Log + send WhatsApp + download PDF
// ══════════════════════════════════════════════════════════════════════════════

// GET: Show receipt generation form
router.get("/suppliers/:id/receipt", requireSupplierAdmin, async (req, res) => {
  try {
    const supplier = await SupplierProfile.findById(req.params.id).lean();
    if (!supplier) return res.redirect("/zq-admin/suppliers");

    const successMsg = req.query.success
      ? `<div style="background:#dcfce7;color:#16a34a;padding:14px;border-radius:8px;margin-bottom:16px">
           ✅ ${esc(req.query.success)}
         </div>`
      : "";

    // Default expiry: 30 days from now
    const defaultExpiry = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
      .toISOString().split("T")[0];
    // Default reference
    const defaultRef = `ZQ-${Date.now()}`;

    res.send(layout(`Receipt: ${esc(supplier.businessName)}`, `
      <a href="/zq-admin/suppliers/${supplier._id}" class="back-link">← Back to Profile</a>
      ${successMsg}

      <div class="panel" style="max-width:680px">
        <div class="panel-head">
          <h3>🧾 Generate Manual Payment Receipt</h3>
          <span style="font-size:12px;color:var(--muted)">
            Logs payment, sends WhatsApp confirmation, and generates downloadable PDF
          </span>
        </div>

        <p style="font-size:13px;color:var(--muted);margin-bottom:20px">
          Supplier: <strong>${esc(supplier.businessName)}</strong>
          &nbsp;•&nbsp; <code>${esc(supplier.phone)}</code>
        </p>

        <form method="POST" action="/zq-admin/suppliers/${supplier._id}/receipt"
              class="edit-form" target="_blank">

          <div class="form-grid">
            <div class="fg">
              <label>Tier / Plan</label>
              <select name="tier">
                <option ${supplier.tier === "basic"    ? "selected" : ""} value="basic">Basic</option>
                <option ${supplier.tier === "pro"      ? "selected" : ""} value="pro">Pro</option>
                <option ${supplier.tier === "featured" ? "selected" : ""} value="featured">Featured</option>
              </select>
            </div>
            <div class="fg">
              <label>Billing Cycle</label>
              <select name="billingCycle">
                <option value="monthly">Monthly</option>
                <option value="annual">Annual</option>
              </select>
            </div>
            <div class="fg">
              <label>Amount Paid</label>
              <input type="number" name="amount" step="0.01" min="0"
                placeholder="e.g. 12.00" required />
            </div>
            <div class="fg">
              <label>Currency</label>
              <select name="currency">
                <option value="USD">USD ($)</option>
                <option value="ZWL">ZWL (Z$)</option>
                <option value="ZAR">ZAR (R)</option>
              </select>
            </div>
            <div class="fg">
              <label>Payment Method</label>
              <select name="paymentMethod">
                <option value="ecocash">EcoCash</option>
                <option value="cash">Cash</option>
                <option value="bank_transfer">Bank Transfer</option>
                <option value="innbucks">InnBucks</option>
                <option value="other">Other</option>
              </select>
            </div>
            <div class="fg">
              <label>Reference Number</label>
              <input name="reference" value="${defaultRef}" />
            </div>
            <div class="fg">
              <label>Subscription Valid Until</label>
              <input type="date" name="expiresAt" value="${defaultExpiry}" required />
            </div>
            <div class="fg">
              <label>Also update subscription?</label>
              <select name="updateSubscription">
                <option value="true">Yes - set status to active + update expiry</option>
                <option value="false">No - receipt only</option>
              </select>
            </div>
          </div>

          <div class="fg full" style="margin-bottom:20px">
            <label>Admin Note (appears on receipt)</label>
            <input name="adminNote"
              placeholder="e.g. Cash received at office 12 Apr 2026" />
          </div>

          <div class="form-actions">
            <button type="submit" name="action" value="send_and_download"
              class="btn btn-blue">
              🧾 Send WhatsApp + Download PDF
            </button>
            <button type="submit" name="action" value="whatsapp_only"
              class="btn btn-green" formtarget="_self">
              📱 WhatsApp Only
            </button>
            <button type="submit" name="action" value="pdf_only"
              class="btn btn-gray">
              📄 PDF Only
            </button>
            <a href="/zq-admin/suppliers/${supplier._id}" class="btn btn-gray">Cancel</a>
          </div>
        </form>
      </div>
    `));
  } catch (err) {
    res.send(layout("Error", `<div class="alert red">${err.message}</div>`));
  }
});

// POST: Process receipt - log, WhatsApp, PDF
router.post("/suppliers/:id/receipt", requireSupplierAdmin, async (req, res) => {
  try {
    const {
      tier, billingCycle, amount, currency, paymentMethod,
      reference, expiresAt, updateSubscription, adminNote, action
    } = req.body;

    const supplier = await SupplierProfile.findById(req.params.id);
    if (!supplier) return res.redirect("/zq-admin/suppliers");

    const now         = new Date();
    const expiryDate  = expiresAt ? new Date(expiresAt) : new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
    const ref         = reference?.trim() || `ZQ-${Date.now()}`;
    const amountNum   = Number(amount) || 0;

    // ── Log the payment ───────────────────────────────────────────────────────
    await SupplierSubscriptionPayment.create({
      supplierPhone: supplier.phone,
      supplierId:    supplier._id,
      tier:          tier || supplier.tier,
      plan:          billingCycle || "monthly",
      amount:        amountNum,
      currency:      currency || "USD",
      reference:     ref,
      status:        "paid",
      paidAt:        now,
      ecocashPhone:  paymentMethod === "ecocash" ? "manual-ecocash" : `manual-${paymentMethod || "cash"}`
    });

    // ── Optionally update subscription status ─────────────────────────────────
    if (updateSubscription === "true") {
      const TIER_TO_PACKAGE = { basic: "bronze", pro: "silver", featured: "gold" };
      await SupplierProfile.findByIdAndUpdate(supplier._id, {
        tier:                  tier || supplier.tier,
        tierRank:              tier === "featured" ? 3 : tier === "pro" ? 2 : 1,
        subscriptionStatus:    "active",
        subscriptionStartedAt: now,
        subscriptionExpiresAt: expiryDate,
        subscriptionPlan:      billingCycle || "monthly",
        active:                true
      });
      // Also update business record if linked
      if (supplier.businessId) {
        const Business = (await import("../models/business.js")).default;
        const TIER_TO_PACKAGE = { basic: "bronze", pro: "silver", featured: "gold" };
        await Business.findByIdAndUpdate(supplier.businessId, {
          package:               TIER_TO_PACKAGE[tier] || "bronze",
          subscriptionStatus:    "active",
          subscriptionStartedAt: now,
          subscriptionEndsAt:    expiryDate
        });
      }
    }

    // ── Send WhatsApp receipt (Meta template) ─────────────────────────────────
    const sendWhatsApp = action === "send_and_download" || action === "whatsapp_only";
    if (sendWhatsApp) {
      try {
        const { notifySupplierPaymentReceipt } = await import("../services/supplierNotifications.js");
        await notifySupplierPaymentReceipt(
          supplier.phone,
          supplier.businessName,
          tier || supplier.tier,
          billingCycle || "monthly",
          amountNum,
          currency || "USD",
          ref,
          expiryDate
        );
      } catch (waErr) {
        console.error("[Receipt] WhatsApp send failed:", waErr.message);
      }
    }

    // ── Generate PDF receipt ──────────────────────────────────────────────────
    const generatePDF = action === "send_and_download" || action === "pdf_only";
    if (generatePDF) {
      const planLabelR  = (tier || supplier.tier).charAt(0).toUpperCase() + (tier || supplier.tier).slice(1);
      const cycleLabelR = billingCycle === "annual" ? "Annual" : "Monthly";
      const methodLabelR = (paymentMethod || "Manual").replace(/_/g, " ").replace(/\w/g, c => c.toUpperCase());
      const symR        = currency === "ZWL" ? "Z$" : currency === "ZAR" ? "R" : "$";
      const locationR   = [supplier.location?.area, supplier.location?.city].filter(Boolean).join(", ");
      await _streamReceiptPDF(res, {
        filename:     `ZimQuote_Receipt_${ref}.pdf`,
        ref,
        isActivation: false,
        supplierName: supplier.businessName,
        phone:        supplier.phone,
        location:     locationR,
        planLabel:    planLabelR,
        cycleLabel:   cycleLabelR,
        amount:       amountNum,
        currency:     currency || "USD",
        validFromStr: now.toLocaleString("en-GB", { day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" }),
        validUntilStr: expiryDate.toLocaleString("en-GB", { day: "numeric", month: "long", year: "numeric" }),
        methodLabel:  methodLabelR,
        tableRows: [
          ["Receipt Number",  ref],
          ["Payment Method",  methodLabelR],
          ["Subscription",    `${planLabelR} / ${cycleLabelR}`],
          ["Amount Paid",     `${symR}${amountNum.toFixed(2)}`],
          ["Valid From",      now.toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric" })],
          ["Valid Until",     expiryDate.toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric" })],
          ["Status",          "Active & Live on ZimQuote"],
          ...(adminNote ? [["Note", adminNote]] : [])
        ]
      });
      return;
    }

    // ── WhatsApp-only: redirect back with success ─────────────────────────────
    res.redirect(
      `/zq-admin/suppliers/${req.params.id}/receipt?success=${encodeURIComponent(
        `Receipt sent to ${supplier.businessName}. Ref: ${ref}`
      )}`
    );
  } catch (err) {
    res.send(layout("Error", `<div class="alert red">${err.message}</div>`));
  }
});


// ══════════════════════════════════════════════════════════════════════════════
// ── 5. EXPIRY MANAGEMENT DASHBOARD ───────────────────────────────────────────
// GET /zq-admin/expiry  →  View expiring/expired suppliers + send reminders
// ══════════════════════════════════════════════════════════════════════════════

router.get("/expiry", requireSupplierAdmin, async (req, res) => {
  try {
    const now        = new Date();
    const in7days    = new Date(now.getTime() + 7  * 24 * 60 * 60 * 1000);
    const in3days    = new Date(now.getTime() + 3  * 24 * 60 * 60 * 1000);
    const in1day     = new Date(now.getTime() + 1  * 24 * 60 * 60 * 1000);
    const ago7days   = new Date(now.getTime() - 7  * 24 * 60 * 60 * 1000);
    const ago30days  = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const [expiring7, expiring3, expiring1, expiredRecent, expiredOld] = await Promise.all([
      SupplierProfile.find({
        active: true,
        subscriptionExpiresAt: { $gte: in3days, $lte: in7days }
      }).sort({ subscriptionExpiresAt: 1 }).lean(),

      SupplierProfile.find({
        active: true,
        subscriptionExpiresAt: { $gte: in1day, $lt: in3days }
      }).sort({ subscriptionExpiresAt: 1 }).lean(),

      SupplierProfile.find({
        active: true,
        subscriptionExpiresAt: { $gte: now, $lt: in1day }
      }).sort({ subscriptionExpiresAt: 1 }).lean(),

      SupplierProfile.find({
        subscriptionStatus: "expired",
        subscriptionExpiresAt: { $gte: ago7days, $lt: now }
      }).sort({ subscriptionExpiresAt: -1 }).lean(),

      SupplierProfile.find({
        subscriptionStatus: "expired",
        subscriptionExpiresAt: { $gte: ago30days, $lt: ago7days }
      }).sort({ subscriptionExpiresAt: -1 }).lean(),
    ]);

    const successMsg = req.query.success
      ? `<div style="background:#dcfce7;color:#16a34a;padding:14px;border-radius:8px;margin-bottom:16px">
           ✅ ${esc(req.query.success)}
         </div>`
      : "";

    function expiryRow(s) {
      const daysLeft = Math.ceil((new Date(s.subscriptionExpiresAt) - now) / (1000 * 60 * 60 * 24));
      const expired  = daysLeft < 0;
      return `<tr>
        <td><strong>${esc(s.businessName)}</strong></td>
        <td><code style="font-size:11px">${esc(s.phone)}</code></td>
        <td>${badge(s.tier || "basic", tierColor(s.tier))}</td>
        <td style="color:${expired ? "#dc2626" : daysLeft <= 1 ? "#f97316" : "#d97706"};font-weight:600">
          ${expired ? "Expired " + Math.abs(daysLeft) + "d ago" : daysLeft + " day(s)"}
        </td>
        <td>${new Date(s.subscriptionExpiresAt).toLocaleDateString("en-GB")}</td>
        <td>
          <form method="POST" action="/zq-admin/expiry/notify-one" style="display:inline">
            <input type="hidden" name="supplierId" value="${s._id}" />
            <input type="hidden" name="notifyType" value="${expired ? "expired" : "expiring"}" />
            <button class="btn btn-sm btn-${expired ? "orange" : "blue"}">
              ${expired ? "📤 Send Expired Notice" : "📤 Send Reminder"}
            </button>
          </form>
          <a href="/zq-admin/suppliers/${s._id}" class="btn-link" style="margin-left:8px;font-size:12px">View →</a>
        </td>
      </tr>`;
    }

    function expiryTable(title, suppliers, color) {
      if (!suppliers.length) return `
        <div class="panel">
          <h3>${title} <span class="count">0</span></h3>
          <p class="muted" style="padding:12px 0">None in this window.</p>
        </div>`;

      return `
        <div class="panel">
          <div class="panel-head">
            <h3>${title} <span class="count">${suppliers.length}</span></h3>
            <form method="POST" action="/zq-admin/expiry/notify-bulk" style="display:inline">
              <input type="hidden" name="ids" value="${suppliers.map(s => s._id).join(",")}" />
              <input type="hidden" name="notifyType"
                value="${title.includes("Expired") ? "expired" : "expiring"}" />
              <button class="btn btn-sm btn-${color}"
                onclick="return confirm('Send reminders to all ${suppliers.length} suppliers in this group?')">
                📤 Notify All (${suppliers.length})
              </button>
            </form>
          </div>
          <table>
            <thead>
              <tr>
                <th>Business</th><th>Phone</th><th>Tier</th>
                <th>Time Left / Overdue</th><th>Expiry Date</th><th></th>
              </tr>
            </thead>
            <tbody>${suppliers.map(expiryRow).join("")}</tbody>
          </table>
        </div>`;
    }

    res.send(layout("Subscription Expiry", `
      ${successMsg}

      <div class="stats-grid" style="margin-bottom:20px">
        ${stat(expiring7.length,   "Expiring in 7 days",  "yellow")}
        ${stat(expiring3.length,   "Expiring in 3 days",  "orange")}
        ${stat(expiring1.length,   "Expiring tomorrow",   "red")}
        ${stat(expiredRecent.length,"Expired this week",   "gray")}
      </div>

      ${expiryTable("⏰ Expiring in 4–7 Days", expiring7,     "yellow")}
      ${expiryTable("⚠️ Expiring in 1–3 Days", expiring3,     "orange")}
      ${expiryTable("🔴 Expiring Within 24 Hours", expiring1, "red")}
      ${expiryTable("❌ Expired This Week", expiredRecent,    "orange")}
      ${expiryTable("💀 Expired Last 30 Days", expiredOld,    "gray")}
    `));
  } catch (err) {
    res.send(layout("Expiry", `<div class="alert red">Error: ${err.message}</div>`));
  }
});

// POST /zq-admin/expiry/notify-one  →  Notify a single supplier
router.post("/expiry/notify-one", requireSupplierAdmin, async (req, res) => {
  try {
    const { supplierId, notifyType } = req.body;
    const supplier = await SupplierProfile.findById(supplierId).lean();
    if (!supplier) return res.redirect("/zq-admin/expiry");

    const {
      notifySupplierSubscriptionExpiring,
      notifySupplierSubscriptionExpired
    } = await import("../services/supplierNotifications.js");

    if (notifyType === "expired") {
      await notifySupplierSubscriptionExpired(supplier.phone, supplier.businessName, supplier.subscriptionExpiresAt);
    } else {
      await notifySupplierSubscriptionExpiring(supplier.phone, supplier.businessName, supplier.subscriptionExpiresAt);
    }

    res.redirect(
      `/zq-admin/expiry?success=${encodeURIComponent(
        `Reminder sent to ${supplier.businessName} (${supplier.phone})`
      )}`
    );
  } catch (err) {
    res.send(layout("Error", `<div class="alert red">${err.message}</div>`));
  }
});

// POST /zq-admin/expiry/notify-bulk  →  Notify a group of suppliers
router.post("/expiry/notify-bulk", requireSupplierAdmin, async (req, res) => {
  try {
    const { ids, notifyType } = req.body;
    const idList = (ids || "").split(",").map(id => id.trim()).filter(Boolean);
    const suppliers = await SupplierProfile.find({ _id: { $in: idList } }).lean();

    const {
      notifySupplierSubscriptionExpiring,
      notifySupplierSubscriptionExpired
    } = await import("../services/supplierNotifications.js");

    let sent = 0;
    for (const s of suppliers) {
      try {
        if (notifyType === "expired") {
          await notifySupplierSubscriptionExpired(s.phone, s.businessName, s.subscriptionExpiresAt);
        } else {
          await notifySupplierSubscriptionExpiring(s.phone, s.businessName, s.subscriptionExpiresAt);
        }
        sent++;
      } catch (_) {}
      await new Promise(r => setTimeout(r, 300));
    }

    res.redirect(
      `/zq-admin/expiry?success=${encodeURIComponent(
        `Bulk reminder sent: ${sent} of ${suppliers.length} suppliers notified`
      )}`
    );
  } catch (err) {
    res.send(layout("Error", `<div class="alert red">${err.message}</div>`));
  }
});


// ══════════════════════════════════════════════════════════════════════════════
// ── SIDEBAR NAV UPDATE ────────────────────────────────────────────────────────
// In the layout() function near the bottom of supplierAdmin.js,
// find the `nav` array and ADD these items:
//
//   { href: "/zq-admin/broadcast-offer", label: "📣 Broadcast Offer",
//     match: req.path.startsWith("/broadcast-offer") },
//   { href: "/zq-admin/expiry",           label: "⏰ Subscriptions",
//     match: req.path.startsWith("/expiry") },
//
// ALSO add "📤 Send Offer" and "🧾 Receipt" buttons in the supplier manage
// page action-row (around line 775-799 in the original supplierAdmin.js):
//
//   <a href="/zq-admin/suppliers/${supplier._id}/send-offer" class="btn btn-blue">
//     📣 Send Offer
//   </a>
//
//   <a href="/zq-admin/suppliers/${supplier._id}/receipt" class="btn btn-green">
//     🧾 Generate Receipt
//   </a>
// ══════════════════════════════════════════════════════════════════════════════
// ─────────────────────────────────────────────────────────────────────────────
// SEARCH COMMAND LOGS - Buyer command flow tracking
// ─────────────────────────────────────────────────────────────────────────────
router.get("/search-logs", requireSupplierAdmin, async (req, res) => {
  try {
    const { q = "", page = 1 } = req.query;

    const limit = 30;
    const skip = (Number(page) - 1) * limit;

    const match = {};

    if (q) {
      match.$or = [
        { phone: { $regex: q, $options: "i" } },
        { rawText: { $regex: q, $options: "i" } },
        { normalizedText: { $regex: q, $options: "i" } },
        { "parsed.product": { $regex: q, $options: "i" } },
        { "parsed.service": { $regex: q, $options: "i" } },
        { "parsed.city": { $regex: q, $options: "i" } },
        { "parsed.area": { $regex: q, $options: "i" } }
      ];
    }

    const contactsAgg = await SearchCommandLog.aggregate([
      { $match: match },
      { $sort: { createdAt: -1 } },
      {
        $group: {
          _id: "$phone",
          phone: { $first: "$phone" },
          lastText: { $first: "$rawText" },
          lastFlow: { $first: "$flow" },
          lastSource: { $first: "$source" },
          lastResultMode: { $first: "$resultMode" },
          lastSessionState: { $first: "$sessionState" },
          lastSeenAt: { $first: "$createdAt" },
          totalRecords: { $sum: 1 },
          noResultCount: {
            $sum: { $cond: [{ $eq: ["$resultMode", "none"] }, 1, 0] }
          },
          errorCount: {
            $sum: { $cond: [{ $eq: ["$resultMode", "error"] }, 1, 0] }
          },
          helpedCount: {
            $sum: { $cond: ["$helped", 1, 0] }
          }
        }
      },
      { $sort: { lastSeenAt: -1 } },
      {
        $facet: {
          rows: [{ $skip: skip }, { $limit: limit }],
          total: [{ $count: "count" }]
        }
      }
    ]);

    const rows = contactsAgg[0]?.rows || [];
    const total = contactsAgg[0]?.total?.[0]?.count || 0;
    const pages = Math.ceil(total / limit);
    const qs = p => `?page=${p}&q=${encodeURIComponent(q)}`;

    res.send(layout("Search Logs", `
      <div class="panel">
        <div class="panel-head">
          <h3>👥 Contact Activity <span class="count">${total}</span></h3>
        </div>

        <form method="GET" class="filter-form" style="margin-bottom:16px">
          <input name="q" placeholder="Search contact, text, product, city..." value="${esc(q)}" />
          <button type="submit">Search</button>
          <a href="/zq-admin/search-logs" class="btn-reset">Clear</a>
        </form>

        <table>
          <thead>
            <tr>
              <th>Contact</th>
              <th>Last Activity</th>
              <th>Last Text / Command</th>
              <th>Flow</th>
              <th>Records</th>
              <th>Issues</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            ${rows.map(c => `
              <tr>
                <td>
                  <strong>
                    <a href="/zq-admin/search-logs/contact/${esc(c.phone)}" class="btn-link">
                      ${esc(c.phone)}
                    </a>
                  </strong>
                  <br>
                  <a href="https://wa.me/${esc(c.phone)}" target="_blank" class="btn-link">
                    Open WhatsApp
                  </a>
                </td>

                <td>${new Date(c.lastSeenAt).toLocaleString()}</td>

                <td>
                  <strong>${esc(c.lastText || "-")}</strong>
                  <br><small>${esc(c.lastSessionState || "")}</small>
                </td>

                <td>
                  ${badge(c.lastFlow || "unknown", "blue")}
                  <br><small>${esc(c.lastSource || "")}</small>
                </td>

                <td>${badge(`${c.totalRecords || 0} records`, "green")}</td>

                <td>
                  ${c.noResultCount ? badge(`${c.noResultCount} no result`, "orange") : ""}
                  ${c.errorCount ? badge(`${c.errorCount} errors`, "red") : ""}
                  ${c.helpedCount ? badge(`${c.helpedCount} helped`, "blue") : ""}
                  ${!c.noResultCount && !c.errorCount && !c.helpedCount ? "-" : ""}
                </td>

                <td>
                  <a class="btn-link" href="/zq-admin/search-logs/contact/${esc(c.phone)}">
                    View Activity →
                  </a>
                </td>
              </tr>
            `).join("") || `
              <tr>
                <td colspan="7"><em class="muted">No contact activity found yet.</em></td>
              </tr>
            `}
          </tbody>
        </table>

        ${pages > 1 ? `
          <div class="pagination">
            ${Array.from({ length: pages }, (_, i) => i + 1).map(p =>
              `<a href="/zq-admin/search-logs${qs(p)}" class="${Number(page) === p ? "active" : ""}">${p}</a>`
            ).join("")}
          </div>
        ` : ""}
      </div>
    `));
  } catch (err) {
    res.send(layout("Search Logs", `<div class="alert red">Error: ${esc(err.message)}</div>`));
  }
});
router.get("/search-logs/contact/:phone", requireSupplierAdmin, async (req, res) => {
  try {
    const phone = String(req.params.phone || "").replace(/\D+/g, "");

    const logs = await SearchCommandLog.find({ phone })
      .sort({ createdAt: -1 })
      .limit(80)
      .lean();

    res.send(layout(`Contact Search Flow: ${phone}`, `
      <a href="/zq-admin/search-logs" class="back-link">← Back to Search Logs</a>

      <div class="panel">
        <div class="panel-head">
          <h3>📱 Contact Search Flow: ${esc(phone)}</h3>
          <a class="btn btn-green btn-sm" href="https://wa.me/${esc(phone)}" target="_blank">
            Open WhatsApp
          </a>
        </div>

        ${logs.map(l => `
          <div style="border:1px solid #e5e7eb;border-radius:10px;padding:14px;margin-bottom:12px">
            <div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap">
              <strong>${esc(l.rawText || "-")}</strong>
              <small>${new Date(l.createdAt).toLocaleString()}</small>
            </div>

            <p style="margin:8px 0;color:#64748b">
              Parsed:
              <strong>${esc(l.parsed?.product || l.parsed?.service || "-")}</strong>
              ${[l.parsed?.area, l.parsed?.city].filter(Boolean).length
                ? ` • ${esc([l.parsed?.area, l.parsed?.city].filter(Boolean).join(", "))}`
                : ""}
            </p>

            <p>
              ${badge(`${l.resultMode} (${l.resultCount || 0})`,
                l.resultMode === "none" ? "orange" :
                l.resultMode === "error" ? "red" : "green"
              )}
              ${l.helped ? badge("helped", "blue") : ""}
            </p>

            ${l.errorMessage ? `<div class="alert red">${esc(l.errorMessage)}</div>` : ""}

            ${(l.resultsPreview || []).length ? `
              <ol style="margin-left:20px;margin-top:10px">
                ${l.resultsPreview.map(r => `
                  <li>
                    <strong>${esc(r.supplierName || "-")}</strong>
                    ${r.product ? ` - ${esc(r.product)}` : ""}
                    ${r.service ? ` - ${esc(r.service)}` : ""}
                    ${r.priceText ? ` <small>${esc(r.priceText)}</small>` : ""}
                    <br><small>${esc([r.area, r.city].filter(Boolean).join(", "))}</small>
                  </li>
                `).join("")}
              </ol>
            ` : ""}

            <div style="margin-top:10px">
              <a href="/zq-admin/search-logs/${l._id}" class="btn-link">
                Open this search →
              </a>
            </div>
          </div>
        `).join("") || `<div class="alert">No logs found for this contact.</div>`}
      </div>
    `));
  } catch (err) {
    res.send(layout("Contact Search Flow", `<div class="alert red">Error: ${esc(err.message)}</div>`));
  }
});


router.get("/search-logs/:id", requireSupplierAdmin, async (req, res) => {
  try {
    const log = await SearchCommandLog.findById(req.params.id).lean();
    if (!log) return res.redirect("/zq-admin/search-logs");

    const searchText = log.parsed?.product || log.parsed?.service || log.rawText || "";
    const city = log.parsed?.city || "";

    const supplierQuery = { active: true };

    if (city) {
      supplierQuery["location.city"] = { $regex: `^${city}$`, $options: "i" };
    }

    if (searchText) {
      supplierQuery.$or = [
        { businessName: { $regex: searchText, $options: "i" } },
        { products: { $regex: searchText, $options: "i" } },
        { listedProducts: { $regex: searchText, $options: "i" } },
        { "rates.service": { $regex: searchText, $options: "i" } },
        { categories: { $regex: searchText, $options: "i" } }
      ];
    }

    const suggestedSuppliers = await SupplierProfile.find(supplierQuery)
      .sort({ tierRank: -1, rating: -1, createdAt: -1 })
      .limit(10)
      .lean();

    const success = req.query.success
      ? `<div style="background:#dcfce7;color:#16a34a;padding:14px;border-radius:8px;margin-bottom:16px">
           ✅ ${esc(req.query.success)}
         </div>`
      : "";

    res.send(layout("Search Log Detail", `
      <a href="/zq-admin/search-logs" class="back-link">← Back to Search Logs</a>
      ${success}

      <div class="two-col">
        <div class="panel">
          <h3>🔎 Search Details</h3>

          <p><strong>Contact:</strong>
            <a href="/zq-admin/search-logs/contact/${esc(log.phone)}">${esc(log.phone)}</a>
          </p>
          <p><strong>Command:</strong> ${esc(log.rawText || "-")}</p>
          <p><strong>Time:</strong> ${new Date(log.createdAt).toLocaleString()}</p>
          <p><strong>Flow:</strong> ${esc(log.flow || "-")}</p>
          <p><strong>Session:</strong> ${esc(log.sessionState || "-")}</p>
          <p><strong>Parsed:</strong></p>
          <pre style="white-space:pre-wrap;background:#f8fafc;padding:10px;border-radius:8px;border:1px solid #e5e7eb">${esc(JSON.stringify(log.parsed || {}, null, 2))}</pre>

          <p><strong>Result:</strong>
            ${badge(`${log.resultMode} (${log.resultCount || 0})`,
              log.resultMode === "none" ? "orange" :
              log.resultMode === "error" ? "red" : "green"
            )}
          </p>

          ${log.errorMessage ? `<div class="alert red"><strong>Error:</strong><br>${esc(log.errorMessage)}</div>` : ""}

          <h4 style="margin-top:18px">Results Buyer Got</h4>
          ${(log.resultsPreview || []).length ? `
            <ol style="margin-left:20px">
              ${log.resultsPreview.map(r => `
                <li>
                  <strong>${esc(r.supplierName || "-")}</strong>
                  ${r.product ? ` - ${esc(r.product)}` : ""}
                  ${r.service ? ` - ${esc(r.service)}` : ""}
                  ${r.priceText ? ` (${esc(r.priceText)})` : ""}
                  <br><small>${esc([r.area, r.city].filter(Boolean).join(", "))}</small>
                </li>
              `).join("")}
            </ol>
          ` : `<p style="color:#64748b">No results were recorded.</p>`}
        </div>

        <div class="panel">
          <h3>📲 Send Meta Notification</h3>

          <p style="color:#64748b;font-size:13px;margin-bottom:12px">
            This sends the approved template <strong>buyer_request_results_ready</strong>.
            The buyer receives a ZimQuote continuation link, then the chatbot can show results inside WhatsApp.
          </p>

          <form method="POST" action="/zq-admin/search-logs/${log._id}/send-help">
            <div class="fg">
              <label>Request details sent in template</label>
              <input name="searchText" value="${esc(searchText)}" />
            </div>

            <div class="fg">
              <label>Select seller profiles to attach internally</label>
              ${suggestedSuppliers.length ? suggestedSuppliers.map(s => `
                <label style="display:block;margin:8px 0;padding:8px;border:1px solid #e5e7eb;border-radius:8px">
                  <input type="checkbox" name="supplierIds" value="${s._id}">
                  <strong>${esc(s.businessName)}</strong>
                  <small>${esc([s.location?.area, s.location?.city].filter(Boolean).join(", "))}</small>
                </label>
              `).join("") : `<div class="alert orange">No suggested suppliers found. You can still send the continuation template.</div>`}
            </div>

            <button class="btn btn-green" type="submit">
              📲 Send WhatsApp Template
            </button>
          </form>
        </div>
      </div>
    `));
  } catch (err) {
    res.send(layout("Search Log Detail", `<div class="alert red">Error: ${esc(err.message)}</div>`));
  }
});


router.post("/search-logs/:id/send-help", requireSupplierAdmin, async (req, res) => {
  try {
    const log = await SearchCommandLog.findById(req.params.id);
    if (!log) return res.redirect("/zq-admin/search-logs");

    let supplierIds = req.body.supplierIds || [];
    if (!Array.isArray(supplierIds)) supplierIds = supplierIds ? [supplierIds] : [];

    const suppliers = supplierIds.length
      ? await SupplierProfile.find({ _id: { $in: supplierIds } }).lean()
      : [];

    const result = await sendBuyerSearchHelpTemplate({
      phone: log.phone,
      searchText: req.body.searchText || log.rawText,
      suppliers,
      adminNote: ""
    });

    log.helped = true;
    log.helpNote = `Template sent. Reference: ${result.reference || ""}`;
    log.followUpSentAt = new Date();

    log.meta = {
      ...(log.meta || {}),
      followUpReference: result.reference || "",
      followUpContinueLink: result.continueLink || "",
      followUpSupplierIds: supplierIds,
      followUpTemplate: "buyer_request_results_ready",
      followUpOk: Boolean(result.ok)
    };

    await log.save();

    res.redirect(
      `/zq-admin/search-logs/${log._id}?success=${encodeURIComponent(
        result.ok
          ? `Template sent successfully. Reference ${result.reference}`
          : `Fallback message attempted. Reference ${result.reference}`
      )}`
    );
  } catch (err) {
    res.send(layout("Send Help", `<div class="alert red">Error: ${esc(err.message)}</div>`));
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ZIMQUOTE CHATBOT LINK PANEL - SUPPLIERS / SELLERS
// Pure wa.me link. No domain. No slug. No web page.
// Link: https://wa.me/<BOT>?text=ZQ:SUPPLIER:<mongoId>
//
// When tapped opens WhatsApp → ZimQuote bot shows full seller chatbot:
//   instant quote (if prices loaded), RFQ (if no prices),
//   product order, service booking, delivery/collection, stock check.
//
// Routes:
//   GET  /zq-admin/suppliers/:id/chatlink       → panel
//   POST /zq-admin/suppliers/:id/chatlink/send  → send to seller via WA
//   GET  /zq-admin/suppliers/:id/chatlink/qr    → QR poster
// ─────────────────────────────────────────────────────────────────────────────

const SUP_BOT = (process.env.WHATSAPP_BOT_NUMBER || "263771143904").replace(/\D/g, "");

function _waLinkSupplier(id) {
  return `https://wa.me/${SUP_BOT}?text=${encodeURIComponent("ZQ:SUPPLIER:" + id)}`;
}
function _supQrUrl(waLink, size = 300) {
  return `https://api.qrserver.com/v1/create-qr-code/?size=${size}x${size}&data=${encodeURIComponent(waLink)}&color=085041&bgcolor=FFFFFF&qzone=2`;
}

router.get("/suppliers/:id/chatlink", requireSupplierAdmin, async (req, res) => {
     res.redirect(`/zq-admin/suppliers/${req.params.id}/smart-link`);
 });

// ── Send link to seller via WhatsApp ─────────────────────────────────────────
router.post("/suppliers/:id/chatlink/send", requireSupplierAdmin, async (req, res) => {
  try {
    const supplier = await SupplierProfile.findById(req.params.id).lean();
    if (!supplier) return res.redirect("/zq-admin/suppliers");
    const message  = String(req.body.message || "").trim();
    if (!message) return res.redirect(`/zq-admin/suppliers/${supplier._id}/chatlink?error=${encodeURIComponent("Message is empty.")}`);
    const { sendText: _st } = await import("../services/metaSender.js");
    await _st(supplier.phone, message);
    res.redirect(`/zq-admin/suppliers/${supplier._id}/chatlink?success=${encodeURIComponent("Link sent to " + supplier.phone + " via WhatsApp.")}`);
  } catch (err) {
    res.redirect(`/zq-admin/suppliers/${req.params.id}/chatlink?error=${encodeURIComponent("Send failed: " + err.message)}`);
  }
});

// ── QR print poster ───────────────────────────────────────────────────────────
router.get("/suppliers/:id/chatlink/qr", requireSupplierAdmin, async (req, res) => {
  try {
    const supplier = await SupplierProfile.findById(req.params.id).lean();
    if (!supplier) return res.redirect(`/zq-admin/suppliers/${req.params.id}/chatlink`);

    const waLink    = _waLinkSupplier(String(supplier._id));
    const qrImg     = _supQrUrl(waLink, 400);
    const isService = supplier.serviceType === "service" || supplier.profileType === "service";
    const loc       = [supplier.area||supplier.location?.area, supplier.city||supplier.location?.city].filter(Boolean).join(", ");
    const productSample = isService
      ? (supplier.rates  || []).slice(0,4).map(r=>r.service).join(" · ")
      : (supplier.prices || []).slice(0,4).map(p=>p.product).join(" · ");

    res.send(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<title>QR Poster- ${esc(supplier.businessName)}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,"Segoe UI",sans-serif;background:#fff;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;padding:20px}
.poster{width:420px;border:3px solid #085041;border-radius:20px;padding:28px;text-align:center}
.brand{font-size:11px;font-weight:700;color:#0F6E56;letter-spacing:.1em;text-transform:uppercase;margin-bottom:16px}
h1{font-size:22px;font-weight:800;color:#0a1a0a;margin-bottom:6px;line-height:1.2}
.sub{font-size:13px;color:#5a7a5a;margin-bottom:4px}
.type{display:inline-block;margin:10px 0 14px;background:#FAEEDA;color:#854F0B;font-size:12px;font-weight:700;padding:5px 14px;border-radius:20px}
.qrw{margin:0 auto 16px;padding:14px;border:1px solid #E1F5EE;border-radius:14px;display:inline-block;background:#f9fff9}
.qrw img{display:block;width:200px;height:200px}
.cta{font-size:14px;font-weight:700;color:#085041;margin-bottom:6px}
.how{font-size:12px;color:#666;background:#f0faf5;border-radius:8px;padding:8px 12px;margin-bottom:14px;line-height:1.6}
.prods{font-size:12px;color:#5a7a5a;margin-bottom:14px;line-height:1.6}
.foot{font-size:10px;color:#aaa}
.noprint{margin-top:16px;display:flex;gap:10px;justify-content:center}
@media print{.noprint{display:none!important}body{padding:0}}
</style></head><body>
<div class="poster">
  <div class="brand">ZimQuote · Verified ${isService?"Service Provider":"Supplier"}</div>
  <h1>${esc(supplier.businessName)}</h1>
  <p class="sub">📍 ${esc(loc)}</p>
  <span class="type">${isService?"🔧 Services":"🏪 Products"}</span>
  <div class="qrw"><img src="${esc(qrImg)}" alt="Scan to open on WhatsApp"></div>
  <p class="cta">📲 Scan to ${isService?"book a service & get a quote":"see prices & get a quote"}</p>
  ${productSample?`<p class="prods">${esc(productSample)}</p>`:""}
  <div class="how">Open WhatsApp → tap Camera → scan this code<br>See ${isService?"services, rates & book a job":"products, prices & instant quote"}.<br>No app download. Works on any phone.</div>
  <div class="foot">Powered by ZimQuote · zimquote.co.zw</div>
</div>
<div class="noprint">
  <button onclick="window.print()" style="padding:10px 20px;background:#085041;color:#fff;border:none;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer">🖨️ Print Poster</button>
  <a href="/zq-admin/suppliers/${supplier._id}/chatlink" style="padding:10px 20px;background:#e2e8f0;color:#475569;border-radius:8px;font-size:14px;font-weight:600;text-decoration:none">← Back</a>
</div>
</body></html>`);
  } catch (err) {
    res.status(500).send(`<p>Error: ${err.message}</p>`);
  }
});




// ─────────────────────────────────────────────────────────────────────────────
// VIP NOTIFICATION SETTINGS
// GET  /zq-admin/suppliers/:id/vip-settings  → view/edit VIP flags
// POST /zq-admin/suppliers/:id/vip-settings  → save flags
// ─────────────────────────────────────────────────────────────────────────────
router.get("/suppliers/:id/vip-settings", requireSupplierAdmin, async (req, res) => {
  try {
    const supplier = await SupplierProfile.findById(req.params.id).lean();
    if (!supplier) return res.redirect("/zq-admin/suppliers");

    const successMsg = req.query.success
      ? `<div style="background:#dcfce7;color:#16a34a;padding:12px 16px;border-radius:8px;margin-bottom:16px">✅ ${esc(req.query.success)}</div>`
      : "";

    res.send(layout(esc(supplier.businessName), `
      <a href="/zq-admin/suppliers/${supplier._id}" class="back-link">← Back to Profile</a>
      ${successMsg}

      <div class="panel" style="max-width:600px">
        <div class="panel-head">
          <h3>🔒 VIP Notification Settings</h3>
        </div>

        <div style="background:#fef9c3;color:#a16207;border-radius:8px;padding:12px 16px;margin-bottom:18px;font-size:13px;line-height:1.6">
          <strong>What this does:</strong> When enabled, this seller receives an extra follow-up message
          containing the contact number of the person who opened their profile link or sent a request.
          Standard sellers never see these numbers. Only assign to verified, trusted sellers.
        </div>

        <form method="POST" action="/zq-admin/suppliers/${supplier._id}/vip-settings">
          <table style="width:100%;border-collapse:collapse;margin-bottom:20px">
            <thead>
              <tr>
                <th style="text-align:left;padding:10px 12px;background:#f8fafc;border-bottom:2px solid #e2e8f0;font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:.5px">Notification type</th>
                <th style="text-align:left;padding:10px 12px;background:#f8fafc;border-bottom:2px solid #e2e8f0;font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:.5px">What it does</th>
                <th style="text-align:center;padding:10px 12px;background:#f8fafc;border-bottom:2px solid #e2e8f0;font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:.5px">Enabled</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td style="padding:14px 12px;border-bottom:1px solid #f1f5f9;font-weight:600">📦 Request buyer phone</td>
                <td style="padding:14px 12px;border-bottom:1px solid #f1f5f9;color:#64748b;font-size:13px">
                  When a buyer sends a request and this seller is notified, a follow-up message
                  is sent with the buyer's WhatsApp number. Seller can contact them directly.
                </td>
                <td style="padding:14px 12px;border-bottom:1px solid #f1f5f9;text-align:center">
                  <label style="display:inline-flex;align-items:center;gap:8px;cursor:pointer">
                    <input type="checkbox" name="revealBuyerPhone" value="true"
                           ${supplier.revealBuyerPhone ? "checked" : ""}
                           style="width:18px;height:18px;cursor:pointer" />
                    <span style="font-size:13px">${supplier.revealBuyerPhone ? badge("Enabled", "green") : badge("Disabled", "gray")}</span>
                  </label>
                </td>
              </tr>
              <tr>
                <td style="padding:14px 12px;font-weight:600">👁 Smart link visitor phone</td>
                <td style="padding:14px 12px;color:#64748b;font-size:13px">
                  When someone opens this seller's ZimQuote profile link, a follow-up message
                  is sent with the visitor's WhatsApp number. Seller can follow up with them directly.
                </td>
                <td style="padding:14px 12px;text-align:center">
                  <label style="display:inline-flex;align-items:center;gap:8px;cursor:pointer">
                    <input type="checkbox" name="revealVisitorPhone" value="true"
                           ${supplier.revealVisitorPhone ? "checked" : ""}
                           style="width:18px;height:18px;cursor:pointer" />
                    <span style="font-size:13px">${supplier.revealVisitorPhone ? badge("Enabled", "green") : badge("Disabled", "gray")}</span>
                  </label>
                </td>
              </tr>
              <tr>
                <td style="padding:14px 12px;font-weight:600">👥 Contact database (chatbot)</td>
                <td style="padding:14px 12px;color:#64748b;font-size:13px">
                  Seller can type <strong>"my contacts"</strong> in the WhatsApp bot to see a
                  paginated list of every phone number that has opened their smart link or staff card.
                  Only enable for trusted sellers who need lead follow-up capability.
                </td>
                <td style="padding:14px 12px;text-align:center">
                  <label style="display:inline-flex;align-items:center;gap:8px;cursor:pointer">
                    <input type="checkbox" name="canViewContacts" value="true"
                           ${supplier.canViewContacts ? "checked" : ""}
                           style="width:18px;height:18px;cursor:pointer" />
                    <span style="font-size:13px">${supplier.canViewContacts ? badge("Enabled", "green") : badge("Disabled", "gray")}</span>
                  </label>
                </td>
              </tr>
            </tbody>
          </table>

          <div style="display:flex;gap:10px;align-items:center">
            <button type="submit" class="btn btn-purple">🔒 Save VIP Settings</button>
            <a href="/zq-admin/suppliers/${supplier._id}" class="btn btn-gray">Cancel</a>
          </div>
        </form>

        <div style="margin-top:24px;padding-top:18px;border-top:1px solid #e2e8f0">
          <h4 style="font-size:13px;font-weight:600;margin-bottom:10px;color:#64748b">Current VIP sellers (all)</h4>
          <a href="/zq-admin/vip-sellers" class="btn-link" style="font-size:13px">View all VIP sellers →</a>
        </div>
      </div>
    `));
  } catch (err) {
    res.send(layout("Error", `<div class="alert red">${err.message}</div>`));
  }
});

router.post("/suppliers/:id/vip-settings", requireSupplierAdmin, async (req, res) => {
  try {
    const revealBuyerPhone   = req.body.revealBuyerPhone   === "true";
    const revealVisitorPhone = req.body.revealVisitorPhone === "true";
    const canViewContacts    = req.body.canViewContacts    === "true";

    await SupplierProfile.findByIdAndUpdate(req.params.id, {
      $set: { revealBuyerPhone, revealVisitorPhone, canViewContacts }
    });

    const supplier = await SupplierProfile.findById(req.params.id).lean();
    const changes  = [];
    if (revealBuyerPhone)   changes.push("buyer phone on requests");
    if (revealVisitorPhone) changes.push("visitor phone on smart link opens");
    if (canViewContacts)    changes.push("contact database (chatbot)");
    const msg = changes.length
      ? `VIP enabled: ${changes.join(" + ")} for ${supplier?.businessName || "this seller"}`
      : `VIP notifications disabled for ${supplier?.businessName || "this seller"}`;

    res.redirect(`/zq-admin/suppliers/${req.params.id}/vip-settings?success=${encodeURIComponent(msg)}`);
  } catch (err) {
    res.redirect(`/zq-admin/suppliers/${req.params.id}/vip-settings?error=${encodeURIComponent(err.message)}`);
  }
});

// ── VIP Sellers overview page ──────────────────────────────────────────────
router.get("/vip-sellers", requireSupplierAdmin, async (req, res) => {
  try {
    const vipSellers = await SupplierProfile.find({
      $or: [{ revealBuyerPhone: true }, { revealVisitorPhone: true }]
    }).sort({ businessName: 1 }).lean();

    res.send(layout("VIP Sellers", `
      <div class="panel">
        <div class="panel-head">
          <h3>🔒 VIP Sellers <span class="count">${vipSellers.length}</span></h3>
          <p style="font-size:12px;color:var(--muted);margin:0">Sellers who receive buyer or visitor phone numbers in notifications.</p>
        </div>

        ${vipSellers.length ? `
        <table>
          <thead>
            <tr>
              <th>Business</th>
              <th>Phone</th>
              <th>City</th>
              <th>Buyer phone</th>
              <th>Visitor phone</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            ${vipSellers.map(s => `
            <tr>
              <td><strong>${esc(s.businessName)}</strong></td>
              <td><code style="font-size:12px">${esc(s.phone)}</code></td>
              <td>${esc(s.location?.city || "-")}</td>
              <td>${s.revealBuyerPhone ? badge("Enabled", "green") : badge("Off", "gray")}</td>
              <td>${s.revealVisitorPhone ? badge("Enabled", "green") : badge("Off", "gray")}</td>
              <td>
                <a href="/zq-admin/suppliers/${s._id}/vip-settings" class="btn-link">Edit →</a>
                <a href="/zq-admin/suppliers/${s._id}/contacts" class="btn-link" style="margin-left:8px">👥 Contacts →</a>
              </td>
            </tr>`).join("")}
          </tbody>
        </table>` : `
        <div style="padding:20px;color:var(--muted);font-size:13px">
          No VIP sellers yet. Go to any supplier profile and click
          <strong>🔒 VIP Notifications</strong> to assign phone reveal.
        </div>`}
      </div>
    `));
  } catch (err) {
    res.send(layout("VIP Sellers", `<div class="alert red">${err.message}</div>`));
  }
});

router.use("/suppliers/:id/smart-link", smartLinkRoutes);

// ─────────────────────────────────────────────────────────────────────────────
// SUPPLIER SMART LINK CONTACTS VIEWER
// GET  /zq-admin/suppliers/:id/contacts           → all visitors for this supplier
// GET  /zq-admin/suppliers/:id/contacts/staff/:cardId → visitors for a staff card
// POST /zq-admin/suppliers/:id/contacts/export    → CSV download
// ─────────────────────────────────────────────────────────────────────────────

router.get("/suppliers/:id/contacts", requireSupplierAdmin, async (req, res) => {
  try {
    const supplier = await SupplierProfile.findById(req.params.id).lean();
    if (!supplier) return res.redirect("/zq-admin/suppliers");

    const page     = Math.max(0, parseInt(req.query.page || "0", 10));
    const pageSize = 50;
    const linkType = req.query.type === "staff" ? "staff" : "supplier";

    const query = linkType === "staff"
      ? { supplierId: supplier._id, linkType: "staff" }
      : { supplierId: supplier._id, linkType: "supplier" };

    const [total, visitors] = await Promise.all([
      SupplierLinkVisitor.countDocuments(query),
      SupplierLinkVisitor.find(query)
        .sort({ lastSeen: -1 })
        .skip(page * pageSize)
        .limit(pageSize)
        .lean()
    ]);

    // Load staff cards for the tab links
    const { StaffCard: _StaffCardModel } = await _loadStaffModules() || {};
    const staffCards = _StaffCardModel
      ? await _StaffCardModel.find({ supplierId: supplier._id }).lean()
      : [];

    const totalPages = Math.ceil(total / pageSize);
    const srcLabel = { fb:"Facebook", wa:"WhatsApp Status", tt:"TikTok", qr:"QR Scan", sms:"SMS/Flyer", ig:"Instagram", yt:"YouTube", direct:"Direct" };

    const successMsg = req.query.success
      ? `<div style="background:#dcfce7;color:#16a34a;padding:12px 16px;border-radius:8px;margin-bottom:16px">✅ ${esc(req.query.success)}</div>`
      : "";

    res.send(layout(`Contacts: ${esc(supplier.businessName)}`, `
      <a href="/zq-admin/suppliers/${supplier._id}" class="back-link">← Back to Profile</a>
      ${successMsg}

      <div class="panel">
        <div class="panel-head" style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:10px">
          <div>
            <h3>👥 Smart Link Contacts - ${esc(supplier.businessName)}</h3>
            <p style="font-size:12px;color:var(--muted);margin:4px 0 0">
              Every WhatsApp number that opened this supplier's smart link or staff card.
              ${supplier.canViewContacts ? badge("Chatbot Access ON", "green") : badge("Chatbot Access OFF", "gray")}
            </p>
          </div>
          <div style="display:flex;gap:8px;flex-wrap:wrap">
            <a href="/zq-admin/suppliers/${supplier._id}/contacts/export?type=${linkType}" class="btn btn-gray" style="font-size:13px">⬇ Export CSV</a>
            <a href="/zq-admin/suppliers/${supplier._id}/vip-settings" class="btn btn-purple" style="font-size:13px">🔒 VIP Settings</a>
          </div>
        </div>

        <!-- Type tabs -->
        <div style="display:flex;gap:4px;margin-bottom:16px;border-bottom:2px solid var(--border);padding-bottom:0">
          <a href="?type=supplier" style="padding:8px 16px;font-size:13px;font-weight:600;border-radius:6px 6px 0 0;text-decoration:none;
            ${linkType === "supplier" ? "background:var(--blue);color:white" : "color:var(--muted)"}">
            🏪 Supplier Link (${linkType === "supplier" ? total : "?"})
          </a>
          <a href="?type=staff" style="padding:8px 16px;font-size:13px;font-weight:600;border-radius:6px 6px 0 0;text-decoration:none;
            ${linkType === "staff" ? "background:var(--blue);color:white" : "color:var(--muted)"}">
            👤 Staff Cards (${linkType === "staff" ? total : "?"})
          </a>
        </div>

        ${!total ? `
        <div style="padding:40px;text-align:center;color:var(--muted)">
          <div style="font-size:40px;margin-bottom:12px">📭</div>
          <p>No contacts recorded yet for this ${linkType === "staff" ? "staff card" : "supplier link"}.</p>
          <p style="font-size:12px;margin-top:8px">Contacts are captured automatically when someone opens the smart link via WhatsApp.</p>
        </div>` : `

        <div style="display:flex;gap:16px;margin-bottom:16px;flex-wrap:wrap">
          ${stat(total, "Total contacts", "blue")}
          ${stat(visitors.filter(v => v.converted).length + (page > 0 ? "+" : ""), "Conversions (this page)", "green")}
          ${stat(visitors.filter(v => v.source === "qr").length + (page > 0 ? "+" : ""), "QR scans (this page)", "")}
        </div>

        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>Phone</th>
              <th>Source</th>
              ${linkType === "staff" ? "<th>Staff Card</th>" : ""}
              <th>Views</th>
              <th>First seen</th>
              <th>Last seen</th>
              <th>Converted</th>
            </tr>
          </thead>
          <tbody>
            ${visitors.map((v, i) => {
              const dispPhone = v.phone.startsWith("263") ? "0" + v.phone.slice(3) : v.phone;
              const firstD = new Date(v.firstSeen).toLocaleDateString("en-GB", { day:"numeric", month:"short", year:"2-digit" });
              const lastD  = new Date(v.lastSeen).toLocaleDateString("en-GB", { day:"numeric", month:"short", year:"2-digit" });
              const staffName = linkType === "staff" && staffCards.length
                ? (staffCards.find(c => String(c._id) === String(v.staffCardId))?.name || "-")
                : "";
              return `
              <tr>
                <td style="color:var(--muted);font-size:12px">${page * pageSize + i + 1}</td>
                <td>
                  <a href="/zq-admin/search-logs/contact/${esc(v.phone)}" class="btn-link" style="font-weight:600">${esc(dispPhone)}</a>
                </td>
                <td>${badge(srcLabel[v.source] || v.source, v.source === "qr" ? "blue" : v.source === "fb" ? "blue" : "gray")}</td>
                ${linkType === "staff" ? `<td style="font-size:12px;color:var(--muted)">${esc(staffName)}</td>` : ""}
                <td>${v.viewCount}</td>
                <td style="font-size:12px;color:var(--muted)">${firstD}</td>
                <td style="font-size:12px;color:var(--muted)">${lastD}</td>
                <td>${v.converted ? badge("✅ Yes", "green") : badge("No", "gray")}</td>
              </tr>`;
            }).join("")}
          </tbody>
        </table>

        ${totalPages > 1 ? `
        <div style="display:flex;gap:8px;justify-content:center;padding:16px 0;flex-wrap:wrap">
          ${page > 0 ? `<a href="?type=${linkType}&page=${page-1}" class="btn btn-gray">← Prev</a>` : ""}
          <span style="padding:8px 12px;font-size:13px;color:var(--muted)">Page ${page+1} of ${totalPages}</span>
          ${page < totalPages-1 ? `<a href="?type=${linkType}&page=${page+1}" class="btn btn-blue">Next →</a>` : ""}
        </div>` : ""}
        `}
      </div>
    `));
  } catch (err) {
    res.send(layout("Error", `<div class="alert red">${err.message}</div>`));
  }
});

// ── CSV export ────────────────────────────────────────────────────────────────
router.get("/suppliers/:id/contacts/export", requireSupplierAdmin, async (req, res) => {
  try {
    const supplier = await SupplierProfile.findById(req.params.id).lean();
    if (!supplier) return res.status(404).send("Not found");

    const linkType = req.query.type === "staff" ? "staff" : "supplier";
    const visitors = await SupplierLinkVisitor.find({ supplierId: supplier._id, linkType })
      .sort({ lastSeen: -1 }).lean();

    const rows = [
      ["Phone", "Display Phone", "Source", "Views", "First Seen", "Last Seen", "Converted", "Converted At"]
    ];
    for (const v of visitors) {
      const disp = v.phone.startsWith("263") ? "0" + v.phone.slice(3) : v.phone;
      rows.push([
        v.phone,
        disp,
        v.source,
        v.viewCount,
        v.firstSeen ? new Date(v.firstSeen).toISOString().slice(0,10) : "",
        v.lastSeen  ? new Date(v.lastSeen).toISOString().slice(0,10) : "",
        v.converted ? "Yes" : "No",
        v.convertedAt ? new Date(v.convertedAt).toISOString().slice(0,10) : ""
      ]);
    }

    const csv = rows.map(r => r.map(c => `"${String(c).replace(/"/g,'""')}"`).join(",")).join("\n");
    const filename = `${supplier.businessName.replace(/\s+/g,"_")}_${linkType}_contacts_${new Date().toISOString().slice(0,10)}.csv`;
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(csv);
  } catch (err) {
    res.status(500).send(err.message);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// SEARCH COMMAND LOGS - Buyer command flow tracking
// ─────────────────────────────────────────────────────────────────────────────




router.get("/search-logs/contact/:phone", requireSupplierAdmin, async (req, res) => {
  try {
    const phone = String(req.params.phone || "").replace(/\D+/g, "");

    const logs = await SearchCommandLog.find({ phone })
      .sort({ createdAt: -1 })
      .limit(80)
      .lean();

    res.send(layout(`Contact Search Flow: ${phone}`, `
      <a href="/zq-admin/search-logs" class="back-link">← Back to Search Logs</a>

      <div class="panel">
        <div class="panel-head">
          <h3>📱 ${esc(phone)}</h3>
          <a class="btn btn-green btn-sm" href="https://wa.me/${esc(phone)}" target="_blank">Open WhatsApp</a>
        </div>

        ${logs.map(l => `
          <div style="border:1px solid #e5e7eb;border-radius:10px;padding:14px;margin-bottom:12px">
            <div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap">
              <strong>${esc(l.rawText || "-")}</strong>
              <small>${new Date(l.createdAt).toLocaleString()}</small>
            </div>

            <p style="margin:8px 0;color:#64748b">
              Parsed: <strong>${esc(l.parsed?.product || l.parsed?.service || "-")}</strong>
              ${[l.parsed?.area, l.parsed?.city].filter(Boolean).length ? ` • ${esc([l.parsed?.area, l.parsed?.city].filter(Boolean).join(", "))}` : ""}
            </p>

            <p>
              ${badge(`${l.resultMode} (${l.resultCount || 0})`, l.resultMode === "none" ? "orange" : l.resultMode === "error" ? "red" : "green")}
              ${l.helped ? badge("helped", "blue") : ""}
            </p>

            ${l.errorMessage ? `<div class="alert red">${esc(l.errorMessage)}</div>` : ""}

            ${(l.resultsPreview || []).length ? `
              <ol style="margin-left:20px;margin-top:10px">
                ${l.resultsPreview.map(r => `
                  <li>
                    <strong>${esc(r.supplierName || "-")}</strong>
                    ${r.product ? ` - ${esc(r.product)}` : ""}
                    ${r.priceText ? ` <small>${esc(r.priceText)}</small>` : ""}
                    <br><small>${esc([r.area, r.city].filter(Boolean).join(", "))}</small>
                  </li>
                `).join("")}
              </ol>
            ` : ""}

            <div style="margin-top:10px">
              <a href="/zq-admin/search-logs/${l._id}" class="btn-link">Open this search →</a>
            </div>
          </div>
        `).join("") || `<div class="alert">No logs found for this contact.</div>`}
      </div>
    `));
  } catch (err) {
    res.send(layout("Contact Search Flow", `<div class="alert red">Error: ${esc(err.message)}</div>`));
  }
});


router.get("/search-logs/:id", requireSupplierAdmin, async (req, res) => {
  try {
    const log = await SearchCommandLog.findById(req.params.id).lean();
    if (!log) return res.redirect("/zq-admin/search-logs");

    const searchText = log.parsed?.product || log.parsed?.service || log.rawText || "";
    const city = log.parsed?.city || "";

    const supplierQuery = { active: true };

    if (city) {
      supplierQuery["location.city"] = { $regex: `^${city}$`, $options: "i" };
    }

    if (searchText) {
      supplierQuery.$or = [
        { businessName: { $regex: searchText, $options: "i" } },
        { products: { $regex: searchText, $options: "i" } },
        { listedProducts: { $regex: searchText, $options: "i" } },
        { "rates.service": { $regex: searchText, $options: "i" } },
        { categories: { $regex: searchText, $options: "i" } }
      ];
    }

    const suggestedSuppliers = await SupplierProfile.find(supplierQuery)
      .sort({ tierRank: -1, rating: -1, createdAt: -1 })
      .limit(10)
      .lean();

    res.send(layout("Search Log Detail", `
      <a href="/zq-admin/search-logs" class="back-link">← Back to Search Logs</a>

      <div class="two-col">
        <div class="panel">
          <h3>🔎 Search Details</h3>

          <p><strong>Contact:</strong> <a href="/zq-admin/search-logs/contact/${esc(log.phone)}">${esc(log.phone)}</a></p>
          <p><strong>Command:</strong> ${esc(log.rawText || "-")}</p>
          <p><strong>Time:</strong> ${new Date(log.createdAt).toLocaleString()}</p>
          <p><strong>Flow:</strong> ${esc(log.flow)}</p>
          <p><strong>Session:</strong> ${esc(log.sessionState || "-")}</p>
          <p><strong>Parsed:</strong> ${esc(JSON.stringify(log.parsed || {}, null, 2))}</p>
          <p><strong>Result:</strong> ${badge(`${log.resultMode} (${log.resultCount || 0})`, log.resultMode === "none" ? "orange" : log.resultMode === "error" ? "red" : "green")}</p>

          ${log.errorMessage ? `<div class="alert red"><strong>Error:</strong><br>${esc(log.errorMessage)}</div>` : ""}

          <h4 style="margin-top:18px">Results Buyer Got</h4>
          ${(log.resultsPreview || []).length ? `
            <ol style="margin-left:20px">
              ${log.resultsPreview.map(r => `
                <li>
                  <strong>${esc(r.supplierName || "-")}</strong>
                  ${r.product ? ` - ${esc(r.product)}` : ""}
                  ${r.priceText ? ` (${esc(r.priceText)})` : ""}
                  <br><small>${esc([r.area, r.city].filter(Boolean).join(", "))}</small>
                </li>
              `).join("")}
            </ol>
          ` : `<p style="color:#64748b">No results were recorded.</p>`}
        </div>

        <div class="panel">
          <h3>🛟 Help This Buyer</h3>

          <form method="POST" action="/zq-admin/search-logs/${log._id}/send-help">
            <div class="fg">
              <label>Admin note to buyer</label>
              <textarea name="adminNote" rows="4">We noticed your search may not have returned the right results. Here are sellers that may help.</textarea>
            </div>

            <div class="fg">
              <label>Select seller profiles to send</label>
              ${suggestedSuppliers.length ? suggestedSuppliers.map(s => `
                <label style="display:block;margin:8px 0;padding:8px;border:1px solid #e5e7eb;border-radius:8px">
                  <input type="checkbox" name="supplierIds" value="${s._id}">
                  <strong>${esc(s.businessName)}</strong>
                  <small>${esc([s.location?.area, s.location?.city].filter(Boolean).join(", "))}</small>
                </label>
              `).join("") : `<div class="alert orange">No suggested suppliers found. Search manually from Suppliers and follow up directly.</div>`}
            </div>

            <button class="btn btn-green" type="submit">📲 Send WhatsApp Follow-up</button>
          </form>
        </div>
      </div>
    `));
  } catch (err) {
    res.send(layout("Search Log Detail", `<div class="alert red">Error: ${esc(err.message)}</div>`));
  }
});


router.post("/search-logs/:id/send-help", requireSupplierAdmin, async (req, res) => {
  try {
    const log = await SearchCommandLog.findById(req.params.id);
    if (!log) return res.redirect("/zq-admin/search-logs");

    let supplierIds = req.body.supplierIds || [];
    if (!Array.isArray(supplierIds)) supplierIds = [supplierIds];

    const suppliers = await SupplierProfile.find({ _id: { $in: supplierIds } }).lean();

    await sendBuyerSearchHelpTemplate({
      phone: log.phone,
      searchText: log.rawText,
      suppliers,
      adminNote: req.body.adminNote || ""
    });

    log.helped = true;
    log.helpNote = req.body.adminNote || "";
    log.followUpSentAt = new Date();
    await log.save();

    res.redirect(`/zq-admin/search-logs/${log._id}?success=1`);
  } catch (err) {
    res.send(layout("Send Help", `<div class="alert red">Error: ${esc(err.message)}</div>`));
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// 📸 PHOTO REQUEST REVIEW
// List: /zq-admin/requests/pending-photos
// Single review: /zq-admin/requests/:id/review
// Approve POST: /zq-admin/requests/:id/approve-photo
// Reject POST:  /zq-admin/requests/:id/reject-photo
// ══════════════════════════════════════════════════════════════════════════════

// ── List: all requests with pending photos ────────────────────────────────────
router.get("/requests/pending-photos", requireSupplierAdmin, async (req, res) => {
  try {
    const pending = await BuyerRequest.find({ imageStatus: "pending_review" })
      .sort({ createdAt: -1 })
      .limit(100)
      .lean();

    const rows = pending.map(r => {
      const ref      = `REQ-${String(r._id).slice(-6).toUpperCase()}`;
      const items    = (r.items || []).map(it => `${it.product} x${it.quantity || 1}`).join(", ");
      const location = r.area ? `${r.area}, ${r.city || ""}` : r.city || "-";
      const age      = Math.round((Date.now() - new Date(r.createdAt).getTime()) / 60000);
      return `
        <tr>
          <td><strong>${esc(ref)}</strong></td>
          <td>${esc(items.slice(0, 80))}</td>
          <td>${esc(location)}</td>
          <td>${age < 60 ? age + "m ago" : Math.round(age / 60) + "h ago"}</td>
          <td><img src="${esc(r.imageUrl)}" style="width:60px;height:60px;object-fit:cover;border-radius:6px;cursor:pointer"
               onclick="window.open('${esc(r.imageUrl)}','_blank')" /></td>
          <td>
            <a href="/zq-admin/requests/${r._id}/review" class="btn btn-blue btn-sm">Review →</a>
          </td>
        </tr>`;
    }).join("");

    res.send(layout("📸 Pending Photo Requests", `
      <a href="/zq-admin" class="back-link">← Dashboard</a>
      <div class="panel">
        <h3>📸 Photo Requests - Awaiting Review (${pending.length})</h3>
        ${pending.length === 0 ? '<p style="color:var(--muted)">No pending photo requests.</p>' : `
        <table class="data-table" style="width:100%">
          <thead><tr>
            <th>Ref</th><th>Items</th><th>Location</th><th>Age</th><th>Photo</th><th>Action</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>`}
      </div>
    `));
  } catch (err) {
    res.send(layout("Error", `<div class="alert red">${esc(err.message)}</div>`));
  }
});

// ── Single review page ────────────────────────────────────────────────────────
router.get("/requests/:id/review", requireSupplierAdmin, async (req, res) => {
  try {
    const r = await BuyerRequest.findById(req.params.id).lean();
    if (!r) return res.redirect("/zq-admin/requests/pending-photos");

    const ref      = `REQ-${String(r._id).slice(-6).toUpperCase()}`;
    const items    = (r.items || []).map((it, i) => `${i + 1}. ${it.product} × ${it.quantity || 1}`).join("<br>");
    const location = r.area ? `${r.area}, ${r.city || ""}` : r.city || "-";
    const statusBadge = r.imageStatus === "pending_review"
      ? `<span style="background:#fef3c7;color:#92400e;padding:3px 10px;border-radius:20px;font-size:12px">⏳ Pending Review</span>`
      : r.imageStatus === "approved"
        ? `<span style="background:#d1fae5;color:#065f46;padding:3px 10px;border-radius:20px;font-size:12px">✅ Approved</span>`
        : `<span style="background:#fee2e2;color:#991b1b;padding:3px 10px;border-radius:20px;font-size:12px">❌ Rejected</span>`;

    res.send(layout(`Review ${esc(ref)}`, `
      <a href="/zq-admin/requests/pending-photos" class="back-link">← Pending Photos</a>
      <div class="panel" style="max-width:700px">
        <h3>📸 Photo Review - ${esc(ref)}</h3>
        <div style="display:flex;gap:24px;flex-wrap:wrap;margin-bottom:20px">
          <div style="flex:1;min-width:240px">
            <p style="color:var(--muted);font-size:12px;margin-bottom:4px">BUYER</p>
            <p>${esc(r.buyerPhone)}</p>
            <p style="color:var(--muted);font-size:12px;margin:12px 0 4px">ITEMS REQUESTED</p>
            <p>${items}</p>
            <p style="color:var(--muted);font-size:12px;margin:12px 0 4px">LOCATION</p>
            <p>${esc(location)}</p>
            ${r.imageCaption ? `<p style="color:var(--muted);font-size:12px;margin:12px 0 4px">BUYER'S CAPTION</p><p><em>${esc(r.imageCaption)}</em></p>` : ""}
            <p style="margin-top:12px">${statusBadge}</p>
          </div>
          <div style="flex:0 0 280px">
            <p style="color:var(--muted);font-size:12px;margin-bottom:8px">ATTACHED PHOTO</p>
            <div id="img-wrap">
              <a href="${esc(r.imageUrl)}" target="_blank" id="img-link">
                <img src="${esc(r.imageUrl)}"
                     style="width:100%;max-width:280px;border-radius:10px;border:1px solid var(--border);display:block"
                     onerror="document.getElementById('img-broken').style.display='block';document.getElementById('img-link').style.display='none'" />
              </a>
              <div id="img-broken" style="display:none;background:#fef3c7;border:1px solid #f59e0b;border-radius:8px;padding:12px;font-size:12px;margin-top:4px">
                <strong>⚠️ Image cannot be displayed in browser</strong><br><br>
                This is usually because <strong>express.static is not serving the <code>docs/</code> folder</strong>,
                or <code>SITE_URL</code> is wrong in your <code>.env</code>.<br><br>
                <strong>Fix - add to your Express app (app.js / server.js):</strong><br>
                <code style="background:#fff;padding:4px 8px;border-radius:4px;display:block;margin:6px 0;font-size:11px">
                  app.use('/docs', express.static(path.join(__dirname, 'docs')));
                </code>
                <strong>Also verify in .env:</strong><br>
                <code style="background:#fff;padding:4px 8px;border-radius:4px;display:block;margin:6px 0;font-size:11px">
                  SITE_URL=https://yourdomain.com
                </code>
                <hr style="margin:8px 0;border-color:#f59e0b">
                Raw URL (right-click → open in new tab to test):<br>
                <a href="${esc(r.imageUrl)}" target="_blank" style="color:#1d4ed8;word-break:break-all;font-size:11px">${esc(r.imageUrl)}</a>
              </div>
            </div>
            <p style="font-size:11px;color:var(--muted);margin-top:4px">Click to open full size</p>
          </div>
        </div>

        ${r.imageStatus === "pending_review" ? `
        <div style="display:flex;gap:12px;flex-wrap:wrap;margin-top:12px">
          <form method="POST" action="/zq-admin/requests/${r._id}/approve-photo" style="flex:1">
            <button type="submit" class="btn btn-blue" style="width:100%;padding:12px">✅ Approve - Send to Sellers</button>
          </form>
          <form method="POST" action="/zq-admin/requests/${r._id}/reject-photo" style="flex:1">
            <select name="reason" style="width:100%;padding:10px;border:1px solid var(--border);border-radius:7px;margin-bottom:8px;font-size:13px">
              <option value="Photo did not meet our content guidelines">Photo did not meet guidelines</option>
              <option value="Photo is not related to the request">Photo not related to request</option>
              <option value="Photo quality is too low to be useful for sellers">Photo quality too low</option>
              <option value="Photo contains inappropriate content">Inappropriate content</option>
              <option value="Other - please resubmit with a clearer photo">Other - please resubmit</option>
            </select>
            <button type="submit" style="width:100%;padding:12px;background:#ef4444;color:white;border:none;border-radius:8px;cursor:pointer;font-size:14px;font-weight:600">❌ Reject - Notify Buyer</button>
          </form>
        </div>
        ` : `<p style="color:var(--muted);font-size:13px;margin-top:8px">This request has already been ${r.imageStatus}${r.imageRejectionReason ? ": " + r.imageRejectionReason : ""}.</p>`}
      </div>
    `));
  } catch (err) {
    res.send(layout("Error", `<div class="alert red">${esc(err.message)}</div>`));
  }
});

// ── Approve photo: notify suppliers + buyer ───────────────────────────────────
router.post("/requests/:id/approve-photo", requireSupplierAdmin, async (req, res) => {
  try {
    const r = await BuyerRequest.findById(req.params.id);
    if (!r) return res.redirect("/zq-admin/requests/pending-photos");

    r.imageStatus     = "approved";
    r.imageReviewedAt = new Date();
    r.imageReviewedBy = "admin";
    await r.save();

    // 1. Notify suppliers - sets awaiting_offer_intro session for each matched seller
    let notifiedCount = 0;
    let notifiedSuppliers = [];
    try {
      const { notifySuppliersOfBuyerRequest: _notifyFn, findSuppliersForBuyerRequest: _findFn } = await import("../services/chatbotEngine.js");
      notifiedCount = await _notifyFn(r);
    } catch (err) {
      console.warn("[ADMIN APPROVE] notifySuppliersOfBuyerRequest failed:", err.message);
    }

    // 2. If request has an image, immediately send it to all matched suppliers
    //    This is belt-and-suspenders: the chatbotEngine also sends it when the seller
    //    first replies, but this ensures instant delivery without waiting for a reply.
    if (r.imageUrl && r.imageStatus === "approved") {
      try {
        const { sendImage } = await import("../services/metaSender.js");
        const SupplierProfile = (await import("../models/supplierProfile.js")).default;
        const UserSession     = (await import("../models/userSession.js")).default;

        // Find all suppliers who just got set to awaiting_offer_intro for this request
        const _sessionsForReq = await UserSession.find({
          "tempData.sellerRequestId":         String(r._id),
          "tempData.sellerRequestReplyState": "awaiting_offer_intro"
        }).lean();

        const _ref = `REQ-${String(r._id).slice(-6).toUpperCase()}`;

        for (const _sess of _sessionsForReq) {
          const _supplierPhone = _sess.phone;
          if (!_supplierPhone) continue;
          const _wa = _supplierPhone.startsWith("0") ? "263" + _supplierPhone.slice(1) : _supplierPhone;
          try {
            await sendImage(_wa, {
              imageUrl: r.imageUrl,
              caption:  r.imageCaption
                ? `📸 Buyer photo for ${_ref}: ${r.imageCaption}`
                : `📸 Buyer attached a photo for request ${_ref}`
            });
            console.log(`[ADMIN APPROVE] Image sent to ${_wa} for ${_ref}`);
          } catch (_imgErr) {
            console.warn(`[ADMIN APPROVE] Could not send image to ${_wa}: ${_imgErr.message}`);
          }
        }
      } catch (imgErr) {
        console.warn("[ADMIN APPROVE] Image broadcast error:", imgErr.message);
      }
    }

    // 3. Notify buyer via template (works outside 24hr session)
    const ref         = `REQ-${String(r._id).slice(-6).toUpperCase()}`;
    const itemSummary = (r.items || []).slice(0, 3).map((it, i) => `${i + 1}. ${it.product} x${it.quantity || 1}`).join(", ");
    await notifyBuyerRequestApproved({ buyerPhone: r.buyerPhone, ref, itemSummary, notifiedCount });

    console.log(`[ADMIN APPROVE] ${ref} approved. imageUrl: ${r.imageUrl || "none"} notified: ${notifiedCount}`);
    res.redirect(`/zq-admin/requests/pending-photos?approved=1&notified=${notifiedCount}`);
  } catch (err) {
    res.send(layout("Error", `<div class="alert red">${esc(err.message)}</div>`));
  }
});

// ── Reject photo: notify buyer only ──────────────────────────────────────────
router.post("/requests/:id/reject-photo", requireSupplierAdmin, async (req, res) => {
  try {
    const r = await BuyerRequest.findById(req.params.id);
    if (!r) return res.redirect("/zq-admin/requests/pending-photos");

    const reason = (req.body.reason || "Photo did not meet our content guidelines").trim();

    r.imageStatus             = "rejected";
    r.imageRejectionReason    = reason;
    r.imageReviewedAt         = new Date();
    r.imageReviewedBy         = "admin";
    r.status                  = "closed"; // Close the request - buyer must resubmit
    await r.save();

    const ref = `REQ-${String(r._id).slice(-6).toUpperCase()}`;
    await notifyBuyerRequestRejected({ buyerPhone: r.buyerPhone, ref, reason });

    res.redirect(`/zq-admin/requests/pending-photos?rejected=1`);
  } catch (err) {
    res.send(layout("Error", `<div class="alert red">${esc(err.message)}</div>`));
  }
});


// ══════════════════════════════════════════════════════════════════════════════
// GROUP SMART LINKS
// ── /zq-admin/groups
// ── /zq-admin/groups/new
// ── /zq-admin/groups/:slug
// ── /zq-admin/groups/:slug/add-seller
// ── /zq-admin/groups/:slug/remove-seller
// ── /zq-admin/groups/:slug/delete
// ══════════════════════════════════════════════════════════════════════════════

const BOT_WA = `https://wa.me/${(process.env.WHATSAPP_BOT_NUMBER || "263771143904").replace(/\D/g, "")}`;

// ── GET /zq-admin/groups - list all groups ───────────────────────────────────
router.get("/groups", requireSupplierAdmin, async (req, res) => {
  try {
    const groups = await getAllGroups();

    const rows = groups.map(g => {
      const sellerCount = (g.sellers || []).length;
      const link = buildGroupDeepLink(g.slug);
      return `
      <tr>
        <td><a href="/zq-admin/groups/${esc(g.slug)}" style="font-weight:600;color:var(--blue)">${esc(g.name)}</a></td>
        <td style="font-family:monospace;font-size:12px;color:var(--muted)">${esc(g.slug)}</td>
        <td>${esc(g.tagline || "-")}</td>
        <td style="text-align:center">${sellerCount}</td>
        <td style="text-align:center">${g.viewCount || 0}</td>
        <td>
          <span style="display:inline-block;padding:2px 8px;border-radius:12px;font-size:11px;font-weight:600;background:${g.active ? "#dcfce7" : "#fee2e2"};color:${g.active ? "#16a34a" : "#dc2626"}">
            ${g.active ? "Active" : "Inactive"}
          </span>
        </td>
        <td>
          <a href="/zq-admin/groups/${esc(g.slug)}" class="btn btn-sm" style="background:#e0f2fe;color:#0369a1">✏️ Manage</a>
          <button onclick="copyText('${esc(link)}')" class="btn btn-sm" style="background:#f0fdf4;color:#16a34a;margin-left:4px">📋 Copy Link</button>
        </td>
      </tr>`;
    }).join("");

    const html = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px">
      <div>
        <h1 style="font-size:22px;font-weight:700;margin:0">🔗 Group Smart Links</h1>
        <p style="color:var(--muted);margin-top:4px;font-size:13px">One link for a category of sellers. Share on Facebook, Instagram or WhatsApp.</p>
      </div>
      <a href="/zq-admin/groups/new" class="btn btn-green">➕ Create Group</a>
    </div>

    ${groups.length === 0 ? `
    <div style="background:white;border-radius:12px;padding:40px;text-align:center;color:var(--muted)">
      <div style="font-size:40px;margin-bottom:12px">🔗</div>
      <h3 style="margin-bottom:8px;color:var(--text)">No groups yet</h3>
      <p style="margin-bottom:20px">Create a group to bundle multiple sellers under one shareable link.</p>
      <a href="/zq-admin/groups/new" class="btn btn-blue">➕ Create your first group</a>
    </div>` : `
    <div style="background:white;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.08)">
      <table style="width:100%;border-collapse:collapse;font-size:13px">
        <thead>
          <tr style="background:#f8fafc">
            <th style="padding:10px 14px;text-align:left;color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.5px;border-bottom:2px solid var(--border)">Name</th>
            <th style="padding:10px 14px;text-align:left;color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.5px;border-bottom:2px solid var(--border)">Slug</th>
            <th style="padding:10px 14px;text-align:left;color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.5px;border-bottom:2px solid var(--border)">Tagline</th>
            <th style="padding:10px 14px;text-align:center;color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.5px;border-bottom:2px solid var(--border)">Sellers</th>
            <th style="padding:10px 14px;text-align:center;color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.5px;border-bottom:2px solid var(--border)">Views</th>
            <th style="padding:10px 14px;text-align:center;color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.5px;border-bottom:2px solid var(--border)">Status</th>
            <th style="padding:10px 14px;border-bottom:2px solid var(--border)"></th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`}

    <script>
    function copyText(text) {
      navigator.clipboard.writeText(text).then(() => {
        const t = document.createElement("div");
        t.textContent = "✅ Copied!";
        t.style.cssText = "position:fixed;bottom:24px;right:24px;background:#0f172a;color:white;padding:10px 18px;border-radius:8px;font-size:13px;z-index:9999";
        document.body.appendChild(t);
        setTimeout(() => t.remove(), 2000);
      });
    }
    </script>`;

    res.send(layout("Group Smart Links", html));
  } catch (err) {
    res.send(layout("Group Smart Links", `<div style="color:red;padding:20px">Error: ${esc(err.message)}</div>`));
  }
});

// ── GET /zq-admin/groups/new - create form ───────────────────────────────────
router.get("/groups/new", requireSupplierAdmin, async (req, res) => {
  const err = req.query.error || "";
  const html = `
  <div style="max-width:560px">
    <a href="/zq-admin/groups" style="color:var(--blue);font-size:13px;text-decoration:none">← Back to Groups</a>
    <h1 style="margin:16px 0 4px;font-size:22px;font-weight:700">Create Group Smart Link</h1>
    <p style="color:var(--muted);font-size:13px;margin-bottom:24px">Bundle multiple sellers under one shareable WhatsApp link.</p>

    ${err ? `<div style="background:#fee2e2;color:#dc2626;padding:12px 16px;border-radius:8px;margin-bottom:16px;font-size:13px">❌ ${esc(err)}</div>` : ""}

    <div style="background:white;border-radius:12px;padding:24px;box-shadow:0 1px 3px rgba(0,0,0,.08)">
      <form method="POST" action="/zq-admin/groups/new">
        <div style="margin-bottom:16px">
          <label style="display:block;font-weight:600;font-size:13px;margin-bottom:6px">Group Name *</label>
          <input name="name" type="text" required placeholder="e.g. Kariba Tourism"
            style="width:100%;padding:10px 12px;border:1px solid var(--border);border-radius:8px;font-size:14px">
          <p style="color:var(--muted);font-size:12px;margin-top:4px">Display name shown to buyers when they open the group link.</p>
        </div>

        <div style="margin-bottom:16px">
          <label style="display:block;font-weight:600;font-size:13px;margin-bottom:6px">Slug (URL identifier) *</label>
          <div style="display:flex;align-items:center;gap:8px">
            <span style="font-size:13px;color:var(--muted);font-family:monospace;white-space:nowrap">ZQ:GROUP:</span>
            <input name="slug" id="slugInput" type="text" required placeholder="kariba-tourism"
              style="flex:1;padding:10px 12px;border:1px solid var(--border);border-radius:8px;font-size:14px;font-family:monospace"
              pattern="[a-z0-9-]+" title="Lowercase letters, numbers and hyphens only">
          </div>
          <p style="color:var(--muted);font-size:12px;margin-top:4px">This becomes the link: <code>wa.me/...?text=ZQ:GROUP:<strong>your-slug</strong></code><br>Use lowercase letters and hyphens only. Cannot be changed after sharing.</p>
        </div>

        <div style="margin-bottom:24px">
          <label style="display:block;font-weight:600;font-size:13px;margin-bottom:6px">Tagline <span style="color:var(--muted);font-weight:400">(optional)</span></label>
          <input name="tagline" type="text" placeholder="e.g. Game drives, houseboats, tours and accommodation in Kariba"
            style="width:100%;padding:10px 12px;border:1px solid var(--border);border-radius:8px;font-size:14px">
          <p style="color:var(--muted);font-size:12px;margin-top:4px">One line shown to buyers below the group name.</p>
        </div>

        <div style="display:flex;gap:10px">
          <button type="submit" class="btn btn-green" style="padding:10px 24px;font-size:14px">✅ Create Group</button>
          <a href="/zq-admin/groups" class="btn" style="background:var(--border);color:var(--text);padding:10px 24px;font-size:14px">Cancel</a>
        </div>
      </form>
    </div>
  </div>

  <script>
  // Auto-generate slug from name
  const nameInput = document.querySelector('input[name="name"]');
  const slugInput = document.getElementById("slugInput");
  let slugManuallyEdited = false;

  slugInput.addEventListener("input", () => { slugManuallyEdited = true; });
  nameInput.addEventListener("input", () => {
    if (slugManuallyEdited) return;
    slugInput.value = nameInput.value
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, "")
      .trim()
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .slice(0, 40);
  });
  </script>`;

  res.send(layout("Group: New", html));
});

// ── POST /zq-admin/groups/new ────────────────────────────────────────────────
router.post("/groups/new", requireSupplierAdmin, async (req, res) => {
  try {
    const { name, slug, tagline } = req.body;
    const group = await createGroup({ slug, name, tagline });
    res.redirect(`/zq-admin/groups/${encodeURIComponent(group.slug)}?success=Group+created`);
  } catch (err) {
    res.redirect(`/zq-admin/groups/new?error=${encodeURIComponent(err.message)}`);
  }
});

// ── GET /zq-admin/groups/:slug - manage group ────────────────────────────────
router.get("/groups/:slug", requireSupplierAdmin, async (req, res) => {
  try {
    const group = await getGroupBySlug(req.params.slug);
    if (!group) return res.redirect("/zq-admin/groups");

    const mongoose = (await import("mongoose")).default;
    const sellerIds = (group.sellers || [])
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
      .map(s => s.supplierId);
    const sellers = await SupplierProfile.find({ _id: { $in: sellerIds } }).lean();
    const orderedSellers = sellerIds
      .map(id => sellers.find(s => String(s._id) === String(id)))
      .filter(Boolean);

    const sellerRows = orderedSellers.map((s, i) => {
      const loc = [s.location?.area, s.location?.city].filter(Boolean).join(", ");
      return `
      <tr>
        <td style="width:32px;color:var(--muted);font-size:13px">${i + 1}</td>
        <td>
          <strong>${esc(s.businessName)}</strong>
          ${loc ? `<br><span style="color:var(--muted);font-size:12px">📍 ${esc(loc)}</span>` : ""}
        </td>
        <td style="font-family:monospace;font-size:12px;color:var(--muted)">${esc(s.phone || "")}</td>
        <td>
          <span style="font-size:11px;padding:2px 8px;border-radius:10px;background:#f1f5f9;color:var(--muted)">${esc(s.profileType || "supplier")}</span>
        </td>
        <td>
          <form method="POST" action="/zq-admin/groups/${esc(group.slug)}/remove-seller" style="display:inline">
            <input type="hidden" name="phone" value="${esc(s.phone)}">
            <button type="submit" class="btn btn-sm" style="background:#fee2e2;color:#dc2626"
              onclick="return confirm('Remove ${esc(s.businessName)} from this group?')">Remove</button>
          </form>
        </td>
      </tr>`;
    }).join("");

    const groupLink = buildGroupDeepLink(group.slug);
    const qrUrl     = buildGroupQrImageUrl(group.slug, 300);
    const waLink    = `${BOT_WA}?text=${encodeURIComponent("ZQ:GROUP:" + group.slug)}`;

    const successMsg = req.query.success
      ? `<div style="background:#dcfce7;color:#16a34a;padding:12px 16px;border-radius:8px;margin-bottom:16px;font-size:13px">✅ ${esc(req.query.success)}</div>`
      : "";
    const errorMsg = req.query.error
      ? `<div style="background:#fee2e2;color:#dc2626;padding:12px 16px;border-radius:8px;margin-bottom:16px;font-size:13px">❌ ${esc(req.query.error)}</div>`
      : "";

    const html = `
    <a href="/zq-admin/groups" style="color:var(--blue);font-size:13px;text-decoration:none">← Back to Groups</a>
    <div style="display:flex;align-items:center;justify-content:space-between;margin:16px 0 8px">
      <div>
        <h1 style="font-size:22px;font-weight:700;margin:0">${esc(group.name)}</h1>
        <p style="color:var(--muted);font-size:13px;margin-top:2px">${esc(group.tagline || "")}</p>
      </div>
      <form method="POST" action="/zq-admin/groups/${esc(group.slug)}/delete">
        <button type="submit" class="btn btn-sm" style="background:#fee2e2;color:#dc2626"
          onclick="return confirm('Delete group ${esc(group.name)}? This cannot be undone.')">🗑 Delete Group</button>
      </form>
    </div>

    ${successMsg}${errorMsg}

    <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-bottom:24px">

      <!-- Link card -->
      <div style="background:white;border-radius:12px;padding:20px;box-shadow:0 1px 3px rgba(0,0,0,.08)">
        <h2 style="font-size:13px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:14px">Group Link</h2>
        <div style="background:#f8fafc;border:1px solid var(--border);border-radius:8px;padding:10px 12px;font-family:monospace;font-size:12px;color:#0369a1;word-break:break-all;margin-bottom:12px;cursor:pointer"
          onclick="copyText('${esc(groupLink)}')" title="Click to copy">
          ${esc(groupLink)}
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button onclick="copyText('${esc(groupLink)}')" class="btn btn-sm" style="background:#e0f2fe;color:#0369a1">📋 Copy Link</button>
          <a href="${esc(waLink)}" target="_blank" class="btn btn-sm" style="background:#dcfce7;color:#16a34a">📱 Test on WhatsApp</a>
        </div>
        <div style="margin-top:12px;padding-top:12px;border-top:1px solid var(--border)">
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
            <div style="text-align:center;padding:10px;background:#f8fafc;border-radius:8px">
              <div style="font-size:22px;font-weight:800;color:var(--blue)">${orderedSellers.length}</div>
              <div style="font-size:11px;color:var(--muted);margin-top:2px">Sellers</div>
            </div>
            <div style="text-align:center;padding:10px;background:#f8fafc;border-radius:8px">
              <div style="font-size:22px;font-weight:800;color:var(--teal)">${group.viewCount || 0}</div>
              <div style="font-size:11px;color:var(--muted);margin-top:2px">Total Views</div>
            </div>
          </div>
        </div>
      </div>

      <!-- QR + edit -->
      <div style="background:white;border-radius:12px;padding:20px;box-shadow:0 1px 3px rgba(0,0,0,.08)">
        <h2 style="font-size:13px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:14px">QR Code</h2>
        <div style="text-align:center;margin-bottom:12px">
          <img src="${esc(qrUrl)}" width="180" height="180" alt="QR Code" style="border-radius:8px;border:2px solid var(--border)">
          <p style="color:var(--muted);font-size:11px;margin-top:6px">Print on flyers or posters</p>
        </div>
        <a href="${esc(qrUrl)}" download="group-qr-${esc(group.slug)}.png" target="_blank"
          class="btn btn-sm" style="width:100%;text-align:center;display:block;background:#f1f5f9;color:var(--text)">
          ⬇️ Download QR
        </a>
      </div>
    </div>

    <!-- Edit tagline / name -->
    <div style="background:white;border-radius:12px;padding:20px;box-shadow:0 1px 3px rgba(0,0,0,.08);margin-bottom:24px">
      <h2 style="font-size:13px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:14px">Edit Group Details</h2>
      <form method="POST" action="/zq-admin/groups/${esc(group.slug)}/edit" style="display:grid;grid-template-columns:1fr 1fr auto;gap:12px;align-items:end">
        <div>
          <label style="display:block;font-size:12px;font-weight:600;margin-bottom:4px">Name</label>
          <input name="name" value="${esc(group.name)}" required
            style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;font-size:13px">
        </div>
        <div>
          <label style="display:block;font-size:12px;font-weight:600;margin-bottom:4px">Tagline</label>
          <input name="tagline" value="${esc(group.tagline || "")}" placeholder="One-line description"
            style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;font-size:13px">
        </div>
        <button type="submit" class="btn btn-blue" style="padding:8px 16px;font-size:13px">Save</button>
      </form>
    </div>

    <!-- Sellers table -->
    <div style="background:white;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.08);margin-bottom:20px">
      <div style="padding:16px 20px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between">
        <h2 style="font-size:14px;font-weight:700;margin:0">Sellers in this group (${orderedSellers.length})</h2>
      </div>
      ${orderedSellers.length === 0 ? `
        <div style="padding:32px;text-align:center;color:var(--muted)">
          No sellers added yet. Add sellers below.
        </div>` : `
      <table style="width:100%;border-collapse:collapse;font-size:13px">
        <thead>
          <tr style="background:#f8fafc">
            <th style="padding:8px 12px;text-align:left;color:var(--muted);font-size:11px;border-bottom:1px solid var(--border)">#</th>
            <th style="padding:8px 12px;text-align:left;color:var(--muted);font-size:11px;border-bottom:1px solid var(--border)">Business</th>
            <th style="padding:8px 12px;text-align:left;color:var(--muted);font-size:11px;border-bottom:1px solid var(--border)">Phone</th>
            <th style="padding:8px 12px;text-align:left;color:var(--muted);font-size:11px;border-bottom:1px solid var(--border)">Type</th>
            <th style="padding:8px 12px;border-bottom:1px solid var(--border)"></th>
          </tr>
        </thead>
        <tbody>${sellerRows}</tbody>
      </table>`}
    </div>

    <!-- Add seller form -->
    <div style="background:white;border-radius:12px;padding:20px;box-shadow:0 1px 3px rgba(0,0,0,.08)">
      <h2 style="font-size:13px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:14px">Add Seller to Group</h2>
      <form method="POST" action="/zq-admin/groups/${esc(group.slug)}/add-seller"
        style="display:grid;grid-template-columns:1fr auto;gap:10px;align-items:end">
        <div>
          <label style="display:block;font-size:12px;font-weight:600;margin-bottom:4px">Seller Phone Number</label>
          <input name="phone" type="text" required placeholder="e.g. 263771446827 or 0771446827"
            style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;font-size:13px">
          <p style="color:var(--muted);font-size:11px;margin-top:3px">The seller's registered phone number on ZimQuote.</p>
        </div>
        <button type="submit" class="btn btn-green" style="padding:8px 16px;font-size:13px">➕ Add</button>
      </form>
    </div>

    <script>
    function copyText(text) {
      navigator.clipboard.writeText(text).then(() => {
        const t = document.createElement("div");
        t.textContent = "✅ Copied!";
        t.style.cssText = "position:fixed;bottom:24px;right:24px;background:#0f172a;color:white;padding:10px 18px;border-radius:8px;font-size:13px;z-index:9999";
        document.body.appendChild(t);
        setTimeout(() => t.remove(), 2000);
      });
    }
    </script>`;

    res.send(layout(`Group: ${group.name}`, html));
  } catch (err) {
    res.redirect(`/zq-admin/groups?error=${encodeURIComponent(err.message)}`);
  }
});

// ── POST /zq-admin/groups/:slug/edit ─────────────────────────────────────────
router.post("/groups/:slug/edit", requireSupplierAdmin, async (req, res) => {
  try {
    const { name, tagline } = req.body;
    const group = await getGroupBySlug(req.params.slug);
    if (!group) return res.redirect("/zq-admin/groups");
    const mongoose = (await import("mongoose")).default;
    const SupplierGroup = mongoose.model("SupplierGroup");
    await SupplierGroup.findByIdAndUpdate(group._id, {
      $set: { name: String(name || "").trim(), tagline: String(tagline || "").trim() }
    });
    res.redirect(`/zq-admin/groups/${encodeURIComponent(req.params.slug)}?success=Group+updated`);
  } catch (err) {
    res.redirect(`/zq-admin/groups/${encodeURIComponent(req.params.slug)}?error=${encodeURIComponent(err.message)}`);
  }
});

// ── POST /zq-admin/groups/:slug/add-seller ───────────────────────────────────
router.post("/groups/:slug/add-seller", requireSupplierAdmin, async (req, res) => {
  try {
    await addSellerToGroup(req.params.slug, req.body.phone);
    res.redirect(`/zq-admin/groups/${encodeURIComponent(req.params.slug)}?success=Seller+added`);
  } catch (err) {
    res.redirect(`/zq-admin/groups/${encodeURIComponent(req.params.slug)}?error=${encodeURIComponent(err.message)}`);
  }
});

// ── POST /zq-admin/groups/:slug/remove-seller ────────────────────────────────
router.post("/groups/:slug/remove-seller", requireSupplierAdmin, async (req, res) => {
  try {
    await removeSellerFromGroup(req.params.slug, req.body.phone);
    res.redirect(`/zq-admin/groups/${encodeURIComponent(req.params.slug)}?success=Seller+removed`);
  } catch (err) {
    res.redirect(`/zq-admin/groups/${encodeURIComponent(req.params.slug)}?error=${encodeURIComponent(err.message)}`);
  }
});

// ── POST /zq-admin/groups/:slug/delete ───────────────────────────────────────
router.post("/groups/:slug/delete", requireSupplierAdmin, async (req, res) => {
  try {
    await deleteGroup(req.params.slug);
    res.redirect("/zq-admin/groups?success=Group+deleted");
  } catch (err) {
    res.redirect(`/zq-admin/groups/${encodeURIComponent(req.params.slug)}?error=${encodeURIComponent(err.message)}`);
  }
});


// ─────────────────────────────────────────────────────────────────────────────
// ASSIGN SLUGS TO ALL SELLERS WHO DON'T HAVE ONE
// GET  /zq-admin/suppliers/assign-slugs  → preview page (dry run count)
// POST /zq-admin/suppliers/assign-slugs  → run assignment + show results
//
// Run once after deploying named links so all existing sellers get
// a human-readable ZQ:S:<slug> link automatically.
// Safe to run multiple times - skips sellers who already have a slug.
// ─────────────────────────────────────────────────────────────────────────────
router.get("/suppliers/assign-slugs", requireSupplierAdmin, async (req, res) => {
  try {
    const missing = await SupplierProfile.find(
      { $or: [{ zqSlug: { $exists: false } }, { zqSlug: null }, { zqSlug: "" }] },
      { businessName: 1, phone: 1 }
    ).lean();

    const rows = missing.slice(0, 50).map(s =>
      `<tr>
        <td style="padding:8px 12px">${esc(s.businessName || "-")}</td>
        <td style="padding:8px 12px;font-family:monospace;color:var(--muted)">${esc(s.phone || "")}</td>
      </tr>`
    ).join("");

    const overflow = missing.length > 50
      ? `<p style="color:var(--muted);font-size:13px;padding:12px 16px">...and ${missing.length - 50} more</p>`
      : "";

    const html = `
    <div style="max-width:680px">
      <a href="/zq-admin/suppliers" style="color:var(--blue);font-size:13px;text-decoration:none">← Back to Suppliers</a>
      <h1 style="margin:16px 0 4px;font-size:22px;font-weight:700">Assign Named Links to Sellers</h1>
      <p style="color:var(--muted);font-size:13px;margin-bottom:24px">
        This assigns a human-readable slug to every seller who doesn't have one yet,
        enabling the <code>ZQ:S:&lt;slug&gt;</code> named link format.
      </p>

      <div style="background:white;border-radius:12px;padding:20px;box-shadow:0 1px 3px rgba(0,0,0,.08);margin-bottom:20px">
        <div style="display:flex;align-items:center;gap:16px;margin-bottom:16px">
          <div style="text-align:center;padding:14px 20px;background:#f0fdf4;border-radius:10px;border:2px solid #86efac">
            <div style="font-size:28px;font-weight:800;color:#16a34a">${missing.length}</div>
            <div style="font-size:12px;color:#16a34a;margin-top:2px">sellers need a slug</div>
          </div>
          <div style="flex:1">
            <p style="font-size:13px;margin-bottom:8px">
              ${missing.length === 0
                ? "✅ All sellers already have named links. Nothing to do."
                : `${missing.length} seller${missing.length === 1 ? "" : "s"} will be assigned a slug based on their business name. This is safe to run - sellers who already have a slug are skipped.`}
            </p>
            ${missing.length > 0 ? `
            <form method="POST" action="/zq-admin/suppliers/assign-slugs">
              <button type="submit" class="btn btn-green"
                onclick="return confirm('Assign slugs to ${missing.length} seller${missing.length === 1 ? "" : "s"}? This is safe and can be run again.')">
                ▶️ Run - Assign ${missing.length} Slug${missing.length === 1 ? "" : "s"}
              </button>
            </form>` : ""}
          </div>
        </div>

        ${missing.length > 0 ? `
        <details style="margin-top:4px">
          <summary style="cursor:pointer;font-size:13px;color:var(--blue);font-weight:600">
            Preview sellers (${Math.min(missing.length, 50)} shown)
          </summary>
          <div style="margin-top:12px;border:1px solid var(--border);border-radius:8px;overflow:hidden">
            <table style="width:100%;border-collapse:collapse;font-size:13px">
              <thead>
                <tr style="background:#f8fafc">
                  <th style="padding:8px 12px;text-align:left;color:var(--muted);font-size:11px;border-bottom:1px solid var(--border)">Business Name</th>
                  <th style="padding:8px 12px;text-align:left;color:var(--muted);font-size:11px;border-bottom:1px solid var(--border)">Phone</th>
                </tr>
              </thead>
              <tbody>${rows}</tbody>
            </table>
            ${overflow}
          </div>
        </details>` : ""}
      </div>
    </div>`;

    res.send(layout("Assign Slugs", html));
  } catch (err) {
    res.send(layout("Assign Slugs", `<div style="color:red;padding:20px">Error: ${esc(err.message)}</div>`));
  }
});

router.post("/suppliers/assign-slugs", requireSupplierAdmin, async (req, res) => {
  try {
    const missing = await SupplierProfile.find(
      { $or: [{ zqSlug: { $exists: false } }, { zqSlug: null }, { zqSlug: "" }] },
      { _id: 1, businessName: 1 }
    ).lean();

    const results = [];
    let success = 0, failed = 0;

    for (const s of missing) {
      try {
        const slug = await assignSlugToSupplier(String(s._id));
        results.push({ name: s.businessName, slug, ok: true });
        success++;
      } catch (err) {
        results.push({ name: s.businessName, slug: null, ok: false, error: err.message });
        failed++;
      }
      // Small delay to avoid hammering the DB
      await new Promise(r => setTimeout(r, 30));
    }

    const rows = results.map(r =>
      `<tr>
        <td style="padding:8px 12px">${esc(r.name || "-")}</td>
        <td style="padding:8px 12px">
          ${r.ok
            ? `<span style="font-family:monospace;color:#16a34a;font-size:13px">✅ ZQ:S:${esc(r.slug)}</span>`
            : `<span style="color:#dc2626;font-size:13px">❌ ${esc(r.error)}</span>`}
        </td>
      </tr>`
    ).join("");

    const html = `
    <div style="max-width:680px">
      <a href="/zq-admin/suppliers/assign-slugs" style="color:var(--blue);font-size:13px;text-decoration:none">← Run again</a>
      <h1 style="margin:16px 0 4px;font-size:22px;font-weight:700">Slug Assignment Complete</h1>

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin:20px 0">
        <div style="background:#f0fdf4;border-radius:10px;padding:16px;text-align:center;border:2px solid #86efac">
          <div style="font-size:28px;font-weight:800;color:#16a34a">${success}</div>
          <div style="font-size:12px;color:#16a34a;margin-top:2px">slugs assigned</div>
        </div>
        <div style="background:${failed > 0 ? "#fee2e2" : "#f8fafc"};border-radius:10px;padding:16px;text-align:center;border:2px solid ${failed > 0 ? "#fca5a5" : "var(--border)"}">
          <div style="font-size:28px;font-weight:800;color:${failed > 0 ? "#dc2626" : "var(--muted)"}">${failed}</div>
          <div style="font-size:12px;color:${failed > 0 ? "#dc2626" : "var(--muted)"};margin-top:2px">failed</div>
        </div>
      </div>

      ${results.length > 0 ? `
      <div style="background:white;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.08)">
        <table style="width:100%;border-collapse:collapse;font-size:13px">
          <thead>
            <tr style="background:#f8fafc">
              <th style="padding:8px 12px;text-align:left;color:var(--muted);font-size:11px;border-bottom:1px solid var(--border)">Business</th>
              <th style="padding:8px 12px;text-align:left;color:var(--muted);font-size:11px;border-bottom:1px solid var(--border)">Result</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>` : `<p style="color:var(--muted);padding:20px">No sellers needed slugs.</p>`}

      <div style="margin-top:16px;display:flex;gap:10px">
        <a href="/zq-admin/suppliers" class="btn btn-blue">← Back to Suppliers</a>
        <a href="/zq-admin/suppliers/assign-slugs" class="btn" style="background:var(--border);color:var(--text)">Run Again</a>
      </div>
    </div>`;

    res.send(layout("Assign Slugs", html));
  } catch (err) {
    res.send(layout("Assign Slugs", `<div style="color:red;padding:20px">Error: ${esc(err.message)}</div>`));
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// SCHOOL GROUP SMART LINKS
// ── /zq-admin/school-groups
// ── /zq-admin/school-groups/new
// ── /zq-admin/school-groups/:slug
// ── /zq-admin/school-groups/:slug/add-school
// ── /zq-admin/school-groups/:slug/remove-school
// ── /zq-admin/school-groups/:slug/delete
// ── /zq-admin/school-groups/:slug/edit
// ══════════════════════════════════════════════════════════════════════════════

// ── GET /zq-admin/school-groups ──────────────────────────────────────────────
router.get("/school-groups", requireSupplierAdmin, async (req, res) => {
  try {
    const groups = await getAllSchoolGroups();
    const rows = groups.map(g => {
      const schoolCount = (g.schools || []).length;
      const link = buildSchoolGroupDeepLink(g.slug);
      return `
      <tr>
        <td><a href="/zq-admin/school-groups/${esc(g.slug)}" style="font-weight:600;color:var(--blue)">${esc(g.name)}</a></td>
        <td style="font-family:monospace;font-size:12px;color:var(--muted)">${esc(g.slug)}</td>
        <td>${esc(g.tagline || "-")}</td>
        <td style="text-align:center">${schoolCount}</td>
        <td style="text-align:center">${g.viewCount || 0}</td>
        <td>
          <span style="display:inline-block;padding:2px 8px;border-radius:12px;font-size:11px;font-weight:600;background:${g.active ? "#dcfce7" : "#fee2e2"};color:${g.active ? "#16a34a" : "#dc2626"}">
            ${g.active ? "Active" : "Inactive"}
          </span>
        </td>
        <td>
          <a href="/zq-admin/school-groups/${esc(g.slug)}" class="btn btn-sm" style="background:#e0f2fe;color:#0369a1">✏️ Manage</a>
          <button onclick="copyText('${esc(link)}')" class="btn btn-sm" style="background:#f0fdf4;color:#16a34a;margin-left:4px">📋 Copy Link</button>
        </td>
      </tr>`;
    }).join("");

    const html = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px">
      <div>
        <h1 style="font-size:22px;font-weight:700;margin:0">🏫 School Group Smart Links</h1>
        <p style="color:var(--muted);margin-top:4px;font-size:13px">One link for a group of schools. Share on Facebook, WhatsApp groups, or print as QR codes.</p>
      </div>
      <a href="/zq-admin/school-groups/new" class="btn btn-green">➕ Create School Group</a>
    </div>

    ${groups.length === 0 ? `
    <div style="background:white;border-radius:12px;padding:40px;text-align:center;color:var(--muted)">
      <div style="font-size:40px;margin-bottom:12px">🏫</div>
      <h3 style="margin-bottom:8px;color:var(--text)">No school groups yet</h3>
      <p style="margin-bottom:20px">Bundle multiple schools under one shareable WhatsApp link.</p>
      <a href="/zq-admin/school-groups/new" class="btn btn-blue">➕ Create your first school group</a>
    </div>` : `
    <div style="background:white;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.08)">
      <table style="width:100%;border-collapse:collapse;font-size:13px">
        <thead>
          <tr style="background:#f8fafc">
            <th style="padding:10px 14px;text-align:left;color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.5px;border-bottom:2px solid var(--border)">Name</th>
            <th style="padding:10px 14px;text-align:left;color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.5px;border-bottom:2px solid var(--border)">Slug</th>
            <th style="padding:10px 14px;text-align:left;color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.5px;border-bottom:2px solid var(--border)">Tagline</th>
            <th style="padding:10px 14px;text-align:center;color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.5px;border-bottom:2px solid var(--border)">Schools</th>
            <th style="padding:10px 14px;text-align:center;color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.5px;border-bottom:2px solid var(--border)">Views</th>
            <th style="padding:10px 14px;text-align:center;color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.5px;border-bottom:2px solid var(--border)">Status</th>
            <th style="padding:10px 14px;border-bottom:2px solid var(--border)"></th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`}

    <script>
    function copyText(text) {
      navigator.clipboard.writeText(text).then(() => {
        const t = document.createElement("div");
        t.textContent = "✅ Copied!";
        t.style.cssText = "position:fixed;bottom:24px;right:24px;background:#0f172a;color:white;padding:10px 18px;border-radius:8px;font-size:13px;z-index:9999";
        document.body.appendChild(t);
        setTimeout(() => t.remove(), 2000);
      });
    }
    </script>`;

    res.send(layout("School Group Smart Links", html));
  } catch (err) {
    res.send(layout("School Group Smart Links", `<div style="color:red;padding:20px">Error: ${esc(err.message)}</div>`));
  }
});

// ── GET /zq-admin/school-groups/new ─────────────────────────────────────────
router.get("/school-groups/new", requireSupplierAdmin, async (req, res) => {
  const err = req.query.error || "";
  const html = `
  <div style="max-width:560px">
    <a href="/zq-admin/school-groups" style="color:var(--blue);font-size:13px;text-decoration:none">← Back to School Groups</a>
    <h1 style="margin:16px 0 4px;font-size:22px;font-weight:700">Create School Group Link</h1>
    <p style="color:var(--muted);font-size:13px;margin-bottom:24px">Bundle multiple schools under one shareable WhatsApp link.</p>

    ${err ? `<div style="background:#fee2e2;color:#dc2626;padding:12px 16px;border-radius:8px;margin-bottom:16px;font-size:13px">❌ ${esc(err)}</div>` : ""}

    <div style="background:white;border-radius:12px;padding:24px;box-shadow:0 1px 3px rgba(0,0,0,.08)">
      <form method="POST" action="/zq-admin/school-groups/new">
        <div style="margin-bottom:16px">
          <label style="display:block;font-weight:600;font-size:13px;margin-bottom:6px">Group Name *</label>
          <input name="name" type="text" required placeholder="e.g. Harare Private Schools"
            style="width:100%;padding:10px 12px;border:1px solid var(--border);border-radius:8px;font-size:14px">
          <p style="color:var(--muted);font-size:12px;margin-top:4px">Display name shown to parents when they open the group link.</p>
        </div>

        <div style="margin-bottom:16px">
          <label style="display:block;font-weight:600;font-size:13px;margin-bottom:6px">Slug (URL identifier) *</label>
          <div style="display:flex;align-items:center;gap:8px">
            <span style="font-size:13px;color:var(--muted);font-family:monospace;white-space:nowrap">ZQ:SGROUP:</span>
            <input name="slug" id="slugInput" type="text" required placeholder="harare-private-schools"
              style="flex:1;padding:10px 12px;border:1px solid var(--border);border-radius:8px;font-size:14px;font-family:monospace"
              pattern="[a-z0-9-]+" title="Lowercase letters, numbers and hyphens only">
          </div>
          <p style="color:var(--muted);font-size:12px;margin-top:4px">Link becomes: <code>wa.me/...?text=ZQ:SGROUP:<strong>your-slug</strong></code></p>
        </div>

        <div style="margin-bottom:24px">
          <label style="display:block;font-weight:600;font-size:13px;margin-bottom:6px">Tagline <span style="color:var(--muted);font-weight:400">(optional)</span></label>
          <input name="tagline" type="text" placeholder="e.g. Top private schools in Harare - tap a school to enquire"
            style="width:100%;padding:10px 12px;border:1px solid var(--border);border-radius:8px;font-size:14px">
        </div>

        <div style="display:flex;gap:10px">
          <button type="submit" class="btn btn-green" style="padding:10px 24px;font-size:14px">✅ Create Group</button>
          <a href="/zq-admin/school-groups" class="btn" style="background:var(--border);color:var(--text);padding:10px 24px;font-size:14px">Cancel</a>
        </div>
      </form>
    </div>
  </div>

  <script>
  const nameInput = document.querySelector('input[name="name"]');
  const slugInput = document.getElementById("slugInput");
  let slugManuallyEdited = false;
  slugInput.addEventListener("input", () => { slugManuallyEdited = true; });
  nameInput.addEventListener("input", () => {
    if (slugManuallyEdited) return;
    slugInput.value = nameInput.value
      .toLowerCase().replace(/[^a-z0-9\s-]/g, "").trim()
      .replace(/\s+/g, "-").replace(/-+/g, "-").slice(0, 40);
  });
  </script>`;

  res.send(layout("School Group: New", html));
});

// ── POST /zq-admin/school-groups/new ─────────────────────────────────────────
router.post("/school-groups/new", requireSupplierAdmin, async (req, res) => {
  try {
    const { name, slug, tagline } = req.body;
    const group = await createSchoolGroup({ slug, name, tagline });
    res.redirect(`/zq-admin/school-groups/${encodeURIComponent(group.slug)}?success=School+group+created`);
  } catch (err) {
    res.redirect(`/zq-admin/school-groups/new?error=${encodeURIComponent(err.message)}`);
  }
});

// ── GET /zq-admin/school-groups/:slug ────────────────────────────────────────
router.get("/school-groups/:slug", requireSupplierAdmin, async (req, res) => {
  try {
    const group = await getSchoolGroupBySlug(req.params.slug);
    if (!group) return res.redirect("/zq-admin/school-groups");

    const SchoolProfile = (await import("../models/schoolProfile.js")).default;
    const schoolIds = (group.schools || [])
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
      .map(s => s.schoolId);
    const schools = await SchoolProfile.find({ _id: { $in: schoolIds } }).lean();
    const orderedSchools = schoolIds
      .map(id => schools.find(s => String(s._id) === String(id)))
      .filter(Boolean);

    const schoolRows = orderedSchools.map((s, i) => {
      const loc = [s.suburb, s.city].filter(Boolean).join(", ");
      return `
      <tr>
        <td style="width:32px;color:var(--muted);font-size:13px">${i + 1}</td>
        <td>
          <strong>${esc(s.schoolName)}</strong>
          ${loc ? `<br><span style="color:var(--muted);font-size:12px">📍 ${esc(loc)}</span>` : ""}
        </td>
        <td style="font-family:monospace;font-size:12px;color:var(--muted)">${esc(s.phone || "")}</td>
        <td><span style="font-size:11px;padding:2px 8px;border-radius:10px;background:#f1f5f9;color:var(--muted)">${esc(s.type || "school")}</span></td>
        <td>
          <form method="POST" action="/zq-admin/school-groups/${esc(group.slug)}/remove-school" style="display:inline">
            <input type="hidden" name="phone" value="${esc(s.phone)}">
            <button type="submit" class="btn btn-sm" style="background:#fee2e2;color:#dc2626"
              onclick="return confirm('Remove ${esc(s.schoolName)} from this group?')">Remove</button>
          </form>
        </td>
      </tr>`;
    }).join("");

    const groupLink = buildSchoolGroupDeepLink(group.slug);
    const qrUrl     = buildSchoolGroupQrImageUrl(group.slug, 300);
    const waLink    = `${BOT_WA}?text=${encodeURIComponent("ZQ:SGROUP:" + group.slug)}`;

    const successMsg = req.query.success ? `<div style="background:#dcfce7;color:#16a34a;padding:12px 16px;border-radius:8px;margin-bottom:16px;font-size:13px">✅ ${esc(req.query.success)}</div>` : "";
    const errorMsg   = req.query.error   ? `<div style="background:#fee2e2;color:#dc2626;padding:12px 16px;border-radius:8px;margin-bottom:16px;font-size:13px">❌ ${esc(req.query.error)}</div>` : "";

    const html = `
    <a href="/zq-admin/school-groups" style="color:var(--blue);font-size:13px;text-decoration:none">← Back to School Groups</a>
    <div style="display:flex;align-items:center;justify-content:space-between;margin:16px 0 8px">
      <div>
        <h1 style="font-size:22px;font-weight:700;margin:0">${esc(group.name)}</h1>
        <p style="color:var(--muted);font-size:13px;margin-top:2px">${esc(group.tagline || "")}</p>
      </div>
      <form method="POST" action="/zq-admin/school-groups/${esc(group.slug)}/delete">
        <button type="submit" class="btn btn-sm" style="background:#fee2e2;color:#dc2626"
          onclick="return confirm('Delete group ${esc(group.name)}? This cannot be undone.')">🗑 Delete Group</button>
      </form>
    </div>

    ${successMsg}${errorMsg}

    <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-bottom:24px">
      <div style="background:white;border-radius:12px;padding:20px;box-shadow:0 1px 3px rgba(0,0,0,.08)">
        <h2 style="font-size:13px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:14px">Group Link</h2>
        <div style="background:#f8fafc;border:1px solid var(--border);border-radius:8px;padding:10px 12px;font-family:monospace;font-size:12px;color:#0369a1;word-break:break-all;margin-bottom:12px;cursor:pointer"
          onclick="copyText('${esc(groupLink)}')" title="Click to copy">
          ${esc(groupLink)}
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button onclick="copyText('${esc(groupLink)}')" class="btn btn-sm" style="background:#e0f2fe;color:#0369a1">📋 Copy Link</button>
          <a href="${esc(waLink)}" target="_blank" class="btn btn-sm" style="background:#dcfce7;color:#16a34a">📱 Test on WhatsApp</a>
        </div>
        <div style="margin-top:12px;padding-top:12px;border-top:1px solid var(--border)">
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
            <div style="text-align:center;padding:10px;background:#f8fafc;border-radius:8px">
              <div style="font-size:22px;font-weight:800;color:var(--blue)">${orderedSchools.length}</div>
              <div style="font-size:11px;color:var(--muted);margin-top:2px">Schools</div>
            </div>
            <div style="text-align:center;padding:10px;background:#f8fafc;border-radius:8px">
              <div style="font-size:22px;font-weight:800;color:var(--teal)">${group.viewCount || 0}</div>
              <div style="font-size:11px;color:var(--muted);margin-top:2px">Total Views</div>
            </div>
          </div>
        </div>
      </div>

      <div style="background:white;border-radius:12px;padding:20px;box-shadow:0 1px 3px rgba(0,0,0,.08)">
        <h2 style="font-size:13px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:14px">QR Code</h2>
        <div style="text-align:center;margin-bottom:12px">
          <img src="${esc(qrUrl)}" width="180" height="180" alt="QR Code" style="border-radius:8px;border:2px solid var(--border)">
          <p style="color:var(--muted);font-size:11px;margin-top:6px">Print on flyers or notice boards</p>
        </div>
        <a href="${esc(qrUrl)}" download="school-group-qr-${esc(group.slug)}.png" target="_blank"
          class="btn btn-sm" style="width:100%;text-align:center;display:block;background:#f1f5f9;color:var(--text)">
          ⬇️ Download QR
        </a>
      </div>
    </div>

    <!-- Edit group details -->
    <div style="background:white;border-radius:12px;padding:20px;box-shadow:0 1px 3px rgba(0,0,0,.08);margin-bottom:24px">
      <h2 style="font-size:13px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:14px">Edit Group Details</h2>
      <form method="POST" action="/zq-admin/school-groups/${esc(group.slug)}/edit" style="display:grid;grid-template-columns:1fr 1fr auto;gap:12px;align-items:end">
        <div>
          <label style="display:block;font-size:12px;font-weight:600;margin-bottom:4px">Name</label>
          <input name="name" value="${esc(group.name)}" required
            style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;font-size:13px">
        </div>
        <div>
          <label style="display:block;font-size:12px;font-weight:600;margin-bottom:4px">Tagline</label>
          <input name="tagline" value="${esc(group.tagline || "")}" placeholder="One-line description"
            style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;font-size:13px">
        </div>
        <button type="submit" class="btn btn-blue" style="padding:8px 16px;font-size:13px">Save</button>
      </form>
    </div>

    <!-- Schools table -->
    <div style="background:white;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.08);margin-bottom:20px">
      <div style="padding:16px 20px;border-bottom:1px solid var(--border)">
        <h2 style="font-size:14px;font-weight:700;margin:0">Schools in this group (${orderedSchools.length})</h2>
      </div>
      ${orderedSchools.length === 0 ? `
        <div style="padding:32px;text-align:center;color:var(--muted)">No schools added yet. Add schools below.</div>` : `
      <table style="width:100%;border-collapse:collapse;font-size:13px">
        <thead>
          <tr style="background:#f8fafc">
            <th style="padding:8px 12px;text-align:left;color:var(--muted);font-size:11px;border-bottom:1px solid var(--border)">#</th>
            <th style="padding:8px 12px;text-align:left;color:var(--muted);font-size:11px;border-bottom:1px solid var(--border)">School</th>
            <th style="padding:8px 12px;text-align:left;color:var(--muted);font-size:11px;border-bottom:1px solid var(--border)">Phone</th>
            <th style="padding:8px 12px;text-align:left;color:var(--muted);font-size:11px;border-bottom:1px solid var(--border)">Type</th>
            <th style="padding:8px 12px;border-bottom:1px solid var(--border)"></th>
          </tr>
        </thead>
        <tbody>${schoolRows}</tbody>
      </table>`}
    </div>

    <!-- Add school form -->
    <div style="background:white;border-radius:12px;padding:20px;box-shadow:0 1px 3px rgba(0,0,0,.08)">
      <h2 style="font-size:13px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:14px">Add School to Group</h2>
      <form method="POST" action="/zq-admin/school-groups/${esc(group.slug)}/add-school"
        style="display:grid;grid-template-columns:1fr auto;gap:10px;align-items:end">
        <div>
          <label style="display:block;font-size:12px;font-weight:600;margin-bottom:4px">School Phone Number</label>
          <input name="phone" type="text" required placeholder="e.g. 263771446827 or 0771446827"
            style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;font-size:13px">
          <p style="color:var(--muted);font-size:11px;margin-top:3px">The school's registered phone number on ZimQuote.</p>
        </div>
        <button type="submit" class="btn btn-green" style="padding:8px 16px;font-size:13px">➕ Add</button>
      </form>
    </div>

    <script>
    function copyText(text) {
      navigator.clipboard.writeText(text).then(() => {
        const t = document.createElement("div");
        t.textContent = "✅ Copied!";
        t.style.cssText = "position:fixed;bottom:24px;right:24px;background:#0f172a;color:white;padding:10px 18px;border-radius:8px;font-size:13px;z-index:9999";
        document.body.appendChild(t);
        setTimeout(() => t.remove(), 2000);
      });
    }
    </script>`;

    res.send(layout(`School Group: ${group.name}`, html));
  } catch (err) {
    res.redirect(`/zq-admin/school-groups?error=${encodeURIComponent(err.message)}`);
  }
});

// ── POST /zq-admin/school-groups/:slug/edit ───────────────────────────────────
router.post("/school-groups/:slug/edit", requireSupplierAdmin, async (req, res) => {
  try {
    const { name, tagline } = req.body;
    const mongoose = (await import("mongoose")).default;
    const SchoolGroup = mongoose.model("SchoolGroup");
    await SchoolGroup.findOneAndUpdate(
      { slug: req.params.slug },
      { $set: { name: String(name || "").trim(), tagline: String(tagline || "").trim() } }
    );
    res.redirect(`/zq-admin/school-groups/${encodeURIComponent(req.params.slug)}?success=Group+updated`);
  } catch (err) {
    res.redirect(`/zq-admin/school-groups/${encodeURIComponent(req.params.slug)}?error=${encodeURIComponent(err.message)}`);
  }
});

// ── POST /zq-admin/school-groups/:slug/add-school ─────────────────────────────
router.post("/school-groups/:slug/add-school", requireSupplierAdmin, async (req, res) => {
  try {
    await addSchoolToGroup(req.params.slug, req.body.phone);
    res.redirect(`/zq-admin/school-groups/${encodeURIComponent(req.params.slug)}?success=School+added`);
  } catch (err) {
    res.redirect(`/zq-admin/school-groups/${encodeURIComponent(req.params.slug)}?error=${encodeURIComponent(err.message)}`);
  }
});

// ── POST /zq-admin/school-groups/:slug/remove-school ──────────────────────────
router.post("/school-groups/:slug/remove-school", requireSupplierAdmin, async (req, res) => {
  try {
    await removeSchoolFromGroup(req.params.slug, req.body.phone);
    res.redirect(`/zq-admin/school-groups/${encodeURIComponent(req.params.slug)}?success=School+removed`);
  } catch (err) {
    res.redirect(`/zq-admin/school-groups/${encodeURIComponent(req.params.slug)}?error=${encodeURIComponent(err.message)}`);
  }
});

// ── POST /zq-admin/school-groups/:slug/delete ─────────────────────────────────
router.post("/school-groups/:slug/delete", requireSupplierAdmin, async (req, res) => {
  try {
    await deleteSchoolGroup(req.params.slug);
    res.redirect("/zq-admin/school-groups?success=Group+deleted");
  } catch (err) {
    res.redirect(`/zq-admin/school-groups?error=${encodeURIComponent(err.message)}`);
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// BROADCAST HUB  –  /zq-admin/broadcast
// ──────────────────────────────────────────────────────────────────────────────
// Uses the 4 approved MARKETING templates:
//   zqm_welcome_back      · zqm_add_your_business
//   zqm_news_update       · zqm_suppliers_ready
// ══════════════════════════════════════════════════════════════════════════════

const _broadcastLog   = [];   // in-memory session log (last 50 campaigns)
const _ENQUIRIES_LINK = "https://wa.me/263789901058";

// ── helpers shared by broadcast routes ───────────────────────────────────────
async function _buildPhoneList({ pool, cutoffDays, city, keyword }) {
  const Business  = (await import("../models/business.js")).default;
  const cutoffDate = cutoffDays > 0 ? new Date(Date.now() - cutoffDays * 86400000) : null;
  const normPhone  = p => {
    let d = String(p || "").replace(/\D+/g, "");
    if (d.startsWith("0") && d.length === 10) d = "263" + d.slice(1);
    return d.length >= 10 ? d : null;
  };
  let phones = [];
  if (pool === "searchers" || pool === "all") {
    const q = {};
    if (cutoffDate) q.createdAt = { $lte: cutoffDate };
    if (keyword)    q.$or = [{ rawText: { $regex: keyword, $options: "i" } }, { "parsed.product": { $regex: keyword, $options: "i" } }];
    phones.push(...await SearchCommandLog.distinct("phone", q));
  }
  if (pool === "businesses" || pool === "all") {
    const q = {};
    if (cutoffDate) q.updatedAt = { $lte: cutoffDate };
    if (city)       q["location.city"] = { $regex: city, $options: "i" };
    phones.push(...await Business.distinct("phone", q));
  }
  if (pool === "buyers" || pool === "all") {
    const q = {};
    if (cutoffDate) q.createdAt = { $lte: cutoffDate };
    phones.push(...await BuyerRequest.distinct("buyerPhone", q));
  }
  phones = [...new Set(phones)].map(normPhone).filter(Boolean);
  phones = [...new Set(phones)];
  return phones;
}

// Resolve a phone to a display name from SupplierProfile or Business
async function _resolveContactName(phone) {
  const SupProf = (await import("../models/supplierProfile.js")).default;
  const Biz     = (await import("../models/business.js")).default;
  const sp = await SupProf.findOne({ phone }, { businessName:1, location:1 }).lean();
  if (sp) return `${sp.businessName}${sp.location?.city ? " · "+sp.location.city : ""}`;
  const biz = await Biz.findOne({ phone }, { sessionData:1 }).lean();
  if (biz?.sessionData?.businessName) return biz.sessionData.businessName;
  return null;
}

// ── GET /zq-admin/broadcast ───────────────────────────────────────────────────
router.get("/broadcast", requireSupplierAdmin, async (req, res) => {
  try {
    const Business = (await import("../models/business.js")).default;

    const [searchers, bizPhones, buyerPhones] = await Promise.all([
      SearchCommandLog.distinct("phone"),
      Business.distinct("phone"),
      BuyerRequest.distinct("buyerPhone")
    ]);
    const totalAll = new Set([...searchers, ...bizPhones, ...buyerPhones]).size;

    const successMsg = req.query.success
      ? `<div style="background:#dcfce7;color:#16a34a;padding:14px 16px;border-radius:10px;margin-bottom:20px;font-size:13px;font-weight:600">✅ ${esc(req.query.success)}</div>` : "";
    const errorMsg = req.query.error
      ? `<div style="background:#fee2e2;color:#dc2626;padding:14px 16px;border-radius:10px;margin-bottom:20px;font-size:13px">❌ ${esc(req.query.error)}</div>` : "";

    // Campaign log rows
    const logRows = _broadcastLog.slice(-50).reverse().map(c => `
      <tr>
        <td style="white-space:nowrap;padding:8px 10px;font-size:12px">${esc(new Date(c.ts).toLocaleString("en-GB",{day:"numeric",month:"short",hour:"2-digit",minute:"2-digit"}))}</td>
        <td style="padding:8px 10px"><code style="font-size:11px;background:#f1f5f9;padding:2px 6px;border-radius:4px">${esc(c.tpl)}</code></td>
        <td style="padding:8px 10px;font-size:12px;color:var(--muted)">${esc(c.audience)}</td>
        <td style="padding:8px 10px;text-align:center;font-size:12px">${c.total}</td>
        <td style="padding:8px 10px;text-align:center;color:#16a34a;font-weight:700;font-size:12px">${c.sent}</td>
        <td style="padding:8px 10px;text-align:center;color:${c.failed>0?"#dc2626":"var(--muted)"};font-size:12px">${c.failed}</td>
        <td style="padding:8px 10px"><span style="background:${c.dryRun?"#fef9c3":"#dcfce7"};color:${c.dryRun?"#854d0e":"#15803d"};padding:2px 8px;border-radius:8px;font-size:10px;font-weight:700">${c.dryRun?"DRY RUN":"LIVE"}</span></td>
      </tr>`).join("") || `<tr><td colspan="7" style="padding:20px;text-align:center;color:var(--muted);font-size:13px">No campaigns sent this session.</td></tr>`;

    res.send(layout("Broadcast Hub", `
      ${successMsg}${errorMsg}

      <!-- stats row -->
      <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:24px">
        ${stat(searchers.length,  "Searchers",      "blue")}
        ${stat(bizPhones.length,  "Businesses",     "green")}
        ${stat(buyerPhones.length,"Buyer Requests", "")}
        ${stat(totalAll,          "Total Contacts", "purple")}
      </div>

      <!-- template reference -->
      <details style="margin-bottom:20px;background:white;border-radius:10px;border:1px solid var(--border)">
        <summary style="cursor:pointer;font-size:13px;font-weight:700;color:var(--blue);padding:14px 16px;list-style:none">
          📋 Approved Template Reference - click to expand
        </summary>
        <div style="padding:0 16px 16px;font-size:12px;line-height:2;color:#334155;font-family:monospace;border-top:1px solid var(--border);margin-top:0">

          <strong style="font-size:13px">0. zqm_broadcast_image</strong> &nbsp;<span style="background:#dcfce7;color:#15803d;padding:1px 7px;border-radius:4px;font-size:10px;font-family:sans-serif">UTILITY · APPROVED ✅</span><br>
          <b>Type:</b> Image header + body text<br>
          <b>Body:</b><br>
          ZimQuote<br>
          <b>{{1}}</b><br>
          For queries, contact our team on 263789901058.<br>
          <b>Usage:</b> Attach an image in Step 3, type your message in {{1}}<br>
          <b>Example:</b> {{1}} = <code>Dear customer, please find attached our latest product list.</code><br><br>

          <strong style="font-size:13px">1. zqm_welcome_back</strong> &nbsp;<span style="background:#dbeafe;color:#1e40af;padding:1px 7px;border-radius:4px;font-size:10px;font-family:sans-serif">MARKETING</span><br>
          <b>Header:</b> Welcome Back to ZimQuote<br>
          <b>Body:</b><br>
          Good news - ZimQuote now has <b>{{1}}</b> businesses listed across Zimbabwe,<br>
          including plumbers, electricians, builders, grocers and more.<br>
          You can search for any product or service and receive quotes directly<br>
          on WhatsApp within minutes.<br>
          Our team is on 263789901058 if you need help.<br>
          <b>Footer:</b> ZimQuote · Zimbabwe on WhatsApp<br>
          <b>Button:</b> Quick Reply · 🔍 Search Now · payload: main_menu_back<br>
          <b>Example:</b> {{1}} = <code>47</code><br><br>

          <strong style="font-size:13px">2. zqm_add_your_business</strong> &nbsp;<span style="background:#dbeafe;color:#1e40af;padding:1px 7px;border-radius:4px;font-size:10px;font-family:sans-serif">MARKETING</span><br>
          <b>Header:</b> Add Your Business to ZimQuote<br>
          <b>Body:</b><br>
          Hi! Buyers in Zimbabwe are already searching for <b>{{1}}</b> on ZimQuote<br>
          but we have no supplier listed yet. If your business offers this,<br>
          you can add your listing at no cost and start receiving quote requests<br>
          directly on WhatsApp.<br>
          Send us a message to register. Our team is on 263789901058.<br>
          <b>Footer:</b> ZimQuote · Zimbabwe on WhatsApp<br>
          <b>Button:</b> Quick Reply · ➕ Register My Business · payload: list_my_business<br>
          <b>Example:</b> {{1}} = <code>plumbers in Harare</code><br><br>

          <strong style="font-size:13px">3. zqm_news_update</strong> &nbsp;<span style="background:#dbeafe;color:#1e40af;padding:1px 7px;border-radius:4px;font-size:10px;font-family:sans-serif">MARKETING</span><br>
          <b>Header:</b> ZimQuote News<br>
          <b>Body:</b><br>
          Hi! Here is an update from the ZimQuote team.<br>
          <b>{{1}}</b><br>
          If you have questions or need assistance, our team is available<br>
          on 263789901058 - just send us a message.<br>
          <b>Footer:</b> ZimQuote · Zimbabwe on WhatsApp<br>
          <b>Button:</b> Quick Reply · 💬 Get in Touch · payload: main_menu_back<br>
          <b>Example:</b> {{1}} = <code>We have added new verified suppliers in Harare and Bulawayo covering plumbing, electrical work and solar installations. Send us what you need and we will find you quotes right away.</code><br><br>

          <strong style="font-size:13px">4. zqm_suppliers_ready</strong> &nbsp;<span style="background:#dbeafe;color:#1e40af;padding:1px 7px;border-radius:4px;font-size:10px;font-family:sans-serif">MARKETING</span><br>
          <b>Header:</b> {{1}} Suppliers Ready to Quote You &nbsp;<em>({{1}} also appears in header)</em><br>
          <b>Body:</b><br>
          Hi! ZimQuote has <b>{{2}}</b> verified <b>{{1}}</b> businesses in Zimbabwe who<br>
          can send you a price and availability quote directly on WhatsApp.<br>
          No phone calls needed - just send us a message to get started.<br>
          Our team is on 263789901058 if you need help.<br>
          <b>Footer:</b> ZimQuote · Zimbabwe on WhatsApp<br>
          <b>Button:</b> Quick Reply · 🏪 View Suppliers · payload: main_menu_back<br>
          <b>Example:</b> {{1}} = <code>Plumbing</code> &nbsp;|&nbsp; {{2}} = <code>4</code>
        </div>
      </details>

      <!-- composer -->
      <div style="background:white;border-radius:12px;padding:24px;box-shadow:0 1px 3px rgba(0,0,0,.08);margin-bottom:24px">
        <h3 style="font-size:16px;font-weight:700;margin-bottom:4px">📡 Compose & Send</h3>
        <p style="font-size:12px;color:var(--muted);margin-bottom:20px">
          Rate: 1 message / 3 seconds. Enquiries: <a href="${_ENQUIRIES_LINK}" target="_blank" style="color:var(--blue)">wa.me/263789901058</a>
        </p>

        <form method="POST" action="/zq-admin/broadcast" onsubmit="
          var ta=document.getElementById('var1Textarea');
          var inp=document.getElementById('var1Input');
          if(ta && !ta.disabled && ta.value.trim()){
            inp.value=ta.value;
            inp.disabled=false;
          }
          return true;
        ">

          <!-- Step 1: Audience -->
          <fieldset style="border:1px solid var(--border);border-radius:8px;padding:16px;margin-bottom:16px">
            <legend style="font-size:11px;font-weight:700;color:var(--muted);padding:0 8px;text-transform:uppercase;letter-spacing:.5px">Step 1 · Audience</legend>

            <!-- Audience mode tabs -->
            <div style="display:flex;gap:8px;margin-bottom:14px;flex-wrap:wrap">
              <button type="button" id="modeFilter" onclick="setAudienceMode('filter')"
                style="padding:6px 14px;border-radius:6px;border:2px solid var(--blue);background:var(--blue);color:white;font-size:12px;font-weight:700;cursor:pointer">
                🔎 Filter from database
              </button>
              <button type="button" id="modeManual" onclick="setAudienceMode('manual')"
                style="padding:6px 14px;border-radius:6px;border:2px solid var(--border);background:white;color:var(--text);font-size:12px;font-weight:600;cursor:pointer">
                ✏️ Enter phones manually
              </button>
              <button type="button" id="modeSelect" onclick="setAudienceMode('select')"
                style="padding:6px 14px;border-radius:6px;border:2px solid var(--border);background:white;color:var(--text);font-size:12px;font-weight:600;cursor:pointer">
                ☑️ Pick contacts from list
              </button>
            </div>
            <input type="hidden" name="audienceMode" id="audienceMode" value="filter" />

            <!-- Filter mode -->
            <div id="filterPanel">
              <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px">
                <div>
                  <label style="font-size:12px;font-weight:600;display:block;margin-bottom:4px">Contact Pool</label>
                  <select name="pool" style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;font-size:13px">
                    <option value="all">👥 All contacts</option>
                    <option value="searchers">🔎 Searchers only</option>
                    <option value="businesses">🏪 Registered businesses only</option>
                    <option value="buyers">📋 Buyer request submitters only</option>
                  </select>
                </div>
                <div>
                  <label style="font-size:12px;font-weight:600;display:block;margin-bottom:4px">Inactive for at least</label>
                  <select name="inactiveDays" style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;font-size:13px">
                    <option value="0">All (any activity)</option>
                    <option value="7">7+ days</option>
                    <option value="14" selected>14+ days</option>
                    <option value="30">30+ days</option>
                    <option value="60">60+ days</option>
                    <option value="90">90+ days</option>
                  </select>
                </div>
              </div>
              <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
                <div>
                  <label style="font-size:12px;font-weight:600;display:block;margin-bottom:4px">City (optional)</label>
                  <select name="city" style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;font-size:13px">
                    <option value="">🌍 All cities</option>
                    <option>Harare</option><option>Bulawayo</option><option>Mutare</option>
                    <option>Gweru</option><option>Kwekwe</option><option>Masvingo</option>
                    <option>Chinhoyi</option><option>Bindura</option><option>Victoria Falls</option>
                  </select>
                </div>
                <div>
                  <label style="font-size:12px;font-weight:600;display:block;margin-bottom:4px">Keyword filter (optional)</label>
                  <input name="keyword" placeholder="e.g. plumber, solar, grocery"
                    style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;font-size:13px" />
                </div>
              </div>
            </div>

            <!-- Manual phone entry mode -->
            <div id="manualPanel" style="display:none">
              <label style="font-size:12px;font-weight:600;display:block;margin-bottom:6px">
                Phone numbers - one per line, or comma separated
                <span style="font-weight:400;color:var(--muted)">(Zim format: 0771234567 or 263771234567)</span>
              </label>
              <textarea name="manualPhones" rows="6" placeholder="0771234567&#10;0772345678&#10;263773456789&#10;..."
                style="width:100%;padding:10px;border:1px solid var(--border);border-radius:6px;font-size:13px;font-family:monospace;resize:vertical"></textarea>
              <p style="font-size:11px;color:var(--muted);margin-top:4px">Duplicates are automatically removed before sending.</p>
            </div>

            <!-- Pick from list mode -->
            <div id="selectPanel" style="display:none">
              <p style="font-size:12px;color:var(--muted);margin-bottom:10px">
                First use the filter above to narrow down contacts, then click <strong>Load Contact List</strong> to choose individually.
              </p>
              <div style="display:flex;gap:8px;margin-bottom:10px;flex-wrap:wrap">
                <select id="selectPool" style="padding:7px 10px;border:1px solid var(--border);border-radius:6px;font-size:12px">
                  <option value="all">All contacts</option>
                  <option value="searchers">Searchers only</option>
                  <option value="businesses">Businesses only</option>
                  <option value="buyers">Buyers only</option>
                </select>
                <select id="selectDays" style="padding:7px 10px;border:1px solid var(--border);border-radius:6px;font-size:12px">
                  <option value="0">Any activity</option>
                  <option value="7">7+ days inactive</option>
                  <option value="14" selected>14+ days inactive</option>
                  <option value="30">30+ days inactive</option>
                  <option value="60">60+ days inactive</option>
                  <option value="90">90+ days inactive</option>
                </select>
                <input id="selectCity" placeholder="City (optional)" style="padding:7px 10px;border:1px solid var(--border);border-radius:6px;font-size:12px;width:140px" />
                <input id="selectKeyword" placeholder="Keyword (optional)" style="padding:7px 10px;border:1px solid var(--border);border-radius:6px;font-size:12px;width:160px" />
                <button type="button" onclick="loadContactList()"
                  style="padding:7px 16px;background:var(--blue);color:white;border:none;border-radius:6px;font-size:12px;font-weight:700;cursor:pointer">
                  Load List
                </button>
              </div>
              <div id="contactListWrap" style="display:none;border:1px solid var(--border);border-radius:8px;overflow:hidden">
                <div style="background:#f8fafc;padding:8px 12px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between">
                  <span id="contactListCount" style="font-size:12px;font-weight:700;color:var(--muted)">0 contacts</span>
                  <div style="display:flex;gap:8px">
                    <button type="button" onclick="selectAllContacts(true)"
                      style="padding:4px 10px;font-size:11px;background:#e0f2fe;color:#0369a1;border:none;border-radius:4px;cursor:pointer;font-weight:600">Select All</button>
                    <button type="button" onclick="selectAllContacts(false)"
                      style="padding:4px 10px;font-size:11px;background:#f1f5f9;color:var(--text);border:none;border-radius:4px;cursor:pointer">Deselect All</button>
                  </div>
                </div>
                <div id="contactListBody" style="max-height:320px;overflow-y:auto;padding:8px 12px"></div>
              </div>
              <!-- hidden field that carries selected phones to POST -->
              <textarea name="selectedPhones" id="selectedPhones" style="display:none"></textarea>
            </div>

          </fieldset>

          <!-- Step 2: Template -->
          <fieldset style="border:1px solid var(--border);border-radius:8px;padding:16px;margin-bottom:16px">
            <legend style="font-size:11px;font-weight:700;color:var(--muted);padding:0 8px;text-transform:uppercase;letter-spacing:.5px">Step 2 · Template & Variables</legend>

            <div style="margin-bottom:14px">
              <label style="font-size:12px;font-weight:600;display:block;margin-bottom:4px">Template</label>
              <select name="templateName" id="tplSelect"
                style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;font-size:13px"
                onchange="onTplChange(this.value)">
                <option value="zqm_broadcast_image">📸 zqm_broadcast_image · Image Broadcast · {{1}}=message text (approved ✅)</option>
                <option value="zqm_welcome_back">zqm_welcome_back · Welcome Back / Re-engagement · {{1}}=count</option>
                <option value="zqm_add_your_business">zqm_add_your_business · Add Your Business · {{1}}=category</option>
                <option value="zqm_news_update">zqm_news_update · News / Update · {{1}}=full text</option>
                <option value="zqm_suppliers_ready">zqm_suppliers_ready · Suppliers Ready · {{1}}=category  {{2}}=count</option>
              </select>
            </div>

            <div style="margin-bottom:10px">
              <label style="font-size:12px;font-weight:600;display:block;margin-bottom:4px" id="var1Label">{{1}} - Total businesses listed</label>
              <!-- Single-line input for short variables (default templates) -->
              <input name="var1" id="var1Input" placeholder="e.g. 47"
                style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;font-size:13px;display:block" />
              <!-- Multi-line textarea for zqm_broadcast_image (long message text) -->
              <textarea name="var1_multi" id="var1Textarea"
                placeholder="Type your full message here. Line breaks and paragraphs will be preserved."
                style="display:none;width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;font-size:13px;min-height:180px;resize:vertical;font-family:inherit;line-height:1.5"></textarea>
              <p id="var1MultiHint" style="display:none;font-size:11px;color:var(--muted);margin:4px 0 0">
                ✅ Line breaks and paragraphs are preserved in delivery.
              </p>
            </div>

            <div id="var2Row" style="display:none;margin-bottom:10px">
              <label style="font-size:12px;font-weight:600;display:block;margin-bottom:4px" id="var2Label">{{2}} - Number of suppliers</label>
              <input name="var2" id="var2Input" placeholder="e.g. 4"
                style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;font-size:13px" />
            </div>
          </fieldset>

          <!-- Step 3: Optional media -->
          <fieldset style="border:1px solid var(--border);border-radius:8px;padding:16px;margin-bottom:16px" id="mediaFields">
            <legend style="font-size:11px;font-weight:700;color:var(--muted);padding:0 8px;text-transform:uppercase;letter-spacing:.5px">Step 3 · Media Attachment</legend>
            <div id="mediaWarning" style="background:#fef9c3;border:1px solid #fde047;border-radius:6px;padding:10px 14px;font-size:12px;color:#854d0e;margin-bottom:12px">
              ℹ️ Select <strong>zqm_broadcast_image</strong> in Step 2 to enable image attachment. For other templates, media is not supported.
            </div>

            <!-- Media source tabs -->
            <div style="display:flex;gap:8px;margin-bottom:14px">
              <button type="button" id="mediaNone" onclick="setMediaMode('none')"
                style="padding:5px 12px;border-radius:6px;border:2px solid var(--blue);background:var(--blue);color:white;font-size:11px;font-weight:700;cursor:pointer">No media</button>
              <button type="button" id="mediaUpload" onclick="setMediaMode('upload')"
                style="padding:5px 12px;border-radius:6px;border:2px solid var(--border);background:white;color:var(--text);font-size:11px;font-weight:600;cursor:pointer">⬆ Upload file</button>
              <button type="button" id="mediaUrl" onclick="setMediaMode('url')"
                style="padding:5px 12px;border-radius:6px;border:2px solid var(--border);background:white;color:var(--text);font-size:11px;font-weight:600;cursor:pointer">🔗 Use URL</button>
            </div>
            <input type="hidden" name="mediaMode" id="mediaMode" value="none" />

            <!-- Upload panel -->
            <div id="mediaUploadPanel" style="display:none">
              <div style="border:2px dashed var(--border);border-radius:8px;padding:20px;text-align:center;background:#fafafa;cursor:pointer"
                onclick="document.getElementById('mediaFileInput').click()"
                ondragover="event.preventDefault();this.style.borderColor='var(--blue)'"
                ondragleave="this.style.borderColor='var(--border)'"
                ondrop="handleFileDrop(event)">
                <div style="font-size:28px;margin-bottom:8px">📁</div>
                <div style="font-size:13px;font-weight:600;color:var(--text);margin-bottom:4px">Click or drag a file here</div>
                <div style="font-size:11px;color:var(--muted)">Images (JPG, PNG, GIF, WebP) · PDF · Video (MP4) · Max 16 MB</div>
                <input type="file" id="mediaFileInput" accept=".jpg,.jpeg,.png,.gif,.webp,.pdf,.mp4,.mov"
                  style="display:none" onchange="handleFileSelect(this)" />
              </div>
              <div id="uploadStatus" style="margin-top:8px;font-size:12px;display:none"></div>
              <!-- After upload, the returned URL is stored here -->
              <input type="hidden" name="uploadedMediaUrl" id="uploadedMediaUrl" value="" />
              <input type="hidden" name="uploadedMediaType" id="uploadedMediaType" value="" />
            </div>

            <!-- URL panel -->
            <div id="mediaUrlPanel" style="display:none">
              <div style="display:grid;grid-template-columns:1fr 120px 200px;gap:10px;align-items:end">
                <div>
                  <label style="font-size:12px;font-weight:600;display:block;margin-bottom:4px">Public Media URL</label>
                  <input name="headerMediaUrl" id="headerMediaUrl" placeholder="https://yourserver.com/promo.jpg"
                    style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;font-size:13px" />
                </div>
                <div>
                  <label style="font-size:12px;font-weight:600;display:block;margin-bottom:4px">Type</label>
                  <select name="headerType" id="headerType" style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;font-size:13px">
                    <option value="image">🖼 Image</option>
                    <option value="document">📄 PDF</option>
                    <option value="video">🎬 Video</option>
                  </select>
                </div>
                <div>
                  <label style="font-size:12px;font-weight:600;display:block;margin-bottom:4px">Filename (PDF only)</label>
                  <input name="headerFilename" value="ZimQuote.pdf"
                    style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;font-size:13px" />
                </div>
              </div>
            </div>

            <!-- Recently uploaded files picker -->
            <div id="recentUploadsWrap" style="margin-top:12px;display:none">
              <p style="font-size:11px;font-weight:700;color:var(--muted);margin-bottom:6px;text-transform:uppercase;letter-spacing:.5px">Recently uploaded files</p>
              <div id="recentUploadsList" style="display:flex;gap:8px;flex-wrap:wrap"></div>
            </div>
          </fieldset>

          <!-- Step 4: Send options -->
          <fieldset style="border:1px solid var(--border);border-radius:8px;padding:16px;margin-bottom:20px">
            <legend style="font-size:11px;font-weight:700;color:var(--muted);padding:0 8px;text-transform:uppercase;letter-spacing:.5px">Step 4 · Send Options</legend>
            <div style="display:flex;align-items:center;gap:20px;flex-wrap:wrap">
              <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:13px;font-weight:600">
                <input type="checkbox" name="dryRun" value="1" checked style="width:16px;height:16px" />
                🧪 Dry Run - preview count, no messages sent
              </label>
              <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:13px">
                <input type="checkbox" name="dedupePhones" value="1" checked style="width:16px;height:16px" />
                Deduplicate contacts
              </label>
            </div>
            <p style="font-size:11px;color:#854d0e;background:#fef9c3;border-radius:6px;padding:8px 12px;margin-top:12px">
              ⚠️ Uncheck Dry Run only when ready. 100 contacts ≈ 5 minutes at 3 s/msg.
            </p>
          </fieldset>

          <div style="display:flex;gap:10px">
            <button type="submit" name="action" value="preview"
              style="background:#e0f2fe;color:#0369a1;border:none;padding:10px 22px;border-radius:8px;font-size:13px;font-weight:700;cursor:pointer">
              🔍 Preview Audience Count
            </button>
            <button type="submit" name="action" value="send"
              onclick="return confirm('Send broadcast? Uncheck Dry Run first if you want real sends.')"
              class="btn btn-blue">
              📤 Send Broadcast
            </button>
          </div>
        </form>
      </div>

      <!-- campaign log -->
      <div style="background:white;border-radius:12px;padding:20px;box-shadow:0 1px 3px rgba(0,0,0,.08)">
        <h3 style="font-size:15px;font-weight:700;margin-bottom:14px">📋 Campaign Log (this session)</h3>
        <div style="overflow-x:auto">
          <table style="width:100%;border-collapse:collapse;font-size:13px">
            <thead><tr style="background:#f8fafc">
              <th style="padding:8px 10px;text-align:left;font-size:11px;color:var(--muted);border-bottom:1px solid var(--border)">Time</th>
              <th style="padding:8px 10px;text-align:left;font-size:11px;color:var(--muted);border-bottom:1px solid var(--border)">Template</th>
              <th style="padding:8px 10px;text-align:left;font-size:11px;color:var(--muted);border-bottom:1px solid var(--border)">Audience</th>
              <th style="padding:8px 10px;text-align:center;font-size:11px;color:var(--muted);border-bottom:1px solid var(--border)">Total</th>
              <th style="padding:8px 10px;text-align:center;font-size:11px;color:var(--muted);border-bottom:1px solid var(--border)">Sent</th>
              <th style="padding:8px 10px;text-align:center;font-size:11px;color:var(--muted);border-bottom:1px solid var(--border)">Failed</th>
              <th style="padding:8px 10px;text-align:left;font-size:11px;color:var(--muted);border-bottom:1px solid var(--border)">Mode</th>
            </tr></thead>
            <tbody>${logRows}</tbody>
          </table>
        </div>
      </div>

      <script>
      // ── Template variable hints ──────────────────────────────────────────────
      // ── Shared state - must be declared before any function that uses it ──────
      let _recentUploads = []; // in-memory uploaded files for this session

      const TPL_META = {
        zqm_broadcast_image:   { v1: "{{1}} - Your message text (image must be attached via Step 3)  e.g. Dear customer, please find attached.", v2: false, hasMedia: true },
        zqm_welcome_back:      { v1: "{{1}} - Total businesses listed  e.g. 47",                                               v2: false, hasMedia: false },
        zqm_add_your_business: { v1: "{{1}} - Category buyers are searching  e.g. plumbers in Harare",                        v2: false, hasMedia: false },
        zqm_news_update:       { v1: "{{1}} - Full update text  e.g. We have added new verified suppliers in Harare...",       v2: false, hasMedia: false },
        zqm_suppliers_ready:   { v1: "{{1}} - Category name, capitalised (also goes in header)  e.g. Plumbing",               v2: "{{2}} - Number of suppliers  e.g. 4", hasMedia: false }
      };
      function onTplChange(v) {
        const m = TPL_META[v] || {};
        document.getElementById("var1Label").textContent = m.v1 || "{{1}}";
        const r2 = document.getElementById("var2Row");
        if (m.v2) { r2.style.display=""; document.getElementById("var2Label").textContent = m.v2; }
        else        r2.style.display = "none";

        // Toggle between single-line input and multi-line textarea
        const inp  = document.getElementById("var1Input");
        const ta   = document.getElementById("var1Textarea");
        const hint = document.getElementById("var1MultiHint");
        if (m.hasMedia) {
          // Multi-line textarea for image broadcast
          inp.style.display  = "none";
          inp.disabled       = true;
          ta.style.display   = "block";
          ta.disabled        = false;
          if (hint) hint.style.display = "block";
        } else {
          // Single-line input for other templates
          ta.style.display   = "none";
          ta.disabled        = true;
          inp.style.display  = "block";
          inp.disabled       = false;
          if (hint) hint.style.display = "none";
        }

        // Show/hide media warning based on template
        const mediaWarn   = document.getElementById("mediaWarning");
        const mediaFields = document.getElementById("mediaFields");
        if (m.hasMedia) {
          if (mediaWarn)   mediaWarn.style.display   = "none";
          if (mediaFields) mediaFields.style.opacity = "1";
          setMediaMode("upload");
        } else {
          if (mediaWarn)   mediaWarn.style.display   = "";
          if (mediaFields) mediaFields.style.opacity = "0.6";
          setMediaMode("none");
        }
      }
      onTplChange(document.getElementById("tplSelect").value);

      // ── Media mode tabs ──────────────────────────────────────────────────
      function setMediaMode(mode) {
        document.getElementById("mediaMode").value = mode;
        ["none","upload","url"].forEach(m => {
          const btn = document.getElementById("media" + m.charAt(0).toUpperCase() + m.slice(1));
          const panel = document.getElementById("mediaUploadPanel") || null;
          if (btn) {
            btn.style.background   = m === mode ? "var(--blue)" : "white";
            btn.style.color        = m === mode ? "white"       : "var(--text)";
            btn.style.borderColor  = m === mode ? "var(--blue)" : "var(--border)";
          }
        });
        const up = document.getElementById("mediaUploadPanel");
        const ur = document.getElementById("mediaUrlPanel");
        if (up) up.style.display = mode === "upload" ? "" : "none";
        if (ur) ur.style.display = mode === "url"    ? "" : "none";
        if (mode === "upload" && _recentUploads.length) renderRecentUploads();
        document.getElementById("recentUploadsWrap").style.display =
          (mode === "upload" && _recentUploads.length) ? "" : "none";
      }

      // ── File upload ──────────────────────────────────────────────────────
      function handleFileDrop(e) {
        e.preventDefault();
        e.currentTarget.style.borderColor = "var(--border)";
        const file = e.dataTransfer.files[0];
        if (file) uploadFile(file);
      }
      function handleFileSelect(input) {
        const file = input.files[0];
        if (file) uploadFile(file);
      }

      async function uploadFile(file) {
        const status = document.getElementById("uploadStatus");
        status.style.display = "";
        status.innerHTML = \`<span style="color:var(--blue)">⬆ Uploading <strong>\${file.name}</strong>...</span>\`;

        const fd = new FormData();
        fd.append("broadcastFile", file);

        try {
          const res  = await fetch("/zq-admin/broadcast/upload", { method: "POST", body: fd });
          const data = await res.json();
          if (!res.ok || data.error) throw new Error(data.error || "Upload failed");

          document.getElementById("uploadedMediaUrl").value  = data.url;
          document.getElementById("uploadedMediaType").value = data.mediaType;

          status.innerHTML = \`
            <div style="background:#f0fdf4;border:1px solid #86efac;border-radius:6px;padding:10px 12px;display:flex;align-items:center;gap:10px">
              \${data.mediaType === "image"
                ? \`<img src="\${data.url}" style="height:48px;width:48px;object-fit:cover;border-radius:4px" />\`
                : \`<span style="font-size:24px">\${data.mediaType === "document" ? "📄" : "🎬"}</span>\`}
              <div>
                <div style="font-size:12px;font-weight:700;color:#15803d">✅ Uploaded successfully</div>
                <div style="font-size:11px;color:#16a34a;word-break:break-all">\${data.url}</div>
                <div style="font-size:11px;color:var(--muted)">Type: \${data.mediaType} · \${(file.size/1024).toFixed(0)} KB</div>
              </div>
              <button type="button" onclick="clearUpload()" style="margin-left:auto;padding:4px 8px;font-size:11px;background:#fee2e2;color:#dc2626;border:none;border-radius:4px;cursor:pointer">✕ Remove</button>
            </div>\`;

          _recentUploads.unshift({ url: data.url, mediaType: data.mediaType, name: file.name });
          if (_recentUploads.length > 10) _recentUploads.pop();
          renderRecentUploads();
          document.getElementById("recentUploadsWrap").style.display = "";

        } catch(e) {
          status.innerHTML = \`<div style="color:#dc2626;font-size:12px">❌ Upload failed: \${e.message}</div>\`;
        }
      }

      function clearUpload() {
        document.getElementById("uploadedMediaUrl").value  = "";
        document.getElementById("uploadedMediaType").value = "";
        document.getElementById("uploadStatus").style.display = "none";
        document.getElementById("mediaFileInput").value = "";
      }

      function renderRecentUploads() {
        const list = document.getElementById("recentUploadsList");
        list.innerHTML = _recentUploads.map((u,i) => \`
          <div style="border:1px solid var(--border);border-radius:6px;padding:6px 10px;font-size:11px;cursor:pointer;background:white;display:flex;align-items:center;gap:6px"
            onclick="useRecentUpload(\${i})" title="Click to use this file">
            <span>\${u.mediaType==="image"?"🖼":u.mediaType==="document"?"📄":"🎬"}</span>
            <span style="max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">\${u.name}</span>
            <span style="color:var(--blue);font-weight:700">Use</span>
          </div>\`).join("");
      }

      function useRecentUpload(i) {
        const u = _recentUploads[i];
        document.getElementById("uploadedMediaUrl").value  = u.url;
        document.getElementById("uploadedMediaType").value = u.mediaType;
        const status = document.getElementById("uploadStatus");
        status.style.display = "";
        status.innerHTML = \`<div style="background:#f0fdf4;border:1px solid #86efac;border-radius:6px;padding:8px 12px;font-size:12px;color:#15803d">
          ✅ Using: \${u.name} (<a href="\${u.url}" target="_blank" style="color:#0369a1">\${u.url}</a>)</div>\`;
      }
      function setAudienceMode(mode) {
        document.getElementById("audienceMode").value = mode;
        ["filter","manual","select"].forEach(m => {
          const panel = document.getElementById(m + "Panel");
          const btn   = document.getElementById("mode" + m.charAt(0).toUpperCase() + m.slice(1));
          if (m === mode) {
            panel.style.display = "";
            btn.style.background = "var(--blue)";
            btn.style.color      = "white";
            btn.style.borderColor = "var(--blue)";
          } else {
            panel.style.display = "none";
            btn.style.background  = "white";
            btn.style.color       = "var(--text)";
            btn.style.borderColor = "var(--border)";
          }
        });
      }

      // ── Contact list loader (calls /broadcast/contacts JSON endpoint) ────────
      let _selectedPhones = new Set();

      async function loadContactList() {
        const pool    = document.getElementById("selectPool").value;
        const days    = document.getElementById("selectDays").value;
        const city    = document.getElementById("selectCity").value;
        const keyword = document.getElementById("selectKeyword").value;

        const wrap = document.getElementById("contactListWrap");
        const body = document.getElementById("contactListBody");
        body.innerHTML = '<div style="padding:20px;text-align:center;color:var(--muted);font-size:13px">Loading...</div>';
        wrap.style.display = "";

        try {
          const qs = new URLSearchParams({ pool, days, city, keyword });
          const res = await fetch("/zq-admin/broadcast/contacts?" + qs);
          const data = await res.json();

          document.getElementById("contactListCount").textContent = data.contacts.length + " contacts";

          if (!data.contacts.length) {
            body.innerHTML = '<div style="padding:16px;text-align:center;color:var(--muted);font-size:13px">No contacts matched.</div>';
            return;
          }

          body.innerHTML = data.contacts.map(c => \`
            <label style="display:flex;align-items:center;gap:10px;padding:7px 4px;border-bottom:1px solid #f1f5f9;cursor:pointer;font-size:13px">
              <input type="checkbox" value="\${c.phone}" onchange="onContactCheck(this)"
                \${_selectedPhones.has(c.phone) ? "checked" : ""}
                style="width:15px;height:15px;cursor:pointer;flex-shrink:0" />
              <span style="font-family:monospace;color:#0369a1;font-size:12px;min-width:110px">\${c.phone}</span>
              <span style="color:var(--muted);font-size:12px">\${c.name || ""}</span>
              \${c.source ? \`<span style="margin-left:auto;background:#f1f5f9;color:var(--muted);font-size:10px;padding:1px 6px;border-radius:4px">\${c.source}</span>\` : ""}
            </label>
          \`).join("");

          syncSelectedField();
        } catch(e) {
          body.innerHTML = '<div style="padding:16px;color:#dc2626;font-size:13px">Error loading contacts: ' + e.message + '</div>';
        }
      }

      function onContactCheck(cb) {
        if (cb.checked) _selectedPhones.add(cb.value);
        else            _selectedPhones.delete(cb.value);
        syncSelectedField();
        const count = document.getElementById("contactListCount");
        const total = document.querySelectorAll("#contactListBody input[type=checkbox]").length;
        count.textContent = total + " contacts (" + _selectedPhones.size + " selected)";
      }

      function selectAllContacts(checked) {
        document.querySelectorAll("#contactListBody input[type=checkbox]").forEach(cb => {
          cb.checked = checked;
          if (checked) _selectedPhones.add(cb.value);
          else         _selectedPhones.delete(cb.value);
        });
        syncSelectedField();
        const total = document.querySelectorAll("#contactListBody input[type=checkbox]").length;
        document.getElementById("contactListCount").textContent =
          total + " contacts (" + _selectedPhones.size + " selected)";
      }

      function syncSelectedField() {
        document.getElementById("selectedPhones").value = [..._selectedPhones].join("\\n");
      }
      </script>
    `));
  } catch (err) {
    res.send(layout("Broadcast Hub", `<div style="color:red;padding:20px">Error: ${esc(err.message)}</div>`));
  }
});

// ── POST /zq-admin/broadcast/upload  (file upload for media attachments) ─────
router.post("/broadcast/upload", requireSupplierAdmin, _broadcastUpload.single("broadcastFile"), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file received or file type not allowed." });

    const ext       = _receiptPath.extname(req.file.originalname).toLowerCase();
    const mediaType = [".jpg",".jpeg",".png",".gif",".webp"].includes(ext) ? "image"
                    : [".mp4",".mov"].includes(ext)                         ? "video"
                    :                                                         "document";

    // Build the public URL - assumes express.static serves /public at root
    const host    = req.protocol + "://" + req.get("host");
    const fileUrl = host + "/broadcasts/" + req.file.filename;

    console.log(`[BROADCAST UPLOAD] ${req.file.originalname} → ${fileUrl} (${mediaType})`);
    res.json({ url: fileUrl, mediaType, filename: req.file.filename, originalName: req.file.originalname });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /zq-admin/broadcast/contacts  (JSON - used by contact picker) ────────
router.get("/broadcast/contacts", requireSupplierAdmin, async (req, res) => {
  try {
    const { pool = "all", days = "14", city = "", keyword = "" } = req.query;
    const phones = await _buildPhoneList({
      pool,
      cutoffDays: parseInt(days, 10) || 0,
      city,
      keyword
    });

    // Resolve names in parallel (batched, max 100 at a time to avoid overload)
    const SupProf = (await import("../models/supplierProfile.js")).default;
    const Biz     = (await import("../models/business.js")).default;
    const SearchLog = SearchCommandLog;

    // Batch-load profiles
    const [profiles, bizDocs, searchDocs] = await Promise.all([
      SupProf.find({ phone: { $in: phones } }, { phone:1, businessName:1, "location.city":1 }).lean(),
      Biz.find({ phone: { $in: phones } }, { phone:1, sessionData:1 }).lean(),
      SearchLog.find({ phone: { $in: phones } }, { phone:1, rawText:1 }).sort({ createdAt: -1 }).lean()
    ]);

    const profileMap = {};
    profiles.forEach(p => { profileMap[p.phone] = { name: p.businessName + (p.location?.city ? " · " + p.location.city : ""), source: "supplier" }; });
    bizDocs.forEach(b => { if (!profileMap[b.phone] && b.sessionData?.businessName) profileMap[b.phone] = { name: b.sessionData.businessName, source: "business" }; });
    searchDocs.forEach(s => { if (!profileMap[s.phone]) profileMap[s.phone] = { name: s.rawText ? "Searched: " + String(s.rawText).slice(0, 40) : "", source: "searcher" }; });

    const contacts = phones.map(phone => ({
      phone,
      name:   profileMap[phone]?.name   || "",
      source: profileMap[phone]?.source || "contact"
    }));

    res.json({ contacts });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /zq-admin/broadcast ──────────────────────────────────────────────────
// ── Self-contained sender for zqm_broadcast_image (image header + {{1}} body) ──
// Bypasses sendBroadcastTemplate since that function only knows the 4 older templates.
// Returns { sent, failed, skipped } matching the shape sendBroadcastTemplate returns.
async function _sendBroadcastImage({ phones, messageText, imageUrl, msPerMessage = 3000, dryRun = false }) {
  const PHONE_ID = process.env.WHATSAPP_PHONE_NUMBER_ID
                || process.env.META_PHONE_NUMBER_ID
                || process.env.PHONE_NUMBER_ID;
  const TOKEN    = process.env.META_ACCESS_TOKEN
                || process.env.WHATSAPP_ACCESS_TOKEN;

  let sent = 0, failed = 0, skipped = 0;

  for (const phone of phones) {
    if (dryRun) { skipped++; continue; }

    try {
      const body = {
        messaging_product: "whatsapp",
        to:   phone,
        type: "template",
        template: {
          name:     "zqm_broadcast_image",
          language: { code: "en" },
          components: [
            // Header: image
            {
              type: "header",
              parameters: [{ type: "image", image: { link: imageUrl } }]
            },
            // Body: {{1}} = messageText
            {
              type: "body",
              parameters: [{ type: "text", text: String(messageText || "").slice(0, 1024) }]
            }
          ]
        }
      };

      await axios.post(
        `https://graph.facebook.com/v24.0/${PHONE_ID}/messages`,
        body,
        { headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" } }
      );
      sent++;
    } catch (err) {
      console.error(`[BROADCAST IMAGE] Failed to ${phone}:`, err.response?.data?.error?.message || err.message);
      failed++;
    }

    if (msPerMessage > 0) {
      await new Promise(r => setTimeout(r, msPerMessage));
    }
  }

  return { sent, failed, skipped };
}

router.post("/broadcast", requireSupplierAdmin, async (req, res) => {
  try {
    const {
      audienceMode  = "filter",
      pool          = "all",
      inactiveDays  = "14",
      city          = "",
      keyword       = "",
      manualPhones  = "",
      selectedPhones = "",
      templateName,
      var1          = "",
      var2          = "",
      mediaMode     = "none",
      headerMediaUrl = "",
      headerType    = "image",
      headerFilename = "ZimQuote.pdf",
      uploadedMediaUrl  = "",
      uploadedMediaType = "image",
      dryRun,
      action        = "send"
    } = req.body;

    if (!templateName) throw new Error("Please select a template.");
    if (!var1.trim())  throw new Error("{{1}} variable is required.");

    const isDryRun = dryRun === "1" || action === "preview";

    // Resolve final media URL and type from whichever mode was used
    let finalMediaUrl  = null;
    let finalMediaType = "image";
    let finalFilename  = "ZimQuote.pdf";
    if (mediaMode === "upload" && uploadedMediaUrl.trim()) {
      finalMediaUrl  = uploadedMediaUrl.trim();
      finalMediaType = uploadedMediaType || "image";
      finalFilename  = "ZimQuote-Broadcast.pdf";
    } else if (mediaMode === "url" && headerMediaUrl.trim()) {
      finalMediaUrl  = headerMediaUrl.trim();
      finalMediaType = headerType;
      finalFilename  = headerFilename;
    }

    const normPhone = p => {
      let d = String(p || "").replace(/\D+/g, "");
      if (d.startsWith("0") && d.length === 10) d = "263" + d.slice(1);
      return d.length >= 10 ? d : null;
    };

    let phones = [];
    let audienceLabel = "";

    if (audienceMode === "manual") {
      // Parse manual textarea - split on newlines, commas, semicolons, spaces
      const raw = String(manualPhones || "").split(/[\n,;\s]+/).filter(Boolean);
      phones = raw.map(normPhone).filter(Boolean);
      phones = [...new Set(phones)];
      audienceLabel = `manual (${phones.length} entered)`;

    } else if (audienceMode === "select") {
      // Selected phones come from the hidden textarea (newline-separated)
      const raw = String(selectedPhones || "").split(/[\n,;\s]+/).filter(Boolean);
      phones = raw.map(normPhone).filter(Boolean);
      phones = [...new Set(phones)];
      audienceLabel = `selected (${phones.length} picked)`;

    } else {
      // filter mode - same DB query as before
      phones = await _buildPhoneList({
        pool,
        cutoffDays: parseInt(inactiveDays, 10) || 0,
        city,
        keyword
      });
      const cutoffDays = parseInt(inactiveDays, 10) || 0;
      audienceLabel = `${pool} / ${cutoffDays}d inactive${city ? " / "+city : ""}${keyword ? ' / "'+keyword+'"' : ""}`;
    }

    if (action === "preview") {
      return res.redirect(`/zq-admin/broadcast?success=${encodeURIComponent(
        `Preview: ${phones.length} contacts will receive this broadcast (mode: ${audienceMode}). Uncheck Dry Run to send.`
      )}`);
    }

    if (!phones.length) {
      return res.redirect(`/zq-admin/broadcast?error=${encodeURIComponent("No contacts to send to. Check your audience settings.")}`);
    }

    const variables = [var1.trim(), var2.trim()].filter(Boolean);

    let result;
    if (templateName === "zqm_broadcast_image") {
      // Handle the image broadcast template directly - sendBroadcastTemplate doesn't know this one
      if (!finalMediaUrl && !isDryRun) {
        return res.redirect(`/zq-admin/broadcast?error=${encodeURIComponent("zqm_broadcast_image requires an image. Please attach one in Step 3.")}`);
      }
      result = await _sendBroadcastImage({
        phones,
        messageText:  var1.trim() || "Dear customer, please find attached.",
        imageUrl:     finalMediaUrl || "",
        msPerMessage: isDryRun ? 0 : 3000,
        dryRun:       isDryRun
      });
    } else {
      const { sendBroadcastTemplate } = await import("../services/buyerRequestNotifications.js");
      result = await sendBroadcastTemplate({
        phones,
        templateName,
        variables,
        headerMediaUrl: finalMediaUrl,
        headerType:     finalMediaType,
        headerFilename: finalFilename,
        msPerMessage: isDryRun ? 0 : 3000,
        dryRun: isDryRun
      });
    }

    _broadcastLog.push({
      ts:       Date.now(),
      tpl:      templateName,
      audience: audienceLabel,
      total:    phones.length,
      sent:     result.sent,
      failed:   result.failed,
      dryRun:   isDryRun
    });
    if (_broadcastLog.length > 50) _broadcastLog.splice(0, _broadcastLog.length - 50);

    const modeLabel = isDryRun ? "Dry run" : "Broadcast sent";
    res.redirect(`/zq-admin/broadcast?success=${encodeURIComponent(
      `${modeLabel}: ${result.sent} ${isDryRun?"simulated":"sent"}, ${result.failed} failed, ${result.skipped} skipped - ${phones.length} total (${templateName})`
    )}`);

  } catch (err) {
    res.redirect(`/zq-admin/broadcast?error=${encodeURIComponent(err.message)}`);
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// ── REPORTS HUB - admin view of business reports (daily/weekly/monthly/balance)
// GET /zq-admin/reports-hub
// ══════════════════════════════════════════════════════════════════════════════
router.get("/reports-hub", requireSupplierAdmin, async (req, res) => {
  try {
    const Business   = (await import("../models/business.js")).default;
    const Branch     = (await import("../models/branch.js")).default;
    const Invoice    = (await import("../models/invoice.js")).default;
    const Expense    = (await import("../models/expense.js")).default;
    const InvoicePayment = (await import("../models/invoicePayment.js")).default;
    const CashBalance    = (await import("../models/cashBalance.js")).default;
    const CashPayout     = (await import("../models/cashPayout.js")).default.catch ? null
      : (await import("../models/cashPayout.js")).default;

    // Filters from query string
    const selBizId    = req.query.biz    || "";
    const selBranch   = req.query.branch || "";
    const selPeriod   = req.query.period || "daily";  // daily|weekly|monthly
    const selDate     = req.query.date   || new Date().toISOString().split("T")[0];

    // Load all businesses for the filter dropdown
    const businesses = await Business.find({}, { name: 1, _id: 1 }).sort({ name: 1 }).lean();

    // Load branches for selected business
    let branches = [];
    if (selBizId) {
      branches = await Branch.find({ businessId: selBizId }, { name: 1, _id: 1 }).lean();
    }

    // Build date range from period + date
    const anchor   = new Date(selDate + "T00:00:00.000Z");
    let   start    = new Date(anchor);
    let   end      = new Date(anchor);
    end.setHours(23, 59, 59, 999);

    if (selPeriod === "weekly") {
      start.setDate(start.getDate() - 6);
    } else if (selPeriod === "monthly") {
      start.setDate(1);
    }

    let reportHtml = "";
    let reportData = null;

    if (selBizId) {
      const biz = await Business.findById(selBizId).lean();
      if (biz) {
        const baseQ = { businessId: biz._id };
        if (selBranch) baseQ.branchId = selBranch;
        const rangeQ = { ...baseQ, createdAt: { $gte: start, $lte: end } };

        const [invoices, payments, expenses, balance, payouts] = await Promise.all([
          Invoice.find(rangeQ).sort({ createdAt: -1 }).lean(),
          InvoicePayment.find(rangeQ).sort({ createdAt: -1 }).lean(),
          Expense.find(rangeQ).sort({ createdAt: -1 }).lean(),
          CashBalance.findOne({ ...baseQ, date: { $gte: new Date(selDate + "T00:00:00.000Z"), $lte: new Date(selDate + "T23:59:59.999Z") } }).lean(),
          CashPayout ? CashPayout.find(rangeQ).sort({ createdAt: -1 }).lean() : []
        ]);

        const fmt = (n) => `$${Number(n||0).toFixed(2)}`;
        const totalInvoiced = invoices.reduce((s,i) => s + (i.total||0), 0);
        const totalPayments = payments.reduce((s,p) => s + (p.amount||0), 0);
        const totalExpenses = expenses.reduce((s,e) => s + (e.amount||0), 0);
        const totalPayouts  = (payouts||[]).reduce((s,p) => s + (p.amount||0), 0);
        const opening       = balance?.openingBalance || 0;
        const cashAtHand    = opening + totalPayments - totalExpenses - totalPayouts;

        const periodLabel = selPeriod === "daily" ? `Daily - ${selDate}`
          : selPeriod === "weekly" ? `Weekly - ${start.toLocaleDateString("en-GB",{day:"numeric",month:"short"})} to ${end.toLocaleDateString("en-GB",{day:"numeric",month:"short",year:"numeric"})}`
          : `Monthly - ${start.toLocaleDateString("en-GB",{month:"long",year:"numeric"})}`;

        const branchLabel = selBranch ? (branches.find(b => b._id.toString() === selBranch)?.name || selBranch) : "All Branches";

        reportData = { biz, periodLabel, branchLabel, totalInvoiced, totalPayments, totalExpenses, totalPayouts, opening, cashAtHand, invoices, payments, expenses, payouts: payouts||[], fmt };

        const invRows = invoices.map(i => `
          <tr>
            <td>${new Date(i.createdAt).toLocaleDateString("en-GB")}</td>
            <td><code>${esc(i.number||"-")}</code></td>
            <td>${esc(i.type||"invoice")}</td>
            <td>${esc(i.billingTo||"Walk-in")}</td>
            <td style="text-align:right;font-weight:600">${fmt(i.total)}</td>
            <td><a href="/docs/generated/receipts/${esc(i.pdfFile||"")}" target="_blank" style="color:var(--blue);font-size:11px">${i.pdfFile?"📄 PDF":""}</a></td>
          </tr>`).join("") || `<tr><td colspan="6" style="text-align:center;color:var(--muted);padding:16px">No invoices in this period.</td></tr>`;

        const expRows = expenses.map(e => `
          <tr>
            <td>${new Date(e.createdAt).toLocaleDateString("en-GB")}</td>
            <td>${esc(e.description||"-")}</td>
            <td>${esc(e.category||"Other")}</td>
            <td>${esc(e.method||"Cash")}</td>
            <td style="text-align:right;font-weight:600;color:#dc2626">${fmt(e.amount)}</td>
          </tr>`).join("") || `<tr><td colspan="5" style="text-align:center;color:var(--muted);padding:16px">No expenses in this period.</td></tr>`;

        const payRows = payments.map(p => `
          <tr>
            <td>${new Date(p.createdAt).toLocaleDateString("en-GB")}</td>
            <td>${esc(p.invoiceNumber||"-")}</td>
            <td>${esc(p.method||"Cash")}</td>
            <td style="text-align:right;font-weight:600;color:#16a34a">${fmt(p.amount)}</td>
          </tr>`).join("") || `<tr><td colspan="4" style="text-align:center;color:var(--muted);padding:16px">No payments in this period.</td></tr>`;

        reportHtml = `
          <div style="margin-top:24px">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;flex-wrap:wrap;gap:8px">
              <div>
                <h2 style="font-size:18px;font-weight:700;margin:0">${esc(biz.name)} - ${esc(periodLabel)}</h2>
                <p style="font-size:12px;color:var(--muted);margin:2px 0">Branch: ${esc(branchLabel)}</p>
              </div>
              <a href="/zq-admin/reports-hub/pdf?biz=${selBizId}&branch=${selBranch}&period=${selPeriod}&date=${selDate}"
                target="_blank"
                style="background:#1e40af;color:white;padding:8px 18px;border-radius:8px;text-decoration:none;font-size:13px;font-weight:700">
                📄 Download PDF
              </a>
            </div>

            <!-- Summary cards -->
            <div style="display:grid;grid-template-columns:repeat(5,1fr);gap:10px;margin-bottom:20px">
              ${stat(fmt(opening),       "Opening Balance", "")}
              ${stat(fmt(totalPayments), "Cash In",         "green")}
              ${stat(fmt(totalExpenses + totalPayouts), "Cash Out", "red" )}
              ${stat(fmt(cashAtHand),    "Cash at Hand",    cashAtHand >= 0 ? "green" : "red")}
              ${stat(fmt(totalInvoiced), "Invoiced",        "blue")}
            </div>

            <!-- Invoices table -->
            <div style="background:white;border-radius:10px;border:1px solid var(--border);margin-bottom:16px;overflow:hidden">
              <div style="background:#f8fafc;padding:12px 16px;border-bottom:1px solid var(--border);font-size:13px;font-weight:700">
                📄 Invoices / Receipts / Quotes (${invoices.length})
              </div>
              <div style="overflow-x:auto">
                <table style="width:100%;border-collapse:collapse;font-size:12px">
                  <thead><tr style="background:#f8fafc">
                    <th style="padding:8px 12px;text-align:left;color:var(--muted);border-bottom:1px solid var(--border)">Date</th>
                    <th style="padding:8px 12px;text-align:left;color:var(--muted);border-bottom:1px solid var(--border)">Ref</th>
                    <th style="padding:8px 12px;text-align:left;color:var(--muted);border-bottom:1px solid var(--border)">Type</th>
                    <th style="padding:8px 12px;text-align:left;color:var(--muted);border-bottom:1px solid var(--border)">Client</th>
                    <th style="padding:8px 12px;text-align:right;color:var(--muted);border-bottom:1px solid var(--border)">Amount</th>
                    <th style="padding:8px 12px;text-align:left;color:var(--muted);border-bottom:1px solid var(--border)">PDF</th>
                  </tr></thead>
                  <tbody>${invRows}</tbody>
                </table>
              </div>
            </div>

            <!-- Payments table -->
            <div style="background:white;border-radius:10px;border:1px solid var(--border);margin-bottom:16px;overflow:hidden">
              <div style="background:#f8fafc;padding:12px 16px;border-bottom:1px solid var(--border);font-size:13px;font-weight:700">
                💳 Payments Received (${payments.length})
              </div>
              <div style="overflow-x:auto">
                <table style="width:100%;border-collapse:collapse;font-size:12px">
                  <thead><tr style="background:#f8fafc">
                    <th style="padding:8px 12px;text-align:left;color:var(--muted);border-bottom:1px solid var(--border)">Date</th>
                    <th style="padding:8px 12px;text-align:left;color:var(--muted);border-bottom:1px solid var(--border)">Invoice</th>
                    <th style="padding:8px 12px;text-align:left;color:var(--muted);border-bottom:1px solid var(--border)">Method</th>
                    <th style="padding:8px 12px;text-align:right;color:var(--muted);border-bottom:1px solid var(--border)">Amount</th>
                  </tr></thead>
                  <tbody>${payRows}</tbody>
                </table>
              </div>
            </div>

            <!-- Expenses table -->
            <div style="background:white;border-radius:10px;border:1px solid var(--border);overflow:hidden">
              <div style="background:#f8fafc;padding:12px 16px;border-bottom:1px solid var(--border);font-size:13px;font-weight:700">
                💸 Expenses (${expenses.length}) &nbsp;&nbsp;
                ${(payouts||[]).length ? `+ Payouts (${payouts.length})` : ""}
              </div>
              <div style="overflow-x:auto">
                <table style="width:100%;border-collapse:collapse;font-size:12px">
                  <thead><tr style="background:#f8fafc">
                    <th style="padding:8px 12px;text-align:left;color:var(--muted);border-bottom:1px solid var(--border)">Date</th>
                    <th style="padding:8px 12px;text-align:left;color:var(--muted);border-bottom:1px solid var(--border)">Description</th>
                    <th style="padding:8px 12px;text-align:left;color:var(--muted);border-bottom:1px solid var(--border)">Category</th>
                    <th style="padding:8px 12px;text-align:left;color:var(--muted);border-bottom:1px solid var(--border)">Method</th>
                    <th style="padding:8px 12px;text-align:right;color:var(--muted);border-bottom:1px solid var(--border)">Amount</th>
                  </tr></thead>
                  <tbody>${expRows}</tbody>
                </table>
              </div>
            </div>
          </div>`;
      }
    }

    // Build business select
    const bizOptions = businesses.map(b =>
      `<option value="${b._id}" ${b._id.toString() === selBizId ? "selected" : ""}>${esc(b.name)}</option>`
    ).join("");

    const branchOptions = `<option value="">All Branches</option>` +
      branches.map(b =>
        `<option value="${b._id}" ${b._id.toString() === selBranch ? "selected" : ""}>${esc(b.name)}</option>`
      ).join("");

    res.send(layout("Reports Hub", `
      <form method="GET" action="/zq-admin/reports-hub" style="background:white;border-radius:12px;padding:20px;box-shadow:0 1px 3px rgba(0,0,0,.08);margin-bottom:24px">
        <h2 style="font-size:16px;font-weight:700;margin-bottom:16px">📊 Reports Hub - Browse Business Reports</h2>
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr auto;gap:12px;align-items:end">
          <div>
            <label style="font-size:11px;font-weight:700;color:var(--muted);display:block;margin-bottom:4px;text-transform:uppercase">Business</label>
            <select name="biz" onchange="this.form.submit()"
              style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;font-size:13px">
              <option value="">- Select business -</option>
              ${bizOptions}
            </select>
          </div>
          <div>
            <label style="font-size:11px;font-weight:700;color:var(--muted);display:block;margin-bottom:4px;text-transform:uppercase">Branch</label>
            <select name="branch" style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;font-size:13px">
              ${branchOptions}
            </select>
          </div>
          <div>
            <label style="font-size:11px;font-weight:700;color:var(--muted);display:block;margin-bottom:4px;text-transform:uppercase">Period</label>
            <select name="period" style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;font-size:13px">
              <option value="daily"   ${selPeriod==="daily"   ?"selected":""}>📅 Daily</option>
              <option value="weekly"  ${selPeriod==="weekly"  ?"selected":""}>📊 Weekly</option>
              <option value="monthly" ${selPeriod==="monthly" ?"selected":""}>📆 Monthly</option>
            </select>
          </div>
          <div>
            <label style="font-size:11px;font-weight:700;color:var(--muted);display:block;margin-bottom:4px;text-transform:uppercase">Date</label>
            <input type="date" name="date" value="${selDate}"
              style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;font-size:13px" />
          </div>
          <div>
            <button type="submit" class="btn btn-blue" style="white-space:nowrap">🔍 View Report</button>
          </div>
        </div>
      </form>

      ${reportHtml || (selBizId ? "<p style='color:var(--muted);text-align:center;padding:40px'>No data found for this selection.</p>" : "<p style='color:var(--muted);text-align:center;padding:40px'>Select a business above to view its report.</p>")}
    `));
  } catch (err) {
    res.send(layout("Reports Hub", `<div class="alert red">Error: ${esc(err.message)}</div>`));
  }
});

// GET /zq-admin/reports-hub/pdf  - PDF download of the same report
router.get("/reports-hub/pdf", requireSupplierAdmin, async (req, res) => {
  try {
    const { selBizId, selBranch, selPeriod, selDate } = {
      selBizId:   req.query.biz    || "",
      selBranch:  req.query.branch || "",
      selPeriod:  req.query.period || "daily",
      selDate:    req.query.date   || new Date().toISOString().split("T")[0]
    };
    if (!selBizId) return res.status(400).send("Business ID required.");

    const Business       = (await import("../models/business.js")).default;
    const Branch         = (await import("../models/branch.js")).default;
    const Invoice        = (await import("../models/invoice.js")).default;
    const Expense        = (await import("../models/expense.js")).default;
    const InvoicePayment = (await import("../models/invoicePayment.js")).default;
    const CashBalance    = (await import("../models/cashBalance.js")).default;

    const biz    = await Business.findById(selBizId).lean();
    if (!biz) return res.status(404).send("Business not found.");

    const anchor = new Date(selDate + "T00:00:00.000Z");
    let start = new Date(anchor), end = new Date(anchor);
    end.setHours(23, 59, 59, 999);
    if (selPeriod === "weekly")  start.setDate(start.getDate() - 6);
    if (selPeriod === "monthly") start.setDate(1);

    const baseQ  = { businessId: biz._id };
    if (selBranch) baseQ.branchId = selBranch;
    const rangeQ = { ...baseQ, createdAt: { $gte: start, $lte: end } };

    const [invoices, payments, expenses, balance] = await Promise.all([
      Invoice.find(rangeQ).sort({ createdAt: 1 }).lean(),
      InvoicePayment.find(rangeQ).sort({ createdAt: 1 }).lean(),
      Expense.find(rangeQ).sort({ createdAt: 1 }).lean(),
      CashBalance.findOne({ ...baseQ, date: { $gte: new Date(selDate + "T00:00:00.000Z"), $lte: new Date(selDate + "T23:59:59.999Z") } }).lean()
    ]);

    const branchDoc = selBranch ? await Branch.findById(selBranch).lean() : null;
    const branchName = branchDoc?.name || "All Branches";
    const totalPayments = payments.reduce((s,p) => s + (p.amount||0), 0);
    const totalExpenses = expenses.reduce((s,e) => s + (e.amount||0), 0);
    const opening       = balance?.openingBalance || 0;
    const cashAtHand    = opening + totalPayments - totalExpenses;

    const { generateReportPDF } = await import("../services/reportPDF.js");
    const periodLabel = selPeriod === "daily"   ? `Daily Report - ${selDate}`
                      : selPeriod === "weekly"  ? `Weekly Report - w/e ${end.toLocaleDateString("en-GB",{day:"numeric",month:"short",year:"numeric"})}`
                      : `Monthly Report - ${start.toLocaleDateString("en-GB",{month:"long",year:"numeric"})}`;

    const { filename } = await generateReportPDF({
      biz, reportType: periodLabel, periodLabel, branchName,
      data: { invoices, payments, expenses },
      totals: { moneyIn: totalPayments, moneyOut: totalExpenses, profit: totalPayments - totalExpenses, openingBalance: opening, cashAtHand },
      prevTotals: null, weeks: null
    });

    const site = (process.env.SITE_URL || "").replace(/\/$/, "");
    res.redirect(`${site}/docs/generated/reports/${filename}`);
  } catch (err) {
    res.status(500).send(`PDF generation error: ${err.message}`);
  }
});


// ════════════════════════════════════════════════════════════════════════════
// STAFF & BRANCHES MANAGEMENT
// Admin can directly assign phones to roles/branches - no invitation needed.
// ════════════════════════════════════════════════════════════════════════════

// ── GET /suppliers/:id/staff ─────────────────────────────────────────────────
router.get("/suppliers/:id/staff", requireSupplierAdmin, async (req, res) => {
  try {
    const supplier  = await SupplierProfile.findById(req.params.id).lean();
    if (!supplier) return res.redirect("/zq-admin/suppliers");

    const Business = (await import("../models/business.js")).default;
    const UserRole = (await import("../models/userRole.js")).default;
    const Branch   = (await import("../models/branch.js")).default;

    const biz = supplier.businessId
      ? await Business.findById(supplier.businessId).lean()
      : null;

    let branches = [], users = [];
    if (biz) {
      [branches, users] = await Promise.all([
        Branch.find({ businessId: biz._id }).sort({ isDefault: -1, name: 1 }).lean(),
        UserRole.find({ businessId: biz._id }).sort({ role: 1, phone: 1 }).lean()
      ]);
    }

    const errMsg     = req.query.error   ? `<div style="background:#fee2e2;color:#dc2626;padding:12px 16px;border-radius:8px;margin-bottom:16px">❌ ${esc(req.query.error)}</div>` : "";
    const successMsg = req.query.success ? `<div style="background:#dcfce7;color:#16a34a;padding:12px 16px;border-radius:8px;margin-bottom:16px">✅ ${esc(req.query.success)}</div>` : "";

    const roleColors = { owner: "#7c3aed", admin: "#1d4ed8", manager: "#0f766e", clerk: "#b45309" };
    const roleBadge  = (role) => `<span style="background:${roleColors[role]||"#374151"};color:white;padding:2px 9px;border-radius:12px;font-size:11px;font-weight:700">${role}</span>`;

    const branchMap  = Object.fromEntries(branches.map(b => [b._id.toString(), b.name]));

    const usersTable = users.length ? `
      <table style="width:100%;border-collapse:collapse;font-size:13px">
        <thead>
          <tr style="background:#f8fafc;border-bottom:2px solid var(--border)">
            <th style="padding:10px 12px;text-align:left">Name</th>
            <th style="padding:10px 12px;text-align:left">Phone</th>
            <th style="padding:10px 12px;text-align:left">Role</th>
            <th style="padding:10px 12px;text-align:left">Branch</th>
            <th style="padding:10px 12px;text-align:left">Status</th>
            <th style="padding:10px 12px;text-align:left">Actions</th>
          </tr>
        </thead>
        <tbody>
          ${users.map(u => `
          <tr style="border-bottom:1px solid var(--border)">
            <td style="padding:10px 12px"><strong>${esc(u.name || "-")}</strong></td>
            <td style="padding:10px 12px"><strong>${esc(u.phone)}</strong></td>
            <td style="padding:10px 12px">${roleBadge(u.role)}</td>
            <td style="padding:10px 12px">${esc(branchMap[u.branchId?.toString()] || (u.role === "owner" ? "All branches" : "-"))}</td>
            <td style="padding:10px 12px">${u.suspended ? badge("Suspended","red") : badge("Active","green")}</td>
            <td style="padding:10px 12px;display:flex;gap:6px;flex-wrap:wrap">
              <!-- Edit role/branch/name -->
              <button onclick="openEditUser('${u._id}','${esc(u.phone)}','${u.role}','${u.branchId?.toString()||""}','${esc(u.name||"")}')"
                style="background:#e0f2fe;color:#0369a1;border:none;padding:4px 10px;border-radius:6px;font-size:12px;cursor:pointer">✏️ Edit</button>
              <!-- Suspend/unsuspend -->
              <form method="POST" action="/zq-admin/suppliers/${supplier._id}/users/${u._id}/suspend" style="display:inline">
                <button style="background:${u.suspended?"#dcfce7":"#fef3c7"};color:${u.suspended?"#16a34a":"#92400e"};border:none;padding:4px 10px;border-radius:6px;font-size:12px;cursor:pointer">
                  ${u.suspended ? "▶ Unsuspend" : "⏸ Suspend"}
                </button>
              </form>
              <!-- Remove (only if not owner or multiple owners exist) -->
              <form method="POST" action="/zq-admin/suppliers/${supplier._id}/users/${u._id}/remove" style="display:inline"
                onsubmit="return confirm('Remove ${esc(u.phone)} (${u.role}) from this business?')">
                <button style="background:#fee2e2;color:#dc2626;border:none;padding:4px 10px;border-radius:6px;font-size:12px;cursor:pointer">🗑 Remove</button>
              </form>
            </td>
          </tr>`).join("")}
        </tbody>
      </table>` : `<p style="color:var(--muted);padding:12px">No users assigned yet.</p>`;

    const branchRows = branches.map(b => `
      <tr style="border-bottom:1px solid var(--border)">
        <td style="padding:10px 12px"><strong>${esc(b.name)}</strong>${b.isDefault ? ' <span style="font-size:10px;background:#dbeafe;color:#1d4ed8;padding:1px 6px;border-radius:4px">Default</span>' : ""}</td>
        <td style="padding:10px 12px">${esc(b.location || "-")}</td>
        <td style="padding:10px 12px">
          ${users.filter(u => u.branchId?.toString() === b._id.toString()).length} user(s)
        </td>
        <td style="padding:10px 12px;display:flex;gap:6px">
          <button onclick="openEditBranch('${b._id}','${esc(b.name)}','${esc(b.location||"")}')"
            style="background:#e0f2fe;color:#0369a1;border:none;padding:4px 10px;border-radius:6px;font-size:12px;cursor:pointer">✏️ Edit</button>
          ${!b.isDefault ? `
          <form method="POST" action="/zq-admin/suppliers/${supplier._id}/branches/${b._id}/delete" style="display:inline"
            onsubmit="return confirm('Delete branch ${esc(b.name)}? Users in this branch will lose their branch assignment.')">
            <button style="background:#fee2e2;color:#dc2626;border:none;padding:4px 10px;border-radius:6px;font-size:12px;cursor:pointer">🗑 Delete</button>
          </form>` : ""}
        </td>
      </tr>`).join("");

    const branchTable = branches.length ? `
      <table style="width:100%;border-collapse:collapse;font-size:13px">
        <thead>
          <tr style="background:#f8fafc;border-bottom:2px solid var(--border)">
            <th style="padding:10px 12px;text-align:left">Branch Name</th>
            <th style="padding:10px 12px;text-align:left">Location</th>
            <th style="padding:10px 12px;text-align:left">Users</th>
            <th style="padding:10px 12px;text-align:left">Actions</th>
          </tr>
        </thead>
        <tbody>${branchRows}</tbody>
      </table>` : `<p style="color:var(--muted);padding:12px">No branches yet.</p>`;

    const branchOptions = branches.map(b =>
      `<option value="${b._id}">${esc(b.name)}</option>`
    ).join("");

    if (!biz) {
      return res.send(layout(`Staff - ${esc(supplier.businessName)}`, `
        <a href="/zq-admin/suppliers/${supplier._id}" class="back-link">← Back to ${esc(supplier.businessName)}</a>
        <div class="panel"><p style="color:var(--muted)">⚠️ This supplier has no linked Business account yet. Staff management is available after activation.</p></div>
      `));
    }

    res.send(layout(`Staff - ${esc(supplier.businessName)}`, `
      <a href="/zq-admin/suppliers/${supplier._id}" class="back-link">← Back to ${esc(supplier.businessName)}</a>
      ${errMsg}${successMsg}

      <h2 style="font-size:18px;font-weight:700;margin-bottom:20px">👥 Staff &amp; Branches - ${esc(supplier.businessName)}</h2>

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-bottom:24px">

        <!-- Branches panel -->
        <div class="panel">
          <div class="panel-head">
            <h3>🏬 Branches (${branches.length})</h3>
            <button onclick="document.getElementById('addBranchForm').style.display='block';this.style.display='none'"
              style="background:#0f766e;color:white;border:none;padding:6px 14px;border-radius:8px;font-size:12px;cursor:pointer">+ Add Branch</button>
          </div>
          ${branchTable}

          <!-- Add branch form (hidden) -->
          <form id="addBranchForm" method="POST" action="/zq-admin/suppliers/${supplier._id}/branches/add"
            style="display:none;margin-top:16px;padding:16px;background:#f8fafc;border-radius:8px;border:1px solid var(--border)">
            <h4 style="margin:0 0 12px;font-size:13px;font-weight:700">Add New Branch</h4>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px">
              <div>
                <label style="font-size:11px;color:var(--muted);display:block;margin-bottom:3px;text-transform:uppercase;font-weight:700">Branch Name *</label>
                <input name="name" required placeholder="e.g. Harare South"
                  style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;font-size:13px">
              </div>
              <div>
                <label style="font-size:11px;color:var(--muted);display:block;margin-bottom:3px;text-transform:uppercase;font-weight:700">Location / Area</label>
                <input name="location" placeholder="e.g. Southerton, Harare"
                  style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;font-size:13px">
              </div>
            </div>
            <div style="display:flex;gap:8px">
              <button type="submit" style="background:#0f766e;color:white;border:none;padding:7px 18px;border-radius:8px;font-size:13px;font-weight:700;cursor:pointer">Save Branch</button>
              <button type="button" onclick="this.closest('form').style.display='none'"
                style="background:#f1f5f9;color:#374151;border:none;padding:7px 14px;border-radius:8px;font-size:13px;cursor:pointer">Cancel</button>
            </div>
          </form>
        </div>

        <!-- Assign user panel -->
        <div class="panel">
          <div class="panel-head"><h3>➕ Assign Staff Member</h3></div>
          <form method="POST" action="/zq-admin/suppliers/${supplier._id}/users/assign">
            <div style="display:flex;flex-direction:column;gap:12px">
              <div>
                <label style="font-size:11px;color:var(--muted);display:block;margin-bottom:4px;text-transform:uppercase;font-weight:700">Phone Number *</label>
                <input name="phone" required placeholder="e.g. 0771234567 or 263771234567"
                  style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;font-size:13px">
                <p style="font-size:11px;color:var(--muted);margin:3px 0 0">International or local format accepted.</p>
              </div>
              <div>
                <label style="font-size:11px;color:var(--muted);display:block;margin-bottom:4px;text-transform:uppercase;font-weight:700">Role *</label>
                <select name="role" id="roleSelect" onchange="updateBranchReq()"
                  style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;font-size:13px">
                  <option value="owner">👑 Owner - full access, all branches</option>
                  <option value="manager">🧑‍💼 Manager - sales, reports, settings</option>
                  <option value="clerk">🏷 Clerk - sales and payments only</option>
                </select>
              </div>
              <div id="branchField">
                <label style="font-size:11px;color:var(--muted);display:block;margin-bottom:4px;text-transform:uppercase;font-weight:700">Branch <span id="branchReqLabel">*</span></label>
                <select name="branchId"
                  style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;font-size:13px">
                  <option value="">- No specific branch (owner access) -</option>
                  ${branchOptions}
                </select>
                <p style="font-size:11px;color:var(--muted);margin:3px 0 0">Managers and clerks must be assigned to a branch.</p>
              </div>
              <button type="submit"
                style="background:#1d4ed8;color:white;border:none;padding:9px 20px;border-radius:8px;font-size:13px;font-weight:700;cursor:pointer;width:100%">
                ✅ Assign Staff Member
              </button>
            </div>
          </form>
        </div>
      </div>

      <!-- All staff table -->
      <div class="panel">
        <div class="panel-head"><h3>👤 All Staff (${users.length})</h3></div>
        ${usersTable}
      </div>

      <!-- Edit User Modal -->
      <div id="editUserModal" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:1000;align-items:center;justify-content:center">
        <div style="background:white;border-radius:12px;padding:24px;width:420px;max-width:90vw">
          <h3 style="margin:0 0 16px;font-size:15px;font-weight:700">✏️ Edit Staff Member</h3>
          <form method="POST" id="editUserForm">
            <p id="editUserPhone" style="font-size:13px;color:var(--muted);margin-bottom:14px"></p>
            <div style="margin-bottom:12px">
              <label style="font-size:11px;font-weight:700;color:var(--muted);display:block;margin-bottom:4px;text-transform:uppercase">Full Name</label>
              <input name="name" id="editUserName" maxlength="60"
                placeholder="e.g. Tendai Moyo"
                style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;font-size:13px" />
              <span style="font-size:11px;color:var(--muted)">Shown on reports, receipts, and handover logs</span>
            </div>
            <div style="margin-bottom:12px">
              <label style="font-size:11px;font-weight:700;color:var(--muted);display:block;margin-bottom:4px;text-transform:uppercase">Role</label>
              <select name="role" id="editUserRole"
                style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;font-size:13px">
                <option value="owner">👑 Owner</option>
                <option value="manager">🧑‍💼 Manager</option>
                <option value="clerk">🏷 Clerk</option>
              </select>
            </div>
            <div style="margin-bottom:16px">
              <label style="font-size:11px;font-weight:700;color:var(--muted);display:block;margin-bottom:4px;text-transform:uppercase">Branch</label>
              <select name="branchId"
                style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;font-size:13px">
                <option value="">- No specific branch -</option>
                ${branchOptions}
              </select>
            </div>
            <div style="display:flex;gap:8px">
              <button type="submit" style="background:#1d4ed8;color:white;border:none;padding:8px 20px;border-radius:8px;font-size:13px;font-weight:700;cursor:pointer">Save Changes</button>
              <button type="button" onclick="closeEditUser()"
                style="background:#f1f5f9;color:#374151;border:none;padding:8px 16px;border-radius:8px;font-size:13px;cursor:pointer">Cancel</button>
            </div>
          </form>
        </div>
      </div>

      <!-- Edit Branch Modal -->
      <div id="editBranchModal" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:1000;align-items:center;justify-content:center">
        <div style="background:white;border-radius:12px;padding:24px;width:380px;max-width:90vw">
          <h3 style="margin:0 0 16px;font-size:15px;font-weight:700">✏️ Edit Branch</h3>
          <form method="POST" id="editBranchForm">
            <div style="margin-bottom:12px">
              <label style="font-size:11px;font-weight:700;color:var(--muted);display:block;margin-bottom:4px;text-transform:uppercase">Branch Name *</label>
              <input name="name" id="editBranchName" required
                style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;font-size:13px">
            </div>
            <div style="margin-bottom:16px">
              <label style="font-size:11px;font-weight:700;color:var(--muted);display:block;margin-bottom:4px;text-transform:uppercase">Location / Area</label>
              <input name="location" id="editBranchLocation"
                style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;font-size:13px">
            </div>
            <div style="display:flex;gap:8px">
              <button type="submit" style="background:#0f766e;color:white;border:none;padding:8px 20px;border-radius:8px;font-size:13px;font-weight:700;cursor:pointer">Save Branch</button>
              <button type="button" onclick="closeEditBranch()"
                style="background:#f1f5f9;color:#374151;border:none;padding:8px 16px;border-radius:8px;font-size:13px;cursor:pointer">Cancel</button>
            </div>
          </form>
        </div>
      </div>

      <script>
        function openEditUser(id, phone, role, branchId, name) {
          document.getElementById("editUserPhone").textContent = "Editing: " + phone;
          document.getElementById("editUserForm").action = "/zq-admin/suppliers/${supplier._id}/users/" + id + "/edit-role";
          document.getElementById("editUserRole").value = role;
          const nameFld = document.getElementById("editUserName");
          if (nameFld) nameFld.value = name || "";
          const bSel = document.getElementById("editUserForm").querySelector("select[name=branchId]");
          if (bSel) bSel.value = branchId || "";
          const modal = document.getElementById("editUserModal");
          modal.style.display = "flex";
        }
        function closeEditUser() { document.getElementById("editUserModal").style.display = "none"; }

        function openEditBranch(id, name, location) {
          document.getElementById("editBranchForm").action = "/zq-admin/suppliers/${supplier._id}/branches/" + id + "/edit";
          document.getElementById("editBranchName").value = name;
          document.getElementById("editBranchLocation").value = location;
          const modal = document.getElementById("editBranchModal");
          modal.style.display = "flex";
        }
        function closeEditBranch() { document.getElementById("editBranchModal").style.display = "none"; }

        function updateBranchReq() {
          const role = document.getElementById("roleSelect").value;
          document.getElementById("branchReqLabel").textContent = (role === "owner") ? "(optional)" : "*";
        }
        updateBranchReq();
      </script>
    `));
  } catch (err) {
    res.send(layout("Error", `<div class="alert red">${err.message}</div>`));
  }
});

// ── POST /suppliers/:id/branches/add ─────────────────────────────────────────
router.post("/suppliers/:id/branches/add", requireSupplierAdmin, async (req, res) => {
  try {
    const supplier  = await SupplierProfile.findById(req.params.id).lean();
    if (!supplier?.businessId) return res.redirect(`/zq-admin/suppliers/${req.params.id}/staff?error=No linked business`);

    const Branch   = (await import("../models/branch.js")).default;
    const { name, location } = req.body;
    if (!name?.trim()) return res.redirect(`/zq-admin/suppliers/${req.params.id}/staff?error=Branch name required`);

    await Branch.create({ businessId: supplier.businessId, name: name.trim(), location: location?.trim() || "", isDefault: false });
    res.redirect(`/zq-admin/suppliers/${req.params.id}/staff?success=${encodeURIComponent("Branch added: " + name.trim())}`);
  } catch (err) {
    res.redirect(`/zq-admin/suppliers/${req.params.id}/staff?error=${encodeURIComponent(err.message)}`);
  }
});

// ── POST /suppliers/:id/branches/:bid/edit ────────────────────────────────────
router.post("/suppliers/:id/branches/:bid/edit", requireSupplierAdmin, async (req, res) => {
  try {
    const supplier = await SupplierProfile.findById(req.params.id).lean();
    if (!supplier?.businessId) return res.redirect(`/zq-admin/suppliers/${req.params.id}/staff?error=No linked business`);

    const Branch = (await import("../models/branch.js")).default;
    const { name, location } = req.body;
    if (!name?.trim()) return res.redirect(`/zq-admin/suppliers/${req.params.id}/staff?error=Branch name required`);

    await Branch.findByIdAndUpdate(req.params.bid, { name: name.trim(), location: location?.trim() || "" });
    res.redirect(`/zq-admin/suppliers/${req.params.id}/staff?success=${encodeURIComponent("Branch updated")}`);
  } catch (err) {
    res.redirect(`/zq-admin/suppliers/${req.params.id}/staff?error=${encodeURIComponent(err.message)}`);
  }
});

// ── POST /suppliers/:id/branches/:bid/delete ──────────────────────────────────
router.post("/suppliers/:id/branches/:bid/delete", requireSupplierAdmin, async (req, res) => {
  try {
    const supplier = await SupplierProfile.findById(req.params.id).lean();
    if (!supplier?.businessId) return res.redirect(`/zq-admin/suppliers/${req.params.id}/staff?error=No linked business`);

    const Branch   = (await import("../models/branch.js")).default;
    const UserRole = (await import("../models/userRole.js")).default;

    const branch = await Branch.findById(req.params.bid).lean();
    if (!branch) return res.redirect(`/zq-admin/suppliers/${req.params.id}/staff?error=Branch not found`);
    if (branch.isDefault) return res.redirect(`/zq-admin/suppliers/${req.params.id}/staff?error=Cannot delete the default branch`);

    // Unassign users from this branch (null out their branchId)
    await UserRole.updateMany({ businessId: supplier.businessId, branchId: branch._id }, { $set: { branchId: null } });
    await Branch.findByIdAndDelete(req.params.bid);
    res.redirect(`/zq-admin/suppliers/${req.params.id}/staff?success=${encodeURIComponent("Branch deleted. Affected users have been unassigned from it.")}`);
  } catch (err) {
    res.redirect(`/zq-admin/suppliers/${req.params.id}/staff?error=${encodeURIComponent(err.message)}`);
  }
});

// ── POST /suppliers/:id/users/assign ─────────────────────────────────────────
// Directly assign a phone number to a role+branch - no invitation flow.
router.post("/suppliers/:id/users/assign", requireSupplierAdmin, async (req, res) => {
  try {
    const supplier = await SupplierProfile.findById(req.params.id).lean();
    if (!supplier?.businessId) return res.redirect(`/zq-admin/suppliers/${req.params.id}/staff?error=No linked business`);

    const UserRole = (await import("../models/userRole.js")).default;
    const Branch   = (await import("../models/branch.js")).default;
    const Business = (await import("../models/business.js")).default;
    const UserSession = (await import("../models/userSession.js")).default;

    const rawPhone = String(req.body.phone || "").trim();
    let phone = rawPhone.replace(/\D+/g, "");
    if (phone.startsWith("0") && phone.length === 10) phone = "263" + phone.slice(1);
    if (!phone || phone.length < 9) return res.redirect(`/zq-admin/suppliers/${req.params.id}/staff?error=Invalid phone number`);

    const role     = req.body.role     || "clerk";
    const branchId = req.body.branchId || null;

    const validRoles = ["owner", "manager", "clerk"];
    if (!validRoles.includes(role)) return res.redirect(`/zq-admin/suppliers/${req.params.id}/staff?error=Invalid role`);

    // Non-owners MUST have a branch
    if (role !== "owner" && !branchId) {
      return res.redirect(`/zq-admin/suppliers/${req.params.id}/staff?error=Managers and clerks must be assigned to a branch`);
    }
    if (branchId) {
      const branch = await Branch.findById(branchId).lean();
      if (!branch || branch.businessId.toString() !== supplier.businessId.toString()) {
        return res.redirect(`/zq-admin/suppliers/${req.params.id}/staff?error=Branch not found or belongs to another business`);
      }
    }

    // Check if this phone is already assigned to this business
    const existing = await UserRole.findOne({ businessId: supplier.businessId, phone });
    if (existing) {
      return res.redirect(`/zq-admin/suppliers/${req.params.id}/staff?error=${encodeURIComponent(phone + " is already assigned to this business as " + existing.role + ". Remove first to reassign.")}`);
    }

    // Create UserRole directly (no pending=true, no invite needed)
    await UserRole.create({
      businessId: supplier.businessId,
      branchId:   branchId || null,
      phone,
      role,
      pending:    false
    });

    // Ensure the assigned phone has a UserSession pointing to this business
    await UserSession.findOneAndUpdate(
      { phone },
      { $setOnInsert: { phone, activeBusinessId: supplier.businessId } },
      { upsert: true }
    );

    res.redirect(`/zq-admin/suppliers/${req.params.id}/staff?success=${encodeURIComponent(phone + " assigned as " + role)}`);
  } catch (err) {
    res.redirect(`/zq-admin/suppliers/${req.params.id}/staff?error=${encodeURIComponent(err.message)}`);
  }
});

// ── POST /suppliers/:id/users/:uid/edit-role ──────────────────────────────────
router.post("/suppliers/:id/users/:uid/edit-role", requireSupplierAdmin, async (req, res) => {
  try {
    const supplier = await SupplierProfile.findById(req.params.id).lean();
    if (!supplier?.businessId) return res.redirect(`/zq-admin/suppliers/${req.params.id}/staff?error=No linked business`);

    const UserRole = (await import("../models/userRole.js")).default;
    const Branch   = (await import("../models/branch.js")).default;

    const role     = req.body.role     || "clerk";
    const branchId = req.body.branchId || null;

    if (role !== "owner" && !branchId) {
      return res.redirect(`/zq-admin/suppliers/${req.params.id}/staff?error=Managers and clerks must have a branch`);
    }
    if (branchId) {
      const branch = await Branch.findById(branchId).lean();
      if (!branch || branch.businessId.toString() !== supplier.businessId.toString()) {
        return res.redirect(`/zq-admin/suppliers/${req.params.id}/staff?error=Branch not found`);
      }
    }

    const staffName = (req.body.name || "").trim().slice(0, 60);
    await UserRole.findByIdAndUpdate(req.params.uid, {
      $set: { role, branchId: branchId || null, ...(staffName ? { name: staffName } : {}) }
    });
    res.redirect(`/zq-admin/suppliers/${req.params.id}/staff?success=${encodeURIComponent("User updated" + (staffName ? " - " + staffName : ""))}`);
  } catch (err) {
    res.redirect(`/zq-admin/suppliers/${req.params.id}/staff?error=${encodeURIComponent(err.message)}`);
  }
});

// ── POST /suppliers/:id/users/:uid/suspend ────────────────────────────────────
router.post("/suppliers/:id/users/:uid/suspend", requireSupplierAdmin, async (req, res) => {
  try {
    const UserRole = (await import("../models/userRole.js")).default;
    const user = await UserRole.findById(req.params.uid).lean();
    if (!user) return res.redirect(`/zq-admin/suppliers/${req.params.id}/staff?error=User not found`);

    await UserRole.findByIdAndUpdate(req.params.uid, { $set: { suspended: !user.suspended } });
    const msg = user.suspended ? "User unsuspended" : "User suspended";
    res.redirect(`/zq-admin/suppliers/${req.params.id}/staff?success=${encodeURIComponent(msg)}`);
  } catch (err) {
    res.redirect(`/zq-admin/suppliers/${req.params.id}/staff?error=${encodeURIComponent(err.message)}`);
  }
});

// ── POST /suppliers/:id/users/:uid/remove ─────────────────────────────────────
router.post("/suppliers/:id/users/:uid/remove", requireSupplierAdmin, async (req, res) => {
  try {
    const supplier = await SupplierProfile.findById(req.params.id).lean();
    if (!supplier?.businessId) return res.redirect(`/zq-admin/suppliers/${req.params.id}/staff?error=No linked business`);

    const UserRole = (await import("../models/userRole.js")).default;
    const user = await UserRole.findById(req.params.uid).lean();
    if (!user) return res.redirect(`/zq-admin/suppliers/${req.params.id}/staff?error=User not found`);

    // Safety: block removing the last owner
    if (user.role === "owner") {
      const ownerCount = await UserRole.countDocuments({ businessId: supplier.businessId, role: "owner", pending: false });
      if (ownerCount <= 1) {
        return res.redirect(`/zq-admin/suppliers/${req.params.id}/staff?error=Cannot remove the only owner. Assign another owner first.`);
      }
    }

    await UserRole.findByIdAndDelete(req.params.uid);
    res.redirect(`/zq-admin/suppliers/${req.params.id}/staff?success=${encodeURIComponent(user.phone + " removed from business")}`);
  } catch (err) {
    res.redirect(`/zq-admin/suppliers/${req.params.id}/staff?error=${encodeURIComponent(err.message)}`);
  }
});



// ══════════════════════════════════════════════════════════════════════════════
// STAFF E-BUSINESS CARDS
// Routes: /zq-admin/suppliers/:id/staff-cards/...
// All routes lazy-load staffCard + staffSmartLink so the server starts even
// when those files are not yet on disk. Once deployed, replace the lazy-load
// block above with the static imports and restart.
// ══════════════════════════════════════════════════════════════════════════════

const _NOT_DEPLOYED_HTML = (supplierId) => `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Staff Cards – Setup Required</title>
<style>body{font-family:system-ui,sans-serif;background:#f8f9fa;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
.box{background:#fff;border-radius:12px;padding:40px;max-width:500px;text-align:center;box-shadow:0 2px 8px rgba(0,0,0,.1)}
h2{color:#dc2626;margin:0 0 12px}p{color:#555;font-size:14px;line-height:1.6}
pre{background:#f5f5f5;padding:12px;border-radius:6px;font-size:12px;text-align:left;white-space:pre-wrap}
a{color:#3b82f6;font-size:13px}</style></head>
<body><div class="box">
<h2>⚙️ Staff Cards Not Yet Active</h2>
<p>The staff e-business card feature requires two files to be deployed to the server:</p>
<pre>models/staffCard.js\nservices/staffSmartLink.js</pre>
<p>Download them from the ZimQuote outputs, upload via SCP/SFTP, then restart PM2:</p>
<pre>pm2 restart cripfcnt</pre>
<a href="/zq-admin/suppliers/${supplierId}">← Back to Supplier</a>
</div></body></html>`;

router.get("/suppliers/:id/staff-cards", requireSupplierAdmin, async (req, res) => {
  const m = await _loadStaffModules();
  if (!m) return res.send(_NOT_DEPLOYED_HTML(req.params.id));
  const { StaffCard, buildStaffQrImageUrl, buildStaffAnalyticsSummary, STAFF_LINK_SOURCES: SRC } = m;
  try {
    const supplier = await SupplierProfile.findById(req.params.id).lean();
    if (!supplier) return res.redirect("/zq-admin/suppliers");
    const cards = await StaffCard.find({ supplierId: req.params.id }).sort({ createdAt: -1 }).lean();
    const successMsg = req.query.success ? `<div style="background:#dcfce7;color:#16a34a;padding:12px 16px;border-radius:8px;margin-bottom:16px;font-size:13px">✅ ${esc(req.query.success)}</div>` : "";
    const errorMsg   = req.query.error   ? `<div style="background:#fee2e2;color:#dc2626;padding:12px 16px;border-radius:8px;margin-bottom:16px;font-size:13px">❌ ${esc(req.query.error)}</div>` : "";
    const totalViews = cards.reduce((s,c) => s+(c.zqLinkViews||0), 0);
    const totalConvs = cards.reduce((s,c) => s+(c.zqLinkConversions||0), 0);
    const sortedByViews = [...cards].sort((a,b) => (b.zqLinkViews||0)-(a.zqLinkViews||0)).slice(0,3);
    const sortedByConvs = [...cards].sort((a,b) => (b.zqLinkConversions||0)-(a.zqLinkConversions||0)).slice(0,3);
    const leaderboardHtml = cards.length >= 2 ? `
      <div style="background:linear-gradient(135deg,#1e3a5f 0%,#2563eb 100%);color:#fff;border-radius:8px;padding:20px;margin-bottom:20px;box-shadow:0 1px 4px rgba(0,0,0,.12)">
        <h2 style="color:#fff;margin:0 0 16px;font-size:14px;letter-spacing:.05em;text-transform:uppercase">🏆 Staff Leaderboard</h2>
        <div style="display:flex;gap:16px;flex-wrap:wrap;margin-bottom:14px">
          <div style="flex:1;min-width:160px">
            <div style="font-size:11px;opacity:.7;text-transform:uppercase;letter-spacing:.08em;margin-bottom:8px">👁 Most Views</div>
            ${sortedByViews.map((c,i) => `<div style="display:flex;justify-content:space-between;margin-bottom:5px;font-size:13px"><span>${["🥇","🥈","🥉"][i]} ${esc(c.name)}</span><span style="font-weight:700">${c.zqLinkViews||0}</span></div>`).join("")}
          </div>
          <div style="flex:1;min-width:160px">
            <div style="font-size:11px;opacity:.7;text-transform:uppercase;letter-spacing:.08em;margin-bottom:8px">✅ Most Enquiries</div>
            ${sortedByConvs.map((c,i) => `<div style="display:flex;justify-content:space-between;margin-bottom:5px;font-size:13px"><span>${["🥇","🥈","🥉"][i]} ${esc(c.name)}</span><span style="font-weight:700">${c.zqLinkConversions||0}</span></div>`).join("")}
          </div>
        </div>
        <div style="display:flex;gap:16px;border-top:1px solid rgba(255,255,255,.2);padding-top:12px;font-size:12px;opacity:.9;flex-wrap:wrap">
          <span>📊 Team views: <strong>${totalViews}</strong></span>
          <span>💬 Team enquiries: <strong>${totalConvs}</strong></span>
          <span>👥 Active: <strong>${cards.filter(c=>c.active).length}/${cards.length}</strong></span>
        </div>
      </div>` : "";
    // ── Inline QR builder - matches buildStaffQrImageUrl() exactly ───────────────
    // Payload: ZQ:STAFF:<id>:SRC:qr  (NOT ZQ:S: - that routes to supplier resolver)
    // Service: chart.googleapis.com  (same as buildStaffQrImageUrl in staffSmartLink.js)
    const _STAFF_BOT = (process.env.WHATSAPP_BOT_NUMBER || "263771143904").replace(/\D/g, "");
    function _staffQrUrl(cardId, size) {
      const rawPayload = "ZQ:STAFF:" + cardId + ":SRC:qr";
      const rawWaLink  = "https://wa.me/" + _STAFF_BOT + "?text=" + rawPayload;
      return "https://chart.googleapis.com/chart?cht=qr&chs=" + size + "x" + size
        + "&chl=" + encodeURIComponent(rawWaLink) + "&choe=UTF-8";
    }
    const cardRows = cards.map(card => {
      const stats  = buildStaffAnalyticsSummary(card);
      const cardId = String(card._id);
      const qrUrl  = _staffQrUrl(cardId, 80);
      return `<tr style="border-bottom:1px solid #f0f0f0">
        <td style="padding:12px 8px;vertical-align:middle">
          <span style="display:inline-block;width:32px;height:32px;border-radius:50%;background:#e0e7ff;color:#4f46e5;text-align:center;line-height:32px;font-size:13px;font-weight:700;margin-right:8px;vertical-align:middle">${esc(card.name.charAt(0).toUpperCase())}</span>
          <strong style="font-size:14px">${esc(card.name)}</strong><br>
          <span style="font-size:11px;color:#888;margin-left:40px">${esc(card.title||"-")}</span>
          ${card.locationLabel?`<br><span style="font-size:11px;color:#aaa;margin-left:40px">📍 ${esc(card.locationLabel)}</span>`:""}
        </td>
        <td style="padding:12px 8px;vertical-align:middle;font-size:13px">${esc(card.phone)}${card.email?`<br><span style="color:#888;font-size:11px">${esc(card.email)}</span>`:""}</td>
        <td style="padding:12px 8px;vertical-align:middle;text-align:center"><img src="${esc(qrUrl)}" width="56" height="56" style="border:1px solid #eee;border-radius:4px" loading="lazy"></td>
        <td style="padding:12px 8px;vertical-align:middle;font-size:12px"><strong>${stats.views}</strong> views<br><strong>${stats.converts}</strong> enquiries<br><span style="color:#888;font-size:11px">${esc(stats.topSource)}</span></td>
        <td style="padding:12px 8px;vertical-align:middle"><span style="display:inline-block;padding:2px 8px;border-radius:12px;font-size:11px;background:${card.active?"#dcfce7":"#fee2e2"};color:${card.active?"#16a34a":"#dc2626"}">${card.active?"Active":"Inactive"}</span></td>
        <td style="padding:12px 8px;vertical-align:middle;text-align:right;white-space:nowrap">
          <a href="/zq-admin/suppliers/${esc(req.params.id)}/staff-cards/${esc(String(card._id))}/smart-link" style="display:inline-block;margin:2px;padding:5px 10px;background:#3b82f6;color:#fff;border-radius:5px;font-size:12px;text-decoration:none">🔗 Smart Link</a>
          <a href="/zq-admin/suppliers/${esc(req.params.id)}/staff-cards/${esc(String(card._id))}/business-card" target="_blank" style="display:inline-block;margin:2px;padding:5px 10px;background:#8b5cf6;color:#fff;border-radius:5px;font-size:12px;text-decoration:none">🖨 Print</a>
          <a href="/zq-admin/suppliers/${esc(req.params.id)}/staff-cards/${esc(String(card._id))}/edit" style="display:inline-block;margin:2px;padding:5px 10px;background:#f59e0b;color:#fff;border-radius:5px;font-size:12px;text-decoration:none">✏️ Edit</a>
          <form method="POST" action="/zq-admin/suppliers/${esc(req.params.id)}/staff-cards/${esc(String(card._id))}/toggle-active" style="display:inline">
            <button type="submit" style="margin:2px;padding:5px 10px;background:${card.active?"#6b7280":"#10b981"};color:#fff;border:none;border-radius:5px;font-size:12px;cursor:pointer">${card.active?"Deactivate":"Activate"}</button>
          </form>
          <form method="POST" action="/zq-admin/suppliers/${esc(req.params.id)}/staff-cards/${esc(String(card._id))}/delete" style="display:inline" onsubmit="return confirm('Delete card for ${esc(card.name).replace(/'/g,"\\'")}?')">
            <button type="submit" style="margin:2px;padding:5px 10px;background:#ef4444;color:#fff;border:none;border-radius:5px;font-size:12px;cursor:pointer">🗑</button>
          </form>
        </td>
      </tr>`;
    }).join("");
    res.send(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Staff E-Business Cards – ${esc(supplier.businessName)}</title>
<style>body{font-family:system-ui,sans-serif;margin:0;background:#f8f9fa;color:#222}.wrap{max-width:1150px;margin:0 auto;padding:24px 16px}h1{font-size:20px;margin:0 0 4px}.sub{font-size:13px;color:#888;margin-bottom:20px}.back{font-size:13px;color:#3b82f6;text-decoration:none;margin-bottom:16px;display:inline-block}table{width:100%;border-collapse:collapse;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.08)}th{background:#f5f5f5;font-size:11px;text-transform:uppercase;padding:10px 8px;text-align:left;color:#888}.card{background:#fff;border-radius:8px;padding:20px;margin-bottom:20px;box-shadow:0 1px 4px rgba(0,0,0,.08)}.form-row{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:12px}.form-row label{display:flex;flex-direction:column;gap:4px;font-size:13px;font-weight:600;flex:1;min-width:160px}.form-row input,.form-row textarea{padding:8px 10px;border:1px solid #d1d5db;border-radius:6px;font-size:13px;font-family:inherit}.btn-primary{padding:10px 20px;background:#3b82f6;color:#fff;border:none;border-radius:6px;font-size:14px;cursor:pointer;font-weight:600}.empty{text-align:center;padding:40px;color:#aaa;font-size:14px}</style></head>
<body><div class="wrap">
  <a class="back" href="/zq-admin/suppliers/${esc(req.params.id)}">← Back to Supplier</a>
  <h1>👥 Staff E-Business Cards</h1>
  <p class="sub">${esc(supplier.businessName)} · ${cards.length} card${cards.length!==1?"s":""} issued</p>
  ${successMsg}${errorMsg}${leaderboardHtml}
  <div class="card">
    <h2 style="font-size:16px;margin:0 0 16px">➕ Issue New E-Business Card</h2>
    <form method="POST" action="/zq-admin/suppliers/${esc(req.params.id)}/staff-cards/add">
      <div class="form-row">
        <label>Full Name *<input name="name" required placeholder="e.g. Muchaneta Horinda" maxlength="60"></label>
        <label>Job Title<input name="title" placeholder="e.g. Sales &amp; Marketing Consultant" maxlength="80"></label>
      </div>
      <div class="form-row">
        <label>Phone * <span style="font-weight:400;color:#888">(07xxxxxxxx or 263xxxxxxxxx)</span><input name="phone" required placeholder="0772570345" maxlength="20"></label>
        <label>Email (optional)<input name="email" type="email" placeholder="name@company.co.zw" maxlength="80"></label>
      </div>
      <div class="form-row">
        <label>Location Label<input name="locationLabel" placeholder="e.g. Mutare Branch" maxlength="60"></label>
        <label>Personal Tagline<input name="tagline" placeholder="e.g. For the golden finish you deserve" maxlength="100"></label>
      </div>
      <div class="form-row"><label>Admin Notes <span style="font-weight:400;color:#888">(never shown to buyers)</span><textarea name="adminNotes" rows="2" maxlength="300"></textarea></label></div>
      <button type="submit" class="btn-primary">Issue Card &amp; Generate Smart Link →</button>
    </form>
  </div>
  ${cards.length===0 ? `<div class="empty">No staff cards yet. Use the form above to issue the first one.</div>`
    : `<table><thead><tr><th>Staff Member</th><th>Phone / Email</th><th>QR</th><th>Analytics</th><th>Status</th><th style="text-align:right">Actions</th></tr></thead><tbody>${cardRows}</tbody></table>`}
</div></body></html>`);
  } catch (err) {
    res.redirect(`/zq-admin/suppliers/${req.params.id}?error=${encodeURIComponent(err.message)}`);
  }
});

router.post("/suppliers/:id/staff-cards/add", requireSupplierAdmin, async (req, res) => {
  const m = await _loadStaffModules();
  if (!m) return res.send(_NOT_DEPLOYED_HTML(req.params.id));
  const { StaffCard, assignSlugToStaffCard } = m;
  try {
    const supplier = await SupplierProfile.findById(req.params.id).lean();
    if (!supplier) return res.redirect("/zq-admin/suppliers");
    const { name, title, phone: rawPhone, email, locationLabel, tagline, adminNotes } = req.body;
    if (!name?.trim()) return res.redirect(`/zq-admin/suppliers/${req.params.id}/staff-cards?error=Name+is+required`);
    let phone = String(rawPhone||"").replace(/\D+/g,"");
    if (phone.startsWith("0")&&phone.length===10) phone="263"+phone.slice(1);
    if (!phone||phone.length<9) return res.redirect(`/zq-admin/suppliers/${req.params.id}/staff-cards?error=${encodeURIComponent("Invalid phone - use 07xxxxxxxx or 263xxxxxxxxx")}`);
    const card = await StaffCard.create({
      supplierId: req.params.id, name: name.trim(), title: (title||"").trim(), phone,
      email: (email||"").trim(), locationLabel: (locationLabel||"").trim(),
      tagline: (tagline||"").trim().slice(0,100), adminNotes: (adminNotes||"").trim().slice(0,300), active: true,
    });
    try { await assignSlugToStaffCard(String(card._id)); } catch(_){}
    res.redirect(`/zq-admin/suppliers/${req.params.id}/staff-cards/${String(card._id)}/smart-link?success=${encodeURIComponent("Card issued! Share the smart link with "+card.name+".")}`);
  } catch (err) {
    res.redirect(`/zq-admin/suppliers/${req.params.id}/staff-cards?error=${encodeURIComponent(err.message)}`);
  }
});

router.get("/suppliers/:id/staff-cards/:cid/edit", requireSupplierAdmin, async (req, res) => {
  const m = await _loadStaffModules();
  if (!m) return res.send(_NOT_DEPLOYED_HTML(req.params.id));
  const { StaffCard } = m;
  try {
    const supplier = await SupplierProfile.findById(req.params.id).lean();
    const card     = await StaffCard.findById(req.params.cid).lean();
    if (!supplier||!card) return res.redirect(`/zq-admin/suppliers/${req.params.id}/staff-cards`);
    const msg = req.query.success ? `<div style="background:#dcfce7;color:#16a34a;padding:12px 16px;border-radius:8px;margin-bottom:16px;font-size:13px">✅ ${esc(req.query.success)}</div>` : "";
    res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Edit Card – ${esc(card.name)}</title>
<style>body{font-family:system-ui,sans-serif;margin:0;background:#f8f9fa}.wrap{max-width:700px;margin:0 auto;padding:24px 16px}.back{font-size:13px;color:#3b82f6;text-decoration:none;margin-bottom:16px;display:inline-block}.card{background:#fff;border-radius:8px;padding:24px;box-shadow:0 1px 4px rgba(0,0,0,.08)}h1{font-size:18px;margin:0 0 20px}.form-row{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:14px}.form-row label{display:flex;flex-direction:column;gap:4px;font-size:13px;font-weight:600;flex:1;min-width:180px}.form-row input,.form-row textarea{padding:8px 10px;border:1px solid #d1d5db;border-radius:6px;font-size:13px;font-family:inherit}.btn-primary{padding:10px 20px;background:#3b82f6;color:#fff;border:none;border-radius:6px;font-size:14px;cursor:pointer;font-weight:600}</style></head>
<body><div class="wrap"><a class="back" href="/zq-admin/suppliers/${esc(req.params.id)}/staff-cards">← Staff Cards</a>${msg}
<div class="card"><h1>✏️ Edit – ${esc(card.name)}</h1>
<form method="POST" action="/zq-admin/suppliers/${esc(req.params.id)}/staff-cards/${esc(req.params.cid)}/edit">
<div class="form-row"><label>Full Name *<input name="name" required value="${esc(card.name)}" maxlength="60"></label><label>Job Title<input name="title" value="${esc(card.title||"")}" maxlength="80"></label></div>
<div class="form-row"><label>Phone *<input name="phone" required value="${esc(card.phone)}" maxlength="20"></label><label>Email<input name="email" type="email" value="${esc(card.email||"")}" maxlength="80"></label></div>
<div class="form-row"><label>Location Label<input name="locationLabel" value="${esc(card.locationLabel||"")}" maxlength="60"></label><label>Tagline<input name="tagline" value="${esc(card.tagline||"")}" maxlength="100"></label></div>
<div class="form-row"><label>Admin Notes<textarea name="adminNotes" rows="2" maxlength="300">${esc(card.adminNotes||"")}</textarea></label></div>
<div style="display:flex;gap:12px;align-items:center;margin-top:8px">
  <button type="submit" class="btn-primary">Save Changes</button>
  <a href="/zq-admin/suppliers/${esc(req.params.id)}/staff-cards/${esc(req.params.cid)}/smart-link" style="color:#3b82f6;font-size:13px;text-decoration:none">🔗 Smart Link →</a>
</div></form></div></div></body></html>`);
  } catch (err) {
    res.redirect(`/zq-admin/suppliers/${req.params.id}/staff-cards?error=${encodeURIComponent(err.message)}`);
  }
});

router.post("/suppliers/:id/staff-cards/:cid/edit", requireSupplierAdmin, async (req, res) => {
  const m = await _loadStaffModules();
  if (!m) return res.send(_NOT_DEPLOYED_HTML(req.params.id));
  const { StaffCard, assignSlugToStaffCard } = m;
  try {
    const card = await StaffCard.findById(req.params.cid).lean();
    if (!card) return res.redirect(`/zq-admin/suppliers/${req.params.id}/staff-cards?error=Card+not+found`);
    const { name, title, phone: rawPhone, email, locationLabel, tagline, adminNotes } = req.body;
    if (!name?.trim()) return res.redirect(`/zq-admin/suppliers/${req.params.id}/staff-cards/${req.params.cid}/edit?error=Name+required`);
    let phone = String(rawPhone||"").replace(/\D+/g,"");
    if (phone.startsWith("0")&&phone.length===10) phone="263"+phone.slice(1);
    if (!phone||phone.length<9) return res.redirect(`/zq-admin/suppliers/${req.params.id}/staff-cards/${req.params.cid}/edit?error=${encodeURIComponent("Invalid phone number")}`);
    const nameChanged = card.name.trim().toLowerCase()!==name.trim().toLowerCase();
    await StaffCard.findByIdAndUpdate(req.params.cid,{$set:{name:name.trim(),title:(title||"").trim(),phone,email:(email||"").trim(),locationLabel:(locationLabel||"").trim(),tagline:(tagline||"").trim().slice(0,100),adminNotes:(adminNotes||"").trim().slice(0,300)}});
    if (nameChanged){try{await assignSlugToStaffCard(req.params.cid,{force:true});}catch(_){}}
    res.redirect(`/zq-admin/suppliers/${req.params.id}/staff-cards/${req.params.cid}/edit?success=${encodeURIComponent("Card updated")}`);
  } catch (err) {
    res.redirect(`/zq-admin/suppliers/${req.params.id}/staff-cards?error=${encodeURIComponent(err.message)}`);
  }
});

router.post("/suppliers/:id/staff-cards/:cid/toggle-active", requireSupplierAdmin, async (req, res) => {
  const m = await _loadStaffModules();
  if (!m) return res.send(_NOT_DEPLOYED_HTML(req.params.id));
  const { StaffCard } = m;
  try {
    const card = await StaffCard.findById(req.params.cid).lean();
    if (!card) return res.redirect(`/zq-admin/suppliers/${req.params.id}/staff-cards?error=Card+not+found`);
    await StaffCard.findByIdAndUpdate(req.params.cid,{$set:{active:!card.active}});
    const msg = card.active?`${card.name}'s card deactivated`:`${card.name}'s card activated`;
    res.redirect(`/zq-admin/suppliers/${req.params.id}/staff-cards?success=${encodeURIComponent(msg)}`);
  } catch (err) {
    res.redirect(`/zq-admin/suppliers/${req.params.id}/staff-cards?error=${encodeURIComponent(err.message)}`);
  }
});

router.post("/suppliers/:id/staff-cards/:cid/delete", requireSupplierAdmin, async (req, res) => {
  const m = await _loadStaffModules();
  if (!m) return res.send(_NOT_DEPLOYED_HTML(req.params.id));
  const { StaffCard } = m;
  try {
    const card = await StaffCard.findById(req.params.cid).lean();
    if (!card) return res.redirect(`/zq-admin/suppliers/${req.params.id}/staff-cards?error=Card+not+found`);
    await StaffCard.findByIdAndDelete(req.params.cid);
    res.redirect(`/zq-admin/suppliers/${req.params.id}/staff-cards?success=${encodeURIComponent(card.name+"'s card deleted")}`);
  } catch (err) {
    res.redirect(`/zq-admin/suppliers/${req.params.id}/staff-cards?error=${encodeURIComponent(err.message)}`);
  }
});

router.get("/suppliers/:id/staff-cards/:cid/smart-link", requireSupplierAdmin, async (req, res) => {
  const m = await _loadStaffModules();
  if (!m) return res.send(_NOT_DEPLOYED_HTML(req.params.id));
  const { StaffCard, assignSlugToStaffCard, buildStaffDeepLink, buildAllStaffLinks, buildStaffQrImageUrl, buildStaffProfileCard, buildStaffSharableCaption, buildStaffAnalyticsSummary } = m;
  try {
    const supplier = await SupplierProfile.findById(req.params.id).lean();
    let card       = await StaffCard.findById(req.params.cid).lean();
    if (!supplier||!card) return res.redirect(`/zq-admin/suppliers/${req.params.id}/staff-cards`);
    if (!card.zqSlug){try{await assignSlugToStaffCard(String(card._id));card=await StaffCard.findById(card._id).lean();}catch(_){}}
    const cardId     = String(card._id);
    const allLinks   = buildAllStaffLinks(cardId);
    const directLink = buildStaffDeepLink(cardId, null);
    // ── Build QR URLs matching buildStaffQrImageUrl() exactly ────────────────────
    // Payload: ZQ:STAFF:<id>:SRC:qr  (NOT ZQ:S: - that routes to supplier resolver)
    // Service: chart.googleapis.com
    const _DETAIL_BOT = (process.env.WHATSAPP_BOT_NUMBER || "263771143904").replace(/\D/g, "");
    function _detailQr(size) {
      const rawPayload = "ZQ:STAFF:" + cardId + ":SRC:qr";
      const rawWaLink  = "https://wa.me/" + _DETAIL_BOT + "?text=" + rawPayload;
      return "https://chart.googleapis.com/chart?cht=qr&chs=" + size + "x" + size
        + "&chl=" + encodeURIComponent(rawWaLink) + "&choe=UTF-8";
    }
    const qrUrl400 = _detailQr(400);
    const qrUrl600 = _detailQr(600);
    const stats      = buildStaffAnalyticsSummary(card);
    const srcViews   = card.zqSourceViews||{};
    const srcConvs   = card.zqSourceConversions||{};
    const preview    = buildStaffProfileCard(card, supplier);
    const successMsg = req.query.success ? `<div style="background:#dcfce7;color:#16a34a;padding:12px 16px;border-radius:8px;margin-bottom:16px;font-size:13px">✅ ${esc(req.query.success)}</div>` : "";
    const sourceRows = Object.entries(STAFF_LINK_SOURCES).map(([src, label]) => {
      const link    = src==="direct"?directLink:allLinks[src];
      const caption = buildStaffSharableCaption(card, supplier, src);
      return `<tr style="border-bottom:1px solid #f5f5f5">
        <td style="padding:10px 8px;font-size:13px;font-weight:600;white-space:nowrap">${esc(label)}</td>
        <td style="padding:10px 8px;font-size:11px;max-width:240px;word-break:break-all">
          <code style="background:#f5f5f5;padding:3px 6px;border-radius:4px;font-size:10px">${esc(link)}</code>
          <button onclick="navigator.clipboard.writeText(${JSON.stringify(link)});this.textContent='✅'" style="margin-left:6px;padding:2px 8px;font-size:11px;border:1px solid #d1d5db;border-radius:4px;cursor:pointer;background:#fff">Copy</button>
        </td>
        <td style="padding:10px 8px;text-align:center;font-size:13px;font-weight:700">${srcViews[src]||0}</td>
        <td style="padding:10px 8px;text-align:center;font-size:13px;font-weight:700">${srcConvs[src]||0}</td>
        <td style="padding:10px 8px"><details><summary style="cursor:pointer;font-size:12px;color:#3b82f6">📋 Caption</summary>
          <pre style="font-size:11px;background:#f9f9f9;padding:8px;border-radius:4px;white-space:pre-wrap;margin-top:6px;max-height:180px;overflow-y:auto">${esc(caption)}</pre>
          <button onclick="navigator.clipboard.writeText(this.previousElementSibling.textContent.trim());this.textContent='✅'" style="margin-top:4px;padding:3px 10px;font-size:11px;border:1px solid #d1d5db;border-radius:4px;cursor:pointer;background:#fff">Copy Caption</button>
        </details></td>
      </tr>`;
    }).join("");
    res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Smart Link – ${esc(card.name)}</title>
<style>body{font-family:system-ui,sans-serif;margin:0;background:#f8f9fa;color:#222}.wrap{max-width:1100px;margin:0 auto;padding:24px 16px}.back{font-size:13px;color:#3b82f6;text-decoration:none;margin-bottom:16px;display:inline-block}h1{font-size:20px;margin:0 0 4px}.sub{font-size:13px;color:#888;margin-bottom:16px}.cols{display:flex;gap:20px;flex-wrap:wrap}.col{flex:1;min-width:280px}.card{background:#fff;border-radius:8px;padding:20px;box-shadow:0 1px 4px rgba(0,0,0,.08);margin-bottom:20px}.card h2{font-size:12px;text-transform:uppercase;color:#888;margin:0 0 14px;letter-spacing:.05em}.stat-row{display:flex;gap:12px;margin-bottom:20px;flex-wrap:wrap}.stat{flex:1;min-width:80px;background:#f5f5f5;border-radius:8px;padding:12px 16px;text-align:center}.stat .n{font-size:26px;font-weight:700}.stat .l{font-size:11px;color:#888;margin-top:2px}table{width:100%;border-collapse:collapse}th{background:#f5f5f5;font-size:11px;text-transform:uppercase;padding:8px;text-align:left;color:#888}.preview{background:#fffbeb;border:1px solid #fde68a;border-radius:8px;padding:16px;font-family:monospace;font-size:12px;white-space:pre-wrap;line-height:1.7}</style></head>
<body><div class="wrap">
<a class="back" href="/zq-admin/suppliers/${esc(req.params.id)}/staff-cards">← Staff Cards</a>
${successMsg}
<div style="display:flex;align-items:flex-start;gap:16px;flex-wrap:wrap;margin-bottom:16px">
  <div><h1>🔗 ${esc(card.name)}'s Smart Link</h1>
  <p class="sub">${esc(card.title||supplier.businessName)} · <span style="display:inline-block;padding:2px 8px;border-radius:12px;font-size:11px;background:${card.active?"#dcfce7":"#fee2e2"};color:${card.active?"#16a34a":"#dc2626"}">${card.active?"Active":"Inactive"}</span>${card.zqSlug?`<span style="margin-left:8px;font-size:12px;color:#888">Slug: <code>${esc(card.zqSlug)}</code></span>`:""}</p></div>
  <div style="margin-left:auto;display:flex;gap:8px;flex-wrap:wrap">
    <a href="/zq-admin/suppliers/${esc(req.params.id)}/staff-cards/${esc(cardId)}/business-card" target="_blank" style="padding:8px 14px;background:#8b5cf6;color:#fff;border-radius:6px;font-size:13px;text-decoration:none;font-weight:600">🖨 Print Card</a>
    <a href="/zq-admin/suppliers/${esc(req.params.id)}/staff-cards/${esc(cardId)}/edit" style="padding:8px 14px;background:#f59e0b;color:#fff;border-radius:6px;font-size:13px;text-decoration:none;font-weight:600">✏️ Edit</a>
    <form method="POST" action="/zq-admin/suppliers/${esc(req.params.id)}/staff-cards/${esc(cardId)}/toggle-active" style="display:inline">
      <button type="submit" style="padding:8px 14px;background:${card.active?"#6b7280":"#10b981"};color:#fff;border:none;border-radius:6px;font-size:13px;cursor:pointer;font-weight:600">${card.active?"Deactivate":"Activate"}</button>
    </form>
  </div>
</div>
<div class="stat-row">
  <div class="stat"><div class="n">${stats.views}</div><div class="l">Total Views</div></div>
  <div class="stat"><div class="n">${stats.converts}</div><div class="l">Enquiries</div></div>
  <div class="stat"><div class="n">${stats.convRate}%</div><div class="l">Conv. Rate</div></div>
  <div class="stat"><div class="n" style="font-size:14px">${esc(stats.topSource)}</div><div class="l">Top Source</div></div>
</div>
<div class="cols">
  <div class="col">
    <div class="card"><h2>📱 QR Code</h2>
      <div style="text-align:center;margin-bottom:12px"><img src="${esc(qrUrl400)}" width="200" height="200" style="border:1px solid #eee;border-radius:8px"></div>
      <div style="display:flex;gap:8px;justify-content:center;flex-wrap:wrap">
        <a href="${esc(qrUrl400)}" target="_blank" style="padding:7px 14px;background:#3b82f6;color:#fff;border-radius:6px;font-size:12px;text-decoration:none">Open QR</a>
        <a href="${esc(qrUrl600)}" target="_blank" style="padding:7px 14px;background:#6b7280;color:#fff;border-radius:6px;font-size:12px;text-decoration:none">600px (Print)</a>
      </div>
    </div>
    <div class="card"><h2>🔗 Direct WhatsApp Link</h2>
      <code style="display:block;background:#f5f5f5;padding:10px;border-radius:6px;font-size:11px;word-break:break-all;margin-bottom:10px">${esc(directLink)}</code>
      <button onclick="navigator.clipboard.writeText(${JSON.stringify(directLink)});this.textContent='✅ Copied'" style="padding:7px 14px;background:#fff;border:1px solid #d1d5db;border-radius:6px;font-size:12px;cursor:pointer">Copy Link</button>
      <a href="${esc(directLink)}" target="_blank" style="margin-left:8px;padding:7px 14px;background:#25d366;color:#fff;border-radius:6px;font-size:12px;text-decoration:none">Test on WhatsApp</a>
    </div>
  </div>
  <div class="col">
    <div class="card"><h2>💬 What buyers see on WhatsApp</h2>
      <div class="preview">${esc(preview)}</div>
    </div>
  </div>
</div>
<div class="card"><h2>📊 Source-Tracked Links &amp; Captions</h2>
  <div style="overflow-x:auto"><table><thead><tr><th>Platform</th><th>Link</th><th>Views</th><th>Enquiries</th><th>Caption</th></tr></thead><tbody>${sourceRows}</tbody></table></div>
</div>
</div></body></html>`);
  } catch (err) {
    res.redirect(`/zq-admin/suppliers/${req.params.id}/staff-cards?error=${encodeURIComponent(err.message)}`);
  }
});

router.post("/suppliers/:id/staff-cards/:cid/regenerate-slug", requireSupplierAdmin, async (req, res) => {
  const m = await _loadStaffModules();
  if (!m) return res.send(_NOT_DEPLOYED_HTML(req.params.id));
  const { assignSlugToStaffCard } = m;
  try {
    const slug = await assignSlugToStaffCard(req.params.cid, { force: true });
    res.redirect(`/zq-admin/suppliers/${req.params.id}/staff-cards/${req.params.cid}/smart-link?success=${encodeURIComponent("Slug regenerated: "+slug)}`);
  } catch (err) {
    res.redirect(`/zq-admin/suppliers/${req.params.id}/staff-cards/${req.params.cid}/smart-link?error=${encodeURIComponent(err.message)}`);
  }
});

router.get("/suppliers/:id/staff-cards/:cid/business-card", requireSupplierAdmin, async (req, res) => {
  const m = await _loadStaffModules();
  if (!m) return res.send(_NOT_DEPLOYED_HTML(req.params.id));
  const { StaffCard, buildStaffQrImageUrl } = m;
  try {
    const supplier = await SupplierProfile.findById(req.params.id).lean();
    const card     = await StaffCard.findById(req.params.cid).lean();
    if (!supplier||!card) return res.status(404).send("Not found");
    // ── Build QR URL matching buildStaffQrImageUrl() exactly ─────────────────────
    // Payload: ZQ:STAFF:<id>:SRC:qr  (chart.googleapis.com - same as the service function)
    const _BC_BOT    = (process.env.WHATSAPP_BOT_NUMBER || "263771143904").replace(/\D/g, "");
    const _bcRawPayload = "ZQ:STAFF:" + String(card._id) + ":SRC:qr";
    const _bcRawWaLink  = "https://wa.me/" + _BC_BOT + "?text=" + _bcRawPayload;
    const qrUrl      = "https://chart.googleapis.com/chart?cht=qr&chs=300x300"
                     + "&chl=" + encodeURIComponent(_bcRawWaLink) + "&choe=UTF-8";
    const location = card.locationLabel || [supplier.location?.area, supplier.location?.city].filter(Boolean).join(", ");
    const phone    = (() => { const p=card.phone; return p.length>=11?`+${p.slice(0,3)} ${p.slice(3,5)} ${p.slice(5,8)} ${p.slice(8)}`:p; })();
    const tagline  = card.tagline || supplier.businessName;
    res.setHeader("Content-Type","text/html");
    res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Business Card – ${esc(card.name)}</title>
<style>@page{size:85mm 54mm;margin:0}*{box-sizing:border-box;margin:0;padding:0}body{width:85mm;height:54mm;font-family:Arial,sans-serif;overflow:hidden}.card{width:85mm;height:54mm;background:#0f1f3d;color:#fff;display:flex;position:relative;overflow:hidden}.accent{width:8mm;background:linear-gradient(180deg,#b8860b 0%,#ffd700 50%,#b8860b 100%);flex-shrink:0}.content{flex:1;padding:5mm 4mm 4mm 5mm;display:flex;flex-direction:column;justify-content:space-between}.top{display:flex;justify-content:space-between;align-items:flex-start}.name-block .name{font-size:11pt;font-weight:700;color:#ffd700;letter-spacing:.03em}.name-block .title{font-size:7pt;color:#cbd5e1;margin-top:1mm}.name-block .biz{font-size:8pt;font-weight:600;color:#fff;margin-top:2mm}.name-block .loc{font-size:6pt;color:#94a3b8;margin-top:0.5mm}.qr-block{display:flex;flex-direction:column;align-items:center;gap:1mm}.qr-block img{width:16mm;height:16mm;border:1px solid #ffd700;border-radius:2px}.qr-block .scan-text{font-size:5pt;color:#94a3b8;text-align:center;white-space:nowrap}.bottom{display:flex;flex-direction:column;gap:1mm}.contact-line{font-size:7pt;color:#e2e8f0;display:flex;align-items:center;gap:1.5mm}.contact-line .icon{color:#ffd700;font-size:7pt}.tagline{font-size:5.5pt;color:#ffd700;font-style:italic;margin-top:1mm;text-align:center;border-top:0.5px solid rgba(255,215,0,.3);padding-top:1.5mm}.zq-badge{position:absolute;bottom:2mm;right:3mm;font-size:5pt;color:rgba(255,255,255,.3)}@media screen{body{display:flex;align-items:center;justify-content:center;height:100vh;background:#555}.card{box-shadow:0 8px 32px rgba(0,0,0,.5);border-radius:3mm}.print-btn{position:fixed;top:20px;right:20px;padding:10px 20px;background:#3b82f6;color:#fff;border:none;border-radius:6px;font-size:14px;cursor:pointer;font-family:system-ui}}</style></head>
<body><button class="print-btn" onclick="window.print()">🖨 Print / Save PDF</button>
<div class="card"><div class="accent"></div><div class="content">
<div class="top"><div class="name-block">
  <div class="name">${esc(card.name)}</div>
  ${card.title?`<div class="title">${esc(card.title)}</div>`:""}
  <div class="biz">${esc(supplier.businessName)}</div>
  ${location?`<div class="loc">📍 ${esc(location)}</div>`:""}
</div><div class="qr-block"><img src="${esc(qrUrl)}" alt="QR"><div class="scan-text">Scan to quote</div></div></div>
<div class="bottom">
  ${phone?`<div class="contact-line"><span class="icon">📱</span><span>${esc(phone)}</span></div>`:""}
  ${card.email?`<div class="contact-line"><span class="icon">✉</span><span>${esc(card.email)}</span></div>`:""}
  ${supplier.website?`<div class="contact-line"><span class="icon">🌐</span><span>${esc(supplier.website.replace(/^https?:\/\//,""))}</span></div>`:""}
  ${tagline?`<div class="tagline">"${esc(tagline)}"</div>`:""}
</div></div><div class="zq-badge">ZimQuote</div></div></body></html>`);
  } catch (err) {
    res.status(500).send("Error: "+esc(err.message));
  }
});


// ═════════════════════════════════════════════════════════════════════════════
// PUBLIC SCHOOL APPLICATION FORM - no auth required
// GET  /apply/school/:id          → web application form page
// POST /apply/school/:id/submit   → handle web form submission
// ═════════════════════════════════════════════════════════════════════════════

router.get("/apply/school/:id", async (req, res) => {
  try {
    const SP = (await import("../models/schoolProfile.js")).default;
    const school = await SP.findById(req.params.id).lean();
    if (!school) return res.status(404).send("School not found.");

    const form       = school.applicationForm || {};
    const feesRaw    = school.fees;
    const feesStr    = feesRaw?.term1 ? `$${feesRaw.term1}/term` : (typeof feesRaw === "number" ? `$${feesRaw}/term` : "");
    const curriculum = (school.curriculum || []).map(c => c.toUpperCase()).join(" + ") || "";
    const location   = school.location?.area
      ? `${school.location.area}, ${school.location.city || ""}`
      : school.location?.city || school.suburb || "";
    const gradeOpts  = form.gradeOptions || [];
    const intakeYear = form.intakeYear || "";
    const ok         = req.query.success === "1";

    const gradeSelect = gradeOpts.length
      ? `<select name="grade" required style="width:100%;padding:11px 14px;border:2px solid #e2e8f0;border-radius:8px;font-size:15px;background:white;appearance:none">
           <option value="">- Select grade -</option>
           ${gradeOpts.map(g => `<option value="${esc(g)}">${esc(g)}</option>`).join("")}
         </select>`
      : `<input name="grade" type="text" required placeholder="e.g. Form 1, Grade 7, ECD A" style="width:100%;padding:11px 14px;border:2px solid #e2e8f0;border-radius:8px;font-size:15px">`;

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Apply - ${esc(school.schoolName)}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f0f4f8;min-height:100vh;padding:16px}
.wrap{max-width:560px;margin:0 auto}
.header{background:linear-gradient(135deg,#1a3c5e 0%,#0ea5e9 100%);color:white;border-radius:16px 16px 0 0;padding:28px 24px 24px;text-align:center}
.header h1{font-size:22px;font-weight:800;margin-bottom:4px}
.header .sub{font-size:14px;opacity:.85}
.school-card{background:#1e4976;color:white;padding:16px 24px;font-size:13px;line-height:1.7}
.school-card p{margin:2px 0}
.card{background:white;padding:24px;border-radius:0 0 16px 16px;box-shadow:0 4px 20px rgba(0,0,0,.1)}
.section{margin-bottom:22px}
.section-title{font-size:13px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.8px;margin-bottom:14px;padding-bottom:6px;border-bottom:2px solid #f0f4f8}
.field{margin-bottom:16px}
label{display:block;font-size:13px;font-weight:600;color:#374151;margin-bottom:6px}
label .req{color:#ef4444}
input[type=text],input[type=date],input[type=email],input[type=tel],select,textarea{width:100%;padding:11px 14px;border:2px solid #e2e8f0;border-radius:8px;font-size:15px;transition:border .2s;outline:none;font-family:inherit}
input:focus,select:focus,textarea:focus{border-color:#0ea5e9}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:12px}
@media(max-width:480px){.grid2{grid-template-columns:1fr}}
.btn-submit{width:100%;padding:16px;background:linear-gradient(135deg,#1a3c5e,#0ea5e9);color:white;border:none;border-radius:10px;font-size:17px;font-weight:700;cursor:pointer;margin-top:8px;letter-spacing:.3px}
.btn-submit:hover{opacity:.92}
.success{background:#f0fdf4;border:2px solid #bbf7d0;border-radius:12px;padding:28px;text-align:center;margin:16px 0}
.success h2{color:#16a34a;font-size:20px;margin-bottom:10px}
.success p{color:#166534;font-size:14px;line-height:1.6}
.downloads{background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:16px;margin-top:18px}
.downloads h3{font-size:13px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.6px;margin-bottom:12px}
.dl-btn{display:block;padding:11px 16px;background:white;border:1.5px solid #e2e8f0;border-radius:8px;text-decoration:none;color:#1a3c5e;font-size:14px;font-weight:600;margin-bottom:8px;transition:border-color .2s}
.dl-btn:hover{border-color:#0ea5e9}
.footer{text-align:center;font-size:12px;color:#94a3b8;margin-top:20px;padding-bottom:16px}
.footer a{color:#1a3c5e}
.note{font-size:12px;color:#94a3b8;margin-top:4px}
</style>
</head>
<body>
<div class="wrap">
  <div class="header">
    <div style="font-size:36px;margin-bottom:8px">🏫</div>
    <h1>${esc(school.schoolName)}${school.verified ? " ✅" : ""}</h1>
    ${intakeYear ? `<div class="sub">${esc(intakeYear)}</div>` : ""}
  </div>
  <div class="school-card">
    ${location ? `<p>📍 ${esc(location)}</p>` : ""}
    ${feesStr ? `<p>💰 ${esc(feesStr)}${curriculum ? ` &nbsp;·&nbsp; ${esc(curriculum)}` : ""}</p>` : (curriculum ? `<p>📚 ${esc(curriculum)}</p>` : "")}
    ${school.contactPhone || school.phone ? `<p>📞 ${esc(school.contactPhone || school.phone)}</p>` : ""}
    ${school.email ? `<p>📧 ${esc(school.email)}</p>` : ""}
  </div>
  <div class="card">
    ${ok ? `<div class="success">
      <div style="font-size:48px;margin-bottom:10px">✅</div>
      <h2>Application Submitted!</h2>
      <p>Your application has been sent directly to <strong>${esc(school.schoolName)}</strong>.<br>
      The school will contact you shortly on the number you provided.<br><br>
      <em>If you also completed a WhatsApp form or downloaded the PDF, the school has received all versions.</em></p>
    </div>` : `
    <form method="POST" action="/apply/school/${esc(req.params.id)}/submit">

      <div class="section">
        <div class="section-title">Student Details</div>
        <div class="field">
          <label>Student Full Name <span class="req">*</span></label>
          <input name="studentName" type="text" required placeholder="e.g. Tatenda Moyo">
        </div>
        <div class="grid2">
          <div class="field">
            <label>Grade Applying For <span class="req">*</span></label>
            ${gradeSelect}
          </div>
          <div class="field">
            <label>Date of Birth <span class="req">*</span></label>
            <input name="dob" type="date" required>
          </div>
        </div>
        <div class="grid2">
          <div class="field">
            <label>Gender</label>
            <select name="gender" style="width:100%;padding:11px 14px;border:2px solid #e2e8f0;border-radius:8px;font-size:15px;background:white">
              <option value="">- Select -</option>
              <option>Male</option><option>Female</option>
            </select>
          </div>
          <div class="field">
            <label>Nationality</label>
            <input name="nationality" type="text" placeholder="e.g. Zimbabwean">
          </div>
        </div>
        <div class="field">
          <label>Current School (if any)</label>
          <input name="currentSchool" type="text" placeholder="e.g. Churchill Primary School">
        </div>
        <div class="field">
          <label>Home Address</label>
          <input name="homeAddress" type="text" placeholder="e.g. 12 Borrowdale Road, Harare">
        </div>
      </div>

      <div class="section">
        <div class="section-title">Parent / Guardian Details</div>
        <div class="grid2">
          <div class="field">
            <label>Parent / Guardian Name <span class="req">*</span></label>
            <input name="parentName" type="text" required placeholder="e.g. Blessing Moyo">
          </div>
          <div class="field">
            <label>Relationship to Student</label>
            <select name="relationship" style="width:100%;padding:11px 14px;border:2px solid #e2e8f0;border-radius:8px;font-size:15px;background:white">
              <option value="">- Select -</option>
              <option>Father</option><option>Mother</option><option>Guardian</option><option>Other</option>
            </select>
          </div>
        </div>
        <div class="grid2">
          <div class="field">
            <label>WhatsApp / Phone Number <span class="req">*</span></label>
            <input name="parentPhone" type="tel" required placeholder="e.g. 0771234567">
            <div class="note">The school will call or WhatsApp you on this number</div>
          </div>
          <div class="field">
            <label>Email Address (optional)</label>
            <input name="parentEmail" type="email" placeholder="parent@email.com">
          </div>
        </div>
        <div class="field">
          <label>Occupation</label>
          <input name="occupation" type="text" placeholder="e.g. Teacher, Business Owner">
        </div>
      </div>

      <div class="section">
        <div class="section-title">Emergency &amp; Medical</div>
        <div class="grid2">
          <div class="field">
            <label>Emergency Contact Name</label>
            <input name="emergencyName" type="text" placeholder="e.g. Chipo Moyo">
          </div>
          <div class="field">
            <label>Emergency Contact Phone</label>
            <input name="emergencyPhone" type="tel" placeholder="e.g. 0712345678">
          </div>
        </div>
        <div class="field">
          <label>Known Allergies or Medical Conditions</label>
          <textarea name="medical" rows="2" placeholder="None / describe any conditions..." style="width:100%;padding:11px 14px;border:2px solid #e2e8f0;border-radius:8px;font-size:14px;resize:vertical;font-family:inherit"></textarea>
        </div>
      </div>

      <div class="section">
        <div class="section-title">Additional Notes</div>
        <div class="field">
          <textarea name="notes" rows="2" placeholder="Any other information the school should know..." style="width:100%;padding:11px 14px;border:2px solid #e2e8f0;border-radius:8px;font-size:14px;resize:vertical;font-family:inherit"></textarea>
        </div>
      </div>

      <p style="font-size:12px;color:#94a3b8;margin-bottom:16px;line-height:1.5">
        ✅ By submitting this form, I confirm that the information provided is true and correct.
        This application will be sent directly to ${esc(school.schoolName)}.
      </p>
      <button type="submit" class="btn-submit">📩 Submit Application</button>
    </form>`}

    ${form.brochureUrl || form.rawFormUrl ? `
    <div class="downloads">
      <h3>📥 Downloads</h3>
      ${form.brochureUrl ? `<a href="${esc(form.brochureUrl)}" target="_blank" class="dl-btn">📄 ${esc(form.brochureName || "School Brochure")} ↗</a>` : ""}
      ${form.rawFormUrl  ? `<a href="${esc(form.rawFormUrl)}"  target="_blank" class="dl-btn">📋 ${esc(form.rawFormName  || "Printable Application Form")} ↗</a>` : ""}
    </div>` : ""}
  </div>
  <div class="footer">
    Powered by <a href="https://zimquote.co.zw">ZimQuote</a> · School Management Platform
  </div>
</div>
</body></html>`;

    res.send(html);
  } catch (err) {
    res.status(500).send("Error loading application form: " + err.message);
  }
});

// POST /apply/school/:id/submit - handle web form submission
router.post("/apply/school/:id/submit", async (req, res) => {
  try {
    const SP = (await import("../models/schoolProfile.js")).default;
    const school = await SP.findById(req.params.id).lean();
    if (!school) return res.status(404).send("School not found.");

    const {
      studentName, grade, dob, gender, nationality, currentSchool, homeAddress,
      parentName, relationship, parentPhone, parentEmail, occupation,
      emergencyName, emergencyPhone, medical, notes
    } = req.body;

    if (!studentName || !grade || !dob || !parentName || !parentPhone) {
      return res.redirect(`/apply/school/${req.params.id}?error=Please+fill+in+all+required+fields.`);
    }

    const data = {
      studentName, grade, dob, gender, nationality, currentSchool, homeAddress,
      parentName, relationship, parentPhone, parentEmail, occupation,
      emergencyName, emergencyPhone, medical, notes,
      intakeYear: school.applicationForm?.intakeYear || "",
      submittedVia: "web"
    };

    // Capture contact
    try {
      const SC = (await import("../models/schoolContact.js")).default;
      const normP = parentPhone.replace(/\D/g,"");
      const fullP = normP.startsWith("0") ? "263"+normP.slice(1) : normP;
      await SC.findOneAndUpdate(
        { schoolId: school._id, phone: fullP },
        {
          $set:  { lastSeen: new Date(), source: "apply", converted: true, appliedAt: new Date(),
                   studentName, parentName, gradeInterest: grade, applicationData: data },
          $inc:  { viewCount: 1 },
          $setOnInsert: { firstSeen: new Date(), phone: fullP, schoolId: school._id }
        },
        { upsert: true }
      );
    } catch (_ce) { console.warn("[SCHOOL WEB CONTACT]", _ce.message); }

    // Email + WhatsApp notifications
    try {
      const { notifySchoolWebSubmission } = await import("../services/schoolApplicationForm.js");
      const normP2 = parentPhone.replace(/\D/g,"");
      const fullP2 = normP2.startsWith("0") ? "263"+normP2.slice(1) : normP2;
      await notifySchoolWebSubmission({ school, data, applicantPhone: fullP2 });
    } catch (_ne) { console.warn("[SCHOOL WEB NOTIFY]", _ne.message); }

    res.redirect(`/apply/school/${req.params.id}?success=1`);
  } catch (err) {
    console.error("[SCHOOL WEB SUBMIT]", err.message);
    res.redirect(`/apply/school/${req.params.id}?error=${encodeURIComponent("Submission failed. Please try again.")}`);
  }
});


// ─────────────────────────────────────────────────────────────────────────────
// PATCH: supplierAdmin.js - Recurring Billing admin routes
//
// WHERE TO INSERT: Add this entire block BEFORE "
// ── GET /suppliers/:id/recurring/:acctId/edit - edit account ─────────────────
router.get("/suppliers/:id/recurring/:acctId/edit", requireSupplierAdmin, async (req, res) => {
  try {
    const supplier = await SupplierProfile.findById(req.params.id).lean();
    const Business         = (await import("../models/business.js")).default;
    const RecurringAccount = (await import("../models/recurringAccount.js")).default;
    const Branch           = (await import("../models/branch.js")).default;
    const biz  = supplier?.businessId ? await Business.findById(supplier.businessId).lean() : null;
    const acct = await RecurringAccount.findById(req.params.acctId).lean();
    if (!acct || !biz) return res.redirect(`/zq-admin/suppliers/${req.params.id}/recurring`);

    const branches = await Branch.find({ businessId: biz._id }).lean();
    const errMsg     = req.query.error   ? `<div class="alert red">❌ ${esc(req.query.error)}</div>`   : "";
    const successMsg = req.query.success ? `<div class="alert green">✅ ${esc(req.query.success)}</div>` : "";

    const catOpts = ["unit","flat","room","student","policy","member","plot","other"]
      .map(c => `<option value="${c}" ${acct.category === c ? "selected" : ""}>${c.charAt(0).toUpperCase()+c.slice(1)}</option>`)
      .join("");
    const cycleOpts = ["monthly","quarterly","termly","annual"]
      .map(c => `<option value="${c}" ${acct.billingCycle === c ? "selected" : ""}>${c.charAt(0).toUpperCase()+c.slice(1)}</option>`)
      .join("");
    const branchOpts = `<option value="">- No branch -</option>` +
      branches.map(b => `<option value="${b._id}" ${String(acct.branchId) === String(b._id) ? "selected" : ""}>${esc(b.name)}</option>`).join("");

    const content = `
      <div style="margin-bottom:16px">
        <a href="/zq-admin/suppliers/${supplier._id}/recurring" style="color:var(--blue);text-decoration:none">← Back to Recurring Billing</a>
      </div>
      <h2 style="font-size:20px;font-weight:700;margin-bottom:20px">✏️ Edit Account - ${esc(acct.name)}</h2>
      ${errMsg}${successMsg}
      <div class="card" style="max-width:600px">
        <form method="POST" action="/zq-admin/suppliers/${supplier._id}/recurring/${acct._id}/edit">
          <div style="margin-bottom:14px">
            <label style="font-weight:600;display:block;margin-bottom:6px">Account / Unit Name *</label>
            <input name="name" required value="${esc(acct.name)}"
              style="width:100%;padding:9px 12px;border:1px solid var(--border);border-radius:7px;font-size:14px">
          </div>
          <div style="margin-bottom:14px">
            <label style="font-weight:600;display:block;margin-bottom:6px">Short Reference Code</label>
            <input name="ref" value="${esc(acct.ref || "")}"
              style="width:100%;padding:9px 12px;border:1px solid var(--border);border-radius:7px;font-size:14px">
          </div>
          <div style="margin-bottom:14px">
            <label style="font-weight:600;display:block;margin-bottom:6px">Category</label>
            <select name="category" style="width:100%;padding:9px 12px;border:1px solid var(--border);border-radius:7px;font-size:14px">${catOpts}</select>
          </div>
          <div style="margin-bottom:14px">
            <label style="font-weight:600;display:block;margin-bottom:6px">Description</label>
            <input name="description" value="${esc(acct.description || "")}"
              style="width:100%;padding:9px 12px;border:1px solid var(--border);border-radius:7px;font-size:14px">
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:14px">
            <div>
              <label style="font-weight:600;display:block;margin-bottom:6px">Charge Amount *</label>
              <input name="billingAmount" type="number" step="0.01" required value="${acct.billingAmount || 0}"
                style="width:100%;padding:9px 12px;border:1px solid var(--border);border-radius:7px;font-size:14px">
            </div>
            <div>
              <label style="font-weight:600;display:block;margin-bottom:6px">Billing Cycle</label>
              <select name="billingCycle" style="width:100%;padding:9px 12px;border:1px solid var(--border);border-radius:7px;font-size:14px">${cycleOpts}</select>
            </div>
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:14px">
            <div>
              <label style="font-weight:600;display:block;margin-bottom:6px">Billing Day (1–28)</label>
              <input name="billingDay" type="number" min="1" max="28" value="${acct.billingDay || 1}"
                style="width:100%;padding:9px 12px;border:1px solid var(--border);border-radius:7px;font-size:14px">
            </div>
            <div>
              <label style="font-weight:600;display:block;margin-bottom:6px">Branch</label>
              <select name="branchId" style="width:100%;padding:9px 12px;border:1px solid var(--border);border-radius:7px;font-size:14px">${branchOpts}</select>
            </div>
          </div>
          <div style="margin-bottom:14px">
            <label style="display:flex;align-items:center;gap:8px;cursor:pointer">
              <input type="checkbox" name="isActive" value="1" ${acct.isActive !== false ? "checked" : ""}
                style="width:16px;height:16px">
              <span style="font-weight:600">Account is active</span>
            </label>
          </div>
          <div style="display:flex;gap:10px;margin-top:20px">
            <button type="submit" style="background:var(--blue);color:white;padding:10px 20px;border:none;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer">
              ✅ Save Changes
            </button>
            <a href="/zq-admin/suppliers/${supplier._id}/recurring"
               style="background:#f1f5f9;color:var(--text);padding:10px 20px;border-radius:8px;font-size:14px;text-decoration:none">
              Cancel
            </a>
          </div>
        </form>
      </div>`;

    res.send(layout(`Recurring: ${acct.name}`, content));
  } catch (e) {
    res.redirect(`/zq-admin/suppliers/${req.params.id}/recurring?error=${encodeURIComponent(e.message)}`);
  }
});

// ── POST /suppliers/:id/recurring/:acctId/edit - save account edits ──────────
router.post("/suppliers/:id/recurring/:acctId/edit", requireSupplierAdmin, async (req, res) => {
  try {
    const RecurringAccount = (await import("../models/recurringAccount.js")).default;
    const { name, ref, category, description, billingAmount, billingCycle, billingDay, branchId, isActive } = req.body;
    await RecurringAccount.findByIdAndUpdate(req.params.acctId, {
      name:          name?.trim(),
      ref:           (ref || "").trim(),
      category:      category || "unit",
      description:   (description || "").trim(),
      billingAmount: parseFloat(billingAmount) || 0,
      billingCycle:  billingCycle || "monthly",
      billingDay:    parseInt(billingDay, 10) || 1,
      branchId:      branchId || null,
      isActive:      isActive === "1"
    });
    res.redirect(`/zq-admin/suppliers/${req.params.id}/recurring?success=${encodeURIComponent(`Account "${name}" updated`)}`);
  } catch (e) {
    res.redirect(`/zq-admin/suppliers/${req.params.id}/recurring/${req.params.acctId}/edit?error=${encodeURIComponent(e.message)}`);
  }
});

// ── POST /suppliers/:id/recurring/:acctId/record-payment - record payment ────
router.post("/suppliers/:id/recurring/:acctId/record-payment", requireSupplierAdmin, async (req, res) => {
  try {
    const supplier = await SupplierProfile.findById(req.params.id).lean();
    const Business = (await import("../models/business.js")).default;
    const biz = supplier?.businessId ? await Business.findById(supplier.businessId).lean() : null;
    if (!biz) return res.redirect(`/zq-admin/suppliers/${req.params.id}/recurring`);

    const { amount, method, reference, notes } = req.body;
    const { recordRecurringPayment } = await import("../services/recurringBilling.js");
    await recordRecurringPayment({
      businessId: biz._id,
      accountId:  req.params.acctId,
      amount:     parseFloat(amount) || 0,
      method:     method || "cash",
      reference:  reference || "",
      notes:      notes || "",
      clerkPhone: "admin",
      date:       new Date()
    });

    res.redirect(`/zq-admin/suppliers/${req.params.id}/recurring/${req.params.acctId}/statement?success=${encodeURIComponent("Payment recorded")}`);
  } catch (e) {
    res.redirect(`/zq-admin/suppliers/${req.params.id}/recurring?error=${encodeURIComponent(e.message)}`);
  }
});

// ── POST /suppliers/:id/recurring/:acctId/delete - deactivate account ────────
router.post("/suppliers/:id/recurring/:acctId/delete", requireSupplierAdmin, async (req, res) => {
  try {
    const RecurringAccount = (await import("../models/recurringAccount.js")).default;
    await RecurringAccount.findByIdAndUpdate(req.params.acctId, { isActive: false });
    res.redirect(`/zq-admin/suppliers/${req.params.id}/recurring?success=Account+deactivated`);
  } catch (e) {
    res.redirect(`/zq-admin/suppliers/${req.params.id}/recurring?error=${encodeURIComponent(e.message)}`);
  }
});


// ── GET /suppliers/:id/recurring - main recurring billing dashboard ───────────
router.get("/suppliers/:id/recurring", requireSupplierAdmin, async (req, res) => {
  try {
    const supplier = await SupplierProfile.findById(req.params.id).lean();
    if (!supplier) return res.redirect("/zq-admin/suppliers");
    const Business         = (await import("../models/business.js")).default;
    const RecurringAccount = (await import("../models/recurringAccount.js")).default;
    const RecurringTenant  = (await import("../models/recurringTenant.js")).default;
    const RecurringInvoice = (await import("../models/recurringInvoice.js")).default;
    const RecurringPayment = (await import("../models/recurringPayment.js")).default;

    const biz = supplier.businessId ? await Business.findById(supplier.businessId).lean() : null;
    if (!biz) return res.send(layout(`Recurring: ${supplier.businessName}`, `<div class="alert red">No business record linked to this supplier.</div>`));

    const [accounts, recentPayments] = await Promise.all([
      RecurringAccount.find({ businessId: biz._id }).sort({ isActive: -1, name: 1 }).lean(),
      RecurringPayment.find({ businessId: biz._id }).sort({ date: -1 }).limit(10).lean()
    ]);

    // Attach tenant and latest invoice to each account
    for (const acct of accounts) {
      acct._tenants = await RecurringTenant.find({ accountId: acct._id, isActive: true }).lean();
      acct._tenant  = acct._tenants[0] || null;
      acct._invoice = await RecurringInvoice.findOne({ accountId: acct._id, status: { $in: ["unpaid","partial","overdue"] } })
        .sort({ periodStart: -1 }).lean();
    }

    const totalAccounts  = accounts.length;
    const activeAccounts = accounts.filter(a => a.isActive).length;
    const vacantAccounts = accounts.filter(a => a.isVacant).length;
    const cur = biz.currency || "USD";
    const totalOutstanding = accounts.reduce((s, a) => s + (a.currentBalance || 0), 0);

    const errMsg     = req.query.error   ? `<div class="alert red">❌ ${esc(req.query.error)}</div>`   : "";
    const successMsg = req.query.success ? `<div class="alert green">✅ ${esc(req.query.success)}</div>` : "";

    const accountRows = accounts.map(acct => {
      const statusColor = acct.isActive ? (acct.currentBalance > 0 ? "red" : "green") : "gray";
      const statusLabel = !acct.isActive ? "Inactive" : acct.currentBalance > 0 ? "Outstanding" : "Clear";
      return `
        <tr>
          <td><strong>${esc(acct.name)}</strong>${acct.ref ? ` <small style="color:var(--muted)">(${esc(acct.ref)})</small>` : ""}<br>
              <small style="color:var(--muted)">${esc(acct.description || acct.category)}</small></td>
          <td>${acct._tenant ? esc(acct._tenant.name) + (acct._tenants.length > 1 ? ` <small style="color:var(--blue);font-weight:600">+${acct._tenants.length - 1} more</small>` : "") : '<span style="color:var(--muted)">Vacant</span>'}<br>
              <small style="color:var(--muted)">${acct._tenant?.phone ? esc(acct._tenant.phone) : ""}</small></td>
          <td>${acct.billingAmount} ${cur}/${acct.billingCycle}</td>
          <td><strong style="color:${acct.currentBalance > 0 ? "var(--red)" : "var(--green)"}">${(acct.currentBalance || 0).toFixed(2)} ${cur}</strong></td>
          <td>${acct._invoice ? `<small>${esc(acct._invoice.number)} · ${esc(acct._invoice.period)}</small>` : '<span style="color:var(--muted)">-</span>'}</td>
          <td>${badge(statusLabel, statusColor)}</td>
          <td style="display:flex;gap:6px;flex-wrap:wrap">
            <a href="/zq-admin/suppliers/${supplier._id}/recurring/${acct._id}/edit"
               style="background:#e0f2fe;color:#0369a1;border:none;padding:4px 10px;border-radius:6px;font-size:12px;text-decoration:none">✏️ Edit</a>
            <a href="/zq-admin/suppliers/${supplier._id}/recurring/${acct._id}/statement"
               style="background:#f0fdf4;color:#16a34a;border:none;padding:4px 10px;border-radius:6px;font-size:12px;text-decoration:none">📋 Statement</a>
            <a href="/zq-admin/suppliers/${supplier._id}/recurring/${acct._id}/tenant"
               style="background:#fef3c7;color:#92400e;border:none;padding:4px 10px;border-radius:6px;font-size:12px;text-decoration:none">👤 Tenant</a>
            <a href="/zq-admin/suppliers/${supplier._id}/recurring/${acct._id}/records"
               style="background:#ede9fe;color:#5b21b6;border:none;padding:4px 10px;border-radius:6px;font-size:12px;text-decoration:none">📂 Records</a>
            <button onclick="openInvoiceModal('${acct._id}','${esc(acct.name)}')"
               style="background:#0f172a;color:white;border:none;padding:4px 10px;border-radius:6px;font-size:12px;cursor:pointer">🧾 Invoice</button>
            <button onclick="openPaymentModal('${acct._id}','${esc(acct.name)}')"
               style="background:#7c3aed;color:white;border:none;padding:4px 10px;border-radius:6px;font-size:12px;cursor:pointer">💰 Pay</button>
            <form method="POST" action="/zq-admin/suppliers/${supplier._id}/recurring/${acct._id}/delete" style="display:inline"
                  onsubmit="return confirm('Deactivate ${esc(acct.name)}?')">
              <button style="background:#fee2e2;color:#dc2626;border:none;padding:4px 10px;border-radius:6px;font-size:12px;cursor:pointer">⏸ Deactivate</button>
            </form>
            <button onclick="openDeleteModal('${acct._id}','${esc(acct.name)}')"
               style="background:#7f1d1d;color:white;border:none;padding:4px 10px;border-radius:6px;font-size:12px;cursor:pointer">🗑 Delete Permanently</button>
          </td>
        </tr>`;
    }).join("");

    const content = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px">
        <div>
          <h2 style="font-size:20px;font-weight:700">🏠 Recurring Billing</h2>
          <div style="color:var(--muted);font-size:13px">${esc(biz.name)}</div>
        </div>
        <div style="display:flex;gap:10px">
          <a href="/zq-admin/suppliers/${supplier._id}/recurring/new-account"
             style="background:var(--blue);color:white;padding:9px 16px;border-radius:8px;text-decoration:none;font-size:13px;font-weight:600">
            ➕ Add Account / Unit
          </a>
          <form method="POST" action="/zq-admin/suppliers/${supplier._id}/recurring/bulk-generate" style="display:inline">
            <button style="background:#16a34a;color:white;padding:9px 16px;border-radius:8px;border:none;font-size:13px;font-weight:600;cursor:pointer">
              📄 Generate This Month's Invoices
            </button>
          </form>
          <form method="POST" action="/zq-admin/suppliers/${supplier._id}/recurring/send-reminders" style="display:inline">
            <button style="background:#ea580c;color:white;padding:9px 16px;border-radius:8px;border:none;font-size:13px;font-weight:600;cursor:pointer">
              📢 Send Reminders
            </button>
          </form>
        </div>
      </div>

      ${errMsg}${successMsg}

      <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:24px">
        ${stat(totalAccounts,   "Total Accounts", "")}
        ${stat(activeAccounts,  "Active",         "green")}
        ${stat(vacantAccounts,  "Vacant",         "yellow")}
        ${stat(`${totalOutstanding.toFixed(2)} ${cur}`, "Total Outstanding", totalOutstanding > 0 ? "red" : "")}
      </div>

      <div class="card">
        <div style="font-weight:700;margin-bottom:14px">Accounts / Units</div>
        ${accounts.length ? `
        <table style="width:100%;border-collapse:collapse;font-size:13px">
          <thead>
            <tr style="background:#f8fafc;border-bottom:2px solid var(--border)">
              <th style="padding:10px 12px;text-align:left">Account / Unit</th>
              <th style="padding:10px 12px;text-align:left">Tenant</th>
              <th style="padding:10px 12px;text-align:left">Charge</th>
              <th style="padding:10px 12px;text-align:left">Balance</th>
              <th style="padding:10px 12px;text-align:left">Latest Invoice</th>
              <th style="padding:10px 12px;text-align:left">Status</th>
              <th style="padding:10px 12px;text-align:left">Actions</th>
            </tr>
          </thead>
          <tbody>${accountRows}</tbody>
        </table>` : `<p style="color:var(--muted);padding:12px">No accounts yet. Click "Add Account / Unit" to get started.</p>`}
      </div>`;

    // Payment modal - inline quick-payment form rendered client-side
    const paymentModal = `
      <div id="payModal" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:1000;align-items:center;justify-content:center">
        <div style="background:white;border-radius:12px;padding:28px;width:400px;max-width:95vw">
          <h3 style="font-size:16px;font-weight:700;margin-bottom:16px">💰 Record Payment</h3>
          <div id="payAcctName" style="font-weight:600;color:var(--muted);margin-bottom:14px;font-size:13px"></div>
          <form id="payForm" method="POST">
            <div style="margin-bottom:12px">
              <label style="font-weight:600;display:block;margin-bottom:4px;font-size:13px">Amount *</label>
              <input name="amount" type="number" step="0.01" required placeholder="300.00"
                style="width:100%;padding:9px 12px;border:1px solid var(--border);border-radius:7px;font-size:14px">
            </div>
            <div style="margin-bottom:12px">
              <label style="font-weight:600;display:block;margin-bottom:4px;font-size:13px">Method</label>
              <select name="method" style="width:100%;padding:9px 12px;border:1px solid var(--border);border-radius:7px;font-size:14px">
                <option value="cash">💵 Cash</option>
                <option value="ecocash">📱 EcoCash</option>
                <option value="bank">🏦 Bank Transfer</option>
                <option value="innbucks">💳 InnBucks</option>
                <option value="zipit">🔄 ZipIt</option>
                <option value="other">Other</option>
              </select>
            </div>
            <div style="margin-bottom:16px">
              <label style="font-weight:600;display:block;margin-bottom:4px;font-size:13px">Reference (optional)</label>
              <input name="reference" placeholder="EcoCash transaction ref"
                style="width:100%;padding:9px 12px;border:1px solid var(--border);border-radius:7px;font-size:14px">
            </div>
            <div style="display:flex;gap:10px">
              <button type="submit" style="background:var(--blue);color:white;padding:10px 20px;border:none;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer;flex:1">
                ✅ Record Payment
              </button>
              <button type="button" onclick="document.getElementById('payModal').style.display='none'"
                style="background:#f1f5f9;color:var(--text);padding:10px 20px;border:none;border-radius:8px;font-size:14px;cursor:pointer">
                Cancel
              </button>
            </div>
          </form>
        </div>
      </div>
      <script>
        function openPaymentModal(acctId, acctName) {
          document.getElementById('payAcctName').textContent = '🏠 ' + acctName;
          document.getElementById('payForm').action = '/zq-admin/suppliers/${supplier._id}/recurring/' + acctId + '/record-payment';
          document.getElementById('payModal').style.display = 'flex';
        }
        document.getElementById('payModal')?.addEventListener('click', function(e) {
          if (e.target === this) this.style.display = 'none';
        });
      </script>`;

    // Permanent delete modal - requires retyping the account name to confirm
    const deleteModal = `
      <div id="delModal" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:1000;align-items:center;justify-content:center">
        <div style="background:white;border-radius:12px;padding:28px;width:420px;max-width:95vw">
          <h3 style="font-size:16px;font-weight:700;margin-bottom:8px;color:#7f1d1d">🗑 Permanently Delete Account</h3>
          <p style="font-size:13px;color:var(--muted);margin-bottom:14px">
            This deletes <strong id="delAcctName"></strong> and ALL its tenants, invoices, payments, and expenses.
            This cannot be undone. Type the account name below to confirm.
          </p>
          <form id="delForm" method="POST">
            <input name="confirmName" id="delConfirmInput" required placeholder="Type account name exactly"
              style="width:100%;padding:9px 12px;border:1px solid var(--border);border-radius:7px;font-size:14px;margin-bottom:16px">
            <div style="display:flex;gap:10px">
              <button type="submit" style="background:#7f1d1d;color:white;padding:10px 20px;border:none;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer;flex:1">
                Permanently Delete
              </button>
              <button type="button" onclick="document.getElementById('delModal').style.display='none'"
                style="background:#f1f5f9;color:var(--text);padding:10px 20px;border:none;border-radius:8px;font-size:14px;cursor:pointer">
                Cancel
              </button>
            </div>
          </form>
        </div>
      </div>
      <script>
        function openDeleteModal(acctId, acctName) {
          document.getElementById('delAcctName').textContent = acctName;
          document.getElementById('delConfirmInput').value = '';
          document.getElementById('delForm').action = '/zq-admin/suppliers/${supplier._id}/recurring/' + acctId + '/permanently-delete';
          document.getElementById('delModal').style.display = 'flex';
        }
        document.getElementById('delModal')?.addEventListener('click', function(e) {
          if (e.target === this) this.style.display = 'none';
        });
      </script>`;

    // Invoice-now modal - manual ad-hoc invoicing for a single account
    // (vacant or single-tenant only - multi-tenant accounts get redirected
    // by the server to invoice each tenant individually).
    const invoiceModal = `
      <div id="invModal" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:1000;align-items:center;justify-content:center">
        <div style="background:white;border-radius:12px;padding:28px;width:420px;max-width:95vw">
          <h3 style="font-size:16px;font-weight:700;margin-bottom:8px">🧾 Invoice Now</h3>
          <div id="invAcctName" style="font-weight:600;color:var(--muted);margin-bottom:14px;font-size:13px"></div>
          <p style="font-size:12px;color:var(--muted);margin-bottom:14px">
            Leave fields blank to use the account's normal billing amount, cycle and due day.
            If this account has more than one tenant, you'll be told to invoice them individually instead.
          </p>
          <form id="invForm" method="POST">
            <div style="margin-bottom:12px">
              <label style="font-weight:600;display:block;margin-bottom:4px;font-size:13px">Amount Override (optional)</label>
              <input name="amount" type="number" step="0.01" placeholder="Leave blank to use default"
                style="width:100%;padding:9px 12px;border:1px solid var(--border);border-radius:7px;font-size:14px">
            </div>
            <div style="margin-bottom:12px">
              <label style="font-weight:600;display:block;margin-bottom:4px;font-size:13px">Period Label (optional)</label>
              <input name="periodLabel" placeholder="e.g. June 2026"
                style="width:100%;padding:9px 12px;border:1px solid var(--border);border-radius:7px;font-size:14px">
            </div>
            <div style="margin-bottom:14px">
              <label style="font-weight:600;display:block;margin-bottom:4px;font-size:13px">Due Date (optional)</label>
              <input name="dueDate" type="date"
                style="width:100%;padding:9px 12px;border:1px solid var(--border);border-radius:7px;font-size:14px">
            </div>
            <label style="display:flex;align-items:center;gap:8px;cursor:pointer;margin-bottom:16px">
              <input type="checkbox" name="force" value="1" style="width:16px;height:16px">
              <span style="font-weight:600;font-size:13px">Force - raise an extra invoice even if already invoiced this period</span>
            </label>
            <div style="display:flex;gap:10px">
              <button type="submit" style="background:#0f172a;color:white;padding:10px 20px;border:none;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer;flex:1">
                🧾 Raise Invoice
              </button>
              <button type="button" onclick="document.getElementById('invModal').style.display='none'"
                style="background:#f1f5f9;color:var(--text);padding:10px 20px;border:none;border-radius:8px;font-size:14px;cursor:pointer">
                Cancel
              </button>
            </div>
          </form>
        </div>
      </div>
      <script>
        function openInvoiceModal(acctId, acctName) {
          document.getElementById('invAcctName').textContent = '🏠 ' + acctName;
          document.getElementById('invForm').action = '/zq-admin/suppliers/${supplier._id}/recurring/' + acctId + '/invoice-now';
          document.getElementById('invModal').style.display = 'flex';
        }
        document.getElementById('invModal')?.addEventListener('click', function(e) {
          if (e.target === this) this.style.display = 'none';
        });
      </script>`;

    res.send(layout(`Recurring: ${biz.name}`, content + paymentModal + deleteModal + invoiceModal));
  } catch (e) {
    res.send(layout("Recurring Billing", `<div class="alert red">Error: ${e.message}</div>`));
  }
});

// ── GET /suppliers/:id/recurring/new-account ─────────────────────────────────
router.get("/suppliers/:id/recurring/new-account", requireSupplierAdmin, async (req, res) => {
  try {
    const supplier = await SupplierProfile.findById(req.params.id).lean();
    if (!supplier) return res.redirect("/zq-admin/suppliers");
    const Business = (await import("../models/business.js")).default;
    const Branch   = (await import("../models/branch.js")).default;
    const biz = supplier.businessId ? await Business.findById(supplier.businessId).lean() : null;
    if (!biz) return res.redirect(`/zq-admin/suppliers/${supplier._id}/recurring`);
    const branches = await Branch.find({ businessId: biz._id }).lean();

    const content = `
      <h2 style="font-size:20px;font-weight:700;margin-bottom:20px">➕ Add Account / Unit</h2>
      <div class="card" style="max-width:600px">
        <form method="POST" action="/zq-admin/suppliers/${supplier._id}/recurring/new-account">
          <div style="margin-bottom:14px">
            <label style="font-weight:600;display:block;margin-bottom:6px">Account / Unit Name *</label>
            <input name="name" required placeholder="e.g. Flat 3A, Room 12, John Moyo"
              style="width:100%;padding:9px 12px;border:1px solid var(--border);border-radius:7px;font-size:14px">
            <div style="color:var(--muted);font-size:11px;margin-top:4px">This is the name that appears on all statements and invoices</div>
          </div>
          <div style="margin-bottom:14px">
            <label style="font-weight:600;display:block;margin-bottom:6px">Short Reference Code</label>
            <input name="ref" placeholder="e.g. F3A, R12"
              style="width:100%;padding:9px 12px;border:1px solid var(--border);border-radius:7px;font-size:14px">
          </div>
          <div style="margin-bottom:14px">
            <label style="font-weight:600;display:block;margin-bottom:6px">Category</label>
            <select name="category" style="width:100%;padding:9px 12px;border:1px solid var(--border);border-radius:7px;font-size:14px">
              <option value="unit">Unit</option>
              <option value="flat">Flat</option>
              <option value="room">Room</option>
              <option value="student">Student</option>
              <option value="policy">Policy</option>
              <option value="member">Member</option>
              <option value="plot">Plot</option>
              <option value="other">Other</option>
            </select>
          </div>
          <div style="margin-bottom:14px">
            <label style="font-weight:600;display:block;margin-bottom:6px">Description / Notes</label>
            <input name="description" placeholder="e.g. 2-bedroom flat, Ground floor"
              style="width:100%;padding:9px 12px;border:1px solid var(--border);border-radius:7px;font-size:14px">
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:14px">
            <div>
              <label style="font-weight:600;display:block;margin-bottom:6px">Monthly / Recurring Charge *</label>
              <input name="billingAmount" type="number" step="0.01" required placeholder="300.00"
                style="width:100%;padding:9px 12px;border:1px solid var(--border);border-radius:7px;font-size:14px">
            </div>
            <div>
              <label style="font-weight:600;display:block;margin-bottom:6px">Billing Cycle *</label>
              <select name="billingCycle" style="width:100%;padding:9px 12px;border:1px solid var(--border);border-radius:7px;font-size:14px">
                <option value="monthly">Monthly</option>
                <option value="quarterly">Quarterly</option>
                <option value="termly">Termly</option>
                <option value="annual">Annual</option>
              </select>
            </div>
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:14px">
            <div>
              <label style="font-weight:600;display:block;margin-bottom:6px">Billing Day (day of month)</label>
              <input name="billingDay" type="number" min="1" max="28" value="1"
                style="width:100%;padding:9px 12px;border:1px solid var(--border);border-radius:7px;font-size:14px">
            </div>
            <div>
              <label style="font-weight:600;display:block;margin-bottom:6px">Branch</label>
              <select name="branchId" style="width:100%;padding:9px 12px;border:1px solid var(--border);border-radius:7px;font-size:14px">
                <option value="">- No branch -</option>
                ${branches.map(b => `<option value="${b._id}">${esc(b.name)}</option>`).join("")}
              </select>
            </div>
          </div>
          <div style="display:flex;gap:10px;margin-top:20px">
            <button type="submit" style="background:var(--blue);color:white;padding:10px 20px;border:none;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer">
              ✅ Save Account
            </button>
            <a href="/zq-admin/suppliers/${supplier._id}/recurring"
               style="background:#f1f5f9;color:var(--text);padding:10px 20px;border-radius:8px;font-size:14px;text-decoration:none">
              Cancel
            </a>
          </div>
        </form>
      </div>`;

    res.send(layout(`Recurring: ${biz.name}`, content));
  } catch (e) {
    res.redirect(`/zq-admin/suppliers/${req.params.id}/recurring?error=${encodeURIComponent(e.message)}`);
  }
});

// ── POST /suppliers/:id/recurring/new-account ─────────────────────────────────
router.post("/suppliers/:id/recurring/new-account", requireSupplierAdmin, async (req, res) => {
  try {
    const supplier = await SupplierProfile.findById(req.params.id).lean();
    const Business         = (await import("../models/business.js")).default;
    const RecurringAccount = (await import("../models/recurringAccount.js")).default;
    const biz = supplier?.businessId ? await Business.findById(supplier.businessId).lean() : null;
    if (!biz) return res.redirect(`/zq-admin/suppliers/${req.params.id}/recurring`);

    const { name, ref, category, description, billingAmount, billingCycle, billingDay, branchId } = req.body;
    await RecurringAccount.create({
      businessId:    biz._id,
      branchId:      branchId || null,
      name:          name.trim(),
      ref:           (ref || "").trim(),
      category:      category || "unit",
      description:   (description || "").trim(),
      billingAmount: parseFloat(billingAmount) || 0,
      billingCycle:  billingCycle || "monthly",
      billingDay:    parseInt(billingDay, 10) || 1,
      currency:      biz.currency || "USD",
      isActive:      true
    });

    res.redirect(`/zq-admin/suppliers/${req.params.id}/recurring?success=${encodeURIComponent(`Account "${name}" created`)}`);
  } catch (e) {
    res.redirect(`/zq-admin/suppliers/${req.params.id}/recurring?error=${encodeURIComponent(e.message)}`);
  }
});

// ── GET /suppliers/:id/recurring/:acctId/tenant - manage tenant ──────────────
router.get("/suppliers/:id/recurring/:acctId/tenant", requireSupplierAdmin, async (req, res) => {
  try {
    const supplier = await SupplierProfile.findById(req.params.id).lean();
    const Business         = (await import("../models/business.js")).default;
    const RecurringAccount = (await import("../models/recurringAccount.js")).default;
    const RecurringTenant  = (await import("../models/recurringTenant.js")).default;
    const biz = supplier?.businessId ? await Business.findById(supplier.businessId).lean() : null;
    const acct = await RecurringAccount.findById(req.params.acctId).lean();
    if (!acct || !biz) return res.redirect(`/zq-admin/suppliers/${req.params.id}/recurring`);

    const tenants = await RecurringTenant.find({ accountId: acct._id }).lean();
    const errMsg     = req.query.error   ? `<div class="alert red">❌ ${esc(req.query.error)}</div>`   : "";
    const successMsg = req.query.success ? `<div class="alert green">✅ ${esc(req.query.success)}</div>` : "";

    const cycleOptsBlank = [["", "- Use account default -"], ["monthly","Monthly"], ["quarterly","Quarterly"], ["termly","Termly"], ["annual","Annual"]]
      .map(([v,l]) => `<option value="${v}">${l}</option>`).join("");

    const tenantRows = tenants.map(t => {
      const hasOverride = t.billingAmount != null;
      const effAmount   = hasOverride ? t.billingAmount : acct.billingAmount;
      const effCycle    = t.billingCycle || acct.billingCycle;
      return `
      <tr>
        <td><strong>${esc(t.name)}</strong></td>
        <td>${esc(t.phone || "-")}</td>
        <td>${esc(t.email || "-")}</td>
        <td style="text-align:right;font-weight:600">
          ${(effAmount||0).toFixed(2)} ${acct.currency || "USD"} <small style="color:var(--muted)">/${effCycle}</small>
          ${hasOverride ? `<div style="font-weight:400">${badge("Custom rate","blue")}</div>` : ""}
        </td>
          <td style="text-align:right;font-weight:600;color:${(t.openingBalance||0) > 0 ? "var(--red)" : (t.openingBalance||0) < 0 ? "var(--green)" : "var(--muted)"}">
            ${(t.openingBalance||0) !== 0 ? (t.openingBalance||0).toFixed(2) : "—"}
            ${t.openingBalanceDate ? `<div style="font-weight:400;color:var(--muted);font-size:10px">as at ${new Date(t.openingBalanceDate).toLocaleDateString("en-GB")}</div>` : ""}
          </td>
          <td>${t.canSelfServe ? badge("Self-serve","green") : badge("Staff only","gray")}</td>
        <td>${t.isActive ? badge("Active","green") : badge("Inactive","red")}</td>
        <td style="display:flex;gap:6px;flex-wrap:wrap">
          <form method="POST" action="/zq-admin/suppliers/${supplier._id}/recurring/${acct._id}/tenant/${t._id}/toggle">
            <button style="background:#fef3c7;color:#92400e;border:none;padding:4px 10px;border-radius:6px;font-size:12px;cursor:pointer">
              ${t.isActive ? "⏸ Deactivate" : "▶ Activate"}
            </button>
          </form>
          <form method="POST" action="/zq-admin/suppliers/${supplier._id}/recurring/${acct._id}/tenant/${t._id}/toggle-selfserve">
            <button style="background:#e0f2fe;color:#0369a1;border:none;padding:4px 10px;border-radius:6px;font-size:12px;cursor:pointer">
              ${t.canSelfServe ? "🔒 Disable Self-serve" : "🔓 Enable Self-serve"}
            </button>
          </form>
          <button onclick="openTenantInvoiceModal('${t._id}','${esc(t.name)}')"
             style="background:#0f172a;color:white;border:none;padding:4px 10px;border-radius:6px;font-size:12px;cursor:pointer">🧾 Invoice</button>
          <button onclick="openTenantPayModal('${t._id}','${esc(t.name)}')"
             style="background:#7c3aed;color:white;border:none;padding:4px 10px;border-radius:6px;font-size:12px;cursor:pointer">💰 Pay</button>
          <a href="/zq-admin/suppliers/${supplier._id}/recurring/${acct._id}/tenant/${t._id}/statement"
             style="background:#f0fdf4;color:#16a34a;border:none;padding:4px 10px;border-radius:6px;font-size:12px;text-decoration:none">📋 Statement</a>
          <a href="/zq-admin/suppliers/${supplier._id}/recurring/${acct._id}/tenant/${t._id}/edit"
             style="background:#ede9fe;color:#5b21b6;border:none;padding:4px 10px;border-radius:6px;font-size:12px;text-decoration:none">✏️ Edit</a>
          <form method="POST" action="/zq-admin/suppliers/${supplier._id}/recurring/${acct._id}/tenant/${t._id}/delete"
                onsubmit="return confirm('Delete tenant ${esc(t.name)}? Their invoices/payments stay on the account but become unallocated.')">
            <button style="background:#fee2e2;color:#dc2626;border:none;padding:4px 10px;border-radius:6px;font-size:12px;cursor:pointer">🗑 Delete</button>
          </form>
        </td>
      </tr>`;
    }).join("");

    const content = `
      <div style="margin-bottom:16px">
        <a href="/zq-admin/suppliers/${supplier._id}/recurring" style="color:var(--blue);text-decoration:none">← Back to Recurring Billing</a>
      </div>
      <h2 style="font-size:20px;font-weight:700;margin-bottom:4px">👤 Tenants - ${esc(acct.name)}</h2>
      <div style="color:var(--muted);margin-bottom:20px">${esc(biz.name)} · Default rate: ${(acct.billingAmount||0).toFixed(2)} ${acct.currency || "USD"}/${acct.billingCycle}</div>
      ${errMsg}${successMsg}
      ${tenants.filter(t => t.isActive).length > 1 ? `<div class="alert" style="background:#eff6ff;color:#1d4ed8;border:1px solid #bfdbfe;padding:10px 14px;border-radius:8px;margin-bottom:16px;font-size:13px">
        ℹ️ This account has ${tenants.filter(t => t.isActive).length} active tenants - each can have their own rent/cycle below ("Rate Override"), and each is invoiced and paid separately using the 🧾/💰 buttons on their row.
      </div>` : ""}
      <div class="card" style="margin-bottom:20px">
        <div style="font-weight:700;margin-bottom:14px">Add Tenant</div>
        <form method="POST" action="/zq-admin/suppliers/${supplier._id}/recurring/${acct._id}/tenant/add"
              style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px">
          <div>
            <label style="font-weight:600;display:block;margin-bottom:4px;font-size:12px">Name *</label>
            <input name="name" required placeholder="John Moyo"
              style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:7px;font-size:13px">
          </div>
          <div>
            <label style="font-weight:600;display:block;margin-bottom:4px;font-size:12px">Phone (for WhatsApp)</label>
            <input name="phone" placeholder="263771234567"
              style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:7px;font-size:13px">
          </div>
          <div>
            <label style="font-weight:600;display:block;margin-bottom:4px;font-size:12px">Move-in Date</label>
            <input name="startDate" type="date"
              style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:7px;font-size:13px">
          </div>
          <div>
            <label style="font-weight:600;display:block;margin-bottom:4px;font-size:12px">Opening Balance</label>
            <input name="openingBalance" type="number" step="0.01" placeholder="0.00"
              style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:7px;font-size:13px">
            <div style="color:var(--muted);font-size:10px;margin-top:2px">Arrears before system setup</div>
          </div>
          <div>
            <label style="font-weight:600;display:block;margin-bottom:4px;font-size:12px">Balance As At</label>
            <input name="openingBalanceDate" type="date"
              style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:7px;font-size:13px">
          </div>
          <div></div>
          <div style="grid-column:1/4;border-top:1px solid var(--border);margin-top:4px;padding-top:12px">
            <div style="font-weight:600;font-size:13px;margin-bottom:2px">Rate Override <span style="font-weight:400;color:var(--muted);font-size:11px">(only needed when this tenant pays a different rent than the account default - e.g. several rooms sharing one "Building" account)</span></div>
          </div>
          <div>
            <label style="font-weight:600;display:block;margin-bottom:4px;font-size:12px">Custom Amount</label>
            <input name="billingAmount" type="number" step="0.01" placeholder="Leave blank to use account default (${acct.billingAmount||0})"
              style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:7px;font-size:13px">
          </div>
          <div>
            <label style="font-weight:600;display:block;margin-bottom:4px;font-size:12px">Custom Cycle</label>
            <select name="billingCycle" style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:7px;font-size:13px">${cycleOptsBlank}</select>
          </div>
          <div>
            <label style="font-weight:600;display:block;margin-bottom:4px;font-size:12px">Invoice Line Label</label>
            <input name="billingDescription" placeholder="e.g. Room 2 Rent"
              style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:7px;font-size:13px">
          </div>
          <div style="grid-column:1/4">
            <button type="submit" style="background:var(--blue);color:white;padding:9px 16px;border:none;border-radius:7px;font-size:13px;font-weight:600;cursor:pointer;white-space:nowrap">
              ✅ Add Tenant
            </button>
          </div>
        </form>
      </div>
      <div class="card">
        <div style="font-weight:700;margin-bottom:14px">Current Tenants</div>
        ${tenants.length ? `
        <table style="width:100%;border-collapse:collapse;font-size:13px">
          <thead><tr style="background:#f8fafc;border-bottom:2px solid var(--border)">
            <th style="padding:10px 12px;text-align:left">Name</th>
            <th style="padding:10px 12px;text-align:left">Phone</th>
            <th style="padding:10px 12px;text-align:left">Email</th>
            <th style="padding:10px 12px;text-align:right">Rent / Cycle</th>
            <th style="padding:10px 12px;text-align:right">Opening Bal</th>
            <th style="padding:10px 12px;text-align:left">Self-serve</th>
            <th style="padding:10px 12px;text-align:left">Status</th>
            <th style="padding:10px 12px;text-align:left">Actions</th>
          </tr></thead>
          <tbody>${tenantRows}</tbody>
        </table>` : `<p style="color:var(--muted)">No tenants yet.</p>`}
      </div>`;

    // Per-tenant Invoice and Payment modals
    const tenantModals = `
      <div id="tInvModal" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:1000;align-items:center;justify-content:center">
        <div style="background:white;border-radius:12px;padding:28px;width:420px;max-width:95vw">
          <h3 style="font-size:16px;font-weight:700;margin-bottom:8px">🧾 Invoice Tenant</h3>
          <div id="tInvName" style="font-weight:600;color:var(--muted);margin-bottom:14px;font-size:13px"></div>
          <p style="font-size:12px;color:var(--muted);margin-bottom:14px">Leave fields blank to use this tenant's normal rate, cycle and due day.</p>
          <form id="tInvForm" method="POST">
            <div style="margin-bottom:12px">
              <label style="font-weight:600;display:block;margin-bottom:4px;font-size:13px">Amount Override</label>
              <input name="amount" type="number" step="0.01" placeholder="Leave blank for default"
                style="width:100%;padding:9px 12px;border:1px solid var(--border);border-radius:7px;font-size:14px">
            </div>
            <div style="margin-bottom:12px">
              <label style="font-weight:600;display:block;margin-bottom:4px;font-size:13px">Period Label</label>
              <input name="periodLabel" placeholder="e.g. June 2026"
                style="width:100%;padding:9px 12px;border:1px solid var(--border);border-radius:7px;font-size:14px">
            </div>
            <div style="margin-bottom:14px">
              <label style="font-weight:600;display:block;margin-bottom:4px;font-size:13px">Due Date</label>
              <input name="dueDate" type="date"
                style="width:100%;padding:9px 12px;border:1px solid var(--border);border-radius:7px;font-size:14px">
            </div>
            <label style="display:flex;align-items:center;gap:8px;cursor:pointer;margin-bottom:16px">
              <input type="checkbox" name="force" value="1" style="width:16px;height:16px">
              <span style="font-weight:600;font-size:13px">Force - raise an extra invoice even if already invoiced this period</span>
            </label>
            <div style="display:flex;gap:10px">
              <button type="submit" style="background:#0f172a;color:white;padding:10px 20px;border:none;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer;flex:1">
                🧾 Raise Invoice
              </button>
              <button type="button" onclick="document.getElementById('tInvModal').style.display='none'"
                style="background:#f1f5f9;color:var(--text);padding:10px 20px;border:none;border-radius:8px;font-size:14px;cursor:pointer">Cancel</button>
            </div>
          </form>
        </div>
      </div>
      <div id="tPayModal" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:1000;align-items:center;justify-content:center">
        <div style="background:white;border-radius:12px;padding:28px;width:400px;max-width:95vw">
          <h3 style="font-size:16px;font-weight:700;margin-bottom:16px">💰 Record Payment</h3>
          <div id="tPayName" style="font-weight:600;color:var(--muted);margin-bottom:14px;font-size:13px"></div>
          <form id="tPayForm" method="POST">
            <div style="margin-bottom:12px">
              <label style="font-weight:600;display:block;margin-bottom:4px;font-size:13px">Amount *</label>
              <input name="amount" type="number" step="0.01" required placeholder="300.00"
                style="width:100%;padding:9px 12px;border:1px solid var(--border);border-radius:7px;font-size:14px">
            </div>
            <div style="margin-bottom:12px">
              <label style="font-weight:600;display:block;margin-bottom:4px;font-size:13px">Method</label>
              <select name="method" style="width:100%;padding:9px 12px;border:1px solid var(--border);border-radius:7px;font-size:14px">
                <option value="cash">💵 Cash</option>
                <option value="ecocash">📱 EcoCash</option>
                <option value="bank">🏦 Bank Transfer</option>
                <option value="innbucks">💳 InnBucks</option>
                <option value="zipit">🔄 ZipIt</option>
                <option value="other">Other</option>
              </select>
            </div>
            <div style="margin-bottom:16px">
              <label style="font-weight:600;display:block;margin-bottom:4px;font-size:13px">Reference (optional)</label>
              <input name="reference" placeholder="EcoCash transaction ref"
                style="width:100%;padding:9px 12px;border:1px solid var(--border);border-radius:7px;font-size:14px">
            </div>
            <div style="display:flex;gap:10px">
              <button type="submit" style="background:var(--blue);color:white;padding:10px 20px;border:none;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer;flex:1">
                ✅ Record Payment
              </button>
              <button type="button" onclick="document.getElementById('tPayModal').style.display='none'"
                style="background:#f1f5f9;color:var(--text);padding:10px 20px;border:none;border-radius:8px;font-size:14px;cursor:pointer">Cancel</button>
            </div>
          </form>
        </div>
      </div>
      <script>
        function openTenantInvoiceModal(tid, tname) {
          document.getElementById('tInvName').textContent = '👤 ' + tname;
          document.getElementById('tInvForm').action = '/zq-admin/suppliers/${supplier._id}/recurring/${acct._id}/tenant/' + tid + '/invoice-now';
          document.getElementById('tInvModal').style.display = 'flex';
        }
        document.getElementById('tInvModal')?.addEventListener('click', function(e) { if (e.target === this) this.style.display = 'none'; });
        function openTenantPayModal(tid, tname) {
          document.getElementById('tPayName').textContent = '👤 ' + tname;
          document.getElementById('tPayForm').action = '/zq-admin/suppliers/${supplier._id}/recurring/${acct._id}/tenant/' + tid + '/record-payment';
          document.getElementById('tPayModal').style.display = 'flex';
        }
        document.getElementById('tPayModal')?.addEventListener('click', function(e) { if (e.target === this) this.style.display = 'none'; });
      </script>`;

    res.send(layout(`Recurring: ${acct.name}`, content + tenantModals));
  } catch (e) {
    res.redirect(`/zq-admin/suppliers/${req.params.id}/recurring?error=${encodeURIComponent(e.message)}`);
  }
});

// ── POST add tenant ───────────────────────────────────────────────────────────
router.post("/suppliers/:id/recurring/:acctId/tenant/add", requireSupplierAdmin, async (req, res) => {
  try {
    const supplier = await SupplierProfile.findById(req.params.id).lean();
    const Business        = (await import("../models/business.js")).default;
    const RecurringTenant = (await import("../models/recurringTenant.js")).default;
    const biz = supplier?.businessId ? await Business.findById(supplier.businessId).lean() : null;
    if (!biz) return res.redirect(`/zq-admin/suppliers/${req.params.id}/recurring`);

    const { name, phone, startDate, openingBalance, openingBalanceDate, billingAmount, billingCycle, billingDescription } = req.body;
    let p = (phone || "").replace(/\D/g, "");
    if (p.startsWith("0")) p = "263" + p.slice(1);

    await RecurringTenant.create({
      businessId:          biz._id,
      accountId:           req.params.acctId,
      name:                name.trim(),
      phone:               p,
      startDate:           startDate ? new Date(startDate) : null,
      isActive:            true,
      canSelfServe:        false,
      notificationsEnabled: true,
      openingBalance:      parseFloat(openingBalance) || 0,
      openingBalanceDate:  openingBalanceDate ? new Date(openingBalanceDate) : null,
      // Blank = inherit the account's billing settings (most tenants).
      billingAmount:       billingAmount !== "" && billingAmount != null ? parseFloat(billingAmount) : null,
      billingCycle:        billingCycle || null,
      billingDescription:  (billingDescription || "").trim()
    });

    res.redirect(`/zq-admin/suppliers/${req.params.id}/recurring/${req.params.acctId}/tenant?success=${encodeURIComponent(`Tenant "${name}" added`)}`);
  } catch (e) {
    res.redirect(`/zq-admin/suppliers/${req.params.id}/recurring/${req.params.acctId}/tenant?error=${encodeURIComponent(e.message)}`);
  }
});

// ── POST toggle tenant active ─────────────────────────────────────────────────
router.post("/suppliers/:id/recurring/:acctId/tenant/:tid/toggle", requireSupplierAdmin, async (req, res) => {
  try {
    const RecurringTenant = (await import("../models/recurringTenant.js")).default;
    const t = await RecurringTenant.findById(req.params.tid);
    if (t) { t.isActive = !t.isActive; await t.save(); }
    res.redirect(`/zq-admin/suppliers/${req.params.id}/recurring/${req.params.acctId}/tenant?success=Status+updated`);
  } catch (e) {
    res.redirect(`/zq-admin/suppliers/${req.params.id}/recurring/${req.params.acctId}/tenant?error=${encodeURIComponent(e.message)}`);
  }
});

// ── POST toggle tenant self-serve ─────────────────────────────────────────────
router.post("/suppliers/:id/recurring/:acctId/tenant/:tid/toggle-selfserve", requireSupplierAdmin, async (req, res) => {
  try {
    const RecurringTenant = (await import("../models/recurringTenant.js")).default;
    const t = await RecurringTenant.findById(req.params.tid);
    if (t) { t.canSelfServe = !t.canSelfServe; await t.save(); }
    res.redirect(`/zq-admin/suppliers/${req.params.id}/recurring/${req.params.acctId}/tenant?success=Self-serve+updated`);
  } catch (e) {
    res.redirect(`/zq-admin/suppliers/${req.params.id}/recurring/${req.params.acctId}/tenant?error=${encodeURIComponent(e.message)}`);
  }
});

// ── POST bulk generate invoices ───────────────────────────────────────────────
router.post("/suppliers/:id/recurring/bulk-generate", requireSupplierAdmin, async (req, res) => {
  try {
    const supplier = await SupplierProfile.findById(req.params.id).lean();
    const Business = (await import("../models/business.js")).default;
    const biz = supplier?.businessId ? await Business.findById(supplier.businessId).lean() : null;
    if (!biz) return res.redirect(`/zq-admin/suppliers/${req.params.id}/recurring`);
    const { bulkGenerateInvoices } = await import("../services/recurringBilling.js");
    const result = await bulkGenerateInvoices({ biz });
    res.redirect(`/zq-admin/suppliers/${req.params.id}/recurring?success=${encodeURIComponent(`Generated ${result.created} invoices. Skipped ${result.skipped} (already invoiced).`)}`);
  } catch (e) {
    res.redirect(`/zq-admin/suppliers/${req.params.id}/recurring?error=${encodeURIComponent(e.message)}`);
  }
});

// ── POST send payment reminders ───────────────────────────────────────────────
router.post("/suppliers/:id/recurring/send-reminders", requireSupplierAdmin, async (req, res) => {
  try {
    const supplier = await SupplierProfile.findById(req.params.id).lean();
    const Business = (await import("../models/business.js")).default;
    const biz = supplier?.businessId ? await Business.findById(supplier.businessId).lean() : null;
    if (!biz) return res.redirect(`/zq-admin/suppliers/${req.params.id}/recurring`);
    const { broadcastPaymentReminders } = await import("../services/recurringBilling.js");
    const result = await broadcastPaymentReminders({ biz });
    res.redirect(`/zq-admin/suppliers/${req.params.id}/recurring?success=${encodeURIComponent(`Sent ${result.sent} reminders. Skipped ${result.skipped} (no balance).`)}`);
  } catch (e) {
    res.redirect(`/zq-admin/suppliers/${req.params.id}/recurring?error=${encodeURIComponent(e.message)}`);
  }
});

// ── GET account statement (web view + PDF download) ───────────────────────────
router.get("/suppliers/:id/recurring/:acctId/statement", requireSupplierAdmin, async (req, res) => {
  try {
    const supplier = await SupplierProfile.findById(req.params.id).lean();
    const Business         = (await import("../models/business.js")).default;
    const RecurringAccount = (await import("../models/recurringAccount.js")).default;
    const biz  = supplier?.businessId ? await Business.findById(supplier.businessId).lean() : null;
    const acct = await RecurringAccount.findById(req.params.acctId).lean();
    if (!acct || !biz) return res.redirect(`/zq-admin/suppliers/${req.params.id}/recurring`);

    // Period: this month by default, or from query params
    const now   = new Date();
    const year  = parseInt(req.query.year  || now.getFullYear(), 10);
    const month = parseInt(req.query.month !== undefined ? req.query.month : now.getMonth(), 10);
    const periodStart = new Date(year, month, 1, 0, 0, 0, 0);
    const periodEnd   = new Date(year, month + 1, 0, 23, 59, 59, 999);
    const pl = periodStart.toLocaleDateString("en-GB", { month: "long", year: "numeric" });

    const { buildAccountStatement, generateAccountStatementPDF } = await import("../services/recurringBilling.js");
    const stmt = await buildAccountStatement({ businessId: biz._id, accountId: acct._id, periodStart, periodEnd });
    const cur  = stmt.cur;

    // If PDF requested
    if (req.query.pdf === "1") {
      const { filename, filepath } = await generateAccountStatementPDF({ biz, stmt, periodLabel: pl });
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      const { createReadStream } = await import("fs");
      createReadStream(filepath).pipe(res);
      return;
    }

    // Month selector
    const months = Array.from({ length: 12 }, (_, i) => {
      const d = new Date(now.getFullYear(), i, 1);
      return `<option value="${now.getFullYear()}_${i}" ${now.getFullYear() === year && i === month ? "selected" : ""}>
        ${d.toLocaleDateString("en-GB", { month: "long", year: "numeric" })}
      </option>`;
    }).join("");

    const rowsHtml = stmt.rows.map(r => `
      <tr>
        <td>${new Date(r.date).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}</td>
        <td>${esc(r.typeLabel || r.type)}</td>
        <td>${esc(r.description)}</td>
        <td style="text-align:right;color:${r.debit > 0 ? "var(--red)" : "var(--muted)"}">${r.debit > 0 ? r.debit.toFixed(2) : "-"}</td>
        <td style="text-align:right;color:${r.credit > 0 ? "var(--green)" : "var(--muted)"}">${r.credit > 0 ? r.credit.toFixed(2) : "-"}</td>
        <td style="text-align:right;font-weight:700;color:${r.balance > 0 ? "var(--red)" : "var(--green)"}">${r.balance.toFixed(2)} ${cur}</td>
      </tr>`).join("");

    const content = `
      <div style="margin-bottom:16px">
        <a href="/zq-admin/suppliers/${supplier._id}/recurring" style="color:var(--blue);text-decoration:none">← Back to Recurring Billing</a>
      </div>
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px">
        <div>
          <h2 style="font-size:20px;font-weight:700">📋 Account Statement - ${esc(acct.name)}</h2>
          ${stmt.tenant ? `<div style="color:var(--muted)">👤 ${esc(stmt.tenant.name)}</div>` : ""}
        </div>
        <div style="display:flex;gap:10px;align-items:center">
          <form method="GET" style="display:flex;gap:8px;align-items:center">
            <select name="period" onchange="const[y,m]=this.value.split('_');this.form.elements.year.value=y;this.form.elements.month.value=m;this.form.submit()"
              style="padding:8px 10px;border:1px solid var(--border);border-radius:7px;font-size:13px">
              ${months}
            </select>
            <input type="hidden" name="year" value="${year}">
            <input type="hidden" name="month" value="${month}">
          </form>
          <a href="?year=${year}&month=${month}&pdf=1"
             style="background:var(--blue);color:white;padding:9px 14px;border-radius:7px;text-decoration:none;font-size:13px;font-weight:600">
            📄 Download PDF
          </a>
        </div>
      </div>

      <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:20px">
        ${stat((stmt.openingBalance).toFixed(2) + " " + cur, "Opening Balance", "")}
        ${stat(stmt.totalCharged.toFixed(2) + " " + cur, "Total Charged", "red")}
        ${stat(stmt.totalPaid.toFixed(2) + " " + cur, "Total Paid", "green")}
        ${stat(stmt.closingBalance.toFixed(2) + " " + cur, "Closing Balance", stmt.closingBalance > 0 ? "red" : "")}
      </div>

      <div class="card">
        <table style="width:100%;border-collapse:collapse;font-size:13px">
          <thead><tr style="background:#0f172a;color:white">
            <th style="padding:10px 12px;text-align:left">Date</th>
            <th style="padding:10px 12px;text-align:left">Type</th>
            <th style="padding:10px 12px;text-align:left">Description</th>
            <th style="padding:10px 12px;text-align:right">Charges</th>
            <th style="padding:10px 12px;text-align:right">Payments</th>
            <th style="padding:10px 12px;text-align:right">Balance</th>
          </tr></thead>
          <tbody>
            <tr style="background:#eff6ff;font-weight:700">
              <td colspan="5" style="padding:10px 12px">Opening Balance (carried forward)</td>
              <td style="padding:10px 12px;text-align:right;color:${stmt.openingBalance > 0 ? "var(--red)" : "var(--green)"}">${stmt.openingBalance.toFixed(2)} ${cur}</td>
            </tr>
            ${rowsHtml}
            <tr style="background:#f0fdf4;font-weight:700;font-size:14px">
              <td colspan="4" style="padding:12px">CLOSING BALANCE</td>
              <td colspan="2" style="padding:12px;text-align:right;color:${stmt.closingBalance > 0 ? "var(--red)" : "var(--green)"}">${stmt.closingBalance.toFixed(2)} ${cur}</td>
            </tr>
          </tbody>
        </table>
      </div>`;

    res.send(layout(`Recurring: ${acct.name}`, content));
  } catch (e) {
    res.redirect(`/zq-admin/suppliers/${req.params.id}/recurring?error=${encodeURIComponent(e.message)}`);
  }
});


// ── POST /suppliers/:id/recurring/:acctId/permanently-delete - hard delete ──
// Deactivate (above) is reversible and keeps history. This is NOT reversible:
// it removes the account and every tenant, invoice, payment, and expense
// linked to it. Requires the admin to retype the account name to confirm.
router.post("/suppliers/:id/recurring/:acctId/permanently-delete", requireSupplierAdmin, async (req, res) => {
  try {
    const RecurringAccount = (await import("../models/recurringAccount.js")).default;
    const RecurringTenant  = (await import("../models/recurringTenant.js")).default;
    const RecurringInvoice = (await import("../models/recurringInvoice.js")).default;
    const RecurringPayment = (await import("../models/recurringPayment.js")).default;
    const RecurringExpense = (await import("../models/recurringExpense.js")).default;

    const acct = await RecurringAccount.findById(req.params.acctId).lean();
    if (!acct) return res.redirect(`/zq-admin/suppliers/${req.params.id}/recurring`);

    if ((req.body.confirmName || "").trim().toLowerCase() !== acct.name.trim().toLowerCase()) {
      return res.redirect(`/zq-admin/suppliers/${req.params.id}/recurring?error=${encodeURIComponent("Account name didn't match - nothing was deleted")}`);
    }

    await Promise.all([
      RecurringTenant.deleteMany({ accountId: acct._id }),
      RecurringInvoice.deleteMany({ accountId: acct._id }),
      RecurringPayment.deleteMany({ accountId: acct._id }),
      RecurringExpense.deleteMany({ accountId: acct._id })
    ]);
    await RecurringAccount.findByIdAndDelete(acct._id);

    res.redirect(`/zq-admin/suppliers/${req.params.id}/recurring?success=${encodeURIComponent(`"${acct.name}" and all its records were permanently deleted`)}`);
  } catch (e) {
    res.redirect(`/zq-admin/suppliers/${req.params.id}/recurring?error=${encodeURIComponent(e.message)}`);
  }
});

// ── GET /suppliers/:id/recurring/:acctId/tenant/:tid/edit - edit tenant ──────
router.get("/suppliers/:id/recurring/:acctId/tenant/:tid/edit", requireSupplierAdmin, async (req, res) => {
  try {
    const supplier = await SupplierProfile.findById(req.params.id).lean();
    const RecurringAccount = (await import("../models/recurringAccount.js")).default;
    const RecurringTenant  = (await import("../models/recurringTenant.js")).default;
    const acct   = await RecurringAccount.findById(req.params.acctId).lean();
    const tenant = await RecurringTenant.findById(req.params.tid).lean();
    if (!acct || !tenant) return res.redirect(`/zq-admin/suppliers/${req.params.id}/recurring/${req.params.acctId}/tenant`);

    const errMsg = req.query.error ? `<div class="alert red">❌ ${esc(req.query.error)}</div>` : "";

    const content = `
      <div style="margin-bottom:16px">
        <a href="/zq-admin/suppliers/${supplier._id}/recurring/${acct._id}/tenant" style="color:var(--blue);text-decoration:none">← Back to Tenants</a>
      </div>
      <h2 style="font-size:20px;font-weight:700;margin-bottom:4px">✏️ Edit Tenant - ${esc(tenant.name)}</h2>
      <div style="color:var(--muted);margin-bottom:20px">${esc(acct.name)}</div>
      ${errMsg}
      <div class="card" style="max-width:600px">
        <form method="POST" action="/zq-admin/suppliers/${supplier._id}/recurring/${acct._id}/tenant/${tenant._id}/edit">
          <div style="margin-bottom:14px">
            <label style="font-weight:600;display:block;margin-bottom:6px">Name *</label>
            <input name="name" required value="${esc(tenant.name)}"
              style="width:100%;padding:9px 12px;border:1px solid var(--border);border-radius:7px;font-size:14px">
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:14px">
            <div>
              <label style="font-weight:600;display:block;margin-bottom:6px">Phone (for WhatsApp)</label>
              <input name="phone" value="${esc(tenant.phone || "")}"
                style="width:100%;padding:9px 12px;border:1px solid var(--border);border-radius:7px;font-size:14px">
            </div>
            <div>
              <label style="font-weight:600;display:block;margin-bottom:6px">Email</label>
              <input name="email" value="${esc(tenant.email || "")}"
                style="width:100%;padding:9px 12px;border:1px solid var(--border);border-radius:7px;font-size:14px">
            </div>
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:14px">
            <div>
              <label style="font-weight:600;display:block;margin-bottom:6px">Move-in Date</label>
              <input name="startDate" type="date" value="${tenant.startDate ? new Date(tenant.startDate).toISOString().slice(0,10) : ""}"
                style="width:100%;padding:9px 12px;border:1px solid var(--border);border-radius:7px;font-size:14px">
            </div>
            <div>
              <label style="font-weight:600;display:block;margin-bottom:6px">Move-out Date</label>
              <input name="endDate" type="date" value="${tenant.endDate ? new Date(tenant.endDate).toISOString().slice(0,10) : ""}"
                style="width:100%;padding:9px 12px;border:1px solid var(--border);border-radius:7px;font-size:14px">
            </div>
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:14px">
            <div>
              <label style="font-weight:600;display:block;margin-bottom:6px">Opening Balance</label>
              <input name="openingBalance" type="number" step="0.01" value="${tenant.openingBalance || 0}"
                style="width:100%;padding:9px 12px;border:1px solid var(--border);border-radius:7px;font-size:14px">
              <div style="color:var(--muted);font-size:10px;margin-top:2px">Arrears before system setup (positive = owes, negative = credit)</div>
            </div>
            <div>
              <label style="font-weight:600;display:block;margin-bottom:6px">Balance As At</label>
              <input name="openingBalanceDate" type="date" value="${tenant.openingBalanceDate ? new Date(tenant.openingBalanceDate).toISOString().slice(0,10) : ""}"
                style="width:100%;padding:9px 12px;border:1px solid var(--border);border-radius:7px;font-size:14px">
            </div>
          </div>
          <div style="margin-bottom:14px">
            <label style="font-weight:600;display:block;margin-bottom:6px">Notes</label>
            <textarea name="notes" rows="2"
              style="width:100%;padding:9px 12px;border:1px solid var(--border);border-radius:7px;font-size:14px">${esc(tenant.notes || "")}</textarea>
          </div>
          <div style="border-top:1px solid var(--border);padding-top:14px;margin-bottom:14px">
            <div style="font-weight:600;font-size:13px;margin-bottom:8px">Rate Override <span style="font-weight:400;color:var(--muted);font-size:11px">(blank = use account's default rate of ${acct.billingAmount||0} ${acct.currency||"USD"}/${acct.billingCycle})</span></div>
            <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px">
              <div>
                <label style="font-weight:600;display:block;margin-bottom:6px;font-size:12px">Custom Amount</label>
                <input name="billingAmount" type="number" step="0.01" value="${tenant.billingAmount != null ? tenant.billingAmount : ""}" placeholder="Account default"
                  style="width:100%;padding:9px 12px;border:1px solid var(--border);border-radius:7px;font-size:14px">
              </div>
              <div>
                <label style="font-weight:600;display:block;margin-bottom:6px;font-size:12px">Custom Cycle</label>
                <select name="billingCycle" style="width:100%;padding:9px 12px;border:1px solid var(--border);border-radius:7px;font-size:14px">
                  <option value="">- Account default -</option>
                  ${["monthly","quarterly","termly","annual"].map(c => `<option value="${c}" ${tenant.billingCycle === c ? "selected" : ""}>${c.charAt(0).toUpperCase()+c.slice(1)}</option>`).join("")}
                </select>
              </div>
              <div>
                <label style="font-weight:600;display:block;margin-bottom:6px;font-size:12px">Invoice Line Label</label>
                <input name="billingDescription" value="${esc(tenant.billingDescription || "")}" placeholder="e.g. Room 2 Rent"
                  style="width:100%;padding:9px 12px;border:1px solid var(--border);border-radius:7px;font-size:14px">
              </div>
            </div>
          </div>
          <div style="display:flex;gap:18px;margin-bottom:14px">
            <label style="display:flex;align-items:center;gap:8px;cursor:pointer">
              <input type="checkbox" name="isActive" value="1" ${tenant.isActive !== false ? "checked" : ""} style="width:16px;height:16px">
              <span style="font-weight:600">Active</span>
            </label>
            <label style="display:flex;align-items:center;gap:8px;cursor:pointer">
              <input type="checkbox" name="canSelfServe" value="1" ${tenant.canSelfServe ? "checked" : ""} style="width:16px;height:16px">
              <span style="font-weight:600">Self-serve (can WhatsApp for balance)</span>
            </label>
            <label style="display:flex;align-items:center;gap:8px;cursor:pointer">
              <input type="checkbox" name="notificationsEnabled" value="1" ${tenant.notificationsEnabled !== false ? "checked" : ""} style="width:16px;height:16px">
              <span style="font-weight:600">Notifications enabled</span>
            </label>
          </div>
          <div style="display:flex;gap:10px;margin-top:20px">
            <button type="submit" style="background:var(--blue);color:white;padding:10px 20px;border:none;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer">
              ✅ Save Changes
            </button>
            <a href="/zq-admin/suppliers/${supplier._id}/recurring/${acct._id}/tenant"
               style="background:#f1f5f9;color:var(--text);padding:10px 20px;border-radius:8px;font-size:14px;text-decoration:none">
              Cancel
            </a>
          </div>
        </form>
      </div>`;

    res.send(layout(`Edit Tenant: ${tenant.name}`, content));
  } catch (e) {
    res.redirect(`/zq-admin/suppliers/${req.params.id}/recurring/${req.params.acctId}/tenant?error=${encodeURIComponent(e.message)}`);
  }
});

// ── POST /suppliers/:id/recurring/:acctId/tenant/:tid/edit - save tenant ─────
router.post("/suppliers/:id/recurring/:acctId/tenant/:tid/edit", requireSupplierAdmin, async (req, res) => {
  try {
    const RecurringTenant = (await import("../models/recurringTenant.js")).default;
    const { name, phone, email, startDate, endDate, openingBalance, openingBalanceDate, notes, isActive, canSelfServe, notificationsEnabled, billingAmount, billingCycle, billingDescription } = req.body;

    let p = (phone || "").replace(/\D/g, "");
    if (p.startsWith("0")) p = "263" + p.slice(1);

    await RecurringTenant.findByIdAndUpdate(req.params.tid, {
      name:                 (name || "").trim(),
      phone:                p,
      email:                (email || "").trim(),
      startDate:            startDate ? new Date(startDate) : null,
      endDate:              endDate ? new Date(endDate) : null,
      openingBalance:       parseFloat(openingBalance) || 0,
      openingBalanceDate:   openingBalanceDate ? new Date(openingBalanceDate) : null,
      notes:                notes || "",
      isActive:             isActive === "1",
      canSelfServe:         canSelfServe === "1",
      notificationsEnabled: notificationsEnabled === "1",
      billingAmount:        billingAmount !== "" && billingAmount != null ? parseFloat(billingAmount) : null,
      billingCycle:         billingCycle || null,
      billingDescription:   (billingDescription || "").trim()
    });

    res.redirect(`/zq-admin/suppliers/${req.params.id}/recurring/${req.params.acctId}/tenant?success=${encodeURIComponent(`Tenant "${name}" updated`)}`);
  } catch (e) {
    res.redirect(`/zq-admin/suppliers/${req.params.id}/recurring/${req.params.acctId}/tenant/${req.params.tid}/edit?error=${encodeURIComponent(e.message)}`);
  }
});

// ── POST /suppliers/:id/recurring/:acctId/tenant/:tid/delete - hard delete ───
// Removes the tenant record itself. Their invoices/payments are NOT deleted
// (that's real financial history tied to the account) - they're unlinked
// from the tenant (tenantId set to null) so the books stay intact and the
// account statement keeps showing them.
router.post("/suppliers/:id/recurring/:acctId/tenant/:tid/delete", requireSupplierAdmin, async (req, res) => {
  try {
    const RecurringTenant  = (await import("../models/recurringTenant.js")).default;
    const RecurringInvoice = (await import("../models/recurringInvoice.js")).default;
    const RecurringPayment = (await import("../models/recurringPayment.js")).default;

    const tenant = await RecurringTenant.findById(req.params.tid).lean();
    if (!tenant) return res.redirect(`/zq-admin/suppliers/${req.params.id}/recurring/${req.params.acctId}/tenant`);

    await Promise.all([
      RecurringInvoice.updateMany({ tenantId: tenant._id }, { $set: { tenantId: null } }),
      RecurringPayment.updateMany({ tenantId: tenant._id }, { $set: { tenantId: null } })
    ]);
    await RecurringTenant.findByIdAndDelete(req.params.tid);

    res.redirect(`/zq-admin/suppliers/${req.params.id}/recurring/${req.params.acctId}/tenant?success=${encodeURIComponent(`Tenant "${tenant.name}" deleted`)}`);
  } catch (e) {
    res.redirect(`/zq-admin/suppliers/${req.params.id}/recurring/${req.params.acctId}/tenant?error=${encodeURIComponent(e.message)}`);
  }
});

// ── POST /suppliers/:id/recurring/:acctId/tenant/:tid/record-payment ─────────
// Scoped to ONE tenant's own outstanding invoices - required once an account
// can have several tenants on different rentals, so a payment from Tenant A
// can never get applied to Tenant B's invoice just because it's older.
router.post("/suppliers/:id/recurring/:acctId/tenant/:tid/record-payment", requireSupplierAdmin, async (req, res) => {
  try {
    const supplier = await SupplierProfile.findById(req.params.id).lean();
    const Business = (await import("../models/business.js")).default;
    const biz = supplier?.businessId ? await Business.findById(supplier.businessId).lean() : null;
    if (!biz) return res.redirect(`/zq-admin/suppliers/${req.params.id}/recurring`);

    const { amount, method, reference, notes } = req.body;
    const { recordRecurringPayment } = await import("../services/recurringBilling.js");
    await recordRecurringPayment({
      businessId: biz._id,
      accountId:  req.params.acctId,
      tenantId:   req.params.tid,
      amount:     parseFloat(amount) || 0,
      method:     method || "cash",
      reference:  reference || "",
      notes:      notes || "",
      clerkPhone: "admin",
      date:       new Date()
    });

    res.redirect(`/zq-admin/suppliers/${req.params.id}/recurring/${req.params.acctId}/tenant?success=${encodeURIComponent("Payment recorded")}`);
  } catch (e) {
    res.redirect(`/zq-admin/suppliers/${req.params.id}/recurring/${req.params.acctId}/tenant?error=${encodeURIComponent(e.message)}`);
  }
});

// ── POST /suppliers/:id/recurring/:acctId/invoice-now - manually invoice an account ──
// Only works for vacant accounts or accounts with exactly ONE active tenant.
// Accounts with several tenants on different rentals must be invoiced per
// tenant (see the tenant/:tid/invoice-now route below) - a single account
// charge can't sensibly cover several different rents at once.
router.post("/suppliers/:id/recurring/:acctId/invoice-now", requireSupplierAdmin, async (req, res) => {
  try {
    const supplier = await SupplierProfile.findById(req.params.id).lean();
    const Business = (await import("../models/business.js")).default;
    const biz = supplier?.businessId ? await Business.findById(supplier.businessId).lean() : null;
    if (!biz) return res.redirect(`/zq-admin/suppliers/${req.params.id}/recurring`);

    const { amount, periodLabel, dueDate, force } = req.body;
    const { generateInvoiceForAccount } = await import("../services/recurringBilling.js");
    const result = await generateInvoiceForAccount({
      biz, accountId: req.params.acctId,
      clerkPhone: "admin",
      force: force === "1",
      amountOverride:      amount ? parseFloat(amount) : null,
      periodLabelOverride: periodLabel || null,
      dueDateOverride:     dueDate || null
    });

    const msg = result.created
      ? `Invoice ${result.invoice.number} raised for ${result.invoice.amount.toFixed(2)} ${result.invoice.currency}`
      : `Already invoiced for this period (use "Force" to raise an extra one)`;
    res.redirect(`/zq-admin/suppliers/${req.params.id}/recurring/${req.params.acctId}/records?${result.created ? "success" : "error"}=${encodeURIComponent(msg)}`);
  } catch (e) {
    res.redirect(`/zq-admin/suppliers/${req.params.id}/recurring?error=${encodeURIComponent(e.message)}`);
  }
});

// ── POST /suppliers/:id/recurring/:acctId/tenant/:tid/invoice-now - invoice ONE tenant ──
// The multi-tenant path: each tenant is invoiced using THEIR OWN effective
// billing (their override if set, otherwise the account's default).
router.post("/suppliers/:id/recurring/:acctId/tenant/:tid/invoice-now", requireSupplierAdmin, async (req, res) => {
  try {
    const supplier = await SupplierProfile.findById(req.params.id).lean();
    const Business = (await import("../models/business.js")).default;
    const biz = supplier?.businessId ? await Business.findById(supplier.businessId).lean() : null;
    if (!biz) return res.redirect(`/zq-admin/suppliers/${req.params.id}/recurring`);

    const { amount, periodLabel, dueDate, description, force } = req.body;
    const { generateInvoiceForTenant } = await import("../services/recurringBilling.js");
    const result = await generateInvoiceForTenant({
      biz, accountId: req.params.acctId, tenantId: req.params.tid,
      clerkPhone: "admin",
      force: force === "1",
      amountOverride:      amount ? parseFloat(amount) : null,
      periodLabelOverride: periodLabel || null,
      dueDateOverride:     dueDate || null,
      descriptionOverride: description || null
    });

    const msg = result.created
      ? `Invoice ${result.invoice.number} raised for ${result.invoice.amount.toFixed(2)} ${result.invoice.currency}`
      : `Already invoiced for this period (use "Force" to raise an extra one)`;
    res.redirect(`/zq-admin/suppliers/${req.params.id}/recurring/${req.params.acctId}/tenant?${result.created ? "success" : "error"}=${encodeURIComponent(msg)}`);
  } catch (e) {
    res.redirect(`/zq-admin/suppliers/${req.params.id}/recurring/${req.params.acctId}/tenant?error=${encodeURIComponent(e.message)}`);
  }
});

// ── GET /suppliers/:id/recurring/:acctId/tenant/:tid/statement - per-tenant statement ──
// Distinct from the account statement: this shows ONLY this tenant's own
// charges/payments/balance, which matters once an account hosts several
// tenants on different rentals (the account statement mixes everyone).
router.get("/suppliers/:id/recurring/:acctId/tenant/:tid/statement", requireSupplierAdmin, async (req, res) => {
  try {
    const supplier = await SupplierProfile.findById(req.params.id).lean();
    const Business        = (await import("../models/business.js")).default;
    const RecurringAccount = (await import("../models/recurringAccount.js")).default;
    const RecurringTenant  = (await import("../models/recurringTenant.js")).default;
    const biz  = supplier?.businessId ? await Business.findById(supplier.businessId).lean() : null;
    const acct = await RecurringAccount.findById(req.params.acctId).lean();
    const tenant = await RecurringTenant.findById(req.params.tid).lean();
    if (!acct || !biz || !tenant) return res.redirect(`/zq-admin/suppliers/${req.params.id}/recurring`);

    const now   = new Date();
    const year  = parseInt(req.query.year  || now.getFullYear(), 10);
    const month = parseInt(req.query.month !== undefined ? req.query.month : now.getMonth(), 10);
    const periodStart = new Date(year, month, 1, 0, 0, 0, 0);
    const periodEnd   = new Date(year, month + 1, 0, 23, 59, 59, 999);
    const pl = periodStart.toLocaleDateString("en-GB", { month: "long", year: "numeric" });

    const { buildTenantStatement, generateTenantStatementPDF } = await import("../services/recurringBilling.js");
    const stmt = await buildTenantStatement({ businessId: biz._id, tenantId: tenant._id, periodStart, periodEnd });
    const cur  = stmt.cur;

    if (req.query.pdf === "1") {
      const { filename, filepath } = await generateTenantStatementPDF({ biz, stmt, periodLabel: pl });
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      const { createReadStream } = await import("fs");
      createReadStream(filepath).pipe(res);
      return;
    }

    const months = Array.from({ length: 12 }, (_, i) => {
      const d = new Date(now.getFullYear(), i, 1);
      return `<option value="${now.getFullYear()}_${i}" ${now.getFullYear() === year && i === month ? "selected" : ""}>
        ${d.toLocaleDateString("en-GB", { month: "long", year: "numeric" })}
      </option>`;
    }).join("");

    const rowsHtml = stmt.rows.map(r => `
      <tr>
        <td>${new Date(r.date).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}</td>
        <td>${esc(r.type === "CHARGE" ? "Charge" : "Payment")}</td>
        <td>${esc(r.description)}</td>
        <td style="text-align:right;color:${r.debit > 0 ? "var(--red)" : "var(--muted)"}">${r.debit > 0 ? r.debit.toFixed(2) : "-"}</td>
        <td style="text-align:right;color:${r.credit > 0 ? "var(--green)" : "var(--muted)"}">${r.credit > 0 ? r.credit.toFixed(2) : "-"}</td>
        <td style="text-align:right;font-weight:700;color:${r.balance > 0 ? "var(--red)" : "var(--green)"}">${r.balance.toFixed(2)} ${cur}</td>
      </tr>`).join("");

    const content = `
      <div style="margin-bottom:16px">
        <a href="/zq-admin/suppliers/${supplier._id}/recurring/${acct._id}/tenant" style="color:var(--blue);text-decoration:none">← Back to Tenants</a>
      </div>
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px">
        <div>
          <h2 style="font-size:20px;font-weight:700">📋 Tenant Statement - ${esc(tenant.name)}</h2>
          <div style="color:var(--muted)">🏠 ${esc(acct.name)}</div>
        </div>
        <div style="display:flex;gap:10px;align-items:center">
          <form method="GET" style="display:flex;gap:8px;align-items:center">
            <select name="period" onchange="const[y,m]=this.value.split('_');this.form.elements.year.value=y;this.form.elements.month.value=m;this.form.submit()"
              style="padding:8px 10px;border:1px solid var(--border);border-radius:7px;font-size:13px">
              ${months}
            </select>
            <input type="hidden" name="year" value="${year}">
            <input type="hidden" name="month" value="${month}">
          </form>
          <a href="?year=${year}&month=${month}&pdf=1"
             style="background:var(--blue);color:white;padding:9px 14px;border-radius:7px;text-decoration:none;font-size:13px;font-weight:600">
            📄 Download PDF
          </a>
        </div>
      </div>

      <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:20px">
        ${stat((stmt.openingBalance).toFixed(2) + " " + cur, "Opening Balance", "")}
        ${stat(stmt.totalCharged.toFixed(2) + " " + cur, "Total Charged", "red")}
        ${stat(stmt.totalPaid.toFixed(2) + " " + cur, "Total Paid", "green")}
        ${stat(stmt.closingBalance.toFixed(2) + " " + cur, "Closing Balance", stmt.closingBalance > 0 ? "red" : "")}
      </div>

      <div class="card">
        <table style="width:100%;border-collapse:collapse;font-size:13px">
          <thead><tr style="background:#0f172a;color:white">
            <th style="padding:10px 12px;text-align:left">Date</th>
            <th style="padding:10px 12px;text-align:left">Type</th>
            <th style="padding:10px 12px;text-align:left">Description</th>
            <th style="padding:10px 12px;text-align:right">Charges</th>
            <th style="padding:10px 12px;text-align:right">Payments</th>
            <th style="padding:10px 12px;text-align:right">Balance</th>
          </tr></thead>
          <tbody>
            <tr style="background:#eff6ff;font-weight:700">
              <td colspan="5" style="padding:10px 12px">Opening Balance (carried forward)</td>
              <td style="padding:10px 12px;text-align:right;color:${stmt.openingBalance > 0 ? "var(--red)" : "var(--green)"}">${stmt.openingBalance.toFixed(2)} ${cur}</td>
            </tr>
            ${rowsHtml}
            <tr style="background:#f0fdf4;font-weight:700;font-size:14px">
              <td colspan="4" style="padding:12px">CLOSING BALANCE</td>
              <td colspan="2" style="padding:12px;text-align:right;color:${stmt.closingBalance > 0 ? "var(--red)" : "var(--green)"}">${stmt.closingBalance.toFixed(2)} ${cur}</td>
            </tr>
          </tbody>
        </table>
      </div>`;

    res.send(layout(`Tenant Statement: ${tenant.name}`, content));
  } catch (e) {
    res.redirect(`/zq-admin/suppliers/${req.params.id}/recurring/${req.params.acctId}/tenant?error=${encodeURIComponent(e.message)}`);
  }
});

// ── GET /suppliers/:id/recurring/:acctId/records - manage invoices/payments/expenses ──
router.get("/suppliers/:id/recurring/:acctId/records", requireSupplierAdmin, async (req, res) => {
  try {
    const supplier = await SupplierProfile.findById(req.params.id).lean();
    const RecurringAccount = (await import("../models/recurringAccount.js")).default;
    const RecurringInvoice = (await import("../models/recurringInvoice.js")).default;
    const RecurringPayment = (await import("../models/recurringPayment.js")).default;
    const RecurringExpense = (await import("../models/recurringExpense.js")).default;

    const acct = await RecurringAccount.findById(req.params.acctId).lean();
    if (!acct) return res.redirect(`/zq-admin/suppliers/${req.params.id}/recurring`);
    const cur = acct.currency || "USD";

    const [invoices, payments, expenses] = await Promise.all([
      RecurringInvoice.find({ accountId: acct._id }).sort({ periodStart: -1 }).lean(),
      RecurringPayment.find({ accountId: acct._id }).sort({ date: -1 }).lean(),
      RecurringExpense.find({ accountId: acct._id }).sort({ date: -1 }).lean()
    ]);

    const errMsg     = req.query.error   ? `<div class="alert red">❌ ${esc(req.query.error)}</div>`   : "";
    const successMsg = req.query.success ? `<div class="alert green">✅ ${esc(req.query.success)}</div>` : "";

    const invStatusColor = { unpaid: "yellow", partial: "yellow", paid: "green", overdue: "red", cancelled: "gray" };
    const invoiceRows = invoices.length ? invoices.map(inv => `
      <tr>
        <td>${esc(inv.number)}</td>
        <td>${esc(inv.period)}</td>
        <td style="text-align:right">${(inv.amount||0).toFixed(2)} ${cur}</td>
        <td style="text-align:right">${(inv.amountPaid||0).toFixed(2)} ${cur}</td>
        <td style="text-align:right;font-weight:600;color:${inv.balance > 0 ? "var(--red)" : "var(--green)"}">${(inv.balance||0).toFixed(2)} ${cur}</td>
        <td>${badge(inv.status, invStatusColor[inv.status] || "gray")}</td>
        <td style="display:flex;gap:6px;flex-wrap:wrap">
          <a href="/zq-admin/suppliers/${supplier._id}/recurring/${acct._id}/invoice/${inv._id}/edit"
             style="background:#e0f2fe;color:#0369a1;border:none;padding:4px 10px;border-radius:6px;font-size:12px;text-decoration:none">✏️ Edit</a>
          <form method="POST" action="/zq-admin/suppliers/${supplier._id}/recurring/${acct._id}/invoice/${inv._id}/delete"
                onsubmit="return confirm('Delete invoice ${esc(inv.number)}? Any linked payments will become unallocated, not deleted.')">
            <button style="background:#fee2e2;color:#dc2626;border:none;padding:4px 10px;border-radius:6px;font-size:12px;cursor:pointer">🗑 Delete</button>
          </form>
        </td>
      </tr>`).join("") : `<tr><td colspan="7" style="padding:14px;color:var(--muted)">No invoices yet.</td></tr>`;

    const paymentRows = payments.length ? payments.map(p => `
      <tr>
        <td>${new Date(p.date).toLocaleDateString("en-GB")}</td>
        <td style="text-align:right;font-weight:600;color:var(--green)">${(p.amount||0).toFixed(2)} ${cur}</td>
        <td>${esc(p.method)}</td>
        <td>${esc(p.reference || "-")}</td>
        <td>${esc(p.period || "-")}</td>
        <td style="display:flex;gap:6px;flex-wrap:wrap">
          <a href="/zq-admin/suppliers/${supplier._id}/recurring/${acct._id}/payment/${p._id}/edit"
             style="background:#e0f2fe;color:#0369a1;border:none;padding:4px 10px;border-radius:6px;font-size:12px;text-decoration:none">✏️ Edit</a>
          <form method="POST" action="/zq-admin/suppliers/${supplier._id}/recurring/${acct._id}/payment/${p._id}/delete"
                onsubmit="return confirm('Delete this payment of ${(p.amount||0).toFixed(2)} ${cur}? The linked invoice balance will be recalculated.')">
            <button style="background:#fee2e2;color:#dc2626;border:none;padding:4px 10px;border-radius:6px;font-size:12px;cursor:pointer">🗑 Delete</button>
          </form>
        </td>
      </tr>`).join("") : `<tr><td colspan="6" style="padding:14px;color:var(--muted)">No payments yet.</td></tr>`;

    const expenseRows = expenses.length ? expenses.map(x => `
      <tr>
        <td>${new Date(x.date).toLocaleDateString("en-GB")}</td>
        <td>${esc(x.description)}</td>
        <td>${esc(x.category)}</td>
        <td style="text-align:right;font-weight:600;color:var(--red)">${(x.amount||0).toFixed(2)} ${cur}</td>
        <td style="display:flex;gap:6px;flex-wrap:wrap">
          <a href="/zq-admin/suppliers/${supplier._id}/recurring/${acct._id}/expense/${x._id}/edit"
             style="background:#e0f2fe;color:#0369a1;border:none;padding:4px 10px;border-radius:6px;font-size:12px;text-decoration:none">✏️ Edit</a>
          <form method="POST" action="/zq-admin/suppliers/${supplier._id}/recurring/${acct._id}/expense/${x._id}/delete"
                onsubmit="return confirm('Delete this expense?')">
            <button style="background:#fee2e2;color:#dc2626;border:none;padding:4px 10px;border-radius:6px;font-size:12px;cursor:pointer">🗑 Delete</button>
          </form>
        </td>
      </tr>`).join("") : `<tr><td colspan="5" style="padding:14px;color:var(--muted)">No expenses yet.</td></tr>`;

    const content = `
      <div style="margin-bottom:16px">
        <a href="/zq-admin/suppliers/${supplier._id}/recurring" style="color:var(--blue);text-decoration:none">← Back to Recurring Billing</a>
      </div>
      <h2 style="font-size:20px;font-weight:700;margin-bottom:4px">📂 Records - ${esc(acct.name)}</h2>
      <div style="color:var(--muted);margin-bottom:20px">Edit or delete invoices, payments, and expenses for this account.</div>
      ${errMsg}${successMsg}

      <div class="card" style="margin-bottom:20px">
        <div style="font-weight:700;margin-bottom:14px">Invoices</div>
        <table style="width:100%;border-collapse:collapse;font-size:13px">
          <thead><tr style="background:#f8fafc;border-bottom:2px solid var(--border)">
            <th style="padding:10px 12px;text-align:left">Number</th>
            <th style="padding:10px 12px;text-align:left">Period</th>
            <th style="padding:10px 12px;text-align:right">Amount</th>
            <th style="padding:10px 12px;text-align:right">Paid</th>
            <th style="padding:10px 12px;text-align:right">Balance</th>
            <th style="padding:10px 12px;text-align:left">Status</th>
            <th style="padding:10px 12px;text-align:left">Actions</th>
          </tr></thead>
          <tbody>${invoiceRows}</tbody>
        </table>
      </div>

      <div class="card" style="margin-bottom:20px">
        <div style="font-weight:700;margin-bottom:14px">Payments</div>
        <table style="width:100%;border-collapse:collapse;font-size:13px">
          <thead><tr style="background:#f8fafc;border-bottom:2px solid var(--border)">
            <th style="padding:10px 12px;text-align:left">Date</th>
            <th style="padding:10px 12px;text-align:right">Amount</th>
            <th style="padding:10px 12px;text-align:left">Method</th>
            <th style="padding:10px 12px;text-align:left">Reference</th>
            <th style="padding:10px 12px;text-align:left">Period</th>
            <th style="padding:10px 12px;text-align:left">Actions</th>
          </tr></thead>
          <tbody>${paymentRows}</tbody>
        </table>
      </div>

      <div class="card" style="margin-bottom:20px">
        <div style="font-weight:700;margin-bottom:14px">Add Expense</div>
        <form method="POST" action="/zq-admin/suppliers/${supplier._id}/recurring/${acct._id}/expense/add"
              style="display:grid;grid-template-columns:repeat(4,1fr) auto;gap:10px;align-items:end">
          <div>
            <label style="font-weight:600;display:block;margin-bottom:4px;font-size:12px">Description *</label>
            <input name="description" required placeholder="Plumber call-out"
              style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:7px;font-size:13px">
          </div>
          <div>
            <label style="font-weight:600;display:block;margin-bottom:4px;font-size:12px">Category</label>
            <input name="category" placeholder="Maintenance"
              style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:7px;font-size:13px">
          </div>
          <div>
            <label style="font-weight:600;display:block;margin-bottom:4px;font-size:12px">Amount *</label>
            <input name="amount" type="number" step="0.01" required placeholder="25.00"
              style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:7px;font-size:13px">
          </div>
          <div>
            <label style="font-weight:600;display:block;margin-bottom:4px;font-size:12px">Date *</label>
            <input name="date" type="date" required value="${new Date().toISOString().slice(0,10)}"
              style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:7px;font-size:13px">
          </div>
          <button type="submit" style="background:var(--blue);color:white;padding:9px 16px;border:none;border-radius:7px;font-size:13px;font-weight:600;cursor:pointer;white-space:nowrap">
            ➕ Add Expense
          </button>
        </form>
      </div>

      <div class="card">
        <div style="font-weight:700;margin-bottom:14px">Expenses</div>
        <table style="width:100%;border-collapse:collapse;font-size:13px">
          <thead><tr style="background:#f8fafc;border-bottom:2px solid var(--border)">
            <th style="padding:10px 12px;text-align:left">Date</th>
            <th style="padding:10px 12px;text-align:left">Description</th>
            <th style="padding:10px 12px;text-align:left">Category</th>
            <th style="padding:10px 12px;text-align:right">Amount</th>
            <th style="padding:10px 12px;text-align:left">Actions</th>
          </tr></thead>
          <tbody>${expenseRows}</tbody>
        </table>
      </div>`;

    res.send(layout(`Records: ${acct.name}`, content));
  } catch (e) {
    res.redirect(`/zq-admin/suppliers/${req.params.id}/recurring?error=${encodeURIComponent(e.message)}`);
  }
});

// ── GET /suppliers/:id/recurring/:acctId/invoice/:invId/edit - edit invoice ──
router.get("/suppliers/:id/recurring/:acctId/invoice/:invId/edit", requireSupplierAdmin, async (req, res) => {
  try {
    const supplier = await SupplierProfile.findById(req.params.id).lean();
    const RecurringAccount = (await import("../models/recurringAccount.js")).default;
    const RecurringInvoice = (await import("../models/recurringInvoice.js")).default;
    const acct = await RecurringAccount.findById(req.params.acctId).lean();
    const inv  = await RecurringInvoice.findById(req.params.invId).lean();
    if (!acct || !inv) return res.redirect(`/zq-admin/suppliers/${req.params.id}/recurring/${req.params.acctId}/records`);

    const errMsg = req.query.error ? `<div class="alert red">❌ ${esc(req.query.error)}</div>` : "";
    const statusOpts = ["unpaid","partial","paid","overdue","cancelled"]
      .map(s => `<option value="${s}" ${inv.status === s ? "selected" : ""}>${s.charAt(0).toUpperCase()+s.slice(1)}</option>`)
      .join("");

    const content = `
      <div style="margin-bottom:16px">
        <a href="/zq-admin/suppliers/${supplier._id}/recurring/${acct._id}/records" style="color:var(--blue);text-decoration:none">← Back to Records</a>
      </div>
      <h2 style="font-size:20px;font-weight:700;margin-bottom:4px">✏️ Edit Invoice - ${esc(inv.number)}</h2>
      <div style="color:var(--muted);margin-bottom:20px">${esc(acct.name)} · ${esc(inv.period)}</div>
      ${errMsg}
      <div class="card" style="max-width:600px">
        <form method="POST" action="/zq-admin/suppliers/${supplier._id}/recurring/${acct._id}/invoice/${inv._id}/edit">
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:14px">
            <div>
              <label style="font-weight:600;display:block;margin-bottom:6px">Amount *</label>
              <input name="amount" type="number" step="0.01" required value="${inv.amount}"
                style="width:100%;padding:9px 12px;border:1px solid var(--border);border-radius:7px;font-size:14px">
              <div style="color:var(--muted);font-size:10px;margin-top:2px">Changing this recalculates balance from amount paid so far (${(inv.amountPaid||0).toFixed(2)})</div>
            </div>
            <div>
              <label style="font-weight:600;display:block;margin-bottom:6px">Status</label>
              <select name="status" style="width:100%;padding:9px 12px;border:1px solid var(--border);border-radius:7px;font-size:14px">${statusOpts}</select>
            </div>
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:14px">
            <div>
              <label style="font-weight:600;display:block;margin-bottom:6px">Due Date</label>
              <input name="dueDate" type="date" value="${inv.dueDate ? new Date(inv.dueDate).toISOString().slice(0,10) : ""}"
                style="width:100%;padding:9px 12px;border:1px solid var(--border);border-radius:7px;font-size:14px">
            </div>
            <div>
              <label style="font-weight:600;display:block;margin-bottom:6px">Period Label</label>
              <input name="period" value="${esc(inv.period || "")}"
                style="width:100%;padding:9px 12px;border:1px solid var(--border);border-radius:7px;font-size:14px">
            </div>
          </div>
          <div style="margin-bottom:14px">
            <label style="font-weight:600;display:block;margin-bottom:6px">Notes</label>
            <textarea name="notes" rows="2"
              style="width:100%;padding:9px 12px;border:1px solid var(--border);border-radius:7px;font-size:14px">${esc(inv.notes || "")}</textarea>
          </div>
          <div style="display:flex;gap:10px;margin-top:20px">
            <button type="submit" style="background:var(--blue);color:white;padding:10px 20px;border:none;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer">
              ✅ Save Changes
            </button>
            <a href="/zq-admin/suppliers/${supplier._id}/recurring/${acct._id}/records"
               style="background:#f1f5f9;color:var(--text);padding:10px 20px;border-radius:8px;font-size:14px;text-decoration:none">
              Cancel
            </a>
          </div>
        </form>
      </div>`;

    res.send(layout(`Edit Invoice: ${inv.number}`, content));
  } catch (e) {
    res.redirect(`/zq-admin/suppliers/${req.params.id}/recurring/${req.params.acctId}/records?error=${encodeURIComponent(e.message)}`);
  }
});

// ── POST /suppliers/:id/recurring/:acctId/invoice/:invId/edit - save invoice ─
router.post("/suppliers/:id/recurring/:acctId/invoice/:invId/edit", requireSupplierAdmin, async (req, res) => {
  try {
    const RecurringInvoice = (await import("../models/recurringInvoice.js")).default;
    const { amount, status, dueDate, period, notes } = req.body;

    const inv = await RecurringInvoice.findById(req.params.invId).lean();
    if (!inv) return res.redirect(`/zq-admin/suppliers/${req.params.id}/recurring/${req.params.acctId}/records`);

    const newAmount  = parseFloat(amount) || 0;
    const newBalance = Math.max(0, newAmount - (inv.amountPaid || 0));
    const newStatus  = status || (newBalance <= 0 ? "paid" : (inv.amountPaid || 0) > 0 ? "partial" : "unpaid");

    await RecurringInvoice.findByIdAndUpdate(req.params.invId, {
      amount:  newAmount,
      balance: newBalance,
      status:  newStatus,
      dueDate: dueDate ? new Date(dueDate) : inv.dueDate,
      period:  (period || inv.period || "").trim(),
      notes:   notes || ""
    });

    const { recomputeAccountBalance, recomputeTenantBalance } = await import("../services/recurringBilling.js");
    await recomputeAccountBalance(inv.businessId, inv.accountId);
    if (inv.tenantId) await recomputeTenantBalance(inv.businessId, inv.tenantId);

    res.redirect(`/zq-admin/suppliers/${req.params.id}/recurring/${req.params.acctId}/records?success=${encodeURIComponent(`Invoice "${inv.number}" updated`)}`);
  } catch (e) {
    res.redirect(`/zq-admin/suppliers/${req.params.id}/recurring/${req.params.acctId}/invoice/${req.params.invId}/edit?error=${encodeURIComponent(e.message)}`);
  }
});

// ── POST /suppliers/:id/recurring/:acctId/invoice/:invId/delete ──────────────
// Deletes the invoice. Any payments that were allocated to it are NOT
// deleted - they become unallocated (invoiceId set to null) so the cash
// already received is never silently lost.
router.post("/suppliers/:id/recurring/:acctId/invoice/:invId/delete", requireSupplierAdmin, async (req, res) => {
  try {
    const RecurringInvoice = (await import("../models/recurringInvoice.js")).default;
    const RecurringPayment = (await import("../models/recurringPayment.js")).default;

    const inv = await RecurringInvoice.findById(req.params.invId).lean();
    if (!inv) return res.redirect(`/zq-admin/suppliers/${req.params.id}/recurring/${req.params.acctId}/records`);

    await RecurringPayment.updateMany({ invoiceId: inv._id }, { $set: { invoiceId: null } });
    await RecurringInvoice.findByIdAndDelete(req.params.invId);

    const { recomputeAccountBalance, recomputeTenantBalance } = await import("../services/recurringBilling.js");
    await recomputeAccountBalance(inv.businessId, inv.accountId);
    if (inv.tenantId) await recomputeTenantBalance(inv.businessId, inv.tenantId);

    res.redirect(`/zq-admin/suppliers/${req.params.id}/recurring/${req.params.acctId}/records?success=${encodeURIComponent(`Invoice "${inv.number}" deleted`)}`);
  } catch (e) {
    res.redirect(`/zq-admin/suppliers/${req.params.id}/recurring/${req.params.acctId}/records?error=${encodeURIComponent(e.message)}`);
  }
});

// ── GET /suppliers/:id/recurring/:acctId/payment/:payId/edit - edit payment ──
router.get("/suppliers/:id/recurring/:acctId/payment/:payId/edit", requireSupplierAdmin, async (req, res) => {
  try {
    const supplier = await SupplierProfile.findById(req.params.id).lean();
    const RecurringAccount = (await import("../models/recurringAccount.js")).default;
    const RecurringPayment = (await import("../models/recurringPayment.js")).default;
    const acct = await RecurringAccount.findById(req.params.acctId).lean();
    const pay  = await RecurringPayment.findById(req.params.payId).lean();
    if (!acct || !pay) return res.redirect(`/zq-admin/suppliers/${req.params.id}/recurring/${req.params.acctId}/records`);

    const errMsg = req.query.error ? `<div class="alert red">❌ ${esc(req.query.error)}</div>` : "";
    const methodOpts = ["cash","ecocash","bank","innbucks","zipit","card","other"]
      .map(m => `<option value="${m}" ${pay.method === m ? "selected" : ""}>${m.charAt(0).toUpperCase()+m.slice(1)}</option>`)
      .join("");

    const content = `
      <div style="margin-bottom:16px">
        <a href="/zq-admin/suppliers/${supplier._id}/recurring/${acct._id}/records" style="color:var(--blue);text-decoration:none">← Back to Records</a>
      </div>
      <h2 style="font-size:20px;font-weight:700;margin-bottom:4px">✏️ Edit Payment</h2>
      <div style="color:var(--muted);margin-bottom:20px">${esc(acct.name)} · ${new Date(pay.date).toLocaleDateString("en-GB")}</div>
      ${errMsg}
      <div class="card" style="max-width:600px">
        <form method="POST" action="/zq-admin/suppliers/${supplier._id}/recurring/${acct._id}/payment/${pay._id}/edit">
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:14px">
            <div>
              <label style="font-weight:600;display:block;margin-bottom:6px">Amount *</label>
              <input name="amount" type="number" step="0.01" required value="${pay.amount}"
                style="width:100%;padding:9px 12px;border:1px solid var(--border);border-radius:7px;font-size:14px">
              <div style="color:var(--muted);font-size:10px;margin-top:2px">Changing this recalculates the linked invoice's balance, if any</div>
            </div>
            <div>
              <label style="font-weight:600;display:block;margin-bottom:6px">Method</label>
              <select name="method" style="width:100%;padding:9px 12px;border:1px solid var(--border);border-radius:7px;font-size:14px">${methodOpts}</select>
            </div>
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:14px">
            <div>
              <label style="font-weight:600;display:block;margin-bottom:6px">Date *</label>
              <input name="date" type="date" required value="${new Date(pay.date).toISOString().slice(0,10)}"
                style="width:100%;padding:9px 12px;border:1px solid var(--border);border-radius:7px;font-size:14px">
            </div>
            <div>
              <label style="font-weight:600;display:block;margin-bottom:6px">Reference</label>
              <input name="reference" value="${esc(pay.reference || "")}"
                style="width:100%;padding:9px 12px;border:1px solid var(--border);border-radius:7px;font-size:14px">
            </div>
          </div>
          <div style="margin-bottom:14px">
            <label style="font-weight:600;display:block;margin-bottom:6px">Notes</label>
            <textarea name="notes" rows="2"
              style="width:100%;padding:9px 12px;border:1px solid var(--border);border-radius:7px;font-size:14px">${esc(pay.notes || "")}</textarea>
          </div>
          <div style="display:flex;gap:10px;margin-top:20px">
            <button type="submit" style="background:var(--blue);color:white;padding:10px 20px;border:none;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer">
              ✅ Save Changes
            </button>
            <a href="/zq-admin/suppliers/${supplier._id}/recurring/${acct._id}/records"
               style="background:#f1f5f9;color:var(--text);padding:10px 20px;border-radius:8px;font-size:14px;text-decoration:none">
              Cancel
            </a>
          </div>
        </form>
      </div>`;

    res.send(layout(`Edit Payment`, content));
  } catch (e) {
    res.redirect(`/zq-admin/suppliers/${req.params.id}/recurring/${req.params.acctId}/records?error=${encodeURIComponent(e.message)}`);
  }
});

// ── POST /suppliers/:id/recurring/:acctId/payment/:payId/edit - save payment ─
router.post("/suppliers/:id/recurring/:acctId/payment/:payId/edit", requireSupplierAdmin, async (req, res) => {
  try {
    const RecurringPayment = (await import("../models/recurringPayment.js")).default;
    const { amount, method, date, reference, notes } = req.body;

    const pay = await RecurringPayment.findById(req.params.payId).lean();
    if (!pay) return res.redirect(`/zq-admin/suppliers/${req.params.id}/recurring/${req.params.acctId}/records`);

    await RecurringPayment.findByIdAndUpdate(req.params.payId, {
      amount:    parseFloat(amount) || 0,
      method:    method || "cash",
      date:      date ? new Date(date) : pay.date,
      reference: reference || "",
      notes:     notes || ""
    });

    const { recomputeInvoiceFromPayments, recomputeAccountBalance, recomputeTenantBalance } = await import("../services/recurringBilling.js");
    if (pay.invoiceId) await recomputeInvoiceFromPayments(pay.invoiceId);
    await recomputeAccountBalance(pay.businessId, pay.accountId);
    if (pay.tenantId) await recomputeTenantBalance(pay.businessId, pay.tenantId);

    res.redirect(`/zq-admin/suppliers/${req.params.id}/recurring/${req.params.acctId}/records?success=Payment+updated`);
  } catch (e) {
    res.redirect(`/zq-admin/suppliers/${req.params.id}/recurring/${req.params.acctId}/payment/${req.params.payId}/edit?error=${encodeURIComponent(e.message)}`);
  }
});

// ── POST /suppliers/:id/recurring/:acctId/payment/:payId/delete ──────────────
router.post("/suppliers/:id/recurring/:acctId/payment/:payId/delete", requireSupplierAdmin, async (req, res) => {
  try {
    const RecurringPayment = (await import("../models/recurringPayment.js")).default;
    const pay = await RecurringPayment.findById(req.params.payId).lean();
    if (!pay) return res.redirect(`/zq-admin/suppliers/${req.params.id}/recurring/${req.params.acctId}/records`);

    await RecurringPayment.findByIdAndDelete(req.params.payId);

    const { recomputeInvoiceFromPayments, recomputeAccountBalance, recomputeTenantBalance } = await import("../services/recurringBilling.js");
    if (pay.invoiceId) await recomputeInvoiceFromPayments(pay.invoiceId);
    await recomputeAccountBalance(pay.businessId, pay.accountId);
    if (pay.tenantId) await recomputeTenantBalance(pay.businessId, pay.tenantId);

    res.redirect(`/zq-admin/suppliers/${req.params.id}/recurring/${req.params.acctId}/records?success=Payment+deleted`);
  } catch (e) {
    res.redirect(`/zq-admin/suppliers/${req.params.id}/recurring/${req.params.acctId}/records?error=${encodeURIComponent(e.message)}`);
  }
});

// ── POST /suppliers/:id/recurring/:acctId/expense/add - add expense ──────────
router.post("/suppliers/:id/recurring/:acctId/expense/add", requireSupplierAdmin, async (req, res) => {
  try {
    const supplier = await SupplierProfile.findById(req.params.id).lean();
    const Business         = (await import("../models/business.js")).default;
    const RecurringExpense = (await import("../models/recurringExpense.js")).default;
    const biz = supplier?.businessId ? await Business.findById(supplier.businessId).lean() : null;
    if (!biz) return res.redirect(`/zq-admin/suppliers/${req.params.id}/recurring`);

    const { description, category, amount, date } = req.body;
    const d = date ? new Date(date) : new Date();

    await RecurringExpense.create({
      businessId:  biz._id,
      accountId:   req.params.acctId,
      description: (description || "").trim(),
      category:    (category || "Maintenance").trim(),
      amount:      parseFloat(amount) || 0,
      date:        d,
      period:      d.toLocaleDateString("en-GB", { month: "long", year: "numeric" }),
      createdBy:   "admin"
    });

    res.redirect(`/zq-admin/suppliers/${req.params.id}/recurring/${req.params.acctId}/records?success=Expense+added`);
  } catch (e) {
    res.redirect(`/zq-admin/suppliers/${req.params.id}/recurring/${req.params.acctId}/records?error=${encodeURIComponent(e.message)}`);
  }
});

// ── GET /suppliers/:id/recurring/:acctId/expense/:expId/edit - edit expense ──
router.get("/suppliers/:id/recurring/:acctId/expense/:expId/edit", requireSupplierAdmin, async (req, res) => {
  try {
    const supplier = await SupplierProfile.findById(req.params.id).lean();
    const RecurringAccount = (await import("../models/recurringAccount.js")).default;
    const RecurringExpense = (await import("../models/recurringExpense.js")).default;
    const acct = await RecurringAccount.findById(req.params.acctId).lean();
    const exp  = await RecurringExpense.findById(req.params.expId).lean();
    if (!acct || !exp) return res.redirect(`/zq-admin/suppliers/${req.params.id}/recurring/${req.params.acctId}/records`);

    const errMsg = req.query.error ? `<div class="alert red">❌ ${esc(req.query.error)}</div>` : "";

    const content = `
      <div style="margin-bottom:16px">
        <a href="/zq-admin/suppliers/${supplier._id}/recurring/${acct._id}/records" style="color:var(--blue);text-decoration:none">← Back to Records</a>
      </div>
      <h2 style="font-size:20px;font-weight:700;margin-bottom:4px">✏️ Edit Expense</h2>
      <div style="color:var(--muted);margin-bottom:20px">${esc(acct.name)}</div>
      ${errMsg}
      <div class="card" style="max-width:600px">
        <form method="POST" action="/zq-admin/suppliers/${supplier._id}/recurring/${acct._id}/expense/${exp._id}/edit">
          <div style="margin-bottom:14px">
            <label style="font-weight:600;display:block;margin-bottom:6px">Description *</label>
            <input name="description" required value="${esc(exp.description)}"
              style="width:100%;padding:9px 12px;border:1px solid var(--border);border-radius:7px;font-size:14px">
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:14px">
            <div>
              <label style="font-weight:600;display:block;margin-bottom:6px">Category</label>
              <input name="category" value="${esc(exp.category || "")}"
                style="width:100%;padding:9px 12px;border:1px solid var(--border);border-radius:7px;font-size:14px">
            </div>
            <div>
              <label style="font-weight:600;display:block;margin-bottom:6px">Amount *</label>
              <input name="amount" type="number" step="0.01" required value="${exp.amount}"
                style="width:100%;padding:9px 12px;border:1px solid var(--border);border-radius:7px;font-size:14px">
            </div>
          </div>
          <div style="margin-bottom:14px">
            <label style="font-weight:600;display:block;margin-bottom:6px">Date *</label>
            <input name="date" type="date" required value="${new Date(exp.date).toISOString().slice(0,10)}"
              style="width:100%;padding:9px 12px;border:1px solid var(--border);border-radius:7px;font-size:14px">
          </div>
          <div style="margin-bottom:14px">
            <label style="font-weight:600;display:block;margin-bottom:6px">Notes</label>
            <textarea name="notes" rows="2"
              style="width:100%;padding:9px 12px;border:1px solid var(--border);border-radius:7px;font-size:14px">${esc(exp.notes || "")}</textarea>
          </div>
          <div style="display:flex;gap:10px;margin-top:20px">
            <button type="submit" style="background:var(--blue);color:white;padding:10px 20px;border:none;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer">
              ✅ Save Changes
            </button>
            <a href="/zq-admin/suppliers/${supplier._id}/recurring/${acct._id}/records"
               style="background:#f1f5f9;color:var(--text);padding:10px 20px;border-radius:8px;font-size:14px;text-decoration:none">
              Cancel
            </a>
          </div>
        </form>
      </div>`;

    res.send(layout(`Edit Expense`, content));
  } catch (e) {
    res.redirect(`/zq-admin/suppliers/${req.params.id}/recurring/${req.params.acctId}/records?error=${encodeURIComponent(e.message)}`);
  }
});

// ── POST /suppliers/:id/recurring/:acctId/expense/:expId/edit - save expense ─
router.post("/suppliers/:id/recurring/:acctId/expense/:expId/edit", requireSupplierAdmin, async (req, res) => {
  try {
    const RecurringExpense = (await import("../models/recurringExpense.js")).default;
    const { description, category, amount, date, notes } = req.body;
    const exp = await RecurringExpense.findById(req.params.expId).lean();
    if (!exp) return res.redirect(`/zq-admin/suppliers/${req.params.id}/recurring/${req.params.acctId}/records`);

    await RecurringExpense.findByIdAndUpdate(req.params.expId, {
      description: (description || "").trim(),
      category:    (category || "Maintenance").trim(),
      amount:      parseFloat(amount) || 0,
      date:        date ? new Date(date) : exp.date,
      notes:       notes || ""
    });

    res.redirect(`/zq-admin/suppliers/${req.params.id}/recurring/${req.params.acctId}/records?success=Expense+updated`);
  } catch (e) {
    res.redirect(`/zq-admin/suppliers/${req.params.id}/recurring/${req.params.acctId}/expense/${req.params.expId}/edit?error=${encodeURIComponent(e.message)}`);
  }
});

// ── POST /suppliers/:id/recurring/:acctId/expense/:expId/delete ──────────────
router.post("/suppliers/:id/recurring/:acctId/expense/:expId/delete", requireSupplierAdmin, async (req, res) => {
  try {
    const RecurringExpense = (await import("../models/recurringExpense.js")).default;
    await RecurringExpense.findByIdAndDelete(req.params.expId);
    res.redirect(`/zq-admin/suppliers/${req.params.id}/recurring/${req.params.acctId}/records?success=Expense+deleted`);
  } catch (e) {
    res.redirect(`/zq-admin/suppliers/${req.params.id}/recurring/${req.params.acctId}/records?error=${encodeURIComponent(e.message)}`);
  }
});

export default router;