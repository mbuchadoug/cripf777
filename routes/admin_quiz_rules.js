import { Router } from "express";
import { ensureAuth } from "../middleware/authGuard.js";
import Organization from "../models/organization.js";
import QuizRule from "../models/quizRule.js";

const router = Router();

router.get(
  "/admin/orgs/:slug/quiz-rules",
  ensureAuth,
  async (req, res) => {
    const org = await Organization.findOne({ slug: req.params.slug }).lean();
    if (!org) return res.status(404).send("Org not found");

    const rules = await QuizRule.find({ org: org._id }).lean();

    res.render("admin/quiz_rules", {
      org,
      rules,
      user: req.user
    });
  }
);

router.post(
  "/admin/orgs/:slug/quiz-rules",
  ensureAuth,
  async (req, res) => {
    const { grade, subject, title } = req.body;

    const org = await Organization.findOne({ slug: req.params.slug });
    if (!org) return res.status(404).send("Org not found");

    await QuizRule.create({
      org: org._id,
      grade: Number(grade),
      subject,
      title,
      isTrial: true
    });

    res.redirect(`/admin/orgs/${org.slug}/quiz-rules`);
  }
);

export default router;
