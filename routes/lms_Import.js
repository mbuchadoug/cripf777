// routes/lms_import.js
import { Router } from "express";
import multer from "multer";
import mongoose from "mongoose";
import ensureAuth from "../../middleware/authGuard.js";
import Question from "../../models/question.js";
import Organization from "../../models/organization.js";

const router = Router();

// multer memory storage
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 1024 * 1024 * 12 } // 12MB
});

/* Simple ensureAdmin - replace with your project's if you have one */
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

/* GET import form */
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
 * We explicitly call upload.any() inside the route so we can catch multer errors and log them.
 */
router.post("/import", ensureAuth, ensureAdmin, (req, res) => {
  // call multer explicitly so we capture multer errors here
  upload.any()(req, res, async function (multerErr) {
    // ALWAYS log header/body to help debug multipart issues
    console.log("========== [IMPORT] START ==========");
    console.log("[IMPORT] Request headers:", Object.assign({}, req.headers));
    try {
      if (multerErr) {
        console.error("[MULTER ERROR] code:", multerErr.code, "message:", multerErr.message);
        // log full error stack
        console.error(multerErr && (multerErr.stack || multerErr));
        const organizations = await Organization.find().sort({ name: 1 }).lean().exec();
        return res.render("admin/lms_import", {
          title: "Import Results",
          result: { parsed: 0, inserted: 0, errors: [{ reason: `Multer error: ${multerErr.message}` }] },
          user: req.user,
          organizations
        });
      }

      console.log("[IMPORT] req.files present:", Array.isArray(req.files) ? req.files.length : 0);
      if (Array.isArray(req.files)) {
        req.files.forEach((f, i) => {
          console.log(`[IMPORT] file[${i}] field=${f.fieldname} original=${f.originalname} mime=${f.mimetype} size=${f.size}`);
          // preview first 200 chars of file text (if text-like)
          try {
            const txt = f.buffer ? f.buffer.toString("utf8") : "";
            const trimmed = txt.replace(/\s+/g, " ").trim().slice(0, 200);
            if (trimmed.length) console.log(`[IMPORT] file[${i}] preview: "${trimmed.replace(/\n/g, ' ')}"`);
          } catch (e) {
            console.warn("[IMPORT] could not preview file content:", e && e.message);
          }
        });
      }

      console.log("[IMPORT] req.body keys:", Object.keys(req.body || {}));
      if (req.body && Object.keys(req.body).length) {
        // log some fields but avoid dumping huge textarea contents fully
        for (const k of Object.keys(req.body)) {
          if (k === 'text') {
            const preview = String(req.body.text || "").replace(/\s+/g, " ").trim().slice(0, 200);
            console.log(`[IMPORT] body.text preview: "${preview}"`);
            continue;
          }
          console.log(`[IMPORT] body.${k} =`, req.body[k]);
        }
      }

      // collect texts
      const texts = [];

      // pair passageFile + question files if present
      if (Array.isArray(req.files) && req.files.length) {
        const passageFile = req.files.find(f => f.fieldname === "passageFile");
        const questionFiles = req.files.filter(f => ["file", "files", "questions", "qfile"].includes(f.fieldname));

        if (passageFile && questionFiles.length) {
          const passageText = passageFile.buffer ? passageFile.buffer.toString("utf8") : "";
          console.log(`[IMPORT] found passageFile (${passageFile.originalname}) and ${questionFiles.length} question file(s).`);
          for (const qf of questionFiles) {
            const qText = qf.buffer ? qf.buffer.toString("utf8") : "";
            texts.push({ filename: `${passageFile.originalname}+${qf.originalname}`, text: passageText + "\n\n---\n\n" + qText });
          }
        }

        // add any standalone files not used in pairing
        for (const f of req.files) {
          const wasPaired = passageFile && (f === passageFile || questionFiles.includes(f));
          if (wasPaired) continue;
          const buf = f.buffer ? f.buffer.toString("utf8") : "";
          if (!buf.trim()) {
            console.log(`[IMPORT] skipping empty uploaded file ${f.originalname}`);
            continue;
          }
          texts.push({ filename: f.originalname || f.fieldname, text: buf });
        }
      }

      // fallback to textarea text
      if (!texts.length && req.body && req.body.text && String(req.body.text).trim()) {
        texts.push({ filename: "pasted", text: String(req.body.text) });
      }

      if (!texts.length) {
        console.log("[IMPORT] No text sources found after processing files/body.");
        const organizations = await Organization.find().sort({ name: 1 }).lean().exec();
        return res.render("admin/lms_import", {
          title: "Import Results",
          result: { parsed: 0, inserted: 0, errors: [{ reason: "No file(s) or text provided" }] },
          user: req.user,
          organizations
        });
      }

      // log how many "text sources" we'll process
      console.log(`[IMPORT] Text sources to process: ${texts.length} (filenames: ${texts.map(t => t.filename).join(", ")})`);

      // org/module
      const orgId = req.body.orgId && mongoose.isValidObjectId(req.body.orgId) ? mongoose.Types.ObjectId(req.body.orgId) : null;
      const moduleName = String(req.body.module || "general").trim().toLowerCase();
      console.log(`[IMPORT] orgId: ${orgId}, module: ${moduleName}`);

      // counters/errors
      let parsedCount = 0;
      let insertedParents = 0;
      let insertedChildren = 0;
      const allErrors = [];
      const preview = [];

      // Process each text
      for (const item of texts) {
        console.log(`--- [IMPORT] processing file: ${item.filename} (len ${String(item.text).length}) ---`);
        const rawText = item.text || "";
        if (!rawText.trim()) {
          console.log(`[IMPORT] ${item.filename} is empty - skipping.`);
          allErrors.push({ file: item.filename, reason: "Empty content" });
          continue;
        }

        // try comprehension
        const { parsedComprehensions = [], errors: compErrors = [] } = parseComprehensionFromText(rawText);
        if (compErrors && compErrors.length) {
          compErrors.forEach(e => {
            allErrors.push({ file: item.filename, ...e });
            console.log("[IMPORT] comprehension parse error:", e);
          });
        }

        if (parsedComprehensions && parsedComprehensions.length) {
          console.log(`[IMPORT] parsed ${parsedComprehensions.length} comprehension block(s) in ${item.filename}`);
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

              console.log("[IMPORT] inserting children count:", childDocs.length);
              const inserted = await Question.insertMany(childDocs, { ordered: true });
              const childIds = inserted.map(d => d._id);
              console.log("[IMPORT] inserted children IDs:", childIds);

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
              console.log("[IMPORT] inserted parent ID:", insertedParent._id);

              // optionally tag children with parent reference
              await Question.updateMany({ _id: { $in: childIds } }, { $addToSet: { tags: `comprehension-${insertedParent._id}` } }).exec();

              parsedCount++;
              insertedParents++;
              insertedChildren += childIds.length;
              preview.push((comp.passage || "").slice(0, 500));
            } catch (e) {
              console.error("[IMPORT] DB insert for comprehension failed:", e && (e.stack || e));
              allErrors.push({ file: item.filename, reason: "DB insert failed for comprehension", error: String(e && e.message) });
            }
          }
          continue; // next text
        }

        // fallback to single-question parser
        const { parsed, errors } = parseQuestionsFromText(rawText);
        if (errors && errors.length) {
          errors.forEach(e => {
            allErrors.push({ file: item.filename, ...e });
            console.log("[IMPORT] single-question parse error:", e);
          });
        }

        if (!parsed.length) {
          console.log(`[IMPORT] no parsed questions in ${item.filename}`);
          allErrors.push({ file: item.filename, reason: "No valid questions parsed" });
          continue;
        }

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
          console.log(`[IMPORT] inserting ${toInsert.length} single questions from ${item.filename}`);
          const inserted = await Question.insertMany(toInsert, { ordered: true });
          console.log("[IMPORT] inserted single-question IDs (first 5):", inserted.slice(0,5).map(d => d._id));
          parsedCount += parsed.length;
          insertedChildren += inserted.length;
          preview.push(parsed.slice(0, 3).map(q => q.text).join("\n---\n"));
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

      console.log("========== [IMPORT] SUMMARY ==========");
      console.log(JSON.stringify(summary, null, 2));
      if (allErrors.length) console.log("[IMPORT] first error:", allErrors[0]);

      const organizations = await Organization.find().sort({ name: 1 }).lean().exec();
      return res.render("admin/lms_import", { title: "Import Results", result: summary, preview: preview.slice(0,5), user: req.user, organizations });
    } catch (topErr) {
      console.error("[IMPORT] unexpected error:", topErr && (topErr.stack || topErr));
      const organizations = await Organization.find().sort({ name: 1 }).lean().exec();
      return res.render("admin/lms_import", {
        title: "Import Results",
        result: { parsed: 0, inserted: 0, errors: [{ reason: "Unexpected server error", error: String(topErr && topErr.message) }] },
        user: req.user,
        organizations
      });
    } finally {
      console.log("=========== [IMPORT] END ===========");
    }
  });
});

