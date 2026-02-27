// models/battle.js
import mongoose from "mongoose";

/**
 * Battle = a public competition event (Arena / Blitz).
 * It does NOT replace your quiz system — it creates ExamInstances that reuse /lms/quiz.
 */
const BattleSchema = new mongoose.Schema(
  {
    status: {
      type: String,
    enum: ["draft", "scheduled", "open", "locked", "settling", "ended"],
default: "scheduled",
      index: true
    },

    mode: {
      type: String,
      enum: ["arena_blitz"], // MVP
      default: "arena_blitz",
      index: true
    },

    title: { type: String, required: true },

    // Category like "soccer", "general_knowledge", etc.
    category: { type: String, required: true, lowercase: true, index: true },

    // Entry fee in cents to avoid float issues (USD)
    entryFeeCents: { type: Number, default: 100, min: 0 },

    // Winner pool split as % (must sum <= 100)
    platformFeePct: { type: Number, default: 30, min: 0, max: 100 },

    // Minimum entrants required before battle can lock/start
    minEntries: { type: Number, default: 20, min: 2 },

    // Schedule
    opensAt: { type: Date, required: true, index: true },
    locksAt: { type: Date, required: true, index: true },
    endsAt: { type: Date, required: true, index: true },

    // Quiz settings
    durationMinutes: { type: Number, default: 5, min: 1, max: 60 },
    questionCount: { type: Number, default: 10, min: 3, max: 50 },

    // Where questions come from (MVP: use Question bank by subject/topic)
    // Keep it flexible without breaking current LMS
quiz: {
  subject: { type: String, default: "general", lowercase: true },
  grade: { type: Number, default: 0 }, // 0 = mixed
  difficulty: { type: Number, default: 2, min: 1, max: 5 }, // numeric 1–5
  topics: { type: [String], default: [] },

  // "bank" = Question collection only
  // "ai"   = AIQuiz collection only
  // "mixed"= try bank first then AI fallback
  source: { type: String, enum: ["bank", "ai", "mixed"], default: "mixed" }
},

    // Selected question ids locked for fairness (everyone gets same set)
    //lockedQuestionIds: { type: [mongoose.Schema.Types.ObjectId], default: [] },
    lockedQuestionIds: [{ type: String }],

    // Stats
    entryCount: { type: Number, default: 0 },
    settledAt: { type: Date, default: null }
  },
  { timestamps: true }
);

BattleSchema.index({ status: 1, opensAt: 1, locksAt: 1 });

export default mongoose.models.Battle || mongoose.model("Battle", BattleSchema);