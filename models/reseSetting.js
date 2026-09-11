// models/reseSetting.js
//
// A single settings document the admin edits. Loaded via ReseSetting.load()
// which creates it with defaults on first use.

import mongoose from "mongoose";

const ReseSettingSchema = new mongoose.Schema({
  key: { type: String, default: "singleton", unique: true },

  // Minimum age to work. Age-restricted work requires an adult-confirmed worker.
  minAge: { type: Number, default: 18 },

  // If true, a worker must be approved by an admin before they receive jobs.
  requireWorkerApproval: { type: Boolean, default: true },

  // If true, a worker must be ID-verified before they receive jobs.
  requireVerification: { type: Boolean, default: false },

  // Auto-close open jobs after this many hours.
  autoExpireHours: { type: Number, default: 3 },

  // Category ids that only adult-confirmed workers may take.
  ageRestrictedCategories: { type: [String], default: [] },

  updatedAt: { type: Date, default: Date.now }
});

ReseSettingSchema.statics.load = async function () {
  let doc = await this.findOne({ key: "singleton" });
  if (!doc) doc = await this.create({ key: "singleton" });
  return doc;
};

export default mongoose.models.ReseSetting ||
  mongoose.model("ReseSetting", ReseSettingSchema);
