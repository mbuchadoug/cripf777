import mongoose from "mongoose";

const SpecialScoiAuditSchema = new mongoose.Schema({
  framework: {
    type: String,
    default: "CRIPFCnt SCOI"
  },

  auditClass: {
    type: String,
    default: "special_report",
    immutable: true
  },

  auditType: {
    type: String,
    required: true
  },

  // ── Display title / series identity ──────────────────────────────────────
  // title is shown on the cover, marketplace card, admin lists, Stripe product
  // name and PDF filename. Falls back to subject.name when absent.
  title:        String,
  subtitle:     String,
  reportCode:   String,
  presentation: mongoose.Schema.Types.Mixed,   // { theme, watermark, badge, edition, classification }
  marketplace:  mongoose.Schema.Types.Mixed,   // { summary, features[] }

  subject: {
    name:         String,
    entityType:   String,
    entityScope:  String,     // ← full scope description
    sectorContext: String,    // ← sector / industry context
    jurisdiction: String      // ← geographic jurisdiction
  },

  // ── assessmentWindow ──────────────────────────────────────────────────────
  // Must be Mixed because the JSON embeds a "type" key which Mongoose
  // misreads as a schema-type directive, causing cast errors.
  assessmentWindow: mongoose.Schema.Types.Mixed,

  // ── assessmentDate ────────────────────────────────────────────────────────
  // Used by cumulative audits (Lawyer-style) instead of assessmentWindow.
  assessmentDate: mongoose.Schema.Types.Mixed,

  author:         String,
  purpose:        String,
  status:         String,
  revisionPolicy: String,

  // ── matrix ────────────────────────────────────────────────────────────────
  // e.g. "dual" - analytical matrix descriptor shown on cover and in profile
  matrix: String,

  // ── Core doctrine ─────────────────────────────────────────────────────────
  coreDoctrine: mongoose.Schema.Types.Mixed,

  // ── Top-level coreFinding ─────────────────────────────────────────────────
  // Lawyer-style audits place the core finding at root level.
  coreFinding: String,

  // ── CRIPFCnt interpretation block ─────────────────────────────────────────
  // Includes: summary, keyDoctrine, structuralLesson[]
  CRIPFCntInterpretation: mongoose.Schema.Types.Mixed,

  // ── Temporal / cumulative fields ──────────────────────────────────────────
  // Used by Lawyer-style cumulative audits
  temporalLayers:              mongoose.Schema.Types.Mixed,
  currentCumulativeAssessment: mongoose.Schema.Types.Mixed,
  majorStructuralTransitions:  mongoose.Schema.Types.Mixed,

  // ── Historical context ────────────────────────────────────────────────────
  // Used by GS-style historical audits: { summary, conditions[] }
  historicalContext: mongoose.Schema.Types.Mixed,

  definitions:           mongoose.Schema.Types.Mixed,
  method:                mongoose.Schema.Types.Mixed,
  context:               mongoose.Schema.Types.Mixed,

  scores:                mongoose.Schema.Types.Mixed,
  calculations:          mongoose.Schema.Types.Mixed,
  findings:              mongoose.Schema.Types.Mixed,
  civilizationRiskSignals: mongoose.Schema.Types.Mixed,

  counterfactual:        mongoose.Schema.Types.Mixed,

  // ── Extended / non-standard audit sections ────────────────────────────────
  // Without these declarations Mongoose (strict mode) silently drops them on
  // import, so they never reach the view or the PDF.
  executiveSummary:            mongoose.Schema.Types.Mixed,
  overridingPosition:          mongoose.Schema.Types.Mixed,
  methodologicalDeparture:     mongoose.Schema.Types.Mixed,
  financialPeriod:             mongoose.Schema.Types.Mixed,
  financialStatement:          mongoose.Schema.Types.Mixed,
  revenueBreakdown:            mongoose.Schema.Types.Mixed,
  ratioVisual:                 mongoose.Schema.Types.Mixed,
  keyRatios:                   mongoose.Schema.Types.Mixed,
  sensitivityAnalysis:         mongoose.Schema.Types.Mixed,
  provisionalSCOICalculations: mongoose.Schema.Types.Mixed,
  SCOIStructuralComparison:    mongoose.Schema.Types.Mixed,
  civilizationFoundation:      mongoose.Schema.Types.Mixed,
  civilizationEconomicsAudit:  mongoose.Schema.Types.Mixed,
  sportingCausationAudit:      mongoose.Schema.Types.Mixed,
  timeAudit:                   mongoose.Schema.Types.Mixed,
  associationAudit:            mongoose.Schema.Types.Mixed,
  civilizationRecommendations: mongoose.Schema.Types.Mixed,
  futureTimeAuditSeries:       mongoose.Schema.Types.Mixed,
  finalCivilizationCall:       mongoose.Schema.Types.Mixed,
  sources:                     mongoose.Schema.Types.Mixed,
  disclaimers:           mongoose.Schema.Types.Mixed,
  tags:                  [String],

  price: {
    type:    Number,
    default: 29900
  },

  isPaid: {
    type:    Boolean,
    default: false
  },

  pdfUrl: String,

  createdAt: {
    type:    Date,
    default: Date.now
  }
}, {
  collection: "special_scoi_audits"
});

export default mongoose.model("SpecialScoiAudit", SpecialScoiAuditSchema);