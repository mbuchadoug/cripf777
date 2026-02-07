// services/adaptiveQuizEngine.js
import mongoose from "mongoose";
import crypto from "crypto";
import Question from "../models/question.js";
import TopicMastery from "../models/topicMastery.js";
import AdaptiveQuizConfig from "../models/adaptiveQuizConfig.js";
import ExamInstance from "../models/examInstance.js";
import User from "../models/user.js";

/**
 * Adaptive Quiz Engine - Generates personalized quizzes based on student weaknesses
 * 
 * Core Algorithm:
 * 1. Load student's topic mastery records
 * 2. Classify topics into buckets (weak, struggling, strong, mastered)
 * 3. Calculate question distribution based on config weights
 * 4. Select questions from each bucket at appropriate difficulty
 * 5. Create ExamInstance with shuffled questions
 */

export class AdaptiveQuizEngine {
  constructor(config) {
    this.config = config;
  }

  /**
   * Generate an adaptive quiz for a student
   * 
   * @param {Object} params
   * @param {ObjectId} params.userId - Student ID
   * @param {string} params.subject - Subject (e.g., "math")
   * @param {number} params.grade - Grade level
   * @param {ObjectId} params.orgId - Organization ID
   * @param {number} params.questionCount - Total questions (default from config)
   * @returns {ExamInstance}
   */
  async generateQuiz({ userId, subject, grade, orgId, questionCount = null }) {
    try {
      // Validate inputs
      if (!userId || !subject || !grade) {
        throw new Error("userId, subject, and grade are required");
      }

      // Get student
      const student = await User.findById(userId).lean();
      if (!student) {
        throw new Error("Student not found");
      }

      // Use provided question count or config default
      const totalQuestions = questionCount || this.config.defaultQuestionCount;

      // Load student's topic mastery for this subject
      const masteryRecords = await TopicMastery.getStudentMastery(userId, subject, grade);

      console.log(`[AdaptiveQuiz] Generating quiz for user ${userId}, subject ${subject}, grade ${grade}`);
      console.log(`[AdaptiveQuiz] Found ${masteryRecords.length} topic mastery records`);

      // If student has no mastery data, generate a diagnostic quiz
      if (masteryRecords.length === 0) {
        console.log("[AdaptiveQuiz] No mastery data - generating diagnostic quiz");
        return this.generateDiagnosticQuiz({ userId, subject, grade, orgId, totalQuestions });
      }

      // Classify topics into buckets
      const buckets = this.classifyTopics(masteryRecords);

      console.log("[AdaptiveQuiz] Topic distribution:", {
        weak: buckets.weak.length,
        struggling: buckets.struggling.length,
        strong: buckets.strong.length,
        mastered: buckets.mastered.length
      });

      // Calculate question distribution
      const distribution = this.config.getDistribution(totalQuestions);

      console.log("[AdaptiveQuiz] Question distribution:", distribution);

      // Select questions from each bucket
      const selectedQuestions = await this.selectQuestions({
        buckets,
        distribution,
        subject,
        grade,
        orgId
      });

      console.log(`[AdaptiveQuiz] Selected ${selectedQuestions.length} questions`);

      // If we don't have enough questions, fill with random ones
      if (selectedQuestions.length < totalQuestions) {
        console.log(`[AdaptiveQuiz] Need ${totalQuestions - selectedQuestions.length} more questions`);
        const additionalQuestions = await this.fillRemainingQuestions({
          currentQuestions: selectedQuestions,
          needed: totalQuestions - selectedQuestions.length,
          subject,
          grade,
          orgId
        });
        selectedQuestions.push(...additionalQuestions);
      }

      // Shuffle questions if config allows
      if (this.config.randomizeQuestions) {
        this.shuffle(selectedQuestions);
      }

      // Create choice order mappings
      const choicesOrder = selectedQuestions.map(q => {
        const n = q.choices ? q.choices.length : 0;
        const order = Array.from({ length: n }, (_, i) => i);
        if (this.config.randomizeChoices) {
          this.shuffle(order);
        }
        return order;
      });

      // Create ExamInstance
      const examId = crypto.randomUUID();
      const assignmentId = crypto.randomUUID();

      const exam = await ExamInstance.create({
        examId,
        assignmentId,
        userId,
        org: orgId,
        targetRole: "student",
        module: subject,
        title: `Adaptive ${this.capitalizeFirst(subject)} Quiz`,
        quizTitle: `Adaptive ${this.capitalizeFirst(subject)} Quiz - Grade ${grade}`,
        questionIds: selectedQuestions.map(q => q._id),
        choicesOrder,
        durationMinutes: 30,
        status: "pending",
        meta: {
          adaptive: true,
          subject,
          grade,
          generatedAt: new Date(),
          distribution: {
            weak: distribution.weak,
            struggling: distribution.struggling,
            strong: distribution.strong,
            mastered: distribution.mastered
          },
          topicsCovered: [...new Set(selectedQuestions.map(q => q.topic).filter(Boolean))]
        }
      });

      console.log(`[AdaptiveQuiz] Created exam ${examId} with ${selectedQuestions.length} questions`);

      return exam;

    } catch (error) {
      console.error("[AdaptiveQuiz] Error generating quiz:", error);
      throw error;
    }
  }

