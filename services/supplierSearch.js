// services/supplierSearch.js

import SupplierProfile from "../models/supplierProfile.js";
import { sendText, sendList, sendButtons } from "./metaSender.js";
import { SUPPLIER_CITIES } from "./supplierPlans.js";

export async function startSupplierSearch(from, biz, saveBiz) {
 biz.sessionState = "supplier_search_category";
biz.sessionData = {
  supplierSearch: {}
};

// hard reset any stale buyer order/search paging state
delete biz.sessionData.orderSupplierId;
delete biz.sessionData.orderCart;
delete biz.sessionData.orderItems;
delete biz.sessionData.orderProduct;
delete biz.sessionData.orderQuantity;
delete biz.sessionData.orderIsService;
delete biz.sessionData.orderBrowseMode;
delete biz.sessionData.orderCataloguePage;
delete biz.sessionData.orderCatalogueSearch;
delete biz.sessionData.searchResults;
delete biz.sessionData.searchPage;

await saveBiz(biz);

  const { SUPPLIER_CATEGORIES } = await import("./supplierPlans.js");

   return sendList(from, "🔍 What are you looking for?", [
    ...SUPPLIER_CATEGORIES.map(c => ({
      id: `sup_search_cat_${c.id}`,
      title: c.label
    })),
    { id: "sup_search_all", title: "🔍 Search by product or service name" }
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
 "appliances": ["fridge", "stove", "microwave", "washing machine", "home appliances", "household appliances", "kitchen appliances"],
  "fridge": ["refrigerator", "freezer", "appliances", "fridge freezer"],
  "stove": ["cooker", "gas stove", "electric stove", "appliances"],
  "microwave": ["oven", "microwave oven", "appliances"],
  "washing machine": ["washer", "dryer", "laundry", "appliances"],
  "blender": ["juicer", "mixer", "kitchen appliances", "appliances"],
  "air conditioner": ["ac", "aircon", "cooling", "fan", "appliances"],
  "geyser": ["water heater", "hot water", "appliances"],

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
  "plumber": ["plumbing", "pipes", "geyser", "geyser installation", "geyser repair", "water pipes", "burst pipe", "tap", "toilet", "drain"],
  "plumbing": ["plumber", "pipes", "geyser", "geyser installation", "geyser repair", "water pipes", "burst pipe", "tap", "toilet", "drain", "sink"],
  "geyser": ["geyser installation", "geyser repair", "water heater", "hot water", "plumbing", "plumber", "thermostat replacement", "element replacement"],
  "geyser installation": ["geyser", "water heater installation", "hot water geyser", "plumbing", "plumber"],
  "geyser repair": ["geyser", "geyser fix", "no hot water", "water heater repair", "plumbing", "plumber"],
  "geyser no hot water": ["geyser repair", "geyser", "hot water", "plumbing", "plumber"],
  "hot water": ["geyser", "geyser repair", "geyser installation", "water heater", "plumbing", "plumber"],
  "thermostat": ["thermostat replacement", "geyser", "plumbing", "plumber"],
  "thermostat replacement": ["geyser", "thermostat", "plumbing", "plumber"],
  "element replacement": ["geyser", "element", "plumbing", "plumber"],
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

  // ── MEDICAL & DENTAL ──────────────────────────────────────────────────────
  "dentist": ["dental", "teeth", "teeth cleaning", "dental clinic", "check-ups", "fillings", "root canal", "oral health", "medical_health"],
  "dental": ["dentist", "teeth", "teeth cleaning", "dental clinic", "check-ups", "fillings", "root canal", "oral health", "medical_health"],
  "teeth cleaning": ["dental", "dentist", "oral health", "dental clinic", "medical_health"],
  "teeth": ["dental", "dentist", "teeth cleaning", "oral health", "medical_health"],
  "doctor": ["clinic", "medical", "health", "gp", "general practitioner", "medical_health"],
  "clinic": ["doctor", "medical", "health", "hospital", "medical_health"],
  "medical": ["doctor", "clinic", "health", "hospital", "medical_health", "pharmacy"],
  "pharmacy": ["chemist", "medicine", "drugs", "medical", "health", "medical_health"],
};

// ── Expand a search term using the synonym map ───────────────────────────────
// Returns original term + up to 6 synonyms to keep MongoDB $or manageable
export function expandSearchTerms(product) {
  const lower = (product || "").toLowerCase().trim();
  if (!lower) return [];

  // Category ID slugs (e.g. "medical_health") are not text fields in the DB -
  // strip them from synonyms so they don't pollute regex searches
  const isCategorySlug = s => /^[a-z]+_[a-z_]+$/.test(s);

  // Exact match in synonym map
  if (SEARCH_SYNONYMS[lower]) {
    const synonyms = SEARCH_SYNONYMS[lower]
      .filter(s => !isCategorySlug(s))  // drop "medical_health" etc
      .slice(0, 6);
    return [lower, ...synonyms];
  }

  // Partial match: keys that start with OR contain the search term
  const partialMatches = Object.keys(SEARCH_SYNONYMS)
    .filter(key => key.startsWith(lower) || (lower.length >= 4 && key.includes(lower)))
    .slice(0, 3);

  if (partialMatches.length) {
    const extraSynonyms = partialMatches
      .flatMap(k => SEARCH_SYNONYMS[k])
      .filter(s => !isCategorySlug(s))
      .slice(0, 6);
    return [lower, ...partialMatches, ...extraSynonyms];
  }

  return [lower];
}


// ── Helper: infer category slugs from a search term ─────────────────────────
// Lets "geyser installation" match suppliers with categories:["plumbing"] etc.
function _inferCategoriesFromSearch(product, expandedTerms) {
  const SERVICE_TERM_TO_CATEGORY = {
    "plumb": "plumbing", "geyser": "plumbing", "pipe": "plumbing", "drain": "plumbing",
    "tap": "plumbing", "toilet": "plumbing", "borehole": "plumbing", "leak": "plumbing",
    "thermostat": "plumbing", "element replace": "plumbing", "hot water": "plumbing",
    "water heater": "plumbing", "burst": "plumbing", "fitting": "plumbing",
    "electric": "electrical", "wiring": "electrical", "socket": "electrical", "lights": "electrical",
    "generator": "electrical", "solar": "electrical",
    "build": "construction", "construct": "construction", "renovat": "construction",
    "plaster": "construction", "brick": "construction", "roof": "construction",
    "paint": "painting", "painter": "painting",
    "weld": "welding", "gate": "welding", "fabricat": "welding",
    "clean": "cleaning", "maid": "cleaning", "laundry": "cleaning", "pest": "cleaning",
    "garden": "gardening", "lawn": "gardening", "landscap": "gardening",
    "tutor": "education", "teach": "education", "lesson": "education", "maths": "education",
    "hair": "beauty", "salon": "beauty", "nail": "beauty", "makeup": "beauty", "barber": "beauty",
    "photo": "photography", "video": "photography",
    "cater": "catering", "chef": "catering", "cake": "catering",
    "print": "printing", "brand": "printing", "design": "printing",
    "security": "security", "guard": "security",
    "account": "accounting", "tax": "accounting", "audit": "accounting",
    "legal": "legal", "lawyer": "legal", "attorney": "legal",
    "transport": "transport", "deliver": "transport", "courier": "transport", "truck": "transport",
    "it support": "it", "computer repair": "it", "tech": "it",
    "mechanic": "automotive", "panel beat": "automotive", "tyre": "automotive",
  };
  const cats = new Set();
  const allTerms = [product, ...(expandedTerms || [])];
  for (const term of allTerms) {
    const t = (term || "").toLowerCase();
    for (const [keyword, cat] of Object.entries(SERVICE_TERM_TO_CATEGORY)) {
      if (t.includes(keyword)) cats.add(cat);
    }
  }
  return [...cats];
}


// ─────────────────────────────────────────────────────────────────────────────
// EXPORTED: Score how well a supplier matches a requested product/service term.
// Returns a score 0-100. Higher = stronger match.
//
// Tiers (highest to lowest):
//   50  — exact match in rates.service  (service supplier has this exact rate)
//   45  — exact match in listedProducts / products
//   30  — partial match in rates.service
//   25  — partial match in listedProducts / products
//   15  — match via businessName
//    5  — match only via category tag (broad — lowest confidence)
// ─────────────────────────────────────────────────────────────────────────────
export function scoreSupplierMatch(supplier, searchTerm) {
  if (!supplier || !searchTerm) return 0;

  const term    = normalizeProductName(searchTerm);
  const terms   = expandSearchTerms(term);           // term + synonyms
  const allTerms = [term, ...terms];

  function _norm(s) { return normalizeProductName(s || ""); }

  // ── rates.service (service suppliers) ───────────────────────────────────
  for (const rate of (supplier.rates || [])) {
    const svc = _norm(rate.service);
    if (!svc) continue;
    if (svc === term)           return 50;   // exact
    if (svc.includes(term) || term.includes(svc)) return 30;  // partial
    for (const t of allTerms) {
      if (t && (svc === t || svc.includes(t) || t.includes(svc))) return 28;
    }
  }

  // ── listedProducts / products ────────────────────────────────────────────
  const listedBlob = _splitServiceBlobPublic(supplier.listedProducts);
  const prodBlob   = _splitServiceBlobPublic(supplier.products);
  const allProds   = [...listedBlob, ...prodBlob];

  for (const p of allProds) {
    const pn = _norm(p);
    if (!pn) continue;
    if (pn === term)                                return 45;  // exact
    if (pn.includes(term) || term.includes(pn))    return 25;  // partial
    for (const t of allTerms) {
      if (t && (pn.includes(t) || t.includes(pn))) return 22;
    }
  }

  // ── businessName ─────────────────────────────────────────────────────────
  const bname = _norm(supplier.businessName);
  if (bname && (bname.includes(term) || term.includes(bname))) return 15;
  for (const t of allTerms) {
    if (t && bname && bname.includes(t)) return 12;
  }

  // ── category tag only (broad match) ──────────────────────────────────────
  const cats = (supplier.categories || []).map(c => (c || "").toLowerCase());
  const inferredCats = _inferCategoriesFromSearch(term, terms);
  if (inferredCats.some(cat => cats.includes(cat))) return 5;

  return 0;
}

// Internal helper exposed for scoreSupplierMatch — splits blob arrays
function _splitServiceBlobPublic(arr) {
  return (arr || []).flatMap(p => {
    if (!p || p === "pending_upload") return [];
    return String(p).split(/[\r\n,]+/).map(s => s.trim()).filter(Boolean);
  });
}

export async function runSupplierSearch({ city, category, product, profileType, area }) {
  const _stack = new Error().stack.split('').slice(1,4).join(' | ');
  console.log(`[TRACE-RS] runSupplierSearch called: product="${product}" city="${city}" area="${area}" | CALLER: ${_stack}`);
  const query = {
    active: true,
    $and: [
      { $or: [{ suspended: false }, { suspended: { $exists: false } }] },
      { $or: [{ subscriptionStatus: "active" }, { subscriptionStatus: "trial" }] }
    ]
  };

  if (profileType) query.profileType = profileType;
  if (city) query["location.city"] = new RegExp(`^${city}$`, "i");
  if (category) query.categories = category;

  if (product) {
    product = String(product)
      .toLowerCase()
      .trim()
      .replace(/\s+/g, " ");

    const searchTerms = expandSearchTerms(product);

    const individualWords = product.split(/\s+/).filter(w => w.length > 2);

    // Escape special regex chars so e.g. "geyser (install)" won't crash
    function _safeRx(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

    // Infer category slugs from the search term (e.g. "geyser installation" → "plumbing")
    const _inferredCats = _inferCategoriesFromSearch(product, searchTerms);

    const productOr = [
      { listedProducts:  { $regex: _safeRx(product), $options: "i" } },
      { products:        { $regex: _safeRx(product), $options: "i" } },
      { "rates.service": { $regex: _safeRx(product), $options: "i" } },
      { categories:      { $regex: _safeRx(product), $options: "i" } },
      { businessName:    { $regex: _safeRx(product), $options: "i" } },

      // Category-based match: "geyser installation" → categories: "plumbing"
      ..._inferredCats.map(cat => ({ categories: cat })),

      ...searchTerms.flatMap(term => [
        { listedProducts:  { $regex: _safeRx(term), $options: "i" } },
        { products:        { $regex: _safeRx(term), $options: "i" } },
        { "rates.service": { $regex: _safeRx(term), $options: "i" } },
        { categories:      { $regex: _safeRx(term), $options: "i" } },
        { businessName:    { $regex: _safeRx(term), $options: "i" } }
      ]),

      ...individualWords.flatMap(word => [
        { listedProducts:  { $regex: _safeRx(word), $options: "i" } },
        { products:        { $regex: _safeRx(word), $options: "i" } },
        { "rates.service": { $regex: _safeRx(word), $options: "i" } },
        { categories:      { $regex: _safeRx(word), $options: "i" } }
      ])
    ];

    query.$and.push({ $or: productOr });
  }

let results = await SupplierProfile.find(query)
    .sort({ tierRank: -1, credibilityScore: -1, rating: -1 })
    .limit(50)
    .lean();

  // If city was specified but returned 0 results, try without city restriction
  // so "valve brass harare" still finds results even if supplier is listed under
  // a different city spelling or area
  if (city && results.length === 0) {
    const relaxedQuery = { ...query };
    delete relaxedQuery["location.city"];
    results = await SupplierProfile.find(relaxedQuery)
      .sort({ tierRank: -1, credibilityScore: -1, rating: -1 })
      .limit(50)
      .lean();
  }

  // For service suppliers: if still 0 results with profileType filter, also try
  // without profileType restriction (catches suppliers whose profileType may be
  // stored differently or missing) — filter by category inferences instead
  if (profileType === "service" && results.length === 0) {
    const serviceRelaxedQuery = { ...query };
    delete serviceRelaxedQuery.profileType;
    delete serviceRelaxedQuery["location.city"];
    results = await SupplierProfile.find(serviceRelaxedQuery)
      .sort({ tierRank: -1, credibilityScore: -1, rating: -1 })
      .limit(50)
      .lean();
    // Keep only service-type suppliers from this fallback
    results = results.filter(s => s.profileType === "service");
  }

// AFTER:
const preFilterCount = results.length;

// Helper: split a potentially newline-joined blob into individual service names
function _splitServiceBlob(arr) {
  return (arr || []).flatMap(p => {
    if (!p || p === "pending_upload") return [];
    return String(p).split(/[\r\n,]+/).map(s => s.trim()).filter(s => s && s !== "pending_upload");
  });
}

results = results.filter((supplier) => {
  if (supplier?.profileType === "service") {
    const hasRates = (supplier.rates || []).some(r => normalizeProductName(r?.service || ""));
    const listedParts = _splitServiceBlob(supplier.listedProducts);
    const productParts = _splitServiceBlob(supplier.products);
    const hasListedProducts = listedParts.some(p => normalizeProductName(p));
    const hasProducts = productParts.some(p => normalizeProductName(p));
    const passes = hasRates || hasListedProducts || hasProducts;
    if (!passes) console.log(`[TRACE-FILTER] REMOVED service supplier: ${supplier.businessName} rates=${hasRates} listed=${hasListedProducts} products=${hasProducts}`);
    return passes;
  }
const hasListedProducts = (supplier.listedProducts || []).some(
  p => p && p !== "pending_upload" && normalizeProductName(p)
);
const hasProducts = (supplier.products || []).some(
  p => p && p !== "pending_upload" && normalizeProductName(p)
);

// Keep this aligned with offer-building fallback:
// if listedProducts exists use it, otherwise allow products[].
const passes = hasListedProducts || hasProducts;
  if (!passes) console.log(`[TRACE-FILTER] REMOVED product supplier: ${supplier.businessName} listed=${hasListedProducts} products=${hasProducts}`);
  return passes;
});
console.log(`[TRACE-FILTER] before filter: ${preFilterCount}, after filter: ${results.length}`);

  if (area && results.length > 1) {
    const areaLower = area.toLowerCase();
    results.sort((a, b) => {
      const aInArea = (a.location?.area || "").toLowerCase().includes(areaLower) ? 0 : 1;
      const bInArea = (b.location?.area || "").toLowerCase().includes(areaLower) ? 0 : 1;
      if (aInArea !== bInArea) return aInArea - bInArea;
      return (b.tierRank || 0) - (a.tierRank || 0);
    });
  }

  console.log(`[TRACE-RS-RESULT] returning ${results.length} suppliers: ${results.map(s => s.businessName + '|rates:' + (s.rates||[]).length + '|products:' + JSON.stringify(s.products||[]) + '|listed:' + JSON.stringify(s.listedProducts||[])).join(' || ')}`);
  return results.slice(0, 20);
}






function normalizeProductName(value = "") {
  return String(value || "")
    .toLowerCase()
    .trim()
    .replace(/[^\w\s]/g, "")
    .replace(/\s+/g, " ");
}



function tokenizeProductName(value = "") {
  return normalizeProductName(value)
    .split(" ")
    .map(s => s.trim())
    .filter(Boolean);
}

function getExpandedSearchTerms(searchTerm = "") {
  const base = normalizeProductName(searchTerm);
  if (!base) return [];

  const expanded = new Set([base]);

  for (const [key, values] of Object.entries(SEARCH_SYNONYMS || {})) {
    const normKey = normalizeProductName(key);
    const normValues = (values || []).map(v => normalizeProductName(v));

    if (base === normKey || normValues.includes(base) || base.includes(normKey) || normKey.includes(base)) {
      expanded.add(normKey);
      normValues.forEach(v => expanded.add(v));
    }
  }

  return [...expanded].filter(Boolean);
}

function scoreProductMatch(productName = "", searchTerm = "") {
  const productNorm = normalizeProductName(productName);
  const searchNorm = normalizeProductName(searchTerm);

  if (!productNorm || !searchNorm) return 0;

  if (productNorm === searchNorm) return 100;

  const expandedTerms = getExpandedSearchTerms(searchNorm);
  const productTokens = tokenizeProductName(productNorm);
  const scores = [];

  for (const term of expandedTerms) {
    const termTokens = tokenizeProductName(term);
    if (!termTokens.length) continue;

    let score = 0;

    if (productNorm.includes(term) || term.includes(productNorm)) {
      score += 40;
    }

    const overlap = termTokens.filter(t => productTokens.includes(t)).length;
    if (overlap) {
      score += Math.round((overlap / Math.max(termTokens.length, productTokens.length)) * 50);
    }

    if (productTokens[0] && termTokens[0] && productTokens[0] === termTokens[0]) {
      score += 10;
    }

    scores.push(score);
  }

  return scores.length ? Math.max(...scores) : 0;
}

function productMatchesSearch(productName = "", searchTerm = "") {
  return scoreProductMatch(productName, searchTerm) >= 45;
}
function buildProductSearchOffersFromSupplier(supplier, searchTerm = "") {
  const offers = [];
  const seen = new Set();

  if (!supplier) return offers;

  // ── SERVICE SUPPLIERS ──────────────────────────────────────────────────
  if (supplier.profileType === "service") {

    // 1. Use rates[] if the supplier has set prices
    for (const rate of (supplier.rates || [])) {
      const serviceName = String(rate?.service || "").trim();
      const rawRate = String(rate?.rate || "").trim();
      if (!serviceName || !normalizeProductName(serviceName)) continue;

      const amountMatch = rawRate.match(/^\$?\s*(\d+(?:\.\d+)?)/);
      const amount = amountMatch ? Number(amountMatch[1]) : null;
      const unit = rawRate.includes("/") ? rawRate.split("/")[1].trim() || "job" : "job";

      const dedupeKey = `${supplier._id}:${normalizeProductName(serviceName)}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      offers.push({
        supplierId: String(supplier._id),
        supplierName: supplier.businessName || "Supplier",
        supplierPhone: supplier.phone || "",
        supplierLocation: `${supplier.location?.area || ""}, ${supplier.location?.city || ""}`.replace(/^,\s*|,\s*$/g, ""),
        supplierArea: supplier.location?.area || "",
        supplierCity: supplier.location?.city || "",
        supplierTier: supplier.tier || "",
        supplierRating: typeof supplier.rating === "number" ? supplier.rating : 0,
        profileType: "service",
        deliveryText: supplier.travelAvailable ? "🚗 Mobile service" : "📍 Visit provider",
        product: serviceName,
        pricePerUnit: typeof amount === "number" && !Number.isNaN(amount) ? amount : null,
        unit,
        matchSource: "rates"
      });
    }

    // 2. No rates set yet - show all items from products[] and listedProducts[],
    //    sorted so matching items appear first.
    //    runSupplierSearch already confirmed this supplier matches the query,
    //    so we show their full offering so buyers can compare and see everything.
     // 2. No rates set yet - only return matching items from products[] / listedProducts[].
    // Do NOT expand to the full service catalogue in buyer search results.
    if (offers.length === 0) {
      const visibleSourceItems = (supplier.listedProducts || []).length
        ? (supplier.listedProducts || [])
        : (supplier.products || []);

      const normalizedSearch = normalizeProductName(searchTerm || "");
      const exactMatches = [];
      const partialMatches = [];

      for (const serviceNameRaw of visibleSourceItems) {
        const serviceName = String(serviceNameRaw || "").trim();
        const normalizedServiceName = normalizeProductName(serviceName);

        if (!serviceName || !normalizedServiceName) continue;
        if (serviceName === "pending_upload") continue;

        const dedupeKey = `${supplier._id}:${normalizedServiceName}`;
        if (seen.has(dedupeKey)) continue;

        if (normalizedSearch && normalizedServiceName === normalizedSearch) {
          exactMatches.push(serviceName);
          continue;
        }

        if (productMatchesSearch(serviceName, searchTerm)) {
          partialMatches.push(serviceName);
        }
      }

      const matchedServices = exactMatches.length ? exactMatches : partialMatches;

      for (const serviceName of matchedServices) {
        const normalizedServiceName = normalizeProductName(serviceName);
        const dedupeKey = `${supplier._id}:${normalizedServiceName}`;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);

        offers.push({
          supplierId: String(supplier._id),
          supplierName: supplier.businessName || "Supplier",
          supplierPhone: supplier.phone || "",
          supplierLocation: `${supplier.location?.area || ""}, ${supplier.location?.city || ""}`.replace(/^,\s*|,\s*$/g, ""),
          supplierArea: supplier.location?.area || "",
          supplierCity: supplier.location?.city || "",
          supplierTier: supplier.tier || "",
          supplierRating: typeof supplier.rating === "number" ? supplier.rating : 0,
          profileType: "service",
          deliveryText: supplier.travelAvailable ? "🚗 Mobile service" : "📍 Visit provider",
          product: serviceName,
          pricePerUnit: null,
          unit: "job",
          matchSource: (supplier.listedProducts || []).length ? "listedProducts" : "products"
        });
      }
    }

    return offers;
  }

  // ── PRODUCT SUPPLIERS ──────────────────────────────────────────────────
   // STRICT buyer visibility:
  // use listedProducts when present,
  // but if listedProducts is still empty for an active supplier,
  // temporarily fall back to products[] so search does not go blank.
  const visibleSourceItems = (supplier.listedProducts || []).some(
    p => p && p !== "pending_upload" && normalizeProductName(p)
  )
    ? (supplier.listedProducts || [])
    : (supplier.products || []);

  const allowedNames = new Set(
    visibleSourceItems
      .filter(p => p && p !== "pending_upload")
      .map(p => normalizeProductName(p))
      .filter(Boolean)
  );

  for (const price of (supplier.prices || [])) {
    const normalizedPriceProduct = normalizeProductName(price?.product || "");
    if (!normalizedPriceProduct) continue;
    if (price?.inStock === false) continue;
    if (!allowedNames.has(normalizedPriceProduct)) continue;
    if (!productMatchesSearch(price?.product || "", searchTerm)) continue;
    const dedupeKey = `${supplier._id}:${normalizedPriceProduct}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    offers.push({
      supplierId: String(supplier._id),
      supplierName: supplier.businessName || "Supplier",
      supplierPhone: supplier.phone || "",
      supplierLocation: `${supplier.location?.area || ""}, ${supplier.location?.city || ""}`.replace(/^,\s*|,\s*$/g, ""),
      supplierArea: supplier.location?.area || "",
      supplierCity: supplier.location?.city || "",
      supplierTier: supplier.tier || "",
      supplierRating: typeof supplier.rating === "number" ? supplier.rating : 0,
      profileType: "product",
      deliveryText: supplier.delivery?.available ? "🚚 Delivery available" : "🏠 Collection only",
      product: price?.product || "",
      pricePerUnit: typeof price?.amount === "number" ? Number(price.amount) : null,
      unit: price?.unit || "each",
      matchSource: "prices"
    });
  }

  for (const product of visibleSourceItems) {
    const normalizedVisibleProduct = normalizeProductName(product);
    if (!normalizedVisibleProduct) continue;
    if (product === "pending_upload") continue;
    if (!productMatchesSearch(product, searchTerm)) continue;

    const dedupeKey = `${supplier._id}:${normalizedVisibleProduct}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    offers.push({
      supplierId: String(supplier._id),
      supplierName: supplier.businessName || "Supplier",
      supplierPhone: supplier.phone || "",
      supplierLocation: `${supplier.location?.area || ""}, ${supplier.location?.city || ""}`.replace(/^,\s*|,\s*$/g, ""),
      supplierArea: supplier.location?.area || "",
      supplierCity: supplier.location?.city || "",
      supplierTier: supplier.tier || "",
      supplierRating: typeof supplier.rating === "number" ? supplier.rating : 0,
      profileType: "product",
      deliveryText: supplier.delivery?.available ? "🚚 Delivery available" : "🏠 Collection only",
      product,
      pricePerUnit: null,
      unit: "each",
      matchSource: (supplier.listedProducts || []).length ? "listedProducts" : "products"
    });
  }
  return offers;
}

export async function runSupplierOfferSearch({ city, category, product, profileType, area }) {
  const suppliers = await runSupplierSearch({ city, category, product, profileType, area });

  console.log(`[OFFER SEARCH] product="${product}" city="${city}" area="${area}" → ${suppliers.length} suppliers found`);
  suppliers.forEach(s => {
    console.log(`  supplier: ${s.businessName} | profileType: ${s.profileType} | rates: ${s.rates?.length || 0} | products: ${JSON.stringify(s.products || [])} | listedProducts: ${JSON.stringify(s.listedProducts || [])}`);
  });

  const offers = suppliers.flatMap(supplier => {
    const built = buildProductSearchOffersFromSupplier(supplier, product || category || "");
    console.log(`  → built ${built.length} offers from ${supplier.businessName}`);
    return built.map((offer, idx) => ({
        ...offer,
        sortTierRank: typeof supplier.tierRank === "number" ? supplier.tierRank : 0,
        sortCredibility: typeof supplier.credibilityScore === "number" ? supplier.credibilityScore : 0,
        sortPosition: idx
      }));
  });

  offers.sort((a, b) => {
    const aHasPrice = a.pricePerUnit !== null ? 0 : 1;
    const bHasPrice = b.pricePerUnit !== null ? 0 : 1;
    if (aHasPrice !== bHasPrice) return aHasPrice - bHasPrice;

    if (b.sortTierRank !== a.sortTierRank) return b.sortTierRank - a.sortTierRank;
    if (b.sortCredibility !== a.sortCredibility) return b.sortCredibility - a.sortCredibility;
    if (b.supplierRating !== a.supplierRating) return b.supplierRating - a.supplierRating;

    return a.product.localeCompare(b.product);
  });

  return offers.slice(0, 50);
}

export function formatSupplierOfferResults(offers = [], searchTerm = "") {
  return offers.map((offer) => {
    const priceText =
      offer.pricePerUnit !== null
        ? `$${Number(offer.pricePerUnit).toFixed(2)}/${offer.unit || "each"}`
        : "Price on request";

    const locationText = [offer.supplierArea, offer.supplierCity].filter(Boolean).join(", ");
    const desc = [
      locationText ? `📍 ${locationText}` : "",
      offer.deliveryText || ""
    ].filter(Boolean).join(" · ");

    return {
      id: `sup_offer_pick_${offer.supplierId}_${encodeURIComponent(offer.product)}`,
      title: offer.product.slice(0, 72),
      description: `${priceText} · 🏪 ${offer.supplierName} · ${desc}`.slice(0, 72)
    };
  });
}


export function formatSupplierResults(suppliers, city, searchTerm) {
  if (!suppliers || !suppliers.length) return [];

  const normalizedSearchTerm = normalizeProductName(searchTerm || "");

  return suppliers.map((s) => {
    const badge = s.tier === "featured" ? "🔥 "
      : s.tier === "pro" ? "⭐ " : "";

   const delivery = s.profileType === "service"
  ? (s.travelAvailable ? "🚗 Mobile service" : "📍 Visit us")
  : (s.delivery?.available ? "🚚 Delivers" : "🏠 Collect");

    const min = s.minOrder > 0 ? ` · Min $${s.minOrder}` : "";
    const rating = typeof s.rating === "number" ? ` · ⭐${s.rating.toFixed(1)}` : "";

let matchHint = "";
if (normalizedSearchTerm && s.profileType === "service" && s.rates?.length) {
  const match = s.rates.find(r => {
    const serviceName = normalizeProductName(r?.service || "");
    return serviceName && (serviceName.includes(normalizedSearchTerm) || normalizedSearchTerm.includes(serviceName));
  });
  if (match) matchHint = ` · ${match.service} ${match.rate}`;
} else if (normalizedSearchTerm && s.profileType === "service" && !s.rates?.length) {
  // No rates yet - show a matching product/service name as the hint
  const allItems = [...(s.listedProducts || []), ...(s.products || [])];
  const matchedItem = allItems.find(p => {
    const norm = normalizeProductName(p || "");
    return norm && (norm.includes(normalizedSearchTerm) || normalizedSearchTerm.includes(norm));
  });
  if (matchedItem) matchHint = ` · ${matchedItem}`;
  else matchHint = ` · ${allItems[0] || ""}`.trimEnd();
} else if (normalizedSearchTerm) {
      // Allow prices from listedProducts OR products[] (for suppliers without a listed cap)
      const allowedNames = new Set(
        [...(s.listedProducts || []), ...(s.products || [])]
          .map(p => normalizeProductName(p))
          .filter(Boolean)
      );

      const match = (s.prices || []).find(p => {
        const productName = normalizeProductName(p?.product || "");
        return productName &&
          p?.inStock !== false &&
          allowedNames.has(productName) &&
          (productName.includes(normalizedSearchTerm) || normalizedSearchTerm.includes(productName));
      });

      if (match) matchHint = ` · $${match.amount}/${match.unit}`;
    }
  const contactHint = s.contactDetails ? ` • 📞 ${String(s.contactDetails).slice(0, 28)}` : "";
const websiteHint = s.website ? ` • 🌐 ${String(s.website).slice(0, 28)}` : "";

return {
  id: `sup_shop_${s._id}`,
  title: `${badge}${s.businessName}`,
  description: `${delivery}${min}${rating}${matchHint}${contactHint}${websiteHint}`
};
  });
}

// ── Suburb → City mapping ─────────────────────────────────────────────────
const SUBURB_TO_CITY = {
  // Harare suburbs
  "avondale": "Harare",
  "borrowdale": "Harare",
  "malbereign": "Harare",
  "malborough": "Harare",
  "marlborough": "Harare",
  "mabelreign": "Harare",
  "mbare": "Harare",
  "highfield": "Harare",
  "glen view": "Harare",
  "glenview": "Harare",
  "budiriro": "Harare",
  "cbd":"Harare",
  "kuwadzana": "Harare",
  "dzivarasekwa": "Harare",
 "dzivarasekwa extension": "Harare",
  "hatfield": "Harare",
  "greendale": "Harare",
  "msasa": "Harare",
  "eastlea": "Harare",
  "waterfalls": "Harare",
  "glen norah": "Harare",
  "glennorah": "Harare",
  "mufakose": "Harare",
  "chitungwiza": "Harare",
  "ruwa": "Harare",
  "epworth": "Harare",
  "tafara": "Harare",
  "mabvuku": "Harare",
  "highlands": "Harare",
  "mount pleasant": "Harare",
  "belgravia": "Harare",
  "milton park": "Harare",
  "milton": "Harare",
  "newlands": "Harare",
  "chisipite": "Harare",
  "gunhill": "Harare",
  "greencroft": "Harare",
  "greystone": "Harare",
  "strathaven": "Harare",
  "alexandra park": "Harare",
  "alex park": "Harare",
  "braeside": "Harare",
  "arcadia": "Harare",
  "southerton": "Harare",
  "workington": "Harare",
  "willowvale": "Harare",
  "graniteside": "Harare",
  "industrial": "Harare",
  "seke": "Harare",
  "norton": "Harare",
  "dzivaresekwa": "Harare",
  "kambuzuma": "Harare",
  "warren park": "Harare",
  "warren": "Harare",

  // - suburbs
  "nkulumane": "Bulawayo",
  "luveve": "Bulawayo",
  "entumbane": "Bulawayo",
  "njube": "Bulawayo",
  "mpopoma": "Bulawayo",
  "lobengula": "Bulawayo",
  "makokoba": "Bulawayo",
  "tshabalala": "Bulawayo",
  "pelandaba": "Bulawayo",
  "mabutweni": "Bulawayo",
  "emakhandeni": "Bulawayo",
  "pumula": "Bulawayo",
  "iminyela": "Bulawayo",
  "cowdray park": "Bulawayo",
  "cowdray": "Bulawayo",
  "magwegwe": "Bulawayo",
  "mahatshula":"Bulawayo",
  "selbourne": "Bulawayo",
  "hillside": "Bulawayo",
  "suburbs": "Bulawayo",
  "white city": "Bulawayo",

  // Mutare suburbs
  "sakubva": "Mutare",
  "dangamvura": "Mutare",
  "chikanga": "Mutare",
  "hobhouse": "Mutare",
  "paulington": "Mutare",
  "tiger's kloof": "Mutare",

  // Gweru suburbs
  "mambo": "Gweru",
  "mkoba": "Gweru",
  "senga": "Gweru",
  "ascot": "Gweru",

  // Masvingo suburbs
  "mucheke": "Masvingo",
  "rujeko": "Masvingo",
  "eastvale": "Masvingo",

  // Kwekwe suburbs  
  "mbizo": "Kwekwe",
  "amaveni": "Kwekwe",
  "oh well": "Kwekwe",

  // Chinhoyi suburbs
  "chinhoyi heights": "Chinhoyi",
  "mhangura": "Chinhoyi",

  //Murehwa suburbs
  "macheke": "Murehwa",
};

function normalizeLocationPart(value = "") {
  return String(value || "")
    .toLowerCase()
    .trim()
    .replace(/[^\w\s]/g, "")
    .replace(/\s+/g, " ");
}

function toTitleCase(value = "") {
  return String(value || "")
    .split(" ")
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

// ── Parse shortcode search from raw text ─────────────────────────────────────
// Handles: "find cement", "find plumber harare", "find cement mbare" etc.
// Lives here - AFTER SUBURB_TO_CITY (const) and toTitleCase so both are defined.
// ── Parse shortcode search from raw text ─────────────────────────────────────
// Handles: "find cement", "find plumber harare", "find cement mbare",
//          "find dentist avondale", "find cleaner borrowdale harare",
//          "find electrician mbare harare"
// Scans ALL word-window positions so city/suburb can appear anywhere in the
// phrase. Both city and suburb can be present simultaneously.
export function parseShortcodeSearch(input = "") {
  const _SUBURBS = {"avondale":"Harare","borrowdale":"Harare","cbd":"Harare","mbare":"Harare","highfield":"Harare","hatfield":"Harare","greendale":"Harare","greencroft":"Harare","msasa":"Harare","eastlea":"Harare","waterfalls":"Harare","mufakose":"Harare","chitungwiza":"Harare","ruwa":"Harare","epworth":"Harare","tafara":"Harare","mabvuku":"Harare","highlands":"Harare","mount pleasant":"Harare","belgravia":"Harare","milton park":"Harare","newlands":"Harare","chisipite":"Harare","gunhill":"Harare","greystone":"Harare","strathaven":"Harare","braeside":"Harare","arcadia":"Harare","southerton":"Harare","workington":"Harare","willowvale":"Harare","graniteside":"Harare","seke":"Harare","norton":"Harare","kambuzuma":"Harare","warren park":"Harare","glen view":"Harare","glenview":"Harare","budiriro":"Harare","kuwadzana":"Harare","dzivarasekwa":"Harare","malbelreign":"Harare","mabelreign":"Harare","malborough":"Harare","marlborough":"Harare","glen norah":"Harare","glennorah":"Harare","nkulumane":"Bulawayo","luveve":"Bulawayo","entumbane":"Bulawayo","njube":"Bulawayo","mpopoma":"Bulawayo","lobengula":"Bulawayo","makokoba":"Bulawayo","tshabalala":"Bulawayo","pumula":"Bulawayo","cowdray park":"Bulawayo","magwegwe":"Bulawayo","hillside":"Bulawayo","white city":"Bulawayo","sakubva":"Mutare","dangamvura":"Mutare","chikanga":"Mutare","mambo":"Gweru","mkoba":"Gweru","senga":"Gweru","ascot":"Gweru","mucheke":"Masvingo","rujeko":"Masvingo","mbizo":"Kwekwe","amaveni":"Kwekwe", "macheke":"Murehwa"};
  const _CITIES = ["harare","bulawayo","mutare","gweru","masvingo","kwekwe","kadoma","chinhoyi","victoria falls","murehwa"];

  const raw = String(input || "").toLowerCase().trim()
    .replace(/^find\s+/i, "").replace(/^search\s+/i, "").replace(/^s\s+/i, "").replace(/\s+/g, " ");
  if (!raw) return null;

  function _tc(v) { return String(v||"").split(" ").filter(Boolean).map(p=>p[0].toUpperCase()+p.slice(1)).join(" "); }

  const words = raw.split(" ").filter(Boolean);
  if (!words.length) return null;

  let city=null, area=null, cityIdx=-1, cityLen=0, areaIdx=-1, areaLen=0;

  // Pass 1: find city name at ANY position in phrase
  outer1: for (let len=Math.min(2,words.length); len>=1; len--) {
    for (let i=0; i<=words.length-len; i++) {
      const c = words.slice(i,i+len).join(" ");
      if (_CITIES.includes(c)) { city=_tc(c); cityIdx=i; cityLen=len; break outer1; }
    }
  }

  // Pass 2: find suburb at ANY position in phrase
  outer2: for (let len=Math.min(3,words.length); len>=1; len--) {
    for (let i=0; i<=words.length-len; i++) {
      if (i===cityIdx && len===cityLen) continue;
      const c = words.slice(i,i+len).join(" ");
      if (_SUBURBS[c]) { area=_tc(c); areaIdx=i; areaLen=len; if(!city) city=_SUBURBS[c]; break outer2; }
    }
  }

  // Strip city+suburb words to get the product term
  const remove = [];
  if (cityIdx>=0) remove.push([cityIdx, cityIdx+cityLen]);
  if (areaIdx>=0) remove.push([areaIdx, areaIdx+areaLen]);
  remove.sort((a,b)=>a[0]-b[0]);
  const productWords = words.filter((_,i) => !remove.some(([s,e])=>i>=s&&i<e));
  const product = productWords.join(" ").trim();

  return { product: product||raw, city, area };
}
function parseQueryWithCity(query = "") {
  const KNOWN_CITIES = [
    "harare", "-", "mutare", "gweru", "masvingo",
    "kwekwe", "kadoma", "chinhoyi", "victoria falls"
  ];

  const normalizedQuery = normalizeLocationPart(query);
  const words = normalizedQuery.split(/\s+/).filter(Boolean);
  let city = null;
  let area = null;
  let productWords = words;

  // ── Step 1: Check last 2 → 1 words for a known CITY ──────────────────────
  for (let len = Math.min(2, words.length); len >= 1; len--) {
    const candidate = words.slice(-len).join(" ");
    const matched = KNOWN_CITIES.find(c => c === candidate);
    if (matched) {
      city = toTitleCase(matched);
      productWords = words.slice(0, -len);
      if (productWords.length) {
        return {
          product: productWords.join(" ").trim(),
          city,
          area: null
        };
      }
      break;
    }
  }

  // ── Step 2: Check last 3 → 1 words for a known SUBURB/AREA ───────────────
  for (let len = Math.min(3, words.length); len >= 1; len--) {
    const candidate = words.slice(-len).join(" ");
    const mappedCity = SUBURB_TO_CITY[candidate];
    if (mappedCity) {
      city = mappedCity;
      area = toTitleCase(candidate);
      productWords = words.slice(0, -len);
      if (productWords.length) {
        return {
          product: productWords.join(" ").trim(),
          city,
          area
        };
      }
      break;
    }
  }

  return {
    product: normalizedQuery,
    city: null,
    area: null
  };
}