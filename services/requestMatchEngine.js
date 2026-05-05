// services/requestMatchEngine.js
//
// Purpose-built matching engine for the ⚡ Request Sellers flow.
// This module is SEPARATE from Browse & Shop (runSupplierSearch).
// It must NOT be used for Browse & Shop, shortcode search, or any other flow.
//
// Key rules:
//  - businessName match alone NEVER qualifies a supplier.
//  - For product requests, at least one item must match listedProducts/prices/products/rates.
//  - Category-only match is fallback for service requests only.
//  - Generic single-word requests are flagged for clarification, not sent blind.

import SupplierProfile from "../models/supplierProfile.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function normalize(s = "") {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ─── Intent Category Classification ─────────────────────────────────────────
//
// Maps normalized keyword fragments → canonical intent category.
// More specific entries must come before broader ones within each group.
// These are NOT supplier category IDs — they are classification labels.

const INTENT_KEYWORD_MAP = [
  // ── PLUMBING SUPPLIES (products) ──────────────────────────────────────────
  { pattern: /\b(pvc pipe|pvc ug pipe|ac pvc|hdpe pipe|copper pipe|cu pipe|waste pipe|pressure pipe)\b/, intent: "plumbing_supplies" },
  { pattern: /\b(p trap|bottle trap|floor drain|inspection eye|plain bend|ht bend|plain tee|access tee|y junction|reducer tee|vent valve|boss connector|ic tee|ie bend|gulley)\b/, intent: "plumbing_supplies" },
  { pattern: /\b(solvent cement|pipe clip|male connector|cap elbow|compression fitting|gate valve|ball valve|check valve|angle valve|isolator valve|stop cock|float valve|bib tap|pillar tap)\b/, intent: "plumbing_supplies" },
  { pattern: /\b(basin|sink|toilet|cistern|shower rose|shower tray|bath tub|pedestal|toilet seat|toilet lid|basin waste|overflow cap)\b/, intent: "plumbing_supplies" },
  { pattern: /\b(geyser|water heater|hot water cylinder|pressure relief valve|prv|thermostat)\b/, intent: "plumbing_supplies" },
  { pattern: /\b(nasco flux|soldering wire|gas canister|pipe fittings|plumbing fittings|plumbing supplies|plumbing materials)\b/, intent: "plumbing_supplies" },

  // ── PLUMBING SERVICE ──────────────────────────────────────────────────────
  { pattern: /\b(plumber|plumbing service|blocked drain|burst pipe|water leak|pipe leak|geyser install|geyser repair|geyser service|toilet repair|burst geyser|borehole drill|borehole pump|drain clearance|unblock|sewer|sewage|drain cleaning|drain rodding)\b/, intent: "plumbing_service" },
  { pattern: /\b(plumbing install|plumbing repair|plumbing maintenance|pipe install|plumbing work|plumbing contractor)\b/, intent: "plumbing_service" },

  // ── ELECTRICAL SUPPLIES (products) ────────────────────────────────────────
  { pattern: /\b(db board|distribution board|circuit breaker|mcb|rcd|rcbo|consumer unit|main switch|isolator|elcb|contactor|relay|surge protector|surge arrester)\b/, intent: "electrical_supplies" },
  { pattern: /\b(cable|electrical cable|armoured cable|flat twin|pvc conduit|conduit|trunking|wire|electrical wire|twin wire|earth wire|swa cable|xlpe cable)\b/, intent: "electrical_supplies" },
  { pattern: /\b(socket|plug|switched socket|spur|switch plate|light switch|dimmer switch|junction box|back box|cable clip|cable tray)\b/, intent: "electrical_supplies" },
  { pattern: /\b(led bulb|led strip|fluorescent tube|batten fitting|downlight|spotlight|floodlight|street light|sensor light|security light|pendant)\b/, intent: "electrical_supplies" },
  { pattern: /\b(inverter|solar panel|solar charge controller|mppt|battery bank|deep cycle battery|agm battery|gel battery|lifepo4|lithium battery|ups)\b/, intent: "electrical_supplies" },
  { pattern: /\b(transformer|generator|genset|alternator|motor|electric motor|pump motor|starter|capacitor|ammeter|voltmeter|multimeter)\b/, intent: "electrical_supplies" },
  { pattern: /\b(electrical supplies|electrical materials|electrical fittings|electrical accessories|wiring accessories)\b/, intent: "electrical_supplies" },

  // ── ELECTRICAL SERVICE ────────────────────────────────────────────────────
  { pattern: /\b(electrician|electrical install|electrical repair|electrical service|rewiring|house wiring|db board fault|db board repair|db board install|electrical fault|power fault|load shedding solution|solar install|solar system install|inverter install|geyser timer|prepaid meter install|smart meter|meter box)\b/, intent: "electrical_service" },

  // ── CONSTRUCTION MATERIALS (products) ─────────────────────────────────────
  { pattern: /\b(cement|portland cement|opc cement|bag of cement|bags of cement|concrete|premix|rapid set)\b/, intent: "construction_materials" },
  { pattern: /\b(river sand|plaster sand|building sand|sharp sand|pit sand|crusher dust|aggregate|gravel|stone|quarry stone|road stone)\b/, intent: "construction_materials" },
  { pattern: /\b(bricks|face brick|burnt brick|common brick|block|hollow block|solid block|paving block|paver)\b/, intent: "construction_materials" },
  { pattern: /\b(iron sheets|roofing sheets|roof sheets|corrugated iron|box profile|IBR sheet|ridge cap|roof tiles|clay tiles|concrete tiles|slate tile)\b/, intent: "construction_materials" },
  { pattern: /\b(timber|plank|lumber|board|pine plank|hardwood|beam|rafter|purlin|door frame|window frame|architrave|skirting)\b/, intent: "construction_materials" },
  { pattern: /\b(steel bar|rebar|high yield|round bar|flat bar|angle iron|channel iron|square tube|rectangular tube|steel pipe|galvanized pipe|structural steel)\b/, intent: "construction_materials" },
  { pattern: /\b(floor tile|wall tile|ceramic tile|porcelain tile|mosaic tile|vitrified tile|tile adhesive|tile grout|tile spacer|waterproofing)\b/, intent: "construction_materials" },
  { pattern: /\b(emulsion paint|gloss paint|primer|undercoat|roof paint|enamel|bitumen|damp proof|dpc|polythene|shadenet|shade cloth)\b/, intent: "construction_materials" },
  { pattern: /\b(nails|screws|bolts|nuts|washers|rawl bolt|dynabolt|anchor bolt|hilti|drill bit|masonry bit|angle grinder disk)\b/, intent: "construction_materials" },
  { pattern: /\b(building materials|construction materials|hardware supplies|hardware products)\b/, intent: "construction_materials" },

  // ── CONSTRUCTION SERVICE ──────────────────────────────────────────────────
  { pattern: /\b(builder|contractor|construction work|house build|room add|extension|renovation|remodel|plastering|plaster work|tiling|tile laying|roofing work|roof repair|roof install|waterproof service|paint service|house paint|painting service|painter)\b/, intent: "construction_service" },

  // ── CAR SPARES (products) ─────────────────────────────────────────────────
  { pattern: /\b(brake pad|disc brake|drum brake|brake shoe|brake caliper|brake line|brake fluid|abs sensor|wheel bearing|hub bearing|cv joint|cv boot|drive shaft)\b/, intent: "car_spares" },
  { pattern: /\b(oil filter|air filter|fuel filter|cabin filter|pollen filter|spark plug|glow plug|ignition coil|distributor cap|rotor arm)\b/, intent: "car_spares" },
  { pattern: /\b(timing belt|timing chain|water pump|thermostat|radiator|radiator hose|fan belt|serpentine belt|idler pulley|tensioner)\b/, intent: "car_spares" },
  { pattern: /\b(shock absorber|strut|coil spring|leaf spring|stabilizer link|ball joint|tie rod|rack end|steering rack|power steering pump)\b/, intent: "car_spares" },
  { pattern: /\b(alternator|starter motor|car battery|battery terminal|fuse box|relay|headlight|tail light|indicator|fog light|bulb h4|bulb h7|led headlight)\b/, intent: "car_spares" },
  { pattern: /\b(engine oil|gear oil|transmission fluid|diff oil|power steering fluid|coolant|antifreeze|brake cleaner|carb cleaner|grease)\b/, intent: "car_spares" },
  { pattern: /\b(tyre|tire|rim|alloy wheel|hub cap|spare wheel|tyre sealant)\b/, intent: "car_spares" },
  { pattern: /\b(service kit|major service kit|minor service kit|car parts|auto parts|spare parts|vehicle parts|car accessories|car supplies)\b/, intent: "car_spares" },
  // Named car models strongly signal car spares context
  { pattern: /\b(toyota|honda|mazda|nissan|mitsubishi|isuzu|ford|bmw|mercedes|vw|volkswagen|hyundai|kia|suzuki|subaru|peugeot|renault|benz)\b.*\b(part|spare|service|kit|pad|filter|oil|belt|pump|bearing|sensor|brake)\b/, intent: "car_spares" },
  { pattern: /\b(aqua|vitz|fielder|axio|ist|wish|spacio|corolla|hilux|ranger|amarok|d4d|d4|rav4|rush|prado|land cruiser|allion|premio|harrier)\b/, intent: "car_spares" },

  // ── CAR REPAIR SERVICE ────────────────────────────────────────────────────
  { pattern: /\b(mechanic|car service|vehicle service|car repair|car diagnosis|engine repair|gearbox repair|panel beat|spray paint|body work|car body|car detailing|wheel alignment|wheel balance|tyre fitting|car wash)\b/, intent: "car_repair" },

  // ── GROCERIES / FOOD PRODUCTS ─────────────────────────────────────────────
  { pattern: /\b(mealie meal|roller meal|flour|sugar|cooking oil|rice|soya chunks|kapenta|baked beans|tomato paste|margarine|jam|tea bags|coffee|salt|bread|buns|loaf)\b/, intent: "groceries" },
  { pattern: /\b(frozen chicken|chicken pieces|beef|pork|mutton|fish|kapenta|matemba|nyama|offals|giblets)\b/, intent: "groceries" },
  { pattern: /\b(milk|long life milk|fresh milk|yoghurt|cheese|butter|eggs|dairy)\b/, intent: "groceries" },
  { pattern: /\b(tomatoes|onions|cabbage|spinach|potatoes|carrots|green beans|peas|lettuce|cucumber|avocado|mango|bananas|apples|oranges)\b/, intent: "groceries" },
  { pattern: /\b(drinks|juice|soft drinks|water|soda|cooldrink|sparkling water|mineral water|energy drink|cordial)\b/, intent: "groceries" },
  { pattern: /\b(nappies|diapers|baby food|formula|pampers|huggies|sanitary|pads|tissue|toilet paper|washing powder|detergent|dishwash|bleach|jik)\b/, intent: "groceries" },

  // ── CLOTHING & UNIFORMS ───────────────────────────────────────────────────
  { pattern: /\b(school uniform|uniform|school shoes|school bag|school wear|school clothes|school kit|grey trouser|white shirt|school dress)\b/, intent: "clothing" },
  { pattern: /\b(t-shirt|tshirt|polo shirt|golf shirt|jacket|hoodie|sweater|jersey|trouser|pants|jeans|shorts|dress|skirt|suit|blazer|tie|belt)\b/, intent: "clothing" },
  { pattern: /\b(sneakers|shoes|boots|sandals|heels|flatform|trainers|school shoes|safety shoes|gumboots|steel toe)\b/, intent: "clothing" },
  { pattern: /\b(salaula|second hand clothes|secondhand|thrift|bale|bails of clothes)\b/, intent: "clothing" },
  { pattern: /\b(corporate wear|workwear|overalls|reflective vest|hard hat|ppe|personal protective)\b/, intent: "clothing" },

  // ── FURNITURE & HOME ──────────────────────────────────────────────────────
  { pattern: /\b(sofa|couch|lounge suite|dining table|dining chair|coffee table|tv stand|bookshelf|wardrobe|bedroom suite|bed frame|mattress|bunk bed|wall unit|kitchen unit|kitchen cupboard)\b/, intent: "furniture" },
  { pattern: /\b(curtains|blinds|roller blind|venetian blind|cushion|throw|carpet|rug|mirror|picture frame|wall art|home décor)\b/, intent: "furniture" },

  // ── ELECTRONICS ───────────────────────────────────────────────────────────
  { pattern: /\b(laptop|notebook|computer|desktop pc|all in one|tablet|ipad|chromebook|macbook|hp laptop|dell laptop|lenovo|asus|acer)\b/, intent: "electronics" },
  { pattern: /\b(smartphone|mobile phone|cell phone|iphone|samsung|tecno|infinix|itel|redmi|xiaomi|oppo|airpods|earphones|headphones)\b/, intent: "electronics" },
  { pattern: /\b(flat screen|tv|television|smart tv|android tv|samsung tv|lg tv|hisense|decoder|dstv|openview|starsat|remotes)\b/, intent: "electronics" },
  { pattern: /\b(fridge|refrigerator|chest freezer|upright freezer|fridge freezer|washing machine|tumble dryer|dishwasher|microwave|electric stove|gas stove|air conditioner|aircon|water dispenser)\b/, intent: "electronics" },
  { pattern: /\b(solar panel|inverter system|mppt controller|battery backup|power backup)\b/, intent: "electronics" },

  // ── CLEANING SERVICE ──────────────────────────────────────────────────────
  { pattern: /\b(cleaner|cleaning service|house cleaning|office cleaning|industrial cleaning|carpet cleaning|deep clean|spring clean|domestic worker|maid|housekeeper|laundry service|dry cleaning|pest control|fumigation|termite|rodent|cockroach)\b/, intent: "cleaning_service" },

  // ── GARDENING SERVICE ─────────────────────────────────────────────────────
  { pattern: /\b(gardener|gardening|grass cut|lawn mow|tree cut|tree trim|tree removal|landscaping|landscaper|hedge trim|leaf blow|garden clean)\b/, intent: "gardening_service" },

  // ── IT / TECH ─────────────────────────────────────────────────────────────
  { pattern: /\b(it support|computer repair|laptop repair|screen replace|keyboard replace|virus removal|software install|windows install|network setup|wifi setup|cctv install|cctv camera|access control|biometric|intercom)\b/, intent: "it_service" },
  { pattern: /\b(web design|website design|website develop|app develop|software develop|graphic design|logo design|branding|printing service|banner print|flyer print|business cards|tshirt print|vinyl wrap|signage)\b/, intent: "it_service" },

  // ── BEAUTY & HAIR SERVICE ─────────────────────────────────────────────────
  { pattern: /\b(hairdresser|hair salon|braiding|cornrows|dreadlocks|weave|hair relaxer|hair treatment|hair color|barber|haircut|nail technician|manicure|pedicure|nail art|makeup artist|make up|eyebrow|lashes|massage|spa|waxing|threading)\b/, intent: "beauty_service" },

  // ── CATERING & FOOD SERVICE ───────────────────────────────────────────────
  { pattern: /\b(catering|caterer|event catering|birthday cake|wedding cake|custom cake|cake order|cooked food|meals delivery|food delivery|chef|buffet|braai|finger food|office lunch)\b/, intent: "catering_service" },

  // ── TRANSPORT & LOGISTICS ─────────────────────────────────────────────────
  { pattern: /\b(truck hire|lorry hire|flatbed|tipper truck|skip hire|move furniture|relocation|removals|courier service|parcel delivery|driver hire|chauffeur|car hire|vehicle hire|car rental|taxi|minibus hire)\b/, intent: "transport_service" },

  // ── PRINTING & BRANDING ───────────────────────────────────────────────────
  { pattern: /\b(printing|banners|flyers|pamphlets|posters|business cards|letterheads|stationery|t-shirt printing|branded merchandise|promotional items|roll up banner|exhibition stand|car wrap|vehicle branding|embroidery)\b/, intent: "printing_service" },

  // ── TUTORING & EDUCATION ─────────────────────────────────────────────────
  { pattern: /\b(tutor|tutoring|maths tutor|science tutor|english tutor|a level|o level|alevel|olevel|lessons|private lessons|home tuition|coding class|driving lessons|music lessons)\b/, intent: "tutoring_service" },

  // ── SECURITY SERVICES ─────────────────────────────────────────────────────
  { pattern: /\b(security guard|armed response|security company|security patrol|alarm system|panic button|electric fence|electric gate|gate motor)\b/, intent: "security_service" },

  // ── WELDING & FABRICATION ─────────────────────────────────────────────────
  { pattern: /\b(welder|welding|fabricat|burglar bars|security bars|gate install|gate fabricat|steel gate|iron gate|window guard|security door|steel door|roller shutter|shade structure|carport|pergola)\b/, intent: "welding_service" },

  // ── MEDICAL / DENTAL ──────────────────────────────────────────────────────
  { pattern: /\b(dentist|dental|teeth clean|tooth extract|filling|root canal|denture|braces|orthodon)\b/, intent: "medical_service" },
  { pattern: /\b(doctor|clinic|gp|general practitioner|physiotherapist|physiotherapy|optician|optical|glasses|optometrist|psychologist|counsellor|nutritionist|dietitian)\b/, intent: "medical_service" },
  { pattern: /\b(pharmacy|chemist|medicine|pills|prescription|supplement|vitamin|first aid)\b/, intent: "medical_service" },
];

