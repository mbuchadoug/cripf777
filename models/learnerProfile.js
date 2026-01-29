import mongoose from "mongoose";

const LearnerProfileSchema = new mongoose.Schema({
  parentUserId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
    index: true
  },

  displayName: {
    type: String,
    required: true
  },

  schoolLevel: {
    type: String,
    enum: ["junior", "high"],
    required: true,
    index: true
  },

  grade: {
    type: Number,
    required: true,
    index: true
  },

  subjects: [{
    type: String,
    enum: ["maths", "english", "science"]
  }],

  subscriptionStatus: {
    type: String,
    enum: ["trial", "paid"],
    default: "trial",
    index: true
  },

  trialCounters: {
    maths: { type: Number, default: 0 },
    english: { type: Number, default: 0 },
    science: { type: Number, default: 0 }
  },

  createdAt: {
    type: Date,
    default: Date.now
  }
});

export default mongoose.model("LearnerProfile", LearnerProfileSchema);
