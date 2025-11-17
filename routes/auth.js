// routes/auth.js
import { Router } from "express";
import passport from "passport";

const router = Router();

// Kick off Google sign-in
router.get("/google", passport.authenticate("google", { scope: ["profile", "email"] }));

// Callback (Google -> our app)
/*router.get(
  "/google/callback",
  passport.authenticate("google", { failureRedirect: "/" }),
  (req, res) => {
    // Successful auth -> redirect to audit page (or wherever)
    res.redirect("/audit");
  }
);*/
router.get(
  "/google/callback",
  passport.authenticate("google", { failureRedirect: "/" }),
  (req, res) => {
    // redirect to saved page or default /audit
    const redirectTo = req.session.returnTo || "/audit";
    delete req.session.returnTo;
    res.redirect(redirectTo);
  }
);


// Sign out
/*router.get("/logout", (req, res) => {
  req.logout?.(err => {
    // some passport versions expect callback
    if (err) console.error("Logout error:", err);
  });
  req.session.destroy(() => {
    res.clearCookie("connect.sid");
    res.redirect("/");
  });
});*/


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
