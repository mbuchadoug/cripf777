// routes/mobileAdmin.js
//
// A small admin area for the mobile app: view users who registered on mobile,
// manually activate their subscription (no payment needed), and view their
// quiz attempts. Reuses the same admin-email gate as the org admin.
//
// Mount in server.js:
//    import mobileAdminRouter from "./routes/mobileAdmin.js";
//    app.use("/", mobileAdminRouter);
//
// Then visit:  https://cripfcnt.com/admin/mobile/users

import { Router } from "express";
import User from "../models/user.js";
import ExamInstance from "../models/examInstance.js";

const router = Router();

/* Reuse the same login + admin-email gate the org admin uses. */
function ensureAuth(req, res, next) {
  if (req.isAuthenticated && req.isAuthenticated()) return next();
  return res.redirect("/auth/google");
}
function ensureAdminEmails(req, res, next) {
  const adminEmails = (process.env.ADMIN_EMAILS || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (!req.user || !req.user.email) return res.status(403).send("Admins only");
  if (!adminEmails.includes(req.user.email.toLowerCase())) return res.status(403).send("Admins only");
  next();
}

/* Plan configs - mirror routes/payments.js PLANS. */
const PLANS = {
  silver: { name: "Silver", role: "parent", plan: "silver", maxChildren: 2, durationDays: 30 },
  gold: { name: "Gold", role: "parent", plan: "gold", maxChildren: 5, durationDays: 30 },
  teacher_starter: { name: "Teacher Starter", role: "teacher", plan: "starter", maxChildren: 15, aiQuizCredits: 20, durationDays: 30 },
  teacher_professional: { name: "Teacher Professional", role: "teacher", plan: "professional", maxChildren: 40, aiQuizCredits: 50, durationDays: 30 }
};

const esc = (s) =>
  String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );

/* ══════════════════════════════════════════════════════════════════
   GET /admin/mobile/users - list mobile users (parents, teachers, students)
   ════════════════════════════════════════════════════════════════════ */
