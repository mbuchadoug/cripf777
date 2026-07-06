/**
 * models/stockItem.js
 * ─────────────────────────────────────────────────────────────────────────────
 * WHERE TO PUT THIS FILE:  models/stockItem.js
 *
 * A product a business has CHOSEN to track stock for. Stock is opt-in and
 * per-item: only products with a StockItem here are ever counted. Everything
 * else in the sales ledger is ignored, so turning stock on never disturbs a
 * business that sells un-tracked things.
 *
 * SCOPE: per branch (the user chose "per branch, with a business-wide roll-up
 * in the report"). Two branches selling "Coke" each keep their own StockItem
 * and their own count; the report sums them for the owner.
 *
 * QUANTITY IS DERIVED, NEVER GUESSED:
 *   currentQty = openingQty
 *              + Σ purchases / positive adjustments      (StockMovement)
 *              − Σ wastage / negative adjustments         (StockMovement)
 *              − Σ quantity sold                          (matched from Invoice
 *                                                          line items - real
 *                                                          sales, no hook in the
 *                                                          sale flow)
 * `currentQty` below is a CACHE recomputed by stockService.recomputeItemQty();
 * the movements + invoices are always the source of truth.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import mongoose from "mongoose";

const StockItemSchema = new mongoose.Schema({
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

  // ── Identity ────────────────────────────────────────────────────────────────
  name: { type: String, required: true, trim: true },
  sku:  { type: String, trim: true, default: "" },
  unit: { type: String, default: "each" },   // each, box, kg, litre, crate...

  // Aliases used to auto-match sale line items to this product. Lower-cased.
  // e.g. product "Coca-Cola 500ml" with aliases ["coke","coca cola","coke 500"]
  // so a receipt line "2x coke" still decrements this item.
  aliases: { type: [String], default: [] },

  // ── Pricing (for stock valuation and margin) ────────────────────────────────
  costPrice: { type: Number, default: 0 },   // what the business pays per unit
  sellPrice: { type: Number, default: 0 },   // default selling price per unit
  currency:  { type: String, default: "USD" },

  // ── Levels ──────────────────────────────────────────────────────────────────
  openingQty:   { type: Number, default: 0 },   // stock on hand when first added
  openingDate:  { type: Date,   default: Date.now },
  currentQty:   { type: Number, default: 0 },   // CACHE - see header
  reorderLevel: { type: Number, default: 0 },   // alert threshold (0 = no alert)

  lastRecomputedAt: { type: Date, default: null },

  // ── Status ──────────────────────────────────────────────────────────────────
  isActive:  { type: Boolean, default: true, index: true },

  // ── Metadata ────────────────────────────────────────────────────────────────
  notes:     { type: String, default: "" },
  createdBy: { type: String, default: null }
}, { timestamps: true });

StockItemSchema.index({ businessId: 1, branchId: 1, isActive: 1 });
StockItemSchema.index({ businessId: 1, name: 1 });

export default mongoose.models.StockItem ||
  mongoose.model("StockItem", StockItemSchema);