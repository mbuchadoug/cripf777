import mongoose from "mongoose";

const buyerRequestItemSchema = new mongoose.Schema(
  {
    product: { type: String, required: true, trim: true },
    quantity: { type: Number, default: 1 },
    unitLabel: { type: String, default: "units" },
    notes: { type: String, default: "" }
  },
  { _id: false }
);

const buyerRequestResponseItemSchema = new mongoose.Schema(
  {
    product: { type: String, required: true, trim: true },
    quantity: { type: Number, default: 1 },
    unit: { type: String, default: "each" },
    pricePerUnit: { type: Number, default: null },
    total: { type: Number, default: null },
    available: { type: Boolean, default: true }
  },
  { _id: false }
);

const buyerRequestResponseSchema = new mongoose.Schema(
  {
    supplierId: { type: mongoose.Schema.Types.ObjectId, ref: "SupplierProfile", required: true },
    supplierPhone: { type: String, required: true, trim: true },
    supplierName: { type: String, required: true, trim: true },
    mode: {
      type: String,
      enum: ["manual_offer", "auto_quote", "unavailable"],
      default: "manual_offer"
    },
    message: { type: String, default: "" },
    items: { type: [buyerRequestResponseItemSchema], default: [] },
    totalAmount: { type: Number, default: null },
    deliveryAvailable: { type: Boolean, default: null },
    etaText: { type: String, default: "" },
    createdAt: { type: Date, default: Date.now }
  },
  { _id: false }
);

const buyerRequestSchema = new mongoose.Schema(
  {
    buyerPhone: { type: String, required: true, trim: true, index: true },
    requestType: {
      type: String,
      enum: ["simple", "bulk", "quote"],
      default: "simple"
    },
    profileType: {
      type: String,
      enum: ["product", "service", "mixed"],
      default: "product"
    },
    rawText: { type: String, default: "" },
    items: { type: [buyerRequestItemSchema], default: [] },
    city: { type: String, default: null },
    area: { type: String, default: null },
    deliveryRequired: { type: Boolean, default: false },
    status: {
      type: String,
      enum: ["open", "closed", "expired"],
      default: "open",
      index: true
    },
    notifiedSuppliers: [{ type: mongoose.Schema.Types.ObjectId, ref: "SupplierProfile" }],
    responses: { type: [buyerRequestResponseSchema], default: [] }
  },
  { timestamps: true }
);

export default mongoose.models.BuyerRequest ||
  mongoose.model("BuyerRequest", buyerRequestSchema);