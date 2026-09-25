// routes/mobileStudent.js
// ─────────────────────────────────────────────────────────────────────────────
// Student onboarding + grade allocation for the mobile app. Additive — it does
// NOT change the working register flow. After a student signs up (or logs in),
// the app asks for their grade and calls POST /grade, which:
//   • stores the grade,
//   • ensures they're a member of cripfcnt-home (where student quizzes live),
//   • assigns that grade's TRIAL quizzes — the same assignment the web does when
//     a student is created — so the student immediately has quizzes to take.
//
// GET /grades is PUBLIC (used on the sign-up screen before the user has a token).
//
// Mount in server.js:
//    import mobileStudentRouter from "./routes/mobileStudent.js";
//    app.use("/api/mobile/student", mobileStudentRouter);
// ─────────────────────────────────────────────────────────────────────────────
import express, { Router } from "express";
import User from "../models/user.js";
import Organization from "../models/organization.js";
import OrgMembership from "../models/orgMembership.js";
import QuizRule from "../models/quizRule.js";
import { requireMobileAuth } from "./mobileApi.js";
import { assignQuizFromRule } from "../services/quizAssignment.js";

const router = Router();
router.use(express.json({ limit: "256kb" }));

const HOME_ORG_SLUG = "cripfcnt-home";
const gradeLabel = (g) => (Number(g) === 0 ? "ECD" : `Grade ${g}`);

// ── PUBLIC: which grades a student can pick (the ones that actually have quizzes)
router.get("/grades", async (req, res) => {
  try {
    const org = await Organization.findOne({ slug: HOME_ORG_SLUG }).lean();
    if (!org) return res.json({ grades: fallbackGrades(), roles: roleNotes() });

    const raw = await QuizRule.distinct("grade", { org: org._id, enabled: true, grade: { $ne: null } });
    const grades = raw
      .map(Number).filter((g) => Number.isFinite(g)).sort((a, b) => a - b)
      .map((g) => ({ value: g, label: gradeLabel(g) }));

    res.json({ grades: grades.length ? grades : fallbackGrades(), roles: roleNotes() });
  } catch (e) {
    console.error("[student grades]", e);
    res.json({ grades: fallbackGrades(), roles: roleNotes() });
  }
});

function fallbackGrades() {
  return [0, 1, 2, 3, 4, 5, 6, 7].map((g) => ({ value: g, label: gradeLabel(g) }));
}
// Plain-language notes for the sign-up role chooser (the app can show these).
function roleNotes() {
  return [
    { value: "student", title: "Student", note: "I'm a learner. Take quizzes for my grade, track my progress and build my knowledge map." },
    { value: "parent", title: "Parent / Guardian", note: "I'll add my children and follow their learning, quizzes and results." },
    { value: "private_teacher", title: "Private teacher", note: "I teach my own students and manage their quizzes and progress." },
    { value: "employee", title: "Professional", note: "I'm here for the professional courses, assessments and certificates." }
  ];
}

// ── AUTH: set the signed-in student's grade → allocate that grade's quizzes
router.post("/grade", requireMobileAuth, async (req, res) => {
  try {
    const gradeNum = Number(req.body?.grade);
    if (!Number.isFinite(gradeNum) || gradeNum < 0 || gradeNum > 7) {
      return res.status(400).json({ error: "Please choose a valid grade." });
    }

    const user = await User.findById(req.mobileUser._id);
    if (!user) return res.status(404).json({ error: "Account not found." });
    if (user.role !== "student") return res.status(403).json({ error: "Only student accounts set a grade." });

    const org = await Organization.findOne({ slug: HOME_ORG_SLUG }).lean();
    if (!org) return res.status(500).json({ error: "Home learning isn't set up yet." });

    // Store grade + home org (idempotent — safe to call again to change grade)
    user.grade = gradeNum;
    if (!user.organization) user.organization = org._id;
    await user.save();

    await OrgMembership.updateOne(
      { user: user._id, org: org._id },
      { $setOnInsert: { user: user._id, org: org._id, role: "student", active: true, joinedAt: new Date() } },
      { upsert: true }
    );

    // Assign this grade's TRIAL quizzes (mirrors admin_quiz_rules.js student path)
    const rules = await QuizRule.find({ org: org._id, grade: gradeNum, quizType: "trial", enabled: true });
    let assigned = 0;
    for (const rule of rules) {
      try { await assignQuizFromRule({ rule, userId: user._id, orgId: org._id }); assigned++; } catch (_) {}
    }

    res.json({ ok: true, grade: gradeNum, gradeLabel: gradeLabel(gradeNum), quizzesAssigned: assigned });
  } catch (e) {
    console.error("[student set grade]", e);
    res.status(500).json({ error: "Could not set your grade. Please try again." });
  }
});

export default router;