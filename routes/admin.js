// routes/admin.js
import { Router } from "express";
import fs from "fs";
import path from "path";
import multer from "multer";
import { fileURLToPath } from "url";
import User from "../models/user.js";
import Visit from "../models/visit.js";
import UniqueVisit from "../models/uniqueVisit.js";
import { ensureAuth } from "../middleware/authGuard.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const router = Router();
console.log("🔥 admin routes loaded");

// storage for multer (store in memory then write to disk)
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

// helper: admin set
function getAdminSet() {
  return new Set(
    (process.env.ADMIN_EMAILS || "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  );
}

function ensureAdmin(req, res, next) {
  const email = (req.user && (req.user.email || req.user.username) || "").toLowerCase();
  const ADMIN_SET = getAdminSet();
  if (!email || !ADMIN_SET.has(email)) {
    if (req.headers.accept && req.headers.accept.includes("text/html")) {
      return res.status(403).send("<h3>Forbidden — admin only</h3>");
    }
    return res.status(403).json({ error: "Forbidden — admin only" });
  }
  next();
}

// safeRender helper so res.render errors are captured
function safeRender(req, res, view, locals = {}) {
  try {
    return res.render(view, locals, (err, html) => {
      if (err) {
        console.error(`[safeRender] render error for view="${view}":`, err && (err.stack || err));
        if (req.headers.accept && req.headers.accept.includes("text/html")) {
          if (!res.headersSent) {
            return res.status(500).send(`<h3>Server error rendering ${view}</h3><pre>${String(err.message || err)}</pre>`);
          }
          return;
        }
        if (!res.headersSent) return res.status(500).json({ error: "Render failed", detail: String(err.message || err) });
        return;
      }
      if (!res.headersSent) return res.send(html);
    });
  } catch (e) {
    console.error(`[safeRender] synchronous render exception for view="${view}":`, e && (e.stack || e));
    if (!res.headersSent) {
      return res.status(500).send("Server render exception");
    }
  }
}

/**
 * Robust parser for the quiz text format.
 *
 * Accepts blocks separated by one or more blank lines. Each block typically follows:
 *   1. Question text...
 *   a) choice text
 *   b) choice text
 *   c) ...
 *   Correct Answer: b
 *
 * The parser is forgiving:
 * - question lines that start "1." or not numbered are supported
 * - choice markers allowed: a) a. a) (case-insensitive)
 * - correct answer can be "Correct Answer: b)" or "Correct Answer: b" or full text
 *
 * Returns array of { text, choices: [{ text }], correctIndex, rawBlock }
 */
function parseQuestionBlocks(raw) {
  if (!raw || typeof raw !== "string") return [];
  // normalize line endings and trim overall whitespace
  const normalized = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();

  // split into blocks on one or more blank lines (we use 2+ newlines or single blank-line)
  // split on two-or-more newlines OR on a newline that is followed by whitespace-only line.
  const blocks = normalized.split(/\n{2,}/).map(b => b.trim()).filter(Boolean);
  const parsed = [];

  for (const block of blocks) {
    // split into lines, preserve order but remove purely-empty lines
    const lines = block.split("\n").map(l => l.replace(/\t/g, ' ').trim()).filter(Boolean);
    if (lines.length === 0) continue;

    // strategy:
    // - find index of the first choice line (a) / b) / a. / etc)
    // - everything before that (joined with space) is the question text (strip leading numbering)
    // - collect choice lines (a,b,c,d...) that occur (stop when we hit a non-choice that looks like 'Correct Answer' or other footer)
    // - find correct line and parse letter or match text

    const isChoiceLine = (s) => /^[a-d][\.\)]\s+/i.test(s) || /^\([a-d]\)\s+/i.test(s);
    const isCorrectLine = (s) => /Correct Answer:/i.test(s) || /✅\s*Correct Answer:/i.test(s);

    // find first choice line index
    let firstChoiceIdx = lines.findIndex(isChoiceLine);

    // If no choice lines found, attempt to locate choices that start with letters + whitespace (fallback)
    if (firstChoiceIdx === -1) {
      firstChoiceIdx = lines.findIndex(l => /^[a-d]\s+/.test(l));
    }

    // question lines are lines before firstChoiceIdx (if found), else assume first line is question
    let questionLines = [];
    let choiceLines = [];
    let footerLines = [];

    if (firstChoiceIdx > 0) {
      questionLines = lines.slice(0, firstChoiceIdx);
      // rest until a "Correct Answer" or end are potential choice lines
      let i = firstChoiceIdx;
      for (; i < lines.length; i++) {
        const line = lines[i];
        if (isCorrectLine(line)) {
          footerLines.push(line);
          i++;
          break;
        }
        if (isChoiceLine(line) || /^[a-d]\s+/.test(line)) {
          choiceLines.push(line);
        } else {
          // If it's not a choice, but looks like a continuation of previous choice (no marker) - attach to previous
          if (choiceLines.length) {
            choiceLines[choiceLines.length - 1] += " " + line;
          } else {
            // no choice yet — treat line as footer/question continuation
            questionLines.push(line);
          }
        }
      }
      // any remaining lines after footer (i..end) append to footerLines
      if (firstChoiceIdx !== -1 && footerLines.length === 0) {
        // search for explicit correct line later
        for (let j = firstChoiceIdx + choiceLines.length; j < lines.length; j++) {
          const ln = lines[j];
          if (isCorrectLine(ln)) footerLines.push(ln);
          else footerLines.push(ln);
        }
      }
    } else {
      // No explicit choice marker found. Heuristic:
      // treat first line as question, subsequent lines starting with letters as choices.
      questionLines = [lines[0]];
      for (let i = 1; i < lines.length; i++) {
        const l = lines[i];
        if (isChoiceLine(l) || /^[a-d]\s+/.test(l) || /^[A-D]\)\s+/.test(l)) {
          choiceLines.push(l);
        } else if (isCorrectLine(l)) {
          footerLines.push(l);
        } else {
          // either continuation of question (if before choices) or appended to last choice
          if (choiceLines.length === 0) {
            questionLines.push(l);
          } else {
            choiceLines[choiceLines.length - 1] += " " + l;
          }
        }
      }
    }

    // Build question text (join question lines and strip leading numbering like "1. ")
    let questionText = questionLines.join(" ").trim();
    questionText = questionText.replace(/^\d+\.\s*/, "").trim();

    // Normalize choice lines into plain texts
    const choices = choiceLines.map(cl => {
      // remove leading "a) " "a. " "(a) " "a " etc
      const txt = cl.replace(/^[\(\[]?[a-d][\)\.\]]?\s*/i, "").trim();
      return { text: txt };
    });

    // find a correctIndex from footerLines (look for letter) OR from a "Correct Answer: <text>"
    let correctIndex = null;
    let correctLetter = null;
    const footer = footerLines.join(" ").trim();

    if (footer) {
      // try letter capture
      const m = footer.match(/Correct Answer:\s*[:\-]?\s*([a-d])\b/i);
      if (m) {
        correctLetter = m[1].toLowerCase();
        correctIndex = { a: 0, b: 1, c: 2, d: 3 }[correctLetter];
      } else {
        // try to extract single-letter inside parentheses e.g. "Correct Answer: b) ..." or emoji line
        const m2 = footer.match(/([a-d])\)/i);
        if (m2) {
          correctLetter = m2[1].toLowerCase();
          correctIndex = { a: 0, b: 1, c: 2, d: 3 }[correctLetter];
        } else {
          // fallback: see if footer contains the exact text of one of choices
          const stripped = footer.replace(/Correct Answer:/i, "").replace(/✅/g, "").trim();
          const found = choices.findIndex(c => {
            const lcChoice = (c.text || "").toLowerCase().replace(/^[\)\.:\s]*/, "");
            const sc = stripped.toLowerCase().replace(/^[\)\.:\s]*/, "");
            return lcChoice.startsWith(sc) || lcChoice === sc || sc.startsWith(lcChoice);
          });
          if (found >= 0) correctIndex = found;
        }
      }
    }

    // sanity checks
    if (!questionText) continue;
    if (choices.length === 0) {
      // skip blocks that don't contain choices
      continue;
    }

    parsed.push({
      text: questionText,
      choices,
      correctIndex: typeof correctIndex === "number" ? correctIndex : null,
      rawBlock: block
    });
  }

  return parsed;
}