// ─── VAGUE SINGLE TERMS ───────────────────────────────────────────────────────
// These terms alone (with no qualifying words) must trigger a clarification prompt.
// "plumber" by itself → ask what for. "ball valve 20mm" → enough detail, no prompt.
export const VAGUE_SINGLE_TERMS = new Set([
  // Generic trades (person title alone)
  "plumber", "electrician", "mechanic", "builder", "contractor", "welder",
  "carpenter", "painter", "cleaner", "gardener", "driver", "technician",
  // Generic product categories alone
  "valve", "valves", "pipe", "pipes", "fitting", "fittings", "cable", "cables",
  "spares", "parts", "service", "repair", "fix", "maintenance",
  "panel", "board", "unit", "pump", "motor", "switch", "connector",
  "bracket", "nut", "bolt", "screw",
  // Other single ambiguous terms
  "supplies", "materials", "equipment", "goods", "items", "products",
  "tiles", "tile", "paint", "sand", "cement", "hardware",
]);

// Clarification prompts per vague term — what to ask the buyer
const VAGUE_CLARIFICATION = {
  plumber:      "What do you need the plumber for?\n\nExamples:\n_blocked drain avondale_\n_burst pipe borrowdale_\n_geyser installation mbare_\n_new bathroom fitting harare_",
  electrician:  "What do you need the electrician for?\n\nExamples:\n_DB board fault borrowdale_\n_house rewiring harare_\n_solar installation avondale_\n_new sockets fitted harare_",
  mechanic:     "What do you need the mechanic for?\n\nExamples:\n_Toyota Aqua service harare_\n_engine diagnosis harare_\n_gearbox repair harare_\n_panel beating harare_",
  builder:      "What building work do you need?\n\nExamples:\n_2-room extension harare_\n_house plastering harare_\n_roof repair harare_\n_tiling bathrooms harare_",
  contractor:   "What work do you need the contractor for?\n\nExamples:\n_house renovation harare_\n_new perimeter wall harare_\n_driveway paving harare_",
  welder:       "What do you need the welder for?\n\nExamples:\n_security door harare_\n_burglar bars harare_\n_driveway gate harare_\n_steel carport harare_",
  carpenter:    "What carpentry work do you need?\n\nExamples:\n_kitchen cupboards harare_\n_wooden doors harare_\n_built-in wardrobe harare_",
  painter:      "What painting do you need done?\n\nExamples:\n_interior house painting harare_\n_exterior walls harare_\n_roof painting harare_",
  cleaner:      "What cleaning service do you need?\n\nExamples:\n_house deep clean harare_\n_office cleaning harare_\n_carpet cleaning harare_",
  gardener:     "What garden work do you need?\n\nExamples:\n_grass cutting weekly harare_\n_tree trimming harare_\n_full garden cleanup harare_",
  valve:        "Please include the type and size.\n\nExamples:\n_ball valve brass 20mm_\n_gate valve 25mm_\n_ball valve 15mm_",
  pipe:         "Please include the type and size.\n\nExamples:\n_110mm pvc pipe_\n_22mm copper pipe_\n_20mm hdpe pipe_",
  cable:        "Please include the type and size.\n\nExamples:\n_2.5mm flat twin cable_\n_16mm armoured cable_\n_4mm earth wire_",
  spares:       "Please include the make and model.\n\nExamples:\n_Toyota Aqua brake pads harare_\n_Mazda 3 service kit harare_\n_Nissan NP200 shock absorbers harare_",
  parts:        "Please include the make and part name.\n\nExamples:\n_Toyota Aqua brake pads harare_\n_Honda Fit alternator harare_\n_Isuzu KB oil filter harare_",
  tiles:        "Please include the type and size.\n\nExamples:\n_600x600 porcelain floor tiles harare_\n_300x600 wall tiles harare_\n_200x200 ceramic tiles harare_",
  tile:         "Please include the type and size.\n\nExamples:\n_600x600 porcelain floor tile harare_\n_300x600 wall tile harare_",
  hardware:     "Please include the specific item you need.\n\nExamples:\n_50 bags cement harare_\n_river sand 2 loads harare_\n_110mm pvc pipe x10 harare_",
};

