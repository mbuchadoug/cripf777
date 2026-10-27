// utils/scoiImportNormalizer.js
// ─────────────────────────────────────────────────────────────────────────────
// FLEXIBLE SCOI IMPORT NORMALIZER  (v2 — structure-agnostic)
//
// Goal: accept a SCOI report in ANY shape and turn it into a document the
// SpecialScoiAudit / PlacementAudit models will accept, WITHOUT dropping
// anything and WITHOUT ever skipping a readable report.
//
// It copes with, among others:
//   • the "standard" flat format        ({ subject:{name}, purpose, ... })
//   • the section_NN_* format            (Martin Butler)
//   • metadata-based formats under ANY key:
//       metadata / report_metadata / reportMetadata / meta / audit_metadata …
//   • reports with NO subject field at all (name is derived, or generated)
//   • an array of partial chunks         (deep-merged into one)
//   • plain text
//
// Design rules (so nothing that already works breaks):
//   1. NON-DESTRUCTIVE — a field already present is never overwritten; we only
//      FILL what's missing.
//   2. FULL FIDELITY — the complete original is preserved verbatim in `raw`,
//      which is what the generic renderer (scoiCompleteHtml) displays.
//   3. NEVER SKIP — subject.name, auditType and purpose are ALWAYS produced,
//      deriving them from whatever the report contains, and generating a
//      last-resort name rather than rejecting the report.
//
// No external dependencies — safe to import anywhere.
// ─────────────────────────────────────────────────────────────────────────────

function clone(obj) {
  try { if (typeof structuredClone === "function") return structuredClone(obj); }
  catch { /* fall through */ }
  return JSON.parse(JSON.stringify(obj));
}

function isPlainObject(v) {
  return v && typeof v === "object" && !Array.isArray(v);
}

