// models/mobileVerification.js
// Short-lived 6-digit codes for email verification and password setup.
// Codes are stored HASHED (never plaintext), expire in 10 min via TTL index,
// and are attempt-limited so they can't be brute-forced.

import mongoose from "mongoose";
import crypto from "crypto";

const MobileVerificationSchema = new mongoose.Schema({
  email: { type: String, required: true, lowercase: true, trim: true, index: true },

  // sha256 of the 6-digit code - we never store the code itself
  codeHash: { type: String, required: true },

  // what this code authorises
  purpose: {
    type: String,
    enum: ["signup", "set_password", "signin"],
    default: "signup"
  },

  // pending account details, held until the code is confirmed (signup only)
  pending: { type: mongoose.Schema.Types.Mixed, default: null },

  attempts: { type: Number, default: 0 },   // wrong tries so far
  consumed: { type: Boolean, default: false },

  createdAt: { type: Date, default: Date.now }
});

// Mongo deletes the doc 10 minutes after createdAt.
MobileVerificationSchema.index({ createdAt: 1 }, { expireAfterSeconds: 600 });

MobileVerificationSchema.statics.hashCode = function (code) {
  return crypto.createHash("sha256").update(String(code)).digest("hex");
};

MobileVerificationSchema.statics.generateCode = function () {
  // 6 digits, zero-padded, cryptographically random
  return String(crypto.randomInt(0, 1000000)).padStart(6, "0");
};

export default mongoose.models.MobileVerification ||
  mongoose.model("MobileVerification", MobileVerificationSchema);
