// services/subscriptionPlans
// ─── Supplier subscription plans ─────────────────────────────────────────────

export const SUBSCRIPTION_PLANS = {
  basic: {
    name: "Basic",
    monthly: { price: 5,   currency: "USD", durationDays: 30  },
    annual:  { price: 50,  currency: "USD", durationDays: 365 }
  },
  pro: {
    name: "Pro",
    monthly: { price: 12,  currency: "USD", durationDays: 30  },
    annual:  { price: 120, currency: "USD", durationDays: 365 }
  },
  featured: {
    name: "Featured",
    monthly: { price: 25,  currency: "USD", durationDays: 30  }
  }
};

// ─── Cities ──────────────────────────────────────────────────────────────────

export const SUPPLIER_CITIES = [
  "Harare",
  "Bulawayo",
  "Mutare",
  "Gweru",
  "Kwekwe",
  "Masvingo",
  "Chinhoyi",
  "Bindura",
  "Marondera",
  "Chegutu"
];

// ─── Category taxonomy ────────────────────────────────────────────────────────
// Each category has:
//   id         - slug used in DB and button IDs
//   label      - display name
//   types      - ["product"] | ["service"] | ["product","service"]
//   subcats    - optional sub-categories for filtering / admin preset grouping
//   presetKey  - if a preset exists in supplierProductTemplates.js, its key

