// models/eightQTConfig.js
// Admin-controlled configuration for the 8 Quotients Test
// Each document represents one quotient's settings
import mongoose from "mongoose";

const EightQTConfigSchema = new mongoose.Schema({
  code: {
    type: String,
    required: true,
    unique: true,
    enum: ["CsQ", "RQ", "IQ", "PQ", "FQ", "CvQ", "NQ", "TQ"]
  },
  name: { type: String, required: true },           // e.g. "Consciousness"
  description: { type: String, default: "" },        // shown on results page
  dominantInterpretation: { type: String, default: "" }, // text when this is highest
  developmentEdge: { type: String, default: "" },    // text when this is lowest
  questionCount: { type: Number, default: 8 },       // admin sets per-quotient
  weight: { type: Number, default: 1 },              // multiplier for overall score
  active: { type: Boolean, default: true, index: true },
  displayOrder: { type: Number, default: 0 },
  color: { type: String, default: "#1E3A5F" }        // for radar chart
}, { timestamps: true });

export default mongoose.models.EightQTConfig ||
  mongoose.model("EightQTConfig", EightQTConfigSchema);
