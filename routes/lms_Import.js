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
router.post("/import", ensureAuth, ensureAdmin, upload.array("files", 6), async (req, res) => {
  try {
    // Collect text from either uploaded files OR the textarea 'text' (fallback)
    const texts = [];

    // multer puts files in req.files when using upload.array(...)
    if (Array.isArray(req.files) && req.files.length) {
      for (const f of req.files) {
        // only accept text-like files
        const buf = f.buffer ? f.buffer.toString("utf8") : "";
        if (!buf) continue;
        texts.push({ filename: f.originalname || "file", text: buf });
      }
    }

    // also accept named fields commonly used: 'passageFile' + 'file' — multer.array will include them in req.files
    // If nothing uploaded but textarea supplied, use that
    if (!texts.length && req.body && req.body.text && String(req.body.text).trim()) {
      texts.push({ filename: "pasted", text: String(req.body.text) });
    }

    // legacy: if user posted single file using single-field middleware (req.file)
    if (!texts.length && req.file && req.file.buffer) {
      texts.push({ filename: req.file.originalname || "file", text: req.file.buffer.toString("utf8") });
    }

    if (!texts.length) {
      const organizations = await Organization.find().sort({ name: 1 }).lean().exec();
      return res.render("admin/lms_import", {
        title: "Import Results",
        result: { parsed: 0, inserted: 0, errors: [{ reason: "No file or text provided" }] },
        user: req.user,
        organizations
      });
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
      const rawText = String(item.text || "");

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

/* ------------------------------------------------------------------
 * Parser helpers (kept robust to common formats)
 * ------------------------------------------------------------------ */

/**
 * parseComprehensionFromText(raw)
 * - expects a passage at top, then a delimiter line of dashes (---...), then question blocks
 * - returns { parsedComprehensions: [ { passage, questions: [ { text, choices, answerIndex, tags, difficulty, instructions } ] } ], errors: [...] }
 */
function parseComprehensionFromText(raw) {
  const errors = [];
  const parsedComprehensions = [];

  if (!raw || typeof raw !== "string") return { parsedComprehensions, errors };

  // normalize newlines
  const text = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  // split on a line that contains 3+ dashes (and optional spaces)
  const parts = text.split(/^\s*-{3,}\s*$/m).map(p => p.trim()).filter(Boolean);

  if (parts.length < 2) {
    // no delimiter found — not a comprehension formatted file
    return { parsedComprehensions: [], errors };
  }

  // Treat first part as passage, the rest joined as quiz block(s)
  const passage = parts[0];
  const quizBlock = parts.slice(1).join("\n\n");

  // helper: letter -> index (a..z)
  const letterToIndex = (letter) => {
    if (!letter) return -1;
    const m = letter.trim().toLowerCase().match(/^([a-z])/);
    if (!m) return -1;
    return "abcdefghijklmnopqrstuvwxyz".indexOf(m[1]);
  };

  // split quizBlock into question blocks separated by two or more newlines
  const qBlocks = quizBlock.split(/\n{2,}/).map(b => b.trim()).filter(Boolean);

  const questions = [];

  for (const block of qBlocks) {
    try {
      // find question line (optional leading number)
      const qMatch = block.match(/^\s*(?:\d+\s*[\.\)]\s*)?(.+?)(?=\n|$)/);
      if (!qMatch) {
        errors.push({ block: block.slice(0, 120), reason: "No question line found" });
        continue;
      }
      const qText = qMatch[1].trim();

      // find labeled choices (a) b) c) ... )
      const choiceRegex = /^[ \t]*([a-zA-Z])[\.\)]\s*(.+)$/gm;
      const choices = [];
      let m;
      while ((m = choiceRegex.exec(block)) !== null) {
        choices.push(m[2].trim());
      }

      if (choices.length < 2) {
        errors.push({ question: qText, reason: `Expected labelled choices. Found ${choices.length}.` });
        continue;
      }

      // find answer line
      let answerIndex = -1;
      const ansMatch =
        block.match(/✅\s*Correct Answer\s*:\s*(.+)$/im) ||
        block.match(/Correct Answer\s*:\s*(.+)$/im) ||
        block.match(/Answer\s*:\s*(.+)$/im);

      if (ansMatch) {
        const ansText = ansMatch[1].trim();
        const lm = ansText.match(/^([a-zA-Z])[\.\)]?/);
        if (lm) {
          answerIndex = letterToIndex(lm[1]);
        } else {
          // try matching by normalized text
          const normalize = s => String(s||"").replace(/[^a-z0-9]+/gi," ").trim().toLowerCase();
          const found = choices.findIndex(c => normalize(c) === normalize(ansText) || c.toLowerCase().startsWith(ansText.toLowerCase()) || ansText.toLowerCase().startsWith(c.toLowerCase()));
          if (found >= 0) answerIndex = found;
        }
      }

      if (answerIndex < 0 || answerIndex >= choices.length) {
        errors.push({ question: qText, reason: "Could not determine correct answer" });
        continue;
      }

      // optional difficulty/tags/instructions
      let difficulty = "medium";
      const diffMatch = block.match(/difficulty\s*[:\-]\s*(easy|medium|hard)/i) || block.match(/\[(easy|medium|hard)\]/i);
      if (diffMatch) difficulty = diffMatch[1].toLowerCase();

      const tags = [];
      const tagMatch = block.match(/tags?\s*[:\-]\s*([a-zA-Z0-9,\s\-]+)/i);
      if (tagMatch) {
        tagMatch[1].split(",").map(t => t.trim()).filter(Boolean).forEach(t => tags.push(t));
      }

      let instructions = "";
      const instrQ = block.match(/Instructions?:\s*([\s\S]+?)$/i);
      if (instrQ) instructions = instrQ[1].trim();

      questions.push({
        text: qText,
        choices,
        answerIndex,
        tags,
        difficulty,
        instructions
      });
    } catch (e) {
      errors.push({ block: block.slice(0, 120), reason: e.message || String(e) });
    }
  }

  if (questions.length) {
    parsedComprehensions.push({
      passage,
      questions
    });
  } else {
    errors.push({ reason: "No valid sub-questions parsed from quiz block." });
  }

  return { parsedComprehensions, errors };
}

/* ------------------------------------------------------------------
 * Existing single-question parser (kept mostly intact)
 * ------------------------------------------------------------------ */

/**
 * Parser: Accepts raw text and returns { parsed: [ { text, choices, answerIndex, tags, difficulty, instructions } ], errors: [...] }
 */
function parseQuestionsFromText(raw) {
  const errors = [];
  const parsed = [];

  if (!raw || typeof raw !== "string") return { parsed, errors };

  // Normalize line endings:
  const text = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  // Optional: If file contains a top-level "Instructions:" section, capture it
  let globalInstructions = "";
  const instrMatch = text.match(/(?:^|\n)Instructions:\s*([\s\S]*?)(?=\n\s*\n|$)/i);
  if (instrMatch) {
    globalInstructions = instrMatch[1].trim();
  }

  // Split into blocks separated by two or more newlines
  const blocks = text.split(/\n{2,}/).map(b => b.trim()).filter(Boolean);

  // Helper to extract a choice label -> index
  const choiceLetterToIndex = (letter) => {
    if (!letter) return -1;
    const m = letter.trim().toLowerCase().match(/^([a-d])/);
    if (!m) return -1;
    return "abcd".indexOf(m[1]);
  };

  for (const block of blocks) {
    try {
      // skip pure "Instructions" block if it was captured already
      if (/^Instructions?:/i.test(block)) continue;

      // Try to find the question line (start with optional number and dot)
      const qMatch = block.match(/^\s*(?:\d+\s*[\.\)]\s*)?(.+?)(?=\n|$)/);
      if (!qMatch) {
        errors.push({ block: block.slice(0, 120), reason: "No question line found" });
        continue;
      }
      let qText = qMatch[1].trim();

      // Now extract choices a) b) c) d)
      const choiceRegex = /^[ \t]*([a-dA-D])[\.\)]\s*(.+)$/gm;
      const choices = [];
      let m;
      while ((m = choiceRegex.exec(block)) !== null) {
        choices.push(m[2].trim());
      }

      if (choices.length < 2) {
        errors.push({ question: qText, reason: `Expected labelled choices a)-d). Found ${choices.length}.` });
        continue;
      }

      // find answer line
      let answerIndex = -1;
      let ansMatch = block.match(/✅\s*Correct Answer\s*:\s*(.+)$/im) || block.match(/Correct Answer\s*:\s*(.+)$/im) || block.match(/Answer\s*:\s*(.+)$/im);
      if (ansMatch) {
        const ansText = ansMatch[1].trim();
        const letterMatch = ansText.match(/^([a-dA-D])[\.\)]?/);
        if (letterMatch) {
          answerIndex = choiceLetterToIndex(letterMatch[1]);
        } else {
          const found = choices.findIndex(c => {
            return normalizeForCompare(c) === normalizeForCompare(ansText) || c.toLowerCase().startsWith(ansText.toLowerCase()) || ansText.toLowerCase().startsWith(c.toLowerCase());
          });
          if (found >= 0) answerIndex = found;
          else {
            const insideLetter = ansText.match(/\(([a-dA-D])\)/);
            if (insideLetter) answerIndex = choiceLetterToIndex(insideLetter[1]);
          }
        }
      }

      if (answerIndex < 0 || answerIndex >= choices.length) {
        errors.push({ question: qText, reason: `Could not determine correct answer from block. Choices found: ${choices.length}` });
        continue;
      }

      // optional difficulty/tags: not required
      let difficulty = "medium";
      const diffMatch = block.match(/difficulty\s*[:\-]\s*(easy|medium|hard)/i) || block.match(/\[(easy|medium|hard)\]/i);
      if (diffMatch) difficulty = diffMatch[1].toLowerCase();

      const tags = [];
      const tagMatch = block.match(/tags?\s*[:\-]\s*([a-zA-Z0-9,\s\-]+)/i);
      if (tagMatch) {
        tagMatch[1].split(",").map(t => t.trim()).filter(Boolean).forEach(t => tags.push(t));
      }

      // optional per-question instructions
      let instructions = "";
      const instrQ = block.match(/Instructions?:\s*([\s\S]+?)$/i);
      if (instrQ) instructions = instrQ[1].trim();

      parsed.push({
        text: qText,
        choices,
        answerIndex,
        tags,
        difficulty,
        instructions: instructions || globalInstructions || ""
      });

    } catch (e) {
      errors.push({ block: block.slice(0, 120), reason: e.message || String(e) });
    }
  }

  return { parsed, errors };
}

function normalizeForCompare(s) {
  return String(s || "").replace(/[^a-z0-9]+/gi, " ").trim().toLowerCase();
}

export default router;
