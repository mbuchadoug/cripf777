import mongoose from "mongoose";

// ==============================
// ⚙️ HOTSPOT SETTING  (single global document)
// Small knobs the owner controls from the UI. Right now: the cap on how many
// user accounts may exist. Kept as a singleton so it is cheap to read.
// ==============================

const HotspotSettingSchema = new mongoose.Schema({
  key: { type: String, default: "global", unique: true, index: true },
  maxAccounts: { type: Number, default: 50 },   // 0 = unlimited
  updatedAt: { type: Date, default: Date.now }
}, { strict: true });

// Fetch-or-create the single settings doc.
HotspotSettingSchema.statics.get = async function () {
  let s = await this.findOne({ key: "global" });
  if (!s) s = await this.create({ key: "global" });
  return s;
};

const HotspotSetting =
  mongoose.models.HotspotSetting || mongoose.model("HotspotSetting", HotspotSettingSchema);

export default HotspotSetting;
