// routes/admin/lms_import.js
import { Router } from "express";
import multer from "multer";
import mongoose from "mongoose";
import ensureAuth from "../../middleware/authGuard.js"; // adjust import if style differs
import Question from "../../models/question.js";
import Organization from "../../models/organization.js";

const router = Router();

// multer memory storage (we only need the buffer)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 1024 * 1024 * 8 } // 8MB
});

/* simple internal ensureAdmin helper (replace with your own if you have one) */
function ensureAdmin(req, res, next) {
  try {
    const email = (req.user && (req.user.email || req.user.username) || "").toLowerCase();
    const ADMIN_SET = new Set(
      (process.env.ADMIN_EMAILS || "")
        .split(",")
        .map(s => s.trim().toLowerCase())
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

/* GET form */
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
 * Accept uploaded files (any field names) or textarea 'text'
 */
router.post("/import", ensureAuth, ensureAdmin, upload.any(), async (req, res) => {
  try {
    // Debug logs - helpful during development
    console.log("[IMPORT] req.files count:", Array.isArray(req.files) ? req.files.length : 0);
    if (req.files && req.files.length) {
      req.files.forEach((f, i) => console.log(`[IMPORT] file[${i}] field=${f.fieldname} name=${f.originalname} size=${f.size}`));
    }
    console.log("[IMPORT] body keys:", Object.keys(req.body || {}));

    // collect text sources from uploaded files or textarea
    const texts = [];

    // if passageFile + questions file pairing present, combine them (preferred)
    if (Array.isArray(req.files) && req.files.length) {
      const passageFile = req.files.find(f => f.fieldname === "passageFile");
      const questionFiles = req.files.filter(f => ["file", "files", "questions", "qfile"].includes(f.fieldname));

      if (passageFile && questionFiles.length) {
        const passageText = passageFile.buffer ? passageFile.buffer.toString("utf8") : "";
        for (const qf of questionFiles) {
          const qText = qf.buffer ? qf.buffer.toString("utf8") : "";
          if (!qText.trim()) continue;
          // combine passage and questions with delimiter so parser handles it
          texts.push({
            filename: `${passageFile.originalname}+${qf.originalname}`,
            text: passageText + "\n\n---\n\n" + qText
          });
        }
      }

      // add any standalone uploaded files that weren't used in pair
      for (const f of req.files) {
        const wasUsed = passageFile && (f === passageFile || questionFiles.includes(f));
        if (wasUsed) continue;
        const buf = f.buffer ? f.buffer.toString("utf8") : "";
        if (!buf || !buf.trim()) continue;
        texts.push({ filename: f.originalname || f.fieldname, text: buf });
      }
    }

    // fallback: accept textarea 'text'
    if (!texts.length && req.body && req.body.text && String(req.body.text).trim()) {
      texts.push({ filename: "pasted", text: String(req.body.text) });
    }

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

    // global counters and collector
    let parsedCount = 0;
    let insertedParents = 0;
    let insertedChildren = 0;
    const allErrors = [];
    const previewSnippets = [];

    // process each uploaded/pasted text independently
    for (const item of texts) {
      const rawText = item.text || "";
      if (!rawText.trim()) {
        allErrors.push({ file: item.filename, reason: "Empty content" });
        continue;
      }

      // First attempt comprehension parse (passage + delimiter)
      const { parsedComprehensions = [], errors: compErrors = [] } = parseComprehensionFromText(rawText);
      if (compErrors && compErrors.length) compErrors.forEach(e => allErrors.push({ file: item.filename, ...e }));

      if (parsedComprehensions && parsedComprehensions.length) {
        // for each comprehension in the file (usually 1)
        for (const comp of parsedComprehensions) {
          try {
            // create child docs for each sub-question
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

            // create parent comprehension doc in same collection
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

            // optional: tag children with parent id (makes later lookup easy)
            await Question.updateMany({ _id: { $in: childIds } }, { $addToSet: { tags: `comprehension-${insertedParent._id}` } }).exec();

            parsedCount++;
            insertedParents++;
            insertedChildren += childIds.length;

            // keep preview snippet
            previewSnippets.push((comp.passage || '').slice(0, 400));
            console.log(`[IMPORT] file=${item.filename} inserted parent=${insertedParent._id} children=${childIds.length}`);
          } catch (e) {
            console.error("[IMPORT] comprehension insert failed:", e && (e.stack || e));
            allErrors.push({ file: item.filename, reason: "DB insert failed for comprehension", error: String(e && e.message) });
          }
        }
        // go next file
        continue;
      }

      // Fallback: parse as regular single-question file
      const { parsed, errors } = parseQuestionsFromText(rawText);
      if (errors && errors.length) errors.forEach(e => allErrors.push({ file: item.filename, ...e }));

      if (!parsed.length) {
        allErrors.push({ file: item.filename, reason: "No valid questions parsed" });
        continue;
      }

      // insert single questions
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
        previewSnippets.push(parsed.slice(0,3).map(q => q.text).join("\n---\n"));
        console.log(`[IMPORT] file=${item.filename} inserted ${inserted.length} single questions`);
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
    return res.render("admin/lms_import", { title: "Import Results", result: summary, preview: previewSnippets.slice(0,5), user: req.user, organizations });
  } catch (err) {
    console.error("[IMPORT] error:", err && (err.stack || err));
    return res.status(500).send("Import failed: " + (err.message || String(err)));
  }
});

/* ------------------------------------------------------------------
 * Parser helpers
 * ------------------------------------------------------------------ */

/**
 * Robust comprehension parser:
 * - normalizes CRLF and long dash characters
 * - splits at the FIRST delimiter line with 3+ hyphens
 * - extracts labeled choices a) b) c) ...
 * - detects answer lines like "✅ Correct Answer: c)" "Correct Answer: c" or "Answer: c"
 */
function parseComprehensionFromText(raw) {
  const errors = [];
  const parsedComprehensions = [];
  if (!raw || typeof raw !== "string") return { parsedComprehensions, errors };

  // normalize newlines & unicode dashes to plain '-'
  const normalized = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/[\u2013\u2014\u2015\u2212]+/g, '-');

  // locate first delimiter line like: --- or ----- (with optional spaces)
  const delimRegex = /^[ \t]*-{3,}[ \t]*$/m;
  const delimMatch = normalized.match(delimRegex);
  if (!delimMatch) {
    return { parsedComprehensions: [], errors };
  }

  const idx = normalized.search(delimRegex);
  const before = normalized.slice(0, idx).trim();
  const after = normalized.slice(idx).replace(delimRegex, '').trim();

  if (!before || !after) {
    errors.push({ reason: "Passage or question block missing around delimiter" });
    return { parsedComprehensions: [], errors };
  }

  const passage = before;
  // split question blocks on two-or-more newlines or (if author used single blank lines) on double blank lines
  const qBlocks = after.split(/\n{2,}/).map(b => b.trim()).filter(Boolean);

  const alphabet = "abcdefghijklmnopqrstuvwxyz";
  const letterToIndex = (letter) => {
    if (!letter) return -1;
    const m = letter.trim().toLowerCase().match(/^([a-z])/);
    if (!m) return -1;
    return alphabet.indexOf(m[1]);
  };

  const questions = [];

  for (const block of qBlocks) {
    try {
      // question line (allow optional leading "1." or "1)")
      const qMatch = block.match(/^\s*(?:\d+\s*[\.\)]\s*)?(.+?)(?=\n|$)/);
      if (!qMatch) {
        errors.push({ block: block.slice(0,120), reason: "No question line found" });
        continue;
      }
      const qText = qMatch[1].trim();

      // find labeled choices (a) b) c) etc. tolerant)
      const choiceRegex = /^[ \t]*([a-zA-Z])[\.\)]\s*(.+)$/gm;
      const choices = [];
      let m;
      while ((m = choiceRegex.exec(block)) !== null) {
        choices.push(m[2].trim());
      }

      if (choices.length < 2) {
        errors.push({ question: qText, reason: `Expected labeled choices. Found ${choices.length}.` });
        continue;
      }

      // find answer lines (tolerant)
      let answerIndex = -1;
      const ansMatch = block.match(/✅\s*Correct Answer\s*[:\-]?\s*(.+)$/im) ||
                       block.match(/Correct Answer\s*[:\-]?\s*(.+)$/im) ||
                       block.match(/Answer\s*[:\-]?\s*(.+)$/im);

      if (ansMatch) {
        const ansText = ansMatch[1].trim();
        const lm = ansText.match(/^([a-zA-Z])[\.\)]?/);
        if (lm) {
          answerIndex = letterToIndex(lm[1]);
        } else {
          // try to match normalized choice text
          const normalize = s => String(s || '').replace(/[^a-z0-9]+/gi, ' ').trim().toLowerCase();
          const found = choices.findIndex(c => normalize(c) === normalize(ansText) || c.toLowerCase().startsWith(ansText.toLowerCase()) || ansText.toLowerCase().startsWith(c.toLowerCase()));
          if (found >= 0) answerIndex = found;
        }
      }

      if (answerIndex < 0 || answerIndex >= choices.length) {
        errors.push({ question: qText, reason: "Could not determine correct answer" });
        continue;
      }

      questions.push({
        text: qText,
        choices,
        answerIndex,
        tags: [],
        difficulty: "medium",
        instructions: ""
      });
    } catch (e) {
      errors.push({ block: block.slice(0,120), reason: String(e && e.message) });
    }
  }

  if (questions.length) {
    parsedComprehensions.push({ passage, questions });
  } else {
    errors.push({ reason: "No valid sub-questions parsed from quiz block." });
  }

  return { parsedComprehensions, errors };
}

