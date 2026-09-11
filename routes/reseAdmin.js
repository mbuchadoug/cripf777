// routes/reseAdmin.js
//
// Rese Rese admin panel — same idiom as your ZimQuote admin: a layout() shell
// with a dark off-canvas sidebar, light content, a session-flag password gate,
// per-router body parsing, and GridFS for the verification images.
//
// Mount in server.js:
//    import reseAdminRouter from "./routes/reseAdmin.js";
//    app.use("/rese-admin", reseAdminRouter);
//
// Then visit:  https://cripfcnt.com/rese-admin
// Password:    process.env.RESE_ADMIN_PASSWORD  (default below — change it)

import { Router } from "express";
import express from "express";
import mongoose from "mongoose";

import ReseUser from "../models/reseUser.js";
import JobRequest from "../models/jobRequest.js";
import ReseSetting from "../models/reseSetting.js";

const router = Router();

// This router parses its own bodies (your global parsers are off).
router.use(express.json());
router.use(express.urlencoded({ extended: true }));

const ADMIN_PASSWORD = process.env.RESE_ADMIN_PASSWORD || "rese_admin_2026";

/* ── helpers ──────────────────────────────────────────────── */

const esc = (s) =>
  String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );

const CATS = {
  water: { e: "💧", l: "Water & errands" },
  clean: { e: "🧹", l: "Cleaning" },
  carwash: { e: "🚗", l: "Car wash" },
  garden: { e: "🌿", l: "Garden & yard" },
  carry: { e: "📦", l: "Carry & move" },
  laundry: { e: "🧺", l: "Laundry" },
  paint: { e: "🎨", l: "Painting" },
  cook: { e: "🍲", l: "Cooking help" },
  build: { e: "🧱", l: "Building help" },
  any: { e: "➕", l: "Anything else" }
};
const cat = (id) => CATS[id] || { e: "•", l: id || "—" };

function fmtDate(d) {
  if (!d) return "—";
  return new Date(d).toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}
