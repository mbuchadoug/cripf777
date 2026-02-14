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
