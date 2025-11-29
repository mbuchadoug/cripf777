// routes/lms.js
import { Router } from "express";
const router = Router();

// Home (optional) — renders views/lms/index.hbs if present
router.get("/", (req, res) => {
  try {
    return res.render("lms/index", { user: req.user || null, courses: [] });
  } catch (err) {
    console.error("[lms/] render error:", err && (err.stack || err));
    return res.status(500).send("LMS render error");
  }
});

// QUIZ UI page
router.get("/quiz", (req, res) => {
  try {
    return res.render("lms/quiz", { user: req.user || null });
  } catch (err) {
    console.error("[lms/quiz] render error:", err && (err.stack || err));
    return res.status(500).send("Failed to render quiz page");
  }
});

export default router;
