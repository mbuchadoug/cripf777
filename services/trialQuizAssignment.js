// services/trialQuizAssignment.js
import crypto from "crypto";
import Question from "../models/question.js";
import ExamInstance from "../models/examInstance.js";
import QuizRule from "../models/quizRule.js";

/**
 * Assign trial quizzes to a new user in cripfcnt-school
 * Returns 3 trial quizzes (one from each core module)
 */
export async function assignTrialQuizzesToUser({ userId, orgId }) {
  try {
    // ✅ Prevent duplicate trial assignments
    const existing = await ExamInstance.countDocuments({
      org: orgId,
      userId,
      "meta.isTrial": true
    });

    if (existing > 0) {
      console.log(`[trialQuiz] User ${userId} already has trial quizzes`);
      return { assigned: 0, skipped: existing };
    }

    // ✅ Find trial quiz rules for cripfcnt-school
    const trialRules = await QuizRule.find({
      org: orgId,
      quizType: "trial",
      enabled: true
    })
      .limit(3)
      .lean();

    if (!trialRules.length) {
      console.warn(`[trialQuiz] No trial quiz rules found for org ${orgId}`);
      return { assigned: 0, skipped: 0 };
    }

    let assigned = 0;
    const baseAssignmentId = crypto.randomUUID();

    for (const rule of trialRules) {
      try {
        // Load parent question
        const parentQuiz = await Question.findById(rule.quizQuestionId).lean();
        if (!parentQuiz || parentQuiz.type !== "comprehension") {
          console.warn(`[trialQuiz] Invalid parent quiz for rule ${rule._id}`);
          continue;
        }

        const childIds = Array.isArray(parentQuiz.questionIds)
          ? parentQuiz.questionIds.map(String)
          : [];

        if (!childIds.length) {
          console.warn(`[trialQuiz] Parent quiz ${parentQuiz._id} has no children`);
          continue;
        }

        // Build question IDs array
        const questionIds = [`parent:${String(parentQuiz._id)}`, ...childIds];
        const choicesOrder = [[]]; // parent marker

        // Shuffle choices for each child
        for (const cid of childIds) {
          const childDoc = await Question.findById(cid).select("choices").lean();
          const nChoices = Array.isArray(childDoc?.choices) ? childDoc.choices.length : 0;

          const indices = Array.from({ length: nChoices }, (_, i) => i);
          for (let i = indices.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [indices[i], indices[j]] = [indices[j], indices[i]];
          }
          choicesOrder.push(indices);
        }

        // Create exam instance
        const examId = crypto.randomUUID();
        const quizTitle = rule.quizTitle || parentQuiz.text || "Trial Quiz";

        await ExamInstance.create({
          examId,
          assignmentId: `${baseAssignmentId}-${rule._id}`,
          org: orgId,
          userId,
          module: rule.module || "general",
          modules: rule.modules || [rule.module || "general"],
          title: quizTitle,
          quizTitle,
          questionIds,
          choicesOrder,
          isOnboarding: false,
          targetRole: "teacher",
          durationMinutes: rule.durationMinutes || 30,
          meta: {
            isTrial: true,
            ruleId: rule._id,
            trialAssignmentId: baseAssignmentId
          },
          createdAt: new Date()
        });

        assigned++;
        console.log(`[trialQuiz] Assigned trial quiz: ${quizTitle} to user ${userId}`);
      } catch (err) {
        console.error(`[trialQuiz] Failed to assign quiz for rule ${rule._id}:`, err.message);
      }
    }

    return { assigned, skipped: 0 };
  } catch (err) {
    console.error("[trialQuiz] Error assigning trial quizzes:", err);
    throw err;
  }
}