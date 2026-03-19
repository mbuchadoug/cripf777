// models/categoryPreset.js
// ─── Admin-managed preset products/services per category ─────────────────────
// This model lets admins load presets via the admin portal instead of
// hardcoding them in supplierProductTemplates.js.
// The getTemplateForCategory() function checks this model FIRST,
// then falls back to the static file.

import mongoose from "mongoose";

const PriceEntrySchema = new mongoose.Schema({
  product: { type: String, required: true },
  amount:  { type: Number, required: true },
  unit:    { type: String, default: "each" }
}, { _id: false });

const SubcatMapSchema = new mongoose.Schema({
  label:    { type: String, required: true },
  products: [String]
}, { _id: false });

const CategoryPresetSchema = new mongoose.Schema({
  catId:       { type: String, required: true, unique: true, index: true },
  label:       { type: String, required: true },
  profileType: { type: String, enum: ["product", "service", "both"], default: "product" },

  products:    { type: [String], default: [] },
  prices:      { type: [PriceEntrySchema], default: [] },
  subcatMap:   { type: [SubcatMapSchema], default: [] },  // for display grouping in admin

  isActive:    { type: Boolean, default: true },  // false = don't show to suppliers
  adminNote:   { type: String, default: "" },
  updatedBy:   { type: String, default: "" },     // admin username who last edited

  createdAt:   { type: Date, default: Date.now },
  updatedAt:   { type: Date, default: Date.now }
});

CategoryPresetSchema.pre("save", function(next) {
  this.updatedAt = new Date();
  next();
});

// Helper: get preset as plain object compatible with getTemplateForCategory()
CategoryPresetSchema.methods.toTemplate = function() {
  return {
    isAdminPreset: true,
    adminNote: this.adminNote,
    products: this.products,
    prices: this.prices,
    subcatMap: this.subcatMap?.length
      ? Object.fromEntries(this.subcatMap.map(s => [s.label, s.products]))
      : null
  };
};

export default mongoose.model("CategoryPreset", CategoryPresetSchema);