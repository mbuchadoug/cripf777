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
  { id: "groceries", label: "🛒 Groceries & Food" },
  { id: "clothing", label: "👗 Clothing & Shoes" },
  { id: "hardware", label: "🏗 Hardware & Building" },
  { id: "agriculture", label: "🌽 Agriculture & Farming" },
  { id: "electronics", label: "📱 Electronics" },
  { id: "crossborder", label: "✈️ Cross-border Goods" },
 { id: 'cosmetics',   label: '💄 Cosmetics & Beauty' },
  { id: 'furniture',   label: '🛋 Furniture & Home' },
  { id: 'services',    label: '🔧 Services & Trades' },
  { id: 'health',      label: '💊 Health & Pharmacy' },
  { id: 'transport',   label: '🚛 Transport & Logistics' },
  { id: 'food_cooked', label: '🍱 Cooked Food & Catering' },
  { id: 'printing',    label: '🖨 Printing & Stationery' },
  { id: 'other',       label: '🗂 Other' }
];