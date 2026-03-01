import mongoose from "mongoose";

const FILE_SIZE_LIMITS = {
  // Documents
  'application/pdf': 50 * 1024 * 1024, // 50MB
  'application/msword': 25 * 1024 * 1024, // 25MB
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 25 * 1024 * 1024, // 25MB
  'application/vnd.ms-powerpoint': 50 * 1024 * 1024, // 50MB
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 50 * 1024 * 1024, // 50MB
  
  // Images
  'image/jpeg': 10 * 1024 * 1024, // 10MB
  'image/png': 10 * 1024 * 1024, // 10MB
  'image/gif': 5 * 1024 * 1024, // 5MB
  'image/webp': 10 * 1024 * 1024, // 10MB
  
  // Audio
  'audio/mpeg': 50 * 1024 * 1024, // 50MB (MP3)
  'audio/wav': 100 * 1024 * 1024, // 100MB
  'audio/mp4': 50 * 1024 * 1024, // 50MB (M4A)
  
  // Video
  'video/mp4': 500 * 1024 * 1024, // 500MB
  'video/webm': 500 * 1024 * 1024, // 500MB
  'video/quicktime': 500 * 1024 * 1024, // 500MB (MOV)
  
  // Text
  'text/plain': 5 * 1024 * 1024, // 5MB
  'text/markdown': 5 * 1024 * 1024 // 5MB
};

const ALLOWED_TYPES = Object.keys(FILE_SIZE_LIMITS);

const learningMaterialSchema = new mongoose.Schema({
  teacherId: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: "User", 
    required: true, 
    index: true 
  },
  
  title: { 
    type: String, 
    required: true,
    trim: true,
    maxlength: 200
  },
  
  subject: { 
    type: String, 
    required: true,
    lowercase: true,
    index: true
  },
  
  grade: { 
    type: Number, 
    required: true,
    min: 0,
    max: 13,
    index: true
  },
  
  description: { 
    type: String, 
    default: "",
    maxlength: 1000
  },
  
  // Text content (for typed materials)
  content: { 
    type: String, 
    default: null 
  },
  
  // File storage
  fileUrl: { 
    type: String, 
    default: null 
  },
  
  fileType: { 
    type: String, 
    default: null,
    enum: [...ALLOWED_TYPES, null]
  },
  
  fileName: {
    type: String,
    default: null
  },
  
  fileSize: {
    type: Number,
    default: 0
  },
  
  // Video streaming metadata
  isVideo: {
    type: Boolean,
    default: false
  },
  
  videoProcessingStatus: {
    type: String,
    enum: ['pending', 'processing', 'ready', 'failed', null],
    default: null
  },
  
  streamUrl: {
    type: String,
    default: null
  },
  
  thumbnailUrl: {
    type: String,
    default: null
  },
  
  duration: {
    type: Number, // seconds
    default: null
  },
  
  // Assignment
  assignedTo: [{ 
    type: mongoose.Schema.Types.ObjectId, 
    ref: "User" 
  }],
  
  assignmentType: {
    type: String,
    enum: ['individual', 'grade', 'all'],
    default: 'individual'
  },
  
  // Visibility
  status: { 
    type: String, 
    default: "active", 
    enum: ["active", "archived", "processing"] 
  },
  
  // Analytics
  viewCount: {
    type: Number,
    default: 0
  },
  
  lastViewedAt: {
    type: Date,
    default: null
  },
  
  // Download protection
  allowDownload: {
    type: Boolean,
    default: false
  }
}, { 
  timestamps: true 
});

// Indexes for efficient queries
learningMaterialSchema.index({ teacherId: 1, status: 1 });
learningMaterialSchema.index({ grade: 1, subject: 1, status: 1 });
learningMaterialSchema.index({ assignedTo: 1, status: 1 });

// Validate file size before save
learningMaterialSchema.pre('save', function(next) {
  if (this.fileType && this.fileSize) {
    const limit = FILE_SIZE_LIMITS[this.fileType];
    if (limit && this.fileSize > limit) {
      return next(new Error(`File size ${(this.fileSize / 1024 / 1024).toFixed(2)}MB exceeds limit of ${(limit / 1024 / 1024)}MB for ${this.fileType}`));
    }
  }
  
  // Auto-detect if video
  if (this.fileType && this.fileType.startsWith('video/')) {
    this.isVideo = true;
    if (!this.videoProcessingStatus) {
      this.videoProcessingStatus = 'pending';
    }
  }
  
  next();
});

// Helper method to get file size limit
learningMaterialSchema.statics.getFileSizeLimit = function(mimeType) {
  return FILE_SIZE_LIMITS[mimeType] || null;
};

// Helper method to check if type is allowed
learningMaterialSchema.statics.isTypeAllowed = function(mimeType) {
  return ALLOWED_TYPES.includes(mimeType);
};

export default mongoose.model("LearningMaterial", learningMaterialSchema);
export { FILE_SIZE_LIMITS, ALLOWED_TYPES };