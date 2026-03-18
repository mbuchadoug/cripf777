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

export async function notifySupplierNewOrder(supplierPhone, order, buyerPhone, options = {}) {
  const { isBooking } = options;

  // ── Booking notification (service providers) ──────────────────────────────
  if (isBooking) {
    const service  = order.items?.[0]?.product || "Service";
    const location = order.delivery?.address   || "Not specified";
    const when     = order.supplierNote        || "Not specified";
    return sendButtons(supplierPhone, {
      text:
        `📅 *New Booking Request!*\n\n` +
        `🔧 Service: ${service}\n` +
        `📍 Location: ${location}\n` +
        `🗓 When: ${when}\n` +
        `📞 Buyer: ${buyerPhone || order.buyerPhone}`,
      buttons: [
        { id: `sup_book_confirm_${order._id}`, title: "✅ Accept Booking" },
        { id: `sup_decline_${order._id}`,      title: "❌ Decline" }
      ]
    });
  }

 const itemLines = formatOrderItems(order.items);

const supplier = await SupplierProfile.findOne({ phone: supplierPhone }).lean();
const isServiceSupplier = supplier?.profileType === "service";

const deliveryLine = order.delivery?.required
  ? `🚚 Delivery: ${order.delivery.address || "Address not provided"}`
  : isServiceSupplier
    ? `📍 Service location: ${order.delivery?.address || "Not specified"}`
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
    `${isServiceSupplier ? "📅" : "🛒"} *${isServiceSupplier ? "New Booking Request!" : "New Order!"}*\n\n` +
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
  const isServiceSupplier = supplier?.profileType === "service";

  if (hasPricing) {
    order.status = "accepted";
    await order.save();

  // FIXED - also increments completedOrders
await SupplierProfile.findOneAndUpdate(
  { phone: from },
  { $inc: { monthlyOrders: 1, completedOrders: 1 } }
);

    const itemLines = order.items
      .map(i => {
        const unitSuffix = i.unit && i.unit !== "units" ? ` ${i.unit}` : "";
        return `• ${i.product} x${i.quantity}${unitSuffix} @ $${Number(i.pricePerUnit).toFixed(2)} = $${Number(i.total).toFixed(2)}`;
      })
      .join("\n");

    const deliveryLine = order.delivery?.required
      ? `🚚 Delivery: ${order.delivery.address || "Address not provided"}`
      : isServiceSupplier
        ? `📍 Service location: ${order.delivery?.address || "Not specified"}`
        : "🏠 Collection";

    try {
      await sendButtons(order.buyerPhone, {
        text:
          `✅ *${isServiceSupplier ? "Booking Accepted!" : "Order Accepted!"}*\n\n` +
          `*${supplier?.businessName || from}* has accepted your ${isServiceSupplier ? "booking" : "order"}:\n\n` +
          `${itemLines}\n\n` +
          `${deliveryLine}\n` +
          `💵 *${isServiceSupplier ? "Booking Total" : "Order Total"}: $${Number(order.totalAmount).toFixed(2)}*\n` +
          `📞 Contact: ${from}\n\n` +
          `They will be in touch to arrange ${isServiceSupplier ? "the service" : "payment & delivery"}.`,
        buttons: [
          { id: `rate_order_${order._id}`, title: isServiceSupplier ? "⭐ Rate Service" : "⭐ Rate Order" },
          { id: "suppliers_home", title: "🏪 Suppliers" }
        ]
      });
    } catch (err) {
      console.error("[SUPPLIER AUTO-ACCEPT → BUYER NOTIFY FAILED]", err?.response?.data || err.message);
    }

    return sendList(
      from,
      `✅ ${isServiceSupplier ? "Booking accepted" : "Order accepted"}. Total: $${Number(order.totalAmount).toFixed(2)}\n\n${isServiceSupplier ? "When will you do the job?" : "When will the order be ready?"}`,
      [
        { id: `sup_eta_today_${orderId}`, title: "Today" },
        { id: `sup_eta_tomorrow_${orderId}`, title: "Tomorrow" },
        { id: `sup_eta_twodays_${orderId}`, title: "2-3 days" },
        { id: `sup_eta_contact_${orderId}`, title: "I'll contact buyer" }
      ]
    );
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

  // Build a numbered pricing form — each line shows exactly what needs a price
  // Format: "1. cement × 10 bags → price per bag = ?"
  const pricingLines = order.items.map((item, i) => {
    const qty = Number(item.quantity) || 1;
    const unitLabel = item.unit && item.unit !== "units" ? item.unit : (isServiceSupplier ? "job" : "unit");
    return `${i + 1}. *${item.product}* × ${qty} ${unitLabel}\n   → Your price per ${unitLabel}: ❓`;
  }).join("\n\n");

  // Build a concrete example using the ACTUAL first item from the order
  const firstItem = order.items[0];
  const firstQty = Number(firstItem?.quantity) || 1;
  const firstUnit = firstItem?.unit && firstItem.unit !== "units"
    ? firstItem.unit
    : (isServiceSupplier ? "job" : "unit");

  let instructions;
  if (order.items.length === 1) {
    // Single item — very explicit
    instructions =
      `💡 *Enter the price per ${firstUnit}.*\n\n` +
      `Example: If *${firstItem?.product}* costs *$12* per ${firstUnit},\n` +
      `and the buyer wants *${firstQty}*, total = *$${12 * firstQty}*.\n\n` +
      `So just type: *12*\n\n` +
      `_The system multiplies your unit price × quantity automatically._`;
  } else {
    // Multiple items — numbered, explicit per-unit
    const examplePrices = order.items.map((_, i) => ((i + 1) * 5 + 7)).join(", ");
    const exampleLines = order.items.map((item, i) => {
      const qty = Number(item.quantity) || 1;
      const unitPrice = (i + 1) * 5 + 7;
      const exUnit = item.unit && item.unit !== "units" ? item.unit : (isServiceSupplier ? "job" : "unit");
      return `  ${i + 1}. ${item.product}: $${unitPrice}/per ${exUnit} × ${qty} = $${unitPrice * qty}`;
    }).join("\n");

    instructions =
      `💡 *Enter price per unit for each item, in order, separated by commas.*\n\n` +
      `Example reply: *${examplePrices}*\n` +
      `That means:\n${exampleLines}\n\n` +
      `_Enter ${order.items.length} prices. The system calculates totals automatically._`;
  }

  return sendButtons(from, {
    text:
      `💰 *Price This ${isServiceSupplier ? "Booking" : "Order"}*\n` +
      `_Buyer: ${order.buyerPhone}_\n\n` +
      `─────────────────\n` +
      `*What was ordered:*\n\n` +
      `${pricingLines}\n\n` +
      `─────────────────\n` +
      `${instructions}`,
    buttons: [{ id: "suppliers_home", title: "⬅ Back" }]
  });
}

export async function handleBookingAccepted(from, orderId) {
  const order = await SupplierOrder.findById(orderId);
  if (!order) {
    await sendText(from, "❌ Booking not found.");
    return;
  }

  order.status = "accepted";
  await order.save();

// FIXED - also increments completedOrders
await SupplierProfile.findOneAndUpdate(
  { phone: from },
  { $inc: { monthlyOrders: 1, completedOrders: 1 } }
);

  const supplier = await SupplierProfile.findOne({ phone: from });

  // Notify buyer
  try {
    await sendButtons(order.buyerPhone, {
      text:
        `✅ *Booking Accepted!*\n\n` +
        `*${supplier?.businessName || from}* has accepted your booking.\n\n` +
        `🔧 ${order.items?.[0]?.product || "Service"}\n` +
        `📍 ${order.delivery?.address || "Location TBC"}\n` +
        `🗓 ${order.supplierNote || "Time TBC"}\n\n` +
        `📞 Contact: ${from}\n\n` +
        `They will be in touch to confirm details.`,
      buttons: [
        { id: `rate_order_${order._id}`, title: "⭐ Rate Service" },
        { id: "suppliers_home",           title: "🏪 Suppliers" }
      ]
    });
  } catch (err) {
    console.error("[BOOKING ACCEPT → BUYER NOTIFY FAILED]", err?.response?.data || err.message);
  }

  return sendButtons(from, {
    text: `✅ *Booking confirmed!*\n\nThe buyer has been notified. Contact them at ${order.buyerPhone} to arrange the job.`,
    buttons: [
    { id: "sup_my_orders",   title: "📦 Orders From Buyers" },
      { id: "suppliers_home",  title: "🏪 Suppliers" }
    ]
  });
}



export async function handleOrderDeclined(from, orderId, biz, saveBiz) {
  biz.sessionState = "supplier_decline_reason";
  biz.sessionData = {
    ...(biz.sessionData || {}),
    declineOrderId: orderId
  };
  await saveBiz(biz);

  return sendList(from, "Why are you declining?", [
    { id: "dec_out_of_stock", title: "Out of stock" },
    { id: "dec_min_not_met", title: "Min order not met" },
    { id: "dec_no_delivery", title: "Cannot deliver to area" },
    { id: "dec_price_changed", title: "Price has changed" },
    { id: "dec_other", title: "Other reason" }
  ]);
}