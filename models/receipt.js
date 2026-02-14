import mongoose from "mongoose";

const ReceiptSchema = new mongoose.Schema({
  businessId: mongoose.Schema.Types.ObjectId,
  branchId: mongoose.Schema.Types.ObjectId,
  invoiceId: mongoose.Schema.Types.ObjectId,
  paymentId: mongoose.Schema.Types.ObjectId,
  number: String,
  amount: Number,
  currency: String
}, { timestamps: true });

export default mongoose.model("Receipt", ReceiptSchema);
