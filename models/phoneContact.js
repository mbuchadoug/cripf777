// models/phoneContact.js
import mongoose from "mongoose";

const PhoneContactSchema = new mongoose.Schema({
  phone: { type: String, required: true, unique: true, index: true },
  firstSeen: { type: Date, default: Date.now },
  firstMessage: { type: String, default: "" },   // what they typed first
  channel: { type: String, default: "whatsapp" } // future-proof for multi-channel
}, { timestamps: true });

export default mongoose.models.PhoneContact ||
  mongoose.model("PhoneContact", PhoneContactSchema);