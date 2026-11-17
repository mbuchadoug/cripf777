// services/zqBooks.js
// ═════════════════════════════════════════════════════════════════════════════
// Books helpers shared by the Quote Desk and normal business tools
// ─────────────────────────────────────────────────────────────────────────────
// GENERIC (any business on ZimQuote):
//   convertQuoteToInvoice({ quoteId, biz, by })  → INV from a QT, linked both ways,
//                                                 never twice, trial limit respected
//   recordInvoicePayment({ invoiceId, amount, method, by }) → atomic balance update,
//                                                 InvoicePayment + RCPT-000123 receipt PDF
//   recordCostOfSale({ bizId, amount, note, by }) → Expense "Cost of sales"
//
// HOUSE BOOKS (ZimQuote's own business account, for the Quote Desk):
//   getHouseBiz()  → ZQ_HOUSE_BIZ_ID, else the business OWNED by the admin phone
//   bookQuote(...) → saves a ZimQuote quotation as a real QT-… quote in those books
//
// Every function returns plain data and throws Error(message) on a user-facing
// problem, so WhatsApp and the web admin can show the message as-is.
// ═════════════════════════════════════════════════════════════════════════════
import mongoose from "mongoose";
import Business from "../models/business.js";
import Client from "../models/client.js";
import Invoice from "../models/invoice.js";
import InvoicePayment from "../models/invoicePayment.js";
import Expense from "../models/expense.js";
import { nextDocNumber } from "./docNumbers.js";

const SITE = () => String(process.env.SITE_URL || "").replace(/\/$/, "");
const r2 = n => Math.round((Number(n) || 0) * 100) / 100;
const METHODS = { cash: "Cash", bank: "Bank", ecocash: "EcoCash", eco: "EcoCash", other: "Other", swipe: "Bank", transfer: "Bank", card: "Bank", innbucks: "Other", onemoney: "Other", zipit: "Bank" };

export function normMethod(raw = "") {
  const k = String(raw || "").toLowerCase().replace(/[^a-z]/g, "");
  if (!k) return "";
  if (METHODS[k]) return METHODS[k];
  if (k.startsWith("eco")) return "EcoCash";
  if (k.startsWith("cash")) return "Cash";
  if (k.startsWith("bank") || k.startsWith("rtgs")) return "Bank";
  return "";
}

export function docUrl(type, filename) {
  const folder = type === "invoice" ? "invoices" : type === "quote" ? "quotes" : "receipts";
  return `${SITE()}/docs/generated/${folder}/${filename}`;
}

async function pdf(args) {
  const { generatePDF } = await import("../routes/twilio_biz.js");
  return generatePDF(args);
}

function bizMeta(biz, doc, extra = {}) {
  return {
    name: biz.name, logoUrl: biz.logoUrl, address: biz.address || "",
    discountPercent: doc.discountPercent || 0, vatPercent: doc.vatPercent || 0,
    applyVat: Number(doc.vatAmount || 0) > 0,
    _id: String(biz._id), status: doc.status, ...extra
  };
}

// ── Trial limit (same rule as the normal "create invoice" flow) ──────────────
export async function assertCanCreateDoc(biz) {
  if (biz?.package !== "trial") return;
  let limit = Infinity;
  try { const { PACKAGES } = await import("./packages.js"); limit = PACKAGES?.trial?.monthlyDocs ?? Infinity; } catch (_) {}
  if ((biz.documentCountMonth || 0) >= limit) {
    const e = new Error(`Trial limit reached - you can only create ${limit} documents on the Trial package. Upgrade to continue.`);
    e.code = "TRIAL_LIMIT";
    throw e;
  }
}

// ── Clients ──────────────────────────────────────────────────────────────────
export async function upsertClient(businessId, { name = "", phone = "" } = {}) {
  const ph = String(phone || "").replace(/\D+/g, "");
  if (!ph) return Client.create({ businessId, name: name || "Walk-in" });
  const update = name ? { $set: { phone: ph, name } } : { $set: { phone: ph }, $setOnInsert: { name: ph } };
  return Client.findOneAndUpdate({ businessId, phone: ph }, update, { upsert: true, new: true });
}

