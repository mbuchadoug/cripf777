/**
 * models/recurringIncome.js
 * ─────────────────────────────────────────────────────────────
 * "Other income" on the recurring-billing side - money the operation takes in
 * that is NOT a tenant's rent payment. Examples for a rentals business:
 *   deposits, key/tag replacement, application fees, late-payment penalties,
 *   parking, laundry, water/electricity recoveries, one-off charges, misc cash.
 *
 * CRITICAL DIFFERENCE FROM RecurringPayment:
 *   A RecurringPayment settles a tenant's rent invoice and REDUCES that
 *   tenant's/account's outstanding balance. RecurringIncome does NOT - it is
 *   pure cash-in that appears on the business-wide billing ledger and totals,
 *   but never touches anyone's rent arrears. This keeps rent balances pristine
 *   while still capturing every dollar that came through the operation.
 *
 * accountId / tenantId are OPTIONAL. Left null, the income is "business-wide"
 * (the normal case for the chatbot "other income, not a tenant" flow). They can
 * be set if you ever want to tag income to a specific unit for reference.
 *
 * WHERE TO PUT THIS FILE: models/recurringIncome.js
 */

import mongoose from "mongoose";

const RecurringIncomeSchema = new mongoose.Schema({
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

  // Optional links - null = business-wide income (not tied to a unit/tenant)
  accountId: {
    type:  mongoose.Schema.Types.ObjectId,
    ref:   "RecurringAccount",
    index: true,
    default: null
  },
  tenantId: {
    type:  mongoose.Schema.Types.ObjectId,
    ref:   "RecurringTenant",
    default: null
  },

  // ── Income details ──────────────────────────────────────────────────────────
  description: { type: String, required: true, trim: true },
  category:    { type: String, default: "Other Income" },
  amount:      { type: Number, required: true },
  currency:    { type: String, default: "USD" },

  method: {
    type:    String,
    enum:    ["cash", "ecocash", "bank", "innbucks", "zipit", "card", "other"],
    default: "cash"
  },
  reference: { type: String, default: "" },

  // ── Date ────────────────────────────────────────────────────────────────────
  date:   { type: Date, required: true, index: true },
  period: { type: String, default: "" },  // e.g. "June 2026"

  // ── Metadata ────────────────────────────────────────────────────────────────
  notes:     { type: String, default: "" },
  createdBy: { type: String, default: null }   // clerk phone who recorded it

}, { timestamps: true });

RecurringIncomeSchema.index({ businessId: 1, date: -1 });
RecurringIncomeSchema.index({ businessId: 1, branchId: 1, date: -1 });

export default mongoose.models.RecurringIncome ||
  mongoose.model("RecurringIncome", RecurringIncomeSchema);