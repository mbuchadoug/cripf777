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
  }
};

export function getTemplateForCategory(categoryId) {
  return SUPPLIER_PRODUCT_TEMPLATES[categoryId] || null;
}