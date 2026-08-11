// routes/auth.js
// ─────────────────────────────────────────────────────────────────────
//  CHANGES FROM PREVIOUS VERSION:
//
//  1. After Google OAuth callback, school members (employees/students/
//     teachers/admins) who don't have a username get one auto-assigned.
//     They also get needsPasswordSetup=true so the dashboard can prompt
//     them to create a password.
//
//  2. NEW routes:
//       GET  /auth/set-password   → form for school users to set/change password
//       POST /auth/set-password   → save new password + generate username if missing
//       POST /auth/change-password → for logged-in users changing existing password
//
//  3. The /auth/school POST now also matches by `username` field so
//     users can log in as  username | studentId | teacherId | adminId
//
//  All other routes (parent, teacher, google, logout, etc.) are UNCHANGED.
// ─────────────────────────────────────────────────────────────────────

import { Router } from "express";
import passport from "passport";
import Organization from "../models/organization.js";
import OrgMembership from "../models/orgMembership.js";
import crypto from "crypto";
import ExamInstance from "../models/examInstance.js";
import Question from "../models/question.js";
import { ensureAuth } from "../middleware/authGuard.js";
import User from "../models/user.js";
import { mobileGoogleReturn } from "./mobileApi.js"; // mobile app return hook

const router = Router();

// ── Helpers ────────────────────────────────────────────────────────
function safeReturnTo(candidate) {
  if (!candidate || typeof candidate !== "string") return null;
  const decoded = decodeURIComponent(candidate).trim();
  if (!decoded.startsWith("/")) return null;
  if (decoded.startsWith("//")) return null;
  if (decoded.length > 2048) return null;
  if (decoded.startsWith("/auth") || decoded.startsWith("/logout")) return null;
  return decoded;
}

function encodeState(returnTo) {
  try {
    if (!returnTo) return "";
    return Buffer.from(returnTo, "utf8")
      .toString("base64")
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  } catch { return ""; }
}

function decodeState(state) {
  try {
    if (!state || typeof state !== "string") return null;
    const base64 = state.replace(/-/g, "+").replace(/_/g, "/") +
      "==".slice((2 - state.length * 3) & 3);
    return Buffer.from(base64, "base64").toString("utf8");
  } catch { return null; }
}

// ─────────────────────────────────────────────────────────────────────
// PARENT / TEACHER / ARENA signup (unchanged)
// ─────────────────────────────────────────────────────────────────────

// ────────────────────────────────────────────────────────────
// PARENT LOGIN PAGE  ← homepage "Parents & Guardians" points here (/auth/login)
// Renders the chooser page (email / code / Google) instead of auto-Google.
// ────────────────────────────────────────────────────────────
router.get("/login", async (req, res) => {
  if (req.user) {
    if (req.user.role === "student" || req.user.parentUserId) return res.redirect("/student/dashboard");
    if (req.user.role === "private_teacher") {
      const td = await User.findById(req.user._id).select("needsProfileSetup schoolLevelsEnabled").lean();
      return res.redirect((td?.needsProfileSetup || !td?.schoolLevelsEnabled?.length) ? "/teacher/setup" : "/teacher/dashboard");
    }
    return res.redirect("/parent/dashboard");
  }
  // If your view lives elsewhere, change this render path to match.
  return res.render("auth/parent_login", { layout: false });
});

router.get("/parent", async (req, res) => {
  if (req.user) {
    // NEVER convert a managed student/child into a parent. A signed-in student
    // who lands here (e.g. clicks a "Parent" link) goes to their own dashboard;
    // their role is left untouched.
    if (req.user.role === "student" || req.user.parentUserId) {
      return res.redirect("/student/dashboard");
    }
    if (!["parent", "private_teacher"].includes(req.user.role)) {
      await User.updateOne(
        { _id: req.user._id },
        { $set: { role: "parent", consumerEnabled: true, accountType: "parent" } }
      );
      req.user.role = "parent";
    }
    return res.redirect("/parent/dashboard");
  }

  // ✅ Only launch Google when the page's "Continue with Google" button asks for it
  //    (href="/auth/parent?google=1"). A plain visit shows the parent login page.
  const wantsGoogle = req.query.google === "1" || req.query.provider === "google";
  if (!wantsGoogle) return res.render("auth/parent_login", { layout: false });

  req.session.signupSource = "parent";
  req.session.returnTo = "/parent/dashboard";
  req.session.save(() => res.redirect("/auth/google"));
});