/** First non-empty trimmed string from the candidates. */
function firstString(...vals) {
  for (const v of vals) {
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

/** Pull a human name out of a free-text subject such as
 *  "Martin Butler — five-minute discussion" → "Martin Butler", or
 *  "Original Johari Window model (Luft and Ingham, 1955)" → "Original Johari Window model". */
function leadName(str) {
  if (typeof str !== "string") return null;
  const cut = str.split(/[—–:|(]| - /)[0];
  const out = (cut || str).trim();
  return out || null;
}

/** Every object whose KEY looks like metadata, merged into one lookup view.
 *  Handles metadata, report_metadata, reportMetadata, meta, audit_metadata … */
function gatherMeta(obj) {
  const merged = {};
  for (const [k, v] of Object.entries(obj)) {
    if (isPlainObject(v) && /meta(data)?$/i.test(k)) {
      Object.assign(merged, v);
    }
  }
  // also fold in a top-level `meta` even if named oddly
  if (isPlainObject(obj.metadata)) Object.assign(merged, obj.metadata);
  return merged;
}

/** Recursively search for the first string value whose key matches `keyRe`.
 *  Shallow-first, bounded depth, skips the giant `raw`-like noise. */
function deepFindString(obj, keyRe, maxDepth = 4) {
  const queue = [[obj, 0]];
  while (queue.length) {
    const [cur, depth] = queue.shift();
    if (!isPlainObject(cur) || depth > maxDepth) continue;
    for (const [k, v] of Object.entries(cur)) {
      if (typeof v === "string" && v.trim() && keyRe.test(k)) return v.trim();
    }
    for (const v of Object.values(cur)) {
      if (isPlainObject(v)) queue.push([v, depth + 1]);
      else if (Array.isArray(v)) v.forEach(it => isPlainObject(it) && queue.push([it, depth + 1]));
    }
  }
  return null;
}

/** Collect section_NN_* keys (for the warning note). */
function sectionKeys(obj) {
  return Object.keys(obj).filter(k => /^section[_]?\d+/i.test(k));
}

/** Best-effort purpose text from any summary-like content, any format. */
function derivePurpose(src, meta) {
  const exec =
    src.section_01_executive_summary ||
    src.executiveSummary ||
    src.executive_summary ||              // ← Johari uses snake_case
    src.section_1_executive_summary ||
    null;

  // executive_summary may itself be a plain string
  if (typeof exec === "string" && exec.trim()) return exec.trim();

  return firstString(
    src.purpose,
    exec && (exec.summary || exec.finding || exec.central_question ||
             exec.reframed_question || exec.overview || exec.interpretation),
    src.summary,
    src.abstract,
    src.overview,
    src.marketplace && src.marketplace.summary,
    src.CRIPFCntInterpretation && src.CRIPFCntInterpretation.summary,
    src.civilization_insight,
    meta.disclaimer,
    meta.description,
    deepFindString(src, /^(summary|finding|purpose|abstract|overview)$/i)
  );
}

/** Price in CENTS from any known location; null if none found. */
function derivePriceCents(src, meta) {
  const fromAccess = (ap) => (ap && Number(ap.amount) > 0) ? Math.round(Number(ap.amount) * 100) : null;
  const cs = src.commercialStatus;
  if (cs && Number(cs.fullReportPriceUSD) > 0) return Math.round(Number(cs.fullReportPriceUSD) * 100);
  return (
    fromAccess(meta.access_price) ||
    fromAccess(src.access_price) ||
    (Number.isInteger(src.price) && src.price > 0 ? src.price : null) ||
    (Number(src.priceUSD || src.priceUsd) > 0 ? Math.round(Number(src.priceUSD || src.priceUsd) * 100) : null)
  );
}

/** assessmentWindow.label — used for dedup + list display. */
function deriveWindowLabel(src, meta) {
  return firstString(
    src.assessmentWindow && src.assessmentWindow.label,
    src.assessmentDate && (src.assessmentDate.label || src.assessmentDate.date),
    typeof src.assessmentDate === "string" ? src.assessmentDate : null,
    meta.period,                                   // ← Johari "2026"
    meta.reference_date,
    meta.historical_reference_date,
    meta.publication_date,
    src.reference_date,
    src.temporal_controls && (src.temporal_controls.historical_as_of || src.temporal_controls.report_prepared),
    meta.version && `v${meta.version}`,
    src.version && `v${src.version}`,
    src.date
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// normalizeScoiAudit(input)
//   input: an object (any shape) OR a string (plain text / stringified JSON)
//   returns: { record, raw, priceCents, warnings[] }
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
    warnings.push("Imported as plain text — title/subject derived from the first line.");
    return { record, raw, priceCents: null, warnings };
  }

  if (!isPlainObject(input)) {
    throw new Error("Unsupported import payload (expected an object or text).");
  }

  const raw    = clone(input);   // pristine, full-fidelity copy for the renderer
  const record = clone(input);   // working copy we fill required fields on
  const meta   = gatherMeta(record);   // metadata under ANY key, merged

  // ── subject.name (always ends up set) ───────────────────────────────────────
  if (!record.subject || typeof record.subject !== "object") {
    // keep a string subject as a hint but make subject an object
    if (typeof record.subject === "string" && record.subject.trim()) {
      record.subject = { name: leadName(record.subject) || record.subject.trim() };
    } else {
      record.subject = {};
    }
  }
  if (!record.subject.name) {
    const derived = firstString(
      record.subjectName,
      record.subject_name,
      record.section_03_subject_and_context && record.section_03_subject_and_context.speaker_name,
      record.section_03_subject_and_context && record.section_03_subject_and_context.subject_name,
      leadName(meta.subject),
      meta.subject_name,
      meta.entity,
      leadName(record.subject_description),
      // a nested subject object anywhere (e.g. subject.name deeper in the tree)
      deepFindString(record, /^(name|speaker_name|subject_name|entity|entity_name|organization|organisation|company|person|title)$/i),
      meta.title,
      record.title,
      record.name,
      meta.report_id,
      record.report_id
    );
    if (derived) {
      record.subject.name = derived;
      warnings.push(`subject.name auto-derived → "${derived}".`);
    } else {
      // Last resort: never skip. Generate a stable-ish name so it imports.
      record.subject.name = `Imported SCOI Report ${new Date().toISOString().slice(0,19).replace("T"," ")}`;
      warnings.push("subject.name could not be found — a placeholder name was generated so the report still imports. You can rename it later.");
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
      record.audit_type, record.document_type, meta.document_type,
      meta.assessment_type, record.reportType, record.type, "special_report"
    );
    record.auditType = at;
    warnings.push(`auditType auto-derived → "${at}".`);
  }

  // ── purpose (importer requires this) ───────────────────────────────────────
  if (!record.purpose) {
    record.purpose = derivePurpose(record, meta) || record.title || record.subject.name || "SCOI structured audit report.";
    warnings.push("purpose auto-derived from executive summary / metadata.");
  }

  // ── assessmentWindow.label (dedup + list display) ──────────────────────────
  const label = deriveWindowLabel(record, meta);
  if (label) {
    if (!isPlainObject(record.assessmentWindow)) record.assessmentWindow = {};
    if (!record.assessmentWindow.label) record.assessmentWindow.label = label;
  }

  // ── reportCode (PDF filename) ──────────────────────────────────────────────
  if (!record.reportCode) {
    const rc = firstString(meta.report_id, record.report_id, record.code, meta.report_code);
    if (rc) record.reportCode = rc;
  }

  // ── status / author passthrough fills ──────────────────────────────────────
  if (!record.status) record.status = firstString(meta.status, record.state) || undefined;
  if (!record.author) record.author = firstString(meta.author, meta.publisher) || undefined;

  // ── price ──────────────────────────────────────────────────────────────────
  const priceCents = derivePriceCents(record, meta);
  if (priceCents != null) warnings.push(`price resolved → $${(priceCents / 100).toFixed(2)}.`);

  const secs = sectionKeys(record);
  if (secs.length) warnings.push(`${secs.length} section_* block(s) preserved via raw.`);

  return { record, raw, priceCents, warnings };
}

export default normalizeScoiAudit;