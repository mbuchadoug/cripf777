// services/docNumbers.js
// ═════════════════════════════════════════════════════════════════════════════
// Atomic document numbers (INV-000123 / QT-000045 / RCPT-000067)
// ─────────────────────────────────────────────────────────────────────────────
// The old way (biz.counters.x += 1 in memory, then biz.save()) can hand the
// SAME number to two documents when two people on one business finish a
// document at the same moment. A single $inc in the database can't.
//
//   const number = await nextDocNumber(biz._id, "invoice");   // "INV-000124"
//
// Never mutate biz.counters in memory after this - biz.save() only writes the
// paths you changed, so leaving counters alone keeps the DB value intact.
// ═════════════════════════════════════════════════════════════════════════════
import Business from "../models/business.js";

const KEYS = { invoice: "invoice", quote: "quote", receipt: "receipt" };
const PAD = 6;

export function docPrefix(biz, type) {
  if (type === "quote")   return (biz?.quotePrefix   || "QT").trim()   || "QT";
  if (type === "receipt") return (biz?.receiptPrefix || "RCPT").trim() || "RCPT";
  return (biz?.invoicePrefix || "INV").trim() || "INV";
}

export function formatDocNumber(prefix, n) {
  return `${prefix}-${String(n).padStart(PAD, "0")}`;
}

/**
 * Reserve the next number for a document type, atomically.
 * @param {ObjectId|string|object} bizOrId  business or its _id
 * @param {"invoice"|"quote"|"receipt"} type
 * @returns {Promise<string>} e.g. "INV-000124"
 */
export async function nextDocNumber(bizOrId, type = "invoice") {
  const key = KEYS[type] || "invoice";
  const _id = bizOrId?._id || bizOrId;
  const projection = { counters: 1, invoicePrefix: 1, quotePrefix: 1, receiptPrefix: 1 };
  let b = null;
  try {
    b = await Business.findOneAndUpdate({ _id }, { $inc: { [`counters.${key}`]: 1 } }, { new: true, projection }).lean();
  } catch (err) {
    // Very old records can have counters: null → "$inc" can't create a field
    // inside null. Repair once (only when it's not an object), then retry.
    await Business.updateOne(
      { _id, $or: [{ counters: null }, { counters: { $type: "number" } }, { counters: { $type: "string" } }] },
      { $set: { counters: { invoice: 0, quote: 0, receipt: 0 } } }
    );
    b = await Business.findOneAndUpdate({ _id }, { $inc: { [`counters.${key}`]: 1 } }, { new: true, projection }).lean();
  }
  if (!b) throw new Error("Business not found for numbering");
  return formatDocNumber(docPrefix(b, type), b.counters?.[key] || 1);
}

export default { nextDocNumber, docPrefix, formatDocNumber };
