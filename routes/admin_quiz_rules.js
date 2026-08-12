import { Router } from "express";
import { ensureAuth } from "../middleware/authGuard.js";
import Organization from "../models/organization.js";
import QuizRule from "../models/quizRule.js";
import Question from "../models/question.js";
import User from "../models/user.js";
import { assignQuizFromRule } from "../services/quizAssignment.js";
import { applyEmployeeQuizRules } from "../services/employeeRuleAssignment.js"; // ✅ NEW (for cripfcnt-school)

const router = Router();

// ----------------------------------
// 🔐 Platform admin email guard
// ----------------------------------
function ensureAdminEmails(req, res, next) {
  const adminSet = new Set(
    (process.env.ADMIN_EMAILS || "")
      .split(",")
      .map(e => e.trim().toLowerCase())
      .filter(Boolean)
  );

  const email = String(req.user?.email || "").toLowerCase();

  if (!adminSet.has(email)) {
    return res.status(403).send("Admins only");
  }

  next();
}

// ----------------------------------
// VIEW QUIZ RULES (HOME + SCHOOL)
// GET /admin/orgs/:slug/quiz-rules
// ----------------------------------
router.get(
  "/admin/orgs/:slug/quiz-rules",
  ensureAuth,
  ensureAdminEmails,
  async (req, res) => {
    const org = await Organization.findOne({ slug: req.params.slug }).lean();
    if (!org) return res.status(404).send("Org not found");

    // ✅ allow only these two orgs
    const allowed = new Set(["cripfcnt-home", "cripfcnt-school"]);
    if (!allowed.has(org.slug)) {
      return res.status(403).send("Not allowed");
    }

    const rules = await QuizRule.find({ org: org._id }).lean();

    // comprehension passages available to this org
    const quizzes = await Question.find({
      type: "comprehension",
      $or: [
        { organization: org._id },
        { organization: { $exists: false } },
        { organization: null }
      ]
    })
      .select("_id text module")
      .lean();

    // You may need a different view later for school,
    // but for now we pass flags so your template can hide grade/subject for school.
    // Real counts for the on-page process/status panel
    const questionsCount = await Question.countDocuments({
      $or: [
        { organization: org._id },
        { organization: { $exists: false } },
        { organization: null }
      ]
    });

    res.render("admin/quiz_rules", {
      org,
      rules,
      quizzes,
      user: req.user,
      isHomeSchool: org.slug === "cripfcnt-home",
      isCripSchool: org.slug === "cripfcnt-school",
      stats: {
        questions: questionsCount,
        passages: quizzes.length,
        rules: rules.length
      }
    });
  }
);

// ----------------------------------
// CREATE QUIZ RULE (HOME + SCHOOL)
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

      // ✅ allow only these two orgs
      const allowed = new Set(["cripfcnt-home", "cripfcnt-school"]);
      if (!allowed.has(org.slug)) {
        return res.status(403).send("Not allowed");
      }

      const {
        grade,
        subject,
        module,
        quizQuestionId,
        quizType,
        questionCount,
        durationMinutes
      } = req.body;

      // Must have at least quiz + type + module for both orgs
   const quizIdsRaw = req.body.quizQuestionId;

// HTML multi-select posts either a string or an array depending on selection count
const quizIds = Array.isArray(quizIdsRaw) ? quizIdsRaw : [quizIdsRaw].filter(Boolean);

if (!quizIds.length || !quizType || !module) {
  return res.status(400).send("Missing fields");
}

// ✅ Validate all quizzes exist
const quizzesFound = await Question.find({ _id: { $in: quizIds } })
  .select("_id text module")
  .lean();

if (quizzesFound.length !== quizIds.length) {
  return res.status(400).send("One or more selected quizzes are invalid");
}


      // ----------------------------------
      // 🏠 PART 1: cripfcnt-home rules (existing behavior)
      // ----------------------------------
     // ----------------------------------
