// services/buyerRequestNotifications.js
// ─── Buyer Request - Meta Template Notifications ─────────────────────────────
//
// TWO TEMPLATES SUPPORTED:
//
//   supplier_new_buyer_request  (CURRENT — active, plain text only)
//     Supplier must reply "hi" to trigger the item list flow.
//     Used by default (USE_V2_TEMPLATE = false).
//
//   supplier_new_request_v2     (NEW — switch on when Meta approves it)
//     Has QUICK REPLY buttons built into the template.
//     Supplier taps "💬 View & Quote" directly — no typing needed.
//     Enable by setting USE_V2_TEMPLATE = true below.
//
// ─── HOW TO SWITCH TO THE NEW TEMPLATE ───────────────────────────────────────
//   1. Submit supplier_new_request_v2 to Meta (see NEW_TEMPLATE_GUIDE.md)
//   2. Wait for Meta approval (usually 24-48 hrs for UTILITY)
//   3. Change USE_V2_TEMPLATE = false  →  USE_V2_TEMPLATE = true
//   4. Deploy — done. No other changes needed.
// ─────────────────────────────────────────────────────────────────────────────

import axios   from "axios";
import { sendButtons, sendText } from "./metaSender.js";

// ══ FEATURE FLAG — flip to true once supplier_new_request_v2 is approved ══════
const USE_V2_TEMPLATE = false;
// ══════════════════════════════════════════════════════════════════════════════

const GRAPH_API_VERSION = "v24.0";
const PHONE_NUMBER_ID   =
  process.env.WHATSAPP_PHONE_NUMBER_ID ||
  process.env.META_PHONE_NUMBER_ID     ||
  process.env.PHONE_NUMBER_ID;
const ACCESS_TOKEN =
  process.env.META_ACCESS_TOKEN ||
  process.env.WHATSAPP_ACCESS_TOKEN;

// ── Guard: warn loudly at startup if env vars are missing ────────────────────
if (!PHONE_NUMBER_ID) {
  console.error("[BUY REQ TPL] ⚠️  No PHONE_NUMBER_ID found in environment. Template notifications will fail.");
}
if (!ACCESS_TOKEN) {
  console.error("[BUY REQ TPL] ⚠️  No ACCESS_TOKEN found in environment. Template notifications will fail.");
}

// ── Helper: normalize Zimbabwean phone numbers to international format ─────────
function _normalizeZimPhone(raw = "") {
  let phone = String(raw).replace(/\D+/g, "");
  if (phone.startsWith("0") && phone.length === 10) {
    phone = "263" + phone.slice(1);
  }
  return phone;
}

// ─── Low-level: send a pre-approved Meta template (body variables only) ───────
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
      to:    phone,
      type:  "template",
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

// ─── Low-level: send v2 template which has QUICK REPLY buttons ────────────────
// The buttons component must be sent separately from the body component.
async function _sendTemplateV2(to, templateName, variables = []) {
  const phone = _normalizeZimPhone(to);

  // v2 template has: header, body (with variables), footer, and 2 quick-reply buttons
  // The buttons are defined in the template itself — we just need to include the
  // buttons component in the request so Meta knows to render them.
  const components = [
    // Body variables
    {
      type: "body",
      parameters: variables.map(v => ({ type: "text", text: String(v).slice(0, 1024) }))
    },
    // Quick reply buttons — the index matches the order defined in the template
    {
      type:     "button",
      sub_type: "quick_reply",
      index:    "0",           // "💬 View & Quote" button (first button)
      parameters: [{ type: "payload", payload: "view_and_quote" }]
    },
    {
      type:     "button",
      sub_type: "quick_reply",
      index:    "1",           // "❌ Not Available" button (second button)
      parameters: [{ type: "payload", payload: "not_available" }]
    }
  ];

  const res = await axios.post(
    `https://graph.facebook.com/${GRAPH_API_VERSION}/${PHONE_NUMBER_ID}/messages`,
    {
      messaging_product: "whatsapp",
      to:    phone,
      type:  "template",
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
// Automatically uses v2 template (with tap buttons) when USE_V2_TEMPLATE = true,
// falls back to v1 (plain text) otherwise.
//
// With v2: supplier taps "💬 View & Quote" in the template → webhook receives
//   button_reply with payload "view_and_quote" → chatbotEngine shows item list
//   immediately. No typing needed.
//
// With v1: supplier must type any message → awaiting_offer_intro handler fires
//   → shows item list + View & Quote buttons.
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

  // ── Build item summary line (max 1 line for template variable) ───────────────
  const _itemCount   = Number(itemCount) || 1;
  const _singleItem  = itemSummary
    ? String(itemSummary).split("\n")[0].replace(/^\d+\.\s*/, "").trim()
    : "item";
  const _itemSummary = _itemCount === 1
    ? `1 item: ${_singleItem}`
    : `${_itemCount} items: ${_singleItem}${_itemCount > 1 ? " + more" : ""}`;

  // ── v2 template: has "View & Quote" button built in ──────────────────────────
  if (USE_V2_TEMPLATE) {
    try {
      await _sendTemplateV2(normalizedPhone, "supplier_new_request_v2", [
        _itemSummary,   // {{1}} items summary
        locationText,   // {{2}} location
        deliveryLine,   // {{3}} delivery line
        ref             // {{4}} reference
      ]);
      console.log(`[BUY REQ TPL v2] supplier_new_request_v2 → ${normalizedPhone} (${ref})`);
      return; // v2 sent — buttons are IN the template, no further action needed
    } catch (err) {
      console.warn(`[BUY REQ TPL v2] failed for ${normalizedPhone}: ${err.message}. Falling back to v1.`);
      // Fall through to v1 below
    }
  }

  // ── v1 template: plain text ping — supplier must reply to trigger item list ──
  try {
    await _sendTemplate(normalizedPhone, "supplier_new_buyer_request", [
      ref,
      locationText,
      `${_itemCount} item${_itemCount === 1 ? "" : "s"} requested`,
      deliveryLine
    ]);
    console.log(`[BUY REQ TPL v1] supplier_new_buyer_request → ${normalizedPhone} (${ref})`);
  } catch (err) {
    console.warn(`[BUY REQ TPL v1] template failed for ${normalizedPhone}: ${err.message}. Falling back to sendButtons.`);
    // Last resort: plain sendButtons (only works within 24-hour session window)
    try {
      const itemDisplay = fullItemLines || itemSummary;
      await sendButtons(normalizedPhone, {
        text:
          `🔥 *New Buyer Request* (${ref})\n\n` +
          `📍 ${locationText}\n` +
          `${deliveryLine}\n\n` +
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
// PUBLIC: Remind supplier of unanswered request (nudge after timeout)
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
