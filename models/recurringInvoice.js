/**
 * models/recurringInvoice.js
 * ─────────────────────────────────────────────────────────────
 * A periodic invoice raised against a RecurringAccount / RecurringTenant.
 * Completely separate from the main Invoice model so recurring billing
 * never pollutes the sales ledger or changes invoice number sequences.
 *
 * Number sequence: RENT-0001, SCH-0001, etc. (prefix set per business)
 *
 * WHERE TO PUT THIS FILE: models/recurringInvoice.js
 */

import mongoose from "mongoose";

const RecurringInvoiceSchema = new mongoose.Schema({
  businessId: {
    type:     mongoose.Schema.Types.ObjectId,
    ref:      "Business",
    required: true,
    index:    true
  },
  branchId: {
    type:  mongoose.Schema.Types.ObjectId,
    ref:   "Branch",
    index: true,
    default: null
  },
  accountId: {
    type:     mongoose.Schema.Types.ObjectId,
    ref:      "RecurringAccount",
    required: true,
    index:    true
  },
  tenantId: {
    type:  mongoose.Schema.Types.ObjectId,
    ref:   "RecurringTenant",
    index: true,
    default: null
  },

  // ── Reference ───────────────────────────────────────────────────────────────
  number: { type: String, required: true },   // e.g. "RENT-0001"

  // ── Period this invoice covers ───────────────────────────────────────────────
  period:      { type: String, required: true },  // e.g. "June 2026"
  periodStart: { type: Date,   required: true },
  periodEnd:   { type: Date,   required: true },
  dueDate:     { type: Date,   required: true },

  // ── Amounts ─────────────────────────────────────────────────────────────────
  amount:     { type: Number, required: true },   // gross charge
  amountPaid: { type: Number, default: 0 },
  balance:    { type: Number, default: 0 },       // amount - amountPaid
  currency:   { type: String, default: "USD" },

  // ── Status ──────────────────────────────────────────────────────────────────
  status: {
    type:    String,
    enum:    ["unpaid", "partial", "paid", "cancelled", "overdue"],
    default: "unpaid",
    index:   true
  },

  // ── Description lines (like invoice items) ───────────────────────────────────
  lines: [{
    description: { type: String },
    amount:      { type: Number, default: 0 }
  }],

  // ── Metadata ────────────────────────────────────────────────────────────────
  notes:     { type: String, default: "" },
  createdBy: { type: String, default: null },   // clerk phone
  pdfPath:   { type: String, default: null }

}, { timestamps: true });

RecurringInvoiceSchema.index({ businessId: 1, accountId: 1, status: 1 });
RecurringInvoiceSchema.index({ businessId: 1, periodStart: -1 });
RecurringInvoiceSchema.index({ number: 1, businessId: 1 }, { unique: true });

export default mongoose.models.RecurringInvoice ||
  mongoose.model("RecurringInvoice", RecurringInvoiceSchema);