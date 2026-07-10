// models/eightQTQuiz.js
// A "quiz" is a named way to assemble questions for an attempt.
//
//   mode: "dynamic"  -> draw `size` questions from the bank each attempt
//                       (reshuffled every time). drawStrategy controls spread.
//   mode: "fixed"    -> a curated, admin-titled set of specific questions.
//
// The public flow serves the quiz marked isDefault at /8qt. Fixed quizzes are
// reachable at /8qt/q/:slug. If no quiz exists at all, the routes fall back to
// the original per-quotient behaviour, so nothing breaks before you create one.
import mongoose from "mongoose";

const CODES = ["CsQ", "RQ", "IQ", "PQ", "FQ", "CvQ", "NQ", "TQ"];

const EightQTQuizSchema = new mongoose.Schema({
  title:       { type: String, required: true, trim: true },   // admin-set title
  slug:        { type: String, unique: true, index: true },     // /8qt/q/:slug
  description: { type: String, default: "" },

  mode: { type: String, enum: ["dynamic", "fixed"], default: "dynamic", index: true },

  // ── dynamic mode ──
  size: { type: Number, default: 8, min: 1 },                   // questions per attempt
  drawStrategy: { type: String, enum: ["even", "random"], default: "even" },
  // Optional: restrict a dynamic draw to these quotients (empty = all active)
  quotients: [{ type: String, enum: CODES }],

  // ── fixed mode ──
  questionIds: [{ type: mongoose.Schema.Types.ObjectId, ref: "EightQTQuestion" }],

  // ── behaviour (both modes) ──
  shuffleQuestions: { type: Boolean, default: true },
  shuffleOptions:   { type: Boolean, default: true },

  // ── retake / anti-repeat policy (per quiz) ──
  // retakeDays: participant must wait this many days after finishing before
  //             retaking THIS quiz. 0 = no cooldown.
  retakeDays: { type: Number, default: 0, min: 0 },
  // maxAttemptsPerPerson: hard cap on finished attempts per person for this
  //             quiz (matched by userId / session code / IP). 0 = unlimited.
  maxAttemptsPerPerson: { type: Number, default: 0, min: 0 },
  // avoidRepeatQuestions (dynamic mode only): exclude questions this person
  //             has already been served in previous attempts on this quiz,
  //             so every retake draws fresh material until the bank is
  //             exhausted (then it gracefully resets).
  avoidRepeatQuestions: { type: Boolean, default: true },

  // ── scheduling window (optional, both modes) ──
  // Lets admins rotate quizzes: outside [opensAt, closesAt] the quiz refuses
  // new attempts with a clear message. Null = always open on that side.
  opensAt:  { type: Date, default: null },
  closesAt: { type: Date, default: null },

  // ── provenance ──
  // When a quiz was created from a CSV upload, this links it to that upload's
  // question batch (EightQTQuestion.importBatch) for preview/cleanup.
  importBatch: { type: String, default: null, index: true },

  active:    { type: Boolean, default: true, index: true },
  isDefault: { type: Boolean, default: false, index: true },    // served at /8qt

  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null }
}, { timestamps: true });

// Auto-slug from title if not supplied
EightQTQuizSchema.pre("validate", function (next) {
  if (!this.slug && this.title) {
    this.slug = String(this.title).toLowerCase()
      .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60)
      || ("quiz-" + Date.now());
  }
  next();
});

export default mongoose.models.EightQTQuiz ||
  mongoose.model("EightQTQuiz", EightQTQuizSchema);