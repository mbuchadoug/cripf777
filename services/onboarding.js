import crypto from "crypto";
import ExamInstance from "../models/examInstance.js";
import Question from "../models/question.js";

export async function assignOnboardingQuizzes({ orgId, userId }) {
  const existing = await ExamInstance.countDocuments({
    org: orgId,
    userId,
    isOnboarding: true
  });

  if (existing > 0) return;

  const questions = await Question.aggregate([
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
  targetRole: "teacher", // ✅ REQUIRED
  module: "onboarding",
  isOnboarding: true,
  questionIds: questions.map(q => String(q._id)),
  choicesOrder: questions.map(q =>
    Array.from({ length: q.choices.length }, (_, i) => i)
  ),
  createdAt: new Date()
});

}
