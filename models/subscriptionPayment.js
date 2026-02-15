import mongoose from "mongoose";

const subscriptionPaymentSchema = new mongoose.Schema(
  {
    businessId: { type: mongoose.Schema.Types.ObjectId, ref: "Business", required: true },

    // what plan was paid for / activated
    packageKey: { type: String, required: true }, // bronze/silver/gold
    amount: { type: Number, required: true },
    currency: { type: String, default: "USD" },

    // paynow tracking
    reference: { type: String, required: true },
    pollUrl: { type: String },
    method: { type: String, default: "ecocash" },
    ecocashPhone: { type: String },

    status: { type: String, default: "pending" }, // pending/paid/failed
    paidAt: { type: Date },

    // receipt from Zimqoute
    receiptFilename: { type: String },
    receiptUrl: { type: String }
  },
  { timestamps: true }
);

export default mongoose.model("SubscriptionPayment", subscriptionPaymentSchema);
