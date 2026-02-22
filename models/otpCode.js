import mongoose from "mongoose";

const OTPCodeSchema = new mongoose.Schema({
  phone: {
    type: String,
    required: true,
    index: true
  },
  
  code: {
    type: String,
    required: true
  },
  
  expiresAt: {
    type: Date,
    required: true,
    index: true
  },
  
  verified: {
    type: Boolean,
    default: false
  },
  
  attempts: {
    type: Number,
    default: 0
  }
}, { timestamps: true });

// Auto-delete expired OTPs after 10 minutes
OTPCodeSchema.index({ createdAt: 1 }, { expireAfterSeconds: 600 });

export default mongoose.model("OTPCode", OTPCodeSchema);