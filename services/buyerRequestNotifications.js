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

const GRAPH_API_VERSION = "v24.0";
const PHONE_NUMBER_ID   =
  process.env.WHATSAPP_PHONE_NUMBER_ID ||
  process.env.META_PHONE_NUMBER_ID     ||
  process.env.PHONE_NUMBER_ID;
const ACCESS_TOKEN =
  process.env.META_ACCESS_TOKEN ||
  process.env.WHATSAPP_ACCESS_TOKEN;

// ── Helper: normalize Zimbabwean phone numbers to international format ─────────
// Handles:  0771234567  → 263771234567
//           263771234567 → 263771234567  (already correct)
//           +263771234567 → 263771234567 (strips the +)
function _normalizeZimPhone(raw = "") {
  let phone = String(raw).replace(/\D+/g, "");
  if (phone.startsWith("0") && phone.length === 10) {
    phone = "263" + phone.slice(1);
  }
  return phone;
}

// ─── Low-level: send a pre-approved Meta template message ─────────────────────
async function _sendTemplate(to, templateName, variables = []) {
  const phone = _normalizeZimPhone(to); // ← fixed: was String(to).replace(/\D+/g, "") + passed raw `to`

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
      to:       phone,           // ← fixed: was `to` (raw), now `phone` (normalized)
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
  itemSummary,
  deliveryLine  = "Collection / flexible",
  fullItemLines = null,
  replyExamples = "1=12.50"
}) {
  const normalizedPhone = _normalizeZimPhone(supplierPhone);
  try {
    await _sendTemplate(normalizedPhone, "supplier_new_buyer_request", [
      ref,
      locationText,
      itemSummary,
      deliveryLine   // {{4}} — e.g. "🚚 Delivery to buyer needed" or "🏠 Collection / flexible"
    ]);
    console.log(`[BUY REQ TPL] supplier_new_buyer_request → ${normalizedPhone} (${ref})`);
  } catch (err) {
    console.warn(`[BUY REQ TPL] template failed for ${normalizedPhone}: ${err.message}. Falling back to sendButtons.`);
    try {
      const itemDisplay = fullItemLines || itemSummary;
      await sendButtons(normalizedPhone, {
        text:
          `🔥 *New Buyer Request* (${ref})\n\n` +
          `📍 ${locationText}\n\n` +
          `📦 Items needed:\n${itemDisplay}\n\n` +
          `${deliveryLine}\n\n` +
          `*How to reply (tap Send Offer):*\n` +
          `• Price by number: _${replyExamples}_\n` +
          `• Skip an item: _skip 2_\n` +
          `• Message: _msg I can do tomorrow_\n\n` +
          `Respond now — buyers pick the first good quote.`,
        buttons: [
          { id: `req_offer_${requestId}`,   title: "💬 Send Offer" },
          { id: `req_unavail_${requestId}`, title: "❌ Not Available" }
        ]
      });
    } catch (fallbackErr) {
      console.error(`[BUY REQ TPL] fallback also failed for ${normalizedPhone}: ${fallbackErr.message}`);
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
  const normalizedPhone = _normalizeZimPhone(supplierPhone);
  try {
    await _sendTemplate(normalizedPhone, "supplier_request_reminder", [
      ref,
      itemSummary,
      String(minutesRemaining)
    ]);
    console.log(`[BUY REQ REMIND] supplier_request_reminder → ${normalizedPhone} (${ref})`);
  } catch (err) {
    console.warn(`[BUY REQ REMIND] template failed for ${normalizedPhone}: ${err.message}`);
    try {
      await sendText(
        normalizedPhone,
        `⏰ *Reminder!*\n\n` +
        `A buyer is still waiting for a quote (${ref}).\n` +
        `📦 ${itemSummary}\n\n` +
        `This request closes in ${minutesRemaining} minutes.\n` +
        `Type *menu* → Marketplace → My Store to respond.`
      );
    } catch (e) {
      console.warn(`[BUY REQ REMIND] fallback sendText also failed for ${normalizedPhone}: ${e.message}`);
    }
  }
}