// services/aiQuizGenerator.js
import Anthropic from "@anthropic-ai/sdk";
import AIQuiz from "../models/aiQuiz.js";
import User from "../models/user.js";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const QUIZ_MODEL = process.env.ANTHROPIC_QUIZ_MODEL || "claude-sonnet-4-5";

// ── Credit entitlement - SELF-CONTAINED (does not depend on model methods) ──
// Paid teacher plan → 20/50. Active 3-day trial → 5. Everyone else → 3 free a
// month, so a new teacher can always TRY the AI feature (the hook that sells it).
function currentMonth() { return new Date().toISOString().slice(0, 7); } // YYYY-MM
function teacherAllowance(u) {
  const paidActive = u.teacherSubscriptionStatus === "paid" &&
    u.teacherSubscriptionExpiresAt && new Date(u.teacherSubscriptionExpiresAt) > new Date();
  if (paidActive) {
    if (u.teacherSubscriptionPlan === "professional") return 50;
    if (u.teacherSubscriptionPlan === "starter") return 20;
    return 20;
  }
  const trialActive = u.trialEndsAt && new Date(u.trialEndsAt) > new Date();
  if (trialActive) return 5;
  return 3; // baseline free taste
}

// Grant the monthly allowance if this calendar month hasn't been granted yet.
// Returns the current (possibly just-granted) credit balance.
async function ensureMonthlyCredits(teacher) {
  const month = currentMonth();
  const stampMonth = teacher.aiQuizCreditsResetAt
    ? new Date(teacher.aiQuizCreditsResetAt).toISOString().slice(0, 7)
    : null;
  if (stampMonth !== month) {
    teacher.aiQuizCredits = teacherAllowance(teacher);
    teacher.aiQuizCreditsResetAt = new Date();
    await teacher.save();
  }
  return teacher.aiQuizCredits || 0;
}

export async function generateAIQuiz({ teacherId, subject, grade, topic, difficulty, questionCount = 10 }) {
  const teacher = await User.findById(teacherId);
  if (!teacher) throw new Error("Teacher not found");

  const credits = await ensureMonthlyCredits(teacher);
  console.log(`[AI Quiz] Teacher ${teacherId} has ${credits} credits (allowance ${teacherAllowance(teacher)})`);
  if (credits <= 0) throw new Error("No quiz generation credits remaining this month");

  const prompt = `Generate ${questionCount} multiple-choice quiz questions for:
- Subject: ${subject}
- Grade Level: ${grade}
- Topic: ${topic}
- Difficulty: ${difficulty}

Format each question as JSON with this structure:
{
  "text": "question text",
  "choices": ["option A", "option B", "option C", "option D"],
  "correctIndex": 0,
  "explanation": "why this answer is correct"
}

Return ONLY a JSON array of questions, no additional text.`;

  try {
    const message = await anthropic.messages.create({
      model: QUIZ_MODEL, max_tokens: 4000,
      messages: [{ role: "user", content: prompt }]
    });
    const content = message.content[0].text;
    const jsonMatch = content.match(/\[[\s\S]*\]/);
    if (!jsonMatch) throw new Error("Failed to parse AI response");
    const questions = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(questions) || questions.length === 0) throw new Error("No valid questions generated");

    const aiQuiz = await AIQuiz.create({
      teacherId, title: `${topic} - Grade ${grade} (${difficulty})`,
      subject: String(subject).toLowerCase(), grade, topic, difficulty,
      questionCount: questions.length, questions, aiProvider: "anthropic"
    });

    // Deduct one credit only after a successful generation.
    teacher.aiQuizCredits = Math.max(0, (teacher.aiQuizCredits || 0) - 1);
    await teacher.save();
    console.log(`[AI Quiz] Credit used. Remaining: ${teacher.aiQuizCredits}`);
    return aiQuiz;
  } catch (error) {
    console.error("[AI Quiz Generation Error]", error);
    throw new Error("Failed to generate quiz: " + error.message);
  }
}

// Expose the allowance helper so routes can SHOW the balance without generating.
export async function getTeacherCreditInfo(teacherId) {
  const teacher = await User.findById(teacherId);
  if (!teacher) return { credits: 0, allowance: 0 };
  const credits = await ensureMonthlyCredits(teacher);
  return { credits, allowance: teacherAllowance(teacher) };
}

export async function assignAIQuizToStudents({ aiQuizId, studentIds, teacherId }) {
  const ExamInstance = (await import("../models/examInstance.js")).default;
  const crypto = (await import("crypto")).default;
  const aiQuiz = await AIQuiz.findOne({ _id: aiQuizId, teacherId });
  if (!aiQuiz) throw new Error("Quiz not found");

  const assignments = [];
  for (const studentId of studentIds) {
    const existing = await ExamInstance.findOne({ userId: studentId, "meta.aiQuizId": aiQuizId });
    if (existing) continue;
    const examId = crypto.randomUUID();
    const student = await User.findById(studentId).select("organization").lean();
    const exam = await ExamInstance.create({
      examId, userId: studentId, org: student?.organization || null,
      title: aiQuiz.title, quizTitle: aiQuiz.title,
      module: aiQuiz.subject, subject: aiQuiz.subject, grade: aiQuiz.grade,
      targetRole: "student", status: "pending", durationMinutes: aiQuiz.questionCount * 2,
      questionIds: aiQuiz.questions.map((_, idx) => `ai:${aiQuizId}:${idx}`),
      choicesOrder: aiQuiz.questions.map(q => Array.from({ length: q.choices.length }, (_, i) => i)),
      meta: { aiQuizId, isAIGenerated: true, teacherId, difficulty: aiQuiz.difficulty }
    });
    aiQuiz.assignedTo.push({ studentId, assignedAt: new Date() });
    assignments.push(exam);
  }
  await aiQuiz.save();
  return assignments;
}