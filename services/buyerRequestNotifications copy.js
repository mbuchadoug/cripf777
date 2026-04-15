// services/buyerRequestNotifications.js
// ─── Buyer Request — Meta Template Notifications ─────────────────────────────
//
// Sends WhatsApp template messages to suppliers so they are reached even
// when they haven't messaged the bot in the last 24 hours.
//
// Template must be pre-approved in Meta Business Manager before use.
// See README / implementation guide for template submission details.
//
// Falls back to a regular sendButtons() call if the template fails
// (works within the 24-hour session window).

import axios   from "axios";
import { sendButtons, sendText } from "./metaSender.js";

const GRAPH_API_VERSION = "v19.0";
const PHONE_NUMBER_ID   =
  process.env.WHATSAPP_PHONE_NUMBER_ID ||
  process.env.META_PHONE_NUMBER_ID     ||
  process.env.PHONE_NUMBER_ID;
const ACCESS_TOKEN =
  process.env.META_ACCESS_TOKEN ||
  process.env.WHATSAPP_ACCESS_TOKEN;

  

// ─── Low-level: send a pre-approved Meta template message ─────────────────────
async function _sendTemplate(to, templateName, variables = []) {
  const phone = String(to).replace(/\D+/g, "");

  const components = variables.length
    ? [{
        type:       "body",
        parameters: variables.map(v => ({ type: "text", text: String(v).slice(0, 1024) }))
      }]
    : [];

  const res = await axios.post(
    `https://graph.facebook.com/${GRAPH_API_VERSION}/${PHONE_NUMBER_ID}/messages`,
    {
      messaging_product: "whatsapp",
      to,
      type:     "template",
      template: {
        name:       templateName,
        language:   { code: "en" },
        components
      }
    },
    {
      headers: {
        Authorization:  `Bearer ${ACCESS_TOKEN}`,
        "Content-Type": "application/json"
      }
    }
  );

  return res.data;
}

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC: Notify a supplier of a new buyer request
// ─────────────────────────────────────────────────────────────────────────────
//
// Submit this template body to Meta Business Manager:
//
//   Template name: supplier_new_buyer_request
//   Category:      UTILITY
//   Language:      English (en)
//
//   Body text:
//   "🔥 New buyer request on ZimQuote!\n
//   Reference: {{1}}\n
//   Location: {{2}}\n
//   Items: {{3}}\n
//   Open the ZimQuote chatbot now to send your quote and win this customer."
//
// Variables:
//   {{1}} = REQ-XXXX
//   {{2}} = e.g. "Avondale, Harare"
//   {{3}} = e.g. "Cement (10 bags), River sand (2 trips)"
//
// ─────────────────────────────────────────────────────────────────────────────
export async function notifySupplierNewRequestTemplate({
  supplierPhone,
  requestId,
  ref,
  locationText,
  itemSummary
}) {
  try {
    await _sendTemplate(supplierPhone, "supplier_new_buyer_request", [
      ref,
      locationText,
      itemSummary
    ]);
    console.log(`[BUY REQ TPL] supplier_new_buyer_request → ${supplierPhone} (${ref})`);
  } catch (err) {
    console.warn(`[BUY REQ TPL] template failed for ${supplierPhone}: ${err.message}. Falling back.`);
    // Fallback: plain sendButtons (only works within 24h session window)
    try {
      await sendButtons(supplierPhone, {
        text:
          `🔥 *New Buyer Request* (${ref})\n\n` +
          `📍 ${locationText}\n\n` +
          `📦 Items: ${itemSummary}\n\n` +
          `Open ZimQuote and tap *Send Offer* to quote this buyer.`,
        buttons: [
          { id: `req_offer_${requestId}`,   title: "💬 Send Offer" },
          { id: `req_unavail_${requestId}`, title: "❌ Not Available" }
        ]
      });
    } catch (fallbackErr) {
      console.error(`[BUY REQ TPL] fallback also failed: ${fallbackErr.message}`);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC: Remind supplier of unanswered request (5 min nudge)
// ─────────────────────────────────────────────────────────────────────────────
//
//   Template name: supplier_request_reminder
//   Category:      UTILITY
//   Language:      English (en)
//
//   Body text:
//   "⏰ Reminder: A buyer is waiting for your quote on ZimQuote!\n
//   Reference: {{1}}\n
//   Items: {{2}}\n
//   This request closes in {{3}} minutes. Tap to respond now."
//
// ─────────────────────────────────────────────────────────────────────────────
export async function remindSupplierOfPendingRequest({
  supplierPhone,
  requestId,
  ref,
  itemSummary,
  minutesRemaining = 10
}) {
  try {
    await _sendTemplate(supplierPhone, "supplier_request_reminder", [
      ref,
      itemSummary,
      String(minutesRemaining)
    ]);
    console.log(`[BUY REQ REMIND] supplier_request_reminder → ${supplierPhone} (${ref})`);
  } catch (err) {
    console.warn(`[BUY REQ REMIND] template failed: ${err.message}`);
    try {
      await sendText(
        supplierPhone,
        `⏰ *Reminder!*\n\n` +
        `A buyer is still waiting for a quote (${ref}).\n` +
        `📦 ${itemSummary}\n\n` +
        `This request closes in ${minutesRemaining} minutes.\n` +
        `Type *menu* → Marketplace → My Store to respond.`
      );
    } catch (e) { /* non-critical */ }
  }
}