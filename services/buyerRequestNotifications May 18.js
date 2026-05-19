// services/buyerRequestNotifications.js
// ─── Buyer Request - Meta Template Notifications ─────────────────────────────
//
// TWO REQUEST NOTIFICATION TIERS:
//
//   supplier_new_request_v2          (standard - all sellers, no phone number)
//     Has QUICK REPLY buttons. Supplier taps "💬 View & Quote" directly.
//
//   supplier_new_request_v2_with_phone  (VIP - admin-selected sellers only)
//     Same as v2 but includes buyer's phone number as {{5}}.
//     Only sent when supplier.revealBuyerPhone === true.
//
// TWO SMART LINK NOTIFICATION TIERS:
//
//   supplier_link_opened             (standard - all sellers, no visitor phone)
//   supplier_link_opened_with_phone  (VIP - includes visitor phone as {{4}})
//     Only sent when supplier.revealVisitorPhone === true.
//
// CLARIFICATION TEMPLATES (new):
//
//   supplier_clarification_request   (sent to BUYER when a seller needs more info)
//   supplier_clarification_reply     (sent to SELLER when buyer answers)
//
// ─── HOW TO SWITCH TEMPLATES ─────────────────────────────────────────────────
//   USE_V2_TEMPLATE = true  (already on - do not change)
//
// ─── VIP PHONE REVEAL ────────────────────────────────────────────────────────
//   Set supplier.revealBuyerPhone = true  to enable request phone reveal.
//   Set supplier.revealVisitorPhone = true to enable smart link phone reveal.
//   Use admin WhatsApp command: "admin revealphone 263773xxxxxx on"
//   Or set via /zq-admin supplier edit page.
//
// ─── SUBMIT THESE NEW TEMPLATES TO META BUSINESS MANAGER ─────────────────────
//
//   supplier_new_request_v2_with_phone  (UTILITY)
//     New buyer request!
//     Items: {{1}}
//     Location: {{2}}
//     Delivery: {{3}}
//     Ref: {{4}}
//     Buyer contact: {{5}}
//     Tap to view full list and quote.
//     [Button 1: 💬 View & Quote  | payload: view_and_quote]
//     [Button 2: ❌ Not Available | payload: not_available]
//
//   supplier_link_opened_with_phone  (UTILITY)
//     👁 Someone opened your ZimQuote profile!
//     Business: {{1}}
//     Via: {{2}}
//     Time: {{3}}
//     Visitor contact: {{4}}
//     Type *menu* to see your store.
//     This is an automated activity alert from ZimQuote.
//
//   supplier_clarification_request  (UTILITY - sent to buyer)
//     A seller needs more details to quote your request!
//     Request: {{1}}
//     Their question: {{2}}
//     Please reply with the details so they can send you a correct quote.
//     This is an automated message from ZimQuote.
//
//   supplier_clarification_reply  (UTILITY - sent to seller when buyer answers)
//     The buyer answered your question for request {{1}}:
//     {{2}}
//     Tap View & Quote to proceed with your pricing.
//     [Button 1: 💬 View & Quote | payload: view_and_quote]
//
// ─────────────────────────────────────────────────────────────────────────────

import axios   from "axios";
import { sendButtons, sendText } from "./metaSender.js";

// ══ FEATURE FLAG ══════════════════════════════════════════════════════════════
const USE_V2_TEMPLATE = true;
// ══════════════════════════════════════════════════════════════════════════════

const GRAPH_API_VERSION = "v24.0";
const PHONE_NUMBER_ID   =
  process.env.WHATSAPP_PHONE_NUMBER_ID ||
  process.env.META_PHONE_NUMBER_ID     ||
  process.env.PHONE_NUMBER_ID;
const ACCESS_TOKEN =
  process.env.META_ACCESS_TOKEN ||
  process.env.WHATSAPP_ACCESS_TOKEN;

if (!PHONE_NUMBER_ID) {
  console.error("[BUY REQ TPL] ⚠️  No PHONE_NUMBER_ID found in environment. Template notifications will fail.");
}
if (!ACCESS_TOKEN) {
  console.error("[BUY REQ TPL] ⚠️  No ACCESS_TOKEN found in environment. Template notifications will fail.");
}

// ── Helper: normalize Zimbabwean phone numbers ────────────────────────────────
function _normalizeZimPhone(raw = "") {
  let phone = String(raw).replace(/\D+/g, "");
  if (phone.startsWith("0") && phone.length === 10) phone = "263" + phone.slice(1);
  return phone;
}

