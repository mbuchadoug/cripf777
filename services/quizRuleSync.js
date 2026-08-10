// services/quizRuleSync.js  (DIAGNOSTIC BUILD)
//
// Canonical assignment via assignQuizFromRule, PLUS per-run logging so we can
// see exactly why a grade quiz is or is not assigned on the web. Once the
// picture is clear we swap back to the quiet version.

import QuizRule from "../models/quizRule.js";
import ExamInstance from "../models/examInstance.js";
import User from "../models/user.js";
import { assignQuizFromRule } from "./quizAssignment.js";

export async function syncQuizRulesForUser({ orgId, userId, grade }) {
  if (!orgId || !userId || grade == null) return;

  const rules = await QuizRule.find({ org: orgId, enabled: true, grade }).lean();

  // Resolve the payer once, the same way assignQuizFromRule gates paid quizzes.
  const student = await User.findById(userId).select("parentUserId role").lean();
  const parent = student?.parentUserId
    ? await User.findById(student.parentUserId).select("subscriptionStatus subscriptionPlan").lean()
    : null;
  const parentPaid = parent?.subscriptionStatus === "paid";

  console.log(`[quizRuleSync] grade=${grade} orgId=${orgId} rulesFound=${rules.length} parentPaid=${parentPaid} (parentStatus=${parent?.subscriptionStatus || "none"}, plan=${parent?.subscriptionPlan || "none"})`);

  if (!rules.length) return;

  let assigned = 0, skipDup = 0, skipPaid = 0, skipNoQ = 0, failed = 0;

  for (const rule of rules) {
    try {
      const title = rule.quizTitle || rule.title || "(untitled)";
      const moduleKey = rule.module || rule.subject || null;
      const quizType = rule.quizType || "(none)";
      const hasQQID = !!rule.quizQuestionId;

      const dedupOr = [{ ruleId: rule._id }];
      if (rule.quizTitle || rule.title) {
        if (moduleKey) dedupOr.push({ quizTitle: rule.quizTitle || rule.title, module: moduleKey });
      }
      const already = await ExamInstance.findOne({ userId, $or: dedupOr }).select("_id").lean();

      let action;
      if (already) { action = "skip-already-assigned"; skipDup++; }
      else if (quizType === "paid" && !parentPaid) { action = "skip-paid-parent-not-subscribed"; skipPaid++; }
      else if (!hasQQID) { action = "skip-no-quizQuestionId"; skipNoQ++; }
      else {
        const before = await ExamInstance.countDocuments({ userId, ruleId: rule._id });
        await assignQuizFromRule({ rule, userId, orgId });
        const after = await ExamInstance.countDocuments({ userId, ruleId: rule._id });
        if (after > before) { action = "ASSIGNED"; assigned++; }
        else { action = "assignQuizFromRule-made-nothing (check quizQuestionId children / paid gate)"; failed++; }
      }

      console.log(`[quizRuleSync]   rule "${title}" type=${quizType} hasQQID=${hasQQID} -> ${action}`);
    } catch (e) {
      failed++;
      console.warn(`[quizRuleSync]   rule ${rule && rule._id} ERROR:`, e.message);
    }
  }

  console.log(`[quizRuleSync] done grade=${grade}: assigned=${assigned} skipDup=${skipDup} skipPaid=${skipPaid} skipNoQ=${skipNoQ} failed=${failed}`);
}