router.get("/teacher", async (req, res) => {
  if (req.user) {
    // NEVER convert a managed student/child into a private teacher. Send a
    // signed-in student to their own dashboard instead of overwriting the role.
    if (req.user.role === "student" || req.user.parentUserId) {
      return res.redirect("/student/dashboard");
    }
    if (req.user.role !== "private_teacher") {
      await User.updateOne(
        { _id: req.user._id },
        { $set: { role: "private_teacher", needsProfileSetup: true, consumerEnabled: true } }
      );
      req.user.role = "private_teacher";
    }
    const doc = await User.findById(req.user._id).select("needsProfileSetup schoolLevelsEnabled").lean();
    if (doc?.needsProfileSetup || !doc?.schoolLevelsEnabled?.length) return res.redirect("/teacher/setup");
    return res.redirect("/teacher/dashboard");
  }
  req.session.signupSource = "private_teacher";
  req.session.returnTo = "/teacher/setup";
  req.session.save(() => res.redirect("/auth/google"));
});

router.get("/arena", async (req, res) => {
  if (req.user) return res.redirect("/arena");
  req.session.signupSource = "arena";
  req.session.returnTo = "/arena";
  req.session.save(() => res.redirect("/auth/google?returnTo=%2Farena&force=1"));
});

// ─────────────────────────────────────────────────────────────────────
// GOOGLE OAUTH
// ─────────────────────────────────────────────────────────────────────

router.get("/google", (req, res, next) => {
  try {
    let candidate = null;
    if (req.query?.returnTo)   candidate = String(req.query.returnTo);
    else if (req.session?.returnTo) candidate = String(req.session.returnTo);
    else {
      const ref = req.get("referer");
      if (ref) {
        try { const u = new URL(ref); candidate = (u.pathname || "/") + (u.search || ""); } catch {}
      }
    }
    const safe  = safeReturnTo(candidate) || null;
    const force = req.query?.force === "1";
    if (safe && req.session) {
      req.session.returnTo = safe;
      if (typeof req.session.save === "function") {
        req.session.save(() => {
          passport.authenticate("google", { scope: ["profile", "email"], state: encodeState(safe), ...(force ? { prompt: "select_account" } : {}) })(req, res, next);
        });
        return;
      }
    }
    passport.authenticate("google", { scope: ["profile", "email"], state: encodeState(safe), ...(force ? { prompt: "select_account" } : {}) })(req, res, next);
  } catch {
    passport.authenticate("google", { scope: ["profile", "email"] })(req, res, next);
  }
});