// ── Helper: format phone for display in template ──────────────────────────────
// e.g. "263773123456" → "+263 773 123 456"
function _formatPhoneDisplay(raw = "") {
  const digits = _normalizeZimPhone(raw);
  if (digits.startsWith("263") && digits.length >= 12) {
    return `+263 ${digits.slice(3, 5)} ${digits.slice(5, 8)} ${digits.slice(8)}`;
  }
  return `+${digits}`;
}

// ─── Low-level: send a body-variables-only Meta template ─────────────────────
async function _sendTemplate(to, templateName, variables = []) {
  const phone = _normalizeZimPhone(to);
  const components = variables.length
    ? [{ type: "body", parameters: variables.map(v => ({ type: "text", text: String(v).slice(0, 1024) })) }]
    : [];

  const res = await axios.post(
    `https://graph.facebook.com/${GRAPH_API_VERSION}/${PHONE_NUMBER_ID}/messages`,
    {
      messaging_product: "whatsapp",
      to: phone,
      type: "template",
      template: { name: templateName, language: { code: "en" }, components }
    },
    { headers: { Authorization: `Bearer ${ACCESS_TOKEN}`, "Content-Type": "application/json" } }
  );
  return res.data;
}

// ─── Low-level: send v2 template (2 quick reply buttons) ─────────────────────
async function _sendTemplateV2(to, templateName, variables = []) {
  const phone = _normalizeZimPhone(to);
  const components = [
    { type: "body", parameters: variables.map(v => ({ type: "text", text: String(v).slice(0, 1024) })) },
    { type: "button", sub_type: "quick_reply", index: "0", parameters: [{ type: "payload", payload: "view_and_quote" }] },
    { type: "button", sub_type: "quick_reply", index: "1", parameters: [{ type: "payload", payload: "not_available" }] }
  ];

  const res = await axios.post(
    `https://graph.facebook.com/${GRAPH_API_VERSION}/${PHONE_NUMBER_ID}/messages`,
    {
      messaging_product: "whatsapp",
      to: phone,
      type: "template",
      template: { name: templateName, language: { code: "en" }, components }
    },
    { headers: { Authorization: `Bearer ${ACCESS_TOKEN}`, "Content-Type": "application/json" } }
  );
  return res.data;
}

// ─── Low-level: send clarification-reply template (1 quick reply button) ─────
async function _sendTemplateWithOneButton(to, templateName, variables = []) {
  const phone = _normalizeZimPhone(to);
  const components = [
    { type: "body", parameters: variables.map(v => ({ type: "text", text: String(v).slice(0, 1024) })) },
    { type: "button", sub_type: "quick_reply", index: "0", parameters: [{ type: "payload", payload: "view_and_quote" }] }
  ];

  const res = await axios.post(
    `https://graph.facebook.com/${GRAPH_API_VERSION}/${PHONE_NUMBER_ID}/messages`,
    {
      messaging_product: "whatsapp",
      to: phone,
      type: "template",
      template: { name: templateName, language: { code: "en" }, components }
    },
    { headers: { Authorization: `Bearer ${ACCESS_TOKEN}`, "Content-Type": "application/json" } }
  );
  return res.data;
}

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC: Notify a supplier of a new buyer request
//
// supplier object (or just supplierPhone string) - if object, checks revealBuyerPhone
// for VIP notification. buyerPhone is only passed when supplier is an object.
// ─────────────────────────────────────────────────────────────────────────────
export async function notifySupplierNewRequestTemplate({
  supplierPhone,
  supplier        = null,   // full SupplierProfile object (for VIP check)
  notificationContacts = [],
  requestId,
  ref,
  locationText,
  itemCount,
  itemSummary,
  deliveryLine    = "Collection / flexible",
  fullItemLines   = null,
  replyExamples   = "1=12.50",
  buyerPhone      = null    // buyer's number - only shown to VIP sellers
}) {
  const _extra  = Array.isArray(notificationContacts) ? notificationContacts : [];
  const _phones = [...new Set([supplierPhone, ..._extra])].filter(Boolean).map(_normalizeZimPhone);

  // Determine if this supplier gets the VIP (with-phone) template
  const _isVip = supplier?.revealBuyerPhone === true && !!buyerPhone;

  await Promise.allSettled(_phones.map(phone => _sendNewRequestToPhone({
    phone, requestId, ref, locationText, itemCount, itemSummary,
    deliveryLine, fullItemLines, replyExamples,
    isVip: _isVip,
    buyerPhone: _isVip ? buyerPhone : null
  })));
}

