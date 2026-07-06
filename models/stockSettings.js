/**
 * models/stockSettings.js
 * ─────────────────────────────────────────────────────────────────────────────
 * WHERE TO PUT THIS FILE:  models/stockSettings.js
 *
 * The opt-in switch. Stock tracking is OFF for every business until an owner
 * turns it on here. Kept in its OWN collection (one doc per business) rather
 * than as a field on the Business model, for two reasons:
 *   1. We don't have to modify the Business schema - and Mongoose silently
 *      discards fields that aren't declared on a schema (the same trap that
 *      bit openingBalance and the payout recordedBy field), so a new
 *      undeclared Business field would just vanish.
 *   2. Stock is a self-contained optional module; its settings live with it.
 *
 * `enabled=false` (or no doc at all) => the business behaves exactly as before:
 * no Stock Control menu item shown, no sale ever matched, nothing computed.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import mongoose from "mongoose";

const StockSettingsSchema = new mongoose.Schema({
  businessId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Business",
    required: true,
    unique: true,
    index: true
  },

  enabled: { type: Boolean, default: false },

  // When true, sale line items are auto-matched to tracked products by
  // name/alias (the default). When false, only items explicitly picked from
  // the stock list at sale time are counted. Both paths are supported.
  autoMatchSales: { type: Boolean, default: true },

  // Low-stock alerts on/off (uses each item's reorderLevel)
  lowStockAlerts: { type: Boolean, default: true },

  enabledBy:  { type: String, default: null },
  enabledAt:  { type: Date,   default: null }
}, { timestamps: true });

export default mongoose.models.StockSettings ||
  mongoose.model("StockSettings", StockSettingsSchema);