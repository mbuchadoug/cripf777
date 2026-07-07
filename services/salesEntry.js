// services/salesEntry.js
// ─────────────────────────────────────────────────────────────────────────────
//  Shared "record a document / expense / payout" service for the /office portal.
//  Mirrors the WhatsApp bot exactly (numbering, records, notifications, PDF) so
//  anything recorded on the web is identical to a WhatsApp entry. The bot code
//  itself is NOT modified — this is additive.
// ─────────────────────────────────────────────────────────────────────────────

async function liveBusiness(biz) {
  if (biz && typeof biz.save === "function") return biz;
  const Business = (await import("../models/business.js")).default;
  return Business.findById(biz._id || biz);
}
async function branchName(branchId) {
  if (!branchId) return null;
  try { const Branch = (await import("../models/branch.js")).default; const b = await Branch.findById(branchId).lean(); return b?.name || null; }
  catch { return null; }
}

// docType → counter key, business prefix field, default prefix, output folder
const DOC = {
  receipt: { counter: "receipt", prefix: "receiptPrefix", def: "RCPT", folder: "receipts" },
  invoice: { counter: "invoice", prefix: "invoicePrefix", def: "INV",  folder: "invoices" },
  quote:   { counter: "quote",   prefix: "quotePrefix",   def: "QT",   folder: "quotes" },
};
export function docFolder(type) { return (DOC[type] || DOC.receipt).folder; }

// Build the PDF for a document using the SAME generator the bot uses.
async function makePdf({ biz, inv, clientName }) {
  try {
    const { generatePDF } = await import("../routes/twilio_biz.js");
    const applyVat = inv.type !== "receipt" && (inv.vatPercent || 0) > 0;
    const { filename } = await generatePDF({
      type: inv.type, number: inv.number, date: inv.createdAt || new Date(),
      billingTo: clientName || "Walk-in",
      items: (inv.items || []).map(i => ({ item: i.item, qty: i.qty, unit: i.unit })),
      bizMeta: {
        name: biz.name, logoUrl: biz.logoUrl, address: biz.address || "",
        discountPercent: inv.discountPercent || 0, vatPercent: inv.vatPercent || 0, applyVat,
        _id: biz._id.toString(), status: inv.status,
      },
    });
    return filename;
  } catch (e) { console.error("[salesEntry pdf]", e.message); return null; }
}

