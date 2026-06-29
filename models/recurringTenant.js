/**
 * models/recurringTenant.js
 * ─────────────────────────────────────────────────────────────
 * The person occupying / using a RecurringAccount.
 *
 * For property manager : the tenant who lives in a flat
 * For a school         : the parent/guardian who pays fees
 * For insurance        : the policy holder
 *
 * A tenant can:
 *   • Send "hi" to the chatbot and see their own balance & invoices
 *   • Receive broadcast payment reminders
 *   • Receive PDF invoices and receipts on WhatsApp
 *
 * WHERE TO PUT THIS FILE: models/recurringTenant.js
 */

import mongoose from "mongoose";

const RecurringTenantSchema = new mongoose.Schema({
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

  // ── Contact details ─────────────────────────────────────────────────────────
  name:  { type: String, required: true, trim: true },
  phone: { type: String, trim: true, default: "", index: true },
  email: { type: String, trim: true, default: "" },

  // ── Occupancy / membership dates ─────────────────────────────────────────────
  startDate:   { type: Date, default: null },
  endDate:     { type: Date, default: null },
  isActive:    { type: Boolean, default: true, index: true },

  // ── Self-service access ──────────────────────────────────────────────────────
  // When true, the tenant can WhatsApp the chatbot number and see their own
  // balance, invoices, and statements.  Toggled by the business owner/admin.
  canSelfServe: { type: Boolean, default: false },

  // ── Notifications ────────────────────────────────────────────────────────────
  // Receive payment reminders and receipts via WhatsApp
  notificationsEnabled: { type: Boolean, default: true },

  // ── Opening balance (migration / system setup) ──────────────────────────────
  // Admin-entered balance the tenant had before ZimQuote was set up.
  // Positive = tenant owes money. Negative = tenant is in credit.
  // Set once at setup — never auto-updated by the system.
  openingBalance:     { type: Number, default: 0 },
  openingBalanceDate: { type: Date,   default: null },

  // ── Notes ───────────────────────────────────────────────────────────────────
  notes:     { type: String, default: "" },
  createdBy: { type: String, default: null }

}, { timestamps: true });

RecurringTenantSchema.index({ businessId: 1, accountId: 1, isActive: 1 });
RecurringTenantSchema.index({ phone: 1, businessId: 1 });

export default mongoose.models.RecurringTenant ||
  mongoose.model("RecurringTenant", RecurringTenantSchema);