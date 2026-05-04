// models/schoolProfile.js
import mongoose from "mongoose";
import { computeSchoolFeeRange } from "../services/schoolPlans.js";

// ─────────────────────────────────────────────────────────────────────────────
// FEE STRUCTURE
// Zimbabwe private schools charge fees per school section, not a single rate.
// Sections that exist depend on the school type:
//
//   ECD only:         ecd
//   Primary only:     primary (some split lower/upper)
//   Secondary only:   olevel, alevel
//   Combined:         ecd + primary + olevel + alevel
//   ECD+Primary:      ecd + primary
//
// Each section has: term1, term2, term3 (USD)
// Boarding fees are also per section (e.g. O-Level boarders pay differently to A-Level)
// Once-off fees: registration/admission fee, caution money (refundable deposit)
// Annual levies: development, sports, IT, library, exam
//
// The feeRange (budget/mid/premium) is computed from the primary day fee,
// or O-Level if no primary, or ECD if ECD-only. This gives a fair comparison.
// ─────────────────────────────────────────────────────────────────────────────

// Sub-schema: one section's term fees
const termFeesSchema = new mongoose.Schema({
  term1: { type: Number, default: 0 },
  term2: { type: Number, default: 0 },
  term3: { type: Number, default: 0 }
}, { _id: false });

// Sub-schema: a once-off or annual levy
const levySchema = new mongoose.Schema({
  name:     { type: String, required: true },   // "Development", "Sports", "IT", "Library", "Exam"
  amount:   { type: Number, default: 0 },
  per:      { type: String, enum: ["term", "year", "once_off"], default: "year" },
  sections: { type: [String], default: [] }     // [] means all sections; else ["primary","olevel"]
}, { _id: false });

