// models/searchCategory.js
// ─── Admin-managed search categories ─────────────────────────────────────────
// Two kinds of record live here:
//   • builtIn:false  - a NEW category the admin created (e.g. "borehole_drilling")
//   • builtIn:true   - extra search keywords / a new label for a BUILT-IN category
//                      from services/supplierPlans.js (same id, e.g. "electrical")
// Both are merged at runtime by services/categoryRegistry.js. Sellers can have
// any number of categories (SupplierProfile.categories is an array).
import mongoose from "mongoose";

const SearchCategorySchema = new mongoose.Schema({
  id:       { type: String, required: true, unique: true, lowercase: true, trim: true }, // slug: a-z0-9_
  label:    { type: String, default: "" },                 // "🚰 Borehole Drilling"
  type:     { type: String, enum: ["product", "service", "both"], default: "service" },
  // Words buyers type that mean this category ("borehole, drilling, water well").
  // Used by the search to understand the query and to boost sellers in it.
  keywords: { type: [String], default: [] },
  // Find, Buy & Hire home group (1-8) this category is listed under; 0 = not listed.
  group:    { type: Number, default: 0 },
  builtIn:  { type: Boolean, default: false },
  active:   { type: Boolean, default: true },
  updatedBy:{ type: String, default: "" }
}, { timestamps: true });

export default mongoose.models.SearchCategory || mongoose.model("SearchCategory", SearchCategorySchema);
