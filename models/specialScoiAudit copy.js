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
    sectorContext: String,
    jurisdiction: String
  },

 assessmentWindow: {
  label: {
    type: String
  },
  phase: {
    type: String   // ← renamed from "type"
  }
}
,

  author: String,
  purpose: String,
  status: String,
  revisionPolicy: String,

 matrix: mongoose.Schema.Types.Mixed,

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