router.get(
  "/google/callback",
  passport.authenticate("google", { failureRedirect: "/" }),
  async (req, res) => {
    try {
      // ── Mobile app login? Hand back a one-time code and stop. ──
      // Set by /api/mobile/auth/google/start. Browser logins never set it,
      // so the web flow below is completely unaffected.
      if (req.session?.mobileFlow) {
        const handled = await mobileGoogleReturn(req, res);
        if (handled) return;
      }

      const rawState  = req.query?.state ? String(req.query.state) : null;
      const decoded   = rawState ? decodeState(rawState) : null;
      const fromState   = decoded && safeReturnTo(decoded) ? decoded : null;
      const fromSession = req.session?.returnTo ? safeReturnTo(req.session.returnTo) : null;
      if (req.session) { try { delete req.session.returnTo; } catch {} }

      // ── AUTO-ASSIGN USERNAME for school users who don't have one ──
      // This runs on every Google callback, but the $set only fires
      // when username is genuinely missing, so it's safe to repeat.
      if (req.user && !req.user.username) {
        const membership = await OrgMembership.findOne({ user: req.user._id }).lean();
        if (membership) {
          // School member - give them a username and flag password setup
          try {
            const newUsername = await User.createUniqueUsername(
              req.user.firstName || req.user.displayName?.split(" ")[0] || "user",
              req.user.lastName  || req.user.displayName?.split(" ").slice(1).join("") || ""
            );
            await User.updateOne(
              { _id: req.user._id },
              { $set: { username: newUsername, needsPasswordSetup: true } }
            );
            req.user.username = newUsername;
            console.log(`[auth] ✅ Assigned username "${newUsername}" to ${req.user.email}`);
          } catch (e) {
            console.warn("[auth] username assignment failed:", e.message);
          }
        }
      }

      const defaultOrgSlug = "cripfcnt-school";
      let redirectPath = null;
      const signupSource = req.session?.signupSource || null;
      if (req.session?.signupSource) delete req.session.signupSource;

      if (fromState || fromSession) {
        redirectPath = fromState || fromSession;
      } else {
        const memberships = await OrgMembership.find({ user: req.user._id }).populate("org").lean();

        const isManagedStudent = req.user.role === "student" || !!req.user.parentUserId;

        if (isManagedStudent) {
          // A student/child is never re-roled by a signup source.
          redirectPath = "/student/dashboard";
        } else if (signupSource === "private_teacher" && req.user.role !== "private_teacher") {
          await User.updateOne({ _id: req.user._id }, { $set: { role: "private_teacher", needsProfileSetup: true, consumerEnabled: true } });
          req.user.role = "private_teacher";
          redirectPath = "/teacher/setup";
        } else if (signupSource === "private_teacher") {
          const td = await User.findById(req.user._id).select("needsProfileSetup schoolLevelsEnabled").lean();
          redirectPath = (td?.needsProfileSetup || !td?.schoolLevelsEnabled?.length) ? "/teacher/setup" : "/teacher/dashboard";
        } else if (signupSource === "parent") {
          if (!["parent", "private_teacher"].includes(req.user.role)) {
            await User.updateOne({ _id: req.user._id }, { $set: { role: "parent", consumerEnabled: true, accountType: "parent" } });
            req.user.role = "parent";
          }
          redirectPath = "/parent/dashboard";
        } else if (req.user.role === "private_teacher") {
          const td = await User.findById(req.user._id).select("needsProfileSetup schoolLevelsEnabled").lean();
          redirectPath = (td?.needsProfileSetup || !td?.schoolLevelsEnabled?.length) ? "/teacher/setup" : "/teacher/dashboard";
        } else if (req.user.role === "parent") {
          redirectPath = "/parent/dashboard";
        } else if (memberships.length > 0 && memberships[0].org?.slug) {
          redirectPath = `/org/${memberships[0].org.slug}/dashboard`;
        } else {
          const org = await Organization.findOne({ slug: defaultOrgSlug }).lean();
          if (org) {
            await OrgMembership.create({ org: org._id, user: req.user._id, role: "employee", joinedAt: new Date() });
          }
          redirectPath = `/org/${defaultOrgSlug}/dashboard`;
        }
      }

      // AUTO-ENROLL helpers (unchanged logic)
      try {
        const homeOrg = await Organization.findOne({ slug: "cripfcnt-home" }).lean();
        if (homeOrg && (req.user.role === "parent" || req.user.role === "private_teacher")) {
          const has = await OrgMembership.findOne({ org: homeOrg._id, user: req.user._id }).lean();
          if (!has) await OrgMembership.create({ org: homeOrg._id, user: req.user._id, role: req.user.role === "private_teacher" ? "private_teacher" : "parent", joinedAt: new Date() });
        }
      } catch (e) { console.warn("[auth] auto-enroll cripfcnt-home failed:", e.message); }

      try {
        if (["employee","parent","private_teacher"].includes(req.user.role)) {
          const schoolOrg = await Organization.findOne({ slug: "cripfcnt-school" }).lean();
          if (schoolOrg) {
            const has = await OrgMembership.findOne({ org: schoolOrg._id, user: req.user._id }).lean();
            if (!has) await OrgMembership.create({ org: schoolOrg._id, user: req.user._id, role: req.user.role === "employee" ? "employee" : req.user.role, joinedAt: new Date() });
          }
        }
      } catch (e) { console.warn("[auth] auto-enroll cripfcnt-school failed:", e.message); }

      console.log("[/auth/google/callback] redirecting to:", redirectPath);
      return res.redirect(redirectPath);
    } catch (e) {
      console.error("[/auth/google/callback] redirect error:", e.message);
      return res.redirect("/audit");
    }
  }
);

// ─────────────────────────────────────────────────────────────────────
// STUDENT LOGIN  (unchanged)
// ─────────────────────────────────────────────────────────────────────

router.get("/student", (req, res) => {
  res.render("auth/student_login", { layout: false });
});

