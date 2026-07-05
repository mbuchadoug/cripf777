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

  // ── Cash SOURCE: whose till this money physically left ─────────────────────
  // THE FIX for "owner drawings inflate the clerk's balance". A payout depletes
  // the till of whoever is HOLDING the cash, which is not always the person who
  // typed it in. Example: the owner records a $167 drawing, but the notes come
  // out of the clerk's drawer - so the CLERK's custody must drop, not the
  // owner's.
  //
  // Semantics:
  //   • fromPhone set  → THAT person's statement is debited (their balance
  //                      drops), regardless of who recorded the payout.
  //   • fromPhone null → falls back to the recorder (createdBy/recordedBy),
  //                      which is the EXACT original behaviour - so every
  //                      existing payout keeps working unchanged until/unless
  //                      an admin assigns a till to it.
  //
  // In the admin "act as <person>" workspace this defaults to that person, so
  // a drawing entered while acting as the clerk correctly leaves the clerk's
  // till. On WhatsApp a clerk's own payout defaults to their own till; an
  // owner/manager is asked whose till the cash came from.
  fromPhone: {
    type: String,
    default: null,
    index: true
  },
  fromName: {
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