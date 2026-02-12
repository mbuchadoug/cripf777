// services/quizAssignment.js
import crypto from "crypto";
import ExamInstance from "../models/examInstance.js";
import User from "../models/user.js";
import Question from "../models/question.js";

/**
 * Assigns a comprehension quiz based on a QuizRule to a user.
 * Supports BOTH:
 * - Home students (paid check via parent subscription)
 * - School employees (paid check via employee subscription)
 */
export async function assignQuizFromRule({ rule, userId, orgId, force = false }) {
  const user = await User.findById(userId).lean();
  if (!user) return;

  // ✅ PAID GATING
  if (rule.quizType === "paid" && !force) {
    // HOME student: parent must be paid
    if (user.role === "student") {
      const parent = user.parentUserId
        ? await User.findById(user.parentUserId).lean()
        : null;

      if (!parent || parent.subscriptionStatus !== "paid") return;
    }

    // SCHOOL employee: employee must be paid
    if (user.role === "employee") {
      if (user.employeeSubscriptionStatus !== "paid") return;
      if (user.employeeSubscriptionPlan !== "full_access") return;
      // If you add expiry later, check it here too
    }
  }

  // ✅ Prevent duplicates (scoped to org + rule)
  const exists = await ExamInstance.findOne({
    userId,
    org: orgId,
    ruleId: rule._id
  }).lean();

  if (exists) return;

  // Load comprehension parent
  const parentQuestion = await Question.findById(rule.quizQuestionId).lean();
  if (!parentQuestion) return;

  const childIds = Array.isArray(parentQuestion.questionIds)
    ? parentQuestion.questionIds.map(String)
    : [];

  if (!childIds.length) return;

  // Build question list: parent marker + children
  const questionIds = [`parent:${String(parentQuestion._id)}`, ...childIds];

  /**
   * ✅ IMPORTANT FIX:
   * questionIds includes the parent marker at index 0,
   * so choicesOrder must also include a placeholder at index 0.
   */
  const choicesOrder = [[]];

  for (const cid of childIds) {
    const q = await Question.findById(cid).select("choices").lean();
    const n = Array.isArray(q?.choices) ? q.choices.length : 0;
    const arr = Array.from({ length: n }, (_, i) => i);
    choicesOrder.push(arr);
  }

  const assignmentId = crypto.randomUUID();

  await ExamInstance.create({
    examId: crypto.randomUUID(),
    assignmentId,

    org: orgId,
    userId,
    ruleId: rule._id,

    module: rule.module || parentQuestion.module || "general",

    title: rule.quizTitle || parentQuestion.text || "Quiz",
    quizTitle: rule.quizTitle || parentQuestion.text || "Quiz",
    quizType: rule.quizType, // "trial" | "paid"

    questionIds,
    choicesOrder,

    durationMinutes: Number(rule.durationMinutes) || 30,

    targetRole: user.role === "employee" ? "employee" : "student",
    status: "pending",
    isOnboarding: false,

    meta: {
      isRuleAssigned: true,
      ruleOrg: String(orgId),
      ruleModule: rule.module || null,
      ruleQuizType: rule.quizType || null
      // subject/grade can exist for home rules; for school they’ll be null
    },

    createdAt: new Date()
  });
}
