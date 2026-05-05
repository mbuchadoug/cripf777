// models/schoolProfile.js
import mongoose from "mongoose";
import { computeSchoolFeeRange } from "../services/schoolPlans.js";

// ─────────────────────────────────────────────────────────────────────────────
// FEE MODEL — Zimbabwe private school structure
//
// schoolFees[] is the canonical fee store. Each item represents one line on
// the school's fee schedule exactly as Zimbabwean schools present it.
//
// appliesTo values (school levels in Zimbabwe):
//   "nursery"   – Baby Class / Nursery (age ~3)
//   "ecd_a"     – ECD A (age ~4)
//   "ecd_b"     – ECD B (age ~5, pre-Grade 1)
//   "grade1_4"  – Lower Primary: Grades 1–4
//   "grade5_7"  – Upper Primary: Grades 5–7
//   "primary"   – Primary Grades 1–7 (when not split lower/upper)
//   "form1_4"   – O-Level: Form 1–4
//   "form5_6"   – A-Level: Form 5–6 / Upper 6
//   "boarding"  – Boarding (accommodation + meals, any level)
//   "transport" – School bus / transport
//   "all"       – School-wide (levies, registration)
//
// feeType values:
//   "tuition"      – Regular term tuition
//   "boarding"     – Boarding accommodation + meals
//   "transport"    – School bus
//   "development"  – Development levy
//   "sports"       – Sports levy
//   "it"           – IT / Computer levy
//   "library"      – Library levy
//   "exam"         – Exam / assessment fees
//   "registration" – Once-off admission fee
//   "caution"      – Refundable boarding deposit
//   "uniform"      – Uniform estimate
//   "other"        – Custom / other fee
//
// per values:
//   "term"     – charged each term (most tuition)
//   "year"     – charged once per year (most levies)
//   "once_off" – charged once ever (registration, caution)
// ─────────────────────────────────────────────────────────────────────────────

const schoolFeeItemSchema = new mongoose.Schema({
  id:        { type: String, default: () => Date.now().toString(36) + Math.random().toString(36).slice(2,5) },
  label:     { type: String, required: true },
  appliesTo: { type: String, default: "all" },
  feeType:   { type: String, default: "tuition" },
  amount:    { type: Number, default: 0 },
  per:       { type: String, enum: ["term","year","once_off"], default: "term" },
  note:      { type: String, default: "" },
}, { _id: false });

// Legacy sub-schemas (kept for backward compat)
const termFeesSchema = new mongoose.Schema({
  term1: { type: Number, default: 0 },
  term2: { type: Number, default: 0 },
  term3: { type: Number, default: 0 }
}, { _id: false });

// ── FAQ attachment sub-schema ─────────────────────────────────────────────────
// Supports PDFs, PNG, JPG, JPEG, WEBP attached to a Q&A item.
// Stored in GridFS (faqAttachments bucket). Sent to parents on WhatsApp.
const faqAttachmentSchema = new mongoose.Schema({
  id:           { type: String, default: () => Date.now().toString(36) + Math.random().toString(36).slice(2,5) },
  label:        { type: String, default: "Attachment" },
  url:          { type: String, default: "" },      // public serving URL
  fileId:       { type: String, default: "" },      // GridFS file _id (as string)
  filename:     { type: String, default: "" },      // GridFS filename
  originalName: { type: String, default: "" },
  mimeType:     { type: String, default: "" },
  type:         { type: String, enum: ["pdf","image","other"], default: "other" },
  uploadedAt:   { type: Date, default: Date.now }
}, { _id: false });

