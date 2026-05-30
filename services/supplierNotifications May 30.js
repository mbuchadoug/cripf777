// services/supplierNotifications.js
// ─── ZimQuote Supplier Admin - WhatsApp Template Notifications ───────────────
//
// Uses Meta template messages so notifications reach suppliers even when
// they haven't messaged the bot in the last 24 hours.
// Falls back to plain sendText if template sending fails (within 24hr window).
//
// Templates must be pre-approved in Meta Business Manager before use.
// Template names must match exactly what was submitted to Meta.
//
// ── Templates covered: ───────────────────────────────────────────────────────
//   supplier_trial_activated         → trial started notification
//   supplier_offer                   → discount / payment offer blast
//   supplier_subscription_expiring   → expiry warning (3 days / 1 day before)
//   supplier_subscription_expired    → post-expiry notice
//   supplier_payment_receipt         → manual payment receipt
//   supplier_link_opened             → smart link opened (standard, no phone)
//   supplier_link_opened_with_phone  → smart link opened (VIP, visitor phone in {{4}})
//
// ── Meta template body reference (submit these to Meta Business Manager): ────
//
//  supplier_trial_activated:
//    Hi {{1}}, your *{{2}}* trial on ZimQuote has started!
//    Your listing is now LIVE and visible to buyers.
//    Plan: {{3}} | Expires: {{4}}
//    Type *menu* on WhatsApp to access your seller dashboard.
//    This is an automated message from ZimQuote.
//
//  supplier_offer:
//    Special offer for ZimQuote suppliers!
//    {{1}}
//    Valid until: {{2}}
//    Reply *yes* to claim or visit: {{3}}
//    This is a promotional message from ZimQuote.
//
//  supplier_subscription_expiring:
//    ⚠️ Hi {{1}}, your ZimQuote subscription for *{{2}}* expires in {{3}} day(s) on {{4}}.
//    Renew now to keep your listing LIVE and visible to buyers.
//    Reply *renew* or type *menu* to manage your account.
//    This is an automated reminder from ZimQuote.
//
//  supplier_subscription_expired:
//    Hi {{1}}, your ZimQuote subscription for *{{2}}* has expired as of {{3}}.
//    Your listing is currently hidden from buyers.
//    Reply *renew* to reactivate or type *menu* for options.
//    This is an automated message from ZimQuote.
//
//  supplier_payment_receipt:
//    ✅ Payment confirmed! ZimQuote Receipt
//    Business: {{1}}
//    Plan: {{2}} ({{3}})
//    Amount: {{4}}
//    Reference: {{5}}
//    Valid until: {{6}}
//    Thank you for your payment. Type *menu* to access your dashboard.
//    This is an automated receipt from ZimQuote.
//
//  supplier_link_opened:  (UTILITY - standard, no phone number)
//    👁 Someone opened your ZimQuote profile!
//    Business: {{1}}
//    Via: {{2}}
//    Time: {{3}}
//    They can request a quote, book a service, or send you an enquiry.
//    Type *menu* to view your store.
//    This is an automated activity alert from ZimQuote.
//
//  supplier_link_opened_with_phone:  (UTILITY - VIP sellers only, APPROVED)
//    👁 Someone opened your ZimQuote profile!
//    Business: {{1}}
//    Via: {{2}}
//    Time: {{3}}
//    Visitor contact: {{4}}
//    They can request a quote, book, or send an enquiry directly.
//    Type *menu* to view your store.
//    This is an automated activity alert from ZimQuote.
//
//    Variables:
//      {{1}} = businessName          e.g.  "Mutare Electrical Supplies"
//      {{2}} = sourceLabel           e.g.  "QR Code scan"
//      {{3}} = timestamp             e.g.  "15 May 2026, 09:42"
//      {{4}} = visitor phone         e.g.  "+263 773 123 456"
//
// ── VIP SELLER ASSIGNMENT ────────────────────────────────────────────────────
// Set via /zq-admin → Supplier → Edit → "VIP Notifications" section:
//   revealBuyerPhone    = true → receives buyer phone on new request notifications
//   revealVisitorPhone  = true → receives visitor phone on smart link open alerts
// Or via admin WhatsApp command (see chatbotEngine.js admin section).

import axios from "axios";
import { sendText } from "./metaSender.js";

const GRAPH_API_VERSION = "v24.0";
const PHONE_NUMBER_ID   =
  process.env.WHATSAPP_PHONE_NUMBER_ID ||
  process.env.META_PHONE_NUMBER_ID     ||
  process.env.PHONE_NUMBER_ID;
