// services/supplierPlans.js
// ─── Supplier subscription plans ─────────────────────────────────────────────

export const SUPPLIER_PLANS = {
  basic: {
    name: "Basic",
    monthly: { price: 5,   currency: "USD", durationDays: 30  },
    annual:  { price: 50,  currency: "USD", durationDays: 365 }
  },
  pro: {
    name: "Pro",
    monthly: { price: 10,  currency: "USD", durationDays: 30  },
    annual:  { price: 100, currency: "USD", durationDays: 365 }
  },
  featured: {
    name: "Featured",
    monthly: { price: 25,  currency: "USD", durationDays: 30  }
  }
};






export const SUPPLIER_PLAN_FEATURES = {
  basic: [
    "Up to 20 live items",
    "Unlimited uploads",
    "Unlimited orders",
    "Upgrade anytime"
  ],
  pro: [
    "Up to 60 live items",
    "Unlimited uploads",
    "Unlimited orders",
    "Upgrade anytime"
  ],
  featured: [
    "Up to 150 live items",
    "Unlimited uploads",
    "Unlimited orders",
    "Upgrade anytime"
  ]
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
  "Bindura"
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
    label: "💄 Cosmetics & Beauty Products",
    types: ["product"],
    presetKey: null
  },

  {
    id: "car_supplies",
    label: "🚗 Auto Parts & Accessories",
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
    label: "🏗️ Construction & Building",
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
    id: "dentists",
    label: "🦷 Dentists & Dental Clinics",
    types: ["service"],
    subcats: [
      { id: "general_dentistry", label: "General Dentistry" },
      { id: "tooth_extraction",  label: "Tooth Extraction" },
      { id: "teeth_cleaning",    label: "Teeth Cleaning & Whitening" },
      { id: "braces_aligners",   label: "Braces & Aligners" },
      { id: "dental_implants",   label: "Dental Implants" },
      { id: "emergency_dental",  label: "Emergency Dental Care" }
    ],
    presetKey: null
  },

  {
    id: "legal",
    label: "⚖️ Legal Services",
    types: ["service"],
    subcats: [
      { id: "conveyancing",      label: "Conveyancing & Property Transfer" },
      { id: "notary_commission", label: "Notary & Commissioner Services" },
      { id: "company_registration", label: "Company Registration" },
      { id: "family_law",        label: "Family Law" },
      { id: "labour_law",        label: "Labour Law" },
      { id: "litigation",        label: "Litigation & Court Matters" },
      { id: "contract_drafting", label: "Contracts & Agreements" }
    ],
    presetKey: null
  },

  {
    id: "real_estate",
    label: "🏠 Real Estate Services",
    types: ["service"],
    subcats: [
      { id: "property_sales",    label: "Property Sales" },
      { id: "property_rentals",  label: "Property Rentals" },
      { id: "property_valuation", label: "Property Valuation" },
      { id: "property_management", label: "Property Management" },
      { id: "commercial_property", label: "Commercial Property" },
      { id: "land_sales",        label: "Land & Stands" }
    ],
    presetKey: null
  },

  {
    id: "accounting",
    label: "📊 Accounting & Bookkeeping",
    types: ["service"],
    subcats: [
      { id: "bookkeeping",       label: "Bookkeeping" },
      { id: "financial_statements", label: "Financial Statements" },
      { id: "payroll",           label: "Payroll Services" },
      { id: "management_accounts", label: "Management Accounts" },
      { id: "tax_returns",       label: "Tax Returns" },
      { id: "vat_returns",       label: "VAT Returns" }
    ],
    presetKey: null
  },

  {
    id: "auditing",
    label: "🧾 Auditing & Assurance",
    types: ["service"],
    subcats: [
      { id: "external_audit",    label: "External Audit" },
      { id: "internal_audit",    label: "Internal Audit" },
      { id: "compliance_review", label: "Compliance Review" },
      { id: "risk_assessment",   label: "Risk Assessment" },
      { id: "forensic_audit",    label: "Forensic Audit" },
      { id: "assurance_services", label: "Assurance Services" }
    ],
    presetKey: null
  },

  {
    id: "medical",
    label: "🏥 Private Clinics & Medical Services",
    types: ["service"],
    subcats: [
      { id: "general_practice",  label: "General Practice" },
      { id: "specialist_consult", label: "Specialist Consultation" },
      { id: "laboratory",        label: "Laboratory Services" },
      { id: "scans_xray",        label: "Scans & X-Ray" },
      { id: "physiotherapy",     label: "Physiotherapy" },
      { id: "occupational_health", label: "Occupational Health" }
    ],
    presetKey: null
  },

  {
    id: "architecture",
    label: "📐 Architecture & Design",
    types: ["service"],
    subcats: [
      { id: "house_plans",       label: "House Plans" },
      { id: "commercial_design", label: "Commercial Design" },
      { id: "plan_approvals",    label: "Plan Approvals" },
      { id: "interior_design",   label: "Interior Design" },
      { id: "3d_visuals",        label: "3D Visuals & Concepts" }
    ],
    presetKey: null
  },

  {
    id: "engineering",
    label: "🏗️ Engineering Services",
    types: ["service"],
    subcats: [
      { id: "structural_engineering", label: "Structural Engineering" },
      { id: "civil_engineering",      label: "Civil Engineering" },
      { id: "electrical_engineering", label: "Electrical Engineering" },
      { id: "mechanical_engineering", label: "Mechanical Engineering" },
      { id: "site_inspections",       label: "Site Inspections & Reports" }
    ],
    presetKey: null
  },

  {
    id: "insurance",
    label: "🛡️ Insurance Services",
    types: ["service"],
    subcats: [
      { id: "motor_insurance",   label: "Motor Insurance" },
    { id: "medical_insurance", label: "Medical Insurance" },
      { id: "funeral_cover",     label: "Funeral Cover" },
      { id: "business_insurance", label: "Business Insurance" },
      { id: "property_insurance", label: "Property Insurance" }
    ],
    presetKey: null
  },

  {
    id: "other_services",
    label: "🔨 Other Services",
    types: ["service"],
    presetKey: null
  }

];