router.post("/student", async (req, res) => {
  try {
    const { studentId, password } = req.body;
    const user = await User.findOne({ studentId, role: "student" });
    if (!user)                       return res.status(401).send("Invalid student ID");
    const ok = await user.verifyPassword(password);
    if (!ok)                         return res.status(401).send("Invalid password");
    user.lastLogin = new Date();
    await user.save();
    req.login(user, async err => {
      if (err) return res.status(500).send("Login failed");
      const membership = await OrgMembership.findOne({ user: user._id }).populate("org").lean();
      if (!membership || !membership.org?.slug) return res.status(403).send("No organization assigned");
      if (user.role === "student") return res.redirect("/student/dashboard");
      return res.redirect(`/org/${membership.org.slug}/dashboard`);
    });
  } catch (e) {
    console.error("[student login]", e);
    res.status(500).send("Login failed");
  }
});

// ─────────────────────────────────────────────────────────────────────
// SCHOOL LOGIN  ← UPDATED: now also matches `username` field
// ─────────────────────────────────────────────────────────────────────

router.get("/school", (req, res) => {
  res.render("auth/school_login", { layout: false, error: null });
});

router.post("/school", async (req, res) => {
  try {
    const { loginId, password } = req.body;

    if (!loginId || !password) {
      return res.render("auth/school_login", { layout: false, error: "Please enter your ID/username and password" });
    }

    // Match any of: username, studentId, teacherId, adminId, email
    const raw   = String(loginId).trim();
    const lower = raw.toLowerCase();

    // Match any of: username | email (both stored lowercase) OR studentId |
    // teacherId | adminId (case-sensitive). This is the SAME identifier set the
    // mobile app matches, so a username + password created on the phone - whether
    // for a parent OR a child - signs in here unchanged.
    const user = await User.findOne({
      $or: [
        { username:  lower },
        { email:     lower },
        { studentId: raw },
        { teacherId: raw },
        { adminId:   raw }
      ]
    });

    if (!user) {
      return res.render("auth/school_login", { layout: false, error: "Invalid username/ID or password" });
    }

    const ok = await user.verifyPassword(password);
    if (!ok) {
      return res.render("auth/school_login", { layout: false, error: "Invalid username/ID or password" });
    }

    user.lastLogin = new Date();
    await user.save();

    // ---- DIAGNOSTIC (temporary) ----
    // Shows exactly which account matched the typed credentials, and - when it
    // is a parent/teacher - the child usernames that DO reach the student dash.
    // Remove this block once the correct child username is confirmed.
    try {
      console.log("[/auth/school] MATCHED ACCOUNT", {
        typed: raw,
        _id: String(user._id),
        role: user.role,
        username: user.username || null,
        parentUserId: user.parentUserId ? String(user.parentUserId) : null,
        hasPassword: !!user.passwordHash
      });
      if (user.role === "parent" || user.role === "private_teacher") {
        const kids = await User.find({ parentUserId: user._id, role: "student" })
          .select("firstName lastName username grade passwordHash")
          .lean();
        console.log(`[/auth/school] ^ this is a ${user.role}; ${kids.length} child login(s):`);
        for (const k of kids) {
          console.log("   child:", [k.firstName, k.lastName].filter(Boolean).join(" "),
            "| username:", k.username || "(none)",
            "| canWebLogin:", !!k.passwordHash,
            "| grade:", k.grade == null ? "-" : k.grade);
        }
        console.log("   >> To reach the STUDENT dashboard, log in with a child username above that shows canWebLogin:true (NOT this parent account).");
      }
    } catch (e) {
      console.warn("[/auth/school] diagnostic failed:", e.message);
    }

    req.login(user, async err => {
      if (err) {
        console.error(err);
        return res.render("auth/school_login", { layout: false, error: "Login failed" });
      }
      // ---- Route by ROLE first ----
      // Home-learning accounts created on the mobile app (a parent and the
      // children they add) may have NO OrgMembership row, so we must not gate
      // every login on one. Only real school staff need an org to land in.

      // STUDENT - school-enrolled OR a home-learning child created on mobile.
      if (user.role === "student") {
        // Self-heal: mobile-created children have `organization` set but no
        // OrgMembership row (web-created children get one in parent.js). Create
        // it now so the student dashboard + quiz flows behave identically for
        // both. Wrapped so a failure here can never block a valid login.
        try {
          const has = await OrgMembership.findOne({ user: user._id }).lean();
          if (!has) {
            let orgId = user.organization || null;
            if (!orgId) {
              const homeOrg = await Organization.findOne({ slug: "cripfcnt-home" }).lean();
              orgId = homeOrg?._id || null;
            }
            if (orgId) {
              await OrgMembership.create({
                org: orgId,
                user: user._id,
                role: "student",
                joinedAt: new Date()
              });
              console.log("[/auth/school] self-healed membership for mobile student", String(user._id));
            }
          }
        } catch (e) {
          console.warn("[/auth/school] student membership self-heal failed:", e.message);
        }

        console.log("[/auth/school] student login -> /student/dashboard", {
          userId: String(user._id),
          username: user.username
        });
        return res.redirect("/student/dashboard");
      }

      // PARENT - home-learning. Always the parent dashboard, never an org page.
      if (user.role === "parent") {
        console.log("[/auth/school] parent login -> /parent/dashboard", {
          userId: String(user._id),
          username: user.username
        });
        return res.redirect("/parent/dashboard");
      }

      // PRIVATE TEACHER - home-learning. Setup first if the profile is incomplete.
      if (user.role === "private_teacher") {
        const td = await User.findById(user._id)
          .select("needsProfileSetup schoolLevelsEnabled")
          .lean();

        if (td?.needsProfileSetup || !td?.schoolLevelsEnabled?.length) {
          console.log("[/auth/school] private teacher -> /teacher/setup");
          return res.redirect("/teacher/setup");
        }
        console.log("[/auth/school] private teacher -> /teacher/dashboard");
        return res.redirect("/teacher/dashboard");
      }

      // SCHOOL STAFF - employee / org_admin / super_admin / readonly_admin.
      // These roles DO need an organization to land in.
      const membership = await OrgMembership.findOne({ user: user._id }).populate("org").lean();
      if (!membership || !membership.org?.slug) {
        return res.render("auth/school_login", { layout: false, error: "No school assigned to this account" });
      }

      console.log("[/auth/school] staff org redirect", {
        userId: String(user._id),
        username: user.username,
        role: user.role,
        orgSlug: membership.org.slug
      });
      return res.redirect(`/org/${membership.org.slug}/dashboard`);
    });
  } catch (e) {
    console.error("[school login]", e);
    res.render("auth/school_login", { layout: false, error: "Unexpected error occurred" });
  }
});

