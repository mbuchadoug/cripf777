// models/eightQTAttempt.js
// Stores each participant's 8QT session - registered OR anonymous
import mongoose from "mongoose";

const QuotientScoreSchema = new mongoose.Schema({
  code:  { type: String },
  name:  { type: String },
  raw:   { type: Number, default: 0 },
  max:   { type: Number, default: 0 },
  score: { type: Number, default: 0 },   // 0-100
  band:  { type: String, default: "Emerging" } // Emerging|Developing|Functional|Structural|Recalibrative
}, { _id: false });

const AnswerSchema = new mongoose.Schema({
  questionId:    { type: mongoose.Schema.Types.ObjectId, ref: "EightQTQuestion" },
  quotient:      { type: String },
  selectedIndex: { type: Number, default: null },
  scores:        { type: mongoose.Schema.Types.Mixed, default: {} } // actual points awarded
}, { _id: false });

const EightQTAttemptSchema = new mongoose.Schema({
  // Identity
  userId: {
    type:    mongoose.Schema.Types.ObjectId,
    ref:     "User",
    default: null,
    index:   true
  },

  // Anonymous participant info
  participantCode: { type: String, unique: true, sparse: true, index: true },
  participantName: { type: String, default: "" }, // system-generated e.g. "Thinker-Amber-2847"

  // Pre-test optional profile
  profile: {
    firstName: { type: String, default: "" },
    country:   { type: String, default: "" },
    sector:    { type: String, default: "" }
  },

  // Test state
  status: {
    type:    String,
    enum:    ["in_progress", "finished"],
    default: "in_progress",
    index:   true
  },

  // Which quiz produced this attempt (null = legacy default behaviour)
  quizId:    { type: mongoose.Schema.Types.ObjectId, ref: "EightQTQuiz", default: null, index: true },
  quizTitle: { type: String, default: null },

  // Which questions were served (ordered)
  questionIds: [{ type: mongoose.Schema.Types.ObjectId, ref: "EightQTQuestion" }],
  // Randomised option order per question
  optionsOrder: [[{ type: Number }]],

  // Per-quotient max achievable points for THIS attempt's served questions.
  // Used as the scoring denominator so quiz size can vary without skewing %.
  // Shape: { CsQ: 24, RQ: 6, ... }. Null on legacy attempts (falls back).
  quotientMax: { type: mongoose.Schema.Types.Mixed, default: null },

  answers: [AnswerSchema],

  // Results (populated on finish)
  quotientScores: [QuotientScoreSchema],
  archetypeId: {
    type:    mongoose.Schema.Types.ObjectId,
    ref:     "EightQTArchetype",
    default: null
  },
  archetypeName: { type: String, default: null },

  // Dominant / development edge
  dominantQuotient: { type: String, default: null },
  developmentEdge:  { type: String, default: null },

  // Certificate flow
  certificateStatus: {
    type:    String,
    enum:    ["none", "requested", "paid", "issued"],
    default: "none",
    index:   true
  },
  certificateRequestedAt: { type: Date, default: null },
  // Full name as it should appear on the certificate
  certificateName:  { type: String, default: "" },
  certificateEmail: { type: String, default: "" },
  certificateOrg:   { type: String, default: "" },
  // Whether participant opted to make profile public
  profilePublic: { type: Boolean, default: false },

  // PDF output
  certificatePdfUrl:    { type: String, default: null },
  certificateVerifyCode: { type: String, default: null, index: true, sparse: true },
  certificateIssuedAt:  { type: Date, default: null },

  // Stripe
  stripePurchaseSessionId: { type: String, default: null, index: true, sparse: true },

  // Admin manual issuance audit trail
  // Set when an admin issues a certificate without payment via /admin/8qt/attempts/:id/issue-cert
  adminIssuedBy:  { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  adminIssueNote: { type: String, default: null },

  // Timing
  startedAt:  { type: Date, default: null },
  finishedAt: { type: Date, default: null },

  // Attribution
  attemptIp: { type: String, default: null },
  referrer:  { type: String, default: null }

}, { timestamps: true });

EightQTAttemptSchema.index({ participantCode: 1 });
EightQTAttemptSchema.index({ certificateVerifyCode: 1 });
EightQTAttemptSchema.index({ userId: 1, status: 1 });
// Retake-policy lookups: previous attempts on a quiz by identity
EightQTAttemptSchema.index({ quizId: 1, userId: 1, status: 1 });
EightQTAttemptSchema.index({ quizId: 1, attemptIp: 1, status: 1 });

export default mongoose.models.EightQTAttempt ||
  mongoose.model("EightQTAttempt", EightQTAttemptSchema);