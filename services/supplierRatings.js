// services/supplierRatings.js

import SupplierProfile from "../models/supplierProfile.js";
import SupplierOrder from "../models/supplierOrder.js";

export async function sendRatingPrompt(buyerPhone, orderId) {
  const { sendButtons } = await import("./metaSender.js");
  const order = await SupplierOrder.findById(orderId);
  if (!order || order.ratingPromptSent) return;

  order.ratingPromptSent = true;
  await order.save();

  await sendButtons(buyerPhone, {
    text: `⭐ How was your order?\n\nRate your experience with the supplier`,
    buttons: [
      { id: `rate_poor_${orderId}`, title: "😞 Poor" },
      { id: `rate_ok_${orderId}`, title: "😐 OK" },
      { id: `rate_great_${orderId}`, title: "😍 Great" }
    ]
  });
}

export async function updateSupplierCredibility(supplierId) {
  const supplier = await SupplierProfile.findById(supplierId);
  if (!supplier) return;

  // Credibility formula
  let score = 0;

  // Rating weight (0-50 points)
  score += (supplier.rating / 5) * 50;

  // Completed orders weight (0-20 points)
  score += Math.min(supplier.completedOrders * 0.5, 20);

  // Verified bonus (10 points)
  if (supplier.verified) score += 10;

  // Account age bonus (0-10 points)
  const ageMonths = (Date.now() - supplier.createdAt) /
    (1000 * 60 * 60 * 24 * 30);
  score += Math.min(ageMonths, 10);

  // Dispute penalty
  score -= supplier.disputeCount * 5;

  // Top supplier badge threshold
  const topSupplier = score >= 70 && supplier.completedOrders >= 10;

  await SupplierProfile.findByIdAndUpdate(supplierId, {
    credibilityScore: Math.max(0, Math.round(score)),
    topSupplierBadge: topSupplier
  });
}