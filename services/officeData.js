// services/officeData.js
// ─────────────────────────────────────────────────────────────────────────────
//  Catalogue (Product) + Client helpers for the /office web portal.
//  Uses the SAME Product / Client collections the WhatsApp bot uses, so products,
//  prices and clients created here appear on WhatsApp and vice-versa.
// ─────────────────────────────────────────────────────────────────────────────
async function models() {
  const Product = (await import("../models/product.js")).default;
  const Client  = (await import("../models/client.js")).default;
  return { Product, Client };
}

// List catalogue products (optionally branch-scoped like "View Products").
export async function listProducts({ businessId, branchId = null, includeInactive = false }) {
  const { Product } = await models();
  const q = { businessId };
  if (!includeInactive) q.isActive = true;
  if (branchId) q.$or = [{ branchId }, { branchId: null }, { branchId: { $exists: false } }];
  return Product.find(q).sort({ isService: 1, name: 1 }).lean();
}

// Create or update a product by (businessId, name) — same upsert key the bot uses.
export async function createProduct({ businessId, branchId = null, name, unitPrice = 0, isService = false }) {
  const { Product } = await models();
  name = String(name || "").trim();
  if (!name) throw new Error("Product name is required");
  return Product.findOneAndUpdate(
    { businessId, name },
    { $set: {
        businessId, name,
        unitPrice: Number(unitPrice) || 0,
        isService: !!isService,
        isActive: true,
        ...(branchId ? { branchId } : {}),
      } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
}

// Update an existing product (name / price / active) scoped to the business.
export async function updateProduct({ businessId, id, name, unitPrice, isActive }) {
  const { Product } = await models();
  const set = {};
  if (name != null && String(name).trim()) set.name = String(name).trim();
  if (unitPrice != null && unitPrice !== "") set.unitPrice = Number(unitPrice) || 0;
  if (isActive != null) set.isActive = !!isActive;
  return Product.findOneAndUpdate({ _id: id, businessId }, { $set: set }, { new: true });
}

// List clients for the picker.
export async function listClients({ businessId, limit = 500 }) {
  const { Client } = await models();
  return Client.find({ businessId }).select("name phone").sort({ name: 1 }).limit(limit).lean();
}