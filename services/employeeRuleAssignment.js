// services/employeeRuleAssignment.js
import QuizRule from "../models/quizRule.js";
import ExamInstance from "../models/examInstance.js";
import Question from "../models/question.js";
import crypto from "crypto";

/**
 * Apply employee quiz rules for cripfcnt-school.
 * - trial: always assign to employee
 * - paid: assign only if user is paid OR force=true
 */
export async function applyEmployeeQuizRules({ orgId, userId, force = false }) {
  // Load all enabled rules for this org
  const rules = await QuizRule.find({
    org: orgId,
    enabled: true,
    // school has no grade/subject → rules will have grade=null subject=null
  }).lean();

  if (!rules.length) return { applied: 0 };

  let applied = 0;

  for (const rule of rules) {
    // Only process paid rules when force=true (i.e. after upgrade)
    if (rule.quizType === "paid" && !force) continue;

    // Prevent duplicates per rule
    const exists = await ExamInstance.findOne({
      org: orgId,
      userId,
      ruleId: rule._id
    }).lean();
    if (exists) continue;

    // Load parent comprehension quiz
    const parent = await Question.findById(rule.quizQuestionId).lean();
    if (!parent) continue;

    const childIds = Array.isArray(parent.questionIds) ? parent.questionIds.map(String) : [];
    if (!childIds.length) continue;

    // Build questionIds with parent marker
    const questionIds = [`parent:${String(parent._id)}`, ...childIds];

    // choicesOrder: include placeholder [] for parent marker
    const choicesOrder = [[]];

    for (const cid of childIds) {
      const child = await Question.findById(cid).select("choices").lean();
      const n = child?.choices?.length || 0;
      choicesOrder.push(Array.from({ length: n }, (_, i) => i));
    }

    const assignmentId = crypto.randomUUID();
    await ExamInstance.create({
      examId: crypto.randomUUID(),
      assignmentId,
      org: orgId,
      userId,
      ruleId: rule._id,

      // employee
      targetRole: "employee",

      module: rule.module,
      title: rule.quizTitle,
      quizTitle: rule.quizTitle,
      quizType: rule.quizType,

      questionIds,
      choicesOrder,
      durationMinutes: rule.durationMinutes,

      status: "pending",
      isOnboarding: false,

      meta: {
        isRuleAssigned: true,
        ruleQuizType: rule.quizType
      },

      createdAt: new Date()
    });

    applied++;
  }

  return { applied };
}
