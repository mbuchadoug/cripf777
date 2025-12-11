// routes/admin/lms_import.js
import { Router } from "express";
import multer from "multer";
import mongoose from "mongoose";
import { ensureAuth } from "../../middleware/authGuard.js"; // adjust if your export differs
import Question from "../../models/question.js";
import Organization from "../../models/organization.js";

const router = Router();

// multer memory storage (we only need the buffer)
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 1024 * 1024 * 5 } }); // 5MB

// small helper ensureAdmin (in case admin.js helper isn't importable)
function ensureAdmin(req, res, next) {
  try {
    const email = (req.user && (req.user.email || req.user.username) || "").toLowerCase();
    const ADMIN_SET = new Set(
      (process.env.ADMIN_EMAILS || "")
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean)
    );
    if (!email || !ADMIN_SET.has(email)) {
      if (req.headers.accept && req.headers.accept.includes("text/html")) {
        return res.status(403).send("<h3>Forbidden — admin only</h3>");
      }
      return res.status(403).json({ error: "Forbidden — admin only" });
    }
    return next();
  } catch (e) {
    return next(e);
  }
}

// GET upload form - include organizations for the dropdown
router.get("/import", ensureAuth, ensureAdmin, async (req, res) => {
  try {
    const organizations = await Organization.find().sort({ name: 1 }).lean().exec();
    return res.render("admin/lms_import", { title: "Import LMS Questions", user: req.user, organizations });
  } catch (err) {
    console.error("[GET /admin/lms/import] error:", err && (err.stack || err));
    return res.status(500).send("failed to render import page");
  }
});

/**
 * POST /admin/lms/import
 * Accepts multiple files (upload.array("files")) or a textarea 'text'.
 * Supports:
 *  - single combined file (passage + --- + questions)
 *  - two-file upload (passageFile + file) — handled by upload.array reading any uploaded text files
 *  - multiple question files uploaded together
 *
 * The route will try comprehension parsing first (passage + --- + questions); if none found it falls back
 * to single-question block parsing. Inserted children are standard Question docs; comprehension parent is
 * saved as a Question doc with type:'comprehension' and questionIds linking to children.
 */
// Use multer.fields to accept specific named file inputs
const uploadFields = upload.fields([
  { name: "file", maxCount: 3 },
  { name: "passageFile", maxCount: 1 },
  { name: "files", maxCount: 6 } // if you allow an array named "files"
]);

router.post("/import", ensureAuth, ensureAdmin, uploadFields, async (req, res) => {
  try {
    // DEBUG: inspect what multer received
    console.log("[IMPORT] req.files keys:", Object.keys(req.files || {}));
    // req.files will be a map: { file: [ {..} ], passageFile: [ {..} ] }

    const texts = [];

    // First prioritize explicit passageFile + questions file pair
    if (req.files && req.files.passageFile && req.files.passageFile.length) {
      const passageBuf = req.files.passageFile[0].buffer ? req.files.passageFile[0].buffer.toString("utf8") : "";
      // if questions file also uploaded as 'file' or 'files', collect them
      const questionFiles = (req.files.file || req.files.files || []).slice();
      // if only one questions file provided, use it; if many, treat each separately
      if (passageBuf) {
        if (questionFiles.length) {
          // pair passage with each questions file (useful if uploading passage + one questions file)
          for (const qf of questionFiles) {
            const qtxt = qf.buffer ? qf.buffer.toString("utf8") : "";
            if (!qtxt) continue;
            // build a combined text: passage + delimiter + questions
            texts.push({ filename: `${req.files.passageFile[0].originalname} + ${qf.originalname}`, text: passageBuf + "\n\n---\n\n" + qtxt });
          }
        } else {
          // only passage uploaded -> treat passage as text only (no questions)
          texts.push({ filename: req.files.passageFile[0].originalname || "passage", text: passageBuf });
        }
      }
    }

    // If no passageFile pairing created, add any standalone uploaded files (file/files)
    if (!texts.length && req.files) {
      for (const key of ["file", "files"]) {
        if (req.files[key] && req.files[key].length) {
          for (const f of req.files[key]) {
            const buf = f.buffer ? f.buffer.toString("utf8") : "";
            if (!buf) continue;
            texts.push({ filename: f.originalname || key, text: buf });
          }
        }
      }
    }

    // If still empty, fallback to textarea 'text'
    if (!texts.length && req.body && req.body.text && String(req.body.text).trim()) {
      texts.push({ filename: "pasted", text: String(req.body.text) });
    }

    // If still empty, render error
    if (!texts.length) {
      const organizations = await Organization.find().sort({ name: 1 }).lean().exec();
      return res.render("admin/lms_import", {
        title: "Import Results",
        result: { parsed: 0, inserted: 0, errors: [{ reason: "No file(s) or text provided" }] },
        user: req.user,
        organizations
      });
    }

    // optional org/module inputs from the form
    const orgId = req.body.orgId && mongoose.isValidObjectId(req.body.orgId) ? mongoose.Types.ObjectId(req.body.orgId) : null;
    const moduleName = String(req.body.module || "general").trim().toLowerCase();

    // now reuse your parsing + insert logic (call parseComprehensionFromText and parseQuestionsFromText)
    // (You can copy the parsing + DB insert blocks you already have here.)
    // For brevity: iterate texts[], attempt comprehension parse first, fallback to questions parse.
    // ... (your existing parsing + insert code goes here) ...

    // After processing, render results (don't forget to fetch organizations for the dropdown)
    const organizations = await Organization.find().sort({ name: 1 }).lean().exec();
    return res.render("admin/lms_import", { title: "Import Results", result: summary, user: req.user, organizations });

  } catch (err) {
    console.error("Import failed:", err && (err.stack || err));
    return res.status(500).send("Import failed: " + (err.message || String(err)));
  }
});


function normalizeForCompare(s) {
  return String(s || "").replace(/[^a-z0-9]+/gi, " ").trim().toLowerCase();
}

export default router;
