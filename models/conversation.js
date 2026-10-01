// models/conversation.js - a 1:1 (or small group) thread between connected people.
import mongoose from "mongoose";
const ConversationSchema = new mongoose.Schema({
  participants: [{ type: mongoose.Schema.Types.ObjectId, ref: "User", index: true }],
  isGroup: { type: Boolean, default: false },
  title: { type: String, default: "" },
  lastMessage: { text: String, sender: mongoose.Schema.Types.ObjectId, at: Date },
  lastActivity: { type: Date, default: Date.now, index: true }
}, { timestamps: true });
export default mongoose.models.Conversation || mongoose.model("Conversation", ConversationSchema);