// path to save fallback file so API can read it
const FALLBACK_PATH = "/mnt/data/responsibilityQuiz.txt";

// GET import page (render a simple importer)
router.get("/lms/import", ensureAuth, ensureAdmin, (req, res) => {
  return safeRender(req, res, "admin/lms_import", { title: "Import LMS Questions (paste)" });
});

/**
 * POST /admin/lms/import
 * Accepts:
 *   - file upload (field 'file')
 *   - or pasted text in textarea (field 'text')
 * If 'save' param present (save=1), attempt to save parsed questions to DB (Questions collection).
 */
router.post("/lms/import", ensureAuth, ensureAdmin, upload.single("file"), async (req, res) => {
  try {
    // prefer uploaded file -> fallback to textarea 'text'
    let content = "";

    if (req.file && req.file.buffer && req.file.buffer.length) {
      content = req.file.buffer.toString("utf8");
    } else if (req.body && typeof req.body.text === "string" && req.body.text.trim().length) {
      content = req.body.text;
    }

    if (!content || !content.trim()) {
      // no content provided
      if (req.headers.accept && req.headers.accept.includes("text/html")) {
        return res.status(400).send("Import failed: No text provided. Paste your questions or upload a .txt file and click Import.");
      }
      return res.status(400).json({ error: "No text provided" });
    }

    // Save fallback file to disk so API /mnt/data reads it
    try {
      // ensure dir exists
      const dir = path.dirname(FALLBACK_PATH);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(FALLBACK_PATH, content, { encoding: "utf8" });
      console.log(`[admin/lms/import] saved fallback quiz file to ${FALLBACK_PATH}`);
    } catch (err) {
      console.error("[admin/lms/import] failed to write fallback file:", err && (err.stack || err));
    }

    // parse blocks
    const blocks = parseQuestionBlocks(content);
    console.log(`[admin/lms/import] parsed ${blocks.length} question blocks`);

    // If admin requested to "save" to DB, attempt to insert into Question collection
    const saveToDb = req.body && (req.body.save === "1" || req.body.save === "true" || req.body.save === "on");

    let inserted = 0;
    let dbSkipped = false;
    let dbErr = null;

    if (saveToDb && blocks.length) {
      try {
        // import Question model if present (best-effort)
        let Question;
        try {
          Question = (await import("../models/question.js")).default;
        } catch (e) {
          // alternative path name or missing model
          try {
            Question = (await import("../models/question/index.js")).default;
          } catch (e2) {
            Question = null;
          }
        }

        if (!Question) {
          dbSkipped = true;
          console.warn("[admin/lms/import] Question model not found — skipping DB insert");
        } else {
          // map parsed blocks into the DB schema shape (choices as embedded docs)
          const toInsert = blocks.map(b => ({
            text: b.text,
            // make sure we insert choices as objects (not plain strings) to match typical schemas
            choices: (b.choices || []).map(c => ({ text: c.text })),
            correctIndex: typeof b.correctIndex === "number" ? b.correctIndex : null,
            tags: ["responsibility"],
            source: req.body.source || "import",
            raw: b.rawBlock,
            createdAt: new Date()
          }));

          const result = await Question.insertMany(toInsert);
          inserted = result.length || 0;
        }
      } catch (err) {
        console.error("[admin/lms/import] DB insert error:", err && (err.stack || err));
        dbErr = String(err.message || err);
      }
    }

    // Render preview page (if HTML) with summary
    if (req.headers.accept && req.headers.accept.includes("text/html")) {
      return safeRender(req, res, "admin/lms_import_summary", {
        title: "Import summary",
        detected: blocks.length,
        blocks,
        savedToDb: saveToDb && !dbSkipped && !dbErr,
        inserted,
        dbSkipped,
        dbErr
      });
    }

    // JSON response for API callers
    return res.json({ success: true, parsed: blocks.length, savedToDb: saveToDb && !dbSkipped && !dbErr, inserted, dbSkipped, dbErr });

  } catch (err) {
    console.error("[admin/lms/import] error:", err && (err.stack || err));
    if (req.headers.accept && req.headers.accept.includes("text/html")) {
      return res.status(500).send("Import failed");
    }
    return res.status(500).json({ error: "Import failed", detail: String(err.message || err) });
  }
});

