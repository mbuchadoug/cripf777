/**
 * invoiceAdapters.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Meta WhatsApp button handlers for the client-selection step of all three
 * document flows (invoice / quotation / receipt).
 *
 * CHANGES FROM ORIGINAL:
 *   • Uses preserveSessionCore() - eliminates duplicated docType / targetBranchId
 *     extraction that existed in every function
 *   • Uses sendAddItemPrompt() - eliminates duplicated sendButtons call
 *   • All existing exports preserved with identical signatures
 * ─────────────────────────────────────────────────────────────────────────────
 */

import Business    from "../models/business.js";
import UserSession from "../models/userSession.js";
import Client      from "../models/client.js";
import { sendList, sendText } from "./metaSender.js";
import { preserveSessionCore, sendAddItemPrompt } from "./invoiceHelpers.js";

// ─── Guard: WhatsApp list-row titles must be ≤ 24 characters ──────────────────
// A saved client whose name is longer than 24 chars would make Meta reject the
// entire list message with HTTP 400. Clamp so long names never break selection.
function clampRowTitle(title, max = 24) {
  const str   = String(title == null ? "" : title);
  const chars = Array.from(str);
  return chars.length <= max ? str : chars.slice(0, max - 1).join("") + "…";
}

// ─── Internal: walk-in / generic client ──────────────────────────────────────

async function getOrCreateGenericClient(businessId) {
  return Client.findOneAndUpdate(
    { businessId, phone: "walk-in" },
    {
      $setOnInsert: {
        businessId,
        name:      "Walk-in Customer",
        phone:     "walk-in",
        isGeneric: true
      }
    },
    { upsert: true, new: true }
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// handleSkipClient
// Button: "⏭ Skip client"
// Sets a generic Walk-in client and moves to item-adding.
// ─────────────────────────────────────────────────────────────────────────────
export async function handleSkipClient(to) {
  const phone   = to.replace(/\D+/g, "");
  const session = await UserSession.findOne({ phone });
  const biz     = await Business.findById(session?.activeBusinessId);

  if (!biz) return sendText(to, "❌ No active business.");

  const core   = preserveSessionCore(biz);
  const client = await getOrCreateGenericClient(biz._id);

  biz.sessionData = {
    ...core,
    clientId:     client._id,
    client,
    items:        [],
    itemMode:     null,
    lastItem:     null,
    expectingQty: false
  };
  biz.sessionState = "creating_invoice_add_items";
  biz.markModified("sessionData");
  await biz.save();

  return sendAddItemPrompt(to, biz);
}

// ─────────────────────────────────────────────────────────────────────────────
// handleChooseSavedClient
// Button: "📋 Saved client"
// Shows a list of recent clients or falls back to new-client name entry.
// ─────────────────────────────────────────────────────────────────────────────
export async function handleChooseSavedClient(to) {
  const phone   = to.replace(/\D+/g, "");
  const session = await UserSession.findOne({ phone });
  const biz     = await Business.findById(session?.activeBusinessId);

  if (!biz) return sendText(to, "❌ No active business.");

  const clients = await Client.find({ businessId: biz._id })
    .sort({ updatedAt: -1 })
    .limit(10)
    .lean();

  if (!clients.length) {
    const core = preserveSessionCore(biz);
    biz.sessionState = "creating_invoice_new_client";
    biz.sessionData  = { ...core };
    biz.markModified("sessionData");
    await biz.save();
    return sendText(to, "No saved clients found.\n\nEnter client name:");
  }

  biz.sessionState              = "creating_invoice_choose_client_index";
  biz.sessionData.recentClients = clients;
  biz.markModified("sessionData");
  await biz.save();

  return sendList(
    to,
    "Select client",
    clients.map(c => ({ id: `client_${c._id}`, title: clampRowTitle(c.name || c.phone) }))
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// handleNewClientFromInvoice
// Button: "➕ New client"
// Moves to the new-client name-entry state.
// ─────────────────────────────────────────────────────────────────────────────
export async function handleNewClientFromInvoice(to) {
  const phone   = to.replace(/\D+/g, "");
  const session = await UserSession.findOne({ phone });
  const biz     = await Business.findById(session?.activeBusinessId);

  if (!biz) return sendText(to, "❌ No active business.");

  const core = preserveSessionCore(biz);
  biz.sessionState = "creating_invoice_new_client";
  biz.sessionData  = { ...core };
  biz.markModified("sessionData");
  await biz.save();

  return sendText(to, "Enter client name:");
}

// ─────────────────────────────────────────────────────────────────────────────
// handleClientPicked
// List selection: user tapped a saved client from the list
// ─────────────────────────────────────────────────────────────────────────────
export async function handleClientPicked(to, clientId) {
  const phone   = to.replace(/\D+/g, "");
  const session = await UserSession.findOne({ phone });
  const biz     = await Business.findById(session?.activeBusinessId);

  if (!biz)    return sendText(to, "❌ No active business.");

  const client = await Client.findById(clientId);
  if (!client) return sendText(to, "❌ Client not found.");

  const core = preserveSessionCore(biz);

  biz.sessionData = {
    ...core,
    clientId:     client._id,
    client,
    items:        [],
    itemMode:     null,
    lastItem:     null,
    expectingQty: false
  };
  biz.sessionState = "creating_invoice_add_items";
  biz.markModified("sessionData");
  await biz.save();

  return sendAddItemPrompt(to, biz);
}