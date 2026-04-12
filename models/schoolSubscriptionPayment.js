import mongoose from "mongoose";

const schoolSubscriptionPaymentSchema = new mongoose.Schema({
  phone:       { type: String, required: true, index: true },
  schoolId:    { type: mongoose.Schema.Types.ObjectId, ref: "SchoolProfile" },
  tier:        { type: String, required: true },
  plan:        { type: String, required: true },

  // final amount paid after discount
  amount:      { type: Number, required: true },

  currency:    { type: String, default: "USD" },
  reference:   { type: String, required: true, unique: true },
  status:      { type: String, enum: ["pending", "paid", "failed"], default: "pending" },
  paidAt:      { type: Date, default: null },
  endsAt:      { type: Date, default: null },

  // receipt / discount breakdown
  originalAmount:  { type: Number, default: 0 },
  discountPercent: { type: Number, default: 0 },
  discountAmount:  { type: Number, default: 0 },
  paymentMethod:   { type: String, default: "cash" },
  receiptUrl:      { type: String, default: "" },
  receiptFilename: { type: String, default: "" }
}, { timestamps: true });

export default mongoose.model("SchoolSubscriptionPayment", schoolSubscriptionPaymentSchema);