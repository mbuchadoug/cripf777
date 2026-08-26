import mongoose from "mongoose";

/* ============================================================================
   GroceryOrder - ZimQuote grocery delivery orders.
   FULLY ISOLATED from the CRIPFCnt Payment/subscription model. Its own
   collection, its own lifecycle. Nothing here touches parents/quizzes/plans.
   ========================================================================== */

const ItemSchema = new mongoose.Schema({
  sku:       { type: String, default: null },   // catalogue key, null for custom
  name:      { type: String, required: true },
  unit:      { type: String, default: "" },
  qty:       { type: Number, required: true, min: 1 },
  unitPrice: { type: Number, default: null },   // null = custom, awaiting admin price
  lineTotal: { type: Number, default: 0 },
  custom:    { type: Boolean, default: false }
}, { _id: false });

const TimelineSchema = new mongoose.Schema({
  at:    { type: Date, default: Date.now },
  event: String,
  note:  String
}, { _id: false });

const GroceryOrderSchema = new mongoose.Schema({
  reference: { type: String, required: true, unique: true, index: true },

  // Who is paying (may be diaspora)
  customer: {
    name:       { type: String, required: true },
    phone:      { type: String, required: true, index: true }, // payer phone / contact
    email:      { type: String, default: null },
    isDiaspora: { type: Boolean, default: false },
    country:    { type: String, default: "ZW" }
  },

  // Who receives the delivery (for diaspora orders this differs from payer)
  recipient: {
    name:  { type: String, default: null },
    phone: { type: String, default: null }
  },

  delivery: {
    zone:     { type: String, enum: ["cbd", "mid", "outer"], required: true },
    area:     { type: String, default: "" },     // suburb / township
    address:  { type: String, default: "" },     // house / street or description
    landmark: { type: String, default: "" },     // Zimbabwe reality: landmarks > addresses
    geo:      { lat: { type: Number, default: null }, lng: { type: Number, default: null } },
    notes:    { type: String, default: "" }
  },

  items: { type: [ItemSchema], default: [] },
  hasCustomItems: { type: Boolean, default: false },

  amounts: {
    goods:       { type: Number, default: 0 },
    serviceFee:  { type: Number, default: 0 },
    deliveryFee: { type: Number, default: 0 },
    total:       { type: Number, default: 0 },
    currency:    { type: String, default: "USD" }
  },

  payment: {
    method:    { type: String, enum: ["ecocash", "stripe", null], default: null },
    status:    { type: String, enum: ["unpaid", "pending", "paid", "failed", "cancelled"], default: "unpaid", index: true },
    reference: { type: String, default: null },
    pollUrl:   { type: String, default: null },     // Paynow poll url
    gatewayId: { type: String, default: null },     // stripe session id, etc.
    paidAt:    { type: Date, default: null }
  },

  // Fulfilment lifecycle (separate from payment)
  fulfilment: {
    status: {
      type: String,
      enum: ["received", "quote_pending", "awaiting_payment", "paid",
             "shopping", "out_for_delivery", "delivered", "cancelled"],
      default: "received",
      index: true
    },
    rider:     { type: String, default: null },
    proofUrl:  { type: String, default: null },   // photo proof of delivery
    timeline:  { type: [TimelineSchema], default: [] }
  },

  source:    { type: String, default: "zimqoute-web" },
  createdAt: { type: Date, default: Date.now, index: true }
});

GroceryOrderSchema.methods.pushTimeline = function (event, note = "") {
  this.fulfilment.timeline.push({ at: new Date(), event, note });
};

const GroceryOrder = mongoose.models.GroceryOrder
  || mongoose.model("GroceryOrder", GroceryOrderSchema);

export default GroceryOrder;
