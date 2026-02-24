import mongoose from "mongoose";

const CashPayoutSchema = new mongoose.Schema({
  businessId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Business",
    required: true,
    index: true
  },

  branchId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Branch",
    required: true,
    index: true
  },

  amount: {
    type: Number,
    required: true
  },

  reason: {
    type: String,
    default: ""
  },

  createdBy: {
    type: String,
    default: null
  },

  date: {
    type: Date,
    required: true,
    index: true
  }
}, { timestamps: true });

CashPayoutSchema.index({ businessId: 1, branchId: 1, date: -1 });

export default mongoose.models.CashPayout || mongoose.model("CashPayout", CashPayoutSchema);