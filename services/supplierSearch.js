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

export async function runSupplierSearch({ city, category, product, profileType }) {
  // Base query — never show suspended or inactive suppliers
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

  // Product/service free-text search — searches both product list AND priced items
  if (product) {
    const productOr = profileType === "service"
      ? [
          { products: { $regex: product, $options: "i" } },
          { "rates.service": { $regex: product, $options: "i" } },
          { categories: { $regex: product, $options: "i" } }
        ]
      : [
          { products: { $regex: product, $options: "i" } },
          { "prices.product": { $regex: product, $options: "i" } }
        ];

    // Merge into existing $and so we don't clobber the suspended $or
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
      ? (s.travelAvailable ? "🚗 Travels" : "📍 Fixed location")
      : (s.delivery?.available ? "🚚 Delivers" : "🏠 Collect");

    const min = s.minOrder > 0 ? ` · Min $${s.minOrder}` : "";
    const rating = typeof s.rating === "number" ? ` · ⭐${s.rating.toFixed(1)}` : "";

    // Show a matching product/rate if we have a search term
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

// ── Parse shortcode search from raw text ──────────────────────────────────
// Handles: "find cement", "find plumber harare", "s tiles", "/find bread"
export function parseShortcodeSearch(text = "") {
  const raw = text.trim().toLowerCase();

  // Patterns: "find X", "search X", "s X", "/find X", "buy X", "looking for X"
  const patterns = [
    /^(?:\/find|find|search|s|buy|get|looking for|need|want)\s+(.+)$/i,
    /^(?:find me|i need|i want)\s+(.+)$/i
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

// Splits "plumber harare" into { product: "plumber", city: "Harare" }
function parseQueryWithCity(query = "") {
  // Import SUPPLIER_CITIES inline to avoid circular dependency
  const KNOWN_CITIES = [
    "harare", "bulawayo", "mutare", "gweru", "masvingo",
    "kwekwe", "kadoma", "chinhoyi", "victoria falls"
  ];

  const words = query.trim().split(/\s+/);
  let city = null;

  // Check if last word(s) match a city
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