// services/employeeTrialAssignment.js
import crypto from "crypto";
import ExamInstance from "../models/examInstance.js";
import Question from "../models/question.js";

/**
 * Assign 3 trial quizzes to new cripfcnt-school employee
 * These are the same onboarding quizzes: Inclusion, Responsibility, Grid
 */
export async function assignEmployeeTrialQuizzes({ orgId, userId }) {
  // Check if already assigned
  const existing = await ExamInstance.countDocuments({
    org: orgId,
    userId,
    'meta.isEmployeeTrial': true
  });

  if (existing > 0) {
    console.log(`[EmployeeTrial] User ${userId} already has trial quizzes`);
    return { assigned: false, reason: "already_assigned" };
  }

  const trialAssignmentId = crypto.randomUUID();

  const trialQuizzes = [
    { module: "inclusion", title: "Inclusion Is Not Absorption" },
    { module: "responsibility", title: "Responsibility Is Not Blame" },
    { module: "grid", title: "The Grid – How the World Actually Operates" }
  ];

  let assignedCount = 0;

  for (const quiz of trialQuizzes) {
    // Sample 3 questions from module
    const questions = await Question.aggregate([
      {
        $match: {
          module: quiz.module,
          $or: [{ organization: orgId }, { organization: null }]
        }
      },
      { $sample: { size: 3 } }
    ]);

    if (!questions.length) {
      console.warn(`[EmployeeTrial] No questions found for module: ${quiz.module}`);
      continue;
    }

    await ExamInstance.create({
      examId: crypto.randomUUID(),
      assignmentId: trialAssignmentId,
      title: quiz.title,
      org: orgId,
      userId,
      module: quiz.module,
      isOnboarding: false, // NOT onboarding
      targetRole: "employee",
      questionIds: questions.map(q => String(q._id)),
      choicesOrder: questions.map(q =>
        Array.from({ length: q.choices.length }, (_, i) => i)
      ),
      meta: {
        isEmployeeTrial: true, // ✅ MARK AS EMPLOYEE TRIAL
        isTrial: true,
        trialQuizNumber: assignedCount + 1
      },
      createdAt: new Date()
    });

    assignedCount++;
  }

  console.log(`[EmployeeTrial] Assigned ${assignedCount} trial quizzes to user ${userId}`);

  return {
    assigned: true,
    count: assignedCount,
    assignmentId: trialAssignmentId
  };
}

/**
 * Check trial quiz completion status
 */
export async function getEmployeeTrialStatus(userId, orgId) {
  const trials = await ExamInstance.find({
    userId,
    org: orgId,
    'meta.isEmployeeTrial': true
  }).lean();

  const completed = trials.filter(t => t.status === 'finished').length;
  const total = trials.length;

  return {
    total,
    completed,
    remaining: total - completed,
    canUpgrade: completed >= total && total > 0
  };
}

/**
 * Unlock all quizzes for paid employee
 */
export async function unlockAllEmployeeQuizzes({ orgId, userId }) {
  console.log(`[EmployeeTrial] Unlocking all quizzes for user ${userId}`);

  // Get all comprehension passages for org
  const allQuizzes = await Question.find({
    organization: orgId,
    type: 'comprehension'
  }).select('_id text module questionIds').lean();

  console.log(`[EmployeeTrial] Found ${allQuizzes.length} quizzes to unlock`);

  const baseAssignmentId = crypto.randomUUID();
  let created = 0;

  for (const quiz of allQuizzes) {
    try {
      // Skip if already assigned
      const exists = await ExamInstance.findOne({
        userId,
        org: orgId,
        'meta.catalogQuizId': quiz._id
      });

      if (exists) continue;

      // Build question IDs
      const questionIds = [];
      const choicesOrder = [];

      // Add parent marker
      questionIds.push(`parent:${String(quiz._id)}`);
      choicesOrder.push([]);

      // Add child questions
      const childIds = Array.isArray(quiz.questionIds) ? quiz.questionIds.map(String) : [];

      for (const cid of childIds) {
        questionIds.push(String(cid));

        // Shuffle choices
        let nChoices = 0;
        try {
          const childDoc = await Question.findById(String(cid)).select('choices').lean();
          if (childDoc) nChoices = Array.isArray(childDoc.choices) ? childDoc.choices.length : 0;
        } catch (e) {
          nChoices = 0;
        }

        const indices = Array.from({ length: Math.max(0, nChoices) }, (_, i) => i);
        for (let i = indices.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [indices[i], indices[j]] = [indices[j], indices[i]];
        }
        choicesOrder.push(indices);
      }

      // Create exam instance
      await ExamInstance.create({
        examId: crypto.randomUUID(),
        assignmentId: `${baseAssignmentId}-${quiz._id}`,
        org: orgId,
        userId,
        module: quiz.module || 'general',
        title: quiz.text || 'Quiz',
        quizTitle: quiz.text || 'Quiz',
        questionIds,
        choicesOrder,
        isOnboarding: false,
        targetRole: 'employee',
        durationMinutes: 30,
        meta: {
          catalogQuizId: quiz._id,
          isPaidEmployeeQuiz: true,
          unlockedAt: new Date()
        },
        createdAt: new Date()
      });

      created++;

      // Log progress every 100 quizzes
      if (created % 100 === 0) {
        console.log(`[EmployeeTrial] Unlocked ${created} quizzes...`);
      }

    } catch (err) {
      console.error(`[EmployeeTrial] Failed to unlock quiz ${quiz._id}:`, err.message);
    }
  }

  console.log(`[EmployeeTrial] ✅ Unlocked ${created} quizzes for user ${userId}`);

  return {
    unlocked: created,
    total: allQuizzes.length
  };
}