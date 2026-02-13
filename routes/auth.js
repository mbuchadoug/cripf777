// routes/auth.js - CORRECTED VERSION (no /start conflict)
import { Router } from "express";
import passport from "passport";
import Organization from "../models/organization.js";
import OrgMembership from "../models/orgMembership.js";
import crypto from "crypto";
import ExamInstance from "../models/examInstance.js";
import Question from "../models/question.js";
import { ensureAuth } from "../middleware/authGuard.js";
import User from "../models/user.js";

const router = Router();

// Helper functions for safe returnTo handling
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
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  } catch {
    return "";
  }
}

function decodeState(state) {
  try {
    if (!state || typeof state !== "string") return null;
    const base64 =
      state.replace(/-/g, "+").replace(/_/g, "/") +
      "==".slice((2 - state.length * 3) & 3);
    return Buffer.from(base64, "base64").toString("utf8");
  } catch {
    return null;
  }
}

/* ================================================================== */
/*  ✅ PARENT SIGNUP ROUTE (renamed from /start to avoid conflict)    */
/* ================================================================== */
router.get("/parent", (req, res) => {
  req.session.signupSource = "parent";   // ✅ MARK AS PARENT FLOW
  res.redirect("/auth/google");
});

/**
 * GET /auth/google
 */
router.get("/google", (req, res, next) => {
  try {
    let candidate = null;

    if (req.query?.returnTo) candidate = String(req.query.returnTo);
    else if (req.session?.returnTo) candidate = String(req.session.returnTo);
    else {
      const ref = req.get("referer");
      if (ref) {
        try {
          const u = new URL(ref);
          candidate = (u.pathname || "/") + (u.search || "");
        } catch {}
      }
    }

    const safe = safeReturnTo(candidate) || null;

    if (safe && req.session) {
      req.session.returnTo = safe;
      if (typeof req.session.save === "function") {
        req.session.save(() => {
          const state = encodeState(safe);
          return passport.authenticate("google", {
            scope: ["profile", "email"],
            state
          })(req, res, next);
        });
        return;
      }
    }

    const state = encodeState(safe);
    return passport.authenticate("google", {
      scope: ["profile", "email"],
      state
    })(req, res, next);
  } catch {
    return passport.authenticate("google", {
      scope: ["profile", "email"]
    })(req, res, next);
  }
});

/**
 * GET /auth/google/callback
 */
router.get(
  "/google/callback",
  passport.authenticate("google", { failureRedirect: "/" }),
  async (req, res) => {
    try {
      const rawState = req.query?.state ? String(req.query.state) : null;
      const decoded = rawState ? decodeState(rawState) : null;

      const fromState = decoded && safeReturnTo(decoded) ? decoded : null;
      const fromSession =
        req.session?.returnTo ? safeReturnTo(req.session.returnTo) : null;

      if (req.session) {
        try { delete req.session.returnTo; } catch {}
      }

      const defaultOrgSlug = "cripfcnt-school";
      let redirectPath = null;

      // 1️⃣ Respect explicit return paths first
      if (fromState || fromSession) {
        redirectPath = fromState || fromSession;
      } else {
const memberships = await OrgMembership
  .find({ user: req.user._id })
  .populate("org")
  .lean();

// ✅ Redirect by signup flow (parent vs employee), not by req.user.role
const isParentFlow = req.session?.signupSource === "parent";

if (isParentFlow) {
  redirectPath = "/parent/dashboard";
} else if (memberships.length > 0 && memberships[0].org?.slug) {
  redirectPath = `/org/${memberships[0].org.slug}/dashboard`;
} 
        else {
          // 3️⃣ New user → auto-enrol into default org
          const org = await Organization.findOne({ slug: defaultOrgSlug }).lean();
          if (org) {
            await OrgMembership.create({
              org: org._id,
              user: req.user._id,
              role: "employee",
              joinedAt: new Date(),
              isOnboardingComplete: false
            });

            if (req.session) {
              req.session.isFirstLogin = true;
            }

            redirectPath = `/org/${defaultOrgSlug}/dashboard`;
          }
          else {
            redirectPath = "/";
          }
        }
      }

      console.log("[/auth/google/callback] redirecting to:", redirectPath);

      return res.redirect(redirectPath);
    } catch (e) {
      console.error("[/auth/google/callback] redirect error:", e.message);
      return res.redirect("/audit");
    }
  }
);

