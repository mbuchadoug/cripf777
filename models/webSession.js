import mongoose from "mongoose";

const WebSessionSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "UserRole",
    required: true,
    index: true
  },
  
  businessId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Business",
    required: true
  },
  
  phone: {
    type: String,
    required: true
  },
  
  ipAddress: String,
  userAgent: String,
  
  lastActivity: {
    type: Date,
    default: Date.now
  }
}, { timestamps: true });

// Auto-delete sessions after 30 days of inactivity
WebSessionSchema.index({ lastActivity: 1 }, { expireAfterSeconds: 2592000 });

export default mongoose.model("WebSession", WebSessionSchema);