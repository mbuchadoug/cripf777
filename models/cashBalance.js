import mongoose from "mongoose";

const CashBalanceSchema = new mongoose.Schema({
  businessId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Business",
    required: true,
    index: true
  },

  branchId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Branch",
    index: true
  },

  date: {
    type: Date,
    required: true,
    index: true
  },

  openingBalance: {
    type: Number,
    default: 0
  },

  closingBalance: {
    type: Number,
    default: 0
  },

  cashIn: {
    type: Number,
    default: 0
  },

  cashOut: {
    type: Number,
    default: 0
  },

  // Breakdown
  invoicePayments: { type: Number, default: 0 },
  receiptSales: { type: Number, default: 0 },
  expenses: { type: Number, default: 0 }
}, { timestamps: true });

// Compound index for efficient queries
CashBalanceSchema.index({ businessId: 1, branchId: 1, date: -1 });

export default mongoose.model("CashBalance", CashBalanceSchema);