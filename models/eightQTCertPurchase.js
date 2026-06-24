// models/eightQTCertPurchase.js
// Tracks Stripe certificate purchase — idempotency guard and audit trail
import mongoose from "mongoose";

const EightQTCertPurchaseSchema = new mongoose.Schema({
  attemptId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "EightQTAttempt",
    required: true,
    index: true
  },
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    default: null,
    index: true
  },
  participantCode: { type: String, default: null },
  stripeSessionId: { type: String, required: true, unique: true },
  amountPaid: { type: Number, default: 0 },         // in cents
  currency: { type: String, default: "usd" },
  tier: { type: String, default: "standard" },       // standard | premium
  status: {
    type: String,
    enum: ["pending", "complete", "failed"],
    default: "pending"
  },
  paidAt: { type: Date, default: null }
}, { timestamps: true });

export default mongoose.models.EightQTCertPurchase ||
  mongoose.model("EightQTCertPurchase", EightQTCertPurchaseSchema);
