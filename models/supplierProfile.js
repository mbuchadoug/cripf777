// models/supplierProfile.js
import mongoose from "mongoose";

const SupplierProfileSchema = new mongoose.Schema({
  phone: { type: String, required: true, index: true },

  businessId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Business",
    default: null
  },
  mainBranchId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Branch",
    default: null
  },

  businessName: { type: String, required: true },
  location: {
    city: { type: String, required: true },
    area: { type: String, required: true }
  },
  address:        { type: String, default: "" },
  contactDetails: { type: String, default: "" },
  website:        { type: String, default: "" },

  notificationContacts: {
    type:    [String],
    default: [],
    index:   true
  },

  categories:     [{ type: String }],
  products:       [{ type: String }],
  listedProducts: [{ type: String }],

  prices: [{
    product:  { type: String, required: true },
    amount:   { type: Number, required: true },
    currency: { type: String, enum: ["USD", "ZWL"], default: "USD" },
    unit:     { type: String, default: "each" },
    inStock:  { type: Boolean, default: true },
    validUntil: Date
  }],

  priceUpdatedAt: { type: Date },

  delivery: {
    available: { type: Boolean, default: false },
    range: {
      type:    String,
      enum:    ["area_only", "city_wide", "nationwide"],
      default: "city_wide"
    },
    fee: { type: Number, default: 0 }
  },

  minOrder:         { type: Number, default: 0 },
  minOrderCurrency: { type: String, default: "USD" },

  // ── Subscription ───────────────────────────────────────────────────────────
  tier: {
    type:    String,
    enum:    ["basic", "pro", "featured"],
    default: "basic"
  },
  tierRank:             { type: Number, default: 1 }, // basic=1, pro=2, featured=3
  subscriptionStatus: {
    type:    String,
    enum:    ["pending", "active", "expired", "trial"],
    default: "pending"
  },
  subscriptionStartedAt: Date,
  subscriptionEndsAt:    Date,
  subscriptionPlan: {
    type:    String,
    enum:    ["monthly", "annual"],
    default: "monthly"
  },

  // ── Status ─────────────────────────────────────────────────────────────────
  active:   { type: Boolean, default: false },
  verified: { type: Boolean, default: false },
  stockStatus: {
    type:    String,
    enum:    ["in_stock", "low_stock", "out_of_stock"],
    default: "in_stock"
  },
  lastStockUpdate: Date,

  // ── Credibility ────────────────────────────────────────────────────────────
  rating:           { type: Number, default: 0 },
  reviewCount:      { type: Number, default: 0 },
  completedOrders:  { type: Number, default: 0 },
  declinedOrders:   { type: Number, default: 0 },
  credibilityScore: { type: Number, default: 0 },
  topSupplierBadge: { type: Boolean, default: false },
  disputeCount:     { type: Number, default: 0 },
  suspended:        { type: Boolean, default: false },

  // ── Analytics ──────────────────────────────────────────────────────────────
  viewCount:          { type: Number, default: 0 },
  monthlyViews:       { type: Number, default: 0 },
  monthlyOrders:      { type: Number, default: 0 },
  responseCount:      { type: Number, default: 0 },
  avgResponseMinutes: { type: Number, default: null },
  lastRespondedAt:    { type: Date,   default: null },
  monthlyRevenue:     { type: Number, default: 0 },

  // ── Profile type ───────────────────────────────────────────────────────────
  // "product"     = sells physical goods
  // "service"     = offers services (plumbing, electrical, cleaning, etc.)
  // "hospitality" = lodge, hotel, guesthouse, safari operator, tour guide, etc.
  profileType: {
    type:    String,
    enum:    ["product", "service", "hospitality"],
    default: "product"
  },

  // ── Service-provider specific ──────────────────────────────────────────────
  rates: {
    type: [{
      service: { type: String, trim: true },
      rate:    { type: String, trim: true }
    }],
    default: []
  },
  travelAvailable: { type: Boolean },
  serviceArea:     { type: String },

  // ── Smart link / slug ──────────────────────────────────────────────────────
  zqSlug:            { type: String, unique: true, sparse: true },
  zqLinkViews:       { type: Number, default: 0 },
  zqLinkConversions: { type: Number, default: 0 },
  zqSourceViews:       { type: Object, default: {} },
  zqSourceConversions: { type: Object, default: {} },

  // ── VIP notification flags (set by admin only) ─────────────────────────────
  revealBuyerPhone:   { type: Boolean, default: false },
  revealVisitorPhone: { type: Boolean, default: false },

  // ── Tutor / teacher fields ─────────────────────────────────────────────────
  subjects:      { type: [String], default: [] },
  gradesOffered: { type: [String], default: [] },

  // ── HOSPITALITY & TOURISM fields ───────────────────────────────────────────
  // Populated when profileType = "hospitality".
  // tourismSubtype is an ARRAY so an operator can be both a lodge AND a safari
  // operator — they appear in results for both accommodation and activity requests.
  //
  // Allowed values:
  //   "lodge"           - bush lodge, game lodge, tented camp, luxury lodge
  //   "hotel"           - hotel, boutique hotel, motel
  //   "guesthouse"      - guesthouse, B&B, bed and breakfast, airbnb-style
  //   "self_catering"   - self-catering unit, chalet, cottage, villa
  //   "campsite"        - campsite, bush camp, caravan park
  //   "safari_operator" - game drives, bush walks, wildlife tours
  //   "tour_guide"      - guided tours, city tours, heritage tours, cultural tours
  //   "boat_hire"       - boat hire, houseboat, canoe, kayak, sunset cruise
  //   "travel_agency"   - holiday packages, travel packages, transfers

  tourismSubtype: {
    type:    [String],
    enum:    ["lodge","hotel","guesthouse","self_catering","campsite",
              "safari_operator","tour_guide","boat_hire","travel_agency"],
    default: []
  },

  // Areas/parks/destinations this operator covers
  // e.g. ["Hwange", "Victoria Falls", "Kariba"]
  tourismAreas: { type: [String], default: [] },

  // Room types for accommodation providers
  // Each entry: { name, capacity, pricePerNight, currency }
  // e.g. [{ name: "Double Room", capacity: 2, pricePerNight: 80, currency: "USD" }]
  roomTypes: {
    type: [{
      name:          { type: String },
      capacity:      { type: Number, default: 2 },
      pricePerNight: { type: Number, default: 0 },
      currency:      { type: String, default: "USD" },
      description:   { type: String, default: "" }
    }],
    default: []
  },

  // Total max guests the property can accommodate at once
  maxCapacity: { type: Number, default: 0 },

  // Facilities offered — array of string codes, indexed for search
  // Allowed: "wifi","pool","hot_shower","breakfast","en_suite","generator",
  //          "dstv","braai","aircon","game_drives","fishing","boat_hire",
  //          "conference","gym","bar","restaurant","laundry","parking",
  //          "pets_allowed","child_friendly","wheelchair_access"
  facilities: {
    type:    [String],
    default: [],
    index:   true
  },

  // Check-in / check-out times (stored as readable strings e.g. "14:00")
  checkInTime:  { type: String, default: "" },
  checkOutTime: { type: String, default: "" },

  // Meal plan offered
  mealPlan: {
    type:    String,
    enum:    ["room_only","bed_breakfast","half_board","full_board","self_catering","not_applicable"],
    default: "not_applicable"
  },

  // Legacy field — kept for backward compat; prefer tourismSubtype[]
  tourismType: { type: String, default: "" },

  // ── Saved / Waitlist ───────────────────────────────────────────────────────
  savedBy:          [{ type: String }],
  featuredWaitlist: { type: Boolean, default: false }

}, { timestamps: true });

// ── Compound indexes ───────────────────────────────────────────────────────────
SupplierProfileSchema.index({
  "location.city": 1,
  categories:      1,
  active:          1,
  tierRank:        -1,
  credibilityScore:-1
});

SupplierProfileSchema.index({
  "location.city": 1,
  profileType:     1,
  tourismSubtype:  1,
  active:          1,
  tierRank:        -1
});

SupplierProfileSchema.index({
  profileType: 1,
  facilities:  1,
  active:      1
});

export default mongoose.models.SupplierProfile ||
  mongoose.model("SupplierProfile", SupplierProfileSchema);