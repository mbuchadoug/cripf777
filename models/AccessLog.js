// models/AccessLog.js
import mongoose from 'mongoose';

const accessLogSchema = new mongoose.Schema({
  // Which code was used
  accessCode: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'AccessCode',
    required: true,
    index: true
  },
  
  code: {
    type: String,
    required: true // Store actual code for reference
  },
  
  // User information
  ipAddress: {
    type: String,
    required: true
  },
  
  userAgent: {
    type: String,
    default: null
  },
  
  device: {
    type: String, // mobile, desktop, tablet
    default: null
  },
  
  browser: {
    type: String,
    default: null
  },
  
  // Device fingerprint (to track unique devices)
  deviceFingerprint: {
    type: String,
    index: true
  },
  
  // WiFi password shown?
  passwordShown: {
    type: Boolean,
    default: false
  },
  
  // Timestamp
  accessedAt: {
    type: Date,
    default: Date.now,
    index: true
  },
  
  // Success or failure
  success: {
    type: Boolean,
    default: true
  },
  
  failureReason: {
    type: String,
    default: null
  }
}, {
  timestamps: true
});

// Indexes for analytics
accessLogSchema.index({ accessCode: 1, accessedAt: -1 });
accessLogSchema.index({ accessedAt: -1 });
accessLogSchema.index({ ipAddress: 1, accessedAt: -1 });

// Static method to get usage stats
accessLogSchema.statics.getStats = async function(codeId, startDate, endDate) {
  const stats = await this.aggregate([
    {
      $match: {
        accessCode: codeId,
        accessedAt: {
          $gte: startDate || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
          $lte: endDate || new Date()
        }
      }
    },
    {
      $group: {
        _id: null,
        totalAccesses: { $sum: 1 },
        uniqueIPs: { $addToSet: '$ipAddress' },
        uniqueDevices: { $addToSet: '$deviceFingerprint' },
        successCount: {
          $sum: { $cond: ['$success', 1, 0] }
        }
      }
    }
  ]);
  
  if (stats.length === 0) {
    return {
      totalAccesses: 0,
      uniqueIPs: 0,
      uniqueDevices: 0,
      successRate: 0
    };
  }
  
  return {
    totalAccesses: stats[0].totalAccesses,
    uniqueIPs: stats[0].uniqueIPs.length,
    uniqueDevices: stats[0].uniqueDevices.length,
    successRate: (stats[0].successCount / stats[0].totalAccesses * 100).toFixed(2)
  };
};

export default mongoose.model('AccessLog', accessLogSchema);
