// routes/lms.js
import { Router } from "express";
import { ensureAuth } from "../middleware/authGuard.js";

const router = Router();

router.get("/", (req, res) => {
  try {
    return res.render("lms/index", { user: req.user || null, courses: [] });
  } catch (err) {
    console.error("[lms/] render error:", err && (err.stack || err));
    return res.status(500).send("LMS render error");
  }
});

// /lms/quiz
// - if called as /lms/quiz           -> 5-question global demo
// - if called as /lms/quiz?module=Responsibility&org=muono -> 20-question org quiz
router.get("/quiz", ensureAuth, (req, res) => {
  try {
    const orgSlug = (req.query.org || "").trim() || null;
    const moduleFromQuery = (req.query.module || "").trim();

    const isOrgMode = !!orgSlug && !!moduleFromQuery;

    const quizCount = isOrgMode ? 20 : 5;

    // for display heading on the page
    const moduleLabel = isOrgMode
      ? moduleFromQuery
      : "Responsibility (demo)";

    return res.render("lms/quiz", {
      user: req.user || null,
      quizCount,
      module: moduleLabel, // used for title/description
      orgSlug             // used to decide “org mode” in JS
    });
  } catch (err) {
    console.error("[lms/quiz] render error:", err && (err.stack || err));
    return res.status(500).send("Failed to render quiz page");
  }
});

export default router;
