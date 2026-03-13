// models/supplierProfile.js
import mongoose from "mongoose";

const SupplierProfileSchema = new mongoose.Schema({
  phone: { type: String, required: true, index: true },
  businessName: { type: String, required: true },
  location: {
    city: { type: String, required: true },
    area: { type: String, required: true }
  },
  categories: [{ type: String }],
  products: [{ type: String }],
  prices: [{
    product: { type: String, required: true },
    amount: { type: Number, required: true },
    currency: { type: String, enum: ["USD", "ZWL"], default: "USD" },
    unit: { type: String, default: "each" },
    inStock: { type: Boolean, default: true },
    validUntil: Date
  }],
  priceUpdatedAt: { type: Date },
  delivery: {
    available: { type: Boolean, default: false },
    range: {
      type: String,
      enum: ["area_only", "city_wide", "nationwide"],
      default: "city_wide"
    },
    fee: { type: Number, default: 0 }
  },
  minOrder: { type: Number, default: 0 },
  minOrderCurrency: { type: String, default: "USD" },

  // Subscription
  tier: {
    type: String,
    enum: ["basic", "pro", "featured"],
    default: "basic"
  },
  tierRank: { type: Number, default: 1 }, // basic=1, pro=2, featured=3
  subscriptionStatus: {
    type: String,
    enum: ["pending", "active", "expired"],
    default: "pending"
  },
  subscriptionStartedAt: Date,
  subscriptionEndsAt: Date,
  subscriptionPlan: {
    type: String,
    enum: ["monthly", "annual"],
    default: "monthly"
  },

  // Status
  active: { type: Boolean, default: false }, // only true after payment
  verified: { type: Boolean, default: false },
  stockStatus: {
    type: String,
    enum: ["in_stock", "low_stock", "out_of_stock"],
    default: "in_stock"
  },
  lastStockUpdate: Date,

  // Credibility
  rating: { type: Number, default: 0 },
  reviewCount: { type: Number, default: 0 },
  completedOrders: { type: Number, default: 0 },
  declinedOrders: { type: Number, default: 0 },
  credibilityScore: { type: Number, default: 0 },
  topSupplierBadge: { type: Boolean, default: false },
  disputeCount: { type: Number, default: 0 },
  suspended: { type: Boolean, default: false },

 
  priceUpdatedAt: { type: Date },
priceUpdatedAt: { type: Date },
  // Analytics
  viewCount: { type: Number, default: 0 },
  monthlyViews: { type: Number, default: 0 },
  monthlyOrders: { type: Number, default: 0 },
  monthlyRevenue: { type: Number, default: 0 },
profileType:     { type: String, enum: ['product', 'service'], default: 'product' },
rates:           { type: String },          // e.g. "$20/hr or $50/job"
travelAvailable: { type: Boolean },         // service providers: do they travel to client?
serviceArea:     { type: String },          // e.g. "Harare CBD and suburbs"
  // Saved by buyers
  savedBy: [{ type: String }], // array of phone numbers

  // Featured slot waitlist
  featuredWaitlist: { type: Boolean, default: false }

}, { timestamps: true });

// Compound index for fast search
SupplierProfileSchema.index({
  "location.city": 1,
  categories: 1,
  active: 1,
  tierRank: -1,
  credibilityScore: -1
});

export default mongoose.models.SupplierProfile ||
  mongoose.model("SupplierProfile", SupplierProfileSchema);