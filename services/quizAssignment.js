import crypto from "crypto";
import ExamInstance from "../models/examInstance.js";
import Question from "../models/question.js";

export async function assignQuizFromRule({ rule, userId, orgId }) {
  const quiz = await Question.findById(rule.quizQuestionId).lean();
  if (!quiz) return;

  const exists = await ExamInstance.findOne({
    org: orgId,
    userId,
    quizTitle: quiz.text
  });

  if (exists) return;

 await ExamInstance.create({
  examId: crypto.randomUUID(),
  assignmentId: crypto.randomUUID(),
  org: orgId,
  userId,

  targetRole: "student", // ✅ REQUIRED (THIS IS THE FIX)

  module: quiz.module,
  title: quiz.text,
  quizTitle: quiz.text,
  isTrial: rule.quizType === "trial",
  durationMinutes: rule.durationMinutes,
  questionIds: quiz.questionIds.map(id => String(id)),
  createdAt: new Date()
});

}
