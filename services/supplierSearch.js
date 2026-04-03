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

  // Category ID slugs (e.g. "medical_health") are not text fields in the DB —
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

export async function runSupplierSearch({ city, category, product, profileType, area }) {
  const _stack = new Error().stack.split('').slice(1,4).join(' | ');
  console.log(`[TRACE-RS] runSupplierSearch called: product="${product}" city="${city}" area="${area}" | CALLER: ${_stack}`);
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

  if (product) {
    product = String(product)
      .toLowerCase()
      .trim()
      .replace(/\s+/g, " ");

    const searchTerms = expandSearchTerms(product);

    const individualWords = product.split(/\s+/).filter(w => w.length > 2);

    const productOr = [
      { listedProducts: { $regex: product, $options: "i" } },
      { products: { $regex: product, $options: "i" } },
      { "rates.service": { $regex: product, $options: "i" } },
      { categories: { $regex: product, $options: "i" } },
      { businessName: { $regex: product, $options: "i" } },

      ...searchTerms.flatMap(term => [
        { listedProducts: { $regex: term, $options: "i" } },
        { products: { $regex: term, $options: "i" } },
        { "rates.service": { $regex: term, $options: "i" } },
        { categories: { $regex: term, $options: "i" } },
        { businessName: { $regex: term, $options: "i" } }
      ]),

      ...individualWords.flatMap(word => [
        { listedProducts: { $regex: word, $options: "i" } },
        { products: { $regex: word, $options: "i" } },
        { "rates.service": { $regex: word, $options: "i" } },
        { categories: { $regex: word, $options: "i" } }
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

// AFTER:
const preFilterCount = results.length;

results = results.filter((supplier) => {
  if (supplier?.profileType === "service") {
    const hasRates = (supplier.rates || []).some(r => normalizeProductName(r?.service || ""));
    const hasListedProducts = (supplier.listedProducts || []).some(p =>
      p && p !== "pending_upload" && normalizeProductName(p)
    );
    const hasProducts = (supplier.products || []).some(p =>
      p && p !== "pending_upload" && normalizeProductName(p)
    );
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

function productMatchesSearch(productName = "", searchTerm = "") {
  const productNorm = normalizeProductName(productName);
  const searchNorm = normalizeProductName(searchTerm);

  if (!productNorm || !searchNorm) return false;

  return productNorm.includes(searchNorm) || searchNorm.includes(productNorm);
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

    // 2. No rates set yet — show all items from products[] and listedProducts[],
    //    sorted so matching items appear first.
    //    runSupplierSearch already confirmed this supplier matches the query,
    //    so we show their full offering so buyers can compare and see everything.
    if (offers.length === 0) {
      const seen2 = new Set();
      const searchNorm = normalizeProductName(searchTerm || "");

      const allServiceItems = [
        ...(supplier.listedProducts || []),
        ...(supplier.products || [])
      ];

      // Sort: items that directly match the search term bubble to the top
      const sortedItems = [...allServiceItems].sort((a, b) => {
        const aNorm = normalizeProductName(a || "");
        const bNorm = normalizeProductName(b || "");
        const aMatch = searchNorm && (aNorm.includes(searchNorm) || searchNorm.includes(aNorm)) ? 0 : 1;
        const bMatch = searchNorm && (bNorm.includes(searchNorm) || searchNorm.includes(bNorm)) ? 0 : 1;
        return aMatch - bMatch;
      });

      for (const svcName of sortedItems) {
        if (!svcName || svcName === "pending_upload") continue;
        const cleanSvc = String(svcName).trim();
        const norm = normalizeProductName(cleanSvc);
        if (!norm) continue;
        if (seen2.has(norm)) continue;
        seen2.add(norm);

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
          product: cleanSvc,
          pricePerUnit: null,
          unit: "job",
          matchSource: "products"
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
  // No rates yet — show a matching product/service name as the hint
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
  "mabelreign": "Harare",
  "mbare": "Harare",
  "highfield": "Harare",
  "glen view": "Harare",
  "glenview": "Harare",
  "budiriro": "Harare",
  "kuwadzana": "Harare",
  "dzivarasekwa": "Harare",
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
// Lives here — AFTER SUBURB_TO_CITY (const) and toTitleCase so both are defined.
// ── Parse shortcode search from raw text ─────────────────────────────────────
// Handles: "find cement", "find plumber harare", "find cement mbare",
//          "find dentist avondale", "find cleaner borrowdale harare",
//          "find electrician mbare harare"
// Scans ALL word-window positions so city/suburb can appear anywhere in the
// phrase. Both city and suburb can be present simultaneously.
export function parseShortcodeSearch(input = "") {
  const _SUBURBS = {"avondale":"Harare","borrowdale":"Harare","mbare":"Harare","highfield":"Harare","hatfield":"Harare","greendale":"Harare","msasa":"Harare","eastlea":"Harare","waterfalls":"Harare","mufakose":"Harare","chitungwiza":"Harare","ruwa":"Harare","epworth":"Harare","tafara":"Harare","mabvuku":"Harare","highlands":"Harare","mount pleasant":"Harare","belgravia":"Harare","milton park":"Harare","newlands":"Harare","chisipite":"Harare","gunhill":"Harare","greystone":"Harare","strathaven":"Harare","braeside":"Harare","arcadia":"Harare","southerton":"Harare","workington":"Harare","willowvale":"Harare","graniteside":"Harare","seke":"Harare","norton":"Harare","kambuzuma":"Harare","warren park":"Harare","glen view":"Harare","glenview":"Harare","budiriro":"Harare","kuwadzana":"Harare","dzivarasekwa":"Harare","mabelreign":"Harare","glen norah":"Harare","glennorah":"Harare","nkulumane":"Bulawayo","luveve":"Bulawayo","entumbane":"Bulawayo","njube":"Bulawayo","mpopoma":"Bulawayo","lobengula":"Bulawayo","makokoba":"Bulawayo","tshabalala":"Bulawayo","pumula":"Bulawayo","cowdray park":"Bulawayo","magwegwe":"Bulawayo","hillside":"Bulawayo","white city":"Bulawayo","sakubva":"Mutare","dangamvura":"Mutare","chikanga":"Mutare","mambo":"Gweru","mkoba":"Gweru","senga":"Gweru","ascot":"Gweru","mucheke":"Masvingo","rujeko":"Masvingo","mbizo":"Kwekwe","amaveni":"Kwekwe"};
  const _CITIES = ["harare","bulawayo","mutare","gweru","masvingo","kwekwe","kadoma","chinhoyi","victoria falls"];

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