export const SUPPLIER_CATEGORIES = [

  // ── PRODUCT CATEGORIES ──────────────────────────────────────────────────────

  {
    id: "building_materials",
    label: "🧱 Building Materials",
    types: ["product"],
    subcats: [
      { id: "cement_lime",         label: "Cement & Lime" },
      { id: "sand_aggregates",     label: "Sand & Aggregates" },
      { id: "bricks_blocks",       label: "Bricks & Blocks" },
      { id: "roofing_sheets",      label: "Roofing Sheets & Ridge" },
      { id: "steel_iron",          label: "Steel & Iron" },
      { id: "timber_wood",         label: "Timber & Wood Products" },
      { id: "paints_finishes",     label: "Paints & Finishes" },
      { id: "waterproofing",       label: "Waterproofing & Chemicals" },
      { id: "tile_adhesive",       label: "Tiles, Adhesive & Grout" }
    ],
    presetKey: "building_materials"
  },

  {
    id: "hardware_tools",
    label: "🔧 Hardware & Tools",
    types: ["product"],
    subcats: [
      { id: "hand_tools",     label: "Hand Tools" },
      { id: "power_tools",    label: "Power Tools & Equipment" },
      { id: "fasteners",      label: "Nails, Screws & Bolts" },
      { id: "locks_security", label: "Locks & Door Hardware" },
      { id: "safety_gear",    label: "Safety & PPE" },
      { id: "building_tools", label: "Building Tools (trowels, levels)" }
    ],
    presetKey: "hardware_tools"
  },

  {
    id: "plumbing_supplies",
    label: "🚿 Plumbing Supplies",
    types: ["product"],
    subcats: [
      { id: "pvc_pipes",          label: "PVC Pipes" },
      { id: "copper_pipes",       label: "Copper Pipes & Fittings" },
      { id: "cpvc_pipes",         label: "CPVC / Hot Water Pipes" },
      { id: "valves",             label: "Valves & Controls" },
      { id: "taps_showers",       label: "Taps, Showers & Mixers" },
      { id: "bathroom_fittings",  label: "Bathroom Suites & Basins" },
      { id: "water_tanks",        label: "Water Tanks & Geysers" },
      { id: "drainage",           label: "Drainage & Waste" },
      { id: "pipe_fittings",      label: "Pipe Fittings & Accessories" }
    ],
    presetKey: "plumbing_supplies"
  },

  {
    id: "electrical_supplies",
    label: "⚡ Electrical Supplies",
    types: ["product"],
    subcats: [
      { id: "cables_wire",    label: "Cables & Wire" },
      { id: "db_components",  label: "DB Boards & Breakers" },
      { id: "switches_plugs", label: "Switches & Plug Sockets" },
      { id: "lighting",       label: "Lights & Fittings" },
      { id: "conduit",        label: "Conduit & Trunking" }
    ],
    presetKey: "electrical_supplies"
  },

  {
    id: "solar_energy",
    label: "☀️ Solar & Energy",
    types: ["product"],
    subcats: [
      { id: "solar_panels",     label: "Solar Panels" },
      { id: "inverters",        label: "Inverters & Charge Controllers" },
      { id: "batteries",        label: "Batteries & Storage" },
      { id: "solar_geysers",    label: "Solar Geysers" },
      { id: "solar_accessories", label: "Accessories & Wiring" }
    ],
    presetKey: "solar_energy"
  },

  {
    id: "groceries",
    label: "🛒 Groceries & Food",
    types: ["product"],
    presetKey: "groceries"
  },

  {
    id: "agriculture",
    label: "🌱 Agriculture & Farming",
    types: ["product"],
    presetKey: "agriculture"
  },

  {
    id: "electronics",
    label: "📱 Electronics & Gadgets",
    types: ["product"],
    presetKey: null
  },

  {
    id: "furniture",
    label: "🛋️ Furniture & Fittings",
    types: ["product"],
    presetKey: null
  },

  {
    id: "clothing",
    label: "👕 Clothing & Footwear",
    types: ["product"],
    presetKey: null
  },

  {
    id: "cosmetics",
   label: "💄 Cosmetics & Beauty",
    types: ["product"],
    presetKey: null
  },

  {
    id: "car_supplies",
   label: "🚗 Auto Parts & Tyres",
    types: ["product"],
    presetKey: "car_supplies"
  },

  {
    id: "health",
    label: "💊 Health & Pharmacy",
    types: ["product"],
    presetKey: null
  },

  {
    id: "stationery",
    label: "📋 Stationery & Office",
    types: ["product"],
    presetKey: null
  },

  {
    id: "other_products",
    label: "📦 Other Products",
    types: ["product"],
    presetKey: null
  },

  // ── SERVICE CATEGORIES ──────────────────────────────────────────────────────

  {
    id: "plumbing",
    label: "🔧 Plumbing Services",
    types: ["service"],
    subcats: [
      { id: "burst_pipes",        label: "Burst Pipes & Leaks" },
      { id: "geyser_install",     label: "Geyser Installation & Repair" },
      { id: "drainage_clearing",  label: "Blocked Drains & Sewage" },
      { id: "bathroom_install",   label: "Bathroom Fitting & Renovation" },
      { id: "water_tank_install", label: "Water Tank Installation" },
      { id: "borehole",           label: "Borehole & Pump Services" },
      { id: "general_plumbing",   label: "General Plumbing" }
    ],
    presetKey: "plumbing_services"
  },

  {
    id: "electrical",
    label: "⚡ Electrical Services",
    types: ["service"],
    subcats: [
      { id: "house_wiring",   label: "House & Office Wiring" },
      { id: "db_boards",      label: "DB Board Installation" },
      { id: "solar_install",  label: "Solar System Installation" },
      { id: "fault_finding",  label: "Fault Finding & Repairs" },
      { id: "cctv_alarm",     label: "CCTV & Alarm Systems" },
      { id: "lighting_fit",   label: "Lighting & Fitting" }
    ],
    presetKey: "electrical_services"
  },

  {
    id: "construction",
  label: "🏗️ Construction",
    types: ["service"],
    subcats: [
      { id: "bricklaying",    label: "Bricklaying & Block Work" },
      { id: "plastering",     label: "Plastering & Screeding" },
      { id: "roofing_work",   label: "Roofing & Guttering" },
      { id: "tiling_work",    label: "Tiling (floor & wall)" },
      { id: "foundations",    label: "Foundations & Slabs" },
      { id: "renovations",    label: "Renovations & Additions" }
    ],
    presetKey: "construction_services"
  },

  {
    id: "painting",
    label: "🎨 Painting & Decorating",
    types: ["service"],
    presetKey: "painting_services"
  },

  {
    id: "welding",
    label: "⚙️ Welding & Fabrication",
    types: ["service"],
    presetKey: "welding_services"
  },

  {
    id: "carpentry",
    label: "🪚 Carpentry & Joinery",
    types: ["service"],
    presetKey: null
  },

  {
    id: "cleaning",
    label: "🧹 Cleaning Services",
    types: ["service"],
    presetKey: null
  },

  {
    id: "transport",
    label: "🚚 Transport & Delivery",
    types: ["service"],
    presetKey: null
  },

  {
    id: "food_cooked",
    label: "🍽️ Food & Catering",
    types: ["service"],
    presetKey: null
  },

  {
    id: "printing",
    label: "🖨️ Printing & Branding",
    types: ["service"],
    presetKey: null
  },

  {
    id: "beauty",
    label: "💅 Beauty & Personal Care",
    types: ["service"],
    presetKey: null
  },

  {
    id: "photography",
    label: "📸 Photography & Videography",
    types: ["service"],
    presetKey: null
  },

  {
    id: "tutoring",
    label: "📚 Tutoring & Education",
    types: ["service"],
    presetKey: null
  },

  {
    id: "it_support",
    label: "💻 IT & Tech Support",
    types: ["service"],
    presetKey: null
  },

  {
    id: "security",
    label: "🔒 Security Services",
    types: ["service"],
    presetKey: null
  },

  {
    id: "landscaping",
    label: "🌿 Landscaping & Garden",
    types: ["service"],
    presetKey: null
  },

  {
    id: "other_services",
    label: "🔨 Other Services",
    types: ["service"],
    presetKey: null
  }
];



// ── Listing caps ─────────────────────────────────────────────
export const SUPPLIER_LISTING_CAPS = {
  basic: 20,
  pro: 60,
  featured: 150
};