/* ------------------------------------------------------------------
 * Parsers (same robust versions as before)
 * ------------------------------------------------------------------ */

function parseComprehensionFromText(raw) {
  const errors = [];
  const parsedComprehensions = [];
  if (!raw || typeof raw !== "string") return { parsedComprehensions, errors };

  const normalized = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/[\u2013\u2014\u2015\u2212]+/g, '-');
  const delimRegex = /^[ \t]*-{3,}[ \t]*$/m;
  const delimMatch = normalized.match(delimRegex);
  if (!delimMatch) return { parsedComprehensions: [], errors };

  const idx = normalized.search(delimRegex);
  const passage = normalized.slice(0, idx).trim();
  const after = normalized.slice(idx).replace(delimRegex, '').trim();
  if (!passage || !after) {
    errors.push({ reason: "Passage or question block missing around delimiter" });
    return { parsedComprehensions: [], errors };
  }

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
      const qMatch = block.match(/^\s*(?:\d+\s*[\.\)]\s*)?(.+?)(?=\n|$)/);
      if (!qMatch) { errors.push({ block: block.slice(0,120), reason: "No question line found" }); continue; }
      const qText = qMatch[1].trim();

      const choiceRegex = /^[ \t]*([a-zA-Z])[\.\)]\s*(.+)$/gm;
      const choices = [];
      let m;
      while ((m = choiceRegex.exec(block)) !== null) { choices.push(m[2].trim()); }

      if (choices.length < 2) { errors.push({ question: qText, reason: `Expected labeled choices. Found ${choices.length}.` }); continue; }

      let answerIndex = -1;
      const ansMatch = block.match(/✅\s*Correct Answer\s*[:\-]?\s*(.+)$/im) ||
                       block.match(/Correct Answer\s*[:\-]?\s*(.+)$/im) ||
                       block.match(/Answer\s*[:\-]?\s*(.+)$/im);

      if (ansMatch) {
        const ansText = ansMatch[1].trim();
        const lm = ansText.match(/^([a-zA-Z])[\.\)]?/);
        if (lm) answerIndex = letterToIndex(lm[1]);
        else {
          const normalize = s => String(s || '').replace(/[^a-z0-9]+/gi, ' ').trim().toLowerCase();
          const found = choices.findIndex(c => normalize(c) === normalize(ansText) || c.toLowerCase().startsWith(ansText.toLowerCase()) || ansText.toLowerCase().startsWith(c.toLowerCase()));
          if (found >= 0) answerIndex = found;
        }
      }

      if (answerIndex < 0 || answerIndex >= choices.length) { errors.push({ question: qText, reason: "Could not determine correct answer" }); continue; }

      questions.push({ text: qText, choices, answerIndex, tags: [], difficulty: "medium", instructions: "" });
    } catch (e) {
      errors.push({ block: block.slice(0,120), reason: String(e && e.message) });
    }
  }

  if (questions.length) parsedComprehensions.push({ passage, questions });
  else errors.push({ reason: "No valid sub-questions parsed from quiz block." });

  return { parsedComprehensions, errors };
}

