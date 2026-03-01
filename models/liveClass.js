import mongoose from "mongoose";

const attendeeSchema = new mongoose.Schema({
  studentId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true
  },
  joinedAt: {
    type: Date,
    default: Date.now
  },
  leftAt: {
    type: Date,
    default: null
  },
  duration: {
    type: Number, // seconds
    default: 0
  },
  isPresent: {
    type: Boolean,
    default: true
  }
}, { _id: false });

const liveClassSchema = new mongoose.Schema({
  teacherId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
    index: true
  },
  
  title: {
    type: String,
    required: true,
    trim: true
  },
  
  subject: {
    type: String,
    required: true,
    lowercase: true
  },
  
  grade: {
    type: Number,
    required: true
  },
  
  description: {
    type: String,
    default: ""
  },
  
  // Scheduling
  scheduledStart: {
    type: Date,
    required: true,
    index: true
  },
  
  scheduledEnd: {
    type: Date,
    required: true
  },
  
  actualStart: {
    type: Date,
    default: null
  },
  
  actualEnd: {
    type: Date,
    default: null
  },
  
  // Status
  status: {
    type: String,
    enum: ['scheduled', 'live', 'ended', 'cancelled'],
    default: 'scheduled',
    index: true
  },
  
  // Attendance
  attendees: [attendeeSchema],
  
  expectedStudents: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: "User"
  }],
  
  // Recording
  recordingUrl: {
    type: String,
    default: null
  },
  
  recordingDuration: {
    type: Number,
    default: null
  },
  
  // Meeting link (if using external platform)
  meetingLink: {
    type: String,
    default: null
  },
  
  meetingPassword: {
    type: String,
    default: null
  },
  
  // Analytics
  totalAttendees: {
    type: Number,
    default: 0
  },
  
  averageAttendance: {
    type: Number, // percentage
    default: 0
  }
  
}, { timestamps: true });

// Indexes
liveClassSchema.index({ teacherId: 1, status: 1 });
liveClassSchema.index({ scheduledStart: 1, status: 1 });
liveClassSchema.index({ "attendees.studentId": 1 });

// Calculate attendance stats before save
liveClassSchema.pre('save', function(next) {
  if (this.attendees && this.attendees.length > 0) {
    this.totalAttendees = this.attendees.length;
    
    if (this.expectedStudents && this.expectedStudents.length > 0) {
      this.averageAttendance = Math.round(
        (this.totalAttendees / this.expectedStudents.length) * 100
      );
    }
  }
  next();
});

export default mongoose.model("LiveClass", liveClassSchema);