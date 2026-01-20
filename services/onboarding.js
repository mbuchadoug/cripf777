// services/onboarding.js
import crypto from "crypto";
import ExamInstance from "../models/examInstance.js";
import QuizQuestion from "../models/question.js";

async function assignOnboardingQuizzes({ orgId, userId }) {
  const existing = await ExamInstance.countDocuments({
    org: orgId,
    userId,
    isOnboarding: true
  });

  if (existing > 0) return;

  const questions = await QuizQuestion.aggregate([
    {
      $match: {
        $or: [{ organization: orgId }, { organization: null }]
      }
    },
    { $sample: { size: 5 } }
  ]);

  if (!questions.length) return;

  await ExamInstance.create({
    examId: crypto.randomUUID(),
    org: orgId,
    userId,
    module: "onboarding",
    isOnboarding: true,   // ✅ MUST BE TRUE
    questionIds: questions.map(q => String(q._id)),
    choicesOrder: questions.map(q =>
      Array.from({ length: q.choices.length }, (_, i) => i)
    ),
    createdAt: new Date()
  });
}
