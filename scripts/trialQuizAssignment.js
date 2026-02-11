// services/trialQuizAssignment.js
// Assigns trial quizzes to new cripfcnt-school users
import crypto from "crypto";
import ExamInstance from "../models/examInstance.js";
import Question from "../models/question.js";
import User from "../models/user.js";

// ==============================
// 📋 TRIAL QUIZ CONFIGURATION
// ==============================
const TRIAL_QUIZ_CONFIG = {
  consciousness: {
    title: "Consciousness & Awareness - Trial",
    count: 5,
    topics: ['self-awareness', 'perception-accuracy', 'attention-direction']
  },
  responsibility: {
    title: "Responsibility & Placement - Trial",
    count: 5,
    topics: ['placement', 'consequence-management', 'decision-frameworks']
  },
  interpretation: {
    title: "Interpretation & Context - Trial",
    count: 5,
    topics: ['context-reading', 'meaning-extraction', 'perspective-shifts']
  }
};

// ==============================
// 🎯 ASSIGN TRIAL QUIZZES
// ==============================
export async function assignTrialQuizzes({ userId, orgId }) {
  try {
    console.log(`[trialQuiz] Assigning trial quizzes to user ${userId}`);
    
    // Check if user already has trial quizzes
    const existing = await ExamInstance.countDocuments({
      org: orgId,
      userId,
      'meta.isTrial': true
    });
    
    if (existing > 0) {
      console.log(`[trialQuiz] User already has ${existing} trial quizzes, skipping`);
      return { assigned: 0, alreadyExists: true };
    }
    
    const assignmentId = crypto.randomUUID();
    let assignedCount = 0;
    
    // Create one quiz per module
    for (const [module, config] of Object.entries(TRIAL_QUIZ_CONFIG)) {
      try {
        // Find questions for this module
        const questions = await Question.aggregate([
          {
            $match: {
              organization: orgId,
              modules: module,
              type: 'question' // exclude comprehension parents
            }
          },
          { $sample: { size: config.count } }
        ]);
        
        if (questions.length === 0) {
          console.warn(`[trialQuiz] No questions found for module: ${module}`);
          continue;
        }
        
        // Build questionIds and choicesOrder
        const questionIds = [];
        const choicesOrder = [];
        
        for (const q of questions) {
          questionIds.push(String(q._id));
          
          // Shuffle choices
          const n = Array.isArray(q.choices) ? q.choices.length : 0;
          const indices = Array.from({ length: n }, (_, i) => i);
          
          // Fisher-Yates shuffle
          for (let i = indices.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [indices[i], indices[j]] = [indices[j], indices[i]];
          }
          
          choicesOrder.push(indices);
        }
        
        // Create exam instance
        await ExamInstance.create({
          examId: crypto.randomUUID(),
          assignmentId,
          org: orgId,
          userId,
          module,
          modules: [module],
          title: config.title,
          quizTitle: config.title,
          questionIds,
          choicesOrder,
          targetRole: 'teacher', // default for cripfcnt-school
          isOnboarding: false,
          expiresAt: null, // trial quizzes don't expire
          durationMinutes: null, // no time limit for trial
          meta: {
            isTrial: true,
            trialVersion: 1,
            topics: config.topics
          },
          createdAt: new Date()
        });
        
        assignedCount++;
        console.log(`[trialQuiz] Assigned ${module} trial quiz (${questions.length} questions)`);
        
      } catch (err) {
        console.error(`[trialQuiz] Failed to assign ${module} quiz:`, err);
      }
    }
    
    console.log(`[trialQuiz] Successfully assigned ${assignedCount} trial quizzes`);
    
    return {
      assigned: assignedCount,
      assignmentId,
      alreadyExists: false
    };
    
  } catch (error) {
    console.error('[trialQuiz] Error assigning trial quizzes:', error);
    throw error;
  }
}

// ==============================
// 📊 CHECK TRIAL QUIZ STATUS
// ==============================
export async function getTrialQuizStatus(userId, orgId) {
  try {
    const trialQuizzes = await ExamInstance.find({
      org: orgId,
      userId,
      'meta.isTrial': true
    })
    .select('examId module title questionIds')
    .lean();
    
    // Check which quizzes have been completed
    const status = {
      total: trialQuizzes.length,
      completed: 0,
      remaining: trialQuizzes.length,
      quizzes: []
    };
    
    for (const quiz of trialQuizzes) {
      const isCompleted = quiz.status === 'finished' || quiz.finishedAt;
      
      if (isCompleted) {
        status.completed++;
        status.remaining--;
      }
      
      status.quizzes.push({
        examId: quiz.examId,
        module: quiz.module,
        title: quiz.title,
        questionCount: quiz.questionIds?.length || 0,
        completed: isCompleted
      });
    }
    
    return status;
    
  } catch (error) {
    console.error('[trialQuiz] Error getting trial quiz status:', error);
    throw error;
  }
}

// ==============================
// 🔓 CHECK IF USER CAN UPGRADE
// ==============================
export async function canUserUpgrade(userId, orgId) {
  try {
    const status = await getTrialQuizStatus(userId, orgId);
    
    // User can upgrade if they've completed at least 1 trial quiz
    return {
      canUpgrade: status.completed >= 1,
      completedQuizzes: status.completed,
      totalTrialQuizzes: status.total,
      message: status.completed >= 1
        ? 'You can now upgrade to access unlimited quizzes'
        : `Complete ${1 - status.completed} more trial quiz(es) to unlock upgrade`
    };
    
  } catch (error) {
    console.error('[trialQuiz] Error checking upgrade eligibility:', error);
    throw error;
  }
}

export default {
  assignTrialQuizzes,
  getTrialQuizStatus,
  canUserUpgrade
};