// services/supplierSearch.js

import SupplierProfile from "../models/supplierProfile.js";
import { sendText, sendList, sendButtons } from "./metaSender.js";

export async function startSupplierSearch(from, biz, saveBiz) {
  biz.sessionState = "supplier_search_category";
  biz.sessionData = { supplierSearch: {} };
  await saveBiz(biz);

  const { SUPPLIER_CATEGORIES } = await import("./supplierPlans.js");

  return sendList(from, "🔍 What are you looking for?", [
    ...SUPPLIER_CATEGORIES.map(c => ({
      id: `sup_search_cat_${c.id}`,
      title: c.label
    })),
    { id: "sup_search_all", title: "🔍 Search by product name" }
  ]);
}

// ── Synonym/alias map: Maps what buyers TYPE → what suppliers LIST ────────────
const SEARCH_SYNONYMS = {
  // ── GROCERIES & FOOD ─────────────────────────────────────────────────────
  "food": ["groceries", "grocery", "cooking oil", "mealie meal", "rice", "bread", "flour", "sugar", "sadza"],
  "groceries": ["grocery", "supermarket", "food", "provisions", "cooking oil", "mealie meal", "rice", "bread", "flour", "sugar"],
  "grocery": ["groceries", "food", "provisions", "cooking oil", "mealie meal", "rice", "bread", "flour", "sugar"],
  "mealie meal": ["sadza", "roller meal", "maize meal", "flour", "grain", "groceries"],
  "sadza": ["mealie meal", "roller meal", "maize meal", "grain", "groceries"],
  "cooking oil": ["oil", "sunflower oil", "vegetable oil", "groceries", "food"],
  "oil": ["cooking oil", "sunflower oil", "vegetable oil", "lubricant", "engine oil"],
  "bread": ["loaf", "buns", "bakery", "groceries", "food"],
  "rice": ["basmati", "white rice", "groceries", "grain", "food"],
  "flour": ["wheat flour", "self raising flour", "groceries", "baking", "food"],
  "sugar": ["white sugar", "brown sugar", "groceries", "sweetener", "food"],
  "chicken": ["poultry", "broiler", "frozen chicken", "meat", "groceries", "food"],
  "beef": ["steak", "mince", "meat", "nyama", "groceries", "food"],
  "fish": ["bream", "kapenta", "seafood", "groceries", "food"],
  "vegetables": ["veggies", "tomatoes", "onions", "cabbage", "spinach", "potatoes", "carrots", "groceries", "fresh produce"],
  "fruit": ["apples", "bananas", "oranges", "mangoes", "avocado", "fresh produce", "groceries"],
  "drinks": ["juice", "soft drinks", "water", "beverages", "cooldrink", "soda", "groceries"],
  "water": ["drinking water", "mineral water", "bottled water", "drinks", "groceries"],
  "milk": ["dairy", "fresh milk", "long life milk", "groceries", "food"],
  "eggs": ["poultry", "groceries", "food", "dairy"],
  "provisions": ["groceries", "food", "supplies", "household"],

  // ── CAR PARTS & SUPPLIES ──────────────────────────────────────────────────
  "car parts": ["auto parts", "spare parts", "spares", "vehicle parts", "car accessories", "car supplies", "mechanical parts"],
  "spares": ["car parts", "spare parts", "auto parts", "vehicle parts", "car accessories", "car supplies"],
  "spare parts": ["spares", "car parts", "auto parts", "vehicle parts", "mechanical parts", "car supplies"],
  "auto parts": ["car parts", "spare parts", "spares", "vehicle parts", "car accessories"],
  "tyres": ["tires", "wheels", "rims", "car supplies", "car parts", "spares"],
  "tires": ["tyres", "wheels", "rims", "car supplies", "car parts"],
  "battery": ["car battery", "batteries", "car parts", "spares", "electrical"],
  "engine oil": ["oil", "lubricant", "motor oil", "car supplies", "car parts"],
  "brake pads": ["brakes", "car parts", "spares", "auto parts"],
  "filters": ["oil filter", "air filter", "car parts", "spares", "auto parts"],

  // ── CLOTHING & SHOES ──────────────────────────────────────────────────────
  "clothes": ["clothing", "fashion", "garments", "wear", "shirts", "trousers", "dresses", "jeans", "t-shirts", "suits", "uniforms", "shoes"],
  "clothing": ["clothes", "fashion", "garments", "wear", "shirts", "trousers", "dresses", "jeans", "t-shirts", "suits"],
  "shoes": ["sneakers", "boots", "heels", "sandals", "footwear", "clothing", "fashion"],
  "sneakers": ["shoes", "trainers", "sports shoes", "footwear", "clothing"],
  "school uniforms": ["uniforms", "school clothes", "clothing", "school wear", "school supplies"],
  "uniforms": ["school uniforms", "work uniforms", "clothing", "corporate wear"],
  "dresses": ["clothing", "fashion", "women wear", "ladies wear", "clothes"],
  "suits": ["formal wear", "clothing", "men wear", "corporate wear", "fashion"],
  "second hand": ["salaula", "used clothes", "secondhand", "thrift", "clothing"],
  "salaula": ["second hand", "used clothes", "secondhand", "thrift", "clothing"],

  // ── HARDWARE & BUILDING ───────────────────────────────────────────────────
  "hardware": ["building materials", "construction materials", "cement", "sand", "bricks", "steel", "iron sheets", "timber", "paint", "tools"],
  "cement": ["concrete", "building materials", "hardware", "construction", "portland cement"],
  "sand": ["river sand", "building sand", "plaster sand", "hardware", "building materials", "construction"],
  "river sand": ["sand", "building sand", "hardware", "building materials"],
  "bricks": ["building bricks", "face bricks", "hardware", "building materials", "construction"],
  "iron sheets": ["roofing sheets", "roof sheets", "corrugated iron", "hardware", "building materials", "roofing"],
  "roofing": ["iron sheets", "roof sheets", "roofing sheets", "tiles", "hardware", "building materials"],
  "timber": ["wood", "planks", "lumber", "hardware", "building materials", "furniture"],
  "wood": ["timber", "planks", "lumber", "hardwood", "furniture", "hardware"],
  "nails": ["screws", "bolts", "hardware", "fasteners", "building materials"],
  "steel": ["steel bars", "rebar", "metal", "hardware", "building materials", "construction"],
  "pipes": ["plumbing pipes", "pvc pipes", "hardware", "plumbing", "building materials"],
  "tiles": ["floor tiles", "wall tiles", "ceramic tiles", "hardware", "building materials", "roofing"],
  "paint": ["emulsion", "gloss paint", "hardware", "painting", "building materials"],
  "tools": ["power tools", "hand tools", "drill", "hardware", "building materials"],
  "building materials": ["hardware", "cement", "sand", "bricks", "steel", "iron sheets", "timber", "construction materials"],

  // ── AGRICULTURE & FARMING ─────────────────────────────────────────────────
  "farming": ["agriculture", "seeds", "fertilizer", "chemicals", "pesticides", "livestock", "crops", "maize", "soya"],
  "agriculture": ["farming", "seeds", "fertilizer", "chemicals", "pesticides", "livestock", "crops"],
  "seeds": ["maize seed", "vegetable seeds", "soya seed", "farming", "agriculture"],
  "fertilizer": ["fertiliser", "compound D", "ammonium nitrate", "farming", "agriculture"],
  "pesticides": ["chemicals", "herbicides", "insecticides", "farming", "agriculture"],
  "maize": ["corn", "grain", "farming", "agriculture", "groceries"],
  "soya": ["soya beans", "farming", "agriculture", "grain"],
  "day old chicks": ["poultry", "chicks", "broilers", "farming", "agriculture", "livestock"],
  "livestock": ["cattle", "goats", "pigs", "chickens", "poultry", "farming", "agriculture"],

  // ── ELECTRONICS ───────────────────────────────────────────────────────────
  "electronics": ["phones", "laptops", "computers", "tv", "television", "appliances", "gadgets", "solar", "inverter"],
  "phone": ["smartphones", "mobile phones", "cell phones", "electronics", "gadgets"],
  "phones": ["smartphones", "mobile phones", "cell phones", "electronics", "gadgets"],
  "laptop": ["laptops", "computers", "notebooks", "electronics", "gadgets"],
  "laptops": ["laptop", "computers", "notebooks", "electronics", "gadgets"],
  "tv": ["television", "smart tv", "flat screen", "electronics", "appliances"],
  "television": ["tv", "smart tv", "flat screen", "electronics", "appliances"],
  "solar": ["solar panels", "solar system", "inverter", "batteries", "electronics", "energy"],
  "inverter": ["solar", "ups", "power backup", "electronics", "energy"],
  "appliances": ["fridge", "stove", "microwave", "washing machine", "electronics", "home appliances"],
  "fridge": ["refrigerator", "freezer", "appliances", "electronics"],
  "stove": ["cooker", "gas stove", "electric stove", "appliances", "electronics"],

  // ── CROSS-BORDER GOODS ────────────────────────────────────────────────────
  "cross border": ["imports", "foreign goods", "imported goods", "crossborder", "south africa goods", "china goods"],
  "crossborder": ["cross border", "imports", "foreign goods", "imported goods"],
  "imports": ["cross border", "imported goods", "foreign goods", "crossborder"],
  "imported": ["cross border", "imports", "foreign goods", "crossborder"],

  // ── COSMETICS & BEAUTY ────────────────────────────────────────────────────
  "cosmetics": ["beauty products", "skincare", "makeup", "lotion", "cream", "hair products", "perfume"],
  "beauty products": ["cosmetics", "skincare", "makeup", "lotion", "cream", "hair products"],
  "skincare": ["cosmetics", "beauty products", "lotion", "cream", "moisturiser", "sunscreen"],
  "lotion": ["body lotion", "skincare", "cream", "cosmetics", "beauty products"],
  "makeup": ["cosmetics", "foundation", "lipstick", "mascara", "beauty products"],
  "perfume": ["fragrance", "cologne", "cosmetics", "beauty products"],
  "hair products": ["weave", "extensions", "shampoo", "conditioner", "cosmetics", "beauty products", "hair"],
  "weave": ["hair extensions", "hair products", "cosmetics", "beauty products"],

  // ── FURNITURE & HOME ──────────────────────────────────────────────────────
  "furniture": ["sofas", "chairs", "tables", "beds", "wardrobes", "cabinets", "home furniture", "office furniture"],
  "sofas": ["couches", "sofa sets", "furniture", "lounge suite"],
  "couch": ["sofas", "couches", "sofa sets", "furniture", "lounge suite"],
  "beds": ["mattress", "bedroom furniture", "bunk beds", "furniture"],
  "mattress": ["beds", "bedroom furniture", "furniture"],
  "wardrobe": ["wardrobes", "closet", "bedroom furniture", "furniture"],
  "tables": ["dining table", "coffee table", "desk", "furniture"],
  "chairs": ["office chairs", "dining chairs", "furniture"],
  "curtains": ["blinds", "drapes", "home décor", "furniture", "home"],

  // ── PLUMBING ──────────────────────────────────────────────────────────────
  "plumber": ["plumbing", "pipes", "geyser", "water pipes", "burst pipe", "tap", "toilet", "drain"],
  "plumbing": ["plumber", "pipes", "geyser", "water pipes", "burst pipe", "tap", "toilet", "drain", "sink"],
  "geyser": ["water heater", "hot water", "plumbing", "plumber"],
  "burst pipe": ["pipe", "pipes", "plumbing", "plumber", "water leak", "leak"],
  "leak": ["water leak", "burst pipe", "plumbing", "plumber", "roof leak"],
  "tap": ["faucet", "water tap", "plumbing", "plumber"],
  "drain": ["drainage", "blocked drain", "sewage", "plumbing", "plumber"],
  "toilet": ["bathroom", "flush", "plumbing", "plumber", "drain"],
  "borehole": ["drilling", "water", "borehole drilling", "plumbing", "water supply"],

  // ── ELECTRICAL ────────────────────────────────────────────────────────────
  "electrician": ["electrical", "wiring", "power", "lights", "sockets", "DB board", "electrical fault"],
  "electrical": ["electrician", "wiring", "power", "lights", "sockets", "DB board", "electrical repair"],
  "wiring": ["electrical", "electrician", "rewiring", "cable", "power"],
  "lights": ["lighting", "electrical", "electrician", "LED", "bulbs"],
  "generator": ["genset", "power backup", "electrical", "energy"],
  "solar installation": ["solar", "solar panels", "electrical", "electrician", "energy"],

  // ── CONSTRUCTION & BUILDING ───────────────────────────────────────────────
  "construction": ["building", "contractor", "builder", "renovation", "extension", "house building", "walls", "roofing"],
  "builder": ["construction", "contractor", "building", "renovation", "house building"],
  "contractor": ["construction", "builder", "building", "renovation", "house building"],
  "renovation": ["construction", "builder", "contractor", "remodelling", "repair", "home improvement"],
  "plastering": ["plaster", "construction", "builder", "walls", "cement"],

  // ── PAINTING & DÉCOR ──────────────────────────────────────────────────────
  "painter": ["painting", "paint", "walls", "décor", "interior design", "house painting"],
  "painting": ["painter", "paint", "walls", "décor", "house painting", "interior painting"],
  "interior design": ["décor", "painting", "painter", "home improvement", "furniture"],
  "décor": ["decoration", "interior design", "painting", "home décor", "curtains"],

  // ── WELDING & FABRICATION ─────────────────────────────────────────────────
  "welder": ["welding", "fabrication", "gates", "burglar bars", "metal work", "steel work"],
  "welding": ["welder", "fabrication", "gates", "burglar bars", "metal work", "steel work"],
  "gates": ["gate", "welding", "welder", "fabrication", "burglar bars", "metal work"],
  "burglar bars": ["security bars", "welding", "welder", "fabrication", "gates"],
  "fabrication": ["welding", "welder", "metal work", "steel work", "gates"],

  // ── CLEANING SERVICES ─────────────────────────────────────────────────────
  "cleaner": ["cleaning", "house cleaning", "office cleaning", "domestic worker", "maid", "laundry"],
  "cleaning": ["cleaner", "house cleaning", "office cleaning", "domestic worker", "maid", "laundry"],
  "domestic worker": ["maid", "cleaner", "house cleaning", "cleaning", "housekeeper"],
  "maid": ["domestic worker", "cleaner", "house cleaning", "cleaning", "housekeeper"],
  "laundry": ["washing", "dry cleaning", "clothes washing", "cleaning", "cleaner"],
  "pest control": ["fumigation", "termites", "cockroaches", "rats", "cleaning", "exterminator"],
  "fumigation": ["pest control", "termites", "cockroaches", "rats", "exterminator"],

  // ── GARDENING & LANDSCAPING ───────────────────────────────────────────────
  "gardener": ["gardening", "landscaping", "lawn", "grass cutting", "tree cutting", "plants"],
  "gardening": ["gardener", "landscaping", "lawn", "grass cutting", "tree cutting", "plants"],
  "lawn": ["grass cutting", "gardening", "gardener", "landscaping"],
  "tree cutting": ["tree trimming", "gardening", "gardener", "landscaping", "tree removal"],
  "landscaping": ["gardening", "gardener", "lawn", "grass cutting", "plants", "design"],

  // ── TRANSPORT & LOGISTICS ─────────────────────────────────────────────────
  "transport": ["delivery", "courier", "car hire", "taxi", "truck hire", "logistics", "moving"],
  "delivery": ["transport", "courier", "logistics", "truck hire", "delivery service"],
  "car hire": ["vehicle hire", "car rental", "transport", "taxi", "vehicle"],
  "taxi": ["car hire", "transport", "cab", "ride", "uber"],
  "truck hire": ["truck", "lorry", "transport", "logistics", "moving", "delivery"],
  "courier": ["delivery", "transport", "logistics", "express delivery", "parcel"],
  "logistics": ["transport", "delivery", "courier", "truck hire", "supply chain"],

  // ── MOVING & REMOVALS ─────────────────────────────────────────────────────
  "moving": ["removals", "relocation", "moving company", "furniture removal", "transport"],
  "removals": ["moving", "relocation", "moving company", "furniture removal", "transport"],
  "relocation": ["moving", "removals", "moving company", "transport"],

  // ── COOKED FOOD & CATERING ────────────────────────────────────────────────
  "catering": ["food", "cooked food", "meals", "event catering", "buffet", "chef"],
  "cooked food": ["catering", "meals", "food delivery", "chef", "restaurant", "takeaway"],
  "meals": ["cooked food", "catering", "food", "takeaway", "lunch", "dinner"],
  "chef": ["catering", "cooking", "food", "cooked food", "meals"],
  "takeaway": ["cooked food", "meals", "food", "fast food", "restaurant", "catering"],
  "lunch": ["meals", "cooked food", "catering", "food", "takeaway"],
  "baking": ["cakes", "bread", "pastries", "cooked food", "catering", "food"],
  "cakes": ["baking", "pastries", "birthday cake", "catering", "cooked food", "food"],
  "birthday cake": ["cakes", "baking", "catering", "cooked food", "food"],

  // ── PRINTING & BRANDING ───────────────────────────────────────────────────
  "printing": ["branding", "flyers", "banners", "t-shirts", "business cards", "stationery", "graphic design"],
  "branding": ["printing", "logo design", "graphic design", "marketing", "flyers", "banners"],
  "flyers": ["printing", "branding", "pamphlets", "marketing", "advertising"],
  "banners": ["printing", "branding", "signage", "advertising", "marketing"],
  "t-shirt printing": ["printing", "branding", "custom t-shirts", "clothing"],
  "business cards": ["printing", "branding", "stationery", "cards"],
  "graphic design": ["design", "printing", "branding", "logo design", "artwork"],
  "logo": ["logo design", "graphic design", "branding", "printing"],
  "signage": ["signs", "banners", "printing", "branding", "advertising"],

  // ── BEAUTY & HAIR ─────────────────────────────────────────────────────────
  "hairdresser": ["hair", "hairdressing", "salon", "beauty", "braiding", "weave", "relaxer"],
  "hair": ["hairdresser", "hairdressing", "salon", "beauty", "braiding", "weave", "relaxer", "barber"],
  "salon": ["beauty", "hair", "hairdresser", "nails", "makeup", "spa"],
  "braiding": ["hair", "hairdresser", "salon", "beauty", "cornrows", "dreadlocks"],
  "barber": ["haircut", "shaving", "barbershop", "hair", "beauty"],
  "nails": ["nail technician", "manicure", "pedicure", "beauty", "salon"],
  "makeup artist": ["makeup", "beauty", "salon", "cosmetics", "photography"],
  "spa": ["massage", "beauty", "salon", "relaxation", "wellness"],
  "massage": ["spa", "massage therapist", "beauty", "wellness", "relaxation"],

  // ── PHOTOGRAPHY & VIDEOGRAPHY ─────────────────────────────────────────────
  "photographer": ["photography", "photos", "pictures", "videography", "video", "wedding photography", "events"],
  "photography": ["photographer", "photos", "pictures", "videography", "video", "events", "wedding"],
  "videography": ["videographer", "video", "photography", "photographer", "events", "wedding"],
  "wedding photography": ["photographer", "photography", "wedding", "videography", "events"],
  "events": ["photography", "photographer", "catering", "videography", "DJ", "sound"],
  "dj": ["music", "events", "sound system", "entertainment", "party"],
  "sound system": ["DJ", "music", "events", "entertainment", "sound hire"],

  // ── TUTORING & TEACHING ───────────────────────────────────────────────────
  "teacher": ["tutor", "tutoring", "teaching", "lesson", "lessons", "maths", "science", "english", "education", "school"],
  "tutor": ["teacher", "tutoring", "teaching", "lesson", "lessons", "education", "school", "maths", "science", "english"],
  "tutoring": ["tutor", "teacher", "teaching", "lesson", "lessons", "education", "school", "maths", "science", "english"],
  "lessons": ["tutoring", "tutor", "teacher", "teaching", "education", "school"],
  "maths tutor": ["maths", "mathematics", "tutoring", "tutor", "teacher", "lessons"],
  "maths": ["mathematics", "math", "tutoring", "tutor", "teacher", "lessons", "science"],
  "mathematics": ["maths", "math", "tutoring", "tutor", "teacher", "lessons"],
  "science": ["physics", "chemistry", "biology", "tutoring", "tutor", "teacher", "lessons"],
  "physics": ["science", "tutoring", "tutor", "teacher", "lessons", "maths"],
  "chemistry": ["science", "tutoring", "tutor", "teacher", "lessons"],
  "biology": ["science", "life science", "tutoring", "tutor", "teacher", "lessons"],
  "english": ["language", "tutoring", "tutor", "teacher", "lessons", "literature"],
  "a level": ["alevel", "sixth form", "tutoring", "tutor", "teacher", "lessons", "education"],
  "o level": ["olevel", "tutoring", "tutor", "teacher", "lessons", "education", "school"],
  "education": ["tutoring", "tutor", "teacher", "lessons", "school"],

  // ── IT & TECH SUPPORT ─────────────────────────────────────────────────────
  "it support": ["computer repair", "tech support", "laptop repair", "software", "networking", "it"],
  "computer repair": ["laptop repair", "it support", "tech support", "it", "electronics"],
  "laptop repair": ["computer repair", "it support", "tech support", "it", "electronics"],
  "tech support": ["it support", "computer repair", "laptop repair", "it", "software"],
  "software": ["it support", "tech support", "programming", "app development", "it"],
  "website": ["web design", "web development", "it support", "software", "it"],
  "web design": ["website", "web development", "it support", "software", "graphic design"],
  "networking": ["network", "wifi", "it support", "tech support", "it"],
  "cctv": ["security cameras", "security", "it support", "surveillance", "cameras"],

  // ── SECURITY SERVICES ─────────────────────────────────────────────────────
  "security": ["security guard", "guard", "security company", "alarm", "cctv", "surveillance"],
  "security guard": ["guard", "security", "security company", "watchman"],
  "alarm": ["alarm system", "security", "security company", "cctv", "surveillance"],

  // ── OTHER / GENERAL ───────────────────────────────────────────────────────
  "repair": ["fix", "maintenance", "service", "technician"],
  "technician": ["repair", "service", "maintenance", "it support", "electrician", "plumber"],
  "fix": ["repair", "maintenance", "service"],
  "hire": ["rent", "rental", "car hire", "truck hire", "equipment hire"],
  "rent": ["hire", "rental", "car hire", "equipment hire"],
  "mechanic": ["car repair", "vehicle", "auto", "garage", "car service"],
  "carpenter": ["woodwork", "furniture", "carpentry", "timber", "doors"],
  "tailor": ["sewing", "clothing", "alterations", "dressmaker", "fashion"],
  "driver": ["transport", "car hire", "delivery", "taxi", "chauffeur"],
};

