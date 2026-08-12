import mongoose from "mongoose";

const InvoiceSchema = new mongoose.Schema({
  businessId: {
    type: mongoose.Schema.Types.ObjectId,
    index: true,
    required: true
  },

  branchId: {
    type: mongoose.Schema.Types.ObjectId,
    index: true
  },

  clientId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Client",
    required: true
  },

  number: {
    type: String,
    index: true,
    required: true
  },
type: {
  type: String,
  enum: ["invoice", "quote", "receipt"],
  default: "invoice",
  index: true
},

  currency: {
    type: String,
    required: true
  },

  status: {
    type: String,
    enum: ["unpaid", "partial", "paid"],
    default: "unpaid",
    index: true
  },

  amountPaid: {
    type: Number,
    default: 0
  },

  balance: {
    type: Number,
    default: 0
  },

  items: [{
    item: String,
    qty: Number,
    unit: Number,
    total: Number
  }],

  subtotal: Number,
  discountPercent: Number,
  discountAmount: Number,
  vatPercent: Number,
  vatAmount: Number,
  total: Number,

  createdBy: String,

  // ── Reversal trail (soft-reverse, keeps audit history) ─────────────────────
  // Mirrors Expense/CashIncome. Reversing a sale (receipt/invoice) zeroes its
  // contributing amount (total) and stashes the original, so EVERY
  // summation-based reader - the daily recompute, buildLedger, the finance
  // feed - excludes it automatically, exactly like a reversed expense, while
  // the row stays visible for audit.
  reversed:      { type: Boolean, default: false, index: true },
  originalTotal: { type: Number,  default: null },
  reversedAt:    { type: Date,    default: null },
  reversedBy:    { type: String,  default: null }
}, { timestamps: true });

export default mongoose.model("Invoice", InvoiceSchema);