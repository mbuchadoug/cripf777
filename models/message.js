// models/message.js — a single chat message. Media is a reference to an uploaded blob.
import mongoose from "mongoose";
const MessageSchema = new mongoose.Schema({
  conversation: { type: mongoose.Schema.Types.ObjectId, ref: "Conversation", required: true, index: true },
  sender: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
  text: { type: String, default: "" },
  media: { kind: { type: String, enum: ["image", "audio", "file", null], default: null }, url: String, name: String, size: Number, mime: String },
  replyTo: { type: mongoose.Schema.Types.ObjectId, ref: "Message", default: null },
  deletedFor: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],  // hide for these users
  deletedForAll: { type: Boolean, default: false },                      // "delete for everyone"
  readBy: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }]
}, { timestamps: true });
MessageSchema.index({ conversation: 1, createdAt: -1 });
export default mongoose.models.Message || mongoose.model("Message", MessageSchema);