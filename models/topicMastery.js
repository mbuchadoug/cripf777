// models/topicMastery.js
import mongoose from "mongoose";

/**
 * TopicMastery - Tracks student performance on micro-topics (cripfcnt-home only)
 * 
 * Example:
 * {
 *   userId: "student123",
 *   subject: "math",
 *   topic: "fractions",
 *   grade: 4,
 *   totalAttempted: 25,
 *   totalCorrect: 12,
 *   masteryPct: 48,
 *   currentDifficulty: 2
 * }
 */

const TopicMasterySchema = new mongoose.Schema({
  // Student
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
    index: true
  },

  // Organization (should always be cripfcnt-home)
  organization: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Organization",
    index: true,
    required: true
  },

  // Subject (math, english, science, responsibility)
  subject: {
    type: String,
    required: true,
    lowercase: true,
    index: true
  },

  // Micro-topic (fractions, multiplication, verb-tenses, etc.)
  topic: {
    type: String,
    required: true,
    lowercase: true,
    index: true
  },

  // Grade level
  grade: {
    type: Number,
    required: true,
    index: true
  },

  // Performance metrics
  totalAttempted: {
    type: Number,
    default: 0,
    min: 0
  },

  totalCorrect: {
    type: Number,
    default: 0,
    min: 0
  },

  // Auto-calculated mastery percentage (0-100)
  masteryPct: {
    type: Number,
    default: 0,
    min: 0,
    max: 100
  },

  // Current difficulty level (1-5)
  currentDifficulty: {
    type: Number,
    default: 1,
    min: 1,
    max: 5
  },

  // Recent attempts (last 5)
  recentAttempts: [{
    questionId: mongoose.Schema.Types.ObjectId,
    correct: Boolean,
    difficulty: Number,
    attemptedAt: Date
  }],

  // Streak tracking
  currentStreak: {
    type: Number,
    default: 0
  },

  longestStreak: {
    type: Number,
    default: 0
  },

  lastAttemptedAt: {
    type: Date,
    index: true
  },

  createdAt: {
    type: Date,
    default: Date.now
  },

  updatedAt: {
    type: Date,
    default: Date.now
  }
}, {
  timestamps: true
});

// ==============================
// INDEXES
// ==============================
TopicMasterySchema.index({ userId: 1, subject: 1, topic: 1, grade: 1 }, { unique: true });
TopicMasterySchema.index({ userId: 1, subject: 1, grade: 1 });
TopicMasterySchema.index({ organization: 1, subject: 1, topic: 1 });

// ==============================
// METHODS
// ==============================

/**
 * Record a new attempt for this topic
 */
TopicMasterySchema.methods.recordAttempt = function(questionId, correct, difficulty) {
  this.totalAttempted += 1;
  
  if (correct) {
    this.totalCorrect += 1;
    this.currentStreak += 1;
    if (this.currentStreak > this.longestStreak) {
      this.longestStreak = this.currentStreak;
    }
  } else {
    this.currentStreak = 0;
  }

  // Update mastery percentage
  this.masteryPct = Math.round((this.totalCorrect / this.totalAttempted) * 100);

  // Update recent attempts
  this.recentAttempts.push({
    questionId,
    correct,
    difficulty,
    attemptedAt: new Date()
  });

  // Keep only last 5
  if (this.recentAttempts.length > 5) {
    this.recentAttempts.shift();
  }

  // Auto-adjust difficulty
  this.adjustDifficulty();

  this.lastAttemptedAt = new Date();
  this.updatedAt = new Date();
};

/**
 * Adjust difficulty based on performance
 */
TopicMasterySchema.methods.adjustDifficulty = function() {
  if (this.totalAttempted < 3) return;

  const recentCorrect = this.recentAttempts.filter(a => a.correct).length;
  const recentTotal = this.recentAttempts.length;
  const recentPct = recentTotal > 0 ? (recentCorrect / recentTotal) * 100 : 0;

  // Increase difficulty if performing well
  if (recentPct >= 80 && this.currentDifficulty < 5) {
    this.currentDifficulty += 1;
  }
  // Decrease difficulty if struggling
  else if (recentPct < 50 && this.currentDifficulty > 1) {
    this.currentDifficulty -= 1;
  }
};

/**
 * Get classification (weak/struggling/strong/mastered)
 */
TopicMasterySchema.methods.getClassification = function() {
  if (this.masteryPct >= 75) return "mastered";
  if (this.masteryPct >= 60) return "strong";
  if (this.masteryPct >= 40) return "struggling";
  return "weak";
};

// ==============================
// STATICS
// ==============================

/**
 * Get or create mastery record
 */
TopicMasterySchema.statics.getOrCreate = async function({ userId, organization, subject, topic, grade }) {
  let record = await this.findOne({ userId, organization, subject, topic, grade });
  
  if (!record) {
    record = await this.create({
      userId,
      organization,
      subject,
      topic,
      grade,
      totalAttempted: 0,
      totalCorrect: 0,
      masteryPct: 0,
      currentDifficulty: 1,
      recentAttempts: []
    });
  }

  return record;
};

/**
 * Get all masteries for a student in a subject
 */
TopicMasterySchema.statics.getStudentMastery = async function(userId, subject, grade) {
  return this.find({ userId, subject, grade })
    .sort({ masteryPct: 1, topic: 1 })
    .lean();
};

/**
 * Get knowledge map for visualization
 */
TopicMasterySchema.statics.getKnowledgeMap = async function(userId, subject, grade) {
  const topics = await this.find({ userId, subject, grade })
    .sort({ topic: 1 })
    .lean();

  return topics.map(t => ({
    topic: t.topic,
    masteryPct: t.masteryPct,
    totalAttempted: t.totalAttempted,
    currentDifficulty: t.currentDifficulty,
    classification: t.masteryPct >= 75 ? "mastered" : 
                   t.masteryPct >= 60 ? "strong" : 
                   t.masteryPct >= 40 ? "struggling" : "weak",
    needsPractice: t.masteryPct < 75,
    lastAttemptedAt: t.lastAttemptedAt
  }));
};

export default mongoose.models.TopicMastery || mongoose.model("TopicMastery", TopicMasterySchema);
