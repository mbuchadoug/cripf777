// services/groupSmartLink.js
// ─── ZimQuote Group Smart Link Engine ────────────────────────────────────────
//
// A "group" bundles multiple sellers under one shareable WhatsApp link.
// e.g.  ZQ:GROUP:plumber-zim  →  list of all plumbers → buyer taps one → showSellerMenu
//
// Deep link format:
//   https://wa.me/<BOT>?text=ZQ:GROUP:<slug>
//
// ─── CHATBOT FLOWS ───────────────────────────────────────────────────────────
//
// BUYER / VISITOR FLOW (existing):
//   1. Visitor sends "ZQ:GROUP:<slug>"
//   2. handleGroupSmartLink() sends a WhatsApp list of sellers + "List Your Biz" CTA row
//   3. Visitor taps a seller → handleGroupSellerTap() → showSellerMenu()
//
// NEW - SELLER SELF-REGISTRATION FLOW:
//   1. Visitor taps "➕ List Your Business Here" row  (action: zqg_register_<slug>)
//   2. handleGroupSellerTap() detects "zqg_register_" prefix
//   3. handleGroupRegistrationFlow() is called:
//        a. Checks if visitor is already a registered supplier
//           → if YES: shows their own seller menu + friendly message
//        b. If NOT registered (or incomplete):
//           → Calls startSupplierRegistration() - the exact same WhatsApp flow
//              as tapping "List My Business" on the main menu
//           → Tracks registrationTap counter on the group (analytics)
//           → Notifies admin (non-blocking): who tapped, which group
//
// ─── ADMIN CRUD (called from supplierAdmin.js) ───────────────────────────────
//   createGroup / getAllGroups / getGroupBySlug / addSellerToGroup /
//   removeSellerFromGroup / deleteGroup / setGroupTagline / setGroupCTA /
//   validateGroupSlug
//
// ─── LINK BUILDERS (called from supplierAdmin.js page rendering) ─────────────
//   buildGroupDeepLink / buildGroupQrImageUrl
//
// ─── NEW SCHEMA FIELDS ───────────────────────────────────────────────────────
//   registrationTaps  {Number}  - total "List Your Biz" taps (analytics)
//   ctaText           {String}  - custom CTA label (override default per group)
//
// ─────────────────────────────────────────────────────────────────────────────

import mongoose from "mongoose";
import { sendList, sendText, sendButtons } from "./metaSender.js";
import { showSellerMenu }                   from "./sellerChat.js";

// ─── Config ───────────────────────────────────────────────────────────────────
const BOT_NUMBER  = (process.env.WHATSAPP_BOT_NUMBER || "263771143904").replace(/\D/g, "");
const BOT_WA_URL  = `https://wa.me/${BOT_NUMBER}`;

// ─── Mongoose model ───────────────────────────────────────────────────────────

const supplierGroupSchema = new mongoose.Schema(
  {
    slug:      { type: String, required: true, unique: true, lowercase: true, trim: true },
    name:      { type: String, required: true, trim: true },
    tagline:   { type: String, default: "" },
    active:    { type: Boolean, default: true },

    // ── Analytics ─────────────────────────────────────────────────────────────
    viewCount:        { type: Number, default: 0 }, // group link opens
    registrationTaps: { type: Number, default: 0 }, // "List Your Biz" taps

    // ── Custom CTA label (optional) ───────────────────────────────────────────
    // Shown as the bottom row in the seller list.
    // e.g. "Are you a plumber? Get listed FREE 👇"
    // Falls back to the default label if blank.
    ctaText: { type: String, default: "" },

    // sellers: ordered array of { supplierId, order }
    sellers: [
      {
        supplierId: { type: mongoose.Schema.Types.ObjectId, ref: "SupplierProfile" },
        order:      { type: Number, default: 0 }
      }
    ]
  },
  { timestamps: true }
);

const SupplierGroup = mongoose.models.SupplierGroup
  || mongoose.model("SupplierGroup", supplierGroupSchema);

// ─── Slug validation ──────────────────────────────────────────────────────────

/**
 * Returns null if slug is valid, or an error string if invalid.
 * Slug rules: 2-40 chars, lowercase letters / digits / hyphens only,
 * no leading/trailing hyphen, no double hyphens.
 */
