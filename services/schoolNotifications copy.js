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

const GRAPH_API_VERSION = "v19.0";
const PHONE_NUMBER_ID   = process.env.WHATSAPP_PHONE_NUMBER_ID;
const ACCESS_TOKEN      = process.env.WHATSAPP_ACCESS_TOKEN;

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
  const phone = String(to).replace(/\D+/g, "");

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
// PUBLIC: Notify school — a parent viewed their profile
// Template body (submitted to Meta):
//   New school profile view on ZimQuote.
//   School: {{1}}
//   Parent number: {{2}}
//   Time: {{3}}
//   This is an automated activity alert from ZimQuote.
// ─────────────────────────────────────────────────────────────────────────────
export async function notifySchoolProfileView(schoolPhone, schoolName, parentPhone) {
  const ts = _timestamp();
  try {
    await _sendTemplate(schoolPhone, "school_profile_view", [schoolName, parentPhone, ts]);
    console.log(`[School Notify] school_profile_view sent to ${schoolPhone}`);
  } catch (err) {
    console.warn(`[School Notify] template failed (${err.message}), falling back to sendText`);
    try {
      await sendText(
        schoolPhone,
`New school profile view on ZimQuote.

School: ${schoolName}
Parent number: ${parentPhone}
Time: ${ts}

This is an automated activity alert from ZimQuote.`
      );
    } catch (e) { /* non-critical */ }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC: Notify school — a parent tapped Contact School
// Template body (submitted to Meta):
//   New parent enquiry received on ZimQuote.
//   School: {{1}}
//   Parent number: {{2}}
//   Time: {{3}}
//   This is an automated activity alert from ZimQuote.
// ─────────────────────────────────────────────────────────────────────────────
export async function notifySchoolEnquiry(schoolPhone, schoolName, parentPhone) {
  const ts = _timestamp();
  try {
    await _sendTemplate(schoolPhone, "school_new_enquiry", [schoolName, parentPhone, ts]);
    console.log(`[School Notify] school_new_enquiry sent to ${schoolPhone}`);
  } catch (err) {
    console.warn(`[School Notify] template failed (${err.message}), falling back to sendText`);
    try {
      await sendText(
        schoolPhone,
`New parent enquiry received on ZimQuote.

School: ${schoolName}
Parent number: ${parentPhone}
Time: ${ts}

This is an automated activity alert from ZimQuote.`
      );
    } catch (e) { /* non-critical */ }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC: Notify school — a parent requested to apply
// Template body (submitted to Meta):
//   New application interest received on ZimQuote.
//   School: {{1}}
//   Parent number: {{2}}
//   Time: {{3}}
//   This is an automated activity alert from ZimQuote.
// ─────────────────────────────────────────────────────────────────────────────
export async function notifySchoolApplicationInterest(schoolPhone, schoolName, parentPhone) {
  const ts = _timestamp();
  try {
    await _sendTemplate(schoolPhone, "school_application_interest", [schoolName, parentPhone, ts]);
    console.log(`[School Notify] school_application_interest sent to ${schoolPhone}`);
  } catch (err) {
    console.warn(`[School Notify] template failed (${err.message}), falling back to sendText`);
    try {
      await sendText(
        schoolPhone,
`New application interest received on ZimQuote.

School: ${schoolName}
Parent number: ${parentPhone}
Time: ${ts}

This is an automated activity alert from ZimQuote.`
      );
    } catch (e) { /* non-critical */ }
  }
}