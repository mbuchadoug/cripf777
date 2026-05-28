// services/groupSmartLink.js
// ─── ZimQuote Group Smart Link Engine ────────────────────────────────────────
//
// Handles grouped seller smart links — one link for a category of sellers.
// e.g. ZQ:GROUP:kariba-tourism  or  ZQ:GROUP:harare-plumbers
//
// Link format:
//   https://wa.me/263771143904?text=ZQ:GROUP:kariba-tourism
//
// When a buyer opens a group link:
//   1. System fetches all active sellers in the group
//   2. Sends a WhatsApp list showing seller names + taglines
//   3. Buyer taps a seller → enters that seller's existing smart link flow
//   4. Admin is notified (group opened)
//   5. Seller is notified when buyer selects them (via existing supplier flow)
//
// Admin commands (WhatsApp bot):
//   admin group create <slug> <name>         — create a new group
//   admin group add <slug> <seller-phone>    — add a seller to a group
//   admin group remove <slug> <seller-phone> — remove a seller from a group
//   admin group list                         — list all groups
//   admin group info <slug>                  — show group details
//   admin group delete <slug>                — delete a group
//   admin group tagline <slug> <tagline>     — set group tagline
//
// Model: SupplierGroup (models/supplierGroup.js — create this)
//   slug:      String (unique, lowercase, hyphens, max 40 chars)
//   name:      String (display name, e.g. "Kariba Tourism")
//   tagline:   String (one-liner shown in group list header)
//   sellers:   [{ supplierId: ObjectId, order: Number }]
//   active:    Boolean (default true)
//   createdAt: Date
//   viewCount: Number (total opens)
//   lastViewAt: Date
//
// ─────────────────────────────────────────────────────────────────────────────

import mongoose        from "mongoose";
import SupplierProfile from "../models/supplierProfile.js";

// Lazy-load model to avoid circular imports
async function _getGroupModel() {
  try {
    return mongoose.model("SupplierGroup");
  } catch (_) {
    // Model not registered yet — define it inline
    const schema = new mongoose.Schema({
      slug:      { type: String, required: true, unique: true, lowercase: true, trim: true },
      name:      { type: String, required: true, trim: true },
      tagline:   { type: String, default: "" },
      sellers:   [{
        supplierId: { type: mongoose.Schema.Types.ObjectId, ref: "SupplierProfile" },
        order:      { type: Number, default: 0 }
      }],
      active:    { type: Boolean, default: true },
      viewCount: { type: Number, default: 0 },
      lastViewAt:{ type: Date },
      createdAt: { type: Date, default: Date.now }
    });
    return mongoose.model("SupplierGroup", schema);
  }
}

const BOT_NUMBER = (process.env.WHATSAPP_BOT_NUMBER || "263771143904").replace(/\D/g, "");
const BOT_WA_URL = `https://wa.me/${BOT_NUMBER}`;

// ─── Link builder ─────────────────────────────────────────────────────────────

export function buildGroupDeepLink(slug) {
  return `${BOT_WA_URL}?text=${encodeURIComponent("ZQ:GROUP:" + slug)}`;
}

export function buildGroupQrImageUrl(slug, sizePx = 400) {
  const link = buildGroupDeepLink(slug);
  return `https://chart.googleapis.com/chart?cht=qr&chs=${sizePx}x${sizePx}&chl=${encodeURIComponent(link)}&choe=UTF-8`;
}

// ─── Slug validation ──────────────────────────────────────────────────────────

export function validateGroupSlug(slug = "") {
  const clean = String(slug).toLowerCase().trim()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
  if (!clean || clean.length < 2) return null;
  return clean;
}

// ─── CRUD ─────────────────────────────────────────────────────────────────────

export async function createGroup({ slug, name, tagline = "" }) {
  const SupplierGroup = await _getGroupModel();
  const cleanSlug = validateGroupSlug(slug);
  if (!cleanSlug) throw new Error("Invalid slug — use lowercase letters, numbers and hyphens only");
  const exists = await SupplierGroup.findOne({ slug: cleanSlug }).lean();
  if (exists) throw new Error(`Slug "${cleanSlug}" is already taken by group: ${exists.name}`);
  const group = await SupplierGroup.create({ slug: cleanSlug, name: name.trim(), tagline });
  return group;
}

export async function getGroupBySlug(slug) {
  const SupplierGroup = await _getGroupModel();
  return SupplierGroup.findOne({ slug: String(slug).toLowerCase().trim() }).lean();
}

export async function getAllGroups() {
  const SupplierGroup = await _getGroupModel();
  return SupplierGroup.find({}).sort({ name: 1 }).lean();
}

