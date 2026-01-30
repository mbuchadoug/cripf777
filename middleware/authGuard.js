import Organization from "../models/organization.js";
import { syncQuizRulesForUser } from "../services/quizRuleSync.js";


// middleware/authGuard.js
export async function ensureAuth(req, res, next) {
  try {
    if (req.isAuthenticated && req.isAuthenticated()) {

      // 🔁 AUTO-SYNC HOME LEARNING QUIZZES
      if (req.user.role === "student" && req.user.grade) {
        const homeOrg = await Organization.findOne({
          slug: "cripfcnt-home"
        }).lean();

        if (homeOrg) {
          await syncQuizRulesForUser({
            orgId: homeOrg._id,
            userId: req.user._id,
            grade: req.user.grade
          });
        }
      }

      return next();
    }

    // ---------- NOT AUTHENTICATED ----------
    const dest = String(req.originalUrl || req.url || "/");

    if (req.session) {
      try {
        req.session.returnTo = dest;
      } catch (e) {
        console.warn("[ensureAuth] failed to set returnTo:", e?.message);
      }
    }

    const encoded = encodeURIComponent(dest);
    return res.redirect(`/auth/google?returnTo=${encoded}`);
  } catch (err) {
    console.warn("[ensureAuth] unexpected error:", err?.message);
    return res.redirect("/auth/google");
  }
}
