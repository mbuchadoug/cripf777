import SupplierOrder from "../models/supplierOrder.js";
import SupplierProfile from "../models/supplierProfile.js";
import { sendText, sendButtons, sendList } from "./metaSender.js";

function formatOrderItems(items = []) {
  if (!Array.isArray(items) || !items.length) return "• No items";

  return items.map(i => {
    const name = i.product || "Item";
    const qty = i.quantity ?? 1;
    const unitSuffix = i.unit && i.unit !== "units" ? ` ${i.unit}` : "";
    const lineTotal = typeof i.total === "number" ? ` — $${i.total.toFixed(2)}` : "";
    return `• ${name} x${qty}${unitSuffix}${lineTotal}`;
  }).join("\n");
}

export async function notifySupplierNewOrder(supplierPhone, order) {
  const itemLines = formatOrderItems(order.items);

  const deliveryLine = order.delivery?.required
    ? `🚚 Deliver to: ${order.delivery.address}`
    : "🏠 Collection";

  await sendButtons(supplierPhone, {
    text:
      `🛒 *New Order!*\n\n` +
      `${itemLines}\n\n` +
      `💵 Total: Pending — set your price when accepting\n` +
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
  if (!order) {
    await sendText(from, "❌ Order not found.");
    return;
  }

  if (!biz) {
    await sendText(from, "❌ Session expired. Type *menu* and try again.");
    return;
  }

  biz.sessionState = "supplier_order_enter_price";
  biz.sessionData = {
    ...(biz.sessionData || {}),
    pricingOrderId: orderId
  };
  await saveBiz(biz);

  const itemLines = formatOrderItems(order.items);

  const instructions =
    order.items.length === 1
      ? "Reply with the *unit price*.\nExample: *4.50*"
      : "Reply with prices in item order, separated by commas.\nExample: *4.50, 8, 1.20*";

  return sendButtons(from, {
    text:
      `💰 *Set Price for Order*\n\n` +
      `${itemLines}\n\n` +
      `${instructions}`,
    buttons: [{ id: "suppliers_home", title: "🏪 Back" }]
  });
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