// ─────────────────────────────────────────────────────────────────────
// SET PASSWORD  (for school users - Google sign-ins + admin-issued accounts)
// GET  /auth/set-password   → show form
// POST /auth/set-password   → save password, generate username if missing
// ─────────────────────────────────────────────────────────────────────

router.get("/set-password", ensureAuth, async (req, res) => {
  // Redirect Google-only users to this page from dashboard
  const user = await User.findById(req.user._id)
    .select("username firstName lastName needsPasswordSetup passwordHash")
    .lean();
  return res.render("auth/set_password", {
    user,
    error: null,
    success: null,
    isFirstTime: !user.passwordHash  // true = "Create" wording; false = "Change" wording
  });
});

router.post("/set-password", ensureAuth, async (req, res) => {
  try {
    const { newPassword, confirmPassword } = req.body;

    // Validation
    if (!newPassword || newPassword.length < 8) {
      return res.render("auth/set_password", {
        user: req.user,
        error: "Password must be at least 8 characters",
        success: null,
        isFirstTime: !req.user.passwordHash
      });
    }
    if (newPassword !== confirmPassword) {
      return res.render("auth/set_password", {
        user: req.user,
        error: "Passwords do not match",
        success: null,
        isFirstTime: !req.user.passwordHash
      });
    }

    const user = await User.findById(req.user._id);
    if (!user) return res.status(404).send("User not found");

    // Set password
    await user.setPassword(newPassword);
    user.needsPasswordSetup = false;

    // Assign username if missing
    if (!user.username) {
      user.username = await User.createUniqueUsername(
        user.firstName || user.displayName?.split(" ")[0] || "user",
        user.lastName  || user.displayName?.split(" ").slice(1).join("") || ""
      );
    }

    await user.save();

    // Refresh session user
    req.user.username          = user.username;
    req.user.needsPasswordSetup = false;

    return res.render("auth/set_password", {
      user: { ...req.user, username: user.username },
      error: null,
      success: `Password set! Your login username is: ${user.username}`,
      isFirstTime: false
    });
  } catch (e) {
    console.error("[set-password]", e);
    res.render("auth/set_password", {
      user: req.user,
      error: "Something went wrong. Please try again.",
      success: null,
      isFirstTime: !req.user.passwordHash
    });
  }
});

