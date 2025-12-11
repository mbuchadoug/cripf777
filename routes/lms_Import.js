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
router.post(
  "/import",
  ensureAuth,
  ensureAdmin,
  // accept both 'file' and 'passageFile' (each optional, max 1)
  upload.fields([{ name: "file", maxCount: 1 }, { name: "passageFile", maxCount: 1 }]),
  async (req, res) => {
    try {
      let rawText = "";

      // If user uploaded separate passageFile + questions file, join them
      const files = req.files || {}; // multer puts files here when using upload.fields
      const questionsFile = Array.isArray(files.file) && files.file[0] ? files.file[0] : null;
      const passageFile = Array.isArray(files.passageFile) && files.passageFile[0] ? files.passageFile[0] : null;

      if (questionsFile && questionsFile.buffer) {
        rawText = questionsFile.buffer.toString("utf8");
      } else if (req.body && req.body.text) {
        rawText = String(req.body.text);
      }

      // If a passage file was uploaded, prepend the passage and a delimiter so parsers see it
      if (passageFile && passageFile.buffer) {
        const passage = passageFile.buffer.toString("utf8").trim();
        if (rawText && rawText.trim()) {
          // If both present, assume questions are in rawText and passage in passageFile
          rawText = passage + "\n\n---\n\n" + rawText;
        } else {
          // If no questions file/text but only passage file (unlikely), keep passage
          rawText = passage;
        }
      }

      if (!rawText || !rawText.trim()) {
        return res.status(400).json({ error: "No file or text provided" });
      }

      // optional org/module inputs from the form
      const orgId = req.body.orgId && mongoose.isValidObjectId(req.body.orgId) ? mongoose.Types.ObjectId(req.body.orgId) : null;
      const moduleName = String(req.body.module || "general").trim().toLowerCase();

      // Try comprehension parser first
      const { parsedComprehensions = [], errors: compErrors = [] } = parseComprehensionFromText(rawText);

      if (parsedComprehensions && parsedComprehensions.length) {
        const insertedParents = [];
        const combinedErrors = [...compErrors];

        for (const comp of parsedComprehensions) {
          try {
            // prepare children for Question model
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

            // create parent comprehension doc in the same Question collection
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
            insertedParents.push(insertedParent);

            // tag children with a link to parent for easy lookup (optional)
            await Question.updateMany({ _id: { $in: childIds } }, { $addToSet: { tags: `comprehension-${insertedParent._id}` } }).exec();
          } catch (e) {
            console.error("[import comprehension insert] failed:", e && (e.stack || e));
            combinedErrors.push({ reason: "DB insert failed for a comprehension", error: String(e && e.message) });
          }
        }

        const summary = {
          parsed: parsedComprehensions.length,
          insertedParents: insertedParents.length,
          errors: combinedErrors
        };

        const organizations = await Organization.find().sort({ name: 1 }).lean().exec();
        return res.render("admin/lms_import", { title: "Import Results", result: summary, user: req.user, organizations });
      }

      // Fallback to single-question parser
      const { parsed, errors } = parseQuestionsFromText(rawText);

      if (!parsed.length) {
        const organizations = await Organization.find().sort({ name: 1 }).lean().exec();
        return res.render("admin/lms_import", { title: "Import Results", result: { inserted: 0, parsed: 0, errors }, user: req.user, organizations });
      }

      // Insert parsed single questions into Question collection
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

      const inserted = await Question.insertMany(toInsert, { ordered: true });

      const summary = {
        parsed: parsed.length,
        inserted: inserted.length,
        errors
      };

      const organizations = await Organization.find().sort({ name: 1 }).lean().exec();
      return res.render("admin/lms_import", { title: "Import Results", result: summary, user: req.user, organizations });
    } catch (err) {
      console.error("Import failed:", err && (err.stack || err));
      return res.status(500).send("Import failed: " + (err.message || String(err)));
    }
  }
);


function normalizeForCompare(s) {
  return String(s || "").replace(/[^a-z0-9]+/gi, " ").trim().toLowerCase();
}
