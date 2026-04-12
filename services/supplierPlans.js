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



// ─── Service collar groupings ─────────────────────────────────────────────────
// Used in registration and buyer browsing to group services by work type.

export const SERVICE_COLLAR_GROUPS = {
  white_collar: {
    label: "💼 White Collar / Professional",
    description: "Consulting, legal, finance, design, IT, HR, accounting",
    categoryIds: [
      "accounting",
      "legal",
      "financial_advisory",
      "hr_recruitment",
      "marketing_digital",
      "architecture_design",
      "it_support",
      "tutoring",
      "medical_health",
      "real_estate",
      "insurance",
      "events_management"
    ]
  },
  trade: {
    label: "🔧 Trade & Artisan",
    description: "Skilled trades: plumbing, electrical, welding, construction",
    categoryIds: [
      "plumbing",
      "electrical",
      "construction",
      "welding",
      "carpentry",
      "painting",
      "solar_install_service",
      "tiling_flooring",
      "glazing_aluminium",
      "air_conditioning"
    ]
  },
  blue_collar: {
    label: "🧹 Blue Collar / General",
    description: "Cleaning, transport, delivery, domestic, security",
    categoryIds: [
      "cleaning",
      "transport",
      "security",
      "landscaping",
      "food_cooked",
      "beauty",
      "photography",
      "printing",
      "other_services"
    ]
  }
};

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
  id: "industrial_equipment",
  label: "🏭 Industrial Equipment",
  types: ["product"],
  presetKey: null
},

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
    id: "appliances",
    label: "🏠 Household & Kitchen Appliances",
    types: ["product"],
    subcats: [
      { id: "fridges_freezers",   label: "Fridges & Freezers" },
      { id: "stoves_cookers",     label: "Stoves & Cookers" },
      { id: "washing_machines",   label: "Washing Machines & Dryers" },
      { id: "microwaves",         label: "Microwaves & Ovens" },
      { id: "water_heaters",      label: "Water Heaters & Geysers" },
      { id: "blenders_mixers",    label: "Blenders, Juicers & Mixers" },
      { id: "air_conditioners",   label: "Air Conditioners & Fans" },
      { id: "vacuum_cleaners",    label: "Vacuum Cleaners & Floor Care" },
      { id: "small_appliances",   label: "Small Kitchen Appliances" },
      { id: "appliance_parts",    label: "Appliance Spare Parts" }
    ],
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
// ── SERVICE CATEGORIES ──────────────────────────────────────────────────────

  // ── WHITE COLLAR / PROFESSIONAL ────────────────────────────────────────────

  {
    id: "accounting",
    label: "📊 Accounting & Bookkeeping",
    types: ["service"],
    collar: "white_collar",
    subcats: [
      { id: "bookkeeping",        label: "Bookkeeping & Ledgers" },
      { id: "tax_returns",        label: "Tax Returns & ZIMRA" },
      { id: "payroll",            label: "Payroll Processing" },
      { id: "auditing",           label: "Auditing & Compliance" },
      { id: "financial_reports",  label: "Financial Statements" },
      { id: "vat_registration",   label: "VAT & Business Registration" }
    ],
    presetKey: null
  },

  {
    id: "legal",
    label: "⚖️ Legal Services",
    types: ["service"],
    collar: "white_collar",
    subcats: [
      { id: "contracts",          label: "Contract Drafting & Review" },
      { id: "property_law",       label: "Property & Conveyancing" },
      { id: "civil_litigation",   label: "Civil Litigation" },
      { id: "company_reg",        label: "Company Registration" },
      { id: "notary",             label: "Notary & Affidavits" },
      { id: "immigration",        label: "Immigration & Work Permits" },
      { id: "family_law",         label: "Family Law & Divorce" }
    ],
    presetKey: null
  },

  {
    id: "financial_advisory",
    label: "💰 Financial Advisory",
    types: ["service"],
    collar: "white_collar",
    subcats: [
      { id: "investment_advice",  label: "Investment Planning" },
      { id: "insurance_advisory", label: "Insurance Advisory" },
      { id: "forex",              label: "Forex & Treasury" },
      { id: "business_valuation", label: "Business Valuation" },
      { id: "loan_advisory",      label: "Loan & Funding Advisory" }
    ],
    presetKey: null
  },

  {
    id: "hr_recruitment",
    label: "🧑‍💼 HR & Recruitment",
    types: ["service"],
    collar: "white_collar",
    subcats: [
      { id: "recruitment",        label: "Recruitment & Headhunting" },
      { id: "hr_consulting",      label: "HR Policy & Consulting" },
      { id: "training_dev",       label: "Staff Training & Development" },
      { id: "job_placement",      label: "Job Placement" },
      { id: "labour_relations",   label: "Labour Relations & Disputes" }
    ],
    presetKey: null
  },

  {
    id: "marketing_digital",
    label: "📣 Marketing & Digital",
    types: ["service"],
    collar: "white_collar",
    subcats: [
      { id: "social_media_mgmt",  label: "Social Media Management" },
      { id: "seo_ads",            label: "SEO & Google/Meta Ads" },
      { id: "content_creation",   label: "Content Creation & Copywriting" },
      { id: "branding",           label: "Branding & Identity" },
      { id: "web_development",    label: "Website Development" },
      { id: "email_marketing",    label: "Email Marketing Campaigns" },
      { id: "market_research",    label: "Market Research & Surveys" }
    ],
    presetKey: null
  },

  {
    id: "architecture_design",
    label: "🏛️ Architecture & Design",
    types: ["service"],
    collar: "white_collar",
    subcats: [
      { id: "architectural_plans", label: "Architectural Plans & Drawings" },
      { id: "structural_eng",      label: "Structural Engineering" },
      { id: "interior_design",     label: "Interior Design" },
      { id: "quantity_surveying",  label: "Quantity Surveying (QS)" },
      { id: "landscape_design",    label: "Landscape Architecture" },
      { id: "project_management",  label: "Construction Project Management" }
    ],
    presetKey: null
  },

  {
    id: "medical_health",
    label: "🩺 Medical & Health Services",
    types: ["service"],
    collar: "white_collar",
    subcats: [
      { id: "gp_consult",         label: "GP & General Consultation" },
      { id: "dental",             label: "Dental Services" },
      { id: "physio",             label: "Physiotherapy" },
      { id: "mental_health",      label: "Counselling & Mental Health" },
      { id: "home_nursing",       label: "Home Nursing & Care" },
      { id: "nutrition",          label: "Nutrition & Dietetics" },
      { id: "optometry",          label: "Eye Care & Optometry" }
    ],
    presetKey: null
  },

  {
    id: "real_estate",
    label: "🏠 Real Estate & Property",
    types: ["service"],
    collar: "white_collar",
    subcats: [
      { id: "property_sales",     label: "Property Sales & Letting" },
      { id: "property_mgmt",      label: "Property Management" },
      { id: "valuations",         label: "Property Valuations" },
      { id: "rentals",            label: "Rentals & Tenant Finding" }
    ],
    presetKey: null
  },

  {
    id: "events_management",
    label: "🎪 Events & Entertainment",
    types: ["service"],
    collar: "white_collar",
    subcats: [
      { id: "event_planning",     label: "Event Planning & Coordination" },
      { id: "mc_services",        label: "MC & Host Services" },
      { id: "dj_music",           label: "DJ & Live Music" },
      { id: "tent_hire",          label: "Tent & Décor Hire" },
      { id: "wedding_planning",   label: "Wedding Planning" },
      { id: "corporate_events",   label: "Corporate Events" }
    ],
    presetKey: null
  },

  // ── TRADE & ARTISAN ─────────────────────────────────────────────────────────

  {
    id: "plumbing",
    label: "🔧 Plumbing Services",
    types: ["service"],
    collar: "trade",
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
  id: "engineering_services",
  label: "🛠 Engineering Services",
  types: ["service"],
  collar: "white_collar",
  subcats: [
    { id: "mechanical", label: "Mechanical Engineering" },
    { id: "electrical_eng", label: "Electrical Engineering" },
    { id: "civil_eng", label: "Civil Engineering" },
    { id: "industrial_eng", label: "Industrial Engineering" },
    { id: "consulting_eng", label: "Engineering Consulting" }
  ],
  presetKey: null
},
  {
    id: "electrical",
    label: "⚡ Electrical Services",
    types: ["service"],
    collar: "trade",
    subcats: [
      { id: "house_wiring",       label: "House & Office Wiring" },
      { id: "db_boards",          label: "DB Board Installation" },
      { id: "solar_install",      label: "Solar System Installation" },
      { id: "fault_finding",      label: "Fault Finding & Repairs" },
      { id: "cctv_alarm",         label: "CCTV & Alarm Systems" },
      { id: "lighting_fit",       label: "Lighting & Fitting" },
      { id: "generator_install",  label: "Generator Installation" }
    ],
    presetKey: "electrical_services"
  },

  {
    id: "construction",
    label: "🏗️ Construction & Building",
    types: ["service"],
    collar: "trade",
    subcats: [
      { id: "bricklaying",        label: "Bricklaying & Block Work" },
      { id: "plastering",         label: "Plastering & Screeding" },
      { id: "roofing_work",       label: "Roofing & Guttering" },
      { id: "tiling_work",        label: "Tiling (floor & wall)" },
      { id: "foundations",        label: "Foundations & Slabs" },
      { id: "renovations",        label: "Renovations & Additions" },
      { id: "swimming_pool",      label: "Swimming Pool Construction" },
      { id: "drywall_ceiling",    label: "Drywall & Ceiling" }
    ],
    presetKey: "construction_services"
  },

  {
    id: "welding",
    label: "⚙️ Welding & Fabrication",
    types: ["service"],
    collar: "trade",
    subcats: [
      { id: "gates_fencing",      label: "Gates & Security Fencing" },
      { id: "burglar_bars",       label: "Burglar Bars & Grilles" },
      { id: "steel_structures",   label: "Steel Structures & Carports" },
      { id: "trailer_fabrication",label: "Trailer & Vehicle Fabrication" },
      { id: "general_welding",    label: "General Welding & Repairs" }
    ],
    presetKey: "welding_services"
  },

  {
    id: "carpentry",
    label: "🪚 Carpentry & Joinery",
    types: ["service"],
    collar: "trade",
    subcats: [
      { id: "door_fitting",       label: "Door & Window Fitting" },
      { id: "built_in_cupboards", label: "Built-in Cupboards & Wardrobes" },
      { id: "kitchen_units",      label: "Kitchen Units & Cabinets" },
      { id: "decking",            label: "Decking & Pergolas" },
      { id: "roof_trusses",       label: "Roof Trusses & Timber Frame" },
      { id: "furniture_repair",   label: "Furniture Repair & Restoration" }
    ],
    presetKey: null
  },

  {
    id: "painting",
    label: "🎨 Painting & Decorating",
    types: ["service"],
    collar: "trade",
    subcats: [
      { id: "interior_painting",  label: "Interior Painting" },
      { id: "exterior_painting",  label: "Exterior Painting" },
      { id: "roof_painting",      label: "Roof Painting & Waterproofing" },
      { id: "texture_coat",       label: "Texture Coat & Plastering" },
      { id: "wallpaper",          label: "Wallpaper & Feature Walls" }
    ],
    presetKey: "painting_services"
  },

  {
    id: "tiling_flooring",
    label: "🪵 Tiling & Flooring",
    types: ["service"],
    collar: "trade",
    subcats: [
      { id: "floor_tiles",        label: "Floor Tiling" },
      { id: "wall_tiles",         label: "Wall Tiling" },
      { id: "wooden_floors",      label: "Wooden & Laminate Floors" },
      { id: "epoxy_flooring",     label: "Epoxy & Industrial Flooring" },
      { id: "carpet_laying",      label: "Carpet Laying" }
    ],
    presetKey: null
  },

  {
    id: "air_conditioning",
    label: "❄️ Air Conditioning & Refrigeration",
    types: ["service"],
    collar: "trade",
    subcats: [
      { id: "ac_install",         label: "AC Installation" },
      { id: "ac_repair",          label: "AC Service & Repair" },
      { id: "fridge_repair",      label: "Fridge & Freezer Repair" },
      { id: "cold_room",          label: "Cold Room Installation" }
    ],
    presetKey: null
  },

  {
    id: "glazing_aluminium",
    label: "🪟 Glazing & Aluminium",
    types: ["service"],
    collar: "trade",
    subcats: [
      { id: "windows_doors",      label: "Aluminium Windows & Doors" },
      { id: "glass_replacement",  label: "Glass Replacement & Repair" },
      { id: "shower_screens",     label: "Shower Screens & Enclosures" },
      { id: "mirrors",            label: "Mirrors & Frameless Glass" }
    ],
    presetKey: null
  },

  // ── BLUE COLLAR / GENERAL ───────────────────────────────────────────────────

  {
    id: "cleaning",
    label: "🧹 Cleaning Services",
    types: ["service"],
    collar: "blue_collar",
    subcats: [
      { id: "office_cleaning",    label: "Office & Commercial Cleaning" },
      { id: "domestic_cleaning",  label: "Domestic & House Cleaning" },
      { id: "carpet_cleaning",    label: "Carpet & Upholstery Cleaning" },
      { id: "deep_clean",         label: "Deep Clean & Move-out Clean" },
      { id: "window_cleaning",    label: "Window Cleaning" },
      { id: "industrial_clean",   label: "Industrial & Post-construction" }
    ],
    presetKey: null
  },

  {
    id: "transport",
    label: "🚚 Transport & Delivery",
    types: ["service"],
    collar: "blue_collar",
    subcats: [
      { id: "car_hire",           label: "Car Hire & Chauffeuring" },
      { id: "furniture_removal",  label: "Furniture Removal & Moving" },
      { id: "courier",            label: "Courier & Same-day Delivery" },
      { id: "airport_transfer",   label: "Airport Transfers" },
      { id: "truck_hire",         label: "Truck & Lorry Hire" },
      { id: "grocery_delivery",   label: "Grocery & Errand Delivery" }
    ],
    presetKey: null
  },

  {
    id: "security",
    label: "🔒 Security Services",
    types: ["service"],
    collar: "blue_collar",
    subcats: [
      { id: "guards",             label: "Security Guards & Patrols" },
      { id: "alarm_install",      label: "Alarm System Installation" },
      { id: "access_control",     label: "Access Control & Biometrics" },
      { id: "electric_fence",     label: "Electric Fence Installation" },
      { id: "vip_protection",     label: "VIP & Close Protection" }
    ],
    presetKey: null
  },

  {
    id: "landscaping",
    label: "🌿 Landscaping & Garden",
    types: ["service"],
    collar: "blue_collar",
    subcats: [
      { id: "lawn_mowing",        label: "Lawn Mowing & Maintenance" },
      { id: "tree_felling",       label: "Tree Felling & Trimming" },
      { id: "garden_design",      label: "Garden Design & Planting" },
      { id: "irrigation",         label: "Irrigation Systems" },
      { id: "paving",             label: "Paving & Driveways" }
    ],
    presetKey: null
  },

  {
    id: "food_cooked",
    label: "🍽️ Food & Catering",
    types: ["service"],
    collar: "blue_collar",
    subcats: [
      { id: "event_catering",     label: "Event & Wedding Catering" },
      { id: "lunch_boxes",        label: "Daily Lunch Boxes" },
      { id: "baking_cakes",       label: "Baking & Custom Cakes" },
      { id: "private_chef",       label: "Private Chef Services" },
      { id: "buffet_setup",       label: "Buffet & Equipment Hire" }
    ],
    presetKey: null
  },

  {
    id: "beauty",
    label: "💅 Beauty & Personal Care",
    types: ["service"],
    collar: "blue_collar",
    subcats: [
      { id: "hair",               label: "Hair Braiding, Weaves & Styling" },
      { id: "nails",              label: "Nails & Nail Art" },
      { id: "makeup",             label: "Makeup & Beauty" },
      { id: "massage",            label: "Massage & Spa" },
      { id: "barbering",          label: "Barbering & Men's Grooming" },
      { id: "lashes_brows",       label: "Lashes & Brow Services" }
    ],
    presetKey: null
  },

  {
    id: "photography",
    label: "📸 Photography & Videography",
    types: ["service"],
    collar: "blue_collar",
    subcats: [
      { id: "wedding_photos",     label: "Wedding Photography" },
      { id: "events_coverage",    label: "Events Coverage" },
      { id: "corporate_photos",   label: "Corporate & Product Photography" },
      { id: "drone_footage",      label: "Drone Footage" },
      { id: "passport_photos",    label: "Passport & ID Photos" },
      { id: "video_production",   label: "Video Production & Editing" }
    ],
    presetKey: null
  },

  {
    id: "tutoring",
    label: "📚 Tutoring & Education",
    types: ["service"],
    collar: "blue_collar",
    subcats: [
      { id: "primary_tutor",      label: "Primary School Tutoring" },
      { id: "olevel_tutor",       label: "O-Level Tutoring" },
      { id: "alevel_tutor",       label: "A-Level Tutoring" },
      { id: "driving_lessons",    label: "Driving Lessons" },
      { id: "music_lessons",      label: "Music Lessons" },
      { id: "language_classes",   label: "Language Classes" }
    ],
    presetKey: null
  },

  {
    id: "it_support",
    label: "💻 IT & Tech Support",
    types: ["service"],
    collar: "blue_collar",
    subcats: [
      { id: "laptop_repair",      label: "Laptop & PC Repair" },
      { id: "phone_repair",       label: "Phone & Tablet Repair" },
      { id: "networking",         label: "Networking & WiFi Setup" },
      { id: "cctv_it",            label: "CCTV & Camera Systems" },
      { id: "software_support",   label: "Software & IT Support" },
      { id: "web_hosting",        label: "Web Hosting & Domains" }
    ],
    presetKey: null
  },

  {
    id: "printing",
    label: "🖨️ Printing & Branding",
    types: ["service"],
    collar: "blue_collar",
    subcats: [
      { id: "business_cards",     label: "Business Cards & Stationery" },
      { id: "banners_signage",    label: "Banners & Signage" },
      { id: "branded_clothing",   label: "Branded Clothing & Uniforms" },
      { id: "flyers_brochures",   label: "Flyers & Brochures" },
      { id: "vehicle_branding",   label: "Vehicle Branding & Wraps" }
    ],
    presetKey: null
  },

  {
    id: "other_services",
    label: "🔨 Other Services",
    types: ["service"],
    collar: "blue_collar",
    subcats: [
      { id: "handyman",           label: "Handyman & Odd Jobs" },
      { id: "pest_control",       label: "Pest Control" },
      { id: "laundry",            label: "Laundry & Dry Cleaning" },
      { id: "pool_maintenance",   label: "Swimming Pool Maintenance" }
    ],
    presetKey: null
  }
]