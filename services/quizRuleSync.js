// services/quizRuleSync.js
//
// Assigns the full grade quiz set to a home-learning student using the SAME
// canonical mechanism the mobile app and the payment flow already use
// (assignQuizFromRule -> rule.quizQuestionId). Paid gating is inherited from
// assignQuizFromRule: trial quizzes are always assigned; paid quizzes only when
// the student's parent is subscribed (subscriptionStatus === "paid").
//
// Idempotent: a quiz already on the student's list (by ruleId, or by
// title + module for older/onboarding exams) is never assigned twice, so this
// is safe to run on every request from ensureAuth.

import QuizRule from "../models/quizRule.js";
import ExamInstance from "../models/examInstance.js";
import { assignQuizFromRule } from "./quizAssignment.js";

export async function syncQuizRulesForUser({ orgId, userId, grade }) {
  if (!orgId || !userId || grade == null) return;

  const rules = await QuizRule.find({ org: orgId, enabled: true, grade }).lean();
  if (!rules.length) return;

  for (const rule of rules) {
    try {
      const title = rule.quizTitle || rule.title || null;
      const moduleKey = rule.module || rule.subject || null;

      const dedupOr = [{ ruleId: rule._id }];
      if (title && moduleKey) dedupOr.push({ quizTitle: title, module: moduleKey });

      const already = await ExamInstance.findOne({ userId, $or: dedupOr })
        .select("_id")
        .lean();
      if (already) continue;

      await assignQuizFromRule({ rule, userId, orgId });
    } catch (e) {
      console.warn(`[quizRuleSync] assign failed for rule ${rule && rule._id}:`, e.message);
    }
  }
}