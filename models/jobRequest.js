// models/jobRequest.js
//
// One casual job. Short-lived by design (Rese Rese jobs are "right now"), so it
// carries an expiresAt the app/cron can use to auto-close stale posts.

import mongoose from "mongoose";

const JobRequestSchema = new mongoose.Schema({
  // Who asked
  poster: { type: mongoose.Schema.Types.ObjectId, ref: "ReseUser", index: true },
  posterPhone: { type: String, default: "" },
  posterName: { type: String, default: "" },

  // What
  category: { type: String, required: true, index: true }, // water, clean, ...
  description: { type: String, default: "" },
  suburb: { type: String, default: "", index: true },
  budget: { type: String, default: "" }, // free text: "$2", "discuss"

  // Lifecycle
  status: {
    type: String,
    enum: ["open", "accepted", "done", "cancelled", "expired"],
    default: "open",
    index: true
  },

  // Who took it
  worker: { type: mongoose.Schema.Types.ObjectId, ref: "ReseUser", default: null },
  workerPhone: { type: String, default: "" },
  workerName: { type: String, default: "" },

  // Moderation
  flagged: { type: Boolean, default: false },
  removedByAdmin: { type: Boolean, default: false },

  meta: {
    source: { type: String, default: "mobile-app" }
  },

  createdAt: { type: Date, default: Date.now, index: true },
  acceptedAt: { type: Date, default: null },
  completedAt: { type: Date, default: null },
  expiresAt: { type: Date, default: null } // set to now + N hours on create
});

export default mongoose.models.JobRequest ||
  mongoose.model("JobRequest", JobRequestSchema);
