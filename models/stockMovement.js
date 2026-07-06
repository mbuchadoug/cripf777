/**
 * models/stockMovement.js
 * ─────────────────────────────────────────────────────────────────────────────
 * WHERE TO PUT THIS FILE:  models/stockMovement.js
 *
 * Records a MANUAL stock movement - the things that aren't a sale:
 *   • "purchase"   - stock bought IN (restock)                 qty > 0
 *   • "opening"    - initial stock when the item was created    qty > 0
 *   • "return"     - customer/supplier return back into stock   qty > 0
 *   • "adjustment" - manual correction (count fix)              qty +/-
 *   • "wastage"    - breakage, theft, expiry, write-off         qty < 0
 *
 * SALES ARE NOT STORED HERE. They are derived at read-time from the real
 * Invoice line items (see stockService), so the sale flow is never touched and
 * can never be broken by stock code. This model only holds what a human types
 * into Stock Control.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import mongoose from "mongoose";

const StockMovementSchema = new mongoose.Schema({
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
  stockItemId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "StockItem",
    required: true,
    index: true
  },

  type: {
    type: String,
    enum: ["opening", "purchase", "return", "adjustment", "wastage"],
    required: true
  },

  // Signed quantity: positive adds to stock, negative removes.
  qty: { type: Number, required: true },

  // Unit cost for purchases (for valuation / weighted average, optional)
  unitCost: { type: Number, default: 0 },
  currency: { type: String, default: "USD" },

  // Running balance AFTER this movement (audit convenience, computed on write)
  balanceAfter: { type: Number, default: null },

  reason: { type: String, default: "" },
  date:   { type: Date, required: true, index: true },

  createdBy: { type: String, default: null },

  // ── Reversal trail (soft) ──────────────────────────────────────────────────
  reversed:   { type: Boolean, default: false },
  reversedAt: { type: Date,    default: null },
  reversedBy: { type: String,  default: null }
}, { timestamps: true });

StockMovementSchema.index({ businessId: 1, branchId: 1, date: -1 });
StockMovementSchema.index({ stockItemId: 1, date: 1 });

export default mongoose.models.StockMovement ||
  mongoose.model("StockMovement", StockMovementSchema);