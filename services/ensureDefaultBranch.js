// services/ensureDefaultBranch.js
export async function ensureDefaultBranch(bizId) {
  const Branch = (await import("../models/branch.js")).default;

  const existing = await Branch.find({ businessId: bizId }).sort({ name: 1 }).lean();
  if (existing.length) return { branches: existing, defaultBranch: existing[0], created: false };

  // Auto-heal: create a default branch for businesses that "don't use branches"
  const createdBranch = await Branch.create({
    businessId: bizId,
    name: "Main Branch",
    isDefault: true
  });

  return { branches: [createdBranch.toObject?.() || createdBranch], defaultBranch: createdBranch, created: true };
}