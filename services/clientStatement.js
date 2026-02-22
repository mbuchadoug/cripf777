import Invoice from "../models/invoice.js";
import InvoicePayment from "../models/invoicePayment.js";

/**
 * Build a client ledger with running balance
 */
export async function buildClientStatement({ businessId, clientId, branchId = null }) {
  const Invoice = (await import("../models/invoice.js")).default;
  const InvoicePayment = (await import("../models/invoicePayment.js")).default;

  // ✅ BUILD QUERY WITH OPTIONAL BRANCH FILTER
  const query = { businessId, clientId };
  
  if (branchId) {
    query.branchId = branchId;
  }

  const invoices = await Invoice.find(query)
    .sort({ createdAt: 1 })
    .lean();

  const payments = await InvoicePayment.find(query)
    .sort({ createdAt: 1 })
    .lean();

 

  // 3️⃣ Normalize into ledger rows
  const ledger = [];

  for (const inv of invoices) {
    ledger.push({
      date: inv.createdAt,
      ref: inv.number,
      debit: inv.total,
      credit: 0
    });
  }

  for (const pay of payments) {
    ledger.push({
      date: pay.createdAt,
      ref: "RCPT",
      debit: 0,
      credit: pay.amount
    });
  }

  // 4️⃣ Sort by date ASC
  ledger.sort((a, b) => new Date(a.date) - new Date(b.date));

  // 5️⃣ Running balance
  let balance = 0;
  const rows = ledger.map(row => {
    balance += row.debit;
    balance -= row.credit;

    return {
      ...row,
      balance
    };
  });

  return rows;
}
