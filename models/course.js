// models/course.js
// ─────────────────────────────────────────────────────────────────────────────
// A Course is a LEVEL-1 credential built on a professional AREA
// (e.g. "structural-responsibility"). An admin selects which of the area's
// comprehension quizzes (passages) count toward it, optionally grouped into
// Units (which usually map to your existing `series`). Completion of the course
// issues the Certificate of Competence.
//
// This model sits ON TOP of your existing Question/Attempt data. It never
// changes how a single quiz is taken - it only defines which quizzes form a
// course and what standard passes it.
//
// Legacy note: this is standalone. It does NOT use the old Quiz/Lesson models.
// ─────────────────────────────────────────────────────────────────────────────
import mongoose from "mongoose";

const UnitSchema = new mongoose.Schema({
  title: { type: String, required: true },        // e.g. "Ai Energy Fiduciary Responsibility"
  seriesSlug: { type: String, default: null },    // optional link to Question.series
  order: { type: Number, default: 0 },
  // Selected comprehension passages (Question _ids) that make up this unit
  quizIds: [{ type: mongoose.Schema.Types.ObjectId, ref: "Question" }]
}, { _id: true });

const GradeBandSchema = new mongoose.Schema({
  label: { type: String, required: true },   // "Pass" | "Merit" | "Distinction"
  min: { type: Number, required: true }        // inclusive lower bound on overall %
}, { _id: false });

const CourseSchema = new mongoose.Schema({
  // ── Identity ────────────────────────────────────────────────────────────
  professionalArea: { type: String, required: true, index: true }, // category slug
  areaLabel: { type: String, default: null },     // "Structural Responsibility"
  title: { type: String, required: true },        // course title (may match area)
  slug: { type: String, required: true, unique: true, index: true },
  description: { type: String, default: "" },
  level: { type: String, enum: ["foundation", "intermediate", "advanced"], default: "foundation" },

  org: { type: mongoose.Schema.Types.ObjectId, ref: "Organization", index: true, default: null },

  // Persona this course is taken under (multi-role app). Availability is gated
  // in the route by whether the user has this persona.
  role: { type: String, default: "professional", index: true },

  // ── Content: ordered units, each holding selected quizzes ─────────────────
  units: [UnitSchema],

  // ── Completion rules (the "seven numbers") ───────────────────────────────
  rules: {
    // % a single quiz must reach to count as "passed" (best attempt)
    perQuizPassMark: { type: Number, default: 70 },
    // BREADTH gate: how many selected quizzes must be individually passed.
    // null = all selected quizzes required.
    minQuizzesToPass: { type: Number, default: null },
    // Optional stricter breadth: minimum passed PER unit (null = ignore)
    minPerUnit: { type: Number, default: null },
    // DEPTH gate: weighted overall average that must be met
    overallPassMark: { type: Number, default: 70 },
    // Grade classification on the overall %
    gradeBands: {
      type: [GradeBandSchema],
      default: () => ([
        { label: "Pass", min: 70 },
        { label: "Merit", min: 80 },
        { label: "Distinction", min: 90 }
      ])
    },
    // Attempt policy
    maxAttempts: { type: Number, default: 3 },        // per quiz
    cooldownHours: { type: Number, default: 24 },     // between attempts on same quiz
    scoreModel: { type: String, enum: ["best", "latest"], default: "best" }
  },

  // How quizzes are weighted in the overall average
  weighting: { type: String, enum: ["equal", "by_difficulty"], default: "equal" },

  published: { type: Boolean, default: false, index: true },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },

  // ── Enrollment & pricing ─────────────────────────────────────────────────
  // free   → self-enroll, instant active
  // paid   → self-enroll then pay (EcoCash / card) OR admin comps them
  // invite → admin enrolls/activates only
  accessType: { type: String, enum: ["free", "paid", "invite"], default: "free", index: true },
  price: { type: Number, default: 0 },
  currency: { type: String, default: "USD" },
  // Master switch for self-enrollment (admins can always enroll people)
  enrollmentOpen: { type: Boolean, default: true }
}, { timestamps: true });

// Total number of selected quizzes across all units
CourseSchema.virtual("totalQuizzes").get(function () {
  return (this.units || []).reduce((n, u) => n + ((u.quizIds || []).length), 0);
});

// Flat list of all quiz ids in the course (handy for progress checks)
CourseSchema.methods.allQuizIds = function () {
  const ids = [];
  for (const u of (this.units || [])) for (const q of (u.quizIds || [])) ids.push(q);
  return ids;
};

CourseSchema.set("toJSON", { virtuals: true });
CourseSchema.set("toObject", { virtuals: true });

export default mongoose.models.Course || mongoose.model("Course", CourseSchema);