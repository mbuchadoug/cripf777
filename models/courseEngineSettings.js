// models/courseEngineSettings.js
// ─────────────────────────────────────────────────────────────────────────────
// One settings document per org (org:null = global default). Holds the defaults
// the auto-provisioning engine uses when it mints a course per professional area
// and bundles areas into the 8 CRIPFCnt modules. Admins can change any of these;
// per-module overrides beat the global default, and a per-course quizTarget beats
// the module override.
// ─────────────────────────────────────────────────────────────────────────────
import mongoose from "mongoose";

const ModuleSettingSchema = new mongoose.Schema({
  pillar: { type: String, required: true },              // consciousness | responsibility | …
  quizzesPerCourse: { type: Number, default: null },     // null → use global default
  minCoursesToComplete: { type: Number, default: null }, // capstone gate; null → all courses in module
  enabled: { type: Boolean, default: true }
}, { _id: false });

const CourseEngineSettingsSchema = new mongoose.Schema({
  org: { type: mongoose.Schema.Types.ObjectId, ref: "Organization", default: null, unique: true, sparse: true },

  // How many assessments a generated course should contain by default
  defaultQuizzesPerCourse: { type: Number, default: 12 },
  // How the default quizzes are chosen from an area's passages
  selectionStrategy: { type: String, enum: ["balanced", "first", "random"], default: "balanced" },

  // Defaults stamped onto newly generated courses
  defaultLevel: { type: String, enum: ["foundation", "intermediate", "advanced"], default: "foundation" },
  defaultAccessType: { type: String, enum: ["free", "paid", "invite"], default: "free" },
  defaultPrice: { type: Number, default: 0 },
  autoPublish: { type: Boolean, default: true },

  // Per-module overrides (seeded with the 8 pillars)
  moduleSettings: { type: [ModuleSettingSchema], default: [] }
}, { timestamps: true });

export default mongoose.models.CourseEngineSettings ||
  mongoose.model("CourseEngineSettings", CourseEngineSettingsSchema);