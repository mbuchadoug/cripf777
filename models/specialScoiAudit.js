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
  // e.g. "dual" — analytical matrix descriptor shown on cover and in profile
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