// ── Expand a search term using the synonym map ───────────────────────────────
// Returns original term + up to 6 synonyms to keep MongoDB $or manageable
export function expandSearchTerms(product) {
  const lower = (product || "").toLowerCase().trim();
  const synonyms = SEARCH_SYNONYMS[lower];
  if (!synonyms) return [lower];
  return [lower, ...synonyms.slice(0, 6)];
}

export async function runSupplierSearch({ city, category, product, profileType }) {
  // Base query - never show suspended or inactive suppliers
  const query = {
    active: true,
    $and: [
      { $or: [{ suspended: false }, { suspended: { $exists: false } }] },
      { subscriptionStatus: "active" }
    ]
  };

  if (profileType) query.profileType = profileType;
  if (city) query["location.city"] = new RegExp(`^${city}$`, "i");
  if (category) query.categories = category;

  // Product/service free-text search - uses synonym expansion so "teacher" finds "tutoring" etc
  if (product) {
    const searchTerms = expandSearchTerms(product);

    // Search ALL fields regardless of profileType - buyer doesn't know supplier's category name
    const productOr = searchTerms.flatMap(term => [
      { products: { $regex: term, $options: "i" } },
      { "rates.service": { $regex: term, $options: "i" } },
      { categories: { $regex: term, $options: "i" } },
      { "prices.product": { $regex: term, $options: "i" } },
      { businessName: { $regex: term, $options: "i" } }
    ]);

    query.$and.push({ $or: productOr });
  }

  return SupplierProfile.find(query)
    .sort({ tierRank: -1, credibilityScore: -1, rating: -1 })
    .limit(10)
    .lean();
}

