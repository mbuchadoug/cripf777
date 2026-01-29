import { Router } from "express";
import { ensureAuth } from "../middleware/authGuard.js";
import Organization from "../models/organization.js";
import QuizRule from "../models/quizRule.js";

const router = Router();

// ----------------------------------
// VIEW QUIZ RULES (HOME SCHOOL ONLY)
// GET /admin/orgs/:slug/quiz-rules
// ----------------------------------
router.get(
  "/admin/orgs/:slug/quiz-rules",
  ensureAuth,
  async (req, res) => {
    const org = await Organization.findOne({ slug: req.params.slug }).lean();
    if (!org) return res.status(404).send("Org not found");

    // 🔒 HARD LOCK
    if (org.slug !== "cripfcnt-home") {
      return res.status(403).send("Not allowed");
    }

    const rules = await QuizRule.find({ org: org._id }).lean();

    res.render("admin/quiz_rules", {
      org,
      rules,
      user: req.user
    });
  }
);

// ----------------------------------
// CREATE QUIZ RULE (HOME SCHOOL ONLY)
// POST /admin/orgs/:slug/quiz-rules
// ----------------------------------
router.post(
  "/admin/orgs/:slug/quiz-rules",
  ensureAuth,
  async (req, res) => {
    const { grade, subject, title, isTrial } = req.body;

    const org = await Organization.findOne({ slug: req.params.slug });
    if (!org) return res.status(404).send("Org not found");

    // 🔒 HARD LOCK
    if (org.slug !== "cripfcnt-home") {
      return res.status(403).send("Not allowed");
    }

   //const { grade, subject, title, isTrial } = req.body;

await QuizRule.create({
  org: org._id,
  grade: Number(grade),
  subject,
  title,
  isTrial: isTrial !== "false"   // true by default
});


    res.redirect(`/admin/orgs/${org.slug}/quiz-rules`);
  }
);

export default router;
