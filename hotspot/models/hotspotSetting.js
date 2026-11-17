import mongoose from "mongoose";

// ==============================
// ⚙️ HOTSPOT SETTING  (single global document)
// Small knobs the owner controls from the UI. Right now: the cap on how many
// user accounts may exist. Kept as a singleton so it is cheap to read.
// ==============================

const HotspotSettingSchema = new mongoose.Schema({
  key: { type: String, default: "global", unique: true, index: true },
  maxAccounts: { type: Number, default: 50 },   // 0 = unlimited

  // ── QR / auto-login settings ──
  // loginBase: where the MikroTik hotspot login page lives, as the phone reaches
  // it. The auto-login QR points at <loginBase>/login?username=CODE&password=CODE.
  // Use the hotspot gateway IP (e.g. http://192.168.88.1) OR, better for covering
  // every SSID with one URL, a hotspot dns-name you set on all servers
  // (e.g. http://login.central). No trailing slash.
  loginBase: { type: String, default: process.env.HOTSPOT_LOGIN_BASE || "http://192.168.88.1" },
  // joinSsid: the open network name the "scan to join" QR connects phones to.
  joinSsid:  { type: String, default: process.env.HOTSPOT_JOIN_SSID || "Central Cyber" },

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
