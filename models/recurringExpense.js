/**
 * models/recurringExpense.js
 * ─────────────────────────────────────────────────────────────
 * An expense charged to a specific RecurringAccount (unit/flat/room).
 * Appears on the unit statement and affects its closing balance.
 *
 * Examples:
 *   Flat 3A: plumber call-out $25, light bulb replacement $3
 *   Student: textbook $12, uniform $40
 *
 * WHERE TO PUT THIS FILE: models/recurringExpense.js
 */

import mongoose from "mongoose";

const RecurringExpenseSchema = new mongoose.Schema({
  businessId: {
    type:     mongoose.Schema.Types.ObjectId,
    ref:      "Business",
    required: true,
    index:    true
  },
  accountId: {
    type:     mongoose.Schema.Types.ObjectId,
    ref:      "RecurringAccount",
    required: true,
    index:    true
  },

  // ── Expense details ─────────────────────────────────────────────────────────
  description: { type: String, required: true, trim: true },
  category:    { type: String, default: "Maintenance" },
  amount:      { type: Number, required: true },
  currency:    { type: String, default: "USD" },

  // ── Date ────────────────────────────────────────────────────────────────────
  date:   { type: Date, required: true, index: true },
  period: { type: String, default: "" },  // e.g. "June 2026"

  // ── Metadata ────────────────────────────────────────────────────────────────
  notes:     { type: String, default: "" },
  createdBy: { type: String, default: null }

}, { timestamps: true });

RecurringExpenseSchema.index({ businessId: 1, accountId: 1, date: -1 });

export default mongoose.models.RecurringExpense ||
  mongoose.model("RecurringExpense", RecurringExpenseSchema);