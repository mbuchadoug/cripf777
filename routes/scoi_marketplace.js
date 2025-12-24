import { Router } from "express";
const router = Router();

router.get("/scoi", (req, res) => {
  res.render("scoi/marketplace", {
    user: req.user || null
  });
});

export default router;
