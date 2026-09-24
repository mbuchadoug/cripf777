// models/reseOtp.js
// Short-lived phone login codes. Stored HASHED, expire in 10 min via TTL index,
// attempt-limited so they can't be brute-forced.

import mongoose from "mongoose";
import crypto from "crypto";

const ReseOtpSchema = new mongoose.Schema({
  phone: { type: String, required: true, index: true }, // +2637...
  codeHash: { type: String, required: true },
  attempts: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now }
});

// Mongo deletes the doc 10 minutes after createdAt.
ReseOtpSchema.index({ createdAt: 1 }, { expireAfterSeconds: 600 });

ReseOtpSchema.statics.hashCode = function (code) {
  return crypto.createHash("sha256").update(String(code)).digest("hex");
};
ReseOtpSchema.statics.generateCode = function () {
  return String(crypto.randomInt(0, 1000000)).padStart(6, "0");
};

export default mongoose.models.ReseOtp || mongoose.model("ReseOtp", ReseOtpSchema);