export function validateGroupSlug(slug = "") {
  const s = String(slug).toLowerCase().trim();
  if (s.length < 2)  return "Slug must be at least 2 characters.";
  if (s.length > 40) return "Slug must be 40 characters or less.";
  if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(s) && !/^[a-z0-9]$/.test(s))
    return "Slug may only contain lowercase letters, numbers, and hyphens, and must not start or end with a hyphen.";
  if (/--/.test(s))
    return "Slug may not contain consecutive hyphens.";
  return null;
}

// ─── Link builders ────────────────────────────────────────────────────────────

export function buildGroupDeepLink(slug) {
  const payload = `ZQ:GROUP:${slug}`;
  return `${BOT_WA_URL}?text=${encodeURIComponent(payload)}`;
}

export function buildGroupQrImageUrl(slug, sizePx = 400) {
  const link    = buildGroupDeepLink(slug);
  const encoded = encodeURIComponent(link);
  return `https://chart.googleapis.com/chart?cht=qr&chs=${sizePx}x${sizePx}&chl=${encoded}&choe=UTF-8`;
}


// ─── CRUD ─────────────────────────────────────────────────────────────────────

export async function getAllGroups() {
  return SupplierGroup.find({}).sort({ createdAt: -1 }).lean();
}

export async function getGroupBySlug(slug) {
  return SupplierGroup.findOne({ slug: String(slug).toLowerCase().trim() }).lean();
}

export async function createGroup({ slug, name, tagline = "" }) {
  const s = String(slug).toLowerCase().trim();
  const err = validateGroupSlug(s);
  if (err) throw new Error(err);

  const existing = await SupplierGroup.findOne({ slug: s });
  if (existing) throw new Error(`Slug "${s}" is already taken.`);

  return SupplierGroup.create({ slug: s, name: String(name).trim(), tagline: String(tagline).trim() });
}

export async function deleteGroup(slug) {
  return SupplierGroup.findOneAndDelete({ slug: String(slug).toLowerCase().trim() });
}

export async function setGroupTagline(slug, tagline) {
  return SupplierGroup.findOneAndUpdate(
    { slug: String(slug).toLowerCase().trim() },
    { $set: { tagline: String(tagline || "").trim() } },
    { new: true }
  );
}

/**
 * Set or clear a custom CTA label for the "List Your Business" row.
 * Pass an empty string to revert to the default label.
 *
 * @example
 *   await setGroupCTA("plumbers-zim", "Are you a plumber? Get listed FREE 👇")
 *   await setGroupCTA("plumbers-zim", "")   // revert to default
 */
export async function setGroupCTA(slug, ctaText) {
  return SupplierGroup.findOneAndUpdate(
    { slug: String(slug).toLowerCase().trim() },
    { $set: { ctaText: String(ctaText || "").trim().slice(0, 72) } }, // WhatsApp row title limit
    { new: true }
  );
}

/**
 * Add a supplier to a group by phone number.
 * Looks up the supplier by phone, then pushes to group.sellers (no duplicates).
 */
export async function addSellerToGroup(slug, phone) {
  const SupplierProfile = (await import("../models/supplierProfile.js")).default;
  const cleanPhone = String(phone || "").replace(/\D/g, "");
  const supplier = await SupplierProfile.findOne({ phone: cleanPhone }).lean();
  if (!supplier) throw new Error(`No supplier found with phone ${cleanPhone}`);

  const group = await SupplierGroup.findOne({ slug: String(slug).toLowerCase().trim() });
  if (!group) throw new Error(`Group "${slug}" not found`);

  const alreadyIn = (group.sellers || []).some(
    s => String(s.supplierId) === String(supplier._id)
  );
  if (alreadyIn) throw new Error(`${supplier.businessName} is already in this group.`);

  const nextOrder = Math.max(0, ...(group.sellers || []).map(s => s.order ?? 0)) + 1;
  group.sellers.push({ supplierId: supplier._id, order: nextOrder });
  await group.save();
  return group;
}

/**
 * Remove a supplier from a group by phone number.
 */
export async function removeSellerFromGroup(slug, phone) {
  const SupplierProfile = (await import("../models/supplierProfile.js")).default;
  const cleanPhone = String(phone || "").replace(/\D/g, "");
  const supplier = await SupplierProfile.findOne({ phone: cleanPhone }).lean();
  if (!supplier) throw new Error(`No supplier found with phone ${cleanPhone}`);

  const group = await SupplierGroup.findOne({ slug: String(slug).toLowerCase().trim() });
  if (!group) throw new Error(`Group "${slug}" not found`);

  group.sellers = (group.sellers || []).filter(
    s => String(s.supplierId) !== String(supplier._id)
  );
  await group.save();
  return group;
}

