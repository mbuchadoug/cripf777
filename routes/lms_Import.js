// routes/lms_import.js
import { Router } from "express";
import multer from "multer";
import mongoose from "mongoose";
import crypto from "crypto";


import { ensureAuth } from "../middleware/authGuard.js";

import Question from "../models/question.js";
import Organization from "../models/organization.js";
import OrgMembership from "../models/orgMembership.js";
import ExamInstance from "../models/examInstance.js";
import Attempt from "../models/attempt.js";

const router = Router();

/* ------------------------------------------------------------------ */
/*  Multer                                                            */
/* ------------------------------------------------------------------ */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 1024 * 1024 * 12 },
});

/* ------------------------------------------------------------------ */
/*  Admin check                                                       */
/* ------------------------------------------------------------------ */
function ensureAdmin(req, res, next) {
  const email = (req.user?.email || "").toLowerCase();
  const admins = new Set(
    (process.env.ADMIN_EMAILS || "")
      .split(",")
      .map(e => e.trim().toLowerCase())
      .filter(Boolean)
  );
  if (!admins.has(email)) return res.status(403).send("Admins only");
  next();
}

/* ------------------------------------------------------------------ */
/*  GET import page                                                   */
/* ------------------------------------------------------------------ */
router.get("/lms/import", ensureAuth, ensureAdmin, async (req, res) => {
  const organizations = await Organization.find()
    .select("_id name slug")
    .sort({ name: 1 })
    .lean();

res.render("admin/lms_import", {
  title: "Import LMS Questions",
  user: req.user,
  organizations,
  isAdmin: true, // 👈 enables admin navbar links
  ok: req.query.ok || null,
  err: req.query.err || null,
  preview: req.query.preview || null,
  text: req.query.text || ""
});

});