const schoolProfileSchema = new mongoose.Schema({

  // ── Identity ───────────────────────────────────────────────────────────────
  phone:          { type: String, required: true, unique: true, index: true },
  contactPhone:   { type: String, default: "" },
  schoolName:     { type: String, required: true },
  principalName:  { type: String, default: "" },
  deputyName:     { type: String, default: "" },
  email:          { type: String, default: "" },
  website:        { type: String, default: "" },
  logoUrl:        { type: String, default: "" },

  // ── Location ───────────────────────────────────────────────────────────────
  city:    { type: String, required: true, index: true },
  suburb:  { type: String, default: "", index: true },
  address: { type: String, default: "" },

  // ── Academic profile ───────────────────────────────────────────────────────
  type:       { type: String, enum: ["ecd","ecd_primary","primary","secondary","combined"], default: "combined" },
  curriculum: { type: [String], default: [] },
  gender:     { type: String, enum: ["mixed","boys","girls"], default: "mixed" },
  boarding:   { type: String, enum: ["day","boarding","both"], default: "day" },
  grades: {
    from: { type: String, default: "ECD A" },
    to:   { type: String, default: "Form 6" }
  },

  // ── Preschool levels offered ───────────────────────────────────────────────
  // Each is independently toggled — a school may have Nursery + ECD B but not ECD A
  preschoolLevels: {
    nursery: { type: Boolean, default: false },
    ecd_a:   { type: Boolean, default: false },
    ecd_b:   { type: Boolean, default: false },
  },

  capacity:     { type: Number, default: 0 },
  studentCount: { type: Number, default: 0 },
  officeHours:  { type: String, default: "" },

  // ── Fee schedule (canonical) ───────────────────────────────────────────────
  schoolFees: { type: [schoolFeeItemSchema], default: [] },

  // Computed for search — do not set manually
  feeRange: { type: String, enum: ["budget","mid","premium",""], default: "" },

  // Payment info (shown to parents in fee answers)
  paymentMethods: { type: [String], default: [] },
  ecocashNumber:  { type: String, default: "" },
  bankDetails:    { type: String, default: "" },
  feeDiscounts:   { type: String, default: "" },
  bursaryInfo:    { type: String, default: "" },
  feeSchedulePdfUrl: { type: String, default: "" },

  // ── Legacy fee fields (auto-synced from schoolFees, kept for compat) ───────
  feeSections: {
    ecd:          { day: termFeesSchema, boarding: termFeesSchema },
    lowerPrimary: { day: termFeesSchema, boarding: termFeesSchema },
    upperPrimary: { day: termFeesSchema, boarding: termFeesSchema },
    primary:      { day: termFeesSchema, boarding: termFeesSchema },
    olevel:       { day: termFeesSchema, boarding: termFeesSchema },
    alevel:       { day: termFeesSchema, boarding: termFeesSchema },
  },
  levies: [{
    name:     { type: String },
    amount:   { type: Number, default: 0 },
    per:      { type: String, enum: ["term","year","once_off"], default: "year" },
    sections: { type: [String], default: [] }
  }],
  admissionFee:    { type: Number, default: 0 },
  cautionMoney:    { type: Number, default: 0 },
  uniformEstimate: { type: Number, default: 0 },
  fees: {
    term1: { type: Number, default: 0 }, term2: { type: Number, default: 0 }, term3: { type: Number, default: 0 },
    currency: { type: String, default: "USD" },
    boardingTerm1: { type: Number, default: 0 }, boardingTerm2: { type: Number, default: 0 }, boardingTerm3: { type: Number, default: 0 },
    ecdTerm1: { type: Number, default: 0 }, ecdTerm2: { type: Number, default: 0 }, ecdTerm3: { type: Number, default: 0 },
  },

  // ── Facilities & activities ────────────────────────────────────────────────
  facilities:           { type: [String], default: [] },
  extramuralActivities: { type: [String], default: [] },
  sportsAchievements:   { type: String, default: "" },

  // ── Admissions ────────────────────────────────────────────────────────────
  admissionsOpen:          { type: Boolean, default: true },
  registrationLink:        { type: String, default: "" },
  enrollmentDocs:          { type: String, default: "" },
  ageRequirements:         { type: String, default: "" },
  tourInfo:                { type: String, default: "" },
  boardingInfo:            { type: String, default: "" },
  boardingApplicationInfo: { type: String, default: "" },
  visitingDays:            { type: String, default: "" },

  // ── Academic results ───────────────────────────────────────────────────────
  academicResults: {
    oLevelPassRate:    { type: Number, default: 0 },
    oLevelYear:        { type: String, default: "" },
    oLevel5Plus:       { type: Number, default: 0 },
    aLevelPassRate:    { type: Number, default: 0 },
    aLevelYear:        { type: String, default: "" },
    cambridgePassRate: { type: Number, default: 0 },
    universityEntry:   { type: Number, default: 0 },
    universityInfo:    { type: String, default: "" },
    topSubjects:       { type: String, default: "" },
    nationalRanking:   { type: Number, default: 0 },
    harareRanking:     { type: Number, default: 0 },
  },

  // ── Info fields ────────────────────────────────────────────────────────────
  termCalendar:     { type: String, default: "" },
  uniformInfo:      { type: String, default: "" },
  transportInfo:    { type: String, default: "" },
  transportRoutes:  { type: String, default: "" },
  transportFees:    { type: String, default: "" },
  transportTimes:   { type: String, default: "" },
  transportContact: { type: String, default: "" },
  feedingInfo:      { type: String, default: "" },

  // ── Documents ─────────────────────────────────────────────────────────────
  profilePdfUrl:      { type: String, default: "" },
  applicationFormUrl: { type: String, default: "" },
  brochures: [{
    label:   { type: String, default: "School Brochure" },
    url:     { type: String, required: true },
    addedAt: { type: Date, default: Date.now }
  }],

  // ── ZimQuote tracking ─────────────────────────────────────────────────────
  zqSlug:            { type: String, unique: true, sparse: true },
  zqLinkViews:       { type: Number, default: 0 },
  zqLinkConversions: { type: Number, default: 0 },

  // ── Subscription ──────────────────────────────────────────────────────────
  active:             { type: Boolean, default: false, index: true },
  verified:           { type: Boolean, default: false },
  tier:               { type: String, enum: ["basic","featured",""], default: "" },
  subscriptionPlan:   { type: String, default: "" },
  subscriptionEndsAt: { type: Date, default: null },

  // ── Analytics ─────────────────────────────────────────────────────────────
  monthlyViews: { type: Number, default: 0 },
  inquiries:    { type: Number, default: 0 },

  // ── FAQ & Enquiry Assistant ────────────────────────────────────────────────
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
    // Legacy single-attachment fields (kept for compat)
    pdfUrl:             { type: String, default: "" },
    pdfLabel:           { type: String, default: "" },
    // Multi-attachment support (PDF, PNG, JPG, JPEG, WEBP)
    attachments:        { type: [faqAttachmentSchema], default: [] },
    active:             { type: Boolean, default: true },
    order:              { type: Number, default: 0 },
    isDefault:          { type: Boolean, default: false },
    editedDefault:      { type: Boolean, default: false },
    overridesDefaultId: { type: String, default: "" },
    actionType:         { type: String, default: "" }
  }],

  // ── Ratings ───────────────────────────────────────────────────────────────
  rating: { type: Number, default: 0 }, reviewCount: { type: Number, default: 0 }, qualityScore: { type: Number, default: 0 }

}, { timestamps: true });

