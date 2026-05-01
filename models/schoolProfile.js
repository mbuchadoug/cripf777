// models/schoolProfile.js
import mongoose from "mongoose";
import { computeSchoolFeeRange } from "../services/schoolPlans.js";

const schoolProfileSchema = new mongoose.Schema({
  // ── Identity ──────────────────────────────────────────────────────────────
  phone:          { type: String, required: true, unique: true, index: true },
  contactPhone:   { type: String, default: "" },   // public-facing number shown to parents
  schoolName:     { type: String, required: true },
  principalName:  { type: String, default: "" },
  email:          { type: String, default: "" },
  website:        { type: String, default: "" },
  logoUrl:        { type: String, default: "" },

  // ── Location ──────────────────────────────────────────────────────────────
  city:    { type: String, required: true, index: true },
  suburb:  { type: String, default: "", index: true },
  address: { type: String, default: "" },

  // ── Academic profile ──────────────────────────────────────────────────────
  type:        { type: String, enum: ["ecd", "ecd_primary", "primary", "secondary", "combined"], default: "combined" },
  curriculum:  { type: [String], default: [] },      // ["zimsec","cambridge"]
  gender:      { type: String, enum: ["mixed","boys","girls"], default: "mixed" },
  boarding:    { type: String, enum: ["day","boarding","both"], default: "day" },
  grades: {
    from: { type: String, default: "ECD A" },
    to:   { type: String, default: "Form 6" }
  },
  capacity:      { type: Number, default: 0 },
  studentCount:  { type: Number, default: 0 },

  // ── Fees ─────────────────────────────────────────────────────────────────
fees: {
    // Day school fees
    term1:    { type: Number, default: 0 },
    term2:    { type: Number, default: 0 },
    term3:    { type: Number, default: 0 },
    currency: { type: String, default: "USD" },
    // Boarding fees - only populated when boarding === "boarding" or "both"
    boardingTerm1: { type: Number, default: 0 },
    boardingTerm2: { type: Number, default: 0 },
    boardingTerm3: { type: Number, default: 0 },
    // ECD fees - only populated when type includes ECD and fees differ from primary
    ecdTerm1: { type: Number, default: 0 },
    ecdTerm2: { type: Number, default: 0 },
    ecdTerm3: { type: Number, default: 0 },
  },
  // Auto-computed from fees.term1 (day fee): "budget" | "mid" | "premium"
  feeRange: { type: String, enum: ["budget","mid","premium",""], default: "" },

  // ── Facilities & activities ───────────────────────────────────────────────
  facilities:           { type: [String], default: [] },
  extramuralActivities: { type: [String], default: [] },

  // ── Admissions ────────────────────────────────────────────────────────────
  admissionsOpen:     { type: Boolean, default: true },
  registrationLink:   { type: String, default: "" },   // online application URL
 profilePdfUrl:      { type: String, default: "" },   // legacy single PDF (kept for compatibility)
  brochures: [{
    label:     { type: String, default: "School Brochure" }, // e.g. "2025 Prospectus", "Fee Schedule"
    url:       { type: String, required: true },             // publicly accessible URL
    addedAt:   { type: Date,   default: Date.now }
  }],
  zqSlug:            { type: String, unique: true, sparse: true },
zqLinkViews:       { type: Number, default: 0 },
zqLinkConversions: { type: Number, default: 0 },

  // ── Subscription & listing ────────────────────────────────────────────────
  active:              { type: Boolean, default: false, index: true },
  verified:            { type: Boolean, default: false },
  tier:                { type: String, enum: ["basic","featured",""], default: "" },
  subscriptionPlan:    { type: String, default: "" },   // "monthly" | "annual"
  subscriptionEndsAt:  { type: Date, default: null },

  // ── Analytics ─────────────────────────────────────────────────────────────
  monthlyViews:  { type: Number, default: 0 },
  inquiries:     { type: Number, default: 0 },

  // ── Ratings ───────────────────────────────────────────────────────────────
  rating:       { type: Number, default: 0 },
  reviewCount:  { type: Number, default: 0 },
  // Composite score 0-100 (computed separately)
  qualityScore: { type: Number, default: 0 }

}, { timestamps: true });

// ── Auto-compute feeRange before every save ──────────────────────────────────
schoolProfileSchema.pre("save", function (next) {
  if (this.fees?.term1 !== undefined) {
    this.feeRange = computeSchoolFeeRange(this.fees.term1);
  }
  next();
});

// ── Indexes for fast parent search queries ────────────────────────────────────
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