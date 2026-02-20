import { Router } from "express";
import CreatorCampaign from "../models/creatorCampaign.js";
import { ensureAuth } from "../middleware/authGuard.js";
import crypto from "crypto";

const router = Router();

/**
 * POST /teacher/campaigns
 * Create new public creator campaign
 */
router.post("/teacher/campaigns", ensureAuth, async (req, res) => {
  try {
    if (req.user.role !== "private_teacher") {
      return res.status(403).json({ error: "Only teachers can create campaigns" });
    }

   const { title, aiQuizId, durationMinutes } = req.body;


    if (!title || !aiQuizId) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const dur = Number(durationMinutes);

if (!dur || dur < 1 || dur > 180) {
  return res.status(400).json({ error: "Duration must be between 1 and 180 minutes" });
}


    // Generate professional unique slug
    const baseSlug = title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "");

    const unique = crypto.randomBytes(3).toString("hex");

    const slug = `${baseSlug}-${unique}`;

    const campaign = await CreatorCampaign.create({
      title,
      slug,
      status: "active",
      aiQuizId,
      creatorId: req.user._id,
      settings: {
        requireName: true,
        requireGrade: true,
        requirePhone: false,
        showLeaderboard: true,
        showAnswersAfterSubmit: true,
        durationMinutes: dur // ✅ NEW
      },
      createdAt: new Date(),
      updatedAt: new Date()
    });

    return res.json({
      success: true,
      campaignId: campaign._id,
      slug: campaign.slug,
      shareUrl: `${process.env.SITE_URL}/c/${campaign.slug}/start`
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to create campaign" });
  }
});

export default router;