// ─────────────────────────────────────────────────────────────────────
// CHANGE PASSWORD  (logged-in users who already have a password)
// POST /auth/change-password
// ─────────────────────────────────────────────────────────────────────

router.post("/change-password", ensureAuth, async (req, res) => {
  try {
    const { currentPassword, newPassword, confirmPassword } = req.body;
    const user = await User.findById(req.user._id);

    // If the user has no password yet, redirect to set-password
    if (!user.passwordHash) {
      return res.redirect("/auth/set-password");
    }

    const currentOk = await user.verifyPassword(currentPassword);
    if (!currentOk) {
      return res.status(400).json({ ok: false, error: "Current password is incorrect" });
    }
    if (!newPassword || newPassword.length < 8) {
      return res.status(400).json({ ok: false, error: "New password must be at least 8 characters" });
    }
    if (newPassword !== confirmPassword) {
      return res.status(400).json({ ok: false, error: "New passwords do not match" });
    }

    await user.setPassword(newPassword);
    await user.save();

    return res.json({ ok: true, message: "Password changed successfully" });
  } catch (e) {
    console.error("[change-password]", e);
    return res.status(500).json({ ok: false, error: "Failed to change password" });
  }
});

// ─────────────────────────────────────────────────────────────────────
// LOGOUT  (unchanged)
// ─────────────────────────────────────────────────────────────────────

router.get("/logout", (req, res, next) => {
  const role = req.user?.role;
  req.logout(function (err) {
    if (err) return next(err);
    req.session.destroy(() => {
      res.clearCookie("connect.sid");
      if (role === "student" || role === "teacher" || role === "admin") return res.redirect("/auth/school");
      return res.redirect("/");
    });
  });
});

// ─────────────────────────────────────────────────────────────────────
// ADMIN HELPER - CREATE PARENT  (unchanged)
// ─────────────────────────────────────────────────────────────────────

router.post("/admin/create-parent", ensureAuth, async (req, res) => {
  if (!["admin", "employee"].includes(req.user.role)) return res.status(403).send("Not allowed");
  const { email, firstName, lastName } = req.body;
  if (!email || !firstName) return res.status(400).send("Missing required fields");
  const existing = await User.findOne({ email: email.toLowerCase() });
  if (existing) return res.status(400).send("User already exists");
  const parent = await User.create({
    email: email.toLowerCase(), firstName, lastName,
    role: "parent", accountType: "parent", consumerEnabled: true, createdAt: new Date()
  });
  return res.json({ success: true, parentId: parent._id });
});

// ────────────────────────────────────────────────────────────
// EMAIL LOGIN API  (used by the auth/parent_login page)
// Session-based one-time codes - no new models. Wire sendLoginCode() to your real
// mailer; until then non-prod returns the code as devCode (the page displays it).
// ────────────────────────────────────────────────────────────
function genCode() { return String(Math.floor(100000 + Math.random() * 900000)); }

async function sendLoginCode(email, code, purpose) {
  console.log(`[auth/email] code for ${email} (${purpose}): ${code}`);
  const isProd = process.env.NODE_ENV === "production";
  return { devCode: isProd ? undefined : code }; // TODO: replace with SMTP/Gmail send
}

function redirectForUser(user) {
  if (user.role === "student" || user.parentUserId) return "/student/dashboard";
  if (user.role === "private_teacher") return "/teacher/dashboard";
  return "/parent/dashboard";
}

function readEmailAuth(req) {
  const s = req.session?.emailAuth;
  if (!s || !s.expiresAt || Date.now() > s.expiresAt) return null;
  return s;
}

router.post("/email/check", async (req, res) => {
  try {
    const email = String(req.body?.email || "").trim().toLowerCase();
    if (!email) return res.status(400).json({ error: "Email required" });
    const user = await User.findOne({ email }).select("passwordHash").lean();
    return res.json({ exists: !!user, hasPassword: !!user?.passwordHash });
  } catch (e) { console.error("[auth/email/check]", e); return res.status(500).json({ error: "Something went wrong" }); }
});

