// models/supplierQuote.js
import mongoose from "mongoose";

const SupplierQuoteSchema = new mongoose.Schema({
  supplierId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "SupplierProfile"
  },
  supplierPhone: String,
  requestId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "BuyerRequest"
  },
  buyerPhone: String,
  message: String,
  price: String,
  seen: { type: Boolean, default: false }
}, { timestamps: true });

export default mongoose.models.SupplierQuote ||
  mongoose.model("SupplierQuote", SupplierQuoteSchema);