/**
 * Returns a clarification prompt string if the item name is vague and alone,
 * or null if the item is specific enough to proceed.
 * Used in chatbotEngine awaiting_items state.
 */
export function getVagueTermClarification(itemName = "") {
  const norm = normalize(itemName);
  const tokens = norm.split(" ").filter(Boolean).filter(t => t.length > 1);
  // Filter out location words and quantity indicators before checking vagueness
  const FILLER = new Set(["a","an","the","for","of","and","with","in","on","to","my","need","want","looking","harare","bulawayo","mutare","gweru","kwekwe","masvingo","x","qty"]);
  const meaningful = tokens.filter(t => !FILLER.has(t) && !/^\d+$/.test(t));

  if (meaningful.length !== 1) return null; // multi-token = specific enough
  const singleToken = meaningful[0];
  if (!VAGUE_SINGLE_TERMS.has(singleToken)) return null;

  const prompt = VAGUE_CLARIFICATION[singleToken];
  if (prompt) return prompt;

  // Generic fallback for terms in VAGUE_SINGLE_TERMS without specific prompt
  return `Please add more detail to your request for *${singleToken}* so sellers can quote correctly.\n\nInclude: type, size, brand, model, or exact service needed.`;
}

// ─── Intent → Supplier Category IDs ─────────────────────────────────────────
// Maps intent category → the values that appear in SupplierProfile.categories[]
// These must match the actual category IDs in supplierPlans.js / the DB.

