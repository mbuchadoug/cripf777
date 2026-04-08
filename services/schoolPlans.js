// services/schoolPlans.js
// ─── ZimQuote Schools Module — Plans, Cities, Facilities & Constants ─────────

export const SCHOOL_CITIES = [
  "Harare", "Bulawayo", "Mutare", "Gweru", "Masvingo",
  "Kwekwe", "Kadoma", "Chinhoyi", "Victoria Falls", "Bindura",
  "Zvishavane", "Chegutu", "Rusape", "Kariba", "Hwange"
];

// ── Suburb → City map (mirrors supplierSearch.js pattern) ────────────────────
export const SCHOOL_SUBURB_TO_CITY = {
  // Harare
  "avondale": "Harare", "borrowdale": "Harare", "cbd": "Harare",
  "mbare": "Harare", "highfield": "Harare", "hatfield": "Harare",
  "greendale": "Harare", "msasa": "Harare", "eastlea": "Harare",
  "waterfalls": "Harare", "mufakose": "Harare", "chitungwiza": "Harare",
  "ruwa": "Harare", "highlands": "Harare", "mount pleasant": "Harare",
  "belgravia": "Harare", "milton park": "Harare", "newlands": "Harare",
  "chisipite": "Harare", "gunhill": "Harare", "greystone": "Harare",
  "strathaven": "Harare", "braeside": "Harare", "arcadia": "Harare",
  "southerton": "Harare", "warren park": "Harare", "glen view": "Harare",
  "budiriro": "Harare", "kuwadzana": "Harare", "mabelreign": "Harare",
  "glen norah": "Harare", "dzivarasekwa": "Harare", "tafara": "Harare",
  "mabvuku": "Harare", "norton": "Harare", "kambuzuma": "Harare",
  "epworth": "Harare", "belvedere": "Harare", "westgate": "Harare",
  "sunridge": "Harare", "whitecliff": "Harare", "prospect": "Harare",
  "mbare west": "Harare", "houghton park": "Harare", "tynwald": "Harare",
  "marlborough": "Harare", "borrowdale brooke": "Harare",
  "greystone park": "Harare", "chishawasha": "Harare",
  "mount hampden": "Harare", "ruwa east": "Harare",
  "zengeza": "Harare", "seke": "Harare",
  // Bulawayo
  "nkulumane": "Bulawayo", "luveve": "Bulawayo", "entumbane": "Bulawayo",
  "njube": "Bulawayo", "mpopoma": "Bulawayo", "lobengula": "Bulawayo",
  "makokoba": "Bulawayo", "tshabalala": "Bulawayo", "pumula": "Bulawayo",
  "cowdray park": "Bulawayo", "magwegwe": "Bulawayo", "hillside": "Bulawayo",
 "white city": "Bulawayo", "suburbs": "Bulawayo",
  "famona": "Bulawayo", "barham green": "Bulawayo",
  "queenspark": "Bulawayo", "selbourne park": "Bulawayo",
  "nketa": "Bulawayo", "iminyela": "Bulawayo",
  "mabutweni": "Bulawayo", "makhandeni": "Bulawayo",
  "waterford": "Bulawayo", "whitestone": "Bulawayo",
  "ascot": "Bulawayo",
  // Mutare
"sakubva": "Mutare", "dangamvura": "Mutare", "chikanga": "Mutare",
  "hobhouse": "Mutare", "yeovil": "Mutare", "palmerston": "Mutare",
  "murambi": "Mutare",
  // Gweru
  "mambo": "Gweru", "mkoba": "Gweru", "senga": "Gweru", "ascot": "Gweru",
  // Masvingo
  "mucheke": "Masvingo", "rujeko": "Masvingo", "eastvale": "Masvingo",
  // Kwekwe
 "mbizo": "Kwekwe", "amaveni": "Kwekwe", "redcliff": "Kwekwe",
  // Chinhoyi
  "chinhoyi cbd": "Chinhoyi", "hunyani": "Chinhoyi",
  // Bindura
  "chipadze": "Bindura",
  // Masvingo
  "mucheke": "Masvingo", "rujeko": "Masvingo", "eastvale": "Masvingo"
};

// ── School facilities (shown as multi-select checklist during registration) ───
export const SCHOOL_FACILITIES = [
  { id: "swimming_pool",      label: "🏊 Swimming Pool" },
  { id: "science_lab",        label: "🔬 Science Lab" },
  { id: "computer_lab",       label: "💻 Computer Lab" },
  { id: "library",            label: "📚 Library" },
  { id: "sports_fields",      label: "⚽ Sports Fields" },
  { id: "tennis_courts",      label: "🎾 Tennis Courts" },
  { id: "basketball_court",   label: "🏀 Basketball Court" },
  { id: "gymnasium",          label: "🏋️ Gymnasium" },
  { id: "auditorium",         label: "🎭 Auditorium / Hall" },
  { id: "chapel",             label: "⛪ Chapel" },
  { id: "boarding_house",     label: "🏠 Boarding House" },
  { id: "cafeteria",          label: "🍽️ Cafeteria" },
  { id: "transport",          label: "🚌 School Bus / Transport" },
  { id: "wifi",               label: "📶 Wi-Fi Campus" },
  { id: "art_room",           label: "🎨 Art Room" },
  { id: "music_room",         label: "🎵 Music Room" },
  { id: "drama_studio",       label: "🎬 Drama Studio" },
  { id: "home_economics",     label: "🍳 Home Economics" },
  { id: "agriculture",        label: "🌱 Agriculture / Farm" },
  { id: "medical_centre",     label: "🏥 Medical Centre" }
];

