// models/supplierLinkVisitor.js
// ─── Smart Link Visitor Database ──────────────────────────────────────────────
//
// Captures every WhatsApp phone number that opens a supplier smart link,
// a supplier slug link, or a staff e-business card link.
//
// One record per (phone + supplierId/staffCardId) - upserted on each open.
// linkType: "supplier" | "staff"
//
// Used for:
//   - Admin contact viewer: see who opened your profile
//   - Chatbot "my contacts" command (when canViewContacts=true on the profile)
//   - Source analytics (which channel brings the most visitors)
//   - Follow-up lead tracking
//
import mongoose from "mongoose";

const supplierLinkVisitorSchema = new mongoose.Schema({
  // ── What was opened ────────────────────────────────────────────────────────
  linkType:   { type: String, enum: ["supplier", "staff"], required: true, index: true },
  supplierId: { type: mongoose.Schema.Types.ObjectId, ref: "SupplierProfile", required: true, index: true },
  staffCardId:{ type: mongoose.Schema.Types.ObjectId, ref: "StaffCard", default: null, index: true },

  // ── Who opened it ─────────────────────────────────────────────────────────
  phone:      { type: String, required: true, index: true },

  // ── How and when ──────────────────────────────────────────────────────────
  source:     { type: String, default: "direct" },  // fb | wa | tt | qr | sms | ig | yt | direct
  firstSeen:  { type: Date,   default: Date.now },
  lastSeen:   { type: Date,   default: Date.now },
  viewCount:  { type: Number, default: 1 },

  // ── Conversion tracking ───────────────────────────────────────────────────
  // converted = true when visitor sent a quote, order, booking or enquiry
  converted:  { type: Boolean, default: false },
  convertedAt:{ type: Date, default: null },

  // ── Admin notes ───────────────────────────────────────────────────────────
  notes:      { type: String, default: "" }
}, {
  timestamps: true
});

// One record per phone+supplierId+linkType (staff and supplier tracked separately)
supplierLinkVisitorSchema.index({ supplierId: 1, phone: 1, linkType: 1 }, { unique: true });
// Fast lookup: all visitors for a supplier, latest first
supplierLinkVisitorSchema.index({ supplierId: 1, linkType: 1, lastSeen: -1 });
// Fast lookup: all visitors for a staff card
supplierLinkVisitorSchema.index({ staffCardId: 1, lastSeen: -1 });

export default mongoose.models.SupplierLinkVisitor
  || mongoose.model("SupplierLinkVisitor", supplierLinkVisitorSchema);