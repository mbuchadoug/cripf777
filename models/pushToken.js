// models/pushToken.js — one row per device per user (a user can have several devices).
import mongoose from "mongoose";
const PushTokenSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
  token: { type: String, required: true, index: true },          // Expo push token
  platform: { type: String, enum: ["ios", "android", "web"], default: "android" },
  active: { type: Boolean, default: true }
}, { timestamps: true });
PushTokenSchema.index({ user: 1, token: 1 }, { unique: true });
export default mongoose.models.PushToken || mongoose.model("PushToken", PushTokenSchema);