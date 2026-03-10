// models/supplierSubscriptionPayment.js
import mongoose from "mongoose";

const SupplierSubscriptionPaymentSchema = new mongoose.Schema({
  supplierPhone: { type: String, required: true, index: true },
  supplierId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "SupplierProfile"
  },
  tier: {
    type: String,
    enum: ["basic", "pro", "featured"],
    required: true
  },
  plan: {
    type: String,
    enum: ["monthly", "annual"],
    required: true
  },
  amount: { type: Number, required: true },
  currency: { type: String, default: "USD" },
  reference: String,
  pollUrl: String,
  ecocashPhone: String,
  status: {
    type: String,
    enum: ["pending", "paid", "failed"],
    default: "pending"
  },
  paidAt: Date,
  endsAt: Date,
  receiptUrl: String,
  receiptFilename: String
}, { timestamps: true });

export default mongoose.models.SupplierSubscriptionPayment ||
  mongoose.model(
    "SupplierSubscriptionPayment",
    SupplierSubscriptionPaymentSchema
  );