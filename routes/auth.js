// routes/auth.js
import { Router } from "express";
import passport from "passport";
import Organization from "../models/organization.js";
import OrgMembership from "../models/orgMembership.js";

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
    const b = Buffer.from(returnTo, "utf8")
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    return b;
  } catch (e) {
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
  } catch (e) {
    return null;
  }
}

/**
 * GET /auth/google
 */
router.get("/google", (req, res, next) => {
  try {
    let candidate = null;
    if (req.query && req.query.returnTo) candidate = String(req.query.returnTo);
    else if (req.session && req.session.returnTo) candidate = String(req.session.returnTo);
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
  } catch (e) {
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

      // =======================
      // 🔹 NEW: AUTO ORG MEMBERSHIP
      // =======================
      try {
        const org = await Organization.findOne({ slug: defaultOrgSlug }).lean();

        if (org && req.user?._id) {
          const existing = await OrgMembership.findOne({
            org: org._id,
            user: req.user._id
          });

          if (!existing) {
            await OrgMembership.create({
              org: org._id,
              user: req.user._id,
              role: "employee",
              joinedAt: new Date()
            });

            // mark first login (for welcome banner)
            if (req.session) {
              req.session.isFirstLogin = true;
            }
          }
        }
      } catch (e) {
        console.error("[auth] auto org membership failed:", e.message);
      }
      // =======================

      const final =
        fromState ||
        fromSession ||
        `/org/${defaultOrgSlug}/dashboard`;

      console.log("[/auth/google/callback] redirecting to:", final);

      return res.redirect(final);
    } catch (e) {
      console.error("[/auth/google/callback] redirect error:", e.message);
      return res.redirect("/audit");
    }
  }
);

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
