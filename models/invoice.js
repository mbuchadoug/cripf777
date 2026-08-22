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

  // ── Optional note / memo ────────────────────────────────────────────────────
  // Free-text note the user can attach when creating the document (invoice /
  // quote / receipt) or add later from the sales list if they skipped it. Shows
  // on the reports and is echoed in the "note" business notification. Optional -
  // defaults to empty so existing documents are unaffected.
  note: { type: String, default: "" },

  // ── True system-entry time (audit) ─────────────────────────────────────────
  // createdAt carries the user-chosen BUSINESS date (may be backdated) so reports
  // bucket the doc on the right day. enteredAt is always the real time the record
  // was captured, kept for audit / anti-fraud.
  enteredAt: { type: Date, default: Date.now },

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