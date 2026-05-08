// services/schoolNotifications.js
// ─── ZimQuote School Admin - WhatsApp Template Notifications ─────────────────
//
// Uses Meta template messages so notifications reach school admins even when
// they haven't messaged the bot in the last 24 hours.
// Falls back to plain sendText if template sending fails (within 24hr window).
//
// Templates must be pre-approved in Meta Business Manager before use.
// Template names must match exactly what was submitted to Meta.

import axios from "axios";
import { sendText } from "./metaSender.js";

const GRAPH_API_VERSION = "v24.0";
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID || process.env.META_PHONE_NUMBER_ID || process.env.PHONE_NUMBER_ID;
const ACCESS_TOKEN    = process.env.META_ACCESS_TOKEN || process.env.WHATSAPP_ACCESS_TOKEN;

// ── Guard: warn loudly at startup if env vars are missing ────────────────────
if (!PHONE_NUMBER_ID) {
  console.error("[School Notify] ⚠️  No PHONE_NUMBER_ID found in environment (checked WHATSAPP_PHONE_NUMBER_ID, META_PHONE_NUMBER_ID, PHONE_NUMBER_ID). Template notifications will fail.");
}
if (!ACCESS_TOKEN) {
  console.error("[School Notify] ⚠️  No ACCESS_TOKEN found in environment (checked META_ACCESS_TOKEN, WHATSAPP_ACCESS_TOKEN). Template notifications will fail.");
}

