// services/buyerRequestNotifications.js
// ─── Buyer Request - Meta Template Notifications ─────────────────────────────
//
// Strategy: Template is a SHORT PING only (ref + item count + location).
// Full item list + pricing form is shown when supplier taps into the chatbot.
// This avoids the Meta template single-line variable limitation entirely.
//
// Falls back to sendButtons() if template fails (within 24-hour session window).

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
function _normalizeZimPhone(raw = "") {
  let phone = String(raw).replace(/\D+/g, "");
  if (phone.startsWith("0") && phone.length === 10) {
    phone = "263" + phone.slice(1);
  }
  return phone;
}

// ─── Low-level: send a pre-approved Meta template message ─────────────────────
async function _sendTemplate(to, templateName, variables = []) {
  const phone = _normalizeZimPhone(to);

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
      to:       phone,
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
//
// Template {{3}} = short count summary e.g. "6 items requested"
// Full item list shown when supplier taps Send Offer in chatbot.
// ─────────────────────────────────────────────────────────────────────────────
export async function notifySupplierNewRequestTemplate({
  supplierPhone,
  requestId,
  ref,
  locationText,
  itemCount,
  itemSummary,
  deliveryLine  = "Collection / flexible",
  fullItemLines = null,
  replyExamples = "1=12.50"
}) {
  const normalizedPhone = _normalizeZimPhone(supplierPhone);

  const templateItemSummary = itemCount
    ? `${itemCount} item${itemCount === 1 ? "" : "s"} requested`
    : itemSummary || "Items requested";

  try {
    await _sendTemplate(normalizedPhone, "supplier_new_buyer_request", [
      ref,
      locationText,
      templateItemSummary,
      deliveryLine
    ]);
    console.log(`[BUY REQ TPL] supplier_new_buyer_request → ${normalizedPhone} (${ref})`);
  } catch (err) {
    console.warn(`[BUY REQ TPL] template failed for ${normalizedPhone}: ${err.message}. Falling back to sendButtons.`);
    try {
      const itemDisplay = fullItemLines || itemSummary;
      await sendButtons(normalizedPhone, {
        text:
          `🔥 *New Buyer Request* (${ref})\n\n` +
          `📍 ${locationText}\n` +
          `${deliveryLine}\n\n` +
          `📦 *Items needed:*\n${itemDisplay}\n\n` +
          `─────────────────\n` +
          `*To quote, tap Send Offer below.*\n` +
          `Enter prices as: _${replyExamples}_\n` +
          `Or use x: _1x12.50, 2x11.00_\n` +
          `Skip items: _skip 2_ or _skip 2,3_\n\n` +
          `Respond now - buyers pick the first good quote.`,
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