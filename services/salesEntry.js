// services/salesEntry.js
// ─────────────────────────────────────────────────────────────────────────────
//  Shared "record a sale / expense" service used by the /office web portal.
//
//  It reproduces EXACTLY what the WhatsApp bot (twilioStateBridge.js) does when
//  it creates a cash-sale receipt or an expense — same client upsert, same
//  receipt numbering (prefix + 6-digit counter), same Invoice/Expense records,
//  same owner/clerk notification + cash-at-hand line. That way a sale recorded
//  on the web is indistinguishable from one recorded on WhatsApp, and reports,
//  clerk custody and notifications all stay consistent.
//
//  The bot itself is NOT modified — this is a standalone, additive service.
// ─────────────────────────────────────────────────────────────────────────────

async function liveBusiness(biz) {
  if (biz && typeof biz.save === "function") return biz;      // already a doc
  const Business = (await import("../models/business.js")).default;
  return Business.findById(biz._id || biz);
}

async function branchName(branchId) {
  if (!branchId) return null;
  try {
    const Branch = (await import("../models/branch.js")).default;
    const b = await Branch.findById(branchId).lean();
    return b?.name || null;
  } catch { return null; }
}

// ─────────────────────────────────────────────────────────────────────────────
//  Record a CASH SALE (a paid receipt) — mirrors the bot's receipt path.
//  items: [{ item, qty, unit }]
// ─────────────────────────────────────────────────────────────────────────────
export async function createCashSale({
  biz, branchId = null, clerkPhone = null, clientId = null,
  customerName = "Walk-in Customer", customerPhone = null,
  items = [], discountPercent = 0,
}) {
  const Invoice = (await import("../models/invoice.js")).default;
  const Client  = (await import("../models/client.js")).default;

  const bizDoc = await liveBusiness(biz);
  if (!bizDoc) throw new Error("Business not found");

  const cleanItems = (items || [])
    .map(i => ({ item: String(i.item || "").trim(), qty: Number(i.qty) || 0, unit: Number(i.unit) || 0 }))
    .filter(i => i.item && i.qty > 0);
  if (!cleanItems.length) throw new Error("Add at least one item with a quantity");

  // Respect the trial document cap (best-effort; same rule the bot enforces)
  try {
    if (bizDoc.package === "trial") {
      const { PACKAGES } = await import("./packages.js");
      const limit = PACKAGES?.trial?.monthlyDocs;
      if (limit && (bizDoc.documentCountMonth || 0) >= limit) {
        const err = new Error(`Trial limit reached — ${limit} documents this month. Upgrade to record more.`);
        err.code = "TRIAL_LIMIT";
        throw err;
      }
    }
  } catch (e) { if (e.code === "TRIAL_LIMIT") throw e; }

  // Use a chosen existing client if provided; otherwise resolve/create like the bot.
  let client = null;
  if (clientId) {
    client = await Client.findOne({ _id: clientId, businessId: bizDoc._id });
  }
  if (!client) {
    const phoneVal = customerPhone ? (String(customerPhone).replace(/\D+/g, "") || null) : null;
    const name = String(customerName || "").trim() || "Walk-in Customer";
    client = await Client.findOneAndUpdate(
      { businessId: bizDoc._id, ...(phoneVal ? { phone: phoneVal } : { name, phone: null }) },
      { $set: { name, phone: phoneVal, ...(branchId ? { branchId } : {}) } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
  }

  // Receipt number: prefix + zero-padded counter (same format as the bot)
  const prefix = bizDoc.receiptPrefix || "RCPT";
  bizDoc.counters = bizDoc.counters || { invoice: 0, quote: 0, receipt: 0 };
  bizDoc.counters.receipt = (bizDoc.counters.receipt || 0) + 1;
  bizDoc.markModified("counters");
  const number = `${prefix}-${String(bizDoc.counters.receipt).padStart(6, "0")}`;

  const subtotal = cleanItems.reduce((s, i) => s + i.qty * i.unit, 0);
  const dPct = Number(discountPercent) || 0;
  const discountAmount = subtotal * (dPct / 100);
  const total = subtotal - discountAmount;   // receipts carry no VAT (same as bot)

  const invoiceDoc = await Invoice.create({
    businessId: bizDoc._id, clientId: client._id, type: "receipt",
    branchId: branchId || undefined,
    number, currency: bizDoc.currency,
    items: cleanItems.map(i => ({ item: i.item, qty: i.qty, unit: i.unit, total: i.qty * i.unit })),
    subtotal, discountPercent: dPct, discountAmount, vatPercent: 0, vatAmount: 0, total,
    amountPaid: total, balance: 0, status: "paid",
    createdBy: clerkPhone || "web",
  });

  bizDoc.documentCountMonth = (bizDoc.documentCountMonth || 0) + 1;
  await bizDoc.save();

  // Notify owner/managers/clerk (updates the cash-at-hand line too)
  try {
    const { notifyDocumentCreated } = await import("./bizNotifications.js");
    await notifyDocumentCreated({
      biz: bizDoc,
      doc: { number, total, clientName: client.name || client.phone },
      docType: "receipt",
      clerkPhone,
      branchName: await branchName(branchId),
      branchId: branchId || null,
    });
  } catch (e) { console.error("[salesEntry receipt notify]", e.message); }

  return { number, total, invoiceId: invoiceDoc._id, clientName: client.name };
}

// ─────────────────────────────────────────────────────────────────────────────
//  Record an EXPENSE — mirrors the bot's expense path.
// ─────────────────────────────────────────────────────────────────────────────
export async function recordExpense({
  biz, branchId = null, clerkPhone = null,
  amount, description = "", category = "", method = "Cash",
}) {
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
    await notifyExpensesRecorded({
      biz: bizDoc,
      expenses: [{ description: desc, amount: amt, category: cat }],
      clerkPhone,
      branchName: await branchName(branchId),
      branchId: branchId || null,
    });
  } catch (e) { console.error("[salesEntry expense notify]", e.message); }

  return exp;
}