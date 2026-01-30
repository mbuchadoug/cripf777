import { Router } from "express";
import { ensureAuth } from "../middleware/authGuard.js";
import Organization from "../models/organization.js";
import QuizRule from "../models/quizRule.js";
import Question from "../models/question.js";

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
const quizzes = await Question.find({
  organization: org._id,
  type: "comprehension"
})
.select("_id text module")
.lean();

res.render("admin/quiz_rules", {
  org,
  rules,
  quizzes,
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
  ensureAdminEmails,
  async (req, res) => {
    try {
      const slug = req.params.slug;
      const org = await Organization.findOne({ slug });
      if (!org) return res.status(404).send("Org not found");

      const {
        grade,
        module,
        quizTitle,
        quizType,
        questionCount,
        durationMinutes
      } = req.body;

      if (!grade || !module || !quizTitle || !quizType) {
        return res.status(400).send("Missing fields");
      }

      await QuizRule.create({
        org: org._id,
        grade: Number(grade),
        module: module.toLowerCase(),
        quizTitle: quizTitle.trim(),
        quizType,
        questionCount: Number(questionCount) || 10,
        durationMinutes: Number(durationMinutes) || 30
      });

      res.redirect(`/admin/orgs/${slug}/manage`);
    } catch (err) {
      console.error("[quiz rule create]", err);
      res.status(500).send("Failed");
    }
  }
);



router.post(
  "/admin/orgs/:slug/quiz-rules/:ruleId/apply",
  ensureAuth,
  ensureAdminEmails,
  async (req, res) => {
    try {
      const { slug, ruleId } = req.params;

      const org = await Organization.findOne({ slug });
      if (!org) return res.status(404).send("Org not found");

      const rule = await QuizRule.findById(ruleId);
      if (!rule || !rule.enabled) {
        return res.status(404).send("Rule not found");
      }

      const students = await User.find({
        organization: org._id,
        role: "student",
        grade: rule.grade
      });

      for (const student of students) {
        await assignQuizFromRule({
          rule,
          userId: student._id,
          orgId: org._id
        });
      }

      res.redirect(`/admin/orgs/${slug}/manage`);
    } catch (err) {
      console.error("[apply quiz rule]", err);
      res.status(500).send("Failed");
    }
  }
);


export default router;