// ── Internal: send new request notification to a single phone ─────────────────
async function _sendNewRequestToPhone({
  phone: normalizedPhone, requestId, ref, locationText, itemCount,
  itemSummary, deliveryLine, fullItemLines, replyExamples,
  isVip = false, buyerPhone = null
}) {
  const _itemCount   = Number(itemCount) || 1;
  const _singleItem  = itemSummary
    ? String(itemSummary).split("\n")[0].replace(/^\d+\.\s*/, "").trim()
    : "item";
  const _itemSummary = _itemCount === 1
    ? `1 item: ${_singleItem}`
    : `${_itemCount} items: ${_singleItem}${_itemCount > 1 ? " + more" : ""}`;

  if (USE_V2_TEMPLATE) {
    try {
      if (isVip && buyerPhone) {
        // ── VIP path: 5-variable template with buyer phone ──────────────────
        await _sendTemplateV2(normalizedPhone, "supplier_new_request_v2_with_phone", [
          _itemSummary,
          locationText,
          deliveryLine,
          ref,
          _formatPhoneDisplay(buyerPhone)
        ]);
        console.log(`[BUY REQ TPL VIP] supplier_new_request_v2_with_phone → ${normalizedPhone} (${ref})`);
      } else {
        // ── Standard path ───────────────────────────────────────────────────
        await _sendTemplateV2(normalizedPhone, "supplier_new_request_v2", [
          _itemSummary,
          locationText,
          deliveryLine,
          ref
        ]);
        console.log(`[BUY REQ TPL v2] supplier_new_request_v2 → ${normalizedPhone} (${ref})`);
      }
      return;
    } catch (err) {
      console.warn(`[BUY REQ TPL v2] failed for ${normalizedPhone}: ${err.message}. Falling back to v1.`);
    }
  }

  // ── v1 fallback: plain text template ─────────────────────────────────────
  try {
    await _sendTemplate(normalizedPhone, "supplier_new_buyer_request", [
      ref,
      locationText,
      `${_itemCount} item${_itemCount === 1 ? "" : "s"} requested`,
      deliveryLine
    ]);
    console.log(`[BUY REQ TPL v1] supplier_new_buyer_request → ${normalizedPhone} (${ref})`);
  } catch (err) {
    console.warn(`[BUY REQ TPL v1] failed for ${normalizedPhone}: ${err.message}. Falling back to sendButtons.`);
    try {
      const itemDisplay = fullItemLines || itemSummary;
      await sendButtons(normalizedPhone, {
        text:
          `🔥 *New Buyer Request* (${ref})\n\n` +
          `📍 ${locationText}\n${deliveryLine}\n\n` +
          `📦 *Items needed:*\n${itemDisplay}\n\n` +
          `─────────────────\n` +
          `Tap *View & Quote* to enter your prices.`,
        buttons: [
          { id: `req_offer_${requestId}`,   title: "💬 View & Quote"  },
          { id: `req_unavail_${requestId}`, title: "❌ Not Available" }
        ]
      });
    } catch (fallbackErr) {
      console.error(`[BUY REQ TPL] all fallbacks failed for ${normalizedPhone}: ${fallbackErr.message}`);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC: Notify seller that someone opened their Smart Link
//
// supplier: full SupplierProfile object (for VIP check + notification contacts)
// source: "fb" | "wa" | "tt" | "qr" | "sms" | "ig" | "yt" | "direct"
// visitorPhone: optional - only shown when supplier.revealVisitorPhone === true
// ─────────────────────────────────────────────────────────────────────────────
export async function notifySellerSmartLinkOpened({
  sellerPhone,
  supplier      = null,  // full SupplierProfile object (for VIP check)
  businessName,
  source        = "direct",
  visitorPhone  = null   // visitor's number - only shown to VIP sellers
}) {
  const _isVip = supplier?.revealVisitorPhone === true && !!visitorPhone;

  const sourceLabels = {
    fb:             "Facebook",
    wa:             "WhatsApp Status",
    tt:             "TikTok",
    qr:             "QR Code scan",
    sms:            "SMS / Flyer",
    ig:             "Instagram",
    yt:             "YouTube",
    direct:         "Direct link",
    whatsapp_link:  "WhatsApp link"
  };
  const sourceLabel = sourceLabels[source] || "ZimQuote link";
  const timeStr     = new Date().toLocaleString("en-GB", {
    day: "numeric", month: "short", hour: "2-digit", minute: "2-digit"
  });

  // Determine phones to notify: primary + notification contacts
  const _extra  = Array.isArray(supplier?.notificationContacts) ? supplier.notificationContacts : [];
  const _phones = [...new Set([sellerPhone, ..._extra])].filter(Boolean).map(_normalizeZimPhone);

  await Promise.allSettled(_phones.map(phone =>
    _sendSmartLinkNotifToPhone({ phone, businessName, sourceLabel, timeStr, isVip: _isVip, visitorPhone })
  ));
}

async function _sendSmartLinkNotifToPhone({
  phone, businessName, sourceLabel, timeStr, isVip, visitorPhone
}) {
  try {
    if (isVip && visitorPhone) {
      await _sendTemplate(phone, "supplier_link_opened_with_phone", [
        businessName || "Your business",
        sourceLabel,
        timeStr,
        _formatPhoneDisplay(visitorPhone)
      ]);
      console.log(`[SMART LINK TPL VIP] supplier_link_opened_with_phone → ${phone}`);
    } else {
      await _sendTemplate(phone, "supplier_link_opened", [
        businessName || "Your business",
        sourceLabel,
        timeStr
      ]);
      console.log(`[SMART LINK TPL] supplier_link_opened → ${phone} (via ${sourceLabel})`);
    }
    return;
  } catch (templateErr) {
    console.warn(`[SMART LINK TPL] template failed for ${phone}: ${templateErr.message}. Falling back to sendButtons.`);
  }

  // Fallback: sendButtons (within 24hr session only)
  try {
    await sendButtons(phone, {
      text:
        `👁 *Someone just opened your ZimQuote profile!*\n\n` +
        `🏪 ${businessName || "Your business"}\n` +
        `📱 Via: ${sourceLabel}\n` +
        `⏰ ${timeStr}\n` +
        (isVip && visitorPhone ? `📞 Visitor: ${_formatPhoneDisplay(visitorPhone)}\n` : "") +
        `\nThey can request a quote, book, or send an enquiry.\n\n` +
        `💡 _Keep your services and rates updated so visitors convert._`,
      buttons: [
        { id: "my_supplier_account", title: "🏪 My Store"    },
        { id: "sup_request_sellers", title: "⚡ Marketplace" }
      ]
    });
  } catch (fallbackErr) {
    console.warn(`[SMART LINK TPL] all fallbacks failed for ${phone}: ${fallbackErr.message}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC: Send clarification request from seller to buyer
//
// Called when a seller taps "❓ Need More Info" and types their question.
// Sends a UTILITY template to the buyer.
// ─────────────────────────────────────────────────────────────────────────────
export async function sendClarificationRequestToBuyer({
  buyerPhone,
  ref,
  question
}) {
  const normalizedPhone = _normalizeZimPhone(buyerPhone);
  try {
    await _sendTemplate(normalizedPhone, "supplier_clarification_request", [
      ref,
      String(question).slice(0, 1024)
    ]);
    console.log(`[CLARIF] supplier_clarification_request → ${normalizedPhone} (${ref})`);
  } catch (err) {
    console.warn(`[CLARIF] template failed for ${normalizedPhone}: ${err.message}. Falling back to sendText.`);
    try {
      await sendText(
        normalizedPhone,
        `❓ *A seller needs more details for your request (${ref})*\n\n` +
        `Their question:\n_${question}_\n\n` +
        `Please reply with the details so they can send you an accurate quote.`
      );
    } catch (e) {
      console.warn(`[CLARIF] fallback sendText also failed for ${normalizedPhone}: ${e.message}`);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC: Send clarification reply from buyer back to seller
//
// Called when the buyer replies to a clarification request.
// Sends a UTILITY template to the seller with a "View & Quote" button.
// ─────────────────────────────────────────────────────────────────────────────
export async function sendClarificationReplyToSeller({
  sellerPhone,
  ref,
  answer
}) {
  const normalizedPhone = _normalizeZimPhone(sellerPhone);
  try {
    await _sendTemplateWithOneButton(normalizedPhone, "supplier_clarification_reply", [
      ref,
      String(answer).slice(0, 1024)
    ]);
    console.log(`[CLARIF] supplier_clarification_reply → ${normalizedPhone} (${ref})`);
  } catch (err) {
    console.warn(`[CLARIF] reply template failed for ${normalizedPhone}: ${err.message}. Falling back to sendButtons.`);
    try {
      await sendButtons(normalizedPhone, {
        text:
          `✅ *Buyer answered your question* (${ref})\n\n` +
          `Their answer:\n_${answer}_\n\n` +
          `Tap View & Quote to proceed with your pricing.`,
        buttons: [
          { id: `view_and_quote`, title: "💬 View & Quote" }
        ]
      });
    } catch (e) {
      console.warn(`[CLARIF] reply fallback also failed for ${normalizedPhone}: ${e.message}`);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC: Remind supplier of pending request (unchanged)
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