router.post("/email/login-password", async (req, res) => {
  try {
    const email = String(req.body?.email || "").trim().toLowerCase();
    const password = String(req.body?.password || "");
    if (!email || !password) return res.status(400).json({ error: "Email and password required" });
    const user = await User.findOne({ email });
    if (!user || !user.passwordHash) return res.status(401).json({ error: "Wrong email or password" });
    if (!(await user.verifyPassword(password))) return res.status(401).json({ error: "Wrong email or password" });
    user.lastLogin = new Date(); await user.save();
    req.login(user, (err) => err ? res.status(500).json({ error: "Login failed" }) : res.json({ redirect: redirectForUser(user) }));
  } catch (e) { console.error("[auth/email/login-password]", e); return res.status(500).json({ error: "Login failed" }); }
});

router.post("/email/request-code", async (req, res) => {
  try {
    const email = String(req.body?.email || "").trim().toLowerCase();
    const purpose = req.body?.purpose === "set_password" ? "set_password" : "signin";
    if (!email) return res.status(400).json({ error: "Email required" });
    const user = await User.findOne({ email }).select("_id").lean();
    if (!user) return res.status(404).json({ error: "We couldn't find an account with that email." });
    const code = genCode();
    req.session.emailAuth = { email, code, purpose, userId: String(user._id), expiresAt: Date.now() + 10 * 60 * 1000 };
    const { devCode } = await sendLoginCode(email, code, purpose);
    req.session.save(() => res.json({ ok: true, ...(devCode ? { devCode } : {}) }));
  } catch (e) { console.error("[auth/email/request-code]", e); return res.status(500).json({ error: "Could not send a code" }); }
});

router.post("/email/verify-code", async (req, res) => {
  try {
    const email = String(req.body?.email || "").trim().toLowerCase();
    const code = String(req.body?.code || "").trim();
    const s = readEmailAuth(req);
    if (!s || s.email !== email) return res.status(400).json({ error: "Your code has expired. Request a new one." });
    if (s.code !== code) return res.status(400).json({ error: "That code is not right." });
    const user = await User.findById(s.userId);
    if (!user) return res.status(404).json({ error: "Account not found" });
    user.lastLogin = new Date(); await user.save();
    req.login(user, (err) => {
      if (err) return res.status(500).json({ error: "Login failed" });
      if (!user.passwordHash) { req.session.emailAuth = { ...s, verified: true }; return res.json({ needsPassword: true }); }
      delete req.session.emailAuth;
      return res.json({ redirect: redirectForUser(user) });
    });
  } catch (e) { console.error("[auth/email/verify-code]", e); return res.status(500).json({ error: "Could not verify code" }); }
});

router.post("/email/set-password", ensureAuth, async (req, res) => {
  try {
    const password = String(req.body?.password || "");
    if (password.length < 6) return res.status(400).json({ error: "Use at least 6 characters" });
    const user = await User.findById(req.user._id);
    if (!user) return res.status(404).json({ error: "User not found" });
    await user.setPassword(password); await user.save();
    if (req.session?.emailAuth) delete req.session.emailAuth;
    return res.json({ redirect: redirectForUser(user) });
  } catch (e) { console.error("[auth/email/set-password]", e); return res.status(500).json({ error: "Could not save your password" }); }
});

router.post("/email/reset-password", async (req, res) => {
  try {
    const email = String(req.body?.email || "").trim().toLowerCase();
    const code = String(req.body?.code || "").trim();
    const password = String(req.body?.password || "");
    if (password.length < 6) return res.status(400).json({ error: "Use at least 6 characters" });
    const s = readEmailAuth(req);
    if (!s || s.email !== email) return res.status(400).json({ error: "Your code has expired. Request a new one." });
    if (s.code !== code) return res.status(400).json({ error: "That code is not right." });
    const user = await User.findById(s.userId);
    if (!user) return res.status(404).json({ error: "Account not found" });
    await user.setPassword(password); user.lastLogin = new Date(); await user.save();
    delete req.session.emailAuth;
    req.login(user, (err) => err ? res.status(500).json({ error: "Login failed" }) : res.json({ redirect: redirectForUser(user) }));
  } catch (e) { console.error("[auth/email/reset-password]", e); return res.status(500).json({ error: "Could not reset your password" }); }
});

export default router;