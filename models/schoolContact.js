// models/schoolContact.js
// ─── School Contact Database ──────────────────────────────────────────────────
//
// Captures every person who interacts with a school's smart links:
//   - Opened school profile QR / smart link   (source: "profile")
//   - Opened application form QR / smart link (source: "apply")
//   - Submitted an application                (source: "apply", converted: true)
//   - Sent an enquiry                         (source: "enquiry")
//
// One record per (phone + schoolId) combination — upserted on each interaction.
// Used for:
//   - Follow-up campaigns by school admins
//   - Conversion tracking (viewed → applied → enrolled)
//   - Contact export (CSV) from admin panel
//
import mongoose from "mongoose";

const schoolContactSchema = new mongoose.Schema({
  schoolId:    { type: mongoose.Schema.Types.ObjectId, ref: "SchoolProfile", required: true, index: true },
  phone:       { type: String, required: true, index: true },

  // What we know about this person
  name:        { type: String, default: null },       // captured if they submitted application
  parentName:  { type: String, default: null },
  studentName: { type: String, default: null },
  gradeInterest: { type: String, default: null },     // grade they applied for or browsed

  // Interaction tracking
  source:      { type: String, enum: ["profile", "apply", "enquiry", "brochure"], default: "profile" },
  firstSeen:   { type: Date, default: Date.now },
  lastSeen:    { type: Date, default: Date.now },
  viewCount:   { type: Number, default: 1 },          // how many times they opened any link

  // Conversion
  appliedAt:   { type: Date, default: null },         // when they submitted application
  converted:   { type: Boolean, default: false },     // true = submitted application

  // Application data (stored when they complete the WhatsApp form)
  applicationData: { type: mongoose.Schema.Types.Mixed, default: null },

  // Notes (admin can add follow-up notes)
  notes:       { type: String, default: "" },
  status:      { type: String, enum: ["new", "contacted", "enrolled", "not_interested"], default: "new" }
}, {
  timestamps: true
});

// Compound unique index: one record per phone+school
schoolContactSchema.index({ schoolId: 1, phone: 1 }, { unique: true });

export default mongoose.models.SchoolContact
  || mongoose.model("SchoolContact", schoolContactSchema);