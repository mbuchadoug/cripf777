import { Router } from "express";
import multer from "multer";
import PlacementAudit from "../models/placementAudit.js";
import SpecialScoiAudit from "../models/specialScoiAudit.js";
import { ensureAuth } from "../middleware/authGuard.js";
import { normalizeScoiAudit } from "../utils/scoiImportNormalizer.js";

const router = Router();

// Multer config for uploads.
// RELAXED (flexible import): accept .json and .txt (and files with no extension),
// so differently-packaged reports can be uploaded without renaming. The content
// itself is parsed/normalized downstream, so a wrong extension is harmless.
const upload = multer({
  limits: { fileSize: 8 * 1024 * 1024 }, // 8MB
  fileFilter(req, file, cb) {
    const name = (file.originalname || "").toLowerCase();
    const ok = name.endsWith(".json") || name.endsWith(".txt") || !name.includes(".");
    if (!ok) {
      return cb(new Error("Please upload a .json or .txt file (or paste the content)."));
    }
    cb(null, true);
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// mergeAuditObjects - unchanged behaviour.
// The SCOI JSON format allows a single audit to be represented as an ARRAY of
// partial objects, each contributing different fields. We deep-merge those into
// one document before validation and deduplication.
// ──────────────────────────────────────────────────────────────────────────────
function mergeAuditObjects(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return [];

  const allArePartial = arr.every(
    obj =>
      obj && typeof obj === "object" &&
      !(obj.subject?.name && obj.purpose)
  );

  if (allArePartial) {
    const merged = {};
    for (const obj of arr) {
      deepMerge(merged, obj);
    }
    return [merged];
  }

  const result = [];
  let current = null;

  for (const obj of arr) {
    if (obj?.subject?.name || obj?.auditType) {
      if (current) result.push(current);
      current = deepMerge({}, obj);
    } else if (current) {
      deepMerge(current, obj);
    } else {
      current = deepMerge({}, obj);
    }
  }

  if (current) result.push(current);
  return result.length > 0 ? result : arr;
}

function deepMerge(target, source) {
  if (!source || typeof source !== "object") return target;
  for (const [key, val] of Object.entries(source)) {
    if (
      val && typeof val === "object" && !Array.isArray(val) &&
      target[key] && typeof target[key] === "object" && !Array.isArray(target[key])
    ) {
      deepMerge(target[key], val);
    } else {
      target[key] = val;
    }
  }
  return target;
}

// ──────────────────────────────────────────────────────────────────────────────
// Shared import logic.
//
// FLEXIBLE IMPORT: each merged audit is run through normalizeScoiAudit(), which
// guarantees the required fields (auditType, subject.name, purpose) are present -
// deriving them from whatever structure the submission uses - and preserves the
// COMPLETE original in `raw`. This removes the need to hand-reformat every report.
//
// `inputs` may be an array of objects, a single object, or a single string
// (plain text). Backwards compatible with all previously-working imports.
// ──────────────────────────────────────────────────────────────────────────────
async function runScoiImport(inputs, auditType) {
  // Plain-text submission arrives as a single string.
  let audits;
  if (typeof inputs === "string") {
    audits = [inputs];
  } else {
    const arr = Array.isArray(inputs) ? inputs : [inputs];
    audits = mergeAuditObjects(arr);
  }

  console.log(`[SCOI import] inputs → ${audits.length} audit(s) to process`);

  let imported = 0;
  let skipped  = 0;
  const errors = [];
  const notes  = [];

  for (const item of audits) {
    let record, raw, priceCents, warnings;
    try {
      ({ record, raw, priceCents, warnings } = normalizeScoiAudit(item));
    } catch (normErr) {
      console.warn("[SCOI import] normalize failed:", normErr.message);
      skipped++;
      errors.push(`normalize: ${normErr.message}`);
      continue;
    }

    try {
      // Safety net: the normalizer guarantees these, but double-check.
      if (!record.subject?.name) {
        skipped++;
        errors.push("Skipped: could not determine a subject name.");
        continue;
      }
      if (!record.auditType) record.auditType = "special_report";
      if (!record.purpose)   record.purpose   = record.title || record.subject.name;

      const Model = auditType === "placement" ? PlacementAudit : SpecialScoiAudit;

      // Dedup on subject.name (+ window label when available).
      const dupQuery = { "subject.name": record.subject.name };
      if (record.assessmentWindow?.label) {
        dupQuery["assessmentWindow.label"] = record.assessmentWindow.label;
      }
      const exists = await Model.findOne(dupQuery).lean();
      if (exists) {
        console.log(`[SCOI import] Duplicate skipped: "${record.subject.name}"`);
        skipped++;
        continue;
      }

      // Resolve price: normalizer's derived price → legacy default $299.
      const finalPrice = (priceCents && priceCents > 0) ? priceCents : 29900;

      await Model.create({
        framework: "CRIPFCnt SCOI",
        ...record,
        raw,              // COMPLETE original - nothing dropped, renders generically
        price: finalPrice
      });

      if (warnings && warnings.length) {
        notes.push(`"${record.subject.name}": ${warnings.join(" ")}`);
      }
      console.log(`[SCOI import] ✅ Imported: "${record.subject.name}"`);
      imported++;
    } catch (docErr) {
      console.error("[SCOI import] Error saving audit:", docErr.message);
      errors.push(`${record?.subject?.name || "unknown"}: ${docErr.message}`);
      skipped++;
    }
  }

  return { imported, skipped, errors, notes };
}

// ──────────────────────────────────────────────────────────────────────────────
// GET - Import page
// ──────────────────────────────────────────────────────────────────────────────
router.get("/admin/scoi/import", ensureAuth, (req, res) => {
  res.render("admin/scoi_import", {
    title: "Import SCOI Reports",
    user:  req.user
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// POST - Import via file upload OR pasted content.
//
// Accepts: a .json file, a .txt file, pasted JSON, or pasted plain text.
// JSON that fails to parse is imported as plain text rather than rejected.
// ──────────────────────────────────────────────────────────────────────────────
router.post(
  "/admin/scoi/import",
  ensureAuth,
  upload.single("auditFile"),
  async (req, res) => {
    const renderPage = (props) =>
      res.render("admin/scoi_import", { user: req.user, ...props });

    try {
      const auditType = req.body?.auditType || "special"; // 'placement' | 'special'
      let rawText;

      if (req.file) {
        rawText = req.file.buffer.toString("utf8");
      } else if (req.body?.auditJson?.trim()) {
        rawText = req.body.auditJson.trim();
      } else {
        return renderPage({ error: "Please upload a file or paste the report content." });
      }

      // Try JSON first; if it isn't JSON, import as plain text.
      let payload;
      try {
        payload = JSON.parse(rawText);
      } catch {
        payload = rawText; // plain-text path
      }

      const { imported, skipped, errors, notes } = await runScoiImport(payload, auditType);

      const message = `✅ Imported ${imported} report${imported !== 1 ? "s" : ""}. ` +
                      `Skipped ${skipped} (duplicates or unreadable).`;

      return renderPage({
        success:      message,
        importErrors: errors.length ? errors : null,
        importNotes:  notes && notes.length ? notes : null
      });
    } catch (err) {
      console.error("[SCOI import]", err);
      return renderPage({ error: err.message || "Import failed" });
    }
  }
);

export default router;