export function formatSupplierResults(suppliers, city, searchTerm) {
  if (!suppliers || !suppliers.length) return [];

  return suppliers.map((s) => {
    const badge = s.tier === "featured" ? "🔥 "
      : s.tier === "pro" ? "⭐ " : "";

   const delivery = s.profileType === "service"
  ? (s.travelAvailable ? "🚗 Mobile service" : "📍 Visit us")
  : (s.delivery?.available ? "🚚 Delivers" : "🏠 Collect");

    const min = s.minOrder > 0 ? ` · Min $${s.minOrder}` : "";
    const rating = typeof s.rating === "number" ? ` · ⭐${s.rating.toFixed(1)}` : "";

    let matchHint = "";
    if (searchTerm && s.profileType === "service" && s.rates?.length) {
      const match = s.rates.find(r =>
        r.service?.toLowerCase().includes(searchTerm.toLowerCase())
      );
      if (match) matchHint = ` · ${match.service} ${match.rate}`;
    } else if (searchTerm && s.prices?.length) {
      const match = s.prices.find(p =>
        p.product?.toLowerCase().includes(searchTerm.toLowerCase())
      );
      if (match) matchHint = ` · $${match.amount}/${match.unit}`;
    }

    return {
      id: `sup_view_${s._id}`,
      title: `${badge}${s.businessName}`,
      description: `${delivery}${min}${rating}${matchHint}`
    };
  });
}

