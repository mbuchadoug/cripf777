// models/battleEntry.js
import mongoose from "mongoose";

/**
 * BattleEntry links a user to a battle + their ExamInstance
 * Payment: MVP uses status flags (pending/paid) without touching your payments yet.
 */
const BattleEntrySchema = new mongoose.Schema(
  {
    battleId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Battle",
      required: true,
      index: true
    },
    codeName: {
  type: String,
  default: null,
  index: true
},

payoutEcoCashPhone: {
  type: String,
  default: null
},

payoutName: {
  type: String,
  default: null
},

paidAt: {
  type: Date,
  default: null
},

    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true
    },

    status: {
      type: String,
      enum: ["pending_payment", "paid", "started", "finished", "void"],
      default: "pending_payment",
      index: true
    },

    // The exam instance created for this entry
    examId: { type: String, default: null, index: true }, // ExamInstance.examId

    // Result snapshot (so we can rank without requerying attempts)
    scorePct: { type: Number, default: null },
    correctCount: { type: Number, default: null },
    maxScore: { type: Number, default: null },
    timeTakenSec: { type: Number, default: null },

    // Ranking / payout
    rank: { type: Number, default: null },
    payoutCents: { type: Number, default: 0 }
  },
  { timestamps: true }
);

BattleEntrySchema.index({ battleId: 1, userId: 1 }, { unique: true });

export default mongoose.models.BattleEntry || mongoose.model("BattleEntry", BattleEntrySchema);