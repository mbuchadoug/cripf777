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
    required: true // e.g. placement_event, crisis, exit, restructuring
  },

  subject: {
    name: String,
    entityType: String,
    entityScope: String,
    sectorContext: String,
    jurisdiction: String
  },

  // ── assessmentWindow ──────────────────────────────────────────────────────
  // MUST be Mixed, not a typed sub-document.
  //
  // Why: the JSON contains a "type" key inside assessmentWindow:
  //   { label: "1904_1939", durationYears: 35, type: "institutional_..." }
  //
  // When Mongoose sees a nested object that has a "type" key, it treats that
  // key as a schema-type directive and tries to cast the whole field to that
  // type (String in this case). This produces:
  //   "Cast to string failed for value {...} at path assessmentWindow"
  //
  // Using Mixed bypasses all casting and stores whatever arrives as-is.
  assessmentWindow: mongoose.Schema.Types.Mixed,

  author: String,
  purpose: String,
  status: String,
  revisionPolicy: String,

  matrix: mongoose.Schema.Types.Mixed,

  // ── Core doctrine (top-level key in the JSON) ──────────────────────────────
  // Previously missing from schema → was silently dropped on Model.create()
  // This is what the Findings section falls back to when
  // findings.coreFinding is absent.
  coreDoctrine: mongoose.Schema.Types.Mixed,

  // ── CRIPFCnt interpretation block ─────────────────────────────────────────
  // Previously missing from schema → was silently dropped on Model.create()
  // The template uses audit.CRIPFCntInterpretation.summary as the second
  // fallback for the core finding box.
  CRIPFCntInterpretation: mongoose.Schema.Types.Mixed,

  definitions: mongoose.Schema.Types.Mixed,
  method: mongoose.Schema.Types.Mixed,
  context: mongoose.Schema.Types.Mixed,

  scores: mongoose.Schema.Types.Mixed,
  calculations: mongoose.Schema.Types.Mixed,
  findings: mongoose.Schema.Types.Mixed,
  civilizationRiskSignals: mongoose.Schema.Types.Mixed,

  counterfactual: mongoose.Schema.Types.Mixed,
  disclaimers: mongoose.Schema.Types.Mixed,
  tags: [String],

  price: {
    type: Number,
    default: 29900
  },

  isPaid: {
    type: Boolean,
    default: false
  },

  pdfUrl: String,

  createdAt: {
    type: Date,
    default: Date.now
  }
}, {
  collection: "special_scoi_audits"
});

export default mongoose.model("SpecialScoiAudit", SpecialScoiAuditSchema);