const INTENT_TO_SUPPLIER_CATEGORIES = {
  plumbing_supplies:      ["plumbing_supplies", "hardware", "building_materials", "plumbing"],
  plumbing_service:       ["plumbing", "plumbing_service", "trades", "plumbing_supplies"],
  electrical_supplies:    ["electrical", "electrical_supplies", "solar", "hardware"],
  electrical_service:     ["electrical", "electrician", "trades", "solar", "electrical_service"],
  construction_materials: ["hardware", "building_materials", "construction", "construction_materials", "roofing"],
  construction_service:   ["construction", "construction_service", "trades", "building", "roofing"],
  car_spares:             ["car_parts", "auto_parts", "car_spares", "spares", "automotive", "vehicles"],
  car_repair:             ["mechanic", "car_repair", "automotive", "garage", "panel_beating", "trades"],
  groceries:              ["groceries", "food", "fresh_produce", "wholesale_groceries", "provisions"],
  clothing:               ["clothing", "fashion", "uniforms", "shoes", "salaula", "school_uniforms"],
  furniture:              ["furniture", "home", "home_decor", "interiors"],
  electronics:            ["electronics", "phones", "laptops", "appliances", "solar", "it_supplies"],
  cleaning_service:       ["cleaning", "cleaning_service", "domestic", "pest_control", "fumigation"],
  gardening_service:      ["gardening", "landscaping", "garden_service"],
  it_service:             ["it_support", "tech", "web_design", "printing", "branding", "cctv", "security_tech", "it_service"],
  beauty_service:         ["beauty", "hair", "salon", "nails", "spa", "barber", "beauty_service"],
  catering_service:       ["catering", "food_service", "cooked_food", "catering_service", "bakery"],
  transport_service:      ["transport", "logistics", "courier", "car_hire", "truck_hire", "removals"],
  printing_service:       ["printing", "branding", "graphic_design", "signage", "printing_service"],
  tutoring_service:       ["tutoring", "education", "lessons", "tutoring_service"],
  security_service:       ["security", "security_service", "alarm_systems"],
  welding_service:        ["welding", "fabrication", "steel_work", "trades", "welding_service"],
  medical_service:        ["medical_health", "dental", "pharmacy", "health", "wellness"],
  other:                  [],
};