export async function addSellerToGroup(slug, sellerPhone) {
  const SupplierGroup = await _getGroupModel();
  const group = await SupplierGroup.findOne({ slug: String(slug).toLowerCase().trim() });
  if (!group) throw new Error(`Group "${slug}" not found`);

  const phone = String(sellerPhone).replace(/\D/g, "");
  const seller = await SupplierProfile.findOne({ phone }).lean();
  if (!seller) throw new Error(`No seller found with phone ${phone}`);

  const alreadyIn = group.sellers.some(s => String(s.supplierId) === String(seller._id));
  if (alreadyIn) throw new Error(`${seller.businessName} is already in this group`);

  group.sellers.push({ supplierId: seller._id, order: group.sellers.length });
  await group.save();
  return { group, seller };
}

export async function removeSellerFromGroup(slug, sellerPhone) {
  const SupplierGroup = await _getGroupModel();
  const group = await SupplierGroup.findOne({ slug: String(slug).toLowerCase().trim() });
  if (!group) throw new Error(`Group "${slug}" not found`);

  const phone = String(sellerPhone).replace(/\D/g, "");
  const seller = await SupplierProfile.findOne({ phone }).lean();
  if (!seller) throw new Error(`No seller found with phone ${phone}`);

  const before = group.sellers.length;
  group.sellers = group.sellers.filter(s => String(s.supplierId) !== String(seller._id));
  if (group.sellers.length === before) throw new Error(`${seller.businessName} is not in this group`);

  await group.save();
  return { group, seller };
}

export async function deleteGroup(slug) {
  const SupplierGroup = await _getGroupModel();
  const group = await SupplierGroup.findOneAndDelete({ slug: String(slug).toLowerCase().trim() });
  if (!group) throw new Error(`Group "${slug}" not found`);
  return group;
}

export async function setGroupTagline(slug, tagline) {
  const SupplierGroup = await _getGroupModel();
  const group = await SupplierGroup.findOneAndUpdate(
    { slug: String(slug).toLowerCase().trim() },
    { $set: { tagline: String(tagline).trim() } },
    { new: true }
  );
  if (!group) throw new Error(`Group "${slug}" not found`);
  return group;
}

// ─── Main handler — called from chatbotEngine / handleZqDeepLink ──────────────

/**
 * Handle an incoming ZQ:GROUP:<slug> message.
 * Shows a WhatsApp list of all sellers in the group.
 * Notifies admin of the group open.
 * Returns true if handled, false if group not found.
 */
export async function handleGroupSmartLink({ from, slug, biz, saveBiz }) {
  const SupplierGroup = await _getGroupModel();

  const group = await SupplierGroup.findOne({
    slug:   String(slug).toLowerCase().trim(),
    active: true
  }).lean();

  if (!group) return false;

  // Fire-and-forget: increment view counter + timestamp
  SupplierGroup.findByIdAndUpdate(group._id, {
    $inc: { viewCount: 1 },
    $set: { lastViewAt: new Date() }
  }).catch(() => {});

  // Notify admin (non-blocking)
  _notifyAdminGroupOpened({ group, visitorPhone: from }).catch(() => {});

  // Fetch active sellers in order
  const sellerIds = group.sellers
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    .map(s => s.supplierId);

  if (!sellerIds.length) {
    const { sendText } = await import("../services/metaSender.js");
    await sendText(from,
      `🔍 *${group.name}*\n\n` +
      (group.tagline ? `_${group.tagline}_\n\n` : "") +
      `No businesses are listed in this group yet. Check back soon.`
    );
    return true;
  }

  const sellers = await SupplierProfile.find({
    _id: { $in: sellerIds }
  }).lean();

  // Keep admin-defined order
  const orderedSellers = sellerIds
    .map(id => sellers.find(s => String(s._id) === String(id)))
    .filter(Boolean);

  // WhatsApp list: max 10 rows per section
  const rows = orderedSellers.slice(0, 10).map(s => {
    const area = s.location?.area || "";
    const city = s.location?.city || "";
    const loc  = [area, city].filter(Boolean).join(", ");
    const desc = loc || (s.profileType === "hospitality" ? "Hospitality" : (s.profileType === "service" ? "Services" : "Products"));
    return {
      id:          `zqg_sel_${String(s._id)}`,
      title:       (s.businessName || "Business").slice(0, 24),
      description: desc.slice(0, 72)
    };
  });

  const overflow = orderedSellers.length > 10
    ? `\n_...and ${orderedSellers.length - 10} more. Type the name to search._`
    : "";

  const { sendList } = await import("../services/metaSender.js");
  await sendList(from,
    `🏪 *${group.name}*\n` +
    (group.tagline ? `_${group.tagline}_\n` : "") +
    `\nTap a business to view their services, catalogue and request a quote.${overflow}`,
    rows
  );

  return true;
}

