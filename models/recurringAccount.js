/**
 * models/recurringAccount.js
 * ─────────────────────────────────────────────────────────────
 * A "billable account" - the thing that gets charged on a schedule.
 *
 * For a property manager : a flat / unit / room  (e.g. "Flat 3A")
 * For a school           : a student              (e.g. "John Moyo - Grade 7A")
 * For an insurance firm  : a policy               (e.g. "Policy ZW-00441")
 * For any subscription   : a subscriber account
 *
 * Each account:
 *   • Has its own name, reference code, and monthly/quarterly/annual charge
 *   • Can have one or more tenants/occupants (see RecurringTenant)
 *   • Accumulates expenses (maintenance, repairs, etc.)
 *   • Carries a running statement with previous-period closing as opening
 *
 * WHERE TO PUT THIS FILE: models/recurringAccount.js
 */

import mongoose from "mongoose";

const RecurringAccountSchema = new mongoose.Schema({
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

  // ── Identity ────────────────────────────────────────────────────────────────
  // name   : human-readable label e.g. "Flat 3A", "Room 12", "John Moyo"
  // ref    : short code for statements e.g. "F3A", "R12", "JM7A"
  // category: what kind of account this is - drives label language in UI/reports
  name: { type: String, required: true, trim: true },
  ref:  { type: String, trim: true, default: "" },
  description: { type: String, default: "" },

  // category: the KIND of billable client/account. Inclusive across industries:
  //   property/rentals - flat, apartment, room, house, cottage, unit, plot,
  //     stand, shop, office, warehouse, parking, desk
  //   people/services  - student, member, subscriber, patient, policy, vehicle
  //   other            - anything else
  // All original values are preserved, so existing accounts are unaffected.
  category: {
    type:    String,
    enum:    ["unit", "room", "flat", "apartment", "house", "cottage", "plot",
              "stand", "shop", "office", "warehouse", "parking", "desk",
              "student", "policy", "member", "subscriber", "patient", "vehicle",
              "other"],
    default: "unit"
  },

  // propertyName: optional grouping label so many accounts can sit under ONE
  // property / building / site (e.g. "Sunrise Apartments" -> Flat 1, Flat 2) or
  // any grouping that suits the business. Blank = ungrouped. Purely additive.
  propertyName: { type: String, trim: true, default: "", index: true },

  // ── Recurring charge ────────────────────────────────────────────────────────
  billingAmount: { type: Number, required: true, default: 0 },
  currency:      { type: String, default: "USD" },

  billingCycle: {
    type:    String,
    enum:    ["monthly", "quarterly", "termly", "annual", "custom"],
    default: "monthly"
  },

  // Day of month to raise an invoice (1-28).  Used by bulk-generate.
  billingDay: { type: Number, default: 1, min: 1, max: 28 },

  // Custom interval in days (used when billingCycle = "custom")
  customIntervalDays: { type: Number, default: 30 },

  // ── Status ──────────────────────────────────────────────────────────────────
  isActive:  { type: Boolean, default: true, index: true },
  isVacant:  { type: Boolean, default: false },

  // ── Financials (cached for quick dashboard - recomputed on statement) ────────
  currentBalance: { type: Number, default: 0 },    // positive = money owed TO business
  lastInvoicedAt: { type: Date,   default: null },
  lastPaidAt:     { type: Date,   default: null },

  // ── Metadata ────────────────────────────────────────────────────────────────
  notes:     { type: String, default: "" },
  createdBy: { type: String, default: null }   // clerk phone who created it

}, { timestamps: true });

RecurringAccountSchema.index({ businessId: 1, isActive: 1 });
RecurringAccountSchema.index({ businessId: 1, branchId: 1, isActive: 1 });
RecurringAccountSchema.index({ businessId: 1, propertyName: 1, isActive: 1 });

export default mongoose.models.RecurringAccount ||
  mongoose.model("RecurringAccount", RecurringAccountSchema);