// Which profileType to target for each intent
const INTENT_TO_PROFILE_TYPE = {
  plumbing_supplies:      "product",
  plumbing_service:       "service",
  electrical_supplies:    "product",
  electrical_service:     "service",
  construction_materials: "product",
  construction_service:   "service",
  car_spares:             "product",
  car_repair:             "service",
  groceries:              "product",
  clothing:               "product",
  furniture:              "product",
  electronics:            "product",
  cleaning_service:       "service",
  gardening_service:      "service",
  it_service:             "service",
  beauty_service:         "service",
  catering_service:       "service",
  transport_service:      "service",
  printing_service:       "service",
  tutoring_service:       "service",
  security_service:       "service",
  welding_service:        "service",
  medical_service:        "service",
  other:                  null, // search both
};

// ─── Intent Classification ────────────────────────────────────────────────────

/**
 * Classify a single item string → intent category string.
 */
function classifyItem(itemName = "") {
  const norm = normalize(itemName);
  for (const { pattern, intent } of INTENT_KEYWORD_MAP) {
    if (pattern.test(norm)) return intent;
  }
  return "other";
}

/**
 * Classify an array of request items → { intents: Set, dominant: string, profileType: string|null }
 * dominant = the most frequent intent (or "other" if all are "other")
 */
export function classifyRequestItems(items = []) {
  const counts = {};
  for (const item of items) {
    const label = String(item?.product || item?.service || item?.raw || "");
    const intent = classifyItem(label);
    counts[intent] = (counts[intent] || 0) + 1;
  }

  const intents = new Set(Object.keys(counts));

  // dominant = highest count; prefer non-"other" over "other"
  let dominant = "other";
  let maxCount = 0;
  for (const [intent, count] of Object.entries(counts)) {
    if (intent === "other") continue;
    if (count > maxCount) { maxCount = count; dominant = intent; }
  }
  if (dominant === "other" && intents.size > 0) dominant = [...intents][0];

  const profileType = INTENT_TO_PROFILE_TYPE[dominant] ?? null;

  return { intents, dominant, profileType };
}

