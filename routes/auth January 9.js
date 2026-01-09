// routes/auth.js
import { Router } from "express";
import passport from "passport";
import Organization from "../models/organization.js";
import OrgMembership from "../models/orgMembership.js";
import User from "../models/user.js";

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
              joinedAt: new Date()
            });

            if (req.session) {
              req.session.isFirstLogin = true;
            }

            redirectPath = `/org/${defaultOrgSlug}/dashboard`;
          } else {
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
  const { schoolCode, studentId } = req.body;

  const org = await Organization.findOne({ slug: schoolCode }).lean();
  if (!org) return res.status(400).send("Invalid school code");

  const user = await User.findOne({
    organization: org._id,
    studentId,
    role: "student"
  });

  if (!user) return res.status(401).send("Invalid student ID");

  req.login(user, err => {
    if (err) return res.status(500).send("Login failed");
    res.redirect(`/org/${org.slug}/dashboard`);
  });
});

// Logout
router.get("/logout", (req, res, next) => {
  req.logout(function (err) {
    if (err) return next(err);
    req.session.destroy(() => {
      res.clearCookie("connect.sid");
      res.redirect("/");
    });
  });
});

export default router;