function timeAgo(d) {
  if (!d) return "—";
  const s = Math.floor((Date.now() - new Date(d).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function verifyBadge(v) {
  const map = {
    approved: ["✅ Verified", "green"],
    pending: ["⏳ Pending", "orange"],
    rejected: ["✕ Rejected", "red"],
    unverified: ["— Unverified", "muted"]
  };
  const [label, cls] = map[v?.status || "unverified"] || map.unverified;
  return `<span class="pill ${cls}">${label}</span>`;
}
function statusBadge(s) {
  const map = { active: ["Active", "green"], pending: ["Pending", "orange"], suspended: ["Suspended", "red"] };
  const [label, cls] = map[s] || ["—", "muted"];
  return `<span class="pill ${cls}">${label}</span>`;
}
function jobStatusBadge(s) {
  const map = { open: ["Open", "orange"], accepted: ["Taken", "blue"], done: ["Done", "green"], cancelled: ["Cancelled", "muted"], expired: ["Expired", "muted"] };
  const [label, cls] = map[s] || ["—", "muted"];
  return `<span class="pill ${cls}">${label}</span>`;
}

function bucket() {
  return new mongoose.mongo.GridFSBucket(mongoose.connection.db, { bucketName: "rese_uploads" });
}

/* ── auth ─────────────────────────────────────────────────── */

function requireReseAdmin(req, res, next) {
  if (req.session && req.session.isReseAdmin) return next();
  return res.redirect("/rese-admin/login");
}

router.get("/login", (req, res) => {
  if (req.session && req.session.isReseAdmin) return res.redirect("/rese-admin");
  res.send(`<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Rese Rese Admin</title>
<style>
  body{font-family:system-ui,sans-serif;background:#0f172a;color:#f1f5f9;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;padding:20px}
  .box{background:#1e293b;padding:32px;border-radius:16px;width:100%;max-width:360px;box-shadow:0 10px 40px rgba(0,0,0,.4)}
  h1{margin:0 0 4px;font-size:22px}h1 span{color:#f97316}
  p{color:#94a3b8;font-size:13px;margin:0 0 20px}
  input{width:100%;padding:14px;border-radius:10px;border:1px solid #334155;background:#0f172a;color:#fff;font-size:16px;margin-bottom:14px;box-sizing:border-box}
  button{width:100%;padding:14px;border:none;border-radius:10px;background:#f97316;color:#fff;font-size:16px;font-weight:700;cursor:pointer}
  .err{background:rgba(220,38,38,.15);color:#fca5a5;padding:10px;border-radius:8px;font-size:13px;margin-bottom:14px}
</style></head><body>
<form class="box" method="post" action="/rese-admin/login">
  <h1>Rese <span>Rese</span></h1>
  <p>Admin panel</p>
  ${req.query.e ? '<div class="err">Wrong password. Try again.</div>' : ""}
  <input type="password" name="password" placeholder="Admin password" autofocus>
  <button type="submit">Enter</button>
</form></body></html>`);
});

router.post("/login", (req, res) => {
  if (req.body && req.body.password === ADMIN_PASSWORD) {
    req.session.isReseAdmin = true;
    return res.redirect("/rese-admin");
  }
  res.redirect("/rese-admin/login?e=1");
});

router.post("/logout", requireReseAdmin, (req, res) => {
  req.session.isReseAdmin = false;
  res.redirect("/rese-admin/login");
});

/* ── layout shell (responsive) ────────────────────────────── */

function layout(title, content, active = "") {
  const nav = [
    { href: "/rese-admin", label: "📊 Dashboard", key: "dash" },
    { divider: "PEOPLE" },
    { href: "/rese-admin/users", label: "👥 All users", key: "users" },
    { href: "/rese-admin/users?role=worker", label: "💪 Workers", key: "workers" },
    { href: "/rese-admin/verifications", label: "🪪 Verifications", key: "verify" },
    { divider: "MARKETPLACE" },
    { href: "/rese-admin/jobs", label: "🧾 Jobs", key: "jobs" },
    { divider: "SYSTEM" },
    { href: "/rese-admin/settings", label: "⚙️ Settings", key: "settings" }
  ];
  const navHtml = nav
    .map((n) =>
      n.divider
        ? `<div class="nav-divider">${n.divider}</div>`
        : `<a href="${n.href}" class="nav-link ${n.key === active ? "on" : ""}">${n.label}</a>`
    )
    .join("");

  return `<!doctype html><html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · Rese Rese Admin</title>
<style>
:root{
  --bg:#f1f5f9;--sidebar:#0f172a;--sidebar-hover:#1e293b;--white:#fff;--border:#e2e8f0;
  --text:#1e293b;--muted:#64748b;--brand:#f97316;--green:#16a34a;--red:#dc2626;
  --orange:#ea580c;--blue:#2563eb;--sidebar-w:230px;
}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:system-ui,-apple-system,sans-serif;background:var(--bg);color:var(--text);font-size:14px}
a{color:inherit;text-decoration:none}
.sidebar{position:fixed;left:0;top:0;bottom:0;width:var(--sidebar-w);background:var(--sidebar);display:flex;flex-direction:column;z-index:200;transition:transform .25s ease;overflow-y:auto}
.sidebar-brand{padding:18px 20px;font-size:19px;font-weight:800;color:#fff;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid #1e293b}
.sidebar-brand span{color:var(--brand)}
.sidebar-close{display:none;background:none;border:none;color:#94a3b8;font-size:22px;cursor:pointer}
.nav-link{display:block;padding:11px 20px;color:#cbd5e1;font-size:14px;border-left:3px solid transparent}
.nav-link:hover{background:var(--sidebar-hover);color:#fff}
.nav-link.on{background:var(--sidebar-hover);color:#fff;border-left-color:var(--brand)}
.nav-divider{padding:14px 20px 4px;font-size:10px;font-weight:700;letter-spacing:1px;color:#475569}
.logout{margin:auto 16px 18px;padding:10px;text-align:center;border:1px solid #334155;border-radius:8px;color:#94a3b8;font-size:13px;background:none;cursor:pointer;width:calc(100% - 32px)}
.main{margin-left:var(--sidebar-w);min-height:100vh}
.topbar{display:flex;align-items:center;gap:12px;padding:16px 22px;background:var(--white);border-bottom:1px solid var(--border);position:sticky;top:0;z-index:100}
.hamburger{display:none;background:none;border:none;font-size:22px;cursor:pointer}
.topbar h2{font-size:18px;font-weight:700}
.content{padding:22px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:14px;margin-bottom:22px}
.stat{background:var(--white);border:1px solid var(--border);border-radius:14px;padding:18px}
.stat .n{font-size:30px;font-weight:800;line-height:1}
.stat .l{color:var(--muted);font-size:13px;margin-top:6px}
.stat.brand{border-left:4px solid var(--brand)}.stat.green{border-left:4px solid var(--green)}
.stat.orange{border-left:4px solid var(--orange)}.stat.blue{border-left:4px solid var(--blue)}
.card{background:var(--white);border:1px solid var(--border);border-radius:14px;padding:18px;margin-bottom:18px}
.card h3{font-size:15px;margin-bottom:12px}
.table-wrap{overflow-x:auto;-webkit-overflow-scrolling:touch;border:1px solid var(--border);border-radius:14px;background:var(--white)}
table{width:100%;border-collapse:collapse;min-width:640px}
th,td{text-align:left;padding:12px 14px;border-bottom:1px solid var(--border);font-size:13.5px;vertical-align:middle}
th{background:#f8fafc;color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.5px;position:sticky;top:0}
tr:last-child td{border-bottom:none}
.pill{display:inline-block;padding:3px 10px;border-radius:999px;font-size:11.5px;font-weight:700}
.pill.green{background:#dcfce7;color:#15803d}.pill.orange{background:#ffedd5;color:#c2410c}
.pill.red{background:#fee2e2;color:#b91c1c}.pill.blue{background:#dbeafe;color:#1d4ed8}
.pill.muted{background:#f1f5f9;color:#64748b}
.btn{display:inline-block;padding:9px 15px;border:none;border-radius:9px;background:var(--brand);color:#fff;font-weight:700;font-size:13px;cursor:pointer}
.btn.sm{padding:6px 11px;font-size:12px}
.btn.green{background:var(--green)}.btn.red{background:var(--red)}.btn.blue{background:var(--blue)}
.btn.ghost{background:#fff;color:var(--text);border:1px solid var(--border)}
.controls{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px}
input,select,textarea{padding:10px 12px;border:1px solid var(--border);border-radius:9px;font-size:14px;background:#fff;color:var(--text)}
.actions{display:flex;gap:6px;flex-wrap:wrap}
.avatar{width:40px;height:40px;border-radius:50%;object-fit:cover;background:#e2e8f0;vertical-align:middle}
.docimg{width:100%;max-width:280px;border-radius:12px;border:1px solid var(--border);background:#f8fafc;display:block}
.muted{color:var(--muted)}
.row2{display:grid;grid-template-columns:1fr 1fr;gap:18px}
.kv{display:flex;justify-content:space-between;padding:9px 0;border-bottom:1px solid var(--border);font-size:14px}
.kv b{font-weight:700}
.alert{padding:12px 14px;border-radius:10px;margin-bottom:16px;font-size:13.5px}
.alert.red{background:#fee2e2;color:#b91c1c}
.backdrop{display:none;position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:150}
.setting-row{display:flex;align-items:center;justify-content:space-between;gap:14px;padding:12px 0;border-bottom:1px solid var(--border);flex-wrap:wrap}
label.chk{display:inline-flex;align-items:center;gap:7px;padding:8px 12px;border:1px solid var(--border);border-radius:999px;font-size:13px;cursor:pointer;margin:3px}
@media(max-width:860px){
  .sidebar{transform:translateX(-100%)}
  .sidebar.open{transform:translateX(0)}
  .sidebar-close{display:block}
  .main{margin-left:0}
  .hamburger{display:block}
  .backdrop.open{display:block}
  .row2{grid-template-columns:1fr}
}
</style></head><body>
<aside class="sidebar" id="sb">
  <div class="sidebar-brand">Rese <span>Rese</span><button class="sidebar-close" onclick="sb.classList.remove('open');bd.classList.remove('open')">✕</button></div>
  <nav>${navHtml}</nav>
  <form method="post" action="/rese-admin/logout"><button class="logout" type="submit">Log out</button></form>
</aside>
<div class="backdrop" id="bd" onclick="sb.classList.remove('open');this.classList.remove('open')"></div>
<div class="main">
  <div class="topbar">
    <button class="hamburger" onclick="sb.classList.add('open');bd.classList.add('open')">☰</button>
    <h2>${esc(title)}</h2>
  </div>
  <div class="content">${content}</div>
</div>
<script>var sb=document.getElementById('sb'),bd=document.getElementById('bd');</script>
</body></html>`;
}

/* ── dashboard ────────────────────────────────────────────── */

router.get("/", requireReseAdmin, async (req, res) => {
  try {
    const dayAgo = new Date(Date.now() - 86400000);
    const [users, workers, pendingVerify, pendingApproval, openJobs, jobsToday, doneJobs, recent] =
      await Promise.all([
        ReseUser.countDocuments({}),
        ReseUser.countDocuments({ isWorker: true }),
        ReseUser.countDocuments({ "verification.status": "pending" }),
        ReseUser.countDocuments({ status: "pending" }),
        JobRequest.countDocuments({ status: "open", removedByAdmin: { $ne: true } }),
        JobRequest.countDocuments({ createdAt: { $gte: dayAgo } }),
        JobRequest.countDocuments({ status: "done" }),
        ReseUser.find({}).sort({ createdAt: -1 }).limit(8).lean()
      ]);

    const recentRows = recent
      .map(
        (u) => `<tr>
        <td>${u.avatarFileId ? `<img class="avatar" src="/rese-admin/media/${u.avatarFileId}">` : "🙂"} <b>${esc(u.name || "—")}</b></td>
        <td class="muted">${esc(u.phone)}</td>
        <td>${u.isWorker ? "💪 Worker" : "🙋 Requester"}</td>
        <td>${statusBadge(u.status)}</td>
        <td class="muted">${timeAgo(u.createdAt)}</td>
        <td><a class="btn sm ghost" href="/rese-admin/users/${u._id}">View</a></td>
      </tr>`
      )
      .join("");

    res.send(
      layout(
        "Dashboard",
        `
      <div class="grid">
        <div class="stat brand"><div class="n">${users}</div><div class="l">Total users</div></div>
        <div class="stat blue"><div class="n">${workers}</div><div class="l">Workers</div></div>
        <div class="stat orange"><div class="n">${pendingApproval}</div><div class="l">Awaiting approval</div></div>
        <div class="stat orange"><div class="n">${pendingVerify}</div><div class="l">Awaiting verification</div></div>
        <div class="stat green"><div class="n">${openJobs}</div><div class="l">Open jobs</div></div>
        <div class="stat"><div class="n">${jobsToday}</div><div class="l">Jobs today</div></div>
        <div class="stat green"><div class="n">${doneJobs}</div><div class="l">Jobs completed</div></div>
      </div>
      ${
        pendingVerify > 0 || pendingApproval > 0
          ? `<div class="card"><h3>Needs your attention</h3>
              ${pendingApproval > 0 ? `<p style="margin-bottom:8px">🟠 <b>${pendingApproval}</b> worker(s) waiting for account approval — <a style="color:var(--brand);font-weight:700" href="/rese-admin/users?status=pending">review</a></p>` : ""}
              ${pendingVerify > 0 ? `<p>🪪 <b>${pendingVerify}</b> ID verification(s) pending — <a style="color:var(--brand);font-weight:700" href="/rese-admin/verifications">review</a></p>` : ""}
            </div>`
          : ""
      }
      <div class="card"><h3>Newest users</h3>
        <div class="table-wrap"><table>
          <thead><tr><th>Name</th><th>Phone</th><th>Type</th><th>Status</th><th>Joined</th><th></th></tr></thead>
          <tbody>${recentRows || '<tr><td colspan="6" class="muted">No users yet. Use “Seed demo data” in Settings to try the panel.</td></tr>'}</tbody>
        </table></div>
      </div>`,
        "dash"
      )
    );
  } catch (err) {
    console.error("[rese-admin/dashboard]", err);
    res.send(layout("Dashboard", `<div class="alert red">Error: ${esc(err.message)}</div>`, "dash"));
  }
});

/* ── users list ───────────────────────────────────────────── */

router.get("/users", requireReseAdmin, async (req, res) => {
  try {
    const q = String(req.query.q || "").trim();
    const role = String(req.query.role || "").trim();
    const status = String(req.query.status || "").trim();

    const query = {};
    if (role === "worker") query.isWorker = true;
    if (role === "requester") query.isWorker = false;
    if (status) query.status = status;
    if (q) query.$or = [{ name: new RegExp(esc(q), "i") }, { phone: new RegExp(q.replace(/[^\d+]/g, ""), "i") }];

    const users = await ReseUser.find(query).sort({ createdAt: -1 }).limit(300).lean();

    const rows = users
      .map(
        (u) => `<tr>
        <td>${u.avatarFileId ? `<img class="avatar" src="/rese-admin/media/${u.avatarFileId}">` : "🙂"} <b>${esc(u.name || "—")}</b></td>
        <td class="muted">${esc(u.phone)}</td>
        <td>${u.isWorker ? "💪 Worker" : "🙋 Requester"}</td>
        <td>${statusBadge(u.status)}</td>
        <td>${u.isWorker ? verifyBadge(u.verification) : '<span class="muted">—</span>'}</td>
        <td class="muted">${timeAgo(u.createdAt)}</td>
        <td><a class="btn sm ghost" href="/rese-admin/users/${u._id}">Open</a></td>
      </tr>`
      )
      .join("");

    res.send(
      layout(
        "All users",
        `
      <form method="get" class="controls">
        <input name="q" value="${esc(q)}" placeholder="Search name or phone" style="flex:1;min-width:180px">
        <select name="role"><option value="">All types</option><option value="worker" ${role === "worker" ? "selected" : ""}>Workers</option><option value="requester" ${role === "requester" ? "selected" : ""}>Requesters</option></select>
        <select name="status"><option value="">Any status</option><option value="active" ${status === "active" ? "selected" : ""}>Active</option><option value="pending" ${status === "pending" ? "selected" : ""}>Pending</option><option value="suspended" ${status === "suspended" ? "selected" : ""}>Suspended</option></select>
        <button class="btn" type="submit">Search</button>
      </form>
      <div class="table-wrap"><table>
        <thead><tr><th>Name</th><th>Phone</th><th>Type</th><th>Status</th><th>ID</th><th>Joined</th><th></th></tr></thead>
        <tbody>${rows || '<tr><td colspan="7" class="muted">No users match.</td></tr>'}</tbody>
      </table></div>`,
        role === "worker" ? "workers" : "users"
      )
    );
  } catch (err) {
    console.error("[rese-admin/users]", err);
    res.send(layout("All users", `<div class="alert red">Error: ${esc(err.message)}</div>`, "users"));
  }
});

/* ── user detail ──────────────────────────────────────────── */

router.get("/users/:id", requireReseAdmin, async (req, res) => {
  try {
    const u = await ReseUser.findById(req.params.id).lean({ virtuals: true });
    if (!u) return res.send(layout("User", `<div class="alert red">User not found.</div>`, "users"));

    const w = u.worker || {};
    const skills = (w.skills || []).map((id) => `<label class="chk">${cat(id).e} ${esc(cat(id).l)}</label>`).join("") || '<span class="muted">—</span>';
    const areas = (w.suburbs || []).map((s) => `<label class="chk">📍 ${esc(s)}</label>`).join("") || '<span class="muted">—</span>';

    const [recentJobs, doneCount] = await Promise.all([
      JobRequest.find({ $or: [{ poster: u._id }, { worker: u._id }] }).sort({ createdAt: -1 }).limit(10).lean(),
      JobRequest.countDocuments({ worker: u._id, status: "done" })
    ]);

    const jobRows = recentJobs
      .map((j) => `<tr><td>${cat(j.category).e} ${esc(cat(j.category).l)}</td><td>${esc(j.suburb)}</td><td>${jobStatusBadge(j.status)}</td><td>${String(j.poster) === String(u._id) ? "posted" : "worked"}</td><td class="muted">${timeAgo(j.createdAt)}</td></tr>`)
      .join("");

    res.send(
      layout(
        u.name || "User",
        `
      <p style="margin-bottom:16px"><a class="btn sm ghost" href="/rese-admin/users">← Back</a></p>

      <div class="row2">
        <div class="card">
          <h3>Account</h3>
          <div style="display:flex;align-items:center;gap:14px;margin-bottom:12px">
            ${u.avatarFileId ? `<img class="avatar" style="width:64px;height:64px" src="/rese-admin/media/${u.avatarFileId}">` : '<div class="avatar" style="width:64px;height:64px;display:flex;align-items:center;justify-content:center;font-size:30px">🙂</div>'}
            <div><div style="font-size:19px;font-weight:800">${esc(u.name || "—")}</div><div class="muted">${esc(u.phone)}</div></div>
          </div>
          <div class="kv"><span>Type</span><b>${u.isWorker ? "💪 Worker" : ""} ${u.isRequester ? "🙋 Requester" : ""}</b></div>
          <div class="kv"><span>Status</span><b>${statusBadge(u.status)}</b></div>
          <div class="kv"><span>Age</span><b>${u.age != null ? u.age + " yrs" : "unknown"} ${u.adultConfirmed ? "✅ adult" : ""}</b></div>
          <div class="kv"><span>Joined</span><b>${fmtDate(u.createdAt)}</b></div>
          <div class="kv"><span>Jobs done</span><b>${doneCount}</b></div>

          <div class="actions" style="margin-top:16px">
            ${u.status !== "active" ? `<form method="post" action="/rese-admin/users/${u._id}/approve"><button class="btn green sm">✔ Approve account</button></form>` : ""}
            ${u.status !== "suspended" ? `<form method="post" action="/rese-admin/users/${u._id}/suspend"><button class="btn red sm">⛔ Suspend</button></form>` : `<form method="post" action="/rese-admin/users/${u._id}/approve"><button class="btn green sm">↺ Reactivate</button></form>`}
            <form method="post" action="/rese-admin/users/${u._id}/set-adult" onsubmit="return true"><input type="hidden" name="adult" value="${u.adultConfirmed ? "0" : "1"}"><button class="btn sm ghost">${u.adultConfirmed ? "Mark under-age" : "Confirm 18+"}</button></form>
          </div>
        </div>

        <div class="card">
          <h3>ID verification ${verifyBadge(u.verification)}</h3>
          ${
            w.selfieFileId || w.idFileId
              ? `<div class="row2">
                  <div><div class="muted" style="margin-bottom:6px">Selfie</div>${w.selfieFileId ? `<img class="docimg" src="/rese-admin/media/${w.selfieFileId}">` : '<span class="muted">—</span>'}</div>
                  <div><div class="muted" style="margin-bottom:6px">National ID</div>${w.idFileId ? `<img class="docimg" src="/rese-admin/media/${w.idFileId}">` : '<span class="muted">—</span>'}</div>
                </div>`
              : '<p class="muted">No documents uploaded yet.</p>'
          }
          ${u.verification?.reason ? `<p class="muted" style="margin-top:10px">Reason: ${esc(u.verification.reason)}</p>` : ""}
          <div class="actions" style="margin-top:14px">
            <form method="post" action="/rese-admin/users/${u._id}/verify"><button class="btn green sm">✅ Approve verification</button></form>
            <form method="post" action="/rese-admin/users/${u._id}/reject" style="display:flex;gap:6px">
              <input name="reason" placeholder="Reason" style="flex:1">
              <button class="btn red sm">✕ Reject</button>
            </form>
          </div>
        </div>
      </div>

      ${
        u.isWorker
          ? `<div class="card"><h3>Worker profile</h3>
              <div class="muted" style="margin:8px 0 4px">Can do</div><div>${skills}</div>
              <div class="muted" style="margin:14px 0 4px">Works in</div><div>${areas}</div>
            </div>`
          : ""
      }

      <div class="card"><h3>Recent jobs</h3>
        <div class="table-wrap"><table>
          <thead><tr><th>Job</th><th>Area</th><th>Status</th><th>Role</th><th>When</th></tr></thead>
          <tbody>${jobRows || '<tr><td colspan="5" class="muted">None.</td></tr>'}</tbody>
        </table></div>
      </div>`,
        "users"
      )
    );
  } catch (err) {
    console.error("[rese-admin/user]", err);
    res.send(layout("User", `<div class="alert red">Error: ${esc(err.message)}</div>`, "users"));
  }
});

/* ── user actions ─────────────────────────────────────────── */

async function setUser(id, patch) {
  await ReseUser.findByIdAndUpdate(id, patch);
}

router.post("/users/:id/approve", requireReseAdmin, async (req, res) => {
  await setUser(req.params.id, { status: "active" });
  res.redirect(`/rese-admin/users/${req.params.id}`);
});
router.post("/users/:id/suspend", requireReseAdmin, async (req, res) => {
  await setUser(req.params.id, { status: "suspended" });
  res.redirect(`/rese-admin/users/${req.params.id}`);
});
router.post("/users/:id/verify", requireReseAdmin, async (req, res) => {
  await setUser(req.params.id, {
    "verification.status": "approved",
    "verification.reviewedAt": new Date(),
    "verification.reviewedBy": "admin",
    "verification.reason": ""
  });
  res.redirect(`/rese-admin/users/${req.params.id}`);
});
router.post("/users/:id/reject", requireReseAdmin, async (req, res) => {
  await setUser(req.params.id, {
    "verification.status": "rejected",
    "verification.reviewedAt": new Date(),
    "verification.reviewedBy": "admin",
    "verification.reason": String(req.body?.reason || "Not clear")
  });
  res.redirect(`/rese-admin/users/${req.params.id}`);
});
router.post("/users/:id/set-adult", requireReseAdmin, async (req, res) => {
  await setUser(req.params.id, { adultConfirmed: String(req.body?.adult) === "1" });
  res.redirect(`/rese-admin/users/${req.params.id}`);
});

/* ── verification queue ───────────────────────────────────── */

router.get("/verifications", requireReseAdmin, async (req, res) => {
  try {
    const pending = await ReseUser.find({ "verification.status": "pending" }).sort({ createdAt: 1 }).limit(100).lean();
    const cards = pending
      .map(
        (u) => `<div class="card">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
          <b>${esc(u.name || "—")} · <span class="muted">${esc(u.phone)}</span></b>
          <a class="btn sm ghost" href="/rese-admin/users/${u._id}">Open</a>
        </div>
        <div class="row2">
          <div><div class="muted" style="margin-bottom:6px">Selfie</div>${u.worker?.selfieFileId ? `<img class="docimg" src="/rese-admin/media/${u.worker.selfieFileId}">` : '<span class="muted">—</span>'}</div>
          <div><div class="muted" style="margin-bottom:6px">National ID</div>${u.worker?.idFileId ? `<img class="docimg" src="/rese-admin/media/${u.worker.idFileId}">` : '<span class="muted">—</span>'}</div>
        </div>
        <div class="actions" style="margin-top:12px">
          <form method="post" action="/rese-admin/users/${u._id}/verify"><button class="btn green sm">✅ Approve</button></form>
          <form method="post" action="/rese-admin/users/${u._id}/reject" style="display:flex;gap:6px"><input name="reason" placeholder="Reason"><button class="btn red sm">✕ Reject</button></form>
        </div>
      </div>`
      )
      .join("");
    res.send(layout("Verifications", cards || '<div class="card muted">Nothing pending. 🎉</div>', "verify"));
  } catch (err) {
    res.send(layout("Verifications", `<div class="alert red">Error: ${esc(err.message)}</div>`, "verify"));
  }
});

/* ── jobs ─────────────────────────────────────────────────── */

router.get("/jobs", requireReseAdmin, async (req, res) => {
  try {
    const status = String(req.query.status || "").trim();
    const query = {};
    if (status) query.status = status;
    const jobs = await JobRequest.find(query).sort({ createdAt: -1 }).limit(300).lean();
    const rows = jobs
      .map(
        (j) => `<tr>
        <td>${cat(j.category).e} <b>${esc(cat(j.category).l)}</b><br><span class="muted">${esc((j.description || "").slice(0, 50))}</span></td>
        <td>${esc(j.suburb)}</td>
        <td>${esc(j.budget)}</td>
        <td>${jobStatusBadge(j.removedByAdmin ? "cancelled" : j.status)}</td>
        <td class="muted">${esc(j.posterName || j.posterPhone)}</td>
        <td class="muted">${timeAgo(j.createdAt)}</td>
        <td>${j.removedByAdmin ? '<span class="muted">removed</span>' : `<form method="post" action="/rese-admin/jobs/${j._id}/remove"><button class="btn red sm">Remove</button></form>`}</td>
      </tr>`
      )
      .join("");
    res.send(
      layout(
        "Jobs",
        `<form method="get" class="controls">
          <select name="status"><option value="">All statuses</option>${["open", "accepted", "done", "expired", "cancelled"].map((s) => `<option value="${s}" ${status === s ? "selected" : ""}>${s}</option>`).join("")}</select>
          <button class="btn" type="submit">Filter</button>
        </form>
        <div class="table-wrap"><table>
          <thead><tr><th>Job</th><th>Area</th><th>Pay</th><th>Status</th><th>Posted by</th><th>When</th><th></th></tr></thead>
          <tbody>${rows || '<tr><td colspan="7" class="muted">No jobs.</td></tr>'}</tbody>
        </table></div>`,
        "jobs"
      )
    );
  } catch (err) {
    res.send(layout("Jobs", `<div class="alert red">Error: ${esc(err.message)}</div>`, "jobs"));
  }
});

router.post("/jobs/:id/remove", requireReseAdmin, async (req, res) => {
  await JobRequest.findByIdAndUpdate(req.params.id, { removedByAdmin: true, status: "cancelled" });
  res.redirect("/rese-admin/jobs");
});

/* ── settings ─────────────────────────────────────────────── */

router.get("/settings", requireReseAdmin, async (req, res) => {
  const s = await ReseSetting.load();
  const catChecks = Object.entries(CATS)
    .map(([id, c]) => `<label class="chk"><input type="checkbox" name="ageRestrictedCategories" value="${id}" ${s.ageRestrictedCategories.includes(id) ? "checked" : ""}> ${c.e} ${esc(c.l)}</label>`)
    .join("");
  res.send(
    layout(
      "Settings",
      `${req.query.saved ? '<div class="alert" style="background:#dcfce7;color:#15803d">Saved.</div>' : ""}
      <form method="post" action="/rese-admin/settings">
        <div class="card">
          <h3>Age &amp; approval rules</h3>
          <div class="setting-row"><div><b>Minimum working age</b><br><span class="muted">Used for age-restricted jobs</span></div><input type="number" name="minAge" value="${s.minAge}" style="width:90px"></div>
          <div class="setting-row"><div><b>Workers need admin approval</b><br><span class="muted">New workers stay “pending” until you approve</span></div><input type="checkbox" name="requireWorkerApproval" ${s.requireWorkerApproval ? "checked" : ""}></div>
          <div class="setting-row"><div><b>Workers need ID verification</b><br><span class="muted">Must be verified before receiving jobs</span></div><input type="checkbox" name="requireVerification" ${s.requireVerification ? "checked" : ""}></div>
          <div class="setting-row"><div><b>Auto-close open jobs after</b><br><span class="muted">Hours before an unanswered job expires</span></div><input type="number" name="autoExpireHours" value="${s.autoExpireHours}" style="width:90px"></div>
        </div>
        <div class="card">
          <h3>Age-restricted job types</h3>
          <p class="muted" style="margin-bottom:10px">Only adult-confirmed (18+) workers can take these.</p>
          <div>${catChecks}</div>
        </div>
        <button class="btn" type="submit">💾 Save settings</button>
      </form>
      <div class="card" style="margin-top:20px">
        <h3>Testing</h3>
        <p class="muted" style="margin-bottom:10px">Populate the panel with sample users and jobs so you can see it working before the app is wired.</p>
        <form method="post" action="/rese-admin/seed-demo"><button class="btn ghost">🌱 Seed demo data</button></form>
      </div>`,
      "settings"
    )
  );
});

router.post("/settings", requireReseAdmin, async (req, res) => {
  const b = req.body || {};
  const arr = Array.isArray(b.ageRestrictedCategories)
    ? b.ageRestrictedCategories
    : b.ageRestrictedCategories
    ? [b.ageRestrictedCategories]
    : [];
  const s = await ReseSetting.load();
  s.minAge = Number(b.minAge) || 18;
  s.requireWorkerApproval = b.requireWorkerApproval === "on";
  s.requireVerification = b.requireVerification === "on";
  s.autoExpireHours = Number(b.autoExpireHours) || 3;
  s.ageRestrictedCategories = arr;
  s.updatedAt = new Date();
  await s.save();
  res.redirect("/rese-admin/settings?saved=1");
});

/* ── media (GridFS, admin-gated) ──────────────────────────── */

router.get("/media/:id", requireReseAdmin, (req, res) => {
  let _id;
  try {
    _id = new mongoose.Types.ObjectId(req.params.id);
  } catch {
    return res.status(400).end();
  }
  res.setHeader("Content-Type", "image/jpeg");
  res.setHeader("Cache-Control", "private, max-age=300");
  const stream = bucket().openDownloadStream(_id);
  stream.on("error", () => {
    if (!res.headersSent) res.status(404);
    res.end();
  });
  stream.pipe(res);
});

/* ── seed demo (for trying the panel before the app is wired) ── */

router.post("/seed-demo", requireReseAdmin, async (req, res) => {
  try {
    const demo = [
      { phone: "+263771000101", name: "Tapiwa M.", isWorker: true, status: "pending", worker: { skills: ["water", "carry", "garden"], suburbs: ["Budiriro", "Glen View"] }, verification: { status: "pending" } },
      { phone: "+263771000102", name: "Rutendo K.", isWorker: true, status: "active", adultConfirmed: true, worker: { skills: ["clean", "laundry"], suburbs: ["Kuwadzana"] }, verification: { status: "approved", reviewedAt: new Date(), reviewedBy: "admin" } },
      { phone: "+263771000103", name: "Amai Tino", isWorker: false, status: "active" }
    ];
    for (const d of demo) {
      await ReseUser.updateOne({ phone: d.phone }, { $setOnInsert: { ...d, createdAt: new Date() } }, { upsert: true });
    }
    const tino = await ReseUser.findOne({ phone: "+263771000103" });
    await JobRequest.create([
      { poster: tino?._id, posterName: "Amai Tino", posterPhone: "+263771000103", category: "water", description: "Fetch 5 buckets from the borehole", suburb: "Budiriro", budget: "$2", status: "open", createdAt: new Date(), expiresAt: new Date(Date.now() + 3 * 3600000) },
      { poster: tino?._id, posterName: "Amai Tino", posterPhone: "+263771000103", category: "carwash", description: "Wash small car at home", suburb: "Kuwadzana", budget: "$3", status: "done", createdAt: new Date(Date.now() - 86400000), completedAt: new Date() }
    ]);
    res.redirect("/rese-admin");
  } catch (err) {
    res.send(layout("Settings", `<div class="alert red">Seed error: ${esc(err.message)}</div>`, "settings"));
  }
});

export default router;