// ── Parse shortcode search from raw text ─────────────────────────────────────
// Handles: "find cement", "find plumber harare", "s tiles", "need teacher harare"
export function parseShortcodeSearch(text = "") {
  const raw = text.trim().toLowerCase();

  const patterns = [
    /^(?:\/find|find|search|s|buy|get|looking for|need|want|seeking|i need|i want|find me|get me|where can i get|who sells|who does|do you have)\s+(.+)$/i,
  ];

  for (const p of patterns) {
    const m = raw.match(p);
    if (m) {
      const query = m[1].trim();
      return parseQueryWithCity(query);
    }
  }
  return null;
}

// ── Split "plumber harare" into { product: "plumber", city: "Harare" } ───────
function parseQueryWithCity(query = "") {
  const KNOWN_CITIES = [
    "harare", "bulawayo", "mutare", "gweru", "masvingo",
    "kwekwe", "kadoma", "chinhoyi", "victoria falls"
  ];

  const words = query.trim().split(/\s+/);
  let city = null;

  // Check if last 1 or 2 words match a known city
  for (let len = 2; len >= 1; len--) {
    const candidate = words.slice(-len).join(" ").toLowerCase();
    const matched = KNOWN_CITIES.find(c => c === candidate);
    if (matched) {
      city = matched.charAt(0).toUpperCase() + matched.slice(1);
      const product = words.slice(0, -len).join(" ").trim();
      if (product) return { product, city };
      break;
    }
  }

  return { product: query.trim(), city: null };
}