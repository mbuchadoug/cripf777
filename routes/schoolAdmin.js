// routes/schoolAdmin.js
// ─── ZimQuote School Admin Panel ─────────────────────────────────────────────
// Mirrors supplierAdmin.js patterns exactly.
// Mount at: app.use("/zq-admin", schoolAdminRouter) in your main app file
// (same router as supplierAdmin - just add the routes below to the existing
//  supplierAdmin router OR import and use separately with the same session auth)

import express from "express";
import multer from "multer";
import mongoose from "mongoose";
import { GridFSBucket } from "mongodb";
import path from "path";
import { requireSupplierAdmin } from "../middleware/supplierAdminAuth.js";
import SchoolProfile from "../models/schoolProfile.js";
import SchoolSubscriptionPayment from "../models/schoolSubscriptionPayment.js";
import { sendDocument, sendText } from "../services/metaSender.js";
import { generatePDF } from "../routes/twilio_biz.js";
import SchoolLead from "../models/schoolLead.js";
import {
  SCHOOL_CITIES,
  SCHOOL_FACILITIES,
  SCHOOL_EXTRAMURALACTIVITIES,
  SCHOOL_CURRICULA,
  SCHOOL_TYPES,
  SCHOOL_GENDERS,
  SCHOOL_BOARDING,
  SCHOOL_PLANS,
  computeSchoolFeeRange
} from "../services/schoolPlans.js";




function getSchoolPlanAmount(tier, plan) {
  const t = String(tier || "basic").toLowerCase();
  const p = String(plan || "monthly").toLowerCase();

  const PRICE_MAP = {
    basic:    { monthly: 15, annual: 150 },
    featured: { monthly: 35, annual: 350 }
  };

  return PRICE_MAP[t]?.[p] ?? PRICE_MAP.basic.monthly;
}

function fmtUsd(n) {
  return Number(n || 0).toFixed(2);
}

function buildSchoolOfferMessage({
  schoolName,
  tier,
  plan,
  targetAmount,
  dueText,
  discountPercent
}) {
  const planLabel =
    String(tier).toLowerCase() === "featured" ? "Featured" : "Basic";

  const isAnnual = String(plan).toLowerCase() === "annual";

const cycleLabel = isAnnual ? "for 1 full year" : "per month";

  const dueLabel = String(dueText || "").trim() || "today";

const hasDiscount = Number(discountPercent || 0) > 0;

const discountExpiryLine = hasDiscount
  ? `\n\n⚠️ This discounted price is only valid if payment is made by ${dueLabel}.`
  : "";

return `Hi ${schoolName},

Your trial listing on ZimQuote is ending.

To stay visible to parents searching on WhatsApp, we can activate your ${planLabel} plan for just $${fmtUsd(targetAmount)} ${cycleLabel} if payment is made by ${dueLabel}.${discountExpiryLine}

Once activated, your school stays visible and can remain on the first page when parents search for schools.

I've also attached the invoice showing the discounted fee.

To arrange payment, contact 0789901058.

Reply here if you want us to activate it for you.`;
}

// ── ZimQuote chatbot link helpers (must be before route declarations) ──────────
const SC_BOT = (process.env.WHATSAPP_BOT_NUMBER || "263771143904").replace(/\D/g, "");

function _waLinkSchool(id) {
  return "https://wa.me/" + SC_BOT + "?text=" + encodeURIComponent("ZQ:SCHOOL:" + id);
}
function _qrUrl(waLink, size) {
  size = size || 300;
  return "https://api.qrserver.com/v1/create-qr-code/?size=" + size + "x" + size
    + "&data=" + encodeURIComponent(waLink) + "&color=085041&bgcolor=FFFFFF&qzone=2";
}

const router = express.Router();



// ── GridFS bucket for school brochures ───────────────────────────────────────
function getBucket() {
  return new GridFSBucket(mongoose.connection.db, { bucketName: "schoolBrochures" });
}

// ── Multer — store in memory first, then pipe to GridFS ──────────────────────
const brochureUpload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 10 * 1024 * 1024 }, // 10MB max
  fileFilter: (req, file, cb) => {
    if (file.mimetype === "application/pdf") cb(null, true);
    else cb(new Error("Only PDF files are allowed."));
  }
});
router.use(express.json());

