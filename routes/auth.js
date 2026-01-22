// routes/auth.js
import { Router } from "express";
import passport from "passport";
import Organization from "../models/organization.js";
import OrgMembership from "../models/orgMembership.js";
import User from "../models/user.js";
import crypto from "crypto";
import ExamInstance from "../models/examInstance.js";
import Question from "../models/question.js";


const router = Router();

// small helper to ensure returnTo is a safe same-origin path
function safeReturnTo(candidate) {
  if (!candidate || typeof candidate !== "string") return null;
  const decoded = decodeURIComponent(candidate).trim();
  if (!decoded.startsWith("/")) return null;
  if (decoded.startsWith("//")) return null;
  if (decoded.length > 2048) return null;
  if (decoded.startsWith("/auth") || decoded.startsWith("/logout")) return null;
  return decoded;
}

// encode/decode for the state param — use base64url of the path only (no secrets)
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


// ======================================================
// 🧠 Assign 5 onboarding quizzes to first-time users
// ======================================================


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
        // 2️⃣ Check if user already belongs to an org
        const memberships = await OrgMembership
          .find({ user: req.user._id })
          .populate("org")
          .lean();

        if (memberships.length > 0 && memberships[0].org?.slug) {
          // Existing user → their org dashboard
          redirectPath = `/org/${memberships[0].org.slug}/dashboard`;
        } else {
          // 3️⃣ New user → auto-enrol into default org
          const org = await Organization.findOne({ slug: defaultOrgSlug }).lean();
if (org) {
await OrgMembership.create({
  org: org._id,
  user: req.user._id,
  role: "employee",
  joinedAt: new Date(),
  isOnboardingComplete: false // 🔐 LOCK DOWN
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


router.get("/student", (req, res) => {
  res.render("auth/student_login");
});


router.post("/student", async (req, res) => {
  try {
    const { studentId, password } = req.body;

    // Find student by ID
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

    // Login session
    req.login(user, async err => {
      if (err) return res.status(500).send("Login failed");

      // Find org membership for redirect
      const membership = await OrgMembership
        .findOne({ user: user._id })
        .populate("org")
        .lean();

      if (!membership || !membership.org?.slug) {
        return res.status(403).send("No organization assigned");
      }

      res.redirect(`/org/${membership.org.slug}/dashboard`);
    });
  } catch (e) {
    console.error("[student login]", e);
    res.status(500).send("Login failed");
  }
});


// Logout
/*router.get("/logout", (req, res, next) => {
  req.logout(function (err) {
    if (err) return next(err);
    req.session.destroy(() => {
      res.clearCookie("connect.sid");
      res.redirect("/");
    });
  });
});*/


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

    // 🔍 Find user by ANY school-issued ID
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

    // 🔐 Verify password
    const ok = await user.verifyPassword(password);
    if (!ok) {
      return res.render("auth/school_login", {
        error: "Invalid ID or password"
      });
    }

    user.lastLogin = new Date();
    await user.save();

    // ✅ Create login session
    req.login(user, async err => {
      if (err) {
        console.error(err);
        return res.render("auth/school_login", {
          error: "Login failed"
        });
      }

      // 🔗 Get org membership
      const membership = await OrgMembership
        .findOne({ user: user._id })
        .populate("org")
        .lean();

      if (!membership || !membership.org?.slug) {
        return res.render("auth/school_login", {
          error: "No school assigned to this account"
        });
      }

      // 🚦 Role-based redirect
  const orgSlug = membership.org.slug;
const memberRole = String(membership.role || "").toLowerCase();

// 🎓 SCHOOL ORG LOGIC
return res.redirect(`/org/${membership.org.slug}/dashboard`);


// 🏢 NON-SCHOOL ORG LOGIC (fallback)


//return res.redirect(`/org/${orgSlug}/dashboard`);

    });
  } catch (e) {
    console.error("[school login]", e);
    res.render("auth/school_login", {
      error: "Unexpected error occurred"
    });
  }
});



router.get("/logout", (req, res, next) => {
  const role = req.user?.role; // capture role before logout

  req.logout(function (err) {
    if (err) return next(err);

    req.session.destroy(() => {
      res.clearCookie("connect.sid");

      // 🎓 Students go to student login
      if (role === "student") {
        return res.redirect("/auth/school");
      }else if(role == "teacher"){
        return res.redirect("/auth/school");
      } else if(role == "admin"){
        return res.redirect("/auth/school");
      }

      // 👨‍🏫 Others go home
      return res.redirect("/");
    });
  });
});
export default router;