/* ================================================================== */
/*  STUDENT LOGIN ROUTES                                              */
/* ================================================================== */

router.get("/student", (req, res) => {
  res.render("auth/student_login");
});

router.post("/student", async (req, res) => {
  try {
    const { studentId, password } = req.body;

    const user = await User.findOne({
      studentId,
      role: "student"
    });

    if (!user) {
      return res.status(401).send("Invalid student ID");
    }

    const ok = await user.verifyPassword(password);
    if (!ok) {
      return res.status(401).send("Invalid password");
    }

    user.lastLogin = new Date();
    await user.save();

    req.login(user, async err => {
      if (err) return res.status(500).send("Login failed");

      const membership = await OrgMembership
        .findOne({ user: user._id })
        .populate("org")
        .lean();

      if (!membership || !membership.org?.slug) {
        return res.status(403).send("No organization assigned");
      }

     // ✅ If this is a student logging in from /auth/school, send them to the new dashboard
if (user.role === "student") {
  return res.redirect("/student/dashboard");
}

// teachers/admins/employees keep the org dashboard
return res.redirect(`/org/${membership.org.slug}/dashboard`);

    });
  } catch (e) {
    console.error("[student login]", e);
    res.status(500).send("Login failed");
  }
});

/* ================================================================== */
/*  SCHOOL LOGIN ROUTES                                               */
/* ================================================================== */

router.get("/school", (req, res) => {
  res.render("auth/school_login", { error: null });
});

router.post("/school", async (req, res) => {
  try {
    const { loginId, password } = req.body;

    if (!loginId || !password) {
      return res.render("auth/school_login", {
        error: "Please enter your ID and password"
      });
    }

    const user = await User.findOne({
      $or: [
        { studentId: loginId },
        { teacherId: loginId },
        { adminId: loginId }
      ]
    });

    if (!user) {
      return res.render("auth/school_login", {
        error: "Invalid ID or password"
      });
    }

    const ok = await user.verifyPassword(password);
    if (!ok) {
      return res.render("auth/school_login", {
        error: "Invalid ID or password"
      });
    }

    user.lastLogin = new Date();
    await user.save();

    req.login(user, async err => {
      if (err) {
        console.error(err);
        return res.render("auth/school_login", {
          error: "Login failed"
        });
      }

      const membership = await OrgMembership
        .findOne({ user: user._id })
        .populate("org")
        .lean();

      if (!membership || !membership.org?.slug) {
        return res.render("auth/school_login", {
          error: "No school assigned to this account"
        });
      }

    // ✅ If this is a student logging in from /auth/school, send them to the new dashboard
if (user.role === "student") {
  return res.redirect("/student/dashboard");
}

// teachers/admins/employees keep the org dashboard
return res.redirect(`/org/${membership.org.slug}/dashboard`);

    });
  } catch (e) {
    console.error("[school login]", e);
    res.render("auth/school_login", {
      error: "Unexpected error occurred"
    });
  }
});

/* ================================================================== */
/*  LOGOUT                                                            */
/* ================================================================== */

router.get("/logout", (req, res, next) => {
  const role = req.user?.role;

  req.logout(function (err) {
    if (err) return next(err);

    req.session.destroy(() => {
      res.clearCookie("connect.sid");

      if (role === "student" || role === "teacher" || role === "admin") {
        return res.redirect("/auth/school");
      }

      return res.redirect("/");
    });
  });
});

/* ================================================================== */
/*  ADMIN HELPER - CREATE PARENT                                      */
/* ================================================================== */

router.post("/admin/create-parent", ensureAuth, async (req, res) => {
  if (!["admin", "employee"].includes(req.user.role)) {
    return res.status(403).send("Not allowed");
  }

  const { email, firstName, lastName } = req.body;

  if (!email || !firstName) {
    return res.status(400).send("Missing required fields");
  }

  const existing = await User.findOne({ email: email.toLowerCase() });
  if (existing) {
    return res.status(400).send("User already exists");
  }

  const parent = await User.create({
    email: email.toLowerCase(),
    firstName,
    lastName,
    role: "parent",
    accountType: "parent",
    consumerEnabled: true,
    createdAt: new Date()
  });

  return res.json({
    success: true,
    parentId: parent._id
  });
});

export default router;