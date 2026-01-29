import { Router } from "express";
import { ensureAuth } from "../middleware/authGuard.js";
import QuizRule from "../models/quizRule.js";
import Organization from "../models/organization.js";

const router = Router();

/* ------------------------------
   LIST RULES
   GET /admin/quiz-rules
-------------------------------- */
router.get("/admin/quiz-rules", ensureAuth, async (req, res) => {
  const rules = await QuizRule.find()
    .sort({ grade: 1, subject: 1 })
    .lean();

  res.render("admin/quiz_rules", {
    user: req.user,
    rules
  });
});

/* ------------------------------
   CREATE RULE
   POST /admin/quiz-rules
-------------------------------- */
router.post("/admin/quiz-rules", ensureAuth, async (req, res) => {
  const {
    grade,
    subject,
    type,
    questionSource,
    module,
    passageId,
    count,
    durationMinutes
  } = req.body;

  await QuizRule.create({
    grade: Number(grade),
    subject,
    type,
    questionSource,
    module: questionSource === "module" ? module : null,
    passageId: questionSource === "passage" ? passageId : null,
    count: Number(count),
    durationMinutes: Number(durationMinutes)
  });

  res.redirect("/admin/quiz-rules");
});

/* ------------------------------
   TOGGLE ACTIVE
   POST /admin/quiz-rules/:id/toggle
-------------------------------- */
router.post("/admin/quiz-rules/:id/toggle", ensureAuth, async (req, res) => {
  const rule = await QuizRule.findById(req.params.id);
  if (!rule) return res.status(404).send("Not found");

  rule.active = !rule.active;
  await rule.save();

  res.redirect("/admin/quiz-rules");
});

export default router;