// Core document creator (receipt = paid; invoice/quote = unpaid, affect balances).
async function _createDoc({
  biz, branchId = null, clerkPhone = null, clientId = null,
  customerName = "Walk-in Customer", customerPhone = null,
  items = [], docType = "receipt", discountPercent = 0, vatPercent = 0,
}) {
  const Invoice = (await import("../models/invoice.js")).default;
  const Client  = (await import("../models/client.js")).default;
  const conf = DOC[docType] || DOC.receipt;

  const bizDoc = await liveBusiness(biz);
  if (!bizDoc) throw new Error("Business not found");

  const cleanItems = (items || [])
    .map(i => ({ item: String(i.item || "").trim(), qty: Number(i.qty) || 0, unit: Number(i.unit) || 0 }))
    .filter(i => i.item && i.qty > 0);
  if (!cleanItems.length) throw new Error("Add at least one item with a quantity");

  // Trial cap (same rule the bot enforces)
  try {
    if (bizDoc.package === "trial") {
      const { PACKAGES } = await import("./packages.js");
      const limit = PACKAGES?.trial?.monthlyDocs;
      if (limit && (bizDoc.documentCountMonth || 0) >= limit) {
        const e = new Error(`Trial limit reached — ${limit} documents this month. Upgrade to record more.`);
        e.code = "TRIAL_LIMIT"; throw e;
      }
    }
  } catch (e) { if (e.code === "TRIAL_LIMIT") throw e; }

  // Resolve / create the client
  let client = null;
  if (clientId) client = await Client.findOne({ _id: clientId, businessId: bizDoc._id });
  if (!client) {
    const phoneVal = customerPhone ? (String(customerPhone).replace(/\D+/g, "") || null) : null;
    const name = String(customerName || "").trim() || "Walk-in Customer";
    client = await Client.findOneAndUpdate(
      { businessId: bizDoc._id, ...(phoneVal ? { phone: phoneVal } : { name, phone: null }) },
      { $set: { name, phone: phoneVal, ...(branchId ? { branchId } : {}) } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
  }

  // Number: prefix + zero-padded counter (same format as the bot)
  const prefix = bizDoc[conf.prefix] || conf.def;
  bizDoc.counters = bizDoc.counters || { invoice: 0, quote: 0, receipt: 0 };
  bizDoc.counters[conf.counter] = (bizDoc.counters[conf.counter] || 0) + 1;
  bizDoc.markModified("counters");
  const number = `${prefix}-${String(bizDoc.counters[conf.counter]).padStart(6, "0")}`;

  const subtotal = cleanItems.reduce((s, i) => s + i.qty * i.unit, 0);
  const dPct = Number(discountPercent) || 0;
  const discountAmount = subtotal * (dPct / 100);
  const isReceipt = docType === "receipt";
  const vPct = isReceipt ? 0 : (Number(vatPercent) || 0);
  const vatAmount = vPct > 0 ? (subtotal - discountAmount) * (vPct / 100) : 0;
  const total = subtotal - discountAmount + vatAmount;

  const inv = await Invoice.create({
    businessId: bizDoc._id, clientId: client._id, type: docType, branchId: branchId || undefined,
    number, currency: bizDoc.currency,
    items: cleanItems.map(i => ({ item: i.item, qty: i.qty, unit: i.unit, total: i.qty * i.unit })),
    subtotal, discountPercent: dPct, discountAmount, vatPercent: vPct, vatAmount, total,
    amountPaid: isReceipt ? total : 0,
    balance: isReceipt ? 0 : total,
    status: isReceipt ? "paid" : "unpaid",
    createdBy: clerkPhone || "web",
  });

  bizDoc.documentCountMonth = (bizDoc.documentCountMonth || 0) + 1;
  await bizDoc.save();

  const pdfFile = await makePdf({ biz: bizDoc, inv, clientName: client.name || client.phone });

  // Notify (invoices/receipts affect balances; quotes are informational)
  try {
    const { notifyDocumentCreated } = await import("./bizNotifications.js");
    await notifyDocumentCreated({
      biz: bizDoc, doc: { number, total, clientName: client.name || client.phone },
      docType, clerkPhone, branchName: await branchName(branchId), branchId: branchId || null,
    });
  } catch (e) { console.error("[salesEntry notify]", e.message); }

  return {
    number, total, docType, invoiceId: inv._id, clientName: client.name,
    pdfFile, folder: conf.folder,
    pdfUrl: pdfFile ? `/docs/generated/${conf.folder}/${pdfFile}` : null,
  };
}

export async function createCashSale(args) { return _createDoc({ ...args, docType: "receipt" }); }
export async function createDocument(args) { return _createDoc(args); }

// Regenerate the PDF for any existing document (preview/download anytime).
export async function documentPdf({ biz, invoiceId }) {
  const Invoice = (await import("../models/invoice.js")).default;
  const Client  = (await import("../models/client.js")).default;
  const bizDoc  = await liveBusiness(biz);
  const inv = await Invoice.findOne({ _id: invoiceId, businessId: bizDoc._id }).lean();
  if (!inv) throw new Error("Document not found");
  const client = inv.clientId ? await Client.findById(inv.clientId).lean() : null;
  const filename = await makePdf({ biz: bizDoc, inv, clientName: client?.name || client?.phone || "Walk-in" });
  if (!filename) throw new Error("PDF generation failed");
  return { filename, folder: docFolder(inv.type), type: inv.type, number: inv.number };
}

// ── EXPENSE ──────────────────────────────────────────────────────────────────
export async function recordExpense({ biz, branchId = null, clerkPhone = null, amount, description = "", category = "", method = "Cash" }) {
  const Expense = (await import("../models/expense.js")).default;
  const bizDoc  = await liveBusiness(biz);
  if (!bizDoc) throw new Error("Business not found");
  const amt = Number(amount);
  if (!(amt > 0)) throw new Error("Enter a valid amount");
  const desc = String(description || "").trim() || String(category || "").trim() || "Expense";
  const cat  = String(category || "").trim() || "Other";
  const exp = await Expense.create({
    businessId: bizDoc._id, branchId: branchId || undefined,
    amount: amt, description: desc, category: cat,
    method: String(method || "Cash"), createdBy: clerkPhone || "web",
  });
  try {
    const { notifyExpensesRecorded } = await import("./bizNotifications.js");
    await notifyExpensesRecorded({ biz: bizDoc, expenses: [{ description: desc, amount: amt, category: cat }], clerkPhone, branchName: await branchName(branchId), branchId: branchId || null });
  } catch (e) { console.error("[salesEntry expense notify]", e.message); }
  return exp;
}

// Soft-reverse an expense (the model has reversal fields; keeps audit history).
export async function reverseExpense({ biz, id, byPhone = null }) {
  const Expense = (await import("../models/expense.js")).default;
  const bizDoc  = await liveBusiness(biz);
  const exp = await Expense.findOne({ _id: id, businessId: bizDoc._id });
  if (!exp) throw new Error("Expense not found");
  if (exp.reversed) throw new Error("Already reversed");
  exp.reversed = true;
  exp.originalAmount = exp.amount;
  exp.amount = 0;                       // stop it counting toward money-out
  exp.reversedAt = new Date();
  exp.reversedBy = byPhone || "web";
  await exp.save();
  return exp;
}

// ── PAYOUT / DRAWING ───────────────────────────────────────────────────────────
export async function recordPayout({ biz, branchId = null, clerkPhone = null, amount, reason = "", recipientName = null, recipientPhone = null }) {
  const CashPayout = (await import("../models/cashPayout.js")).default;
  const bizDoc = await liveBusiness(biz);
  if (!bizDoc) throw new Error("Business not found");
  const amt = Number(amount);
  if (!(amt > 0)) throw new Error("Enter a valid amount");
  const rp = recipientPhone ? (String(recipientPhone).replace(/\D+/g, "") || null) : null;
  const payout = await CashPayout.create({
    businessId: bizDoc._id, branchId: branchId || undefined,
    amount: amt, reason: String(reason || "").trim() || "Payout",
    createdBy: clerkPhone || "web", recordedBy: clerkPhone || "web",
    fromPhone: clerkPhone || null, fromName: null,
    paidToPhone: rp, paidToName: recipientName ? String(recipientName).trim() : null,
    date: new Date(),
  });
  try {
    const { notifyPayoutRecorded } = await import("./bizNotifications.js");
    await notifyPayoutRecorded({ biz: bizDoc, payout, clerkPhone, branchName: await branchName(branchId), branchId: branchId || null });
  } catch (e) { console.error("[salesEntry payout notify]", e.message); }
  return payout;
}