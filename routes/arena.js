// routes/arena.js
import { Router } from "express";
import { ensureAuth } from "../middleware/authGuard.js";

const router = Router();

/**
 * GET /arena
 * Arena landing page (protected)
 */
router.get("/arena", ensureAuth, (req, res) => {
  return res.render("arena/index", { user: req.user || null });
});

export default router;