  /**
   * Classify topics into mastery buckets
   */
  classifyTopics(masteryRecords) {
    const buckets = {
      weak: [],
      struggling: [],
      strong: [],
      mastered: []
    };

    for (const record of masteryRecords) {
      const classification = this.config.classifyTopic(record.masteryPct);
      buckets[classification].push(record);
    }

    return buckets;
  }

  /**
   * Select questions from each bucket based on distribution
   */
  async selectQuestions({ buckets, distribution, subject, grade, orgId }) {
    const selectedQuestions = [];

    // Helper to get questions for a topic at specific difficulty
    const getQuestionsForTopic = async (topic, difficulty, count) => {
      const match = {
        subject: subject.toLowerCase(),
        topic: topic.toLowerCase(),
        grade,
        type: { $ne: "comprehension" } // Only regular questions for adaptive quizzes
      };

      // Add org filter
      if (orgId) {
        match.$or = [
          { organization: orgId },
          { organization: null },
          { organization: { $exists: false } }
        ];
      } else {
        match.$or = [
          { organization: null },
          { organization: { $exists: false } }
        ];
      }

      // Filter by difficulty if specified
      if (difficulty) {
        match.difficulty = difficulty;
      }

      const questions = await Question.find(match)
        .limit(count * 2) // Get extra for randomization
        .lean();

      // Shuffle and take needed count
      this.shuffle(questions);
      return questions.slice(0, count);
    };

    // Select from weak topics (highest priority)
    if (distribution.weak > 0 && buckets.weak.length > 0) {
      const perTopic = Math.ceil(distribution.weak / buckets.weak.length);
      for (const mastery of buckets.weak) {
        const questions = await getQuestionsForTopic(
          mastery.topic,
          mastery.currentDifficulty,
          perTopic
        );
        selectedQuestions.push(...questions);
      }
    }

    // Select from struggling topics
    if (distribution.struggling > 0 && buckets.struggling.length > 0) {
      const perTopic = Math.ceil(distribution.struggling / buckets.struggling.length);
      for (const mastery of buckets.struggling) {
        const questions = await getQuestionsForTopic(
          mastery.topic,
          mastery.currentDifficulty,
          perTopic
        );
        selectedQuestions.push(...questions);
      }
    }

    // Select from strong topics
    if (distribution.strong > 0 && buckets.strong.length > 0) {
      const perTopic = Math.ceil(distribution.strong / buckets.strong.length);
      for (const mastery of buckets.strong) {
        const questions = await getQuestionsForTopic(
          mastery.topic,
          mastery.currentDifficulty,
          perTopic
        );
        selectedQuestions.push(...questions);
      }
    }

    // Select from mastered topics (confidence boost)
    if (distribution.mastered > 0 && buckets.mastered.length > 0) {
      const perTopic = Math.ceil(distribution.mastered / buckets.mastered.length);
      for (const mastery of buckets.mastered) {
        const questions = await getQuestionsForTopic(
          mastery.topic,
          mastery.currentDifficulty,
          perTopic
        );
        selectedQuestions.push(...questions);
      }
    }

    return selectedQuestions;
  }

  /**
   * Fill remaining questions if we don't have enough from mastery topics
   */
  async fillRemainingQuestions({ currentQuestions, needed, subject, grade, orgId }) {
    const usedIds = new Set(currentQuestions.map(q => String(q._id)));

    const match = {
      subject: subject.toLowerCase(),
      grade,
      type: { $ne: "comprehension" },
      _id: { $nin: Array.from(usedIds).map(id => mongoose.Types.ObjectId(id)) }
    };

    if (orgId) {
      match.$or = [
        { organization: orgId },
        { organization: null },
        { organization: { $exists: false } }
      ];
    } else {
      match.$or = [
        { organization: null },
        { organization: { $exists: false } }
      ];
    }

    const questions = await Question.aggregate([
      { $match: match },
      { $sample: { size: needed } }
    ]);

    return questions;
  }

