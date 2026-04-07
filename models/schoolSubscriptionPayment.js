// models/schoolSubscriptionPayment.js
import mongoose from "mongoose";

const schoolSubscriptionPaymentSchema = new mongoose.Schema({
  phone:       { type: String, required: true, index: true },
  schoolId:    { type: mongoose.Schema.Types.ObjectId, ref: "SchoolProfile" },
  tier:        { type: String, required: true },          // "basic" | "featured"
  plan:        { type: String, required: true },          // "monthly" | "annual"
  amount:      { type: Number, required: true },
  currency:    { type: String, default: "USD" },
  reference:   { type: String, required: true, unique: true },
  status:      { type: String, enum: ["pending","paid","failed"], default: "pending" },
  paidAt:      { type: Date, default: null },
  endsAt:      { type: Date, default: null }
}, { timestamps: true });

export default mongoose.model("SchoolSubscriptionPayment", schoolSubscriptionPaymentSchema);