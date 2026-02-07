// models/adaptiveQuizConfig.js
import mongoose from "mongoose";

/**
 * AdaptiveQuizConfig stores the rules for generating personalized quizzes.
 * Can be customized per organization or use global defaults.
 * 
 * These weights determine the question distribution in adaptive quizzes:
 * - Weak topics get the most questions (to improve gaps)
 * - Strong topics get some questions (to maintain skills)
 * - Mastered topics get few questions (for confidence)
 */

const AdaptiveQuizConfigSchema = new mongoose.Schema({
  // Organization (null = global default)
  organization: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Organization",
    index: true,
    default: null
  },

  // Human-readable name
  name: {
    type: String,
    default: "Default Adaptive Config"
  },

  // ==============================
  // QUESTION DISTRIBUTION WEIGHTS
  // ==============================
  
  // Percentage of questions from weak topics (< 40% mastery)
  weakWeight: {
    type: Number,
    default: 40,
    min: 0,
    max: 100
  },

  // Percentage from struggling topics (40-59% mastery)
  strugglingWeight: {
    type: Number,
    default: 30,
    min: 0,
    max: 100
  },

  // Percentage from strong topics (60-74% mastery)
  strongWeight: {
    type: Number,
    default: 20,
    min: 0,
    max: 100
  },

  // Percentage from mastered topics (≥75% mastery)
  masteredWeight: {
    type: Number,
    default: 10,
    min: 0,
    max: 100
  },

  // ==============================
  // MASTERY THRESHOLDS
  // ==============================

  // Threshold for "mastered" classification
  masteryThreshold: {
    type: Number,
    default: 75,
    min: 50,
    max: 100
  },

  // Threshold below which topic is "struggling"
  struggleThreshold: {
    type: Number,
    default: 60,
    min: 30,
    max: 80
  },

  // Threshold below which topic is "weak"
  weakThreshold: {
    type: Number,
    default: 40,
    min: 0,
    max: 60
  },

  // ==============================
  // DIFFICULTY PROGRESSION RULES
  // ==============================

  // Minimum attempts before increasing difficulty
  minAttemptsBeforeProgressionUp: {
    type: Number,
    default: 5,
    min: 3,
    max: 10
  },

  // Required mastery to progress to next difficulty
  progressionMasteryRequired: {
    type: Number,
    default: 70,
    min: 60,
    max: 90
  },

  // Whether to allow difficulty regression on poor performance
  allowDifficultyRegression: {
    type: Boolean,
    default: true
  },

  // ==============================
  // QUIZ GENERATION SETTINGS
  // ==============================

  // Default number of questions per quiz
  defaultQuestionCount: {
    type: Number,
    default: 10,
    min: 5,
    max: 50
  },

  // Minimum questions per topic in a quiz
  minQuestionsPerTopic: {
    type: Number,
    default: 2,
    min: 1,
    max: 5
  },

  // Whether to randomize question order
  randomizeQuestions: {
    type: Boolean,
    default: true
  },

  // Whether to randomize choice order within questions
  randomizeChoices: {
    type: Boolean,
    default: true
  },

  // ==============================
  // REVIEW & SPACED REPETITION
  // ==============================

  // Days before reviewing mastered topics
  masteredTopicReviewInterval: {
    type: Number,
    default: 7,
    min: 3,
    max: 30
  },

  // Days before reviewing struggling topics
  strugglingTopicReviewInterval: {
    type: Number,
    default: 2,
    min: 1,
    max: 7
  },

  // ==============================
  // METADATA
  // ==============================

  enabled: {
    type: Boolean,
    default: true,
    index: true
  },

  isDefault: {
    type: Boolean,
    default: false,
    index: true
  },

  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    default: null
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

AdaptiveQuizConfigSchema.index({ organization: 1, enabled: 1 });
AdaptiveQuizConfigSchema.index({ isDefault: 1 });

// ==============================
// VALIDATION
// ==============================

AdaptiveQuizConfigSchema.pre('save', function(next) {
  // Ensure weights sum to 100
  const total = this.weakWeight + this.strugglingWeight + this.strongWeight + this.masteredWeight;
  
  if (Math.abs(total - 100) > 0.01) {
    const err = new Error(`Weights must sum to 100. Current sum: ${total}`);
    return next(err);
  }

  // Ensure thresholds are logical
  if (this.weakThreshold >= this.struggleThreshold) {
    return next(new Error('weakThreshold must be less than struggleThreshold'));
  }

  if (this.struggleThreshold >= this.masteryThreshold) {
    return next(new Error('struggleThreshold must be less than masteryThreshold'));
  }

  this.updatedAt = new Date();
  next();
});

// ==============================
// METHODS
// ==============================

/**
 * Get question distribution for a quiz
 */
AdaptiveQuizConfigSchema.methods.getDistribution = function(totalQuestions) {
  return {
    weak: Math.round((totalQuestions * this.weakWeight) / 100),
    struggling: Math.round((totalQuestions * this.strugglingWeight) / 100),
    strong: Math.round((totalQuestions * this.strongWeight) / 100),
    mastered: Math.round((totalQuestions * this.masteredWeight) / 100)
  };
};

/**
 * Classify a topic based on mastery percentage
 */
AdaptiveQuizConfigSchema.methods.classifyTopic = function(masteryPct) {
  if (masteryPct >= this.masteryThreshold) return "mastered";
  if (masteryPct >= this.struggleThreshold) return "strong";
  if (masteryPct >= this.weakThreshold) return "struggling";
  return "weak";
};

/**
 * Check if student can progress to next difficulty level
 */
AdaptiveQuizConfigSchema.methods.canProgressDifficulty = function(masteryRecord) {
  return masteryRecord.totalAttempted >= this.minAttemptsBeforeProgressionUp &&
         masteryRecord.masteryPct >= this.progressionMasteryRequired;
};

// ==============================
// STATICS
// ==============================

/**
 * Get config for organization (or default)
 */
AdaptiveQuizConfigSchema.statics.getConfig = async function(organizationId = null) {
  // Try to find org-specific config
  if (organizationId) {
    const orgConfig = await this.findOne({ 
      organization: organizationId, 
      enabled: true 
    });
    if (orgConfig) return orgConfig;
  }

  // Fall back to default config
  let defaultConfig = await this.findOne({ 
    isDefault: true, 
    enabled: true 
  });

  // Create default if it doesn't exist
  if (!defaultConfig) {
    defaultConfig = await this.create({
      name: "Global Default Config",
      isDefault: true,
      enabled: true,
      weakWeight: 40,
      strugglingWeight: 30,
      strongWeight: 20,
      masteredWeight: 10,
      masteryThreshold: 75,
      struggleThreshold: 60,
      weakThreshold: 40
    });
  }

  return defaultConfig;
};

/**
 * Create default config if none exists
 */
AdaptiveQuizConfigSchema.statics.ensureDefault = async function() {
  const existing = await this.findOne({ isDefault: true });
  
  if (!existing) {
    return this.create({
      name: "Global Default Config",
      isDefault: true,
      enabled: true,
      weakWeight: 40,
      strugglingWeight: 30,
      strongWeight: 20,
      masteredWeight: 10,
      masteryThreshold: 75,
      struggleThreshold: 60,
      weakThreshold: 40,
      defaultQuestionCount: 10,
      minQuestionsPerTopic: 2,
      randomizeQuestions: true,
      randomizeChoices: true,
      minAttemptsBeforeProgressionUp: 5,
      progressionMasteryRequired: 70,
      allowDifficultyRegression: true,
      masteredTopicReviewInterval: 7,
      strugglingTopicReviewInterval: 2
    });
  }

  return existing;
};

export default mongoose.models.AdaptiveQuizConfig || mongoose.model("AdaptiveQuizConfig", AdaptiveQuizConfigSchema);
