// models/pageSellers.js
// Which sellers / businesses / smart links show on each zimqoute.co.zw page.
// One document per page path (e.g. "/blog/brake-pads-and-discs-price-harare").
// Pages WITHOUT a document keep showing whatever is hard-coded in their HTML.
import mongoose from "mongoose";

const itemSchema = new mongoose.Schema({
  kind:     { type: String, enum: ["supplier", "custom"], default: "supplier" },
  supplier: { type: mongoose.Schema.Types.ObjectId, ref: "SupplierProfile", default: null },
  slug:     { type: String, default: "" },      // snapshot of supplier zqSlug (for display / fallback)
  name:     { type: String, default: "" },      // custom card name, or override for a supplier
  meta:     { type: String, default: "" },      // small line under the name (services · area)
  link:     { type: String, default: "" },      // custom card link (https:// only)
  badge:    { type: String, default: "" },      // "⭐ Recommended", "Featured", "Pro"...
  top:      { type: Boolean, default: false },  // gold highlighted tile
  cities:   { type: String, default: "" },      // live tool strips only: "Harare, Bulawayo" (blank = all)
}, { _id: false });

const pageSellersSchema = new mongoose.Schema({
  path:   { type: String, required: true, unique: true, index: true },
  title:  { type: String, default: "" },
  status: { type: String, enum: ["managed", "hidden"], default: "managed" },

  heading: { type: String, default: "" },
  sub:     { type: String, default: "" },

  showListCard:  { type: Boolean, default: true },
  listCardTitle: { type: String, default: "" },
  listCardText:  { type: String, default: "" },

  // Live provider list on tool pages (solar, building, plumbing):
  pinLive:  { type: Boolean, default: false },                       // put these sellers on top of the live list
  liveMode: { type: String, enum: ["pin", "only"], default: "pin" }, // only = show ONLY these sellers

  // Optional: point the page's main "Chat on WhatsApp" seller buttons to this seller.
  ctaSupplier: { type: mongoose.Schema.Types.ObjectId, ref: "SupplierProfile", default: null },

  items:     { type: [itemSchema], default: [] },
  updatedBy: { type: String, default: "" },
}, { timestamps: true, collection: "page_sellers" });

export default mongoose.models.PageSellers || mongoose.model("PageSellers", pageSellersSchema);
