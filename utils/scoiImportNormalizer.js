// utils/scoiImportNormalizer.js
// ─────────────────────────────────────────────────────────────────────────────
// FLEXIBLE SCOI IMPORT NORMALIZER
//
// Goal: accept SCOI report submissions in ANY shape - the "standard" flat format,
// the newer schema_version / section_NN_* format (e.g. Martin Butler), a bare
// metadata+sections object, an array of partial chunks, or even plain text - and
// turn each into a document that SpecialScoiAudit / PlacementAudit will accept
// WITHOUT dropping anything.
//
// Design rules (so nothing that already works breaks):
//   1. NON-DESTRUCTIVE: a field that is already present on the submission is never
//      overwritten. We only FILL the required fields that are missing.
//   2. FULL FIDELITY: the complete original submission is preserved verbatim in
//      `raw`, which is what the generic renderer (scoiCompleteHtml) displays. So
//      a format this schema has never seen still shows every section.
//   3. SCHEMA-SAFE: the three things the pipeline needs are always produced -
//        • auditType      (SpecialScoiAudit schema: required:true)
//        • subject.name   (importer validation + dedup + PDF filename)
//        • purpose        (importer validation)
//      plus title, assessmentWindow.label and a price, all derived from whatever
//      the submission actually contains.
//
// This file has NO external dependencies and is safe to import anywhere.
// ─────────────────────────────────────────────────────────────────────────────

/** Deep clone that is safe for the plain-JSON objects we import. */
function clone(obj) {
  try {
    if (typeof structuredClone === "function") return structuredClone(obj);
  } catch { /* fall through */ }
  return JSON.parse(JSON.stringify(obj));
}

function isPlainObject(v) {
  return v && typeof v === "object" && !Array.isArray(v);
}

