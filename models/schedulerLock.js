// models/schedulerLock.js
import mongoose from "mongoose";

const SchedulerLockSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true }, // e.g. "battleScheduler"
    ownerId: { type: String, required: true },           // instance id
    expiresAt: { type: Date, required: true }            // TTL
  },
  { timestamps: true }
);

// TTL index: document auto-deletes after expiresAt passes
SchedulerLockSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export default mongoose.models.SchedulerLock ||
  mongoose.model("SchedulerLock", SchedulerLockSchema);