// ─── Item-Level Scoring ───────────────────────────────────────────────────────

const ITEM_ALIASES = {
  "brake pads":        ["brakes", "disc pads", "brake shoes", "brake lining"],
  "brake shoes":       ["drum brakes", "brake pads", "brakes"],
  "shock absorber":    ["strut", "shock", "damper"],
  "cv joint":          ["cv", "cv axle", "drive shaft"],
  "ball valve":        ["gate valve", "stop cock", "ball cock"],
  "pvc pipe":          ["upvc pipe", "plastic pipe", "waste pipe"],
  "solvent cement":    ["pvc glue", "pipe glue", "solvent"],
  "copper pipe":       ["cu pipe", "15mm cu", "22mm cu"],
  "db board":          ["distribution board", "consumer unit", "fuse board", "main board"],
  "circuit breaker":   ["mcb", "rcbo", "rcd", "breaker"],
  "armoured cable":    ["swa cable", "steel wire armoured"],
  "flat twin":         ["twin wire", "twin and earth", "t&e"],
  "mealie meal":       ["roller meal", "maize meal", "sadza flour"],
  "cooking oil":       ["sunflower oil", "vegetable oil", "oil"],
  "engine oil":        ["motor oil", "lubricant oil", "sae"],
  "school uniform":    ["uniform", "school clothes", "school wear"],
  "service kit":       ["service pack", "service set", "major service", "minor service"],
  "floor tile":        ["ceramic tile", "porcelain tile", "vitrified tile", "tiles"],
  "roof sheet":        ["iron sheets", "corrugated iron", "ibr sheet", "box profile"],
  "brick":             ["building brick", "face brick", "burnt brick", "block"],
  "river sand":        ["building sand", "plaster sand", "coarse sand"],
  "rebar":             ["steel bar", "high yield bar", "hysb", "round bar"],
  "led bulb":          ["led lamp", "energy saver", "cfl", "light bulb"],
  "water pump":        ["submersible pump", "surface pump", "centrifugal pump"],
  "generator":         ["genset", "diesel generator", "petrol generator"],
};

function getAliases(term = "") {
  const norm = normalize(term);
  for (const [key, aliases] of Object.entries(ITEM_ALIASES)) {
    if (norm.includes(normalize(key)) || normalize(key).includes(norm)) {
      return aliases.map(normalize);
    }
  }
  return [];
}

