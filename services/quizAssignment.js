import mongoose from "mongoose";
import crypto from "crypto";
import ExamInstance from "../models/examInstance.js";
import User from "../models/user.js";
import Question from "../models/question.js";

export async function assignQuizFromRule({ rule, userId, orgId, force = false }) {

  // 🔎 Load child
  const student = await User.findById(userId).lean();
  if (!student) return;

  // 🔎 Check payment if PAID quiz
if (rule.quizType === "paid" && !force) {
  const parent = await User.findById(student.parentUserId).lean();
  if (!parent || parent.subscriptionStatus !== "paid") {
    return;
  }
}



  // 🚫 Prevent duplicates
  const exists = await ExamInstance.findOne({
    userId,
    ruleId: rule._id
  }).lean();

  if (exists) return;

  // 🔎 Load quiz question (parent comprehension)
  const parentQuestion = await Question.findById(rule.quizQuestionId).lean();
  if (!parentQuestion) return;

  const childIds = parentQuestion.questionIds || [];
  if (!childIds.length) return;

  const questionIds = [`parent:${parentQuestion._id}`, ...childIds.map(String)];

  const choicesOrder = [];
  for (const cid of childIds) {
    const q = await Question.findById(cid).lean();
    const n = q?.choices?.length || 0;
    const arr = Array.from({ length: n }, (_, i) => i);
    choicesOrder.push(arr);
  }

 
const assignmentId = crypto.randomUUID();

await ExamInstance.create({
  examId: assignmentId,          // 👈 SAME VALUE
  assignmentId,                  // 👈 REQUIRED

  org: orgId,
  userId,
  ruleId: rule._id,

  targetRole: "student",

  module: rule.module,
  title: rule.quizTitle,         // 👈 REQUIRED
  quizTitle: rule.quizTitle,     // 👈 REQUIRED

  questionIds,
  choicesOrder,

  durationMinutes: rule.durationMinutes,

  status: "pending",
  isOnboarding: false
});


}