const schoolProfileSchema = new mongoose.Schema({

  // ── Identity ──────────────────────────────────────────────────────────────
  phone:          { type: String, required: true, unique: true, index: true },
  contactPhone:   { type: String, default: "" },
  schoolName:     { type: String, required: true },
  principalName:  { type: String, default: "" },
  deputyName:     { type: String, default: "" },
  email:          { type: String, default: "" },
  website:        { type: String, default: "" },
  logoUrl:        { type: String, default: "" },

  // ── Location ──────────────────────────────────────────────────────────────
  city:    { type: String, required: true, index: true },
  suburb:  { type: String, default: "", index: true },
  address: { type: String, default: "" },

  // ── Academic profile ──────────────────────────────────────────────────────
  type:        { type: String, enum: ["ecd","ecd_primary","primary","secondary","combined"], default: "combined" },
  curriculum:  { type: [String], default: [] },     // ["zimsec","cambridge"]
  gender:      { type: String, enum: ["mixed","boys","girls"], default: "mixed" },
  boarding:    { type: String, enum: ["day","boarding","both"], default: "day" },
  grades: {
    from: { type: String, default: "ECD A" },
    to:   { type: String, default: "Form 6" }
  },
  capacity:      { type: Number, default: 0 },
  studentCount:  { type: Number, default: 0 },
  officeHours:   { type: String, default: "" },

  // ── Fee structure (section-based) ─────────────────────────────────────────
  //
  //  SECTIONS (all are optional — only populate sections the school has):
  //
  //    feeSections.ecd       – ECD A / ECD B (preschool)
  //    feeSections.lowerPrimary  – Grades 1–4 (optional split from primary)
  //    feeSections.upperPrimary  – Grades 5–7 (optional split from primary)
  //    feeSections.primary   – Grades 1–7 (used when no lower/upper split)
  //    feeSections.olevel    – Form 1–4
  //    feeSections.alevel    – Form 5–6 / Upper 6
  //
  //  Each section has day fees and, if school has boarding, boarding fees.
  //
  feeSections: {
    ecd:           { day: termFeesSchema, boarding: termFeesSchema },
    lowerPrimary:  { day: termFeesSchema, boarding: termFeesSchema },
    upperPrimary:  { day: termFeesSchema, boarding: termFeesSchema },
    primary:       { day: termFeesSchema, boarding: termFeesSchema },
    olevel:        { day: termFeesSchema, boarding: termFeesSchema },
    alevel:        { day: termFeesSchema, boarding: termFeesSchema },
  },

  // ── Levies (school-wide or section-specific) ───────────────────────────────
  levies: { type: [levySchema], default: [] },

  // ── Once-off fees ─────────────────────────────────────────────────────────
  admissionFee:   { type: Number, default: 0 },   // one-time registration/admission fee
  cautionMoney:   { type: Number, default: 0 },   // refundable deposit (boarding mainly)
  uniformEstimate:{ type: Number, default: 0 },   // rough cost of full uniform set

  // ── Legacy flat fee fields (kept for backward compatibility) ──────────────
  // These are auto-populated from feeSections for older code paths.
  fees: {
    term1: { type: Number, default: 0 },
    term2: { type: Number, default: 0 },
    term3: { type: Number, default: 0 },
    currency: { type: String, default: "USD" },
    boardingTerm1: { type: Number, default: 0 },
    boardingTerm2: { type: Number, default: 0 },
    boardingTerm3: { type: Number, default: 0 },
    ecdTerm1: { type: Number, default: 0 },
    ecdTerm2: { type: Number, default: 0 },
    ecdTerm3: { type: Number, default: 0 },
  },

  // Auto-computed: "budget" | "mid" | "premium"
  feeRange: { type: String, enum: ["budget","mid","premium",""], default: "" },

  // Payment methods
  paymentMethods: { type: [String], default: [] },  // ["EcoCash","InnBucks","bank","cash"]
  ecocashNumber:  { type: String, default: "" },
  bankDetails:    { type: String, default: "" },     // "CBZ, Acc: 12345678"
  feeDiscounts:   { type: String, default: "" },     // free text: sibling discounts etc.
  bursaryInfo:    { type: String, default: "" },

  // ── Facilities & activities ───────────────────────────────────────────────
  facilities:           { type: [String], default: [] },
  extramuralActivities: { type: [String], default: [] },
  sportsAchievements:   { type: String, default: "" },

  // ── Admissions ────────────────────────────────────────────────────────────
  admissionsOpen:     { type: Boolean, default: true },
  registrationLink:   { type: String, default: "" },
  enrollmentDocs:     { type: String, default: "" },
  ageRequirements:    { type: String, default: "" },
  tourInfo:           { type: String, default: "" },
  boardingInfo:       { type: String, default: "" },
  boardingApplicationInfo: { type: String, default: "" },
  visitingDays:       { type: String, default: "" },

  // ── Academic results ──────────────────────────────────────────────────────
  academicResults: {
    oLevelPassRate:  { type: Number, default: 0 },
    oLevelYear:      { type: String, default: "" },
    oLevel5Plus:     { type: Number, default: 0 },
    aLevelPassRate:  { type: Number, default: 0 },
    aLevelYear:      { type: String, default: "" },
    cambridgePassRate: { type: Number, default: 0 },
    universityEntry: { type: Number, default: 0 },
    universityInfo:  { type: String, default: "" },
    topSubjects:     { type: String, default: "" },
    nationalRanking: { type: Number, default: 0 },
    harareRanking:   { type: Number, default: 0 },
  },

  // ── Calendar ──────────────────────────────────────────────────────────────
  termCalendar:    { type: String, default: "" },
  uniformInfo:     { type: String, default: "" },
  transportInfo:   { type: String, default: "" },
  transportRoutes: { type: String, default: "" },
  transportFees:   { type: String, default: "" },
  transportTimes:  { type: String, default: "" },
  transportContact:{ type: String, default: "" },
  feedingInfo:     { type: String, default: "" },

  // ── Documents / media ────────────────────────────────────────────────────
  profilePdfUrl:     { type: String, default: "" },
  feeSchedulePdfUrl: { type: String, default: "" },
  applicationFormUrl:{ type: String, default: "" },
  brochures: [{
    label:   { type: String, default: "School Brochure" },
    url:     { type: String, required: true },
    addedAt: { type: Date, default: Date.now }
  }],

  // ── ZimQuote link tracking ────────────────────────────────────────────────
  zqSlug:            { type: String, unique: true, sparse: true },
  zqLinkViews:       { type: Number, default: 0 },
  zqLinkConversions: { type: Number, default: 0 },

  // ── Subscription & listing ────────────────────────────────────────────────
  active:              { type: Boolean, default: false, index: true },
  verified:            { type: Boolean, default: false },
  tier:                { type: String, enum: ["basic","featured",""], default: "" },
  subscriptionPlan:    { type: String, default: "" },
  subscriptionEndsAt:  { type: Date, default: null },

  // ── Analytics ─────────────────────────────────────────────────────────────
  monthlyViews:  { type: Number, default: 0 },
  inquiries:     { type: Number, default: 0 },

  // ── FAQ & Enquiry Assistant ───────────────────────────────────────────────
  faqCategories: [{
    id:     { type: String, required: true },
    name:   { type: String, required: true },
    emoji:  { type: String, default: "❓" },
    order:  { type: Number, default: 0 },
    active: { type: Boolean, default: true }
  }],
  faqItems: [{
    id:                 { type: String, required: true },
    categoryId:         { type: String, required: true },
    question:           { type: String, required: true },
    answer:             { type: String, default: "" },
    pdfUrl:             { type: String, default: "" },
    pdfLabel:           { type: String, default: "" },
    active:             { type: Boolean, default: true },
    order:              { type: Number, default: 0 },
    isDefault:          { type: Boolean, default: false },
    overridesDefaultId: { type: String, default: "" },
    actionType:         { type: String, default: "" }
  }],

  // ── Ratings ───────────────────────────────────────────────────────────────
  rating:       { type: Number, default: 0 },
  reviewCount:  { type: Number, default: 0 },
  qualityScore: { type: Number, default: 0 }

}, { timestamps: true });

