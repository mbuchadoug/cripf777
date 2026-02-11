// models/question.js (CORRECTED - NO ARRAY INDEXES IN SCHEMA)
import mongoose from "mongoose";

const ChoiceSchema = new mongoose.Schema({
  label: String,
  text: String
}, { _id: false });

const QuestionSchema = new mongoose.Schema({
  text: { type: String, required: true },

  // for regular questions
  choices: [ChoiceSchema],
  correctIndex: { type: Number, required: function() { return this.type !== 'comprehension'; } },
  title: { type: String, default: null },

  // ==============================
  // 🎯 ADAPTIVE LEARNING FIELDS (cripfcnt-home only)
  // ==============================
  
  // Micro-topic (e.g., "fractions", "multiplication", "verb-tenses")
  topic: {
    type: String,
    lowercase: true,
    trim: true,
    // NO INDEX HERE - created separately in MongoDB
    default: null
  },

  // Subject (math, english, science, responsibility)
  subject: {
    type: String,
    lowercase: true,
    trim: true,
    // NO INDEX HERE - created separately in MongoDB
    default: null
  },

  // Grade level (1-7)
  grade: {
    type: Number,
    min: 1,
    max: 7,
    // NO INDEX HERE - created separately in MongoDB
    default: null
  },

  // Difficulty level (1=easiest, 5=hardest)
  difficulty: {
    type: Number,
    min: 1,
    max: 5,
    default: null
    // NO INDEX HERE - created separately in MongoDB
  },

  // ==============================
  // EXISTING FIELDS
  // ==============================

  // NEW: comprehension parent support
  type: { type: String, enum: ["question","comprehension"], default: "question", index: true },
  passage: { type: String, default: null },
  questionIds: [{ type: mongoose.Schema.Types.ObjectId, ref: "Question" }],

  // metadata
  organization: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: "Organization",
    default: null,
    index: true
  },
  
  // ==============================
  // 📚 MODULES (CRIPFCNT-SCHOOL)
  // ==============================
  // Legacy single module (keep for backward compatibility)
  module: {
    type: String,
    default: "general",
    index: true
  },
  
  // NEW: Multiple modules support for cripfcnt-school
  // ⚠️ CRITICAL: NO INDEX ON ARRAY FIELDS IN SCHEMA
  modules: [{
    type: String,
    lowercase: true,
    trim: true,
    enum: [
      'consciousness',
      'responsibility', 
      'interpretation',
      'purpose',
      'frequencies',
      'civilization',
      'negotiation',
      'technology',
      'general'
    ]
  }],
  
  // ==============================
  // 🏷️ TOPICS (CRIPFCNT-SCHOOL)
  // ==============================
  // Topics are micro-categories within modules
  // ⚠️ CRITICAL: NO INDEX ON ARRAY FIELDS IN SCHEMA
  topics: [{
    type: String,
    lowercase: true,
    trim: true
  }],
  
  // Series/collection identifier (e.g., "foundation-series", "advanced-placement")
  series: {
    type: String,
    lowercase: true,
    trim: true,
    // NO INDEX HERE - created separately in MongoDB
    default: null
  },

  tags: [String],
  source: { type: String, default: "import" },
  raw: { type: String, default: null },
  createdAt: { type: Date, default: () => new Date() },
  updatedAt: { type: Date, default: () => new Date() }
});

// ==============================
// ⚠️ IMPORTANT: INDEXES CREATED SEPARATELY
// ==============================
// DO NOT use .index() in schema for array fields
// Indexes are created via fix-indexes.js script
// This prevents parallel array index errors

// ==============================
// STATIC METHOD FOR BULK TAGGING
// ==============================
QuestionSchema.statics.bulkUpdateTopicsAndDifficulty = async function(updates) {
  const bulkOps = updates.map(update => ({
    updateOne: {
      filter: { _id: update.id },
      update: {
        $set: {
          topic: update.topic,
          difficulty: update.difficulty,
          subject: update.subject || undefined,
          updatedAt: new Date()
        }
      }
    }
  }));

  if (bulkOps.length === 0) {
    return { modifiedCount: 0 };
  }

  return await this.bulkWrite(bulkOps);
};

// ==============================
// EXPORT MODEL
// ==============================
export default mongoose.models.Question || mongoose.model("Question", QuestionSchema);