  /**
   * Generate a diagnostic quiz when student has no mastery data
   * Covers all available topics evenly
   */
  async generateDiagnosticQuiz({ userId, subject, grade, orgId, totalQuestions }) {
    console.log("[AdaptiveQuiz] Generating diagnostic quiz");

    // Find all available topics for this subject/grade
    const match = {
      subject: subject.toLowerCase(),
      grade,
      type: { $ne: "comprehension" }
    };

    if (orgId) {
      match.$or = [
        { organization: orgId },
        { organization: null },
        { organization: { $exists: false } }
      ];
    } else {
      match.$or = [
        { organization: null },
        { organization: { $exists: false } }
      ];
    }

    // Get unique topics
    const topics = await Question.distinct("topic", match);
    console.log(`[AdaptiveQuiz] Found ${topics.length} topics for diagnostic`);

    // If no topics found, generate random questions
    if (topics.length === 0) {
      return this.generateRandomQuiz({ userId, subject, grade, orgId, totalQuestions });
    }

    // Select questions evenly from all topics
    const questionsPerTopic = Math.ceil(totalQuestions / topics.length);
    const selectedQuestions = [];

    for (const topic of topics) {
      const questions = await Question.find({
        ...match,
        topic,
        difficulty: { $in: [1, 2] } // Start with easier questions for diagnostic
      })
        .limit(questionsPerTopic)
        .lean();

      selectedQuestions.push(...questions);
    }

    // Shuffle and trim to desired count
    this.shuffle(selectedQuestions);
    const finalQuestions = selectedQuestions.slice(0, totalQuestions);

    // Create exam
    const examId = crypto.randomUUID();
    const assignmentId = crypto.randomUUID();

    const choicesOrder = finalQuestions.map(q => {
      const n = q.choices ? q.choices.length : 0;
      const order = Array.from({ length: n }, (_, i) => i);
      if (this.config.randomizeChoices) {
        this.shuffle(order);
      }
      return order;
    });

    return ExamInstance.create({
      examId,
      assignmentId,
      userId,
      org: orgId,
      targetRole: "student",
      module: subject,
      title: `Diagnostic ${this.capitalizeFirst(subject)} Quiz`,
      quizTitle: `Diagnostic ${this.capitalizeFirst(subject)} Quiz - Grade ${grade}`,
      questionIds: finalQuestions.map(q => q._id),
      choicesOrder,
      durationMinutes: 30,
      status: "pending",
      meta: {
        adaptive: true,
        diagnostic: true,
        subject,
        grade,
        generatedAt: new Date(),
        topicsCovered: [...new Set(finalQuestions.map(q => q.topic).filter(Boolean))]
      }
    });
  }

  /**
   * Generate a random quiz (fallback when no questions available)
   */
  async generateRandomQuiz({ userId, subject, grade, orgId, totalQuestions }) {
    console.log("[AdaptiveQuiz] Generating random fallback quiz");

    const match = {
      grade,
      type: { $ne: "comprehension" }
    };

    // Try with subject first
    if (subject) {
      match.subject = subject.toLowerCase();
    }

    if (orgId) {
      match.$or = [
        { organization: orgId },
        { organization: null },
        { organization: { $exists: false } }
      ];
    } else {
      match.$or = [
        { organization: null },
        { organization: { $exists: false } }
      ];
    }

    const questions = await Question.aggregate([
      { $match: match },
      { $sample: { size: totalQuestions } }
    ]);

    const examId = crypto.randomUUID();
    const assignmentId = crypto.randomUUID();

    const choicesOrder = questions.map(q => {
      const n = q.choices ? q.choices.length : 0;
      const order = Array.from({ length: n }, (_, i) => i);
      if (this.config.randomizeChoices) {
        this.shuffle(order);
      }
      return order;
    });

    return ExamInstance.create({
      examId,
      assignmentId,
      userId,
      org: orgId,
      targetRole: "student",
      module: subject || "general",
      title: `Practice Quiz - Grade ${grade}`,
      quizTitle: `Practice Quiz - Grade ${grade}`,
      questionIds: questions.map(q => q._id),
      choicesOrder,
      durationMinutes: 30,
      status: "pending",
      meta: {
        adaptive: false,
        random: true,
        subject,
        grade,
        generatedAt: new Date()
      }
    });
  }

  /**
   * Fisher-Yates shuffle algorithm
   */
  shuffle(array) {
    for (let i = array.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
  }

  /**
   * Capitalize first letter
   */
  capitalizeFirst(str) {
    if (!str) return "";
    return str.charAt(0).toUpperCase() + str.slice(1);
  }
}

/**
 * Factory function to create engine with config
 */
export async function createAdaptiveQuizEngine(organizationId = null) {
  const config = await AdaptiveQuizConfig.getConfig(organizationId);
  return new AdaptiveQuizEngine(config);
}

/**
 * Convenience function to generate adaptive quiz
 */
export async function generateAdaptiveQuiz(params) {
  const engine = await createAdaptiveQuizEngine(params.orgId);
  return engine.generateQuiz(params);
}