// ─── Chatbot: handle ZQ:GROUP:<slug> ─────────────────────────────────────────

/**
 * Called when a buyer/visitor sends "ZQ:GROUP:<slug>" (text or QR scan).
 *
 * Renders a WhatsApp interactive list with:
 *   - Up to 9 active sellers (admin-ordered)
 *   - A final "➕ List Your Business Here" CTA row  (action: zqg_register_<slug>)
 *
 * Returns true if handled, false if group not found / inactive.
 */
export async function handleGroupSmartLink({ from, slug, biz, saveBiz }) {
  try {
    const group = await SupplierGroup.findOne({ slug: String(slug).toLowerCase().trim() }).lean();
    if (!group || !group.active) return false;

    // Track view (non-blocking)
    SupplierGroup.findByIdAndUpdate(group._id, { $inc: { viewCount: 1 } }).catch(() => {});

    // Notify admin (non-blocking)
    _notifyAdminGroupOpened(group, from).catch(() => {});

    const sellerIds = (group.sellers || [])
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
      .map(s => s.supplierId);

    // ── Build the CTA row (always shown, regardless of seller count) ──────────
    const ctaLabel       = group.ctaText || "➕ List Your Business";
    const ctaDescription = "Tap to register and get found by buyers";
    const ctaRow = {
      id:          `zqg_register_${group.slug}`,
      title:       ctaLabel.slice(0, 24),       // WhatsApp hard limit: 24 chars
      description: ctaDescription.slice(0, 72)  // WhatsApp hard limit: 72 chars
    };

    // ── No sellers yet - still show the CTA so they can register ─────────────
    if (!sellerIds.length) {
      const header = `🏪 *${group.name}*\n\nNo businesses listed yet - be the first!`;
      await sendList(from, header, [ctaRow]);
      return true;
    }

    // ── Load active seller profiles ───────────────────────────────────────────
    const SupplierProfile = (await import("../models/supplierProfile.js")).default;
    const sellers = await SupplierProfile.find(
      { _id: { $in: sellerIds }, active: true },
      { businessName: 1, location: 1, profileType: 1, _id: 1 }
    ).lean();

    // Preserve admin-defined order
    const orderedSellers = sellerIds
      .map(id => sellers.find(s => String(s._id) === String(id)))
      .filter(Boolean);

    if (!orderedSellers.length) {
      const header = `😕 No active sellers in *${group.name}* right now.\n\nBe the first to get listed!`;
      await sendList(from, header, [ctaRow]);
      return true;
    }

    // ── Build seller rows (max 9 sellers + 1 CTA = 10 rows total, WA list limit) ─
    const sellerRows = orderedSellers.slice(0, 9).map(s => {
      const loc = [s.location?.area, s.location?.city].filter(Boolean).join(", ");
      return {
        id:          `zqg_sel_${s._id}`,
        title:       (s.businessName || "Seller").slice(0, 24),
        description: (loc || undefined)
      };
    });

    const tagline = group.tagline || "Tap a business to view their profile, catalogue and request a quote.";
    const header  = `🏪 *${group.name}*\n\n${tagline}`;

    // Sellers first, CTA last
    await sendList(from, header, [...sellerRows, ctaRow]);
    return true;

  } catch (err) {
    console.error("[GROUP SMART LINK ERROR]", err.message);
    return false;
  }
}

// ─── Chatbot: handle zqg_sel_* and zqg_register_* ────────────────────────────

/**
 * Routes list-row taps from the group seller list.
 *
 * Handles two action prefixes:
 *   zqg_sel_<supplierId>    → showSellerMenu()
 *   zqg_register_<slug>     → handleGroupRegistrationFlow()
 *
 * Returns true if handled, false if not.
 */
