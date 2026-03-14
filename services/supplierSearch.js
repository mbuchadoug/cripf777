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
  const query = {
    active: true,
    suspended: false,
    subscriptionStatus: "active"
  };

  if (profileType) query.profileType = profileType;
  if (city) query["location.city"] = city;
  if (category) query.categories = category;

  if (product) {
    query.products = {
      $regex: product,
      $options: "i"
    };
  }

  return SupplierProfile.find(query)
    .sort({ tierRank: -1, credibilityScore: -1 })
    .limit(10)
    .lean();
}
export function formatSupplierResults(suppliers, city, category) {
  if (!suppliers.length) return null;

  const lines = suppliers.map((s, i) => {
    const badge = s.tier === "featured" ? "🔥 "
      : s.tier === "pro" ? "⭐ " : "";
    const delivery = s.delivery?.available ? "🚚 Delivers" : "🏠 Collect";
    const min = s.minOrder > 0 ? `| Min $${s.minOrder}` : "";
    return {
      id: `sup_view_${s._id}`,
      title: `${badge}${s.businessName}`,
      description: `${delivery} ${min} | ⭐${s.rating.toFixed(1)}`
    };
  });

  return lines;
}