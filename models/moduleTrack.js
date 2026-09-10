// models/moduleTrack.js
// A capstone definition for a MODULE / PILLAR (e.g. "consciousness").
// The admin chooses which area courses count toward the module certificate and
// how many must be completed. Completing them issues the "Certificate of
// Mastery" (the ultimatum credential).
import mongoose from "mongoose";

const GradeBandSchema = new mongoose.Schema({
  label: { type: String, required: true },
  min: { type: Number, required: true }
}, { _id: false });

const ModuleTrackSchema = new mongoose.Schema({
  pillar: { type: String, required: true, index: true },   // "consciousness" | "responsibility" | …
  title: { type: String, required: true },                  // "Consciousness - Module Mastery"
  slug: { type: String, required: true, unique: true, index: true },
  description: { type: String, default: "" },

  org: { type: mongoose.Schema.Types.ObjectId, ref: "Organization", index: true, default: null },
  role: { type: String, default: "professional", index: true },

  // Which area courses make up this module (admin-selected).
  courseIds: [{ type: mongoose.Schema.Types.ObjectId, ref: "Course" }],

  rules: {
    // How many member courses must be completed. null = all of them.
    minCoursesToComplete: { type: Number, default: null },
    // Capstone classification on the average of member-course overall %.
    gradeBands: {
      type: [GradeBandSchema],
      default: () => ([
        { label: "Pass", min: 70 },
        { label: "Merit", min: 80 },
        { label: "Mastery", min: 90 }
      ])
    }
  },

  published: { type: Boolean, default: false, index: true },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null }
}, { timestamps: true });

export default mongoose.models.ModuleTrack || mongoose.model("ModuleTrack", ModuleTrackSchema);