export async function handleGroupSellerTap({ from, action, biz, saveBiz }) {
  const actionStr = String(action || "").trim();

  // ── Route: registration CTA ───────────────────────────────────────────────
  if (/^zqg_register_/i.test(actionStr)) {
    const slug = actionStr.replace(/^zqg_register_/i, "").trim();
    return handleGroupRegistrationFlow({ from, slug, biz, saveBiz });
  }

  // ── Route: seller profile tap ─────────────────────────────────────────────
  if (/^zqg_sel_/i.test(actionStr)) {
    try {
      const supplierId = actionStr.replace(/^zqg_sel_/i, "").trim();
      if (!supplierId || supplierId.length !== 24) {
        console.warn(`[GROUP SELLER TAP] Invalid supplierId from action="${action}"`);
        return false;
      }

      console.log(`[GROUP SELLER TAP] from=${from} supplierId=${supplierId}`);
      await showSellerMenu(from, supplierId, biz, saveBiz, { source: "group" });
      return true;

    } catch (err) {
      console.error("[GROUP SELLER TAP ERROR]", err.message, err.stack);
      try { await sendText(from, "❌ Could not load seller profile. Please try again."); } catch (_) {}
      return true; // prevent chatbotEngine fall-through
    }
  }

  return false;
}

// ─── NEW: Seller self-registration flow ──────────────────────────────────────

/**
 * Handles a tap on the "List Your Business Here" CTA row.
 *
 * Logic:
 *   1. If visitor is already a registered supplier  → show their own menu + note.
 *   2. If NOT registered:
 *        a. Send warm pitch message with benefits
 *        b. Send a registration link  (pre-filled with phone + referral slug)
 *        c. Increment group.registrationTaps  (analytics)
 *        d. Notify admin (non-blocking)
 *
 * Returns true always (fully handled).
 */
export async function handleGroupRegistrationFlow({ from, slug, biz, saveBiz }) {
  try {
    console.log(`[GROUP REGISTER] from=${from} slug=${slug}`);

    // ── Track analytics + notify admin (non-blocking) ────────────────────────
    const group = await SupplierGroup.findOne({ slug: String(slug).toLowerCase().trim() }).lean();
    if (group) {
      SupplierGroup.findByIdAndUpdate(group._id, { $inc: { registrationTaps: 1 } }).catch(() => {});
      _notifyAdminRegistrationTap({ group, visitorPhone: from }).catch(() => {});
    }

    // ── Delegate entirely to startSupplierRegistration ───────────────────────
    // This is the exact same function called when a user taps "List My Business"
    // on the main menu. It handles all cases:
    //   • Already active supplier  → shows their account menu
    //   • Incomplete registration  → resumes where they left off
    //   • First-time visitor       → shows "What would you like to list?" picker
    //     (Products / Services / School) and starts the full WhatsApp reg flow
    const { startSupplierRegistration } = await import("./supplierRegistration.js");
    await startSupplierRegistration(from, biz || null);
    return true;

  } catch (err) {
    console.error("[GROUP REGISTER ERROR]", err.message, err.stack);
    try {
      await sendText(from, "❌ Something went wrong. Please type *menu* to continue.");
    } catch (_) {}
    return true;
  }
}

// ─── Admin group command handler ──────────────────────────────────────────────

/**
 * Handles "admin group <command>" typed by admin phone.
 * Returns true if handled.
 */