/* ------------------------------------------------------------------ */
/*  POST import  — builds a selectable comprehension "quiz" and optionally     */
/*  assigns it. Covers the full set of checks: content, org, parsing, passage,   */
/*  in-batch de-duplication, and correct assignment field names.                 */
/* ------------------------------------------------------------------ */
router.post(
  "/lms/import",
  ensureAuth,
  ensureAdmin,
  upload.any(),
  async (req, res) => {
    const back = (qs) => res.redirect("/admin/lms/import" + (qs ? "?" + qs : ""));
    try {
      // ── 1. Gather content (file or pasted text) ──────────────────────────
      let content = "";
      if (req.files?.length)      content = req.files[0].buffer.toString("utf8");
      else if (req.body.text)     content = String(req.body.text);
      if (!content.trim()) {
        return back("err=" + encodeURIComponent("Paste questions or upload a .txt file."));
      }

      // ── 2. Inputs + validation ───────────────────────────────────────────
      const saveToDb   = req.body.save === "1" || req.body.save === "on";
      const assignNow  = req.body.assignNow === "1" || req.body.assignNow === "on";
      const moduleKey  = String(req.body.module || "general").toLowerCase().trim() || "general";
      const passage    = String(req.body.passage || "").trim();      // ← real passage now
      const subject    = String(req.body.subject || "").toLowerCase().trim() || null;
      const gradeRaw   = req.body.grade;
      const grade      = (gradeRaw !== undefined && gradeRaw !== null && String(gradeRaw).trim() !== "")
                          ? Number(gradeRaw) : null;

      const orgId =
        req.body.orgId && mongoose.isValidObjectId(req.body.orgId)
          ? new mongoose.Types.ObjectId(req.body.orgId)
          : null;

      const quizTitle =
        (typeof req.body.quizTitle === "string" && req.body.quizTitle.trim())
          ? req.body.quizTitle.trim()
          : `${moduleKey} Imported Quiz`;

      // ── 3. Parse + validate questions ────────────────────────────────────
      const parsedAll = parseQuestionsFromText(content);
      if (!parsedAll.length) {
        return back("err=" + encodeURIComponent("No valid questions found. Each needs at least 2 options and a 'Correct Answer: X' line."));
      }

      // In-batch de-duplication by normalised question text
      const seen = new Set();
      const parsed = [];
      let duplicates = 0;
      for (const q of parsedAll) {
        const key = q.text.toLowerCase().replace(/\s+/g, " ").trim();
        if (seen.has(key)) { duplicates++; continue; }
        seen.add(key);
        parsed.push(q);
      }

      // ── 4. Preview mode (not saving) — report what WOULD happen ──────────
      if (!saveToDb) {
        const msg = `Preview: ${parsed.length} valid question(s)` +
          (duplicates ? `, ${duplicates} duplicate(s) skipped` : "") +
          (passage ? ", with a passage" : "") +
          ". Tick \"Save to database\" to import.";
        return back("preview=" + encodeURIComponent(msg));
      }

      // Saving requires an organisation so the quiz is scoped correctly.
      if (!orgId) {
        return back("err=" + encodeURIComponent("Choose an organisation before saving."));
      }

      // ── 5. Insert CHILD questions ────────────────────────────────────────
      const childDocs = parsed.map(q => ({
        text: q.text,
        choices: q.choices.map(c => ({ text: c })),
        correctIndex: q.answerIndex,
        organization: orgId,
        module: moduleKey,
        subject,
        grade,
        source: "import",
      }));
      const insertedChildren = await Question.insertMany(childDocs);
      const childIds = insertedChildren.map(q => q._id);

      // ── 6. Create the PARENT comprehension "quiz" (selectable in rules) ──
      //     Every import becomes a comprehension parent so it shows up in the
      //     Quiz Rules picker. Passage is stored when provided.
      const parent = await Question.create({
        text: quizTitle,
        type: "comprehension",
        passage: passage || "",
        questionIds: childIds,
        organization: orgId,
        module: moduleKey,
        subject,
        grade,
        source: "import",
      });

      // ── 7. Optional immediate assignment to org members (school-style) ──
      let assignedTo = 0;
      if (assignNow) {
        const members = await OrgMembership.find({
          org: orgId,
          role: { $in: ["employee", "manager", "admin"] },
        }).lean();

        for (const m of members) {
          const questionIds = [`parent:${parent._id}`];
          const choicesOrder = [[]];
          for (const q of insertedChildren) {
            questionIds.push(String(q._id));
            const indices = Array.from({ length: q.choices.length }, (_, i) => i);
            for (let i = indices.length - 1; i > 0; i--) {
              const k = Math.floor(Math.random() * (i + 1));
              [indices[i], indices[k]] = [indices[k], indices[i]];
            }
            choicesOrder.push(indices);
          }

          // FIX: schema field is `userId` (not `user`), and m.user is already
          // an ObjectId from .lean() — no ObjectId() wrapper (throws in Mongoose 7).
          await ExamInstance.create({
            examId: crypto.randomUUID(),
            org: orgId,
            module: moduleKey,
            userId: m.user,
            title: quizTitle,
            quizTitle,
            questionIds,
            choicesOrder,
          });

          await Attempt.create({
            userId: m.user,
            organization: orgId,
            module: moduleKey,
            questionIds,
            startedAt: new Date(),
            maxScore: childIds.length,
          });
          assignedTo++;
        }
      }

      // ── 8. Success summary ───────────────────────────────────────────────
      const okMsg = `Imported "${quizTitle}" — ${childIds.length} question(s)` +
        (passage ? " with passage" : "") +
        (duplicates ? `, ${duplicates} duplicate(s) skipped` : "") +
        (assignNow ? `, assigned to ${assignedTo} member(s)` : "") +
        ". It's now selectable when creating a quiz rule.";
      return back("ok=" + encodeURIComponent(okMsg));

    } catch (err) {
      console.error("[LMS IMPORT] error:", err && err.stack);
      return res.redirect("/admin/lms/import?err=" + encodeURIComponent("Import failed: " + (err.message || "unknown error")));
    }
  }
);


/* ------------------------------------------------------------------ */
/*  Parser                                                           */
/* ------------------------------------------------------------------ */
function parseQuestionsFromText(raw) {
  const blocks = raw
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split(/\n{2,}/)
    .map(b => b.trim())
    .filter(Boolean);

  const parsed = [];

  for (const block of blocks) {
    const lines = block.split("\n").map(l => l.trim()).filter(Boolean);
    if (lines.length < 3) continue;

    const question = lines[0];
    const choices = [];
    let answerIndex = -1;

    for (const line of lines.slice(1)) {
      const m = line.match(/^([a-dA-D])[.)]\s*(.+)$/);
      if (m) choices.push(m[2]);

      const a = line.match(/Correct Answer\s*[:\-]?\s*([a-dA-D])/i);
      if (a) answerIndex = "abcd".indexOf(a[1].toLowerCase());
    }

    if (choices.length >= 2 && answerIndex >= 0) {
      parsed.push({ text: question, choices, answerIndex });
    }
  }

  return parsed;
}

export default router;