// routes/schoolAdmin.js
// ─── ZimQuote School Admin Panel ─────────────────────────────────────────────
// Mirrors supplierAdmin.js patterns exactly.
// Mount at: app.use("/zq-admin", schoolAdminRouter) in your main app file
// (same router as supplierAdmin — just add the routes below to the existing
//  supplierAdmin router OR import and use separately with the same session auth)

import express from "express";
import { requireSupplierAdmin } from "../middleware/supplierAdminAuth.js";
import SchoolProfile from "../models/schoolProfile.js";
import SchoolSubscriptionPayment from "../models/schoolSubscriptionPayment.js";
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

const router = express.Router();
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
  return `<div class="stat-card ${color ? "stat-" + color : ""}">
    <div class="stat-val">${value}</div>
    <div class="stat-lbl">${label}</div>
  </div>`;
}
function tierColor(t) {
  return { basic: "blue", featured: "orange" }[t] || "gray";
}

// ─── Shared layout (same CSS as supplierAdmin — reuses the sidebar nav) ────────
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
                <option ${status === "active"   ? "selected" : ""} value="active">Active</option>
                <option ${status === "inactive" ? "selected" : ""} value="inactive">Inactive</option>
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
              <td>${badge(s.active ? "Active" : "Inactive", s.active ? "green" : "gray")}</td>
              <td>${s.admissionsOpen ? "🟢 Open" : "🔴 Closed"}</td>
              <td>⭐ ${(s.rating || 0).toFixed(1)}</td>
              <td><a href="/zq-admin/schools/${s._id}" class="btn-link">Manage →</a></td>
            </tr>`).join("") : `
            <tr><td colspan="9" style="text-align:center;padding:32px;color:var(--muted)">No schools found.</td></tr>`}
          </tbody>
        </table>
        ${pages > 1 ? `
        <div class="pagination">
          ${Number(page) > 1 ? `<a href="${qs(Number(page) - 1)}">← Prev</a>` : ""}
          ${Array.from({ length: Math.min(pages, 10) }, (_, i) => i + 1).map(p =>
            `<a href="${qs(p)}" class="${Number(page) === p ? "active" : ""}">${p}</a>`
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
        <span style="font-size:12px;color:var(--muted)">Admin-created listing — bypasses WhatsApp flow</span>
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
                <option value="basic">✅ Basic — $15/month</option>
                <option value="featured">🔥 Featured — $35/month</option>
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
                <option value="true">✅ Yes — visible to parents now</option>
                <option value="false">⏸ No — save as inactive</option>
              </select>
            </div>
            <div class="fg">
              <label>Admissions Open?</label>
              <select name="admissionsOpen">
                <option value="true">🟢 Yes — currently accepting</option>
                <option value="false">🔴 No — closed</option>
              </select>
            </div>
            <div class="fg">
              <label>Mark as Verified?</label>
              <select name="verified">
                <option value="false">No</option>
                <option value="true">✅ Yes — show verified badge</option>
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
      schoolName, phone, city, suburb, address, email, website,
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
    const t1 = parseFloat(feesTerm1) || 0;
    const t2 = parseFloat(feesTerm2) || t1;
    const t3 = parseFloat(feesTerm3) || t1;
    const fees     = { term1: t1, term2: t2, term3: t3, currency: "USD" };
    const feeRange = computeSchoolFeeRange(t1);

    // Normalise checkbox arrays (single value comes as string, multiple as array)
    const curriculumArr         = curriculum         ? (Array.isArray(curriculum)         ? curriculum         : [curriculum])         : [];
    const facilitiesArr         = facilities         ? (Array.isArray(facilities)         ? facilities         : [facilities])         : [];
    const extramuralArr         = extramuralActivities ? (Array.isArray(extramuralActivities) ? extramuralActivities : [extramuralActivities]) : [];

    const school = await SchoolProfile.create({
      schoolName:           schoolName.trim(),
      phone:                cleanPhone,
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
            <dt>Phone</dt><dd>${esc(school.phone)}</dd>
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
            <dt>Fees / Term</dt><dd>$${school.fees?.term1 || 0} / $${school.fees?.term2 || 0} / $${school.fees?.term3 || 0} USD
              <span class="badge badge-${school.feeRange === "budget" ? "green" : school.feeRange === "premium" ? "orange" : "blue"}" style="margin-left:6px">${esc(school.feeRange || "-")}</span>
            </dd>
            <dt>Plan</dt><dd>${badge(school.tier || "none", tierColor(school.tier))}</dd>
            <dt>Status</dt><dd>${badge(school.active ? "Active" : "Inactive", school.active ? "green" : "gray")}</dd>
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
              <button class="btn ${school.active ? "btn-orange" : "btn-green"}">
                ${school.active ? "⏸ Deactivate" : "✅ Activate"}
              </button>
            </form>
            <form method="POST" action="/zq-admin/schools/${school._id}/toggle-admissions" style="display:inline">
              <button class="btn ${school.admissionsOpen ? "btn-gray" : "btn-green"}">
                ${school.admissionsOpen ? "🔴 Close Admissions" : "🟢 Open Admissions"}
              </button>
            </form>
            <form method="POST" action="/zq-admin/schools/${school._id}/toggle-verified" style="display:inline">
              <button class="btn ${school.verified ? "btn-orange" : "btn-blue"}">
                ${school.verified ? "❌ Remove Verified" : "✅ Mark Verified"}
              </button>
            </form>
            <a href="/zq-admin/schools/${school._id}/activate" class="btn btn-green">
              🎁 Manual Activation
            </a>
          </div>
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
          <thead><tr><th>Plan</th><th>Amount</th><th>Status</th><th>Paid</th><th>Expires</th></tr></thead>
          <tbody>
            ${payments.map(p => `
            <tr>
              <td>${esc(p.tier)} / ${esc(p.plan)}</td>
              <td>$${p.amount}</td>
              <td>${badge(p.status, p.status === "paid" ? "green" : "gray")}</td>
              <td>${p.paidAt ? new Date(p.paidAt).toLocaleDateString() : "-"}</td>
              <td>${p.endsAt ? new Date(p.endsAt).toLocaleDateString() : "-"}</td>
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
            <div class="fg"><label>Phone</label><input name="phone" value="${esc(school.phone)}" required /></div>
            <div class="fg">
              <label>City</label>
              <select name="city" required>
                <option value="">Select city...</option>
                ${cityOptions}
                <option value="${esc(school.city)}" selected>${esc(school.city)}</option>
              </select>
            </div>
            <div class="fg"><label>Suburb / Area</label><input name="suburb" value="${esc(school.suburb || "")}" required /></div>
            <div class="fg"><label>Address</label><input name="address" value="${esc(school.address || "")}" /></div>
            <div class="fg"><label>Email</label><input name="email" type="email" value="${esc(school.email || "")}" /></div>
            <div class="fg"><label>Website</label><input name="website" value="${esc(school.website || "")}" /></div>
            <div class="fg"><label>Principal</label><input name="principalName" value="${esc(school.principalName || "")}" /></div>
          </div>

          <!-- ── Academic ────────────────────────────────────────────── -->
          <p style="font-weight:700;font-size:13px;margin-bottom:14px;margin-top:20px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px">Academic Profile</p>
          <div class="form-grid">
            <div class="fg"><label>School Type</label><select name="type">${typeOptions}</select></div>
            <div class="fg"><label>Gender</label><select name="gender">${genderOptions}</select></div>
            <div class="fg"><label>Boarding</label><select name="boarding">${boardingOptions}</select></div>
            <div class="fg"><label>Grades From</label><input name="gradesFrom" value="${esc(school.grades?.from || "ECD A")}" /></div>
            <div class="fg"><label>Grades To</label><input name="gradesTo" value="${esc(school.grades?.to || "Form 6")}" /></div>
            <div class="fg"><label>Capacity</label><input type="number" name="capacity" value="${school.capacity || 0}" min="0" /></div>
          </div>
          <div class="fg full" style="margin-bottom:14px">
            <label>Curriculum</label>
            <div class="checkbox-grid">${curriculumChecks}</div>
          </div>

          <!-- ── Fees ────────────────────────────────────────────────── -->
          <p style="font-weight:700;font-size:13px;margin-bottom:14px;margin-top:20px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px">Fees (USD)</p>
          <div class="form-grid">
            <div class="fg"><label>Term 1 ($)</label><input type="number" name="feesTerm1" value="${school.fees?.term1 || 0}" min="0" step="0.01" /></div>
            <div class="fg"><label>Term 2 ($)</label><input type="number" name="feesTerm2" value="${school.fees?.term2 || 0}" min="0" step="0.01" /></div>
            <div class="fg"><label>Term 3 ($)</label><input type="number" name="feesTerm3" value="${school.fees?.term3 || 0}" min="0" step="0.01" /></div>
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
                <option value="basic"    ${school.tier === "basic"    ? "selected" : ""}>Basic — $15/month</option>
                <option value="featured" ${school.tier === "featured" ? "selected" : ""}>Featured — $35/month</option>
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
            <input name="registrationLink" value="${esc(school.registrationLink || "")}" placeholder="https://forms.gle/..." />
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
      schoolName, phone, city, suburb, address, email, website,
      principalName, type, gender, boarding, gradesFrom, gradesTo,
      capacity, curriculum, facilities, extramuralActivities,
      feesTerm1, feesTerm2, feesTerm3,
      registrationLink, tier, subscriptionEndsAt,
      active, admissionsOpen, verified, adminNote
    } = req.body;

    const t1 = parseFloat(feesTerm1) || 0;
    const t2 = parseFloat(feesTerm2) || t1;
    const t3 = parseFloat(feesTerm3) || t1;

    const curriculumArr = curriculum
      ? (Array.isArray(curriculum) ? curriculum : [curriculum]) : [];
    const facilitiesArr = facilities
      ? (Array.isArray(facilities) ? facilities : [facilities]) : [];
    const extramuralArr = extramuralActivities
      ? (Array.isArray(extramuralActivities) ? extramuralActivities : [extramuralActivities]) : [];

    school.schoolName           = schoolName?.trim() || school.schoolName;
    school.phone                = phone?.trim().replace(/\s+/g, "") || school.phone;
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
    school.fees                 = { term1: t1, term2: t2, term3: t3, currency: "USD" };
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
// MANUAL ACTIVATION (GET form)
// GET /zq-admin/schools/:id/activate
// ─────────────────────────────────────────────────────────────────────────────
router.get("/schools/:id/activate", requireSupplierAdmin, async (req, res) => {
  try {
    const school = await SchoolProfile.findById(req.params.id).lean();
    if (!school) return res.redirect("/zq-admin/schools");

    res.send(layout(`Activate: ${esc(school.schoolName)}`, `
      <a href="/zq-admin/schools/${school._id}" class="back-link">← Back to Profile</a>
      <div class="panel" style="max-width:600px">
        <h3>🎁 Manual Activation — ${esc(school.schoolName)}</h3>
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
                <option value="basic">✅ Basic — $15/month</option>
                <option value="featured">🔥 Featured — $35/month</option>
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
          </div>
          <div class="fg full" style="margin-bottom:16px">
            <label>Also set listing Active?</label>
            <select name="setActive">
              <option value="true">Yes — make listing visible to parents now</option>
              <option value="false">No — activate subscription only</option>
            </select>
          </div>
          <div class="fg full" style="margin-bottom:16px">
            <label>Mark as Verified?</label>
            <select name="setVerified">
              <option value="false">No</option>
              <option value="true">✅ Yes — add verified badge</option>
            </select>
          </div>
          <div class="form-actions">
            <button type="submit" class="btn btn-green">✅ Activate Now</button>
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
// MANUAL ACTIVATION (POST handler)
// POST /zq-admin/schools/:id/activate
// ─────────────────────────────────────────────────────────────────────────────
router.post("/schools/:id/activate", requireSupplierAdmin, async (req, res) => {
  try {
    const { tier, plan, durationDays, reason, setActive, setVerified } = req.body;

    const school = await SchoolProfile.findById(req.params.id);
    if (!school) return res.redirect("/zq-admin/schools");

    const now       = new Date();
    const days      = Number(durationDays) || 30;
    const expiresAt = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
    const isActive  = setActive === "true";

    // Update the school profile
    school.tier               = tier || "basic";
    school.subscriptionPlan   = plan || "monthly";
    school.subscriptionEndsAt = expiresAt;
    school.active             = isActive;
    if (setVerified === "true") school.verified = true;
    if (reason?.trim()) {
      school.adminNote = (school.adminNote ? school.adminNote + " | " : "") +
        `[Activated on ${now.toDateString()}: ${reason.trim()}]`;
    }
    await school.save();

    // Log a $0 payment record for the audit trail
    await SchoolSubscriptionPayment.create({
      phone:     school.phone,
      schoolId:  school._id,
      tier:      tier || "basic",
      plan:      plan || "monthly",
      amount:    0,
      currency:  "USD",
      reference: `ADMIN_ACT_${school._id}_${Date.now()}`,
      status:    "paid",
      paidAt:    now,
      endsAt:    expiresAt
    });

    // Notify the school via WhatsApp
    try {
      const { sendText } = await import("../services/metaSender.js");
      await sendText(school.phone,
`🎉 *Your school listing is now LIVE on ZimQuote!*

🏫 *${school.schoolName}*
Plan: *${tier === "featured" ? "🔥 Featured" : "✅ Basic"}*
Active until: *${expiresAt.toDateString()}*

Parents across Zimbabwe can now find your school and make inquiries.

Type *menu* to manage your listing. 🎓`
      );
    } catch (notifyErr) {
      console.error("[School Activation] WhatsApp notify failed:", notifyErr.message);
    }

    res.redirect(
      `/zq-admin/schools/${school._id}?success=${encodeURIComponent(
        `School activated on ${tier} plan until ${expiresAt.toDateString()}.${isActive ? " Listing is now visible to parents." : ""}`
      )}`
    );
  } catch (err) {
    res.send(layout("Error", `<div class="alert red">${err.message}</div>`));
  }
});

export default router;