// 🏠 PART 1: cripfcnt-home rules (MULTI-QUIZ FIX)
// ----------------------------------
if (org.slug === "cripfcnt-home") {
  // Grade 0 (ECD) is valid, so check for empty/undefined explicitly - not falsy.
  const gradeMissing = grade === undefined || grade === null || String(grade).trim() === "";
  if (gradeMissing || !subject) {
    return res.status(400).send("Missing fields");
  }

  // ✅ Create ONE rule per selected quiz
  const rules = await QuizRule.insertMany(
    quizzesFound.map(q => ({
      org: org._id,
      grade: Number(grade),
      subject: subject.toLowerCase(),
      module: module.toLowerCase(),
      quizQuestionId: q._id,
      quizTitle: q.text,
      quizType,
      questionCount: Number(questionCount) || 10,
      durationMinutes: Number(durationMinutes) || 30,
      enabled: true
    }))
  );

  // 🔁 Auto-assign TRIAL rules
  if (quizType === "trial") {
    const students = await User.find({
      organization: org._id,
      role: "student",
      grade: Number(grade)
    }).select("_id").lean();

    for (const student of students) {
      for (const rule of rules) {
        await assignQuizFromRule({
          rule,
          userId: student._id,
          orgId: org._id
        });
      }
    }
  }

  // 💳 Apply PAID rules to already-paid parents
  if (quizType === "paid") {
    const paidParents = await User.find({
      subscriptionStatus: "paid"
    }).select("_id").lean();

    for (const parent of paidParents) {
      const children = await User.find({
        parentUserId: parent._id,
        role: "student",
        grade: Number(grade)
      }).select("_id").lean();

      for (const child of children) {
        for (const rule of rules) {
          await assignQuizFromRule({
            rule,
            userId: child._id,
            orgId: org._id,
            force: true
          });
        }
      }
    }
  }

  return res.redirect(`/admin/orgs/${slug}/manage`);
}


      // ----------------------------------
      // 🏫 PART 2: cripfcnt-school employee rules (NO grade/subject)
      // ----------------------------------
   if (org.slug === "cripfcnt-school") {

  // ✅ Create ONE rule per selected quiz
  const rules = await QuizRule.insertMany(
    quizzesFound.map(q => ({
      org: org._id,
      grade: null,
      subject: null,

      module: module.toLowerCase(),
      quizQuestionId: q._id,
      quizTitle: q.text,

      quizType,
      questionCount: Number(questionCount) || 10,
      durationMinutes: Number(durationMinutes) || 30,

      enabled: true
    }))
  );

  // ✅ Immediately apply rules to existing employees
  if (quizType === "trial") {
    const employees = await User.find({ role: "employee" }).select("_id").lean();
    for (const emp of employees) {
      await applyEmployeeQuizRules({
        orgId: org._id,
        userId: emp._id,
        force: false
      });
    }
  }

  if (quizType === "paid") {
    const paidEmployees = await User.find({
      role: "employee",
      employeeSubscriptionStatus: "paid"
    }).select("_id").lean();

    for (const emp of paidEmployees) {
      await applyEmployeeQuizRules({
        orgId: org._id,
        userId: emp._id,
        force: true
      });
    }
  }

  return res.redirect(`/admin/orgs/${slug}/manage`);
}


      // fallback (should never reach)
      return res.status(400).send("Unsupported org");

    } catch (err) {
      console.error("[quiz rule create]", err);
      res.status(500).send("Failed");
    }
  }
);

// ----------------------------------
// TOGGLE a rule enabled/disabled
// POST /admin/orgs/:slug/quiz-rules/:ruleId/toggle
// ----------------------------------
router.post(
  "/admin/orgs/:slug/quiz-rules/:ruleId/toggle",
  ensureAuth,
  ensureAdminEmails,
  async (req, res) => {
    try {
      const org = await Organization.findOne({ slug: req.params.slug });
      if (!org) return res.status(404).send("Org not found");
      const allowed = new Set(["cripfcnt-home", "cripfcnt-school"]);
      if (!allowed.has(org.slug)) return res.status(403).send("Not allowed");

      const rule = await QuizRule.findOne({ _id: req.params.ruleId, org: org._id });
      if (!rule) return res.status(404).send("Rule not found");
      rule.enabled = !rule.enabled;
      await rule.save();

      return res.redirect(`/admin/orgs/${req.params.slug}/quiz-rules`);
    } catch (err) {
      console.error("[quiz rule toggle]", err);
      res.status(500).send("Failed");
    }
  }
);

// ----------------------------------
// DELETE a rule
// POST /admin/orgs/:slug/quiz-rules/:ruleId/delete
// (Only removes the rule; quizzes already assigned to students are untouched.)
// ----------------------------------
router.post(
  "/admin/orgs/:slug/quiz-rules/:ruleId/delete",
  ensureAuth,
  ensureAdminEmails,
  async (req, res) => {
    try {
      const org = await Organization.findOne({ slug: req.params.slug });
      if (!org) return res.status(404).send("Org not found");
      const allowed = new Set(["cripfcnt-home", "cripfcnt-school"]);
      if (!allowed.has(org.slug)) return res.status(403).send("Not allowed");

      await QuizRule.deleteOne({ _id: req.params.ruleId, org: org._id });
      return res.redirect(`/admin/orgs/${req.params.slug}/quiz-rules`);
    } catch (err) {
      console.error("[quiz rule delete]", err);
      res.status(500).send("Failed");
    }
  }
);

export default router;