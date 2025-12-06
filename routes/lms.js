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

// DEMO quiz: always 5 questions, global pool
router.get("/quiz", ensureAuth, (req, res) => {
  try {
    return res.render("lms/quiz", {
      user: req.user || null,
      quizCount: 5,                    // 👈 this is important
      module: "Responsibility (demo)", // just a label
      orgSlug: null
    });
  } catch (err) {
    console.error("[lms/quiz] render error:", err && (err.stack || err));
    return res.status(500).send("Failed to render quiz page");
  }
});

export default router;
