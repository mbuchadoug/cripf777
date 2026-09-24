// models/resePayment.js
// A worker "corner fee" payment via Paynow EcoCash.

import mongoose from "mongoose";

const ResePaymentSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "ReseUser", index: true },
  phone: { type: String, default: "" },
  reference: { type: String, unique: true },
  amount: { type: Number, default: 1 },
  days: { type: Number, default: 7 }, // access granted on success
  pollUrl: { type: String, default: "" },
  status: { type: String, enum: ["pending", "paid", "failed", "cancelled"], default: "pending" },
  createdAt: { type: Date, default: Date.now }
});

export default mongoose.models.ResePayment ||
  mongoose.model("ResePayment", ResePaymentSchema);