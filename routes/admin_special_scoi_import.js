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

  // If every item is a plain object and none of them looks like a
  // standalone complete audit (subject.name + purpose both present),
  // treat the whole array as one split audit and merge it.
  const allArePartial = arr.every(
    obj =>
      obj && typeof obj === "object" &&
      !(obj.subject?.name && obj.purpose)
  );

  if (allArePartial) {
    // Deep-merge all objects into one - later keys win for scalars,
    // nested objects are recursively merged.
    const merged = {};
    for (const obj of arr) {
      deepMerge(merged, obj);
    }
    return [merged];
  }

  // Mixed array: some objects are standalone audits, some may be fragments.
  // Group consecutive fragments that don't have subject.name into the
  // nearest preceding object that has subject.name.
  const result = [];
  let current = null;

  for (const obj of arr) {
    if (obj?.subject?.name || obj?.auditType) {
      // Start a new audit group
      if (current) result.push(current);
      current = deepMerge({}, obj);
    } else if (current) {
      // Fragment - merge into current audit
      deepMerge(current, obj);
    } else {
      // Fragment before any anchor - start a new group anyway
      current = deepMerge({}, obj);
    }
  }

  if (current) result.push(current);
  return result.length > 0 ? result : arr; // fall back to raw if nothing matched
}

// Simple deep-merge (target mutated in place, returns target)
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

// Import page
router.get("/admin/scoi/import", ensureAuth, (req, res) => {
  res.render("admin/scoi_import", {
    title: "Import SCOI Reports",
    user: req.user
  });
});

// Handle import
router.post(
  "/admin/scoi/import",
  ensureAuth,
  upload.single("auditFile"),
  async (req, res) => {
    try {
      if (!req.file) {
        return res.render("admin/scoi_import", {
          error: "No file uploaded",
          user: req.user
        });
      }

      const { auditType } = req.body; // 'placement' or 'special'
      const raw = req.file.buffer.toString("utf8");

      let data;
      try {
        data = JSON.parse(raw);
      } catch (parseErr) {
        return res.render("admin/scoi_import", {
          error: `Invalid JSON: ${parseErr.message}`,
          user: req.user
        });
      }

      // Support single object or array
      const rawAudits = Array.isArray(data) ? data : [data];

      // ✅ FIX: merge split-object arrays into proper single audit documents
      const audits = mergeAuditObjects(rawAudits);

      console.log(`[SCOI import] Raw objects: ${rawAudits.length}, merged audits: ${audits.length}`);

      let imported = 0;
      let skipped  = 0;
      const errors = [];

      for (const audit of audits) {
        try {
          // Validate required fields
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

          // Choose model
          const Model = auditType === "special" ? SpecialScoiAudit : PlacementAudit;

          // Check for duplicates - match on subject name + window label
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

          // Create audit document
          await Model.create({
            framework: "CRIPFCnt SCOI",
            ...audit
          });

          console.log(`[SCOI import] ✅ Imported: "${audit.subject.name}"`);
          imported++;

        } catch (docErr) {
          console.error("[SCOI import] Error saving audit:", docErr.message);
          errors.push(`${audit.subject?.name || "unknown"}: ${docErr.message}`);
          skipped++;
        }
      }

      const message = `✅ Imported ${imported} report${imported !== 1 ? "s" : ""}. Skipped ${skipped} (duplicates or invalid).`;

      return res.render("admin/scoi_import", {
        success: message,
        importErrors: errors.length ? errors : null,
        user: req.user
      });

    } catch (err) {
      console.error("[SCOI import]", err);
      return res.render("admin/scoi_import", {
        error: err.message || "Import failed",
        user: req.user
      });
    }
  }
);

export default router;