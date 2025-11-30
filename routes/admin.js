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

  // split into blocks on one or more blank lines
  const blocks = normalized.split(/\n{2,}/).map(b => b.trim()).filter(Boolean);
  const parsed = [];

  for (const block of blocks) {
    const lines = block.split("\n").map(l => l.replace(/\t/g, ' ').trim()).filter(Boolean);
    if (lines.length === 0) continue;

    const isChoiceLine = (s) => /^[a-d][\.\)]\s+/i.test(s) || /^\([a-d]\)\s+/i.test(s);
    const isCorrectLine = (s) => /Correct Answer:/i.test(s) || /✅\s*Correct Answer:/i.test(s);

    let firstChoiceIdx = lines.findIndex(isChoiceLine);
    if (firstChoiceIdx === -1) firstChoiceIdx = lines.findIndex(l => /^[a-d]\s+/.test(l));

    let questionLines = [];
    let choiceLines = [];
    let footerLines = [];

    if (firstChoiceIdx > 0) {
      questionLines = lines.slice(0, firstChoiceIdx);
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
          if (choiceLines.length) {
            choiceLines[choiceLines.length - 1] += " " + line;
          } else {
            questionLines.push(line);
          }
        }
      }
      if (firstChoiceIdx !== -1 && footerLines.length === 0) {
        for (let j = firstChoiceIdx + choiceLines.length; j < lines.length; j++) {
          const ln = lines[j];
          if (isCorrectLine(ln)) footerLines.push(ln);
          else footerLines.push(ln);
        }
      }
    } else {
      questionLines = [lines[0]];
      for (let i = 1; i < lines.length; i++) {
        const l = lines[i];
        if (isChoiceLine(l) || /^[a-d]\s+/.test(l) || /^[A-D]\)\s+/.test(l)) {
          choiceLines.push(l);
        } else if (isCorrectLine(l)) {
          footerLines.push(l);
        } else {
          if (choiceLines.length === 0) questionLines.push(l);
          else choiceLines[choiceLines.length - 1] += " " + l;
        }
      }
    }

    let questionText = questionLines.join(" ").trim();
    questionText = questionText.replace(/^\d+\.\s*/, "").trim();

    const choices = choiceLines.map(cl => {
      const txt = cl.replace(/^[\(\[]?[a-d][\)\.\]]?\s*/i, "").trim();
      return { text: txt };
    });

    let correctIndex = null;
    const footer = footerLines.join(" ").trim();
    if (footer) {
      const m = footer.match(/Correct Answer:\s*[:\-]?\s*([a-d])\b/i);
      if (m) correctIndex = { a: 0, b: 1, c: 2, d: 3 }[m[1].toLowerCase()];
      else {
        const m2 = footer.match(/([a-d])\)/i);
        if (m2) correctIndex = { a: 0, b: 1, c: 2, d: 3 }[m2[1].toLowerCase()];
        else {
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

    if (!questionText) continue;
    if (choices.length === 0) continue;

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

// GET import page
router.get("/lms/import", ensureAuth, ensureAdmin, (req, res) => {
  return safeRender(req, res, "admin/lms_import", { title: "Import LMS Questions (paste)" });
});

router.post("/lms/import", ensureAuth, ensureAdmin, upload.single("file"), async (req, res) => {
  try {
    let content = "";

    if (req.file && req.file.buffer && req.file.buffer.length) {
      content = req.file.buffer.toString("utf8");
    } else if (req.body && typeof req.body.text === "string" && req.body.text.trim().length) {
      content = req.body.text;
    }

    if (!content || !content.trim()) {
      if (req.headers.accept && req.headers.accept.includes("text/html")) {
        return res.status(400).send("Import failed: No text provided. Paste your questions or upload a .txt file and click Import.");
      }
      return res.status(400).json({ error: "No text provided" });
    }

    // Save fallback file to disk so API /mnt/data reads it
    try {
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

    // save to DB if requested
    const saveToDb = req.body && (req.body.save === "1" || req.body.save === "true" || req.body.save === "on");

    let inserted = 0;
    let dbSkipped = false;
    let dbErr = null;

    if (saveToDb && blocks.length) {
      try {
        let Question;
        try {
          Question = (await import("../models/question.js")).default;
        } catch (e) {
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
          const toInsert = blocks.map(b => ({
            text: b.text,
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
 * Lists quiz sources and tags with counts for Manage Quizzes UI.
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
      // aggregate counts by source
      try {
        const srcAgg = await Question.aggregate([
          { $group: { _id: { $ifNull: ["$source", "unknown"] }, count: { $sum: 1 } } },
          { $sort: { count: -1 } }
        ]).allowDiskUse(true);
        sources = srcAgg.map(r => ({ name: String(r._id), count: r.count }));
      } catch (e) {
        console.warn("[admin/lms/quizzes] source aggregation failed:", e && e.message);
        const distinct = await Question.distinct("source").catch(() => []);
        sources = (distinct || []).map(s => ({ name: s || "unknown", count: 0 }));
      }

      // aggregate counts by tag (tags may be arrays)
      try {
        const tagAgg = await Question.aggregate([
          { $unwind: { path: "$tags", preserveNullAndEmptyArrays: false } },
          { $group: { _id: "$tags", count: { $sum: 1 } } },
          { $sort: { count: -1 } }
        ]).allowDiskUse(true);
        tags = tagAgg.map(r => ({ name: String(r._id), count: r.count }));
      } catch (e) {
        console.warn("[admin/lms/quizzes] tag aggregation failed:", e && e.message);
        const distinctTags = await Question.distinct("tags").catch(() => []);
        tags = (distinctTags || []).flat().filter(Boolean).map(t => ({ name: t, count: 0 }));
      }
    }

    return safeRender(req, res, "admin/lms_quizzes", { title: "Manage Quizzes", sources: sources || [], tags: tags || [], deleted: req.query.deleted });
  } catch (err) {
    console.error("[admin/lms/quizzes] error:", err && (err.stack || err));
    return res.status(500).send("Failed to load quizzes");
  }
});

/**
 * POST /admin/lms/quizzes/delete
 * Deletes questions by a single source OR a single tag (targeted delete).
 * Expects body: { type: 'source'|'tag', value: '<name>' }
 *
 * This route is intended for the per-row "Delete" buttons in the Manage UI.
 */
router.post("/lms/quizzes/delete", ensureAuth, ensureAdmin, async (req, res) => {
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

    const type = (req.body && req.body.type) || (req.query && req.query.type);
    const value = (req.body && req.body.value) || (req.query && req.query.value);

    if (!type || !value) {
      if (req.headers.accept && req.headers.accept.includes("text/html")) {
        return res.status(400).send("Missing type or value for deletion.");
      }
      return res.status(400).json({ error: "Missing type or value" });
    }

    let filter = {};
    if (type === "source") {
      filter = { source: value };
    } else if (type === "tag") {
      // remove any document where tags array contains the value
      filter = { tags: value };
    } else {
      if (req.headers.accept && req.headers.accept.includes("text/html")) {
        return res.status(400).send("Invalid type. Use 'source' or 'tag'.");
      }
      return res.status(400).json({ error: "Invalid type. Use 'source' or 'tag'." });
    }

    const deleteRes = await Question.deleteMany(filter);
    console.log(`[admin/lms/quizzes/delete] deleted ${deleteRes.deletedCount} questions (type=${type}, value=${value})`);

    if (req.headers.accept && req.headers.accept.includes("text/html")) {
      return res.redirect("/admin/lms/quizzes?deleted=" + encodeURIComponent(deleteRes.deletedCount));
    }
    return res.json({ deleted: deleteRes.deletedCount, filter });
  } catch (err) {
    console.error("[admin/lms/quizzes/delete] error:", err && (err.stack || err));
    if (req.headers.accept && req.headers.accept.includes("text/html")) {
      return res.status(500).send("Failed to delete questions");
    }
    return res.status(500).json({ error: "delete failed", detail: String(err.message || err) });
  }
});

/**
 * POST /admin/lms/quizzes/delete-all
 * Legacy/bulk deletion: deletes by filter or all if none provided.
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
