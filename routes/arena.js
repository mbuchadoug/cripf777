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

router.get("/arena/lobby", ensureAuth, async (req, res) => {
  const battleId = String(req.query.battleId || "").trim();
  if (!battleId) return res.redirect("/arena");

  res.render("arena/lobby", {
    user: req.user,
    battleId
  });
});

export default router;