function getAllSupplierItemNames(supplier) {
  const names = [];
  for (const p of supplier.listedProducts || []) {
    if (p && p !== "pending_upload") names.push(normalize(p));
  }
  for (const p of supplier.products || []) {
    if (p && p !== "pending_upload") names.push(normalize(p));
  }
  for (const pr of supplier.prices || []) {
    if (pr?.product) names.push(normalize(pr.product));
  }
  for (const r of supplier.rates || []) {
    if (r?.service) names.push(normalize(r.service));
  }
  return names;
}

/**
 * Score a single request item against a supplier's catalogue.
 * Returns: { score, matchType }
 * matchType: "exact" | "substring" | "alias" | "none"
 */
function scoreItemAgainstSupplier(itemName = "", supplierItemNames = []) {
  const req = normalize(itemName);
  if (!req || !supplierItemNames.length) return { score: 0, matchType: "none" };

  // Exact match
  if (supplierItemNames.some(n => n === req)) return { score: 30, matchType: "exact" };

  // Substring match (item is part of listed name or listed name is part of item)
  const reqTokens = req.split(" ").filter(t => t.length > 2);
  for (const n of supplierItemNames) {
    if (n.includes(req) || req.includes(n)) return { score: 15, matchType: "substring" };
    // Token overlap: at least 2 meaningful tokens match
    const nTokens = n.split(" ").filter(t => t.length > 2);
    const overlap = reqTokens.filter(t => nTokens.includes(t));
    if (overlap.length >= 2) return { score: 12, matchType: "substring" };
    if (overlap.length === 1 && reqTokens.length === 1) return { score: 8, matchType: "substring" };
  }

  // Alias match
  const aliases = getAliases(req);
  for (const alias of aliases) {
    if (supplierItemNames.some(n => n.includes(alias) || alias.includes(n))) {
      return { score: 10, matchType: "alias" };
    }
  }

  return { score: 0, matchType: "none" };
}

// ─── 3-Stage Matching Gate ────────────────────────────────────────────────────

/**
 * Score a supplier against the full request.
 * Returns { totalScore, hasItemMatch } or null if fails eligibility.
 *
 * Stage 1: Eligibility (active, not suspended, subscription active/trial)
 * Stage 2: Category gate (must match at least one allowed category)
 * Stage 3: Item-level scoring
 */
function scoreSupplierForRequest(supplier, items, intentResult) {
  const { dominant, profileType } = intentResult;

  // ── Stage 1: Eligibility ──────────────────────────────────────────────────
  if (!supplier.active) return null;
  if (supplier.suspended === true) return null;
  const subStatus = supplier.subscriptionStatus;
  if (subStatus !== "active" && subStatus !== "trial") return null;

  // ── Stage 2: Category gate ────────────────────────────────────────────────
  const allowedCats = new Set(INTENT_TO_SUPPLIER_CATEGORIES[dominant] || []);
  if (allowedCats.size > 0) {
    const supplierCats = Array.isArray(supplier.categories) ? supplier.categories : [];
    const hasCategory = supplierCats.some(c => allowedCats.has(String(c).toLowerCase()));
    if (!hasCategory) return null; // businessName alone does NOT qualify
  }

  // ProfileType gate (if intent clearly indicates product or service)
  if (profileType && supplier.profileType && supplier.profileType !== profileType) {
    // Allow slight mismatch for hybrid suppliers (e.g. plumbing_supplies supplier who also does installs)
    // Only hard-exclude if the mismatch is stark
    const isHardMismatch = (profileType === "service" && supplier.profileType === "product") ||
                           (profileType === "product" && supplier.profileType === "service");
    if (isHardMismatch && dominant !== "other") return null;
  }

  // ── Stage 3: Item-level scoring ───────────────────────────────────────────
  const supplierItemNames = getAllSupplierItemNames(supplier);
  let totalScore = 0;
  let hasItemMatch = false;
  let categoryOnlyScore = 2; // base for category match alone

  for (const item of items) {
    const label = String(item?.product || item?.service || item?.raw || "");
    const { score, matchType } = scoreItemAgainstSupplier(label, supplierItemNames);
    totalScore += score;
    if (matchType !== "none") hasItemMatch = true;
  }

  // For service intents: category match alone is enough (no item catalogue required)
  const isServiceIntent = dominant.endsWith("_service") || INTENT_TO_PROFILE_TYPE[dominant] === "service";
  if (isServiceIntent && !hasItemMatch && allowedCats.size > 0) {
    // Grant a small base score so they're included but ranked low
    totalScore += categoryOnlyScore;
    // hasItemMatch stays false — they'll be ranked below suppliers with matched items
  }

  // For product intents: must have at least one item match to qualify
  if (!isServiceIntent && !hasItemMatch) return null;

  // Boost by tier
  totalScore += (supplier.tierRank || 1) * 2;
  totalScore += Math.min(supplier.credibilityScore || 0, 10);

  return { totalScore, hasItemMatch };
}

// ─── City / Area Matching ─────────────────────────────────────────────────────

