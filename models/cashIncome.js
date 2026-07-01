// models/cashIncome.js
// ─────────────────────────────────────────────────────────────
// Manual "cash in" / income entries - money received that isn't
// a full invoice/receipt sales document (e.g. quick cash sale,
// other income, refund received). Used by the admin "act as
// clerk" Financial Records workspace so income can be logged the
// same way expenses, payouts and handovers are, without touching
// the existing Invoice/Receipt document-generation flow.
//
// Counted as cash IN by dailyReportEnhanced.js (fetchOpeningBalance /
// saveClosingBalance) and shown in the admin Financial Records list.
// ─────────────────────────────────────────────────────────────
import mongoose from "mongoose";

const CashIncomeSchema = new mongoose.Schema({
  businessId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Business",
    required: true,
    index: true
  },
  branchId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Branch",
    default: null,
    index: true
  },

  amount:      { type: Number, required: true },
  description: { type: String, default: "" },
  category:    { type: String, default: "Sale" }, // Sale, Other Income, Refund Received, etc.
  method:      { type: String, default: "cash" },

  createdBy: { type: String, default: null }, // phone of clerk/owner this was recorded on behalf of

  // ── Reversal trail (soft-reverse, keeps audit history) ─────────────────────
  reversed:       { type: Boolean, default: false },
  originalAmount: { type: Number, default: null },
  reversedAt:     { type: Date,   default: null },
  reversedBy:     { type: String, default: null }
}, { timestamps: true });

CashIncomeSchema.index({ businessId: 1, branchId: 1, createdAt: -1 });

export default mongoose.models.CashIncome || mongoose.model("CashIncome", CashIncomeSchema);