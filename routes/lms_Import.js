// routes/admin/lms_import.js
import { Router } from "express";
import multer from "multer";
import mongoose from "mongoose";
import ensureAuth from "../../middleware/authGuard.js"; // adjust if your export style differs
import QuizQuestion from "../../models/quizQuestion.js";
import { getAdminSet } from "../admin.js"; // optional helper if you have it

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

// GET upload form
router.get("/import", (req, res) => {
  // require auth & admin
  if (!(req.isAuthenticated && req.isAuthenticated && req.isAuthenticated())) {
    return res.redirect("/auth/google");
  }
  // check admin
  const email = (req.user && (req.user.email || req.user.username) || "").toLowerCase();
  const ADMIN_SET = new Set(
    (process.env.ADMIN_EMAILS || "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  );
  if (!email || !ADMIN_SET.has(email)) {
    return res.status(403).send("Forbidden — admin only");
  }

  return res.render("admin/lms_import", { title: "Import LMS Questions", user: req.user });
});

/**
 * POST /admin/lms/import
 * Accepts form-data 'file' (text/plain) or a JSON body 'text' to parse directly.
 * Supports two formats:
 *  - Comprehension files: passage, then a delimiter line of dashes (---...), then question blocks.
 *  - Regular question files: blocks of single questions (existing behavior).
 */
router.post("/import", upload.single("file"), async (req, res) => {
  try {
    // require auth & admin
    if (!(req.isAuthenticated && req.isAuthenticated && req.isAuthenticated())) {
      return res.status(401).json({ error: "Authentication required" });
    }
    const email = (req.user && (req.user.email || req.user.username) || "").toLowerCase();
    const ADMIN_SET = new Set(
      (process.env.ADMIN_EMAILS || "")
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean)
    );
    if (!email || !ADMIN_SET.has(email)) {
      return res.status(403).json({ error: "Forbidden — admin only" });
    }

    let rawText = "";

    if (req.file && req.file.buffer) {
      rawText = req.file.buffer.toString("utf8");
    } else if (req.body && req.body.text) {
      rawText = String(req.body.text);
    } else {
      return res.status(400).json({ error: "No file or text provided" });
    }

    // read optional form fields for org/module
    const orgId = req.body.orgId && mongoose.isValidObjectId(req.body.orgId) ? mongoose.Types.ObjectId(req.body.orgId) : null;
    const moduleName = String(req.body.module || "general").trim().toLowerCase();

    // First: try comprehension parser (passage separated by a dashed line like "----")
    const { parsedComprehensions = [], errors: compErrors = [] } = parseComprehensionFromText(rawText);

    if (parsedComprehensions && parsedComprehensions.length) {
      const insertedParents = [];
      const combinedErrors = [...compErrors];

      for (const comp of parsedComprehensions) {
        try {
          // insert child question docs with org/module metadata
          const childDocs = comp.questions.map(q => ({
            text: q.text,
            choices: (q.choices || []).map(c => (typeof c === "string" ? c : (c.text || String(c)))),
            answerIndex: typeof q.answerIndex === "number" ? q.answerIndex : 0, // ensure required field present
            tags: q.tags || [],
            difficulty: q.difficulty || "medium",
            instructions: q.instructions || "",
            source: "import",
            organization: orgId,
            module: moduleName,
            createdAt: new Date()
          }));

          const insertedChildren = await QuizQuestion.insertMany(childDocs, { ordered: true });

          const childIds = insertedChildren.map(d => d._id);

          // create parent comprehension doc
          const parentDoc = {
            text: (comp.passage || "").split("\n").slice(0, 1).join(" ").slice(0, 120) || "Comprehension passage",
            choices: [], // parent has no choices
            answerIndex: 0, // placeholder so schema requirements are satisfied
            type: "comprehension",
            passage: comp.passage,
            questionIds: childIds,
            tags: comp.tags || [],
            source: "import",
            organization: orgId,
            module: moduleName,
            createdAt: new Date()
          };

          // create parent (if model/schema doesn't accept some fields they will be ignored;
          // ideally your QuizQuestion schema includes `type`, `passage`, `questionIds`)
          const insertedParent = await QuizQuestion.create(parentDoc);
          insertedParents.push(insertedParent);

          // help future diagnostics: add tag linking children to parent
          try {
            await QuizQuestion.updateMany({ _id: { $in: childIds } }, { $addToSet: { tags: `comprehension-${insertedParent._id}` } }).exec();
          } catch (tErr) {
            // non-fatal
            console.warn("[import] tagging children failed", tErr && tErr.message);
          }
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

      return res.render("admin/lms_import", { title: "Import Results", result: summary, user: req.user });
    }

    // Fallback: use existing single-question parser
    const { parsed, errors } = parseQuestionsFromText(rawText);

    if (!parsed.length) {
      return res.render("admin/lms_import", { title: "Import Results", result: { inserted: 0, parsed: 0, errors }, user: req.user });
    }

    // Insert into DB but mark source 'import' and attach org/module
    const toInsert = parsed.map(p => ({
      text: p.text,
      choices: (p.choices || []).map(c => (typeof c === "string" ? c : (c.text || String(c)))),
      answerIndex: typeof p.answerIndex === "number" ? p.answerIndex : 0, // ensure required
      tags: p.tags || [],
      difficulty: p.difficulty || "medium",
      instructions: p.instructions || "",
      source: "import",
      organization: orgId,
      module: moduleName,
      createdAt: new Date()
    }));

    const inserted = await QuizQuestion.insertMany(toInsert, { ordered: true });

    const summary = {
      parsed: parsed.length,
      inserted: inserted.length,
      errors
    };

    return res.render("admin/lms_import", { title: "Import Results", result: summary, user: req.user });
  } catch (err) {
    console.error("Import failed:", err);
    return res.status(500).send("Import failed: " + (err.message || String(err)));
  }
});

export default router;

/* ------------------------------------------------------------------
 * Parser helpers
 * ------------------------------------------------------------------ */

/**
 * parseComprehensionFromText(raw)
 * - expects a passage at top, then a delimiter line of dashes (3+), then question blocks
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
 * Optional file-level 'Instructions:' or question-level 'Instructions:' lines are supported.
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
      // e.g. "1. Taking responsibility in a team means:"
      const qMatch = block.match(/^\s*(?:\d+\s*[\.\)]\s*)?(.+?)(?=\n|$)/);
      if (!qMatch) {
        errors.push({ block: block.slice(0, 120), reason: "No question line found" });
        continue;
      }
      let qText = qMatch[1].trim();

      // Now extract choices a) b) c) d)
      // Find all lines beginning with a) or a. or a)
      const choiceRegex = /^[ \t]*([a-dA-D])[\.\)]\s*(.+)$/gm;
      const choices = [];
      let m;
      while ((m = choiceRegex.exec(block)) !== null) {
        choices.push(m[2].trim());
      }

      if (choices.length < 2) {
        // maybe choices are inline separated by newlines but without labels; attempt other patterns
        // Look for lines that look like "a) ..." etc case-insensitive already handled
        errors.push({ question: qText, reason: `Expected labelled choices a)-d). Found ${choices.length}.` });
        continue;
      }

      // find answer line: "✅ Correct Answer:" or "Correct Answer:" or "Answer:"
      let answerIndex = -1;
      let ansMatch = block.match(/✅\s*Correct Answer\s*:\s*(.+)$/im) || block.match(/Correct Answer\s*:\s*(.+)$/im) || block.match(/Answer\s*:\s*(.+)$/im);
      if (ansMatch) {
        const ansText = ansMatch[1].trim();
        // If answer text begins with letter like "b)" or "b." or "b)"
        const letterMatch = ansText.match(/^([a-dA-D])[\.\)]?/);
        if (letterMatch) {
          answerIndex = choiceLetterToIndex(letterMatch[1]);
        } else {
          // try to match by choice text content (find nearest match in choices)
          const found = choices.findIndex(c => {
            // compare normalized
            return normalizeForCompare(c) === normalizeForCompare(ansText) || c.toLowerCase().startsWith(ansText.toLowerCase()) || ansText.toLowerCase().startsWith(c.toLowerCase());
          });
          if (found >= 0) answerIndex = found;
          else {
            // maybe ansText contains a letter inside parentheses
            const insideLetter = ansText.match(/\(([a-dA-D])\)/);
            if (insideLetter) answerIndex = choiceLetterToIndex(insideLetter[1]);
          }
        }
      } else {
        // No explicit answer found — attempt to find a trailing line like "✅ Correct Answer: c) text"
        // If still not found, skip as parse error
      }

      if (answerIndex < 0 || answerIndex >= choices.length) {
        errors.push({ question: qText, reason: `Could not determine correct answer from block. Choices found: ${choices.length}` });
        continue;
      }

      // optional difficulty/tags: not required, try to detect "[easy]" or "difficulty: easy" or "tags: x,y"
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

      // final build
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
