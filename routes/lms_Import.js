// routes/admin/lms_import.js
import { Router } from "express";
import multer from "multer";
import ensureAuth from "../../middleware/authGuard.js";
import QuizQuestion from "../../models/quizQuestion.js";

const router = Router();

// multer memory storage (5MB limit)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 1024 * 1024 * 5 },
});

// helper to build admin set from env
function getAdminSet() {
  return new Set(
    (process.env.ADMIN_EMAILS || "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  );
}

// check if current user is admin
function isAdmin(req) {
  const email = (req.user && (req.user.email || req.user.username) || "").toLowerCase();
  if (!email) return false;
  const ADMIN_SET = getAdminSet();
  return ADMIN_SET.has(email);
}

// GET /admin/lms/import  – show upload form
router.get("/import", ensureAuth, (req, res) => {
  if (!isAdmin(req)) {
    return res.status(403).send("Forbidden — admin only");
  }

  return res.render("admin/lms_import", {
    title: "Import LMS Questions",
    user: req.user,
  });
});

/**
 * POST /admin/lms/import
 * Accepts form-data 'file' (text/plain) or a JSON / form body 'text' to parse directly.
 */
router.post("/import", ensureAuth, upload.single("file"), async (req, res) => {
  try {
    // ensure admin
    if (!isAdmin(req)) {
      // JSON error so this route can also be used via API
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

    // Run parser
    const { parsed, errors } = parseQuestionsFromText(rawText);

    if (!parsed.length) {
      return res.render("admin/lms_import", {
        title: "Import Results",
        result: { inserted: 0, parsed: 0, errors },
        user: req.user,
      });
    }

    // Insert into DB, mark source "import"
    const toInsert = parsed.map((p) => ({
      ...p,
      source: "import",
      createdAt: new Date(),
    }));

    const inserted = await QuizQuestion.insertMany(toInsert, { ordered: true });

    const summary = {
      parsed: parsed.length,
      inserted: inserted.length,
      errors,
    };

    return res.render("admin/lms_import", {
      title: "Import Results",
      result: summary,
      user: req.user,
    });
  } catch (err) {
    console.error("Import failed:", err);
    return res.status(500).send("Import failed: " + (err.message || String(err)));
  }
});

export default router;

/**
 * Parser: Accepts raw text and returns:
 *   { parsed: [ { text, choices, answerIndex, tags, difficulty, instructions } ], errors: [...] }
 *
 * Supported formats:
 *  - Choices like:
 *      a) Option one
 *      b) Option two ✅      <-- tick marks correct answer
 *  - OR explicit answer line:
 *      Correct Answer: b) Option two
 *      Answer: b) Option two
 *      ✅ Correct Answer: b) Option two
 */
function parseQuestionsFromText(raw) {
  const errors = [];
  const parsed = [];

  if (!raw || typeof raw !== "string") return { parsed, errors };

  // Normalize line endings
  const text = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  // Optional top-level "Instructions:" block
  let globalInstructions = "";
  const instrMatch = text.match(/(?:^|\n)Instructions:\s*([\s\S]*?)(?=\n\s*\n|$)/i);
  if (instrMatch) {
    globalInstructions = instrMatch[1].trim();
  }

  // Split into blocks separated by two or more newlines
  const blocks = text
    .split(/\n{2,}/)
    .map((b) => b.trim())
    .filter(Boolean);

  const choiceLetterToIndex = (letter) => {
    if (!letter) return -1;
    const m = letter.trim().toLowerCase().match(/^([a-d])/);
    if (!m) return -1;
    return "abcd".indexOf(m[1]);
  };

  for (const block of blocks) {
    try {
      if (/^Instructions?:/i.test(block)) continue;
      if (block === "⸻") continue; // ignore pure separator lines if present

      // Question line – supports "1. Question..." or "1) Question..."
      const qMatch = block.match(/^\s*(?:\d+\s*[\.\)]\s*)?(.+?)(?=\n|$)/);
      if (!qMatch) {
        errors.push({
          block: block.slice(0, 120),
          reason: "No question line found",
        });
        continue;
      }
      const qText = qMatch[1].trim();

      // Choices: lines starting with a) / b) / c) / d)
      const choiceRegex = /^[ \t]*([a-dA-D])[\.\)]\s*(.+)$/gm;
      const choices = [];
      let m;
      let answerIndex = -1; // determined either by ✅ or explicit answer line

      while ((m = choiceRegex.exec(block)) !== null) {
        const idx = choices.length;
        let choiceText = m[2].trim();

        // ✅ support: mark this choice as correct
        if (choiceText.includes("✅")) {
          choiceText = choiceText.replace(/✅/g, "").trim();
          if (answerIndex === -1) {
            answerIndex = idx;
          } else if (answerIndex !== idx) {
            errors.push({
              question: qText,
              reason: "Multiple ✅ ticks found in one question block.",
            });
          }
        }

        choices.push(choiceText);
      }

      if (choices.length < 2) {
        errors.push({
          question: qText,
          reason: `Expected labelled choices a)-d). Found ${choices.length}.`,
        });
        continue;
      }

      // If no ✅, look for explicit "Correct Answer:" / "Answer:" line
      if (answerIndex === -1) {
        let ansMatch =
          block.match(/✅\s*Correct Answer\s*:\s*(.+)$/im) ||
          block.match(/Correct Answer\s*:\s*(.+)$/im) ||
          block.match(/Answer\s*:\s*(.+)$/im);

        if (ansMatch) {
          const ansText = ansMatch[1].trim();

          // a) / b) / c) style
          const letterMatch = ansText.match(/^([a-dA-D])[\.\)]?/);
          if (letterMatch) {
            answerIndex = choiceLetterToIndex(letterMatch[1]);
          } else {
            // try to match by text
            const found = choices.findIndex((c) => {
              return (
                normalizeForCompare(c) === normalizeForCompare(ansText) ||
                c.toLowerCase().startsWith(ansText.toLowerCase()) ||
                ansText.toLowerCase().startsWith(c.toLowerCase())
              );
            });
            if (found >= 0) {
              answerIndex = found;
            } else {
              // maybe (b) inside brackets
              const insideLetter = ansText.match(/\(([a-dA-D])\)/);
              if (insideLetter) answerIndex = choiceLetterToIndex(insideLetter[1]);
            }
          }
        }
      }

      if (answerIndex < 0 || answerIndex >= choices.length) {
        errors.push({
          question: qText,
          reason: `Could not determine correct answer from block. Choices found: ${choices.length}`,
        });
        continue;
      }

      // difficulty (optional)
      let difficulty = "medium";
      const diffMatch =
        block.match(/difficulty\s*[:\-]\s*(easy|medium|hard)/i) ||
        block.match(/\[(easy|medium|hard)\]/i);
      if (diffMatch) difficulty = diffMatch[1].toLowerCase();

      // tags (optional)
      const tags = [];
      const tagMatch = block.match(/tags?\s*[:\-]\s*([a-zA-Z0-9,\s\-]+)/i);
      if (tagMatch) {
        tagMatch[1]
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean)
          .forEach((t) => tags.push(t));
      }

      // per-question instructions (optional)
      let instructions = "";
      const instrQ = block.match(/Instructions?:\s*([\s\S]+?)$/i);
      if (instrQ) instructions = instrQ[1].trim();

      parsed.push({
        text: qText,
        choices,
        answerIndex,
        tags,
        difficulty,
        instructions: instructions || globalInstructions || "",
      });
    } catch (e) {
      errors.push({
        block: block.slice(0, 120),
        reason: e.message || String(e),
      });
    }
  }

  return { parsed, errors };
}

function normalizeForCompare(s) {
  return String(s || "")
    .replace(/[^a-z0-9]+/gi, " ")
    .trim()
    .toLowerCase();
}
