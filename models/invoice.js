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

  createdBy: String
}, { timestamps: true });

export default mongoose.model("Invoice", InvoiceSchema);
