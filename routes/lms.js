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

// QUIZ UI page
router.get("/quiz", ensureAuth, (req, res) => {
  try {
    const moduleName = req.query.module || "General";
    const org = req.query.org || null;
    return res.render("lms/quiz", {
      user: req.user || null,
      module: moduleName,
      org,
    });
  } catch (err) {
    console.error("[lms/quiz] render error:", err && (err.stack || err));
    return res.status(500).send("Failed to render quiz page");
  }
});

export default router;
