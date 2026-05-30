import { Router } from "express";
import multer from "multer";
import PlacementAudit from "../models/placementAudit.js";
import SpecialScoiAudit from "../models/specialScoiAudit.js";
import { ensureAuth } from "../middleware/authGuard.js";

const router = Router();

// Multer config for JSON uploads
const upload = multer({
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter(req, file, cb) {
    if (!file.originalname.endsWith(".json")) {
      return cb(new Error("Only JSON files allowed"));
    }
    cb(null, true);
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// mergeAuditObjects
// ──────────────────────────────────────────────────────────────────────────────
// ROOT-CAUSE FIX for "Imported 0 reports. Skipped 12 duplicates."
//
// The SCOI JSON format allows a single audit to be represented as an ARRAY of
// partial objects, each contributing different fields:
//
//   [ { "subject": {...}, "auditType": "..." },   ← metadata chunk
//     { "purpose": "..." },                        ← purpose chunk
//     { "context": {...} },                        ← context chunk
//     ...
//   ]
//
// The old code treated each object individually. Because no single object
// contained BOTH subject.name AND purpose, EVERY object failed validation and
// was counted as a skipped "duplicate" (actually a validation failure).
//
// FIX: detect when the array looks like a single split audit (no object has
// both subject.name and auditType on its own, or they share a common
// "framework" / "auditType" key) and deep-merge them into one document before
// validation and deduplication.
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
// Shared import logic — accepts a merged audit array + auditType string
//
// How it works:
//   Both the file-upload path and the paste path call this after parsing JSON.
//   No duplication of the core validation/upsert logic.
// ──────────────────────────────────────────────────────────────────────────────
async function runScoiImport(rawAudits, auditType) {
  const audits = mergeAuditObjects(rawAudits);
  console.log(`[SCOI import] Raw objects: ${rawAudits.length}, merged audits: ${audits.length}`);

  let imported = 0;
  let skipped  = 0;
  const errors = [];

  for (const audit of audits) {
    try {
      if (!audit.subject?.name) {
        console.warn("[SCOI import] Skipping - missing subject.name:", JSON.stringify(audit).slice(0, 120));
        skipped++;
        continue;
      }
      if (!audit.purpose) {
        console.warn("[SCOI import] Skipping - missing purpose for:", audit.subject?.name);
        skipped++;
        continue;
      }

      const Model = auditType === "special" ? SpecialScoiAudit : PlacementAudit;

      const dupQuery = { "subject.name": audit.subject.name };
      if (audit.assessmentWindow?.label) {
        dupQuery["assessmentWindow.label"] = audit.assessmentWindow.label;
      }

      const exists = await Model.findOne(dupQuery).lean();
      if (exists) {
        console.log(`[SCOI import] Duplicate skipped: "${audit.subject.name}"`);
        skipped++;
        continue;
      }

      await Model.create({ framework: "CRIPFCnt SCOI", ...audit });
      console.log(`[SCOI import] ✅ Imported: "${audit.subject.name}"`);
      imported++;
    } catch (docErr) {
      console.error("[SCOI import] Error saving audit:", docErr.message);
      errors.push(`${audit.subject?.name || "unknown"}: ${docErr.message}`);
      skipped++;
    }
  }

  return { imported, skipped, errors };
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
// POST - Import via file upload OR pasted JSON
//
// How it works:
//   1. multer runs — if a file was sent it populates req.file, otherwise no-op
//   2. We check req.file first (file upload path, unchanged behaviour)
//   3. If no file, we look for req.body.auditJson (the textarea input)
//   4. Both paths parse JSON → mergeAuditObjects → runScoiImport
// ──────────────────────────────────────────────────────────────────────────────
router.post(
  "/admin/scoi/import",
  ensureAuth,
  upload.single("auditFile"),   // always present; harmless when no file sent
  async (req, res) => {
    const renderPage = (props) =>
      res.render("admin/scoi_import", { user: req.user, ...props });

    try {
      const { auditType } = req.body; // 'placement' or 'special'
      let raw;

      if (req.file) {
        // ── Path A: file upload (original behaviour) ──
        raw = req.file.buffer.toString("utf8");
      } else if (req.body?.auditJson?.trim()) {
        // ── Path B: pasted JSON text ──
        raw = req.body.auditJson.trim();
      } else {
        return renderPage({ error: "Please upload a JSON file or paste JSON text" });
      }

      let data;
      try {
        data = JSON.parse(raw);
      } catch (parseErr) {
        return renderPage({ error: `Invalid JSON: ${parseErr.message}` });
      }

      const rawAudits = Array.isArray(data) ? data : [data];
      const { imported, skipped, errors } = await runScoiImport(rawAudits, auditType);

      const message = `✅ Imported ${imported} report${imported !== 1 ? "s" : ""}. Skipped ${skipped} (duplicates or invalid).`;

      return renderPage({
        success:      message,
        importErrors: errors.length ? errors : null
      });
    } catch (err) {
      console.error("[SCOI import]", err);
      return renderPage({ error: err.message || "Import failed" });
    }
  }
);

export default router;