router.get("/admin/mobile/users", ensureAuth, ensureAdminEmails, async (req, res) => {
  try {
    const q = String(req.query.q || "").trim();
    const roleFilter = String(req.query.role || "").trim();

    const query = {
      role: { $in: ["parent", "private_teacher", "student"] }
    };
    if (roleFilter) query.role = roleFilter;
    if (q) {
      query.$or = [
        { email: new RegExp(q, "i") },
        { username: new RegExp(q, "i") },
        { displayName: new RegExp(q, "i") },
        { firstName: new RegExp(q, "i") },
        { lastName: new RegExp(q, "i") }
      ];
    }

    const users = await User.find(query)
      .select("displayName firstName lastName email username role grade subscriptionPlan teacherSubscriptionPlan subscriptionExpiresAt parentUserId createdAt")
      .sort({ createdAt: -1 })
      .limit(300)
      .lean();

    const rows = users
      .map((u) => {
        const plan =
          u.role === "private_teacher"
            ? u.teacherSubscriptionPlan && u.teacherSubscriptionPlan !== "none"
              ? `teacher_${u.teacherSubscriptionPlan}`
              : "-"
            : u.subscriptionPlan && u.subscriptionPlan !== "none"
            ? u.subscriptionPlan
            : "-";
        const active =
          u.subscriptionExpiresAt && new Date(u.subscriptionExpiresAt) > new Date();
        const roleLabel = u.role === "private_teacher" ? "teacher" : u.role;
        const planOptions = Object.entries(PLANS)
          .filter(([, cfg]) =>
            u.role === "private_teacher" ? cfg.role === "teacher" : cfg.role === "parent"
          )
          .map(([key, cfg]) => `<option value="${key}">${esc(cfg.name)}</option>`)
          .join("");

        return `
      <tr>
        <td>
          <strong>${esc(u.displayName || [u.firstName, u.lastName].filter(Boolean).join(" ") || u.username)}</strong><br>
          <span class="muted">${esc(u.email || "no email")} · @${esc(u.username || "")}</span>
        </td>
        <td><span class="pill">${esc(roleLabel)}</span></td>
        <td>${u.role === "student" ? `Grade ${esc(u.grade || "-")}` : "-"}</td>
        <td>
          ${plan === "-" ? '<span class="muted">free</span>' : `<span class="pill green">${esc(plan)}</span>`}
          ${active ? `<br><span class="muted">until ${new Date(u.subscriptionExpiresAt).toLocaleDateString()}</span>` : ""}
        </td>
        <td class="nowrap">
          ${
            u.role === "student"
              ? `<a class="btn sm" href="/admin/mobile/attempts?userId=${u._id}">Attempts</a>`
              : `
            <form method="post" action="/admin/mobile/users/${u._id}/activate" style="display:flex;gap:6px;align-items:center">
              <select name="plan">${planOptions}</select>
              <button class="btn sm" type="submit">Activate</button>
            </form>`
          }
        </td>
      </tr>`;
      })
      .join("");

    res.send(pageShell(`
      <h1>Mobile users</h1>
      <p class="muted">Users who registered on the mobile app. Activate a plan manually, or view a student's attempts.</p>
      <form method="get" class="controls">
        <input name="q" value="${esc(q)}" placeholder="Search name, email, username">
        <select name="role">
          <option value="">All roles</option>
          <option value="parent" ${roleFilter === "parent" ? "selected" : ""}>Parents</option>
          <option value="private_teacher" ${roleFilter === "private_teacher" ? "selected" : ""}>Teachers</option>
          <option value="student" ${roleFilter === "student" ? "selected" : ""}>Students</option>
        </select>
        <button class="btn" type="submit">Search</button>
      </form>
      <table>
        <thead><tr><th>User</th><th>Role</th><th>Grade</th><th>Plan</th><th>Actions</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="5" class="muted">No users found.</td></tr>'}</tbody>
      </table>
    `));
  } catch (err) {
    console.error("[admin/mobile/users]", err);
    res.status(500).send("Error loading users");
  }
});

/* ══════════════════════════════════════════════════════════════════
   POST /admin/mobile/users/:id/activate - manually activate a plan
   ════════════════════════════════════════════════════════════════════ */
router.post("/admin/mobile/users/:id/activate", ensureAuth, ensureAdminEmails, async (req, res) => {
  try {
    const planKey = String(req.body?.plan || "");
    const cfg = PLANS[planKey];
    if (!cfg) return res.status(400).send("Invalid plan");

    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).send("User not found");

    const now = new Date();
    // Extend from an existing expiry if still active, else from now.
    const base =
      user.subscriptionExpiresAt && new Date(user.subscriptionExpiresAt) > now
        ? new Date(user.subscriptionExpiresAt)
        : now;
    const expiresAt = new Date(base.getTime() + cfg.durationDays * 24 * 60 * 60 * 1000);

    if (cfg.role === "teacher") {
      user.teacherSubscriptionPlan = cfg.plan; // starter | professional
      user.teacherSubscriptionStatus = "paid"; // was "active" - NOT a valid enum value (trial|paid)
      user.teacherSubscriptionExpiresAt = expiresAt;
      user.teacherPaidAt = now;
      user.maxChildren = cfg.maxChildren;
      if (cfg.aiQuizCredits) user.aiQuizCredits = (user.aiQuizCredits || 0) + cfg.aiQuizCredits;
    } else {
      // The missing flip. Web gates access on subscriptionStatus === "paid";
      // without this the account looks paid on mobile (which keys off the plan)
      // but unpaid on the web. Set both so the two platforms agree.
      user.subscriptionStatus = "paid";
      user.subscriptionPlan = cfg.plan; // silver | gold
      user.paidAt = now;
      user.maxChildren = cfg.maxChildren;
    }
    user.subscriptionExpiresAt = expiresAt;
    await user.save();

    res.redirect("/admin/mobile/users");
  } catch (err) {
    console.error("[admin/mobile/activate]", err);
    res.status(500).send("Error activating plan");
  }
});