// ─── Helpers (same as supplierAdmin.js) ───────────────────────────────────────
function esc(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
function badge(text, color) {
  return `<span class="badge badge-${color}">${esc(text)}</span>`;
}
function stat(value, label, color) {
  return `<div class="stat-card ${color ? 'stat-' + color : ''}">
    <div class="stat-val">${value}</div>
    <div class="stat-lbl">${label}</div>
  </div>`;
}
function tierColor(t) {
  return { basic: "blue", featured: "orange" }[t] || "gray";
}

// ─── Shared layout (same CSS as supplierAdmin - reuses the sidebar nav) ────────
function layout(title, content) {
const nav = [
    { href: "/zq-admin",                label: "📊 Dashboard",        match: title === "Dashboard" },
    { href: "/zq-admin/suppliers",      label: "🏪 Suppliers",         match: title === "Suppliers" || title.includes("Edit") },
    { href: "/zq-admin/suppliers/new",  label: "➕ Register Supplier", match: title === "Register Supplier" },
    { href: "/zq-admin/schools",        label: "🏫 Schools",           match: title === "Schools" || title.startsWith("Edit:") || title.startsWith("Activate:") },
    { href: "/zq-admin/schools/new",    label: "➕ Register School",   match: title === "Register School" },
    { href: "/zq-admin/orders",         label: "📦 Orders",            match: title === "Orders" },
    { href: "/zq-admin/payments",       label: "💳 Payments",          match: title === "Payments" },
    { href: "/zq-admin/contacts",       label: "👥 Contacts",          match: title === "Contacts" },
    { href: "/zq-admin/presets",        label: "🗂 Presets",           match: title === "Presets" },
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
}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:system-ui,-apple-system,sans-serif;background:var(--bg);color:var(--text);font-size:14px}
.sidebar{position:fixed;left:0;top:0;bottom:0;width:210px;background:var(--sidebar);display:flex;flex-direction:column;z-index:100}
.sidebar-brand{padding:20px;font-size:18px;font-weight:700;color:white;border-bottom:1px solid #1e293b;letter-spacing:-.3px}
.sidebar-brand span{color:#60a5fa}
.sidebar-nav{flex:1;padding:8px 0}
.sidebar-nav a{display:flex;align-items:center;gap:8px;padding:11px 20px;color:#94a3b8;text-decoration:none;font-size:13px;transition:all .15s}
.sidebar-nav a:hover,.sidebar-nav a.active{background:var(--sidebar-hover);color:white}
.sidebar-footer{padding:16px 20px;border-top:1px solid #1e293b}
.sidebar-footer form button{background:none;border:none;color:#94a3b8;cursor:pointer;font-size:13px;padding:0}
.sidebar-footer form button:hover{color:white}
.main{margin-left:210px;padding:24px;min-height:100vh}
.page-title{font-size:22px;font-weight:700;margin-bottom:20px;color:var(--text)}
.stats-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:12px;margin-bottom:20px}
.stat-card{background:var(--white);padding:18px;border-radius:10px;box-shadow:0 1px 3px rgba(0,0,0,.08);border-left:3px solid #e2e8f0}
.stat-green{border-left-color:#22c55e}.stat-orange{border-left-color:#f97316}
.stat-blue{border-left-color:#3b82f6}.stat-yellow{border-left-color:#eab308}
.stat-purple{border-left-color:#a855f7}.stat-teal{border-left-color:#14b8a6}
.stat-val{font-size:26px;font-weight:700;line-height:1}
.stat-lbl{font-size:12px;color:var(--muted);margin-top:5px}
.panel{background:var(--white);border-radius:10px;padding:20px;box-shadow:0 1px 3px rgba(0,0,0,.08);margin-bottom:16px}
.panel h3{font-size:15px;font-weight:700;margin-bottom:14px}
.panel-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:14px}
.panel-head h3{margin:0}
.two-col{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px}
table{width:100%;border-collapse:collapse;font-size:13px}
th{text-align:left;padding:9px 12px;background:#f8fafc;border-bottom:2px solid var(--border);color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.5px;white-space:nowrap}
td{padding:9px 12px;border-bottom:1px solid #f1f5f9;vertical-align:middle}
tr:last-child td{border-bottom:none}
tr:hover td{background:#fafbfc}
.badge{display:inline-flex;align-items:center;padding:3px 9px;border-radius:20px;font-size:11px;font-weight:700;text-transform:capitalize}
.badge-green{background:#dcfce7;color:#16a34a}.badge-red{background:#fee2e2;color:#dc2626}
.badge-gray{background:#f1f5f9;color:#475569}.badge-blue{background:#dbeafe;color:#1d4ed8}
.badge-yellow{background:#fef9c3;color:#a16207}.badge-orange{background:#ffedd5;color:#c2410c}
.badge-teal{background:#ccfbf1;color:#0f766e}
.count{background:#f1f5f9;color:#64748b;padding:2px 8px;border-radius:20px;font-size:12px;margin-left:6px}
.btn{display:inline-block;padding:9px 18px;border:none;border-radius:7px;font-size:13px;font-weight:600;cursor:pointer;text-decoration:none;transition:opacity .15s}
.btn:hover{opacity:.88}
.btn-blue{background:var(--blue);color:white}.btn-green{background:#22c55e;color:white}
.btn-red{background:#ef4444;color:white}.btn-orange{background:#f97316;color:white}
.btn-gray{background:#e2e8f0;color:#475569}.btn-purple{background:#7c3aed;color:white}
.btn-sm{padding:5px 12px;font-size:12px}
.btn-link{color:var(--blue);text-decoration:none;font-size:13px;font-weight:600}
.btn-link:hover{text-decoration:underline}
.btn-reset{color:var(--muted);text-decoration:none;font-size:13px}
.filter-form{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.filter-form input,.filter-form select{padding:7px 11px;border:1px solid var(--border);border-radius:6px;font-size:13px;outline:none}
.filter-form button{padding:7px 14px;background:var(--blue);color:white;border:none;border-radius:6px;cursor:pointer;font-size:13px}
.edit-form .form-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:14px}
.fg{display:flex;flex-direction:column;gap:5px}
.fg.full{margin-bottom:12px}
.fg label{font-size:12px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.4px}
.fg input,.fg select,.fg textarea{padding:9px 11px;border:1px solid var(--border);border-radius:7px;font-size:13px;outline:none}
.fg input:focus,.fg select:focus,.fg textarea:focus{border-color:var(--blue)}
.fg textarea{resize:vertical}
.form-actions{display:flex;gap:10px;margin-top:16px}
.detail-list{display:grid;grid-template-columns:160px 1fr;gap:1px}
.detail-list dt{font-size:12px;font-weight:600;color:var(--muted);padding:8px 0;border-bottom:1px solid #f8fafc;text-transform:uppercase;letter-spacing:.3px}
.detail-list dd{padding:8px 0;border-bottom:1px solid #f8fafc;font-size:13px}
.admin-note{background:#fefce8;padding:6px 10px;border-radius:6px;font-style:italic;color:#854d0e}
.tag-cloud{display:flex;flex-wrap:wrap;gap:6px}
.tag{background:#e0f2fe;color:#0369a1;padding:4px 10px;border-radius:20px;font-size:12px}
.action-row{display:flex;gap:8px;flex-wrap:wrap;margin-top:16px;padding-top:16px;border-top:1px solid var(--border)}
.back-link{display:inline-block;margin-bottom:16px;color:var(--blue);text-decoration:none;font-size:13px}
.back-link:hover{text-decoration:underline}
.alert.red{background:#fee2e2;color:#dc2626;padding:14px;border-radius:8px}
.muted{color:var(--muted)}
.pagination{display:flex;gap:4px;margin-top:14px;flex-wrap:wrap}
.pagination a{padding:5px 11px;border:1px solid var(--border);border-radius:6px;text-decoration:none;color:var(--muted);font-size:13px}
.pagination a.active{background:var(--blue);color:white;border-color:var(--blue)}
.checkbox-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:8px;margin-top:8px}
.checkbox-grid label{display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer;padding:6px 10px;border:1px solid var(--border);border-radius:6px}
.checkbox-grid label:hover{background:#f8fafc}
code{background:#f1f5f9;padding:2px 6px;border-radius:4px;font-size:12px;font-family:monospace}
@media(max-width:768px){.sidebar{display:none}.main{margin-left:0}.two-col,.edit-form .form-grid{grid-template-columns:1fr}.stats-grid{grid-template-columns:repeat(2,1fr)}}
</style>
</head>
<body>
<nav class="sidebar">
  <div class="sidebar-brand">⚡ <span>Zim</span>Quote</div>
  <div class="sidebar-nav">
    ${nav.map(n => `<a href="${n.href}" ${n.match ? 'class="active"' : ""}>${n.label}</a>`).join("")}
  </div>
  <div class="sidebar-footer">
    <form method="POST" action="/zq-admin/logout">
      <button>🚪 Logout</button>
    </form>
  </div>
</nav>
<main class="main">
  <div class="page-title">${esc(title)}</div>
  ${content}
</main>
</body>
</html>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// SCHOOLS LIST
// GET /zq-admin/schools
// ─────────────────────────────────────────────────────────────────────────────
// ── FAQ management helpers ───────────────────────────────────────────────────
// ── FAQ & Category management helpers ────────────────────────────────────────
function _genFaqId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
}

const SYSTEM_FAQ_CATEGORIES = [
  { id: "fees",       name: "Fees & Payments", emoji: "💵", order: 10 },
  { id: "admissions", name: "Admissions",       emoji: "📝", order: 20 },
  { id: "boarding",   name: "Boarding",         emoji: "🛏️", order: 30 },
  { id: "transport",  name: "Transport",        emoji: "🚌", order: 40 },
  { id: "academics",  name: "Academics",        emoji: "📊", order: 50 },
  { id: "facilities", name: "Facilities",       emoji: "🏊", order: 60 },
  { id: "uniforms",   name: "Uniforms",         emoji: "👕", order: 70 },
  { id: "calendar",   name: "Term Calendar",    emoji: "📆", order: 80 },
  { id: "contact",    name: "Contact & Admin",  emoji: "📞", order: 90 },
];

function _esc(str) {
  return String(str || "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}


router.get("/schools", requireSupplierAdmin, async (req, res) => {
  try {
    const { search = "", status = "", tier = "", city = "", page = 1 } = req.query;
    const limit = 20;
    const skip  = (Number(page) - 1) * limit;

    const query = {};
    if (search) {
      query.$or = [
        { schoolName: { $regex: search, $options: "i" } },
        { phone:      { $regex: search, $options: "i" } },
        { city:       { $regex: search, $options: "i" } },
        { suburb:     { $regex: search, $options: "i" } }
      ];
    }
    if (status === "active")   query.active = true;
    if (status === "inactive") query.active = false;
    if (tier)  query.tier = tier;
    if (city)  query.city = city;

    const [schools, total, activeCount, inactiveCount] = await Promise.all([
      SchoolProfile.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      SchoolProfile.countDocuments(query),
      SchoolProfile.countDocuments({ active: true }),
      SchoolProfile.countDocuments({ active: false })
    ]);

    const pages = Math.ceil(total / limit);
    const qs    = (p) => `?page=${p}&search=${encodeURIComponent(search)}&status=${status}&tier=${tier}&city=${city}`;

    const cityOptions = SCHOOL_CITIES.map(c =>
      `<option value="${esc(c)}" ${city === c ? "selected" : ""}>${esc(c)}</option>`
    ).join("");

    res.send(layout("Schools", `
      <div class="stats-grid">
        ${stat(total,         "Total Schools",    "")}
        ${stat(activeCount,   "Active Listings",  "green")}
        ${stat(inactiveCount, "Inactive",         "orange")}
      </div>

      <div class="panel">
        <div class="panel-head">
          <h3>Schools <span class="count">${total}</span></h3>
          <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
            <a href="/zq-admin/schools/new" class="btn btn-green btn-sm">➕ Register School</a>
            <form method="GET" class="filter-form">
              <input name="search" placeholder="Name, phone, city..." value="${esc(search)}" />
              <select name="status">
                <option value="">All Status</option>
                <option ${status === 'active'   ? 'selected' : ''} value="active">Active</option>
                <option ${status === 'inactive' ? 'selected' : ''} value="inactive">Inactive</option>
              </select>
              <select name="tier">
                <option value="">All Plans</option>
                <option ${tier === "basic"    ? "selected" : ""} value="basic">Basic</option>
                <option ${tier === "featured" ? "selected" : ""} value="featured">Featured</option>
              </select>
              <select name="city">
                <option value="">All Cities</option>
                ${cityOptions}
              </select>
              <button type="submit">Filter</button>
              <a href="/zq-admin/schools" class="btn-reset">Clear</a>
            </form>
          </div>
        </div>
        <table>
          <thead>
            <tr>
              <th>School</th><th>Phone</th><th>City / Suburb</th><th>Type</th>
              <th>Plan</th><th>Status</th><th>Admissions</th><th>Rating</th><th></th>
            </tr>
          </thead>
          <tbody>
            ${schools.length ? schools.map(s => `
            <tr>
              <td><strong>${esc(s.schoolName)}</strong></td>
              <td>${esc(s.phone)}</td>
              <td>${esc(s.suburb || "")}${s.suburb ? ", " : ""}${esc(s.city)}</td>
              <td><span class="tag" style="font-size:11px">${esc(s.type || "combined")}</span></td>
              <td>${badge(s.tier || "none", tierColor(s.tier))}</td>
              <td>${badge(s.active ? 'Active' : 'Inactive', s.active ? 'green' : 'gray')}</td>
              <td>${s.admissionsOpen ? "🟢 Open" : "🔴 Closed"}</td>
              <td>⭐ ${(s.rating || 0).toFixed(1)}</td>
     <td>
  <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
    <a href="/zq-admin/schools/${s._id}" class="btn-link">Manage →</a>
    <a href="/zq-admin/schools/${s._id}/offer" class="btn-link">Send Offer</a>
  </div>
</td>
            </tr>`).join("") : `
            <tr><td colspan="9" style="text-align:center;padding:32px;color:var(--muted)">No schools found.</td></tr>`}
          </tbody>
        </table>
        ${pages > 1 ? `
        <div class="pagination">
          ${Number(page) > 1 ? `<a href="${qs(Number(page) - 1)}">← Prev</a>` : ""}
          ${Array.from({ length: Math.min(pages, 10) }, (_, i) => i + 1).map(p =>
            `<a href="${qs(p)}" class="${Number(page) === p ? 'active' : ''}">${p}</a>`
          ).join("")}
          ${Number(page) < pages ? `<a href="${qs(Number(page) + 1)}">Next →</a>` : ""}
        </div>` : ""}
      </div>
    `));
  } catch (err) {
    res.send(layout("Schools", `<div class="alert red">Error: ${err.message}</div>`));
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// REGISTER NEW SCHOOL (GET form)
// GET /zq-admin/schools/new
// ─────────────────────────────────────────────────────────────────────────────
router.get("/schools/new", requireSupplierAdmin, (req, res) => {
  const error   = req.query.error   ? `<div class="alert red" style="margin-bottom:16px">❌ ${esc(req.query.error)}</div>` : "";
  const success = req.query.success ? `<div style="background:#dcfce7;color:#16a34a;padding:14px;border-radius:8px;margin-bottom:16px">✅ ${esc(req.query.success)}</div>` : "";

  const cityOptions     = SCHOOL_CITIES.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join("");
  const typeOptions     = SCHOOL_TYPES.map(t => `<option value="${esc(t.id)}">${esc(t.label)}</option>`).join("");
  const genderOptions   = SCHOOL_GENDERS.map(g => `<option value="${esc(g.id)}">${esc(g.label)}</option>`).join("");
  const boardingOptions = SCHOOL_BOARDING.map(b => `<option value="${esc(b.id)}">${esc(b.label)}</option>`).join("");

  const curriculumChecks = SCHOOL_CURRICULA.map(c => `
    <label>
      <input type="checkbox" name="curriculum" value="${esc(c.id)}" />
      ${esc(c.label)}
    </label>`).join("");

  const facilityChecks = SCHOOL_FACILITIES.map(f => `
    <label>
      <input type="checkbox" name="facilities" value="${esc(f.id)}" />
      ${esc(f.label)}
    </label>`).join("");

  const extramuralChecks = SCHOOL_EXTRAMURALACTIVITIES.map(e => `
    <label>
      <input type="checkbox" name="extramuralActivities" value="${esc(e.id)}" />
      ${esc(e.label)}
    </label>`).join("");

  res.send(layout("Register School", `
    <a href="/zq-admin/schools" class="back-link">← Back to Schools</a>
    ${error}${success}

    <div class="panel" style="max-width:900px">
      <div class="panel-head">
        <h3>🏫 Register New School</h3>
        <span style="font-size:12px;color:var(--muted)">Admin-created listing - bypasses WhatsApp flow</span>
      </div>

      <form method="POST" action="/zq-admin/schools/new" class="edit-form">

        <!-- ── SECTION 1: School Info ──────────────────────────────────── -->
        <div style="margin-bottom:20px;padding-bottom:16px;border-bottom:1px solid var(--border)">
          <p style="font-weight:700;font-size:13px;margin-bottom:14px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px">1. School Info</p>
          <div class="form-grid">
            <div class="fg">
              <label>School Name <span style="color:red">*</span></label>
              <input name="schoolName" placeholder="e.g. St John's Academy" required />
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
                <option value="Other">Other City</option>
              </select>
            </div>
            <div class="fg">
              <label>Suburb / Area <span style="color:red">*</span></label>
              <input name="suburb" placeholder="e.g. Borrowdale, Hillside" required />
            </div>
            <div class="fg">
              <label>Physical Address</label>
              <input name="address" placeholder="e.g. 15 Churchill Ave, Borrowdale" />
            </div>
            <div class="fg">
              <label>Email</label>
              <input name="email" type="email" placeholder="e.g. admin@stjohns.ac.zw" />
            </div>
            <div class="fg">
              <label>Website</label>
              <input name="website" placeholder="e.g. www.stjohns.ac.zw" />
            </div>
            <div class="fg">
              <label>Principal Name</label>
              <input name="principalName" placeholder="e.g. Mrs J. Moyo" />
            </div>
            <div class="fg">
              <label>Contact Phone (shown to parents)</label>
              <input name="contactPhone" placeholder="e.g. 0242123456 or 0772123456"
                     title="This number appears on the school profile card. Leave blank to hide." />
              <span style="font-size:11px;color:var(--muted)">Office landline, bursar, or admissions number - shown publicly on the WhatsApp profile card.</span>
            </div>
          </div>
        </div>

        <!-- ── SECTION 2: Academic Profile ────────────────────────────── -->
        <div style="margin-bottom:20px;padding-bottom:16px;border-bottom:1px solid var(--border)">
          <p style="font-weight:700;font-size:13px;margin-bottom:14px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px">2. Academic Profile</p>
          <div class="form-grid">
            <div class="fg">
              <label>School Type <span style="color:red">*</span></label>
              <select name="type" required>
                ${typeOptions}
              </select>
            </div>
            <div class="fg">
              <label>Gender Policy</label>
              <select name="gender">
                ${genderOptions}
              </select>
            </div>
            <div class="fg">
              <label>Boarding</label>
              <select name="boarding">
                ${boardingOptions}
              </select>
            </div>
            <div class="fg">
              <label>Grades From</label>
              <input name="gradesFrom" placeholder="e.g. ECD A" value="ECD A" />
            </div>
            <div class="fg">
              <label>Grades To</label>
              <input name="gradesTo" placeholder="e.g. Form 6" value="Form 6" />
            </div>
            <div class="fg">
              <label>Student Capacity</label>
              <input type="number" name="capacity" placeholder="e.g. 800" min="0" />
            </div>
          </div>

          <div class="fg full" style="margin-bottom:12px">
            <label>Curriculum (tick all that apply)</label>
            <div class="checkbox-grid">${curriculumChecks}</div>
          </div>
        </div>

        <!-- ── SECTION 3: Fees ─────────────────────────────────────────── -->
        <div style="margin-bottom:20px;padding-bottom:16px;border-bottom:1px solid var(--border)">
          <p style="font-weight:700;font-size:13px;margin-bottom:14px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px">3. Fees (USD)</p>
          <div class="form-grid">
            <div class="fg">
              <label>Term 1 Fee ($)</label>
              <input type="number" name="feesTerm1" placeholder="e.g. 800" min="0" step="0.01" />
            </div>
            <div class="fg">
              <label>Term 2 Fee ($)</label>
              <input type="number" name="feesTerm2" placeholder="e.g. 800" min="0" step="0.01" />
            </div>
            <div class="fg">
              <label>Term 3 Fee ($)</label>
              <input type="number" name="feesTerm3" placeholder="e.g. 750" min="0" step="0.01" />
            </div>
          </div>
          <p style="font-size:12px;color:var(--muted)">Leave blank if unknown. Fee range (budget/mid/premium) is computed automatically.</p>
        </div>

        <!-- ── SECTION 4: Facilities ───────────────────────────────────── -->
        <div style="margin-bottom:20px;padding-bottom:16px;border-bottom:1px solid var(--border)">
          <p style="font-weight:700;font-size:13px;margin-bottom:14px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px">4. Facilities (tick all that apply)</p>
          <div class="checkbox-grid">${facilityChecks}</div>
        </div>

        <!-- ── SECTION 5: Extramural ───────────────────────────────────── -->
        <div style="margin-bottom:20px;padding-bottom:16px;border-bottom:1px solid var(--border)">
          <p style="font-weight:700;font-size:13px;margin-bottom:14px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px">5. Extramural Activities (tick all that apply)</p>
          <div class="checkbox-grid">${extramuralChecks}</div>
        </div>

        <!-- ── SECTION 6: Online Registration ─────────────────────────── -->
        <div style="margin-bottom:20px;padding-bottom:16px;border-bottom:1px solid var(--border)">
          <p style="font-weight:700;font-size:13px;margin-bottom:14px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px">6. Online Application</p>
          <div class="fg full">
            <label>Online Application Link (optional)</label>
            <input name="registrationLink" placeholder="e.g. https://forms.gle/abc123 or https://stjohns.ac.zw/apply" />
            <span style="font-size:11px;color:var(--muted)">This link is sent to parents who tap "Apply Online" in WhatsApp search.</span>
          </div>
        </div>

        <!-- ── SECTION 7: Subscription & Activation ───────────────────── -->
        <div style="margin-bottom:20px;padding-bottom:16px;border-bottom:1px solid var(--border)">
          <p style="font-weight:700;font-size:13px;margin-bottom:14px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px">7. Subscription & Activation</p>
          <div class="form-grid">
            <div class="fg">
              <label>Plan / Tier</label>
              <select name="tier" required>
                <option value="basic">✅ Basic - $15/month</option>
                <option value="featured">🔥 Featured - $35/month</option>
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
              <label>Duration (days)</label>
              <input type="number" name="durationDays" value="30" min="1" max="365" />
            </div>
            <div class="fg">
              <label>Set Active Immediately?</label>
              <select name="setActive">
                <option value="true">✅ Yes - visible to parents now</option>
                <option value="false">⏸ No - save as inactive</option>
              </select>
            </div>
            <div class="fg">
              <label>Admissions Open?</label>
              <select name="admissionsOpen">
                <option value="true">🟢 Yes - currently accepting</option>
                <option value="false">🔴 No - closed</option>
              </select>
            </div>
            <div class="fg">
              <label>Mark as Verified?</label>
              <select name="verified">
                <option value="false">No</option>
                <option value="true">✅ Yes - show verified badge</option>
              </select>
            </div>
          </div>
        </div>

        <!-- ── SECTION 8: Admin Note ───────────────────────────────────── -->
        <div class="fg full" style="margin-bottom:20px">
          <label>Admin Note (internal only)</label>
          <textarea name="adminNote" rows="2"
            placeholder="e.g. Registered at education expo, paid cash, free trial..."></textarea>
        </div>

        <div class="form-actions">
          <button type="submit" class="btn btn-green">✅ Register School</button>
          <a href="/zq-admin/schools" class="btn btn-gray">Cancel</a>
        </div>
      </form>
    </div>
  `));
});

// ─────────────────────────────────────────────────────────────────────────────
// REGISTER NEW SCHOOL (POST handler)
// POST /zq-admin/schools/new
// ─────────────────────────────────────────────────────────────────────────────
router.post("/schools/new", requireSupplierAdmin, async (req, res) => {
  try {
    const {
      schoolName, phone, contactPhone, city, suburb, address, email, website,
      principalName, type, gender, boarding, gradesFrom, gradesTo,
      capacity, curriculum, facilities, extramuralActivities,
      feesTerm1, feesTerm2, feesTerm3,
      registrationLink, tier, billingCycle, durationDays,
      setActive, admissionsOpen, verified, adminNote
    } = req.body;

    if (!schoolName?.trim()) throw new Error("School name is required.");
    if (!phone?.trim())      throw new Error("Phone number is required.");
    if (!city?.trim())       throw new Error("City is required.");
    if (!suburb?.trim())     throw new Error("Suburb / area is required.");

    const cleanPhone = phone.trim().replace(/\s+/g, "");

    const existing = await SchoolProfile.findOne({ phone: cleanPhone });
    if (existing) {
      return res.redirect(
        `/zq-admin/schools/new?error=${encodeURIComponent(
          "A school with phone " + cleanPhone + " already exists."
        )}`
      );
    }

    const now       = new Date();
    const days      = Number(durationDays) || 30;
    const expiresAt = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
    const isActive  = setActive === "true";

    // Parse fees
// Parse fees
    const t1 = parseFloat(feesTerm1) || 0;
    const t2 = parseFloat(feesTerm2) || t1;
    const t3 = parseFloat(feesTerm3) || t1;
    // ── Section-based fee parsing ─────────────────────────────────────────────
    const SECTIONS = ["ecd","lowerPrimary","upperPrimary","primary","olevel","alevel"];
    const feeSections = {};
    for (const sec of SECTIONS) {
      const dt1 = parseFloat(req.body["feeDay_"+sec+"_t1"]) || 0;
      const dt2 = parseFloat(req.body["feeDay_"+sec+"_t2"]) || dt1;
      const dt3 = parseFloat(req.body["feeDay_"+sec+"_t3"]) || dt1;
      const bt1 = parseFloat(req.body["feeBrd_"+sec+"_t1"]) || 0;
      const bt2 = parseFloat(req.body["feeBrd_"+sec+"_t2"]) || bt1;
      const bt3 = parseFloat(req.body["feeBrd_"+sec+"_t3"]) || bt1;
      feeSections[sec] = { day: { term1: dt1, term2: dt2, term3: dt3 }, boarding: { term1: bt1, term2: bt2, term3: bt3 } };
    }
    const admissionFeeVal = parseFloat(req.body.admissionFee) || 0;
    const levies = [];
    for (const [key, name, per] of [["levyDevelopment","Development","term"],["levySports","Sports","year"],["levyIT","IT / Computer","year"],["levyLibrary","Library","year"],["levyExam","Exam","year"]]) {
      const amt = parseFloat(req.body[key]) || 0;
      if (amt > 0) levies.push({ name, amount: amt, per, sections: [] });
    }
    const repSec = feeSections.primary?.day?.term1 > 0 ? feeSections.primary.day :
                   feeSections.olevel?.day?.term1  > 0 ? feeSections.olevel.day  :
                   feeSections.upperPrimary?.day?.term1 > 0 ? feeSections.upperPrimary.day :
                   feeSections.lowerPrimary?.day?.term1 > 0 ? feeSections.lowerPrimary.day :
                   feeSections.ecd?.day?.term1     > 0 ? feeSections.ecd.day     :
                   { term1: t1, term2: t2, term3: t3 };
    const brdSec = feeSections.olevel?.boarding?.term1 > 0 ? feeSections.olevel.boarding :
                   feeSections.primary?.boarding?.term1 > 0 ? feeSections.primary.boarding : null;
    const fees = {
      term1: repSec.term1, term2: repSec.term2 || repSec.term1, term3: repSec.term3 || repSec.term1,
      currency: "USD",
      boardingTerm1: brdSec?.term1 || 0, boardingTerm2: brdSec?.term2 || 0, boardingTerm3: brdSec?.term3 || 0,
      ecdTerm1: feeSections.ecd?.day?.term1 || 0, ecdTerm2: feeSections.ecd?.day?.term2 || 0, ecdTerm3: feeSections.ecd?.day?.term3 || 0
    };
    const feeRange = computeSchoolFeeRange(repSec.term1);

    // Normalise checkbox arrays (single value comes as string, multiple as array)
    const curriculumArr         = curriculum         ? (Array.isArray(curriculum)         ? curriculum         : [curriculum])         : [];
    const facilitiesArr         = facilities         ? (Array.isArray(facilities)         ? facilities         : [facilities])         : [];
    const extramuralArr         = extramuralActivities ? (Array.isArray(extramuralActivities) ? extramuralActivities : [extramuralActivities]) : [];

    const school = await SchoolProfile.create({
      schoolName:           schoolName.trim(),
      phone:                cleanPhone,
      contactPhone:         contactPhone?.trim() || "",
      city:                 city.trim(),
      suburb:               suburb.trim(),
      address:              address?.trim() || "",
      email:                email?.trim() || "",
      website:              website?.trim() || "",
      principalName:        principalName?.trim() || "",
      type:                 type || "combined",
      gender:               gender || "mixed",
      boarding:             boarding || "day",
      grades: {
        from: gradesFrom?.trim() || "ECD A",
        to:   gradesTo?.trim()   || "Form 6"
      },
      capacity:             Number(capacity) || 0,
      curriculum:           curriculumArr,
      fees,
      feeRange,
      facilities:           facilitiesArr,
      extramuralActivities: extramuralArr,
      registrationLink:     registrationLink?.trim() || "",
      admissionsOpen:       admissionsOpen === "true",
      verified:             verified === "true",
      active:               isActive,
      tier:                 tier || "basic",
      subscriptionPlan:     billingCycle || "monthly",
      subscriptionEndsAt:   expiresAt,
      adminNote: adminNote?.trim()
        ? `[Admin registered on ${now.toDateString()}] ${adminNote.trim()}`
        : `[Admin registered on ${now.toDateString()}]`
    });

    // Log a $0 subscription payment record
    await SchoolSubscriptionPayment.create({
      phone:     cleanPhone,
      schoolId:  school._id,
      tier:      tier || "basic",
      plan:      billingCycle || "monthly",
      amount:    0,
      currency:  "USD",
      reference: `ADMIN_REG_${school._id}_${Date.now()}`,
      status:    "paid",
      paidAt:    now,
      endsAt:    expiresAt
    });

    res.redirect(
      `/zq-admin/schools/${school._id}?success=${encodeURIComponent("School registered successfully!")}`
    );
  } catch (err) {
    res.redirect(
      `/zq-admin/schools/new?error=${encodeURIComponent(err.message)}`
    );
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// SCHOOL DETAIL PAGE
// GET /zq-admin/schools/:id
// ─────────────────────────────────────────────────────────────────────────────
router.get("/schools/:id", requireSupplierAdmin, async (req, res) => {
  try {
    const school = await SchoolProfile.findById(req.params.id).lean();
    if (!school) return res.redirect("/zq-admin/schools");

    const payments = await SchoolSubscriptionPayment.find({
      $or: [{ schoolId: school._id }, { phone: school.phone }]
    }).sort({ createdAt: -1 }).lean();

    const successMsg = req.query.success
      ? `<div style="background:#dcfce7;color:#16a34a;padding:14px;border-radius:8px;margin-bottom:16px">✅ ${esc(req.query.success)}</div>`
      : "";

    const facilitiesText = (school.facilities || [])
      .map(id => SCHOOL_FACILITIES.find(f => f.id === id)?.label || id)
      .join(" · ") || "None";

    const extramuralText = (school.extramuralActivities || [])
      .map(id => SCHOOL_EXTRAMURALACTIVITIES.find(e => e.id === id)?.label || id)
      .join(" · ") || "None";

    const curriculumText = (school.curriculum || [])
      .map(id => SCHOOL_CURRICULA.find(c => c.id === id)?.label || id.toUpperCase())
      .join(" + ") || "Not set";

    const renewDate = school.subscriptionEndsAt
      ? new Date(school.subscriptionEndsAt).toDateString()
      : "N/A";

    res.send(layout(esc(school.schoolName), `
      <a href="/zq-admin/schools" class="back-link">← Back to Schools</a>
      ${successMsg}

      <div class="two-col">
        <div class="panel">
          <div class="panel-head">
            <h3>🏫 School Profile</h3>
            <a href="/zq-admin/schools/${school._id}/edit" class="btn btn-blue btn-sm">✏️ Edit</a>
          </div>
          <dl class="detail-list">
            <dt>School Name</dt><dd><strong>${esc(school.schoolName)}</strong>${school.verified ? " ✅ Verified" : ""}</dd>
            <dt>Phone (login)</dt><dd>${esc(school.phone)}</dd>
            <dt>Contact Phone</dt><dd>${esc(school.contactPhone || "-")}</dd>
            <dt>Email</dt><dd>${esc(school.email || "-")}</dd>
            <dt>Website</dt><dd>${esc(school.website || "-")}</dd>
            <dt>Location</dt><dd>${esc(school.suburb || "")}, ${esc(school.city)}</dd>
            <dt>Address</dt><dd>${esc(school.address || "-")}</dd>
            <dt>Principal</dt><dd>${esc(school.principalName || "-")}</dd>
            <dt>Type</dt><dd>${esc(school.type || "-")}</dd>
            <dt>Gender</dt><dd>${esc(school.gender || "-")}</dd>
            <dt>Boarding</dt><dd>${esc(school.boarding || "-")}</dd>
            <dt>Grades</dt><dd>${esc(school.grades?.from || "ECD A")} – ${esc(school.grades?.to || "Form 6")}</dd>
            <dt>Curriculum</dt><dd>${esc(curriculumText)}</dd>
          <dt>Day Fees / Term</dt><dd>$${school.fees?.term1 || 0} / $${school.fees?.term2 || 0} / $${school.fees?.term3 || 0} USD
              <span class="badge badge-${school.feeRange === 'budget' ? 'green' : school.feeRange === 'premium' ? 'orange' : 'blue'}" style="margin-left:6px">${esc(school.feeRange || "-")}</span>
            </dd>
            ${(school.fees?.boardingTerm1 || 0) > 0 ? `<dt>Boarding Fees / Term</dt><dd>$${school.fees.boardingTerm1} / $${school.fees.boardingTerm2} / $${school.fees.boardingTerm3} USD</dd>` : ""}
            ${(school.fees?.ecdTerm1 || 0) > 0 ? `<dt>ECD Fees / Term</dt><dd>$${school.fees.ecdTerm1} / $${school.fees.ecdTerm2} / $${school.fees.ecdTerm3} USD</dd>` : ""}
            <dt>Plan</dt><dd>${badge(school.tier || "none", tierColor(school.tier))}</dd>
            <dt>Status</dt><dd>${badge(school.active ? 'Active' : 'Inactive', school.active ? 'green' : 'gray')}</dd>
            <dt>Admissions</dt><dd>${school.admissionsOpen ? "🟢 Open" : "🔴 Closed"}</dd>
            <dt>Subscription Ends</dt><dd>${renewDate}</dd>
            <dt>Rating</dt><dd>⭐ ${(school.rating || 0).toFixed(1)} (${school.reviewCount || 0} reviews)</dd>
            <dt>Views (month)</dt><dd>${school.monthlyViews || 0}</dd>
            <dt>Inquiries</dt><dd>${school.inquiries || 0}</dd>
            <dt>Registered</dt><dd>${new Date(school.createdAt).toDateString()}</dd>
            ${school.registrationLink ? `<dt>Apply Link</dt><dd><a href="${esc(school.registrationLink)}" target="_blank" class="btn-link">${esc(school.registrationLink)}</a></dd>` : ""}
            ${school.adminNote ? `<dt>Admin Note</dt><dd class="admin-note">${esc(school.adminNote)}</dd>` : ""}
          </dl>

          <div class="action-row">
            <form method="POST" action="/zq-admin/schools/${school._id}/toggle-active" style="display:inline">
              <button class="btn ${school.active ? 'btn-orange' : 'btn-green'}">
                ${school.active ? "⏸ Deactivate" : "✅ Activate"}
              </button>
            </form>
            <form method="POST" action="/zq-admin/schools/${school._id}/toggle-admissions" style="display:inline">
              <button class="btn ${school.admissionsOpen ? 'btn-gray' : 'btn-green'}">
                ${school.admissionsOpen ? "🔴 Close Admissions" : "🟢 Open Admissions"}
              </button>
            </form>
            <form method="POST" action="/zq-admin/schools/${school._id}/toggle-verified" style="display:inline">
              <button class="btn ${school.verified ? 'btn-orange' : 'btn-blue'}">
                ${school.verified ? "❌ Remove Verified" : "✅ Mark Verified"}
              </button>
            </form>
            <a href="/zq-admin/schools/${school._id}/activate" class="btn btn-green">
              🎁 Manual Activation
            </a>
            <a href="/zq-admin/schools/${school._id}/smartcard" class="btn btn-teal">
              🔗 Smart Card
            </a>
          </div>
        </div>

        <!-- ── Brochures panel ── -->
          <div class="panel">
            <div class="panel-head">
              <h3>📄 Brochures & Documents</h3>
            </div>

            ${(school.brochures || []).length ? `
            <table style="margin-bottom:14px">
              <thead><tr><th>Label</th><th>URL</th><th>Added</th><th></th></tr></thead>
              <tbody>
                ${(school.brochures || []).map((b, i) => `
                <tr>
                  <td><strong>${esc(b.label)}</strong></td>
                  <td><a href="${esc(b.url)}" target="_blank" class="btn-link" style="font-size:12px">View →</a></td>
                  <td style="color:var(--muted);font-size:12px">${new Date(b.addedAt).toLocaleDateString()}</td>
                  <td>
                    <form method="POST" action="/zq-admin/schools/${school._id}/brochure/${i}/delete" style="display:inline" onsubmit="return confirm('Remove this brochure?')">
                      <button class="btn btn-sm" style="background:#fef2f2;color:#dc2626;border:1px solid #fecaca;padding:4px 10px;font-size:11px">Remove</button>
                    </form>
                  </td>
                </tr>`).join("")}
              </tbody>
            </table>` : `<p class="muted" style="font-size:13px;margin-bottom:14px">No brochures uploaded yet.</p>`}

           <form method="POST" action="/zq-admin/schools/${school._id}/brochure/add" enctype="multipart/form-data" style="display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap">
              <div class="fg" style="flex:1;min-width:160px">
                <label style="font-size:11px;color:var(--muted);display:block;margin-bottom:4px">Label</label>
                <input name="label" placeholder="e.g. 2025 Prospectus" style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;font-size:13px" required />
              </div>
              <div class="fg" style="flex:2;min-width:240px">
                <label style="font-size:11px;color:var(--muted);display:block;margin-bottom:4px">PDF File</label>
                <input name="brochureFile" type="file" accept=".pdf,application/pdf" style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:6px;font-size:13px;background:var(--surface2);color:var(--text)" required />
              </div>
              <button type="submit" class="btn btn-blue btn-sm" style="white-space:nowrap">⬆ Upload PDF</button>
            </form>
            <p style="font-size:11px;color:var(--muted);margin-top:8px">📁 PDF is stored on the server and sent directly to parents on WhatsApp — no Google Drive or data needed.</p>
            <p style="font-size:11px;color:var(--muted);margin-top:4px">⚠ Max file size: 10MB. Keep PDFs under 5MB for best WhatsApp delivery.</p>
          </div>
        <div>
          <div class="panel">
            <h3>🏊 Facilities (${(school.facilities || []).length})</h3>
            <p style="font-size:13px;line-height:1.8">${esc(facilitiesText)}</p>
          </div>
          <div class="panel">
            <h3>🏃 Extramural (${(school.extramuralActivities || []).length})</h3>
            <p style="font-size:13px;line-height:1.8">${esc(extramuralText)}</p>
          </div>
        </div>
      </div>

      <div class="panel">
        <h3>💳 Subscription Payments</h3>
        ${payments.length ? `
        <table>
         <thead><tr><th>Plan</th><th>Amount</th><th>Status</th><th>Paid</th><th>Expires</th><th>Receipt</th></tr></thead>
<tbody>
  ${payments.map(p => `
  <tr>
    <td>${esc(p.tier)} / ${esc(p.plan)}</td>
    <td>
      $${Number(p.amount || 0).toFixed(2)}
      ${p.discountPercent ? `<div style="font-size:11px;color:var(--muted)">-${Number(p.discountPercent).toFixed(2)}% discount</div>` : ""}
    </td>
    <td>${badge(p.status, p.status === 'paid' ? 'green' : 'gray')}</td>
    <td>${p.paidAt ? new Date(p.paidAt).toLocaleDateString() : "-"}</td>
    <td>${p.endsAt ? new Date(p.endsAt).toLocaleDateString() : "-"}</td>
    <td>
      ${p.receiptUrl
        ? `<a href="${esc(p.receiptUrl)}" target="_blank" class="btn-link">View Receipt</a>`
        : "-"}
    </td>
  </tr>`).join("")}
</tbody>
        </table>` : "<em class='muted'>No payments yet.</em>"}
      </div>
    `));
  } catch (err) {
    res.send(layout("Error", `<div class="alert red">${err.message}</div>`));
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// EDIT SCHOOL (GET form)
// GET /zq-admin/schools/:id/edit
// ─────────────────────────────────────────────────────────────────────────────
router.get("/schools/:id/edit", requireSupplierAdmin, async (req, res) => {
  try {
    const school = await SchoolProfile.findById(req.params.id).lean();
    if (!school) return res.redirect("/zq-admin/schools");

    const cityOptions = SCHOOL_CITIES.map(c =>
      `<option value="${esc(c)}" ${school.city === c ? "selected" : ""}>${esc(c)}</option>`
    ).join("");

    const typeOptions = SCHOOL_TYPES.map(t =>
      `<option value="${esc(t.id)}" ${school.type === t.id ? "selected" : ""}>${esc(t.label)}</option>`
    ).join("");

    const genderOptions = SCHOOL_GENDERS.map(g =>
      `<option value="${esc(g.id)}" ${school.gender === g.id ? "selected" : ""}>${esc(g.label)}</option>`
    ).join("");

    const boardingOptions = SCHOOL_BOARDING.map(b =>
      `<option value="${esc(b.id)}" ${school.boarding === b.id ? "selected" : ""}>${esc(b.label)}</option>`
    ).join("");

    const curriculumChecks = SCHOOL_CURRICULA.map(c => `
      <label>
        <input type="checkbox" name="curriculum" value="${esc(c.id)}"
               ${(school.curriculum || []).includes(c.id) ? "checked" : ""} />
        ${esc(c.label)}
      </label>`).join("");

    const facilityChecks = SCHOOL_FACILITIES.map(f => `
      <label>
        <input type="checkbox" name="facilities" value="${esc(f.id)}"
               ${(school.facilities || []).includes(f.id) ? "checked" : ""} />
        ${esc(f.label)}
      </label>`).join("");

    const extramuralChecks = SCHOOL_EXTRAMURALACTIVITIES.map(e => `
      <label>
        <input type="checkbox" name="extramuralActivities" value="${esc(e.id)}"
               ${(school.extramuralActivities || []).includes(e.id) ? "checked" : ""} />
        ${esc(e.label)}
      </label>`).join("");

    const expiryVal = school.subscriptionEndsAt
      ? new Date(school.subscriptionEndsAt).toISOString().split("T")[0]
      : "";

    const errorMsg   = req.query.error   ? `<div class="alert red" style="margin-bottom:16px">❌ ${esc(req.query.error)}</div>` : "";
    const successMsg = req.query.success ? `<div style="background:#dcfce7;color:#16a34a;padding:14px;border-radius:8px;margin-bottom:16px">✅ ${esc(req.query.success)}</div>` : "";

    res.send(layout(`Edit: ${esc(school.schoolName)}`, `
      <a href="/zq-admin/schools/${school._id}" class="back-link">← Back to Profile</a>
      ${errorMsg}${successMsg}

      <div class="panel" style="max-width:900px">
        <h3>✏️ Edit School: ${esc(school.schoolName)}</h3>

        <form method="POST" action="/zq-admin/schools/${school._id}/edit" class="edit-form">

          <!-- ── Basic Info ──────────────────────────────────────────── -->
          <p style="font-weight:700;font-size:13px;margin-bottom:14px;margin-top:8px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px">Basic Info</p>
          <div class="form-grid">
            <div class="fg"><label>School Name</label><input name="schoolName" value="${esc(school.schoolName)}" required /></div>
            <div class="fg"><label>Phone (login / WhatsApp)</label><input name="phone" value="${esc(school.phone)}" required /></div>
            <div class="fg"><label>Contact Phone (shown to parents)</label><input name="contactPhone" value="${esc(school.contactPhone || '')}" placeholder="e.g. 0242123456" /></div>
            <div class="fg">
              <label>City</label>
              <select name="city" required>
                <option value="">Select city...</option>
                ${cityOptions}
                <option value="${esc(school.city)}" selected>${esc(school.city)}</option>
              </select>
            </div>
            <div class="fg"><label>Suburb / Area</label><input name="suburb" value="${esc(school.suburb || '')}" required /></div>
            <div class="fg"><label>Address</label><input name="address" value="${esc(school.address || '')}" /></div>
            <div class="fg"><label>Email</label><input name="email" type="email" value="${esc(school.email || '')}" /></div>
            <div class="fg"><label>Website</label><input name="website" value="${esc(school.website || '')}" /></div>
            <div class="fg"><label>Principal</label><input name="principalName" value="${esc(school.principalName || '')}" /></div>
          </div>

          <!-- ── Academic ────────────────────────────────────────────── -->
          <p style="font-weight:700;font-size:13px;margin-bottom:14px;margin-top:20px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px">Academic Profile</p>
          <div class="form-grid">
            <div class="fg"><label>School Type</label><select name="type">${typeOptions}</select></div>
            <div class="fg"><label>Gender</label><select name="gender">${genderOptions}</select></div>
            <div class="fg"><label>Boarding</label><select name="boarding">${boardingOptions}</select></div>
            <div class="fg"><label>Grades From</label><input name="gradesFrom" value="${esc(school.grades?.from || 'ECD A')}" /></div>
            <div class="fg"><label>Grades To</label><input name="gradesTo" value="${esc(school.grades?.to || 'Form 6')}" /></div>
            <div class="fg"><label>Capacity</label><input type="number" name="capacity" value="${school.capacity || 0}" min="0" /></div>
          </div>
          <div class="fg full" style="margin-bottom:14px">
            <label>Curriculum</label>
            <div class="checkbox-grid">${curriculumChecks}</div>
          </div>

          <!-- ── Fees (Section-based) ───────────────────────────────── -->
          <p style="font-weight:700;font-size:13px;margin-bottom:6px;margin-top:20px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px">Fee Schedule (USD per term)</p>
          <p style="font-size:12px;color:var(--muted);margin-bottom:14px">
            Enter fees for each section your school has. Leave at 0 for sections that don't apply.
            Boarding fees only apply for boarding or day-and-boarding schools.
            These appear directly in parent enquiry answers — keep them up to date.
          </p>

          ${["ecd","lowerPrimary","upperPrimary","primary","olevel","alevel"].map(sec => {
            const LABELS = { ecd:"ECD / Preschool", lowerPrimary:"Lower Primary (Grades 1–4)", upperPrimary:"Upper Primary (Grades 5–7)", primary:"Primary (Grades 1–7)", olevel:"O-Level (Form 1–4)", alevel:"A-Level (Form 5–6)" };
            const ICONS  = { ecd:"🌱", lowerPrimary:"📗", upperPrimary:"📗", primary:"📗", olevel:"📙", alevel:"📘" };
            const d = school.feeSections?.[sec]?.day || {};
            const b = school.feeSections?.[sec]?.boarding || {};
            const hasBoarding = school.boarding === "boarding" || school.boarding === "both";
            return `
            <div style="background:var(--bg);border-radius:10px;padding:14px;margin-bottom:12px;border:.5px solid var(--border)">
              <p style="font-size:13px;font-weight:600;margin-bottom:10px">${ICONS[sec]} ${LABELS[sec]} <span style="font-weight:400;font-size:11px;color:var(--muted)">— Day fees per term</span></p>
              <div class="form-grid" style="margin-bottom:${hasBoarding?8:0}px">
                <div class="fg" style="margin-bottom:0"><label>Term 1 ($)</label><input type="number" name="feeDay_${sec}_t1" value="${d.term1||0}" min="0" step="0.01" /></div>
                <div class="fg" style="margin-bottom:0"><label>Term 2 ($)</label><input type="number" name="feeDay_${sec}_t2" value="${d.term2||0}" min="0" step="0.01" /></div>
                <div class="fg" style="margin-bottom:0"><label>Term 3 ($)</label><input type="number" name="feeDay_${sec}_t3" value="${d.term3||0}" min="0" step="0.01" /></div>
              </div>
              ${hasBoarding ? `
              <p style="font-size:12px;font-weight:600;margin:10px 0 6px;color:var(--muted)">🏠 Boarding fees for this section <span style="font-weight:400">(leave 0 if no boarding for this section)</span></p>
              <div class="form-grid">
                <div class="fg" style="margin-bottom:0"><label>Boarding T1 ($)</label><input type="number" name="feeBrd_${sec}_t1" value="${b.term1||0}" min="0" step="0.01" /></div>
                <div class="fg" style="margin-bottom:0"><label>Boarding T2 ($)</label><input type="number" name="feeBrd_${sec}_t2" value="${b.term2||0}" min="0" step="0.01" /></div>
                <div class="fg" style="margin-bottom:0"><label>Boarding T3 ($)</label><input type="number" name="feeBrd_${sec}_t3" value="${b.term3||0}" min="0" step="0.01" /></div>
              </div>` : ""}
            </div>`;
          }).join("")}

          <p style="font-size:13px;font-weight:600;margin:14px 0 8px">💳 Additional Levies <span style="font-weight:400;font-size:12px;color:var(--muted)">(optional — shown to parents)</span></p>
          <div class="form-grid">
            <div class="fg"><label>Development levy ($/term)</label><input type="number" name="levyDevelopment" value="${(school.levies||[]).find(l=>l.name.toLowerCase().includes("develop"))?.amount||0}" min="0" step="0.01" /></div>
            <div class="fg"><label>Sports levy ($/year)</label><input type="number" name="levySports" value="${(school.levies||[]).find(l=>l.name.toLowerCase().includes("sport"))?.amount||0}" min="0" step="0.01" /></div>
            <div class="fg"><label>IT / Computer levy ($/year)</label><input type="number" name="levyIT" value="${(school.levies||[]).find(l=>l.name.toLowerCase().includes("it")||l.name.toLowerCase().includes("computer"))?.amount||0}" min="0" step="0.01" /></div>
            <div class="fg"><label>Library levy ($/year)</label><input type="number" name="levyLibrary" value="${(school.levies||[]).find(l=>l.name.toLowerCase().includes("library"))?.amount||0}" min="0" step="0.01" /></div>
            <div class="fg"><label>Exam fees ($/year)</label><input type="number" name="levyExam" value="${(school.levies||[]).find(l=>l.name.toLowerCase().includes("exam"))?.amount||0}" min="0" step="0.01" /></div>
            <div class="fg"><label>Admission / Reg fee (once-off)</label><input type="number" name="admissionFee" value="${school.admissionFee||0}" min="0" step="0.01" /></div>
          </div>

          <!-- ── Facilities ──────────────────────────────────────────── -->
          <p style="font-weight:700;font-size:13px;margin-bottom:14px;margin-top:20px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px">Facilities</p>
          <div class="checkbox-grid">${facilityChecks}</div>

          <!-- ── Extramural ──────────────────────────────────────────── -->
          <p style="font-weight:700;font-size:13px;margin-bottom:14px;margin-top:20px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px">Extramural Activities</p>
          <div class="checkbox-grid">${extramuralChecks}</div>

          <!-- ── Application & Settings ─────────────────────────────── -->
          <p style="font-weight:700;font-size:13px;margin-bottom:14px;margin-top:20px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px">Settings</p>
          <div class="form-grid">
            <div class="fg">
              <label>Plan</label>
              <select name="tier">
                <option value="basic"    ${school.tier === "basic"    ? "selected" : ""}>Basic - $15/month</option>
                <option value="featured" ${school.tier === "featured" ? "selected" : ""}>Featured - $35/month</option>
              </select>
            </div>
            <div class="fg">
              <label>Subscription Ends</label>
              <input type="date" name="subscriptionEndsAt" value="${expiryVal}" />
            </div>
            <div class="fg">
              <label>Active</label>
              <select name="active">
                <option value="true"  ${school.active ? "selected" : ""}>✅ Yes</option>
                <option value="false" ${!school.active ? "selected" : ""}>⏸ No</option>
              </select>
            </div>
            <div class="fg">
              <label>Admissions Open</label>
              <select name="admissionsOpen">
                <option value="true"  ${school.admissionsOpen ? "selected" : ""}>🟢 Yes</option>
                <option value="false" ${!school.admissionsOpen ? "selected" : ""}>🔴 No</option>
              </select>
            </div>
            <div class="fg">
              <label>Verified</label>
              <select name="verified">
                <option value="false" ${!school.verified ? "selected" : ""}>No</option>
                <option value="true"  ${school.verified  ? "selected" : ""}>✅ Yes</option>
              </select>
            </div>
          </div>
          <div class="fg full" style="margin-bottom:14px;margin-top:10px">
            <label>Online Application Link</label>
            <input name="registrationLink" value="${esc(school.registrationLink || '')}" placeholder="https://forms.gle/..." />
          </div>
          <div class="fg full" style="margin-bottom:20px">
            <label>Admin Note (internal)</label>
            <textarea name="adminNote" rows="2">${esc(school.adminNote || "")}</textarea>
          </div>

          <div class="form-actions">
            <button type="submit" class="btn btn-blue">💾 Save Changes</button>
            <a href="/zq-admin/schools/${school._id}" class="btn btn-gray">Cancel</a>
          </div>
        </form>
      </div>
    `));
  } catch (err) {
    res.send(layout("Error", `<div class="alert red">${err.message}</div>`));
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// EDIT SCHOOL (POST handler)
// POST /zq-admin/schools/:id/edit
// ─────────────────────────────────────────────────────────────────────────────
router.post("/schools/:id/edit", requireSupplierAdmin, async (req, res) => {
  try {
    const school = await SchoolProfile.findById(req.params.id);
    if (!school) return res.redirect("/zq-admin/schools");

 const {
      schoolName, phone, contactPhone, city, suburb, address, email, website,
      principalName, type, gender, boarding, gradesFrom, gradesTo,
      capacity, curriculum, facilities, extramuralActivities,
      feesTerm1, feesTerm2, feesTerm3,
      feesBoarding1, feesBoarding2, feesBoarding3,
      feesEcd1, feesEcd2, feesEcd3,
      registrationLink, tier, subscriptionEndsAt,
      active, admissionsOpen, verified, adminNote
    } = req.body;

    const t1 = parseFloat(feesTerm1) || 0;
    const t2 = parseFloat(feesTerm2) || t1;
    const t3 = parseFloat(feesTerm3) || t1;
    const b1 = parseFloat(feesBoarding1) || 0;
    const b2 = parseFloat(feesBoarding2) || b1;
    const b3 = parseFloat(feesBoarding3) || b1;
    const e1 = parseFloat(feesEcd1) || 0;
    const e2 = parseFloat(feesEcd2) || e1;
    const e3 = parseFloat(feesEcd3) || e1;

    const curriculumArr = curriculum
      ? (Array.isArray(curriculum) ? curriculum : [curriculum]) : [];
    const facilitiesArr = facilities
      ? (Array.isArray(facilities) ? facilities : [facilities]) : [];
    const extramuralArr = extramuralActivities
      ? (Array.isArray(extramuralActivities) ? extramuralActivities : [extramuralActivities]) : [];

    school.schoolName           = schoolName?.trim() || school.schoolName;
    school.phone                = phone?.trim().replace(/\s+/g, "") || school.phone;
    school.contactPhone         = contactPhone?.trim() || "";
    school.city                 = city?.trim() || school.city;
    school.suburb               = suburb?.trim() || school.suburb;
    school.address              = address?.trim() || "";
    school.email                = email?.trim() || "";
    school.website              = website?.trim() || "";
    school.principalName        = principalName?.trim() || "";
    school.type                 = type || school.type;
    school.gender               = gender || school.gender;
    school.boarding             = boarding || school.boarding;
    school.grades               = { from: gradesFrom?.trim() || "ECD A", to: gradesTo?.trim() || "Form 6" };
    school.capacity             = Number(capacity) || 0;
    school.curriculum           = curriculumArr;
  school.fees = {
      term1: t1, term2: t2, term3: t3, currency: "USD",
      boardingTerm1: b1, boardingTerm2: b2, boardingTerm3: b3,
      ecdTerm1: e1, ecdTerm2: e2, ecdTerm3: e3
    };
    school.feeRange             = computeSchoolFeeRange(t1);
    school.facilities           = facilitiesArr;
    school.extramuralActivities = extramuralArr;
    school.registrationLink     = registrationLink?.trim() || "";
    school.tier                 = tier || school.tier;
    school.active               = active === "true";
    school.admissionsOpen       = admissionsOpen === "true";
    school.verified             = verified === "true";
    school.adminNote            = adminNote?.trim() || school.adminNote;

    if (subscriptionEndsAt) {
      school.subscriptionEndsAt = new Date(subscriptionEndsAt);
    }

    await school.save();

    res.redirect(
      `/zq-admin/schools/${school._id}?success=${encodeURIComponent("School updated successfully!")}`
    );
  } catch (err) {
    res.redirect(
      `/zq-admin/schools/${req.params.id}/edit?error=${encodeURIComponent(err.message)}`
    );
  }
});


// ─────────────────────────────────────────────────────────────────────────────
// ADD BROCHURE
// POST /zq-admin/schools/:id/brochure/add
// ─────────────────────────────────────────────────────────────────────────────
router.post("/schools/:id/brochure/add",
  requireSupplierAdmin,
  brochureUpload.single("brochureFile"),
  async (req, res) => {
    try {
      const school = await SchoolProfile.findById(req.params.id);
      if (!school) return res.redirect("/zq-admin/schools");

      if (!req.file) throw new Error("Please select a PDF file to upload.");

      const label    = (req.body.label?.trim()) || "School Brochure";
      const filename = `${school._id}_${Date.now()}.pdf`;
      const bucket   = getBucket();

      // ── Stream the buffer into GridFS ─────────────────────────────────────
      await new Promise((resolve, reject) => {
        const uploadStream = bucket.openUploadStream(filename, {
          contentType: "application/pdf",
          metadata: {
            schoolId:   school._id.toString(),
            schoolName: school.schoolName,
            label
          }
        });
        uploadStream.on("finish", resolve);
        uploadStream.on("error",  reject);
        uploadStream.end(req.file.buffer);
      });

      // ── Build the serving URL ─────────────────────────────────────────────
      // This URL is served by the GET route below — publicly accessible
      const baseUrl  = process.env.APP_BASE_URL || `https://${req.headers.host}`;
      const fileUrl  = `${baseUrl}/zq-admin/schools/brochure/${filename}`;

      school.brochures = school.brochures || [];
      school.brochures.push({ label, url: fileUrl, addedAt: new Date() });
      await school.save();

      const sizeMB = (req.file.size / 1024 / 1024).toFixed(2);
      res.redirect(`/zq-admin/schools/${req.params.id}?success=` +
        encodeURIComponent(`"${label}" uploaded (${sizeMB} MB). Parents can now download it on WhatsApp.`));

    } catch (err) {
      res.redirect(`/zq-admin/schools/${req.params.id}?error=${encodeURIComponent(err.message)}`);
    }
  }
);




// ── GET /zq-admin/schools/brochure/:filename ──────────────────────────────────
// Serves the PDF directly — no login required so WhatsApp/Meta can fetch it
// and parents receive it as a native WhatsApp document
router.get("/schools/brochure/:filename", async (req, res) => {
  try {
    const bucket = getBucket();
    const files  = await bucket.find({ filename: req.params.filename }).toArray();

    if (!files || files.length === 0) {
      return res.status(404).send("File not found.");
    }

    const file = files[0];
    res.setHeader("Content-Type",        "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="${file.filename}"`);
    res.setHeader("Cache-Control",       "public, max-age=86400"); // cache 24h

    const downloadStream = bucket.openDownloadStreamByName(req.params.filename);
    downloadStream.on("error", () => res.status(404).send("File not found."));
    downloadStream.pipe(res);

  } catch (err) {
    console.error("[Brochure Serve]", err.message);
    res.status(500).send("Error serving file.");
  }
});
// ─────────────────────────────────────────────────────────────────────────────
// DELETE BROCHURE
// POST /zq-admin/schools/:id/brochure/:index/delete
// ─────────────────────────────────────────────────────────────────────────────
router.post("/schools/:id/brochure/:index/delete", requireSupplierAdmin, async (req, res) => {
  try {
    const school = await SchoolProfile.findById(req.params.id);
    if (!school) return res.redirect("/zq-admin/schools");

    const idx = parseInt(req.params.index);
    if (!isNaN(idx) && school.brochures?.[idx]) {
      const brochure = school.brochures[idx];

      // ── Also delete from GridFS if it's a self-hosted file ────────────────
      try {
        const urlParts = brochure.url.split("/brochure/");
        if (urlParts.length > 1) {
          const filename = urlParts[1];
          const bucket   = getBucket();
          const files    = await bucket.find({ filename }).toArray();
          if (files.length > 0) {
            await bucket.delete(files[0]._id);
          }
        }
      } catch (gfsErr) {
        console.error("[Brochure GFS Delete]", gfsErr.message);
        // Don't block — still remove from DB even if GFS delete fails
      }

      school.brochures.splice(idx, 1);
      await school.save();
    }
    res.redirect(`/zq-admin/schools/${req.params.id}?success=${encodeURIComponent("Brochure removed.")}`);
  } catch (err) {
    res.redirect(`/zq-admin/schools/${req.params.id}?error=${encodeURIComponent(err.message)}`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// TOGGLE ACTIVE
// POST /zq-admin/schools/:id/toggle-active
// ─────────────────────────────────────────────────────────────────────────────
router.post("/schools/:id/toggle-active", requireSupplierAdmin, async (req, res) => {
  const school = await SchoolProfile.findById(req.params.id);
  if (school) {
    school.active = !school.active;
    await school.save();
  }
  res.redirect(`/zq-admin/schools/${req.params.id}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// TOGGLE ADMISSIONS OPEN/CLOSED
// POST /zq-admin/schools/:id/toggle-admissions
// ─────────────────────────────────────────────────────────────────────────────
router.post("/schools/:id/toggle-admissions", requireSupplierAdmin, async (req, res) => {
  const school = await SchoolProfile.findById(req.params.id);
  if (school) {
    school.admissionsOpen = !school.admissionsOpen;
    await school.save();
  }
  res.redirect(`/zq-admin/schools/${req.params.id}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// TOGGLE VERIFIED
// POST /zq-admin/schools/:id/toggle-verified
// ─────────────────────────────────────────────────────────────────────────────
router.post("/schools/:id/toggle-verified", requireSupplierAdmin, async (req, res) => {
  const school = await SchoolProfile.findById(req.params.id);
  if (school) {
    school.verified = !school.verified;
    await school.save();
  }
  res.redirect(`/zq-admin/schools/${req.params.id}`);
});



// ─────────────────────────────────────────────────────────────────────────────
// SEND OFFER (GET form)
// GET /zq-admin/schools/:id/offer
// ─────────────────────────────────────────────────────────────────────────────
router.get("/schools/:id/offer", requireSupplierAdmin, async (req, res) => {
  try {
    const school = await SchoolProfile.findById(req.params.id).lean();
    if (!school) return res.redirect("/zq-admin/schools");

    const errorMsg = req.query.error
  ? `<div class="alert red" style="margin-bottom:16px">❌ ${esc(req.query.error)}</div>`
  : "";

    res.send(layout(`Send Offer: ${esc(school.schoolName)}`, `
      <a href="/zq-admin/schools" class="back-link">← Back to Schools</a>
 ${errorMsg}

      <div class="panel" style="max-width:700px">
        <h3>💬 Send Discount Offer - ${esc(school.schoolName)}</h3>
        <p style="color:var(--muted);margin-bottom:20px;font-size:13px">
          Send a WhatsApp offer message to this school admin.
        </p>

        <form method="POST" action="/zq-admin/schools/${school._id}/offer" class="edit-form">
          <div class="form-grid">
            <div class="fg">
              <label>Plan / Tier</label>
              <select name="tier" id="offerTier" required>
                <option value="basic">✅ Basic - $15/month</option>
                <option value="featured">🔥 Featured - $35/month</option>
              </select>
            </div>

            <div class="fg">
              <label>Billing Cycle</label>
              <select name="plan" id="offerPlan">
                <option value="monthly">Monthly</option>
                <option value="annual">Annual</option>
              </select>
            </div>

            <div class="fg">
              <label>Target Amount ($)</label>
              <input type="number" name="targetAmount" id="offerTargetAmount" placeholder="e.g. 50" step="0.01" min="0" required />
            </div>

            <div class="fg">
              <label>Discount (%)</label>
              <input type="number" name="discountPercent" id="offerDiscountPercent" value="0" step="0.0001" readonly />
            </div>

            <div class="fg">
              <label>Pay By</label>
              <select name="dueText" required>
                <option value="today">Today</option>
                <option value="tomorrow">Tomorrow</option>
                <option value="Monday">Monday</option>
                <option value="Tuesday">Tuesday</option>
                <option value="Wednesday">Wednesday</option>
                <option value="Thursday">Thursday</option>
                <option value="Friday">Friday</option>
              </select>
            </div>
          </div>

          <div class="form-actions">
            <button type="submit" class="btn btn-green">📨 Send Offer</button>
            <a href="/zq-admin/schools" class="btn btn-gray">Cancel</a>
          </div>
        </form>
      </div>

      <script>
      (function() {
        const tierEl = document.getElementById("offerTier");
        const planEl = document.getElementById("offerPlan");
        const targetEl = document.getElementById("offerTargetAmount");
        const discountEl = document.getElementById("offerDiscountPercent");

        function getBaseAmount() {
          const tier = (tierEl.value || "basic").toLowerCase();
          const plan = (planEl.value || "monthly").toLowerCase();

          if (tier === "featured") {
            return plan === "annual" ? 350 : 35;
          }
          return plan === "annual" ? 150 : 15;
        }

        function recalc() {
          const base = getBaseAmount();
          const target = parseFloat(targetEl.value);

          if (!target || target <= 0 || target >= base) {
            discountEl.value = "0";
            return;
          }

          const pct = ((base - target) / base) * 100;
          discountEl.value = pct.toFixed(4);
        }

        tierEl.addEventListener("change", recalc);
        planEl.addEventListener("change", recalc);
        targetEl.addEventListener("input", recalc);
      })();
      </script>
    `));
  } catch (err) {
    res.send(layout("Error", `<div class="alert red">${esc(err.message)}</div>`));
  }
});



// ─────────────────────────────────────────────────────────────────────────────
// SEND OFFER (POST)
// POST /zq-admin/schools/:id/offer
// ─────────────────────────────────────────────────────────────────────────────
router.post("/schools/:id/offer", requireSupplierAdmin, async (req, res) => {
  try {
    const school = await SchoolProfile.findById(req.params.id);
    if (!school) return res.redirect("/zq-admin/schools");

    const safeTier = String(req.body.tier || "basic").toLowerCase();
    const safePlan = String(req.body.plan || "monthly").toLowerCase();
    const dueText = String(req.body.dueText || "today").trim();
    const targetAmount = Number(req.body.targetAmount || 0);

    const baseAmount = getSchoolPlanAmount(safeTier, safePlan);
    if (!targetAmount || targetAmount <= 0 || targetAmount >= baseAmount) {
      return res.redirect(
        `/zq-admin/schools/${school._id}/offer?error=${encodeURIComponent("Enter a valid target amount below the normal price.")}`
      );
    }

    const pct = Number((((baseAmount - targetAmount) / baseAmount) * 100).toFixed(4));
    const discountAmount = Number((baseAmount - targetAmount).toFixed(2));

    // 1) Generate invoice PDF and send it first
    try {
      const offerRef = `SCH-OFFER-${Date.now()}`;

      const invoiceItems = [
        {
          item: `ZimQuote School ${safeTier === "featured" ? "Featured" : "Basic"} Plan (${safePlan})`,
          qty: 1,
          unit: baseAmount,
          total: baseAmount
        }
      ];

      if (discountAmount > 0) {
        invoiceItems.push({
          item: `Discount (${pct.toFixed(2)}%)`,
          qty: 1,
          unit: -discountAmount,
          total: -discountAmount
        });
      }

      const { filename } = await generatePDF({
        type: "invoice",
        number: offerRef,
        date: new Date(),
        billingTo: school.schoolName,
        items: invoiceItems,
        bizMeta: {
          name: "ZimQuote",
          logoUrl: "",
          address: "ZimQuote School Platform",
          _id: String(school._id),
          status: "offer"
        }
      });

      const site = (process.env.SITE_URL || "").replace(/\/$/, "");
      const invoiceUrl = `${site}/docs/generated/invoices/${filename}`;

      await sendDocument(school.phone, { link: invoiceUrl, filename });
    } catch (pdfErr) {
      console.error("[School Offer] invoice PDF generation failed:", pdfErr.message);
    }

    // 2) Send WhatsApp offer message after the invoice
    const msg = buildSchoolOfferMessage({
  schoolName: school.schoolName,
  tier: safeTier,
  plan: safePlan,
  targetAmount,
  dueText,
  discountPercent: pct
});

    await sendText(school.phone, msg);

    school.adminNote = (school.adminNote ? school.adminNote + " | " : "") +
      `[Offer sent ${new Date().toDateString()}: ${safeTier}/${safePlan} base $${fmtUsd(baseAmount)} target $${fmtUsd(targetAmount)} discount $${fmtUsd(discountAmount)} by ${dueText} (${pct}%)]`;

    await school.save();

    return res.redirect(
      `/zq-admin/schools/${school._id}?success=${encodeURIComponent(`Offer sent with invoice: $${fmtUsd(targetAmount)} ${safePlan} ${safeTier} by ${dueText}.`)}`
    );
  } catch (err) {
    return res.send(layout("Error", `<div class="alert red">${esc(err.message)}</div>`));
  }
});
// ─────────────────────────────────────────────────────────────────────────────
// MANUAL ACTIVATION (GET form)
// GET /zq-admin/schools/:id/activate
// ─────────────────────────────────────────────────────────────────────────────
router.get("/schools/:id/activate", requireSupplierAdmin, async (req, res) => {
  try {
    const school = await SchoolProfile.findById(req.params.id).lean();
    if (!school) return res.redirect("/zq-admin/schools");

    res.send(layout(`Activate: ${esc(school.schoolName)}`, `
      <a href="/zq-admin/schools/${school._id}" class="back-link">← Back to Profile</a>
      <div class="panel" style="max-width:700px">
        <h3>🎁 Manual Activation - ${esc(school.schoolName)}</h3>
        <p style="color:var(--muted);margin-bottom:20px;font-size:13px">
          Activate this school listing without requiring EcoCash payment.
          Use for manual arrangements, free trials, or cash payments.
        </p>

        <form method="POST" action="/zq-admin/schools/${school._id}/activate" class="edit-form">
          <div class="form-grid">
            <div class="fg">
              <label>Plan / Tier</label>
              <select name="tier" required>
                <option value="">Select a plan...</option>
                <option value="basic">✅ Basic - $15/month</option>
                <option value="featured">🔥 Featured - $35/month</option>
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
              <input name="reason" placeholder="e.g. Paid cash, free trial, partner deal..." />
            </div>

            <div class="fg">
             <label>Target Amount ($)</label>
<input type="number" id="targetAmount" placeholder="e.g. 50" step="0.01" />

<label>Discount (%)</label>
<input type="number" id="discountPercent" name="discountPercent" value="0" min="0" max="100" step="0.01" readonly />
            </div>

            <div class="fg">
              <label>Payment Method</label>
              <select name="paymentMethod">
                <option value="cash">Cash</option>
                <option value="ecocash">EcoCash</option>
                <option value="bank_transfer">Bank Transfer</option>
                <option value="other">Other</option>
              </select>
            </div>
          </div>

          <div class="fg full" style="margin-bottom:16px">
            <label>Also set listing Active?</label>
            <select name="setActive">
              <option value="true">Yes - make listing visible to parents now</option>
              <option value="false">No - activate subscription only</option>
            </select>
          </div>

          <div class="fg full" style="margin-bottom:16px">
            <label>Mark as Verified?</label>
            <select name="setVerified">
              <option value="false">No</option>
              <option value="true">✅ Yes - add verified badge</option>
            </select>
          </div>

          <div class="fg full" style="margin-bottom:16px">
            <label>Receipt Note (optional)</label>
            <input name="receiptNote" placeholder="e.g. Cash received by admin, discounted partner rate" />
          </div>

          <div class="form-actions">
            <button type="submit" class="btn btn-green">✅ Activate Now</button>
            <a href="/zq-admin/schools/${school._id}" class="btn btn-gray">Cancel</a>
          </div>


          <script>
(function() {
  const targetInput = document.getElementById('targetAmount');
  const discountInput = document.getElementById('discountPercent');

  const tierSelect = document.querySelector('[name="tier"]');
  const planSelect = document.querySelector('[name="plan"]');

  function getBaseAmount() {
    const tier = (tierSelect.value || 'basic').toLowerCase();
    const plan = (planSelect.value || 'monthly').toLowerCase();

    if (tier === 'featured') {
      return plan === 'annual' ? 350 : 35;
    }
    return plan === 'annual' ? 150 : 15;
  }

  function calculateDiscount() {
    const base = getBaseAmount();
    const target = parseFloat(targetInput.value);

    if (!target || target <= 0 || target >= base) {
      discountInput.value = 0;
      return;
    }

    const pct = ((base - target) / base) * 100;
    discountInput.value = pct.toFixed(4); // high precision
  }

  targetInput.addEventListener('input', calculateDiscount);
  tierSelect.addEventListener('change', calculateDiscount);
  planSelect.addEventListener('change', calculateDiscount);
})();
</script>
        </form>
      </div>
    `));
  } catch (err) {
    res.send(layout("Error", `<div class="alert red">${err.message}</div>`));
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// MANUAL ACTIVATION (POST handler)
// POST /zq-admin/schools/:id/activate
// ─────────────────────────────────────────────────────────────────────────────
router.post("/schools/:id/activate", requireSupplierAdmin, async (req, res) => {
  try {
    const {
      tier,
      plan,
      durationDays,
      reason,
      setActive,
      setVerified,
      discountPercent,
      paymentMethod,
      receiptNote
    } = req.body;

    const school = await SchoolProfile.findById(req.params.id);
    if (!school) return res.redirect("/zq-admin/schools");

    const now       = new Date();
    const days      = Number(durationDays) || 30;
    const expiresAt = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
    const isActive  = setActive === "true";

    const safeTier = String(tier || "basic").toLowerCase();
    const safePlan = String(plan || "monthly").toLowerCase();

    const baseAmount = getSchoolPlanAmount(safeTier, safePlan);
    const pct = Math.max(0, Math.min(100, Number(discountPercent) || 0));
  const rawDiscount = baseAmount * (pct / 100);
const rawFinal = baseAmount - rawDiscount;

// ✅ Round FINAL first (this fixes 49.99 issue)
const finalAmount = Number(rawFinal.toFixed(2));

// ✅ Then derive discount from final (keeps math consistent)
const discountAmount = Number((baseAmount - finalAmount).toFixed(2));

    // Update the school profile
    school.tier               = safeTier;
    school.subscriptionPlan   = safePlan;
    school.subscriptionEndsAt = expiresAt;
    school.active             = isActive;
    if (setVerified === "true") school.verified = true;

    const noteBits = [];
    if (reason?.trim()) noteBits.push(reason.trim());
    if (pct > 0) noteBits.push(`discount ${pct}% (-$${discountAmount.toFixed(2)})`);
    if (paymentMethod?.trim()) noteBits.push(`method: ${paymentMethod.trim()}`);
    if (receiptNote?.trim()) noteBits.push(receiptNote.trim());

    if (noteBits.length) {
      school.adminNote = (school.adminNote ? school.adminNote + " | " : "") +
        `[Activated on ${now.toDateString()}: ${noteBits.join(" | ")}]`;
    }

    await school.save();

    const reference = `ADMIN_ACT_${school._id}_${Date.now()}`;

    // Log payment record using FINAL paid amount
    const payment = await SchoolSubscriptionPayment.create({
      phone:     school.phone,
      schoolId:  school._id,
      tier:      safeTier,
      plan:      safePlan,
      amount:    finalAmount,
      currency:  "USD",
      reference,
      status:    "paid",
      paidAt:    now,
      endsAt:    expiresAt,

      // Safe extras if schema already supports them
      originalAmount:  baseAmount,
      discountPercent: pct,
      discountAmount,
      paymentMethod:   paymentMethod || "cash"
    });

    // Generate and send receipt PDF
    try {
      const receiptNumber = `SCH-${reference.slice(-8).toUpperCase()}`;

      const receiptItems = [
        {
          item: `ZimQuote School ${safeTier === "featured" ? "Featured" : "Basic"} Plan (${safePlan})`,
          qty: 1,
          unit: baseAmount,
          total: baseAmount
        }
      ];

      if (discountAmount > 0) {
        receiptItems.push({
          item: `Discount (${pct}%)`,
          qty: 1,
          unit: -discountAmount,
          total: -discountAmount
        });
      }

      const { filename } = await generatePDF({
        type: "receipt",
        number: receiptNumber,
        date: now,
        billingTo: school.schoolName,
        items: receiptItems,
        bizMeta: {
          name: "ZimQuote",
          logoUrl: "",
          address: "ZimQuote School Platform",
          _id: String(school._id),
          status: "paid"
        }
      });

      const site = (process.env.SITE_URL || "").replace(/\/$/, "");
      const receiptUrl = `${site}/docs/generated/receipts/${filename}`;

      await SchoolSubscriptionPayment.findByIdAndUpdate(payment._id, {
        $set: {
          receiptUrl,
          receiptFilename: filename
        }
      });

      await sendDocument(school.phone, { link: receiptUrl, filename });
    } catch (pdfErr) {
      console.error("[School Activation] receipt PDF generation failed:", pdfErr.message);
    }

    // Notify school
    try {
      const planLabel = safeTier === "featured" ? "🔥 Featured" : "✅ Basic";
      const discountLine = pct > 0
        ? `\nDiscount: *${pct}%* (-$${discountAmount.toFixed(2)})`
        : "";

      await sendText(
        school.phone,
`🎉 *Your school listing is now LIVE on ZimQuote!*

🏫 *${school.schoolName}*
Plan: *${planLabel}*
Paid: *$${finalAmount.toFixed(2)}*${discountLine}
Active until: *${expiresAt.toDateString()}*

We've sent your payment receipt above.

Type *menu* to manage your listing. 🎓`
      );
    } catch (notifyErr) {
      console.error("[School Activation] WhatsApp notify failed:", notifyErr.message);
    }

    res.redirect(
      `/zq-admin/schools/${school._id}?success=${encodeURIComponent(
        `School activated on ${safeTier} plan until ${expiresAt.toDateString()}. Paid $${finalAmount.toFixed(2)}${pct > 0 ? ` after ${pct}% discount` : ""}.${isActive ? " Listing is now visible to parents." : ""}`
      )}`
    );
  } catch (err) {
    res.send(layout("Error", `<div class="alert red">${err.message}</div>`));
  }
});


// ─────────────────────────────────────────────────────────────────────────────
// ZIMQUOTE CHATBOT LINK PANEL — SCHOOLS
// The "chatbot link" is a pure wa.me deep-link. No domain. No slug. No web page.
// When tapped on any platform it opens WhatsApp and the ZimQuote bot immediately
// shows the school's full FAQ chatbot — fees, enrollment, tour booking, results.
//
// Link format: https://wa.me/<BOT>?text=ZQ:SCHOOL:<mongoId>
// That's it. Generated from the school's MongoDB _id — no setup required.
//
// Routes:
//   GET  /zq-admin/schools/:id/smartcard          → chatbot link panel
//   POST /zq-admin/schools/:id/smartcard/send      → send link to school via WA
//   POST /zq-admin/schools/:id/smartcard/lead/:id/contacted → mark lead contacted
//   GET  /zq-admin/schools/:id/smartcard/leads     → full leads list
//   GET  /zq-admin/schools/:id/smartcard/qr        → print-ready QR poster
// ─────────────────────────────────────────────────────────────────────────────


// ── Chatbot link panel ────────────────────────────────────────────────────────
router.get("/schools/:id/smartcard", requireSupplierAdmin, async (req, res) => {
  try {
    const school = await SchoolProfile.findById(req.params.id).lean();
    if (!school) return res.redirect("/zq-admin/schools");

    const ok  = req.query.success ? `<div style="background:#dcfce7;color:#16a34a;padding:14px;border-radius:8px;margin-bottom:16px">✅ ${esc(req.query.success)}</div>` : "";
    const err = req.query.error   ? `<div style="background:#fee2e2;color:#dc2626;padding:14px;border-radius:8px;margin-bottom:16px">❌ ${esc(req.query.error)}</div>`    : "";

    const waLink  = _waLinkSchool(String(school._id));
    const qrImg   = _qrUrl(waLink, 260);

    // Lead stats
    const [totalLeads, uncontacted, recentLeads, sourceBreakdown] = await Promise.all([
      SchoolLead.countDocuments({ schoolId: school._id }),
      SchoolLead.countDocuments({ schoolId: school._id, contacted: false, actionType: { $ne: "view" } }),
      SchoolLead.find({ schoolId: school._id, actionType: { $ne: "view" } }).sort({ createdAt: -1 }).limit(10).lean(),
      SchoolLead.aggregate([
        { $match: { schoolId: school._id, actionType: { $ne: "view" } } },
        { $group: { _id: "$source", count: { $sum: 1 } } },
        { $sort: { count: -1 } }
      ])
    ]);

    const AL = { fees:"Requested fees", visit:"Visit request", place:"Place enquiry", pdf:"Downloaded PDF", enquiry:"General enquiry", apply:"Apply interest", view:"Profile view" };
    const SL = { tiktok:"TikTok", facebook:"Facebook", twitter:"Twitter/X", whatsapp_status:"WA Status", qr:"QR Poster", sms:"SMS", direct:"Direct", whatsapp_link:"WA Link", other:"Other" };

    const admLine = school.admissionsOpen ? "🟢 Admissions currently OPEN" : "";

    // Per-platform captions — all using the same wa.me link
    const PLATFORMS = [
     { id:"tiktok",          icon:"📱", label:"TikTok bio",       tip:'Put as your bio link. Say "link in bio 👆" in every video.' },
      { id:"facebook",        icon:"📘", label:"Facebook",          tip:"Paste in post captions and your Page About section." },
      { id:"twitter",         icon:"🐦", label:"Twitter / X",       tip:"Add to your profile bio under Website." },
      { id:"whatsapp_status", icon:"💬", label:"WhatsApp Status",   tip:"Post the message below as a status update." },
      { id:"sms",             icon:"📲", label:"SMS blast",          tip:"Paste in SMS messages to parents. Works on any phone." }
    ];

    const platformRows = PLATFORMS.map(p => {
      const caption = `🏫 ${school.schoolName}\n📍 ${school.suburb||""}${school.suburb?", ":""}${school.city}\n${admLine}\n\nTap to see full profile, fees & enquire on WhatsApp:\n👉 ${waLink}\n\n_Found via ZimQuote_`;
      return `<tr>
        <td><strong>${p.icon} ${p.label}</strong></td>
        <td style="font-size:12px;color:var(--muted)">${p.tip}</td>
        <td style="white-space:nowrap">
          <button class="btn btn-sm btn-gray"
            data-copy="${esc(caption)}"
            onclick="var d=this.dataset.copy;navigator.clipboard.writeText(d).then(()=>{this.textContent='✅ Copied!';var b=this;setTimeout(()=>b.textContent='📋 Copy caption',1800)}).catch(()=>{})">
            📋 Copy caption
          </button>
        </td>
      </tr>`;
    }).join("");

    const leadsRows = recentLeads.map(l => `<tr>
      <td style="white-space:nowrap;font-size:12px">${new Date(l.createdAt).toLocaleDateString("en-GB",{day:"numeric",month:"short"})}</td>
      <td><strong>${esc(l.parentName||"Anonymous")}</strong>${l.parentPhone?`<div style="font-size:11px;color:var(--muted)">${esc(l.parentPhone)}</div>`:""}</td>
      <td style="font-size:12px">${esc(AL[l.actionType]||l.actionType)}${l.gradeInterest?` <em>(${esc(l.gradeInterest)})</em>`:""}</td>
      <td style="font-size:12px">${esc(SL[l.source]||l.source)}</td>
      <td>${l.contacted
        ? `<span class="badge badge-green">Contacted</span>`
        : `<form method="POST" action="/zq-admin/schools/${school._id}/smartcard/lead/${l._id}/contacted" style="display:inline"><button class="btn btn-sm btn-green">✅ Mark contacted</button></form>`}
      </td>
      <td>${l.parentPhone
        ? `<a href="https://wa.me/${l.parentPhone.replace(/\D+/g,'')}?text=${encodeURIComponent('Hi '+(l.parentName||'')+(l.parentName?', ':'')+'I\'m following up from '+school.schoolName+' regarding your ZimQuote enquiry.')}" target="_blank" class="btn btn-sm btn-blue">💬 Reply</a>`
        : "—"}
      </td>
    </tr>`).join("");

    const sourceRows = sourceBreakdown.map(s =>
      `<tr><td>${esc(SL[s._id]||s._id||"Unknown")}</td><td><strong>${s.count}</strong></td></tr>`
    ).join("") || `<tr><td colspan="2" style="color:var(--muted)">No leads yet</td></tr>`;

    const msgToSchool = `Hi ${school.schoolName},

Your ZimQuote chatbot link is ready! 🎉

📲 Your link:
${waLink}

When anyone taps this link — on Facebook, TikTok, WhatsApp, or SMS — WhatsApp opens and your school's full profile appears instantly in the ZimQuote chat.

Parents can:
• See fees, facilities, and results
• Book a school tour
• Ask about enrollment and required documents
• Download your fee schedule
• Send you an enquiry

All without you being online.

Share it everywhere:
📱 TikTok → Put it as your bio link
📘 Facebook → Paste in post captions
💬 WhatsApp Status → Share it weekly
📲 SMS → Send to parents in your contact list
🖨️ Print → We've generated a QR code you can print

ZimQuote Team`;

    res.send(layout(`Chatbot Link: ${esc(school.schoolName)}`, `
      <a href="/zq-admin/schools/${school._id}" class="back-link">← Back to ${esc(school.schoolName)}</a>
      ${ok}${err}

      <!-- ── THE LINK ─────────────────────────────────────────────────────── -->
      <div class="panel" style="margin-bottom:16px">
        <div class="panel-head">
          <h3>📲 ZimQuote Chatbot Link</h3>
          <span class="badge badge-green">Active — no setup needed</span>
        </div>

        <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:10px;padding:18px;margin-bottom:16px">
          <div style="font-size:11px;font-weight:700;color:#15803d;text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px">
            Pure WhatsApp link — works on every platform, no web page, no domain
          </div>
          <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:12px">
            <code style="font-size:13px;flex:1;word-break:break-all;background:#dcfce7;padding:9px 12px;border-radius:7px;font-family:monospace">${esc(waLink)}</code>
          </div>
          <div style="display:flex;gap:8px;flex-wrap:wrap">
            <button class="btn btn-green btn-sm"
              data-copy="${esc(waLink)}"
            onclick="var d=this.dataset.copy;navigator.clipboard.writeText(d).then(()=>{this.textContent='✅ Copied!';var b=this;setTimeout(()=>b.textContent='📋 Copy Link',1800)}).catch(()=>{})">
              📋 Copy Link
            </button>
            <a href="${esc(waLink)}" target="_blank" class="btn btn-blue btn-sm">
              📱 Test on WhatsApp
            </a>
            <a href="/zq-admin/schools/${school._id}/smartcard/qr" target="_blank" class="btn btn-sm btn-gray">
              🖨️ Print QR Poster
            </a>
          </div>
          <p style="font-size:12px;color:#166534;margin-top:10px">
            When tapped, WhatsApp opens and the ZimQuote bot shows the full school chatbot:
            fees, enrollment enquiry, tour booking, academic results, transport, facilities — all instantly.
          </p>
        </div>

        <!-- Stats -->
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:12px">
          <div class="stat-card stat-blue"><div class="stat-val">${school.zqLinkViews||0}</div><div class="stat-lbl">Link taps</div></div>
          <div class="stat-card stat-green"><div class="stat-val">${school.zqLinkConversions||0}</div><div class="stat-lbl">Bot opens</div></div>
          <div class="stat-card stat-orange"><div class="stat-val">${totalLeads}</div><div class="stat-lbl">Total leads</div></div>
          <div class="stat-card stat-purple"><div class="stat-val" style="color:#dc2626">${uncontacted}</div><div class="stat-lbl">Not contacted</div></div>
        </div>
      </div>

      <!-- ── QR CODE ─────────────────────────────────────────────────────── -->
      <div class="panel" style="margin-bottom:16px">
        <h3>🖨️ QR Code</h3>
        <div style="display:flex;align-items:flex-start;gap:20px;flex-wrap:wrap">
          <div style="border:1px solid var(--border);border-radius:10px;padding:10px;background:#fff">
            <img src="${esc(qrImg)}" alt="QR Code" width="130" height="130" style="display:block">
          </div>
          <div>
            <p style="font-size:13px;color:var(--muted);margin-bottom:10px;max-width:360px">
              This QR code encodes the WhatsApp link directly — not a website URL.
              Scanning it with WhatsApp's built-in camera opens the bot immediately.
              Print it on school gate banners, posters, notice boards, and flyers.
            </p>
            <a href="/zq-admin/schools/${school._id}/smartcard/qr" target="_blank" class="btn btn-blue">🖨️ Open Print-Ready Poster</a>
          </div>
        </div>
      </div>

      <!-- ── SEND TO SCHOOL ─────────────────────────────────────────────── -->
      <div class="panel" style="margin-bottom:16px">
        <h3>📨 Send link to school admin</h3>
        <p style="font-size:13px;color:var(--muted);margin-bottom:14px">
          Send the chatbot link and instructions directly to <strong>${esc(school.phone)}</strong> via WhatsApp.
        </p>
        <form method="POST" action="/zq-admin/schools/${school._id}/smartcard/send">
          <div class="fg" style="margin-bottom:12px">
            <label>Message (edit before sending)</label>
            <textarea name="message" rows="16" style="font-size:12px;font-family:monospace">${esc(msgToSchool)}</textarea>
          </div>
          <button type="submit" class="btn btn-green">📱 Send via WhatsApp</button>
        </form>
      </div>

      <!-- ── PLATFORM CAPTIONS ──────────────────────────────────────────── -->
      <div class="panel" style="margin-bottom:16px">
        <h3>📋 Ready-to-paste captions</h3>
        <p style="font-size:13px;color:var(--muted);margin-bottom:14px">
          The link is the same everywhere. These are captions to post alongside it on each platform.
        </p>
        <table>
          <thead><tr><th>Platform</th><th>Where to use</th><th></th></tr></thead>
          <tbody>${platformRows}</tbody>
        </table>
      </div>

      <!-- ── RECENT LEADS ───────────────────────────────────────────────── -->
      <div class="panel" style="margin-bottom:16px">
        <div class="panel-head">
          <h3>👥 Recent leads</h3>
          <a href="/zq-admin/schools/${school._id}/smartcard/leads" class="btn btn-sm btn-blue">View all ${totalLeads} →</a>
        </div>
        ${recentLeads.length
          ? `<div style="overflow-x:auto"><table>
              <thead><tr><th>Date</th><th>Parent</th><th>Action</th><th>Source</th><th>Status</th><th></th></tr></thead>
              <tbody>${leadsRows}</tbody>
            </table></div>`
          : `<p style="color:var(--muted);font-size:13px">No leads yet. Share the chatbot link to start receiving leads.</p>`}
      </div>

      <!-- ── LEADS BY SOURCE ────────────────────────────────────────────── -->
      <div class="panel">
        <h3>📊 Leads by source</h3>
        <table style="max-width:320px">
          <thead><tr><th>Source</th><th>Leads</th></tr></thead>
          <tbody>${sourceRows}</tbody>
        </table>
      </div>
    `));
  } catch (err) {
    res.send(layout("Error", `<div class="alert red">${err.message}</div>`));
  }
});

// ── Send chatbot link to school ───────────────────────────────────────────────
router.post("/schools/:id/smartcard/send", requireSupplierAdmin, async (req, res) => {
  try {
    const school  = await SchoolProfile.findById(req.params.id).lean();
    if (!school) return res.redirect("/zq-admin/schools");
    const message = String(req.body.message || "").trim();
    if (!message) return res.redirect(`/zq-admin/schools/${school._id}/smartcard?error=${encodeURIComponent("Message is empty.")}`);
    await sendText(school.phone, message);
    res.redirect(`/zq-admin/schools/${school._id}/smartcard?success=${encodeURIComponent("Link sent to " + school.phone + " via WhatsApp.")}`);
  } catch (err) {
    res.redirect(`/zq-admin/schools/${req.params.id}/smartcard?error=${encodeURIComponent("Send failed: " + err.message)}`);
  }
});

// ── Mark lead as contacted ────────────────────────────────────────────────────
router.post("/schools/:id/smartcard/lead/:leadId/contacted", requireSupplierAdmin, async (req, res) => {
  try {
    await SchoolLead.findByIdAndUpdate(req.params.leadId, { $set: { contacted: true, contactedAt: new Date() } });
    res.redirect(`/zq-admin/schools/${req.params.id}/smartcard?success=${encodeURIComponent("Lead marked as contacted.")}`);
  } catch (err) {
    res.redirect(`/zq-admin/schools/${req.params.id}/smartcard?error=${encodeURIComponent(err.message)}`);
  }
});

// ── All leads list ────────────────────────────────────────────────────────────
router.get("/schools/:id/smartcard/leads", requireSupplierAdmin, async (req, res) => {
  try {
    const school  = await SchoolProfile.findById(req.params.id).lean();
    if (!school) return res.redirect("/zq-admin/schools");
    const page    = parseInt(req.query.page || "0", 10);
    const perPage = 25;
    const total   = await SchoolLead.countDocuments({ schoolId: school._id, actionType: { $ne: "view" } });
    const leads   = await SchoolLead.find({ schoolId: school._id, actionType: { $ne: "view" } })
      .sort({ createdAt: -1 }).skip(page * perPage).limit(perPage).lean();

    const AL = { fees:"Requested fees", visit:"Visit request", place:"Place enquiry", pdf:"Downloaded PDF", enquiry:"General enquiry", apply:"Apply interest" };
    const SL = { tiktok:"TikTok", facebook:"Facebook", twitter:"Twitter/X", whatsapp_status:"WA Status", qr:"QR", sms:"SMS", direct:"Direct", whatsapp_link:"WA Link", other:"Other" };

    const rows = leads.map(l => `<tr>
      <td style="white-space:nowrap;font-size:12px">${new Date(l.createdAt).toLocaleDateString("en-GB",{day:"numeric",month:"short",year:"numeric"})}</td>
      <td><strong>${esc(l.parentName||"Anonymous")}</strong>${l.parentPhone?`<div style="font-size:11px;color:var(--muted)">${esc(l.parentPhone)}</div>`:""}</td>
      <td style="font-size:12px">${esc(AL[l.actionType]||l.actionType)}${l.gradeInterest?` <em>(${esc(l.gradeInterest)})</em>`:""}</td>
      <td style="font-size:12px">${esc(SL[l.source]||l.source)}</td>
      <td>${l.contacted
        ? `<span class="badge badge-green">Contacted</span>`
        : `<form method="POST" action="/zq-admin/schools/${school._id}/smartcard/lead/${l._id}/contacted" style="display:inline"><button class="btn btn-sm btn-green">✅ Mark contacted</button></form>`}
      </td>
      <td>${l.parentPhone
        ? `<a href="https://wa.me/${l.parentPhone.replace(/\D+/g,'')}?text=${encodeURIComponent('Hi '+(l.parentName||'')+(l.parentName?', ':'')+'I\'m following up from '+school.schoolName+' regarding your ZimQuote enquiry.')}" target="_blank" class="btn btn-sm btn-blue">💬 Reply</a>`
        : "—"}
      </td>
    </tr>`).join("");

    const totalPages = Math.ceil(total / perPage);
    const pager = totalPages > 1 ? `<div style="display:flex;gap:8px;margin-top:16px">
      ${page>0?`<a href="?page=${page-1}" class="btn btn-sm btn-gray">← Prev</a>`:""}
      <span style="padding:6px 12px;font-size:13px;color:var(--muted)">Page ${page+1} of ${totalPages}</span>
      ${page<totalPages-1?`<a href="?page=${page+1}" class="btn btn-sm btn-gray">Next →</a>`:""}
    </div>` : "";

    res.send(layout(`Leads: ${esc(school.schoolName)}`, `
      <a href="/zq-admin/schools/${school._id}/smartcard" class="back-link">← Back to Chatbot Link</a>
      <div class="panel">
        <div class="panel-head">
          <h3>👥 All leads — ${esc(school.schoolName)}</h3>
          <span style="font-size:13px;color:var(--muted)">${total} total</span>
        </div>
        ${leads.length
          ? `<div style="overflow-x:auto"><table>
              <thead><tr><th>Date</th><th>Parent</th><th>Action</th><th>Source</th><th>Status</th><th></th></tr></thead>
              <tbody>${rows}</tbody>
            </table></div>${pager}`
          : "<em style='color:var(--muted)'>No leads yet.</em>"}
      </div>
    `));
  } catch (err) {
    res.send(layout("Error", `<div class="alert red">${err.message}</div>`));
  }
});

// ── QR print-ready poster ─────────────────────────────────────────────────────
router.get("/schools/:id/smartcard/qr", requireSupplierAdmin, async (req, res) => {
  try {
    const school  = await SchoolProfile.findById(req.params.id).lean();
    if (!school) return res.redirect(`/zq-admin/schools/${req.params.id}/smartcard`);

    const waLink  = _waLinkSchool(String(school._id));
    const qrImg   = _qrUrl(waLink, 400);
    const loc     = [school.suburb, school.city].filter(Boolean).join(", ");
    const feeStr  = school.fees?.term1
      ? `$${school.fees.term1}/term`
      : { budget:"Under $300/term", mid:"$300–$800/term", premium:"$800+/term" }[school.feeRange] || "";

    res.send(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<title>QR Poster – ${esc(school.schoolName)}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,"Segoe UI",sans-serif;background:#fff;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;padding:20px}
.poster{width:420px;border:3px solid #085041;border-radius:20px;padding:28px;text-align:center}
.brand{font-size:11px;font-weight:700;color:#0F6E56;letter-spacing:.1em;text-transform:uppercase;margin-bottom:16px}
h1{font-size:22px;font-weight:800;color:#0a1a0a;margin-bottom:6px;line-height:1.2}
.sub{font-size:13px;color:#5a7a5a;margin-bottom:4px}
.adm{display:inline-block;margin:10px 0 14px;background:#E1F5EE;color:#0F6E56;font-size:12px;font-weight:700;padding:5px 14px;border-radius:20px}
.adm.closed{background:#fee2e2;color:#dc2626}
.qrw{margin:0 auto 16px;padding:14px;border:1px solid #E1F5EE;border-radius:14px;display:inline-block;background:#f9fff9}
.qrw img{display:block;width:200px;height:200px}
.cta{font-size:14px;font-weight:700;color:#085041;margin-bottom:6px}
.how{font-size:12px;color:#666;background:#f0faf5;border-radius:8px;padding:8px 12px;margin-bottom:14px;line-height:1.6}
.dets{font-size:12px;color:#5a7a5a;display:flex;justify-content:center;gap:12px;flex-wrap:wrap;margin-bottom:14px}
.foot{font-size:10px;color:#aaa}
.noprint{margin-top:16px;display:flex;gap:10px;justify-content:center}
@media print{.noprint{display:none!important}body{padding:0}}
</style></head><body>
<div class="poster">
  <div class="brand">ZimQuote · Verified School</div>
  <h1>${esc(school.schoolName)}</h1>
  <p class="sub">📍 ${esc(loc)}</p>
  ${feeStr?`<p class="sub">${esc(feeStr)}</p>`:""}
  <span class="adm ${school.admissionsOpen===false?'closed':''}">${school.admissionsOpen===false?'🔴 Admissions Closed':'🟢 Admissions Open'}</span>
  <div class="qrw"><img src="${esc(qrImg)}" alt="Scan to open on WhatsApp"></div>
  <p class="cta">📲 Scan to see fees, enroll & enquire</p>
  <div class="how">Open WhatsApp → tap Camera → scan this code<br>Your school profile opens in the chat <strong>instantly</strong>.<br>No app download. No website. Any phone.</div>
  <div class="dets">
    ${(school.curriculum||[]).length?`<span>📚 ${school.curriculum.map(c=>c.toUpperCase()).join(" + ")}</span>`:""}
    ${school.gender?`<span>${{mixed:"👫 Co-ed",boys:"👦 Boys",girls:"👧 Girls"}[school.gender]||""}</span>`:""}
    ${school.boarding?`<span>${{day:"🏠 Day",boarding:"🏫 Boarding",both:"🏠🏫 Day & Boarding"}[school.boarding]||""}</span>`:""}
  </div>
  <div class="foot">Powered by ZimQuote · zimquote.co.zw</div>
</div>
<div class="noprint">
  <button onclick="window.print()" style="padding:10px 20px;background:#085041;color:#fff;border:none;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer">🖨️ Print Poster</button>
  <a href="/zq-admin/schools/${school._id}/smartcard" style="padding:10px 20px;background:#e2e8f0;color:#475569;border-radius:8px;font-size:14px;font-weight:600;text-decoration:none">← Back</a>
</div>
</body></html>`);
  } catch (err) {
    res.status(500).send(`<p>Error: ${err.message}</p>`);
  }
});


// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// ENQUIRY & FAQ MANAGER
// Admins manage categories, questions, answers, ordering, visibility.
// Both system-generated defaults and admin-created items are shown together
// to parents as one unified list — no labels, no separation.
//
// SchoolProfile schema additions:
//   faqCategories: [{ id, name, emoji, order, active }]
//   faqItems:      [{ id, categoryId, question, answer, pdfUrl, pdfLabel,
//                     active, order, isDefault, overridesDefaultId }]
//
// Routes:
//   GET  /schools/:id/faq                          → manager landing
//   GET  /schools/:id/faq/cat/:catId               → questions in a category
//   POST /schools/:id/faq/cat/add                  → create custom category
//   POST /schools/:id/faq/cat/:catId/edit          → rename/reorder category
//   POST /schools/:id/faq/cat/:catId/toggle        → show/hide category
//   POST /schools/:id/faq/cat/:catId/delete        → delete category (+questions)
//   POST /schools/:id/faq/cat/:catId/move          → reorder category
//   POST /schools/:id/faq/q/add                    → add question
//   POST /schools/:id/faq/q/:qId/edit              → edit question or answer
//   POST /schools/:id/faq/q/:qId/toggle            → activate/deactivate
//   POST /schools/:id/faq/q/:qId/delete            → delete question
//   POST /schools/:id/faq/q/:qId/move              → reorder question
//   POST /schools/:id/faq/q/:qId/moveto            → move to different category
// ─────────────────────────────────────────────────────────────────────────────

// ── FAQ Manager landing — shows all categories ─────────────────────────────
router.get("/schools/:id/faq", requireSupplierAdmin, async (req, res) => {
  try {
    const school = await SchoolProfile.findById(req.params.id).lean();
    if (!school) return res.redirect("/zq-admin/schools");

    const ok  = req.query.success ? '<div style="background:#dcfce7;color:#16a34a;padding:12px 16px;border-radius:8px;margin-bottom:16px">✅ ' + _esc(req.query.success) + "</div>" : "";
    const err = req.query.error   ? '<div style="background:#fee2e2;color:#dc2626;padding:12px 16px;border-radius:8px;margin-bottom:16px">❌ ' + _esc(req.query.error) + "</div>" : "";

    const adminCats  = (school.faqCategories || []).sort((a, b) => (a.order||0) - (b.order||0));
    const adminItems = school.faqItems || [];
    const systemIds  = new Set(SYSTEM_FAQ_CATEGORIES.map(s => s.id));

    // Merge system + admin categories
    const allCats = SYSTEM_FAQ_CATEGORIES.map(sc => {
      const over = adminCats.find(a => a.id === sc.id);
      const count = adminItems.filter(q => q.categoryId === sc.id).length;
      return {
        id:       sc.id,
        name:     over?.name  || sc.name,
        emoji:    over?.emoji || sc.emoji,
        order:    over?.order ?? sc.order,
        active:   over ? over.active !== false : true,
        isSystem: true,
        count
      };
    });
    // Admin-only custom categories
    adminCats.filter(c => !systemIds.has(c.id)).forEach(c => {
      allCats.push({
        id:       c.id,
        name:     c.name,
        emoji:    c.emoji || "❓",
        order:    c.order || 999,
        active:   c.active !== false,
        isSystem: false,
        count:    adminItems.filter(q => q.categoryId === c.id).length
      });
    });
    allCats.sort((a, b) => (a.order||0) - (b.order||0));

    const totalQ = adminItems.length;
    const activeQ = adminItems.filter(q => q.active !== false).length;

    const catRows = allCats.map(cat => {
      const badge = cat.active
        ? '<span style="background:#dcfce7;color:#16a34a;font-size:11px;padding:2px 8px;border-radius:10px">Visible</span>'
        : '<span style="background:#f1f5f9;color:#64748b;font-size:11px;padding:2px 8px;border-radius:10px">Hidden</span>';
      const systemBadge = cat.isSystem
        ? '<span style="background:#eff6ff;color:#3b82f6;font-size:11px;padding:2px 8px;border-radius:10px">System</span>'
        : '<span style="background:#fef9c3;color:#854d0e;font-size:11px;padding:2px 8px;border-radius:10px">Custom</span>';
      return "<tr>"
        + '<td style="font-size:18px;text-align:center">' + _esc(cat.emoji) + "</td>"
        + "<td><strong>" + _esc(cat.name) + "</strong><div style='font-size:11px;color:var(--muted)'>" + cat.id + "</div></td>"
        + "<td>" + badge + " " + systemBadge + "</td>"
        + '<td style="font-size:13px">' + cat.count + " admin Q&A</td>"
        + "<td style='white-space:nowrap'>"
        + '<a href="/zq-admin/schools/' + school._id + '/faq/cat/' + cat.id + '" class="btn btn-sm btn-blue">✏️ Manage Q&A</a> '
        + '<form method="POST" action="/zq-admin/schools/' + school._id + '/faq/cat/' + cat.id + '/toggle" style="display:inline">'
        + '<button class="btn btn-sm btn-gray">' + (cat.active ? "Hide" : "Show") + "</button></form> "
        + '<form method="POST" action="/zq-admin/schools/' + school._id + '/faq/cat/' + cat.id + '/move" style="display:inline">'
        + '<input type="hidden" name="dir" value="up"><button class="btn btn-sm btn-gray" title="Move up">↑</button></form> '
        + '<form method="POST" action="/zq-admin/schools/' + school._id + '/faq/cat/' + cat.id + '/move" style="display:inline">'
        + '<input type="hidden" name="dir" value="down"><button class="btn btn-sm btn-gray" title="Move down">↓</button></form>'
        + (!cat.isSystem ? ' <form method="POST" action="/zq-admin/schools/' + school._id + '/faq/cat/' + cat.id + '/delete" style="display:inline" onsubmit="return confirm(\'Delete this category?\')"><button class="btn btn-sm btn-red">🗑️</button></form>' : "")
        + "</td>"
        + "</tr>";
    }).join("");

    res.send(layout("FAQ Manager: " + _esc(school.schoolName),
      '<a href="/zq-admin/schools/' + school._id + '" class="back-link">← Back to ' + _esc(school.schoolName) + "</a>\n"
      + ok + err

      + '<div class="panel" style="margin-bottom:16px">'
      + '<div class="panel-head"><h3>❓ Enquiry & FAQ Manager</h3>'
      + '<span style="font-size:13px;color:var(--muted)">' + totalQ + ' admin Q&A · ' + activeQ + ' active</span></div>'

      + '<p style="font-size:13px;color:var(--muted);margin-bottom:14px">'
      + 'Smart questions are generated automatically from the school profile and shown to parents alongside admin-created Q&A — all in the same categories, no labels. '
      + 'Use this panel to add custom questions, rename categories, control ordering, and manage visibility.'
      + "</p>"

      + '<div style="overflow-x:auto"><table>'
      + "<thead><tr><th></th><th>Category</th><th>Status</th><th>Admin Q&A</th><th>Actions</th></tr></thead>"
      + "<tbody>" + catRows + "</tbody>"
      + "</table></div></div>"

      + '<div class="panel">'
      + "<h3>➕ Add a custom category</h3>"
      + '<p style="font-size:13px;color:var(--muted);margin-bottom:12px">Create a new category that does not exist in the system list above (e.g. "Scholarships", "Extra Classes", "School Trips").</p>'
      + '<form method="POST" action="/zq-admin/schools/' + school._id + '/faq/cat/add">'
      + '<div style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end">'
      + '<div class="fg" style="flex:1;min-width:160px;margin:0"><label>Category name <span style="color:red">*</span></label><input name="name" placeholder="e.g. Scholarships" maxlength="30" required></div>'
      + '<div class="fg" style="width:80px;margin:0"><label>Emoji</label><input name="emoji" placeholder="🎓" maxlength="4"></div>'
      + '<div class="fg" style="width:80px;margin:0"><label>Order</label><input type="number" name="order" value="100" min="0" max="999" style="width:70px"></div>'
      + '<button type="submit" class="btn btn-green" style="margin-bottom:1px">➕ Add category</button>'
      + "</div></form></div>"
    ));
  } catch (err) {
    res.send(layout("Error", '<div class="alert red">' + err.message + "</div>"));
  }
});

// ── Category Q&A detail page ───────────────────────────────────────────────
router.get("/schools/:id/faq/cat/:catId", requireSupplierAdmin, async (req, res) => {
  try {
    const school  = await SchoolProfile.findById(req.params.id).lean();
    if (!school) return res.redirect("/zq-admin/schools");
    const catId   = req.params.catId;

    const ok  = req.query.success ? '<div style="background:#dcfce7;color:#16a34a;padding:12px 16px;border-radius:8px;margin-bottom:16px">✅ ' + _esc(req.query.success) + "</div>" : "";
    const err = req.query.error   ? '<div style="background:#fee2e2;color:#dc2626;padding:12px 16px;border-radius:8px;margin-bottom:16px">❌ ' + _esc(req.query.error) + "</div>" : "";

    const sysCat    = SYSTEM_FAQ_CATEGORIES.find(s => s.id === catId);
    const adminCat  = (school.faqCategories || []).find(c => c.id === catId);
    const catName   = adminCat?.name  || sysCat?.name  || catId;
    const catEmoji  = adminCat?.emoji || sysCat?.emoji || "❓";
    const isSystem  = !!sysCat;

    const adminItems = (school.faqItems || [])
      .filter(q => q.categoryId === catId)
      .sort((a, b) => (a.order||0) - (b.order||0));

    // Smart default preview (generated from profile)
    const { default: schoolFAQMod } = await import("../services/schoolFAQ.js").catch(() => ({}));
    let defaultPreview = [];
    if (schoolFAQMod?._generateDefaults) {
      defaultPreview = schoolFAQMod._generateDefaults(school).filter(d => d.categoryId === catId);
    }

    const defRows = defaultPreview.length
      ? defaultPreview.map(d =>
          "<tr style='opacity:.7'>"
          + '<td style="font-size:11px;background:#eff6ff;color:#3b82f6;padding:3px 8px;border-radius:4px;white-space:nowrap">Auto</td>'
          + "<td><em>" + _esc(d.question) + "</em></td>"
          + '<td style="font-size:12px;color:var(--muted)">' + _esc((d.answer||"").slice(0, 80)) + "…</td>"
          + "<td>✅ Active</td><td>—</td>"
          + "</tr>"
        ).join("")
      : "";

    const adminRows = adminItems.map((q, idx) => {
      const active = q.active !== false;
      return "<tr>"
        + '<td style="font-size:11px;background:#fef9c3;color:#854d0e;padding:3px 8px;border-radius:4px;white-space:nowrap">Admin</td>'
        + "<td><strong>" + _esc(q.question) + "</strong>"
        + (q.question.length > 24 ? '<div style="font-size:10px;color:#dc2626">⚠️ Button shows: ' + _esc(q.question.slice(0,24)) + "</div>" : "")
        + "</td>"
        + '<td style="font-size:12px;color:var(--muted)">' + _esc((q.answer||"").slice(0, 80)) + (q.answer?.length > 80 ? "…" : "") + "</td>"
        + "<td>" + (active ? "✅ Active" : "⏸️ Hidden") + "</td>"
        + "<td style='white-space:nowrap'>"
        + '<a href="/zq-admin/schools/' + school._id + '/faq/q/' + q.id + '/edit" class="btn btn-sm btn-blue">✏️ Edit</a> '
        + '<form method="POST" action="/zq-admin/schools/' + school._id + '/faq/q/' + q.id + '/toggle" style="display:inline"><button class="btn btn-sm btn-gray">' + (active ? "Hide" : "Show") + "</button></form> "
        + '<form method="POST" action="/zq-admin/schools/' + school._id + '/faq/q/' + q.id + '/move" style="display:inline"><input type="hidden" name="dir" value="up"><button class="btn btn-sm btn-gray" title="Up">↑</button></form> '
        + '<form method="POST" action="/zq-admin/schools/' + school._id + '/faq/q/' + q.id + '/move" style="display:inline"><input type="hidden" name="dir" value="down"><button class="btn btn-sm btn-gray" title="Down">↓</button></form> '
        + '<form method="POST" action="/zq-admin/schools/' + school._id + '/faq/q/' + q.id + '/delete" style="display:inline" onsubmit="return confirm(\'Delete this question?\')"><button class="btn btn-sm btn-red">🗑️</button></form>'
        + "</td></tr>";
    }).join("");

    // Other categories for "Move to" dropdown
    const otherCats = SYSTEM_FAQ_CATEGORIES
      .filter(s => s.id !== catId)
      .map(s => '<option value="' + s.id + '">' + s.emoji + " " + s.name + "</option>")
      .join("");

    // Example questions for this category
    const EXAMPLES = {
      fees:       ["What happens if fees are paid late?", "Can fees be paid in installments?", "Is there a registration fee?", "Are fees the same for all grades?"],
      admissions: ["What is the waiting list process?", "Do you have an entry assessment?", "What is the maximum class size?", "Do you accept mid-year transfers?"],
      boarding:   ["What time is lights out?", "Can pupils bring personal items?", "How often can parents visit?", "Is laundry included?"],
      transport:  ["Is transport compulsory?", "What if my area is not on the route?", "What time does the bus leave school?", "Is there a morning and afternoon bus?"],
      academics:  ["What remedial support is available?", "Is there a gifted learner programme?", "How often are parent-teacher meetings?", "What is the homework policy?"],
      facilities: ["Is the swimming pool heated?", "Is there Wi-Fi for pupils?", "What security measures are in place?", "Is there CCTV on campus?"],
      uniforms:   ["Can I buy second-hand uniform?", "Are there PE kit requirements?", "Is there a supplier price list?", "What shoes are required?"],
      calendar:   ["When does the school year start?", "How long is each term?", "When are parent-teacher evenings?", "When is prize giving?"],
      contact:    ["Who is the head of admissions?", "What are weekend office hours?", "Is there a parent WhatsApp group?", "How do I update my contact details?"]
    };
    const examples = EXAMPLES[catId] || ["How does this work?", "Tell me more", "What are the requirements?", "How do I start?"];
    const exBtns = examples.map(q =>
      '<button type="button" style="background:var(--bg);border:.5px solid var(--border);border-radius:6px;padding:5px 10px;font-size:12px;cursor:pointer;margin:3px" '
      + 'onclick="document.getElementById(\'new_q\').value=' + JSON.stringify(q) + ';document.getElementById(\'new_q\').focus()">'
      + _esc(q) + "</button>"
    ).join("");

    res.send(layout(_esc(catEmoji + " " + catName) + " — FAQ", 
      '<a href="/zq-admin/schools/' + school._id + '/faq" class="back-link">← Back to FAQ Manager</a>\n'
      + ok + err

      + '<div class="panel" style="margin-bottom:16px">'
      + '<div class="panel-head"><h3>' + _esc(catEmoji + " " + catName) + "</h3>"
      + '<span style="font-size:13px;color:var(--muted)">' + adminItems.length + " admin questions · " + defaultPreview.length + " auto-generated</span></div>"
      + '<p style="font-size:13px;color:var(--muted);margin-bottom:14px">Auto-generated questions come from the school profile and cannot be edited here. Admin questions appear alongside them. Parents see both together — no labels.</p>'
      + '<div style="overflow-x:auto"><table>'
      + "<thead><tr><th>Source</th><th>Question (button title, max 24 chars)</th><th>Answer preview</th><th>Status</th><th>Actions</th></tr></thead>"
      + "<tbody>" + defRows + adminRows + "</tbody>"
      + "</table></div></div>"

      + '<div class="panel" style="margin-bottom:16px">'
      + "<h3>➕ Add a question to this category</h3>"
      + '<form method="POST" action="/zq-admin/schools/' + school._id + '/faq/q/add">'
      + '<input type="hidden" name="categoryId" value="' + _esc(catId) + '">'

      + '<div style="margin-bottom:10px"><div style="font-size:12px;font-weight:500;color:var(--muted);margin-bottom:6px">Quick-fill examples:</div>' + exBtns + "</div>"

      + '<div class="fg" style="margin-bottom:6px">'
      + '<label>Question (shown as list button to parents) <span style="color:red">*</span></label>'
      + '<input id="new_q" name="question" maxlength="100" required placeholder="e.g. Can I visit the school?" oninput="document.getElementById(\'q_preview\').textContent=this.value.slice(0,24);document.getElementById(\'q_len\').textContent=this.value.length">'
      + '<div style="font-size:11px;margin-top:3px;color:var(--muted)">Button shows first 24 chars: <strong id="q_preview"></strong> (<span id="q_len">0</span>/100 typed)</div>'
      + "</div>"

      + '<div class="fg" style="margin-bottom:12px">'
      + '<label>Answer (full text shown to parent) <span style="color:red">*</span></label>'
      + '<textarea name="answer" rows="5" required maxlength="2000" placeholder="Type the complete answer. Be specific — include times, numbers, contact details where relevant."></textarea>'
      + "</div>"

      + '<div class="fg" style="margin-bottom:12px">'
      + '<label>PDF attachment URL (optional)</label>'
      + '<input type="text" name="pdfUrl" placeholder="https://drive.google.com/... (direct download link)">'
      + '<div style="font-size:11px;color:var(--muted);margin-top:3px">If provided, the PDF is sent to the parent alongside the text answer.</div>'
      + "</div>"

      + '<div class="fg" style="margin-bottom:14px"><label>PDF label (optional)</label>'
      + '<input type="text" name="pdfLabel" placeholder="e.g. School prospectus 2026" maxlength="60"></div>'

      + '<div class="fg" style="margin-bottom:14px"><label>Order (0 = first)</label>'
      + '<input type="number" name="order" value="' + adminItems.length + '" min="0" max="999" style="width:90px"></div>'

      + '<button type="submit" class="btn btn-green">➕ Add question</button>'
      + "</form></div>"

      + (adminItems.length > 0
        ? '<div class="panel">'
          + "<h3>📦 Move all questions in this category</h3>"
          + '<form method="POST" action="/zq-admin/schools/' + school._id + '/faq/cat/' + catId + '/delete">'
          + '<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">'
          + '<select name="moveTo" style="flex:1"><option value="">Delete all questions in this category</option>' + otherCats + "</select>"
          + '<button class="btn btn-red" onclick="return confirm(\'Are you sure? This cannot be undone.\')">🗑️ Delete category</button>'
          + "</div></form></div>"
        : "")
    ));
  } catch (err) {
    res.send(layout("Error", '<div class="alert red">' + err.message + "</div>"));
  }
});

// ── Edit question/answer ───────────────────────────────────────────────────
router.get("/schools/:id/faq/q/:qId/edit", requireSupplierAdmin, async (req, res) => {
  try {
    const school = await SchoolProfile.findById(req.params.id).lean();
    if (!school) return res.redirect("/zq-admin/schools");
    const q = (school.faqItems || []).find(x => x.id === req.params.qId);
    if (!q) return res.redirect("/zq-admin/schools/" + school._id + "/faq");

    const ok  = req.query.success ? '<div style="background:#dcfce7;color:#16a34a;padding:12px 16px;border-radius:8px;margin-bottom:16px">✅ ' + _esc(req.query.success) + "</div>" : "";

    const catOptions = SYSTEM_FAQ_CATEGORIES.map(c =>
      '<option value="' + c.id + '"' + (q.categoryId === c.id ? " selected" : "") + ">" + c.emoji + " " + c.name + "</option>"
    ).join("");

    res.send(layout("Edit Q&A — " + _esc(school.schoolName),
      '<a href="/zq-admin/schools/' + school._id + '/faq/cat/' + q.categoryId + '" class="back-link">← Back</a>\n'
      + ok
      + '<div class="panel">'
      + "<h3>✏️ Edit question and answer</h3>"
      + '<form method="POST" action="/zq-admin/schools/' + school._id + '/faq/q/' + q.id + '/edit">'
      + '<div class="fg" style="margin-bottom:12px"><label>Category</label><select name="categoryId">' + catOptions + "</select></div>"
      + '<div class="fg" style="margin-bottom:12px"><label>Question <span style="color:red">*</span></label>'
      + '<input name="question" value="' + _esc(q.question) + '" maxlength="100" required></div>'
      + '<div class="fg" style="margin-bottom:12px"><label>Answer <span style="color:red">*</span></label>'
      + '<textarea name="answer" rows="6" required maxlength="2000">' + _esc(q.answer) + "</textarea></div>"
      + '<div class="fg" style="margin-bottom:12px"><label>PDF URL (optional)</label>'
      + '<input type="text" name="pdfUrl" value="' + _esc(q.pdfUrl || "") + '" placeholder="https://..."></div>'
      + '<div class="fg" style="margin-bottom:12px"><label>PDF label</label>'
      + '<input type="text" name="pdfLabel" value="' + _esc(q.pdfLabel || "") + '" maxlength="60"></div>'
      + '<div class="fg" style="margin-bottom:14px"><label>Order</label>'
      + '<input type="number" name="order" value="' + (q.order || 0) + '" min="0" max="999" style="width:90px"></div>'
      + '<button type="submit" class="btn btn-green">💾 Save changes</button>'
      + "</form></div>"
    ));
  } catch (err) {
    res.send(layout("Error", '<div class="alert red">' + err.message + "</div>"));
  }
});

// ── Add category ───────────────────────────────────────────────────────────
router.post("/schools/:id/faq/cat/add", requireSupplierAdmin, async (req, res) => {
  try {
    const school = await SchoolProfile.findById(req.params.id);
    if (!school) return res.redirect("/zq-admin/schools");
    const name  = String(req.body.name  || "").trim();
    const emoji = String(req.body.emoji || "❓").trim().slice(0, 4) || "❓";
    const order = parseInt(req.body.order || "100", 10);
    if (!name) return res.redirect("/zq-admin/schools/" + school._id + "/faq?error=" + encodeURIComponent("Category name is required."));
    const cats = school.faqCategories || [];
    const id   = name.toLowerCase().replace(/[^a-z0-9]+/g, "_").slice(0, 30);
    if (cats.find(c => c.id === id)) return res.redirect("/zq-admin/schools/" + school._id + "/faq?error=" + encodeURIComponent("A category with that name already exists."));
    cats.push({ id, name, emoji, order, active: true });
    school.faqCategories = cats;
    await school.save();
    res.redirect("/zq-admin/schools/" + school._id + "/faq/cat/" + id + "?success=" + encodeURIComponent("Category created. Add questions to it below."));
  } catch (err) {
    res.redirect("/zq-admin/schools/" + req.params.id + "/faq?error=" + encodeURIComponent(err.message));
  }
});

// ── Toggle category visibility ─────────────────────────────────────────────
router.post("/schools/:id/faq/cat/:catId/toggle", requireSupplierAdmin, async (req, res) => {
  try {
    const school = await SchoolProfile.findById(req.params.id);
    if (!school) return res.redirect("/zq-admin/schools");
    const catId = req.params.catId;
    const cats  = school.faqCategories || [];
    const existing = cats.find(c => c.id === catId);
    if (existing) {
      existing.active = !existing.active;
    } else {
      // Override a system category visibility
      const sysCat = SYSTEM_FAQ_CATEGORIES.find(s => s.id === catId);
      if (sysCat) cats.push({ id: catId, name: sysCat.name, emoji: sysCat.emoji, order: sysCat.order, active: false });
    }
    school.faqCategories = cats;
    await school.save();
    res.redirect("/zq-admin/schools/" + school._id + "/faq?success=" + encodeURIComponent("Category visibility updated."));
  } catch (err) {
    res.redirect("/zq-admin/schools/" + req.params.id + "/faq?error=" + encodeURIComponent(err.message));
  }
});

// ── Move category up/down ──────────────────────────────────────────────────
router.post("/schools/:id/faq/cat/:catId/move", requireSupplierAdmin, async (req, res) => {
  try {
    const school = await SchoolProfile.findById(req.params.id);
    if (!school) return res.redirect("/zq-admin/schools");
    const catId = req.params.catId;
    const dir   = req.body.dir === "up" ? -1 : 1;
    // Build merged list, find position, swap orders
    const cats = school.faqCategories || [];
    const existing = cats.find(c => c.id === catId);
    const sysCat   = SYSTEM_FAQ_CATEGORIES.find(s => s.id === catId);
    if (!existing && sysCat) cats.push({ id: catId, name: sysCat.name, emoji: sysCat.emoji, order: sysCat.order, active: true });
    cats.sort((a, b) => (a.order||0) - (b.order||0));
    const idx  = cats.findIndex(c => c.id === catId);
    const swap = idx + dir;
    if (idx >= 0 && swap >= 0 && swap < cats.length) {
      const tmp = cats[idx].order; cats[idx].order = cats[swap].order; cats[swap].order = tmp;
    }
    school.faqCategories = cats;
    await school.save();
    res.redirect("/zq-admin/schools/" + school._id + "/faq?success=" + encodeURIComponent("Category reordered."));
  } catch (err) {
    res.redirect("/zq-admin/schools/" + req.params.id + "/faq?error=" + encodeURIComponent(err.message));
  }
});

// ── Delete category (with move or delete questions) ────────────────────────
router.post("/schools/:id/faq/cat/:catId/delete", requireSupplierAdmin, async (req, res) => {
  try {
    const school  = await SchoolProfile.findById(req.params.id);
    if (!school) return res.redirect("/zq-admin/schools");
    const catId   = req.params.catId;
    const moveTo  = String(req.body.moveTo || "").trim();
    const items   = school.faqItems || [];
    if (moveTo) {
      // Move questions to another category
      items.forEach(q => { if (q.categoryId === catId) q.categoryId = moveTo; });
    } else {
      // Delete all questions in this category
      school.faqItems = items.filter(q => q.categoryId !== catId);
    }
    school.faqCategories = (school.faqCategories || []).filter(c => c.id !== catId);
    await school.save();
    const msg = moveTo ? "Category deleted and questions moved." : "Category and all its questions deleted.";
    res.redirect("/zq-admin/schools/" + school._id + "/faq?success=" + encodeURIComponent(msg));
  } catch (err) {
    res.redirect("/zq-admin/schools/" + req.params.id + "/faq?error=" + encodeURIComponent(err.message));
  }
});

// ── Add question ───────────────────────────────────────────────────────────
router.post("/schools/:id/faq/q/add", requireSupplierAdmin, async (req, res) => {
  try {
    const school     = await SchoolProfile.findById(req.params.id);
    if (!school) return res.redirect("/zq-admin/schools");
    const question   = String(req.body.question || "").trim();
    const answer     = String(req.body.answer || "").trim();
    const categoryId = String(req.body.categoryId || "contact").trim();
    const pdfUrl     = String(req.body.pdfUrl || "").trim();
    const pdfLabel   = String(req.body.pdfLabel || "").trim();
    const order      = parseInt(req.body.order || "0", 10);
    if (!question || !answer) return res.redirect("/zq-admin/schools/" + school._id + "/faq/cat/" + categoryId + "?error=" + encodeURIComponent("Question and answer are required."));
    const items = school.faqItems || [];
    if (items.length >= 100) return res.redirect("/zq-admin/schools/" + school._id + "/faq/cat/" + categoryId + "?error=" + encodeURIComponent("Maximum 100 questions per school."));
    items.push({ id: _genFaqId(), categoryId, question, answer, pdfUrl: pdfUrl || undefined, pdfLabel: pdfLabel || undefined, active: true, order, isDefault: false });
    school.faqItems = items;
    await school.save();
    res.redirect("/zq-admin/schools/" + school._id + "/faq/cat/" + categoryId + "?success=" + encodeURIComponent("Question added. Parents will see it in this category."));
  } catch (err) {
    res.redirect("/zq-admin/schools/" + req.params.id + "/faq?error=" + encodeURIComponent(err.message));
  }
});

// ── Edit question/answer (POST) ────────────────────────────────────────────
router.post("/schools/:id/faq/q/:qId/edit", requireSupplierAdmin, async (req, res) => {
  try {
    const school = await SchoolProfile.findById(req.params.id);
    if (!school) return res.redirect("/zq-admin/schools");
    const q = (school.faqItems || []).find(x => x.id === req.params.qId);
    if (!q) return res.redirect("/zq-admin/schools/" + school._id + "/faq");
    const prevCat    = q.categoryId;
    q.categoryId     = String(req.body.categoryId || q.categoryId).trim();
    q.question       = String(req.body.question   || q.question).trim();
    q.answer         = String(req.body.answer     || q.answer).trim();
    q.pdfUrl         = String(req.body.pdfUrl     || "").trim() || undefined;
    q.pdfLabel       = String(req.body.pdfLabel   || "").trim() || undefined;
    q.order          = parseInt(req.body.order ?? q.order, 10);
    await school.save();
    res.redirect("/zq-admin/schools/" + school._id + "/faq/cat/" + q.categoryId + "?success=" + encodeURIComponent("Question updated."));
  } catch (err) {
    res.redirect("/zq-admin/schools/" + req.params.id + "/faq?error=" + encodeURIComponent(err.message));
  }
});

// ── Toggle question active ─────────────────────────────────────────────────
router.post("/schools/:id/faq/q/:qId/toggle", requireSupplierAdmin, async (req, res) => {
  try {
    const school = await SchoolProfile.findById(req.params.id);
    if (!school) return res.redirect("/zq-admin/schools");
    const q = (school.faqItems || []).find(x => x.id === req.params.qId);
    if (q) { q.active = !q.active; await school.save(); }
    res.redirect("/zq-admin/schools/" + school._id + "/faq/cat/" + (q?.categoryId || "") + "?success=" + encodeURIComponent("Question " + (q?.active ? "activated" : "hidden") + "."));
  } catch (err) {
    res.redirect("/zq-admin/schools/" + req.params.id + "/faq?error=" + encodeURIComponent(err.message));
  }
});

// ── Delete question ────────────────────────────────────────────────────────
router.post("/schools/:id/faq/q/:qId/delete", requireSupplierAdmin, async (req, res) => {
  try {
    const school = await SchoolProfile.findById(req.params.id);
    if (!school) return res.redirect("/zq-admin/schools");
    const q = (school.faqItems || []).find(x => x.id === req.params.qId);
    const catId = q?.categoryId || "";
    school.faqItems = (school.faqItems || []).filter(x => x.id !== req.params.qId);
    await school.save();
    res.redirect("/zq-admin/schools/" + school._id + "/faq/cat/" + catId + "?success=" + encodeURIComponent("Question deleted."));
  } catch (err) {
    res.redirect("/zq-admin/schools/" + req.params.id + "/faq?error=" + encodeURIComponent(err.message));
  }
});

// ── Move question up/down ──────────────────────────────────────────────────
router.post("/schools/:id/faq/q/:qId/move", requireSupplierAdmin, async (req, res) => {
  try {
    const school = await SchoolProfile.findById(req.params.id);
    if (!school) return res.redirect("/zq-admin/schools");
    const q    = (school.faqItems || []).find(x => x.id === req.params.qId);
    if (!q) return res.redirect("/zq-admin/schools/" + school._id + "/faq");
    const dir  = req.body.dir === "up" ? -1 : 1;
    const cats = (school.faqItems || []).filter(x => x.categoryId === q.categoryId).sort((a,b) => (a.order||0)-(b.order||0));
    const idx  = cats.findIndex(x => x.id === q.id);
    const swap = idx + dir;
    if (idx >= 0 && swap >= 0 && swap < cats.length) { const tmp = cats[idx].order; cats[idx].order = cats[swap].order; cats[swap].order = tmp; }
    await school.save();
    res.redirect("/zq-admin/schools/" + school._id + "/faq/cat/" + q.categoryId + "?success=" + encodeURIComponent("Question reordered."));
  } catch (err) {
    res.redirect("/zq-admin/schools/" + req.params.id + "/faq?error=" + encodeURIComponent(err.message));
  }
});

export default router;