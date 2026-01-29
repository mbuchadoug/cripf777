import QuizRule from "../models/quizRule.js";
import Question from "../models/question.js";
import ExamInstance from "../models/examInstance.js";
import crypto from "crypto";

export async function assignQuizzesForLearner({
  learnerProfile,
  parentUserId,
  type = "trial" // trial | paid
}) {
  const rules = await QuizRule.find({
    grade: learnerProfile.grade,
    type,
    active: true
  }).lean();

  for (const rule of rules) {
    // 🔒 Prevent duplicate assignment
    const exists = await ExamInstance.findOne({
      learnerProfileId: learnerProfile._id,
      module: rule.subject,
      "meta.ruleId": rule._id
    });

    if (exists) continue;

    // 🎯 Fetch questions
    let questions = [];

    if (rule.questionSource === "module") {
      questions = await Question.aggregate([
        {
          $match: {
            subject: rule.subject,
            grade: learnerProfile.grade
          }
        },
        { $sample: { size: rule.count } }
      ]);
    }

    if (!questions.length) continue;

    await ExamInstance.create({
      examId: crypto.randomUUID(),
      learnerProfileId: learnerProfile._id,
      userId: parentUserId,
      targetRole: "student",
      module: rule.subject,
      title: `${rule.subject.toUpperCase()} – Grade ${rule.grade}`,
      questionIds: questions.map(q => String(q._id)),
      choicesOrder: questions.map(q =>
        Array.from({ length: q.choices.length }, (_, i) => i)
      ),
      durationMinutes: rule.durationMinutes,
      meta: {
        ruleId: rule._id,
        type
      }
    });
  }
}