// ─────────────────────────────────────────────────────────────────────────────
// PRE-SAVE: compute feeRange, sync legacy fields, auto-set preschoolLevels
// ─────────────────────────────────────────────────────────────────────────────
schoolProfileSchema.pre("save", function (next) {
  const sf = this.schoolFees || [];

  // Helper: find tuition amount for given appliesTo level(s)
  const tuitionFor = (...levels) => {
    for (const lvl of levels) {
      const f = sf.find(x => x.appliesTo === lvl && x.feeType === "tuition" && x.amount > 0);
      if (f) return f.amount;
    }
    return 0;
  };

  if (sf.length > 0) {
    // Auto-set preschoolLevels flags from schoolFees
    if (!this.preschoolLevels) this.preschoolLevels = {};
    this.preschoolLevels.nursery = sf.some(f => f.appliesTo === "nursery" && f.amount > 0);
    this.preschoolLevels.ecd_a   = sf.some(f => f.appliesTo === "ecd_a"   && f.amount > 0);
    this.preschoolLevels.ecd_b   = sf.some(f => f.appliesTo === "ecd_b"   && f.amount > 0);

    // Representative amount for feeRange (primary > olevel > ecd > alevel)
    const repAmt =
      tuitionFor("grade5_7","grade1_4","primary") ||
      tuitionFor("form1_4") ||
      tuitionFor("ecd_b","ecd_a","nursery") ||
      tuitionFor("form5_6");
    if (repAmt > 0) this.feeRange = computeSchoolFeeRange(repAmt);

    // Sync schoolFees → legacy fees fields
    const primaryAmt  = tuitionFor("grade1_4","grade5_7","primary") || tuitionFor("form1_4") || 0;
    const boardingAmt = sf.find(f => f.feeType === "boarding" && f.amount > 0)?.amount || 0;
    const ecdAmt      = tuitionFor("ecd_b","ecd_a","nursery") || 0;
    this.fees = {
      term1: primaryAmt, term2: primaryAmt, term3: primaryAmt, currency: "USD",
      boardingTerm1: boardingAmt, boardingTerm2: boardingAmt, boardingTerm3: boardingAmt,
      ecdTerm1: ecdAmt, ecdTerm2: ecdAmt, ecdTerm3: ecdAmt
    };
    const admFee = sf.find(f => f.feeType === "registration")?.amount || 0;
    const caution = sf.find(f => f.feeType === "caution")?.amount || 0;
    if (admFee)   this.admissionFee = admFee;
    if (caution)  this.cautionMoney = caution;
  } else {
    // Legacy feeSections path — backward compat
    const fs = this.feeSections;
    if (fs) {
      const rep =
        fs.primary?.day?.term1 > 0     ? fs.primary.day :
        fs.olevel?.day?.term1  > 0     ? fs.olevel.day  :
        fs.upperPrimary?.day?.term1 > 0 ? fs.upperPrimary.day :
        fs.lowerPrimary?.day?.term1 > 0 ? fs.lowerPrimary.day :
        fs.ecd?.day?.term1 > 0         ? fs.ecd.day : null;
      if (rep && rep.term1 > 0) this.feeRange = computeSchoolFeeRange(rep.term1);
    }
    if (!this.feeRange && this.fees?.term1 > 0) {
      this.feeRange = computeSchoolFeeRange(this.fees.term1);
    }
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
schoolProfileSchema.index({ "preschoolLevels.nursery": 1, city: 1, active: 1 });
schoolProfileSchema.index({ "preschoolLevels.ecd_a":   1, city: 1, active: 1 });
schoolProfileSchema.index({ "preschoolLevels.ecd_b":   1, city: 1, active: 1 });

export default mongoose.model("SchoolProfile", schoolProfileSchema);