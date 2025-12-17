import { Router } from "express";
import Certificate from "../models/certificate.js";
import User from "../models/user.js";

const router = Router();

router.get("/certificates/:serial", async (req, res) => {
  const serial = req.params.serial;

  const cert = await Certificate
    .findOne({ serial })
    .populate("userId")
    .lean();

  if (!cert) return res.status(404).send("Certificate not found");

  return res.render("certificates/view", {
    cert,
    user: cert.userId
  });
});

export default router;
