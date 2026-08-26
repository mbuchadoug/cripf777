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
  // "tutor"       = private teacher / lessons provider (rides on supplier rails:
  //                 smart link, seller chat, viewer-phone notifications all reused).
  //                 Billed on the $5/mo supplier "basic" plan.
  profileType: {
    type:    String,
    enum:    ["product", "service", "hospitality", "tutor"],
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

  // ── Smart link marketing (mirrors SchoolProfile pattern) ───────────────────
  // smartLinkPitch: marketing description sent FIRST when a buyer opens the
  //                 seller's smart link - before the profile card and menu.
  // smartLinkFlyers: images (JPG/PNG/WEBP) sent as WhatsApp image messages
  //                  after the pitch. Managed at /zq-admin/suppliers/:id/marketing
  // brochures: PDFs (or images) sent as WhatsApp documents after the flyers.
  //            Same GridFS storage pattern as school brochures.
  smartLinkPitch: { type: String, default: "" },

  smartLinkFlyers: {
    type: [{
      label:    { type: String, default: "" },
      url:      { type: String, required: true },
      mimeType: { type: String, default: "image/jpeg" },
      addedAt:  { type: Date,   default: Date.now }
    }],
    default: []
  },

  brochures: {
    type: [{
      label:    { type: String, default: "" },
      url:      { type: String, required: true },
      isImage:  { type: Boolean, default: false },
      mimeType: { type: String, default: "application/pdf" },
      addedAt:  { type: Date,   default: Date.now }
    }],
    default: []
  },

  // ── Smart link / slug ──────────────────────────────────────────────────────
  zqSlug:            { type: String, unique: true, sparse: true },
  zqLinkViews:       { type: Number, default: 0 },
  zqLinkConversions: { type: Number, default: 0 },
  zqSourceViews:       { type: Object, default: {} },
  zqSourceConversions: { type: Object, default: {} },

  // ── VIP notification flags (set by admin only) ─────────────────────────────
  revealBuyerPhone:   { type: Boolean, default: false },
  revealVisitorPhone: { type: Boolean, default: false },

  // ── Contact visibility (admin-controlled) ──────────────────────────────────
  // When true, the supplier/owner can type "my contacts" in the chatbot and see
  // a list of phone numbers that have opened their smart link or staff card.
  // Only Typhon (ZimQuote admin) can toggle this on - sellers never self-enable.
  canViewContacts: { type: Boolean, default: false },

  // ── Tutor / teacher fields ─────────────────────────────────────────────────
  // Populated when profileType = "tutor". A tutor IS a SupplierProfile, so it
  // automatically inherits smart links (zqSlug), seller chat, and the
  // revealVisitorPhone notification (teacher gets the phone number of anyone who
  // opens their profile). These fields drive the PARENT-FACING search funnel:
  // parents pick a subject + level + city, and optionally a price ceiling.
  subjects:      { type: [String], default: [], index: true },  // ["Mathematics","Physics","English",...]
  gradesOffered: { type: [String], default: [] },               // legacy free-text levels

  // Structured levels for search filtering. Allowed codes (see schoolPlans.TUTOR_LEVELS):
  //   "ecd","primary","zjc","olevel","alevel","cambridge","college","adult"
  teachingLevels: { type: [String], default: [], index: true },

  // How lessons are delivered - drives "online tutor" vs "near me" searches.
  //   "in_person" = tutor travels to / hosts the student
  //   "online"    = video / WhatsApp lessons (nationwide reach, no city filter)
  //   "both"      = offers both
  // LEGACY single field, kept for backward-compatible search/display. It is now
  // auto-derived from teachingModes[] on save (see the hooks below), so existing
  // readers keep working while new code uses the multi-select array.
  teachingMode: {
    type:    String,
    enum:    ["in_person", "online", "whatsapp", "both"],
    default: "in_person"
  },

  // Multi-select delivery modes (the source of truth going forward). Any of:
  //   "in_person" | "online" | "whatsapp"
  // A tutor can offer any combination (e.g. in person + online + WhatsApp).
  teachingModes: {
    type:    [String],
    enum:    ["in_person", "online", "whatsapp"],
    default: []
  },

  // Where in-person lessons happen (any combination).
  //   "tutor_place" = at the tutor's home/study
  //   "student_home"= tutor travels to the student (home visits)
  //   "public"      = library / agreed venue
  lessonVenues: { type: [String], default: ["tutor_place"] },

  // Hourly rate is the headline number parents compare on. Kept simple + numeric
  // so it can be range-filtered ("under $10/hr").
  hourlyRate:      { type: Number, default: 0 },
  // When true, the tutor prefers to quote per student - the profile shows
  // "Rate on request" instead of a number (even if hourlyRate is set/0).
  rateOnRequest:   { type: Boolean, default: false },
  hourlyCurrency:  { type: String, enum: ["USD", "ZWL"], default: "USD" },
  groupRate:       { type: Number, default: 0 },   // per-student rate for group lessons (0 = not offered)
  offersGroups:    { type: Boolean, default: false },
  offersExamPrep:  { type: Boolean, default: false }, // final-exam crash courses / holiday intensives
  offersHolidayLessons: { type: Boolean, default: false },

  // Credibility signals parents look for.
  qualifications:  { type: String, default: "" },  // "BSc Maths (UZ), 8 yrs experience"
  experienceYears: { type: Number, default: 0 },
  examBoards:      { type: [String], default: [] }, // ["ZIMSEC","Cambridge"]
  availability:    { type: String, default: "" },   // free text: "Weekday evenings, Sat mornings"
  languages:       { type: [String], default: [] }, // ["English","Shona","Ndebele"]

  // ── HOSPITALITY & TOURISM fields ───────────────────────────────────────────
  // Populated when profileType = "hospitality".
  // tourismSubtype is an ARRAY so an operator can be both a lodge AND a safari
  // operator - they appear in results for both accommodation and activity requests.
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
      pricePerNight: { type: Number, default: 0 },  // overnight rate
      restRate:      { type: Number, default: 0 },  // day-use / rest rate (few hours, no overnight)
      currency:      { type: String, default: "USD" },
      description:   { type: String, default: "" }
    }],
    default: []
  },

  // Total max guests the property can accommodate at once
  maxCapacity: { type: Number, default: 0 },

  // Facilities offered - array of string codes, indexed for search
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

  // Extra services charged separately from room rate
  // e.g. conference room, airport pickup, pool access, breakfast, laundry
  extraServices: {
    type: [{
      name:  { type: String },
      price: { type: Number, default: 0 },
      unit:  { type: String, default: "service" }  // "person","trip","half day","load", etc.
    }],
    default: []
  },

  // Legacy field - kept for backward compat; prefer tourismSubtype[]
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