// ═════════════════════════════════════════════════════════════════════════════
// QUOTE → INVOICE (generic)
// ═════════════════════════════════════════════════════════════════════════════
/**
 * @returns {{ invoice, quote, url, filename, already:boolean }}
 *  already=true when the quote had been converted before (the existing invoice
 *  is returned and its PDF regenerated) - so a double tap never makes two.
 */
export async function convertQuoteToInvoice({ quoteId, biz = null, by = "", enforceTrial = true, notify = true, branchName = null }) {
  const quote = await Invoice.findById(quoteId).lean();
  if (!quote) throw new Error("Quotation not found.");
  if (quote.type !== "quote") throw new Error("Only quotations can be converted to an invoice.");
  if (quote.reversed) throw new Error("This quotation was reversed.");
  if (!biz || String(biz._id) !== String(quote.businessId)) biz = await Business.findById(quote.businessId);
  if (!biz) throw new Error("Business not found.");

  // Already converted → hand back the same invoice.
  if (quote.convertedToInvoiceId) {
    const existing = await Invoice.findById(quote.convertedToInvoiceId).lean();
    if (existing) return { ...(await invoicePdf(biz, existing)), invoice: existing, quote, already: true };
  }

  if (enforceTrial) await assertCanCreateDoc(biz);

  // Claim the quote atomically (two taps at once → only one wins).
  const newId = String(new mongoose.Types.ObjectId());   // hex string - casts to ObjectId
  const claimed = await Invoice.findOneAndUpdate(
    { _id: quote._id, type: "quote", convertedToInvoiceId: null },
    { $set: { convertedToInvoiceId: newId } },
    { new: true }
  ).lean();
  if (!claimed) {
    // Lost the race - return whatever the winner created.
    const q2 = await Invoice.findById(quote._id).lean();
    const inv = q2?.convertedToInvoiceId ? await Invoice.findById(q2.convertedToInvoiceId).lean() : null;
    if (inv) return { ...(await invoicePdf(biz, inv)), invoice: inv, quote: q2, already: true };
    throw new Error("This quotation is being converted - try again in a moment.");
  }

  let invoice;
  try {
    const number = await nextDocNumber(biz._id, "invoice");
    const total = r2(quote.total);
    const doc = new Invoice({
      _id: newId,
      businessId: biz._id, branchId: quote.branchId || undefined, clientId: quote.clientId,
      type: "invoice", number, currency: quote.currency || biz.currency || "USD",
      items: (quote.items || []).map(i => ({ item: i.item, qty: i.qty, unit: i.unit, total: i.total })),
      subtotal: quote.subtotal, discountPercent: quote.discountPercent || 0, discountAmount: quote.discountAmount || 0,
      vatPercent: quote.vatPercent || 0, vatAmount: quote.vatAmount || 0, total,
      amountPaid: 0, balance: total, status: "unpaid",
      note: quote.note ? `From ${quote.number} · ${quote.note}`.slice(0, 500) : `From ${quote.number}`,
      sourceQuoteId: quote._id, externalRef: quote.externalRef || "",
      createdBy: by || quote.createdBy || "", enteredAt: new Date()
    });
    await doc.save();
    invoice = doc.toObject ? doc.toObject() : { ...doc };
  } catch (err) {
    await Invoice.updateOne({ _id: quote._id, convertedToInvoiceId: newId }, { $set: { convertedToInvoiceId: null } }).catch(() => {});
    throw err;
  }
  // Counts as one document this month (atomic; in-memory biz is never re-saved over it).
  await Business.updateOne({ _id: biz._id }, { $inc: { documentCountMonth: 1 } }).catch(() => {});

  const out = await invoicePdf(biz, invoice);
  if (notify) {
    try {
      const { notifyDocumentCreated } = await import("./bizNotifications.js");
      const client = await Client.findById(invoice.clientId).lean().catch(() => null);
      await notifyDocumentCreated({
        biz, doc: { number: invoice.number, total: invoice.total, clientName: client?.name || client?.phone || "-" },
        docType: "invoice", clerkPhone: by || null, branchName, branchId: invoice.branchId || null
      });
    } catch (e) { console.error("[BOOKS] notify invoice:", e.message); }
  }
  return { ...out, invoice, quote: { ...quote, convertedToInvoiceId: newId }, already: false };
}

