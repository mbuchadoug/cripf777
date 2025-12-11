// routes/admin/lms_import.js
import { Router } from "express";
import multer from "multer";
import mongoose from "mongoose";
import { ensureAuth } from "../../middleware/authGuard.js";
import Question from "../../models/question.js";
import Organization from "../../models/organization.js";

const router = Router();

// multer memory storage
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 1024 * 1024 * 12 } }); // 12MB

// admin guard (keeps your original logic)
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
 * - Uses upload.any() to accept any file field names (avoids "Unexpected field" errors).
 * - Logs req.files and req.body and also returns debug info to the rendered page.
 */
router.post("/import", ensureAuth, ensureAdmin, upload.any(), async (req, res) => {
  try {
    // --- DEBUG / INSPECTION (very helpful to find fieldname mismatches) ---
    console.log("[IMPORT] incoming files count:", Array.isArray(req.files) ? req.files.length : 0);
    if (Array.isArray(req.files)) {
      req.files.forEach((f, i) => {
        console.log(`[IMPORT] file[${i}] field=${f.fieldname} name=${f.originalname} size=${f.size}`);
      });
    }
    console.log("[IMPORT] req.body keys:", Object.keys(req.body || {}));

    // collect text contents to process: array of { filename, text }
    const texts = [];

    // If files present: try to pair passageFile + question files; otherwise treat standalone
    if (Array.isArray(req.files) && req.files.length) {
      // look specifically for passageFile and common question file names
      const passageFile = req.files.find(f => f.fieldname === "passageFile");
      const questionFiles = req.files.filter(f => ["file", "files", "questions", "qfile", "questionFile"].includes(f.fieldname));

      if (passageFile && questionFiles.length) {
        const passageText = passageFile.buffer ? passageFile.buffer.toString("utf8") : "";
        for (const qf of questionFiles) {
          const qtext = qf.buffer ? qf.buffer.toString("utf8") : "";
          if (!qtext.trim()) continue;
          texts.push({ filename: `${passageFile.originalname} + ${qf.originalname}`, text: passageText + "\n\n---\n\n" + qtext });
        }
      }

      // add any uploaded files not already used in pairing
      for (const f of req.files) {
        // skip if used in the pair
        if (passageFile && (f === passageFile || questionFiles.includes(f))) continue;
        const buf = f.buffer ? f.buffer.toString("utf8") : "";
        if (!buf.trim()) continue;
        texts.push({ filename: f.originalname || f.fieldname, text: buf });
      }
    }

    // fallback: textarea
    if (!texts.length && req.body && req.body.text && String(req.body.text).trim()) {
      texts.push({ filename: "pasted", text: String(req.body.text) });
    }

    // if still nothing -> render with debug so you can see what happened
    if (!texts.length) {
      const organizations = await Organization.find().sort({ name: 1 }).lean().exec();
      const debug = {
        files: (req.files || []).map(f => ({ field: f.fieldname, name: f.originalname, size: f.size })),
        body: req.body
      };
      return res.render("admin/lms_import", {
        title: "Import Results",
        result: { parsedFiles: 0, parsedItems: 0, insertedParents: 0, insertedChildren: 0, errors: [{ reason: "No text found in files or textarea" }] },
        debug,
        user: req.user,
        organizations
      });
    }

    // org/module
    const orgId = req.body.orgId && mongoose.isValidObjectId(req.body.orgId) ? mongoose.Types.ObjectId(req.body.orgId) : null;
    const moduleName = String(req.body.module || "general").trim().toLowerCase();

    // counters
    let parsedCount = 0, insertedParents = 0, insertedChildren = 0;
    const allErrors = [];

    // iterate texts and parse
    for (const item of texts) {
      const rawText = item.text || "";
      if (!rawText.trim()) {
        allErrors.push({ file: item.filename, reason: "Empty content" });
        continue;
      }

      // try comprehension first
      const { parsedComprehensions = [], errors: compErrors = [] } = parseComprehensionFromText(rawText);
      if (compErrors && compErrors.length) compErrors.forEach(e => allErrors.push({ file: item.filename, ...e }));

      if (parsedComprehensions && parsedComprehensions.length) {
        for (const comp of parsedComprehensions) {
          try {
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

            // tag children with comprehension id
            await Question.updateMany({ _id: { $in: childIds } }, { $addToSet: { tags: `comprehension-${insertedParent._id}` } }).exec();

            parsedCount++;
            insertedParents++;
            insertedChildren += childIds.length;
          } catch (e) {
            console.error("[IMPORT] comprehension insert failed:", e && (e.stack || e));
            allErrors.push({ file: item.filename, reason: "DB insert failed for comprehension", error: String(e && e.message) });
          }
        }
        continue;
      }

      // fallback parse single-question blocks
      const { parsed, errors } = parseQuestionsFromText(rawText);
      if (errors && errors.length) errors.forEach(e => allErrors.push({ file: item.filename, ...e }));

      if (!parsed.length) continue;

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

    const summary = { parsedFiles: texts.length, parsedItems: parsedCount, insertedParents, insertedChildren, errors: allErrors };
    const organizations = await Organization.find().sort({ name: 1 }).lean().exec();
    const debug = {
      files: (req.files || []).map(f => ({ field: f.fieldname, name: f.originalname, size: f.size })),
      body: req.body
    };

    return res.render("admin/lms_import", { title: "Import Results", result: summary, debug, user: req.user, organizations });
  } catch (err) {
    console.error("[IMPORT] error:", err && (err.stack || err));
    return res.status(500).send("Import failed: " + (err.message || String(err)));
  }
});

/* ------------------------------------------------------------------
 * Parsers (unchanged from your existing logic)
 * ------------------------------------------------------------------ */
function parseComprehensionFromText(raw) {
  const errors = [];
  const parsedComprehensions = [];

  if (!raw || typeof raw !== "string") return { parsedComprehensions, errors };
  const text = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const parts = text.split(/^\s*-{3,}\s*$/m).map(p => p.trim()).filter(Boolean);
  if (parts.length < 2) return { parsedComprehensions: [], errors };

  const passage = parts[0];
  const quizBlock = parts.slice(1).join("\n\n");

  const letterToIndex = (letter) => {
    if (!letter) return -1;
    const m = letter.trim().toLowerCase().match(/^([a-z])/);
    if (!m) return -1;
    return "abcdefghijklmnopqrstuvwxyz".indexOf(m[1]);
  };

  const qBlocks = quizBlock.split(/\n{2,}/).map(b => b.trim()).filter(Boolean);
  const questions = [];

  for (const block of qBlocks) {
    try {
      const qMatch = block.match(/^\s*(?:\d+\s*[\.\)]\s*)?(.+?)(?=\n|$)/);
      if (!qMatch) {
        errors.push({ block: block.slice(0, 120), reason: "No question line found" });
        continue;
      }
      const qText = qMatch[1].trim();

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
          const normalize = s => String(s||"").replace(/[^a-z0-9]+/gi," ").trim().toLowerCase();
          const found = choices.findIndex(c => normalize(c) === normalize(ansText) || c.toLowerCase().startsWith(ansText.toLowerCase()) || ansText.toLowerCase().startsWith(c.toLowerCase()));
          if (found >= 0) answerIndex = found;
        }
      }

      if (answerIndex < 0 || answerIndex >= choices.length) {
        errors.push({ question: qText, reason: "Could not determine correct answer" });
        continue;
      }

      let difficulty = "medium";
      const diffMatch = block.match(/difficulty\s*[:\-]\s*(easy|medium|hard)/i) || block.match(/\[(easy|medium|hard)\]/i);
      if (diffMatch) difficulty = diffMatch[1].toLowerCase();

      const tags = [];
      const tagMatch = block.match(/tags?\s*[:\-]\s*([a-zA-Z0-9,\s\-]+)/i);
      if (tagMatch) tagMatch[1].split(",").map(t=>t.trim()).filter(Boolean).forEach(t => tags.push(t));

      let instructions = "";
      const instrQ = block.match(/Instructions?:\s*([\s\S]+?)$/i);
      if (instrQ) instructions = instrQ[1].trim();

      questions.push({ text: qText, choices, answerIndex, tags, difficulty, instructions });
    } catch (e) {
      errors.push({ block: block.slice(0, 120), reason: e.message || String(e) });
    }
  }

  if (questions.length) {
    parsedComprehensions.push({ passage, questions });
  } else {
    errors.push({ reason: "No valid sub-questions parsed from quiz block." });
  }

  return { parsedComprehensions, errors };
}

