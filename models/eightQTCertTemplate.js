// models/eightQTCertTemplate.js
// Admin-managed certificate template — background, field positions, pricing, signatory
import mongoose from "mongoose";

const FieldPositionSchema = new mongoose.Schema({
  field: { type: String },   // "name" | "date" | "archetype" | "scores" | "verifyCode"
  x: { type: Number },
  y: { type: Number },
  fontSize: { type: Number, default: 24 },
  fontFamily: { type: String, default: "serif" },
  color: { type: String, default: "#1E3A5F" },
  align: { type: String, default: "center" }
}, { _id: false });

const EightQTCertTemplateSchema = new mongoose.Schema({
  label: { type: String, default: "Default" },  // admin label
  active: { type: Boolean, default: true },      // only one active at a time
  backgroundUrl: { type: String, default: null },// uploaded background image URL
  width: { type: Number, default: 1122 },        // px at 96dpi (A4 landscape)
  height: { type: Number, default: 794 },
  signatoryName: { type: String, default: "Donald Mataranyika" },
  signatoryTitle: { type: String, default: "Founder, CRIPFCnt" },
  showAllScores: { type: Boolean, default: true },
  fieldPositions: [FieldPositionSchema],
  // Pricing tiers — pulled into Stripe checkout
  standardPriceCents: { type: Number, default: 999 },    // $9.99
  premiumPriceCents: { type: Number, default: 2499 },    // $24.99
  currency: { type: String, default: "usd" },
  // Retake policy
  retakeDays: { type: Number, default: 90 },
  // Band labels — admin can rename
  bands: {
    type: mongoose.Schema.Types.Mixed,
    default: {
      0:  "Emerging",
      21: "Developing",
      41: "Functional",
      61: "Structural",
      81: "Recalibrative"
    }
  }
}, { timestamps: true });

export default mongoose.models.EightQTCertTemplate ||
  mongoose.model("EightQTCertTemplate", EightQTCertTemplateSchema);