/** First non-empty string from a list of candidates. */
function firstString(...vals) {
  for (const v of vals) {
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

/** Pull a human subject name out of a free-text subject like
 *  "Martin Butler - five-minute discussion on dishonesty" → "Martin Butler". */
function leadName(str) {
  if (typeof str !== "string") return null;
  const cut = str.split(/[-–\-:|,(]/)[0];
  return (cut || str).trim() || null;
}

/** Collect the section_NN_* / sectionNN keys (newer format) in order. */
function sectionKeys(obj) {
  return Object.keys(obj)
    .filter(k => /^section[_]?\d+/i.test(k))
    .sort();
}

/** Best-effort purpose text from whatever summary-like content exists. */
function derivePurpose(src) {
  const exec =
    src.section_01_executive_summary ||
    src.executiveSummary ||
    src.section_1_executive_summary ||
    null;

  return firstString(
    src.purpose,
    exec && (exec.summary || exec.central_question || exec.reframed_question || exec.overview),
    src.summary,
    src.marketplace && src.marketplace.summary,
    src.CRIPFCntInterpretation && src.CRIPFCntInterpretation.summary,
    src.metadata && src.metadata.disclaimer,
    src.abstract,
    src.overview
  );
}

/** Price in CENTS from any of the known price locations; null if none found. */
function derivePriceCents(src) {
  // commercialStatus.fullReportPriceUSD (dollars) - standard format
  const cs = src.commercialStatus;
  if (cs && Number(cs.fullReportPriceUSD) > 0) {
    return Math.round(Number(cs.fullReportPriceUSD) * 100);
  }
  // metadata.access_price.amount (dollars) - newer format
  const ap = src.metadata && src.metadata.access_price;
  if (ap && Number(ap.amount) > 0) {
    return Math.round(Number(ap.amount) * 100);
  }
  // access_price at root (dollars)
  if (src.access_price && Number(src.access_price.amount) > 0) {
    return Math.round(Number(src.access_price.amount) * 100);
  }
  // price already in cents (integer) - standard stored form
  if (Number.isInteger(src.price) && src.price > 0) return src.price;
  // priceUSD / priceUsd (dollars)
  const dollars = Number(src.priceUSD || src.priceUsd);
  if (dollars > 0) return Math.round(dollars * 100);
  return null;
}

/** assessmentWindow.label used for dedup + list display. */
function deriveWindowLabel(src) {
  return firstString(
    src.assessmentWindow && src.assessmentWindow.label,
    src.assessmentDate && (src.assessmentDate.label || src.assessmentDate.date),
    src.metadata && src.metadata.reference_date,
    src.metadata && src.metadata.publication_date,
    src.reference_date,
    src.assessmentDate && typeof src.assessmentDate === "string" ? src.assessmentDate : null,
    src.metadata && src.metadata.version && `v${src.metadata.version}`,
    src.date
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// normalizeScoiAudit(input)
//   input: an object (any shape) OR a string (plain text / stringified JSON)
//   returns: { record, raw, priceCents, warnings[] }
//     record     → merged into Model.create({ framework, ...record, raw, price })
//     raw        → the pristine original, stored verbatim for the renderer
//     priceCents → resolved price in cents (caller may still default it)
//     warnings   → human-readable notes about what was auto-derived
// ─────────────────────────────────────────────────────────────────────────────
export function normalizeScoiAudit(input) {
  const warnings = [];

  // ── Plain-text submission ──────────────────────────────────────────────────
  if (typeof input === "string") {
    const text = input.trim();
    const firstLine = (text.split("\n").find(l => l.trim()) || "Imported SCOI Report").trim();
    const title = firstLine.slice(0, 160);
    const record = {
      auditType: "special_report",
      title,
      subject: { name: title.slice(0, 120) },
      purpose: text.slice(0, 500),
      body: text
    };
    const raw = { document_type: "plain_text_import", title, content: text };
    warnings.push("Imported as plain text - title/subject derived from the first line.");
    return { record, raw, priceCents: null, warnings };
  }

  if (!isPlainObject(input)) {
    throw new Error("Unsupported import payload (expected an object or text).");
  }

  const raw = clone(input);            // pristine, full-fidelity copy for the renderer
  const record = clone(input);         // working copy we fill required fields on
  const meta = isPlainObject(record.metadata) ? record.metadata : {};

  // ── subject.name ───────────────────────────────────────────────────────────
  if (!record.subject || typeof record.subject !== "object") record.subject = {};
  if (!record.subject.name) {
    const derived = firstString(
      typeof record.subject === "string" ? record.subject : null,
      record.subjectName,
      record.section_03_subject_and_context && record.section_03_subject_and_context.speaker_name,
      record.section_03_subject_and_context && record.section_03_subject_and_context.subject_name,
      leadName(meta.subject),
      leadName(record.subject_description),
      meta.title,
      record.title,
      record.name,
      meta.report_id
    );
    if (derived) {
      record.subject.name = derived;
      warnings.push(`subject.name auto-derived → "${derived}".`);
    }
  }

  // ── title ──────────────────────────────────────────────────────────────────
  if (!record.title) {
    const t = firstString(meta.title, record.name, record.subject.name);
    if (t) { record.title = t; warnings.push(`title auto-derived → "${t}".`); }
  }

  // ── auditType (schema requires this) ───────────────────────────────────────
  if (!record.auditType) {
    const at = firstString(
      record.audit_type,
      record.document_type,
      record.reportType,
      record.type,
      "special_report"
    );
    record.auditType = at;
    warnings.push(`auditType auto-derived → "${at}".`);
  }

  // ── purpose (importer requires this) ───────────────────────────────────────
  if (!record.purpose) {
    const p = derivePurpose(record);
    record.purpose = p || record.title || record.subject.name || "SCOI structured audit report.";
    warnings.push("purpose auto-derived from executive summary / metadata.");
  }

  // ── assessmentWindow.label (dedup + list display) ──────────────────────────
  const label = deriveWindowLabel(record);
  if (label) {
    if (!isPlainObject(record.assessmentWindow)) {
      // keep any existing assessmentWindow data, but guarantee a label
      record.assessmentWindow = isPlainObject(record.assessmentWindow)
        ? record.assessmentWindow
        : {};
    }
    if (!record.assessmentWindow.label) record.assessmentWindow.label = label;
  }

  // ── reportCode (nice-to-have, used in PDF filename) ────────────────────────
  if (!record.reportCode) {
    const rc = firstString(meta.report_id, record.report_id, record.code);
    if (rc) record.reportCode = rc;
  }

  // ── status / author passthrough fills ──────────────────────────────────────
  if (!record.status) record.status = firstString(meta.status, record.state) || undefined;
  if (!record.author) record.author = firstString(meta.author, meta.publisher) || undefined;

  // ── price ──────────────────────────────────────────────────────────────────
  const priceCents = derivePriceCents(record);
  if (priceCents != null) warnings.push(`price resolved → $${(priceCents / 100).toFixed(2)}.`);

  // Ensure the newer section_NN_* format is never lost at the top level:
  // declared schema fields populate where they match; everything else lives in
  // `raw` and is rendered by scoiCompleteHtml. Nothing is dropped.
  const secs = sectionKeys(record);
  if (secs.length) warnings.push(`${secs.length} section_* block(s) preserved via raw.`);

  return { record, raw, priceCents, warnings };
}

export default normalizeScoiAudit;
