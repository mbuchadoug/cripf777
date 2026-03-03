import mongoose from "mongoose";

export function applyBranchScope({ query, webUser, branchFilter }) {
  const { role, branchId } = webUser;

  // Non-owner: hard lock to their branch
  if (role !== "owner" && branchId) {
    query.branchId = branchId;
    return;
  }

  // Owner: optional branch filter
  if (role === "owner" && branchFilter) {
    if (branchFilter === "all") return;
    if (mongoose.Types.ObjectId.isValid(branchFilter)) query.branchId = branchFilter;
  }
}