/* ══════════════════════════════════════════════════════════════════
   GET /admin/mobile/attempts - mobile quiz attempts (all, or by user)
   ════════════════════════════════════════════════════════════════════ */
router.get("/admin/mobile/attempts", ensureAuth, ensureAdminEmails, async (req, res) => {
  try {
    const userId = String(req.query.userId || "").trim();
    const query = { "meta.source": "mobile-app" };
    if (userId) query.userId = userId;

    const attempts = await ExamInstance.find(query)
      .sort({ updatedAt: -1 })
      .limit(300)
      .lean();

    // Resolve student names.
    const ids = [...new Set(attempts.map((a) => String(a.userId)).filter(Boolean))];
    const users = await User.find({ _id: { $in: ids } }).select("displayName firstName lastName username").lean();
    const nameById = {};
    for (const u of users) nameById[String(u._id)] = u.displayName || [u.firstName, u.lastName].filter(Boolean).join(" ") || u.username;

    const rows = attempts
      .map((a) => {
        const pct = a.meta?.percentage;
        const when = a.meta?.finishedAt || a.updatedAt;
        return `
      <tr>
        <td>${esc(nameById[String(a.userId)] || a.userId)}</td>
        <td>${esc(a.quizTitle || a.title || a.module || "Quiz")}</td>
        <td><span class="pill">${esc(a.status)}</span></td>
        <td>${pct != null ? `<strong>${pct}%</strong>` : "-"}</td>
        <td class="muted">${when ? new Date(when).toLocaleString() : "-"}</td>
      </tr>`;
      })
      .join("");

    res.send(pageShell(`
      <h1>Mobile attempts</h1>
      <p><a class="btn sm" href="/admin/mobile/users">← Back to users</a></p>
      <table>
        <thead><tr><th>Student</th><th>Quiz</th><th>Status</th><th>Score</th><th>When</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="5" class="muted">No mobile attempts yet.</td></tr>'}</tbody>
      </table>
    `));
  } catch (err) {
    console.error("[admin/mobile/attempts]", err);
    res.status(500).send("Error loading attempts");
  }
});

/* Minimal styled shell so it looks consistent without a template. */
function pageShell(body) {
  return `<!doctype html><html><head><meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Mobile admin · CRIPFCnt</title>
  <style>
    body{font-family:Inter,system-ui,sans-serif;background:#04231F;color:#F5F2EA;margin:0;padding:28px}
    h1{font-family:Georgia,serif;font-weight:600;margin:0 0 4px}
    .muted{color:#7E908B;font-size:13px}
    a{color:#1DE9B6;text-decoration:none}
    table{width:100%;border-collapse:collapse;margin-top:18px;background:#0B2E28;border-radius:12px;overflow:hidden}
    th,td{text-align:left;padding:12px 14px;border-bottom:1px solid rgba(245,242,234,0.08);font-size:14px;vertical-align:top}
    th{background:#0B4F45;color:#CFE;font-size:12px;text-transform:uppercase;letter-spacing:.5px}
    .pill{display:inline-block;padding:2px 9px;border-radius:999px;background:rgba(245,242,234,0.10);font-size:11px;text-transform:capitalize}
    .pill.green{background:rgba(29,233,182,0.16);color:#1DE9B6}
    .btn{display:inline-block;background:#1DE9B6;color:#04231F;padding:9px 16px;border:none;border-radius:8px;font-weight:600;cursor:pointer;font-size:13px}
    .btn.sm{padding:6px 12px;font-size:12px}
    .btn.secondary{background:transparent;color:#1DE9B6;border:1px solid #1DE9B6}
    .controls{display:flex;gap:8px;margin-top:16px;flex-wrap:wrap}
    input,select{background:#0B2E28;border:1px solid rgba(245,242,234,0.18);color:#F5F2EA;padding:9px 12px;border-radius:8px;font-size:13px}
    .nowrap{white-space:nowrap}
  </style></head><body>${body}</body></html>`;
}

export default router;