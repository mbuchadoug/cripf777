import Invoice from "../models/invoice.js";
import Payment from "../models/payment.js";

/**
 * Build a client ledger with running balance
 */
export async function buildClientStatement({
  businessId,
  clientId
}) {
  // 1️⃣ Fetch invoices
  const invoices = await Invoice.find({
    businessId,
    clientId
  })
    .select("number total createdAt")
    .lean();

  // 2️⃣ Fetch payments / receipts
  const payments = await Payment.find({
    businessId,
    clientId
  })
    .select("amount createdAt invoiceId")
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
