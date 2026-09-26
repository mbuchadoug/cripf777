// routes/mobileStudent.js
// ─────────────────────────────────────────────────────────────────────────────
// Student onboarding + grade allocation for the mobile app. Additive — it does
// NOT change the working register flow.
//
//   GET  /grades  (public)  — the full grade list (0–13), matching the web's
//                             parent "add child" form. Always returns a list.
//   POST /grade   (auth)    — set the signed-in student's grade, ensure their
//                             cripfcnt-home membership, and assign that grade's
//                             trial quizzes (same as the web does on student
//                             create). Works for brand-new AND already-registered
//                             students who never picked a grade.
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
const MIN_GRADE = 0;
const MAX_GRADE = 13;

// Labels match the web parent form exactly: Grade 0–7, then Form 1–6 (8–13).
function gradeLabel(g) {
  g = Number(g);
  return g <= 7 ? `Grade ${g}` : `Form ${g - 7}`;
}
function gradeCategory(g) {
  g = Number(g);
  return g === 0 ? "Early years" : g <= 7 ? "Primary" : "Secondary";
}
// The full, fixed list — never depends on whether quiz rules exist yet.
function allGrades() {
  const out = [];
  for (let g = MIN_GRADE; g <= MAX_GRADE; g++) {
    out.push({ value: g, label: gradeLabel(g), category: gradeCategory(g) });
  }
  return out;
}
function roleNotes() {
  return [
    { value: "student", title: "Student", note: "I'm a learner. Take quizzes for my grade, track my progress and build my knowledge map." },
    { value: "parent", title: "Parent / Guardian", note: "I'll add my children and follow their learning, quizzes and results." },
    { value: "private_teacher", title: "Private teacher", note: "I teach my own students and manage their quizzes and progress." },
    { value: "employee", title: "Professional", note: "I'm here for the professional courses, assessments and certificates." }
  ];
}

// ── PUBLIC: grade options for the sign-up picker ─────────────────────────────
router.get("/grades", async (req, res) => {
  // Always return the full list; grades are a fixed academic ladder, not a
  // function of how many quiz rules happen to exist.
  res.json({ grades: allGrades(), roles: roleNotes() });
});

// ── AUTH: set the signed-in student's grade → allocate that grade's quizzes ──
router.post("/grade", requireMobileAuth, async (req, res) => {
  try {
    const gradeNum = Number(req.body?.grade);
    if (!Number.isFinite(gradeNum) || gradeNum < MIN_GRADE || gradeNum > MAX_GRADE) {
      return res.status(400).json({ error: "Please choose a valid grade." });
    }

    const user = await User.findById(req.mobileUser._id);
    if (!user) return res.status(404).json({ error: "Account not found." });
    if (user.role !== "student") return res.status(403).json({ error: "Only student accounts set a grade." });

    const org = await Organization.findOne({ slug: HOME_ORG_SLUG }).lean();
    if (!org) return res.status(500).json({ error: "Home learning isn't set up yet." });

    // Store grade + home org (idempotent — safe to re-run to change grade)
    user.grade = gradeNum;
    if (!user.organization) user.organization = org._id;
    await user.save();

    await OrgMembership.updateOne(
      { user: user._id, org: org._id },
      { $setOnInsert: { user: user._id, org: org._id, role: "student", active: true, joinedAt: new Date() } },
      { upsert: true }
    );

    // Assign this grade's TRIAL quizzes (mirrors admin_quiz_rules.js student path).
    // If no rules exist for this grade yet, the grade is still saved — quizzes
    // appear automatically when an admin adds rules for it.
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