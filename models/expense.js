import mongoose from "mongoose";

const ExpenseSchema = new mongoose.Schema({
  businessId: { type: mongoose.Schema.Types.ObjectId, ref: "Business", required: true },
  branchId: { type: mongoose.Schema.Types.ObjectId, ref: "Branch" },
  amount: { type: Number, required: true },
  description: { type: String },
  category: { type: String },
  method: { type: String },
  createdBy: { type: String },

  // ── Reversal trail (soft-reverse, keeps audit history) ─────────────────────
  reversed:       { type: Boolean, default: false },
  originalAmount: { type: Number, default: null },
  reversedAt:     { type: Date,   default: null },
  reversedBy:     { type: String, default: null }
}, { timestamps: true });

const Expense = mongoose.model("Expense", ExpenseSchema);

export default Expense;