function parseQuestionsFromText(raw) {
  const errors = [];
  const parsed = [];
  if (!raw || typeof raw !== "string") return { parsed, errors };
  const text = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

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
      if (!qMatch) { errors.push({ block: block.slice(0,120), reason: "No question line found" }); continue; }
      let qText = qMatch[1].trim();

      const choiceRegex = /^[ \t]*([a-dA-D])[\.\)]\s*(.+)$/gm;
      const choices = [];
      let m;
      while ((m = choiceRegex.exec(block)) !== null) choices.push(m[2].trim());
      if (choices.length < 2) { errors.push({ question: qText, reason: `Expected labelled choices a)-d). Found ${choices.length}.` }); continue; }

      let answerIndex = -1;
      let ansMatch = block.match(/✅\s*Correct Answer\s*:\s*(.+)$/im) || block.match(/Correct Answer\s*:\s*(.+)$/im) || block.match(/Answer\s*:\s*(.+)$/im);
      if (ansMatch) {
        const ansText = ansMatch[1].trim();
        const letterMatch = ansText.match(/^([a-dA-D])[\.\)]?/);
        if (letterMatch) answerIndex = choiceLetterToIndex(letterMatch[1]);
        else {
          const found = choices.findIndex(c => normalizeForCompare(c) === normalizeForCompare(ansText) || c.toLowerCase().startsWith(ansText.toLowerCase()) || ansText.toLowerCase().startsWith(c.toLowerCase()));
          if (found >= 0) answerIndex = found;
          else {
            const insideLetter = ansText.match(/\(([a-dA-D])\)/);
            if (insideLetter) answerIndex = choiceLetterToIndex(insideLetter[1]);
          }
        }
      }

      if (answerIndex < 0 || answerIndex >= choices.length) { errors.push({ question: qText, reason: `Could not determine correct answer from block. Choices found: ${choices.length}` }); continue; }

      let difficulty = "medium";
      const diffMatch = block.match(/difficulty\s*[:\-]\s*(easy|medium|hard)/i) || block.match(/\[(easy|medium|hard)\]/i);
      if (diffMatch) difficulty = diffMatch[1].toLowerCase();

      const tags = [];
      const tagMatch = block.match(/tags?\s*[:\-]\s*([a-zA-Z0-9,\s\-]+)/i);
      if (tagMatch) tagMatch[1].split(",").map(t=>t.trim()).filter(Boolean).forEach(t=>tags.push(t));

      let instructions = "";
      const instrQ = block.match(/Instructions?:\s*([\s\S]+?)$/i);
      if (instrQ) instructions = instrQ[1].trim();

      parsed.push({ text: qText, choices, answerIndex, tags, difficulty, instructions: instructions || globalInstructions || "" });
    } catch (e) {
      errors.push({ block: block.slice(0,120), reason: e.message || String(e) });
    }
  }

  return { parsed, errors };
}

function normalizeForCompare(s) {
  return String(s || "").replace(/[^a-z0-9]+/gi, " ").trim().toLowerCase();
}

export default router;