// ─── Handle buyer tapping a seller from the group list ────────────────────────
// Action format: zqg_sel_<supplierId>
// Wire into chatbotEngine sc_ / action handler block

export async function handleGroupSellerTap({ from, action, biz, saveBiz }) {
  if (!action.startsWith("zqg_sel_")) return false;
  const supplierId = action.replace("zqg_sel_", "").trim();
  if (!mongoose.Types.ObjectId.isValid(supplierId)) return false;

  try {
    const { showSellerMenu } = await import("./sellerChat.js");
    await showSellerMenu(from, supplierId, biz, saveBiz, { source: "group_link" });
  } catch (_) {
    const { sendText } = await import("../services/metaSender.js");
    await sendText(from, "Sorry, couldn't load that business. Please try again.");
  }
  return true;
}

// ─── Admin notification ───────────────────────────────────────────────────────

async function _notifyAdminGroupOpened({ group, visitorPhone }) {
  try {
    const { notifyAdminGroupLinkOpened } = await import("./buyerRequestNotifications.js");
    await notifyAdminGroupLinkOpened({
      groupName:   group.name,
      slug:        group.slug,
      viewCount:   (group.viewCount || 0) + 1,
      visitorPhone
    });
  } catch (_) {}
}

// ─── Admin WhatsApp bot command handler ───────────────────────────────────────
// Called from chatbotEngine admin command section.
// Usage: handleGroupAdminCommand({ from, text })
// Returns true if handled.

export async function handleGroupAdminCommand({ from, text }) {
  const raw   = String(text || "").trim();
  const lower = raw.toLowerCase();

  if (!lower.startsWith("admin group")) return false;

  const { sendText } = await import("../services/metaSender.js");

  // "admin group list"
  if (lower === "admin group list") {
    const groups = await getAllGroups();
    if (!groups.length) {
      await sendText(from, "No groups created yet. Use:\n*admin group create <slug> <name>*");
      return true;
    }
    const lines = groups.map(g => {
      const sellerCount = g.sellers?.length || 0;
      const status = g.active ? "✅" : "⏸";
      return `${status} *${g.name}* (${g.slug})\n   ${sellerCount} seller${sellerCount === 1 ? "" : "s"} · ${g.viewCount || 0} views`;
    });
    await sendText(from, `📋 *Group Smart Links (${groups.length})*\n\n` + lines.join("\n\n"));
    return true;
  }

  // "admin group info <slug>"
  const infoMatch = lower.match(/^admin group info (.+)$/);
  if (infoMatch) {
    const slug = infoMatch[1].trim();
    const group = await getGroupBySlug(slug);
    if (!group) {
      await sendText(from, `❌ Group "${slug}" not found.`);
      return true;
    }
    const sellerIds = (group.sellers || []).sort((a, b) => (a.order ?? 0) - (b.order ?? 0)).map(s => s.supplierId);
    const sellers   = await SupplierProfile.find({ _id: { $in: sellerIds } }).lean();
    const ordered   = sellerIds.map(id => sellers.find(s => String(s._id) === String(id))).filter(Boolean);
    const sellerList = ordered.map((s, i) => `${i + 1}. ${s.businessName} (${s.phone})`).join("\n");
    const link = buildGroupDeepLink(group.slug);
    await sendText(from,
      `📋 *${group.name}*\n` +
      `Slug: ${group.slug}\n` +
      `Tagline: ${group.tagline || "(none)"}\n` +
      `Status: ${group.active ? "✅ Active" : "⏸ Inactive"}\n` +
      `Views: ${group.viewCount || 0}\n\n` +
      `*Sellers (${ordered.length}):*\n${sellerList || "(none)"}\n\n` +
      `*Link:*\n${link}`
    );
    return true;
  }

  // "admin group create <slug> <name>"
  const createMatch = raw.match(/^admin group create (\S+)\s+(.+)$/i);
  if (createMatch) {
    const slug = createMatch[1].trim();
    const name = createMatch[2].trim();
    try {
      const group = await createGroup({ slug, name });
      const link  = buildGroupDeepLink(group.slug);
      await sendText(from,
        `✅ *Group created!*\n\n` +
        `Name: ${group.name}\n` +
        `Slug: ${group.slug}\n\n` +
        `*Link:*\n${link}\n\n` +
        `Now add sellers:\n*admin group add ${group.slug} <phone>*`
      );
    } catch (err) {
      await sendText(from, `❌ ${err.message}`);
    }
    return true;
  }

  // "admin group add <slug> <phone>"
  const addMatch = raw.match(/^admin group add (\S+)\s+(\S+)$/i);
  if (addMatch) {
    const slug  = addMatch[1].trim();
    const phone = addMatch[2].trim();
    try {
      const { seller } = await addSellerToGroup(slug, phone);
      await sendText(from, `✅ *${seller.businessName}* added to group *${slug}*`);
    } catch (err) {
      await sendText(from, `❌ ${err.message}`);
    }
    return true;
  }

  // "admin group remove <slug> <phone>"
  const removeMatch = raw.match(/^admin group remove (\S+)\s+(\S+)$/i);
  if (removeMatch) {
    const slug  = removeMatch[1].trim();
    const phone = removeMatch[2].trim();
    try {
      const { seller } = await removeSellerFromGroup(slug, phone);
      await sendText(from, `✅ *${seller.businessName}* removed from group *${slug}*`);
    } catch (err) {
      await sendText(from, `❌ ${err.message}`);
    }
    return true;
  }

  // "admin group tagline <slug> <tagline text>"
  const taglineMatch = raw.match(/^admin group tagline (\S+)\s+(.+)$/i);
  if (taglineMatch) {
    const slug    = taglineMatch[1].trim();
    const tagline = taglineMatch[2].trim();
    try {
      await setGroupTagline(slug, tagline);
      await sendText(from, `✅ Tagline updated for *${slug}*:\n_${tagline}_`);
    } catch (err) {
      await sendText(from, `❌ ${err.message}`);
    }
    return true;
  }

  // "admin group delete <slug>"
  const deleteMatch = raw.match(/^admin group delete (\S+)$/i);
  if (deleteMatch) {
    const slug = deleteMatch[1].trim();
    try {
      const group = await deleteGroup(slug);
      await sendText(from, `✅ Group *${group.name}* (${slug}) deleted.`);
    } catch (err) {
      await sendText(from, `❌ ${err.message}`);
    }
    return true;
  }

  // Unknown group command — show help
  await sendText(from,
    `📋 *Group Smart Link commands:*\n\n` +
    `*admin group list*\n   List all groups\n\n` +
    `*admin group create <slug> <name>*\n   e.g. admin group create kariba-tourism Kariba Tourism\n\n` +
    `*admin group add <slug> <phone>*\n   e.g. admin group add kariba-tourism 263771446827\n\n` +
    `*admin group remove <slug> <phone>*\n   Remove a seller\n\n` +
    `*admin group tagline <slug> <text>*\n   Set a one-line description\n\n` +
    `*admin group info <slug>*\n   View group details and link\n\n` +
    `*admin group delete <slug>*\n   Delete a group`
  );
  return true;
}

