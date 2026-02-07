// services/topicMasteryTracker.js
import mongoose from "mongoose";
import Question from "../models/question.js";
import Attempt from "../models/attempt.js";
import TopicMastery from "../models/topicMastery.js";
import Organization from "../models/organization.js";

const HOME_ORG_SLUG = "cripfcnt-home";

/**
 * Update topic mastery after quiz attempt (cripfcnt-home only)
 * 
 * @param {ObjectId} attemptId - Attempt ID
 * @returns {Object} Summary of updates
 */
export async function updateTopicMasteryFromAttempt(attemptId) {
  try {
    const attempt = await Attempt.findById(attemptId).lean();
    if (!attempt) {
      throw new Error("Attempt not found");
    }

    // Check if this is cripfcnt-home org
    const org = await Organization.findById(attempt.organization).lean();
    if (!org || org.slug !== HOME_ORG_SLUG) {
      console.log(`[TopicMastery] Skipping - not cripfcnt-home org`);
      return { updated: 0, created: 0, skipped: true };
    }

    console.log(`[TopicMastery] Processing attempt ${attemptId} for user ${attempt.userId}`);

    // Get question IDs
    const questionIds = (attempt.answers || [])
      .map(a => a.questionId)
      .filter(Boolean)
      .filter(id => mongoose.isValidObjectId(id))
      .map(id => mongoose.Types.ObjectId(id));

    if (questionIds.length === 0) {
      console.log("[TopicMastery] No valid question IDs");
      return { updated: 0, created: 0 };
    }

    // Load questions
    const questions = await Question.find({
      _id: { $in: questionIds }
    }).lean();

    console.log(`[TopicMastery] Found ${questions.length} questions`);

    // Build maps
    const questionMap = {};
    for (const q of questions) {
      questionMap[String(q._id)] = q;
    }

    const answerMap = {};
    for (const answer of attempt.answers) {
      answerMap[String(answer.questionId)] = answer;
    }

    // Track updates
    const updates = {
      updated: 0,
      created: 0,
      topics: new Set()
    };

    // Process each question
    for (const question of questions) {
      const qid = String(question._id);
      const answer = answerMap[qid];

      if (!answer || answer.answerType !== "mcq") {
        continue; // Skip non-MCQ
      }

      // Get topic, subject, grade
      const topic = question.topic;
      const subject = question.subject;
      const grade = question.grade;

      if (!topic || !subject || !grade) {
        console.log(`[TopicMastery] Skipping question ${qid} - missing topic/subject/grade`);
        continue;
      }

      // Get or create mastery record
      const mastery = await TopicMastery.getOrCreate({
        userId: attempt.userId,
        organization: attempt.organization,
        subject: subject.toLowerCase(),
        topic: topic.toLowerCase(),
        grade
      });

      // Record attempt
      const wasCorrect = answer.correct === true;
      const difficulty = question.difficulty || 1;

      mastery.recordAttempt(qid, wasCorrect, difficulty);
      await mastery.save();

      updates.topics.add(topic);
      if (mastery.isNew) {
        updates.created++;
      } else {
        updates.updated++;
      }
    }

    console.log(`[TopicMastery] Updated ${updates.updated}, created ${updates.created}`);
    console.log(`[TopicMastery] Topics:`, Array.from(updates.topics));

    return {
      updated: updates.updated,
      created: updates.created,
      topics: Array.from(updates.topics)
    };

  } catch (error) {
    console.error("[TopicMastery] Error:", error);
    throw error;
  }
}

/**
 * Get student's knowledge map
 */
export async function getStudentKnowledgeMap(userId, subject, grade) {
  try {
    const topics = await TopicMastery.getKnowledgeMap(userId, subject, grade);

    // Group by classification
    const byClassification = {
      mastered: topics.filter(t => t.classification === "mastered"),
      strong: topics.filter(t => t.classification === "strong"),
      struggling: topics.filter(t => t.classification === "struggling"),
      weak: topics.filter(t => t.classification === "weak")
    };

    // Stats
    const totalTopics = topics.length;
    const totalAttempted = topics.reduce((sum, t) => sum + t.totalAttempted, 0);
    const avgMastery = totalTopics > 0
      ? Math.round(topics.reduce((sum, t) => sum + t.masteryPct, 0) / totalTopics)
      : 0;

    // Focus areas (weakest topics)
    const focusTopics = topics
      .filter(t => t.masteryPct < 60)
      .sort((a, b) => a.masteryPct - b.masteryPct)
      .slice(0, 3)
      .map(t => t.topic);

    return {
      subject,
      grade,
      topics,
      byClassification,
      stats: {
        totalTopics,
        totalAttempted,
        avgMastery,
        masteredCount: byClassification.mastered.length,
        strongCount: byClassification.strong.length,
        strugglingCount: byClassification.struggling.length,
        weakCount: byClassification.weak.length
      },
      focusTopics
    };

  } catch (error) {
    console.error("[TopicMastery] Error getting knowledge map:", error);
    throw error;
  }
}
