import mongoose from "mongoose";

const CashPayoutSchema = new mongoose.Schema({
  businessId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Business",
    required: true,
    index: true
  },

  branchId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Branch",
    required: true,
    index: true
  },

  amount: {
    type: Number,
    required: true
  },

  reason: {
    type: String,
    default: ""
  },

  createdBy: {
    type: String,
    default: null
  },

  // ── Alias kept because the WhatsApp payout flow historically wrote
  //    `recordedBy` (which this schema silently discarded - THE reason
  //    WhatsApp payouts never appeared on clerk statements). The flow now
  //    writes BOTH createdBy and recordedBy; statements query with $or so
  //    either field attributes the payout to its clerk. ──────────────────────
  recordedBy: {
    type: String,
    default: null
  },

  // ── Directed payout: WHO received the money ────────────────────────────────
  // null = external party (delivery driver, supplier, wages taken home...) -
  // no effect on any staff statement, exactly the old behaviour.
  // When set to a staff phone: the payer's statement shows a debit
  // "Payout → <name>" and the RECEIVER's statement shows a matching credit
  // "Payout received from <payer>" that increases their running custody
  // balance (works for clerks, managers, admins and the OWNER alike).
  // Single source of truth: one document drives both sides, so a
  // reverse/delete automatically corrects both statements at once.
  paidToPhone: {
    type: String,
    default: null,
    index: true
  },
  paidToName: {
    type: String,
    default: null
  },

  // ── Reversal trail ──────────────────────────────────────────────────────────
  // The admin panel has always SET these on reverse, but they were never in
  // the schema, so Mongoose discarded them: the amount went to 0 (that part
  // worked) but the REVERSED badge and original amount were silently lost.
  // Declaring them fixes the audit trail with zero behaviour change.
  reversed:       { type: Boolean, default: false },
  originalAmount: { type: Number,  default: null },
  reversedAt:     { type: Date,    default: null },
  reversedBy:     { type: String,  default: null },

  date: {
    type: Date,
    required: true,
    index: true
  }
}, { timestamps: true });

CashPayoutSchema.index({ businessId: 1, branchId: 1, date: -1 });

export default mongoose.models.CashPayout || mongoose.model("CashPayout", CashPayoutSchema);