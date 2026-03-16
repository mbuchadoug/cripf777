// services/supplierPlans.js

export const SUPPLIER_PLANS = {
  basic: {
    name: "Basic",
    monthly: { price: 0.05, currency: "USD", durationDays: 30 },
    annual: { price: 50, currency: "USD", durationDays: 365 },
    ordersPerMonth: 10,
    tierRank: 1
  },
  pro: {
    name: "Pro",
    monthly: { price: 12, currency: "USD", durationDays: 30 },
    annual: { price: 120, currency: "USD", durationDays: 365 },
    ordersPerMonth: null, // unlimited
    tierRank: 2
  },
  featured: {
    name: "Featured",
    monthly: { price: 25, currency: "USD", durationDays: 30 },
    annual: null, // monthly only
    ordersPerMonth: null,
    maxSlotsPerCityCategory: 3,
    tierRank: 3
  }
};

export const SUPPLIER_CITIES = [
  "Harare", "Bulawayo", "Mutare",
  "Gweru", "Masvingo", "Kwekwe",
  "Kadoma", "Chinhoyi", "Victoria Falls"
];

export const SUPPLIER_CATEGORIES = [
  { id: "groceries",   label: "🛒 Groceries & Food",       types: ["product"] },
  { id: "car_supplies", label: "🚗 Car Parts & Supplies",  types: ["product"] },
  { id: "clothing",    label: "👗 Clothing & Shoes",       types: ["product"] },
  { id: "hardware",    label: "🏗 Hardware & Building",    types: ["product"] },
  { id: "agriculture", label: "🌽 Agriculture & Farming",  types: ["product"] },
  { id: "electronics", label: "📱 Electronics",            types: ["product"] },
  { id: "crossborder", label: "✈️ Cross-border Goods",     types: ["product"] },
  { id: "cosmetics",   label: "💄 Cosmetics & Beauty",     types: ["product"] },
  { id: "furniture",   label: "🛋 Furniture & Home",       types: ["product"] },

  { id: "services",    label: "🔧 Services & Trades",      types: ["service"] },
  { id: "transport",   label: "🚛 Transport & Logistics",  types: ["service"] },
  { id: "food_cooked", label: "🍱 Cooked Food & Catering", types: ["service"] },
  { id: "printing",    label: "🖨 Printing & Stationery",  types: ["service"] },

  { id: "health",      label: "💊 Health & Pharmacy",      types: ["product", "service"] },
  { id: "other",       label: "🗂 Other",                  types: ["product", "service"] }
];