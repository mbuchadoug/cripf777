/**
 * models/recurringPayment.js
 * ─────────────────────────────────────────────────────────────
 * Records a payment made against a RecurringInvoice.
 * Multiple payments can be made against one invoice (partial payments).
 *
 * WHERE TO PUT THIS FILE: models/recurringPayment.js
 */

import mongoose from "mongoose";

const RecurringPaymentSchema = new mongoose.Schema({
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
  tenantId: {
    type:  mongoose.Schema.Types.ObjectId,
    ref:   "RecurringTenant",
    index: true,
    default: null
  },
  invoiceId: {
    type:  mongoose.Schema.Types.ObjectId,
    ref:   "RecurringInvoice",
    index: true,
    default: null   // null = unallocated payment / advance payment
  },

  // ── Amount ──────────────────────────────────────────────────────────────────
  amount:   { type: Number, required: true },
  currency: { type: String, default: "USD" },

  // ── Method ──────────────────────────────────────────────────────────────────
  method: {
    type:    String,
    enum:    ["cash", "ecocash", "bank", "innbucks", "zipit", "card", "other"],
    default: "cash"
  },
  reference: { type: String, default: "" },   // e.g. EcoCash transaction ref

  // ── Date ────────────────────────────────────────────────────────────────────
  date:      { type: Date, required: true, index: true },

  // ── Period this payment applies to (for statement grouping) ──────────────────
  period: { type: String, default: "" },   // e.g. "June 2026"

  // ── Metadata ────────────────────────────────────────────────────────────────
  notes:     { type: String, default: "" },
  createdBy: { type: String, default: null }   // clerk phone

}, { timestamps: true });

RecurringPaymentSchema.index({ businessId: 1, accountId: 1, date: -1 });
RecurringPaymentSchema.index({ invoiceId: 1 });

export default mongoose.models.RecurringPayment ||
  mongoose.model("RecurringPayment", RecurringPaymentSchema);