async function invoicePdf(biz, inv, extraMeta = {}) {
  try {
    const client = await Client.findById(inv.clientId).lean().catch(() => null);
    const { filename } = await pdf({
      type: "invoice", number: inv.number, date: inv.createdAt || new Date(),
      billingTo: client?.name || client?.phone || "Customer", items: inv.items || [],
      bizMeta: bizMeta(biz, inv, extraMeta)
    });
    return { filename, url: docUrl("invoice", filename) };
  } catch (e) {
    console.error("[BOOKS] invoice PDF:", e.message);
    return { filename: "", url: "" };
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// PAYMENT → RECEIPT (generic)
// ═════════════════════════════════════════════════════════════════════════════
/**
 * Records money received against an invoice. Never takes more than the balance.
 * @returns {{ invoice, payment, receiptNumber, url, filename, applied }}
 */
export async function recordInvoicePayment({ invoiceId, amount, method = "Cash", by = "", biz = null, notify = true, branchName = null }) {
  const amt = r2(amount);
  if (!(amt > 0)) throw new Error("Enter an amount above 0.");
  const m = normMethod(method) || "Cash";

  let inv = null, applied = 0;
  for (let attempt = 0; attempt < 3 && !inv; attempt++) {
    const cur = await Invoice.findById(invoiceId).lean();
    if (!cur) throw new Error("Invoice not found.");
    if (cur.type !== "invoice") throw new Error("Payments can only be recorded on invoices.");
    if (cur.reversed) throw new Error("This invoice was reversed.");
    const bal = r2(cur.balance);
    if (!(bal > 0)) throw new Error(`${cur.number} is already fully paid.`);
    applied = Math.min(amt, bal);
    const newBal = r2(bal - applied);
    // Optimistic: only applies if nobody changed the balance in between.
    inv = await Invoice.findOneAndUpdate(
      { _id: cur._id, balance: cur.balance },
      { $set: { amountPaid: r2((cur.amountPaid || 0) + applied), balance: newBal, status: newBal <= 0 ? "paid" : "partial" } },
      { new: true }
    ).lean();
  }
  if (!inv) throw new Error("The invoice is being updated by someone else - try again.");

  if (!biz || String(biz._id) !== String(inv.businessId)) biz = await Business.findById(inv.businessId);
  let receiptNumber;
  try { receiptNumber = await nextDocNumber(inv.businessId, "receipt"); }
  catch (_) { receiptNumber = `RCPT-${Date.now()}`; }

  const payment = await InvoicePayment.create({
    businessId: inv.businessId, clientId: inv.clientId, branchId: inv.branchId || null,
    invoiceId: inv._id, amount: applied, method: m, receiptNumber, createdBy: by || null
  });

  let filename = "", url = "";
  try {
    const out = await pdf({
      type: "receipt", number: receiptNumber, date: new Date(), billingTo: inv.number,
      items: [{ item: `Payment received (${m}) - ${inv.number}`, qty: 1, unit: applied, total: applied }],
      bizMeta: { name: biz?.name, logoUrl: biz?.logoUrl, address: biz?.address || "", _id: String(inv.businessId), status: inv.status }
    });
    filename = out.filename; url = docUrl("receipt", filename);
  } catch (e) { console.error("[BOOKS] receipt PDF:", e.message); }

  if (notify && biz) {
    try {
      const { notifyPaymentRecorded } = await import("./bizNotifications.js");
      const client = await Client.findById(inv.clientId).lean().catch(() => null);
      await notifyPaymentRecorded({
        biz, payment: { amount: applied, method: m }, invoiceNumber: inv.number,
        clientName: client?.name || client?.phone || "-", clerkPhone: by || null, branchName, branchId: inv.branchId || null
      });
    } catch (e) { console.error("[BOOKS] notify payment:", e.message); }
  }
  return { invoice: inv, payment: payment.toObject ? payment.toObject() : payment, receiptNumber, url, filename, applied };
}

// ═════════════════════════════════════════════════════════════════════════════
// COST OF SALE (what was paid to the seller / supplier)
// ═════════════════════════════════════════════════════════════════════════════
export async function recordCostOfSale({ bizId, amount, note = "", method = "Cash", by = "" }) {
  const amt = r2(amount);
  if (!(amt > 0)) throw new Error("Enter an amount above 0.");
  const e = await Expense.create({
    businessId: bizId, amount: amt, category: "Cost of sales",
    description: String(note || "Cost of sale").slice(0, 300), method: normMethod(method) || "Cash",
    createdBy: by || "", enteredAt: new Date()
  });
  return e.toObject ? e.toObject() : e;
}

// ═════════════════════════════════════════════════════════════════════════════
// HOUSE BOOKS (ZimQuote's own business)
// ═════════════════════════════════════════════════════════════════════════════
let _house = { at: 0, biz: null };
export function _resetHouseCache() { _house = { at: 0, biz: null }; }

export async function getHouseBiz({ fresh = false } = {}) {
  if (!fresh && _house.biz && Date.now() - _house.at < 5 * 60 * 1000) return _house.biz;
  let biz = null;
  const id = String(process.env.ZQ_HOUSE_BIZ_ID || "").trim();
  if (/^[a-f0-9]{24}$/i.test(id)) biz = await Business.findById(id).lean().catch(() => null);
  if (!biz) {
    try {
      const { adminPhones } = await import("./quoteDesk.js");
      const UserRole = (await import("../models/userRole.js")).default;
      for (const p of adminPhones()) {
        const variants = [p, `+${p}`, p.startsWith("263") ? `0${p.slice(3)}` : p];
        const role = await UserRole.findOne({ phone: { $in: variants }, role: "owner", pending: { $ne: true } }).lean().catch(() => null);
        if (role?.businessId) { biz = await Business.findById(role.businessId).lean().catch(() => null); if (biz) break; }
      }
    } catch (e) { console.warn("[BOOKS] house lookup:", e.message); }
  }
  _house = { at: Date.now(), biz };
  return biz;
}

/**
 * Save a ZimQuote (Quote Desk) quotation in the house books as type "quote".
 * The number must be reserved first with nextDocNumber(house._id, "quote") so
 * the same number is printed on the PDF.
 */
export async function bookQuote({ house, number, customerPhone, customerName = "", lines, notes = "", ref = "", by = "" }) {
  const client = await upsertClient(house._id, { name: customerName, phone: customerPhone });
  const items = (lines || []).map(l => ({ item: l.item, qty: Number(l.qty) || 1, unit: r2(l.unit), total: r2(l.total || (Number(l.qty) || 1) * (Number(l.unit) || 0)) }));
  const total = r2(items.reduce((s, i) => s + i.total, 0));
  const doc = await Invoice.create({
    businessId: house._id, clientId: client._id, type: "quote", number,
    currency: "USD", items, subtotal: total, discountPercent: 0, discountAmount: 0, vatPercent: 0, vatAmount: 0, total,
    amountPaid: 0, balance: total, status: "unpaid",
    note: [ref ? `Quote Desk ${ref}` : "", notes].filter(Boolean).join(" · ").slice(0, 500),
    externalRef: ref, createdBy: by || "quote-desk", enteredAt: new Date()
  });
  return doc.toObject ? doc.toObject() : doc;
}

export default {
  convertQuoteToInvoice, recordInvoicePayment, recordCostOfSale, getHouseBiz, bookQuote,
  upsertClient, assertCanCreateDoc, normMethod, docUrl
};