// Tutor search: subject + city, cheapest credible tutors first.
// NOTE: MongoDB forbids a compound index over TWO array fields ("cannot index
// parallel arrays"). subjects[] and teachingLevels[] are both arrays, so only
// subjects[] goes in this compound index. teachingLevels[] keeps its own
// single-field (multikey) index above for level filtering.
SupplierProfileSchema.index({
  profileType:    1,
  subjects:       1,
  "location.city":1,
  active:         1,
  tierRank:       -1,
  hourlyRate:     1
});

// ─────────────────────────────────────────────────────────────────────────────
// TUTOR INTEGRITY GUARD - "fix it for once"
// A record with teachingLevels[] is unambiguously a private tutor (a real
// product/service supplier NEVER has teachingLevels). This guarantees that no
// code path - self-registration, EcoCash/Paynow activation, a payment webhook,
// or any future update - can silently save such a record as "product"/"service".
// It does NOT touch normal suppliers (they have no teachingLevels), so it can't
// mislabel anyone. To intentionally convert a tutor to another type, clear
// teachingLevels in the same operation.
// ─────────────────────────────────────────────────────────────────────────────
function _looksLikeTutor(levels) {
  return Array.isArray(levels) && levels.length > 0;
}

// Derive the LEGACY single teachingMode from the multi-select teachingModes[]
// so existing search/display code keeps working. WhatsApp counts as an
// online/remote channel for the legacy bucket. Returns null when there is
// nothing to derive (so we never clobber an existing value with a blank).
function _deriveTeachingMode(modes) {
  const m = Array.isArray(modes) ? modes : [];
  if (!m.length) return null;
  const hasIn     = m.includes("in_person");
  const hasRemote = m.includes("online") || m.includes("whatsapp");
  if (hasIn && hasRemote) return "both";
  if (hasRemote)          return "online";
  return "in_person";
}

// Covers supplier.save() (self-reg finalise + payment activation both use .save()).
SupplierProfileSchema.pre("save", function (next) {
  if (this.profileType !== "tutor" && _looksLikeTutor(this.teachingLevels)) {
    this.profileType = "tutor";
  }
  // Keep the legacy single teachingMode in sync with the multi-select array.
  const _derived = _deriveTeachingMode(this.teachingModes);
  if (_derived) this.teachingMode = _derived;
  next();
});

// Covers findOneAndUpdate / findByIdAndUpdate paths (e.g. webhooks) that would
// set profileType to product/service without also clearing teachingLevels.
SupplierProfileSchema.pre(["findOneAndUpdate", "updateOne", "updateMany"], async function () {
  const update  = this.getUpdate() || {};
  const set     = update.$set || update;
  const newType = set.profileType;
  if (newType && ["product", "service"].includes(newType)) {
    const clearingLevels =
      (Array.isArray(set.teachingLevels) && set.teachingLevels.length === 0) ||
      (update.$unset && "teachingLevels" in update.$unset);
    if (!clearingLevels) {
      const existing = await this.model.findOne(this.getQuery()).select("teachingLevels").lean();
      if (existing && _looksLikeTutor(existing.teachingLevels)) {
        if (update.$set) delete update.$set.profileType; else delete update.profileType;
        this.setUpdate(update);
      }
    }
  }
  // Keep the legacy single teachingMode in sync when teachingModes[] is updated.
  if (set.teachingModes !== undefined) {
    const _derived = _deriveTeachingMode(set.teachingModes);
    if (_derived) {
      if (update.$set) update.$set.teachingMode = _derived;
      else             update.teachingMode      = _derived;
      this.setUpdate(update);
    }
  }
});

export default mongoose.models.SupplierProfile ||
  mongoose.model("SupplierProfile", SupplierProfileSchema);