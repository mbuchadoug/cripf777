import Business from "../models/business.js";
import UserSession from "../models/userSession.js";
import Invoice from "../models/invoice.js"; // adjust if your model name differs
import { sendList, sendText } from "./metaSender.js";

export async function showUnpaidInvoices(to) {
  const phone = to.replace(/\D+/g, "");
  const session = await UserSession.findOne({ phone });
  const biz = await Business.findById(session?.activeBusinessId);

  if (!biz) {
    return sendText(to, "❌ No active business.");
  }

 const invoices = await Invoice.find({
  businessId: biz._id,
  type: "invoice",        // 🔥 THIS IS THE FIX
  status: { $ne: "paid" }
})
  .sort({ createdAt: -1 })
  .limit(10)
  .lean();


  if (!invoices.length) {
    return sendText(to, "✅ No unpaid invoices found.");
  }

  return sendList(
    to,
    "📄 Select Invoice to Record Payment",
    invoices.map(inv => ({
      id: `payinv_${inv._id}`,
title: `${inv.number} – ${inv.balance} ${inv.currency}`

    }))
  );
}



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

  const Invoice = (await import("../models/invoice.js")).default;
  
  // ✅ BUILD QUERY WITH BRANCH FILTER
  const query = {
    businessId: biz._id,
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
    
    await (await import("./metaSender.js")).sendText(from, msg);
    return (await import("./metaMenus.js")).sendPaymentsMenu(from);
  }

  const header = caller && ["clerk", "manager"].includes(caller.role)
    ? "💰 Unpaid Invoices (Your Branch)"
    : "💰 Select invoice to pay";

  return (await import("./metaSender.js")).sendList(
    from,
    header,
    unpaid.map(inv => ({
      id: `payinv_${inv._id}`,
      title: `${inv.number} - ${inv.balance} ${inv.currency}`
    }))
  );
}