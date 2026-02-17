// services/aiQuizGenerator.js
import Anthropic from "@anthropic-ai/sdk";
import AIQuiz from "../models/aiQuiz.js";
import User from "../models/user.js";

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY
});

/**
 * Generate quiz questions using Claude AI
 */
export async function generateAIQuiz({
  teacherId,
  subject,
  grade,
  topic,
  difficulty,
  questionCount = 10
}) {
  const teacher = await User.findById(teacherId);
  
  // ✅ Reset credits if needed (this updates in memory)
  teacher.resetAIQuizCredits();
  
  // ✅ Save the reset before checking
  await teacher.save();
  
  // ✅ Reload to get fresh data
  const freshTeacher = await User.findById(teacherId);
  
  console.log(`[AI Quiz] Teacher ${teacherId} has ${freshTeacher.aiQuizCredits} credits`);
  
  if (!freshTeacher.hasAIQuizCredits() || freshTeacher.aiQuizCredits <= 0) {
    throw new Error("No AI quiz credits remaining this month");
  }

  // Check and reset credits if needed
  teacher.resetAIQuizCredits();
  
  if (!teacher.hasAIQuizCredits()) {
    throw new Error("No AI quiz credits remaining this month");
  }

  // Build prompt
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
      model: "claude-sonnet-4-20250514",
      max_tokens: 4000,
      messages: [{
        role: "user",
        content: prompt
      }]
    });

    // Parse response
    const content = message.content[0].text;
    const jsonMatch = content.match(/\[[\s\S]*\]/);
    
    if (!jsonMatch) {
      throw new Error("Failed to parse AI response");
    }

    const questions = JSON.parse(jsonMatch[0]);

    // Validate questions
    if (!Array.isArray(questions) || questions.length === 0) {
      throw new Error("No valid questions generated");
    }

    // Create AIQuiz document
    const aiQuiz = await AIQuiz.create({
      teacherId,
      title: `${topic} - Grade ${grade} (${difficulty})`,
      subject: subject.toLowerCase(),
      grade,
      topic,
      difficulty,
      questionCount: questions.length,
      questions,
      aiProvider: "anthropic"
    });

    // Deduct credit
  // ✅ Deduct credit using freshTeacher
freshTeacher.aiQuizCredits -= 1;
await freshTeacher.save();

console.log(`[AI Quiz] Credit used. Remaining: ${freshTeacher.aiQuizCredits}`);

return aiQuiz;

  } catch (error) {
    console.error("[AI Quiz Generation Error]", error);
    throw new Error("Failed to generate quiz: " + error.message);
  }
}

/**
 * Assign AI quiz to multiple students
 */
export async function assignAIQuizToStudents({
  aiQuizId,
  studentIds,
  teacherId
}) {
  const ExamInstance = (await import("../models/examInstance.js")).default;
  const crypto = (await import("crypto")).default;
  
  const aiQuiz = await AIQuiz.findOne({
    _id: aiQuizId,
    teacherId
  });

  if (!aiQuiz) {
    throw new Error("Quiz not found");
  }

  const assignments = [];

  for (const studentId of studentIds) {
    // Check if already assigned
    const existing = await ExamInstance.findOne({
      userId: studentId,
      "meta.aiQuizId": aiQuizId
    });

    if (existing) continue;

    // Create exam instance
    const examId = crypto.randomUUID();
    
    const exam = await ExamInstance.create({
      examId,
      userId: studentId,
      title: aiQuiz.title,
      quizTitle: aiQuiz.title,
      module: aiQuiz.subject,
      targetRole: "student",
      status: "pending",
      durationMinutes: aiQuiz.questionCount * 2, // 2 min per question
      
      // Store questions directly (not refs)
      questionIds: aiQuiz.questions.map((_, idx) => `ai:${aiQuizId}:${idx}`),
      choicesOrder: aiQuiz.questions.map(q => 
        Array.from({ length: q.choices.length }, (_, i) => i)
      ),
      
      meta: {
        aiQuizId: aiQuizId,
        isAIGenerated: true,
        teacherId,
        difficulty: aiQuiz.difficulty
      }
    });

    // Track assignment
    aiQuiz.assignedTo.push({
      studentId,
      assignedAt: new Date()
    });

    assignments.push(exam);
  }

  await aiQuiz.save();
  
  return assignments;
}