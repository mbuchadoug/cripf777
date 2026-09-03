import mongoose from "mongoose";

// ==============================
// 🎥 BYPASS DEVICE
// Anything that must NEVER see the voucher login page: your 10 cameras,
// reception PC, staff devices. Stored here, pushed to the router as an
// "ip-binding / bypassed" entry so it's always allowed straight through.
// ==============================

const BypassDeviceSchema = new mongoose.Schema({
  mac: {
    type: String,
    required: true,
    unique: true,
    uppercase: true,
    trim: true,
    index: true
  },

  label: { type: String, required: true },   // "Reception camera", "Front desk PC"

  category: {
    type: String,
    enum: ["camera", "reception", "staff", "other"],
    default: "camera",
    index: true
  },

  active: { type: Boolean, default: true, index: true },

  rosBindingId:   { type: String, default: null },   // *XX id on the router
  syncedToRouter: { type: Boolean, default: false },
  lastSyncError:  { type: String, default: null },

  createdByName: { type: String, default: "" },
  createdAt:     { type: Date, default: Date.now }
}, { strict: true });

// Normalise a MAC to AA:BB:CC:DD:EE:FF (accepts dashes, dots, no separators).
BypassDeviceSchema.statics.normaliseMac = function (raw) {
  const hex = String(raw || "").toUpperCase().replace(/[^0-9A-F]/g, "");
  if (hex.length !== 12) return null;
  return hex.match(/.{2}/g).join(":");
};

const BypassDevice =
  mongoose.models.BypassDevice || mongoose.model("BypassDevice", BypassDeviceSchema);

export default BypassDevice;