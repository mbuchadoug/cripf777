// services/quizRuleSync.js
//
// Assigns the full grade quiz set to a home-learning student using the SAME
// canonical mechanism the mobile app and the payment flow already use
// (assignQuizFromRule -> rule.quizQuestionId). The previous version random-
// sampled questions by { module, grade, organization } and skipped every rule
// whose sample came back empty, so the web only ever materialised a partial
// set (the "only 4 quizzes" problem). Switching to assignQuizFromRule makes
// the web assign every grade quiz exactly like mobile.
//
// Paid gating is inherited from assignQuizFromRule:
//   - trial quizzes -> always assigned
//   - paid quizzes  -> assigned only when the student's parent is subscribed
//
// Idempotent: a quiz already on the student's list (matched by ruleId, or by
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

      // Already present for this student (any status)? Skip. We check both the
      // canonical ruleId link and the older title+module shape so a quiz that
      // was assigned by a previous mechanism is not duplicated.
      const dedupOr = [{ ruleId: rule._id }];
      if (title && moduleKey) dedupOr.push({ quizTitle: title, module: moduleKey });

      const already = await ExamInstance.findOne({ userId, $or: dedupOr })
        .select("_id")
        .lean();
      if (already) continue;

      // Canonical assignment. Handles paid gating (parent subscription) and its
      // own duplicate guard internally.
      await assignQuizFromRule({ rule, userId, orgId });
    } catch (e) {
      console.warn(`[quizRuleSync] assign failed for rule ${rule && rule._id}:`, e.message);
    }
  }
}