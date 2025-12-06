// routes/lms.js
import { Router } from "express";
import { ensureAuth } from "../middleware/authGuard.js";
const router = Router();

// simple landing page
router.get("/", (req, res) => {
  try {
    return res.render("lms/index", { user: req.user || null, courses: [] });
  } catch (err) {
    console.error("[lms/] render error:", err && (err.stack || err));
    return res.status(500).send("LMS render error");
  }
});

// DEMO quiz: 5 questions, global pool
router.get("/quiz", ensureAuth, (req, res) => {
  try {
    return res.render("lms/quiz", {
      user: req.user || null,
      quizCount: 5,                // <= 5 questions
      moduleLabel: "Responsibility (demo) — Quick Quiz",
      moduleKey: "",               // no module filter
      orgSlug: "",                 // no org filter
    });
  } catch (err) {
    console.error("[lms/quiz] render error:", err && (err.stack || err));
    return res.status(500).send("Failed to render quiz page");
  }
});

export default router;
