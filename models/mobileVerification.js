// models/mobileVerification.js
// Short-lived 6-digit codes for sign-up, sign-in and password resets - used by
// BOTH the mobile app and the website (one code system, not two).
//
// Codes are stored HASHED (never plaintext), expire in 10 min via TTL index,
// and are attempt-limited so they can't be brute-forced.
//
// Phase 1 (central login) - additive, fully backward compatible:
//   • `email` is no longer required (WhatsApp/SMS codes have no email)
//   • `target`  - where the code was sent: an email, or a phone "+263..."
//   • `channel` - "email" | "whatsapp" | "sms"
//   • `userId`  - the account the code is for (sign-in / reset)
//   • extra purposes for the web flows
// Existing mobile records (email only) keep working: a pre-validate hook fills
// target/channel from email.

import mongoose from "mongoose";
import crypto from "crypto";

const MobileVerificationSchema = new mongoose.Schema({
  email: { type: String, lowercase: true, trim: true, index: true },

  target: { type: String, trim: true, index: true },
  channel: { type: String, enum: ["email", "whatsapp", "sms"], default: "email" },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },

  // sha256 of the 6-digit code - we never store the code itself
  codeHash: { type: String, required: true },

  // what this code authorises
  purpose: {
    type: String,
    enum: ["signup", "set_password", "signin", "reset_password", "verify_phone", "verify_email"],
    default: "signup"
  },

  // pending account details, held until the code is confirmed (signup only)
  pending: { type: mongoose.Schema.Types.Mixed, default: null },

  attempts: { type: Number, default: 0 },   // wrong tries so far
  consumed: { type: Boolean, default: false },

  createdAt: { type: Date, default: Date.now }
});

MobileVerificationSchema.pre("validate", function (next) {
  if (!this.target && this.email) { this.target = this.email; this.channel = "email"; }
  if (!this.target) return next(new Error("Verification needs an email or a target"));
  next();
});

// Mongo deletes the doc 10 minutes after createdAt.
MobileVerificationSchema.index({ createdAt: 1 }, { expireAfterSeconds: 600 });
MobileVerificationSchema.index({ target: 1, purpose: 1, createdAt: -1 });

MobileVerificationSchema.statics.hashCode = function (code) {
  return crypto.createHash("sha256").update(String(code)).digest("hex");
};

MobileVerificationSchema.statics.generateCode = function () {
  // 6 digits, zero-padded, cryptographically random
  return String(crypto.randomInt(0, 1000000)).padStart(6, "0");
};

export default mongoose.models.MobileVerification ||
  mongoose.model("MobileVerification", MobileVerificationSchema);
