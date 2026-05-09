import mongoose from "mongoose";

const SearchCommandLogSchema = new mongoose.Schema(
  {
    phone: { type: String, index: true, required: true },

    rawText: { type: String, default: "" },
    normalizedText: { type: String, default: "", index: true },

    source: {
      type: String,
      enum: ["text", "button", "list", "smart_link", "unknown"],
      default: "text",
      index: true
    },

    flow: {
      type: String,
      enum: ["supplier_search", "school_search", "seller_chat", "main", "unknown"],
      default: "unknown",
      index: true
    },

    sessionState: { type: String, default: "" },

    parsed: {
      product: String,
      service: String,
      city: String,
      area: String,
      category: String,
      profileType: String
    },

    resultMode: {
      type: String,
      enum: ["offers", "suppliers", "schools", "none", "error", "unknown"],
      default: "unknown",
      index: true
    },

    resultCount: { type: Number, default: 0 },
    resultsPreview: [
      {
        supplierId: String,
        supplierName: String,
        product: String,
        service: String,
        city: String,
        area: String,
        priceText: String
      }
    ],

    errorMessage: { type: String, default: "" },
    botReplySummary: { type: String, default: "" },

    helped: { type: Boolean, default: false, index: true },
    helpNote: { type: String, default: "" },
    followUpSentAt: Date,

    adminTags: [{ type: String }],
    meta: { type: mongoose.Schema.Types.Mixed, default: {} }
  },
  { timestamps: true }
);

SearchCommandLogSchema.index({ phone: 1, createdAt: -1 });
SearchCommandLogSchema.index({ flow: 1, resultMode: 1, createdAt: -1 });

export default mongoose.model("SearchCommandLog", SearchCommandLogSchema);