const ACCESS_TOKEN =
  process.env.META_ACCESS_TOKEN ||
  process.env.WHATSAPP_ACCESS_TOKEN;

if (!PHONE_NUMBER_ID) {
  console.error(
    "[Supplier Notify] ⚠️  No PHONE_NUMBER_ID found in environment " +
    "(checked WHATSAPP_PHONE_NUMBER_ID, META_PHONE_NUMBER_ID, PHONE_NUMBER_ID). " +
    "Template notifications will fail."
  );
}
if (!ACCESS_TOKEN) {
  console.error(
    "[Supplier Notify] ⚠️  No ACCESS_TOKEN found in environment " +
    "(checked META_ACCESS_TOKEN, WHATSAPP_ACCESS_TOKEN). " +
    "Template notifications will fail."
  );
}

// ── Helper: normalize Zimbabwean phone numbers to international format ────────
function _normalizeZimPhone(raw = "") {
  let phone = String(raw).replace(/\D+/g, "");
  if (phone.startsWith("0") && phone.length === 10) {
    phone = "263" + phone.slice(1);
  }
  return phone;
}

// ── Helper: format phone for human-readable display ───────────────────────────
// e.g. "263773123456" → "+263 773 123 456"
function _formatPhoneDisplay(raw = "") {
  const digits = _normalizeZimPhone(raw);
  if (digits.startsWith("263") && digits.length >= 12) {
    return `+263 ${digits.slice(3, 6)} ${digits.slice(6, 9)} ${digits.slice(9)}`;
  }
  return digits ? `+${digits}` : "unknown";
}

// ── Helper: current timestamp in readable format ──────────────────────────────
function _timestamp() {
  return new Date().toLocaleString("en-GB", {
    day:    "numeric",
    month:  "short",
    year:   "numeric",
    hour:   "2-digit",
    minute: "2-digit"
  });
}

// ── Helper: format a date nicely ─────────────────────────────────────────────
function _formatDate(date) {
  return new Date(date).toLocaleString("en-GB", {
    day:   "numeric",
    month: "short",
    year:  "numeric"
  });
}