// ─── Re-engagement campaign admin commands ────────────────────────────────────
// "admin reactivate dormant <days>"
// "admin reactivate seller <slug>"
//
// These are handled in chatbotEngine's admin command section.
// Export the handlers here so they can be imported cleanly.

export async function sendWeeklySellerReports() {
  // Called by a cron job (e.g. every Monday 8am).
  // Sends each active seller their weekly activity summary.
  const sellers = await SupplierProfile.find({ active: true }).lean();
  let sent = 0;

  for (const seller of sellers) {
    if (!seller.phone) continue;
    try {
      await _sendWeeklyReportToSeller(seller);
      sent++;
      // Throttle: 1 per second to avoid Meta rate limits
      await new Promise(r => setTimeout(r, 1000));
    } catch (_) {}
  }
  console.log(`[WEEKLY REPORT] Sent ${sent} seller reports`);
  return sent;
}

async function _sendWeeklyReportToSeller(seller) {
  const phone   = String(seller.phone).replace(/\D/g, "");
  const views   = seller.zqLinkViews   || 0;
  const convs   = seller.zqLinkConversions || 0;
  const slug    = seller.zqSlug;
  const botNum  = (process.env.WHATSAPP_BOT_NUMBER || "263771143904").replace(/\D/g, "");
  const link    = slug
    ? `https://wa.me/${botNum}?text=${encodeURIComponent("ZQ:S:" + slug)}`
    : `https://wa.me/${botNum}?text=${encodeURIComponent("ZQ:SUPPLIER:" + seller._id)}`;

  // Try Meta template first
  try {
    const { _sendTemplate } = await import("./buyerRequestNotifications.js");
    await _sendTemplate(phone, "zq_seller_weekly_report", [
      seller.businessName || "Your Business",
      String(views),
      String(convs),
      link
    ]);
    console.log(`[WEEKLY REPORT] zq_seller_weekly_report → ${phone}`);
    return;
  } catch (_) {}

  // Fallback: sendText
  const { sendText } = await import("../services/metaSender.js");
  await sendText(phone,
    `📊 *Your ZimQuote activity this week — ${seller.businessName}*\n\n` +
    `👁 Profile views: ${views}\n` +
    `✅ Enquiries / quotes: ${convs}\n\n` +
    `Share your link to get more enquiries:\n${link}\n\n` +
    `_Reply MENU to open your dashboard._`
  );
}