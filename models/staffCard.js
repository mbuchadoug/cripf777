// models/staffCard.js
// ─── ZimQuote Staff E-Business Card Model ─────────────────────────────────────
//
// One document per staff member (salesperson, consultant, agent, driver, etc.).
// Each card is linked to a parent SupplierProfile and generates its own
// WhatsApp deep link + QR so the admin can issue personalised smart links
// to every member of their sales team.
//
// Deep link payload formats:
//   ZQ:STAFF:<cardId>                  → direct, no source
//   ZQ:STAFF:<cardId>:SRC:fb           → Facebook source
//   ZQ:STAFF:<cardId>:SRC:qr           → QR scan
//   ZQ:STAFF:SLUG:<slug>               → human-readable slug variant
//   ZQ:STAFF:SLUG:<slug>:SRC:wa        → slug + source
//
// On intercept:
//   1. Loads StaffCard + parent SupplierProfile
//   2. Tracks view on StaffCard (per-source)
//   3. Notifies salesperson via staff_card_opened template (outside 24hr)
//   4. Notifies business owner via supplier_link_opened template (outside 24hr)
//   5. Calls showSellerMenu with scStaffCardId injected → full buyer experience
//   6. When buyer sends enquiry/quote, BOTH salesperson + owner are notified
//
// ─────────────────────────────────────────────────────────────────────────────

import mongoose from "mongoose";

const StaffCardSchema = new mongoose.Schema({

  // ── Parent business linkage ────────────────────────────────────────────────
  supplierId: {
    type:     mongoose.Schema.Types.ObjectId,
    ref:      "SupplierProfile",
    required: true,
    index:    true
  },

  // ── Personal details (shown on the card) ──────────────────────────────────
  name:     { type: String, required: true, trim: true },   // "Muchaneta Horinda"
  title:    { type: String, default: "",    trim: true },   // "Sales & Marketing Consultant"
  phone:    { type: String, required: true, trim: true },   // "263772570345"  ← international format
  email:    { type: String, default: "",    trim: true },   // optional
  photoUrl: { type: String, default: "" },                  // URL to profile photo (optional)

  // ── Optional display overrides ─────────────────────────────────────────────
  // locationLabel:  replaces parent city/area on the card  e.g. "Mutare Branch"
  // tagline:        personal tagline shown beneath title   e.g. "For the golden finish you deserve"
  // These inherit from the parent supplier if left blank.
  locationLabel: { type: String, default: "", trim: true },
  tagline:       { type: String, default: "", trim: true, maxlength: 100 },

  // ── Smart link / slug ──────────────────────────────────────────────────────
  // Slug format: <biz-slug>-<firstname>  e.g. "zibugold-construction-muchaneta"
  // sparse=true so un-slugged cards don't conflict on the unique index.
  zqSlug:            { type: String, unique: true, sparse: true },

  // ── Analytics (mirrors SupplierProfile pattern) ───────────────────────────
  zqLinkViews:         { type: Number, default: 0 },         // total opens
  zqLinkConversions:   { type: Number, default: 0 },         // enquiries / quotes / bookings
  zqSourceViews:       { type: Object, default: {} },        // { fb:12, wa:8, qr:3, ... }
  zqSourceConversions: { type: Object, default: {} },

  // ── Status ─────────────────────────────────────────────────────────────────
  // active=false → link gracefully falls back to parent supplier, still logs view
  active:     { type: Boolean, default: true },

  // ── Contact visibility (admin-controlled) ──────────────────────────────────
  // When true, the staff member can type "my contacts" in the chatbot to see
  // phones that opened their personal staff card link.
  // Only ZimQuote admin can enable - staff never self-enable.
  canViewContacts: { type: Boolean, default: false },

  // ── Admin-only internal notes (never shown to buyers) ─────────────────────
  adminNotes: { type: String, default: "", maxlength: 300 }

}, { timestamps: true });

// ── Compound indexes ──────────────────────────────────────────────────────────
StaffCardSchema.index({ supplierId: 1, active: 1 });
StaffCardSchema.index({ supplierId: 1, createdAt: -1 });
// Phone index so chatbot can look up a staff member's card by their own phone
// (used when the salesperson types "my card" to the bot to see their own stats)
StaffCardSchema.index({ phone: 1 });

export default mongoose.models.StaffCard ||
  mongoose.model("StaffCard", StaffCardSchema);