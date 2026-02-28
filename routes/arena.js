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


router.get("/arena/results", ensureAuth, async (req, res) => {
  const battleId = String(req.query.battleId || "");
  if (!battleId) return res.redirect("/arena");
  return res.render("arena/results", { user: req.user, battleId });
});




router.get("/arena/paynow/poll", ensureAuth, async (req, res) => {
  try {
    const reference = String(req.query.reference || "").trim();
    if (!reference) return res.status(400).json({ error: "Missing reference" });

    const payment = await Payment.findOne({ reference, userId: req.user._id });
    if (!payment) return res.status(404).json({ error: "Payment not found" });

    // If already marked paid, return fast
    if (payment.status === "paid") return res.json({ success: true, status: "paid" });

    const status = await paynow.pollTransaction(payment.pollUrl);

    const st = String(status.status || "").toLowerCase();

    if (st === "paid") {
      payment.status = "paid";
      payment.paidAt = new Date();
      await payment.save();

      // unlock entry
      await BattleEntry.updateOne(
        { battleId: payment.battleId, userId: payment.userId },
        { $set: { status: "paid", paidAt: new Date() } }
      );

      return res.json({ success: true, status: "paid" });
    }

    if (st === "failed") {
      payment.status = "failed";
      await payment.save();
      return res.json({ success: true, status: "failed" });
    }

    return res.json({ success: true, status: "pending" });
  } catch (e) {
    console.error("[arena poll] error", e);
    return res.status(500).json({ error: "Poll error" });
  }
});
export default router;