// routes/office.js
// ─────────────────────────────────────────────────────────────────────────────
//  ZimQuote BACK-OFFICE PORTAL  (mounts at /office)
//
//  A brand-new, self-contained web portal for business OWNERS, MANAGERS and
//  CLERKS. It works hand-in-hand with the WhatsApp chatbot: it reads and writes
//  the SAME data (Invoice/Expense/StockItem/UserRole/Branch) using the SAME
//  services the bot uses, so anything done here shows on WhatsApp and vice-versa.
//
//  Identity = UserRole (the same record the bot uses for staff). We added
//  username/passwordHash/mustSetPassword to UserRole so staff can log in on the
//  web with a username + password, while their WhatsApp number keeps working.
//
//  Auth is session-based (req.session.officeRoleId) using the express-session
//  already configured in server.js. No new session store needed.
//
//  UI is rendered as self-contained HTML (same proven pattern as
//  supplierAdmin.js) so there is no view-engine/partial coupling. Fully
//  responsive, modern, accounting-styled. Each role only sees what applies.
//
//  MOUNT (server.js):
//     import officeRoutes from "./routes/office.js";
//     app.use("/office", officeRoutes);
// ─────────────────────────────────────────────────────────────────────────────
import { Router } from "express";

const router = Router();

const BOT_NUMBER = (process.env.TWILIO_WHATSAPP_NUMBER || process.env.META_WHATSAPP_NUMBER || "").replace(/\D+/g, "");

// ─── tiny helpers ────────────────────────────────────────────────────────────
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function money(n, cur = "USD") {
  const v = Number(n) || 0;
  const sym = cur === "USD" ? "$" : (cur === "ZWL" ? "ZWL " : cur + " ");
  return sym + v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function num(n) { return (Number(n) || 0).toLocaleString("en-US"); }
function initials(name, phone) {
  const s = String(name || "").trim();
  if (s) return s.split(/\s+/).slice(0, 2).map(w => w[0]).join("").toUpperCase();
  return String(phone || "?").slice(-2);
}
function genTempPassword() {
  return "zq" + Math.random().toString(36).slice(2, 7);
}
function normalizePhone(raw) {
  let p = String(raw || "").replace(/\D+/g, "");
  if (p.startsWith("00")) p = p.slice(2);
  if (p.startsWith("0")) p = "263" + p.slice(1);
  if (p.length === 9) p = "263" + p;   // 77xxxxxxx → 26377xxxxxxx
  return p;
}
function startOfToday() { const d = new Date(); d.setHours(0, 0, 0, 0); return d; }
function startOfWeek() { const d = startOfToday(); const dow = (d.getDay() + 6) % 7; d.setDate(d.getDate() - dow); return d; }
function startOfMonth() { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1); }
function periodRange(period, q = {}) {
  const end = new Date();
  if (period === "today") return { start: startOfToday(), end, label: "Today" };
  if (period === "week") return { start: startOfWeek(), end, label: "This week" };
  if (period === "custom" && q.from && q.to) {
    const s = new Date(q.from); s.setHours(0, 0, 0, 0);
    const e = new Date(q.to); e.setHours(23, 59, 59, 999);
    if (!isNaN(s) && !isNaN(e)) return { start: s, end: e, label: `${q.from} → ${q.to}` };
  }
  return { start: startOfMonth(), end, label: "This month" };
}

// ─── model / service loaders (lazy, matches codebase style) ──────────────────
const M = {
  UserRole: () => import("../models/userRole.js").then(m => m.default),
  Business: () => import("../models/business.js").then(m => m.default),
  Branch:   () => import("../models/branch.js").then(m => m.default),
  Invoice:  () => import("../models/invoice.js").then(m => m.default),
  Expense:  () => import("../models/expense.js").then(m => m.default),
};
const svcReports = () => import("../services/dailyReportEnhanced.js");
const svcStock   = () => import("../services/stockService.js");

async function branchesFor(bizId) {
  try { const Branch = await M.Branch(); return await Branch.find({ businessId: bizId }).sort({ name: 1 }).lean(); }
  catch { return []; }
}
function effectiveBranch(office, req) {
  if (office.isOwner) {
    const b = req.query.branch || req.body?.branch || "";
    return b && b !== "all" ? b : null;
  }
  return office.scopeBranchId || null;
}

// ═════════════════════════════════════════════════════════════════════════════
//  UI SHELL  (modern, responsive, accounting vibe)
// ═════════════════════════════════════════════════════════════════════════════
const NAV = [
  { key: "dashboard", href: "/office",          icon: "▦", label: "Dashboard", roles: ["owner", "admin", "manager", "clerk"] },
  { key: "sales",     href: "/office/sales",    icon: "🧾", label: "Sales",     roles: ["owner", "admin", "manager", "clerk"] },
  { key: "expenses",  href: "/office/expenses", icon: "💸", label: "Expenses",  roles: ["owner", "admin", "manager", "clerk"] },
  { key: "stock",     href: "/office/stock",    icon: "📦", label: "Stock",     roles: ["owner", "admin", "manager", "clerk"] },
  { key: "products",  href: "/office/products", icon: "🏷", label: "Products",  roles: ["owner", "admin", "manager"] },
  { key: "reports",   href: "/office/reports",  icon: "📈", label: "Reports",   roles: ["owner", "admin", "manager", "clerk"] },
  { key: "team",      href: "/office/team",     icon: "👥", label: "Team",      roles: ["owner", "admin"] },
];

