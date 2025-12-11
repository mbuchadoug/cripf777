// routes/admin/lms_import.js
import { Router } from "express";
import multer from "multer";
import mongoose from "mongoose";
import { ensureAuth } from "../../middleware/authGuard.js"; // adjust if your export differs
import Question from "../../models/question.js";
import Organization from "../../models/organization.js";

const router = Router();

// multer memory storage (we only need the buffer)
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 1024 * 1024 * 8 } }); // 8MB

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
 *
 * Behavior:
 * - Accepts uploaded files (any field names) or textarea `text`.
 * - If `passageFile` + `file` are uploaded, the passage is paired with the questions file.
 * - If a file contains a passage followed by a delimiter line of 3+ dashes (`---`), it will be parsed as comprehension.
 * - Child questions are inserted as normal Question docs; a parent doc (type: 'comprehension') is saved with questionIds pointing to children.
 *
 * Note: This uses upload.any() to avoid Multer "Unexpected field" problems while iterating. After confirming everything works,
 * you can switch to `upload.fields([{ name: 'passageFile' }, { name: 'file' }])` to strictly allow only those inputs.
 */
router.post("/import", ensureAuth, ensureAdmin, upload.any(), async (req, res) => {
  try {
    // Debug - server logs to help track what was uploaded
    console.log("[IMPORT] req.files count:", Array.isArray(req.files) ? req.files.length : 0);
    if (req.files) {
      req.files.forEach((f, i) => console.log(`[IMPORT] file[${i}] field=${f.fieldname} name=${f.originalname} size=${f.size}`));
    }
    console.log("[IMPORT] body keys:", Object.keys(req.body || {}));

    // collect text sources from uploaded files or textarea
    // We'll produce an array of { filename, text } to process independently
    const texts = [];

    // If multer.any() used, req.files is an array
    if (Array.isArray(req.files) && req.files.length) {
      // Priority: if there's a pair passageFile + file, build a combined entry for that pair
      const passageFileEntry = req.files.find(f => f.fieldname === "passageFile");
      const questionFileEntries = req.files.filter(f => (f.fieldname === "file" || f.fieldname === "files" || f.fieldname === "questions" || f.fieldname === "qfile"));

      if (passageFileEntry && questionFileEntries.length) {
        const passageText = passageFileEntry.buffer ? passageFileEntry.buffer.toString("utf8") : "";
        for (const qf of questionFileEntries) {
          const qtext = qf.buffer ? qf.buffer.toString("utf8") : "";
          if (!qtext.trim()) continue;
          // combine: passage + delimiter + questions
          texts.push({ filename: `${passageFileEntry.originalname}+${qf.originalname}`, text: passageText + "\n\n---\n\n" + qtext });
        }
      }

      // Add any standalone files that weren't part of a pairing
      for (const f of req.files) {
        // if we already used the pair above skip those specific files
        const wasUsedInPair = passageFileEntry && (f === passageFileEntry || questionFileEntries.includes(f));
        if (wasUsedInPair) continue;

        const buf = f.buffer ? f.buffer.toString("utf8") : "";
        if (!buf.trim()) continue;
        texts.push({ filename: f.originalname || f.fieldname, text: buf });
      }
    }

    // also accept textarea 'text' if provided and no files present
    if (!texts.length && req.body && req.body.text && String(req.body.text).trim()) {
      texts.push({ filename: "pasted", text: String(req.body.text) });
    }

    // If still nothing, render error
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

    // global counters and error collection
    let parsedCount = 0;
    let insertedParents = 0;
    let insertedChildren = 0;
    const allErrors = [];

    // iterate each uploaded/pasted text
    for (const item of texts) {
      const rawText = item.text || "";
      if (!rawText.trim()) {
        allErrors.push({ file: item.filename, reason: "Empty content" });
        continue;
      }

      // Try comprehension parser first
      const { parsedComprehensions = [], errors: compErrors = [] } = parseComprehensionFromText(rawText);
      if (compErrors && compErrors.length) compErrors.forEach(e => allErrors.push({ file: item.filename, ...e }));

      if (parsedComprehensions && parsedComprehensions.length) {
        // for each comprehension found in this file
        for (const comp of parsedComprehensions) {
          try {
            // child question docs (standard question shape)
            const childDocs = (comp.questions || []).map(q => ({
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

            const inserted = await Question.insertMany(childDocs, { ordered: true });
            const childIds = inserted.map(d => d._id);

            // parent comprehension doc in same collection
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

            // optional: tag children with parent id for easy lookup later
            await Question.updateMany({ _id: { $in: childIds } }, { $addToSet: { tags: `comprehension-${insertedParent._id}` } }).exec();

            parsedCount++;
            insertedParents++;
            insertedChildren += childIds.length;
          } catch (e) {
            console.error("[IMPORT] comprehension insert failed:", e && (e.stack || e));
            allErrors.push({ file: item.filename, reason: "DB insert failed for comprehension", error: String(e && e.message) });
          }
        }

        // done with this item
        continue;
      }

      // fallback: parse single-question blocks
      const { parsed, errors } = parseQuestionsFromText(rawText);
      if (errors && errors.length) errors.forEach(e => allErrors.push({ file: item.filename, ...e }));

      if (!parsed.length) {
        // nothing parsed from this file — move on
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
        parsedCount += parsed.length;
        insertedChildren += inserted.length;
      } catch (e) {
        console.error("[IMPORT] single-question insert failed:", e && (e.stack || e));
        allErrors.push({ file: item.filename, reason: "DB insert failed for single questions", error: String(e && e.message) });
      }
    } // end for texts

    const summary = {
      parsedFiles: texts.length,
      parsedItems: parsedCount,
      insertedParents,
      insertedChildren,
      errors: allErrors
    };

    const organizations = await Organization.find().sort({ name: 1 }).lean().exec();
    return res.render("admin/lms_import", { title: "Import Results", result: summary, user: req.user, organizations });
  } catch (err) {
    console.error("[IMPORT] error:", err && (err.stack || err));
    return res.status(500).send("Import failed: " + (err.message || String(err)));
  }
});

/* ------------------------------------------------------------------
 * Parser helpers (comprehension + single-question parser)
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
          const normalize = s => String(s || "").replace(/[^a-z0-9]+/gi, " ").trim().toLowerCase();
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
 *
 * Expected block format (per question):
 *
 * 1. Question text...
 * a) Choice A
 * b) Choice B
 * c) Choice C
 * d) Choice D
 * ✅ Correct Answer: b) Stepping in where needed, even beyond your direct role.
 *
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
  } // end for blocks

  return { parsed, errors };
}

function normalizeForCompare(s) {
  return String(s || "").replace(/[^a-z0-9]+/gi, " ").trim().toLowerCase();
}

export default router;