// ── Low-level: send a pre-approved Meta template message ──────────────────────
async function _sendTemplate(to, templateName, variables = []) {
  const phone = _normalizeZimPhone(to);

  const components = variables.length
    ? [{
        type: "body",
        parameters: variables.map(v => ({ type: "text", text: String(v).slice(0, 1024) }))
      }]
    : [];

  await axios.post(
    `https://graph.facebook.com/${GRAPH_API_VERSION}/${PHONE_NUMBER_ID}/messages`,
    {
      messaging_product: "whatsapp",
      to:                phone,
      type:              "template",
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
}

// ── Low-level: send a v2 template with quick reply buttons ────────────────────
async function _sendTemplateV2(to, templateName, variables = [], buttons = []) {
  const phone = _normalizeZimPhone(to);

  const components = [
    {
      type: "body",
      parameters: variables.map(v => ({ type: "text", text: String(v).slice(0, 1024) }))
    },
    ...buttons.map((payload, idx) => ({
      type:       "button",
      sub_type:   "quick_reply",
      index:      String(idx),
      parameters: [{ type: "payload", payload }]
    }))
  ];

  await axios.post(
    `https://graph.facebook.com/${GRAPH_API_VERSION}/${PHONE_NUMBER_ID}/messages`,
    {
      messaging_product: "whatsapp",
      to:                phone,
      type:              "template",
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
}

// ─────────────────────────────────────────────────────────────────────────────
// INTERNAL: Fan out a notification to ALL registered notification contacts.
//
// supplier.notificationContacts = ["263771000001", "263772000002"]
// Primary phone (supplier.phone) is ALWAYS included - contacts are additive.
// ─────────────────────────────────────────────────────────────────────────────
async function _notifyAllSupplier(supplier, notifyFn) {
  const extra  = Array.isArray(supplier.notificationContacts) ? supplier.notificationContacts : [];
  const phones = [...new Set([supplier.phone, ...extra])].filter(Boolean);
  await Promise.allSettled(phones.map(phone => notifyFn(phone)));
}

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC: Notify supplier - trial has been activated
// Template: supplier_trial_activated
// ─────────────────────────────────────────────────────────────────────────────
export async function notifySupplierTrialActivated(
  supplierPhone,
  businessName,
  tier,
  billingCycle,
  expiresAt
) {
  const normalizedTo = _normalizeZimPhone(supplierPhone);
  const planLabel    = `${tier.charAt(0).toUpperCase() + tier.slice(1)} (${billingCycle === "annual" ? "Annual" : "Monthly"})`;
  const expiryStr    = _formatDate(expiresAt);

  try {
    await _sendTemplate(normalizedTo, "supplier_trial_activated", [
      businessName,
      businessName,
      planLabel,
      expiryStr
    ]);
    console.log(`[Supplier Notify] supplier_trial_activated sent to ${normalizedTo}`);
  } catch (err) {
    console.warn(`[Supplier Notify] template failed for ${normalizedTo} (${err.message}), falling back to sendText`);
    try {
      await sendText(normalizedTo,
`✅ *Your ZimQuote Trial Has Started!*

Hi *${businessName}*!

Your listing is now *LIVE* and visible to buyers on ZimQuote.

📦 Plan: *${planLabel}*
📅 Expires: *${expiryStr}*

Type *menu* on WhatsApp to access your seller dashboard and manage your listing.

_This is an automated message from ZimQuote._`
      );
    } catch (e) {
      console.warn(`[Supplier Notify] fallback sendText also failed for ${normalizedTo}: ${e.message}`);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC: Send a discount or payment offer to a supplier
// Template: supplier_offer
// ─────────────────────────────────────────────────────────────────────────────
export async function notifySupplierOffer(
  supplierPhone,
  offerText,
  validUntil,
  actionLink = "wa.me/263XXXXXXXXX"
) {
  const normalizedTo = _normalizeZimPhone(supplierPhone);
  const validStr     = validUntil ? _formatDate(validUntil) : "Limited time";

  try {
    await _sendTemplate(normalizedTo, "supplier_offer", [
      offerText,
      validStr,
      actionLink
    ]);
    console.log(`[Supplier Notify] supplier_offer sent to ${normalizedTo}`);
  } catch (err) {
    console.warn(`[Supplier Notify] template failed for ${normalizedTo} (${err.message}), falling back to sendText`);
    try {
      await sendText(normalizedTo,
`🎉 *Special Offer from ZimQuote!*

${offerText}

⏰ Valid until: *${validStr}*

Reply *yes* to claim this offer or visit:
${actionLink}

_This is a promotional message from ZimQuote._`
      );
    } catch (e) {
      console.warn(`[Supplier Notify] fallback sendText also failed for ${normalizedTo}: ${e.message}`);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC: Broadcast an offer to MULTIPLE suppliers at once
// ─────────────────────────────────────────────────────────────────────────────
export async function broadcastSupplierOffer(
  supplierList,
  offerText,
  validUntil,
  actionLink
) {
  const results = { sent: 0, failed: 0 };
  for (const supplier of supplierList) {
    try {
      await notifySupplierOffer(supplier.phone, offerText, validUntil, actionLink);
      results.sent++;
    } catch (_) {
      results.failed++;
    }
    await new Promise(r => setTimeout(r, 300));
  }
  console.log(`[Supplier Notify] Broadcast complete: ${results.sent} sent, ${results.failed} failed`);
  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC: Notify supplier - subscription is expiring soon
// Template: supplier_subscription_expiring
// ─────────────────────────────────────────────────────────────────────────────
export async function notifySupplierSubscriptionExpiring(
  supplierPhone,
  businessName,
  expiresAt
) {
  const normalizedTo = _normalizeZimPhone(supplierPhone);
  const expiryDate   = new Date(expiresAt);
  const now          = new Date();
  const daysLeft     = Math.max(0, Math.ceil((expiryDate - now) / (1000 * 60 * 60 * 24)));
  const expiryStr    = _formatDate(expiresAt);

  try {
    await _sendTemplate(normalizedTo, "supplier_subscription_expiring", [
      businessName,
      businessName,
      String(daysLeft),
      expiryStr
    ]);
    console.log(`[Supplier Notify] supplier_subscription_expiring sent to ${normalizedTo}`);
  } catch (err) {
    console.warn(`[Supplier Notify] template failed for ${normalizedTo} (${err.message}), falling back to sendText`);
    try {
      await sendText(normalizedTo,
`⚠️ *ZimQuote Subscription Expiring Soon!*

Hi *${businessName}*,

Your ZimQuote listing subscription expires in *${daysLeft} day(s)* on *${expiryStr}*.

When your subscription expires, your listing will be *hidden from buyers*.

👉 Reply *renew* now or type *menu* to manage your account and keep your listing LIVE.

_This is an automated reminder from ZimQuote._`
      );
    } catch (e) {
      console.warn(`[Supplier Notify] fallback sendText also failed for ${normalizedTo}: ${e.message}`);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC: Notify supplier - subscription has expired
// Template: supplier_subscription_expired
// ─────────────────────────────────────────────────────────────────────────────
export async function notifySupplierSubscriptionExpired(
  supplierPhone,
  businessName,
  expiredAt
) {
  const normalizedTo = _normalizeZimPhone(supplierPhone);
  const expiryStr    = _formatDate(expiredAt);

  try {
    await _sendTemplate(normalizedTo, "supplier_subscription_expired", [
      businessName,
      businessName,
      expiryStr
    ]);
    console.log(`[Supplier Notify] supplier_subscription_expired sent to ${normalizedTo}`);
  } catch (err) {
    console.warn(`[Supplier Notify] template failed for ${normalizedTo} (${err.message}), falling back to sendText`);
    try {
      await sendText(normalizedTo,
`❌ *ZimQuote Subscription Expired*

Hi *${businessName}*,

Your ZimQuote subscription expired on *${expiryStr}*.

Your listing is currently *hidden from buyers*.

👉 Reply *renew* to reactivate your listing, or type *menu* for options.

_This is an automated message from ZimQuote._`
      );
    } catch (e) {
      console.warn(`[Supplier Notify] fallback sendText also failed for ${normalizedTo}: ${e.message}`);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC: Send a payment receipt to supplier after manual payment confirmation
// Template: supplier_payment_receipt
// ─────────────────────────────────────────────────────────────────────────────
export async function notifySupplierPaymentReceipt(
  supplierPhone,
  businessName,
  tier,
  billingCycle,
  amount,
  currency = "USD",
  reference,
  expiresAt
) {
  const normalizedTo = _normalizeZimPhone(supplierPhone);
  const planLabel    = tier.charAt(0).toUpperCase() + tier.slice(1);
  const cycleLabel   = billingCycle === "annual" ? "Annual" : "Monthly";
  const amountStr    = `${currency === "USD" ? "$" : currency + " "}${Number(amount).toFixed(2)}`;
  const expiryStr    = _formatDate(expiresAt);
  const ref          = reference || `ZQ-${Date.now()}`;

  try {
    await _sendTemplate(normalizedTo, "supplier_payment_receipt", [
      businessName,
      planLabel,
      cycleLabel,
      amountStr,
      ref,
      expiryStr
    ]);
    console.log(`[Supplier Notify] supplier_payment_receipt sent to ${normalizedTo}`);
  } catch (err) {
    console.warn(`[Supplier Notify] template failed for ${normalizedTo} (${err.message}), falling back to sendText`);
    try {
      await sendText(normalizedTo,
`✅ *ZimQuote Payment Receipt*

Thank you! Your payment has been confirmed.

━━━━━━━━━━━━━━━━━━━
🏪 *Business:* ${businessName}
📦 *Plan:* ${planLabel} (${cycleLabel})
💰 *Amount Paid:* ${amountStr}
🔖 *Reference:* ${ref}
📅 *Valid Until:* ${expiryStr}
━━━━━━━━━━━━━━━━━━━

Your listing is *LIVE* and visible to buyers.

Type *menu* to access your seller dashboard.

_This is an automated receipt from ZimQuote._`
      );
    } catch (e) {
      console.warn(`[Supplier Notify] fallback sendText also failed for ${normalizedTo}: ${e.message}`);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// UTILITY: Run expiry checks across all active supplier subscriptions
// Call from a cron job (e.g. daily at 08:00)
// ─────────────────────────────────────────────────────────────────────────────
export async function runSupplierExpiryChecks() {
  try {
    const SupplierProfile = (await import("../models/supplierProfile.js")).default;
    const now             = new Date();

    const warn3Start = new Date(now.getTime() + 2 * 24 * 60 * 60 * 1000 + 23 * 60 * 60 * 1000);
    const warn3End   = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000 + 1  * 60 * 60 * 1000);
    const warn1Start = new Date(now.getTime() + 23 * 60 * 60 * 1000);
    const warn1End   = new Date(now.getTime() + 25 * 60 * 60 * 1000);
    const expiredStart = new Date(now.getTime() - 2 * 60 * 60 * 1000);

    const [expiring3Day, expiring1Day, justExpired] = await Promise.all([
      SupplierProfile.find({ subscriptionStatus: "active", active: true, subscriptionExpiresAt: { $gte: warn3Start, $lte: warn3End } }).lean(),
      SupplierProfile.find({ subscriptionStatus: "active", active: true, subscriptionExpiresAt: { $gte: warn1Start, $lte: warn1End } }).lean(),
      SupplierProfile.find({ subscriptionStatus: "active", active: true, subscriptionExpiresAt: { $gte: expiredStart, $lte: now } }).lean()
    ]);

    console.log(`[Supplier Notify] Expiry checks: 3-day=${expiring3Day.length}, 1-day=${expiring1Day.length}, just-expired=${justExpired.length}`);

    for (const s of expiring3Day) {
      await notifySupplierSubscriptionExpiring(s.phone, s.businessName, s.subscriptionExpiresAt);
      await new Promise(r => setTimeout(r, 300));
    }
    for (const s of expiring1Day) {
      await notifySupplierSubscriptionExpiring(s.phone, s.businessName, s.subscriptionExpiresAt);
      await new Promise(r => setTimeout(r, 300));
    }
    for (const s of justExpired) {
      await SupplierProfile.findByIdAndUpdate(s._id, { subscriptionStatus: "expired", active: false });
      await notifySupplierSubscriptionExpired(s.phone, s.businessName, s.subscriptionExpiresAt);
      await new Promise(r => setTimeout(r, 300));
    }

    console.log("[Supplier Notify] Expiry checks complete.");
  } catch (err) {
    console.error("[Supplier Notify] runSupplierExpiryChecks error:", err.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC: Fan-out wrapper — notify ALL contacts when smart link is opened.
//
// Standard sellers (revealVisitorPhone = false):
//   → supplier_link_opened  (3 variables, no phone)
//
// VIP sellers (revealVisitorPhone = true):
//   → supplier_link_opened_with_phone  (4 variables, visitor phone as {{4}})
//     This template was submitted as UTILITY and approved by Meta.
// ─────────────────────────────────────────────────────────────────────────────
export async function notifyAllSupplierLinkOpened(supplier, source, visitorPhone = null) {
  const _isVip = supplier?.revealVisitorPhone === true && !!visitorPhone;
  await _notifyAllSupplier(supplier, phone =>
    notifySupplierLinkOpened(phone, supplier.businessName, source, _isVip ? visitorPhone : null)
  );
}

export async function notifySupplierLinkOpened(supplierPhone, businessName, source, visitorPhone = null) {
  const ts           = _timestamp();
  const normalizedTo = _normalizeZimPhone(supplierPhone);
  const isVip        = !!visitorPhone;

  const sourceLabels = {
    fb:            "Facebook",
    wa:            "WhatsApp Status",
    tt:            "TikTok",
    qr:            "QR Code scan",
    sms:           "SMS / Flyer",
    ig:            "Instagram",
    yt:            "YouTube",
    direct:        "Direct link",
    whatsapp_link: "WhatsApp link"
  };
  const sourceLabel = sourceLabels[source] || "ZimQuote link";

  try {
    if (isVip) {
      // ── VIP: single template with visitor phone as {{4}} ──────────────────
      await _sendTemplate(normalizedTo, "supplier_link_opened_with_phone", [
        businessName || "Your business",
        sourceLabel,
        ts,
        _formatPhoneDisplay(visitorPhone)
      ]);
      console.log(`[Supplier Notify] supplier_link_opened_with_phone → ${normalizedTo} (${sourceLabel})`);
    } else {
      // ── Standard: 3-variable template, no phone ───────────────────────────
      await _sendTemplate(normalizedTo, "supplier_link_opened", [
        businessName || "Your business",
        sourceLabel,
        ts
      ]);
      console.log(`[Supplier Notify] supplier_link_opened → ${normalizedTo} (${sourceLabel})`);
    }
  } catch (err) {
    console.warn(`[Supplier Notify] link_opened template failed for ${normalizedTo} (${err.message}), falling back`);
    try {
      await sendText(normalizedTo,
`👁 Someone opened your ZimQuote profile!

Business: ${businessName}
Via: ${sourceLabel}
Time: ${ts}${isVip && visitorPhone ? `\nVisitor: ${_formatPhoneDisplay(visitorPhone)}` : ""}

They can request a quote, book a service, or send you an enquiry directly from your link.

Type *menu* to view your store.

This is an automated activity alert from ZimQuote.`
      );
    } catch (e) {
      console.warn(`[Supplier Notify] fallback sendText also failed for ${normalizedTo}: ${e.message}`);
    }
  }
}