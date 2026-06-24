// models/eightQTQuestion.js
// Question bank for the CRIPFCnt 8 Quotients Test
// Uploaded by admin via CSV import or manually created
import mongoose from "mongoose";

const OptionSchema = new mongoose.Schema({
  text: { type: String, required: true },
  // scores: map of quotient codes to point values
  // e.g. { "RQ": 3 } or blended { "RQ": 2, "CvQ": 1 }
  scores: { type: mongoose.Schema.Types.Mixed, default: {} }
}, { _id: false });

const EightQTQuestionSchema = new mongoose.Schema({
  quotient: {
    type: String,
    required: true,
    index: true,
    enum: ["CsQ", "RQ", "IQ", "PQ", "FQ", "CvQ", "NQ", "TQ"]
  },
  text: { type: String, required: true },
  options: {
    type: [OptionSchema],
    validate: {
      validator: v => v.length >= 2 && v.length <= 4,
      message: "Each question must have 2-4 options"
    }
  },
  // True if this question contributes to more than one quotient
  isBlended: { type: Boolean, default: false },
  active: { type: Boolean, default: true, index: true },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  importBatch: { type: String, default: null } // tracks which CSV upload created this
}, { timestamps: true });

EightQTQuestionSchema.index({ quotient: 1, active: 1 });

export default mongoose.models.EightQTQuestion ||
  mongoose.model("EightQTQuestion", EightQTQuestionSchema);
