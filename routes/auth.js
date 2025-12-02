// routes/auth.js
import { Router } from "express";
import passport from "passport";

const router = Router();

function safeReturnTo(candidate) {
  if (!candidate || typeof candidate !== "string") return null;
  const decoded = decodeURIComponent(candidate).trim();
  if (!decoded.startsWith("/")) return null;
  if (decoded.startsWith("//")) return null;
  if (decoded.length > 2048) return null;
  // optional block of sensitive paths
  if (decoded.startsWith("/auth") || decoded.startsWith("/logout")) return null;
  return decoded;
}

// Step 1: when someone visits /auth/google we accept ?returnTo= and persist it to session before calling passport
router.get("/google", (req, res, next) => {
  try {
    const candidate = req.query && req.query.returnTo ? String(req.query.returnTo) : null;
    if (candidate) {
      const safe = safeReturnTo(candidate);
      if (safe && req.session) {
        req.session.returnTo = safe;
      }
    }
    // If no query param but session already has returnTo (e.g. set by ensureAuth) we keep it.
    // Save session now to guarantee persistence before passport redirects to Google.
    if (req.session && typeof req.session.save === "function") {
      req.session.save((err) => {
        if (err) console.warn("[/auth/google] session.save err:", err && err.message);
        return passport.authenticate("google", { scope: ["profile", "email"] })(req, res, next);
      });
    } else {
      // no session.save available — continue
      return passport.authenticate("google", { scope: ["profile", "email"] })(req, res, next);
    }
  } catch (e) {
    console.warn("[/auth/google] error:", e && e.message);
    return passport.authenticate("google", { scope: ["profile", "email"] })(req, res, next);
  }
});

// Callback: authenticate then redirect to saved path. Log session for debugging.
router.get(
  "/google/callback",
  passport.authenticate("google", { failureRedirect: "/" }),
  (req, res) => {
    try {
      // Debug: log session (remove in production)
      try {
        console.log("[/auth/google/callback] session:", {
          id: req.sessionID,
          returnTo: req.session ? req.session.returnTo : undefined,
          cookies: req.headers.cookie,
        });
      } catch (e) { /* ignore logging errors */ }

      const raw = (req.session && req.session.returnTo) ? req.session.returnTo : null;
      if (req.session) delete req.session.returnTo;
      const safe = safeReturnTo(raw) || "/audit";
      return res.redirect(safe);
    } catch (e) {
      console.error("[/auth/google/callback] redirect error:", e && e.message);
      return res.redirect("/audit");
    }
  }
);

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
