// services/supplierOrders.js

import SupplierOrder from "../models/supplierOrder.js";
import SupplierProfile from "../models/supplierProfile.js";
import { sendText, sendButtons, sendList } from "./metaSender.js";

export async function notifySupplierNewOrder(supplierPhone, order) {
  const { sendButtons } = await import("./metaSender.js");

  const itemLines = order.items
    .map(i => `• ${i.product} x${i.quantity} — $${i.total}`)
    .join("\n");

  const deliveryLine = order.delivery.required
    ? `🚚 Deliver to: ${order.delivery.address}`
    : "🏠 Collection";

  await sendButtons(supplierPhone, {
    text: `🛒 *New Order!*\n\n` +
          `${itemLines}\n\n` +
          `💵 Total: $${order.totalAmount}\n` +
          `${deliveryLine}\n` +
          `📞 Buyer: ${order.buyerPhone}`,
    buttons: [
      { id: `sup_accept_${order._id}`, title: "✅ Accept" },
      { id: `sup_decline_${order._id}`, title: "❌ Decline" }
    ]
  });
}

export async function handleOrderAccepted(from, orderId, biz, saveBiz) {
  const order = await SupplierOrder.findById(orderId);
  if (!order) return;

  order.status = "accepted";
  await order.save();

  // Update supplier stats
  await SupplierProfile.findOneAndUpdate(
    { phone: from },
    { $inc: { completedOrders: 1, monthlyOrders: 1 } }
  );

  // Notify buyer
  await sendButtons(order.buyerPhone, {
    text: `✅ *Order Accepted!*\n\n` +
          `${order.items.map(i =>
            `• ${i.product} x${i.quantity}`).join("\n")}\n\n` +
          `💵 $${order.totalAmount}\n` +
          `📞 ${from}\n\n` +
          `Contact them to arrange\n` +
          `payment & delivery.`,
    buttons: [
      { id: `rate_order_${order._id}`, title: "⭐ Rate After Delivery" },
      { id: "menu", title: "🏠 Main Menu" }
    ]
  });

  // Ask supplier for estimated time
  return sendList(from, "When will the order be ready?", [
    { id: `sup_eta_today_${orderId}`, title: "Today" },
    { id: `sup_eta_tomorrow_${orderId}`, title: "Tomorrow" },
    { id: `sup_eta_twodays_${orderId}`, title: "Within 2-3 days" },
    { id: `sup_eta_contact_${orderId}`, title: "I'll contact buyer directly" }
  ]);
}

export async function handleOrderDeclined(from, orderId, biz, saveBiz) {
  biz.sessionState = "supplier_decline_reason";
  biz.sessionData = { declineOrderId: orderId };
  await saveBiz(biz);

  return sendList(from, "Why are you declining?", [
    { id: "dec_out_of_stock", title: "Out of stock" },
    { id: "dec_min_not_met", title: "Min order not met" },
    { id: "dec_no_delivery", title: "Cannot deliver to area" },
    { id: "dec_price_changed", title: "Price has changed" },
    { id: "dec_other", title: "Other reason" }
  ]);
}