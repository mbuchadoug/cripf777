import { Router } from "express";
import multer from "multer";
import PlacementAudit from "../models/placementAudit.js";
import SpecialScoiAudit from "../models/specialScoiAudit.js";
import { ensureAuth } from "../middleware/authGuard.js";

const router = Router();

const upload = multer({
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter(req, file, cb) {
    if (!file.originalname.endsWith(".json")) return cb(new Error("Only JSON files allowed"));
    cb(null, true);
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// deepMerge + mergeAuditObjects  (unchanged)
// ──────────────────────────────────────────────────────────────────────────────
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

function mergeAuditObjects(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return [];

  const allArePartial = arr.every(
    obj => obj && typeof obj === "object" && !(obj.subject?.name && obj.purpose)
  );

  if (allArePartial) {
    const merged = {};
    for (const obj of arr) deepMerge(merged, obj);
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

// ──────────────────────────────────────────────────────────────────────────────
// normalizeAudit
// Maps alternative/flexible JSON field names → canonical names the view expects
// ──────────────────────────────────────────────────────────────────────────────
function normalizeAudit(raw) {
  // Shallow clone so we don't mutate the original
  const a = Object.assign({}, raw);

  // 1. assessmentDate → assessmentWindow
  //    Your JSON uses assessmentDate.label; the view reads assessmentWindow.label
  if (!a.assessmentWindow?.label && a.assessmentDate?.label) {
    a.assessmentWindow = {
      ...(a.assessmentWindow || {}),
      label: a.assessmentDate.label,
      phase: a.assessmentDate.type || a.assessmentDate.phase || ""
    };
  }

  // 2. CRIPFCntInterpretation → findings
  //    Your JSON puts the core finding in CRIPFCntInterpretation.summary
  //    The view reads findings.coreFinding / findings.secondaryFindings
  if (!a.findings && a.CRIPFCntInterpretation) {
    const interp = a.CRIPFCntInterpretation;
    const secondary = [];
    if (interp.keyDoctrine) secondary.push(interp.keyDoctrine);
    a.findings = {
      coreFinding:        interp.summary   || "",
      secondaryFindings:  secondary,
      classification:     a.classification || null
    };
  }

  // 3. Top-level classification → findings.classification
  //    (handles case where findings already exists but classification is missing from it)
  if (a.findings && !a.findings.classification && a.classification) {
    a.findings = { ...a.findings, classification: a.classification };
  }

  // 4. coreDoctrine → context.doctrine
  //    The view renders this inside the Context section
  if (a.coreDoctrine) {
    a.context = {
      ...(a.context || {}),
      doctrine: a.coreDoctrine
    };
  }

  return a;
}

// ──────────────────────────────────────────────────────────────────────────────
// runScoiImport
// ──────────────────────────────────────────────────────────────────────────────
async function runScoiImport(rawAudits, auditType) {
  const audits = mergeAuditObjects(rawAudits);
  console.log(`[SCOI import] Raw: ${rawAudits.length} → merged: ${audits.length}`);

  let imported = 0, skipped = 0;
  const errors = [];

  for (let audit of audits) {
    try {
      // Normalize BEFORE validation so assessmentWindow etc. are present
      audit = normalizeAudit(audit);

      if (!audit.subject?.name) {
        console.warn("[SCOI import] skip – no subject.name:", JSON.stringify(audit).slice(0, 100));
        skipped++; continue;
      }
      if (!audit.purpose) {
        console.warn("[SCOI import] skip – no purpose:", audit.subject.name);
        skipped++; continue;
      }

      const Model = auditType === "special" ? SpecialScoiAudit : PlacementAudit;

      // Dedup on name + window (if window present)
      const dupQuery = { "subject.name": audit.subject.name };
      if (audit.assessmentWindow?.label) {
        dupQuery["assessmentWindow.label"] = audit.assessmentWindow.label;
      }

      const exists = await Model.findOne(dupQuery).lean();
      if (exists) {
        console.log(`[SCOI import] duplicate: "${audit.subject.name}"`);
        skipped++; continue;
      }

      await Model.create({ framework: "CRIPFCnt SCOI", ...audit });
      console.log(`[SCOI import] ✅ saved: "${audit.subject.name}"`);
      imported++;
    } catch (docErr) {
      console.error("[SCOI import] save error:", docErr.message);
      errors.push(`${audit.subject?.name || "unknown"}: ${docErr.message}`);
      skipped++;
    }
  }

  return { imported, skipped, errors };
}

// ──────────────────────────────────────────────────────────────────────────────
// GET  /admin/scoi/import
// ──────────────────────────────────────────────────────────────────────────────
router.get("/admin/scoi/import", ensureAuth, (req, res) => {
  res.render("admin/scoi_import", { title: "Import SCOI Reports", user: req.user });
});

// ──────────────────────────────────────────────────────────────────────────────
// POST /admin/scoi/import  — file upload OR pasted JSON
// ──────────────────────────────────────────────────────────────────────────────
router.post(
  "/admin/scoi/import",
  ensureAuth,
  upload.single("auditFile"),
  async (req, res) => {
    const page = (props) => res.render("admin/scoi_import", { user: req.user, ...props });

    try {
      const { auditType } = req.body;
      let raw;

      if (req.file) {
        raw = req.file.buffer.toString("utf8");
      } else if (req.body?.auditJson?.trim()) {
        raw = req.body.auditJson.trim();
      } else {
        return page({ error: "Please upload a JSON file or paste JSON text" });
      }

      let data;
      try { data = JSON.parse(raw); }
      catch (e) { return page({ error: `Invalid JSON: ${e.message}` }); }

      const rawAudits = Array.isArray(data) ? data : [data];
      const { imported, skipped, errors } = await runScoiImport(rawAudits, auditType);

      return page({
        success:      `✅ Imported ${imported} report${imported !== 1 ? "s" : ""}. Skipped ${skipped}.`,
        importErrors: errors.length ? errors : null
      });
    } catch (err) {
      console.error("[SCOI import]", err);
      return page({ error: err.message || "Import failed" });
    }
  }
);

export default router;