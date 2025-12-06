// routes/lms.js
import { Router } from "express";
import { ensureAuth } from "../middleware/authGuard.js";

const router = Router();

// LMS home
router.get("/", (req, res) => {
  try {
    return res.render("lms/index", { user: req.user || null, courses: [] });
  } catch (err) {
    console.error("[lms/] render error:", err && (err.stack || err));
    return res.status(500).send("LMS render error");
  }
});

// QUIZ UI (demo OR org, same page)
/*router.get("/quiz", ensureAuth, (req, res) => {
  try {
    const rawModule = String(req.query.module || "Responsibility").trim();
    const moduleKey = rawModule.toLowerCase();
    const orgSlug = String(req.query.org || "").trim();

    const isOrg = !!orgSlug;
    const quizCount = isOrg ? 20 : 5; // 👈 20 for org, 5 for demo

    const displayModule = isOrg ? rawModule : `${rawModule} (demo)`;

    return res.render("lms/quiz", {
      user: req.user || null,
      quizCount,          // number of questions UI should load
      displayModule,      // text used in the heading
      moduleKey,          // lower-cased key used for DB filter
      orgSlug,            // org slug (or empty)
      isOrg               // boolean flag
    });
  } catch (err) {
    console.error("[lms/quiz] render error:", err && (err.stack || err));
    return res.status(500).send("Failed to render quiz page");
  }
});*/

// DEMO quiz: always 5 questions, global pool
router.get("/quiz", ensureAuth, (req, res) => {
  try {
    return res.render("lms/quiz", {
      user: req.user || null,
      quizCount: 5,                    // 👈 demo = 5
      module: "Responsibility (demo)", // label only
      orgSlug: "",                     // no org
    });
  } catch (err) {
    console.error("[lms/quiz] render error:", err && (err.stack || err));
    return res.status(500).send("Failed to render quiz page");
  }
});


export default router;
