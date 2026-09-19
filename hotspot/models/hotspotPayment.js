import mongoose from "mongoose";

// ==============================
// 💳 HOTSPOT PAYMENT
// Self-service EcoCash purchases for WiFi vouchers. Kept SEPARATE from the
// main subscription Payment model so guest purchases (no user account, hotspot
// plan keys) never clash with that schema's rules.
// ==============================

const HotspotPaymentSchema = new mongoose.Schema({
  reference:   { type: String, required: true, unique: true, index: true },
  amount:      { type: Number, required: true },
  currency:    { type: String, default: "USD" },
  planKey:     { type: String },                 // hotspot plan (e.g. "lunch2h")
  voucherCode: { type: String, index: true },
  phone:       { type: String },
  pollUrl:     { type: String },
  method:      { type: String, default: "ecocash" },
  status: {
    type: String,
    enum: ["pending", "paid", "failed", "cancelled"],
    default: "pending",
    index: true
  },
  createdAt: { type: Date, default: Date.now },
  paidAt:    { type: Date, default: null }
}, { strict: true });

const HotspotPayment =
  mongoose.models.HotspotPayment || mongoose.model("HotspotPayment", HotspotPaymentSchema);

export default HotspotPayment;