function shell(office, active, title, body, opts = {}) {
  const role = office.role.role;
  const nav = NAV.filter(n => n.roles.includes(role)).map(n => `
    <a href="${n.href}" class="nav-item ${n.key === active ? "active" : ""}">
      <span class="ni">${n.icon}</span><span class="nl">${esc(n.label)}</span>
    </a>`).join("");
  const bottomNav = NAV.filter(n => n.roles.includes(role)).slice(0, 5).map(n => `
    <a href="${n.href}" class="bn ${n.key === active ? "active" : ""}">
      <span>${n.icon}</span><small>${esc(n.label)}</small>
    </a>`).join("");

  const roleLabel = { owner: "Owner", admin: "Administrator", manager: "Manager", clerk: "Clerk" }[role] || role;
  const branchTag = office.branch ? esc(office.branch.name) : (office.isOwner ? "All branches" : "");

  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · ${esc(office.biz.name || "ZimQuote")}</title>
<style>
:root{
  --ink:#0f172a; --ink2:#1e293b; --muted:#64748b; --line:#e2e8f0; --bg:#f1f5f9;
  --card:#ffffff; --brand:#4f46e5; --brand2:#6366f1; --green:#16a34a; --red:#dc2626;
  --amber:#b45309; --soft:#f8fafc; --radius:14px; --shadow:0 1px 3px rgba(15,23,42,.06),0 8px 24px -12px rgba(15,23,42,.12);
}
*{box-sizing:border-box}
html,body{margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
  background:var(--bg);color:var(--ink2);font-size:15px;line-height:1.5;-webkit-font-smoothing:antialiased}
a{color:inherit;text-decoration:none}
.app{display:flex;min-height:100vh}
/* ── Sidebar ── */
.side{width:248px;background:linear-gradient(180deg,#0f172a,#131c31);color:#cbd5e1;
  display:flex;flex-direction:column;position:fixed;inset:0 auto 0 0;z-index:40;transition:transform .22s ease}
.brand{padding:20px 20px 16px;display:flex;align-items:center;gap:10px;border-bottom:1px solid rgba(255,255,255,.07)}
.brand .logo{width:34px;height:34px;border-radius:9px;background:linear-gradient(135deg,var(--brand),var(--brand2));
  display:flex;align-items:center;justify-content:center;color:#fff;font-weight:800}
.brand .bt{font-weight:800;color:#fff;font-size:15px;line-height:1.15}
.brand .bs{font-size:11px;color:#94a3b8}
.side .grp{padding:14px 14px 4px;font-size:10.5px;letter-spacing:.14em;text-transform:uppercase;color:#64748b}
.nav-item{display:flex;align-items:center;gap:12px;padding:11px 16px;margin:2px 10px;border-radius:10px;
  color:#cbd5e1;font-weight:500;font-size:14.5px}
.nav-item .ni{width:22px;text-align:center;font-size:15px}
.nav-item:hover{background:rgba(255,255,255,.06);color:#fff}
.nav-item.active{background:linear-gradient(135deg,var(--brand),var(--brand2));color:#fff;box-shadow:0 6px 16px -6px rgba(79,70,229,.7)}
.side .foot{margin-top:auto;padding:14px;border-top:1px solid rgba(255,255,255,.07)}
.ucard{display:flex;align-items:center;gap:10px;padding:8px;border-radius:10px;background:rgba(255,255,255,.05)}
.ucard .av{width:36px;height:36px;border-radius:50%;background:linear-gradient(135deg,#334155,#475569);
  color:#fff;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:13px}
.ucard .un{font-weight:700;color:#fff;font-size:13.5px}
.ucard .ur{font-size:11.5px;color:#94a3b8}
.logout{display:block;text-align:center;margin-top:10px;padding:9px;border-radius:9px;
  background:rgba(220,38,38,.12);color:#fca5a5;font-weight:600;font-size:13px}
.logout:hover{background:rgba(220,38,38,.2);color:#fecaca}
/* ── Main ── */
.main{flex:1;margin-left:248px;min-width:0;display:flex;flex-direction:column}
.top{position:sticky;top:0;z-index:30;background:rgba(255,255,255,.85);backdrop-filter:blur(8px);
  border-bottom:1px solid var(--line);padding:14px 24px;display:flex;align-items:center;gap:14px}
.top h1{font-size:19px;font-weight:800;color:var(--ink);margin:0}
.top .sub{font-size:12.5px;color:var(--muted)}
.top .spacer{flex:1}
.pill{display:inline-flex;align-items:center;gap:6px;background:var(--soft);border:1px solid var(--line);
  border-radius:999px;padding:6px 12px;font-size:12.5px;color:var(--muted);font-weight:600}
.burger{display:none;background:none;border:1px solid var(--line);border-radius:9px;width:40px;height:40px;
  font-size:18px;cursor:pointer;color:var(--ink)}
.wrap{padding:24px;max-width:1200px;width:100%;margin:0 auto}
@media(max-width:960px){
  .side{transform:translateX(-100%);box-shadow:0 0 40px rgba(0,0,0,.4)}
  body.nav-open .side{transform:translateX(0)}
  body.nav-open .scrim{display:block}
  .main{margin-left:0}
  .burger{display:inline-flex;align-items:center;justify-content:center}
  .wrap{padding:16px 14px 84px}
  .bottomnav{display:flex}
}
.scrim{display:none;position:fixed;inset:0;background:rgba(15,23,42,.5);z-index:35}
.bottomnav{display:none;position:fixed;bottom:0;left:0;right:0;z-index:38;background:#fff;border-top:1px solid var(--line);
  justify-content:space-around;padding:6px 4px env(safe-area-inset-bottom)}
.bn{display:flex;flex-direction:column;align-items:center;gap:2px;padding:6px 8px;color:var(--muted);font-size:16px;border-radius:10px}
.bn small{font-size:10px;font-weight:600}
.bn.active{color:var(--brand)}
/* ── Components ── */
.grid{display:grid;gap:16px}
.kpis{grid-template-columns:repeat(auto-fit,minmax(180px,1fr))}
.card{background:var(--card);border:1px solid var(--line);border-radius:var(--radius);box-shadow:var(--shadow)}
.card .ch{padding:16px 18px;border-bottom:1px solid var(--line);display:flex;align-items:center;gap:10px;justify-content:space-between}
.card .ch h3{margin:0;font-size:15px;font-weight:800;color:var(--ink)}
.card .cb{padding:18px}
.kpi{padding:18px}
.kpi .kl{font-size:11.5px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);font-weight:700}
.kpi .kv{font-size:26px;font-weight:800;color:var(--ink);margin-top:8px;letter-spacing:-.02em}
.kpi .ks{font-size:12px;color:var(--muted);margin-top:4px}
.kpi.accent{background:linear-gradient(135deg,var(--brand),var(--brand2));border:none;color:#fff}
.kpi.accent .kl,.kpi.accent .ks{color:rgba(255,255,255,.8)}
.kpi.accent .kv{color:#fff}
.green{color:var(--green)}.red{color:var(--red)}.amber{color:var(--amber)}
table{width:100%;border-collapse:collapse;font-size:13.5px}
th{text-align:left;padding:11px 14px;background:var(--soft);color:var(--muted);font-size:11.5px;
  text-transform:uppercase;letter-spacing:.05em;font-weight:700;border-bottom:1px solid var(--line)}
td{padding:12px 14px;border-bottom:1px solid var(--line);vertical-align:middle}
tr:last-child td{border-bottom:none}
.r{text-align:right}.c{text-align:center}
.tbl-wrap{overflow-x:auto}
.badge{display:inline-block;padding:3px 9px;border-radius:999px;font-size:11.5px;font-weight:700}
.b-green{background:#dcfce7;color:#166534}.b-red{background:#fee2e2;color:#991b1b}
.b-slate{background:#e2e8f0;color:#334155}.b-amber{background:#fef3c7;color:#92400e}.b-indigo{background:#e0e7ff;color:#3730a3}
.btn{display:inline-flex;align-items:center;gap:8px;justify-content:center;padding:11px 18px;border-radius:10px;
  font-weight:700;font-size:14px;cursor:pointer;border:1px solid transparent;transition:.15s}
.btn-primary{background:var(--brand);color:#fff}.btn-primary:hover{background:#4338ca}
.btn-ghost{background:#fff;border-color:var(--line);color:var(--ink)}.btn-ghost:hover{background:var(--soft)}
.btn-danger{background:#fff;border-color:#fecaca;color:var(--red)}.btn-danger:hover{background:#fef2f2}
.btn-sm{padding:7px 12px;font-size:12.5px}
.field{margin-bottom:14px}
.field label{display:block;font-size:12.5px;font-weight:700;color:var(--ink);margin-bottom:6px}
.input,select.input{width:100%;padding:11px 13px;border:1px solid var(--line);border-radius:10px;font-size:14.5px;
  background:#fff;color:var(--ink);outline:none;transition:.15s}
.input:focus{border-color:var(--brand);box-shadow:0 0 0 3px rgba(79,70,229,.12)}
.row{display:flex;gap:12px;flex-wrap:wrap}.row>*{flex:1;min-width:140px}
.alert{padding:12px 16px;border-radius:11px;font-size:13.5px;font-weight:600;margin-bottom:16px}
.alert.ok{background:#dcfce7;color:#166534}.alert.err{background:#fee2e2;color:#991b1b}
.empty{text-align:center;padding:40px 20px;color:var(--muted)}
.empty .e-ic{font-size:34px;margin-bottom:8px}
.muted{color:var(--muted)}.small{font-size:12.5px}
.section-title{font-size:13px;font-weight:800;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;margin:24px 0 12px}
.cred{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--ink);color:#a5f3fc;
  padding:4px 10px;border-radius:8px;font-size:14px;font-weight:700}
.hint{font-size:12.5px;color:var(--muted);margin-top:6px}
</style></head>
<body>
<div class="scrim" onclick="document.body.classList.remove('nav-open')"></div>
<div class="app">
  <aside class="side">
    <div class="brand">
      <div class="logo">${esc((office.biz.name || "Z")[0].toUpperCase())}</div>
      <div><div class="bt">${esc(office.biz.name || "ZimQuote")}</div><div class="bs">Business Office</div></div>
    </div>
    <div class="grp">Menu</div>
    ${nav}
    <div class="foot">
      <div class="ucard">
        <div class="av">${esc(initials(office.role.name, office.role.phone))}</div>
        <div><div class="un">${esc(office.role.name || office.role.phone || "Staff")}</div>
        <div class="ur">${esc(roleLabel)}${branchTag ? " · " + branchTag : ""}</div></div>
      </div>
      <a class="logout" href="/office/logout">Sign out</a>
    </div>
  </aside>
  <div class="main">
    <div class="top">
      <button class="burger" onclick="document.body.classList.toggle('nav-open')">☰</button>
      <div><h1>${esc(title)}</h1><div class="sub">${esc(office.biz.name || "")}${branchTag ? " · " + branchTag : ""}</div></div>
      <div class="spacer"></div>
      ${opts.topRight || `<span class="pill">${esc(roleLabel)}</span>`}
    </div>
    <div class="wrap">${body}</div>
  </div>
</div>
<nav class="bottomnav">${bottomNav}</nav>
</body></html>`;
}

function loginShell(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title>
<style>
*{box-sizing:border-box}body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;
  background:radial-gradient(1200px 600px at 20% -10%,#1e293b,#0f172a);min-height:100vh;display:flex;
  align-items:center;justify-content:center;padding:20px;color:#0f172a}
.box{width:100%;max-width:400px;background:#fff;border-radius:18px;padding:34px 30px;
  box-shadow:0 30px 60px -20px rgba(0,0,0,.5)}
.lg{width:52px;height:52px;border-radius:14px;background:linear-gradient(135deg,#4f46e5,#6366f1);
  display:flex;align-items:center;justify-content:center;color:#fff;font-weight:800;font-size:22px;margin:0 auto 16px}
h1{font-size:22px;text-align:center;margin:0 0 4px}p.sub{text-align:center;color:#64748b;margin:0 0 22px;font-size:14px}
label{display:block;font-size:13px;font-weight:700;margin:0 0 6px}
.input{width:100%;padding:12px 14px;border:1px solid #e2e8f0;border-radius:11px;font-size:15px;margin-bottom:14px;outline:none}
.input:focus{border-color:#4f46e5;box-shadow:0 0 0 3px rgba(79,70,229,.14)}
.btn{width:100%;padding:13px;border:none;border-radius:11px;background:#4f46e5;color:#fff;font-size:15px;
  font-weight:700;cursor:pointer}.btn:hover{background:#4338ca}
.err{background:#fee2e2;color:#991b1b;padding:11px 14px;border-radius:10px;font-size:13.5px;font-weight:600;margin-bottom:16px}
.foot{text-align:center;color:#94a3b8;font-size:12.5px;margin-top:18px}
</style></head><body><div class="box">${body}</div></body></html>`;
}

// ═════════════════════════════════════════════════════════════════════════════
//  AUTH
// ═════════════════════════════════════════════════════════════════════════════
router.get("/login", (req, res) => {
  if (req.session?.officeRoleId) return res.redirect("/office");
  const err = req.query.err ? `<div class="err">${esc(req.query.err)}</div>` : "";
  res.send(loginShell("Sign in", `
    <div class="lg">Z</div>
    <h1>Business Office</h1><p class="sub">Sign in to manage sales, stock & reports</p>
    ${err}
    <form method="POST" action="/office/login">
      <label>Username</label>
      <input class="input" name="username" autocapitalize="none" autocomplete="username" placeholder="e.g. tino482" required>
      <label>Password</label>
      <input class="input" name="password" type="password" autocomplete="current-password" placeholder="Your password" required>
      <button class="btn">Sign in</button>
    </form>
    <div class="foot">Prefer WhatsApp? Send <b>hi</b> to your ZimQuote number.</div>`));
});

router.post("/login", async (req, res) => {
  try {
    const username = String(req.body.username || "").trim().toLowerCase();
    const password = String(req.body.password || "");
    if (!username || !password) return res.redirect("/office/login?err=" + encodeURIComponent("Enter your username and password"));
    const UserRole = await M.UserRole();
    const role = await UserRole.findOne({ username });
    if (!role || role.suspended || !role.passwordHash) {
      return res.redirect("/office/login?err=" + encodeURIComponent("Invalid username or password"));
    }
    const ok = await role.verifyPassword(password);
    if (!ok) return res.redirect("/office/login?err=" + encodeURIComponent("Invalid username or password"));
    role.lastWebLogin = new Date();
    await role.save();
    req.session.officeRoleId = String(role._id);
    return res.redirect(role.mustSetPassword ? "/office/set-password" : "/office");
  } catch (e) {
    console.error("[office login]", e.message);
    return res.redirect("/office/login?err=" + encodeURIComponent("Something went wrong. Try again."));
  }
});

router.get("/logout", (req, res) => {
  if (req.session) req.session.officeRoleId = null;
  res.redirect("/office/login");
});

// ─── auth middleware (everything below requires a session) ───────────────────
async function requireOffice(req, res, next) {
  try {
    const id = req.session?.officeRoleId;
    if (!id) return res.redirect("/office/login");
    const UserRole = await M.UserRole();
    const role = await UserRole.findById(id);
    if (!role || role.suspended) { req.session.officeRoleId = null; return res.redirect("/office/login?err=" + encodeURIComponent("Session ended. Please sign in.")); }
    const Business = await M.Business();
    const biz = await Business.findById(role.businessId).lean();
    if (!biz) { req.session.officeRoleId = null; return res.redirect("/office/login"); }
    let branch = null;
    if (role.branchId) { try { const Branch = await M.Branch(); branch = await Branch.findById(role.branchId).lean(); } catch {} }
    const isOwner = role.role === "owner" || role.role === "admin";
    req.office = {
      role, biz, branch,
      isOwner, isManager: role.role === "manager", isClerk: role.role === "clerk",
      scopeBranchId: isOwner ? null : (role.branchId ? String(role.branchId) : null),
      cur: biz.currency || "USD",
    };
    if (role.mustSetPassword && req.path !== "/set-password" && req.path !== "/logout") {
      return res.redirect("/office/set-password");
    }
    next();
  } catch (e) { console.error("[office auth]", e.message); res.redirect("/office/login"); }
}

// ─── force password on first login ───────────────────────────────────────────
router.get("/set-password", requireOffice, (req, res) => {
  const err = req.query.err ? `<div class="err">${esc(req.query.err)}</div>` : "";
  res.send(loginShell("Set your password", `
    <div class="lg">Z</div>
    <h1>Set your password</h1><p class="sub">Welcome, ${esc(req.office.role.name || "there")}. Choose a password to finish.</p>
    ${err}
    <form method="POST" action="/office/set-password">
      <label>New password</label>
      <input class="input" name="password" type="password" minlength="6" placeholder="At least 6 characters" required>
      <label>Confirm password</label>
      <input class="input" name="confirm" type="password" minlength="6" placeholder="Re-type it" required>
      <button class="btn">Save & continue</button>
    </form>`));
});
router.post("/set-password", requireOffice, async (req, res) => {
  const pw = String(req.body.password || ""), cf = String(req.body.confirm || "");
  if (pw.length < 6) return res.redirect("/office/set-password?err=" + encodeURIComponent("Password must be at least 6 characters"));
  if (pw !== cf) return res.redirect("/office/set-password?err=" + encodeURIComponent("Passwords don't match"));
  await req.office.role.setPassword(pw);
  await req.office.role.save();
  res.redirect("/office");
});

router.use(requireOffice);

// ═════════════════════════════════════════════════════════════════════════════
//  DASHBOARD
// ═════════════════════════════════════════════════════════════════════════════
router.get("/", async (req, res) => {
  const { office } = req;
  const cur = office.cur;
  const branchId = effectiveBranch(office, req);
  try {
    const { fetchReportData, calcTotals } = await svcReports();
    const now = new Date();
    const [today, month] = await Promise.all([
      fetchReportData({ biz: office.biz, start: startOfToday(), end: now, branchId }).then(calcTotals),
      fetchReportData({ biz: office.biz, start: startOfMonth(), end: now, branchId }).then(calcTotals),
    ]);

    // Stock snapshot (only if enabled)
    let stock = null;
    try {
      const { isStockEnabled, buildStockReport } = await svcStock();
      if (await isStockEnabled(office.biz._id)) {
        stock = await buildStockReport({ biz: office.biz, branchId, start: startOfMonth(), end: now });
      }
    } catch (e) { console.warn("[office dash stock]", e.message); }

    const kpi = (label, val, sub, cls = "", accent = false) => `
      <div class="card kpi ${accent ? "accent" : ""}">
        <div class="kl">${esc(label)}</div>
        <div class="kv ${cls}">${val}</div>
        <div class="ks">${esc(sub)}</div>
      </div>`;

    const stockCards = stock ? `
      ${kpi("Stock value (cost)", money(stock.totals.stockValueCost, cur), `${num(stock.itemCount || stock.rows.length)} tracked items`)}
      ${kpi("Low-stock items", num(stock.totals.lowStockCount), stock.totals.lowStockCount ? "Need restocking" : "All healthy", stock.totals.lowStockCount ? "red" : "green")}` : "";

    const body = `
      ${office.isOwner ? branchFilter(await branchesFor(office.biz._id), branchId, "/office") : ""}
      <div class="grid kpis">
        ${kpi("Money in — today", money(today.moneyIn, cur), `Cash ${money(today.cashSales, cur)} · Paid ${money(today.invoicePayments, cur)}`, "green", true)}
        ${kpi("Profit — today", money(today.profit, cur), `Out ${money(today.moneyOut, cur)}`, today.profit >= 0 ? "green" : "red")}
        ${kpi("Money in — this month", money(month.moneyIn, cur), `Profit ${money(month.profit, cur)}`)}
        ${kpi("Outstanding (unpaid)", money(month.outstanding, cur), `Invoiced ${money(month.totalInvoiced, cur)}`, month.outstanding > 0 ? "amber" : "")}
        ${stockCards}
      </div>

      <div class="section-title">Quick actions</div>
      <div class="row">
        <a class="btn btn-primary" href="/office/stock">📦 Manage stock</a>
        <a class="btn btn-ghost" href="/office/reports">📈 Run a report</a>
        <a class="btn btn-ghost" href="/office/sales">🧾 View sales</a>
        ${office.isOwner ? `<a class="btn btn-ghost" href="/office/team">👥 Manage team</a>` : ""}
      </div>

      <div class="card" style="margin-top:24px">
        <div class="ch"><h3>Record on the go</h3></div>
        <div class="cb">
          <p class="muted small" style="margin:0 0 12px">Record sales and expenses right here — they use the same numbering and owner notifications as WhatsApp, so everything stays in sync.</p>
          <div class="row">
            <a class="btn btn-primary btn-sm" href="/office/sales#newsale">🧾 Record a sale</a>
            <a class="btn btn-ghost btn-sm" href="/office/expenses#newexp">💸 Record an expense</a>
            ${BOT_NUMBER ? `<a class="btn btn-ghost btn-sm" target="_blank" href="https://wa.me/${BOT_NUMBER}?text=hi">Or use WhatsApp →</a>` : ""}
          </div>
        </div>
      </div>`;
    res.send(shell(office, "dashboard", "Dashboard", body));
  } catch (e) {
    console.error("[office dashboard]", e);
    res.send(shell(office, "dashboard", "Dashboard", `<div class="alert err">Couldn't load the dashboard: ${esc(e.message)}</div>`));
  }
});

function branchFilter(branches, current, base) {
  if (!branches.length) return "";
  const opt = (v, l) => `<option value="${esc(v)}" ${String(current || "all") === String(v) ? "selected" : ""}>${esc(l)}</option>`;
  return `<form method="GET" action="${base}" class="card" style="padding:12px 14px;margin-bottom:16px;display:flex;gap:10px;align-items:center;flex-wrap:wrap">
    <span class="small muted" style="font-weight:700">Branch</span>
    <select class="input" name="branch" style="max-width:280px" onchange="this.form.submit()">
      ${opt("all", "All branches")}
      ${branches.map(b => opt(b._id, b.name)).join("")}
    </select></form>`;
}

// ═════════════════════════════════════════════════════════════════════════════
//  SALES  (read — receipts + invoices)
// ═════════════════════════════════════════════════════════════════════════════
router.get("/sales", async (req, res) => {
  const { office } = req; const cur = office.cur;
  const branchId = effectiveBranch(office, req);
  try {
    const Invoice = await M.Invoice();
    const q = { businessId: office.biz._id, type: { $in: ["receipt", "invoice"] } };
    if (branchId) q.branchId = branchId;
    const docs = await Invoice.find(q).sort({ createdAt: -1 }).limit(80).lean();

    const { listClients, listProducts } = await import("../services/officeData.js");
    const [clients, products] = await Promise.all([
      listClients({ businessId: office.biz._id }).catch(() => []),
      listProducts({ businessId: office.biz._id, branchId }).catch(() => []),
    ]);
    const clientOpts = clients.map(c => `<option value="${esc(c._id)}">${esc(c.name || c.phone)}${c.phone ? " · " + esc(c.phone) : ""}</option>`).join("");
    const productOptsHtml = products.map(p => `<option value="${esc(p.name)}" data-price="${p.unitPrice || 0}">${esc(p.name)}${p.unitPrice ? " — " + money(p.unitPrice, cur) : ""}</option>`).join("");
    const productSelectHtml = '<option value="">- pick a product -</option>' + productOptsHtml + '<option value="__custom__">Other (type below)</option>';

    const rows = docs.map(d => {
      const isReceipt = d.type === "receipt";
      const paid = isReceipt || (Number(d.balance) || 0) <= 0;
      return `<tr>
        <td><b>${esc(d.invoiceNumber || d.receiptNumber || d.number || String(d._id).slice(-6))}</b></td>
        <td><span class="badge ${isReceipt ? "b-green" : "b-indigo"}">${isReceipt ? "Receipt" : "Invoice"}</span></td>
        <td>${esc(d.clientName || d.customerName || "Walk-in")}</td>
        <td class="r">${money(d.total, cur)}</td>
        <td class="r">${isReceipt ? "—" : money(d.balance, cur)}</td>
        <td class="c"><span class="badge ${paid ? "b-green" : "b-amber"}">${paid ? "Paid" : "Owing"}</span></td>
        <td class="small muted">${new Date(d.createdAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}</td>
      </tr>`;
    }).join("");

    const ok = req.query.ok ? `<div class="alert ok">${esc(req.query.ok)}</div>` : "";
    const err = req.query.err ? `<div class="alert err">${esc(req.query.err)}</div>` : "";
    const body = `
      ${ok}${err}
      ${office.isOwner ? branchFilter(await branchesFor(office.biz._id), branchId, "/office/sales") : ""}
      <details id="newsale" class="card" style="margin-bottom:18px" ${req.query.err ? "open" : ""}>
        <summary class="ch" style="cursor:pointer"><h3>➕ New cash sale (receipt)</h3><span class="pill">tap to open</span></summary>
        <div class="cb">
          <form method="POST" action="/office/sales/new">
            <input type="hidden" name="branch" value="${esc(branchId || "")}">
            <div class="field"><label>Customer</label>
              <select class="input" name="clientId" id="clientSel" onchange="onClientChange()">
                <option value="walkin">🚶 Walk-in Customer</option>
                ${clientOpts}
                <option value="new">➕ New customer…</option>
              </select>
            </div>
            <div id="newClient" class="row" style="display:none">
              <div class="field"><label>New customer name</label><input class="input" name="customerName" placeholder="e.g. John Moyo"></div>
              <div class="field"><label>Phone (optional)</label><input class="input" name="customerPhone" placeholder="e.g. 0771234567"></div>
            </div>
            <label style="font-size:12.5px;font-weight:700;color:var(--ink);margin:4px 0 6px;display:block">Items</label>
            <div id="saleItems"></div>
            <button type="button" class="btn btn-ghost btn-sm" onclick="addSaleRow()">＋ Add item</button>
            <div style="display:flex;justify-content:flex-end;margin-top:14px"><button class="btn btn-primary">Record cash sale</button></div>
          </form>
        </div>
      </details>
      <script>
      var PRODUCT_OPTS = ${JSON.stringify(productSelectHtml)};
      function onClientChange(){var v=document.getElementById('clientSel').value;document.getElementById('newClient').style.display=(v==='new')?'flex':'none';}
      function addSaleRow(){var w=document.getElementById('saleItems');var d=document.createElement('div');d.className='row';d.style.marginBottom='8px';d.style.alignItems='flex-start';
      d.innerHTML='<div class="field" style="margin:0;flex:2"><select class="input" name="pick[]" onchange="pickProduct(this)">'+PRODUCT_OPTS+'</select>'+
      '<input class="input" name="item_name[]" placeholder="Item name" style="margin-top:6px;display:none"></div>'+
      '<div class="field" style="margin:0;max-width:90px"><input class="input" type="number" step="0.01" min="0" name="qty[]" placeholder="Qty" value="1"></div>'+
      '<div class="field" style="margin:0;max-width:120px"><input class="input" type="number" step="0.01" min="0" name="unit[]" placeholder="Price"></div>'+
      '<button type="button" class="btn btn-danger btn-sm" style="flex:0 0 auto" onclick="this.parentNode.remove()">&times;</button>';
      w.appendChild(d);}
      function pickProduct(sel){var opt=sel.options[sel.selectedIndex];var row=sel.parentNode.parentNode;var nameInput=row.querySelector('input[name="item_name[]"]');var unit=row.querySelector('input[name="unit[]"]');
      if(sel.value==='__custom__'){nameInput.style.display='block';nameInput.value='';unit.value='';nameInput.focus();}
      else{nameInput.style.display='none';nameInput.value=sel.value;var pr=opt.getAttribute('data-price');if(pr&&Number(pr)>0)unit.value=pr;}}
      addSaleRow();
      </script>
      <div class="card">
        <div class="ch"><h3>Recent sales</h3>
          <a class="btn btn-ghost btn-sm" href="#newsale" onclick="var e=document.getElementById('newsale');e.open=true;e.scrollIntoView();return false;">＋ New sale</a>
        </div>
        ${docs.length ? `<div class="tbl-wrap"><table>
          <thead><tr><th>No.</th><th>Type</th><th>Customer</th><th class="r">Total</th><th class="r">Balance</th><th class="c">Status</th><th>Date</th></tr></thead>
          <tbody>${rows}</tbody></table></div>`
        : `<div class="empty"><div class="e-ic">🧾</div>No sales yet. Record your first sale on WhatsApp — it'll appear here instantly.</div>`}
      </div>`;
    res.send(shell(office, "sales", "Sales", body));
  } catch (e) {
    console.error("[office sales]", e);
    res.send(shell(office, "sales", "Sales", `<div class="alert err">Couldn't load sales: ${esc(e.message)}</div>`));
  }
});

// ═════════════════════════════════════════════════════════════════════════════
//  EXPENSES  (read)
// ═════════════════════════════════════════════════════════════════════════════
router.get("/expenses", async (req, res) => {
  const { office } = req; const cur = office.cur;
  const branchId = effectiveBranch(office, req);
  try {
    const Expense = await M.Expense();
    const q = { businessId: office.biz._id };
    if (branchId) q.branchId = branchId;
    const docs = await Expense.find(q).sort({ createdAt: -1 }).limit(80).lean();
    const total = docs.reduce((s, e) => s + (Number(e.amount) || 0), 0);

    const rows = docs.map(d => `<tr>
      <td>${esc(d.category || d.description || d.title || "Expense")}</td>
      <td class="small muted">${esc(d.note || d.description || "")}</td>
      <td class="r"><b class="red">${money(d.amount, cur)}</b></td>
      <td class="small muted">${new Date(d.createdAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}</td>
    </tr>`).join("");

    const ok = req.query.ok ? `<div class="alert ok">${esc(req.query.ok)}</div>` : "";
    const err = req.query.err ? `<div class="alert err">${esc(req.query.err)}</div>` : "";
    const body = `
      ${ok}${err}
      ${office.isOwner ? branchFilter(await branchesFor(office.biz._id), branchId, "/office/expenses") : ""}
      <details id="newexp" class="card" style="margin-bottom:18px" ${req.query.err ? "open" : ""}>
        <summary class="ch" style="cursor:pointer"><h3>➕ Record expense</h3><span class="pill">tap to open</span></summary>
        <div class="cb">
          <form method="POST" action="/office/expenses/new">
            <input type="hidden" name="branch" value="${esc(branchId || "")}">
            <div class="row">
              <div class="field"><label>Amount (${esc(cur)})</label><input class="input" type="number" step="0.01" min="0.01" name="amount" required></div>
              <div class="field"><label>Category</label><input class="input" name="category" placeholder="e.g. Transport, Rent, Airtime"></div>
            </div>
            <div class="row">
              <div class="field"><label>Description</label><input class="input" name="description" placeholder="What was it for?"></div>
              <div class="field"><label>Paid via</label><select class="input" name="method"><option>Cash</option><option>Bank</option><option>EcoCash</option><option>Other</option></select></div>
            </div>
            <div style="display:flex;justify-content:flex-end"><button class="btn btn-primary">Record expense</button></div>
          </form>
        </div>
      </details>
      <div class="grid kpis" style="margin-bottom:16px">
        <div class="card kpi"><div class="kl">Expenses shown</div><div class="kv red">${money(total, cur)}</div><div class="ks">${num(docs.length)} entries</div></div>
      </div>
      <div class="card">
        <div class="ch"><h3>Recent expenses</h3>
          <a class="btn btn-ghost btn-sm" href="#newexp" onclick="var e=document.getElementById('newexp');e.open=true;e.scrollIntoView();return false;">＋ New expense</a>
        </div>
        ${docs.length ? `<div class="tbl-wrap"><table>
          <thead><tr><th>Category</th><th>Note</th><th class="r">Amount</th><th>Date</th></tr></thead>
          <tbody>${rows}</tbody></table></div>`
        : `<div class="empty"><div class="e-ic">💸</div>No expenses recorded yet.</div>`}
      </div>`;
    res.send(shell(office, "expenses", "Expenses", body));
  } catch (e) {
    console.error("[office expenses]", e);
    res.send(shell(office, "expenses", "Expenses", `<div class="alert err">Couldn't load expenses: ${esc(e.message)}</div>`));
  }
});

// ─── record a cash sale (receipt): identical records/numbering/notify as the bot
router.post("/sales/new", async (req, res) => {
  const { office } = req;
  const branchId = effectiveBranch(office, req) || null;
  const back = "/office/sales" + (branchId ? "?branch=" + branchId : "");
  const sep = branchId ? "&" : "?";
  try {
    const names = [].concat(req.body.item_name || []);
    const qtys  = [].concat(req.body.qty || []);
    const units = [].concat(req.body.unit || []);
    const items = names.map((n, i) => ({ item: n, qty: qtys[i], unit: units[i] }))
      .filter(x => String(x.item || "").trim() && Number(x.qty) > 0);
    if (!items.length) return res.redirect(back + sep + "err=" + encodeURIComponent("Add at least one item with a quantity"));
    const clientSel = req.body.clientId || "walkin";
    const clientId = (clientSel && clientSel !== "walkin" && clientSel !== "new") ? clientSel : null;
    const customerName = clientSel === "new" ? req.body.customerName : "Walk-in Customer";
    const { createCashSale } = await import("../services/salesEntry.js");
    const r = await createCashSale({
      biz: office.biz, branchId, clerkPhone: office.role.phone || "web",
      clientId, customerName, customerPhone: req.body.customerPhone, items,
    });
    res.redirect(back + sep + "ok=" + encodeURIComponent(`Sale recorded — ${r.number} (${money(r.total, office.cur)})`));
  } catch (e) {
    console.error("[office sale new]", e);
    res.redirect(back + sep + "err=" + encodeURIComponent(e.message));
  }
});

// ─── record an expense: identical record + notify as the bot
router.post("/expenses/new", async (req, res) => {
  const { office } = req;
  const branchId = effectiveBranch(office, req) || null;
  const back = "/office/expenses" + (branchId ? "?branch=" + branchId : "");
  const sep = branchId ? "&" : "?";
  try {
    const amount = parseFloat(req.body.amount);
    if (!(amount > 0)) return res.redirect(back + sep + "err=" + encodeURIComponent("Enter a valid amount"));
    const { recordExpense } = await import("../services/salesEntry.js");
    await recordExpense({
      biz: office.biz, branchId, clerkPhone: office.role.phone || "web",
      amount, description: req.body.description, category: req.body.category, method: req.body.method,
    });
    res.redirect(back + sep + "ok=" + encodeURIComponent(`Expense recorded — ${money(amount, office.cur)}`));
  } catch (e) {
    console.error("[office expense new]", e);
    res.redirect(back + sep + "err=" + encodeURIComponent(e.message));
  }
});

// ═════════════════════════════════════════════════════════════════════════════
//  STOCK  (read + record stock-in / adjust — via stockService, safe)
// ═════════════════════════════════════════════════════════════════════════════
router.get("/stock", async (req, res) => {
  const { office } = req; const cur = office.cur;
  const branchId = effectiveBranch(office, req);
  try {
    const { isStockEnabled, buildStockReport, listStockItems } = await svcStock();
    if (!(await isStockEnabled(office.biz._id))) {
      return res.send(shell(office, "stock", "Stock", `
        <div class="card"><div class="cb empty">
          <div class="e-ic">📦</div>
          <h3 style="margin:.2em 0">Stock tracking is off</h3>
          <p class="muted">Turn it on from WhatsApp: <b>Business Tools → Stock Control → Enable</b>, then track your products. They'll appear here.</p>
          ${BOT_NUMBER ? `<a class="btn btn-primary" target="_blank" href="https://wa.me/${BOT_NUMBER}?text=hi" style="margin-top:10px">Open WhatsApp →</a>` : ""}
        </div></div>`));
    }
    const now = new Date();
    const report = await buildStockReport({ biz: office.biz, branchId, start: startOfMonth(), end: now });
    const items = await listStockItems(office.biz._id, branchId, true);
    const ok = req.query.ok ? `<div class="alert ok">${esc(req.query.ok)}</div>` : "";
    const err = req.query.err ? `<div class="alert err">${esc(req.query.err)}</div>` : "";

    const rows = report.rows.map(r => `<tr class="${r.lowStock ? "low" : ""}">
      <td><b>${esc(r.name)}</b>${r.lowStock ? ` <span class="badge b-red">Low</span>` : ""}<div class="small muted">${esc(r.unit || "each")}${r.sku ? " · " + esc(r.sku) : ""}</div></td>
      <td class="r"><b>${num(r.closing)}</b></td>
      <td class="r">${num(r.soldIn)}</td>
      <td class="r">${money(r.sellPrice, cur)}</td>
      <td class="r">${money(r.stockValueCost, cur)}</td>
      <td class="r">${r.marginPct == null ? "—" : r.marginPct + "%"}</td>
    </tr>`).join("");

    const opts = items.map(i => `<option value="${esc(i._id)}">${esc(i.name)} (${num(i.currentQty)} on hand)</option>`).join("");
    const canAdjust = office.isOwner || office.isManager;

    const body = `
      ${ok}${err}
      ${office.isOwner ? branchFilter(await branchesFor(office.biz._id), branchId, "/office/stock") : ""}
      <div class="grid kpis" style="margin-bottom:18px">
        <div class="card kpi"><div class="kl">Stock value (cost)</div><div class="kv">${money(report.totals.stockValueCost, cur)}</div><div class="ks">${num(report.rows.length)} items</div></div>
        <div class="card kpi"><div class="kl">Potential sales value</div><div class="kv">${money(report.totals.potentialSales, cur)}</div><div class="ks">at current sell prices</div></div>
        <div class="card kpi"><div class="kl">Low-stock items</div><div class="kv ${report.totals.lowStockCount ? "red" : "green"}">${num(report.totals.lowStockCount)}</div><div class="ks">${report.totals.lowStockCount ? "need restocking" : "all healthy"}</div></div>
        <div class="card kpi"><div class="kl">Sold this month</div><div class="kv">${num(report.totals.soldQty)}</div><div class="ks">gross profit ${money(report.totals.grossProfit, cur)}</div></div>
      </div>

      <div class="card" style="margin-bottom:18px">
        <div class="ch"><h3>Stock levels</h3><a class="btn btn-ghost btn-sm" href="/office/reports?tab=stock${branchId ? "&branch=" + branchId : ""}">Report & PDF</a></div>
        ${report.rows.length ? `<div class="tbl-wrap"><table>
          <thead><tr><th>Product</th><th class="r">On hand</th><th class="r">Sold (mo)</th><th class="r">Sell price</th><th class="r">Value</th><th class="r">Margin</th></tr></thead>
          <tbody>${rows}</tbody></table></div>`
        : `<div class="empty"><div class="e-ic">📦</div>No tracked products yet. Track them from WhatsApp: <b>Stock Control → Track a Product</b>.</div>`}
      </div>

      ${items.length ? `
      <div class="row" style="align-items:flex-start">
        <div class="card" style="flex:1;min-width:280px">
          <div class="ch"><h3>📥 Record stock in</h3></div>
          <div class="cb">
            <form method="POST" action="/office/stock/in">
              <input type="hidden" name="branch" value="${esc(branchId || "")}">
              <div class="field"><label>Product</label><select class="input" name="stockItemId" required>${opts}</select></div>
              <div class="row">
                <div class="field"><label>Quantity received</label><input class="input" name="qty" type="number" step="0.01" min="0.01" placeholder="e.g. 20" required></div>
                <div class="field"><label>Unit cost (${esc(cur)})</label><input class="input" name="unitCost" type="number" step="0.01" min="0" value="0"></div>
              </div>
              <div class="field"><label>Note (optional)</label><input class="input" name="reason" placeholder="e.g. delivery from supplier"></div>
              <button class="btn btn-primary" style="width:100%">Add to stock</button>
            </form>
          </div>
        </div>
        ${canAdjust ? `
        <div class="card" style="flex:1;min-width:280px">
          <div class="ch"><h3>🔧 Adjust / wastage</h3></div>
          <div class="cb">
            <form method="POST" action="/office/stock/adjust">
              <input type="hidden" name="branch" value="${esc(branchId || "")}">
              <div class="field"><label>Product</label><select class="input" name="stockItemId" required>${opts}</select></div>
              <div class="field"><label>Type</label><select class="input" name="kind">
                <option value="wastage">Wastage / loss / breakage (removes stock)</option>
                <option value="adjustment_down">Correction — reduce count</option>
                <option value="adjustment_up">Correction — increase count</option>
              </select></div>
              <div class="field"><label>Quantity</label><input class="input" name="qty" type="number" step="0.01" min="0.01" placeholder="e.g. 3" required></div>
              <div class="field"><label>Reason</label><input class="input" name="reason" placeholder="e.g. expired / miscount" required></div>
              <button class="btn btn-danger" style="width:100%">Record adjustment</button>
            </form>
          </div>
        </div>` : ""}
      </div>` : ""}`;
    res.send(shell(office, "stock", "Stock", body));
  } catch (e) {
    console.error("[office stock]", e);
    res.send(shell(office, "stock", "Stock", `<div class="alert err">Couldn't load stock: ${esc(e.message)}</div>`));
  }
});

router.post("/stock/in", async (req, res) => {
  const { office } = req;
  const branchId = effectiveBranch(office, req) || null;
  const back = "/office/stock" + (branchId ? "?branch=" + branchId : "");
  try {
    const qty = parseFloat(req.body.qty);
    if (!req.body.stockItemId || !(qty > 0)) return res.redirect(back + (branchId ? "&" : "?") + "err=" + encodeURIComponent("Pick a product and a quantity"));
    const { recordMovement } = await svcStock();
    await recordMovement({
      businessId: office.biz._id, stockItemId: req.body.stockItemId, branchId,
      type: "purchase", qty, unitCost: parseFloat(req.body.unitCost) || 0,
      reason: String(req.body.reason || "").trim(), createdBy: office.role.phone || "web", currency: office.cur,
    });
    res.redirect(back + (branchId ? "&" : "?") + "ok=" + encodeURIComponent("Stock added"));
  } catch (e) {
    console.error("[office stock in]", e);
    res.redirect(back + (branchId ? "&" : "?") + "err=" + encodeURIComponent(e.message));
  }
});

router.post("/stock/adjust", async (req, res) => {
  const { office } = req;
  if (!(office.isOwner || office.isManager)) return res.redirect("/office/stock?err=" + encodeURIComponent("Not allowed"));
  const branchId = effectiveBranch(office, req) || null;
  const back = "/office/stock" + (branchId ? "?branch=" + branchId : "");
  const sep = branchId ? "&" : "?";
  try {
    let qty = parseFloat(req.body.qty);
    if (!req.body.stockItemId || !(qty > 0)) return res.redirect(back + sep + "err=" + encodeURIComponent("Pick a product and a quantity"));
    const kind = req.body.kind;
    let type = "adjustment", signedQty = qty;
    if (kind === "wastage") { type = "wastage"; signedQty = -Math.abs(qty); }
    else if (kind === "adjustment_down") { type = "adjustment"; signedQty = -Math.abs(qty); }
    else { type = "adjustment"; signedQty = Math.abs(qty); }
    const { recordMovement } = await svcStock();
    await recordMovement({
      businessId: office.biz._id, stockItemId: req.body.stockItemId, branchId,
      type, qty: signedQty, reason: String(req.body.reason || "").trim(),
      createdBy: office.role.phone || "web", currency: office.cur,
    });
    res.redirect(back + sep + "ok=" + encodeURIComponent("Adjustment recorded"));
  } catch (e) {
    console.error("[office stock adjust]", e);
    res.redirect(back + sep + "err=" + encodeURIComponent(e.message));
  }
});

// ═════════════════════════════════════════════════════════════════════════════
//  PRODUCTS & PRICES  (catalogue used by sales pickers + the WhatsApp bot)
// ═════════════════════════════════════════════════════════════════════════════
router.get("/products", async (req, res) => {
  const { office } = req; const cur = office.cur;
  const canEdit = office.isOwner || office.isManager;
  try {
    const { listProducts } = await import("../services/officeData.js");
    const products = await listProducts({ businessId: office.biz._id, includeInactive: true });
    const ok = req.query.ok ? `<div class="alert ok">${esc(req.query.ok)}</div>` : "";
    const err = req.query.err ? `<div class="alert err">${esc(req.query.err)}</div>` : "";

    const rows = products.map(p => `<tr style="${p.isActive === false ? "opacity:.55" : ""}">
      <td><b>${esc(p.name)}</b> ${p.isService ? `<span class="badge b-indigo">Service</span>` : ""}${p.isActive === false ? ` <span class="badge b-red">Hidden</span>` : ""}</td>
      <td class="r">${canEdit ? `
        <form method="POST" action="/office/products/update" style="display:flex;gap:6px;justify-content:flex-end;align-items:center">
          <input type="hidden" name="id" value="${p._id}">
          <input class="input" name="unitPrice" type="number" step="0.01" min="0" value="${p.unitPrice || 0}" style="width:120px">
          <button class="btn btn-ghost btn-sm">Save</button>
        </form>` : money(p.unitPrice, cur)}</td>
      <td class="c">${canEdit ? `
        <form method="POST" action="/office/products/update"><input type="hidden" name="id" value="${p._id}"><input type="hidden" name="isActive" value="${p.isActive === false ? "1" : "0"}"><button class="btn ${p.isActive === false ? "btn-ghost" : "btn-danger"} btn-sm">${p.isActive === false ? "Show" : "Hide"}</button></form>` : ""}</td>
    </tr>`).join("");

    const addForm = canEdit ? `
      <div class="card" style="margin-bottom:18px"><div class="ch"><h3>➕ Add product / service</h3></div>
        <div class="cb"><form method="POST" action="/office/products/add"><div class="row">
          <div class="field"><label>Name</label><input class="input" name="name" placeholder="e.g. Starlink Mini Kit" required></div>
          <div class="field"><label>Price (${esc(cur)})</label><input class="input" type="number" step="0.01" min="0" name="unitPrice" value="0"></div>
          <div class="field"><label>Type</label><select class="input" name="isService"><option value="">Product</option><option value="1">Service</option></select></div>
        </div><button class="btn btn-primary">Add to catalogue</button></form></div>
      </div>` : "";

    const body = `${ok}${err}${addForm}
      <div class="card"><div class="ch"><h3>Catalogue</h3><span class="pill">${num(products.length)} items</span></div>
        ${products.length ? `<div class="tbl-wrap"><table><thead><tr><th>Product / Service</th><th class="r">Price</th><th class="c">Visible</th></tr></thead><tbody>${rows}</tbody></table></div>`
        : `<div class="empty"><div class="e-ic">🏷</div>No products yet. Add one above — they become pickable (with price) when recording a sale.</div>`}
      </div>`;
    res.send(shell(office, "products", "Products", body));
  } catch (e) { console.error("[office products]", e); res.send(shell(office, "products", "Products", `<div class="alert err">${esc(e.message)}</div>`)); }
});

router.post("/products/add", async (req, res) => {
  const { office } = req;
  if (!(office.isOwner || office.isManager)) return res.redirect("/office/products?err=Not+allowed");
  try {
    const { createProduct } = await import("../services/officeData.js");
    await createProduct({ businessId: office.biz._id, branchId: office.scopeBranchId || null, name: req.body.name, unitPrice: req.body.unitPrice, isService: !!req.body.isService });
    res.redirect("/office/products?ok=" + encodeURIComponent("Product saved"));
  } catch (e) { res.redirect("/office/products?err=" + encodeURIComponent(e.message)); }
});

router.post("/products/update", async (req, res) => {
  const { office } = req;
  if (!(office.isOwner || office.isManager)) return res.redirect("/office/products?err=Not+allowed");
  try {
    const { updateProduct } = await import("../services/officeData.js");
    const patch = { businessId: office.biz._id, id: req.body.id };
    if (req.body.unitPrice != null && req.body.unitPrice !== "") patch.unitPrice = req.body.unitPrice;
    if (req.body.isActive != null) patch.isActive = req.body.isActive === "1";
    if (req.body.name) patch.name = req.body.name;
    await updateProduct(patch);
    res.redirect("/office/products?ok=" + encodeURIComponent("Updated"));
  } catch (e) { res.redirect("/office/products?err=" + encodeURIComponent(e.message)); }
});

// ═════════════════════════════════════════════════════════════════════════════
//  REPORTS  — summary · detailed ledger · clerk statement · stock (+ PDF)
//  Reuses the SAME builders the WhatsApp reports use, so figures match exactly.
// ═════════════════════════════════════════════════════════════════════════════
async function staffForBusiness(bizId, branchId) {
  const UserRole = await M.UserRole();
  const rows = await UserRole.find({ businessId: bizId, suspended: { $ne: true } })
    .select("name phone role branchId").sort({ role: 1, name: 1 }).lean();
  return rows.filter(r => r.phone && (!branchId || r.role === "owner" || r.role === "admin" || String(r.branchId) === String(branchId)));
}

router.get("/reports", async (req, res) => {
  const { office } = req; const cur = office.cur;
  const forcedClerk = office.isClerk ? (office.role.phone || null) : null;
  const branchId = office.isClerk ? office.scopeBranchId : effectiveBranch(office, req);
  const type = ["summary", "ledger", "clerk", "stock"].includes(req.query.type) ? req.query.type : (office.isClerk ? "clerk" : "summary");
  const period = req.query.period || "month";
  const { start, end, label } = periodRange(period, req.query);
  const err = req.query.err ? `<div class="alert err">${esc(req.query.err)}</div>` : "";
  try {
    const branches = office.isOwner ? await branchesFor(office.biz._id) : [];
    const staff = (type === "clerk" && !office.isClerk) ? await staffForBusiness(office.biz._id, branchId) : [];
    const selectedClerk = forcedClerk || req.query.clerk || (staff[0]?.phone || "");

    const pdfQuery = (t) => {
      const p = new URLSearchParams();
      p.set("type", t); p.set("period", period);
      if (branchId) p.set("branch", branchId);
      if (req.query.from) { p.set("from", req.query.from); p.set("to", req.query.to || ""); }
      if (selectedClerk) p.set("clerk", selectedClerk);
      return p.toString();
    };
    const pdfBtn = (t) => `<a class="btn btn-primary btn-sm" href="/office/reports/pdf?${pdfQuery(t)}">⬇ Download PDF</a>`;

    const controls = `
      <form method="GET" action="/office/reports" class="card" style="padding:14px;margin-bottom:18px">
        <div class="row">
          <div class="field" style="margin:0"><label>Report</label>
            <select class="input" name="type">
              ${!office.isClerk ? `<option value="summary" ${type === "summary" ? "selected" : ""}>Sales & cash summary</option>
              <option value="ledger" ${type === "ledger" ? "selected" : ""}>Detailed ledger</option>` : ""}
              <option value="clerk" ${type === "clerk" ? "selected" : ""}>${office.isClerk ? "My statement" : "Clerk statement"}</option>
              ${!office.isClerk ? `<option value="stock" ${type === "stock" ? "selected" : ""}>Stock & sales</option>` : ""}
            </select></div>
          <div class="field" style="margin:0"><label>Period</label>
            <select class="input" name="period">
              ${["today", "week", "month", "year", "alltime", "custom"].map(p => `<option value="${p}" ${period === p ? "selected" : ""}>${({ today: "Today", week: "Last 7 days", month: "This month", year: "This year", alltime: "All time", custom: "Custom range" })[p]}</option>`).join("")}
            </select></div>
          ${office.isOwner && branches.length ? `<div class="field" style="margin:0"><label>Branch</label>
            <select class="input" name="branch"><option value="all">All branches</option>${branches.map(b => `<option value="${b._id}" ${String(branchId) === String(b._id) ? "selected" : ""}>${esc(b.name)}</option>`).join("")}</select></div>` : ""}
          ${type === "clerk" && !office.isClerk ? `<div class="field" style="margin:0"><label>Clerk</label>
            <select class="input" name="clerk">${staff.map(x => `<option value="${esc(x.phone)}" ${selectedClerk === x.phone ? "selected" : ""}>${esc(x.name || x.phone)} (${esc(x.role)})</option>`).join("")}</select></div>` : ""}
        </div>
        <div class="row" style="margin-top:12px">
          <div class="field" style="margin:0"><label>From (custom)</label><input class="input" type="date" name="from" value="${esc(req.query.from || "")}"></div>
          <div class="field" style="margin:0"><label>To (custom)</label><input class="input" type="date" name="to" value="${esc(req.query.to || "")}"></div>
          <div class="field" style="margin:0;display:flex;align-items:flex-end"><button class="btn btn-primary" style="width:100%">Run report</button></div>
        </div>
      </form>`;

    let content = "";
    if (type === "summary") {
      const { fetchReportData, calcTotals } = await svcReports();
      const data = await fetchReportData({ biz: office.biz, start, end, branchId });
      const t = calcTotals(data);
      content = `
        <div class="grid kpis" style="margin-bottom:18px">
          <div class="card kpi accent"><div class="kl">Money in</div><div class="kv">${money(t.moneyIn, cur)}</div><div class="ks">Cash ${money(t.cashSales, cur)} · Paid ${money(t.invoicePayments, cur)}</div></div>
          <div class="card kpi"><div class="kl">Money out</div><div class="kv red">${money(t.moneyOut, cur)}</div><div class="ks">${num(data.expenses.length)} expenses</div></div>
          <div class="card kpi"><div class="kl">Profit</div><div class="kv ${t.profit >= 0 ? "green" : "red"}">${money(t.profit, cur)}</div><div class="ks">${esc(label)}</div></div>
          <div class="card kpi"><div class="kl">Outstanding</div><div class="kv ${t.outstanding > 0 ? "amber" : ""}">${money(t.outstanding, cur)}</div><div class="ks">Invoiced ${money(t.totalInvoiced, cur)}</div></div>
        </div>
        <div class="card"><div class="ch"><h3>Sales & cash — ${esc(label)}</h3>${pdfBtn("summary")}</div>
          <div class="cb"><table>
            <tr><td>Cash sales (receipts)</td><td class="r green">${money(t.cashSales, cur)}</td></tr>
            <tr><td>Invoice payments received</td><td class="r green">${money(t.invoicePayments, cur)}</td></tr>
            <tr><td>Total money in</td><td class="r"><b>${money(t.moneyIn, cur)}</b></td></tr>
            <tr><td>Expenses paid out</td><td class="r red">${money(t.moneyOut, cur)}</td></tr>
            <tr><td><b>Net profit</b></td><td class="r"><b class="${t.profit >= 0 ? "green" : "red"}">${money(t.profit, cur)}</b></td></tr>
          </table></div>
        </div>`;
    } else if (type === "ledger") {
      const { fetchReportData, fetchOpeningBalance, _buildRunningLedger } = await svcReports();
      const opening = period === "alltime" ? 0 : await fetchOpeningBalance(office.biz, branchId, start);
      const data = await fetchReportData({ biz: office.biz, start, end, branchId });
      const ledger = await _buildRunningLedger({ biz: office.biz, data, branchId, start, end, openingBalance: opening });
      const rows = (ledger.rows || []).slice(0, 250).map(r => {
        const cin = r.credit || r.in || 0, cout = r.debit || r.out || 0;
        return `<tr><td class="small">${r.date ? new Date(r.date).toLocaleDateString("en-GB", { day: "numeric", month: "short" }) : ""}</td><td>${esc(r.description || r.label || r.type || "")}</td><td class="r ${cin ? "green" : ""}">${cin ? money(cin, cur) : ""}</td><td class="r ${cout ? "red" : ""}">${cout ? money(cout, cur) : ""}</td><td class="r"><b>${money(r.balance || 0, cur)}</b></td></tr>`;
      }).join("");
      content = `
        <div class="grid kpis" style="margin-bottom:18px">
          <div class="card kpi"><div class="kl">Opening balance</div><div class="kv">${money(opening, cur)}</div></div>
          <div class="card kpi"><div class="kl">Money in</div><div class="kv green">${money(ledger.totalCredits, cur)}</div></div>
          <div class="card kpi"><div class="kl">Money out</div><div class="kv red">${money(ledger.totalDebits, cur)}</div></div>
          <div class="card kpi accent"><div class="kl">Closing balance</div><div class="kv">${money(ledger.closingBalance, cur)}</div></div>
        </div>
        <div class="card"><div class="ch"><h3>Detailed ledger — ${esc(label)}</h3>${pdfBtn("ledger")}</div>
          <div class="tbl-wrap"><table><thead><tr><th>Date</th><th>Detail</th><th class="r">In</th><th class="r">Out</th><th class="r">Balance</th></tr></thead><tbody>${rows}</tbody></table></div>
        </div>
        <p class="hint" style="margin-top:10px">Up to 250 rows shown — the PDF has the full running-balance statement.</p>`;
    } else if (type === "clerk") {
      if (!selectedClerk) {
        content = `<div class="card"><div class="cb empty"><div class="e-ic">👤</div>No staff to report on yet.</div></div>`;
      } else {
        const { fetchClerkCumulativeBalance } = await svcReports();
        const { buildClerkStatement } = await import("../services/reportHelpers.js");
        const opening = period === "alltime" ? 0 : await fetchClerkCumulativeBalance({ biz: office.biz, clerkPhone: selectedClerk, branchId, before: start });
        const stmt = await buildClerkStatement({ biz: office.biz, clerkPhone: selectedClerk, branchId, start, end, openingCustody: opening });
        const rec = stmt.handedOver !== null && stmt.handedOver !== undefined
          ? (Math.abs(stmt.discrepancy) < 0.01 ? "✅ Balanced" : (stmt.discrepancy > 0 ? `⚠ Surplus +${money(stmt.discrepancy, cur)}` : `❌ Short ${money(Math.abs(stmt.discrepancy), cur)}`))
          : "⏳ Shift open";
        const rows = (stmt.txRows || []).slice(0, 250).map(r => {
          const cin = r.in || r.credit || 0, cout = r.out || r.debit || 0;
          return `<tr><td class="small">${r.date ? new Date(r.date).toLocaleDateString("en-GB", { day: "numeric", month: "short" }) : ""}</td><td>${esc(r.label || r.description || r.type || "")}</td><td class="r ${cin ? "green" : ""}">${cin ? money(cin, cur) : ""}</td><td class="r ${cout ? "red" : ""}">${cout ? money(cout, cur) : ""}</td></tr>`;
        }).join("");
        content = `
          <div class="grid kpis" style="margin-bottom:18px">
            <div class="card kpi"><div class="kl">${office.isClerk ? "Me" : "Clerk"}</div><div class="kv" style="font-size:17px">${esc(stmt.clerkName || selectedClerk)}</div><div class="ks">${esc(stmt.clerkRole || "")}</div></div>
            <div class="card kpi"><div class="kl">Opening</div><div class="kv">${money(stmt.openingCustody, cur)}</div></div>
            <div class="card kpi"><div class="kl">In / Out</div><div class="kv green" style="font-size:17px">${money(stmt.totalIn, cur)}</div><div class="ks red">− ${money(stmt.totalOut, cur)}</div></div>
            <div class="card kpi accent"><div class="kl">Cash at hand</div><div class="kv">${money(stmt.expectedClosing, cur)}</div><div class="ks">${esc(rec)}</div></div>
          </div>
          <div class="card"><div class="ch"><h3>${office.isClerk ? "My" : "Clerk"} statement — ${esc(label)}</h3>${pdfBtn("clerk")}</div>
            <div class="tbl-wrap"><table><thead><tr><th>Date</th><th>Detail</th><th class="r">In</th><th class="r">Out</th></tr></thead><tbody>${rows}</tbody></table></div>
          </div>`;
      }
    } else { // stock
      const { isStockEnabled, buildStockReport } = await svcStock();
      if (!(await isStockEnabled(office.biz._id))) content = `<div class="card"><div class="cb empty"><div class="e-ic">📦</div>Stock tracking is off.</div></div>`;
      else {
        const report = await buildStockReport({ biz: office.biz, branchId, start, end });
        const rows = report.rows.map(r => `<tr class="${r.lowStock ? "low" : ""}"><td>${esc(r.name)}</td><td class="r">${num(r.openingAtStart)}</td><td class="r">${num(r.purchasedIn)}</td><td class="r">${num(r.soldIn)}</td><td class="r"><b>${num(r.closing)}</b></td><td class="r">${money(r.salesValue, cur)}</td><td class="r">${money(r.grossProfit, cur)}</td></tr>`).join("");
        content = `
          <div class="grid kpis" style="margin-bottom:18px">
            <div class="card kpi"><div class="kl">Units sold</div><div class="kv">${num(report.totals.soldQty)}</div></div>
            <div class="card kpi"><div class="kl">Gross profit</div><div class="kv green">${money(report.totals.grossProfit, cur)}</div></div>
            <div class="card kpi"><div class="kl">Stock value</div><div class="kv">${money(report.totals.stockValueCost, cur)}</div></div>
            <div class="card kpi"><div class="kl">Low-stock</div><div class="kv ${report.totals.lowStockCount ? "red" : "green"}">${num(report.totals.lowStockCount)}</div></div>
          </div>
          <div class="card"><div class="ch"><h3>Stock & sales — ${esc(label)}</h3><a class="btn btn-primary btn-sm" href="/office/reports/stock.pdf?period=${period}${branchId ? "&branch=" + branchId : ""}${req.query.from ? "&from=" + req.query.from + "&to=" + req.query.to : ""}">⬇ Download PDF</a></div>
            ${report.rows.length ? `<div class="tbl-wrap"><table><thead><tr><th>Product</th><th class="r">Open</th><th class="r">In</th><th class="r">Sold</th><th class="r">Close</th><th class="r">Sales</th><th class="r">Profit</th></tr></thead><tbody>${rows}</tbody></table></div>` : `<div class="empty">No stock activity.</div>`}
          </div>`;
      }
    }
    res.send(shell(office, "reports", "Reports", err + controls + content));
  } catch (e) {
    console.error("[office reports]", e);
    res.send(shell(office, "reports", "Reports", `<div class="alert err">Couldn't build the report: ${esc(e.message)}</div>`));
  }
});

// PDF: summary / detailed ledger / clerk statement
router.get("/reports/pdf", async (req, res) => {
  const { office } = req;
  const forcedClerk = office.isClerk ? (office.role.phone || null) : null;
  const branchId = office.isClerk ? office.scopeBranchId : effectiveBranch(office, req);
  const type = req.query.type;
  const period = req.query.period || "month";
  const { start, end, label } = periodRange(period, req.query);
  try {
    const { generateReportPDF } = await import("../services/reportPDF.js");
    let branchName = office.branch?.name || (branchId ? "" : "All branches");
    if (branchId && office.isOwner) { try { const Branch = await M.Branch(); const b = await Branch.findById(branchId).lean(); branchName = b?.name || branchName; } catch {} }

    let out;
    if (type === "summary") {
      const { fetchReportData, calcTotals } = await svcReports();
      const data = await fetchReportData({ biz: office.biz, start, end, branchId });
      out = await generateReportPDF({ biz: office.biz, reportType: "Monthly Report", periodLabel: label, branchName, data, totals: calcTotals(data) });
    } else if (type === "ledger") {
      const { fetchReportData, fetchOpeningBalance, _buildRunningLedger } = await svcReports();
      const opening = period === "alltime" ? 0 : await fetchOpeningBalance(office.biz, branchId, start);
      const data = await fetchReportData({ biz: office.biz, start, end, branchId });
      const ledger = await _buildRunningLedger({ biz: office.biz, data, branchId, start, end, openingBalance: opening });
      out = await generateReportPDF({ biz: office.biz, reportType: "Ledger Statement", periodLabel: label, branchName, ledgerRows: ledger.rows, openingBalance: opening, closingBalance: ledger.closingBalance });
    } else if (type === "clerk") {
      const clerkPhone = forcedClerk || req.query.clerk;
      if (!clerkPhone) throw new Error("No clerk selected");
      const { fetchClerkCumulativeBalance } = await svcReports();
      const { buildClerkStatement } = await import("../services/reportHelpers.js");
      const opening = period === "alltime" ? 0 : await fetchClerkCumulativeBalance({ biz: office.biz, clerkPhone, branchId, before: start });
      const stmt = await buildClerkStatement({ biz: office.biz, clerkPhone, branchId, start, end, openingCustody: opening });
      out = await generateReportPDF({ biz: office.biz, reportType: office.isClerk ? "My Statement" : "Clerk Statement", periodLabel: `${stmt.clerkName || clerkPhone} · ${label}`, branchName, clerkData: { ...stmt, openingCustody: opening } });
    } else {
      return res.redirect("/office/reports");
    }
    const abs = typeof out === "string" ? out : (out?.filepath || out?.path);
    if (!abs) throw new Error("PDF generation returned no file");
    return res.download(abs);
  } catch (e) {
    console.error("[office report pdf]", e);
    res.redirect("/office/reports?err=" + encodeURIComponent("Couldn't generate PDF: " + e.message));
  }
});

router.get("/reports/stock.pdf", async (req, res) => {
  const { office } = req;
  const branchId = effectiveBranch(office, req);
  const { start, end, label } = periodRange(req.query.period || "month", req.query);
  try {
    const { isStockEnabled, buildStockReport, generateStockReportPDF } = await svcStock();
    if (!(await isStockEnabled(office.biz._id))) return res.redirect("/office/reports?type=stock");
    const report = await buildStockReport({ biz: office.biz, branchId, start, end });
    const out = await generateStockReportPDF({
      biz: office.biz, report, periodLabel: label,
      branchName: office.branch?.name || (branchId ? "" : "All branches"),
    });
    const abs = typeof out === "string" ? out : (out?.filepath || out?.path || out?.file);
    if (!abs) throw new Error("PDF generation returned no file");
    return res.download(abs, "stock-report.pdf");
  } catch (e) {
    console.error("[office stock pdf]", e);
    res.redirect("/office/reports?type=stock&err=" + encodeURIComponent("Couldn't generate PDF: " + e.message));
  }
});

// ═════════════════════════════════════════════════════════════════════════════
//  TEAM  (owner/admin: create staff, generate usernames, reset password, etc.)
// ═════════════════════════════════════════════════════════════════════════════
function requireOwner(req, res, next) {
  if (!req.office.isOwner) return res.status(403).send(shell(req.office, "dashboard", "Not allowed",
    `<div class="alert err">Only the owner or an administrator can manage the team.</div>`));
  next();
}

router.get("/team", requireOwner, async (req, res) => {
  const { office } = req;
  try {
    const UserRole = await M.UserRole();
    const branches = await branchesFor(office.biz._id);
    const branchName = {}; branches.forEach(b => branchName[String(b._id)] = b.name);
    const staff = await UserRole.find({ businessId: office.biz._id }).sort({ role: 1, name: 1 }).lean();
    const ok = req.query.ok ? `<div class="alert ok">${esc(req.query.ok)}</div>` : "";
    const err = req.query.err ? `<div class="alert err">${esc(req.query.err)}</div>` : "";

    const roleBadge = r => ({ owner: "b-indigo", admin: "b-indigo", manager: "b-amber", clerk: "b-slate" }[r] || "b-slate");
    const rows = staff.map(s => {
      const isSelf = String(s._id) === String(office.role._id);
      return `<tr>
        <td><b>${esc(s.name || "—")}</b>${isSelf ? ` <span class="badge b-green">You</span>` : ""}<div class="small muted">${esc(s.phone || "")}</div></td>
        <td><span class="badge ${roleBadge(s.role)}">${esc(s.role)}</span></td>
        <td>${esc(s.role === "owner" ? "All branches" : (branchName[String(s.branchId)] || "—"))}</td>
        <td>${s.username ? `<span class="cred">${esc(s.username)}</span>` : `<span class="muted small">no web login</span>`}</td>
        <td class="c">${s.suspended ? `<span class="badge b-red">Suspended</span>` : `<span class="badge b-green">Active</span>`}</td>
        <td class="r">${isSelf ? "" : `
          <form method="POST" action="/office/team/reset" style="display:inline"><input type="hidden" name="id" value="${s._id}"><button class="btn btn-ghost btn-sm">Reset password</button></form>
          <form method="POST" action="/office/team/${s.suspended ? "unsuspend" : "suspend"}" style="display:inline"><input type="hidden" name="id" value="${s._id}"><button class="btn ${s.suspended ? "btn-ghost" : "btn-danger"} btn-sm">${s.suspended ? "Reactivate" : "Suspend"}</button></form>`}
        </td>
      </tr>`;
    }).join("");

    const branchOptions = branches.map(b => `<option value="${b._id}">${esc(b.name)}</option>`).join("");

    const body = `
      ${ok}${err}
      <div class="card" style="margin-bottom:18px">
        <div class="ch"><h3>➕ Add a staff member</h3></div>
        <div class="cb">
          <p class="muted small" style="margin:0 0 14px">Create a login for a manager or clerk. They can use the web portal <b>and</b> WhatsApp (same phone number). You'll get a username + temporary password to share — they set their own password on first sign-in.</p>
          <form method="POST" action="/office/team/add">
            <div class="row">
              <div class="field"><label>Full name</label><input class="input" name="name" placeholder="e.g. Tino Moyo" required></div>
              <div class="field"><label>WhatsApp number</label><input class="input" name="phone" placeholder="e.g. 0771234567" required></div>
            </div>
            <div class="row">
              <div class="field"><label>Role</label><select class="input" name="role"><option value="clerk">Clerk (records sales/stock)</option><option value="manager">Manager (branch oversight)</option><option value="admin">Administrator (full access)</option></select></div>
              <div class="field"><label>Branch</label><select class="input" name="branchId"><option value="">— select branch —</option>${branchOptions}</select><div class="hint">Admins can be left without a branch (all branches).</div></div>
            </div>
            <button class="btn btn-primary">Create staff login</button>
          </form>
        </div>
      </div>

      <div class="card">
        <div class="ch"><h3>Team</h3><span class="pill">${num(staff.length)} members</span></div>
        <div class="tbl-wrap"><table>
          <thead><tr><th>Name</th><th>Role</th><th>Branch</th><th>Username</th><th class="c">Status</th><th class="r">Actions</th></tr></thead>
          <tbody>${rows}</tbody></table></div>
      </div>`;
    res.send(shell(office, "team", "Team", body));
  } catch (e) {
    console.error("[office team]", e);
    res.send(shell(office, "team", "Team", `<div class="alert err">Couldn't load the team: ${esc(e.message)}</div>`));
  }
});

function credCard(office, title, name, username, tempPw, note) {
  return shell(office, "team", title, `
    <div class="card" style="max-width:520px;margin:0 auto">
      <div class="ch"><h3>✅ ${esc(title)}</h3></div>
      <div class="cb">
        <p class="muted small">${esc(note)}</p>
        <div style="background:var(--soft);border:1px solid var(--line);border-radius:12px;padding:18px;margin:14px 0">
          <div style="margin-bottom:12px"><div class="small muted" style="font-weight:700;text-transform:uppercase;letter-spacing:.05em">Name</div><div style="font-size:16px;font-weight:700">${esc(name)}</div></div>
          <div style="margin-bottom:12px"><div class="small muted" style="font-weight:700;text-transform:uppercase;letter-spacing:.05em">Username</div><div class="cred" style="display:inline-block;margin-top:4px">${esc(username)}</div></div>
          <div><div class="small muted" style="font-weight:700;text-transform:uppercase;letter-spacing:.05em">Temporary password</div><div class="cred" style="display:inline-block;margin-top:4px">${esc(tempPw)}</div></div>
        </div>
        <p class="hint">⚠ Copy these now — the password is shown only once. They'll be asked to set their own password when they first sign in at <b>/office/login</b>.</p>
        <a class="btn btn-primary" href="/office/team" style="margin-top:8px">Back to team</a>
      </div>
    </div>`);
}

router.post("/team/add", requireOwner, async (req, res) => {
  const { office } = req;
  try {
    const UserRole = await M.UserRole();
    const name = String(req.body.name || "").trim();
    const phone = normalizePhone(req.body.phone);
    const role = ["clerk", "manager", "admin"].includes(req.body.role) ? req.body.role : "clerk";
    let branchId = req.body.branchId || null;
    if (!name || !phone) return res.redirect("/office/team?err=" + encodeURIComponent("Name and WhatsApp number are required"));
    if (role !== "admin" && !branchId) return res.redirect("/office/team?err=" + encodeURIComponent("Managers and clerks need a branch"));

    // Reuse an existing record for this phone in this business if present (link web login to it)
    let staff = await UserRole.findOne({ businessId: office.biz._id, phone });
    if (staff && staff.username) return res.redirect("/office/team?err=" + encodeURIComponent("That number already has a web login"));
    if (!staff) {
      staff = new UserRole({ businessId: office.biz._id, phone, role, branchId: branchId || undefined, name, pending: false });
    } else {
      staff.name = name; staff.role = role; if (branchId) staff.branchId = branchId; staff.pending = false;
    }
    staff.username = await UserRole.makeUsername(name, "staff");
    const tempPw = genTempPassword();
    await staff.setPassword(tempPw);
    staff.mustSetPassword = true;
    await staff.save();

    res.send(credCard(office, "Staff login created", name, staff.username, tempPw,
      `Share these with ${name}. They sign in at /office/login and will set their own password.`));
  } catch (e) {
    console.error("[office team add]", e);
    res.redirect("/office/team?err=" + encodeURIComponent(e.code === 11000 ? "Username clash — please try again" : e.message));
  }
});

router.post("/team/reset", requireOwner, async (req, res) => {
  const { office } = req;
  try {
    const UserRole = await M.UserRole();
    const staff = await UserRole.findOne({ _id: req.body.id, businessId: office.biz._id });
    if (!staff) return res.redirect("/office/team?err=" + encodeURIComponent("Staff not found"));
    if (String(staff._id) === String(office.role._id)) return res.redirect("/office/team?err=" + encodeURIComponent("Change your own password from Sign-in"));
    if (!staff.username) staff.username = await UserRole.makeUsername(staff.name, "staff");
    const tempPw = genTempPassword();
    await staff.setPassword(tempPw);
    staff.mustSetPassword = true;
    await staff.save();
    res.send(credCard(office, "Password reset", staff.name || staff.phone, staff.username, tempPw,
      `New temporary password for ${staff.name || staff.phone}. They'll set their own on next sign-in.`));
  } catch (e) {
    console.error("[office team reset]", e);
    res.redirect("/office/team?err=" + encodeURIComponent(e.message));
  }
});

async function setSuspended(req, res, value) {
  const { office } = req;
  try {
    const UserRole = await M.UserRole();
    const staff = await UserRole.findOne({ _id: req.body.id, businessId: office.biz._id });
    if (!staff) return res.redirect("/office/team?err=" + encodeURIComponent("Staff not found"));
    if (String(staff._id) === String(office.role._id)) return res.redirect("/office/team?err=" + encodeURIComponent("You can't suspend yourself"));
    staff.suspended = value; await staff.save();
    res.redirect("/office/team?ok=" + encodeURIComponent(value ? "Staff suspended" : "Staff reactivated"));
  } catch (e) { res.redirect("/office/team?err=" + encodeURIComponent(e.message)); }
}
router.post("/team/suspend", requireOwner, (req, res) => setSuspended(req, res, true));
router.post("/team/unsuspend", requireOwner, (req, res) => setSuspended(req, res, false));

export default router;