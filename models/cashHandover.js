/**
 * models/cashHandover.js
 * ─────────────────────────────────────────────────────────────
 * WHERE TO PUT THIS FILE:  models/cashHandover.js
 * (same folder as cashPayout.js, invoice.js, expense.js, etc.)
 * ─────────────────────────────────────────────────────────────
 *
 * Records a shift cash handover from one staff member to another.
 * Used in:
 *   - Daily / weekly / monthly reports  (Cash Custody Timeline)
 *   - Audit trail  (who held the till and when)
 *   - Multi-clerk branches  (shift accountability)
 */

import mongoose from "mongoose";

const CashHandoverSchema = new mongoose.Schema(
  {
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

    // ── Outgoing staff (ending their shift) ───────────────────
    outgoingPhone: { type: String, required: true },
    outgoingName:  { type: String, default: "Unknown" },
    outgoingRole:  { type: String, default: "clerk" },

    // ── Incoming staff (starting their shift) ─────────────────
    incomingPhone: { type: String, default: null },  // null = owner / no named person
    incomingName:  { type: String, default: "Unknown" },
    incomingRole:  { type: String, default: "clerk" },

    // ── Cash count at the handover moment ─────────────────────
    amountCounted: { type: Number, required: true, min: 0 },

    // ── Optional note (discrepancy, pending items, float, etc.)
    notes: { type: String, default: "" },

    // ── Exact timestamp for timeline ordering ─────────────────
    handoverAt: { type: Date, default: Date.now, index: true },

    // ── Date bucket for fast daily range queries ───────────────
    date: { type: Date, required: true, index: true },

    // ── Reversal trail (audit-only — handovers don't affect cash totals) ──────
    reversed:   { type: Boolean, default: false },
    reversedAt: { type: Date,   default: null },
    reversedBy: { type: String, default: null }
  },
  { timestamps: true }
);

// Fast fetch: all handovers for a branch on a given day
CashHandoverSchema.index({ businessId: 1, branchId: 1, date: 1 });

export default mongoose.model("CashHandover", CashHandoverSchema);