/* ------------------------------------------------------------------
 * Single-question parser (kept similar to previous)
 * ------------------------------------------------------------------ */
function parseQuestionsFromText(raw) {
  const errors = [];
  const parsed = [];
  if (!raw || typeof raw !== "string") return { parsed, errors };

  const text = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  // optional global Instructions:
  let globalInstructions = "";
  const instrMatch = text.match(/(?:^|\n)Instructions:\s*([\s\S]*?)(?=\n\s*\n|$)/i);
  if (instrMatch) globalInstructions = instrMatch[1].trim();

  const blocks = text.split(/\n{2,}/).map(b => b.trim()).filter(Boolean);

  const choiceLetterToIndex = (letter) => {
    if (!letter) return -1;
    const m = letter.trim().toLowerCase().match(/^([a-d])/);
    if (!m) return -1;
    return "abcd".indexOf(m[1]);
  };

  for (const block of blocks) {
    try {
      if (/^Instructions?:/i.test(block)) continue;

      const qMatch = block.match(/^\s*(?:\d+\s*[\.\)]\s*)?(.+?)(?=\n|$)/);
      if (!qMatch) {
        errors.push({ block: block.slice(0,120), reason: "No question line found" });
        continue;
      }
      const qText = qMatch[1].trim();

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

      let answerIndex = -1;
      const ansMatch = block.match(/✅\s*Correct Answer\s*[:\-]?\s*(.+)$/im) ||
                       block.match(/Correct Answer\s*[:\-]?\s*(.+)$/im) ||
                       block.match(/Answer\s*[:\-]?\s*(.+)$/im);
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

      let difficulty = "medium";
      const diffMatch = block.match(/difficulty\s*[:\-]\s*(easy|medium|hard)/i) || block.match(/\[(easy|medium|hard)\]/i);
      if (diffMatch) difficulty = diffMatch[1].toLowerCase();

      const tags = [];
      const tagMatch = block.match(/tags?\s*[:\-]\s*([a-zA-Z0-9,\s\-]+)/i);
      if (tagMatch) tagMatch[1].split(",").map(t => t.trim()).filter(Boolean).forEach(t => tags.push(t));

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
      errors.push({ block: block.slice(0,120), reason: String(e && e.message) });
    }
  }

  return { parsed, errors };
}

function normalizeForCompare(s) {
  return String(s || "").replace(/[^a-z0-9]+/gi, " ").trim().toLowerCase();
}

export default router;
