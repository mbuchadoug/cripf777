import mongoose from "mongoose";

const BusinessSchema = new mongoose.Schema({
  provider: { type: String, default: "whatsapp" },
  providerId: { type: String, index: true },

  name: String,
  email: String,
  address: String,
  currency: { type: String, default: "ZWL" },

  paymentTermsDays: { type: Number, default: 30 },
  logoUrl: String,

  invoicePrefix: { type: String, default: "INV" },
  quotePrefix: { type: String, default: "QT" },

  counters: {
    invoice: { type: Number, default: 0 },
    quote: { type: Number, default: 0 },
    receipt: { type: Number, default: 0 }
  },

  sessionState: { type: String, default: null },
  whatsappPhoneNumberId: String,

  // ✅ PACKAGES
package: {
  type: String,
  enum: ["trial", "bronze", "silver", "gold", "enterprise"],
  default: "trial"
},


  subscriptionStatus: {
    type: String,
    enum: ["active", "expired"],
    default: "active"
  },

  // 🧪 TRIAL CONTROL (1 DAY)
  trialStartedAt: {
    type: Date,
    default: Date.now
  },

  trialEndsAt: {
    type: Date,
    default: () => new Date(Date.now() + 24 * 60 * 60 * 1000)
  },

  // 📊 USAGE
  documentCountMonth: { type: Number, default: 0 },
  documentCountMonthKey: { type: String },

  sessionData: { type: mongoose.Schema.Types.Mixed, default: {} },

}, { timestamps: true });

export default mongoose.models.Business || mongoose.model("Business", BusinessSchema);
