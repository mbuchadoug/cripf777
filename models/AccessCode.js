// models/AccessCode.js
import mongoose from 'mongoose';

const accessCodeSchema = new mongoose.Schema({
  code: {
    type: String,
    required: true,
    unique: true,
    uppercase: true,
    index: true
  },
  
  // Who created this code
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  
  // Code details
  description: {
    type: String, // e.g., "John's visitor", "Client meeting"
    default: ''
  },
  
  // Expiration
  expiresAt: {
    type: Date,
    required: true,
    index: true
  },
  
  // Usage limits
  maxUses: {
    type: Number,
    default: null // null = unlimited uses
  },
  
  currentUses: {
    type: Number,
    default: 0
  },
  
  // Device limit
  maxDevices: {
    type: Number,
    default: null // null = unlimited devices
  },
  
  // Status
  isActive: {
    type: Boolean,
    default: true,
    index: true
  },
  
  // Revocation
  revokedAt: {
    type: Date,
    default: null
  },
  
  revokedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  },
  
  revokeReason: {
    type: String,
    default: null
  },
  
  // Metadata
  createdAt: {
    type: Date,
    default: Date.now,
    index: true
  }
}, {
  timestamps: true
});

// Indexes for performance
accessCodeSchema.index({ isActive: 1, expiresAt: 1 });
accessCodeSchema.index({ createdBy: 1, createdAt: -1 });

// Virtual for checking if code is valid
accessCodeSchema.virtual('isValid').get(function() {
  if (!this.isActive) return false;
  if (this.revokedAt) return false;
  if (this.expiresAt < new Date()) return false;
  if (this.maxUses && this.currentUses >= this.maxUses) return false;
  return true;
});

// Method to increment usage
accessCodeSchema.methods.recordUse = async function() {
  this.currentUses += 1;
  await this.save();
};

// Method to revoke code
accessCodeSchema.methods.revoke = async function(userId, reason) {
  this.isActive = false;
  this.revokedAt = new Date();
  this.revokedBy = userId;
  this.revokeReason = reason;
  await this.save();
};

// Static method to generate unique code
accessCodeSchema.statics.generateCode = async function() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // Exclude confusing chars
  let code;
  let exists = true;
  
  while (exists) {
    code = '';
    for (let i = 0; i < 8; i++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    exists = await this.findOne({ code });
  }
  
  return code;
};

// Clean up expired codes periodically (call this from cron job)
accessCodeSchema.statics.cleanExpired = async function() {
  const result = await this.updateMany(
    { 
      expiresAt: { $lt: new Date() },
      isActive: true
    },
    { 
      isActive: false 
    }
  );
  return result.modifiedCount;
};

export default mongoose.model('AccessCode', accessCodeSchema);
