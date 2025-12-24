// models/auditPurchase.js
import mongoose from "mongoose";

const AuditPurchaseSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true
  },

  auditId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "PlacementAudit",
    required: true
  },

  pricePaid: {
    type: Number, // cents
    required: true
  },

  currency: {
    type: String,
    default: "usd"
  },

  purchasedAt: {
    type: Date,
    default: Date.now
  },

  stripeSessionId: {
    type: String,
    required: true,
    unique: true
  }
}, {
  collection: "audit_purchases"
});

export default mongoose.model("AuditPurchase", AuditPurchaseSchema);
