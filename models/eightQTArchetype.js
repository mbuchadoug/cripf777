// models/eightQTArchetype.js
// Admin-configured archetype profiles assigned based on quotient score combinations
import mongoose from "mongoose";

// Each condition: { quotient, operator, value }
// e.g. { quotient: "RQ", operator: "gte", value: 70 }
const ConditionSchema = new mongoose.Schema({
  quotient: { type: String, required: true },
  operator: {
    type: String,
    enum: ["gte", "lte", "gt", "lt", "between"],
    required: true
  },
  value: { type: Number, required: true },
  value2: { type: Number, default: null } // used for "between"
}, { _id: false });

const EightQTArchetypeSchema = new mongoose.Schema({
  name: { type: String, required: true },           // e.g. "The Responsible Builder"
  tagline: { type: String, default: "" },            // short line for certificate/share card
  description: { type: String, default: "" },        // shown on results page
  reflectionPrompts: [{ type: String }],             // 2-3 personalised questions
  conditions: [ConditionSchema],                     // all must match (AND logic)

  // NEW: match by dominant quotient. When set (e.g. "RQ"), this archetype fires
  // when that quotient is the participant's HIGHEST score - robust for any quiz
  // size, unlike absolute thresholds. conditions (if any) must ALSO pass.
  dominantQuotient: {
    type: String,
    enum: ["CsQ", "RQ", "IQ", "PQ", "FQ", "CvQ", "NQ", "TQ", null],
    default: null,
    index: true
  },

  priority: { type: Number, default: 0, index: true }, // higher = evaluated first
  active: { type: Boolean, default: true, index: true },
  isDefault: { type: Boolean, default: false }       // fallback if nothing matches
}, { timestamps: true });

export default mongoose.models.EightQTArchetype ||
  mongoose.model("EightQTArchetype", EightQTArchetypeSchema);