import Business from "../models/business.js";
import UserSession from "../models/userSession.js";
import Invoice from "../models/invoice.js";
import { sendList, sendText } from "./metaSender.js";

/**
 * Show unpaid invoices filtered by user role and branch
 * @param {string} from - User's phone number
 */
export async function showUnpaidInvoices(from) {
  const biz = await (await import("./bizHelpers.js")).getBizForPhone(from);
  if (!biz) return;

  // ✅ GET USER ROLE & BRANCH
  const phone = from.replace(/\D+/g, "");
  const UserRole = (await import("../models/userRole.js")).default;
  
  const caller = await UserRole.findOne({
    businessId: biz._id,
    phone,
    pending: false
  });

  // ✅ BUILD QUERY WITH BRANCH FILTER
  const query = {
    businessId: biz._id,
    type: "invoice",  // ✅ ONLY INVOICES (not quotes/receipts)
    status: { $in: ["unpaid", "partial"] }
  };

  // ✅ CLERKS & MANAGERS: only see their branch invoices
  if (caller && ["clerk", "manager"].includes(caller.role) && caller.branchId) {
    query.branchId = caller.branchId;
  }

  const unpaid = await Invoice.find(query)
    .sort({ createdAt: -1 })
    .limit(10)
    .lean();

  if (!unpaid.length) {
    const msg = caller && ["clerk", "manager"].includes(caller.role)
      ? "✅ No unpaid invoices in your branch."
      : "✅ No unpaid invoices.";
    
    await sendText(from, msg);
    return (await import("./metaMenus.js")).sendPaymentsMenu(from);
  }

  const header = caller && ["clerk", "manager"].includes(caller.role)
    ? "💰 Unpaid Invoices (Your Branch)"
    : "💰 Select invoice to pay";

  return sendList(
    from,
    header,
    unpaid.map(inv => ({
      id: `payinv_${inv._id}`,
      title: `${inv.number} - ${inv.balance} ${inv.currency}`
    }))
  );
}