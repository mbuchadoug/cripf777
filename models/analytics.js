// models/analytics.js
import mongoose from "mongoose";

const analyticsSchema = new mongoose.Schema({
  // Session tracking
  sessionId: { type: String, required: true, index: true },
  
  // User identification
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", index: true },
  userRole: { type: String }, // student, parent, admin, employee, visitor
  
  // Page view details
  path: { type: String, required: true, index: true },
  method: { type: String, default: "GET" },
  statusCode: { type: Number },
  
  // Request metadata
  referrer: { type: String },
  userAgent: { type: String },
  
  // Device/Browser info
  device: {
    type: { type: String }, // mobile, tablet, desktop
    os: { type: String },
    browser: { type: String },
    version: { type: String }
  },
  
  // Location (from IP)
  ip: { type: String },
  country: { type: String },
  city: { type: String },
  
  // Timing
  responseTime: { type: Number }, // milliseconds
  timestamp: { type: Date, default: Date.now, index: true },
  
  // Organization context
  organizationId: { type: mongoose.Schema.Types.ObjectId, ref: "Organization" },
  
  // UTM parameters (marketing)
  utm: {
    source: { type: String },
    medium: { type: String },
    campaign: { type: String },
    term: { type: String },
    content: { type: String }
  }
}, {
  timestamps: true
});

// Indexes for common queries
analyticsSchema.index({ timestamp: -1 });
analyticsSchema.index({ path: 1, timestamp: -1 });
analyticsSchema.index({ userId: 1, timestamp: -1 });
analyticsSchema.index({ sessionId: 1, timestamp: -1 });
analyticsSchema.index({ "device.type": 1, timestamp: -1 });

// TTL index - auto-delete records older than 90 days (optional)
// analyticsSchema.index({ timestamp: 1 }, { expireAfterSeconds: 7776000 }); // 90 days

const Analytics = mongoose.model("Analytics", analyticsSchema);

export default Analytics;