import crypto from "crypto";
import QuizRule from "../models/quizRule.js";
import ExamInstance from "../models/examInstance.js";
import Question from "../models/question.js";

export async function syncQuizRulesForUser({ orgId, userId, grade }) {

  const rules = await QuizRule.find({
    org: orgId,
    enabled: true,
    grade
  }).lean();

  if (!rules.length) return;

  for (const rule of rules) {

    const exists = await ExamInstance.findOne({
      org: orgId,
      userId,
      module: rule.subject,
      quizTitle: rule.title,
      isTrial: rule.isTrial
    });

    if (exists) continue;

    const questions = await Question.aggregate([
      {
        $match: {
          module: rule.subject,
          grade,
          organization: orgId
        }
      },
      { $sample: { size: rule.questionCount || 10 } }
    ]);

    if (!questions.length) continue;

    await ExamInstance.create({
      examId: crypto.randomUUID(),
      assignmentId: `rule:${rule._id}`,
      org: orgId,
      userId,
      module: rule.subject,
      title: rule.title,
      quizTitle: rule.title,
      isTrial: rule.isTrial,
      targetRole: "student",
      questionIds: questions.map(q => String(q._id)),
      choicesOrder: questions.map(q =>
        Array.from({ length: q.choices.length }, (_, i) => i)
      ),
      createdAt: new Date()
    });
  }
}