/**
 * GET /admin/lms/quizzes
 * Returns a simple view listing quiz sources and tags detected in DB (for Manage Quizzes page).
 * If no Question model found, the view will still render but show "No sources found".
 */
router.get("/lms/quizzes", ensureAuth, ensureAdmin, async (req, res) => {
  try {
    let Question;
    try {
      Question = (await import("../models/question.js")).default;
    } catch (e) {
      Question = null;
    }

    let sources = [];
    let tags = [];

    if (Question) {
      // aggregate distinct sources and tags
      sources = await Question.distinct("source").catch(() => []);
      tags = await Question.distinct("tags").catch(() => []);
      // normalize tags (tags may be arrays)
      tags = (Array.isArray(tags) ? tags.flat() : tags).filter(Boolean);
    }

    return safeRender(req, res, "admin/lms_quizzes", { title: "Manage Quizzes", sources: sources || [], tags: tags || [] });
  } catch (err) {
    console.error("[admin/lms/quizzes] error:", err && (err.stack || err));
    return res.status(500).send("Failed to load quizzes");
  }
});

/**
 * POST /admin/lms/quizzes/delete-all
 * Deletes questions by filter:
 *  - if body.filter === 'source' and body.value provided -> deletes by source
 *  - if body.filter === 'tag' and body.value provided -> deletes by tag
 *  - else deletes ALL questions
 *
 * Protected by ensureAuth + ensureAdmin.
 */
