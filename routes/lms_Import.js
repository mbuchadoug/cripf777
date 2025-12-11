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
 * Accepts form-data 'file' (text/plain) or a JSON body 'text' to parse directly.
 * Supports comprehension format (passage + --- delimiter + questions) and single-question blocks.
 */
// replace your existing router.post("/import", ...) with this
// routes/admin/lms_import.js (only the POST /admin/lms/import part shown - replace existing POST handler)
router.post("/import", ensureAuth, ensureAdmin, upload.array("files", 6), async (req, res) => {
  try {
    // Collect text from either uploaded files OR the textarea 'text' (fallback)
    const texts = [];

    // multer puts files in req.files when using upload.array(...)
    if (Array.isArray(req.files) && req.files.length) {
      for (const f of req.files) {
        // ensure we only accept text files
        const mimetype = (f.mimetype || "").toLowerCase();
        const name = String(f.originalname || "file");
        const buf = f.buffer ? f.buffer.toString("utf8") : "";
        if (!buf) continue;
        texts.push({ filename: name, text: buf });
      }
    }

    // also accept a single pasted text in textarea field 'text' (if supplied)
    if (!texts.length && req.body && req.body.text) {
      texts.push({ filename: "pasted", text: String(req.body.text) });
    }

    if (!texts.length) {
      // if user sent a single-file using field name 'file' (legacy) try req.file
      if (req.file && req.file.buffer) {
        texts.push({ filename: req.file.originalname || "file", text: req.file.buffer.toString("utf8") });
      }
    }

    if (!texts.length) {
      const organizations = await Organization.find().sort({ name: 1 }).lean().exec();
      return res.render("admin/lms_import", { title: "Import Results", result: { parsed: 0, inserted: 0, errors: [{ reason: "No file or text provided" }] }, user: req.user, organizations });
    }

    // optional org/module inputs from the form
    const orgId = req.body.orgId && mongoose.isValidObjectId(req.body.orgId) ? mongoose.Types.ObjectId(req.body.orgId) : null;
    const moduleName = String(req.body.module || "general").trim().toLowerCase();

    let globalParsed = 0;
    let globalInsertedParents = 0;
    let globalInsertedChildren = 0;
    const allErrors = [];

    // process each uploaded text file independently
    for (const item of texts) {
      const rawText = item.text || "";

      // First try comprehension parser (passage + --- delimiter)
      const { parsedComprehensions = [], errors: compErrors = [] } = parseComprehensionFromText(rawText);

      if (compErrors && compErrors.length) {
        compErrors.forEach(e => allErrors.push({ file: item.filename, ...e }));
      }

      if (parsedComprehensions && parsedComprehensions.length) {
        // for each comprehension found in the file
        for (const comp of parsedComprehensions) {
          try {
            // insert children as standard question docs
            const childDocs = comp.questions.map(q => ({
              text: q.text,
              choices: (q.choices || []).map(c => ({ text: c })),
              correctIndex: typeof q.answerIndex === "number" ? q.answerIndex : 0,
              tags: q.tags || [],
              difficulty: q.difficulty || "medium",
              source: "import",
              organization: orgId,
              module: moduleName,
              raw: '',
              createdAt: new Date()
            }));

            const insertedChildren = await Question.insertMany(childDocs, { ordered: true });
            const childIds = insertedChildren.map(d => d._id);

            // create parent comprehension doc in same Question collection
            const parentDoc = {
              text: (comp.passage || "").split("\n").slice(0, 1).join(" ").slice(0, 120) || "Comprehension passage",
              type: "comprehension",
              passage: comp.passage,
              questionIds: childIds,
              tags: comp.tags || [],
              source: "import",
              organization: orgId,
              module: moduleName,
              createdAt: new Date()
            };

            const insertedParent = await Question.create(parentDoc);

            // optional: tag children so we can find them easily later
            await Question.updateMany({ _id: { $in: childIds } }, { $addToSet: { tags: `comprehension-${insertedParent._id}` } }).exec();

            globalParsed++;
            globalInsertedParents++;
            globalInsertedChildren += childIds.length;
          } catch (e) {
            console.error("[import comprehension insert] failed:", e && (e.stack || e));
            allErrors.push({ file: item.filename, reason: "DB insert failed for a comprehension", error: String(e && e.message) });
          }
        }

        // done with this file (go next file)
        continue;
      }

      // Fallback: parse as regular single-question blocks
      const { parsed, errors } = parseQuestionsFromText(rawText);
      if (errors && errors.length) errors.forEach(e => allErrors.push({ file: item.filename, ...e }));

      if (!parsed.length) {
        // nothing parsed from this file
        continue;
      }

      // insert parsed single questions
      const toInsert = parsed.map(p => ({
        text: p.text,
        choices: (p.choices || []).map(c => ({ text: c })),
        correctIndex: typeof p.answerIndex === "number" ? p.answerIndex : 0,
        tags: p.tags || [],
        difficulty: p.difficulty || "medium",
        instructions: p.instructions || "",
        source: "import",
        organization: orgId,
        module: moduleName,
        raw: '',
        createdAt: new Date()
      }));

      try {
        const inserted = await Question.insertMany(toInsert, { ordered: true });
        globalParsed += parsed.length;
        globalInsertedChildren += inserted.length;
      } catch (e) {
        console.error("[import single insert] failed:", e && (e.stack || e));
        allErrors.push({ file: item.filename, reason: "DB insert failed for single questions", error: String(e && e.message) });
      }
    } // end for files

    const summary = {
      parsedFiles: texts.length,
      parsedItems: globalParsed,
      insertedParents: globalInsertedParents,
      insertedChildren: globalInsertedChildren,
      errors: allErrors
    };

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
