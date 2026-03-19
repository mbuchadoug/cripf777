


// Add this at the top of the file (after imports are set up in the route context)
// OR create a separate async helper in supplierRegistration.js:

// In supplierRegistration.js or chatbotEngine.js, replace:
//   const template = getTemplateForCategory(catId);
// With:
//   const template = await getTemplateForCategoryWithDB(catId);

// Add this helper function in supplierProductTemplates.js:
export async function getTemplateForCategoryWithDB(catId) {
  try {
    const CategoryPreset = (await import("../models/categoryPreset.js")).default;
    const dbPreset = await CategoryPreset.findOne({ catId, isActive: true }).lean();
    if (dbPreset) {
      return {
        isAdminPreset: true,
        adminNote: dbPreset.adminNote,
        products: dbPreset.products,
        prices: dbPreset.prices,
        subcatMap: dbPreset.subcatMap?.length
          ? Object.fromEntries(dbPreset.subcatMap.map(s => [s.label, s.products]))
          : null
      };
    }
  } catch (_) {
    // DB unavailable - fall through to static
  }
  // Fallback to static templates
  return TEMPLATES[catId] || null;
}


// services/supplierProductTemplates.js
export const SUPPLIER_PRODUCT_TEMPLATES = {
  plumbing: {
    label: "🔧 Plumbing",
    products: [
      "access tee", "110mm vent horn", "1/2 female elbow", "1/2 cap elbow",
      "1/2 cap tee", "1/2 cu-iron", "shower mixer", "angle valve",
      "1/2 cu-pipe", "3/4 cu-pipe", "22mm cu-elbow", "22mm cu-tee",
      "25mm pvc elbow", "25mm pvc tee", "3/4 gate valve", "15mm crossover",
      "32mm poly tee", "32mm end cap", "silicon", "basin bolt",
      "close couple set", "hand basin pedestal", "basin mixer",
      "basin waste", "50mm ie bend", "50mm ie tee", "50mm waste pipe", "shower trap"
    ]
  },
  groceries: {
    label: "🛒 Groceries",
    products: [
      "cooking oil", "rice", "sugar", "flour", "salt", "bread",
      "milk", "eggs", "margarine", "tea", "coffee", "soap",
      "washing powder", "matches", "candles", "tomatoes", "onions"
    ]
  },
  hardware: {
    label: "🏗 Hardware",
    products: [
      "cement", "river sand", "pit sand", "bricks", "roofing sheets",
      "nails", "screws", "hinges", "padlock", "paint", "primer",
      "steel bar", "binding wire", "wheelbarrow", "spade"
    ]
  },
  electrical: {
    label: "⚡ Electrical",
    products: [
      "circuit breaker", "cable 1.5mm", "cable 2.5mm", "cable 4mm",
      "conduit pipe", "conduit box", "socket outlet", "light switch",
      "distribution board", "earth leakage", "plug top", "lamp holder",
      "led bulb", "extension cord", "fluorescent tube"
    ]
  },
  car_supplies: {
    label: "🚗 Car Parts & Supplies",
    products: [
      "engine oil", "gear oil", "brake fluid", "coolant",
      "car battery", "spark plugs", "brake pads", "brake discs",
      "air filter", "oil filter", "fuel filter", "timing belt",
      "wiper blades", "headlight bulb", "car fuse", "jump cables",
      "tyre", "inner tube", "rim", "wheel nut",
      "radiator hose", "fan belt", "alternator belt", "water pump",
      "shock absorber", "ball joint", "tie rod", "wheel bearing",
      "car jack", "car battery charger", "tow rope", "car polish"
    ]
  }

};

export function getTemplateForCategory(categoryId) {
  return SUPPLIER_PRODUCT_TEMPLATES[categoryId] || null;
}