router.post("/lms/quizzes/delete-all", ensureAuth, ensureAdmin, async (req, res) => {
  try {
    let Question;
    try {
      Question = (await import("../models/question.js")).default;
    } catch (e) {
      Question = null;
    }

    if (!Question) {
      if (req.headers.accept && req.headers.accept.includes("text/html")) {
        return res.status(500).send("Question model not found on server; cannot delete from DB.");
      }
      return res.status(500).json({ error: "Question model not found" });
    }

    const filterType = req.body && req.body.filter;
    const value = req.body && req.body.value;

    let filter = {};
    if (filterType === "source" && value) {
      filter.source = value;
    } else if (filterType === "tag" && value) {
      filter.tags = value;
    } else {
      filter = {}; // delete all
    }

    const deleteRes = await Question.deleteMany(filter);
    console.log(`[admin/lms/quizzes/delete-all] deleted ${deleteRes.deletedCount} questions (filter: ${JSON.stringify(filter)})`);

    if (req.headers.accept && req.headers.accept.includes("text/html")) {
      // redirect back to manage page with a flash-like query param (simple)
      return res.redirect("/admin/lms/quizzes?deleted=" + encodeURIComponent(deleteRes.deletedCount));
    }
    return res.json({ deleted: deleteRes.deletedCount, filter });
  } catch (err) {
    console.error("[admin/lms/quizzes/delete-all] error:", err && (err.stack || err));
    if (req.headers.accept && req.headers.accept.includes("text/html")) {
      return res.status(500).send("Failed to delete questions");
    }
    return res.status(500).json({ error: "delete failed", detail: String(err.message || err) });
  }
});

// other admin routes below (user listing, visits, etc).
// --- Example: /admin/users (kept minimal here; you likely have a larger set already) ---

router.get("/users", ensureAuth, ensureAdmin, async (req, res) => {
  try {
    const users = await User.find().sort({ createdAt: -1 }).lean();
    return safeRender(req, res, "admin/users", { title: "Admin · Users", users });
  } catch (err) {
    console.error("[admin/users] error:", err && (err.stack || err));
    return res.status(500).send("Failed to load users");
  }
});

export default router;
