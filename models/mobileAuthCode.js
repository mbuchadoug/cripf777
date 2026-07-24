// models/mobileAuthCode.js
//
// A single-use, short-lived code handed back to the mobile app after Google
// OAuth completes. The app trades it for a JWT over POST.
//
// Why not put the JWT straight in the redirect URL? Because a custom scheme
// redirect (cripfcnt://) is visible to the OS and, on Android, another app can
// in principle register the same scheme. A one-time code that expires in five
// minutes and dies on first use is worth the extra round trip.
//
// The TTL index means Mongo cleans these up itself — nothing to maintain.

import mongoose from "mongoose";

const MobileAuthCodeSchema = new mongoose.Schema({
  code: { type: String, required: true, unique: true, index: true },

  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
    index: true
  },

  // Set once the code has been redeemed. A second attempt is rejected.
  usedAt: { type: Date, default: null },

  createdAt: { type: Date, default: Date.now }
});

// Mongo deletes the document 5 minutes after createdAt.
MobileAuthCodeSchema.index({ createdAt: 1 }, { expireAfterSeconds: 300 });

export default mongoose.models.MobileAuthCode ||
  mongoose.model("MobileAuthCode", MobileAuthCodeSchema);