// ── Extramural activities (multi-select during registration) ─────────────────
export const SCHOOL_EXTRAMURALACTIVITIES = [
  { id: "football",      label: "⚽ Football" },
  { id: "netball",       label: "🏐 Netball" },
  { id: "cricket",       label: "🏏 Cricket" },
  { id: "athletics",     label: "🏃 Athletics" },
  { id: "swimming",      label: "🏊 Swimming" },
  { id: "tennis",        label: "🎾 Tennis" },
  { id: "basketball",    label: "🏀 Basketball" },
  { id: "volleyball",    label: "🏐 Volleyball" },
  { id: "chess",         label: "♟️ Chess" },
  { id: "debating",      label: "🎤 Debating" },
  { id: "music",         label: "🎵 Music / Band" },
  { id: "drama",         label: "🎭 Drama" },
  { id: "dance",         label: "💃 Dance" },
  { id: "art",           label: "🎨 Art" },
  { id: "scouts",        label: "⚜️ Scouts / Guides" },
  { id: "environmental", label: "🌿 Environmental Club" },
  { id: "coding",        label: "💻 Coding Club" },
  { id: "science_club",  label: "🔬 Science Club" }
];

// ── Curriculum options ────────────────────────────────────────────────────────
export const SCHOOL_CURRICULA = [
  { id: "zimsec",     label: "📘 ZIMSEC" },
  { id: "cambridge",  label: "🎓 Cambridge (IGCSE/A-Level)" },
  { id: "ib",         label: "🌍 IB (International Baccalaureate)" },
  { id: "combined",   label: "📚 ZIMSEC + Cambridge" }
];

// ── School types ──────────────────────────────────────────────────────────────
export const SCHOOL_TYPES = [
  { id: "primary",   label: "📗 Primary (ECD–Grade 7)" },
  { id: "secondary", label: "📙 Secondary (Form 1–6)" },
  { id: "combined",  label: "📘 Combined (ECD–Form 6)" }
];

// ── Fee ranges (auto-computed, also used as search filter) ───────────────────
export const SCHOOL_FEE_RANGES = [
  { id: "budget",  label: "💚 Budget (Under $300/term)" },
  { id: "mid",     label: "💛 Mid-Range ($300–$800/term)" },
  { id: "premium", label: "💎 Premium ($800+/term)" }
];

// ── Gender options ────────────────────────────────────────────────────────────
export const SCHOOL_GENDERS = [
  { id: "mixed", label: "👫 Mixed (Co-ed)" },
  { id: "boys",  label: "👦 Boys Only" },
  { id: "girls", label: "👧 Girls Only" }
];

// ── Boarding options ──────────────────────────────────────────────────────────
export const SCHOOL_BOARDING = [
  { id: "day",      label: "🏠 Day School Only" },
  { id: "boarding", label: "🏫 Boarding Only" },
  { id: "both",     label: "🏠🏫 Day & Boarding" }
];

// ── Grade bands (from/to options) ────────────────────────────────────────────
export const SCHOOL_GRADE_FROM = [
  "ECD A", "ECD B", "Grade 1", "Grade 2", "Grade 3",
  "Grade 4", "Grade 5", "Grade 6", "Grade 7", "Form 1"
];
export const SCHOOL_GRADE_TO = [
  "Grade 7", "Form 1", "Form 2", "Form 3", "Form 4",
  "Form 5", "Form 6", "Upper 6"
];

// ── Subscription plans ────────────────────────────────────────────────────────
export const SCHOOL_PLANS = {
  basic: {
    id:       "basic",
    name:     "Basic",
    monthly:  { price: 15, label: "$15/month", id: "school_plan_basic_monthly" },
    annual:   { price: 150, label: "$150/year (save $30)", id: "school_plan_basic_annual" },
    features: "Listed in search · Profile PDF · Application link"
  },
  featured: {
    id:       "featured",
    name:     "Featured",
    monthly:  { price: 35, label: "$35/month", id: "school_plan_featured_monthly" },
    annual:   { price: 350, label: "$350/year (save $70)", id: "school_plan_featured_annual" },
    features: "Top of results · Verified badge · Analytics · All Basic features"
  }
};

// ── Helper: compute fee range string from term fee amount ────────────────────
export function computeSchoolFeeRange(termFee = 0) {
  const n = Number(termFee) || 0;
  if (n < 300)  return "budget";
  if (n <= 800) return "mid";
  return "premium";
}

// ── Helper: readable fee range label ─────────────────────────────────────────
export function feeRangeLabel(range = "") {
  return { budget: "Under $300/term", mid: "$300–$800/term", premium: "$800+/term" }[range] || "Not specified";
}

// ── Helper: emoji icon for facility id ───────────────────────────────────────
export function facilityIcon(id = "") {
  const f = SCHOOL_FACILITIES.find(f => f.id === id);
  return f ? f.label.split(" ")[0] : "•";
}