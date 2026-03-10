// models/buyerRequest.js
import mongoose from "mongoose";

const BuyerRequestSchema = new mongoose.Schema({
  buyerPhone: { type: String, required: true, index: true },
  category: String,
  description: { type: String, required: true },
  city: String,
  budget: String,
  status: {
    type: String,
    enum: ["open", "fulfilled", "expired", "cancelled"],
    default: "open"
  },
  quotesCount: { type: Number, default: 0 },
  expiresAt: {
    type: Date,
    default: () => new Date(Date.now() + 24 * 60 * 60 * 1000)
  }
}, { timestamps: true });

export default mongoose.models.BuyerRequest ||
  mongoose.model("BuyerRequest", BuyerRequestSchema);