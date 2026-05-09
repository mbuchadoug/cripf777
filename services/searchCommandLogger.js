import SearchCommandLog from "../models/searchCommandLog.js";

function normPhone(raw = "") {
  let p = String(raw || "").replace(/\D+/g, "");
  if (p.startsWith("0") && p.length === 10) p = "263" + p.slice(1);
  return p;
}

function normalizeText(text = "") {
  return String(text || "").toLowerCase().trim().replace(/\s+/g, " ");
}

function previewResults(results = []) {
  return (results || []).slice(0, 8).map(r => ({
    supplierId: String(r.supplierId || r._id || ""),
    supplierName: r.supplierName || r.businessName || "",
    product: r.product || "",
    service: r.service || "",
    city: r.supplierCity || r.location?.city || r.city || "",
    area: r.supplierArea || r.location?.area || r.area || "",
    priceText:
      r.pricePerUnit !== null && r.pricePerUnit !== undefined
        ? `$${Number(r.pricePerUnit).toFixed(2)}/${r.unit || "each"}`
        : ""
  }));
}

export async function logSearchCommand({
  phone,
  rawText,
  source = "text",
  flow = "unknown",
  sessionState = "",
  parsed = {},
  resultMode = "unknown",
  results = [],
  errorMessage = "",
  botReplySummary = "",
  meta = {}
}) {
  try {
    return await SearchCommandLog.create({
      phone: normPhone(phone),
      rawText: String(rawText || "").slice(0, 1000),
      normalizedText: normalizeText(rawText),
      source,
      flow,
      sessionState: sessionState || "",
      parsed: {
        product: parsed.product || "",
        service: parsed.service || "",
        city: parsed.city || "",
        area: parsed.area || "",
        category: parsed.category || "",
        profileType: parsed.profileType || ""
      },
      resultMode,
      resultCount: Array.isArray(results) ? results.length : 0,
      resultsPreview: previewResults(results),
      errorMessage: String(errorMessage || "").slice(0, 1000),
      botReplySummary: String(botReplySummary || "").slice(0, 500),
      meta
    });
  } catch (err) {
    console.warn("[SEARCH LOG FAILED]", err.message);
    return null;
  }
}