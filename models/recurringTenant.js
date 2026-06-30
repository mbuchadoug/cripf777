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

  // ── Per-tenant billing override (REAL-WORLD SCENARIO) ────────────────────────
  // An account (unit/building) can host MULTIPLE tenants who each pay a
  // DIFFERENT amount (e.g. a boarding house "Main House" account with Room 1
  // paying $80 and Room 2 paying $120, or a school "Grade 7" account with
  // siblings on different fee plans). When any of these are set (non-null),
  // they OVERRIDE the parent RecurringAccount's billing settings for THIS
  // tenant only. Leave null/blank to simply inherit the account's settings
  // (this is the default and matches the original single-tenant-per-account
  // behaviour exactly — nothing changes for existing accounts).
  billingAmount:      { type: Number, default: null },
  billingCycle: {
    type:    String,
    enum:    ["monthly", "quarterly", "termly", "annual", "custom", null],
    default: null
  },
  billingDay:         { type: Number, default: null, min: 1, max: 28 },
  customIntervalDays: { type: Number, default: null },
  // Optional override for the invoice line description, e.g. "Room 2 Rent".
  // Falls back to "<period> charge" when blank.
  billingDescription: { type: String, default: "" },

  // ── Cached balance (THIS tenant's own share only — recomputed on demand) ────
  // Unlike RecurringAccount.currentBalance (which is the sum of EVERY tenant
  // under that account), this is scoped to just this tenant, so multiple
  // tenants sharing one account never see each other's balance.
  currentBalance: { type: Number, default: 0 },

  // ── Notes ───────────────────────────────────────────────────────────────────
  notes:     { type: String, default: "" },
  createdBy: { type: String, default: null }

}, { timestamps: true });

RecurringTenantSchema.index({ businessId: 1, accountId: 1, isActive: 1 });
RecurringTenantSchema.index({ phone: 1, businessId: 1 });

export default mongoose.models.RecurringTenant ||
  mongoose.model("RecurringTenant", RecurringTenantSchema);