// ─────────────────────────────────────────────────────────────────────────────
// PRE-SAVE: Sync feeSections → legacy fees fields + compute feeRange
// This keeps backward compatibility with any code reading school.fees.term1
// ─────────────────────────────────────────────────────────────────────────────
schoolProfileSchema.pre("save", function (next) {
  const fs = this.feeSections;
  if (!fs) { next(); return; }

  // Representative day fee for feeRange computation:
  // Use the most relevant section depending on school type
  const repSection = (
    fs.primary?.day?.term1 > 0  ? fs.primary.day  :
    fs.olevel?.day?.term1  > 0  ? fs.olevel.day   :
    fs.upperPrimary?.day?.term1 > 0 ? fs.upperPrimary.day :
    fs.lowerPrimary?.day?.term1 > 0 ? fs.lowerPrimary.day :
    fs.ecd?.day?.term1     > 0  ? fs.ecd.day      :
    fs.alevel?.day?.term1  > 0  ? fs.alevel.day   :
    null
  );

  if (repSection) {
    // Sync to legacy fees fields
    this.fees = this.fees || {};
    this.fees.term1 = repSection.term1 || 0;
    this.fees.term2 = repSection.term2 || 0;
    this.fees.term3 = repSection.term3 || 0;
    this.fees.currency = "USD";

    // ECD legacy sync
    if (fs.ecd?.day?.term1 > 0) {
      this.fees.ecdTerm1 = fs.ecd.day.term1;
      this.fees.ecdTerm2 = fs.ecd.day.term2 || fs.ecd.day.term1;
      this.fees.ecdTerm3 = fs.ecd.day.term3 || fs.ecd.day.term1;
    }

    // Boarding legacy sync — use olevel boarding if available, else primary
    const brd = fs.olevel?.boarding?.term1 > 0 ? fs.olevel.boarding :
                fs.primary?.boarding?.term1 > 0 ? fs.primary.boarding : null;
    if (brd) {
      this.fees.boardingTerm1 = brd.term1;
      this.fees.boardingTerm2 = brd.term2 || brd.term1;
      this.fees.boardingTerm3 = brd.term3 || brd.term1;
    }

    this.feeRange = computeSchoolFeeRange(repSection.term1);
  } else if (this.fees?.term1) {
    this.feeRange = computeSchoolFeeRange(this.fees.term1);
  }

  next();
});

// ─────────────────────────────────────────────────────────────────────────────
// INDEXES
// ─────────────────────────────────────────────────────────────────────────────
schoolProfileSchema.index({ city: 1, active: 1 });
schoolProfileSchema.index({ city: 1, suburb: 1, active: 1 });
schoolProfileSchema.index({ feeRange: 1, active: 1 });
schoolProfileSchema.index({ type: 1, active: 1 });
schoolProfileSchema.index({ facilities: 1, active: 1 });
schoolProfileSchema.index({ curriculum: 1, active: 1 });
schoolProfileSchema.index({ gender: 1, active: 1 });
schoolProfileSchema.index({ boarding: 1, active: 1 });
schoolProfileSchema.index({ city: 1, type: 1, feeRange: 1, active: 1 });

export default mongoose.model("SchoolProfile", schoolProfileSchema);