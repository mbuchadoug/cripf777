// models/schoolLead.js
// ─── ZimQuote Smart Card - Lead Database ─────────────────────────────────────
//
// Every parent who opens a Smart Card and interacts with it becomes a lead.
// Leads are created by two paths:
//   1. The public Smart Card page (POST /s/:slug/capture) - before WA opens
//   2. The WhatsApp bot - when a parent enquires via the bot directly
//
// Fields marked (*) are set only by path 1 (the web page).

import mongoose from "mongoose";

const schoolLeadSchema = new mongoose.Schema(
  {
    // ── School reference ──────────────────────────────────────────────────────
    schoolId:    { type: mongoose.Schema.Types.ObjectId, ref: "SchoolProfile", required: true, index: true },
    schoolPhone: { type: String, required: true },
    schoolName:  { type: String, default: "" },
    zqSlug:      { type: String, default: "" },

    // ── Parent identity ───────────────────────────────────────────────────────
    parentName:  { type: String, default: "" },         // (*) entered on Smart Card page
    parentPhone: { type: String, default: "" },         // captured from WA number or URL param

    // ── What they wanted ─────────────────────────────────────────────────────
    // action: "fees" | "visit" | "place" | "pdf" | "enquiry" | "apply" | "view"
    actionType:  { type: String, default: "view" },
    gradeInterest: { type: String, default: "" },       // set when action is "place"
    message:     { type: String, default: "" },         // set when action is "enquiry"

    // ── Where they came from ─────────────────────────────────────────────────
    // source: "tiktok" | "facebook" | "twitter" | "whatsapp_status" | "qr" |
    //         "direct" | "whatsapp_bot" | "sms" | "other"
    source:      { type: String, default: "direct" },

    // ── Funnel tracking ───────────────────────────────────────────────────────
    pageViewed:  { type: Boolean, default: false },     // (*) they opened the Smart Card page
    waOpened:    { type: Boolean, default: false },     // (*) they tapped the WA button
    nameEntered: { type: Boolean, default: false },     // (*) they filled in the name field

    // ── Follow-up tracking ────────────────────────────────────────────────────
    contacted:    { type: Boolean, default: false, index: true },
    contactedAt:  { type: Date,    default: null },
    contactedBy:  { type: String,  default: "" },       // phone of the school admin who followed up

    // ── Admin note ────────────────────────────────────────────────────────────
    notes:       { type: String, default: "" }
  },
  {
    timestamps: true   // createdAt, updatedAt
  }
);

// ── Compound index: school + uncontacted leads lookup ─────────────────────────
schoolLeadSchema.index({ schoolId: 1, contacted: 1, createdAt: -1 });

// ── Compound index: source analytics ─────────────────────────────────────────
schoolLeadSchema.index({ schoolId: 1, source: 1, createdAt: -1 });

export default mongoose.models.SchoolLead || mongoose.model("SchoolLead", schoolLeadSchema);