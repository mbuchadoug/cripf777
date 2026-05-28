// services/groupSmartLink.js
// ─── ZimQuote Group Smart Link Engine ────────────────────────────────────────
//
// A "group" bundles multiple sellers under one shareable WhatsApp link.
// e.g.  ZQ:GROUP:plumber-zim  →  list of all plumbers → buyer taps one → showSellerMenu
//
// Deep link format:
//   https://wa.me/<BOT>?text=ZQ:GROUP:<slug>
//
// Chatbot flow:
//   1. Buyer sends "ZQ:GROUP:plumber-zim"  (text message or QR scan)
//   2. handleGroupSmartLink() looks up the group, sends a WhatsApp list of sellers
//      with action IDs  zqg_sel_<supplierId>
//   3. Buyer taps a seller from the list
//   4. handleGroupSellerTap() extracts supplierId → calls showSellerMenu()
//
// Admin CRUD (called from supplierAdmin.js):
//   createGroup / getAllGroups / getGroupBySlug / addSellerToGroup /
//   removeSellerFromGroup / deleteGroup / setGroupTagline / validateGroupSlug
//
// Link builders (called from supplierAdmin.js page rendering):
//   buildGroupDeepLink / buildGroupQrImageUrl
//
// ─────────────────────────────────────────────────────────────────────────────

import mongoose from "mongoose";
import { sendList, sendText } from "./metaSender.js";
import { showSellerMenu }    from "./sellerChat.js";

// ─── Config ───────────────────────────────────────────────────────────────────
const BOT_NUMBER = (process.env.WHATSAPP_BOT_NUMBER || "263771143904").replace(/\D/g, "");
const BOT_WA_URL = `https://wa.me/${BOT_NUMBER}`;

// ─── Mongoose model (defined inline - no separate model file needed) ──────────

const supplierGroupSchema = new mongoose.Schema(
  {
    slug:      { type: String, required: true, unique: true, lowercase: true, trim: true },
    name:      { type: String, required: true, trim: true },
    tagline:   { type: String, default: "" },
    active:    { type: Boolean, default: true },
    viewCount: { type: Number, default: 0 },

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

// Use existing model if already compiled (hot-reload safe)
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

  // Prevent duplicates
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
 * Called when a buyer sends "ZQ:GROUP:<slug>" (text or button tap).
 * Sends a WhatsApp list of sellers in the group.
 * Returns true if handled, false if not (group not found / empty).
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

    if (!sellerIds.length) {
      await sendText(from, `❌ *${group.name}* has no sellers yet. Check back soon!`);
      return true;
    }

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
      await sendText(from, `😕 No active sellers in *${group.name}* right now. Try again later.`);
      return true;
    }

    // WhatsApp list rows: max 10 per section
    const rows = orderedSellers.slice(0, 9).map(s => {
      const loc = [s.location?.area, s.location?.city].filter(Boolean).join(", ");
      return {
        id:          `zqg_sel_${s._id}`,
        title:       s.businessName || "Seller",
        description: loc || undefined
      };
    });

    const tagline  = group.tagline || "Tap a business to view their services, catalogue and request a quote.";
    const header   = `🏪 *${group.name}*\n\n${tagline}`;

    await sendList(from, header, rows);
    return true;

  } catch (err) {
    console.error("[GROUP SMART LINK ERROR]", err.message);
    return false;
  }
}

// ─── Chatbot: handle zqg_sel_<supplierId> ────────────────────────────────────

/**
 * Called when a buyer taps a seller from the group list reply.
 * Action format: "zqg_sel_<supplierId>"
 * Calls showSellerMenu() to display the seller's profile card + action buttons.
 * Returns true if handled, false if not.
 */
export async function handleGroupSellerTap({ from, action, biz, saveBiz }) {
  try {
    const supplierId = String(action || "").replace(/^zqg_sel_/i, "").trim();
    if (!supplierId || supplierId.length !== 24) {
      console.warn(`[GROUP SELLER TAP] Invalid supplierId from action="${action}"`);
      return false;
    }

    console.log(`[GROUP SELLER TAP] from=${from} supplierId=${supplierId}`);

    await showSellerMenu(from, supplierId, biz, saveBiz, { source: "group" });
    return true;

  } catch (err) {
    console.error("[GROUP SELLER TAP ERROR]", err.message, err.stack);
    try {
      await sendText(from, "❌ Could not load seller profile. Please try again.");
    } catch (_) {}
    return true; // return true so chatbotEngine doesn't fall through
  }
}

// ─── Admin group command handler ──────────────────────────────────────────────

/**
 * Handles "admin group <command>" typed by admin phone.
 * Currently a no-op stub — extend as needed.
 * Returns true if handled.
 */
export async function handleGroupAdminCommand({ from, text }) {
  const parts = String(text || "").trim().toLowerCase().split(/\s+/);
  // parts[0] = "admin", parts[1] = "group", parts[2] = subcommand
  const subCmd = parts[2] || "";
  console.log(`[GROUP ADMIN CMD] from=${from} subCmd=${subCmd}`);
  // Stub: just acknowledge
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