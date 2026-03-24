import Business from "../models/business.js";
import UserSession from "../models/userSession.js";
import Invoice from "../models/invoice.js";
import { sendList, sendText } from "./metaSender.js";

/**
 * Show unpaid invoices filtered by user role and branch
 * @param {string} from - User's phone number
 */
export async function showUnpaidInvoices(from, branchId = null, page = 0, search = null) {
  const biz = await (await import("./bizHelpers.js")).getBizForPhone(from);
  if (!biz) return;

  const phone    = from.replace(/\D+/g, "");
  const UserRole = (await import("../models/userRole.js")).default;
  const caller   = await UserRole.findOne({ businessId: biz._id, phone, pending: false });

  const query = {
    businessId: biz._id,
    type:   "invoice",
    status: { $in: ["unpaid", "partial"] }
  };

  if (branchId) {
    query.branchId = branchId;
  } else if (caller && ["clerk", "manager"].includes(caller.role) && caller.branchId) {
    query.branchId = caller.branchId;
  }

  // Search by invoice number
  if (search) {
    query.number = { $regex: search, $options: "i" };
  }

  const PAGE_SIZE  = 8;
  const total      = await Invoice.countDocuments(query);

  if (!total) {
    const msg = search
      ? `✅ No unpaid invoices matching "*${search}*".`
      : "✅ No unpaid invoices.";
    await sendText(from, msg);
    return (await import("./metaMenus.js")).sendPaymentsMenu(from);
  }

  const totalPages = Math.ceil(total / PAGE_SIZE);
  const safePage   = Math.min(page, totalPages - 1);
  const unpaid     = await Invoice.find(query)
    .sort({ createdAt: -1 })
    .skip(safePage * PAGE_SIZE)
    .limit(PAGE_SIZE)
    .lean();

  const header = search
    ? `💰 Unpaid Invoices 🔍 "${search}"`
    : caller && ["clerk", "manager"].includes(caller.role)
      ? "💰 Unpaid Invoices (Your Branch)"
      : "💰 Unpaid Invoices";

  // Always use numbered text list — avoids sendList row limits
  let msg = `${header}\nPage ${safePage + 1}/${totalPages} · ${total} unpaid\n\n`;
  unpaid.forEach((inv, i) => {
    msg += `${safePage * PAGE_SIZE + i + 1}. *${inv.number}* — $${Number(inv.balance || 0).toFixed(2)} ${inv.currency || ""}\n`;
  });
  msg += `\nType the *number* to select an invoice to pay.`;

  // Store in session for number-to-select
  const Business = (await import("../models/business.js")).default;
  const bizDoc   = await Business.findById(biz._id);
  bizDoc.sessionState = "payment_select_invoice";
  bizDoc.sessionData  = {
    invoiceListIds:    unpaid.map(inv => inv._id.toString()),
    invoiceListOffset: safePage * PAGE_SIZE,
    invoiceListPage:   safePage,
    invoiceListBranch: branchId,
    invoiceListSearch: search
  };
  bizDoc.markModified("sessionData");
  await bizDoc.save();

  await sendText(from, msg);

  // Navigation + search buttons (max 3)
  const branchCode = branchId || "br0";
  const navBtns = [];
  if (safePage > 0)              navBtns.push({ id: `paylist_prev_${branchCode}_${safePage}`, title: "⬅ Prev" });
  if (safePage < totalPages - 1) navBtns.push({ id: `paylist_next_${branchCode}_${safePage}`, title: "➡ Next" });
  navBtns.push({ id: `paylist_search_${branchCode}`, title: "🔍 Search" });

  return sendButtons(from, {
    text: "Navigate or search invoices:",
    buttons: navBtns.slice(0, 3)
  });
}