function parseQuestionsFromText(raw) {
  const errors = [];
  const parsed = [];
  if (!raw || typeof raw !== "string") return { parsed, errors };

  const text = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
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
      const qText = qMatch[1].trim();

      const choiceRegex = /^[ \t]*([a-dA-D])[\.\)]\s*(.+)$/gm;
      const choices = [];
      let m;
      while ((m = choiceRegex.exec(block)) !== null) choices.push(m[2].trim());

      if (choices.length < 2) { errors.push({ question: qText, reason: `Expected labelled choices a)-d). Found ${choices.length}.` }); continue; }

      let answerIndex = -1;
      const ansMatch = block.match(/✅\s*Correct Answer\s*[:\-]?\s*(.+)$/im) ||
                       block.match(/Correct Answer\s*[:\-]?\s*(.+)$/im) ||
                       block.match(/Answer\s*[:\-]?\s*(.+)$/im);
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
      if (tagMatch) tagMatch[1].split(",").map(t => t.trim()).filter(Boolean).forEach(t => tags.push(t));

      let instructions = "";
      const instrQ = block.match(/Instructions?:\s*([\s\S]+?)$/i);
      if (instrQ) instructions = instrQ[1].trim();

      parsed.push({ text: qText, choices, answerIndex, tags, difficulty, instructions: instructions || globalInstructions || "" });
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