const CITY_ALIASES = {
  "harare":       ["harare", "hre", "salisbury"],
  "bulawayo":     ["bulawayo", "byo", "bula"],
  "mutare":       ["mutare", "umtali"],
  "gweru":        ["gweru", "gwelo"],
  "masvingo":     ["masvingo", "fort victoria"],
  "kwekwe":       ["kwekwe", "que que"],
  "kadoma":       ["kadoma", "gatooma"],
  "chinhoyi":     ["chinhoyi", "sinoia"],
  "bindura":      ["bindura"],
  "victoria falls":["victoria falls", "vic falls"],
  "hwange":       ["hwange", "wankie"],
  "chiredzi":     ["chiredzi"],
  "zvishavane":   ["zvishavane", "shabani"],
  "beitbridge":   ["beitbridge"],
  "rusape":       ["rusape"],
  "chipinge":     ["chipinge"],
  "chegutu":      ["chegutu", "hartley"],
  "redcliff":     ["redcliff"],
  "chitungwiza":  ["chitungwiza", "chitu"],
  "epworth":      ["epworth"],
};

function normalizeCityForSearch(cityInput = "") {
  const norm = normalize(cityInput);
  for (const [canonical, aliases] of Object.entries(CITY_ALIASES)) {
    if (aliases.some(a => norm.includes(a) || a.includes(norm))) return canonical;
  }
  return norm || null;
}

// ─── Main Export: findSuppliersForRequest ─────────────────────────────────────

/**
 * Replacement for the old findSuppliersForBuyerRequest in chatbotEngine.js.
 * Uses the 3-stage gate instead of broad runSupplierSearch.
 *
 * @param {Object} opts
 * @param {Array}  opts.items   - Array of { product, quantity, ... }
 * @param {string} opts.city    - City string (may be raw user input)
 * @param {string} opts.area    - Area/suburb string
 * @returns {Array} Array of SupplierProfile documents, sorted by score desc, max 12
 */
export async function findSuppliersForRequest({ items = [], city = null, area = null }) {
  if (!items.length) return [];

  const intentResult = classifyRequestItems(items);
  const { dominant, profileType } = intentResult;

  const allowedCats = INTENT_TO_SUPPLIER_CATEGORIES[dominant] || [];

  // ── Build focused DB query ────────────────────────────────────────────────
  const query = {
    active: true,
    $and: [
      { $or: [{ suspended: false }, { suspended: { $exists: false } }] },
      { $or: [{ subscriptionStatus: "active" }, { subscriptionStatus: "trial" }] },
    ],
  };

  // Location gate
  const normalizedCity = normalizeCityForSearch(city || "");
  if (normalizedCity) {
    query["location.city"] = new RegExp(`^${normalizedCity}$`, "i");
  }

  // Category gate in DB query (narrow the fetch before scoring)
  if (allowedCats.length > 0) {
    query.categories = { $in: allowedCats };
  }

  // ProfileType gate (hard filter for non-ambiguous intents)
  if (profileType && dominant !== "other") {
    query.profileType = profileType;
  }

  // Intentionally NOT matching businessName — that's the root cause of overmatch

  let candidates = await SupplierProfile.find(query)
    .sort({ tierRank: -1, credibilityScore: -1, rating: -1 })
    .limit(80)
    .lean();

  // If city filter returned 0 results, relax city constraint and retry
  if (normalizedCity && candidates.length === 0) {
    const relaxedQuery = { ...query };
    delete relaxedQuery["location.city"];
    candidates = await SupplierProfile.find(relaxedQuery)
      .sort({ tierRank: -1, credibilityScore: -1, rating: -1 })
      .limit(80)
      .lean();
  }

  // If category filter returned 0 results and intent is "other", relax category
  if (candidates.length === 0 && dominant === "other") {
    const openQuery = {
      active: true,
      $and: [
        { $or: [{ suspended: false }, { suspended: { $exists: false } }] },
        { $or: [{ subscriptionStatus: "active" }, { subscriptionStatus: "trial" }] },
      ],
    };
    if (normalizedCity) openQuery["location.city"] = new RegExp(`^${normalizedCity}$`, "i");
    candidates = await SupplierProfile.find(openQuery)
      .sort({ tierRank: -1, credibilityScore: -1, rating: -1 })
      .limit(80)
      .lean();
  }

  // ── Score and filter ──────────────────────────────────────────────────────
  const scored = [];
  for (const supplier of candidates) {
    const result = scoreSupplierForRequest(supplier, items, intentResult);
    if (result) {
      scored.push({ supplier, ...result });
    }
  }

  // Sort: item match first, then by totalScore desc
  scored.sort((a, b) => {
    if (b.hasItemMatch !== a.hasItemMatch) return b.hasItemMatch ? 1 : -1;
    return b.totalScore - a.totalScore;
  });

  console.log(`[REQUEST-MATCH] intent="${dominant}" profileType="${profileType}" city="${normalizedCity}" candidates=${candidates.length} qualified=${scored.length}`);

  return scored.slice(0, 12).map(e => e.supplier);
}