// ── Helper: normalize Zimbabwean phone numbers to international format ────────
// Handles:  0771234567  → 263771234567
//           263771234567 → 263771234567  (already correct, no change)
//           +263771234567 → 263771234567 (strips the +)
function _normalizeZimPhone(raw = "") {
  let phone = String(raw).replace(/\D+/g, ""); // strip everything except digits
  if (phone.startsWith("0") && phone.length === 10) {
    phone = "263" + phone.slice(1);            // 0771234567 → 263771234567
  }
  return phone;
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

// ── Low-level: send a pre-approved Meta template message ──────────────────────
async function _sendTemplate(to, templateName, variables = []) {
  const phone = _normalizeZimPhone(to); // ← was: String(to).replace(/\D+/g, "")

  const components = variables.length
    ? [{
        type: "body",
        parameters: variables.map(v => ({ type: "text", text: String(v) }))
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

// ─────────────────────────────────────────────────────────────────────────────
// INTERNAL: Fan out a notification to ALL registered notification contacts.
//
// school.notificationContacts = ["263771000001", "263772000002"]  (set by admin)
// If empty or missing, falls back to school.phone (the single primary number).
//
// Usage:
//   await _notifyAll(school, (phone) => notifySchoolProfileView(phone, school.schoolName, parentPhone));
// ─────────────────────────────────────────────────────────────────────────────
async function _notifyAll(school, notifyFn) {
  const phones = Array.isArray(school.notificationContacts) && school.notificationContacts.length
    ? school.notificationContacts
    : [school.phone];

  await Promise.allSettled(phones.map(phone => notifyFn(phone)));
}

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC: Notify school - a parent viewed their profile
// Template body (submitted to Meta):
//   New school profile view on ZimQuote.
//   School: {{1}}
//   Parent number: {{2}}
//   Time: {{3}}
//   This is an automated activity alert from ZimQuote.
// ─────────────────────────────────────────────────────────────────────────────
export async function notifySchoolProfileView(schoolPhone, schoolName, parentPhone) {
  const ts           = _timestamp();
  const normalizedTo = _normalizeZimPhone(schoolPhone);
  try {
    await _sendTemplate(normalizedTo, "school_profile_view", [schoolName, parentPhone, ts]);
    console.log(`[School Notify] school_profile_view sent to ${normalizedTo}`);
  } catch (err) {
    console.warn(`[School Notify] template failed for ${normalizedTo} (${err.message}), falling back to sendText`);
    try {
      await sendText(
        normalizedTo,
`New school profile view on ZimQuote.

School: ${schoolName}
Parent number: ${parentPhone}
Time: ${ts}

This is an automated activity alert from ZimQuote.`
      );
    } catch (e) {
      console.warn(`[School Notify] fallback sendText also failed for ${normalizedTo}: ${e.message}`);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC: Notify school - a parent sent a typed enquiry message
// Template body (submitted to Meta):
//   New parent enquiry received on ZimQuote.
//   School: {{1}}
//   Parent number: {{2}}
//   Message: {{3}}
//   Time: {{4}}
//   This is an automated activity alert from ZimQuote.
//
// NOTE: Template was originally approved with 3 variables (no message field).
// If the 4-variable template is not yet re-approved, the catch block falls
// back to sendText which includes the full message regardless.
// ─────────────────────────────────────────────────────────────────────────────
export async function notifySchoolEnquiry(schoolPhone, schoolName, parentPhone, message = "") {
  const ts           = _timestamp();
  const normalizedTo = _normalizeZimPhone(schoolPhone);

  // Full text used for fallback (plain sendText) - always includes message
  const fallbackBody = message
    ? `New parent enquiry received on ZimQuote.

School: ${schoolName}
Parent number: ${parentPhone}
Message: ${message}
Time: ${ts}

This is an automated activity alert from ZimQuote.`
    : `New parent enquiry received on ZimQuote.

School: ${schoolName}
Parent number: ${parentPhone}
Time: ${ts}

This is an automated activity alert from ZimQuote.`;

  try {
    // Try 4-variable template first (re-submitted with Message field)
    // Falls back to 3-variable if not yet approved
    await _sendTemplate(normalizedTo, "school_new_enquiry", [
      schoolName,
      parentPhone,
      message || "(no message)",
      ts
    ]);
    console.log(`[School Notify] school_new_enquiry sent to ${normalizedTo}`);
  } catch (err) {
    console.warn(`[School Notify] template failed for ${normalizedTo} (${err.message}), falling back to sendText`);
    try {
      await sendText(normalizedTo, fallbackBody);
    } catch (e) {
      console.warn(`[School Notify] fallback sendText also failed for ${normalizedTo}: ${e.message}`);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC: Notify school - a parent requested to apply
// Template body (submitted to Meta):
//   New application interest received on ZimQuote.
//   School: {{1}}
//   Parent number: {{2}}
//   Time: {{3}}
//   This is an automated activity alert from ZimQuote.
// ─────────────────────────────────────────────────────────────────────────────
export async function notifySchoolApplicationInterest(schoolPhone, schoolName, parentPhone) {
  const ts           = _timestamp();
  const normalizedTo = _normalizeZimPhone(schoolPhone);
  try {
    await _sendTemplate(normalizedTo, "school_application_interest", [schoolName, parentPhone, ts]);
    console.log(`[School Notify] school_application_interest sent to ${normalizedTo}`);
  } catch (err) {
    console.warn(`[School Notify] template failed for ${normalizedTo} (${err.message}), falling back to sendText`);
    try {
      await sendText(
        normalizedTo,
`New application interest received on ZimQuote.

School: ${schoolName}
Parent number: ${parentPhone}
Time: ${ts}

This is an automated activity alert from ZimQuote.`
      );
    } catch (e) {
      console.warn(`[School Notify] fallback sendText also failed for ${normalizedTo}: ${e.message}`);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC: Notify school - a named lead was captured via the Smart Card page
// Template body (submit to Meta as "school_new_lead"):
//   New lead captured on ZimQuote Smart Card.
//   School: {{1}}
//   Parent: {{2}}
//   Action: {{3}}
//   Source: {{4}}
//   Time: {{5}}
//   This is an automated activity alert from ZimQuote.
// ─────────────────────────────────────────────────────────────────────────────
export async function notifySchoolNewLead(schoolPhone, schoolName, parentName, action, source) {
  const ts           = _timestamp();
  const normalizedTo = _normalizeZimPhone(schoolPhone);

  const actionLabels = {
    fees:    "Requested fee schedule",
    visit:   "Requested school visit",
    place:   "Asked about a place",
    pdf:     "Downloaded school profile",
    enquiry: "Sent general enquiry",
    view:    "Viewed profile"
  };
  const actionLabel = actionLabels[action] || action || "Viewed Smart Card";

  try {
    await _sendTemplate(normalizedTo, "school_new_lead", [
      schoolName, parentName, actionLabel, source, ts
    ]);
    console.log(`[School Notify] school_new_lead sent to ${normalizedTo} (${parentName}, ${actionLabel})`);
  } catch (err) {
    console.warn(`[School Notify] school_new_lead template failed for ${normalizedTo} (${err.message}), falling back to sendText`);
    try {
      await sendText(normalizedTo,
`🎯 New lead captured on ZimQuote Smart Card.

School: ${schoolName}
Parent: ${parentName}
Action: ${actionLabel}
Source: ${source}
Time: ${ts}

Reply to this message to contact them directly.

This is an automated alert from ZimQuote.`
      );
    } catch (e) {
      console.warn(`[School Notify] fallback sendText also failed for ${normalizedTo}: ${e.message}`);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC: Notify school - a parent booked a school visit via Smart Card
// Template body (submit to Meta as "school_visit_request"):
//   New school visit request on ZimQuote.
//   School: {{1}}
//   Parent: {{2}}
//   Source: {{3}}
//   Time: {{4}}
//   This is an automated activity alert from ZimQuote.
// ─────────────────────────────────────────────────────────────────────────────
export async function notifySchoolVisitRequest(schoolPhone, schoolName, parentName, source) {
  const ts           = _timestamp();
  const normalizedTo = _normalizeZimPhone(schoolPhone);
  try {
    await _sendTemplate(normalizedTo, "school_visit_request", [
      schoolName, parentName, source, ts
    ]);
    console.log(`[School Notify] school_visit_request sent to ${normalizedTo}`);
  } catch (err) {
    console.warn(`[School Notify] school_visit_request template failed for ${normalizedTo} (${err.message}), falling back to sendText`);
    try {
      await sendText(normalizedTo,
`📅 New school visit request on ZimQuote.

School: ${schoolName}
Parent: ${parentName}
Source: ${source}
Time: ${ts}

Contact them to confirm a visit date.

This is an automated alert from ZimQuote.`
      );
    } catch (e) {
      console.warn(`[School Notify] fallback sendText also failed for ${normalizedTo}: ${e.message}`);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC: Notify school - a parent asked about a specific grade place
// Template body (submit to Meta as "school_place_enquiry"):
//   New place enquiry received on ZimQuote.
//   School: {{1}}
//   Parent: {{2}}
//   Grade: {{3}}
//   Source: {{4}}
//   Time: {{5}}
//   This is an automated activity alert from ZimQuote.
// ─────────────────────────────────────────────────────────────────────────────
export async function notifySchoolPlaceEnquiry(schoolPhone, schoolName, parentName, grade, source) {
  const ts           = _timestamp();
  const normalizedTo = _normalizeZimPhone(schoolPhone);
  const gradeText    = grade || "Not specified";
  try {
    await _sendTemplate(normalizedTo, "school_place_enquiry", [
      schoolName, parentName, gradeText, source, ts
    ]);
    console.log(`[School Notify] school_place_enquiry sent to ${normalizedTo} (${gradeText})`);
  } catch (err) {
    console.warn(`[School Notify] school_place_enquiry template failed for ${normalizedTo} (${err.message}), falling back to sendText`);
    try {
      await sendText(normalizedTo,
`📝 New place enquiry received on ZimQuote.

School: ${schoolName}
Parent: ${parentName}
Grade: ${gradeText}
Source: ${source}
Time: ${ts}

Reply to check availability and follow up.

This is an automated alert from ZimQuote.`
      );
    } catch (e) {
      console.warn(`[School Notify] fallback sendText also failed for ${normalizedTo}: ${e.message}`);
    }
  }
}
// ─────────────────────────────────────────────────────────────────────────────
// FAN-OUT WRAPPERS
// These accept a full school object and notify ALL registered contacts.
// Use these everywhere instead of the single-phone functions above.
//
// schoolSearch.js and other callers should use:
//   notifyAllSchoolProfileView(school, parentPhone)
//   notifyAllSchoolEnquiry(school, parentPhone, message)
//   notifyAllSchoolApplicationInterest(school, parentPhone)
//   notifyAllSchoolNewLead(school, parentName, action, source)
//   notifyAllSchoolVisitRequest(school, parentName, source)
//   notifyAllSchoolPlaceEnquiry(school, parentName, grade, source)
// ─────────────────────────────────────────────────────────────────────────────

export async function notifyAllSchoolProfileView(school, parentPhone) {
  await _notifyAll(school, phone => notifySchoolProfileView(phone, school.schoolName, parentPhone));
}

export async function notifyAllSchoolEnquiry(school, parentPhone, message = "") {
  await _notifyAll(school, phone => notifySchoolEnquiry(phone, school.schoolName, parentPhone, message));
}

export async function notifyAllSchoolApplicationInterest(school, parentPhone) {
  await _notifyAll(school, phone => notifySchoolApplicationInterest(phone, school.schoolName, parentPhone));
}

export async function notifyAllSchoolNewLead(school, parentName, action, source) {
  await _notifyAll(school, phone => notifySchoolNewLead(phone, school.schoolName, parentName, action, source));
}

export async function notifyAllSchoolVisitRequest(school, parentName, source) {
  await _notifyAll(school, phone => notifySchoolVisitRequest(phone, school.schoolName, parentName, source));
}

export async function notifyAllSchoolPlaceEnquiry(school, parentName, grade, source) {
  await _notifyAll(school, phone => notifySchoolPlaceEnquiry(phone, school.schoolName, parentName, grade, source));
}