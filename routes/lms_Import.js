// routes/admin/lms_import.js
import { Router } from "express";
import multer from "multer";
import mongoose from "mongoose";
import { ensureAuth } from "../../middleware/authGuard.js"; // keep your existing auth
import Question from "../../models/question.js";
import Organization from "../../models/organization.js";

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 1024 * 1024 * 8 } }); // 8MB

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

// GET form
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
 * Accepts single upload field 'file' (text) or textarea 'text'.
 * Expects single combined file format: passage, a line with ---, then question blocks.
 */
router.post("/import", ensureAuth, ensureAdmin, upload.single("file"), async (req, res) => {
  try {
    // get raw text from uploaded file or textarea
    let rawText = "";
    if (req.file && req.file.buffer) rawText = req.file.buffer.toString("utf8");
    else if (req.body && req.body.text) rawText = String(req.body.text || "");
    if (!rawText || !rawText.trim()) {
      const organizations = await Organization.find().sort({ name: 1 }).lean().exec();
      return res.render("admin/lms_import", { title: "Import Results", result: { parsed: 0, inserted: 0, errors: [{ reason: "No file or text provided" }] }, user: req.user, organizations });
    }

    // optional org/module
    const orgId = req.body.orgId && mongoose.isValidObjectId(req.body.orgId) ? mongoose.Types.ObjectId(req.body.orgId) : null;
    const moduleName = String(req.body.module || "general").trim().toLowerCase();

    // Try comprehension parser first
    const { parsedComprehensions = [], errors: compErrors = [] } = parseComprehensionFromText(rawText);

    const summary = { parsed: 0, inserted: 0, insertedParents: 0, errors: [] };

    if (compErrors && compErrors.length) summary.errors.push(...compErrors);

    if (parsedComprehensions && parsedComprehensions.length) {
      // For each comprehension found, insert children then parent
      for (const comp of parsedComprehensions) {
        try {
          // prepare child documents — map parser.answerIndex -> correctIndex
          const childDocs = (comp.questions || []).map(q => ({
            text: q.text,
            choices: (q.choices || []).map(c => ({ text: c })), // store as ChoiceSchema { text }
            correctIndex: (typeof q.answerIndex === "number") ? q.answerIndex : 0,
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

          // parent comprehension doc
          const parentDoc = {
            text: (comp.passage || "").split("\n").slice(0, 1).join(" ").slice(0, 160) || "Comprehension passage",
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

          // optional: tag children with parent id for easier lookup
          await Question.updateMany({ _id: { $in: childIds } }, { $addToSet: { tags: `comprehension-${insertedParent._id}` } }).exec();

          summary.parsed += (comp.questions || []).length;
          summary.inserted += childIds.length;
          summary.insertedParents += 1;
        } catch (e) {
          console.error("[import comprehension insert] failed:", e && (e.stack || e));
          summary.errors.push({ reason: "DB insert failed for a comprehension", error: String(e && e.message) });
        }
      }

      const organizations = await Organization.find().sort({ name: 1 }).lean().exec();
      return res.render("admin/lms_import", { title: "Import Results", result: summary, user: req.user, organizations });
    }

    // Fallback: parse single-question blocks
    const { parsed = [], errors = [] } = parseQuestionsFromText(rawText);
    if (errors && errors.length) summary.errors.push(...errors);
    if (!parsed.length) {
      const organizations = await Organization.find().sort({ name: 1 }).lean().exec();
      return res.render("admin/lms_import", { title: "Import Results", result: summary, user: req.user, organizations });
    }

    // Insert parsed single questions
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
      summary.parsed += parsed.length;
      summary.inserted += inserted.length;
    } catch (e) {
      console.error("[import single insert] failed:", e && (e.stack || e));
      summary.errors.push({ reason: "DB insert failed for single questions", error: String(e && e.message) });
    }

    const organizations = await Organization.find().sort({ name: 1 }).lean().exec();
    return res.render("admin/lms_import", { title: "Import Results", result: summary, user: req.user, organizations });

  } catch (err) {
    console.error("Import failed:", err && (err.stack || err));
    return res.status(500).send("Import failed: " + (err.message || String(err)));
  }
});

export default router;

/* ------------------------------------------------------------------
 * Parser helpers (comprehension + single-question parser)
 * ------------------------------------------------------------------ */

function parseComprehensionFromText(raw) {
  const errors = [];
  const parsedComprehensions = [];
  if (!raw || typeof raw !== "string") return { parsedComprehensions, errors };
  const text = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  // split on a line that contains 3+ dashes
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
      while ((m = choiceRegex.exec(block)) !== null) choices.push(m[2].trim());

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
        if (lm) answerIndex = letterToIndex(lm[1]);
        else {
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
      if (tagMatch) tagMatch[1].split(",").map(t => t.trim()).filter(Boolean).forEach(t => tags.push(t));

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

  if (questions.length) parsedComprehensions.push({ passage, questions });
  else errors.push({ reason: "No valid sub-questions parsed from quiz block." });

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
      const qText = qMatch[1].trim();

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
      errors.push({ block: block.slice(0,120), reason: e.message || String(e) });
    }
  }

  return { parsed, errors };
}

function normalizeForCompare(s) {
  return String(s || "").replace(/[^a-z0-9]+/gi, " ").trim().toLowerCase();
}
