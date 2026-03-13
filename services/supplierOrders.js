import SupplierOrder from "../models/supplierOrder.js";
import SupplierProfile from "../models/supplierProfile.js";
import { sendText, sendButtons, sendList } from "./metaSender.js";

function formatOrderItems(items = []) {
  if (!Array.isArray(items) || !items.length) return "• No items";

  return items.map(i => {
    const name = i.product || "Item";
    const qty = i.quantity ?? 1;
    const unitSuffix = i.unit && i.unit !== "units" ? ` ${i.unit}` : "";
    const lineTotal = typeof i.total === "number" ? ` - $${i.total.toFixed(2)}` : "";
    return `• ${name} x${qty}${unitSuffix}${lineTotal}`;
  }).join("\n");
}

export async function notifySupplierNewOrder(supplierPhone, order) {
  const itemLines = formatOrderItems(order.items);

  const deliveryLine = order.delivery?.required
    ? `🚚 Deliver to: ${order.delivery.address}`
    : "🏠 Collection";

  const hasPricing =
    Array.isArray(order.items) &&
    order.items.length > 0 &&
    order.items.every(i => typeof i.pricePerUnit === "number" && typeof i.total === "number");

  const totalLine = hasPricing
    ? `💵 Total: $${Number(order.totalAmount || 0).toFixed(2)}`
    : `💵 Total: Pending - set your price when accepting`;

  await sendButtons(supplierPhone, {
    text:
      `🛒 *New Order!*\n\n` +
      `${itemLines}\n\n` +
      `${totalLine}\n` +
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

  const hasPricing =
    Array.isArray(order.items) &&
    order.items.length > 0 &&
    order.items.every(i => typeof i.pricePerUnit === "number" && typeof i.total === "number") &&
    typeof order.totalAmount === "number" &&
    order.totalAmount > 0;

  const supplier = await SupplierProfile.findOne({ phone: from });

  if (hasPricing) {
    order.status = "accepted";
    await order.save();

    await SupplierProfile.findOneAndUpdate(
      { phone: from },
      { $inc: { monthlyOrders: 1 } }
    );

    const itemLines = order.items
      .map(i => {
        const unitSuffix = i.unit && i.unit !== "units" ? ` ${i.unit}` : "";
        return `• ${i.product} x${i.quantity}${unitSuffix} @ $${Number(i.pricePerUnit).toFixed(2)} = $${Number(i.total).toFixed(2)}`;
      })
      .join("\n");

    const deliveryLine = order.delivery?.required
      ? `🚚 Delivery: ${order.delivery.address || "Address not provided"}`
      : "🏠 Collection";

    try {
      await sendButtons(order.buyerPhone, {
        text:
          `✅ *Order Accepted!*\n\n` +
          `*${supplier?.businessName || from}* has accepted your order:\n\n` +
          `${itemLines}\n\n` +
          `${deliveryLine}\n` +
          `💵 *Order Total: $${Number(order.totalAmount).toFixed(2)}*\n` +
          `📞 Contact: ${from}\n\n` +
          `They will be in touch to arrange payment & delivery.`,
        buttons: [
          { id: `rate_order_${order._id}`, title: "⭐ Rate Order" },
          { id: "menu", title: "🏠 Main Menu" }
        ]
      });
    } catch (err) {
      console.error("[SUPPLIER AUTO-ACCEPT → BUYER NOTIFY FAILED]", err?.response?.data || err.message);
    }

    return sendList(from, `✅ Order accepted. Total: $${Number(order.totalAmount).toFixed(2)}\n\nWhen will the order be ready?`, [
      { id: `sup_eta_today_${orderId}`, title: "Today" },
      { id: `sup_eta_tomorrow_${orderId}`, title: "Tomorrow" },
      { id: `sup_eta_twodays_${orderId}`, title: "2-3 days" },
      { id: `sup_eta_contact_${orderId}`, title: "I'll contact buyer" }
    ]);
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