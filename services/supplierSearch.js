// services/supplierSearch.js

import SupplierProfile from "../models/supplierProfile.js";
import { sendText, sendList, sendButtons } from "./metaSender.js";

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
};

// ── Expand a search term using the synonym map ───────────────────────────────
// Returns original term + up to 6 synonyms to keep MongoDB $or manageable
export function expandSearchTerms(product) {
  const lower = (product || "").toLowerCase().trim();
  const synonyms = SEARCH_SYNONYMS[lower];
  if (!synonyms) return [lower];
  return [lower, ...synonyms.slice(0, 6)];
}

export async function runSupplierSearch({ city, category, product, profileType, area }) {
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
    const searchTerms = expandSearchTerms(product);

    // Also split multi-word queries into individual words so
    // "valve brass" matches "ball valve brass 25mm"
    const individualWords = product.toLowerCase().split(/\s+/).filter(w => w.length > 2);

    const productOr = [
      // Original expanded terms (exact phrase matching)
      ...searchTerms.flatMap(term => [
        { listedProducts: { $regex: term, $options: "i" } },
        { "rates.service": { $regex: term, $options: "i" } },
        { businessName: { $regex: term, $options: "i" } }
      ]),
      // Individual word matching — finds "ball valve brass 25mm" when searching "valve brass"
      ...individualWords.flatMap(word => [
        { listedProducts: { $regex: word, $options: "i" } },
        { "rates.service": { $regex: word, $options: "i" } }
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

  results = results.filter((supplier) => {
    if (supplier?.profileType === "service") {
      return (supplier.rates || []).some(r => normalizeProductName(r?.service || ""));
    }

    return (supplier.listedProducts || []).some(p =>
      p && p !== "pending_upload" && normalizeProductName(p)
    );
  });

  if (area && results.length > 1) {
    const areaLower = area.toLowerCase();
    results.sort((a, b) => {
      const aInArea = (a.location?.area || "").toLowerCase().includes(areaLower) ? 0 : 1;
      const bInArea = (b.location?.area || "").toLowerCase().includes(areaLower) ? 0 : 1;
      if (aInArea !== bInArea) return aInArea - bInArea;
      return (b.tierRank || 0) - (a.tierRank || 0);
    });
  }

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

  const pushOffer = ({ product, price, unit, matchSource }) => {
    const cleanProduct = String(product || "").trim();
    const normalizedProduct = normalizeProductName(cleanProduct);

    if (!cleanProduct || !normalizedProduct) return;
    if (!productMatchesSearch(cleanProduct, searchTerm)) return;

    const dedupeKey = `${supplier._id}:${normalizedProduct}`;
    if (seen.has(dedupeKey)) return;
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
      profileType: supplier.profileType || "product",
      deliveryText:
        supplier.profileType === "service"
          ? (supplier.travelAvailable ? "🚗 Mobile service" : "📍 Visit provider")
          : (supplier.delivery?.available ? "🚚 Delivery available" : "🏠 Collection only"),
      product: cleanProduct,
      pricePerUnit: typeof price === "number" && !Number.isNaN(price) ? Number(price) : null,
      unit: unit || (supplier.profileType === "service" ? "job" : "each"),
      matchSource: matchSource || "listedProducts"
    });
  };

  if (supplier.profileType === "service") {
    for (const rate of (supplier.rates || [])) {
      const serviceName = String(rate?.service || "").trim();
      const rawRate = String(rate?.rate || "").trim();
      if (!normalizeProductName(serviceName)) continue;

      const amountMatch = rawRate.match(/^\$?\s*(\d+(?:\.\d+)?)/);
      const amount = amountMatch ? Number(amountMatch[1]) : null;
      const unit = rawRate.includes("/") ? rawRate.split("/")[1].trim() || "job" : "job";

      pushOffer({
        product: serviceName,
        price: amount,
        unit,
        matchSource: "rates"
      });
    }

    return offers;
  }

  const allowedNames = new Set(
    (supplier.listedProducts || [])
      .filter(p => p && p !== "pending_upload")
      .map(p => normalizeProductName(p))
      .filter(Boolean)
  );

  for (const price of (supplier.prices || [])) {
    const normalizedPriceProduct = normalizeProductName(price?.product || "");
    if (!normalizedPriceProduct) continue;
    if (price?.inStock === false) continue;
    if (!allowedNames.has(normalizedPriceProduct)) continue;

    pushOffer({
      product: price?.product || "",
      price: typeof price?.amount === "number" ? Number(price.amount) : null,
      unit: price?.unit || "each",
      matchSource: "prices"
    });
  }

  for (const product of (supplier.listedProducts || [])) {
    const normalizedListedProduct = normalizeProductName(product);
    if (!normalizedListedProduct) continue;
    if (product === "pending_upload") continue;

    const alreadyExists = offers.some(o =>
      normalizeProductName(o.product) === normalizedListedProduct
    );

    if (alreadyExists) continue;

    pushOffer({
      product,
      price: null,
      unit: "each",
      matchSource: "listedProducts"
    });
  }

  return offers;
}

export async function runSupplierOfferSearch({ city, category, product, profileType, area }) {
  const suppliers = await runSupplierSearch({ city, category, product, profileType, area });

  const offers = suppliers.flatMap(supplier =>
    buildProductSearchOffersFromSupplier(supplier, product || category || "")
      .map((offer, idx) => ({
        ...offer,
        sortTierRank: typeof supplier.tierRank === "number" ? supplier.tierRank : 0,
        sortCredibility: typeof supplier.credibilityScore === "number" ? supplier.credibilityScore : 0,
        sortPosition: idx
      }))
  );

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

export function formatSupplierOfferResults(offers = []) {
  return offers.map((offer) => {
    const priceText =
      offer.pricePerUnit !== null
        ? `$${Number(offer.pricePerUnit).toFixed(2)}/${offer.unit || "each"}`
        : "Price on request";

    const locationText = [offer.supplierArea, offer.supplierCity].filter(Boolean).join(", ");
    const desc = [
      `🏪 ${offer.supplierName}`,
      locationText ? `📍 ${locationText}` : "",
      offer.deliveryText || ""
    ].filter(Boolean).join(" · ");

    return {
      id: `sup_offer_pick_${offer.supplierId}_${encodeURIComponent(offer.product)}`,
      title: `${offer.product}`.slice(0, 72),
      description: `${priceText} · ${desc}`.slice(0, 72)
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
    } else if (normalizedSearchTerm) {
      const allowedNames = new Set(
        (s.listedProducts || [])
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

  // ── Pattern 1: explicit prefix (find/search/s/buy etc.) ──────────────────
  const prefixPattern = /^(?:\/find|find|search|s|buy|get|looking for|need|want|seeking|i need|i want|find me|get me|where can i get|who sells|who does|do you have)\s+(.+)$/i;
  const m = raw.match(prefixPattern);
  if (m) {
    return parseQueryWithCity(m[1].trim());
  }

  // ── Pattern 2: plain "product city" — only treat as shortcode if a known
  //    city or suburb appears in the text (avoids hijacking normal messages)
  const plain = parseQueryWithCity(raw);
  if (plain && plain.city) {
    // City was detected → treat as shortcode
    return plain;
  }

  return null;
}

// ── Split "plumber harare" into { product: "plumber", city: "Harare" } ───────
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

  // Bulawayo suburbs
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

function parseQueryWithCity(query = "") {
  const KNOWN_CITIES = [
    "harare", "bulawayo", "mutare", "gweru", "masvingo",
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