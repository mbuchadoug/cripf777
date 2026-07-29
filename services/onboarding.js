// services/onboarding.js
//
// Gives a brand-new learner a small, grade-appropriate set of REAL trial
// quizzes. Each quiz is ONE comprehension "parent" (a single Test = a passage
// plus its own child questions), assigned with the same parent-token structure
// as assignQuizFromRule — so the mobile/web players show one coherent test with
// one passage, never a random mix of unrelated tests.
//
// This replaces the old behaviour, which sampled 5 random questions from the
// whole bank (no rule, no parent), producing the mixed-passage quizzes.

import crypto from "crypto";
import ExamInstance from "../models/examInstance.js";
import Question from "../models/question.js";
import QuizRule from "../models/quizRule.js";
import User from "../models/user.js";

export async function assignOnboardingQuizzes({ orgId, userId, maxQuizzes = 3 }) {
  // Skip if this learner already has onboarding quizzes.
  const existing = await ExamInstance.countDocuments({
    org: orgId,
    userId,
    isOnboarding: true
  });
  if (existing > 0) return;

  const user = await User.findById(userId).select("grade role").lean();
  const grade = user?.grade ?? null;

  // Enabled TRIAL rules for this grade. Fall back to any enabled trial rule if
  // the grade has none configured yet. Each rule points at one comprehension
  // parent (rule.quizQuestionId).
  let rules = await QuizRule.find({
    org: orgId,
    enabled: true,
    quizType: "trial",
    ...(grade != null ? { grade } : {})
  }).lean();

  if (!rules.length && grade != null) {
    rules = await QuizRule.find({
      org: orgId,
      enabled: true,
      quizType: "trial"
    }).lean();
  }

  // No trial rules configured yet → assign nothing. We deliberately do NOT fall
  // back to random sampling; that was the source of the mixed-passage quizzes.
  if (!rules.length) return;

  // One quiz per subject, capped, so a new learner isn't flooded.
  const seenSubject = new Set();
  const picked = [];
  for (const r of rules) {
    const key = r.subject || String(r._id);
    if (seenSubject.has(key)) continue;
    seenSubject.add(key);
    picked.push(r);
    if (picked.length >= maxQuizzes) break;
  }

  for (const rule of picked) {
    // Skip if this exact rule is already assigned and still active.
    const dupe = await ExamInstance.findOne({
      userId,
      org: orgId,
      ruleId: rule._id,
      status: { $in: ["pending", "in_progress", "started"] }
    }).lean();
    if (dupe) continue;

    const parentQuestion = await Question.findById(rule.quizQuestionId)
      .select("questionIds text module")
      .lean();
    if (!parentQuestion) continue;

    const childIds = Array.isArray(parentQuestion.questionIds)
      ? parentQuestion.questionIds.map(String)
      : [];
    if (!childIds.length) continue;

    // Canonical structure: parent marker + children (matches assignQuizFromRule).
    const questionIds = [`parent:${String(parentQuestion._id)}`, ...childIds];

    // choicesOrder aligned to questionIds — placeholder [] for the parent marker,
    // then an identity order per child.
    const choicesOrder = [[]];
    for (const cid of childIds) {
      const q = await Question.findById(cid).select("choices").lean();
      const n = Array.isArray(q?.choices) ? q.choices.length : 0;
      choicesOrder.push(Array.from({ length: n }, (_, i) => i));
    }

    await ExamInstance.create({
      examId: crypto.randomUUID(),
      org: orgId,
      userId,
      ruleId: rule._id, // ← lets the player resolve the SPECIFIC quiz canonically
      module: rule.module || parentQuestion.module || "general",
      title: rule.quizTitle || parentQuestion.text || "Quiz",
      quizTitle: rule.quizTitle || parentQuestion.text || "Quiz",
      questionIds,
      choicesOrder,
      durationMinutes: Number(rule.durationMinutes) || 30,
      targetRole: user?.role === "employee" ? "employee" : "student",
      status: "pending",
      isOnboarding: true, // ← keeps the skip-guard above working
      meta: {
        subject: rule.subject || null,
        isOnboarding: true,
        isRuleAssigned: true,
        assignedGrade: rule.grade ?? grade ?? null
      },
      createdAt: new Date()
    });
  }
}