export async function handleGroupAdminCommand({ from, text }) {
  const parts  = String(text || "").trim().toLowerCase().split(/\s+/);
  const subCmd = parts[2] || "";
  console.log(`[GROUP ADMIN CMD] from=${from} subCmd=${subCmd}`);
  await sendText(from, `ℹ️ Group admin command received: "${text}". No automated action taken.`);
  return true;
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

async function _notifyAdminGroupOpened(group, visitorPhone) {
  try {
    const { notifyAdminGroupLinkOpened } = await import("./buyerRequestNotifications.js");
    await notifyAdminGroupLinkOpened({
      groupName:    group.name,
      slug:         group.slug,
      viewCount:    (group.viewCount || 0) + 1,
      visitorPhone: visitorPhone
    });
  } catch (_) {
    // Non-critical
  }
}

/**
 * Notify admin when someone taps "List Your Business" in a group.
 * Uses sendText (session-based) - non-blocking, failure is silent.
 *
 * Message format:
 *   ➕ New registration tap!
 *   Group: Plumbers Zimbabwe (plumbers-zim)
 *   Phone: +263 77 312 3456
 *   Time: 28 May, 14:32
 */
async function _notifyAdminRegistrationTap({ group, visitorPhone }) {
  try {
    const adminPhone = String(
      process.env.ZQ_ADMIN_PHONE || process.env.ADMIN_WHATSAPP_PHONE || ""
    ).replace(/\D/g, "");
    if (!adminPhone || adminPhone.length < 10) return;

    const timeStr = new Date().toLocaleString("en-GB", {
      day: "numeric", month: "short", hour: "2-digit", minute: "2-digit"
    });

    const displayPhone = _formatPhoneDisplay(visitorPhone);

    await sendText(
      adminPhone,
      `➕ *New registration tap!*\n\n` +
      `Group: *${group.name}* (${group.slug})\n` +
      `Phone: ${displayPhone}\n` +
      `Time: ${timeStr}\n\n` +
      `_This visitor tapped "List Your Business" and was sent the registration link._`
    );
    console.log(`[GROUP REGISTER ADMIN] notified ${adminPhone} - visitor ${visitorPhone} tapped register on "${group.slug}"`);
  } catch (_) {
    // Non-critical - never let this break the main flow
  }
}

// ── Format phone for display  e.g.  "263773123456" → "+263 77 312 3456" ──────
function _formatPhoneDisplay(raw = "") {
  const digits = String(raw).replace(/\D/g, "");
  let d = digits;
  if (d.startsWith("0") && d.length === 10) d = "263" + d.slice(1);
  if (d.startsWith("263") && d.length >= 12) {
    return `+263 ${d.slice(3, 5)} ${d.slice(5, 8)} ${d.slice(8)}`;
  }
  return `+${d}`;
}

// ══════════════════════════════════════════════════════════════════════════════
// ─── SCHOOL GROUP SMART LINKS ─────────────────────────────────────────────────
//
// A "school group" bundles multiple SchoolProfile entries under one shareable link.
// Deep link format: https://wa.me/<BOT>?text=ZQ:SGROUP:<slug>
//
// Chatbot flow:
//   1. Visitor sends "ZQ:SGROUP:<slug>"
//   2. handleSchoolGroupSmartLink() shows WhatsApp list of schools
//      with action IDs  zqsg_sch_<schoolId>
//   3. Visitor taps a school → handleSchoolGroupTap() → showSchoolFAQMenu()
//      (identical experience to opening a ZQ:SCHOOL: deep link)
//   4. Bottom CTA row "🏫 Add My School" → handleSchoolGroupRegFlow()
//      → startSupplierRegistration() with school path pre-selected
//
// Admin CRUD (called from supplierAdmin.js):
//   createSchoolGroup / getAllSchoolGroups / getSchoolGroupBySlug /
//   addSchoolToGroup / removeSchoolFromGroup / deleteSchoolGroup /
//   setSchoolGroupTagline / validateGroupSlug (shared)
//
// Link builders:
//   buildSchoolGroupDeepLink / buildSchoolGroupQrImageUrl
// ══════════════════════════════════════════════════════════════════════════════

// ─── Mongoose model ────────────────────────────────────────────────────────────
const schoolGroupSchema = new mongoose.Schema(
  {
    slug:      { type: String, required: true, unique: true, lowercase: true, trim: true },
    name:      { type: String, required: true, trim: true },
    tagline:   { type: String, default: "" },
    active:    { type: Boolean, default: true },
    ctaText:   { type: String, default: "" },

    viewCount:        { type: Number, default: 0 },
    registrationTaps: { type: Number, default: 0 },

    // schools: ordered array of { schoolId, order }
    schools: [
      {
        schoolId: { type: mongoose.Schema.Types.ObjectId, ref: "SchoolProfile" },
        order:    { type: Number, default: 0 }
      }
    ]
  },
  { timestamps: true }
);

const SchoolGroup = mongoose.models.SchoolGroup
  || mongoose.model("SchoolGroup", schoolGroupSchema);

// ─── Link builders ─────────────────────────────────────────────────────────────

export function buildSchoolGroupDeepLink(slug) {
  const payload = `ZQ:SGROUP:${slug}`;
  return `${BOT_WA_URL}?text=${encodeURIComponent(payload)}`;
}

export function buildSchoolGroupQrImageUrl(slug, sizePx = 400) {
  const link    = buildSchoolGroupDeepLink(slug);
  const encoded = encodeURIComponent(link);
  return `https://chart.googleapis.com/chart?cht=qr&chs=${sizePx}x${sizePx}&chl=${encoded}&choe=UTF-8`;
}

// ─── CRUD ──────────────────────────────────────────────────────────────────────

export async function getAllSchoolGroups() {
  return SchoolGroup.find({}).sort({ createdAt: -1 }).lean();
}

export async function getSchoolGroupBySlug(slug) {
  return SchoolGroup.findOne({ slug: String(slug).toLowerCase().trim() }).lean();
}

export async function createSchoolGroup({ slug, name, tagline = "" }) {
  const s = String(slug).toLowerCase().trim();
  const err = validateGroupSlug(s);
  if (err) throw new Error(err);
  const existing = await SchoolGroup.findOne({ slug: s });
  if (existing) throw new Error(`Slug "${s}" is already taken.`);
  return SchoolGroup.create({ slug: s, name: String(name).trim(), tagline: String(tagline).trim() });
}

export async function deleteSchoolGroup(slug) {
  return SchoolGroup.findOneAndDelete({ slug: String(slug).toLowerCase().trim() });
}

export async function setSchoolGroupTagline(slug, tagline) {
  return SchoolGroup.findOneAndUpdate(
    { slug: String(slug).toLowerCase().trim() },
    { $set: { tagline: String(tagline || "").trim() } },
    { new: true }
  );
}

/**
 * Add a school to a school group by phone number.
 */
export async function addSchoolToGroup(slug, phone) {
  const { default: SchoolProfile } = await import("../models/schoolProfile.js");
  const cleanPhone = String(phone || "").replace(/\D/g, "");
  const school = await SchoolProfile.findOne({ phone: cleanPhone }).lean();
  if (!school) throw new Error(`No school found with phone ${cleanPhone}`);

  const group = await SchoolGroup.findOne({ slug: String(slug).toLowerCase().trim() });
  if (!group) throw new Error(`School group "${slug}" not found`);

  const alreadyIn = (group.schools || []).some(
    s => String(s.schoolId) === String(school._id)
  );
  if (alreadyIn) throw new Error(`${school.schoolName} is already in this group.`);

  const nextOrder = Math.max(0, ...(group.schools || []).map(s => s.order ?? 0)) + 1;
  group.schools.push({ schoolId: school._id, order: nextOrder });
  await group.save();
  return group;
}

/**
 * Remove a school from a school group by phone number.
 */
export async function removeSchoolFromGroup(slug, phone) {
  const { default: SchoolProfile } = await import("../models/schoolProfile.js");
  const cleanPhone = String(phone || "").replace(/\D/g, "");
  const school = await SchoolProfile.findOne({ phone: cleanPhone }).lean();
  if (!school) throw new Error(`No school found with phone ${cleanPhone}`);

  const group = await SchoolGroup.findOne({ slug: String(slug).toLowerCase().trim() });
  if (!group) throw new Error(`School group "${slug}" not found`);

  group.schools = (group.schools || []).filter(
    s => String(s.schoolId) !== String(school._id)
  );
  await group.save();
  return group;
}

// ─── Chatbot: handle ZQ:SGROUP:<slug> ─────────────────────────────────────────

/**
 * Called when a visitor sends "ZQ:SGROUP:<slug>".
 * Sends a WhatsApp list of schools in the group + "Add My School" CTA for non-schools.
 * Returns true if handled, false if group not found / inactive.
 */
export async function handleSchoolGroupSmartLink({ from, slug, biz, saveBiz }) {
  try {
    const group = await SchoolGroup.findOne({ slug: String(slug).toLowerCase().trim() }).lean();
    if (!group || !group.active) return false;

    // Track view (non-blocking)
    SchoolGroup.findByIdAndUpdate(group._id, { $inc: { viewCount: 1 } }).catch(() => {});

    // Notify admin - non-blocking, never breaks main flow
    _notifyAdminSchoolGroupOpened(group, from).catch(() => {});

    const { default: SchoolProfile } = await import("../models/schoolProfile.js");

    // ── Check if visitor is already a registered school ───────────────────────
    const cleanPhone = String(from || "").replace(/\D/g, "");
    const visitorIsSchool = !!(await SchoolProfile.findOne({ phone: cleanPhone }, { _id: 1 }).lean());

    // ── Build CTA row (only for non-registered visitors) ──────────────────────
    const ctaLabel = (group.ctaText || "🏫 Add My School").slice(0, 24);
    const ctaRow = visitorIsSchool ? null : {
      id:          `zqsg_register_${group.slug}`,
      title:       ctaLabel,
      description: "Tap to list your school for free"
    };

    const schoolIds = (group.schools || [])
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
      .map(s => s.schoolId);

    // ── No schools yet ────────────────────────────────────────────────────────
    if (!schoolIds.length) {
      const header = `🏫 *${group.name}*\n\nNo schools listed yet - be the first!`;
      const rows = ctaRow ? [ctaRow] : [];
      if (!rows.length) {
        await sendText(from, `❌ *${group.name}* has no schools yet. Check back soon!`);
        return true;
      }
      await sendList(from, header, rows);
      return true;
    }

    // ── Load active school profiles ───────────────────────────────────────────
    const schools = await SchoolProfile.find(
      { _id: { $in: schoolIds }, active: true },
      { schoolName: 1, city: 1, suburb: 1, type: 1, _id: 1 }
    ).lean();

    // Preserve admin-defined order
    const orderedSchools = schoolIds
      .map(id => schools.find(s => String(s._id) === String(id)))
      .filter(Boolean);

    if (!orderedSchools.length) {
      const header = `😕 No active schools in *${group.name}* right now.`;
      const rows = ctaRow ? [ctaRow] : [];
      if (!rows.length) {
        await sendText(from, `😕 No active schools in *${group.name}* right now. Try again later.`);
        return true;
      }
      await sendList(from, header, rows);
      return true;
    }

    // ── Build school rows ─────────────────────────────────────────────────────
    const maxSchools = ctaRow ? 9 : 10;
    const schoolRows = orderedSchools.slice(0, maxSchools).map(s => {
      const loc = [s.suburb, s.city].filter(Boolean).join(", ");
      return {
        id:          `zqsg_sch_${s._id}`,
        title:       (s.schoolName || "School").slice(0, 24),
        description: (loc || undefined)
      };
    });

    const tagline = group.tagline || "Tap a school to view fees, facilities and enquire about admissions.";
    const header  = `🏫 *${group.name}*\n\n${tagline}`;

    const rows = ctaRow ? [...schoolRows, ctaRow] : schoolRows;
    await sendList(from, header, rows);
    return true;

  } catch (err) {
    console.error("[SCHOOL GROUP SMART LINK ERROR]", err.message);
    return false;
  }
}

// ─── Chatbot: handle zqsg_sch_* and zqsg_register_* ───────────────────────────

/**
 * Routes school group list-row taps.
 *   zqsg_sch_<schoolId>   → showSchoolFAQMenu() (same as ZQ:SCHOOL: deep link)
 *   zqsg_register_<slug>  → handleSchoolGroupRegFlow()
 */
export async function handleSchoolGroupTap({ from, action, biz, saveBiz }) {
  const actionStr = String(action || "").trim();

  // ── Route: register CTA ───────────────────────────────────────────────────
  if (/^zqsg_register_/i.test(actionStr)) {
    const slug = actionStr.replace(/^zqsg_register_/i, "").trim();
    return handleSchoolGroupRegFlow({ from, slug, biz, saveBiz });
  }

  // ── Route: school profile tap ─────────────────────────────────────────────
  if (/^zqsg_sch_/i.test(actionStr)) {
    try {
      const schoolId = actionStr.replace(/^zqsg_sch_/i, "").trim();
      if (!schoolId || schoolId.length !== 24) {
        console.warn(`[SCHOOL GROUP TAP] Invalid schoolId from action="${action}"`);
        return false;
      }
      console.log(`[SCHOOL GROUP TAP] from=${from} schoolId=${schoolId}`);

      // Track view on the school (non-blocking)
      const { default: SchoolProfile } = await import("../models/schoolProfile.js");
      SchoolProfile.findByIdAndUpdate(schoolId, { $inc: { monthlyViews: 1 } }).catch(() => {});

      // Notify admin which school was tapped and by whom - non-blocking
      SchoolProfile.findById(schoolId, { schoolName: 1, city: 1 }).lean().then(sch => {
        if (sch) _notifyAdminSchoolTapped(sch, from).catch(() => {});
      }).catch(() => {});

      // Open school FAQ menu - identical to tapping a ZQ:SCHOOL: link
      const { showSchoolFAQMenu } = await import("./schoolFAQ.js");
      await showSchoolFAQMenu(from, schoolId, biz, saveBiz, { source: "school_group" });
      return true;

    } catch (err) {
      console.error("[SCHOOL GROUP TAP ERROR]", err.message, err.stack);
      try { await sendText(from, "❌ Could not load school profile. Please try again."); } catch (_) {}
      return true;
    }
  }

  return false;
}

// ─── Chatbot: school self-registration from group CTA ─────────────────────────

/**
 * Called when a visitor taps "🏫 Add My School Here".
 * Delegates to startSupplierRegistration() which handles the school path.
 */
export async function handleSchoolGroupRegFlow({ from, slug, biz, saveBiz }) {
  try {
    console.log(`[SCHOOL GROUP REGISTER] from=${from} slug=${slug}`);

    const group = await SchoolGroup.findOne({ slug: String(slug).toLowerCase().trim() }).lean();
    if (group) {
      SchoolGroup.findByIdAndUpdate(group._id, { $inc: { registrationTaps: 1 } }).catch(() => {});
      // Notify admin of registration tap - non-blocking
      _notifyAdminSchoolGroupRegTap({ group, visitorPhone: from }).catch(() => {});
    }

    // Delegate to the same registration flow as "List My Business → I Run a School"
    const { startSupplierRegistration } = await import("./supplierRegistration.js");
    await startSupplierRegistration(from, biz || null);
    return true;

  } catch (err) {
    console.error("[SCHOOL GROUP REGISTER ERROR]", err.message, err.stack);
    try { await sendText(from, "❌ Something went wrong. Please type *menu* to continue."); } catch (_) {}
    return true;
  }
}


// ─── School group admin notification helpers ──────────────────────────────────

/**
 * Notify admin that a school group link was opened.
 * Message includes the group name, slug, view count and visitor phone.
 */
async function _notifyAdminSchoolGroupOpened(group, visitorPhone) {
  try {
    const adminPhone = String(
      process.env.ZQ_ADMIN_PHONE || process.env.ADMIN_WHATSAPP_PHONE || ""
    ).replace(/\D/g, "");
    if (!adminPhone || adminPhone.length < 10) return;

    const timeStr = new Date().toLocaleString("en-GB", {
      day: "numeric", month: "short", hour: "2-digit", minute: "2-digit"
    });
    const displayPhone = _formatPhoneDisplay(visitorPhone);

    await sendText(
      adminPhone,
      `🏫 *School group link opened*\n\n` +
      `Group: *${group.name}* (${group.slug})\n` +
      `Views: ${(group.viewCount || 0) + 1}\n` +
      `Visitor: ${displayPhone}\n` +
      `Time: ${timeStr}`
    );
    console.log(`[SCHOOL GROUP ADMIN] group opened - visitor ${visitorPhone} slug "${group.slug}"`);
  } catch (_) {
    // Non-critical
  }
}

/**
 * Notify admin that a visitor tapped a specific school inside a school group list.
 * Message includes the school name, city and visitor phone.
 */
async function _notifyAdminSchoolTapped(school, visitorPhone) {
  try {
    const adminPhone = String(
      process.env.ZQ_ADMIN_PHONE || process.env.ADMIN_WHATSAPP_PHONE || ""
    ).replace(/\D/g, "");
    if (!adminPhone || adminPhone.length < 10) return;

    const timeStr = new Date().toLocaleString("en-GB", {
      day: "numeric", month: "short", hour: "2-digit", minute: "2-digit"
    });
    const displayPhone = _formatPhoneDisplay(visitorPhone);
    const loc = school.city ? ` · ${school.city}` : "";

    await sendText(
      adminPhone,
      `🏫 *School profile tapped from group link*\n\n` +
      `School: *${school.schoolName}*${loc}\n` +
      `Visitor: ${displayPhone}\n` +
      `Time: ${timeStr}`
    );
    console.log(`[SCHOOL GROUP ADMIN] school tapped: "${school.schoolName}" by ${visitorPhone}`);
  } catch (_) {
    // Non-critical
  }
}

/**
 * Notify admin when someone taps "Add My School" in a school group.
 */
async function _notifyAdminSchoolGroupRegTap({ group, visitorPhone }) {
  try {
    const adminPhone = String(
      process.env.ZQ_ADMIN_PHONE || process.env.ADMIN_WHATSAPP_PHONE || ""
    ).replace(/\D/g, "");
    if (!adminPhone || adminPhone.length < 10) return;

    const timeStr = new Date().toLocaleString("en-GB", {
      day: "numeric", month: "short", hour: "2-digit", minute: "2-digit"
    });
    const displayPhone = _formatPhoneDisplay(visitorPhone);

    await sendText(
      adminPhone,
      `🏫 *New school registration tap!*\n\n` +
      `Group: *${group.name}* (${group.slug})\n` +
      `Phone: ${displayPhone}\n` +
      `Time: ${timeStr}\n\n` +
      `_This visitor tapped "Add My School" and was sent into the school registration flow._`
    );
    console.log(`[SCHOOL GROUP ADMIN] reg tap - visitor ${visitorPhone} on "${group.slug}"`);
  } catch (_) {
    // Non-critical
  }
}