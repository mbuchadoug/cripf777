import Business from "../models/business.js";
import UserSession from "../models/userSession.js";
import Client from "../models/client.js";
import { sendList, sendText, sendButtons } from "./metaSender.js";


/**
 * ✅ NEW: Create or get generic "Walk-in Customer" client
 */
async function getOrCreateGenericClient(businessId) {
  const genericClient = await Client.findOneAndUpdate(
    { 
      businessId, 
      phone: "walk-in" 
    },
    { 
      $setOnInsert: {
        businessId,
        name: "Walk-in Customer",
        phone: "walk-in",
        isGeneric: true
      }
    },
    { 
      upsert: true, 
      new: true 
    }
  );

  return genericClient;
}

/**
 * ✅ NEW: Handle skip client action (Meta)
 */
export async function handleSkipClient(to) {
  const phone = to.replace(/\D+/g, "");
  const session = await UserSession.findOne({ phone });
  const biz = await Business.findById(session?.activeBusinessId);

  if (!biz) return sendText(to, "❌ No active business.");

  // Create or get generic client
  const client = await getOrCreateGenericClient(biz._id);

  // ✅ PRESERVE docType before resetting
const docType = biz.sessionData?.docType || "invoice";
const targetBranchId = biz.sessionData?.targetBranchId || null; // ✅ preserve

biz.sessionData = {
  docType,
  targetBranchId, // ✅ keep it
  clientId: client._id,
  client,
  items: [],
  itemMode: null,
  lastItem: null,
  expectingQty: false
};

  biz.sessionState = "creating_invoice_add_items";
  biz.markModified("sessionData");
  await biz.save();

  return sendButtons(to, {
    text: "How would you like to add an item?",
    buttons: [
      { id: "inv_item_catalogue", title: "📦 Catalogue" },
      { id: "inv_item_custom", title: "✍️ Custom item" }
    ]
  });
}

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
    // ✅ PRESERVE docType before resetting
    const docType = biz.sessionData?.docType || "invoice";
    
    biz.sessionState = "creating_invoice_new_client";
    biz.sessionData = { docType };  // ✅ Keep docType
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
      id: `client_${c._id}`,
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

  // ✅ PRESERVE docType before resetting
const docType = biz.sessionData?.docType || "invoice";
const targetBranchId = biz.sessionData?.targetBranchId || null; // ✅ preserve

biz.sessionState = "creating_invoice_new_client";
biz.sessionData = { docType, targetBranchId };
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

  // ✅ PRESERVE docType before resetting
  const docType = biz.sessionData?.docType || "invoice";
const targetBranchId = biz.sessionData?.targetBranchId || null; // ✅ preserve

biz.sessionData = {
  docType,
  targetBranchId, // ✅ keep it
  clientId: client._id,
  client,
  items: [],
  itemMode: null,
  lastItem: null,
  expectingQty: false
};
  biz.sessionState = "creating_invoice_add_items";
  biz.markModified("sessionData");
  await biz.save();

  return sendButtons(to, {
    text: "How would you like to add an item?",
    buttons: [
      { id: "inv_item_catalogue", title: "📦 Catalogue" },
      { id: "inv_item_custom", title: "✍️ Custom item" }
    ]
  });
}