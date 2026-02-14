import Business from "../models/business.js";
import UserSession from "../models/userSession.js";
import Client from "../models/client.js";
import { sendList, sendText, sendButtons } from "./metaSender.js";

/**
 * Meta: Use saved client
 * Maps to Twilio state: creating_invoice_choose_client_index
 */
export async function handleChooseSavedClient(to) {
  const phone = to.replace(/\D+/g, "");
  const session = await UserSession.findOne({ phone });
  const biz = await Business.findById(session?.activeBusinessId);

  if (!biz) return sendText(to, "❌ No active business.");

  const clients = await Client.find({ businessId: biz._id })
    .sort({ updatedAt: -1 })
    .limit(10)
    .lean();

  if (!clients.length) {
    biz.sessionState = "creating_invoice_new_client";
    biz.sessionData = biz.sessionData || {};
    biz.markModified("sessionData");
    await biz.save();
    return sendText(to, "No saved clients. Enter client name:");
  }

  biz.sessionState = "creating_invoice_choose_client_index";
  biz.sessionData.recentClients = clients;
  biz.markModified("sessionData");
  await biz.save();

  return sendList(
    to,
    "Select client",
    clients.map(c => ({
      id: `client_${c._id}`, // ✅ correct
      title: c.name || c.phone
    }))
  );
}

/**
 * Meta: New client from invoice
 * Maps to Twilio state: creating_invoice_new_client
 */
export async function handleNewClientFromInvoice(to) {
  const phone = to.replace(/\D+/g, "");
  const session = await UserSession.findOne({ phone });
  const biz = await Business.findById(session?.activeBusinessId);

  if (!biz) return sendText(to, "❌ No active business.");

  biz.sessionState = "creating_invoice_new_client";
  biz.sessionData = {};
  await biz.save();

  return sendText(to, "Enter client name:");
}

/**
 * Meta: client picked from list
 * 🔥 FIXED: persist clientId (THIS WAS THE BUG)
 */
export async function handleClientPicked(to, clientId) {
  const phone = to.replace(/\D+/g, "");
  const session = await UserSession.findOne({ phone });
  const biz = await Business.findById(session?.activeBusinessId);

  if (!biz) return sendText(to, "❌ No active business.");

  const client = await Client.findById(clientId);
  if (!client) return sendText(to, "❌ Client not found.");

  // 🔒 CRITICAL FIX — persist durable ID
  biz.sessionData.clientId = client._id;

  // Optional cache (safe)
  biz.sessionData.client = client;

 biz.sessionState = "creating_invoice_add_items";
biz.sessionData.items = [];

// 🔥 CRITICAL RESET
biz.sessionData.itemMode = null;
biz.sessionData.lastItem = null;
biz.sessionData.expectingQty = false;


  biz.markModified("sessionData");
  await biz.save();

return sendButtons(to, {
  text: "How would you like to add an item?",
  buttons: [
    { id: "inv_item_catalogue", title: "📦 Catalogue" },
    { id: "inv_view_products", title: "👀 View items" },
    { id: "inv_item_custom", title: "✍️ Custom item" }
  ]
});


}
