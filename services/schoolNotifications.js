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
        // Meta rejects template params containing newlines/tabs or 4+ spaces
        // (error 132018) - a parent's multi-line question used to fail here and
        // only reach the school if they happened to be inside the 24h window.
        parameters: variables.map(v => ({
          type: "text",
          text: (String(v ?? "").replace(/[\r\n\t]+/g, " ").replace(/ {2,}/g, " ").trim() || "-").slice(0, 1000)
        }))
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
  // Always notify the primary phone PLUS any extra notification contacts.
  // notificationContacts are additional numbers - they never replace the primary.
  const extra  = Array.isArray(school.notificationContacts) ? school.notificationContacts : [];
  const phones = [...new Set([school.phone, ...extra])].filter(Boolean);

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
// ─────────────────────────────────────────────────────────────────────────────
// BRANCH-AWARE FAN-OUT (multi-campus schools)
// When a parent is on a specific branch, the alert goes to:
//   • the school's primary phone + notificationContacts (head office), and
//   • that branch's contactPhone + notificationContacts,
// with the branch name in the School field ("Firm Foundation - Borrowdale"),
// so every receiving number knows which campus the parent wants.
// branch = null behaves exactly like the notifyAll* wrappers (numbers are
// normalised before de-duplication, so 077… and 26377… are not sent twice).
// Uses only the already-approved templates - no new Meta approval needed.
// ─────────────────────────────────────────────────────────────────────────────
export function schoolBranchLabel(school, branch) {
  return branch && branch.name ? `${school.schoolName} - ${branch.name}` : school.schoolName;
}

export function schoolBranchPhones(school, branch) {
  const raw = [
    school.phone,
    ...(Array.isArray(school.notificationContacts) ? school.notificationContacts : []),
    ...(branch ? [branch.contactPhone, ...(Array.isArray(branch.notificationContacts) ? branch.notificationContacts : [])] : [])
  ];
  return [...new Set(raw.map(p => _normalizeZimPhone(p)).filter(p => p && p.length >= 9))];
}

async function _notifyBranch(school, branch, fn) {
  const label = schoolBranchLabel(school, branch);
  await Promise.allSettled(schoolBranchPhones(school, branch).map(p => fn(p, label)));
}

// "Branch opened" alert. Throttled per parent+branch (30 min) so a parent
// flicking back and forth doesn't flood the school's phones.
const _branchViewSeen = new Map();
export async function notifyBranchProfileView(school, branch, parentPhone) {
  const key = `${school._id}|${branch?.id || "main"}|${parentPhone}`;
  const now = Date.now();
  if (now - (_branchViewSeen.get(key) || 0) < 30 * 60 * 1000) return;
  _branchViewSeen.set(key, now);
  if (_branchViewSeen.size > 5000) {
    for (const [k, t] of _branchViewSeen) if (now - t > 30 * 60 * 1000) _branchViewSeen.delete(k);
  }
  await _notifyBranch(school, branch, (p, label) => notifySchoolProfileView(p, label, parentPhone));
}

export async function notifyBranchEnquiry(school, branch, parentPhone, message = "") {
  await _notifyBranch(school, branch, (p, label) => notifySchoolEnquiry(p, label, parentPhone, message));
}

export async function notifyBranchApplicationInterest(school, branch, parentPhone) {
  await _notifyBranch(school, branch, (p, label) => notifySchoolApplicationInterest(p, label, parentPhone));
}

export async function notifyBranchVisitRequest(school, branch, parentName, source, preferred = "") {
  const src = preferred ? `${source} - preferred: ${String(preferred).slice(0, 80)}` : source;
  await _notifyBranch(school, branch, (p, label) => notifySchoolVisitRequest(p, label, parentName, src));
}

export async function notifyBranchPlaceEnquiry(school, branch, parentName, grade, source) {
  await _notifyBranch(school, branch, (p, label) => notifySchoolPlaceEnquiry(p, label, parentName, grade, source));
}

// A completed WhatsApp application. Uses the approved school_new_lead template,
// so it reaches the school even outside WhatsApp's 24-hour window (the plain
// "New WhatsApp Application" text only arrives inside that window).
export async function notifyBranchApplicationSubmitted(school, branch, data = {}, parentPhone = "") {
  const who    = [data.parentName, data.parentPhone || parentPhone].filter(Boolean).join(" ");
  const action = `Submitted an application - ${data.studentName || "student"}, ${data.grade || "grade not given"}`;
  await _notifyBranch(school, branch, (p, label) =>
    notifySchoolNewLead(p, label, who || String(parentPhone || "Parent"), action.slice(0, 120), "WhatsApp application form"));
}