// models/attempt.js
import mongoose from "mongoose";

const AnswerSub = new mongoose.Schema(
  {
    questionId: { type: mongoose.Schema.Types.Mixed, required: true }, // ObjectId or string token
    choiceIndex: { type: Number, default: null }, // original order index
    shownIndex: { type: Number, default: null }, // UI shown index
    selectedText: { type: String, default: "" },
    correctIndex: { type: Number, default: null },
    correct: { type: Boolean, default: false }
  },
  { _id: false }
);

const AttemptSchema = new mongoose.Schema(
  {
    examId: { type: String, index: true },

    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", index: true, default: null },
    organization: { type: mongoose.Schema.Types.ObjectId, ref: "Organization", index: true, default: null },

    module: { type: String, default: null },
    modules: [{ type: String }],

    learnerProfileId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "LearnerProfile",
      index: true,
      default: null
    },

    quizTitle: { type: String, default: null },

    score: { type: Number, default: 0 },
    maxScore: { type: Number, default: 0 },

    // IMPORTANT: your code references attempt.percentage; make it first-class
    percentage: { type: Number, default: 0, index: true },

    passed: { type: Boolean, default: false },
    status: { type: String, default: "in_progress" }, // in_progress | finished

    questionIds: [{ type: mongoose.Schema.Types.Mixed }],
    answers: [AnswerSub],

    startedAt: { type: Date, default: null },
    finishedAt: { type: Date, default: null },

    duration: {
      hours: { type: Number, default: 0 },
      minutes: { type: Number, default: 0 },
      seconds: { type: Number, default: 0 },
      totalSeconds: { type: Number, default: 0 }
    },

    // PUBLIC CREATOR CAMPAIGN TRACKING
    isPublic: { type: Boolean, default: false, index: true },
    creator: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null, index: true },
    campaignId: { type: mongoose.Schema.Types.ObjectId, ref: "CreatorCampaign", default: null, index: true },
    shareId: { type: String, default: null, index: true }, // attribution token (optional)
    source: { type: String, default: null, index: true }, // "tiktok", "whatsapp", etc.

  publicParticipant: {
  name: { type: String, default: "" },
  grade: { type: Number, default: null },
  phone: { type: String, default: "" },
  school: { type: String, default: "" },

  // ✅ add this (THIS is the missing field)
  participantCode: { type: String, default: "" }
},

    attemptIp: { type: String, default: null }
  },
  { timestamps: true }
);

export default mongoose.models.Attempt || mongoose.model("Attempt", AttemptSchema);
