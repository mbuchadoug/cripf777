// models/supplierOrder.js
import mongoose from "mongoose";

const SupplierOrderSchema = new mongoose.Schema({
  supplierId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "SupplierProfile",
    required: true
  },
  supplierPhone: { type: String, required: true },
  buyerPhone: { type: String, required: true },

  items: [{
    product: String,
    quantity: Number,
    unit: String,
    pricePerUnit: Number,
    currency: String,
    total: Number
  }],

  totalAmount: { type: Number, required: true },
  currency: { type: String, default: "USD" },

  delivery: {
    required: { type: Boolean, default: false },
    address: String,
    fee: { type: Number, default: 0 },
    estimatedDate: String
  },

  status: {
    type: String,
    enum: [
      "pending",
      "accepted",
      "declined",
      "completed",
      "cancelled",
      "disputed"
    ],
    default: "pending"
  },

  declineReason: String,
  supplierNote: String,

  // Rating
  buyerRating: { type: Number },
  buyerRatingTags: [String],
  supplierRating: { type: String, enum: ["good", "problem"] },
  ratingPromptSent: { type: Boolean, default: false }

}, { timestamps: true });

SupplierOrderSchema.index({ supplierPhone: 1, status: 1 });
SupplierOrderSchema.index({ buyerPhone: 1, status: 1 });

export default mongoose.models.SupplierOrder ||
  mongoose.model("SupplierOrder", SupplierOrderSchema);