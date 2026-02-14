import Counter from "../models/counter.js";

export async function nextNumber(type) {
  // type: "invoice", "quote", "receipt"
  const now = new Date();
  const y = now.getFullYear();
  const doc = await Counter.findOneAndUpdate(
    { _id: `${type}-${y}` },
    { $inc: { seq: 1 } },
    { upsert: true, new: true }
  );
  const seq = String(doc.seq).padStart(3, "0");
  return `${type.toUpperCase().slice(0,3)}${y}${seq}`; // e.g. INV2025001
}
